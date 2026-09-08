import test from "node:test";
import assert from "node:assert/strict";

import {
  closableChild,
  emptyRuntime,
  findChild,
  findChildByPane,
  formatChildren,
  liveChildren,
  markChildClosed,
  markChildAssigned,
  newChildId,
  normalizeRuntime,
  registerChild,
  runningTaskIds,
  vanishedChildren,
  withoutPlanApproval,
  type ChildSession,
  type OrchestratorRuntime,
} from "../lib/orchestrator-registry.ts";

const NOW = "2026-08-29T12:00:00.000Z";

function child(overrides: Partial<ChildSession> = {}): ChildSession {
  return { id: "a-1", taskId: "a", paneId: "%2", cwd: "/repo", createdAt: NOW, ...overrides };
}

function runtimeWith(...children: ChildSession[]): OrchestratorRuntime {
  return children.reduce(registerChild, emptyRuntime("orch-abc-1"));
}

test("a fresh runtime knows its address and owns nothing yet", () => {
  const runtime = emptyRuntime("orch-abc-1");
  assert.equal(runtime.orchestrationId, "orch-abc-1");
  assert.deepEqual(runtime.children, []);
  assert.equal(runtime.approvedPlanHash, undefined, "no approval ⇒ no spawning");
  assert.deepEqual(runtime.notify.sentAt, []);
});

test("a child id is readable and unique per spawn", () => {
  assert.match(newChildId("split-plan", 1_700_000_000_000), /^split-plan-/);
  assert.notEqual(newChildId("a", 1), newChildId("a", 2));
  assert.doesNotMatch(newChildId("a/../b", 1), /\//, "the id is safe to use in a message");
});

test("registering never mutates the runtime it was given", () => {
  const before = emptyRuntime("orch-abc-1");
  const after = registerChild(before, child());
  assert.deepEqual(before.children, [], "the input is untouched");
  assert.equal(after.children.length, 1);
  assert.equal(findChild(after, "a-1")?.paneId, "%2");
  assert.equal(findChild(after, "nope"), undefined);
  assert.equal(findChildByPane(after, "%2")?.id, "a-1");
});

test("LIVENESS IS OBSERVED: a stored child whose pane is gone is not alive", () => {
  const runtime = runtimeWith(child({ id: "a-1", paneId: "%2" }), child({ id: "b-1", taskId: "b", paneId: "%3" }));
  assert.deepEqual(liveChildren(runtime, ["%2"]).map((c) => c.id), ["a-1"]);
  assert.deepEqual(vanishedChildren(runtime, ["%2"]).map((c) => c.id), ["b-1"],
    "a pane that disappeared on its own means the child died — it must be reported, not hidden");
  assert.deepEqual(liveChildren(runtime, []).map((c) => c.id), [],
    "an unreadable pane list means nothing is PROVABLY alive");
});

test("a child the gate closed is neither alive nor 'vanished'", () => {
  const runtime = markChildClosed(runtimeWith(child()), "a-1", NOW);
  assert.deepEqual(liveChildren(runtime, ["%2"]), []);
  assert.deepEqual(vanishedChildren(runtime, []), [], "we closed it — that is not a disappearance");
});

test("running task ids drive the scheduler, and a LIVE PANE occupies its task (B4)", () => {
  let runtime = runtimeWith(child({ id: "a-1", taskId: "a" }), child({ id: "b-1", taskId: "b", paneId: "%3" }));
  assert.deepEqual(runningTaskIds(runtime, ["%2", "%3"]).sort(), ["a", "b"]);
  // Being re-tasked changes nothing about occupancy either: the pane is what
  // holds the repo, and same-repo tasks are serialized because they share ONE
  // worktree. The slot frees when the pane is CLOSED.
  runtime = markChildAssigned(runtime, "a-1", NOW);
  assert.deepEqual(runningTaskIds(runtime, ["%2", "%3"]).sort(), ["a", "b"]);
  runtime = markChildClosed(runtime, "a-1", NOW);
  assert.deepEqual(runningTaskIds(runtime, ["%2", "%3"]), ["b"],
    "only a closed (or vanished) pane gives the task back");
});

test("only a REGISTERED, open child is closable — the user's panes are unaddressable", () => {
  const runtime = runtimeWith(child());
  const unknown = closableChild(runtime, "%99");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.reason, /只能关闭由 orchestrator_spawn 开出来/);

  const ok = closableChild(runtime, "a-1");
  assert.equal(ok.ok, true);

  const closed = closableChild(markChildClosed(runtime, "a-1", NOW), "a-1");
  assert.equal(closed.ok, false);
  if (!closed.ok) assert.match(closed.reason, /已经关闭/, "an already-closed child is a no-op, not an error to retry");
});


