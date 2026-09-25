/**
 * THE DEPS OF THE AGENT-FACING JUDGE TOOLS — `judge_wait` / `judge_close`
 * (lib/judge-session-tools.ts) and `judge_spawn` & co. (lib/judge-spawn-tools.ts).
 * Built from the session's registry, lanes and settle path; moved out of
 * `extensions/review-gate.ts` (t8, 2026-09-26, wave 4 of the split). Every rule these
 * tools apply lives in their own modules — this is only what they need from
 * this session.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { settleAuditRound } from "./audit-round-settle.ts";
import type { createAuditRoundHost } from "./audit-round-host.ts";
import type { ChannelIO } from "./channel-io.ts";
import { judgeChildRecordOf, tmuxServerFrom } from "./hierarchy.ts";
import type { createJudgeLanes } from "./judge-lane-host.ts";
import type { createJudgeLaunch } from "./judge-launch-host.ts";
import { judgeWorkDirFor } from "./judge-lifecycle.ts";
import { judgeSessionIdFor, shortRepoHash } from "./judge-process.ts";
import type { JudgeRegistry } from "./judge-registry-host.ts";
import type { createJudgeRoundSettle } from "./judge-round-settle.ts";
import type { JudgeSessionToolDeps } from "./judge-session-tools.ts";
import type { JudgeSpawnToolDeps } from "./judge-spawn-tools.ts";
import { buildPlanAuditTask, formatPlanAuditCarryover, planAuditHash } from "./orchestrator-plan-audit.ts";
import { formatPlanSummary } from "./orchestrator-plan.ts";
import type { TmuxRunner } from "./orchestrator-tmux.ts";
import { readPlanFile } from "./orchestrator-wiring.ts";
import type { createRoundCancel } from "./round-cancel-host.ts";
import type { SessionCells } from "./session-cells.ts";
import { sessionDirForCwd } from "./session-dir.ts";
import type { SessionRepos } from "./session-repos-host.ts";
import type { TmuxScope } from "./session-tmux-scope.ts";

export interface JudgeToolsWiringDeps {
  registry: JudgeRegistry;
  settle: ReturnType<typeof createJudgeRoundSettle>;
  channelIO: ChannelIO;
  runTmux: TmuxRunner;
  tmuxScope: TmuxScope;
  resolveToolRepo: SessionRepos["resolveToolRepo"];
  auditRoundDeps: ReturnType<typeof createAuditRoundHost>["auditRoundDeps"];
  buildGoalAuditRound: ReturnType<typeof createAuditRoundHost>["buildGoalAuditRound"];
  applyRoundCancel: ReturnType<typeof createRoundCancel>["applyRoundCancel"];
  resolveJudgeLane: ReturnType<typeof createJudgeLanes>["resolveJudgeLane"];
  resolveJudgeLaunch: ReturnType<typeof createJudgeLaunch>["resolveJudgeLaunch"];
  cancelChildWaitTimer(): void;
}

/**
 * THE GATE'S OWN DEPS HANDLE (2026-09-08) — the object the agent-facing
 * `judge_wait` / `judge_close` registrations close over; the gate's
 * self-audit chains call the SAME `doWait` / `doClose` implementations
 * through it, so the repo-addressing check inside `addressJudge` is bypassed
 * for the gate's own auditor only. One object, not a copy (哲学三).
 */
