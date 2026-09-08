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
  decideApprovalCarry,
  snapshotApprovedPlan,
} from "../lib/orchestrator-plan-approval.ts";
import { parsePlan, planHash, type OrchestratorPlan } from "../lib/orchestrator-plan.ts";
import { buildPlanConfirmMessage } from "../lib/orchestrator-tools.ts";
import { normalizeRuntime } from "../lib/orchestrator-registry.ts";


/** The plan shape the round-4 run actually used: one file per task. */
function fileGrainPlan(): OrchestratorPlan {
  const parsed = parsePlan({
    title: "重构计划",
    intent: "把三个工具搬进各自的模块",
    maxParallel: 2,
    tasks: [
      { id: "t1", title: "用户交互工具", repo: "/repo" },
      { id: "t2", title: "命令层", repo: "/repo", dependsOn: ["t1"] },
      { id: "t3", title: "文档", repo: "/repo", execution: "parallel" },
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

test("THE round-4 case is gone by construction: a plan task declares no files at all", () => {
  // Measured in round 4: a module had to become two files to stay under the
  // gate's own 600-line rule, the plan's boundary had to be widened, and the
  // approval dialog popped a second time — to an empty chair for 425 seconds.
  // File boundaries were removed on 2026-09-17 (user decision), so the edit
  // that caused it cannot exist: a child writes wherever its own repo needs,
  // and the plan is unaffected.
  const plan = fileGrainPlan();
  for (const task of plan.tasks) {
    assert.deepEqual(
      Object.keys(task).sort(),
      ["dependsOn", "execution", "id", "note", "repo", "status", "title"],
      "a task carries no file scope at all",
    );
  }
  const decision = decideApprovalCarry(approved(plan), withTask(plan, "t1", { note: "拆成两个文件" }));
  assert.equal(decision.carries, true, "a note-only edit still carries");
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

  const movedRepo = decideApprovalCarry(base, withTask(plan, "t1", { repo: "/other-repo" }));
  assert.equal(movedRepo.carries, false, "moving a task to another repo is a NEW write surface");
  assert.match(movedRepo.widenings.join("\n"), /repo/, "the widening names the repo change");
});

test("the DELIVERY STATION is authority: raising it revokes, lowering it carries", () => {
  // 2026-09-06. `pr` authorizes the orchestration to publish; nobody may hand
  // it that between two dialogs. The mirror case matters just as much: a
  // manager tightening its own contract must not have to wake the user.
  const plan = fileGrainPlan();
  const base = approved({ ...plan, deliveryStation: "precommit" });

  const raised = decideApprovalCarry(base, { ...plan, deliveryStation: "pr" });
  assert.equal(raised.carries, false);
  assert.match(raised.widenings.join("\n"), /交付站点/, "the widening says what changed");

  const tightened = decideApprovalCarry(
    approved({ ...plan, deliveryStation: "pr" }), { ...plan, deliveryStation: "commit" },
  );
  assert.equal(tightened.carries, true);
  assert.match(tightened.amendments.join("\n"), /交付站点/, "…and a tightening is still recorded");

  const unchanged = decideApprovalCarry(base, { ...plan, deliveryStation: "precommit" });
  assert.deepEqual(unchanged.widenings, []);
  assert.deepEqual(unchanged.amendments, []);
});

test("a snapshot from BEFORE the station existed is read as the strictest one", () => {
  // Old runtimes on disk have no `deliveryStation`. Reading that as "whatever
  // the new plan says" would silently grant `pr`; reading it as `precommit`
  // can only cost one dialog.
  const plan = fileGrainPlan();
  const legacy = { ...approved(plan), deliveryStation: undefined };
  assert.equal(decideApprovalCarry(legacy, { ...plan, deliveryStation: "pr" }).carries, false);
  assert.equal(decideApprovalCarry(legacy, { ...plan, deliveryStation: "precommit" }).carries, true);
});

test("the approved station SURVIVES the runtime round trip", () => {
  // `normalizeApprovedPlan` rebuilds the snapshot field by field, so a field
  // it does not know is silently dropped — which would make every later
  // station change look like it started from `precommit`.
  const plan = { ...fileGrainPlan(), deliveryStation: "pr" as const };
  const runtime = normalizeRuntime({
    orchestrationId: "orch-deadbeef-abc",
    children: [],
    notify: { sentAt: [], lastByKey: {} },
    approvedPlanHash: planHash(plan),
    approvedPlanAt: "2026-09-06T10:00:00.000Z",
    approvedPlan: snapshotApprovedPlan(plan, planHash(plan), "2026-09-06T10:00:00.000Z"),
  }, "orch-deadbeef-abc");
  assert.ok(runtime, "the runtime must survive normalization for this test to mean anything");
  assert.equal(runtime.approvedPlan?.deliveryStation, "pr");
  // …and with it on record, dropping back to `commit` is an amendment rather
  // than a re-approval.
  assert.equal(
    decideApprovalCarry(runtime.approvedPlan!, { ...plan, deliveryStation: "commit" }).carries,
    true,
  );
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
        { id: "t1", title: "任务一", repo: "/repo" },
        { id: "t2", title: "任务二", repo: "/repo" },
      ],
    },
  });
  assert.equal(reply.details?.approved, false);
  assert.match(replyText(reply), /授权快照/);
});

