/**
 * THE CHANNEL PROTOCOL — the medium the whole supervision layer now rests on.
 *
 * These tests drive the REAL implementation (`lib/orchestrator-channel.ts`,
 * `lib/orchestrator-child-channel.ts`, `lib/orchestrator-supervisor.ts`) with
 * an in-memory filesystem, a fake clock and a fake dialog. There is no tmux,
 * no pi process and no disk anywhere in this file — which is the acceptance
 * requirement for this round, and also the reason these tests can assert on
 * things a terminal-based test never could: which side answered a question,
 * what was written when nobody answered, and what a second orchestrator sees
 * when it opens the same paths.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  appendRecord,
  channelDir,
  channelPathFor,
  isStalled,
  projectChannel,
  readChannel,
  requestPayload,
  MAX_INLINE_RECORD_CHARS,
  HEARTBEAT_STALE_MS,
  type ChannelIO,
  type ChannelRecord,
} from "../lib/orchestrator-channel.ts";
import {
  acknowledgeInstruct,
  askThroughChannel,
  pendingInstructions,
  reportState,
  type ChildChannelBinding,
} from "../lib/orchestrator-child-channel.ts";
import {
  decideSupervisionEvents,
  formatSupervisionReceipt,
  superviseChildren,
  type SupervisionMemory,
} from "../lib/orchestrator-supervisor.ts";
import type { ChildSession } from "../lib/orchestrator-registry.ts";

const T0 = 1_700_000_000_000;
const ORCH = "orch-deadbeef-abc";
const HOME = "/home/test";

function memoryIO(now: () => number): ChannelIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    ensureDir() { /* implicit */ },
    appendLine(path, line) { files.set(path, (files.get(path) ?? "") + line); },
    readText(path) { return files.get(path); },
    writeText(path, text) { files.set(path, text); },
    now,
  };
}

function binding(io: ChannelIO, childId = "c1", extra: Partial<ChildChannelBinding> = {}): ChildChannelBinding {
  return {
    io,
    target: { orchestrationId: ORCH, childId, home: HOME },
    pollMs: 0,
    // A sleep that resolves immediately: the race is decided by ordering, not
    // by wall-clock time, so a test never has to spend any.
    sleep: async () => { /* immediate */ },
    ...extra,
  };
}

function child(id = "c1"): ChildSession {
  return { id, taskId: "t1", paneId: "%2", cwd: "/repo", createdAt: new Date(T0).toISOString() };
}

// ---------------------------------------------------------------------------
// The medium: isolation, records, the spill rule
// ---------------------------------------------------------------------------

test("each child has its OWN file — isolation is physical, not a filter somebody applies", () => {
  const a = channelPathFor(ORCH, "c1", HOME);
  const b = channelPathFor(ORCH, "c2", HOME);
  assert.notEqual(a, b);
  assert.ok(a.startsWith(channelDir(ORCH, HOME)), "both live under the ORCHESTRATION's directory");
  assert.ok(b.startsWith(channelDir(ORCH, HOME)));
  assert.notEqual(channelDir(ORCH, HOME), channelDir("orch-11111111-zzz", HOME),
    "another orchestration's traffic is somewhere else entirely, not merely ignored");
});

test("a channel id can never become a path", () => {
  const path = channelPathFor("../../etc", "../../passwd", HOME);
  assert.doesNotMatch(path, /\.\./);
});

test("records round-trip, and a malformed line is REPORTED rather than swallowed", () => {
  const io = memoryIO(() => T0);
  const target = { orchestrationId: ORCH, childId: "c1", home: HOME };
  appendRecord(io, target, { kind: "state", from: "child", at: new Date(T0).toISOString(), state: "working" });
  io.appendLine(channelPathFor(ORCH, "c1", HOME), "{not json\n");
  appendRecord(io, target, { kind: "state", from: "child", at: new Date(T0 + 1).toISOString(), state: "idle" });

  const read = readChannel(io, channelPathFor(ORCH, "c1", HOME));
  assert.equal(read.records.length, 2);
  assert.equal(read.malformed, 1, "a line the reader cannot parse is counted, never hidden");
  assert.equal(read.cursor, 3, "the cursor counts LINES, so a rewrite cannot silently replay history");
});

