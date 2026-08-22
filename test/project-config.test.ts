import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  defaultProjectConfig,
  loadProjectConfig,
  projectConfigPath,
  MIN_MAX_ROUNDS,
  MAX_MAX_ROUNDS,
  type ProjectConfig,
} from "../lib/project-config.ts";
import { DEFAULT_MAX_ROUNDS } from "../lib/constants.ts";

const tempDirs: string[] = [];
function makeTemp(): string {
  const d = mkdtempSync(join(tmpdir(), "rg-cfg-"));
  tempDirs.push(d);
  return d;
}
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// HERMETIC HOME: loadProjectConfig without homeOverride reads the REAL
// user's ~/.pi/review-gate.json — a user who actually uses this feature
// would make these tests fail (measured: 6 failures with a real global
// config present). Every test loads through loadCfg with a throwaway home.
const emptyHome = makeTemp();
function loadCfg(cwd: string): ProjectConfig {
  return loadProjectConfig(cwd, emptyHome);
}

function writeConfig(cwd: string, content: string): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(projectConfigPath(cwd), content);
}

// ---------------------------------------------------------------------------
// defaults & missing/corrupt config — fail-safe, never fail-open
// ---------------------------------------------------------------------------

test("no config file → defaults", () => {
  const cfg = loadCfg(makeTemp());
  assert.deepEqual(cfg, defaultProjectConfig());
  assert.equal(cfg.maxRounds, DEFAULT_MAX_ROUNDS);
  assert.equal(cfg.thinkHarder, true);
  assert.equal(cfg.gitMemory, true);
  // L7 ships ON: a repo with no gh / no GitHub remote / no PR resolves to
  // UNSUPPORTED on the first check, so "on" costs nothing where the feature
  // does not exist — while "off by default" would mean nobody gets it.
  assert.equal(cfg.copilotReview.enabled, true);
  // The owner allow-list is the cold-start fallback for "is Copilot review
  // available here?" — GitHub publishes no way to ask.
  assert.deepEqual(cfg.copilotReview.owners, ["onekeyhq"]);
});

test("global config (~/.pi/review-gate.json) fills unset fields; project wins field-by-field", () => {
  const cwd = makeTemp();
  const home = makeTemp();
  // Global layer: docSync off, maxRounds 7, gitMemory off, copilot owners.
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(join(home, ".pi", "review-gate.json"), JSON.stringify({
    maxRounds: 7,
    docSync: false,
    gitMemory: false,
    copilotReview: { owners: ["acme"] },
  }));
  // Project layer overrides ONLY docSync and maxRounds.
  writeConfig(cwd, JSON.stringify({ docSync: true, maxRounds: 13 }));
  const cfg = loadProjectConfig(cwd, home);
  // Project wins where it states the field…
  assert.equal(cfg.docSync, true);
  assert.equal(cfg.maxRounds, 13);
  // …global fills the rest…
  assert.equal(cfg.gitMemory, false);
  assert.deepEqual(cfg.copilotReview.owners, ["acme"]);
  // …and untouched fields keep the defaults.
  assert.equal(cfg.thinkHarder, true);
  assert.equal(cfg.llmGuards.model, "deepseek/deepseek-v4-flash");
});

test("global config alone (no project file) applies; corrupt global keeps defaults", () => {
  const cwd = makeTemp();
  const home = makeTemp();
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(join(home, ".pi", "review-gate.json"), "{ not json");
  // Corrupt global must NOT loosen anything (fail-safe).
  assert.equal(loadProjectConfig(cwd, home).docSync, true);
  writeFileSync(join(home, ".pi", "review-gate.json"), JSON.stringify({ docSync: false }));
  assert.equal(loadProjectConfig(cwd, home).docSync, false);
  // A project file that contradicts the global wins.
  writeConfig(cwd, JSON.stringify({ docSync: true }));
  assert.equal(loadProjectConfig(cwd, home).docSync, true);
});

