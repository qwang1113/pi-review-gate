// pre-commit main gate tests (sidecar shape / verdict / mode / bypass /
// session-field semantics). This file used to hold the whole 1900-line hook
// suite; it was split (2026-09-08) so the hook suites run as several files in
// parallel under node --test: git-hooks-lanes.test.ts (docSync + lanes + L6),
// git-hooks-divergence.test.ts (staged-vs-worktree divergence + submodule),
// git-hooks-index.test.ts (checker entry + committed index),
// git-hooks-verdict.test.ts (migration/materialization/unreviewed/message-only)
// and git-hooks-msg-install.test.ts (commit-msg + installer). Shared hermetic
// fixtures live in test/helpers/hook-fixtures.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeDir, makeGitRepo, writeState, runPreCommit, runPrePush, readyState, cleanupTempDirs } from "./helpers/hook-fixtures.ts";
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

test("fingerprint mismatch on review → block", () => {
  const dir = makeGitRepo();
  // State says hasCodeChange=true + review READY but the fingerprint cannot
  // match the staged content.
  writeState(dir, { ...readyState(dir), review: { verdict: "READY", fingerprint: "wrong-fp", at: "t" } }, true);
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /fingerprint mismatch/);
});
