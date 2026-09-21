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
import { parsePlan } from "../lib/orchestrator-plan.ts";
import { decideNotify, emptyNotifyHistory, notifyKey, recordNotify } from "../lib/user-notify.ts";
import { addGrant, hasGrant } from "../lib/orchestrator-registry.ts";
import { ORCHESTRATION_ID_ENV, newOrchestrationId } from "../lib/orchestration-id.ts";
import { GATE_MODE_ENV } from "../lib/task-mode.ts";
import { STATION_CAP_ENV } from "../lib/repo-pr-policy.ts";
import { ACCEPTANCE_GATE_ENV } from "../lib/acceptance-round.ts";
import { registerOrchestratorStateTools } from "../lib/orchestrator-tools.ts";

/**
 * A crosscheck that PASSES the structure check, for the tests that are about
 * some other rule (constraint 8, the channel write, the settled request…).
 *
 * It is spelled out rather than generated so those tests keep exercising the
 * real validator: if the required shape changes, they fail here rather than
 * quietly stopping to test anything.
 */
const CROSSCHECK_T1 =
  "任务 t1：任务目标——草稿要做的事就是 plan 里 t1 这条，没有跑偏、也没有夹带别的任务；" +
  "交付站点——它声明的交付站点与 plan 的 deliveryStation 一致，没有往后挪。";


/**
 * The 8 tools an orchestration session gets, and nothing else.
 *
 * `session_handoff` is deliberately NOT on this list: it belongs to every
 * kind of session, not to the project manager (lib/session-handoff-tools.ts),
 * and listing it here would claim the orchestration layer owns it.
 *
 * `orchestrator_notify` USED TO BE THE NINTH (deleted 2026-09-17): letting the
 * manager decide when to interrupt the human is what the notification rule
 * exists to prevent, so the GATE raises the banner now, for three events
 * (lib/user-notify.ts). A manager that needs a person calls `ask_user`.
 */
