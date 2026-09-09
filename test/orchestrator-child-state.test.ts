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
  IDLE_PROGRESS_GRACE_MS,
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

function stateRecord(state: "working" | "waiting-input" | "idle" | "done" | "mode-changed", at = iso()): ChannelRecord {
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

test("…and the child's own HEARTBEAT cannot re-date that completion (2026-09-17)", () => {
  // A finished child keeps reporting `done`: its gate rewrites the unchanged
  // state every minute with a fresh timestamp. Reading the NEWEST record made
  // the round-1 bound evaporate within a minute of re-tasking — the completion
  // of the PREVIOUS task looked newer than the assignment that replaced it.
  const records = [
    stateRecord("done", iso(-60_000)),   // it really finished, a minute ago
    stateRecord("done", iso(1_000)),     // …and its heartbeat says so again, now
  ];
  const reassigned = observe(records, { lastAssignedAt: T0 - 1_000, at: T0 + 2_000 });
  assert.notEqual(classifyChildState(reassigned), "done",
    "the bound compares the START of the `done` run, not the heartbeat that refreshed it");

  // The other direction must still hold, or the fix would simply hide every
  // completion: a genuinely NEW completion starts a new run of the state.
  const finishedAgain = observe([
    stateRecord("done", iso(-60_000)),
    stateRecord("working", iso(-30_000)),  // it took the new work…
    stateRecord("done", iso(1_000)),       // …and finished THAT
  ], { lastAssignedAt: T0 - 1_000, at: T0 + 2_000 });
  assert.equal(classifyChildState(finishedAgain), "done");
});

test("no `lastStateSince` at all (an older projection) falls back to the record's own time", () => {
  // The same two records as above — so the two readings genuinely DISAGREE:
  // the run started before the assignment, the newest record came after it.
  const records = [stateRecord("done", iso(-60_000)), stateRecord("done", iso(1_000))];
  const projection = projectChannel(records);
  assert.equal(projection.lastStateSince, iso(-60_000), "the projection normally answers this");
  delete (projection as { lastStateSince?: string }).lastStateSince;
  const observation = observe(records, { projection, lastAssignedAt: T0 - 1_000, at: T0 + 2_000 });
  assert.equal(classifyChildState(observation), "done",
    "missing information must not invent a contradiction — the record's own time still answers");
});


test("a child that stopped without finishing is `idle`", () => {
  assert.equal(classifyChildState(observe([stateRecord("idle")])), "idle");
});

test("B3 — a child that reported `idle` while STILL STEPPING FORWARD is working, not stopped", () => {
  // THE MEASURED CASE (2026-09-04). The child was reading code — bash, read,
  // bash — and `ctx.isIdle()` is true between two tool calls, so its own
  // heartbeat reported `idle` while its transcript grew 23.7KB in 45s. The
  // supervisor printed "停下了（没有 declare_done）" with "最后活动 0s 前" on
  // the SAME line: the contradicting fact was already in the record.
  const records: ChannelRecord[] = [
    { kind: "state", from: "child", at: iso(), state: "idle", lastProgressAt: iso(-3_000), contextPercent: 24 },
  ];
  assert.equal(classifyChildState(observe(records)), "working",
    "a forward step 3 seconds ago outranks the child's own `idle` reading");

  const health = childHealth(observe(records));
  assert.equal(health.progressStaleSeconds, 3);
  assert.equal(health.selfReportedIdle, true, "the overruled report stays visible to the supervisor");
  const rendered = formatChildHealth([health]);
  // THE EXACT LINE, because both halves of it are requirements: the raw signal
  // is shown (not hidden for two minutes), and it is shown in as few characters
  // as carry it (user, 2026-09-17 — this row is scanned every few minutes, one
  // per child, inside a five-block receipt). A sentence here would be a
  // regression even though it says the same thing.
  assert.match(rendered, /在干活（自上次推进 3s·自报停下未满 120s）/);
  assert.doesNotMatch(rendered, /停下了（没有 declare_done）/);
  const marker = /·自报停下未满 \d+s/.exec(rendered)![0];
  assert.ok(marker.length <= 14, `the doubt marker must stay dense, got ${marker.length} chars: ${marker}`);

  // The second half of B3's cost: `idle` is newsworthy, so every poll returned
  // instantly and `orchestrator_wait` degraded into a busy poll.
  assert.equal(isNewsworthy(classifyChildState(observe(records))), false,
    "a child that is turning the crank must not wake the orchestrator");
});

test("B3 — 120s without progress is THE USER'S threshold: past it, the child's `idle` is believed", () => {
  assert.equal(IDLE_PROGRESS_GRACE_MS, 120_000, "the user's number (2026-09-04), not a tunable magic constant");
  const at = (sinceProgressMs: number) => observe([
    { kind: "state", from: "child", at: iso(), state: "idle", lastProgressAt: iso(-sinceProgressMs) },
  ]);
  assert.equal(classifyChildState(at(IDLE_PROGRESS_GRACE_MS - 1)), "working", "one ms short of the grace");
  assert.equal(classifyChildState(at(IDLE_PROGRESS_GRACE_MS)), "idle", "the boundary itself is a real stop");
  assert.equal(classifyChildState(at(IDLE_PROGRESS_GRACE_MS + 60_000)), "idle");
  assert.equal(childHealth(at(IDLE_PROGRESS_GRACE_MS)).selfReportedIdle, undefined,
    "a believed report is not an overruled one");
});

test("B3 — an `idle` report with NO progress stamp is believed (R3-5 stays caught)", () => {
  // No stamp is NO INFORMATION, and inventing a contradiction out of it would
  // turn a genuinely stopped child — or one on an extension older than the
  // stamp — into a permanent `working`.
  assert.equal(classifyChildState(observe([stateRecord("idle")])), "idle");
  assert.equal(childHealth(observe([stateRecord("idle")])).selfReportedIdle, undefined);
});

test("B3 — the grace period never overrules a state that outranks `idle`", () => {
  const fresh = (state: "done" | "idle") => ({
    kind: "state" as const, from: "child" as const, at: iso(), state, lastProgressAt: iso(-1_000),
  });
  assert.equal(classifyChildState(observe([fresh("done")])), "done",
    "a completion is still a completion, however recently it stepped");
  // Silence beats the report either way: the heartbeat is what `stalled` is
  // the absence of, and a stale stamp cannot revive a dead extension.
  const mute = observe([{ ...fresh("idle"), at: iso(-(HEARTBEAT_STALE_MS + 60_000)) }],
    { at: T0 });
  assert.equal(classifyChildState(mute), "stalled");
  assert.equal(classifyChildState({ ...mute, paneAlive: false }), "dead");
  const asking: ChannelRecord[] = [
    fresh("idle"),
    { kind: "request", from: "child", at: iso(), requestId: "r1", dialogKind: "select", title: "选一个", options: ["A"] },
  ];
  assert.equal(classifyChildState(observe(asking)), "waiting-input");
});

test("a mode switch is reported as mode-changed and is newsworthy", () => {
  assert.equal(classifyChildState(observe([stateRecord("mode-changed")])), "mode-changed");
  assert.equal(isNewsworthy("mode-changed"), true, "a child that silently changed mode must wake the orchestrator");
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

test("E — a `working` child carries a progress reading, and it never wakes anyone", () => {
  // Heartbeat is fresh (state reported now), so the child is `working`, not
  // stalled — but its last FORWARD progress was an hour ago.
  const records: ChannelRecord[] = [
    { kind: "state", from: "child", at: iso(), state: "working", lastProgressAt: iso(-3_600_000) },
  ];
  const health = childHealth(observe(records));
  assert.equal(health.state, "working");
  assert.equal(health.progressStaleSeconds, 3600, "seconds since the last real forward step");
  // The whole point of round-5 E: it is a READING, not a wake reason.
  assert.equal(isNewsworthy("working"), false, "a progress reading must not make `working` newsworthy");
  const rendered = formatChildHealth([health]);
  assert.match(rendered, /自上次推进 3600s/);
});

test("E — the progress reading is for `working` and `idle`, never done/waiting", () => {
  // An idle child carries the reading (2026-09-09): it is the only number
  // that separates "its turn just ended" from "it stopped long ago" — the
  // heartbeat time cannot, it refreshes whether or not the child stepped.
  const idle = childHealth(observe([
    { kind: "state", from: "child", at: iso(), state: "idle", lastProgressAt: iso(-3_600_000) },
  ]));
  assert.equal(idle.state, "idle");
  assert.equal(idle.progressStaleSeconds, 3600);
  // A `working` child that never reported progress yet (booting) has no reading.
  const booting = childHealth(observe([
    { kind: "state", from: "child", at: iso(), state: "working" },
  ]));
  assert.equal(booting.progressStaleSeconds, undefined);
  // done / waiting states still carry no reading — their own clock already
  // says what a supervisor needs (stateForSeconds).
  const done = childHealth(observe([
    { kind: "state", from: "child", at: iso(), state: "done", lastProgressAt: iso(-60_000) },
  ]));
  assert.equal(done.progressStaleSeconds, undefined);
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
