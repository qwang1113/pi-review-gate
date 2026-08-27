import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, symlinkSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { neutraliseHostGitConfig } from "./helpers/git.ts";

// 100 fixture git calls live in this file (and the hooks under test shell out
// to git themselves), so neutralise the host config once for the process.
neutraliseHostGitConfig();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRE_COMMIT = join(ROOT, "hooks", "pre-commit");
const COMMIT_MSG = join(ROOT, "hooks", "commit-msg");

/** Throwaway HOME for hermetic hook tests (the hook reads the user-global
 *  config from ~/.pi/review-gate.json). Tests that exercise the global
 *  config pass their own HOME explicitly. */
const emptyHome = mkdtempSync(join(tmpdir(), "rg-hooks-home-"));

const tempDirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-hook-"));
  tempDirs.push(dir);
  return dir;
}

// Create a git repo so the hook can compute a fingerprint.
function makeGitRepo(): string {
  const dir = makeDir();
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function writeState(dir: string, state: object, withChangedFile = false) {
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

function runPreCommit(dir: string, env: Record<string, string> = {}) {
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
const FP_VERSION = 2;

const READY = {
  schema: 1,
  fingerprintVersion: FP_VERSION,
  sessionId: "test-session",
  hasCodeChange: true,
  hasDocChange: false,
  review: { verdict: "READY", fingerprint: "x", at: "t" },
  precommit: { verdict: "PASS", fingerprint: "x", at: "t" },
  rounds: [],
  maxRounds: 10,
  bypass: { active: false, reason: null, at: null },
  updatedAt: "t",
};

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
  tempDirs.push(tmpBase);
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
  writeState(dir, READY, /*withChangedFile=*/ true);
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
  writeState(dir, { ...READY, hasCodeChange: false, hasDocChange: false });
  assert.equal(runPreCommit(dir).status, 0);
});

test("review not READY → block", () => {
  const dir = makeGitRepo();
  writeState(dir, { ...READY, review: { verdict: "PENDING", fingerprint: null, at: null } });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /review is PENDING/);
});

test("precommit NO_CHECKS_RUN → block (PR #7 lesson 3)", () => {
  const dir = makeGitRepo();
  writeState(dir, { ...READY, precommit: { verdict: "NO_CHECKS_RUN", fingerprint: null, at: "t" } });
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
  writeState(dir, { ...READY, schema: 42 });
  assert.equal(runPreCommit(dir).status, 1);
});

test("user-chosen explore mode makes hook gates advisory", () => {
  const dir = makeGitRepo();
  writeState(dir, {
    ...READY,
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
    ...READY,
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
      ...READY,
      taskMode: "normal",
      ...extra,
      review: { verdict: "PENDING", fingerprint: null, at: null },
      precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
    });
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
      ...READY,
      taskMode: "explore",
      ...extra,
      review: { verdict: "PENDING", fingerprint: null, at: null },
      precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
    });
    const res = runPreCommit(dir);
    assert.equal(res.status, 1, JSON.stringify(extra));
    assert.match(res.stderr, /review is PENDING/);
  }
});

test("SECURITY: forged taskModeSource values fail closed", () => {
  const dir = makeGitRepo();
  writeState(dir, {
    ...READY,
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
      ...READY,
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
    ...READY,
    hasCodeChange: false,
    hasDocChange: false,
    pausedQuestion: { question: "Which auth provider?", at: "t" },
  });
  assert.equal(runPreCommit(dir).status, 0);
});

test("pausedQuestion: gates unmet stay blocked even while paused (no fail-open)", () => {
  const dir = makeGitRepo();
  writeState(dir, {
    ...READY,
    review: { verdict: "PENDING", fingerprint: null, at: null },
    pausedQuestion: { question: "q", at: "t" },
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /review is PENDING/);
});

test("SECURITY: malformed pausedQuestion shapes fail closed (tampered sidecar)", () => {
  for (const bad of ["str", 42, { question: 1, at: "t" }, { question: "q" }, { at: "t" }]) {
    const dir = makeGitRepo();
    writeState(dir, { ...READY, hasCodeChange: false, hasDocChange: false, pausedQuestion: bad });
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
    ...READY,
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
    ...READY,
    review: { verdict: "PENDING", fingerprint: null, at: null },
    scopeLimit: { preexistingFiles: ["src/old.ts"], sessionFiles: ["src/new.ts"], at: "t" },
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /review is PENDING/);
});

test("sessionEditedFiles: valid shape accepted; malformed shapes fail closed", () => {
  const ok = makeGitRepo();
  writeState(ok, {
    ...READY,
    hasCodeChange: false,
    hasDocChange: false,
    sessionEditedFiles: ["src/new.ts"],
  });
  assert.equal(runPreCommit(ok).status, 0);

  for (const bad of ["str", 42, [1], ["ok", null]]) {
    const dir = makeGitRepo();
    writeState(dir, { ...READY, hasCodeChange: false, hasDocChange: false, sessionEditedFiles: bad });
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
    writeState(dir, { ...READY, hasCodeChange: false, hasDocChange: false, scopeLimit: bad });
    const res = runPreCommit(dir);
    assert.equal(res.status, 1, JSON.stringify(bad));
    assert.match(res.stderr, /shape\/verdict invalid/);
  }
});

test("explore does not bypass unknown or malformed sidecar schemas", () => {
  const unknown = makeDir();
  writeState(unknown, { ...READY, schema: 999, taskMode: "explore" });
  const unknownRes = runPreCommit(unknown);
  assert.equal(unknownRes.status, 1);
  assert.match(unknownRes.stderr, /unknown gate schema/);

  const malformed = makeDir();
  writeState(malformed, {
    ...READY,
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
  writeState(dir, { ...READY, review: { verdict: "PENDING", fingerprint: null, at: null }, bypass: { active: true, reason: "hotfix", at: "t" } });
  assert.equal(runPreCommit(dir).status, 0);
});

test("REVIEW_GATE_BYPASS=1 env → allow", () => {
  const dir = makeDir();
  writeState(dir, { ...READY, review: { verdict: "BLOCKED", fingerprint: null, at: "t" } });
  assert.equal(runPreCommit(dir, { REVIEW_GATE_BYPASS: "1" }).status, 0);
});

test("no changes tracked → allow even without verdicts", () => {
  const dir = makeDir();
  writeState(dir, {
    ...READY,
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
    ...READY,
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
  // State says hasCodeChange=true + review READY but fingerprint won't match clean repo.
  writeState(dir, { ...READY, review: { verdict: "READY", fingerprint: "wrong-fp", at: "t" } });
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
  writeState(dir, { ...READY, hasCodeChange: false, hasDocChange: false });
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
    ...READY, hasCodeChange: true,
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

const INSTALL_HOOKS = join(ROOT, "scripts", "install-git-hooks.sh");

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


// ---------------------------------------------------------------------------
// Staged/worktree divergence (P0, found by independent review)
// ---------------------------------------------------------------------------
// The fingerprint is deliberately WORKTREE-based and staging-invariant, so
// `git add` cannot invalidate a review. That leaves one gap the digest cannot
// close: `git commit` (without -a) ships the INDEX. If a path is staged with
// content A while the worktree holds the reviewed content B, the commit ships
// A even though the gate bound B — and the digest never moves. The hook must
// reject exactly that, without over-blocking the safe cases.

/** Repo with a READY sidecar bound to its CURRENT fingerprint. */
function repoBoundToCurrentFingerprint(mutate: (dir: string) => void): string {
  const dir = makeGitRepo();
  execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "x.ts"), "BASE\n");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "base"], {
    cwd: dir, stdio: "ignore",
  });
  mutate(dir);
  const fp = JSON.parse(
    execFileSync("node", [join(ROOT, "scripts", "compute-fingerprint.cjs"), dir], { encoding: "utf8" }),
  );
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), JSON.stringify({
    ...READY,
    review: { verdict: "READY", fingerprint: fp.digest, at: "t", docSync: "NOT_NEEDED" },
    precommit: { verdict: "PASS", fingerprint: fp.digest, at: "t" },
  }));
  return dir;
}

test("pre-commit blocks a path staged with content differing from the reviewed worktree", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "x.ts"), "STAGED-UNREVIEWED\n");
    execFileSync("git", ["add", "x.ts"], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, "x.ts"), "WORKTREE-REVIEWED\n"); // the reviewed version
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "a divergent staged path must block the commit");
  assert.match(res.stderr, /staged with content that differs/);
  assert.match(res.stderr, /x\.ts/);
});

