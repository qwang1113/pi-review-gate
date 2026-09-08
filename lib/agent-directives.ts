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
 * THE wait discipline — one wording, two waiters (2026-09-05, user decision).
 *
 * WHAT IT REPLACED. The gate forbade ending a turn to be woken up and, at the
 * same time, had no waiting tool on the agent surface. The only move left was
 * a hand-written `sleep` loop inside one bash call — which never ends the
 * turn, so the session never settles, so the wake-up never fires: a measured
 * nine minutes with a finished review sitting unrecorded on disk. A rule that
 * forbids every exit is not a rule, it is a trap.
 *
 * THE THREE SENTENCES, and why each one is phrased the way it is:
 *  ① do the deterministic work you have. Its second half is deliberately SOFT
 *    — after submitting a round there is often genuinely nothing to prepare,
 *    and a rule that demands work anyway just teaches the agent to invent
 *    some. The gate SUGGESTS looking ahead or drafting the closing report.
 *  ② only then wait, and wait through the TOOL — not a sleep loop, and not by
 *    ending the turn (the supervisor of the gate is the session itself).
 *  ③ the tool is message-driven, so waiting is cheap: it returns on the first
 *    thing that happened, not at the end of the round.
 *
 * The PROJECT MANAGER gets the same three sentences with its own tool named,
 * plus the one thing that is only true of it: it supervises PEOPLE-facing
 * children, so handing the watch back to the user is the failure mode its
 * wording has always guarded against. That clause is kept verbatim in spirit.
 */
export function buildWaitDiscipline(tool: "judge_wait" | "orchestrator_wait"): string {
  const messages = tool === "judge_wait"
    ? "新 finding、judge 提问、本轮结论、pane 消失"
    : "子会话提问、子会话完成、子会话静默、pane 消失";
  const second = tool === "judge_wait"
    ? `②确实没活可做了，才调 ${tool} 等 —— 不是手写 sleep 轮询，也不是结束 turn。`
    : `②确实没活可做了，才调 ${tool} 等 —— 不是手写 sleep 轮询，更不要结束 turn 把盯梢责任丢回给用户。`;
  return (
    "等待纪律：①有确定性工作（代码/测试/文档/其他 repo 事务）就先做掉，尤其 goal / plan 审计期间：读代码、调查、补上下文；" +
    "送 reviewer 前应已准备充分，送完往往没事可做——这时可以看看下一轮要什么、或先准备收尾报告（提示，不强求）。" +
    second +
    `③${tool} 是消息驱动的：${messages}，任一到达即返回，拿到就继续干。`
  );
}

/** The child/loop-session wording — the one injected with a judge's replies. */
export const WAIT_DISCIPLINE_HINT = buildWaitDiscipline("judge_wait");

/** The project-manager wording — same three sentences, its own tool. */
export const ORCHESTRATOR_WAIT_DISCIPLINE = buildWaitDiscipline("orchestrator_wait");


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
  "| 把需求反述给用户确认（谈 goal 之前的必经一步） | `propose_restatement({restatement, station})` — 没有它，propose_loop_goal 直接被拒且不弹框 |\n" +
  "| 提交 goal 草稿 | `propose_loop_goal({goal})` — 门禁自己跑 goal 审计，过了才弹用户批准框 |\n" +
  "| 自己决定不了的设计取舍 | `judge_submit({role:\"adviser\", task})` |\n" +
  "| 当前在 main/master/dev/develop 上要提交 | checkpoint 会被门禁直接拒（2026-09-16 起不弹确认框）；ship 提交（git commit）也会被拒 — 先切到功能分支 |\n" +
  "| 有 judge 在跑、还有活可做 | 先把活做掉——新消息落盘时门禁会用标准报告唤醒你（结论、证据位置、记录情况、待答问题） |\n" +
  "| 有 judge 在跑、确实没活可做 | `judge_wait({role})` — 消息驱动：新 finding / judge 提问 / 本轮结论 / pane 消失，任一到达即返回 |\n" +
  "| 任务做完了 | `declare_done({summary})` — 门禁复检后收尾，工作留在当前分支 |\n" +
  "| 要改敏感文件 / 缩小审查范围 | `request_sensitive_edit` / `request_scope_limit` |";


/**
 * MINIMALISM REMINDER — the write-time half of the doctrine (2026-09-08, user
 * decision): a nudge, never a block. The rules live in
 * `docs/coding-standards.md` §5 (their only substantive copy — this block
 * cites, never quotes). Rendered into the standing block by
 * buildAgentDirectives, so every turn carries it exactly once.
 */
