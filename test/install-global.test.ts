import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
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
    hasCodeChange: false,
    hasDocChange: false,
    review: { verdict: "PENDING", fingerprint: null, at: null },
    precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
    rounds: [],
    bypass: { active: false },
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
