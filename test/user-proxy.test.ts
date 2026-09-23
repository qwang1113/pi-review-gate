/**
 * THE PROXY'S RULES — every one of them a safety property.
 *
 * Nothing here sleeps. The window is driven by an injected scheduler, so the
 * thirty-minute rule is pinned in milliseconds and the ORDER of the four facts
 * (human first / window elapses / human during the proxy's run / proxy first)
 * is asserted rather than hoped for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROXY_ANSWER_TIMEOUT_MS,
  PROXY_SYSTEM_PROMPT,
  buildProxyPrompt,
  formatProxyDecisionReport,
  parseProxyDecision,
  raceWithUserProxy,
  sessionProxyDecisions,
  type ProxyScheduler,
} from "../lib/user-proxy.ts";

test("the completion report claims only this session's decisions and its handoff predecessor's", () => {
  const row = (at: string, sessionId?: string) => ({
    at, question: `q-${at}`, options: ["a", "b"], choice: "a", rationale: "r",
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  const all = [
    row("2026-09-19T21:06:37Z"), // written before the field existed — a past task
    row("2026-09-20T00:35:52Z", "other"), // a concurrent / earlier session
    row("2026-09-23T07:00:00Z", "pred"), // the session this one continued
    row("2026-09-23T08:00:00Z", "me"),
  ];
  assert.deepEqual(
    sessionProxyDecisions(all, ["me", "pred"]).map((d) => d.at),
    ["2026-09-23T07:00:00Z", "2026-09-23T08:00:00Z"],
  );
  assert.deepEqual(sessionProxyDecisions(all, ["me", undefined]).map((d) => d.sessionId), ["me"],
    "no predecessor: only this session's own");
  assert.equal(formatProxyDecisionReport(sessionProxyDecisions(all.slice(0, 2), ["me"])), "",
    "history alone prints no proxy section at all");
});

/** A scheduler a test fires by hand — the window is a fact to be triggered. */
function manualClock(): {
  schedule: ProxyScheduler;
  fire: () => void;
  windows: Array<{ ms: number; fired: boolean }>;
} {
  const entries: Array<{ fn: () => void; ms: number; cancelled: boolean; fired: boolean }> = [];
  return {
    windows: entries,
    schedule: (fn, ms) => {
      const entry = { fn, ms, cancelled: false, fired: false };
      entries.push(entry);
      return {
        cancel: () => { entry.cancelled = true; },
      };
    },
    fire: () => {
      for (const entry of entries) {
        if (entry.cancelled || entry.fired) continue;
        entry.fired = true;
        entry.fn();
      }
    },
  };
}

