// Staged/worktree divergence hook tests. Split out of test/git-hooks.test.ts
// (2026-09-08) so the hook suites run as several files in parallel under
// node --test. Shared hermetic fixtures live in test/helpers/hook-fixtures.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, symlinkSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { ROOT, PRE_COMMIT, makeDir, makeGitRepo, writeState, runPreCommit, readyState, cleanupTempDirs } from "./helpers/hook-fixtures.ts";
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


// ---------------------------------------------------------------------------
// ROUND-8 FINDING (P0): staged gitlink vs reviewed dirty submodule
// ---------------------------------------------------------------------------
// A parent tree stores only a submodule's gitlink, so the index tree and the
// worktree tree are byte-IDENTICAL whenever they agree on that OID — even when
// the submodule checkout holds different, reviewed content. Sequence: the
// submodule advances to commit B, the reviewer approves further uncommitted
// content C, then `git add sm` stages gitlink B. The parent commit publishes B
// while READY bound C, and neither the digest nor the tree comparison moves.
// (The identical-tree fast path also had to go, or this check never ran.)

/** Parent repo with a submodule, plus a READY sidecar bound to the current fp. */
function repoWithSubmodule(mutate: (parent: string, sub: string) => void): string | null {
  const parent = makeGitRepo();
  const sub = makeGitRepo();
  execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: parent, stdio: "ignore" });
  writeFileSync(join(sub, "s.ts"), "A\n");
  execFileSync("git", ["add", "s.ts"], { cwd: sub, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "A"], { cwd: sub, stdio: "ignore" });
  writeFileSync(join(parent, "app.ts"), "base\n");
  execFileSync("git", ["add", "app.ts"], { cwd: parent, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], { cwd: parent, stdio: "ignore" });
  try {
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", sub, "sm"], {
      cwd: parent, stdio: "ignore",
    });
  } catch {
    return null; // environment forbids local-path submodules
  }
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add sm"], { cwd: parent, stdio: "ignore" });
  mutate(parent, join(parent, "sm"));
  const req = createRequire(import.meta.url);
  const { worktreeTreeOid } = req("../scripts/compute-fingerprint.cjs") as {
    worktreeTreeOid: (cwd: string) => string;
  };
  const tree = worktreeTreeOid(parent); // round-8: bindings are commit trees
  mkdirSync(join(parent, ".pi"), { recursive: true });
  writeFileSync(join(parent, ".pi", "review-gate-state.json"), JSON.stringify({
    ...readyState(parent),
    review: { verdict: "READY", fingerprint: tree, at: "t", docSync: "NOT_NEEDED" },
    precommit: { verdict: "PASS", fingerprint: tree, at: "t" },
  }));
  return parent;
}

test("pre-commit blocks a staged gitlink whose submodule checkout is dirty", (t) => {
  const parent = repoWithSubmodule((_p, sm) => {
    // submodule advances to B
    writeFileSync(join(sm, "s.ts"), "B\n");
    execFileSync("git", ["add", "s.ts"], { cwd: sm, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "B"], { cwd: sm, stdio: "ignore" });
    // reviewed content C sits on top, uncommitted
    writeFileSync(join(sm, "s.ts"), "C-reviewed-dirty\n");
  });
  if (parent === null) { t.skip("submodule add unsupported in this environment"); return; }
  execFileSync("git", ["add", "sm"], { cwd: parent, stdio: "ignore" }); // stage gitlink B
  const res = runPreCommit(parent);
  assert.equal(res.status, 1, "staging a gitlink while the submodule is dirty must block");
  assert.match(res.stderr, /sm/);
});

test("pre-commit allows a clean submodule bump (gitlink staged, checkout clean)", (t) => {
  const parent = repoWithSubmodule((_p, sm) => {
    writeFileSync(join(sm, "s.ts"), "B\n");
    execFileSync("git", ["add", "s.ts"], { cwd: sm, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "B"], { cwd: sm, stdio: "ignore" });
  });
  if (parent === null) { t.skip("submodule add unsupported in this environment"); return; }
  execFileSync("git", ["add", "sm"], { cwd: parent, stdio: "ignore" });
  assert.equal(runPreCommit(parent).status, 0, "an ordinary clean submodule bump must not block");
});

test("pre-commit allows a dirty submodule when its gitlink is NOT being committed", (t) => {
  const parent = repoWithSubmodule((_p, sm) => {
    writeFileSync(join(sm, "s.ts"), "dirty but unstaged\n");
  });
  if (parent === null) { t.skip("submodule add unsupported in this environment"); return; }
  assert.equal(
    runPreCommit(parent).status, 0,
    "a dirty submodule whose gitlink is unchanged is the safe analogue of an unstaged edit",
  );
});


