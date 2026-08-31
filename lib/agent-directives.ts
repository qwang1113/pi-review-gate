/**
 * The gate's standing instructions to the agent — ONE block, injected every
 * turn.
 *
 * WHY THIS MODULE EXISTS (user ask, 2026-08-29). Two behaviours cost a full
 * loop iteration every time they happened, and neither is a knowledge problem:
 *
 *  - the agent wanted the user, so it wrote a question into its reply and
 *    ended the turn. The session stopped, the gate woke it, and only then did
 *    it remember there is a tool for that;
 *  - the agent took a requirement at face value, implemented its own reading
 *    of it, and found out at review time that it had built the wrong thing.
 *
 * So the block is not a tutorial: it is a lookup table from SITUATION to TOOL,
 * a check to run before ending a turn, and the protocol for adopting a
 * requirement. Everything procedural has a tool; what is left is the work.
 */

/**
 * Situation → tool. Deliberately short: an agent scanning this mid-task must
 * find its row in one pass.
 */
export const TOOL_DECISION_TABLE =
  "## 情况 → 工具（结束本轮前先对照）\n" +
  "| 你现在要做的事 | 调这个 |\n" +
  "| --- | --- |\n" +
  "| 问用户、等用户拍板 | `ask_user({questions})` — 它会问并暂停循环；别把问题写进回复就结束 |\n" +
  "| 提交本轮改动送审 | `judge_submit({role:\"reviewer\", task})` — 门禁自己跑 precommit→checkpoint→送审 |\n" +
  "| 提交 goal 草稿 | `propose_loop_goal({goal})` — 门禁自己跑 goal 审计，过了才弹用户批准框 |\n" +
  "| 自己决定不了的设计取舍 | `judge_submit({role:\"adviser\", task})` |\n" +
  "| 当前在 main/master/dev/develop 上要提交 | checkpoint 前门禁会弹确认框；ship 提交（git commit）会被拒 — 切到开发分支 |\n" +
  "| 看 judge 的状态或结论 | `judge_read({role})`；实在没别的可做才 `judge_wait({role})` |\n" +
  "| 任务做完了 | `declare_done({summary})` — 门禁复检后收尾，工作留在当前分支 |\n" +
  "| 要改敏感文件 / 缩小审查范围 | `request_sensitive_edit` / `request_scope_limit` |";

/**
 * The check that stops the "ask in prose, end the turn, get woken up" cycle.
 * It is phrased as a question the agent answers, not as a rule it obeys.
 */
export const END_OF_TURN_CHECK =
  "结束本轮前自检：有没有「本该调工具却写成了文字」的事？" +
  "想问用户 → `ask_user`；改完了 → `judge_submit({role:\"reviewer\"})`；" +
  "拿不定主意 → `judge_submit({role:\"adviser\"})`。有就先调，别把工具的活写成一段话。";

/**
 * Adopting a requirement (user ask, O12): understand, ask, restate, confirm.
 *
 * The failure it prevents is silent and expensive — implementing the agent's
 * OWN reading of a request and discovering the gap at review time.
 */
export const REQUIREMENT_PROTOCOL =
  "## 采纳需求前（澄清 → 反述 → 确认）\n" +
  "1. 先理解，别直接开干：找出范围、边界、交付方式、没说清的术语里的疑点。\n" +
  "2. 有疑点就用 `ask_user` 一次问清（带选项和你的推荐）——不要靠猜。\n" +
  "3. 准备采纳时先**反述**：目标、范围、交付物、非目标，让用户确认。\n" +
  "4. 用户确认后才采纳（进 goal 协商或开始实现）；他提出修正就改完再反述一次。";

/**
 * Explore-mode extra guidance, appended after the standing block when the
 * session is in explore mode (investigation). One reminder the decision table
 * does not carry: a task that turns into delivery work must first be
 * escalated to the full loop (set_gate_mode("loop") applies immediately, no
 * user consent needed). Measured 2026-08-31: an explore session receiving a
 * fix request went straight to editing, skipping the escalation.
 */
export const EXPLORE_MODE_NOTE =
  "## 注意（explore 探查模式）\n" +
  "当前是 explore（探查）模式：门禁为 advisory，ship 命令（git commit/push、gh pr）仍被完整拦截。\n" +
  "若用户的任务变成**交付性工作**（修复、实现、重构、要提交上线），先调用 `set_gate_mode(\"loop\")` " +
  "升级到完整门禁循环（立即生效，无需用户确认），再开始改代码；只有纯分析/只读调查才留在 explore。";

/** The whole standing block, in the order an agent reads it. */
export function buildAgentDirectives(mode?: "loop" | "explore"): string {
  return (`${TOOL_DECISION_TABLE}\n\n${REQUIREMENT_PROTOCOL}\n\n${END_OF_TURN_CHECK}` +
    (mode === "explore" ? `\n\n${EXPLORE_MODE_NOTE}` : ""));
}

/**
 * The nudge `agent_settled` adds when the previous turn ended in prose while
 * gates were unmet — the exact moment the decision table exists for.
 */
export const SETTLED_TOOL_REMINDER =
  "上一轮是直接输出结束的，而门禁还没满足。如果你本来是想问用户，用 `ask_user`（它会问并暂停）；" +
  "如果改完了，用 `judge_submit({role:\"reviewer\"})`。";
