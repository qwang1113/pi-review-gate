import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { git as hermeticGit, hermeticGitEnv } from "./helpers/git.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(ROOT, "scripts", "precommit-runner.mjs");

const tempDirs: string[] = [];
/** Scratch files written OUTSIDE a fixture (a receipt inside it perturbs the tree). */
const tempFiles: string[] = [];
function makeDir(pkg?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-pc-"));
  tempDirs.push(dir);
  if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  return dir;
}
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  for (const f of tempFiles) rmSync(f, { force: true });
});

function run(dir: string, extra: string[] = []) {
  const res = spawnSync("node", [RUNNER, "--cwd", dir, ...extra], { encoding: "utf8" });
  return { code: res.status, out: res.stdout + res.stderr };
}

// ---------------------------------------------------------------------------
// PR #7 lesson 3 — three verdicts, all-skip is NOT pass
// ---------------------------------------------------------------------------

test("zero runnable scripts → ⚠️ NO CHECKS RUN sentinel, DISTINCT exit 2, NOT ✅ PASS", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: {} });
  const { code, out } = run(dir);
  // exit 2 is a distinct code (not 0=PASS, not 1=FAIL) so the extension can
  // tell NO_CHECKS_RUN apart from success without parsing stdout.
  assert.equal(code, 2);
  assert.match(out, /## Overall: ⚠️ NO CHECKS RUN/);
  assert.doesNotMatch(out, /## Overall: ✅ PASS/);
});

test("empty dir (no package.json, no ecosystem) → NO CHECKS RUN", () => {
  const dir = makeDir();
  const { out } = run(dir);
  assert.match(out, /## Overall: ⚠️ NO CHECKS RUN/);
});

test("passing test script → ✅ PASS", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "exit 0" } });
  const { code, out } = run(dir);
  assert.equal(code, 0);
  assert.match(out, /## Overall: ✅ PASS/);
});

test("failing test script → ❌ FAIL, exit 1", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "exit 1" } });
  const { code, out } = run(dir);
  assert.equal(code, 1);
  assert.match(out, /## Overall: ❌ FAIL/);
});

test("lint pass + test fail → FAIL (any failure wins)", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { lint: "exit 0", test: "exit 1" } });
  // `--mode full`: with another check present, the fast lane would narrow the
  // test step away (this script has no derivable related set).
  const { code, out } = run(dir, ["--mode", "full"]);
  assert.equal(code, 1);
  assert.match(out, /## Overall: ❌ FAIL/);
});

test("missing lint recorded as explicit skip, does not fail the run", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "exit 0" } });
  const { out } = run(dir, ["--json"]);
  const parsed = JSON.parse(out);
  const lint = parsed.steps.find((s: { name: string }) => s.name === "lint");
  assert.equal(lint.status, "skip");
  assert.equal(parsed.verdict, "PASS");
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.checksRun, 1);
  assert.equal(parsed.checksFailed, 0);
});

// ---------------------------------------------------------------------------
// PR #7 lesson 1 — glob trap warning
// ---------------------------------------------------------------------------

test("node --test with ** glob → loud glob-trap warning on stderr", () => {
  const dir = makeDir({
    name: "t",
    version: "1.0.0",
    scripts: { test: "node --test test/**/*.test.js || true" },
  });
  const { out } = run(dir);
  assert.match(out, /\[glob-trap\]/);
  assert.match(out, /does NOT recurse/i);
});

test("node --test with $(find ...) → no glob-trap warning", () => {
  const dir = makeDir({
    name: "t",
    version: "1.0.0",
    scripts: { test: `sh -c 'exit 0' || node --test $(find test -name "*.test.js")` },
  });
  const { out } = run(dir);
  assert.doesNotMatch(out, /\[glob-trap\]/);
});

// ---------------------------------------------------------------------------
// Meta-regression: OUR OWN package.json must not fall into the glob trap.
// Reproduces npm's /bin/sh expansion exactly (mirrors PR #7's
// package-test-coverage test).
// ---------------------------------------------------------------------------

