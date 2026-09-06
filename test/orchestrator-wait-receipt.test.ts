/**
 * ONE RECEIPT, ONE TRUTH — the two defects the first end-to-end orchestration
 * run measured on 2026-09-04, driven through the real tools.
 *
 * B3: a child in the middle of a read-only investigation reported `idle` (its
 * host is idle BETWEEN two tool calls), and the supervisor printed "停下了
 * （没有 declare_done）" with "最后活动 0s 前" on the same line while the
 * child's transcript grew 23.7KB in 45 seconds. The manager interrupted it
 * twice, and — because `idle` is newsworthy — every `orchestrator_wait`
 * returned instantly, which turned the supervisor's one waiting tool into a
 * busy poll.
 *
 * B4: the same receipt said "已完成" in block 1 and "还有 1 个子会话活着" in
 * block 5, because block 1 read the child's CHANNEL and block 5 read a
 * registry field that nothing had written since the old probe was deleted.
 *
 * These are end-to-end on purpose. Both defects are about what ONE reply says
 * about ONE child, and each half is correct in isolation — the failure only
 * exists where the blocks meet.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

import { makeFakeWorld, replyText, twoTaskPlan, type FakeWorld } from "./helpers/fake-orchestration.ts";
import { IDLE_PROGRESS_GRACE_MS } from "../lib/orchestrator-child-state.ts";
import { markChildAssigned } from "../lib/orchestrator-registry.ts";

async function spawnT1(world: FakeWorld): Promise<string> {
  const reply = await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  assert.equal(reply.isError, undefined, replyText(reply));
  const child = world.runtime().children[0];
  assert.ok(child, "the spawn must register a child");
  return child!.id;
}

const iso = (world: FakeWorld, offsetMs = 0) => new Date(world.now() + offsetMs).toISOString();

// ---------------------------------------------------------------------------
// B3 — a child that is turning the crank is not a child that stopped
// ---------------------------------------------------------------------------

test("B3: an `idle` report with fresh progress reads as working, and does not wake the manager", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  // Exactly what the measured child wrote: its host was idle between two tool
  // calls, but it had stepped forward 3 seconds ago.
  world.childReports(childId, "idle", { lastProgressAt: iso(world, -3_000), contextPercent: 24 });

  const reply = await world.call("orchestrator_wait", { timeoutMs: 0 });
  const text = replyText(reply);
  assert.match(text, /在干活/);
  assert.match(text, /自上次推进 3s/);
  assert.match(text, /自报停下/, "the overruled report stays visible — it is not hidden for two minutes");
  assert.doesNotMatch(text, /停下了（没有 declare_done）/,
    "this is the line that got a working child interrupted twice");

  // The busy-poll half of B3: a `working` child is not newsworthy, so a wait
  // that blocks has nothing to return early with.
  const details = reply.details as { done: boolean; reason: string } | undefined;
  assert.equal(details?.done, false, "nothing newsworthy happened — the wait must keep waiting");
});

test("B3: past the 120s grace the child's own `idle` is believed again", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childReports(childId, "idle", { lastProgressAt: iso(world, -IDLE_PROGRESS_GRACE_MS) });

  const text = replyText(await world.call("orchestrator_wait", { timeoutMs: 0 }));
  assert.match(text, /停下了（没有 declare_done）/,
    "a child that really has not moved for two minutes must still be reported as stopped");
});

// ---------------------------------------------------------------------------
// B4 — the completion and the wrap-up block read the same snapshot
// ---------------------------------------------------------------------------

test("B4: one receipt never says a child is finished AND still to be waited for", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childReports(childId, "done");

  const text = replyText(await world.call("orchestrator_wait", { timeoutMs: 0 }));

  // Block 1 — the health snapshot, from the channel.
  assert.match(text, new RegExp(`${childId}：已完成`));
  // Block 5 — the wrap-up, from the SAME reading.
  assert.match(text, /已报完成、pane 还开着/);
  assert.match(text, /待你复验后/, "the manager is told what is left to do, not just what is blocked");
  assert.match(text, /set-status/);
  assert.match(text, /orchestrator_close/);
  assert.doesNotMatch(text, /还有 1 个子会话活着/,
    "THE measured contradiction: block 5 called the finished child 'alive, go wait for it'");
  // Its plan line names the same fact rather than a bare `running`.
  assert.match(text, /t1\(running，孩子已报完成/);
});

test("B4: the gate does NOT close the task itself, and the child still blocks the exit", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childReports(childId, "done");

  const text = replyText(await world.call("orchestrator_wait", { timeoutMs: 0 }));

  // The manager's own re-verification is the contract (user decision,
  // 2026-09-17): a gate that flips the task to `done` would hollow it out.
  assert.equal(world.plan()!.tasks.find((t) => t.id === "t1")!.status, "running",
    "only the manager may declare a task done");
  assert.match(text, /门禁不替你标 done/);
  // And "it said it finished" is not "the pane is closed": the exit stays shut
  // (user decision — same behaviour as before, minus the contradiction).
  assert.doesNotMatch(text, /没有了，可以 declare_done/);
});

test("B4: a child that finished and THEN lost its pane is not called '从未报告完成'", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  const child = world.runtime().children[0]!;
  world.childReports(childId, "done");
  // The pane goes away after the completion — the human closed it, or the
  // session exited. Its STATE is `dead` (a corpse is the headline a
  // supervisor must see), but it is still a child that finished.
  world.panes.get(child.paneId)!.alive = false;

  const text = replyText(await world.call("orchestrator_wait", { timeoutMs: 0 }));
  assert.doesNotMatch(text, /从未报告完成/,
    "it DID report — telling the manager to reset the task to pending would throw the work away");
  assert.doesNotMatch(text, /必要时把任务改回 pending 重开/);
  // The task line still carries the completion, which is what the manager acts on.
  assert.match(text, /t1\(running，孩子已报完成/);
});


test("B4: a re-tasked child is not reported finished on the strength of its old completion", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childReports(childId, "done");
  assert.match(replyText(await world.call("orchestrator_wait", { timeoutMs: 0 })), /已报完成、pane 还开着/);

  // Round-1 P1, and the reason a completion is bounded by the assignment
  // stamp: give it new work, and the OLD completion stops being evidence.
  world.advance(60_000);
  world.saveRuntime(markChildAssigned(world.runtime(), childId, new Date(world.now()).toISOString()));
  world.advance(1_000);
  world.childReports(childId, "working", { lastProgressAt: iso(world) });

  const text = replyText(await world.call("orchestrator_wait", { timeoutMs: 0 }));
  assert.doesNotMatch(text, /已报完成、pane 还开着/,
    "a completion older than the current assignment belongs to the previous task");
});

// ---------------------------------------------------------------------------
// F14 — an unreadable tmux is missing information, not a graveyard
// ---------------------------------------------------------------------------

test("F14: when `list-panes` cannot be read the wrap-up claims no deaths", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childReports(childId, "working", { lastProgressAt: iso(world) });
  // tmux breaks AFTER the child was registered — the situation the old code
  // turned into "every pane is gone" by passing an empty pane list.
  world.options.tmuxBroken = true;

  const text = replyText(await world.call("orchestrator_wait", { timeoutMs: 0 }));
  assert.doesNotMatch(text, /pane 已经消失/, "an unreadable pane list is not a death certificate");
  assert.match(text, /存活状态未知/);
  assert.match(text, /F14/);
  assert.doesNotMatch(text, /没有了，可以 declare_done/,
    "unknown liveness blocks the exit rather than opening it");
});
