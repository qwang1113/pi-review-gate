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
 * TWO LANES (default-on, no flags):
 *   fast — lint + typecheck + build + the tests RELATED to the changed files.
 *          This is the lane a `git commit` needs.
 *   full — the same checks with the COMPLETE test suite. This is the lane a
 *          `git push` / `gh pr create` needs.
 *
 * The split exists because binding every verdict to worktree content means a
 * one-character fix re-runs everything; on a large repo that was 4-5 minutes
 * per loop round, nearly all of it re-testing code the round did not touch.
 * Nothing is weakened by the split: the receipt records `testScope`, the gate
 * records the lane, and only a `full` PASS can authorize a push or a PR.
 *
 * Scheduling: any lint:fix script runs FIRST (it edits files, so it must
 * stabilize the worktree before anything reads it), then the remaining checks
 * run in parallel. Output and the receipt's `steps` array are presented in
 * DECLARATION order (lint, typecheck, build, test), never in completion order,
 * so a killed run's log still stops at the first unfinished check.
 *
 * Detection: package.json scripts (lint:fix/lint, typecheck, build, test:unit/test),
 * then ecosystem fallbacks (cargo, go, pytest/ruff) when package.json is absent.
 *
 * PR #7 lesson 1 (npm test glob trap): when the test script contains an
 * unexpanded `**` glob passed to node --test we WARN loudly, because /bin/sh
 * does not recurse `**` and tests may be silently skipped.
 */

import { execSync, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { readPrecommitConfig } from "./precommit-config.mjs";
import {
  detectsMdConsumingBuild,
  intersectWithScriptPaths,
  parseTestScript,
  planFastTests,
  runTestsByPathCommand,
  shellQuote,
  stepInputScope,
} from "./precommit-plan.mjs";
import {
  computeInputDigests,
  loadCache,
  lookup as cacheLookup,
  record as cacheRecord,
  recordFixOutcome,
  repoRootOf,
  saveCache,
} from "./precommit-cache.mjs";

const RUN_STARTED = Date.now();

const args = process.argv.slice(2);
function argOf(flag, dflt) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
}
// Normalized to the two known lanes: an unrecognized value must not land in a
// third, undefined state. It resolves to `fast`, the lane that cannot
// authorize a publish — so a typo costs a narrowed run, never a wider claim.
const mode = argOf("--mode", "fast") === "full" ? "full" : "fast";
const cwd = argOf("--cwd", process.cwd());
const asJson = args.includes("--json");
// Receipt mode: when the extension spawns this runner directly it passes a
// private receipt path + nonce (never exposed to the model). The runner writes
// a structured, nonce-stamped result there via temp+atomic-rename, so the
// extension trusts ONLY a receipt the runner actually produced. See
// lib/precommit-receipt.ts / extensions/review-gate.ts run_precommit tool.
const receiptPath = argOf("--receipt", null);
const nonce = argOf("--nonce", null);

// The repository the run belongs to. `cwd` may be a SUBDIRECTORY of it, so
// anything that has to line up with git output (changed files, the cache keys,
// the doc-consuming-framework probe) is anchored here rather than on `cwd`.
const repoRoot = repoRootOf(cwd) ?? cwd;

// Project-level step overrides (`.pi/review-gate.json` → `precommit`).
// `source: "default"` keeps the default detection below byte-for-byte;
// `invalid` is diagnostics-only (the run still uses the default logic).
const pc = readPrecommitConfig(repoRoot);
if (pc.invalid) {
  console.error(`⚠️  [precommit-config] ${pc.path}: ${pc.invalid} — using default detection`);
}

const steps = [];

// Streaming diagnostics (receipt mode only).
//
// Each step's output is buffered into THIS process's memory — grandchildren do
// not inherit the runner's stdout. So even after the extension started
// capturing our stdio to a log file, that log would hold almost nothing, and
// the final summary only lands once every step has finished: a run killed at
// the 20-minute timeout produced an EMPTY log, with no way to tell which check
// hung.
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
  pending[idx] = { lines, step: { ...step, source: plan[idx]?.source ?? "detected" } };
  while (nextToPresent < pending.length && pending[nextToPresent]) {
    const unit = pending[nextToPresent];
    for (const line of unit.lines) stream(line);
    steps.push(unit.step);
    nextToPresent++;
  }
}

