import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { gitFailureText, gitOrNull, gitRawOrNull, gitText } from "../lib/git-exec.ts";
import { hermeticGitEnv } from "./helpers/git.ts";

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rg-git-exec-")));
  execFileSync("git", ["init", "-q", dir], { env: hermeticGitEnv() });
  return dir;
}

// The bug the module exists for: an inherited GIT_DIR / GIT_WORK_TREE (a git
// hook, a wrapper) made every un-sanitized call describe ANOTHER repository.
test("an ambient GIT_DIR / GIT_WORK_TREE cannot relocate the answer", () => {
  const mine = repo();
  const other = repo();
  const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
  try {
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    assert.equal(gitText(mine, ["rev-parse", "--show-toplevel"]), mine);
    assert.equal(gitOrNull(mine, ["rev-parse", "--show-toplevel"]), mine);
  } finally {
    if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
    if (saved.tree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.tree;
    rmSync(mine, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("failures: gitText throws with the exit status, the OrNull forms return null", () => {
  const dir = repo();
  try {
    assert.throws(() => gitText(dir, ["rev-parse", "--verify", "nope"]), (e: { status?: number }) => e.status === 128);
    assert.equal(gitOrNull(dir, ["rev-parse", "--verify", "nope"]), null);
    assert.equal(gitRawOrNull(dir, ["rev-parse", "--verify", "nope"]), null);
    assert.equal(gitRawOrNull(dir, ["rev-parse", "--is-inside-work-tree"]), "true\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// t11: git commit writes "nothing to commit" to STDOUT; Node's message has stderr only.
test("gitFailureText keeps the stdout a failing git wrote its reason to", () => {
  const dir = repo();
  try {
    let caught: unknown;
    try { gitText(dir, ["commit", "-m", "x"]); } catch (e) { caught = e; }
    assert.ok(caught, "a commit on an empty repo must fail");
    assert.match(gitFailureText(caught), /nothing to commit/);
    assert.equal(gitFailureText(new Error("plain")), "plain", "no stdout ⇒ the message alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
