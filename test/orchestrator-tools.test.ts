/**
 * The ORCHESTRATION TOOLS, driven end to end against the fake world.
 *
 * These are PROTOCOL tests, not unit tests: they call the real registered
 * tools and then assert on observable state — what is in the plan, what the
 * registry holds, which argv a pane was started with, what is in the child's
 * CHANNEL. Nothing is asserted about which functions were called, and nothing
 * here needs a tmux server, a pi process or a disk.
 *
 * The 2026-08-30 rewrite changed what is observable, and that is the point:
 * where a test used to draw a screen and press arrow keys, it now appends a
 * request record and calls `orchestrator_answer`. Every defect the old
 * screen-based tests existed to prevent (R-1, R-8, R-12, R-13, R-20, F6) is
 * prevented by CONSTRUCTION now — there is no parse to get wrong and no key
 * to send — so those tests are gone with the code they covered.
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
  type FakeWorld,
} from "./helpers/fake-orchestration.ts";
import { ORCHESTRATION_ID_ENV } from "../lib/orchestration-id.ts";
import { GATE_MODE_ENV } from "../lib/task-mode.ts";

/** The 10 tools an orchestrator gets, and nothing else. */
const ORCHESTRATION_TOOLS = [
  "orchestrator_plan",
  "orchestrator_notify",
  "orchestrator_spawn",
  "orchestrator_instruct",
  "orchestrator_wait",
  "orchestrator_answer",
  "orchestrator_close",
  "orchestrator_recover",
  "orchestrator_attach",
  "orchestrator_handoff",
];

/** Spawn t1 and return its registry handle. */
async function spawnT1(world: FakeWorld): Promise<string> {
  const reply = await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  assert.equal(reply.isError, undefined, replyText(reply));
  const child = world.runtime().children[0];
  assert.ok(child, "the spawn must register a child");
  return child!.id;
}

/**
 * The fake child's gate boots and reports by itself during a spawn (see
 * `makeFakeWorld`), so most tests need nothing extra. This helper exists for
 * the cases that report AGAIN after doing something.
 */
function readyChild(world: FakeWorld, childId: string): void {
  world.childReports(childId, "working");
}


test("the ten orchestration tools are registered, and the deleted ones are not", () => {
  const world = makeFakeWorld();
  for (const name of ORCHESTRATION_TOOLS) {
    assert.ok(world.tools.has(name), `${name} must be registered`);
  }
  assert.equal(world.tools.size, ORCHESTRATION_TOOLS.length,
    `exactly ${ORCHESTRATION_TOOLS.length} orchestration tools: ${[...world.tools.keys()].join(", ")}`);
  // Philosophy three: the replaced tools are GONE, not deprecated.
  for (const gone of ["orchestrator_read", "orchestrator_key", "orchestrator_status", "orchestrator_send", "orchestrator_relay"]) {
    assert.equal(world.tools.has(gone), false, `${gone} must no longer exist`);
  }
});

test("every tool refuses outside orchestrator mode", async () => {
  const world = makeFakeWorld({ taskMode: "loop" });
  for (const name of ORCHESTRATION_TOOLS) {
    const reply = await world.call(name, { childId: "c1", taskId: "t1", answer: "x", orchestrationId: "orch-a-b", handoffPath: "docs/h.md" });
    assert.equal(reply.isError, true, `${name} must refuse in loop mode`);
    assert.match(replyText(reply), /orchestrator（项目经理）模式|orchestrator 模式/);
  }
});

// ---------------------------------------------------------------------------
// plan (unchanged by the channel rewrite, still the spawn authorization)
// ---------------------------------------------------------------------------

test("writing a plan does NOT approve it; the user's dialog does", async () => {
  const world = makeFakeWorld();
  const written = await world.call("orchestrator_plan", { action: "write", plan: twoTaskPlan() });
  assert.equal(written.isError, undefined, replyText(written));
  assert.equal(world.runtime().approvedPlanHash, undefined, "writing must not approve");

  world.confirmAnswers.push(true);
  const submitted = await world.call("orchestrator_plan", { action: "submit" });
  assert.equal(submitted.isError, undefined, replyText(submitted));
  assert.ok(world.runtime().approvedPlanHash, "the user's yes is what approves it");
});

test("CONSTRAINT 1: spawning without an approved plan is refused", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan() });
  const reply = await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  assert.equal(reply.isError, true);
  assert.equal(world.panes.size, 1, "no pane may be opened without an approved plan");
});

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

