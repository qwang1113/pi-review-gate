/**
 * THE PLAN AUDIT TASK — the template the goal-auditor judges a plan against.
 *
 * 2026-09-17 (user decision): the orchestrator doubles as the product manager.
 * Before a plan may reach the user for approval, the PM must have read the
 * involved code, restated/clarified the requirements (grillme / ask_user) and
 * understood each child's goal. The audit template therefore carries a 7th
 * check — "需求是否已澄清、goal 是否可派生" — and it must be mechanically
 * checkable: the auditor verifies plan.decisions are resolved, each task book
 * is complete enough for a child to negotiate its own goal, and the PM's
 * transcript (ask_user / grillme Q&A) is consulted for evidence that the
 * clarification actually landed in the plan.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPlanAuditTask,
  adjudicatePlanAudit,
  planAuditHash,
  planAuditPassed,
  type PlanAuditFinding,
} from "../lib/orchestrator-plan-audit.ts";
import { parsePlan, type OrchestratorPlan } from "../lib/orchestrator-plan.ts";

const NOW = "2026-09-17T12:00:00.000Z";

function planOf(overrides: Record<string, unknown> = {}): OrchestratorPlan {
  const parsed = parsePlan({
    title: "拆分 review-gate",
    intent: "把扩展拆成模块并澄清需求",
    tasks: [
      { id: "a", title: "抽 plan 模块", fileBoundaries: ["lib/plan"], repo: "/work/pi-review-gate" },
      { id: "b", title: "抽 tmux 模块", fileBoundaries: ["lib/tmux"], repo: "/work/pi-review-gate" },
    ],
    decisions: [
      { id: "d1", question: "拆分后是否保留旧入口？", answer: "保留", resolvedAt: NOW, notifiedAt: NOW },
    ],
    ...overrides,
  }, NOW, true);
  assert.ok(parsed.ok, `fixture must parse: ${parsed.problems.join("; ")}`);
  return parsed.plan!;
}

test("the audit task carries the 7th check: requirements clarified & goal derivable", () => {
  const task = buildPlanAuditTask(planOf());
  // The check exists and is numbered 7.
  assert.match(task, /7\. 需求是否已澄清、goal 是否可派生/);
  // It states the PM=product-manager rule.
  assert.match(task, /项目经理同时承担产品经理角色/);
  assert.match(task, /grillme\/ask_user 把需求反述澄清/);
});

test("the 7th check is mechanically checkable: decisions, task-book completeness, transcript", () => {
  const task = buildPlanAuditTask(planOf());
  // (a) unresolved plan.decisions are a P1.
  // (a) unresolved plan.decisions are a P1 — the SPECIFIC verdict sentence,
  // not a bare /P1/ that matches elsewhere in the template.
  assert.match(task, /plan\.decisions/);
  assert.match(task, /resolvedAt/);
  assert.match(task, /需求未澄清，P1/);
  // (b) a vague task book ("做分页" with no acceptance criteria) is a P1 —
  // the SPECIFIC threshold sentence, not the example alone.
  assert.match(task, /做分页/);
  assert.match(task, /没有交互\/边界\/验收标准的任务书是 P1/);
  // (c) the auditor is directed to the PM's transcript for ask_user/grillme evidence.
  assert.match(task, /transcript/);
  assert.match(task, /ask_user\/grillme/);
});

test("the 7th check names the transcript location when sessionDir/sessionId are provided", () => {
  const task = buildPlanAuditTask(planOf(), {
    sessionDir: "/tmp/session-dir",
    sessionId: "sess-123",
  });
  assert.match(task, /\/tmp\/session-dir/);
  assert.match(task, /sess-123/);
});

test("adjudication: only P0/P1 block, and a READY with P2s passes", () => {
  const p1: PlanAuditFinding = { severity: "P1", issue: "任务书只写了『做分页』" };
  const p2: PlanAuditFinding = { severity: "P2", issue: "可加验收示例" };
  assert.deepEqual(adjudicatePlanAudit("BLOCKED", [p1]), { verdict: "FAIL", blocking: [p1] });
  assert.deepEqual(adjudicatePlanAudit("READY", [p2]), { verdict: "PASS", blocking: [] });
  // A BLOCKED gate without findings still fails — no evidence of approval.
  assert.deepEqual(adjudicatePlanAudit("BLOCKED", []), { verdict: "FAIL", blocking: [] });
});

test("planAuditHash / planAuditPassed: the record binds to the canonical plan content", () => {
  const plan = planOf();
  const hash = planAuditHash(plan);
  assert.equal(hash.length, 64, "sha256 hex");
  const record = { hash, verdict: "PASS" as const, at: NOW };
  assert.equal(planAuditPassed(record, plan), true);
  // A different plan (an added task) does not ride on the same PASS.
  const widened = planOf({
    tasks: [
      { id: "a", title: "抽 plan 模块", fileBoundaries: ["lib/plan"], repo: "/work/pi-review-gate" },
      { id: "b", title: "抽 tmux 模块", fileBoundaries: ["lib/tmux"], repo: "/work/pi-review-gate" },
      { id: "c", title: "抽 review 模块", fileBoundaries: ["lib/review"], repo: "/work/pi-review-gate" },
    ],
  });
  assert.equal(planAuditPassed(record, widened), false);
});