test("pre-commit allows a fully staged edit (index == worktree)", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "x.ts"), "EDITED\n");
    execFileSync("git", ["add", "x.ts"], { cwd: d, stdio: "ignore" });
  });
  assert.equal(runPreCommit(dir).status, 0, "staging the reviewed content must not block");
});

test("pre-commit allows an unstaged edit (that content is not committed)", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "x.ts"), "EDITED-NOT-STAGED\n");
  });
  assert.equal(runPreCommit(dir).status, 0, "a merely dirty worktree must not block");
});

test("pre-commit allows staged and dirty paths that do not overlap", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "a.ts"), "new file\n");
    execFileSync("git", ["add", "a.ts"], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, "x.ts"), "dirty other path\n");
  });
  assert.equal(runPreCommit(dir).status, 0, "divergence must be judged per path, not globally");
});


// ROUND-5 FINDING: `git diff --name-only` does NOT list untracked files, so a
// staged DELETE whose path is then recreated in the worktree looked clean to
// the old shell-pipeline check. The commit would delete a file the review had
// just approved, with the fingerprint unchanged. Same class: a staged RENAME
// whose source path is recreated.
test("pre-commit blocks a staged delete whose path was recreated in the worktree", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    execFileSync("git", ["rm", "x.ts"], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, "x.ts"), "WORKTREE-REVIEWED\n"); // recreated, untracked
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "staged delete + worktree recreate must block");
  assert.match(res.stderr, /staged with content that differs/);
  assert.match(res.stderr, /x\.ts/);
});

test("pre-commit blocks a staged rename whose source path was recreated", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    execFileSync("git", ["mv", "x.ts", "y.ts"], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, "x.ts"), "recreated source\n");
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "staged rename + recreated source must block");
  assert.match(res.stderr, /x\.ts/);
});

test("pre-commit allows a staged delete when the file really is gone", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    execFileSync("git", ["rm", "x.ts"], { cwd: d, stdio: "ignore" });
  });
  assert.equal(runPreCommit(dir).status, 0, "a staged delete matching the worktree is safe");
});

test("pre-commit allows a clean staged rename", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    execFileSync("git", ["mv", "x.ts", "y.ts"], { cwd: d, stdio: "ignore" });
  });
  assert.equal(runPreCommit(dir).status, 0, "a rename with no recreated source is safe");
});

test("pre-commit handles paths with spaces and non-ASCII names (NUL-safe)", () => {
  const weird = "a file with spaces \u4e2d\u6587.ts";
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, weird), "STAGED\n");
    execFileSync("git", ["add", "--", weird], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, weird), "WORKTREE\n"); // diverge
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "divergence must be detected for awkward path names");
  assert.match(res.stderr, /a file with spaces/);
});


// ROUND-6 FINDING (P0): `assume-unchanged` tells git to stop reporting a
// path's worktree changes, so a status-based divergence check silently passed
// a staged blob that differed from the reviewed worktree. The checker now
// compares TREE CONTENT and clears the cache bits in its scratch index, so the
// suppression cannot hide anything.
test("pre-commit blocks divergence hidden by assume-unchanged", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "x.ts"), "STAGED-UNREVIEWED\n");
    execFileSync("git", ["add", "x.ts"], { cwd: d, stdio: "ignore" });
    execFileSync("git", ["update-index", "--assume-unchanged", "x.ts"], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, "x.ts"), "WORKTREE-REVIEWED\n");
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "assume-unchanged must not hide staged/worktree divergence");
  assert.match(res.stderr, /x\.ts/);
});

test("pre-commit blocks divergence hidden by skip-worktree", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "x.ts"), "STAGED-UNREVIEWED\n");
    execFileSync("git", ["add", "x.ts"], { cwd: d, stdio: "ignore" });
    execFileSync("git", ["update-index", "--skip-worktree", "x.ts"], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, "x.ts"), "WORKTREE-REVIEWED\n");
  });
  assert.equal(runPreCommit(dir).status, 1, "skip-worktree must not hide staged/worktree divergence");
});

