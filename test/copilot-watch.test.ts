/**
 * L7 — the background watcher (lib/copilot-watch.ts).
 *
 * What is under test is the POLICY that replaced the agent's blind polling:
 * how often the gate looks, what a look means, and the one sentence that wakes
 * the session. Each test names the failure it prevents — a wake with no news
 * (which trains the agent to ignore wakes), a silent tick that loses the
 * review, or a wait that never ends because the probe failed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COPILOT_LANDING_GRACE_MS,
  COPILOT_WATCH_INTERVAL_MS,
  COPILOT_WATCH_SLOW_MS,
  COPILOT_WATCH_SLOWEST_MS,
  WATCH_EARLY_MS,
  WATCH_LATE_MS,
  decideWatchTick,
  watchIntervalMs,
  watchRunsInMode,
} from "../lib/copilot-watch.ts";
import {
  armCopilotReview,
  COPILOT_AWAIT_TIMEOUT_MS,
  type CopilotProbe,
  type CopilotReviewState,
} from "../lib/copilot-review.ts";

const NOW_ISO = "2026-08-07T10:00:00.000Z";
const NOW = Date.parse(NOW_ISO);

function cycle(over: Partial<CopilotReviewState> = {}): CopilotReviewState {
  return {
    ...armCopilotReview(undefined, NOW_ISO),
    status: "AWAITING",
    pr: 592,
    requestedAt: NOW_ISO,
    firstRequestedAt: NOW_ISO,
    rounds: 1,
    ...over,
  };
}

/** A light probe: queued (or not), with whatever reviews the caller wants. */
function probe(over: Partial<CopilotProbe> = {}): CopilotProbe {
  return {
    head: "headsha",
    queued: true,
    payload: { head: "headsha", reviews: [], threads: [] },
    ...over,
  };
}

function landedProbe(): CopilotProbe {
  return probe({
    payload: {
      head: "headsha",
      reviews: [{ author: "copilot", submittedAt: NOW_ISO, commit: "headsha", state: "COMMENTED" }],
      threads: [],
    },
  });
}

test("the watcher only runs where there is a loop to advance", () => {
  assert.equal(watchRunsInMode("loop"), true);
  assert.equal(watchRunsInMode("orchestrator"), true);
  assert.equal(watchRunsInMode("explore"), false, "research has no Copilot requirement to watch");
  assert.equal(watchRunsInMode("normal"), false, "and normal mode has no gates at all");
  assert.equal(watchRunsInMode(undefined), false);
});

test("the cadence backs off as the wait gets old — it is a ~16 minute answer", () => {
  assert.equal(watchIntervalMs(null), COPILOT_WATCH_INTERVAL_MS);
  assert.equal(watchIntervalMs(0), COPILOT_WATCH_INTERVAL_MS);
  assert.equal(watchIntervalMs(WATCH_EARLY_MS - 1), COPILOT_WATCH_INTERVAL_MS);
  assert.equal(watchIntervalMs(WATCH_EARLY_MS), COPILOT_WATCH_SLOW_MS);
  assert.equal(watchIntervalMs(WATCH_LATE_MS), COPILOT_WATCH_SLOWEST_MS);
});

