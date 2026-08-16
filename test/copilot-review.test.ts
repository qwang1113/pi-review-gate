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
  COPILOT_HISTORY_PR_COUNT,
  COPILOT_REVIEWER_LOGIN,
  COPILOT_THREADS_QUERY,
  analyzeCopilot,
  armCopilotReview,
  copilotProblems,
  evaluateCopilot,
  isCopilotAuthor,
  isCopilotOutstanding,
  isUnknownJsonFieldError,
  PR_VIEW_JSON_FIELDS,
  parseCopilotHistoryProbe as historyProbe,
  parseCopilotPayload,
  decideCopilotSupport,
  decidePrView,
  isCopilotOwnerAllowed,
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

test("REGRESSION: legacy gh without headRefOid still resolves a PR (timestamp-anchored fallback)", () => {
  // gh 2.4.0 (measured) rejects `--json number,headRefOid,url,state` with
  // `Unknown JSON field: "headRefOid"` — resolveOpenPr retries with the
  // legacy field set, and parsePrView must yield a usable PrSummary whose
  // head is null (analyzeCopilot then anchors proof on timestamps).
  assert.equal(
    isUnknownJsonFieldError('Unknown JSON field: "headRefOid"'),
    true,
  );
  assert.equal(
    isUnknownJsonFieldError("no pull requests found for branch \"main\""),
    false,
  );
  assert.equal(isUnknownJsonFieldError(""), false);
  assert.deepEqual(
    parsePrView('{"number":12,"url":"https://github.com/o/r/pull/12","state":"OPEN"}'),
    { number: 12, head: null, url: "https://github.com/o/r/pull/12", state: "OPEN" },
  );
  // The legacy list must not name a field legacy gh rejects.
  assert.ok(PR_VIEW_JSON_FIELDS.legacy.includes("number"));
  assert.ok(!PR_VIEW_JSON_FIELDS.legacy.includes("headRefOid"));
  assert.ok(PR_VIEW_JSON_FIELDS.modern.includes("headRefOid"));
});

test("decidePrView: every version-drift branch is behavior-locked (P1: modern→legacy + error choice)", () => {
  const modernOk = {
    ok: true,
    stdout: '{"number":12,"headRefOid":"deadbeef","url":"https://github.com/o/r/pull/12","state":"OPEN"}',
    stderr: "",
  };
  const legacyFieldError = {
    ok: false,
    stdout: "",
    stderr: 'Unknown JSON field: "headRefOid"',
  };
  const legacyOk = {
    ok: true,
    stdout: '{"number":12,"url":"https://github.com/o/r/pull/12","state":"OPEN"}',
    stderr: "",
  };
  const noPr = { ok: false, stdout: "", stderr: 'no pull requests found for branch "main"' };

  // modern ok → its payload wins.
  assert.deepEqual(decidePrView(modernOk, undefined), { ok: true, pr: { number: 12, head: "deadbeef", url: "https://github.com/o/r/pull/12", state: "OPEN" } });
  // modern ok but unparseable → its own error, no legacy call needed.
  assert.deepEqual(decidePrView({ ok: true, stdout: "nope", stderr: "" }, undefined), {
    ok: false,
    error: "`gh pr view` returned no recognizable pull request",
  });
  // modern failed for a REAL reason (no PR) → no retry, real cause reported.
  assert.deepEqual(decidePrView(noPr, legacyOk), { ok: false, error: 'no pull requests found for branch "main"' });
  // modern field-whitelist error + legacy ok → legacy payload wins (head null).
  assert.deepEqual(decidePrView(legacyFieldError, legacyOk), { ok: true, pr: { number: 12, head: null, url: "https://github.com/o/r/pull/12", state: "OPEN" } });
  // modern field-whitelist error + legacy ALSO failed → THE LEGACY error wins
  // (the whitelist error would mask the real cause).
  assert.deepEqual(decidePrView(legacyFieldError, noPr), { ok: false, error: 'no pull requests found for branch "main"' });
  // modern field-whitelist error, legacy undefined (caller skipped the retry)
  // → falls back to the modern error text.
  assert.deepEqual(decidePrView(legacyFieldError, undefined), { ok: false, error: 'Unknown JSON field: "headRefOid"' });
  // empty stderr → the caller's fallback text.
  assert.deepEqual(decidePrView({ ok: false, stdout: "", stderr: "" }, undefined), {
    ok: false,
    error: "`gh pr view` failed (gh missing, not authenticated, or no PR)",
  });
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
    nowIso: NOW_ISO, now: NOW,
  });
  assert.equal(next.status, "AWAITING");
  assert.equal(isCopilotOutstanding(next), true);
});

