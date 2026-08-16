/**
 * Two Pi sessions, one repo, one sidecar.
 *
 * The sidecar names a single sessionId and every writer replaces the whole
 * file, so session B's next write used to erase the READY + PASS session A had
 * just earned. Only that file is visible to the git hooks, so A's next commit
 * was rejected for a review it had actually passed — while A's own in-memory
 * state still said READY. That contradiction is what sent a real session
 * chasing a phantom "another process is resetting my sidecar" for 40 minutes.
 *
 * mergeConcurrentBindings preserves a foreign verdict, but ONLY while it still
 * describes the current worktree. These tests pin both halves: what survives,
 * and — more importantly — what must not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyState,
  mergeConcurrentBindings,
  saveSidecarPreservingConcurrent,
  type GateState,
} from "../lib/gate-state.ts";
import { DEFAULT_MAX_ROUNDS } from "../lib/constants.ts";

const DIGEST = "a".repeat(40);
const OTHER_DIGEST = "b".repeat(40);

/** A state as a session would hold it: armed, nothing achieved yet. */
function armed(sessionId: string): GateState {
  // emptyState takes (sessionId, maxRounds); omitting the second argument left
  // state.maxRounds undefined in every fixture here.
  const s = emptyState(sessionId, DEFAULT_MAX_ROUNDS);
  s.hasCodeChange = true;
  return s;
}

/** A state that already earned READY + PASS bound to `digest`. */
function approved(sessionId: string, digest: string): GateState {
  const s = armed(sessionId);
  s.review = { verdict: "READY", fingerprint: digest, at: "2026-01-01T00:00:00.000Z", docSync: "UPDATED" };
  s.precommit = { verdict: "PASS", fingerprint: digest, at: "2026-01-01T00:00:00.000Z" };
  return s;
}

test("concurrent sidecar: a foreign READY/PASS bound to the CURRENT tree survives", () => {
  const mine = armed("mine");
  const merged = mergeConcurrentBindings(mine, approved("theirs", DIGEST), () => DIGEST);

  assert.equal(merged.review.verdict, "READY");
  assert.equal(merged.review.fingerprint, DIGEST, "the binding must keep its original fingerprint");
  assert.equal(merged.review.docSync, "UPDATED");
  assert.equal(merged.precommit.verdict, "PASS");
  assert.equal(merged.sessionId, "mine", "the file stays owned by the writing session");
  assert.equal(mine.review.verdict, "PENDING", "the caller's own state must not be mutated");
});

test("concurrent sidecar: a foreign verdict bound to a DIFFERENT tree is dropped", () => {
  // The other session reviewed some earlier content; the worktree has moved on.
  const merged = mergeConcurrentBindings(armed("mine"), approved("theirs", OTHER_DIGEST), () => DIGEST);
  assert.equal(merged.review.verdict, "PENDING");
  assert.equal(merged.precommit.verdict, "NOT_RUN");
});

test("concurrent sidecar: an unverifiable digest drops the foreign verdict (fail-closed)", () => {
  for (const digest of [null, ""]) {
    const merged = mergeConcurrentBindings(armed("mine"), approved("theirs", DIGEST), () => digest);
    assert.equal(merged.review.verdict, "PENDING", `digest ${JSON.stringify(digest)} must not carry over`);
  }
});

test("concurrent sidecar: the digest is not computed unless a foreign verdict is at stake", () => {
  let calls = 0;
  const digest = () => { calls++; return DIGEST; };

  // Same session — our own previous write.
  mergeConcurrentBindings(armed("mine"), approved("mine", DIGEST), digest);
  // Foreign, but holds nothing we lack.
  mergeConcurrentBindings(approved("mine", DIGEST), armed("theirs"), digest);
  // No sidecar at all.
  mergeConcurrentBindings(armed("mine"), undefined, digest);
  assert.equal(calls, 0, "hashing the worktree on every persist would be a hot-path cost");

  mergeConcurrentBindings(armed("mine"), approved("theirs", DIGEST), digest);
  assert.equal(calls, 1);
});

test("concurrent sidecar: our own better verdict wins over the foreign one", () => {
  const mine = approved("mine", DIGEST);
  mine.review.at = "2026-02-02T00:00:00.000Z";
  const merged = mergeConcurrentBindings(mine, approved("theirs", DIGEST), () => DIGEST);
  assert.equal(merged.review.at, "2026-02-02T00:00:00.000Z");
  assert.equal(merged, mine, "no copy is needed when nothing is carried over");
});

