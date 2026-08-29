import test from "node:test";
import assert from "node:assert/strict";

import { registerOrchestratorStateTools } from "../lib/orchestrator-tools.ts";
import { registerOrchestratorSessionTools } from "../lib/orchestrator-session-tools.ts";
import type { OrchestratorDeps, ToolHost, ToolReply } from "../lib/orchestrator-deps.ts";
import { parsePlan, planHash, type OrchestratorPlan } from "../lib/orchestrator-plan.ts";
import { emptyRuntime, type OrchestratorRuntime } from "../lib/orchestrator-registry.ts";
import { ORCHESTRATION_ID_ENV } from "../lib/orchestration-id.ts";
import { GATE_MODE_ENV } from "../lib/task-mode.ts";
import { PREDECESSOR_PANE_ENV } from "../lib/orchestrator-relay.ts";
import type { TaskMode } from "../lib/task-mode.ts";

const NOW = 1_700_000_000_000;

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
  const parsed = parsePlan(input, new Date(NOW).toISOString());
  assert.ok(parsed.ok, parsed.problems.join("; "));
  return parsed.plan!;
}

interface Harness {
  call(name: string, params?: Record<string, unknown>): Promise<ToolReply>;
  deps: OrchestratorDeps;
  tmuxCalls: string[][];
  worktrees: string[];
  removed: string[];
  confirmAnswers: boolean[];
  emitted: string[];
  plan(): OrchestratorPlan | undefined;
  runtime(): OrchestratorRuntime;
  setEnv(env: NodeJS.ProcessEnv): void;
}