test("threads waiting on us ⇒ OPEN with the count the agent must work off", () => {
  const next = evaluateCopilot(
    armed(),
    analyzeCopilot(payload({ threads: [thread({ id: "a" }), thread({ id: "b" })] }), { anchorAt: NOW_ISO }),
    { nowIso: NOW_ISO, now: NOW },
  );
  assert.equal(next.status, "OPEN");
  assert.equal(next.openThreads, 2);
});

test("every thread handled ⇒ SATISFIED, bound to the head it was verified against", () => {
  const next = evaluateCopilot(
    armed(),
    analyzeCopilot(payload({ threads: [thread({ isResolved: true }), thread({ id: "b", lastAuthor: "alice" })] }), { anchorAt: NOW_ISO }),
    { nowIso: NOW_ISO, now: NOW },
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
    { nowIso: NOW_ISO, now: NOW },
  );
  assert.equal(next.status, "ARMED");
  assert.equal(next.requestedAt, undefined, "a new cycle needs a fresh request stamp");
  assert.match(next.note ?? "", /head moved/);
});

test("REGRESSION: a push must not bury Copilot findings that are still waiting on us", () => {
  // The reported bug, reproduced from a real PR. Copilot reviewed commit A and
  // left an unanswered thread; the fix was pushed, so the head became B and
  // `reviewed` went false for the new cycle. The old state machine asked
  // "reviewed?" before "anything waiting on us?", so it reported AWAITING /
  // ARMED and the finding stopped being counted — then the wait budget expired
  // and the task was released with the comment never handled. GitHub does not
  // re-review a new head by default, so that thread was the ONLY feedback
  // there was.
  const stalePush = analyzeCopilot(
    payload({
      head: "newsha",
      reviews: [{ author: "Copilot", submittedAt: "2026-08-07T09:00:00Z", commit: "abc123", state: "COMMENTED" }],
      threads: [thread({ id: "unanswered", createdAt: "2026-08-07T09:00:00Z" })],
    }),
    { anchorAt: NOW_ISO },
  );
  assert.equal(stalePush.reviewed, false, "nothing has reviewed the new head — that part was right");
  assert.equal(stalePush.actionable.length, 1, "but the old finding is still ours");

  const next = evaluateCopilot(armed(), stalePush, { nowIso: NOW_ISO, now: NOW });
  assert.equal(next.status, "OPEN", "the finding outranks both the head drift and the wait");
  assert.equal(next.openThreads, 1);
  assert.equal(copilotProblems(next).length, 1, "and completion stays blocked until it is handled");

  // Even a wait budget that has fully expired cannot release it.
  const expired = evaluateCopilot(armed(), stalePush, {
    nowIso: NOW_ISO,
    now: NOW + COPILOT_AWAIT_TIMEOUT_MS + 1,
  });
  assert.equal(expired.status, "OPEN");

  // Once it IS handled, the head drift takes over and a fresh review is due.
  const handled = analyzeCopilot(
    payload({
      head: "newsha",
      reviews: [{ author: "Copilot", submittedAt: "2026-08-07T09:00:00Z", commit: "abc123", state: "COMMENTED" }],
      threads: [thread({ id: "unanswered", lastAuthor: "alice", createdAt: "2026-08-07T09:00:00Z" })],
    }),
    { anchorAt: NOW_ISO },
  );
  assert.equal(
    evaluateCopilot(armed(), handled, { nowIso: NOW_ISO, now: NOW }).status,
    "ARMED",
  );
});