const ORCHESTRATION_TOOLS = [
  "orchestrator_plan",
  "orchestrator_spawn",
  "orchestrator_instruct",
  "orchestrator_wait",
  "orchestrator_answer",
  "orchestrator_close",
  "orchestrator_recover",
  "orchestrator_attach",
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

/**
 * The task document a spawn wrote under `prefix`.
 *
 * It is the only place the brief, the station ceiling and the branch line are
 * visible together — exactly what the child reads before it negotiates its own
 * goal, so a mapping that goes in here reaches the child.
 */
function taskDocument(world: FakeWorld, prefix = "/repo/"): string {
  const entry = [...world.scratch.entries()].find(([path]) => path.startsWith(prefix) && path.includes("/.pi/tasks/"));
  assert.ok(entry, `a spawn writes its task file under ${prefix}`);
  return entry[1]!;
}


test("the orchestration tools are registered, and the deleted ones are not", () => {
  const world = makeFakeWorld();
  for (const name of ORCHESTRATION_TOOLS) {
    assert.ok(world.tools.has(name), `${name} must be registered`);
  }
  assert.equal(world.tools.size, ORCHESTRATION_TOOLS.length,
    `exactly ${ORCHESTRATION_TOOLS.length} orchestration tools: ${[...world.tools.keys()].join(", ")}`);
  // Philosophy three: the replaced tools are GONE, not deprecated.
  for (const gone of [
    "orchestrator_read", "orchestrator_key", "orchestrator_status", "orchestrator_send",
    "orchestrator_relay",
    // …and the notify tool, retired with the OSC channel: the gate sends now.
    "orchestrator_notify",
  ]) {
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
  // The write path is STRICT: every task must declare its repo (the child's cwd).
  const plan = { ...twoTaskPlan(), tasks: twoTaskPlan().tasks.map((t) => ({ ...t, repo: "/repo" })) };
  const written = await world.call("orchestrator_plan", { action: "write", plan });
  assert.equal(written.isError, undefined, replyText(written));
  assert.equal(world.runtime().approvedPlanHash, undefined, "writing must not approve");

  world.confirmAnswers.push(true);
  const submitted = await world.call("orchestrator_plan", { action: "submit" });
  assert.equal(submitted.isError, undefined, replyText(submitted));
  assert.ok(world.runtime().approvedPlanHash, "the user's yes is what approves it");
});

test("an ANSWERED-NOTHING plan dialog is not a rejection — ask before submitting again", async () => {
  // User report (2026-09-14), same rule as propose_restatement / propose_loop_goal:
  // closing the box without choosing means the user did not answer — usually
  // because they were saying something else — and calling that "not approved"
  // sends the PM off to rewrite a plan nobody objected to.
  const world = makeFakeWorld();
  const plan = { ...twoTaskPlan(), tasks: twoTaskPlan().tasks.map((t) => ({ ...t, repo: "/repo" })) };
  await world.call("orchestrator_plan", { action: "write", plan });
  world.confirmAnswers.push(false);
  const submitted = await world.call("orchestrator_plan", { action: "submit" });
  assert.equal(submitted.isError, true);
  assert.match(replyText(submitted), /没有作答/);
  assert.match(replyText(submitted), /ask_user/);
  assert.doesNotMatch(replyText(submitted), /没有批准/);
  assert.equal(world.runtime().approvedPlanHash, undefined, "an unanswered dialog approves nothing");
});

test("WRITE path REFUSES a task with no repo — the strict flag is pinned at the call site", async () => {
  // The parsePlan unit tests pin the rule itself, but THIS pins the ACTION:
  // if someone drops the `true` at the write call site, the deadlock (child
  // spawned in the orchestrator's own repo) silently returns.
  const world = makeFakeWorld();
  const plan = { ...twoTaskPlan(), tasks: twoTaskPlan().tasks.map((t) => ({ ...t, repo: undefined })) };
  const written = await world.call("orchestrator_plan", { action: "write", plan });
  assert.equal(written.isError, true, replyText(written));
  assert.match(replyText(written), /必须声明 repo/, "the refusal names the missing repo");
  assert.equal(world.plan(), undefined, "nothing is written");
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
  // The argv carries the REPO-RELATIVE ref; the fake keys its scratch store by
  // absolute path under the child's cwd (the task's repo).
  const ref = taskArg.slice(1);
  assert.ok(!ref.startsWith("/"), `the task file ref is repo-relative, not absolute: ${ref}`);
  assert.match(world.scratch.get(`/repo/${ref}`) ?? "", /做任务一/);
});

test("a task declaring a repo spawns its child in THAT repo, not the orchestrator's", async () => {
  const plan = parsePlan({
    title: "跨仓库计划",
    intent: "任务声明了另一个仓库",
    tasks: [
      { id: "t1", title: "任务一", repo: "/other/repo" },
    ],
  });
  assert.ok(plan.plan);
  const world = makeFakeWorld({
    plan: plan.plan,
    approvePlan: true,
    // The declared repo is NOT one this session has edited — that is the
    // point: knownRepoRoots membership must not gate the child's cwd.
    resolvableRepos: ["/other/repo"],
  });
  const receipt = await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  assert.equal(receipt.isError, undefined, replyText(receipt));
  const child = world.runtime().children[0]!;
  assert.equal(child.cwd, "/other/repo", "the registry records the task's repo as the child's cwd");
  const pane = world.panes.get(child.paneId)!;
  assert.equal(pane.cwd, "/other/repo", "tmux split-window -c receives the task's repo");
  // Fix 2 — the success receipt names the child's cwd, so the PM always sees
  // WHICH repo the child's gate is bound to (goal + edits).
  const details = receipt.details as Record<string, unknown>;
  assert.equal(details.cwd, "/other/repo", "the receipt names the child's cwd");
  assert.match(replyText(receipt), /cwd[^\n]*\/other\/repo/, "the receipt text states the child's working directory");
  // CROSS-REPO FIX (2026-09-17): the task file must land in the TASK's repo,
  // not the orchestrator's — the child resolves @.pi/tasks/<file> against ITS
  // cwd. Writing it elsewhere made cross-repo spawns hand the child a path
  // it could not find: pi exited at boot and the pane died.
  const taskFilePaths = [...world.scratch.keys()].filter((p) => p.includes("/.pi/tasks/"));
  assert.ok(taskFilePaths.length > 0, "the task file was written");
  assert.ok(taskFilePaths.every((p) => p.startsWith("/other/repo/")),
    `the task file lands in the TASK repo, not the orchestrator's: ${taskFilePaths.join(", ")}`);
});

test("a task declaring an unresolvable repo is REFUSED, never silently falling back", async () => {
  const plan = parsePlan({
    title: "坏仓库计划",
    intent: "任务声明了一个不存在的仓库",
    tasks: [
      { id: "t1", title: "任务一", repo: "/nowhere/repo" },
    ],
  });
  assert.ok(plan.plan);
  const world = makeFakeWorld({ plan: plan.plan, approvePlan: true });
  const reply = await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  assert.equal(reply.isError, true, replyText(reply));
  assert.match(replyText(reply), /repo 无法使用/);
  assert.equal(world.panes.size, 1, "no pane may be opened for an unresolvable repo");
  assert.equal(world.plan()!.tasks.find((t) => t.id === "t1")!.status, "pending", "the task stays pending");
});

test("the ONLY way out of the one-PR rule is ON THE TOOL SURFACE (round-1 P1)", () => {
  // Three surfaces tell the reader to "put the repo into allowMultiplePrs and
  // re-approve" — the plan approval dialog, the child's task book and its goal
  // dialog — and the gate narrows to `commit` by DEFAULT. A field the planner
  // cannot send is not a way out of anything, and the first version of this
  // rule shipped exactly that: the field existed in the plan parser and in the
  // approval algebra, and nowhere an agent could reach it.
  const world = makeFakeWorld();
  const specs = new Map<string, { description: string; parameters: { properties?: Record<string, unknown> } }>();
  registerOrchestratorStateTools(
    { registerTool: (definition) => { specs.set(definition.name, definition as never); } },
    world.deps,
  );
  const plan = specs.get("orchestrator_plan")!;
  const planProps = plan.parameters.properties?.['plan'] as { properties?: Record<string, unknown> } | undefined;
  assert.ok(planProps?.properties?.['allowMultiplePrs'],
    "the plan object must accept allowMultiplePrs — otherwise the refusal points at a surface that does not exist");
  assert.match(plan.description, /allowMultiplePrs/,
    "and the tool that writes plans must SAY so: it is the only reader of that description");
  assert.match(plan.description, /ONE PR/, "the rule itself is stated where plans are written");
});

test("a task WITHOUT a repo declaration still spawns in the orchestrator's own repo", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  const child = world.runtime().children[0]!;
  assert.equal(child.cwd, "/repo", "no repo declared ⇒ the orchestrator's own repo");
  const pane = world.panes.get(child.paneId)!;
  assert.equal(pane.cwd, "/repo");
});

test("the child's ceiling is the NARROWED station — in its environment AND in its task book (2026-09-15)", async () => {
  // One requirement, two tasks, one repo, plan at `pr`: the user gets ONE PR
  // out of a local merge (lib/repo-pr-policy.ts), so EVERY child in that repo
  // stops at `commit`. The ceiling rides the environment because that is the
  // one channel the child's own prompt cannot write, and the task book states
  // it where the child reads before negotiating its goal.
  const parsed = parsePlan({
    title: "同 repo 两任务",
    intent: "验证站点上界",
    deliveryStation: "pr",
    tasks: [
      { id: "t1", title: "A", repo: "/repo" },
      { id: "t2", title: "B", repo: "/repo", execution: "parallel" },
    ],
  });
  assert.ok(parsed.plan, parsed.problems.join("; "));
  const world = makeFakeWorld({ plan: parsed.plan!, approvePlan: true, resolvableRepos: ["/repo"] });
  const childId = await spawnT1(world);
  const child = world.runtime().children.find((c) => c.id === childId)!;
  assert.equal(world.panes.get(child.paneId)!.env[STATION_CAP_ENV], "commit");
  const doc = [...world.scratch.values()].join("\n");
  assert.match(doc, /本轮交付站点：commit/);
  assert.match(doc, /allowMultiplePrs/, "the way out is named where the child (and its user) reads it");
});

test("a single-task repo keeps the plan's station — the ceiling is not a blanket downgrade", async () => {
  const parsed = parsePlan({
    title: "单任务",
    intent: "验证站点上界",
    deliveryStation: "pr",
    tasks: [{ id: "t1", title: "A", repo: "/repo" }],
  });
  assert.ok(parsed.plan, parsed.problems.join("; "));
  const world = makeFakeWorld({ plan: parsed.plan!, approvePlan: true, resolvableRepos: ["/repo"] });
  const childId = await spawnT1(world);
  const child = world.runtime().children.find((c) => c.id === childId)!;
  assert.equal(world.panes.get(child.paneId)!.env[STATION_CAP_ENV], "pr");
});

test("only the plan's LAST task is spawned with the acceptance gate open (2026-09-22)", async () => {
  // The gate is an ENTITLEMENT the dispatcher writes: every other child gets
  // `off`, because a completion that spends a top-tier judge on an acceptance
  // nobody asked for is exactly what the plan never authorized. The last task
  // gets `on` — decided by lib/repo-pr-policy.ts's `acceptanceTaskId` and
  // consumed here, never re-derived.
  const parsed = parsePlan({
    title: "两任务",
    intent: "验收 gate 只给 plan 最后一环",
    deliveryStation: "commit",
    tasks: [
      { id: "t1", title: "A", repo: "/repo" },
      { id: "t2", title: "B", repo: "/repo" },
    ],
  });
  assert.ok(parsed.plan, parsed.problems.join("; "));
  const world = makeFakeWorld({ plan: parsed.plan!, approvePlan: true, resolvableRepos: ["/repo"], isolateChild: true });
  await spawnT1(world);
  const first = world.runtime().children.find((c) => c.taskId === "t1")!;
  assert.equal(world.panes.get(first.paneId)!.env[ACCEPTANCE_GATE_ENV], "off",
    "an ordinary work task must not owe a real-acceptance round");

  const second = await world.call("orchestrator_spawn", { taskId: "t2", task: "做任务二" });
  assert.equal(second.isError, undefined, replyText(second));
  const acceptance = world.runtime().children.find((c) => c.taskId === "t2")!;
  assert.equal(world.panes.get(acceptance.paneId)!.env[ACCEPTANCE_GATE_ENV], "on",
    "the last task IS the acceptance task");
});

test("the task book states the branch the child is on — a FACT, not an order to branch (A, 2026-09-18)", async () => {
  // Measured: the fixed 「开工前先给自己开一个功能分支」 sentence told a FINISH
  // task to fork the very branch it was spawned to deliver. The dispatcher knew
  // the branch all along, so it is now what the task book says.
  const world = makeFakeWorld({
    plan: twoTaskPlan(),
    approvePlan: true,
    currentBranch: "feat/plan-finish-task",
  });
  await spawnT1(world);
  const doc = taskDocument(world);
  assert.match(doc, /你在这条分支（`feat\/plan-finish-task`）上工作/);
  assert.doesNotMatch(doc, /git checkout -b/, "the branch is a fact here, not a command to run");
});

test("an ISOLATED child is told which branch it holds — and whether it may publish it (A, 2026-09-18)", async () => {
  // The mapping `dispatchSpawn` owns, and the two ways to get it backwards: the
  // gate's own checkout must be stated as ISOLATED, and a station that reaches
  // `pr` must NOT be told to stay off the remote — that would leave the one
  // task that delivers unable to deliver.
  const parsed = parsePlan({
    title: "同 repo 两任务",
    intent: "验证分支行",
    deliveryStation: "pr",
    tasks: [
      { id: "t1", title: "A", repo: "/repo" },
      { id: "t2", title: "B", repo: "/repo", execution: "parallel" },
    ],
  });
  assert.ok(parsed.plan, parsed.problems.join("; "));
  const world = makeFakeWorld({
    plan: parsed.plan!,
    approvePlan: true,
    isolateChild: true,
    resolvableRepos: ["/repo"],
    currentBranch: "feat/shared-branch",
  });
  await spawnT1(world);
  const shared = taskDocument(world);
  assert.match(shared, /你在这条分支（`feat\/shared-branch`）上工作/);
  assert.doesNotMatch(shared, /独立 checkout/, "the first child works in the shared checkout");

  await world.call("orchestrator_plan", { action: "set-status", taskId: "t1", status: "done" });
  const second = await world.call("orchestrator_spawn", { taskId: "t2", task: "做任务二" });
  assert.equal(second.isError, undefined, replyText(second));
  const isolated = taskDocument(world, "/repo-rg-");
  assert.match(isolated, /独立 checkout/);
  // t2 is the plan's LAST task, so it keeps the plan's station (`pr`) and IS
  // the delivery: it renames the gate's handle instead of being told to stay
  // away from the remote.
  assert.match(isolated, /本轮交付站点：pr/);
  assert.match(isolated, /git branch -m <type>\/<slug>/);
  assert.doesNotMatch(isolated, /不要 push/, "a delivering task is never told not to deliver");
});

// THE TASK BOOK IS WHAT THE CHILD READS (2026-09-21). `plan.tasks[].note` is
// the assignment the plan was audited and approved for, and the spawn path
// never read it: the child got whatever `task` the manager typed at spawn
// time, so the audited text, the approved text and the delivered text could
// all differ, with nothing keeping them in step.
test("a spawn with no `task` hands over the task BOOK", async () => {
  const parsed = parsePlan({
    title: "计划",
    intent: "任务书就是子会话的第一条消息",
    tasks: [{
      id: "t1",
      title: "任务一",
      repo: "/repo",
      note: "目标：把分页做出来\n代码落点：lib/pagination.ts（新模块）",
    }],
  }, undefined, true);
  assert.ok(parsed.plan, `fixture must parse: ${parsed.problems.join("; ")}`);
  const world = makeFakeWorld({ plan: parsed.plan!, approvePlan: true, resolvableRepos: ["/repo"] });
  const reply = await world.call("orchestrator_spawn", { taskId: "t1" });
  assert.equal(reply.isError, undefined, replyText(reply));
  const doc = taskDocument(world);
  assert.match(doc, /目标：把分页做出来/);
  assert.match(doc, /代码落点：lib\/pagination\.ts/);
});

test("a spawn still refuses when NEITHER the task book nor `task` says anything", async () => {
  const parsed = parsePlan({
    title: "计划",
    intent: "没有任务书也没有 task",
    tasks: [{ id: "t1", title: "任务一", repo: "/repo" }],
  }, undefined, true);
  assert.ok(parsed.plan, `fixture must parse: ${parsed.problems.join("; ")}`);
  const world = makeFakeWorld({ plan: parsed.plan!, approvePlan: true, resolvableRepos: ["/repo"] });
  const reply = await world.call("orchestrator_spawn", { taskId: "t1" });
  assert.equal(reply.isError, true, "an empty session is exactly the deadlock F8 measured");
  assert.match(replyText(reply), /note/, "the refusal names the field the manager has to fill");
  assert.equal(world.runtime().children.length, 0, "and no pane was opened");
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

test("CONSTRAINT 6: a task in the same repo as a running one is refused with the scheduler's reason", async () => {
  const plan = twoTaskPlan();
  const world = makeFakeWorld({ plan, approvePlan: true });
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
  assert.equal((await withRoom.call("orchestrator_wait", { timeoutMs: 0 })).details?.handoffDue, false);

  const nearlyFull = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, contextPercent: 72 });
  const c2 = await spawnT1(nearlyFull);
  readyChild(nearlyFull, c2);
  const clean = await nearlyFull.call("orchestrator_wait", { timeoutMs: 0 });
  assert.equal(clean.details?.handoffDue, true);
  assert.match(replyText(clean), /写进门禁准备好的交接文档/);
  assert.match(replyText(clean), /session_handoff\(\)/, "the one tool is named, not a concept");

  nearlyFull.childAsks(c2, { requestId: "r", title: "问题", options: ["A", "B"] });
  const busy = await nearlyFull.call("orchestrator_wait", { timeoutMs: 0 });
  assert.match(replyText(busy), /先把这 1 个待答请求回掉/);
});

test("one threshold for every kind of session — 69% is quiet, 70% is the handover lane", async () => {
  // The receipt used to carry a soft/hard pair (80/90) that only the
  // orchestrator obeyed, while a judge rotated at 60 — three numbers for one
  // decision. lib/session-handoff.ts owns the single 70% now, and this pins
  // that the receipt speaks it.
  const below = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, contextPercent: 69 });
  const c1 = await spawnT1(below);
  readyChild(below, c1);
  assert.equal((await below.call("orchestrator_wait", { timeoutMs: 0 })).details?.handoffDue, false,
    "69% is below the threshold — there is no second lane to fall into");

  const full = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, contextPercent: 95 });
  const c = await spawnT1(full);
  readyChild(full, c);
  const reply = await full.call("orchestrator_wait", { timeoutMs: 0 });
  assert.equal(reply.details?.handoffDue, true);
  assert.match(replyText(reply), /接力是现在的动作/);
  assert.match(replyText(reply), /阈值 70%/, "the receipt states the number the policy uses");
});


