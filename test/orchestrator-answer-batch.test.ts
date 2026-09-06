/**
 * ANSWERING A WHOLE INTERVIEW IN ONE CALL (2026-09-06) — and the old way
 * still working, because the manager that will use this is running the build
 * it started with.
 *
 * A child's `ask_user` submits up to ten questions at once and now writes all
 * of them to its channel before it raises the first box. That closes half the
 * round trip; this file is the other half — `orchestrator_answer` taking the
 * whole batch — plus the compatibility property that made the wire change
 * safe in the first place:
 *
 *   A PROJECT MANAGER THAT HAS NEVER HEARD OF BATCHES sees N ordinary open
 *   requests and answers them one `requestId` at a time. It loses nothing but
 *   the convenience, and it is never blocked.
 *
 * The rule the batch path must not break is that ENFORCEMENT HAS ONE COPY:
 * the crosscheck, constraint 8 and the sensitive-edit grant door are reached
 * through the same function whether one question is answered or five, so a
 * batch can never become a way around a check (哲学三 — never two
 * implementations of the same rule).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

import {
  makeFakeWorld,
  projectionOf,
  replyText,
  twoTaskPlan,
} from "./helpers/fake-orchestration.ts";
import { normalizeAnswerItems } from "../lib/orchestrator-answer-tools.ts";
import type { FakeWorld } from "./helpers/fake-orchestration.ts";
import type { ChannelRecord } from "../lib/orchestrator-channel.ts";

const BATCH = "ask-batch-1";

async function spawnT1(world: FakeWorld): Promise<string> {
  const reply = await world.call("orchestrator_spawn", { taskId: "t1", task: "开工" });
  const id = (reply.details as { childId?: string } | undefined)?.childId;
  assert.ok(id, `spawn must return a childId: ${replyText(reply)}`);
  return id!;
}

/** A child that asked three questions in ONE interview, as the batch does. */
async function childWithInterview(world: FakeWorld): Promise<string> {
  const childId = await spawnT1(world);
  const questions = [
    { requestId: "q-1", title: "问题 1 / 3\n选架构", options: ["A", "B"] },
    { requestId: "q-2", title: "问题 2 / 3\n选存储", options: ["C", "D"] },
    { requestId: "q-3", title: "问题 3 / 3\n选站点", options: ["E", "F"] },
  ];
  questions.forEach((q, index) => {
    world.childAsks(childId, { ...q, topic: "ask-user", batch: { id: BATCH, index, total: 3 } });
  });
  return childId;
}

function answersOn(world: FakeWorld, childId: string): Array<Extract<ChannelRecord, { kind: "answer" }>> {
  return world.channelOf(childId)
    .filter((r): r is Extract<ChannelRecord, { kind: "answer" }> => r.kind === "answer");
}

// ---------------------------------------------------------------------------
// The batch form
// ---------------------------------------------------------------------------

test("ONE call answers the whole interview", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await childWithInterview(world);

  const reply = await world.call("orchestrator_answer", {
    childId,
    answers: [
      { requestId: "q-1", answer: "B" },
      { requestId: "q-2", answer: "2" },       // a 1-based index, same as the single form
      { requestId: "q-3", answer: "E" },
    ],
  });

  assert.notEqual(reply.isError, true, replyText(reply));
  assert.deepEqual(
    answersOn(world, childId).map((a) => [a.requestId, a.answer]),
    [["q-1", "B"], ["q-2", "D"], ["q-3", "E"]],
    "every question got its own answer record, resolved through the same option table",
  );
  const details = reply.details as { answered: number; refused: number };
  assert.equal(details.answered, 3);
  assert.equal(details.refused, 0);
  assert.equal(projectionOf(world, childId).pendingAnswers.length, 3,
    "all three are waiting for the child, which settles them itself");
});

test("one bad item is refused ON ITS OWN — the rest are still answered, and nothing rolls back", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await childWithInterview(world);

  const reply = await world.call("orchestrator_answer", {
    childId,
    answers: [
      { requestId: "q-1", answer: "B" },
      { requestId: "q-2", answer: "这不是任何一个选项" },
      { requestId: "q-3", answer: "F" },
    ],
  });

  const text = replyText(reply);
  assert.notEqual(reply.isError, true, "two of three went through, so this is not a failed call");
  const details = reply.details as { answered: number; refused: number; results: Array<{ requestId?: string; ok: boolean }> };
  assert.equal(details.answered, 2);
  assert.equal(details.refused, 1);
  assert.deepEqual(details.results.map((r) => r.ok), [true, false, true]);
  assert.deepEqual(answersOn(world, childId).map((a) => a.requestId), ["q-1", "q-3"],
    "the refused question got NO answer record — a batch is not a transaction, it is three decisions");
  assert.match(text, /不是这个框里的任何一项/, "the refusal says exactly what was wrong with that one item");
  assert.match(text, /q-2/, "…and which question it was");
  assert.match(text, /不会回滚/, "and it is explicit that the two written answers stand");
});

