/**
 * The QUEUE PROBE of `copilot_review` (lib/copilot-review-tools.ts): is an
 * outstanding Copilot review request queued, working, broken, or not there at
 * all — and, when it is broken, the one recovery a cycle gets.
 *
 * Split out of the tool module so the tool file keeps only the tool body and
 * its registration. The wait's VERDICT is still `decideCopilotWait`
 * (lib/copilot-watch.ts); this module gathers the evidence it is judged on
 * and acts on what it says.
 */

import type { ToolReply } from "./tool-host.ts";
import type { GateState } from "./gate-state.ts";
import { ghError } from "./copilot-gh.ts";
import {
  COPILOT_AWAIT_TIMEOUT_MS,
  recordCopilotRequest,
  type CopilotQueueObservation,
  type CopilotReviewState,
  type CopilotWaitState,
} from "./copilot-review-state.ts";
import type { CopilotProbe, CopilotTimeline, PrSummary } from "./copilot-probe-parse.ts";
import {
  decideCopilotWait,
  type CopilotQueueEvidence,
  type CopilotWaitVerdict,
} from "./copilot-watch.ts";
import { releaseReply } from "./copilot-review-replies.ts";
import type { CopilotReviewToolDeps } from "./copilot-review-tools.ts";

/**
 * How the tool confirms that GitHub actually QUEUED the review request.
 *
 * This replaced a poll that could not work. The old in-tool poll waited
 * 3 × 20 seconds for the REVIEW to appear, against a measured median of 15.8
 * minutes (min 4.0 over 50 paired rounds on a 10k-line PR) — a 60-second window
 * that essentially never contains the answer. The queue flag is the part that
 * DOES arrive fast: `review_requested` landed within 63 seconds of every one of
 * the 51 measured requests (median 35s). So the wait is now spent on the
 * question that resolves in a minute — "did GitHub take it?" — and the review
 * itself is left to the blocking wait (`runCopilotReview`).
 *
 * 6 × 15s = 90s = `COPILOT_LANDING_GRACE_MS`: the same window
 * `decideCopilotWait` uses to conclude that a request was dropped, so the tool
 * and the state machine cannot disagree about what "too late" means.
 */
export const COPILOT_CONFIRM_ATTEMPTS = 6;
export const COPILOT_CONFIRM_DELAY_MS = 15_000;
/** The retry after a dropped request gets a shorter window (see `confirmQueued`). */
export const COPILOT_CONFIRM_RETRY_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// The queue probe: is this request queued, working, broken or not there at all?
// ---------------------------------------------------------------------------

/** Milliseconds since an ISO time, or null when it cannot be read. */
export function waitedSince(iso: string | undefined, now: number): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.max(0, now - ms);
}

export function waitedMinutes(ms: number | null): string {
  return ms === null ? "an unknown time" : `${(ms / 60_000).toFixed(1)} minutes`;
}

/**
 * The evidence the wait is judged on, assembled from every source that is
 * already in hand: the live `queued` answer from the light probe, and the
 * timeline facts remembered on the state (a `copilot_work_started` does not
 * un-happen, so an observation from an earlier call still describes this
 * cycle — until a new cycle re-arms and drops it).
 */
function waitEvidence(
  probe: CopilotProbe | undefined,
  timeline: CopilotTimeline | undefined,
  state: CopilotReviewState,
): CopilotQueueEvidence {
  const rememberedFailed = state.queue?.state === "failed";
  return {
    // A failed probe is "could not read", never "no".
    queued: probe ? probe.queued : null,
    workStartedAt: timeline?.workStartedAt ?? state.queue?.startedAt ?? null,
    workFailedAt: timeline?.workFailedAt ?? (rememberedFailed ? state.queue?.at ?? null : null),
  };
}

/** The observation to persist from a verdict + the evidence it was drawn from. */
export function observationOf(
  state: CopilotWaitState,
  evidence: CopilotQueueEvidence,
  nowIso: string,
): CopilotQueueObservation {
  return {
    state,
    at: nowIso,
    ...(evidence.workStartedAt ? { startedAt: evidence.workStartedAt } : {}),
  };
}