test("own package.json test script expands to every test file under /bin/sh", () => {
  const pkg = JSON.parse(
    execFileSync("cat", [join(ROOT, "package.json")], { encoding: "utf8" }),
  );
  const script: string = pkg.scripts.test;
  assert.ok(script.startsWith("node --test "), `unexpected script shape: ${script}`);
  const args = script.slice("node --test ".length);
  const expanded = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${args}`], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .sort();

  const onDisk = execFileSync(
    "find",
    ["test", "-name", "*.test.ts", "-o", "-name", "*.test.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort();

  assert.deepEqual(expanded, onDisk, "npm test must cover every test file on disk");
  assert.ok(onDisk.length >= 5, "sanity: this suite itself should be found");
});

// ---------------------------------------------------------------------------
// Trusted-receipt channel — the extension spawns the runner with a private
// nonce + receipt path and trusts ONLY the nonce-stamped receipt.
// ---------------------------------------------------------------------------

import { readFileSync as readFile } from "node:fs";

function runReceipt(dir: string, extra: string[] = []) {
  const receipt = join(dir, "receipt.json");
  const res = spawnSync("node", [RUNNER, "--cwd", dir, "--receipt", receipt, "--nonce", "NONCE123", ...extra], { encoding: "utf8" });
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(readFile(receipt, "utf8")); } catch { /* none */ }
  return { code: res.status, receipt: parsed, out: res.stdout + res.stderr };
}

test("receipt: passing checks → schema/verdict/counts/nonce/cwd, exit 0", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "exit 0" } });
  const { code, receipt } = runReceipt(dir);
  assert.equal(code, 0);
  assert.ok(receipt);
  assert.equal(receipt!.schema, 1);
  assert.equal(receipt!.verdict, "PASS");
  assert.equal(receipt!.checksRun, 1);
  assert.equal(receipt!.checksFailed, 0);
  assert.equal(receipt!.nonce, "NONCE123");
  assert.equal(receipt!.cwd, dir);
});

test("receipt: failing checks → verdict FAIL, exit 1, counts reflect failure", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "exit 1" } });
  const { code, receipt } = runReceipt(dir);
  assert.equal(code, 1);
  assert.equal(receipt!.verdict, "FAIL");
  assert.equal(receipt!.checksFailed, 1);
});

test("receipt: no checks → verdict NO_CHECKS_RUN, distinct exit 2", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: {} });
  const { code, receipt } = runReceipt(dir);
  assert.equal(code, 2);
  assert.equal(receipt!.verdict, "NO_CHECKS_RUN");
  assert.equal(receipt!.checksRun, 0);
});

// ---------------------------------------------------------------------------
// Streaming diagnostics — the run log has to be useful, including mid-run.
// ---------------------------------------------------------------------------

test("receipt mode streams each step's FULL output, not just the 40-line receipt tail", () => {
  // The extension captures this stdout to <repo>/.pi/precommit-last.log and
  // tells the agent to read it. If only the final summary were printed, a FAIL
  // would still be undiagnosable — the bug this replaced.
  const marker = "UNIQUE_FAILURE_MARKER_9271";
  // 60 lines: more than the receipt's 40-line tail, so a test asserting on the
  // FIRST line proves the log is not merely the tail reprinted.
  const script = `for i in $(seq 1 60); do echo "${marker} line $i"; done; exit 1`;
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: script } });
  const { code, out, receipt } = runReceipt(dir);

  assert.equal(code, 1);
  assert.equal(receipt!.verdict, "FAIL");
  assert.match(out, new RegExp(`${marker} line 1$`, "m"), "the first line must reach the log");
  assert.match(out, new RegExp(`${marker} line 60$`, "m"), "the last line must reach the log");
  // Step boundaries let a reader (and a killed-mid-run log) locate the step.
  assert.match(out, /▶ test — /, "each step must be announced BEFORE it runs");
  assert.match(out, /◀ test — fail \(\d+ms, exit 1\)/, "each step must report its own result");
});

test("steps appear in DECLARATION order in the log — parallel execution, merged presentation", () => {
  // Ordering is the whole point: on a 20-minute timeout the log ends at the
  // first unfinished check's `▶` with no matching `◀`, which identifies the
  // hung step. Checks now run in parallel, but the log still reads in
  // declaration order (lint before test), never in completion order.
  // `--mode full` so the test step is the complete suite: the fast lane would
  // narrow it to the changed files, which is a different question.
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { lint: "echo linting", test: "exit 0" } });
  const { out } = runReceipt(dir, ["--mode", "full"]);
  const lintStart = out.indexOf("▶ lint");
  const lintEnd = out.indexOf("◀ lint");
  const testStart = out.indexOf("▶ test");
  assert.ok(lintStart >= 0 && lintEnd > lintStart, "lint must be announced, then completed");
  assert.ok(testStart > lintEnd, "steps must appear in declaration order");
});

// ---------------------------------------------------------------------------
// Parallel scheduling (default-on): independent checks overlap, lint:fix runs
// first and alone, output and receipt stay in declaration order.
// ---------------------------------------------------------------------------

test("independent checks run in PARALLEL — wall time is less than the serial sum", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { lint: "sleep 0.3", test: "sleep 0.3" } });
  const started = Date.now();
  const { code } = run(dir, ["--mode", "full"]);
  const elapsed = Date.now() - started;
  assert.equal(code, 0);
  // Serial would take ~0.6s; parallel ~0.3s. Generous bound against loaded CI.
  assert.ok(elapsed < 800, `expected parallel overlap, took ${elapsed}ms`);
});

test("a SLOW earlier-declared step does not reorder the log or the receipt steps", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { lint: "echo LINT_BODY; sleep 0.4", test: "echo TEST_BODY" } });
  const { out, receipt } = runReceipt(dir, ["--mode", "full", "--json"]);
  // test finishes long before lint, yet the log and the steps array must
  // present lint first — completion order must never leak into either.
  assert.ok(out.indexOf("LINT_BODY") < out.indexOf("TEST_BODY"), "log follows declaration order");
  const names = (receipt!.steps as Array<{ name: string }>).map((s) => s.name);
  assert.deepEqual(names, ["lint", "typecheck", "build", "test"], "receipt steps follow declaration order");
});

test("lint:fix runs FIRST and alone — parallel checks start only after it finished", () => {
  // lint:fix edits files; every other check must see the fixed worktree.
  // The test script fails if the marker does not exist yet, which would
  // happen if it were allowed to start before lint:fix completed.
  const dir = makeDir({
    name: "t",
    version: "1.0.0",
    scripts: {
      "lint:fix": "echo FIXED > fix-marker.txt",
      test: "test -f fix-marker.txt",
    },
  });
  const { code, receipt } = runReceipt(dir, ["--mode", "full"]);
  assert.equal(code, 0);
  assert.equal(receipt!.verdict, "PASS");
  const names = (receipt!.steps as Array<{ name: string }>).map((s) => s.name);
  assert.deepEqual(names, ["lint", "typecheck", "build", "test"], "lint (the fix step) is declared first");
});

test("a failure in any parallel check still fails the run (any-failure-wins)", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { lint: "exit 0", test: "exit 1" } });
  const { code, out, receipt } = runReceipt(dir, ["--mode", "full"]);
  assert.equal(code, 1);
  assert.equal(receipt!.verdict, "FAIL");
  assert.equal(receipt!.checksRun, 2);
  assert.equal(receipt!.checksFailed, 1);
  assert.match(out, /## Overall: ❌ FAIL/);
});

test("skipped steps are named in the log too (a skip is not a silent pass)", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "exit 0" } });
  const { out } = runReceipt(dir);
  assert.match(out, /⏭ lint — skipped \(no script/);
});

test("human mode (no --receipt) keeps the original compact output — no streaming noise", () => {
  // Streaming is for the machine-captured log. A human running this by hand
  // must not suddenly get the full output of every check dumped at them.
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "echo hello; exit 0" } });
  const { out } = run(dir);
  assert.match(out, /## Overall: ✅ PASS/);
  assert.doesNotMatch(out, /▶ test/);
  assert.doesNotMatch(out, /◀ test/);
  assert.doesNotMatch(out, /⏭ lint/);
});

// ---------------------------------------------------------------------------
// Project-level step configuration (`.pi/review-gate.json` → `precommit`)
// ---------------------------------------------------------------------------

import { mkdirSync } from "node:fs";

function writeReviewGateConfig(dir: string, content: string): void {
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate.json"), content);
}

test("config: configured command replaces the detected step and marks the receipt", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "exit 1" } });
  writeReviewGateConfig(dir, JSON.stringify({
    precommit: { typecheck: { command: "exit 0" } },
  }));
  const { code, receipt, out } = runReceipt(dir);
  assert.equal(code, 0);
  assert.equal(receipt!.verdict, "PASS");
  // config.source travels with the receipt so the extension can name it.
  assert.deepEqual(receipt!.config, { source: "project", path: join(dir, ".pi", "review-gate.json") });
  const typecheck = (receipt!.steps as Array<Record<string, unknown>>).find((s) => s.name === "typecheck");
  assert.equal(typecheck!.status, "pass");
  assert.equal(typecheck!.source, "config");
  // The unconfigured test step still used default detection (and failed).
  const test = (receipt!.steps as Array<Record<string, unknown>>).find((s) => s.name === "test");
  assert.equal(test!.source, "detected");
  assert.match(out, /config: project/);
});

test("config: null / {skip:true} steps are explicitly skipped with a reason", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "exit 0" } });
  writeReviewGateConfig(dir, JSON.stringify({
    precommit: { lint: null, typecheck: { skip: true, command: "exit 1" } },
  }));
  const { code, receipt, out } = runReceipt(dir);
  assert.equal(code, 0);
  assert.match(out, /⏭ lint — skipped \(configured skip\)/);
  assert.match(out, /⏭ typecheck — skipped \(configured skip\)/);
  const names = (receipt!.steps as Array<{ name: string }>).map((s) => s.name);
  assert.deepEqual(names, ["lint", "typecheck", "build", "test"], "all four steps are declared, skipped ones included");
});

test("config: a configured script missing from package.json skips the step (never a silent fallback)", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: {} });
  writeReviewGateConfig(dir, JSON.stringify({
    precommit: { typecheck: { script: "nope" } },
  }));
  const { code, out } = runReceipt(dir);
  assert.equal(code, 2); // nothing runnable left
  assert.match(out, /⏭ typecheck — skipped \(configured script "nope" not found in package.json\)/);
  assert.match(out, /## Overall: ⚠️ NO CHECKS RUN/);
});

test("config: fast test with narrow:false runs the complete command → testScope full", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "exit 0" } });
  writeReviewGateConfig(dir, JSON.stringify({
    precommit: { test: { fast: { script: "test", narrow: false } } },
  }));
  const { code, receipt, out } = runReceipt(dir);
  assert.equal(code, 0);
  assert.equal(receipt!.testScope, "full");
  assert.match(out, /narrow disabled/);
  // Narrowing the fast lane is why it exists — disabling it must be visible.
  const test = (receipt!.steps as Array<Record<string, unknown>>).find((s) => s.name === "test");
  assert.equal(test!.status, "pass");
  assert.equal(test!.source, "config");
});

test("config: fast test command that cannot be narrowed runs in full → testScope full (never dropped)", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "sh -c 'exit 0'" } });
  writeReviewGateConfig(dir, JSON.stringify({
    precommit: { test: { fast: { script: "test" } } },
  }));
  const { code, receipt, out } = runReceipt(dir);
  assert.equal(code, 0);
  assert.equal(receipt!.testScope, "full");
  assert.match(out, /narrow not applicable/);
});

test("config: corrupt JSON falls back to the default detection with a loud warning", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: {} });
  writeReviewGateConfig(dir, "{broken");
  const { code, receipt, out } = runReceipt(dir);
  assert.equal(code, 2); // same as with no config at all
  assert.equal(receipt!.verdict, "NO_CHECKS_RUN");
  assert.deepEqual(receipt!.config, { source: "default", path: join(dir, ".pi", "review-gate.json") });
  assert.match(out, /\[precommit-config\]/);
});

test("config: full lane uses its own configured test command; fast lane falls back to detection", () => {
  const dir = makeDir({
    name: "t", version: "1.0.0",
    scripts: { test: "exit 1", "test:unit": "exit 0", lint: "exit 0" },
  });
  writeReviewGateConfig(dir, JSON.stringify({
    precommit: { test: { full: { script: "test" } } },
  }));
  // fast: full lane unconfigured → default detection picks test:unit, which is
  // a bare single command with no derivable related set → dropped as skipped
  // (lint is the other runnable check, so the drop does not trigger the
  // only-check full-suite fallback).
  const fast = runReceipt(dir);
  assert.equal(fast.code, 0);
  assert.equal(fast.receipt!.testScope, "skipped");
  // REGRESSION (P0b): a skipped test step must be LOUD in the human report —
  // a PASS next to a zero-test run is the silent-failure trap this batch
  // exists to kill.
  assert.match(fast.out, /WARNING: no tests were run in this lane/,
    "a fast PASS with testScope skipped must print the no-tests warning");
  assert.match(fast.out, /\[pi-review-gate\]|\u26a0\ufe0f/,
    "the warning must be visually prominent");
  // full: configured to use the failing `test` script → FAIL.
  const full = runReceipt(dir, ["--mode", "full"]);
  assert.equal(full.code, 1);
  assert.equal(full.receipt!.verdict, "FAIL");
  assert.equal(full.receipt!.testScope, "full");
});

test("config: top-level \"test\": null skips BOTH lanes without crashing", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "exit 1" } });
  writeReviewGateConfig(dir, JSON.stringify({
    precommit: { typecheck: { command: "exit 0" }, test: null },
  }));
  // Regression: reading `cfg.fast` on a top-level null crashed the runner.
  const fast = runReceipt(dir);
  assert.equal(fast.code, 0);
  assert.equal(fast.receipt!.verdict, "PASS");
  assert.equal(fast.receipt!.testScope, "skipped");
  const test = (fast.receipt!.steps as Array<Record<string, unknown>>).find((s) => s.name === "test");
  assert.equal(test!.status, "skip");
  assert.match(test!.reason as string, /configured skip/);
  // full lane must not violate "mode full ⇒ testScope full".
  const full = runReceipt(dir, ["--mode", "full"]);
  assert.equal(full.code, 0);
  assert.equal(full.receipt!.verdict, "PASS");
  assert.equal(full.receipt!.testScope, "full");
});

test("config: full lane + skipped test reports testScope full (protocol invariant)", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "exit 1" } });
  writeReviewGateConfig(dir, JSON.stringify({
    precommit: { typecheck: { command: "exit 0" }, test: { skip: true } },
  }));
  const { code, receipt } = runReceipt(dir, ["--mode", "full"]);
  assert.equal(code, 0);
  // Receipt must be accepted by validatePrecommitReceipt: mode full ⇒ full.
  assert.equal(receipt!.mode, "full");
  assert.equal(receipt!.testScope, "full");
});

test("config: full lane + configured script missing reports testScope full, not a protocol ERROR", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: {} });
  writeReviewGateConfig(dir, JSON.stringify({
    precommit: { typecheck: { command: "exit 0" }, test: { script: "nope" } },
  }));
  const { code, receipt } = runReceipt(dir, ["--mode", "full"]);
  assert.equal(code, 0);
  assert.equal(receipt!.verdict, "PASS");
  assert.equal(receipt!.testScope, "full");
});

test("config: no package.json + partial config still runs the ecosystem fallback test", () => {
  // Cargo project with a configured lint command: the unconfigured test step
  // must fall back to the ecosystem detection, never be silently dropped.
  const dir = makeDir();
  writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"t\"\nversion = \"0.1.0\"\n");
  writeReviewGateConfig(dir, JSON.stringify({
    precommit: { lint: { command: "exit 0" } },
  }));
  const { receipt, out } = runReceipt(dir);
  const names = (receipt!.steps as Array<{ name: string }>).map((s) => s.name);
  assert.ok(names.includes("cargo-test"), `ecosystem fallback missing from steps: ${names.join(",")}`);
  assert.equal(receipt!.testScope, "full");
  assert.match(out, /cargo test --quiet/);
});

test("config: no package.json + configured test command replaces the ecosystem fallback", () => {
  const dir = makeDir();
  writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"t\"\nversion = \"0.1.0\"\n");
  writeReviewGateConfig(dir, JSON.stringify({
    precommit: { test: { fast: { command: "exit 0" } } },
  }));
  const { code, receipt } = runReceipt(dir);
  assert.equal(code, 0);
  assert.equal(receipt!.verdict, "PASS");
  const names = (receipt!.steps as Array<{ name: string }>).map((s) => s.name);
  assert.ok(!names.includes("cargo-test"), `ecosystem fallback should be replaced: ${names.join(",")}`);
  assert.equal(receipt!.testScope, "full");
});

test("config: fast test narrowing SUCCEEDS → testScope related (entry.body wiring)", () => {
  // Regression (P1-A): configured narrow attempts were dropped because the
  // entry lacked `body`; narrowTestStep re-parses entry.body and saw null.
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "vitest run", lint: "exit 0" } });
  const binDir = join(dir, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "vitest"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // A git repo with a changed source file, so the related set is derivable.
  hermeticGit(dir, ["init", "-q"], { quiet: true });
  hermeticGit(dir, ["config", "user.email", "t@t"], { quiet: true });
  hermeticGit(dir, ["config", "user.name", "t"], { quiet: true });
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  hermeticGit(dir, ["add", "-A"], { quiet: true });
  hermeticGit(dir, ["commit", "-qm", "init"], { quiet: true });
  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
  writeReviewGateConfig(dir, JSON.stringify({
    precommit: { test: { fast: { script: "test" } } },
  }));
  const { code, receipt, out } = runReceipt(dir);
  assert.equal(code, 0);
  assert.equal(receipt!.verdict, "PASS");
  assert.equal(receipt!.testScope, "related");
  const test = (receipt!.steps as Array<Record<string, unknown>>).find((s) => s.name === "test");
  assert.equal(test!.status, "pass");
  assert.equal(test!.source, "config");
  assert.match(out, /vitest related/);
});

test("config: lane-only narrow:false keeps the detected test and runs it in full", () => {
  // Regression (P1-B): { narrow: false } without command/script silently
  // dropped the whole suite (fail-open) instead of configuring the lane.
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "exit 0", lint: "exit 0" } });
  writeReviewGateConfig(dir, JSON.stringify({
    precommit: { test: { fast: { narrow: false } } },
  }));
  const { code, receipt } = runReceipt(dir);
  assert.equal(code, 0);
  assert.equal(receipt!.verdict, "PASS");
  assert.equal(receipt!.testScope, "full");
  const test = (receipt!.steps as Array<Record<string, unknown>>).find((s) => s.name === "test");
  assert.equal(test!.status, "pass");
  assert.equal(test!.source, "detected");
  // The failing-suite case must FAIL, never pass (fail-open guard).
  const bad = makeDir({ name: "t", version: "1.0.0", scripts: { test: "exit 1", lint: "exit 0" } });
  writeReviewGateConfig(bad, JSON.stringify({
    precommit: { test: { fast: { narrow: false } } },
  }));
  const badRun = runReceipt(bad);
  assert.equal(badRun.code, 1);
  assert.equal(badRun.receipt!.verdict, "FAIL");
  // full lane too: the same config must run the detected suite.
  const full = runReceipt(bad, ["--mode", "full"]);
  assert.equal(full.code, 1);
  assert.equal(full.receipt!.verdict, "FAIL");
});

// ---------------------------------------------------------------------------
// jest `.pi` ignore injection — END TO END, with a real spawned jest stand-in
// ---------------------------------------------------------------------------

/**
 * Write a fake `node_modules/.bin/jest` that answers `--showConfig` with a
 * real-shaped config and passes any other invocation.
 *
 * This is what pins the injection to a SPAWNABLE binary: the resolver used for
 * shell command strings returns a shell-QUOTED path, and passing that to
 * `spawnSync` (argv, no shell) fails with ENOENT — which `spawnSync` reports
 * in `result.error` instead of throwing, so the feature would degrade to
 * silently never injecting. A unit test on the pure helpers cannot see that;
 * only actually spawning the binary can.
 */
function writeFakeJest(dir: string, patterns: string[]): void {
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const jest = join(bin, "jest");
  const config = JSON.stringify({ configs: [{ testPathIgnorePatterns: patterns }] });
  writeFileSync(jest, `#!/bin/sh\nif [ "$1" = "--showConfig" ]; then\n  echo '${config}'\n  exit 0\nfi\nexit 0\n`);
  chmodSync(jest, 0o755);
}

test("jest ignore injection actually spawns jest and merges its own patterns", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "jest" } });
  writeFakeJest(dir, ["/node_modules/", "<rootDir>/e2e/"]);

  const { out } = run(dir, ["--mode", "full"]);

  // The plan preamble prints the command that will run: injection visible there
  // proves `jest --showConfig` was really spawned and parsed.
  assert.match(out, /--testPathIgnorePatterns '<rootDir>\/\.pi\/'/, "the .pi exclusion must reach the command");
  assert.match(out, /--testPathIgnorePatterns '\/node_modules\/'/, "the repo's own patterns must be preserved");
  assert.match(out, /--testPathIgnorePatterns '<rootDir>\/e2e\/'/, "the repo's own patterns must be preserved");
  assert.match(out, /npm run test -- --testPathIgnorePatterns/, "npm needs -- to forward the args");
  assert.doesNotMatch(out, /injection skipped/, "a spawnable jest must not fall into the skip branch");
});

