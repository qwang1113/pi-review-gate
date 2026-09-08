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
  formatPlanAuditCarryover,
  type PlanAuditFinding,
} from "../lib/orchestrator-plan-audit.ts";
import { parsePlan, type OrchestratorPlan } from "../lib/orchestrator-plan.ts";
import { UNTRUSTED_DATA_HEADER, UNTRUSTED_DATA_RULE } from "../lib/untrusted-data.ts";

const NOW = "2026-09-17T12:00:00.000Z";

function planOf(overrides: Record<string, unknown> = {}): OrchestratorPlan {
  const parsed = parsePlan({
    title: "拆分 review-gate",
    intent: "把扩展拆成模块并澄清需求",
    tasks: [
      { id: "a", title: "抽 plan 模块", repo: "/work/pi-review-gate" },
      { id: "b", title: "抽 tmux 模块", repo: "/work/pi-review-gate" },
    ],
    decisions: [
      { id: "d1", question: "拆分后是否保留旧入口？", answer: "保留", resolvedAt: NOW, notifiedAt: NOW },
    ],
    ...overrides,
  }, NOW, true);
  assert.ok(parsed.ok, `fixture must parse: ${parsed.problems.join("; ")}`);
  return parsed.plan!;
}

test("the audit task carries the 8th check: requirements clarified & goal derivable", () => {
  const task = buildPlanAuditTask(planOf());
  // The check exists and is numbered 8 (2026-09-08: the minimalism check took
  // 7, inside the checklist — a check after the conclude instructions would
  // never run, reviewer P1).
  assert.match(task, /8\. 需求是否已澄清、goal 是否可派生/);
  // It states the PM=product-manager rule.
  assert.match(task, /项目经理同时承担产品经理角色/);
  // 2026-09-06: the restatement itself is MECHANICAL now (submit refuses
  // without a confirmed one), so the task points at that mechanism instead of
  // asking the auditor to police an advisory step — and it names the module
  // that owns the rules, so this prose can never become a second copy of them.
  assert.match(task, /propose_restatement/);
  assert.match(task, /lib\/restatement\.ts/);
  assert.doesNotMatch(task, /grillme\/ask_user 把需求反述澄清/,
    "the old advisory wording must be gone, not living beside the mechanism");
});

test("the 8th check is mechanically checkable: decisions, task-book completeness, transcript", () => {
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

test("the 8th check names the transcript location when sessionDir/sessionId are provided", () => {
  const task = buildPlanAuditTask(planOf(), {
    sessionDir: "/tmp/session-dir",
    sessionId: "sess-123",
  });
  assert.match(task, /\/tmp\/session-dir/);
  assert.match(task, /sess-123/);
});

test("round 5: the plan is UNTRUSTED DATA and sits after the gate's checks", () => {
  const task = buildPlanAuditTask(planOf(), { repoRoot: "/work/pi-review-gate" });
  // ORDER, not presence: the plan is orchestrator-authored text, and a plan
  // pasted above the checks frames the audit before the auditor knows its job.
  const role = task.indexOf("You are goal-auditor");
  const checks = task.indexOf("===== 审计要点");
  const header = task.indexOf(UNTRUSTED_DATA_HEADER);
  const planBlock = task.indexOf("\n<plan>\n");
  assert.ok(role >= 0 && checks > role, "the gate's own checks come first");
  assert.ok(header > checks, "the untrusted region opens after them");
  assert.ok(planBlock > header, "and the plan rides inside it");
  assert.match(task, /<\/plan>/);
  assert.ok(task.includes(UNTRUSTED_DATA_RULE), "the rule travels with the task");
  // The plan's own text (its title) appears only inside the block.
  assert.ok(task.indexOf("拆分 review-gate") > header);
});

test("round 5: a re-audit's previous plan is untrusted data, not carryover prose", () => {
  const prev = {
    hash: "aa",
    verdict: "FAIL" as const,
    at: NOW,
    planText: "旧版 plan：任务 a 边界 lib/old",
  };
  const carryover = formatPlanAuditCarryover(prev);
  assert.match(carryover, /<previous_plan> data block/, "the carryover points at the block");
  assert.doesNotMatch(carryover, /lib\/old/, "…and does not inline the old plan itself");
  const task = buildPlanAuditTask(planOf(), { carryover, prevPlanText: prev.planText });
  const header = task.indexOf(UNTRUSTED_DATA_HEADER);
  assert.ok(task.indexOf("\n<previous_plan>\n") > header);
  assert.ok(task.indexOf("lib/old") > header, "the old plan text only appears inside the block");
  assert.ok(task.indexOf("PREVIOUS audit judged a DIFFERENT version") < header, "the verdict carryover stays trusted");
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
      { id: "a", title: "抽 plan 模块", repo: "/work/pi-review-gate" },
      { id: "b", title: "抽 tmux 模块", repo: "/work/pi-review-gate" },
      { id: "c", title: "抽 review 模块", repo: "/work/pi-review-gate" },
    ],
  });
  assert.equal(planAuditPassed(record, widened), false);
});

// The report-selection tests moved to test/audit-round.test.ts with the
// function itself (2026-09-05): picking THIS round's report is the audit
// ROUND's question, not the plan's — every kind had to answer it.

test("the audit task carries the 7th check: minimalism (inside the checklist, mergeable tasks are P1)", () => {
  const task = buildPlanAuditTask(planOf());
  assert.match(task, /7\. 最小化检查/);
  assert.ok(task.includes("docs/coding-standards.md") && task.includes("Section 5"), "it cites the standards section, not a copy");
  assert.match(task, /可合并的任务.*P1/, "mergeable/redundant tasks are a P1");
  for (const rule of ["YAGNI", "复用优先", "能删就删", "新依赖须论证"]) {
    assert.ok(!task.includes(rule), `the four checks must not be quoted in the task (found: ${rule})`);
  }
});
