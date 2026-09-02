import { test } from "node:test";
import assert from "node:assert/strict";
import {
  READONLY_STALL_LIMIT,
  READONLY_STALL_NUDGE,
  evaluateReadonlyStall,
} from "../lib/readonly-stall.ts";

// ---------------------------------------------------------------------------
// evaluateReadonlyStall — the fold logic

test("read-only calls accumulate toward the limit", () => {
  let state: Parameters<typeof evaluateReadonlyStall>[0]["previous"];
  for (let i = 1; i < READONLY_STALL_LIMIT; i++) {
    const v = evaluateReadonlyStall({ previous: state, produced: false, read: true });
    state = v.state;
    assert.equal(v.state.consecutiveReads, i);
    assert.equal(v.nudge, false, `no nudge before the limit (call ${i})`);
  }
});

test("the limit crossing fires the nudge exactly once", () => {
  let state: Parameters<typeof evaluateReadonlyStall>[0]["previous"];
  let nudges = 0;
  for (let i = 1; i <= READONLY_STALL_LIMIT + 5; i++) {
    const v = evaluateReadonlyStall({ previous: state, produced: false, read: true });
    state = v.state;
    if (v.nudge) nudges += 1;
  }
  assert.equal(nudges, 1, "the crossing fires exactly one nudge");
  assert.equal(state?.consecutiveReads, READONLY_STALL_LIMIT + 5);
});

test("production resets the counter and clears the nudged flag", () => {
  let state: Parameters<typeof evaluateReadonlyStall>[0]["previous"];
  // Build up past the limit.
  for (let i = 0; i < READONLY_STALL_LIMIT; i++) {
    state = evaluateReadonlyStall({ previous: state, produced: false, read: true }).state;
  }
  assert.equal(state?.nudged, true);
  // A produced call resets everything.
  const after = evaluateReadonlyStall({ previous: state, produced: true, read: false });
  assert.equal(after.state.consecutiveReads, 0);
  assert.equal(after.state.nudged, false);
  assert.equal(after.nudge, false);
  // The counter starts fresh from zero.
  const next = evaluateReadonlyStall({ previous: after.state, produced: false, read: true });
  assert.equal(next.state.consecutiveReads, 1);
  assert.equal(next.nudge, false);
});

test("non-read, non-production observations leave the counter unchanged", () => {
  const state = evaluateReadonlyStall({ previous: undefined, produced: false, read: true }).state;
  const v = evaluateReadonlyStall({ previous: state, produced: false, read: false });
  assert.equal(v.state.consecutiveReads, state.consecutiveReads);
  assert.equal(v.state.nudged, state.nudged);
  assert.equal(v.nudge, false);
});

test("a first observation that is not a read starts at zero", () => {
  const v = evaluateReadonlyStall({ previous: undefined, produced: false, read: false });
  assert.equal(v.state.consecutiveReads, 0);
  assert.equal(v.nudge, false);
});

// ---------------------------------------------------------------------------
// nudge copy — prompt-only guidance, never enforcement wording

test("the nudge names the drill, steers to verify-by-doing, and does not block", () => {
  assert.match(READONLY_STALL_NUDGE, /只读工具调用/);
  assert.match(READONLY_STALL_NUDGE, /最小实现|测试|先例/);
  assert.match(READONLY_STALL_NUDGE, /没有拦截/);
  assert.doesNotMatch(READONLY_STALL_NUDGE, /\bblock(ed|ing)?\b/i, "nudges must not claim to block");
  assert.doesNotMatch(READONLY_STALL_NUDGE, /interrupt/i);
});