test("agents section is carried per layer (project over global over undefined)", () => {
  const cwd = makeTemp();
  const home = makeTemp();
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(join(home, ".pi", "review-gate.json"), JSON.stringify({
    agents: { worker: { auto: false, slots: ["claude-sonnet-5:max"] } },
  }));
  writeConfig(cwd, JSON.stringify({
    agents: { reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } },
  }));
  const cfg = loadProjectConfig(cwd, home);
  assert.deepEqual(cfg.agentsGlobal, { worker: { auto: false, slots: ["claude-sonnet-5:max"] } }, "global agents must survive");
  assert.deepEqual(cfg.agentsProject, { reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } }, "project agents must survive");
  // Defaults keep agents layers undefined when no section is configured.
  assert.equal(defaultProjectConfig().agentsGlobal, undefined);
  assert.equal(defaultProjectConfig().agentsProject, undefined);
  // A non-object `agents` value (string AND array) is ignored with a diagnostic.
  writeConfig(cwd, JSON.stringify({ agents: "nope" }));
  assert.equal(loadProjectConfig(cwd, home).agentsProject, undefined);
  assert.match(loadProjectConfig(cwd, home).agentsDiagnostics.join("\n"), /project: the agents section is not an object/);
  writeConfig(cwd, JSON.stringify({ agents: ["reviewer"] }));
  assert.equal(loadProjectConfig(cwd, home).agentsProject, undefined, "array agents must also be ignored");
  assert.match(loadProjectConfig(cwd, home).agentsDiagnostics.join("\n"), /project: the agents section is not an object/);
});

test("precommit steps merge ACROSS layers step-by-step (project wins per step)", () => {
  const cwd = makeTemp();
  const home = makeTemp();
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(join(home, ".pi", "review-gate.json"), JSON.stringify({
    precommit: { lint: "lint:global", test: { fast: { script: "test:unit", narrow: true } } },
  }));
  // Project overrides ONLY the test step; lint must survive from the global.
  writeConfig(cwd, JSON.stringify({ precommit: { test: { full: { command: "yarn test" } } } }));
  const cfg = loadProjectConfig(cwd, home);
  assert.deepEqual(cfg.precommit?.lint, { script: "lint:global" },
    "a step the project does not mention keeps the global value");
  assert.deepEqual(cfg.precommit?.test, { full: { command: "yarn test" } },
    "the project's test step replaces the global test step entirely");
  // Explicit null (skip) in the project wins over a global value.
  const cwd2 = makeTemp();
  writeConfig(cwd2, JSON.stringify({ precommit: { test: null } }));
  const cfg2 = loadProjectConfig(cwd2, home);
  assert.equal(cfg2.precommit?.test, null, "an explicit project skip wins");
  assert.deepEqual(cfg2.precommit?.lint, { script: "lint:global" }, "lint still merges");
});

test("copilotReview: honored and fail-safe on garbage", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ copilotReview: { enabled: false } }));
  assert.equal(loadCfg(d).copilotReview.enabled, false);

  // Wrong shapes are ignored entirely rather than half-applied.
  const g = makeTemp();
  writeConfig(g, JSON.stringify({ copilotReview: ["nope"] }));
  assert.deepEqual(loadCfg(g).copilotReview, defaultProjectConfig().copilotReview);
  const h = makeTemp();
  writeConfig(h, JSON.stringify({ copilotReview: { enabled: "yes" } }));
  assert.deepEqual(loadCfg(h).copilotReview, defaultProjectConfig().copilotReview);

  // `maxRounds` was REMOVED (a round cap could only ever end a task with
  // review comments unhandled). A config still carrying it stays valid and
  // the key is simply inert — it must not resurrect a cap.
  const i = makeTemp();
  writeConfig(i, JSON.stringify({ copilotReview: { maxRounds: 3 } }));
  assert.deepEqual(loadCfg(i).copilotReview, defaultProjectConfig().copilotReview);
});

