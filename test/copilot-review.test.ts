/**
 * L7 — the post-PR Copilot review cycle (lib/copilot-review.ts).
 *
 * The rules under test are the ones that decide whether a task may END, so
 * each test names the failure it prevents: a cycle waved through unreviewed, a
 * thread silently dropped, a loop that never terminates, or — just as bad — a
 * requirement that strands a task on a repo where Copilot does not exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COPILOT_AWAIT_TIMEOUT_MS,
  COPILOT_MAX_ROUNDS,
  COPILOT_MAX_ROUNDS_DEFAULT,
  COPILOT_MIN_ROUNDS,
  COPILOT_REVIEWER_LOGIN,
  COPILOT_THREADS_QUERY,
  analyzeCopilot,
  armCopilotReview,
  copilotProblems,
  evaluateCopilot,
  isCopilotAuthor,
  isCopilotOutstanding,
  parseCopilotPayload,
  parseNameWithOwner,
  parsePrView,
  recordCopilotRequest,
  releaseCopilotReview,
  sanitizeCopilotState,
  slugFromPrUrl,
  type CopilotPayload,
  type CopilotReviewState,
} from "../lib/copilot-review.ts";

const NOW_ISO = "2026-08-07T10:00:00.000Z";
const NOW = Date.parse(NOW_ISO);

function payload(over: Partial<CopilotPayload> = {}): CopilotPayload {
  return { head: "abc123", reviews: [], threads: [], ...over };
}

function thread(over: Partial<CopilotPayload["threads"][number]> = {}) {
  return {
    id: "PRRT_1",
    isResolved: false,
    isOutdated: false,
    path: "lib/x.ts",
    line: 12,
    author: "copilot-pull-request-reviewer",
    lastAuthor: "copilot-pull-request-reviewer",
    createdAt: NOW_ISO,
    excerpt: "consider handling the null case",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Identity

test("every spelling GitHub uses for the Copilot reviewer maps to one actor", () => {
  // REST wants `copilot-pull-request-reviewer[bot]`, GraphQL reports the login
  // without the suffix, the CLI shorthand is `@copilot`. Missing one spelling
  // would silently classify Copilot's own threads as somebody else's and let
  // the cycle finish with everything still open.
  for (const login of [
    "copilot-pull-request-reviewer[bot]", "copilot-pull-request-reviewer",
    "Copilot", "copilot", "GitHub-Copilot[bot]",
  ]) {
    assert.equal(isCopilotAuthor(login), true, login);
  }
  for (const other of ["coderabbitai", "dependabot[bot]", "alice", "", null, undefined]) {
    assert.equal(isCopilotAuthor(other as string), false, String(other));
  }
  assert.equal(COPILOT_REVIEWER_LOGIN, "copilot-pull-request-reviewer[bot]");
});

// ---------------------------------------------------------------------------
// Payload parsing — tolerant, never throwing, never optimistic

test("gh payloads that are garbage parse to 'no data', not to an exception", () => {
  for (const bad of ["", "not json", "null", "[]", '{"number":"12"}', '{"number":0}']) {
    assert.equal(parsePrView(bad), undefined, bad);
  }
  assert.deepEqual(
    parsePrView('{"number":12,"headRefOid":"deadbeef","url":"https://github.com/o/r/pull/12","state":"OPEN"}'),
    { number: 12, head: "deadbeef", url: "https://github.com/o/r/pull/12", state: "OPEN" },
  );
  for (const bad of ["", "{}", "not json", '{"data":{"repository":null}}']) {
    assert.equal(parseCopilotPayload(bad), undefined, bad);
  }
});

test("owner/name comes from gh, with a host-agnostic URL fallback", () => {
  assert.equal(parseNameWithOwner('{"nameWithOwner":"acme/widgets"}'), "acme/widgets");
  assert.equal(parseNameWithOwner('{"nameWithOwner":"broken"}'), null);
  assert.equal(parseNameWithOwner("nope"), null);
  // GHES hosts differ, so the fallback anchors on /pull/<n>, not on the host.
  assert.equal(slugFromPrUrl("https://github.com/acme/widgets/pull/7"), "acme/widgets");
  assert.equal(slugFromPrUrl("https://git.corp.example/acme/widgets/pull/7"), "acme/widgets");
  assert.equal(slugFromPrUrl("https://github.com/acme/widgets"), null);
  assert.equal(slugFromPrUrl(null), null);
});

test("the GraphQL query asks for BOTH ends of each thread (who started, who spoke last)", () => {
  // Dropping either selection breaks a different rule: without the first
  // comment we cannot tell Copilot's threads from a human's, without the last
  // one we cannot tell whether the ball is in our court.
  assert.match(COPILOT_THREADS_QUERY, /firstComment: comments\(first:1\)/);
  assert.match(COPILOT_THREADS_QUERY, /lastComment: comments\(last:1\)/);
  assert.match(COPILOT_THREADS_QUERY, /isResolved/);
  assert.match(COPILOT_THREADS_QUERY, /commit\{oid\}/);
});

test("a real GraphQL payload maps onto the thread/review model", () => {
  const raw = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          headRefOid: "abc123",
          reviews: { nodes: [{ author: { login: "Copilot" }, submittedAt: NOW_ISO, state: "COMMENTED", commit: { oid: "abc123" } }] },
          reviewThreads: {
            nodes: [{
              id: "PRRT_x", isResolved: false, isOutdated: true, path: "a.ts", line: 3,
              firstComment: { nodes: [{ author: { login: "Copilot" }, createdAt: NOW_ISO, body: "  multi\n  line   body  " }] },
              lastComment: { nodes: [{ author: { login: "alice" }, createdAt: NOW_ISO }] },
            }],
          },
        },
      },
    },
  });
  const parsed = parseCopilotPayload(raw);
  assert.equal(parsed?.head, "abc123");
  assert.equal(parsed?.reviews[0].commit, "abc123");
  assert.equal(parsed?.threads[0].isOutdated, true);
  assert.equal(parsed?.threads[0].author, "Copilot");
  assert.equal(parsed?.threads[0].lastAuthor, "alice");
  assert.equal(parsed?.threads[0].excerpt, "multi line body");
});

// ---------------------------------------------------------------------------
// analyzeCopilot — has Copilot reviewed, and what still waits on us

test("'Copilot reviewed this' is proven by the COMMIT first, clock second", () => {
  const commitAnchored = analyzeCopilot(
    payload({ reviews: [{ author: "Copilot", submittedAt: "1999-01-01T00:00:00Z", commit: "abc123", state: "COMMENTED" }] }),
    { anchorAt: NOW_ISO },
  );
  assert.equal(commitAnchored.reviewed, true, "a review OF the current head needs no clock");

  const timeAnchored = analyzeCopilot(
    payload({ reviews: [{ author: "Copilot", submittedAt: NOW_ISO, commit: null, state: "COMMENTED" }] }),
    { anchorAt: NOW_ISO },
  );
  assert.equal(timeAnchored.reviewed, true, "no commit in the payload ⇒ fall back to the timestamp");

  const stale = analyzeCopilot(
    payload({ reviews: [{ author: "Copilot", submittedAt: "2026-08-07T09:00:00Z", commit: "old", state: "COMMENTED" }] }),
    { anchorAt: NOW_ISO },
  );
  assert.equal(stale.reviewed, false, "a review of OLD code is not a review of this cycle");

  // An unparseable anchor must not become "anything counts" — that is the one
  // direction that waves an unreviewed cycle through.
  const noAnchor = analyzeCopilot(
    payload({ reviews: [{ author: "Copilot", submittedAt: NOW_ISO, commit: null, state: "COMMENTED" }] }),
    { anchorAt: undefined },
  );
  assert.equal(noAnchor.reviewed, false);
  const noAnchorButCommit = analyzeCopilot(
    payload({ reviews: [{ author: "Copilot", submittedAt: NOW_ISO, commit: "abc123", state: "COMMENTED" }] }),
    { anchorAt: "not a date" },
  );
  assert.equal(noAnchorButCommit.reviewed, true);
});

test("Copilot posting only inline threads (no review object) still counts as reviewed", () => {
  const a = analyzeCopilot(payload({ threads: [thread()] }), { anchorAt: NOW_ISO });
  assert.equal(a.reviewed, true, "an inline thread is Copilot having spoken");
});

test("a thread waits on us only while COPILOT spoke last; our reply settles it", () => {
  const a = analyzeCopilot(payload({
    threads: [
      thread({ id: "open" }),                                    // Copilot last ⇒ ours to handle
      thread({ id: "answered", lastAuthor: "alice" }),            // we explained ⇒ accepted
      thread({ id: "resolved", isResolved: true }),               // fixed + resolved
      thread({ id: "human", author: "alice", lastAuthor: "alice" }), // not Copilot's thread at all
      thread({ id: "reopened", lastAuthor: "copilot" }),          // Copilot pushed back ⇒ ours again
    ],
  }), { anchorAt: NOW_ISO });
  assert.deepEqual(a.actionable.map((t) => t.id), ["open", "reopened"]);
  assert.equal(a.answered, 1);
  assert.equal(a.resolved, 1);
});

test("an OUTDATED thread is still ours to handle (moved code ≠ fixed concern)", () => {
  const a = analyzeCopilot(payload({ threads: [thread({ isOutdated: true })] }), { anchorAt: NOW_ISO });
  assert.equal(a.actionable.length, 1, "outdated must not silently excuse a finding");
  assert.equal(a.actionable[0].isOutdated, true, "…but the hint is carried through to the agent");
});

// ---------------------------------------------------------------------------
// evaluateCopilot — the state machine

const armed = (over: Partial<CopilotReviewState> = {}): CopilotReviewState => ({
  status: "AWAITING", pr: 7, armedAt: NOW_ISO, requestedAt: NOW_ISO, head: "abc123", rounds: 1, ...over,
});

test("no review yet ⇒ AWAITING (a persistent state, not a failure)", () => {
  const next = evaluateCopilot(armed(), analyzeCopilot(payload(), { anchorAt: NOW_ISO }), {
    nowIso: NOW_ISO, now: NOW, maxRounds: 3,
  });
  assert.equal(next.status, "AWAITING");
  assert.equal(isCopilotOutstanding(next), true);
});

test("threads waiting on us ⇒ OPEN with the count the agent must work off", () => {
  const next = evaluateCopilot(
    armed(),
    analyzeCopilot(payload({ threads: [thread({ id: "a" }), thread({ id: "b" })] }), { anchorAt: NOW_ISO }),
    { nowIso: NOW_ISO, now: NOW, maxRounds: 3 },
  );
  assert.equal(next.status, "OPEN");
  assert.equal(next.openThreads, 2);
});

test("every thread handled ⇒ SATISFIED, bound to the head it was verified against", () => {
  const next = evaluateCopilot(
    armed(),
    analyzeCopilot(payload({ threads: [thread({ isResolved: true }), thread({ id: "b", lastAuthor: "alice" })] }), { anchorAt: NOW_ISO }),
    { nowIso: NOW_ISO, now: NOW, maxRounds: 3 },
  );
  assert.equal(next.status, "SATISFIED");
  assert.equal(next.head, "abc123");
  assert.equal(isCopilotOutstanding(next), false);
  assert.deepEqual(copilotProblems(next), []);
});

test("the PR moving under us re-opens the cycle instead of accepting stale evidence", () => {
  // Fixing a Copilot finding means pushing, which changes the head. Accepting
  // the old review there would mark the NEW code reviewed without anyone
  // looking at it.
  const next = evaluateCopilot(
    armed(),
    analyzeCopilot(payload({ head: "newsha", threads: [] }), { anchorAt: NOW_ISO }),
    { nowIso: NOW_ISO, now: NOW, maxRounds: 3 },
  );
  assert.equal(next.status, "ARMED");
  assert.equal(next.requestedAt, undefined, "a new cycle needs a fresh request stamp");
  assert.match(next.note ?? "", /head moved/);
});

test("SAFETY VALVE: a Copilot that never answers releases the task instead of stranding it", () => {
  const next = evaluateCopilot(
    armed(),
    analyzeCopilot(payload(), { anchorAt: NOW_ISO }),
    { nowIso: NOW_ISO, now: NOW + COPILOT_AWAIT_TIMEOUT_MS + 1, maxRounds: 3 },
  );
  assert.equal(next.status, "EXHAUSTED");
  assert.match(next.note ?? "", /escalate to the user/);
  assert.deepEqual(copilotProblems(next), [], "a released requirement blocks nothing");
});

test("SAFETY VALVE: the round budget ends the loop with a human, not with more rounds", () => {
  const next = evaluateCopilot(
    armed({ rounds: 4 }),
    analyzeCopilot(payload({ threads: [thread()] }), { anchorAt: NOW_ISO }),
    { nowIso: NOW_ISO, now: NOW, maxRounds: 3 },
  );
  assert.equal(next.status, "EXHAUSTED");
  assert.match(next.note ?? "", /budget spent/);
});

test("the round budget is bounded by construction (a config typo cannot unbound it)", () => {
  assert.ok(COPILOT_MIN_ROUNDS >= 1);
  assert.ok(COPILOT_MAX_ROUNDS <= 10, "an upper bound must exist");
  assert.ok(COPILOT_MAX_ROUNDS_DEFAULT >= COPILOT_MIN_ROUNDS && COPILOT_MAX_ROUNDS_DEFAULT <= COPILOT_MAX_ROUNDS);
  assert.ok(COPILOT_AWAIT_TIMEOUT_MS <= 60 * 60 * 1000, "the wait must be bounded in wall time too");
});

// ---------------------------------------------------------------------------
// Arming — the loop part of the loop

test("ANY new PR ship re-opens the cycle, overriding every terminal status", () => {
  // The ordering hole this closes: `git push` on a branch with no PR resolves
  // to UNSUPPORTED, and if `gh pr create` could not re-arm from there, the
  // most common workflow would bypass the requirement entirely.
  for (const status of ["SATISFIED", "UNSUPPORTED", "EXHAUSTED", "OPEN", "AWAITING"] as const) {
    const next = armCopilotReview(armed({ status, rounds: 2 }), NOW_ISO);
    assert.equal(next.status, "ARMED", status);
    assert.equal(next.rounds, 2, "rounds are cumulative — re-arming must not hand out a fresh budget");
  }
  assert.equal(armCopilotReview(undefined, NOW_ISO).rounds, 0);
});

test("requesting a review spends a round and stamps time + head authoritatively", () => {
  const next = recordCopilotRequest(armCopilotReview(undefined, NOW_ISO), { pr: 9, head: "sha9", nowIso: NOW_ISO });
  assert.equal(next.status, "AWAITING");
  assert.equal(next.rounds, 1);
  assert.equal(next.requestedAt, NOW_ISO);
  assert.equal(next.head, "sha9");
  assert.equal(next.pr, 9);
});

test("the problem lines name the next concrete action for each open status", () => {
  assert.match(copilotProblems(armed({ status: "ARMED" }))[0], /request_copilot_review/);
  assert.match(copilotProblems(armed({ status: "AWAITING" }))[0], /check_copilot_review/);
  const open = copilotProblems(armed({ status: "OPEN", openThreads: 3 }))[0];
  assert.match(open, /3 Copilot review thread/);
  assert.match(open, /resolve them, or reply/);
  for (const status of ["SATISFIED", "UNSUPPORTED", "EXHAUSTED"] as const) {
    assert.deepEqual(copilotProblems(armed({ status })), []);
  }
  assert.deepEqual(copilotProblems(undefined), []);
});

test("releasing keeps the audit trail (why, when, against which head)", () => {
  const released = releaseCopilotReview(armed(), "UNSUPPORTED", "no gh on PATH", NOW_ISO);
  assert.equal(released.status, "UNSUPPORTED");
  assert.equal(released.note, "no gh on PATH");
  assert.equal(released.at, NOW_ISO);
  assert.equal(released.head, "abc123", "the previous head is kept when none is supplied");
});

// ---------------------------------------------------------------------------
// Sidecar validation — malformed input may only ever mean MORE work

test("a malformed cycle is repaired toward 'unfinished', never toward 'done'", () => {
  // A forged or corrupted sidecar must not be able to claim SATISFIED.
  assert.equal(sanitizeCopilotState({ status: "SATISFIED_LOL", pr: 3, armedAt: NOW_ISO, rounds: 1 })?.status, "ARMED");
  assert.equal(sanitizeCopilotState({ status: 42, rounds: -5 })?.status, "ARMED");
  assert.equal(sanitizeCopilotState({ status: "OPEN", rounds: -5 })?.rounds, 0);
  assert.equal(sanitizeCopilotState({ status: "OPEN", pr: "12" })?.pr, null);
  assert.equal(sanitizeCopilotState({ status: "OPEN", armedAt: 12 })?.armedAt, "");
  // A note is untrusted text from an earlier run: length-capped, never dropped.
  assert.equal(sanitizeCopilotState({ status: "OPEN", note: "x".repeat(9000) })?.note?.length, 500);
  // Nothing object-shaped ⇒ no cycle at all; the next PR ship arms a fresh one.
  for (const bad of [null, undefined, 7, "SATISFIED", []]) {
    assert.equal(sanitizeCopilotState(bad), undefined, String(bad));
  }
});

test("a sanitized SATISFIED payload keeps blocking nothing (round-trip stays honest)", () => {
  const clean = sanitizeCopilotState({
    status: "SATISFIED", pr: 4, armedAt: NOW_ISO, requestedAt: NOW_ISO, head: "sha", rounds: 2, openThreads: 0,
  });
  assert.equal(clean?.status, "SATISFIED");
  assert.equal(isCopilotOutstanding(clean), false);
});
