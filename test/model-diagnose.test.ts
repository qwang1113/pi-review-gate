import { test } from "node:test";
import assert from "node:assert/strict";

import {
  diagnoseChain,
  formatModelDiagnosis,
  parseAgentFrontmatter,
  type RegistryFacts,
} from "../lib/model-diagnose.ts";
import { isModelAllowed } from "../lib/pdw-bridge.ts";

const REVIEWER_FRONTMATTER = `---
name: reviewer
model: claude-fable-5
fallbackModels: claude-opus-5, onekey/gpt-5.6-sol, opencode-go/deepseek-v4-flash
thinking: max
---
body`;

function facts(overrides: Partial<RegistryFacts> = {}): RegistryFacts {
  return {
    models: [
      { provider: "anthropic", id: "claude-fable-5" },
      { provider: "anthropic", id: "claude-opus-5" },
      { provider: "onekey", id: "gpt-5.6-sol" },
      { provider: "opencode-go", id: "deepseek-v4-flash" },
      { provider: "opencode-go", id: "qwen3.8-max" },
    ],
    authedProviders: new Set(["anthropic", "opencode-go"]),
    allowed: isModelAllowed,
    ...overrides,
  };
}

test("parseAgentFrontmatter reads model + fallbackModels", () => {
  const parsed = parseAgentFrontmatter(REVIEWER_FRONTMATTER);
  assert.equal(parsed?.model, "claude-fable-5");
  assert.deepEqual(parsed?.fallbackModels, ["claude-opus-5", "onekey/gpt-5.6-sol", "opencode-go/deepseek-v4-flash"]);
  assert.equal(parseAgentFrontmatter("no frontmatter"), undefined);
  assert.equal(parseAgentFrontmatter(""), undefined);
});

test("quoted frontmatter values are unquoted (model and fallbackModels, symmetric)", () => {
  const parsed = parseAgentFrontmatter(`---
model: "anthropic/claude-fable-5"
fallbackModels: 'onekey/gpt-5.6-sol', "opencode-go/deepseek-v4-flash"
---`);
  assert.equal(parsed?.model, "anthropic/claude-fable-5");
  assert.deepEqual(parsed?.fallbackModels, ["onekey/gpt-5.6-sol", "opencode-go/deepseek-v4-flash"]);
});

test("bare id ambiguous across providers is reported as ambiguous, not missing", () => {
  const fm = `---
model: gpt-5.6-sol
---`;
  // Two providers carry the same id → ambiguous.
  const f = facts();
  f.models.push({ provider: "acme", id: "gpt-5.6-sol" });
  const entry = diagnoseChain("reviewer", fm, f);
  assert.equal(entry.blocked, true);
  assert.match(entry.candidates[0]!.reason ?? "", /ambiguous across providers/);
  // Unique provider → resolves.
  const unique = facts({ authedProviders: new Set(["anthropic"]) });
  const entry2 = diagnoseChain("reviewer", `---\nmodel: claude-fable-5\n---`, unique);
  assert.equal(entry2.blocked, false);
  assert.equal(entry2.usable, "claude-fable-5", "usable keeps the pinned spec text");
});

test("diagnoseChain: first usable model wins (provider order)", () => {
  const entry = diagnoseChain("reviewer", REVIEWER_FRONTMATTER, facts());
  assert.equal(entry.blocked, false);
  assert.equal(entry.usable, "claude-fable-5");
  assert.deepEqual(
    entry.candidates.map((c) => [c.spec, c.ok]),
    [
      ["claude-fable-5", true],
      ["claude-opus-5", true],
      ["onekey/gpt-5.6-sol", false],
      ["opencode-go/deepseek-v4-flash", true],
    ],
  );
  assert.match(entry.candidates[2]!.reason ?? "", /no configured credentials/);
});

test("diagnoseChain: allowlist rejects every non-flash opencode-go model", () => {
  const fm = `---
model: opencode-go/qwen3.8-max
fallbackModels: opencode-go/gpt-5.6-luna, opencode-go/deepseek-v4-pro
---`;
  const entry = diagnoseChain("worker", fm, facts({ authedProviders: new Set(["opencode-go"]) }));
  assert.equal(entry.blocked, true, "the whole chain is forbidden — only flash may run on opencode-go");
  assert.equal(entry.usable, null);
  for (const c of entry.candidates) {
    assert.equal(c.ok, false);
    assert.match(c.reason ?? "", /allowlist forbids/);
  }
});

test("diagnoseChain: flash-only chain resolves on opencode-go", () => {
  const fm = `---
model: opencode-go/deepseek-v4-flash
---`;
  const entry = diagnoseChain("recon", fm, facts({ authedProviders: new Set(["opencode-go"]) }));
  assert.equal(entry.blocked, false);
  assert.equal(entry.usable, "opencode-go/deepseek-v4-flash");
});

test("diagnoseChain: unauthed provider blocks, thinking suffix is stripped", () => {
  const fm = `---
model: onekey/gpt-5.6-sol:max
fallbackModels: anthropic/claude-fable-5
---`;
  const entry = diagnoseChain("arbiter", fm, facts({ authedProviders: new Set(["anthropic"]) }));
  assert.equal(entry.blocked, false);
  assert.equal(entry.usable, "anthropic/claude-fable-5");
  assert.equal(entry.candidates[0]!.ok, false);
});

test("formatModelDiagnosis renders a readable block with the BLOCKED marker", () => {
  const ok = diagnoseChain("reviewer", REVIEWER_FRONTMATTER, facts());
  const dead = diagnoseChain(
    "worker",
    `---
model: opencode-go/qwen3.8-max
---`,
    facts({ authedProviders: new Set(["opencode-go"]) }),
  );
  const text = formatModelDiagnosis([ok, dead]);
  assert.match(text, /reviewer: → claude-fable-5/);
  assert.match(text, /worker: ⚠️ BLOCKED/);
  assert.match(text, /allowlist forbids/);
  assert.match(text, /✓ claude-fable-5/);
  assert.match(text, /✗ onekey\/gpt-5\.6-sol/);
});

test("formatModelDiagnosis handles no entries", () => {
  assert.match(formatModelDiagnosis([]), /none found/);
});
