import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateQuestions,
  resumeFrom,
  buildNoDialogNotice,
  progressLabel,
  interpretChoice,
  questionRows,
  resolveQuestion,
  stepInterview,
  formatAnswers,
  formatTranscriptSummary,
  needsUserReply,
  MAX_QUESTION_CHARS,
  MULTI_NONE_ANSWER,
  type AskAnswer,
  type AskQuestion,
} from "../lib/ask-user.ts";
import { BACK_ROW, DECLINE_ROW, MAX_CHOICE_OPTIONS } from "../lib/choice-dialog.ts";

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

test("sizes are CAPPED rather than refused — and the NUMBER of questions is not capped at all", () => {
  // The 10-question cap is gone (user decision, 2026-09-17): it dropped the
  // tail of a long batch, and an agent told the rest would come "next round"
  // usually never asked again. Every question goes up now.
  const many = validateQuestions(Array.from({ length: 50 }, (_, i) =>
    ({ text: `q${i}`, options: ["A", "B"], recommended: "A" })));
  assert.equal(many.ok, true);
  if (!many.ok) return;
  assert.equal(many.questions.length, 50, "no question is dropped");

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

// ---- what a picked line MEANS ----

test("picking a row answers with the option AND the letter — the record matches the screen", () => {
  const question = q("q", ["继续", "停止"], "停止");
  assert.deepEqual(interpretChoice("B. 停止（推荐）", question),
    { kind: "answered", answer: "B. 停止", option: "停止" });
  assert.deepEqual(interpretChoice("A. 继续", question),
    { kind: "answered", answer: "A. 继续", option: "继续" });
  // …and the short forms a user or a project manager reads off the screen.
  assert.deepEqual(interpretChoice("B", question),
    { kind: "answered", answer: "B. 停止", option: "停止" });
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

test("the one typed escape works from the decline row's reason box", () => {
  // Anything else typed there is the reason itself: there is no second escape
  // to remember (user decision, 2026-09-17).
  assert.deepEqual(interpretChoice(`${DECLINE_ROW}：!CHAT`, q("q")), { kind: "deferred-to-chat" });
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
    { question: "交付？", kind: "unanswered" },
  ];
  const text = formatAnswers(answers);
  assert.match(text, /1 \/ 3 范围？\n→ A/);
  assert.match(text, /2 \/ 3 分支？\n→ 用户选择在聊天里详细回答/);
  assert.match(text, /3 \/ 3 交付？\n→ 没有得到回答/);
});

test("an empty interview says so instead of returning an empty string", () => {
  assert.equal(formatAnswers([]), "（没有问题）");
});

test("the summary counts each outcome", () => {
  const answers: AskAnswer[] = [
    { question: "a", kind: "answered", answer: "x" },
    { question: "b", kind: "unanswered" },
    { question: "c", kind: "deferred-to-chat" },
  ];
  const summary = formatTranscriptSummary(answers);
  assert.match(summary, /已回答 1/);
  assert.match(summary, /转聊天 1/);
  assert.match(summary, /未作答 1/);
  assert.match(summary, /共 3 问/);
});

test("the transcript keeps the Q&A itself, not just the counts", () => {
  // User report 2026-08-29: the dialogs write nothing of their own, so counts
  // alone left the user unable to see what they had chosen.
  const summary = formatTranscriptSummary([
    { question: "本轮交付范围？\n（第二行是补充说明）", kind: "answered", answer: "全做：1+2+3+4" },
    { question: "申诉入口形态？", kind: "unanswered" },
    { question: "配额存哪？", kind: "deferred-to-chat" },
    { question: "还有别的吗？", kind: "unanswered" },
  ]);
  assert.match(summary, /1 \/ 4 本轮交付范围？ → 全做：1\+2\+3\+4/, "question and chosen answer, one line");
  assert.doesNotMatch(summary, /第二行是补充说明/, "only the question's first line is kept");
  assert.match(summary, /2 \/ 4 申诉入口形态？ → （未作答）/);
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
  assert.equal(needsUserReply([{ question: "a", kind: "unanswered" }]), true);
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

test("an unanswered question is not carried over — the interview resumes there", () => {
  const stored = {
    at: "t",
    answers: [
      { question: "范围？", kind: "answered" as const, answer: "A" },
      { question: "分支？", kind: "unanswered" as const },
    ],
  };
  assert.equal(resumeFrom(stored, QS).length, 1);
});

// ---- an environment with no dialogs must say so ----

test("the no-dialog notice hands the questions back to the agent, in full", () => {
  const notice = buildNoDialogNotice([q("范围？", ["只改这个模块", "整个仓库"], "只改这个模块")]);
  assert.match(notice, /没能展示给用户/);
  assert.match(notice, /写进你的回复/);
  assert.match(notice, /范围？/);
  assert.match(notice, /选项：A\. 只改这个模块（推荐） \/ B\. 整个仓库 \/ ✎ 不选，我说明原因/);
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

const PICK = q("选一个", ["继续", "停止"], "继续");

test("an answer the race delivered is honoured", () => {
  // The one case batching created: the project manager answered this question
  // through the channel before the user got to it. 先答者生效.
  assert.deepEqual(resolveQuestion(PICK, "B. 停止"),
    { answer: { question: "选一个", kind: "answered", answer: "B. 停止", option: "停止" } });
  // The letter and the recommendation marker are both dropped from the option
  // itself — the agent's own comparisons run on the text it wrote.
  assert.equal(resolveQuestion(PICK, "A. 继续（推荐）").answer.answer, "A. 继续");
  assert.equal(resolveQuestion(PICK, "A. 继续（推荐）").answer.option, "继续");
});

test("an instruct that took the box away is nobody deciding anything", () => {
  const interrupted = resolveQuestion(PICK, undefined, { interrupted: true });
  assert.deepEqual(interrupted, { answer: { question: "选一个", kind: "unanswered" } });
  assert.equal(interrupted.stop, undefined,
    "an interrupt is not the user closing anything — the channel settles the batch");
});

test("closing the box stops the WHOLE interview, and says so", () => {
  const closed = resolveQuestion(PICK, undefined);
  assert.equal(closed.stop, true);
  assert.equal(closed.answer.kind, "unanswered");
  // An ordinary answer stops nothing.
  assert.equal(resolveQuestion(PICK, "A. 继续").stop, undefined);
  assert.equal(resolveQuestion(PICK, `${DECLINE_ROW}：!chat`).answer.kind, "deferred-to-chat");
});

// ---------- walking back (user decision, 2026-09-19) ----------

test("the back row moves the cursor one question earlier, and never off the front", () => {
  assert.deepEqual(stepInterview({ anchor: 2, cursor: 2 }, BACK_ROW), { kind: "render", cursor: 1 });
  assert.deepEqual(stepInterview({ anchor: 2, cursor: 1 }, BACK_ROW), { kind: "render", cursor: 0 });
  assert.deepEqual(stepInterview({ anchor: 2, cursor: 0 }, BACK_ROW), { kind: "render", cursor: 0 },
    "the first question has nowhere to go back to");
});

test("an answer to the ANCHORED question settles it; an answer on the way back is a revision", () => {
  assert.deepEqual(stepInterview({ anchor: 2, cursor: 2 }, "A. 继续"),
    { kind: "answerCurrent", picked: "A. 继续" });
  assert.deepEqual(stepInterview({ anchor: 2, cursor: 0 }, "B. 停止"),
    { kind: "revise", index: 0, picked: "B. 停止" });
});

test("a closed box closes the interview, from whichever question it was", () => {
  assert.deepEqual(stepInterview({ anchor: 2, cursor: 2 }, undefined), { kind: "close" });
  assert.deepEqual(stepInterview({ anchor: 2, cursor: 1 }, undefined), { kind: "close" });
});

// ---------- the CHECKBOX shape (user decision, 2026-09-22) ----------

/**
 * THE INVARIANT BOTH SHAPES OWE: 「直接回车 ＝ 接受提问方的推荐」.
 *
 * A radio question pays for it with `recommended` (still required, still
 * refused when missing); a checkbox question pays with `defaultChecked` — the
 * group the list opens ticked. That is why the second field is REQUIRED and
 * the second shape needs no recommendation at all.
 */
const checklist = (over: Partial<AskQuestion> = {}): AskQuestion => ({
  text: "开哪几个环节？",
  options: ["预检", "quality 审查", "precommit"],
  recommended: "",
  multiple: true,
  defaultChecked: [],
  ...over,
});

test("a checklist with no defaultChecked is refused — there is nothing Enter would accept", () => {
  const missing = validateQuestions([
    { text: "开哪几个环节？", multiple: true, options: ["预检", "审查"] },
  ]);
  assert.equal(missing.ok, false);
  assert.match(missing.ok === false ? missing.error : "", /defaultChecked/);

  const ok = validateQuestions([
    { text: "开哪几个环节？", multiple: true, defaultChecked: ["预检"], options: ["预检", "审查"] },
  ]);
  assert.equal(ok.ok, true, ok.ok === false ? ok.error : "");
  assert.deepEqual(ok.ok === true ? ok.questions[0]!.defaultChecked : undefined, ["预检"]);
});

test("an EMPTY defaultChecked is a real recommendation — “tick none of them”", () => {
  const none = validateQuestions([
    { text: "开哪几个环节？", multiple: true, defaultChecked: [], options: ["预检", "审查"] },
  ]);
  assert.equal(none.ok, true, none.ok === false ? none.error : "");
  assert.deepEqual(none.ok === true ? none.questions[0]!.defaultChecked : undefined, []);
});

test("a tick that is not on the list is refused, and so is a tick on a RADIO question", () => {
  const stray = validateQuestions([
    { text: "开哪几个环节？", multiple: true, defaultChecked: ["不存在"], options: ["预检", "审查"] },
  ]);
  assert.equal(stray.ok, false);
  assert.match(stray.ok === false ? stray.error : "", /defaultChecked 里有不在选项里的/);

  // A default tick an agent believes in while the user sees a plain
  // single-choice list is exactly the silent misunderstanding this refuses.
  const radio = validateQuestions([
    { text: "选一个？", options: ["A", "B"], recommended: "A", defaultChecked: ["A"] },
  ]);
  assert.equal(radio.ok, false);
  assert.match(radio.ok === false ? radio.error : "", /defaultChecked 但没有 multiple/);
});

test("a checklist needs no recommended — but one it DOES give must be an option", () => {
  const without = validateQuestions([
    { text: "开哪几个环节？", multiple: true, defaultChecked: ["预检"], options: ["预检", "审查"] },
  ]);
  assert.equal(without.ok, true, without.ok === false ? without.error : "");

  const stray = validateQuestions([
    { text: "开哪几个环节？", multiple: true, defaultChecked: [], options: ["预检", "审查"], recommended: "第三个" },
  ]);
  assert.equal(stray.ok, false);
  assert.match(stray.ok === false ? stray.error : "", /不在选项里/);
});

test("a checklist may not be an AUTHORIZATION question — consent has one answer", () => {
  const refused = validateQuestions([
    {
      text: "授予权限？", multiple: true, defaultChecked: [],
      options: ["允许", "拒绝"], grantScope: "sensitive-edit",
    },
  ]);
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.error : "", /grantScope/);
});

test("an option CONTAINING the answer separator is refused — it could not be read back", () => {
  // `A. 甲 / C. 丙` is how a checklist answer is written down (quality round P2,
  // 2026-09-22), so an option whose own text contains `" / "` makes one tick
  // and two ticks the same string — silently, in the losing direction.
  const refused = validateQuestions([
    { text: "选方案？", multiple: true, defaultChecked: [], options: ["A / B 方案", "只有 A"] },
  ]);
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.error : "", /分隔符/);

  // The radio shape is untouched: it never joins several rows into one string.
  const radio = validateQuestions([
    { text: "选方案？", options: ["A / B 方案", "只有 A"], recommended: "只有 A" },
  ]);
  assert.equal(radio.ok, true, radio.ok === false ? radio.error : "");
});

test("a checklist answer nobody can read keeps the text but claims NO ticks", () => {
  const confused = resolveQuestion(checklist(), "一段谁都看不懂的话");
  assert.equal(confused.answer.kind, "answered");
  assert.equal(confused.answer.answer, "一段谁都看不懂的话");
  assert.equal(confused.answer.options, undefined,
    "an empty list means “ticked nothing”; prose must not be able to claim it");
});

test("the checklist answer is a LIST in option order — and an empty one is an answer", () => {
  const question = checklist();
  const picked = resolveQuestion(question, "C. precommit / A. 预检");
  assert.equal(picked.answer.kind, "answered");
  assert.deepEqual(picked.answer.options, ["预检", "precommit"], "option order, not the order they were ticked");
  assert.equal(picked.answer.answer, "A. 预检 / C. precommit");

  const confirmedNothing = resolveQuestion(question, "");
  assert.equal(confirmedNothing.answer.kind, "answered");
  assert.deepEqual(confirmedNothing.answer.options, []);
  assert.equal(confirmedNothing.answer.answer, MULTI_NONE_ANSWER);

  const declined = resolveQuestion(question, `${DECLINE_ROW}：一个都不开"`);
  assert.equal(declined.answer.kind, "answered");
  assert.deepEqual(declined.answer.options, []);

  // A closed box is still nothing of the sort, on either shape.
  const dismissed = resolveQuestion(question, undefined);
  assert.equal(dismissed.answer.kind, "unanswered");
  assert.equal(dismissed.stop, true);
});

test("the checklist's rows travel as CHECKBOX rows, in the transcript and the headless notice", () => {
  assert.deepEqual(questionRows(checklist({ defaultChecked: ["预检"] })), [
    "[x] A. 预检",
    "[ ] B. quality 审查",
    "[ ] C. precommit",
    DECLINE_ROW,
  ]);
  assert.match(buildNoDialogNotice([checklist({ defaultChecked: ["预检"] })]), /\[x\] A\. 预检/);
});
