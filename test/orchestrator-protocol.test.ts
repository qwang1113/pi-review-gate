/**
 * PROTOCOL-LEVEL tests for the orchestration layer.
 *
 * The previous round shipped this layer with 1867 green unit tests and it
 * deadlocked on the first hop of the first real run. Every defect lived in the
 * seam between a decision and the world, and a unit test that stubs
 * `tmux() → ok` cannot see a seam. These tests drive the REAL tools against a
 * simulated tmux whose panes behave like panes (test/helpers/fake-orchestration.ts):
 * text typed into one appears on its screen only after an Enter, a dialog moves
 * its highlight only when arrow keys arrive, a pane that was never given a
 * command shows nothing.
 *
 * They are named after the defects they would have caught, so a regression
 * report reads as an English sentence.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ORCHESTRATION_ID_ENV } from "../lib/orchestration-id.ts";
import { GATE_MODE_ENV } from "../lib/task-mode.ts";
import { STATE_VARIANT_ENV } from "../lib/gate-state.ts";
import { PREDECESSOR_PANE_ENV, HANDOFF_PATH_ENV } from "../lib/orchestrator-relay.ts";
import { fakeOrchestration, replyText as text, samplePlan } from "./helpers/fake-orchestration.ts";

/** Spawn task `a` and hand back the harness plus the registered child. */
async function spawned(options: Parameters<typeof fakeOrchestration>[0] = {}) {
  const h = fakeOrchestration({ plan: samplePlan(), approved: true, ...options });
  const reply = await h.call("orchestrator_spawn", { taskId: "a", task: "把 lib/plan 拆出来" });
  return { h, reply, child: h.runtime().children[0] };
}

// ---------------------------------------------------------------------------
// The whole chain — the thing that did not work at all
// ---------------------------------------------------------------------------

test("PROTOCOL: spawn → wait → read → answer a NON-default option → close, unattended", async () => {
  const { h, reply, child } = await spawned();
  assert.notEqual(reply.isError, true, "the spawn itself succeeded");
  assert.equal(reply.details?.delivered, true, "and its delivery was verified, not assumed");

  // The child asks something the gate knows nothing about, and rings the bell.
  h.openDialog(child!.paneId, "先跑哪一步？", ["先补测试", "先改实现", "先问用户"], 0);
  h.pushAttention({ toSessionId: "orch-abc-1", fromPane: child!.paneId, reason: "等待回答提问" });

  const waited = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(waited.details?.done, true);
  assert.equal(waited.details?.reason, "attention");
  assert.match(text(waited), /orchestrator_read/, "the wake-up points at the tool that shows the question");

  // F3 — the question itself is readable, options and highlight included.
  const read = await h.call("orchestrator_read", { childId: child!.id });
  assert.match(text(read), /先跑哪一步？/);
  assert.match(text(read), /1\. 先补测试/);
  assert.match(text(read), /3\. 先问用户/);
  assert.equal(read.details?.selectedIndex, 1, "the highlight is on the default row");

  // F6 — answer the THIRD option. Hitting Enter would have taken the first.
  const answered = await h.call("orchestrator_key", { childId: child!.id, index: 3 });
  assert.notEqual(answered.isError, true, text(answered));
  assert.equal(answered.details?.submitted, true);
  assert.match(h.render(child!.paneId), /answered: 先问用户/, "the NON-default option really landed");

  const closed = await h.call("orchestrator_close", { childId: child!.id });
  assert.notEqual(closed.isError, true);
  assert.equal(h.panes.get(child!.paneId)!.alive, false);
});

test("F6: `match` picks a row by its text, and an ambiguous match is refused, not guessed", async () => {
  const { h, child } = await spawned();
  h.openDialog(child!.paneId, "选一个", ["保留 A", "保留 B", "全部丢弃"], 0);

  const ambiguous = await h.call("orchestrator_key", { childId: child!.id, match: "保留" });
  assert.equal(ambiguous.isError, true);
  assert.match(text(ambiguous), /歧义不猜/);
  assert.match(h.render(child!.paneId), /选一个/, "nothing was submitted");

  const precise = await h.call("orchestrator_key", { childId: child!.id, match: "全部丢弃" });
  assert.notEqual(precise.isError, true, text(precise));
  assert.match(h.render(child!.paneId), /answered: 全部丢弃/);
});

