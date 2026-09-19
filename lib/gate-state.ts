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

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic-write.ts";
import { normalizeTaskMode, type TaskMode, type TaskModeSource } from "./task-mode.ts";
import { normalizeRuntime } from "./orchestrator-registry.ts";
import { normalizeNotifyHistory } from "./user-notify.ts";
import { normalizeOrchestrationId } from "./orchestration-id.ts";
import { FINGERPRINT_VERSION } from "./fingerprint.ts";
import { sanitizeCopilotState, type CopilotReviewState } from "./copilot-review.ts";
import { restatementHash, type RestatementRecord } from "./restatement.ts";
import { isDeliveryStation } from "./delivery-station.ts";
import { SHIP_COMMAND_KINDS, type ShipCommandKind } from "./constants.ts";

import type { GoalPrereviewRecord, LoopGoalConfirmation } from "./loop-goal.ts";
import type { QualityRecord } from "./quality-round.ts";
import type { PlanAuditRecord } from "./orchestrator-plan-audit.ts";

import { TEST_SCOPES, type TestScope } from "./precommit-receipt.ts";
// The round's audit stamp is the CHANNEL's stamp: one shape, one validator.
import { sanitizeScopeStamp, type ReviewScopeStamp } from "./orchestrator-channel.ts";

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

export interface GateState {
  schema: 1;
  /**
   * Algorithm version of the digests in `review.fingerprint` /
   * `precommit.fingerprint` (see FINGERPRINT_VERSION). Optional because
   * sidecars written before versioning have none — those are treated as v1 and
   * their bindings are invalidated on load, never reinterpreted.
   *
   * This is deliberately NOT the `schema` field: the sidecar SHAPE is
   * unchanged, so bumping `schema` would make older hooks reject the file
   * outright ("unknown gate schema") instead of reporting a migration.
   */
  fingerprintVersion?: number;
  sessionId: string | null;
  /**
   * Set when ANOTHER live session holds this worktree — the refusal text,
   * verbatim (lib/session-exclusivity.ts decides it).
   *
   * IN MEMORY ONLY, and that is load-bearing rather than tidy: a refused
   * session must not write this worktree's sidecar at all — the file belongs
   * to the session that holds it, and persisting a refusal into it would tell
   * the HOLDER that its own worktree is taken. `saveSidecar` strips the field
   * as a second line of defence.
   *
   * It lives on the state, rather than beside it, because that is what reaches
   * `unmetRequirements` — the one authority every ship path already shares.
   */
  exclusivityRefusal?: string;

