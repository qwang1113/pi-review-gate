import test from "node:test";
import assert from "node:assert/strict";

import {
  ORCHESTRATOR_DOC_PATTERN,
  formatOrchestrationStatus,
  humanOnlyDecision,
  notifyAuthorization,
  orchestratorDoneProblems,
  orchestratorWriteBlock,
  proxyApprovalProblems,
  spawnAuthorization,
  type OrchestratorDoneFacts,
} from "../lib/orchestrator-gate.ts";
import { parsePlan, planHash, type OrchestratorPlan, type PlanTask } from "../lib/orchestrator-plan.ts";
import { emptyRuntime, registerChild, type OrchestratorRuntime } from "../lib/orchestrator-registry.ts";

const NOW = "2026-08-29T12:00:00.000Z";

function planOf(overrides: Record<string, unknown> = {}): OrchestratorPlan {
  const parsed = parsePlan({
    title: "t", intent: "i",
    tasks: [{ id: "a", title: "a", fileBoundaries: ["lib/orchestrator"] }],
    ...overrides,
  }, NOW);
  assert.ok(parsed.ok, parsed.problems.join("; "));
  return parsed.plan!;
}

function approved(plan: OrchestratorPlan): OrchestratorRuntime {
  return { ...emptyRuntime("orch-abc-1"), approvedPlanHash: planHash(plan), approvedPlanAt: NOW };
}