test("a landed review wakes the session, and the message says what to do", () => {
  const tick = decideWatchTick({ state: cycle(), probe: landedProbe(), now: NOW + 16 * 60_000 });
  assert.equal(tick.kind, "wake");
  assert.equal(tick.kind === "wake" && tick.reason, "landed");
  assert.equal(tick.kind === "wake" && tick.waitedMs, 16 * 60_000);
  assert.match(tick.kind === "wake" ? tick.message : "", /\[REVIEW_GATE_COPILOT\] PR #592 的 Copilot 审查已落地（请求后 16\.0 分钟）/);
  assert.match(tick.kind === "wake" ? tick.message : "", /调 copilot_review/);
  assert.match(tick.kind === "wake" ? tick.message : "", /不用再自己轮询/);
});

test("a review that lands AFTER the budget still wins — landing is news, not a timer", () => {
  const tick = decideWatchTick({
    state: cycle(),
    probe: landedProbe(),
    now: NOW + COPILOT_AWAIT_TIMEOUT_MS + 5 * 60_000,
  });
  assert.equal(tick.kind === "wake" && tick.reason, "landed");
});

test("a poll that FAILED is not news — the next tick retries, quietly", () => {
  const tick = decideWatchTick({ state: cycle(), probe: undefined, now: NOW + 60_000 });
  assert.equal(tick.kind, "wait");
  assert.equal(tick.kind === "wait" && tick.state, "unknown");
  assert.equal(tick.kind === "wait" && tick.intervalMs, COPILOT_WATCH_INTERVAL_MS);
});

test("a request that never landed wakes as soon as the grace window closes", () => {
  const early = decideWatchTick({
    state: cycle(),
    probe: probe({ queued: false }),
    now: NOW + 5_000,
  });
  assert.equal(early.kind, "wait", "5 seconds in, 'no flag yet' means nothing");

  const tick = decideWatchTick({
    state: cycle(),
    probe: probe({ queued: false }),
    now: NOW + COPILOT_LANDING_GRACE_MS + 20_000,
  });
  assert.equal(tick.kind === "wake" && tick.reason, "not-landed");
  assert.match(tick.kind === "wake" ? tick.message : "", /请求没有被接住/);
  assert.match(tick.kind === "wake" ? tick.message : "", /重发一次/);
});

test("the not-landed wake quotes the LAST request's age, not the cycle's", () => {
  // The verdict's 90-second window is about the request GitHub just failed to
  // take. After a re-send the cycle is older than that request, and quoting
  // the cycle's total would misdescribe the very window being reported.
  const first = "2026-08-07T09:00:00.000Z";
  const resent = "2026-08-07T09:10:00.000Z";
  const tick = decideWatchTick({
    state: cycle({ requestedAt: resent, firstRequestedAt: first }),
    probe: probe({ queued: false }),
    now: Date.parse(resent) + COPILOT_LANDING_GRACE_MS + 20_000,
  });
  assert.equal(tick.kind === "wake" && tick.reason, "not-landed");
  assert.match(tick.kind === "wake" ? tick.message : "", /请求发出后 110 秒/,
    "110s since the re-send — not the 710s the cycle has been open (600s of it before the re-send)");
});

test("a queued request that never produces a review ends at the budget, not before", () => {
  const stillWaiting = decideWatchTick({
    state: cycle(),
    probe: probe(),
    now: NOW + COPILOT_AWAIT_TIMEOUT_MS - 1,
  });
  assert.equal(stillWaiting.kind, "wait");
  assert.equal(stillWaiting.kind === "wait" && stillWaiting.state, "queued");

  const tick = decideWatchTick({
    state: cycle(),
    probe: probe(),
    now: NOW + COPILOT_AWAIT_TIMEOUT_MS,
  });
  assert.equal(tick.kind === "wake" && tick.reason, "timeout");
  assert.match(tick.kind === "wake" ? tick.message : "", /已等满 30\.0 分钟/);
  assert.match(tick.kind === "wake" ? tick.message : "", /查时间线/);
});

test("a cycle that is no longer AWAITING is not watched (the state owns the decision)", () => {
  const tick = decideWatchTick({ state: cycle({ status: "SATISFIED" }), probe: landedProbe(), now: NOW });
  assert.equal(tick.kind, "wait", "no wake for a cycle somebody already closed");
  const open = decideWatchTick({
    state: cycle({ status: "OPEN", openThreads: 2 }),
    probe: landedProbe(),
    now: NOW + 60_000,
  });
  assert.equal(open.kind, "wait", "OPEN findings are acted on by the tool, not by a wake");
});

test("the start time of an OLDER run does not describe this cycle, but a remembered one does", () => {
  // The persisted observation is what the agent was already told ("Copilot is
  // working since …"), so a tick that keeps it is not lying; a start recorded
  // before this cycle's request is a different run's and is ignored.
  const stale = decideWatchTick({
    state: cycle({ queue: { state: "working", at: "2026-08-07T09:00:00.000Z", startedAt: "2026-08-07T09:00:00.000Z" } }),
    probe: probe(),
    now: NOW + 60_000,
  });
  assert.equal(stale.kind === "wait" && stale.state, "queued");

  const fresh = decideWatchTick({
    state: cycle({ queue: { state: "working", at: NOW_ISO, startedAt: NOW_ISO } }),
    probe: probe(),
    now: NOW + 60_000,
  });
  assert.equal(fresh.kind === "wait" && fresh.state, "working");
});

test("the budget runs on the cycle's FIRST request, not on the last re-send", () => {
  // A request GitHub never queued is re-sent once: `requestedAt` moves, the
  // budget's anchor does not. Anchoring the timeout on the last re-send would
  // let a re-request buy the cycle a fresh window — and would make this wake
  // fire a whole request later than the budget the tool actually enforces.
  const first = "2026-08-07T09:00:00.000Z";
  const resent = "2026-08-07T09:20:00.000Z";
  const state = cycle({ requestedAt: resent, firstRequestedAt: first });
  const spent = decideWatchTick({
    state,
    probe: probe(),
    now: Date.parse(first) + COPILOT_AWAIT_TIMEOUT_MS,
  });
  assert.equal(spent.kind === "wake" && spent.reason, "timeout");
  assert.equal(spent.kind === "wake" && spent.waitedMs, COPILOT_AWAIT_TIMEOUT_MS);
  // The re-send itself is recent, so there is no news about it either.
  const fresh = decideWatchTick({ state, probe: probe(), now: Date.parse(resent) + 1 });
  assert.equal(fresh.kind, "wait");
});
