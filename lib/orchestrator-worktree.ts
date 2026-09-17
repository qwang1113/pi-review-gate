/**
 * ONE CHECKOUT PER WRITER — the isolation that makes same-repo parallelism safe.
 *
 * THE RULE IT REPLACES (2026-09-07 → 2026-09-10). Two children editing one
 * checkout overwrite each other's work, so the answer used to be "never run
 * two at once": `scheduleNextTasks` serialized every task by repo key, and a
 * plan with three dashboard tasks could only ever use one slot. The case that
 * paid for the change is ordinary — t12 and t13 were both `dashboard`, both
 * purely additive, and neither could start until the other had closed.
 *
 * WHAT MAKES IT SAFE NOW is not a smarter lock, it is a separate directory:
 * `git worktree add` gives the second writer its OWN checkout of the same
 * repository, on its own branch, sharing the object store. Nothing to merge at
 * the file level while they run, and the shared `.git` is read-mostly.
 *
 * WHAT THIS MODULE IS: the pure half. Every path, branch name and git argv is
 * derived here, so the algebra is testable without a repository — the git
 * calls themselves are injected at the call site (lib/orchestrator-dispatch.ts).
 *
 * WHO CLEARS IT (哲学-adjacent, and the same rule the review worktrees follow):
 * whoever creates it. A child's worktree is removed when the project manager
 * settles it — merged, or discarded — and an orphan (a manager that died before
 * deciding) is REPORTED rather than silently reaped: the work in it may be the
 * only copy, and deleting somebody's last copy to save disk is not a trade this
 * gate makes.
 */

/** The branch a child's isolated checkout is on. */
export function childWorktreeBranch(childId: string): string {
  return `rg-child-${childId}`;
}

/**
 * Where that checkout lives: BESIDE the repo, never inside it.
 *
 * A worktree inside the repository would appear as untracked content in the
 * main checkout, which is the very thing the isolation exists to prevent —
 * the fingerprint, the precommit cache and the ship gate all read that tree.
 * The name is derived from the child id, so the path is stable across a
 * recovery and two children can never collide on it.
 */
export function childWorktreePath(repoRoot: string, childId: string): string {
  const idx = repoRoot.lastIndexOf("/");
  const parent = idx > 0 ? repoRoot.slice(0, idx) : repoRoot;
  const name = idx > 0 ? repoRoot.slice(idx + 1) : repoRoot;
  return `${parent}/${name}-rg-${childId}`;
}

/**
 * The repo a child's worktree was cut from — the inverse of
 * {@link childWorktreePath}, and the path a merge lands in.
 *
 * Returns undefined for a path this module could not have produced (a
 * hand-made worktree, a renamed directory). That is a REFUSAL, not a guess:
 * the alternative to "I cannot tell which repo this belongs to" is merging
 * somebody's work into the wrong checkout.
 */
export function repoRootOfWorktree(worktreePath: string, childId: string): string | undefined {
  const suffix = `-rg-${childId}`;
  return worktreePath.endsWith(suffix) ? worktreePath.slice(0, -suffix.length) : undefined;
}

/**
 * One git invocation, as an argv. */
export type WorktreeArgv = readonly string[];

/**
 * THE SEQUENCE THAT CREATES AN ISOLATED CHECKOUT.
 *
 * `-b <branch> <path> HEAD` pins the child to the commit the parent is on
 * right now. That is what makes the child's own review and precommit
 * meaningful: it starts from the same tree its task was planned against, and
 * the manager's later commits cannot move the ground under it.
 *
 * `HEAD` rather than a branch name on purpose: a detached-at-a-name checkout
 * would follow whatever that branch did next, and a child that started from
 * "what main is now" must not silently pick up somebody else's later merge.
 */
export function createWorktreeArgv(repoRoot: string, childId: string): WorktreeArgv {
  return [
    "-C", repoRoot,
    "worktree", "add",
    "-b", childWorktreeBranch(childId),
    childWorktreePath(repoRoot, childId),
    "HEAD",
  ];
}

