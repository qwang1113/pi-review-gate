/**
 * Gate state machine.
 *
 * State lives in TWO places, deliberately:
 *  1. Session entries via `pi.appendEntry()` — survives context compaction
 *     (PR #7 lesson 7: needed [AUTO_LOOP_RESUME] stdout re-injection
 *     because transcript state died on compact; Pi session entries are
 *     excluded from LLM context and survive compaction natively).
 *  2. A sidecar JSON file `.pi/review-gate-state.json` — so the installed
 *     git pre-commit / pre-push hooks (defense-in-depth layer) can verify the
 *     gate without talking to Pi at all.
 *
 * Fail-closed rules:
 *  - A pass is bound to a worktree fingerprint. Fingerprint mismatch = not passed.
 *  - Unreadable/corrupt sidecar = not passed.
 *  - "No checks run" (precommit NO_CHECKS_RUN) = not passed (PR #7 lesson 3).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeTaskMode, type TaskMode, type TaskModeSource } from "./task-mode.ts";

export type GateVerdict = "PENDING" | "READY" | "BLOCKED" | "NEEDS_HUMAN";
export type PrecommitVerdict = "PASS" | "FAIL" | "NO_CHECKS_RUN" | "NOT_RUN";

/**
 * Code↔doc sync attestation (docSync knob). When a review covers code
 * changes the reviewer must explicitly attest either that docs were
 * meaningfully UPDATED for the behavior change, or that a doc change is
 * NOT_NEEDED. This is deliberately an attestation the INDEPENDENT reviewer
 * makes — a mechanical "a .md file was touched" rule would be satisfied by a
 * trivial one-line append, whereas the reviewer must verify substance.
 */
export type DocSyncAttestation = "UPDATED" | "NOT_NEEDED";
export const DOC_SYNC_ATTESTATIONS: ReadonlySet<string> = new Set<DocSyncAttestation>(["UPDATED", "NOT_NEEDED"]);

/** Valid enum members, used to fail-closed on unknown/forged sidecar verdicts. */
export const GATE_VERDICTS: ReadonlySet<string> = new Set<GateVerdict>(["PENDING", "READY", "BLOCKED", "NEEDS_HUMAN"]);
export const PRECOMMIT_VERDICTS: ReadonlySet<string> = new Set<PrecommitVerdict>(["PASS", "FAIL", "NO_CHECKS_RUN", "NOT_RUN"]);

export interface RoundRecord {
  round: number;
  findingsTotal: number | null; // null = unparseable (PR #7 lesson 2: never fail-open on parse trouble)
  fingerprints: string[]; // finding fingerprints for plateau detection
  /**
   * The recorded verdict for this round. Optional for backward compatibility
   * with older sidecars that predate oscillation detection (absent ⇒ unknown,
   * which conservatively does NOT count toward an oscillation transition).
   */
  verdict?: Exclude<GateVerdict, "PENDING">;
  at: string;
}

export interface GateState {
  schema: 1;
  sessionId: string | null;
  hasCodeChange: boolean;
  hasDocChange: boolean;
  review: {
    verdict: GateVerdict;
    fingerprint: string | null; // worktree fingerprint the verdict is bound to
    at: string | null;
    /**
     * Reviewer's code↔doc attestation from the verdict JSON. Optional for
     * backward compatibility with older sidecars; absent ⇒ no attestation,
     * which is an UNMET requirement when the project enables `docSync`
     * (fail-closed — same philosophy as NO_CHECKS_RUN ≠ PASS).
     */
    docSync?: DocSyncAttestation;
  };
  precommit: {
    verdict: PrecommitVerdict;
    fingerprint: string | null;
    at: string | null;
  };
  rounds: RoundRecord[];
  maxRounds: number;
  bypass: {
    active: boolean;
    reason: string | null;
    at: string | null;
  };
  /** Session-level workflow choice. Absent means not chosen yet; consumers
   * must fail closed by treating it as loop until the user decides. */
  taskMode?: TaskMode;
  /**
   * Who chose taskMode. SECURITY: the git pre-commit hook downgrades to
   * advisory ONLY for a user-chosen explore ("user"); a heuristic
   * auto-selection ("auto") never weakens the hook. Absent ⇒ treated as
   * "auto" (fail-closed — older sidecars keep the full gate).
   */
  taskModeSource?: TaskModeSource;
  /**
   * sd0x-dev-flow R10 ("Think Harder") port: whether the one-shot strategic
   * reset checklist has fired for this state lifetime. Optional so schema-1
   * sidecars written by older versions still validate; absent ⇒ not fired.
   */
  strategicResetFired?: boolean;
  updatedAt: string;
}

