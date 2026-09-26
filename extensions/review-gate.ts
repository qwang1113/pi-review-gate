/**
 * pi-review-gate — quality gates for Pi.
 *
 * Enforcement layers:
 *   L1 Ship gate (HARD)  — tool_call blocks git commit/push & gh pr create/edit
 *                          until review READY + precommit PASS, both bound to
 *                          the current worktree fingerprint.
 *   L2 Auto-continuation — agent_settled re-triggers the loop when gates are
 *                          unmet (recursion-guarded, max_rounds, plateau stop).
 *   L3 Git hooks         — scripts/install-git-hooks.sh installs pre-commit /
 *                          pre-push verification that works even outside Pi.
 *   L4 Output-language   — before_agent_start unconditionally injects the
 *                          strict Simplified-Chinese LANGUAGE_DIRECTIVE every
 *                          turn (thinking in Chinese too); protocol English
 *                          tokens (verdict enum, commit msgs, code) exempt.
 *   L5 Commit/PR English — HARD: tool_call blocks a git commit message or
 *                          PR title/body that is predominantly non-English
 *                          (majority-body policy; escape hatch named in the
 *                          reason); the per-turn LANGUAGE_DIRECTIVE instructs
 *                          the agent to write ship text in English and the
 *                          reviewer checks it during review too.
 *   L6 Test-label English — pre-commit (scripts/scan-test-labels.cjs) blocks a
 *                          staged it/test/describe label written in a non-Latin
 *                          script, unless a `// review-gate: allow-non-english`
 *                          (line) or `-file` marker exempts it.
 *
 * Design principles (from real-world harness engineering):
 *   1 glob trap        → precommit runner warns on `node --test **` scripts
 *   2 fail-open parse  → no verdict text to parse; a judge's structured
 *                        conclusion rides its channel report, and a READY
 *                        carrying an open P0/P1 is recorded as BLOCKED
 *   3 NO_CHECKS_RUN    → distinct precommit verdict; never treated as pass
 *   4 NotebookEdit     → coalesceToolPath reads every path param spelling
 *   5 extension drift  → ONE CODE_EXTENSIONS list; structural test enforces it
 *   6 formatter safety → no formatter is run at all
 *   7 compaction       → state persisted via appendEntry + sidecar; re-injected
 *                        into context after session_compact and on resume
 *   8 word boundaries  → commit-msg patterns \b-bound only bare AI
 *
 * sd0x-dev-flow ports beyond PR #7 (see README "-dev-flow features ported"):
 *   R6  per-project maxRounds via .pi/review-gate.json (clamped 3..50)
 *   R9  [GIT_CONTEXT] git memory after compaction (filtered, capped; default on)
 *   R10 one-shot [STRATEGIC_RESET] think-harder checklist near the round cap
 *   —   auto-loop prohibited behaviors in the per-turn reminder
 *   —   .git/ internals in SENSITIVE_FILE_PATTERNS (pre-edit-guard port)
 *   —   /gate-lesson self-improvement log (.pi/review-gate-lessons.md)
 *
 * THIS FILE IS WIRING ONLY (t8, 2026-09-26). Every tool body, lifecycle
 * handler and piece of session state lives in lib/ (docs/module-map.md is the
 * map); what is left here is the order things are created and registered in,
 * which is a fact the session's behaviour depends on (tool and event order).
 * The mutable session bindings are ONE object, lib/session-cells.ts.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename as pathBasename, dirname as pathDirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { TASK_TEXT_MARKER } from "../lib/constants.ts";
import { registerUserInteractionTools } from "../lib/user-interaction-tools.ts";
import { registerGateCommands } from "../lib/gate-command-tools.ts";
import { nodeChannelIO, type ChannelIO } from "../lib/channel-io.ts";
import type { ReportConclusion } from "../lib/channel-projection.ts";
import { describeToolActivity } from "../lib/orchestrator-child-channel.ts";
import { tmuxServerFrom } from "../lib/hierarchy.ts";
import {
  addressableSessions,
  createOwnershipProbe,
  sanitizeScopeRecord,
  type TmuxScope,
} from "../lib/session-tmux-scope.ts";
import { closeOwnSessionOnExit } from "../lib/session-scope-exit.ts";
import { readJudgeSideEnv } from "../lib/judge-side.ts";
import { createOrchestratorDeps, runTmux as rawTmux } from "../lib/orchestrator-wiring.ts";
import { sideEffectsEnabled } from "../lib/side-effects.ts";
import type { UserNotifyKind } from "../lib/user-notify.ts";
import { createUserNotifyRuntime } from "../lib/user-notify-runtime.ts";
import { parseWorkerRegistry, WORKER_REGISTRY_RELPATH } from "../lib/worker-pane.ts";
import type { ToolHost } from "../lib/tool-host.ts";
import { orchestrationIdFromEnv, startupOrchestrationId, storedRuntimeIsMine } from "../lib/orchestration-id.ts";
import { contextPercentOf } from "../lib/session-handoff.ts";
import { createSessionNaming, liveSessionNames } from "../lib/session-name-tools.ts";
import { createSessionMessaging, nodeInboxIO } from "../lib/session-message-tools.ts";
import { nodeRegistryIO, pidAlive, sessionRegistryRoot } from "../lib/session-registry.ts";
import { registerOrchestratorStateTools } from "../lib/orchestrator-tools.ts";
import {
  registerOrchestratorSessionTools,
  type OrchestratorSessionDeps,
} from "../lib/orchestrator-session-tools.ts";
import { readInheritance } from "../lib/session-inheritance.ts";
import { addGrant, emptyRuntime, hasGrant, removeGrant, type OrchestratorRuntime } from "../lib/orchestrator-registry.ts";
import {
  registerJudgeSessionTools,
  registerJudgeWaitTool,
  type JudgeSessionToolDeps,
} from "../lib/judge-session-tools.ts";
import { doWait } from "../lib/judge-wait-tool.ts";
import { registerJudgeSpawnTools } from "../lib/judge-spawn-tools.ts";
import { AUDIT_SELF_WAIT_BUDGET_MS, awaitRoundReport } from "../lib/judge-lifecycle.ts";
// THE TEN ADVANCED ENTRIES ARE GONE (2026-08-30, philosophy three). FIVE of
// them are still IMPLEMENTATIONS, registered into `internalHost` instead of
// into `pi`: the chain calls them so the mechanical checks live in exactly one
// place, and no model can see the names. The two RECORDERS are plain functions
// on no host at all (2026-09-04).
import { registerReviewPrepareTools } from "../lib/review-prepare-tools.ts";
import { registerAdvisoryPrepareTools } from "../lib/advisory-prepare-tools.ts";
import { registerCopilotReviewTools } from "../lib/copilot-review-tools.ts";
import { registerGoalTools } from "../lib/goal-tools.ts";
import { registerRestatementTools } from "../lib/restatement.ts";
import { registerLoopStageTools } from "../lib/loop-stages.ts";
import { recordGoalPrereview, type GoalPrereviewDeps } from "../lib/goal-prereview-tools.ts";
import { evaluateToolCall, type ShipGateHookDeps } from "../lib/ship-gate-hook.ts";
import type { SessionHost } from "../lib/session-host.ts";
import { createStatusStrip } from "../lib/status-strip.ts";
import { createEditTimeChecks } from "../lib/edit-time-checks.ts";
import { appendAuditLog, createArbitrationHost } from "../lib/arbitration-host.ts";
import { createChildSide } from "../lib/child-side-host.ts";
import { createOrchestratorRuntime } from "../lib/orchestrator-runtime-host.ts";
import { createJudgeRegistry } from "../lib/judge-registry-host.ts";
import { createReviewTargets } from "../lib/review-target-host.ts";
import { createJudgeLaunch } from "../lib/judge-launch-host.ts";
import { createPrecommitLane } from "../lib/precommit-lane.ts";
import { createReviewChain } from "../lib/review-chain.ts";
import { createJudgeLanes } from "../lib/judge-lane-host.ts";
import { createJudgeRoundDispatch } from "../lib/judge-round-dispatch.ts";
import { createJudgeRoundSettle } from "../lib/judge-round-settle.ts";
import { createAuditRoundHost } from "../lib/audit-round-host.ts";
import { createReviewVerdictRecorder } from "../lib/verdict-host.ts";
import { createSiblingVerdictRecorders } from "../lib/sibling-verdict-host.ts";
import { createRoundCancel } from "../lib/round-cancel-host.ts";
import { createRoundCancelLedger } from "../lib/round-cancel-ledger.ts";
import { createAcceptanceHost } from "../lib/acceptance-host.ts";
import { createWorktreePresence } from "../lib/worktree-presence-host.ts";
import { asChoiceHost, createGateDialogs, showToUser } from "../lib/gate-dialogs.ts";
import { createDialogProxy } from "../lib/dialog-proxy.ts";
import {
  commitsAheadOfBase,
  currentBranch,
  hasStagedChanges,
  headCommitTree,
  unreviewedTreesSince,
  worktreeTree,
} from "../lib/repo-facts.ts";
import type { ToolUpdate } from "../lib/progress-stream.ts";
import { readJsonIfExists } from "../lib/json-file.ts";
import { sessionDirForCwd } from "../lib/session-dir.ts";
import { createLlmClassifier, type LlmClassifier } from "../lib/llm-classify.ts";
import { loopGoalRelPath } from "../lib/loop-goal.ts";
import { choiceRows, type ChoiceUi } from "../lib/choice-dialog.ts";
import { projectAgentIdentity } from "../lib/agent-frontmatter.ts";
import {
  fetchCopilotPayload,
  fetchCopilotProbe,
  fetchCopilotTimeline,
  requestCopilotReviewer,
  resolveCopilotSupport,
  resolveOpenPr,
  resolveRepoSlug,
} from "../lib/copilot-gh.ts";
// ---- the wave-4 carve-out (t8): state cells, tool bodies, lifecycle ----
import { armLoop, clearBypassToken, createSessionCells } from "../lib/session-cells.ts";
import { createSessionPersistence } from "../lib/session-restore-host.ts";
import { createSessionRepos } from "../lib/session-repos-host.ts";
import {
  createLoopGoalHost,
  loopGoalPathIn,
  nearestExistingDir,
  readSessionLoopGoal,
  SESSION_STATE_VARIANT,
  stationCapFromEnv,
} from "../lib/loop-goal-host.ts";
import { createJudgePaneSelf, registerJudgeSide } from "../lib/judge-pane-self.ts";
import { createModelLayers } from "../lib/model-layers-host.ts";
import { createHandoffHost } from "../lib/handoff-host.ts";
import { createWorktreeSettlement } from "../lib/orchestrator-worktree-host.ts";
import { createAppealLedger, registerArbitrationTool } from "../lib/arbitration-tool.ts";
import { createL2Continuation } from "../lib/l2-continuation.ts";
import { createEditTracking } from "../lib/edit-tracking-hook.ts";
import {
  appendPendingHints,
  createInputHook,
  createToolResultHook,
  EDIT_TOOL_NAMES,
  wireBackgroundWaitSignals,
} from "../lib/tool-event-hooks.ts";
import { registerCheckpointTool } from "../lib/checkpoint-tool.ts";
import { registerPrecommitTool } from "../lib/precommit-tool.ts";
import { registerJudgeSubmitTool } from "../lib/judge-submit-tool.ts";
import { buildJudgeSessionDeps, buildJudgeSpawnDeps } from "../lib/judge-tools-wiring.ts";
import { buildAdvisoryPrepareDeps, buildReviewPrepareDeps } from "../lib/review-prepare-wiring.ts";
import { registerWorkerSurface } from "../lib/worker-wiring.ts";
import { registerDeclareDoneTool } from "../lib/declare-done-tool.ts";
import { registerGateModeTool } from "../lib/gate-mode-tool.ts";
import { createSessionLifecycle } from "../lib/session-lifecycle.ts";
import { createTurnDirective, createTurnEndHook, registerThinkingLoopGuard } from "../lib/turn-directive.ts";

/**
 * Read the PROJECT-layer agent file that actually shadows `name` at runtime:
 * pi-subagents loads every `.md` under <repo>/.pi/agents and registers it
 * under its frontmatter `name`, so a custom-named file DOES override the
 * global one — the widget and /gate-status must find it by IDENTITY, not by
 * basename (round-11 P2). LAST match wins, like everyone else who resolves
 * this (pi-subagents' `projectMap.set`, gate-doctor's `projectByIdentity`).
 */
