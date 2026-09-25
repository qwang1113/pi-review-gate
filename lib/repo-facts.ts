/**
 * GIT FACTS the gate reads about a repository — moved out of
 * `extensions/review-gate.ts` (t5, wave 1). Every function here is a pure
 * read of the repository (or of a path) and closed over nothing, which is why
 * they could leave the extension's closure unchanged.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

import { computeFingerprint, worktreeTreeOid } from "./fingerprint.ts";
import { gitOrNull, gitRaw, gitText } from "./git-exec.ts";
import { rebaseBranchName } from "./git-rewrite.ts";
import { branchOfListedWorktree } from "./orchestrator-worktree.ts";
import type { GateState } from "./gate-state.ts";

/** Detect commits ahead of the upstream tracking branch or main/master. P0: also
    checks @{upstream} so local commits ahead of remote on any branch are caught.

    SYNC ON PURPOSE (review round 1 P1, drill F1 follow-up): the secondary-repo
    arming site (`stateForRepo`) is a synchronous state factory, and a branch
    ahead of its base arms the gate THERE as well — a repo whose only work is
    already committed must not read as "nothing to review" to the ship gate,
    which is exactly the fail-open F1 closed for the primary repo. The async
    dep seams wrap this ONE implementation. */
export function commitsAheadOfBase(cwd: string): number {
  // Priority: the upstream tracking branch (local ahead of remote on any
  // branch), then main/master (no upstream set), then origin/main|master
  // (on main, main..HEAD is 0 even when ahead of origin/main). A base that
  // does not resolve is skipped.
  for (const base of ["@{upstream}", "main", "master", "origin/main", "origin/master"]) {
    const n = parseInt(gitOrNull(cwd, ["rev-list", "--count", `${base}..HEAD`], { timeout: 5000 }) ?? "", 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return 0;
}

/**
 * Worktree digest for the concurrent-sidecar merge, or null when it cannot
 * be computed (fail-closed: an unverifiable foreign binding is dropped).
 *
 * Only reached when another session's sidecar holds a verdict this session
 * lacks, so the hashing cost stays off the normal persist path.
 */
export function digestForMerge(dir: string): string | null {
  const fp = computeFingerprint(dir);
  return fp.unavailable || !fp.digest ? null : fp.digest;
}

/** Do two paths name the same directory? Compared through realpath: a Pi
 *  launched via a symlinked path has a logical cwd that never string-matches
 *  git's physical repo root. Unresolvable paths fall back to string
 *  equality (this only ever decides whether a message says "ran in …"). */
export function samePlace(a: string, b: string): boolean {
  if (a === b) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}
/** Resolve a path through symlinks, or return it unchanged when it cannot be
 *  resolved (a path that does not exist is not an error here — the caller is
 *  comparing strings, not opening files).
 *
 *  Load-bearing for the snapshot pin on macOS: `snapshotBaseDir` falls back to
 *  the system temp dir, where `prepare_review` prints `/var/folders/…` while a
 *  reviewer's own `pwd` prints `/private/var/folders/…`. Comparing the raw
 *  strings would silently lose the reviewer's self-reported evidence and
 *  could withhold an honest READY. */
export function canonicalPath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * The branch this repo is working on.
 *
 * A rebase in progress is NOT a detached head in any meaningful sense: git
 * remembers the branch it will land back on, and every commit the rebase
 * makes belongs to that branch. Reading it is what keeps the branch rule
 * from blocking `git rebase -i` reword — the very operation an agent needs
 * to fix a non-English commit message (observed deadlock, 2026-08-29).
 * A genuine detached HEAD still reports undefined, and the rule still
 * refuses.
 */
export function currentBranch(root: string): string | undefined {
  // Failure = detached — maybe a rebase; ask git where it came from.
  return gitOrNull(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || rebaseBranch(root);
}

/**
 * WHICH BRANCH THIS REPOSITORY LISTS FOR ONE OF ITS OWN CHECKOUTS.
 *
 * ASKED OF THE REPOSITORY, NEVER OF THE CHECKOUT DIRECTORY (quality round
 * P1, 2026-09-18). `currentBranch(worktreePath)` is the obvious read and it is
 * a trap in the one place settlement uses a branch name: when that directory
 * is not a repository — a `git worktree add` that failed halfway, an emptied
 * shell left by a failed removal — git walks UP to the enclosing repository
 * and answers with ITS branch, and that answer then goes to
 * `git -C <repoRoot> branch -D`, which is destructive. `worktree list` is the
 * repository's own registry of the checkouts it owns: a path it does not list
 * yields nothing, so the caller falls through to the name this session
 * recorded or to the one it derived.
 */
export function listedWorktreeBranch(repoRoot: string, worktreePath: string): string | undefined {
  try {
    const out = gitRaw(repoRoot, ["worktree", "list", "--porcelain"], { timeout: 10_000 });
    // TWO SPELLINGS, ONE CHECKOUT. git records a worktree under the path it
    // was CREATED with, symlinks resolved — measured on this repository's own
    // list, where `/tmp/...` reads back as `/private/tmp/...`. The gate
    // derives the path from the repo root it was handed, so the two differ
    // whenever a repository lives behind a symlink; a miss would fall through
    // to the derived name, which is exactly the name a renamed child no
    // longer has. Both spellings are tried and neither is invented: a path
    // that cannot be resolved is simply not a match.
    const resolved = realpathOrUndefined(worktreePath);
    return branchOfListedWorktree(out, worktreePath)
      ?? (resolved === undefined ? undefined : branchOfListedWorktree(out, resolved));
  } catch { return undefined; }
}

/** `realpathSync`, or undefined when the path cannot be resolved (it may be gone). */
function realpathOrUndefined(target: string): string | undefined {
  try { return realpathSync(target); } catch { return undefined; }
}

/** The branch a rebase in progress will return to, read from the git dir. */
function rebaseBranch(root: string): string | undefined {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    try {
      const gitPath = gitText(root, ["rev-parse", "--git-path", `${dir}/head-name`]);
      if (!gitPath || !existsSync(pathResolve(root, gitPath))) continue;
      const name = rebaseBranchName(readFileSync(pathResolve(root, gitPath), "utf8"));
      if (name) return name;
    } catch { /* no rebase in progress, or an unreadable git dir */ }
  }
  return undefined;
}

/** HEAD commit tree OID — the content-boundary every ship binding compares against (round-8 P1). */
export function headCommitTree(root: string): string {
  return gitOrNull(root, ["rev-parse", "HEAD^{tree}"]) ?? "";
}

/**
 * The tree the NEXT commit would publish — the worktree tree, computed the
 * same way the ship bindings are (lib/fingerprint.ts). Empty when it cannot
 * be read, which every caller must treat as "unknown" rather than "equal".
 */
export function worktreeTree(root: string): string | undefined {
  try {
    return worktreeTreeOid(root) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Does the INDEX differ from HEAD? `git diff --cached --quiet HEAD` exits 1
 * when it does, so a throw means "staged content" — and so does any error,
 * which is the fail-closed reading: `undefined` (unknown) never authorizes
 * the message-only exemption.
 */
export function hasStagedChanges(root: string): boolean | undefined {
  try {
    gitText(root, ["diff", "--cached", "--quiet", "HEAD"]);
    return false;
  } catch (err) {
    // Exit 1 is the documented "there are differences" answer; anything else
    // (no HEAD, not a repo, git missing) is unknown, not "clean".
    return (err as { status?: number }).status === 1 ? true : undefined;
  }
}

/**
 * Round-9 P1: trees of the commits between the last READY's reviewed
 * commit and HEAD that DIFFER from the reviewed tree. Non-empty ⇒ content
 * no reviewer saw entered the branch since the READY (a checkpoint never
 * re-reviewed, a change-and-revert, or a rebase that moved the reviewed
 * point) — HEAD's tree matching is not enough. Returns undefined when there
 * is nothing to compare against (older sidecar). When the range cannot be
 * computed (the reviewed commit was squashed/rebase away), the HEAD-tree
 * match is the content proof and the check is skipped — a squash that
 * preserves the tree must keep the READY alive (goal criterion 4), and a
 * rebase that CHANGED content already fails the fingerprint match before
 * this check runs.
 */
export function unreviewedTreesSince(root: string, review: GateState["review"]): string[] | undefined {
  if (!review?.commitSha || !review.fingerprint) return undefined;
  try {
    const out = gitRaw(root, ["rev-list", "--format=%T", `${review.commitSha}..HEAD`]);
    return out
      .split("\n")
      .filter((l) => l && !l.startsWith("commit ") && l.trim() !== review.fingerprint)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return []; // reviewed commit gone (squash) — tree match is the proof
  }
}
