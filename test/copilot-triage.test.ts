import test from "node:test";
import assert from "node:assert/strict";

import {
  COPILOT_TRIAGE_ASK_FROM_ROUND,
  COPILOT_TRIAGE_MAX_RECORDS,
  DECLINE_CHOICE,
  FIX_CHOICE,
  IRRELEVANT_CHOICE,
  decisionFor,
  findingBody,
  findingChoiceSpec,
  findingKey,
  needsQuestion,
  recordDecision,
  sanitizeCopilotTriage,
  summarizeTriage,
  triageAskPlan,
  triageAsksUser,
  triagePickFrom,
  type CopilotTriageState,
} from "../lib/copilot-triage.ts";
import { DECLINE_ROW } from "../lib/choice-dialog.ts";
import type { CopilotThread } from "../lib/copilot-review.ts";

/**
 * The triage rules are pure, so they are tested as rules: no session, no
 * dialog, no `gh`. What matters here is the direction every ambiguous case
 * falls — a finding nobody decided must never come out as "fix".
 */

const AT = "2026-09-14T10:00:00.000Z";

function thread(over: Partial<CopilotThread> = {}): CopilotThread {
  return {
    id: "T1",
    isResolved: false,
    isOutdated: false,
    path: "lib/x.ts",
    line: 12,
    author: "copilot",
    lastAuthor: "copilot",
    createdAt: AT,
    excerpt: "the short form",
    body: "the short form",
    latestBody: "the short form",
    lastCommentId: "C1",
    ...over,
  };
}

// ---------- the round threshold ----------

test("the gate asks only from the threshold round on, and treats garbage as 'do not ask'", () => {
  assert.equal(COPILOT_TRIAGE_ASK_FROM_ROUND, 4);
  for (const rounds of [0, 1, 2, 3]) {
    assert.equal(triageAsksUser(rounds), false, `round ${rounds} keeps the old behaviour`);
  }
  for (const rounds of [4, 5, 99]) {
    assert.equal(triageAsksUser(rounds), true, `round ${rounds} asks`);
  }
  // An unreadable round count does NOT switch the feature on: rounds 1-3 are
  // the round where the agent fixes alone, and a broken counter is not
  // evidence that this conversation is old.
  assert.equal(triageAsksUser(Number.NaN), false);
});

// ---------- what identifies a question ----------

test("a finding is its thread AND its last comment — Copilot speaking again is a new question", () => {
  const first = thread();
  const again = thread({ lastCommentId: "C2" });
  const other = thread({ id: "T2" });
  assert.notEqual(findingKey(first), findingKey(again));
  assert.notEqual(findingKey(first), findingKey(other));
  // A payload without a last comment still keys stably, so the decision is
  // not lost on a GraphQL hiccup.
  assert.equal(findingKey(thread({ lastCommentId: null })), findingKey(thread({ lastCommentId: null })));
});

test("an answered finding is not asked again; a re-commented one is", () => {
  const decided = recordDecision(undefined, thread(), "fix", AT);
  assert.equal(needsQuestion(decided, thread()), false);
  assert.equal(needsQuestion(decided, thread({ lastCommentId: "C2" })), true);
  assert.equal(decisionFor(decided, thread())?.decision, "fix");
});

test("answering the same finding twice replaces the record instead of stacking one", () => {
  let triage = recordDecision(undefined, thread(), "fix", AT);
  triage = recordDecision(triage, thread(), "decline", AT, "  这条不适用  ");
  assert.equal(triage.records.length, 1);
  assert.deepEqual(triage.records[0], {
    threadId: "T1", commentId: "C1", decision: "decline", reason: "这条不适用", at: AT,
  });
});

test("the record list is capped: the oldest answers are the ones forgotten", () => {
  let triage: CopilotTriageState | undefined;
  for (let i = 0; i < COPILOT_TRIAGE_MAX_RECORDS + 5; i++) {
    triage = recordDecision(triage, thread({ id: `T${i}` }), "fix", AT);
  }
  assert.equal(triage?.records.length, COPILOT_TRIAGE_MAX_RECORDS);
  assert.equal(decisionFor(triage, thread({ id: "T0" })), undefined, "the oldest is gone (asked again, never guessed)");
  assert.equal(decisionFor(triage, thread({ id: `T${COPILOT_TRIAGE_MAX_RECORDS + 4}` }))?.decision, "fix");
});

// ---------- grouping ----------

test("the four groups partition the findings, in the order they arrived", () => {
  const threads = [
    thread({ id: "a" }), thread({ id: "b" }), thread({ id: "c" }), thread({ id: "d" }),
  ];
  let triage = recordDecision(undefined, threads[1]!, "decline", AT, "out of scope");
  triage = recordDecision(triage, threads[0]!, "fix", AT);
  triage = recordDecision(triage, threads[3]!, "irrelevant", AT);
  const groups = summarizeTriage(threads, triage);
  assert.deepEqual(groups.fix.map((e) => e.thread.id), ["a"]);
  assert.deepEqual(groups.decline.map((e) => e.thread.id), ["b"]);
  assert.deepEqual(groups.decline.map((e) => e.record?.reason), ["out of scope"]);
  assert.deepEqual(groups.irrelevant.map((e) => e.thread.id), ["d"]);
  assert.deepEqual(groups.unanswered.map((e) => e.thread.id), ["c"], "no record ⇒ nobody decided");
});

