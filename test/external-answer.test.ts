/**
 * THE EXTERNAL ANSWER CHANNEL (lib/external-answer.ts) — the gate's half of
 * the pending-question protocol.
 *
 * WHAT THESE TESTS ARE REALLY ABOUT. The happy path is three lines; what needs
 * pinning is every way the channel must NOT decide anything: an answer outside
 * the rows, a body that is not JSON, ids that do not match the ask, a home
 * that cannot be written. A second answer source that can be talked into a
 * verdict is a hole in every dialog the gate owns, so each refusal is driven
 * here through the real files and the real parser — never a mock of them.
 *
 * The two halves meet for real: the ANSWERS are written by the daemon's own
 * `submitAnswer` (lib/daemon/questions.ts), so these tests fail if either side
 * drifts from docs/daemon/api.md §7.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildExternalQuestion,
  createExternalAnswers,
  lookAtAnswerFile,
  newExternalRequestId,
  type ExternalAnswerHandle,
  type ExternalQuestionInput,
} from "../lib/external-answer.ts";
import { listPendingQuestions, parseQuestion, REQUEST_ID_PATTERN, submitAnswer } from "../lib/daemon/questions.ts";
import { questionAnswerPath, questionPath, sessionQuestionsDir } from "../lib/daemon/paths.ts";
import { DECLINE_ROW } from "../lib/choice-dialog.ts";

const SESSION = "sess-external-1";

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "rg-external-"));
}

/** A scheduler a test steps by hand, so nothing here waits on a clock. */
function manual(): { schedule: (fn: () => void, ms: number) => { cancel: () => void }; step: () => void; pending: () => number } {
  const queue: Array<() => void> = [];
  return {
    schedule: (fn) => {
      queue.push(fn);
      return {
        cancel: () => {
          const at = queue.indexOf(fn);
          if (at >= 0) queue.splice(at, 1);
        },
      };
    },
    step: () => { queue.shift()?.(); },
    pending: () => queue.length,
  };
}

function channel(home: string, overrides: { identity?: () => { sessionId: string } | undefined; log?: (m: string) => void } = {}) {
  const clock = manual();
  const logs: string[] = [];
  return {
    clock,
    logs,
    channel: createExternalAnswers({
      home,
      identity: overrides.identity ?? (() => ({ sessionId: SESSION })),
      now: () => 1_700_000_000_000,
      schedule: clock.schedule,
      log: overrides.log ?? ((message) => { logs.push(message); }),
    }),
  };
}

const ALLOW_SPEC = {
  title: "允许吗？",
  options: ["允许", "拒绝"],
  recommended: "拒绝",
};

/** The one pending question on the machine, or a failed assertion. */
function pending(home: string) {
  const listed = listPendingQuestions(home);
  assert.deepEqual(listed.problems, [], "a question the daemon cannot parse is a question nobody can answer");
  assert.equal(listed.questions.length, 1);
  return listed.questions[0]!;
}

/** Publish one question and hand the test everything it needs to answer it. */
function ask(home: string, input: Partial<ExternalQuestionInput> = {}) {
  const built = channel(home);
  const handle = built.channel.open({
    spec: ALLOW_SPEC,
    multiple: false,
    body: "正文（不可信数据）",
    ...input,
  });
  return { ...built, handle, question: pending(home) };
}

test("the question is published at the frozen path, in the frozen shape", () => {
  const home = scratchHome();
  const { question, handle } = ask(home, { topic: "goal-approval", batch: { id: "ask-x", index: 1, total: 3 } });

  assert.match(question.requestId, REQUEST_ID_PATTERN);
  assert.equal(question.sessionId, SESSION);
  assert.equal(question.title, ALLOW_SPEC.title);
  // The rows the dialog SHOWS: the options plus the template's own decline row.
  assert.deepEqual(question.options, ["允许", "拒绝", DECLINE_ROW]);
  assert.equal(question.recommended, "拒绝");
  assert.equal(question.multiple, false);
  assert.deepEqual(question.defaultChecked, []);
  assert.equal(question.payload, "正文（不可信数据）");
  assert.equal(question.payloadRef, null);
  assert.equal(question.topic, "goal-approval");
  assert.equal(question.batchId, "ask-x");
  assert.equal(question.batchIndex, 1);
  assert.equal(question.batchTotal, 3);
  // The path is the identity: (directory sessionId, filename requestId).
  assert.ok(existsSync(questionPath(home, SESSION, question.requestId)));
  assert.equal(parseQuestion(question).ok, true);
  // Nothing was answered, so it is listed as pending ...
  assert.equal(existsSync(questionAnswerPath(home, SESSION, question.requestId)), false);
  handle.close();
});