// ROUND-6 FINDING (P0): the checker used to exit 0 on ANY git error, so a
// broken repo could silently disable it while the fingerprint stayed bindable.
// An installed-but-broken safety check must fail CLOSED.
//
// NOTE: this deliberately uses a CORRUPT INDEX rather than a bad
// `status.showUntrackedFiles` config. The original reproduction relied on the
// checker shelling out to `git status`; the rewrite compares trees and never
// calls it, so that config no longer fails anything — a version of this test
// written against it passed for the wrong reason (real divergence blocked it,
// not the error path). Mutation testing caught that, hence the corrupt index,
// which genuinely makes the checker's own git calls fail with NO divergence
// otherwise present.
test("staged-divergence checker fails closed when it cannot run", () => {
  const dir = makeGitRepo();
  writeFileSync(join(dir, "x.ts"), "BASE\n");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "base"], {
    cwd: dir, stdio: "ignore",
  });
  // No divergence exists; the only reason to exit non-zero is the failure path.
  writeFileSync(join(dir, ".git", "index"), "GARBAGE-NOT-AN-INDEX");
  const res = spawnSync("node", [join(ROOT, "scripts", "check-staged-divergence.cjs"), dir], { encoding: "utf8" });
  assert.equal(res.status, 1, "an unusable git state must fail closed, not report success");
  assert.match(res.stderr, /Failing closed/);
});

// README claims NUL-safety, which only a literal newline really exercises.
test("pre-commit detects divergence for a path containing a literal newline", () => {
  const weird = "weird\nname.ts";
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, weird), "STAGED\n");
    execFileSync("git", ["add", "--", weird], { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, weird), "WORKTREE\n");
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "a newline in a path must not break the NUL-delimited parsing");
  assert.match(res.stderr, /weird/);
});

// A non-git directory is not a check failure — there is nothing to check and
// nothing can be committed from it. It must not fail closed (that would brick
// the "no changes tracked" path).
test("staged-divergence checker exits 0 outside a git repository", () => {
  const dir = makeDir();
  const res = spawnSync("node", [join(ROOT, "scripts", "check-staged-divergence.cjs"), dir], { encoding: "utf8" });
  assert.equal(res.status, 0, "a non-git directory must not be treated as a check failure");
});


// ROUND-7 FINDING (P0): the checker compared only blob OIDs
// (`rev-parse <tree>:<path>`), but a git tree entry's identity is
// <mode, type, oid, path>. A staged executable bit, or a symlink<->regular-file
// type change whose object content happens to match, produced a DIFFERENT
// committable tree while the OIDs compared equal — so it shipped unreviewed
// tree metadata. The checker now compares full `ls-tree` entries.
test("pre-commit blocks a staged mode change with an identical blob", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "s.sh"), "same\n");
    execFileSync("git", ["add", "s.sh"], { cwd: d, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add script"], {
      cwd: d, stdio: "ignore",
    });
    chmodSync(join(d, "s.sh"), 0o755);
    execFileSync("git", ["add", "s.sh"], { cwd: d, stdio: "ignore" }); // stage 100755
    chmodSync(join(d, "s.sh"), 0o644);                                 // worktree 100644
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "a staged exec-bit change must block even when the blob is identical");
  assert.match(res.stderr, /s\.sh/);
});

test("pre-commit blocks a staged symlink whose worktree copy is a regular file", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    symlinkSync("target", join(d, "p"));
    execFileSync("git", ["add", "p"], { cwd: d, stdio: "ignore" }); // stage 120000
    unlinkSync(join(d, "p"));
    writeFileSync(join(d, "p"), "target");                          // worktree 100644, same bytes
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "a staged type change must block even when the object content matches");
  assert.match(res.stderr, /p/);
});

test("pre-commit allows a mode change that is staged and matches the worktree", () => {
  const dir = repoBoundToCurrentFingerprint((d) => {
    writeFileSync(join(d, "ok.sh"), "same\n");
    execFileSync("git", ["add", "ok.sh"], { cwd: d, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add"], {
      cwd: d, stdio: "ignore",
    });
    chmodSync(join(d, "ok.sh"), 0o755);
    execFileSync("git", ["add", "ok.sh"], { cwd: d, stdio: "ignore" }); // index and worktree agree
  });
  assert.equal(runPreCommit(dir).status, 0, "an exec-bit change staged to match the worktree is safe");
});


// ---------------------------------------------------------------------------
// ROUND-8 FINDING (P0): staged gitlink vs reviewed dirty submodule
// ---------------------------------------------------------------------------
// A parent tree stores only a submodule's gitlink, so the index tree and the
// worktree tree are byte-IDENTICAL whenever they agree on that OID — even when
// the submodule checkout holds different, reviewed content. Sequence: the
// submodule advances to commit B, the reviewer approves further uncommitted
// content C, then `git add sm` stages gitlink B. The parent commit publishes B
// while READY bound C, and neither the digest nor the tree comparison moves.
// (The identical-tree fast path also had to go, or this check never ran.)

/** Parent repo with a submodule, plus a READY sidecar bound to the current fp. */
function repoWithSubmodule(mutate: (parent: string, sub: string) => void): string | null {
  const parent = makeGitRepo();
  const sub = makeGitRepo();
  execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: parent, stdio: "ignore" });
  writeFileSync(join(sub, "s.ts"), "A\n");
  execFileSync("git", ["add", "s.ts"], { cwd: sub, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "A"], { cwd: sub, stdio: "ignore" });
  writeFileSync(join(parent, "app.ts"), "base\n");
  execFileSync("git", ["add", "app.ts"], { cwd: parent, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], { cwd: parent, stdio: "ignore" });
  try {
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", sub, "sm"], {
      cwd: parent, stdio: "ignore",
    });
  } catch {
    return null; // environment forbids local-path submodules
  }
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add sm"], { cwd: parent, stdio: "ignore" });
  mutate(parent, join(parent, "sm"));
  const fp = JSON.parse(
    execFileSync("node", [join(ROOT, "scripts", "compute-fingerprint.cjs"), parent], { encoding: "utf8" }),
  );
  mkdirSync(join(parent, ".pi"), { recursive: true });
  writeFileSync(join(parent, ".pi", "review-gate-state.json"), JSON.stringify({
    ...READY,
    review: { verdict: "READY", fingerprint: fp.digest, at: "t", docSync: "NOT_NEEDED" },
    precommit: { verdict: "PASS", fingerprint: fp.digest, at: "t" },
  }));
  return parent;
}

