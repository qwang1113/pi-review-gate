/**
 * The two READY guards, as BEHAVIOUR.
 *
 * These lived inline in `record_review`, where tests could only assert the
 * shape of the source — and a mutation experiment showed that was worthless:
 * neutralizing the drift downgrade left the whole suite green. Extracting the
 * decision made the truth table testable, so these cases are what actually
 * keep the guards alive.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyVerdictGuards, decideSnapshotPlan } from "../lib/verdict-guards.ts";

const TREE_A = "a".repeat(40);
const TREE_B = "b".repeat(40);

test("clean round: a READY stands", () => {
  const r = applyVerdictGuards({
    verdict: "READY",
    snapshotDrifts: [],
    reviewedTree: TREE_A,
    currentTree: TREE_A,
  });
  assert.equal(r.verdict, "READY");
  assert.equal(r.driftBlocked, false);
  assert.equal(r.staleTree, undefined);
});

test("REGRESSION: snapshot drift downgrades a READY", () => {
  const r = applyVerdictGuards({
    verdict: "READY",
    snapshotDrifts: ["snapshot shard-2: DRIFTED (built aaa, ended bbb)"],
    reviewedTree: TREE_A,
    currentTree: TREE_A,
  });
  assert.equal(r.verdict, "BLOCKED", "a reviewer that verified against its own edits is not evidence");
  assert.equal(r.driftBlocked, true);
});

test("drift leaves a BLOCKED verdict exactly as it was (findings still count)", () => {
  const r = applyVerdictGuards({
    verdict: "BLOCKED",
    snapshotDrifts: ["drifted"],
    reviewedTree: TREE_A,
    currentTree: TREE_B,
  });
  assert.equal(r.verdict, "BLOCKED");
  assert.equal(r.driftBlocked, false, "nothing was downgraded — it was already blocked");
  assert.equal(r.staleTree, undefined, "no need to re-explain a verdict that already fails closed");
});

test("REGRESSION: a READY cannot bind to a tree the reviewer never saw", () => {
  // The fail-open the streaming feature would otherwise create: the agent is
  // told to fix findings WHILE the review runs, so the worktree at record time
  // can differ from what was reviewed.
  const r = applyVerdictGuards({
    verdict: "READY",
    snapshotDrifts: [],
    reviewedTree: TREE_A,
    currentTree: TREE_B,
  });
  assert.equal(r.verdict, "BLOCKED");
  assert.equal(r.driftBlocked, false, "this is the stale-tree guard, not the drift guard");
  assert.match(r.staleTree ?? "", /reviewed aaaaaaaaaaaa/);
  assert.match(r.staleTree ?? "", /worktree is now bbbbbbbbbbbb/);
});

test("REGRESSION: an unreadable current tree fails CLOSED", () => {
  // "I could not compute it" is not evidence that it matches.
  const r = applyVerdictGuards({
    verdict: "READY",
    snapshotDrifts: [],
    reviewedTree: TREE_A,
    currentTree: undefined,
  });
  assert.equal(r.verdict, "BLOCKED");
  assert.match(r.staleTree ?? "", /current tree unreadable/);
});

test("no reviewed tree recorded ⇒ the stale-tree guard stays out of the way", () => {
  // No prepare_review (or isolation unavailable): semantics revert to what they
  // were before the feature — the fingerprint binding alone.
  const r = applyVerdictGuards({ verdict: "READY", snapshotDrifts: [], currentTree: TREE_B });
  assert.equal(r.verdict, "READY");
  assert.equal(r.staleTree, undefined);
});

test("TIGHTEN-ONLY: no input combination can produce a READY that was not already READY", () => {
  const verdicts = ["READY", "BLOCKED", "NEEDS_HUMAN", "", "ready"];
  const drifts: readonly string[][] = [[], ["drifted"]];
  const trees: Array<string | undefined> = [undefined, TREE_A, TREE_B];
  for (const verdict of verdicts) {
    for (const snapshotDrifts of drifts) {
      for (const reviewedTree of trees) {
        for (const currentTree of trees) {
          const r = applyVerdictGuards({
            verdict,
            snapshotDrifts,
            ...(reviewedTree ? { reviewedTree } : {}),
            ...(currentTree ? { currentTree } : {}),
          });
          if (verdict !== "READY") {
            assert.equal(r.verdict, verdict, `verdict ${verdict} must pass through untouched`);
          } else {
            assert.ok(
              r.verdict === "READY" || r.verdict === "BLOCKED",
              "a READY may only stay READY or become BLOCKED",
            );
          }
          assert.notEqual(
            r.verdict === "READY" && verdict !== "READY",
            true,
            "nothing may be upgraded to READY",
          );
        }
      }
    }
  }
});

test("both guards can fire at once, and the reason for each is reported", () => {
  const r = applyVerdictGuards({
    verdict: "READY",
    snapshotDrifts: ["drifted"],
    reviewedTree: TREE_A,
    currentTree: TREE_B,
  });
  assert.equal(r.verdict, "BLOCKED");
  assert.equal(r.driftBlocked, true);
  // The stale-tree explanation is skipped once drift already blocked it: one
  // clear reason beats two, and the drift is the one to act on first.
  assert.equal(r.staleTree, undefined);
});

// ---------- decideSnapshotPlan ----------

test("every reviewer isolated ⇒ the plan proceeds", () => {
  assert.deepEqual(decideSnapshotPlan(["shard-1", "shard-2"], ["shard-1", "shard-2"]), {
    kind: "isolated",
  });
});

test("REGRESSION: a PARTIAL plan is refused, naming the shards that failed", () => {
  // The fail-open this prevents: keeping the successful shards would leave the
  // failed shard's files reviewed by NOBODY while the round reports full
  // coverage. (The inline version of this decision had zero test coverage —
  // setting its condition to false changed no test, which is exactly why it now
  // lives here.)
  const d = decideSnapshotPlan(["shard-1", "shard-2", "shard-3"], ["shard-1", "shard-3"]);
  assert.equal(d.kind, "partial");
  assert.deepEqual(d.kind === "partial" ? d.failedLabels : [], ["shard-2"]);
});

test("nothing isolated ⇒ 'none' (review in place, under the old rules)", () => {
  assert.deepEqual(decideSnapshotPlan(["a", "b"], []), { kind: "none" });
  // Degenerate input must not be reported as a usable isolated plan.
  assert.deepEqual(decideSnapshotPlan([], []), { kind: "none" });
});

test("a single reviewer is the common case, both ways", () => {
  assert.equal(decideSnapshotPlan(["integration"], ["integration"]).kind, "isolated");
  assert.equal(decideSnapshotPlan(["integration"], []).kind, "none");
});

test("labels are compared by identity, so a renamed snapshot counts as FAILED", () => {
  // Snapshot labels are sanitized; if a sanitized label no longer matches what
  // was requested, that reviewer has no snapshot and the plan must not pass.
  const d = decideSnapshotPlan(["a/b"], ["a-b"]);
  assert.equal(d.kind, "partial", "a mismatch must never read as fully isolated");
});