function harness(options: {
  taskMode?: TaskMode;
  plan?: OrchestratorPlan;
  approved?: boolean;
  panes?: string[];
  ownPane?: string;
  env?: NodeJS.ProcessEnv;
  notificationsWork?: boolean;
} = {}): Harness {
  const tools = new Map<string, (params: Record<string, unknown>) => Promise<ToolReply>>();
  const host: ToolHost = {
    registerTool(def) {
      tools.set(def.name, (params) =>
        def.execute("id", params, { aborted: false }, undefined, undefined));
    },
  };

  let plan = options.plan;
  let runtime: OrchestratorRuntime = emptyRuntime("orch-abc-1");
  if (options.approved && plan) {
    runtime = { ...runtime, approvedPlanHash: planHash(plan), approvedPlanAt: new Date(NOW).toISOString() };
  }
  let env = options.env ?? ({} as NodeJS.ProcessEnv);
  const panes = options.panes ?? ["%1"];
  const tmuxCalls: string[][] = [];
  const worktrees: string[] = [];
  const removed: string[] = [];
  const confirmAnswers: boolean[] = [];
  const emitted: string[] = [];
  const notificationsWork = options.notificationsWork ?? true;
  let nextPane = 2;

  const deps: OrchestratorDeps = {
    repoRoot: "/repo",
    now: () => NOW,
    env: () => env,
    taskMode: () => options.taskMode ?? "orchestrator",
    runtime: () => runtime,
    saveRuntime: (next) => { runtime = next; },
    readPlan: () => ({ plan, problems: [] }),
    savePlan: (next) => { plan = next; },
    tmux: (argv) => {
      tmuxCalls.push([...argv]);
      if (argv[0] === "list-panes") return { ok: true, stdout: panes.join("\n"), stderr: "" };
      if (argv[0] === "split-window") {
        const id = `%${nextPane++}`;
        panes.push(id);
        return { ok: true, stdout: `${id}\n`, stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    },
    ownPane: () => options.ownPane ?? "%1",
    confirm: async () => confirmAnswers.shift() ?? false,
    addWorktree: (name) => {
      const path = `/tmp/wt/${name}`;
      worktrees.push(path);
      return { ok: true, path };
    },
    removeWorktree: (path) => { removed.push(path); },
    consumeAttention: () => undefined,
    branchFacts: () => ({ mergeSettled: true, mergeWaived: false }),
    emitNotification: (sequence) => { emitted.push(sequence); return notificationsWork; },
    fileChars: () => 1000,
    sessionTranscriptPath: () => "/sessions/self.jsonl",
  };

  registerOrchestratorStateTools(host, deps);
  registerOrchestratorSessionTools(host, deps);

  return {
    async call(name, params = {}) {
      const tool = tools.get(name);
      assert.ok(tool, `tool ${name} must be registered`);
      return tool(params);
    },
    deps,
    tmuxCalls,
    worktrees,
    removed,
    confirmAnswers,
    emitted,
    plan: () => plan,
    runtime: () => runtime,
    setEnv: (next) => { env = next; },
  };
}

function text(reply: ToolReply): string {
  return reply.content.map((c) => c.text).join("\n");
}

test("all eight orchestration tools are registered", () => {
  const registered: string[] = [];
  const host: ToolHost = { registerTool: (def) => { registered.push(def.name); } };
  const stub = harness().deps;
  registerOrchestratorStateTools(host, stub);
  registerOrchestratorSessionTools(host, stub);
  assert.deepEqual(registered.sort(), [
    "orchestrator_close", "orchestrator_notify", "orchestrator_plan", "orchestrator_relay",
    "orchestrator_send", "orchestrator_spawn", "orchestrator_status", "orchestrator_wait",
  ]);
});

test("every tool refuses outside orchestrator mode", async () => {
  const h = harness({ taskMode: "loop", plan: planFrom(), approved: true });
  for (const name of [
    "orchestrator_plan", "orchestrator_status", "orchestrator_spawn",
    "orchestrator_send", "orchestrator_wait", "orchestrator_close", "orchestrator_relay",
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
  const reply = await h.call("orchestrator_spawn", { taskId: "a" });
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
  assert.ok(h.tmuxCalls.some((c) => c[0] === "send-keys" && c.includes("开始干活")),
    "the opening message is delivered");
});

test("CONSTRAINT 7: a parallel task gets a gate-created worktree; a serial one does not", async () => {
  const h = harness({ plan: planFrom(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a" });
  assert.deepEqual(h.worktrees, [], "the first child runs alone — no isolation needed");

  const second = await h.call("orchestrator_spawn", { taskId: "b" });
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
  await h.call("orchestrator_spawn", { taskId: "a" });
  const blocked = await h.call("orchestrator_spawn", { taskId: "b" });
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
  const reply = await h.call("orchestrator_spawn", { taskId: "b" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /已回滚/);
  assert.deepEqual(h.runtime().children, []);
});

// ---------------------------------------------------------------------------
// send / close / relay
// ---------------------------------------------------------------------------

test("CONSTRAINT 8: a proxied goal outside the task boundary is refused", async () => {
  const h = harness({ plan: planFrom(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a" });
  const childId = h.runtime().children[0]!.id;

  const inside = await h.call("orchestrator_send", {
    childId, approveGoal: "重构 lib/plan/state.ts，补测试",
  });
  assert.notEqual(inside.isError, true);

  const outside = await h.call("orchestrator_send", {
    childId, approveGoal: "顺手改 extensions/review-gate.ts",
  });
  assert.equal(outside.isError, true);
  assert.match(text(outside), /范围变更/);
  assert.deepEqual(outside.details?.outside, ["extensions/review-gate.ts"]);
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
  await h.call("orchestrator_spawn", { taskId: "a" });
  const registered = h.runtime().children[0]!.id;
  assert.notEqual((await h.call("orchestrator_send", { childId: registered, message: "hi" })).isError, true);
});

test("closing is limited to registered panes, and cleans up the worktree", async () => {
  const h = harness({ plan: planFrom(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a" });
  await h.call("orchestrator_spawn", { taskId: "b" });
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

  await h.call("orchestrator_spawn", { taskId: "a" });
  const unknown = await h.call("orchestrator_wait", { childId: "ghost" });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.details?.reason, "no-such-child",
    "waiting on a child that was never registered is a typo, not an end state");
});

test("status reports the plan, the children and what still blocks the exit", async () => {
  const h = harness({ plan: planFrom(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a" });
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
