/**
 * THE SESSION'S MUTABLE CELLS — every binding `extensions/review-gate.ts` used
 * to hold as a closure `let`, gathered into ONE object (t8, 2026-09-26, wave 4 of the split).
 *
 * WHY ONE OBJECT AND NOT A `Ref` PER VARIABLE. The modules carved out in this
 * wave (the tool bodies, the lifecycle handlers, the L2 continuation) each read
 * and write a dozen of these bindings, and many of them the SAME dozen: the loop
 * budget, the abort flag, the arbitration records. A `Ref` per variable would
 * have made every deps object list the same cells again, which is a second way
 * for two modules to disagree about which cell they share. Here there is one
 * object, created once per extension instance, and every module holds the same
 * reference — a write in one is the value the next reader sees, exactly as the
 * closure `let` behaved.
 *
 * WHAT IS NOT HERE: state a single module owns alone (its memo, its once-flag)
 * stays private to that module; `SessionHost` (lib/session-host.ts) stays the
 * narrower seam the earlier waves' modules read through.
 *
 * The `session-host.ts` rule still holds for the reassigned fields: read them
 * through the object on every use (`cells.state`, never a captured copy).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BypassToken } from "./arbitration.ts";
import { emptyState, type GateState } from "./gate-state.ts";
import type { InspectionBlock, InspectionPass } from "./inspection-appeal.ts";
import { emptyInspection, type InspectionEvidence } from "./judge-inspection.ts";
import type { StallState } from "./loop-stall.ts";
import { defaultProjectConfig, type ProjectConfig } from "./project-config.ts";
import type { ReadonlyStallState } from "./readonly-stall.ts";
import { gitRootOfDir } from "./repo-resolve.ts";
import type { SensitiveGrant } from "./sensitive-grant.ts";
import type { Ref } from "./session-host.ts";
import type { BlockedShipRecord } from "./ship-gate-hook.ts";
import type { AppealableBlock } from "./text-appeal.ts";
import { DEFAULT_MAX_ROUNDS } from "./constants.ts";

export interface SessionCells {
  // ---- where the session works (session_start re-derives all four) ----
  state: GateState;
  cwd: string;
  /** Does the session cwd sit inside a git repository? */
  sessionInGit: boolean;
  primaryRepoRoot: string;
  /** The repo the agent most recently edited (verdict / precommit target). */
  readonly activeRepoRoot: Ref<string>;
  /** Every repo this session has edited; declare_done requires ALL of them. */
  readonly sessionRepos: Set<string>;
  /** Non-primary repo states, loaded lazily (the primary IS `state`). */
  readonly repoStateCache: Map<string, GateState>;
  projectConfig: ProjectConfig;
  /** The most recent context — tool_call refreshes it before every tool body. */
  latestCtx: ExtensionContext | undefined;
  /** The last UI context a widget render reached (the refresh timer's target). */
  readonly lastUiCtx: Ref<ExtensionContext | undefined>;
  /** When the gate last got an answer out of the user (the stall breaker's fact). */
  readonly lastUserInteractionAt: Ref<string | undefined>;
  /** Wall clock of the last gate event — the review round's duration bound. */
  readonly lastGateEventAt: Ref<number>;

  // ---- the L2 loop ----
  /** /gate-bypass or NEEDS_HUMAN disarms auto-continuation. */
  loopArmed: boolean;
  /** The human picked "Pause gate and wait" in an arbitration dialog. */
  arbitrationPaused: boolean;
  /** Total auto-continuation injections (persisted with the state). */
  continuationsInjected: number;
  /** L7/L8 continuations spent on completion-only work (their own budget). */
  completionContinuations: number;
  /** The stall breaker's memory — in memory by design. */
  loopStall: StallState | undefined;
  stallNoticeShown: boolean;
  /** ISO of the previous stall observation — what `stallInMotion` compares against. */
  lastStallObservedAt: string | undefined;
  /** Hosted judge-child wait notices are throttled, not budgeted. */
  lastChildNoticeAt: number;
  /** The referenced hosted-wait watchdog (never unref'd). */
  childWaitTimer: ReturnType<typeof setTimeout> | undefined;
  /** The run's last assistant message ended "aborted" (ESC = pause). */
  lastRunAborted: boolean;

  // ---- this session's own edits ----
  /** Has THIS session edited anything? (pre-existing changes do not count) */
  sessionEdited: boolean;
  /** Repo-relative paths THIS session edited (successful edit results only). */
  readonly sessionEditedPaths: Set<string>;
  /**
   * Edit-discipline nudge window (prompt-only, never blocking): set when an
   * edit/write tool call FAILS; cleared ONLY on a successful edit or after one
   * nudge has been issued (2026-09-08 — it used to close at turn start / on
   * new user input, which let a persistently broken edit tool cross turns and
   * fall into bash file edits with no reminder).
   */
  editFailurePending: boolean;
  readonlyStallState: ReadonlyStallState | undefined;
  /** The goal-negotiation reminder on read-only tools, throttled. */
  lastGoalReminderAt: number;
  goalReminderCount: number;

  // ---- consent locks (in memory only) ----
  agentDowngradesLocked: boolean;
  scopeLimitDeclined: boolean;
  tmuxAccessDeclined: boolean;
  /** Live one-shot sensitive-file grants — never outlive the process. */
  sensitiveGrants: SensitiveGrant[];
  readonly sensitiveDeclinedPaths: Set<string>;

  // ---- arbitration (in memory only) ----
  bypassToken: BypassToken | null;
  lastBlockedShip: BlockedShipRecord | null;
  lastBlockedText: (AppealableBlock & { at: number }) | null;
  lastBlockedInspection: InspectionBlock | null;
  inspectionPass: InspectionPass | undefined;
  /** Re-roll prevention: decisions cached by (commandDigest#round#body). */
  readonly arbitrationDecisions: Map<string, "GATE_WINS" | "AGENT_WINS" | "HUMAN">;

  // ---- this process as a judge pane ----
  judgeInspection: InspectionEvidence;
  judgeReviewRange: string | undefined;
  judgeScopeKind: "full" | "incremental" | undefined;
  /** The round number the TASK carried (authoritative over the opener's table). */
  judgeTaskRound: number | undefined;

  // ---- misc ----
  /** restore() dropped bindings written by an older fingerprint algorithm. */
  fingerprintMigrated: boolean;
  /** When the current `copilot_review` call started blocking, if it is. */
  copilotWaitSince: number | undefined;
  /** Open question ids already announced (a restart re-announces — desired). */
  readonly announcedRequestIds: Set<string>;
  /** Judges whose DEATH has already been announced. */
  readonly announcedTerminated: Set<string>;
  /** Hints (never refusals) already delivered — said once each. */
  readonly deliveredHints: Set<string>;
  /** Hints earned by the tool call in flight — appended to ITS result. */
  readonly pendingHints: string[];
}

