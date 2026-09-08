// pre-commit main gate + docSync + lanes + L6 + commit-msg + installer hook
// tests. This file used to hold the whole 1900-line hook suite; it was split
// (2026-09-08) so the hook suites run as several files in parallel under
// node --test: git-hooks-divergence.test.ts (staged-vs-worktree divergence +
// submodule/gitlink) and git-hooks-verdict.test.ts (entry classification,
// committed index, migration, materialization, unreviewed-commit,
// message-only). Shared hermetic fixtures live in
// test/helpers/hook-fixtures.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT, INSTALL_HOOKS, COMMIT_MSG, emptyHome, makeDir, makeGitRepo, writeState, runPreCommit, readyState, cleanupTempDirs } from "./helpers/hook-fixtures.ts";
import { neutraliseHostGitConfig } from "./helpers/git.ts";

// Process-wide hermetic git (the shared fixtures neutralise too, but the
// hermetic-git guard requires the call to appear in THIS file's code).
neutraliseHostGitConfig();

after(cleanupTempDirs);

// ---------------------------------------------------------------------------
// pre-commit
// ---------------------------------------------------------------------------

test("no sidecar → allow (repos without the extension must not brick)", () => {
  assert.equal(runPreCommit(makeDir()).status, 0);
});

test("inside a review snapshot worktree → BLOCKED even without a sidecar (shares the real .git)", () => {
  // A snapshot deliberately carries no .pi/ (the extension is inert there),
  // so the "no sidecar → allow" rule would let a reviewer's commit/push
  // ship the REAL repo through the shared .git. Both layouts must fail
  // closed: the repo-local .pi/review-snapshots/ path and the tmpdir
  // fallback (<tmp>/rg-review-snap-*/<instance>).
  const repo = makeGitRepo();
  const snapLayout = join(repo, ".pi", "review-snapshots", "rg-review-snap-abc", "shard-1");
  mkdirSync(snapLayout, { recursive: true });
  const blocked = runPreCommit(snapLayout);
  assert.equal(blocked.status, 1, "repo-local snapshot layout must fail closed");
  assert.match(blocked.stderr, /review snapshot worktree/, "the refusal must name the reason");

  const tmpBase = mkdtempSync(join(tmpdir(), "rg-hooks-snap-"));
  const tmpLayout = join(tmpBase, "rg-review-snap-abc", "shard-1");
  mkdirSync(tmpLayout, { recursive: true });
  try {
    const blockedTmp = runPreCommit(tmpLayout);
    assert.equal(blockedTmp.status, 1, "tmpdir fallback snapshot layout must fail closed");
    assert.match(blockedTmp.stderr, /review snapshot worktree/, "the refusal must name the reason here too");
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }

  // pre-push re-execs pre-commit with REVIEW_GATE_REQUIRE_FULL=1, so the
  // snapshot refusal must hold for PUSHES too (the copy claims commit/push).
  const pushed = runPrePush(snapLayout);
  assert.equal(pushed.status, 1, "the snapshot refusal must hold for pre-push as well");
  assert.match(pushed.stderr, /review snapshot worktree/, "pre-push must name the same reason");

  // The same repo from a NORMAL subdir still allows (no sidecar).
  const plain = join(repo, "src");
  mkdirSync(plain, { recursive: true });
  assert.equal(runPreCommit(plain).status, 0, "a plain subdir without a sidecar still allows");
});

test("gates met → allow", () => {
  const dir = makeGitRepo();
  // Need a dirty file so fingerprint doesn't match clean state.
  // Use withChangedFile so state's fingerprint matches the current worktree.
  writeState(dir, readyState(dir), /*withChangedFile=*/ true);
  // READY review + PASS precommit with fingerprint "x" won't match
  // current worktree fingerprint → blocked by fingerprint mismatch.
  // We need the fingerprint in state to match. Let's set it to a dummy
  // and test with hasCodeChange=false (pre-existing clean work).
  const res = runPreCommit(dir);
  // fingerprint mismatch blocks
  assert.equal(res.status, 1);
  assert.match(res.stderr, /fingerprint mismatch/);
});

