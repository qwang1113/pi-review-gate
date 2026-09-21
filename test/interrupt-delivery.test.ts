/**
 * STOP, THEN SPEAK — the interrupt handoff (2026-09-21).
 *
 * The measured bug this file exists for: two judges of one round sat frozen for
 * 552 seconds, their panes alive, their transcripts ending on `Operation
 * aborted` + a steering message nobody would ever read. The dispatch had been
 * delivered into a queue that the abort's own end-of-run skipped draining.
 *
 * What each test pins is one clause of the fix, and the clauses are the ORDER:
 * request the stop, WAIT for it, then speak in the form that starts a round —
 * and never drop the text when the wait does not succeed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INTERRUPT_IDLE_WAIT_MS,
  INTERRUPT_POLL_MS,
  ROUND_SILENT_MS,
  deliverInterrupt,
  roundLooksUnstarted,
  waitForIdle,
} from "../lib/interrupt-delivery.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/**
 * A world with a clock the test moves by hand: `idleAfter` is when the pane
 * stops streaming, measured from the call. Nothing here sleeps for real — the
 * timing contract is the thing under test, and a test that took 30 seconds to
 * prove a 30-second bound would not be run.
 */
function makeWorld(opts: { idleAfter?: number; waitMs?: number; sendNowThrows?: boolean } = {}) {
  const idleAfter = opts.idleAfter ?? 0;
  const calls: string[] = [];
  let at = 0;
  const isIdle = () => at >= idleAfter;
  const world = {
    abort: () => { calls.push("abort"); },
    isIdle,
    sendNow: (text: string) => {
      if (opts.sendNowThrows) throw new Error("agent is streaming");
      calls.push(`now:${text}`);
    },
    sleep: async (ms: number) => { at += ms; },
    now: () => at,
    waitMs: opts.waitMs ?? 1_000,
    pollMs: 10,
  };
  return { world, calls };
}

test("the abort is requested FIRST, and the text waits for the pane to stop", async () => {
  const { world, calls } = makeWorld({ idleAfter: 200 });
  const result = await deliverInterrupt("下一轮任务", world);
  assert.deepEqual(calls, ["abort", "now:下一轮任务"],
    "abort first, delivery second — the reversed order is the 552-second deadlock");
  assert.equal(result.delivered, "turn");
  assert.ok(result.waitedMs > 0, "the wait is real, not skipped");
});

test("an already-idle pane is not made to wait for anything", async () => {
  const { world, calls } = makeWorld({ idleAfter: 0 });
  const result = await deliverInterrupt("下一轮任务", world);
  assert.equal(result.delivered, "turn");
  assert.equal(result.waitedMs, 0, "no rounds between dispatches must stay free");
  assert.deepEqual(calls, ["abort", "now:下一轮任务"]);
});

test("the delivery carries NO `deliverAs` — that is the form that opens a turn", async () => {
  // pi's own contract (docs/extensions.md, pi.sendUserMessage): not streaming ⇒
  // "sent immediately and triggers a new turn"; streaming ⇒ `deliverAs` is
  // required and omitting it throws. So the normal path must be the bare call.
  const { world, calls } = makeWorld({ idleAfter: 0 });
  await deliverInterrupt("正文", world);
  assert.ok(calls.includes("now:正文"));
  assert.deepEqual(calls, ["abort", "now:正文"], "the ONLY call is the bare one — `deliverAs` never appears");
});

test("a pane that never stops is DEFERRED — nothing is queued into the dead queue", async () => {
  // The first version of this module fell back to `deliverAs: "steer"` here,
  // on the theory that a queued message is at least not a lost one. It was the
  // SAME deadlock: the queue it queued into is the one the abort stopped
  // draining (`shouldStopAfterTurn` returns before the drain), so a timeout
  // parked the text forever while the ack said "delivered". A wait that does
  // not reach idle now delivers NOTHING, and the text stays in the channel for
  // the next drain to retry.
  const { world, calls } = makeWorld({ idleAfter: Number.POSITIVE_INFINITY, waitMs: 500 });
  const result = await deliverInterrupt("正文", world);
  assert.equal(result.delivered, "deferred");
  assert.deepEqual(calls, ["abort"], "nothing was sent — the caller keeps the text and retries");
  assert.ok(result.waitedMs >= 500, "…after the bounded wait, not before it");
});