test("an answer written by the daemon settles the dialog, and both files go away", async () => {
  const home = scratchHome();
  const { clock, handle, question } = ask(home);

  const written = submitAnswer(home, { sessionId: SESSION, requestId: question.requestId, answer: "允许" });
  assert.equal(written.ok, true, written.problem ?? "submitAnswer refused the daemon's own write");

  clock.step();
  assert.equal(await handle.answer, "允许");
  assert.equal(handle.answered(), true);
  assert.equal(existsSync(questionPath(home, SESSION, question.requestId)), false);
  assert.equal(existsSync(questionAnswerPath(home, SESSION, question.requestId)), false);
  assert.equal(listPendingQuestions(home).questions.length, 0);
});

test("a letter or a 1-based number means the same row the screen offered", async () => {
  // The shorthands are `resolveAnswer`'s (lib/orchestrator-answer-rules.ts) —
  // the SAME reader the daemon and the project manager's answers already use.
  for (const given of ["A", "a", "A.", "1"]) {
    const home = scratchHome();
    const { clock, handle, question } = ask(home);
    assert.equal(submitAnswer(home, { sessionId: SESSION, requestId: question.requestId, answer: given }).ok, true);
    clock.step();
    assert.equal(await handle.answer, "允许", `"${given}" should have read as the first row`);
  }
});

test("the decline row is an answerable row — with the reason the user typed", async () => {
  const home = scratchHome();
  const { clock, handle, question } = ask(home);
  const decline = `${DECLINE_ROW}：这个授权我不放心`;
  assert.equal(submitAnswer(home, { sessionId: SESSION, requestId: question.requestId, answer: decline }).ok, true);
  clock.step();
  assert.equal(await handle.answer, decline, "a refusal must arrive as a refusal, with its reason");
});

test("a checkbox question keeps its shape on the wire and takes several rows", async () => {
  const home = scratchHome();
  const { clock, handle, question } = ask(home, {
    spec: { title: "开哪几个环节？", options: ["审查", "质量", "验收"], defaultChecked: ["审查"] },
    multiple: true,
  });
  assert.equal(question.multiple, true);
  assert.deepEqual(question.defaultChecked, ["审查"]);
  assert.equal(question.recommended, null);

  assert.equal(submitAnswer(home, { sessionId: SESSION, requestId: question.requestId, answer: "审查、验收" }).ok, true);
  clock.step();
  assert.equal(await handle.answer, "审查 / 验收");
});

test("an answer outside the offered rows is REFUSED and the dialog goes on waiting", async () => {
  const home = scratchHome();
  const { clock, logs, handle, question } = ask(home);
  const answerFile = questionAnswerPath(home, SESSION, question.requestId);
  writeFileSync(answerFile, JSON.stringify({
    schema: 1, requestId: question.requestId, sessionId: SESSION, answer: "我自己发明的答案", by: "daemon", reason: null, at: "2026-10-01T00:00:00.000Z",
  }));

  clock.step();
  assert.equal(handle.answered(), false, "nothing that is not a row may settle a dialog");
  // Consumed, so a real answer can still be written later ...
  assert.equal(existsSync(answerFile), false);
  assert.equal(existsSync(questionPath(home, SESSION, question.requestId)), true);
  assert.match(logs.join("\n"), /外部答案被拒/);

  // ... and it does: the refusal cost the panel nothing.
  assert.equal(submitAnswer(home, { sessionId: SESSION, requestId: question.requestId, answer: "拒绝" }).ok, true);
  clock.step();
  assert.equal(await handle.answer, "拒绝");
});