test("copilotReview.owners: REPLACES the default, normalized, junk-safe", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ copilotReview: { owners: ["Acme", "  OTHER-Org "] } }));
  assert.deepEqual(loadCfg(d).copilotReview.owners, ["acme", "other-org"],
    "lowercased, trimmed, and the default org is NOT silently kept");

  // An explicit empty list is a real choice: "evidence only, trust no owner".
  const e = makeTemp();
  writeConfig(e, JSON.stringify({ copilotReview: { owners: [] } }));
  assert.deepEqual(loadCfg(e).copilotReview.owners, []);

  // Junk entries are dropped; an all-junk array degrades to the same
  // evidence-only end rather than to somebody else's organisation.
  const f = makeTemp();
  writeConfig(f, JSON.stringify({ copilotReview: { owners: [42, null, "  ", { x: 1 }] } }));
  assert.deepEqual(loadCfg(f).copilotReview.owners, []);
  const g = makeTemp();
  writeConfig(g, JSON.stringify({ copilotReview: { owners: [42, "Keep"] } }));
  assert.deepEqual(loadCfg(g).copilotReview.owners, ["keep"]);

  // A non-array keeps the default untouched (half-applied config is worse).
  const h = makeTemp();
  writeConfig(h, JSON.stringify({ copilotReview: { owners: "acme" } }));
  assert.deepEqual(loadCfg(h).copilotReview.owners, ["onekeyhq"]);
});

test("corrupt JSON → defaults + corrupt flag (renderer must keep last render)", () => {
  const d = makeTemp();
  writeConfig(d, "{maxRounds: broken");
  const cfg = loadCfg(d);
  const expected = defaultProjectConfig();
  expected.agentsProjectCorrupt = true; // file EXISTS but does not parse
  assert.deepEqual(cfg, expected);
});

test("non-object JSON (array/number/null) → defaults + corrupt flag", () => {
  for (const content of ["[1,2]", "42", "null", '"str"']) {
    const d = makeTemp();
    writeConfig(d, content);
    const expected = defaultProjectConfig();
    expected.agentsProjectCorrupt = true; // exists-but-not-an-object is corrupt too
    assert.deepEqual(loadCfg(d), expected, content);
  }
});

test("corrupt GLOBAL config sets agentsGlobalCorrupt (agentsGlobal stays unset)", () => {
  const d = makeTemp();
  const home = makeTemp();
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(join(home, ".pi", "review-gate.json"), "not json at all");
  const cfg = loadProjectConfig(d, home);
  assert.equal(cfg.agentsGlobalCorrupt, true, "existing-but-broken global file must be flagged");
  assert.equal(cfg.agentsGlobal, undefined);
  assert.equal(cfg.agentsProjectCorrupt, false, "missing project file is NOT corrupt");
});

