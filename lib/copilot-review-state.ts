/**
 * L7 — the Copilot requirement's STATE MACHINE: its statuses, the persisted
 * state, the transitions the extension drives (arm / request / release), the
 * unmet-requirement lines, and the sidecar validator.
 *
 * Split out of lib/copilot-review.ts, whose docblock explains the whole loop
 * and which keeps the evaluation (`analyzeCopilot` / `evaluateCopilot`) that
 * moves this state from observed evidence. Pure: `now` is injected and every
 * function returns a new value.
 */

/**
 * Lifecycle of one Copilot requirement.
 *
 *   ARMED       a PR-affecting ship was observed; no review requested yet
 *   AWAITING    a review was requested; Copilot has not answered yet. WHICH
 *               kind of not-answered is kept in `queue` — queued, working,
 *               failed or never landed (lib/copilot-watch.ts)
 *   OPEN        Copilot answered and left threads that still need work
 *   SATISFIED   every Copilot thread is resolved or answered
 *   UNSUPPORTED no PR / no gh / repo or account cannot do Copilot review
 *   EXHAUSTED   Copilot never answered within the wait budget — released,
 *               escalate to human (there is no round budget)
 *
 * The last three are terminal for the current cycle: they stop blocking
 * `declare_done`. A new PR-affecting ship re-arms from any of them (see
 * {@link armCopilotReview}) — that is what makes the loop a loop, and what
 * closes the "push first, open the PR afterwards" ordering hole.
 *
 * THE USER'S OWN TRIAGE rides along. From round 4 on, every actionable finding
 * is put to the user first (lib/copilot-triage.ts) and the answers are stored
 * on this state. They are about a piece of TEXT, not about a round, so they
 * survive every transition below — a finding already answered is never asked
 * about twice, and Copilot speaking again on the same thread produces a new
 * key and therefore a new question.
 */
import { sanitizeCopilotTriage, type CopilotTriageState } from "./copilot-triage.ts";
import { asRecord } from "./copilot-probe-parse.ts";

export type CopilotStatus =
  | "ARMED"
  | "AWAITING"
  | "OPEN"
  | "SATISFIED"
  | "UNSUPPORTED"
  | "EXHAUSTED";

const COPILOT_STATUSES: ReadonlySet<string> = new Set<CopilotStatus>([
  "ARMED", "AWAITING", "OPEN", "SATISFIED", "UNSUPPORTED", "EXHAUSTED",
]);

/** Statuses that no longer hold `declare_done` back. */
const RELEASED: ReadonlySet<CopilotStatus> = new Set<CopilotStatus>([
  "SATISFIED", "UNSUPPORTED", "EXHAUSTED",
]);

/**
 * There is NO cap on Copilot review cycles, on purpose.
 *
 * There used to be one (3 rounds, project-configurable). It was a third way to
 * finish a task with Copilot findings unhandled: on a PR where Copilot keeps
 * commenting, round 4 simply released the requirement. "Round 4 of a review
 * conversation" is not a reason to stop caring what the reviewer said, and
 * unlike a wait, another round costs nothing but the agent's own work — the
 * way out is always in the agent's hands (fix it, or reply why not).
 *
 * The loop still cannot run forever: it advances only when the agent pushes
 * new code, and every cycle that Copilot does not answer is bounded by
 * {@link COPILOT_AWAIT_TIMEOUT_MS}.
 */

/**
 * How long a QUEUED review may stay unanswered before the requirement is
 * released as EXHAUSTED.
 *
 * MEASURED, not guessed (server-service-dashboard PR #592, 50 paired rounds,
 * 2026-09-14): request → review has a median of 15.8 minutes, a p90 of 19.4
 * and a maximum of 23.4. Copilot's own run also fails at ~20.1 minutes
 * ({@link CopilotQueueEvidence.workFailedAt}, 4 occurrences in the same
 * sample). The previous 20-minute budget sat exactly on that p90, so a tenth
 * of the rounds released the requirement seconds before the review it was
 * waiting for arrived — and could not tell a broken run from silence.
 *
 * This is still the ONLY time budget, and it is still the one that cannot
 * drop feedback. What keeps a repo where nothing ever happens from spending
 * it is no longer the clock but the EVIDENCE (`lib/copilot-watch.ts`): a
 * request that never shows up as queued is given only that module's grace
 * window, and a failed run ends the wait outright.
 */