test("a non-jest test script never triggers a jest --showConfig probe", () => {
  // Spawning jest for a vitest/node --test project costs a process for a result
  // that can never be used, and its skip note would describe a jest problem the
  // project does not have.
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "vitest run" } });
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "vitest"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // A jest that RECORDS every invocation: it must never be called.
  const probeLog = join(dir, "jest-probe.log");
  writeFileSync(join(bin, "jest"), `#!/bin/sh\necho called >> ${probeLog}\nexit 0\n`, { mode: 0o755 });

  const { out } = run(dir, ["--mode", "full"]);

  assert.ok(!existsSync(probeLog), "jest must not be spawned for a non-jest test script");
  assert.doesNotMatch(out, /showConfig/, "no jest-specific note belongs in this project's log");
});

test("a jest whose --showConfig fails injects NOTHING (never a CLI override)", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "jest" } });
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "jest"), "#!/bin/sh\nexit 3\n");
  chmodSync(join(bin, "jest"), 0o755);

  const { out } = run(dir, ["--mode", "full"]);

  // Injecting only `.pi` here would REPLACE the repo's own patterns (jest CLI
  // overrides config), silently running suites the project excludes.
  assert.doesNotMatch(out, /--testPathIgnorePatterns/, "no patterns known ⇒ no CLI override at all");
  assert.match(out, /injection skipped: jest --showConfig failed/, "the reason must be recorded in the log");
});