test("a cursor reads only what is NEW", () => {
  const io = memoryIO(() => T0);
  const target = { orchestrationId: ORCH, childId: "c1", home: HOME };
  const path = channelPathFor(ORCH, "c1", HOME);
  appendRecord(io, target, { kind: "state", from: "child", at: new Date(T0).toISOString(), state: "working" });
  const first = readChannel(io, path);
  appendRecord(io, target, { kind: "state", from: "child", at: new Date(T0 + 1).toISOString(), state: "idle" });
  const second = readChannel(io, path, first.cursor);
  assert.equal(second.records.length, 1);
  assert.equal((second.records[0] as { state: string }).state, "idle");
});

test("a bulky payload SPILLS to a side file so the JSONL line can never be torn", () => {
  const io = memoryIO(() => T0);
  const target = { orchestrationId: ORCH, childId: "c1", home: HOME };
  const huge = "目标".repeat(2000);
  const stored = appendRecord(io, target, {
    kind: "request", from: "child", at: new Date(T0).toISOString(),
    requestId: "r1", dialogKind: "confirm", title: "认可吗", options: ["认可"], payload: huge,
  });
  assert.equal((stored as { payload?: string }).payload, undefined, "the bulky field left the line");
  const line = io.files.get(channelPathFor(ORCH, "c1", HOME))!;
  assert.ok(line.length <= MAX_INLINE_RECORD_CHARS + 200, `the appended line stayed small: ${line.length}`);

  const read = readChannel(io, channelPathFor(ORCH, "c1", HOME));
  const record = read.records[0] as Extract<ChannelRecord, { kind: "request" }>;
  assert.equal(requestPayload(io, record), huge, "and a reader gets the whole thing back");
});

test("`outstanding` is decided by the CHILD's settle record, never by the answer", () => {
  const records: ChannelRecord[] = [
    { kind: "request", from: "child", at: "t1", requestId: "r1", dialogKind: "select", title: "q", options: ["A"] },
    { kind: "answer", from: "orchestrator", at: "t2", requestId: "r1", answer: "A" },
  ];
  const projected = projectChannel(records);
  assert.equal(projected.openRequests.length, 1,
    "an answer the child never consumed must stay pending — a recovery would otherwise drop it");
  assert.equal(projected.pendingAnswers.length, 1);

  const settled = projectChannel([
    ...records,
    { kind: "request-settled", from: "child", at: "t3", requestId: "r1", by: "orchestrator" },
  ]);
  assert.equal(settled.openRequests.length, 0);
  assert.equal(settled.pendingAnswers.length, 0);
});

test("silence while the pane lives is a stall; silence with no pane, or no pane reading, is not", () => {
  const projection = projectChannel([
    { kind: "state", from: "child", at: new Date(T0 - HEARTBEAT_STALE_MS - 1000).toISOString(), state: "working" },
  ]);
  assert.equal(isStalled(projection, true, T0), true);
  assert.equal(isStalled(projection, false, T0), false, "a dead child is dead, not stalled");
  assert.equal(isStalled(projection, undefined, T0), false, "an unreadable pane list claims nothing");
});

// ---------------------------------------------------------------------------
// The child side: the two-answer race
// ---------------------------------------------------------------------------

test("the ORCHESTRATOR answering first resolves the question AND aborts the human's dialog", async () => {
  const io = memoryIO(() => T0);
  const bind = binding(io);
  let dialogAborted = false;

  // The dialog never resolves on its own; it only reacts to the abort — which
  // is exactly how `ui.select(..., { signal })` behaves.
  const render = (signal: AbortSignal) => new Promise<string | undefined>((resolve) => {
    signal.addEventListener("abort", () => { dialogAborted = true; resolve(undefined); }, { once: true });
  });

  const asking = askThroughChannel(bind, {
    dialogKind: "select", title: "选一个", options: ["A", "B"], hasUI: true,
  }, render);

  // Play the orchestrator: find the open request and answer it.
  await Promise.resolve();
  const open = projectChannel(readChannel(io, channelPathFor(ORCH, "c1", HOME)).records).openRequests;
  assert.equal(open.length, 1, "the question is on the channel before anybody answers");
  appendRecord(io, { orchestrationId: ORCH, childId: "c1", home: HOME }, {
    kind: "answer", from: "orchestrator", at: new Date(T0).toISOString(),
    requestId: open[0]!.requestId, answer: "B",
  });

  const outcome = await asking;
  assert.equal(outcome.answer, "B");
  assert.equal(outcome.by, "orchestrator");
  assert.equal(dialogAborted, true, "the box comes off the user's screen — it is already settled");

  const settled = readChannel(io, channelPathFor(ORCH, "c1", HOME)).records
    .find((r) => r.kind === "request-settled");
  assert.ok(settled, "the settle record is what releases the other side");
  assert.equal((settled as { by: string }).by, "orchestrator");
});

