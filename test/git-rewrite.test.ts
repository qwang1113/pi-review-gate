import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isMessageOnlyRewrite, hasAmendFlag, rebaseBranchName } from "../lib/git-rewrite.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- the observation: same tree ⇒ no content ------------------------------

const CLEAN = { newTree: "t1", replacedTree: "t1", stagedChanges: false } as const;

test("an amend whose tree is unchanged and index is empty is a message-only rewrite", () => {
  assert.equal(isMessageOnlyRewrite({ amend: true, ...CLEAN }), true);
});

test("an amend that CHANGES the tree is an ordinary commit and stays gated", () => {
  assert.equal(isMessageOnlyRewrite({ amend: true, newTree: "t2", replacedTree: "t1", stagedChanges: false }), false);
});

test("a STAGED change is content, even when the worktree tree looks unchanged", () => {
  // Stage a change, restore the worktree: the worktree tree matches HEAD again
  // while the index — which is what `--amend` publishes — does not.
  assert.equal(isMessageOnlyRewrite({ amend: true, ...CLEAN, stagedChanges: true }), false);
  assert.equal(isMessageOnlyRewrite({ amend: true, newTree: "t1", replacedTree: "t1" }), false,
    "an unmeasured index is unknown, and unknown fails closed");
});

test("without --amend nothing is exempt, however the trees compare", () => {
  assert.equal(isMessageOnlyRewrite({ amend: false, ...CLEAN }), false);
});

test("an unreadable tree proves nothing: fail closed", () => {
  assert.equal(isMessageOnlyRewrite({ amend: true, replacedTree: "t1", stagedChanges: false }), false);
  assert.equal(isMessageOnlyRewrite({ amend: true, newTree: "t1", stagedChanges: false }), false);
  assert.equal(isMessageOnlyRewrite({ amend: true, stagedChanges: false }), false);
  assert.equal(isMessageOnlyRewrite({ amend: true, newTree: "", replacedTree: "", stagedChanges: false }), false);
});

// ---- recognizing the flag --------------------------------------------------

test("hasAmendFlag recognizes the flag as its own token", () => {
  assert.equal(hasAmendFlag('git commit --amend -m "fix: x"'), true);
  assert.equal(hasAmendFlag("git commit --amend"), true);
  assert.equal(hasAmendFlag("git commit --amend --no-edit"), true);
});

test("hasAmendFlag ignores look-alikes", () => {
  assert.equal(hasAmendFlag('git commit -m "document the --amendment policy"'), false);
  assert.equal(hasAmendFlag("git commit --amend-all"), false);
  assert.equal(hasAmendFlag("git commit -m x"), false);
});

// ---- where a rebase thinks it is -------------------------------------------

test("rebaseBranchName reads the branch out of a full ref", () => {
  assert.equal(rebaseBranchName("refs/heads/feat/pagination\n"), "feat/pagination");
  assert.equal(rebaseBranchName("refs/heads/main"), "main");
});

test("a rebase started from a raw sha names no branch", () => {
  assert.equal(rebaseBranchName("detached HEAD"), undefined);
  assert.equal(rebaseBranchName(""), undefined);
  assert.equal(rebaseBranchName("   "), undefined);
  assert.equal(rebaseBranchName(undefined), undefined);
});

// ---- the same rule at the hook layer --------------------------------------

test("the pre-commit hook applies the same no-content exemption", () => {
  const hook = readFileSync(join(ROOT, "hooks", "pre-commit"), "utf8");
  assert.match(hook, /rev-parse", "HEAD\^\{tree\}"/, "the hook reads the replaced tree");
  assert.match(hook, /headTree === currentFp && !staged\) process\.exit\(0\)/,
    "an identical tree AND an empty index skip the content gates");
  assert.match(hook, /"diff", "--cached", "--quiet", "HEAD"/,
    "the index — what the commit publishes — is measured too");
  const exemptionAt = hook.indexOf("headTree === currentFp");
  const gatesAt = hook.indexOf("if (state.hasCodeChange) {");
  assert.ok(exemptionAt > 0 && gatesAt > exemptionAt,
    "the exemption must be decided BEFORE the content gates run");
});

test("the commit-msg hook enforces L5 on the message an editor produced", () => {
  const hook = readFileSync(join(ROOT, "hooks", "commit-msg"), "utf8");
  assert.match(hook, /Script=Latin/, "the same hard rule as lib/lang-detect.ts");
  assert.match(hook, /startsWith\(commentChar\)/, "git's own comment lines are not the message");
  assert.match(hook, /core\.commentChar/, "…and the comment character is git's to define, not ours");
  assert.match(hook, /REVIEW_GATE_BYPASS/, "the reason names the escape hatch");
});