test("one call asks about EVERY pending finding — nothing is deferred", () => {
  const many = Array.from({ length: 13 }, (_, i) => thread({ id: `T${i}` }));
  const pending = triageAskPlan(many, undefined);
  assert.equal(pending.length, 13, "no cap slices the list any more");
  // Already-decided findings are skipped entirely: they are not asked about.
  const decided = recordDecision(undefined, many[0]!, "fix", AT);
  const second = triageAskPlan(many, decided);
  assert.equal(second[0]?.id, "T1");
  assert.equal(second.length, 12);
});

// ---------- reading the dialog's answer ----------

test("each option row maps to its decision, with or without the recommendation marker", () => {
  const spec = findingChoiceSpec(thread(), 0, 1);
  assert.deepEqual(triagePickFrom(FIX_CHOICE, spec), { kind: "decided", decision: "fix" });
  assert.deepEqual(triagePickFrom(`${FIX_CHOICE}（推荐）`, spec), { kind: "decided", decision: "fix" });
  assert.deepEqual(triagePickFrom(DECLINE_CHOICE, spec), { kind: "decided", decision: "decline" });
  assert.deepEqual(triagePickFrom(IRRELEVANT_CHOICE, spec), { kind: "decided", decision: "irrelevant" });
});

test("everything that is NOT one of the three answers is unanswered — never a fix", () => {
  const spec = findingChoiceSpec(thread(), 0, 1);
  // ESC / a dismissed box.
  assert.deepEqual(triagePickFrom(undefined, spec), { kind: "unanswered" });
  // The template's ✎ row, with and without a reason: they picked none of the
  // three, and what they typed is carried as words, not as consent.
  assert.deepEqual(triagePickFrom(DECLINE_ROW, spec), { kind: "unanswered" });
  assert.deepEqual(triagePickFrom(`${DECLINE_ROW}：这条我另有打算`, spec),
    { kind: "unanswered", reason: "这条我另有打算" });
  // A project manager answering with free text of its own.
  assert.deepEqual(triagePickFrom("fix it", spec), { kind: "unanswered", reason: "fix it" });
});

test("the one honoured escape from the ✎ box is `!chat`", () => {
  // (Everything else typed there lands in the neighbouring test: carried as
  // the user's words, never as consent.)
  const spec = findingChoiceSpec(thread(), 0, 3);
  assert.deepEqual(triagePickFrom(`${DECLINE_ROW}：!chat`, spec),
    { kind: "unanswered", reason: "（他想改在聊天里说）" });
});

// ---------- the question itself ----------

test("the question shows the progress, the location and the FULL comment", () => {
  const spec = findingChoiceSpec(thread(), 1, 3);
  assert.equal(spec.title, "Copilot 评审问题 2 / 3：lib/x.ts:12");
  assert.deepEqual(spec.options, [FIX_CHOICE, DECLINE_CHOICE, IRRELEVANT_CHOICE]);
  assert.equal(spec.recommended, FIX_CHOICE);
  const body = findingBody(thread({ body: "a much longer explanation than the excerpt", isOutdated: true }));
  assert.match(body, /文件：lib\/x\.ts:12/);
  assert.match(body, /a much longer explanation than the excerpt/);
  assert.match(body, /已移动/, "an outdated thread says so — the user is deciding on stale evidence otherwise");
  // A payload with no body at all still says something useful.
  assert.match(findingBody(thread({ body: "", latestBody: "" })), /the short form/);
});

test("a re-asked finding shows the NEW comment, not the one already answered", () => {
  const body = findingBody(thread({
    body: "the original complaint",
    latestBody: "still not fixed, second look",
  }));
  assert.match(body, /最新的一条评论/);
  assert.ok(body.indexOf("still not fixed") < body.indexOf("the original complaint"),
    "the comment that re-opened the question comes first");
  // One comment: the latest IS the first, so it is shown once, in the plain form.
  const single = findingBody(thread());
  assert.match(single, /Copilot 的评论：\nthe short form/);
  assert.doesNotMatch(single, /最新的一条评论/);
});

// ---------- sidecar validation ----------

test("a triage block is repaired by DROPPING what cannot be read — never by inventing a decision", () => {
  const good = recordDecision(undefined, thread(), "irrelevant", AT, "not our code");
  const roundTrip = sanitizeCopilotTriage(JSON.parse(JSON.stringify(good)));
  assert.deepEqual(roundTrip, good);
  // Garbage in, nothing out: every finding it named is asked again.
  assert.equal(sanitizeCopilotTriage(undefined), undefined);
  assert.equal(sanitizeCopilotTriage("nope"), undefined);
  assert.equal(sanitizeCopilotTriage({ records: [] }), undefined);
  assert.equal(sanitizeCopilotTriage({ records: [
    { threadId: "T1", decision: "maybe", commentId: "C1", at: AT },
    { decision: "fix", commentId: "C1", at: AT },
    null,
  ] }), undefined, "an unknown decision is not a decision");
});

test("a readable record survives with its reason, and an absurd one is clipped", () => {
  const state = sanitizeCopilotTriage({ at: AT, records: [
    { threadId: "T1", decision: "decline", reason: "  out of scope  ", at: AT },
    { threadId: "T2", decision: "fix", commentId: "C9", reason: "x".repeat(900), at: AT },
  ] });
  assert.equal(state?.records[0]?.reason, "out of scope");
  assert.equal(state?.records[0]?.commentId, "", "a missing comment id keys on the thread alone");
  assert.equal(state?.records[1]?.reason?.length, 500);
  assert.equal(state?.at, AT);
});
