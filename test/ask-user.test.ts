import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateQuestions,
  resumeFrom,
  buildNoDialogNotice,
  progressLabel,
  buildChoiceList,
  interpretChoice,
  resolveQuestion,
  formatAnswers,
  formatTranscriptSummary,
  needsUserReply,
  SKIP_REST_CHOICE,
  MAX_QUESTIONS,
  MAX_QUESTION_CHARS,
  type AskAnswer,
  type AskQuestion,
} from "../lib/ask-user.ts";
import { DECLINE_ROW, MAX_CHOICE_OPTIONS } from "../lib/choice-dialog.ts";

/** A question that follows the template — the shape every test starts from. */
function q(text: string, options: string[] = ["A", "B"], recommended = options[0] ?? ""): AskQuestion {
  return { text, options, recommended };
}

// ---- the template is a HARD requirement (user decision, 2026-09-08) ----

test("a batch that follows the template is accepted as written", () => {
  const result = validateQuestions([
    { text: "范围？", options: ["A", "B"], recommended: "A" },
    { text: "分支？", options: ["X", "Y", "Z"], recommended: "Y" },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.questions.length, 2);
  assert.deepEqual(result.questions[0]?.options, ["A", "B"]);
  assert.equal(result.questions[1]?.recommended, "Y");
  assert.equal(result.dropped, 0);
  assert.equal(result.trimmedOptions, 0);
});

test("a question with fewer than two options rejects the WHOLE batch", () => {
  const result = validateQuestions([
    { text: "好的问题？", options: ["A", "B"], recommended: "A" },
    { text: "坏问题？", options: ["只有一个"], recommended: "只有一个" },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /第 2 个问题/);
  assert.match(result.error, /2–4 个选项/);
});

test("a question without a recommendation rejects the whole batch", () => {
  const result = validateQuestions([{ text: "q", options: ["A", "B"] }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /recommended/);
});

test("a recommendation that is not one of the options rejects the whole batch", () => {
  const result = validateQuestions([{ text: "q", options: ["A", "B"], recommended: "C" }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /不在选项里/);
});

test("duplicate options reject the whole batch — a row must be unambiguous", () => {
  const result = validateQuestions([{ text: "q", options: ["A", "A"], recommended: "A" }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /重复选项/);
});

test("a question with no readable text rejects the batch", () => {
  const result = validateQuestions([{ text: "   " }]);
  assert.equal(result.ok, false);
});

test("an empty batch is refused with an actionable message", () => {
  for (const raw of [[], undefined, "not a list", null]) {
    const result = validateQuestions(raw);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.match(result.error, /没有提交任何问题/);
  }
});

test("sizes are CAPPED rather than refused, and the reply says what was cut", () => {
  const many = validateQuestions(Array.from({ length: 50 }, (_, i) =>
    ({ text: `q${i}`, options: ["A", "B"], recommended: "A" })));
  assert.equal(many.ok, true);
  if (!many.ok) return;
  assert.equal(many.questions.length, MAX_QUESTIONS);
  assert.equal(many.dropped, 50 - MAX_QUESTIONS);

  const wide = validateQuestions([{
    text: "q",
    options: Array.from({ length: 20 }, (_, i) => `o${i}`),
    recommended: "o0",
  }]);
  assert.equal(wide.ok, true);
  if (!wide.ok) return;
  assert.equal(wide.questions[0]?.options.length, MAX_CHOICE_OPTIONS);
  assert.equal(wide.trimmedOptions, 1);

  const long = validateQuestions([{ text: "x".repeat(MAX_QUESTION_CHARS + 500), options: ["A", "B"], recommended: "A" }]);
  assert.equal(long.ok, true);
  if (!long.ok) return;
  assert.equal(long.questions[0]?.text.length, MAX_QUESTION_CHARS);
});

test("blank options disappear — and a question left with one of them is refused", () => {
  const result = validateQuestions([{ text: "q", options: ["", "  ", "A"], recommended: "A" }]);
  assert.equal(result.ok, false, "one real option is not a question");
});

// ---- what the dialog shows ----

test("progress is 1-based", () => {
  assert.equal(progressLabel(0, 3), "1 / 3");
  assert.equal(progressLabel(2, 3), "3 / 3");
});

test("the row list is the template plus the interview's own escape", () => {
  const rows = buildChoiceList(q("q", ["A", "B"], "B"));
  assert.deepEqual(rows, ["A", "B（推荐）", DECLINE_ROW, SKIP_REST_CHOICE]);
});

// ---- what a picked line MEANS ----

test("picking an option returns the option the agent wrote, without the marker", () => {
  const question = q("q", ["A", "B"], "B");
  assert.deepEqual(interpretChoice("B（推荐）", question), { kind: "answered", answer: "B" });
  assert.deepEqual(interpretChoice("A", question), { kind: "answered", answer: "A" });
});

test("the interview's escape row is recognized", () => {
  assert.deepEqual(interpretChoice(SKIP_REST_CHOICE, q("q")), { kind: "skip-rest" });
});

test("the decline row carries the reason as the answer", () => {
  const question = q("q", ["A", "B"], "A");
  assert.deepEqual(
    interpretChoice(`${DECLINE_ROW}：两个都不合适，我要第三种`, question),
    { kind: "answered", answer: "不选，原因：两个都不合适，我要第三种" },
  );
  // An empty box is still an answer: "none of these, no reason given".
  assert.deepEqual(interpretChoice(DECLINE_ROW, question),
    { kind: "answered", answer: "不选（未说明原因）" });
});

test("the typed escapes work from the decline row's reason box", () => {
  const question = q("q");
  assert.deepEqual(interpretChoice(`${DECLINE_ROW}：!skip`, question), { kind: "skip-rest" });
  assert.deepEqual(interpretChoice(`${DECLINE_ROW}：!CHAT`, question), { kind: "deferred-to-chat" });
});

test("a dismissed dialog is neither an answer nor a skip", () => {
  // Treating ESC as consent is how a gate invents approvals.
  assert.deepEqual(interpretChoice(undefined, q("q")), { kind: "dismissed" });
});

// ---- what comes back ----

test("the answer sheet reports silence as silence", () => {
  const answers: AskAnswer[] = [
    { question: "范围？", kind: "answered", answer: "A" },
    { question: "分支？", kind: "deferred-to-chat" },
    { question: "交付？", kind: "skipped" },
  ];
  const text = formatAnswers(answers);
  assert.match(text, /1 \/ 3 范围？\n→ A/);
  assert.match(text, /2 \/ 3 分支？\n→ 用户选择在聊天里详细回答/);
  assert.match(text, /3 \/ 3 交付？\n→ 用户跳过/);
});

test("an empty interview says so instead of returning an empty string", () => {
  assert.equal(formatAnswers([]), "（没有问题）");
});

test("the summary counts each outcome", () => {
  const answers: AskAnswer[] = [
    { question: "a", kind: "answered", answer: "x" },
    { question: "b", kind: "skipped" },
    { question: "c", kind: "deferred-to-chat" },
  ];
  const summary = formatTranscriptSummary(answers);
  assert.match(summary, /已回答 1/);
  assert.match(summary, /转聊天 1/);
  assert.match(summary, /跳过 1/);
  assert.match(summary, /共 3 问/);
});

test("the transcript keeps the Q&A itself, not just the counts", () => {
  // User report 2026-08-29: the dialogs write nothing of their own, so counts
  // alone left the user unable to see what they had chosen.
  const summary = formatTranscriptSummary([
    { question: "本轮交付范围？\n（第二行是补充说明）", kind: "answered", answer: "全做：1+2+3+4" },
    { question: "申诉入口形态？", kind: "skipped" },
    { question: "配额存哪？", kind: "deferred-to-chat" },
    { question: "还有别的吗？", kind: "unanswered" },
  ]);
  assert.match(summary, /1 \/ 4 本轮交付范围？ → 全做：1\+2\+3\+4/, "question and chosen answer, one line");
  assert.doesNotMatch(summary, /第二行是补充说明/, "only the question's first line is kept");
  assert.match(summary, /2 \/ 4 申诉入口形态？ → （跳过）/);
  assert.match(summary, /3 \/ 4 配额存哪？ → （转聊天回答）/);
  assert.match(summary, /4 \/ 4 还有别的吗？ → （未作答）/);
});

test("a long question or answer is capped, never wrapped over several lines", () => {
  const summary = formatTranscriptSummary([
    { question: "q".repeat(200), kind: "answered", answer: "a".repeat(200) },
  ]);
  const lines = summary.split("\n");
  assert.equal(lines.length, 2, "one header line plus one line per question");
  assert.match(lines[1], /…/, "the overflow is elided");
  assert.ok(lines[1].length < 200, `the line stays short (${lines[1].length} chars)`);
});

test("the loop waits whenever anything went unanswered", () => {
  assert.equal(needsUserReply([{ question: "a", kind: "answered", answer: "x" }]), false);
  assert.equal(needsUserReply([{ question: "a", kind: "skipped" }]), true);
  assert.equal(needsUserReply([{ question: "a", kind: "deferred-to-chat" }]), true);
  assert.equal(needsUserReply([]), false);
});

// ---- an interrupted interview resumes instead of restarting ----

const QS = [q("范围？"), q("分支？"), q("交付？")];

test("settled answers carry over; the first unsettled question is where it resumes", () => {
  const stored = {
    at: "t",
    answers: [
      { question: "范围？", kind: "answered" as const, answer: "A" },
      { question: "分支？", kind: "unanswered" as const },
    ],
  };
  const carried = resumeFrom(stored, QS);
  assert.equal(carried.length, 1, "only the settled prefix carries over");
  assert.equal(carried[0].answer, "A");
});

test("a different question list is a different interview — nothing carries over", () => {
  const stored = { at: "t", answers: [{ question: "别的问题", kind: "answered" as const, answer: "A" }] };
  assert.deepEqual(resumeFrom(stored, QS), []);
});

test("no stored progress means a fresh interview", () => {
  assert.deepEqual(resumeFrom(undefined, QS), []);
  assert.deepEqual(resumeFrom({ at: "t", answers: [] }, QS), []);
});

test("a skip is settled too — it does not re-ask", () => {
  const stored = {
    at: "t",
    answers: [
      { question: "范围？", kind: "answered" as const, answer: "A" },
      { question: "分支？", kind: "skipped" as const },
    ],
  };
  assert.equal(resumeFrom(stored, QS).length, 2);
});

// ---- an environment with no dialogs must say so ----

test("the no-dialog notice hands the questions back to the agent, in full", () => {
  const notice = buildNoDialogNotice([q("范围？", ["A", "B"], "A")]);
  assert.match(notice, /没能展示给用户/);
  assert.match(notice, /写进你的回复/);
  assert.match(notice, /范围？/);
  assert.match(notice, /选项：A（推荐） \/ B \/ ✎ 不选，我说明原因 \/ ⏭ 跳过后续问题/);
});

test("an unanswered question reads as unanswered, never as 'ask me in chat'", () => {
  const text = formatAnswers([{ question: "范围？", kind: "unanswered" }]);
  assert.match(text, /没有得到回答/);
  assert.doesNotMatch(text, /选择在聊天里/);
  assert.match(formatTranscriptSummary([{ question: "q", kind: "unanswered" }]), /未作答 1/);
});

test("an unanswered question keeps the loop waiting", () => {
  assert.equal(needsUserReply([{ question: "a", kind: "unanswered" }]), true);
});


// ---------- what one settled question MEANS (the batch rule) ----------

const PICK = q("选一个", ["A", "B"], "A");

test("an answer the race delivered is honoured, whatever stopped the rest", () => {
  // The one case batching created: the project manager answered this question
  // through the channel before the user pressed "skip the rest" on an earlier
  // one. 先答者生效 — the stop reason interprets SILENCE, never an answer.
  assert.deepEqual(resolveQuestion(PICK, "B", { stopped: "skip-rest" }),
    { answer: { question: "选一个", kind: "answered", answer: "B" } });
  assert.deepEqual(resolveQuestion(PICK, "B", { stopped: "interrupted" }),
    { answer: { question: "选一个", kind: "answered", answer: "B" } });
  // The recommendation marker is stripped: the agent gets the option it wrote.
  assert.equal(resolveQuestion(PICK, "A（推荐）").answer.answer, "A");
});

test("only SILENCE is interpreted by what stopped the interview", () => {
  // Skipped: the user chose to stop, so the questions they never saw are
  // reported as skipped…
  assert.deepEqual(resolveQuestion(PICK, undefined, { stopped: "skip-rest" }),
    { answer: { question: "选一个", kind: "skipped" } });
  // …but an instruct that took the box away is nobody deciding anything, and
  // the reply must not claim the user did.
  assert.deepEqual(resolveQuestion(PICK, undefined, { stopped: "interrupted" }),
    { answer: { question: "选一个", kind: "unanswered" } });
  assert.deepEqual(resolveQuestion(PICK, undefined),
    { answer: { question: "选一个", kind: "unanswered" } });
});

test("a question can STOP the interview, and says which way", () => {
  const skipped = resolveQuestion(PICK, SKIP_REST_CHOICE);
  assert.equal(skipped.stop, "skip-rest");
  assert.equal(skipped.answer.kind, "skipped");
  const interrupted = resolveQuestion(PICK, undefined, { interrupted: true });
  assert.equal(interrupted.stop, "interrupted");
  assert.equal(interrupted.answer.kind, "unanswered");
  // An ordinary answer stops nothing.
  assert.equal(resolveQuestion(PICK, "A").stop, undefined);
  assert.equal(resolveQuestion(PICK, `${DECLINE_ROW}：!chat`).answer.kind, "deferred-to-chat");
  assert.equal(resolveQuestion(PICK, `${DECLINE_ROW}：!skip`).stop, "skip-rest");
});
