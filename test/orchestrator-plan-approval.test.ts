/**
 * THE APPROVAL DIALOG BUDGET — one plan, one interruption of the human.
 *
 * Round 4 measured the opposite: three approval dialogs in one orchestration,
 * the second one to an empty chair for 425 seconds, because the ONLY way to
 * change a file boundary was to rewrite the plan and rewriting the plan
 * revoked the approval. Both edits that caused it were the same honest
 * discovery — a module had to become two files to stay under the gate's own
 * 600-line rule — which an orchestrator cannot know at planning time.
 *
 * These tests pin the fix from both sides, because only having both makes it
 * safe: a NARROWING edit must never reach the user, and a WIDENING one must
 * always reach them. They also cover the two other things that made a plan
 * rewrite expensive — statuses being reset, and no audit standing between a
 * plan and the human.
 *
 * Protocol tests: the real tools, the real judgement, a fake world.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

import { makeFakeWorld, replyText, twoTaskPlan } from "./helpers/fake-orchestration.ts";
import {
  classifyBoundaryChange,
  decideApprovalCarry,
  boundaryDirPrefix,
  snapshotApprovedPlan,
} from "../lib/orchestrator-plan-approval.ts";
import { parsePlan, planHash, type OrchestratorPlan } from "../lib/orchestrator-plan.ts";
import { buildPlanConfirmMessage } from "../lib/orchestrator-tools.ts";


/** The plan shape the round-4 run actually used: one file per task. */
function fileGrainPlan(): OrchestratorPlan {
  const parsed = parsePlan({
    title: "重构计划",
    intent: "把三个工具搬进各自的模块",
    maxParallel: 2,
    tasks: [
      { id: "t1", title: "用户交互工具", fileBoundaries: ["lib/user-interaction-tools.ts"] },
      { id: "t2", title: "命令层", fileBoundaries: ["lib/gate-command-tools.ts"], dependsOn: ["t1"] },
      { id: "t3", title: "文档", fileBoundaries: ["docs/execution-model.md"], execution: "parallel" },
    ],
  });
  assert.ok(parsed.plan, parsed.problems.join("; "));
  return parsed.plan!;
}