function runStep(name, command, idx, yieldCpu = false, cacheScope = "all") {
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
      const durationMs = Date.now() - started;
      const lines = [
        `\n▶ ${name} — ${cmd}`,
        full,
        `◀ ${name} — ${passed ? "pass" : "fail"} (${durationMs}ms, exit ${code ?? `signal ${signal}`})`,
      ];
      const status = passed ? "pass" : "fail";
      // Keyed on the DECLARED command, not on `cmd`: the `nice` prefix is a
      // scheduling detail that depends on how many steps happened to run in
      // parallel, and letting it into the key would miss on every run.
      cacheRecord(cache, {
        name, command, scope: cacheScope, digests, status, durationMs, tail: full,
      });
      present(idx, lines, {
        name,
        command: cmd,
        status,
        durationMs,
        cached: false,
        cacheScope,
        // The receipt stays a BOUNDED structured summary; the unbounded full text
        // lives in the streamed log. Two channels, two jobs.
        tail: full.split("\n").slice(-40).join("\n"),
      });
      resolve();
    });
  });
}

/** Present a step whose recorded PASS was reused instead of re-running it. */
function cachedStep(name, command, idx, entry, cacheScope) {
  present(idx, [
    `\n▶ ${name} — ${command}`,
    `⚡ cache hit — inputs (${cacheScope}) unchanged since ${entry.at}; reusing the recorded PASS`,
    entry.tail ?? "",
    `◀ ${name} — pass (cached, originally ${entry.durationMs}ms)`,
  ], {
    name,
    command,
    status: "pass",
    durationMs: 0,
    cached: true,
    cacheScope,
    tail: entry.tail ?? "",
  });
}

