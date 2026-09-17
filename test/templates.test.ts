/**
 * THE THREE SKELETONS — 「照抄这个骨架填即可」 (user ask, 2026-09-17).
 *
 * WHAT THIS FILE IS FOR. The gate hands an agent two documents it has to WRITE
 * and one it has to ANSWER: the requirement restatement, the loop goal, and a
 * plan task's `note`. Until this round each was described in prose somewhere
 * else — an English one-liner in the goal tool, a checklist inside the plan
 * auditor, nothing at all for `note` — so the agent's first job was to
 * translate a description into a document. The translation is where the
 * checkable parts get lost, and every loss comes back as an audit round. Now
 * each surface hands over the document itself.
 *
 * WHAT IS PINNED, and why exactly these things:
 *  - the TEMPLATE reaches BOTH moments of the goal round: `propose_loop_goal`
 *    (before the first submit) and `buildGoalPrereviewRefusal` (after an audit
 *    rejects one). A template in only the first place leaves the refused agent
 *    to re-invent it; only in the second, to invent it first;
 *  - the ONE FAMILY: three skeletons that open the same way and blank the same
 *    way, so an agent that has met one can fill the others. Pinned as a LOOP
 *    over the three, so adding a fourth that does not match is a red test;
 *  - the POINTER vs. the COPY: the standing block names where the templates
 *    live and quotes neither — the second copy of a fill-in template is the
 *    copy that drifts;
 *  - the FLATNESS of the plan: the task book goes in `note`, and `note` is
 *    excluded from `canonicalPlanText`. That second half is the one the user
 *    decided on 2026-09-17 when the file-boundary deadlock was abolished —
 *    「代码落点」 is INSTRUCTIONS, so a child that changes a module its note
 *    never named must not void the audit or revoke the approval.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

import { LOOP_GOAL_SKELETON, buildGoalPrereviewRefusal } from "../lib/loop-goal.ts";
import {
  ORCHESTRATOR_DIRECTIVE,
  PLAN_FINISH_TASK_BRIEF,
  PLAN_TASK_SKELETON,
} from "../lib/orchestrator-directives.ts";
import { RESTATEMENT_SKELETON } from "../lib/restatement.ts";
import { REQUIREMENT_PROTOCOL } from "../lib/agent-directives.ts";
import { registerGoalTools, type GoalToolDeps } from "../lib/goal-tools.ts";
import { registerOrchestratorStateTools } from "../lib/orchestrator-tools.ts";
import { canonicalPlanText, parsePlan } from "../lib/orchestrator-plan.ts";
import { makeFakeWorld } from "./helpers/fake-orchestration.ts";
import type { ToolHost } from "../lib/tool-host.ts";

/** The three templates, as [name, text] — the family this file pins. */
const SKELETONS: ReadonlyArray<readonly [string, string]> = [
  ["需求反述", RESTATEMENT_SKELETON],
  ["loop goal", LOOP_GOAL_SKELETON],
  ["plan 任务书", PLAN_TASK_SKELETON],
];

/** A registered definition, as far as these assertions need to read it. */
interface CapturedSpec {
  description: string;
  properties?: Record<string, unknown>;
  items?: CapturedSpec;
}

/** Register one tool family against a stub host and read back what it declared. */
function captureSpecs(register: (host: ToolHost) => void): Map<string, CapturedSpec> {
  const specs = new Map<string, CapturedSpec>();
  register({ registerTool: (definition) => { specs.set(definition.name, definition as unknown as CapturedSpec); } });
  assert.ok(specs.size > 0, "the family registered nothing — the assertions below would pass on an empty map");
  return specs;
}

/** The declared properties of a schema node — a definition carries its
 *  parameters' shape under `parameters`, a nested NODE carries its own. */
function propsOf(spec: CapturedSpec | undefined): Record<string, CapturedSpec> {
  const node = spec as unknown as
    | { parameters?: { properties?: Record<string, CapturedSpec> }; properties?: Record<string, CapturedSpec> }
    | undefined;
  return node?.parameters?.properties ?? node?.properties ?? {};
}

