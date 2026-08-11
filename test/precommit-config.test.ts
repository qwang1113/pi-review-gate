/**
 * Project-level precommit configuration — the runner-side loader
 * (scripts/precommit-config.mjs). Mirrors lib/project-config.ts semantics:
 * every invalid shape falls back to the default detection per step, and a
 * missing/corrupt file NEVER changes the runner's behavior (fail-safe).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readPrecommitConfig } from "../scripts/precommit-config.mjs";

interface LoadedConfig {
  source: "project" | "default";
  path: string | null;
  invalid: string | null;
  steps: Record<string, any>;
}
function load(dir: string): LoadedConfig {
  return readPrecommitConfig(dir) as unknown as LoadedConfig;
}

const tempDirs: string[] = [];
function makeTemp(): string {
  const d = mkdtempSync(join(tmpdir(), "rg-pccfg-"));
  tempDirs.push(d);
  return d;
}
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function writeConfig(cwd: string, content: string): string {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const p = join(cwd, ".pi", "review-gate.json");
  writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// missing / corrupt config — fail-safe, never fail-open
// ---------------------------------------------------------------------------

test("no config file → source default, empty steps", () => {
  const cfg = load(makeTemp());
  assert.equal(cfg.source, "default");
  assert.equal(cfg.path, null);
  assert.equal(cfg.invalid, null);
  assert.deepEqual(cfg.steps, {});
});

test("unparseable JSON → source default + invalid reason", () => {
  const dir = makeTemp();
  const p = writeConfig(dir, "{not json");
  const cfg = load(dir);
  assert.equal(cfg.source, "default");
  assert.equal(cfg.path, p);
  assert.match(cfg.invalid ?? "", /unparseable JSON/);
  assert.deepEqual(cfg.steps, {});
});

test("config root not an object → default", () => {
  const dir = makeTemp();
  writeConfig(dir, "[1, 2]");
  assert.equal(load(dir).source, "default");
  assert.match(load(dir).invalid ?? "", /not an object/);
});

test("precommit section missing/null → default, no invalid reason", () => {
  const dir = makeTemp();
  writeConfig(dir, JSON.stringify({ maxRounds: 5 }));
  const cfg = load(dir);
  assert.equal(cfg.source, "default");
  assert.equal(cfg.invalid, null);
});

test("precommit section not an object → default + invalid", () => {
  const dir = makeTemp();
  writeConfig(dir, JSON.stringify({ precommit: "nope" }));
  const cfg = load(dir);
  assert.equal(cfg.source, "default");
  assert.match(cfg.invalid ?? "", /not an object/);
});

test("precommit section with no usable steps → default + invalid", () => {
  const dir = makeTemp();
  writeConfig(dir, JSON.stringify({ precommit: { typecheck: 42, lint: {} } }));
  const cfg = load(dir);
  assert.equal(cfg.source, "default");
  assert.match(cfg.invalid ?? "", /no usable steps/);
});

// ---------------------------------------------------------------------------
// step shapes — string / null / {script} / {command} / {skip}
// ---------------------------------------------------------------------------

test("string step → {script}; null → explicit skip", () => {
  const dir = makeTemp();
  writeConfig(dir, JSON.stringify({ precommit: { lint: "lint:fix", build: null } }));
  const { source, steps } = load(dir);
  assert.equal(source, "project");
  assert.deepEqual(steps.lint, { script: "lint:fix" });
  assert.equal(steps.build, null);
});

test("{script} and {command} normalize as-is; command wins when both present", () => {
  const dir = makeTemp();
  writeConfig(dir, JSON.stringify({
    precommit: {
      typecheck: { command: "tsc --noEmit" },
      build: { script: "build" },
      lint: { command: "mwts fix", script: "lint:fix" },
    },
  }));
  const { source, steps } = load(dir);
  assert.equal(source, "project");
  assert.deepEqual(steps.typecheck, { command: "tsc --noEmit" });
  assert.deepEqual(steps.build, { script: "build" });
  assert.deepEqual(steps.lint, { command: "mwts fix" });
});

test("{skip:true} wins over any command", () => {
  const dir = makeTemp();
  writeConfig(dir, JSON.stringify({ precommit: { build: { skip: true, command: "x" } } }));
  const { steps } = load(dir);
  assert.deepEqual(steps.build, { skip: true });
});

test("narrow is carried only on the fast test lane shape", () => {
  const dir = makeTemp();
  writeConfig(dir, JSON.stringify({
    precommit: {
      test: {
        fast: { script: "test:unit", narrow: false },
        full: { command: "yarn test" },
      },
    },
  }));
  const { source, steps } = load(dir);
  assert.equal(source, "project");
  assert.deepEqual(steps.test, {
    fast: { script: "test:unit", narrow: false },
    full: { command: "yarn test" },
  });
});

test("test as a single step applies to both lanes; per-lane null keeps default for the other", () => {
  const dir = makeTemp();
  writeConfig(dir, JSON.stringify({ precommit: { test: { fast: null } } }));
  const { steps } = load(dir);
  assert.deepEqual(steps.test, { fast: null });

  const dir2 = makeTemp();
  writeConfig(dir2, JSON.stringify({ precommit: { test: { command: "yarn test" } } }));
  const { steps: steps2 } = load(dir2);
  assert.deepEqual(steps2.test, { command: "yarn test" });
});

test("invalid step shapes are ignored per step (independent fallback)", () => {
  const dir = makeTemp();
  writeConfig(dir, JSON.stringify({
    precommit: {
      lint: 42,                      // invalid → ignored
      typecheck: "typecheck",        // valid → kept
      build: [],                     // invalid → ignored
    },
  }));
  const { source, steps } = load(dir);
  assert.equal(source, "project");
  assert.deepEqual(steps, { typecheck: { script: "typecheck" } });
});