test("a body that is not an answer at all never settles anything", async () => {
  const home = scratchHome();
  const { clock, handle, question } = ask(home);
  const answerFile = questionAnswerPath(home, SESSION, question.requestId);
  writeFileSync(answerFile, "{ not json");
  clock.step();
  assert.equal(handle.answered(), false);
  assert.equal(existsSync(answerFile), false);

  writeFileSync(answerFile, JSON.stringify({ schema: 1, requestId: question.requestId, sessionId: SESSION, answer: "" }));
  clock.step();
  assert.equal(handle.answered(), false, "an empty answer is not an answer");
});

test("an answer whose ids do not match the ask is refused", async () => {
  const home = scratchHome();
  const { clock, handle, question } = ask(home);
  const answerFile = questionAnswerPath(home, SESSION, question.requestId);
  writeFileSync(answerFile, JSON.stringify({
    schema: 1, requestId: "q-somebody-else", sessionId: SESSION, answer: "允许", by: "daemon", reason: null, at: "2026-10-01T00:00:00.000Z",
  }));
  clock.step();
  assert.equal(handle.answered(), false, "an answer for another request is not this request's answer");
  assert.equal(existsSync(answerFile), false);
});

test("close() takes the question off the wire and stops the watch", () => {
  const home = scratchHome();
  const { clock, handle, question } = ask(home);
  handle.close();
  assert.equal(existsSync(questionPath(home, SESSION, question.requestId)), false);
  assert.equal(existsSync(sessionQuestionsDir(home, SESSION)), false, "the session's own directory is reclaimed when it empties");
  assert.equal(clock.pending(), 0);
  handle.close(); // idempotent
  assert.equal(handle.answered(), false);
});

test("no session identity ⇒ the protocol is not offered, and nothing is written", async () => {
  const home = scratchHome();
  const built = channel(home, { identity: () => undefined });
  const handle = built.channel.open({ spec: ALLOW_SPEC, multiple: false });
  assert.equal(listPendingQuestions(home).questions.length, 0);
  assert.equal(built.clock.pending(), 0);
  handle.close();
  assert.equal(await Promise.race([handle.answer, "still waiting"]), "still waiting");
});

test("an unwritable home degrades to the old behavior instead of failing the dialog", async () => {
  const blocker = join(scratchHome(), "not-a-directory");
  writeFileSync(blocker, "x");
  const built = channel(join(blocker, "nested"));
  const handle = built.channel.open({ spec: ALLOW_SPEC, multiple: false });
  assert.match(built.logs.join("\n"), /外部答案通道不可用/);
  assert.equal(await Promise.race([handle.answer, "still waiting"]), "still waiting");
});

test("a request id is a safe path segment and does not repeat", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newExternalRequestId(1_700_000_000_000)));
  assert.equal(ids.size, 200, "a resumed session must never re-use a request id");
  for (const id of ids) assert.match(id, REQUEST_ID_PATTERN);
});

test("lookAtAnswerFile reads exactly what it is given", () => {
  const home = mkdtempSync(join(tmpdir(), "rg-external-look-"));
  mkdirSync(join(home, "x"), { recursive: true });
  const path = join(home, "x", "a.json");
  const expected = { sessionId: SESSION, requestId: "q-1", options: ["允许", "拒绝"], multiple: false };
  assert.deepEqual(lookAtAnswerFile(path, expected), { kind: "pending" });
  writeFileSync(path, JSON.stringify({ schema: 1, requestId: "q-1", sessionId: SESSION, answer: "允许" }));
  assert.deepEqual(lookAtAnswerFile(path, expected), { kind: "answer", answer: "允许" });
  assert.equal(lookAtAnswerFile(path, { ...expected, requestId: "q-2" }).kind, "refused");
});

test("buildExternalQuestion never invents a recommendation for a checkbox", () => {
  const question = buildExternalQuestion(SESSION, "q-1", {
    spec: { title: "t", options: ["甲", "乙"], defaultChecked: ["乙"] },
    multiple: true,
  }, "2026-10-01T00:00:00.000Z");
  assert.equal(question.recommended, null);
  assert.deepEqual(question.defaultChecked, ["乙"]);
});
