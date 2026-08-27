import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { hermeticGitEnv } from "./helpers/git.ts";

const { gitRootOfDir, resolveShipRepos, resolveToolRepoTarget } = await import(
  join(resolve(import.meta.dirname ?? "."), "..", "lib", "repo-resolve.ts")
);

// ---- fixture helpers -------------------------------------------------------

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: hermeticGitEnv() }).trim();
}

/** Create a throwaway git repo under one shared temp parent (so repos are
 *  siblings and `cd ..` chains work). Each repo gets one commit. */
const multiParent = mkdtempSync(join(tmpdir(), "rg-multi-"));
const roots = new Map<string, string>();
function makeRepo(name: string): string {
  const root = join(multiParent, name);
  git(multiParent, "init", "-b", "main", name);
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Gate Test");
  writeFileSync(join(root, "file.ts"), "export const a = 1;\n");
  git(root, "add", "file.ts");
  git(root, "commit", "-m", "init");
  // Canonicalize: git reports /private/var/... where mkdtemp returned /var/...
  const canonical = realpathSync(root);
  roots.set(canonical, realpathSync(multiParent));
  return canonical;
}
const repoA = makeRepo("repoA");
const repoB = makeRepo("repoB");

after(() => {
  for (const parent of new Set(roots.values())) {
    try { rmSync(parent, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ---- gitRootOfDir ----------------------------------------------------------

test("gitRootOfDir resolves a repo root from a subdirectory", () => {
  mkdirSync(join(repoA, "sub", "deep"), { recursive: true });
  assert.equal(gitRootOfDir(repoA), repoA);
  assert.equal(gitRootOfDir(join(repoA, "sub", "deep")), repoA);
});

test("gitRootOfDir returns null outside a repository", () => {
  const bare = mkdtempSync(join(tmpdir(), "rg-bare-"));
  try { assert.equal(gitRootOfDir(bare), null); } finally {
    try { rmSync(bare, { recursive: true, force: true }); } catch { /* */ }
  }
});

// ---- resolveShipRepos: cd chains -------------------------------------------

test("cd into a repo then git commit resolves that repo", () => {
  const { repos, ambiguous } = resolveShipRepos(`cd ${repoB} && git commit -m "x"`, repoA);
  assert.deepEqual(repos, [repoB]);
  assert.equal(ambiguous, false);
});

test("relative cd chain resolves against the previous dir", () => {
  // repoA and repoB are siblings under the same temp parent.
  const parent = join(repoA, "..");
  const { repos } = resolveShipRepos(`cd ${parent} && cd repoB && git push`, repoA);
  assert.deepEqual(repos, [repoB]);
});

test("git commit without any cd stays on the session cwd", () => {
  const { repos, ambiguous } = resolveShipRepos("git commit -am x", repoA);
  assert.deepEqual(repos, [repoA]);
  assert.equal(ambiguous, false);
});

test("cd .. is resolved as a relative path", () => {
  const sub = join(repoA, "sub");
  mkdirSync(sub, { recursive: true });
  const { repos } = resolveShipRepos(`cd ../.. && cd repoB && git commit -m x`, sub);
  assert.deepEqual(repos, [repoB]);
});

// ---- resolveShipRepos: git -C / --git-dir ----------------------------------

test("git -C overrides the cd chain", () => {
  const { repos } = resolveShipRepos(`cd ${repoA} && git -C ${repoB} commit -m x`, repoA);
  assert.deepEqual(repos, [repoB]);
});

test("git --git-dir= points at the repo", () => {
  const { repos } = resolveShipRepos(`git --git-dir=${join(repoB, ".git")} commit -m x`, repoA);
  assert.deepEqual(repos, [repoB]);
});

test("wrapper prefix does not break -C extraction", () => {
  const { repos } = resolveShipRepos(`sudo git -C ${repoB} push`, repoA);
  assert.deepEqual(repos, [repoB]);
});

test("GIT_DIR= env assignment resolves to the repo root", () => {
  const { repos } = resolveShipRepos(`GIT_DIR=${join(repoB, ".git")} git commit -m x`, repoA);
  assert.deepEqual(repos, [repoB]);
});

// ---- resolveShipRepos: multi-repo compound commands ------------------------

test("two ship segments in different repos resolve both", () => {
  const { repos, ambiguous } = resolveShipRepos(
    `cd ${repoA} && git commit -m a && cd ${repoB} && git push`,
    repoA,
  );
  assert.deepEqual(repos, [repoA, repoB]);
  assert.equal(ambiguous, false);
});

// ---- resolveShipRepos: ambiguous constructs --------------------------------

test("cd with a variable is ambiguous", () => {
  const { repos, ambiguous } = resolveShipRepos(`cd $DIR && git commit -m x`, repoA);
  assert.equal(ambiguous, true);
  assert.deepEqual(repos, [repoA]); // falls back to cwd
});

test("git -C with a variable is ambiguous", () => {
  const { repos, ambiguous } = resolveShipRepos(`git -C $DIR commit -m x`, repoA);
  assert.equal(ambiguous, true);
});

test("bare cd and cd - are ambiguous", () => {
  assert.equal(resolveShipRepos(`cd && git commit -m x`, repoA).ambiguous, true);
  assert.equal(resolveShipRepos(`cd - && git push`, repoA).ambiguous, true);
  assert.equal(resolveShipRepos(`cd ~ && git push`, repoA).ambiguous, true);
});

test("cd ~/x is ambiguous (NOT parsed as a literal <cwd>/~/x dir)", () => {
  const { repos, ambiguous } = resolveShipRepos(`cd ~/frontend && git commit -m x`, repoA);
  assert.equal(ambiguous, true, "cd ~/x must be ambiguous");
  assert.deepEqual(repos, [repoA]);
});

test("quoted path with spaces is ambiguous (not truncated)", () => {
  const { ambiguous } = resolveShipRepos(`cd \"/tmp/my repo\" && git commit -m x`, repoA);
  assert.equal(ambiguous, true, "space-mangled quoted cd must be ambiguous");
});

test("pushd/popd are ambiguous (not silently resolved to cwd)", () => {
  assert.equal(resolveShipRepos(`pushd /tmp && git commit -m x`, repoA).ambiguous, true);
  assert.equal(resolveShipRepos(`popd && git push`, repoA).ambiguous, true);
});

test("nested sh -c with an inner cd is ambiguous", () => {
  const { ambiguous } = resolveShipRepos(`bash -c \"cd ${repoB} && git commit -m x\"`, repoA);
  assert.equal(ambiguous, true, "nested-shell cd must be ambiguous");
});

test("cd into a NON-EXISTENT directory is ambiguous (mis-parse fail-closed)", () => {
  const { ambiguous } = resolveShipRepos(`cd /tmp/rg-does-not-exist-xyz && git commit -m x`, repoA);
  assert.equal(ambiguous, true);
});

test("cd with substitution is ambiguous", () => {
  assert.equal(resolveShipRepos(`cd /tmp$(mktemp -u -d) && git commit -m x`, repoA).ambiguous, true);
});

// ---- resolveShipRepos: git global value options ----------------------------

test("git -c k=v before -C does not hide the -C (value options consumed)", () => {
  const { repos } = resolveShipRepos(`git -c user.name=x -C ${repoB} commit -m x`, repoA);
  assert.deepEqual(repos, [repoB]);
});

test("git --work-tree is AMBIGUOUS (it does not relocate the git-dir; the cwd repo is the one committed)", () => {
  // Real git: `git --work-tree=/b commit` run in a commits A's staged index
  // into A's history — only the work-tree files change. Treating it as a
  // relocation would check the wrong repo (round-2 P1, verified with git).
  const { ambiguous } = resolveShipRepos(`git --work-tree=${repoB} commit -m x`, repoA);
  assert.equal(ambiguous, true);
  const { ambiguous: eq } = resolveShipRepos(`git --work-tree=${repoB} commit -m x`, repoA);
  assert.equal(eq, true);
});

test("git -C accumulates (second -C resolves relative to the first)", () => {
  const { repos } = resolveShipRepos(`git -C ${repoB} -C .. commit -m x`, join(repoA, "sub"));
  // repoB/.. is the shared temp parent, NOT a repo — resolve to the parent dir.
  assert.equal(repos.length, 1);
  assert.notEqual(repos[0], repoA);
});

test("env GIT_DIR=… wrapper is ambiguous (not silently resolved to cwd)", () => {
  const { ambiguous } = resolveShipRepos(`env GIT_DIR=${join(repoB, ".git")} git commit -m x`, repoA);
  assert.equal(ambiguous, true, "env GIT_DIR must be ambiguous");
  const { ambiguous: s } = resolveShipRepos(`sudo -u me env GIT_DIR=${join(repoB, ".git")} git commit -m x`, repoA);
  assert.equal(s, true);
});

test("env -C / --chdir is ambiguous (relocates the working dir)", () => {
  assert.equal(resolveShipRepos(`env -C ${repoB} git commit -m x`, repoA).ambiguous, true);
  assert.equal(resolveShipRepos(`env --chdir ${repoB} git commit -m x`, repoA).ambiguous, true);
});

test("GIT_DIR with a stripped substitution value is ambiguous", () => {
  // segments() strips the backtick body, leaving `GIT_DIR= git commit` — the
  // value is unknowable, so it must not silently resolve to cwd.
  const { ambiguous } = resolveShipRepos("GIT_DIR=`echo /x/.git` git commit -m x", repoA);
  assert.equal(ambiguous, true);
});

test("subshell cd is ambiguous (the cd leaks out of the tracked chain)", () => {
  const { ambiguous } = resolveShipRepos(`(cd ${repoB}); git push`, repoA);
  assert.equal(ambiguous, true);
});

// ---- resolveShipRepos: non-repo fallback -----------------------------------

test("ship segment in a non-repo directory resolves to the bare dir (fail-closed fingerprint)", () => {
  const bare = mkdtempSync(join(tmpdir(), "rg-norepo-"));
  try {
    const { repos } = resolveShipRepos(`cd ${bare} && git commit -m x`, repoA);
    assert.deepEqual(repos, [bare]);
  } finally {
    try { rmSync(bare, { recursive: true, force: true }); } catch { /* */ }
  }
});

// ---- resolveShipRepos: gh pr -----------------------------------------------

test("gh pr create in a cd'd repo resolves that repo", () => {
  const { repos } = resolveShipRepos(`cd ${repoB} && gh pr create --title "x"`, repoA);
  assert.deepEqual(repos, [repoB]);
});

// ---- resolveToolRepoTarget: which repo a verdict is recorded against -------
//
// The multi-repo deadlock these tests guard: record_review/run_precommit used
// to write to whichever repo was edited LAST, and only an edit could move that
// target. A session that edited repoB last could never record a verdict for
// repoA again — repoA's commit stayed blocked no matter how many review rounds
// ran, which reads exactly like the gate randomly resetting itself.

const toolTargetDefaults = {
  primaryRepo: repoA,
  resolveAbsolute: (p: string) => resolve(repoA, p),
  resolveRoot: (dir: string) => gitRootOfDir(dir) ?? null,
};

test("tool repo target: a single-repo session still needs no explicit repo", () => {
  const r = resolveToolRepoTarget({
    ...toolTargetDefaults, sessionRepos: [repoA], activeRepo: repoA,
  });
  assert.deepEqual(r, { ok: true, root: repoA });
});

test("tool repo target: an explicit repo overrides the last-edited default", () => {
  const r = resolveToolRepoTarget({
    ...toolTargetDefaults, sessionRepos: [repoA, repoB], activeRepo: repoB, requested: repoA,
  });
  assert.deepEqual(r, { ok: true, root: repoA }, "this is the deadlock escape hatch");
});

test("tool repo target: a subdirectory normalizes to the repo root", () => {
  const sub = join(repoB, "src", "deep");
  mkdirSync(sub, { recursive: true });
  const r = resolveToolRepoTarget({
    ...toolTargetDefaults, sessionRepos: [repoA, repoB], activeRepo: repoA, requested: sub,
  });
  // Anything but the canonical root would mint a SECOND gate state for one
  // repo — one of them could hold READY while the ship check reads the other.
  assert.deepEqual(r, { ok: true, root: repoB });
});

test("tool repo target: a relative repo path resolves against the session cwd", () => {
  const r = resolveToolRepoTarget({
    ...toolTargetDefaults, sessionRepos: [repoA, repoB], activeRepo: repoA,
    requested: join("..", "repoB"),
  });
  assert.deepEqual(r, { ok: true, root: repoB });
});

test("tool repo target: several repos and no explicit repo is an error, not a guess", () => {
  const r = resolveToolRepoTarget({
    ...toolTargetDefaults, sessionRepos: [repoA, repoB], activeRepo: repoB,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /more than one repository/);
  assert.match(r.error, /session repo/, "the candidate list must identify the session repo");
  assert.match(r.error, /last edited/, "...and which one was edited last");
  assert.ok(r.error.includes(repoA) && r.error.includes(repoB), "both candidates must be listed");
});

test("tool repo target: blank/whitespace repo counts as omitted", () => {
  const r = resolveToolRepoTarget({
    ...toolTargetDefaults, sessionRepos: [repoA, repoB], activeRepo: repoB, requested: "   ",
  });
  assert.equal(r.ok, false, "an empty string must not silently pick the last-edited repo");
});

test("tool repo target: a repo this session never edited is rejected", () => {
  const r = resolveToolRepoTarget({
    ...toolTargetDefaults, sessionRepos: [repoA], activeRepo: repoA, requested: repoB,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /not one of the repositories this session has edited/);
});

test("tool repo target: a path outside any git repo is rejected", () => {
  const bare = mkdtempSync(join(tmpdir(), "rg-tool-norepo-"));
  try {
    const r = resolveToolRepoTarget({
      ...toolTargetDefaults, sessionRepos: [repoA, repoB], activeRepo: repoA, requested: bare,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /not inside a readable git repository/);
  } finally {
    try { rmSync(bare, { recursive: true, force: true }); } catch { /* */ }
  }
});

test("tool repo target: a tracked non-git primary is still targetable", () => {
  // When the session cwd is not inside a repository, primaryRepoRoot IS that
  // plain directory. Requiring git to recognize it would make its verdict
  // unrecordable as soon as a second repo is edited: omitting `repo` is
  // ambiguous, and passing it would fail resolution.
  const bare = mkdtempSync(join(tmpdir(), "rg-tool-bare-"));
  try {
    const r = resolveToolRepoTarget({
      ...toolTargetDefaults, primaryRepo: bare, sessionRepos: [bare, repoB], activeRepo: repoB,
      resolveAbsolute: (p: string) => resolve(bare, p), requested: bare,
    });
    assert.deepEqual(r, { ok: true, root: bare });
  } finally {
    try { rmSync(bare, { recursive: true, force: true }); } catch { /* */ }
  }
});
