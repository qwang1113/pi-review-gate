import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { assembleGitMemory, buildGitMemory, GIT_MEMORY_MAX_LINES } from "../lib/git-memory.ts";
import { hermeticGitEnv } from "./helpers/git.ts";

const tempDirs: string[] = [];
function makeTemp(): string {
  const d = mkdtempSync(join(tmpdir(), "rg-gitmem-"));
  tempDirs.push(d);
  return d;
}
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", env: hermeticGitEnv() });
}

function makeRepo(): string {
  const d = makeTemp();
  git(d, "init", "-q");
  git(d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "initial commit");
  return d;
}

test("non-git dir → empty string (never throws)", () => {
  assert.equal(buildGitMemory(makeTemp()), "");
});

test("repo with commits and dirty tree → [GIT_CONTEXT] with sections", () => {
  const d = makeRepo();
  writeFileSync(join(d, "a.ts"), "export {};\n");
  const out = buildGitMemory(d);
  assert.ok(out.startsWith("[GIT_CONTEXT]"));
  assert.match(out, /Recent commits:/);
  assert.match(out, /initial commit/);
  assert.match(out, /Working tree:/);
  assert.match(out, /a\.ts/);
});

test("secret-pattern lines are filtered out", () => {
  const d = makeRepo();
  writeFileSync(join(d, ".env.production"), "SECRET=1\n");
  writeFileSync(join(d, "server.pem"), "x\n");
  writeFileSync(join(d, "credentials"), "x\n");
  writeFileSync(join(d, "normal.ts"), "export {};\n");
  const out = buildGitMemory(d);
  assert.ok(!out.includes(".env.production"), "env file must be filtered");
  assert.ok(!out.includes("server.pem"), "pem file must be filtered");
  assert.ok(!out.includes("credentials"), "credentials must be filtered");
  assert.ok(out.includes("normal.ts"), "normal file stays");
});

test("secret-pattern commit messages are filtered out", () => {
  const d = makeRepo();
  git(d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "add API token rotation");
  const out = buildGitMemory(d);
  assert.ok(!out.includes("token rotation"), "commit message containing 'token' must be filtered");
  assert.ok(out.includes("initial commit"));
});

test("TOTAL output (header included) is hard-capped at GIT_MEMORY_MAX_LINES", () => {
  const d = makeRepo();
  for (let i = 0; i < 60; i++) writeFileSync(join(d, `f${i}.ts`), "export {};\n");
  const out = buildGitMemory(d);
  assert.ok(out.split("\n").length <= GIT_MEMORY_MAX_LINES, "must respect the total line cap");
});

// Reviewer P2: the git-backed test can't reach the boundary (each git source is
// pre-capped at 10/15/15), so exercise the pure assembler directly at 40+ lines.
test("assembleGitMemory: header counts toward the cap; line 41 is dropped", () => {
  const many = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`);
  const out = assembleGitMemory(many(20, "c"), many(20, "d"), many(20, "s"));
  const lines = out.split("\n");
  assert.equal(lines.length, GIT_MEMORY_MAX_LINES, "exactly the cap, header included");
  assert.equal(lines[0], "[GIT_CONTEXT]");
  // 1 header + 1 section title + 20 commits + 1 title + 17 diff lines = 40.
  assert.equal(lines[GIT_MEMORY_MAX_LINES - 1], "d16", "content past the cap must be dropped");
  assert.ok(!out.includes("s0"), "third section entirely beyond the cap");
});

test("assembleGitMemory: empty sections → empty string", () => {
  assert.equal(assembleGitMemory([], [], []), "");
});