// ROUND-9 FINDING (P0): the submodule rule used the submodule's own
// `git status` to decide "is the checkout clean?" — repeating, one level down,
// the mistake already fixed for the parent. `assume-unchanged` /
// `skip-worktree` inside the submodule suppress its status output, so a dirty
// checkout reported clean and the unreviewed gitlink shipped anyway. The rule
// now compares the submodule's worktree TREE against the tree of the staged
// gitlink commit, which reads real content and clears those bits.
for (const bit of ["--assume-unchanged", "--skip-worktree"]) {
  test(`pre-commit blocks a staged gitlink when submodule dirt is hidden by ${bit}`, (t) => {
    const parent = repoWithSubmodule((_p, sm) => {
      writeFileSync(join(sm, "s.ts"), "B\n");
      execFileSync("git", ["add", "s.ts"], { cwd: sm, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "B"], { cwd: sm, stdio: "ignore" });
      execFileSync("git", ["update-index", bit, "s.ts"], { cwd: sm, stdio: "ignore" });
      writeFileSync(join(sm, "s.ts"), "C-reviewed-dirty\n"); // hidden from status
    });
    if (parent === null) { t.skip("submodule add unsupported in this environment"); return; }
    execFileSync("git", ["add", "sm"], { cwd: parent, stdio: "ignore" });
    const res = runPreCommit(parent);
    assert.equal(res.status, 1, `${bit} must not hide a dirty submodule checkout`);
    assert.match(res.stderr, /sm/);
  });
}

// A brand-new repository has no .git/index at all. That is not a failure —
// an empty scratch index is correct — and failing closed there would block a
// legitimate first commit.
test("staged-divergence checker exits 0 on a brand-new repo with no index", () => {
  const dir = makeGitRepo();
  rmSync(join(dir, ".git", "index"), { force: true });
  const res = spawnSync("node", [join(ROOT, "scripts", "check-staged-divergence.cjs"), dir], { encoding: "utf8" });
  assert.equal(res.status, 0, `a missing index must not fail closed: ${res.stderr}`);
});


// ROUND-10 FINDING (P0): a git tree stores only a gitlink per submodule, so an
// OUTER submodule can match its staged commit exactly while a NESTED submodule
// underneath holds different, reviewed-but-unpublished content. The check now
// recurses through every gitlink named by the published tree.
/** parent -> outer -> nested. Returns null if submodules are unsupported. */
function nestedSubmoduleRepo(): { parent: string; outerCk: string; nestedCk: string } | null {
  const commit = (cwd: string, m: string) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", m], { cwd, stdio: "ignore" });
  const addSub = (cwd: string, url: string, name: string) =>
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", url, name], { cwd, stdio: "ignore" });

  const nested = makeGitRepo();
  writeFileSync(join(nested, "i.txt"), "A\n");
  execFileSync("git", ["add", "i.txt"], { cwd: nested, stdio: "ignore" });
  commit(nested, "A");

  const outer = makeGitRepo();
  writeFileSync(join(outer, "o.txt"), "o\n");
  execFileSync("git", ["add", "o.txt"], { cwd: outer, stdio: "ignore" });
  commit(outer, "o");
  try { addSub(outer, nested, "nested"); } catch { return null; }
  commit(outer, "add nested");

  const parent = makeGitRepo();
  execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: parent, stdio: "ignore" });
  writeFileSync(join(parent, "app.ts"), "base\n");
  execFileSync("git", ["add", "app.ts"], { cwd: parent, stdio: "ignore" });
  commit(parent, "init");
  try { addSub(parent, outer, "outer"); } catch { return null; }
  commit(parent, "add outer");
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"], {
    cwd: parent, stdio: "ignore",
  });
  return { parent, outerCk: join(parent, "outer"), nestedCk: join(parent, "outer", "nested") };
}