// ---------------------------------------------------------------------------
// The tool: end to end
// ---------------------------------------------------------------------------

test("the tool carries the approval across an amendable edit — and records why nobody was asked", async () => {
  const world = makeFakeWorld({ plan: fileGrainPlan(), approvePlan: true });
  const before = world.runtime().approvedPlanHash;

  const reply = await world.call("orchestrator_plan", {
    action: "write",
    plan: {
      title: "重构计划",
      intent: "把三个工具搬进各自的模块",
      maxParallel: 1,
      tasks: [
        { id: "t1", title: "用户交互工具", repo: "/repo" },
        { id: "t2", title: "命令层", repo: "/repo", dependsOn: ["t1", "t3"] },
        { id: "t3", title: "文档", repo: "/repo", execution: "serial" },
      ],
    },
  });

  assert.equal(reply.details?.approved, true, replyText(reply));
  assert.equal(reply.details?.amended, true);
  const after = world.runtime();
  assert.notEqual(after.approvedPlanHash, before, "the approval MOVED to the new content");
  assert.equal(after.approvedPlanHash, planHash(world.plan()!), "and matches what is on disk");
  assert.equal(after.approvalAmendments?.length, 1, "the audit trail records the migration");
  assert.match(after.approvalAmendments![0]!.changes.join("\n"), /前置依赖/);
  assert.equal(world.confirmAnswers.length, 0, "no dialog was consumed");
});

test("a spawn is still authorized after an amendable edit — the whole point", async () => {
  const world = makeFakeWorld({ plan: fileGrainPlan(), approvePlan: true });
  await world.call("orchestrator_plan", {
    action: "write",
    plan: {
      title: "重构计划",
      intent: "把三个工具搬进各自的模块",
      maxParallel: 1,
      tasks: [
        { id: "t1", title: "用户交互工具", repo: "/repo" },
        { id: "t2", title: "命令层", repo: "/repo", dependsOn: ["t1", "t3"] },
        { id: "t3", title: "文档", repo: "/repo", execution: "serial" },
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
        { id: "t1", title: "任务一", repo: "/repo" },
        { id: "t2", title: "任务二", repo: "/repo" },
        { id: "t3", title: "新任务", repo: "/repo" },
      ],
    },
  });

  const plan = world.plan()!;
  assert.equal(plan.tasks.find((t) => t.id === "t1")?.status, "done", "a merged task must not be reported as pending");
  assert.equal(plan.tasks.find((t) => t.id === "t1")?.note, "已合并");
  assert.equal(plan.tasks.find((t) => t.id === "t2")?.status, "running");
  assert.equal(plan.tasks.find((t) => t.id === "t3")?.status, "pending", "only a NEW task starts at pending");
});

test("`write` ACCEPTS a note update for an existing task, and the approval survives it", async () => {
  // B2b (2026-09-06, user decision): the note is prose for a human. It is
  // outside `canonicalPlanText`, outside the approved snapshot and outside
  // `decideApprovalCarry`, so writing one grants nothing — and dropping it
  // was a silent data loss the last four orchestrations all worked around.
  // The fixture declares `repo`, because a `write` must declare it (strictRepo)
  // — without it the rewrite would differ from the approved content in a field
  // that DOES grant something, and the approval would be revoked for a reason
  // that has nothing to do with the note.
  const approved = parsePlan({
    title: "测试计划",
    intent: "两个互不重叠的任务",
    tasks: [
      { id: "t1", title: "任务一", repo: "/repo" },
      { id: "t2", title: "任务二", repo: "/repo" },
    ],
  }, undefined, true);
  assert.ok(approved.plan, `fixture must parse: ${approved.problems.join("; ")}`);
  const world = makeFakeWorld({ plan: approved.plan!, approvePlan: true });
  await world.call("orchestrator_plan", { action: "set-status", taskId: "t1", status: "running", note: "旧备注" });

  const written = await world.call("orchestrator_plan", {
    action: "write",
    plan: {
      title: "测试计划",
      intent: "两个互不重叠的任务",
      tasks: [
        { id: "t1", title: "任务一", repo: "/repo", note: "新备注" },
        { id: "t2", title: "任务二", repo: "/repo" },
      ],
    },
  });

  const plan = world.plan()!;
  assert.equal(plan.tasks.find((t) => t.id === "t1")?.note, "新备注", "the note the caller wrote must land");
  assert.equal(plan.tasks.find((t) => t.id === "t1")?.status, "running", "the status is still execution's");
  assert.equal(written.details?.approved, true, "a note is not a widening — the approval must survive");
});