export function emptyState(sessionId: string | null, maxRounds: number): GateState {
  return {
    schema: 1,
    sessionId,
    hasCodeChange: false,
    hasDocChange: false,
    review: { verdict: "PENDING", fingerprint: null, at: null },
    precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
    rounds: [],
    maxRounds,
    bypass: { active: false, reason: null, at: null },
    updatedAt: new Date().toISOString(),
  };
}

export function sidecarPath(cwd: string, configDirName = ".pi"): string {
  return join(cwd, configDirName, "review-gate-state.json");
}

export function loadSidecar(path: string): GateState | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as GateState;
    if (parsed?.schema !== 1) return undefined;
    // P0: reject malformed schema-1 payloads (e.g. {"schema":1}).
    if (typeof parsed.hasCodeChange !== "boolean" || typeof parsed.hasDocChange !== "boolean") return undefined;
    // P1 fail-closed: reject unknown/forged verdicts, not merely non-strings.
    // A schema-1 payload carrying precommit.verdict:"READY" (not a real
    // precommit verdict) must be rejected so it can't slip past the if-else
    // chain in unmetRequirements and fail-open.
    if (!parsed.review || !GATE_VERDICTS.has(parsed.review.verdict as string)) return undefined;
    if (!parsed.precommit || !PRECOMMIT_VERDICTS.has(parsed.precommit.verdict as string)) return undefined;
    if (!Array.isArray(parsed.rounds)) return undefined;
    if (!parsed.bypass || typeof parsed.bypass.active !== "boolean") return undefined;
    // Optional field. Unknown values are removed so consumers fall back to
    // the safer loop behavior.
    if (parsed.taskMode !== undefined && normalizeTaskMode(parsed.taskMode) === undefined) {
      delete parsed.taskMode;
    }
    // Unknown source values fail closed to "auto" (never hook-advisory).
    if (parsed.taskModeSource !== undefined && parsed.taskModeSource !== "auto" && parsed.taskModeSource !== "user") {
      delete parsed.taskModeSource;
    }
    // Unknown/forged docSync attestation → treated as absent (fail-closed:
    // absent blocks when the project enforces docSync, never passes).
    if (parsed.review.docSync !== undefined && !DOC_SYNC_ATTESTATIONS.has(parsed.review.docSync as string)) {
      delete parsed.review.docSync;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveSidecar(path: string, state: GateState): void {
  state.updatedAt = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  // Atomic write: temp + rename, so a crashed write can't leave a truncated
  // JSON that a fail-open parser might half-read.
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * The single authority on "may we ship?".
 * Returns the list of unmet requirements (empty = ship allowed).
 */
export function unmetRequirements(
  state: GateState | undefined,
  currentFingerprint: string,
  fingerprintUnavailable: boolean,
  opts?: {
    /**
     * Project knob `docSync` (default ON). When true, a code change additionally
     * requires the READY review to carry a docSync attestation
     * (UPDATED | NOT_NEEDED). The attestation is required on EVERY code
     * change — not only when no doc file was touched — so trivially touching
     * a .md file cannot satisfy the gate: the reviewer must always judge.
     */
    requireDocSync?: boolean;
  },
): string[] {
  if (!state) return ["gate state missing (fail-closed)"];
  if (state.bypass.active) return [];

  const problems: string[] = [];

  if (!state.hasCodeChange && !state.hasDocChange) {
    // Nothing tracked as changed this session. We still verify the review
    // if the worktree is dirty relative to what was reviewed — but with no
    // session changes at all, shipping pre-existing work is allowed.
    return [];
  }

  if (fingerprintUnavailable) {
    problems.push("worktree fingerprint unavailable (git unreadable) — cannot verify gate binding");
    return problems;
  }

  if (state.hasCodeChange) {
    // Fail-closed: only an explicit READY bound to the current fingerprint passes.
    // (Any non-READY value — including an unknown/forged one — falls here.)
    if (state.review.verdict !== "READY") {
      problems.push(`code review gate is ${state.review.verdict} (need READY)`);
    } else if (state.review.fingerprint !== currentFingerprint) {
      problems.push("code was modified after the last READY review (fingerprint mismatch)");
    } else if (opts?.requireDocSync && state.review.docSync === undefined) {
      // Fail-closed: enforcement is on and the READY review carries no
      // attestation (older review, or reviewer omitted the field) → unmet.
      problems.push(
        "docSync enforced: READY review lacks a code↔doc attestation — the reviewer verdict JSON " +
        'must include "docSync": "UPDATED" | "NOT_NEEDED"; re-run the independent review',
      );
    }

    // Fail-closed: only an explicit PASS bound to the current fingerprint is a
    // pass. Anything else — NOT_RUN, FAIL, NO_CHECKS_RUN, or an unknown/forged
    // verdict — blocks. The default branch guards against a value that somehow
    // bypassed the loader enum check.
    if (state.precommit.verdict === "PASS") {
      if (state.precommit.fingerprint !== currentFingerprint) {
        problems.push("code was modified after the last precommit PASS (fingerprint mismatch)");
      }
    } else if (state.precommit.verdict === "NOT_RUN") {
      problems.push("precommit has not run");
    } else if (state.precommit.verdict === "FAIL") {
      problems.push("precommit FAILED");
    } else if (state.precommit.verdict === "NO_CHECKS_RUN") {
      // PR #7 lesson 3: all-steps-skipped is NOT a pass.
      problems.push("precommit ran zero checks (NO_CHECKS_RUN ≠ PASS) — configure real checks or use /gate-bypass");
    } else {
      problems.push(`precommit verdict unrecognized (${String(state.precommit.verdict)}) — fail-closed`);
    }
  }

  if (state.hasDocChange && !state.hasCodeChange) {
    if (state.review.verdict !== "READY") {
      problems.push(`doc review gate is ${state.review.verdict} (need READY)`);
    } else if (state.review.fingerprint !== currentFingerprint) {
      problems.push("docs were modified after the last READY review (fingerprint mismatch)");
    }
  }

  return problems;
}

/**
 * sd0x-dev-flow R10 "Think Harder" firing predicate (pure, unit-tested).
 * The one-shot [STRATEGIC_RESET] checklist fires only when ALL hold:
 *  - the project has thinkHarder enabled;
 *  - it has not fired for this state lifetime;
 *  - the review loop is actually stuck (verdict BLOCKED — not READY awaiting
 *    precommit, not PENDING before a first review, not NEEDS_HUMAN which
 *    already escalated);
 *  - the round count is within `offset` rounds of the cap.
 * The CALLER sets strategicResetFired and persists it when this returns true.
 */
export function shouldStrategicReset(
  state: GateState,
  thinkHarder: boolean,
  offset: number,
): boolean {
  if (!thinkHarder) return false;
  if (state.strategicResetFired) return false;
  if (state.review.verdict !== "BLOCKED") return false;
  const threshold = Math.max(1, state.maxRounds - offset);
  return state.rounds.length >= threshold;
}

/**
 * Oscillation detection (pure, unit-tested). Counts READY→BLOCKED transitions
 * across the recorded rounds: a round whose verdict is BLOCKED and whose
 * immediately preceding round with a known verdict was READY. When this count
 * reaches `limit` the review loop is thrashing (the reviewer keeps finding NEW
 * problems after signalling READY) rather than converging.
 *
 * Rounds with an absent verdict (older sidecars) are skipped when looking for
 * the preceding verdict, so a legacy tail never fabricates a transition.
 * Tighten-only: the caller uses a true result solely to DISARM the auto-loop
 * and escalate — it never permits a ship.
 */
export function countOscillations(rounds: RoundRecord[]): number {
  let count = 0;
  let prevKnown: Exclude<GateVerdict, "PENDING"> | undefined;
  for (const r of rounds) {
    if (r.verdict === undefined) continue; // legacy round: cannot judge
    if (r.verdict === "BLOCKED" && prevKnown === "READY") count++;
    prevKnown = r.verdict;
  }
  return count;
}

export function isOscillating(rounds: RoundRecord[], limit: number): boolean {
  return countOscillations(rounds) >= limit;
}

/** Plateau detection: same findings recurring across N rounds without shrinking. */
export function isPlateaued(rounds: RoundRecord[], windowSize: number): boolean {
  if (rounds.length < windowSize) return false;
  const window = rounds.slice(-windowSize);
  // total must be non-decreasing across the window
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1].findingsTotal;
    const cur = window[i].findingsTotal;
    if (prev === null || cur === null) return false; // unparseable → rely on hard cap
    if (cur < prev) return false;
  }
  // fingerprint overlap >= 50% between consecutive rounds
  for (let i = 1; i < window.length; i++) {
    const a = new Set(window[i - 1].fingerprints);
    const b = window[i].fingerprints;
    if (a.size === 0 || b.length === 0) return false;
    const overlap = b.filter((f) => a.has(f)).length / b.length;
    if (overlap < 0.5) return false;
  }
  return true;
}