test("a vanished pane is `dead`, and the receipt names the assets that survived it", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  readyChild(world, childId);
  const child = world.runtime().children[0]!;
  world.sidecars.set(child.cwd, { review: { verdict: "READY" } });
  world.panes.get(child.paneId)!.alive = false;

  const reply = await world.call("orchestrator_wait", { timeoutMs: 0 });
  const text = replyText(reply);
  assert.match(text, /pane 已消失/);
  assert.match(text, /review 裁决 READY/, "the review verdict survived the death and is named");
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

  // A path inside the child's own repo → approved.
  world.sidecars.set(child.cwd, { sessionEditedFiles: ["lib/a/one.ts"] });
  const ok = await world.call("orchestrator_answer", { childId, answer: "认可，写入 .pi/loop-goal.md", crosscheck: CROSSCHECK_T1 });

  assert.equal(ok.isError, undefined, replyText(ok));

  // A SENSITIVE path OUTSIDE the repo → refused. This is the security floor
  // that survived the file boundaries (2026-09-17): in-repo paths are the
  // child's own business, an out-of-repo secret is not.
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
  world2.sidecars.set(child2.cwd, { sessionEditedFiles: ["/Users/someone/.ssh/id_rsa"] });
  const refused = await world2.call("orchestrator_answer", { childId: c2, answer: "认可，写入 .pi/loop-goal.md", crosscheck: CROSSCHECK_T1 });

  assert.equal(refused.isError, true, replyText(refused));
  assert.match(replyText(refused), /仓库之外/, "the refusal names what it judged");
  assert.equal(world2.channelOf(c2).filter((r) => r.kind === "answer").length, 0);
});

