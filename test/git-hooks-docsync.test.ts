// docSync knob tests (code↔doc attestation, defense-in-depth mirror of the
// extension's unmetRequirements): default-on, project/global config
// precedence, fail-safe on corrupt config. Split out of test/git-hooks.test.ts
// (2026-09-08) so the hook suites run as several files in parallel under
// node --test; shared hermetic fixtures (incl. repoWithMatchingGates) live in
// test/helpers/hook-fixtures.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPreCommit, repoWithMatchingGates, cleanupTempDirs } from "./helpers/hook-fixtures.ts";
import { neutraliseHostGitConfig } from "./helpers/git.ts";

// Process-wide hermetic git (the shared fixtures neutralise too, but the
// hermetic-git guard requires the call to appear in THIS file's code).
neutraliseHostGitConfig();

after(cleanupTempDirs);

// ---------------------------------------------------------------------------
// pre-commit: docSync knob (code↔doc attestation, defense-in-depth mirror)
// ---------------------------------------------------------------------------

test("docSync DEFAULT ON → READY review without attestation blocks", () => {
  const dir = repoWithMatchingGates(); // no config file → default enforced
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /docSync enforced/);
});

test("docSync explicitly disabled → READY+PASS without attestation commits", () => {
  const dir = repoWithMatchingGates({}, { docSync: false });
  assert.equal(runPreCommit(dir).status, 0);
});

test("docSync: user-global config (~/.pi/review-gate.json) is the hook's fallback", () => {
  // Global false + no project config → hook honors the global (releases).
  const globalHome = mkdtempSync(join(tmpdir(), "rg-hooks-global-"));
  mkdirSync(join(globalHome, ".pi"), { recursive: true });
  writeFileSync(join(globalHome, ".pi", "review-gate.json"), JSON.stringify({ docSync: false }));
  const dir = repoWithMatchingGates(); // no project config
  assert.equal(runPreCommit(dir, { HOME: globalHome }).status, 0,
    "a global docSync:false must release the attestation requirement");
  // Project explicit true beats global false (project wins field-by-field).
  const dir2 = repoWithMatchingGates({}, { docSync: true });
  const res = runPreCommit(dir2, { HOME: globalHome });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /docSync enforced/,
    "an explicit project docSync:true must override the global false");
  // Corrupt global config → default enforced (fail-safe).
  const badHome = mkdtempSync(join(tmpdir(), "rg-hooks-global-bad-"));
  mkdirSync(join(badHome, ".pi"), { recursive: true });
  writeFileSync(join(badHome, ".pi", "review-gate.json"), "{ nope");
  assert.equal(runPreCommit(dir, { HOME: badHome }).status, 1,
    "a corrupt global config must fall back to the enforced default");
});

test("docSync on → UPDATED / NOT_NEEDED attestation commits (default and explicit)", () => {
  for (const att of ["UPDATED", "NOT_NEEDED"]) {
    const dflt = repoWithMatchingGates({ docSync: att });
    assert.equal(runPreCommit(dflt).status, 0, `default: ${att}`);
    const explicit = repoWithMatchingGates({ docSync: att }, { docSync: true });
    assert.equal(runPreCommit(explicit).status, 0, `explicit: ${att}`);
  }
});

test("SECURITY: forged docSync attestation values fail closed (shape invalid)", () => {
  const dir = repoWithMatchingGates({ docSync: "YES" }, { docSync: true });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /shape\/verdict invalid/);
});

test("docSync: corrupt project config → default ENFORCED (fail-safe, never fail-open)", () => {
  const dir = repoWithMatchingGates();
  writeFileSync(join(dir, ".pi", "review-gate.json"), "{truncated");
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /docSync enforced/);
});