test("the HUMAN answering first wins, and the settle record releases the orchestrator", async () => {
  const io = memoryIO(() => T0);
  const outcome = await askThroughChannel(binding(io), {
    dialogKind: "select", title: "选一个", options: ["A", "B"], hasUI: true,
  }, async () => "A");

  assert.equal(outcome.answer, "A");
  assert.equal(outcome.by, "human");
  const projected = projectChannel(readChannel(io, channelPathFor(ORCH, "c1", HOME)).records);
  assert.equal(projected.openRequests.length, 0,
    "the orchestrator's own wait ends instead of hanging on a question nobody will answer again");
});

test("a DISMISSED dialog settles the question rather than stranding the orchestrator", async () => {
  const io = memoryIO(() => T0);
  const outcome = await askThroughChannel(binding(io), {
    dialogKind: "select", title: "选一个", options: ["A"], hasUI: true,
  }, async () => undefined);
  assert.equal(outcome.answer, undefined);
  assert.equal(outcome.by, "dismissed");
  assert.equal(projectChannel(readChannel(io, channelPathFor(ORCH, "c1", HOME)).records).openRequests.length, 0);
});

test("with NO UI the channel answers alone — an instant `undefined` is not a person deciding", async () => {
  const io = memoryIO(() => T0);
  const bind = binding(io);
  let rendered = false;
  const asking = askThroughChannel(bind, {
    dialogKind: "select", title: "选一个", options: ["A", "B"], hasUI: false,
  }, async () => { rendered = true; return undefined; });

  await Promise.resolve();
  const open = projectChannel(readChannel(io, channelPathFor(ORCH, "c1", HOME)).records).openRequests;
  appendRecord(io, { orchestrationId: ORCH, childId: "c1", home: HOME }, {
    kind: "answer", from: "orchestrator", at: new Date(T0).toISOString(),
    requestId: open[0]!.requestId, answer: "A",
  });

  const outcome = await asking;
  assert.equal(rendered, false, "a headless child renders nothing at all");
  assert.equal(outcome.by, "orchestrator");
  assert.equal(outcome.answer, "A");
});

test("a request carries its full payload, so the orchestrator never has to look at a screen", async () => {
  const io = memoryIO(() => T0);
  const draft = "# 任务\n只改 lib/a/";
  await askThroughChannel(binding(io), {
    dialogKind: "confirm", topic: "goal-approval", title: "认可吗", options: ["认可", "不认可"],
    payload: draft, hasUI: true,
  }, async () => "认可");

  const record = readChannel(io, channelPathFor(ORCH, "c1", HOME)).records
    .find((r) => r.kind === "request") as Extract<ChannelRecord, { kind: "request" }>;
  assert.equal(record.topic, "goal-approval", "the gate labels its own dialogs — nothing is recognized by wording");
  assert.deepEqual(record.options, ["认可", "不认可"]);
  assert.equal(requestPayload(io, record), draft);
});

test("instructions are read as PENDING until acknowledged, and an ack closes them", () => {
  const io = memoryIO(() => T0);
  const bind = binding(io);
  appendRecord(io, bind.target, {
    kind: "instruct", from: "orchestrator", at: new Date(T0).toISOString(),
    instructId: "i1", mode: "followUp", text: "换个思路",
  });
  assert.equal(pendingInstructions(bind).length, 1);
  acknowledgeInstruct(bind, "i1", true, "pi.sendUserMessage");
  assert.equal(pendingInstructions(bind).length, 0);
});

test("reporting never throws, even when the filesystem does", () => {
  const broken: ChannelIO = {
    ensureDir() { throw new Error("read-only"); },
    appendLine() { throw new Error("read-only"); },
    readText() { throw new Error("read-only"); },
    writeText() { throw new Error("read-only"); },
    now: () => T0,
  };
  assert.doesNotThrow(() => reportState(binding(broken), "working"),
    "supervision is never allowed to break the child's own work");
});

// ---------------------------------------------------------------------------
// The orchestrator side: snapshot, events, receipt
// ---------------------------------------------------------------------------