/** The cells as a fresh extension instance starts them. */
export function createSessionCells(cwd: string = process.cwd()): SessionCells {
  const root = gitRootOfDir(cwd);
  const primaryRepoRoot = root ?? cwd;
  return {
    state: emptyState(null, DEFAULT_MAX_ROUNDS),
    cwd,
    sessionInGit: root !== null,
    primaryRepoRoot,
    activeRepoRoot: { current: primaryRepoRoot },
    sessionRepos: new Set<string>([primaryRepoRoot]),
    repoStateCache: new Map<string, GateState>(),
    projectConfig: defaultProjectConfig(),
    latestCtx: undefined,
    lastUiCtx: { current: undefined },
    lastUserInteractionAt: { current: undefined },
    lastGateEventAt: { current: Date.now() },
    loopArmed: true,
    arbitrationPaused: false,
    continuationsInjected: 0,
    completionContinuations: 0,
    loopStall: undefined,
    stallNoticeShown: false,
    lastStallObservedAt: undefined,
    lastChildNoticeAt: 0,
    childWaitTimer: undefined,
    lastRunAborted: false,
    sessionEdited: false,
    sessionEditedPaths: new Set<string>(),
    editFailurePending: false,
    readonlyStallState: undefined,
    lastGoalReminderAt: 0,
    goalReminderCount: 0,
    agentDowngradesLocked: false,
    scopeLimitDeclined: false,
    tmuxAccessDeclined: false,
    sensitiveGrants: [],
    sensitiveDeclinedPaths: new Set<string>(),
    bypassToken: null,
    lastBlockedShip: null,
    lastBlockedText: null,
    lastBlockedInspection: null,
    inspectionPass: undefined,
    arbitrationDecisions: new Map(),
    judgeInspection: emptyInspection(),
    judgeReviewRange: undefined,
    judgeScopeKind: undefined,
    judgeTaskRound: undefined,
    fingerprintMigrated: false,
    copilotWaitSince: undefined,
    announcedRequestIds: new Set<string>(),
    announcedTerminated: new Set<string>(),
    deliveredHints: new Set<string>(),
    pendingHints: [],
  };
}

/**
 * Re-arm the loop AND clear the arbitration pause together: working again
 * means the human stop no longer applies (2026-08-30, P1).
 */
export function armLoop(cells: SessionCells): void {
  cells.loopArmed = true;
  cells.arbitrationPaused = false;
}

/**
 * Clear any standing bypass token — called whenever the worktree or review
 * round changes, so a token can never outlive the exact state it was for.
 */
export function clearBypassToken(cells: SessionCells): void {
  cells.bypassToken = null;
}

/**
 * The loop budget resets together, at every place that starts a fresh loop
 * (a mode decision, a completed task, /gate-reset). The orchestrator's own
 * continuation budget is the caller's to reset beside it.
 */
export function resetLoopBudget(cells: SessionCells): void {
  cells.continuationsInjected = 0;
  cells.completionContinuations = 0;
  cells.loopStall = undefined; // a fresh loop is a change of circumstances
  cells.stallNoticeShown = false;
}