function withTask(plan: OrchestratorPlan, id: string, patch: Partial<OrchestratorPlan["tasks"][number]>): OrchestratorPlan {
  return { ...plan, tasks: plan.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

function approved(plan: OrchestratorPlan) {
  return snapshotApprovedPlan(plan, planHash(plan), "2026-08-30T10:00:00.000Z");
}

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

test("THE round-4 case: splitting a module into a second file in the SAME directory keeps the approval", () => {
  const plan = fileGrainPlan();
  const next = withTask(plan, "t1", {
    fileBoundaries: ["lib/user-interaction-tools.ts", "lib/consent-request-tools.ts"],
  });
  const decision = decideApprovalCarry(approved(plan), next);
  assert.equal(decision.carries, true, decision.widenings.join("; "));

  assert.match(decision.amendments.join("\n"), /lib\/consent-request-tools\.ts/);
});

test("a NEW DIRECTORY always needs the user — a docs task cannot reach into lib/", () => {
  const plan = fileGrainPlan();
  const next = withTask(plan, "t3", {
    fileBoundaries: ["docs/execution-model.md", "lib/orchestrator-tools.ts"],
  });
  const decision = decideApprovalCarry(approved(plan), next);
  assert.equal(decision.carries, false);
  assert.match(decision.widenings.join("\n"), /不在任何已批准边界/);
});

test("a refinement that lands on ANOTHER task's turf needs the user, same directory or not", () => {
  const plan = fileGrainPlan();
  // t1 tries to take the file t2 already owns.
  const next = withTask(plan, "t1", {
    fileBoundaries: ["lib/user-interaction-tools.ts", "lib/gate-command-tools.ts"],
  });
  const decision = decideApprovalCarry(approved(plan), next);
  assert.equal(decision.carries, false);
  assert.match(decision.widenings.join("\n"), /与其他任务已声明的/);
});

test("a TOP-LEVEL file grants nothing around it — otherwise one file would mean the whole repo", () => {
  assert.equal(boundaryDirPrefix("README.md"), undefined);
  assert.equal(boundaryDirPrefix("lib"), undefined, "a bare `lib` is indistinguishable from a top-level file");
  assert.equal(boundaryDirPrefix("lib/a.ts"), "lib");
  assert.equal(boundaryDirPrefix("."), undefined);

  const { widenings } = classifyBoundaryChange({
    taskId: "t1",
    approvedBoundaries: ["README.md"],
    nextBoundaries: ["README.md", "package.json"],
    foreign: [],
  });
  assert.equal(widenings.length, 1, "a sibling of an approved top-level file is still a widening");
});

test("a declared DIRECTORY already covers new files under it — that is a refinement, not a grant", () => {
  const { widenings, amendments } = classifyBoundaryChange({
    taskId: "t1",
    approvedBoundaries: ["lib/"],
    nextBoundaries: ["lib/a.ts", "lib/b.ts"],
    foreign: [],
  });
  assert.deepEqual(widenings, []);
  assert.equal(amendments.some((a) => /收回了边界 lib/.test(a)), true, "and narrowing lib/ to two files is recorded");
});

test("every OTHER kind of widening still stops at the user", () => {
  const plan = fileGrainPlan();
  const base = approved(plan);

  const moreParallel = decideApprovalCarry(base, { ...plan, maxParallel: 4 });
  assert.equal(moreParallel.carries, false);

  const newTask = decideApprovalCarry(base, {
    ...plan,
    tasks: [...plan.tasks, { ...plan.tasks[0]!, id: "t4" }],
  });
  assert.equal(newTask.carries, false);

  const droppedDep = decideApprovalCarry(base, withTask(plan, "t2", { dependsOn: [] }));
  assert.equal(droppedDep.carries, false, "removing a dependency turns a serial chain into a race");

  const nowParallel = decideApprovalCarry(base, withTask(plan, "t1", { execution: "parallel" }));
  assert.equal(nowParallel.carries, false);
});

test("narrowing in every direction is free: fewer tasks, more dependencies, less parallelism", () => {
  const plan = fileGrainPlan();
  const base = approved(plan);
  const narrowed: OrchestratorPlan = {
    ...plan,
    maxParallel: 1,
    tasks: plan.tasks
      .filter((t) => t.id !== "t3")
      .map((t) => (t.id === "t1" ? { ...t, execution: "serial" as const } : { ...t, dependsOn: ["t1"] })),
  };
  const decision = decideApprovalCarry(base, narrowed);
  assert.equal(decision.carries, true, decision.widenings.join("; "));
  const changes = decision.amendments.join("\n");
  assert.match(changes, /已从 plan 中删除/, "dropping a task is recorded");
  assert.match(changes, /并行上限从 2 降到 1/, "and so is lowering the parallelism");

});

test("without a snapshot the gate cannot prove anything, so it asks — fail-closed", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  // Simulate an older/unreadable record: the hash is there, the snapshot is not.
  const runtime = world.runtime();
  world.deps.saveRuntime({ ...runtime, approvedPlan: undefined });

  const reply = await world.call("orchestrator_plan", {
    action: "write",
    plan: {
      title: "测试计划",
      intent: "两个互不重叠的任务",
      tasks: [
        { id: "t1", title: "任务一", fileBoundaries: ["lib/a/", "lib/a2/"] },
        { id: "t2", title: "任务二", fileBoundaries: ["lib/b/"] },
      ],
    },
  });
  assert.equal(reply.details?.approved, false);
  assert.match(replyText(reply), /授权快照/);
});

// ---------------------------------------------------------------------------
// The tool: end to end
// ---------------------------------------------------------------------------

test("the tool carries the approval across a narrowing edit — and records why nobody was asked", async () => {
  const world = makeFakeWorld({ plan: fileGrainPlan(), approvePlan: true });
  const before = world.runtime().approvedPlanHash;

  const reply = await world.call("orchestrator_plan", {
    action: "write",
    plan: {
      title: "重构计划",
      intent: "把三个工具搬进各自的模块",
      maxParallel: 2,
      tasks: [
        {
          id: "t1",
          title: "用户交互工具",
          fileBoundaries: ["lib/user-interaction-tools.ts", "lib/consent-request-tools.ts"],
        },
        { id: "t2", title: "命令层", fileBoundaries: ["lib/gate-command-tools.ts"], dependsOn: ["t1"] },
        { id: "t3", title: "文档", fileBoundaries: ["docs/execution-model.md"], execution: "parallel" },
      ],
    },
  });

  assert.equal(reply.details?.approved, true, replyText(reply));
  assert.equal(reply.details?.amended, true);
  const after = world.runtime();
  assert.notEqual(after.approvedPlanHash, before, "the approval MOVED to the new content");
  assert.equal(after.approvedPlanHash, planHash(world.plan()!), "and matches what is on disk");
  assert.equal(after.approvalAmendments?.length, 1, "the audit trail records the migration");
  assert.match(after.approvalAmendments![0]!.changes.join("\n"), /consent-request-tools/);
  assert.equal(world.confirmAnswers.length, 0, "no dialog was consumed");
});

test("a spawn is still authorized after the boundary was refined — the whole point", async () => {
  const world = makeFakeWorld({ plan: fileGrainPlan(), approvePlan: true });
  await world.call("orchestrator_plan", {
    action: "write",
    plan: {
      title: "重构计划",
      intent: "把三个工具搬进各自的模块",
      maxParallel: 2,
      tasks: [
        {
          id: "t1",
          title: "用户交互工具",
          fileBoundaries: ["lib/user-interaction-tools.ts", "lib/consent-request-tools.ts"],
        },
        { id: "t2", title: "命令层", fileBoundaries: ["lib/gate-command-tools.ts"], dependsOn: ["t1"] },
        { id: "t3", title: "文档", fileBoundaries: ["docs/execution-model.md"], execution: "parallel" },
      ],
    },
  });
  const spawn = await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  assert.equal(spawn.isError, undefined, replyText(spawn));
});

test("`write` PRESERVES task status and note — a rewrite is not an execution reset", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await world.call("orchestrator_plan", { action: "set-status", taskId: "t1", status: "running" });
  await world.call("orchestrator_plan", { action: "set-status", taskId: "t1", status: "done", note: "已合并" });
  await world.call("orchestrator_plan", { action: "set-status", taskId: "t2", status: "running" });

  await world.call("orchestrator_plan", {
    action: "write",
    plan: {
      title: "测试计划",
      intent: "两个互不重叠的任务",
      tasks: [
        { id: "t1", title: "任务一", fileBoundaries: ["lib/a/"] },
        { id: "t2", title: "任务二", fileBoundaries: ["lib/b/"] },
        { id: "t3", title: "新任务", fileBoundaries: ["docs/"] },
      ],
    },
  });

  const plan = world.plan()!;
  assert.equal(plan.tasks.find((t) => t.id === "t1")?.status, "done", "a merged task must not be reported as pending");
  assert.equal(plan.tasks.find((t) => t.id === "t1")?.note, "已合并");
  assert.equal(plan.tasks.find((t) => t.id === "t2")?.status, "running");
  assert.equal(plan.tasks.find((t) => t.id === "t3")?.status, "pending", "only a NEW task starts at pending");
});

