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

function writeConfig(cwd: string, content: string): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(projectConfigPath(cwd), content);
}

// ---------------------------------------------------------------------------
// defaults & missing/corrupt config — fail-safe, never fail-open
// ---------------------------------------------------------------------------

test("no config file → defaults", () => {
  const cfg = loadProjectConfig(makeTemp());
  assert.deepEqual(cfg, defaultProjectConfig());
  assert.equal(cfg.maxRounds, DEFAULT_MAX_ROUNDS);
  assert.equal(cfg.thinkHarder, true);
  assert.equal(cfg.gitMemory, true);
});

test("corrupt JSON → defaults (fail-safe)", () => {
  const d = makeTemp();
  writeConfig(d, "{maxRounds: broken");
  assert.deepEqual(loadProjectConfig(d), defaultProjectConfig());
});

test("non-object JSON (array/number/null) → defaults", () => {
  for (const content of ["[1,2]", "42", "null", '"str"']) {
    const d = makeTemp();
    writeConfig(d, content);
    assert.deepEqual(loadProjectConfig(d), defaultProjectConfig(), content);
  }
});

// ---------------------------------------------------------------------------
// maxRounds (sd0x-dev-flow R6): clamped to [3, 50] — forged huge caps rejected
// ---------------------------------------------------------------------------

test("maxRounds override within range is honored", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ maxRounds: 5 }));
  assert.equal(loadProjectConfig(d).maxRounds, 5);
});

test("maxRounds above cap is clamped to MAX (forged 100000 can't disable the cap)", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ maxRounds: 100000 }));
  assert.equal(loadProjectConfig(d).maxRounds, MAX_MAX_ROUNDS);
});

test("maxRounds below floor is clamped to MIN", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ maxRounds: 1 }));
  assert.equal(loadProjectConfig(d).maxRounds, MIN_MAX_ROUNDS);
});

test("non-integer / non-numeric maxRounds keeps default", () => {
  for (const v of [3.5, "7", true, null, [7]]) {
    const d = makeTemp();
    writeConfig(d, JSON.stringify({ maxRounds: v }));
    assert.equal(loadProjectConfig(d).maxRounds, DEFAULT_MAX_ROUNDS, String(v));
  }
});

// ---------------------------------------------------------------------------
// thinkHarder (R10) / gitMemory (R9) — independent boolean validation
// ---------------------------------------------------------------------------

test("thinkHarder=false and gitMemory=false are honored (explicit opt-out)", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ thinkHarder: false, gitMemory: false }));
  const cfg = loadProjectConfig(d);
  assert.equal(cfg.thinkHarder, false);
  assert.equal(cfg.gitMemory, false);
});

test("non-boolean flags keep defaults; other valid fields still apply", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ thinkHarder: "yes", gitMemory: 1, maxRounds: 12 }));
  const cfg = loadProjectConfig(d);
  assert.equal(cfg.thinkHarder, true);   // default
  assert.equal(cfg.gitMemory, true);     // default (ON)
  assert.equal(cfg.maxRounds, 12);       // valid field still honored
});

test("unknown fields are ignored", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ maxRounds: 8, futureKnob: "x" }));
  assert.equal(loadProjectConfig(d).maxRounds, 8);
});

// ---------------------------------------------------------------------------
// docSync knob — default ON boolean; explicit false disables; invalid → default
// ---------------------------------------------------------------------------

test("docSync defaults ON; explicit false disables; non-boolean keeps default", () => {
  assert.equal(loadProjectConfig(makeTemp()).docSync, true);

  const d1 = makeTemp();
  writeConfig(d1, JSON.stringify({ docSync: false }));
  assert.equal(loadProjectConfig(d1).docSync, false);

  const d2 = makeTemp();
  writeConfig(d2, JSON.stringify({ docSync: "yes" }));
  assert.equal(loadProjectConfig(d2).docSync, true); // fail-safe default (enforced)
});

// ---------------------------------------------------------------------------
// llmGuards (LLM semantic guard layer — DeepSeek V4 Flash)

