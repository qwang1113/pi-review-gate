/**
 * WAIT CRITERIA — when a blocking `orchestrator_wait` is over, and how long it
 * may block.
 *
 * These pins used to live in test/orchestrator-relay.test.ts, beside the
 * handover preconditions they have nothing to do with. The handover side moved
 * to test/session-inheritance.test.ts and test/session-handoff-tools.test.ts;
 * this file keeps the wait's own rules where their subject is.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CHILD_WAIT_DEFAULT_MS,
  CHILD_WAIT_MAX_MS,
  clampChildWaitTimeout,
  dueRequests,
  evaluateChildWait,
} from "../lib/orchestrator-wait.ts";
import { REWAKE_BACKOFF_MS } from "../lib/orchestrator-child-state.ts";
import type { PendingRequest, SupervisionEvent } from "../lib/orchestrator-supervisor.ts";

function question(childId: string, requestId: string): PendingRequest {
  return {
    childId,
    requestId,
    dialogKind: "select",
    title: "pick",
    options: ["a", "b"],
    askedAt: new Date(0).toISOString(),
  };
}

function supervision(summary: string): SupervisionEvent {
  return { childId: "c1", state: "waiting-input", summary };
}

test("a supervision event is the most informative outcome, so it wins", () => {
  const decision = evaluateChildWait({
    events: [supervision("c1 在等回答：「等待回答提问」")], paneAlive: true,
  });
  assert.equal(decision.done, true);
  assert.equal(decision.reason, "supervision");
  assert.match(decision.summary, /等待回答提问/, "the summary carries what the child actually asked for");
  assert.equal(decision.childId, "c1");
});

test("a finished child does NOT exit — 'done' arrives as an EVENT, not a process end", () => {
  // B4: there is no separate `child-done` criterion any more. Completion is
  // newsworthy, so the supervisor manufactures an event for it — one reading
  // (the channel), one answer. The old second criterion read a registry field
  // nothing wrote, which is how one receipt managed to say "已完成" and "还有
  // 1 个子会话活着" about the same child.
  const decision = evaluateChildWait({
    events: [{ childId: "c1", state: "done", summary: "c1：已完成" }],
    paneAlive: true,
  });
  assert.equal(decision.done, true);
  assert.equal(decision.reason, "supervision");
  assert.equal(decision.childId, "c1");
  assert.match(decision.summary, /已完成/,
    "waiting for the process to end here would hang forever — that is why the criteria differ from a judge's");
});

test("a vanished pane ends the wait instead of burning the whole budget", () => {
  const decision = evaluateChildWait({ paneAlive: false });
  assert.equal(decision.done, true);
  assert.equal(decision.reason, "pane-gone");
  assert.match(decision.summary, /多半没做完/);
});

test("nothing yet is not an end state, and the note becomes the live snapshot", () => {
  const decision = evaluateChildWait({ paneAlive: true, note: "子会话 a-1 仍在 pane %2" });
  assert.equal(decision.done, false);
  assert.equal(decision.reason, "pending");
  assert.equal(decision.summary, "子会话 a-1 仍在 pane %2");
});

test("news that arrived on the same probe travels together, led by the question", () => {
  // Quality round 2, P1: the probe marks its events reported in the SHARED
  // memory, so an event dropped on the way out is an event nobody announces —
  // not this reply, and not the background timer either.
  const decision = evaluateChildWait({
    events: [{ childId: "c2", state: "done", summary: "c2：已完成" }],
    pendingRequests: [question("c1", "r1")],
    paneAlive: true,
  });
  assert.equal(decision.reason, "pending-request", "the blocked child leads");
  assert.equal(decision.childId, "c1");
});

test("an unanswered question is due at once, then on the documented backoff", () => {
  const open = [question("c1", "r1")];
  const first = dueRequests({ open, announced: [], at: 1_000 });
  assert.deepEqual(first.due.map((r) => r.requestId), ["r1"], "never announced ⇒ due immediately");
  assert.deepEqual(first.memory, [{ requestId: "r1", at: 1_000, reports: 1 }]);

  // One second later it is the same news, and waking the manager again would
  // turn one dialog into a busy poll.
  assert.deepEqual(dueRequests({ open, announced: first.memory, at: 2_000 }).due, []);

  // The first backoff step is 10s — the SAME rhythm the event path uses.
  const second = dueRequests({ open, announced: first.memory, at: 1_000 + REWAKE_BACKOFF_MS[0]! });
  assert.deepEqual(second.due.map((r) => r.requestId), ["r1"], "an unanswered question is not forgotten");
  assert.equal(second.memory[0]!.reports, 2);
});

test("a question that is no longer open leaves the record by itself", () => {
  // The child settled r1 and asked r2 — a second question inside one interview
  // is NOT a change of state, which is why the event path could not see it.
  const announced = [{ requestId: "r1", at: 1_000, reports: 1 }];
  const settled = dueRequests({ open: [question("c1", "r2")], announced, at: 1_500 });
  assert.deepEqual(settled.due.map((r) => r.requestId), ["r2"]);
  assert.deepEqual(settled.memory.map((a) => a.requestId), ["r2"],
    "the answered one is pruned — the record cannot grow without bound");
});

test("a wait scoped to one child leaves its siblings' questions owed", () => {
  const open = [question("c1", "r1"), question("c2", "r2")];
  const scoped = dueRequests({ open, announced: [], at: 1_000, childId: "c1" });
  assert.deepEqual(scoped.due.map((r) => r.requestId), ["r1"]);
  assert.deepEqual(scoped.memory.map((a) => a.requestId), ["r1"],
    "c2's question was never announced, so the next unscoped wait still owes it");
  assert.deepEqual(
    dueRequests({ open, announced: scoped.memory, at: 1_100, childId: "c2" }).due.map((r) => r.requestId),
    ["r2"],
  );
});

test("the wait budget is clamped to a sane window", () => {
  assert.equal(clampChildWaitTimeout(undefined), CHILD_WAIT_DEFAULT_MS);
  assert.equal(clampChildWaitTimeout("soon"), CHILD_WAIT_DEFAULT_MS);
  // 0 is the SNAPSHOT mode that absorbed `orchestrator_status` — it is passed
  // through rather than clamped up to a 1s busy-poll, and so is anything
  // meaningless-but-non-blocking.
  assert.equal(clampChildWaitTimeout(0), 0);
  assert.equal(clampChildWaitTimeout(-1), 0);

  assert.equal(clampChildWaitTimeout(10 ** 12), CHILD_WAIT_MAX_MS);
  assert.equal(clampChildWaitTimeout(60_000), 60_000);
});
