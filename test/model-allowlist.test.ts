import { test } from "node:test";
import assert from "node:assert/strict";

import { isModelAllowed } from "../lib/model-allowlist.ts";

test("USER REQUIREMENT: opencode-go may only run deepseek-v4-flash", () => {
  // The registry lists every opencode-go model; the allowlist is what stops a
  // pinned candidate from silently landing on an expensive one.
  assert.equal(isModelAllowed({ provider: "opencode-go", id: "deepseek-v4-flash" }), true);
  assert.equal(isModelAllowed({ provider: "opencode-go", id: "qwen3.8-max" }), false);
  assert.equal(isModelAllowed({ provider: "opencode-go", id: "gpt-5.6-luna" }), false);
  assert.equal(isModelAllowed({ provider: "opencode-go", id: "deepseek-v4-pro" }), false);
  // Every other provider is unrestricted (claude / onekey / ... may be added
  // later and must not be blocked by this rule).
  assert.equal(isModelAllowed({ provider: "anthropic", id: "claude-fable-5" }), true);
  assert.equal(isModelAllowed({ provider: "onekey", id: "gpt-5.6-sol" }), true);
  assert.equal(isModelAllowed({ provider: "opencode-go", id: "DEEPSEEK-V4-FLASH" }), false,
    "id match is exact (registry ids are lowercase)");
  // Malformed entries are rejected (fail-closed: never trust a bare string).
  assert.equal(isModelAllowed(null), false);
  assert.equal(isModelAllowed("opencode-go/qwen3.8-max"), false);
  assert.equal(isModelAllowed({ provider: "opencode-go" }), false);
});

test("REGRESSION: the allowlist survived the engine removal (moved out of pdw-bridge)", () => {
  // docs/handoff-remove-pdw.md step 2 deleted lib/pdw-bridge.ts but must keep
  // isModelAllowed — deleting this assertion lets someone delete the module
  // with the whole suite still green while an expensive opencode-go model
  // silently becomes eligible.
  assert.equal(isModelAllowed({ provider: "opencode-go", id: "deepseek-v4-flash" }), true);
  assert.equal(isModelAllowed({ provider: "opencode-go", id: "deepseek-v4-pro" }), false);
});