export const COPILOT_AWAIT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Tolerance when comparing OUR local timestamps against GitHub's. Only used
 * for the timestamp fallback — the primary "this review covers the current
 * code" test compares commit SHAs and needs no clock at all.
 */
export const COPILOT_CLOCK_SKEW_MS = 2 * 60 * 1000;

export interface CopilotReviewState {
  status: CopilotStatus;
  /** PR number the requirement tracks; null until a PR was resolved. */
  pr: number | null;
  /** ISO time the requirement was armed by a PR-affecting ship. */
  armedAt: string;
  /** ISO time the EXTENSION requested the review (never agent-supplied). */
  requestedAt?: string;
  /**
   * ISO time of the FIRST request in this cycle. The wait budget is anchored
   * here, not on `requestedAt`: re-requesting must not push the deadline out,
   * or an agent that keeps calling `request_copilot_review` could wait forever
   * on a repo where Copilot never answers.
   */
  firstRequestedAt?: string;
  /** PR head SHA the current cycle was requested against / satisfied at. */
  head?: string;
  /**
   * Copilot review cycles since the requirement was first armed. Bookkeeping
   * only — nothing caps it (see COPILOT_AWAIT_TIMEOUT_MS).
   */
  rounds: number;
  /** ISO time of the last transition. */
  at?: string;
  /** Human-readable explanation of the last transition. */
  note?: string;
  /** Threads still needing work at the last check (status OPEN). */
  openThreads?: number;
  /**
   * The LAST thing the queue probe said about this cycle's request, and when.
   * Persisted for two readers: `/gate-status` ("is it queued or is Copilot
   * working on it?") and the tool reply's elapsed-time line. Never a verdict
   * on its own — it is one observation, and the next probe overwrites it.
   */
  queue?: CopilotQueueObservation;
  /**
   * The cycle's ONE recovery re-request has been spent — after a run that
   * FAILED, or a request GitHub never queued. A second breakage in the same
   * cycle releases the requirement instead of asking a third time.
   */
  breakageRetried?: boolean;
  /**
   * Sticky memory of a CONFIRMED availability probe (a real Copilot review was
   * seen on this PR or in the repo's recent PRs). Cached because the evidence
   * is monotonic — a repository that has done a Copilot review can do one —
   * so later cycles skip the history query entirely. Never set from an
   * ASSUMED (owner allow-list) decision: an allow-list entry is a policy, not
   * evidence, and must stay re-evaluable when the policy changes.
   */
  supportConfirmed?: boolean;
  /**
   * L7 triage (from round {@link COPILOT_TRIAGE_ASK_FROM_ROUND} on): the
   * user's per-finding answers, keyed by thread + last comment. Absent until
   * the first finding is put to them.
   */
  triage?: CopilotTriageState;
}

/**
 * A PR-affecting ship happened: (re)open a Copilot cycle.
 *
 * This deliberately overrides EVERY terminal status. Without that, the most
 * common ordering — push the branch, then open the PR — would resolve to
 * UNSUPPORTED ("no PR yet") on the push and stay there, and the feature would
 * be bypassed by the normal way people work. `rounds` stays cumulative across
 * re-arms so the count reads as "how long has this conversation been going",
 * not "how many times was the counter reset".
 */
export function armCopilotReview(
  prev: CopilotReviewState | undefined,
  nowIso: string,
): CopilotReviewState {
  return {
    status: "ARMED",
    pr: prev?.pr ?? null,
    armedAt: nowIso,
    rounds: prev?.rounds ?? 0,
    // Availability evidence survives re-arming: it is a fact about the
    // repository, not about this cycle.
    ...(prev?.supportConfirmed ? { supportConfirmed: true } : {}),
    // So does the triage: those answers are about findings, not about this
    // round, and re-asking a question the user already answered is exactly
    // the behaviour this feature exists to avoid.
    ...(prev?.triage ? { triage: prev.triage } : {}),
    at: nowIso,
    note: "PR created or updated — a Copilot review round is due",
  };
}

