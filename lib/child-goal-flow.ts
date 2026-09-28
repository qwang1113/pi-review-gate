/**
 * THE ORCHESTRATION CHILD'S GOAL FLOW (round 4, user decision 2026-09-28).
 *
 * A child works ONE task of a plan the user already approved, under a project
 * manager who reads its goal draft anyway. The two steps a standalone loop
 * session runs before its approval dialog — the requirement RESTATEMENT and the
 * `goal-auditor` audit — only re-asked what the plan and the manager already
 * settled, and cost a dialog plus a minutes-long judge round per child. So a
 * child skips both: it drafts its goal and calls `propose_loop_goal`, whose
 * approval box goes to the manager (with its mandatory crosscheck) and to the
 * child's own pane, first answer wins.
 *
 * Every surface that tells a child what to do next reads its text from HERE,
 * so the standalone texts (lib/loop-goal-directives.ts, lib/loop-goal.ts,
 * lib/restatement.ts) stay exactly what a standalone session needs.
 */

import { buildRejection } from "./rejection-copy.ts";

/** The whole flow, in one sentence group — quoted by every child surface. */
export const CHILD_GOAL_FLOW =
  "编排子会话的 goal 流程只有一步：**不做**需求反述（`propose_restatement` 会被拒），也**不跑** " +
  "goal-auditor 审计 —— 直接用简体中文写好你自己的 loop goal（标识符、路径、代码 token 保持英文），" +
  "调 `propose_loop_goal`。它弹出批准框，同时经通道交给项目经理审核，用户或项目经理谁先答算谁的；" +
  "交付站点缺省就是 plan 给本任务的上限。goal 获批前，L8 会拦下所有 edit/write。";

/** Step 0 of the per-turn prompt while the child has no approved goal. */
export const CHILD_GOAL_MISSING_DIRECTIVE =
  "## Loop goal（Step 0 —— 编排子会话，先谈 goal 再动手）\n" +
  "本会话还没有获批的 loop goal。任务书只是 plan 的任务边界，不是你的 goal；plan 批准 ≠ goal 批准。\n" +
  CHILD_GOAL_FLOW;

/** The escalated form, once too many turns went by without a goal. */
export function buildChildGoalForceNegotiateDirective(shown: string): string {
  return (
    "## 强制协商 loop goal（门禁，2026-09-17）\n" +
    `你已 ${shown} 未获批 loop goal。继续只读探查或任何其他工作之前，**必须先**把 goal 交出去。\n` +
    CHILD_GOAL_FLOW
  );
}

/** Appended to a read-only result while the child has no approved goal. */
export const CHILD_GOAL_REMINDER_TEXT =
  "\n[review-gate] 你还没获批本会话的 loop goal —— 直接写 goal 调 `propose_loop_goal`" +
  "（编排子会话不做需求反述、不跑 goal 审计，由项目经理审），获批之后才改代码（未批准前 L8 会拦下 edit/write）。";

/** The L8 edit block's next step, for a child. */
export function childGoalEditBlock(repoRoot?: string): string {
  return buildRejection({
    what: "edit/write 被拦 —— 这个仓库还没有获批的 loop goal" + (repoRoot ? ` (repo: ${repoRoot})` : ""),
    why: "L8 在编辑发生之前就拦：批准只有在动手之前才有意义。",
    by: "agent",
    next: CHILD_GOAL_FLOW,
  });
}

/** `propose_restatement` in a child: refused, and pointed at the one step. */
export function childRestatementRefusal(): string {
  return buildRejection({
    what: "propose_restatement 被拒 —— 编排子会话不做需求反述，没有弹出任何对话框",
    why: "需求已经由用户批准的 plan 定下，你的 goal 由项目经理直接审核；再反述一遍只是多问一次同样的事。",
    by: "agent",
    next: CHILD_GOAL_FLOW,
  });
}
