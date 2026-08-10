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
 * Scheduling (default-on, no flags): any lint:fix script runs FIRST (it edits
 * files, so it must stabilize the worktree before anything reads it), then the
 * remaining checks (lint/typecheck/build/test) run in parallel. Output and the
 * receipt's `steps` array are presented in DECLARATION order (lint, typecheck,
 * build, test), never in completion order, so a killed run's log still stops at
 * the first unfinished check.
 *
 * Detection: package.json scripts (lint:fix/lint, typecheck, build, test:unit/test),
 * then ecosystem fallbacks (cargo, go, pytest/ruff) when package.json is absent.
 *
 * PR #7 lesson 1 (npm test glob trap): when the test script contains an
 * unexpanded `**` glob passed to node --test we WARN loudly, because /bin/sh
 * does not recurse `**` and tests may be silently skipped.
 */

import { execSync, spawn } from "node:child_process";
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

// Streaming diagnostics (receipt mode only).
//
// Each step runs through spawnSync, which buffers the child's output into THIS
// process's memory — grandchildren do not inherit the runner's stdout. So even
// after the extension started capturing our stdio to a log file, that log would
// hold almost nothing, and the final summary only lands once every step has
// finished: a run killed at the 20-minute timeout produced an EMPTY log, with
// no way to tell which check hung.
//
// In receipt mode we therefore announce each step BEFORE running it and dump
// its complete stdout+stderr immediately AFTER, so the log stays useful even
// when the process is killed mid-run. Interactive humans (no --receipt) keep
// the original compact output.
const streaming = Boolean(receiptPath && nonce);

function stream(line) {
  if (streaming) console.log(line);
}

// ---- parallel execution, declaration-order presentation ----
//
// Checks run concurrently, but the log and the receipt `steps` array must read
// in DECLARATION order (lint, typecheck, build, test) — not completion order.
// Each finished unit waits for every earlier-declared unit to be presented
// first. Consequences, both intended:
//   - a killed run's log stops at the FIRST unfinished check in declaration
//     order (its `▶` is the last line), so the hung step stays identifiable;
//   - the `▶ … ◀` pair marks a unit's place in the log, not the instant the
//     child was spawned (a parallel child may have finished by then).
const pending = []; // declaration-order slots; null until that step finished
let nextToPresent = 0;

function present(idx, lines, step) {
  pending[idx] = { lines, step };
  while (nextToPresent < pending.length && pending[nextToPresent]) {
    const unit = pending[nextToPresent];
    for (const line of unit.lines) stream(line);
    steps.push(unit.step);
    nextToPresent++;
  }
}

function runStep(name, command, idx, yieldCpu = false) {
  const started = Date.now();
  return new Promise((resolve) => {
    // CPU priority: when checks actually run in parallel, `test` gets the
    // highest priority and every OTHER parallel step yields via `nice -n 10`.
    // Timing-sensitive suites (this repo's fingerprint regressions) measurably
    // slow down when tsc competes for CPU; a yielding tsc keeps the test's
    // pacing intact. `nice` is POSIX and bash is already a hard requirement.
    // A step that runs alone (the lint:fix first stage, a single ecosystem
    // fallback) has no competitor and is never niced.
    const cmd = yieldCpu ? `nice -n 10 ${command}` : command;
    const child = spawn("bash", ["-c", cmd], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15 * 60 * 1000,
    });
    // The old spawnSync had a 64MB maxBuffer that turned pathological output
    // into a hard failure; the streamed version caps capture the same way,
    // but truncates with a marker instead of failing the step.
    let full = "";
    let captureTruncated = false;
    const MAX_CAPTURE = 64 * 1024 * 1024;
    const onData = (d) => {
      if (captureTruncated) return;
      if (full.length + d.length > MAX_CAPTURE) {
        full = `${full.slice(0, MAX_CAPTURE)}\n…[output truncated at 64MB]…\n`;
        captureTruncated = true;
        return;
      }
      full += d;
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", () => { /* spawn failure surfaces via close with non-zero */ });
    child.on("close", (code, signal) => {
      const passed = code === 0;
      const lines = [
        `\n▶ ${name} — ${cmd}`,
        full,
        `◀ ${name} — ${passed ? "pass" : "fail"} (${Date.now() - started}ms, exit ${code ?? `signal ${signal}`})`,
      ];
      present(idx, lines, {
        name,
        command: cmd,
        status: passed ? "pass" : "fail",
        durationMs: Date.now() - started,
        // The receipt stays a BOUNDED structured summary; the unbounded full text
        // lives in the streamed log. Two channels, two jobs.
        tail: full.split("\n").slice(-40).join("\n"),
      });
      resolve();
    });
  });
}