/**
 * Poll until GitHub shows the request as QUEUED (the pending-reviewer dot), up
 * to `attempts` × {@link COPILOT_CONFIRM_DELAY_MS}.
 *
 * Returns as soon as the flag appears — that is the median-35-second case — so
 * the common path costs a couple of light queries, not the whole window. A
 * timeline probe is spent once, when the queue flag first shows up, to answer
 * the question the flag cannot: has Copilot STARTED (the spinner state) or is
 * it merely queued?
 */
export async function confirmQueued(args: {
  deps: CopilotReviewToolDeps;
  dir: string;
  slug: string;
  prNumber: number;
  requestedAt: string;
  signal: AbortSignal | undefined;
  progress: { step(message: string): void };
  attempts: number;
}): Promise<{ queued: boolean | null; timeline: CopilotTimeline | undefined; startedAt: string | null }> {
  const { deps, dir, slug, prNumber, signal } = args;
  /** Did the LAST probe actually answer? A probe that never ran is not "no". */
  let readable = false;
  for (let attempt = 0; attempt < args.attempts; attempt++) {
    if (signal?.aborted) break;
    const probe = await deps.gh.fetchCopilotProbe(dir, slug, prNumber, signal);
    if (probe !== undefined) readable = true;
    if (probe?.queued === true) {
      args.progress.step("已排队 —— 读时间线确认 Copilot 是否已开工");
      const timeline = signal?.aborted
        ? undefined
        : await deps.gh.fetchCopilotTimeline(dir, slug, prNumber, signal);
      return { queued: true, timeline, startedAt: timeline?.workStartedAt ?? null };
    }
    if (attempt < args.attempts - 1) {
      args.progress.step(`等待 GitHub 记录这次请求（第 ${attempt + 1}/${args.attempts} 次）`);
      await deps.delay(COPILOT_CONFIRM_DELAY_MS);
    }
  }
  // Never saw the flag. Read the timeline once before concluding "dropped": a
  // run that started and failed shows there and nowhere else.
  const timeline = signal?.aborted
    ? undefined
    : await deps.gh.fetchCopilotTimeline(dir, slug, prNumber, signal);
  return { queued: readable ? false : null, timeline, startedAt: timeline?.workStartedAt ?? null };
}

/**
 * What an unanswered request demands, from the verdict GitHub's evidence
 * produced: a retry (once per cycle), a release, or nothing at all — in which
 * case the caller records the observation and reports the wait.
 *
 * THE RETRY IS THE POINT: a run that FAILED and a request that was never
 * QUEUED are both things waiting cannot fix, and the measured cost of not
 * knowing the difference was a full 20-minute budget spent to learn nothing.
 * One recovery per cycle, then the requirement is released with the reason —
 * a repository whose Copilot review is broken must not hold a task forever.
 */
export async function actOnBreakage(args: {
  deps: CopilotReviewToolDeps;
  ctx: unknown;
  root: string;
  st: GateState;
  dir: string;
  slug: string;
  pr: PrSummary;
  state: CopilotReviewState;
  signal: AbortSignal | undefined;
  verdict: CopilotWaitVerdict;
  progress: { step(message: string): void };
}): Promise<ToolReply | undefined> {
  const { deps, ctx, root, st, dir, slug, pr, state, signal, verdict, progress } = args;
  if (verdict.state !== "failed" && verdict.state !== "not-landed") return undefined;
  const why = verdict.state === "failed"
    ? `Copilot's review run failed (copilot_work_finished_failure) after ${waitedMinutes(verdict.waitedMs)}`
    : `GitHub never queued the review request (no pending reviewer, no copilot_work_started) after ${waitedMinutes(verdict.waitedMs)}`;
  if (state.breakageRetried) {
    return releaseReply({
      deps, ctx, root, st,
      status: "UNSUPPORTED",
      note: `${why}, and the cycle's retry was already spent`,
      text: `review-gate: ${why}, and the one retry this cycle gets was already spent. ` +
        "Requirement released (UNSUPPORTED) — tell the user: Copilot code review is not working " +
        "for this PR, and the findings (if any) were never produced.",
      details: { pr: pr.number },
    });
  }
  progress.step("重发请求");
  const again = await deps.gh.requestCopilotReviewer(dir, pr, slug, signal);
  if (!again.ok) {
    // An abort is the user pressing ESC, not GitHub refusing. Leave the state
    // exactly as it was: the wait continues, and the next call diagnoses again.
    if (signal?.aborted) {
      return {
        content: [{
          type: "text",
          text: "review-gate: aborted before the retry completed — nothing changed; call " +
            "copilot_review again.",
        }],
        details: { status: state.status, pr: pr.number },
      };
    }
    return releaseReply({
      deps, ctx, root, st,
      status: "UNSUPPORTED",
      note: `${why}, and the retry was refused: ${ghError(again, "the review request was refused")}`,
      text: `review-gate: ${why}, and the retry was refused — ${ghError(again, "the review request was refused")}. ` +
        "Requirement released (UNSUPPORTED).",
      details: { pr: pr.number },
    });
  }
  st.copilot = recordCopilotRequest(state, {
    pr: pr.number,
    head: pr.head,
    nowIso: new Date().toISOString(),
    queue: { state: "unknown", at: new Date().toISOString() },
    afterBreakage: verdict.state,
    note: `${why} — a fresh request was sent`,
  });
  deps.persist(ctx, root);
  deps.armLoop();
  deps.log(`copilot retry for PR #${pr.number} (round ${st.copilot.rounds}): ${why}`);
  return {
    content: [{
      type: "text",
      text: `review-gate: ${why}. A fresh request was sent (round ${st.copilot.rounds}).`,
    }],
    details: { status: "AWAITING", pr: pr.number, rounds: st.copilot.rounds, retry: verdict.state },
  };
}

