// Staged/worktree divergence hook tests. Split out of test/git-hooks.test.ts
// (2026-09-08) so the hook suites run as several files in parallel under
// node --test; submodule/gitlink regressions moved to
// git-hooks-submodule.test.ts, partial/mixed-install to
// git-hooks-partial-install.test.ts. Shared hermetic fixtures live in
// test/helpers/hook-fixtures.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, chmodSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ROOT, makeDir, makeGitRepo, writeState, runPreCommit, readyState, cleanupTempDirs } from "./helpers/hook-fixtures.ts";
import { neutraliseHostGitConfig } from "./helpers/git.ts";

// Process-wide hermetic git (the shared fixtures neutralise too, but the
// hermetic-git guard requires the call to appear in THIS file's code).
neutraliseHostGitConfig();

after(cleanupTempDirs);

// ---------------------------------------------------------------------------
// Staged/worktree divergence (P0, found by independent review)
// ---------------------------------------------------------------------------
// The fingerprint is deliberately WORKTREE-based and staging-invariant, so
// `git add` cannot invalidate a review. That leaves one gap the digest cannot
// close: `git commit` (without -a) ships the INDEX. If a path is staged with
// content A while the worktree holds the reviewed content B, the commit ships
// A even though the gate bound B — and the digest never moves. The hook must
// reject exactly that, without over-blocking the safe cases.

/** Repo with a READY sidecar bound to its CURRENT fingerprint. */
function repoBoundToCurrentFingerprint(mutate: (dir: string) => void): string {
  const dir = makeGitRepo();
  execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "x.ts"), "BASE\n");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "base"], {
    cwd: dir, stdio: "ignore",
  });
  mutate(dir);
  const fp = JSON.parse(
    execFileSync("node", [join(ROOT, "scripts", "compute-fingerprint.cjs"), dir], { encoding: "utf8" }),
  );
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), JSON.stringify({
    ...readyState(dir),
    review: { verdict: "READY", fingerprint: fp.digest, at: "t", docSync: "NOT_NEEDED" },
    precommit: { verdict: "PASS", fingerprint: fp.digest, at: "t" },
  }));
  return dir;
}

test("pre-commit blocks a path staged with content differing from the reviewed worktree", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "x.ts"), "STAGED-UNREVIEWED\n");
    execFileSync("git", ["add", "x.ts"], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, "x.ts"), "WORKTREE-REVIEWED\n"); // the reviewed version
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "a divergent staged path must block the commit");
  assert.match(res.stderr, /staged with content that differs/);
  assert.match(res.stderr, /x\.ts/);
});

test("pre-commit allows a fully staged edit (index == worktree)", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "x.ts"), "EDITED\n");
    execFileSync("git", ["add", "x.ts"], { cwd: d, stdio: "ignore" });
  });
  assert.equal(runPreCommit(dir).status, 0, "staging the reviewed content must not block");
});

test("pre-commit allows an unstaged edit (that content is not committed)", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "x.ts"), "EDITED-NOT-STAGED\n");
  });
  assert.equal(runPreCommit(dir).status, 0, "a merely dirty worktree must not block");
});

test("pre-commit allows staged and dirty paths that do not overlap", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "a.ts"), "new file\n");
    execFileSync("git", ["add", "a.ts"], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, "x.ts"), "dirty other path\n");
  });
  assert.equal(runPreCommit(dir).status, 0, "divergence must be judged per path, not globally");
});


// ROUND-5 FINDING: `git diff --name-only` does NOT list untracked files, so a
// staged DELETE whose path is then recreated in the worktree looked clean to
// the old shell-pipeline check. The commit would delete a file the review had
// just approved, with the fingerprint unchanged. Same class: a staged RENAME
// whose source path is recreated.
test("pre-commit blocks a staged delete whose path was recreated in the worktree", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    execFileSync("git", ["rm", "x.ts"], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, "x.ts"), "WORKTREE-REVIEWED\n"); // recreated, untracked
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "staged delete + worktree recreate must block");
  assert.match(res.stderr, /staged with content that differs/);
  assert.match(res.stderr, /x\.ts/);
});

test("pre-commit blocks a staged rename whose source path was recreated", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    execFileSync("git", ["mv", "x.ts", "y.ts"], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, "x.ts"), "recreated source\n");
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "staged rename + recreated source must block");
  assert.match(res.stderr, /x\.ts/);
});

test("pre-commit allows a staged delete when the file really is gone", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    execFileSync("git", ["rm", "x.ts"], { cwd: d, stdio: "ignore" });
  });
  assert.equal(runPreCommit(dir).status, 0, "a staged delete matching the worktree is safe");
});

test("pre-commit allows a clean staged rename", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    execFileSync("git", ["mv", "x.ts", "y.ts"], { cwd: d, stdio: "ignore" });
  });
  assert.equal(runPreCommit(dir).status, 0, "a rename with no recreated source is safe");
});

test("pre-commit handles paths with spaces and non-ASCII names (NUL-safe)", () => {
  const weird = "a file with spaces \u4e2d\u6587.ts";
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, weird), "STAGED\n");
    execFileSync("git", ["add", "--", weird], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, weird), "WORKTREE\n"); // diverge
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "divergence must be detected for awkward path names");
  assert.match(res.stderr, /a file with spaces/);
});


