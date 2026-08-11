import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = join(ROOT, "scripts", "install-global.sh");

const tempDirs: string[] = [];
function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-install-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function installGlobal(home: string) {
  return spawnSync("bash", [INSTALLER], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

// Regression: the global installer must ship compute-fingerprint.cjs to
// ~/.pi/agent/scripts/ under its ORIGINAL name, because the installed git hooks
// resolve it as ../scripts/compute-fingerprint.cjs relative to their own dir.
// If it is missing, every hook fails closed and normal commits are impossible.
test("install-global ships compute-fingerprint.cjs where the hooks resolve it", () => {
  const home = makeHome();
  const res = installGlobal(home);
  assert.equal(res.status, 0, `installer failed: ${res.stderr}`);

  const scriptsDir = join(home, ".pi", "agent", "scripts");
  const fpScript = join(scriptsDir, "compute-fingerprint.cjs");
  assert.ok(existsSync(fpScript), "compute-fingerprint.cjs missing from installed scripts dir");

  // The L6 test-label scanner must also ship under its ORIGINAL name so the
  // installed pre-commit resolves ../scripts/scan-test-labels.cjs.
  const labelScript = join(scriptsDir, "scan-test-labels.cjs");
  assert.ok(existsSync(labelScript), "scan-test-labels.cjs missing from installed scripts dir");

  // The installed runner imports ./precommit-config.mjs — without it the
  // runner crashes on startup and every precommit run reports a fail-closed
  // ERROR (no PASS, no commits).
  const configScript = join(scriptsDir, "precommit-config.mjs");
  assert.ok(existsSync(configScript), "precommit-config.mjs missing from installed scripts dir");

  // The installed pre-commit hook resolves FP_SCRIPT as HOOK_DIR/../scripts/…;
  // HOOK_DIR is the same scripts dir, so the relative path must also resolve.
  const hookResolved = join(scriptsDir, "..", "scripts", "compute-fingerprint.cjs");
  assert.ok(existsSync(hookResolved), "hook-relative FP_SCRIPT path does not resolve");
});

// End-to-end: run the INSTALLED pre-commit hook (from ~/.pi/agent/scripts) in a
// real repo carrying a sidecar, and confirm it can compute a fingerprint rather
// than dying with "cannot compute worktree fingerprint" (the B2 symptom).
test("installed pre-commit hook computes a fingerprint (no fail-closed on missing script)", () => {
  const home = makeHome();
  const inst = installGlobal(home);
  assert.equal(inst.status, 0, `installer failed: ${inst.stderr}`);
  const installedPreCommit = join(home, ".pi", "agent", "scripts", "pre-commit");
  assert.ok(existsSync(installedPreCommit), "installed pre-commit hook missing");

  // Minimal git repo with a sidecar that has no code/doc change → hook should
  // reach the "no changes → allow" path (exit 0), proving FP_SCRIPT was found
  // and executed. A missing script would exit 1 before that.
  const repo = mkdtempSync(join(tmpdir(), "rg-install-repo-"));
  tempDirs.push(repo);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], { cwd: repo, stdio: "ignore" });
  mkdirSync(join(repo, ".pi"), { recursive: true });
  writeFileSync(join(repo, ".pi", "review-gate-state.json"), JSON.stringify({
    schema: 1,
    sessionId: "test-session",
    hasCodeChange: false,
    hasDocChange: false,
    review: { verdict: "PENDING", fingerprint: null, at: null },
    precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
    rounds: [],
    maxRounds: 10,
    bypass: { active: false, reason: null, at: null },
    updatedAt: "t",
  }));

  const res = spawnSync("bash", [installedPreCommit], { cwd: repo, encoding: "utf8" });
  assert.equal(res.status, 0, `installed hook failed: ${res.stderr}`);
  assert.ok(
    !/cannot compute worktree fingerprint/.test(res.stderr),
    `hook could not find fingerprint script: ${res.stderr}`,
  );
});

// Regression: npm exposes the installer as a node_modules/.bin symlink pointing
// at ../<pkg>/scripts/install-global.sh. If SRC is derived from the symlink's
// own dir instead of the resolved target, it lands in node_modules and every cp
// fails. Simulate that layout: a .bin symlink to the real installer, invoked so
// BASH_SOURCE[0] is the symlink path.
test("install-global resolves its own symlink (npm .bin entrypoint works)", () => {
  const home = makeHome();
  const binDir = join(home, "fake_node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const link = join(binDir, "pi-review-gate-install");
  symlinkSync(INSTALLER, link); // absolute-target symlink, like npm's relative one in effect

  const res = spawnSync("bash", [link], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(res.status, 0, `installer via symlink failed: ${res.stderr}`);
  assert.ok(
    !/No such file or directory/.test(res.stderr),
    `installer resolved wrong SRC via symlink: ${res.stderr}`,
  );
  // Real artifacts must land under the resolved package root, not node_modules.
  assert.ok(existsSync(join(home, ".pi", "agent", "extensions", "pi-review-gate", "review-gate.ts")));
  assert.ok(existsSync(join(home, ".pi", "agent", "scripts", "compute-fingerprint.cjs")));
});

// ---------------------------------------------------------------------------
// Agent definitions: always overwritten with the shipped version (the repo is
// the single source of truth — same policy as the extension/skill/scripts).

test("re-install overwrites agent definitions with the shipped version", () => {
  const home = makeHome();
  const first = installGlobal(home);
  assert.equal(first.status, 0, `installer failed: ${first.stderr}`);
  const agentsDir = join(home, ".pi", "agent", "agents");
  const reviewerFile = join(agentsDir, "reviewer.md");
  const adviserFile = join(agentsDir, "adviser.md");
  // P2 regression: the arbiter agent definition must ship too — the README
  // documents all three judge roles as part of the install.
  const arbiterFile = join(agentsDir, "arbiter.md");
  assert.ok(existsSync(reviewerFile) && existsSync(adviserFile) && existsSync(arbiterFile));
  const shipped = readFileSync(reviewerFile, "utf8");

  // A locally edited copy is overwritten on re-install (repo wins).
  writeFileSync(reviewerFile, shipped.replace(/^thinking: .*$/m, "thinking: low"));
  // Simulate leftover state from the removed three-way-merge updater so the
  // cleanup is actually exercised (an empty assertion would pass vacuously).
  const legacyDir = join(agentsDir, ".pi-review-gate-shipped");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "reviewer.md"), "stale base copy");
  const second = installGlobal(home);
  assert.equal(second.status, 0, `re-install failed: ${second.stderr}`);
  assert.equal(readFileSync(reviewerFile, "utf8"), shipped, "re-install must restore the shipped version");
  assert.match(second.stdout, /reviewer subagent installed \(overwritten with shipped version\)/);

  // Legacy three-way-merge state dir is cleaned up.
  assert.ok(!existsSync(legacyDir), "legacy merge-base dir must be removed");
});


