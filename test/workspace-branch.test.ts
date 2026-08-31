import { test } from "node:test";
import assert from "node:assert/strict";
import { isProtectedBranch, PROTECTED_BRANCHES } from "../lib/workspace-branch.ts";

// ---- the soft guardrail: protected-branch detection ----

test("main, master, dev and develop are protected", () => {
  for (const b of ["main", "master", "dev", "develop"]) {
    assert.equal(isProtectedBranch(b), true, `${b} should be protected`);
  }
});

test("whitespace does not fool the check", () => {
  assert.equal(isProtectedBranch(" main "), true);
  assert.equal(isProtectedBranch("\tmain\n"), true);
});

test("feature branches are not protected", () => {
  for (const b of ["feat/foo", "fix/bar", "session-abc", "dev/2026-09-07", "develop2", "mainline"]) {
    assert.equal(isProtectedBranch(b), false, `${b} should not be protected`);
  }
});

test("the protected list is exactly the four obvious non-dev branches", () => {
  assert.deepEqual(PROTECTED_BRANCHES, ["main", "master", "dev", "develop"]);
});

test("empty or detached input is not protected", () => {
  assert.equal(isProtectedBranch(""), false);
  assert.equal(isProtectedBranch("HEAD"), false);
});