test("gates met + matching fingerprints → allow", () => {
  const dir = makeGitRepo();
  // Clean repo, no changes → fingerprint is stable.
  // Set hasCodeChange to false so the hook skips the gate completely.
  writeState(dir, { ...readyState(dir), hasCodeChange: false, hasDocChange: false });
  assert.equal(runPreCommit(dir).status, 0);
});

test("review not READY → block", () => {
  const dir = makeGitRepo();
  // withChangedFile: the fixture must hold real staged content, or the commit
  // would publish HEAD's own tree — a no-content commit the gates skip by
  // design (message-only rewrite exemption).
  writeState(dir, { ...readyState(dir), review: { verdict: "PENDING", fingerprint: null, at: null } }, true);
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /review is PENDING/);
});

test("precommit NO_CHECKS_RUN → block (PR #7 lesson 3)", () => {
  const dir = makeGitRepo();
  writeState(dir, { ...readyState(dir), precommit: { verdict: "NO_CHECKS_RUN", fingerprint: null, at: "t" } }, true);
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /zero checks/);
});

test("corrupt sidecar → block (fail closed)", () => {
  const dir = makeDir(); // no git needed for corrupt JSON test
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), "{truncated");
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unreadable/);
});

test("unknown schema → block (fail closed)", () => {
  const dir = makeDir(); // no git needed for schema test
  writeState(dir, { ...readyState(dir), schema: 42 });
  assert.equal(runPreCommit(dir).status, 1);
});

test("user-chosen explore mode makes hook gates advisory", () => {
  const dir = makeGitRepo();
  writeState(dir, {
    ...readyState(dir),
    taskMode: "explore",
    taskModeSource: "user",
    review: { verdict: "PENDING", fingerprint: null, at: null },
    precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
  });
  assert.equal(runPreCommit(dir).status, 0);
});

test("user-chosen normal mode makes hook gates advisory", () => {
  const dir = makeGitRepo();
  writeState(dir, {
    ...readyState(dir),
    taskMode: "normal",
    taskModeSource: "user",
    review: { verdict: "PENDING", fingerprint: null, at: null },
    precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
  });
  assert.equal(runPreCommit(dir).status, 0);
});

test("SECURITY: agent/auto-set normal must NOT make the hook advisory", () => {
  // normal fully opens the commit gate, so a forged/agent-written sidecar with
  // source "auto" (or no source) must keep the hook enforced — only a
  // user-confirmed normal (source "user") may downgrade it.
  for (const extra of [{ taskModeSource: "auto" }, {}]) {
    const dir = makeGitRepo();
    writeState(dir, {
      ...readyState(dir),
      taskMode: "normal",
      ...extra,
      review: { verdict: "PENDING", fingerprint: null, at: null },
      precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
    }, true);
    const res = runPreCommit(dir);
    assert.equal(res.status, 1, JSON.stringify(extra));
    assert.match(res.stderr, /review is PENDING/);
  }
});

test("SECURITY: auto-classified explore must NOT make the hook advisory", () => {
  // A heuristic misclassification (taskModeSource: "auto") or a sidecar
  // without the field must keep the full commit gate. Only an explicit user
  // choice may downgrade the hook.
  for (const extra of [{ taskModeSource: "auto" }, {}]) {
    const dir = makeGitRepo();
    writeState(dir, {
      ...readyState(dir),
      taskMode: "explore",
      ...extra,
      review: { verdict: "PENDING", fingerprint: null, at: null },
      precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
    }, true);
    const res = runPreCommit(dir);
    assert.equal(res.status, 1, JSON.stringify(extra));
    assert.match(res.stderr, /review is PENDING/);
  }
});

