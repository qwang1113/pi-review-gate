/**
 * THIS PROCESS AS A JUDGE PANE — what a reporting shell knows about the round
 * it is judging (its range, scope kind and number, read back out of its task
 * text), and the two judge-only registrations: `judge_conclude` and the pane's
 * own model self-heal. Moved out of `extensions/review-gate.ts` (t8, 2026-09-26, wave 4).
 */

import { existsSync, readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { effectiveAgentsConfig } from "./agents-config.ts";
import type { ChannelIO } from "./channel-io.ts";
import type { createChildSide } from "./child-side-host.ts";
import type { ScopeStampRecord } from "./gate-state-records.ts";
import { registerJudgeConcludeTool } from "./judge-conclude.ts";
import { emptyInspection, parseReviewRange, parseReviewScopeKind } from "./judge-inspection.ts";
import { createModelRotation } from "./judge-model-rotation.ts";
import { modelChainFor } from "./judge-prompt.ts";
import { HIERARCHY_FILENAME } from "./judge-registry-host.ts";
import { JUDGE_STREAM_ENV, JUDGE_TASK_ENV, readJudgeSideEnv } from "./judge-side.ts";
import { KNOWN_THINKING_LEVELS, parseModelSpec } from "./model-spec.ts";
import { reportState } from "./orchestrator-child-channel.ts";
import type { ProjectConfig } from "./project-config.ts";
import type { SessionCells } from "./session-cells.ts";
import { contextPercentOf } from "./session-handoff.ts";

export function createJudgePaneSelf(cells: SessionCells) {
  /** Is THIS session a judge pane? (the observer's only scope). */
  function isJudgePane(): boolean {
    return readJudgeSideEnv(process.env) !== undefined;
  }

  /**
   * Learn the round's review range and scope kind from its task text. Both are
   * opener knowledge that reaches a pane only as prose — round 1 through the
   * task file in the environment, later rounds through the channel — so they
   * are read back out of that prose. Best effort by design: no range simply
   * means the evidence carries no range flag (a goal audit has none at all),
   * and no decision marker means the report carries no scope kind.
   */
  function noteJudgeTaskText(text: string | undefined, roundSeq?: number): void {
    const range = parseReviewRange(text);
    if (range) cells.judgeReviewRange = range;
    const kind = parseReviewScopeKind(text);
    if (kind) cells.judgeScopeKind = kind;
    // WHICH ROUND THIS TASK IS (2026-09-16). The number travels WITH the task
    // because the opener's table holds the NEXT dispatch's number by the time a
    // busy pane reads this one — reading it from there is exactly how an old
    // verdict got booked against a new round. Only a real number is recorded:
    // an absent field must not renumber an existing round to 0.
    if (typeof roundSeq === "number" && Number.isFinite(roundSeq)) {
      cells.judgeTaskRound = Math.floor(roundSeq);
    }
  }

  /**
   * THIS round's scope, as this pane read it — the judge half of the audit
   * pair stamped on the channel report. Undefined when the task text carried
   * neither fact, which is the honest answer for a round that has no range
   * (a goal audit): an empty stamp would claim a scope nobody recorded.
   */
  function judgeReviewScope(): ScopeStampRecord | undefined {
    const range = cells.judgeReviewRange;
    const kind = cells.judgeScopeKind;
    if (range === undefined && kind === undefined) return undefined;
    return {
      ...(range === undefined ? {} : { range }),
      ...(kind === undefined ? {} : { kind }),
    };
  }

  /** Round 1's task, as the pane was opened with it (a path in the env). */
  function judgeTaskText(): string | undefined {
    const path = (process.env[JUDGE_TASK_ENV] ?? "").trim();
    if (!path) return undefined;
    try {
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    } catch { return undefined; }
  }

  /**
   * The paths THIS round was handed: its task file and its findings stream.
   *
   * They are the round's own paperwork, and reading them is not reviewing the
   * repository — the probe ("conclude READY, do nothing else") would otherwise
   * clear the inspection gate on the task read every judge performs anyway.
   * The generic markers live in lib/judge-inspection.ts; these two are the
   * exact paths only this process knows.
   */
  function judgeOwnPaths(): string[] {
    const paths: string[] = [];
    for (const key of [JUDGE_TASK_ENV, JUDGE_STREAM_ENV]) {
      const value = (process.env[key] ?? "").trim();
      if (value) paths.push(value);
    }
    return paths;
  }

  return { isJudgePane, noteJudgeTaskText, judgeReviewScope, judgeTaskText, judgeOwnPaths };
}

export type JudgePaneSelf = ReturnType<typeof createJudgePaneSelf>;

/**
 * THE JUDGE-ONLY SURFACE. judge_conclude is the ONLY tool that exists on one
 * side only: a judge concludes its own round through it, and the main session
 * must never see it (a main session that could self-certify a verdict breaks
 * the gate). The guard is the registration itself — anti-forgery by surface,
 * not secret. A process that is not a judge pane registers nothing here.
 */
export function registerJudgeSide(
  pi: ExtensionAPI,
  cells: SessionCells,
  self: JudgePaneSelf,
  deps: {
    channelIO: ChannelIO;
    freshProjectConfig(root: string): ProjectConfig;
    childBinding: ReturnType<typeof createChildSide>["childBinding"];
    log(text: string): void;
  },
): void {
  const side = readJudgeSideEnv(process.env);
  if (!side) return;
  // Round 1's task arrives as a FILE in the environment (later rounds come
  // through the channel drain), and it is the only place this pane can learn
  // the range its inspection evidence is measured against.
  self.noteJudgeTaskText(self.judgeTaskText());
  registerJudgeConcludeTool(pi, {
    env: () => process.env,
    repoRoot: () => cells.cwd,
    hierarchyPath: (root) => pathJoin(root, ".pi", HIERARCHY_FILENAME),
    readText: (path) => {
      try {
        if (!existsSync(path)) return undefined;
        return readFileSync(path, "utf8");
      } catch { return undefined; }
    },
    channelIO: () => deps.channelIO,
    channelHome: () => undefined,
    now: () => Date.now(),
    inspection: () => cells.judgeInspection,
    // The audit stamp for THIS round, read out of the task text this pane
    // was opened (or instructed) with. Unlike the evidence above it is NOT
    // reset between rounds: a later round arriving through the channel
    // carries its own scope block and overwrites it, and a round whose text
    // says nothing new is still running against the same range.
    reviewScope: () => self.judgeReviewScope(),
    // The round the TASK said it is, when a task said so — the one reading
    // that cannot be overtaken by the next dispatch's numbering.
    taskRound: () => cells.judgeTaskRound,
    // THIS pane's own context usage, taken at the conclusion — the reading
    // the opener cannot take, and the one its rotation policy runs on
    // (lib/judge-rotation.ts). `undefined` when the host offers no usage,
    // which never rotates.
    contextPercent: () => contextPercentOf(cells.latestCtx as unknown as { getContextUsage?: () => unknown }),
    inspectionPass: () => cells.inspectionPass,
    noteInspectionRefusal: (block) => { cells.lastBlockedInspection = block; },
    noteConcluded: (usedPass) => {
      // A round's evidence belongs to that round: the next one starts blind.
      cells.judgeInspection = emptyInspection();
      if (usedPass) cells.inspectionPass = undefined;
    },
  });
  // The pane watches its OWN model: the opener cannot (it is parked in a
  // wait) and no other surface sees this process's provider errors.
  installJudgeModelRotation(pi, cells, side.role, deps);
}

/**
 * THE PANE'S OWN MODEL SELF-HEAL (2026-09-10).
 *
 * The judge side is the ONLY party that sees this session's provider errors:
 * the opener is parked in a wait, and the channel carries verdicts, not
 * stack traces. So the pane watches its own runs and, when one ends with
 * `stopReason: "error"` AND pi has nothing left to retry (`agent_settled`),
 * it walks the role's chain (lib/judge-model-rotation.ts): switch model,
 * nudge itself to carry on, and REPORT the event so the opener can cool the
 * failed slot down.
 *
 * Why `agent_settled` and not the first failed request: a burst of 503s that
 * recovers 30 seconds later is the normal shape of a busy provider
 * (measured), and rotating on it would move every round to the backup for no
 * reason. The terminal condition is "pi gave up", which is exactly what
 * `agent_settled` with a failed last message means.
 */
function installJudgeModelRotation(
  pi: ExtensionAPI,
  cells: SessionCells,
  role: string,
  deps: {
    freshProjectConfig(root: string): ProjectConfig;
    childBinding: ReturnType<typeof createChildSide>["childBinding"];
    log(text: string): void;
  },
): void {
  /** The last run's terminal error, cleared by any run that ended cleanly. */
  let lastRunError: string | undefined;
  const rotation = createModelRotation({
    chain: () => {
      const cfg = deps.freshProjectConfig(cells.cwd);
      const { map } = effectiveAgentsConfig(cfg.agentsGlobal, cfg.agentsProject);
      return modelChainFor(map, role, cells.cwd);
    },
    currentSpec: () => {
      const model = cells.latestCtx?.model as { provider?: string; id?: string } | undefined;
      return model?.provider && model.id ? `${model.provider}/${model.id}` : undefined;
    },
    switchTo: async (spec) => {
      const parsed = parseModelSpec(spec);
      if (!parsed.provider || !parsed.id) return `spec 里解析不出 provider/id：${spec}`;
      const latestCtx = cells.latestCtx;
      if (!latestCtx) return "会话还没有可用的 ctx（读不到模型注册表）";
      try {
        const model = latestCtx.modelRegistry.find(parsed.provider, parsed.id);
        if (!model) return `注册表里没有这个模型：${parsed.provider}/${parsed.id}`;
        if (!(await pi.setModel(model))) return `pi.setModel 拒绝了 ${parsed.provider}/${parsed.id}`;
        // The slot's own level, applied AFTER the switch (setModel resets it
        // to the new model's default). A level the model cannot take is not
        // a reason to abandon a working model — pi clamps it, and an unknown
        // suffix is dropped here rather than passed on as a lie.
        if (parsed.thinking && KNOWN_THINKING_LEVELS.has(parsed.thinking)) {
          pi.setThinkingLevel(parsed.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
        }
        return true;
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        return `切换 ${spec} 时抛错：${text.slice(0, 160)}`;
      }
    },
    nudge: (text) => {
      try {
        // The same idiom the thinking-loop notice uses: idle ⇒ a plain user
        // message (this IS the next turn); anything still streaming ⇒ steer,
        // so the notice rides that run instead of being rejected.
        if (cells.latestCtx?.isIdle()) pi.sendUserMessage(text);
        else pi.sendUserMessage(text, { deliverAs: "steer" });
      } catch { /* the report still went out */ }
    },
    report: (event) => {
      const binding = deps.childBinding();
      // The state tells the truth about what happens NEXT: a rotation means
      // the round goes on (working), an exhausted chain means it stopped.
      if (binding) reportState(binding, event.exhausted ? "idle" : "working", { modelEvent: event });
    },
    notify: (text, level) => {
      try { cells.latestCtx?.ui.notify(text, level); } catch { /* headless */ }
    },
  });
  pi.on("agent_end", (event) => {
    const messages = (event as { messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string }> }).messages ?? [];
    let error: string | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role !== "assistant") continue;
      error = message.stopReason === "error" ? (message.errorMessage ?? "model error") : undefined;
      break;
    }
    lastRunError = error;
  });
  pi.on("agent_settled", async () => {
    const error = lastRunError;
    lastRunError = undefined;
    if (error === undefined) return;
    const event = await rotation.onModelFailure(error);
    // A rotation that FAILED to switch (no auth, unknown id) is still a fact
    // the opener must not be blind to — the attempt list is in the event.
    if (event) deps.log(`model fallback: ${event.spec} failed (${event.error ?? "error"}) → ${event.to ?? "chain exhausted"}`);
  });
}
