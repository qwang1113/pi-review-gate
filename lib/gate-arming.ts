/**
 * WHAT "THIS SESSION HAS CHANGES TO REVIEW" MEANS, in one place.
 *
 * THE MEASURED BUG (drill F1, 2026-09-19). Arming has TWO independent sources
 * — a dirty code/doc file in the worktree, and commits this branch has ahead
 * of its base — and they were written out twice: once where the gate ARMS
 * (`session_start`), once where it RECONCILES (`turn_end`). The second copy
 * only looked at the working tree's file kinds, so a single untracked file of
 * no code/doc kind (measured: the `node_modules` symlink a seeded worktree
 * carries) cleared `hasCodeChange` while EIGHT unreviewed commits sat ahead of
 * the base. `lib/ship-gate-bash.ts` then read "this session changed nothing"
 * and let `git commit`, `git push` and `gh pr create` straight through — a
 * fail-open in the one gate whose whole job is to fail closed.
 *
 * So the rule lives here, and both sites call it: arming is
 * `dirtyCodeOrDocFile || commitsAheadOfBase`, and a flag may be cleared only
 * when the SAME facts no longer justify it.
 *
 * WHAT THE CALLER OWNS. The two facts are read from git, which this module
 * does not touch: `files` arrives already filtered by the scope-limit
 * exemption (`GateState.scopeLimit.preexistingFiles`), and `commitsAhead` is
 * already 0 when a user-granted scope limit suspends branch-commit arming.
 * Both call sites apply those two rules identically today; keeping them at the
 * call site keeps this module a pure decision.
 *
 * NOT A FINGERPRINT AND NOT A VERDICT: this says whether there is anything for
 * the gate to be armed about, never whether it has been reviewed.
 */

import { isCodeFile, isDocFile } from "./constants.ts";

/** The facts arming is decided from — both of them, always. */
export interface ArmingFacts {
  /**
   * Dirty paths in the worktree, ALREADY filtered by the scope-limit
   * exemption. Empty is ordinary (a clean tree, or one holding only files the
   * user exempted).
   */
  files: readonly string[];
  /**
   * Commits this branch has ahead of its base. 0 under a user-granted scope
   * limit, where a new commit is either the consented exempted work being
   * shipped or a user action — never this session's own unprotected work.
   */
  commitsAhead: number;
}

/** The two flags the gate arms on. */
export interface ArmingFlags {
  hasCodeChange: boolean;
  hasDocChange: boolean;
}

/**
 * What THESE facts justify right now.
 *
 * The two flags are not symmetric, and that asymmetry is deliberate: a branch
 * that is ahead of its base is code (there is something to review), while
 * "documentation only" can only be said of a file actually in the tree.
 */
export function armingFromFacts(facts: ArmingFacts): ArmingFlags {
  const hasBranchCommits = facts.commitsAhead > 0;
  return {
    hasCodeChange: facts.files.some(isCodeFile) || hasBranchCommits,
    hasDocChange: facts.files.some(isDocFile),
  };
}

/**
 * Clear-only reconciliation: keep exactly what the facts still justify.
 *
 * `changed` says whether the caller owes a persist — the same shape the four
 * arming sites already read. A flag the caller had is never SET here: arming
 * happens where work is done (an edit, a bash command, `session_start`), and a
 * reconciliation that could arm would be a second answer to the question this
 * module exists to answer once.
 *
 * AN EMPTY WORKTREE IS NOT EVIDENCE ABOUT KINDS (review round 1 P1). This is
 * where "clear what is no longer justified" is not the same function as
 * `armingFromFacts`, and the difference is measurable: the checkpoint commits a
 * documentation-only round, the worktree goes clean, and the branch is now
 * ahead. Reading the doc flag off an empty file list would clear BOTH flags and
 * hand that round's commits to a ship gate that sees "nothing changed" — the
 * exact fail-open this module exists to close, reached from the other side. An
 * empty list therefore clears only when the branch has nothing ahead either.
 */
export function reconcileArming(current: ArmingFlags, facts: ArmingFacts): ArmingFlags & { changed: boolean } {
  const hasBranchCommits = facts.commitsAhead > 0;
  const justified: ArmingFlags = facts.files.length === 0
    ? { hasCodeChange: hasBranchCommits, hasDocChange: hasBranchCommits }
    : {
        hasCodeChange: hasBranchCommits || facts.files.some(isCodeFile),
        hasDocChange: facts.files.some(isDocFile),
      };
  const hasCodeChange = current.hasCodeChange && justified.hasCodeChange;
  const hasDocChange = current.hasDocChange && justified.hasDocChange;
  return {
    hasCodeChange,
    hasDocChange,
    changed: hasCodeChange !== current.hasCodeChange || hasDocChange !== current.hasDocChange,
  };
}

/**
 * CAN THIS RECONCILIATION CLEAR ANYTHING? — asked before paying for the git
 * call that answers "is the branch ahead".
 *
 * A worktree whose dirty files still include a code file and a doc file has
 * nothing to reconcile (`turn_end` runs on every turn, and a `git rev-list`
 * spawn per turn is a cost the gate does not need to pay while the answer is
 * obviously "no").
 */
export function couldReconcile(current: ArmingFlags, files: readonly string[]): boolean {
  if (files.length === 0) return true;
  if (current.hasCodeChange && !files.some(isCodeFile)) return true;
  if (current.hasDocChange && !files.some(isDocFile)) return true;
  return false;
}