test("F6: a low-level key press is offered as a fallback and never claims a hit", async () => {
  const { h, child } = await spawned();
  h.openDialog(child!.paneId, "确定吗", ["Yes", "No"], 0);

  const bad = await h.call("orchestrator_key", { childId: child!.id, keys: ["escpae"] });
  assert.equal(bad.isError, true, "an unknown key name is refused, not typed as text");

  const escaped = await h.call("orchestrator_key", { childId: child!.id, keys: ["escape"] });
  assert.notEqual(escaped.isError, true);
  assert.match(text(escaped), /没有「命中校验」可做/, "the low-level path is honest about what it does not know");
  assert.match(h.render(child!.paneId), /dialog dismissed/);
});

// ---------------------------------------------------------------------------
// F7 / F8 — the receipt must be earned
// ---------------------------------------------------------------------------

test("F8: a child that never starts is reported as a FAILURE, its task returned to pending", async () => {
  const { h, reply, child } = await spawned({ childStarts: false });
  assert.equal(reply.isError, true, "no evidence of a running child ⇒ no receipt");
  assert.equal(reply.details?.delivered, false);
  assert.equal(h.plan()!.tasks[0]!.status, "pending", "the task can be picked up again");
  assert.ok(child, "the child stays REGISTERED so it can be inspected");
  assert.equal(h.panes.get(child!.paneId)!.alive, true, "and its pane is not killed on suspicion");
  assert.match(text(reply), /orchestrator_read/, "the failure names the next step");
});

