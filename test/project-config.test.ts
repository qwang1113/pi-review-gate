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
  assert.equal(cfg.gitMemory, false);
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

test("thinkHarder=false and gitMemory=true are honored", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ thinkHarder: false, gitMemory: true }));
  const cfg = loadProjectConfig(d);
  assert.equal(cfg.thinkHarder, false);
  assert.equal(cfg.gitMemory, true);
});

test("non-boolean flags keep defaults; other valid fields still apply", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ thinkHarder: "yes", gitMemory: 1, maxRounds: 12 }));
  const cfg = loadProjectConfig(d);
  assert.equal(cfg.thinkHarder, true);   // default
  assert.equal(cfg.gitMemory, false);    // default
  assert.equal(cfg.maxRounds, 12);       // valid field still honored
});

test("unknown fields are ignored", () => {
  const d = makeTemp();
  writeConfig(d, JSON.stringify({ maxRounds: 8, futureKnob: "x" }));
  assert.equal(loadProjectConfig(d).maxRounds, 8);
});
