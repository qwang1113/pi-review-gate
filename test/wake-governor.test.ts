import test from "node:test";
import assert from "node:assert/strict";
import { createWakeGovernor, decideWake, EMPTY_WAKE_MEMO, WAKE_LIMIT, type WakeMemo } from "../lib/wake-governor.ts";

const T0 = 1_000_000_000_000;

test("no progress: exactly five wakes, on widening gaps, then silence for good", () => {
  let memo: WakeMemo = EMPTY_WAKE_MEMO;
  const admittedAt: number[] = [];
  // A source asking every 10s for two days — the measured storm.
  for (let t = T0; t <= T0 + 48 * 3_600_000; t += 10_000) {
    const d = decideWake({ memo, now: t, progressKey: "unchanged" });
    memo = d.memo;
    if (d.admit) admittedAt.push(t - T0);
  }
  assert.equal(admittedAt.length, WAKE_LIMIT);
  assert.equal(WAKE_LIMIT, 5);
  const gaps = admittedAt.slice(1).map((t, i) => t - admittedAt[i]!);
  assert.deepEqual(gaps, [120_000, 240_000, 480_000, 960_000]);
});

test("the 60s floor holds across different facts", () => {
  const first = decideWake({ memo: EMPTY_WAKE_MEMO, now: T0, progressKey: "a" });
  assert.equal(first.admit, true);
  const tooSoon = decideWake({ memo: first.memo, now: T0 + 30_000, progressKey: "b" });
  assert.equal(tooSoon.admit, false);
  assert.equal(tooSoon.nextDelayMs, 30_000);
  assert.equal(decideWake({ memo: first.memo, now: T0 + 60_000, progressKey: "b" }).admit, true);
});

test("progress resets the budget: an exhausted fact wakes again once the key changes", () => {
  let memo: WakeMemo = EMPTY_WAKE_MEMO;
  let t = T0;
  for (let i = 0; i < WAKE_LIMIT; i++) {
    const d = decideWake({ memo, now: t, progressKey: "stuck" });
    assert.equal(d.admit, true);
    memo = d.memo;
    t += 3_600_000;
  }
  const done = decideWake({ memo, now: t, progressKey: "stuck" });
  assert.deepEqual([done.admit, done.exhausted], [false, true]);
  const moved = decideWake({ memo, now: t, progressKey: "user-said-something" });
  assert.equal(moved.admit, true);
});

test("the session governor sends only what it admits, and tells the UI once when it falls silent", () => {
  let now = T0;
  const sent: string[] = [];
  const notices: string[] = [];
  const gov = createWakeGovernor({
    pi: { sendUserMessage: (t: string) => { sent.push(t); }, sendMessage: () => { sent.push("<custom>"); } },
    notify: (t) => notices.push(t),
    now: () => now,
  });
  for (let i = 0; i < 400; i++) {
    gov.wake({ source: "revive", progressKey: "k", delivery: { kind: "user", text: `wake ${i}` } });
    now += 60_000;
  }
  assert.equal(sent.length, WAKE_LIMIT);
  assert.equal(notices.length, 1, "one notice, not one per refused request");
  gov.wake({ source: "orchestration-notice", progressKey: "k2", delivery: { kind: "custom", message: { customType: "x", content: "y", display: true } } });
  assert.equal(sent.at(-1), "<custom>", "progress re-opens it");
});
