import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const { computeFingerprint, changedFiles } = await import(
  join(resolve(import.meta.dirname ?? "."), "..", "lib", "fingerprint.ts")
);

const tempDirs: string[] = [];
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-fp-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], {
    cwd: dir, stdio: "ignore",
  });
  return dir;
}
after(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

test("clean repo fingerprint is stable", () => {
  const dir = makeRepo();
  const a = computeFingerprint(dir);
  const b = computeFingerprint(dir);
  assert.equal(a.digest, b.digest);
  assert.equal(a.unavailable, false);
});

test("brand-new UNTRACKED file changes the fingerprint", () => {
  const dir = makeRepo();
  const a = computeFingerprint(dir);
  writeFileSync(join(dir, "new.ts"), "// new file");
  const b = computeFingerprint(dir);
  assert.notEqual(a.digest, b.digest);
});

test("untracked file inside a new directory is seen", () => {
  const dir = makeRepo();
  const a = computeFingerprint(dir);
  mkdirSync(join(dir, "deep", "nested"), { recursive: true });
  writeFileSync(join(dir, "deep", "nested", "lib.ts"), "// deep");
  const b = computeFingerprint(dir);
  assert.notEqual(a.digest, b.digest);
});

test("staged edit changes fingerprint", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "file.ts"), "// v1");
  const a = computeFingerprint(dir);
  execFileSync("git", ["add", "file.ts"], { cwd: dir, stdio: "ignore" });
  const b = computeFingerprint(dir);
  assert.notEqual(a.digest, b.digest);
});

test("unstaged edit changes fingerprint", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "file.ts"), "// v1");
  execFileSync("git", ["add", "file.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add"], { cwd: dir, stdio: "ignore" });
  const a = computeFingerprint(dir);
  writeFileSync(join(dir, "file.ts"), "// v2");
  const b = computeFingerprint(dir);
  assert.notEqual(a.digest, b.digest);
});

test("HEAD move changes fingerprint", () => {
  const dir = makeRepo();
  const a = computeFingerprint(dir);
  writeFileSync(join(dir, "f.ts"), "//");
  execFileSync("git", ["add", "f.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add"], { cwd: dir, stdio: "ignore" });
  const b = computeFingerprint(dir);
  assert.notEqual(a.digest, b.digest);
});

test("non-git directory → unavailable=true (fail closed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-nogit-"));
  tempDirs.push(dir);
  const fp = computeFingerprint(dir);
  assert.equal(fp.unavailable, true);
});

test("changedFiles: clean repo → [], dirty repo lists paths", () => {
  const dir = makeRepo();
  assert.deepEqual(changedFiles(dir), []);
  writeFileSync(join(dir, "x.ts"), "//");
  writeFileSync(join(dir, "y.md"), "//");
  const files = changedFiles(dir);
  assert.ok(files!.includes("x.ts"));
  assert.ok(files!.includes("y.md"));
});

// ---------------------------------------------------------------------------
// P0 self-deadlock regression: the gate's OWN writes must not invalidate the
// fingerprint they were bound to. In a repo that does NOT gitignore .pi, the
// old fingerprint included the untracked sidecar (size+mtime), so persist()
// after record_review immediately broke the READY binding.

/** Disable the developer's global gitignore for a test repo so an ambient
 *  `.pi*` exclude (present on some machines) can't mask the regression. */
function disableGlobalExcludes(dir: string): void {
  execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: dir, stdio: "ignore" });
}

test("P0: gate-owned .pi files do NOT affect the fingerprint (sidecar self-deadlock)", () => {
  const dir = makeRepo();
  disableGlobalExcludes(dir);
  writeFileSync(join(dir, "code.ts"), "// change\n"); // some real change
  const before = computeFingerprint(dir);
  // Simulate persist(): create + rewrite the sidecar, lessons, arbitration log.
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), JSON.stringify({ schema: 1 }));
  writeFileSync(join(dir, ".pi", "review-gate-lessons.md"), "### L1\nlesson\n");
  writeFileSync(join(dir, ".pi", "review-gate-arbitration.log"), "entry\n");
  const after = computeFingerprint(dir);
  assert.equal(before.digest, after.digest, "gate-owned .pi writes must be fingerprint-invisible");
  // Rewriting the sidecar again (new mtime + content) still changes nothing.
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), JSON.stringify({ schema: 1, updatedAt: "t2" }));
  assert.equal(computeFingerprint(dir).digest, after.digest);
});

test("P0: .pi-subagents artifacts do NOT affect the fingerprint", () => {
  const dir = makeRepo();
  disableGlobalExcludes(dir);
  const before = computeFingerprint(dir);
  mkdirSync(join(dir, ".pi-subagents", "artifacts"), { recursive: true });
  writeFileSync(join(dir, ".pi-subagents", "artifacts", "x_output.md"), "transcript");
  assert.equal(computeFingerprint(dir).digest, before.digest);
});

test("P0: changedFiles ignores gate-owned .pi paths (turn_end reconciliation)", () => {
  const dir = makeRepo();
  disableGlobalExcludes(dir);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), "{}");
  assert.deepEqual(changedFiles(dir), []);
});

test("real project files still change the fingerprint after the exclusion", () => {
  const dir = makeRepo();
  disableGlobalExcludes(dir);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), "{}");
  const a = computeFingerprint(dir);
  writeFileSync(join(dir, "new.ts"), "// real change");
  assert.notEqual(computeFingerprint(dir).digest, a.digest);
});

// The CJS mirror (scripts/compute-fingerprint.cjs, used by the git hooks) must
// produce the IDENTICAL digest — drift between the two implementations makes
// every hook fail closed on fingerprint mismatch.
test("parity: compute-fingerprint.cjs emits the same digest as lib/fingerprint.ts", () => {
  const dir = makeRepo();
  disableGlobalExcludes(dir);
  writeFileSync(join(dir, "code.ts"), "// change\n");
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), "{}");
  execFileSync("git", ["add", "code.ts"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "code.ts"), "// v2\n"); // staged + unstaged + untracked mix
  writeFileSync(join(dir, "notes.md"), "docs\n");
  const tsFp = computeFingerprint(dir);
  const cjsOut = execFileSync("node", [
    join(resolve(import.meta.dirname ?? "."), "..", "scripts", "compute-fingerprint.cjs"), dir,
  ], { encoding: "utf8" });
  const cjsFp = JSON.parse(cjsOut);
  assert.equal(cjsFp.unavailable, false);
  assert.equal(cjsFp.digest, tsFp.digest, "TS and CJS fingerprint implementations drifted");
});