test("a deferred delivery sends nothing at all, whatever the mode would have been", async () => {
  // Guard against a future "just queue it" reflex: the module has exactly ONE
  // side effect on the failure path — the abort.
  const { world, calls } = makeWorld({ idleAfter: Number.POSITIVE_INFINITY, waitMs: 100 });
  await deliverInterrupt("正文", world);
  assert.deepEqual(calls.filter((c) => c.startsWith("now:")), [], "no direct send");
  assert.equal(calls.length, 1, "and no second delivery mechanism");
});

test("waitForIdle returns how long it waited, and gives up at the bound", async () => {
  const { world } = makeWorld({ idleAfter: 250, waitMs: 1_000 });
  const waited = await waitForIdle(world);
  assert.equal(waited.idle, true);
  assert.ok(waited.waitedMs >= 250 && waited.waitedMs < 1_000, "it stops when the pane does");

  const { world: stuck } = makeWorld({ idleAfter: Number.POSITIVE_INFINITY, waitMs: 300 });
  const gave = await waitForIdle(stuck);
  assert.equal(gave.idle, false);
  assert.ok(gave.waitedMs >= 300, "and it stops when the clock runs out");
});

test("a round that never touched its transcript LOOKS unstarted — and that is only a REPORT", () => {
  // Goal 6(d). A heartbeat proves a PROCESS, not a round: the 552-second
  // freeze had two live panes whose gates were reporting happily while no
  // agent turn was running. The transcript is the one reading that moves only
  // when the agent works.
  const nowMs = 10_000_000;
  const quiet = nowMs - ROUND_SILENT_MS - 1;
  assert.equal(roundLooksUnstarted({ nowMs, hasReport: false, transcriptActivityAtMs: quiet }), true);
  assert.equal(roundLooksUnstarted({ nowMs, hasReport: false, transcriptActivityAtMs: nowMs - 1_000 }), false,
    "a transcript written seconds ago is work in progress, not silence");
  assert.equal(roundLooksUnstarted({ nowMs, hasReport: true, transcriptActivityAtMs: quiet }), false,
    "a round that reported is a round that ran");
  // FAIL-OPEN on a missing reading: information missing is not evidence.
  assert.equal(roundLooksUnstarted({ nowMs, hasReport: false }), false);
  // The dispatch is a FLOOR under the transcript, never a substitute for it:
  // a transcript whose last line predates this round must not look silent from
  // the start of time.
  assert.equal(
    roundLooksUnstarted({ nowMs, hasReport: false, dispatchedAtMs: nowMs - 1_000, transcriptActivityAtMs: 1 }),
    false,
  );
});

test("the bounds are the ones the design states", () => {
  assert.equal(INTERRUPT_IDLE_WAIT_MS, 3_000);
  assert.equal(INTERRUPT_POLL_MS, 50);
});

test("the gate's interrupt path goes through this module — the losing race cannot come back", () => {
  // The defect was an ORDER inside one call site, so the call site is what has
  // to be pinned: a future edit that re-inlines it would reintroduce the
  // deadlock while every unit test above stayed green.
  const src = readFileSync(join(ROOT, "extensions", "review-gate.ts"), "utf8");
  assert.match(src, /await deliverInterrupt\(/, "the drain must await the handoff");
  assert.doesNotMatch(
    src,
    /pi\.sendUserMessage\(interruptText, \{ deliverAs: "steer" \}\)/,
    "abort-without-waiting followed by a steer delivery is the losing race — it must not be re-inlined",
  );
});
