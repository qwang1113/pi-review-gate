/**
 * WHICH COMMITS A CHANGE IS COMPARED AGAINST (2026-09-15, dashboard).
 *
 * The measured deadlock: mid-merge, HEAD is still the branch tip, so every
 * file `main` brought in looked newly created by this session — the file-size
 * gate refused the checkpoint over 600-line files main had authored, and the
 * only way into the review loop is that checkpoint. The session escaped by
 * switching the gate off.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  changeBaseRefsFromMergeHeads,
  firstBaseContaining,
  isNewInWorktree,
  readChangeBaseRefs,
} from "../lib/change-baseline.ts";
import { hermeticGitEnv } from "./helpers/git.ts";

test("HEAD is always the first base; merge parents are appended", () => {
  assert.deepEqual(changeBaseRefsFromMergeHeads(undefined), ["HEAD"], "no merge ⇒ exactly the old behaviour");
  assert.deepEqual(changeBaseRefsFromMergeHeads(""), ["HEAD"]);
  const sha = "a".repeat(40);
  assert.deepEqual(changeBaseRefsFromMergeHeads(sha + "\n"), ["HEAD", sha], "one extra parent");
  // An octopus merge has more than one, and duplicates (git repeats the name
  // when asked twice) must not multiply the list.
  const other = "b".repeat(40);
  assert.deepEqual(changeBaseRefsFromMergeHeads(`${sha}\n${other}\n${sha}\n`), ["HEAD", sha, other]);
});

test("junk in MERGE_HEAD never becomes an argv", () => {
  // A malformed line handed to `git cat-file -e <junk>:path` would answer
  // "missing" and make every file look NEW — the exact bug, restored by a
  // data problem nobody can see.
  assert.deepEqual(changeBaseRefsFromMergeHeads("not-a-sha\n../etc/passwd\n"), ["HEAD"]);
});

test("mid-merge, a file the OTHER side brought in is not new — and a genuinely new one still is", () => {
  const root = mkdtempSync(join(tmpdir(), "rg-baseline-"));
  const repo = join(root, "repo");
  const other = join(root, "other");
  try {
    const gitIn = (dir: string) => (...args: string[]): string =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: hermeticGitEnv() });
    const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com"];

    // A repo with a tracked file, plus a SIDE BRANCH that adds a big source
    // file (the file-size gate's subject) and a manifest.
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "README.md"), "hi\n");
    const git = gitIn(repo);
    git("init", "-q");
    git("add", "-A");
    git(...identity, "commit", "-q", "-m", "init");
    git("checkout", "-q", "-b", "side");
    writeFileSync(join(repo, "big-from-side.ts"), "// x\n".repeat(900));
    writeFileSync(join(repo, "package.json"), '{"dependencies":{"from-side":"1.0.0"}}\n');
    git("add", "-A");
    git(...identity, "commit", "-q", "-m", "side work");

    // Back on the branch, then merge the side in WITHOUT committing: this is
    // exactly the window a checkpoint runs in.
    git("checkout", "-q", "-");
    writeFileSync(join(repo, "ours.ts"), "// ours\n");
    git("add", "-A");
    git(...identity, "commit", "-q", "-m", "our work");
    git(...identity, "merge", "--no-commit", "--no-ff", "side");

    const bases = readChangeBaseRefs(repo);
    assert.equal(bases.length, 2, "HEAD plus the merge parent");
    assert.equal(bases[0], "HEAD");

    // THE BUG: this file is not in HEAD — the branch tip — yet it is not this
    // session's creation either.
    assert.equal(firstBaseContaining(repo, "big-from-side.ts", ["HEAD"]), undefined, "the pre-fix reading: 'new'");
    assert.equal(isNewInWorktree(repo, "big-from-side.ts", bases), false, "the fix: main authored it, not us");
    assert.equal(isNewInWorktree(repo, "ours.ts", bases), false, "ours is in HEAD");
    // …and the gate still catches what THIS session actually creates: a file
    // neither side of the merge carries.
    writeFileSync(join(repo, "genuinely-new.ts"), "// new\n".repeat(900));
    assert.equal(isNewInWorktree(repo, "genuinely-new.ts", bases), true, "no base has it ⇒ this change creates it");

    // The dependency gate's question — "which base do I compare content
    // against?" — has the same answer, and HEAD wins whenever it has the file.
    assert.equal(firstBaseContaining(repo, "package.json", bases), bases[1], "only the other side has the manifest");
  } finally {
    rmSync(root, { recursive: true, force: true });
    void other;
  }
});

test("an OCTOPUS merge contributes EVERY parent, not just the first", () => {
  // The rule is written over a LIST because a merge can have more than one
  // extra parent. If the reader only ever saw the first one, the second side's
  // files would keep counting as this session's creations — the same deadlock
  // this module exists to remove, just harder to hit.
  const root = mkdtempSync(join(tmpdir(), "rg-baseline-octopus-"));
  try {
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: hermeticGitEnv() });
    const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
    git("init", "-q");
    writeFileSync(join(root, "base.ts"), "base\n");
    git("add", "-A");
    git(...identity, "commit", "-q", "-m", "base");
    for (const name of ["side-a", "side-b"]) {
      git("checkout", "-q", "-b", name);
      writeFileSync(join(root, `${name}.ts`), `${name}\n`);
      git("add", "-A");
      git(...identity, "commit", "-q", "-m", name);
      git("checkout", "-q", "-");
    }
    writeFileSync(join(root, "ours.ts"), "ours\n");
    git("add", "-A");
    git(...identity, "commit", "-q", "-m", "ours");
    git(...identity, "merge", "--no-commit", "--no-ff", "side-a", "side-b");

    const bases = readChangeBaseRefs(root);
    assert.equal(bases.length, 3, "HEAD plus BOTH merge parents");
    for (const name of ["side-a.ts", "side-b.ts"]) {
      assert.equal(isNewInWorktree(root, name, bases), false, `${name} came from another side of the octopus`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no merge in progress ⇒ exactly HEAD, the pre-existing behaviour", () => {
  const root = mkdtempSync(join(tmpdir(), "rg-baseline-single-"));
  try {
    execFileSync("git", ["-C", root, "init", "-q"], { env: hermeticGitEnv() });
    assert.deepEqual(readChangeBaseRefs(root), ["HEAD"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
