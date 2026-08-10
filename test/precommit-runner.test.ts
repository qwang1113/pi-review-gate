import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(ROOT, "scripts", "precommit-runner.mjs");

const tempDirs: string[] = [];
function makeDir(pkg?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-pc-"));
  tempDirs.push(dir);
  if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  return dir;
}
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
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
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { lint: "sleep 1", test: "sleep 1" } });
  const started = Date.now();
  const { code } = run(dir, ["--mode", "full"]);
  const elapsed = Date.now() - started;
  assert.equal(code, 0);
  // Serial would take ~2s; parallel ~1s. Generous bound against loaded CI.
  assert.ok(elapsed < 1800, `expected parallel overlap, took ${elapsed}ms`);
});

test("a SLOW earlier-declared step does not reorder the log or the receipt steps", () => {
  const dir = makeDir({ name: "t", version: "1.0.0", scripts: { lint: "echo LINT_BODY; sleep 1.5", test: "echo TEST_BODY" } });
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
