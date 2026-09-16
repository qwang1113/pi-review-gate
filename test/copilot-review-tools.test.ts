import test from "node:test";
import assert from "node:assert/strict";

import {
  registerCopilotReviewTools,
  COPILOT_CONFIRM_ATTEMPTS,
  COPILOT_CONFIRM_DELAY_MS,
  COPILOT_CONFIRM_RETRY_ATTEMPTS,
  type CopilotReviewToolDeps,
} from "../lib/copilot-review-tools.ts";
import type { ToolHost, ToolReply } from "../lib/tool-host.ts";
import type { ChoiceSpec } from "../lib/choice-dialog.ts";
import { emptyState, type GateState } from "../lib/gate-state.ts";
import {
  armCopilotReview,
  COPILOT_AWAIT_TIMEOUT_MS,
  releaseCopilotReview,
  type CopilotPayload,
  type CopilotProbe,
  type CopilotThread,
  type CopilotTimeline,
  type PrSummary,
} from "../lib/copilot-review.ts";
import {
  COPILOT_TRIAGE_MAX_QUESTIONS,
  DECLINE_CHOICE,
  FIX_CHOICE,
  IRRELEVANT_CHOICE,
  recordDecision,
} from "../lib/copilot-triage.ts";
import { SKIP_REST_CHOICE } from "../lib/ask-user.ts";
import { DECLINE_ROW } from "../lib/choice-dialog.ts";

/**
 * The L7 Copilot tool used to live inside the 8900-line extension, where
 * exercising "GitHub refused the request" or "three threads are waiting on
 * you" meant a real repository, a real PR and a real `gh`. It is now a lib/
 * module whose GitHub access arrives as `deps.gh` — so every branch below runs
 * against fakes, and a behavior change during the move would have to survive
 * an assertion instead of a reviewer's eyes.
 *
 * WHAT CHANGED IN THE MERGE (2026-09-14). `request_copilot_review` +
 * `check_copilot_review` became one `copilot_review`, and the blind wait was
 * replaced by evidence: the queue flag (`reviewRequests`), the timeline's
 * `copilot_work_started` / `copilot_work_finished_failure`, and the retry
 * rules. The tests below are grouped by which of those the call is about —
 * the request half, the wait half, the reading half.
 */

const ROOT = "/repo";
const PR: PrSummary = { number: 42, head: "headsha", url: "https://github.com/o/r/pull/42", state: "OPEN" };
const NOW = "2026-08-29T10:00:00.000Z";

interface GhCall { name: string; args: unknown[] }

