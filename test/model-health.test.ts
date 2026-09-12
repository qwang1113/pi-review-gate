/**
 * The dispatch's memory of a bad model slot: which spec is skipped, for how
 * long, and — the branch that matters — what happens when EVERY slot is out.
 *
 * The failure this pins is the one measured on 2026-09-10: a chain whose
 * `slots[1]` answered 503 for hours while `slots[0]` was healthy, and nothing
 * in the dispatch ever looked past the head.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_MODEL_HEALTH_ENTRIES,
  MODEL_FAILURE_TTL_MS,
  clearModelFailure,
  describeCoolingSlot,
  modelKeyOf,
  nextSlotAfter,
  pruneModelHealth,
  recordModelFailure,
  selectHealthySlot,
  type ModelHealth,
} from "../lib/model-health.ts";

const CHAIN = [
  "anthropic/claude-opus-5:max",
  "onekey/gpt-6-astra:xhigh",
  "anthropic/claude-fable-5-1:max",
];

const T0 = 1_700_000_000_000;

test("modelKeyOf drops the thinking suffix, keeps provider/id", () => {
  assert.equal(modelKeyOf("onekey/gpt-6-astra:xhigh"), "onekey/gpt-6-astra");
  assert.equal(modelKeyOf(" onekey/gpt-6-astra "), "onekey/gpt-6-astra");
  assert.equal(modelKeyOf("claude-fable-5:max"), "claude-fable-5");
  // A colon that is NOT a thinking level stays part of the id (ollama tags).
  assert.equal(modelKeyOf("ollama/qwen3:latest"), "ollama/qwen3:latest");
});

test("an empty chain yields no choice at all (the caller fails closed)", () => {
  assert.equal(selectHealthySlot([], {}, T0), undefined);
});

test("a healthy chain picks the head, skipping nothing", () => {
  const picked = selectHealthySlot(CHAIN, {}, T0);
  assert.deepEqual(picked, { spec: CHAIN[0], index: 0, skipped: [], allCooling: false });
});

test("a cooling-down head is skipped for the next slot — the 503 case", () => {
  const health = recordModelFailure({}, CHAIN[0]!, T0 - 1000, "503 auth_unavailable");
  const picked = selectHealthySlot(CHAIN, health, T0);
  assert.equal(picked?.spec, CHAIN[1]);
  assert.equal(picked?.index, 1);
  assert.equal(picked?.allCooling, false);
  assert.equal(picked?.skipped.length, 1);
  assert.equal(picked?.skipped[0]?.error, "503 auth_unavailable");
});

test("the cooldown EXPIRES: after the TTL the slot is the head again", () => {
  const health = recordModelFailure({}, CHAIN[0]!, T0 - MODEL_FAILURE_TTL_MS - 1, "503");
  const picked = selectHealthySlot(CHAIN, health, T0);
  assert.equal(picked?.index, 0);
  assert.deepEqual(picked?.skipped, []);
});

test("a failure keyed by a DIFFERENT thinking suffix still cools the model", () => {
  const health = recordModelFailure({}, "onekey/gpt-6-astra:high", T0, "503");
  const picked = selectHealthySlot(["onekey/gpt-6-astra:xhigh", CHAIN[0]!], health, T0);
  assert.equal(picked?.index, 1, "the same provider/id under another level is the same model");
});

test("EVERY slot cooling still dispatches the head — and says so", () => {
  let health: ModelHealth = {};
  for (const spec of CHAIN) health = recordModelFailure(health, spec, T0, "503");
  const picked = selectHealthySlot(CHAIN, health, T0);
  assert.equal(picked?.spec, CHAIN[0], "fail-open: a round that cannot start cannot report either");
  assert.equal(picked?.allCooling, true);
  assert.equal(picked?.skipped.length, CHAIN.length);
});

test("recordModelFailure never mutates the input map", () => {
  const before: ModelHealth = {};
  const after = recordModelFailure(before, CHAIN[0]!, T0, "502");
  assert.deepEqual(before, {});
  assert.deepEqual(Object.keys(after), ["anthropic/claude-opus-5"]);
});

test("clearModelFailure un-benches a model that just worked", () => {
  // A rotation that SUCCEEDED proves the destination is reachable: keeping an
  // older failure on record would bench a healthy model for the rest of the TTL.
  const health = recordModelFailure({}, "onekey/gpt-6-astra:high", T0, "503");
  const cleared = clearModelFailure(health, "onekey/gpt-6-astra:xhigh", T0);
  assert.deepEqual(cleared, {}, "the level suffix is not part of the key");
  assert.ok(Object.keys(health).length === 1, "the input map is untouched");
  // Clearing the head puts it back in front of the pick.
  const picked = selectHealthySlot(CHAIN, cleared, T0);
  assert.equal(picked?.index, 0);
});

test("prune drops stale entries and caps the map at the newest N", () => {
  const health: ModelHealth = { stale: { at: T0 - MODEL_FAILURE_TTL_MS - 1 } };
  assert.deepEqual(pruneModelHealth(health, T0), {});
  const many: ModelHealth = {};
  for (let i = 0; i < MAX_MODEL_HEALTH_ENTRIES + 5; i++) {
    many[`p/m${i}`] = { at: T0 - i };
  }
  const pruned = pruneModelHealth(many, T0);
  assert.equal(Object.keys(pruned).length, MAX_MODEL_HEALTH_ENTRIES);
  assert.ok("p/m0" in pruned, "the NEWEST entry survives");
  assert.ok(!(`p/m${MAX_MODEL_HEALTH_ENTRIES + 4}` in pruned), "the oldest entries are the ones dropped");
});

test("nextSlotAfter walks forward and never re-tries a spent spec", () => {
  assert.deepEqual(nextSlotAfter(CHAIN, CHAIN[0]!, []), { spec: CHAIN[1], index: 1 });
  // Already tried 0 and 1 (a repeated provider counts as tried, keyed by model).
  assert.deepEqual(nextSlotAfter(CHAIN, CHAIN[1]!, [CHAIN[0]!, CHAIN[1]!]), {
    spec: CHAIN[2],
    index: 2,
  });
  assert.equal(nextSlotAfter(CHAIN, CHAIN[2]!, [CHAIN[0]!, CHAIN[1]!, CHAIN[2]!]), undefined);
  // An unknown current spec starts from the head.
  assert.deepEqual(nextSlotAfter(CHAIN, "someone/else", []), { spec: CHAIN[0], index: 0 });
  // Repeats never make the pane try the same model twice in one round.
  const repeated = ["a/x:max", "a/x:high", "b/y:max"];
  assert.deepEqual(nextSlotAfter(repeated, "a/x:max", ["a/x:max"]), { spec: "b/y:max", index: 2 });
});

test("describeCoolingSlot names the model, the age and the reason", () => {
  const line = describeCoolingSlot({ spec: "onekey/gpt-6-astra:xhigh", at: T0 - 5 * 60000, error: "503" }, T0);
  assert.equal(line, "onekey/gpt-6-astra（5 分钟前失败：503）");
  assert.match(describeCoolingSlot({ spec: "a/b", at: T0 }, T0), /1 分钟前失败/);
});
