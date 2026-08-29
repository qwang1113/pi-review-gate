import test from "node:test";
import assert from "node:assert/strict";

import {
  registerCopilotReviewTools,
  COPILOT_CHECK_ATTEMPTS,
  COPILOT_CHECK_DELAY_MS,
  type CopilotReviewToolDeps,
} from "../lib/copilot-review-tools.ts";
import type { ToolHost, ToolReply } from "../lib/tool-host.ts";
import { emptyState, type GateState } from "../lib/gate-state.ts";
import {
  armCopilotReview,
  releaseCopilotReview,
  type CopilotPayload,
  type CopilotThread,
  type PrSummary,
} from "../lib/copilot-review.ts";

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
