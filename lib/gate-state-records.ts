/**
 * The record shapes the gate state is built from — verdict vocabularies,
 * round records, the parked READY, the binding blocks and the proxy-decision
 * record — with the small sanitizers that validate them.
 *
 * Split out of lib/gate-state.ts, which keeps the `GateState` interface itself.
 */

import type { TestScope } from "./precommit-receipt.ts";
// The round's audit stamp is the CHANNEL's stamp: one shape, one validator.
import { sanitizeScopeStamp } from "./channel-projection.ts";
import type { ReviewScopeStamp } from "./channel-records.ts";

export type GateVerdict = "PENDING" | "READY" | "BLOCKED" | "NEEDS_HUMAN";
export type PrecommitVerdict = "PASS" | "FAIL" | "NO_CHECKS_RUN" | "NOT_RUN";

/** The two precommit lanes. See scripts/precommit-runner.mjs for what each runs. */
export type PrecommitMode = "fast" | "full";
export const PRECOMMIT_MODES: ReadonlySet<string> = new Set<PrecommitMode>(["fast", "full"]);

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

/**
 * One side of a round's scope record.
 *
 * It IS the channel's wire stamp (`ReviewScopeStamp`), aliased rather than
 * re-declared: the judge's half of this record arrives straight off a channel
 * report, and a second structurally-identical type is how the two ends of one
 * value drift apart.
 */
export type ScopeStampRecord = ReviewScopeStamp;

/** Both sides of the audit pair — what the gate sent, what the judge reported. */
export interface RoundScopeRecord {
  /** Registered by the gate when it prepared and dispatched this round. */
  dispatched?: ScopeStampRecord;
  /** Stamped by the judge on the report that closed this round. */
  reported?: ScopeStampRecord;
}

/**
 * Keep only what is a recognisable scope pair; drop everything else.
 *
 * Each half goes through the CHANNEL's own stamp sanitizer — the same
 * function that validates a stamp arriving on a report — so a sidecar and a
 * channel record can never disagree about what a valid stamp is. A pair with
 * neither half left becomes `undefined`, because an empty `scope` object
 * would read as "this round recorded its scope" when it recorded nothing.
 */
export function sanitizeRoundScope(raw: unknown): RoundScopeRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as { dispatched?: unknown; reported?: unknown };
  const dispatched = sanitizeScopeStamp(value.dispatched);
  const reported = sanitizeScopeStamp(value.reported);
  if (dispatched === undefined && reported === undefined) return undefined;
  return {
    ...(dispatched === undefined ? {} : { dispatched }),
    ...(reported === undefined ? {} : { reported }),
  };
}

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
  /**
   * Files that had P2/Nit findings this round (round-18 polish gate).
   * Absent on older sidecars ⇒ treated as empty (never triggers).
   */
  polishFiles?: string[];
  /** Files that had P0/P1 findings this round (resets a file's streak). */
  blockingFiles?: string[];
  /**
   * WHICH SCOPE THIS ROUND RAN UNDER — kept so a finished round stays legible
   * after the fact ("was it incremental, and over what range?") without the
   * channel file having to still exist.
   *
   * TWO HALVES ON PURPOSE. `dispatched` is what the GATE registered when it
   * prepared the round; `reported` is what the JUDGE stamped on its own report
   * (lib/judge-inspection.ts reads it back out of the task text). Both trace
   * back to the same gate-written text, so their AGREEING says nothing about
   * how the round was read — whether it inspected anything at all is the
   * report's own `inspection` record, and how well it read is the verdict
   * itself. Their DISAGREEING is what this pair
   * catches: a judge answering with another round's task text, or a pane on a
   * different build. Nothing acts on it — this is a record, not a rule.
   *
   * Optional, and every part of it optional: sidecars written before this
   * field exists stay readable, and a round whose scope was never computed
   * (any pre-checkpoint audit) records none.
   */
  scope?: RoundScopeRecord;

}