test("pre-commit blocks a staged gitlink whose submodule checkout is dirty", (t) => {
  const parent = repoWithSubmodule((_p, sm) => {
    // submodule advances to B
    writeFileSync(join(sm, "s.ts"), "B\n");
    execFileSync("git", ["add", "s.ts"], { cwd: sm, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "B"], { cwd: sm, stdio: "ignore" });
    // reviewed content C sits on top, uncommitted
    writeFileSync(join(sm, "s.ts"), "C-reviewed-dirty\n");
  });
  if (parent === null) { t.skip("submodule add unsupported in this environment"); return; }
  execFileSync("git", ["add", "sm"], { cwd: parent, stdio: "ignore" }); // stage gitlink B
  const res = runPreCommit(parent);
  assert.equal(res.status, 1, "staging a gitlink while the submodule is dirty must block");
  assert.match(res.stderr, /sm/);
});

test("pre-commit allows a clean submodule bump (gitlink staged, checkout clean)", (t) => {
  const parent = repoWithSubmodule((_p, sm) => {
    writeFileSync(join(sm, "s.ts"), "B\n");
    execFileSync("git", ["add", "s.ts"], { cwd: sm, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "B"], { cwd: sm, stdio: "ignore" });
  });
  if (parent === null) { t.skip("submodule add unsupported in this environment"); return; }
  execFileSync("git", ["add", "sm"], { cwd: parent, stdio: "ignore" });
  assert.equal(runPreCommit(parent).status, 0, "an ordinary clean submodule bump must not block");
});

test("pre-commit allows a dirty submodule when its gitlink is NOT being committed", (t) => {
  const parent = repoWithSubmodule((_p, sm) => {
    writeFileSync(join(sm, "s.ts"), "dirty but unstaged\n");
  });
  if (parent === null) { t.skip("submodule add unsupported in this environment"); return; }
  assert.equal(
    runPreCommit(parent).status, 0,
    "a dirty submodule whose gitlink is unchanged is the safe analogue of an unstaged edit",
  );
});


// ROUND-9 FINDING (P0): the submodule rule used the submodule's own
// `git status` to decide "is the checkout clean?" — repeating, one level down,
// the mistake already fixed for the parent. `assume-unchanged` /
// `skip-worktree` inside the submodule suppress its status output, so a dirty
// checkout reported clean and the unreviewed gitlink shipped anyway. The rule
// now compares the submodule's worktree TREE against the tree of the staged
// gitlink commit, which reads real content and clears those bits.
for (const bit of ["--assume-unchanged", "--skip-worktree"]) {
  test(`pre-commit blocks a staged gitlink when submodule dirt is hidden by ${bit}`, (t) => {
    const parent = repoWithSubmodule((_p, sm) => {
      writeFileSync(join(sm, "s.ts"), "B\n");
      execFileSync("git", ["add", "s.ts"], { cwd: sm, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "B"], { cwd: sm, stdio: "ignore" });
      execFileSync("git", ["update-index", bit, "s.ts"], { cwd: sm, stdio: "ignore" });
      writeFileSync(join(sm, "s.ts"), "C-reviewed-dirty\n"); // hidden from status
    });
    if (parent === null) { t.skip("submodule add unsupported in this environment"); return; }
    execFileSync("git", ["add", "sm"], { cwd: parent, stdio: "ignore" });
    const res = runPreCommit(parent);
    assert.equal(res.status, 1, `${bit} must not hide a dirty submodule checkout`);
    assert.match(res.stderr, /sm/);
  });
}

// A brand-new repository has no .git/index at all. That is not a failure —
// an empty scratch index is correct — and failing closed there would block a
// legitimate first commit.
test("staged-divergence checker exits 0 on a brand-new repo with no index", () => {
  const dir = makeGitRepo();
  rmSync(join(dir, ".git", "index"), { force: true });
  const res = spawnSync("node", [join(ROOT, "scripts", "check-staged-divergence.cjs"), dir], { encoding: "utf8" });
  assert.equal(res.status, 0, `a missing index must not fail closed: ${res.stderr}`);
});


// ROUND-10 FINDING (P0): a git tree stores only a gitlink per submodule, so an
// OUTER submodule can match its staged commit exactly while a NESTED submodule
// underneath holds different, reviewed-but-unpublished content. The check now
// recurses through every gitlink named by the published tree.
/** parent -> outer -> nested. Returns null if submodules are unsupported. */
function nestedSubmoduleRepo(): { parent: string; outerCk: string; nestedCk: string } | null {
  const commit = (cwd: string, m: string) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", m], { cwd, stdio: "ignore" });
  const addSub = (cwd: string, url: string, name: string) =>
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", url, name], { cwd, stdio: "ignore" });

  const nested = makeGitRepo();
  writeFileSync(join(nested, "i.txt"), "A\n");
  execFileSync("git", ["add", "i.txt"], { cwd: nested, stdio: "ignore" });
  commit(nested, "A");

  const outer = makeGitRepo();
  writeFileSync(join(outer, "o.txt"), "o\n");
  execFileSync("git", ["add", "o.txt"], { cwd: outer, stdio: "ignore" });
  commit(outer, "o");
  try { addSub(outer, nested, "nested"); } catch { return null; }
  commit(outer, "add nested");

  const parent = makeGitRepo();
  execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: parent, stdio: "ignore" });
  writeFileSync(join(parent, "app.ts"), "base\n");
  execFileSync("git", ["add", "app.ts"], { cwd: parent, stdio: "ignore" });
  commit(parent, "init");
  try { addSub(parent, outer, "outer"); } catch { return null; }
  commit(parent, "add outer");
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"], {
    cwd: parent, stdio: "ignore",
  });
  return { parent, outerCk: join(parent, "outer"), nestedCk: join(parent, "outer", "nested") };
}

test("staged-divergence checker blocks dirt in a NESTED submodule under a staged outer gitlink", (t) => {
  const repos = nestedSubmoduleRepo();
  if (repos === null) { t.skip("submodules unsupported in this environment"); return; }
  const { parent, outerCk, nestedCk } = repos;
  // outer advances to B...
  writeFileSync(join(outerCk, "o.txt"), "B\n");
  execFileSync("git", ["add", "o.txt"], { cwd: outerCk, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "B"], { cwd: outerCk, stdio: "ignore" });
  // ...while the NESTED checkout holds reviewed-but-unpublished content
  writeFileSync(join(nestedCk, "i.txt"), "C-reviewed-dirty\n");
  execFileSync("git", ["add", "outer"], { cwd: parent, stdio: "ignore" });

  const res = spawnSync("node", [join(ROOT, "scripts", "check-staged-divergence.cjs"), parent], { encoding: "utf8" });
  assert.equal(res.status, 1, "nested submodule dirt must not slip through an outer gitlink bump");
  assert.match(res.stderr, /outer/);
});

