/**
 * THE PLAN'S PRE-REVIEW — the goal audit's twin, for the other contract.
 *
 * ── THE ASYMMETRY THIS CLOSES (user, 2026-08-30) ──
 *
 * A loop goal cannot reach the user until a dedicated `goal-auditor` has
 * passed it: the gate dispatches the audit itself inside `propose_loop_goal`,
 * and a failed audit hands the objections back WITHOUT ever opening a dialog.
 * A plan — which decides what several child sessions may touch, in what
 * order, and how many run at once — had no audit at all. It went straight to
 * the human.
 *
 * That is backwards, because a wrong plan is more expensive than a wrong
 * goal. A boundary that misses where the work actually lands puts two writers
 * in one file; a dependency that is missing turns a serial chain into a race;
 * a `maxParallel` set too high burns machine and money on lanes that will
 * collide anyway. And unlike a goal, none of that is visible in prose — it
 * has to be checked against the repository.
 *
 * ── SAME SHAPE, DELIBERATELY (philosophy two) ──
 *
 * `orchestrator_plan({action:"submit"})` swallows the whole chain exactly as
 * `propose_loop_goal` does: build the task, dispatch the judge, wait, parse,
 * adjudicate, record. The orchestrator submits a plan and gets back either a
 * user dialog or a list of objections — never a half-finished sequence it has
 * to drive itself.
 *
 * The ROLE is `goal-auditor`, not a new `plan-auditor` (user decision,
 * 2026-08-30): both audits answer the same question — "is this contract
 * checkable and does it match reality?" — and adding a fourth judge role
 * would widen the choice an agent has to make every round without adding a
 * distinction it could act on.
 *
 * ── WHAT THE RECORD BINDS TO ──
 *
 * `canonicalPlanText` — the same serialization the user's approval binds to.
 * So an audit PASS survives a status change (executing the plan rewrites
 * statuses constantly) and dies the moment a boundary, dependency, task or
 * parallelism changes, which is precisely when it should be re-judged.
 *
 * Pure module: it builds task text and judges records. The dispatching, the
 * waiting and the sidecar IO belong to the extension.
 */

import { createHash } from "node:crypto";
import { canonicalPlanText, formatPlanSummary, type OrchestratorPlan } from "./orchestrator-plan.ts";

/** One objection, exactly as the auditor's JSON fence reported it. */
export interface PlanAuditFinding {
  severity: string;
  issue: string;
}

/**
 * The sidecar record of "the auditor judged THIS exact plan".
 *
 * Mirrors `GoalPrereviewRecord` field for field, including the reason it is
 * latest-only: recording an audit of plan B after passing plan A means plan A
 * is no longer what is on the table.
 */
export interface PlanAuditRecord {
  /** sha256 of the canonical plan text that was judged. */
  hash: string;
  verdict: "PASS" | "FAIL";
  at: string;
  findingsTotal?: number | null;
  /** The findings verbatim, so a re-audit can be handed its own objections. */
  findings?: PlanAuditFinding[];
  /** The rendered plan that was judged — a re-audit diffs against it. */
  planText?: string;
}

/** sha256 of the authorizing content of a plan. */
export function planAuditHash(plan: OrchestratorPlan): string {
  return createHash("sha256").update(canonicalPlanText(plan), "utf8").digest("hex");
}

/**
 * ADJUDICATION — one rule, and it is the same one the goal audit uses.
 *
 * ONLY P0/P1 BLOCK. A READY carrying P2s or nits is a PASS, and it must not
 * buy another audit round: the measured failure mode on the goal side was an
 * agent volunteering a re-audit for advisory findings, which costs minutes
 * and changes nothing. A BLOCKED gate with no parsed findings still fails —
 * an auditor that says "blocked" without saying why is not evidence of
 * approval.
 */
export function adjudicatePlanAudit(
  gate: string | undefined,
  findings: readonly PlanAuditFinding[],
): { verdict: "PASS" | "FAIL"; blocking: PlanAuditFinding[] } {
  const blocking = findings.filter((f) => {
    const severity = String(f.severity ?? "").toUpperCase();
    return severity === "P0" || severity === "P1";
  });
  if (blocking.length > 0) return { verdict: "FAIL", blocking };
  if (String(gate ?? "").toUpperCase() === "READY") return { verdict: "PASS", blocking: [] };
  return { verdict: "FAIL", blocking: [] };
}

/**
 * May `submit` open the approval dialog for this plan?
 *
 * Fail-closed on every uncertainty — no record, a FAIL, or a record bound to
 * different content all mean "not audited". No TTL, for the same reason the
 * goal has none: the binding is to content, so an old PASS for identical
 * content is still a PASS for that content.
 */
export function planAuditPassed(
  record: PlanAuditRecord | undefined,
  plan: OrchestratorPlan,
): boolean {
  if (!record || record.verdict !== "PASS") return false;
  return planAuditHash(plan) === record.hash;
}