test("a station the PLAN narrowed is refused on the user's behalf too (2026-09-15)", async () => {
  // One requirement, two tasks, one repo: the plan narrows that repo to
  // `commit` so ONE PR can come out of a local merge (lib/repo-pr-policy.ts).
  // The manager answers FOR the user here, and it must be held to the
  // NARROWED ceiling — comparing against the plan's headline `pr` instead
  // would let it confirm exactly the splitting the user forbade.
  const parsed = parsePlan({
    title: "同 repo 两任务",
    intent: "验证代答的站点上界",
    deliveryStation: "pr",
    tasks: [
      { id: "t1", title: "A", repo: "/repo" },
      { id: "t2", title: "B", repo: "/repo", execution: "parallel" },
    ],
  });
  assert.ok(parsed.plan, parsed.problems.join("; "));
  const world = makeFakeWorld({ plan: parsed.plan!, approvePlan: true, resolvableRepos: ["/repo"] });
  const childId = await spawnT1(world);
  world.childAsks(childId, {
    requestId: "goal-1",
    title: "认可这个 loop goal 吗？",
    options: ["认可，写入 .pi/loop-goal.md", "不认可，退回重谈"],
    payload: "# 目标\n两个任务的收口",
    topic: "goal-approval",
    station: "pr",
  });
  const refused = await world.call("orchestrator_answer", {
    childId, answer: "认可，写入 .pi/loop-goal.md", crosscheck: CROSSCHECK_T1,
  });
  assert.equal(refused.isError, true, replyText(refused));
  assert.match(replyText(refused), /站点/, "the refusal names the station it judged");
  assert.equal(world.channelOf(childId).filter((r) => r.kind === "answer").length, 0,
    "nothing may be written when the answer is refused");

  // The control: ONE task in that repo is not narrowed at all, so the very
  // same proxy answer goes through — the rule is per repo, not a blanket ban.
  const single = parsePlan({
    title: "单任务",
    intent: "验证代答的站点上界",
    deliveryStation: "pr",
    tasks: [{ id: "t1", title: "A", repo: "/repo" }],
  });
  assert.ok(single.plan, single.problems.join("; "));
  const world2 = makeFakeWorld({ plan: single.plan!, approvePlan: true, resolvableRepos: ["/repo"] });
  const c2 = await spawnT1(world2);
  world2.childAsks(c2, {
    requestId: "goal-1",
    title: "认可这个 loop goal 吗？",
    options: ["认可，写入 .pi/loop-goal.md", "不认可，退回重谈"],
    payload: "# 目标\n单任务",
    topic: "goal-approval",
    station: "pr",
  });
  const ok = await world2.call("orchestrator_answer", {
    childId: c2, answer: "认可，写入 .pi/loop-goal.md", crosscheck: CROSSCHECK_T1,
  });
  assert.equal(ok.isError, undefined, replyText(ok));
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
  const reply = await world.call("orchestrator_answer", { childId, answer: "认可，写入 .pi/loop-goal.md", crosscheck: CROSSCHECK_T1 });

  assert.equal(reply.isError, true);
  assert.match(replyText(reply), /没有带上 goal 全文/);
});

test("declining a goal with `reason` writes it into the channel — the child renegotiates against it", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childAsks(childId, {
    requestId: "goal-1",
    title: "认可这个 loop goal 吗？",
    options: ["认可，写入 .pi/loop-goal.md", "不认可，退回重谈"],
    payload: "# 目标\n退出条件 3 不可检查",
    topic: "goal-approval",
  });
  const reply = await world.call("orchestrator_answer", { childId, answer: "不认可，退回重谈", reason: "退出条件 3 没有可检查的验收标准" });
  assert.equal(reply.isError, undefined, replyText(reply));
  const answer = world.channelOf(childId).find((r) => r.kind === "answer");
  assert.ok(answer, "an answer record must be written");
  assert.equal(answer.answer, "不认可，退回重谈");
  assert.equal(answer.reason, "退出条件 3 没有可检查的验收标准", "the decline reason rides in the answer record");
});

test("tmux-access proxy answer: the PM needs the user's scope, exactly like a sensitive edit", async () => {
  // Reviewer P2 (2026-09-17). `kill-server` takes the user's whole tmux session
  // with it, so a child that talked its manager into approving it would have
  // bypassed the permission the user was just handed. This pins the mapping
  // (topic → scope): a typo here silently reopens unconditional proxy approval,
  // and nothing else in the suite would notice.
  const ask = (w: FakeWorld, c: string) => w.childAsks(c, {
    requestId: "req-t1",
    title: "AI 请求在 bash 里使用 tmux 命令——是否授权？",
    options: ["允许：本会话和接力继任者都能用 tmux", "只允许这一次", "拒绝"],
    topic: "tmux-access",
  });

  // 1) No grant + the user refuses the proxy scope → refused, nothing written.
  const w1 = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const c1 = await spawnT1(w1);
  ask(w1, c1);
  w1.options.selectAnswers = ["拒绝"];
  const r1 = await w1.call("orchestrator_answer", { childId: c1, answer: "允许：本会话和接力继任者都能用 tmux" });
  assert.equal(r1.isError, true);
  assert.match(replyText(r1), /用户拒绝授予tmux 授权代答权/);
  assert.equal(w1.channelOf(c1).filter((r) => r.kind === "answer").length, 0, "nothing written");
  assert.equal(hasGrant(w1.runtime(), "tmux-access"), false);

  // 2) The user picks "allow and remember" → the scope is minted AND the
  //    manager's answer goes through.
  const w2 = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const c2 = await spawnT1(w2);
  ask(w2, c2);
  w2.options.selectAnswers = ["允许并记住（本 orchestration 内都代答）"];
  const r2 = await w2.call("orchestrator_answer", { childId: c2, answer: "允许：本会话和接力继任者都能用 tmux" });
  assert.equal(r2.isError, undefined, replyText(r2));
  assert.equal(w2.channelOf(c2).filter((r) => r.kind === "answer").length, 1, "the answer was written");
  assert.equal(hasGrant(w2.runtime(), "tmux-access"), true, "the scope the reviewer asked for is the one minted");
  assert.equal(hasGrant(w2.runtime(), "sensitive-edit"), false, "and it does not leak into the other scope");

  // 3) THE PM's ANSWER IS ITSELF the ✎ row — and that only means anything when
  //    the ✎ row is one of the rows THIS request offered, or `resolveAnswer`
  //    rejects it first and the branch below is never reached (reviewer P2).
  //    To isolate `looksLikeDeclineRow` the row must NOT also match the regex
  //    beside it: `✎ 不需要` has no 拒绝/取消/不选 in it, so only the ✎ is what
  //    makes it a refusal.
  const w3 = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const c3 = await spawnT1(w3);
  w3.childAsks(c3, {
    requestId: "req-t3",
    title: "AI 请求在 bash 里使用 tmux 命令——是否授权？",
    options: ["允许：本会话和接力继任者都能用 tmux", "只允许这一次", "拒绝", "✎ 不需要"],
    topic: "tmux-access",
  });
  const r3 = await w3.call("orchestrator_answer", {
    childId: c3, answer: "✎ 不需要",
  });
  assert.equal(r3.isError, undefined, replyText(r3));
  assert.ok(!w3.shown.some((line) => line.includes("项目经理想代答")), "a refusal never opens the grant door");
  assert.equal(hasGrant(w3.runtime(), "tmux-access"), false, "and it mints nothing");
  const decl = w3.channelOf(c3).filter((r) => r.kind === "answer");
  assert.equal(decl.length, 1, "the refusal is written — the child must see that it was refused");
  assert.match(String(decl[0]!.answer), /✎ 不需要/);

  // 4) …and the decline ROW inside the grant dialog is a refusal too, whatever
  //    reason text it carries (it may well say 允许/授权 — the row is the
  //    answer).
  const w4 = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const c4 = await spawnT1(w4);
  ask(w4, c4);
  w4.options.selectAnswers = ["✎ 不选，我说明原因：先不动 tmux"];
  const r4 = await w4.call("orchestrator_answer", {
    childId: c4, answer: "允许：本会话和接力继任者都能用 tmux",
  });
  assert.equal(r4.isError, true, "the decline row in the grant dialog decides, not the text beside it");
});

