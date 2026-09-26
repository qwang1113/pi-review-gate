/**
 * THE ONE HANDOVER, as this session wires it (lib/session-handoff-tools.ts owns
 * the mechanics). Moved out of `extensions/review-gate.ts` (t8, 2026-09-26, wave 4).
 *
 * WHY THIS IS NOT INSIDE registerOrchestratorSessionTools (2026-09-14,
 * philosophy three): handing over is EVERY kind of session's move. A plain
 * loop session, an orchestration child and a judge pane all run out of room
 * exactly like a project manager, so the tool is registered ONCE and the
 * mechanical half lives in lib/session-handoff-tools.ts.
 *
 * WHAT THE AGENT STILL OWNS (user decision, same day): the INTENT. Reaching
 * the threshold produces a reminder plus the document skeleton; nothing is
 * opened until `session_handoff()` is called, because only the session itself
 * knows the work is at a stopping point.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { STATE_VARIANT_ENV } from "./gate-state-io.ts";
import type { HierarchyTable } from "./hierarchy.ts";
import { JUDGE_ID_ENV, JUDGE_OPENER_ENV, JUDGE_ROLE_ENV } from "./judge-pane.ts";
import type { JudgeRegistry } from "./judge-registry-host.ts";
import { JUDGE_STREAM_ENV, readJudgeSideEnv } from "./judge-side.ts";
import { ACCEPTANCE_GATE_ENV } from "./acceptance-round.ts";
import { readSessionLoopGoal } from "./loop-goal-host.ts";
import { ORCHESTRATION_ID_ENV } from "./orchestration-id.ts";
import type { OrchestratorRuntime } from "./orchestrator-registry.ts";
import type { TmuxRunner } from "./orchestrator-tmux.ts";
import { readPlanFile } from "./orchestrator-wiring.ts";
import { STATION_CAP_ENV } from "./repo-pr-policy.ts";
import type { SessionCells } from "./session-cells.ts";
import { sessionDirForCwd } from "./session-dir.ts";
import { closeSessionPane, openSessionWindow } from "./session-factory.ts";
import { claimsMainSidecar } from "./session-exclusivity.ts";
import { handoffAccepted, handoffDue, handoffReminder, type HandoffSessionKind } from "./session-handoff.ts";
import {
  ensureHandoffDoc,
  handoffDocPath,
  handoffExtraEnvFor,
  registerContextStatusTool,
  registerSessionHandoffTool,
  successorOpeningMessage,
  type SessionHandoffDeps,
} from "./session-handoff-tools.ts";
import { handoffGeneration, readInheritance, successorEnv, successorSessionId } from "./session-inheritance.ts";
import type { TmuxScope } from "./session-tmux-scope.ts";
import type { ToolHost } from "./tool-host.ts";
import { changedFiles } from "./worktree-changes.ts";
import { readWorkerSideEnv } from "./worker-side.ts";

export interface HandoffHostDeps {
  runTmux: TmuxRunner;
  tmuxScope: TmuxScope;
  judgeTaskText(): string | undefined;
  releaseWorktree(): void;
  holdWorktree(): void;
  stopChildHeartbeat(): void;
  /** The runtime clocks (lib/orchestrator-runtime-host.ts), read at call time. */
  runtimeClocks(): {
    handedOff(): boolean;
    markHandedOff(): void;
    stopSupervisionTimer(): void;
    stopRevivalTimer(): void;
  };
  /** The orchestration deps' runtime pair — the id this session actually holds. */
  orchestration(): {
    runtime(): OrchestratorRuntime;
    saveRuntime(runtime: OrchestratorRuntime): void;
  };
  /** The judge registry (lib/judge-registry-host.ts), read at call time. */
  registry(): Pick<JudgeRegistry, "ensureHierarchyLoaded" | "judgeHierarchy" | "setHierarchy" | "persistJudgeHierarchy">;
}