test("a spawn registers the pane, injects the address, and starts pi with a task FILE", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  readyChild(world, childId);

  const child = world.runtime().children[0]!;
  const pane = world.panes.get(child.paneId)!;
  assert.equal(pane.env[ORCHESTRATION_ID_ENV], world.runtime().orchestrationId,
    "the child is addressed to the ORCHESTRATION, so a handoff never retires its channel");
  assert.equal(pane.env[GATE_MODE_ENV], "loop", "a child session is an ordinary loop session");
  // F7/F8 — the task rides in on the argv as a file, never through a keyboard.
  assert.ok(pane.command.some((arg) => arg.startsWith("@")), `task file argv: ${pane.command.join(" ")}`);
  assert.ok(pane.command.includes("--session-id"), "a deterministic session id is what makes recovery possible");
  const taskArg = pane.command.find((arg) => arg.startsWith("@"))!;
  assert.match(world.scratch.get(taskArg.slice(1)) ?? "", /做任务一/);
});

test("a spawn is only reported as delivered once the child's gate REPORTS", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, autoReport: false });
  // No channel record and no sidecar: the pane opened, but nothing proves the
  // session started. F8 — the receipt is earned, never assumed.
  const reply = await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  assert.equal(reply.isError, true, replyText(reply));
  assert.match(replyText(reply), /通道里一条记录都没有/);
  assert.equal(world.plan()!.tasks.find((t) => t.id === "t1")!.status, "pending",
    "an unconfirmed spawn returns its task to pending instead of leaving it running");
  assert.equal(world.runtime().children.length, 1, "the child registration is KEPT — never kill a session that may be alive");
});

test("CONSTRAINT 6: a task overlapping a running one is refused with the scheduler's reason", async () => {
  const plan = twoTaskPlan();
  // Make t2 overlap t1's boundary.
  const overlapping = { ...plan, tasks: [plan.tasks[0]!, { ...plan.tasks[1]!, fileBoundaries: ["lib/a/"] }] };
  const world = makeFakeWorld({ plan: overlapping, approvePlan: true });
  const c1 = await spawnT1(world);
  readyChild(world, c1);
  const second = await world.call("orchestrator_spawn", { taskId: "t2", task: "做任务二" });
  assert.equal(second.isError, true, replyText(second));
});

// ---------------------------------------------------------------------------
// wait — the ONE information channel
// ---------------------------------------------------------------------------

test("waiting with NOTHING to wait for is refused, not reported as a dead child", async () => {
  const world = makeFakeWorld();
  const reply = await world.call("orchestrator_wait", {});
  assert.equal(reply.isError, true);
  assert.equal(reply.details?.reason, "no-children");
});

test("timeoutMs:0 is the snapshot that replaced orchestrator_status — same four blocks", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, contextPercent: 12 });
  const childId = await spawnT1(world);
  readyChild(world, childId);

  const reply = await world.call("orchestrator_wait", { timeoutMs: 0 });
  const text = replyText(reply);
  assert.match(text, /### 1\. 子会话健康快照/);
  assert.match(text, /### 2\. 待答请求/);
  assert.match(text, /### 3\. 死亡与恢复/);
  assert.match(text, /### 4\. 你自己的上下文与接力时机/);
  assert.match(text, /### 5\. 还差什么才能收尾/);
  assert.match(text, /上下文已用 12%/);
});

test("an unanswered question is in the receipt IN FULL — title, every option, and the payload", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childAsks(childId, {
    requestId: "req-1",
    title: "基准分支用哪个？",
    options: ["用 main", "拉一条 dev 分支"],
    payload: "工作区有 3 个未提交改动",
  });

  const reply = await world.call("orchestrator_wait", { timeoutMs: 0 });
  const text = replyText(reply);
  assert.match(text, /基准分支用哪个？/);
  assert.match(text, /1\. 用 main/);
  assert.match(text, /2\. 拉一条 dev 分支/);
  assert.match(text, /工作区有 3 个未提交改动/, "the payload rides along — nothing is read off a screen");
  assert.equal(reply.details?.openRequests, 1);
});

test("the handoff advice is COMPUTED and pushed, and it knows about pending questions", async () => {
  const withRoom = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, contextPercent: 50 });
  const c1 = await spawnT1(withRoom);
  readyChild(withRoom, c1);
  assert.equal((await withRoom.call("orchestrator_wait", { timeoutMs: 0 })).details?.handoffUrgency, "none");

  const nearlyFull = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, contextPercent: 84 });
  const c2 = await spawnT1(nearlyFull);
  readyChild(nearlyFull, c2);
  const clean = await nearlyFull.call("orchestrator_wait", { timeoutMs: 0 });
  assert.equal(clean.details?.handoffUrgency, "soon");
  assert.match(replyText(clean), /现在是接力的好时机/);

  nearlyFull.childAsks(c2, { requestId: "r", title: "问题", options: ["A", "B"] });
  const busy = await nearlyFull.call("orchestrator_wait", { timeoutMs: 0 });
  assert.match(replyText(busy), /先处理完这 1 个待答请求再接力/);
});

