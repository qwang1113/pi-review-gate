import { test } from "node:test";
import assert from "node:assert/strict";

import {
  diagnoseChain,
  formatModelDiagnosis,
  parseAgentFrontmatter,
  resolveSpec,
  type RegistryFacts,
} from "../lib/model-diagnose.ts";

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
      // thinkingLevelMap mirrors the real registry: REVIEWER_FRONTMATTER
      // pins `thinking: max`, which the deploy layer appends to every
      // candidate — the fixture models must resolve :max or the chain is
      // (correctly) diagnosed dead (round-11 P2).
      { provider: "anthropic", id: "claude-fable-5", thinkingLevelMap: { max: "max", xhigh: "xhigh" } },
      { provider: "anthropic", id: "claude-opus-5", thinkingLevelMap: { max: "max", xhigh: "xhigh" } },
      { provider: "onekey", id: "gpt-5.6-sol", thinkingLevelMap: { high: "high", max: "max" } },
      { provider: "opencode-go", id: "deepseek-v4-flash", reasoning: false, thinkingLevelMap: { off: null } },
      { provider: "opencode-go", id: "qwen3.8-max" },
    ],
    authedProviders: new Set(["anthropic", "opencode-go"]),
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

test("parseAgentFrontmatter reads YAML block-list fallbacks and CRLF", () => {
  const parsed = parseAgentFrontmatter("---\r\nmodel: x\r\nfallbackModels:\r\n  - y\r\n  - z\r\n---\r\n");
  assert.deepEqual(parsed, { model: "x", fallbackModels: ["y", "z"] });
});

test("parseAgentFrontmatter: a blank line ENDS a block list, a comment does not (runtime parity)", () => {
  // Round-11 P2 claimed pi-subagents "keeps blank lines inside a block value";
  // round-12 R3 disproved that with a direct probe against the installed
  // parser: a PLAIN block (no `>` / `|`) fails the continuation test at the
  // first genuinely blank line, so `fallbackModels:\n  - y\n\n  - z` yields
  // ONLY `y` upstream. Reporting `z` as a usable fallback was
  // deployed ≠ diagnosed — the runtime never starts it.
  const afterBlank = parseAgentFrontmatter("---\nmodel: x\nthinking: max\nfallbackModels:\n  - y\n\n  - z\n---\n");
  assert.deepEqual(
    afterBlank,
    { model: "x", thinking: "max", fallbackModels: ["y"] },
    "items after a blank line never deploy, so they must not be diagnosed as usable",
  );
  // A COMMENT does not end the block. Upstream keeps it as a list entry that
  // then simply fails to resolve, so skipping it here reports the same usable
  // chain minus a candidate that could never work.
  const withComment = parseAgentFrontmatter("---\nmodel: x\nfallbackModels:\n  # keep this comment\n  - y\n  - z\n---\n");
  assert.deepEqual(withComment, { model: "x", fallbackModels: ["y", "z"] }, "a comment must not truncate the real chain");
});

test("diagnoseChain: an UNKNOWN `thinking:` word is ignored, exactly as the runtime ignores it", () => {
  // Round-12 R3 P2: the frontmatter `thinking:` value was applied to every
  // candidate WITHOUT checking it is a real level. pi-subagents resolves it
  // with `THINKING_LEVELS.find((level) => level === configThinking)`
  // (shared/model-info.ts:40), so `thinking: banana` resolves to undefined and
  // the model deploys BARE. Applying it here refused reasoning:false
  // candidates that really do run — a live chain reported as dead.
  const f = facts({ models: [{ provider: "a", id: "m", reasoning: false }], authedProviders: new Set(["a"]) });
  for (const word of ["banana", "false", ""]) {
    const e = diagnoseChain("recon", `---\nmodel: a/m\nthinking: ${word}\n---`, f);
    assert.equal(e.candidates[0]!.ok, true, `thinking: ${JSON.stringify(word)} is not a level, so the bare model stands`);
    assert.equal(e.blocked, false);
  }
  // A REAL level is still applied (round-11 P2 behavior is unchanged).
  const real = diagnoseChain("recon", "---\nmodel: a/m\nthinking: max\n---", f);
  assert.equal(real.candidates[0]!.ok, false, "a genuine :max still vetoes a reasoning:false model");
});

test("diagnoseChain: standalone thinking field gates every candidate (deploy parity)", () => {
  // Round-11 P2: pi-subagents appends the frontmatter `thinking` level to
  // each candidate at deploy time, so a bare spec is only usable when that
  // level resolves — a reasoning:false model with `thinking: max` is dead.
  const f = facts({ models: [{ provider: "a", id: "m", reasoning: false }], authedProviders: new Set(["a"]) });
  const e = diagnoseChain("recon", "---\nmodel: a/m\nthinking: max\n---", f);
  assert.equal(e.candidates[0]!.ok, false, "the implied :max must veto a reasoning:false model");
  assert.equal(e.blocked, true);
  const ok = diagnoseChain("recon", "---\nmodel: a/m\nthinking: off\n---", f);
  assert.equal(ok.candidates[0]!.ok, true, "the implied :off stays usable on reasoning:false");
});

test("colon-bearing model ids remain intact", () => {
  const f = facts({ models: [{ provider: "ollama", id: "qwen3:32b" }], authedProviders: new Set(["ollama"]) });
  const entry = diagnoseChain("local", "---\nmodel: ollama/qwen3:32b\n---", f);
  assert.equal(entry.blocked, false);
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
      // The frontmatter pins `thinking: max`; the flash tier is
      // reasoning:false, so the IMPLIED :max vetoes it (round-11 P2).
      ["opencode-go/deepseek-v4-flash", false],
    ],
  );
  assert.match(entry.candidates[2]!.reason ?? "", /no configured credentials/);
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

