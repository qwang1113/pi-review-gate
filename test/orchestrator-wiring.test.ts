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
import { childJudgeRunning, hooksDirFor, runTmux } from "../lib/orchestrator-wiring.ts";

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

/**
 * THE RUNNER IS THE SECOND DOOR, AND IT IS OPENED BY A DECLARATION
 * (2026-09-25).
 *
 * `runTmux` re-validates every argv on its way out, so the gate's own session
 * commands must arrive WITH the declaration naming the sessions they may
 * address — otherwise they are refused here even though the builder that made
 * them checked the scope a moment earlier. That is what the guard parameter is
 * for, and this is the test that says so. NOTHING HERE RUNS TMUX: every case is
 * either refused by the guard (no process spawns) or measured by the DIFFERENT
 * message a real tmux would produce — a test that killed a session on the user's
 * server would be the defect it is meant to prevent (quality round P1: this test
 * used to do exactly that).
 */
test("runTmux: the four session commands need the caller's declaration", () => {
  const session = "rg-repo-abcdef1234";
  const blind = runTmux(["kill-session", "-t", session], undefined, { ownSessions: [] });
  assert.equal(blind.ok, false);
  assert.match(blind.stderr, /ownSessions/, "no declaration ⇒ refused before tmux ever runs");

  // A kill aimed at anything but a declared session never reaches tmux.
  const elsewhere = runTmux(["kill-session", "-t", "my-work"], undefined, { ownSessions: [session] });
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.stderr, /目标必须是本会话自己的 session 之一/);
  // A leading global flag cannot hide the subcommand either.
  const flagged = runTmux(["-L", "some-socket", "kill-server"], undefined, { ownSessions: [session] });
  assert.equal(flagged.ok, false);
  assert.match(flagged.stderr, /必须以子命令开头/);
  // And `kill-server` is refused whatever is declared.
  const server = runTmux(["kill-server"], undefined, { ownSessions: [session] });
  assert.equal(server.ok, false);
  assert.match(server.stderr, /任何情况都禁止/);
});
