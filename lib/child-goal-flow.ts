/**
 * THE ORCHESTRATION CHILD'S CONTRACT — the task book, not a goal (2026-10-20).
 *
 * A child works ONE task of a plan the user already approved. Round 4
 * (2026-09-28) had already dropped the restatement and the `goal-auditor`
 * audit from its flow, but kept `propose_loop_goal` and the manager's
 * crosschecked approval — a dialog and a review of a contract the plan had
 * settled. The user's decision is the blunt version: a child has NO goal stage
 * at all. The GATE writes the child's five-switch record when it dispatches it
 * (goal off: lib/loop-stages.ts `childStagesRecord`), so restatement, goal
 * negotiation, the goal audit and the L8 goal block simply do not apply, and
 * the child's contract is what the plan already says — the task book the gate
 * wrote into `.pi/tasks/` plus the station ceiling in its environment.
 *
 * The acceptance round follows the same logic one level up: it belongs to the
 * plan's LAST task, not to every child (lib/acceptance-round.ts).
 *
 * Every surface that tells a child what to do next reads its text from HERE,
 * so the standalone texts (lib/loop-goal-directives.ts, lib/loop-goal.ts,
 * lib/restatement.ts) stay exactly what a standalone session needs.
 */

import { buildRejection } from "./rejection-copy.ts";

/** The whole contract, in one sentence group — quoted by every child surface. */
export const CHILD_GOAL_FLOW =
  "编排子会话**没有 loop goal 环节**（门禁派发时已把 goal 环节关掉）：`propose_restatement` 与 " +
  "`propose_loop_goal` 都会被拒，也不会弹任何批准框。你的合同是**任务书** —— 门禁写进 `.pi/tasks/`，" +
  "agent 不可编辑 —— 加上环境里的交付站点上界（`RG_STATION_CAP`）。整个 plan 的真实验收由最后一个任务统一做。";

/** The child's standing directive: what its contract IS. */
export const CHILD_TASK_BOOK_DIRECTIVE =
  "## 你的合同：任务书（编排子会话没有 loop goal）\n" +
  CHILD_GOAL_FLOW +
  "\n任务书里写了目标、交付物、代码落点、验收与边界；照它做，不要扩大范围。" +
  "对它理解有偏差就用 `orchestrator_instruct` 之外的常规方式问项目经理（`ask_user` 会把问题经通道交给他）。";

/** The escalated form, once too many turns went by without a goal. */
export function buildChildTaskBookDirective(opts: { taskFile?: string }): string {
  return (
    CHILD_TASK_BOOK_DIRECTIVE +
    (opts.taskFile === undefined ? "" : `\n你的任务书文件：${opts.taskFile}`) +
    "\n现在就可以开始：读代码、改代码、`judge_submit` 送审，全部按任务书来。"
  );
}

/** Appended to a read-only result: the child owes no goal, and says so once. */
export const CHILD_GOAL_REMINDER_TEXT =
  "\n[review-gate] 编排子会话没有 loop goal 环节 —— 你的合同是 `.pi/tasks/` 里的任务书（门禁写的，别改它）" +
  "加上交付站点上界，照它直接干活即可，不需要也不允许 `propose_loop_goal` / `propose_restatement`。";

/** The L8 edit block's next step, for a child. */
export function childGoalEditBlock(repoRoot?: string): string {
  return buildRejection({
    what: "edit/write 被拦 —— 这个仓库的 loop goal 未获批" + (repoRoot ? ` (repo: ${repoRoot})` : ""),
    why: "L8 只在「goal 环节开着、且 goal 未获批」时拦；编排子会话的 goal 环节由门禁关掉，不该走到这里。",
    by: "agent",
    next: CHILD_GOAL_FLOW,
  });
}

/** `propose_restatement` in a child: refused, and pointed at the one step. */
export function childRestatementRefusal(): string {
  return buildRejection({
    what: "propose_restatement 被拒 —— 编排子会话不做需求反述，没有弹出任何对话框",
    why: "需求已由用户批准的 plan 定下，而你的合同就是那份 plan 写给你的任务书。",
    by: "agent",
    next: CHILD_GOAL_FLOW,
  });
}
