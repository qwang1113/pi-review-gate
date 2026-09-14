import test from "node:test";
import assert from "node:assert/strict";

import {
  registerCopilotReviewTools,
  COPILOT_CHECK_ATTEMPTS,
  COPILOT_CHECK_DELAY_MS,
  type CopilotReviewToolDeps,
} from "../lib/copilot-review-tools.ts";
import type { ToolHost, ToolReply } from "../lib/tool-host.ts";
import type { ChoiceSpec } from "../lib/choice-dialog.ts";
import { emptyState, type GateState } from "../lib/gate-state.ts";
import {
  armCopilotReview,
  releaseCopilotReview,
  type CopilotPayload,
  type CopilotThread,
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
 * The two Copilot tools used to live inside the 8900-line extension, where
 * exercising "GitHub refused the request" or "three threads are waiting on
 * you" meant a real repository, a real PR and a real `gh`. They are now a
 * lib/ module whose GitHub access arrives as `deps.gh` — so every branch below
 * runs against fakes, and a behavior change during the move would have to
 * survive an assertion instead of a reviewer's eyes.
 */

const ROOT = "/repo";
const PR: PrSummary = { number: 42, head: "headsha", url: "https://github.com/o/r/pull/42", state: "OPEN" };

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
  requested: { ok: boolean; stdout: string; stderr: string };
  support: { support: "CONFIRMED" | "UNKNOWN"; confirmed: boolean };
  /** Every triage dialog the tool raised, in order. */
  asked: { spec: ChoiceSpec; body?: string; extraRows?: string[] }[];
  /** What the user picks, one entry per dialog; a missing entry is ESC. */
  answers: (string | undefined)[];
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
    lastCommentId: "C1",
    ...over,
  };
}