test("staged-divergence checker allows an outer gitlink bump when the nested submodule is clean", (t) => {
  const repos = nestedSubmoduleRepo();
  if (repos === null) { t.skip("submodules unsupported in this environment"); return; }
  const { parent, outerCk } = repos;
  writeFileSync(join(outerCk, "o.txt"), "B\n");
  execFileSync("git", ["add", "o.txt"], { cwd: outerCk, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "B"], { cwd: outerCk, stdio: "ignore" });
  execFileSync("git", ["add", "outer"], { cwd: parent, stdio: "ignore" });

  const res = spawnSync("node", [join(ROOT, "scripts", "check-staged-divergence.cjs"), parent], { encoding: "utf8" });
  assert.equal(res.status, 0, `a clean nested tree must not block: ${res.stderr}`);
});

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
  for (const script of ["compute-fingerprint.cjs", "scan-test-labels.cjs", "check-staged-divergence.cjs"]) {
    if (omit.includes(script)) continue;
    writeFileSync(join(root, "scripts", script), readFileSync(join(ROOT, "scripts", script), "utf8"));
  }
  return join(root, "hooks", "pre-commit");
}

test("MISSING staged-divergence checker → commit fails CLOSED", () => {
  const dir = makeGitRepo();
  writeState(dir, READY, /*withChangedFile=*/ true);
  const hook = installHookTree(["check-staged-divergence.cjs"]);
  const res = spawnSync("bash", [hook], { cwd: dir, encoding: "utf8" });
  assert.notEqual(res.status, 0, "a partial install must not be silently tolerated");
  assert.match(res.stderr, /staged-divergence checker MISSING/);
  assert.match(res.stderr, /failing closed/);
});

test("MISSING checker still honors an explicit bypass (escape hatch stays)", () => {
  const dir = makeGitRepo();
  writeState(dir, READY, /*withChangedFile=*/ true);
  const hook = installHookTree(["check-staged-divergence.cjs"]);
  const res = spawnSync("bash", [hook], {
    cwd: dir, encoding: "utf8", env: { ...process.env, REVIEW_GATE_BYPASS: "1" },
  });
  assert.equal(res.status, 0, "REVIEW_GATE_BYPASS=1 must remain the documented escape hatch");
});

test("MISSING L6 label scanner still only warns (style gate keeps warn-and-skip)", () => {
  const dir = makeGitRepo();
  // A bypassing sidecar isolates this to the scanner-missing branch.
  writeState(dir, { ...READY, bypass: { active: true, reason: "test", at: "t" } }, true);
  const hook = installHookTree(["scan-test-labels.cjs"]);
  const res = spawnSync("bash", [hook], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0, "a missing style scanner must never brick an older install");
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

// Classifying that failure by matching git's stderr text was wrong in BOTH
// directions: git prints "not a git repository: /missing/path" for a BROKEN
// worktree (a .git gitfile whose target is gone), which would fail open; and a
// localized git prints none of it, which would block ordinary non-repo
// directories. The decision is structural instead — exercise every branch.
// setup() may return a path to probe INSTEAD of the temp dir itself (used for
// the "inside a bare repo" case, which must be probed from a subdirectory).
const DIVERGENCE_ENTRY_CASES: Array<[string, number, (dir: string) => string | void]> = [
  ["plain directory outside any repository", 0, () => { /* nothing */ }],
  ["bare repository (no worktree to compare)", 0,
    (dir) => execFileSync("git", ["init", "--bare"], { cwd: dir, stdio: "ignore" })],
  [".git gitfile pointing at a MISSING gitdir", 1,
    (dir) => writeFileSync(join(dir, ".git"), "gitdir: /definitely/missing/review-gate-gitdir\n")],
  ["malformed .git gitfile", 1,
    (dir) => writeFileSync(join(dir, ".git"), "this is not a gitfile\n")],
  ["repository with a config git cannot parse", 1, (dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "core.bare", "definitely-not-a-bool"], { cwd: dir, stdio: "ignore" });
  }],
  // existsSync() FOLLOWS symlinks, so a dangling .git link read as "no
  // metadata" and dismissed a broken worktree as an ordinary directory.
  ["dangling .git symlink", 1,
    (dir) => symlinkSync(join(dir, "definitely", "missing", "gitdir"), join(dir, ".git"))],
  // The bare shape must be recognised at EVERY level, not just the starting
  // directory: from a subdirectory of a bare repo git cannot inspect, the
  // ancestor walk previously only looked for `.git` and found nothing.
  ["subdirectory of a bare repo git cannot parse", 1, (dir) => {
    execFileSync("git", ["init", "--bare"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "core.bare", "definitely-not-a-bool"], { cwd: dir, stdio: "ignore" });
    const deep = join(dir, "refs", "deep");
    mkdirSync(deep, { recursive: true });
    return deep;
  }],
];

for (const [label, expected, setup] of DIVERGENCE_ENTRY_CASES) {
  test(`staged-divergence entry: ${label} → exit ${expected}`, () => {
    const dir = makeDir();
    const target = setup(dir) || dir;
    const res = spawnSync("node", [join(ROOT, "scripts", "check-staged-divergence.cjs"), target], {
      encoding: "utf8",
    });
    assert.equal(res.status, expected,
      expected === 0
        ? "a verified 'nothing to check' state must not block an ordinary commit"
        : `an uninspectable repository must fail closed (stderr: ${res.stderr.slice(0, 200)})`);
  });
}

test("staged-divergence entry: a NONEXISTENT path fails closed", () => {
  const res = spawnSync("node", [
    join(ROOT, "scripts", "check-staged-divergence.cjs"), join(makeDir(), "no", "such", "dir"),
  ], { encoding: "utf8" });
  assert.equal(res.status, 1, "a path that cannot be inspected at all must not report success");
});

