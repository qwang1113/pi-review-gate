// Partial-install and mixed-install hook tests: which checker files may be
// missing without bricking commits, which must fail closed, and how a LEGACY
// (pre-single-process) divergence checker is still executed. Split out of
// git-hooks-divergence.test.ts (2026-09-08) so the hook suites run as several
// files in parallel under node --test. Shared hermetic fixtures live in
// test/helpers/hook-fixtures.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { ROOT, PRE_COMMIT, makeDir, makeGitRepo, writeState, readyState, cleanupTempDirs } from "./helpers/hook-fixtures.ts";
import { neutraliseHostGitConfig } from "./helpers/git.ts";

// Process-wide hermetic git (the shared fixtures neutralise too, but the
// hermetic-git guard requires the call to appear in THIS file's code).
neutraliseHostGitConfig();

after(cleanupTempDirs);

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
  // guard, CLI-on-load, stdout-silent (pre --emit-fingerprint). The fixture
  // DISCRIMINATES the two call paths so the test can actually fail: spawned
  // by the checker, argv[2] is the repo path (exit 0 — clean); REQUIRED from
  // it, argv[2] is the sidecar path (exit 1 — the pre-refactor brick). A
  // require-vs-spawn mixup therefore blocks the commit instead of passing.
  const hooksDir = dirname(hook);
  const scriptsDir = join(hooksDir, "..", "scripts");
  writeFileSync(join(scriptsDir, "check-staged-divergence.cjs"),
    "#!/usr/bin/env node\n" +
    "// legacy checker fixture (2026-09-08): executes on load, no exports\n" +
    "const argv2 = process.argv[2] || '';\n" +
    "if (argv2.includes('review-gate-state.json')) process.exit(1);\n" +
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
