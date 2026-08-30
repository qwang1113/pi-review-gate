/**
 * THE REAL COUNTER-EXAMPLE: an agent blocked for ten minutes, in a process
 * that is perfectly healthy.
 *
 * This file exists because of the one round-4 defect where DOING WHAT THE
 * GATE SAID would have made things worse. A child dispatched its own reviewer
 * and sat in `judge_wait`; its heartbeat rode on agent events, which do not
 * fire inside a turn, so the channel went quiet; 180 seconds later the
 * supervisor reported "pane 还在但已失联" and offered `interrupt` / `close`.
 * Following that advice aborts a running review round. It happened twice in
 * one run, ~14 minutes, and a human had to step in to prevent the fix.
 *
 * So every test here drives the REAL implementation with a FAKE CLOCK and a
 * FAKE CHANNEL — no tmux, no pi process, no disk — and asserts the property
 * that was violated: while the child keeps reporting, a long block is
 * `waiting-judge`, it wakes nobody, and nothing anywhere suggests
 * interrupting it. The heartbeat is what makes that reporting possible, so
 * the last test states the contrapositive too: silence still means `stalled`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

import {
  childHealth,
  classifyChildState,
  describeChildStateDetailed,
  isNewsworthy,
  type ChildObservation,
} from "../lib/orchestrator-child-state.ts";
import {
  projectChannel,
  HEARTBEAT_STALE_MS,
  type ChannelRecord,
} from "../lib/orchestrator-channel.ts";
import { decideSupervisionEvents, formatSupervisionReceipt, superviseChildren } from "../lib/orchestrator-supervisor.ts";
import { makeFakeWorld, memoryChannelIO, replyText, twoTaskPlan } from "./helpers/fake-orchestration.ts";

import type { ChildSession } from "../lib/orchestrator-registry.ts";

const T0 = Date.parse("2026-08-30T10:00:00.000Z");

/** The heartbeat's real period in the extension (10s), as a test constant. */
const HEARTBEAT_MS = 10_000;

/**
 * A child that dispatched `reviewer` at T0 and has been blocked ever since,
 * with the INDEPENDENT heartbeat re-reporting every tick — exactly what the
 * extension's timer does while the agent produces no events at all.
 */
function judgeWaitRecords(forMs: number): ChannelRecord[] {
  const records: ChannelRecord[] = [
    { kind: "state", from: "child", at: new Date(T0).toISOString(), state: "working" },
  ];
  for (let elapsed = 0; elapsed <= forMs; elapsed += HEARTBEAT_MS) {
    records.push({
      kind: "state",
      from: "child",
      at: new Date(T0 + elapsed).toISOString(),
      state: "waiting-judge",
      waitingFor: "reviewer",
    });
  }
  return records;
}

function observe(records: ChannelRecord[], atMs: number): ChildObservation {
  return {
    childId: "t2-abc",
    paneAlive: true,
    projection: projectChannel(records),
    at: T0 + atMs,
  };
}

test("a 10-minute judge wait is `waiting-judge`, never `stalled` — the round-4 P0 counter-example", () => {
  const tenMinutes = 600_000;
  assert.ok(tenMinutes > HEARTBEAT_STALE_MS, "the block must outlast the stale budget, or this proves nothing");

  const observation = observe(judgeWaitRecords(tenMinutes), tenMinutes);
  assert.equal(classifyChildState(observation), "waiting-judge");

  const health = childHealth(observation);
  assert.equal(health.waitingFor, "reviewer", "the receipt says WHAT it is waiting for");
  assert.equal(health.stateForSeconds, 600, "and for how long — the number that makes it readable");
  // The heartbeat means it is never quiet, which is the whole mechanism.
  assert.ok((health.quietForSeconds ?? Infinity) <= HEARTBEAT_MS / 1000);
});

test("the long block wakes NOBODY: `waiting-judge` is not newsworthy", () => {
  assert.equal(isNewsworthy("waiting-judge"), false);
  assert.equal(isNewsworthy("stalled"), true, "a real stall still is");
  assert.equal(isNewsworthy("waiting-input"), true, "and so is a question");

  // Driven through the real event rules, across the window that produced 12
  // useless wake-ups in the fourth run.
  const io = memoryChannelIO(() => T0);
  const child: ChildSession = {
    id: "t2-abc",
    taskId: "t2",
    paneId: "%3",
    cwd: "/repo",
    createdAt: new Date(T0).toISOString(),
  };
  let memory = {};
  let wakeups = 0;
  for (let elapsed = 0; elapsed <= 600_000; elapsed += 30_000) {
    const snapshot = superviseChildren({
      orchestrationId: "orch-test",
      children: [child],
      livePanes: new Set(["%3"]),
      io,
      at: T0 + elapsed,
    });
    // The channel is re-read from the records the heartbeat would have
    // written by now.
    snapshot.children[0]!.state = classifyChildState(observe(judgeWaitRecords(elapsed), elapsed));
    snapshot.health[0]!.state = snapshot.children[0]!.state;
    const decided = decideSupervisionEvents(snapshot, memory, T0 + elapsed);
    memory = decided.memory;
    wakeups += decided.events.length;
  }
  assert.equal(wakeups, 0, "ten minutes of healthy review work must produce zero wake-ups");
});

