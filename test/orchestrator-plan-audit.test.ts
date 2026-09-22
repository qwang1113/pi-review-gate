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

test("the 8th check's transcript pointer is RENDERED, never source code (2026-09-17)", () => {
  // The line was a double-quoted string carrying a ${…} expression, so the
  // auditor was handed `读 ${opts.sessionDir ? 'PM 的 transcript…' }` — JS
  // source in the middle of the audit checklist. The neighbouring block below
  // it is a real template, which is why the path assertions still passed: the
  // pointer appeared ELSEWHERE, and the broken line read as prose.
  for (const opts of [{}, { sessionDir: "/tmp/session-dir", sessionId: "sess-123" }]) {
    const task = buildPlanAuditTask(planOf(), opts);
    assert.doesNotMatch(task, /\$\{opts\./, "no JS source may leak into the auditor's task text");
  }
  assert.match(
    buildPlanAuditTask(planOf()).replace(/\s+/g, " "),
    /读 PM 的 transcript，/,
    "with no session the fallback reads as prose",
  );
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

test("the audit task carries the 9th check: architecture & code organization (placement, shared contracts)", () => {
  const task = buildPlanAuditTask(planOf());
  assert.match(task, /9\. 架构与代码组织/, "the new check sits inside the checklist");
  // (a) placement — judged against the repository's real size, because the
  // hard gate only covers NEW files (lib/file-size-gate.ts, 600 lines).
  assert.match(task, /代码落点/);
  assert.match(task, /lib\/file-size-gate\.ts/, "it names the half the hard gate does not cover");
  // (b) shared contracts between tasks.
  assert.match(task, /共享契约/);
  assert.match(task, /dependsOn/);
  // The 2026-09-17 user decision: file lists are NOT part of a plan, so this
  // check must not turn into a demand for one.
  assert.match(task, /任务改哪些文件不是 plan 的一部分/);
  assert.match(task, /不要因为 plan 没列文件清单/);
});

// ---------------------------------------------------------------------------
test("the audit task carries the 10th check: the plan ENDS with an independent acceptance task", () => {
  const task = buildPlanAuditTask(planOf());
  assert.match(task, /10\. 最后两环的分工/, "the new check sits inside the checklist");
  // The TWO links, by position: the second-to-last wraps up, the last accepts.
  assert.match(task, /倒数第二个 = 收尾任务/, "the merge / whole review / commit link is named");
  assert.match(task, /最后一个 = 独立验收任务/, "…and so is the link that accepts and delivers");
  assert.match(task, /不产出新需求、不改业务代码、只做真实验收与交付/,
    "the acceptance task's own terms — what makes it INDEPENDENT");
  // WHY it is a P1: without it nobody may publish at all (the manager is
  // forbidden to ship, the children of a multi-task repo are capped at commit).
  assert.match(task, /没有任何一方能开 PR/);
  assert.match(task, /实测的事故/);
  // The implementation is NAMED, so a renamed helper or a moved rule has to
  // come back and update this line instead of leaving the auditor guessing.
  assert.match(task, /lib\/repo-pr-policy\.ts/);
  assert.match(task, /acceptanceTaskId/);
  assert.match(task, /effectiveTaskStation/);
  assert.doesNotMatch(task, /finishTaskId/, "the old name is gone, not living beside the new one");
  // A POSITION, not a new plan field — the check must not become a demand for
  // one (same discipline as the 9th check's file lists).
  assert.match(task, /位置约定/);
  assert.match(task, /不是 plan 的新字段/);
  // And the tail has to be last in EXECUTION order, not just in the list.
  assert.match(task, /dependsOn/);
  assert.match(task, /plan 顺序/);
});

test("the 10th check states the shape it P1s: a last task that is not an acceptance task", () => {
  // The plan the rule rejects — its last task is one more feature, so the
  // session that wrote the code would be the one that declares it good.
  const broken = planOf({
    tasks: [
      { id: "work", title: "做功能", repo: "/work/pi-review-gate" },
      { id: "more", title: "再做一点", repo: "/work/pi-review-gate" },
    ],
  });
  const task = buildPlanAuditTask(broken);
  assert.match(task, /最后一个任务仍是「实现某个功能」的任务/, "the rejected shape is spelled out");
  assert.match(task, /等于自评/, "and WHY it is rejected: the author grades their own work");
  // The acceptance half is required in its own right, not merely implied by a
  // "delivers" half — that is the whole point of the 2026-09-22 split.
  assert.ok(task.includes("真实验收是跑真实路径 / 命令 / 观察（不是复述实现，也不是给自己打分）"),
    "the acceptance is defined as a real run, not a restatement");
  // …and the offending plan itself is in front of the auditor (the untrusted
  // block), so the check is not an abstract rule it has to take on faith.
  assert.ok(task.includes("再做一点"), "the plan under audit rides in the same task text");
});

test("the 10th check is inside the checklist — before the conclude instructions", () => {
  const task = buildPlanAuditTask(planOf());
  const check = task.indexOf("10. 最后两环的分工");
  const checklist = task.indexOf("===== 审计要点");
  const untrusted = task.indexOf("===== 待审计的 plan =====");
  const conclude = task.indexOf("judge_conclude");
  assert.ok(checklist >= 0 && untrusted > checklist, "the checks come before the untrusted plan (round 5)");
  assert.ok(check > checklist && check < untrusted,
    "a check AFTER the untrusted region (or after the conclude instructions) would never be read as part of the list");
  assert.ok(conclude > check, "and it is stated as a checklist item, not after the closing instructions");
});
