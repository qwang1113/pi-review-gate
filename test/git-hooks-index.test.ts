// Hook checker entry/classification and committed-index tests: what counts as
// "nothing to check", ambient-variable isolation, and the index a commit
// actually publishes. Split out of test/git-hooks.test.ts (2026-09-08) so the
// hook suites run as several files in parallel under node --test. Shared
// hermetic fixtures live in test/helpers/hook-fixtures.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ROOT, PRE_COMMIT, makeDir, makeGitRepo, cleanupTempDirs } from "./helpers/hook-fixtures.ts";
import { neutraliseHostGitConfig } from "./helpers/git.ts";

// Process-wide hermetic git (the shared fixtures neutralise too, but the
// hermetic-git guard requires the call to appear in THIS file's code).
neutraliseHostGitConfig();

after(cleanupTempDirs);

// Classifying that failure by matching git's stderr text was wrong in BOTH
// directions: git prints "not a git repository: /missing/path" for a BROKEN
// worktree (a .git gitfile whose target is gone), which would fail open; and a
// localized git prints none of it, which would block ordinary non-repo
// directories. The decision is structural instead — exercise every branch.
// setup() may return a path to probe INSTEAD of the temp dir itself (used for
// the "inside a bare repo" case, which must be probed from a subdirectory).
const DIVERGENCE_ENTRY_CASES: Array<[string, number, (dir: string) => string | void]> = [
  ["plain directory outside any repository", 0, () => { /* nothing */ }],
  ["bare repository (no worktree to compare)", 0,
    (dir) => execFileSync("git", ["init", "--bare"], { cwd: dir, stdio: "ignore" })],
  [".git gitfile pointing at a MISSING gitdir", 1,
    (dir) => writeFileSync(join(dir, ".git"), "gitdir: /definitely/missing/review-gate-gitdir\n")],
  ["malformed .git gitfile", 1,
    (dir) => writeFileSync(join(dir, ".git"), "this is not a gitfile\n")],
  ["repository with a config git cannot parse", 1, (dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "core.bare", "definitely-not-a-bool"], { cwd: dir, stdio: "ignore" });
  }],
  // existsSync() FOLLOWS symlinks, so a dangling .git link read as "no
  // metadata" and dismissed a broken worktree as an ordinary directory.
  ["dangling .git symlink", 1,
    (dir) => symlinkSync(join(dir, "definitely", "missing", "gitdir"), join(dir, ".git"))],
  // The bare shape must be recognised at EVERY level, not just the starting
  // directory: from a subdirectory of a bare repo git cannot inspect, the
  // ancestor walk previously only looked for `.git` and found nothing.
  ["subdirectory of a bare repo git cannot parse", 1, (dir) => {
    execFileSync("git", ["init", "--bare"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "core.bare", "definitely-not-a-bool"], { cwd: dir, stdio: "ignore" });
    const deep = join(dir, "refs", "deep");
    mkdirSync(deep, { recursive: true });
    return deep;
  }],
];

for (const [label, expected, setup] of DIVERGENCE_ENTRY_CASES) {
  test(`staged-divergence entry: ${label} → exit ${expected}`, () => {
    const dir = makeDir();
    const target = setup(dir) || dir;
    const res = spawnSync("node", [join(ROOT, "scripts", "check-staged-divergence.cjs"), target], {
      encoding: "utf8",
    });
    assert.equal(res.status, expected,
      expected === 0
        ? "a verified 'nothing to check' state must not block an ordinary commit"
        : `an uninspectable repository must fail closed (stderr: ${res.stderr.slice(0, 200)})`);
  });
}

test("staged-divergence entry: a NONEXISTENT path fails closed", () => {
  const res = spawnSync("node", [
    join(ROOT, "scripts", "check-staged-divergence.cjs"), join(makeDir(), "no", "such", "dir"),
  ], { encoding: "utf8" });
  assert.equal(res.status, 1, "a path that cannot be inspected at all must not report success");
});

