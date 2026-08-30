import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseModelSpec,
  splitThinkingSuffix,
  bareModelId,
  formatSpec,
  validateSpec,
  validateSlots,
  parseAgentsSection,
  effectiveAgentsConfig,
  replaceFrontmatterModels,
  extractFrontmatterChain,
  frontmatterBlock,
  isGeneratedAgentFile,
  applyAgentConfigLayer,
  supportedThinkingOptions,
  loadRegistry,
  GENERATED_MARKER,
  MAX_SLOTS,
  KNOWN_AGENTS,
  type ModelRegistry,
  type AgentsConfigMap,
  parseAgentFrontmatterFields,
  projectAgentIdentity,
  resolvePackageAgentsDir,
  ensureAgentFilesPresent,
  validateAgentsForStartup,
} from "../lib/model-config.ts";

const REG: ModelRegistry = {
  anthropic: [
    { id: "claude-fable-5", thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } },
    { id: "claude-sonnet-5", thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
    { id: "claude-haiku-4-5", thinkingLevelMap: { low: "low", medium: "medium" } },
  ],
  onekey: [
    { id: "gpt-5.6-sol", thinkingLevelMap: { low: "low", high: "high", max: "max" } },
    { id: "glm-5.3", thinkingLevelMap: { low: "low", high: "high", max: "max" } },
    { id: "gpt-5.5", thinkingLevelMap: { low: "low", high: "high", max: null } },
  ],
  "opencode-go": [
    { id: "deepseek-v4-flash", thinkingLevelMap: { low: "low", high: "high", max: "max" } },
    { id: "deepseek-v4-pro", thinkingLevelMap: { low: "low", high: "high", max: "max" } },
  ],
};

// ---------------------------------------------------------------------------
// spec parsing
// ---------------------------------------------------------------------------

test("parseModelSpec handles provider, bare id and :thinking suffix", () => {
  assert.deepEqual(parseModelSpec("onekey/gpt-5.6-sol:high"), { provider: "onekey", id: "gpt-5.6-sol", thinking: "high", raw: "onekey/gpt-5.6-sol:high" });
  assert.deepEqual(parseModelSpec("claude-fable-5:max"), { provider: null, id: "claude-fable-5", thinking: "max", raw: "claude-fable-5:max" });
  assert.deepEqual(parseModelSpec("anthropic/claude-opus-5"), { provider: "anthropic", id: "claude-opus-5", thinking: null, raw: "anthropic/claude-opus-5" });
  assert.deepEqual(parseModelSpec("claude-fable-5"), { provider: null, id: "claude-fable-5", thinking: null, raw: "claude-fable-5" });
});

test("parseModelSpec refuses CR/LF injection inside a spec", () => {
  // Round-11 P1: `p/m\ntools: bash` parsed as a valid spec and rendered
  // an extra `tools:` frontmatter line — a config-injection vector.
  const injected = parseModelSpec("p/m\ntools: bash");
  assert.equal(injected.id, "", "a CR/LF spec must resolve to an empty id");
  assert.equal(validateSpec(REG, "p/m\ntools: bash").ok, false, "validateSpec must refuse it");
});

test("parseAgentsSection rejects slot strings containing CR/LF", () => {
  // Round-11 P1: the renderer would splice the slot into frontmatter, so a
  // newline-carrying slot is an injection vector, never a config.
  const r = parseAgentsSection({ reviewer: { auto: false, slots: ["p/m\ntools: bash"] } });
  assert.deepEqual(r.sections.reviewer, { malformed: true }, "an injection slot poisons the entry (fail-safe)");
  assert.ok(r.diagnostics.some((d) => d.includes("ignored")), "a diagnostic must explain the drop");
});

test("splitThinkingSuffix does not mangle ids that contain colons", () => {
  assert.deepEqual(splitThinkingSuffix("gpt-5.6-sol"), { base: "gpt-5.6-sol", thinking: null });
  assert.deepEqual(splitThinkingSuffix("gpt-5.6-sol:high"), { base: "gpt-5.6-sol", thinking: "high" });
  // An ollama-style tag (`qwen3:32b`) is NOT a thinking level — the id keeps
  // its colon (round-5 P2: the test NAME claimed this but no case passed a
  // colon-bearing id, so the guard was unprotected).
  assert.deepEqual(splitThinkingSuffix("qwen3:32b"), { base: "qwen3:32b", thinking: null });
  // A letter-headed suffix OUTSIDE the level whitelist ("latest") is NOT a
  // level — the id keeps it (round-6 P2: splitThinkingSuffix and bareModelId
  // now share the same KNOWN_THINKING_LEVELS whitelist).
  assert.deepEqual(splitThinkingSuffix("ollama/llama3:latest"), { base: "ollama/llama3:latest", thinking: null });
});

test("minimal is a recognized thinking level (round-10 P1)", () => {
  // pi-subagents supports `minimal`; removing it from KNOWN_THINKING_LEVELS
  // must be caught — `:minimal` would otherwise be treated as a model id.
  assert.deepEqual(splitThinkingSuffix("claude-sonnet-5:minimal"), { base: "claude-sonnet-5", thinking: "minimal" });
  assert.equal(validateSpec(REG, "onekey/gpt-5.6-sol:minimal").ok, true, "minimal is default-supported when not null-mapped");
});