test("SECURITY: forged taskModeSource values fail closed", () => {
  const dir = makeGitRepo();
  writeState(dir, {
    ...readyState(dir),
    taskMode: "explore",
    taskModeSource: "root",
    review: { verdict: "PENDING", fingerprint: null, at: null },
    precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /shape\/verdict invalid/);
});

test("SECURITY: unknown taskMode values fail closed (whitelist, incl. retired 'readonly')", () => {
  for (const taskMode of ["free", "readonly"]) {
    const dir = makeGitRepo();
    writeState(dir, {
      ...readyState(dir),
      taskMode,
      taskModeSource: "user",
      review: { verdict: "PENDING", fingerprint: null, at: null },
      precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
    });
    const res = runPreCommit(dir);
    assert.equal(res.status, 1, taskMode);
    assert.match(res.stderr, /shape\/verdict invalid/);
  }
});

test("pausedQuestion: valid shape is accepted (pause never affects the hook's ship decision)", () => {
  const dir = makeGitRepo();
  // Gates fully met (no tracked changes) + a well-formed pause → still allow.
  writeState(dir, {
    ...readyState(dir),
    hasCodeChange: false,
    hasDocChange: false,
    pausedQuestion: { question: "Which auth provider?", at: "t" },
  });
  assert.equal(runPreCommit(dir).status, 0);
});

test("pausedQuestion: gates unmet stay blocked even while paused (no fail-open)", () => {
  const dir = makeGitRepo();
  writeState(dir, {
    ...readyState(dir),
    review: { verdict: "PENDING", fingerprint: null, at: null },
    pausedQuestion: { question: "q", at: "t" },
  }, true);
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /review is PENDING/);
});

test("SECURITY: malformed pausedQuestion shapes fail closed (tampered sidecar)", () => {
  for (const bad of ["str", 42, { question: 1, at: "t" }, { question: "q" }, { at: "t" }]) {
    const dir = makeGitRepo();
    writeState(dir, { ...readyState(dir), hasCodeChange: false, hasDocChange: false, pausedQuestion: bad });
    const res = runPreCommit(dir);
    assert.equal(res.status, 1, JSON.stringify(bad));
    assert.match(res.stderr, /shape\/verdict invalid/);
  }
});

test("scopeLimit: valid shape is accepted (arming flags in the sidecar decide the ship outcome)", () => {
  const dir = makeGitRepo();
  // A user-granted scope limit with no session edits disarms the gate
  // (hasCodeChange/hasDocChange false) — the hook must allow that state.
  writeState(dir, {
    ...readyState(dir),
    hasCodeChange: false,
    hasDocChange: false,
    review: { verdict: "PENDING", fingerprint: null, at: null },
    precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
    scopeLimit: { preexistingFiles: ["src/old.ts"], sessionFiles: [], at: "t" },
  });
  assert.equal(runPreCommit(dir).status, 0);
});

test("scopeLimit: session edits stay fully gated even under a scope limit (no fail-open)", () => {
  const dir = makeGitRepo();
  writeState(dir, {
    ...readyState(dir),
    review: { verdict: "PENDING", fingerprint: null, at: null },
    scopeLimit: { preexistingFiles: ["src/old.ts"], sessionFiles: ["src/new.ts"], at: "t" },
  }, true);
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /review is PENDING/);
});

test("sessionEditedFiles: valid shape accepted; malformed shapes fail closed", () => {
  const ok = makeGitRepo();
  writeState(ok, {
    ...readyState(ok),
    hasCodeChange: false,
    hasDocChange: false,
    sessionEditedFiles: ["src/new.ts"],
  });
  assert.equal(runPreCommit(ok).status, 0);

  for (const bad of ["str", 42, [1], ["ok", null]]) {
    const dir = makeGitRepo();
    writeState(dir, { ...readyState(dir), hasCodeChange: false, hasDocChange: false, sessionEditedFiles: bad });
    const res = runPreCommit(dir);
    assert.equal(res.status, 1, JSON.stringify(bad));
    assert.match(res.stderr, /shape\/verdict invalid/);
  }
});