test("a vanished pane is `dead`, and the receipt names the assets that survived it", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  readyChild(world, childId);
  const child = world.runtime().children[0]!;
  world.sidecars.set(child.cwd, { workBranch: "feat/t1", review: { verdict: "READY" } });
  world.panes.get(child.paneId)!.alive = false;

  const reply = await world.call("orchestrator_wait", { timeoutMs: 0 });
  const text = replyText(reply);
  assert.match(text, /pane 已消失/);
  assert.match(text, /feat\/t1/, "the branch survived the death and must be named in the same breath");
  assert.match(text, /review 裁决 READY/);
  assert.match(text, /orchestrator_recover/, "the receipt carries the executable recovery action");
});

test("an unreadable pane list is UNKNOWN liveness, never a dead child (F14)", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, tmuxBroken: true });
  // The spawn cannot register a pane when tmux is broken, so drive the wait
  // through a child registered while tmux worked.
  const working = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(working);
  readyChild(working, childId);
  void world;

  const reply = await working.call("orchestrator_wait", { timeoutMs: 0 });
  assert.doesNotMatch(replyText(reply), /pane 已消失/);
});

// ---------------------------------------------------------------------------
// answer — the tool that replaced read + key
// ---------------------------------------------------------------------------

test("answering writes the answer into the channel, by text or by 1-based index", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childAsks(childId, { requestId: "req-1", title: "选一个", options: ["方案 A", "方案 B"] });

  const reply = await world.call("orchestrator_answer", { childId, answer: "2" });
  assert.equal(reply.isError, undefined, replyText(reply));
  const answers = world.channelOf(childId).filter((r) => r.kind === "answer");
  assert.equal(answers.length, 1);
  assert.equal((answers[0] as { answer: string }).answer, "方案 B", "an index resolves to the row's TEXT");
});

test("an AMBIGUOUS answer is refused, never guessed", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childAsks(childId, { requestId: "req-1", title: "选一个", options: ["接受改动", "接受改动并提交"] });

  const reply = await world.call("orchestrator_answer", { childId, answer: "接受改动" });
  assert.equal(reply.isError, undefined, "an exact match wins over the ambiguity rule");

  const world2 = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const c2 = await spawnT1(world2);
  world2.childAsks(c2, { requestId: "req-1", title: "选一个", options: ["方案 A 保留", "方案 A 丢弃"] });
  const ambiguous = await world2.call("orchestrator_answer", { childId: c2, answer: "方案 A" });
  assert.equal(ambiguous.isError, true);
  assert.match(replyText(ambiguous), /同时匹配 2 个选项/);
  assert.equal(world2.channelOf(c2).filter((r) => r.kind === "answer").length, 0, "nothing may be written on a refusal");
});

test("a question the USER already answered is reported as settled, not answered twice", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childAsks(childId, { requestId: "req-1", title: "选一个", options: ["A", "B"] });
  world.childSettles(childId, "req-1", "human");

  const reply = await world.call("orchestrator_answer", { childId, answer: "A" });
  assert.equal(reply.isError, true);
  assert.match(replyText(reply), /没有待答的问题/);
});

test("two open questions require the requestId — the gate never picks one for you", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childAsks(childId, { requestId: "req-1", title: "问题一", options: ["A"] });
  world.childAsks(childId, { requestId: "req-2", title: "问题二", options: ["B"] });

  const vague = await world.call("orchestrator_answer", { childId, answer: "A" });
  assert.equal(vague.isError, true);
  assert.match(replyText(vague), /必须指明 requestId/);

  const precise = await world.call("orchestrator_answer", { childId, requestId: "req-2", answer: "B" });
  assert.equal(precise.isError, undefined, replyText(precise));
});

