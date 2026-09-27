import test from "node:test";
import assert from "node:assert/strict";
import { nextStepAfterVerdict } from "../lib/verdict-host.ts";

test("N3: a recorded READY never sends the agent back to precommit", () => {
  const passed = nextStepAfterVerdict("READY", "passed");
  assert.doesNotMatch(passed, /run precommit/);
  assert.match(passed, /already PASSed/);
  assert.match(passed, /declare_done/);

  const waived = nextStepAfterVerdict("READY", "waived");
  assert.doesNotMatch(waived, /run precommit/);
  assert.match(waived, /waived/);
  assert.match(waived, /declare_done/);
});

test("N3: BLOCKED keeps its fix-and-re-review step; NEEDS_HUMAN adds none", () => {
  assert.equal(nextStepAfterVerdict("BLOCKED", "passed"), " Next: fix ALL findings and re-review.");
  assert.equal(nextStepAfterVerdict("NEEDS_HUMAN", "passed"), "");
});
