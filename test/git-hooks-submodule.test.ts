// Staged-gitlink / submodule divergence regressions (ROUND-8/9/10 findings).
// Split out of git-hooks-divergence.test.ts (2026-09-08) so the hook suites
// run as several files in parallel under node --test. Shared hermetic
// fixtures live in test/helpers/hook-fixtures.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ROOT, makeGitRepo, runPreCommit, readyState, cleanupTempDirs } from "./helpers/hook-fixtures.ts";
import { neutraliseHostGitConfig } from "./helpers/git.ts";

// Process-wide hermetic git (the shared fixtures neutralise too, but the
// hermetic-git guard requires the call to appear in THIS file's code).
neutraliseHostGitConfig();

after(cleanupTempDirs);

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