test("every item walks the SAME adjudication — a batch is not a way around the crosscheck", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childAsks(childId, {
    requestId: "goal-1",
    title: "认可这个 loop goal 吗？",
    options: ["认可，写入 .pi/loop-goal.md", "不认可，退回重谈"],
    payload: "# 目标\n只改 lib/a/ 下的东西",
    topic: "goal-approval",
  });

  // The single form's refusal, for reference.
  const single = await world.call("orchestrator_answer", { childId, answer: "认可，写入 .pi/loop-goal.md" });
  assert.equal(single.isError, true);

  // The same approval, smuggled in as a one-item batch, must be refused for
  // the same reason — the guard lives in the shared path, not in the caller.
  const batched = await world.call("orchestrator_answer", {
    childId,
    answers: [{ requestId: "goal-1", answer: "认可，写入 .pi/loop-goal.md" }],
  });
  assert.equal(batched.isError, true);
  assert.match(replyText(batched), /必须给出 `crosscheck` 对照/);
  assert.equal(answersOn(world, childId).length, 0,
    "no approval may reach the channel through either door");
});

test("the same requestId twice in one call writes ONE answer, not two", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await childWithInterview(world);

  const reply = await world.call("orchestrator_answer", {
    childId,
    answers: [
      { requestId: "q-1", answer: "A" },
      { requestId: "q-1", answer: "B" },
    ],
  });

  assert.deepEqual(answersOn(world, childId).map((a) => a.answer), ["A"],
    "the second one is dropped — a decided question must not be re-decided mid-call");
  assert.match(replyText(reply), /已经回答过了/);
  assert.equal((reply.details as { refused: number }).refused, 1);
});

test("an empty answers array answers nothing, and says so", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await childWithInterview(world);
  const reply = await world.call("orchestrator_answer", { childId, answers: [] });
  assert.equal(reply.isError, true);
  assert.match(replyText(reply), /answers 是空数组/);
  assert.equal(answersOn(world, childId).length, 0);
});

test("a malformed item is REPORTED, never silently skipped", () => {
  // Dropping it would answer fewer questions than the manager asked for and
  // say nothing about which one went missing.
  const items = normalizeAnswerItems([{ requestId: "q-1", answer: "A" }, 42, null]);
  assert.equal(items?.length, 3);
  assert.deepEqual(items?.[1], { answer: "" });
  assert.equal(normalizeAnswerItems("nope"), undefined, "a non-array is not a batch at all");
  assert.deepEqual(normalizeAnswerItems([{ requestId: " q-2 ", answer: "B", reason: "  " }])?.[0],
    { answer: "B", requestId: "q-2" }, "ids are trimmed and a blank reason is not a reason");
});

// ---------------------------------------------------------------------------
// COMPATIBILITY: the manager that only knows single answers
// ---------------------------------------------------------------------------

test("an OLD project manager answers the same interview one requestId at a time", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await childWithInterview(world);

  // It never sends `answers`; it does exactly what it did before the batch
  // existed — and the batch fields it has never heard of change nothing.
  for (const [requestId, answer] of [["q-1", "A"], ["q-2", "C"], ["q-3", "E"]] as const) {
    const reply = await world.call("orchestrator_answer", { childId, requestId, answer });
    assert.notEqual(reply.isError, true, replyText(reply));
    assert.match(replyText(reply), /已回答子会话/, "the single form keeps its own reply, word for word");
    assert.equal((reply.details as { answered: boolean }).answered, true);
  }
  assert.deepEqual(answersOn(world, childId).map((a) => a.answer), ["A", "C", "E"]);
});

test("with several questions open, an answer with NO requestId is still refused — batching changed nothing there", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await childWithInterview(world);
  const reply = await world.call("orchestrator_answer", { childId, answer: "A" });
  assert.equal(reply.isError, true);
  assert.match(replyText(reply), /必须指明 requestId/);
  assert.match(replyText(reply), /q-1/, "and it lists what is open");
  assert.equal(answersOn(world, childId).length, 0);
});

// ---------------------------------------------------------------------------
// The receipt: all of it, at once, legible as one interview
// ---------------------------------------------------------------------------

test("the receipt shows the whole interview with its positions, and points at the one-call answer", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await childWithInterview(world);

  const receipt = replyText(await world.call("orchestrator_wait", { timeoutMs: 0 }));

  for (const id of ["q-1", "q-2", "q-3"]) {
    assert.match(receipt, new RegExp(`requestId=\`${id}\``), `${id} must be answerable from this receipt alone`);
  }
  assert.match(receipt, /采访 `ask-batch-1` 第 1\/3 题/);
  assert.match(receipt, /采访 `ask-batch-1` 第 3\/3 题/);
  assert.match(receipt, /answers:\[\{requestId, answer\}, …\]/,
    "the receipt tells the manager it can answer the interview in one call");
  assert.match(receipt, /选架构/, "the questions themselves are in the receipt — nothing is read off a screen");
});

test("a request with a broken batch stamp is still an ordinary question", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  // Position outside its own total: unusable as a label, so it is dropped
  // rather than rendered as "第 8/2 题".
  world.childAsks(childId, {
    requestId: "q-x",
    title: "一个问题",
    options: ["A"],
    topic: "ask-user",
    batch: { id: "b", index: 7, total: 2 },
  });

  const receipt = replyText(await world.call("orchestrator_wait", { timeoutMs: 0 }));
  assert.match(receipt, /requestId=`q-x`/, "the question is still there to answer");
  assert.doesNotMatch(receipt, /第 8\/2 题/);
  assert.doesNotMatch(receipt, /采访/, "a stamp that makes no sense is shown as no stamp at all");

  const reply = await world.call("orchestrator_answer", { childId, answer: "A" });
  assert.notEqual(reply.isError, true, replyText(reply));
});
