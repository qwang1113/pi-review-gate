/**
 * B5 — A LONG BLOCK THAT THE HUMAN CAN END.
 *
 * MEASURED, 2026-09-04 (round-1 end-to-end orchestration run): a project
 * manager sitting in `orchestrator_wait({ timeoutMs: 900000 })` was
 * unreachable for 14 minutes. A message typed into its pane went into the
 * host's steer queue and stayed there until the budget expired; ESC only
 * toggled the editor mode and Ctrl+C was the only thing that landed. The
 * contrast that made it a defect: `orchestrator_instruct(interrupt)` reaches a
 * CHILD in seconds — the manager itself had no such door.
 *
 * MEASURED, 2026-09-06 (/tmp/b5-probe — a real pi TUI driven by expect, a
 * probe extension with a 90s blocking tool, a message typed from outside):
 *
 *     TOOL start seconds=90
 *     INPUT source=interactive behavior=steer waitLive=true …   ← 23.0s in
 *     TOOL end reason=input-abort elapsedMs=23041               ← 170ms later
 *
 * So the host DOES emit `input` while a tool is blocking, and the extension's
 * ALREADY EXISTING `pi.on("input")` handler is the whole trigger. No new tool,
 * no new channel, and nothing anyone but the human at this keyboard can pull.
 *
 * These tests pin the four things that make that safe: an input DURING a wait
 * ends it and says why, an input BEFORE it does not, the gate's own injections
 * (`source === "extension"`) never count, and the snapshot path is untouched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

import { DEFAULT_POLL_MS, notifyUserInput, pollUntil } from "../lib/poll-wait.ts";
import { makeFakeWorld, replyText, twoTaskPlan, type FakeWorld } from "./helpers/fake-orchestration.ts";

/** A fake clock: `sleep` advances time instead of burning it. */
function fakeClock(startAt = 0) {
  let t = startAt;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
  };
}

// ---------------------------------------------------------------------------
// The skeleton (lib/poll-wait.ts)
// ---------------------------------------------------------------------------