test("a supervisor reads every channel once and classifies every child", () => {
  const io = memoryIO(() => T0);
  const at = new Date(T0).toISOString();
  appendRecord(io, { orchestrationId: ORCH, childId: "c1", home: HOME },
    { kind: "state", from: "child", at, state: "working" });
  appendRecord(io, { orchestrationId: ORCH, childId: "c2", home: HOME },
    { kind: "request", from: "child", at, requestId: "r1", dialogKind: "select", title: "问题", options: ["A"] });

  const snapshot = superviseChildren({
    orchestrationId: ORCH,
    children: [child("c1"), { ...child("c2"), paneId: "%3" }],
    livePanes: new Set(["%2", "%3"]),
    io, home: HOME, at: T0,
  });
  assert.equal(snapshot.children.length, 2);
  assert.equal(snapshot.health.find((h) => h.childId === "c1")!.state, "working");
  assert.equal(snapshot.health.find((h) => h.childId === "c2")!.state, "waiting-input");
  assert.equal(snapshot.requests.length, 1);
  assert.equal(snapshot.requests[0]!.childId, "c2");
});

test("a state CHANGE is always news; an unchanged question re-rings on the backoff", () => {
  const io = memoryIO(() => T0);
  appendRecord(io, { orchestrationId: ORCH, childId: "c1", home: HOME }, {
    kind: "request", from: "child", at: new Date(T0).toISOString(),
    requestId: "r1", dialogKind: "select", title: "问题", options: ["A"],
  });
  const snapshot = (at: number) => superviseChildren({
    orchestrationId: ORCH, children: [child()], livePanes: new Set(["%2"]), io, home: HOME, at,
  });

  let memory: SupervisionMemory = {};
  const first = decideSupervisionEvents(snapshot(T0), memory, T0);
  assert.equal(first.events.length, 1, "a new waiting-input is news");
  memory = first.memory;

  const immediate = decideSupervisionEvents(snapshot(T0 + 1000), memory, T0 + 1000);
  assert.equal(immediate.events.length, 0, "one second later is noise, not news");
  memory = immediate.memory;

  const later = decideSupervisionEvents(snapshot(T0 + 11_000), memory, T0 + 11_000);
  assert.equal(later.events.length, 1, "but an unanswered question must ring again — 10s is the first step");
});

test("a completion rings at most twice and then stays quiet", () => {
  const io = memoryIO(() => T0);
  appendRecord(io, { orchestrationId: ORCH, childId: "c1", home: HOME },
    { kind: "state", from: "child", at: new Date(T0).toISOString(), state: "done" });
  const snapshot = (at: number) => superviseChildren({
    orchestrationId: ORCH, children: [child()], livePanes: new Set(["%2"]), io, home: HOME, at,
    staleMs: 10 * 60_000,
  });

  let memory: SupervisionMemory = {};
  let rings = 0;
  for (const offset of [0, 61_000, 122_000, 183_000]) {
    const decided = decideSupervisionEvents(snapshot(T0 + offset), memory, T0 + offset);
    rings += decided.events.length;
    memory = decided.memory;
  }
  assert.equal(rings, 2, "a terminal state is reported twice, then it stops shouting");
});

test("`working` is the ONE state nobody has to be woken for", () => {
  const io = memoryIO(() => T0);
  appendRecord(io, { orchestrationId: ORCH, childId: "c1", home: HOME },
    { kind: "state", from: "child", at: new Date(T0).toISOString(), state: "working" });
  const snapshot = superviseChildren({
    orchestrationId: ORCH, children: [child()], livePanes: new Set(["%2"]), io, home: HOME, at: T0,
  });
  assert.equal(decideSupervisionEvents(snapshot, {}, T0).events.length, 0);
});

test("the receipt prints the question, the options and the recovery action, all structured", () => {
  const io = memoryIO(() => T0);
  const at = new Date(T0).toISOString();
  appendRecord(io, { orchestrationId: ORCH, childId: "c1", home: HOME }, {
    kind: "request", from: "child", at, requestId: "r1", dialogKind: "select",
    title: "基准分支用哪个？", options: ["用 main", "拉一条 dev"], payload: "工作区有 3 个改动",
  });
  const snapshot = superviseChildren({
    orchestrationId: ORCH,
    children: [child(), { ...child("c2"), paneId: "%9" }],
    livePanes: new Set(["%2"]),
    io, home: HOME, at: T0,
    assetsFor: () => ({ branch: "feat/x", reviewVerdict: "READY" }),
  });
  const text = formatSupervisionReceipt(snapshot);
  assert.match(text, /基准分支用哪个？/);
  assert.match(text, /1\. 用 main/);
  assert.match(text, /工作区有 3 个改动/);
  assert.match(text, /c2/, "the dead child is named");
  assert.match(text, /feat\/x/, "with what survived it");
  assert.match(text, /orchestrator_recover/, "and the action that brings it back");
});