test("REGRESSION: an unhandled finding also outranks a SATISFIED verdict from an earlier cycle", () => {
  // SATISFIED short-circuits before anything else is examined. If Copilot
  // comments again on the same head after we were declared done, that comment
  // must reopen the cycle rather than land behind a closed decision.
  const next = evaluateCopilot(
    armed({ status: "SATISFIED", head: "abc123", openThreads: 0 }),
    analyzeCopilot(payload({ threads: [thread()] }), { anchorAt: NOW_ISO }),
    { nowIso: NOW_ISO, now: NOW },
  );
  assert.equal(next.status, "OPEN");
  assert.equal(next.openThreads, 1);
});

test("a repo with no sign of Copilot is released at once instead of waiting out the budget", () => {
  // The user's rule: if it cannot do this, do not spend my time finding out.
  // UNKNOWN means no Copilot review has ever appeared here AND the owner is
  // not on the allow-list.
  const next = evaluateCopilot(
    armed(),
    analyzeCopilot(payload(), { anchorAt: NOW_ISO }),
    { nowIso: NOW_ISO, now: NOW, support: "UNKNOWN" },
  );
  assert.equal(next.status, "UNSUPPORTED");
  assert.match(next.note ?? "", /allow-list/, "and it says what would change the answer");
  assert.deepEqual(copilotProblems(next), [], "released requirements block nothing");

  // Evidence or policy ⇒ the normal wait applies instead.
  for (const support of ["CONFIRMED", "ASSUMED"] as const) {
    assert.equal(
      evaluateCopilot(armed(), analyzeCopilot(payload(), { anchorAt: NOW_ISO }), {
        nowIso: NOW_ISO, now: NOW, support,
      }).status,
      "AWAITING",
      support,
    );
  }
  // A caller that supplies nothing keeps the old waiting behaviour.
  assert.equal(
    evaluateCopilot(armed(), analyzeCopilot(payload(), { anchorAt: NOW_ISO }), {
      nowIso: NOW_ISO, now: NOW,
    }).status,
    "AWAITING",
  );
});

test("UNKNOWN availability never overrides findings that are already on the table", () => {
  // "Unsupported" is about the future (no review will come), never about
  // comments that already exist and are waiting on us.
  const next = evaluateCopilot(
    armed(),
    analyzeCopilot(payload({ threads: [thread()] }), { anchorAt: NOW_ISO }),
    { nowIso: NOW_ISO, now: NOW, support: "UNKNOWN" },
  );
  assert.equal(next.status, "OPEN");
});

test("SAFETY VALVE: a Copilot that never answers releases the task instead of stranding it", () => {
  const next = evaluateCopilot(
    armed(),
    analyzeCopilot(payload(), { anchorAt: NOW_ISO }),
    { nowIso: NOW_ISO, now: NOW + COPILOT_AWAIT_TIMEOUT_MS + 1 },
  );
  assert.equal(next.status, "EXHAUSTED");
  assert.match(next.note ?? "", /escalate to the user/);
  assert.deepEqual(copilotProblems(next), [], "a released requirement blocks nothing");
});