// The pre-commit hook resolves the staged-divergence checker as
// ../scripts/check-staged-divergence.cjs relative to its own directory. If the
// installer does not ship it under that exact name the gate silently degrades
// (the hook warns and skips), so assert it lands where the hook looks.
test("install-global ships check-staged-divergence.cjs where the hook resolves it", () => {
  const home = makeHome();
  const res = installGlobal(home);
  assert.equal(res.status, 0, `installer failed: ${res.stderr}`);
  const scriptsDir = join(home, ".pi", "agent", "scripts");
  assert.ok(
    existsSync(join(scriptsDir, "check-staged-divergence.cjs")),
    "check-staged-divergence.cjs missing from installed scripts dir",
  );
  assert.ok(
    existsSync(join(scriptsDir, "..", "scripts", "check-staged-divergence.cjs")),
    "hook-relative path to the divergence checker does not resolve",
  );
});


// The project installer must also ship the divergence checker under its exact
// name, for the same reason as the global one (the hook resolves it by path).
test("install-project ships check-staged-divergence.cjs under its exact name", () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-proj-"));
  tempDirs.push(repo);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  const res = spawnSync("bash", [join(ROOT, "scripts", "install-project.sh")], {
    cwd: repo, encoding: "utf8", env: { ...process.env, HOME: makeHome() },
  });
  assert.equal(res.status, 0, `project installer failed: ${res.stderr}`);
  assert.ok(
    existsSync(join(repo, ".pi", "scripts", "check-staged-divergence.cjs")),
    "check-staged-divergence.cjs missing from the project install",
  );
});

// Existence checks are not enough: the checker `require`s its fingerprint
// dependency from the SAME directory, so an installer that ships only the
// checker produces a layout where every commit fails closed with "Cannot find
// module" (reproduced by independent review of the project installer). RUN the
// installed copy instead of merely looking for it.
test("install-project produces a WORKING checker (dependency included)", () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-proj-run-"));
  tempDirs.push(repo);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  const install = spawnSync("bash", [join(ROOT, "scripts", "install-project.sh")], {
    cwd: repo, encoding: "utf8", env: { ...process.env, HOME: makeHome() },
  });
  assert.equal(install.status, 0, `project installer failed: ${install.stderr}`);

  const installed = join(repo, ".pi", "scripts", "check-staged-divergence.cjs");
  assert.ok(existsSync(installed), "checker missing from the project install");
  assert.ok(existsSync(join(repo, ".pi", "scripts", "compute-fingerprint.cjs")),
    "the checker's fingerprint dependency must be installed alongside it");

  const run = spawnSync("node", [installed, repo], { encoding: "utf8" });
  assert.ok(!/Cannot find module/.test(run.stderr),
    `the installed checker could not load its dependency: ${run.stderr}`);
  assert.ok(!/cannot load the fingerprint implementation/.test(run.stderr),
    `the installed checker failed closed on a clean repo: ${run.stderr}`);
  assert.equal(run.status, 0, `a clean repo must not be blocked: ${run.stderr}`);
});

test("install-global also produces a WORKING checker", () => {
  const home = makeHome();
  const res = spawnSync("bash", [join(ROOT, "scripts", "install-global.sh")], {
    encoding: "utf8", env: { ...process.env, HOME: home },
  });
  assert.equal(res.status, 0, `global installer failed: ${res.stderr}`);
  const installed = join(home, ".pi", "agent", "scripts", "check-staged-divergence.cjs");
  assert.ok(existsSync(installed), "checker missing from the global install");

  const repo = mkdtempSync(join(tmpdir(), "rg-glob-run-"));
  tempDirs.push(repo);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  const run = spawnSync("node", [installed, repo], { encoding: "utf8" });
  assert.ok(!/Cannot find module/.test(run.stderr),
    `the installed checker could not load its dependency: ${run.stderr}`);
  assert.equal(run.status, 0, `a clean repo must not be blocked: ${run.stderr}`);
});