// Ambient git location variables must not redirect the check. Reproduced
// fail-open: with GIT_DIR/GIT_WORK_TREE pointing at a clean decoy repo, the
// checker inspected the DECOY and exited 0 while the target repo held a real
// staged-vs-worktree divergence.
test("staged-divergence checker ignores an ambient GIT_DIR/GIT_WORK_TREE", () => {
  const target = makeGitRepo();
  writeFileSync(join(target, "x.ts"), "// v1");
  execFileSync("git", ["add", "x.ts"], { cwd: target, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "c"], {
    cwd: target, stdio: "ignore",
  });
  writeFileSync(join(target, "x.ts"), "// vA");
  execFileSync("git", ["add", "x.ts"], { cwd: target, stdio: "ignore" }); // staged A
  writeFileSync(join(target, "x.ts"), "// vB");                          // worktree B

  const decoy = makeGitRepo(); // clean

  const checker = join(ROOT, "scripts", "check-staged-divergence.cjs");
  assert.equal(spawnSync("node", [checker, target], { encoding: "utf8" }).status, 1,
    "precondition: the divergence is detected with a normal environment");

  const res = spawnSync("node", [checker, target], {
    encoding: "utf8",
    env: { ...process.env, GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy },
  });
  assert.equal(res.status, 1,
    "an ambient GIT_DIR must not make the checker inspect a different repository");
});

// ---------------------------------------------------------------------------
// The index a commit ACTUALLY publishes.
//
// git stages into a TEMPORARY index for `git commit -a` and `git commit --
// <path>`, and points the hook at it via GIT_INDEX_FILE (measured:
// <gitdir>/index.lock and <gitdir>/next-index-<pid>.lock). Comparing the plain
// .git/index in those cases judges content the commit will not ship — which
// BLOCKED a safe `git commit -a` whose temporary index already equalled the
// reviewed worktree. The hook therefore forwards "${GIT_INDEX_FILE-}" and the
// checker validates that the path belongs to this repository.

/** Repo whose pre-commit forwards to the real checker, like the shipped hook. */
function repoWithForwardingHook(forwardIndex: boolean): string {
  const dir = makeDir();
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  const checker = join(ROOT, "scripts", "check-staged-divergence.cjs");
  writeFileSync(join(dir, ".git", "hooks", "pre-commit"),
    `#!/usr/bin/env bash\nexec node ${checker} "$(pwd)"${forwardIndex ? ' "${GIT_INDEX_FILE-}"' : ""}\n`);
  chmodSync(join(dir, ".git", "hooks", "pre-commit"), 0o755);
  writeFileSync(join(dir, "a.ts"), "// v1");
  execFileSync("git", ["add", "a.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "c1"], { cwd: dir, stdio: "ignore" });
  return dir;
}

/** staged A, worktree B — the state where the commit MODE decides safety. */
function stageAThenEditB(dir: string) {
  writeFileSync(join(dir, "a.ts"), "// vA");
  execFileSync("git", ["add", "a.ts"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "a.ts"), "// vB");
}

test("commit -a is ALLOWED: its temporary index equals the reviewed worktree", () => {
  const dir = repoWithForwardingHook(true);
  stageAThenEditB(dir);
  const res = spawnSync("git", ["commit", "-a", "-m", "commit-all"], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0, `commit -a must not be blocked: ${res.stderr}`);
});

test("a PLAIN commit in the same state is still BLOCKED (it would ship the staged version)", () => {
  const dir = repoWithForwardingHook(true);
  stageAThenEditB(dir);
  const res = spawnSync("git", ["commit", "-m", "plain"], { cwd: dir, encoding: "utf8" });
  assert.notEqual(res.status, 0, "publishing staged content that differs from the worktree must block");
  assert.match(res.stderr, /differs from the reviewed worktree/);
});

test("a path-limited commit of a CLEAN path is ALLOWED while another path diverges", () => {
  const dir = repoWithForwardingHook(true);
  writeFileSync(join(dir, "other.ts"), "// other v1");
  execFileSync("git", ["add", "other.ts"], { cwd: dir, stdio: "ignore" });
  stageAThenEditB(dir);
  const res = spawnSync("git", ["commit", "-m", "only-other", "--", "other.ts"], {
    cwd: dir, encoding: "utf8",
  });
  assert.equal(res.status, 0, `a path-limited commit of a clean path must not be blocked: ${res.stderr}`);
});

test("without the forwarded index those safe commits WOULD be blocked (guards the contract)", () => {
  // Pins why the hook passes the argument at all: the same state fails when the
  // checker is left to guess the plain index.
  const dir = repoWithForwardingHook(false);
  stageAThenEditB(dir);
  const res = spawnSync("git", ["commit", "-a", "-m", "commit-all"], { cwd: dir, encoding: "utf8" });
  assert.notEqual(res.status, 0,
    "if this ever passes, the forwarded-index argument has stopped being load-bearing");
});

test("the shipped pre-commit hook forwards GIT_INDEX_FILE to the divergence checker", () => {
  const hook = readFileSync(PRE_COMMIT, "utf8");
  assert.match(hook, /node "\$DIVERGENCE_SCRIPT"[^\n]*"\$\{GIT_INDEX_FILE-\}"/,
    "the hook must pass git's commit index explicitly (never via the environment)");
});

test("an index file OUTSIDE the repository is refused (ambient redirection stays impossible)", () => {
  const dir = makeGitRepo();
  writeFileSync(join(dir, "x.ts"), "// v1");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  const foreign = join(makeGitRepo(), ".git", "index");
  const res = spawnSync("node", [join(ROOT, "scripts", "check-staged-divergence.cjs"), dir, foreign], {
    encoding: "utf8",
  });
  assert.equal(res.status, 1, "an index outside this repository must fail closed");
  assert.match(res.stderr, /refusing an index file outside the repository/);
});

test("a forwarded index that is a SYMLINK out of the repository is refused", () => {
  // resolve() only normalizes text, so a symlink planted inside the git dir
  // passed the containment check while copyFileSync followed it out of the
  // repository. Containment is now decided on canonical paths.
  const target = makeGitRepo();
  writeFileSync(join(target, "x.ts"), "// v1");
  execFileSync("git", ["add", "x.ts"], { cwd: target, stdio: "ignore" });
  const decoy = makeGitRepo();
  const planted = join(target, ".git", "forwarded-index");
  symlinkSync(join(decoy, ".git", "index"), planted);

  const res = spawnSync("node", [
    join(ROOT, "scripts", "check-staged-divergence.cjs"), target, planted,
  ], { encoding: "utf8" });
  assert.equal(res.status, 1, "a symlinked foreign index must fail closed");
  assert.match(res.stderr, /refusing an index file outside the repository/);
});

test("a legitimate not-yet-created index path inside the git dir is still accepted", () => {
  // git's temporary indexes (index.lock, next-index-<pid>.lock) may not exist
  // when the checker starts, so containment must canonicalize the nearest
  // EXISTING ancestor rather than requiring the file itself.
  const dir = makeGitRepo();
  writeFileSync(join(dir, "x.ts"), "// v1");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  const future = join(dir, ".git", "next-index-99999.lock");
  const res = spawnSync("node", [
    join(ROOT, "scripts", "check-staged-divergence.cjs"), dir, future,
  ], { encoding: "utf8" });
  assert.ok(!/refusing an index file/.test(res.stderr),
    `a path inside the git dir must be accepted even before git creates it: ${res.stderr}`);
});

// ---------------------------------------------------------------------------
// FINGERPRINT ALGORITHM MIGRATION.
//
// A Pi extension is a resident process: it loads lib/fingerprint.ts once at
// session start and does not hot-reload. Right after an upgrade the extension
// therefore still writes bindings from the OLD algorithm while this hook
// already computes the NEW one, and the hook rejected the very commit the gate
// had just approved — reporting "code was modified after the last READY
// review" for a byte-identical worktree (reproduced while shipping this
// change: extension 7505ba86… vs hook 2d758793…). The hook must recognise that
// and say what to do, while still failing closed.

test("hook reports a MIGRATION (not a code change) for an unversioned binding", () => {
  const dir = makeGitRepo();
  const { fingerprintVersion, ...unversioned } = READY; // pre-migration sidecar
  void fingerprintVersion;
  writeState(dir, unversioned, /*withChangedFile=*/ true);
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "an unverifiable binding must still fail closed");
  assert.match(res.stderr, /fingerprint algorithm mismatch/);
  assert.match(res.stderr, /unversioned \(pre-migration\)/);
  assert.match(res.stderr, /code was NOT modified/);
  assert.match(res.stderr, /restart Pi/);
  assert.ok(!/code was modified after the last READY review/.test(res.stderr),
    "a migration must not be misreported as a code modification");
});

test("hook reports a MIGRATION for a binding from a different algorithm version", () => {
  const dir = makeGitRepo();
  writeState(dir, { ...READY, fingerprintVersion: FP_VERSION + 1 }, true);
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, new RegExp(`a v${FP_VERSION + 1} binding`));
  assert.match(res.stderr, /restart Pi/);
});