test("nothing in the receipt suggests interrupting a child that is waiting for its own judge", () => {
  const io = memoryChannelIO(() => T0);
  const child: ChildSession = {
    id: "t2-abc",
    taskId: "t2",
    paneId: "%3",
    cwd: "/repo",
    createdAt: new Date(T0).toISOString(),
  };
  const snapshot = superviseChildren({
    orchestrationId: "orch-test",
    children: [child],
    livePanes: new Set(["%3"]),
    io,
    at: T0 + 600_000,
  });
  snapshot.health[0] = childHealth(observe(judgeWaitRecords(600_000), 600_000));
  const receipt = formatSupervisionReceipt(snapshot);
  assert.doesNotMatch(receipt, /interrupt/, "the advice that would have cut a review round in half is gone");
  assert.match(receipt, /在等 reviewer/, "and the state is stated positively");
});

test("even a STALLED child is never told to interrupt — recover or close, nothing else", () => {
  const io = memoryChannelIO(() => T0);
  const child: ChildSession = {
    id: "t9-dead",
    taskId: "t9",
    paneId: "%9",
    cwd: "/repo",
    createdAt: new Date(T0).toISOString(),
  };
  // One report, then silence past the budget: the extension itself is gone.
  io.appendLine(
    `${process.env.HOME ?? ""}/.pi/agent/rg-channels/orch-test/t9-dead.jsonl`,
    "",
  );
  const observation: ChildObservation = {
    childId: "t9-dead",
    paneAlive: true,
    projection: projectChannel([
      { kind: "state", from: "child", at: new Date(T0).toISOString(), state: "working" },
    ]),
    at: T0 + HEARTBEAT_STALE_MS + 1000,
  };
  assert.equal(classifyChildState(observation), "stalled", "silence past the budget is still a stall");

  const snapshot = superviseChildren({
    orchestrationId: "orch-test",
    children: [child],
    livePanes: new Set(["%9"]),
    io,
    at: T0 + HEARTBEAT_STALE_MS + 1000,
  });
  snapshot.children[0]!.state = "stalled";
  snapshot.troubled = [snapshot.children[0]!];
  snapshot.health[0] = childHealth(observation);
  const receipt = formatSupervisionReceipt(snapshot);
  // `interrupt` may appear ONLY as an explicit prohibition. The old text
  // recommended it ("先 interrupt 打断它"); the new one names it to forbid it,
  // which is the difference between a supervisor that saves a review round
  // and one that ends it.
  assert.match(receipt, /\*\*不要\*\* `orchestrator_instruct\(\{mode:"interrupt"\}\)`/,
    "interrupting a gate that is not answering destroys work and fixes nothing");
  assert.equal(receipt.split("interrupt").length - 1, 1,
    "and it is mentioned exactly once — in that prohibition, nowhere else");

  assert.match(receipt, /orchestrator_recover/);
  assert.match(receipt, /orchestrator_close/);
});

test("a `waiting-judge` report that STOPS becomes stalled — the state is not a blindfold", () => {
  // The last heartbeat is older than the budget: the process died mid-wait.
  const records = judgeWaitRecords(60_000);
  const observation = observe(records, 60_000 + HEARTBEAT_STALE_MS + 1);
  assert.equal(classifyChildState(observation), "stalled");
});

test("the state clock survives the heartbeat: repeated identical reports keep the ORIGINAL start", () => {
  const projection = projectChannel(judgeWaitRecords(300_000));
  assert.equal(projection.lastStateSince, new Date(T0).toISOString(),
    "a run of identical states keeps its first timestamp, or every wait would look freshly started");
  assert.equal(projection.lastState?.state, "waiting-judge");
});

test("the rendered health line reads as reassurance, with the duration in it", () => {
  const health = childHealth(observe(judgeWaitRecords(220_000), 220_000));
  const line = describeChildStateDetailed(health);
  assert.match(line, /在等 reviewer/);
  assert.match(line, /220s/);
  assert.match(line, /别打断/);
});

test("`orchestrator_recover`'s refusal tells the orchestrator to LOOK, not to interrupt", async () => {
  // The exit criterion names this wording specifically, so it is pinned here:
  // this refusal is what a supervisor reads at the exact moment it suspects a
  // child is stuck, and the sentence it used to end with ("先 interrupt 打断
  // 它") is the one that would have cut a live review round in half.
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  const child = world.runtime().children[0]!;

  const reply = await world.call("orchestrator_recover", { childId: child.id });

  assert.equal(reply.isError, true, "a live pane is never re-opened");
  const text = replyText(reply);
  assert.match(text, /waiting-judge/, "the first thing it points at is 'it may simply be busy'");
  assert.match(text, /不要打断|别打断|不.*interrupt/,
    "and it must never suggest interrupting a child whose state it has not established");
  assert.doesNotMatch(text, /先 `orchestrator_instruct\(\{mode:"interrupt"\}\)`/,
    "the exact recommendation that caused the round-4 near-miss must not come back");
});

