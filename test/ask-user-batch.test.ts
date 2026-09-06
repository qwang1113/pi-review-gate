/**
 * THE INTERVIEW GOES UP AS A BATCH (2026-09-06) — and the pane still shows
 * one box at a time.
 *
 * WHAT WAS MEASURED, and why this file exists. A child's `ask_user` takes
 * 1–10 questions in one call, but the channel request record was written only
 * when that question's dialog was about to be raised. So the project manager
 * learned the interview one question at a time and answered it one round trip
 * at a time: five questions from child t9c cost five ask → wait → answer
 * cycles, t9e four, t9h three — and t9h additionally LOST two questions when
 * an instruct dismissed the single box that happened to be up.
 *
 * The whole batch is now handed to the funnel in one synchronous burst, so
 * every question is on the manager's first receipt. Two invariants must
 * survive that, and they are the reason these tests drive the REAL
 * `askThroughChannel` over an in-memory channel instead of a stub:
 *
 *   1. WHOEVER ANSWERS FIRST WINS. The human in the pane and the manager on
 *      the channel are both legitimate, and batching must not quietly hand
 *      the decision to one of them.
 *   2. THE USER'S WINDOW IS STILL SEQUENTIAL. One box, in question order, so
 *      a person can step in at any point — which is the fallback that makes a
 *      dead project manager survivable.
 *
 * A third property is what the batch bought: no question may be left OPEN on
 * the manager's receipt once the interview stops (skip, or an instruct), or
 * it rings on a 10s → 30s → 60s backoff for an answer nobody can give.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { doAskUser, type UserInteractionToolDeps } from "../lib/user-interaction-tools.ts";
import { askThroughChannel, type ChildChannelBinding } from "../lib/orchestrator-child-channel.ts";
import {
  appendRecord,
  channelPathFor,
  projectChannel,
  readChannel,
  type ChannelIO,
  type ChannelRecord,
} from "../lib/orchestrator-channel.ts";
import { emptyState, type GateState } from "../lib/gate-state.ts";
import { SKIP_REST_CHOICE } from "../lib/ask-user.ts";
import type { SensitiveGrant } from "../lib/sensitive-grant.ts";

const T0 = 1_700_000_000_000;
const ORCH = "orch-deadbeef-abc";
const CHILD = "c1";
const HOME = "/home/test";
const PATH = channelPathFor(ORCH, CHILD, HOME);

function memoryIO(): ChannelIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    ensureDir() { /* implicit */ },
    appendLine(path, line) { files.set(path, (files.get(path) ?? "") + line); },
    readText(path) { return files.get(path); },
    writeText(path, text) { files.set(path, text); },
    now: () => T0,
  };
}

/** Everything on the channel right now. */
function records(io: ChannelIO): ChannelRecord[] {
  return readChannel(io, PATH).records;
}

function requestsOn(io: ChannelIO): Array<Extract<ChannelRecord, { kind: "request" }>> {
  return records(io).filter((r): r is Extract<ChannelRecord, { kind: "request" }> => r.kind === "request");
}

function settlesOn(io: ChannelIO): Array<Extract<ChannelRecord, { kind: "request-settled" }>> {
  return records(io).filter((r): r is Extract<ChannelRecord, { kind: "request-settled" }> => r.kind === "request-settled");
}

/** Play the project manager: write an answer for one open request. */
function orchestratorAnswers(io: ChannelIO, requestId: string, answer: string): void {
  appendRecord(io, { orchestrationId: ORCH, childId: CHILD, home: HOME }, {
    kind: "answer",
    from: "orchestrator",
    at: new Date(T0).toISOString(),
    requestId,
    answer,
  });
}