test("staged-divergence checker blocks dirt in a NESTED submodule under a staged outer gitlink", (t) => {
  const repos = nestedSubmoduleRepo();
  if (repos === null) { t.skip("submodules unsupported in this environment"); return; }
  const { parent, outerCk, nestedCk } = repos;
  // outer advances to B...
  writeFileSync(join(outerCk, "o.txt"), "B\n");
  execFileSync("git", ["add", "o.txt"], { cwd: outerCk, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "B"], { cwd: outerCk, stdio: "ignore" });
  // ...while the NESTED checkout holds reviewed-but-unpublished content
  writeFileSync(join(nestedCk, "i.txt"), "C-reviewed-dirty\n");
  execFileSync("git", ["add", "outer"], { cwd: parent, stdio: "ignore" });

  const res = spawnSync("node", [join(ROOT, "scripts", "check-staged-divergence.cjs"), parent], { encoding: "utf8" });
  assert.equal(res.status, 1, "nested submodule dirt must not slip through an outer gitlink bump");
  assert.match(res.stderr, /outer/);
});

test("staged-divergence checker allows an outer gitlink bump when the nested submodule is clean", (t) => {
  const repos = nestedSubmoduleRepo();
  if (repos === null) { t.skip("submodules unsupported in this environment"); return; }
  const { parent, outerCk } = repos;
  writeFileSync(join(outerCk, "o.txt"), "B\n");
  execFileSync("git", ["add", "o.txt"], { cwd: outerCk, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "B"], { cwd: outerCk, stdio: "ignore" });
  execFileSync("git", ["add", "outer"], { cwd: parent, stdio: "ignore" });

  const res = spawnSync("node", [join(ROOT, "scripts", "check-staged-divergence.cjs"), parent], { encoding: "utf8" });
  assert.equal(res.status, 0, `a clean nested tree must not block: ${res.stderr}`);
});

// ---------------------------------------------------------------------------
// Partial install: the divergence checker is the ONLY guard for
// staged-content-vs-reviewed-worktree (the fingerprint is deliberately
// staging-invariant and cannot see it). Skipping it on "older install"
// grounds would silently re-open that fail-open, so a hook that cannot find
// its checker must fail CLOSED. The L6 label scanner is a style gate and
// keeps the opposite (warn-and-skip) policy on purpose.

/** Install the hook into a private tree, optionally omitting helper scripts. */
function installHookTree(omit: string[]): string {
  const root = makeDir();
  mkdirSync(join(root, "hooks"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "hooks", "pre-commit"), readFileSync(PRE_COMMIT, "utf8"));
  chmodSync(join(root, "hooks", "pre-commit"), 0o755);
  for (const script of ["pre-commit-check.cjs", "compute-fingerprint.cjs", "scan-test-labels.cjs", "check-staged-divergence.cjs"]) {
    if (omit.includes(script)) continue;
    writeFileSync(join(root, "scripts", script), readFileSync(join(ROOT, "scripts", script), "utf8"));
  }
  return join(root, "hooks", "pre-commit");
}

test("MISSING pre-commit checker module → commit fails CLOSED", () => {
  const dir = makeGitRepo();
  writeState(dir, readyState(dir), /*withChangedFile=*/ true);
  const hook = installHookTree(["pre-commit-check.cjs"]);
  const res = spawnSync("bash", [hook], { cwd: dir, encoding: "utf8" });
  assert.notEqual(res.status, 0, "a partial install without the checker must block");
  assert.match(res.stderr, /pre-commit checker MISSING/);
  assert.match(res.stderr, /failing closed/);
});

test("MISSING staged-divergence checker → commit fails CLOSED", () => {
  const dir = makeGitRepo();
  writeState(dir, readyState(dir), /*withChangedFile=*/ true);
  const hook = installHookTree(["check-staged-divergence.cjs"]);
  const res = spawnSync("bash", [hook], { cwd: dir, encoding: "utf8" });
  assert.notEqual(res.status, 0, "a partial install must not be silently tolerated");
  assert.match(res.stderr, /staged-divergence checker MISSING/);
  assert.match(res.stderr, /failing closed/);
});

test("MISSING checker still honors an explicit bypass (escape hatch stays)", () => {
  const dir = makeGitRepo();
  writeState(dir, readyState(dir), /*withChangedFile=*/ true);
  const hook = installHookTree(["check-staged-divergence.cjs"]);
  const res = spawnSync("bash", [hook], {
    cwd: dir, encoding: "utf8", env: { ...process.env, REVIEW_GATE_BYPASS: "1" },
  });
  assert.equal(res.status, 0, "REVIEW_GATE_BYPASS=1 must remain the documented escape hatch");
});

