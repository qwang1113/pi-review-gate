/**
 * Pure validation of a precommit receipt (P1/P2 trust boundary).
 *
 * The run_precommit tool spawns the trusted runner, which writes a nonce-stamped
 * receipt. This module decides, from the receipt + the spawn result, whether the
 * run is a genuine PASS/FAIL/NO_CHECKS_RUN or a protocol ERROR. Everything here
 * is pure so it can be exhaustively unit-tested against the contradiction table.
 *
 * Trust rule (fail-closed): FAIL and NO_CHECKS_RUN are legitimate runner
 * OUTCOMES; a protocol contradiction (exit/verdict/count mismatch, bad schema,
 * wrong nonce/cwd/mode, crash, non-integer counts) is ERROR, never silently
 * downgraded to a business verdict.
 */

export type PrecommitVerdict = "PASS" | "FAIL" | "NO_CHECKS_RUN" | "ERROR";

/**
 * How much of the project's RUNNABLE test suite a run covered.
 *
 *  - `full`    nothing was narrowed away (including repos with no runnable
 *              tests: a full run would cover the same empty set);
 *  - `related` the fast lane ran only the tests related to the changed files;
 *  - `skipped` a runnable suite exists but the fast lane could not derive a
 *              related set, so the test step was dropped.
 *
 * The ship gate requires `full` for a push / PR, so this value is part of the
 * trust boundary and is validated like every other receipt field.
 */
export const TEST_SCOPES = Object.freeze(["related", "full", "skipped"] as const);
export type TestScope = (typeof TEST_SCOPES)[number];

export interface ReceiptExpectation {
  nonce: string;
  cwd: string;
  mode: "fast" | "full";
  /** spawn exit status (null if the process was killed by a signal). */
  exitStatus: number | null;
  /** spawn signal, if any (non-null ⇒ crash ⇒ ERROR). */
  signal: NodeJS.Signals | null;
  /** true if spawnSync returned an error (spawn failure). */
  spawnError: boolean;
}

export interface ReceiptResult {
  verdict: PrecommitVerdict;
  checksRun: number;
  checksFailed: number;
  /** Present only for a non-ERROR verdict; ERROR carries no trusted scope. */
  testScope?: TestScope;
  error?: string;
}

function err(error: string): ReceiptResult {
  return { verdict: "ERROR", checksRun: 0, checksFailed: 0, error };
}

/**
 * Validate a parsed receipt object against the expectation. Returns the trusted
 * verdict, or ERROR for any contradiction. Does NOT touch the filesystem.
 */
export function validatePrecommitReceipt(
  parsed: unknown,
  exp: ReceiptExpectation,
): ReceiptResult {
  if (exp.spawnError) return err("runner spawn failed");
  if (exp.signal) return err(`runner killed by signal ${exp.signal}`);
  if (typeof parsed !== "object" || parsed === null) return err("receipt not an object");
  const r = parsed as Record<string, unknown>;

  if (r.schema !== 1) return err("receipt schema mismatch");
  if (r.nonce !== exp.nonce) return err("receipt nonce mismatch (replay/forgery)");
  if (r.cwd !== exp.cwd) return err("receipt cwd mismatch");
  if (r.mode !== exp.mode) return err("receipt mode mismatch");

  const verdict = r.verdict;
  if (verdict !== "PASS" && verdict !== "FAIL" && verdict !== "NO_CHECKS_RUN") {
    return err(`receipt verdict invalid (${String(verdict)})`);
  }

  // `testScope` decides whether this PASS may later authorize a push/PR, so a
  // missing, unknown or self-contradictory value is a protocol ERROR rather
  // than something to interpret generously. A `full` run can only ever report
  // `full`: it never narrows a suite, and a repo with no runnable tests still
  // reports `full` because a full run would cover the same empty set.
  const scope = r.testScope;
  if (typeof scope !== "string" || !(TEST_SCOPES as readonly string[]).includes(scope)) {
    return err(`receipt testScope invalid (${String(scope)})`);
  }
  if (exp.mode === "full" && scope !== "full") {
    return err(`receipt testScope ${scope} contradicts mode full`);
  }
  const testScope = scope as TestScope;

  const checksRun = r.checksRun;
  const checksFailed = r.checksFailed;
  if (!Number.isSafeInteger(checksRun) || (checksRun as number) < 0) return err("checksRun not a safe non-negative integer");
  if (!Number.isSafeInteger(checksFailed) || (checksFailed as number) < 0) return err("checksFailed not a safe non-negative integer");
  const run = checksRun as number;
  const failed = checksFailed as number;
  if (failed > run) return err("checksFailed > checksRun");

  // Exit status must exactly match the verdict (runner contract: 0/1/2).
  //   0 = PASS, 1 = FAIL, 2 = NO_CHECKS_RUN, 3 = receipt write error (never here).
  const status = exp.exitStatus;

  if (verdict === "PASS") {
    if (status !== 0) return err(`exit ${status} conflicts with PASS`);
    if (run === 0) return err("PASS with zero checks");
    if (failed !== 0) return err("PASS with failed checks");
    return { verdict: "PASS", checksRun: run, checksFailed: failed, testScope };
  }
  if (verdict === "FAIL") {
    if (status !== 1) return err(`exit ${status} conflicts with FAIL`);
    if (run === 0) return err("FAIL with zero checks");
    if (failed === 0) return err("FAIL with zero failed checks");
    return { verdict: "FAIL", checksRun: run, checksFailed: failed, testScope };
  }
  // NO_CHECKS_RUN
  if (status !== 2) return err(`exit ${status} conflicts with NO_CHECKS_RUN`);
  if (run !== 0) return err("NO_CHECKS_RUN with checks that ran");
  return { verdict: "NO_CHECKS_RUN", checksRun: 0, checksFailed: 0, testScope };
}