interface Harness {
  io: ChannelIO & { files: Map<string, string> };
  deps: UserInteractionToolDeps;
  state: GateState;
  /** Titles of the boxes actually raised in the pane, in order. */
  rendered: string[];
  /** The largest number of boxes that were on screen at the same time. */
  maxConcurrent: number;
  armed: boolean[];
  ctx: unknown;
  /** Fires the gate's instruct interrupt, exactly as a real instruct does. */
  interrupt: AbortController;
  run(questions: unknown[]): Promise<string>;
}

/**
 * A child session wired to a REAL channel.
 *
 * `answerInPane` is the human: it is handed the question's title and returns
 * what the person picked (or `undefined` for a dismissal), and it may reach
 * into the channel first — which is how a test makes the project manager and
 * the human race for the same box.
 */
function harness(answerInPane: (title: string, h: Harness) => string | undefined | Promise<string | undefined>): Harness {
  const io = memoryIO();
  const binding: ChildChannelBinding = {
    io,
    target: { orchestrationId: ORCH, childId: CHILD, home: HOME },
    pollMs: 0,
    // A macrotask sleep: the channel watcher yields properly, so a test never
    // spends wall-clock time and never starves the dialogs it is racing.
    sleep: () => new Promise((resolve) => { setTimeout(resolve, 0); }),
  };
  let open = 0;
  const h: Harness = {
    io,
    state: emptyState("sess-1", 10),
    rendered: [],
    maxConcurrent: 0,
    armed: [],
    interrupt: new AbortController(),
    ctx: undefined,
    deps: undefined as unknown as UserInteractionToolDeps,
    run: undefined as unknown as Harness["run"],
  };
  const render = async (title: string, signal: AbortSignal): Promise<string | undefined> => {
    h.rendered.push(title);
    open += 1;
    h.maxConcurrent = Math.max(h.maxConcurrent, open);
    try {
      if (signal.aborted) return undefined;
      return await answerInPane(title, h);
    } finally {
      open -= 1;
    }
  };
  h.ctx = {
    hasUI: true,
    ui: {
      notify: () => {},
      select: (title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
        render(title, opts!.signal!),
      input: (title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) =>
        render(title, opts!.signal!),
    },
  };
  h.deps = {
    state: () => h.state,
    persist: () => {},
    setLoopArmed: (armed) => { h.armed.push(armed); },
    showToUser: () => true,
    confirmBounded: async () => true,
    canChannelDialogs: () => true,
    // THE REAL FUNNEL: the same call the extension makes, with the same
    // interrupt source an instruct fires.
    askEitherSide: (request, hasUI, renderDialog) =>
      askThroughChannel(binding, { ...request, hasUI }, renderDialog, h.interrupt.signal),
    grantProxyScope: () => {},
    cwd: "/repo",
    sessionEditedPaths: () => [],
    commitsAheadOfBase: async () => 0,
    scopeLimitDeclined: () => false,
    declineScopeLimit: () => {},
    sensitiveGrants: () => [] as SensitiveGrant[],
    storeSensitiveGrants: () => {},
    sensitiveDeclinedPaths: new Set<string>(),
    log: () => {},
  };
  h.run = async (questions) => {
    const reply = await doAskUser(h.deps, { questions }, h.ctx);
    return reply.content.map((c) => c.text).join("\n");
  };
  return h;
}

const THREE = [
  { text: "第一题：选架构", options: ["A", "B"], recommended: "A" },
  { text: "第二题：选存储", options: ["C", "D"], recommended: "C" },
  { text: "第三题：选站点", options: ["E", "F"], recommended: "E" },
];

// ---------------------------------------------------------------------------
// 1. The batch reaches the project manager BEFORE the first box is raised
// ---------------------------------------------------------------------------

test("all three questions are on the channel before the FIRST dialog renders", async () => {
  let seenAtFirstRender: Array<Extract<ChannelRecord, { kind: "request" }>> = [];
  const h = harness((title, self) => {
    if (seenAtFirstRender.length === 0) seenAtFirstRender = requestsOn(self.io);
    return title.includes("第一题") ? "A" : title.includes("第二题") ? "C" : "E";
  });

  await h.run(THREE);

  assert.equal(seenAtFirstRender.length, 3,
    "the whole interview is written before question 1 is even shown — that is what removes the round trips");
  const ids = new Set(seenAtFirstRender.map((r) => r.batchId));
  assert.equal(ids.size, 1, "one interview, one batch id");
  assert.ok([...ids][0], "the batch id is a real string");
  assert.deepEqual(seenAtFirstRender.map((r) => r.batchIndex), [0, 1, 2], "in question order");
  assert.deepEqual(seenAtFirstRender.map((r) => r.batchTotal), [3, 3, 3]);
  // The questions themselves travel VERBATIM, as they always did: the manager
  // never reads a screen.
  assert.match(seenAtFirstRender[1]!.title, /第二题：选存储/);
  assert.deepEqual(seenAtFirstRender[1]!.options.slice(0, 2), ["C（推荐）", "D"]);
});

test("a lone question carries NO batch stamp — an interview of one is just a question", async () => {
  const h = harness(() => "A");
  await h.run([{ text: "只有一个问题", options: ["A", "B"] }]);
  const [only] = requestsOn(h.io);
  assert.equal(requestsOn(h.io).length, 1);
  assert.equal(only!.batchId, undefined);
  assert.equal(only!.batchIndex, undefined);
  assert.equal(only!.batchTotal, undefined);
});

// ---------------------------------------------------------------------------
// 2. INVARIANT: the user's window is still one box at a time
// ---------------------------------------------------------------------------

test("INVARIANT: the pane still shows ONE box at a time, in question order", async () => {
  const h = harness((title) => (title.includes("第一题") ? "A" : title.includes("第二题") ? "C" : "E"));
  const text = await h.run(THREE);

  assert.equal(h.maxConcurrent, 1, "batching must never put three boxes on the user at once");
  assert.equal(h.rendered.length, 3);
  assert.match(h.rendered[0]!, /第一题/);
  assert.match(h.rendered[1]!, /第二题/);
  assert.match(h.rendered[2]!, /第三题/);
  assert.match(text, /全部已答/);
  assert.deepEqual(h.state.askUser?.answers.map((a) => a.answer), ["A", "C", "E"]);
});

// ---------------------------------------------------------------------------
// 3. INVARIANT: whoever answers first wins
// ---------------------------------------------------------------------------

test("INVARIANT: the project manager answers the WHOLE batch in one go, and no box needs dismissing", async () => {
  const h = harness((title, self) => {
    // While question 1 is on screen, the manager answers all three — which is
    // exactly what the batch is for.
    for (const request of requestsOn(self.io)) {
      orchestratorAnswers(self.io, request.requestId, request.options[1]!);
    }
    // The human keeps staring at question 1 and never picks anything; the
    // channel side is what settles it.
    return new Promise<string | undefined>(() => {});
  });

  const text = await h.run(THREE);

  assert.deepEqual(h.state.askUser?.answers.map((a) => a.answer), ["B", "D", "F"],
    "one round trip answered the whole interview");
  // The boxes for the already-answered questions DO open for an instant and
  // then come down by themselves — the user's decision (2026-09-06): keep the
  // one existing race rather than add a second "peek at the channel first"
  // code path. What matters is that nobody has to dismiss them.
  assert.deepEqual(settlesOn(h.io).map((s) => s.by), ["orchestrator", "orchestrator", "orchestrator"],
    "every question was decided by the manager, none by a dismissal");
  assert.equal(projectChannel(records(h.io)).openRequests.length, 0, "nothing is left ringing");
  assert.match(text, /全部已答/);
});

test("INVARIANT: the HUMAN wins the box that is open while the manager wins the ones it reached first", async () => {
  const h = harness((title, self) => {
    if (title.includes("第一题")) {
      // The manager answers questions 2 and 3 while the human is still on 1.
      for (const request of requestsOn(self.io)) {
        if (!request.title.includes("第一题")) orchestratorAnswers(self.io, request.requestId, request.options[1]!);
      }
      return "A"; // …and the human answers question 1 in the pane, first.
    }
    // Questions 2 and 3 are already settled on the channel; their boxes come
    // down on their own, so the human never gets to answer them.
    return new Promise<string | undefined>(() => {});
  });

  await h.run(THREE);

  assert.deepEqual(h.state.askUser?.answers.map((a) => a.answer), ["A", "D", "F"]);
  const by = settlesOn(h.io).map((s) => s.by);
  assert.deepEqual(by, ["human", "orchestrator", "orchestrator"],
    "the settle record names who actually decided each question");
});


// ---------------------------------------------------------------------------
// 4. Nothing may be left OPEN when the interview stops early
// ---------------------------------------------------------------------------

test("skip the rest: the unshown questions are settled as DISMISSED, not left ringing", async () => {
  const h = harness((title) => (title.includes("第一题") ? "A" : SKIP_REST_CHOICE));
  const text = await h.run(THREE);

  assert.deepEqual(h.state.askUser?.answers.map((a) => a.kind), ["answered", "skipped", "skipped"]);
  assert.equal(h.rendered.length, 2, "question 3 is never put in front of the user");
  assert.deepEqual(settlesOn(h.io).map((s) => s.by), ["human", "human", "dismissed"],
    "the question the user skipped IN the box is theirs; the one they never saw is a dismissal");
  assert.equal(projectChannel(records(h.io)).openRequests.length, 0,
    "a question nobody will ever answer must not stay on the manager's receipt");
  assert.match(text, /循环已暂停/, "an unanswered interview still pauses the loop");
  assert.deepEqual(h.armed, [false]);
});

test("an instruct INTERRUPT takes the whole batch down as interrupted — never as a rejection", async () => {
  const h = harness((title, self) => {
    if (title.includes("第一题")) {
      // The project manager fires an instruct while the interview is up.
      self.interrupt.abort();
      return new Promise<string | undefined>(() => {});
    }
    throw new Error("no further question may be raised after an interrupt");
  });

  await h.run(THREE);

  assert.deepEqual(h.state.askUser?.answers.map((a) => a.kind), ["unanswered", "unanswered", "unanswered"]);
  assert.deepEqual(settlesOn(h.io).map((s) => s.by), ["interrupted", "interrupted", "interrupted"],
    "an interrupted question is not a dismissal and not a decline — nobody decided anything");
  assert.equal(projectChannel(records(h.io)).openRequests.length, 0,
    "the batch that was interrupted stops asking for an answer");
  assert.deepEqual(h.armed, [false], "and the loop waits for the user");
});

test("an answer the manager already WON survives the user skipping the rest", async () => {
  // 先答者生效, in the one case batching created: the manager's answer to
  // question 3 landed and its watcher took it while the user was still on
  // question 1 — so by the time the user skips the rest, question 3 is not a
  // pending question at all. The skip only ever interprets SILENCE.
  const h = harness(async (title, self) => {
    if (title.includes("第一题")) {
      const third = requestsOn(self.io).find((r) => r.title.includes("第三题"))!;
      orchestratorAnswers(self.io, third.requestId, "F");
      // The human takes a moment to decide, which is all the channel watcher
      // needs to take the answer it was given.
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      return "A";
    }
    return SKIP_REST_CHOICE;
  });

  await h.run(THREE);

  assert.deepEqual(h.state.askUser?.answers.map((a) => a.kind), ["answered", "skipped", "answered"]);
  assert.equal(h.state.askUser?.answers[2]?.answer, "F",
    "an answer the race delivered is honoured, whatever stopped the rest");
  assert.equal(projectChannel(records(h.io)).openRequests.length, 0);
  const third = settlesOn(h.io).find((s) => s.answer === "F");
  assert.equal(third?.by, "orchestrator", "and the wire says who decided it");
});

