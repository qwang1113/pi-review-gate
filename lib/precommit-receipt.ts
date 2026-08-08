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
    return { verdict: "PASS", checksRun: run, checksFailed: failed };
  }
  if (verdict === "FAIL") {
    if (status !== 1) return err(`exit ${status} conflicts with FAIL`);
    if (run === 0) return err("FAIL with zero checks");
    if (failed === 0) return err("FAIL with zero failed checks");
    return { verdict: "FAIL", checksRun: run, checksFailed: failed };
  }
  // NO_CHECKS_RUN
  if (status !== 2) return err(`exit ${status} conflicts with NO_CHECKS_RUN`);
  if (run !== 0) return err("NO_CHECKS_RUN with checks that ran");
  return { verdict: "NO_CHECKS_RUN", checksRun: 0, checksFailed: 0 };
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
