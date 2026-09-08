/**
 * Shared hermetic-git fixtures for the hooks test suites. Split out of
 * test/git-hooks.test.ts (2026-09-08) so the suite can run as several files
 * in parallel under node --test. Module top level neutralises host git
 * config and gate env once per test process (each test file runs in its own
 * process, so importing this module is the per-file initialisation).
 */
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { neutraliseHostGitConfig } from "./git.ts";
import { neutraliseGateEnv } from "./gate-env.ts";

// 100+ fixture git calls live in these suites (and the hooks under test shell
// out to git themselves), so neutralise the host config once for the process.
neutraliseHostGitConfig();
// The hooks under test read the gate's OWN variables (RG_STATE_VARIANT picks
// which sidecar file counts). Inside a gate session — an orchestrator child
// has one — those would travel into every fixture and make the hook look for
// a sidecar the fixture never wrote, i.e. allow everything.
neutraliseGateEnv();

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PRE_COMMIT = join(ROOT, "hooks", "pre-commit");
export const COMMIT_MSG = join(ROOT, "hooks", "commit-msg");
export const INSTALL_HOOKS = join(ROOT, "scripts", "install-git-hooks.sh");

/** Throwaway HOME for hermetic hook tests (the hook reads the user-global
 *  config from ~/.pi/review-gate.json). Tests that exercise the global
 *  config pass their own HOME explicitly. */
export const emptyHome = mkdtempSync(join(tmpdir(), "rg-hooks-home-"));

const tempDirs: string[] = [];
export function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-hook-"));
  tempDirs.push(dir);
  return dir;
}

// Create a git repo so the hook can compute a fingerprint.
export function makeGitRepo(): string {
  const dir = makeDir();
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

export function cleanupTempDirs(): void {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
}

export function writeState(dir: string, state: object, withChangedFile = false) {
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), JSON.stringify(state));
  // If state says hasCodeChange, create a dummy file so fingerprint matches
  // the state's recorded fingerprint (state.fingerprint was set with this file present).
  if (withChangedFile) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "lib.ts"), "// test\n");
    execFileSync("git", ["add", "src/lib.ts"], { cwd: dir, stdio: "ignore" });
  }
}

export function runPreCommit(dir: string, env: Record<string, string> = {}) {
  // HERMETIC HOME: the hook now reads the user-global config
  // (~/.pi/review-gate.json) for docSync. Point HOME at a throwaway dir so a
  // real user config cannot flip these tests; the docSync-global tests below
  // pass their own HOME explicitly.
  return spawnSync("bash", [PRE_COMMIT], {
    cwd: dir, encoding: "utf8", env: { ...process.env, HOME: emptyHome, ...env },
  });
}

/** Must track lib/fingerprint.ts FINGERPRINT_VERSION; a stale value here would
 *  make every fixture take the migration path instead of the gate logic. */
export const FP_VERSION = 2;

export function runPrePush(dir: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [join(ROOT, "hooks", "pre-push")], {
    cwd: dir, encoding: "utf8", env: { ...process.env, HOME: emptyHome, ...env },
  });
}

/** Repo whose sidecar has READY+PASS bound to the REAL current fingerprint. */
export function repoWithMatchingGates(extraReview: object = {}, extraConfig?: object, extraPrecommit: object = {}): string {
  const dir = makeGitRepo();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "lib.ts"), "// change\n");
  execFileSync("git", ["add", "src/lib.ts"], { cwd: dir, stdio: "ignore" });
  const fp = JSON.parse(execFileSync("node", [join(ROOT, "scripts", "compute-fingerprint.cjs"), dir], { encoding: "utf8" })).digest;
  mkdirSync(join(dir, ".pi"), { recursive: true });
  if (extraConfig) writeFileSync(join(dir, ".pi", "review-gate.json"), JSON.stringify(extraConfig));
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), JSON.stringify({
    ...readyState(dir),
    review: { verdict: "READY", fingerprint: fp, at: "t", ...extraReview },
    precommit: { verdict: "PASS", fingerprint: fp, at: "t", ...extraPrecommit },
  }));
  return dir;
}

// Round-8 P1: bindings are COMMIT TREES — the fixture must carry the repo's
// actual HEAD tree OID or every "gates met" case reads as mismatched.
export interface ReadyFixture {
  fingerprintVersion: number;
  [k: string]: unknown;
}

export function readyState(dir: string): ReadyFixture {
  // Worktree-tree OID (not HEAD's): works in repos without a commit and
  // equals the content a commit would publish — the round-8 binding unit.
  const req = createRequire(import.meta.url);
  const { worktreeTreeOid } = req("../../scripts/compute-fingerprint.cjs") as {
    worktreeTreeOid: (cwd: string) => string;
  };
  let tree = "";
  try {
    tree = worktreeTreeOid(dir); // non-git dirs → "" (hook exits before comparing)
  } catch { /* makeDir() fixtures: schema/bypass paths exit before fingerprint */ }
  return {
    schema: 1,
    fingerprintVersion: FP_VERSION,
    sessionId: "test-session",
    hasCodeChange: true,
    hasDocChange: false,
    review: { verdict: "READY", fingerprint: tree, at: "t" },
    precommit: { verdict: "PASS", fingerprint: tree, at: "t" },
    rounds: [],
    maxRounds: 10,
    bypass: { active: false, reason: null, at: null },
    updatedAt: "t",
  };
}