/** Longest step name echoed back; runner names are short, this is anti-abuse. */
const MAX_STEP_NAME = 80;
/** Upper bound on echoed names, so a pathological receipt cannot flood a reply. */
const MAX_FAILED_STEPS = 20;

/**
 * Names of the steps that FAILED, for diagnostics only.
 *
 * Deliberately separate from validatePrecommitReceipt(): that function owns the
 * verdict and its contradiction table, and nothing here may influence it. This
 * one is pure presentation — it answers "which check should I look at?" so the
 * agent can open the run log at the right place instead of guessing.
 *
 * Only NAMES are returned. Step output (`tail`) is attacker-controlled in the
 * mundane sense that any test can print anything, so it is never inlined into a
 * tool reply; the full text lives in the run log, which the agent reads itself.
 * Names are still truncated and capped: a receipt is trusted for its nonce, not
 * for its shape.
 */
export function failedStepNames(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const steps = (parsed as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) return [];
  const names: string[] = [];
  for (const step of steps) {
    if (names.length >= MAX_FAILED_STEPS) break;
    if (typeof step !== "object" || step === null) continue;
    const s = step as Record<string, unknown>;
    if (s.status !== "fail") continue;
    const raw = typeof s.name === "string" && s.name.trim() ? s.name.trim() : "(unnamed step)";
    // Strip control characters (including newlines): these names are echoed
    // into a single-line tool reply.
    names.push(raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, MAX_STEP_NAME));
  }
  return names;
}

/** One step's timing line, as recorded in `.pi/gate-timings.jsonl`. */
export interface StepTiming {
  name: string;
  status: string;
  durationMs: number;
  cached: boolean;
}

/** Upper bound on recorded steps: a receipt is trusted for its nonce, not its shape. */
const MAX_TIMED_STEPS = 40;

/**
 * Per-step timings for the observability log.
 *
 * Diagnostics only — nothing here influences a verdict, so a malformed field
 * is normalized (unknown status, 0ms) rather than rejected. That keeps a
 * partially-written receipt from costing the run its timing record.
 */
export function stepTimings(parsed: unknown): StepTiming[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const steps = (parsed as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) return [];
  const out: StepTiming[] = [];
  for (const step of steps) {
    if (out.length >= MAX_TIMED_STEPS) break;
    if (typeof step !== "object" || step === null) continue;
    const s = step as Record<string, unknown>;
    const name = typeof s.name === "string" && s.name.trim() ? s.name.trim() : "(unnamed step)";
    out.push({
      name: name.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, MAX_STEP_NAME),
      status: typeof s.status === "string" ? s.status.slice(0, 16) : "unknown",
      durationMs: Number.isFinite(s.durationMs) ? Math.max(0, Math.round(s.durationMs as number)) : 0,
      cached: s.cached === true,
    });
  }
  return out;
}

/** Wall clock the runner measured for the whole run, or 0 when unavailable. */
export function receiptTotalMs(parsed: unknown): number {
  if (typeof parsed !== "object" || parsed === null) return 0;
  const total = (parsed as Record<string, unknown>).totalMs;
  return Number.isFinite(total) ? Math.max(0, Math.round(total as number)) : 0;
}