// ---------------------------------------------------------------------------
// Reading the runtime back from the (untrusted) sidecar
// ---------------------------------------------------------------------------

const GOOD_HASH = "a".repeat(64);

test("a well-formed runtime survives a round trip", () => {
  const runtime = {
    ...runtimeWith(child({ id: "a-1" })),
    approvedPlanHash: GOOD_HASH,
    approvedPlanAt: NOW,
    ownPane: "%1",
    relay: { handoffPath: "docs/h.md", at: NOW, successorPane: "%9" },
  };
  const cleaned = normalizeRuntime(JSON.parse(JSON.stringify(runtime)), "orch-abc-1");
  assert.deepEqual(cleaned, runtime);
});

test("an approved plan's task REPO survives the sidecar round trip", () => {
  // snapshotApprovedPlan writes repo; normalizeApprovedPlan must read it
  // back (2026-09-15) — the repo decides WHICH checkout a task's child
  // writes in, so a snapshot that dropped it would misjudge a later repo
  // change as a widening (fail-closed, but wrong).
  const runtime = {
    ...runtimeWith(child()),
    approvedPlanHash: GOOD_HASH,
    approvedPlanAt: NOW,
    approvedPlan: {
      hash: GOOD_HASH,
      at: NOW,
      maxParallel: 2,
      tasks: [
        { id: "t1", dependsOn: [], execution: "serial", repo: "/other/repo" },
        { id: "t2", dependsOn: [], execution: "serial" },
      ],
    },
  };
  const cleaned = normalizeRuntime(JSON.parse(JSON.stringify(runtime)), "orch-abc-1");
  assert.deepEqual(
    cleaned?.approvedPlan?.tasks.map((t) => ({ id: t.id, repo: t.repo })),
    [
      { id: "t1", repo: "/other/repo" },
      { id: "t2", repo: undefined },
    ],
    "the repo of each approved task is read back exactly as approved",
  );
});

test("SECURITY: the orchestration ID comes from the SESSION, never from the file", () => {
  const cleaned = normalizeRuntime({ orchestrationId: "orch-forged-1", children: [] }, "orch-real-1");
  assert.equal(cleaned?.orchestrationId, "orch-real-1",
    "the id is an attention channel key — a forged one must never become an address");
});

test("SECURITY: a malformed blob loses the user's APPROVAL, not the live children", () => {
  // The approval authorizes spawning; children are what declare_done counts.
  // Dropping the approval is fail-closed (ask again); forgetting a live child
  // would be fail-OPEN (exit with work still running).
  const cleaned = normalizeRuntime({
    approvedPlanHash: GOOD_HASH,
    children: [
      { id: "a-1", taskId: "a", paneId: "%2", cwd: "/repo", createdAt: NOW },
      { id: "b-1", taskId: "b", paneId: "not-a-pane", cwd: "/repo", createdAt: NOW },
    ],
  }, "orch-abc-1");
  assert.equal(cleaned?.approvedPlanHash, undefined, "a blob we could not fully read is not an approval");
  assert.deepEqual(cleaned?.children.map((c) => c.id), ["a-1"],
    "the unaddressable child is dropped — it could not be closed or waited on anyway");
});

test("SECURITY: a forged approval hash is refused on shape alone", () => {
  for (const hash of ["not-a-hash", "", "a".repeat(63), "A".repeat(64), "../../etc"]) {
    const cleaned = normalizeRuntime({ approvedPlanHash: hash, children: [] }, "orch-abc-1");
    assert.equal(cleaned?.approvedPlanHash, undefined, `${JSON.stringify(hash)} must not read as an approval`);
  }
  assert.equal(
    normalizeRuntime({ approvedPlanHash: GOOD_HASH, children: [] }, "orch-abc-1")?.approvedPlanHash,
    GOOD_HASH,
  );
});

test("the approval LINEAGE survives a revocation — that is exactly when it is needed", () => {
  // No `approvedPlanHash` here: the approval was revoked by a widening, and
  // the lineage is what lets the next write take that widening back.
  const cleaned = normalizeRuntime({
    children: [],
    approvedPlanHistory: [GOOD_HASH, "b".repeat(64)],
  }, "orch-abc-1");
  assert.deepEqual(cleaned?.approvedPlanHistory, [GOOD_HASH, "b".repeat(64)]);
  assert.equal(cleaned?.approvedPlanHash, undefined, "and it is not an approval by itself");
});