interface Fake {
  deps: CopilotReviewToolDeps;
  tools: Map<string, (params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolReply>>;
  order: string[];
  st: GateState;
  persisted: string[];
  logs: string[];
  armed: number;
  delays: number[];
  calls: GhCall[];
  enabled: boolean;
  repo: { ok: boolean; error: string };
  /** What each faked gh member answers. */
  openPr: { pr?: PrSummary; error?: string };
  slug: string | null;
  payload: CopilotPayload | undefined;
  /** The LIGHT read: `undefined` is "the poll failed", which is not "no". */
  probe: CopilotProbe | undefined;
  /** The REST timeline: `undefined` is "unreadable", not "nothing happened". */
  timeline: CopilotTimeline | undefined;
  requested: { ok: boolean; stdout: string; stderr: string };
  support: { support: "CONFIRMED" | "UNKNOWN"; confirmed: boolean };
  /** Every triage dialog the tool raised, in order. */
  asked: { spec: ChoiceSpec; body?: string; pointer?: string; extraRows?: string[] }[];
  /** What the user picks, one entry per dialog; a missing entry is ESC. */
  answers: (string | undefined)[];
  /** The transcript notices the triage wrote, one per asked finding. */
  notices: { lead: string; body: string }[];
}

function thread(over: Partial<CopilotThread> = {}): CopilotThread {
  return {
    id: "T1",
    isResolved: false,
    isOutdated: false,
    path: "lib/copilot-gh.ts",
    line: 12,
    author: "copilot",
    lastAuthor: "copilot",
    createdAt: "2026-08-29T10:00:00.000Z",
    excerpt: "this argv is not escaped",
    body: "this argv is not escaped",
    latestBody: "this argv is not escaped",
    lastCommentId: "C1",
    ...over,
  };
}

/** A probe that says "the request is queued and Copilot has started". */
function queuedProbe(over: Partial<CopilotProbe> = {}): CopilotProbe {
  return { head: "headsha", queued: true, payload: { head: "headsha", reviews: [], threads: [] }, ...over };
}

function fake(overrides: Partial<Fake> = {}): Fake {
  // "Just now" for the timeline default: a start/failure event is only this
  // cycle's if it is at/after the request, and the request happens at the real
  // current time inside the tool.
  const justNow = new Date().toISOString();
  const state: Fake = {
    deps: undefined as unknown as CopilotReviewToolDeps,
    tools: new Map(),
    order: [],
    st: emptyState("sess-1", 10),
    persisted: [],
    logs: [],
    armed: 0,
    delays: [],
    calls: [],
    enabled: true,
    repo: { ok: true, error: "" },
    openPr: { pr: PR },
    slug: "o/r",
    payload: { head: "headsha", reviews: [], threads: [] },
    probe: queuedProbe(),
    timeline: { requestedAt: justNow, workStartedAt: justNow, workFailedAt: null },
    requested: { ok: true, stdout: "", stderr: "" },
    support: { support: "CONFIRMED", confirmed: true },
    asked: [],
    answers: [],
    notices: [],
    ...overrides,
  };
  const record = (name: string, args: unknown[]) => { state.calls.push({ name, args }); };
  state.deps = {
    resolveRepo: () => (state.repo.ok ? { ok: true, root: ROOT } : { ok: false, error: state.repo.error }),
    stateFor: () => state.st,
    persist: (_ctx, root) => { state.persisted.push(root); },
    repoDir: (root) => `${root}/dir`,
    copilotEnabled: () => state.enabled,
    armLoop: () => { state.armed += 1; },
    log: (message) => { state.logs.push(message); },
    delay: (ms) => { state.delays.push(ms); return Promise.resolve(); },
    askFinding: async (_ctx, spec, opts) => {
      state.asked.push({ spec, ...(opts.body === undefined ? {} : { body: opts.body }),
        ...(opts.extraRows === undefined ? {} : { extraRows: opts.extraRows }) });
      return state.answers.shift();
    },
    showToUser: (_ctx, lead, body) => { state.notices.push({ lead, body }); return true; },
    gh: {
      resolveOpenPr: async (...args) => { record("resolveOpenPr", args); return state.openPr; },
      resolveRepoSlug: async (...args) => { record("resolveRepoSlug", args); return state.slug; },
      fetchCopilotPayload: async (...args) => { record("fetchCopilotPayload", args); return state.payload; },
      fetchCopilotProbe: async (...args) => { record("fetchCopilotProbe", args); return state.probe; },
      fetchCopilotTimeline: async (...args) => { record("fetchCopilotTimeline", args); return state.timeline; },
      requestCopilotReviewer: async (...args) => { record("requestCopilotReviewer", args); return state.requested; },
      resolveCopilotSupport: async (...args) => { record("resolveCopilotSupport", args); return state.support; },
    },
  };
  const host: ToolHost = {
    registerTool: (definition) => {
      state.order.push(definition.name);
      state.tools.set(definition.name, (params, signal) =>
        definition.execute("id", params, signal, undefined, undefined));
    },
  };
  registerCopilotReviewTools(host, state.deps);
  return state;
}

function textOf(reply: ToolReply): string {
  return reply.content.map((c) => c.text).join("\n");
}

async function call(
  f: Fake,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<ToolReply> {
  const run = f.tools.get("copilot_review");
  assert.ok(run, "copilot_review must be registered");
  return run(params, signal);
}

function callsOf(f: Fake, name: string): GhCall[] {
  return f.calls.filter((c) => c.name === name);
}

/** A live cycle that already asked for a review — the wait's starting point. */
function awaiting(f: Fake, over: Partial<Parameters<typeof armCopilotReview>[0]> = {}): void {
  const nowIso = new Date().toISOString();
  f.st.copilot = {
    ...armCopilotReview(undefined, "2026-08-29T09:00:00.000Z"),
    status: "AWAITING",
    pr: 42,
    rounds: 1,
    requestedAt: nowIso,
    firstRequestedAt: nowIso,
    ...over,
  };
}

test("the module registers exactly ONE Copilot review tool", () => {
  const f = fake();
  assert.deepEqual(f.order, ["copilot_review"]);
});

// ---------- the loop being off, and the repo being unresolvable ----------

test("an off loop short-circuits as DISABLED without touching anything", async () => {
  const f = fake({ enabled: false });
  const reply = await call(f);
  assert.equal(reply.details?.status, "DISABLED");
  assert.ok(textOf(reply).endsWith("nothing to do."));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.persisted, []);
  assert.equal(f.armed, 0);
});

test("an unresolvable repo is reported verbatim and nothing is gathered", async () => {
  const f = fake();
  f.repo = { ok: false, error: "review-gate: which repo?" };
  const reply = await call(f);
  assert.equal(reply.isError, true);
  assert.equal(textOf(reply), "review-gate: which repo?");
  assert.deepEqual(f.calls, []);
});

test("an already RELEASED cycle is left alone — no gh call, no state rewrite", async () => {
  const f = fake();
  f.st.copilot = releaseCopilotReview(
    { ...armCopilotReview(undefined, "2026-08-29T10:00:00.000Z"), pr: 42, openThreads: 2 },
    "UNSUPPORTED", "no Copilot review possible: no pull requests found", "2026-08-29T10:05:00.000Z");
  const before = f.st.copilot;
  const reply = await call(f);
  assert.equal(reply.details?.status, "UNSUPPORTED");
  assert.equal(reply.details?.pr, 42);
  assert.equal(reply.details?.unhandled, 2);
  assert.match(textOf(reply), /already released \(UNSUPPORTED\) — no Copilot review possible/);
  // The duty survives the re-call…
  assert.match(textOf(reply), /2 Copilot thread\(s\) were still waiting on you at the last check/);
  // …and nothing was re-derived: no gh call, no persist, no re-arming.
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.persisted, []);
  assert.equal(f.armed, 0);
  assert.equal(f.st.copilot, before);
});