test("a config path that EXISTS but cannot be read is corrupt, not absent (fail-safe)", () => {
  // Round-12 Nit: readConfigObject swallowed every readFileSync error as "no
  // file", so an unreadable config looked exactly like an absent one and the
  // renderer's cleanup sweep could clobber a valid render. Only ENOENT/ENOTDIR
  // are genuinely absent.
  //
  // Round-12 R2 P2: the first version of this test used chmod 000, which root
  // ignores — the assertion was silently skipped on a root CI/dev box and the
  // branch stayed unprotected. A DIRECTORY at the config path fails
  // deterministically for every uid (EISDIR, which is neither ENOENT nor
  // ENOTDIR), so the corrupt-flag branch is always exercised.
  const d = makeTemp();
  const home = makeTemp();
  mkdirSync(join(home, ".pi", "review-gate.json"), { recursive: true });
  const cfg = loadProjectConfig(d, home);
  assert.equal(cfg.agentsGlobalCorrupt, true, "an unreadable global config must be flagged corrupt");
  assert.equal(cfg.agentsGlobal, undefined);
  // Same rule for the PROJECT layer.
  const d2 = makeTemp();
  mkdirSync(join(d2, ".pi", "review-gate.json"), { recursive: true });
  const pcfg = loadProjectConfig(d2, makeTemp());
  assert.equal(pcfg.agentsProjectCorrupt, true, "an unreadable project config must be flagged corrupt");
  // A genuinely MISSING file stays "absent" (not corrupt) — the sweep may run.
  const emptyHome = makeTemp();
  const cfg2 = loadProjectConfig(makeTemp(), emptyHome);
  assert.equal(cfg2.agentsGlobalCorrupt, false, "a missing global config is absent, not corrupt");
  assert.equal(cfg2.agentsProjectCorrupt, false, "a missing project config is absent, not corrupt");
});
test("malformed agents section (array) flags the layer corrupt, fail-safe", () => {
  // Round-11 P1: `{"agents":[]}` is valid JSON, so the top-level parse
  // succeeds — but a non-object agents section must NOT be treated as "no
  // agents section": the renderer would sweep the last rendered chains
  // back to defaults. Corrupt-flag the layer so the fail-safe keep applies.
  const d = makeTemp();
  const home = makeTemp();
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(join(home, ".pi", "review-gate.json"), JSON.stringify({ agents: [] }));
  const cfg = loadProjectConfig(d, home);
  assert.equal(cfg.agentsGlobalCorrupt, true, "non-object agents section must flag the global layer corrupt");
  assert.equal(cfg.agentsGlobal, undefined);
  assert.equal(cfg.agentsProjectCorrupt, false);
  const proj = makeTemp();
  writeConfig(proj, JSON.stringify({ agents: "nope" }));
  // An explicit EMPTY home keeps this hermetic: without it loadProjectConfig
  // reads the developer's real ~/.pi/review-gate.json as the global layer, so
  // the result depended on the machine it ran on.
  const pcfg = loadProjectConfig(proj, makeTemp());
  assert.equal(pcfg.agentsProjectCorrupt, true, "non-object agents section must flag the project layer corrupt");
  assert.equal(pcfg.agentsGlobalCorrupt, false, "the empty home has no global config to be corrupt");
  assert.equal(pcfg.agentsGlobal, undefined, "no global layer leaks in from the real HOME");
});

// ---------------------------------------------------------------------------
// maxRounds (sd0x-dev-flow R6): clamped to [3, 50] — forged huge caps rejected
// ---------------------------------------------------------------------------

test("maxRounds override within range is honored", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ maxRounds: 5 }));
  assert.equal(loadCfg(d).maxRounds, 5);
});

test("maxRounds above cap is clamped to MAX (forged 100000 can't disable the cap)", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ maxRounds: 100000 }));
  assert.equal(loadCfg(d).maxRounds, MAX_MAX_ROUNDS);
});

test("maxRounds below floor is clamped to MIN", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ maxRounds: 1 }));
  assert.equal(loadCfg(d).maxRounds, MIN_MAX_ROUNDS);
});

test("non-integer / non-numeric maxRounds keeps default", () => {
  for (const v of [3.5, "7", true, null, [7]]) {
    const d = makeTemp();
    writeConfig(d, JSON.stringify({ maxRounds: v }));
    assert.equal(loadCfg(d).maxRounds, DEFAULT_MAX_ROUNDS, String(v));
  }
});

// ---------------------------------------------------------------------------
// thinkHarder (R10) / gitMemory (R9) — independent boolean validation
// ---------------------------------------------------------------------------

test("thinkHarder=false and gitMemory=false are honored (explicit opt-out)", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ thinkHarder: false, gitMemory: false }));
  const cfg = loadCfg(d);
  assert.equal(cfg.thinkHarder, false);
  assert.equal(cfg.gitMemory, false);
});

test("non-boolean flags keep defaults; other valid fields still apply", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ thinkHarder: "yes", gitMemory: 1, maxRounds: 12 }));
  const cfg = loadCfg(d);
  assert.equal(cfg.thinkHarder, true);   // default
  assert.equal(cfg.gitMemory, true);     // default (ON)
  assert.equal(cfg.maxRounds, 12);       // valid field still honored
});

