/**
 * THE THIRD ANSWER SOURCE AT THE DIALOG (lib/gate-dialogs.ts ×
 * lib/external-answer.ts).
 *
 * The unit tests next door pin what the channel does with a file. These pin
 * what a DIALOG does with it: `askDialog` is the one funnel every gate dialog
 * goes through, and an answer that arrives from the panel has to behave like
 * the user's own — it settles the box, it takes the question off the panel,
 * it is never recorded as a stand-in's decision, and it does not disturb the
 * human's box or the arbiter's window when THOSE win instead.
 *
 * The answers are written by the daemon's own `submitAnswer`, so both halves
 * of docs/daemon/api.md §7 are exercised end to end on every run.
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGateDialogs } from "../lib/gate-dialogs.ts";
import { createExternalAnswers } from "../lib/external-answer.ts";
import { listPendingQuestions, submitAnswer } from "../lib/daemon/questions.ts";
import { DECLINE_ROW, type ChoiceSpec } from "../lib/choice-dialog.ts";
import type { SessionHost } from "../lib/session-host.ts";

const SESSION = "sess-dialog-1";
/** The window the stand-in waits for — short only in the sense that a test never waits it out. */
const WAIT_MS = 90_000;

const SPEC: ChoiceSpec = { title: "允许吗？", options: ["允许", "拒绝"], recommended: "拒绝" };
const CHECKBOX: ChoiceSpec = { title: "开哪几个环节？", options: ["审查", "质量", "验收"], defaultChecked: ["审查"] };

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** A scheduler the test steps by hand: the poll never waits on a real clock. */
function manual() {
  const queue: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => {
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

/** A box nobody answers: it only ever leaves the screen by being aborted. */
function absentBox(onAbort?: () => void) {
  return {
    select: (_title: string, _rows: string[], opts?: { signal?: AbortSignal }) =>
      new Promise<string | undefined>((resolve) => {
        opts?.signal?.addEventListener("abort", () => { onAbort?.(); resolve(undefined); }, { once: true });
      }),
  };
}

/** The same, for the checkbox shape (lib/multi-choice-dialog.ts's own seam). */
const absentCheckbox = {
  multiSelect: (_title: string, _spec: ChoiceSpec, opts?: { signal?: AbortSignal }) =>
    new Promise<undefined>((resolve) => {
      opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    }),
};

function harness() {
  const home = mkdtempSync(join(tmpdir(), "rg-gate-external-"));
  const clock = manual();
  const logs: string[] = [];
  const recorded: string[] = [];
  const lastUserInteractionAt: { current: string | undefined } = { current: undefined };
  let proxyCalls = 0;
  const host = {
    repos: () => ({ active: "/repo", primary: "/repo" }),
    ctx: () => undefined,
  } as unknown as SessionHost;
  const dialogs = createGateDialogs(host, {
    proxy: {
      answerFor: async (spec) => {
        proxyCalls += 1;
        return { choice: { choice: spec.options[0]!, rationale: "stand-in" } };
      },
      record: (_spec, answer) => { recorded.push(answer); },
      all: () => [],
    },
    raiseBanner: () => undefined,
    lastUserInteractionAt,
    proxyWaitMs: () => WAIT_MS,
    externalAnswers: createExternalAnswers({
      home,
      identity: () => ({ sessionId: SESSION }),
      schedule: clock.schedule,
      log: (message) => { logs.push(message); },
    }),
  });
  return {
    home,
    clock,
    logs,
    recorded,
    lastUserInteractionAt,
    dialogs,
    proxyCalls: () => proxyCalls,
    pending: () => listPendingQuestions(home).questions,
  };
}

test("an answer from the panel settles the box, exactly as the user's own would", async () => {
  const h = harness();
  let aborted = false;
  let byArbiter = false;
  const asking = h.dialogs.askChoice(
    { ui: absentBox(() => { aborted = true; }) } as never,
    SPEC,
    { body: "正文（不可信数据）", onProxyAnswer: () => { byArbiter = true; } },
  );

  // The question is on the wire BEFORE the box is drawn (that is what lets a
  // panel answer a queued dialog), with the rows the dialog shows.
  const question = h.pending()[0]!;
  assert.equal(question.title, SPEC.title);
  assert.deepEqual(question.options, ["允许", "拒绝", DECLINE_ROW]);
  assert.equal(question.payload, "正文（不可信数据）");

  assert.equal(submitAnswer(h.home, { sessionId: SESSION, requestId: question.requestId, answer: "允许" }).ok, true);
  h.clock.step();

  assert.equal(await asking, "允许");
  assert.equal(aborted, true, "the human's box must come off the screen the moment somebody else answered");
  assert.equal(byArbiter, false, "the panel is the user, not a stand-in");
  assert.deepEqual(h.recorded, [], "no proxy decision may be recorded for the user's own answer");
  assert.equal(h.proxyCalls(), 0, "the stand-in must not even be asked");
  assert.ok(h.lastUserInteractionAt.current, "an answer from the panel IS the user engaging");
  assert.deepEqual(h.pending(), [], "the question leaves the panel with the box");
});

test("the human's own answer closes the channel and takes the question off the wire", async () => {
  const h = harness();
  const asking = h.dialogs.askChoice({ ui: { select: async () => "A. 允许" } } as never, SPEC);

  assert.equal(await asking, "A. 允许");
  assert.deepEqual(h.pending(), [], "nobody may be offered an answer to a dialog that is already closed");
  assert.equal(h.clock.pending(), 0, "the watch stops with the dialog");
});

test("a checkbox question reaches the panel with its shape and its default ticks", async () => {
  const h = harness();
  const asking = h.dialogs.askMultiChoice({ ui: absentCheckbox } as never, CHECKBOX, { topic: "ask-user" });

  const question = h.pending()[0]!;
  assert.equal(question.multiple, true);
  assert.deepEqual(question.defaultChecked, ["审查"]);
  assert.equal(question.recommended, null);
  assert.equal(question.topic, "ask-user");

  assert.equal(submitAnswer(h.home, { sessionId: SESSION, requestId: question.requestId, answer: "质量、验收" }).ok, true);
  h.clock.step();
  assert.equal(await asking, "质量 / 验收");
});

test("a nonsense answer leaves the dialog waiting — it can never become a decision", async () => {
  const h = harness();
  const asking = h.dialogs.askChoice({ ui: absentBox() } as never, SPEC);
  const question = h.pending()[0]!;
  // The panel's own route validates, so this is a hand-planted file: the gate
  // must still refuse it rather than read it as the human's word.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(h.home, ".pi", "agent", "rg-daemon", "questions", SESSION, `${question.requestId}.answer.json`),
    JSON.stringify({ schema: 1, requestId: question.requestId, sessionId: SESSION, answer: "随便写点什么" }),
  );
  h.clock.step();

  assert.deepEqual(h.pending().length, 1, "the question is still open");
  assert.match(h.logs.join("\n"), /外部答案被拒/);
  assert.equal(h.proxyCalls(), 0, "a refused answer is not a reason to give up on the user");

  // ... and a real answer still lands.
  assert.equal(submitAnswer(h.home, { sessionId: SESSION, requestId: question.requestId, answer: "拒绝" }).ok, true);
  h.clock.step();
  assert.equal(await asking, "拒绝");
});

test("an unattended dialog still reaches the arbiter — the extra source changes nothing", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const h = harness();
    let byArbiter = false;
    const asking = h.dialogs.askChoice(
      { ui: absentBox() } as never,
      SPEC,
      { onProxyAnswer: () => { byArbiter = true; } },
    );
    const question = h.pending()[0]!;
    await flush();
    mock.timers.tick(WAIT_MS);
    const answer = await asking;
    assert.equal(answer, "允许");
    assert.equal(byArbiter, true);
    assert.deepEqual(h.recorded, ["允许"]);
    assert.deepEqual(h.pending(), [], `the question must not outlive the dialog (${question.requestId})`);
    assert.equal(h.clock.pending(), 0);
  } finally {
    mock.timers.reset();
  }
});
