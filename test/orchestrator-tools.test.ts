import test from "node:test";
import assert from "node:assert/strict";

import { registerOrchestratorStateTools } from "../lib/orchestrator-tools.ts";
import { registerOrchestratorSessionTools } from "../lib/orchestrator-session-tools.ts";
import { registerOrchestratorReadTools } from "../lib/orchestrator-read-tools.ts";
import type { ToolHost, ToolReply } from "../lib/orchestrator-deps.ts";
import { planHash, type OrchestratorPlan } from "../lib/orchestrator-plan.ts";
import { ORCHESTRATION_ID_ENV } from "../lib/orchestration-id.ts";
import { GATE_MODE_ENV } from "../lib/task-mode.ts";
import { STATE_VARIANT_ENV } from "../lib/gate-state.ts";
import { PREDECESSOR_PANE_ENV } from "../lib/orchestrator-relay.ts";
import {
  fakeOrchestration,
  samplePlan,
  NOW,
  type FakeOrchestration,
  type FakeOrchestrationOptions,
} from "./helpers/fake-orchestration.ts";

const PLAN_INPUT = {
  title: "拆分",
  intent: "把大文件拆成模块",
  maxParallel: 2,
  tasks: [
    { id: "a", title: "抽 plan", fileBoundaries: ["lib/plan"] },
    { id: "b", title: "抽 tmux", fileBoundaries: ["lib/tmux"], execution: "parallel" },
  ],
};

function planFrom(input: unknown = PLAN_INPUT): OrchestratorPlan {
  return samplePlan(input);
}

/**
 * The harness is now the SHARED fake (test/helpers/fake-orchestration.ts):
 * these tests and the protocol test drive the very same simulated tmux, so a
 * behavior that only the protocol test exercises cannot silently diverge from
 * the one this file asserts.
 */
type Harness = FakeOrchestration;

function harness(options: FakeOrchestrationOptions = {}): Harness {
  return fakeOrchestration(options);
}


function text(reply: ToolReply): string {
  return reply.content.map((c) => c.text).join("\n");
}

test("all ten orchestration tools are registered", () => {
  const registered: string[] = [];
  const host: ToolHost = { registerTool: (def) => { registered.push(def.name); } };
  const stub = harness().deps;
  registerOrchestratorStateTools(host, stub);
  registerOrchestratorSessionTools(host, stub);
  registerOrchestratorReadTools(host, stub);
  assert.deepEqual(registered.sort(), [
    "orchestrator_close", "orchestrator_key", "orchestrator_notify", "orchestrator_plan",
    "orchestrator_read", "orchestrator_relay", "orchestrator_send", "orchestrator_spawn",
    "orchestrator_status", "orchestrator_wait",
  ]);
});


test("every tool refuses outside orchestrator mode", async () => {
  const h = harness({ taskMode: "loop", plan: planFrom(), approved: true });
  for (const name of [
    "orchestrator_plan", "orchestrator_status", "orchestrator_spawn",
    "orchestrator_send", "orchestrator_wait", "orchestrator_close", "orchestrator_relay",
    "orchestrator_read", "orchestrator_key",

  ]) {
    const reply = await h.call(name, { taskId: "a", childId: "x", handoffPath: "docs/h.md" });
    assert.equal(reply.isError, true, `${name} must refuse`);
    assert.match(text(reply), /只在 orchestrator（项目经理）模式下可用/);
  }
});