// ---------------------------------------------------------------------------
// B2 (2026-09-06) — the approval and its audit leave a trail OUTSIDE the
// sidecar. The sidecar is reset by the next session that opens this repo, so
// a record that lives only there stops existing exactly when somebody asks
// "who approved this, when, against which content".
// ---------------------------------------------------------------------------

test("the USER's approval is written to the audit log, bound to the content hash", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan() });
  world.confirmAnswers.push(true);

  await world.call("orchestrator_plan", { action: "submit" });

  const line = world.auditLog.find((entry) => entry.includes("plan approved by the user"));
  assert.ok(line, `the approval must be logged; log was: ${world.auditLog.join(" | ")}`);
  assert.match(line!, new RegExp(planHash(world.plan()!)), "the log line names the approved content");
});

test("an approval CARRIED across an amendable edit is logged with its reasons", async () => {
  const world = makeFakeWorld({ plan: fileGrainPlan(), approvePlan: true });
  const before = world.runtime().approvedPlanHash!;

  await world.call("orchestrator_plan", {
    action: "write",
    plan: {
      title: "重构计划",
      intent: "把三个工具搬进各自的模块",
      maxParallel: 1,
      tasks: [
        { id: "t1", title: "用户交互工具", repo: "/repo" },
        { id: "t2", title: "命令层", repo: "/repo", dependsOn: ["t1", "t3"] },
        { id: "t3", title: "文档", repo: "/repo", execution: "serial" },
      ],
    },
  });

  const line = world.auditLog.find((entry) => entry.includes("approval carried"));
  assert.ok(line, `a carry decides on the user's behalf and must be logged: ${world.auditLog.join(" | ")}`);
  assert.match(line!, new RegExp(before), "the line names where the approval came FROM");
  assert.match(line!, /前置依赖/, "and why it was allowed to move");
});

test("an approval REVOKED by a widening edit is logged with the widening", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });

  await world.call("orchestrator_plan", {
    action: "write",
    plan: {
      title: "测试计划",
      intent: "两个互不重叠的任务",
      tasks: [
        { id: "t1", title: "任务一", repo: "/repo" },
        { id: "t2", title: "任务二", repo: "/repo" },
        { id: "t3", title: "新任务", repo: "/repo" },
      ],
    },
  });

  const line = world.auditLog.find((entry) => entry.includes("approval REVOKED"));
  assert.ok(line, `a revocation must be logged: ${world.auditLog.join(" | ")}`);
  assert.match(line!, /t3|新任务/, "the line says what widened");
});


// ---------------------------------------------------------------------------
// Taking a widening BACK (round-8): the approval returns to content it had
// ---------------------------------------------------------------------------

/** `fileGrainPlan` as the tool's argument, so a write can reproduce it exactly. */
function fileGrainParams(
  patch: (tasks: Array<Record<string, unknown>>) => Array<Record<string, unknown>> = (t) => t,
): Record<string, unknown> {
  const plan = fileGrainPlan();
  return {
    title: plan.title,
    intent: plan.intent,
    maxParallel: plan.maxParallel,
    tasks: patch(plan.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      repo: t.repo,
      dependsOn: [...t.dependsOn],
      execution: t.execution,
    }))),
  };
}

/** Move one task to another repo in that argument — this suite's widening. */
function withRepo(tasks: Array<Record<string, unknown>>, id: string, repo: string) {
  return tasks.map((t) => (t.id === id ? { ...t, repo } : t));
}

/** Tighten one task's execution in that argument — this suite's amendment. */
function withExecution(tasks: Array<Record<string, unknown>>, id: string, execution: string) {
  return tasks.map((t) => (t.id === id ? { ...t, execution } : t));
}

