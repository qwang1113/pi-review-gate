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
import { FINGERPRINT_VERSION } from "./fingerprint.ts";
import { sanitizeCopilotState, type CopilotReviewState } from "./copilot-review.ts";
import type { GoalPrereviewRecord, LoopGoalConfirmation } from "./loop-goal.ts";
import { TEST_SCOPES, type TestScope } from "./precommit-receipt.ts";

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
   * DIAGNOSTIC INPUT only, like `lastReadyReview` — it never feeds the ship
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
  lastReadyReview?: {
    treeOid: string;
    files?: string[];
    at: string;
  };
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
   * advisory ONLY for a user-chosen explore/normal ("user" — confirmed
   * dialog or /gate-mode); an agent/auto selection ("auto") never weakens
   * the hook. Absent ⇒ treated as "auto" (fail-closed — older sidecars keep
   * the full gate).
   */
  taskModeSource?: TaskModeSource;
  /**
   * sd0x-dev-flow R10 ("Think Harder") port: whether the one-shot strategic
   * reset checklist has fired for this state lifetime. Optional so schema-1
   * sidecars written by older versions still validate; absent ⇒ not fired.
   */
  strategicResetFired?: boolean;
  /**
   * Agent-requested loop pause (pause_for_question tool): the agent hit a
   * genuine blocker only the user can resolve, so L2 auto-continuation is
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
   * USER-GRANTED review-scope limit (request_scope_limit tool): the user
   * confirmed via an extension-rendered dialog that the gate only needs to
   * cover THIS session's own edits — pre-existing worktree/branch changes
   * stop arming it. `preexistingFiles` snapshots the changed files exempted
   * at grant time, so every re-arm path (session_start P0-2, bash git
   * re-arm, turn_end reconciliation) exempts exactly those files — and a
   * file this session later edits is RECLAIMED (removed) from the snapshot
   * by the edit handler: the grant never covers the session's own work.
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
   * time, written only by record_goal_prereview after the EXTENSION parsed the
   * auditor's JSON fence — never an agent-attested boolean).
   *
   * Absent ⇒ the draft was never audited: propose_loop_goal refuses to show
   * the approval dialog. Like {@link loopGoal} it stays out of
   * {@link unmetRequirements} — the git hooks cannot show a dialog, so a
   * pre-review requirement there could never be unblocked.
   */
  goalPrereview?: GoalPrereviewRecord;
  /**
   * L8b audit HISTORY (goal criterion 2): every goal-auditor audit ever
   * recorded, PASS or FAIL, oldest first — `goalPrereview` above is only the
   * latest record. Persisted so a re-audit chain is inspectable (and the
   * per-draft carryover data survives) even after newer drafts replaced the
   * singular record.
   */
  goalPrereviewHistory?: GoalPrereviewRecord[];
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

export function sidecarPath(cwd: string, configDirName = ".pi"): string {
  return join(cwd, configDirName, "review-gate-state.json");
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
    // Incremental-review baseline. `treeOid` is handed to `git diff` as an
    // ARGUMENT, so an unvalidated string from a tampered (or simply
    // repo-committed) sidecar would be git option injection — `--output=…`
    // and friends. Accept only a real object id; drop the whole field
    // otherwise, which just means the next round is a full review.
    if (parsed.lastReadyReview !== undefined) {
      const b = parsed.lastReadyReview as Record<string, unknown> | null;
      const validOid = typeof b?.treeOid === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(b.treeOid);
      const validFiles = b?.files === undefined ||
        (Array.isArray(b.files) && b.files.every((f: unknown) => typeof f === "string"));
      if (!b || typeof b !== "object" || Array.isArray(b) || !validOid || !validFiles || typeof b.at !== "string") {
        delete parsed.lastReadyReview;
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
  mkdirSync(dirname(path), { recursive: true });
  // Atomic write: temp + rename, so a crashed write can't leave a truncated
  // JSON that a fail-open parser might half-read.
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
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
 * incremental-review baseline (`lastReadyReview`). `bypass`,
 * `taskMode`, change flags, scope limits and rounds always stay this
 * session's own — a foreign bypass or advisory mode must never leak in.
 */
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
    ...(keepReview && disk.lastReadyReview ? { lastReadyReview: disk.lastReadyReview } : {}),
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