function skipStep(name, reason, idx) {
  present(idx, [`⏭ ${name} — skipped (${reason})`], {
    name, command: null, status: "skip", reason, durationMs: 0, cached: false,
  });
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

const pm = existsSync(join(cwd, "bun.lockb")) ? "bun"
  : existsSync(join(cwd, "yarn.lock")) ? "yarn"
  : existsSync(join(cwd, "pnpm-lock.yaml")) ? "pnpm"
  : "npm";
const runPrefix = pm === "npm" ? "npm run" : pm === "bun" ? "bun run" : pm;

function collectStep(stepName, scriptNames) {
  const scripts = pkg?.scripts ?? {};
  const found = scriptNames.find((s) => typeof scripts[s] === "string");
  const idx = plan.length;
  if (!found) {
    plan.push({ name: stepName, command: null, reason: `no script (${scriptNames.join("/")})`, idx });
    return null;
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
  const entry = { name: stepName, command: `${runPrefix} ${found}`, isFix: found === "lint:fix", idx, script: found, body, source: "detected" };
  plan.push(entry);
  return entry;
}

/**
 * Collect one non-test step under project config. `configured` comes from
 * `.pi/review-gate.json`; `undefined` means "default detection for this step".
 * A configured script that does not exist in package.json skips the step with
 * a reason (fail-safe — the config never invents a command to run).
 */
function collectConfigured(stepName, scriptNames, configured) {
  const idx = plan.length;
  if (configured === undefined) return collectStep(stepName, scriptNames);
  if (configured === null || configured.skip === true) {
    plan.push({ name: stepName, command: null, reason: "configured skip", idx, source: "config" });
    return null;
  }
  if (typeof configured.command === "string" && configured.command !== "") {
    const entry = { name: stepName, command: configured.command, isFix: false, idx, source: "config" };
    plan.push(entry);
    anyRan = true;
    return entry;
  }
  if (typeof configured.script === "string" && configured.script !== "") {
    const scripts = pkg?.scripts ?? {};
    if (typeof scripts[configured.script] === "string") {
      const entry = {
        name: stepName,
        command: `${runPrefix} ${configured.script}`,
        isFix: configured.script === "lint:fix",
        idx,
        source: "config",
      };
      plan.push(entry);
      anyRan = true;
      return entry;
    }
    plan.push({
      name: stepName,
      command: null,
      reason: `configured script "${configured.script}" not found in package.json`,
      idx,
      source: "config",
    });
    return null;
  }
  return collectStep(stepName, scriptNames);
}

/**
 * Absolute paths of everything the worktree has changed.
 *
 * ABSOLUTE, not repo-relative, on purpose: `git status --porcelain` reports
 * paths from the REPO ROOT, but the checks run in `cwd`, which may be a
 * subdirectory. Handing root-relative paths to a runner started there made
 * `--findRelatedTests` match nothing, so the test step was quietly dropped
 * while the run still reported `related` — a silent under-run.
 */
function changedFiles() {
  try {
    const out = execFileSync(
      "git",
      ["status", "--porcelain", "-uall", "-z", "--", ":(top,exclude).pi", ":(top,exclude).pi-subagents"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
    );
    const entries = out.split("\0").filter(Boolean);
    const files = [];
    for (let i = 0; i < entries.length; i++) {
      const status = entries[i].slice(0, 2);
      const path = entries[i].slice(3);
      if (!path) continue;
      if (status.startsWith("R") && i + 1 < entries.length && entries[i + 1] && !entries[i + 1].startsWith("?")) {
        files.push(path, entries[++i]);
      } else {
        files.push(path);
      }
    }
    return files.map((f) => join(repoRoot, f));
  } catch {
    return null;
  }
}

/** Locate a test runner binary inside the project, or null. */
function resolveRunnerBin(runner) {
  if (runner === "node-test") return shellQuote(process.execPath);
  if (runner !== "jest" && runner !== "vitest") return null;
  const local = join(cwd, "node_modules", ".bin", runner);
  return existsSync(local) ? shellQuote(local) : null;
}

/**
 * Narrow the fast lane's test step to the tests related to the changed files.
 *
 * Returns the testScope actually achieved. `skipped` means no related set
 * could be derived — the step is dropped from the fast lane entirely and only
 * a `full` run can cover it, which is exactly why a fast PASS cannot ship.
 */
function narrowTestStep(entry) {
  const files = changedFiles();
  const fast = planFastTests({
    parsed: parseTestScript(entry.body),
    changedFiles: files,
    fullCommand: entry.command,
    resolveBin: resolveRunnerBin,
  });

  if (fast.testScope !== "related") {
    entry.command = null;
    entry.reason = `fast lane: ${fast.reason}`;
    return { testScope: "skipped", note: fast.reason };
  }

  if (!fast.listCommand) {
    entry.command = fast.command;
    return { testScope: "related", note: fast.reason };
  }

  // jest two-step: enumerate the related tests, intersect with the script's
  // own path filter (jest ignores --testPathPattern when --findRelatedTests is
  // present, so the intersection has to happen here), then run by exact path.
  let listed;
  try {
    listed = execSync(fast.listCommand, {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5 * 60 * 1000,
    });
  } catch {
    entry.reason = "fast lane: could not enumerate related tests";
    entry.command = null;
    return { testScope: "skipped", note: "related-test enumeration failed" };
  }

  const related = intersectWithScriptPaths(
    listed.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("Force exiting")),
    fast.positionals,
    cwd,
  );

  if (related.length === 0) {
    entry.command = null;
    entry.reason = "fast lane: no tests relate to the changed files";
    return { testScope: "related", note: "no related tests" };
  }

  entry.command = runTestsByPathCommand({ env: fast.env, bin: fast.bin, flags: fast.flags, files: related });
  return { testScope: "related", note: `${related.length} related test file(s)` };
}

/**
 * Collect the test step under project config (see precommit-config.mjs for
 * the normalized shapes). Lane semantics, agreed with the user:
 *   - a configured FAST test that cannot be narrowed (compound command,
 *     non-jest/vitest runner, missing bin, or `narrow: false`) runs the
 *     configured command IN FULL with testScope "full" — an explicitly
 *     configured command is executed, never silently dropped;
 *   - when narrowing IS attempted and yields no related tests, the step is
 *     dropped like the default lane (testScope "skipped").
 */
function collectTestConfigured() {
  const cfg = pc.steps.test;
  // `null` at the top level means "explicitly skip the test step in BOTH
  // lanes" — it must be handled BEFORE the lanes probe (reading `cfg.fast`
  // on null would crash).
  const step = cfg === null ? null
    : cfg === undefined ? undefined
    : (typeof cfg.fast !== "undefined" || typeof cfg.full !== "undefined"
      ? (mode === "fast" ? cfg.fast : cfg.full)
      : cfg);
  const idx = plan.length;
  // An object with neither `command` nor `script` (e.g. { narrow: false })
  // still configures the LANE: keep its narrow flag and use default detection
  // for the command — an explicit narrow:false must never silently drop the
  // detected test suite (fail-open), and a bare narrow:true is exactly the
  // default behavior anyway.
  const laneOnlyNarrow = step !== null && typeof step === "object" && step.skip !== true &&
    typeof step.command !== "string" && typeof step.script !== "string";
  const narrowFlag = laneOnlyNarrow && step.narrow === false ? false : undefined;
  const effectiveStep = laneOnlyNarrow ? undefined : step;
  if (effectiveStep === undefined) {
    // Lane not configured → default detection + default narrowing. Without
    // package.json the ecosystem fallback (Cargo/Go/pytest/…) still applies
    // — a partial config must never silently drop the project's real tests.
    collectDefaultTest(narrowFlag);
    return;
  }
  if (effectiveStep === null || effectiveStep.skip === true) {
    plan.push({ name: "test", command: null, reason: "configured skip", idx, source: "config" });
    // A `full` run covers the same (config-diminished) empty set a configured
    // skip leaves behind — same rationale as "no test script". Reporting
    // `skipped` here would violate the protocol invariant "mode full ⇒
    // testScope full" and turn every full run into a fail-closed ERROR.
    testScope = mode === "full" ? "full" : "skipped";
    testScopeNote = mode === "full"
      ? "test step skipped by project config (a full run covers the same set)"
      : "test step skipped by project config";
    return;
  }
  let entry;
  if (typeof effectiveStep.command === "string" && effectiveStep.command !== "") {
    entry = { name: "test", command: effectiveStep.command, idx, source: "config" };
    plan.push(entry);
  } else if (typeof effectiveStep.script === "string" && effectiveStep.script !== "") {
    const scripts = pkg?.scripts ?? {};
    if (typeof scripts[effectiveStep.script] === "string") {
      entry = { name: "test", command: `${runPrefix} ${effectiveStep.script}`, idx, source: "config" };
      plan.push(entry);
    } else {
      plan.push({
        name: "test",
        command: null,
        reason: `configured script "${effectiveStep.script}" not found in package.json`,
        idx,
        source: "config",
      });
      testScope = mode === "full" ? "full" : "skipped";
      testScopeNote = mode === "full"
        ? "configured test script not found (a full run covers the same set)"
        : "configured test script not found";
      return;
    }
  } else {
    // Defensive fallback — a command/script-less object is normalized to the
    // default-detection branch above, but never silently drop the suite.
    collectDefaultTest(narrowFlag);
    return;
  }
  anyRan = true;
  if (mode === "full") {
    testScope = "full";
    return;
  }
  // fast lane: narrowing is opt-out via `narrow: false`, otherwise attempted
  // when the configured command is a single jest/vitest invocation.
  if (effectiveStep.narrow === false) {
    testScope = "full";
    testScopeNote = "configured fast test runs the complete command (narrow disabled)";
    return;
  }
  const body = typeof effectiveStep.script === "string" ? (pkg?.scripts?.[effectiveStep.script] ?? "") : (effectiveStep.command ?? "");
  // narrowTestStep() re-parses entry.body — the entry MUST carry the original
  // script body, otherwise every configured narrow attempt would be dropped
  // as "not a single simple command" (silent under-run).
  entry.body = body;
  const parsed = parseTestScript(body);
  const narrowable = parsed !== null && (parsed.runner === "jest" || parsed.runner === "vitest") &&
    resolveRunnerBin(parsed.runner) !== null;
  if (!narrowable) {
    testScope = "full";
    testScopeNote = "narrow not applicable to the configured test command — ran it in full";
    return;
  }
  const fullCommand = entry.command;
  const narrowed = narrowTestStep(entry);
  testScope = narrowed.testScope;
  testScopeNote = narrowed.note;
  if (!entry.command) {
    if (!plan.some((s) => s.command)) {
      // The narrowed set was empty and this was the only runnable check — run
      // the complete configured command so a commit is never deadlocked.
      entry.command = fullCommand;
      delete entry.reason;
      testScope = "full";
      testScopeNote = `${narrowed.note}; ran the configured command in full (it is the only check)`;
    } else {
      anyRan = plan.some((s) => s.command);
    }
  }
}

// `testScope` describes how much of the project's RUNNABLE test suite this run
// covered. The gate reads it to decide whether a PASS may authorize a push/PR,
// so its meaning has to be exact:
//
//   "full"    — nothing was narrowed away. This includes projects with no
//               runnable tests at all: a `full` run would execute the same
//               (empty) set, and calling it anything else would deadlock the
//               push gate forever on a repo that simply has no test script.
//   "related" — the fast lane ran only the tests related to the changed files.
//   "skipped" — a real, runnable suite exists but the fast lane could not
//               derive a related set, so the test step was dropped.
let testScope = mode === "full" ? "full" : "skipped";
let testScopeNote = "";

if (pc.source === "project") {
  // Project config replaces the default detection step-by-step; an absent
  // step still falls back to it.
  collectConfigured("lint", ["lint:fix", "lint"], pc.steps.lint);
  collectConfigured("typecheck", ["typecheck", "type-check"], pc.steps.typecheck);
  collectConfigured("build", ["build"], pc.steps.build);
  collectTestConfigured();
} else if (pkg) {
  collectStep("lint", ["lint:fix", "lint"]);
  collectStep("typecheck", ["typecheck", "type-check"]);
  collectStep("build", ["build"]);
  const testEntry = collectStep("test", mode === "fast" ? ["test:unit", "test"] : ["test"]);
  if (testEntry && mode === "fast") {
    const fullTestCommand = testEntry.command;
    const narrowed = narrowTestStep(testEntry);
    testScope = narrowed.testScope;
    testScopeNote = narrowed.note;
    if (!testEntry.command) {
      if (!plan.some((s) => s.command)) {
        // The dropped test step was the ONLY runnable check, so dropping it
        // would make every fast run NO_CHECKS_RUN — a repo whose sole check is
        // an underivable suite could then never commit. Run the complete suite
        // instead: slower than a narrowed one, never less than before.
        testEntry.command = fullTestCommand;
        delete testEntry.reason;
        testScope = "full";
        testScopeNote = `${narrowed.note}; ran the full suite (it is the only check)`;
      } else {
        // Other checks still run; the verdict must not claim this one did.
        anyRan = plan.some((s) => s.command);
      }
    }
  } else if (!testEntry) {
    // No test script at all: a `full` run would cover the same empty set.
    testScope = "full";
    testScopeNote = "no test script";
  }
} else {
  // No package.json: ecosystem fallback — try in priority order, first match
  // wins. These runners have no related-test derivation yet, so the fast lane
  // runs them in full (never less than before).
  collectEcosystemTest();
}

/**
 * Default detection for the test step: package.json script priority table
 * (with the ecosystem fallback when there is no package.json) plus the
 * default narrowing. `narrowFlag === false` (from a lane-only config object
 * like { narrow: false }) runs the detected command in full instead.
 */
function collectDefaultTest(narrowFlag) {
  if (!pkg) {
    collectEcosystemTest();
    return;
  }
  const testEntry = collectStep("test", mode === "fast" ? ["test:unit", "test"] : ["test"]);
  if (!testEntry) {
    testScope = "full";
    testScopeNote = "no test script";
    return;
  }
  if (mode !== "fast") return; // full lane runs the detected command as-is
  if (narrowFlag === false) {
    testScope = "full";
    testScopeNote = "configured narrow:false runs the detected test command in full";
    return;
  }
  const fullTestCommand = testEntry.command;
  const narrowed = narrowTestStep(testEntry);
  testScope = narrowed.testScope;
  testScopeNote = narrowed.note;
  if (!testEntry.command) {
    if (!plan.some((s) => s.command)) {
      testEntry.command = fullTestCommand;
      delete testEntry.reason;
      testScope = "full";
      testScopeNote = `${narrowed.note}; ran the full suite (it is the only check)`;
    } else {
      anyRan = plan.some((s) => s.command);
    }
  }
}

/**
 * Ecosystem fallback for the test step (no package.json): Cargo/go/pytest/
 * deno/just/make, first match wins. Also used by the project-config path so a
 * partial config can never silently drop the project's real test suite.
 */
function collectEcosystemTest() {
  testScope = "full";
  const idx = plan.length;
  if (existsSync(join(cwd, "Cargo.toml"))) {
    anyRan = true;
    plan.push({ name: "cargo-test", command: "cargo test --quiet", idx, source: "detected" });
  } else if (existsSync(join(cwd, "go.mod"))) {
    anyRan = true;
    plan.push({ name: "go-test", command: "go test ./...", idx, source: "detected" });
  } else if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) {
    let pytest = false;
    try { execSync("command -v pytest", { cwd, stdio: "ignore" }); pytest = true; } catch { /* not installed */ }
    if (pytest) {
      anyRan = true;
      plan.push({ name: "pytest", command: "pytest -q", idx, source: "detected" });
    } else {
      // pytest is not installed, so a `full` run cannot execute these tests
      // either — nothing was narrowed away.
      plan.push({ name: "pytest", command: null, reason: "pytest not installed", idx, source: "detected" });
    }
  } else if (existsSync(join(cwd, "deno.json")) || existsSync(join(cwd, "deno.jsonc"))) {
    anyRan = true;
    plan.push({ name: "deno-test", command: "deno test --quiet", idx, source: "detected" });
  } else if (existsSync(join(cwd, "justfile"))) {
    anyRan = true;
    plan.push({ name: "just-test", command: "just test", idx, source: "detected" });
  } else if (existsSync(join(cwd, "Makefile"))) {
    anyRan = true;
    plan.push({ name: "make-test", command: "make test", idx, source: "detected" });
  } else {
    // No recognizable ecosystem: there is no suite to narrow away.
    plan.push({ name: "detect", command: null, reason: "no package.json / Cargo.toml / go.mod / pyproject.toml / Makefile / justfile / deno.json", idx, source: "detected" });
  }
}

// ---- per-step cache ----
//
// Keys are derived from a materialized git tree (see precommit-cache.mjs for
// why stat-based keys would be a fail-open). Any problem — no git, submodules,
// unreadable cache — yields `digests = null`, which makes every lookup miss and
// every step run.
// (`repoRoot` is resolved near the top of the file — the changed-file scan
// needs it before the plan is built.)
let mdConsumingBuild = false;
try {
  mdConsumingBuild = detectsMdConsumingBuild(readdirSync(repoRoot));
} catch { /* unreadable root → conservative default (false ⇒ narrow scopes are
             still guarded by DOC_TOUCHING_TOOL_RE per step) */ }

let digests = null;
let treeOidOf = null;
try {
  const { worktreeTreeOid } = createRequire(import.meta.url)("./compute-fingerprint.cjs");
  treeOidOf = () => worktreeTreeOid(repoRoot);
  digests = computeInputDigests(cwd, treeOidOf);
} catch {
  digests = null; // shared fingerprint impl unavailable → no caching
}
const cache = loadCache(repoRoot);

// ---- execute: skips present immediately (queued behind unfinished earlier
// steps), lint:fix runs first and alone, everything else in parallel. ----
for (const s of plan) if (!s.command) skipStep(s.name, s.reason, s.idx);

const runnable = plan.filter((s) => s.command);
for (const s of runnable) s.cacheScope = stepInputScope(s.name, s.command, mdConsumingBuild);

function lookupHit(s) {
  return cacheLookup(cache, {
    name: s.name, command: s.command, scope: s.cacheScope, digests, isFix: Boolean(s.isFix),
  });
}

// ---- stage 1: the fix step, alone ----
//
// `lint:fix` EDITS THE WORKTREE, which is why it runs first and why the cache
// has to treat it specially. Two rules, both load-bearing:
//
//  a) It may only be reused when its previous run left the tree UNCHANGED
//     (`postKey === key`, enforced in precommit-cache.mjs). A fix that did
//     change files last time must run again — skipping it would leave those
//     fixes unapplied while every later step reused a PASS earned on the
//     FIXED tree.
//  b) Once it has actually run, every later step is keyed on the tree AS IT
//     NOW STANDS, not on the pre-fix tree. Recording them against the pre-fix
//     key was a real fail-open: restoring that pre-fix content later (a
//     `git add` + `git checkout -- .`, a stash cycle) replayed the whole run
//     from cache, publishing a PASS for a tree those checks never saw.
const fix = runnable.find((s) => s.isFix);
if (fix) {
  const hit = lookupHit(fix);
  if (hit) {
    cachedStep(fix.name, fix.command, fix.idx, hit, fix.cacheScope);
  } else {
    await runStep(fix.name, fix.command, fix.idx, false, fix.cacheScope);
    // Re-key on the post-fix tree, and record what the fix left behind so a
    // future run can tell a no-op fix (reusable) from an editing one.
    const before = digests;
    if (treeOidOf) {
      try {
        digests = computeInputDigests(cwd, treeOidOf);
      } catch {
        digests = null; // cannot re-key → no caching for the rest of this run
      }
    }
    recordFixOutcome(cache, fix.name, before, digests);
  }
}

// ---- stage 2: everything else, in parallel, keyed on the post-fix tree ----
const toRun = [];
for (const s of runnable) {
  if (s === fix) continue;
  const hit = lookupHit(s);
  if (hit) cachedStep(s.name, s.command, s.idx, hit, s.cacheScope);
  else toRun.push(s);
}

// Only steps that actually run CONCURRENTLY need CPU yielding, and only the
// non-test ones should yield: a lone ecosystem step has no competitor.
const concurrent = toRun.length > 1;
await Promise.all(toRun.map((s) => runStep(s.name, s.command, s.idx, concurrent && s.name !== "test", s.cacheScope)));

saveCache(repoRoot, cache);

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
const result = {
  schema: 1,
  verdict,
  mode,
  // Where the step commands came from: "project" (`.pi/review-gate.json`
  // precommit section) or "default" (package.json / ecosystem detection).
  config: { source: pc.source, path: pc.path },
  // `testScope` is what makes the two lanes safe to distinguish downstream:
  // the gate accepts a fast PASS for a commit, but a push/PR requires a run
  // whose tests were not narrowed.
  testScope,
  totalMs: Date.now() - RUN_STARTED,
  checksRun,
  checksFailed,
  steps,
};

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
  const configTag = pc.source === "project" ? `config: project (${pc.path})` : "config: default";
  console.log(`# Precommit (${mode}, tests: ${testScope}${testScopeNote ? ` — ${testScopeNote}` : ""}, ${configTag})`);
  for (const s of steps) {
    const icon = s.status === "pass" ? "✅" : s.status === "fail" ? "❌" : "⏭️";
    const timing = s.status === "skip" ? ` (${s.reason})` : s.cached ? " (cached)" : ` (${s.durationMs}ms)`;
    console.log(`- ${icon} ${s.name}${timing}`);
    if (s.status === "fail") console.log("```\n" + s.tail + "\n```");
  }
  console.log(`\nTotal: ${result.totalMs}ms`);
  console.log("");
  console.log(overall);
}

// Distinct exit codes so the extension can tell states apart without parsing:
//   0 = PASS, 1 = FAIL, 2 = NO_CHECKS_RUN (NOT a pass), 3 = receipt write error.
process.exit(anyFail ? 1 : anyRan ? 0 : 2);