// ---------------------------------------------------------------------------
// The audit that now stands between a plan and the human
// ---------------------------------------------------------------------------

test("submit runs the audit FIRST, and a failed audit opens no dialog at all", async () => {
  const world = makeFakeWorld({
    plan: twoTaskPlan(),
    planAuditFails: "review-gate: plan 审计**没过** —— t2 的边界漏了测试落点。",
  });
  world.confirmAnswers.push(true); // would approve, if it were ever asked

  const reply = await world.call("orchestrator_plan", { action: "submit" });

  assert.equal(reply.isError, true);
  assert.match(replyText(reply), /审计\*\*没过\*\*/);
  assert.equal(world.planAudits(), 1, "the audit ran");
  assert.equal(world.confirmAnswers.length, 1, "and the dialog was never shown — the answer is untouched");
  assert.equal(world.runtime().approvedPlanHash, undefined, "nothing was approved");
});

test("a passing audit is followed by the dialog, and approval records the snapshot", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan() });
  world.confirmAnswers.push(true);

  const reply = await world.call("orchestrator_plan", { action: "submit" });

  assert.equal(reply.details?.approved, true, replyText(reply));
  assert.equal(world.planAudits(), 1);
  const runtime = world.runtime();
  assert.equal(runtime.approvedPlanHash, planHash(world.plan()!));
  assert.equal(runtime.approvedPlan?.tasks.length, 2, "WHAT was approved is recorded, not just its hash");
  assert.deepEqual(runtime.approvalAmendments, [], "a fresh approval starts with a clean trail");
});

test("the approval dialog states the boundary semantics the user actually agreed to", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan() });
  world.confirmAnswers.push(true);
  await world.call("orchestrator_plan", { action: "submit" });

  // BOTH surfaces are pinned, because the rule they describe is the one thing
  // in this round that WIDENS what an approval means. A user who learns it
  // afterwards did not agree to it, so this copy is a criterion, not prose.
  const transcript = world.shown.join("\n");
  assert.match(transcript, /同一目录内/, "the transcript says what an approved boundary absorbs");
  assert.match(transcript, /不与其他任务重叠/, "and the limit on it");
  assert.match(transcript, /新增任务|新目录/, "and what still comes back to them");

  const dialog = buildPlanConfirmMessage(world.plan()!);
  assert.match(dialog, /文件细化不会再问/, "the decision box carries the same rule, not a softer one");
  assert.match(dialog, /新增任务、碰到新目录/, "including what does invalidate the approval");
});