test("there is NO round cap: a long review conversation is not a reason to stop", () => {
  // Deleted on the user's instruction, and it was a real third way to finish
  // with Copilot's comments unhandled: on round 4 the requirement released
  // itself, whatever was still open. Unlike a wait, another round costs only
  // the agent's own work — so nothing about "round N" justifies walking away.
  for (const rounds of [4, 25, 500]) {
    const idle = evaluateCopilot(
      armed({ rounds }),
      analyzeCopilot(payload(), { anchorAt: NOW_ISO }),
      { nowIso: NOW_ISO, now: NOW },
    );
    assert.equal(idle.status, "AWAITING", `round ${rounds} must still just wait`);

    const open = evaluateCopilot(
      armed({ rounds }),
      analyzeCopilot(payload({ threads: [thread()] }), { anchorAt: NOW_ISO }),
      { nowIso: NOW_ISO, now: NOW },
    );
    assert.equal(open.status, "OPEN", `round ${rounds} must still demand the fix`);
    assert.equal(copilotProblems(open).length, 1, "and completion stays blocked");

    const moved = evaluateCopilot(
      armed({ rounds }),
      analyzeCopilot(payload({ head: "newsha" }), { anchorAt: NOW_ISO }),
      { nowIso: NOW_ISO, now: NOW },
    );
    assert.equal(moved.status, "ARMED", `round ${rounds} must still re-arm on a push`);
  }

  // The ONLY budget left is the wait, and it fires only when Copilot said
  // nothing at all — it cannot drop feedback, because there is none.
  const silent = evaluateCopilot(
    armed({ rounds: 99 }),
    analyzeCopilot(payload(), { anchorAt: NOW_ISO }),
    { nowIso: NOW_ISO, now: NOW + COPILOT_AWAIT_TIMEOUT_MS + 1 },
  );
  assert.equal(silent.status, "EXHAUSTED");
});

// ---------------------------------------------------------------------------
// Terminal statuses are DECISIONS, not snapshots.

test("a released cycle is never resurrected by the next check", () => {
  // Observed for real: request_copilot_review released the cycle as EXHAUSTED,
  // the very next check_copilot_review re-classified it as ARMED, and
  // declare_done was blocked by a requirement the gate had already let go.
  for (const status of ["EXHAUSTED", "UNSUPPORTED"] as const) {
    const released = armed({ status, rounds: 3, note: "released earlier" });
    for (const [label, analysis] of [
      ["no review at all", analyzeCopilot(payload(), { anchorAt: NOW_ISO })],
      ["threads waiting on us", analyzeCopilot(payload({ threads: [thread()] }), { anchorAt: NOW_ISO })],
      ["head moved", analyzeCopilot(payload({ head: "deadbeef" }), { anchorAt: NOW_ISO })],
    ] as const) {
      const next = evaluateCopilot(released, analysis, {
        nowIso: "2026-08-07T12:00:00.000Z",
        now: NOW + COPILOT_AWAIT_TIMEOUT_MS + 1,
      });
      assert.deepEqual(next, released, `${status} must survive untouched (${label})`);
      assert.deepEqual(copilotProblems(next), [], "and must keep blocking nothing");
    }
  }
});

test("SATISFIED survives a re-check, but not code moving under it", () => {
  const satisfied = armed({ status: "SATISFIED", head: "abc123", openThreads: 0 });
  const sameCode = evaluateCopilot(
    satisfied,
    analyzeCopilot(payload({ threads: [thread({ isResolved: true })] }), { anchorAt: NOW_ISO }),
    { nowIso: "2026-08-07T12:00:00.000Z", now: NOW },
  );
  assert.deepEqual(sameCode, satisfied, "re-checking the same head must not rewrite the decision");

  // The one exception that keeps its safety net: the review no longer
  // describes the code, so the cycle re-opens.
  const moved = evaluateCopilot(
    satisfied,
    analyzeCopilot(payload({ head: "deadbeef" }), { anchorAt: NOW_ISO }),
    { nowIso: "2026-08-07T12:00:00.000Z", now: NOW },
  );
  assert.equal(moved.status, "ARMED");
  assert.match(moved.note ?? "", /head moved/);
});

test("a new PR ship is still the way a released cycle re-opens", () => {
  // The terminal short-circuit must not close the loop off entirely: arming is
  // a different entry point and keeps overriding every terminal status.
  for (const status of ["EXHAUSTED", "UNSUPPORTED", "SATISFIED"] as const) {
    const rearmed = armCopilotReview(armed({ status, rounds: 2 }), NOW_ISO);
    assert.equal(rearmed.status, "ARMED", status);
    assert.equal(rearmed.rounds, 2, "and the spent budget is carried over, not refunded");
  }
});