/**
 * A READY review the gate is HOLDING until its content's full-lane precommit
 * lands (2026-09-15).
 *
 * WHY THE GATE HOLDS INSTEAD OF REFUSING. `judge_submit` runs the full
 * precommit BESIDE the review rather than in front of it (B1, 2026-09-10), so a
 * fast reviewer can conclude before the suite is done — measured on this
 * repository (PR #62, round 4): a three-line incremental round concluded in
 * 16s against a 34s full lane, seven seconds short. The old reading wrote that
 * as BLOCKED, permanently, and precommit PASSed seven seconds later with
 * nobody to revisit it: the agent was told to "fix ALL findings and re-review"
 * on a round whose only finding was a Nit saying nothing had changed, and its
 * only way forward was a whole extra review of byte-identical content.
 *
 * The rule itself is right — content that never passed the full lane must not
 * be recorded READY — but "we do not know yet" is not "it failed". So the
 * conclusion is parked here VERBATIM and the lane's own landing revisits it:
 * a PASS on this tree replays the conclusion through the SAME recorder (there
 * is one implementation of "record a READY"), a non-PASS clears it and the
 * failure channel says why. While it is parked `review` stays PENDING, so
 * nothing can ship on it and no reader sees a verdict that was never made.
 *
 * WHY THE WHOLE CONCLUSION AND NOT A FLAG: the replay has to produce exactly
 * what the normal order would have produced (findings count, fingerprints,
 * docSync attestation, cwd check), and re-deriving any of those from a summary
 * would be a second implementation of the recording rules.
 */
export interface PendingReadyReview {
  /** The reviewer's conclusion, exactly as it arrived — replayed verbatim. */
  conclusion: {
    verdict: string;
    findings: unknown[];
    cwd?: string;
    docSync?: string;
    /**
     * The judge's own `scope` (round-1 P2, 2026-09-15). The recorder writes it
     * beside what the gate dispatched (`sanitizeRoundScope`), so dropping it
     * here would make a replayed round's audit pair differ from a straight one
     * — the exact kind of divergence "replayed through the SAME recorder" is
     * supposed to rule out.
     */
    scope?: unknown;
  };
  /** The tree this round judged (from the prepared review target). */
  tree: string;
  /** The HEAD at record time — the commit the READY will bind to. */
  head: string;
  /** The round it belongs to (1-based, for the notice). */
  round: number;
  /** When the reviewer concluded. */
  at: string;
}

/**
 * Is this really a parked conclusion? Fail-closed: anything that is not the
 * exact shape is DROPPED by {@link loadSidecar} rather than replayed.
 *
 * A parked READY is replayed through the normal recorder, so a forged or
 * half-written record would be a forged verdict — the one thing the sidecar's
 * other shape checks exist to prevent. Only `READY` is ever parked (the other
 * withholding reasons refuse the round outright), which is why the verdict
 * field is checked for that exact value.
 */
export function isPendingReadyReview(raw: unknown): raw is PendingReadyReview {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  const detail = record.conclusion;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return false;
  const conclusion = detail as Record<string, unknown>;
  if (conclusion.verdict !== "READY") return false;
  if (!Array.isArray(conclusion.findings)) return false;
  return typeof record.tree === "string" && record.tree.length > 0 &&
    typeof record.head === "string" && record.head.length > 0 &&
    typeof record.at === "string" && record.at.length > 0 &&
    typeof record.round === "number" && Number.isFinite(record.round);
}

/** The shape of `GateState.checkpoint` (see the field for what it means). */
export type CheckpointRecord = {
  sha: string;
  prevSha: string;
  at: string;
  /**
   * This round reached the checkpoint WITHOUT a precommit PASS, on the
   * user's `/gate-bypass` authorization (R-22).
   *
   * Recorded so the fact survives the round: the reviewer is told, and
   * `declare_done` repeats it. A bypass the user granted is legitimate; a
   * bypass nobody can see afterwards is not.
   */
  precommitBypassed?: boolean;
};

/** The shape of `GateState.completion` (see the field for what it means). */
export type CompletionRecord = {
  at: string;
  /** How the work branch landed — merged, waived, or nothing to merge. */
  merge: "merged" | "waived" | "none";
  /** The one-paragraph summary the agent declared with (bounded). */
  summary?: string;
};

