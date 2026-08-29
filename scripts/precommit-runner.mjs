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

import { execSync, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
import { readPrecommitConfig } from "./precommit-config.mjs";
import {
  detectsMdConsumingBuild,
  intersectWithScriptPaths,
  jestIgnoreArgs,
  hasJestConfigSelection,
  boundedTail,
  createCaptureAccumulator,
  maybeInjectJestIgnore,
  parseTestScript,
  planFastTests,
  runTestsByPathCommand,
  shellQuote,
  splitTokens,
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
// `--json` always wins: that mode's stdout is PARSED by its caller, so no
// diagnostic may precede the JSON object — not the step blocks, not the plan
// preamble, not live output. (Passing --json together with --receipt used to
// emit both, leaving stdout unparseable.)
const streaming = Boolean(receiptPath && nonce) && !asJson;

function stream(line) {
  if (streaming) console.log(line);
}

/**
 * Write a raw chunk (no added newline) as LIVE step output.
 *
 * The ordered `▶ … ◀` blocks below remain the log's structure; this writes the
 * body of the block that is currently OPEN, as the child produces it, instead
 * of only at close. Without it a 4-minute test step wrote nothing at all until
 * it finished — which is exactly what made a precommit look hung to the agent
 * tailing this log.
 */
function streamRaw(text) {
  if (streaming && text !== "") process.stdout.write(text);
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

// LIVE OUTPUT, without breaking that order. Only the step the log is
// currently AT (`nextToPresent`) may stream: its `▶` block is open, so its
// body can be written as it arrives. Steps that finish out of order keep
// buffering exactly as before and are presented when their turn comes, so the
// log still reads lint → typecheck → build → test and nothing is printed twice.
const running = new Map(); // idx -> { name, cmd, full, streamed, headerPrinted }

function pumpLive() {
  const cur = running.get(nextToPresent);
  if (!cur) return;
  if (!cur.headerPrinted) {
    stream(`\n▶ ${cur.name} — ${cur.cmd}`);
    cur.headerPrinted = true;
  }
  if (cur.full.length > cur.streamed) {
    streamRaw(cur.full.slice(cur.streamed));
    cur.streamed = cur.full.length;
  }
}

function present(idx, lines, step) {
  pending[idx] = { lines, step: { ...step, source: plan[idx]?.source ?? "detected" } };
  while (nextToPresent < pending.length && pending[nextToPresent]) {
    const unit = pending[nextToPresent];
    for (const line of unit.lines) stream(line);
    steps.push(unit.step);
    nextToPresent++;
  }
  // The step the log is now AT may already be running with output buffered:
  // flush it so liveness resumes immediately instead of at its close.
  pumpLive();
}

// ---- fail-fast across the parallel stage ----
//
// A precommit that already knows its verdict is FAIL has nothing left to
// learn: the remaining checks cost minutes and change nothing. The FIRST
// failure aborts the rest immediately (user ask, 2026-08-29).
//
// Aborted steps are reported as `skip` with a reason, never as `fail`: they
// did not fail, they never finished — and `checksRun` counts only steps that
// actually produced a result. Their cache entries are dropped by
// `record()` (non-pass ⇒ delete), so the next run re-runs them.
const liveSteps = new Map(); // idx -> ChildProcess, only while it runs
const abortedSteps = new Set(); // idx of steps THIS mechanism killed
let failFastBy = null; // name of the step whose failure stopped the run

function abortRemainingSteps(failedName) {
  failFastBy = failedName;
  for (const [idx, child] of liveSteps) {
    abortedSteps.add(idx);
    killStepTree(child);
  }
}

/**
 * Terminate a step and everything it started.
 *
 * Signalling the `bash -c` wrapper alone is not enough, and it cost a measured
 * 25 seconds: bash dies, but its grandchild (`npm` → the real command) keeps
 * running AND keeps the stdout pipe open, so the runner still waits for the
 * step it just aborted. Each step therefore leads its OWN process group, and
 * the whole group is signalled.
 */
function killStepTree(child) {
  try {
    if (typeof child.pid === "number") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    // The group is already gone, or this platform refused the group signal —
    // fall back to the direct child.
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

// A detached group must never outlive the runner: if we exit (normally, or on
// Ctrl-C, which no longer reaches the steps' own groups), take them with us.
function killAllLiveSteps() {
  for (const child of liveSteps.values()) killStepTree(child);
}
process.on("exit", killAllLiveSteps);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { killAllLiveSteps(); process.exit(1); });
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
      // Each step LEADS its own process group, so fail-fast can terminate the
      // whole tree it started (bash → npm → the real command), not just the
      // wrapper. The runner kills every live group on its own exit, so a
      // detached group never outlives the run.
      detached: true,
    });
    // Registered while it runs, so the first failure can stop the others.
    liveSteps.set(idx, child);
    // The old spawnSync had a 64MB maxBuffer that turned pathological output
    // into a hard failure; the streamed version caps capture the same way,
    // but truncates with a marker instead of failing the step.
    const MAX_CAPTURE = 64 * 1024 * 1024;
    // Registered so `pumpLive` can stream this step's body while it is the one
    // the log is at. `full` is re-published on every fragment because the entry
    // holds a snapshot, not a live reference to the accumulator.
    const live = { name, cmd, full: "", streamed: 0, headerPrinted: false };
    running.set(idx, live);
    // ONE decoder per stream, kept across chunks. A child's stdout chunk
    // boundary lands wherever the kernel put it, so decoding each chunk on its
    // own turns a split multibyte character into U+FFFD — permanently, and
    // BEFORE the log is written, which no decoding downstream (the extension's
    // tail) can repair. stdout and stderr get their own decoder: they are
    // independent byte streams and must not share a partial-sequence buffer.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    // Byte-accurate cap + post-truncation flush policy live in a pure unit
    // (precommit-plan.mjs) so both rules are unit-testable without a 64 MiB run.
    const capture = createCaptureAccumulator(MAX_CAPTURE, () => {
      live.full = capture.text;
      pumpLive();
    });
    const onData = (decoder) => (d) => capture.push(d.length, decoder.write(d));
    // Flushed on EVERY exit path, and deliberately not gated on
    // `captureTruncated`: the remainder is at most a few bytes of a character
    // the child was killed in the middle of, and dropping it silently is how
    // the last line of an aborted run goes missing.
    const flushDecoders = () => { capture.flush(outDecoder.end()); capture.flush(errDecoder.end()); };
    child.stdout.on("data", onData(outDecoder));
    child.stderr.on("data", onData(errDecoder));
    child.on("error", () => { /* spawn failure surfaces via close with non-zero */ });
    child.on("close", (code, signal) => {
      const passed = code === 0;
      const durationMs = Date.now() - started;
      // Flush BEFORE the block is closed: a child killed mid-character leaves an
      // incomplete sequence buffered in its decoder, and it belongs in the log.
      flushDecoders();
      const full = capture.text;
      running.delete(idx);
      liveSteps.delete(idx);
      live.full = full;
      // Fail-fast: this step's failure is the whole run's verdict, so the
      // remaining ones are killed here — before anyone waits on them.
      const aborted = abortedSteps.has(idx);
      if (!passed && !aborted) abortRemainingSteps(name);
      const outcome = aborted ? "aborted" : passed ? "pass" : "fail";
      const closing = `◀ ${name} — ${outcome} (${durationMs}ms, exit ${code ?? `signal ${signal}`})`;
      // A step that already streamed live must not have its body reprinted:
      // emit only what the last pump did not cover, plus the closing marker.
      const lines = live.headerPrinted
        ? [full.slice(live.streamed), closing].filter((l) => l !== "")
        : [`\n▶ ${name} — ${cmd}`, full, closing];
      // An aborted step is `skip`, not `fail`: it never produced a result, and
      // reporting it as failed would invent failures the code does not have.
      const status = aborted ? "skip" : passed ? "pass" : "fail";
      // Keyed on the DECLARED command, not on `cmd`: the `nice` prefix is a
      // scheduling detail that depends on how many steps happened to run in
      // parallel, and letting it into the key would miss on every run.
      cacheRecord(cache, {
        // Bounded for the same reason as the receipt: a cache entry is replayed
        // into a later run's log, so an unbounded tail would persist 64 MiB of
        // output in `.pi/precommit-cache.json` and reprint it on every hit.
        name, command, scope: cacheScope, digests, status, durationMs, tail: boundedTail(full),
      });
      present(idx, lines, {
        name,
        command: cmd,
        status,
        ...(aborted ? { reason: `aborted — ${failFastBy ?? "an earlier check"} failed (fail-fast)` } : {}),
        durationMs,
        cached: false,
        cacheScope,
        // The receipt stays a BOUNDED structured summary; the unbounded full text
        // lives in the streamed log. Two channels, two jobs. Bounded in BYTES as
        // well as lines: one un-newlined 64 MiB line is still one line, and the
        // extension refuses any receipt over 1 MiB — which would turn a genuinely
        // passing run into ERROR.
        tail: boundedTail(full),
      });
      resolve();
    });
  });
}