/**
 * How the manager settles a finished child's checkout.
 *
 *  - `keep`    — leave it, and say so in the receipt. The default, because the
 *                work in it is often the only copy and a default that deletes
 *                is a default that eventually deletes something wanted.
 *  - `merge`   — commit the child's leftovers, merge its branch into the
 *                manager's checkout UNCOMMITTED (staged, so the manager sees
 *                exactly what arrived; `--no-commit --no-ff` is what makes the
 *                conflict rollback possible at all), then RECLAIM the checkout
 *                directory (the branch stays — see `reclaimWorktreeArgv`).
 *  - `discard` — remove the checkout and its branch.
 */
export const WORKTREE_SETTLEMENTS = Object.freeze(["keep", "merge", "discard"] as const);
export type WorktreeSettlement = (typeof WORKTREE_SETTLEMENTS)[number];

/**
 * Commit the child's leftovers, so a merge has something to merge.
 *
 * A child at delivery station `precommit` is explicitly allowed to leave its
 * work uncommitted — the station says the GATE's checks pass and the human
 * commits. So the manager cannot assume a clean branch, and a merge of an
 * uncommitted worktree would bring nothing at all.
 *
 * `add -A` THEN `commit`, never `commit -am` (round-5 P1): `-a` stages only
 * MODIFIED and DELETED TRACKED files, so every file the child CREATED would
 * have been left behind — silently, while the receipt told the manager its
 * changes had been merged. A child adding a component and its test is the
 * ordinary case, not the edge one.
 *
 * Two argv, not one: the caller runs steps in order and stops on the first
 * failure, which is exactly the semantics needed here.
 *
 * The message is generated, not asked for: the manager settles the checkout,
 * it does not author the child's history, and the subject names the child so
 * `git log` on the result still says where the work came from.
 */
export function commitLeftoversArgv(worktreePath: string, taskId: string): WorktreeArgv[] {
  return [
    ["-C", worktreePath, "add", "-A"],
    ["-C", worktreePath, "commit", "-m", `chore(child): ${taskId} 的产出`],
  ];
}

/**
 * Merge the child's branch into the manager's checkout, uncommitted.
 *
 * `--no-commit --no-ff`, NOT `--squash` (round-5 P1). A squash merge never
 * writes `MERGE_HEAD`, so `git merge --abort` cannot undo one — which made the
 * promised rollback impossible: a conflict would have left the manager's
 * checkout in a half-merged state with no safe way back. `--no-commit` keeps
 * the same property that mattered (the result is STAGED, so the manager or the
 * next `judge_submit` sees exactly what arrived before committing it), and the
 * merge commit that `--no-ff` would record only exists if the manager commits
 * it.
 *
 * The trade is deliberate: history gains a merge commit where a squash would
 * have had one line, and in exchange a conflict costs one command that
 * actually works.
 *
 * THE BRANCH ARGUMENT IS THE POINT (2026-09-18, reviewer P2). Deriving it from
 * `childId` here was the original shape, and it is wrong in exactly one case:
 * the child RENAMED it. That is not hypothetical — `buildBranchLine`
 * (lib/orchestrator-delivery.ts) asks every child whose station reaches `pr`
 * to rename the gate's `rg-child-…` handle with `git branch -m …` before it
 * pushes, precisely so an internal handle never becomes a PR head. Settling
 * the DERIVED name after that fails with "branch not found", which is the
 * worst shape a gate defect can take: the manager follows the gate's own
 * instruction, and the gate then reports the manager's checkout as broken.
 * Callers pass the branch they read off the checkout; `planSettlement` takes
 * it as a parameter, so no caller can forget it.
 */
export function mergeWorktreeArgv(repoRoot: string, branch: string): WorktreeArgv {
  return ["-C", repoRoot, "merge", "--no-commit", "--no-ff", branch];
}