/** A wait that has gone on long enough to need an explanation. */
interface WaitDiagnosis {
  /** What the wait is doing, for the state and the reply. */
  verdict: { state: CopilotWaitState; waitedMs: number | null; note: string };
  evidence: CopilotQueueEvidence;
}

/**
 * Diagnose an outstanding request by asking GitHub what actually happened to
 * it, and act — the whole point of the merge.
 *
 * The three questions, in the order they are cheap to answer:
 *
 *  1. Is the request pending at all (light query)? No pending flag plus no
 *     `copilot_work_started` past the grace window means GitHub never took it,
 *     and the honest response is to SEND IT AGAIN rather than to wait out a
 *     budget for something that was never queued.
 *  2. Did Copilot's run FAIL (timeline)? `copilot_work_finished_failure` means
 *     no review is coming from this run, so waiting is pointless — re-request
 *     once (the cycle's single retry) instead of discovering it 10 minutes
 *     later.
 *  3. Otherwise it is queued or working, and the answer is genuinely "wait".
 *
 * The timeline probe (two REST round trips) is spent deliberately rarely:
 * on the request path, when the queue flag is missing, when nothing started
 * yet, and when the budget runs out. The ~25-second poll in
 * lib/copilot-watch.ts uses the light query only.
 */
export async function diagnoseWaitRequest(args: {
  deps: CopilotReviewToolDeps;
  dir: string;
  slug: string;
  prNumber: number;
  state: CopilotReviewState;
  signal: AbortSignal | undefined;
  progress: { step(message: string): void };
}): Promise<WaitDiagnosis> {
  const { deps, dir, slug, prNumber, state, signal } = args;
  const now = Date.now();
  const requestedAt = state.firstRequestedAt ?? state.requestedAt;
  const waitedMs = waitedSince(requestedAt, now);
  args.progress.step("确认排队状态（reviewRequests）");
  const probe = await deps.gh.fetchCopilotProbe(dir, slug, prNumber, signal);
  const budgetSpent = waitedMs !== null && waitedMs >= COPILOT_AWAIT_TIMEOUT_MS;
  // Spend the timeline probe when the light answer is not enough to decide:
  // nothing queued (dropped? broken?), nothing started yet (working?), or the
  // budget is up (which of the two ways did this end?).
  const startedKnown = Boolean(state.queue?.startedAt);
  const needsTimeline = probe !== undefined && (
    probe.queued !== true || !startedKnown || budgetSpent
  );
  const timeline = needsTimeline && !signal?.aborted
    ? await (async () => {
      args.progress.step("读时间线事件（copilot_work_started / 失败）");
      return await deps.gh.fetchCopilotTimeline(dir, slug, prNumber, signal);
    })()
    : undefined;
  const evidence = waitEvidence(probe, timeline, state);
  return { verdict: decideCopilotWait({ evidence, requestedAt, now }), evidence };
}