/** Present a step whose recorded PASS was reused instead of re-running it. */
function cachedStep(name, command, idx, entry, cacheScope) {
  // Bound on READ as well as on write: a cache file written by an earlier
  // version (or by hand) still holds an unbounded tail, and replaying it into
  // the receipt reproduces the oversized-receipt failure the write-side bound
  // was added to prevent — a genuine PASS rejected as ERROR.
  const tail = boundedTail(entry.tail ?? "");
  present(idx, [
    `\n▶ ${name} — ${command}`,
    `⚡ cache hit — inputs (${cacheScope}) unchanged since ${entry.at}; reusing the recorded PASS`,
    tail,
    `◀ ${name} — pass (cached, originally ${entry.durationMs}ms)`,
  ], {
    name,
    command,
    status: "pass",
    durationMs: 0,
    cached: true,
    cacheScope,
    tail,
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


// ---- jest `.pi` ignore injection (see precommit-plan.mjs for the pure half) ----
//
// jest's default testMatch would scan `.pi/review-snapshots/` — disposable
// copies of the worktree whose test files are NOT meant to run. Read the
// repo's own testPathIgnorePatterns via `jest --showConfig` (the authoritative
// source), merge `<rootDir>/.pi/` in, and pass the combined list via CLI. A
// repo whose showConfig cannot run gets NO injection (never a CLI override
// that would silently drop the repo's own exclusions) and a recorded reason.
//
// The query must describe the SAME configuration as the run. Rather than
// reproduce an explicit selection (which means reimplementing jest's CLI
// parsing — see `hasJestConfigSelection`), a command that selects its config
// explicitly is skipped with a reason. The merge therefore only ever happens
// where a bare `--showConfig` provably describes the command's own config.
let jestIgnoreNote = "";
let jestIgnoreArgsCache;
function resolveJestIgnoreInjection(body, spawnFn = spawnSync) {
  const source = typeof body === "string" ? body : "";
  const parsed = parseTestScript(source);
  // Not a single jest command ⇒ nothing to inject into: return before spawning
  // anything. Querying `--showConfig` for a vitest/node --test script costs a
  // process for a result that can never be used, and its "skipped" note would
  // describe a jest problem the project does not have. The per-step reason from
  // `maybeInjectJestIgnore` already explains why such a step is not rewritten.
  if (parsed?.runner !== "jest") return "";
  if (hasJestConfigSelection(splitTokens(source))) {
    jestIgnoreNote = "jest ignore injection skipped: the test command selects its own jest config " +
      "(add <rootDir>/.pi/ to that config's testPathIgnorePatterns)";
    return "";
  }
  if (jestIgnoreArgsCache !== undefined) return jestIgnoreArgsCache;
  const remember = (value) => { jestIgnoreArgsCache = value; return value; };
  // RAW path, not `resolveRunnerBin`: this is an argv entry, and a shell-quoted
  // path would spawn a file whose name literally contains the quotes (ENOENT).
  const bin = runnerBinPath("jest");
  if (!bin) {
    jestIgnoreNote = "jest ignore injection skipped: no local jest bin";
    return remember("");
  }
  // Bare query: reaching here proves the command uses default config discovery.
  const r = spawnFn(bin, ["--showConfig"], { cwd, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.status !== 0) {
    // `spawnSync` reports a failed spawn in `error`, not by throwing.
    const why = r.error ? r.error.code ?? r.error.message : `exit ${r.status ?? "unknown"}`;
    jestIgnoreNote = `jest ignore injection skipped: jest --showConfig failed (${why})`;
    return remember("");
  }
  let patterns;
  try {
    patterns = JSON.parse(r.stdout)?.configs?.[0]?.testPathIgnorePatterns;
  } catch { patterns = undefined; }
  if (!Array.isArray(patterns)) {
    jestIgnoreNote = "jest ignore injection skipped: showConfig output lacks testPathIgnorePatterns";
    return remember("");
  }
  jestIgnoreNote = "";
  return remember(jestIgnoreArgs(patterns));
}

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
  // ONLY the test step. The exclusion exists so a test run does not execute the
  // disposable copies under `.pi/review-snapshots/` (repo-local fallback; the
  // default `~/.pi/review-snapshots/` layout is outside the repo and out of
  // reach of any whole-tree scan); a lint/typecheck/build
  // script that happens to be a plain `jest` invocation is a different job, and
  // rewriting it would also change its cache command key (and, for `lint:fix`,
  // the command whose edits the fix stage is keyed on).
  const injected = stepName === "test"
    ? maybeInjectJestIgnore({ command: `${runPrefix} ${found}`, body, pm, ignoreArgs: resolveJestIgnoreInjection(body) })
    : { command: `${runPrefix} ${found}`, injected: false };
  // Keep the SPECIFIC reason when there already is one: the resolver's note
  // (why `jest --showConfig` failed) is the actionable half, and the generic
  // per-step reason would otherwise replace it with a pointer to itself.
  if (!injected.injected && injected.reason && stepName === "test" && !jestIgnoreNote) jestIgnoreNote = injected.reason;
  const entry = { name: stepName, command: injected.command, isFix: found === "lint:fix", idx, script: found, body, source: "detected" };
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
      // NO jest injection here on purpose: this function collects the NON-test
      // steps only (lint / typecheck / build — the test step goes through
      // `collectTestConfigured`), and the `.pi` exclusion is scoped to the test
      // step. A configured `lint` that happens to be a plain `jest` command must
      // keep its command verbatim, or its cache key (and, for `lint:fix`, the
      // command the fix stage is keyed on) changes for an unrelated reason.
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

/**
 * Locate a test runner binary inside the project as a RAW path, or null.
 *
 * Separate from `resolveRunnerBin` on purpose: a shell-quoted path is correct
 * for a command STRING (`execSync`) and wrong for an argv entry (`spawnSync`,
 * no shell), where the quotes become part of the filename and the spawn fails
 * with ENOENT. `spawnSync` reports that in `result.error` rather than throwing,
 * so the mistake degrades silently into never injecting anything.
 */
function runnerBinPath(runner) {
  if (runner === "node-test") return process.execPath;
  if (runner !== "jest" && runner !== "vitest") return null;
  const local = join(cwd, "node_modules", ".bin", runner);
  return existsSync(local) ? local : null;
}

/** Locate a test runner binary inside the project, quoted for a shell command. */
function resolveRunnerBin(runner) {
  const path = runnerBinPath(runner);
  return path === null ? null : shellQuote(path);
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
    // Raw tokens so the planner can see an explicit jest config selection: the
    // enumeration would otherwise run under the DEFAULT config and hand back a
    // related set from the wrong one.
    tokens: splitTokens(typeof entry.body === "string" ? entry.body : ""),
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
  // The enumeration itself must skip `.pi` too: a snapshot copy of a changed
  // source would otherwise enumerate its own test twin as a related test.
  // Same config context as the step being narrowed (entry.body is the script).
  const listIgnore = resolveJestIgnoreInjection(entry.body);
  const listCommand = listIgnore ? `${fast.listCommand} ${listIgnore}` : fast.listCommand;
  let listed;
  try {
    listed = execSync(listCommand, {
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

  entry.command = runTestsByPathCommand({ env: fast.env, bin: fast.bin, flags: fast.flags, files: related, ignore: listIgnore });
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
    // A configured RAW command IS the command: ignore args append directly
    // (no package-manager passthrough). The single-jest boundary still holds —
    // a compound configured command is left byte-for-byte alone.
    const rawInjected = maybeInjectJestIgnore({
      command: effectiveStep.command,
      body: effectiveStep.command,
      pm: "direct",
      ignoreArgs: resolveJestIgnoreInjection(effectiveStep.command),
    });
    // Record WHY injection was skipped. Without it the plan preamble falls
    // through to "jest runs exclude <rootDir>/.pi/" whenever showConfig merely
    // succeeded — claiming an exclusion this run does not actually have.
    if (!rawInjected.injected && rawInjected.reason && !jestIgnoreNote) jestIgnoreNote = rawInjected.reason;
    entry = { name: "test", command: rawInjected.command, idx, source: "config" };
    plan.push(entry);
  } else if (typeof effectiveStep.script === "string" && effectiveStep.script !== "") {
    const scripts = pkg?.scripts ?? {};
    if (typeof scripts[effectiveStep.script] === "string") {
      const configuredTestBody = scripts[effectiveStep.script];
      const scriptInjected = maybeInjectJestIgnore({
        command: `${runPrefix} ${effectiveStep.script}`,
        body: configuredTestBody,
        pm,
        ignoreArgs: resolveJestIgnoreInjection(configuredTestBody),
      });
      if (!scriptInjected.injected && scriptInjected.reason && !jestIgnoreNote) jestIgnoreNote = scriptInjected.reason;
      entry = { name: "test", command: scriptInjected.command, idx, source: "config" };
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

// ---- plan preamble: what this run is ABOUT to do ----
//
// Written BEFORE the first check starts, because this log is the only live
// window into a detached runner: the extension tails this file and forwards
// it, so an empty log until the first step finished meant a run that looked
// hung for minutes. Steps skipped (no script, configured skip) are listed
// too — knowing a check does NOT run is as useful as knowing it does.
//
// `--json` mode stays PURE JSON on stdout (a caller parses it), so the
// preamble is suppressed there — the extension does not use --json.
if (!asJson) {
  console.log(`# Precommit plan (${mode}) — ${runnable.length} step(s) to run`);
  for (const s of plan) {
    if (s.command) console.log(`  · ${s.name}: ${s.command}`);
    else console.log(`  · ${s.name}: skipped (${s.reason ?? "no reason recorded"})`);
  }
  if (jestIgnoreNote) console.log(`  · note: ${jestIgnoreNote}`);
  // Claim the exclusion only when the TEST step's own command carries it. Any
  // other step matching the string (a lint script that greps for it, say) would
  // otherwise produce a user-visible claim about a run that never got it.
  else if (plan.some((s) => s.name === "test" && typeof s.command === "string" && s.command.includes("--testPathIgnorePatterns"))) {
    console.log("  · note: jest runs exclude <rootDir>/.pi/ (merged with the repo's own testPathIgnorePatterns)");
  }
  console.log("");
}

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
//
// Fail-fast reaches ACROSS the stages: a failing fix step already decided the
// verdict, and stage 2 would just spend minutes confirming it. Its steps are
// reported as aborted — the same word the killed parallel peers get, because
// it is the same fact: they never ran.
const fixFailed = steps.some((s) => s.name === fix?.name && s.status === "fail");
const toRun = [];
for (const s of runnable) {
  if (s === fix) continue;
  if (fixFailed) {
    abortedSteps.add(s.idx);
    present(s.idx, [`\n⏭ ${s.name} — aborted (${failFastBy ?? fix?.name} failed)`], {
      name: s.name,
      command: s.command,
      status: "skip",
      reason: `aborted — ${failFastBy ?? fix?.name} failed (fail-fast)`,
      durationMs: 0,
      cached: false,
      cacheScope: s.cacheScope,
      tail: "",
    });
    continue;
  }
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
// Say it out loud when the run stopped early: a reader who sees three checks
// and four steps must not have to guess which ones never finished. Only when
// something was ACTUALLY aborted — a failure with no peer left to stop is
// just a failure, and claiming otherwise describes a run that did not happen.
if (failFastBy && abortedSteps.size > 0) {
  stream(`\n⏹ fail-fast: ${failFastBy} failed — ${abortedSteps.size} remaining check(s) aborted, not run.`);
}

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
  // The run stopped at the first failure: say which check ended it, so the
  // aborted steps above read as "never ran", not as "passed".
  if (failFastBy && abortedSteps.size > 0) {
    console.log(`⏹ fail-fast: ${failFastBy} failed — ${abortedSteps.size} remaining check(s) aborted, not run.`);
    console.log("");
  }
  // testScope skipped means the fast lane dropped the test step entirely: a
  // PASS here did NOT execute the test suite. Say so in the human report —
  // silently "PASS" next to a zero-test run is exactly the trap users hit.
  if (testScope === "skipped" && !anyFail && anyRan) {
    console.log("⚠️  WARNING: no tests were run in this lane (no related-test strategy for the test script);");
    console.log("    a `git push` / `gh pr create` still requires a full run that executes the suite.");
    console.log("");
  }
  console.log(overall);
}

// Distinct exit codes so the extension can tell states apart without parsing:
//   0 = PASS, 1 = FAIL, 2 = NO_CHECKS_RUN (NOT a pass), 3 = receipt write error.
process.exit(anyFail ? 1 : anyRan ? 0 : 2);
