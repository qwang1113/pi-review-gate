/**
 * THE SIX STATES — decided from structured truth, never from a screen.
 *
 * Every case here is a pure function call: a channel projection plus a pane
 * liveness reading in, one state out. That is the whole point of the
 * 2026-08-30 rewrite — the previous version of this file drew terminal text
 * and asserted on how the classifier read it, which is exactly the interface
 * that produced two thirds of three end-to-end runs' defects.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  childHealth,
  classifyChildState,
  describeChildState,
  formatChildHealth,
  isNewsworthy,
  nextRewakeDelayMs,
  REWAKE_BACKOFF_MS,
  DONE_REPORT_LIMIT,
  type ChildObservation,
} from "../lib/orchestrator-child-state.ts";
import {
  projectChannel,
  HEARTBEAT_STALE_MS,
  type ChannelRecord,
} from "../lib/orchestrator-channel.ts";

const T0 = 1_700_000_000_000;
const iso = (offsetMs = 0) => new Date(T0 + offsetMs).toISOString();

/** Build an observation from a list of records the child "wrote". */
function observe(records: ChannelRecord[], overrides: Partial<ChildObservation> = {}): ChildObservation {
  return {
    childId: "c1",
    paneAlive: true,
    projection: projectChannel(records),
    at: T0,
    ...overrides,
  };
}

function stateRecord(state: "working" | "waiting-input" | "idle" | "done", at = iso()): ChannelRecord {
  return { kind: "state", from: "child", at, state };
}

test("a child that reports `working` is working", () => {
  assert.equal(classifyChildState(observe([stateRecord("working")])), "working");
});

test("a vanished pane beats every report — a stale `working` is how a crash hides", () => {
  const observation = observe([stateRecord("working")], { paneAlive: false });
  assert.equal(classifyChildState(observation), "dead");
});

test("UNKNOWN liveness is never a death (F14)", () => {
  const observation = observe([stateRecord("working")], { paneAlive: undefined });
  assert.equal(classifyChildState(observation), "working",
    "an unreadable pane list is missing information, and a wrong death ends supervision");
});

test("an OPEN REQUEST outranks everything else that is alive", () => {
  const records: ChannelRecord[] = [
    stateRecord("working"),
    { kind: "request", from: "child", at: iso(), requestId: "r1", dialogKind: "select", title: "选一个", options: ["A"] },
  ];
  assert.equal(classifyChildState(observe(records)), "waiting-input");
});

test("a SETTLED request is no longer a question", () => {
  const records: ChannelRecord[] = [
    { kind: "request", from: "child", at: iso(), requestId: "r1", dialogKind: "select", title: "选一个", options: ["A"] },
    { kind: "request-settled", from: "child", at: iso(1), requestId: "r1", by: "human" },
    stateRecord("working", iso(2)),
  ];
  assert.equal(classifyChildState(observe(records)), "working");
});

test("R3-5: a child that FINISHED is `done`, not `working` — that silence lasted 725 seconds", () => {
  assert.equal(classifyChildState(observe([stateRecord("done")])), "done");
  assert.equal(isNewsworthy("done"), true, "a completion nobody is told about is indistinguishable from a hang");
  assert.equal(isNewsworthy("working"), false, "and only `working` means nobody has to do anything");
});

test("round-1 P1: a completion older than the CURRENT assignment is not a completion", () => {
  const records = [stateRecord("done", iso(-60_000))];
  const reassigned = observe(records, { lastAssignedAt: T0 - 1_000 });
  assert.notEqual(classifyChildState(reassigned), "done",
    "a child re-tasked after finishing must not report finished again — that hides a child that got STUCK");
});

test("a child that stopped without finishing is `idle`", () => {
  assert.equal(classifyChildState(observe([stateRecord("idle")])), "idle");
});

test("`stalled` is the one state a child cannot report: silence while its pane lives", () => {
  const long = HEARTBEAT_STALE_MS + 60_000;
  const observation = observe([stateRecord("working", iso(-long))], { at: T0 });
  assert.equal(classifyChildState(observation), "stalled");

  // Same silence, but the pane is GONE: that is a death, and death wins.
  assert.equal(classifyChildState({ ...observation, paneAlive: false }), "dead");
  // Same silence, but liveness is unmeasured: claim nothing.
  assert.equal(classifyChildState({ ...observation, paneAlive: undefined }), "working");
});

test("a freshly spawned child that has not reported yet is not `stalled`", () => {
  const observation = observe([], { lastAssignedAt: T0 - 1_000 });
  assert.equal(classifyChildState(observation), "working", "it is still inside its heartbeat budget");

  const abandoned = observe([], { lastAssignedAt: T0 - (HEARTBEAT_STALE_MS + 60_000) });
  assert.equal(classifyChildState(abandoned), "stalled",
    "but a child that never reported at all eventually IS a stall");
});

test("the health line carries what a supervisor reads first", () => {
  const records: ChannelRecord[] = [
    { kind: "state", from: "child", at: iso(-30_000), state: "working", contextPercent: 42, sessionId: "rg-child-c1" },
    { kind: "request", from: "child", at: iso(-30_000), requestId: "r1", dialogKind: "select", title: "基准分支？", options: ["A"] },
  ];
  const health = childHealth(observe(records));
  assert.equal(health.state, "waiting-input");
  assert.equal(health.quietForSeconds, 30);
  assert.equal(health.dialogTitle, "基准分支？");
  assert.equal(health.contextPercent, 42);
  assert.equal(health.sessionId, "rg-child-c1", "recovery needs the child's own session id");
});

test("the rendered snapshot names the state in words, and says so when there is nobody", () => {
  const rendered = formatChildHealth([
    { childId: "c1", state: "waiting-input", quietForSeconds: 12, dialogTitle: "选一个" },
  ]);
  assert.match(rendered, /c1/);
  assert.match(rendered, /等人回答/);
  assert.match(rendered, /12s/);
  assert.match(formatChildHealth([]), /没有存活的子会话/);
  for (const state of ["working", "waiting-input", "done", "idle", "dead", "stalled"] as const) {
    assert.ok(describeChildState(state).length > 0, `${state} must have a human name`);
  }
});

test("an unanswered thing rings again on a backoff, and a completion goes quiet", () => {
  assert.deepEqual([...REWAKE_BACKOFF_MS], [10_000, 30_000, 60_000]);
  assert.equal(nextRewakeDelayMs(0), 10_000);
  assert.equal(nextRewakeDelayMs(2), 60_000);
  assert.equal(nextRewakeDelayMs(99), 60_000, "the backoff plateaus rather than growing forever");
  assert.equal(DONE_REPORT_LIMIT, 2, "a terminal state must not drown the states that still need action");
});
