/**
 * Pure transitions on a `GateState`: what a handoff successor inherits, what an
 * edit invalidates, and the one rule that moves `precommit.lastFullPassTree`.
 *
 * Split out of lib/gate-state.ts.
 */

import type { GateState } from "./gate-state.ts";
import type { PrecommitMode } from "./gate-state-records.ts";
import type { TestScope } from "./precommit-receipt.ts";

/**
 * WHAT A HANDOFF SUCCESSOR CARRIES OVER from its predecessor's session state.
 *
 * A successor runs as a NEW session id, so the restore path starts it from
 * {@link emptyState}. Resetting almost all of that is right: a verdict, a
 * precommit, a fingerprint, a change flag and a bypass all describe ONE
 * round's work, and the successor has done none of it.
 *
 * Four fields describe the USER's contracts instead, and they are the ones a
 * handover must not throw away — re-asking for them re-asks a question whose
 * answer has not changed, which is how a project manager's handover cost the
 * user a restatement dialog, a plan re-audit and a plan approval dialog for a
 * requirement not one word of which was different:
 *
 *  - `restatement` — what the user confirmed the requirement IS (it already
 *    outlives the drafts that follow it; a handover is one more draft);
 *  - `loopGoal` — the goal text the user APPROVED;
 *  - `rounds` / `turnsWithoutGoal` — the ROUND BUDGET. Inherited on purpose,
 *    and not as a courtesy: a successor that restarts the count would let a
 *    handover wash away rounds already spent, and the budget exists precisely
 *    to end a session that is going in circles.
 *
 * `sessionReposPaths` travels too, and it is the same kind of fact seen from
 * the other side (reviewer P2, round 1): it is which OTHER repos this session
 * edited, and `declare_done` re-arms the gate against every one of them. A
 * handover that dropped it could retire work the predecessor left half-done
 * in a second repo — the one direction a succession must never move:
 * inheriting may only ever make completion harder, never easier.
 *
 * WHAT DOES NOT CARRY is the rest of {@link GateState}: `bypass`, the scope
 * limits, the verdicts, the fingerprints, the change flags and the session's
 * own task mode all describe THIS session's standing, and a successor starts
 * with none of them (the same asymmetry the concurrent-sidecar merge in this
 * module states from the other side).
 *
 * Two more omissions are deliberate rather than forgotten. `goalPrereview`
 * and `planAudit` are audits of ONE DRAFT — they answer "did a judge read
 * these exact words?" — so they live and die with the text they judged, and a
 * successor that has to negotiate anything new re-earns them for the new
 * draft. Nobody is asked to re-confirm an answer that has not changed, which
 * is what this function is for; re-running an AUDIT of a changed draft is
 * exactly what the audit is for.
 *
 * None of this widens a permission: every carried record is bound to the
 * CONTENT it names and re-verified by its reader (`isLoopGoalConfirmed`
 * against the goal file, `restatementConfirmed` over text+hash,
 * `approvedPlanHash` against the canonical plan), so a change to any of them
 * expires the inherited record exactly as fast as a fresh one.
 */
export function inheritGoalContract(target: GateState, predecessor: GateState): GateState {
  return {
    ...target,
    ...(predecessor.restatement ? { restatement: predecessor.restatement } : {}),
    ...(predecessor.loopGoal ? { loopGoal: predecessor.loopGoal } : {}),
    ...(predecessor.rounds.length > 0 ? { rounds: predecessor.rounds } : {}),
    // HOW MUCH REVIEW THIS WORK HAS HAD (2026-09-17, user decision): it is a
    // fact about the WORK, like the round budget above, not about the process
    // id that happened to hold the seat — a handover that dropped it would
    // roll the strip back to `轮 0` mid-task and say nothing was ever sent.
    ...(predecessor.sentReviewRounds !== undefined
      ? { sentReviewRounds: predecessor.sentReviewRounds }
      : {}),
    ...(predecessor.turnsWithoutGoal !== undefined
      ? { turnsWithoutGoal: predecessor.turnsWithoutGoal }
      : {}),
    ...(predecessor.sessionReposPaths && predecessor.sessionReposPaths.length > 0
      ? { sessionReposPaths: predecessor.sessionReposPaths }
      : {}),
    // THE STAGE SWITCHES FOLLOW THE WORK, not the process id (2026-09-22): the
    // successor continues the same task, so a stage the user released must stay
    // released — inheriting none would silently re-enable the gate the user
    // switched off, mid-task, with the once-per-session box already spent.
    ...(predecessor.stages ? { stages: predecessor.stages } : {}),
    // THE TMUX GRANT TRAVELS WITH THE SEAT (user decision, 2026-09-17: “当前
    // 会话和他的继承者都能用”). It is permission the USER gave to an on-going
    // piece of work rather than to a process id — a handover changes who holds
    // the seat, not what they were allowed to do. A ONE-SHOT grant is carried
    // as it is: still one use, now owed to the successor.
    ...(predecessor.tmuxAccess ? { tmuxAccess: predecessor.tmuxAccess } : {}),
  };
}