test("diagnoseChain: :max without a thinkingLevelMap is refused (renderer parity)", () => {
  // Round-2 P2: the doctor used to bless such a chain while validateSpec and
  // the fan-out both refuse it — /gate-status could report a chain green that
  // the renderer would never deploy.
  const fm = `---
model: onekey/gpt-5.6-sol:max
---`;
  const noMap = diagnoseChain("reviewer", fm, facts({ models: [{ provider: "onekey", id: "gpt-5.6-sol" }], authedProviders: new Set(["onekey"]) }));
  assert.equal(noMap.candidates[0]!.ok, false, "missing map + :max must be refused");
  assert.match(noMap.candidates[0]!.reason ?? "", /thinking level/);
  const withMap = diagnoseChain(
    "reviewer",
    fm,
    facts({ models: [{ provider: "onekey", id: "gpt-5.6-sol", thinkingLevelMap: { max: "max" } }], authedProviders: new Set(["onekey"]) }),
  );
  assert.equal(withMap.candidates[0]!.ok, true, "an explicitly mapped :max stays usable");
});

test("resolveSpec refuses a leading-slash spec (parity with parseModelSpec)", () => {
  // Round-4 P2: the slash>0 fix had no regression coverage — mutating it
  // back to slash>=0 left this file green.
  const f = facts({ models: [{ provider: "onekey", id: "gpt-5.6-sol" }], authedProviders: new Set(["onekey"]) });
  assert.equal(resolveSpec("/gpt-5.6-sol", f), undefined, "a leading slash is malformed, never a bare id");
  assert.deepEqual(resolveSpec("onekey/gpt-5.6-sol", f), { provider: "onekey", id: "gpt-5.6-sol" });
});

test("diagnoseChain: a colon-less spec is never read as its own thinking suffix (round-12 Nit)", () => {
  // specThinkingSuffix used `spec.slice(spec.lastIndexOf(":") + 1)`, which is
  // the WHOLE spec when there is no colon. A PROVIDER-LESS id that happens to
  // be a level word (`max`) was therefore read as its own thinking suffix: the
  // candidate was then checked against a level the model never declared and
  // came back BLOCKED, and stripThinkingSuffix would have truncated it to
  // `ma`. review-fanout's specThinking always handled colonIdx === -1.
  const f = facts({ models: [{ provider: "p", id: "max" }], authedProviders: new Set(["p"]) });
  const bare = diagnoseChain("recon", "---\nmodel: max\n---", f);
  assert.equal(bare.candidates[0]!.ok, true, `a bare id equal to a level word must resolve: ${bare.candidates[0]!.reason}`);
  assert.equal(bare.usable, "max", `usable must name the real model, not a truncation: ${bare.usable}`);
  assert.equal(bare.blocked, false, "such a chain is not blocked");
  // The genuine suffix form still strips, so `usable` names the model only.
  const levelled = facts({
    models: [{ provider: "p", id: "m", thinkingLevelMap: { max: "max" } }],
    authedProviders: new Set(["p"]),
  });
  const withLevel = diagnoseChain("recon", "---\nmodel: p/m:max\n---", levelled);
  assert.equal(withLevel.usable, "p/m", "a real :thinking suffix is still stripped from `usable`");
});
test("diagnoseChain: reasoning:false model accepts bare and :off specs (validateSpec parity)", () => {
  // Round-5 P1: the doctor used to refuse BOTH while the renderer deploys
  // them — validateSpec allows a bare spec and :off on reasoning:false.
  const f = facts({ models: [{ provider: "a", id: "m", reasoning: false }], authedProviders: new Set(["a"]) });
  for (const fm of ["a/m", "a/m:off"]) {
    const e = diagnoseChain("recon", `---\nmodel: ${fm}\n---`, f);
    assert.equal(e.candidates[0]!.ok, true, `${fm} must be usable`);
    assert.equal(e.usable !== null, true, `${fm} resolves to a usable entry`);
  }
  const hi = diagnoseChain("recon", "---\nmodel: a/m:high\n---", f);
  assert.equal(hi.candidates[0]!.ok, false, "a real level on a reasoning:false model stays refused");
});

test("REGRESSION: reasoning:false + :off survives a null off mapping (round-8 fix)", () => {
  // validateSpec short-circuits reasoning:false to `level === "off"` WITHOUT
  // consulting the map — the doctor used to still read the map's null and
  // mark the deployed chain BLOCKED. Mutation-killing: disabling the early
  // success return must fail this test.
  const f = facts({ models: [{ provider: "p", id: "plain", reasoning: false, thinkingLevelMap: { off: null } }], authedProviders: new Set(["p"]) });
  const e = diagnoseChain("recon", "---\nmodel: p/plain:off\n---", f);
  assert.equal(e.candidates[0]!.ok, true, "the null off map must not veto :off on a reasoning:false model");
  assert.equal(e.usable, "p/plain");
  assert.equal(e.blocked, false);
});

test("formatModelDiagnosis renders a readable block with the BLOCKED marker", () => {
  const ok = diagnoseChain("reviewer", REVIEWER_FRONTMATTER, facts());
  const dead = diagnoseChain(
    "worker",
    `---
model: noauth-provider/no-creds-model
---`,
    facts({ authedProviders: new Set() }),
  );
  const text = formatModelDiagnosis([ok, dead]);
  assert.match(text, /reviewer: → claude-fable-5/);
  assert.match(text, /worker: ⚠️ BLOCKED/);
  assert.match(text, /no configured credentials/);
  assert.match(text, /✓ claude-fable-5/);
  assert.match(text, /✗ onekey\/gpt-5\.6-sol/);
});


test("formatModelDiagnosis handles no entries", () => {
  assert.match(formatModelDiagnosis([]), /none found/);
});