test("a forged non-integer fingerprintVersion is rejected by the shape check", () => {
  // Must not compare "equal" to the running version by type coercion.
  const dir = makeGitRepo();
  writeState(dir, { ...READY, fingerprintVersion: "2" }, true);
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /shape\/verdict invalid/);
});

test("no migration noise for a clean repo with no tracked changes", () => {
  // The migration check must not fire when there is nothing to gate; an
  // unversioned sidecar on an idle repo is not an error state.
  const dir = makeGitRepo();
  const { fingerprintVersion, ...unversioned } = READY;
  void fingerprintVersion;
  writeState(dir, { ...unversioned, hasCodeChange: false, hasDocChange: false });
  assert.equal(runPreCommit(dir).status, 0);
});

test("the current-version fixture does NOT take the migration path", () => {
  // Guards the fixture itself: if FP_VERSION drifts from the implementation,
  // every other hook test would silently exercise migration instead of gate
  // logic. Here the fingerprint simply mismatches, which is the normal path.
  const dir = makeGitRepo();
  writeState(dir, READY, true);
  const res = runPreCommit(dir);
  assert.ok(!/fingerprint algorithm mismatch/.test(res.stderr),
    `FP_VERSION (${FP_VERSION}) drifted from the shipped algorithm: ${res.stderr}`);
});

test("compute-fingerprint.cjs reports its algorithm version", () => {
  const dir = makeGitRepo();
  const out = JSON.parse(execFileSync("node", [
    join(ROOT, "scripts", "compute-fingerprint.cjs"), dir,
  ], { encoding: "utf8" }));
  assert.equal(out.version, FP_VERSION,
    "the hook compares against the version the running algorithm reports");
});

// ---------------------------------------------------------------------------
// ONE MATERIALIZATION PER HOOK INVOCATION.
//
// The checker needs the worktree tree to compare entries and the fingerprint
// needs a digest over the same content. Building it twice doubled the git work
// and — because a repository `clean` filter is an arbitrary program — allowed
// two passes over an UNCHANGED worktree to disagree about what it contains.
// A counting clean filter makes the number of passes directly observable.

// NOTE ON A REJECTED MEASUREMENT: counting `clean` filter invocations looked
// like the obvious way to prove "materialized once", but the count is not a
// stable observable — git re-runs the filter a variable number of times per
// pass depending on what the scratch index's stat cache still holds (measured
// on one unchanged repo: 2 invocations for the checker, 5 for the fingerprint,
// through the SAME materialization function). Asserting a count would produce
// a flaky test that fails for reasons unrelated to sharing. The property is
// therefore pinned structurally (below) plus behaviourally by the digest
// agreement test that follows.

test("the checker memoizes the worktree tree so one run materializes it once", () => {
  const src = readFileSync(join(ROOT, "scripts", "check-staged-divergence.cjs"), "utf8");
  assert.match(src, /worktreeTreeCache = new Map\(\)/,
    "the tree must be memoized per repo path, not rebuilt per caller");
  assert.match(src, /if \(!worktreeTreeCache\.has\(key\)\)[\s\S]{0,200}sharedWorktreeTreeOid\(cwd\)/,
    "a cache miss must be the ONLY path that materializes the tree");
  assert.match(src, /require\("\.\/compute-fingerprint\.cjs"\)/,
    "the checker must reuse the fingerprint's materialization, not keep a second copy");
  // Must hand over the RESOLVER, not one tree: passing a single top-level OID
  // silently degrades to a fresh materialization for every submodule (the
  // fingerprint recurses), which is where a `clean` filter could make the two
  // passes disagree. That degradation is invisible in the digest, so it needs
  // its own assertion.
  assert.match(src, /sharedCompute\([^)]*treeOidForCwd: worktreeTree/,
    "the memoized resolver must be handed to the fingerprint, not a single tree OID");
});

test("the checker fails closed if the shared fingerprint implementation is missing", () => {
  // The checker now depends on compute-fingerprint.cjs; a partial install must
  // block rather than silently fall back to a private implementation.
  const root = makeDir();
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "check-staged-divergence.cjs"),
    readFileSync(join(ROOT, "scripts", "check-staged-divergence.cjs"), "utf8"));
  const dir = makeGitRepo();
  const res = spawnSync("node", [join(root, "scripts", "check-staged-divergence.cjs"), dir], {
    encoding: "utf8",
  });
  assert.equal(res.status, 1, "a checker without its fingerprint dependency must fail closed");
  assert.match(res.stderr, /cannot load the fingerprint implementation/);
});