test("concurrent sidecar: a foreign READY carries over lastReadyReview so the next round can be incremental", () => {
  const theirs = approved("theirs", DIGEST);
  theirs.lastReadyReview = { treeOid: DIGEST, files: ["src/a.ts"], at: "2026-01-01T00:00:00.000Z" };
  const mine = armed("mine");
  const merged = mergeConcurrentBindings(mine, theirs, () => DIGEST);

  assert.equal(merged.review.verdict, "READY");
  assert.deepEqual(merged.lastReadyReview, theirs.lastReadyReview,
    "the incremental-review baseline must survive the carry-over");
});

test("concurrent sidecar: our own BAD verdict is never upgraded by a foreign good one", () => {
  // Two sessions, one tree, opposite conclusions. Worst verdict wins is the
  // rule everywhere in this gate; a fingerprint match proves the other session
  // reviewed THIS tree, not that this tree is shippable. Publishing their
  // READY here would let the git hooks — which never look at sessionId — pass
  // a tree our own reviewer explicitly blocked.
  for (const verdict of ["BLOCKED", "NEEDS_HUMAN"] as const) {
    const mine = armed("mine");
    mine.review = { verdict, fingerprint: DIGEST, at: "2026-02-02T00:00:00.000Z" };
    const merged = mergeConcurrentBindings(mine, approved("theirs", DIGEST), () => DIGEST);
    assert.equal(merged.review.verdict, verdict, `a foreign READY must not overrule our ${verdict}`);
  }

  for (const verdict of ["FAIL", "NO_CHECKS_RUN"] as const) {
    const mine = armed("mine");
    mine.precommit = { verdict, fingerprint: DIGEST, at: "2026-02-02T00:00:00.000Z" };
    const merged = mergeConcurrentBindings(mine, approved("theirs", DIGEST), () => DIGEST);
    assert.equal(merged.precommit.verdict, verdict, `a foreign PASS must not overrule our ${verdict}`);
  }
});

test("concurrent sidecar: bypass, task mode and change flags never cross sessions", () => {
  const theirs = approved("theirs", DIGEST);
  theirs.bypass = { active: true, reason: "their call", at: "2026-01-01T00:00:00.000Z" };
  theirs.taskMode = "normal";
  theirs.taskModeSource = "user";
  theirs.hasCodeChange = false;
  theirs.hasDocChange = false;
  theirs.rounds = [{ round: 1, findingsTotal: 0, fingerprints: [], verdict: "READY", at: "2026-01-01T00:00:00.000Z" }];

  const merged = mergeConcurrentBindings(armed("mine"), theirs, () => DIGEST);

  assert.equal(merged.bypass.active, false, "a foreign bypass must never leak in");
  assert.equal(merged.taskMode, undefined, "a foreign advisory mode must never leak in");
  assert.equal(merged.hasCodeChange, true, "our own change flags decide what is armed");
  assert.deepEqual(merged.rounds, [], "round history belongs to the session that ran the rounds");
});

test("concurrent sidecar: the write path preserves a live verdict on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-cs-"));
  try {
    const path = join(dir, "review-gate-state.json");
    // Session A earned READY + PASS and wrote them.
    saveSidecarPreservingConcurrent(path, approved("A", DIGEST), () => DIGEST);
    // Session B persists its own (unreviewed) state over the same file.
    const b = armed("B");
    saveSidecarPreservingConcurrent(path, b, () => DIGEST);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(onDisk.sessionId, "B");
    assert.equal(onDisk.review.verdict, "READY", "the hooks must still see A's verdict for this tree");
    assert.equal(onDisk.precommit.verdict, "PASS");
    assert.equal(b.review.verdict, "PENDING", "B's in-memory gate is unchanged: B still owes a review");
    assert.ok(b.updatedAt, "the caller's own object still gets a fresh timestamp");

    // Once the tree moves on, A's binding no longer describes it: a THIRD
    // session (so the foreign-sidecar path is what is exercised, not the
    // same-session overwrite) must not republish it.
    saveSidecarPreservingConcurrent(path, approved("A", DIGEST), () => DIGEST);
    saveSidecarPreservingConcurrent(path, armed("C"), () => OTHER_DIGEST);
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(after.sessionId, "C");
    assert.equal(after.review.verdict, "PENDING");
    assert.equal(after.precommit.verdict, "NOT_RUN");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent sidecar: an unreadable sidecar degrades to a plain overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-cs2-"));
  try {
    const path = join(dir, "review-gate-state.json");
    writeFileSync(path, "{ not json");
    const mine = approved("mine", DIGEST);
    saveSidecarPreservingConcurrent(path, mine, () => DIGEST);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(onDisk.sessionId, "mine");
    assert.equal(onDisk.review.verdict, "READY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