export function buildJudgeSessionDeps(cells: SessionCells, deps: JudgeToolsWiringDeps): JudgeSessionToolDeps {
  const { registry, settle } = deps;
  return {
    resolveRepo: (requested) => {
      const resolved = deps.resolveToolRepo(requested);
      if (resolved.ok) registry.ensureHierarchyLoaded(resolved.root);
      return resolved;
    },
    callerId: () => registry.callerIdentity(),
    paneOwner: () => registry.paneOwnerIdentity(),
    // …and the identity a successor REPLACED, so a handover does not orphan the
    // reviewers its predecessor had already dispatched (2026-09-14).
    callerIds: () => registry.callerIdentities(),
    hierarchy: () => { registry.dropDeadForeignJudges(); return registry.judgeHierarchy(); },
    saveHierarchy: (next) => registry.setHierarchy(next),
    findChildById: (judgeId) => {
      const c = registry.ownJudges().find((e) => e.judgeId === judgeId);
      // ONE projection, in the registry module (lib/hierarchy.ts
      // `judgeChildRecordOf`): a judge window that cannot be addressed as
      // `<session>:<@window>` is a judge window nothing can close.
      return c ? judgeChildRecordOf(c) : undefined;
    },
    findChild: (root, role, judgeId) => {
      const c = settle.findJudgeChild(root, role, judgeId);
      return c ? judgeChildRecordOf(c, root) : undefined;
    },
    channelIO: () => deps.channelIO,
    channelHome: () => undefined,
    // THE ONE READING A HEARTBEAT CANNOT GIVE (goal 6(d), 2026-09-21): the
    // judge's transcript mtime. A live pane whose gate is reporting proves a
    // PROCESS; only writes to the transcript prove a TURN is running.
    transcriptActivityAt: (child) => {
      if (!child.sessionDir) return undefined;
      try {
        let newest: number | undefined;
        for (const name of readdirSync(child.sessionDir)) {
          if (!name.endsWith(".jsonl")) continue;
          try {
            const at = statSync(pathJoin(child.sessionDir, name)).mtimeMs;
            if (newest === undefined || at > newest) newest = at;
          } catch { /* one unreadable file is not a verdict on the rest */ }
        }
        return newest;
      } catch {
        return undefined;
      }
    },
    // THE FLOOR UNDER THAT READING — from the REGISTRY, not from the channel
    // (quality round P1, 2026-09-21): `JudgeEntry.spawnedAt` is stamped on
    // EVERY dispatch and is the registry's own answer to "when did this round
    // start". Nothing narrows it further (three review rounds found three ways
    // for a "parked on a question" predicate to go stale).
    roundDispatchedAt: (child) => {
      const at = registry.judgeHierarchy()[child.judgeId]?.spawnedAt;
      if (at === undefined) return undefined;
      const ms = Date.parse(at);
      return Number.isFinite(ms) ? ms : undefined;
    },
    tmux: (argv) => deps.runTmux(argv),
    tmuxServer: () => tmuxServerFrom(process.env),
    now: () => Date.now(),
    readText: (path) => {
      try {
        if (!existsSync(path)) return undefined;
        return readFileSync(path, "utf8");
      } catch { return undefined; }
    },
    announcedQuestions: () => cells.announcedRequestIds,
    markQuestionsAnnounced: (ids) => { for (const id of ids) cells.announcedRequestIds.add(id); },
    // The wait reads the round through the SAME binding the recorder applies.
    roundBinding: (child) => settle.roundBindingOf(child),
    // The wait closes its round through the SAME engine the settle path uses,
    // so a report cannot be recorded twice (one cursor, written in one place).
    settleRound: async (judgeId, root) => {
      // Before the verdict is read: whatever the pane reported about its own
      // model is a fact about this round (lib/judge-model-rotation.ts).
      registry.absorbJudgeModelEvents(root, judgeId);
      const settled = await settleAuditRound(deps.auditRoundDeps(undefined), { judgeId, root });
      switch (settled.status) {
        case "recorded": {
          // THE SAME HAND-OFF THE SWEEP DOES (reviewer P1, 2026-09-15): this
          // path can win the cursor, and the sweep then only ever sees
          // `already-consumed`.
          const handOffNote = await deps.applyRoundCancel(settled.kind, root, undefined);
          return {
            text: settled.text,
            // Its own field, so `judge_wait`'s wake-up prints it too.
            ...(handOffNote === undefined ? {} : { handOffNote }),
            verdict: settled.verdict,
            hasVerdict: settled.hasVerdict,
            ...(settled.bindingNote === undefined ? {} : { bindingNote: settled.bindingNote }),
            // The round's own scope stamp, so a `judge_wait` wake-up says the
            // same thing the settle sweep would have said about this round.
            ...(settled.scope === undefined ? {} : { scope: settled.scope }),
          };
        }
        case "advice":
          return { advice: settled.text, hasVerdict: false };
        case "unrecorded":
          return { verdict: settled.verdict, hasVerdict: settled.hasVerdict };
        default:
          return { hasVerdict: false };
      }
    },
    dropPendingAudit: (root) => registry.dropAudits(root),
    cancelWaitTimer: () => deps.cancelChildWaitTimer(),
    // The wait's side of the model events: the opener acts on them BEFORE its
    // cursor moves past them, so nothing the pane reported is ever dropped.
    absorbModelEvents: (root, judgeId) => registry.absorbJudgeModelEvents(root, judgeId),
  };
}