test("SECURITY: malformed scopeLimit shapes fail closed (tampered sidecar)", () => {
  for (const bad of [
    "str",
    42,
    { preexistingFiles: "x", sessionFiles: [], at: "t" },
    { preexistingFiles: [1], sessionFiles: [], at: "t" },
    { preexistingFiles: [], sessionFiles: [null], at: "t" },
    { preexistingFiles: [], sessionFiles: [] },
    { sessionFiles: [], at: "t" },
  ]) {
    const dir = makeGitRepo();
    writeState(dir, { ...readyState(dir), hasCodeChange: false, hasDocChange: false, scopeLimit: bad });
    const res = runPreCommit(dir);
    assert.equal(res.status, 1, JSON.stringify(bad));
    assert.match(res.stderr, /shape\/verdict invalid/);
  }
});

test("explore does not bypass unknown or malformed sidecar schemas", () => {
  const unknown = makeDir();
  writeState(unknown, { ...readyState(unknown), schema: 999, taskMode: "explore" });
  const unknownRes = runPreCommit(unknown);
  assert.equal(unknownRes.status, 1);
  assert.match(unknownRes.stderr, /unknown gate schema/);

  const malformed = makeDir();
  writeState(malformed, {
    ...readyState(malformed),
    taskMode: "explore",
    hasCodeChange: "yes",
    review: { verdict: "FORGED" },
  });
  const malformedRes = runPreCommit(malformed);
  assert.equal(malformedRes.status, 1);
  assert.match(malformedRes.stderr, /shape\/verdict invalid/);

  const incomplete = makeDir();
  writeState(incomplete, {
    schema: 1,
    hasCodeChange: true,
    hasDocChange: false,
    review: { verdict: "PENDING" },
    precommit: { verdict: "NOT_RUN" },
    rounds: [],
    bypass: { active: false },
    taskMode: "explore",
  });
  const incompleteRes = runPreCommit(incomplete);
  assert.equal(incompleteRes.status, 1);
  assert.match(incompleteRes.stderr, /shape\/verdict invalid/);
});

test("bypass active in state → allow", () => {
  const dir = makeDir();
  writeState(dir, { ...readyState(dir), review: { verdict: "PENDING", fingerprint: null, at: null }, bypass: { active: true, reason: "hotfix", at: "t" } });
  assert.equal(runPreCommit(dir).status, 0);
});

test("REVIEW_GATE_BYPASS=1 env → allow", () => {
  const dir = makeDir();
  writeState(dir, { ...readyState(dir), review: { verdict: "BLOCKED", fingerprint: null, at: "t" } });
  assert.equal(runPreCommit(dir, { REVIEW_GATE_BYPASS: "1" }).status, 0);
});

test("no changes tracked → allow even without verdicts", () => {
  const dir = makeDir();
  writeState(dir, {
    ...readyState(dir),
    hasCodeChange: false,
    review: { verdict: "PENDING", fingerprint: null, at: null },
    precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
  });
  assert.equal(runPreCommit(dir).status, 0);
});

// ---------------------------------------------------------------------------
// pre-commit: docSync knob (code↔doc attestation, defense-in-depth mirror)
// ---------------------------------------------------------------------------

const FP_SCRIPT = join(ROOT, "scripts", "compute-fingerprint.cjs");

/** Repo whose sidecar has READY+PASS bound to the REAL current fingerprint. */
function repoWithMatchingGates(extraReview: object = {}, extraConfig?: object, extraPrecommit: object = {}): string {
  const dir = makeGitRepo();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "lib.ts"), "// change\n");
  execFileSync("git", ["add", "src/lib.ts"], { cwd: dir, stdio: "ignore" });
  const fp = JSON.parse(execFileSync("node", [FP_SCRIPT, dir], { encoding: "utf8" })).digest;
  mkdirSync(join(dir, ".pi"), { recursive: true });
  if (extraConfig) writeFileSync(join(dir, ".pi", "review-gate.json"), JSON.stringify(extraConfig));
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), JSON.stringify({
    ...readyState(dir),
    review: { verdict: "READY", fingerprint: fp, at: "t", ...extraReview },
    precommit: { verdict: "PASS", fingerprint: fp, at: "t", ...extraPrecommit },
  }));
  return dir;
}

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