test("CONSTRAINT 8 / R-7: a goal approval is judged on the CHILD's own draft and its edited files", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  const child = world.runtime().children[0]!;
  world.childAsks(childId, {
    requestId: "goal-1",
    title: "认可这个 loop goal 吗？",
    options: ["认可，写入 .pi/loop-goal.md", "不认可，退回重谈"],
    payload: "# 目标\n只改 lib/a/ 下的东西",
    topic: "goal-approval",
  });

  // Inside the boundary → approved.
  world.sidecars.set(child.cwd, { sessionEditedFiles: ["lib/a/one.ts"] });
  const ok = await world.call("orchestrator_answer", { childId, answer: "认可，写入 .pi/loop-goal.md" });
  assert.equal(ok.isError, undefined, replyText(ok));

  // Outside it → refused as a scope change.
  const world2 = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const c2 = await spawnT1(world2);
  const child2 = world2.runtime().children[0]!;
  world2.childAsks(c2, {
    requestId: "goal-2",
    title: "认可这个 loop goal 吗？",
    options: ["认可，写入 .pi/loop-goal.md", "不认可，退回重谈"],
    payload: "# 目标",
    topic: "goal-approval",
  });
  world2.sidecars.set(child2.cwd, { sessionEditedFiles: ["lib/b/other.ts"] });
  const refused = await world2.call("orchestrator_answer", { childId: c2, answer: "认可，写入 .pi/loop-goal.md" });
  assert.equal(refused.isError, true, replyText(refused));
  assert.equal(world2.channelOf(c2).filter((r) => r.kind === "answer").length, 0);
});

test("a goal-approval request with no draft attached is REFUSED rather than approved blind", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childAsks(childId, {
    requestId: "goal-1",
    title: "认可这个 loop goal 吗？",
    options: ["认可，写入 .pi/loop-goal.md", "不认可"],
    topic: "goal-approval",
  });
  const reply = await world.call("orchestrator_answer", { childId, answer: "认可，写入 .pi/loop-goal.md" });
  assert.equal(reply.isError, true);
  assert.match(replyText(reply), /没有带上 goal 全文/);
});

// ---------------------------------------------------------------------------
// instruct — the tool that replaced send-keys
// ---------------------------------------------------------------------------

test("an instruction is written to the channel and only claimed once the child ACKNOWLEDGES it", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  readyChild(world, childId);

  // No acknowledgement yet ⇒ the delivery FAILS. Writing is not delivering.
  const unacked = await world.call("orchestrator_instruct", { childId, message: "换个思路", mode: "followUp" });
  assert.equal(unacked.isError, true, replyText(unacked));
  assert.match(replyText(unacked), /一直没有回执/);

  // Now play the child's side: acknowledge the pending instruction.
  const pending = projectionOf(world, childId).pendingInstructs;
  assert.equal(pending.length, 1, "the instruction is on the channel even though the receipt failed");
  world.childAcks(childId, pending[0]!.instructId, true, "pi.sendUserMessage(deliverAs:followUp)");

  const second = await world.call("orchestrator_instruct", { childId, message: "再来一次", mode: "steer" });
  // The second instruction has its own id and its own (missing) ack.
  assert.equal(second.isError, true, "each instruction earns its own receipt");
});

test("an instruction the child could NOT inject is a failure carrying the child's own reason", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  readyChild(world, childId);
  // Pre-acknowledge every instruction as failed, by acking as soon as it appears.
  const originalIO = world.deps.channelIO();
  const spy = {
    ...originalIO,
    appendLine(path: string, line: string) {
      originalIO.appendLine(path, line);
      const parsed = JSON.parse(line) as { kind?: string; instructId?: string };
      if (parsed.kind === "instruct" && parsed.instructId) {
        world.childAcks(childId, parsed.instructId, false, "会话已经结束了");
      }
    },
  };
  (world.deps as { channelIO: () => typeof spy }).channelIO = () => spy;

  const reply = await world.call("orchestrator_instruct", { childId, message: "在吗", mode: "followUp" });
  assert.equal(reply.isError, true);
  assert.match(replyText(reply), /会话已经结束了/);
});

test("interrupt needs no text; every other mode does; an unknown mode is refused", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  readyChild(world, childId);

  const bad = await world.call("orchestrator_instruct", { childId, mode: "nextTurn", message: "x" });
  assert.equal(bad.isError, true);
  assert.match(replyText(bad), /steer \/ followUp \/ interrupt/);

  const empty = await world.call("orchestrator_instruct", { childId, mode: "steer" });
  assert.equal(empty.isError, true);
  assert.match(replyText(empty), /要发的内容是空的/);
});

// ---------------------------------------------------------------------------
// close / recover / attach / handoff
// ---------------------------------------------------------------------------

test("CONSTRAINT 13: only a child the GATE spawned is addressable at all", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  for (const name of ["orchestrator_answer", "orchestrator_instruct", "orchestrator_recover", "orchestrator_close"]) {
    const reply = await world.call(name, { childId: "somebody-elses-pane", answer: "x", message: "x" });
    assert.equal(reply.isError, true, `${name} must refuse an unregistered child`);
  }
});