/** The extension requested a review: stamp the authoritative time + head. */
export function recordCopilotRequest(
  prev: CopilotReviewState | undefined,
  args: {
    pr: number | null;
    head: string | null;
    nowIso: string;
    note?: string;
    supportConfirmed?: boolean;
    /**
     * What the request-time confirmation probe saw. Recorded with the
     * request so a later reader (`/gate-status`, the next tool call) does not
     * have to re-ask GitHub whether the request was ever queued.
     */
    queue?: CopilotQueueObservation;
    /**
     * This request RECOVERS from a breakage — a run that failed, or a request
     * GitHub never queued — and spends the cycle's one retry. A broken run
     * also gets a FRESH wait budget: the first one was spent on Copilot's own
     * failure, and charging the retry for it would cut it off mid-review
     * (measured median 15.8 minutes). A request that never landed consumed
     * nothing to recover, so it does not reset the clock.
     */
    afterBreakage?: "failed" | "not-landed";
  },
): CopilotReviewState {
  return {
    status: "AWAITING",
    pr: args.pr,
    armedAt: prev?.armedAt ?? args.nowIso,
    requestedAt: args.nowIso,
    // Anchor the wait budget on the first request of this cycle. Older
    // sidecars have no `firstRequestedAt`; their `requestedAt` is that anchor.
    firstRequestedAt: args.afterBreakage === "failed"
      ? args.nowIso
      : (prev?.firstRequestedAt ?? prev?.requestedAt ?? args.nowIso),
    ...(args.head ? { head: args.head } : {}),
    rounds: (prev?.rounds ?? 0) + 1,
    ...(args.supportConfirmed || prev?.supportConfirmed ? { supportConfirmed: true } : {}),
    ...(prev?.triage ? { triage: prev.triage } : {}),
    ...(args.queue ? { queue: args.queue } : {}),
    ...(args.afterBreakage || prev?.breakageRetried ? { breakageRetried: true } : {}),
    at: args.nowIso,
    note: args.note ?? "Copilot review requested",
  };
}

/**
 * Terminal transition (release the requirement) with an explanation.
 *
 * `openThreads` is carried into the terminal state on purpose: releasing with
 * Copilot findings still unhandled is allowed (nothing may strand a task), but
 * the count has to survive the release. It is the ONLY thing that survives on
 * the paths that matter — the PR is gone, `gh` lost its credentials, the API
 * refused, so there is no payload left to list from — and the extension turns
 * it into the "you are abandoning N findings, tell the user" line those paths
 * used to be silent about.
 */
export function releaseCopilotReview(
  prev: CopilotReviewState | undefined,
  status: "SATISFIED" | "UNSUPPORTED" | "EXHAUSTED",
  note: string,
  nowIso: string,
  head?: string | null,
  openThreads?: number,
): CopilotReviewState {
  const boundHead = head ?? prev?.head ?? null;
  const unhandled = openThreads ?? prev?.openThreads;
  return {
    status,
    pr: prev?.pr ?? null,
    armedAt: prev?.armedAt ?? nowIso,
    ...(prev?.requestedAt ? { requestedAt: prev.requestedAt } : {}),
    ...(prev?.firstRequestedAt ? { firstRequestedAt: prev.firstRequestedAt } : {}),
    ...(boundHead ? { head: boundHead } : {}),
    rounds: prev?.rounds ?? 0,
    ...(prev?.supportConfirmed ? { supportConfirmed: true } : {}),
    ...(prev?.triage ? { triage: prev.triage } : {}),
    ...(typeof unhandled === "number" ? { openThreads: unhandled } : {}),
    at: nowIso,
    note,
  };
}

/**
 * What an unanswered request is actually doing, in one word. The VERDICT that
 * produces it, and the evidence it is drawn from, live in lib/copilot-watch.ts
 * — this module owns the cycle, that one owns the wait.
 */
export type CopilotWaitState = "working" | "queued" | "failed" | "not-landed" | "unknown";

/**
 * The same words, as a set — the validator needs to reject a garbled
 * persisted value.
 */
const COPILOT_WAIT_STATES: ReadonlySet<string> = new Set<CopilotWaitState>([
  "working", "queued", "failed", "not-landed", "unknown",
]);

/** One persisted observation of the queue probe. */
export interface CopilotQueueObservation {
  state: CopilotWaitState;
  /** ISO time of the observation. */
  at: string;
  /** ISO time Copilot's run started, when the timeline showed one. */
  startedAt?: string;
}

