import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeQuestions,
  progressLabel,
  buildChoiceList,
  interpretChoice,
  formatAnswers,
  formatTranscriptSummary,
  needsUserReply,
  SKIP_REST_CHOICE,
  ANSWER_IN_CHAT_CHOICE,
  MAX_QUESTIONS,
  MAX_QUESTION_CHARS,
  MAX_OPTIONS,
  type AskAnswer,
} from "../lib/ask-user.ts";

// ---- question hygiene: a malformed list shrinks, it never explodes ----

test("plain strings and objects are both accepted", () => {
  const qs = normalizeQuestions(["范围？", { text: "分支？", options: ["A", "B"], recommended: "A" }]);
  assert.equal(qs.length, 2);
  assert.equal(qs[0].text, "范围？");
  assert.deepEqual(qs[1].options, ["A", "B"]);
  assert.equal(qs[1].recommended, "A");
});

test("empty, blank and non-question entries are dropped", () => {
  assert.deepEqual(normalizeQuestions([]), []);
  assert.deepEqual(normalizeQuestions(["", "   ", null, 42, {}]), []);
  assert.deepEqual(normalizeQuestions("not a list"), []);
  assert.deepEqual(normalizeQuestions(undefined), []);
});

test("counts and lengths are capped", () => {
  const many = normalizeQuestions(Array.from({ length: 50 }, (_, i) => `q${i}`));
  assert.equal(many.length, MAX_QUESTIONS);
  const long = normalizeQuestions([{ text: "x".repeat(MAX_QUESTION_CHARS + 500) }]);
  assert.equal(long[0].text.length, MAX_QUESTION_CHARS);
  const opts = normalizeQuestions([{ text: "q", options: Array.from({ length: 20 }, (_, i) => `o${i}`) }]);
  assert.equal(opts[0].options?.length, MAX_OPTIONS);
});

test("blank options disappear rather than becoming empty dialog rows", () => {
  const qs = normalizeQuestions([{ text: "q", options: ["", "  ", "A"] }]);
  assert.deepEqual(qs[0].options, ["A"]);
  const none = normalizeQuestions([{ text: "q", options: ["", "  "] }]);
  assert.equal(none[0].options, undefined);
});

// ---- what the dialog shows ----

test("progress is 1-based", () => {
  assert.equal(progressLabel(0, 3), "1 / 3");
  assert.equal(progressLabel(2, 3), "3 / 3");
});

test("a choice list marks the recommendation and always offers both escapes", () => {
  const choices = buildChoiceList({ text: "q", options: ["A", "B"], recommended: "B" });
  assert.deepEqual(choices, ["A", "B（推荐）", ANSWER_IN_CHAT_CHOICE, SKIP_REST_CHOICE]);
});

test("a question without options gets no choice list (it is free text)", () => {
  assert.deepEqual(buildChoiceList({ text: "q" }), []);
});

// ---- what a picked line MEANS ----

test("picking an option returns the option the agent wrote, without the marker", () => {
  const q = { text: "q", options: ["A", "B"], recommended: "B" };
  assert.deepEqual(interpretChoice("B（推荐）", q), { kind: "answered", answer: "B" });
  assert.deepEqual(interpretChoice("A", q), { kind: "answered", answer: "A" });
});

test("the two escapes are recognized", () => {
  const q = { text: "q", options: ["A"] };
  assert.deepEqual(interpretChoice(SKIP_REST_CHOICE, q), { kind: "skip-rest" });
  assert.deepEqual(interpretChoice(ANSWER_IN_CHAT_CHOICE, q), { kind: "deferred-to-chat" });
});

test("a dismissed dialog is neither an answer nor a skip", () => {
  // Treating ESC as consent is how a gate invents approvals.
  assert.deepEqual(interpretChoice(undefined, { text: "q", options: ["A"] }), { kind: "dismissed" });
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

test("the loop waits whenever anything went unanswered", () => {
  assert.equal(needsUserReply([{ question: "a", kind: "answered", answer: "x" }]), false);
  assert.equal(needsUserReply([{ question: "a", kind: "skipped" }]), true);
  assert.equal(needsUserReply([{ question: "a", kind: "deferred-to-chat" }]), true);
  assert.equal(needsUserReply([]), false);
});