test("the only remaining budget is the wait, and it is bounded in wall time", () => {
  assert.ok(COPILOT_AWAIT_TIMEOUT_MS > 0);
  assert.ok(COPILOT_AWAIT_TIMEOUT_MS <= 60 * 60 * 1000, "the wait must be bounded in wall time");
  // The history probe has to look back far enough to be useful and stay one
  // cheap query (measured: 7 of the last 20 PRs on a repo that uses Copilot).
  assert.ok(COPILOT_HISTORY_PR_COUNT >= 10 && COPILOT_HISTORY_PR_COUNT <= 100);
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

// ---------------------------------------------------------------------------
// "Is Copilot even available here?" — the evidence-based availability probe.
//
// Measured facts this section encodes (see lib/copilot-review.ts):
//   * `suggestedActors(CAN_BE_ASSIGNED)` answers a DIFFERENT question and
//     returned no Copilot on a repo Copilot demonstrably reviews — that probe
//     is gone;
//   * a silently dropped request still exits 0 / answers 200 and leaves every
//     `reviewRequests` surface empty — those read-backs are gone too;
//   * a past Copilot review is direct evidence of the exact capability.

const historyPayload = (prs: string[][]) => JSON.stringify({
  data: {
    repository: {
      pullRequests: {
        nodes: prs.map((logins) => ({
          reviews: { nodes: logins.map((login) => ({ author: { login } })) },
        })),
      },
    },
  },
});

test("the history probe finds Copilot under any of its logins, and says so plainly when absent", () => {
  assert.equal(historyProbe(historyPayload([["alice"], ["Copilot"]])), true);
  assert.equal(historyProbe(historyPayload([["copilot-pull-request-reviewer[bot]"]])), true);
  assert.equal(historyProbe(historyPayload([["alice", "bob"], []])), false);
  assert.equal(historyProbe(historyPayload([])), false, "a repo with no PRs has no evidence");
  assert.equal(historyProbe(historyPayload([["copilot-swe-agent"]])), false,
    "the coding agent is not the review bot");
});

test("an unreadable history answer is 'cannot tell', never 'Copilot is missing'", () => {
  // Each of these used to be indistinguishable from a real "no Copilot"
  // answer; treating them as such would decide availability on a hiccup.
  for (const bad of [
    "",
    "not json",
    "{}",
    JSON.stringify({ data: { repository: null } }),
    JSON.stringify({ data: { repository: { pullRequests: {} } } }),
    JSON.stringify({ errors: [{ message: "Bad credentials" }] }),
  ]) {
    assert.equal(historyProbe(bad), undefined, JSON.stringify(bad));
  }
});

test("the owner allow-list is case-insensitive and only ever matches the owner half", () => {
  assert.equal(isCopilotOwnerAllowed("OneKeyHQ/server-service-rebate", ["onekeyhq"]), true);
  assert.equal(isCopilotOwnerAllowed("onekeyhq/x", ["OneKeyHQ"]), true);
  assert.equal(isCopilotOwnerAllowed("someone/onekeyhq", ["onekeyhq"]), false,
    "a repo NAMED like the org is not owned by it");
  assert.equal(isCopilotOwnerAllowed("qwang1113/pi-review-gate", ["onekeyhq"]), false);
  assert.equal(isCopilotOwnerAllowed(null, ["onekeyhq"]), false);
  assert.equal(isCopilotOwnerAllowed("onekeyhq/x", []), false);
});

test("availability: evidence outranks policy, policy outranks silence", () => {
  const owners = ["onekeyhq"];
  // A Copilot review on THIS PR is the cheapest and strongest evidence.
  assert.equal(decideCopilotSupport({ onPr: true, slug: "nobody/x", owners }), "CONFIRMED");
  // Sticky evidence from an earlier cycle counts without re-querying.
  assert.equal(decideCopilotSupport({ remembered: true, slug: "nobody/x", owners }), "CONFIRMED");
  assert.equal(decideCopilotSupport({ history: true, slug: "nobody/x", owners }), "CONFIRMED");
  // No evidence, but the owner is covered by policy.
  assert.equal(decideCopilotSupport({ history: false, slug: "OneKeyHQ/x", owners }), "ASSUMED");
  // Neither.
  assert.equal(decideCopilotSupport({ history: false, slug: "nobody/x", owners }), "UNKNOWN");
  // An UNREADABLE probe must not demote a repo policy already covers: that is
  // the difference between "no evidence" and "evidence of absence".
  assert.equal(decideCopilotSupport({ history: undefined, slug: "OneKeyHQ/x", owners }), "ASSUMED");
  assert.equal(decideCopilotSupport({ history: undefined, slug: "nobody/x", owners }), "UNKNOWN");
  // Nothing supplied at all is the honest worst case, not an optimistic one.
  assert.equal(decideCopilotSupport({}), "UNKNOWN");
});

// ---------------------------------------------------------------------------
// The wait budget belongs to the CYCLE, not to the latest request.

test("re-requesting cannot buy more waiting time (the budget anchors on the first request)", () => {
  // The failure this prevents, observed for real: three request_copilot_review
  // calls in a row each refreshed `requestedAt`, so the 20-minute safety valve
  // kept being pushed out and the task sat in AWAITING indefinitely.
  const first = "2026-08-07T10:00:00.000Z";
  let state = recordCopilotRequest(undefined, { pr: 7, head: "abc123", nowIso: first });
  for (const at of ["2026-08-07T10:05:00.000Z", "2026-08-07T10:12:00.000Z"]) {
    state = recordCopilotRequest(state, { pr: 7, head: "abc123", nowIso: at });
  }
  assert.equal(state.firstRequestedAt, first, "the anchor survives every re-request");
  assert.equal(state.requestedAt, "2026-08-07T10:12:00.000Z", "the latest stamp is still recorded");
  assert.equal(state.rounds, 3);

  const justPastTheBudget = Date.parse(first) + COPILOT_AWAIT_TIMEOUT_MS + 1;
  const next = evaluateCopilot(
    state,
    analyzeCopilot(payload(), { anchorAt: first }),
    { nowIso: NOW_ISO, now: justPastTheBudget },
  );
  assert.equal(next.status, "EXHAUSTED", "20 minutes after the FIRST request, the valve opens");
  assert.match(next.note ?? "", /escalate to the user/);
});

test("a cycle re-armed by a new PR ship starts a fresh wait budget", () => {
  const state = recordCopilotRequest(undefined, { pr: 7, head: "abc123", nowIso: NOW_ISO });
  const rearmed = armCopilotReview(state, "2026-08-07T11:00:00.000Z");
  assert.equal(rearmed.firstRequestedAt, undefined, "a new cycle must not inherit the old anchor");
  assert.equal(rearmed.requestedAt, undefined);
  assert.equal(rearmed.rounds, 1, "but the round COUNT stays cumulative (no cap, just bookkeeping)");
});

test("a sidecar written before the anchor existed still ages out on its last request", () => {
  // Backward compatibility: no firstRequestedAt ⇒ fall back to requestedAt,
  // which is exactly the old behavior rather than "never expires".
  const legacy = sanitizeCopilotState({
    status: "AWAITING", pr: 7, armedAt: NOW_ISO, requestedAt: NOW_ISO, head: "abc123", rounds: 1,
  })!;
  assert.equal(legacy.firstRequestedAt, undefined);
  const next = evaluateCopilot(
    legacy,
    analyzeCopilot(payload(), { anchorAt: NOW_ISO }),
    { nowIso: NOW_ISO, now: NOW + COPILOT_AWAIT_TIMEOUT_MS + 1 },
  );
  assert.equal(next.status, "EXHAUSTED");
  // And a sidecar that HAS the anchor keeps it through sanitization.
  const modern = sanitizeCopilotState({
    status: "AWAITING", pr: 7, armedAt: NOW_ISO, requestedAt: NOW_ISO,
    firstRequestedAt: "2026-08-07T09:00:00.000Z", rounds: 2,
  });
  assert.equal(modern?.firstRequestedAt, "2026-08-07T09:00:00.000Z");
  assert.equal(sanitizeCopilotState({ status: "AWAITING", firstRequestedAt: 42 })?.firstRequestedAt, undefined);
});