test("F7: a long message is delivered as a FILE, and only its path is typed", async () => {
  const { h, child } = await spawned();
  const long = "第一行\n第二行，很长很长".padEnd(400, "。");

  const sent = await h.call("orchestrator_send", { childId: child!.id, message: long });
  assert.notEqual(sent.isError, true, text(sent));
  const typed = h.tmuxCalls.filter((c) => c[0] === "send-keys" && c.includes("-l")).at(-1)!;
  const payload = typed.slice(typed.indexOf("-l") + 1).join(" ");
  assert.ok(!payload.includes("第二行"), "the body never went through the keyboard");
  assert.match(payload, /\/tmp\/rg-orchestration\/tasks\//, "only a path did");
  assert.ok(
    [...h.scratch.values()].some((content) => content.includes("第二行，很长很长")),
    "and the body is on disk in full",
  );
});

test("F7: a message the child never echoed is NOT reported as delivered", async () => {
  const { h, child } = await spawned();
  // The pane stops accepting input (it died between the check and the send).
  h.killPane(child!.paneId);
  const sent = await h.call("orchestrator_send", { childId: child!.id, message: "短消息" });
  assert.equal(sent.isError, true);
});

test("F7: a task file that cannot be written stops the spawn before any pane opens", async () => {
  const h = fakeOrchestration({ plan: samplePlan(), approved: true, scratchBroken: true });
  const reply = await h.call("orchestrator_spawn", { taskId: "a", task: "干活" });
  assert.equal(reply.isError, true);
  assert.deepEqual(h.tmuxCalls.filter((c) => c[0] === "split-window"), []);
});

test("F8: spawning without a task is refused — an empty child IS the deadlock", async () => {
  const h = fakeOrchestration({ plan: samplePlan(), approved: true });
  const reply = await h.call("orchestrator_spawn", { taskId: "a" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /不能为空/);
});

// ---------------------------------------------------------------------------
// F12 / F14 — the waiter
// ---------------------------------------------------------------------------

test("F12: an event from a pane this orchestration never spawned is ignored, not treated as news", async () => {
  const { h } = await spawned();
  h.pushAttention({ toSessionId: "orch-abc-1", fromPane: "%99", reason: "别人的事" });

  const waited = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(waited.details?.done, false, "a foreign event must not end the wait");
  assert.equal(waited.details?.ignored, 1);
  assert.match(text(waited), /不属于本编排/, "and the drop is reported, not swallowed");
});

test("F12: an event whose dialog was already answered means SETTLED, and waiting continues", async () => {
  const { h, child } = await spawned();
  // The human answered the box in the pane themselves: the event was never
  // marked handled, but there is nothing left to answer.
  h.pushAttention({ toSessionId: "orch-abc-1", fromPane: child!.paneId, reason: "等待回答提问" });

  const waited = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(waited.details?.done, false, "事件已销账 ≠ 事情已办成");
});

test("F14: an unreadable pane list is UNKNOWN liveness, never a dead child", async () => {
  const { h } = await spawned();
  h.setTmuxBroken(true);

  const waited = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(waited.details?.done, false);
  assert.notEqual(waited.details?.reason, "pane-gone", "a tmux we cannot read is not a death certificate");
});

test("F14: a wait ALWAYS returns — the budget is spent and reported, never silently held", async () => {
  const { h } = await spawned();
  const waited = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(waited.isError, undefined);
  assert.match(text(waited), /本次预算用完/);
  assert.ok(typeof waited.details?.waitedMs === "number");
});

test("F14: an interrupted wait returns immediately and cancels nothing", async () => {
  const { h } = await spawned();
  const waited = await h.call("orchestrator_wait", { timeoutMs: 900_000, __signal: { aborted: true } });
  assert.equal(waited.details?.reason, "aborted");
  assert.match(text(waited), /子会话还在跑/);
});

test("F14: a dead pane still ends the wait — the child cannot be waited on forever", async () => {
  const { h, child } = await spawned();
  h.killPane(child!.paneId);
  const waited = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(waited.details?.done, true);
  assert.equal(waited.details?.reason, "pane-gone");
});

// ---------------------------------------------------------------------------
// F1 / F5 / O-1 — the smaller ones, end to end
// ---------------------------------------------------------------------------

test("F1: a task stuck in `running` whose child is gone can be re-spawned, with a note", async () => {
  const { h, child } = await spawned();
  assert.equal(h.plan()!.tasks[0]!.status, "running");
  h.killPane(child!.paneId);

  const again = await h.call("orchestrator_spawn", { taskId: "a", task: "重开" });
  assert.notEqual(again.isError, true, text(again));
  assert.equal(h.runtime().children.length, 2, "a fresh child was opened");
  assert.match(h.plan()!.tasks[0]!.note ?? "", /F1/, "and the plan records why it went back to pending");
});

test("F1: a task whose child is still ALIVE is still refused — that guard still does its job", async () => {
  const { h } = await spawned();
  const again = await h.call("orchestrator_spawn", { taskId: "a", task: "再来一次" });
  assert.equal(again.isError, true);
});

test("F5: the gate mints the decision id; the caller only says what the question is", async () => {
  const h = fakeOrchestration({ plan: samplePlan(), approved: true });
  const first = await h.call("orchestrator_plan", { action: "add-decision", question: "要不要丢弃工作区？" });
  assert.notEqual(first.isError, true);
  assert.equal(first.details?.decisionId, "d1");

  const second = await h.call("orchestrator_plan", { action: "add-decision", question: "第二个问题" });
  assert.equal(second.details?.decisionId, "d2", "ids do not collide");
  assert.deepEqual(h.plan()!.decisions.map((d) => d.id), ["d1", "d2"]);
});

test("O-1: the plan approval prints the FULL plan first, and the dialog points at it", async () => {
  const h = fakeOrchestration({ plan: samplePlan() });
  h.confirmAnswers.push(true);
  const submitted = await h.call("orchestrator_plan", { action: "submit" });
  assert.equal(submitted.details?.approved, true);

  assert.equal(h.shown.length, 1, "the plan went to the transcript before the dialog opened");
  const shown = h.shown[0]!;
  assert.match(shown, /抽 plan/, "every task is in the printed text");
  assert.match(shown, /抽 tmux/);
  assert.match(shown, /lib\/tmux/, "boundaries included — the approval binds to them");
});

// ---------------------------------------------------------------------------
// The four paths the first run never reached
// ---------------------------------------------------------------------------

test("ZERO-COVERAGE: a parallel lane gets its own worktree, and closing cleans it up", async () => {
  const { h } = await spawned();
  const parallel = await h.call("orchestrator_spawn", { taskId: "b", task: "并行干活" });
  assert.equal(parallel.details?.execution, "parallel");
  assert.deepEqual(h.worktrees, ["/tmp/wt/b"], "the GATE created it — the agent never ran git");

  const second = h.runtime().children[1]!;
  const split = h.tmuxCalls.filter((c) => c[0] === "split-window").at(-1)!;
  assert.ok(split.includes("/tmp/wt/b"), "the child starts inside its own checkout");
  assert.deepEqual(split.slice(0, 4), ["split-window", "-v", "-t", h.runtime().children[0]!.paneId]);

  await h.call("orchestrator_close", { childId: second.id });
  assert.deepEqual(h.removed, ["/tmp/wt/b"], "and the gate that made it removes it");
});

test("ZERO-COVERAGE: self-relay hands over the address, and only the successor may close the old pane", async () => {
  const { h } = await spawned();
  const relayed = await h.call("orchestrator_relay", { handoffPath: "docs/orchestrator-handoff.md" });
  assert.notEqual(relayed.isError, true, text(relayed));

  const split = h.tmuxCalls.filter((c) => c[0] === "split-window").at(-1)!;
  assert.ok(split.includes(`${ORCHESTRATION_ID_ENV}=orch-abc-1`), "the successor inherits the SAME address");
  assert.ok(split.includes(`${GATE_MODE_ENV}=orchestrator`));
  assert.ok(split.includes(`${HANDOFF_PATH_ENV}=docs/orchestrator-handoff.md`));
  assert.equal(h.runtime().relay?.successorPane, relayed.details?.successorPane);

  // The predecessor cannot close itself; a session that inherited it can.
  const selfClose = await h.call("orchestrator_close", { predecessorPane: "%1" });
  assert.equal(selfClose.isError, true);
  h.setEnv({ [PREDECESSOR_PANE_ENV]: "%1" } as NodeJS.ProcessEnv);
  const successorClose = await h.call("orchestrator_close", { predecessorPane: "%1" });
  assert.notEqual(successorClose.isError, true);
  assert.equal(h.panes.get("%1")!.alive, false);
});

test("ZERO-COVERAGE: notify goes out once, is throttled on repeat, and settles a decision", async () => {
  const h = fakeOrchestration({ plan: samplePlan(), approved: true });
  await h.call("orchestrator_plan", { action: "add-decision", question: "要不要丢弃工作区？" });

  const first = await h.call("orchestrator_notify", { title: "需要你拍板", body: "工作区要不要丢弃", decisionId: "d1" });
  assert.notEqual(first.isError, true);
  assert.equal(h.emitted.length, 1, "the escape sequence went through the injected emitter");
  assert.ok(h.plan()!.decisions[0]!.notifiedAt, "and the decision no longer blocks the exit");

  const repeat = await h.call("orchestrator_notify", { title: "需要你拍板", body: "工作区要不要丢弃" });
  assert.equal(repeat.isError, true, "the same text does not become a pager storm");
  assert.equal(h.emitted.length, 1);
});

test("ZERO-COVERAGE: status reports the children, the plan and exactly what blocks the exit", async () => {
  const { h, child } = await spawned();
  const status = await h.call("orchestrator_status");
  assert.notEqual(status.isError, true);
  assert.match(text(status), new RegExp(child!.id), "the live child is named");
  assert.match(text(status), /还有 1 个子会话活着/, "and it is named as a blocker");
  assert.match(text(status), /plan 还有 2 个任务未完成/);

  await h.call("orchestrator_close", { childId: child!.id });
  const after = await h.call("orchestrator_status");
  assert.doesNotMatch(text(after), /还有 1 个子会话活着/, "closing it clears that blocker");
});

test("F4: each child is started with its OWN sidecar variant, and the read uses it", async () => {
  const { h, child } = await spawned();
  const split = h.tmuxCalls.find((c) => c[0] === "split-window")!;
  assert.ok(split.includes(`${STATE_VARIANT_ENV}=${child!.id}`));

  // F10 — the goal draft was always readable from the child's own sidecar.
  h.setSidecar(child!.cwd, child!.stateVariant, {
    taskMode: "loop",
    goalPrereview: { verdict: "PASS", at: "2026-08-29T00:00:00Z", draft: "# 任务：拆分 lib/plan" },
  });
  const read = await h.call("orchestrator_read", { childId: child!.id });
  assert.match(text(read), /sidecar/, "the channel is named");
  assert.match(text(read), /# 任务：拆分 lib\/plan/, "and the draft it holds is shown in full");
});