/** Abort a conflicted merge, leaving the manager's checkout as it was. */
export function abortMergeArgv(repoRoot: string): WorktreeArgv {
  return ["-C", repoRoot, "merge", "--abort"];
}

/** Is this git output a CONFLICT rather than a refusal we should surface? */
export function looksLikeMergeConflict(output: string): boolean {
  return /CONFLICT \(|Automatic merge failed|fix conflicts/i.test(output);
}

/**
 * Is this git output the thing we were trying to remove ALREADY BEING GONE?
 *
 * WHY IT HAS TO BE ITS OWN PREDICATE (round-11 P1). Reclamation is two steps —
 * remove the checkout, delete the branch — and a first attempt can succeed at
 * one and fail at the other. On the retry the successful half reports "not
 * there", and treating that as a failure would make the pair impossible to
 * converge: `reclamation` would stay non-empty forever, `reclaimed` would
 * never become true, and the record would never be cleared. So "already gone"
 * has to read as "the state you asked for holds".
 *
 * AND IT HAS TO BE NARROW (round-11 P2). Reading a generic failure as success
 * strands a checkout that still exists — the one direction that loses work —
 * so this matches git's own two exact phrasings and nothing else. A permission
 * error, a directory in use, an unreadable repo: all of those stay failures,
 * and the manager gets a receipt that says so.
 *
 * Pure, and beside `looksLikeMergeConflict` for the same reason: the decision
 * belongs where a unit test can reach it, not inside the closure that shells
 * out to git.
 */
export function looksLikeAlreadyGone(output: string): boolean {
  return /is not a working tree/i.test(output) || /error: branch '[^']+' not found/i.test(output);
}

/**
 * The RECLAMATION, and it is two commands because git keeps two things.
 *
 * `--force` on the remove: the child may have left untracked build output, and
 * a worktree that refuses to be removed is a worktree nobody ever reclaims.
 * The branch is deleted separately because it outlives the directory.
 *
 * NOT RUN AS PART OF A MERGE (round-6 P2). The merge this module plans is
 * `--no-commit`, so at the moment it returns the child's work is STAGED and
 * nothing else — delete its checkout and branch there and a `merge --abort` or
 * a `reset` leaves that work reachable only through the reflog, which is
 * exactly what "the work in it is often the only copy" forbids. A merge
 * settles the CONTENT; the checkout is reclaimed by an explicit `discard`
 * once the merge is committed.
 */
export function removeWorktreeArgv(repoRoot: string, childId: string, branch: string): WorktreeArgv[] {
  return [
    ["-C", repoRoot, "worktree", "remove", "--force", childWorktreePath(repoRoot, childId)],
    // The branch comes from the CALLER for the same reason the merge does: a
    // child that renamed it holds a name this module cannot derive.
    ["-C", repoRoot, "branch", "-D", branch],
  ];
}

/**
 * Reclaim the checkout of a child whose work has JUST BEEN MERGED — the
 * directory only, never the branch.
 *
 * WHY THE DIRECTORY GOES AND THE BRANCH STAYS (user decision, 2026-09-15).
 * The manager's merge is `--no-commit --no-ff`, so the receipt the manager
 * reads promises a way back; the branch is that way back. The merge commit
 * does not exist yet, `git merge --abort` still has to work, and it needs the
 * merged content to be reachable from somewhere other than the staged index —
 * delete the branch and an `--abort` after a change of mind leaves the child's
 * work in the reflog and nowhere else, which is the one outcome this module
 * refuses to produce ("the work in it is often the only copy").
 *
 * What the user DID ask for is the pile of directories: four settled children
 * left four `<repo>-rg-<child>` checkouts beside the repository, and the next
 * run has to know which ones are dead. A repository's branches cost nothing
 * and are visible in `git branch`; a checkout costs disk and is invisible.
 *
 * `--force`, like the discard path: a child may have left untracked build
 * output, and a checkout that refuses to be removed is one nobody reclaims.
 */
