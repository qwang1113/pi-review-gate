// Precommit-lane split tests (fast vs full): the hooks must split exactly
// like lib/constants.ts requiresFullPrecommit — a commit accepts the fast
// lane, a push does not. Split out of test/git-hooks.test.ts (2026-09-08) so
// the hook suites run as several files in parallel under node --test; shared
// hermetic fixtures (incl. repoWithMatchingGates / runPrePush) live in
// test/helpers/hook-fixtures.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeGitRepo, runPreCommit, runPrePush, repoWithMatchingGates, readyState, cleanupTempDirs } from "./helpers/hook-fixtures.ts";
import { neutraliseHostGitConfig } from "./helpers/git.ts";

// Process-wide hermetic git (the shared fixtures neutralise too, but the
// hermetic-git guard requires the call to appear in THIS file's code).
neutraliseHostGitConfig();

after(cleanupTempDirs);

// ---------------------------------------------------------------------------
// Precommit lanes: a commit accepts the fast lane, a push does not.
// ---------------------------------------------------------------------------

test("fast lane PASS: commit allowed, PUSH blocked", () => {
  const state = { docSync: "NOT_NEEDED" };
  const fast = { mode: "fast", testScope: "related" };

  assert.equal(runPreCommit(repoWithMatchingGates(state, undefined, fast)).status, 0,
    "a narrowed run is enough to commit");

  const res = runPrePush(repoWithMatchingGates(state, undefined, fast));
  assert.equal(res.status, 1, "a narrowed run must not publish");
  assert.match(res.stderr, /push requires a FULL precommit run/);
  assert.match(res.stderr, /related/);
});

test("fast lane that SKIPPED tests: commit allowed, PUSH blocked", () => {
  const res = runPrePush(repoWithMatchingGates({ docSync: "NOT_NEEDED" }, undefined, { mode: "fast", testScope: "skipped" }));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /push requires a FULL precommit run/);
});

test("testScope full: push allowed no matter which lane produced it", () => {
  for (const mode of ["fast", "full"]) {
    const dir = repoWithMatchingGates({ docSync: "NOT_NEEDED" }, undefined, { mode, testScope: "full" });
    assert.equal(runPrePush(dir).status, 0, mode);
  }
});

test("a sidecar predating the split cannot claim a full run (push fails closed)", () => {
  const dir = repoWithMatchingGates({ docSync: "NOT_NEEDED" }); // no lane fields
  assert.equal(runPreCommit(dir).status, 0, "old sidecars still commit");
  const res = runPrePush(repoWithMatchingGates({ docSync: "NOT_NEEDED" }));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /predates the fast\/full split/);
});

test("REVIEW_GATE_REQUIRE_FULL only counts as exactly \"1\" (no accidental relaxation)", () => {
  // Any other ambient value leaves the commit-level rule in force; it must
  // neither tighten a commit nor loosen the push path.
  for (const v of ["0", "true", ""]) {
    const dir = repoWithMatchingGates({ docSync: "NOT_NEEDED" }, undefined, { mode: "fast", testScope: "related" });
    assert.equal(runPreCommit(dir, { REVIEW_GATE_REQUIRE_FULL: v }).status, 0, v);
  }
});

test("a forged lane value fails the whole sidecar closed", () => {
  for (const forged of [{ mode: "turbo", testScope: "full" }, { mode: "fast", testScope: "partial" }]) {
    const dir = repoWithMatchingGates({ docSync: "NOT_NEEDED" }, undefined, forged);
    const res = runPreCommit(dir);
    assert.equal(res.status, 1, JSON.stringify(forged));
    assert.match(res.stderr, /shape\/verdict invalid/);
  }
});