/** `plan.tasks[].note` — the array item's property, three levels down. */
function taskNoteSpec(plan: CapturedSpec): CapturedSpec | undefined {
  const planObject = propsOf(plan)["plan"];
  const tasks = planObject ? propsOf(planObject)["tasks"] : undefined;
  return tasks?.items ? propsOf(tasks.items)["note"] : undefined;
}

// ---------------------------------------------------------------------------
// ① the goal template, at both moments of the round

test("the goal template reaches the agent BEFORE it drafts and again when an audit rejects the draft", () => {
  // The description is what the agent reads while it still has nothing to lose.
  const goalSpecs = captureSpecs((host) => registerGoalTools(host, {} as GoalToolDeps));
  const propose = goalSpecs.get("propose_loop_goal")!;
  assert.ok(
    propose.description.includes(LOOP_GOAL_SKELETON),
    "propose_loop_goal must show the template itself — a description of a shape is one translation too many",
  );

  // The refusal is the other half: an agent that already drafted badly has to
  // see the format to fix it, not only the objections.
  const refused = buildGoalPrereviewRefusal({
    goalText: "# 目标\n\n一行意图。\n",
    auditorInstalled: true,
    packageAgentsDir: "/pkg/agents",
    repoRoot: "/repos/beta",
  });
  assert.ok(refused.includes(LOOP_GOAL_SKELETON), "the refusal hands back the same template");
  // …and adding the template must not have displaced the diagnosis that was
  // already there: WHICH repo, WHY it was refused, and the language rule.
  assert.match(refused, /\/repos\/beta/);
  assert.match(refused, /no goal-auditor pre-review has been recorded/);
  assert.match(refused, /Simplified Chinese/);
});

test("the goal template carries the column the user named, with all three kinds of case", () => {
  assert.match(LOOP_GOAL_SKELETON, /关键测试场景与边界情况/);
  for (const row of ["正常路径", "边界 / 错误路径", "明确不测的"]) {
    assert.ok(LOOP_GOAL_SKELETON.includes(row), `the template asks for 「${row}」`);
  }
  // The other exit-contract columns the goal is judged against.
  for (const column of ["意图", "退出标准", "非目标", "日期"]) {
    assert.match(LOOP_GOAL_SKELETON, new RegExp(`^${column}`, "m"), `the template keeps 「${column}」`);
  }
});

// ---------------------------------------------------------------------------
// ② the plan task book, where the manager actually writes it

test("the plan task book reaches both surfaces the manager writes it on", () => {
  const world = makeFakeWorld();
  const specs = captureSpecs((host) => registerOrchestratorStateTools(host, world.deps));
  const plan = specs.get("orchestrator_plan")!;
  assert.ok(plan.description.includes(PLAN_TASK_SKELETON),
    "the tool description is read while the plan is being written");
  const note = taskNoteSpec(plan);
  assert.ok(note, "`plan.tasks[].note` must be on the schema — it is the field the task book goes in");
  assert.ok(note!.description.includes(PLAN_TASK_SKELETON),
    "…and the field itself shows the skeleton (`<…>` per line)");
  // The ONE field the skeleton belongs to. The top-level `note` is
  // `set-status`'s 「why did this task move」 — a different question, and a
  // template there would be shown to a manager that is not writing a task book.
  assert.equal(propsOf(plan)["note"]?.description, "Why — recorded on the task");
});

test("the project manager's standing block renders the task book from the same constant", () => {
  assert.ok(ORCHESTRATOR_DIRECTIVE.includes(PLAN_TASK_SKELETON),
    "a hand-written second copy of the skeleton is exactly what this constant exists to prevent");
  // The fact that makes 「代码落点」 safe to write down: it grants nothing.
  assert.match(ORCHESTRATOR_DIRECTIVE, /不参与 plan 批准/);
});

// ---------------------------------------------------------------------------
// ③ one family, and a pointer rather than a fourth copy

test("the three skeletons are ONE family — same opening line, same blanks", () => {
  assert.equal(SKELETONS.length, 3);
  for (const [name, skeleton] of SKELETONS) {
    assert.match(
      skeleton,
      /^## \S.*（照抄这个骨架填即可）/,
      `${name}: every skeleton opens with the same 「照抄」 line — that is what makes them recognisable as one set`,
    );
  }
  for (const [name, skeleton] of SKELETONS) {
    assert.match(skeleton, /<[^<>\n]+>/, `${name}: blanks are angle brackets, one per thing to decide`);
  }
});

