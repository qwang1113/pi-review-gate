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

test("the scratch dir is per session, under the OS tmpdir", () => {
  const a = judgeScratchDir("rg-reviewer-abc123");
  const b = judgeScratchDir("rg-reviewer-def456");
  assert.ok(a.startsWith(tmpdir()), "lives under the OS tmpdir");
  assert.match(a, new RegExp(`${REVIEW_SCRATCH_DIRNAME}/rg-reviewer-abc123$`));
  assert.notEqual(a, b, "two judge sessions never share a scratch — no cross-lane deletion");
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
