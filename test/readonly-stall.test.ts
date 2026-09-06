import { test } from "node:test";
import assert from "node:assert/strict";
import {
  READONLY_STALL_LIMIT,
  READONLY_STALL_NUDGE,
  evaluateReadonlyStall,
  readonlyStallNudgeFor,
} from "../lib/readonly-stall.ts";

test("the threshold constant is the user's chosen 30 consecutive reads", () => {
  // Pinned literally (sibling precedent: test/loop-goal.test.ts pins the
  // 60-turn threshold the same way) so a silent retune cannot change the
  // behaviour without this test failing.
  assert.equal(READONLY_STALL_LIMIT, 30);
});

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

// ---------------------------------------------------------------------------
// readonlyStallNudgeFor — WHO hears the nudge (2026-09-17, user decision A)

test("orchestrator hears nothing: the manager may not write code, so the steer is a false positive by construction", () => {
  // Measured six handoffs in a row (03–08): a project manager doing read-only
  // verification of a child's delivery trips the counter and is told to
  // "write a minimal implementation or a test" — which constraint 2 forbids
  // it from doing. Silence is the only honest answer for that role.
  assert.equal(readonlyStallNudgeFor("orchestrator"), undefined);
});

test("normal hears nothing either — the extension steps aside completely in that mode", () => {
  assert.equal(readonlyStallNudgeFor("normal"), undefined);
});

test("loop and explore still hear the unchanged mode-neutral copy", () => {
  assert.equal(readonlyStallNudgeFor("loop"), READONLY_STALL_NUDGE);
  assert.equal(readonlyStallNudgeFor("explore"), READONLY_STALL_NUDGE);
});

test("an undecided mode hears the nudge — the gate behaves as loop until it is classified", () => {
  assert.equal(readonlyStallNudgeFor(undefined), READONLY_STALL_NUDGE);
});

test("the selector is the only thing that is mode-aware: the counter itself stays mode-blind", () => {
  // Reading is reading; only the COPY is wrong for some roles. Keeping the
  // fold mode-blind means a mode switch mid-session cannot resurrect a stale
  // count or lose a live one.
  let state: Parameters<typeof evaluateReadonlyStall>[0]["previous"];
  for (let i = 0; i < READONLY_STALL_LIMIT; i++) {
    state = evaluateReadonlyStall({ previous: state, produced: false, read: true }).state;
  }
  assert.equal(state?.consecutiveReads, READONLY_STALL_LIMIT);
  assert.equal(state?.nudged, true);
});