test("--emit-fingerprint agrees with the standalone fingerprint script", () => {
  const dir = makeGitRepo();
  writeFileSync(join(dir, "a.ts"), "// content");
  const combined = JSON.parse(spawnSync("node", [
    join(ROOT, "scripts", "check-staged-divergence.cjs"), dir, "", "--emit-fingerprint",
  ], { encoding: "utf8" }).stdout);
  const standalone = JSON.parse(execFileSync("node", [
    join(ROOT, "scripts", "compute-fingerprint.cjs"), dir,
  ], { encoding: "utf8" }));
  assert.equal(combined.digest, standalone.digest,
    "sharing the tree must not change the digest");
  assert.equal(combined.version, standalone.version);
  assert.equal(combined.head, standalone.head);
});

test("without --emit-fingerprint the checker prints nothing (older hooks keep working)", () => {
  const dir = makeGitRepo();
  writeFileSync(join(dir, "a.ts"), "// content");
  const res = spawnSync("node", [
    join(ROOT, "scripts", "check-staged-divergence.cjs"), dir,
  ], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "", "the old contract is stdout-silent");
});

test("a BLOCKED run exits nonzero BEFORE emitting a fingerprint", () => {
  // The hook keys off the exit status, never off stdout being present: a
  // blocked run must not hand it a digest that could be mistaken for approval.
  const dir = makeGitRepo();
  writeFileSync(join(dir, "x.ts"), "// v1");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "c"], {
    cwd: dir, stdio: "ignore",
  });
  writeFileSync(join(dir, "x.ts"), "// vA");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "x.ts"), "// vB");

  const res = spawnSync("node", [
    join(ROOT, "scripts", "check-staged-divergence.cjs"), dir, "", "--emit-fingerprint",
  ], { encoding: "utf8" });
  assert.equal(res.status, 1, "the divergence must still block");
  assert.match(res.stderr, /differs from the reviewed worktree/);
  assert.equal(res.stdout.trim(), "", "no fingerprint may be emitted once the commit is blocked");
});

test("the hook asks the checker for the fingerprint, with a fallback for mixed installs", () => {
  const hook = readFileSync(PRE_COMMIT, "utf8");
  assert.match(hook, /FP_JSON=\$\(node "\$DIVERGENCE_SCRIPT"[^\n]*--emit-fingerprint\)/,
    "the hook must get both answers from one process");
  assert.match(hook, /if \[\[ -z "\$FP_JSON" \]\]; then/,
    "an older checker that prints nothing must not brick the commit");
});

test("a sparse-checkout (skip-worktree) repo can now be fingerprinted at all", () => {
  // Previously `git add` aborted with "outside of your sparse-checkout
  // definition" and the whole fingerprint failed closed, so such a repo could
  // never pass the gate. Clearing the bit in the scratch index fixes it.
  const dir = makeGitRepo();
  writeFileSync(join(dir, "a.ts"), "// v1");
  execFileSync("git", ["add", "a.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "c"], {
    cwd: dir, stdio: "ignore",
  });
  execFileSync("git", ["update-index", "--skip-worktree", "a.ts"], { cwd: dir, stdio: "ignore" });

  const fp = JSON.parse(execFileSync("node", [
    join(ROOT, "scripts", "compute-fingerprint.cjs"), dir,
  ], { encoding: "utf8" }));
  assert.equal(fp.unavailable, false,
    "a skip-worktree repository must produce a usable fingerprint");
  assert.match(fp.digest, /^[0-9a-f]{40}$/);
});

test("REGRESSION: the hook installer REFUSES to run from a review snapshot", () => {
  // A review snapshot is a LINKED WORKTREE, so `.git/hooks` is the real repo's
  // hook layer, not a copy. Installing from inside one repointed the real hooks
  // at a snapshot directory that was then deleted with the round — after which
  // every commit died with "No such file or directory" from .git/hooks/pre-commit.
  // (Observed for real while committing this very change.)
  const repo = makeGitRepo();
  const snapshot = join(repo, ".pi", "review-snapshots", "rg-review-snap-XXXX", "integration");
  mkdirSync(snapshot, { recursive: true });
  // Make the snapshot path a real git worktree of the same repo, so
  // `rev-parse --show-toplevel` resolves there exactly as it does in production.
  execFileSync("git", ["worktree", "add", "--detach", "-f", snapshot, "HEAD"], {
    cwd: repo,
    stdio: "ignore",
  });

  const refused = spawnSync("bash", [join(ROOT, "scripts", "install-git-hooks.sh")], {
    cwd: snapshot,
    encoding: "utf8",
    env: { ...process.env, HOME: emptyHome },
  });
  assert.notEqual(refused.status, 0, "installing from a snapshot must FAIL");
  assert.match(refused.stderr, /refusing to install hooks from a review snapshot/);
  assert.match(refused.stderr, /shared with the real checkout/);
  // …and it must not have touched the shared hook dir.
  assert.equal(existsSync(join(repo, ".git", "hooks", "pre-commit")), false,
    "the refusal must happen BEFORE any hook is written");

  // The same installer still works from the real worktree.
  const ok = spawnSync("bash", [join(ROOT, "scripts", "install-git-hooks.sh")], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, HOME: emptyHome },
  });
  assert.equal(ok.status, 0, ok.stderr);
  const installed = readFileSync(join(repo, ".git", "hooks", "pre-commit"), "utf8");
  assert.match(installed, /pi-review-gate:installed/);
  // Assert the hook points at THIS package's real hook, by exact path.
  //
  // The obvious version of this check — `doesNotMatch(installed, /review-snapshots/)`
  // — is environment-dependent and was wrong: a reviewer runs the suite INSIDE a
  // snapshot, so ROOT itself contains `review-snapshots` and a perfectly correct
  // install then "failed". Same family as the earlier /tmp divergence: never
  // assert on a substring of the absolute path the test happens to live at.
  assert.ok(
    installed.includes(join(ROOT, "hooks", "pre-commit")),
    `the installed hook must exec this package's hook, got:\n${installed}`,
  );
  // …and never the TEST repo's snapshot copy (that is the failure being guarded).
  assert.equal(installed.includes(snapshot), false, "the hook must not point into a snapshot");

  try {
    execFileSync("git", ["worktree", "remove", "--force", snapshot], { cwd: repo, stdio: "ignore" });
  } catch { /* the dir is inside the temp repo and removed with it */ }
});