// ---------------------------------------------------------------------------
// Precommit lanes: the hooks must split exactly like lib/constants.ts
// requiresFullPrecommit — a commit accepts the fast lane, a push does not.
// ---------------------------------------------------------------------------

/** pre-push re-execs pre-commit with the stricter lane requirement set. */
function runPrePush(dir: string) {
  return spawnSync("bash", [join(ROOT, "hooks", "pre-push")], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: emptyHome } });
}

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

test("fingerprint mismatch on review → block", () => {
  const dir = makeGitRepo();
  // State says hasCodeChange=true + review READY but the fingerprint cannot
  // match the staged content.
  writeState(dir, { ...readyState(dir), review: { verdict: "READY", fingerprint: "wrong-fp", at: "t" } }, true);
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /fingerprint mismatch/);
});

// ---------------------------------------------------------------------------
// pre-commit: test-label English gate (L6) integration
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// commit-msg (PR #7 lesson 8)
// ---------------------------------------------------------------------------

function runCommitMsg(message: string, env: Record<string, string> = {}) {
  const dir = makeDir();
  const msgFile = join(dir, "COMMIT_EDITMSG");
  writeFileSync(msgFile, message);
  return spawnSync("bash", [COMMIT_MSG, msgFile], { encoding: "utf8", env: { ...process.env, ...env } });
}

test("plain conventional commit passes", () => {
  assert.equal(runCommitMsg("feat: add gate\n\nDetails.").status, 0);
});

test("FP regression: 'Generated by the maintainer' passes", () => {
  assert.equal(runCommitMsg("docs: x\n\nGenerated by the maintainer script.").status, 0);
});

test("FP regression: 'Generated by domain tooling' passes", () => {
  assert.equal(runCommitMsg("chore: x\n\nGenerated by domain tooling.").status, 0);
});

test("'Generated by AI' blocked", () => {
  assert.notEqual(runCommitMsg("feat: x\n\nGenerated by AI assistant").status, 0);
});

test("'Generated with ChatGPT' blocked (unbounded GPT)", () => {
  assert.notEqual(runCommitMsg("feat: x\n\nGenerated with ChatGPT").status, 0);
});

test("Co-Authored-By Claude blocked", () => {
  assert.notEqual(runCommitMsg("fix: y\n\nCo-Authored-By: Claude <noreply@anthropic.com>").status, 0);
});

test("robot emoji + Claude blocked", () => {
  assert.notEqual(runCommitMsg("feat: z\n\n🤖 Generated with Claude Code").status, 0);
});

test("bypass env allows AI attribution through commit-msg", () => {
  assert.equal(runCommitMsg("feat: x\n\nGenerated by AI", { REVIEW_GATE_BYPASS: "1" }).status, 0);
});

// ---------------------------------------------------------------------------
// install-git-hooks.sh: chained-original preservation across re-installs
// ---------------------------------------------------------------------------

test("P1: re-install preserves a chained original hook (incl. a path with spaces)", () => {
  // Repo whose .git dir lives under a path containing a space — the old
  // extraction (`tr -d '\" '`) destroyed such paths on re-install.
  const base = makeDir();
  const dir = join(base, "my repo");
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], { cwd: dir, stdio: "ignore" });
  // Pre-existing user hook that must survive two installer runs.
  const hooksDir = join(dir, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const sentinel = join(dir, "original-ran");
  writeFileSync(join(hooksDir, "pre-commit"), `#!/usr/bin/env bash\ntouch "${sentinel}"\n`, { mode: 0o755 });

  const first = spawnSync("bash", [INSTALL_HOOKS], { cwd: dir, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const second = spawnSync("bash", [INSTALL_HOOKS], { cwd: dir, encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);

  // After re-install the chain must still reference the backed-up original.
  const hook = readFileSync(join(hooksDir, "pre-commit"), "utf8");
  assert.match(hook, /pre-pi-review-gate/, "chained original lost on re-install");
  // Running the chained hook executes the original (sidecar absent → gate allows).
  const run = spawnSync("bash", [join(hooksDir, "pre-commit")], { cwd: dir, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(sentinel), "original hook did not run through the chain");
});
