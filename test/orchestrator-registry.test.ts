import test from "node:test";
import assert from "node:assert/strict";

import {
  closableChild,
  emptyRuntime,
  findChild,
  findChildByPane,
  formatChildren,
  lastChildPane,
  liveChildren,
  markChildClosed,
  markChildDone,
  newChildId,
  normalizeRuntime,
  registerChild,
  runningTaskIds,
  vanishedChildren,
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

test("running task ids drive the scheduler, and a finished child stops counting", () => {
  let runtime = runtimeWith(child({ id: "a-1", taskId: "a" }), child({ id: "b-1", taskId: "b", paneId: "%3" }));
  assert.deepEqual(runningTaskIds(runtime, ["%2", "%3"]).sort(), ["a", "b"]);
  runtime = markChildDone(runtime, "a-1", NOW);
  assert.deepEqual(runningTaskIds(runtime, ["%2", "%3"]), ["b"],
    "a child that reported done is still alive but no longer occupies its task");
});

test("the LAYOUT anchor is the newest live child, or nothing", () => {
  const runtime = runtimeWith(child({ id: "a-1", paneId: "%2" }), child({ id: "b-1", paneId: "%3" }));
  assert.equal(lastChildPane(runtime, ["%2", "%3"]), "%3", "new children stack under the last one");
  assert.equal(lastChildPane(runtime, ["%2"]), "%2", "a dead pane is not an anchor");
  assert.equal(lastChildPane(runtime, []), undefined,
    "no right column ⇒ the caller splits the orchestrator's own pane instead");
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

test("the status rendering distinguishes the four states a child can be in", () => {
  let runtime = runtimeWith(
    child({ id: "a-1", paneId: "%2" }),
    child({ id: "b-1", paneId: "%3", taskId: "b" }),
    child({ id: "c-1", paneId: "%4", taskId: "c" }),
  );
  runtime = markChildDone(runtime, "b-1", NOW);
  runtime = markChildClosed(runtime, "c-1", NOW);
  const text = formatChildren(runtime, ["%2", "%3"]);
  assert.match(text, /a-1 \[alive\]/);
  assert.match(text, /b-1 \[done（pane 仍在）\]/);
  assert.match(text, /c-1 \[closed\]/);
  assert.equal(formatChildren(emptyRuntime("orch-abc-1"), []), "（还没有开过子会话）");

  const dead = formatChildren(runtimeWith(child({ id: "d-1", paneId: "%9" })), []);
  assert.match(dead, /pane 已消失/);
});