test("the standing block POINTS at the templates instead of quoting a second copy", () => {
  assert.match(REQUIREMENT_PROTOCOL, /propose_loop_goal/);
  assert.match(REQUIREMENT_PROTOCOL, /orchestrator_plan/);
  assert.match(REQUIREMENT_PROTOCOL, /骨架/);
  for (const [name, skeleton] of SKELETONS) {
    assert.ok(!REQUIREMENT_PROTOCOL.includes(skeleton), `${name}: the block must not carry the template body`);
  }
  // …and not its marker either: a quoted template would bring the family's
  // opening line with it.
  assert.doesNotMatch(REQUIREMENT_PROTOCOL, /照抄这个骨架填即可/);
  assert.doesNotMatch(REQUIREMENT_PROTOCOL, /关键测试场景与边界情况/);
});

// ---------------------------------------------------------------------------
// ④ the hard constraint: the task book is instructions, NOT a contract term

test("the task book stays free text — canonicalPlanText carries no note (2026-09-17 user decision)", () => {
  const parsed = parsePlan({
    title: "plan",
    intent: "跑一遍任务书模板",
    tasks: [{
      id: "t1",
      title: "任务一",
      repo: "/repo",
      note: PLAN_TASK_SKELETON + "\n代码落点：lib/templates-example.ts（新模块，不塞进大文件）",
    }],
  });
  assert.ok(parsed.ok, "a plan carrying a full task book must parse");
  const plan = parsed.ok ? parsed.plan : undefined;
  assert.ok(plan);
  const canonical = canonicalPlanText(plan!);
  for (const landing of ["代码落点", "lib/templates-example.ts", "验收：", "边界："]) {
    assert.doesNotMatch(canonical, new RegExp(landing),
      `「${landing}」 is part of the task book, so it must not reach the approved content`);
  }
  assert.ok(!canonical.includes(PLAN_TASK_SKELETON));
  // The note is not dropped — it is the child's brief. It is just not a term.
  assert.match(plan!.tasks[0]!.note ?? "", /代码落点/);
});

// ---------------------------------------------------------------------------
// ⑤ the plan ENDS with a delivery task (2026-09-18 user decision)
//
// Measured: a plan whose last task was one more feature left NOBODY able to
// publish — the manager may not ship (constraint 2) and every child of a
// multi-task repo is capped at `commit` — so the round ended with the work
// committed and no PR. The fix the user named is in the plan, not in the
// manager's mode: the LAST task delivers.

test("the finish-task rule reaches every surface the task book reaches — from ONE constant", () => {
  const world = makeFakeWorld();
  const specs = captureSpecs((host) => registerOrchestratorStateTools(host, world.deps));
  const plan = specs.get("orchestrator_plan")!;
  assert.ok(plan.description.includes(PLAN_FINISH_TASK_BRIEF),
    "the tool description is read while the plan is being written");
  assert.ok(taskNoteSpec(plan)!.description.includes(PLAN_FINISH_TASK_BRIEF),
    "…and so is the field the finish task's book goes in");
  assert.ok(ORCHESTRATOR_DIRECTIVE.includes(PLAN_FINISH_TASK_BRIEF),
    "the standing block renders it too — a hand-written second copy is what this constant prevents");
  // The manager STAYS the manager: the tempting fix for an orchestration that
  // cannot publish is "drop back into loop mode", which the user refused.
  assert.match(ORCHESTRATOR_DIRECTIVE, /全程保持编排身份/);
  assert.match(ORCHESTRATOR_DIRECTIVE, /不降级/);
  // The brief is PROSE, not a fourth skeleton: the three skeletons are the
  // documents an agent fills in, and a template that blanked the same way would
  // have to join that family (opening line + `<…>` blanks).
  assert.doesNotMatch(PLAN_FINISH_TASK_BRIEF, /照抄这个骨架填即可/);
  assert.doesNotMatch(PLAN_FINISH_TASK_BRIEF, /<[^<>\n]+>/);
});