test("no PR releases the requirement as UNSUPPORTED, with the reason", async () => {
  const f = fake({ openPr: { error: "no pull requests found" } });
  const reply = await call(f);
  assert.equal(reply.details?.status, "UNSUPPORTED");
  assert.match(textOf(reply), /no Copilot review for this repo — no pull requests found\. Requirement released \(UNSUPPORTED\); it is not blocking completion\./);
  assert.equal(f.st.copilot?.status, "UNSUPPORTED");
  assert.deepEqual(f.persisted, [ROOT]);
  assert.match(f.logs[0], /copilot cycle released UNSUPPORTED/);
  // gh runs in the directory the deps resolve, never in a guessed cwd.
  assert.deepEqual(f.calls.map((c) => c.name), ["resolveOpenPr"]);
  assert.equal(f.calls[0].args[0], `${ROOT}/dir`);
});

test("a release with findings still open carries the abandoned-threads notice", async () => {
  const f = fake({ openPr: { error: "no pull requests found" } });
  f.st.copilot = { ...armCopilotReview(undefined, "2026-08-29T10:00:00.000Z"), pr: 42, openThreads: 3 };
  const reply = await call(f);
  assert.match(textOf(reply), /3 Copilot thread\(s\) were still waiting on you at the last check/);
  assert.match(textOf(reply), /\(PR #42\)/);
});

test("an unresolvable owner/repo releases UNSUPPORTED (the GraphQL query needs it)", async () => {
  const f = fake({ slug: null });
  const reply = await call(f);
  assert.equal(reply.details?.status, "UNSUPPORTED");
  assert.match(textOf(reply), /could not determine owner\/repo for this PR/);
  assert.deepEqual(f.calls.map((c) => c.name), ["resolveOpenPr", "resolveRepoSlug"]);
});

test("an unreadable payload releases UNSUPPORTED without a poll", async () => {
  const f = fake({ payload: undefined });
  const reply = await call(f);
  assert.equal(reply.details?.status, "UNSUPPORTED");
  assert.match(textOf(reply), /could not read the PR's review threads \(gh missing, unauthenticated, or API refusal\)/);
  assert.equal(callsOf(f, "fetchCopilotPayload").length, 1, "no optimistic poll loop any more");
  assert.deepEqual(f.delays, [], "and nothing to wait for");
  assert.equal(f.st.copilot?.status, "UNSUPPORTED");
});

// ---------- the request half: "does this cycle have a review coming?" ----------

test("request: no review for this head asks GitHub, confirms the queue, and records the round", async () => {
  const f = fake();
  const reply = await call(f);
  assert.equal(reply.details?.status, "AWAITING");
  assert.equal(reply.details?.rounds, 1);
  assert.equal(reply.details?.queue, "working");
  assert.match(textOf(reply), /Copilot review requested for PR #42 \(round 1\) — Copilot is working on the review/);
  assert.match(textOf(reply), /wakes you when it lands — do NOT poll it\./);
  assert.doesNotMatch(textOf(reply), /usually answers within a minute/, "the measured claim replaced the folk one");
  assert.equal(f.st.copilot?.status, "AWAITING");
  assert.equal(f.st.copilot?.supportConfirmed, true);
  assert.equal(f.st.copilot?.queue?.state, "working");
  assert.equal(f.st.copilot?.queue?.startedAt, f.timeline?.workStartedAt,
    "the start time from the timeline is what the state remembers");
  assert.equal(f.armed, 1, "an outstanding requirement re-arms the auto-continuation");
  assert.deepEqual(f.persisted, [ROOT]);
  // The queue is confirmed BEFORE the request is recorded, and the timeline is
  // read exactly once to learn whether Copilot started.
  assert.deepEqual(f.calls.map((c) => c.name), [
    "resolveOpenPr", "resolveRepoSlug", "resolveCopilotSupport", "fetchCopilotPayload",
    "requestCopilotReviewer", "fetchCopilotProbe", "fetchCopilotTimeline",
  ]);
  assert.deepEqual(f.delays, [], "the flag came back on the first probe — no sleeping");
});

test("request: the queue flag alone is enough — 'queued', not 'working', when nothing started yet", async () => {
  const f = fake({ timeline: { requestedAt: NOW, workStartedAt: null, workFailedAt: null } });
  const reply = await call(f);
  assert.equal(reply.details?.queue, "queued");
  assert.match(textOf(reply), /the review request is queued on the PR/);
});

test("request: a request GitHub never queues is RE-SENT once, then released", async () => {
  const f = fake({
    probe: queuedProbe({ queued: false }),
    timeline: { requestedAt: null, workStartedAt: null, workFailedAt: null },
  });
  const reply = await call(f);
  assert.equal(reply.details?.status, "UNSUPPORTED");
  assert.match(textOf(reply), /GitHub never listed it as a pending reviewer/);
  assert.equal(callsOf(f, "requestCopilotReviewer").length, 2, "sent, then re-sent once");
  assert.deepEqual(f.delays,
    new Array(COPILOT_CONFIRM_ATTEMPTS - 1).fill(COPILOT_CONFIRM_DELAY_MS)
      .concat(new Array(COPILOT_CONFIRM_RETRY_ATTEMPTS - 1).fill(COPILOT_CONFIRM_DELAY_MS)),
    "each confirmation waits between probes, never after the last one");
  assert.equal(f.st.copilot?.status, "UNSUPPORTED");
});

test("request: a STALE failure in the timeline tail does not mislabel a fresh request", async () => {
  // The timeline probe reads the tail of the events list, which reaches back
  // past the last push — so a failure from an older run is still in it. Only a
  // failure at/after THIS request describes this cycle.
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const f = fake({
    timeline: { requestedAt: fiveMinutesAgo, workStartedAt: fiveMinutesAgo, workFailedAt: fiveMinutesAgo },
  });
  const reply = await call(f);
  assert.doesNotMatch(textOf(reply), /review run reported a failure/);
  assert.equal(reply.details?.status, "AWAITING");
  assert.equal(reply.details?.queue, "queued");
  assert.equal(f.st.copilot?.breakageRetried, undefined, "nothing was broken — nothing was retried");
});

test("request: a REFUSED request releases UNSUPPORTED with gh's own first stderr line", async () => {
  const f = fake({ requested: { ok: false, stdout: "", stderr: "\n  could not add reviewer: HTTP 422\nmore\n" } });
  const reply = await call(f);
  assert.deepEqual(reply.details, { status: "UNSUPPORTED", pr: 42 });
  assert.match(textOf(reply), /not available for PR #42 — could not add reviewer: HTTP 422\. Requirement released \(UNSUPPORTED\)\./);
  assert.equal(f.st.copilot?.status, "UNSUPPORTED");
  // The cycle binds to the head the request was made against.
  assert.equal(f.st.copilot?.head, "headsha");
  assert.deepEqual(f.persisted, [ROOT]);
});

test("request: an ABORTED request records nothing — ESC proves nothing about Copilot", async () => {
  const f = fake({ requested: { ok: false, stdout: "", stderr: "aborted" } });
  const controller = new AbortController();
  controller.abort();
  const reply = await call(f, {}, controller.signal);
  assert.match(textOf(reply), /aborted before the Copilot review request completed — nothing recorded/);
  assert.equal(reply.details?.status, "ARMED");
  // No release, no persist, no log line: the state machine did not move.
  assert.equal(f.st.copilot, undefined);
  assert.deepEqual(f.persisted, []);
  assert.deepEqual(f.logs, []);
});

test("request: UNKNOWN availability changes the WAIT note, never the request itself", async () => {
  const f = fake({ support: { support: "UNKNOWN", confirmed: false } });
  const reply = await call(f);
  assert.equal(reply.details?.support, "UNKNOWN");
  assert.match(textOf(reply), /No Copilot review has ever appeared on this repository's recent PRs/);
  assert.equal(callsOf(f, "requestCopilotReviewer").length, 1, "the request still goes out");
  assert.equal(f.st.copilot?.status, "AWAITING");
  assert.notEqual(f.st.copilot?.supportConfirmed, true);
});

// ---------- the wait half: evidence instead of a blind timer ----------

test("wait: a queued request reports what GitHub says and tells the agent to stop polling", async () => {
  const f = fake();
  awaiting(f);
  const reply = await call(f);
  assert.equal(reply.details?.status, "AWAITING");
  assert.equal(reply.details?.queue, "working");
  assert.match(textOf(reply), /Copilot has not posted its review of PR #42 yet — working after/);
  assert.match(textOf(reply), /There is nothing to poll for: the gate watches the PR in the background/);
  assert.doesNotMatch(textOf(reply), /call copilot_review again in a minute/);
  // No waiting inside the call: the gate's watcher owns the timer.
  assert.deepEqual(f.delays, []);
  assert.equal(f.armed, 1, "still outstanding, so the loop stays armed");
  assert.equal(f.st.copilot?.queue?.state, "working");
});

test("wait: a probe that could not be read is 'unknown', never 'not queued'", async () => {
  const f = fake({ probe: undefined, timeline: undefined });
  awaiting(f);
  const reply = await call(f);
  assert.equal(reply.details?.status, "AWAITING");
  assert.equal(reply.details?.queue, "unknown");
  assert.match(textOf(reply), /unknown after/);
  assert.equal(f.st.copilot?.status, "AWAITING", "a failed probe releases nothing");
  assert.equal(callsOf(f, "requestCopilotReviewer").length, 0, "and re-requests nothing");
});

test("wait: a request that vanished after the grace window is re-sent, not waited out", async () => {
  const f = fake({
    probe: queuedProbe({ queued: false }),
    timeline: { requestedAt: NOW, workStartedAt: null, workFailedAt: null },
  });
  awaiting(f, { requestedAt: "2026-08-29T09:00:00.000Z", firstRequestedAt: "2026-08-29T09:00:00.000Z" });
  const reply = await call(f);
  assert.equal(reply.details?.status, "AWAITING");
  assert.equal(reply.details?.retry, "not-landed");
  assert.equal(callsOf(f, "requestCopilotReviewer").length, 1, "one fresh request");
  assert.match(textOf(reply), /GitHub never queued the review request.*A fresh request was sent/s);
  assert.equal(f.st.copilot?.rounds, 2, "the re-request is a new round");
  assert.equal(f.st.copilot?.breakageRetried, true,
    "and it spends the cycle's one recovery — a second breakage releases instead of asking again");
});

test("wait: a FAILED run earns the cycle's one retry, with a fresh budget", async () => {
  // The failure is ours only if it happened at/after this request — otherwise
  // an older run's failure would keep relabelling every fresh request.
  const justNow = new Date().toISOString();
  const f = fake({
    probe: queuedProbe({ queued: false }),
    timeline: { requestedAt: justNow, workStartedAt: justNow, workFailedAt: justNow },
  });
  awaiting(f, { requestedAt: justNow, firstRequestedAt: justNow });
  const reply = await call(f);
  assert.match(textOf(reply), /Copilot's review run failed \(copilot_work_finished_failure\)/);
  assert.equal(reply.details?.status, "AWAITING");
  assert.equal(reply.details?.retry, "failed");
  assert.equal(f.st.copilot?.breakageRetried, true, "the cycle's one recovery is now spent");
  assert.equal(f.st.copilot?.firstRequestedAt, f.st.copilot?.requestedAt,
    "the retry gets a fresh window: the first one was spent on Copilot's own failure");
});

test("wait: a second breakage in one cycle releases instead of retrying forever", async () => {
  const justNow = new Date().toISOString();
  const f = fake({
    probe: queuedProbe({ queued: false }),
    timeline: { requestedAt: justNow, workStartedAt: justNow, workFailedAt: justNow },
  });
  awaiting(f, {
    requestedAt: new Date().toISOString(),
    firstRequestedAt: new Date().toISOString(),
    breakageRetried: true,
  });
  const reply = await call(f);
  assert.equal(reply.details?.status, "UNSUPPORTED");
  assert.match(textOf(reply), /the one retry this cycle gets was already spent/);
  assert.equal(callsOf(f, "requestCopilotReviewer").length, 0, "no third request");
});

test("wait: the budget spends on the timeline's explanation, not on another retry", async () => {
  const stale = new Date(Date.now() - COPILOT_AWAIT_TIMEOUT_MS - 60_000).toISOString();
  const f = fake({ timeline: { requestedAt: stale, workStartedAt: stale, workFailedAt: null } });
  awaiting(f, { requestedAt: stale, firstRequestedAt: stale });
  const reply = await call(f);
  assert.equal(reply.details?.status, "EXHAUSTED");
  assert.match(textOf(reply), /Copilot did not answer the review request within the wait budget/);
  // The timeline WAS read — the diagnosis is what makes the release honest.
  assert.equal(callsOf(f, "fetchCopilotTimeline").length, 1);
  assert.equal(callsOf(f, "requestCopilotReviewer").length, 0);
});

test("wait: the timeline is not re-read while the queue flag already answers", async () => {
  const f = fake();
  awaiting(f, { queue: { state: "working", at: NOW, startedAt: NOW } });
  const reply = await call(f);
  assert.equal(reply.details?.status, "AWAITING");
  assert.equal(callsOf(f, "fetchCopilotTimeline").length, 0,
    "a start time already on the state is not worth two REST round trips");
  assert.equal(callsOf(f, "fetchCopilotProbe").length, 1, "the cheap query is the poll");
});

// ---------- the reading half: findings, and the user's per-finding approval ----------

test("read: OPEN threads are listed with their ids, the how-to, and the counts in details", async () => {
  const f = fake();
  awaiting(f, { requestedAt: "2026-08-29T09:00:00.000Z" });
  f.payload = {
    head: "headsha",
    reviews: [{ author: "copilot", commit: "headsha", submittedAt: "2026-08-29T10:00:00.000Z", state: "COMMENTED" }],
    threads: [
      thread(),
      thread({ id: "T2", path: "lib/copilot-review-tools.ts", line: 7, isOutdated: true, excerpt: "stale reply text" }),
      thread({ id: "T3", isResolved: true }),
      thread({ id: "T4", lastAuthor: "qwang" }),
    ],
  };
  const reply = await call(f);
  const text = textOf(reply);
  assert.equal(reply.details?.status, "OPEN");
  assert.deepEqual(reply.details, {
    status: "OPEN", pr: 42, actionable: 2, resolved: 1, answered: 1, support: "CONFIRMED",
  });
  assert.match(text, /PR #42 — 2 Copilot thread\(s\) waiting on you \(1 resolved, 1 answered\)/);
  assert.match(text, /- T1 lib\/copilot-gh\.ts:12\n {6}this argv is not escaped/);
  assert.match(text, /- T2 lib\/copilot-review-tools\.ts:7 \[outdated — the code moved; if that fixed it, resolve the thread\]/);
  assert.match(text, /resolveReviewThread/, "the resolve mutation is spelled out");
  assert.match(text, /addPullRequestReviewThreadReply/, "so is the reply mutation");
  // An outstanding requirement is persisted and re-arms the loop.
  assert.equal(f.st.copilot?.status, "OPEN");
  assert.equal(f.st.copilot?.openThreads, 2);
  assert.deepEqual(f.persisted, [ROOT]);
  assert.equal(f.armed, 1);
});

test("read: availability is queried ONCE per call", async () => {
  const f = fake();
  awaiting(f, { requestedAt: "2026-08-29T09:00:00.000Z" });
  await call(f);
  assert.equal(callsOf(f, "resolveCopilotSupport").length, 1);
});

/** A live cycle at a given round, with Copilot's review already posted. */
function atRound(f: Fake, rounds: number): void {
  f.st.copilot = {
    ...armCopilotReview(undefined, "2026-08-29T09:00:00.000Z"),
    status: "AWAITING",
    requestedAt: "2026-08-29T09:00:00.000Z",
    rounds,
  };
  f.payload = {
    head: "headsha",
    reviews: [{ author: "copilot", commit: "headsha", submittedAt: "2026-08-29T10:00:00.000Z", state: "COMMENTED" }],
    threads: [thread(), thread({ id: "T2", path: "lib/foo.ts", line: 7, excerpt: "stale reply text", body: "stale reply text" })],
  };
}

test("read: rounds 1–3 never raise a dialog — the agent still triages alone", async () => {
  for (const rounds of [0, 1, 2, 3]) {
    const f = fake();
    atRound(f, rounds);
    const reply = await call(f);
    assert.equal(reply.details?.status, "OPEN");
    assert.deepEqual(f.asked, [], `round ${rounds} must not ask`);
    assert.match(textOf(reply), /2 Copilot thread\(s\) waiting on you \(0 resolved, 0 answered\)/);
    assert.match(textOf(reply), /For each: fix it and resolve the thread/);
    assert.match(textOf(reply), /resolveReviewThread/, "the pre-round-4 wording is unchanged");
    assert.equal(f.st.copilot?.triage, undefined);
  }
});

test("read: round 4 asks about each finding, one dialog each, and groups the answer", async () => {
  const f = fake();
  atRound(f, 4);
  f.answers = [FIX_CHOICE, DECLINE_CHOICE];
  const reply = await call(f);
  const text = textOf(reply);

  assert.equal(f.asked.length, 2, "one dialog per open finding");
  assert.equal(f.asked[0]?.spec.title, "Copilot 评审问题 1 / 2：lib/copilot-gh.ts:12");
  assert.equal(f.asked[1]?.spec.title, "Copilot 评审问题 2 / 2：lib/foo.ts:7");
  assert.deepEqual(f.asked[0]?.spec.options, [FIX_CHOICE, DECLINE_CHOICE, IRRELEVANT_CHOICE]);
  assert.equal(f.asked[0]?.spec.recommended, FIX_CHOICE);
  assert.deepEqual(f.asked[0]?.extraRows, [SKIP_REST_CHOICE], "an interview still has an escape row");
  assert.match(f.asked[0]?.body ?? "", /this argv is not escaped/, "the dialog carries the comment");
  // The full text goes to the transcript BEFORE the box. The row budget that
  // used to clip the dialog and make that copy necessary is gone (2026-09-16),
  // but the copy stays: a long finding scrolls past inside a box, and
  // approving one you cannot read is the bug it guards either way.
  assert.equal(f.asked[0]?.pointer, undefined, "no truncation pointer any more — nothing is cut");
  assert.equal(f.notices.length, 2);
  assert.equal(f.notices[0]?.lead, "───── Copilot 评审问题 1 / 2：lib/copilot-gh.ts:12 ─────");
  assert.match(f.notices[0]?.body ?? "", /this argv is not escaped/);

  // Only the approved finding is the agent's to change.
  assert.match(text, /✅ 修复（1 条）—— 只许改这些：/);
  assert.match(text, /- T1 lib\/copilot-gh\.ts:12/);
  assert.match(text, /🚫 不修，回复说明（1 条）/);
  assert.match(text, /- T2 lib\/foo\.ts:7 — 用户没给理由 —— 你写一句简短说明/);
  assert.match(text, /⏸ 未获批准（0 条）/);
  assert.match(text, /Then call copilot_review again\./);

  assert.deepEqual(reply.details?.triage, { fix: 1, decline: 1, irrelevant: 0, unanswered: 0, deferred: 0 });
  // The answers are in the sidecar, keyed by the finding they were made about.
  assert.deepEqual(f.st.copilot?.triage?.records.map((r) => [r.threadId, r.commentId, r.decision, r.reason]), [
    ["T1", "C1", "fix", undefined],
    ["T2", "C1", "decline", undefined],
  ]);
  assert.deepEqual(f.persisted, [ROOT]);
});

test("read: an already-decided finding is not asked again, and keeps its group", async () => {
  const f = fake();
  atRound(f, 5);
  f.st.copilot = {
    ...f.st.copilot!,
    triage: recordDecision(undefined, thread(), "irrelevant", "2026-08-29T09:30:00.000Z"),
  };
  const reply = await call(f);
  assert.deepEqual(f.asked.map((a) => a.spec.title), ["Copilot 评审问题 1 / 1：lib/foo.ts:7"],
    "only the finding without a decision is put to the user — and the progress counts the questions THIS call asks");
  const text = textOf(reply);
  assert.match(text, /➖ 与我无关，直接 resolve（1 条）/);
  assert.match(text, /resolve 掉，不要在 thread 里回复/);
});

test("read: Copilot commenting again on the SAME thread is a new question", async () => {
  const f = fake();
  atRound(f, 6);
  f.st.copilot = {
    ...f.st.copilot!,
    triage: recordDecision(undefined, thread(), "fix", "2026-08-29T09:30:00.000Z"),
  };
  f.payload = {
    ...f.payload!,
    threads: [thread({ lastCommentId: "C2" })],
  };
  await call(f);
  assert.equal(f.asked.length, 1, "the new comment re-opens the question");
  assert.equal(f.asked[0]?.spec.title, "Copilot 评审问题 1 / 1：lib/copilot-gh.ts:12");
});

test("read: an unanswered finding is NOT approval — no record, no fix, reported as such", async () => {
  const f = fake();
  atRound(f, 4);
  f.answers = [undefined, FIX_CHOICE]; // ESC on the first
  const reply = await call(f);
  const text = textOf(reply);
  assert.equal(f.notices.length, 2, "both findings were shown, even the one nobody answered");
  assert.match(text, /⏸ 未获批准（1 条）—— 这些代码不许改，只如实告诉他：/);
  assert.match(text, /- T1 lib\/copilot-gh\.ts:12 —— 他没表态 —— 不许改、不许代他回复。/);
  assert.match(text, /✅ 修复（1 条）/);
  assert.equal(f.st.copilot?.triage?.records.length, 1, "only the answered finding is recorded");
  assert.equal(f.st.copilot?.triage?.records[0]?.threadId, "T2");

  // …and the next call puts the unanswered one back in front of them.
  f.answers = [FIX_CHOICE];
  const again = await call(f);
  assert.deepEqual(f.asked.slice(2).map((a) => a.spec.title), ["Copilot 评审问题 1 / 1：lib/copilot-gh.ts:12"]);
  assert.match(textOf(again), /✅ 修复（2 条）/);
});

test("read: the ✎ row is carried to the agent as the user's own words, and is NOT consent", async () => {
  const f = fake();
  atRound(f, 4);
  f.answers = [`${DECLINE_ROW}：这条我另有打算`, FIX_CHOICE];
  const text = textOf(await call(f));
  assert.match(text, /- T1 lib\/copilot-gh\.ts:12 —— 用户没选任何选项，原话：「这条我另有打算」/);
  assert.match(text, /照它回复并 resolve；如果他要的是别的，用 ask_user 问清再动/);
  assert.equal(f.st.copilot?.triage?.records.length, 1,
    "the ✎ row records nothing: a non-choice is not a decision");
  assert.equal(f.st.copilot?.triage?.records[0]?.threadId, "T2");
});

test("read: skipping the rest leaves the unasked findings unanswered, not decided", async () => {
  const f = fake();
  atRound(f, 4);
  f.payload = {
    ...f.payload!,
    threads: [thread({ id: "A" }), thread({ id: "B" }), thread({ id: "C" })],
  };
  f.answers = [FIX_CHOICE, SKIP_REST_CHOICE];
  const reply = await call(f);
  assert.equal(f.asked.length, 2, "the box the user skipped never opens");
  assert.match(textOf(reply), /✅ 修复（1 条）/);
  assert.match(textOf(reply), /⏸ 未获批准（2 条）/);
  assert.match(textOf(reply), /- B .* —— 他没表态/);
});

test("read: findings past the per-call cap are reported as deferred, never dropped", async () => {
  const f = fake();
  atRound(f, 4);
  f.payload = {
    ...f.payload!,
    threads: Array.from({ length: COPILOT_TRIAGE_MAX_QUESTIONS + 2 }, (_, i) => thread({ id: `T${i}` })),
  };
  f.answers = new Array(COPILOT_TRIAGE_MAX_QUESTIONS).fill(FIX_CHOICE);
  const reply = await call(f);
  assert.equal(f.asked.length, COPILOT_TRIAGE_MAX_QUESTIONS);
  const triage = reply.details?.triage as { fix: number; unanswered: number; deferred: number };
  assert.equal(triage.fix, COPILOT_TRIAGE_MAX_QUESTIONS);
  assert.equal(triage.unanswered, 2, "the ones nobody got to are unanswered, not approved");
  assert.equal(triage.deferred, 2);
  assert.match(textOf(reply), /还有 2 条没来得及问用户，下一次 copilot_review 会接着问/);
});

test("read: a round with nothing actionable asks nothing, however late it is", async () => {
  for (const threads of [[], [thread({ id: "done", isResolved: true })], [thread({ id: "ours", lastAuthor: "alice" })]]) {
    const f = fake();
    atRound(f, 7);
    f.payload = { ...f.payload!, threads };
    const reply = await call(f);
    assert.deepEqual(f.asked, []);
    assert.equal(reply.details?.triage, undefined);
    assert.equal(reply.details?.status, "SATISFIED");
  }
});