/** The carryover block for a re-audit: what the last round objected to. */
export function formatPlanAuditCarryover(prev: PlanAuditRecord): string {
  const findings = prev.findings ?? [];
  return [
    "Plan re-audit carryover — the PREVIOUS audit judged a DIFFERENT version of this plan:",
    `- Previous verdict: ${prev.verdict} (${findings.length} finding(s), ${prev.at}).`,
    ...(findings.length
      ? [
          "- Previous findings, one by one — the revised plan must address each:",
          ...findings.map((f) => `  - ${f.severity}: ${f.issue}`),
        ]
      : ["- The previous audit reported no findings — confirm that still holds."]),
    ...(prev.planText ? ["- The PREVIOUS plan (judged then):", "```", prev.planText, "```"] : []),
  ].join("\n");
}

/**
 * The auditor's task text.
 *
 * The six checks are the user's own list (task book §7) and they are stated as
 * QUESTIONS ABOUT THE REPOSITORY rather than about the prose: the auditor has
 * read-only tools and its whole value is that it can go and look at whether
 * `lib/` really is where that task will land.
 */
export function buildPlanAuditTask(
  plan: OrchestratorPlan,
  opts: { carryover?: string; sessionDir?: string; sessionId?: string; repoRoot?: string } = {},
): string {
  return [
    "You are goal-auditor, this round auditing an ORCHESTRATION PLAN (not a loop goal).",
    "",
    "The plan below is about to be shown to a HUMAN for approval. It decides what each child",
    "session may touch, in what order, and how many run at once — so a mistake here puts two",
    "writers in one file, or turns a serial chain into a race. You run as your own pi process",
    "with read-only tools: CHECK THE PLAN AGAINST THE REPOSITORY, do not judge the prose.",
    ...(opts.repoRoot ? ["", `Repository: ${opts.repoRoot}`] : []),
    "",
    ...(opts.carryover ? [opts.carryover, ""] : []),
    "===== 待审计的 plan =====",
    formatPlanSummary(plan),
    "",
    "===== 审计要点（逐条回答，用仓库里的事实说话） =====",
    "1. 任务拆分是否完整：plan 的 intent 有没有哪一部分不属于任何任务？有没有任务其实是两件事？",
    "2. 文件边界是否覆盖真实落点：按仓库现状，每个任务真正要改的文件是否都在它的 fileBoundaries 内？",
    "   （尤其注意会被漏掉的落点：测试、文档、安装脚本、类型声明、注册入口。）",
    "   数量必须可复核（O-5）：凡是给出「涉及 N 处落点 / 断言 / 调用点」这类计数，",
    "   都要附上你数它用的确切命令与其输出行数（例如 `grep -c 'pi.on(\"tool_call\"' <file>` → 11），",
    "   不要写「三处」这类抽样自然语言——一个偏小的数字会诱导子会话「做完点名的那几处就交差」。",
    "3. 边界重叠与 execution 是否自洽：声明 parallel 的任务之间边界是否真的不相交？",
    "   相交就会被降级成串行——那 plan 承诺的并行是假的。",
    "4. 依赖是否成环或缺失：有没有任务实际依赖另一个任务的产物却没写 dependsOn？",
    "5. maxParallel 是否安全：并行度与边界隔离、与机器/额度成本相称吗？",
    "6. 每个任务是否可独立验收：一个子会话拿到它，能不能自己判断做完没做完？",
    "",
    ...(opts.sessionDir && opts.sessionId
      ? [
          `You do NOT inherit the orchestrator's conversation — read it on demand from ${opts.sessionDir}`,
          `(file named <timestamp>_${opts.sessionId}.jsonl).`,
          "",
        ]
      : []),
    "输出一个 fenced JSON verdict(放在输出最前):",
    "```json",
    '{"gate":"READY"|"BLOCKED","findings":[{"severity":"P0"|"P1"|"P2","issue":"..."}]}',
    "```",
    "READY 仅当 plan 无未解决 P0/P1 异议。findings 为空表示无异议。",
    "输出纪律:只输出 fence + ≤3 行结论要点;不复述 plan、不复述代码、不写过程叙事。",
    "",
    "完成(必须):输出最终 verdict 后正常退出即可——进程退出即完成,主会话以你的输出为准。",
  ].join("\n");
}

/**
 * What the orchestrator is told when the audit blocks.
 *
 * NO DIALOG WAS SHOWN and it says so first, because the next move depends on
 * it: the user has not seen anything, so this is not "the user said no" — it
 * is a revision the orchestrator makes on its own and resubmits.
 */
export function formatPlanAuditRefusal(record: PlanAuditRecord | undefined): string {
  const findings = record?.findings ?? [];
  return [
    "review-gate: plan 审计**没过**，用户那一关连问都没问（没有弹任何框）。",
    "按下面的 findings 改 plan —— 用 `orchestrator_plan({action:\"write\"})` 写修订版，",
    "再 `submit` 一次；门禁会自动重新审计，并把这一轮的结论带给审计者。",
    "",
    ...(findings.length
      ? findings.map((f) => `  - ${f.severity}: ${f.issue}`)
      : [`  （审计器没有给出可解析的 findings，裁决是 ${record?.verdict ?? "NONE"}）`]),
    "",
    "注意：审计裁决绑定 plan 的**授权内容**（任务、边界、依赖、并行度）——",
    "改任务状态不会让它失效，改一个边界就要重审。",
  ].join("\n");
}