test("SECURITY: one bad entry drops the WHOLE lineage — a half-trusted permission record is none", () => {
  for (const lineage of [
    [GOOD_HASH, "not-a-hash"],
    [GOOD_HASH, "A".repeat(64)],
    [GOOD_HASH, ""],
    [GOOD_HASH, 7],
    [GOOD_HASH, null],
    "a".repeat(64), // not even a list
    { 0: GOOD_HASH },
  ]) {
    const cleaned = normalizeRuntime({ children: [], approvedPlanHistory: lineage }, "orch-abc-1");
    assert.equal(cleaned?.approvedPlanHistory, undefined,
      `${JSON.stringify(lineage)} must not read as a permission record`);
  }
});

test("SECURITY: a blob we could not fully read loses the lineage with the approval", () => {
  const cleaned = normalizeRuntime({
    children: "not-an-array",
    approvedPlanHash: GOOD_HASH,
    approvedPlanHistory: [GOOD_HASH],
  }, "orch-abc-1");
  assert.equal(cleaned?.approvedPlanHash, undefined);
  assert.equal(cleaned?.approvedPlanHistory, undefined,
    "the doubt that drops the approval drops what could restore it");
});

test("SECURITY: a new session inherits the child REGISTRY and nothing that grants power", () => {
  // The stripping used to be spelled out at the call site in the extension,
  // which is how a newly added authorizing field rides into a session the
  // user never approved. It is one function now, and this is its contract.
  const inherited = withoutPlanApproval({
    ...runtimeWith(child()),
    approvedPlanHash: GOOD_HASH,
    approvedPlanAt: NOW,
    approvedPlanHistory: [GOOD_HASH],
    approvalAmendments: [{ at: NOW, changes: ["细化了边界"] }],
    grants: [{ scope: "sensitive-edit", grantedAt: NOW, via: "gate-grant" }],
    relay: { handoffPath: "docs/h.md", at: NOW },
    ownPane: "%9",
  });

  assert.equal(inherited.approvedPlanHash, undefined);
  assert.equal(inherited.approvedPlanAt, undefined);
  assert.equal(inherited.approvedPlan, undefined);
  assert.equal(inherited.approvalAmendments, undefined);
  assert.equal(inherited.approvedPlanHistory, undefined, "…including what could restore an approval");
  assert.ok(!("approvedPlanHistory" in inherited), "and it is gone, not present-but-undefined");

  assert.deepEqual(inherited.children.map((c) => c.id), ["a-1"], "the live panes are facts about the world");
  assert.deepEqual(inherited.grants?.map((g) => g.scope), ["sensitive-edit"], "so are the user's own grants");
  assert.equal(inherited.relay?.handoffPath, "docs/h.md");
  assert.equal(inherited.ownPane, "%9");
});


test("garbage in the notify history and the relay record is dropped, not carried", () => {
  const cleaned = normalizeRuntime({
    children: [],
    notify: { sentAt: [1, "soon", null, 3], lastByKey: { a: 1, b: "later" } },
    relay: { handoffPath: "docs/h.md" }, // no `at` ⇒ not a relay record
    ownPane: "%%",
  }, "orch-abc-1");
  assert.deepEqual(cleaned?.notify.sentAt, [1, 3]);
  assert.deepEqual(cleaned?.notify.lastByKey, { a: 1 });
  assert.equal(cleaned?.relay, undefined);
  assert.equal(cleaned?.ownPane, undefined);
});

test("a value that is not an object at all is refused outright", () => {
  for (const raw of [undefined, null, 42, "runtime", [], true]) {
    assert.equal(normalizeRuntime(raw, "orch-abc-1"), undefined, `${JSON.stringify(raw)} is not a runtime`);
  }
});

test("the status rendering distinguishes the states the REGISTRY can see", () => {
  let runtime = runtimeWith(
    child({ id: "a-1", paneId: "%2" }),
    child({ id: "b-1", paneId: "%3", taskId: "b" }),
    child({ id: "c-1", paneId: "%4", taskId: "c" }),
  );
  runtime = markChildClosed(runtime, "c-1", NOW);
  const text = formatChildren(runtime, ["%2", "%3"]);
  assert.match(text, /a-1 \[alive\]/);
  // "Finished" is NOT one of them (B4): completion lives in the child's
  // channel, and this rendering reads the registry.
  assert.match(text, /b-1 \[alive\]/);
  assert.match(text, /c-1 \[closed\]/);
  assert.equal(formatChildren(emptyRuntime("orch-abc-1"), []), "（还没有开过子会话）");

  const dead = formatChildren(runtimeWith(child({ id: "d-1", paneId: "%9" })), []);
  assert.match(dead, /pane 已消失/);
});
