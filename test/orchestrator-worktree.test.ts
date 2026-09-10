/**
 * ONE CHECKOUT PER WRITER (2026-09-10).
 *
 * The algebra only — every path, branch, argv and settlement plan is derived
 * here so it can be checked without a repository. What the git calls DO is the
 * extension's half (it runs these argv against real git) and is covered by the
 * fake-world tests in test/orchestrator-tools.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WORKTREE_SETTLEMENTS,
  abortMergeArgv,
  childWorktreeBranch,
  childWorktreePath,
  createWorktreeArgv,
  findOrphanWorktrees,
  looksLikeMergeConflict,
  mergeWorktreeArgv,
  planSettlement,
  removeWorktreeArgv,
  repoRootOfWorktree,
} from "../lib/orchestrator-worktree.ts";

const REPO = "/Users/dev/workspace/dashboard";
const CHILD = "t13-uiux-dash-mtv8nd57";

test("the checkout lives BESIDE the repo — never inside the tree it isolates from", () => {
  const path = childWorktreePath(REPO, CHILD);
  assert.equal(path, "/Users/dev/workspace/dashboard-rg-t13-uiux-dash-mtv8nd57");
  // Inside the repo would appear as untracked content in the MAIN checkout —
  // the very tree the fingerprint, the precommit cache and the ship gate read.
  assert.ok(!path.startsWith(`${REPO}/`), "an inner worktree would poison every fingerprint");
  assert.equal(childWorktreeBranch(CHILD), `rg-child-${CHILD}`);
});

test("the repo a worktree came from is recoverable — and a foreign path is REFUSED, not guessed", () => {
  assert.equal(repoRootOfWorktree(childWorktreePath(REPO, CHILD), CHILD), REPO,
    "settlement has to know which checkout to merge INTO");
  // The alternative to "I cannot tell where this belongs" is merging somebody's
  // work into the wrong repository, so it must be undefined rather than a
  // best-effort prefix.
  assert.equal(repoRootOfWorktree("/tmp/hand-made", CHILD), undefined);
  assert.equal(repoRootOfWorktree(childWorktreePath(REPO, "some-other-child"), CHILD), undefined,
    "a worktree cut for a DIFFERENT child is not this child's to settle");
});

test("creation pins the child to HEAD on a branch of its own", () => {
  const argv = [...createWorktreeArgv(REPO, CHILD)];
  assert.deepEqual(argv.slice(0, 5), ["-C", REPO, "worktree", "add", "-b"]);
  assert.equal(argv[5], childWorktreeBranch(CHILD));
  assert.equal(argv[6], childWorktreePath(REPO, CHILD));
  assert.equal(argv[7], "HEAD",
    "HEAD, not a branch name — the child must not silently follow a branch that moves under it");
});

test("keep touches nothing, and says where the work is", () => {
  const plan = planSettlement("keep", REPO, CHILD, "t13");
  assert.deepEqual(plan.steps, [], "keep is the default BECAUSE it is the one that cannot lose work");
  assert.equal(WORKTREE_SETTLEMENTS.includes("keep"), true);
});

test("merge covers ALL the leftovers, then merges without committing — and the conflict path is planned UP FRONT", () => {
  const plan = planSettlement("merge", REPO, CHILD, "t13");
  // `add -A` THEN `commit`, never `commit -am` (round-5 P1): `-a` stages only
  // MODIFIED/DELETED tracked files, so every file the child CREATED would have
  // been left behind while the receipt said its changes were merged.
  assert.deepEqual([...plan.steps[0]!], ["-C", childWorktreePath(REPO, CHILD), "add", "-A"]);
  assert.deepEqual([...plan.steps[1]!], ["-C", childWorktreePath(REPO, CHILD), "commit", "-m", "chore(child): t13 的产出"]);
  // `--no-commit --no-ff`, NOT `--squash` (round-5 P1): a squash never writes
  // MERGE_HEAD, so `git merge --abort` cannot undo one — the promised rollback
  // was impossible. This form can be aborted, and the result is still STAGED.
  assert.deepEqual([...plan.steps[2]!], ["-C", REPO, "merge", "--no-commit", "--no-ff", childWorktreeBranch(CHILD)]);
  assert.ok(!plan.steps[2]!.includes("--squash"), "a squash cannot be rolled back");
  // AND the reclamation, which the receipt claimed while nothing did it.
  assert.deepEqual(plan.steps.slice(3).map((a) => [...a]), removeWorktreeArgv(REPO, CHILD).map((a) => [...a]));
  // Decided BEFORE the merge runs, not discovered in it.
  assert.deepEqual([...(plan.onConflict ?? [])].map((a) => [...a]), [[...abortMergeArgv(REPO)]]);
});

test("discard removes BOTH the checkout and the branch — git keeps two things", () => {
  const plan = planSettlement("discard", REPO, CHILD, "t13");
  assert.deepEqual(plan.steps.map((a) => [...a]), removeWorktreeArgv(REPO, CHILD).map((a) => [...a]));
  assert.equal(plan.steps.length, 2, "a removed worktree whose branch survives is half a reclamation");
  assert.ok(plan.steps[0]!.includes("--force"),
    "a child may leave untracked build output, and a worktree that refuses to be removed is never reclaimed");
  assert.equal(plan.onConflict, undefined, "there is nothing to roll back on a discard");
});

test("conflicts are recognised in BOTH streams — git writes them to stdout", () => {
  // Round-5 P1: the executor read only stderr, so neither of these could ever
  // fire — the planned abort never ran. `git merge` writes its conflict report
  // to STDOUT and exits non-zero; the same is true of "nothing to commit".
  assert.equal(looksLikeMergeConflict("CONFLICT (content): Merge conflict in a.ts\nAutomatic merge failed; fix conflicts"), true);
  assert.equal(looksLikeMergeConflict("Auto-merging a.ts\nCONFLICT (content): Merge conflict in a.ts"), true);
  assert.equal(looksLikeMergeConflict("fatal: not a git repository"), false,
    "a refusal is reported as itself — swallowing it as `conflict` would send the manager chasing the wrong thing");
});

test("an unsettled checkout is REPORTED, never reaped — and unknown liveness is not death", () => {
  const children = [
    { id: "c1", taskId: "t1", paneId: "%1", worktree: { path: "/r-rg-c1", branch: "b1" } },
    { id: "c2", taskId: "t2", paneId: "%2" },                                  // no worktree: nothing to settle
    { id: "c3", taskId: "t3", paneId: "%3", worktree: { path: "/r-rg-c3", branch: "b3" }, closedAt: "2026-09-10T00:00:00.000Z" },
  ];
  assert.deepEqual(findOrphanWorktrees(children, ["%1"]), [],
    "a live pane is not an orphan");
  assert.deepEqual(findOrphanWorktrees(children, ["%9"]).map((w) => w.childId), ["c1"],
    "a checkout with no live pane behind it is the one thing a crash leaves behind");
  assert.deepEqual(findOrphanWorktrees(children, undefined), [],
    "an unreadable pane list is missing information, never evidence of death — the same rule the judge panes follow");
});
