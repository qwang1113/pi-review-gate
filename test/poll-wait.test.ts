import { test } from "node:test";
import assert from "node:assert/strict";

import { pollUntil, DEFAULT_POLL_MS } from "../lib/poll-wait.ts";

/**
 * A fake clock: `sleep` advances time instead of waiting, so a 10-minute
 * budget is tested in microseconds and the criteria are the only variable.
 */
function fakeClock(startAt = 0) {
  let t = startAt;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    advance: (ms: number) => { t += ms; },
  };
}

test("a criterion that fires immediately returns without sleeping", async () => {
  const clock = fakeClock();
  let probes = 0;
  const res = await pollUntil({
    probe: () => { probes++; return { done: true, reason: "exit-code" }; },
    isDone: (o) => o.done,
    budgetMs: 60_000,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(res.done, true);
  assert.equal(res.observation.reason, "exit-code");
  assert.equal(probes, 1, "one probe is enough when it already fired");
  assert.equal(res.waitedMs, 0);
});

test("it polls until a criterion fires, then stops", async () => {
  const clock = fakeClock();
  let probes = 0;
  const res = await pollUntil({
    probe: () => { probes++; return { done: probes >= 3 }; },
    isDone: (o) => o.done,
    budgetMs: 60_000,
    pollMs: 1000,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(res.done, true);
  assert.equal(probes, 3, "no probe after the one that fired");
  assert.equal(res.waitedMs, 2000, "two sleeps of the injected cadence");
});

test("a timeout returns the CURRENT observation, not an error", async () => {
  const clock = fakeClock();
  const res = await pollUntil({
    probe: () => ({ done: false, note: `still running at ${clock.now()}ms` }),
    isDone: (o) => o.done,
    budgetMs: 5_000,
    pollMs: 1_000,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(res.done, false);
  assert.equal(res.aborted, false);
  assert.match(res.observation.note, /still running at 5000ms/, "the last observation comes back");
  assert.equal(res.waitedMs, 5_000);
});

test("every probe publishes a snapshot, the first one included", async () => {
  const clock = fakeClock();
  const seen: Array<[number, number]> = [];
  let probes = 0;
  await pollUntil({
    probe: () => { probes++; return { done: probes >= 3, n: probes }; },
    isDone: (o) => o.done,
    budgetMs: 60_000,
    pollMs: 500,
    now: clock.now,
    sleep: clock.sleep,
    onProbe: (o, elapsed) => seen.push([o.n, elapsed]),
  });
  assert.deepEqual(seen, [[1, 0], [2, 500], [3, 1000]],
    "the wait is visible from its first second, not only from the second probe");
});

test("an abort stops the wait and says so", async () => {
  const clock = fakeClock();
  const signal = { aborted: false };
  let probes = 0;
  const res = await pollUntil({
    probe: () => { probes++; if (probes === 2) signal.aborted = true; return { done: false }; },
    isDone: (o) => o.done,
    budgetMs: 60_000,
    pollMs: 100,
    signal,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(res.done, false);
  assert.equal(res.aborted, true, "an abort is reported, never swallowed as a timeout");
  assert.equal(probes, 2);
});

test("an already-aborted signal still probes once, so the caller gets a snapshot", async () => {
  const clock = fakeClock();
  let probes = 0;
  const res = await pollUntil({
    probe: () => { probes++; return { done: false }; },
    isDone: (o) => o.done,
    budgetMs: 60_000,
    signal: { aborted: true },
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(probes, 1);
  assert.equal(res.aborted, true);
});

test("the criteria are the caller's: the same skeleton serves a different waiter", async () => {
  // The orchestrator_wait shape this split exists for: different criteria
  // (an attention event, a child's own completion), identical loop.
  const clock = fakeClock();
  const events: string[] = [];
  let tick = 0;
  const res = await pollUntil({
    probe: () => { tick++; if (tick === 2) events.push("needs-attention"); return { events: [...events] }; },
    isDone: (o) => o.events.includes("needs-attention"),
    budgetMs: 60_000,
    pollMs: 250,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(res.done, true);
  assert.deepEqual(res.observation.events, ["needs-attention"]);
});

test("an async probe is awaited", async () => {
  const clock = fakeClock();
  let probes = 0;
  const res = await pollUntil({
    probe: async () => { probes++; return { done: probes >= 2 }; },
    isDone: (o) => o.done,
    budgetMs: 10_000,
    pollMs: 10,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(res.done, true);
  assert.equal(probes, 2);
});

test("the default cadence is the UI throttle, so progress and probes agree", () => {
  assert.equal(DEFAULT_POLL_MS, 2000);
});