test("writing a widening BACK restores the approval — hash, snapshot and timestamp", async () => {
  // ROUND-8, measured: a task's repo was changed by mistake, the gate
  // correctly revoked, the manager wrote the plan back BYTE FOR BYTE — and
  // still had to pay a goal-auditor round plus a dialog to get the approval it
  // already had.
  const world = makeFakeWorld({ plan: fileGrainPlan(), approvePlan: true });
  const approvedHash = world.runtime().approvedPlanHash;

  const widened = await world.call("orchestrator_plan", {
    action: "write",
    plan: fileGrainParams((tasks) => withRepo(tasks, "t3", "/other-repo")),
  });
  assert.equal(widened.details?.approved, false, "the widening is still refused");
  assert.equal(world.runtime().approvedPlanHash, undefined, "and the approval is really gone");

  const back = await world.call("orchestrator_plan", { action: "write", plan: fileGrainParams() });

  assert.equal(back.details?.approved, true, replyText(back));
  assert.equal(back.details?.restored, true);
  const runtime = world.runtime();
  assert.equal(runtime.approvedPlanHash, approvedHash, "the approval returned to the content it had");
  assert.ok(runtime.approvedPlanAt, "with a timestamp");
  assert.equal(runtime.approvedPlan?.tasks.length, 3, "and the authorizing snapshot, not just the hash");
  assert.equal(world.confirmAnswers.length, 0, "no dialog was consumed");
  assert.ok(
    world.auditLog.some((entry) => entry.includes("approval RESTORED")),
    `the restoration is logged: ${world.auditLog.join(" | ")}`,
  );
});

test("after a restore the NEXT refinement still carries — the snapshot really came back", async () => {
  // A hash-only restore would leave the following edit facing "the gate has
  // no authorizing snapshot", which is the dialog this whole path removes.
  const world = makeFakeWorld({ plan: fileGrainPlan(), approvePlan: true });
  await world.call("orchestrator_plan", {
    action: "write",
    plan: fileGrainParams((tasks) => withRepo(tasks, "t3", "/other-repo")),
  });
  await world.call("orchestrator_plan", { action: "write", plan: fileGrainParams() });

  const refined = await world.call("orchestrator_plan", {
    action: "write",
    plan: fileGrainParams((tasks) => withExecution(tasks, "t3", "serial")),
  });

  assert.equal(refined.details?.approved, true, replyText(refined));
  assert.equal(refined.details?.amended, true);
  assert.match(replyText(refined), /parallel 改成 serial/);
  assert.equal(world.confirmAnswers.length, 0, "still nobody was asked");
});

test("a NEW user approval resets the lineage — a version they moved away from cannot come back", async () => {
  // THE ESCALATION THIS CLOSES: approval A carries to an amendable B; the user
  // later signs a plan C that moves a task to ANOTHER repo. Without the reset,
  // hash(B) would still be on record and writing B back would hand the
  // orchestration a repo the user had just taken away.
  const world = makeFakeWorld({ plan: fileGrainPlan(), approvePlan: true });
  const carriedVersion = fileGrainParams((tasks) => withExecution(tasks, "t3", "serial"));

  const carried = await world.call("orchestrator_plan", { action: "write", plan: carriedVersion });
  assert.equal(carried.details?.approved, true, "B was authorized at the time");

  // The user is asked again about a plan that moves t2 to another repo …
  await world.call("orchestrator_plan", {
    action: "write",
    plan: fileGrainParams((tasks) => withRepo(tasks, "t2", "/other-repo")),
  });
  world.confirmAnswers.push(true);
  const approvedC = await world.call("orchestrator_plan", { action: "submit" });
  assert.equal(approvedC.details?.approved, true, replyText(approvedC));
  assert.deepEqual(
    world.runtime().approvedPlanHistory?.length,
    1,
    "their decision starts the lineage over",
  );

  // … and B, which the earlier approval had carried to, is now a widening.
  const reWidened = await world.call("orchestrator_plan", { action: "write", plan: carriedVersion });

  assert.equal(reWidened.details?.approved, false, replyText(reWidened));
  assert.notEqual(reWidened.details?.restored, true, "restoring it would hand back what the user removed");
  assert.equal(world.runtime().approvedPlanHash, undefined);
});

