/**
 * L7 — the Copilot code-review loop that runs AFTER a PR exists.
 *
 * WHY THIS EXISTS. Every other layer of this gate stops at the moment the PR
 * is opened: review READY + precommit PASS, and `gh pr create` is allowed
 * through. What GitHub Copilot then says about the PR was nobody's job. This
 * module models the missing tail of the workflow: once a PR is created or
 * updated, a Copilot review must be requested, waited for, and *worked off* —
 * every thread either fixed and resolved, or answered with the reason it is
 * not being fixed.
 *
 * WHERE IT IS ALLOWED TO BITE. Deliberately NOT in `unmetRequirements()`
 * (lib/gate-state.ts), the single ship authority read by both the tool_call
 * ship gate and the L3 git hooks. Fixing a Copilot finding requires a commit
 * and a push, so a Copilot requirement that blocked commits would block its
 * own remedy — a deadlock. It binds to "is the task finished?" instead:
 * `declare_done` and the L2 auto-continuation.
 *
 * WHAT IT CAN AND CANNOT PROVE. The extension gathers the facts itself (the
 * agent never reports its own review outcome), so "a Copilot review exists"
 * and "these threads are unresolved" are trustworthy. What it cannot judge is
 * the SUBSTANCE of a reply: a thread answered with "won't fix: out of scope"
 * and one answered with "ok" are structurally identical. That limit is
 * inherent to the user's own rule ("explain why, then move on") and is
 * documented rather than pretended away — same philosophy as the docSync
 * attestation, which trusts the reviewer's judgement instead of counting
 * touched files.
 *
 * HOW "IS COPILOT AVAILABLE HERE?" IS DECIDED. GitHub exposes NO capability
 * API for Copilot code review, and — measured, not assumed — the REQUEST
 * surface reports success even where the request is silently dropped:
 * `gh pr edit --add-reviewer @copilot` exits 0 and REST
 * `POST .../requested_reviewers` answers 200 on a repository that then shows
 * `reviewRequests.totalCount == 0`, no `ReviewRequestedEvent` in the timeline,
 * and no review at all. So neither the exit code nor a bare `reviewRequests`
 * read-back can decide this. Only POSITIVE evidence counts, in this order:
 *
 *   CONFIRMED  a Copilot review or Copilot thread exists on THIS PR, or the
 *              repository's recent PRs contain one (COPILOT_HISTORY_QUERY)
 *   ASSUMED    the repository owner is on the configured owner allow-list
 *   UNKNOWN    neither — treated as "not available", released without waiting
 *
 * UNKNOWN releases instead of waiting because the user's rule is explicit:
 * a repo that cannot do this must not cost the task 20 minutes of polling.
 * The cost of the heuristic is bounded and self-healing: one real Copilot
 * review anywhere in the repo's recent PRs flips it to CONFIRMED forever.
 *
 * WHAT THE REQUEST READ-BACK *IS* GOOD FOR (2026-09-14, measured on
 * server-service-dashboard PR #592). The paragraph above killed the read-back
 * as a VETO and it stays dead — an empty `reviewRequests` right after the call
 * proves nothing, because GitHub has not registered it yet. Read against the
 * CLOCK it becomes the opposite kind of evidence, and read positively:
 * `reviewRequests` listing `copilot-pull-request-reviewer` (the pending dot on
 * the PR page; REST `requested_reviewers` never shows it remember) is proof the
 * request WAS queued, and the timeline's `copilot_work_started` follows within
 * 63 seconds (median 35s over 51 requests). So a request that still shows
 * neither of those after the grace window was dropped, and one
 * that shows them is worth waiting for — which is exactly what
 * `lib/copilot-watch.ts`'s `decideCopilotWait` answers. The failure event
 * (`copilot_work_finished_failure`, observed at ~20.1 minutes) is the third
 * state, and the one no amount of waiting can recover from.
 *
 * PURITY. No IO, no clock, no throwing: payloads arrive as strings, `now` is
 * injected, and every function returns a new value. The extension owns `gh`,
 * the timers and the storage; this module owns the rules.
 *
 * WHERE THE PARTS LIVE. This file keeps the EVALUATION — classifying a
 * payload and advancing the state from it. The state machine itself is
 * lib/copilot-review-state.ts; the queries and the tolerant payload parsers
 * are lib/copilot-probe-parse.ts.
 */
import {
  armCopilotReview,
  COPILOT_AWAIT_TIMEOUT_MS,
  COPILOT_CLOCK_SKEW_MS,
  releaseCopilotReview,
  type CopilotReviewState,
} from "./copilot-review-state.ts";
import {
  isCopilotAuthor,
  type CopilotPayload,
  type CopilotSupport,
  type CopilotThread,
} from "./copilot-probe-parse.ts";