test("MISSING L6 label scanner still only warns (style gate keeps warn-and-skip)", () => {
  const dir = makeGitRepo();
  // A bypassing sidecar isolates this to the scanner-missing branch.
  writeState(dir, { ...readyState(dir), bypass: { active: true, reason: "test", at: "t" } }, true);
  const hook = installHookTree(["scan-test-labels.cjs"]);
  const res = spawnSync("bash", [hook], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0, "a missing style scanner must never brick an older install");
});

test("MIXED install: a LEGACY divergence checker (CLI-on-load) is spawned, not required", () => {
  // A pre-refactor checker has no require.main guard: requiring it would run
  // its whole CLI with argv[2] = the sidecar path. The single-process checker
  // must detect the legacy shape and SPAWN it (like the old bash hook did),
  // so an upgrade in progress never bricks commits.
  const dir = makeGitRepo();
  writeState(dir, { ...readyState(dir), hasCodeChange: false, hasDocChange: false });
  const hook = installHookTree([]); // full tree: check + fingerprint + labels + divergence
  // Replace the divergence checker with a LEGACY-shaped one: no require.main
  // guard, CLI-on-load, stdout-silent (pre --emit-fingerprint), exits 0
  // because the repo is clean.
  const hooksDir = dirname(hook);
  const scriptsDir = join(hooksDir, "..", "scripts");
  writeFileSync(join(scriptsDir, "check-staged-divergence.cjs"),
    "#!/usr/bin/env node\n" +
    "// legacy checker (2026-09-08 fixture): executes on load, no exports\n" +
    "process.exit(0);\n");
  const res = spawnSync("bash", [hook], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0,
    `a legacy divergence checker must be spawned, not required: ${res.stderr}`);
  assert.doesNotMatch(res.stderr, /MISSING/, "the legacy file exists — no fail-closed branch");
});

// The checker takes a cwd argument, and several git commands it uses are
// implicitly cwd-scoped. From a subdirectory `git ls-tree` listed only that
// prefix — i.e. NOTHING — so every comparison found no divergence and the
// checker exited 0 on a repo the same checker rejected from the root. That is
// a silent fail-open, not a cosmetic path issue.
test("staged-divergence checker reports the SAME result from the root and a subdirectory", () => {
  const dir = makeGitRepo();
  writeFileSync(join(dir, "x.ts"), "// v1");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "c"], {
    cwd: dir, stdio: "ignore",
  });
  writeFileSync(join(dir, "x.ts"), "// vA");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" }); // staged A
  writeFileSync(join(dir, "x.ts"), "// vB");                          // worktree B
  mkdirSync(join(dir, "deep", "work"), { recursive: true });

  const checker = join(ROOT, "scripts", "check-staged-divergence.cjs");
  const fromRoot = spawnSync("node", [checker, dir], { encoding: "utf8" });
  const fromSubdir = spawnSync("node", [checker, join(dir, "deep", "work")], { encoding: "utf8" });

  assert.equal(fromRoot.status, 1, "precondition: the divergence must be detected from the root");
  assert.equal(fromSubdir.status, 1,
    "a subdirectory invocation must not miss a divergence the root invocation reports");
});

test("staged-divergence checker agrees from a subdirectory when there is NO divergence", () => {
  // Guard the other direction: the subdir path must not become a blanket
  // "always block" either, which would trivially satisfy the test above.
  const dir = makeGitRepo();
  writeFileSync(join(dir, "x.ts"), "// v1");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "c"], {
    cwd: dir, stdio: "ignore",
  });
  writeFileSync(join(dir, "x.ts"), "// vA");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" }); // index == worktree
  mkdirSync(join(dir, "deep", "work"), { recursive: true });

  const checker = join(ROOT, "scripts", "check-staged-divergence.cjs");
  assert.equal(spawnSync("node", [checker, dir], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("node", [checker, join(dir, "deep", "work")], { encoding: "utf8" }).status, 0);
});

// The entry probe used to collapse EVERY git failure into "not a repository"
// and exit 0. A repo whose config git cannot parse is not "nothing to check" —
// it is a repository the checker could not inspect, and reporting success for
// it contradicts the script's own fail-closed contract.
test("staged-divergence checker FAILS CLOSED when git cannot inspect the repo", () => {
  const dir = makeGitRepo();
  execFileSync("git", ["config", "core.bare", "definitely-not-a-bool"], { cwd: dir, stdio: "ignore" });
  const res = spawnSync("node", [join(ROOT, "scripts", "check-staged-divergence.cjs"), dir], {
    encoding: "utf8",
  });
  assert.equal(res.status, 1, "an uninspectable repository must not report success");
  assert.match(res.stderr, /could not inspect the repository/);
});