test("sensitive-edit proxy answer: NO grant → the user's three-choice door in the PM pane decides", async () => {
  // 1) No grant + user picks "拒绝" → refused, nothing written.
  const w1 = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const c1 = await spawnT1(w1);
  w1.childAsks(c1, {
    requestId: "req-s1",
    title: "AI 请求一次性修改敏感文件",
    options: ["同意一次性修改", "拒绝（保持拦截）"],
    topic: "sensitive-edit",
  });
  w1.options.selectAnswers = ["拒绝"];
  const r1 = await w1.call("orchestrator_answer", { childId: c1, answer: "同意一次性修改" });
  assert.equal(r1.isError, true);
  assert.match(replyText(r1), /用户拒绝授予敏感编辑代答权/);
  assert.equal(w1.channelOf(c1).filter((r) => r.kind === "answer").length, 0, "nothing written");

  // 2) User picks "允许并记住" → grant minted AND the answer goes through.
  const w2 = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const c2 = await spawnT1(w2);
  w2.childAsks(c2, {
    requestId: "req-s2",
    title: "AI 请求一次性修改敏感文件",
    options: ["同意一次性修改", "拒绝（保持拦截）"],
    topic: "sensitive-edit",
  });
  w2.options.selectAnswers = ["允许并记住（本 orchestration 内都代答）"];
  const r2 = await w2.call("orchestrator_answer", { childId: c2, answer: "同意一次性修改" });
  assert.equal(r2.isError, undefined, replyText(r2));
  assert.equal(w2.channelOf(c2).filter((r) => r.kind === "answer").length, 1, "the answer was written");
  assert.equal(hasGrant(w2.runtime(), "sensitive-edit"), true, "the grant was minted");

  // 3) "仅允许这一次" → passes once, NO grant recorded.
  const w3 = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const c3 = await spawnT1(w3);
  w3.childAsks(c3, {
    requestId: "req-s3",
    title: "AI 请求一次性修改敏感文件",
    options: ["同意一次性修改", "拒绝（保持拦截）"],
    topic: "sensitive-edit",
  });
  w3.options.selectAnswers = ["仅允许这一次"];
  const r3 = await w3.call("orchestrator_answer", { childId: c3, answer: "同意一次性修改" });
  assert.equal(r3.isError, undefined, replyText(r3));
  assert.equal(hasGrant(w3.runtime(), "sensitive-edit"), false, "no grant persisted");
});

test("sensitive-edit proxy answer: WITH a grant, no dialog — the answer just goes through", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.saveRuntime(addGrant(world.runtime(), { scope: "sensitive-edit", grantedAt: new Date().toISOString(), via: "gate-grant" }));
  world.childAsks(childId, {
    requestId: "req-g1",
    title: "AI 请求一次性修改敏感文件",
    options: ["同意一次性修改", "拒绝（保持拦截）"],
    topic: "sensitive-edit",
  });
  const reply = await world.call("orchestrator_answer", { childId, answer: "同意一次性修改" });
  assert.equal(reply.isError, undefined, replyText(reply));
  assert.equal(world.channelOf(childId).filter((r) => r.kind === "answer").length, 1);
  assert.equal(world.options.selectAnswers?.length ?? 0, 0, "no PM-pane dialog was opened");
});

// ---------------------------------------------------------------------------
// instruct — the tool that replaced send-keys
// ---------------------------------------------------------------------------

test("an instruction is written to the channel and only claimed once the child ACKNOWLEDGES it", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  readyChild(world, childId);

  // No acknowledgement yet ⇒ the delivery FAILS. Writing is not delivering.
  const unacked = await world.call("orchestrator_instruct", { childId, message: "换个思路" });
  assert.equal(unacked.isError, true, replyText(unacked));
  assert.match(replyText(unacked), /一直没有回执/);

  // Now play the child's side: acknowledge the pending instruction.
  const pending = projectionOf(world, childId).pendingInstructs;
  assert.equal(pending.length, 1, "the instruction is on the channel even though the receipt failed");
  world.childAcks(childId, pending[0]!.instructId, true, "pi.sendUserMessage(deliverAs:steer)");

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

  const reply = await world.call("orchestrator_instruct", { childId, message: "在吗", mode: "steer" });
  assert.equal(reply.isError, true);
  assert.match(replyText(reply), /会话已经结束了/);
});

test("every mode needs text (interrupt included since 2026-08-31); an unknown mode is refused", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  readyChild(world, childId);

  const bad = await world.call("orchestrator_instruct", { childId, mode: "nextTurn", message: "x" });
  assert.equal(bad.isError, true);
  assert.match(replyText(bad), /mode 只能是 interrupt（默认）\/ steer/);
  assert.doesNotMatch(replyText(bad), /followUp/,
    "the refusal must not offer a mode this tool itself refuses");

  const emptySteer = await world.call("orchestrator_instruct", { childId, mode: "steer" });
  assert.equal(emptySteer.isError, true);
  assert.match(replyText(emptySteer), /要发的内容是空的/);

  // 2026-08-31: interrupt now carries its message (highest priority delivery).
  // A bare interrupt would leave the child stopped with no idea why/next.
  const emptyInterrupt = await world.call("orchestrator_instruct", { childId, mode: "interrupt" });
  assert.equal(emptyInterrupt.isError, true);
  assert.match(replyText(emptyInterrupt), /要发的内容是空的/);
});

test("interrupt with text delivers as the highest priority (2026-08-31)", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  readyChild(world, childId);

  // interrupt now carries its message — one call means "stop and do THIS now".
  const unacked = await world.call("orchestrator_instruct", { childId, message: "停下，先处理这个", mode: "interrupt" });
  assert.equal(unacked.isError, true, replyText(unacked)); // no ack yet ⇒ not delivered
  assert.match(replyText(unacked), /一直没有回执/);

  // But the instruction IS on the channel, with its mode and full text —
  // the child's own gate will abort + inject it (deliverAs:steer).
  const pending = projectionOf(world, childId).pendingInstructs;
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.mode, "interrupt", "the mode is interrupt");
  assert.equal(pending[0]!.text, "停下，先处理这个", "the message rides the interrupt");
});

// ---------------------------------------------------------------------------
// The DEFAULT is `interrupt`, and `followUp` is gone from the parameter
// surface (2026-09-17, user decision). A supervisor writes because the child
// should know NOW: an ordinary call that arrives after the round it meant to
// correct is a correction nobody applied.
// ---------------------------------------------------------------------------

test("no mode at all means `interrupt` — the ordinary call is the one that arrives NOW", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  readyChild(world, childId);

  await world.call("orchestrator_instruct", { childId, message: "停下，改做这个" });

  const pending = projectionOf(world, childId).pendingInstructs;
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.mode, "interrupt", "the default written into the channel, not `followUp`");
});

test("`followUp` is refused, and the refusal names the two modes that DO work", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  readyChild(world, childId);

  const refused = await world.call("orchestrator_instruct", { childId, mode: "followUp", message: "稍后读这条" });
  assert.equal(refused.isError, true, replyText(refused));
  assert.match(replyText(refused), /interrupt/, "it points at the default");
  assert.match(replyText(refused), /steer/, "and at the gentle option that still exists");
  assert.equal(projectionOf(world, childId).pendingInstructs.length, 0,
    "a refused mode writes NOTHING into the channel — the child must not read a message the tool rejected");
});