test("unknown fields are ignored", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ maxRounds: 8, futureKnob: "x" }));
  assert.equal(loadCfg(d).maxRounds, 8);
});

// ---------------------------------------------------------------------------
// docSync knob — default ON boolean; explicit false disables; invalid → default
// ---------------------------------------------------------------------------

test("docSync defaults ON; explicit false disables; non-boolean keeps default", () => {
  assert.equal(loadCfg(makeTemp()).docSync, true);

  const d1 = makeTemp();
  writeConfig(d1, JSON.stringify({ docSync: false }));
  assert.equal(loadCfg(d1).docSync, false);

  const d2 = makeTemp();
  writeConfig(d2, JSON.stringify({ docSync: "yes" }));
  assert.equal(loadCfg(d2).docSync, true); // fail-safe default (enforced)
});

// ---------------------------------------------------------------------------
// llmGuards (LLM semantic guard layer — DeepSeek V4 Flash)

test("llmGuards defaults: all guards on, fixed flash model", () => {
  const d = makeTemp();
  assert.deepEqual(loadCfg(d).llmGuards, {
    model: "deepseek/deepseek-v4-flash",
    aiAttribution: true,
    englishCheck: true,
    shipDetect: true,
  });
  assert.deepEqual(defaultProjectConfig().llmGuards, loadCfg(d).llmGuards);
});

test("llmGuards fields load independently; invalid fields keep defaults", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({
    // taskMode is a RETIRED knob (the decision moved in-session) — an old
    // config carrying it must be ignored, not rejected.
    llmGuards: { taskMode: false, shipDetect: false, aiAttribution: "yes", model: 42 },
  }));
  const lg = loadCfg(d).llmGuards;
  // Double cast: LlmGuardsConfig has no index signature, so TS rejects the
  // direct assertion. The point of the probe is exactly that the key is NOT on
  // the type — a retired knob must be dropped, not carried through.
  assert.equal((lg as unknown as Record<string, unknown>).taskMode, undefined);
  assert.equal(lg.shipDetect, false);
  assert.equal(lg.aiAttribution, true);  // invalid type → default
  assert.equal(lg.englishCheck, true);   // absent → default
  assert.equal(lg.model, "deepseek/deepseek-v4-flash"); // invalid type → default
});

test("llmGuards model accepts provider/id and rejects malformed ids", () => {
  const good = makeTemp();
  writeConfig(good, JSON.stringify({ llmGuards: { model: "onekey/deepseek-v4-flash" } }));
  assert.equal(loadCfg(good).llmGuards.model, "onekey/deepseek-v4-flash");

  for (const bad of ["no-slash", "/x", "x/", "a b/c"]) {
    const d = makeTemp();
    writeConfig(d, JSON.stringify({ llmGuards: { model: bad } }));
    assert.equal(loadCfg(d).llmGuards.model, "deepseek/deepseek-v4-flash", bad);
  }
});

test("llmGuards non-object (null/array/string) keeps all defaults", () => {
  for (const bad of [null, [], "on", 1, true]) {
    const d = makeTemp();
    writeConfig(d, JSON.stringify({ llmGuards: bad }));
    assert.deepEqual(loadCfg(d).llmGuards, defaultProjectConfig().llmGuards, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// arbiter (narrow capability-exception config)

test("arbiter defaults: enabled, strong model, small per-session cap", () => {
  const d = makeTemp();
  assert.deepEqual(loadCfg(d).arbiter, {
    enabled: true,
    model: "onekey/gpt-5.6-sol",
    maxPerSession: 3,
  });
  assert.deepEqual(defaultProjectConfig().arbiter, loadCfg(d).arbiter);
});

test("arbiter fields load independently; invalid fields keep defaults", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ arbiter: { enabled: false, model: "prov/model-x", maxPerSession: 5 } }));
  const ab = loadCfg(d).arbiter;
  assert.equal(ab.enabled, false);
  assert.equal(ab.model, "prov/model-x");
  assert.equal(ab.maxPerSession, 5);
});