test("a compound test script is never rewritten, even with a working jest", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "jest && echo done" } });
  writeFakeJest(dir, ["/node_modules/"]);

  const { out } = run(dir, ["--mode", "full"]);

  assert.doesNotMatch(out, /--testPathIgnorePatterns/, "a compound script must be left byte-for-byte alone");
});

// ---------------------------------------------------------------------------
// Live step output — visible WHILE a step runs, in declaration order, once
// ---------------------------------------------------------------------------

test("a legacy oversized cache tail is bounded on REPLAY, not just on write", () => {
  // The write-side bound only covers caches this version wrote. An entry left
  // by an earlier version still holds an unbounded tail, and replaying it into
  // the receipt reproduces the >1 MiB rejection that turns a PASS into ERROR.
  //
  // The fixture MUST be a real git worktree: the per-step cache is keyed on a
  // git tree digest, so in a non-git directory `computeInputDigests` returns
  // null, nothing is ever cached, and this test would pass while exercising
  // no cache path at all.
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "echo hi" } });
  // Neutralise host git config: a global `commit.gpgsign`, `core.hooksPath`
  // or `init.templateDir` would otherwise make this fixture's commit fail on
  // someone else's machine.
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "gpg.format=openpgp", ...args,
  ], { cwd: dir, stdio: "ignore", env: hermeticGitEnv() });
  git("init", "-q", "--template=");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  // `.pi/` is gate-owned per-machine state (the README tells users to ignore
  // it): leaving it untracked would perturb the tree digest between runs and
  // turn the cache hit this test depends on into a miss.
  writeFileSync(join(dir, ".gitignore"), ".pi/\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  // The receipt must live OUTSIDE the fixture: written inside, it changes the
  // worktree between runs, the per-step digest changes with it, and the cache
  // hit this test exists to exercise never happens.
  const runOutside = (tag: string) => {
    const receipt = join(tmpdir(), `rg-legacy-cache-${tag}-${process.pid}.json`);
    tempFiles.push(receipt);
    const res = spawnSync("node", [RUNNER, "--cwd", dir, "--mode", "full", "--receipt", receipt, "--nonce", "n0nce"], { encoding: "utf8" });
    const parsed = JSON.parse(readFileSync(receipt, "utf8")) as Record<string, unknown>;
    return { code: res.status, receipt: parsed, path: receipt, out: res.stdout + res.stderr };
  };

  // First run populates the cache legitimately...
  const first = runOutside("first");
  assert.equal(first.code, 0, "first run must pass");
  const cachePath = join(dir, ".pi", "precommit-cache.json");
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  const entries = cache.entries ?? {};
  const keys = Object.keys(entries);
  assert.ok(keys.length > 0, "the fixture must actually produce cache entries (git tree digest available)");

  // ...then we forge a pre-bounding entry with a huge single-line tail.
  const huge = "x".repeat(1_100_000);
  let forged = 0;
  for (const key of keys) {
    const bucket = entries[key];
    if (bucket && typeof bucket === "object") { bucket.tail = huge; forged++; }
  }
  assert.ok(forged > 0, "a legacy-shaped entry must actually be forged");
  writeFileSync(cachePath, JSON.stringify(cache));

  const second = runOutside("second");
  assert.equal(second.code, 0, "second run must pass");
  const steps = second.receipt.steps as Array<Record<string, unknown>>;
  assert.ok(steps.some((s) => s.cached === true), "the second run must actually hit the cache");

  const size = statSync(second.path).size;
  assert.ok(size <= 1024 * 1024, `receipt must stay under the extension's 1 MiB limit, got ${size}`);
  for (const step of steps) {
    const tail = typeof step.tail === "string" ? step.tail : "";
    assert.ok(Buffer.byteLength(tail, "utf8") <= 64 * 1024, "a replayed tail must be bounded");
  }
});