test("every delivered instruction stamps lastAssignedAt — `interrupt` is no longer exempt", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  readyChild(world, childId);
  const atSpawn = world.runtime().children[0]!.lastAssignedAt;
  assert.ok(atSpawn, "the spawn IS the first assignment");

  // Play the child's gate: acknowledge the injection the moment the record lands.
  const originalIO = world.deps.channelIO();
  const spy = {
    ...originalIO,
    appendLine(path: string, line: string) {
      originalIO.appendLine(path, line);
      const parsed = JSON.parse(line) as { kind?: string; instructId?: string };
      if (parsed.kind === "instruct" && parsed.instructId) {
        world.childAcks(childId, parsed.instructId, true, "已解除等待并立即投递正文", "injected");
      }
    },
  };
  (world.deps as { channelIO: () => typeof spy }).channelIO = () => spy;

  world.advance(60_000);
  const reply = await world.call("orchestrator_instruct", { childId, message: "停下，改做任务二", mode: "interrupt" });
  assert.equal(reply.isError, undefined, replyText(reply));

  const stamped = world.runtime().children[0]!.lastAssignedAt;
  assert.notEqual(stamped, atSpawn,
    "an interrupt carrying text IS new work: without this stamp the previous task's completion keeps counting");
  assert.equal(Date.parse(stamped!), Date.parse(atSpawn!) + 60_000);
});