test("llmGuards defaults: all guards on, fixed flash model", () => {
  const d = makeTemp();
  assert.deepEqual(loadProjectConfig(d).llmGuards, {
    model: "deepseek/deepseek-v4-flash",
    taskMode: true,
    aiAttribution: true,
    englishCheck: true,
    shipDetect: true,
  });
  assert.deepEqual(defaultProjectConfig().llmGuards, loadProjectConfig(d).llmGuards);
});

test("llmGuards fields load independently; invalid fields keep defaults", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({
    llmGuards: { taskMode: false, shipDetect: false, aiAttribution: "yes", model: 42 },
  }));
  const lg = loadProjectConfig(d).llmGuards;
  assert.equal(lg.taskMode, false);
  assert.equal(lg.shipDetect, false);
  assert.equal(lg.aiAttribution, true);  // invalid type → default
  assert.equal(lg.englishCheck, true);   // absent → default
  assert.equal(lg.model, "deepseek/deepseek-v4-flash"); // invalid type → default
});

test("llmGuards model accepts provider/id and rejects malformed ids", () => {
  const good = makeTemp();
  writeConfig(good, JSON.stringify({ llmGuards: { model: "onekey/deepseek-v4-flash" } }));
  assert.equal(loadProjectConfig(good).llmGuards.model, "onekey/deepseek-v4-flash");

  for (const bad of ["no-slash", "/x", "x/", "a b/c"]) {
    const d = makeTemp();
    writeConfig(d, JSON.stringify({ llmGuards: { model: bad } }));
    assert.equal(loadProjectConfig(d).llmGuards.model, "deepseek/deepseek-v4-flash", bad);
  }
});

test("llmGuards non-object (null/array/string) keeps all defaults", () => {
  for (const bad of [null, [], "on", 1, true]) {
    const d = makeTemp();
    writeConfig(d, JSON.stringify({ llmGuards: bad }));
    assert.deepEqual(loadProjectConfig(d).llmGuards, defaultProjectConfig().llmGuards, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// arbiter (narrow capability-exception config)

test("arbiter defaults: enabled, strong model, small per-session cap", () => {
  const d = makeTemp();
  assert.deepEqual(loadProjectConfig(d).arbiter, {
    enabled: true,
    model: "onekey/gpt-5.6-sol",
    maxPerSession: 3,
  });
  assert.deepEqual(defaultProjectConfig().arbiter, loadProjectConfig(d).arbiter);
});

test("arbiter fields load independently; invalid fields keep defaults", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ arbiter: { enabled: false, model: "prov/model-x", maxPerSession: 5 } }));
  const ab = loadProjectConfig(d).arbiter;
  assert.equal(ab.enabled, false);
  assert.equal(ab.model, "prov/model-x");
  assert.equal(ab.maxPerSession, 5);
});

test("arbiter maxPerSession is clamped to [1,10] (a forged huge cap can't make re-rolling free)", () => {
  const hi = makeTemp();
  writeConfig(hi, JSON.stringify({ arbiter: { maxPerSession: 100000 } }));
  assert.equal(loadProjectConfig(hi).arbiter.maxPerSession, 10);
  const lo = makeTemp();
  writeConfig(lo, JSON.stringify({ arbiter: { maxPerSession: 0 } }));
  assert.equal(loadProjectConfig(lo).arbiter.maxPerSession, 1);
});

test("arbiter invalid model / non-object keeps defaults", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ arbiter: { model: "no-slash", enabled: "yes" } }));
  const ab = loadProjectConfig(d).arbiter;
  assert.equal(ab.model, "onekey/gpt-5.6-sol"); // invalid → default
  assert.equal(ab.enabled, true);               // invalid type → default
  for (const bad of [null, [], "on", 1]) {
    const b = makeTemp();
    writeConfig(b, JSON.stringify({ arbiter: bad }));
    assert.deepEqual(loadProjectConfig(b).arbiter, defaultProjectConfig().arbiter, JSON.stringify(bad));
  }
});