export function createHandoffHost(
  pi: ToolHost,
  cells: SessionCells,
  deps: HandoffHostDeps,
) {
  /**
   * WHAT KIND OF SESSION THIS IS — the ONE reading of that fact (2026-09-25).
   *
   * THREE callers branch on it: the registry entry (t2, `mode`), the message
   * sender's self-description (t3), and the handover below. They used to read it
   * in two places with two shapes, which is how two answers to one question
   * drift apart — a worker pane was the fact they had already started to
   * disagree about.
   */
  function ownSessionKind(): string {
    if (readJudgeSideEnv(process.env)) return "judge";
    if (readWorkerSideEnv(process.env)) return "worker";
    if (cells.state.taskMode === "orchestrator") return "orchestrator";
    if ((process.env[STATE_VARIANT_ENV] ?? "").trim()) return "child";
    return cells.state.taskMode ?? "loop";
  }

  /**
   * Which of the FOUR kinds of session is running here, for the handover.
   *
   * A worker pane is not one of them — it is handed work by its opener and never
   * hands over — so it reads as the ordinary loop, exactly as the separate
   * reading it replaced did. Nothing else is invented: `normal` / `explore` are
   * loop sessions too, and the handover document says so.
   */
  function handoffKind(): HandoffSessionKind {
    const kind = ownSessionKind();
    return kind === "orchestrator" || kind === "child" || kind === "judge" ? kind : "loop";
  }

  /** This session's transcript — the raw record a successor may dig through. */
  function ownTranscriptPath(): string | undefined {
    try {
      const dir = sessionDirForCwd(cells.cwd);
      return cells.state.sessionId ? `${dir}/${cells.state.sessionId}.jsonl` : undefined;
    } catch { return undefined; }
  }

  /**
   * The retirement EVERY handover owes — phase one out here, phase two in
   * `committed` (lib/orchestrator-deps.ts's HandoffRetirement spells out why
   * the two cannot be one flag). Shared by the orchestrator deps and the
   * handoff tool, so the two cannot drift.
   */
  function handoffRetirement(): { committed(): void; rolledBack(): void } {
    deps.releaseWorktree();
    return {
      committed: () => {
        const clocks = deps.runtimeClocks();
        clocks.markHandedOff();
        clocks.stopSupervisionTimer();
        clocks.stopRevivalTimer();
        deps.stopChildHeartbeat();
      },
      rolledBack: () => {
        if (claimsMainSidecar(process.env)) deps.holdWorktree();
      },
    };
  }

  /**
   * The MECHANICAL half of the handoff document.
   *
   * Every line is a fact the gate observed — the contract in force, the work
   * still open — so a successor can trust the frame even when the agent's own
   * paragraph is thin. The agent's half is the only testimony in the file and
   * lib/session-handoff.ts marks it as such.
   */
  function handoffDocFacts(): { contract?: string; outstanding?: string[] } {
    const kind = handoffKind();
    const outstanding: string[] = [];
    let contract: string | undefined;
    if (kind === "orchestrator") {
      const { plan } = readPlanFile(cells.cwd);
      if (plan) {
        contract =
          `编排 plan：${plan.title}\n` +
          plan.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}`).join("\n");
      }
      for (const child of cells.state.orchestrator?.children ?? []) {
        outstanding.push(
          `子会话 ${child.id}（任务 ${child.taskId}，pane ${child.paneId}）：` +
          (child.closedAt ? "已关闭" : "运行中"),
        );
      }
    } else if (kind === "judge") {
      const task = deps.judgeTaskText();
      if (task) contract = `本轮审查任务：\n${task}`;
    } else {
      const goal = readSessionLoopGoal(cells.primaryRepoRoot);
      if (goal.present) contract = `loop goal：\n${goal.text}`;
    }
    try {
      const files = changedFiles(cells.cwd) ?? [];
      if (files.length > 0) {
        outstanding.push(
          `未提交改动 ${files.length} 个文件：${files.slice(0, 12).join("、")}${files.length > 12 ? " …" : ""}`,
        );
      }
    } catch { /* a repo the gate cannot read says nothing rather than lying */ }
    return { ...(contract ? { contract } : {}), outstanding };
  }

  /** Everything the successor needs on top of lib/session-inheritance.ts's record. */
  function handoffExtraEnv(kind: HandoffSessionKind): Record<string, string> {
    return handoffExtraEnvFor({
      kind,
      ...(cells.state.taskMode === undefined ? {} : { taskMode: cells.state.taskMode }),
      // THE ID THIS SESSION ACTUALLY HOLDS, through the ONE rule that decides
      // it: `deps.runtime()` returns an empty runtime when the stored record
      // belongs to a different orchestration (lib/orchestrator-wiring.ts, B1),
      // so its id is "mine" by construction. A child holds none — it addresses
      // one, and that address arrived in ITS environment, blank or not.
      ...(kind === "orchestrator"
        ? { orchestrationId: deps.orchestration().runtime().orchestrationId }
        : { orchestrationId: process.env[ORCHESTRATION_ID_ENV] }),
      // Blank handling is the FUNCTION's job (`handoffExtraEnvFor` trims and
      // omits), pinned by its test.
      stateVariant: process.env[STATE_VARIANT_ENV],
      // THE STATION CEILING RIDES THE RELAY TOO (2026-09-15). A successor is a
      // new process, so a ceiling that lived only in the predecessor's
      // environment would evaporate: a child whose plan narrowed its repo to
      // `commit` would come back able to negotiate `pr`. Organic for a
      // standalone session (the variable is absent ⇒ the field is omitted).
      stationCap: process.env[STATION_CAP_ENV],
      // And the ACCEPTANCE GATE rides it (2026-09-22), for exactly the same
      // reason: a relay is a new process, and the variable's ABSENCE means ON.
      acceptanceGate: process.env[ACCEPTANCE_GATE_ENV],
    });
  }

  /**
   * THE JUDGE'S HANDOVER — a judge that ran out of room opens the next
   * generation itself, because the round is ITS to finish.
   *
   * WHY THE JUDGE AND NOT THE OPENER. A reviewer's rotation between rounds is
   * the opener's decision (lib/judge-rotation.ts) and stays that way. But a
   * judge that hits the threshold IN THE MIDDLE of a round cannot wait for the
   * next dispatch: the round it is holding is the one that would blow up. It
   * opens the successor beside itself, points it at the handoff document it
   * just wrote, and the new session's first tool call proves the takeover —
   * at which point the gate closes THIS pane, exactly as it does for every
   * other kind of session.
   *
   * The new id is derived from this one, so the chain is readable, and the
   * table is updated ON DISK so the opener's next sweep finds the new channel.
   */
  async function judgeSuccessionRequest(
    docPath: string,
  ): Promise<{ ok: true; detail: string } | { ok: false; reason: string }> {
    const side = readJudgeSideEnv(process.env);
    if (!side) return { ok: false, reason: "本会话不是 judge" };
    const ownPane = (process.env.TMUX_PANE ?? "").trim();
    if (!ownPane) return { ok: false, reason: "judge pane 不在 tmux 里，无法开新一代会话" };
    const registry = deps.registry();
    // THE TABLE HAS TO BE LOADED FIRST (2026-09-14, measured in the lab): a
    // judge process does not touch the registry on the way up, so without this
    // `judgeHierarchy` is empty, `entry` is undefined, and the handover leaves
    // the opener pointing at a session that no longer exists. The load is
    // idempotent, so the ordinary (already-loaded) path costs a Set lookup.
    registry.ensureHierarchyLoaded(cells.cwd);
    const entry = registry.judgeHierarchy()[side.judgeId];
    const successorId = successorSessionId(side.judgeId, handoffGeneration(side.judgeId) + 1);
    const opened = await openSessionWindow(deps.runTmux, {
      scope: deps.tmuxScope,
      ownPane,
      cwd: cells.cwd,
      layout: "beside-opener",
      command: ["pi", "--session-id", successorId, successorOpeningMessage(docPath, "judge")],
      role: {
        kind: "successor",
        env: successorEnv({
          kind: "judge",
          predecessorPane: ownPane,
          handoffDoc: docPath,
          ...(cells.state.sessionId ? { predecessorSessionId: cells.state.sessionId } : {}),
          extra: {
            [JUDGE_OPENER_ENV]: side.openerId,
            [JUDGE_ID_ENV]: successorId,
            [JUDGE_ROLE_ENV]: side.role,
            ...(entry?.streamPath ? { [JUDGE_STREAM_ENV]: entry.streamPath } : {}),
          },
        }),
      },
    });
    if (!opened.ok) return { ok: false, reason: opened.error };
    if (entry) {
      const next: HierarchyTable = { ...registry.judgeHierarchy() };
      delete next[side.judgeId];
      next[successorId] = { ...entry, judgeId: successorId, paneId: opened.paneId };
      registry.setHierarchy(next);
      try { registry.persistJudgeHierarchy(); } catch { /* the opener still sees the new channel after a reload */ }
    }
    return {
      ok: true,
      detail:
        `新一代 judge 会话已在 pane ${opened.paneId} 启动（${successorId}），` +
        "它会接着这一轮审查；门禁会在它读到交接文档后关掉本 pane。",
    };
  }

  const handoffDeps: SessionHandoffDeps = {
    kind: handoffKind,
    sessionId: () => cells.state.sessionId ?? undefined,
    ownPane: () => (process.env.TMUX_PANE ?? "").trim() || undefined,
    repoRoot: () => cells.cwd,
    transcriptPath: ownTranscriptPath,
    docPath: (sessionId) => handoffDocPath(cells.cwd, sessionId),
    docFacts: handoffDocFacts,
    writeText: (path, text) => {
      mkdirSync(pathJoin(path, ".."), { recursive: true });
      writeFileSync(path, text, "utf8");
    },
    readText: (path) => {
      try { return existsSync(path) ? readFileSync(path, "utf8") : undefined; } catch { return undefined; }
    },
    openSuccessor: async (spec) => {
      const ownPane = (process.env.TMUX_PANE ?? "").trim();
      if (!ownPane) return { ok: false, error: "本会话不在 tmux pane 里" };
      // THE ONE LAYOUT THAT STILL SPLITS (user decision, 2026-09-25): a relay is
      // the human's own seat changing hands, so the successor lands in their
      // window rather than in a tmux session of its own.
      const opened = await openSessionWindow(deps.runTmux, {
        scope: deps.tmuxScope,
        ownPane,
        cwd: cells.cwd,
        layout: "beside-opener",
        command: [...spec.command],
        role: { kind: "successor", env: spec.env },
      });
      return opened.ok ? { ok: true, paneId: opened.paneId } : { ok: false, error: opened.error };
    },
    retire: handoffRetirement,
    // An orchestration records who took over, on the runtime it persists: the
    // successor's own row goes through `persist()`, which refuses to write for
    // a retired session — so this runs BEFORE `committed`.
    recordHandoff: (paneId, docPath) => {
      if (handoffKind() !== "orchestrator") return;
      try {
        const orchestration = deps.orchestration();
        orchestration.saveRuntime({
          ...orchestration.runtime(),
          relay: { handoffPath: docPath, successorPane: paneId, at: new Date().toISOString() },
        });
      } catch { /* the handover must not fail because a diagnostic row could not be written */ }
    },
    ...(readJudgeSideEnv(process.env) ? { requestSuccession: judgeSuccessionRequest } : {}),
    extraEnv: () => handoffExtraEnv(handoffKind()),
    now: () => Date.now(),
  };

  registerSessionHandoffTool(pi, handoffDeps);

  // `context_status()` — the same measurement, handed to the session that owns
  // it (user requirement, 2026-09-14). It is registered beside the handoff tool
  // because they answer halves of one question: how full am I, and what to do
  // about it. Judges get it too: a judge out of context is what handovers are
  // for, and it is the one session nobody can re-ask later.
  registerContextStatusTool(pi, {
    usage: () => {
      try { return cells.latestCtx?.getContextUsage?.(); } catch { return undefined; }
    },
    docPath: () => (cells.state.sessionId ? handoffDocPath(cells.cwd, cells.state.sessionId) : undefined),
  });

  /**
   * THE REMINDER — the whole of what the gate does by itself.
   *
   * It is computed from the session's OWN reading, taken through the same
   * `contextPercentOf` wrapper every other usage read uses, and it renders the
   * document skeleton on the way (the agent has to have somewhere to write its
   * paragraph BEFORE it decides to call the tool). Nothing is opened, nothing
   * is closed and nothing is blocked here: reaching the threshold produces a
   * sentence and a file, and the agent decides when the work is at a stopping
   * point (user decision, 2026-09-14).
   *
   * A missing reading produces NOTHING. A reminder that fires whenever the host
   * cannot report usage is one its reader learns to ignore.
   */
  function handoffReminderBlock(): string {
    const sessionId = cells.state.sessionId;
    if (deps.runtimeClocks().handedOff() || !sessionId) return "";
    let due: { due: boolean; percent?: number };
    try {
      due = handoffDue(cells.latestCtx?.getContextUsage?.());
    } catch { return ""; }
    if (!due.due || due.percent === undefined) return "";
    const docPath = handoffDocPath(cells.cwd, sessionId);
    let pendingFill = true;
    try {
      pendingFill = ensureHandoffDoc(handoffDeps, sessionId, docPath).pendingFill;
    } catch { return ""; }
    return "\n\n" + handoffReminder({
      kind: handoffKind(),
      percent: due.percent,
      docPath,
      pendingFill,
    });
  }

  /**
   * THE SUCCESSOR SIDE — the gate closes the predecessor.
   *
   * The asymmetry the protocol is built on used to be "only the successor may
   * close the predecessor" (constraint 12), and the successor was TOLD to do
   * it by hand. MEASURED: a successor that never learned it owed a close left
   * two live sessions behind, so the act moved to the gate — and the proof
   * moved with it (lib/session-handoff.ts's `handoffAccepted`), and the proof
   * is the user's own two-part test: the successor READ the handoff document
   * AND a tool call succeeded. Running the `read` IS that tool call in the
   * ordinary path.
   *
   * Done exactly once per session: a second tool_result must not race a second
   * kill against the first.
   */
  let successionClosed = false;
  function onSuccessionToolResult(event: ToolResultEvent): void {
    if (successionClosed || !cells.state.sessionId) return;
    const inherited = readInheritance();
    if (!inherited.predecessorPane) return;
    const readPath = event.toolName === "read"
      ? String((event.input as { path?: unknown } | undefined)?.path ?? "").trim()
      : "";
    // RESOLVE IT BEFORE COMPARING (reviewer P2, 2026-09-14): pi's read tool
    // accepts a relative path, and `handoffDocPath` always renders an absolute
    // one — so a successor that read the document as `.pi/handoff/x.md` would
    // never prove its takeover and the predecessor pane would sit there
    // forever. A path that cannot be resolved is simply not a match.
    const resolvedRead = readPath.length === 0 ? "" : pathResolve(cells.cwd, readPath);
    const accepted = handoffAccepted({
      readHandoffDoc: event.isError !== true && inherited.handoffDoc !== undefined &&
        resolvedRead === inherited.handoffDoc,
      firstToolSucceeded: event.isError !== true,
    });
    if (!accepted) return;
    successionClosed = true;
    const closed = closeSessionPane(deps.runTmux, inherited.predecessorPane);
    try {
      (cells.latestCtx as ExtensionContext | undefined)?.ui?.notify(
        closed.ok
          ? `review-gate: 接手成功，前任 pane ${inherited.predecessorPane} 已关闭。`
          : `review-gate: 接手成功，但关闭前任 pane ${inherited.predecessorPane} 失败 —— ${closed.error}`,
        closed.ok ? "info" : "warning",
      );
    } catch { /* headless */ }
  }

  return {
    ownSessionKind,
    handoffKind,
    ownTranscriptPath,
    handoffRetirement,
    handoffReminderBlock,
    onSuccessionToolResult,
  };
}
