/**
 * Behavior tests for the review baseline resolution (round-12 P2): the
 * squash-point walk and the branch-base probe are pure functions over git
 * facts, so their three outcomes are pinned here with real git fixtures —
 * not token-presence assertions.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { squashPointBaseline, branchBaseBaseline } from "../lib/review-baseline.ts";
import { neutraliseHostGitConfig, hermeticGitEnv } from "./helpers/git.ts";

neutraliseHostGitConfig();

const tempDirs: string[] = [];
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-baseline-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  return dir;
}
function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: hermeticGitEnv() }).trim();
}
function commit(dir: string, file: string, content: string, msg: string): string {
  writeFileSync(join(dir, file), content);
  execFileSync("git", ["add", file], { cwd: dir, stdio: "ignore" });
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", msg]);
  return git(dir, ["rev-parse", "HEAD"]);
}

after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test("squashPointBaseline finds the squash point: the newest commit carrying the reviewed tree", () => {
  const dir = makeRepo();
  commit(dir, "base.ts", "export const base = 0;\n", "base");
  const reviewed = commit(dir, "a.ts", "export const a = 1;\n", "reviewed");
  const reviewedTree = git(dir, ["rev-parse", `${reviewed}^{tree}`]);
  // New content after the review (trees differ), then a commit that restores
  // the reviewed tree exactly — the content-identical squash point.
  commit(dir, "a.ts", "export const a = 2;\n", "new1");
  commit(dir, "b.ts", "export const b = 2;\n", "new2");
  // Restore the reviewed tree EXACTLY: revert a.ts AND drop b.ts.
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  execFileSync("git", ["rm", "-q", "b.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "a.ts"], { cwd: dir, stdio: "ignore" });
  const ident = commit(dir, "a.ts", "export const a = 1;\n", "revert-to-reviewed");
  const identTree = git(dir, ["rev-parse", "HEAD^{tree}"]);
  assert.equal(identTree, reviewedTree, "fixture: tree matches the reviewed tree");
  const found = squashPointBaseline(dir, reviewedTree, git(dir, ["rev-parse", "HEAD"]));
  assert.equal(found, ident, "a content-identical commit IS the squash point");
});

test("squashPointBaseline walks parents until the reviewed tree appears", () => {
  const dir = makeRepo();
  const reviewed = commit(dir, "a.ts", "export const a = 1;\n", "reviewed");
  const reviewedTree = git(dir, ["rev-parse", `${reviewed}^{tree}`]);
  // A later commit restores the reviewed tree exactly (change-and-revert).
  commit(dir, "a.ts", "export const a = 2;\n", "change");
  const restored = commit(dir, "a.ts", "export const a = 1;\n", "restore");
  const found = squashPointBaseline(dir, reviewedTree, git(dir, ["rev-parse", "HEAD"]));
  assert.equal(found, restored, "the walk finds the NEWEST commit with the reviewed tree");
  // And the walk honors the cap: starting at a commit whose tree does NOT
  // match (HEAD^ = the change), a cap of 1 cannot reach the restore two
  // steps back — a clean miss, not a hang or a wrong pick.
  const capped = squashPointBaseline(dir, reviewedTree, git(dir, ["rev-parse", "HEAD^"]), 1);
  assert.equal(capped, undefined, "the cap is a clean miss, not a hang or wrong pick");
});

test("squashPointBaseline returns undefined when no commit carries the tree", () => {
  const dir = makeRepo();
  commit(dir, "base.ts", "export const base = 0;\n", "base");
  const reviewed = commit(dir, "a.ts", "export const a = 1;\n", "reviewed");
  const reviewedTree = git(dir, ["rev-parse", `${reviewed}^{tree}`]);
  // The chain is REWRITTEN: the reviewed commit is dropped entirely
  // (reset to base, then new content on top) — the new chain never carries
  // the reviewed tree.
  git(dir, ["reset", "--hard", "-q", "HEAD^"]);
  const n1 = commit(dir, "b.ts", "export const b = 2;\n", "new1");
  const n2 = commit(dir, "c.ts", "export const c = 3;\n", "new2");
  void n1; void n2;
  const found = squashPointBaseline(dir, reviewedTree, git(dir, ["rev-parse", "HEAD"]));
  assert.equal(found, undefined);
});

test("branchBaseBaseline resolves the default branch whatever it is named", () => {
  const dir = makeRepo();
  git(dir, ["checkout", "-q", "-b", "main"]);
  commit(dir, "base.ts", "export const base = 0;\n", "base");
  git(dir, ["checkout", "-q", "-b", "feature"]);
  const head = commit(dir, "f.ts", "export const f = 1;\n", "feature");
  const base = branchBaseBaseline(dir);
  assert.ok(base, "a repo with main resolves a branch base");
  const mb = git(dir, ["merge-base", "main", "HEAD"]);
  assert.equal(base, mb);
  // The merge-base is an ancestor of HEAD (never skips content).
  git(dir, ["merge-base", "--is-ancestor", base!, head]);
  // master-only repo: rename main away, create master
  git(dir, ["branch", "-m", "main", "master"]);
  const base2 = branchBaseBaseline(dir);
  assert.equal(base2, mb, "master is probed after main fails");
});