// Ambient git location variables must not redirect the check. Reproduced
// fail-open: with GIT_DIR/GIT_WORK_TREE pointing at a clean decoy repo, the
// checker inspected the DECOY and exited 0 while the target repo held a real
// staged-vs-worktree divergence.
test("staged-divergence checker ignores an ambient GIT_DIR/GIT_WORK_TREE", () => {
  const target = makeGitRepo();
  writeFileSync(join(target, "x.ts"), "// v1");
  execFileSync("git", ["add", "x.ts"], { cwd: target, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "c"], {
    cwd: target, stdio: "ignore",
  });
  writeFileSync(join(target, "x.ts"), "// vA");
  execFileSync("git", ["add", "x.ts"], { cwd: target, stdio: "ignore" }); // staged A
  writeFileSync(join(target, "x.ts"), "// vB");                          // worktree B

  const decoy = makeGitRepo(); // clean

  const checker = join(ROOT, "scripts", "check-staged-divergence.cjs");
  assert.equal(spawnSync("node", [checker, target], { encoding: "utf8" }).status, 1,
    "precondition: the divergence is detected with a normal environment");

  const res = spawnSync("node", [checker, target], {
    encoding: "utf8",
    env: { ...process.env, GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy },
  });
  assert.equal(res.status, 1,
    "an ambient GIT_DIR must not make the checker inspect a different repository");
});

// ---------------------------------------------------------------------------
// The index a commit ACTUALLY publishes.
//
// git stages into a TEMPORARY index for `git commit -a` and `git commit --
// <path>`, and points the hook at it via GIT_INDEX_FILE (measured:
// <gitdir>/index.lock and <gitdir>/next-index-<pid>.lock). Comparing the plain
// .git/index in those cases judges content the commit will not ship — which
// BLOCKED a safe `git commit -a` whose temporary index already equalled the
// reviewed worktree. The hook therefore forwards "${GIT_INDEX_FILE-}" and the
// checker validates that the path belongs to this repository.