function findProjectAgentText(projectAgentsDir: string, name: string): string | undefined {
  let found: string | undefined;
  try {
    for (const f of readdirSync(projectAgentsDir)) {
      if (!f.endsWith(".md")) continue;
      let text: string | undefined;
      try {
        text = readFileSync(pathJoin(projectAgentsDir, f), "utf8");
      } catch { continue; }
      if (projectAgentIdentity(text) === name) found = text;
    }
  } catch { /* dir missing/unreadable — no project layer */ }
  return found;
}

/**
 * THE ONE PROCESS-EXIT HANDLER FOR THIS SESSION'S NAME (t2; quality round 2 P2).
 *
 * Registered at MODULE scope and pointed at the CURRENT session's runtime. pi
 * rebuilds the extension runner on every `/new`, `/resume`, `/fork` and
 * `/reload` — each of which re-runs the factory below — so a `process.on("exit")`
 * registered inside it would accumulate one listener per session. One listener
 * per PROCESS, re-pointed by the factory, is the whole fix.
 */
/** Same shape, same reason: the CURRENT session's own tmux session (t4, lib/session-scope-exit.ts). */
let sessionScopeAtExit: (() => void) | undefined;
let sessionNamingAtExit: { release(): unknown } | undefined;
process.on("exit", () => {
  try { sessionNamingAtExit?.release(); } catch { /* the process is already going */ }
  try { sessionScopeAtExit?.(); } catch { /* the process is already going */ }
});

