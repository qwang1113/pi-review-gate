import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isMessageOnlyRewrite, hasAmendFlag, rebaseBranchName } from "../lib/git-rewrite.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- the observation: same tree ⇒ no content ------------------------------

test("an amend whose tree is unchanged is a message-only rewrite", () => {
  assert.equal(isMessageOnlyRewrite({ amend: true, newTree: "t1", replacedTree: "t1" }), true);
});

test("an amend that CHANGES the tree is an ordinary commit and stays gated", () => {
  assert.equal(isMessageOnlyRewrite({ amend: true, newTree: "t2", replacedTree: "t1" }), false);
});

test("without --amend nothing is exempt, however the trees compare", () => {
  assert.equal(isMessageOnlyRewrite({ amend: false, newTree: "t1", replacedTree: "t1" }), false);
});

test("an unreadable tree proves nothing: fail closed", () => {
  assert.equal(isMessageOnlyRewrite({ amend: true, replacedTree: "t1" }), false);
  assert.equal(isMessageOnlyRewrite({ amend: true, newTree: "t1" }), false);
  assert.equal(isMessageOnlyRewrite({ amend: true }), false);
  assert.equal(isMessageOnlyRewrite({ amend: true, newTree: "", replacedTree: "" }), false);
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
  assert.match(hook, /headTree === currentFp\) process\.exit\(0\)/,
    "an identical tree skips the content gates");
  const exemptionAt = hook.indexOf("headTree === currentFp");
  const gatesAt = hook.indexOf("if (state.hasCodeChange) {");
  assert.ok(exemptionAt > 0 && gatesAt > exemptionAt,
    "the exemption must be decided BEFORE the content gates run");
});

test("the commit-msg hook enforces L5 on the message an editor produced", () => {
  const hook = readFileSync(join(ROOT, "hooks", "commit-msg"), "utf8");
  assert.match(hook, /Script=Latin/, "the same hard rule as lib/lang-detect.ts");
  assert.match(hook, /startsWith\("#"\)/, "git's own comment lines are not the message");
  assert.match(hook, /REVIEW_GATE_BYPASS/, "the reason names the escape hatch");
});