/** What `judge_spawn` (goal / plan reviews opened by their owner) needs. */
export function buildJudgeSpawnDeps(cells: SessionCells, deps: JudgeToolsWiringDeps): JudgeSpawnToolDeps {
  const { registry } = deps;
  return {
    callerId: () => registry.callerIdentity(),
    paneOwner: () => registry.paneOwnerIdentity(),
    hierarchy: () => { registry.dropDeadForeignJudges(); return registry.judgeHierarchy(); },
    saveHierarchy: (next) => registry.setHierarchy(next),
    channelIO: () => deps.channelIO,
    channelHome: () => undefined,
    tmux: (argv) => deps.runTmux(argv),
    ownPane: () => process.env.TMUX_PANE?.trim() || undefined,
    // Every judge this session opens is a window of THIS session's own tmux
    // session — never a pane taken from the user's window.
    scope: deps.tmuxScope,
    tmuxServer: () => tmuxServerFrom(process.env),
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    resolveRepo: (requested) => {
      const resolved = deps.resolveToolRepo(requested);
      if (resolved.ok) registry.ensureHierarchyLoaded(resolved.root);
      return resolved;
    },
    // THE lane resolver, shared with `dispatchJudgeRound` — one policy, one
    // retire path, whichever tool starts the judge.
    lane: (root, role, opener) => {
      const resolved = deps.resolveJudgeLane(root, role, opener);
      return {
        lane: resolved.decision.lane,
        roundsInObject: resolved.decision.roundsInObject,
        retirePrevious: () => { resolved.retirePrevious(); },
      };
    },
    launchConfig: (root, role, opener, lane) => {
      const workDir = pathJoin(root, judgeWorkDirFor(role, shortRepoHash(root), opener, lane));
      // ONE launch resolver for both dispatch surfaces (judge_spawn here,
      // judge_submit's chain in dispatchJudgeRound).
      const judgeId = judgeSessionIdFor(role, shortRepoHash(root), opener, lane);
      // Same reason as `dispatchJudgeRound`: the events this pane reported last
      // round must be acted on (and their cursor advanced) before
      // `registerJudge` replaces the entry that carries the cursor.
      registry.absorbJudgeModelEvents(root, judgeId);
      const launch = deps.resolveJudgeLaunch(root, role, workDir, role, judgeId);
      if (!launch.ok) {
        return { ok: false, error: launch.error };
      }
      const sessionDir = pathJoin(workDir, "sessions");
      try { mkdirSync(sessionDir, { recursive: true }); } catch { /* best effort */ }
      return { ok: true, model: launch.spec, sysPromptPath: launch.sysPromptPath, sessionDir };
    },
    buildGoalAuditTask: async (draft, root, ctx) => {
      // The third caller of the ONE assembler (the other two are the audit
      // chain and judge_submit's goal-auditor branch).
      const built = await deps.buildGoalAuditRound(draft, root, ctx);
      if (!built.ok) return { ok: false, error: "goal 审计任务无法生成" };
      return { ok: true, task: built.task, streamPath: built.streamPath };
    },
    buildPlanAuditTask: async (root) => {
      const read = readPlanFile(root);
      if (!read.plan) {
        return { ok: false, error: `读不到可审计的 plan：${read.problems.join("；") || "plan 文件不存在"}` };
      }
      const plan = read.plan;
      const hash = planAuditHash(plan);
      const state = cells.state;
      const previous = state.planAudit;
      const carryover = previous && previous.hash !== hash ? formatPlanAuditCarryover(previous) : undefined;
      return {
        ok: true,
        task: buildPlanAuditTask(plan, {
          ...(carryover === undefined ? {} : { carryover }),
          ...(carryover !== undefined && previous?.planText ? { prevPlanText: previous.planText } : {}),
          repoRoot: root,
          ...(state.sessionId ? { sessionId: state.sessionId, sessionDir: sessionDirForCwd(cells.cwd) } : {}),
        }),
      };
    },
    writeJudgeTaskFile: (root, role, opener, task, lane) => {
      try {
        const workDir = pathJoin(root, judgeWorkDirFor(role, shortRepoHash(root), opener, lane));
        const sessionDir = pathJoin(workDir, "sessions");
        mkdirSync(sessionDir, { recursive: true });
        const taskPath = pathJoin(sessionDir, `task-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.md`);
        writeFileSync(taskPath, task, "utf8");
        return { ok: true, path: taskPath };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    pendingAuditKind: (root) => {
      const pending = registry.pendingAudits.get(root);
      return pending?.kind === "goal" || pending?.kind === "plan" ? pending.kind : undefined;
    },
    rememberGoalAudit: (root, draft) => {
      registry.pendingAudits.set(root, { kind: "goal", draft, startedAt: new Date().toISOString() });
      registry.persistJudgeHierarchy();
    },
    rememberPlanAudit: (root) => {
      const read = readPlanFile(root);
      if (!read.plan) return { ok: false, error: `读不到 plan：${read.problems.join("；") || "plan 文件不存在"}` };
      const plan = read.plan;
      registry.pendingAudits.set(root, {
        kind: "plan",
        hash: planAuditHash(plan),
        planText: formatPlanSummary(plan),
        startedAt: new Date().toISOString(),
      });
      registry.persistJudgeHierarchy();
      return { ok: true };
    },
    forgetAudit: (root) => {
      registry.pendingAudits.delete(root);
      registry.persistJudgeHierarchy();
    },
  };
}