test("a SECOND orchestrator opening the same paths sees exactly the same thing", () => {
  // The handover guarantee, expressed as an equality. A channel belongs to a
  // path, not to a process, so "taking over" is opening the same files.
  const io = memoryIO(() => T0);
  appendRecord(io, { orchestrationId: ORCH, childId: "c1", home: HOME }, {
    kind: "request", from: "child", at: new Date(T0).toISOString(),
    requestId: "r1", dialogKind: "select", title: "问题", options: ["A"],
  });
  const read = () => superviseChildren({
    orchestrationId: ORCH, children: [child()], livePanes: new Set(["%2"]), io, home: HOME, at: T0,
  });
  assert.deepEqual(read().requests, read().requests);
  assert.equal(read().requests[0]!.title, "问题",
    "nothing about the successor's identity changes what the channel says");
});

// ---------------------------------------------------------------------------
// STOP-FIRST (2026-09-01): an instruct interrupt dismisses an open dialog
// ---------------------------------------------------------------------------

test("an instruct interrupt dismisses an open dialog as INTERRUPTED, not as a human dismissal", async () => {
  const io = memoryIO(() => T0);
  const bind = binding(io);
  const interrupt = new AbortController();
  let dialogAborted = false;
  const render = (signal: AbortSignal) => new Promise<string | undefined>((resolve) => {
    signal.addEventListener("abort", () => { dialogAborted = true; resolve(undefined); }, { once: true });
  });

  const asking = askThroughChannel(bind, {
    dialogKind: "confirm", topic: "goal-approval", title: "认可目标吗", options: ["认可", "不认可"], hasUI: true,
  }, render, interrupt.signal);

  await Promise.resolve();
  const open = projectChannel(readChannel(io, channelPathFor(ORCH, "c1", HOME)).records).openRequests;
  assert.equal(open.length, 1, "the goal box is waiting");

  // The orchestrator interrupts instead of answering.
  interrupt.abort();
  const outcome = await asking;

  assert.equal(outcome.answer, undefined);
  assert.equal(outcome.by, "interrupted", "an interrupt is not a rejection");
  assert.equal(dialogAborted, true, "the box came off the screen");
  const settled = readChannel(io, channelPathFor(ORCH, "c1", HOME)).records
    .find((r) => r.kind === "request-settled");
  assert.ok(settled, "the request is settled, so the supervisor's wait ends");
  assert.equal((settled as { by: string }).by, "interrupted");
  assert.equal(projectChannel(readChannel(io, channelPathFor(ORCH, "c1", HOME)).records).openRequests.length, 0,
    "no request is left open for the child to wedge on");
});

test("an interrupt fired BEFORE the dialog opened does not kill a later dialog", async () => {
  const io = memoryIO(() => T0);
  // The drain aborted the OLD controller and installed a FRESH one.
  const oldController = new AbortController();
  oldController.abort();
  const freshController = new AbortController();
  const outcome = await askThroughChannel(binding(io), {
    dialogKind: "select", title: "选一个", options: ["A", "B"], hasUI: true,
  }, async () => "A", freshController.signal);

  assert.equal(outcome.answer, "A");
  assert.equal(outcome.by, "human", "a later dialog is not dismissed by an interrupt that already fired");
});

test("a render that NEVER resolves cannot hang a settled question (P1 pin)", async () => {
  const io = memoryIO(() => T0);
  const interrupt = new AbortController();
  // The measured deadlock's shape: a dialog whose render ignores its abort
  // signal and never settles. The decision must still complete.
  const neverResolving = new Promise<string | undefined>(() => {});
  const asking = askThroughChannel(binding(io), {
    dialogKind: "confirm", title: "永远不关的框", options: ["A"], hasUI: true,
  }, () => neverResolving, interrupt.signal);

  await Promise.resolve();
  interrupt.abort();
  const outcome = await Promise.race([
    asking,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("askThroughChannel hung on a never-resolving render")), 200)),
  ]);
  assert.equal(outcome.by, "interrupted",
    "the interrupt settles the question even though the render never resolves");
  const settled = readChannel(io, channelPathFor(ORCH, "c1", HOME)).records
    .find((r) => r.kind === "request-settled");
  assert.ok(settled, "the settle record is written without waiting for the render");
});
