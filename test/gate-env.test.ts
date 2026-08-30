import test from "node:test";
import assert from "node:assert/strict";

import { gateEnvKeys, neutraliseGateEnv, GATE_ENV_PREFIXES } from "./helpers/gate-env.ts";
import { STATE_VARIANT_ENV } from "../lib/gate-state.ts";
import { GATE_MODE_ENV } from "../lib/task-mode.ts";
import { ORCHESTRATION_ID_ENV } from "../lib/orchestration-id.ts";
import { PARENT_SESSION_ENV } from "../lib/orchestration-id.ts";
import { PREDECESSOR_PANE_ENV, HANDOFF_PATH_ENV, PREDECESSOR_TRANSCRIPT_ENV } from "../lib/orchestrator-relay.ts";

/**
 * The helper the hook and extension suites rely on to stay hermetic. Its one
 * job is easy to get subtly wrong (strip too little and a suite passes only
 * outside a gate session; strip by an explicit list and the next variable
 * reintroduces the bug), so both halves are asserted.
 */

test("every environment variable the gate sets is covered by the swept prefixes", () => {
  // Named constants, not string literals: this is what catches a NEW variable
  // that a prefix sweep would miss.
  for (const name of [
    STATE_VARIANT_ENV, GATE_MODE_ENV, ORCHESTRATION_ID_ENV, PARENT_SESSION_ENV,
    PREDECESSOR_PANE_ENV, HANDOFF_PATH_ENV, PREDECESSOR_TRANSCRIPT_ENV,
  ]) {
    assert.ok(
      GATE_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
      `${name} must be swept by one of ${GATE_ENV_PREFIXES.join(", ")}`,
    );
  }
});

test("the sweep removes the gate's variables and leaves everything else alone", () => {
  const env: NodeJS.ProcessEnv = {
    [STATE_VARIANT_ENV]: "t1-some-task",
    REVIEW_GATE_BYPASS: "1",
    PATH: "/usr/bin",
    RGB_COLOR: "not ours",
  };
  assert.deepEqual(gateEnvKeys(env).sort(), [STATE_VARIANT_ENV, "REVIEW_GATE_BYPASS"].sort());
  const removed = neutraliseGateEnv(env);
  assert.deepEqual(removed.sort(), [STATE_VARIANT_ENV, "REVIEW_GATE_BYPASS"].sort());
  assert.deepEqual(env, { PATH: "/usr/bin", RGB_COLOR: "not ours" });
  assert.deepEqual(neutraliseGateEnv(env), [], "a second sweep has nothing left to do");
});