/**
 * Content-change invalidation — the ONE place a session's own edit downgrades
 * standing bindings. READY → PENDING and PASS → NOT_RUN, and the fingerprint
 * goes with the verdict: a downgraded binding must not keep pointing at the
 * content it no longer describes. (Measured residue: the edit path used to
 * flip the verdict but leave the fingerprint, leaving an impossible state
 * like `{verdict:"NOT_RUN", fingerprint:"…"}` in the sidecar — harmless to
 * enforcement, misleading to every reader, 2026-08-31.)
 */
export function invalidateBindings(st: GateState): void {
  if (st.review.verdict === "READY") {
    st.review.verdict = "PENDING";
    st.review.fingerprint = null;
  }
  if (st.precommit.verdict === "PASS") {
    st.precommit.verdict = "NOT_RUN";
    st.precommit.fingerprint = null;
  }
  // THE ACCEPTANCE RECORD follows the REVIEW's rule (2026-09-22): a
  // conclusion earned against a fingerprint that just moved is not a
  // conclusion about this content any more. Deleting it puts the round back
  // to ARMED, which costs a dispatch — the direction that cannot release a
  // changed round. The two terminal releases stay: SKIPPED is a statement
  // about the GOAL and DISABLED one about the GATE, and no later edit can
  // falsify either.
  if (st.acceptance && st.acceptance.status !== "SKIPPED" && st.acceptance.status !== "DISABLED") {
    delete st.acceptance;
  }
  // THE QUALITY STANDING IS DELIBERATELY NOT CLEARED HERE (2026-09-15).
  //
  // It looks like a binding on the worktree, and it is not: `commitSha` binds
  // it to a COMMIT, and an edit does not move HEAD. Keeping it is what lets the
  // hand-off work — the agent is told to keep editing while a judge runs, so an
  // edit arriving between the quality READY and the reviewer's dispatch (the
  // dispatch happens on the settle path, microseconds later) would otherwise
  // erase the pass that dispatch is gated on.
  //
  // What expires it is the CHECKPOINT: the next submission commits the new
  // worktree, HEAD moves, and `lib/quality-round.ts`'s `qualityStandingFor`
  // finds the standing bound to a different head and refuses. That is the
  // fail-closed direction — a stale pass can never unlock a reviewer.
  // NOT cleared here, deliberately: `precommit.lastFullPassTree` is not a
  // binding but a fact about a tree that DID pass — the edit that invalidates
  // the binding cannot un-pass it. See the field's own comment.
}

/**
 * The one rule that maintains `precommit.lastFullPassTree`.
 *
 * PURE and total, so the four cases are a table in a test rather than four
 * branches spread over a 9000-line file. `startedTree` is the tree captured
 * BEFORE the lane ran — the caller has it (it captures it for the async
 * report) and must not substitute the runner's post-run fingerprint, which is
 * recomputed after `lint:fix` may have edited files and can already describe
 * the NEXT round's content.
 *
 *  - a FULL lane PASSED on `startedTree` ⇒ record it;
 *  - a FAIL on the SAME tree ⇒ revoke (the content was disproven);
 *  - anything else (fast lane, a narrowed test scope, no tree, a FAIL of some
 *    other tree, ERROR) ⇒ the previous value stands.
 */
export function nextFullPassTree(args: {
  /** The value already on the state. */
  current: string | undefined;
  verdict: string;
  mode: PrecommitMode | undefined;
  testScope: TestScope | undefined;
  /** Tree captured before the lane started; "" when it could not be read. */
  startedTree: string;
}): string | undefined {
  if (!args.startedTree) return args.current;
  if (args.mode !== "full") return args.current;
  if (args.verdict === "PASS" && args.testScope === "full") return args.startedTree;
  if (args.verdict === "FAIL" && args.current === args.startedTree) return undefined;
  return args.current;
}
