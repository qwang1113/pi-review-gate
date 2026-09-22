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
 * WRITE-TIME REMINDERS — the standing block's half of "standards first"
 * (2026-09-16, user decision).
 *
 * WHAT REPLACED WHAT. There used to be ONE reminder here, about minimalism,
 * and it was the only rule an agent saw before writing. The standards it cited
 * (§5) now have siblings — safety, module placement, comments and nesting —
 * and every one of them caught at review time costs a full round. So they are
 * cited HERE, before the first edit, instead of only by the code-quality
 * judge afterwards.
 *
 * CITE, NEVER QUOTE. Each line names its section of `docs/coding-standards.md`
 * and one ACTION; the clause text stays in the document (the copy map in
 * docs/module-map.md §7 records how often a second copy has drifted). The
 * block is a NUDGE, never a block — write-time is advisory by contract, and
 * `test/agent-directives.test.ts` pins both halves of that sentence.
 */
export const WRITE_TIME_REMINDERS =
  "写作前提醒（只提醒、不阻塞；条文见 `docs/coding-standards.md`）：\n" +
  "- §5 最小化：动手前先想复用（仓库已有 / 标准库 / 平台原生 / 已装依赖），能删先删再写，" +
  "新增依赖必须在送审说明里论证为什么现有手段做不到。\n" +
  "- §6 安全：外部输入进命令 / 路径 / SQL 之前先转义或走白名单；敏感信息不落盘、不进日志；" +
  "破坏性操作（删除 / 覆盖 / force push / reset --hard）要显式确认。\n" +
  "- §6 落点与规模：新增职责先问它落在哪个模块，别往已经很大的文件里加。\n" +
  "- §6 注释与嵌套：注释写「为什么」不写「是什么」；嵌套超过 3 层用卫语句消掉。";

/**
 * The round-note hint — what to put in `judge_submit`'s `task`, in both
 * places the agent can meet it (the tool's parameter description and the
 * standing block's decision table). ONE constant, so the two cannot drift
 * into two different asks: the reviewer's whole context for the round is the
 * text the agent writes here, and an empty or vague note is what turns a
 * review into a guess.
 */
export const ROUND_NOTE_HINT =
  "写清这轮改了什么、为什么 —— 这段说明就是 reviewer 看到的全部改动上下文。";

/**
 * Situation → tool. Deliberately short: an agent scanning this mid-task must
 * find its row in one pass.
 */