export interface CopilotAnalysis {
  /** Copilot has reviewed the code this cycle is about. */
  reviewed: boolean;
  /** Copilot threads that are unresolved AND waiting on us. */
  actionable: CopilotThread[];
  /** Unresolved Copilot threads we already replied to (accepted as explained). */
  answered: number;
  /** Resolved Copilot threads. */
  resolved: number;
  /** Current PR head, straight from the payload. */
  head: string | null;
  /**
   * Copilot has touched this PR at all (any review, any thread, any age).
   * Availability evidence — deliberately NOT tied to the current cycle.
   */
  present: boolean;
}

function parseTime(value: string | null | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Classify what Copilot has done for this cycle.
 *
 * "Reviewed" is anchored on the COMMIT first (a Copilot review submitted
 * against the current head proves it saw this code, with no clock involved),
 * and only falls back to timestamps — with a skew tolerance — when the payload
 * carries no commit. If the anchor time itself is unparseable, ONLY the
 * commit-anchored proof counts; guessing there would be the one direction that
 * can wave a cycle through unreviewed.
 *
 * "Actionable" is a thread Copilot started, that is unresolved, and whose most
 * recent comment is still Copilot's — i.e. the ball is in our court. A thread
 * we answered counts as handled even while unresolved (the user's rule: an
 * explanation is a valid outcome), and Copilot commenting again after our
 * reply flips it back to actionable, which is exactly right. `isOutdated` does
 * NOT excuse a thread: code moving is not the same as the concern being
 * addressed — it is surfaced to the agent as a hint instead.
 *
 * Note what "actionable" deliberately does NOT depend on: which commit the
 * review was submitted against, and whether `reviewed` is true for this cycle.
 * An unanswered Copilot finding stays the agent's business after a push —
 * GitHub does not re-review a new head by default, so the old thread is
 * frequently the ONLY feedback that exists, and scoping it to the current
 * head is precisely how findings used to be dropped on the floor.
 */
export function analyzeCopilot(
  payload: CopilotPayload,
  opts: { anchorAt: string | undefined },
): CopilotAnalysis {
  const anchorMs = parseTime(opts.anchorAt);
  const head = payload.head;

  const copilotReviews = payload.reviews.filter((r) => isCopilotAuthor(r.author));
  const copilotThreads = payload.threads.filter((t) => isCopilotAuthor(t.author));

  const commitAnchored = head !== null && copilotReviews.some((r) => r.commit === head);
  const timeAnchored = anchorMs !== undefined && (
    copilotReviews.some((r) => {
      const ms = parseTime(r.submittedAt);
      return ms !== undefined && ms >= anchorMs - COPILOT_CLOCK_SKEW_MS;
    }) ||
    copilotThreads.some((t) => {
      const ms = parseTime(t.createdAt);
      return ms !== undefined && ms >= anchorMs - COPILOT_CLOCK_SKEW_MS;
    })
  );

  const unresolved = copilotThreads.filter((t) => !t.isResolved);
  const actionable = unresolved.filter((t) => isCopilotAuthor(t.lastAuthor));

  return {
    reviewed: commitAnchored || timeAnchored,
    actionable,
    answered: unresolved.length - actionable.length,
    resolved: copilotThreads.length - unresolved.length,
    head,
    present: copilotReviews.length > 0 || copilotThreads.length > 0,
  };
}

/**
 * Advance the state machine from a fresh analysis.
 *
 * Terminal statuses come FIRST, because a released cycle is a decision that
 * has already been made and re-deciding it is how a finished requirement comes
 * back from the dead. `EXHAUSTED` (the budget is spent) and `UNSUPPORTED` (the
 * repo cannot do this at all) are never re-opened by *observation*: this
 * function will not move them, whatever the payload says. Re-opening is an
 * explicit act — a new PR-affecting ship calling {@link armCopilotReview}, or
 * the agent deliberately calling `copilot_review` again. Observed for
 * real: a released cycle was re-classified as ARMED by
 * the very next check, and `declare_done` was blocked by a requirement that
 * had already been let go.
 * `SATISFIED` keeps its safety net at THIS layer: it only survives while it
 * still describes the code that was reviewed, so a head that moved under it
 * re-arms. Note that the extension short-circuits every released status before
 * calling this, so that branch is currently defense in depth (a rule of the
 * state machine) rather than a path the tools can reach — in practice the
 * re-arm comes from the ship.
 *
 * Then, in order, the fail-safe priorities:
 *  1. threads waiting on us ⇒ OPEN — FIRST, ahead of head drift and ahead of
 *     the wait budget. An unanswered Copilot finding is work the agent can
 *     always do (reply or resolve; Copilot's participation is not required),
 *     so this can never deadlock, and putting it anywhere lower is what let a
 *     push bury real findings: the head moved, `reviewed` went false, and the
 *     thread stopped being counted at all;
 *  2. head drift — the PR moved and nothing is pending on us, so this cycle's
 *     evidence is stale and a new request is due (ARMED). There is no round
 *     cap on this: as long as Copilot keeps finding things, the loop keeps
 *     going;
 *  3. no review yet ⇒ AWAITING, unless availability is UNKNOWN (nothing has
 *     ever shown Copilot works here) in which case the requirement is
 *     released immediately as UNSUPPORTED rather than burning the wait
 *     budget, or the wait budget already ran out ⇒ EXHAUSTED;
 *  4. otherwise ⇒ SATISFIED, bound to the head it was verified against.
 */
export function evaluateCopilot(
  state: CopilotReviewState,
  analysis: CopilotAnalysis,
  opts: {
    nowIso: string;
    now: number;
    /**
     * What the availability evidence says (see {@link decideCopilotSupport}).
     * Defaults to CONFIRMED so a caller that cannot probe keeps the
     * "wait for the review" behaviour instead of releasing early.
     */
    support?: CopilotSupport;
  },
): CopilotReviewState {
  const headMoved = Boolean(state.head && analysis.head && state.head !== analysis.head);
  const support = opts.support ?? "CONFIRMED";

  if (state.status === "EXHAUSTED" || state.status === "UNSUPPORTED") return state;
  if (state.status === "SATISFIED" && !headMoved && analysis.actionable.length === 0) return state;

  if (analysis.actionable.length > 0) {
    return {
      ...state,
      status: "OPEN",
      at: opts.nowIso,
      openThreads: analysis.actionable.length,
      note: `${analysis.actionable.length} Copilot thread(s) waiting on a fix, a resolve, or a reply`,
    };
  }

  if (headMoved) {
    return {
      ...armCopilotReview(state, opts.nowIso),
      pr: state.pr,
      note: "the PR head moved since the review was requested — request a fresh Copilot review",
      openThreads: 0,
    };
  }

  // NOTE: no round cap here. Deleted deliberately — see the comment on
  // COPILOT_AWAIT_TIMEOUT_MS. "We have been round this loop N times" was
  // never a reason to stop handling what the reviewer said, and every round
  // costs only the agent's own work.

  if (!analysis.reviewed) {
    // Nothing has ever demonstrated that Copilot reviews here, and the owner
    // is not on the allow-list: waiting out the full budget would spend the
    // user's time to learn nothing. Release now and say what would change the
    // answer.
    if (support === "UNKNOWN") {
      return releaseCopilotReview(
        state,
        "UNSUPPORTED",
        "no Copilot review has ever appeared on this repository's recent PRs and its owner is not " +
        "on the Copilot owner allow-list — treating Copilot code review as unavailable instead of " +
        "waiting; add the owner to copilotReview.owners in .pi/review-gate.json if that is wrong",
        opts.nowIso,
        null,
        0,
      );
    }
    // Anchored on the FIRST request of this cycle (falling back to the last
    // one for sidecars written before that field existed): re-requesting must
    // never buy more waiting time.
    const requestedMs = parseTime(state.firstRequestedAt ?? state.requestedAt);
    if (requestedMs !== undefined && opts.now - requestedMs > COPILOT_AWAIT_TIMEOUT_MS) {
      return releaseCopilotReview(
        state,
        "EXHAUSTED",
        "Copilot did not answer the review request within the wait budget — the repository or " +
        "account may not have Copilot code review enabled; escalate to the user",
        opts.nowIso,
        null,
        0,
      );
    }
    return {
      ...state,
      status: state.requestedAt ? "AWAITING" : "ARMED",
      at: opts.nowIso,
      note: state.requestedAt
        ? "Copilot has not posted its review yet — copilot_review blocks until it lands"
        : "no Copilot review of this PR yet — call copilot_review to request one",
      openThreads: 0,
    };
  }

  return {
    ...releaseCopilotReview(
      state,
      "SATISFIED",
      `every Copilot thread handled (${analysis.resolved} resolved, ${analysis.answered} answered)`,
      opts.nowIso,
      analysis.head,
      0,
    ),
    openThreads: 0,
  };
}
