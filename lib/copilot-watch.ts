/**
 * The BACKGROUND WATCHER for one Copilot review request: how often to look,
 * what a look means, and the one message it sends when there is news.
 *
 * WHY THIS EXISTS. Until 2026-09-14 the wait for a Copilot review was carried
 * by the agent: the then-`check_copilot_review` polled for 3 × 20 seconds
 * inside one tool call and then told the agent to come back in a minute.
 * Measured on server-service-dashboard PR #592 (50 paired rounds) the answer
 * takes a median of 15.8 minutes (p90 19.4, max 23.4) — so that 60-second poll
 * can essentially never hit, and the real mechanism was the agent calling the
 * tool again and again: one measured round spent five calls and 16.5 minutes
 * discovering a review that had been posted at minute 13, and a session log
 * shows 47 such calls across a day. That is blind waiting by construction: the
 * agent cannot see the PR, and the only thing it can do with a tool call is
 * ask again.
 *
 * The gate CAN see the PR. So the waiting moves here: a timer polls the LIGHT
 * query (~1 KB, see `COPILOT_PROBE_QUERY`) while the requirement is AWAITING,
 * and the agent is woken only when there is something to act on. `steer`-style
 * polling is replaced by this, and it is why `copilotProblems({watchedAwait})`
 * can stop nagging the revival timer about a wait that is already being
 * watched.
 *
 * WHAT IT IS NOT. It reads nothing else, writes no gate state and decides no
 * verdict of its own: the CYCLE's transitions are lib/copilot-review.ts (which
 * owns the state machine and the payload parsers), the tool owns the state
 * writes, and this module owns the wait end to end — what an unanswered
 * request is doing ({@link decideCopilotWait}), how often to look again, and
 * the one sentence that wakes the session. That split is what keeps every
 * branch below unit-testable without a GitHub, a clock or a session.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not run the timeline probe (two
 * REST round trips, ~30 KB) on every tick; that probe answers "is Copilot
 * WORKING or did its run FAIL", and the two moments where that question
 * changes a decision — the request itself and the budget running out — are
 * tool-call moments. Polling the expensive truth every 25 seconds to print it
 * would be the same blind waiting with a bigger bill.
 */

import {
  analyzeCopilot,
  COPILOT_AWAIT_TIMEOUT_MS,
  COPILOT_CLOCK_SKEW_MS,
  type CopilotProbe,
  type CopilotReviewState,
  type CopilotWaitState,
} from "./copilot-review.ts";

/**
 * How long a request may go with NO evidence that GitHub took it before the
 * gate acts on that absence.
 *
 * Sized against the measured landing time, not against a feeling: across 51
 * requests the `review_requested` timeline event appeared within 63 seconds
 * (median 35s). When the pending-reviewer flag has not appeared by 90 seconds,
 * what the gate is waiting for was not queued — which is the case the old
 * fixed budget turned into a 20-minute wait, and the case this window exists
 * to end in 90 seconds instead.
 */
export const COPILOT_LANDING_GRACE_MS = 90 * 1000;

/**
 * What GitHub says about the REQUEST itself — the two states the PR page
 * draws and this gate used to ignore entirely.
 *
 * The reviewer box shows either a pending dot (Copilot was asked and has not
 * answered; GraphQL `reviewRequests` lists `copilot-pull-request-reviewer`,
 * while REST `requested_reviewers` stays empty — measured on PR #592) or a
 * re-request arrow (it answered, so the request is gone). The timeline adds
 * the finer states: `copilot_work_started` (the run is underway) and
 * `copilot_work_finished_failure` (the run broke without producing a review).
 *
 * `null` means "could not read", never "no": an unavailable `gh` must not be
 * turned into a claim about Copilot.
 */
export interface CopilotQueueEvidence {
  /** A Copilot review request is pending on the PR (the dot). null = unreadable. */
  queued: boolean | null;
  /** `copilot_work_started` at/after the cycle's request (ISO). */
  workStartedAt?: string | null;
  /** `copilot_work_finished_failure` after that start (ISO). */
  workFailedAt?: string | null;
}

