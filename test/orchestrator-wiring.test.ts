/**
 * WHERE THE ORCHESTRATION LAYER TOUCHES THE REAL MACHINE.
 *
 * lib/orchestrator-wiring.ts is the thin shell around git and the filesystem,
 * and two of this round's defects lived exactly there — a worktree created
 * without a branch (R-2) and the shared `.git/hooks` directory an
 * orchestration child hijacked (R-28). Neither is visible to a test that
 * stubs git, so these run against REAL repositories in a temp dir.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { neutraliseHostGitConfig } from "./helpers/git.ts";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";
import { childJudgeRunning, hooksDirFor } from "../lib/orchestrator-wiring.ts";

neutraliseHostGitConfig();
neutraliseGateEnv();

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-orch-wiring-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "hi\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}


// ---------------------------------------------------------------------------
// R-23 — "is a judge round in flight" is a FACT, read from disk
// ---------------------------------------------------------------------------

test("R-23: a judge run without an exit-code counts as in flight; a finished one does not", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rg-judge-live-"));
  dirs.push(cwd);
  const run = join(cwd, ".pi", "judge-sessions", "reviewer-abc", "runs", "2026-08-30T00-00-00-000Z-aaa");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "stdout.log"), "working…\n");

  assert.equal(childJudgeRunning(cwd), true, "no exit-code ⇒ the round is still going");

  writeFileSync(join(run, "exit-code"), "0\n");
  assert.equal(childJudgeRunning(cwd), false, "an exit-code ⇒ it finished");
});

test("R-23: a STALE run directory does not make a child look busy forever", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rg-judge-stale-"));
  dirs.push(cwd);
  const run = join(cwd, ".pi", "judge-sessions", "reviewer-abc", "runs", "old");
  mkdirSync(run, { recursive: true });

  // A run that started "two hours ago" and never wrote an exit code: a crash,
  // not a live judge. Reporting it as busy would make a stopped child
  // permanently invisible to the idle detector.
  const twoHoursLater = Date.now() + 2 * 60 * 60_000;
  assert.equal(childJudgeRunning(cwd, twoHoursLater), false);
  assert.equal(childJudgeRunning(cwd, Date.now()), true);
});

test("a child with no judge sessions at all answers false, and never throws", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rg-judge-none-"));
  dirs.push(cwd);
  assert.equal(childJudgeRunning(cwd), false);
  assert.equal(childJudgeRunning("/nonexistent/path/at/all"), false);
});
