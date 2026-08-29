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
import {
  addWorktree,
  childJudgeRunning,
  gitHooksReferencing,
  hooksDirFor,
  removeWorktree,
  worktreeBranchName,
  worktreeRootFor,
} from "../lib/orchestrator-wiring.ts";

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
// R-2 — a gate-created worktree arrives ON A BRANCH
// ---------------------------------------------------------------------------

test("R-2: a gate-created worktree is on a BRANCH, not a detached HEAD", () => {
  // The measured failure: the worktree was created with `--detach`, so the
  // child's own `setup_workspace` refused ("当前是 detached HEAD，无法确定基准
  // 分支") and the child had to improvise `git checkout -b`. Two children
  // independently invented the same workaround — which is the "the gate
  // provides the tool, the session does not assemble it" rule being broken.
  const repo = makeRepo();
  const created = addWorktree(repo, "t3-module-map-docs");
  assert.ok(created.ok, created.ok ? "" : created.error);
  dirs.push(worktreeRootFor(repo));

  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: created.ok ? created.path : repo,
    encoding: "utf8",
  }).trim();
  assert.notEqual(branch, "HEAD", "a child must not land on a detached HEAD");
  assert.match(branch, /^orch\/t3-module-map-docs-/, "and the branch names the task it was made for");

  if (created.ok) removeWorktree(repo, created.path);
});

test("R-2: two worktrees for the same task never collide on a branch name", () => {
  const first = worktreeBranchName("t1", 1);
  const second = worktreeBranchName("t1", 2);
  assert.notEqual(first, second);
  assert.match(worktreeBranchName("../evil task", 1), /^orch\/[A-Za-z0-9._-]+$/,
    "a hostile task id cannot escape the namespace");
});

// ---------------------------------------------------------------------------
// R-28 — the shared hooks directory
// ---------------------------------------------------------------------------

test("R-28: a hook that points INTO a worktree is DETECTED before that worktree is removed", () => {
  const repo = makeRepo();
  const hooks = hooksDirFor(repo);
  assert.ok(hooks, "the hooks dir is resolved from the COMMON git dir");
  mkdirSync(hooks!, { recursive: true });

  const created = addWorktree(repo, "t2-lane");
  assert.ok(created.ok, created.ok ? "" : created.error);
  const worktree = created.ok ? created.path : "";
  dirs.push(worktreeRootFor(repo));

  // Nothing references it yet.
  assert.deepEqual(gitHooksReferencing(repo, worktree), []);

  // The exact shape the incident left behind: the repository's shared hook
  // exec'ing a script inside a temporary worktree.
  writeFileSync(
    join(hooks!, "commit-msg"),
    `#!/usr/bin/env bash\n# pi-review-gate:installed\nexec "${worktree}/hooks/commit-msg" "$@"\n`,
  );
  writeFileSync(join(hooks!, "pre-commit"), "#!/usr/bin/env bash\nexec /somewhere/else/pre-commit \"$@\"\n");

  assert.deepEqual(gitHooksReferencing(repo, worktree), ["commit-msg"],
    "only the hook that actually points into the doomed directory is named");
  assert.deepEqual(gitHooksReferencing(repo, "/tmp/unrelated"), []);

  if (created.ok) removeWorktree(repo, created.path);
});

test("R-28: removeWorktree refuses any path outside the gate's own scratch root", () => {
  const repo = makeRepo();
  const victim = mkdtempSync(join(tmpdir(), "rg-not-ours-"));
  dirs.push(victim);
  writeFileSync(join(victim, "keep.txt"), "important\n");

  removeWorktree(repo, victim);
  assert.equal(readFileSync(join(victim, "keep.txt"), "utf8"), "important\n",
    "a corrupted registry entry must never point the cleanup at somebody's checkout");
});

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