export default function reviewGate(pi: ExtensionAPI) {
  /**
   * Every tool's own `execute`, captured as it is registered.
   *
   * `judge_submit` runs the submission chain (precommit → checkpoint →
   * prepare → dispatch) by CALLING those tools, not by re-implementing them:
   * one implementation, one set of mechanical checks, no second copy to drift.
   */
  type ToolExecute = (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content?: { type: string; text: string }[]; details?: Record<string, unknown>; isError?: boolean }>;
  const toolExecutes = new Map<string, ToolExecute>();
  // Intercepted ONCE, here, rather than at every registration site: every tool
  // this extension registers is captured on its way through, so the chain can
  // never call a stale copy of one.
  const registerToolUpstream = pi.registerTool.bind(pi) as (spec: unknown) => unknown;
  (pi as { registerTool: (spec: unknown) => unknown }).registerTool = (spec: unknown) => {
    const s = spec as { name?: string; execute?: unknown };
    if (typeof s?.name === "string" && typeof s?.execute === "function") {
      toolExecutes.set(s.name, s.execute as ToolExecute);
    }
    return registerToolUpstream(spec);
  };
  /**
   * The INTERNAL host — an implementation the gate runs but does not expose.
   *
   * A tool has two halves: an implementation and a registration. This host
   * keeps the first and drops the second — the body is captured into
   * `toolExecutes` (so `judge_submit` and `propose_loop_goal` still call the ONE
   * implementation) and `pi` never learns the name exists.
   * `test/extension-structure.test.ts` asserts that they are not registered.
   */
  function captureInternalTool(spec: unknown): void {
    const s = spec as { name?: string; execute?: unknown };
    if (typeof s?.name === "string" && typeof s?.execute === "function") {
      toolExecutes.set(s.name, s.execute as ToolExecute);
    }
  }
  /** The `lib/` tool modules register through this. */
  const internalHost: ToolHost = { registerTool: captureInternalTool };
  /**
   * A TEST SEAM, and deliberately not a tool surface: the internal
   * implementations hold mechanical checks whose behavior is the point of
   * several suites. An agent's world is the TOOL REGISTRY, and nothing here is
   * in it.
   */
  (pi as unknown as { __reviewGateInternalTools?: Map<string, ToolExecute> })
    .__reviewGateInternalTools = toolExecutes;

  /**
   * The same seam, for the RECORDERS that are plain functions rather than
   * internal tools (2026-09-04, user decision D4). They take a STRUCTURED
   * conclusion, `pi` never learns a name for either, and the only production
   * callers are the gate's own settle path.
   */
  (pi as unknown as { __reviewGateRecorders?: Record<string, unknown> }).__reviewGateRecorders = {
    recordGoalPrereview: (input: Parameters<typeof recordGoalPrereview>[1], ctx: unknown) =>
      recordGoalPrereview(goalPrereviewDeps, input, ctx),
    recordReviewVerdict: (concluded: ReportConclusion, repo: string, ctx: unknown) =>
      recordReviewVerdict(concluded, repo, ctx),
    // THE QUALITY RECORDER: since 2026-09-16 a functional READY can only be
    // recorded when a quality standing covers the SAME head.
    recordQualityVerdict: (concluded: ReportConclusion, repo: string, ctx: unknown) =>
      recordQualityVerdict(concluded, repo, ctx),
  };

  /**
   * The lane, exposed for the ONE test that needs a lane to actually be running
   * (a parked READY can only be revived by that lane's own landing). SIDE
   * EFFECT: starting a lane RESETS the recorded `precommit` entry to `NOT_RUN`.
   */
  (pi as unknown as { __reviewGateTestSeams?: Record<string, unknown> }).__reviewGateTestSeams = {
    startFullLane: (root: string, ctx: unknown) => startPrecommitBeside(root, ctx).settled,
  };

  /** Call another gate tool internally; a missing tool is a programming error. */
  async function callTool(
    name: string,
    params: Record<string, unknown>,
    ctx: unknown,
    /** Live-output sink forwarded to the called tool (the chain streams). */
    onUpdate?: ToolUpdate,
    /** The caller's abort signal, forwarded so ESC can stop internal waits. */
    signal?: AbortSignal | undefined,
  ) {
    const run = toolExecutes.get(name);
    if (!run) throw new Error(`review-gate: internal tool ${name} is not registered`);
    return run(`internal-${name}`, params, signal, onUpdate, ctx);
  }
  /** Bridge an internal wait's motion frames into the chain's own progress tail. */
  function forwardWaitUpdates(progress: { tail?(text: string): void; step?(t: string): void } | undefined): ToolUpdate | undefined {
    if (!progress) return undefined;
    return (partial) => {
      const text = (partial.content ?? []).map((c) => c.text).join("\n").slice(-500).trim();
      if (!text) return;
      if (progress.tail) progress.tail(text);
      else progress.step?.(text.slice(0, 120));
    };
  }
  /**
   * THE GATE'S OWN WAIT (2026-09-08). The single `wait` step addresses the
   * auditor by JUDGE ID through `doWait` directly instead of
   * `callTool("judge_wait", { repo })`: the tool path re-runs `addressJudge`'s
   * "has this session edited that repo" check, which refuses a legitimate
   * self-audit of an unedited repo. The judgeId comes from this session's own
   * registry, never from an agent-supplied parameter.
   */
  async function selfAuditWait(
    root: string,
    ctx: unknown,
    onUpdate: ToolUpdate | undefined,
    signal: AbortSignal | undefined,
  ) {
    return awaitRoundReport({
      wait: (timeoutMs) => {
        const judgeId = judgeChildByRole(root, "goal-auditor")?.judgeId;
        if (judgeId === undefined) {
          return Promise.resolve({
            content: [{ type: "text", text: "review-gate: no judge on record — submit a round first (judge_submit)." }],
            details: { done: false, reason: undefined, role: undefined, hasVerdict: false },
            isError: true,
          });
        }
        // Pass the LIVE signal through, never a frozen snapshot: `pollUntil`
        // reads `aborted` on every tick.
        return doWait(
          selfSessionDeps(),
          { sessionId: judgeId, timeoutMs },
          signal,
          onUpdate,
          true, // gateSelf: the gate's own chain, never an agent param
        );
      },
      now: () => Date.now(),
      aborted: () => signal?.aborted === true,
      // THE GATE OWNS ITS OWN BUDGET (2026-09-19): an audit is not an agent
      // wait — see `AUDIT_SELF_WAIT_BUDGET_MS`.
      budgetMs: AUDIT_SELF_WAIT_BUDGET_MS,
    }) as ReturnType<typeof callTool>;
  }

  /** The text a tool result carries (its content joined). */
  function toolText(result: { content?: { type: string; text: string }[] }): string {
    return (result.content ?? []).map((c) => c.text).join("\n");
  }

  /**
   * The payload a `prepare_*` tool built, split off its human-facing header.
   * A result WITHOUT the marker is handed over whole rather than silently
   * truncated.
   */
  function extractTaskText(prepared: string): string {
    const at = prepared.indexOf(TASK_TEXT_MARKER);
    if (at < 0) return prepared;
    return prepared.slice(at + TASK_TEXT_MARKER.length).trim() || prepared;
  }

  // ---------- the session: cells, persistence, repos, the host ----------

  const cells = createSessionCells();
  const { persist, restore, setTaskMode, resetSessionState, noteGateStatePersistSkip } = createSessionPersistence(cells, {
    pi,
    updateWidget: (ctx) => updateWidget(ctx),
    handedOff: () => handedOff(),
    reportChildState: (ctx, note, opts) => reportChildState(ctx, note, opts),
    resetOrchestratorContinuations: () => resetOrchestratorContinuations(),
  });
  const repos = createSessionRepos(cells, {
    persist,
    noteGateStatePersistSkip,
    callerIdentity: () => callerIdentity(),
    resolveJudgeLane: (root, role, opener) => resolveJudgeLane(root, role, opener),
  });
  const {
    stateForRepo, persistRepo, repoLabel, knownRepoRoots, crossRepoVerdictHint, otherRepoStatus,
    resolveToolRepo, enforcementStateFor, reviewScopeFor, previousRoundFindings, settledConclusion,
    copilotEnabled, repoDirFor,
  } = repos;

  /**
   * THE SESSION HOST — what every module carved out of this closure reads the
   * session through (lib/session-host.ts). Accessors, never values.
   */
  const host: SessionHost = {
    state: () => cells.state,
    stateFor: (root) => stateForRepo(root),
    persist: (ctx) => persist(ctx),
    persistRepo: (ctx, root) => persistRepo(ctx, root),
    repos: () => ({
      primary: cells.primaryRepoRoot,
      active: cells.activeRepoRoot.current,
      all: cells.sessionRepos,
      cwd: cells.cwd,
      inGit: cells.sessionInGit,
    }),
    ctx: () => cells.latestCtx,
    log: (text) => appendAuditLog(cells.primaryRepoRoot, cells.state.sessionId, text),
  };
  const { log } = host;

  const judgeSelf = createJudgePaneSelf(cells);
  const { isJudgePane, noteJudgeTaskText } = judgeSelf;
  const loopGoal = createLoopGoalHost(cells, {
    stateForRepo, persistRepo, persist, knownRepoRoots, isJudgePane,
    askMultiChoice: (uiCtx, spec, opts) => askMultiChoice(uiCtx, spec, opts),
    log,
  });
  const {
    loopGoalConfirmed, stageIsOn, laneVerificationWaived, goalStageSatisfied,
    ensureLoopStagesFor, deliveryStationFor, loopGoalEditBlockFor, goalTextForReviewers,
  } = loopGoal;

  // ---- TUI widgets (display-only; never throw, never block the gate) ----
  const { contractReadout, updateWidget, armUiRefreshTimer, disarmUiRefreshTimer } = createStatusStrip(host, {
    goalStageSatisfied: () => goalStageSatisfied(),
    goalStageOn: () => stageIsOn("goal"),
    isJudgePane,
    judgeTaskRound: () => cells.judgeTaskRound,
    sessionEdited: () => cells.sessionEdited || cells.sessionEditedPaths.size > 0,
    loopGoalPresent: (root) => readSessionLoopGoal(root).present,
    loopGoalPath: (root) => loopGoalPathIn(root),
    lastUiCtx: cells.lastUiCtx,
  });
  const { freshProjectConfig, ensureModelLayersRendered } = createModelLayers(cells, { log });
  const { appealsUsed, spendArbitration, refuseText } = createAppealLedger(cells, {
    persist,
    appendLesson: (text) => appendLesson(text),
  });

  // ---------- the CHILD side of the supervision channel (lib/child-side-host.ts) ----------
  const channelIO: ChannelIO = nodeChannelIO();
  const childSide = createChildSide(host, {
    pi,
    channelIO,
    activeJudgeWait: () => activeJudgeWait(),
    isJudgePane,
    noteJudgeTaskText,
  });
  const {
    childBinding, reportChildState, noteChildProgress, noteToolActivity, startChildHeartbeat,
    stopChildHeartbeat, drainChildInstructions, askEitherSide,
  } = childSide;

  // ---------- ONE gate session per worktree (lib/worktree-presence-host.ts) ----------
  const { holdWorktree, releaseWorktree, applySessionExclusivity, stopExclusivityRecheck } =
    createWorktreePresence(host, { lastUiCtx: cells.lastUiCtx });

  // ---------- orchestration layer (the project-manager role) ----------
  //
  // The orchestration id is an ADDRESS, not an identity: a relay successor
  // inherits the predecessor's id from its environment. A session started
  // without one mints its own the first time it needs it.
  let orchestrationIdValue: string | undefined = orchestrationIdFromEnv();
  /**
   * The session that HOLDS this orchestration, as written to the sidecar — it
   * answers "is the runtime on disk mine to resume?" and is deliberately not
   * `state.sessionId` (the B1 rule).
   */
  let orchestrationOwner: string | undefined;
  function currentOrchestrationId(): string {
    const state = cells.state;
    if (!orchestrationIdValue) {
      const stored = state.orchestrator;
      orchestrationIdValue = startupOrchestrationId({
        env: process.env,
        storedId: stored?.orchestrationId,
        // The durable answer, never "did the sidecar carry my session id".
        storedBelongsToThisSession: storedRuntimeIsMine({
          ownerSessionId: stored?.ownerSessionId,
          sessionId: state.sessionId,
        }),
        repoRoot: cells.primaryRepoRoot,
      });
    }
    // WHICHEVER WAY IT RESOLVED, THIS SESSION HOLDS IT (written with the
    // runtime in `persistOrchestration`).
    orchestrationOwner = state.sessionId ?? undefined;
    return orchestrationIdValue;
  }
  /** Take over an existing orchestration's ADDRESS (B1, `orchestrator_attach`). */
  function adoptOrchestrationId(id: string): void {
    orchestrationIdValue = id;
    // TAKEOVER IS A CLAIM: from here this session owns the address.
    orchestrationOwner = cells.state.sessionId ?? undefined;
  }
  /** Started BY an orchestrator as a worker (not as its relay successor). */
  function isOrchestrationChild(): boolean {
    return orchestrationIdFromEnv() !== undefined && readInheritance().predecessorPane === undefined;
  }
  function persistOrchestration(runtime: OrchestratorRuntime): void {
    // THE OWNER RIDES WITH THE RECORD (a runtime inherited but never claimed
    // keeps the owner it already had). No `if (latestCtx)`: an in-memory-only
    // runtime would silently lose the user's plan approval on a restart.
    cells.state.orchestrator = orchestrationOwner === undefined
      ? runtime
      : { ...runtime, ownerSessionId: orchestrationOwner };
    persist(cells.latestCtx);
  }
  /**
   * MY OWN TMUX SESSION (lib/session-tmux-scope.ts): built ONCE and injected
   * everywhere a child can be opened, so "which session do my children go in"
   * has one answer in the process.
   */
  const tmuxScope: TmuxScope = {
    sessionId: () => cells.state.sessionId?.trim() || undefined,
    repoRoot: () => cells.primaryRepoRoot,
    read: () => sanitizeScopeRecord(cells.state.tmuxScope),
    write: (record) => {
      cells.state.tmuxScope = record;
      persist(cells.latestCtx ?? cells.lastUiCtx.current);
    },
    now: () => new Date().toISOString(),
    ownerProcess: () => ({ pid: process.pid, pane: process.env.TMUX_PANE?.trim() || undefined }),
  };
  const worktrees = createWorktreeSettlement(cells, { persistOrchestration });

  const orchestratorDeps = createOrchestratorDeps({
    repoRoot: cells.primaryRepoRoot,
    scope: tmuxScope,
    taskMode: () => cells.state.taskMode,
    // THE one banner channel: `add-decision` announces a decision the moment
    // it registers one (constraint 11).
    notifyUser: (opts) => raiseBanner({ kind: opts.kind, detail: opts.detail }),
    // Read live: `propose_restatement` writes it during the same session.
    restatement: () => cells.state.restatement,
    loadRuntime: () => cells.state.orchestrator,
    storeRuntime: persistOrchestration,
    // B2 — one log, one grep.
    log: (message) => { log(message); },
    orchestrationId: currentOrchestrationId,
    adoptOrchestrationId,
    askChoice: (spec, opts) => askChoice(asChoiceHost(cells.latestCtx ?? {}), spec, opts),
    // O-1 — the plan's full text goes into the TRANSCRIPT before the dialog.
    showToUser: (title, text) => { showToUser(cells.latestCtx ?? {}, title, text); },
    // ROUND-4 P1 — `orchestrator_wait`'s fourth block is computed from this.
    contextPercent: () => contextPercentOf(cells.latestCtx as unknown as { getContextUsage?: () => unknown }),
    auditPlan: (plan, onUpdate, signal) => runPlanAudit(plan, onUpdate as { step?: (t: string) => void; done?: (t: string) => void } | undefined, signal),
    sessionTranscriptPath: () => {
      try {
        const dir = sessionDirForCwd(cells.cwd);
        return cells.state.sessionId ? `${dir}/${cells.state.sessionId}.jsonl` : undefined;
      } catch { return undefined; }
    },
    // Handed to a successor as its takeover proof (lib/orchestrator-relay.ts).
    ownSessionId: () => cells.state.sessionId ?? undefined,
    // WHERE THE CHILD WORKS (2026-09-18, A): the session's own rebase-aware read.
    currentBranch: (root) => currentBranch(root),
    // ONE CHECKOUT PER WRITER (lib/orchestrator-worktree-host.ts).
    createWorktree: worktrees.createWorktree,
    settleWorktree: worktrees.settleWorktree,
    knownRepoRoots: () => knownRepoRoots(),
    // Symmetric re-arm (goal 5): the project manager's work is its
    // orchestration tools, so it re-arms itself by managing.
    onToolCall: () => { armLoop(cells); },
    // RETIRE — the two-phase handover retirement (lib/handoff-host.ts).
    onHandoff: () => handoff.handoffRetirement(),
  });
  registerOrchestratorStateTools(pi, orchestratorDeps);
  // The session tools take the orchestration deps as they are, through an
  // alias — one live object, never a frozen spread.
  const sessionDeps: OrchestratorSessionDeps = orchestratorDeps;
  registerOrchestratorSessionTools(pi, sessionDeps);

  // ---------- THE ONE HANDOVER (lib/handoff-host.ts) ----------
  const handoff = createHandoffHost(pi, cells, {
    runTmux: (argv, env) => runTmux(argv, env),
    tmuxScope,
    judgeTaskText: judgeSelf.judgeTaskText,
    releaseWorktree,
    holdWorktree,
    stopChildHeartbeat,
    runtimeClocks: () => ({ handedOff, markHandedOff, stopSupervisionTimer, stopRevivalTimer }),
    orchestration: () => orchestratorDeps,
    registry: () => ({ ensureHierarchyLoaded, judgeHierarchy, setHierarchy, persistJudgeHierarchy }),
  });
  pi.on("tool_result", (event) => handoff.onSuccessionToolResult(event));

  /**
   * THE registry of pane judges (lib/judge-registry-host.ts), the round's
   * review target (lib/review-target-host.ts) and what a round launches on
   * (lib/judge-launch-host.ts). `judgeHierarchy()` is an ACCESSOR.
   */
  const registry = createJudgeRegistry(host, {
    runTmux: (argv) => runTmux(argv),
    channelIO,
    roundBindingOf: (judge) => roundBindingOf(judge),
    copilotWaitSince: () => cells.copilotWaitSince,
  });
  const {
    judgeHierarchy, pendingAudits, setHierarchy, dropAudits, persistJudgeHierarchy, ensureHierarchyLoaded,
    reloadJudgeHierarchy, callerIdentity, callerIdentities, paneOwnerIdentity, ownJudges, ownLiveJudges,
    activeJudgeWait, judgeModelHealth, absorbJudgeModelEvents, judgeCurrentRound, dropDeadForeignJudges,
    nextJudgeRound,
  } = registry;
  const { reviewTargets, noteQualityRoundDispatched, qualityRoundInFlight } =
    createReviewTargets(host, { ownLiveJudges });
  const { resolveJudgeLaunch, sweepStaleJudgeSessionDirs } = createJudgeLaunch(host, {
    freshProjectConfig,
    ensureModelLayersRendered,
    judgeModelHealth,
    judgeHierarchy,
  });

  /**
   * The tmux sessions the WORKER registry names, read on demand — ONLY THE
   * ROWS OF THIS SESSION'S LINE (2026-09-25, t4 whole-branch review P1): the
   * file is per REPO, and another session's session is still somebody else's.
   * BOTH ID FLAVOURS ARE THE LINE (judge rows record `callerIdentity()`,
   * worker rows the plain `sessionId`).
   */
  const workerRegistrySessions = (): Array<string | undefined> => {
    try {
      const entries = parseWorkerRegistry(readJsonIfExists(pathJoin(cells.activeRepoRoot.current, WORKER_REGISTRY_RELPATH)));
      const line = new Set<string>(callerIdentities());
      const own = cells.state.sessionId?.trim();
      if (own) line.add(own);
      return Object.values(entries)
        .filter((entry) => line.has(entry.openerId))
        .map((entry) => entry.tmuxSession);
    } catch {
      // No registry yet, or an unreadable one: both only ever narrow the list.
      return [];
    }
  };

  /**
   * THE OWNERSHIP PROBE — the marker read that turns a name some registry
   * mentions into a session this process may actually DECLARE. It rides the
   * raw runner, so it cannot recurse into the declaration it is building.
   */
  const sessionOwnership = createOwnershipProbe(tmuxScope, (argv) => rawTmux(argv));

  /**
   * THE RUNNER, and the only one this file uses (2026-09-25). It carries THIS
   * session's declaration on every call, so the four session commands are
   * refused unless their target is one of the sessions this process holds
   * coordinates for (its own, the lineage's judges, its children, its
   * workers). The raw runner is imported under a different name so that
   * forgetting the declaration is not expressible. Declared AFTER the
   * registries it closes over (a `let` read before its declaration is a TDZ
   * error).
   */
  const runTmux = (argv: readonly string[], env?: NodeJS.ProcessEnv, extraSessions?: readonly string[]) =>
    rawTmux(argv, env ?? process.env, {
      ownSessions: addressableSessions(
        tmuxScope,
        [
          ...ownJudges().map((entry) => entry.tmuxSession),
          ...(cells.state.orchestrator?.children ?? []).map((child) => child.tmuxSession),
          ...workerRegistrySessions(),
        ],
        sessionOwnership,
        // SESSIONS THIS CALL PROVED ARE GATE SESSIONS ANYWAY (the orphan
        // sweep's marker-verified dead sessions, t2/t4 review P1).
        extraSessions,
      ),
    });

  /**
   * THE SESSION'S OWN NAME (2026-09-25, t2) — a REGISTRY RATHER THAN GATE
   * STATE: the name is global, renewed by a timer, and read by processes that
   * never share this session's state (lib/session-registry.ts).
   */
  const sessionNaming = createSessionNaming({
    runTmux,
    sessionId: () => cells.state.sessionId?.trim() || undefined,
    ownPane: () => process.env.TMUX_PANE?.trim() || undefined,
    // THE SERVER HALF OF THE COORDINATES (t4 review P1).
    tmuxServer: () => tmuxServerFrom(process.env),
    repoRoot: () => cells.primaryRepoRoot,
    cwd: () => cells.cwd,
    mode: () => handoff.ownSessionKind(),
    // A COARSE READING IS ENOUGH: "is anybody there" is the question.
    state: () => (cells.latestCtx?.isIdle?.() ? "idle" : "working"),
    scopeSession: () => tmuxScope.read()?.name,
    log: (message) => log(`review-gate[session-name] ${message}`),
    onLost: (reason) => {
      // NOT A SILENT LOSS: everything that addressed this session by name now
      // reaches somebody else (or nobody).
      log(`review-gate[session-name] ${reason}`);
      try { cells.latestCtx?.ui?.notify?.(`review-gate: ${reason}`, "warning"); } catch { /* headless */ }
    },
  });

  /**
   * ONE SESSION MESSAGING ANOTHER (2026-09-25, t3) — sharing the registry root
   * with the name that addresses it (lib/session-message-tools.ts).
   */
  const sessionRegistryRootDir = sessionRegistryRoot();
  const sessionRegistryFiles = nodeRegistryIO(sessionRegistryRootDir);
  const sessionMessaging = createSessionMessaging({
    root: sessionRegistryRootDir,
    io: nodeInboxIO(),
    // WHO IS STILL A SESSION is the registry's own answer (t2).
    liveSessions: () => liveSessionNames({
      root: sessionRegistryRootDir,
      io: sessionRegistryFiles,
      runTmux: (argv) => runTmux(argv, undefined),
      alive: pidAlive,
      // WHICH SERVER THIS PROCESS IS ON (t4 review P1).
      tmuxServer: () => tmuxServerFrom(process.env),
    }),
    self: () => ({
      name: sessionNaming.currentName(),
      sessionId: cells.state.sessionId ?? "",
      repo: cells.primaryRepoRoot,
      mode: handoff.ownSessionKind(),
    }),
    // THE INJECTION IS A STEER: the recipient finishes its tool call first.
    inject: (text) => { pi.sendUserMessage(text, { deliverAs: "steer" }); },
    log: (message) => log(`review-gate[session-message] ${message}`),
  });

  /** THE SESSION'S RUNTIME CLOCKS (lib/orchestrator-runtime-host.ts). */
  const {
    orchestrationDoneProblems, orchestratorSettled, startRevivalTimer, stopRevivalTimer, stopSupervisionTimer,
    startSessionNamingHeartbeat, stopSessionNamingHeartbeat, handedOff, markHandedOff,
    resetOrchestratorContinuations,
  } = createOrchestratorRuntime(host, {
    pi,
    orchestratorDeps,
    channelIO,
    currentOrchestrationId: () => currentOrchestrationId(),
    lastRunAborted: () => cells.lastRunAborted,
    arbitrationPaused: () => cells.arbitrationPaused,
    updateWidget: (ctx) => updateWidget(ctx),
    goalStageSatisfied: () => goalStageSatisfied(),
    copilotProblemsFor: (st) => repos.copilotProblemsFor(st),
    repoLabel,
    projectConfig: () => cells.projectConfig,
    sessionNaming,
    sessionMessaging,
  });
  // THE NAME GOES BACK WHEN THE PROCESS DIES, however it dies (t2).
  sessionNamingAtExit = sessionNaming;
  // AND THE SESSION'S OWN TMUX SESSION WITH IT (t4) — idempotent, so a /quit
  // that already closed it in session_shutdown finds nothing here.
  const closeScopeOnExit = (): void => {
    const outcome = closeOwnSessionOnExit((argv) => runTmux(argv), tmuxScope, {
      handedOff: handedOff(),
      openChildren: (cells.state.orchestrator?.children ?? []).filter((child) => !child.closedAt).length,
    });
    log(`review-gate[session-scope] 退出时：${outcome.note}`);
  };
  sessionScopeAtExit = closeScopeOnExit;
  // `name_session()` / `send_message()` — registered for EVERY kind of session
  // (user decision, 2026-09-25).
  sessionNaming.register(pi);
  sessionMessaging.register(pi);

  // LLM semantic guard layer (lib/llm-classify.ts), lazily (re)created so it
  // always reflects the loaded projectConfig model. Tighten-only + fail-back.
  let llmClassifier: LlmClassifier | null = null;
  let llmClassifierModel = "";
  function classifier(): LlmClassifier {
    const model = cells.projectConfig.llmGuards.model;
    if (!llmClassifier || llmClassifierModel !== model) {
      llmClassifier = createLlmClassifier(model);
      llmClassifierModel = model;
    }
    return llmClassifier;
  }

  // THE BANNER CHANNEL (user decision, 2026-09-17) — POLICY in
  // lib/user-notify.ts, RUNTIME in lib/user-notify-runtime.ts; this file only
  // supplies the session's plumbing.
  const notifyRuntime = createUserNotifyRuntime({
    state: () => cells.state,
    persist: () => persist(cells.latestCtx),
    repoName: () => pathBasename(cells.primaryRepoRoot),
    taskMode: () => cells.state.taskMode,
    env: () => process.env,
    interactive: () => sideEffectsEnabled(process.env, process.stdout.isTTY === true),
    runTmux: (argv) => runTmux(argv),
  });
  // KIND TWO of three is registered once, for the whole process.
  notifyRuntime.armExitHandler();
  /** Raise the banner for one event. Never throws; never claims delivery. */
  const raiseBanner = (opts: { kind: UserNotifyKind; detail: string; blocking?: boolean }) =>
    notifyRuntime.notify(opts);

  // ---------- L2 (lib/l2-continuation.ts) ----------
  const l2 = createL2Continuation(cells, {
    pi,
    childSide,
    registry,
    settleFinishedRounds: (ctx) => settleFinishedRounds(ctx),
    runtime: () => ({ handedOff, orchestratorSettled, startRevivalTimer }),
    goalStageSatisfied: () => goalStageSatisfied(),
    copilotProblemsAcrossRepos: repos.copilotProblemsAcrossRepos,
    updateWidget: (ctx) => updateWidget(ctx),
    persist,
  });

  // ---------- user-visible output channels (lib/gate-dialogs.ts + lib/dialog-proxy.ts) ----------
  const dialogProxy = createDialogProxy(host, {
    resolveArbiterModel: () => resolveArbiterModel(),
    ownTranscriptPath: () => handoff.ownTranscriptPath(),
  });
  const { askChoice, askMultiChoice } = createGateDialogs(host, {
    proxy: dialogProxy,
    raiseBanner: (opts) => raiseBanner(opts),
    lastUserInteractionAt: cells.lastUserInteractionAt,
  });

  // ---------- L6 (edit time) + the arbitration I/O they share a quota with ----------
  const { editedTestContent, checkTestLabels, llmNotice } = createEditTimeChecks(host, {
    projectConfig: () => cells.projectConfig,
    classifier: () => classifier(),
    refuseText,
  });
  const arbitration = createArbitrationHost(host, {
    projectConfig: () => cells.projectConfig,
    appealsUsed,
    spendArbitration,
    arbitrationDecisions: cells.arbitrationDecisions,
    grantInspectionPass: (pass) => { cells.inspectionPass = pass; },
  });
  const { computeTokenBindings, resolveArbiterModel, appendLesson } = arbitration;

  // ---------- L1: tool_call — sensitive files + ship gate (lib/ship-gate-hook.ts) ----------
  const shipGateHookDeps: ShipGateHookDeps = {
    noteContext: (c) => { cells.latestCtx = c as ExtensionContext; },
    // A HINT, not a refusal — and it rides THE CALL'S OWN RESULT (user
    // decision, 2026-09-14). Deduplicated per session.
    hint: (message) => {
      if (cells.deliveredHints.has(message)) return;
      cells.deliveredHints.add(message);
      cells.pendingHints.push(message);
    },
    isEditTool: (toolName) => EDIT_TOOL_NAMES.has(toolName),
    isJudgeSession: () => readJudgeSideEnv(process.env) !== undefined,
    // THE STAGE FALLBACK (2026-09-22): the box the USER answers once per session.
    ensureLoopStages: (ctx) => ensureLoopStagesFor(ctx),
    cwd: () => cells.cwd,
    primaryRepoRoot: () => cells.primaryRepoRoot,
    taskMode: () => cells.state.taskMode,
    relayHandoffPath: () => cells.state.orchestrator?.relay?.handoffPath,
    sensitiveGrants: () => cells.sensitiveGrants,
    sensitiveDeclined: (absPath) => cells.sensitiveDeclinedPaths.has(absPath),
    nearestExistingDir,
    loopGoalEditBlockFor,
    checkTestLabels: (path, input, ctx) => checkTestLabels(
      path,
      editedTestContent(input, path),
      ctx,
      llmNotice(ctx),
    ),
    markSessionEdited: () => { cells.sessionEdited = true; },
    bypassActive: () => cells.state.bypass.active,
    projectConfig: () => cells.projectConfig,
    sessionRepos: () => cells.sessionRepos,
    knownRepoRoots,
    enforcementStateFor,
    stateForRepo,
    repoLabel,
    currentBranch,
    worktreeTree,
    headCommitTree,
    hasStagedChanges,
    unreviewedTreesSince,
    loopGoalConfirmed: () => goalStageSatisfied(),
    deliveryStation: (root) => deliveryStationFor(root),
    crossRepoVerdictHint,
    classifier,
    notice: (ctx) => llmNotice(ctx),
    refuseText,
    appendLesson,
    bypassToken: () => cells.bypassToken,
    setBypassToken: (token) => { cells.bypassToken = token; },
    // The tmux permission is read LIVE off the state (minted mid-session).
    tmuxAccess: () => cells.state.tmuxAccess,
    consumeTmuxAccess: () => {
      // One use, and only a ONE-SHOT is consumed.
      if (cells.state.tmuxAccess?.scope !== "once") return;
      delete cells.state.tmuxAccess;
      persist(cells.latestCtx);
    },
    clearBypassToken: () => clearBypassToken(cells),
    computeTokenBindings,
    setLastBlockedShip: (record) => { cells.lastBlockedShip = record; },
  };

  // ONE `tool_call` handler, TWO jobs, in this order: the activity line is
  // refreshed BEFORE the gate decides (the receipt's answer to "spinning or
  // working" — 2026-09-17).
  pi.on("tool_call", (event, ctx) => {
    noteToolActivity(describeToolActivity(String(event.toolName ?? ""), event.input));
    return evaluateToolCall(shipGateHookDeps, event, ctx);
  });
  // THE HINTS RIDE THE RESULT (user decision, 2026-09-14).
  pi.on("tool_result", (event) => appendPendingHints(cells, event));

  // ---------- track edits & precommit results (lib/tool-event-hooks.ts) ----------
  const onToolResult = createToolResultHook(cells, {
    childSide,
    isJudgePane,
    judgeCurrentRound: () => judgeCurrentRound(),
    judgeOwnPaths: judgeSelf.judgeOwnPaths,
    goalStageSatisfied: () => goalStageSatisfied(),
    stateForRepo,
    persistRepo,
    onEditResult: createEditTracking(cells, { stateForRepo, persist, persistRepo, repoRelative: repos.repoRelative, log }),
  });
  pi.on("tool_result", (event, ctx) => onToolResult(event, ctx));

  // ---------- review_checkpoint (internal; lib/checkpoint-tool.ts) ----------
  registerCheckpointTool(internalHost, cells, {
    resolveToolRepo, stateForRepo, persistRepo, refuseText, stageIsOn,
    precommitLaneRunning: (root) => precommitLaneRunning(root),
  });

  // ---------- the review loop's host modules ----------

  /**
   * What the goal-audit recorder needs from this session — spread into
   * `registerGoalTools` below, so the recorder and the approval tool can never
   * drift apart on which repo they read and write.
   */
  const goalPrereviewDeps: GoalPrereviewDeps = {
    primaryRepoRoot: () => cells.primaryRepoRoot,
    cwd: () => cells.cwd,
    stateFor: (root) => stateForRepo(root),
    persist: (ctx, root) => persistRepo(ctx as unknown as ExtensionContext, root),
    log: (message) => log(message),
  };

  /**
   * THE REVIEW LOOP'S HOST MODULES (t7). They reference each other in a
   * cycle, so every cross-module dep is a lambda read at CALL time.
   */
  const judgeLanes = createJudgeLanes(host, {
    registry: { judgeHierarchy, setHierarchy, dropAudits },
    runTmux: (argv) => runTmux(argv),
    loopGoalConfirmed,
    reviewScopeFor,
    settledConclusion,
    previousRoundFindings,
  });
  const { resolveJudgeLane, reapReviewScratch } = judgeLanes;
  const cancelLedger = createRoundCancelLedger();
  const { dispatchJudgeRound } = createJudgeRoundDispatch(host, {
    cancelLedger,
    registry: {
      judgeHierarchy, setHierarchy, dropAudits, callerIdentity, paneOwnerIdentity,
      absorbJudgeModelEvents, nextJudgeRound, dropDeadForeignJudges,
    },
    lanes: judgeLanes,
    reviewTargets,
    stageIsOn,
    runTmux: (argv) => runTmux(argv),
    channelIO,
    tmuxScope,
    resolveJudgeLaunch,
    sweepStaleJudgeSessionDirs,
  });
  const settle = createJudgeRoundSettle(host, {
    pi,
    registry: {
      judgeHierarchy, pendingAudits, ownJudges, absorbJudgeModelEvents,
      reloadJudgeHierarchy, callerIdentities, paneOwnerIdentity,
    },
    channelIO,
    runTmux: (argv) => runTmux(argv),
    announcedRequestIds: () => cells.announcedRequestIds,
    auditRoundDeps: (ctx) => auditRoundDeps(ctx),
    applyRoundCancel: (kind, root, ctx) => applyRoundCancel(kind, root, ctx),
    resumeParkedReady: (root, ctx) => resumeParkedReady(root, ctx),
  });
  const { judgeChildByRole, checkpointAtFor, roundBindingOf, settleFinishedRounds } = settle;
  const { precommitLaneRunning, abortPrecommitLane, waitForQuietLane, startPrecommitBeside } =
    createPrecommitLane(host, {
      pi,
      callTool,
      toolText,
      applyCancelPlan: (plan, root, why) => applyCancelPlan(plan, root, why),
      resumeParkedReady: (root, ctx, landing) => resumeParkedReady(root, ctx, landing),
    });
  const { recordReviewVerdict } = createReviewVerdictRecorder(host, {
    reviewTargets,
    resolveToolRepo,
    reviewScopeFor,
    stageIsOn,
    laneVerificationWaived,
    precommitLaneRunning,
    qualityRoundInFlight,
    clearBypassToken: () => clearBypassToken(cells),
    setLoopArmed: (armed) => { cells.loopArmed = armed; },
    maybeStrategicReset: (st) => l2.maybeStrategicReset(st),
    lastGateEventAt: cells.lastGateEventAt,
  });
  const { recordQualityVerdict, recordAcceptanceVerdict } = createSiblingVerdictRecorders(host, {
    reviewTargets,
    resolveToolRepo,
    stageIsOn,
    lastGateEventAt: cells.lastGateEventAt,
  });
  const { cancelJudgeRound, resumeParkedReady, applyCancelPlan, applyRoundCancel } = createRoundCancel(host, {
    pi,
    cancelLedger,
    registry: { judgeHierarchy, setHierarchy, absorbJudgeModelEvents },
    runTmux: (argv) => runTmux(argv),
    reviewTargets,
    stageIsOn,
    laneVerificationWaived,
    judgeChildByRole,
    closeJudgePaneOf: judgeLanes.closeJudgePaneOf,
    reapReviewScratch,
    precommitLaneRunning,
    abortPrecommitLane,
    qualityRoundInFlight,
    recordReviewVerdict,
  });
  const { auditRoundDeps, auditRunDeps, buildGoalAuditRound } = createAuditRoundHost(host, {
    registry: { judgeHierarchy, setHierarchy, dropAudits, pendingAudits, persistJudgeHierarchy },
    channelIO,
    lastUiCtx: cells.lastUiCtx,
    callTool,
    toolText,
    extractTaskText,
    goalPrereviewDeps,
    judgeChildByRole,
    checkpointAtFor,
    dispatchJudgeRound,
    recordReviewVerdict,
    recordQualityVerdict,
    recordAcceptanceVerdict,
    selfAuditWait,
    forwardWaitUpdates,
    selfSessionDeps: () => selfSessionDeps(),
  });
  const { submitForReview, runGoalAudit, runPlanAudit } = createReviewChain(host, {
    callTool,
    toolText,
    extractTaskText,
    stageIsOn,
    reviewTargets,
    waitForQuietLane,
    startPrecommitBeside,
    buildGoalAuditRound,
    auditRunDeps,
  });
  const { armAcceptanceRound } = createAcceptanceHost(host, {
    reviewTargets,
    runTmux: (argv) => runTmux(argv),
    stageIsOn,
    repoLabel,
    loopGoalConfirmed,
    readSessionLoopGoal,
    loopGoalPathIn,
    judgeChildByRole,
    dispatchJudgeRound,
  });

  // ---------- judge_submit (lib/judge-submit-tool.ts) ----------
  registerJudgeSubmitTool(pi, cells, {
    resolveToolRepo, stateForRepo, persistRepo, stageIsOn, callTool, toolText, extractTaskText,
    submitForReview, buildGoalAuditRound, dispatchJudgeRound, cancelJudgeRound, noteQualityRoundDispatched,
    registry, cancelLedger,
  });

  // ---------- judge_wait / judge_close / judge_spawn (lib/judge-tools-wiring.ts) ----------
  const judgeToolsWiring = {
    registry,
    settle,
    channelIO,
    runTmux: (argv: readonly string[]) => runTmux(argv),
    tmuxScope,
    resolveToolRepo,
    auditRoundDeps,
    buildGoalAuditRound,
    applyRoundCancel,
    cancelLedger,
    resolveJudgeLane,
    resolveJudgeLaunch,
    cancelChildWaitTimer: () => l2.cancelChildWaitTimer(),
  };
  /**
   * THE GATE'S OWN DEPS HANDLE (2026-09-08): the gate's self-audit chains call
   * the SAME `doWait` / `doClose` through this accessor — one object, not a
   * copy (哲学三).
   */
  function selfSessionDeps(): JudgeSessionToolDeps {
    return judgeSessionDeps;
  }
  const judgeSessionDeps = buildJudgeSessionDeps(cells, judgeToolsWiring);
  // `judge_close` stays INTERNAL (the gate's own audit chains); `judge_wait` is
  // on BOTH hosts — the same implementation (2026-09-05, user decision D1).
  registerJudgeSessionTools(internalHost, judgeSessionDeps);
  registerJudgeWaitTool(pi, judgeSessionDeps);

  // ---------- worker panes (lib/worker-wiring.ts) ----------
  registerWorkerSurface(pi, cells, {
    runTmux: (argv) => runTmux(argv),
    tmuxScope,
    channelIO,
    paneOwnerIdentity,
    freshProjectConfig,
    log,
  });

  // ---------- the judge-only surface: judge_conclude + model self-heal ----------
  registerJudgeSide(pi, cells, judgeSelf, { channelIO, freshProjectConfig, childBinding, log });
  registerJudgeSpawnTools(pi, buildJudgeSpawnDeps(cells, judgeToolsWiring));

  // ---------- the internal prepare steps (lib/review-prepare-wiring.ts) ----------
  const prepareWiring = {
    repos,
    loopGoalConfirmed,
    goalTextForReviewers,
    loopGoalPath: loopGoalPathIn,
    reviewTargets,
  };
  registerReviewPrepareTools(internalHost, buildReviewPrepareDeps(cells, prepareWiring));
  registerAdvisoryPrepareTools(internalHost, buildAdvisoryPrepareDeps(cells, prepareWiring));

  // ---------- run_precommit (internal; lib/precommit-tool.ts) ----------
  registerPrecommitTool(internalHost, cells, { resolveToolRepo, stateForRepo, persistRepo, repoLabel });

  // ---------- declare_done (lib/declare-done-tool.ts) ----------
  registerDeclareDoneTool(pi, cells, {
    enforcementStateFor,
    stateForRepo,
    persistRepo,
    persist,
    repoLabel,
    repoDirFor,
    copilotProblemsAcrossRepos: repos.copilotProblemsAcrossRepos,
    goalStageSatisfied: () => goalStageSatisfied(),
    deliveryStationFor,
    orchestrationDoneProblems,
    resetOrchestratorContinuations,
    registry,
    reapReviewScratch,
    armAcceptanceRound,
    runTmux: (argv) => runTmux(argv),
    tmuxScope,
    raiseBanner,
    releaseSessionName: () => sessionNaming.release(),
    proxyDecisions: () => dialogProxy.all(),
  });

  // ---------- the goal family, the restatement, the stage switches ----------
  registerGoalTools(pi, {
    ...goalPrereviewDeps,
    runGoalAudit: (input) => runGoalAudit(input),
    showToUser: (uiCtx, lead, body) => showToUser(uiCtx as ExtensionContext, lead, body),
    askChoice: (uiCtx, spec, opts) => askChoice(uiCtx as { ui?: ChoiceUi }, spec, opts),
    askEitherSide: (request, hasUI, render) => askEitherSide(request, hasUI, render),
    loopGoalPath: (root) => loopGoalPathIn(root),
    loopGoalRelPath: loopGoalRelPath(SESSION_STATE_VARIANT),
    findProjectAgent: (dir, name) => findProjectAgentText(dir, name),
    // HOW FAR THIS SESSION MAY SHIP (2026-09-15): read from the environment the
    // DISPATCHER wrote, never from anything this session's prompt could say.
    stationCap: stationCapFromEnv,
    writeGoalFile: (path, text) => {
      // A session another one holds this worktree against must not overwrite
      // `.pi/loop-goal.md` (reviewer P1, 2026-09-05).
      if (cells.state.exclusivityRefusal) throw new Error(cells.state.exclusivityRefusal);
      mkdirSync(pathDirname(path), { recursive: true });
      writeFileSync(path, text, "utf8");
    },
  });
  // `propose_restatement` shares the goal family's bindings deliberately: two
  // steps of one negotiation must agree on which repo they are about.
  registerRestatementTools(pi, {
    primaryRepoRoot: () => cells.primaryRepoRoot,
    cwd: () => cells.cwd,
    stateFor: (root) => stateForRepo(root),
    persist: (ctx, root) => persistRepo(ctx as unknown as ExtensionContext, root),
    log: (message) => log(message),
    showToUser: (uiCtx, lead, body) => showToUser(uiCtx as ExtensionContext, lead, body),
    askChoice: (uiCtx, spec, opts) => askChoice(uiCtx as { ui?: ChoiceUi }, spec, opts),
    askEitherSide: (request, hasUI, render) => askEitherSide(request, hasUI, render),
    // THE SAME CEILING the goal dialog reads (2026-09-15).
    stationCap: stationCapFromEnv,
  });
  // `choose_loop_stages` — the SAME deps back the tool_call fallback.
  registerLoopStageTools(pi, loopGoal.loopStageDeps);

  // ---------- L7: copilot_review (lib/copilot-review-tools.ts + lib/copilot-gh.ts) ----------
  registerCopilotReviewTools(pi, {
    resolveRepo: (requested) => resolveToolRepo(requested),
    stateFor: (root) => stateForRepo(root),
    persist: (ctx, root) => persistRepo(ctx as unknown as ExtensionContext, root),
    repoDir: (root) => repoDirFor(root),
    copilotEnabled: (st) => copilotEnabled(st),
    sessionMode: () => cells.state.taskMode,
    onWaiting: (active) => {
      cells.copilotWaitSince = active ? Date.now() : undefined;
      if (cells.latestCtx) reportChildState(cells.latestCtx, undefined, { force: true });
    },
    armLoop: () => { armLoop(cells); },
    log: (message) => log(message),
    gh: {
      resolveOpenPr: (dir, signal) => resolveOpenPr(dir, signal),
      resolveRepoSlug: (dir, pr, signal) => resolveRepoSlug(dir, pr, signal),
      fetchCopilotPayload: (dir, slug, prNumber, signal) => fetchCopilotPayload(dir, slug, prNumber, signal),
      fetchCopilotProbe: (dir, slug, prNumber, signal) => fetchCopilotProbe(dir, slug, prNumber, signal),
      fetchCopilotTimeline: (dir, slug, prNumber, signal) => fetchCopilotTimeline(dir, slug, prNumber, signal),
      requestCopilotReviewer: (dir, pr, slug, signal) => requestCopilotReviewer(dir, pr, slug, signal),
      // The allow-list is THIS extension's project config.
      resolveCopilotSupport: (dir, slug, supportConfirmed, opts) =>
        resolveCopilotSupport(dir, slug, supportConfirmed, cells.projectConfig.copilotReview.owners, opts),
    },
    // The ONE dialog the triage needs — the same shape (and, in an
    // orchestration, the same race) as every other gate question.
    askFinding: async (uiCtx, spec, opts) => {
      const ui = uiCtx as { hasUI?: boolean; ui?: ChoiceUi };
      const outcome = await askEitherSide(
        {
          dialogKind: "select",
          topic: "other",
          title: opts.body ? `${spec.title}\n${opts.body}` : spec.title,
          options: choiceRows(spec),
          payload: `推荐答案：${spec.recommended}`,
        },
        ui.hasUI === true,
        (signal) => askChoice(ui, spec, {
          ...(opts.body === undefined ? {} : { body: opts.body }),
          signal,
        }),
      );
      return outcome.answer;
    },
    showToUser: (uiCtx, lead, body) => showToUser(uiCtx as ExtensionContext, lead, body),
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  });

  // ---------- ask_user + the consent tools (lib/user-interaction-tools.ts) ----------
  // `state` is a GETTER on purpose — the state object is rebound at
  // session_start and /gate-reset.
  registerUserInteractionTools(pi, {
    state: () => cells.state,
    // THE GIT ROOT, NOT `cwd` (review round 5 P1).
    repoRoot: () => cells.primaryRepoRoot,
    persist: (ctx) => persist(ctx as unknown as ExtensionContext),
    setLoopArmed: (armed) => { cells.loopArmed = armed; },
    showToUser: (uiCtx, lead, body) => showToUser(uiCtx as Parameters<typeof showToUser>[0], lead, body),
    askChoice: (uiCtx, spec, opts) => askChoice(uiCtx as { ui?: ChoiceUi }, spec, opts),
    askMultiChoice: (uiCtx, spec, opts) => askMultiChoice(uiCtx as { ui?: ChoiceUi }, spec, opts),
    askEitherSide: (request, hasUI, render) => askEitherSide(request, hasUI, render),
    canChannelDialogs: () => childBinding() !== undefined,
    grantProxyScope: (scope, via) => {
      if (!cells.state.orchestrator) return; // not an orchestration — nothing to grant
      persistOrchestration(addGrant(cells.state.orchestrator, { scope, grantedAt: new Date().toISOString(), via }));
    },
    // The same doorway, closing (lib/ask-user-interview.ts `applyGrant`).
    revokeProxyScope: (scope) => {
      if (!cells.state.orchestrator) return; // not an orchestration — nothing to revoke
      persistOrchestration(removeGrant(cells.state.orchestrator, scope));
    },
    cwd: cells.cwd,
    sessionEditedPaths: () => [...cells.sessionEditedPaths],
    commitsAheadOfBase: async () => commitsAheadOfBase(cells.cwd),
    scopeLimitDeclined: () => cells.scopeLimitDeclined,
    declineScopeLimit: () => { cells.scopeLimitDeclined = true; },
    tmuxAccessDeclined: () => cells.tmuxAccessDeclined,
    declineTmuxAccess: () => { cells.tmuxAccessDeclined = true; },
    sensitiveGrants: () => cells.sensitiveGrants,
    storeSensitiveGrants: (next) => { cells.sensitiveGrants = next; },
    sensitiveDeclinedPaths: cells.sensitiveDeclinedPaths,
    log: (message) => log(message),
  });

  pi.on("input", createInputHook(cells, { persist }));

  // ---------- set_gate_mode + request_arbitration ----------
  registerGateModeTool(pi, cells, {
    setTaskMode,
    askChoice,
    reportChildState,
    isOrchestrationChild,
    loopGoalDirectiveText: loopGoal.loopGoalDirectiveText,
  });
  registerArbitrationTool(pi, cells, { arbitration, appealsUsed, spendArbitration, askChoice });

  // ---------- L2: ESC abort detection + auto-continuation ----------
  pi.on("agent_end", (event) => l2.onAgentEnd(event));
  pi.on("agent_settled", (_event, ctx) => l2.onAgentSettled(ctx));

  // ---------- lifecycle (lib/session-lifecycle.ts) ----------
  const lifecycle = createSessionLifecycle(cells, {
    pi,
    restore,
    persist,
    setTaskMode,
    ensureModelLayersRendered: (ctx) => ensureModelLayersRendered(ctx),
    ensureHierarchyLoaded,
    dropDeadForeignJudges,
    armUiRefreshTimer,
    disarmUiRefreshTimer,
    updateWidget,
    startChildHeartbeat,
    stopChildHeartbeat,
    reportChildState,
    applySessionExclusivity,
    releaseWorktree,
    stopExclusivityRecheck,
    runtime: () => ({ stopSupervisionTimer, stopRevivalTimer, startSessionNamingHeartbeat, stopSessionNamingHeartbeat }),
    cancelChildWaitTimer: () => l2.cancelChildWaitTimer(),
    notify: notifyRuntime,
    naming: sessionNaming,
    closeScopeOnExit,
    log,
  });
  pi.on("session_start", (_event, ctx) => lifecycle.onSessionStart(ctx));
  pi.on("session_shutdown", (event) => lifecycle.onSessionShutdown(event));
  pi.on("session_compact", () => lifecycle.onSessionCompact());
  const onTurnEnd = createTurnEndHook(cells, {
    noteChildProgress: () => noteChildProgress(),
    reportChildState: (ctx) => reportChildState(ctx),
    persist,
    persistRepo,
  });
  pi.on("turn_end", (_event, ctx) => onTurnEnd(ctx));

  // ---------- thinking-loop guard + background-agent waits ----------
  const registerThinkingDisplay = registerThinkingLoopGuard(pi, cells);
  wireBackgroundWaitSignals(pi, cells, childSide);
  registerThinkingDisplay();

  // ---------- commands (lib/gate-command-tools.ts) ----------
  // `state`, `projectConfig` and `primaryRepoRoot` are GETTERS on purpose —
  // all three are rebound while the session lives.
  registerGateCommands(pi, {
    state: () => cells.state,
    projectConfig: () => cells.projectConfig,
    primaryRepoRoot: () => cells.primaryRepoRoot,
    cwd: cells.cwd,
    // The doctor reads the assets THIS package ships; computed here so it
    // cannot silently change meaning when a module moves between directories.
    packageRoot: pathJoin(pathDirname(fileURLToPath(import.meta.url)), ".."),
    persist: (ctx) => persist(ctx as unknown as ExtensionContext),
    callTool: (name, params, ctx) => callTool(name, params, ctx),
    toolText: (result) => toolText(result),
    otherRepoStatus: () => otherRepoStatus(),
    loopGoalConfirmed: () => loopGoalConfirmed(),
    loopGoalPresent: () => readSessionLoopGoal(cells.primaryRepoRoot).present,
    contract: () => contractReadout(),
    hasProxyGrant: (scope) => hasGrant(cells.state.orchestrator ?? emptyRuntime("none"), scope),
    grantProxyScope: (scope, via) => {
      if (!cells.state.orchestrator) return;
      persistOrchestration(addGrant(cells.state.orchestrator, { scope, grantedAt: new Date().toISOString(), via }));
    },
    askChoice: (uiCtx, spec, opts) => askChoice(uiCtx as { ui?: ChoiceUi }, spec, opts),
    setLoopArmed: (armed) => { cells.loopArmed = armed; },
    setTaskMode: (mode, source, ctx) => setTaskMode(mode, source, ctx as ExtensionContext),
    // Only a USER action may lift the lock (/gate-mode, /gate-reset).
    unlockAgentDowngrades: () => { cells.agentDowngradesLocked = false; },
    resetSession: resetSessionState,
    findProjectAgentText: (dir, name) => findProjectAgentText(dir, name),
  });

  // ---------- per-turn protocol reminder (lib/turn-directive.ts) ----------
  const { onBeforeAgentStart } = createTurnDirective(cells, {
    handoffReminderBlock: handoff.handoffReminderBlock,
    orchestrationDoneProblems,
    loopStagesRecord: () => loopGoal.loopStagesRecord(),
    stageIsOn: (stage) => stageIsOn(stage),
    goalStageSatisfied: () => goalStageSatisfied(),
    loopGoalDirectiveText: loopGoal.loopGoalDirectiveText,
    isOrchestrationChild,
    reviewScopeFor,
    previousRoundFindings,
    settledConclusion,
    log,
  });
  pi.on("before_agent_start", (event) => onBeforeAgentStart(event));

  // The 5s widget refresh (lib/status-strip.ts) — armed once the whole
  // factory has run; session_shutdown disarms it, session_start re-arms it.
  armUiRefreshTimer();
}