test("bareModelId and formatSpec round-trip", () => {
  assert.equal(bareModelId("onekey/gpt-5.6-sol:high"), "gpt-5.6-sol");
  assert.equal(formatSpec("onekey", "gpt-5.6-sol", "high"), "onekey/gpt-5.6-sol:high");
  assert.equal(formatSpec(null, "gpt-5.6-sol", null), "gpt-5.6-sol");
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test("validateSpec accepts supported thinking levels and rejects unsupported ones", () => {
  assert.equal(validateSpec(REG, "claude-fable-5:max").ok, true, "fable max is legal");
  // fable-5's map lists off/xhigh/max — `high` is MISSING, and since round-7
  // a missing key means default support (pi-subagents semantics), except for
  // the restricted top tiers.
  assert.equal(validateSpec(REG, "claude-fable-5:high").ok, true, "missing key = default-supported (round-7 rule)");
  assert.equal(validateSpec(REG, "claude-fable-5:off").ok, false, "fable EXPLICITLY maps off to null — refused");
  assert.equal(validateSpec(REG, "onekey/gpt-5.5:max").ok, false, "gpt-5.5 maps max to null");
  assert.equal(validateSpec(REG, "onekey/gpt-5.6-sol:high").ok, true);
  // Restricted tiers require an explicit mapping: fable lists xhigh — but
  // gpt-5.5 does NOT list xhigh, so it is refused.
  assert.equal(validateSpec(REG, "onekey/gpt-5.5:xhigh").ok, false, "missing xhigh key = not offered (restricted tier)");
});

test("opencode-go cost allowlist also refuses a PROVIDER-LESS id that only resolves there", () => {
  // Round-12 R3 P2: the bare-id branch of the allowlist had ZERO coverage —
  // deleting it left model-config, review-fanout, model-diagnose, gate-doctor
  // and extension-structure all green, so a bare slot could render a banned
  // opencode-go model for any agent.
  assert.equal(validateSpec(REG, "opencode-go/deepseek-v4-pro").ok, false, "the annotated form is refused");
  const bare = validateSpec(REG, "deepseek-v4-pro");
  assert.equal(bare.ok, false, "a bare id that resolves ONLY under opencode-go is refused too");
  assert.match(bare.reason ?? "", /opencode-go only allows deepseek-v4-flash/, `reason must name the allowlist: ${bare.reason}`);
  // The allowed model still passes in BOTH forms.
  assert.equal(validateSpec(REG, "opencode-go/deepseek-v4-flash").ok, true);
  assert.equal(validateSpec(REG, "deepseek-v4-flash").ok, true);
});

test("a reasoning:false refusal names `off` as the supported level, not 'no metadata'", () => {
  // Round-12 R3 Nit: such a model DOES support exactly one level (`off`) but
  // carries no thinkingLevelMap, so the message said "supported: no metadata"
  // and left the user with nothing to pin.
  const reg: ModelRegistry = { p: [{ id: "plain", reasoning: false, thinkingLevelMap: undefined }] };
  const v = validateSpec(reg, "p/plain:high");
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /supported: off/, `the refusal must name :off: ${v.reason}`);
  assert.equal(validateSpec(reg, "p/plain:off").ok, true, ":off itself stays usable");
  // A model that merely LACKS metadata still reports "no metadata".
  const unknown: ModelRegistry = { p: [{ id: "mystery", thinkingLevelMap: undefined }] };
  const u = validateSpec(unknown, "p/mystery:max");
  assert.equal(u.ok, false, "max is refused without metadata");
  assert.match(u.reason ?? "", /supported: no metadata/, `unchanged for a reasoning model: ${u.reason}`);
});
test("a leading-slash spec is refused, never silently provider-less", () => {
  // Round-2 P1: parseModelSpec used to turn "/gpt-5.6-sol:high" into
  // provider:"" + id:"gpt-5.6-sol", which validateSpec accepted wherever the
  // bare id resolved. The slash must stay part of the id so the lookup fails.
  const v = validateSpec(REG, "/gpt-5.6-sol:high");
  assert.equal(v.ok, false, "malformed spec must be refused");
  assert.match(v.reason ?? "", /cannot be resolved|absent from the registry/, `reason should say the model is unresolvable: ${v.reason}`);
});

test("auto:false with empty slots renders the default chain AND says so", () => {
  const { map, diagnostics } = effectiveAgentsConfig(undefined, { reviewer: { auto: false } });
  assert.equal(map.reviewer!.auto, false);
  assert.equal(map.reviewer!.slots.length, 0);
  assert.equal(map.reviewer!.source, "project");
  assert.ok(
    diagnostics.some((d) => d.includes("reviewer") && d.includes("built-in default chain")),
    `expected a default-chain diagnostic, got: ${JSON.stringify(diagnostics)}`,
  );
});

test("validateSpec treats `:off` as universal unless the map explicitly nulls it (round-6 P2)", () => {
  // deepseek-v4-flash's map has no `off` key — pi-subagents still supports
  // thinking OFF, so the level must pass (AGENTS.md documents `:off` slots).
  assert.equal(validateSpec(REG, "opencode-go/deepseek-v4-flash:off").ok, true, "missing off key must not reject");
  assert.equal(validateSpec(REG, "claude-fable-5:off").ok, false, "fable EXPLICITLY maps off to null — refused");
});

test("validateSpec resolves provider-less specs by id", () => {
  assert.equal(validateSpec(REG, "glm-5.3:high").ok, true);
  assert.equal(validateSpec(REG, "nope-does-not-exist").ok, false);
  assert.equal(validateSpec(REG, "unknown-provider/gpt-5.6-sol").ok, false);
});

test("validateSpec rejects ambiguous provider-less ids", () => {
  const reg: ModelRegistry = {
    p1: [{ id: "shared", thinkingLevelMap: undefined }],
    p2: [{ id: "shared", thinkingLevelMap: undefined }],
  };
  assert.equal(validateSpec(reg, "shared:high").ok, false);
});

test("reasoning:false models only accept off", () => {
  const reg: ModelRegistry = { p: [{ id: "plain", reasoning: false, thinkingLevelMap: undefined }] };
  assert.equal(validateSpec(reg, "p/plain:off").ok, true);
  assert.equal(validateSpec(reg, "p/plain:high").ok, false);
});

test("validateSpec enforces the opencode-go cost allowlist", () => {
  assert.equal(validateSpec(REG, "opencode-go/deepseek-v4-flash:high").ok, true);
  const v = validateSpec(REG, "opencode-go/deepseek-v4-pro:high");
  assert.equal(v.ok, false);
  assert.match(v.reason!, /opencode-go/);
});

test("validateSpec warns (not blocks) when the model has no thinking metadata", () => {
  const reg: ModelRegistry = { onekey: [{ id: "mystery-model", thinkingLevelMap: undefined }] };
  const v = validateSpec(reg, "onekey/mystery-model:high");
  assert.equal(v.ok, true);
  assert.ok(v.warning);
});

test("validateSlots stops at the first failure", () => {
  assert.equal(validateSlots(REG, ["claude-fable-5:max", "onekey/gpt-5.6-sol:high"]).ok, true);
  assert.equal(validateSlots(REG, ["claude-fable-5:off", "onekey/gpt-5.6-sol:high"]).ok, false, "fable:off is explicitly null-mapped");
});

// ---------------------------------------------------------------------------
// registry helpers
// ---------------------------------------------------------------------------

test("supportedThinkingOptions mirrors runtime thinking defaults", () => {
  assert.deepEqual(supportedThinkingOptions(REG, "claude-fable-5"), [
    "anthropic/claude-fable-5:high",
    "anthropic/claude-fable-5:low",
    "anthropic/claude-fable-5:max",
    "anthropic/claude-fable-5:medium",
    "anthropic/claude-fable-5:minimal",
    "anthropic/claude-fable-5:xhigh",
  ]);
  assert.deepEqual(supportedThinkingOptions(REG, "onekey/gpt-5.5"), [
    "onekey/gpt-5.5:high",
    "onekey/gpt-5.5:low",
    "onekey/gpt-5.5:medium",
    "onekey/gpt-5.5:minimal",
    "onekey/gpt-5.5:off",
  ]);
  assert.deepEqual(supportedThinkingOptions(REG, "glm-5.3"), [
    "onekey/glm-5.3:high",
    "onekey/glm-5.3:low",
    "onekey/glm-5.3:max",
    "onekey/glm-5.3:medium",
    "onekey/glm-5.3:minimal",
    "onekey/glm-5.3:off",
  ]);
  assert.deepEqual(supportedThinkingOptions(REG, "no-such-model"), []);
});

test("loadRegistry merges models.json and models-store.json from a fake home", () => {
  const home = mkdtempSync(join(tmpdir(), "rg-reg-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "models.json"),
    JSON.stringify({ providers: { anthropic: { models: [{ id: "claude-fable-5", thinkingLevelMap: { max: "max" } }] } } }),
    "utf8",
  );
  writeFileSync(
    join(home, ".pi", "agent", "models-store.json"),
    JSON.stringify({ providers: { onekey: { models: [{ id: "gpt-5.6-sol", thinkingLevelMap: { high: "high" } }] } } }),
    "utf8",
  );
  const reg = loadRegistry(home);
  assert.ok(reg.anthropic.some((m) => m.id === "claude-fable-5"));
  assert.ok(reg.onekey.some((m) => m.id === "gpt-5.6-sol"));
  // A corrupt file degrades gracefully — it must not wipe the other source.
  writeFileSync(join(home, ".pi", "agent", "models.json"), "{bad", "utf8");
  const reg2 = loadRegistry(home);
  assert.ok(reg2.onekey.some((m) => m.id === "gpt-5.6-sol"), "corrupt models.json must not wipe models-store.json");
  rmSync(home, { recursive: true, force: true });
});

test("loadRegistry: a metadata-less duplicate does not shadow the other source's metadata (round-12 Nit)", () => {
  // models.json is ingested FIRST, so an entry there without a
  // thinkingLevelMap used to make the same id in models-store.json be skipped
  // entirely — and "no map" means `:max` is REFUSED, so validateSpec rejected
  // a level the registry actually proves supported.
  const home = mkdtempSync(join(tmpdir(), "rg-reg-dup-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "models.json"),
    JSON.stringify({ providers: { onekey: { models: [{ id: "glm-5.3" }] } } }),
    "utf8",
  );
  writeFileSync(
    join(home, ".pi", "agent", "models-store.json"),
    JSON.stringify({
      providers: { onekey: { models: [{ id: "glm-5.3", reasoning: true, thinkingLevelMap: { max: "max" } }] } },
    }),
    "utf8",
  );
  const reg = loadRegistry(home);
  const entries = reg.onekey.filter((m) => m.id === "glm-5.3");
  assert.equal(entries.length, 1, "the id stays a single entry (first source still wins)");
  assert.deepEqual(entries[0]!.thinkingLevelMap, { max: "max" }, "the later source fills the missing map");
  assert.equal(entries[0]!.reasoning, true, "the later source fills missing reasoning too");
  assert.equal(validateSpec(reg, "onekey/glm-5.3:max").ok, true, "a level the store proves supported must pass");
  rmSync(home, { recursive: true, force: true });
});

test("loadRegistry: the FIRST source's metadata is never overwritten by a later one", () => {
  const home = mkdtempSync(join(tmpdir(), "rg-reg-prio-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "models.json"),
    JSON.stringify({ providers: { onekey: { models: [{ id: "m", reasoning: false, thinkingLevelMap: { max: null } }] } } }),
    "utf8",
  );
  writeFileSync(
    join(home, ".pi", "agent", "models-store.json"),
    JSON.stringify({ providers: { onekey: { models: [{ id: "m", reasoning: true, thinkingLevelMap: { max: "max" } }] } } }),
    "utf8",
  );
  const reg = loadRegistry(home);
  const entry = reg.onekey.find((m) => m.id === "m")!;
  assert.deepEqual(entry.thinkingLevelMap, { max: null }, "models.json keeps priority when it HAS a map");
  assert.equal(entry.reasoning, false, "models.json keeps priority for reasoning too");
  rmSync(home, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// config section parsing & layering
// ---------------------------------------------------------------------------

test("parseAgentsSection accepts valid entries and reports diagnostics", () => {
  const r = parseAgentsSection({
    reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high", "claude-fable-5:max"] },
    fixer: { slots: ["opencode-go/deepseek-v4-flash:high"] }, // auto defaults true
  });
  assert.deepEqual(r.sections.reviewer, { auto: false, slots: ["onekey/gpt-5.6-sol:high", "claude-fable-5:max"] });
  assert.deepEqual(r.sections.fixer, { slots: ["opencode-go/deepseek-v4-flash:high"] });
  assert.equal(r.diagnostics.length, 0);
});

test("parseAgentsSection truncates slots beyond MAX_SLOTS with a diagnostic", () => {
  const many = Array.from({ length: 6 }, (_, i) => `onekey/model-${i}`);
  const r = parseAgentsSection({ reviewer: { slots: many } });
  assert.equal(r.sections.reviewer!.slots!.length, MAX_SLOTS);
  assert.ok(r.diagnostics.some((d) => /truncated/.test(d)));
});

test("parseAgentsSection tolerates corrupt entries without throwing", () => {
  const r = parseAgentsSection({ reviewer: "nope", fixer: { slots: "not-an-array" }, garbage: 42 });
  // A KNOWN agent with a non-object entry is malformed (keeps the last
  // render, round-11 P1); an unknown name is dropped entirely.
  assert.deepEqual(r.sections.reviewer, { malformed: true }, "a non-object entry for a known agent is malformed");
  assert.deepEqual(r.sections.fixer, { malformed: true });
  assert.equal(r.sections.garbage, undefined, "an unknown agent name is dropped");
  assert.ok(r.diagnostics.length >= 1);
});

test("effectiveAgentsConfig layers defaults ← global ← project and labels the source", () => {
  const globalRaw = { agents: { reviewer: { auto: false, slots: ["claude-fable-5:max"] }, fixer: { auto: false, slots: ["claude-sonnet-5:max"] } } };
  const projectRaw = { agents: { reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } } };
  const { map } = effectiveAgentsConfig(globalRaw.agents, projectRaw.agents);
  const reviewer = map.reviewer!;
  assert.equal(reviewer.auto, false);
  assert.deepEqual(reviewer.slots, ["onekey/gpt-5.6-sol:high"], "project wins over global for the same agent");
  assert.equal(reviewer.source, "project");
  assert.deepEqual(map.fixer!.slots, ["claude-sonnet-5:max"], "unset in project falls through to global");
  assert.equal(map.fixer!.source, "global");
  assert.deepEqual(map.adviser!.slots, [], "unset anywhere is default");
  assert.equal(map.adviser!.auto, true);
  assert.equal(map.adviser!.source, "default");
});

test("effectiveAgentsConfig ignores unknown agent names", () => {
  // Pass the SECTION itself (not a nested {agents: …} wrapper) — the wrapper
  // made this test vacuous: parseAgentsSection saw only the key "agents"
  // and discarded it before the filter ran (round-4 P1).
  const { map } = effectiveAgentsConfig({ "not-an-agent": { auto: false, slots: ["onekey/gpt-5.6-sol"] } }, undefined);
  assert.equal(KNOWN_AGENTS.includes("not-an-agent"), false);
  assert.equal(map["not-an-agent"], undefined);
});

// ---------------------------------------------------------------------------
// frontmatter rendering
// ---------------------------------------------------------------------------

const SAMPLE_AGENT = `---
name: reviewer
description: some description
model: claude-fable-5
fallbackModels: claude-opus-5, opencode-go/deepseek-v4-flash
thinking: max
tools: read, grep, find, ls, bash
---
Body text stays untouched.`;

test("replaceFrontmatterModels swaps model/fallback and keeps every other field", () => {
  const out = replaceFrontmatterModels(SAMPLE_AGENT, { model: "onekey/gpt-5.6-sol:high", fallbackModels: ["claude-fable-5:max", "onekey/glm-5.3:high"] })!;
  assert.ok(out, "frontmatter present");
  assert.ok(out.startsWith("---\n"));
  assert.match(out, /# @generated by pi-review-gate/);
  assert.match(out, /name: reviewer/);
  assert.match(out, /description: some description/);
  assert.match(out, /model: onekey\/gpt-5\.6-sol:high/);
  assert.match(out, /fallbackModels: claude-fable-5:max, onekey\/glm-5\.3:high/);
  assert.match(out, /^---$/m);
  assert.match(out, /Body text stays untouched\./);
});

test("replaceFrontmatterModels accepts '--- ' openers like the runtime parser does", () => {
  // pi-subagents' parseFrontmatter only checks startsWith("---") and then
  // indexOf("\n---", 3), so a file opened with `--- ` / `---\t` really loads
  // at runtime; the renderer must not refuse it (P1: explicit slots were
  // silently rejected and the old chain kept deploying).
  // `--- # note` / `---x` are the round-3 P2 cases: the runtime opens a block on
  // ANY `---…` line, so a renderer that only tolerated `---[ \t]*` still refused
  // files that really deploy.
  for (const opener of ["--- ", "---\t", "--- # note", "---x"]) {
    const agent = opener + "\nname: reviewer\nmodel: old\n---\nbody";
    const out = replaceFrontmatterModels(agent, { model: "onekey/gpt-5.6-sol:high", fallbackModels: [] });
    assert.ok(out, `opener ${JSON.stringify(opener)} must render, not be refused`);
    assert.match(out!, /model: onekey\/gpt-5\.6-sol:high/, `the model line must be swapped for ${JSON.stringify(opener)}`);
    // The three frontmatter readers in this file must not diverge: the block
    // reader and the chain extractor have to accept exactly what the renderer
    // (and the runtime) accept, or an `auto:true` overlay silently reports "no
    // parseable frontmatter" for a file that really loads.
    assert.ok(frontmatterBlock(agent), `frontmatterBlock must accept ${JSON.stringify(opener)}`);
    assert.deepStrictEqual(
      extractFrontmatterChain(agent),
      { model: "old", fallback: [] },
      `extractFrontmatterChain must accept ${JSON.stringify(opener)}`,
    );
  }
});

test("replaceFrontmatterModels is idempotent and marker-aware", () => {
  const countMarker = (s: string): number => {
    let n = 0;
    let i = s.indexOf(GENERATED_MARKER);
    while (i !== -1) { n++; i = s.indexOf(GENERATED_MARKER, i + 1); }
    return n;
  };
  const once = replaceFrontmatterModels(SAMPLE_AGENT, { model: "onekey/gpt-5.6-sol:high", fallbackModels: [] })!;
  const twice = replaceFrontmatterModels(once, { model: "onekey/gpt-5.6-sol:high", fallbackModels: [] })!;
  assert.equal(isGeneratedAgentFile(twice), true);
  assert.equal(countMarker(twice), 1, "marker is not duplicated by re-rendering");
  assert.equal(twice, once, "a no-op re-render returns identical text state");
});

test("isGeneratedAgentFile still recognizes renders from the retired marker", () => {
  // The shipped marker once carried a suffix (the retired editor). Recognition
  // is a prefix match, so those files stay managed until the next re-render.
  // The suffix is CONCATENATED so the tracked file never spells the forbidden
  // literal (exit criterion 3) while the test still exercises the real bytes.
  const retiredSuffix = ["(T", "UI)"].join("");
  const legacy = SAMPLE_AGENT.replace(/^---/m, `---\n${GENERATED_MARKER} ${retiredSuffix}`);
  assert.equal(isGeneratedAgentFile(legacy), true);
  assert.equal(isGeneratedAgentFile(SAMPLE_AGENT), false);
  // Recognition is the EXACT marker prefix: another tool's marker line must
  // NOT be mistaken for ours (the cleanup would delete a file we never owned).
  const foreign = SAMPLE_AGENT.replace(/^---/m, `---\n# @generated by pi-review-gate unrelated-tool`);
  assert.equal(isGeneratedAgentFile(foreign), false, "a foreign tool's marker must not be claimed");
});

test("isGeneratedAgentFile: models-other / modelsX markers are foreign, not ours (round-11)", () => {
  // Round-11 P1: the unbounded startsWith claimed "# @generated by
  // pi-review-gate models-other" / "...modelsX" — another tool's marker —
  // so the cleanup deleted files this feature never owned. Only the EXACT
  // marker and the retired space+suffix render variant are ours.
  const withMarker = (line: string) => SAMPLE_AGENT.replace(/^---/m, `---\n${line}`);
  assert.equal(isGeneratedAgentFile(withMarker(GENERATED_MARKER)), true, "exact marker is ours");
  // Concatenated so the tracked file never spells the forbidden literal
  // (exit criterion 3) while the test still exercises the real bytes.
  const retiredSuffix = ["(T", "UI)"].join("");
  assert.equal(isGeneratedAgentFile(withMarker(`${GENERATED_MARKER} ${retiredSuffix}`)), true, "retired suffix render stays managed");
  assert.equal(isGeneratedAgentFile(withMarker("# @generated by pi-review-gate models-other")), false, "models-other is a foreign marker");
  assert.equal(isGeneratedAgentFile(withMarker("# @generated by pi-review-gate modelsX")), false, "modelsX is a foreign marker");
});

test("replaceFrontmatterModels returns undefined when there is no frontmatter", () => {
  assert.equal(replaceFrontmatterModels("no frontmatter here", { model: "x", fallbackModels: [] }), undefined);
});

test("replaceFrontmatterModels drops YAML block-list continuations under fallbackModels", () => {
  const BLOCK = [
    "---",
    "name: reviewer",
    "model: claude-fable-5",
    "fallbackModels:",
    "  - claude-opus-5",
    "  - opencode-go/deepseek-v4-flash",
    "thinking: max",
    "---",
    "Body",
  ].join("\n");
  const out = replaceFrontmatterModels(BLOCK, { model: "onekey/gpt-5.6-sol:high", fallbackModels: ["claude-fable-5:max"] })!;
  assert.match(out, /model: onekey\/gpt-5\.6-sol:high/);
  assert.match(out, /fallbackModels: claude-fable-5:max/);
  assert.doesNotMatch(out, /  - claude-opus-5/, "orphaned block bullet must be removed");
  assert.doesNotMatch(out, /  - opencode-go\/deepseek-v4-flash/, "orphaned block bullet must be removed");
  // Parses cleanly: the removed fallback keys leave no stray lines.
  const fm = out.split("---\n")[1]!.split("\n---")[0]!;
  const hasBroken = fm.split("\n").some((l) => {
    const t = l.trim();
    return t !== "" && !t.startsWith("#") && !/^[\w-]+:/.test(t);
  });
  assert.equal(hasBroken, false, "every non-comment frontmatter line is a well-formed key");
});

test("replaceFrontmatterModels drops block lists split by blank/comment lines (round-11)", () => {
  // Round-11 P1: the key regex stopped at the first non-bullet line, so
  // `fallbackModels:` followed by a BLANK line or a COMMENT left orphaned
  // `  - item` bullets that pi-subagents re-attached to the previous key.
  const BLOCK = [
    "---",
    "name: reviewer",
    "model: claude-fable-5",
    "fallbackModels:",
    "",
    "  # keep this comment",
    "  - claude-opus-5",
    "  - opencode-go/deepseek-v4-flash",
    "thinking: max",
    "---",
    "Body",
  ].join("\n");
  const out = replaceFrontmatterModels(BLOCK, { model: "onekey/gpt-5.6-sol:high", fallbackModels: [] })!;
  assert.match(out, /model: onekey\/gpt-5\.6-sol:high/);
  assert.doesNotMatch(out, /  - claude-opus-5/, "bullet after blank line must be removed");
  assert.doesNotMatch(out, /  - opencode-go/, "bullet after comment must be removed");
  // The following key must survive intact.
  assert.match(out, /thinking: max/);
  assert.match(out, /Body/);
});

test("replaceFrontmatterModels: a following key's own block list is not swallowed (round-11)", () => {
  // Round-11 P1: the continuation regex also matched an empty-valued key
  // (`tools:`) and its bullets, deleting a field the edit must preserve.
  const BLOCK = [
    "---",
    "name: reviewer",
    "model: claude-fable-5",
    "fallbackModels:",
    "  - claude-opus-5",
    "tools:",
    "  - read",
    "  - bash",
    "---",
    "Body",
  ].join("\n");
  const out = replaceFrontmatterModels(BLOCK, { model: "onekey/gpt-5.6-sol:high", fallbackModels: [] })!;
  assert.doesNotMatch(out, /  - claude-opus-5/, "fallback bullets removed");
  assert.match(out, /tools:/, "the following key survives");
  assert.match(out, /  - read/, "its bullets survive too");
  assert.match(out, /  - bash/);
});

test("parseAgentFrontmatterFields mirrors pi-subagents semantics (round-11)", () => {
  // Round-11 P1: a regex approximation diverged from the runtime parser on
  // block scalars, nested keys and quoted empties — this reference parser
  // is what projectAgentIdentity / the doctor / the widget all use now.
  const fields = (text: string) => parseAgentFrontmatterFields(text);
  // Block scalar with content → folded non-empty description.
  const block = fields("---\nname: x\ndescription: >\n  project reviewer\nmodel: dead/x\n---\n");
  assert.equal(block.name, "x");
  assert.equal(block.description, "project reviewer", "folded block scalar content is the value");
  // Nested keys inside a block scalar are NOT top-level fields.
  const nested = fields("---\ntools: |\n  name: reviewer\n  description: project reviewer\nmodel: dead/x\n---\n");
  assert.equal(nested.name, undefined, "indented name inside tools: is not a top-level field");
  assert.equal(nested.tools, "name: reviewer\ndescription: project reviewer");
  // Quoted empties are empty; plain scalars unquote.
  assert.equal(fields('---\nname: ""\ndescription: ""\n---\n').name, "");
  assert.equal(fields("---\nname: 'a'\ndescription: b\n---\n").name, "a");
  // projectAgentIdentity: needs BOTH fields non-empty; name is the identity.
  assert.equal(projectAgentIdentity("---\nname: reviewer\ndescription: d\n---\n"), "reviewer");
  assert.equal(projectAgentIdentity("---\ndescription: d\n---\n"), undefined, "no name → not loadable");
  assert.equal(projectAgentIdentity("---\nname: reviewer\ndescription: >\n  \n---\n"), undefined, "empty block description → not loadable");
});

test("parseAgentFrontmatterFields: the OPENING delimiter follows the runtime, not a stricter regex (round-12 R2 P2)", () => {
  // pi-subagents only does startsWith("---") + indexOf("\n---", 3), so a
  // trailing space/tab after the opening --- (or any trailing text) still
  // OPENS a frontmatter block. A stricter `^---\n` here reported such a file as
  // not loadable while it really does shadow the global agent.
  for (const opener of ["--- ", "---\t", "---no-newline-here"]) {
    const text = `${opener}\nname: reviewer\ndescription: d\n---\nbody`;
    assert.equal(
      parseAgentFrontmatterFields(text).name,
      "reviewer",
      `opener ${JSON.stringify(opener)} must still open a frontmatter block`,
    );
    assert.equal(
      projectAgentIdentity(text),
      "reviewer",
      `opener ${JSON.stringify(opener)} is loadable at runtime, so it must shadow`,
    );
  }
  // CRLF files normalize the same way.
  assert.equal(parseAgentFrontmatterFields("---\r\nname: r\r\ndescription: d\r\n---\r\n").name, "r");
  // No closing delimiter and no leading --- both yield NO fields.
  assert.deepEqual(parseAgentFrontmatterFields("---\nname: q\n"), {});
  assert.deepEqual(parseAgentFrontmatterFields("not frontmatter\n"), {});
});

test("parseAgentFrontmatterFields: a QUOTED EMPTY opens a block, like the runtime (round-12 R2 Nit)", () => {
  // pi-subagents decides on the UNQUOTED value (`value === ""`), so `name: ""`
  // opens a block scalar and collects the indented lines after it. Deciding on
  // the RAW text made it a terminal scalar here — the same parity gap class as
  // the delimiter and block-scalar fixes.
  assert.equal(
    parseAgentFrontmatterFields('---\nname: ""\n  indented-continuation\ndescription: d\n---\n').name,
    "indented-continuation",
    "a quoted empty collects the indented continuation",
  );
  assert.equal(
    parseAgentFrontmatterFields("---\nname: ''\n  cont\nmodel: m\n---\n").name,
    "cont",
    "single quotes behave the same",
  );
  // The common case (nothing indented after it) still yields the empty string,
  // so projectAgentIdentity keeps reporting such a file as NOT loadable.
  assert.equal(parseAgentFrontmatterFields('---\nname: ""\ndescription: ""\n---\n').name, "");
  assert.equal(projectAgentIdentity('---\nname: ""\ndescription: ""\n---\n'), undefined);
});
test("parseAgentFrontmatterFields: blank lines inside block scalars match the runtime (round-12 P2)", () => {
  // Round-12 P2: blank continuation lines were only honored for FOLDED blocks,
  // so a LITERAL block (`|` / `|-`) was truncated at its first blank line and
  // one that STARTS blank came out empty — projectAgentIdentity then reported a
  // runtime-loadable project agent as not loadable and the shadow detection
  // missed it. Folded blocks additionally collapsed paragraph breaks into
  // spaces instead of keeping them as newlines (pi-subagents' foldBlock).
  const literal = parseAgentFrontmatterFields(
    "---\nname: reviewer\ndescription: |\n  first\n\n  after blank\ntools: read\n---\nbody\n",
  );
  assert.equal(literal.description, "first\n\nafter blank", "a literal block keeps its blank line");
  assert.equal(literal.tools, "read", "the key AFTER the block is still parsed");
  const startsBlank = parseAgentFrontmatterFields(
    "---\nname: reviewer\ndescription: |-\n\n  starts blank\nmodel: x\n---\n",
  );
  assert.equal(startsBlank.description, "starts blank", "a literal block that starts blank is not emptied");
  assert.equal(
    projectAgentIdentity("---\nname: reviewer\ndescription: |\n\n  d\n---\n"),
    "reviewer",
    "such a file IS loadable at runtime, so it must shadow",
  );
  // Folded: a blank line is a paragraph separator (newline), not a space.
  const folded = parseAgentFrontmatterFields("---\nname: a\ndescription: >\n  folded\n\n  still folded\n---\n");
  assert.equal(folded.description, "folded\nstill folded", "a folded paragraph break survives as a newline");
  // A more-indented line inside a folded block keeps its own break AND its
  // extra indentation (only the block's COMMON prefix is stripped) — verified
  // against pi-subagents' parseFrontmatter, not assumed.
  const moreIndented = parseAgentFrontmatterFields("---\nname: b\ndescription: >-\n  one\n  two\n    deep\n---\n");
  assert.equal(moreIndented.description, "one two\n  deep", "a more-indented folded line keeps its line break");
});
test("extractFrontmatterChain parses BOTH inline and YAML block-list fallbacks", () => {
  // Round-8 P1: `\s` in the inline regex crossed the newline, so the block-list
  // branch was dead code and a block list yielded a corrupt "- item" entry.
  const chain = extractFrontmatterChain([
    "---",
    "name: reviewer",
    "model: claude-fable-5",
    "fallbackModels:",
    "  - claude-opus-5",
    "  - opencode-go/deepseek-v4-flash",
    "thinking: max",
    "---",
    "Body",
  ].join("\n"));
  assert.ok(chain, "block-list chain must parse");
  assert.equal(chain!.model, "claude-fable-5");
  assert.deepEqual(chain!.fallback, ["claude-opus-5", "opencode-go/deepseek-v4-flash"]);
  assert.equal(chain!.fallback.some((f) => f.startsWith("-")), false, "no bullet debris may leak through");
  const inline = extractFrontmatterChain([
    "---",
    "model: onekey/gpt-5.6-sol:high",
    "fallbackModels: claude-fable-5:max, onekey/glm-5.3:high",
    "---",
  ].join("\n"));
  assert.deepEqual(inline!.fallback, ["claude-fable-5:max", "onekey/glm-5.3:high"]);
});

test("extractFrontmatterChain block list STOPS at the next top-level key (round-9 P2)", () => {
  // A later block-list key (tools:) must not leak its items into the chain.
  const chain = extractFrontmatterChain([
    "---",
    "name: reviewer",
    "model: claude-fable-5",
    "fallbackModels:",
    "  - claude-opus-5",
    "  - opencode-go/deepseek-v4-flash",
    "tools:",
    "  - read",
    "  - grep",
    "defaultReads:",
    "  - plan.md",
    "---",
  ].join("\n"));
  assert.deepEqual(chain!.fallback, ["claude-opus-5", "opencode-go/deepseek-v4-flash"]);
  assert.equal(chain!.fallback.some((f) => f === "read" || f === "grep" || f === "plan.md"), false, "later block keys must not leak");
});

test("frontmatter rendering result still parses under pi-subagents-style parsing", () => {
  const out = replaceFrontmatterModels(SAMPLE_AGENT, { model: "onekey/gpt-5.6-sol:high", fallbackModels: ["claude-fable-5:max"] })!;
  // The generated marker is a comment line; every original field must survive.
  assert.match(out, /# @generated by pi-review-gate/);
  assert.match(out, /^---$/m);
  assert.match(out, /\nname: reviewer\n/);
  assert.match(out, /\ndescription: some description\n/);
  assert.match(out, /\nmodel: onekey\/gpt-5\.6-sol:high\n/);
  assert.match(out, /\nfallbackModels: claude-fable-5:max\n/);
  assert.match(out, /\nthinking: max\n/);
  assert.match(out, /\ntools: read, grep, find, ls, bash\n/);
});

// ---------------------------------------------------------------------------
// layer application
// ---------------------------------------------------------------------------

function tempRepo(): { dir: string; sourceDir: string; targetDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "modelcfg-"));
  const sourceDir = join(dir, "src");
  const targetDir = join(dir, "target");
  mkdirSync(sourceDir);
  for (const name of ["reviewer", "worker", "adviser"]) {
    writeFileSync(join(sourceDir, `${name}.md`), SAMPLE_AGENT, "utf8");
  }
  return { dir, sourceDir, targetDir };
}

function mapOf(entries: Record<string, { auto?: boolean; slots?: string[]; source?: "project" | "global" | "default" }>): AgentsConfigMap {
  const map: AgentsConfigMap = {};
  for (const [name, e] of Object.entries(entries)) {
    // An entry that pins auto:false or a slot list is EXPLICITLY configured
    // (source project); a bare default (auto:true, no slots) represents the
    // "not configured in this layer" case (source default → cleanup).
    const explicit = (e.slots?.length ?? 0) > 0 || e.auto === false;
    map[name] = { auto: e.auto ?? true, slots: e.slots ?? [], source: e.source ?? (explicit ? "project" : "default") };
  }
  return map;
}

test("applyAgentConfigLayer does not materialize an empty layer dir (all-default)", () => {
  // Round-7 P2: the extension session-start applies with no `agents` section;
  // an eager mkdirSync would litter <repo>/.pi/agents for nothing. With no
  // configured agent, no generated file is written and the dir must stay
  // absent.
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    const res = applyAgentConfigLayer({ agents: mapOf({}), targetDir, sourceDir, registry: REG });
    assert.equal(res.written.length, 0);
    assert.equal(res.deleted.length, 0);
    assert.equal(existsSync(targetDir), false, "no generated file → no directory may be created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup deletes ONLY generated products — a hand-written file survives a config lift (round-10 P2)", () => {
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(targetDir, "reviewer.md"),
      "---\nname: reviewer\nmodel: claude-sonnet-5\n---\nHand-written by the user\n",
      "utf8",
    );
    const { map } = effectiveAgentsConfig(undefined, undefined); // all default → cleanup
    const res = applyAgentConfigLayer({ agents: map, targetDir, sourceDir, registry: REG });
    assert.equal(res.deleted.length, 0, "a hand-written (non-generated) file must never be deleted");
    assert.equal(res.written.length, 0);
    assert.equal(readFileSync(join(targetDir, "reviewer.md"), "utf8").includes("Hand-written"), true, "file untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyAgentConfigLayer renders auto:false slots into the target layer", () => {
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    const res = applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high", "claude-fable-5:max"] }, worker: { auto: true } }),
      targetDir,
      sourceDir,
      registry: REG,
    });
    assert.deepEqual(res.written, ["reviewer"]);
    assert.deepEqual(res.deleted, []);
    assert.deepEqual(res.errors, []);
    const text = readFileSync(join(targetDir, "reviewer.md"), "utf8");
    assert.match(text, /model: onekey\/gpt-5\.6-sol:high/);
    assert.match(text, /fallbackModels: claude-fable-5:max/);
    assert.equal(existsSync(join(targetDir, "worker.md")), false, "auto:true agents are not rendered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyAgentConfigLayer refuses a broken slot and keeps the previous file", () => {
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    const res = applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: false, slots: ["claude-fable-5:off"] } }), // off explicitly null-mapped
      targetDir,
      sourceDir,
      registry: REG,
    });
    assert.deepEqual(res.written, []);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0]!, /off/);
    assert.equal(existsSync(join(targetDir, "reviewer.md")), false, "no file may land on a failed write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyAgentConfigLayer deletes generated products when auto turns back on", () => {
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    // render once (auto:false)
    applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } }),
      targetDir,
      sourceDir,
      registry: REG,
    });
    assert.equal(existsSync(join(targetDir, "reviewer.md")), true);
    // flip to auto:true — the generated product must be removed (fall back to upstream)
    const res = applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: true } }),
      targetDir,
      sourceDir,
      registry: REG,
    });
    assert.deepEqual(res.deleted, ["reviewer"]);
    assert.equal(existsSync(join(targetDir, "reviewer.md")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyAgentConfigLayer copies the upstream base when the target lacks the file", () => {
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    const res = applyAgentConfigLayer({
      agents: mapOf({ adviser: { auto: false, slots: ["claude-fable-5:max"] } }),
      targetDir,
      sourceDir,
      registry: REG,
    });
    assert.deepEqual(res.written, ["adviser"]);
    const text = readFileSync(join(targetDir, "adviser.md"), "utf8");
    assert.match(text, /model: claude-fable-5:max/);
    assert.match(text, /^---$/m, "copied base keeps a valid frontmatter block");
    assert.match(text, /Body text stays untouched\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed agent ENTRY keeps the last render instead of sweeping it (round-11)", () => {
  // Round-11 P1: `agents.reviewer.slots=[1]` — an entry with NO valid
  // field — was treated as "unconfigured", so the cleanup deleted a
  // previously valid generated chain. It must be kept untouched (fail-safe).
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    mkdirSync(targetDir, { recursive: true });
    // First render a valid slot chain…
    const r1 = applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } }),
      targetDir, sourceDir, registry: REG,
    });
    assert.deepEqual(r1.written, ["reviewer"]);
    assert.match(readFileSync(join(targetDir, "reviewer.md"), "utf8"), /model: onekey\/gpt-5\.6-sol:high/);
    // …then re-render with a malformed entry: nothing may change.
    const { map, diagnostics } = effectiveAgentsConfig({ reviewer: { slots: [1] } }, undefined);
    assert.ok(diagnostics.some((d) => d.includes("ignored")), "the malformed field is diagnosed");
    assert.equal(map.reviewer?.malformed, true, "the entry is marked malformed, not unconfigured");
    const r2 = applyAgentConfigLayer({ agents: map, targetDir, sourceDir, registry: REG });
    assert.deepEqual(r2.deleted, [], "the cleanup must NOT sweep the render");
    assert.deepEqual(r2.written, [], "nothing may be overwritten");
    assert.match(readFileSync(join(targetDir, "reviewer.md"), "utf8"), /model: onekey\/gpt-5\.6-sol:high/, "the last good render survives");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-object and invalid-slots entries are malformed, never swept (round-11 P1)", () => {
  // Round-11 P1 (shard-4): `{reviewer:"typo"}` / `{reviewer:null}` and
  // `{reviewer:{auto:false, slots:[1]}}` used to fall back to source=default
  // and the cleanup restored the built-in chain over the last good render.
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    mkdirSync(targetDir, { recursive: true });
    applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } }),
      targetDir, sourceDir, registry: REG,
    });
    // (a) non-object entry (string)
    const m1 = effectiveAgentsConfig({ reviewer: "typo" }, undefined);
    assert.equal(m1.map.reviewer?.malformed, true, "a string entry is malformed");
    const r1 = applyAgentConfigLayer({ agents: m1.map, targetDir, sourceDir, registry: REG });
    assert.deepEqual(r1.deleted, []);
    assert.match(readFileSync(join(targetDir, "reviewer.md"), "utf8"), /onekey\/gpt-5\.6-sol:high/);
    // (b) auto:false + INVALID slots
    const m2 = effectiveAgentsConfig({ reviewer: { auto: false, slots: [1] } }, undefined);
    assert.equal(m2.map.reviewer?.malformed, true, "invalid slots poison the entry");
    const r2 = applyAgentConfigLayer({ agents: m2.map, targetDir, sourceDir, registry: REG });
    assert.deepEqual(r2.deleted, []);
    assert.match(readFileSync(join(targetDir, "reviewer.md"), "utf8"), /onekey\/gpt-5\.6-sol:high/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid auto field poisons otherwise-valid slots (round-11 P1)", () => {
  // Round-11 P1 (shard-4): `{auto:"false", slots:[...]}` used to default
  // auto to true and SILENTLY IGNORE the user's slot chain.
  const r = parseAgentsSection({ reviewer: { auto: "false", slots: ["onekey/gpt-5.6-sol:high"] } });
  assert.deepEqual(r.sections.reviewer, { malformed: true }, "invalid auto poisons the entry");
  assert.ok(r.diagnostics.some((d) => d.includes("is not a boolean")), "the bad auto is diagnosed");
});
test("hand-written target is backed up and restored across an auto round-trip", () => {
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    mkdirSync(targetDir, { recursive: true });
    // A hand-written (non-generated) target file the user owns.
    const HANDWRITTEN = `---
name: reviewer
model: claude-sonnet-5
thinking: max
tools: read, grep, find, ls, bash
---
Hand-written body`;
    writeFileSync(join(targetDir, "reviewer.md"), HANDWRITTEN, "utf8");
    // auto:false adopts it — with a backup, not a silent overwrite.
    const r1 = applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } }),
      targetDir, sourceDir, registry: REG,
    });
    assert.deepEqual(r1.written, ["reviewer"]);
    assert.ok(r1.warnings.some((w) => /backed up/.test(w)), "the manual adoption must warn + back up");
    assert.equal(readFileSync(join(targetDir, "reviewer.md.bak"), "utf8"), HANDWRITTEN, "backup keeps the user content");
    // auto:true restores the hand-written file (not an orphaned .bak).
    const r2 = applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: true } }),
      targetDir, sourceDir, registry: REG,
    });
    assert.deepEqual(r2.deleted, [], "nothing to delete — the backup was restored");
    assert.equal(readFileSync(join(targetDir, "reviewer.md"), "utf8"), HANDWRITTEN, "user's file is back");
    assert.equal(existsSync(join(targetDir, "reviewer.md.bak")), false, "backup consumed by the restore");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale .bak is refreshed to the NEWER hand-written content (round-11)", () => {
  // Round-11 P1: with a pre-existing .bak (v1), a LATER hand edit (v2) was
  // silently overwritten by the render and the restore brought back v1 —
  // losing the user's newest content. The .bak must track the latest
  // hand-written state.
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    mkdirSync(targetDir, { recursive: true });
    const V1 = `---\nname: reviewer\nmodel: claude-sonnet-5\n---\nbody v1`;
    const V2 = `---\nname: reviewer\nmodel: claude-sonnet-5\n---\nbody v2`;
    // First adoption: v1 becomes the .bak.
    writeFileSync(join(targetDir, "reviewer.md"), V1, "utf8");
    applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } }),
      targetDir, sourceDir, registry: REG,
    });
    assert.equal(readFileSync(join(targetDir, "reviewer.md.bak"), "utf8"), V1);
    // The user edits by hand again (v2) while the .bak (v1) still exists.
    writeFileSync(join(targetDir, "reviewer.md"), V2, "utf8");
    const r2 = applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } }),
      targetDir, sourceDir, registry: REG,
    });
    assert.ok(r2.warnings.some((w) => /backed up/.test(w)), "the newer hand edit must be re-backed-up");
    assert.equal(readFileSync(join(targetDir, "reviewer.md.bak"), "utf8"), V2, ".bak tracks the newest hand-written content");
    // Lifting the config restores v2, not the stale v1.
    const r3 = applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: true } }),
      targetDir, sourceDir, registry: REG,
    });
    assert.equal(readFileSync(join(targetDir, "reviewer.md"), "utf8"), V2, "restore brings back the newest hand edit");
    assert.equal(existsSync(join(targetDir, "reviewer.md.bak")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a .bak path that is a directory refuses adoption instead of losing data (round-11)", () => {
  // Round-11 P1: with reviewer.md.bak as a DIRECTORY, the backup was
  // silently skipped and the hand-written target was overwritten with no
  // recoverable copy.
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    mkdirSync(join(targetDir, "reviewer.md.bak"), { recursive: true });
    const HAND = `---\nname: reviewer\nmodel: claude-sonnet-5\n---\nbody`;
    writeFileSync(join(targetDir, "reviewer.md"), HAND, "utf8");
    const res = applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } }),
      targetDir, sourceDir, registry: REG,
    });
    assert.ok(res.errors.some((e) => /not a regular file/.test(e)), "a .bak-as-directory must error, not silently adopt");
    assert.deepEqual(res.written, [], "nothing may be written when the backup is impossible");
    assert.equal(readFileSync(join(targetDir, "reviewer.md"), "utf8"), HAND, "the hand-written target survives");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an upstream path that is a directory errors per-agent, never throws (round-11)", () => {
  // Round-11 P1: readBase threw EISDIR and aborted the whole layer render.
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    rmSync(join(sourceDir, "reviewer.md"), { force: true }); // drop tempRepo's file
    mkdirSync(join(sourceDir, "reviewer.md"), { recursive: true }); // upstream is a DIR
    mkdirSync(targetDir, { recursive: true });
    const res = applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } }),
      targetDir, sourceDir, registry: REG,
    });
    assert.ok(res.errors.some((e) => /upstream file missing/.test(e)), "a directory upstream is reported, not thrown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an UPSTREAM-identical target is not mistaken for a hand-written file (postinstall case)", () => {
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    // installAgents just copied the upstream default into the target.
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "reviewer.md"), readFileSync(join(sourceDir, "reviewer.md"), "utf8"), "utf8");
    const res = applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } }),
      targetDir, sourceDir, registry: REG,
    });
    assert.deepEqual(res.written, ["reviewer"]);
    assert.equal(res.warnings.length, 0, "no misleading hand-written backup warning");
    assert.equal(existsSync(join(targetDir, "reviewer.md.bak")), false, "no stray .bak for an upstream copy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit auto:true renders a default-chain shadow, overriding a lower layer's slot render", () => {
  // Round-6 P1: with global reviewer.auto:false + slots, a project auto:true
  // must deploy the BUILT-IN default — leaving the global slot render in force
  // would make the DEPLOYED model contradict the effective config.
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    // Lower layer (global) rendered slots into the shared target.
    applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } }),
      targetDir, sourceDir, registry: REG,
    });
    assert.match(readFileSync(join(targetDir, "reviewer.md"), "utf8"), /model: onekey\/gpt-5\.6-sol:high/);
    // Higher layer explicitly turns auto ON (source project) → default-chain
    // overlay SHADOWS the slot render; check no stray auto:false leftovers.
    const res = applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: true, source: "project" } }),
      targetDir, sourceDir, registry: REG,
    });
    assert.deepEqual(res.written, ["reviewer"], "explicit auto:true must write the shadow file (not delete)");
    const text = readFileSync(join(targetDir, "reviewer.md"), "utf8");
    assert.match(text, /# @generated by pi-review-gate/, "shadow is a generated overlay");
    assert.match(text, /model: claude-fable-5/, "shadow carries the UPSTREAM DEFAULT main model");
    assert.doesNotMatch(text, /onekey\/gpt-5\.6-sol/, "the lower layer's slot model must NOT survive the shadow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto:true with a hand-written target and a MISSING upstream refuses to fake a default chain", () => {
  // Round-5 P1: readBase fell back to the TARGET file, so an explicit
  // auto:true deployed the user's custom chain as if it were the built-in
  // default (published-layout reproduction). No upstream ⇒ refuse instead.
  const dir = mkdtempSync(join(tmpdir(), "rg-mc-noup-"));
  const src = join(dir, "src");
  const tgt = join(dir, "tgt");
  mkdirSync(tgt, { recursive: true });
  writeFileSync(join(tgt, "reviewer.md"), "---\nname: reviewer\nmodel: custom-model\n---\nbody\n");
  const res = applyAgentConfigLayer({
    agents: mapOf({ reviewer: { auto: true, source: "project" } }),
    targetDir: tgt, sourceDir: src, registry: REG,
  });
  assert.deepEqual(res.written, [], "nothing may be written when the upstream default is missing");
  assert.ok(res.errors.some((e) => e.includes("reviewer")), "the refusal must name the agent");
  assert.match(readFileSync(join(tgt, "reviewer.md"), "utf8"), /model: custom-model/, "the hand-written file is left untouched");
  rmSync(dir, { recursive: true, force: true });
});

test("restoreDefault restores the upstream default on cleanup (infrastructure layer)", () => {
  // Round-7 P1: the global layer is the pi-subagents load source; deleting a
  // generated file when the config is lifted would leave NO user-level agent
  // until the next install. With restoreDefault the upstream default is copied
  // back instead.
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } }),
      targetDir, sourceDir, registry: REG,
    });
    assert.match(readFileSync(join(targetDir, "reviewer.md"), "utf8"), /# @generated by pi-review-gate/);
    // Lift the config with restoreDefault (global-layer semantics).
    const { map } = effectiveAgentsConfig(undefined, undefined); // all default → cleanup
    const res = applyAgentConfigLayer({ agents: map, targetDir, sourceDir, registry: REG, restoreDefault: true });
    assert.equal(res.deleted.length, 0, "infrastructure layer restores, never deletes");
    const text = readFileSync(join(targetDir, "reviewer.md"), "utf8");
    assert.match(text, /model: claude-fable-5/, "upstream default restored");
    assert.doesNotMatch(text, /# @generated by pi-review-gate/, "restored file is the plain default");
    assert.equal(existsSync(join(targetDir, "reviewer.md.bak")), false, "no orphaned backup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Bootstrap self-heal — the mechanism that keeps a REQUIRED role dispatchable
// ---------------------------------------------------------------------------

test("resolvePackageAgentsDir probes the install layouts and requires a real directory", () => {
  // The gate's own agents/ dir is a sibling of lib/, which is the layout the
  // second probe candidate exists for. A single unprobed path is exactly how
  // the self-heal below turns into a silent no-op on a published install.
  const found = resolvePackageAgentsDir();
  assert.ok(found, "the package's own agents dir must resolve from lib/");
  assert.equal(existsSync(join(found!, "goal-auditor.md")), true, "and it must be the dir that ships the roles");
  // Never throws, even where import.meta.url is not a file URL (the postinstall
  // imports this module as a data: URL) — the call is lazy and guarded, so the
  // worst case is null, never a crash that takes the render down.
  assert.doesNotThrow(() => resolvePackageAgentsDir());
});

test("resolvePackageAgentsDir probes the THREE layouts in order and requires THIS package's agents dir", () => {
  // The order is the guard: a probe that only checked one relative path is
  // exactly how the self-heal became a silent no-op on a published install.
  const root = mkdtempSync(join(tmpdir(), "agents-probe-"));
  const asAgentsDir = (dir: string): string => {
    mkdirSync(dir, { recursive: true });
    // Identity marker: a bare directory named `agents` is NOT this package's.
    writeFileSync(join(dir, "reviewer.md"), "---\nname: reviewer\n---\n");
    return dir;
  };
  try {
    const here = join(root, "a", "b", "lib");
    mkdirSync(here, { recursive: true });
    // Third candidate only (<here>/../../agents) — the nested install layout.
    const nested = asAgentsDir(join(root, "a", "agents"));
    assert.equal(resolvePackageAgentsDir(here), nested, "must fall through to the third layout");
    // Second candidate (<here>/../agents) outranks the third.
    const sibling = asAgentsDir(join(root, "a", "b", "agents"));
    assert.equal(resolvePackageAgentsDir(here), sibling, "the lib/ sibling wins over the nested layout");
    // First candidate (<here>/agents) outranks both.
    const own = asAgentsDir(join(here, "agents"));
    assert.equal(resolvePackageAgentsDir(here), own, "the package-root layout is probed first");
    // A FILE named agents is not a layout — the probe requires a directory,
    // otherwise the copy loop would fail on every role.
    const fileOnly = join(root, "f", "lib");
    mkdirSync(fileOnly, { recursive: true });
    writeFileSync(join(fileOnly, "agents"), "not a dir\n");
    assert.equal(resolvePackageAgentsDir(fileOnly), null, "a file must not satisfy the probe");
    // A FOREIGN `agents/` directory (no role files) must be rejected: the third
    // candidate reaches two levels up, where an unrelated folder can live, and
    // adopting it would feed foreign files to the renderer AND the self-heal.
    const foreign = join(root, "g", "lib");
    mkdirSync(join(root, "g", "agents", "unrelated"), { recursive: true });
    mkdirSync(foreign, { recursive: true });
    assert.equal(resolvePackageAgentsDir(foreign), null, "a directory without this package's roles is not a match");
    // Nothing anywhere ⇒ null (diagnosable), never a throw.
    const empty = join(root, "empty", "lib");
    mkdirSync(empty, { recursive: true });
    assert.equal(resolvePackageAgentsDir(empty), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureAgentFilesPresent fills GAPS only, is idempotent, and never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-heal-"));
  try {
    const sourceDir = join(dir, "pkg");
    const targetDir = join(dir, "home");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(sourceDir, "goal-auditor.md"), "---\nname: goal-auditor\n---\nupstream\n");
    writeFileSync(join(sourceDir, "reviewer.md"), "---\nname: reviewer\n---\nupstream\n");
    // An existing (locally customized) file must survive untouched.
    writeFileSync(join(targetDir, "reviewer.md"), "mine\n");

    const first = ensureAgentFilesPresent({ sourceDir, targetDir, agents: ["goal-auditor", "reviewer"] });
    assert.deepEqual(first.copied, ["goal-auditor"], "only the MISSING role is restored");
    assert.equal(readFileSync(join(targetDir, "reviewer.md"), "utf8"), "mine\n", "an existing file is never clobbered");
    assert.match(readFileSync(join(targetDir, "goal-auditor.md"), "utf8"), /upstream/);

    // Idempotent: a second session start copies nothing.
    const second = ensureAgentFilesPresent({ sourceDir, targetDir, agents: ["goal-auditor", "reviewer"] });
    assert.deepEqual(second.copied, [], "the second run is a no-op");
    assert.deepEqual(second.problems, []);

    // A role the package does not ship is simply skipped (no problem, no throw).
    const absent = ensureAgentFilesPresent({ sourceDir, targetDir, agents: ["not-shipped"] });
    assert.deepEqual(absent.copied, []);
    assert.deepEqual(absent.problems, []);

    // An unresolvable source is REPORTED, never silent: a quiet no-op here is
    // what leaves a required role missing and the session deadlocked.
    const unresolved = ensureAgentFilesPresent({ sourceDir: null, targetDir, agents: ["goal-auditor"] });
    assert.deepEqual(unresolved.copied, []);
    assert.match(unresolved.problems.join("\n"), /包内 agents 目录无法定位/);

    // Fail-soft: an unwritable target is a problem line, not an exception.
    const blocked = ensureAgentFilesPresent({
      sourceDir,
      targetDir: join(sourceDir, "goal-auditor.md"), // a FILE, not a dir
      agents: ["reviewer"],
    });
    assert.deepEqual(blocked.copied, []);
    assert.equal(blocked.problems.length, 1, "the failure is reported per agent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restoreDefault never DELETES the only copy when the upstream is unresolvable", () => {
  // Hardened branch: the infrastructure layer used to fall through to rmSync
  // when the upstream file could not be found, so "restore the default" became
  // "remove the user's only copy" — for a required role that is a deadlock.
  const { dir, sourceDir, targetDir } = tempRepo();
  try {
    applyAgentConfigLayer({
      agents: mapOf({ reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } }),
      targetDir, sourceDir, registry: REG,
    });
    assert.equal(existsSync(join(targetDir, "reviewer.md")), true);
    rmSync(join(sourceDir, "reviewer.md"), { force: true }); // upstream vanishes
    const { map } = effectiveAgentsConfig(undefined, undefined); // config lifted → cleanup
    const res = applyAgentConfigLayer({ agents: map, targetDir, sourceDir, registry: REG, restoreDefault: true });
    assert.equal(existsSync(join(targetDir, "reviewer.md")), true, "the file must survive an unresolvable upstream");
    assert.deepEqual(res.deleted, [], "restore-default must never degenerate into a delete");
    assert.match(res.warnings.join("\n"), /unresolvable/, "and it must say why it kept the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the self-heal's agent list covers the gate-critical goal-auditor role", () => {
  // The extension hands KNOWN_AGENTS to ensureAgentFilesPresent, so dropping
  // goal-auditor from this list would silently stop healing the ONE role that
  // can block every goal approval — the exact deadlock the heal exists for.
  assert.ok(KNOWN_AGENTS.includes("goal-auditor"), "goal-auditor must be a known (and therefore healed) agent");
  const dir = mkdtempSync(join(tmpdir(), "agent-heal-known-"));
  try {
    const sourceDir = join(dir, "pkg");
    const targetDir = join(dir, "home");
    mkdirSync(sourceDir, { recursive: true });
    for (const name of KNOWN_AGENTS) writeFileSync(join(sourceDir, `${name}.md`), `---\nname: ${name}\n---\n`);
    const res = ensureAgentFilesPresent({ sourceDir, targetDir, agents: KNOWN_AGENTS });
    assert.deepEqual([...res.copied].sort(), [...KNOWN_AGENTS].sort(), "every shipped role is restorable");
    assert.equal(existsSync(join(targetDir, "goal-auditor.md")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

test("validateAgentsForStartup refuses a role with NO config entry", () => {
  const checks = validateAgentsForStartup({}, REG, ["reviewer"]);
  assert.equal(checks.reviewer.ok, false);
  assert.match(checks.reviewer.reason ?? "", /没有任何配置/);
});

test("validateAgentsForStartup refuses auto:true (no explicit slots)", () => {
  const map: AgentsConfigMap = { reviewer: { auto: true, slots: [], source: "default" } };
  const checks = validateAgentsForStartup(map, REG, ["reviewer"]);
  assert.equal(checks.reviewer.ok, false);
  assert.match(checks.reviewer.reason ?? "", /未配置模型链/);
});

test("validateAgentsForStartup refuses an empty slot list under auto:false", () => {
  const map: AgentsConfigMap = { reviewer: { auto: false, slots: [], source: "global" } };
  const checks = validateAgentsForStartup(map, REG, ["reviewer"]);
  assert.equal(checks.reviewer.ok, false);
  assert.match(checks.reviewer.reason ?? "", /未配置模型链/);
});

test("validateAgentsForStartup refuses an unresolvable spec", () => {
  const map: AgentsConfigMap = {
    reviewer: { auto: false, slots: ["anthropic/claude-nonexistent:max"], source: "global" },
  };
  const checks = validateAgentsForStartup(map, REG, ["reviewer"]);
  assert.equal(checks.reviewer.ok, false);
  assert.match(checks.reviewer.reason ?? "", /spec 非法或不可解析/);
});

test("validateAgentsForStartup refuses a malformed entry", () => {
  const map: AgentsConfigMap = { reviewer: { auto: true, slots: [], source: "global", malformed: true } };
  const checks = validateAgentsForStartup(map, REG, ["reviewer"]);
  assert.equal(checks.reviewer.ok, false);
  assert.match(checks.reviewer.reason ?? "", /malformed/);
});

test("validateAgentsForStartup passes a fully configured role", () => {
  const map: AgentsConfigMap = {
    reviewer: { auto: false, slots: ["anthropic/claude-fable-5:max"], source: "global" },
  };
  const checks = validateAgentsForStartup(map, REG, ["reviewer"]);
  assert.equal(checks.reviewer.ok, true);
});
});