test("recover refuses while the pane is ALIVE, and re-opens the same session id when it is not", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  readyChild(world, childId);
  const before = world.runtime().children[0]!;

  const tooEarly = await world.call("orchestrator_recover", { childId });
  assert.equal(tooEarly.isError, true, "two processes in one worktree is worse than a stuck child");

  world.panes.get(before.paneId)!.alive = false;
  const recovered = await world.call("orchestrator_recover", { childId, reason: "被误杀" });
  assert.equal(recovered.isError, undefined, replyText(recovered));
  const after = world.runtime().children[0]!;
  assert.notEqual(after.paneId, before.paneId, "the registry is re-pointed at the NEW pane");
  assert.equal(after.id, before.id, "the child KEEPS its identity — nothing about it died");
  const pane = world.panes.get(after.paneId)!;
  assert.ok(pane.command.includes("--session-id"), "the transcript continues rather than starting over");
  assert.equal(
    pane.command[pane.command.indexOf("--session-id") + 1],
    `rg-child-${childId}`,
    "the SAME deterministic session id",
  );
  assert.equal(world.plan()!.tasks.find((t) => t.id === "t1")!.status, "running",
    "the task never stopped being true");
});

test("attach hands back the plan, the children, the open questions and the ORPHANS", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childAsks(childId, { requestId: "req-1", title: "在等你", options: ["A"] });
  world.panes.get(world.runtime().children[0]!.paneId)!.alive = false;

  const reply = await world.call("orchestrator_attach", { orchestrationId: world.runtime().orchestrationId });
  assert.equal(reply.isError, undefined, replyText(reply));
  const text = replyText(reply);
  assert.match(text, /测试计划/);
  assert.match(text, /在等你/, "questions still waiting are handed over, not lost");
  assert.match(text, /### 4\. 孤儿任务/);
  assert.match(text, /任务 t1/, "a task marked running with no live pane is an orphan");
  assert.equal(reply.details?.orphans, 1);
});

test("attach refuses an orchestration this session does not carry", async () => {
  const world = makeFakeWorld();
  const wrong = await world.call("orchestrator_attach", { orchestrationId: "orch-11111111-zzz" });
  assert.equal(wrong.isError, true);
  assert.match(replyText(wrong), /不能在运行中改换编排身份/);

  const malformed = await world.call("orchestrator_attach", { orchestrationId: "not-an-id" });
  assert.equal(malformed.isError, true);
});

test("closing is limited to registered panes and returns the task to pending", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  readyChild(world, childId);
  const paneId = world.runtime().children[0]!.paneId;

  const reply = await world.call("orchestrator_close", { childId });
  assert.equal(reply.isError, undefined, replyText(reply));
  assert.equal(world.panes.get(paneId)!.alive, false);
  assert.ok(world.runtime().children[0]!.closedAt, "the registry records the close");
});

test("CONSTRAINT 12: only a successor may close a predecessor pane", async () => {
  const world = makeFakeWorld();
  const reply = await world.call("orchestrator_close", { predecessorPane: "%9" });
  assert.equal(reply.isError, true, "a session that is not a successor may not close anybody");
});

test("handoff refuses without a handoff document, and opens the successor when it has one", async () => {
  const bare = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const refused = await bare.call("orchestrator_handoff", {});
  assert.equal(refused.isError, true);

  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const reply = await world.call("orchestrator_handoff", { handoffPath: "docs/orchestrator-handoff.md" });
  assert.equal(reply.isError, undefined, replyText(reply));
  const successor = [...world.panes.values()].find((p) => p.env[GATE_MODE_ENV] === "orchestrator");
  assert.ok(successor, "the successor pane is opened by the gate");
  assert.equal(successor!.env[ORCHESTRATION_ID_ENV], world.runtime().orchestrationId,
    "the successor INHERITS the orchestration id, so no child has to be restarted");
});

// ---------------------------------------------------------------------------
// notify (unchanged; the only channel that reaches a human who is elsewhere)
// ---------------------------------------------------------------------------

test("notify writes once and is then throttled", async () => {
  const world = makeFakeWorld();
  const first = await world.call("orchestrator_notify", { title: "要你拍板", body: "有个不可逆的决定" });
  assert.equal(first.isError, undefined, replyText(first));
  const second = await world.call("orchestrator_notify", { title: "要你拍板", body: "有个不可逆的决定" });
  assert.match(replyText(second), /节流|throttl/i);
});