function fake(overrides: Partial<Fake> = {}): Fake {
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
    requested: { ok: true, stdout: "", stderr: "" },
    support: { support: "CONFIRMED", confirmed: true },
    asked: [],
    answers: [],
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
    gh: {
      resolveOpenPr: async (...args) => { record("resolveOpenPr", args); return state.openPr; },
      resolveRepoSlug: async (...args) => { record("resolveRepoSlug", args); return state.slug; },
      fetchCopilotPayload: async (...args) => { record("fetchCopilotPayload", args); return state.payload; },
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
  tool: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<ToolReply> {
  const run = f.tools.get(tool);
  assert.ok(run, `${tool} must be registered`);
  return run(params, signal);
}

test("the module registers exactly the two Copilot review tools, in order", () => {
  const f = fake();
  assert.deepEqual(f.order, ["request_copilot_review", "check_copilot_review"]);
});

// ---------- the loop being off, and the repo being unresolvable ----------

test("both tools short-circuit as DISABLED when the loop is off for this repo/mode", async () => {
  for (const [tool, tail] of [
    ["request_copilot_review", "nothing to do."],
    ["check_copilot_review", "nothing to check."],
  ] as const) {
    const f = fake({ enabled: false });
    const reply = await call(f, tool);
    assert.equal(reply.details?.status, "DISABLED");
    assert.ok(textOf(reply).endsWith(tail), `${tool} must keep its own wording`);
    // A disabled loop spends no API call and records nothing.
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.persisted, []);
    assert.equal(f.armed, 0);
  }
});

test("an unresolvable repo is reported verbatim and nothing is gathered", async () => {
  for (const tool of ["request_copilot_review", "check_copilot_review"]) {
    const f = fake();
    f.repo = { ok: false, error: "review-gate: which repo?" };
    const reply = await call(f, tool);
    assert.equal(reply.isError, true);
    assert.equal(textOf(reply), "review-gate: which repo?");
    assert.deepEqual(f.calls, []);
  }
});

// ---------- request_copilot_review ----------

test("request: no PR releases the requirement as UNSUPPORTED, with the reason", async () => {
  const f = fake({ openPr: { error: "no pull requests found" } });
  const reply = await call(f, "request_copilot_review");
  assert.equal(reply.details?.status, "UNSUPPORTED");
  assert.match(textOf(reply), /no Copilot review for this repo — no pull requests found\. Requirement released \(UNSUPPORTED\); it is not blocking completion\./);
  assert.equal(f.st.copilot?.status, "UNSUPPORTED");
  assert.deepEqual(f.persisted, [ROOT]);
  assert.match(f.logs[0], /copilot cycle released UNSUPPORTED on request: no pull requests found/);
  // gh runs in the directory the deps resolve, never in a guessed cwd.
  assert.deepEqual(f.calls.map((c) => c.name), ["resolveOpenPr"]);
  assert.equal(f.calls[0].args[0], `${ROOT}/dir`);
});

test("request: a release with findings still open carries the abandoned-threads notice", async () => {
  const f = fake({ openPr: { error: "no pull requests found" } });
  f.st.copilot = { ...armCopilotReview(undefined, "2026-08-29T10:00:00.000Z"), pr: 42, openThreads: 3 };
  const reply = await call(f, "request_copilot_review");
  assert.match(textOf(reply), /3 Copilot thread\(s\) were still waiting on you at the last check/);
  assert.match(textOf(reply), /\(PR #42\)/);
});

test("request: a REFUSED request releases UNSUPPORTED with gh's own first stderr line", async () => {
  const f = fake({ requested: { ok: false, stdout: "", stderr: "\n  could not add reviewer: HTTP 422\nmore\n" } });
  const reply = await call(f, "request_copilot_review");
  assert.deepEqual(reply.details, { status: "UNSUPPORTED", pr: 42 });
  assert.match(textOf(reply), /not available for PR #42 — could not add reviewer: HTTP 422\. Requirement released \(UNSUPPORTED\)\./);
  assert.equal(f.st.copilot?.status, "UNSUPPORTED");
  // The cycle binds to the head the request was made against.
  assert.equal(f.st.copilot?.head, "headsha");
  assert.deepEqual(f.persisted, [ROOT]);
});

test("request: an ABORTED request records nothing — ESC proves nothing about Copilot", async () => {
  const f = fake({ requested: { ok: false, stdout: "", stderr: "aborted" } });
  f.st.copilot = armCopilotReview(undefined, "2026-08-29T10:00:00.000Z");
  const controller = new AbortController();
  controller.abort();
  const reply = await call(f, "request_copilot_review", {}, controller.signal);
  assert.match(textOf(reply), /aborted before the Copilot review request completed — nothing recorded/);
  assert.deepEqual(reply.details, { status: "ARMED", pr: 42 });
  // No release, no persist, no log line: the state machine did not move.
  assert.equal(f.st.copilot?.status, "ARMED");
  assert.deepEqual(f.persisted, []);
  assert.deepEqual(f.logs, []);
});

test("request: a successful request records the round, arms the loop and reports AWAITING", async () => {
  const f = fake();
  const reply = await call(f, "request_copilot_review");
  assert.deepEqual(reply.details, { status: "AWAITING", pr: 42, rounds: 1, support: "CONFIRMED" });
  assert.match(textOf(reply), /Copilot review requested for PR #42 \(round 1\)\. Copilot usually answers within a minute\./);
  assert.equal(f.st.copilot?.status, "AWAITING");
  assert.equal(f.st.copilot?.supportConfirmed, true);
  assert.equal(f.armed, 1, "an outstanding requirement re-arms the auto-continuation");
  assert.deepEqual(f.persisted, [ROOT]);
  // Availability is resolved BEFORE the request is spent, from the sidecar's
  // own remembered evidence.
  assert.deepEqual(f.calls.map((c) => c.name),
    ["resolveOpenPr", "resolveRepoSlug", "resolveCopilotSupport", "requestCopilotReviewer"]);
  assert.equal(f.calls[2].args[2], false, "no remembered evidence yet on a fresh state");
});

test("request: UNKNOWN availability changes the WAIT note, never the request itself", async () => {
  const f = fake({ support: { support: "UNKNOWN", confirmed: false } });
  const reply = await call(f, "request_copilot_review");
  assert.equal(reply.details?.support, "UNKNOWN");
  assert.match(textOf(reply), /No Copilot review has ever appeared on this repository's recent PRs/);
  assert.ok(f.calls.some((c) => c.name === "requestCopilotReviewer"), "the request still goes out");
  assert.equal(f.st.copilot?.status, "AWAITING");
  assert.notEqual(f.st.copilot?.supportConfirmed, true);
});

// ---------- check_copilot_review ----------

test("check: an already RELEASED cycle is left alone — no gh call, no state rewrite", async () => {
  const f = fake();
  f.st.copilot = releaseCopilotReview(
    { ...armCopilotReview(undefined, "2026-08-29T10:00:00.000Z"), pr: 42, openThreads: 2 },
    "UNSUPPORTED", "no Copilot review possible: no pull requests found", "2026-08-29T10:05:00.000Z");
  const before = f.st.copilot;
  const reply = await call(f, "check_copilot_review");
  assert.equal(reply.details?.status, "UNSUPPORTED");
  assert.equal(reply.details?.pr, 42);
  assert.equal(reply.details?.unhandled, 2);
  assert.match(textOf(reply), /already released \(UNSUPPORTED\) — no Copilot review possible/);
  // The duty survives the re-check…
  assert.match(textOf(reply), /2 Copilot thread\(s\) were still waiting on you at the last check/);
  // …and nothing was re-derived: no gh call, no persist, no re-arming.
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.persisted, []);
  assert.equal(f.armed, 0);
  assert.equal(f.st.copilot, before);
});

test("check: no PR releases UNSUPPORTED before any thread query", async () => {
  const f = fake({ openPr: { error: "no pull requests found" } });
  const reply = await call(f, "check_copilot_review");
  assert.equal(reply.details?.status, "UNSUPPORTED");
  assert.match(textOf(reply), /no pull request to check — no pull requests found/);
  assert.deepEqual(f.calls.map((c) => c.name), ["resolveOpenPr"]);
  assert.match(f.logs[0], /copilot cycle released UNSUPPORTED on check/);
});

test("check: an unresolvable owner/repo releases UNSUPPORTED (the GraphQL query needs it)", async () => {
  const f = fake({ slug: null });
  const reply = await call(f, "check_copilot_review");
  assert.equal(reply.details?.status, "UNSUPPORTED");
  assert.match(textOf(reply), /could not determine owner\/repo for this PR/);
  assert.deepEqual(f.calls.map((c) => c.name), ["resolveOpenPr", "resolveRepoSlug"]);
  assert.match(f.logs[0], /no owner\/repo for PR #42/);
});

test("check: an unreadable payload polls the documented number of times, then releases", async () => {
  const f = fake({ payload: undefined });
  const reply = await call(f, "check_copilot_review");
  assert.equal(reply.details?.status, "UNSUPPORTED");
  assert.match(textOf(reply), /could not read the PR's review threads \(gh missing, unauthenticated, or API refusal\)/);
  const fetches = f.calls.filter((c) => c.name === "fetchCopilotPayload").length;
  assert.equal(fetches, COPILOT_CHECK_ATTEMPTS, "the optimistic poll runs its full course");
  assert.deepEqual(f.delays, new Array(COPILOT_CHECK_ATTEMPTS - 1).fill(COPILOT_CHECK_DELAY_MS),
    "…waiting between attempts, but never after the last one");
  assert.equal(f.st.copilot?.status, "UNSUPPORTED");
});

test("check: OPEN threads are listed with their ids, the how-to, and the counts in details", async () => {
  const f = fake();
  f.st.copilot = { ...armCopilotReview(undefined, "2026-08-29T09:00:00.000Z"), requestedAt: "2026-08-29T09:00:00.000Z" };
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
  const reply = await call(f, "check_copilot_review");
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
  // The poll stops as soon as the status leaves AWAITING.
  assert.equal(f.calls.filter((c) => c.name === "fetchCopilotPayload").length, 1);
  assert.deepEqual(f.delays, []);
});

test("check: a silent Copilot stays AWAITING and asks to be checked again", async () => {
  const f = fake();
  f.st.copilot = { ...armCopilotReview(undefined, "2026-08-29T09:00:00.000Z"), requestedAt: new Date().toISOString() };
  const reply = await call(f, "check_copilot_review");
  assert.equal(reply.details?.status, "AWAITING");
  assert.match(textOf(reply), /Copilot has not posted its review of PR #42 yet\./);
  assert.equal(f.calls.filter((c) => c.name === "fetchCopilotPayload").length, COPILOT_CHECK_ATTEMPTS);
  assert.equal(f.armed, 1, "an unanswered review is still outstanding");
});

test("check: availability is queried ONCE while the PR shows nothing", async () => {
  const f = fake();
  f.st.copilot = { ...armCopilotReview(undefined, "2026-08-29T09:00:00.000Z"), requestedAt: new Date().toISOString() };
  await call(f, "check_copilot_review");
  assert.equal(f.calls.filter((c) => c.name === "resolveCopilotSupport").length, 1,
    "an empty PR is worth one availability query per call, not one per attempt");
});

// ---------- the user's per-finding approval (round 4 on) ----------

/** A live cycle at a given round, with Copilot's review already posted. */
function atRound(f: Fake, rounds: number): void {
  f.st.copilot = {
    ...armCopilotReview(undefined, "2026-08-29T09:00:00.000Z"),
    requestedAt: "2026-08-29T09:00:00.000Z",
    rounds,
  };
  f.payload = {
    head: "headsha",
    reviews: [{ author: "copilot", commit: "headsha", submittedAt: "2026-08-29T10:00:00.000Z", state: "COMMENTED" }],
    threads: [thread(), thread({ id: "T2", path: "lib/foo.ts", line: 7, excerpt: "stale reply text", body: "stale reply text" })],
  };
}

test("check: rounds 1–3 never raise a dialog — the agent still triages alone", async () => {
  for (const rounds of [0, 1, 2, 3]) {
    const f = fake();
    atRound(f, rounds);
    const reply = await call(f, "check_copilot_review");
    assert.equal(reply.details?.status, "OPEN");
    assert.deepEqual(f.asked, [], `round ${rounds} must not ask`);
    assert.match(textOf(reply), /2 Copilot thread\(s\) waiting on you \(0 resolved, 0 answered\)/);
    assert.match(textOf(reply), /For each: fix it and resolve the thread/);
    assert.match(textOf(reply), /resolveReviewThread/, "the pre-round-4 wording is unchanged");
    assert.equal(f.st.copilot?.triage, undefined);
  }
});

test("check: round 4 asks about each finding, one dialog each, and groups the answer", async () => {
  const f = fake();
  atRound(f, 4);
  f.answers = [FIX_CHOICE, DECLINE_CHOICE];
  const reply = await call(f, "check_copilot_review");
  const text = textOf(reply);

  assert.equal(f.asked.length, 2, "one dialog per open finding");
  assert.equal(f.asked[0]?.spec.title, "Copilot 评审问题 1 / 2：lib/copilot-gh.ts:12");
  assert.equal(f.asked[1]?.spec.title, "Copilot 评审问题 2 / 2：lib/foo.ts:7");
  assert.deepEqual(f.asked[0]?.spec.options, [FIX_CHOICE, DECLINE_CHOICE, IRRELEVANT_CHOICE]);
  assert.equal(f.asked[0]?.spec.recommended, FIX_CHOICE);
  assert.deepEqual(f.asked[0]?.extraRows, [SKIP_REST_CHOICE], "an interview still has an escape row");
  assert.match(f.asked[0]?.body ?? "", /this argv is not escaped/, "the dialog carries the comment");

  // Only the approved finding is the agent's to change.
  assert.match(text, /✅ 修复（1 条）—— 只许改这些：/);
  assert.match(text, /- T1 lib\/copilot-gh\.ts:12/);
  assert.match(text, /🚫 不修，回复说明（1 条）/);
  assert.match(text, /- T2 lib\/foo\.ts:7 — 用户没给理由 —— 你写一句简短说明/);
  assert.match(text, /⏸ 未获批准（0 条）/);
  assert.match(text, /Then call check_copilot_review again\./);

  assert.deepEqual(reply.details?.triage, { fix: 1, decline: 1, irrelevant: 0, unanswered: 0, deferred: 0 });
  // The answers are in the sidecar, keyed by the finding they were made about.
  assert.deepEqual(f.st.copilot?.triage?.records.map((r) => [r.threadId, r.commentId, r.decision, r.reason]), [
    ["T1", "C1", "fix", undefined],
    ["T2", "C1", "decline", undefined],
  ]);
  assert.deepEqual(f.persisted, [ROOT]);
});

test("check: an already-decided finding is not asked again, and keeps its group", async () => {
  const f = fake();
  atRound(f, 5);
  f.st.copilot = {
    ...f.st.copilot!,
    triage: recordDecision(undefined, thread(), "irrelevant", "2026-08-29T09:30:00.000Z"),
  };
  const reply = await call(f, "check_copilot_review");
  assert.deepEqual(f.asked.map((a) => a.spec.title), ["Copilot 评审问题 1 / 1：lib/foo.ts:7"],
    "only the finding without a decision is put to the user — and the progress counts the questions THIS call asks");
  const text = textOf(reply);
  assert.match(text, /➖ 与我无关，直接 resolve（1 条）/);
  assert.match(text, /resolve 掉，不要在 thread 里回复/);
});

test("check: Copilot commenting again on the SAME thread is a new question", async () => {
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
  await call(f, "check_copilot_review");
  assert.equal(f.asked.length, 1, "the new comment re-opens the question");
  assert.equal(f.asked[0]?.spec.title, "Copilot 评审问题 1 / 1：lib/copilot-gh.ts:12");
});

test("check: an unanswered finding is NOT approval — no record, no fix, reported as such", async () => {
  const f = fake();
  atRound(f, 4);
  f.answers = [undefined, FIX_CHOICE]; // ESC on the first
  const reply = await call(f, "check_copilot_review");
  const text = textOf(reply);
  assert.match(textOf(reply), /⏸ 未获批准（1 条）—— 这些代码不许改，只如实告诉他：/);
  assert.match(textOf(reply), /- T1 lib\/copilot-gh\.ts:12 —— 他没表态 —— 不许改、不许代他回复。/);
  assert.match(text, /✅ 修复（1 条）/);
  assert.equal(f.st.copilot?.triage?.records.length, 1, "only the answered finding is recorded");
  assert.equal(f.st.copilot?.triage?.records[0]?.threadId, "T2");

  // …and the next check puts the unanswered one back in front of them.
  f.answers = [FIX_CHOICE];
  const again = await call(f, "check_copilot_review");
  assert.deepEqual(f.asked.slice(2).map((a) => a.spec.title), ["Copilot 评审问题 1 / 1：lib/copilot-gh.ts:12"]);
  assert.match(textOf(again), /✅ 修复（2 条）/);
});

test("check: the ✎ row is carried to the agent as the user's own words, and is NOT consent", async () => {
  const f = fake();
  atRound(f, 4);
  f.answers = [`${DECLINE_ROW}：这条我另有打算`, FIX_CHOICE];
  const text = textOf(await call(f, "check_copilot_review"));
  assert.match(text, /- T1 lib\/copilot-gh\.ts:12 —— 用户没选任何选项，原话：「这条我另有打算」/);
  assert.match(text, /照它回复并 resolve；如果他要的是别的，用 ask_user 问清再动/);
  assert.equal(f.st.copilot?.triage?.records.length, 1,
    "the ✎ row records nothing: a non-choice is not a decision");
  assert.equal(f.st.copilot?.triage?.records[0]?.threadId, "T2");
});

test("check: skipping the rest leaves the unasked findings unanswered, not decided", async () => {
  const f = fake();
  atRound(f, 4);
  f.payload = {
    ...f.payload!,
    threads: [thread({ id: "A" }), thread({ id: "B" }), thread({ id: "C" })],
  };
  f.answers = [FIX_CHOICE, SKIP_REST_CHOICE];
  const reply = await call(f, "check_copilot_review");
  assert.equal(f.asked.length, 2, "the box the user skipped never opens");
  assert.match(textOf(reply), /✅ 修复（1 条）/);
  assert.match(textOf(reply), /⏸ 未获批准（2 条）/);
  assert.match(textOf(reply), /- B .* —— 他没表态/);
});

test("check: findings past the per-call cap are reported as deferred, never dropped", async () => {
  const f = fake();
  atRound(f, 4);
  f.payload = {
    ...f.payload!,
    threads: Array.from({ length: COPILOT_TRIAGE_MAX_QUESTIONS + 2 }, (_, i) => thread({ id: `T${i}` })),
  };
  f.answers = new Array(COPILOT_TRIAGE_MAX_QUESTIONS).fill(FIX_CHOICE);
  const reply = await call(f, "check_copilot_review");
  assert.equal(f.asked.length, COPILOT_TRIAGE_MAX_QUESTIONS);
  const triage = reply.details?.triage as { fix: number; unanswered: number; deferred: number };
  assert.equal(triage.fix, COPILOT_TRIAGE_MAX_QUESTIONS);
  assert.equal(triage.unanswered, 2, "the ones nobody got to are unanswered, not approved");
  assert.equal(triage.deferred, 2);
  assert.match(textOf(reply), /还有 2 条没来得及问用户，下一次 check_copilot_review 会接着问/);
});

test("check: a round with nothing actionable asks nothing, however late it is", async () => {
  for (const threads of [[], [thread({ id: "done", isResolved: true })], [thread({ id: "ours", lastAuthor: "alice" })]]) {
    const f = fake();
    atRound(f, 7);
    f.payload = { ...f.payload!, threads };
    const reply = await call(f, "check_copilot_review");
    assert.deepEqual(f.asked, []);
    assert.equal(reply.details?.triage, undefined);
    assert.equal(reply.details?.status, "SATISFIED");
  }
});