test("a command that selects its own jest config is NOT rewritten (reason recorded)", () => {
  // Reproducing an explicit selection means reimplementing jest's CLI parsing,
  // and every divergence would query a DIFFERENT config than the run uses — then
  // override the real config's patterns with what we read. So the contract is
  // narrowed: explicit selection ⇒ no injection, and say why.
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "jest --config custom.json" } });
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  // The stand-in records its ARGV: the test step itself legitimately runs jest,
  // so what must be absent is a `--showConfig` probe, not every invocation.
  const probeLog = join(dir, "jest-probe.log");
  writeFileSync(join(bin, "jest"), `#!/bin/sh\necho "$@" >> ${probeLog}\nexit 0\n`, { mode: 0o755 });

  const { out } = run(dir, ["--mode", "full"]);

  assert.doesNotMatch(out, /--testPathIgnorePatterns/, "an explicitly configured command must be left verbatim");
  const probed = existsSync(probeLog) ? readFileSync(probeLog, "utf8") : "";
  assert.ok(!probed.includes("--showConfig"), "no showConfig probe is worth running when the result cannot be used");
  assert.match(out, /selects its own jest config/, "the reason must tell the user what to do");
});

test("a configured compound test command records WHY injection was skipped", () => {
  // With a working jest present, `jestIgnoreArgsCache` is non-empty — so the
  // preamble must not fall through to claiming the exclusion is in effect for
  // a command that was never rewritten.
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "jest && echo done" } });
  writeFakeJest(dir, ["/node_modules/"]);
  writeReviewGateConfig(dir, JSON.stringify({
    precommit: { test: { script: "test" } },
  }));

  const { out } = run(dir, ["--mode", "full"]);

  assert.doesNotMatch(out, /jest runs exclude/, "must not claim an exclusion this run does not have");
  assert.match(out, /not a single jest command/, "the real skip reason must be recorded");
});