/** Repo whose pre-commit forwards to the real checker, like the shipped hook. */
function repoWithForwardingHook(forwardIndex: boolean): string {
  const dir = makeDir();
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  const checker = join(ROOT, "scripts", "check-staged-divergence.cjs");
  writeFileSync(join(dir, ".git", "hooks", "pre-commit"),
    `#!/usr/bin/env bash\nexec node ${checker} "$(pwd)"${forwardIndex ? ' "${GIT_INDEX_FILE-}"' : ""}\n`);
  chmodSync(join(dir, ".git", "hooks", "pre-commit"), 0o755);
  writeFileSync(join(dir, "a.ts"), "// v1");
  execFileSync("git", ["add", "a.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "c1"], { cwd: dir, stdio: "ignore" });
  return dir;
}

/** staged A, worktree B — the state where the commit MODE decides safety. */
function stageAThenEditB(dir: string) {
  writeFileSync(join(dir, "a.ts"), "// vA");
  execFileSync("git", ["add", "a.ts"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "a.ts"), "// vB");
}

test("commit -a is ALLOWED: its temporary index equals the reviewed worktree", () => {
  const dir = repoWithForwardingHook(true);
  stageAThenEditB(dir);
  const res = spawnSync("git", ["commit", "-a", "-m", "commit-all"], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0, `commit -a must not be blocked: ${res.stderr}`);
});

test("a PLAIN commit in the same state is still BLOCKED (it would ship the staged version)", () => {
  const dir = repoWithForwardingHook(true);
  stageAThenEditB(dir);
  const res = spawnSync("git", ["commit", "-m", "plain"], { cwd: dir, encoding: "utf8" });
  assert.notEqual(res.status, 0, "publishing staged content that differs from the worktree must block");
  assert.match(res.stderr, /differs from the reviewed worktree/);
});

test("a path-limited commit of a CLEAN path is ALLOWED while another path diverges", () => {
  const dir = repoWithForwardingHook(true);
  writeFileSync(join(dir, "other.ts"), "// other v1");
  execFileSync("git", ["add", "other.ts"], { cwd: dir, stdio: "ignore" });
  stageAThenEditB(dir);
  const res = spawnSync("git", ["commit", "-m", "only-other", "--", "other.ts"], {
    cwd: dir, encoding: "utf8",
  });
  assert.equal(res.status, 0, `a path-limited commit of a clean path must not be blocked: ${res.stderr}`);
});

test("without the forwarded index those safe commits WOULD be blocked (guards the contract)", () => {
  // Pins why the hook passes the argument at all: the same state fails when the
  // checker is left to guess the plain index.
  const dir = repoWithForwardingHook(false);
  stageAThenEditB(dir);
  const res = spawnSync("git", ["commit", "-a", "-m", "commit-all"], { cwd: dir, encoding: "utf8" });
  assert.notEqual(res.status, 0,
    "if this ever passes, the forwarded-index argument has stopped being load-bearing");
});

test("the shipped hook runs the whole chain in ONE node process (pre-commit-check.cjs)", () => {
  const hook = readFileSync(PRE_COMMIT, "utf8");
  assert.match(hook, /node "\$CHECK_SCRIPT" "\$STATE_FILE"/,
    "the shell must exec the single checker process with the sidecar path");
  // The GIT_INDEX_FILE forwarding (commit -a / commit -- <path> semantics)
  // lives in the checker now — assert the actual argv construction, not a
  // comment or a far-apart coincidence.
  const checker = readFileSync(join(ROOT, "scripts", "pre-commit-check.cjs"), "utf8");
  assert.match(checker, /env\.GIT_INDEX_FILE \|\| "", "--emit-fingerprint"\]/, 
    "the checker must forward git's commit index to the divergence run");
});

test("an index file OUTSIDE the repository is refused (ambient redirection stays impossible)", () => {
  const dir = makeGitRepo();
  writeFileSync(join(dir, "x.ts"), "// v1");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  const foreign = join(makeGitRepo(), ".git", "index");
  const res = spawnSync("node", [join(ROOT, "scripts", "check-staged-divergence.cjs"), dir, foreign], {
    encoding: "utf8",
  });
  assert.equal(res.status, 1, "an index outside this repository must fail closed");
  assert.match(res.stderr, /refusing an index file outside the repository/);
});

test("a forwarded index that is a SYMLINK out of the repository is refused", () => {
  // resolve() only normalizes text, so a symlink planted inside the git dir
  // passed the containment check while copyFileSync followed it out of the
  // repository. Containment is now decided on canonical paths.
  const target = makeGitRepo();
  writeFileSync(join(target, "x.ts"), "// v1");
  execFileSync("git", ["add", "x.ts"], { cwd: target, stdio: "ignore" });
  const decoy = makeGitRepo();
  const planted = join(target, ".git", "forwarded-index");
  symlinkSync(join(decoy, ".git", "index"), planted);

  const res = spawnSync("node", [
    join(ROOT, "scripts", "check-staged-divergence.cjs"), target, planted,
  ], { encoding: "utf8" });
  assert.equal(res.status, 1, "a symlinked foreign index must fail closed");
  assert.match(res.stderr, /refusing an index file outside the repository/);
});

test("a legitimate not-yet-created index path inside the git dir is still accepted", () => {
  // git's temporary indexes (index.lock, next-index-<pid>.lock) may not exist
  // when the checker starts, so containment must canonicalize the nearest
  // EXISTING ancestor rather than requiring the file itself.
  const dir = makeGitRepo();
  writeFileSync(join(dir, "x.ts"), "// v1");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  const future = join(dir, ".git", "next-index-99999.lock");
  const res = spawnSync("node", [
    join(ROOT, "scripts", "check-staged-divergence.cjs"), dir, future,
  ], { encoding: "utf8" });
  assert.ok(!/refusing an index file/.test(res.stderr),
    `a path inside the git dir must be accepted even before git creates it: ${res.stderr}`);
});