test("the stamp survives a FAILED receipt — the assignment is the record in the channel", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  readyChild(world, childId);
  const atSpawn = world.runtime().children[0]!.lastAssignedAt;

  // Nobody acknowledges: the receipt fails. But the message IS in the child's
  // inbox and its gate will read it, so the child HAS been re-tasked — gating
  // the stamp on the receipt would leave the last task's completion standing.
  world.advance(60_000);
  const reply = await world.call("orchestrator_instruct", { childId, message: "停下，改做任务二" });
  assert.equal(reply.isError, true, replyText(reply));

  assert.equal(projectionOf(world, childId).pendingInstructs.length, 1, "the message is in its inbox");
  assert.equal(
    Date.parse(world.runtime().children[0]!.lastAssignedAt!),
    Date.parse(atSpawn!) + 60_000,
    "and the assignment stamp moved with it",
  );
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

test("a recovered child is handed its station ceiling again (2026-09-15)", async () => {
  // The ceiling lives in the CHILD'S ENVIRONMENT, and a recovered pane is a
  // new process — the variable died with the old one. A child that comes back
  // unbounded could negotiate its goal at `pr` and open exactly the second PR
  // the plan's narrowing forbade.
  const parsed = parsePlan({
    title: "同 repo 两任务",
    intent: "验证恢复后的站点上界",
    deliveryStation: "pr",
    tasks: [
      { id: "t1", title: "A", repo: "/repo" },
      { id: "t2", title: "B", repo: "/repo", execution: "parallel" },
    ],
  });
  assert.ok(parsed.plan, parsed.problems.join("; "));
  const world = makeFakeWorld({ plan: parsed.plan!, approvePlan: true, resolvableRepos: ["/repo"] });
  const childId = await spawnT1(world);
  const before = world.runtime().children[0]!;
  assert.equal(world.panes.get(before.paneId)!.env[STATION_CAP_ENV], "commit");
  assert.equal(world.panes.get(before.paneId)!.env[ACCEPTANCE_GATE_ENV], "off",
    "t1 is not the plan's last task");

  world.panes.get(before.paneId)!.alive = false;
  const recovered = await world.call("orchestrator_recover", { childId, reason: "机器睡眠" });
  assert.equal(recovered.isError, undefined, replyText(recovered));
  const after = world.runtime().children[0]!;
  assert.notEqual(after.paneId, before.paneId);
  assert.equal(world.panes.get(after.paneId)!.env[STATION_CAP_ENV], "commit",
    "a restart must not widen what the child was allowed to ship");
  assert.equal(world.panes.get(after.paneId)!.env[ACCEPTANCE_GATE_ENV], "off",
    "nor may it hand an ordinary task the acceptance entitlement");
});

test("the ceiling is counted with the PLAN's repo key, not the resolved checkout (round-1 P2)", async () => {
  // `resolveTaskRepo` returns a `git --show-toplevel`: a plan naming a
  // subdirectory or a symlinked path resolves SOMEWHERE ELSE. Counting the
  // narrowing with one key and spawning from the other is how a narrowed repo
  // hands its child an unlimited station — and the fake resolved every
  // declared repo to itself, so nothing could catch the two being mixed up.
  const parsed = parsePlan({
    title: "同 repo 两任务",
    intent: "声明的 repo 与解析结果不同",
    deliveryStation: "pr",
    tasks: [
      { id: "t1", title: "A", repo: "/repo/declared" },
      { id: "t2", title: "B", repo: "/repo/declared", execution: "parallel" },
    ],
  });
  assert.ok(parsed.plan, parsed.problems.join("; "));
  const world = makeFakeWorld({
    plan: parsed.plan!,
    approvePlan: true,
    resolvableRepos: ["/repo/declared"],
    taskRepoAliases: { "/repo/declared": "/repo/actual-toplevel" },
  });
  const childId = await spawnT1(world);
  const child = world.runtime().children.find((c) => c.id === childId)!;
  assert.equal(child.cwd, "/repo/actual-toplevel", "the child really works in the RESOLVED checkout");
  assert.equal(world.panes.get(child.paneId)!.env[STATION_CAP_ENV], "commit",
    "…but the narrowing is counted over the key the PLAN wrote, where both tasks live");
});

test("a recovery with NO approved snapshot gets the STRICTEST ceiling, never none (round-2 P2)", async () => {
  // The promise is "only ever stricter than the original dispatch". `undefined`
  // means NO ceiling — the opposite reading — and takeover-then-recover is
  // exactly the path where the snapshot is missing, because the successor has
  // not re-submitted the plan yet.
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  const before = world.runtime().children[0]!;
  world.saveRuntime({
    ...world.runtime(),
    approvedPlan: undefined,
    approvedPlanHash: undefined,
  });
  world.panes.get(before.paneId)!.alive = false;
  const recovered = await world.call("orchestrator_recover", { childId, reason: "接管后恢复" });
  assert.equal(recovered.isError, undefined, replyText(recovered));
  const after = world.runtime().children[0]!;
  assert.notEqual(after.paneId, before.paneId);
  assert.equal(world.panes.get(after.paneId)!.env[STATION_CAP_ENV], "precommit",
    "no plan on record ⇒ no authorization ⇒ the strictest station");
  assert.equal(world.panes.get(after.paneId)!.env[ACCEPTANCE_GATE_ENV], "off",
    "no plan on record ⇒ no acceptance entitlement either");
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

test("attach refuses an id that is not this repo's, or not on disk, or malformed", async () => {
  // B1 (2026-09-06): an id is ADOPTABLE now, so the refusals had to become
  // specific — each of these three would previously have been the same
  // "you do not carry it" answer, which said nothing about what to do.
  const world = makeFakeWorld();

  // Another repo's orchestration: the id carries a repo hash, and adopting it
  // would put this session's children on somebody else's channels.
  const foreignRepo = await world.call("orchestrator_attach", { orchestrationId: "orch-11111111-zzz" });
  assert.equal(foreignRepo.isError, true);
  assert.match(replyText(foreignRepo), /不是本仓库/);

  const malformed = await world.call("orchestrator_attach", { orchestrationId: "not-an-id" });
  assert.equal(malformed.isError, true);
  assert.match(replyText(malformed), /不像一个门禁铸造的编排 id/);

  // Every refusal hands back the way out, never a dead end.
  for (const reply of [foreignRepo, malformed]) {
    assert.match(replyText(reply), /orchestrator_plan\(\{ action: "archive" \}\)/,
      "the refusal must name the archive route");
  }
});

// ---------------------------------------------------------------------------
// B1 — the two ways out of "somebody else's plan is in this repo"
// ---------------------------------------------------------------------------

/** An orchestration id of the fake world's repo, minted like the gate does. */
function idOfFakeRepo(at: number): string {
  return newOrchestrationId("/repo", at);
}

/** The registry a dead project manager left behind in this repo. */
function previousHolder(at = 1_700_000_000_000) {
  const orchestrationId = idOfFakeRepo(at);
  return {
    orchestrationId,
    children: [{
      id: "t1-old",
      taskId: "t1",
      paneId: "%9",
      cwd: "/repo",
      createdAt: "2026-09-05T00:00:00.000Z",
    }],
    notify: { sentAt: [], lastByKey: {} },
  };
}

test("attach ADOPTS the previous holder's orchestration, registry included", async () => {
  // The measured situation: the manager's session died, its plan is still in
  // the repo, its child panes may still be alive — and the new session never
  // inherited the id, so before B1 this was unreachable and ended in `rm`.
  const recorded = previousHolder();
  const world = makeFakeWorld({
    plan: twoTaskPlan(),
    recordedRuntime: recorded,
    channelDirs: [recorded.orchestrationId],
  });

  const reply = await world.call("orchestrator_attach", { orchestrationId: recorded.orchestrationId });

  assert.equal(reply.isError, undefined, replyText(reply));
  assert.deepEqual(world.adopted, [recorded.orchestrationId], "the id must actually be adopted");
  assert.equal(world.runtime().orchestrationId, recorded.orchestrationId);
  assert.equal(world.runtime().children.length, 1, "the previous holder's registry comes with it");
  // AND THE CLAIM IS ON DISK, not just in memory (2026-09-17). `ownerSessionId`
  // exists to let THIS session resume the record after a reload, and a takeover
  // can be followed by nothing but `orchestrator_wait` for a long while — none
  // of which persists the runtime. Adopting without writing left the record
  // naming the previous session as owner, so the next reload refused it and
  // stranded the children this call had just adopted.
  assert.equal(world.runtimeWriteCount(), 1,
    "taking over an orchestration writes the new owner to the sidecar immediately");
  const text = replyText(reply);
  assert.match(text, /已接管编排/);
  assert.match(text, /尚未获批/, "the approval does NOT travel — the new holder must submit again");
  assert.ok(world.auditLog.some((line) => line.includes("taken over")), "a change of holder is logged");
});

test("attach does NOT write when the sidecar holds a DIFFERENT orchestration", async () => {
  // The durable claim is conditional, and this is the branch with consequences
  // (reviewer P1, 2026-09-17). `runtime()` answers `emptyRuntime(id)` for an id
  // the sidecar has no record of, so an unconditional write here would store an
  // empty runtime over the record beside it — the record of a DIFFERENT
  // orchestration, still describing its children, which is exactly what a later
  // takeover of THAT one needs to find.
  //
  // Remove the `if` in doAttach and this test is the only one that fails: the
  // rule itself is unit-tested (test/orchestrator-takeover.test.ts), but a rule
  // that is tested and not WIRED is not a guard.
  const recorded = previousHolder();
  const other = idOfFakeRepo(1_700_000_500_000);
  assert.notEqual(other, recorded.orchestrationId, "the two ids must differ for this to mean anything");
  const world = makeFakeWorld({
    plan: twoTaskPlan(),
    recordedRuntime: recorded,
    // Known to the discovery — its channel directory is on disk — but NOT in
    // this sidecar's runtime slot.
    channelDirs: [other],
  });

  const reply = await world.call("orchestrator_attach", { orchestrationId: other });

  assert.equal(reply.isError, undefined, replyText(reply));
  assert.deepEqual(world.adopted, [other], "the address is still adopted");
  assert.equal(world.runtime().orchestrationId, other);
  assert.equal(world.runtimeWriteCount(), 0,
    "the other orchestration's record must survive an adoption it has nothing to do with");
  assert.equal(world.deps.recordedRuntime?.()?.orchestrationId, recorded.orchestrationId,
    "and it is STILL the record on disk, not an empty runtime under the new id");
});

test("attach refuses to change identity once this session has children of its own", async () => {
  const recorded = previousHolder();
  const world = makeFakeWorld({
    plan: twoTaskPlan(),
    approvePlan: true,
    recordedRuntime: recorded,
    channelDirs: [recorded.orchestrationId],
  });
  await spawnT1(world);

  const reply = await world.call("orchestrator_attach", { orchestrationId: recorded.orchestrationId });

  assert.equal(reply.isError, true);
  assert.match(replyText(reply), /不能在运行中改换编排身份/);
  assert.deepEqual(world.adopted, [], "nothing may be adopted while children are registered");
});

test("plan write/submit REFUSE while the repo records another orchestration, and route out", async () => {
  const recorded = previousHolder();
  const world = makeFakeWorld({
    plan: twoTaskPlan(),
    recordedRuntime: recorded,
    channelDirs: [recorded.orchestrationId],
    identityConflict: recorded.orchestrationId,
  });

  for (const action of ["write", "submit"]) {
    const reply = await world.call("orchestrator_plan", {
      action,
      plan: {
        title: "我的计划",
        intent: "另起一轮",
        tasks: [{ id: "n1", title: "任务", repo: "/repo" }],
      },
    });
    assert.equal(reply.isError, true, `${action} must refuse`);
    const text = replyText(reply);
    assert.match(text, new RegExp(recorded.orchestrationId), "it names WHICH orchestration is in the way");
    assert.match(text, /orchestrator_attach/, "and both ways out");
    assert.match(text, /action: "archive"/);
  }

  // READ stays open: you must be able to look at what is in your way.
  const read = await world.call("orchestrator_plan", { action: "read" });
  assert.equal(read.isError, undefined, replyText(read));
});

test("archive REFUSES while a registered child pane is still alive", async () => {
  const recorded = previousHolder();
  const world = makeFakeWorld({ plan: twoTaskPlan(), recordedRuntime: recorded });
  // The dead manager's child pane is still up — that is what makes archiving
  // it the wrong move.
  world.panes.set("%9", { id: "%9", command: ["pi"], env: {}, alive: true });

  const reply = await world.call("orchestrator_plan", { action: "archive" });

  assert.equal(reply.isError, true);
  assert.match(replyText(reply), /还有 1 个子会话活着/);
  assert.match(replyText(reply), /orchestrator_attach/, "the honest alternative is a takeover");
  assert.ok(world.plan(), "nothing may move while somebody is working under that plan");
});

test("archive does NOTHING when the user declines (and when there is no dialog at all)", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), recordedRuntime: previousHolder() });
  // confirmAnswers is empty ⇒ the fake dialog answers false, which is also
  // exactly what a headless session does.
  const reply = await world.call("orchestrator_plan", { action: "archive" });

  assert.equal(reply.isError, true);
  assert.ok(world.plan(), "the plan must still be there");
  assert.equal(world.scratch.size, 0, "and nothing may have been written");
});

test("archive asks NOBODY when every task is done — and the receipt says what it took away", async () => {
  const finished = twoTaskPlan();
  const world = makeFakeWorld({
    plan: { ...finished, tasks: finished.tasks.map((t) => ({ ...t, status: "done" as const })) },
    recordedRuntime: previousHolder(),
  });
  // `confirmAnswers` stays EMPTY: the fake dialog answers "no row picked" to
  // anything it is asked, so an archive that succeeds here is an archive that
  // never opened a box (and it is also the headless case).
  const reply = await world.call("orchestrator_plan", { action: "archive" });

  assert.equal(reply.isError, undefined, replyText(reply));
  assert.equal(world.plan(), undefined, "the plan file is out of the way");
  assert.ok([...world.scratch.keys()].some((path) => path.includes("orchestrator-plan.archived-")),
    "the archive file must exist");
  assert.equal(world.deps.recordedRuntime()?.children.length, 0, "the registry went with it");
  const text = replyText(reply);
  assert.match(text, /orchestrator-plan\.archived-/, "the receipt names WHERE it landed");
  assert.match(text, /《测试计划》/, "…WHICH plan went away…");
  assert.match(text, /2 个任务/, "…how big it was…");
  assert.match(text, /没有删除任何东西/, "…and that nothing was destroyed");
});

