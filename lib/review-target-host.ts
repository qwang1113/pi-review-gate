/**
 * THE ROUND'S REVIEW TARGET — what a reviewer round was dispatched against,
 * and whether its quality judge can still conclude, moved out of
 * `extensions/review-gate.ts` (t6, wave 2 of the split) beside the judge
 * registry it reads liveness from (lib/judge-registry-host.ts).
 */

import type { JudgeEntry } from "./hierarchy.ts";
import { isSkippedQualityRecord } from "./quality-round.ts";
import type { ScopeStampRecord } from "./gate-state-records.ts";
import type { SessionHost } from "./session-host.ts";

/**
 * Review targets registered by prepare_review (commit mode): repo root →
 * the reviewed baseline..HEAD plus HEAD's tree. The verdict recorder consumes it:
 * a READY binds to the reviewed tree, and a HEAD that moved past the
 * registered head (a new checkpoint after prepare) is STALE ⇒ BLOCKED.
 */
export interface ReviewTarget {
  baseline: string;
  head: string;
  tree: string;
  /** What this round was DISPATCHED to review (the audit pair's gate half). */
  scope?: ScopeStampRecord;
  /**
   * The files this round changed — carried so the QUALITY PRECONDITION can
   * be evaluated from the target alone (`lib/quality-round.ts`'s
   * `qualityStandingFor`), without a second `git diff` at dispatch time.
   * Absent for targets registered before this field existed: absent ⇒ the
   * guard treats the round as code-bearing (fail-closed).
   */
  files?: readonly string[];
  /**
   * THE QUALITY ROUND THIS TARGET DISPATCHED (2026-09-16).
   *
   * It is written the moment the quality judge of THIS round is dispatched,
   * and it is what makes "is the quality round still owed?" a per-ROUND fact
   * instead of a registry lookup. The quality pane is REUSED across rounds
   * and outlives its own verdict (it is only closed on `fresh`, on rotation
   * or when it dies), so "a quality judge exists and is alive" is true for
   * the rest of the session — a hold predicate built on it would park a
   * conclusion nothing would ever release.
   *
   * `head` is the round it belongs to: a target re-registered by the next
   * `prepare_review` replaces the whole object, so a stale record cannot
   * survive into a round it did not dispatch.
   */
  qualityRound?: { judgeId: string; head: string };
}

export function createReviewTargets(
  host: SessionHost,
  deps: {
    /** Own judges whose pane is not known to be gone (the registry's answer). */
    ownLiveJudges(): JudgeEntry[];
  },
) {
  const { ownLiveJudges } = deps;
  const reviewTargets = new Map<string, ReviewTarget>();

  /**
   * THE QUALITY JUDGE THIS ROUND DISPATCHED — recorded on the round's target.
   *
   * Called only after the dispatch was ACCEPTED (a refused spawn must not make
   * the round believe a quality verdict is coming).
   */
  function noteQualityRoundDispatched(root: string, judgeId: string): void {
    const target = reviewTargets.get(root);
    if (!target) return; // no target ⇒ nothing to bind the round to (fail-closed elsewhere)
    target.qualityRound = { judgeId, head: target.head };
  }

  /**
   * IS THIS ROUND'S QUALITY JUDGE STILL ABLE TO CONCLUDE? — the fact
   * `decideQualityHold` (lib/quality-round.ts) needs before it may HOLD a
   * functional verdict instead of refusing it.
   *
   * Three conditions, and each one is here for a measured reason:
   *  - the ROUND must have dispatched one (a live quality pane somewhere in
   *    the registry is not the same thing — the pane is reused across rounds
   *    and outlives its own verdict);
   *  - its pane must still be alive (`ownLiveJudges`: a persisted entry from a
   *    previous process has no pane, and a judge that died can never land a
   *    verdict — holding there parks the round forever);
   *  - NO verdict may already stand for this head: once one is recorded, the
   *    standing answers the question and this must not keep a hold alive. A
   *    SKIP record is NOT such a verdict (2026-09-22) — it is a permission the
   *    quality judge was never owed, so with the stage back ON the judge
   *    dispatched for this head is still the one that can conclude it.
   */
  function qualityRoundInFlight(root: string): boolean {
    const target = reviewTargets.get(root);
    const round = target?.qualityRound;
    if (!target || !round || round.head !== target.head) return false;
    // THE RECORD MUST BE A JUDGE'S ANSWER, NOT A SKIP (functional P1,
    // 2026-09-22): with the stage back ON a skip bound to this head does not
    // stand for it (`lib/quality-round.ts`'s `qualityStandingFor`), so reading
    // `commitSha` alone said "nobody is coming back" on a round whose quality
    // judge was running — the functional READY was refused and recorded
    // BLOCKED, and that BLOCKED ran the cancel matrix and killed the live
    // quality pane. `isSkippedQualityRecord` is the ONE reading of the brand
    // (a second `skipped` test here is how the two rules drift).
    const quality = host.stateFor(root).quality;
    if (quality?.commitSha === target.head && !isSkippedQualityRecord(quality)) return false;
    return ownLiveJudges().some((e) => e.judgeId === round.judgeId);
  }

  return { reviewTargets, noteQualityRoundDispatched, qualityRoundInFlight };
}