export function reclaimWorktreeArgv(repoRoot: string, childId: string): WorktreeArgv {
  return ["-C", repoRoot, "worktree", "remove", "--force", childWorktreePath(repoRoot, childId)];
}

/**
 * WHAT A SETTLEMENT OWES THE MANAGER, as a plan rather than a sequence of calls.
 *
 * Returned instead of executed so the decision — which is about the manager's
 * checkout, its branch and somebody else's work — is visible in one place, and
 * so the conflict path is decided BEFORE the merge runs rather than discovered
 * in it.
 */
export interface SettlementPlan {
  /** Ordered git argv. A failure at any step stops the sequence. */
  steps: WorktreeArgv[];
  /** Steps to run (best-effort) when a `merge` conflicts. */
  onConflict?: WorktreeArgv[];
}

export function planSettlement(
  settlement: WorktreeSettlement,
  repoRoot: string,
  childId: string,
  taskId: string,
  /**
   * The branch the checkout is ACTUALLY on — read off it by the caller, never
   * derived here: a child whose station reaches `pr` is told to rename the
   * gate's handle before it pushes, and settling the name it no longer has is
   * how the gate turns its own instruction into the manager's error (see
   * {@link mergeWorktreeArgv}).
   */
  branch: string,
): SettlementPlan {
  const worktreePath = childWorktreePath(repoRoot, childId);
  switch (settlement) {
    case "keep":
      return { steps: [] };
    case "merge":
      return {
        steps: [
          ...commitLeftoversArgv(worktreePath, taskId),
          mergeWorktreeArgv(repoRoot, branch),
          // THE DIRECTORY GOES LAST, AND ONLY AFTER THE MERGE SUCCEEDED
          // (2026-09-15, user decision). A failure anywhere above stops the
          // sequence, so a conflicted merge never reaches this step — and the
          // conflict path below needs the child's checkout exactly where it
          // is.
          reclaimWorktreeArgv(repoRoot, childId),
        ],
        // Back to exactly what the manager had. The CHILD's BRANCH is
        // untouched, so a conflict costs a human decision, not the work.
        // `--no-commit --no-ff` is what makes this possible at all — see
        // mergeWorktreeArgv — and keeping the branch (not the checkout) is
        // what keeps it possible after the reclaim above.
        onConflict: [abortMergeArgv(repoRoot)],
      };
    case "discard":
      return { steps: removeWorktreeArgv(repoRoot, childId, branch) };
  }
}

/**
 * A checkout nobody settled, as the manager sees it.
 *
 * `orchestrator_attach` reports these — a crash or a restart is the one thing
 * that leaves a worktree with no live child and no decision on record, and an
 * orphan nobody is told about is an orphan nobody reclaims.
 */
export interface OrphanWorktree {
  childId: string;
  taskId: string;
  path: string;
  branch: string;
}

export function findOrphanWorktrees(
  children: readonly {
    id: string;
    taskId: string;
    paneId: string;
    worktree?: { path: string; branch: string } | undefined;
    closedAt?: string | undefined;
  }[],
  livePaneIds: readonly string[] | undefined,
): OrphanWorktree[] {
  // Liveness is the CALLER's call, and an UNREADABLE pane list resolves the
  // way every other liveness question in this project does: missing
  // information is never evidence of death, so it yields no claim at all
  // (`judgePaneAlive` returns `undefined` for the same input, and the wait
  // treats it as alive). Reporting every worktree the moment tmux hiccups
  // would teach the manager to ignore the list.
  if (livePaneIds === undefined) return [];
  const live = new Set(livePaneIds);
  return children
    .filter((c) => c.worktree !== undefined && !c.closedAt)
    .filter((c) => !live.has(c.paneId))
    .map((c) => ({
      childId: c.id,
      taskId: c.taskId,
      path: c.worktree!.path,
      branch: c.worktree!.branch,
    }));
}