export interface CopilotWaitVerdict {
  state: CopilotWaitState;
  /** Milliseconds since the cycle's FIRST request, when that time is known. */
  waitedMs: number | null;
  /** One line explaining the state, for the tool reply. */
  note: string;
}

/**
 * Decide what a still-unanswered request is doing, from the queue evidence.
 *
 * This is the function that replaced "wait 20 minutes and see": the ways an
 * answer can fail to arrive are TOLD APART, and each one has its own response.
 *
 *  - `failed`    the timeline reports `copilot_work_finished_failure` for this
 *                cycle. Copilot ran and broke, so no review is coming — the
 *                caller re-requests (once, see `breakageRetried`) instead of
 *                waiting out a budget for nothing.
 *  - `working`   a request is pending AND `copilot_work_started` follows it:
 *                the honest answer is a wait, and the gate can say how long it
 *                has been going.
 *  - `queued`    a request is pending but no start event yet (it appears within
 *                ~63s): still the honest answer is a wait.
 *  - `not-landed` nothing pending, nothing started, and the arrival window has
 *                passed: the request was dropped (measured to happen on some
 *                repositories — the request call reports success and GitHub
 *                queues nothing).
 *  - `unknown`   too early, or the probe itself failed. Never a reason to act:
 *                "could not read" must not become "not queued".
 *
 * Two staleness rules keep a tail of old events from describing this cycle:
 * a failure older than the request (or older than a newer start) is ignored,
 * and a start older than the request is not evidence of a run happening now.
 */
export function decideCopilotWait(args: {
  evidence: CopilotQueueEvidence | undefined;
  requestedAt: string | undefined;
  now: number;
}): CopilotWaitVerdict {
  const requestedMs = parseTime(args.requestedAt);
  const waitedMs = requestedMs === undefined ? null : Math.max(0, args.now - requestedMs);
  const startedMs = parseTime(args.evidence?.workStartedAt ?? undefined);
  const failedMs = parseTime(args.evidence?.workFailedAt ?? undefined);
  /** Is this timeline event at/after THIS cycle's request, within clock skew? */
  const ours = (ms: number | undefined): boolean =>
    ms !== undefined && (requestedMs === undefined || ms >= requestedMs - COPILOT_CLOCK_SKEW_MS);
  // A failure belongs to THIS cycle only if it happened after this cycle's
  // request: the timeline probe reads the tail of the events list, which can
  // reach back past the last push — and a stale failure must not relabel a run
  // that is happily queued right now (nor, in the other direction, hide one
  // that really did break after we asked).
  const failedIsOurs = ours(failedMs);
  if (failedIsOurs && (startedMs === undefined || failedMs! >= startedMs)) {
    return { state: "failed", waitedMs, note: copilotWaitNote("failed", args.evidence, waitedMs) };
  }
  if (args.evidence?.queued === true) {
    // "Working" needs a start event from THIS cycle: an older run's start would
    // otherwise have the gate describe a fresh, barely-queued request as one
    // that has been running for twenty minutes.
    const state: CopilotWaitState = ours(startedMs) ? "working" : "queued";
    return { state, waitedMs, note: copilotWaitNote(state, args.evidence, waitedMs) };
  }
  if (args.evidence?.queued === false) {
    // A request does not appear instantly. Concluding "dropped" from a probe
    // taken in the first seconds would re-request a request that is on its way
    // — the same mistake in the other direction.
    if (waitedMs !== null && waitedMs < COPILOT_LANDING_GRACE_MS) {
      return { state: "unknown", waitedMs, note: copilotWaitNote("unknown", args.evidence, waitedMs) };
    }
    return { state: "not-landed", waitedMs, note: copilotWaitNote("not-landed", args.evidence, waitedMs) };
  }
  return { state: "unknown", waitedMs, note: copilotWaitNote("unknown", args.evidence, waitedMs) };
}

/**
 * The ONE sentence explaining a wait state.
 *
 * Extracted so the request-time confirmation — which knows the state from the
 * window it just spent, without any clock arithmetic of its own — describes it
 * in exactly the same words as the state machine. Two wordings for one state
 * is how a message ends up contradicting the state it reports.
 */