export const TOOL_DECISION_TABLE =
  "## 情况 → 工具（结束本轮前先对照）\n" +
  "| 你现在要做的事 | 调这个 |\n" +
  "| --- | --- |\n" +
  "| 问用户、等用户拍板 | `ask_user({questions})` — 它会问并暂停循环；别把问题写进回复就结束 |\n" +
  "| 提交本轮改动送审 | `judge_submit({role:\"reviewer\", task})` — 门禁自己跑 precommit→checkpoint→送审；" +
  ROUND_NOTE_HINT + " |\n" +
  "| 把需求反述给用户确认（谈 goal 之前的必经一步） | `propose_restatement({restatement, station})` — 没有它，propose_loop_goal 直接被拒且不弹框 |\n" +
  "| 提交 goal 草稿 | `propose_loop_goal({goal})` — 门禁自己跑 goal 审计，过了才弹用户批准框 |\n" +
  "| 自己决定不了的设计取舍 | `judge_submit({role:\"adviser\", task})` |\n" +
  "| 当前在 main/master/dev/develop 上要提交 | checkpoint 会被门禁直接拒（2026-09-16 起不弹确认框）；ship 提交（git commit）也会被拒 — 先切到功能分支 |\n" +
  "| 有 judge 在跑、还有活可做 | 先把活做掉——新消息落盘时门禁会用标准报告唤醒你（结论、证据位置、记录情况、待答问题） |\n" +
  "| 有 judge 在跑、确实没活可做 | `judge_wait({role})` — 消息驱动：新 finding / judge 提问 / 本轮结论 / pane 消失，任一到达即返回 |\n" +
  "| 想知道自己上下文用了多少 | `context_status()` — 门禁报出 tokens / 窗口 / 百分比 + 70% 阈值判定；**不要凭感觉估** |\n" +
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
 * GATE-ANOMALY PROTOCOL (2026-09-08, user decision; split into two layers
 * 2026-09-08 the same day after the user's clarification) — what an agent
 * does when the gate itself looks broken.
 *
 * TWO LAYERS, DELIBERATELY. A single failure is normally the agent's own:
 * fix the call and retry — that is the ordinary path and must NOT stop for a
 * report (over-escalating a retryable failure is itself a failure mode: it
 * interrupts flow for something the caller can fix). Only a genuine anomaly
 * — deadlock or another blocking condition — escalates. Measured example of
 * the real thing: a replace-tool schema/gate conflict (path rejected by one
 * side, demanded by the other — no legal call exists) sent a session into
 * self-diagnosis, workaround edits and blind retries for dozens of calls.
 * The gate cannot police its own bugs; the human is the escalation path, and
 * this protocol is injected into the standing block.
 * `request_arbitration` (a block wrongly refused) and `/gate-doctor`
 * (diagnostics) remain the sanctioned channels and are unaffected.
 */
export const GATE_ANOMALY_PROTOCOL =
  "## 门禁异常时（分层：可重试直接继续；真异常才停下报告）\n" +
  "**① 可重试 —— 直接继续，不报告（常态）：** 单次/偶发失败，错误明确指向调用自身" +
  "（参数校验、oldText 不匹配、缺字段、工具名写错）——修调用立即重试，这是正常路径，不要停下来。\n" +
  "**② 真异常 —— 停下，用 `ask_user` 报告（禁止自主探索/绕路/盲试）：** 死锁与阻塞性故障，特征：\n" +
  "   - 修正调用后仍被**同一方式**拒绝，且看不出还能怎么修（错误不随修正变化）；\n" +
  "   - 门禁自锁：等待/审计反复同一句失败（如「未命中本轮 report」）而 pane 早已交卷；\n" +
  "   - 工具参数 schema 与门禁要求互斥，不存在合法调用（如带 path 被拒、不带也被拒）；\n" +
  "   - 任何重试都回到同一点，无法推进。\n" +
  "   报告内容：现象 + 出问题的调用原文 + 门禁返回原文 + 已试过的修正与重试次数 + " +
  "为什么判断是门禁问题。等用户裁决，不自行继续。\n" +
  "③ 正轨不受影响：`request_arbitration` 只用于「某个 block 是误判」的正式申诉；`/gate-doctor` 是给用户跑的诊断命令。";


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
  "2. 有疑点就用 `ask_user` 问清 —— 每题必须 2–4 个选项 + 一个 recommended（门禁会自动追加「✎ 不选，我说明原因」那一行）；" +
  "**选项文本不要自带 `A. ` / `1. ` 这类编号** —— 门禁会自己给每行加字母编号，写了就变成「A. A. …」。" +
  "多选题写 `multiple: true` 并必须给 `defaultChecked`（清单打开时勾好的那一组 = 直接回车接受的那一组；" +
  "`[]` 表示推荐一项都不勾）—— 多选题不需要 recommended；不要靠猜，问几轮都行。\n" +
  "3. **反述是强制的一步，且有工具**：`propose_restatement({ restatement, station })` " +
  "把上下文、例子、改之前 → 改之后、哪几步会变得不同交给用户确认，" +
  "同时定下本轮交付到哪一站（precommit / commit / pr）。\n" +
  "4. 没有已确认的反述，`propose_loop_goal` 与 `orchestrator_plan({action:\"submit\"})` " +
  "会直接被拒、一个框都不弹（拒绝文案里有可照抄的骨架）；需求变了就再反述一次，最新一份生效。\n" +
  // A POINTER, NOT A COPY (2026-09-17, 用户要求). The three skeletons live in
  // the modules that own their documents — LOOP_GOAL_SKELETON in
  // lib/loop-goal.ts, PLAN_TASK_SKELETON in lib/orchestrator-directives.ts —
  // and what the standing block owes the agent is the fact that they EXIST and
  // where they are shown. Quoting them here would be a second copy of a
  // template whose whole job is to be filled in once, in one place.
  "4b. **要写 goal / plan 就照骨架填，别自己发明格式**：goal 骨架见 `propose_loop_goal` 的" +
  "工具说明（goal 审计打回时，拒绝文案里附的是同一份）；plan 任务书骨架见 `orchestrator_plan` " +
  "的工具说明与 `plan.tasks[].note` 的描述。\n" +
  // 2026-09-14（用户要求）：「打断」是语义上的插话，不是按 ESC —— 用户不点选项、
  // 直接在框外说别的事。他往往不止一件事要说，而「答完他就立刻重新弹框」会让他
  // 每次都再打断一次。这条不硬拦（用户明确说「不用做得特别死」），但它对三个
  // 协商环节是同一口径；三处工具在「用户没有作答」时返回的文案也指向同一动作。
  "5. **协商被用户插话时，先问一句再继续**：你反述完、或请用户批准 goal / plan 时，他可能**不点选项**，" +
  "而是在框外提出别的问题或补充（这就是「打断」）。把他说的处理完之后，用 `ask_user` 问一句：" +
  "「关于这份需求/目标/plan，还有别的要补充或要问的吗？没有了我就继续重新反述 / 重新协商 / 重新提交」；" +
  "得到「没有了」再继续。**不要一答完就自动重新弹一次协商框** —— 他往往还没说完。" +
  "三个环节（反述 / goal / plan）都按这一条做。";

/**
 * READING IN PARALLEL — the one rule that costs a model round-trip per read.
 *
 * MEASURED (2026-09-10, this repo): 92.5% of a reviewer's assistant messages
 * carried exactly ONE tool call (mean 1.08) over every reviewer session on
 * disk, and tool execution was 6% of a 226-285s round — the rest was the model
 * waiting on itself, once per file. The main session is no better (85.3% single
 * calls, mean 1.16, ~356 minutes of model time across one week of sessions).
 *
 * pi runs the tool calls of ONE assistant message IN PARALLEL, so the cost is
 * not the reads — it is the number of MESSAGES they are spread across. This is
 * the same conclusion the gate acts on from the other side: a reviewer's task
 * text now ships a pre-split batch plan (lib/parallel-review.ts's
 * formatChangeIndex) so the reads are already grouped before the agent starts.
 *
 * The rule is stated identically in the judge protocol (lib/judge-prompt.ts,
 * JUDGE_COMMON_PROTOCOL) — test/agent-directives.test.ts pins the shared
 * sentence so the two cannot drift.
 */
export const BATCH_READ_DISCIPLINE =
  "## 读代码：一条消息里并行读，不要一条消息读一个\n" +
  "- **一条 assistant 消息里的多个工具调用是并行执行的**：要读多个文件、搜多个模式、看多处 diff 时，" +
  "把它们放进**同一条消息**，不要一条消息只发一个。一个工具调用就是一个完整来回（等模型 + 等工具）。\n" +
  "- 先拿清单再读：`git diff --stat` / `--numstat` 之类的总览先到手，按清单分批读。\n" +
  "- 实测（本 repo 全部 reviewer session）：92.5% 的往返只发 1 个工具调用，单轮 17–59 次往返 × 每次 11–13s，" +
  "而工具执行只占这一轮的 6% —— 少一个往返就是少十几秒。";

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

/**
 * HOW BIG IS THIS? — asked BEFORE the work starts (user ask, 2026-09-21).
 *
 * WHAT IT PREVENTS. A loop session given a requirement that outgrows it has
 * two bad options and picks one: grind on until the context runs out (the
 * work is lost, or a handover interrupts it mid-round), or assemble a
 * half-parallel approach by hand. The right shape — a plan, several child
 * sessions, one exit contract — exists (`set_gate_mode("orchestrator")`) and
 * was reachable only by the USER typing it. The measured cost is a whole run
 * spent in the wrong mode.
 *
 * THE USER'S OWN THREE MARKS (verbatim from the request): 一个会话做不完 /
 * 有明显可并行的独立部分 / 要改多个仓库. They are deliberately coarse: this is
 * a judgement call the agent makes from the requirement in front of it, not a
 * threshold the gate can measure, so a fine-grained rule would be a rule the
 * agent cannot apply.
 *
 * ASK FIRST, THEN SWITCH (user decision, 2026-09-21): the agent names what it
 * sees, asks with a RECOMMENDATION, and only then calls `set_gate_mode`
 * itself — the user never has to type a command. A refusal is final: no
 * second ask, and the work continues in loop mode.
 *
 * LOOP MODE ONLY. `set_gate_mode` upgrades are immediate, so an explore
 * session that gets delivery work follows {@link EXPLORE_MODE_NOTE} to loop
 * first; a project manager is already past this decision (it has no plan to
 * write a bigger one into).
 */
export const SCOPE_ESCALATION_PROTOCOL =
  "## 开工前先量一下活儿有多大（命中就在动手前问用户）\n" +
  "动手之前先拿你面前这个需求对照三条 —— 命中任一条，就是「该交给项目经理调度」的活儿：\n" +
  "① 一个会话做不完（要改的东西多到一个上下文撑不住，或明显要分几轮才能完成）；\n" +
  "② 有明显可并行的独立部分（几块互不重叠的写面可以同时开工）；\n" +
  "③ 要改多个仓库（跨 repo 的改动天然要统一协调与统一交付）。\n" +
  "命中任一条 ⇒ **先用 `ask_user` 主动问用户**要不要切成项目经理模式，把你的判断和推荐一起说清楚；\n" +
  "用户同意 ⇒ **你自己调 `set_gate_mode(\"orchestrator\")` 完成切换**（命令由你敲，不要让用户去敲），" +
  "然后按编排流程写 plan、请他批准、派子会话；\n" +
  "用户不同意 ⇒ 就留在 loop 模式按现在的流程把这件事做完，**不要再提第二次**。";

/** The whole standing block, in the order an agent reads it. */
export function buildAgentDirectives(
  mode?: "loop" | "explore",
  opts: {
    /**
     * Render the SCOPE-ESCALATION rule? FALSE for the shared `loop` mode prompt
     * (2026-09-21). That block is injected into orchestration CHILDREN too, and
     * a child's `set_gate_mode("orchestrator")` is refused mechanically — so
     * the rule would send it to a call that cannot succeed. The row belongs to
     * sessions that can act on it, which is why the TOP-LEVEL injection site
     * appends it (extensions/review-gate.ts).
     */
    scopeEscalation?: boolean;
  } = {},
): string {
  const scope = opts.scopeEscalation === false ? "" : `${SCOPE_ESCALATION_PROTOCOL}\n\n`;
  return (`${TOOL_DECISION_TABLE}\n\n${WRITE_TIME_REMINDERS}\n\n${REQUIREMENT_PROTOCOL}\n\n` +
    (mode === "explore" ? "" : scope) +
    `${BATCH_READ_DISCIPLINE}\n\n${END_OF_TURN_CHECK}` +
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