test("CONSTRAINT 9: notify refuses outside orchestrator mode too", async () => {
  const h = harness({ taskMode: "loop" });
  const reply = await h.call("orchestrator_notify", { title: "t", body: "b" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /只有项目经理/);
});

test("writing a plan does NOT approve it; the user's dialog does", async () => {
  const h = harness();
  const written = await h.call("orchestrator_plan", { action: "write", plan: PLAN_INPUT });
  assert.notEqual(written.isError, true);
  assert.equal(written.details?.approved, false);
  assert.match(text(written), /尚未获得用户批准/);
  assert.equal(h.runtime().approvedPlanHash, undefined, "the same rule as the loop goal");

  h.confirmAnswers.push(true);
  const submitted = await h.call("orchestrator_plan", { action: "submit" });
  assert.equal(submitted.details?.approved, true);
  assert.equal(h.runtime().approvedPlanHash, planHash(h.plan()!));
});

test("a declined plan is reported as declined, not silently approved", async () => {
  const h = harness({ plan: planFrom() });
  h.confirmAnswers.push(false);
  const reply = await h.call("orchestrator_plan", { action: "submit" });
  assert.equal(reply.isError, true);
  assert.equal(h.runtime().approvedPlanHash, undefined);
});

test("re-writing an APPROVED plan with different content revokes the approval", async () => {
  const h = harness({ plan: planFrom(), approved: true });
  const changed = { ...PLAN_INPUT, tasks: [...PLAN_INPUT.tasks, { id: "c", title: "c", fileBoundaries: ["docs"] }] };
  const reply = await h.call("orchestrator_plan", { action: "write", plan: changed });
  assert.equal(reply.details?.approved, false);
  assert.equal(h.runtime().approvedPlanHash, undefined, "content binding, not a one-time blessing");
});

test("an invalid plan is refused with every problem, and nothing is written", async () => {
  const h = harness();
  const reply = await h.call("orchestrator_plan", {
    action: "write",
    plan: { title: "t", intent: "i", tasks: [{ id: "a", title: "a" }] },
  });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /fileBoundaries/);
  assert.equal(h.plan(), undefined);
});

test("the task state machine is enforced through the tool", async () => {
  const h = harness({ plan: planFrom(), approved: true });
  const illegal = await h.call("orchestrator_plan", { action: "set-status", taskId: "a", status: "done" });
  assert.equal(illegal.isError, true);
  assert.match(text(illegal), /不能从 pending 直接变成 done/);

  const legal = await h.call("orchestrator_plan", { action: "set-status", taskId: "a", status: "running" });
  assert.notEqual(legal.isError, true);
  assert.equal(h.plan()!.tasks[0]!.status, "running");
});

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

