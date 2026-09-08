import test from "node:test";
import assert from "node:assert/strict";

import {
  isOutsideRepoPath,
  isSensitiveOutsideRepoPath,
  OUT_OF_REPO_SENSITIVE_SEGMENTS,
  sensitiveOutOfRepoEdits,
} from "../lib/out-of-repo-paths.ts";

// ---------------------------------------------------------------------------
// The signal: absoluteness.
//
// This module is all that is left of lib/orchestrator-boundaries.ts: the
// boundary algebra was removed with the plan's file boundaries (2026-09-17,
// user decision). What survives is the supervision-time question "did this
// child write somewhere it had no business writing?".

test("isOutsideRepoPath reads the one signal the sidecar actually carries: absoluteness", () => {
  assert.equal(isOutsideRepoPath("/tmp/report.md"), true);
  assert.equal(isOutsideRepoPath("C:\\Users\\x\\report.md"), true);
  assert.equal(isOutsideRepoPath("lib/a.ts"), false);
  assert.equal(isOutsideRepoPath("../escape.ts"), false,
    "a `..` escape is resolved by repoRelative before it is ever recorded");
});

test("an out-of-repo process artifact is NOT a violation", () => {
  // Measured twice in round 4: a child writing its completion report to /tmp
  // was reported as out-of-boundary, because an absolute path can never be
  // covered by a repo-relative declaration. It is a process artifact — it
  // cannot pollute the worktree, enter a checkpoint, or reach a tracked file.
  assert.deepEqual(
    sensitiveOutOfRepoEdits(["lib/a.ts", "/tmp/rg-task-report.md", "/tmp/scratch/notes.txt"]),
    [],
  );
});

test("in-repo edits are never violations — that question belonged to the removed boundaries", () => {
  // A child may write anywhere inside its own repo: same-repo tasks are
  // serialized, so two writers never collide, and the plan no longer declares
  // which files a task may touch (2026-09-17 user decision).
  assert.deepEqual(
    sensitiveOutOfRepoEdits(["lib/a.ts", "extensions/review-gate.ts", "test/x.test.ts"]),
    [],
  );
});

test("empty and whitespace entries are dropped rather than reported", () => {
  assert.deepEqual(sensitiveOutOfRepoEdits(["", "   "]), []);
});

// ---------------------------------------------------------------------------
// THE SAFETY EDGE (P0): out-of-repo SENSITIVE paths are still violations

test("out-of-repo sensitive paths are still violations — real, home-EXPANDED absolute paths", () => {
  // The paths are written the way `sessionEditedFiles` actually holds them:
  // the shell expanded `~` long before the gate saw them, so a rule written
  // against the literal tilde would never fire. Every one of these must be
  // reported even though it is outside the repo.
  const sensitive = [
    "/Users/someone/.ssh/id_rsa",
    "/Users/someone/.ssh/config",
    "/Users/someone/.pi/review-gate.json",
    "/Users/someone/.pi/agent/agents/reviewer.md",
    "/Users/someone/.aws/credentials",
    "/Users/someone/.gnupg/secring.gpg",
    "/Users/someone/.config/gh/hosts.yml",
    "/Users/someone/.kube/config",
    "/Users/someone/.docker/config.json",
    "/tmp/staging/.env",
    "/tmp/leak/id_ed25519",
    "/tmp/leak/server.pem",
    "/tmp/leak/credentials",
    "/var/tmp/other-repo/.git/hooks/pre-commit",
  ];
  for (const p of sensitive) {
    assert.equal(isSensitiveOutsideRepoPath(p), true, p);
    assert.deepEqual(sensitiveOutOfRepoEdits([p]), [p], p);
  }
});

test("the sensitive-segment rule matches wherever the directory sits, not just under $HOME", () => {
  // Fail-closed direction: a backup copy of a key ring somewhere else is no
  // less sensitive than the one in the home directory.
  assert.equal(isSensitiveOutsideRepoPath("/tmp/backup/.ssh/id_rsa"), true);
  assert.equal(isSensitiveOutsideRepoPath("/srv/data/.aws/credentials"), true);
  // … and a same-named file that is NOT inside such a directory is not.
  assert.equal(isSensitiveOutsideRepoPath("/tmp/ssh-notes.md"), false);
  assert.equal(isSensitiveOutsideRepoPath("/tmp/config"), false);
});

test("every declared sensitive segment is honoured — the list is not decoration", () => {
  for (const segment of OUT_OF_REPO_SENSITIVE_SEGMENTS) {
    const p = `/Users/someone/${segment}/thing.conf`;
    assert.equal(isSensitiveOutsideRepoPath(p), true, p);
    assert.deepEqual(sensitiveOutOfRepoEdits([p]), [p], p);
  }
});

test("a harmless out-of-repo artifact is not swept up by the sensitive rule", () => {
  for (const p of ["/tmp/report.md", "/tmp/rg-task/notes.txt", "/var/folders/T/scratch.json"]) {
    assert.equal(isSensitiveOutsideRepoPath(p), false, p);
  }
});