  /**
   * The last review_checkpoint commit (sha + wall-clock time). The review
   * unit of the new execution model: prepare_review computes baseline..HEAD
   * against this, and the verdict recorder binds a READY to the reviewed commit's
   * tree. Written only by review_checkpoint; absent before the first one.
   */
  checkpoint?: {
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

  /**
   * The COMPLETION record — `declare_done` was accepted (R3-5).
   *
   * It exists because a supervisor could not tell a finished child from a
   * running one: the orchestration probe was reduced to reading the child's
   * TERMINAL, where "Working" printed an hour ago still matched, and a child
   * that had merged its branch and closed every gate produced no signal for
   * 725 seconds. The gate already knew — it had just accepted the completion
   * — and wrote that fact nowhere. Now it does, in the child's own sidecar,
   * which the orchestrator reads through `childGateState`.
   *
   * Written on ACCEPTANCE only (a rejected `declare_done` records nothing),
   * and never cleared by the loop reset below it: "this task was completed at
   * T" stays true even when the session goes on to do something else.
   */
  completion?: {
    at: string;
    /** How the work branch landed — merged, waived, or nothing to merge. */
    merge: "merged" | "waived" | "none";
    /** The one-paragraph summary the agent declared with (bounded). */
    summary?: string;
  };
  hasCodeChange: boolean;
  hasDocChange: boolean;
  review: {
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
  /**
   * THE QUALITY ROUND's standing verdict (2026-09-15, user requirement).
   *
   * The quality judge runs BETWEEN `prepare` and the functional reviewer, and
   * `lib/quality-round.ts`'s `qualityStandingFor` is the ONE reader that
   * decides whether the reviewer may be dispatched: a READY bound to the
   * current HEAD, or a recorded SKIP (nothing but docs/data changed) —
   * everything else, including an absent record, fails closed.
   *
   * Absent is NORMAL, not an error: the whole point is that a session which
   * never ran a quality round cannot reach the reviewer. Nothing but a
   * finished quality round writes it, and `invalidateBindings` clears a READY
   * the moment the session edits — the content it judged is gone.
   */
  quality?: QualityRecord;
  /**
   * The READY the gate is holding until its verification lands (2026-09-15).
   *
   * Absent is the normal state: it exists only in the window between a
   * reviewer concluding faster than its full lane and that lane landing. While
   * it is set, `review` stays PENDING — nothing ships on a verdict that has
   * not been made yet.
   */
  pendingReady?: PendingReadyReview;
  /**
   * The last READY review's git tree and the files it covered.
   *
   * Kept OUTSIDE `review` on purpose: `review` is replaced wholesale by every
   * verdict, so a single BLOCKED round would erase the very baseline the next
   * round needs. This survives until a new READY replaces it.
   *
   * DIAGNOSTIC INPUT ONLY — it feeds the incremental-review scope
   * (lib/review-scope.ts) and never the ship decision, which stays bound to
   * `review.fingerprint` alone. `review.fingerprint` cannot serve this role:
   * it mixes submodule digests in, so it is not a git object and cannot be
   * diffed. Absent ⇒ the next round is a full review (fail-safe).
   */
  /**
   * Worktree tree OID at the last `prepare_adviser` call for this repo, keyed
   * by goal hash.
   *
   * Lets the NEXT adviser consultation of the SAME goal be told what changed
   * since the previous one (goal criterion 3: incremental advisory), without
   * a consultation of a DIFFERENT goal overwriting the baseline. It is
   * DIAGNOSTIC INPUT only, like `lastReviewedTree` — it never feeds the ship
   * decision. Absent ⇒ the next consultation gets an empty changed-files
   * list and treats the previous conclusion as still standing.
   */
  /**
   * Per-goal advisory baseline: the worktree tree the changed-files list of
   * the NEXT consultation is computed against. `tree` is the tree at the
   * last consultation START (optimistic); `prevTree` is the last CONFIRMED
   * consultation start (rollback target — a consultation that never appended
   * a conclusion must not hide its changes, round-3 P1) or null when NO
   * consultation is confirmed yet (cross-session first advance: the old
   * artifact's conclusions are NOT proof the current one succeeded — the
   * next round then falls back to a full re-check, round-4 P1); `confirmed`
   * is the number of valid conclusions the artifact held when the baseline
   * last advanced.
   */
  adviserBaselines?: Record<string, { tree: string; prevTree: string | null; confirmed: number }>;
  /**
   * THE LAST TREE A REVIEW ROUND CONCLUDED ABOUT (2026-09-19), and the verdict
   * it concluded WITH.
   *
   * This was `lastReadyReview`, written on READY alone — so a round that
   * concluded BLOCKED left no trace of what it had read, and the next
   * `prepare_review` fell back to the branch base and re-reviewed the entire
   * branch. Measured in prime on 2026-09-19: t1-prime-encrypt ran three full
   * deep reviews back to back (15 + 15 + 6 minutes) over the same 65-file
   * diff, because its very first round concluded BLOCKED and the field stayed
   * empty.
   *
   * TWO CONSUMERS, TWO DIFFERENT QUESTIONS — which is why the verdict rides
   * along instead of the field being split in two:
   *   - `reviewScopeFor` asks "what has this session already READ?" — any
   *     concluded round answers that, and `lib/review-scope.ts`'s own
   *     `unreviewedFiles` escalation still forces a FULL round whenever the
   *     increment touches a file the previous round never saw;
   *   - `settledConclusion` asks "what has this session CONFIRMED?" — only a
   *     READY answers that. Handing a BLOCKED tree to the next reviewer as
   *     settled would tell it to skip precisely the content the previous
   *     round refused.
   *
   * The RANGE baseline is untouched by this field: `st.review.commitSha` still
   * moves only when the quality half concluded (`qualityStandingFor`), so a
   * round whose quality judge was cancelled keeps its content inside every
   * later range. Only the DEPTH of the next round reads this tree.
   *
   * DIAGNOSTIC INPUT otherwise, like `adviserBaselines` — it never feeds the
   * ship decision.
   */
  lastReviewedTree?: {
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
  /**
   * EVERY DECISION THE PROXY MADE ON THE USER'S BEHALF (2026-09-19), oldest
   * first.
   *
   * The user leaves, and the gate's dialogs used to wait forever — a session
   * parked on a plan decision, another on a goal approval, with the machine
   * idle. Now a dialog that goes unanswered for `PROXY_ANSWER_TIMEOUT_MS` is
   * handed to `arbiter`, which reads the session's own context and takes the
   * user's place (lib/user-proxy.ts).
   *
   * THIS RECORD IS THE WHOLE SAFETY STORY. Downstream, a stand-in's answer is
   * indistinguishable from the user's own — it opens exactly the same doors
   * (`request_sensitive_edit`, `/gate-bypass`, a goal approval). The only thing
   * that keeps that honest is that the user can SEE it, so two rules follow and
   * both are implemented:
   *   - `declare_done` prints this list mechanically in the completion report;
   *     the user must never have to wonder which decisions were theirs;
   *   - each entry carries enough to re-run the step (question, rows, choice,
   *     reason), so overturning one is re-asking — never undoing.
   *
   * DIAGNOSTIC otherwise: it never feeds the ship decision. A tampered record
   * could only HIDE a proxy decision, which is why nothing here authorizes
   * anything — the answers took effect when they were given.
   */
  proxyDecisions?: Array<{
    at: string;
    /** The dialog's own question, verbatim (its title). */
    question: string;
    /** The rows it chose from, verbatim. */
    options: string[];
    /** The row the proxy chose — one of `options`, verbatim. */
    choice: string;
    /** Why, in the proxy's own words. */
    rationale: string;
  }>;
  precommit: {
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
     * WHAT MAY WRITE IT (lib/gate-state.ts `nextFullPassTree`, the only
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
  rounds: RoundRecord[];
  /**
   * How many reviewer rounds THIS SESSION HAS SENT OUT (2026-09-17, user
   * decision): the strip's `轮 N` reading, and nothing else.
   *
   * WHY IT IS SEPARATE FROM `rounds` ABOVE. `rounds` holds RECORDED verdicts
   * and drives the convergence checks (oscillation / plateau) and the
   * `maxRounds` brake — so it can only move when a judge finishes, which made
   * the strip sit still for the entire duration of every round and read as
   * broken. This one moves the moment a round is SUBMITTED, and deliberately
   * survives `declare_done` (the session's reviewing activity is a fact about
   * the session, not about one task).
   *
   * Incremented once per SUCCESSFUL reviewer dispatch in `judge_submit` —
   * never for a failed one, and never for the adviser / goal-auditor / quality
   * rounds (those are not review rounds the user asked for). Absent on older
   * sidecars ⇒ zero rounds sent.
   */
  sentReviewRounds?: number;
  /**
   * The last polish-gate `reason` the agent supplied to prepare_review
   * (round-18). Injected into the NEXT reviewer's task text so the judge can
   * see why this round exists. Absent on older sidecars ⇒ no reason to
   * carry forward (and no trigger either — the rounds are the trigger).
   */
  lastPolishReason?: { reason: string; at: string; round: number };
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
   * advisory ONLY for a user-chosen explore/normal ("user" — confirmed
   * dialog or /gate-mode); an agent/auto selection ("auto") never weakens
   * the hook. Absent ⇒ treated as "auto" (fail-closed — older sidecars keep
   * the full gate).
   */
  taskModeSource?: TaskModeSource;
  /**
   * The orchestration this session runs, when it is an orchestrator
   * (lib/orchestrator-registry.ts). Holds the child registry, the user's plan
   * approval and the notification throttle — everything that has to survive a
   * turn boundary and be readable by a relay successor.
   *
   * Optional: an ordinary loop session never writes it, and older sidecars
   * simply have none.
   */
  orchestrator?: import("./orchestrator-registry.ts").OrchestratorRuntime;
  /**
   * sd0x-dev-flow R10 ("Think Harder") port: whether the one-shot strategic
   * reset checklist has fired for this state lifetime. Optional so schema-1
   * sidecars written by older versions still validate; absent ⇒ not fired.
   */
  strategicResetFired?: boolean;
  /**
   * The loop pause an `ask_user` interview leaves behind: something the user
   * has not answered yet, so L2 auto-continuation is
   * paused until the user's next interactive message. This NEVER affects the
   * ship gate — unmetRequirements() ignores it entirely; a paused loop still
   * blocks git commit/push and gh pr. Persisted so the pause survives a
   * restart while waiting for the user. Absent ⇒ not paused.
   */
  pausedQuestion?: {
    question: string;
    at: string;
  };
  /**
   * The last `ask_user` interview: what was asked and what came back, kept so
   * the Q&A survives the dialogs that carried it (they leave no transcript of
   * their own) and an interrupted interview stays inspectable. Diagnostic
   * only — no enforcement path reads it.
   */
  askUser?: {
    at: string;
    answers: import("./ask-user.ts").AskAnswer[];
  };
  /**
   * What the notification throttle remembers: when this session last raised a
   * banner, and the exact text of the last few (lib/user-notify.ts).
   *
   * PER SESSION, not per orchestration (2026-09-17): a standalone loop session
   * notifies too, and a history only the orchestrator runtime carried would
   * let one of them become a pager storm while the other stayed silent.
   * Absent ⇒ nothing sent yet, which can only ever mean one extra banner.
   */
  notify?: import("./user-notify.ts").NotifyHistory;
  /**
   * The user's authorization to run tmux commands from bash (user decision,
   * 2026-09-17).
   *
   * `session` covers this session AND the `session_handoff` successor it may
   * name — the user's words were “当前会话和他的继承者”, and this rides the same
   * inheritance path as every other confirmed record. `once` is consumed by the
   * first tmux command that goes through.
   *
   * NOT inherited by `orchestrator_attach`: a takeover is a different session
   * taking over an address, not a continuation of this one's judgement, and
   * the same line already governs the plan approval and the goal contract.
   */
  tmuxAccess?: { at: string; scope: "session" | "once" };
  /**
   * A-class text appeals (lib/text-appeal.ts): how many were spent (a quota
   * SHARED with `gh pr edit` arbitration), which contents were already
   * decided (so a refused text cannot be re-rolled), and the single live
   * content-bound pass, if one was granted.
   *
   * Persisted because all three are anti-abuse facts: an in-memory quota
   * would reset on every restart, and a refused text could be appealed again
   * by killing the session. Absent ⇒ nothing appealed yet.
   */
  appeals?: import("./text-appeal.ts").AppealRecord;
  /**
   * USER-GRANTED review-scope limit: the user confirmed via an
   * extension-rendered dialog (request_scope_limit tool) that the gate only needs to cover
   * THIS session's own edits — pre-existing worktree/branch changes stop
   * arming it. `preexistingFiles` snapshots the changed files exempted at
   * grant time, so every re-arm path (session_start P0-2, bash git re-arm,
   * turn_end reconciliation) exempts exactly those files — and a file this
   * session later edits is RECLAIMED (removed) from the snapshot by the edit
   * handler: the grant never covers the session's own work.
   * Branch commits are exempt for as long as the grant stands — a new
   * commit under a standing grant is either the exempted pre-existing work
   * being shipped (exactly what the user consented to) or a user/bypass
   * action; the session's own NEW edits re-arm the gate before any further
   * agent commit. `sessionFiles` records what this session edited (the scope
   * shown to the reviewer) and grows with each edit. This never
   * fabricates a verdict: narrowing the fence only changes what ARMS the
   * gate — the session's own edits still require READY + PASS. Absent ⇒
   * full-scope gate (fail-closed).
   */
  scopeLimit?: {
    preexistingFiles: string[];
    sessionFiles: string[];
    at: string;
  };
  /**
   * Repo-relative paths of the files THIS session actually edited
   * (successful edit-tool results only). Persisted so a same-session process
   * restart keeps the session's edit attribution — without it, a restart
   * would re-label the session's own edits as "pre-existing" and offer them
   * for a scope-limit exemption. The ship authority (unmetRequirements)
   * never reads it; absent on older sidecars ⇒ no attribution, and the
   * scope hints stay conservative.
   */
  sessionEditedFiles?: string[];
  /**
   * L7: the post-PR Copilot code-review cycle for THIS repo (see
   * lib/copilot-review.ts). Written by the trusted copilot tools and by the
   * arming path that watches successful PR ships.
   *
   * Deliberately NOT read by {@link unmetRequirements}: fixing a Copilot
   * finding requires a commit and a push, so a Copilot requirement inside the
   * ship authority would block its own remedy. It gates task COMPLETION
   * (declare_done + the L2 continuation) instead. Absent ⇒ no cycle is open.
   */
  copilot?: CopilotReviewState;
  /**
   * L8: the user's approval of the CURRENT loop-goal text (hash + time,
   * written only by propose_loop_goal after an extension-rendered dialog).
   *
   * Absent ⇒ the goal is a draft: its body is withheld from the prompt and
   * loop-mode ships are blocked at L1. Like {@link copilot} it stays out of
   * {@link unmetRequirements}, so the git hooks (which cannot see a dialog)
   * keep judging code facts only.
   */
  loopGoal?: LoopGoalConfirmation;
  /**
   * L8b: the goal-auditor PRE-REVIEW of the current draft (hash + verdict +
   * time, written only by the gate's own audit recorder from the auditor's
   * structured conclusion — never an agent-attested boolean).
   *
   * Absent ⇒ the draft was never audited: propose_loop_goal refuses to show
   * the approval dialog. Like {@link loopGoal} it stays out of
   * {@link unmetRequirements} — the git hooks cannot show a dialog, so a
   * pre-review requirement there could never be unblocked.
   */
  goalPrereview?: GoalPrereviewRecord;
  /**
   * The PLAN pre-audit — `goalPrereview`'s twin for the orchestration layer
   * (round-4 §7), written only by the gate after it read the auditor's
   * structured conclusion inside `orchestrator_plan`'s submit.
   *
   * Absent ⇒ this plan was never audited, and `submit` shows no dialog. It
   * binds to the plan's CANONICAL text (tasks, repos, dependencies,
   * parallelism), so executing the plan — which rewrites statuses constantly
   * — never invalidates it, while moving a task to another repo always does.
   */
  planAudit?: PlanAuditRecord;

  /**
   * L8b audit HISTORY (goal criterion 2): every goal-auditor audit ever
   * recorded, PASS or FAIL, oldest first — `goalPrereview` above is only the
   * latest record. Persisted so a re-audit chain is inspectable (and the
   * per-draft carryover data survives) even after newer drafts replaced the
   * singular record.
   */
  goalPrereviewHistory?: GoalPrereviewRecord[];
  /**
   * Audits of the CURRENT goal (B2), counted by the gate so the agent never
   * has to. It counts the lineage being negotiated right now — every revision
   * of one draft — and resets when that negotiation ends (a goal the user
   * approved) or when a new session starts negotiating. It is deliberately
   * NOT `goalPrereviewHistory.length`: that history is append-only across
   * every goal the repo ever had, so it would announce "round 22" on the
   * third audit of today's draft.
   */
  goalAuditRound?: number;
  /** P-multi: repo roots (other than the session repo) this session edited,
  /**
   * 2026-09-17 (user decision): consecutive agent turns in loop mode WITHOUT an
   * approved loop goal. Counted in `agent_settled` (aborted/explore/normal/
   * orchestrator turns excluded), persisted so a restart or resume continues the
   * count instead of letting the agent reset the clock by re-spawning. Cleared
   * when the goal is approved. At `GOAL_FORCE_NEGOTIATE_TURN_THRESHOLD` the gate
   * starts injecting the force-negotiate directive.
   */
  turnsWithoutGoal?: number;
  /**
   * The user-confirmed REQUIREMENT RESTATEMENT for this repo (2026-09-06):
   * what the session said the requirement is, plus the delivery station the
   * user agreed this round stops at (lib/restatement.ts).
   *
   * Absent ⇒ nothing was restated: `propose_loop_goal` and
   * `orchestrator_plan({action:"submit"})` refuse WITHOUT rendering a dialog.
   * Like {@link loopGoal} it stays out of {@link unmetRequirements} — the git
   * hooks cannot show a dialog, so a requirement they could never unblock has
   * no business arming them. It deliberately OUTLIVES the drafts that follow
   * it (a rejected goal does not mean the requirement changed); a fresh
   * `propose_restatement` overwrites it.
   */
  restatement?: RestatementRecord;
  /**
   * SHIP KINDS THE GATE WATCHED SUCCEED in this repo (2026-09-06).
   *
   * Written on the `tool_result` of a bash call that carried a ship command
   * and did NOT fail — so it says "the gate saw `gh pr create` exit 0 here",
   * which is as close to "a PR exists" as a purely local check can get. It is
   * never written from a parameter, so it cannot be attested by the agent.
   *
   * The delivery station's ARRIVAL check reads it (lib/delivery-station.ts),
   * as ONE of three evidences — the FREE one, so it is consulted before the
   * gate spends a network round trip. On its own it is not enough, and used to
   * be the whole check (the bug fixed 2026-09-16): a round that appends to an
   * ALREADY open PR never produces one, because `gh` reports "already exists"
   * as an ERROR — which is why the third evidence exists
   * (lib/station-pr-evidence.ts).
   *
   * Absent / unknown entries are dropped by the loader: this is evidence, and
   * unreadable evidence is no evidence (the arrival then blocks, which is the
   * safe direction).
   */
  shippedKinds?: ShipCommandKind[];

  /** P-multi: repo roots (other than the session repo) this session edited,
   *  persisted so a same-session resume re-arms declare_done against all of
   *  them. Ship enforcement never reads it; absence just narrows the
   *  declare_done scope to the session repo (tighten-only). */
  sessionReposPaths?: string[];
  updatedAt: string;
}

export function emptyState(sessionId: string | null, maxRounds: number): GateState {
  return {
    schema: 1,
    fingerprintVersion: FINGERPRINT_VERSION,
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

/**
 * WHAT A HANDOFF SUCCESSOR CARRIES OVER from its predecessor's session state.
 *
 * A successor runs as a NEW session id, so the restore path starts it from
 * {@link emptyState}. Resetting almost all of that is right: a verdict, a
 * precommit, a fingerprint, a change flag and a bypass all describe ONE
 * round's work, and the successor has done none of it.
 *
 * Four fields describe the USER's contracts instead, and they are the ones a
 * handover must not throw away — re-asking for them re-asks a question whose
 * answer has not changed, which is how a project manager's handover cost the
 * user a restatement dialog, a plan re-audit and a plan approval dialog for a
 * requirement not one word of which was different:
 *
 *  - `restatement` — what the user confirmed the requirement IS (it already
 *    outlives the drafts that follow it; a handover is one more draft);
 *  - `loopGoal` — the goal text the user APPROVED;
 *  - `rounds` / `turnsWithoutGoal` — the ROUND BUDGET. Inherited on purpose,
 *    and not as a courtesy: a successor that restarts the count would let a
 *    handover wash away rounds already spent, and the budget exists precisely
 *    to end a session that is going in circles.
 *
 * `sessionReposPaths` travels too, and it is the same kind of fact seen from
 * the other side (reviewer P2, round 1): it is which OTHER repos this session
 * edited, and `declare_done` re-arms the gate against every one of them. A
 * handover that dropped it could retire work the predecessor left half-done
 * in a second repo — the one direction a succession must never move:
 * inheriting may only ever make completion harder, never easier.
 *
 * WHAT DOES NOT CARRY is the rest of {@link GateState}: `bypass`, the scope
 * limits, the verdicts, the fingerprints, the change flags and the session's
 * own task mode all describe THIS session's standing, and a successor starts
 * with none of them (the same asymmetry the concurrent-sidecar merge in this
 * module states from the other side).
 *
 * Two more omissions are deliberate rather than forgotten. `goalPrereview`
 * and `planAudit` are audits of ONE DRAFT — they answer "did a judge read
 * these exact words?" — so they live and die with the text they judged, and a
 * successor that has to negotiate anything new re-earns them for the new
 * draft. Nobody is asked to re-confirm an answer that has not changed, which
 * is what this function is for; re-running an AUDIT of a changed draft is
 * exactly what the audit is for.
 *
 * None of this widens a permission: every carried record is bound to the
 * CONTENT it names and re-verified by its reader (`isLoopGoalConfirmed`
 * against the goal file, `restatementConfirmed` over text+hash,
 * `approvedPlanHash` against the canonical plan), so a change to any of them
 * expires the inherited record exactly as fast as a fresh one.
 */
export function inheritGoalContract(target: GateState, predecessor: GateState): GateState {
  return {
    ...target,
    ...(predecessor.restatement ? { restatement: predecessor.restatement } : {}),
    ...(predecessor.loopGoal ? { loopGoal: predecessor.loopGoal } : {}),
    ...(predecessor.rounds.length > 0 ? { rounds: predecessor.rounds } : {}),
    // HOW MUCH REVIEW THIS WORK HAS HAD (2026-09-17, user decision): it is a
    // fact about the WORK, like the round budget above, not about the process
    // id that happened to hold the seat — a handover that dropped it would
    // roll the strip back to `轮 0` mid-task and say nothing was ever sent.
    ...(predecessor.sentReviewRounds !== undefined
      ? { sentReviewRounds: predecessor.sentReviewRounds }
      : {}),
    ...(predecessor.turnsWithoutGoal !== undefined
      ? { turnsWithoutGoal: predecessor.turnsWithoutGoal }
      : {}),
    ...(predecessor.sessionReposPaths && predecessor.sessionReposPaths.length > 0
      ? { sessionReposPaths: predecessor.sessionReposPaths }
      : {}),
    // THE TMUX GRANT TRAVELS WITH THE SEAT (user decision, 2026-09-17: “当前
    // 会话和他的继承者都能用”). It is permission the USER gave to an on-going
    // piece of work rather than to a process id — a handover changes who holds
    // the seat, not what they were allowed to do. A ONE-SHOT grant is carried
    // as it is: still one use, now owed to the successor.
    ...(predecessor.tmuxAccess ? { tmuxAccess: predecessor.tmuxAccess } : {}),
  };
}

/**
 * Content-change invalidation — the ONE place a session's own edit downgrades
 * standing bindings. READY → PENDING and PASS → NOT_RUN, and the fingerprint
 * goes with the verdict: a downgraded binding must not keep pointing at the
 * content it no longer describes. (Measured residue: the edit path used to
 * flip the verdict but leave the fingerprint, leaving an impossible state
 * like `{verdict:"NOT_RUN", fingerprint:"…"}` in the sidecar — harmless to
 * enforcement, misleading to every reader, 2026-08-31.)
 */
export function invalidateBindings(st: GateState): void {
  if (st.review.verdict === "READY") {
    st.review.verdict = "PENDING";
    st.review.fingerprint = null;
  }
  if (st.precommit.verdict === "PASS") {
    st.precommit.verdict = "NOT_RUN";
    st.precommit.fingerprint = null;
  }
  // THE QUALITY STANDING IS DELIBERATELY NOT CLEARED HERE (2026-09-15).
  //
  // It looks like a binding on the worktree, and it is not: `commitSha` binds
  // it to a COMMIT, and an edit does not move HEAD. Keeping it is what lets the
  // hand-off work — the agent is told to keep editing while a judge runs, so an
  // edit arriving between the quality READY and the reviewer's dispatch (the
  // dispatch happens on the settle path, microseconds later) would otherwise
  // erase the pass that dispatch is gated on.
  //
  // What expires it is the CHECKPOINT: the next submission commits the new
  // worktree, HEAD moves, and `lib/quality-round.ts`'s `qualityStandingFor`
  // finds the standing bound to a different head and refuses. That is the
  // fail-closed direction — a stale pass can never unlock a reviewer.
  // NOT cleared here, deliberately: `precommit.lastFullPassTree` is not a
  // binding but a fact about a tree that DID pass — the edit that invalidates
  // the binding cannot un-pass it. See the field's own comment.
}

/**
 * The one rule that maintains `precommit.lastFullPassTree`.
 *
 * PURE and total, so the four cases are a table in a test rather than four
 * branches spread over a 9000-line file. `startedTree` is the tree captured
 * BEFORE the lane ran — the caller has it (it captures it for the async
 * report) and must not substitute the runner's post-run fingerprint, which is
 * recomputed after `lint:fix` may have edited files and can already describe
 * the NEXT round's content.
 *
 *  - a FULL lane PASSED on `startedTree` ⇒ record it;
 *  - a FAIL on the SAME tree ⇒ revoke (the content was disproven);
 *  - anything else (fast lane, a narrowed test scope, no tree, a FAIL of some
 *    other tree, ERROR) ⇒ the previous value stands.
 */
export function nextFullPassTree(args: {
  /** The value already on the state. */
  current: string | undefined;
  verdict: string;
  mode: PrecommitMode | undefined;
  testScope: TestScope | undefined;
  /** Tree captured before the lane started; "" when it could not be read. */
  startedTree: string;
}): string | undefined {
  if (!args.startedTree) return args.current;
  if (args.mode !== "full") return args.current;
  if (args.verdict === "PASS" && args.testScope === "full") return args.startedTree;
  if (args.verdict === "FAIL" && args.current === args.startedTree) return undefined;
  return args.current;
}


/**
 * Environment variable that gives a session its OWN sidecar file (F4).
 *
 * THE MEASURED PROBLEM. The sidecar is one file per worktree, and `taskMode`
 * is a single-valued field in it. When an orchestrator supervises a child in
 * the same worktree, the two sessions write the same file: the orchestrator
 * records `taskMode: "orchestrator"`, the child records `taskMode: "loop"`,
 * each `ask_user` record overwrites the other's, and the orchestrator's own
 * prompt ends up quoting the CHILD's unmet gates ("code review gate PENDING")
 * as if they were its own. That is F4 and half of F13.
 *
 * WHY THE CHILD MOVES AND NOT THE ORCHESTRATOR. The obvious fix is to give
 * the orchestrator a special file, and it is the wrong way round. The L3 git
 * hook (`hooks/pre-commit`) resolves the sidecar by this same rule, and a
 * MISSING variable must fail toward the STRICTER file: with children on the
 * variant path, a hook that somehow runs without the variable falls back to
 * the default file — the orchestrator's, an enforced mode with no review —
 * and blocks. With it the other way round, the same accident would check a
 * child's commit against a file the child never wrote and let it through. The
 * fail-closed direction decides it.
 *
 * As a bonus this also separates SERIAL children from each other: two
 * children that run one after another in the same worktree no longer inherit
 * each other's verdicts.
 */
export const STATE_VARIANT_ENV = "RG_STATE_VARIANT";


/** Only these characters may reach a filename. Anything else is dropped. */
const STATE_VARIANT_SAFE = /[^A-Za-z0-9._-]/g;

/**
 * The sidecar variant this process runs under, sanitized, or `undefined` for
 * the default file. Never throws and never returns something that could
 * escape the `.pi/` directory.
 */
export function stateVariantFrom(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[STATE_VARIANT_ENV]?.trim();
  if (!raw) return undefined;
  const safe = raw.replace(STATE_VARIANT_SAFE, "-").replace(/^[.-]+/, "").slice(0, 64);
  return safe.length > 0 ? safe : undefined;
}

export function sidecarPath(cwd: string, configDirName = ".pi", variant?: string): string {
  const safe = variant ? variant.replace(STATE_VARIANT_SAFE, "-").replace(/^[.-]+/, "").slice(0, 64) : "";
  const name = safe.length > 0 ? `review-gate-state.${safe}.json` : "review-gate-state.json";
  return join(cwd, configDirName, name);
}


/**
 * Load and validate the sidecar.
 *
 * The fingerprint migration is applied HERE, not left to callers: forgetting
 * it would mean trusting a binding produced by another algorithm, which is the
 * one outcome this must never allow. Because the migration is consumed here,
 * callers that need to TELL the user why their READY disappeared must pass
 * `out` — reading `state.fingerprintVersion` afterwards is useless, it has
 * already been updated (that exact mistake silenced the notice on the
 * sidecar-restore path).
 */
export function loadSidecar(path: string, out?: { migrated: boolean }): GateState | undefined {
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
    // THE PARKED READY (2026-09-15). Optional, and a malformed one is DROPPED
    // rather than rejecting the sidecar: dropping is the fail-closed direction
    // here (a parked conclusion that cannot be replayed is one the gate must
    // not replay), and `review` stays PENDING either way — so the worst case
    // is a round that has to be re-submitted, never a replayed forgery.
    if (parsed.pendingReady !== undefined && !isPendingReadyReview(parsed.pendingReady)) {
      delete parsed.pendingReady;
    }
    if (!parsed.precommit || !PRECOMMIT_VERDICTS.has(parsed.precommit.verdict as string)) return undefined;
    // Lane metadata. A forged/unknown value is DROPPED rather than rejecting
    // the sidecar, and dropping is the fail-closed direction: an absent
    // testScope is treated as "not full", which blocks a push/PR.
    if (parsed.precommit.mode !== undefined && !PRECOMMIT_MODES.has(parsed.precommit.mode as string)) {
      delete parsed.precommit.mode;
    }
    if (parsed.precommit.testScope !== undefined &&
        !(TEST_SCOPES as readonly string[]).includes(parsed.precommit.testScope as string)) {
      delete parsed.precommit.testScope;
    }
    // The recorded pass-coverage tree: a CONTENT IDENTITY, and the only thing
    // that lets a READY be recorded after the live binding was invalidated by
    // the next round's own edits. Anything that is not a real object id is
    // dropped — dropping means the check falls back to the live verdict, which
    // is the direction that cannot wave an unverified round through.
    if (parsed.precommit.lastFullPassTree !== undefined &&
        !(typeof parsed.precommit.lastFullPassTree === "string" &&
          /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(parsed.precommit.lastFullPassTree))) {
      delete parsed.precommit.lastFullPassTree;
    }
    // Incremental-review baseline. `treeOid` is handed to `git diff` as an
    // ARGUMENT, so an unvalidated string from a tampered (or simply
    // repo-committed) sidecar would be git option injection — `--output=…`
    // and friends. Accept only a real object id; drop the whole field
    // otherwise, which just means the next round is a full review.
    //
    // `verdict` is validated the same way: it is what stops a BLOCKED tree
    // from being read as a settled conclusion (`settledConclusion`), so an
    // unknown word drops the field rather than guessing which side it is on.
    if (parsed.lastReviewedTree !== undefined) {
      const b = parsed.lastReviewedTree as Record<string, unknown> | null;
      const validOid = typeof b?.treeOid === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(b.treeOid);
      const validFiles = b?.files === undefined ||
        (Array.isArray(b.files) && b.files.every((f: unknown) => typeof f === "string"));
      const validVerdict = b?.verdict === "READY" || b?.verdict === "BLOCKED" || b?.verdict === "NEEDS_HUMAN";
      if (!b || typeof b !== "object" || Array.isArray(b) || !validOid || !validFiles || !validVerdict || typeof b.at !== "string") {
        delete parsed.lastReviewedTree;
      }
    }
    // The proxy's record. Shape-validated for one reason: `declare_done` prints
    // it back to the user, so a garbled entry would either crash the completion
    // report or quietly drop a decision nobody else witnessed. A bad shape drops
    // the WHOLE list rather than printing half of it — an incomplete list reads
    // as "that was all of them", which is the one thing this record cannot lie
    // about.
    if (parsed.proxyDecisions !== undefined) {
      const rows = parsed.proxyDecisions;
      const entryOk = (value: unknown): boolean => {
        const e = value as Record<string, unknown> | null;
        return !!e && typeof e === "object" && !Array.isArray(e) &&
          typeof e.at === "string" && typeof e.question === "string" &&
          typeof e.choice === "string" && typeof e.rationale === "string" &&
          Array.isArray(e.options) && e.options.every((o: unknown) => typeof o === "string");
      };
      if (!Array.isArray(rows) || !rows.every(entryOk)) delete parsed.proxyDecisions;
    }
    // Orchestration runtime. Same threat model as `lastReviewedTree` above:
    // this blob carries the USER'S plan approval (which authorizes spawning
    // child sessions) and tmux pane ids (which become command targets), and
    // it lives in an ordinary repo-local file. `normalizeRuntime` validates
    // it and drops the approval on any doubt — the session then simply has to
    // ask the user again.
    //
    // THE ID IS READ BACK, AND THAT IS A CHANGE (2026-09-06, B1). It used to
    // be blanked here, with the reasoning that "a forged id must never become
    // an attention channel key". The blanking did not achieve that and cost
    // something real:
    //
    //  - it did not achieve it, because the very next thing that happened was
    //    lib/orchestrator-wiring.ts STAMPING the session's own id onto the
    //    stored runtime — so a foreign registry was adopted under our address
    //    anyway, and `runtimeConflict` (whose whole job is to refuse exactly
    //    that) compared against `""` and returned a falsy "conflict" that
    //    `dispatchSpawn` skipped;
    //  - it cost the takeover path: with no id on the record, nothing on disk
    //    could say WHICH orchestration this repo's plan belongs to, and a new
    //    project manager had no way to adopt it (it had to `rm` the plan).
    //
    // What actually keeps a forged id from becoming an address is elsewhere
    // and is unchanged: an id is only ADOPTED when a caller names it
    // explicitly in `orchestrator_attach` and it survives that tool's checks.
    // Read back here, the id is a FACT ABOUT THE RECORD ("this registry
    // belongs to that orchestration"), which is what makes refusing it
    // possible. A malformed one is not repaired: the whole blob goes, because
    // a registry whose owner cannot be named is one nothing may act on.
    if (parsed.orchestrator !== undefined) {
      // OPTIONAL CHAINING IS LOAD-BEARING HERE. `parsed.orchestrator` is
      // whatever the file said: `null` passes the `!== undefined` test above
      // and a plain property read on it THROWS — inside the try/catch that
      // wraps this whole function, which returns "unreadable sidecar". The
      // blast radius would have been every mode, not this one: a loop session
      // whose sidecar carried `"orchestrator": null` would silently lose its
      // READY and its precommit because of a field it never reads. The old
      // code was safe by accident (it handed the value to `normalizeRuntime`,
      // which type-checks first); this one has to be safe on purpose.
      const storedId = normalizeOrchestrationId(
        (parsed.orchestrator as { orchestrationId?: unknown } | null)?.orchestrationId,
      );
      const cleaned = storedId ? normalizeRuntime(parsed.orchestrator, storedId) : undefined;
      if (cleaned) parsed.orchestrator = cleaned;
      else delete parsed.orchestrator;
    }
    // Round-18 polish gate: malformed per-round file lists and the last
    // reason are DROPPED (absent means 'no trigger / nothing to carry',
    // which is the safe direction for both).
    if (Array.isArray(parsed.rounds)) {
      for (const r of parsed.rounds as unknown as Array<Record<string, unknown>>) {
        if (r.polishFiles !== undefined &&
            (!Array.isArray(r.polishFiles) || !r.polishFiles.every((v) => typeof v === "string"))) {
          delete r.polishFiles;
        }
        if (r.blockingFiles !== undefined &&
            (!Array.isArray(r.blockingFiles) || !r.blockingFiles.every((v) => typeof v === "string"))) {
          delete r.blockingFiles;
        }
        // A persisted total must be a real count. `isPlateaued` only guards
        // against `null` and then compares numerically, and EVERY comparison
        // with NaN is false — so a NaN slipping in here would sail past the
        // unparseable-total guard and let overlap alone declare a plateau.
        // Anything that is not a finite non-negative number becomes `null`,
        // which is the guard's own fail-closed value (round-15 P1). The
        // sidecar is a file: a stale writer or a hand edit can put anything
        // in it, so the parser's sanitizing is not enough on its own.
        if (r.findingsTotal !== undefined && r.findingsTotal !== null &&
            (typeof r.findingsTotal !== "number" ||
              !Number.isFinite(r.findingsTotal) || r.findingsTotal < 0)) {
          r.findingsTotal = null;
        }
        if (r.fingerprints !== undefined &&
            (!Array.isArray(r.fingerprints) || !r.fingerprints.every((v) => typeof v === "string"))) {
          r.fingerprints = [];
        }
        // The audit stamp is a RECORD, and a record nobody can trust is worse
        // than none: anything that is not a recognisable stamp is dropped
        // rather than kept as a half-value a reader would still print.
        const scope = sanitizeRoundScope(r.scope);
        if (scope === undefined) delete r.scope;
        else r.scope = scope;

      }
    }
    if (parsed.lastPolishReason !== undefined) {
      const p = parsed.lastPolishReason as Record<string, unknown> | null;
      if (!p || typeof p !== "object" || typeof p.reason !== "string" ||
          typeof p.at !== "string" || typeof p.round !== "number") {
        delete parsed.lastPolishReason;
      }
    }
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
    // Malformed pause → treated as NOT paused (tighten-only: the pause only
    // relaxes auto-continuation, so dropping a forged one re-arms the loop;
    // the ship gate never reads this field either way).
    if (parsed.pausedQuestion !== undefined &&
        (typeof parsed.pausedQuestion !== "object" || parsed.pausedQuestion === null ||
         typeof parsed.pausedQuestion.question !== "string" ||
         typeof parsed.pausedQuestion.at !== "string")) {
      delete parsed.pausedQuestion;
    }
    // Malformed completion record → treated as ABSENT, which is the
    // fail-closed direction here: a supervisor then keeps watching a child it
    // cannot prove is finished, rather than writing it off (and marking its
    // plan task done) on a field anything could have written. `merge` is
    // constrained to the three landings the gate itself records.
    if (parsed.completion !== undefined) {
      const c = parsed.completion as Record<string, unknown> | null;
      const validMerge = c?.merge === "merged" || c?.merge === "waived" || c?.merge === "none";
      if (!c || typeof c !== "object" || Array.isArray(c) || typeof c.at !== "string" || !c.at ||
          !validMerge || (c.summary !== undefined && typeof c.summary !== "string")) {
        delete parsed.completion;
      }
    }
    // Malformed scope limit → treated as ABSENT (fail-closed: absent means
    // the FULL-scope gate; dropping a forged one can only widen coverage,
    // never narrow it).
    if (parsed.scopeLimit !== undefined &&
        (typeof parsed.scopeLimit !== "object" || parsed.scopeLimit === null ||
         !Array.isArray(parsed.scopeLimit.preexistingFiles) ||
         !parsed.scopeLimit.preexistingFiles.every((v) => typeof v === "string") ||
         !Array.isArray(parsed.scopeLimit.sessionFiles) ||
         !parsed.scopeLimit.sessionFiles.every((v) => typeof v === "string") ||
         typeof parsed.scopeLimit.at !== "string")) {
      delete parsed.scopeLimit;
    }
    // Malformed session-edit attribution → treated as ABSENT (hints and the
    // scope tool then behave conservatively; the ship authority never reads
    // this field either way).
    if (parsed.sessionEditedFiles !== undefined &&
        (!Array.isArray(parsed.sessionEditedFiles) ||
         !parsed.sessionEditedFiles.every((v) => typeof v === "string"))) {
      delete parsed.sessionEditedFiles;
    }
    // Malformed repo set → treated as ABSENT (declare_done then only covers
    // the session repo; fail-closed for anything it does cover).
    if (parsed.sessionReposPaths !== undefined &&
        (!Array.isArray(parsed.sessionReposPaths) ||
         !parsed.sessionReposPaths.every((v) => typeof v === "string"))) {
      delete parsed.sessionReposPaths;
    }
    // Observed ship kinds: keep only the known vocabulary, deduped. A record
    // that is not an array at all is dropped entirely. Evidence that cannot be
    // read is not evidence — and losing it only makes an ARRIVAL check block,
    // which is the safe direction.
    if (parsed.shippedKinds !== undefined) {
      if (!Array.isArray(parsed.shippedKinds)) {
        delete parsed.shippedKinds;
      } else {
        const known = parsed.shippedKinds.filter(
          (v): v is ShipCommandKind => typeof v === "string" && (SHIP_COMMAND_KINDS as readonly string[]).includes(v),
        );
        parsed.shippedKinds = [...new Set(known)];
      }
    }

    // L7: a malformed Copilot cycle is repaired, never trusted verbatim and
    // never fatal — sanitizeCopilotState downgrades an unrecognized status to
    // ARMED (still to be proven) and drops a non-object entirely. Rejecting
    // the whole sidecar here would brick the ship gate over a field the ship
    // gate does not even read.
    if (parsed.copilot !== undefined) {
      const copilot = sanitizeCopilotState(parsed.copilot);
      if (copilot) parsed.copilot = copilot;
      else delete parsed.copilot;
    }
    // L8: a malformed goal approval is treated as ABSENT — the fail-closed
    // direction here is "not approved" (goal body withheld, loop ships
    // blocked), so a forged or truncated record can only cost a fresh dialog.
    if (parsed.loopGoal !== undefined &&
        (typeof parsed.loopGoal !== "object" || parsed.loopGoal === null ||
         typeof parsed.loopGoal.hash !== "string" ||
         !/^[0-9a-f]{64}$/.test(parsed.loopGoal.hash) ||
         typeof parsed.loopGoal.at !== "string" ||
         (parsed.loopGoal.reason !== undefined && typeof parsed.loopGoal.reason !== "string"))) {
      delete parsed.loopGoal;
    }
    // The goal's delivery station (2026-09-06) is metadata BESIDE the
    // approval, so a broken one drops the FIELD and never the approval: the
    // reader degrades a missing station to `precommit`, the strictest value,
    // which is exactly what an unreadable one should mean. Dropping the whole
    // record instead would revoke an approval the user really gave over a
    // field that grants nothing.
    if (parsed.loopGoal?.station !== undefined && !isDeliveryStation(parsed.loopGoal.station)) {
      delete parsed.loopGoal.station;
    }
    // L8b: a MALFORMED pre-review record is treated as ABSENT — fail-closed
    // here means "never audited", so a truncated or shape-broken record costs
    // one fresh goal-auditor round instead of opening a dialog. This is a
    // SHAPE check, not an anti-forgery one: a well-formed record whose hash
    // matches the submitted text is honoured, exactly like `loopGoal`
    // (fabricating one is the same excluded class as writing the sidecar
    // directly — see the threat model in the README).
    function isGoalPrereviewRecord(x: unknown): boolean {
      const r = x as GoalPrereviewRecord | null | undefined;
      return !!r && typeof r === "object" &&
        typeof r.hash === "string" &&
        /^[0-9a-f]{64}$/.test(r.hash) &&
        (r.verdict === "PASS" || r.verdict === "FAIL") &&
        typeof r.at === "string" &&
        (r.findingsTotal === undefined || r.findingsTotal === null || typeof r.findingsTotal === "number") &&
        (r.findings === undefined ||
          (Array.isArray(r.findings) &&
            r.findings.every((f) =>
              typeof f === "object" && f !== null &&
              typeof (f as { issue?: unknown }).issue === "string" &&
              typeof (f as { severity?: unknown }).severity === "string"))) &&
        (r.draft === undefined || typeof r.draft === "string") &&
        (r.durationMs === undefined || typeof r.durationMs === "number");
    }
    if (parsed.goalPrereview !== undefined && !isGoalPrereviewRecord(parsed.goalPrereview)) {
      delete parsed.goalPrereview;
    }
    // L8b history (goal criterion 2: EVERY audit is persisted, PASS or FAIL,
    // not just the latest). Malformed entries are dropped per-entry, keeping
    // the rest of the history intact.
    if (parsed.goalPrereviewHistory !== undefined) {
      if (!Array.isArray(parsed.goalPrereviewHistory)) {
        delete parsed.goalPrereviewHistory;
      } else {
        parsed.goalPrereviewHistory = parsed.goalPrereviewHistory.filter(isGoalPrereviewRecord);
      }
    }
    // The goal's audit round is a plain counter; anything else on disk is
    // corruption, and dropping it restarts the count rather than printing
    // "第 NaN 轮审计".
    if (parsed.goalAuditRound !== undefined &&
      (typeof parsed.goalAuditRound !== "number" || !Number.isFinite(parsed.goalAuditRound) || parsed.goalAuditRound < 0)) {
      delete parsed.goalAuditRound;
    }
    // The un-goaled turn counter is a plain counter too; anything else on disk
    // is corruption, and dropping it restarts the count. A forged LARGE value
    // would only trigger the force-negotiate directive early (a prompt, not a
    // block — fail-open by design), so no extra bound is needed beyond sanity.
    if (parsed.turnsWithoutGoal !== undefined &&
      (typeof parsed.turnsWithoutGoal !== "number" || !Number.isFinite(parsed.turnsWithoutGoal) || parsed.turnsWithoutGoal < 0)) {
      delete parsed.turnsWithoutGoal;
    }
    // The REQUIREMENT RESTATEMENT (2026-09-06). Dropped WHOLE on any doubt,
    // and unlike every neighbour above this one re-computes the hash: the
    // record carries the confirmed TEXT, so `text` and `hash` disagreeing
    // means the pair was not written by `propose_restatement` — corruption or
    // an assembled record — and both readings are "nobody confirmed this".
    // Fail-closed here costs one fresh confirmation dialog; fail-open would
    // let a contract be negotiated against an understanding the user never
    // saw. The station is validated against the three known values, and a
    // record whose station alone is broken is dropped with it rather than
    // silently downgraded: a confirmation the user gave for `pr` must not
    // survive as something else.
    if (parsed.restatement !== undefined) {
      const rec = parsed.restatement as Partial<RestatementRecord> | null;
      const ok = !!rec && typeof rec === "object" &&
        typeof rec.text === "string" && rec.text.trim().length > 0 &&
        typeof rec.hash === "string" && /^[0-9a-f]{64}$/.test(rec.hash) &&
        typeof rec.at === "string" &&
        isDeliveryStation(rec.station) &&
        restatementHash(rec.text) === rec.hash;
      if (!ok) delete parsed.restatement;
    }
    // The ask_user record is diagnostic, so a malformed one is dropped whole:
    // no enforcement path reads it, and half a record answers nothing.
    if (parsed.askUser !== undefined) {
      const rec = parsed.askUser as { at?: unknown; answers?: unknown };
      const ok = !!rec && typeof rec === "object" && typeof rec.at === "string" &&
        Array.isArray(rec.answers) &&
        rec.answers.every((a) =>
          typeof a === "object" && a !== null &&
          typeof (a as { question?: unknown }).question === "string" &&
          ["answered", "skipped", "deferred-to-chat", "unanswered"].includes(String((a as { kind?: unknown }).kind)) &&
          // An `answer` that is not text would be replayed into the agent's
          // prompt as the user's words — it must be a string or absent. Same
          // for the option the answer was picked from (`option`, the letterless
          // text the proxy-grant rule compares) — 2026-09-19.
          ((a as { answer?: unknown }).answer === undefined || typeof (a as { answer?: unknown }).answer === "string") &&
          ((a as { option?: unknown }).option === undefined || typeof (a as { option?: unknown }).option === "string"));
      if (!ok) delete parsed.askUser;
    }
    // The banner throttle is bookkeeping whose worst failure is one extra
    // notification, so it is read fail-soft: unreadable entries contribute
    // nothing, and a malformed record can never be rounded into silence.
    if (parsed.notify !== undefined) {
      parsed.notify = normalizeNotifyHistory(parsed.notify);
    }
    // TMUX ACCESS is AUTHORITY, so it is read the other way round: a record
    // that does not parse is DROPPED (fail-closed — the agent asks again),
    // and the scope must be one of the two the tool can mint. A forged or
    // corrupted value must never read as a standing permission.
    if (parsed.tmuxAccess !== undefined) {
      const rec = parsed.tmuxAccess as { at?: unknown; scope?: unknown } | null;
      const ok = !!rec && typeof rec === "object" && typeof rec.at === "string" &&
        (rec.scope === "session" || rec.scope === "once");
      if (ok) parsed.tmuxAccess = { at: rec.at as string, scope: rec.scope as "session" | "once" };
      else delete parsed.tmuxAccess;
    }
    // APPEALS are anti-abuse bookkeeping, so a malformed record is dropped
    // WHOLE and the session starts from zero spent appeals. That is the safe
    // direction for the pass (a forged one would authorize content no arbiter
    // ever saw) and the honest one for the quota: a record the gate cannot
    // read is not evidence that anything was spent.
    if (parsed.appeals !== undefined) {
      const a = parsed.appeals as { used?: unknown; decided?: unknown; pass?: unknown };
      const decisionsOk = !!a && typeof a === "object" &&
        typeof a.used === "number" && Number.isFinite(a.used) && a.used >= 0 &&
        !!a.decided && typeof a.decided === "object" && !Array.isArray(a.decided) &&
        Object.entries(a.decided as Record<string, unknown>).every(([digest, decision]) =>
          /^[0-9a-f]{64}$/.test(digest) &&
          ["GATE_WINS", "AGENT_WINS", "HUMAN"].includes(String(decision)));
      const p = a?.pass as { digest?: unknown; kind?: unknown; issuedAt?: unknown } | undefined;
      const passOk = p === undefined ||
        (!!p && typeof p === "object" && typeof p.digest === "string" && /^[0-9a-f]{64}$/.test(p.digest) &&
          typeof p.kind === "string" && typeof p.issuedAt === "string");
      if (!decisionsOk || !passOk) delete parsed.appeals;
    }
    const migrated = migrateFingerprintVersion(parsed);
    if (out) out.migrated = migrated;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Invalidate bindings that were produced by a DIFFERENT fingerprint algorithm.
 *
 * A digest only means something under the algorithm that produced it, so an
 * older (or newer, or corrupt) version number cannot be trusted, reinterpreted
 * or converted — it is dropped back to "needs a fresh round". The change flags
 * are deliberately preserved: the worktree really does hold uncommitted work,
 * and forgetting that would DISARM the gate instead of re-arming it.
 *
 * Returns true when a migration actually happened, so callers can tell the
 * user why their READY disappeared.
 */
export function migrateFingerprintVersion(state: GateState): boolean {
  if (state.fingerprintVersion === FINGERPRINT_VERSION) return false;
  state.fingerprintVersion = FINGERPRINT_VERSION;
  const hadBinding =
    state.review.verdict !== "PENDING" || state.review.fingerprint !== null ||
    state.precommit.verdict !== "NOT_RUN" || state.precommit.fingerprint !== null;
  state.review = { verdict: "PENDING", fingerprint: null, at: state.review.at };
  state.precommit = { verdict: "NOT_RUN", fingerprint: null, at: state.precommit.at };
  return hadBinding;
}

/** Operator-facing explanation for a fingerprint-algorithm migration. */
export const FINGERPRINT_MIGRATION_NOTICE =
  "review-gate: the worktree fingerprint algorithm changed in this version, so the previous " +
  "READY review and precommit PASS no longer describe this worktree and were invalidated " +
  "(the code itself was NOT modified). Run the precommit runner and an independent review again. " +
  "If the git hook keeps rejecting a commit the gate just approved, the resident extension is " +
  "still running the old algorithm — restart Pi (or /reload) first.";

export function saveSidecar(path: string, state: GateState): void {
  state.updatedAt = new Date().toISOString();
  // `exclusivityRefusal` is this session's own predicament, never a fact about
  // the file: writing it would tell the session that HOLDS this worktree that
  // its worktree is held by somebody else. The refused session is not supposed
  // to reach this function at all (its persist is skipped upstream) — this is
  // the second line of defence, where the bytes are actually produced.
  const { exclusivityRefusal: _refusal, ...persisted } = state;
  // Atomic write: temp + rename, so a crashed write can't leave a truncated
  // JSON that a fail-open parser might half-read (lib/atomic-write.ts).
  writeFileAtomic(path, JSON.stringify(persisted, null, 2) + "\n");
}

/**
 * Keep a CONCURRENT session's still-valid bindings alive in the sidecar.
 *
 * The sidecar holds exactly one `sessionId`, and every writer replaces the
 * whole file (atomically, but last-writer-wins). So when two Pi sessions run
 * in the same repo, session B's write erases the READY + PASS that session A
 * had just earned — and since the L3 git hooks read ONLY this file, A's next
 * commit is rejected for a review it actually passed. (A's own in-memory
 * state is untouched, which is exactly why that failure looks so arbitrary:
 * the extension says READY, the hook says PENDING.)
 *
 * This returns the object to WRITE (never mutating `mine`): a foreign
 * READY/PASS is carried over only where this session has NO verdict of its own
 * yet (PENDING / NOT_RUN) and that binding still describes the CURRENT
 * worktree. A verdict of our own always wins — including a bad one. Worst
 * verdict wins is the rule everywhere else in this gate, and two sessions
 * reaching opposite conclusions about one tree is exactly when it matters:
 * a foreign READY must never overwrite our own BLOCKED (nor a foreign PASS
 * our own FAIL) in the file the git hooks trust.
 *
 * Why this is not a fail-open. A carried-over verdict keeps the FINGERPRINT it
 * was earned with, and it is carried over only after that fingerprint is
 * compared against the worktree as it stands right now — so it can authorize
 * a commit only when the tree being committed is byte-for-byte the tree the
 * other session got reviewed. The fingerprint is content-addressed and
 * carries no session identity, so "who ran the review" is irrelevant to what
 * it proves. Any edit by either session changes the digest, and the stale
 * binding is dropped on the very next write.
 *
 * `currentDigest` is a THUNK because the digest costs a full worktree hash and
 * the only case that needs it — a foreign sidecar holding a verdict we lack —
 * cannot occur in a single-session repo, i.e. in almost every repo. A null or
 * empty digest (fingerprint unavailable) drops the binding: a carry-over that
 * cannot be verified must not be written.
 *
 * The carry-over is also short-lived: normally it is gone by this session's
 * next write, because the file then carries our own sessionId and the foreign
 * verdict is indistinguishable from a stale one of ours. Not recognizing it
 * at that point is deliberate — otherwise a binding this session deliberately
 * invalidated could climb back out of the file on a tree that never changed.
 * (Two edges do outlive one write: a re-read of a still-foreign sidecar, and a
 * session restored FROM the sidecar, which inherits it as its own. Both remain
 * fingerprint-bound, so they can still only describe a tree that was reviewed.)
 * Sharing one worktree between sessions therefore stays unreliable by design;
 * this only removes the gratuitous loss of a verdict that is provably valid.
 *
 * Scope is deliberately narrow: only the two verdict blocks and the
 * incremental-review baseline (`lastReviewedTree`). `bypass`,
 * `taskMode`, change flags, scope limits and rounds always stay this
 * session's own — a foreign bypass or advisory mode must never leak in.
 */
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
}

/**
 * The UNION of two sessions' proxy decisions, oldest first.
 *
 * NOT a winner-takes-it like the verdict blocks beside it, and the difference is
 * a fact about what this record IS. A verdict is a binding on shared content, so
 * two of them cannot both be the answer; a proxy decision is TESTIMONY about
 * what happened to one session, and dropping one side would tell the user "these
 * were all of them" about a list that was not — the one thing this record cannot
 * get wrong.
 *
 * Deduped by (time, question, choice): the same decision arriving twice (a
 * re-merge of the same side, a relay successor) is still one decision.
 */
export function mergeProxyDecisions(
  mine: readonly ProxyDecisionRecord[] | undefined,
  theirs: readonly ProxyDecisionRecord[] | undefined,
): ProxyDecisionRecord[] {
  const out: ProxyDecisionRecord[] = [];
  const seen = new Set<string>();
  for (const record of [...(mine ?? []), ...(theirs ?? [])]) {
    const key = `${record.at}|${record.question}|${record.choice}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function mergeConcurrentBindings(
  mine: GateState,
  disk: GateState | undefined,
  currentDigest: () => string | null,
): GateState {
  if (!disk) return mine;
  // Round-8/9 P1: auxiliary diagnostic state merges INDEPENDENTLY of any
  // review/precommit candidate — a concurrent session's goal audits and
  // adviser baselines must survive this session's next persist even when
  // neither side carries a READY/PASS to inherit. When nothing aux is at
  // stake, keep the caller's own object (identity-stable: no copy needed).
  const hasAux =
    (disk.goalPrereview && (!mine.goalPrereview || disk.goalPrereview.at > mine.goalPrereview.at)) ||
    !!disk.goalPrereviewHistory?.length ||
    (disk.adviserBaselines && Object.keys(disk.adviserBaselines).length > 0);
  let merged = mine;
  if (hasAux) {
    merged = { ...mine };
    if (disk.goalPrereview && (!mine.goalPrereview || disk.goalPrereview.at > mine.goalPrereview.at)) {
      merged.goalPrereview = disk.goalPrereview;
    }
    if (disk.goalPrereviewHistory?.length) {
      merged.goalPrereviewHistory = mergeGoalPrereviewHistories(mine.goalPrereviewHistory, disk.goalPrereviewHistory);
    }
      if (disk.adviserBaselines && Object.keys(disk.adviserBaselines).length) {
        merged.adviserBaselines = mergeAdviserBaselines(mine.adviserBaselines, disk.adviserBaselines);
    }
  }
  // THE TESTIMONY MERGES FIRST, AND UNCONDITIONALLY (review round 7 P1).
  //
  // A proxy decision is not a binding to inherit — it is a record of what
  // happened to one session, and the three early returns below (two sessions
  // that reached no verdict, a fingerprint that moved on, a same-session
  // re-write) have nothing to say about it. Merging it at the END of this
  // function meant each of those returns threw the other side's record away,
  // and the user's completion report then claimed the surviving list was all of
  // them.
  //
  // IT IS WRITTEN BACK to `mine` as well (same finding): the caller's own
  // object is what the NEXT persist writes from, so a union that lives only in
  // the returned copy is undone by the very next save.
  const proxyUnion = mergeProxyDecisions(mine.proxyDecisions, disk.proxyDecisions);
  if (proxyUnion.length > 0) {
    mine.proxyDecisions = proxyUnion;
    merged = { ...merged, proxyDecisions: proxyUnion };
  }

  // Same session (or an unidentifiable file): our own last write — replace it.
  if (!disk.sessionId || disk.sessionId === mine.sessionId) return merged;

  const candidateReview =
    // PENDING = "no verdict yet". BLOCKED / NEEDS_HUMAN are verdicts, and a
    // concurrent session's READY does not overrule them.
    mine.review.verdict === "PENDING" &&
    disk.review.verdict === "READY" &&
    typeof disk.review.fingerprint === "string" &&
    disk.review.fingerprint.length > 0;
  const candidatePrecommit =
    // Likewise NOT_RUN only: FAIL and NO_CHECKS_RUN are results, not gaps.
    mine.precommit.verdict === "NOT_RUN" &&
    disk.precommit.verdict === "PASS" &&
    typeof disk.precommit.fingerprint === "string" &&
    disk.precommit.fingerprint.length > 0;
  if (!candidateReview && !candidatePrecommit) return merged;

  const digest = currentDigest();
  if (!digest) return merged;
  const keepReview = candidateReview && disk.review.fingerprint === digest;
  const keepPrecommit = candidatePrecommit && disk.precommit.fingerprint === digest;
  if (!keepReview && !keepPrecommit) return merged;

  return {
    ...merged,
    review: keepReview ? { ...disk.review } : mine.review,
    precommit: keepPrecommit ? { ...disk.precommit } : mine.precommit,
    // The incremental-review baseline must survive the carry-over too,
    // otherwise the next round is forced into a full review even though
    // the tree it describes was already reviewed.
    ...(keepReview && disk.lastReviewedTree ? { lastReviewedTree: disk.lastReviewedTree } : {}),
  };
}

/**
 * Union of two audit histories, deduped by (hash, verdict, at), oldest
 * first. A concurrent session's audits must not be erased by this session's
 * persist (round-8 P1).
 */
function mergeGoalPrereviewHistories(
  a: GoalPrereviewRecord[] | undefined,
  b: GoalPrereviewRecord[] | undefined,
): GoalPrereviewRecord[] {
  const seen = new Set<string>();
  const out: GoalPrereviewRecord[] = [];
  for (const rec of [...(a ?? []), ...(b ?? [])]) {
    const key = `${rec.hash}|${rec.verdict}|${rec.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
}

/**
 * Per-goal adviser baselines, merged key-by-key. `confirmed` counts VALID
 * conclusions and only grows, so the baseline with the higher count is the
 * newer one — a concurrent disk write must never overwrite a baseline THIS
 * session just advanced (round-10 P1: plain spread made the disk copy win
 * even when it was older).
 */
function mergeAdviserBaselines(
  a: Record<string, { tree: string; prevTree: string | null; confirmed: number }> | undefined,
  b: Record<string, { tree: string; prevTree: string | null; confirmed: number }> | undefined,
): Record<string, { tree: string; prevTree: string | null; confirmed: number }> {
  const out = { ...(a ?? {}), ...(b ?? {}) };
  for (const [key, mineVal] of Object.entries(a ?? {})) {
    const diskVal = b?.[key];
    if (diskVal && diskVal.confirmed < mineVal.confirmed) out[key] = mineVal;
  }
  return out;
}

/**
 * saveSidecar + mergeConcurrentBindings: the write path every live session
 * uses. Kept separate from saveSidecar so tests (and any caller that means
 * "persist exactly this") still have a verbatim write.
 *
 * A failed/corrupt read yields `undefined` from loadSidecar and therefore a
 * plain overwrite — identical to the behavior before this existed.
 */
export function saveSidecarPreservingConcurrent(
  path: string,
  state: GateState,
  currentDigest: () => string | null,
): void {
  saveSidecar(path, mergeConcurrentBindings(state, loadSidecar(path), currentDigest));
  // The caller's own object must still show a fresh timestamp: when the merge
  // returned a copy, saveSidecar stamped the copy, not `state`.
  state.updatedAt = new Date().toISOString();
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
    /**
     * Require a precommit run whose tests were NOT narrowed (`testScope`
     * `"full"`).
     *
     * The two lanes exist so a `git commit` does not have to re-run a whole
     * suite for a one-line fix: `fast` runs lint + typecheck + build + the
     * tests related to the changed files. That is a real check, but it is not
     * evidence the suite passes — so everything that PUBLISHES work
     * (`git push`, `gh pr create`/`edit`, and task completion) sets this and
     * demands a full run.
     *
     * Absent `testScope` on an older sidecar counts as NOT full: the
     * guarantee did not exist when it was written, so it cannot be claimed.
     */
    requireFullTests?: boolean;
    /**
     * Round-9 P1: trees of the commits between the last READY's reviewed
     * commit and HEAD that DIFFER from the reviewed tree. Non-empty ⇒
     * content no reviewer saw has entered the branch since the READY —
     * the reviewed tree still matches only if every later commit is a
     * no-content (squash) rewrite of the same tree. Computed by the caller
     * (this function is pure); absent ⇒ not checked (older callers).
     */
    unreviewedCommits?: string[];
  },
): string[] {
  if (!state) return ["gate state missing (fail-closed)"];
  // ANOTHER live session holds this worktree (lib/session-exclusivity.ts).
  // Checked before `bypass`, and it is the ONE requirement a bypass does not
  // clear: `/gate-bypass` is this session's authorization to ship its own
  // work, and the work here is not this session's to authorize — the sidecar,
  // the worktree and the review all belong to the session that holds it.
  if (state.exclusivityRefusal) return [state.exclusivityRefusal];
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
    } else if (opts?.unreviewedCommits && opts.unreviewedCommits.length > 0) {
      // Round-9 P1: the tree matches but content-changing commits landed
      // after the reviewed commit (a checkpoint that was never re-reviewed,
      // or a rebase that moved the reviewed point). HEAD's tree alone cannot
      // see them — a change-and-revert still shipped unreviewed content.
      problems.push(
        `unreviewed commits since the last READY review (${opts.unreviewedCommits.length} commit(s) with content no reviewer saw) — ` +
        "checkpoint the new work and run the next review round before shipping",
      );
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
      } else if (opts?.requireFullTests && state.precommit.testScope !== "full") {
        const covered = state.precommit.testScope ?? "unknown (sidecar predates the fast/full split)";
        problems.push(
          `this action requires a FULL precommit run (tests covered: ${covered}) — ` +
          "a fast run narrows the suite to the changed files, which is enough to commit but not to " +
          'publish; run the precommit runner again with mode "full"',
        );
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
