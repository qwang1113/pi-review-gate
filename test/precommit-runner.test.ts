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
  const { code, out } = run(dir);
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
  return { code: res.status, receipt: parsed };
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