function doneFacts(overrides: Partial<OrchestratorDoneFacts> = {}): OrchestratorDoneFacts {
  return {
    plan: planOf({ tasks: [{ id: "a", title: "a", fileBoundaries: ["lib"], status: "done" }] }),
    runtime: emptyRuntime("orch-abc-1"),
    alivePaneIds: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CONSTRAINT 1 — nothing starts before the user approved the plan
// ---------------------------------------------------------------------------

test("CONSTRAINT 1: no plan, or an unapproved one, means no spawning", () => {
  const plan = planOf();
  const noPlan = spawnAuthorization(emptyRuntime("orch-abc-1"), undefined);
  assert.equal(noPlan.ok, false);
  if (!noPlan.ok) assert.match(noPlan.reason, /还没有 plan/);

  const unapproved = spawnAuthorization(emptyRuntime("orch-abc-1"), plan);
  assert.equal(unapproved.ok, false);
  if (!unapproved.ok) assert.match(unapproved.reason, /自己写 plan 文件不算数/);

  assert.deepEqual(spawnAuthorization(approved(plan), plan), { ok: true });
});

test("CONSTRAINT 1: editing the plan after approval revokes it", () => {
  const plan = planOf();
  const runtime = approved(plan);
  const widened = planOf({ tasks: [{ id: "a", title: "a", fileBoundaries: ["."] }] });
  const result = spawnAuthorization(runtime, widened);
  assert.equal(result.ok, false, "otherwise 'approved' would mean 'was approved once, for something else'");
  if (!result.ok) assert.match(result.reason, /获批之后被改过/);
});

// ---------------------------------------------------------------------------
// CONSTRAINT 2 — the orchestrator does not write code
// ---------------------------------------------------------------------------

test("CONSTRAINT 2: only the plan scope and handoff docs are writable", () => {
  const allowed = [".pi/orchestrator-plan.json", ".pi/loop-goal.md", "docs/orchestrator-handoff.md"];
  for (const relPath of allowed) {
    assert.equal(orchestratorWriteBlock({ relPath, taskMode: "orchestrator" }), undefined, `${relPath} must pass`);
  }
  for (const relPath of ["lib/thing.ts", "test/a.test.ts", "docs/design.md", "README.md", "package.json"]) {
    const blocked = orchestratorWriteBlock({ relPath, taskMode: "orchestrator" });
    assert.ok(blocked, `${relPath} must be refused`);
    assert.match(blocked, /orchestrator_spawn/, "the refusal names the alternative — delegate it");
  }
});

test("CONSTRAINT 2 applies ONLY in orchestrator mode", () => {
  for (const mode of ["loop", "explore", "normal", undefined] as const) {
    assert.equal(orchestratorWriteBlock({ relPath: "lib/thing.ts", taskMode: mode }), undefined,
      `an ordinary ${mode ?? "undecided"} session writes code — that is its job`);
  }
});

test("CONSTRAINT 2: the relay's own handoff path is writable while the relay stands", () => {
  assert.ok(orchestratorWriteBlock({ relPath: "docs/handover.md", taskMode: "orchestrator" }),
    "an arbitrary doc is still refused");
  assert.equal(
    orchestratorWriteBlock({
      relPath: "docs/handover.md",
      taskMode: "orchestrator",
      relayHandoffPath: "docs/handover.md",
    }),
    undefined,
  );
  assert.match("docs/orchestrator-handoff.md", ORCHESTRATOR_DOC_PATTERN);
  assert.doesNotMatch("docs/nested/orchestrator-x.md", ORCHESTRATOR_DOC_PATTERN,
    "the pattern is anchored — it is a specific place, not a name anywhere");
});


// ---------------------------------------------------------------------------
// CONSTRAINT 8 — a proxied goal stays inside the task
// ---------------------------------------------------------------------------

test("R3-1: constraint 8 is judged on EDITED FILES, so prose about paths cannot refuse a goal", () => {
  // The measured failure: a documentation task whose exit criteria said "可逐
  // 条对照 `lib/orchestrator-probe.ts`" and whose non-goals promised not to
  // touch a line of code was refused for "leaving its boundary". Two proxy
  // approvals in the third run had to bypass the mechanical check.
  const task: PlanTask = {
    id: "t3", title: "supervision doc", fileBoundaries: ["docs"],
    dependsOn: [], execution: "parallel", status: "running",
  };
  // It has only edited a doc — every path its GOAL quotes is irrelevant now.
  assert.deepEqual(
    proxyApprovalProblems(["docs/orchestrator-supervision.md"], task),
    { ok: true, outside: [] },
  );
});

test("R3-1: nothing edited yet ⇒ nothing outside the boundary (goal approval happens at step 0)", () => {
  const task: PlanTask = {
    id: "a", title: "a", fileBoundaries: ["lib/orchestrator"],
    dependsOn: [], execution: "serial", status: "running",
  };
  assert.deepEqual(proxyApprovalProblems([], task), { ok: true, outside: [] },
    "a child that has written nothing cannot have breached anything — the probe keeps watching");
});

test("CONSTRAINT 8: a real landing outside the boundary still refuses, and says whose call it is", () => {
  const task: PlanTask = {
    id: "a", title: "a", fileBoundaries: ["lib/orchestrator", "test"],
    dependsOn: [], execution: "serial", status: "running",
  };
  assert.deepEqual(
    proxyApprovalProblems(["lib/orchestrator/plan.ts", "test/plan.test.ts"], task),
    { ok: true, outside: [] },
  );
  const outside = proxyApprovalProblems(["extensions/review-gate.ts"], task);
  assert.equal(outside.ok, false);
  assert.deepEqual(outside.outside, ["extensions/review-gate.ts"]);
  assert.match(outside.reason!, /范围变更/, "scope is the human's call, not a technical trade-off");
  assert.match(outside.reason!, /orchestrator_notify/, "and the refusal says what to do instead");
  assert.match(outside.reason!, /sessionEditedFiles/, "and names the fact it judged, so rewording is not a way through");
});

// ---------------------------------------------------------------------------
// CONSTRAINTS 9 and 14 — who may do what
// ---------------------------------------------------------------------------

test("CONSTRAINT 9: only an orchestrator may notify the human", () => {
  assert.deepEqual(notifyAuthorization("orchestrator"), { ok: true });
  for (const mode of ["loop", "explore", "normal", undefined] as const) {
    const refused = notifyAuthorization(mode);
    assert.equal(refused.ok, false, `${mode ?? "undecided"} must not raise a desktop banner`);
    if (!refused.ok) assert.match(refused.reason, /ask_user/, "a child that needs a person has its own tool");
  }
});

test("CONSTRAINT 14: irreversible and security decisions are never proxied", () => {
  for (const kind of ["discard-worktree", "sensitive-file"]) {
    const reason = humanOnlyDecision(kind);
    assert.ok(reason, `${kind} must be human-only`);
    assert.match(reason, /真人/);
  }
  assert.equal(humanOnlyDecision("technical-tradeoff"), undefined,
    "technical trade-offs ARE the orchestrator's to make — the boundary cuts both ways");
  assert.equal(humanOnlyDecision("gate-bypass"), undefined);
});

// ---------------------------------------------------------------------------
// CONSTRAINTS 3, 4, 10, 11 — the exit contract
// ---------------------------------------------------------------------------

test("a finished orchestration has nothing left to report", () => {
  assert.deepEqual(orchestratorDoneProblems(doneFacts()), []);
});

test("CONSTRAINT 3: an unfinished plan task blocks the exit", () => {
  const problems = orchestratorDoneProblems(doneFacts({
    plan: planOf({ tasks: [
      { id: "a", title: "a", fileBoundaries: ["lib/a"], status: "done" },
      { id: "b", title: "b", fileBoundaries: ["lib/b"], status: "pending" },
    ] }),
  }));
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /约束 3/);
  assert.match(problems[0]!, /b\(pending\)/, "the message names what is left");
});

test("CONSTRAINT 3: no plan at all is itself a blocker", () => {
  const problems = orchestratorDoneProblems(doneFacts({ plan: undefined }));
  assert.ok(problems.some((p) => /没有 plan/.test(p)));
});

test("CONSTRAINT 4: a live child blocks the exit", () => {
  const runtime = registerChild(emptyRuntime("orch-abc-1"), {
    id: "a-1", taskId: "a", paneId: "%2", cwd: "/repo", createdAt: NOW,
  });
  const problems = orchestratorDoneProblems(doneFacts({ runtime, alivePaneIds: ["%2"] }));
  assert.ok(problems.some((p) => /约束 4/.test(p)));
  assert.ok(problems.some((p) => /a-1@%2/.test(p)));
});

test("a child whose pane VANISHED without reporting done is surfaced too", () => {
  const runtime = registerChild(emptyRuntime("orch-abc-1"), {
    id: "a-1", taskId: "a", paneId: "%2", cwd: "/repo", createdAt: NOW,
  });
  const problems = orchestratorDoneProblems(doneFacts({ runtime, alivePaneIds: [] }));
  assert.ok(problems.some((p) => /pane 已经消失/.test(p)),
    "a dead child almost certainly did not finish its task");
});

test("CONSTRAINT 11: a decision the user was never told about blocks the exit", () => {
  const problems = orchestratorDoneProblems(doneFacts({
    plan: planOf({
      tasks: [{ id: "a", title: "a", fileBoundaries: ["lib"], status: "done" }],
      decisions: [{ id: "d1", question: "丢弃工作区？" }],
    }),
  }));
  assert.ok(problems.some((p) => /约束 11/.test(p)));

  // R-29 — "the user was TOLD" is NOT "the question was settled". Measured on
  // 2026-08-30: a decision was registered, notified, answered by the user in
  // chat, and never written back to the plan; nothing noticed, and the
  // orchestration reached wrap-up with a dangling question that even the
  // human reviewing the run mis-read.
  const notified = orchestratorDoneProblems(doneFacts({
    plan: planOf({
      tasks: [{ id: "a", title: "a", fileBoundaries: ["lib"], status: "done" }],
      decisions: [{ id: "d1", question: "丢弃工作区？", notifiedAt: NOW }],
    }),
  }));
  assert.equal(notified.length, 1, "notified-but-unresolved is its own blocker now");
  assert.match(notified[0]!, /R-29/);
  assert.match(notified[0]!, /resolve-decision/, "and it names the way out");

  const resolved = orchestratorDoneProblems(doneFacts({
    plan: planOf({
      tasks: [{ id: "a", title: "a", fileBoundaries: ["lib"], status: "done" }],
      decisions: [{ id: "d1", question: "丢弃工作区？", notifiedAt: NOW, resolvedAt: NOW, answer: "C" }],
    }),
  }));
  assert.deepEqual(resolved, [], "an answer written back into the plan clears it");
});

test("R-29: a decision declares what the plan must become, and the blocker repeats it", () => {
  const problems = orchestratorDoneProblems(doneFacts({
    plan: planOf({
      tasks: [{ id: "a", title: "a", fileBoundaries: ["lib"], status: "done" }],
      decisions: [{
        id: "d1",
        question: "要不要扩边界到 scripts/？",
        notifiedAt: NOW,
        planEffect: "若答 B，任务 a 的边界要加 scripts/",
      }],
    }),
  }));
  assert.match(problems.join("\n"), /任务 a 的边界要加 scripts\//);
});



test("the status line is short enough to inject every turn", () => {
  const line = formatOrchestrationStatus(doneFacts());
  assert.match(line, /orchestration=orch-abc-1/);
  assert.match(line, /任务 1\/1 完成/);
  assert.match(line, /活着的子会话 0/);
  assert.ok(line.length < 200);
  assert.match(formatOrchestrationStatus(doneFacts({ plan: undefined })), /尚无 plan/);
});
