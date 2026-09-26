/**
 * The words the USER reads when approving a plan — the transcript echo and
 * the dialog body, plus the dialog's title and approve row.
 *
 * Split from the action handler (lib/orchestrator-plan-action.ts) because
 * this is copy, not a decision: the handler decides WHEN to ask, this module
 * says WHAT is asked. Tests pin the copy without driving the state machine.
 */

import { deliveryStationLine } from "./delivery-station.ts";
import { narrowedRepoLines } from "./repo-pr-policy.ts";
import { formatPlanSummary, PLAN_RELPATH, type OrchestratorPlan } from "./orchestrator-plan.ts";

/** The dialog the USER approves a plan in (constraint 1). */
export const PLAN_CONFIRM_TITLE = "review-gate: 批准项目经理的任务计划（plan）？";

/** The row that approves it — one spelling, used by the dialog and the parse. */
export const PLAN_APPROVE_LABEL = "批准这份 plan";

/**
 * Retired 2026-09-16 with the row budget (kept as a note, not as code): a plan
 * dialog no longer truncates its body, so there is nothing to point at. The
 * transcript echo it described is still printed before the dialog opens — see
 * `buildPlanTranscriptMessage` below — because approving a plan you cannot read
 * was the O-1 report, and it stays true however the dialog is rendered.
 */

/**
 * The FULL plan, printed to the transcript before the dialog opens (O-1).
 *
 * This is the text the approval actually binds to, so it is the text the user
 * has to be able to read. It also names the file, because a plan long enough
 * to scroll off the screen is exactly the case where "go read it yourself"
 * has to be actionable.
 */
export function buildPlanTranscriptMessage(plan: OrchestratorPlan): string {
  return (
    "任务计划全文（不可信数据）——批准前请读完：\n" +
    "───────────────────────\n" +
    // The USER reads this block before approving, so the station speaks to them.
    formatPlanSummary(plan, "", "user") +
    "\n───────────────────────\n" +
    "同样的内容也在 `" + PLAN_RELPATH + "`（可随时自己去看）。\n" +
    "批准的是**内容**：任务、每个任务的 repo、依赖、并行度中任何一项被**扩大**，批准即失效。\n\n" +
    APPROVAL_SEMANTICS
  );
}

/**
 * WHAT AN APPROVAL COVERS — stated to the user, in the dialog, before they
 * agree to it.
 *
 * This paragraph is the honest half of the round-4 P0 fix. The dialogs that
 * round popped three times were all caused by a plan edit that had to reach
 * the user only because the plan declared FILE BOUNDARIES; those are gone
 * (2026-09-17, user decision), so the edit that caused them cannot exist. What
 * remains is the shorter list of edits that still widen what "approved"
 * means — and a rule the user discovers AFTERWARDS is not a rule they agreed
 * to, so it is written where they are deciding, in the text the approval
 * binds to.
 */
const APPROVAL_SEMANTICS =
  "关于批准的确切含义（请读一句）：批准的是**内容** —— 任务清单、每个任务的 repo、" +
  "依赖关系、并行度、交付站点。\n" +
  "子会话在它自己的 repo 里改哪些文件**不需要再报备**，也不会再来打扰你" +
  "（文件边界已于 2026-09-17 从 plan 中移除：同一 repo 的任务本来就不会同时跑）。\n" +
  "把 plan **写回你此前批准过的内容**同样不会再问（撤回一次误操作不必重走批准），" +
  "而你每批准一次新内容，之前那条链就作废。\n" +
  "以下改动一律**重新**征求你的批准：" +
  "新增任务、把任务换到另一个 repo、删除依赖、把串行改成并行、提高并行上限、把交付站点往后挪" +
  "（precommit → commit → pr，等于放开更多 ship 命令）、让某个任务自己的交付站点变宽" +
  "（改任务顺序、或删掉一个兄弟任务，都可能让「最后一环不受收窄」那份豁免落到别的任务头上），" +
  "以及把某个 repo 加进 `allowMultiplePrs`（默认同一 repo 的一个需求只出一个 PR：多任务时该 repo 的站点" +
  "收窄到 commit；只有 plan 的最后一环 —— 独立验收任务 —— 不受这条收窄（倒数第二个收尾任务" +
  "汇合各任务、走一次整体审核并 commit，最后一个验收任务只做真实验收 + push + 开这一个 PR）。";


/**
 * Dialog body — the DECISION only.
 *
 * The plan itself was just printed by {@link buildPlanTranscriptMessage}, and
 * repeating it here is what produced the truncated, unreadable dialog O-1
 * filed. The fixed copy explaining what approval grants comes first, because
 * the box is read top-down and that copy is what the reader must not miss
 * (before 2026-09-16 a tail cut decided the same order; nothing is cut now).
 */
export function buildPlanConfirmMessage(plan: OrchestratorPlan, defaultRepo = ""): string {
  const narrowing = narrowedRepoLines(plan, defaultRepo);
  return (
    "plan 全文（不可信数据）已显示在上方消息中，请先读完再决定。\n" +
    "批准后，项目经理才能按这份 plan 开子会话干活。批准的是**内容**：" +
    "新增任务、把任务换到另一个 repo、删依赖、串行改并行、提高并行上限、**提高交付站点**、" +
    "**让某个任务自己的交付站点变宽**（改任务顺序 / 删掉一个兄弟任务都可能让最后一环的豁免落到别人头上）、" +
    "**把某个 repo 加进 allowMultiplePrs**（放行该 repo 各自开 PR），" +
    "都会让批准失效并重新问你；" +
    "**子会话在自己 repo 内改哪些文件不再报备**，" +
    "**写回你批准过的内容**也不会再问（详见上方消息）。\n" +

    `标题（不可信数据）：${plan.title.slice(0, 80)}\n` +
    `规模：${plan.tasks.length} 个任务，并行上限 ${plan.maxParallel}\n` +
    // The station is a CONSENT-critical fact: it decides how far this
    // orchestration may go (precommit / commit / pr), and raising it later is
    // a widening that comes back here. A dialog that omitted it would ask the
    // user to approve an authority they were never shown.
    deliveryStationLine(plan.deliveryStation, "user") +
    // AND THE NARROWING, right under it (2026-09-15): a plan that says `pr`
    // while every child in a multi-task repo can only reach `commit` has to
    // say so where the user approves it, or the contract they signed is not
    // the one that runs. The lines come from the ONE implementation of the
    // rule (lib/repo-pr-policy.ts).
    (narrowing.length > 0 ? "\n" + narrowing.join("\n") : "")
  );
}