test("a project-CONFIGURED non-test step is never rewritten either", () => {
  // The configured path is a second entry point: `.pi/review-gate.json` can
  // point lint/typecheck/build at a script that is a plain `jest` command.
  // Only the test step may be rewritten, whichever path collected it.
  const dir = makeDir({
    name: "t", version: "1.0.0",
    scripts: { lint: "jest", test: "jest" },
  });
  writeFakeJest(dir, ["/node_modules/"]);
  writeReviewGateConfig(dir, JSON.stringify({
    precommit: { lint: { script: "lint" } },
  }));

  const { out } = run(dir, ["--mode", "full"]);

  const planLine = (step: string) => out.split("\n").find((l) => l.includes(`· ${step}:`)) ?? "";
  assert.doesNotMatch(planLine("lint"), /--testPathIgnorePatterns/, "a configured lint step must keep its command verbatim");
  assert.match(planLine("test"), /--testPathIgnorePatterns/, "the test step is still injected");
});

test("jest ignore injection touches the TEST step only, never lint/typecheck/build", () => {
  // The exclusion exists so a TEST run skips the disposable copies under
  // .pi/review-snapshots/. A lint/typecheck/build script that happens to be a
  // plain `jest` invocation is a different job; rewriting it would also change
  // its cache command key (and, for lint:fix, the command the fix stage keys on).
  const dir = makeDir({
    name: "t", version: "1.0.0",
    scripts: { lint: "jest", typecheck: "jest", test: "jest" },
  });
  writeFakeJest(dir, ["/node_modules/"]);

  const { out } = run(dir, ["--mode", "full"]);

  const planLine = (step: string) => out.split("\n").find((l) => l.includes(`· ${step}:`)) ?? "";
  assert.match(planLine("test"), /--testPathIgnorePatterns/, "the test step must be injected");
  assert.doesNotMatch(planLine("lint"), /--testPathIgnorePatterns/, "lint must be left alone");
  assert.doesNotMatch(planLine("typecheck"), /--testPathIgnorePatterns/, "typecheck must be left alone");
});