test("a user message DURING a wait ends it, and the result says which interrupt fired", async () => {
  const clock = fakeClock();
  let probes = 0;
  const res = await pollUntil({
    // The message arrives while the second probe is being taken.
    probe: () => { probes++; if (probes === 2) notifyUserInput(); return { done: false }; },
    isDone: (o) => o.done,
    budgetMs: 900_000,
    pollMs: 1_000,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(res.aborted, true, "the wait must not sit out its 900s budget while somebody is talking");
  assert.equal(res.abortReason, "user-input", "and the caller must be able to tell this apart from ESC");
  assert.equal(res.done, false);
  assert.equal(probes, 2, "TRIP WIRE: a third probe means the interrupt was only noticed a poll gap later");
});

test("a user message BEFORE the wait cannot end it — the epoch is a baseline, not a flag", async () => {
  notifyUserInput();
  notifyUserInput();

  const clock = fakeClock();
  const res = await pollUntil({
    probe: () => ({ done: false }),
    isDone: (o) => o.done,
    budgetMs: 5_000,
    pollMs: 1_000,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(res.aborted, false, "a stale input must never abort the NEXT wait");
  assert.equal(res.abortReason, undefined);
  assert.equal(res.waitedMs, 5_000, "it ran its full budget, as a wait with nothing to interrupt it should");
});

test("a caller that passes NO signal at all is still interruptible — that is judge_wait's shape", async () => {
  // judge_wait hands `signal` straight through and never reads `aborted`; it
  // gets this for free precisely because the interrupt lives in the skeleton
  // rather than in each caller's options.
  const clock = fakeClock();
  let probes = 0;
  const res = await pollUntil({
    probe: () => { probes++; if (probes === 3) notifyUserInput(); return { done: false }; },
    isDone: (o) => o.done,
    budgetMs: 600_000,
    pollMs: 2_000,
    // no `signal`
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(res.aborted, true);
  assert.equal(res.abortReason, "user-input");
  assert.equal(probes, 3, "TRIP WIRE: it stopped at the probe that fired, not after another cycle");
});

test("a probe that never returns cannot swallow the interrupt either", async () => {
  // The worst case of the original defect: a slow/hung probe is exactly when
  // the session is least reachable, so the interrupt races the probe too.
  //
  // TRIP WIRE: the budget is a REAL 3s timer rather than this file's usual
  // 900s. With no probe to advance the fake clock, only that timer can end
  // this wait — so a build where the interrupt is gone FAILS in three seconds
  // instead of hanging for fifteen minutes (measured: the mutant did hang).
  const clock = fakeClock();
  const hung = new Promise<{ done: boolean }>(() => { /* never resolves */ });
  const waiting = pollUntil({
    probe: () => hung,
    isDone: (o) => o.done,
    budgetMs: 3_000,
    now: clock.now,
    sleep: clock.sleep,
  });
  await Promise.resolve();
  notifyUserInput();
  const res = await waiting;

  assert.equal(res.aborted, true);
  assert.equal(res.abortReason, "user-input");
  assert.equal(res.stalledInProbe, false, "the probe did not miss a DEADLINE — it was cut short on purpose");
  assert.equal(res.observation, undefined, "and no observation is invented for one that never returned");
});

test("…and neither can a sleep that is still running: the wake is immediate, not next-gap", async () => {
  // The between-probes checks alone would ALSO end this wait eventually — one
  // whole poll gap later. That is the difference between "reachable" and
  // "reachable in two seconds", and on the 900s budget this was measured on it
  // is the difference the user asked for. So the sleep never ends on its own
  // here; only the interrupt (or the 3s real budget, the trip wire) can.
  const clock = fakeClock();
  const waiting = pollUntil({
    probe: () => ({ done: false }),
    isDone: (o) => o.done,
    budgetMs: 3_000,
    now: clock.now,
    sleep: () => new Promise<void>(() => { /* only the interrupt gets us out */ }),
  });
  await Promise.resolve();
  notifyUserInput();
  const res = await waiting;

  assert.equal(res.aborted, true);
  assert.equal(res.abortReason, "user-input");
  assert.equal(res.observation?.done, false, "the last observation still comes back");
});


test("ESC still wins the label when both interrupts fired", async () => {
  // Priority matters to the reply: with the call cancelled there is no turn
  // left for a queued message to be delivered into, so "somebody is talking to
  // you" would be the wrong thing to print.
  const clock = fakeClock();
  const signal = { aborted: false };
  const res = await pollUntil({
    probe: () => { signal.aborted = true; notifyUserInput(); return { done: false }; },
    isDone: (o) => o.done,
    budgetMs: 60_000,
    pollMs: 100,
    signal,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(res.aborted, true);
  assert.equal(res.abortReason, "signal");
});

test("an ESC abort with no user input keeps reporting itself as a signal abort", async () => {
  const clock = fakeClock();
  const signal = { aborted: false };
  const res = await pollUntil({
    probe: () => { signal.aborted = true; return { done: false }; },
    isDone: (o) => o.done,
    budgetMs: 60_000,
    pollMs: 100,
    signal,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(res.aborted, true);
  assert.equal(res.abortReason, "signal");
});

// ---------------------------------------------------------------------------
// The receipt (lib/orchestrator-session-tools.ts), end to end
// ---------------------------------------------------------------------------

async function spawnT1(world: FakeWorld): Promise<string> {
  const reply = await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  assert.equal(reply.isError, undefined, replyText(reply));
  return world.runtime().children[0]!.id;
}

test("orchestrator_wait reports an external message as such — not as a spent budget", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await spawnT1(world);

  // A 5s budget is the TRIP WIRE: if the interrupt never lands this test does
  // not hang, it comes back with the "预算用完" receipt and fails on the text.
  const waiting = world.call("orchestrator_wait", { timeoutMs: 5_000 });
  await new Promise((r) => setTimeout(r, 50)); // let the first probe complete
  notifyUserInput();
  const reply = await waiting;

  const text = replyText(reply);
  assert.match(text, /等待被外部消息打断/, "the manager must learn WHY it came back");
  assert.match(text, /马上就会送到你面前/, "…and that the message is already queued for it");
  assert.match(text, /没有任何东西被取消/, "…and that no child was harmed by the interrupt");
  assert.doesNotMatch(text, /本次预算用完/, "an interrupt must never be dressed up as a timeout");
  assert.equal(reply.details?.done, false);
  assert.equal(reply.details?.reason, "aborted", "the existing reason value is unchanged for old readers");
  assert.equal(reply.details?.abortedBy, "user-input");
  // Not merely "before the budget": BEFORE THE NEXT POLL GAP. A build where
  // only the between-probes check survives comes back a full DEFAULT_POLL_MS
  // (2s) later and would pass a laxer bound while leaving the manager
  // unreachable for exactly the gap this fix is about.
  assert.ok((reply.details?.waitedMs as number) < DEFAULT_POLL_MS,
    `it must return on the message, not on the next poll (waited ${reply.details?.waitedMs}ms)`);

  assert.match(text, /健康|子会话/, "and it still carries the same four-block receipt");
});

test("the timeoutMs: 0 snapshot is untouched by all of this", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await spawnT1(world);

  notifyUserInput(); // a message that just arrived must not turn a snapshot into an abort
  const reply = await world.call("orchestrator_wait", { timeoutMs: 0 });

  assert.equal(reply.isError, undefined, replyText(reply));
  assert.equal(reply.details?.reason !== "aborted", true, "a snapshot never blocks, so it can never be interrupted");
  assert.equal(reply.details?.abortedBy, undefined);
  assert.equal(reply.details?.waitedMs, 0);
});

// ---------------------------------------------------------------------------
// The trigger and the reach — structural, with self-verified windows
// ---------------------------------------------------------------------------

const EXTENSION_SRC = fs.readFileSync(new URL("../extensions/review-gate.ts", import.meta.url), "utf8");
const JUDGE_TOOLS_SRC = fs.readFileSync(new URL("../lib/judge-session-tools.ts", import.meta.url), "utf8");

test("the trigger is the EXISTING input handler, and the gate's own injections never pull it", () => {
  const start = EXTENSION_SRC.indexOf('pi.on("input"');
  assert.ok(start >= 0, "the input handler must exist");
  const end = EXTENSION_SRC.indexOf("\n  });", start);
  assert.ok(end > start, "the window must find the handler's closing brace — otherwise it proves nothing");
  const body = EXTENSION_SRC.slice(start, end);
  assert.ok(body.includes("notifyUserInput()"), "the window must actually CONTAIN the call it is asserting about");

  // The guard and the call are one statement: an unguarded `notifyUserInput()`
  // would let [REVIEW_GATE_RESUME] and an orchestrator's steer/followUp cut a
  // review round short.
  assert.match(body, /if \(event\.source !== "extension"\) notifyUserInput\(\);/);
  assert.equal((body.match(/notifyUserInput\(\)/g) ?? []).length, 1,
    "exactly one call site — a second, unguarded one is the whole risk here");

  // No new entry point: nothing else in the extension may pull the interrupt.
  assert.equal((EXTENSION_SRC.match(/notifyUserInput\(\)/g) ?? []).length, 1,
    "the human's own keyboard is the ONLY thing that ends a wait — never a tool, never a channel");
});

test("judge_wait inherits the interrupt because it has no waiting loop of its own", () => {
  const start = JUDGE_TOOLS_SRC.indexOf("async function doWait(");
  assert.ok(start >= 0, "judge_wait's implementation must exist");
  const end = JUDGE_TOOLS_SRC.indexOf("\n/** Write back a wait's consumed cursors", start);
  assert.ok(end > start, "the window must find the function that FOLLOWS doWait — otherwise it proves nothing");
  const body = JUDGE_TOOLS_SRC.slice(start, end);
  assert.ok(body.includes("await pollUntil({"), "the window must contain the wait it is asserting about");

  assert.equal((body.match(/pollUntil\(/g) ?? []).length, 1, "one wait, through the shared skeleton");
  assert.doesNotMatch(body, /setInterval\(|setTimeout\(/,
    "a second, hand-rolled waiting loop would be exactly the path that stays uninterruptible");
});
