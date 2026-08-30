/**
 * A MESSAGE TO A BUSY CHILD — and the readout that says when to hand over.
 *
 * Two round-4 P1s, both about the orchestrator being told something false.
 *
 * `followUp` means "finish what you are doing, then read this". The delivery
 * check demanded an INJECTION, which a busy child cannot give by definition,
 * so the tool failed on exactly the children the mode exists for — and the
 * message it had already written into the channel was then orphaned. Measured
 * once, worked around by smuggling the text into an answer option. The
 * handshake is two-stage now: `received` proves the gate has it and queued
 * it, `injected` proves pi took it.
 *
 * The context reading was worse in a quieter way: the binding was never wired
 * at all, so every receipt said "宿主未提供读数" and the orchestrator had no
 * basis for deciding when to hand over — on the one axis, running long, that
 * defines unattended work.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

import { makeFakeWorld, projectionOf, replyText, twoTaskPlan, type FakeWorld } from "./helpers/fake-orchestration.ts";
import { deliveryVerdict } from "../lib/orchestrator-delivery.ts";
import { contextPercentFromUsage, handoffAdvice } from "../lib/orchestrator-handoff-advice.ts";


async function spawnT1(world: FakeWorld): Promise<string> {
  const reply = await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  assert.equal(reply.isError, undefined, replyText(reply));
  return world.runtime().children[0]!.id;
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test("`received` is enough for followUp, and NOT enough for steer", () => {
  const evidence = {
    channelReported: true,
    sidecarPresent: true,
    ack: { delivered: true, stage: "received" as const, detail: "已入队（mode=followUp）" },
  };
  const followUp = deliveryVerdict("instruct", evidence, { instructMode: "followUp" });
  assert.equal(followUp.ok, true, "a queued message to a busy child IS delivered");

  const steer = deliveryVerdict("instruct", evidence, { instructMode: "steer" });
  assert.equal(steer.ok, false, "steer promises the CURRENT turn — queued does not satisfy that");
  assert.match((steer as { reason: string }).reason, /followUp/, "and it says which mode would have been right");
});

test("an injection failure is still a failure, whatever the mode", () => {
  const verdict = deliveryVerdict("instruct", {
    channelReported: true,
    sidecarPresent: true,
    ack: { delivered: false, stage: "injected", detail: "sendUserMessage threw" },
  }, { instructMode: "followUp" });
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /sendUserMessage threw/, "with the child's own explanation");
});

test("no acknowledgement at all points at the health snapshot — never at a kill", () => {
  const verdict = deliveryVerdict("instruct", { channelReported: true, sidecarPresent: false }, {
    instructMode: "followUp",
  });
  assert.equal(verdict.ok, false);
  const reason = (verdict as { reason: string }).reason;
  assert.match(reason, /waiting-judge/, "the first thing to check is whether it is simply busy");
  assert.doesNotMatch(reason, /orchestrator_close|interrupt/,
    "an unacknowledged message is not evidence that a session should be ended");
});

// ---------------------------------------------------------------------------
// Through the tool
// ---------------------------------------------------------------------------

test("followUp to a WORKING child succeeds on the receipt its gate wrote", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  // It is mid-turn: the heartbeat drains the instruction and acknowledges
  // receipt, but nothing is injected until the turn ends.
  world.childReports(childId, "working");

  // The delivery check polls, so the ack is written concurrently — which is
  // exactly how the 10-second heartbeat delivers it in production.



  const reply = await Promise.all([
    world.call("orchestrator_instruct", { childId, mode: "followUp", message: "补充授权：可以动 docs/" }),
    (async () => {
      world.childAcks(childId, latestInstructId(world, childId), true, "已入队（mode=followUp）", "received");
    })(),
  ]).then(([r]) => r);

  assert.equal(reply.isError, undefined, replyText(reply));
  assert.equal(reply.details?.delivered, true);
  assert.match(replyText(reply), /已确认收到并入队|跑完手上这一轮/);
});

test("a followUp that was only RECEIVED stays in the child's inbox until it is injected", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  await Promise.all([
    world.call("orchestrator_instruct", { childId, mode: "followUp", message: "稍后读这条" }),
    (async () => {
      world.childAcks(childId, latestInstructId(world, childId), true, "已入队", "received");
    })(),
  ]);

  assert.equal(projectionOf(world, childId).pendingInstructs.length, 1,
    "a received-but-not-injected message must NOT be dropped — that is how the round-4 message was lost");

  world.childAcks(childId, latestInstructId(world, childId), true, "sendUserMessage", "injected");
  assert.equal(projectionOf(world, childId).pendingInstructs.length, 0, "the injection closes it");
});

test("the instruct failure report no longer claims a sidecar that exists is missing", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  const child = world.runtime().children[0]!;
  // The child's gate sidecar IS on disk — the round-4 report said otherwise
  // because the check was never given a cwd.
  world.sidecars.set(child.cwd, { taskMode: "loop" });

  const reply = await world.call("orchestrator_instruct", { childId, mode: "steer", message: "立刻停下手里的事" });

  assert.equal(reply.isError, true, "no ack was ever written, so this must fail");
  assert.match(replyText(reply), /sidecar 存在=是/, "and the evidence it cites must be true");
});

// ---------------------------------------------------------------------------
// Block 4 of the receipt
// ---------------------------------------------------------------------------

test("the wait receipt carries a REAL context reading when the host provides one", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, contextPercent: 83 });
  await spawnT1(world);
  const reply = await world.call("orchestrator_wait", { timeoutMs: 0 });
  const text = replyText(reply);
  assert.match(text, /上下文已用 83%/, "the number is in the receipt, not left for the agent to look up");
  assert.match(text, /接力/, "with the timing call attached to it");
  assert.equal(reply.details?.handoffUrgency, "soon");
});

test("and stays honest when there is genuinely no reading", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await spawnT1(world);
  const reply = await world.call("orchestrator_wait", { timeoutMs: 0 });
  assert.match(replyText(reply), /宿主未提供读数/, "a missing measurement is never reported as room to spare");
  assert.equal(reply.details?.handoffUrgency, "none");
});

test("the four bands are a function of BOTH numbers — questions come before a handover", () => {
  assert.equal(handoffAdvice({ percent: 40, openRequests: 0 }).urgency, "none");
  assert.equal(handoffAdvice({ percent: 85, openRequests: 0 }).urgency, "soon");
  assert.match(handoffAdvice({ percent: 85, openRequests: 2 }).line, /先处理完这 2 个待答请求/);
  assert.equal(handoffAdvice({ percent: 95, openRequests: 0 }).urgency, "now");
  assert.match(handoffAdvice({ percent: 95, openRequests: 1 }).line, /先把这 1 个待答请求回掉/);
});

test("the usage reading understands pi's ACTUAL shape — and the fallback really fires", () => {
  // pi returns { tokens, contextWindow, percent }. The first version of this
  // read `used`/`max`, which pi has never had: the fallback it was supposed to
  // provide could not fire, and a missing fallback renders identically to an
  // unused one (both produce the honest "no reading" line). Hence one case per
  // shape.
  assert.equal(contextPercentFromUsage({ tokens: 100, contextWindow: 200, percent: 50 }), 50);
  assert.equal(
    contextPercentFromUsage({ tokens: 50_000, contextWindow: 200_000, percent: null }),
    25,
    "percent is null right after a compaction — THIS is when the fallback matters",
  );
  assert.equal(contextPercentFromUsage({ tokens: null, contextWindow: 200_000, percent: null }), undefined,
    "an unknown token count is not a zero token count");
  assert.equal(contextPercentFromUsage({ tokens: 10, contextWindow: 0, percent: null }), undefined);
  assert.equal(contextPercentFromUsage(undefined), undefined);
  assert.equal(contextPercentFromUsage({ used: 100, max: 200 }), undefined,
    "the fields the old code invented must not silently start working either");
});


/** The id of the newest instruction on a child's channel. */
function latestInstructId(world: FakeWorld, childId: string): string {
  const instructs = world.channelOf(childId).filter((r) => r.kind === "instruct");
  const last = instructs[instructs.length - 1];
  assert.ok(last && last.kind === "instruct", "the tool must have written an instruction first");
  return last.instructId;
}