/** The shape of `GateState.review` — the recorded review verdict and its binding. */
export type ReviewBinding = {
  verdict: GateVerdict;
  fingerprint: string | null; // worktree fingerprint the verdict is bound to
  /**
   * Round-9 P1: the COMMIT sha the READY was bound to (the reviewed HEAD at
   * record time). prepare_review uses it as the incremental baseline so a
   * chain of checkpoints since the last READY is ALL covered by the next
   * range; absent on older sidecars (fall back to checkpoint.prevSha).
   */
  commitSha?: string;
  at: string | null;
  /**
   * Reviewer's code↔doc attestation from the verdict JSON. Optional for
   * backward compatibility with older sidecars; absent ⇒ no attestation,
   * which is an UNMET requirement when the project enables `docSync`
   * (fail-closed — same philosophy as NO_CHECKS_RUN ≠ PASS).
   */
  docSync?: DocSyncAttestation;
};

/** The shape of `GateState.lastReviewedTree` (see the field for what it means). */
export type LastReviewedTree = {
  treeOid: string;
  files?: string[];
  at: string;
  /**
   * The verdict of the round this tree was reviewed in. Only the three
   * recorded words are accepted (a tampered or unknown value drops the
   * whole field, which buys a full review — fail-closed).
   */
  verdict: string;
};

/** The shape of `GateState.precommit` — the recorded precommit verdict and its binding. */
export type PrecommitBinding = {
  verdict: PrecommitVerdict;
  fingerprint: string | null;
  at: string | null;
  /**
   * Which lane produced this verdict (`run_precommit --mode`). Diagnostics
   * and timing attribution only — the ship decision reads `testScope`,
   * which states what was actually covered rather than what was requested.
   * Absent on sidecars written before the split.
   */
  mode?: PrecommitMode;
  /**
   * How much of the runnable test suite that run covered. This IS part of
   * the ship decision: a push / PR requires `"full"`, so a fast lane that
   * narrowed the suite to the changed files cannot authorize one.
   *
   * Absent ⇒ unknown ⇒ treated as NOT full (fail-closed): an older sidecar
   * predates the guarantee, so it cannot be read as providing it.
   */
  testScope?: TestScope;
  /**
   * The tree of the last FULL-lane PASS — a HISTORICAL FACT, not a binding
   * (2026-09-14).
   *
   * WHY IT EXISTS. `fingerprint` is a live binding: the session's own edit
   * downgrades `verdict` and clears it (`invalidateBindings`), because the
   * PASS no longer describes what is on disk. That is correct — but the
   * round being RECORDED is about an immutable commit, and recording its
   * READY used to consult that live field, so an agent doing the documented
   * thing (keep editing while the review runs) turned a genuine READY into
   * BLOCKED/UNVERIFIED, with a message telling it to fix a precommit that
   * never failed. This field survives the edit, because the content that
   * passed is still that content: a git tree OID is a content identity, so
   * "the tree under review equals a tree a full lane passed" is a fact that
   * does not expire.
   *
   * WHAT MAY WRITE IT (lib/gate-state-transitions.ts `nextFullPassTree`, the only
   * rule): a full lane's PASS, citing the tree captured BEFORE that lane
   * started — never the runner's post-run recomputation, which the code
   * already documents as possibly belonging to the next round's content.
   * A FAIL of that SAME tree revokes it: the claim is about the content, and
   * the content has now been disproven.
   *
   * Absent ⇒ never recorded (old sidecars included): the READY check then
   * falls back to the live verdict, exactly as it did before.
   */
  lastFullPassTree?: string;
};

/**
 * ONE DECISION THE PROXY MADE ON THE USER'S BEHALF, as the state records it.
 *
 * Declared on its own rather than inline on the field because a second consumer
 * exists: `mergeProxyDecisions` below unions two sessions' lists (review round
 * 6), and `lib/user-proxy.ts` renders them for the completion report.
 */
export interface ProxyDecisionRecord {
  at: string;
  /** The dialog's own question, verbatim (its title). */
  question: string;
  /** The rows it chose from, verbatim. */
  options: string[];
  /** The row the proxy chose — one of `options`, verbatim. */
  choice: string;
  /** Why, in the proxy's own words. */
  rationale: string;
  /**
   * The session whose dialog it answered. The list is a UNION across sessions
   * (see below), so `declare_done` reports only its own session's entries by
   * this id (2026-09-23: a completion report listed four decisions from a task
   * finished days earlier). Absent on records written before the field existed.
   */
  sessionId?: string;
}