test("archive moves the plan AND the registry aside, then the repo is free for a new plan", async () => {
  const recorded = previousHolder();
  const world = makeFakeWorld({ plan: twoTaskPlan(), recordedRuntime: recorded });
  world.confirmAnswers.push(true);

  const reply = await world.call("orchestrator_plan", { action: "archive" });

  assert.equal(reply.isError, undefined, replyText(reply));
  assert.equal(world.plan(), undefined, "the plan file is out of the way");
  const archived = [...world.scratch.entries()].find(([path]) => path.includes("orchestrator-plan.archived-"));
  assert.ok(archived, `an archive file must exist: ${[...world.scratch.keys()].join(", ")}`);
  const payload = JSON.parse(archived![1]);
  assert.equal(payload.plan.title, "测试计划", "the user's approved plan is preserved, never deleted");
  assert.equal(payload.orchestration.orchestrationId, recorded.orchestrationId,
    "the registry goes with it — leaving it behind would block every future spawn");
  // THE RECORD ITSELF must stop naming the old orchestration. Leaving it
  // behind is not cosmetic: `runtimeConflict` would then refuse every spawn
  // of the NEW orchestration forever, i.e. the session would have "cleaned
  // up" into a corner it cannot leave.
  const stillRecorded = world.deps.recordedRuntime();
  assert.notEqual(stillRecorded?.orchestrationId, recorded.orchestrationId,
    "the sidecar must no longer record the archived orchestration");
  assert.equal(stillRecorded?.children.length, 0, "and its registry is gone from the live record");
  assert.ok(world.auditLog.some((line) => line.includes("plan archived")), "the archive is logged");
});

test("archive still works when the plan file does NOT parse — that is the sealed-shut case", async () => {
  // THE DEAD END THIS PREVENTS. Every action below the plan-validation gate
  // answers "the plan file does not validate" and does nothing else. With a
  // corrupt plan AND another orchestration's runtime recorded, `write` is
  // refused by the identity guard and `archive` would be refused by the
  // parser — leaving `rm` as the only move, which is the exact situation the
  // action exists to remove. So the archive runs BEFORE the plan must parse.
  const recorded = previousHolder();
  const world = makeFakeWorld({ recordedRuntime: recorded, identityConflict: recorded.orchestrationId });
  // A plan file that exists but cannot be read as a plan.
  world.deps.readPlan = () => ({ problems: ["plan 文件不是合法 JSON：Unexpected token"] });
  world.confirmAnswers.push(true);

  const reply = await world.call("orchestrator_plan", { action: "archive" });

  assert.equal(reply.isError, undefined, replyText(reply));
  const archived = [...world.scratch.entries()].find(([path]) => path.includes("orchestrator-plan.archived-"));
  assert.ok(archived, "an unparseable plan must still be archivable");
  const payload = JSON.parse(archived![1]);
  assert.equal(payload.plan, undefined, "there is no parsed plan to record — and that is not a failure");
  assert.equal(payload.orchestration.orchestrationId, recorded.orchestrationId,
    "the registry is what makes it worth archiving here");
});

test("the archive reply reports what it actually moved, on both paths", async () => {
  // Same rule as the route text (round-1 P2): a receipt may not assert
  // something that did not happen. The registry-only path — a repo left over
  // from the `rm` era — archives no plan and renames no file.
  const withPlan = makeFakeWorld({ plan: twoTaskPlan(), recordedRuntime: previousHolder() });
  withPlan.confirmAnswers.push(true);
  const planReply = await withPlan.call("orchestrator_plan", { action: "archive" });
  assert.equal(planReply.details?.archivedPlan, true);
  assert.match(replyText(planReply), /已改名留在归档旁边/, "a plan file WAS renamed, so say so");

  const registryOnly = makeFakeWorld({ recordedRuntime: previousHolder() });
  registryOnly.confirmAnswers.push(true);
  const registryReply = await registryOnly.call("orchestrator_plan", { action: "archive" });
  assert.equal(registryReply.isError, undefined, replyText(registryReply));
  assert.equal(registryReply.details?.archivedPlan, false);
  assert.equal(registryReply.details?.archivedRuntime, true);
  assert.doesNotMatch(replyText(registryReply), /已改名/, "nothing was renamed — do not claim it was");
  assert.doesNotMatch(replyText(registryReply), /已让出来/, "there was no plan file occupying the slot");
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

// THE HANDOVER TESTS THAT USED TO LIVE HERE went with the tool they tested
// (`orchestrator_handoff`, retired 2026-09-14): handing over is every
// session's move now, exercised through `session_handoff`
// (test/session-handoff-tools.test.ts — skeleton, successor first message,
// release → open → silence ordering, rollback), while the orchestrator's own
// wiring is pinned at its registration site.

// ---------------------------------------------------------------------------
// notify IS NOT A TOOL ANY MORE (user decision, 2026-09-17)
// ---------------------------------------------------------------------------

test("no notification tool is registered, and the throttle lives in the policy module", async () => {
  const world = makeFakeWorld();
  for (const name of ["orchestrator_notify", "notify_user"]) {
    assert.equal(world.tools.get(name), undefined,
      `${name} would put the decision to interrupt the human back in the agent's hands`);
  }
  // The throttle itself is NOT gone — it is what keeps a long run from becoming
  // a pager storm — and it now guards the gate's own three senders.
  const key = notifyKey("完成 · x", "done");
  const history = recordNotify(emptyNotifyHistory(), key, 1_700_000_000_000);
  const again = decideNotify({ history, key, now: 1_700_000_000_001 });
  assert.equal(again.send, false);
});

// ---------------------------------------------------------------------------
// IDENTITY CONFLICT (2026-09-17): a new session must not adopt another
// orchestration's stale runtime
// ---------------------------------------------------------------------------

test("spawn REFUSES when the sidecar holds another orchestration's runtime", async () => {
  const world = makeFakeWorld({
    plan: twoTaskPlan(),
    approvePlan: true,
    // The session minted its own id, but the sidecar carries an old one.
    identityConflict: "orch-deadbeef-OLD",
  });
  const reply = await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  assert.equal(reply.isError, true, "a conflicting identity must fail the spawn");
  assert.match(replyText(reply), /orch-deadbeef-OLD/, "the foreign id is named");
  assert.match(replyText(reply), /无法继续旧编排/, "the refusal says why");
  assert.equal([...world.panes.values()].length, 1, "no pane is opened under the wrong identity");
});

test("spawn proceeds normally when the identity matches or is inherited", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const reply = await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  assert.equal(reply.isError, undefined, replyText(reply));
  const pane = [...world.panes.values()].find((p) => p.env[GATE_MODE_ENV] === "loop");
  assert.ok(pane, "the child pane opened as a loop session");
});

// ---------------------------------------------------------------------------
// THE HANDOFF'S BEHAVIOURAL PINS moved with the tool (2026-09-14).
//
// What they held — a release BEFORE the successor's boot, a silence only
// AFTER the record is persisted, and a rollback on both the refusing and the
// throwing tmux path — is now pinned in test/session-handoff-tools.test.ts,
// where the retirement seam is injected directly instead of through a tool
// that no longer exists.
// ---------------------------------------------------------------------------

