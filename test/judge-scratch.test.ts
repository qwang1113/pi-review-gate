/**
 * D — the gate owns the reviewer's throwaway worktrees.
 *
 * A reviewer verifies by doing (`git worktree add <tmp> HEAD` to run tests on
 * the reviewed commit) and was told to build those under $TMPDIR. The gate
 * points that $TMPDIR at a per-SESSION dir, so on the judge's exit it can
 * reclaim exactly those worktrees — and nothing else, so a concurrent lane's
 * live review copy is never touched. These pin the pure pieces of that.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

import {
  judgeScratchDir,
  reviewScratchWorktrees,
  REVIEW_SCRATCH_DIRNAME,
} from "../lib/judge-process.ts";
import { buildSessionEnv } from "../lib/session-env.ts";

test("the scratch dir is per session, under the OS tmpdir", () => {
  const a = judgeScratchDir("rg-reviewer-abc123");
  const b = judgeScratchDir("rg-reviewer-def456");
  assert.ok(a.startsWith(tmpdir()), "lives under the OS tmpdir");
  assert.match(a, new RegExp(`${REVIEW_SCRATCH_DIRNAME}/rg-reviewer-abc123$`));
  assert.notEqual(a, b, "two judge sessions never share a scratch — no cross-lane deletion");
});

test("the judge pane's TMPDIR IS the directory the reaper looks in (2026-09-14)", () => {
  // The reclaim was written but never ARMED: `reapReviewScratch` walked
  // `judgeScratchDir(judgeId)`, while nothing ever set that env key on the
  // judge — so reviewers built their throwaway worktrees in the SYSTEM tmp
  // root, the reaper found none of them, and one round's worktree broke the
  // repository's shared git hooks for every later commit when it vanished.
  // A missing write side is invisible unless the two sides are compared, so
  // this compares them.
  const judgeId = "rg-reviewer-f3eb4277-b6ae531c-99b425b3-g0";
  const env = buildSessionEnv({ kind: "judge", openerId: "o", judgeId, role: "reviewer" });
  const scratch = judgeScratchDir(judgeId);
  assert.equal(env.TMPDIR, scratch, "the judge must build its worktrees where the gate reclaims them");
  assert.ok(scratch.startsWith(tmpdir()), "and that place is under the OS tmpdir");
  // The worktrees a reviewer leaves there stay reclaimable BECAUSE the env and
  // the reaper agree — this is the pair, not one side of it.
  assert.deepEqual(
    reviewScratchWorktrees(`worktree /repo\n\nworktree ${scratch}/rgrev-abc\ndetached\n`, env.TMPDIR),
    [`${scratch}/rgrev-abc`],
  );
});

test("reviewScratchWorktrees selects ONLY the worktrees under this session's scratch", () => {
  const scratch = judgeScratchDir("rg-reviewer-abc123");
  const other = judgeScratchDir("rg-reviewer-def456");
  const porcelain = [
    `worktree /Users/q/workspace/repo`,
    `HEAD 1111111111111111111111111111111111111111`,
    `branch refs/heads/main`,
    ``,
    `worktree ${scratch}/rg-review-xyz`,
    `HEAD 2222222222222222222222222222222222222222`,
    `detached`,
    ``,
    `worktree ${other}/rg-review-abc`,
    `HEAD 3333333333333333333333333333333333333333`,
    `detached`,
    ``,
  ].join("\n");
  const picked = reviewScratchWorktrees(porcelain, scratch);
  assert.deepEqual(picked, [`${scratch}/rg-review-xyz`],
    "only THIS session's scratch worktree — never the main repo, never another lane's");
});

test("reviewScratchWorktrees matches the scratch dir itself and tolerates a trailing slash", () => {
  const scratch = judgeScratchDir("rg-reviewer-abc123");
  const porcelain = [
    `worktree ${scratch}`,
    `worktree ${scratch}/nested/wt`,
    `worktree /somewhere/else`,
  ].join("\n");
  assert.deepEqual(reviewScratchWorktrees(porcelain, scratch + "/"), [scratch, `${scratch}/nested/wt`]);
});

test("reviewScratchWorktrees is empty when the judge created nothing", () => {
  const scratch = judgeScratchDir("rg-reviewer-abc123");
  assert.deepEqual(reviewScratchWorktrees("worktree /Users/q/workspace/repo\n", scratch), []);
  assert.deepEqual(reviewScratchWorktrees("", scratch), []);
});

test("reviewScratchWorktrees never over-matches a sibling whose id SHARES this prefix", () => {
  // The destructive edge (round-5 P2): a lane `rg-reviewer-abc123` must never
  // reclaim `rg-reviewer-abc123-2`'s worktree just because the path starts with
  // the same characters. The trailing "/" in the prefix is what stops it — a
  // bare `startsWith` would delete a concurrent lane's live review copy.
  const scratch = judgeScratchDir("rg-reviewer-abc123");
  const sibling = judgeScratchDir("rg-reviewer-abc123-2");
  assert.ok(sibling.startsWith(scratch), "the sibling id shares the prefix — the trap this pins");
  const porcelain = [
    `worktree ${scratch}/rg-review-mine`,
    `worktree ${sibling}/rg-review-theirs`,
  ].join("\n");
  assert.deepEqual(reviewScratchWorktrees(porcelain, scratch), [`${scratch}/rg-review-mine`],
    "only THIS lane's worktree — the sibling with the shared prefix is untouched");
});

