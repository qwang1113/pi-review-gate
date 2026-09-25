/**
 * THE SESSION'S PERSISTENCE — the one funnel every gate-state write goes
 * through, the restore a session starts from, the mode decision and the
 * /gate-reset. Moved out of `extensions/review-gate.ts` (t8, 2026-09-26, wave 4).
 */

import { existsSync, statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { blockedMarkerPath, recordBlockedMarker, reconcileBlockedMarker } from "./blocked-marker.ts";
import { DEFAULT_MAX_ROUNDS } from "./constants.ts";
import { emptyState, type GateState } from "./gate-state.ts";
import { saveSidecarPreservingConcurrent } from "./gate-state-io.ts";
import { loadSidecar, migrateFingerprintVersion } from "./gate-state-load.ts";
import { inheritGoalContract } from "./gate-state-transitions.ts";
import { sessionSidecarPath } from "./loop-goal-host.ts";
import { successorRuntime } from "./orchestrator-registry.ts";
import { digestForMerge } from "./repo-facts.ts";
import { armLoop, clearBypassToken, resetLoopBudget, type SessionCells } from "./session-cells.ts";
import { gateStateWriteSkip } from "./session-exclusivity.ts";
import { isHandoffSuccessorOf } from "./session-inheritance.ts";
import { isEnforcedMode, normalizeTaskMode, type TaskMode, type TaskModeSource } from "./task-mode.ts";
import type { createChildSide } from "./child-side-host.ts";

/** Session-entry type for the persisted gate state. */
export const ENTRY_TYPE = "review-gate-state";
/**
 * Session-entry type for the audit record a judge leaves when it declines to
 * write the repo's gate state. Distinct from ENTRY_TYPE on purpose: it is not
 * gate state, it is the note saying none was written.
 */
const GATE_STATE_SKIP_ENTRY = "review-gate-persist-skipped";

export interface SessionPersistenceDeps {
  pi: Pick<ExtensionAPI, "appendEntry">;
  updateWidget(ctx: ExtensionContext): void;
  /** A handed-off orchestrator writes nothing: its successor owns the sidecar. */
  handedOff(): boolean;
  reportChildState: ReturnType<typeof createChildSide>["reportChildState"];
  resetOrchestratorContinuations(): void;
}

export function createSessionPersistence(cells: SessionCells, deps: SessionPersistenceDeps) {
  /** Said once per session — the skip is a standing fact, not an event. */
  let gateStateSkipAnnounced = false;

  /**
   * Is this session barred from writing gate state, and if so, RECORD it.
   *
   * The record deliberately lands nowhere near the repo: `pi.appendEntry`
   * writes into pi's own session store (`~/.pi/agent/sessions/…`) and the
   * notice goes to this pane. A log file under `.pi/judge-sessions/…` would
   * still be the judge writing into the repository it is reviewing, which is
   * the very thing being fixed.
   */
  function noteGateStatePersistSkip(ctx?: ExtensionContext): boolean {
    const skip = gateStateWriteSkip(process.env);
    if (!skip) return false;
    if (!gateStateSkipAnnounced) {
      gateStateSkipAnnounced = true;
      try { deps.pi.appendEntry(GATE_STATE_SKIP_ENTRY, { ...skip, at: new Date().toISOString() }); }
      catch { /* older Pi without appendEntry — the notice below still tells someone */ }
      try { ctx?.ui.notify(skip.reason, "info"); } catch { /* headless */ }
    }
    return true;
  }

  // `ctx` is optional because it is used for ONE thing — refreshing the status
  // widget. A caller that has no context (the orchestration tools persist from
  // a callback) must still be able to write the record: dropping the write
  // instead would lose the user's plan approval on a restart.
  function persist(ctx?: ExtensionContext) {
    // A judge and a worker write NO gate state (lib/session-exclusivity.ts
    // explains why — it is the same question as the exclusivity guard). Checked
    // here, at the single funnel every gate-state write goes through, rather
    // than at each call site — a new caller must not be able to reintroduce it.
    if (noteGateStatePersistSkip(ctx)) return;
    const state = cells.state;
    // Nor does a session another one holds this worktree against: that sidecar
    // is the HOLDER's — its mode, its verdicts, its unmet list — and the whole
    // point of refusing is that these two must not overwrite each other. (The
    // refusal itself is memory-only; saveSidecar strips it as well.)
    if (state.exclusivityRefusal) return;
    // Nor does a RETIRED orchestrator: it handed the orchestration to a
    // successor, and the successor now owns this sidecar. The successor is
    // admitted into this SAME worktree on purpose (one orchestration id, no
    // child restarted), which is exactly the "two sessions, one sidecar"
    // situation the exclusivity guard exists to prevent — so the predecessor
    // is the one that has to stop writing. Without this, a wake-up that
    // slipped past the retirement guards would rewrite the plan and child
    // registry the successor is working from.
    if (deps.handedOff()) return;
    // P-multi: persist the session's repo set so a same-session resume (or
    // restart) re-arms declare_done against every repo this session edited.
    state.sessionReposPaths = [...cells.sessionRepos].filter((r) => r !== cells.primaryRepoRoot);
    const cwd = cells.cwd;
    try {
      saveSidecarPreservingConcurrent(sessionSidecarPath(cwd), state, () => digestForMerge(cwd));
      // Our own earlier write failure (if any) is resolved: reclaim OUR owner
      // entry — and any owner whose session has been silent past the
      // concurrent-session window — but never a live foreign one.
      reconcileBlockedMarker(blockedMarkerPath(sessionSidecarPath(cwd)), { sessionId: state.sessionId });
    } catch {
      recordBlockedMarker(blockedMarkerPath(sessionSidecarPath(cwd)), { sessionId: state.sessionId });
    }
    try {
      // Store continuation count alongside state so it survives restarts.
      deps.pi.appendEntry(ENTRY_TYPE, { state, continuationsInjected: cells.continuationsInjected });
    } catch { /* older Pi without appendEntry */ }
    if (ctx) deps.updateWidget(ctx);
  }

  function restore(ctx: ExtensionContext, sessionId: string | null) {
    const cwd = cells.cwd;
    let restored: GateState | undefined;
    let restoredInjections = 0;
    try {
      const entries = ctx.sessionManager.getEntries() as Array<{
        customType?: string; data?: { state?: GateState; continuationsInjected?: number };
      }>;
      // Newest entry wins; scan backward and stop at the first match so a
      // long session (persist appends one entry per state change) doesn't
      // deserialize every historical snapshot.
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if ((e.customType) === ENTRY_TYPE && e.data?.state?.schema === 1) {
          restored = e.data.state;
          if (typeof e.data.continuationsInjected === "number") restoredInjections = e.data.continuationsInjected;
          break;
        }
      }
    } catch { /* session manager unavailable */ }

    // Fall back to sidecar for cross-process state (L3 hooks read it).
    // loadSidecar() applies the fingerprint migration itself (so it can never
    // be forgotten), which means the result must be collected HERE — asking
    // migrateFingerprintVersion() again below would report "no migration",
    // and the user would watch READY become PENDING with no explanation.
    const sidecarMigration = { migrated: false };
    if (!restored) {
      restored = loadSidecar(sessionSidecarPath(cwd), sidecarMigration);
    }

    // Sidecar corruption detection: file exists but couldn't parse → fail-closed.
    const sidecarFile = sessionSidecarPath(cwd);
    let sidecarCorrupt = false;
    try {
      if (existsSync(sidecarFile) && statSync(sidecarFile).isFile() && !restored) {
        sidecarCorrupt = true;
      }
    } catch { /* best effort */ }

    if (restored?.taskMode !== undefined && normalizeTaskMode(restored.taskMode) === undefined) {
      delete restored.taskMode;
    }

    if (restored && restored.sessionId === sessionId) {
      cells.state = restored;
      cells.continuationsInjected = restoredInjections;
      // The orchestration runtime that came with it keeps its OWN
      // `ownerSessionId` — that field, not this branch, is what answers "may
      // this session resume it" (see `currentOrchestrationId`).
    } else if (restored && restored.sessionId !== sessionId) {
      cells.state = emptyState(sessionId, restored.maxRounds ?? DEFAULT_MAX_ROUNDS);
      // THE ORCHESTRATION RUNTIME SURVIVES THE RESET (2026-09-06, B1).
      //
      // Everything else here describes THIS session's round — its verdict,
      // its precommit, its edits — and a new session owns none of it. The
      // orchestration runtime is the one field that describes something
      // OUTSIDE the session: which orchestration this repo runs, and which
      // child sessions are registered under it. Those children are panes that
      // are still alive; they did not stop existing because their supervisor's
      // process did. Dropping it cost the same bug twice — a RELAY successor
      // (a plain `pi`, hence a fresh session id) lost the predecessor's whole
      // registry, and a TAKEOVER had nothing left to take over.
      //
      // The APPROVAL does not survive — UNLESS this process is the
      // predecessor's own handoff successor, and THAT asymmetry is the point.
      // The registry is a fact about the world; the approval is permission the
      // user gave to a session that is gone, so an ordinary new session (and a
      // takeover through `orchestrator_attach`, which carries no handoff
      // marker either) re-obtains it — one dialog, and no session nobody
      // approved can spawn children. A RELAY SUCCESSOR is the one case where
      // the same permission was given to the same WORK, minutes ago, in this
      // same worktree: re-obtaining it there costs the restatement dialog, the
      // plan re-audit and the plan approval dialog for a requirement not one
      // word of which changed. WHICH sessions those are is one answer:
      // `isHandoffSuccessorOf` checks the handoff marker against the session id
      // the sidecar itself records. WHICH fields carry that permission is
      // lib/orchestrator-registry.ts's to know, not this call site's.
      const relaySuccessor = isHandoffSuccessorOf(process.env, restored.sessionId);
      if (restored.orchestrator) {
        cells.state.orchestrator = successorRuntime(restored.orchestrator, relaySuccessor);
      }
      // …and the successor's own contracts travel the same way: what the user
      // confirmed the requirement is, the goal they approved, and the round
      // budget a handover must not reset. The rule (and what deliberately does
      // NOT carry) is lib/gate-state.ts's.
      if (relaySuccessor) cells.state = inheritGoalContract(cells.state, restored);
    } else if (sidecarCorrupt) {
      cells.state = emptyState(sessionId, DEFAULT_MAX_ROUNDS);
      cells.state.hasCodeChange = true;
      cells.state.hasDocChange = true;
    } else {
      cells.state = emptyState(sessionId, DEFAULT_MAX_ROUNDS);
    }

    // A binding produced by a DIFFERENT fingerprint algorithm cannot be
    // verified by this one, so it is invalidated here rather than trusted.
    // Recorded for session_start to surface — without an explanation the user
    // just sees a READY silently become PENDING after an upgrade.
    // Either source can carry a stale binding: the session entry is migrated
    // by this call, the sidecar was already migrated inside loadSidecar().
    cells.fingerprintMigrated = migrateFingerprintVersion(cells.state) || sidecarMigration.migrated;

    // (A "another session wrote this sidecar recently" WARNING used to be
    // built here. It is gone: `applySessionExclusivity` decides the same
    // question from a heartbeat and either refuses or takes the claim.)
  }

  // SECURITY: source is persisted so the git pre-commit hook can distinguish a
  // user-chosen explore/normal (advisory hook) from an agent selection
  // (hook stays fully enforced). The in-session mode decision is made via the
  // set_gate_mode tool (or the user via /gate-mode): the agent classifies the
  // FIRST decision itself, bounded by lib/task-mode.ts — it can pick loop or
  // (while clean) explore without a dialog, but never normal; later changes go
  // through the same consent rules.
  function setTaskMode(mode: TaskMode, source: TaskModeSource, ctx: ExtensionContext) {
    const state = cells.state;
    state.taskMode = mode;
    state.taskModeSource = source;
    // A fresh mode decision supersedes a standing question pause: an ENFORCED
    // mode re-arms (explore/normal turn auto-continuation off by definition).
    delete state.pausedQuestion;
    // isEnforcedMode, not `=== "loop"`: an orchestrator session is the one
    // that needs the survival invariant MOST — it supervises children through
    // the night — and it is also the one that can never re-arm the old way,
    // because constraint 2 forbids it from editing code and its plan writes
    // go through a tool, not the edit path. Disarming it here made
    // agent_settled and the child watchdog return early, so the session could
    // end its turn with children still running and gates unmet.
    cells.loopArmed = isEnforcedMode(mode);
    resetLoopBudget(cells);
    deps.resetOrchestratorContinuations(); // goal 6 — reset with the loop budget
    persist(ctx);
    // MODE-CHANGE NOTIFICATION (user requirement 2026-08-30): every mode
    // transition — via set_gate_mode tool OR /gate-mode command — is
    // reported to the supervising orchestrator as a forced state update, so
    // a child that downgraded to explore/normal (or became an orchestrator)
    // is never silently invisible to the project manager waiting on it.
    // Without this, an orchestrator could wait forever on a child that
    // stopped heartbeating after a mode switch (deadlock).
    deps.reportChildState(ctx, `gate mode → ${mode}`, { force: true, state: "mode-changed" });
  }

  /**
   * Everything /gate-reset clears — every binding it touches is a session
   * cell: the state object, its loop counters and locks, the never-persisted
   * sensitive-file grants, the bypass token and the appeal ledger. The command
   * module owns the ordering around it (reset → persist → notify).
   */
  function resetSessionState(): void {
    // THE USER'S STAGE SWITCHES SURVIVE THE RESET (2026-09-22, lib/loop-stages.ts):
    // they are the user's own configuration of the gates, not a verdict or a
    // lock — clearing them would silently turn gates back ON behind the choice
    // the box recorded. `/gate-status` names them, and `choose_loop_stages`
    // re-opens the box when the user wants them changed.
    const stages = cells.state.stages;
    cells.state = emptyState(cells.state.sessionId, cells.state.maxRounds);
    if (stages) cells.state.stages = stages;
    armLoop(cells);
    resetLoopBudget(cells);
    deps.resetOrchestratorContinuations(); // goal 6 — reset with the loop budget
    cells.agentDowngradesLocked = false;
    cells.lastRunAborted = false;
    cells.scopeLimitDeclined = false;
    cells.sessionEditedPaths.clear();
    // The user's call: revoke outstanding one-shot sensitive-file
    // authorizations AND lift the per-path decline locks.
    cells.sensitiveGrants = [];
    cells.sensitiveDeclinedPaths.clear();
    clearBypassToken(cells);
    cells.lastBlockedShip = null;
    cells.lastBlockedText = null;
    // The judge-side class clears with the other two, pass included: a live
    // pass would otherwise authorize a zero-inspection READY after the reset.
    cells.lastBlockedInspection = null;
    cells.inspectionPass = undefined;
    // A user-initiated reset clears the appeal ledger too: quota, decided
    // contents and any live pass. It is the user's own call, and leaving a
    // pass behind would let it authorize content after the reset.
    delete cells.state.appeals;
    cells.arbitrationDecisions.clear();
  }

  return { noteGateStatePersistSkip, persist, restore, setTaskMode, resetSessionState };
}

export type SessionPersistence = ReturnType<typeof createSessionPersistence>;
