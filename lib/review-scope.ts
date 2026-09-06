/**
 * Incremental review scoping — THE DECISION HALF.
 *
 * PROBLEM. Every edit invalidates the READY binding, so the next round asks
 * for a brand-new review — including the round where the only change was a
 * typo fix in a comment. The reviewer then re-reads the entire diff at max
 * thinking to re-derive a verdict it already gave, which is the single most
 * expensive step of a loop round.
 *
 * WHAT THIS DOES. The gate remembers the tree the last READY review was bound
 * to. When a new round starts this module computes the INCREMENT since then
 * and decides whether the round may run incrementally at all. It produces a
 * DECISION, never prose: the contract handed to the reviewer — what was
 * already settled, what is new, which findings must be re-checked, and what a
 * consistency scan is — is rendered by `lib/review-carryover.ts`, the single
 * authoritative source for that wording.
 *
 * WHY THERE IS AN ESCALATION THRESHOLD. Incremental reading is only safe while
 * the increment is small enough that cross-file inconsistencies cannot hide in
 * it. Past that — or when the increment touches files the previous review
 * never looked at — the saving is not worth the blind spot, so the scope
 * escalates back to a full deep review. Both limits are deliberately low: this
 * is an optimization, and an optimization that has to be right must give up
 * early.
 *
 * TWO KINDS OF PRECONDITION, AND THE SECOND IS NOT ABOUT THE CODE. Everything
 * above is about the INCREMENT — how big it is, whose files it lands in. There
 * is also a precondition about the READER: an incremental round tells whoever
 * takes it to stop re-deriving what the last round settled, which only means
 * anything if that judge derived it. Since the gate rotates a judge's
 * transcript by itself (lib/judge-rotation.ts — context, round cap, a changed
 * contract), the reviewer of this round routinely is NOT the one that settled
 * the last, and this module refuses to grant incremental to a reader that
 * would have to take the settled conclusion on trust. That fact is decided
 * where transcript continuity lives, never re-derived here.
 *
 * FAIL-SAFE. Any missing input (no previous READY tree, unreadable git, an
 * unparseable diffstat) yields `full`. Incremental is never the default and is
 * never inferred — it is granted only when every precondition is present.
 */

/** Files in the increment beyond which the round is deep-reviewed in full. */
export const INCREMENT_MAX_FILES = 20;

/** Changed lines (added + deleted) beyond which the round escalates to full. */
export const INCREMENT_MAX_LINES = 500;

export type ReviewScopeKind = "full" | "incremental";

export interface ReviewScopeDecision {
  scope: ReviewScopeKind;
  /** Files changed since the last READY tree (empty when unknown). */
  changedFiles: string[];
  /** Added + deleted lines since the last READY tree. */
  changedLines: number;
  /**
   * Files in the increment that the previous review never saw. Non-empty
   * forces `full`: "already reviewed" cannot be claimed for them.
   */
  unreviewedFiles: string[];
  /** Files the previous approved review covered (empty when unknown). */
  reviewedFiles: string[];
  /** One human-readable sentence explaining the decision. */
  reason: string;
}


export interface IncrementInput {
  /** Tree OID the last READY review was bound to, if any. */
  baseTree?: string;
  /** Files + line counts between that tree and the current worktree. */
  changedFiles?: string[];
  changedLines?: number;
  /** Files the previous review's diff covered (its own scope). */
  previouslyReviewedFiles?: string[];
  /**
   * Does the judge that will take this round still hold the previous round's
   * REASONING? Decided by `judgeRemembersPreviousRound` (lib/judge-rotation.ts)
   * — the reuse policy owns transcript continuity, this module only consumes
   * its answer.
   *
   * ABSENT MEANS NO, like every other missing fact here: an incremental round
   * asks its reader to stop re-deriving what the last round settled, and a
   * reader that never derived it cannot honour that with anything but trust.
   */
  judgeRemembersPreviousRound?: boolean;
}


/**
 * Decide how much of this round the reviewer must deep-read.
 *
 * Pure so the escalation rules can be tested exhaustively — the gate calls it
 * with data it collected from git.
 */
export function decideReviewScope(input: IncrementInput): ReviewScopeDecision {
  const changedFiles = input.changedFiles ?? [];
  const changedLines = input.changedLines ?? 0;

  const reviewedFiles = input.previouslyReviewedFiles ?? [];

  const full = (reason: string): ReviewScopeDecision => {
    const seen = new Set(reviewedFiles);
    return {
      scope: "full",
      changedFiles,
      changedLines,
      unreviewedFiles: changedFiles.filter((f) => !seen.has(f)),
      reviewedFiles,
      reason,
    };
  };

  if (!input.baseTree) {
    return full("no previous READY review to build on — full deep review");
  }
  // THE READER-SIDE PRECONDITION, checked before any content rule: the rest
  // of this function asks whether the INCREMENT is small enough to stand on a
  // settled conclusion; this asks whether the reader can stand on one at all.
  // The gate rotates a judge's transcript on its own (context, round cap), so
  // "the reviewer of this round is not the one that settled the last" is a
  // routine event, not an edge case.
  if (input.judgeRemembersPreviousRound !== true) {
    return full(
      "the judge taking this round does not continue the transcript that settled the last one, " +
      "so it never derived that conclusion and cannot carry it forward — full deep review",
    );
  }

  if (!input.changedFiles) {
    return full("the increment could not be computed (git unreadable) — full deep review");
  }
  if (changedFiles.length === 0) {
    return full("nothing changed since the last READY review — re-review the whole change");
  }
  if (changedFiles.length > INCREMENT_MAX_FILES) {
    return full(
      `increment spans ${changedFiles.length} files (> ${INCREMENT_MAX_FILES}) — full deep review`,
    );
  }
  if (changedLines > INCREMENT_MAX_LINES) {
    return full(
      `increment changes ${changedLines} lines (> ${INCREMENT_MAX_LINES}) — full deep review`,
    );
  }

  // A file the previous review never covered has no "already reviewed" status
  // to inherit, so the increment cannot stand on its own.
  const seen = new Set(reviewedFiles);
  const unreviewedFiles = changedFiles.filter((f) => !seen.has(f));
  if (unreviewedFiles.length > 0) {
    return {
      scope: "full",
      changedFiles,
      changedLines,
      unreviewedFiles,
      reviewedFiles,
      reason:
        `increment touches ${unreviewedFiles.length} file(s) the previous review never covered ` +
        `(${unreviewedFiles.slice(0, 5).join(", ")}${unreviewedFiles.length > 5 ? ", …" : ""}) — full deep review`,
    };
  }

  return {
    scope: "incremental",
    changedFiles,
    changedLines,
    unreviewedFiles: [],
    reviewedFiles,
    reason:
      `increment is ${changedFiles.length} file(s) / ${changedLines} line(s) inside already-reviewed files ` +
      `— deep-read the increment, re-check last round's findings, scan the rest for consistency`,
  };
}

/*
 * NOTHING RENDERS TEXT HERE ANY MORE. The wording of the incremental
 * contract — what the previous round settled, which findings must be
 * re-checked, what a consistency scan is and is not — lives in ONE place,
 * `lib/review-carryover.ts`. This module decides; that one speaks.
 */