test("a multibyte character split across child stdout chunks is not corrupted", async () => {
  // The runner used to do `full += buffer`, decoding every chunk on its own:
  // a character split across two writes became U+FFFD in the log BEFORE the
  // extension's tail ever saw it, so no downstream decoding could repair it.
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "node split.js" } });
  // Write the 3 bytes of ▶ in two separate stdout writes, with a gap so they
  // land in different chunks.
  writeFileSync(join(dir, "split.js"), [
    "const b = Buffer.from('▶ marker\\n', 'utf8');",
    "process.stdout.write(b.subarray(0, 2));",
    "setTimeout(() => process.stdout.write(b.subarray(2)), 150);",
  ].join("\n"));

  const log = join(dir, "live.log");
  const fd = openSync(log, "a");
  const child = spawn("node", [RUNNER, "--cwd", dir, "--mode", "full", "--receipt", join(dir, "r.json"), "--nonce", "n0nce"], {
    stdio: ["ignore", fd, fd],
  });
  try {
    await new Promise((r) => child.on("close", r));
    const text = readFileSync(log, "utf8");
    assert.ok(!text.includes("\uFFFD"), "a split character must never reach the log as U+FFFD");
    assert.match(text, /▶ marker/, "the character must be reassembled intact");
  } finally {
    closeSync(fd);
    if (child.exitCode === null) child.kill();
  }
});
test("--json stdout stays pure JSON even in receipt mode", () => {
  // `--json` output is PARSED by its caller, so no diagnostic may precede the
  // object — not the step blocks, not the plan preamble, not live output.
  // Passing --json together with --receipt used to emit all three.
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { test: "echo hi" } });
  const receipt = join(dir, "receipt.json");
  const res = spawnSync("node", [RUNNER, "--cwd", dir, "--mode", "full", "--json", "--receipt", receipt, "--nonce", "n0nce"], { encoding: "utf8" });

  const parsed = JSON.parse(res.stdout); // throws if anything preceded the object
  assert.equal(parsed.verdict, "PASS");
  assert.doesNotMatch(res.stdout, /▶ test/, "no step block may precede the JSON");
  assert.doesNotMatch(res.stdout, /# Precommit plan/, "no plan preamble may precede the JSON");
});