/** Does this state still hold `declare_done` back? */
export function isCopilotOutstanding(state: CopilotReviewState | undefined): boolean {
  if (!state) return false;
  return !RELEASED.has(state.status);
}

/**
 * The unmet-requirement lines for `declare_done` / the L2 continuation.
 * Empty when nothing is outstanding. Never used by the ship gate.
 */
export function copilotProblems(state: CopilotReviewState | undefined): string[] {
  if (!isCopilotOutstanding(state) || !state) return [];
  const pr = state.pr === null ? "the PR" : `PR #${state.pr}`;
  switch (state.status) {
    case "ARMED":
      return [`Copilot code review not requested for ${pr} — call copilot_review`];
    case "AWAITING":
      return [
        `Copilot code review of ${pr} has not come back yet — call copilot_review ` +
        "(the call itself blocks until the review lands; do not end the turn to wait for it)",
      ];
    case "OPEN":
      return [
        `${state.openThreads ?? 0} Copilot review thread(s) on ${pr} still need work — fix and ` +
        "resolve them, or reply in the thread with the reason it will not be fixed, then call " +
        "copilot_review",
      ];
    default:
      return [];
  }
}

/**
 * Sidecar validation.
 *
 * Direction of failure is chosen per field, always toward "more work, not
 * less": an unrecognized status becomes ARMED (a cycle that must still be
 * proven) rather than SATISFIED, a missing round count becomes 0 only for the
 * counter — never for the status — and a payload that is not an object at all
 * disappears entirely (there is nothing to re-arm from; the next PR ship arms
 * a fresh cycle). Nothing here can reject the whole sidecar: this field must
 * never be able to brick the ship gate it deliberately stays out of.
 */
export function sanitizeCopilotState(raw: unknown): CopilotReviewState | undefined {
  const obj = asRecord(raw);
  if (!obj) return undefined;
  const status = typeof obj.status === "string" && COPILOT_STATUSES.has(obj.status)
    ? obj.status as CopilotStatus
    : "ARMED";
  const rounds = typeof obj.rounds === "number" && Number.isInteger(obj.rounds) && obj.rounds >= 0
    ? obj.rounds
    : 0;
  const out: CopilotReviewState = {
    status,
    pr: typeof obj.pr === "number" && Number.isInteger(obj.pr) && obj.pr > 0 ? obj.pr : null,
    armedAt: typeof obj.armedAt === "string" ? obj.armedAt : "",
    rounds,
  };
  if (typeof obj.requestedAt === "string") out.requestedAt = obj.requestedAt;
  if (typeof obj.firstRequestedAt === "string") out.firstRequestedAt = obj.firstRequestedAt;
  if (typeof obj.head === "string" && obj.head.length > 0) out.head = obj.head;
  if (typeof obj.at === "string") out.at = obj.at;
  if (typeof obj.note === "string") out.note = obj.note.slice(0, 500);
  if (typeof obj.openThreads === "number" && Number.isInteger(obj.openThreads) && obj.openThreads >= 0) {
    out.openThreads = obj.openThreads;
  }
  // Only `true` survives: a forged or garbled value must not be able to claim
  // evidence that was never gathered. Claiming CONFIRMED costs waiting time,
  // never correctness, but the field should still mean what it says.
  if (obj.supportConfirmed === true) out.supportConfirmed = true;
  // The queue observation is re-derivable (it is one probe), so a garbled one
  // is dropped rather than repaired: the wait's verdict reads a missing
  // observation as "unknown", which waits instead of acting.
  const queue = asRecord(obj.queue);
  const queueState = queue?.state;
  if (
    typeof queueState === "string" &&
    (COPILOT_WAIT_STATES as ReadonlySet<string>).has(queueState) &&
    typeof queue?.at === "string"
  ) {
    out.queue = {
      state: queueState as CopilotWaitState,
      at: queue.at,
      ...(typeof queue.startedAt === "string" ? { startedAt: queue.startedAt } : {}),
    };
  }
  if (obj.breakageRetried === true) out.breakageRetried = true;
  // Dropped whole when nothing in it is readable: an empty triage block means
  // "no finding was decided yet", which asks the user again — the safe
  // direction. The OTHER direction (keeping a garbled record) would fix code
  // nobody approved.
  const triage = sanitizeCopilotTriage(obj.triage);
  if (triage) out.triage = triage;
  return out;
}