test("arbiter maxPerSession is clamped to [1,10] (a forged huge cap can't make re-rolling free)", () => {
  const hi = makeTemp();
  writeConfig(hi, JSON.stringify({ arbiter: { maxPerSession: 100000 } }));
  assert.equal(loadCfg(hi).arbiter.maxPerSession, 10);
  const lo = makeTemp();
  writeConfig(lo, JSON.stringify({ arbiter: { maxPerSession: 0 } }));
  assert.equal(loadCfg(lo).arbiter.maxPerSession, 1);
});

test("arbiter invalid model / non-object keeps defaults", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ arbiter: { model: "no-slash", enabled: "yes" } }));
  const ab = loadCfg(d).arbiter;
  assert.equal(ab.model, "onekey/gpt-5.6-sol"); // invalid → default
  assert.equal(ab.enabled, true);               // invalid type → default
  for (const bad of [null, [], "on", 1]) {
    const b = makeTemp();
    writeConfig(b, JSON.stringify({ arbiter: bad }));
    assert.deepEqual(loadCfg(b).arbiter, defaultProjectConfig().arbiter, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// precommit section — per-step overrides, fail-safe fallback per step
// ---------------------------------------------------------------------------

test("no precommit section → cfg.precommit === null (default behavior)", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ maxRounds: 5 }));
  assert.equal(loadCfg(d).precommit, null);
  assert.equal(defaultProjectConfig().precommit, null);
});

test("precommit step shapes: string / null / {script} / {command} / {skip}", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({
    precommit: {
      lint: "lint:fix",
      typecheck: { command: "tsc --noEmit" },
      build: null,
    },
  }));
  const pc = loadCfg(d).precommit;
  assert.ok(pc !== null);
  assert.deepEqual(pc.lint, { script: "lint:fix" });
  assert.deepEqual(pc.typecheck, { command: "tsc --noEmit" });
  assert.equal(pc.build, null);
  assert.equal(pc.test, undefined);
});

test("precommit test per-lane shape with narrow; command wins over script", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({
    precommit: {
      test: {
        fast: { script: "test:unit", narrow: false },
        full: { command: "yarn test", script: "test" },
      },
    },
  }));
  const pc = loadCfg(d).precommit;
  assert.ok(pc !== null);
  assert.deepEqual(pc.test, {
    fast: { script: "test:unit", narrow: false },
    full: { command: "yarn test" },
  });
});

test("precommit test single-step shape applies to both lanes", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ precommit: { test: { command: "yarn test" } } }));
  const pc = loadCfg(d).precommit;
  assert.ok(pc !== null);
  assert.deepEqual(pc.test, { command: "yarn test" });
});

test("precommit invalid shapes fall back per step (independent, fail-safe)", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({
    precommit: {
      lint: 42,                    // invalid → ignored
      typecheck: "typecheck",      // valid → kept
      build: { script: 7 },        // invalid script type → ignored
      test: { fast: 3 },           // invalid fast → ignored; no full → nothing
    },
  }));
  const pc = loadCfg(d).precommit;
  assert.ok(pc !== null);
  assert.equal(pc.lint, undefined);
  assert.deepEqual(pc.typecheck, { script: "typecheck" });
  assert.equal(pc.build, undefined);
  assert.equal(pc.test, undefined);
});

test("precommit: whole section with no usable steps → null (default behavior)", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ precommit: { lint: 42, build: [] } }));
  assert.equal(loadCfg(d).precommit, null);
  for (const bad of [null, [], "on", 1]) {
    const b = makeTemp();
    writeConfig(b, JSON.stringify({ precommit: bad }));
    assert.equal(loadCfg(b).precommit, null, JSON.stringify(bad));
  }
});

test("precommit corrupt JSON keeps every other field default and precommit null", () => {
  const d = makeTemp();
  writeConfig(d, "{broken");
  const cfg = loadCfg(d);
  assert.equal(cfg.precommit, null);
  assert.equal(cfg.maxRounds, DEFAULT_MAX_ROUNDS);
});