test("without a lineage on record there is nothing to restore — the user is asked", async () => {
  // This is the state a MALFORMED lineage leaves behind: normalizeRuntime
  // drops the whole list (lib/orchestrator-registry.ts), so a forged record
  // buys exactly what an absent one does — a dialog.
  const world = makeFakeWorld({ plan: fileGrainPlan(), approvePlan: true });
  world.deps.saveRuntime({
    ...world.runtime(),
    approvedPlanHash: undefined,
    approvedPlanAt: undefined,
    approvedPlan: undefined,
    approvedPlanHistory: undefined,
  });

  const back = await world.call("orchestrator_plan", { action: "write", plan: fileGrainParams() });

  assert.notEqual(back.details?.approved, true, replyText(back));
  assert.notEqual(back.details?.restored, true);
  assert.match(replyText(back), /尚未获得用户批准/);
  assert.equal(world.runtime().approvedPlanHash, undefined);
});



// ---------------------------------------------------------------------------
// The audit that now stands between a plan and the human
// ---------------------------------------------------------------------------

test("submit REFUSES before the audit when nothing was restated — no dialog, no judge", async () => {
  // 2026-09-06: the restatement is the earlier step of the same negotiation.
  // Checking it after the audit would bill the user minutes for a plan built
  // on a reading nobody confirmed.
  const world = makeFakeWorld({ plan: twoTaskPlan(), restatement: null });
  world.confirmAnswers.push(true); // would approve, if it were ever asked

  const reply = await world.call("orchestrator_plan", { action: "submit" });

  assert.equal(reply.isError, true);
  assert.equal(reply.details?.restated, false);
  assert.equal(world.planAudits(), 0, "the minutes-long audit never started");
  assert.equal(world.confirmAnswers.length, 1, "and the user was never shown a dialog");
  assert.equal(world.runtime().approvedPlanHash, undefined);
  // The refusal has to get the NEXT session unstuck by itself.
  assert.match(replyText(reply), /propose_restatement/);
  assert.match(replyText(reply), /station/);
  // The misjudgement route has to be one that exists: a tool refusal records
  // no arbitrable block, so `request_arbitration` would be denied — or spend
  // one of three appeals on an unrelated older block (2026-09-06).
  assert.match(replyText(reply), /ask_user/);
  assert.doesNotMatch(replyText(reply), /request_arbitration/);

});

test("submit proceeds once a confirmed restatement is on record", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan() }); // the world restates by default
  world.confirmAnswers.push(true);
  const reply = await world.call("orchestrator_plan", { action: "submit" });
  assert.equal(reply.details?.approved, true, replyText(reply));
  assert.equal(world.planAudits(), 1);
});


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

test("the approval dialog states what an approval still covers", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan() });
  world.confirmAnswers.push(true);
  await world.call("orchestrator_plan", { action: "submit" });

  // BOTH surfaces are pinned, because the rule they describe is what an
  // approval MEANS. A user who learns it afterwards did not agree to it, so
  // this copy is a criterion, not prose.
  const transcript = world.shown.join("\n");
  assert.match(transcript, /不需要再报备/, "the transcript says a task's file choice no longer comes back");
  assert.match(transcript, /把任务换到另一个 repo/, "and what still does come back");
  assert.match(transcript, /写回你此前批准过的内容/, "taking a widening back does not re-ask");
  assert.match(transcript, /每批准一次新内容，之前那条链就作废/, "with the limit on that");

  const dialog = buildPlanConfirmMessage(world.plan()!);
  assert.match(dialog, /改哪些文件不再报备/, "the decision box carries the same rule, not a softer one");
  assert.match(dialog, /把任务换到另一个 repo/, "including what does invalidate the approval");
  assert.match(dialog, /写回你批准过的内容/);
});

test("both consent surfaces state the DELIVERY STATION and that raising it re-asks", async () => {
  // 2026-09-06 (reviewer P2): `decideApprovalCarry` treats a raised station as
  // a widening, so the user has to have been told two things — which station
  // they are approving, and that moving it later comes back to them. A rule
  // the user meets afterwards is not a rule they agreed to.
  const plan = { ...twoTaskPlan(), deliveryStation: "commit" as const };
  const world = makeFakeWorld({ plan });
  world.confirmAnswers.push(true);
  await world.call("orchestrator_plan", { action: "submit" });

  const transcript = world.shown.join("\n");
  assert.match(transcript, /本轮交付站点/, "the plan the user reads names its station");
  assert.match(transcript, /交付站点往后挪/, "…and says that moving it re-asks");

  const dialog = buildPlanConfirmMessage(world.plan()!);
  assert.match(dialog, /本轮交付站点/, "the decision box carries the station itself");
  assert.match(dialog, /提高交付站点/, "…and lists it among the changes that revoke the approval");
});

