/**
 * A child that ran `session_handoff` (2026-09-26, t7):
 *  - `orchestrator_wait` judges it on its successor's pane in the SAME receipt
 *    that re-pointed the registry, instead of calling it dead in the headline;
 *  - `orchestrator_recover` re-opens the newest `-hN` transcript, not the
 *    predecessor's.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

import { makeFakeWorld, replyText, twoTaskPlan, type FakeWorld } from "./helpers/fake-orchestration.ts";
import { childSessionId, recoverSessionId } from "../lib/orchestrator-delivery.ts";

async function spawnT1(world: FakeWorld): Promise<string> {
  const reply = await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  assert.equal(reply.isError, undefined, replyText(reply));
  return world.runtime().children[0]!.id;
}

/** The registered pane dies; the successor reports from a fresh live pane. */
function handOver(world: FakeWorld, childId: string, generation: number, paneId: string): void {
  world.panes.get(world.runtime().children[0]!.paneId)!.alive = false;
  world.panes.set(paneId, { id: paneId, command: [], env: {}, alive: true });
  world.advance(1000);
  world.childReports(childId, "working", { sessionId: `${childSessionId(childId)}-h${generation}`, paneId });
}

for (const scoped of [false, true]) {
  test(`wait${scoped ? " (one child)" : ""}: the receipt that re-points a relayed child does not call it dead`, async () => {
    const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
    const childId = await spawnT1(world);
    handOver(world, childId, 1, "%77");

    const reply = await world.call("orchestrator_wait", { timeoutMs: 0, ...(scoped ? { childId } : {}) });
    const text = replyText(reply);
    assert.equal(world.runtime().children[0]!.paneId, "%77", "the registry follows the successor");
    assert.doesNotMatch(text, /pane 已经消失/, text);
  });
}

test("recover re-opens the newest generation of a handed-over child", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  handOver(world, childId, 1, "%77");
  await world.call("orchestrator_wait", { timeoutMs: 0 });
  handOver(world, childId, 2, "%78");
  await world.call("orchestrator_wait", { timeoutMs: 0 });
  // The predecessor heartbeats once more after its successor's first report.
  world.childReports(childId, "working", { sessionId: `${childSessionId(childId)}-h1`, paneId: "%77" });
  world.panes.get("%78")!.alive = false;

  const recovered = await world.call("orchestrator_recover", { childId });
  assert.equal(recovered.isError, undefined, replyText(recovered));
  const pane = world.panes.get(world.runtime().children[0]!.paneId)!;
  const expected = `${childSessionId(childId)}-h2`;
  assert.equal(pane.command[pane.command.indexOf("--session-id") + 1], expected);
  assert.match(replyText(recovered), new RegExp(expected));
});

test("recoverSessionId: highest generation of THIS chain, root when nothing handed over", () => {
  const root = childSessionId("c1");
  assert.equal(recoverSessionId("c1", []), root);
  assert.equal(recoverSessionId("c1", [root, undefined]), root);
  assert.equal(recoverSessionId("c1", [root, `${root}-h2`, `${root}-h1`]), `${root}-h2`);
  assert.equal(
    recoverSessionId("c1", [`${childSessionId("c2")}-h5`, "3f0c6a8e-1b2c-4d5e-8f90-123456789abc", `${root}-h1`]),
    `${root}-h1`,
    "a sibling's successor and a subagent's uuid are not this child",
  );
});