/** A promise whose settlement this test controls. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const ROWS = ["A. grant it", "B. decline"];

test("the window is thirty minutes", () => {
  assert.equal(PROXY_ANSWER_TIMEOUT_MS, 30 * 60 * 1000);
});

test("a human answer inside the window never starts the proxy", async () => {
  const clock = manualClock();
  const human = deferred<string | undefined>();
  let proxyCalls = 0;
  const raced = raceWithUserProxy<string>({
    direct: human.promise,
    options: ROWS,
    schedule: clock.schedule,
    startProxy: async () => { proxyCalls += 1; return { choice: ROWS[0]!, rationale: "should never run" }; },
  });

  human.resolve(ROWS[1]!);
  const outcome = await raced;
  assert.equal(outcome.answer, ROWS[1]);
  assert.equal(outcome.byProxy, undefined, "the user's own answer carries no proxy mark");
  assert.equal(outcome.proxyFailed, undefined, "…and an ANSWERED dialog owes nobody anything");
  assert.equal(proxyCalls, 0, "…and the proxy was never even asked");

  // THE TIMER IS GONE, not merely unused: a live one would keep the process
  // alive and would fire a request for a question answered minutes ago.
  clock.fire();
  assert.equal(proxyCalls, 0, "a cancelled window never starts the proxy");
});

test("the window elapsing hands the question to the proxy, whose answer is MARKED", async () => {
  const clock = manualClock();
  const human = deferred<string | undefined>();
  const raced = raceWithUserProxy<string>({
    direct: human.promise,
    options: ROWS,
    schedule: clock.schedule,
    now: () => Date.parse("2026-09-19T12:00:00.000Z"),
    startProxy: async () => ({ choice: ROWS[0]!, rationale: "the transcript shows the user asked for exactly this" }),
  });

  assert.equal(clock.windows[0]?.ms, PROXY_ANSWER_TIMEOUT_MS, "the dialog waits the whole window before asking anyone else");
  clock.fire();
  const outcome = await raced;
  assert.equal(outcome.answer, ROWS[0]);
  assert.equal(outcome.byProxy?.rationale, "the transcript shows the user asked for exactly this");
  assert.equal(outcome.byProxy?.at, "2026-09-19T12:00:00.000Z");
});

test("the human wins even while the proxy is running — its answer is discarded", async () => {
  const clock = manualClock();
  const human = deferred<string | undefined>();
  const proxy = deferred<{ choice: string; rationale: string } | undefined>();
  const raced = raceWithUserProxy<string>({
    direct: human.promise,
    options: ROWS,
    schedule: clock.schedule,
    startProxy: () => proxy.promise,
  });

  clock.fire();                       // the proxy starts…
  human.resolve(ROWS[1]!);            // …and the user answers anyway
  const outcome = await raced;
  assert.equal(outcome.answer, ROWS[1]);
  assert.equal(outcome.byProxy, undefined, "the user's word outranks a stand-in");

  proxy.resolve({ choice: ROWS[0]!, rationale: "late" });   // must not throw, must not win
  await new Promise((r) => setImmediate(r));
  assert.equal(outcome.answer, ROWS[1]);
});

test("a proxy answer that is not one of the offered rows is NO answer", async () => {
  for (const choice of ["grant it", "A", 1, ""]) {
    const clock = manualClock();
    const human = deferred<string | undefined>();
    const raced = raceWithUserProxy<string>({
      direct: human.promise,
      options: ROWS,
      schedule: clock.schedule,
      startProxy: async () => ({ choice: choice as string, rationale: "x" }),
    });
    clock.fire();
    const outcome = await raced;
    assert.equal(outcome.answer, undefined, JSON.stringify(choice));
    assert.equal(outcome.byProxy, undefined, "nothing the dialog did not offer can be chosen");
  }
});

test("a CHECKBOX question may be answered with SEVERAL rows — and only a checkbox may (2026-09-22)", async () => {
  const CHECKBOX = ["A. 预检", "B. 质量审查", "C. precommit"];
  const run = async (choice: string, multiple: boolean) => {
    const clock = manualClock();
    const human = deferred<string | undefined>();
    const raced = raceWithUserProxy<string>({
      direct: human.promise,
      options: CHECKBOX,
      ...(multiple ? { multiple: true } : {}),
      schedule: clock.schedule,
      startProxy: async () => ({ choice, rationale: "上下文里两次提到这两个环节" }),
    });
    clock.fire();
    return raced;
  };

  const both = await run("A. 预检 / C. precommit", true);
  assert.equal(both.answer, "A. 预检 / C. precommit", "a checklist answer names every row the proxy picked");
  assert.ok(both.byProxy, "…and it is still marked as the proxy's own decision");
  assert.equal((await run("A. 预检", true)).answer, "A. 预检", "one tick is still an answer");

  // EVERY segment must be a row somebody offered: the check is widened by
  // SHAPE, never loosened, and one bad segment refuses the whole answer.
  for (const choice of ["A. 预检 / Z", "A. 预检 / B", " / "]) {
    assert.equal((await run(choice, true)).answer, undefined, choice);
  }

  // …and a RADIO question still takes exactly one row.
  assert.equal((await run("A. 预检 / C. precommit", false)).answer, undefined);
});

test("the proxy's task text says so when the question is a CHECKBOX", () => {
  const checkbox = buildProxyPrompt({ title: "开哪几个环节？", options: ["预检", "质量审查"], multiple: true });
  assert.match(checkbox, /多选题/);
  assert.match(checkbox, /\" \/ \"/);
  // REVIEWER P2 (2026-09-22): the options the proxy is GIVEN are raw texts
  // rendered as `1. 预检`, so an example written with the DIALOG's letters
  // (`A. 甲 / C. 丙`) asked for a string `isAcceptedProxyChoice` then refuses.
  assert.doesNotMatch(checkbox, /A\. 甲 \/ C\. 丙/);
  assert.match(checkbox, /不要写进 choice/);
  const radio = buildProxyPrompt({ title: "选一个", options: ["是", "否"] });
  assert.doesNotMatch(radio, /多选题/);
  assert.match(radio, /必须是其中某一条的正文/);
});

test("a proxy that fails, throws, or declines settles as NO answer — and REPORTS that nobody decided", async () => {
  for (const startProxy of [
    async () => undefined,
    async () => { throw new Error("arbiter died"); },
  ]) {
    const clock = manualClock();
    const human = deferred<string | undefined>();
    const raced = raceWithUserProxy<string>({
      direct: human.promise,
      options: ROWS,
      schedule: clock.schedule,
      startProxy,
    });
    clock.fire();
    const outcome = await raced;
    assert.equal(outcome.answer, undefined);
    assert.equal(outcome.byProxy, undefined);
    // THE DIFFERENCE THE CALLER CANNOT RECOVER ON ITS OWN: `answer: undefined`
    // is also what a CLOSED box returns, and those two moments owe the user
    // different things — one is answered, one still has a decision outstanding.
    assert.equal(outcome.proxyFailed, true, "a decision is still owed, and the gate must be able to say so");
  }
});

test("a dialog with no rows never asks the proxy — the window settles as unanswered", async () => {
  const clock = manualClock();
  const human = deferred<string | undefined>();
  let proxyCalls = 0;
  const raced = raceWithUserProxy<string>({
    direct: human.promise,
    options: [],
    schedule: clock.schedule,
    startProxy: async () => { proxyCalls += 1; return { choice: "whatever", rationale: "x" }; },
  });
  clock.fire();
  const outcome = await raced;
  assert.equal(outcome.answer, undefined);
  assert.equal(outcome.proxyFailed, true, "the window elapsed with nothing to ask — nobody decided");
  assert.equal(proxyCalls, 0, "there is nothing to choose from, so there is nothing to ask");
});

test("the proxy prompt carries the question, every row verbatim, and where to read context", () => {
  const prompt = buildProxyPrompt({
    title: "review-gate: AI 请求缩小审查范围——是否同意？",
    options: ROWS,
    body: "既有变更 3 个：a.ts, b.ts, c.ts",
    transcript: "/tmp/sessions/abc.jsonl",
    repoRoot: "/repo",
  });
  assert.match(prompt, /门禁的对话框等待超时/);
  assert.match(prompt, /A\. grant it/);
  assert.match(prompt, /B\. decline/);
  assert.match(prompt, /不可信数据/, "the body is fenced as data, like every other judge-facing prompt");
  assert.match(prompt, /\/tmp\/sessions\/abc\.jsonl/, "the proxy is told where to read the conversation");
  assert.match(prompt, /\/repo/);
  // The one thing that makes a proxied answer usable downstream:
  assert.match(PROXY_SYSTEM_PROMPT, /逐字完全相同/);
  // …and the one thing that keeps it honest:
  assert.match(PROXY_SYSTEM_PROMPT, /用户回来可以推翻/);
});

test("a race that ended before the box appeared never arms a window", async () => {
  // The human can answer in the moment between `displayed` resolving and the
  // callback running. Arming then would spawn an arbiter process whose result
  // `finish` immediately discards — correct, and a waste of a process.
  const clock = manualClock();
  const human = deferred<string | undefined>();
  const shown: { promise: Promise<void>; mark: () => void } = (() => {
    let mark: (() => void) | undefined;
    return { promise: new Promise<void>((resolve) => { mark = resolve; }), mark: () => mark?.() };
  })();
  let proxyCalls = 0;
  const raced = raceWithUserProxy<string>({
    direct: human.promise,
    displayed: shown.promise,
    options: ROWS,
    schedule: clock.schedule,
    startProxy: async () => { proxyCalls += 1; return { choice: ROWS[0]!, rationale: "x" }; },
  });

  human.resolve(ROWS[1]!);
  assert.equal((await raced).answer, ROWS[1]);
  shown.mark();
  await new Promise((r) => setImmediate(r));
  clock.fire();
  assert.equal(clock.windows.length, 0, "a settled race arms nothing");
  assert.equal(proxyCalls, 0);
});

test("the window is armed when the box APPEARS, not when it was queued", async () => {
  // THE DIALOG QUEUE SHOWS ONE BOX AT A TIME, so `askChoice` may be one of
  // several calls in a single assistant message with the later ones not on
  // screen yet. Their thirty minutes must not be running — measured in review
  // round 1: a second dialog behind one that stayed open past the window was
  // answered by the proxy before the user had ever seen the question.
  const clock = manualClock();
  const human = deferred<string | undefined>();
  const shown: { promise: Promise<void>; mark: () => void } = (() => {
    let mark: (() => void) | undefined;
    return { promise: new Promise<void>((resolve) => { mark = resolve; }), mark: () => mark?.() };
  })();
  let proxyCalls = 0;
  const raced = raceWithUserProxy<string>({
    direct: human.promise,
    displayed: shown.promise,
    options: ROWS,
    schedule: clock.schedule,
    startProxy: async () => { proxyCalls += 1; return { choice: ROWS[0]!, rationale: "x" }; },
  });

  assert.equal(clock.windows.length, 0, "a queued question has no window yet");
  clock.fire();
  assert.equal(proxyCalls, 0, "and nothing can fire for it");

  shown.mark();
  await new Promise((r) => setImmediate(r));
  assert.equal(clock.windows.length, 1, "the window starts when the box does");

  clock.fire();
  const outcome = await raced;
  assert.equal(proxyCalls, 1);
  assert.equal(outcome.byProxy?.rationale, "x");
});

test("the completion report names every proxy decision — and is EMPTY when there were none", () => {
  // The report a task ends with must read exactly as it always did when nobody
  // stood in for the user; and when somebody DID, the user must not have to dig
  // for it. `declare_done` prints this block mechanically.
  assert.equal(formatProxyDecisionReport([]), "");

  const text = formatProxyDecisionReport([
    {
      at: "2026-09-19T12:00:00.000Z",
      question: "AI 提交了本次任务的目标（退出条约）——是否认可？",
      options: ["A. 认可", "B. 拒绝"],
      choice: "A. 认可",
      rationale: "goal 与已批准 plan 的任务书一致",
    },
    { at: "2026-09-19T12:40:00.000Z", question: "缩小审查范围？", options: ["A. 同意", "B. 拒绝"], choice: "B. 拒绝", rationale: "" },
  ]);
  assert.match(text, /2 个决定是 arbiter 代你做的/);
  assert.match(text, /退出条约/);
  assert.match(text, /goal 与已批准 plan 的任务书一致/);
  assert.match(text, /B\. 拒绝/);
  assert.match(text, /推翻/, "the block says how to overturn one — re-running the step, not undoing");
  // The RATIONALE is nice to have; the DECISION is not.
  assert.match(formatProxyDecisionReport([
    { at: "t", question: "q", options: [], choice: "c", rationale: "" },
  ]), /「q」→ c/);
});

test("parseProxyDecision takes the documented shape and nothing else", () => {
  assert.deepEqual(parseProxyDecision('{"choice":"A. grant it","rationale":"because"}'), {
    choice: "A. grant it",
    rationale: "because",
  });
  // A fenced answer is still an answer.
  assert.deepEqual(parseProxyDecision('```json\n{"choice":"B. decline","rationale":"no"}\n```'), {
    choice: "B. decline",
    rationale: "no",
  });
  // …and every unusable shape is a clean miss (never a guess).
  for (const raw of [undefined, "", "   ", "null", "{}", '{"choice":""}', '{"choice":42}', "not json", "[1,2]", "42"]) {
    assert.equal(parseProxyDecision(raw), undefined, JSON.stringify(raw));
  }
});