test("a running step's output is written to the log before the step finishes", async () => {
  // The whole point of criterion 5: the extension tails this log, so output
  // buffered until close leaves a long check looking hung. This drives a step
  // that prints, waits, then prints again, and reads the log MID-RUN.
  const dir = makeDir({
    name: "t", version: "1.0.0",
    // Markers live in FILES, never in the command text: `npm run` echoes the
    // script body, which would make each marker appear twice for reasons that
    // have nothing to do with streaming.
    scripts: { test: "cat early.txt; sleep 1; cat late.txt" },
  });
  writeFileSync(join(dir, "early.txt"), "EARLY-MARKER\n");
  writeFileSync(join(dir, "late.txt"), "LATE-MARKER\n");
  const log = join(dir, "live.log");
  const out = openSync(log, "a");
  const receipt = join(dir, "receipt.json");
  // Receipt mode is what the extension uses (streaming=true); stdio goes to a
  // file descriptor exactly like runTrustedPrecommit does.
  const child = spawn("node", [RUNNER, "--cwd", dir, "--mode", "full", "--receipt", receipt, "--nonce", "n0nce"], {
    stdio: ["ignore", out, out],
  });
  try {
    // Poll for the early marker while the child is provably still running.
    let sawEarlyWhileRunning = false;
    for (let i = 0; i < 30 && child.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (readFileSync(log, "utf8").includes("EARLY-MARKER")) {
        sawEarlyWhileRunning = child.exitCode === null;
        break;
      }
    }
    assert.ok(sawEarlyWhileRunning, "early output must reach the log while the step is still running");

    await new Promise((r) => child.on("close", r));
    const text = readFileSync(log, "utf8");
    assert.match(text, /LATE-MARKER/, "the rest of the output must land too");
    // Streamed once, then closed — never printed a second time at close.
    assert.equal(text.match(/EARLY-MARKER/g)?.length, 1, "live output must not be duplicated at close");
    assert.equal(text.match(/LATE-MARKER/g)?.length, 1, "live output must not be duplicated at close");
    assert.match(text, /▶ test —/, "the ordered block header is still written");
    assert.match(text, /◀ test — pass/, "the ordered block is still closed");
  } finally {
    closeSync(out);
    if (child.exitCode === null) child.kill();
  }
});
