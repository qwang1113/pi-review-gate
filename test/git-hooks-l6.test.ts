// L6 test-label English gate integration (the hook side; the scanner logic
// itself is unit-tested under test/scan-test-labels.test.ts). Split out of
// test/git-hooks.test.ts (2026-09-08) so the hook suites run as several files
// in parallel under node --test. Shared hermetic fixtures live in
// test/helpers/hook-fixtures.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeGitRepo, writeState, runPreCommit, readyState, cleanupTempDirs } from "./helpers/hook-fixtures.ts";
import { neutraliseHostGitConfig } from "./helpers/git.ts";

// Process-wide hermetic git (the shared fixtures neutralise too, but the
// hermetic-git guard requires the call to appear in THIS file's code).
neutraliseHostGitConfig();

after(cleanupTempDirs);

// Build a repo whose sidecar clears the verdict gate (no code/doc change) so the
// only thing that can block is the L6 label scan, then stage a test file.
function repoForLabelGate(testFileName: string, testFileContent: string): string {
  const dir = makeGitRepo();
  writeState(dir, { ...readyState(dir), hasCodeChange: false, hasDocChange: false });
  writeFileSync(join(dir, testFileName), testFileContent);
  execFileSync("git", ["add", testFileName], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("pre-commit blocks a staged non-English test label (L6)", () => {
  const dir = repoForLabelGate("a.test.ts", "it('返佣金额换算', () => {});\n");
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /non-English test label/);
  assert.match(res.stderr, /a\.test\.ts:1:/);
});

test("pre-commit allows a non-English label with a bypass marker (L6)", () => {
  const dir = repoForLabelGate("b.test.ts", "// review-gate: allow-non-english\nit('中文用例', () => {});\n");
  assert.equal(runPreCommit(dir).status, 0);
});

test("pre-commit allows English test labels (L6)", () => {
  const dir = repoForLabelGate("c.test.ts", "it('does the thing', () => {});\n");
  assert.equal(runPreCommit(dir).status, 0);
});

test("state-level bypass (/gate-bypass) disables L6 too", () => {
  // A non-English label would normally block, but bypass.active must short-
  // circuit ALL ship blocking including L6 (documented /gate-bypass escape).
  const dir = makeGitRepo();
  writeState(dir, {
    ...readyState(dir), hasCodeChange: true,
    review: { verdict: "PENDING", fingerprint: null, at: null },
    bypass: { active: true, reason: "hotfix", at: "t" },
  });
  writeFileSync(join(dir, "a.test.ts"), "it('中文用例', () => {});\n");
  execFileSync("git", ["add", "a.test.ts"], { cwd: dir, stdio: "ignore" });
  assert.equal(runPreCommit(dir).status, 0);
});

test("REVIEW_GATE_BYPASS=1 env disables L6 too", () => {
  const dir = repoForLabelGate("d.test.ts", "it('中文用例', () => {});\n");
  assert.equal(runPreCommit(dir, { REVIEW_GATE_BYPASS: "1" }).status, 0);
});
