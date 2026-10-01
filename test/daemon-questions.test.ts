/**
 * The pending-question file protocol (lib/daemon/questions.ts).
 *
 * docs/daemon/api.md is the frozen contract; these tests pin the half the
 * daemon owns — what it lists as pending, what an answer may say, and that a
 * second answer to one request is refused instead of overwriting the first.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  isPending,
  listPendingQuestions,
  parseAnswer,
  parseQuestion,
  submitAnswer,
} from "../lib/daemon/questions.ts";
import { questionAnswerPath, questionPath, sessionQuestionsDir } from "../lib/daemon/paths.ts";
import { MULTI_ANSWER_SEPARATOR } from "../lib/multi-choice-dialog.ts";
import { scratchHome } from "./daemon-helpers.ts";

const question = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1,
  requestId: "q-1",
  sessionId: "session-1",
  sessionName: "t1-work",
  topic: "ask-user",
  title: "选哪个？",
  options: ["甲", "乙", "丙"],
  multiple: false,
  recommended: "甲",
  defaultChecked: [],
  payload: null,
  payloadRef: null,
  batchId: null,
  batchIndex: null,
  batchTotal: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  ...overrides,
});

function writeQuestion(home: string, sessionId: string, requestId: string, value: unknown): void {
  mkdirSync(sessionQuestionsDir(home, sessionId), { recursive: true });
  writeFileSync(questionPath(home, sessionId, requestId), JSON.stringify(value));
}

test("parseQuestion accepts the documented shape and refuses each malformed part", () => {
  const ok = parseQuestion(question());
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.value.options, ["甲", "乙", "丙"]);
  assert.equal(ok.ok && ok.value.multiple, false);
  assert.equal(ok.ok && ok.value.recommended, "甲");

  const badSchema = parseQuestion({ ...question(), schema: 2 });
  assert.equal(badSchema.ok, false);
  assert.match(badSchema.ok ? "" : badSchema.problem, /schema/);
  assert.equal(parseQuestion(question({ requestId: "../escape" })).ok, false);
  assert.equal(parseQuestion(question({ sessionId: "" })).ok, false);
  assert.equal(parseQuestion(question({ title: "   " })).ok, false);
  assert.equal(parseQuestion(question({ recommended: "丁" })).ok, false, "a recommendation must be one of the options");
  assert.equal(parseQuestion(question({ recommended: null })).ok, false, "a radio question owes a recommendation");
  assert.equal(parseQuestion(question({ multiple: true, recommended: null })).ok, true, "a checkbox question may recommend none");
  assert.equal(parseQuestion(null).ok, false);
});

test("parseAnswer requires the identity pair and a non-empty answer", () => {
  const ok = parseAnswer({ schema: 1, requestId: "q-1", sessionId: "s1", answer: "甲", at: "2026-01-01T00:00:00.000Z" });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.value.by, "daemon");
  assert.equal(parseAnswer({ schema: 1, requestId: "q-1", sessionId: "s1", answer: "" }).ok, false);
  assert.equal(parseAnswer({ schema: 1, requestId: "q-1", sessionId: "../x", answer: "甲" }).ok, false);
});

test("listing shows only unanswered questions, and an answer file retires one", () => {
  const home = scratchHome();
  writeQuestion(home, "session-1", "q-1", question());
  writeQuestion(home, "session-1", "q-2", question({ requestId: "q-2", title: "第二题" }));
  writeQuestion(home, "session-2", "q-3", question({ requestId: "q-3", sessionId: "session-2" }));

  const all = listPendingQuestions(home);
  assert.equal(all.questions.length, 3);
  assert.deepEqual(all.problems, []);
  assert.equal(listPendingQuestions(home, { sessionId: "session-1" }).questions.length, 2);

  const first = all.questions.find((candidate) => candidate.requestId === "q-1")!;
  assert.equal(isPending(home, first), true);
  const outcome = submitAnswer(home, { sessionId: "session-1", requestId: "q-1", answer: "B" });
  assert.equal(outcome.ok, true, outcome.problem ?? "");
  assert.equal(outcome.answer, "乙", "a letter is resolved to the option it names");
  assert.ok(questionAnswerPath(home, "session-1", "q-1").endsWith(".answer.json"));
  assert.equal(listPendingQuestions(home).questions.length, 2);
});

test("an unreadable question file is reported, not silently dropped", () => {
  const home = scratchHome();
  writeQuestion(home, "session-1", "q-bad", { schema: 1, requestId: "q-bad" });
  const listed = listPendingQuestions(home);
  assert.equal(listed.questions.length, 0);
  assert.equal(listed.problems.length, 1);
  assert.match(listed.problems[0]!, /session-1\/q-bad\.json/);
});

test("an answer outside the offered rows is refused and nothing is written", () => {
  const home = scratchHome();
  writeQuestion(home, "session-1", "q-1", question());
  const outcome = submitAnswer(home, { sessionId: "session-1", requestId: "q-1", answer: "丁" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem ?? "", /不是这个框里的任何一项|超出选项范围/);
  assert.equal(listPendingQuestions(home).questions.length, 1);
});

test("a second answer to the same request is refused (first answer wins)", () => {
  const home = scratchHome();
  writeQuestion(home, "session-1", "q-1", question());
  const first = submitAnswer(home, { sessionId: "session-1", requestId: "q-1", answer: "甲", by: "user" });
  assert.equal(first.ok, true);
  const second = submitAnswer(home, { sessionId: "session-1", requestId: "q-1", answer: "乙" });
  assert.equal(second.ok, false);
  assert.match(second.problem ?? "", /已经答过/);
  const stored = JSON.parse(readFileSync(questionAnswerPath(home, "session-1", "q-1"), "utf8")) as { answer: string; by: string };
  assert.equal(stored.answer, "甲");
  assert.equal(stored.by, "user");
});

test("a checkbox question takes several rows; a radio one still takes one", () => {
  const home = scratchHome();
  writeQuestion(home, "session-1", "q-multi", question({
    requestId: "q-multi",
    multiple: true,
    recommended: null,
    defaultChecked: ["甲"],
  }));
  const outcome = submitAnswer(home, { sessionId: "session-1", requestId: "q-multi", answer: "甲 / 丙" });
  assert.equal(outcome.ok, true, outcome.problem ?? "");
  assert.equal(outcome.answer, "甲 / 丙");

  writeQuestion(home, "session-1", "q-radio", question({ requestId: "q-radio" }));
  const refused = submitAnswer(home, { sessionId: "session-1", requestId: "q-radio", answer: "甲 / 乙" });
  assert.equal(refused.ok, false, "a radio question keeps the single-row reading");
});

test("a question with no options takes free text (the panel's own input box)", () => {
  const home = scratchHome();
  writeQuestion(home, "session-1", "q-free", {
    schema: 1,
    requestId: "q-free",
    sessionId: "session-1",
    topic: "other",
    title: "有什么补充？",
    options: [],
    multiple: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const outcome = submitAnswer(home, { sessionId: "session-1", requestId: "q-free", answer: "随便写点什么" });
  assert.equal(outcome.ok, true, outcome.problem ?? "");
  assert.equal(outcome.answer, "随便写点什么");
});

test("a question whose fields disagree with its path is ignored, never answered", () => {
  const home = scratchHome();
  // The file sits at session-1/q-1.json but claims another session and request.
  writeQuestion(home, "session-1", "q-1", question({ sessionId: "session-2", requestId: "q-9" }));
  const listed = listPendingQuestions(home);
  assert.deepEqual(listed.questions, [], "an ask whose identity does not match its path is not listed");
  assert.match(listed.problems[0] ?? "", /与路径不一致/);

  const outcome = submitAnswer(home, { sessionId: "session-1", requestId: "q-1", answer: "甲" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem ?? "", /不一致/);
});

test("answering a request that was never written is a refusal with the reason", () => {
  const home = scratchHome();
  const outcome = submitAnswer(home, { sessionId: "session-1", requestId: "q-none", answer: "甲" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem ?? "", /读不到这个问题/);
});

test("a structured answers list is read row by row — option text may hold the parser's own separators", () => {
  const home = scratchHome();
  // Both rows contain a separator the free-text parser splits on.
  const options = ["A 方案 / 主路径", "B, 备选", "C 方案"];
  const at = (requestId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> =>
    question({ requestId, options, multiple: true, recommended: null, defaultChecked: [], ...overrides });
  writeQuestion(home, "session-1", "q-list", at("q-list"));
  writeQuestion(home, "session-1", "q-text", at("q-text"));

  const asList = submitAnswer(home, { sessionId: "session-1", requestId: "q-list", answers: [options[0]!, options[1]!] });
  assert.equal(asList.ok, true, asList.problem ?? "结构化列表应当被接受");
  assert.equal(asList.answer, [options[0], options[1]].join(MULTI_ANSWER_SEPARATOR));

  // THE SAME TWO ROWS AS ONE STRING cannot survive: the text path has to split
  // what it is given, and the fragments match several rows. That is exactly
  // why the list is handed over as a list.
  const asText = submitAnswer(home, {
    sessionId: "session-1",
    requestId: "q-text",
    answer: [options[0], options[1]].join(MULTI_ANSWER_SEPARATOR),
  });
  assert.equal(asText.ok, false);

  // A single-choice question takes one row, however many the caller sends.
  writeQuestion(home, "session-1", "q-single", at("q-single", { multiple: false, recommended: options[0] }));
  const tooMany = submitAnswer(home, {
    sessionId: "session-1",
    requestId: "q-single",
    answers: [options[0]!, options[2]!],
  });
  assert.equal(tooMany.ok, false);

  // One unreadable row refuses the whole answer — guessing which half was
  // meant is how a wrong tick gets minted.
  writeQuestion(home, "session-1", "q-junk", at("q-junk"));
  const junk = submitAnswer(home, {
    sessionId: "session-1",
    requestId: "q-junk",
    answers: [options[0]!, "不存在的一项"],
  });
  assert.equal(junk.ok, false);
  assert.match(junk.problem ?? "", /读不出来/);

  // The letters a single row would accept still work element by element.
  writeQuestion(home, "session-1", "q-letters", at("q-letters"));
  const letters = submitAnswer(home, { sessionId: "session-1", requestId: "q-letters", answers: ["A", "B"] });
  assert.equal(letters.ok, true, letters.problem ?? "字母也应当被认出来");
  assert.equal(letters.answer, [options[0], options[1]].join(MULTI_ANSWER_SEPARATOR));

  // Whitspace around an element is not part of the row, and an empty element is
  // no row at all — the text path trims, so this one must too.
  writeQuestion(home, "session-1", "q-spaced", at("q-spaced"));
  const spaced = submitAnswer(home, {
    sessionId: "session-1",
    requestId: "q-spaced",
    answers: [`  ${options[0]}  `, ""],
  });
  assert.equal(spaced.ok, true, spaced.problem ?? "首尾空白应当被忽略");
  assert.equal(spaced.answer, options[0]);

  // An empty element must not become “the only choice” on a one-option question
  // (`readRow` would match it against every option, and there is just one).
  writeQuestion(home, "session-1", "q-blank", question({ requestId: "q-blank", options: ["唯一"], recommended: "唯一" }));
  const blank = submitAnswer(home, { sessionId: "session-1", requestId: "q-blank", answers: [""] });
  assert.equal(blank.ok, false, "空元素不是一行");
});

test("a decline row is one answer on both paths, and never travels with a picked row", () => {
  const home = scratchHome();
  const options = ["甲", "乙", "✎ 不选，我说明原因"];
  const at = (requestId: string): Record<string, unknown> => question({ requestId, options, recommended: options[0] });
  const line = "✎ 不选，我说明原因：理由写在这里";

  writeQuestion(home, "session-1", "q-decline-list", at("q-decline-list"));
  const asList = submitAnswer(home, { sessionId: "session-1", requestId: "q-decline-list", answers: [line] });
  assert.equal(asList.ok, true, asList.problem ?? "退路行应当被接受");
  assert.equal(asList.answer, line);

  writeQuestion(home, "session-1", "q-decline-text", at("q-decline-text"));
  const asText = submitAnswer(home, { sessionId: "session-1", requestId: "q-decline-text", answer: line });
  assert.equal(asText.answer, line, "两种形状对同一个意图给出同一个答案");

  writeQuestion(home, "session-1", "q-decline-mixed", at("q-decline-mixed"));
  const mixed = submitAnswer(home, { sessionId: "session-1", requestId: "q-decline-mixed", answers: ["甲", line] });
  assert.equal(mixed.ok, false, "退路行不能和别的选项一起提交");
});