export const MINIMALISM_REMINDER =
  "最小化提醒（只提醒、不阻塞，规则见 `docs/coding-standards.md` §5）：" +
  "动手前先想复用（仓库已有 / 标准库 / 平台原生 / 已装依赖），能删先删再写，" +
  "新增依赖必须在送审说明里论证为什么现有手段做不到。";

/**
 * The check that stops the "ask in prose, end the turn, get woken up" cycle.
 * It is phrased as a question the agent answers, not as a rule it obeys.
 */
export const END_OF_TURN_CHECK =
  "结束本轮前自检：有没有「本该调工具却写成了文字」的事？" +
  "想问用户 → `ask_user`；改完了 → `judge_submit({role:\"reviewer\"})`；" +
  "拿不定主意 → `judge_submit({role:\"adviser\"})`。有就先调，别把工具的活写成一段话。";
/**
 * GATE-ANOMALY PROTOCOL (2026-09-08, user decision) — what an agent does when
 * the gate itself looks broken. Measured failure: a replace-tool schema/gate
 * conflict sent the session into self-diagnosis (reading the gate's own
 * source), workaround edits (python heredocs) and blind retries — dozens of
 * tool calls that never fixed the tool. The gate cannot police its own bugs;
 * the human is the escalation path, so this protocol is injected into the
 * standing block and the rule is: STOP and REPORT, never explore or route
 * around. `request_arbitration` (a block wrongly refused) and `/gate-doctor`
 * (diagnostics) remain the sanctioned channels and are unaffected.
 */
export const GATE_ANOMALY_PROTOCOL =
  "## 发现门禁异常时（禁止自主探索，直接报告）\n" +
  "如果工具/门禁表现异常——同一调用反复被拒但错误看不出是自己造成的、拒绝文案自相矛盾、" +
  "工具参数 schema 与门禁要求冲突（如带 path 被拒、不带也被拒）——\n" +
  "1. **禁止**：自主诊断门禁（深读 review-gate 扩展/lib 源码找原因）、绕路（python/sed 改文件、换非正规通道）、反复盲试。\n" +
  "2. **直接报告**：停下，用 `ask_user` 把问题交给用户——现象、出问题的调用原文、门禁返回原文、" +
  "你判断为什么是门禁问题而不是你的错（给出复现步骤）。等用户裁决，不自行继续。\n" +
  "3. 正轨不受影响：`request_arbitration` 只用于「某个 block 是误判」的正式申诉；`/gate-doctor` 是给用户跑的诊断命令。";



/**
 * Adopting a requirement (user ask, O12): understand, ask, restate, confirm.
 *
 * The failure it prevents is silent and expensive — implementing the agent's
 * OWN reading of a request and discovering the gap at review time.
 *
 * Since 2026-09-06 the restatement is no longer ADVICE: `propose_restatement`
 * is a tool, and `propose_loop_goal` / `orchestrator_plan({action:"submit"})`
 * refuse without a confirmed one. So this block is a SUMMARY and a POINTER —
 * the rules themselves (what the text must contain, what happens without one)
 * live in lib/restatement.ts, and restating them here would be the second
 * copy that drifts.
 */
export const REQUIREMENT_PROTOCOL =
  "## 采纳需求前（澄清 → 反述 → 确认）\n" +
  "1. 先理解，别直接开干：找出范围、边界、交付方式、没说清的术语里的疑点。\n" +
  "2. 有疑点就用 `ask_user` 问清（带选项和你的推荐）——不要靠猜，问几轮都行。\n" +
  "3. **反述是强制的一步，且有工具**：`propose_restatement({ restatement, station })` " +
  "把上下文、例子、改之前 → 改之后、哪几步会变得不同交给用户确认，" +
  "同时定下本轮交付到哪一站（precommit / commit / pr）。\n" +
  "4. 没有已确认的反述，`propose_loop_goal` 与 `orchestrator_plan({action:\"submit\"})` " +
  "会直接被拒、一个框都不弹（拒绝文案里有可照抄的骨架）；需求变了就再反述一次，最新一份生效。";

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
  return (`${TOOL_DECISION_TABLE}\n\n${MINIMALISM_REMINDER}\n\n${REQUIREMENT_PROTOCOL}\n\n${END_OF_TURN_CHECK}` +
    `\n\n${GATE_ANOMALY_PROTOCOL}` +
    (mode === "explore" ? `\n\n${EXPLORE_MODE_NOTE}` : ""));
}

/**
 * The nudge `agent_settled` adds when the previous turn ended in prose while
 * gates were unmet — the exact moment the decision table exists for.
 */
export const SETTLED_TOOL_REMINDER =
  "上一轮是直接输出结束的，而门禁还没满足。如果你本来是想问用户，用 `ask_user`（它会问并暂停）；" +
  "如果改完了，用 `judge_submit({role:\"reviewer\"})`。";