export function copilotWaitNote(
  state: CopilotWaitState,
  evidence: CopilotQueueEvidence | undefined,
  waitedMs: number | null,
): string {
  const seconds = waitedMs === null ? null : Math.round(waitedMs / 1000);
  switch (state) {
    case "failed":
      return "Copilot's review run reported a failure (copilot_work_finished_failure) — no review is " +
        "coming from it; a fresh request is worth one attempt";
    case "working":
      return `Copilot is working on the review (started ${evidence?.workStartedAt}, request still pending)`;
    case "queued":
      return "the review request is queued on the PR (the pending-reviewer dot) — Copilot has not " +
        "started yet";
    case "not-landed":
      return "GitHub never listed Copilot as a pending reviewer and its work never started — the " +
        "request was not queued";
    default:
      return seconds === null || seconds >= (COPILOT_LANDING_GRACE_MS / 1000)
        ? "the queue probe could not be read — waiting is the only safe reading"
        : `only ${seconds}s since the request — too early to tell whether it landed`;
  }
}

/** Milliseconds since an ISO time, or null when it cannot be read. */
function parseTime(value: string | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Poll cadence while the wait is young (the first {@link WATCH_EARLY_MS}). */
export const COPILOT_WATCH_INTERVAL_MS = 20_000;
/** Cadence past {@link WATCH_EARLY_MS}: it is a 15-minute wait, not a 30s one. */
export const COPILOT_WATCH_SLOW_MS = 30_000;
/** Cadence past {@link WATCH_LATE_MS} — the tail, where nothing is expected. */
export const COPILOT_WATCH_SLOWEST_MS = 45_000;
export const WATCH_EARLY_MS = 3 * 60 * 1000;
export const WATCH_LATE_MS = 10 * 60 * 1000;

/**
 * Is a background watcher allowed to run in this gate mode at all?
 *
 * `normal` has no gates to enforce and `explore` is a research session whose
 * deliverable is knowledge — neither has a Copilot requirement to watch, and a
 * timer that polls GitHub in them would be the gate inventing work.
 */
export function watchRunsInMode(mode: string | undefined): boolean {
  return mode === "loop" || mode === "orchestrator";
}

/** Milliseconds until the next poll, given how long the wait has run. */
export function watchIntervalMs(waitedMs: number | null): number {
  if (waitedMs === null) return COPILOT_WATCH_INTERVAL_MS;
  if (waitedMs < WATCH_EARLY_MS) return COPILOT_WATCH_INTERVAL_MS;
  if (waitedMs < WATCH_LATE_MS) return COPILOT_WATCH_SLOW_MS;
  return COPILOT_WATCH_SLOWEST_MS;
}

/** Why the agent is being woken. */
export type CopilotWakeReason = "landed" | "not-landed" | "timeout";

export type CopilotWatchTick =
  /** Nothing to watch: the requirement left AWAITING, or the probe was silent. */
  | { kind: "wait"; state: CopilotWaitState; waitedMs: number | null; intervalMs: number }
  /** Something happened — deliver `message`, then stop the watcher. */
  | { kind: "wake"; reason: CopilotWakeReason; waitedMs: number | null; message: string };

/**
 * One tick's decision.
 *
 * Order matters, and it is the order of what is KNOWN rather than what is
 * hoped: a landed review ends the wait whatever the clock says; the budget
 * ending is reported even when the probe says "still queued" (a queued request
 * that never produces a review is exactly the case the budget exists for); and
 * a request that was never queued is reported as soon as the arrival window has
 * passed — that is the reading that used to cost a fully wasted 20 minutes.
 *
 * A `probe` of `undefined` (gh failed, payload unreadable) is NOT news: the
 * tick keeps waiting with the same cadence. `decideCopilotWait` decides the
 * rest, so "could not read" stays "unknown" instead of becoming "not queued".
 */
export function decideWatchTick(args: {
  state: CopilotReviewState;
  /** The light probe's answer, or undefined when the poll failed. */
  probe: CopilotProbe | undefined;
  now: number;
}): CopilotWatchTick {
  const { state, probe } = args;
  // TWO anchors, because they answer two different questions.
  //
  // "Did a review land for THIS request?" is anchored on the last request
  // (`requestedAt`): a review older than that one is the previous round's
  // answer. "How long has this cycle been waiting, and is the budget spent?"
  // is anchored on the FIRST request — the same anchor `evaluateCopilot` and
  // the tool's diagnosis use, so a re-request (after a request GitHub never
  // queued) cannot make the watcher's timeout wake up a round late.
  const landingAnchor = state.requestedAt ?? state.armedAt;
  const waitedMs = waitedSince(state.firstRequestedAt ?? state.requestedAt ?? state.armedAt, args.now);
  if (state.status !== "AWAITING") {
    return { kind: "wait", state: "unknown", waitedMs, intervalMs: COPILOT_WATCH_INTERVAL_MS };
  }
  if (probe) {
    const analysis = analyzeCopilot(probe.payload, { anchorAt: landingAnchor });
    if (analysis.reviewed) {
      return {
        kind: "wake",
        reason: "landed",
        waitedMs,
        message: landedMessage(state, waitedMs),
      };
    }
  }
  if (waitedMs !== null && waitedMs >= COPILOT_AWAIT_TIMEOUT_MS) {
    return {
      kind: "wake",
      reason: "timeout",
      waitedMs,
      message:
        `[REVIEW_GATE_COPILOT] PR #${state.pr} 已等满 ${minutes(waitedMs)} 仍没有 Copilot 审查。` +
        "调 copilot_review：它会查时间线区分「Copilot 跑挂了」与「仍在审」并给出下一步（重发一次或释放要求）。" +
        "不要自己循环调用。",
    };
  }
  const verdict = decideCopilotWait({
    evidence: probe === undefined ? undefined : queueEvidenceFrom(state, probe),
    // The verdict's grace window is about THE LAST request — "did GitHub take
    // the one we just sent?" — while the budget above is the cycle's.
    requestedAt: state.requestedAt ?? state.armedAt,
    now: args.now,
  });
  if (verdict.state === "not-landed") {
    // The sentence names the LAST request's age, not the cycle's: the verdict's
    // 90-second window is about the request GitHub just failed to take, and
    // after a re-send the cycle's total would read as a lie about THIS one.
    return {
      kind: "wake",
      reason: "not-landed",
      waitedMs,
      message:
        `[REVIEW_GATE_COPILOT] PR #${state.pr} 的审查请求发出后 ${seconds(verdict.waitedMs ?? 0)} 仍未在 GitHub 上排队` +
        "（pending reviewer 与 copilot_work_started 都没有）——请求没有被接住。调 copilot_review：它会重发一次，" +
        "再不行就按不可用释放并要求你如实告诉用户。",
    };
  }
  return { kind: "wait", state: verdict.state, waitedMs, intervalMs: watchIntervalMs(waitedMs) };
}

/**
 * The queue evidence a tick can honestly claim.
 *
 * The light probe answers `queued`; the timeline events (`workStartedAt`,
 * `workFailedAt`) belong to the last tool call that spent the REST probe, and
 * they are carried forward here because they are still true of this cycle —
 * a `copilot_work_started` does not un-happen. The cycle's one RETRY is not
 * part of the decision either (the tool owns it) — only its effects are, in
 * the sense that a `failed` verdict is what the tool acts on next.
 */
function queueEvidenceFrom(state: CopilotReviewState, probe: CopilotProbe) {
  return {
    queued: probe.queued,
    // The persisted observation can only ADD the timeline facts; it never
    // overrides the live `queued` answer.
    ...(state.queue?.startedAt ? { workStartedAt: state.queue.startedAt } : {}),
    ...(state.queue?.state === "failed" ? { workFailedAt: state.queue.at } : {}),
  };
}

function landedMessage(state: CopilotReviewState, waitedMs: number | null): string {
  return (
    `[REVIEW_GATE_COPILOT] PR #${state.pr} 的 Copilot 审查已落地` +
    (waitedMs === null ? "" : `（请求后 ${minutes(waitedMs)}）`) +
    "。调 copilot_review 读结果：第 4 轮起每条会发现先弹框问用户怎么处理，然后只做他批过的事。" +
    "不用再自己轮询——门禁会在有变化时叫你。"
  );
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} 分钟`;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} 秒`;
}

function waitedSince(iso: string | undefined, now: number): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.max(0, now - ms);
}