test("CONSTRAINT 1: spawning without an approved plan is refused", async () => {
  const h = harness({ plan: planFrom() });
  const reply = await h.call("orchestrator_spawn", { taskId: "a", task: "干活 a" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /plan 尚未获得用户批准/);
  assert.deepEqual(h.tmuxCalls.filter((c) => c[0] === "split-window"), [], "nothing was opened");
});

test("a spawn registers the pane, injects the address and starts the child in LOOP mode", async () => {
  const h = harness({ plan: planFrom(), approved: true });
  const reply = await h.call("orchestrator_spawn", { taskId: "a", task: "开始干活" });
  assert.notEqual(reply.isError, true);
  const split = h.tmuxCalls.find((c) => c[0] === "split-window")!;
  assert.deepEqual(split.slice(0, 4), ["split-window", "-h", "-t", "%1"], "the first child creates the right column");
  assert.ok(split.includes(`${ORCHESTRATION_ID_ENV}=orch-abc-1`), "children are addressed to the ORCHESTRATION");
  assert.ok(split.includes(`${GATE_MODE_ENV}=loop`), "a child is an ordinary loop session, and is told so");

  const child = h.runtime().children[0]!;
  assert.equal(child.taskId, "a");
  assert.equal(child.paneId, "%2");
  assert.equal(h.plan()!.tasks[0]!.status, "running", "the plan follows the spawn");
  // F7 — the task is a FILE carried in the argv, not keystrokes. Nothing
  // about the opening message may go through `send-keys`: that is the path
  // that truncated it and then never submitted it.
  assert.equal(child.stateVariant, child.id, "F4: the child owns its own gate sidecar");
  assert.ok(child.taskFile, "the task was written to a file");
  assert.ok(
    split.some((arg) => arg === `@${child.taskFile}`),
    "the task file is the child's first message, via pi's @file argv",
  );
  assert.ok(split.includes(`${STATE_VARIANT_ENV}=${child.id}`), "and the variant is injected");
  assert.deepEqual(
    h.tmuxCalls.filter((c) => c[0] === "send-keys"),
    [],
    "F7/F8: not one keystroke carried the task",
  );
  assert.equal(reply.details?.delivered, true, "F8: the receipt is earned, and says so");

});

test("CONSTRAINT 7: a parallel task gets a gate-created worktree; a serial one does not", async () => {
  const h = harness({ plan: planFrom(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a", task: "干活 a" });
  assert.deepEqual(h.worktrees, [], "the first child runs alone — no isolation needed");

  const second = await h.call("orchestrator_spawn", { taskId: "b", task: "干活 b" });
  assert.equal(second.details?.execution, "parallel");
  assert.deepEqual(h.worktrees, ["/tmp/wt/b"], "a child running alongside another gets its own checkout");
  const split = h.tmuxCalls.filter((c) => c[0] === "split-window")[1]!;
  assert.deepEqual(split.slice(0, 4), ["split-window", "-v", "-t", "%2"], "and it stacks under the first child");
  assert.ok(split.includes("/tmp/wt/b"), "the child starts INSIDE the worktree");
});

test("CONSTRAINT 6: a task overlapping a running one is refused with the scheduler's reason", async () => {
  const h = harness({
    plan: planFrom({
      title: "t", intent: "i", maxParallel: 2,
      tasks: [
        { id: "a", title: "a", fileBoundaries: ["lib"] },
        { id: "b", title: "b", fileBoundaries: ["lib/deep.ts"] },
      ],
    }),
    approved: true,
  });
  await h.call("orchestrator_spawn", { taskId: "a", task: "干活 a" });
  const blocked = await h.call("orchestrator_spawn", { taskId: "b", task: "干活 b" });
  assert.equal(blocked.isError, true);
  assert.match(text(blocked), /约束 6/);
});

test("a spawn that cannot be registered is ROLLED BACK", async () => {
  const h = harness({ plan: planFrom(), approved: true });
  // tmux answers, but with no pane id: an unregistered pane is unaddressable,
  // so the tool must not leave one behind.
  h.deps.tmux = (argv) => {
    h.tmuxCalls.push([...argv]);
    if (argv[0] === "list-panes") return { ok: true, stdout: "%1", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
  const reply = await h.call("orchestrator_spawn", { taskId: "b", task: "干活 b" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /已回滚/);
  assert.deepEqual(h.runtime().children, []);
});

// ---------------------------------------------------------------------------
// send / close / relay
// ---------------------------------------------------------------------------

test("CONSTRAINT 8 / R-7: the boundary check reads the child's SIDECAR draft, not the caller's text", async () => {
  const h = harness({ plan: planFrom(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a", task: "干活 a" });
  const child = h.runtime().children[0]!;
  const childId = child.id;
  const setDraft = (draft: string): void => {
    h.setSidecar(child.cwd, child.stateVariant, { goalPrereview: { verdict: "PASS", at: "now", draft } });
  };

  // R-7 — with no draft on record there is nothing the GATE can check, so it
  // refuses. It never falls back to the text the caller typed: that fallback
  // is exactly how an abridged goal passed the check while the FULL goal was
  // approved on the user's behalf.
  const noDraft = await h.call("orchestrator_send", { childId, approveGoal: true });
  assert.equal(noDraft.isError, true, "no sidecar draft ⇒ no proxy approval");
  assert.match(text(noDraft), /sidecar/);

  setDraft("重构 lib/plan/state.ts，补测试");
  // F11 — a proxied approval has to ANSWER the child's dialog, so there has to
  // BE one. Without it the tool refuses instead of reporting success: the old
  // code passed the boundary check and said "已过边界比对", which read as
  // "approved" while the dialog sat untouched in the pane.
  const withoutDialog = await h.call("orchestrator_send", { childId, approveGoal: true });
  assert.equal(withoutDialog.isError, true, "F11: no dialog on screen ⇒ nothing was approved");
  assert.equal(withoutDialog.details?.boundaryOk, true, "the boundary check itself passed");
  assert.equal(withoutDialog.details?.approved, false, "and the receipt says so plainly");

  h.openDialog(child.paneId, "认可这个 goal 吗？", ["Yes", "No"]);
  const inside = await h.call("orchestrator_send", { childId, approveGoal: true });
  assert.notEqual(inside.isError, true, text(inside));
  assert.equal(inside.details?.approved, true);
  assert.match(h.render(child.paneId), /answered: Yes/, "the dialog was really answered");

  // A draft that reaches OUTSIDE the task is refused on what the CHILD wrote,
  // so a tidied-up copy in the caller's hand changes nothing.
  setDraft("顺手改 extensions/review-gate.ts");
  h.openDialog(child.paneId, "认可这个 goal 吗？", ["Yes", "No"]);
  const outside = await h.call("orchestrator_send", {
    childId,
    approveGoal: "只改 lib/plan/state.ts（这份手抄稿完全在边界内）",
  });
  assert.equal(outside.isError, true, "the SIDECAR draft decides, not the pretty copy");
  assert.match(text(outside), /范围变更/);
  assert.deepEqual(outside.details?.outside, ["extensions/review-gate.ts"]);
});

test("R-7: a caller-supplied text that differs from the sidecar draft is REPORTED, never compared", async () => {
  const h = harness({ plan: planFrom(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a", task: "干活 a" });
  const child = h.runtime().children[0]!;
  h.setSidecar(child.cwd, child.stateVariant, {
    goalPrereview: { draft: "退出标准 1..7，非目标若干\n只动 lib/plan/state.ts" },
  });
  h.openDialog(child.paneId, "认可这个 goal 吗？", ["Yes", "No"]);

  const reply = await h.call("orchestrator_send", { childId: child.id, approveGoal: "删减版：只留 3 条退出标准" });
  assert.notEqual(reply.isError, true, text(reply));
  assert.match(text(reply), /不一致/, "the mismatch is named — that was the silent hole");
  assert.match(text(reply), /退出标准 1\.\.7/, "and the receipt shows what was ACTUALLY approved");
});


test("CONSTRAINT 13: only a child the GATE spawned is addressable at all", async () => {
  // The bash guard stops the agent typing `split-window`; the registry is the
  // other half. A pane nobody registered — the user's own, another
  // orchestration's, or one improvised around the tools — cannot be messaged,
  // waited on or closed, so a hand-made child is not merely discouraged: it
  // is unusable.
  const h = harness({ plan: planFrom(), approved: true });
  for (const [tool, params] of [
    ["orchestrator_send", { childId: "ghost", message: "hi" }],
    ["orchestrator_close", { childId: "%99" }],
  ] as const) {
    const reply = await h.call(tool, params);
    assert.equal(reply.isError, true, `${tool} must refuse an unregistered child`);
    assert.match(text(reply), /没有登记过子会话/);
  }
  // And once the gate DID spawn it, the same calls address it fine.
  await h.call("orchestrator_spawn", { taskId: "a", task: "干活 a" });
  const registered = h.runtime().children[0]!.id;
  assert.notEqual((await h.call("orchestrator_send", { childId: registered, message: "hi" })).isError, true);
});

test("closing is limited to registered panes, and cleans up the worktree", async () => {
  const h = harness({ plan: planFrom(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a", task: "干活 a" });
  await h.call("orchestrator_spawn", { taskId: "b", task: "干活 b" });
  const parallelChild = h.runtime().children[1]!;

  const stranger = await h.call("orchestrator_close", { childId: "%99" });
  assert.equal(stranger.isError, true, "the user's own panes are not addressable");

  const closed = await h.call("orchestrator_close", { childId: parallelChild.id });
  assert.notEqual(closed.isError, true);
  assert.ok(h.tmuxCalls.some((c) => c[0] === "kill-pane" && c[2] === parallelChild.paneId));
  assert.deepEqual(h.removed, ["/tmp/wt/b"]);
  assert.ok(h.runtime().children[1]!.closedAt);
});

test("CONSTRAINT 12: only a successor may close a predecessor pane", async () => {
  const h = harness({ plan: planFrom(), approved: true });
  const refused = await h.call("orchestrator_close", { predecessorPane: "%1" });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /不是任何人的接任者/);

  h.setEnv({ [PREDECESSOR_PANE_ENV]: "%1" } as NodeJS.ProcessEnv);
  const allowed = await h.call("orchestrator_close", { predecessorPane: "%1" });
  assert.notEqual(allowed.isError, true);
  assert.ok(h.tmuxCalls.some((c) => c[0] === "kill-pane" && c[2] === "%1"));
});

test("a relay refuses without a handoff, and hands over everything when it has one", async () => {
  const h = harness({ plan: planFrom(), approved: true });
  const refused = await h.call("orchestrator_relay", {});
  assert.equal(refused.isError, true);
  assert.match(text(refused), /没有交接文档/);

  const done = await h.call("orchestrator_relay", { handoffPath: "docs/orchestrator-handoff.md" });
  assert.notEqual(done.isError, true);
  const split = h.tmuxCalls.filter((c) => c[0] === "split-window").pop()!;
  assert.ok(split.includes(`${ORCHESTRATION_ID_ENV}=orch-abc-1`), "the successor inherits the SAME address");
  assert.ok(split.includes(`${GATE_MODE_ENV}=orchestrator`));
  assert.ok(split.includes(`${PREDECESSOR_PANE_ENV}=%1`));
  assert.ok(split.some((a) => a.includes("/sessions/self.jsonl")), "the raw transcript pointer travels too");
  assert.match(text(done), /由\*\*它\*\*来关掉你这个 pane/);
  assert.equal(h.runtime().relay?.handoffPath, "docs/orchestrator-handoff.md");
});

// ---------------------------------------------------------------------------
// status + notify
// ---------------------------------------------------------------------------

test("waiting with NOTHING to wait for is refused, not reported as a dead child", async () => {
  // The probe's "no live pane" branch means `pane-gone`, which would tell the
  // orchestrator a child died when it never opened one.
  const h = harness({ plan: planFrom(), approved: true });
  const empty = await h.call("orchestrator_wait", {});
  assert.equal(empty.isError, true);
  assert.equal(empty.details?.reason, "no-children");
  assert.match(text(empty), /orchestrator_spawn/, "it points at what to do instead");

  await h.call("orchestrator_spawn", { taskId: "a", task: "干活 a" });
  const unknown = await h.call("orchestrator_wait", { childId: "ghost" });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.details?.reason, "no-such-child",
    "waiting on a child that was never registered is a typo, not an end state");
});

test("status reports the plan, the children and what still blocks the exit", async () => {
  const h = harness({ plan: planFrom(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a", task: "干活 a" });
  const reply = await h.call("orchestrator_status");
  const body = text(reply);
  assert.match(body, /编排状态/);
  assert.match(body, /orchestration=orch-abc-1/);
  assert.match(body, /还差什么才能 declare_done/);
  const problems = reply.details?.problems as string[];
  assert.ok(problems.some((p) => /约束 4/.test(p)), "the live child is named as a blocker");
});

test("notify writes once and is then throttled, and it can settle a decision", async () => {
  const h = harness({
    plan: planFrom({
      ...PLAN_INPUT,
      decisions: [{ id: "d1", question: "丢弃工作区？" }],
    }),
    approved: false,
  });
  const first = await h.call("orchestrator_notify", { title: "需要你", body: "要不要丢弃工作区", decisionId: "d1" });
  assert.equal(first.details?.sent, true);
  assert.equal(h.emitted.length, 1, "the escape sequence goes through the INJECTED emitter, never straight to stdout");
  assert.match(text(first), /已标记为「已通知用户」/);
  assert.ok(h.plan()!.decisions[0]!.notifiedAt, "constraint 11 is released by TELLING the user");

  const repeat = await h.call("orchestrator_notify", { title: "需要你", body: "要不要丢弃工作区" });
  assert.equal(repeat.isError, true);
  assert.match(text(repeat), /节流/);
});

test("notify naming an unknown decision marks nothing and says so", async () => {
  const h = harness({ plan: planFrom() });
  const reply = await h.call("orchestrator_notify", { title: "t", body: "b", decisionId: "ghost" });
  assert.equal(reply.details?.sent, true);
  assert.match(text(reply), /没有决策项 "ghost"/);
});

test("a notification the host suppressed is reported honestly and NOT throttled", async () => {
  // A run with no TTY (a test, CI, a piped host) emits nothing. Recording it
  // anyway would deduplicate away the first notification that could really
  // have reached the user.
  const h = harness({ plan: planFrom(), notificationsWork: false });
  const reply = await h.call("orchestrator_notify", { title: "需要你", body: "看一眼" });
  assert.equal(reply.isError, true);
  assert.equal(reply.details?.sent, false);
  assert.match(text(reply), /没有发出去/);
  assert.match(text(reply), /ask_user/, "the refusal points at the channel that DOES work");
  assert.deepEqual(h.runtime().notify.sentAt, [], "a send that never happened is not recorded");
});
