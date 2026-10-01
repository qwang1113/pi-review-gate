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

test("answering a request that was never written is a refusal with the reason", () => {
  const home = scratchHome();
  const outcome = submitAnswer(home, { sessionId: "session-1", requestId: "q-none", answer: "甲" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem ?? "", /读不到这个问题/);
});
