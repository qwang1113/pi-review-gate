import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { validateConfigText } from "../lib/config-validate.ts";
import type { ModelRegistry } from "../lib/model-spec.ts";

const registry: ModelRegistry = { anthropic: [{ id: "claude-fable-5", reasoning: true, thinkingLevelMap: { max: "max", high: "high" } }] };
const good = { auto: false, slots: ["anthropic/claude-fable-5:max"] };

test("gate: a resolvable chain passes", () => {
  const v = validateConfigText("gate", JSON.stringify({ agents: { reviewer: good }, precommit: { lint: null, test: { fast: "test" } } }), registry);
  assert.deepEqual(v, { ok: true, errors: [] });
});

test("gate: an unresolvable slot is refused and names agents.<role>", () => {
  const v = validateConfigText("gate", JSON.stringify({ agents: { reviewer: good, adviser: { auto: false, slots: ["nope/ghost-9"] } } }), registry);
  assert.equal(v.ok, false);
  assert.deepEqual(v.errors.map((i) => i.path), ["agents.adviser"]);
  assert.match(v.errors[0].message, /ghost-9/);
});

test("gate: a role left out is not an error (the start-up heal fills it); a malformed one is", () => {
  assert.equal(validateConfigText("gate", "{}", registry).ok, true);
  const v = validateConfigText("gate", JSON.stringify({ agents: { reviewer: "typo" } }), registry);
  assert.deepEqual(v.errors.map((i) => i.path), ["agents.reviewer"]);
});

test("gate: a bad precommit step is refused by path", () => {
  const v = validateConfigText("gate", JSON.stringify({ precommit: { lint: 3, test: { fast: {} } } }), registry);
  assert.deepEqual(v.errors.map((i) => i.path), ["precommit.lint", "precommit.test.fast"]);
});

test("syntax error and non-object root", () => {
  // V8 names no position for an unexpected token; the line/column is found anyway.
  const syn = validateConfigText("pi-settings", '{\n  "a": }', registry);
  assert.equal(syn.ok, false);
  assert.match(syn.errors[0].message, /JSON 语法错误（第 2 行第 8 列）/);
  assert.match(validateConfigText("gate", '{"a":1', registry).errors[0].message, /第 1 行第 7 列/);
  assert.match(validateConfigText("gate", "{}\nx", registry).errors[0].message, /第 2 行第 1 列/);
  assert.equal(validateConfigText("pi-models", "[]", registry).ok, false);
});

test("pi-settings: known field types", () => {
  assert.equal(validateConfigText("pi-settings", JSON.stringify({ defaultModel: "x", defaultThinkingLevel: "max", extensions: ["a"], unknownKey: 1 }), registry).ok, true);
  const v = validateConfigText("pi-settings", JSON.stringify({ defaultModel: 3, defaultThinkingLevel: "huge", extensions: [1], quietStartup: "yes" }), registry);
  assert.deepEqual(v.errors.map((i) => i.path).sort(), ["defaultModel", "defaultThinkingLevel", "extensions", "quietStartup"]);
});

test("pi-models: providers shape", () => {
  assert.equal(validateConfigText("pi-models", JSON.stringify({ providers: { p: { models: [{ id: "m" }] } } }), registry).ok, true);
  const v = validateConfigText("pi-models", JSON.stringify({ providers: { p: { models: [{ name: "m" }] } } }), registry);
  assert.deepEqual(v.errors.map((i) => i.path), ["providers.p.models.0"]);
});

const tmp: string[] = [];
after(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("the CLI reads the registry under $HOME and prints one verdict line", () => {
  const home = mkdtempSync(join(tmpdir(), "rg-cfgval-"));
  tmp.push(home);
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: registryAsModels() }));
  const script = fileURLToPath(new URL("../scripts/validate-config.ts", import.meta.url));
  const run = (kind: string, text: string) => spawnSync(process.execPath, [script], { input: JSON.stringify({ kind, text }), env: { ...process.env, HOME: home }, encoding: "utf8" });
  const ok = run("gate", JSON.stringify({ agents: { reviewer: good } }));
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { ok: true, errors: [] });
  const bad = run("gate", JSON.stringify({ agents: { reviewer: { auto: false, slots: ["x/y"] } } }));
  assert.equal(JSON.parse(bad.stdout).errors[0].path, "agents.reviewer");
  assert.equal(run("nope", "{}").status, 2);
});

function registryAsModels() {
  return Object.fromEntries(Object.entries(registry).map(([p, ms]) => [p, { models: ms }]));
}