function skipStep(name, reason, idx) {
  present(idx, [`⏭ ${name} — skipped (${reason})`], { name, command: null, status: "skip", reason });
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

// `anyFail` is derived from the (declaration-ordered) steps in the verdict
// section, not from return values: parallel steps cannot report back through
// a boolean channel.
let anyRan = false;

// ---- collect phase: decide which checks exist WITHOUT running them, so the
// scheduler can run lint:fix first (it edits files) and parallelize the rest.
const plan = []; // { name, command, reason?, isFix?, idx } — declaration order

function collectStep(stepName, scriptNames) {
  const scripts = pkg?.scripts ?? {};
  const found = scriptNames.find((s) => typeof scripts[s] === "string");
  const idx = plan.length;
  if (!found) {
    plan.push({ name: stepName, command: null, reason: `no script (${scriptNames.join("/")})`, idx });
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
  plan.push({ name: stepName, command: `${runPrefix} ${found}`, isFix: found === "lint:fix", idx });
}

if (pkg) {
  collectStep("lint", ["lint:fix", "lint"]);
  if (mode === "full") {
    collectStep("typecheck", ["typecheck", "type-check"]);
    collectStep("build", ["build"]);
  }
  collectStep("test", mode === "fast" ? ["test:unit", "test"] : ["test"]);
} else {
  // ecosystem fallback — try in priority order, first match wins.
  if (existsSync(join(cwd, "Cargo.toml"))) {
    anyRan = true;
    plan.push({ name: "cargo-test", command: "cargo test --quiet", idx: plan.length });
  } else if (existsSync(join(cwd, "go.mod"))) {
    anyRan = true;
    plan.push({ name: "go-test", command: "go test ./...", idx: plan.length });
  } else if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) {
    let pytest = false;
    try { execSync("command -v pytest", { cwd, stdio: "ignore" }); pytest = true; } catch { /* not installed */ }
    if (pytest) {
      anyRan = true;
      plan.push({ name: "pytest", command: "pytest -q", idx: plan.length });
    } else {
      plan.push({ name: "pytest", command: null, reason: "pytest not installed", idx: plan.length });
    }
  } else if (existsSync(join(cwd, "deno.json")) || existsSync(join(cwd, "deno.jsonc"))) {
    anyRan = true;
    plan.push({ name: "deno-test", command: "deno test --quiet", idx: plan.length });
  } else if (existsSync(join(cwd, "justfile"))) {
    anyRan = true;
    plan.push({ name: "just-test", command: "just test", idx: plan.length });
  } else if (existsSync(join(cwd, "Makefile"))) {
    anyRan = true;
    plan.push({ name: "make-test", command: "make test", idx: plan.length });
  } else {
    plan.push({ name: "detect", command: null, reason: "no package.json / Cargo.toml / go.mod / pyproject.toml / Makefile / justfile / deno.json", idx: plan.length });
  }
}

// ---- execute: skips present immediately (queued behind unfinished earlier
// steps), lint:fix runs first and alone, everything else in parallel. ----
for (const s of plan) if (!s.command) skipStep(s.name, s.reason, s.idx);
const fix = plan.find((s) => s.command && s.isFix);
const rest = plan.filter((s) => s.command && s !== fix);
if (fix) await runStep(fix.name, fix.command, fix.idx);
// Only steps that actually run CONCURRENTLY need CPU yielding, and only the
// non-test ones should yield: a lone ecosystem step has no competitor.
const concurrent = rest.length > 1;
await Promise.all(rest.map((s) => runStep(s.name, s.command, s.idx, concurrent && s.name !== "test")));


// ---- verdict ----
// `anyFail` is derived from the (declaration-ordered) steps, not from return
// values: parallel steps cannot report back through the old boolean channel.
const anyFail = steps.some((s) => s.status === "fail");
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