// ROUND-6 FINDING (P0): `assume-unchanged` tells git to stop reporting a
// path's worktree changes, so a status-based divergence check silently passed
// a staged blob that differed from the reviewed worktree. The checker now
// compares TREE CONTENT and clears the cache bits in its scratch index, so the
// suppression cannot hide anything.
test("pre-commit blocks divergence hidden by assume-unchanged", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "x.ts"), "STAGED-UNREVIEWED\n");
    execFileSync("git", ["add", "x.ts"], { cwd: d, stdio: "ignore" });
    execFileSync("git", ["update-index", "--assume-unchanged", "x.ts"], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, "x.ts"), "WORKTREE-REVIEWED\n");
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "assume-unchanged must not hide staged/worktree divergence");
  assert.match(res.stderr, /x\.ts/);
});

test("pre-commit blocks divergence hidden by skip-worktree", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "x.ts"), "STAGED-UNREVIEWED\n");
    execFileSync("git", ["add", "x.ts"], { cwd: d, stdio: "ignore" });
    execFileSync("git", ["update-index", "--skip-worktree", "x.ts"], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, "x.ts"), "WORKTREE-REVIEWED\n");
  });
  assert.equal(runPreCommit(dir).status, 1, "skip-worktree must not hide staged/worktree divergence");
});

// ROUND-6 FINDING (P0): the checker used to exit 0 on ANY git error, so a
// broken repo could silently disable it while the fingerprint stayed bindable.
// An installed-but-broken safety check must fail CLOSED.
//
// NOTE: this deliberately uses a CORRUPT INDEX rather than a bad
// `status.showUntrackedFiles` config. The original reproduction relied on the
// checker shelling out to `git status`; the rewrite compares trees and never
// calls it, so that config no longer fails anything — a version of this test
// written against it passed for the wrong reason (real divergence blocked it,
// not the error path). Mutation testing caught that, hence the corrupt index,
// which genuinely makes the checker's own git calls fail with NO divergence
// otherwise present.
test("staged-divergence checker fails closed when it cannot run", () => {
  const dir = makeGitRepo();
  writeFileSync(join(dir, "x.ts"), "BASE\n");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "base"], {
    cwd: dir, stdio: "ignore",
  });
  // No divergence exists; the only reason to exit non-zero is the failure path.
  writeFileSync(join(dir, ".git", "index"), "GARBAGE-NOT-AN-INDEX");
  const res = spawnSync("node", [join(ROOT, "scripts", "check-staged-divergence.cjs"), dir], { encoding: "utf8" });
  assert.equal(res.status, 1, "an unusable git state must fail closed, not report success");
  assert.match(res.stderr, /Failing closed/);
});

// README claims NUL-safety, which only a literal newline really exercises.
test("pre-commit detects divergence for a path containing a literal newline", () => {
  const weird = "weird\nname.ts";
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, weird), "STAGED\n");
    execFileSync("git", ["add", "--", weird], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, weird), "WORKTREE\n");
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "a newline in a path must not break the NUL-delimited parsing");
  assert.match(res.stderr, /weird/);
});

// A non-git directory is not a check failure — there is nothing to check and
// nothing can be committed from it. It must not fail closed (that would brick
// the "no changes tracked" path).
test("staged-divergence checker exits 0 outside a git repository", () => {
  const dir = makeDir();
  const res = spawnSync("node", [join(ROOT, "scripts", "check-staged-divergence.cjs"), dir], { encoding: "utf8" });
  assert.equal(res.status, 0, "a non-git directory must not be treated as a check failure");
});


// ROUND-7 FINDING (P0): the checker compared only blob OIDs
// (`rev-parse <tree>:<path>`), but a git tree entry's identity is
// <mode, type, oid, path>. A staged executable bit, or a symlink<->regular-file
// type change whose object content happens to match, produced a DIFFERENT
// committable tree while the OIDs compared equal — so it shipped unreviewed
// tree metadata. The checker now compares full `ls-tree` entries.
test("pre-commit blocks a staged mode change with an identical blob", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "s.sh"), "same\n");
    execFileSync("git", ["add", "s.sh"], { cwd: d, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add script"], {
      cwd: d, stdio: "ignore",
    });
    chmodSync(join(d, "s.sh"), 0o755);
    execFileSync("git", ["add", "s.sh"], { cwd: d, stdio: "ignore" }); // stage 100755
    chmodSync(join(d, "s.sh"), 0o644);                                 // worktree 100644
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "a staged exec-bit change must block even when the blob is identical");
  assert.match(res.stderr, /s\.sh/);
});

test("pre-commit blocks a staged symlink whose worktree copy is a regular file", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    symlinkSync("target", join(d, "p"));
    execFileSync("git", ["add", "p"], { cwd: d, stdio: "ignore" }); // stage 120000
    unlinkSync(join(d, "p"));
    writeFileSync(join(d, "p"), "target");                          // worktree 100644, same bytes
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "a staged type change must block even when the object content matches");
  assert.match(res.stderr, /p/);
});

test("pre-commit allows a mode change that is staged and matches the worktree", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "ok.sh"), "same\n");
    execFileSync("git", ["add", "ok.sh"], { cwd: d, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add"], {
      cwd: d, stdio: "ignore",
    });
    chmodSync(join(d, "ok.sh"), 0o755);
    execFileSync("git", ["add", "ok.sh"], { cwd: d, stdio: "ignore" }); // index and worktree agree
  });
  assert.equal(runPreCommit(dir).status, 0, "an exec-bit change staged to match the worktree is safe");
});
