/**
 * WHEN TO HAND OVER — the advice the gate computes so the orchestrator never
 * has to remember to look.
 *
 * The rule it encodes is not "how full is the context" but "what should you
 * do about it, given what else is outstanding". A percentage alone leads
 * straight to the failure this prevents: dispatching one more task on a
 * nearly full context, blowing up halfway through, and leaving the task state
 * dangling with a live child nobody is addressing.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  handoffAdvice,
  HANDOFF_HARD_PERCENT,
  HANDOFF_SOFT_PERCENT,
} from "../lib/orchestrator-handoff-advice.ts";

test("plenty of room is reported as plenty of room, with the number", () => {
  const advice = handoffAdvice({ percent: 30, openRequests: 0 });
  assert.equal(advice.urgency, "none");
  assert.equal(advice.percent, 30);
  assert.match(advice.line, /余量充足/);
});

test("past the soft threshold with a clear queue, NOW is the good moment", () => {
  const advice = handoffAdvice({ percent: HANDOFF_SOFT_PERCENT, openRequests: 0 });
  assert.equal(advice.urgency, "soon");
  assert.match(advice.line, /现在是接力的好时机/);
  assert.match(advice.line, /orchestrator_handoff/, "the advice names the tool, not a concept");
});

test("past the soft threshold with questions outstanding, answer them FIRST", () => {
  const advice = handoffAdvice({ percent: 85, openRequests: 2 });
  assert.equal(advice.urgency, "soon");
  assert.match(advice.line, /先处理完这 2 个待答请求再接力/,
    "a successor inheriting a queue of unanswered questions has no context for them");
});

test("past the HARD threshold, handing over is the first action — with or without a queue", () => {
  const clear = handoffAdvice({ percent: HANDOFF_HARD_PERCENT, openRequests: 0 });
  assert.equal(clear.urgency, "now");
  assert.match(clear.line, /首要动作/);
  assert.match(clear.line, /余量已不足以再带一轮任务/,
    "the REASON is the failure being prevented, not the number");

  const busy = handoffAdvice({ percent: 95, openRequests: 3 });
  assert.equal(busy.urgency, "now");
  assert.match(busy.line, /先把这 3 个待答请求回掉/);
});

test("a MISSING reading is reported as missing — never as room to spare", () => {
  const advice = handoffAdvice({ openRequests: 0 });
  assert.equal(advice.urgency, "none");
  assert.equal(advice.percent, undefined);
  assert.match(advice.line, /宿主未提供读数/);
  assert.doesNotMatch(advice.line, /余量充足/, "a missing measurement must not read as reassurance");

  assert.match(handoffAdvice({ percent: Number.NaN, openRequests: 0 }).line, /宿主未提供读数/);
});

test("the thresholds are the ones the task book named, and are injectable for a test", () => {
  assert.equal(HANDOFF_SOFT_PERCENT, 80);
  assert.equal(HANDOFF_HARD_PERCENT, 90);
  assert.equal(handoffAdvice({ percent: 55, openRequests: 0, soft: 50, hard: 60 }).urgency, "soon");
  assert.equal(handoffAdvice({ percent: 65, openRequests: 0, soft: 50, hard: 60 }).urgency, "now");
});
