import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePorcelain,
  describeDirty,
  appendBranchOp,
  deriveWorkBranchName,
  decideFinish,
  commitBranchAllowed,
  parseConflictFiles,
  interpretWorktreeChoice,
  isProtectedBranch,
  isValidGitBranchName,
  WORKTREE_CHOICES,
  MAX_BRANCH_OPS,
  type BranchOp,
} from "../lib/workspace-branch.ts";

// ---- reading the worktree ----

test("porcelain lines become files, with untracked marked", () => {
  const files = parsePorcelain(" M lib/a.ts\n?? new.ts\nA  staged.ts\n");
  assert.equal(files.length, 3);
  assert.deepEqual(files.map((f) => f.path), ["lib/a.ts", "new.ts", "staged.ts"]);
  assert.deepEqual(files.map((f) => f.untracked), [false, true, false]);
});

test("a rename reports the path that exists NOW", () => {
  const files = parsePorcelain("R  old/name.ts -> new/name.ts\n");
  assert.equal(files[0].path, "new/name.ts");
});

test("empty and truncated output is not a file list", () => {
  assert.deepEqual(parsePorcelain(""), []);
  assert.deepEqual(parsePorcelain("\n\n"), []);
  assert.deepEqual(parsePorcelain("M"), []);
});

test("the description counts tracked and untracked separately and caps the list", () => {
  assert.equal(describeDirty([]), "工作区干净");
  const many = parsePorcelain(Array.from({ length: 20 }, (_, i) => `?? f${i}.ts`).join("\n"));
  const text = describeDirty(many);
  assert.match(text, /20 个改动（0 个已跟踪，20 个未跟踪）/);
  assert.match(text, /…还有 8 个/);
});

// ---- the three-way choice ----

test("every choice line maps back to its choice, and nothing else does", () => {
  assert.equal(interpretWorktreeChoice(WORKTREE_CHOICES.baseline), "baseline");
  assert.equal(interpretWorktreeChoice(WORKTREE_CHOICES.handled), "handled");
  assert.equal(interpretWorktreeChoice(WORKTREE_CHOICES.discard), "discard");
  assert.equal(interpretWorktreeChoice(WORKTREE_CHOICES.exempt), "exempt");
  assert.equal(interpretWorktreeChoice("something else"), undefined);
  assert.equal(interpretWorktreeChoice(undefined), undefined, "a dismissed dialog chooses nothing");
});


// ---- the audit log ----

test("branch ops append in order and stay bounded", () => {
  let log: BranchOp[] | undefined;
  log = appendBranchOp(log, { op: "checkout", from: null, to: "main", at: "t1" });
  log = appendBranchOp(log, { op: "base_branch_set", branch: "dev", at: "t2" });
  assert.equal(log.length, 2);
  assert.equal(log[0].op, "checkout");
  for (let i = 0; i < MAX_BRANCH_OPS + 10; i++) {
    log = appendBranchOp(log, { op: "base_branch_set", branch: `b${i}`, at: "t" });
  }
  assert.equal(log.length, MAX_BRANCH_OPS);
  assert.equal((log[log.length - 1] as { branch: string }).branch, `b${MAX_BRANCH_OPS + 9}`,
    "the NEWEST entries survive");
});

// ---- branch names ----
test("a work branch name follows git ref rules and never a protected branch", () => {
  assert.equal(deriveWorkBranchName("feat/add-pagination", "abc"), "feat/add-pagination");
  assert.equal(deriveWorkBranchName(undefined, "abc"), "session-abc");
  assert.equal(deriveWorkBranchName("", "abc"), "session-abc");
  assert.equal(deriveWorkBranchName("main", "abc"), "session-abc");
  assert.equal(deriveWorkBranchName("master", "abc"), "session-abc");
  // Illegal git ref characters → fall back, never a mangled name.
  assert.equal(deriveWorkBranchName("feat/my thing", "abc"), "session-abc");
  assert.equal(deriveWorkBranchName("--weird--", "abc"), "--weird--");
  assert.equal(deriveWorkBranchName("x".repeat(256), "abc"), "session-abc");
  assert.equal(deriveWorkBranchName("feat..x", "abc"), "session-abc");
  assert.equal(deriveWorkBranchName(".hidden", "abc"), "session-abc");
  assert.equal(deriveWorkBranchName("feat/x.lock", "abc"), "session-abc");
  assert.equal(deriveWorkBranchName("feat/x y", "abc"), "session-abc");
});


