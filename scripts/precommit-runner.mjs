#!/usr/bin/env node
/**
 * pi-review-gate precommit runner — deterministic quality gate.
 *
 * Verdicts (PR #7 lesson 3 — three states, never two):
 *   ## Overall: ✅ PASS           — at least one check ran, all ran checks passed
 *   ## Overall: ❌ FAIL           — at least one check failed
 *   ## Overall: ⚠️ NO CHECKS RUN  — zero runnable checks. This is NOT a pass:
 *                                    it matches neither the PASS grep nor the
 *                                    FAIL grep, so the gate stays unrecorded
 *                                    (fail-closed) and a human must configure
 *                                    real checks or explicitly bypass.
 *
 * Usage: node precommit-runner.mjs [--mode fast|full] [--cwd <dir>] [--json]
 *
 * Detection: package.json scripts (lint:fix/lint, typecheck, build, test:unit/test),
 * then ecosystem fallbacks (cargo, go, pytest/ruff) when package.json is absent.
 *
 * PR #7 lesson 1 (npm test glob trap): when the test script contains an
 * unexpanded `**` glob passed to node --test we WARN loudly, because /bin/sh
 * does not recurse `**` and tests may be silently skipped.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
function argOf(flag, dflt) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
}
const mode = argOf("--mode", "fast");
const cwd = argOf("--cwd", process.cwd());
const asJson = args.includes("--json");
// Receipt mode: when the extension spawns this runner directly it passes a
// private receipt path + nonce (never exposed to the model). The runner writes
// a structured, nonce-stamped result there via temp+atomic-rename, so the
// extension trusts ONLY a receipt the runner actually produced. See
// lib/precommit-receipt.ts / extensions/review-gate.ts run_precommit tool.
const receiptPath = argOf("--receipt", null);
const nonce = argOf("--nonce", null);

const steps = [];

function runStep(name, command) {
  const started = Date.now();
  const res = spawnSync("bash", ["-lc", command], {
    cwd,
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const passed = res.status === 0;
  steps.push({
    name,
    command,
    status: passed ? "pass" : "fail",
    durationMs: Date.now() - started,
    tail: ((res.stdout ?? "") + (res.stderr ?? "")).split("\n").slice(-40).join("\n"),
  });
  return passed;
}

function skipStep(name, reason) {
  steps.push({ name, command: null, status: "skip", reason });
}

// ---- discover checks ----
let pkg = null;
const pkgPath = join(cwd, "package.json");
if (existsSync(pkgPath)) {
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    pkg = null;
  }
}

let anyFail = false;
let anyRan = false;

function tryScript(stepName, scriptNames) {
  const scripts = pkg?.scripts ?? {};
  const found = scriptNames.find((s) => typeof scripts[s] === "string");
  if (!found) {
    skipStep(stepName, `no script (${scriptNames.join("/")})`);
    return;
  }

  // PR #7 lesson 1: warn on `node --test <glob with **>` — /bin/sh won't recurse.
  const body = scripts[found];
  if (/node\s+--test\s+[^&|;]*\*\*/.test(body)) {
    console.error(
      `⚠️  [glob-trap] script "${found}" passes a ** glob to node --test — ` +
        `npm runs scripts via /bin/sh where ** does NOT recurse. ` +
        `Nested tests may be silently skipped. Use $(find ...) instead.`,
    );
  }

  anyRan = true;
  const pm = existsSync(join(cwd, "bun.lockb")) ? "bun"
    : existsSync(join(cwd, "yarn.lock")) ? "yarn"
    : existsSync(join(cwd, "pnpm-lock.yaml")) ? "pnpm"
    : "npm";
  const runPrefix = pm === "npm" ? "npm run" : pm === "bun" ? "bun run" : pm;
  if (!runStep(stepName, `${runPrefix} ${found}`)) anyFail = true;
}

if (pkg) {
  tryScript("lint", ["lint:fix", "lint"]);
  if (mode === "full") {
    tryScript("typecheck", ["typecheck", "type-check"]);
    tryScript("build", ["build"]);
  }
  tryScript("test", mode === "fast" ? ["test:unit", "test"] : ["test"]);
} else {
  // ecosystem fallback — try in priority order, first match wins.
  if (existsSync(join(cwd, "Cargo.toml"))) {
    anyRan = true;
    if (!runStep("cargo-test", "cargo test --quiet")) anyFail = true;
  } else if (existsSync(join(cwd, "go.mod"))) {
    anyRan = true;
    if (!runStep("go-test", "go test ./...")) anyFail = true;
  } else if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) {
    let pytest = false;
    try { execSync("command -v pytest", { cwd, stdio: "ignore" }); pytest = true; } catch { /* not installed */ }
    if (pytest) {
      anyRan = true;
      if (!runStep("pytest", "pytest -q")) anyFail = true;
    } else {
      skipStep("pytest", "pytest not installed");
    }
  } else if (existsSync(join(cwd, "deno.json")) || existsSync(join(cwd, "deno.jsonc"))) {
    anyRan = true;
    if (!runStep("deno-test", "deno test --quiet")) anyFail = true;
  } else if (existsSync(join(cwd, "justfile"))) {
    anyRan = true;
    if (!runStep("just-test", "just test")) anyFail = true;
  } else if (existsSync(join(cwd, "Makefile"))) {
    anyRan = true;
    if (!runStep("make-test", "make test")) anyFail = true;
  } else {
    skipStep("detect", "no package.json / Cargo.toml / go.mod / pyproject.toml / Makefile / justfile / deno.json");
  }
}

// ---- verdict ----
let overall;
if (anyFail) overall = "## Overall: ❌ FAIL";
else if (!anyRan) overall = "## Overall: ⚠️ NO CHECKS RUN";
else overall = "## Overall: ✅ PASS";

const verdict = anyFail ? "FAIL" : anyRan ? "PASS" : "NO_CHECKS_RUN";
const checksRun = steps.filter((s) => s.status === "pass" || s.status === "fail").length;
const checksFailed = steps.filter((s) => s.status === "fail").length;
const result = { schema: 1, verdict, mode, checksRun, checksFailed, steps };

// Write the nonce-stamped receipt (temp + atomic rename) when asked. This is
// the trusted channel; stdout is only for humans.
if (receiptPath && nonce) {
  try {
    const payload = JSON.stringify({ ...result, nonce, cwd });
    const tmp = `${receiptPath}.tmp-${process.pid}`;
    writeFileSync(tmp, payload);
    renameSync(tmp, receiptPath);
  } catch (e) {
    console.error(`precommit-runner: failed to write receipt: ${e.message}`);
    process.exit(3); // distinct: receipt write failure → extension fails closed
  }
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`# Precommit (${mode})`);
  for (const s of steps) {
    const icon = s.status === "pass" ? "✅" : s.status === "fail" ? "❌" : "⏭️";
    console.log(`- ${icon} ${s.name}${s.status === "skip" ? ` (${s.reason})` : ""}`);
    if (s.status === "fail") console.log("```\n" + s.tail + "\n```");
  }
  console.log("");
  console.log(overall);
}

// Distinct exit codes so the extension can tell states apart without parsing:
//   0 = PASS, 1 = FAIL, 2 = NO_CHECKS_RUN (NOT a pass), 3 = receipt write error.
process.exit(anyFail ? 1 : anyRan ? 0 : 2);
