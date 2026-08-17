/**
 * The two guards that decide whether a reviewer's READY may stand.
 *
 * WHY THIS IS ITS OWN PURE MODULE. Both guards used to live inline in
 * `record_review`, where the only thing a test could check was the SHAPE of the
 * source — and a mutation experiment proved that was not enough: neutralizing
 * the drift downgrade (`false && …`) left the whole suite green. A guard whose
 * removal no test notices is not a guard. Here the decision is a pure function
 * over four facts, so the truth table is pinned behaviourally and a mutant dies.
 *
 * Both guards are TIGHTEN-ONLY by construction: the only verdict this file can
 * produce out of thin air is `BLOCKED`. It never turns anything into READY, and
 * it never touches the ship gate.
 */

export interface VerdictGuardInput {
  /** Verdict parsed from the reviewer's output. */
  verdict: string;
  /**
   * Snapshot-integrity complaints for this round: a reviewer whose disposable
   * snapshot no longer holds the tree it was built from ran its final checks
   * against its own edits.
   */
  snapshotDrifts: readonly string[];
  /** Tree the round's reviewers actually read (absent ⇒ nothing to compare). */
  reviewedTree?: string;
  /**
   * Worktree tree at record time. `undefined` means it could not be computed —
   * which is NOT evidence that it matches.
   */
  currentTree?: string;
}

export interface VerdictGuardResult {
  /** The verdict after both guards. Never upgraded, only ever downgraded. */
  verdict: string;
  /** True when drift alone forced the downgrade. */
  driftBlocked: boolean;
  /** Set when the reviewed tree no longer matches the worktree. */
  staleTree?: string;
}

/**
 * Apply both guards to a parsed verdict.
 *
 * Guard 1 — SNAPSHOT DRIFT: a modified snapshot means the reviewer verified
 * against code it had changed itself, so its approval is not evidence. Its
 * findings stay valid (and a BLOCKED verdict is unaffected — BLOCKED ships
 * nothing), so the verdict is downgraded rather than rejected.
 *
 * Guard 2 — STALE TREE: the loop deliberately lets the main agent fix findings
 * WHILE a review runs, so by record time the worktree can differ from what the
 * reviewer read. Binding a READY to it would approve code no reviewer ever saw.
 * An unreadable current tree fails closed for the same reason.
 */
export function applyVerdictGuards(input: VerdictGuardInput): VerdictGuardResult {
  let verdict = input.verdict;
  const driftBlocked = input.snapshotDrifts.length > 0 && verdict === "READY";
  if (driftBlocked) verdict = "BLOCKED";

  let staleTree: string | undefined;
  // Only a surviving READY can be stale-blocked; anything else already fails
  // closed, and re-deriving the comparison would only produce noise.
  if (input.reviewedTree && verdict === "READY" && input.currentTree !== input.reviewedTree) {
    staleTree = input.currentTree
      ? `reviewed ${input.reviewedTree.slice(0, 12)}, worktree is now ${input.currentTree.slice(0, 12)}`
      : `reviewed ${input.reviewedTree.slice(0, 12)}, current tree unreadable`;
    verdict = "BLOCKED";
  }

  return { verdict, driftBlocked, ...(staleTree ? { staleTree } : {}) };
}

export type SnapshotPlanDecision =
  | { kind: "isolated" }
  | { kind: "none" }
  | { kind: "partial"; failedLabels: string[] };

/**
 * What to do when only SOME reviewers got a snapshot.
 *
 * A partially isolated round is the worst shape available: the shards that got
 * no snapshot would either be dropped (their files reviewed by nobody, while
 * the round still reports full coverage — a fail-open) or run in the live
 * worktree with a prompt that tells them they may edit freely. Refusing the
 * whole plan is the only honest option; the caller retries, or reviews without
 * isolation on purpose.
 *
 * Pure so the decision is TESTED. The inline version had zero coverage: setting
 * its condition to `false` left the entire suite green, which by this repo's own
 * standard means it was not a guard at all.
 */
export function decideSnapshotPlan(
  requestedLabels: readonly string[],
  snapshottedLabels: readonly string[],
): SnapshotPlanDecision {
  if (snapshottedLabels.length === 0) return { kind: "none" };
  const got = new Set(snapshottedLabels);
  const failedLabels = requestedLabels.filter((l) => !got.has(l));
  if (failedLabels.length > 0) return { kind: "partial", failedLabels };
  return { kind: "isolated" };
}