test("protected branches are exactly main and master", () => {
  assert.equal(isProtectedBranch("main"), true);
  assert.equal(isProtectedBranch(" master "), true);
  assert.equal(isProtectedBranch("develop"), false);
});

test("isValidGitBranchName applies git check-ref-format rules", () => {
  assert.equal(isValidGitBranchName("feat/add-pagination"), true);
  assert.equal(isValidGitBranchName("session-abc"), true);
  assert.equal(isValidGitBranchName("fix/auth-token"), true);
  assert.equal(isValidGitBranchName(""), false);
  assert.equal(isValidGitBranchName("feat/my thing"), false);
  assert.equal(isValidGitBranchName("feat..x"), false);
  assert.equal(isValidGitBranchName(".hidden"), false);
  assert.equal(isValidGitBranchName("feat/x.lock"), false);
  assert.equal(isValidGitBranchName("feat/x/"), false);
  assert.equal(isValidGitBranchName("feat//x"), false);
  assert.equal(isValidGitBranchName("feat/x y"), false);
  assert.equal(isValidGitBranchName("feat~1"), false);
  assert.equal(isValidGitBranchName("feat^x"), false);
  assert.equal(isValidGitBranchName("feat:x"), false);
  assert.equal(isValidGitBranchName("feat?x"), false);
  assert.equal(isValidGitBranchName("feat*x"), false);
  assert.equal(isValidGitBranchName("feat[x]"), false);
  assert.equal(isValidGitBranchName("feat\\x"), false);
  assert.equal(isValidGitBranchName("feat@{x"), false);
  assert.equal(isValidGitBranchName("@"), false);
  assert.equal(isValidGitBranchName("x".repeat(256)), false);
});

// ---- committing ----

test("no work branch on record ⇒ no commit (fail-closed)", () => {
  const d = commitBranchAllowed({ workBranch: undefined, currentBranch: "feat/x" });
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? "", /setup_workspace/);
});

test("a commit on another branch is refused, naming both", () => {
  const d = commitBranchAllowed({ workBranch: "feat/mine", currentBranch: "main" });
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? "", /main/);
  assert.match(d.reason ?? "", /feat\/mine/);
});

test("a detached HEAD is refused rather than guessed at", () => {
  assert.equal(commitBranchAllowed({ workBranch: "feat/mine", currentBranch: undefined }).allowed, false);
});

test("the work branch may commit", () => {
  assert.deepEqual(commitBranchAllowed({ workBranch: "feat/mine", currentBranch: "feat/mine" }), { allowed: true });
});

// ---- finishing ----

test("no branching ⇒ nothing to merge", () => {
  assert.equal(decideFinish({ workBranch: undefined, baseBranch: "dev", workIsAncestorOfBase: false }), "no-branching");
  assert.equal(decideFinish({ workBranch: "dev", baseBranch: "dev", workIsAncestorOfBase: false }), "no-branching");
  assert.equal(decideFinish({ workBranch: "w", baseBranch: undefined, workIsAncestorOfBase: false }), "no-branching");
});

test("already contained in the base ⇒ nothing to merge", () => {
  assert.equal(decideFinish({ workBranch: "w", baseBranch: "dev", workIsAncestorOfBase: true }), "already-merged");
});

test("different branches with unmerged work ⇒ merge", () => {
  assert.equal(decideFinish({ workBranch: "w", baseBranch: "dev", workIsAncestorOfBase: false }), "merge");
});

test("conflict files are trimmed, deduped of blanks and capped", () => {
  assert.deepEqual(parseConflictFiles("a.ts\n\n  b.ts  \n"), ["a.ts", "b.ts"]);
  assert.equal(parseConflictFiles(Array.from({ length: 80 }, (_, i) => `f${i}`).join("\n")).length, 50);
});
