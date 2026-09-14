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
  evaluateChildWait,
} from "../lib/orchestrator-wait.ts";
import type { SupervisionEvent } from "../lib/orchestrator-supervisor.ts";

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
