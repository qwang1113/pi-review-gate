# 模块地图（module-map）

> 日期：2026-08-29 · 事实基准：本文所有结构性断言都能用文中给出的命令在
> 仓库里当场复核。数字（文件数、工具数、行数）是**快照**，命令是**判据**——
> 两者不一致时以命令输出为准。

这份文档只回答一个问题：**「我这段新代码该落在哪个文件？」**

它不是 API 手册（每个模块头部的块注释才是，而且写得比这里详细），也不是
执行流程说明（那是 `docs/execution-model.md` 与 `docs/judge-protocol.md`）。
它是一张地图：先告诉你门禁被切成了哪几个职责域、每个域的边界在哪，再给一张
`lib/` 全量模块的速查表，让你在动手前 30 秒内找到落点。

写新功能时先想清楚它落在哪个模块，而不是落在「我正好打开的那个文件」——
`extensions/review-gate.ts` 曾经的七千余行（顶峰近 9000 行）就是几十次「只加 100 行」
累积出来的；t1–t8 四波搬迁（2026-09-26 收尾）之后它只剩约 1400 行接线。

改**已有**口径（一条规则、一份清单、一个数字）而不是加新代码时，先看 §七
「口径副本地图」：同一段话在这个仓库里往往有好几份手抄，它告诉你还有哪几处
要跟着改、哪条测试会替你兜底、哪几处**没有任何测试看着**。

---

## 一、`extensions/review-gate.ts` 是什么

它是**扩展入口，只剩接线**（t8，2026-09-26）：会话的可变状态建成一个
`SessionCells`（`lib/session-cells.ts`），再把它和各 host 的 deps 交给 `lib/` 里的
工具注册函数与事件处理函数。**工具体、事件处理体、会话状态的闭包函数都不在
这里** —— 往这个文件里加一段逻辑，就是在重新长回那九千行。

### 1.1 它接线的生命周期事件

每个 `pi.on(...)` 都是一行（最长不过几行）接线，处理体在右列写的 lib/ 模块里：
`session_start` / `session_shutdown` / `session_compact` → `lib/session-lifecycle.ts`；
`before_agent_start` / `turn_end` / 思考空转熔断的 `agent_settled` 与 `message_*` →
`lib/turn-directive.ts`；L2 的 `agent_end` / `agent_settled` → `lib/l2-continuation.ts`；
`tool_result` / `input` / 后台 agent 的 `message_end` → `lib/tool-event-hooks.ts`（编辑分支在
`lib/edit-tracking-hook.ts`）；judge pane 自己的 `agent_end` / `agent_settled` →
`lib/judge-pane-self.ts`；`tool_call` → `lib/ship-gate-hook.ts`。**注册的相对顺序与搬迁前
一致**（handler 在同一事件上按注册顺序跑，顺序本身就是行为）。

| 事件 | 门禁在这里做什么 |
| --- | --- |
| `session_start` | 恢复 sidecar 状态、判定会话模式、装配常驻指令；按 session id 接管本会话已登记的名字，并扫一遍注册表回收死会话留下的 tmux session/登记/inbox（t2），然后装上名字续期定时器 |
| `before_agent_start` | 每轮注入 L4 语言指令、goal 摘要、per-turn 协议提醒 |
| `tool_call` | L1 ship 拦截、敏感文件拦截、L5 文案判定 —— **正文已搬进 `lib/ship-gate-hook.ts` + 两条臂**，扩展只留一行接线与注入的 deps |
| `tool_result` | 追踪本轮编辑、记录 precommit 结果、编辑纪律 nudge、附加提示 |
| `input` | 用户真的说话了：重置编辑失败 nudge、解除 ESC 暂停 |
| `agent_end` | ESC 中止检测，喂给 L2 的暂停判定 |
| `agent_settled` | L2 自动续跑（递归保护、轮次上限、平台期停止）；思考空转熔断的提示也在这里发出（`abort()` 之后会话才空闲，steer 队列得等下一次 run 才被取用） |
| `turn_end` | 本轮编辑/提交状态对账（哪些改动仍在武装门禁） |
| `message_start` / `message_update` / `message_end` | 思考空转熔断：把 assistant 流的三类增量（thinking / text / toolcall）喂给 `lib/thinking-loop-controller.ts`，assistant 消息边界重置与收尾；扩展只转发，判定与动作都在那两个模块里。**另有一条 `message_end`**（2026-09-09）折叠 `subagent-notification` 自定义消息，喂给 `background-wait.ts` 的终态信号；同一条信号还有**事件总线**那个来源（`pi.events.on("subagents:completed" / "subagents:failed")`，2026-09-17，每次跑完都发），两者都只做一件事：把那个 agent id 从等待集合里去掉 |
| `session_shutdown` | 收尾清理（watcher、临时资源）；停掉名字续期定时器，并且**除 `reload` 外都把名字腾出**（`/new`、`/resume`、`/fork` 会换 session id 并重建扩展实例，而 pane 与 pid 不变 —— 不释放就会留下一个永远被判 `live` 的登记；`reload` 复用同一个 session id，下一次 `session_start` 接管同一登记）；进程 `exit` 钩子是所有路径的兵底 |
| `session_compact` | 压缩后重新注入门禁状态与 git 记忆 |

核对（这张表的完整判据）：`grep -rn 'pi\.on("' extensions/review-gate.ts lib/` —— 入口里 12 行
接线，另有 7 个注册在 lib/ 的注册函数里（`judge-pane-self.ts` 2 个、`turn-directive.ts` 4 个、
`tool-event-hooks.ts` 1 个）。

### 1.2 工具注册分两处（重要）

- **扩展一个工具都不直接注册了**（t8，2026-09-26）。原先直接注册的 4 个也搬进了
  `lib/`，扩展里各只剩一次 `register…Tool(pi, cells, deps)` 接线：
  `judge_submit` → `lib/judge-submit-tool.ts`（回执文案在 `lib/judge-submit-receipt.ts`）、
  `declare_done` → `lib/declare-done-tool.ts`、`set_gate_mode` → `lib/gate-mode-tool.ts`、
  `request_arbitration` → `lib/arbitration-tool.ts`（`setup_workspace` 于 2026-09-07 退役）。
  两个内部步骤 `review_checkpoint` / `run_precommit` 同样搬走
  （`lib/checkpoint-tool.ts` / `lib/precommit-tool.ts`，仍注册在 internalHost）。
  核对：`grep -c 'pi.registerTool({' extensions/review-gate.ts` → 0。

- **20 个工具已经搬进 `lib/`，不在扩展里**——而且这是这个仓库正在走的方向：
  - `lib/goal-tools.ts`：`propose_loop_goal`（L8：跑 goal 审计 → 问用户 →
    写文件），并且是这一族的**唯一注册入口**——扩展里只有一次
    `registerGoalTools(pi, {...})` 接线。审计记录侧在
    `lib/goal-prereview-tools.ts`（`recordGoalPrereview`：普通函数，2026-09-04
    起不再注册成任何工具，门禁在审计轮的 report 落盘时自己调；外加两个 goal
    入口共用的提交检查）。
  - `lib/user-interaction-tools.ts`：`ask_user`（采访本身），并且是这一族的
    **唯一注册入口**——它自己调 `lib/consent-request-tools.ts`，所以扩展里只有
    一次 `registerUserInteractionTools(pi, {...})` 接线。
  - `lib/consent-request-tools.ts`：`request_scope_limit`、
    `request_sensitive_edit`（两个「请用户放宽门禁」的工具；对话、门禁状态与
    授权表都经注入的 deps 拿，所以「对话弹不出来 ≠ 用户拒绝」这类分支能用假
    实现单测）。
  - `lib/copilot-review-tools.ts`：`copilot_review`（L7 唯一的工具：发请求 / 报排队状态 / 报 findings 三合一；它要打的 gh 电话在
    `lib/copilot-gh.ts`，经注入的 `gh` seam 调用，所以每条分支都能用假实现单测）。请求半段、排队探针与回复文案
    分别在 `lib/copilot-request-phase.ts` / `lib/copilot-queue-probe.ts` / `lib/copilot-review-replies.ts`。
  - `lib/copilot-watch.ts`：L7 等待的全部策略（轮询节奏、排队证据的判定
    `decideCopilotWait`、一次 tick 的判定）与 `copilot_review` 自己跑的阻塞等待 `awaitCopilotNews`
    （2026-09-23 起取代扩展里的后台 watcher：等待不再靠结束 turn + 唤醒）——扩展只把「正在阻塞」
    报进子会话心跳（`waiting-judge`，`waitingFor: copilot`）。
  - `lib/judge-session-tools.ts`：两个作用在既有 pane judge 上的入口 ——
    `judge_close`（只在 internalHost，门禁自己的审计链收自己派的 judge）与
    `judge_wait`（**同一实现注册到 internalHost 与 agent 面**，`registerJudgeWaitTool`；
    消息驱动：新 channel report / pane 死亡 / judge 提问 / 新 finding 任一到达即返回，
    返回值由 `judge-report.ts` 的标准报告组装）。`judge_read` 已于 2026-09-05 删除
    （零调用死路径）。等待循环在 `lib/judge-wait-tool.ts`、判据在 `lib/judge-wait-criteria.ts`、
    寻址与 opener 校验在 `lib/judge-session-addressing.ts`。

  - `lib/judge-spawn-tools.ts`：`judge_spawn` / `judge_answer` / `judge_recover`
    （pane judge 的生命周期工具；agent 只表达 goal / plan 意图，审计任务由门禁组装）。
  - `lib/orchestrator-tools.ts`：`orchestrator_plan` 的注册（schema + 说明）；各 action 的实现在
    `lib/orchestrator-plan-action.ts`，批准框文案在 `lib/orchestrator-plan-messages.ts`
    （`orchestrator_notify` 已删除 —— 通知改由门禁自己发，见 `lib/user-notify.ts`）。
  - `lib/orchestrator-session-tools.ts`：`orchestrator_spawn`、
    `orchestrator_instruct`、`orchestrator_wait`、`orchestrator_close` 的注册
    （wait / close 的实现在 `lib/orchestrator-wait-tool.ts` / `lib/orchestrator-close-tool.ts`；
    并从这里转注册下面两个模块，所以「有哪些编排工具」
    只有一个地方回答）。交接工具 `session_handoff` **不在**这里：它属于每一类
    会话，注册在扩展侧（`lib/session-handoff-tools.ts`）。
  - `lib/orchestrator-answer-tools.ts`：`orchestrator_answer`（裁决规则在 `lib/orchestrator-answer-rules.ts`）。
  - `lib/orchestrator-recovery-tools.ts`：`orchestrator_recover`、
    `orchestrator_attach`。
  - `lib/session-name-tools.ts`：`name_session`（给本会话起一个全局唯一的名字：占登记 →
    写 window title 与 window 级 user option `@rg_session_name` → 心跳续期 → 释放）。
    **注册表、唯一性在 `lib/session-registry.ts`，回收在 `lib/session-orphan-sweep.ts`**，
    扩展只接线五件事：注册工具、`session_start` 的接管+扫孤儿+装定时器、`declare_done` 的释放、
    `session_shutdown` 在**非 `reload`** 时的释放、以及模块作用域那一个进程 `exit` 钩子的释放。
  - `lib/session-message-tools.ts`：`send_message({to, text})`（按 `@名字` 给另一个会话
    发消息 —— 名字就是地址，来自 t2 的注册表）。发送侧判定与工具注册、inbox 记录的组装与
    写入、收件侧消费（取件 → 注入 → 成功即删 / 失败留原地下次重试）都在这里；文件原语
    （单次 `O_APPEND` 一行 + 超长 spill 到 side file）复用 `lib/channel-io.ts` 的同一
    约定，路径走 `session-registry.ts` 的 `sessionInboxPath`（取件名从它派生，不另立规则）。
    扩展只接线两处：注册工具、把 `drain()` 挂在 t2 已有的命名心跳定时器上。它与**结构化
    通道**（PM 指派 / 子会话回报 / judge 结论 / ask_user 代答）是两回事，后者一行不动。
  核对：`grep -rh 'name: "' lib/*.ts | grep -oE 'name: "[a-z_]+"' | sort -u | wc -l`
  → 33（2026-09-25 实测；这个数只随文件漂，写在这里是告诉你**怎么数**，
  不是让你记住它），其中 3 个是下面说的**内部实现**（`prepare_review` / `prepare_adviser` /
  `prepare_goal_audit`，注册在 internalHost），不注册给 pi。

- **5 个实现存在，但不是工具**（2026-08-30，哲学三）。`run_precommit`、
  `review_checkpoint`、
  `prepare_review`、`prepare_adviser`、`prepare_goal_audit` 的**代码还在**——
  它们持有 precommit 回执校验、L5 文案规则、checkpoint 提交信息、审计任务组装这些机械
  检查，`judge_submit` 与 `propose_loop_goal` 在内部调用它们，所以每条检查只有
  一份实现。但它们注册到扩展内部的 `internalHost` 而不是 `pi`：**agent 看不到
  这些名字**，因此没有第二条路可选。另外三个（`review_spawn` / `review_watch` /
  `review_send`）连实现一起删了 —— 它们连内部都没人调。

- **两个 recorder 更进一步：连内部工具都不是**（2026-09-04，用户决定 D4）。
  `record_review` 与 `record_goal_prereview` 是**普通函数**
  （`lib/verdict-host.ts` 的 `recordReviewVerdict`、`lib/goal-prereview-tools.ts` 的
  `recordGoalPrereview`），门禁在本轮 report 落盘时自己调。它们当初之所以要是
  工具，唯一理由是「收一段文本再解析出裁决」；裁决现在是结构化字段直达，参数没
  东西可传了，工具外壳就只剩「第二条可以手工编排的路」。
  核对：`test/extension-structure.test.ts` 的「TEN advanced entries」那一条。


这些模块都经同一道 **seam** 接进扩展：`lib/tool-host.ts` 定义那个 host 类型
（`lib/orchestrator-deps.ts` 只是把它 re-export，因为编排工具是第一批搬出去
的，但 host 是共享的东西、不属于编排这个领域），每个模块导出一个
`register<Family>Tools(host, deps)`，扩展只负责把自己拥有的东西（门禁状态、
仓库根、UI 通道）通过 `deps` 传进去。

这不是特例，是**这个仓库正在走的路**：`lib/judge-session-tools.ts` 的头注释
直接写明它是 orchestrator 那一批搬迁的续集，理由就是 AGENTS.md 那条架构规范
——扩展是一次次「就在这儿再加个工具体」堆到七千余行的（顶峰近 9000 行，几轮
搬迁一路搬下来的）。**新工具族与新命令请照抄这个形状**：判定逻辑在 `lib/`，
注册也在 `lib/`，扩展只提供依赖。

**钩子也开始走同一条路**：`tool_call`（L1）是第一个搬出去的生命周期钩子，
见下面 §1.4。

### 1.3 命令

**命令一个都不在扩展里了**（2026-08-30）。扩展只有**一次**接线调用
`registerGateCommands(pi, {...})`，命令层整体住在两个模块：

- `lib/gate-command-tools.ts`：命令层的**唯一注册入口**。工作流命令的注册包装、
  `/precommit` 那条门禁自己跑的 lane，以及 `/gate-status`、`/gate-contract`、
  `/gate-bypass`、`/gate-mode`、`/gate-reset`、`/gate-lesson` 六个命令的正文；它自己转注册下面
  那个模块，所以「有哪些命令」只有一个地方回答。命令 host 的 seam
  （`CommandHost` / `CommandContext`）也定义在这里 —— 工具走
  `lib/tool-host.ts`，命令是另一个面，两者不混用。
- `lib/gate-diagnosis-commands.ts`：两个**只读**诊断 —— `/gate-status` 内嵌的
  模型链读数（`modelDiagnosisLines`）与 `/gate-doctor` 体检正文。它只做环境探测
  （模型注册表、两层 agent 目录、git 钩子目录、`gh` 可执行），判定规则仍在
  `lib/model-diagnose.ts` / `lib/gate-doctor.ts`。它不写任何状态，也不喂任何裁决。
  → 改一个命令的文案或时机：改 `lib/gate-command-tools.ts`，不必碰扩展。

- 门禁命令共 7 个：`/gate-status`、`/gate-contract`、`/gate-bypass`、`/gate-mode`、`/gate-reset`、
  `/gate-lesson`、`/gate-doctor`。
- 工作流命令（`/review`、`/precommit`、`/precommit-fast`、`/verify`、
  `/next-step`、`/risk-assess`、`/smart-commit`、`/create-pr`、
  `/load-pr-review`、`/watch-ci`、`/gate-init`）的**定义与提示词**在
  `lib/workflow-commands.ts`，`gate-command-tools.ts` 只是循环注册它们。
  → 加一条工作流命令：改 `lib/workflow-commands.ts`，命令层与扩展都不必碰。
- `/gate-reset` 清掉的那一堆会话可变量都是 `SessionCells` 的格子（`lib/session-cells.ts`），
  聚成 `lib/session-restore-host.ts` 的一个 `resetSessionState()`，命令经
  `deps.resetSession()` 一个口子调用它 —— 命令模块只拥有「reset → persist → notify」这个顺序。

### 1.4 L1 `tool_call` 钩子：三个模块

L1 是扩展里最大的一块，现在住在 `lib/`，扩展只留一行接线
（`pi.on("tool_call", (event, ctx) => evaluateToolCall(shipGateHookDeps, event, ctx))`）
加一个注入的 deps 对象。按**职责**切成三块（也让每个文件都远离 600 行硬拦）：

- `lib/ship-gate-hook.ts`：入口 `evaluateToolCall` + 两条臂之间的分派 + deps
  汇总（`ShipGateHookDeps` 是两条臂 deps 的并集）。（judge 角色 subagent
  拦截曾在这里；随 pi-subagents companion 退役 2026-09-06。）
- `lib/ship-gate-edit-guard.ts`：**edit/write 臂**。敏感文件安全底线
  （`sensitiveEditBlock`，唯一一条在 `normal` 模式下也必须生效的检查）、
  gate-owned 豁免、L8 目标门、orchestrator 写限制、L6 标签检查。这里的
  **次序就是契约**：安全底线在 normal 提前返回之前，gate-owned 豁免在 L8
  目标门之前（否则门禁会卡死在自己的文件上）。
- `lib/ship-gate-bash.ts`：**bash 臂 = ship gate 本体**。tmux backstop、
  `/gate-bypass`、ship 命令识别、L5/AI 署名判定、message-only rewrite 豁免、
  逐 repo 门禁检查、一次性仲裁令牌；拦截文案
  （`describeShips` / `buildShipBlockReason`）在 `lib/ship-gate-copy.ts`，注入的
  依赖面在 `lib/ship-gate-bash-deps.ts`。次序同样是契约：tmux backstop
  在 `/gate-bypass` 之上，`/gate-bypass` 在 ship 检测之上。

→ 改 L1 的任何判定：改这三个模块，不必碰扩展；扩展只在 deps 里补一个新的口子。
纯判定的单测在 `test/ship-gate-hook.test.ts`，结构断言在
`test/extension-structure.test.ts`（它扫的是这三个模块的源码，不是扩展）。


---

## 二、L1–L9：每层落在哪

关卡不是一层一个文件，而是「判定在 `lib/`、接线在扩展、纵深防御在
`hooks/` 与 `scripts/`」的分工。

| 层 | 是什么 | 接线/执行在哪 | 判定逻辑在哪 |
| --- | --- | --- | --- |
| **L1** ship gate（硬拦） | 未过门禁前拦下 `git commit` / `git push` / `gh pr create` / `gh pr edit` | `lib/ship-gate-hook.ts`（`evaluateToolCall`），扩展只留一行 `pi.on("tool_call", …)` 接线 | `lib/ship-gate-bash.ts`（ship 臂）、`lib/ship-gate-edit-guard.ts`（edit 臂）、`lib/ship-detect.ts`、`lib/shell-lex.ts`、`lib/constants.ts`、`lib/repo-resolve.ts`、`lib/fingerprint.ts` |
| **L2** 自动续跑 | 门禁未满足时重新触发一轮；事件链断掉时由存活不变量兜底（60s 周期唤醒） | `lib/l2-continuation.ts` 的 `onAgentSettled`（扩展只留一行 `agent_settled` 接线）+ `lib/session-revival.ts` 驱动的独立定时器 | `lib/gate-state-requirements.ts`（未满足项）、`lib/loop-stall.ts`（断路器，只管事件注入路径）、`lib/session-revival.ts`（兜底唤醒，无视预算与断路器、尊重人的叫停） |
| **L3** git 钩子 | 离开 pi 也有效的纵深防御 | `hooks/pre-commit`（薄壳，2026-09-08 起单次 exec）、`hooks/pre-push`、`hooks/commit-msg` | `scripts/pre-commit-check.cjs`（全链单进程：schema/bypass → L6 → divergence+fingerprint → verdict）、`scripts/compute-fingerprint.cjs`、`scripts/check-staged-divergence.cjs`（钩子不依赖 TypeScript） |
| **L4** 输出语言 | 每轮无条件注入简体中文指令 | `lib/turn-directive.ts` 的 `onBeforeAgentStart`（扩展只留一行 `before_agent_start` 接线） | `lib/constants.ts` 的 `LANGUAGE_DIRECTIVE` |
| **L5** commit/PR 英文 | 命令行传的文案由工具层判；编辑器里写的由钩子判 | `lib/ship-gate-bash.ts`（ship 命令上的 commit message / PR 文案）+ 扩展的 checkpoint 路径 + `hooks/commit-msg` | `lib/lang-detect.ts`（唯一实现）、`lib/llm-classify.ts`（只能加拦）、`lib/text-appeal.ts`（申诉） |
| **L6** 测试标签英文 | 暂存内容里的 `it/test/describe` 标签必须英文 | `hooks/pre-commit` → `scripts/pre-commit-check.cjs` → 进程内 `scripts/scan-test-labels.cjs`；扩展侧在编辑时预检 | `lib/edit-projection.ts`（投影改后全文，避免只看片段漏判） |
| **L7** Copilot 审查 | PR 之后的审查闭环：请求、有证据的等待、逐 thread 消账；第 4 轮起每条问题先经用户逐条审批 | `lib/copilot-review-tools.ts`（工具 `copilot_review`）+ `lib/copilot-gh.ts`（gh 访问），扩展只接线（弹框经 `askFinding` 注入、等待是工具内的阻塞调用 `lib/copilot-watch.ts` `awaitCopilotNews`） | `lib/copilot-review.ts`、`lib/copilot-watch.ts`、`lib/copilot-triage.ts` |
| **L8** loop goal | 用户批准的退出契约，未批准则 ship 被拦 | `lib/goal-tools.ts`（工具 `propose_loop_goal`，内部自跑 goal 审计）+ `lib/goal-prereview-tools.ts`（普通函数 `recordGoalPrereview`：裁决落成记录，不注册成工具），扩展只接线 | `lib/loop-goal.ts` |
| **L9** 真实验收轮 | 完成时刻的真实执行验收：本轮有代码改动、且没有绑定当前内容的验收结论时，门禁在 `declare_done` 内**自己**派 `acceptance`（**按 repo**：每个改过的 repo 各有自己的判定、指纹与记录）；非 READY、或结论绑定的内容已移动 ⇒ 拒绝完成（**不进 `unmetRequirements`** —— 修验收 finding 要 commit，那会被它自己拦住） | `lib/acceptance-host.ts` 的 `armAcceptanceRound` / `acceptanceStepForRepo` / `dispatchAcceptanceRound`（逐 repo 判定、派发；t7 从扩展拆出，扩展只剩 `declare_done` 里的一次调用），派发与结算复用 `dispatchJudgeRound` / `settleAuditRound` | `lib/acceptance-round.ts`（判定表、任务文本、`RG_ACCEPTANCE_GATE` 渲染）、`agents/acceptance.md`（角色纪律）、`lib/repo-pr-policy.ts`（哪个任务验收） |

> **落点指引**：加一条新的**判定规则**（什么该拦、什么该放）→ 落在
> `lib/` 里对应的纯模块，并配一个 `test/*.test.ts`；只有「把判定接到某个
> 事件上」这一步才改扩展。规则写进工具体里等于没有单测。

---

## 三、职责域

### 域 1：关卡判定与 ship 拦截

`ship-detect.ts` 判断一条命令行里是否含 ship 操作，`shell-lex.ts` 是它的底座
（引号、续行、here-doc、命令替换——正则做不对这件事，所以有一个真正的词法
器）。`file-size-gate.ts` 是架构标准里唯一的机械规则（新建源码文件 600 行硬
拦、存量只提醒，判定点是 `judge_submit` 里那次 checkpoint 提交的一刻，不在 precommit runner
里）。`polish-gate.ts` 管「连续 READY 还在打磨」的再审理由，
`loop-stall.ts` 是 L2 的断路器，`git-rewrite.ts` 解开「只改 commit message」
与 L5 的互锁，`blocked-marker.ts` 在 sidecar 写不进去时 fail-closed，
`sensitive-grant.ts` 与 `arbitration.ts` 是两个**受限的放行口子**（一次性
敏感文件授权、独立 arbiter 裁决循环拦截）。`task-mode.ts` 定义模式强弱序
（normal < explore < loop < orchestrator）与升降级规则（Temp 目录只提示不强制；
非 git 目录仍禁 enforced 模式），`workspace-branch.ts` 是保护分支
（main/master/dev/develop）检测：会话开始提示、checkpoint 直接拒绝（2026-09-16 起不再弹确认框）。
`copilot-review.ts`（L7，PR 之后的 Copilot 审查闭环）与 `loop-goal.ts`（L8，
用户批准的退出契约）——两者的**判定**在这里，工具体分别在
`copilot-review-tools.ts` 与 `goal-tools.ts` / `goal-prereview-tools.ts`，
接线见 §2 的层表。`copilot-triage.ts` 是 L7 里用户那半边的**纯规则**：轮次阈
值（`rounds ≥ 4` 才问）、线程键（thread + 最后一条评论）、决策汇总与 sidecar
校验；工具体只负责把问题弹出去、把答案写回状态。

> **落点**：新的拦截规则 → 新建一个 `lib/<rule>.ts` 纯模块（facts in,
> decision out）+ 同名单测；只有接线改扩展。新的**放行**口子要格外小心：
> 现有两个（`sensitive-grant` / `arbitration`）都是 fail-closed 且带限额，
> 照这个形状写。

### 域 2：语言与文本守卫

`lang-detect.ts` 持有 L5 的规则本身——**一条规则**：任何非拉丁字母即拒；调用
方只是传不同的 `kind` 来决定措辞。**但它不是这条规则唯一的实现**：钩子层不能
import TypeScript，所以 `hooks/commit-msg`（内联的一段 node，判编辑器里写的
commit message）与 `scripts/scan-test-labels.cjs`（L6 的测试标签扫描）各自
带着一份自称 mirror 的同规则副本——而且**没有 parity 测试兜底**（不像
`fingerprint` 的两份实现有 `test/constants.test.ts` 比对摘要）。
`llm-classify.ts` 是语义第二意见
（DeepSeek V4 Flash），契约上 **TIGHTEN-ONLY**：只能加拦，永远不能解掉确定性
检查已经下的拦。`text-appeal.ts` 是启发式拦截的申诉口子，
`edit-projection.ts` 把 edit/write 的入参投影成改后全文，让标签检查看得到
上下文。

> **落点**：改英文判定 → 规则改 `lang-detect.ts`，然后**必须同步那两份镜像**
> （`hooks/commit-msg`、`scripts/scan-test-labels.cjs`）——只改 TypeScript 那份，
> 钩子层会静默停在旧规则，而且没有测试会告诉你。别在第四个地方再写一份；
> 加语义判定 → 走 `llm-classify.ts`，并保住 TIGHTEN-ONLY 不变量。

### 域 3：judge 会话与审查协议（2026-09-04 起：pane 模型；2026-09-25 起：window 模型）

judge（reviewer / quality-auditor / adviser / goal-auditor / acceptance）是**独立 window 里的交互 pi**，
归 opener 所有（项目经理 → 子会话 → review，plan review 由项目经理自开；跨级调用一律
fail-closed）：`session-factory.ts` 开 window（**全仓唯一入口**：开 → 登记 → 装饰 →
投递核实，与编排子会话同一条路径；隶属的专属 tmux session 由 `session-tmux-scope.ts` 懒建；
argv 全部复用 `orchestrator-tmux.ts`，颜色标题复用
`orchestrator-pane-decor.ts`），`judge-pane.ts` 只剩探活与 `RG_JUDGE_*` 契约常量，
`hierarchy.ts` 是 opener
注册表与唯一的跨级裁判（纯函数，条目带 opener 派发的轮次号 `roundSeq`）——它是
judge 的**唯一**注册表：扩展里那份内存 `childSessions` Map 已于 2026-09-05 删除
（同一组事实两处手工双写，正是 `judge_wait` 找不到 `judge_spawn` 刚开的 judge 的
根因）。合并后条目自带 `title` / `sessionDir` / `spawnedAt`，读点分两类：问「还在
跑吗」的走 `judgeLive`（缺信息判活，绝不误终结等待），问「我拥有什么」的走
`listByOpener`（联关要连死 pane 的条目一起回收）；按 pane id 关 pane 前另有
`windowClosable` / `paneIdUsable`（tmux server 重启后 id 会重排，缺信息一律不动手）。
`judge-side.ts` 是 pane 内门禁的 reporting
shell（heartbeat、对话框竞态，复用子会话通道原语，不另起通道；它**不写**主仓库
门禁状态——判定在 `session-exclusivity.ts` 的 `gateStateWriteSkip`，2026-09-05 判 judge，
2026-09-21 起同一入口一并判 worker），一轮的结束是 judge
自己调 `judge_conclude`（`judge-conclude.ts`，只在 judge 侧注册）：结构化结论**本体**
直写 channel report（2026-09-04 起不再合成 fence，opener 也不再解析），签名按角色收窄
（reviewer / quality-auditor / goal-auditor 没有 notes 参数），一轮只交一次，transcript 扒取路径已删；
`judge-process.ts` 只剩身份（opener + **lane** 限定的确定性会话 id：同 opener 同 lane 复用、
换 opener 或换 lane 全新；lane 后缀 `laneSuffix` 在这里渲染，会话 id 与工作目录共用它）与 scratch
目录 helper（进程派生已删；`judge-session.ts` 那套 pid + 进程启动时刻的判活已于 2026-09-06
按哲学三删除——它没有生产调用者，生产里 judge 判活只有 `judge-pane.ts` 的 pane 探活与
`exit-code` 文件两条），`judge-rotation.ts` 定复用的单元/释放点/上限并给出 lane（也答「本轮
judge 还记不记得上一轮」），`judge-pane-policy.ts` 定 pane 何时回收的两套政策，
`judge-lifecycle.ts` 剩下 opener + lane 限定的工作目录（含无人认领目录的 TTL/旧格式回收选择器，
新旧两种目录形状都认，所以轮转出的旧目录照旧被回收而不是永久堆积）、
超时钳制与审计裁决（派单/等待判据已随进程模型删除；**等待纪律 2026-09-05 搬到
`agent-directives.ts`**，因为项目经理侧要用同一份措辞、只换工具名），`judge-report.ts`
只剩 opener 侧标准报告（扒取半边已删），`judge-prompt.ts` 装配系统提示（角色定义 + 共同协议），
`child-watch.ts` 按 pane 存活 + 通道活跃度分类等待中的子会话；
`judge-session-tools.ts` 是作用在既有 pane judge 上的两个入口
（`judge_close` 只在 internalHost；`judge_wait` 同一实现同时注册到 internalHost 与 agent 面），

`judge-spawn-tools.ts` 是开/代答/恢复三个生命周期工具——注意这些工具族都不在
扩展里，见 §1.2。进程时代的派发与唤醒（`spawnJudgeProcess` / `decideJudgeDispatch` /
`evaluateJudgeWait` / `lib/judge-watch.ts` 整模块）已随 pane 迁移整体删除：
`judge_submit` 自己走 pane 派单、通道 report 即完成，它们是同一件事的旧路。


审查内容侧：`parallel-review.ts` 持有审查契约（一轮一个 reviewer，判不可变的
`baseline..HEAD`），`review-baseline.ts` 在链被 squash/rebase 后按内容找回基
线，`review-scope.ts` 决定增量多大就升级成整轮深审、以及**读者**这一侧的前置
（transcript 没续用的 judge 拿不到增量任务书）、`review-carryover.ts` 把那个
决定连同上轮裁决与未关闭 findings 渲染成任务书里的增量契约（该契约的**唯一**权威
出处，其余文档与提示词只引用不重述），`review-stream.ts` 让
findings 边审边流出，`review-adjudicate.ts` 在 judge 交上来的**结构化结论**上
做 reviewer 裁决（READY 携带未解决 P0/P1 → BLOCKED、findings 计数、跨轮
fingerprint；`precommit-parse.ts` 是另一件事，只认 `## Overall:`
sentinel），`adviser-brief.ts` 组装 adviser 的
brief，`session-dir.ts` 保证 transcript 指针的编码与 pi 逐字节一致。把这些
拼成一份**判官真正收到的任务文本**的，是两个 prepare 模块 —— 它们是**内部实现**，
不再注册成工具（哲学三），由 `judge_submit` 与 `propose_loop_goal` 在内部调用：
`review-prepare-tools.ts`（算范围、开流、登记 review target）与
`advisory-prepare-tools.ts`（adviser brief 与 goal 审计任务文本，不碰 git 范围）。


> **落点**：改「judge 怎么被启动/等待/唤醒」→ `judge-*.ts`；改「它被告知
> 什么、它交上来的结论怎么被裁决」→ `judge-prompt.ts` / `parallel-review.ts` /
> `judge-conclude.ts`（交卷签名）/ `review-adjudicate.ts`（裁决规则）；改角色的
> **行为定义** → `agents/<role>.md`，不是代码。

### 域 4：orchestrator 编排层

22 个模块，按「决策 / 通道 / 执行 / 工具」四层切开。2026-08-30 的通道重构删掉了
三个（`orchestrator-probe.ts` / `orchestrator-pane-read.ts` /
`orchestrator-keys.ts` —— 它们的全部工作就是让**终端**可读），新增了四个：

- **纯决策**：`orchestrator-gate.ts`（10 条硬约束；约束 5/7/10/14 已退役）、
  `out-of-repo-paths.ts`（**仓库外 + 敏感路径**的越界判定；2026-09-17 随文件边界一起
  从 `orchestrator-boundaries.ts` 里留下）、
  `orchestrator-plan.ts`（plan 是编排层的退出契约，批准绑定内容 hash）、
  `orchestrator-plan-progress.ts`（任务状态机、调度与退出判定）、
  `orchestrator-plan-approval.ts`（**这次改动扩权了吗**——删任务、加依赖、降并行度、
  写回此前已获授权内容（批准世系）都不重新惊动用户，扩权一律重批）、
  `orchestrator-plan-audit.ts`（plan 的前置审计：任务模板、裁决绑定 canonical
  文本、只 P0/P1 阻塞）、
  `orchestrator-pane-decor.ts`（子会话的颜色/标签/边框标题——纯展示层，只出不进）、
  `orchestrator-child-state.ts`（**子会话状态**：working / waiting-input /
  waiting-judge / idle / done / dead / stalled + mode-changed（模式切换事件，
  叫醒项目经理），判据全部是结构化真值——纯函数，
  用一串通道记录就能单测）、

  `orchestrator-wait.ts`（「有事发生」是什么，以及那份五块回执怎么装）、
  `orchestrator-registry.ts`（编排只能操作门禁替它创建的东西）、
  `session-inheritance.ts`（后继者继承什么：前任 pane / 交接文档 / 前任 transcript / **前任 session id**——最后一项是它接管 worktree 占用的继任凭据）、
  `session-handoff.ts` + `session-handoff-tools.ts`（唯一的交接阈值（70%）与唯一的 `session_handoff()` 工具，四类会话共用）、
  `orchestration-id.ts`（编排的稳定地址，接力换人后子会话无感）。
- **通道（两侧，IO 经注入的 seam）**：`channel-records.ts`（记录 schema）、
  `channel-io.ts`（IO seam、路径、追加、大 payload 溢出）、`channel-projection.ts`
  （按字节游标增量读取、净化、投影、心跳）、
  `orchestrator-child-channel.ts`（子会话侧：上报、两方竞态提问、读取与确认
  指令）、`orchestrator-supervisor.ts`（编排侧：读所有通道、判定、决定什么算
  新闻、渲染回执的前三块）。
- **与真实机器打交道**：`orchestrator-tmux.ts`（tmux 命令的唯一构造处，现在
  只剩建/关 session 与 window、开/关 pane、列 pane、列 session、pane/window 装饰
  —— 没有 `send-keys`，没有 `capture-pane`，也没有窗口几何与等分：三列布局的规划/探测/
  等分已于 2026-09-25 整块删除；开子会话的落点是专属 session 里的 window，整条路径住
  在 `session-factory.ts` + `session-tmux-scope.ts`，`assertSafeTmuxArgv` 那四个
  session 级子命令必须显式声明「这是我自己那个 session」且目标指向它 —— 声明由
  `session-tmux-scope.ts` 的 `addressableSessions` 构造，而**注册表里的名字只是候选**：
  候选的 `@rg_scope_owner` 标记必须证明它的名字正是由那个会话派生的
  （`createOwnershipProbe`，2026-09-25 t4 整体审核 P1；否则一份可写的注册表就能把
  声明放宽到别人的 session 上））、
  `orchestrator-wiring.ts`（跑 tmux、读写 plan、持有通道 IO 与
  监督记忆）、`orchestrator-delivery.ts`（投递并**校验真的送达**才报成功，证据
  是通道记录与子会话回执）、`user-notify.ts`（桌面通知：三种事件 + 节流 +
  `terminal-notifier` 的 argv 与点击回 pane —— 第三类「停下来等你回答」有两个入口：
  对话框弹出、以及 plan 决策登记）、`orchestrator-guard.ts`（tmux 权限门：
  未授权拦，授权走 `request_tmux_access`）。
- **工具与接线**：`orchestrator-tools.ts`（plan 工具注册）、`orchestrator-plan-action.ts`
  （plan 各 action 的实现）、`orchestrator-plan-messages.ts`（plan 批准框文案）、
  `orchestrator-session-tools.ts`（spawn / instruct / wait / close 的
  注册，并转注册下面两个模块，所以「有哪些编排工具」只有一个地方回答）、
  `orchestrator-wait-tool.ts`（wait 的实现与回执的退出阻碍 / 继承块）、
  `orchestrator-close-tool.ts`（close 的实现与 worktree 结算）、
  `orchestrator-answer-tools.ts`（answer，含约束 8 的仓库外敏感路径检查）、
  `orchestrator-answer-rules.ts`（答案解析与代批 crosscheck / 站点放宽拒绝）、
  `orchestrator-recovery-tools.ts`（recover / attach、孤儿检测）、
  `orchestrator-dispatch.ts`（spawn / instruct 的实现）、`orchestrator-tool-kit.ts`
  （每个工具的共用前置：模式、pane 实况、plan 可用性、子会话资产）、
  `orchestrator-deps.ts`（编排工具要的依赖集合，host 类型在 `tool-host.ts`）、
  `orchestrator-directives.ts`（项目经理拿全套契约，子会话只拿一句话）。


> **落点**：新的编排**规则** → `orchestrator-gate.ts` 或
> `orchestrator-plan.ts` / `orchestrator-plan-approval.ts`（能被单测点名的那种）；新的**能力**（读、按
> 键、投递之类的原子动作）→ 单独一个 `lib/orchestrator-<能力>.ts` + 在对应
> 的 `*-tools.ts` 里注册。tmux 命令**只**在 `orchestrator-tmux.ts` 里拼。

### 域 5：precommit 与 checkpoint

`precommit-receipt.ts` 是信任边界的纯校验（回执 + spawn 结果 ⇒ 真 PASS/FAIL
还是协议错误），`precommit-tail.ts` 实时 tail runner 的日志文件（runner 走文
件不走管道，管道会把它挂死），`progress-stream.ts` 给长耗时工具发实时进度，
`gate-timings.ts` 把每个门禁事件写成 `.pi/gate-timings.jsonl` 的一行。真正
**跑**检查的是 `scripts/precommit-runner.mjs`（见第四节）。

> **落点**：加/改一条 precommit 检查 → `scripts/precommit-runner.mjs` 与
> `scripts/precommit-plan.mjs`（纯规划逻辑，可单测），不在 `lib/`。

### 域 6：持久化与指纹

`gate-state.ts` 是状态机（`GateState`），sidecar（`.pi/review-gate-state.json`）的
读在 `gate-state-load.ts`、写与并发绑定合并在 `gate-state-io.ts`、未满足项计算在
`gate-state-requirements.ts`；`fingerprint.ts` 是「代码现在长什么样」的稳定
哈希（内容寻址、暂存无关），门禁的每个裁决都绑在它上面；`atomic-write.ts`
是所有状态文件共用的「写临时文件再 rename」；`repo-resolve.ts` 让裁决绑到
编辑真正发生的那个仓库；`project-config.ts` 解析 `.pi/review-gate.json`；
`git-memory.ts` 在上下文压缩后重新注入过滤过的 git 快照。

**谁有资格写这份 sidecar**（2026-09-05）：一个 worktree 同时只允许一个「占用主
sidecar」的会话，判定在 `session-exclusivity.ts`（心跳文件 `.pi/session-presence.json`），
第二个占用者 fail-closed 拒绝——拒绝理由挂在 `GateState.exclusivityRefusal` 上，
由 `unmetRequirements`（所有 ship 路径共用的那个权威）变成拦截，同时该会话
**不写**这份 sidecar（它属于占用者）。judge 会话与编排子会话不占用主 sidecar
（前者不写门禁状态、后者写自己的 `RG_STATE_VARIANT` 分片），因此天然豁免——
它们本来就与 opener 跑在同一个 worktree 里。被拒会话的写面**全部**堵住：
edit/write、ship、门禁自己的 checkpoint 提交（它会 `add -A`，不堵就会把占用者
未提交的工作一起提交掉）、以及 `.pi/loop-goal.md` 的写入（goal 批准绑 hash，
覆盖会让占用者已获批的 goal 失配）。唯一的例外是 `normal` 模式——那个模式的
定义就是门禁整体关闭（edit guard 与 ship gate 都在更早处短路），所以那里不发
拒绝；心跳则分情况——worktree 空闲时它照常写（让别人看见它），已被占用时它
**既不拒绝也不写**（凭据属于占用者）。占用者消失后由定时复检自动解除，不必重开会话。

> **落点**：新的状态字段 → `gate-state.ts`（并想清楚它是否该进指纹；读取校验补在
> `gate-state-load.ts`）；
> 新的项目级开关 → `project-config.ts`；**任何**状态文件写入都要走
> `atomic-write.ts`。注意：`lib/fingerprint.ts` 与
> `scripts/compute-fingerprint.cjs` 是同一算法的两份实现（钩子不能 import
> TypeScript），改一边必须同步另一边——`test/constants.test.ts` 会比对。

### 域 7：模型配置与诊断

`model-config.ts` 把 `review-gate.json` 的 `agents` 段（解析在 `agents-config.ts`）渲染成
`agents/*.md` 的 frontmatter（文件格式在 `agent-frontmatter.ts`，spec 与 registry 在
`model-spec.ts`；项目层盖全局层），**无内置默认**：安装脚本写入 4 角色的默认
slots，会话启动时 `agents-startup.ts` 的 `validateAgentsForStartup` 硬检查每个角色（缺失/slots 空/
spec 非法即停会话；任一层**声明了**的 `agents.worker*` 预设也逐 slot 检查，没有预设不算错），`judge-prompt.ts` 的 `modelChainFor` 对未配置角色返回
**空链**（派发 fail-closed）。`model-diagnose.ts`
回答「我的审查实际跑在哪个模型上」（`/gate-status` 只列六个 judge 角色 + 配置里的 worker 预设，
agent 目录里其他 .md 不算门禁角色），`gate-doctor.ts` 是 `/gate-doctor` 的只读
体检，`ui-widget.ts` 构造 editor 下方那条**单行**状态条（详情在 `/gate-status`）。

> **落点**：除 `model-config.ts` 会把配置渲染进 `agents/*.md` 之外，这一域
> 全是**诊断**：它们永远不产生门禁裁决。想让某个诊断「顺手拦一下」时，请把
> 它写成域 1 的一条规则，而不是让诊断带上拦截权。

### 域 8：用户交互与提示注入

`choice-dialog.ts` 是**门禁唯一的提问模板**（用户决定，2026-09-08；2026-09-19 加字母编号与两道退路；2026-09-22 加第二种形状）：2–4 个选项
（每个带 `A. ` 字母编号）+ 一个「（推荐）」标记 + 一行「✎ 不选，我说明原因」，选中该行弹多行理由编辑器、
原因随答案回传；多题采访从第 2 题起还多一行「← 返回上一题」（它只画给屏幕，通道请求的选项里没有它），
理由编辑器里按 ESC 退回选项列表、已输入文字保留 —— 选项列表的 ESC 仍然关框停整场采访。
`ask_user`、门禁自身每一处是/否框、两处手写 `ui.select` 全部渲染它，
`ui.confirm` 在门禁里不再有调用点。
**`multi-choice-dialog.ts` 是第二种形状：复选清单**（2026-09-22，用户决定；同样由门禁自己与 `ask_user` 共用，
字母编号 / ✎ 行 / ESC 与「← 返回上一题」全部沿用上面那一套）—— 形如 `[x] A. 预检（推荐）` / `[ ] B. …`，
空格勾选、回车确认（返回被勾选项的结构化列表）、一项都不勾回车也是合法答案（t5-stages 的「环节全关」）；
形状标记是 `ChoiceSpec.defaultChecked`（**存在即多选**，内容就是清单打开时勾好的那一组）。
跨两种题型的不变量只有一条：**直接回车 ＝ 接受提问方的推荐** —— 单选题靠必填的 `recommended`，
多选题靠必填的 `defaultChecked`（缺了整批拒绝，因为它就是那个推荐）。
**已知落点（2026-09-22，quality 轮记录）**：宿主画不出复选框时（RPC 的 `ui.custom` 不跑 factory），哨兵 `MULTI_UNAVAILABLE`
只在采访内部生效 —— 通道侧仍把这题结算成 `dismissed`，所以「这题没展示给任何人」与「用户关掉了框」在通道记录里分不出，
项目经理也没有第二次机会答它（编排子会话本身总是 TUI，所以这条路径很窄：RPC 宿主 + 多选 + PM 未来得及答）。
为什么不给通道加第三个 `by` 值，写在哨兵的定义处（`multi-choice-dialog.ts`）。
`ask-user.ts` 是采访模型（逐题推进、**提问数量无上限**、关框即停与「在聊天里回答」
的语义，以及 `resolveQuestion`：一题结算下来到底算什么 —— 竞速送达的答案一律作数，
只有沉默才按「是什么中止了采访」解释），
`user-interaction-tools.ts` 是它的执行侧（工具 `ask_user`：什么时候暂停循环、
每答一题就落盘、人与项目经理谁先答谁生效；2026-09-06 起**整批问题先一次性上送
通道再逐题弹框** —— 上级第一份回执就看得到全部题，用户那边仍一次只有一个框），
并且是这一族的唯一注册入口——
它自己转注册 `consent-request-tools.ts` 的两个同意工具
（`request_scope_limit` / `request_sensitive_edit`，见 §1.2）；
**没人作答时谁来答**（2026-09-19，用户决定）：每个框弹出满 30 分钟仍无人作答，
就由 `user-proxy.ts` 交给 `arbiter` 读本会话上下文代答；答案带「由 arbiter 代为决定 + 依据」
的标记落进 sidecar、在对话区可见，`declare_done` 的完成报告再由门禁机械列出这份清单。
全部十二个对话点都经过 `lib/gate-dialogs.ts` 的 `askDialog`（单选 `askChoice` / 多选 `askMultiChoice`
是它的两个一行转发），所以计时与竞态只接了
那一处，十二个落点一行未改（AGENTS.md 哲学一：不让 agent 记住多步流程）；
`agent-directives.ts` 是每轮注入的常驻指令块（「情况 → 工具」那张表），
`renderer-mode.ts` 管「这个会话是不是 fullscreen 渲染器」这个读数与对它的提醒（对话框行数预算已于 2026-09-16 删除：产生它的那个闪屏只发生在默认渲染器上，而用户每会话都用 fullscreen；模式来自宿主的 `TUI.mode`，不自己重算配置），
跨会话的唤醒**不在**这一域：一个编排子会话经它自己的**通道**上报（见域 4），
全局广播队列已删除；
`edit-discipline.ts` 管「edit/write 失败后改用 bash 写文件」这个习惯，两条通道
都用：`tool_result` 里追加 `EDIT_FAILURE_NUDGE` / `BASH_WRITE_NUDGE`，以及每轮
随系统提示注入的 `EDIT_DISCIPLINE_DIRECTIVE`（与 `agent-directives.ts` 同一条
通道）——**两者都不拦任何东西**，是这一域里最典型的提示级手段。

> **落点**：想让 agent 改掉某个行为习惯，先问这是不是**提示**能解决的——
> 是就改 `agent-directives.ts`，不是就写成域 1 的机械规则。系统级通知由**门禁自己**
> 在三类事件上发（`user-notify.ts`）；agent 已经不能发通知了（`orchestrator_notify`
> 已删除），任何会话都能广播的形态不要再回来。

### 域 9：通用基础设施

`constants.ts` 是全仓唯一的共享常量（代码/文档扩展名、敏感文件模式、ship 命
令种类、语言指令、轮次上限）——`test/constants.test.ts` 用结构性测试逼着每个
消费方 import 它而不是自己再写一份列表。`poll-wait.ts` 是通用等待骨架（探
测、发布、按判据或预算停），判据由调用方注入：judge 等待与编排等待共用它；
它还持有**第二个中断源** `notifyUserInput()` —— 扩展已有的 `pi.on("input")` 在
收到真实用户消息（`source !== "extension"`）时拉它，本进程里每一个阻塞中的
`pollUntil` 立刻返回 `aborted`，所以长阻塞的会话不会对人不可达（B5）。
`workflow-commands.ts` 定义工作流命令及其提示词，含 `--execute` 授权字的严格
解析。`tool-host.ts` 是每个 `lib/` 工具注册模块共用的 host 类型 seam。

> **落点**：任何「扩展名列表」「敏感路径」类的常量 → `constants.ts`，不要
> 在本地再声明一份（这是被明文记过的历史事故）。任何新的等待循环 →
> 复用 `poll-wait.ts` 并只写自己的判据。

---

## 四、`lib/` 之外的目录

| 目录 | 承担什么 | 什么时候往这里加东西 |
| --- | --- | --- |
| `hooks/` | L3 纵深防御：`pre-commit`（薄壳：环境清理 + 布局 fail-closed + 单次 exec `scripts/pre-commit-check.cjs`，全链校验在那边）、`pre-push`（同一套 + full lane 要求）、`commit-msg`（AI 署名 + L5 英文，覆盖编辑器里写的 message） | 新增一条**离开 pi 也必须成立**的检查；bash 写成，不能 import TypeScript |
| `scripts/` | 跑得起来的执行体：`precommit-runner.mjs`（确定性质量门）、`precommit-plan.mjs`（纯规划，可单测，含负载自适应并发）、`precommit-cache.mjs`（按输入摘要缓存每步）、`precommit-config.mjs`（读 `.pi/review-gate.json` 的 precommit 段）、`pre-commit-check.cjs`（2026-09-08：钩子全链单进程入口，进程内复用下面三个）、`compute-fingerprint.cjs`（钩子用的指纹，镜像 `lib/fingerprint.ts`）、`check-staged-divergence.cjs`（导出 `runMain` 供进程内复用）、`scan-test-labels.cjs`（L6，导出 `main(repo)`）、`install-git-hooks.sh`、`install-package.mjs` | **新增一条 precommit 检查**（改 runner + plan）；新增钩子要用的、不能依赖 TypeScript 的逻辑（CJS/MJS） |
| `agents/` | 六个角色定义：`reviewer`、`quality-auditor`、`adviser`、`goal-auditor`、`arbiter`、`acceptance`。frontmatter 是模型链、thinking、工具集的**单一事实源** | **新增或调整一个 judge 角色**：先改这里的 md，模型链由 `lib/model-config.ts` 渲染/校验 |
| `skills/` | 随包分发给 pi 的技能（`package.json` 的 `files` 含 `skills/`，pi 直接从包里加载，因此写在这里就等于全局可用——**不要**再往 `~/.pi/agent/skills/` 手抄副本，那会漂移）。只有一条：`skills/review-loop` 描述审查循环怎么跑 | **收录判据（2026-09-05 用户定，删掉三条不合格的之后立的界）**：skill 只写**环境事实**——这个仓库需要哪些必备依赖、怎么把它跑起来、基本现状与结构约定，也就是**门禁不会注入、而新来的人不知道就会踩坑**的东西。不进 skill 的三类：① 门禁自己的规则与流程（它每轮都自己注入，写成 skill 是重复，且会随门禁改动安静过期）；② 为门禁缺陷发明的绕行办法（那是待办清单上的一条缺陷，不是知识——缺陷修好后没人回来删它，它就从避坑指南变成误导）；③ 只对某一轮成立的排查过程 |

---

## 五、`lib/` 全量速查表（245 个模块）

**维护指令（现在有机械约束了）**：在 `lib/` 下**新增或删除**一个模块时，
**同一轮改动里**顺手加/删这里的一行。忘了会红——`test/module-map.test.ts`
对这张表和 `lib/` 目录做**双向差集**（表里有目录没 = 幽灵行；目录有表里没 =
漏登），并核对标题里的条目数。

这条约束是补上的（2026-09-05）：在此之前它只是一句人肉指令，于是这张表只会
**单向漂移**——「新增模块顺手加一行」人人做得到（你正在写那个模块），而删模块
时你在别的文件里干活，这张表根本不在眼前。判据本来就写在这里
（`ls lib/*.ts | wc -l` 与本表一一对应），只是从来没有人把它变成一条测试。

| 模块 | 一句话职责 |
| --- | --- |
| `abort-race.ts` | **「一个 promise 对一次 abort 的赛跑」的唯一实现**（2026-09-18，quality 轮 P2：同一段十五行在一轮里长出了两份）：监听 `abort`（`{once:true}`）、`settled` 守卫保证只结算一次、非 abort 路径摘掉监听、rejection 折进同一个答案。两个调用方：对话框队列（取消 = `true`，跳过这个框）与 reason box 的回退路径（取消 = `undefined`，连框都不开 —— 后者自己先查 `aborted` 再开框）。**本模块里仍然没有超时**（`AbortSignal.timeout` 是标准做法）；但**门禁从 2026-09-19 起确实给对话框加了超时** —— 30 分钟无人作答后交给 `user-proxy.ts`，那个窗口只住在那一个模块里 |
| `acceptance-round.ts` | **真实验收轮（第 6 个 judge）的判定半边**（2026-09-22 用户决定）—— 这一轮由**门禁在 `declare_done` 里自己派发**，agent 没有工具能起点它。`acceptanceDecision` 是纯判定表（gate 被环境标记关闭 / goal 声明「本轮无真实验收（理由）」/ 本轮无代码 / **工作区指纹取不到**（⇒ block，不派：结论无法绑定，而这类仓库重派会没有出口 —— 2026-09-22）/ 本轮没有一份**用户批准的**验收方案（`hasPlan: false`；goal 环节关闭或 goal 未批准 ⇒ 草稿不算合同，也不会被当成计划）⇒ skip；无记录或 ARMED ⇒ dispatch；AWAITING ⇒ wait（pane 没了 ⇒ 重新派）；READY 绑当前工作区指纹 ⇒ pass，指纹一变 ⇒ dispatch；BLOCKED 且绑当前指纹 ⇒ block）；**逐 repo 判定**（2026-09-22：`armAcceptanceRound` 走 `sessionRepos`，每个 repo 用自己的 `stateForRepo(root)` —— 只看主 repo 的 `hasCodeChange` 曾把一个只改了次要 repo 的会话记成假的「本轮没有代码改动」）；`acceptanceProblems` 是完成条件层的投影（**绝不进 `unmetRequirements`** —— 修验收 finding 要 commit，而 commit 又被验收拦住，那是自我死锁）；`buildAcceptanceTask` 把 goal 的「真实验收方案」段与 `baseline..HEAD` 当不可信数据交给它；`acceptanceGateValue` **消费** `repo-pr-policy.ts` 的 `acceptanceTaskId` 决定哪个编排子会话的验收 gate 开着（`RG_ACCEPTANCE_GATE` 环境变量，dispatcher / recover / handoff 三条链注入，`acceptanceGateOpen` 缺省为开）；`parseNoAcceptanceDeclaration` / `extractAcceptancePlan` 是 goal 文本的两个解析器（**无理由的声明不算豁免**，而批准框会把那句显眼展示给用户拍板）。派发与结算复用既有引擎（`dispatchJudgeRound` / `settleAuditRound`），本模块没有 pane、时钟与 IO |
| `adviser-brief.ts` | 组装 adviser 咨询的 brief：主会话 transcript 指针 + 结论落盘路径，第二次起带上轮结论与其后改动 |
| `advisory-prepare-tools.ts` | **内部实现**（不注册给 pi）：组装 adviser brief 与 goal 审计任务文本，由 `judge_submit` / `propose_loop_goal` 调用 |
| `agent-directives.ts` | 门禁对主会话的常驻指令块，每轮注入的「情况 → 工具」表；**等待纪律的唯一出处**（`buildWaitDiscipline`：子会话侧 `judge_wait`、项目经理侧 `orchestrator_wait` 共用同三条，只换工具名与消息种类） |

| `arbitration.ts` | 仲裁：由独立 arbiter 裁决「循环无解」的门禁拦截，fail-closed 且有次数上限；模型走 `agents.arbiter.slots[0]`（配置层），不再硬编码 |
| `arbitration-host.ts` | 仲裁的 **I/O 一侧**（t5 从扩展拆出）：token 绑定（`computeTokenBindings` / `bodyFileDigest`）、arbiter 模型解析、文案申诉与零检查申诉的听证、给 arbiter 的证据收集（`gatherPrText` 等），以及两份门禁自有的审计日志（`appendAuditLog` 落 repo 根 `.pi/`、`appendLesson`）。规则仍在 `arbitration.ts` / `text-appeal.ts` / `inspection-appeal.ts` |
| `ask-user.ts` | `ask_user` 的采访模型：**提问数量无上限**（2026-09-17 起事实如此 —— 旧口径是「尺寸类问题只截断」，而那个 10 问截断会丢掉一批问题的尾巴，agent 被告诉「下一轮再问」后往往不再问、直接改猜）、逐题推进、关框即停与「在聊天里回答」的语义；问题的**形状**（2–4 选项 + 字母编号 + 推荐 + 追加行）不在这里，在 `choice-dialog.ts`。`validateQuestions` 是整批合规判定（缺选项或缺推荐 ⇒ 整批拒绝且不弹框，过长的题/选项只截断并告知）；`resolveQuestion` 是「一题结算算什么」的唯一判定（竞速送达的答案永远作数，只有沉默才解释：**用户关框 ⇒ `stop: true` 停整场**、被 instruct 打断 ⇒ unanswered，两者不可混同，后者由通道自己结算整批）。`stepInterview`（2026-09-19）是**往回退**的纯状态机：`← 返回上一题` 退一格且退不过第 1 题、锚点题作答 ⇒ `answerCurrent`、退回后作答 ⇒ `revise`（只覆盖那一题，被跳过的题保留原答案）、关框 ⇒ 停整场；`AskAnswer.answer` 记屏幕上的写法 `A. 文本`，`option` 留选项原文供门禁自己做比较（授权只认推荐项的原文）。**多选题（2026-09-22）**：`multiple` 必须显式带 `defaultChecked`（缺了整批拒绝；`[]` = 推荐一项都不勾），它不需要 `recommended`（给了就照样标（推荐））、不允许 `grantScope`（授权必须唯一）；答案记成 `A. 预检 / C. precommit`（选项顺序）加结构化的 `AskAnswer.options`，空勾选记成 `MULTI_NONE_ANSWER`（是答案，不是沉默），`questionRows` 是「这道题在文本里长什么样」的唯一出处（多选 ⇒ 勾选框形态），采访、transcript 与 headless 通知共用 |
| `async-precommit-report.ts` | 后台 full precommit 落地时那条通知的**措辞 + 是否还算数**（2026-09-12；PASS 侧 2026-09-16）：`buildAsyncPrecommitReport` 输出带轮次与内容指纹的失败文本，`asyncPrecommitReportIsStale` 是唯一判据（lane 启动时那份 tree ≠ 投递时的 worktree tree ⇒ 降级成「旧轮次」文案，**不静默丢弃**；两侧指纹任一侧读不出就不降级——未知永不等于相同，fail-closed）；`buildAsyncPrecommitPass` 是 PASS 的短文案（「已经落地，不用再等它」）—— 在它之前 PASS 一声不响，而 `judge_wait` 的事件源里没有 precommit 落地，实测让一个会话在等一个永远不会来的事件上坐等 6 分 47 秒。为什么必须有它：`judge_submit` 的 lane 是并行的，FAIL 只能事后告知，而原先把这条通知挂在 `followUp` 上（pi 只在 agent 不再有工具调用时才 drain）与「门禁未过不许停循环」的存活不变量互斥，实测延迟 2 小时以上才投递，落地时裁决早已被后续 PASS 取代。扩展只接线：采集「本轮 + 验证的是哪份内容」两个事实，然后 `pi.sendMessage(..., { deliverAs: "steer" })` |
| `atomic-write.ts` | 写临时文件再 rename 的原子替换，门禁所有状态文件共用 |
| `audit-round.ts` | **审计回合引擎**（2026-09-05；本文件只留同步回合 `runAuditRound`，结论段与判据分别在 `audit-round-settle.ts` / `audit-round-report.ts`）：「派发 judge → 等本轮 → 选 report → 裁决 → 记录 → 回收」的唯一一份实现。`settleAuditRound` 是结论段（goal / plan / review / advice 四种 kind 都经它，`judge_wait` 与 settle 扫描共用，游标只在这里推进一次、且只在记录落地后推）；`runAuditRound` 是 goal/plan 的同步回合（O-6 的 `judge_close` 是它的一个 `finally`，不再散在每条 return 上；「本轮是不是已被 wait 记完」由 `roundClosedDuringWait` 判——pending 必须已消费，再问 `recordedThisRound`（记录侧的证据：一份绑定本轮内容、时间戳 ≥ 本轮 `startedAt` 的裁决，**不看 verdict**，FAIL 同样结束本轮），登记行还活着时游标已前进也算；全不成立才自己再 settle 并 fail-closed。问记录而不是只问游标，是因为一轮结束就回收 pane（2026-09-21）会连登记行一起删掉，游标那半证据被回收动作自己销毁了）。`selectRoundReport` 是「哪份 report 收本轮」的唯一判据（round-bound 认 `roundSeq`+游标；cursor-only 只认游标；**round-and-content 认 `roundSeq`+`checkpoint.at`+游标，review 专用**，没有 checkpoint 记录（于是没有可比的 `checkpoint.at`）的轮次则只由 round+游标兜底，否则那种轮次不可收敛——与它的范围空不空无关（2026-09-15 起 `prepare_review` 在无 checkpoint 记录时取分支基点，所以那轮可能是 `HEAD..HEAD`，也可能是基点..HEAD 的真实交付）——per-kind 的真实差异），`roundBindingFor` 是三件事实的唯一推导处；共用它的入口有三个：记录侧 `settleAuditRound`、探测侧 `probeJudgeRound`（`judge_wait` 与 settle 扫描）、以及只要 yes/no 的 `roundHasReported`（子会话心跳据它把状态报成 `waiting-judge`、loop 停滞断路器据它判「还在动」，它替掉了扩展里那份「report 晚于 pane spawn」的旧比较） |
| `audit-round-host.ts` | 审计回合引擎的**会话侧依赖**（t7 从扩展拆出）：`auditRoundDeps`（结论段：读通道并顺带记下 judge 自报的上下文读数、推游标、三个记录器、回合结束回收 pane）与 `auditRunDeps`（同步段：派发、门禁自己的等待、O-6 关闭、按内容绑定的「过没过」），外加 goal-auditor 的任务书 `buildGoalAuditRound` 与唯一的「关掉本会话开的 judge」`closeOwnedJudge`；判定全在 `audit-round*.ts` |
| `acceptance-host.ts` | L9 **验收轮的会话侧**（t7 从扩展拆出）：`armAcceptanceRound`（`declare_done` 调，逐 repo 聚合成一份拒绝）、`acceptanceStepForRepo`（单 repo 的判定、SKIP 记录与派发）、`dispatchAcceptanceRound`（写 AWAITING 记录）、`acceptanceGoalText`（只读**已批准**的 goal 原文）；判定表在 `acceptance-round.ts` |
| `audit-round-settle.ts` | 审计回合引擎的**结论段** `settleAuditRound`（选 report → 裁决 → 记录 → 只推一次游标 → 回收 pane）与它自建的 plan 记录；从 `audit-round.ts` 拆出，因为 code review 只从这一段进入引擎 |
| `audit-round-report.ts` | 「哪份 report 收本轮」的**唯一判据** `selectRoundReport`、三件事实的推导 `roundBindingFor`、只要 yes/no 的 `roundHasReported` 与未命中文案 `describeRoundMiss`；记录侧（`audit-round-settle.ts`）与探测侧（`judge-wait-criteria.ts`）共用它 |
| `audit-round-specs.ts` | 审计回合的**措辞半边**：五种 kind 的 spec（goal / plan / review / quality / advice）——judge 角色、report 绑定方式、pane 标题前缀、fail-closed 与拒绝文案 + `specForRound`（role 优先，goal/plan 靠 pending kind 分辨）。**引擎合，措辞不合** —— 合并机械部分是引擎的目的，合并句子则是另一种更糟的重构：plan 审计失败要让人去 `submit`，goal 的要去 `propose_loop_goal`。新增一种 round 只动这个文件 |
| `background-wait.ts` | **「有没有未返回的后台 subagent」的唯一判据**（2026-09-09，事件进、按 agent id 的待完成集合出）：开始 = 工具结果含 pi-subagents 的启动措辞（`started in background … Agent ID: <id>`）、非错误、且该调用是后台的（`run_in_background` 非显式 `false`）；结束 = **该 agent 自己的终态信号**，三个来源（2026-09-17 补了第二个）：① **pi 事件总线的 `subagents:completed` / `subagents:failed`**（每一次跑完都发，是唯一不会漏的）、② `subagent-notification` 消息的 `details.id`/`others[]`（pi-subagents 在结果已被消费时会**跳过**它，实测三个 agent 只到一条）、③ `get_subagent_result` 的**状态行**落在终态集 `completed`/`steered`/`aborted`/`stopped`/`error`（状态行锚定而非全文排除 running，正文可能引用任意字样）——**无超时、无「新一轮清空」兜底**（没终态信号就一直算在等，宁可多报 working）。子会话据此在等后台 agent 期间也报 `working`，不再被报成「停下了」；但**已记录的 `declare_done` 优先于这个等待**（2026-09-17），否则一个永远到不了的残留等待会把已完成的子会话永久盖成 `working` |
| `blocked-marker.ts` | sidecar 写失败时落 `.blocked` 标记，`hooks/pre-commit` 据此拒绝提交。判的是**磁盘记录的所有权**（不是进程），一切未知 fail-**closed**（时间戳读不出/在未来/写删失败一律保留 marker），回收窗 4 小时（`CONCURRENT_SESSION_WINDOW_MS`，唯一用途就在这里）。**它与 `session-exclusivity.ts`、`judge-pane.ts` 的判活为什么不可收敛成一条口径**：两处文件头各写一半，行为并排钉在 `test/liveness-criteria.test.ts`（2026-09-06 复核；同日按哲学三删掉的 `judge-session.ts` 才是真正的重复实现——它没有生产调用者） |
| `change-baseline.ts` | 本次改动的**比较基线**（2026-09-15，dashboard 实测的死锁）：一律 `HEAD`，但仓库处于 merge（`.git/MERGE_HEAD` 存在）时把被合并的 parent 一并算作基线 —— 「不在 HEAD 里」与「是本会话新建的」只在 HEAD 是唯一 parent 时才是同一句话；实测 104 个 staged 新增**全部**来自 `main`，file-size 因此硬拦 checkpoint，而 checkpoint 是 review 的唯一入口（用户只能切 normal 绕过）。`changeBaseRefsFromMergeHeads`（纯，垃圾行不进 argv）/ `readChangeBaseRefs` / `firstBaseContaining` / `isNewInWorktree` |
| `checkpoint-message.ts` | checkpoint 提交信息（纯函数）：把 agent 的 round note 变成合法 Conventional Commits（已是 CC 则原样保留，否则兜底 `chore: <subject>`），并对非英文 round note 回落英文默认、丢正文（L5 自洽）。**自 2026-09-16 起提交信息就是普通提交：门禁不再往里注入任何标记**（用户决定，理由与旧写法写在模块头注释里） |
| `checkpoint-sweep.ts` | **checkpoint 到底提交哪些未跟踪文件**（2026-09-20，演练 F3 实测）：门禁自己的 checkpoint 原本是裸 `git add -A`（还带 `REVIEW_GATE_BYPASS=1`），把「未被 gitignore 且本会话从未用 edit/write 写过」的东西一并提交进仓库 —— 实测：隔离 checkout 的 `node_modules` 软链以 `+1/−0 node_modules` 进了历史，reviewer 是从自己的 change index 里认出来的。纯函数 `planCheckpointSweep` 只做一件事：把 `git ls-files --others --exclude-standard -z` 给出的未跟踪路径（**raw 形式**，不是 `status` 那个带引号转义的）按「本会话写过（`GateState.sessionEditedFiles`，**精确匹配**，不做 glob）」切成 `own` / `leftOut` —— own 进提交，leftOut 原样留在 worktree 并在收条与 `judge_submit` 回执里点名。tracked 改动不参与这个判断（`M`/`D`/`R` 就是本轮工作，仍由 `add -A` 扫入） |
| `choice-dialog.ts` | **门禁唯一的提问模板**（2026-09-08）：2–4 个选项 + 一个（推荐）+ 追加行「✎ 不选，我说明原因」的构造（`choiceRows`）、校验（`validateChoice`）、解析（`parseChoice`）与渲染（`renderChoice`，注入 `ui.select`/`ui.editor`，选中追加行才弹多行理由框）。**没有任何 caller-owned 追加行**（`extraRows` 随 2026-09-17 那次删除一起消失；**2026-09-19 的 `← 返回上一题` 是模板自己的行**，由 `renderChoice` 的 `back` 开关画在最后一行、只画给屏幕 —— 通道请求的 rows 永远是 `choiceRows`，不含导航行）。**2026-09-19：字母编号与两道退路** —— `optionLetter`/`optionRow` 给每个选项行加 `A. ` 前缀（导航行不编号），`optionLabel` 是记录里的写法（`→ A. 文本`）；`parseChoice` 把 `A`/`a`/`A.`/`A. 文本`/选项原文/1 起序号都归一到**选项原文**（原文先行：一个文本恰好是 `A` 的选项不该被位置读法抢走）；理由框里按 ESC 回来的是 `lib/reason-editor.ts` 的 `REASON_EDITOR_BACK` 哨兵（打字内容跟在哨兵后，重开框时作 prefill），而 `undefined` 仍是「关掉这题」。`ask_user`、门禁每一处是/否框、两处手写 select 全走它；`ui.confirm` 已无调用点。**一次只弹一个框**（2026-09-18）：`createDialogQueue` 是那个串行队列——pi 并行执行同一批工具、宿主只有一个对话框槽位，并发的第二个框会顶掉第一个且它的 Promise 永不 settle，实测 rebate 会话 `01a0b328` 整轮卡死、ESC 也无效；`dialogSignal` 把宿主 `ExtensionContext.signal`（ESC 中止的就是它）与调用方自己的 signal 合并成框要监听的那一个；`dialogNotifyDetail` 决定这条对话框的通知正文（框标题 + 问题本身，不再只是「问题 1 / 4」）。**排队中的框可被取消**：等待期间 signal abort ⇒ 立即返回、不等前面的框关闭（否则通道侧已答完的请求会挂在前一个框上），且取消者把自己的队位交还给它在等的那个框 —— 取消者若直接放行，后来的框会跳过那个框、在它上面再开一个 |
| `multi-choice-dialog.ts` | **第二种对话框形状：复选清单**（2026-09-22，用户决定）—— 与 `choice-dialog.ts` 共用同一套词汇（字母编号、`DECLINE_ROW`、推荐标记、位置读法 `parseChoice`），但自己持有行渲染（`multiChoiceRow(s)`：`[x] A. 文本（推荐）`）、纯状态机（`multiChoiceStart` / `multiChoiceKey`：空格勾选、↑↓ 与 j/k 移动并环绕、回车提交、ESC 关闭、导航行不可勾选）、解析（`parseMultiChoice`：`""` = 一项都不勾、`" / "` 连接的多项、✎ 行含原因、读不懂的段 ⇒ `unreadable` 而**不是**猜勾选）与 TUI 组件（`buildMultiChoiceBox`，自己渲染行、不依赖 pi 组件类，宽度按终端 cell 算）。`renderMultiChoice` 是那条与 `renderChoice` 同形的异步路径（defer 到 ✎ 行时走同一个 `declineReason`）。**形状标记是 `ChoiceSpec.defaultChecked`（存在即多选）**；不变量：直接回车 = 提交打开时勾好的那一组 |
| `child-watch.ts` | judge 子进程存活仲裁：主会话不依赖子进程「守规矩」地发完成信号 |
| `constants.ts` | 全仓唯一的共享常量：代码/文档扩展名、敏感文件模式、ship 命令种类、语言指令、轮次上限 |
| `consent-request-tools.ts` | 工具 `request_scope_limit` / `request_sensitive_edit`：两个「请用户放宽门禁」的同意口子，对话与门禁状态经注入的 deps；由 `user-interaction-tools.ts` 转注册 |
| `copilot-gh.ts` | L7 的 gh 访问层：`gh` 以 argv 异步 spawn（超时 + abort），PR / 线程 payload / 轻量探针（head + reviewRequests + 最近 review）/ 时间线事件 / 可用性探测都在这里 |
| `copilot-review-tools.ts` | 工具 `copilot_review`：L7 状态机的唯一驱动端（该请求就请求、该报排队状态就报、该报 findings 就报），gh 访问经注入的 seam；文件里只留 deps、工具体、阻塞等待外层循环与注册 |
| `copilot-request-phase.ts` | `copilot_review` 的请求半段 `doRequestPhase`：发请求 → 确认排队 → 没排上重发一次 → 仍没落地才释放 |
| `copilot-queue-probe.ts` | `copilot_review` 的排队探针：`confirmQueued`（`COPILOT_CONFIRM_*` 窗口）、`diagnoseWaitRequest`（排队 / 在审 / 审崩 / 没落地的证据收集）与 `actOnBreakage`（每个周期一次的重发） |
| `copilot-review-replies.ts` | `copilot_review` 说的话：第 4 轮起逐条问用户的 `askFindings`、按裁决分组的 `triageText`、已释放周期的回复与 `releaseReply`（唯一的释放漏斗，附带「放弃了 N 条 findings」的告知义务） |
| `copilot-watch.ts` | L7 等待的全部策略：一条排队证据的判定（`decideCopilotWait`：排队 / 正在审 / 审崩了 / 从没落地 / 读不到，含陈旧事件剔除）、轮询节奏（20–45s）、一次 tick 的判定（落地 / 未排队 / 超时 / 已结束）、`copilot_review` 的阻塞等待 `awaitCopilotNews`（基于 `poll-wait.ts`，ESC / 用户输入可打断） |
| `copilot-review.ts` | L7：PR 之后的 Copilot 审查闭环总述 + **判定**：`analyzeCopilot`（这一轮 Copilot 做了什么）与 `evaluateCopilot`（据此推进状态机） |
| `copilot-review-state.ts` | L7 的状态机本体：状态、持久化形状、`arm` / `record` / `release` 三个转移、`copilotProblems`、sidecar 校验 `sanitizeCopilotState`；`CopilotReviewState.triage` 带用户自己的裁决，每个转移都带着它走 |
| `copilot-probe-parse.ts` | L7 的 gh 输出纯解析：各 GraphQL query 常量、`parseCopilotProbe` / `parseCopilotTimeline` / `parseCopilotPayload` / `parsePrView` / `decidePrView`、可用性判定 `decideCopilotSupport`、`isCopilotAuthor`；认不出的形状一律是「没数据」，不抛不猜 |
| `copilot-triage.ts` | L7 用户那半边的纯规则：轮次阈值（`COPILOT_TRIAGE_ASK_FROM_ROUND = 4` 起每条问题先问用户）、线程键（thread id + 最后一条评论 id）、「哪些还没表态」、四组裁决汇总、`triage` 块的 sanitize；无 IO/无时钟 |
| `delivery-station.ts` | 交付站点（`precommit` / `commit` / `pr`）：类型、解析与缺省（缺失或非法一律读成 `precommit`）、严格度排序、「某站点放行哪些 `ShipCommandKind`」的纯判定与超站拦截文案（`stationShipProblem` / `STATION_SHIP_NEXT_STEPS`，只给用户能走的两条路、不给申诉假出路），以及 `declare_done` 的「到站」判定（`stationArrivalProblems`：`commit` 要工作区干净，`pr` 要三条证据之一 —— 门禁**亲眼看到**成功的 `gh pr create`（`GateState.shippedKinds`）、Copilot 周期已解析出的 PR 号，或**门禁自己查到的、当前分支上开着的 PR**（`lib/station-pr-evidence.ts`）—— **且本地 HEAD 已在它的 upstream 上**（`prEvidencePresent` / `prArrivalProven` 是唯一的两条谓词，扩展也调前者决定要不要发网络查询；「挂着旧 PR、本轮提交还在本地」——包括门禁自己在 PR 开着之后落的 checkpoint——一律判未到站）；无 fs、无时钟，goal 侧、plan 侧与 ship 门禁共用同一份枚举 |
| `reason-editor.ts` | **门禁唯一的理由框**（2026-09-17，用户要求「和 pi 本身的输入框一致」）：`hostReasonEditor` 把 pi 自己的 `ExtensionEditorComponent`（多行、可粘贴、`ctrl+g` 进 $EDITOR）**连 abort 一起**装好 —— 不用 `ui.editor()` 是因为那个签名不收 `signal`，而这个门禁的对话框模型建立在「另一方先答就把框撤下」上（先答者生效、instruct 打断），一个活过自己答案的框会收下没人会读的输入。**两种 `undefined` 必须分开**：RPC 模式的 `ui.custom()` 不调 factory 就返回 `undefined`，把它读成「用户关框」会误停整场采访（`ask-user.ts` 的 `resolveQuestion`），所以判据是**factory 跑没跑**（跑了 ⇒ 是人关的；没跑 ⇒ 这个宿主根本渲染不了自定义组件 ⇒ 回退到 `ui.editor()`）。纯逻辑：组件经 `build` 注入，宿主两个调用经 `custom`/`fallback` 注入。pi 包的 `import()` 只在 `extensions/review-gate.ts` 一处，而且**按需**（`loadEditorComponent` 缓存结果、失败即降级）—— 模块作用域的静态值导入会让「在 pi 之外加载这个文件的宿主」（安装夹具、检查工具）在**加载期**就炸，整个扩展起不来只为了画一个框；拿不到组件类时直接回退到宿主自己的 `ui.editor`（多行、无 signal）。**回退路径的唯一补丁**是 `hostEditorFallback` + `raceReasonEditor`（2026-09-18，reviewer P1 两条）：适配器只把标题交给 pi 的 `ui.editor`（我们的 `opts` 进 prefill 位会让框里出现 `[object Object]`），自己读 signal；框撤不下来（那个签名不收 signal），但门禁**不能一直等它** —— abort 一到就结束等待；而且框由 **thunk 打开**，已 abort 的信号连框都不开（第一版收 promise，等于先开后弃，在屏幕上留下一个没人读的框）。`hostReasonEditor` 把自己的 `opts` 一并交给 fallback —— RPC 路径（custom 在、factory 不跑）以前只传标题，fallback 拿不到 signal，等于没修（reviewer P1 第二条）；custom 路径在进门前也查 `aborted`（否则先挂载组件再收尾，屏幕上会闪一个没人等的框，reviewer P1 第三条）|
| `rejection-copy.ts` | **拒绝文案的唯一渲染器**（2026-09-16，用户决定）：门禁对 agent 说的每一句「不行」都渲成同一形状 —— `review-gate: <现象>` / `原因：<事实>` / `下一步：<你 / 用户 / 门禁> —— <动作>`。四个字段全是必填的（`RejectionParts` / `RejectionActor`），漏一个编译不过 —— 形状由代码保证，不靠作者记得 `docs/coding-standards.md` §7。本轮接入六条高频路径（`ask_user` 批次不合规、`judge_submit` 送审被拒、goal/plan 打回、`declare_done` 被拒、edit/write 被拦、ship 命令被拦），其余随日后改动收敛；**不是框架**：没有严重度、没有错误码、没有注册表 |
| `renderer-mode.ts` | 这个会话跑在哪个渲染器上 —— 以及不在 `fullscreen` 时对它说一次什么（2026-09-16，用户决定）。它就是原来那套对话框行数预算的**替身**：那个预算存在的理由是 **默认（regular）渲染器**下、对话框高到把 spinner 挤出视口时 pi-tui 每帧清屏并擦掉滚回缓冲（实测 40 行终端：39 行 ⇒ 0/30，40 行 ⇒ 29/30）；而拥有整屏、自己滚动的 `fullscreen` 渲染器永远走不到那个分支，用户也每会话都用它。预算的代价落在「用户正在确认的那些行」上（长路径可以带走站点行与审计预审行），所以删掉预算，改为**提醒**。模式只能来自宿主的 `TUI.mode`（经 `setWidget` 的 factory 形式拿到）——自己按 argv + settings 重算就是一份会算错边角的拷贝（项目未 trusted 时 `.pi/settings.json` 整个被忽略、`/settings` 能在会话中途改模式）。纯判定 `rendererModeNoticeDue` + 文案 `RENDERER_MODE_NOTICE` |
| `edit-discipline.ts` | 识别绕过 edit/write 的 bash 写文件命令，只提示不拦截 |
| `test-run-discipline.ts` | 识别全量测试/typecheck 命令（无参 `npm test` / `tsc --noEmit` / `node --test` 全树），追加「送审时门禁自动 full precommit」提醒；纯判定 + 文案，judge 豁免在接线处 |
| `thinking-loop-guard.ts` | 思考空转（pure-thinking spinning）的**判定**：按 thinking/text/toolcall 三类增量折叠当前 assistant 消息，三条件齐备才判空转（零文本零工具调用 + thinking 过门槛 + 尾部 800 字符窗口里出现一整段**连续重复**：至少 2 个不同的 24 字符 n-gram 各重复 ≥12 次、且连续重复区 ≥300 字符）。24 字符与「连续区」两个判据都是实测逼出来的：8 字符 n-gram 会把模板式的正常思考（「步：检查 」每项重复一次）判成循环，而仅看重复次数又挡不住「一条长分隔线」。另导出 `truncateThinkingForDisplay`（显示截断，**字符与行数双上限**，无换行的循环样本也压得住）。纯逻辑、无 I/O，来源 deepseek-ai/deepseek-harness#5976 |
| `thinking-loop-controller.ts` | 空转熔断的**状态机与动作**：命中后注入「停止空转、立即行动」、`abort()`、通知用户；同一会话连续自动续跑有上限（超过只中止与通知），有产出的回合重置计数。显示截断**不属会话状态**——transformer 只拿得到 markdown 与 messageType、拿不到消息身份，所以截断由内容自己判定（`isThinkingLoopContent` + 字符串缓存）；会话级标志会两头错：截断期间误截所有 thinking，下一轮又把被熔断的那条放回来（reviewer P1，第 1 轮）。副作用（abort / notify / inject）全部注入，所以事件序列可单测；扩展只接线 |
| `edit-projection.ts` | 从 edit/write 入参投影出改后完整文件内容，供标签检查看到上下文 |
| `edit-time-checks.ts` | L6 测试标签语言检查的**编辑期**一侧（t5 从扩展拆出）：投影改后全文（`editedTestContent`）、同一个 lexer 先判确定性违规再走语义层（按标签集 memo）、状态栏慢调用提示（`llmNotice`）；拒绝走注入的 `refuseText`（可申诉），提交期兜底仍是 `scripts/scan-test-labels.cjs` |
| `edit-repo-scope.ts` | 一次编辑落在**哪个仓库**（`primary` / `other-repo` / `outside`）的唯一判定：git 有答案就听 git（调用方必须先爬到最近存在的祖先再问 git，跨仓库分支原样保留），没有答案时用 `fingerprint.ts` 的 `realFile` / `realDir` 解析两侧再按 `root + "/"` 边界判包含；解析后仍在仓库外的，再问一次「它到底属于哪个仓库」——「没有仓库」才跳过，「另一个仓库」照旧武装那个仓库。任何解析不出的情况一律回落 `primary`（fail-closed）。它存在的原因是仓库外的写入（子会话写进 `/tmp` 的完成报告）曾经作废 review 绑定，把已到手的 READY 打回 PENDING |
| `file-size-gate.ts` | 新建源码文件 600 行硬拦、存量超阈值只提醒的纯判定 |
| `dependency-justification.ts` | 新增依赖缺书面论证在 checkpoint 硬性打回的纯判定（`newDependencyNames` / `dependencyJustificationVerdict`），`review_checkpoint` 内接线；实现 §5“新依赖须论证”的机械一半，不复述其余三条。引用面（`agents/reviewer.md`、`agents/goal-auditor.md`、goal/plan 审计任务、`WRITE_TIME_REMINDERS` 只许引用 §5）由 §7.1 最小化行钉住 |
| `fingerprint.ts` | 工作区指纹：内容寻址、暂存无关，门禁裁决与它绑定 |
| `gate-dialogs.ts` | 门禁**唯一的对话框渲染入口**与 transcript 通知（t5 从扩展拆出）：`showToUser`（同步 `ui.notify`、不截断）、`asChoiceHost`、按需加载 pi 的多行编辑器组件接出理由框与复选框、每会话一个对话框队列；`askChoice` / `askMultiChoice` 共用同一个 `askDialog`（横幅、实际展示才起算的 30 分钟代答赛跑、用户交互时间戳写进共享 `Ref`） |
| `dialog-proxy.ts` | 30 分钟无人作答时 arbiter 代答的 **I/O**（t5 随对话框拆出）：带 transcript 指针的只读代答请求、把代答决定写进对应 repo 的 sidecar 并通知、跨 repo 汇总给 `declare_done` 的完成报告；赛跑规则本身在 `user-proxy.ts` |
| `gate-arming.ts` | **「本会话有没有需要审的东西」的唯一判据**（2026-09-20，演练 F1 的 fail-open）：arming 有两条来源 —— 工作区里脏的 code/doc 文件、分支领先 base 的 commit —— 而这条规则以前被抄成了两份（`session_start` 的 arming 与 `turn_end` 的对账），对账那份只看工作区文件类型，于是一个未跟踪的非 code 文件（实测：隔离 checkout 的 `node_modules` 软链）就能把「分支上还压着 8 个未审 commit」造成的 arming 清掉，而 `lib/ship-gate-bash.ts` 读到「本会话没有改动」后整个 ship 门禁放行（`git commit` / `git push` / `gh pr create` 都不再过门禁）。现在 `armingFromFacts`（事实 → 该 arm 什么）/ `reconcileArming`（clear-only，两个来源都问）/ `couldReconcile`（不值得付 git 调用时提前返回）是**唯一实现**，三个 arming 点（`session_start`、git 命令 re-arm、次级 repo 首个 sidecar）与 `turn_end` 对账共用；`files` 已由调用方按 scope limit 豁免表过滤、`commitsAhead` 在 scope limit 下由调用方置 0。**单路径的 edit 事件不走这里**（它问的是「这一次编辑算不算 code 编辑」，答案只看那个路径自己的扩展名，`lib/edit-tracking-hook.ts` 的 edit handler 直接问 `isCodeFile` / `isDocFile`） |
| `gate-command-tools.ts` | 命令层的**唯一注册入口**：工作流命令的注册包装、`/precommit` lane，以及 `/gate-status` / `/gate-contract` / `/gate-bypass` / `/gate-mode` / `/gate-reset` / `/gate-lesson` 六个命令正文；命令 host 的 seam（`CommandHost` / `CommandContext`）也在这里；自己转注册 `gate-diagnosis-commands.ts`。**`/gate-contract`（2026-09-18，用户决定「不常驻展示, 而是通过某个命令」）**：只读地把本会话那份契约（项目经理 = plan 任务全列；loop 会话与编排子会话 = 已批准 goal 的退出标准全文）打进一个多行 `notify` 块，与 `/gate-status` 同一条显示路、零新 UI 组件；行本身由 `lib/ui-widget.ts` 的 `buildContractLines` 构造，命令只有一个纯判定 `contractNotice`（有行 ⇒ 行；没行 ⇒ 「没有可显示的契约 —— **为什么**」，因为 judge pane / 未批准 goal / 无 plan / 非 git 目录 / 解析不出小节 五者都塌成同一个空数组，不写为什么读者只能当成 bug），`GateCommandDeps` 上只多一个 `contract()` seam。快捷键**刻意不绑**（用户决定：要时自己在 `/settings` 里绑） |
| `gate-diagnosis-commands.ts` | 两个只读诊断命令面：`/gate-status` 内嵌的模型链读数（`modelDiagnosisLines`）与 `/gate-doctor` 正文；只做环境探测，不写状态、不喂裁决；由 `gate-command-tools.ts` 转注册 |
| `gate-doctor.ts` | `/gate-doctor` 的只读体检：模型链、provider 允许名单、precommit runner、git 钩子、命令注册表 |
| `gate-state-records.ts` | `GateState` 的记录形状：verdict 词表（`GATE_VERDICTS` 等）、`RoundRecord` / 本轮 scope 对（`sanitizeRoundScope`）、暂存的 READY（`PendingReadyReview` + 守卫）、review / precommit / checkpoint / completion / lastReviewedTree 绑定块、`ProxyDecisionRecord` |
| `gate-state-transitions.ts` | `GateState` 上的纯状态转移：接力继任者继承什么（`inheritGoalContract`）、编辑作废哪些绑定（`invalidateBindings`）、`precommit.lastFullPassTree` 的唯一写入规则（`nextFullPassTree`） |
| `gate-state-load.ts` | sidecar 读取：`loadSidecar` 逐字段校验（伪造/畸形一律 fail-closed 丢弃或拒绝）并当场做指纹算法迁移（`migrateFingerprintVersion` + `FINGERPRINT_MIGRATION_NOTICE`） |
| `gate-state-io.ts` | sidecar 落在哪、怎么写：每会话变体路径（`STATE_VARIANT_ENV` / `stateVariantFrom` / `sidecarPath`）、原子写 `saveSidecar`、多会话并发绑定合并（`mergeConcurrentBindings` / `saveSidecarPreservingConcurrent` / `mergeProxyDecisions`） |
| `gate-state-requirements.ts` | **ship 权威** `unmetRequirements`（L1 与 L3 钩子共用的「能不能 ship」唯一答案），外加循环收敛判定（strategic reset、震荡、平台期） |
| `gate-state.ts` | 门禁状态机：`GateState` 接口与 `emptyState`（读写、判据、转移分别在 `gate-state-load/io/requirements/transitions.ts`，记录形状在 `gate-state-records.ts`）；也存放门禁**自己观察到**的事实，如 `shippedKinds`（跑成功过的 ship 命令种类，供交付站点的到站判定用；loader 只保留已知词表、去重，读不出来就当没有）与 `precommit.lastFullPassTree`（一棵**真的**跑过全量 lane 的 tree；纯规则 `nextFullPassTree` 只在 lane 启动前那棵树 + full/full PASS 时写入、同一棵树的 FAIL 撤销，编辑降级不碰它——它是内容身份，不是活绑定） |
| `gate-timings.ts` | `.pi/gate-timings.jsonl` 可观测日志，每个门禁事件一行 |
| `git-memory.ts` | 上下文压缩后重新注入过滤、截断过的 git 状态快照 |
| `git-rewrite.ts` | 识别「只改 message」的历史重写，解开 L5 与门禁互锁的死结 |
| `git-exec.ts` | **门禁同步跑 git 的唯一入口**（2026-09-25，t1）：`gitText` / `gitRaw` / `gitOrNull` / `gitRawOrNull`，缺省 env 是 `gitBaseEnv()`（剥掉会把仓库挪走的 `GIT_DIR` / `GIT_WORK_TREE` 等与 `GIT_CONFIG*` 注入；`GIT_LOCATION_ENV` 由 `scripts/*.cjs` 镜像、parity 测试守着），stderr 一律 pipe |
| `hash.ts` | 唯一的内容哈希 `sha256`（goal / plan / restatement / arbitration / fingerprint 共用） |
| `json-file.ts` | `readJsonIfExists`：尽力而为的 JSON 读取（缺失 / 读不了 / 坏 JSON 一律 `undefined`）；要区分「缺失」与「损坏」并报告的调用方自己读 |
| `goal-prereview-tools.ts` | **普通函数，不是工具**：`recordGoalPrereview`——把 goal-auditor 交上来的结构化结论落成绑定草稿 sha256 的记录；外加 goal 提交检查（空稿、长度上限、goal 绑定哪个 repo） |
| `goal-tools.ts` | 工具 `propose_loop_goal`（跑 goal 审计 → 用户批准对话 → 门禁自己写文件），并且是 goal 工具族的**唯一注册入口**：一个 host，一个工具 |
| `gate-modes.ts` | 门禁模式注册表（唯一实现）：八种模式各有提示词模板加工具集加流程规则（plan/goal/review 仅内部置入）；`resolveGateMode` 单派发；禁跑工具表与完成纪律的 single source（`judge-side.ts` 只 re-export，各任务 builder 只引用） |
| `hierarchy.ts` | opener 注册表与唯一的跨级裁判：谁开的 review 谁操作，其他会话一律 fail-closed（纯函数，IO 经 seam）；注册表与**至多一份 pending 审计**按 repo 落盘恢复（`parseHierarchySnapshot` fail-closed 解析；2026-09-05 起是单字段 `audit: PendingAudit`——goal 与 plan 共用一个 judge，两份同时挂着是系统进不去的状态，旧的 `goalAudit`/`planAudit` 双字段不再读），条目带 opener 派发的轮次号 `roundSeq`，以及**轮转簿记**（`objectId` 全量 id / `generation` / `roundsInObject` / judge 自报的 `contextPercent`，全部可选——旧 build 写的条目没有它们，降级成「无对象记录」而不是报错）；`findJudgeLane` 是「这个角色现在跑在哪条 lane 上」的唯一查询（judge id 含 lane，派生不出上一条，所以扫这张表而不是另建第二张）；死 pane 异主条目由触达者丢弃（不再过户——opener 限定的 id 不会碰撞）、活 pane 保持拒绝，重启不死锁 |
| `judge-lane-host.ts` | 一轮 judge **跑在哪条 lane 上**（t7 从扩展拆出）：`resolveJudgeLane`（读登记表 → 问 `judge-rotation.ts` 的策略 → 交回 `retirePrevious`，替换 lane 登记之后才退役旧 lane）、轮转交接的事实 `rotationCarryoverFacts`、关一个 judge window 的唯一实现 `closeJudgePaneOf`、scratch worktree 回收 `reapReviewScratch` |
| `judge-round-dispatch.ts` | **派发一轮 judge 的唯一入口** `dispatchJudgeRound`（t7 从扩展拆出）：质量前置、身份与工作目录派生、活 pane 走通道 interrupt（轮号随任务一起送）、死 pane 同 session id 重开并验证启动；`JudgeDispatch`（`delivered` 区分「任务到没到」）与 `hasTranscript` |
| `judge-round-settle.ts` | **一轮 judge 在哪结束**（t7 从扩展拆出）：`judgeChildByRole` / `findJudgeChild`（只找本会话自己的）、探针与记录器共用的 `roundBindingOf`、`recordJudgeConclusion`（进引擎 + 施加取消矩阵）、settle 扫描 `settleFinishedRounds`（用标准报告唤醒 agent） |
| `judge-launch-host.ts` | 一轮 judge **启动在什么上**（t6 从扩展拆出）：`resolveJudgeLaunch`（现读配置 → 按需重渲染模型层 → 按健康度选槽，跳过的冷却槽会告知）与派发前的无主 judge 会话目录回收 `sweepStaleJudgeSessionDirs` |
| `judge-lifecycle.ts` | `judge_submit` 背后的纯决策：opener + lane 限定的会话文件放哪（含无人认领目录的 TTL/旧格式回收选择器；**带 lane 的新目录形状也认**，否则轮转出的旧目录会被判成「not ours」永不回收）、超时钳制、审计裁决是否阻塞、`awaitRoundReport`（门禁自己的 goal/plan 审计链要的是**本轮结束**，所以它在消息驱动的 `judge_wait` 之上反复调同一个工具直到 report/pane-dead，共享一份总预算——不是第二个等待循环）；派单/等待判据已随进程模型删除，等待纪律 2026-09-05 搬到 `agent-directives.ts` |


| `judge-pane.ts` | judge 的跨进程契约常量（`RG_JUDGE_OPENER` / `_ID` / `_ROLE`，judge 侧据此认自己、并据此拿到 session 独占豁免）与 pane 探活（列不出来只算缺信息，绝不判死）；开/关/装饰 pane 已于 2026-09-05 全部搬进 `session-factory.ts` |
| `judge-process.ts` | judge 身份（opener + **lane** 限定的确定性会话 id：同 opener 同 lane 跨 pane/轮/重启复用，换 opener 或换 lane 全新；`JudgeLane`、`shortObjectId` 与 `laneSuffix` 都在这里——会话 id 与工作目录共用同一个后缀渲染器，两者不可能落在不同 lane，不传 lane 则逐字节还原轮转前的形状）与 scratch 目录 helper（`judgeScratchDir`，以 session id 为键）——reviewer 的临时 review worktree 据 `$TMPDIR` 落在那里，门禁按 `reviewScratchWorktrees` 在 pane 回收后精确回收。**写入侧在 `session-env.ts` 的 `buildSessionEnv`**：2026-09-14 前那里没有这个 key，于是 judge 实际把 worktree 建在系统 tmp 根目录、回收永远扫不到（两边必须指向同一个目录，`test/judge-scratch.test.ts` 就钉这一对） |
| `judge-prompt.ts` | judge 会话的系统提示装配：角色定义 + 共同协议 |
| `judge-pane-policy.ts` | **judge pane 何时回收**（2026-09-21 用户决定：从两套收成**一条** —— **一轮结论记录完成即释放**，不问谁派的；取代 2026-09-06「门禁自派的谁派谁收、agent 自派的留到 declare_done」的两套）。政策本身是一个常量 `JUDGE_PANE_RECLAIM`，执行点是**两个同规则的位置**：`runAuditRound` 的 `finally`（门禁自己的同步审计链）与 `settleAuditRound` 的结论半场（agent 自派的 review 经通道异步交卷）。释放不丢上下文：下一轮用**同一 session id** 重开（`judge_submit` 遇到死 pane 会落到 fresh open），所以判决书才是交付物、pane 只是屏幕空间。`declare_done` 的级联仍按 opener 无条件扫 —— 那是「本轮从未交卷」的 pane 的终点，不是这条规则的第二个实现。`reclaimAuditLine` 决定一次回收该不该留下日志：做到了政策承诺的就沉默，**失败或没能确认 pane 已关**才出一行（`judge_close` 连 kill 失败也会清掉登记行，回执一丢那个 pane 就再也找不到了）。给 `JudgeEntry` 加 `dispatchedBy` 的方案已在模块头写明为何被否 |
| `judge-registry-host.ts` | opener 侧的 **judge 注册表**（t6 从扩展拆出，deps 一次定死：`runTmux` / `channelIO` / `roundBindingOf` / `copilotWaitSince`）：一张表（`judgeHierarchy()` 是访问器，表每次写都会被重新赋值）+ 待记录审计 `pendingAudits` + 按 repo 切片持久化（`.pi/judge-hierarchy.json`，`setHierarchy` 是唯一写入漏斗）、身份（`callerIdentity` / `callerIdentities` / `paneOwnerIdentity`）、自己的与活着的 judge（`ownJudges` / `ownLiveJudges` / `activeJudgeWait`）、模型健康记录与 `absorbJudgeModelEvents`、外来死条目清理、轮号 |
| `judge-rotation.ts` | judge transcript 复用的**单元 / 释放点 / 上限**（纯函数，2026-09-05 用户口径）：复用单元 = 一个**已批准**的 review 对象（编排会话取 plan hash、其余取 goal hash，都没有则稳定占位 `none`——`none` 同样受两条闸约束，不是无界桶）；释放点 = 对象 id 变了（惰性判定，下次派发时比对，不改 goal/plan 的写入路径）；上限 = judge 自报上下文 ≥ `JUDGE_ROTATION_CONTEXT_PERCENT`（= 统一的 `HANDOFF_PERCENT`，70——它自己那个 60 已于 2026-09-14 删除）或同对象派发满 `JUDGE_ROTATION_MAX_ROUNDS`（8）轮——**轮次在派发时计数**，所以放弃/重开的轮也算，读数缺失则 fail-open（只靠轮次兜底）。`decideJudgeRotation` 给出 lane（`{objectId, generation}`，由 `judge-process.ts` 的 `laneSuffix` 渲染进 session id 与工作目录）与写回注册表的簿记；`rotationHandoffTask` 组装轮转后首轮的压缩交接——交接正文一律由 `review-carryover.ts` 的 `buildReviewCarryover` 渲染，本模块不写第二份。`judgeRemembersPreviousRound`（2026-09-06）把「本轮 judge 还记不记得上一轮」这件**只有这里知道**的事导出给 `review-scope.ts`：`reuse` **且** 该 lane 的 transcript 确实存在才算记得；`first` 也算不记得（登记表没有的 lane，它的历史门禁担保不了），任何未知一律 `false` |
| `judge-session-addressing.ts` | `judge_close` / `judge_wait` 共用的寻址（`addressJudge`，含 gate-self 旁路）、opener 校验 `checkOpener`、可寻址角色表 `ADDRESSABLE_JUDGE_ROLES` 与两种失败形状 |
| `judge-wait-criteria.ts` | pane judge 的**等待判据**：`probeJudgeRound`（本轮是否结束，调 `selectRoundReport`；settle 扫描也直接用它）、`probeJudgeWait`（消息驱动：report / 提问 / finding / 模型耗尽）、`paneJudgeStalled`、`recentStreamFindings` |
| `judge-wait-tool.ts` | `judge_wait` 的实现 `doWait`：等待循环、finding 与模型事件游标、标准报告组装；门禁自己的审计链带 `gateSelf` 直接调它 |
| `judge-session-tools.ts` | 作用在既有 pane judge 上的两个入口（文件里留 deps、参数 schema、`doClose` 与注册；等待实现/判据/寻址见上三行）：`judge_close`（只在 internalHost，门禁审计链自收）与 `judge_wait`（`registerJudgeWaitTool` 把**同一实现**注册到 internalHost 与 agent 面）；等待是**消息驱动**的 —— 新 channel report / pane 死亡 / judge 提问 / 新 finding / `settled`（本轮已交卷、已记录且已消费，而 pane 空闲 ⇒ **立即**回一个「没有可等的了」，不再阻塞到超时，2026-09-16）任一命中即返回，去重游标是 entry 上的 `lastReportId` + `lastFindingCount` 与会话侧已宣告问题集；opener 校验也在内。**report 落地后它不自己记录**（2026-09-05）：一律交给 `audit-round.ts` 的 `settleAuditRound`，report 游标也由引擎推——它只保留 finding 游标。**「本轮是否结束」也不自己判**（2026-09-05 第二次）：`probeJudgeRound` 调 `selectRoundReport` 用同一份 binding（deps 的 `roundBinding`），不属于本轮的 report 不算结束、原样报成 `notThisRound`——两侧判据不一致时，wait 会宣布一个记录侧随后拒绝的 READY。`judge_read` 已删（2026-09-05） |

| `judge-side.ts` | pane 内门禁的 reporting shell：heartbeat、对话框竞态（复用子会话通道原语）；结论合成与扒取已搬入 `judge-conclude.ts`；禁跑工具表已搬入 `gate-modes.ts`，此处只 re-export；「judge 不写主 sidecar」已搬入 `session-exclusivity.ts`（与 worker 的同一答案、与独占判定同源） |
| `judge-conclude.ts` | 一轮的唯一结束方式：judge 侧专用 `judge_conclude`（只在 judge 会话注册，主会话不可见——防伪靠注册面）：结构化结论**本体**直写 channel report（无 fence 合成、无解析）；**签名按角色收窄**——reviewer / goal-auditor 只有 verdict + findings + cwd（传 notes 显式拒绝且不占额度），adviser 保留 notes（它的产出就是正文）；opener 以 `roundSeq` 编轮次，一轮只交一次，重复调用显式拒绝；校验失败不占额度；**零审查的 READY 直接拒**（判据在 `judge-inspection.ts`，拒绝不占额度、并给出申诉出路），观测结果以新增可选字段 `inspection` 盖在 report 上；本轮范围与全量/增量档位以另一个新增可选字段 `scope` 盖上（自述，与门禁登记的那半并排落进 `RoundRecord.scope`，只记录不阻塞） |
| `judge-inspection.ts` | 机械审查证据（judge 侧、进程内）：把本轮成功的工具调用分类成「读内容 / 看 diff / 检索」（列文件名的 `ls`/`find` 不算），折叠成本轮证据并从任务文本里解析 `baseline..HEAD` 与全量/增量判定标记（`parseReviewScopeKind`，标记常量来自 `review-carryover.ts`；两者**只记录、不作为阻塞条件**）；**本轮公文一律不算审查**（`GATE_OWNED_PATH_MARKERS` + 本轮任务文件/findings 流的确切路径——探针的原话是「直接交 READY 别做别的」，而 judge 总要读任务，算进去这道门就等于从没拦过）；证据按**轮次记名**（`evidenceForRound`），被放弃那一轮的阅读算不到下一轮头上；唯一规则是「带裁决的角色零审查不得交 READY」（adviser 写死豁免，未知角色按裁决角色处理——fail-closed；BLOCKED/NEEDS_HUMAN 不受限） |
| `judge-model-rotation.ts` | pane 侧的**模型自愈**（2026-09-10）：judge 是唯一看得见自己 provider 错误的一方（opener 卡在 wait 里，通道里只有结论），所以链得由它自己走。触发点是 `agent_settled` + 最后一次运行以 `stopReason: "error"` 终结（pi 自己的重试已耗尽；单个 503 burst 通常自愈，所以**不看第一次失败**）。`onModelFailure` 从角色链（`judge-prompt.ts` 的 `modelChainFor`，每次现读配置）走到本轮回合内还没花掉的下一槽：切换模型 + 该槽的 thinking、自注入一句「继续本轮」（transcript、任务与已查到的证据全部保留）、并把 `ModelEvent` 写成通道 state 记录供 opener 冷却坏槽；链全花完标 `exhausted`，那是**轮次的结束**（`judge_wait` 的 `model-exhausted` 判据），不是无限等。无链可走返回 undefined（调用方的 fail-closed 情形） |
| `judge-report.ts` | opener 侧标准报告（wake-up 内容：verdict、证据位置、记录情况、待答问题、**被搁置的 report**（`notThisRound`：id/轮次/时间 + 原因，说明它没被记为本轮裁决）、**降级绑定说明**（`bindingNote`：独立成行，因为「记录」行只打印首行，塞进记录正文就等于记了没人看见）、**本轮审查范围**（`scope`：judge 自报的 `baseline..HEAD` 与全量/增量档位，settle 扫描与 `judge_wait` 两条唤醒路径都传，否则一半唤醒有、一半没有）、**门禁因本轮结束做了什么**（`handOffNote`：2026-09-16 起是取消矩阵的回执——「已终止 reviewer 的这一轮」「正在跑的全量 precommit 已终止」以及扣下的 READY 是否被补记/作废；与 `bindingNote` 同样独立成行，理由相同，且 2026-09-15 刚因此踩过一次：接力失败那句被折进只打印首行的「记录」里，agent 等了一个永远不会启动的 reviewer）；transcript 扒取半边已随交卷工具删除） |
| `judge-spawn-tools.ts` | pane judge 生命周期工具（`judge_spawn` / `judge_answer` / `judge_recover`）及其注册：agent 只给意图，审计任务由门禁组装 |
| `lang-detect.ts` | L5 英文判定的唯一实现：任何非拉丁字母即拒，调用方只决定措辞 |
| `llm-classify.ts` | 语义第二意见（DeepSeek V4 Flash），契约上只能加拦（TIGHTEN-ONLY） |
| `goal-audit-task.ts` | goal 审计任务正文（门禁构造、不经 agent 手写）：上一轮审计的 carryover（`formatGoalPrereviewCarryover`）、草稿机械差异（`diffDraftLines`）、完整审计任务（`buildGoalAuditTask`） |
| `goal-confirm-copy.ts` | goal 批准对话框的文案：transcript 全文回显（`buildGoalTranscriptMessage`）、框标题与正文（`GOAL_CONFIRM_TITLE` / `buildGoalConfirmMessage`） |
| `loop-goal-directives.ts` | loop goal 的提示词注入与展示：每轮 goal 指令（`buildLoopGoalDirective` 等）、协商提醒节流与强制协商（`goalReminderDue` / `goalNegotiationOverdue` / `buildGoalForceNegotiateDirective`），以及下面 `loop-goal.ts` 一行所述的展示出口 `parseGoalCriteria` |
| `loop-goal.ts` | L8：loop 会话退出契约的文件、hash、审批与预审记录、L8 编辑/ship 拦截文案（注入与展示在 `loop-goal-directives.ts`）。**例外的一条纯展示出口**（2026-09-18，住在 `loop-goal-directives.ts`）：`parseGoalCriteria(text)` 只从「退出标准」小节里**原样**取出条目（认 `退出标准`/`退出判据`/`Exit criteria` 三种标题、`1.`/`1、`/`- `/`* ` 四种起头；缩进的非条目行算上一条的续行，顶格行一律算小节结束），不改写、不缩写、不排序 —— 曾有一版把它压成「引导小句」，已按用户口径删除（切中文句子只会产出「真值同源」这类裸名词，且需要在屏幕上重写用户批准的契约）。它刻意吃 **goal 文件原文**而不是 `LoopGoal.text` —— 后者为提示词预算在 `LOOP_GOAL_MAX_CHARS` 处截断，实测本仓 48 份 goal 里 15 份的标准落在截断点之后。不参与任何判定 |
| `loop-stall.ts` | L2 自动续跑的断路器：外部阻塞（限流、模型不可达）时停止空转 |
| `loop-stages.ts` | **五个环节的开关（2026-09-22，用户决定）**：goal（含需求反述）、功能审查 reviewer、质量审查 quality-auditor、真实验收 acceptance、全量 precommit —— 默认**全开＝今天的行为**（没有记录 ⇒ `stageOpen` 一律 true，老 sidecar 与全新会话行为一致）。用户自己在**门禁自己的**五项复选框里勾选（`loopStagesSpec`：行文本即选项原文，`defaultChecked` 是推荐组，空勾合法＝全关）；`choose_loop_stages` 是**无参**工具（agent 只表达意图，框的文案、默认、记录、放行全归门禁），`ensureLoopStages` 是**同一份实现**的兜底入口（第一次 edit/write 或 `propose_restatement` 时尚无记录 ⇒ 门禁自己弹同一个框，扩展侧一线程一次、关框/画不出框都只按默认走、不记录假答案）。记录落在 `GateState.stages`（`sanitizeLoopStages` 全有或全无：半份记录丢弃 → 回到全开，因为一条记录只能**放宽**门禁）；五个卡点各自调**同一个** `stageOpen`（ship 权威在 `gate-state.ts` 的 `unmetRequirements`，L3 钩子在 `scripts/pre-commit-check.cjs` 读同一份 sidecar），故「关了但还拦」在两层不可能出现；编排模式与其子会话、judge pane 一律不提供（`stagesOffered`，一律走完整循环）。**开关会进提示词**（2026-09-22 用户要求）：`buildStagesDirective(record)` 把本会话五项各自的开/关渲染成一段注入 loop 指令的文本（无记录 ⇒ 空字符串，不污染提示词；有环节关闭 ⇒ 点名它并附上后果，那句后果与用户对话框正文共用 `STAGE_OFF_CONSEQUENCES` 一张表；唯一例外是 goal —— 它关掉时已有一整段专用指令，本块不重复）。注入条件是 `taskMode === "loop" || taskMode === undefined`：未分类会话在门禁其它地方已被当作 loop（`isEnforcedMode`），而 `stagesOffered` 也允许它回答开关框，所以它不能读不到自己刚设的开关（2026-09-22）；同一块里，未分类且 goal 关时补注入 `buildGoalStageOffDirective()` —— 否则块里那句「见上面那段 goal 指令」指针悬空（质量轮 P2，2026-09-22）。没有它，`stageIsOn` 释放掉的环节在 agent 眼里是不存在的：实测用户关掉验收后，会话照样往 goal 里写验收方案、还去搭真机现场（`LOOP_STAGES_BODY` 的每环节后果也从那张表渲染） |
| `agent-frontmatter.ts` | `agents/*.md` frontmatter 的读写：生成标记 `GENERATED_MARKER`、模型链替换（`replaceFrontmatterModels`）与读取（`extractFrontmatterChain` / `parseAgentFrontmatterFields` / `projectAgentIdentity`） |
| `agents-config.ts` | `review-gate.json` 的 `agents` 段：单层解析（`parseAgentsSection`，`MAX_SLOTS` 截断）与多层合并成有效配置（`effectiveAgentsConfig`） |
| `agents-startup.ts` | 启动硬检查 `validateAgentsForStartup`（无内置默认；六个 judge 角色 + 已声明的 `agents.worker*` 预设）与缺口自愈 `healMissingAgentSlots`（只补 judge 角色），二者由 `startupAgentsCheck` 排序；它还按声明层给出每个失败角色该修的配置文件（`configFiles` / `fixFiles`：项目层声明的点名项目层文件） |
| `agents-startup-copy.ts` | 启动检查失败时注入 system prompt 的拒绝文案 `formatAgentsStartupRefusal`（经 `rejection-copy.ts` 渲染，点名 `fixFiles`，不写死全局路径） |
| `model-config.ts` | 每个 agent 的模型链配置层：角色清单 `KNOWN_AGENTS`、包内 agents 目录定位与补齐，把有效配置渲染进 agent 文件（`applyAgentConfigLayer`）；解析、校验、启动检查分别在 `agents-config.ts` / `model-spec.ts` / `agents-startup.ts` |
| `model-spec.ts` | 模型 spec 解析（`provider/id:thinking`）、模型 registry 读取（`loadRegistry`）与 spec / 槽链校验（`validateSpec` / `validateSlots`） |
| `model-health.ts` | judge 模型槽的**冷却记忆**（纯函数，2026-09-10）：键是 `provider/id`（丢掉 thinking 后缀，否则改一个槽的 level 就把学到的东西忘了）→ 最近一次失败；`MODEL_FAILURE_TTL_MS`（10 分钟）内派发跳过该槽、过期自动恢复（并带条数上限，坏 id 不会把文件撑爆）。`selectHealthySlot` 给「第一个不在冷却期的槽」，全都在冷却时仍按链头派发并标记 `allCooling`（fail-open：开不出来的轮次连失败都报不了）；`recordModelFailure` / `clearModelFailure`（轮转成功即证明目标可用，旧记录必须清掉，否则 TTL 内白白跳过好模型）/ `nextSlotAfter`（pane 侧走链）/ `describeCoolingSlot`。持久化住在 `.pi/judge-hierarchy.json` 的 `modelHealth`（opener 读写；judge pane 按契约从不写仓库状态） |
| `model-diagnose.ts` | 纯诊断：「我的审查实际会跑在哪个模型上、这条链可用吗」 |
| `readonly-stall.ts` | 只读钻探止损（2026-09-18；阈值 30 → **100**，2026-09-14 用户决定 —— 30 次在「工作本身就是读」的任务里是常态，提醒常常在调查仍有效时到达，而它只是 nudge、晚到不付代价）：工具调用层计数器，连续 `READONLY_STALL_LIMIT` 次成功的只读调用（read 家族 + bash）无 edit 落地时注入 NUDGE（只提示不拦截）。补 loop-stall 的 turn 边界盲区与进展维度「任何调用都算推进」的盲区；状态纯内存，不落盘。**谁听得见由 `readonlyStallNudgeFor(mode)` 决定**（2026-09-17）：`normal` 与 `orchestrator` 静默 —— 项目经理按约束 2 根本不写代码，这条提醒对它恒为误报；计数本身仍与模式无关 |
| `orchestration-id.ts` | 编排 id：编排的稳定地址（不是 session id），接力换人后子会话无感。启动时持哪个 id 的判定也在这里（`startupOrchestrationId`，2026-09-17）：env 继承 → **本会话自己的 runtime（`storedRuntimeIsMine`，按 runtime 自己的 `ownerSessionId` 判，不是按 sidecar 的 sessionId）** → 否则新铸；**别人的 runtime 一律不隐式接管**，那是 `orchestrator_attach` 的事 |
| `out-of-repo-paths.ts` | 仓库外路径判定：`isOutsideRepoPath`（sidecar 里表现为绝对路径就是仓库外）+ **敏感路径**判定（复用 `isSensitiveFile` + `OUT_OF_REPO_SENSITIVE_SEGMENTS` 按目录段匹配，与家目录展开无关）+ `sensitiveOutOfRepoEdits`（代批时真正算违规的那一批）。仓库内的写入**不参与判定**：同一 repo 的任务本来就被串行调度，文件边界已于 2026-09-17 从 plan 中移除（原 `orchestrator-boundaries.ts` 的边界代数一并删除）。它不替代 `ship-gate-edit-guard.ts` 的编辑期敏感文件防线 |
| `child-side-host.ts` | 监督通道的**子会话一侧**（t6 从扩展拆出）：`childBinding`（编排子会话 / worker / judge pane 三种绑定）、`reportChildState`（节流的状态上报，带进展戳与 settled 证据）、10s 心跳定时器 + 自己通道文件的 watcher、指令 drain（两段回执、stop-first、重入守卫）、`askEitherSide`（人与上级谁先答谁生效）；规则在 `orchestrator-child-channel.ts` |
| `channel-records.ts` | 点对点通道的**记录 schema**（state / request / request-settled / answer / instruct / instruct-ack / report），只有类型 |
| `channel-io.ts` | 通道的**磁盘侧**：注入式 `ChannelIO`（可选 `readFrom` 按字节偏移读，假 IO 不实现就回退 `readText`）、`nodeChannelIO`、路径、`appendRecord` 与大 payload 溢出到旁文件、payload 解析 |
| `channel-projection.ts` | 通道的**读取侧**：`readChannel`（游标是字节偏移，只读新追加的完整行；文件比游标短（截断/重写）就回退全读；写到一半的末行留给下次）、投影（还欠着什么；2026-09-09 起**只认通道主人的 `state` 记录**——主人 = 第一条带 session id 的 state 记录的作者，无 id 的记录照收、别的 session 的记录忽略，已污染的通道重读即净）、心跳超时判定；以及**不可信输入的边界净化**——`sanitizeScopeStamp` / `sanitizeContextPercent` / `sanitizeDeliveryStation`（未知取值一律丢弃，绝不降级成某个真值；站点词表仍只由 `lib/delivery-station.ts` 定义） |
| `orchestrator-child-channel.ts` | 子会话侧：状态上报、「人与项目经理任意一方先答即生效」的竞态提问、读取与确认编排下发的指令 |
| `orchestrator-child-state.ts` | 子会话状态（working / waiting-input / **waiting-judge** / idle / done / dead / stalled + mode-changed）与再唤醒退避；`waiting-judge` 是「在等门禁自己派出去的 reviewer/precommit」，不叫醒项目经理；`mode-changed` 是模式切换事件，叫醒项目经理。也让 `stalled` 回到只表示「扩展不在了」。判据全部是结构化真值，不看屏幕。**2026-09-09**：working / idle 行都带「自上次推进 Xs」（idle 行不再印心跳时间）；child 侧 `childBinding` 校验本进程 session id 必须是门禁指定的确定性 id —— 继承 env 的 subagent 不再绑定父通道。**2026-09-10**（用户决定）：`idle` 有**结构化证据**就不等 120s —— child 在 `agent_settled` 上写 `settledSince`、此后任何工具调用清掉它（`lib/channel-records.ts`），「已 settled 且此后无工具调用」是关于结构的陈述，不是时间窗；`IDLE_PROGRESS_GRACE_MS`（120s，用户 2026-09-04 的数字，未改）降为**兼容兜底**（旧版 child / 从未 settle 的会话 / 畸形戳）。同轮：`done` 不再「响两次就永久安静」—— 改为随真持续时间**递减频率**重报（60s→2×→…→封顶 10 分钟），因为终态是对 **child** 而言的，而**项目经理**还欠它一次复验、一个任务状态和一次 `close`（实测两次的共享记忆被消费掉后，PM 在已完成的 child 旁空等满 300s 预算） |
| `orchestrator-pane-decor.ts` | 可视化区分的**字符串**：按 id 派色（纯函数，同一会话永远同色）、`<干什么>@<谁启动>:<名字>` 的边框身份（`paneIdentity()` 是唯一拼标题处；`childPaneLabel` / `judgePaneLabel` / `pmPaneLabel` 是它的三个入口）、`selfPaneOwner()`（opener 从自己的 env/模式算出 `谁启动`）、window 级选项的取值（`PANE_BORDER_FORMAT` 是条件式 `#{?@rg_label,#{@rg_label},#{pane_title}}`：门禁开的 pane 渲染门禁写的标题，旁观者的 pane 照旧渲染自己的 `pane_title`）。**纯展示层**：只写不读，任何判定都不看它。写标题（`refreshSessionPaneTitle` / `paintPaneTitle`）在 `session-factory.ts`。**标签栏只开不关**（2026-09-17 用户决定）：旧释放判定（`releasesWindowLabels` / `countDecoratedPanes`）连同五条关闭路径的接线已整条删除，因为 toggle `pane-border-status` 会让整窗每个 pane 少/多一行（实测，见 `orchestrator-supervision.md` §六丁） |
| `orchestrator-plan-approval.ts` | 「这次 plan 改动扩权了吗」：删任务、加依赖、并行改串行、降并行度、收紧交付站点、某任务的交付站点被收紧、从 `allowMultiplePrs` 移除 repo ⇒批准迁移并记审计；新任务/删依赖/串行改并行/提并行度/换 repo/提高交付站点/**某任务的交付站点被提高**（plan 的最后一环免收窄，所以改任务顺序或删掉兄弟任务都可能把豁免提给别人，2026-09-18）/向 `allowMultiplePrs` 新增 repo ⇒重新批准。**文件边界自 2026-09-17 起不是 plan 的一部分**（用户决定：同 repo 串行，边界防不住冲突），“已批准目录树内的细化 / done 任务让出地盘”两条规则随边界一起删除。一条 2026-09-06 的放宽保留：**批准世系** `approvedPlanHistory`（用户批准起、每次平移追加的内容 hash 链）——写回其中任一内容即把批准平移回来，撤回一次误操作不必重走 submit；用户每次新的显式批准**重置**世系，因此被收窄掉的旧版本回不来 |
| `orchestrator-plan-audit.ts` | plan 的前置审计（`goal-auditor` 角色 + plan 专用模板）：审计要点、裁决绑定 canonical plan 文本的 sha256、只 P0/P1 阻塞、退回 findings 的文案。**「哪份 report 收本轮」已于 2026-09-05 搬去 `audit-round.ts`** —— 那是审计**回合**的问题，不是 plan 的，三种 kind 都要回答它 |
| `orchestrator-answer-rules.ts` | `orchestrator_answer` 的纯裁决：`normalizeAnswerItems`（批量 `answers` 的读入，畸形项保留成空答案去各自裁决）、`resolveAnswer`（选项原文/字母/序号/唯一子串，多选拆分）、`checkProxyCrosscheck` + 词表 `PROXY_CROSSCHECK_TOKENS`、拒绝文案（并排贴回 / 站点放宽） |
| `orchestrator-answer-tools.ts` | 工具 `orchestrator_answer`：把答案写进通道（解析规则在 `orchestrator-answer-rules.ts`，含糊即拒），代批 goal 时按约束 8 检查子会话实际落点是否在**仓库外的敏感位置**；代批 goal / 代确认反述还必须带 `crosscheck` 对照（任务 id + 任务目标/交付站点两判断，词表 `PROXY_CROSSCHECK_TOKENS`，缺项退回并把 plan 任务与子会话正文并排贴回），且请求携带的站点不得宽于已批准 plan 的 `deliveryStation`。可选的 `answers` 数组一次答完子会话一整批 `ask_user` 提问：**裁决只有一份实现**（单问与批量都走 `answerOneRequest`），每条独立成败、写进通道的不回滚 |
| `orchestrator-delivery.ts` | 投递：任务文件 + `pi --session-id @file` 启动、恢复用的 argv 与说明，以及「什么才算送达」的判据（通道记录 / 子会话回执）。任务书在 brief 之后追加两条**门禁自己算的事实**：`TASK_GOAL_DIRECTIVE`（门禁硬指示：plan 批准 ≠ goal 批准，必须先协商自己的 loop goal）与 `buildBranchLine` 渲染的分支行（2026-09-18，替代原先那句固定的「开工前先给自己开一个功能分支」）—— 同一 checkout ⇒ 点明它在的那条分支且不要新开；门禁自建隔离 checkout ⇒ 点明门禁的 `rg-child-…` 分支，站点低于 `pr` 就不许 push/开 PR、站点到 `pr` 则先 `git branch -m` 改成给人看的名字再交付；保护分支或读不到分支 ⇒ 才给「自己开功能分支 + kebab-case 命名规范」 |
| `orchestrator-deps.ts` | 编排工具需要的依赖集合；host 类型本身住在 `tool-host.ts`，这里只 re-export |
| `orchestrator-directives.ts` | 编排两侧的指令：项目经理拿全套契约，子会话只拿一句话 |
| `orchestrator-dispatch.ts` | dispatch 半边：`orchestrator_spawn` / `orchestrator_instruct`；spawn 时按任务声明的 `repo` 解析子会话 cwd（`resolveTaskRepo`，fail-closed——解析不了就拒绝，绝不回退到项目经理自己的 repo），并把分支事实（`deps.currentBranch` 读到的实际分支、是否门禁自建 checkout、站点上界是否到 `pr`）交给 `buildBranchLine` 渲染进任务书 |
| `orchestrator-gate.ts` | 编排的 10 条硬约束（约束 7/10/14 于 2026-09-07、约束 5 于 2026-09-17 退役），写成纯决策以便逐条单测 |
| `orchestrator-guard.ts` | tmux backstop：拦截绕过工具手写的 tmux 命令 |
| `user-notify-runtime.ts` | 通知的运行时半边（2026-09-17 拆出）：解析 `terminal-notifier` 的路径（开一次，退出路径不能再查 PATH）、本会话的 tmux 地址（惰性，只有真要发时才查）、两个 spawn（活会话 detached；`exit` 里只能同步，且给 10s 超时）、以及注册进程退出 handler。拆出理由：那 60 行是新职责，而扩展已经 ~9000 行。**2026-09-18 起还负责「用户是否正看着这个 pane」的取证**：`list-clients` + 每个 client 的 `display-message -c` 得到各 client 的当前 pane，`lsappinfo front` 得到前台 app 的 bundle id —— 两条读数都只在否则真要发一条通知时才取（惰性 thunk），`lsappinfo` 带 2s 超时（同步跑在对话框路径与 exit handler 里），tmux 地址按 banner 重新解析（pane id 进程内固定、**window id 不固定**：join-pane/break-pane 会搬家，跨调用缓存会让点击跳去旧 window） |
| `user-notify.ts` | 桌面通知：三种事件（完成 / 异常结束 / 停下来等用户回答）、只有没有上级的会话能发、`terminal-notifier` 的 argv 与「点回那个 pane」的纯函数、节流。旧的 `orchestrator-notify.ts`（OSC + tmux passthrough）整份删除。**2026-09-18 起**：标题是 `<类型> · <repo>`（等你回答 / 任务完成 / 异常结束）、`-group <sessionId>` 让同一会话的通知互相替换（不再堆叠）、`isWatchingPane` 在「用户正看着这个 pane 且终端在前台」时抑制整条通知（两个事实都成立才算，任一读不到一律照常发；pane id 形状复用 `orchestrator-tmux.ts` 的 `isPaneId`，不再自写正则；前台 app 与 `__CFBundleIdentifier` 的比较是**已知近似** —— 后者是 tmux server 启动时继承的 app，失配方向是多发一条而不是静默）。**取证排在节流之后**：被节流拦下的通知不付 3–5 个同步子进程；被抑制的通知不记额度，下一条照发 |
| `user-proxy.ts` | **没人回答时谁来答**（2026-09-19，用户决定）：门禁的每个对话框等 30 分钟仍无人作答时，交给 `arbiter` 读本会话上下文代答。纯策略层 —— 窗口计时、先答者胜（用户与经通道作答的项目经理都算「人」，先到先得；arbiter 跑到一半用户答了就以用户为准）、代理答案必须是对话框给过的**候选行原文**（`raceWithUserProxy` 里那一次行校验是唯一一道闸）、提示词给的是 transcript **指针**而非正文（它跑在 `PROXY_ISOLATION_FLAGS` 的**只读**工具集下，不是 appeal arbiter 的 `--no-tools` —— 第 2 轮 P1 实测：拿不到工具时那个指针是废的，功能的核心行为根本跑不起来）、失败/超时/不可解析一律**无答案**，而「无答案」对十二个对话框恰好都是保守方向（授权即拒绝、`request_scope_limit` 保持完整门禁、提问即未作答）；`formatProxyDecisionReport` 渲染 `declare_done` 机械打印的那份清单 —— 用户必须能不费力地看出哪些决定不是自己做的。代答不产生任何额外权力：它只填对话框的答案本身。进程执行复用 `arbitration.ts` 的 `runArbiterProcess`（同一执行实现上的第三种问法，不是第二套实现） |
| `orchestrator-plan.ts` | plan **是什么**：编排层的退出契约——类型、`parsePlan` 校验、依赖成环检测、canonical 文本与 `planHash`（批准绑定内容 hash）、`formatPlanSummary` 渲染。`planHash` 的**产出方**，因此「什么算一个 plan hash」也归它：`isPlanHash` 是那条形状规则的唯一实现，凡从 sidecar 读回授权记录的地方都用它（复制出去的授权校验只会朝放宽的方向漂移） |
| `orchestrator-plan-progress.ts` | plan **被执行时**产出什么（2026-09-27 从 `orchestrator-plan.ts` 拆出）：任务状态机（`isLegalTransition` / `applyTaskStatus`）、改写 plan 时保留执行记录（`mergeTaskProgress`）、调度（`scheduleNextTasks`）与退出判定（`unfinishedTasks` / `unreportedDecisions` / `openDecisions` / `nextDecisionId`）。都不属于批准内容，所以不和 hash 绑定住在一起 |
| `orchestrator-recovery-tools.ts` | 工具 `orchestrator_recover` / `orchestrator_attach`：同 session id 续开一个死掉的子会话、接管一整个编排，以及「plan 说 running 但没人在做」的孤儿检测 |
| `orchestrator-runtime-host.ts` | 会话的**运行期时钟**（t6 从扩展拆出）：统一退出判据 `sessionExitProblems` / `orchestrationDoneProblems`、revival 定时器、后台 supervision 定时器（同一份 `superviseNow` 读数）、项目经理的 settle 续跑（`orchestratorSettled` 与续跑预算）、会话名字心跳（顺带 drain 收件箱），以及它们共同遵守的退位标记（`handedOff` / `markHandedOff`）；判定在 `session-revival.ts` / `orchestrator-supervisor.ts` / `orchestrator-gate.ts` |
| `orchestrator-registry.ts` | 子会话登记表：编排只能操作门禁替它创建的东西（类型、登记表增删查、grants）。sidecar 读回的净化在 `orchestrator-registry-normalize.ts`；`successorRuntime(runtime, fromHandoff)` 是「换了个会话能继承什么」的唯一出处 —— 登记表与 grants 照旧留下；许可只在 `fromHandoff` 为真（前任自己交棒的继任者，判定在 `lib/session-inheritance.ts`）时留下，其余情形全部剥离（写在调用点上的字段清单迟早漏掉新字段）。runtime 还带一个 `ownerSessionId`（2026-09-17）：**哪个会话持有这个编排** —— 它是「reload 后能不能恢复」的唯一依据（`storedRuntimeIsMine`），只有铸出、继承或接管了该地址的会话会写它。child 记录上的 `worktree`（路径 + 分支）由净化模块按路径强度校验：它会被交给 git |
| `orchestrator-registry-normalize.ts` | sidecar 里那份 runtime 的**唯一净化处**（`normalizeRuntime`）：批准相关字段（hash / 时间 / 快照 / 世系）按同一强度校验、任何疑点整份丢弃；child 的 pane / window 坐标 / worktree / stateVariant 按形状净化，畸形 child 丢弃而合法 child 保留（fail-closed） |
| `orchestrator-worktree.ts` | **一个写者一个 checkout**（2026-09-10，用户决定）：纯逻辑模块——路径/分支的**派生与反推**（`childWorktreePath` / `repoRootOfWorktree`，后者反推不出来就**拒绝**而不是猜）、创建 argv（`-b <branch> <path> HEAD`，钉在 HEAD 上而不是分支名）、三种结算（`keep` / `merge`（先 `add -A` + `commit` 提交遗留改动，再 `--no-commit --no-ff` 合入并 staged，**最后回收 checkout 目录**——2026-09-15 用户决定：四个结算完的子会话就会在仓库旁边留下四个死目录，而分支留着（它是 `merge --abort` 的唯一回退锚，且不占磁盘）/ `discard`（目录 + 分支，对已回收的 checkout 幂等））的**完整计划**（`planSettlement`，冲突路径在跑之前就定好，且冲突时序列在 merge 那一步就断了、**绝不会**走到回收）、以及未结算 checkout 的识别（`findOrphanWorktrees`：pane 列表读不到就**不下断言**）。git 调用在 `lib/orchestrator-worktree-host.ts` 侧执行 |
| `orchestrator-session-tools.ts` | 注册编排会话工具（spawn / instruct / wait / close，并转注册 answer 与 recover/attach）——spawn / instruct 的实现在 `orchestrator-dispatch.ts`，wait / close 的实现在 `orchestrator-wait-tool.ts` / `orchestrator-close-tool.ts`（2026-09-27 拆出），answer 与 recover/attach 在各自的 `*-tools.ts`；交接工具从 2026-09-14 起**不在这里**（全会话共用的 `session_handoff`，见 `session-handoff-tools.ts`） |
| `orchestrator-wait-tool.ts` | `orchestrator_wait` 的实现 `doWait`：每次探针读遍通道、消费监督记忆、按请求判定待答问题，组装四块回执（含退出阻碍 `exitBlockers` 与继承简报）；纯回执规则在 `orchestrator-wait.ts` |
| `orchestrator-close-tool.ts` | `orchestrator_close` 的实现 `doClose`：关子会话的 window、结算其隔离 checkout（keep / merge / discard，已关闭子会话可只结算），git 动作经 `deps.settleWorktree` 注入 |
| `orchestrator-supervisor.ts` | 编排侧监督：读遍所有通道、逐个判定、决定什么算「有事发生」（含退避与完成上限）、渲染回执的前三块；`relayedPane` 判定交接后的子会话搬到了哪个 pane（登记 pane 已死、自报 pane 活着），由 `orchestrator-registry.ts` 的 `repointChildPanes` 写回登记表 |
| `orchestrator-takeover.ts` | 「仓库里有别人的 plan」时的两个意图：**接管**（从盘上发现本仓库的候选 orchestration id —— sidecar 记录优先、`rg-channels/` 目录名兜底，再判定这个 id 能否被本会话采用）与**归档**（归档文件名、归档载荷、确认框文案）。两条拒绝路径（`orchestrator_plan` 的 write/submit、`orchestrator_spawn`）与两个入口（`orchestrator_attach`、`orchestrator_plan action:archive`）共用同一份判定；纯函数 + 注入式读盘 |
| `orchestrator-tmux.ts` | **全仓唯一的 tmux runner 契约** `TmuxRunner` / `TmuxRunResult`（各模块注入的都是它；宿主实现只有 `orchestrator-wiring.ts` 的 `runTmux`，扩展里的 `runTmux` 只是绑定声明的薄包装）。仅剩的 tmux 命令构造：开/关 pane（接力）、列 pane，加上 pane 装饰（颜色 `select-pane -P`、标题 `set -p -t <pane> @rg_label <标题>`——`PANE_LABEL_OPTION` 就拼在这里，pi 不写这个命名空间，所以写一次不会被覆盖；以及 window 级 `setw pane-border-*`，一律不带 `-g`）；子会话 env 的剥离（`envCommand` + `GATE_ENV_NAMES`）。门禁**自己那个 session** 的建/关/归属/env/展示名 argv 在 `tmux-session-argv.ts`（2026-09-26 按职责拆出，同样经本模块的安全闸门）。**没有 send-keys，没有 capture-pane，也没有窗口几何/等分**（三列布局的规划/探测/等分连同它们的标识符于 2026-09-25 整块删除，本仓不再出现）。**安全闸门**：`kill-server` 任何情况都拒；首位全局 flag 直接拒；`new-session` / `new-window` / `kill-window` / `kill-session` 只在调用方显式声明了自己可寻址的 session 集合、且 argv 自己的目标就在其中（`<name>` 或 `<name>:@id`，别名同样归一）时放行 |
| `orchestrator-tool-kit.ts` | 编排工具的共用前置：模式校验、pane 实况、plan 可用性；以及**投递核实**（`verifyDeliveryOn` 按通道路径盯到第一份证据为止，`verifyDelivery` 是编排侧入口、`verifyJudgeBoot` 是 judge 侧入口——judge 的通道跨 pane 长存，所以它带一条 `baselineRecordCount` 水位线）；探测节奏默认是**退避**（`deliveryVerifyDelayMs`，从 100ms 倍增到 1s 封顶：固定 1s 会把每一次成功的投递都量化成整秒，而等的人是被阻塞在工具调用里的项目经理），显式传 `intervalMs` 的调用方保持旧的等间隔节奏。边框标题的刷新调度在这里，真正写标题的是 `session-factory.ts` |
| `orchestrator-tools.ts` | `orchestrator_plan` 工具的注册（schema + 说明），不碰 tmux |
| `orchestrator-plan-action.ts` | `orchestrator_plan` 各 action（read / write / submit / set-status / add- & resolve-decision / archive）的状态机：身份守卫、批准平移/撤销、审计+用户批准、归档 |
| `orchestrator-plan-messages.ts` | plan 批准框的文案：标题、批准行、transcript 全文回显与对话框正文 |
| `orchestrator-wait.ts` | 「有事发生」对编排子会话意味着什么（等待判据），以及那份五块回执的装配 |
| `orchestrator-wiring.ts` | 编排层与真实机器的接线：跑 tmux、读写 plan、持有本编排唯一的通道 IO 与监督记忆；`resolveTaskRepo` 默认实现用 git 的 `--show-toplevel` 把任务声明的 repo 解析成仓库根（子目录/符号链接路径都归一） |
| `parallel-review.ts` | 审查契约：一轮一个 reviewer、判不可变的 `baseline..HEAD`，以及交给它的任务文本。2026-09-10 起任务文本里还带 **CHANGE INDEX**（`formatChangeIndex`）：逐文件 numstat + 门禁预先分好的读取批次（`planChangeBatches` 贪心装箱，大文件单独成批）—— 实测 reviewer 的 92.5% 往返只发 1 个工具调用、单轮 17–59 次往返，而工具执行只占那一轮的 6%，代价在**消息条数**不在读多少 |
| `quality-round.ts` | **质量轮的判定半边**（2026-09-15 用户要求；2026-09-16 改为与功能轮**同一轮并行**）：`qualityRoundSkip` 回答「这轮有代码可审吗」（**排除法**——只列文档/数据/锁文件扩展名，未知即当代码，因为门禁装在 Node/前端/Rust/Shell/Python/midway 各类仓库上）；`qualityStandingFor` 回答「这个 HEAD 上有没有已成立的质量结论」（质量 READY **绑当前 HEAD**；跳过记录（`skipped`）只在质量环节此刻关着时或本轮无代码时成立 —— 开关一打开它就不再是结论（2026-09-22），其余一律 fail-closed）；`decideQualityHold` / `qualityPrecondition` 回答「功能轮的结论现在能记吗」（结论到位 ⇒ record，本轮质量 judge 还能交卷 ⇒ **扣下**，没人会再回来 ⇒ refuse——与 `unverified-idle` 同一条规矩）；`roundCancelPlan` 是**取消矩阵**的纯表（质量轮非 READY ⇒ 停 reviewer + lane；reviewer 非 READY ⇒ 停质量轮 + lane；lane FAIL ⇒ 只停 reviewer）。`buildQualityAuditTask` 是质量轮的任务书（**不是** `buildReviewPrompt`，那份属于功能轮）。判定表是 `docs/code-quality-rules.md`（唯一实质出处），本模块不复制其中任一条。**路由本身不是本模块的一个函数**：《本轮有没有代码》+《这个 HEAD 有没有已成立的质量结论》两个判定在 `lib/review-chain.ts` 的 `submitForReview` 里组合成三路（跳 / 已有 PASS / 两轮一起派），那里只有接线，判定一个字没重写 |
| `review-adjudicate.ts`（扣下半边） | **一个被扣下的 READY 什么时候复活**：`parkedLaneHalf`（lane 那一半）+ `qualityPrecondition`（质量轮那一半）+ `parkedReadyFate`（两半合成 none/hold/clear/replay）。两个前提**落地顺序任意**，所以结论只能由**两半的状态**算出来，不能由「谁先落地」算出来——扩展的 `resumeParkedReady` 是唯一执行者（lane 落地 / 质量轮记录落地 / settle 扫描三处都调它） |
| `polish-gate.ts` | 连续 READY 或同一文件反复打磨时，再审必须给出理由 |
| `poll-wait.ts` | 通用等待骨架（探测、发布、按判据或预算停），判据由调用方注入 |
| `precommit-parse.ts` | precommit 输出解析：只认 `## Overall:` sentinel（FAIL > NO_CHECKS_RUN > PASS，FAIL 终结）。review 侧没有文本可解析——judge 交卷即结构化 |
| `precommit-receipt.ts` | precommit 回执的纯校验：真 PASS/FAIL 还是协议错误 |
| `precommit-tail.ts` | precommit runner 日志的实时 tail（runner 走文件而非管道） |
| `precommit-lane.ts` | **与审查并行的全量 precommit lane**（t7 从扩展拆出）：唯一的在跑 lane（`precommitLaneRunning` 是它对外唯一的读法）、`abortPrecommitLane`、`waitForQuietLane`（一次只跑本轮的那一条）、`startPrecommitBeside`（落地时写覆盖记录、走取消矩阵的 lane 行、重问挂起的 READY）与 `steer` 通知 |
| `precommit-runner.ts` | 可信 precommit runner 的**启动器**（t5 从扩展拆出）：按包布局找 `scripts/precommit-runner.mjs`、argv 异步 detached 启动、私有 nonce + 回执、abort/超时杀进程组、日志落 repo 根 `.pi/precommit-last.log`（尾部截断），只信 nonce 匹配的回执 |
| `progress-stream.ts` | 长耗时门禁工具的实时进度输出 |
| `project-config.ts` | 每项目门禁配置 `.pi/review-gate.json` 的解析与层叠 |
| `repo-facts.ts` | 门禁读仓库的 **git 事实纯函数**（t5 从扩展拆出）：`commitsAheadOfBase`（唯一实现，同步；异步 seam 只包一层）、`currentBranch`（rebase 中读回落分支）、`listedWorktreeBranch`、`headCommitTree` / `worktreeTree` / `hasStagedChanges` / `unreviewedTreesSince`、`digestForMerge`、`samePlace` / `canonicalPath` |
| `repo-pr-policy.ts` | **同一 repo 一个需求只出一个 PR**（2026-09-15，用户决定）**+ 验收任务豁免**（2026-09-18；2026-09-22 拆成两环）：纯规则 —— 一个 repo 的任务数 ≥2 且未列进 `allowMultiplePrs` ⇒ 该 repo 里**除 plan 最后一环（独立验收任务）以外**的任务收窄为 `commit`（`effectiveTaskStation`：按**任务**回答，不是按 repo），子会话提交完就停、由倒数第二个收尾任务汇合、由最后一个验收任务统一交付（实测反例：同一 repo 三个任务开了三个 PR；实测事故：连最后一环一起收窄 ⇒ 没有任何一方能开 PR）。`acceptanceTaskId`（独立验收任务 = plan 顺序的**最后一个**任务：位置约定，不是新字段；2026-09-22 从 `finishTaskId` 改名 —— 收尾任务现在是倒数第二个，名字必须说清它回答的是验收 gate；t2-round 用同一判定）、`narrowedRepoStations`（`taskIds` 是全部任务，含验收任务）/ `narrowedRepoLines`（批准对话框、plan 摘要与任务书渲染）、`narrowingReasonFor`（任务书的「上界原因」，验收任务为 `undefined`）、`capStationAt`（子会话 goal 协商的上界）、`STATION_CAP_ENV`（上界跨进程走环境变量 —— 那是 agent 提示词写不进去的通道；spawn / `orchestrator_recover` / `session_handoff` 接力三条路径都注入，**一个重开的子会话不该比它第一次启动时能做更多**）；无 fs、无时钟 |
| `repo-resolve.ts` | 多仓解析：裁决绑定到编辑真正发生的那个仓库 |
| `restatement.ts` | L8a 需求反述：记录（正文 + hash + 时间 + 站点，落 gate-state 而非工作区）、内容最小校验（长度 + 必须有「改之前 → 改之后」对照，接受的写法在导出的 `RESTATEMENT_CONTRAST_TOKENS` 数组里）、两处拒绝文案（含可照抄骨架，以及**真走得通的**误判出路：`ask_user` 交给用户 / `/gate-mode` 换模式——**不指向 `request_arbitration`**，工具拒绝不产生可申诉记录，去申诉只会被回绝或误裁到别的拦截并白烧配额）、确认框文案，以及工具 `propose_restatement` 的唯一注册入口 |
| `review-baseline.ts` | 审查基线解析：链被 squash/rebase 后按内容找回基线 |
| `review-adjudicate.ts` | reviewer 裁决（纯）：在 judge 交上来的结构化结论上判 READY 携带未解决 P0/P1 → BLOCKED、findings 计数、跨轮 coarse fingerprint；另有 verdict 规范化与两个投影（per-file 给 polish gate、severity+issue 给 goal/plan 审计） |
| `review-prepare-tools.ts` | **内部实现**（不注册给 pi）：算不可变的 `baseline..HEAD`（起点是**最后一个产生过结论的 commit** —— READY 或 BLOCKED 都算；这个分支从未有过结论时用**分支基点**，绝不回退到「最新 checkpoint 的 parent」—— 那条回退会让一段没有结论的内容永久出局，2026-09-16 实测）、polish gate、findings 流，并登记裁决要绑定的 review target；由 `judge_submit` 调用。**一次 `git diff --numstat` 同时回答「哪些文件动了」与「动了多少」**（失败才回落到 `--name-only`），结果渲染成 reviewer 任务文本里的 CHANGE INDEX（`parallel-review.ts`） |
| `review-chain.ts` | **送审链**（t7 从扩展拆出）：`submitForReview`（precommit lane → checkpoint → prepare → 路由：跳质量轮 / 已有 PASS / 两轮一起派，环节开关在这里读一次）与两个阻塞审计 `runGoalAudit` / `runPlanAudit`（都走 `audit-round.ts` 的 `runAuditRound`）；每一步都调工具自己的实现（`callTool`），不复制 |
| `review-carryover.ts` | **增量审查契约的唯一权威出处**：把「上轮裁决 → 未关闭 findings → 机械算出的 delta → 一致性扫描与可重开条款」渲染成任务书里的 `Review scope for this round` 块；构建器收显式入参（裁决/findings/delta/全量-增量决策），没有 `ReviewScopeDecision` 也能调；两行判定标记同时是 judge 侧读回全量/增量的线格式 |
| `review-scope.ts` | 增量审查定档（只决策、不出文案）：**两类前置** —— 关于增量的（多大就升级成整轮深审、是否触及未审过的文件），以及关于**读者**的（2026-09-06）：只有 transcript 确实续用的 judge 才配拿增量任务书，判定由 `judge-rotation.ts` 的 `judgeRemembersPreviousRound` 给，本模块只消费。缺任何一项即 `full`，增量从不靠推断 |
| `review-stream.ts` | findings 流：reviewer 边审边发，主会话边修 |
| `round-cancel-host.ts` | **取消矩阵的执行面与挂起 READY 的重问**（t7 从扩展拆出）：`cancelJudgeRound`（真杀 pane + 删登记 + 回收 scratch）、`applyCancelPlan`（矩阵三行共用的唯一执行点）、`applyRoundCancel`（judge 结算那一行，挂起的结论不取消任何东西）、`resumeParkedReady`（按两个前提的状态决定 clear / replay）；表与判定在 `quality-round.ts` / `review-adjudicate.ts` |
| `round-cancel-ledger.ts` | **每个 repo+role 最近一次被取消的轮次（墓碑，只在进程内）**：`cancelJudgeRound` 写、dispatch 开始时清；`judge_wait` 找不到登记行时、dispatch 的 boot 校验失败时读它 —— 两处对「本轮被取消」说同一句话（原因 + 下一步） |
| `review-target-host.ts` | 一轮 reviewer 的 **review target**（t6 从扩展拆出）：`ReviewTarget`（`baseline..HEAD` + tree + 派发范围 + 改动文件 + 本轮派出的质量 judge）、`noteQualityRoundDispatched`、`qualityRoundInFlight`（本轮质量 judge 还能不能交卷：本轮派过 + pane 活着 + 没有非 SKIP 的裁决站在这个 head 上）；活性读 `judge-registry-host.ts` 的 `ownLiveJudges` |
| `sensitive-grant.ts` | 敏感文件的一次性用户授权：限定路径、限时、用后即焚 |
| `session-handoff.ts` | **唯一的会话交接策略**（2026-09-14，用户决定）：阈值 `HANDOFF_PERCENT = 70`（orchestrator 的 80/90 与 judge 的 60 三个数字合并成一个）、`handoffDue`（读数缺失**不提醒**——用缺失信息报警会训练读者忽略它）、`buildHandoffDoc`（骨架：契约 / 未完成工作 / transcript 指针 + 明确标为「自述」的 agent 补充段）、`handoffAccepted`（接手判据：**读过交接文档 且** 有过一次成功工具调用，两条同时成立——只跑命令不算，这正是用户同意的形状）；2026-09-26 空白交接事故后加：`lastUserMessages` / `withRecentUserMessages`（文档带前任最后 3 条用户消息原文，每次交接调用时刷新）、`successorDoneRefusal`（接任者首次 `declare_done` 拒一次，贴出那几条消息要求核对）。纯函数 |
| `sibling-verdict-host.ts` | review 记录器的**两个兄弟**（t7 从扩展拆出）：`recordQualityVerdict`（质量 standing，绑 HEAD，无 precommit 绑定）与 `recordAcceptanceVerdict`（绑派发时的工作区指纹，陈旧即 BLOCKED）；与 `verdict-host.ts` 共用裁决与 cwd 检查，刻意不共用 helper |
| `session-host.ts` | 扩展闭包与拆出模块之间的 **seam（只有类型）**（t5）：`SessionHost` 的访问器 `state()` / `stateFor(root)` / `persist()` / `persistRepo()` / `repos()` / `ctx()` / `log()` —— 每次调用现读，因为闭包里的 `state` / 根目录 / `latestCtx` 都会被重新赋值；模块要**写**的可变量用 `Ref<T>`（`{ current }` 句柄）注入；t7 起还带链上要用的 `CallTool` / `GateToolResult`（扩展的 `callTool` 的形状） |
| `session-handoff-tools.ts` | 两个工具（无参数、全会话共用）：`session_handoff()` 写骨架文档 →（非 judge 会话补充段仍是占位 ⇒ 拒绝、不开 pane；judge 没有 edit/write 所以豁免）→ 开新 pane（argv 第一条消息就指向文档——这正是旧路径缺的那一步）→ 记录交接 → 老会话退位；开 pane 失败或抛异常则回滚占用。judge 分支：judge **自己**在旁边的 pane 开新一代（派生 id）并把新 id 写回登记表（opener 的 settle 重读后读到新通道）。`context_status()` 把门禁自己每轮都在量的上下文读数（tokens / 窗口 / 百分比 + 70% 阈值判定）交给会话本人——agent 无法访问 `ctx.getContextUsage()`，不提供工具就只会靠感觉估（2026-09-14 实测：一个会话整轮按 35.8% 的上下文做了“快满了”的预算） |
| `session-inheritance.ts` | 后继者继承什么：`successorEnv`（前任 pane / 交接文档 / 前任 transcript / **前任 session id**（接管 worktree 占用的继任凭据）/ kind）、`readInheritance`、`formatInheritanceBrief`（明说「门禁会自动关掉前任」——旧 brief 让新会话自己调 `orchestrator_close`，那正是两个会话互相干等的根因）、`successorSessionId` / `handoffGeneration`（`-h1`/`-h2` 链式派生，接力历史写在 id 里）、`isHandoffChainOf`（某 id 是否为根 id 本身或其继任者 —— 子会话通道的写侧绑定与读侧主人过滤共用） |
| `session-name-tools.ts` | **`name_session` 与命名的四步生命周期**（2026-09-25 用户决定）：取一个全局唯一的名字 → 写 window title + window 级 user option `@rg_session_name` → 心跳续期 → 释放。工具与生命周期本体都在这里（判定与分类全在 `session-registry.ts`），扩展只接线：`register(pi)`、`session_start` 的 `onSessionStart()`（接管自己的登记 + 扫孤儿）、按 `heartbeatMs` 装定时器调 `tick()`、`declare_done` 与 `session_shutdown`（**非 `reload`** 时）与模块作用域那一个进程 `exit` 钩子调 `release()`（`/new`、`/resume`、`/fork` 会换 session id 而 pane/pid 不变，不释放就会留下永远被判 `live` 的登记）。改名是「先腾旧名、再占新名」，旧名腾不出来就**拒绝改名**（否则同一个 session id 会留下两份登记，而它看起来永远是活的）。`liveSessionNames()` 给 t3 的发送侧用：只列活着的，读不出的单独报出来 |
| `session-orphan-sweep.ts` | **回收死会话留下的东西**（2026-09-25，t2）：会话启动时扫一遍注册表，只对「心跳过期 + pid 不在 + pane 不在」的条目动手 —— 先比对它自己那份 `scopeSession` 的 `@rg_scope_owner` 标记等于该条目的 sessionId（**标记读与 kill 走同一条 tmux 名字解析**；tmux 3.7c 实测无精确命中时 `-t` 会回落成前缀匹配，所以杀的前提是「刚读到「标记是死者的」，而不是名字长得像），然后把登记**先改名移开再删**（期间被重新登记的会被识别出来并放回去），**死者的邮件也不删**（2026-09-25，reviewer P1 两轮）：撤下登记就是原子地释放名字，而新会话可以在「撤名之后、任何清理之前」抢到它并收到信 —— 重读登记（CAS）只能把窗口缩小、不能消除（要消除就得让名字与邮件同处一个原子单元，那要改 t2 的路径约定）。所以邮件留在原地：没人持有的名字不会再收到新邮件（发送侧要求收件人活着），下一个取这个名字的会话读它时跳过不属于自己的那些，文件的空间也在那一刻回收；没人再取就只是一堆伤不了人的死文件。专属 session 已经不在了不是错误：靠 server 自己的名字列表区分「已消失」与「读不到」，前者照样清登记。与注册表分居两个模块：注册表只读一个名字，回收要杀别人留下的 session。任一事实读不到一律 fail-closed（`SweepReport.kept` 里点名理由）。**未命名会话的专属 session**（2026-09-27）：注册表那一段之后，`sweepUnnamedScopes` 列出 server 上所有 `rg-…` session，只在「名字正是其 `@rg_scope_owner` 推导出的（`scopeNameOwnedBy`，跨 repo）+ owner 不是本会话、也不属于任何命名登记 + 创建时写下的 `@rg_scope_owner_pid` 进程不在 + `@rg_scope_owner_pane` 不在 pane 列表」全部成立时 kill；缺任一事实（旧版本建的）即不动（`SweepReport.scopes`）。本会话自己的那份用本进程 pid/pane 刷新。**铉住（`@rg_scope_pinned`）的不动**：交接前（`openSessionWindow` 的 successor 分支）与开编排子会话 window 时写入 —— 那两种 session 的 owner 死了是预期状态（后继 / `orchestrator_attach` 继承里面的 window）；每次回收都进 `notes`（启动日志） |
| `session-message-tools.ts` | **会话间的 `@名字` 消息**（2026-09-25，t3）：`send_message({to, text})` 按 t2 的注册表找到活会话，把消息写进对方的 inbox（`~/.pi/agent/rg-sessions/<名字>.inbox.jsonl`），对方门禁在自己的轮询里读到后用 `pi.sendUserMessage(text, {deliverAs:"steer"})` 注入成一条标明「来自 @谁」的 user 消息 —— **不中止对方当前的 turn**（`steer` 在 streaming 时排队到当前助手回合的工具调用之后，idle 时开新 turn；`followUp` 不用，那个队列只在会话停下来时才排空，而 loop 会话不被允许停）。发送侧判定全在这里：`@` 前缀可省、未命名会话**不能发**（回执教它 `name_session`）、名字非法 / 不存在 / 对方 dead 或 unknown / 发给自己一律拒绝并把**当前活着的会话名**列进回执（“谁还活着”的判定唯一出处是 t2 的 `liveSessionNames()`，这里不写第二份）。写盘复用 `channel-io.ts` 的同一约定（单次 `O_APPEND` 一行、超 `MAX_INLINE_RECORD_BYTES` 先 spill 到 side file 再写引用），路径复用 `session-registry.ts` 的 `sessionInboxPath`（取件名 `<inbox>.taken` 从它派生）。消费是**取件（rename）而不是读后清空**：读-清空之间的窗口会把并发 append 的消息抹掉，而 rename 之后新消息只会落到新文件上；注入失败时未注入的尾部（含失败那条）写回取件文件，下次 tick 继续，已注入的不重放。所有会话（loop / PM / 子会话 / judge / worker）都注册这个工具、都收消息；扩展只接线两处（`register(pi)` + 把 `drain()` 挂在 t2 已有的命名心跳定时器里，不新增第二个心跳）。它替换的是“会话之间只能靠人转述 / 手写 tmux”，**结构化通道一行不动** |
| `session-registry.ts` | **全局会话注册表**（2026-09-25 用户决定）：`~/.pi/agent/rg-sessions/<名字>.json`，每名字一个文件（并发写落不同文件，一个名字的写坏了不牵连别人；唯一性由文件系统回答）。名字形状（kebab-case、2–32）、原子占用（**空位靠 `O_EXCL` 创建、接管靠 `rename(2)` 把死条目移开** —— 两个进程同时看到同一个空位/同一个死名字时只能一个赢）、占用者三分类 `live`/`dead`/`unknown`（心跳 30s 续、>180s 算陈旧，且必须 pid 不在 **且** pane 不在才判 dead；任一事实读不到即 unknown；而 pane 只在**铸它的那个 tmux server 上**有意义 —— 登记里记着 `server`（`<socket>,<pid>`），与当前 server 已知不同时 pane 判定作废，复用的 pane id 不会把死者的名字永远占住，`paneIdUsable` 是唯一判定，2026-09-25 t4 整体审核 P1）、续期/释放（只删自己的；**释放只删登记、不碰 mail** —— 撤下名字是原子的，新会话随时可以接管并收到信，此时清它会导致跨会话丢信，t3 的 reviewer P1 两轮都打在这里），以及 inbox 的路径约定 `<名字>.inbox.jsonl` 与消费中停放的 `.taken`（t3 用）。**没有「清理一个名字的邮件」这个函数**：它的两个候选调用点（release 与 sweep）都是同一个竞态，而输家的代价永远是别人的消息，所以那个删除动作被移除了 —— 邮件改由「收件人=名字+当时的持有者 sessionId」定义（t3 的 `toSessionId`），接管者读到时跳过不属于自己的那些。tmux/文件系统/pid 都从注入的 seam 进，所以竞态与 fail-closed 分支都能单测。**回收死在另一个模块**：`session-orphan-sweep.ts` |
| `session-revival.ts` | 存活不变量（2026-08-30）：会话在退出契约未满足时停下，门禁就周期性唤醒它。纯判定：看不见续跑预算与 loop-stall 断路器（它们管注入路径，管不了「停下」），但尊重人的叫停（ESC / ask_user / bypass / 仲裁 pause）、handoff 交接，以及**已记录完成**（`state.completion`：`declare_done` 写、**任何 project 文件被编辑就删**（2026-09-22 把删除移出 code/doc 分支 —— 之前改 `.json`/`.yaml` 既不清它也不 armLoop，会话就卡在「不叫醒」与「ship 仍拦」之间），所以它一条就同时表示「契约已兑」与「此后没动过」；2026-09-22 加，此前人在同一 checkout 里的 merge / pull / checkout 会把已交付的会话叫回来复审） |
| `session-dir.ts` | pi 的 session-dir 编码约定，fresh-context 角色据此找到主会话 transcript |
| `session-exclusivity.ts` | 一个 worktree 只允许一个「占用主 sidecar」的会话：心跳存在文件（`.pi/session-presence.json`）判活，第二个占用者 fail-closed 拒绝——拦 edit/write、拦 ship、连门禁自己的 checkpoint 提交与 goal 文件写入一并拦（`normal` 模式除外：那个模式的定义就是门禁整体关闭，所以不发拒绝；它只在 worktree 空闲时写心跳，已被占用时既不拒绝也不写——凭据属于占用者）。judge、worker 与编排子会话因为不写主 sidecar 而天然豁免。**「谁不写主门禁状态」这条判定本身也住在这里**（`gateStateWriteSkip`，2026-09-21 从 `judge-side.ts` 搬入并补上 worker）：它与独占判定是同一个主题读两遍，分居两处的结果就是新增角色（worker）只被其中一处认出来 —— 现在 `claimsMainSidecar` 由它派生（写门禁状态 **且** 没有自己的 variant 文件才算占用），编排子会话是两个答案唯一不同的一档（它写，只是不写这个文件）。裁决输入只有**心跳新鲜度**（60s 窗，`PRESENCE_FRESH_MS`），`pid`/`host` 仅作诊断（这一点与 `blocked-marker.ts` 相同，**但两者的失败方向相反**）；一切未知（文件缺失/损坏/时钟异常/未来时间戳）一律 fail-**open** 放行——**只有一个正面事实（刚写的心跳）才能拒绝**，占用者消失后自动复检解除。2026-09-10 新增第二条放行：**继任关系** —— `session_handoff` 起的后继者带着前任的 session id（`RG_HANDOFF_PREDECESSOR_SESSION`），占用者 id 等于它即放行；该判定排在**新鲜度之前**，因为「前任还没来得及释放」正是它要覆盖的场景（实测：后继者被自己前任的心跳拒之门外，报「这个 worktree 已被另一个会话占用」后 pi 随即退出）。**它与 `blocked-marker.ts`、`judge-pane.ts` 的判活为什么不可收敛**：见本文件头与 `test/liveness-criteria.test.ts`（2026-09-06 复核） |
| `session-factory.ts` | **开一个带角色的 pi 会话的唯一入口**（2026-09-05）：一次 `openSessionWindow` 走完「开 → 登记 → 装饰 → 投递核实」，六个开子会话的调用点（judge 轮次派发 / `judge_spawn` / `judge_recover` / `orchestrator_spawn` / `orchestrator_recover` / `session_handoff`）全部经它。**落点是一个 window，不再是一个 pane**（2026-09-25 用户决定）：子会话是 opener 专属 tmux session 里的一个 window（`own-session-window`，session 名与懒建在 `session-tmux-scope.ts`），唯一仍 split 用户窗口的是接力后继者（`beside-opener`，`buildHandoffPaneArgv`）；三列布局的规划/探测/等分于同一轮整块**删除**。关窗是 `closeSessionWindow`（目标写成 `<session>:<window>`，所以一个过期 id 只能碰到门禁自己 session 里的 window），`closeSessionPane` 只为「接力前任关自己那个 pane」保留；env 由 `session-env.ts` 的 `buildSessionEnv` 拼（见下行），judge argv 与 judge/worker 装饰在 `session-launch-specs.ts`；装饰含 window 级边框行（judge pane 曾因此看不到边框 = C1；在 window 拓扑下那条边框设置在**子会话自己的 window** 上），标题刷新 `refreshSessionPaneTitle`（带节流与重绘记忆）与 `paintPaneTitle`（**无记忆无节流**，只给项目经理自己那个不带状态的 pane 用）是仅有的两处写标题处；**关窗不再动任何 window 选项**（2026-09-17：toggle `pane-border-status` 会让整窗每个 pane 少/多一行）；`paneRecoverability` 是两处 recover 共用的同一判定；`windowAlreadyGone` 是「一次 `kill-window` 失败的到底是已经不在还是 tmux 拒绝」的**唯一读法**（2026-09-25，t3 质量轮：`orchestrator_close` 与 `worker_close` 共用它 —— 后者曾经只有一个布尔，把「已经不在」报成关闭失败并把坐标永远留在登记里）。它与 `session-tmux-scope.ts` 是 `orchestrator-tmux.ts` / `tmux-session-argv.ts` 里开/关子会话 argv 构造的**全部**使用者 |
| `session-env.ts` | 门禁开的 pane **是什么**（2026-09-27 从 `session-factory.ts` 拆出）：`SessionPaneRole`（judge / orchestration-child / worker / successor）与 `buildSessionEnv` —— pane 环境变量**唯一**拼装处（`RG_JUDGE_*`、`TMPDIR` scratch 根、`RG_WORKER_*`、`RG_ORCHESTRATION_ID`/`RG_GATE_MODE`/`RG_STATE_VARIANT`/`RG_STATION_CAP`/`RG_ACCEPTANCE_GATE`）；这些都是跨进程契约，也是 session 独占豁免的依据，少一个 key 会让 pane 启动即被杀 |
| `session-launch-specs.ts` | judge / worker pane **用什么开**（2026-09-27 从 `session-factory.ts` 拆出）：`buildJudgePaneCommand` / `buildJudgeRecoverCommand`（只读 judge 的 pi argv，按 session id 续接）与 `judgePaneDecor` / `workerPaneDecor`（边框装饰，owner 取 opener 自己的身份）；真正开窗的是 `session-factory.ts` |
| `session-scope-exit.ts` | **非 `declare_done` 退出时关掉自己的专属 session**（2026-09-26，t4）：`session_shutdown`（非 reload）与进程 `exit` 都经 `closeOwnSessionOnExit` 调 `closeOwnSession`（标记校验不复制）。两种退出**不关**：已交接（后继要接管前任的 judge window）、项目经理还有未关闭的编排子会话（留给 `orchestrator_attach`）。此前只有 `declare_done` 关它，而启动孤儿清扫只遍历已命名登记，未命名会话 /quit 后 worker window 永远留着 |
| `session-tmux-scope.ts` | **本会话自己的 tmux session**（2026-09-25 用户决定）：名字**永远由本会话身份派生**（`rg-<repo slug>-<session id 随机尾>`，**取尾巴不取头** —— pi 的 id 是 UUIDv7，头是毫秒时间戳，同一分钟的会话前八位会一样）、**懒建**（`openScopeWindow`：首个子会话才建 session，且子会话自己的命令就是它的第一个 window，不留空壳 shell）、归属标记（session 级 user option `@rg_scope_owner`，复用与 kill 前都比对，对不上就既不接管也不杀），以及 `closeOwnSession`（`declare_done` 用它关掉自己建的那一个，幂等）。**sidecar 记录是事实而不是名字来源**（审查 P1）：只有记录与本会话派生结果**逐字段相符**（名字 = 我派生的、owner = 我的 session id）才被采信，否则视为“本会话没建过”的空操作 —— 手改或外来的记录因此既不能放宽执行器声明，也不能指使一次 kill。`list-sessions`/`list-panes -a` 读不到时一律「不知道」：不建也不杀。**可声明的 session 由标记证明**（2026-09-25 t4 整体审核 P1）：评判子会话的注册表行只当候选，每个候选要由 `createOwnershipProbe` 读 `@rg_scope_owner` 并确认「名字正是由该 owner 派生」才进声明 —— 此前只做形状检查，一份可写的注册表就能把声明放宽到别的会话的 session 上 |
| `status-strip.ts` | editor 下方**状态条**与 `/gate-contract` 契约读数的接线（t5 从扩展拆出）：廉价事实（`gateWidgetFacts`，不算指纹）、契约行与「为什么为空」同源（`contractReadout`）、内容变了才 `setWidget`、renderer 探针与一次性提示、5s 刷新定时器；纯渲染在 `ui-widget.ts` |
| `side-effects.ts` | 唯一一处「本进程能不能碰外部世界」的判定（测试 / CI / 无 TTY / 显式关闭一律不能），通知与编排共用 |
| `shell-lex.ts` | 最小的引号感知 shell 词法器，命令类判定的共同底座 |
| `ship-detect.ts` | 判断一条命令行是否含 ship 操作（git commit/push、gh pr create/edit）；另有 `observedShipKinds`——**证据侧唯一入口**：同一份检测既用来拦（过匹配安全）又被交付站点用来放行（过匹配就是白给一张 PR 通行证），所以证据只认「不含 heredoc（`containsHeredoc`）+ ship 动词就在该段命令头」的命令：读引号感知词法器的 token（引号里的脚本整体是一个 token），只跨过环境变量赋值与重定向，**不做 `normalizedTokens` 的 wrapper 前扫**（`sudo`/`env`/`timeout` 前扫对「拦」是 fail-closed、对「放行」却是 fail-open，实测 `timeout 60 node -e '…'` 会白给一张 pr-create）；代价是 `sudo git push` 不算证据，重跑一次不带 wrapper 即可。检测器本身**绝不**放松（那才是真绕过） |
| `ship-gate-hook.ts` | **L1 `tool_call` 钩子的入口**：`evaluateToolCall` 分派到两条臂，`ShipGateHookDeps` 汇总两条臂的 deps |
| `ship-gate-edit-guard.ts` | L1 的 **edit/write 臂**：敏感文件安全底线（`sensitiveEditBlock`，`normal` 模式也生效）、gate-owned 豁免、L8 目标门、orchestrator 写限制、L6 标签检查；检查次序即契约 |
| `ship-gate-bash.ts` | L1 的 **bash 臂 = ship gate 本体**：tmux backstop、`/gate-bypass`、ship 识别、L5/AI 署名、message-only rewrite 豁免、逐 repo 门禁、**交付站点放行**（既有拦截全过之后再判这条命令是否在站点内，站点由 deps 注入、多 repo 取最严；message-only rewrite 同样豁免；站点拦截不吃仲裁令牌）、一次性仲裁令牌；依赖面（`ShipGateBashDeps` / `BlockedShipRecord`）在 `ship-gate-bash-deps.ts`，文案在 `ship-gate-copy.ts` |
| `ship-gate-bash-deps.ts` | L1 bash 臂注入的依赖面 `ShipGateBashDeps` 与 `request_arbitration` 申诉的拦截记录 `BlockedShipRecord` |
| `ship-gate-copy.ts` | L1 ship 门禁说出口的话（纯文本）：拦截文案（`describeShips` / `buildShipBlockReason`，站点与质量两半各带各的下一步）与唯一一条**只提示不拦截**的探测 `detectHandRolledWaitPolling`（`sleep ≥30s` + 读通道/findings 流 ⇒ 提示改用 `judge_wait`，经 deps 的 `hint` seam 投递、每会话去重） |

| `station-pr-evidence.ts` | 站点 `pr` 的**门禁侧事实采集**（2026-09-16，用户实测的死路：PR 早已开着、只往里追加提交时，`gh` 把「已经有了」当 ERROR 报，`shippedKinds` 永远记不上，`copilotReview` 关掉的仓库连 PR 号也解析不出来 —— 到站判定被逼成「关掉旧 PR 重开一个」）。`probeOpenPr(dir)` 让门禁自己问 GitHub（复用 `lib/copilot-gh.ts` 的 `resolveOpenPr`，只认 `state === "OPEN"` —— CLOSED/MERGED 与读不出的 state 一律不算）；`hasUnpushedCommits` 是另一条**纯本地**事实（`git rev-list --count @{upstream}..HEAD`；没有 upstream、不是仓库、读不出，全部算「没推」，因为读它的判定只会更严），由调用方对**每一条** `pr` 证据都量一次 —— 「有个 PR」不等于到站；`existingPrNotice` 是失败的 `gh pr create` 之后那条提示（给出 PR 号与 URL，明说往它追加提交、不要关掉重开）。纯判定留在 `lib/delivery-station.ts`，跑进程的事在这里 |
| `task-mode.ts` | 会话门禁模式模型：normal < explore < loop < orchestrator 与升降级规则 |
| `text-appeal.ts` | 启发式文本拦截的申诉口子（A 类） |
| `inspection-appeal.ts` | 第三类申诉口子：judge 被「零审查即 READY」拒掉后走 `request_arbitration`（judge 侧唯一被放行的工具），形状照抄 `text-appeal.ts`——受理判定（配额与本轮不可重掷共用一份额度）、仲裁者 system prompt 与 brief（申诉理由按不可信数据入块）、通行证只绑「本 judge + 本轮」，绝不放行任何命令 |
| `interrupt-delivery.ts` | **interrupt 投递的两步时序 + 本轮沉默的读数**（2026-09-21）。**第一件**：interrupt 的时序（实测缺陷：judge pane 正在跑时收到下一轮派发，正文进 steering 队列后永不 drain，两个审核卡死 552s）：`abort()` → 等 `isIdle()`（`INTERRUPT_IDLE_WAIT_MS = 3_000`，`INTERRUPT_POLL_MS = 50`）→ **不带 `deliverAs`** 投递（pi 的契约：非 streaming 时裸调用才会「立即发送并开启新 turn」）；**等不到 idle 就什么都不发**（返回 `deferred`，正文留在通道里由下一次 drain 重试）—— 退回 `steer` 排队**正是同一个死锁换顶帽子**。**第二件**：`roundLooksUnstarted` + `ROUND_SILENT_MS = 180_000` —— transcript 沉默超过阈值且本轮无 report 时报出的**读数**（不是结论）：judge_wait 的回执里点名 pane、阀值与三种可能，建议再等一等、确认没动静才 `judge_submit({ fresh: true })`，**门禁从不自动重派**；派发时刻（`JudgeEntry.spawnedAt`）是读数下限，否则复用 lane 上的新轮会被误报；**不去区分「在等人回答」**（试过，三轮审查找出三种让这个谓词永久失效的残留）：回执本来就把它写成三种可能之一。纯逻辑，sleep/时钟全注入 | `test/interrupt-delivery.test.ts` · `"the abort is requested FIRST, and the text waits for the pane to stop"` · `"a pane that never stops is DEFERRED — nothing is queued into the dead queue"` · `"a round that never touched its transcript LOOKS unstarted — and that is only a REPORT"` · `test/judge-session-tools.test.ts` · `"judge_wait reports a silent round as a READING"` | 顺序就是修复本身：先 abort、等到 pane 空闲、再裸调用投递 —— 反序或省掉等待就是那个死锁；等不到空闲**一个字节都不许发**；`deferred` 必须以 `stage: received` 回执；静默检测**只报读数不宣称结论**（长工具调用与等人回答会产生同样的读数），**绝不自动重派**；`extensions/review-gate.ts` 里不得再出现 `pi.sendUserMessage(interruptText, { deliverAs: "steer" })` 的旧形态（源码扫描钉死） |
| `tmux-session-argv.ts` | 门禁**自己那个 tmux session** 的 argv（2026-09-26 从 `orchestrator-tmux.ts` 按职责拆出）：建 session / 开 window（`buildNewSessionArgv` / `buildNewWindowArgv`，env 经 `envCommand` 注入）、列 session、读/删 session env、归属标记 `@rg_scope_owner`（`SESSION_OWNER_OPTION`）、关 window（`<session>:<@id>`）/ 关 session、会话展示名（`SESSION_NAME_OPTION` + rename-window / `set -w` / 读自己坐标 `parseOwnCoords`）与 `parseSessionNames` / `parseSpawnedWindow`。每个 builder 仍以 `assertSafeTmuxArgv` 收尾——闸门没挪，挪的只是闸门后面的房间 |
| `tool-host.ts` | 每个 `lib/` 工具注册模块共用的 host 类型 seam（`orchestrator-deps.ts` 只是 re-export 它），以及全仓唯一一对工具返回值构造 `toolReply` / `toolFail`（2026-09-26 收拢：此前 7 个工具模块与 `orchestrator-tool-kit.ts` 各有一份拷贝） |
| `ui-widget.ts` | 会话自我展示的两块文本的纯构造（**不是两个 widget**，见下）：① editor 下方那条**单行**状态条（详情在 `/gate-status`）—— mode / 分支 / 已编辑 / **送审轮次 `轮 N`**（2026-09-17 用户决定：N 是本会话**送出去**的 reviewer 轮次 —— 送审即 +1，不等 reviewer 交卷，`declare_done` 不清零；数据源 loop 侧是 `state.sentReviewRounds`、judge pane 侧是它自己的 `roundSeq`，**无分母**，那个 `/maxRounds` 是 auto-loop 刹车、与审查进度不同源；只有 loop 会话与 judge pane 显示，判定是 `showsRoundReading` 这一条纯函数；零 git 开销）/ 未满足项数；② `buildContractLines` + `planContractRows` —— **按需**的契约清单，由 `/gate-contract` 命令打印（2026-09-18 用户决定：不常驻）。项目经理一侧把 plan 任务渲染成四态（`○`pending `▸`running `✓`done `✕`blocked，blocked 后缀「等 tN」只列未完成的依赖）；loop 会话与编排子会话一侧显示已批准 goal 的退出标准（**永远 `○`**：findings 结构里没有 criterion 索引，任何 `✓` 都是假报进度）。条目**原样上屏**，唯一的机械处理是 `plainMarkdown` 剔掉终端渲染不了的 `**`/`__`（本仓 48 份 goal 的 310 条里 122 行带成对星号）。**没住过屏幕，所以不需要省屏**：不截断、不折叠、不上色（`notify` 只能给整块一色），40 条就出 41 行。上一版做过常驻 aboveEditor，连带 `fitToWidth`/`displayWidth`/`charColumns`/`CONTRACT_MAX_ROWS`/`ContractTheme` 与 `declare_done` 专用的 `contractDelivered` 标记一起整条删除（哲学三：不留旧路径、不留开关）。空清单只表示「这个会话不持有一份这种形状的契约」，**为什么**由扩展侧的 `contractFacts` 一处判定（它把「哪种空情形」与「叫什么」一起回答）；`buildContractReadout(facts, absent)`（2026-09-19）把「**空清单必带理由**」做成不变量 —— 调用方的理由优先，否则给「这份契约里没有可显示的内容（条目都是空白）」—— 于是 `/gate-contract` 的兜底文案再也不会把「有契约但渲染不出内容」说成「不持有一份契约」。与状态条同一条纪律：**display-only** —— 零 git、不算 fingerprint，任何判定都不看它 |
| `untrusted-data.ts` | 主会话/编排层文本的**唯一**降级实现：`asUntrustedData` 包块（命名 tag、载荷内闭合标签中和、截断可见）+ `composeWithUntrustedData` 组装（门禁指令在前、不可信数据块在后），judge 四处任务书拼装点与仲裁/文本申诉/分类器提示词共用 |
| `user-interaction-tools.ts` | 工具 `ask_user`（采访的执行侧：暂停循环、逐题落盘、双方抢答），并且是「用户交互工具族」的**唯一注册入口**（自己转注册 `consent-request-tools.ts`） |
| `workflow-commands.ts` | 工作流命令的定义与提示词组装，含 `--execute` 授权字的严格解析 |
| `worker-pane.ts` | **worker 的注册表与 resume 键**（2026-09-21）：`workerSessionId(workerId)` 确定性派生 pi 的 `--session-id`（同名即同一会话，关掉再派就是续接），`.pi/worker-sessions.json` 记 `paneId`/`sessionId`/`role`/`model`/`reportedAt`（写与读各一份实现，逐条 fail-closed：畸形条目丢弃而不是修成一个「大概是这个 pane」的猜测——猜错会让 `worker_close` 去杀别人的会话）；`buildWorkerPaneCommand` 与 judge pane 同形：都是 `--exclude-tools edit,write`（2026-09-22 用户决定把 `bash` 从 deny list 拿掉 —— 跑不了 `git log`/`rg`/测试的 worker 取不了证；它能落笔这件事改由提示词的只读约束 + 门禁自己的 ship 硬拦守） | `test/worker-tools.test.ts` · `"a worker pane is READ-ONLY by its tool surface, and resumes by session id"` · `"close frees the pane and the next submit RESUMES the same session"` · `"the registry drops a malformed entry instead of guessing a pane"` | 会话 id 必须由 worker id 派生（换名字就换会话）；写工具靠工具面排掉（`--exclude-tools edit,write`），bash 的只读约束靠提示词 + ship 硬拦；关闭后再派必须用**同一个** session id（否则「省屏」变成「丢上下文」）；指令/任务书走 `@file` 与通道，不上命令行 |
| `worker-side.ts` | **worker pane 自己那一侧**（2026-09-21）：`RG_WORKER_OPENER` / `RG_WORKER_ID` / `RG_WORKER_ROLE` 三个环境变量（缺任一即「不是 worker pane」——半配置的 pane 绝不能绑定别人的通道）；`buildWorkerSystemPrompt`（配置的 `prompt` 在前、不可协商的只读/自包含/证据/只交一次在后）与任务书；`worker_report` 是**只在 worker 面注册**的工具（主会话拿到它就能伪造 worker 的答案），一条 `kind:"report"` 记录、文本走 `summary` 字段（`appendRecord` 会按体积外溢到旁文件） | `test/worker-tools.test.ts` · `"the system prompt the pane runs carries the preset's own words"` · `test/worker-tools.test.ts` · `"worker_wait returns the report, and does not deliver the same one twice"` | 三个 env 缺一即不绑定通道；`worker_report` 只在 worker 面（注册即守卫）；报告只有一条记录、文本自包含；额外工具一律不等 |
| `worker-channel.ts` | worker 工具共用的事实：通道位置（`workerChannelTarget`，已存在的 worker 以登记为准）、通道投影 `projectWorkerChannel`、pane 归属 `paneIsOurs` / `ownedPaneAlive`、`nextWorkerId`、预设解析 `resolveWorkerRole` |
| `worker-submit.ts` | `worker_submit` 的实现：活 pane 追加消息并等注入确认、死 pane 同 session id 重开（`openWorkerPane`） |
| `worker-tools.ts` | **worker 家的四个工具**（注册与 wait / answer / close 在此；submit 与共用事实见上两行）（2026-09-21，取代 `npm:@tintinweb/pi-subagents`）：`worker_submit`（活着的 pane 收到的是**消息**而不是第二个 worker，死掉的 pane 用**同一 session id** 重开）/ `worker_wait`（消息驱动，返回 report 或它卡住的提问；同一条 report 不重复交付；等待走 `poll-wait.ts` 的 `pollUntil` 并接住 `execute` 的 `signal`，所以 ESC / 用户说话立即返回，且**不推进报告游标**）/ `worker_answer`（选项原文、序号或唯一子串；歧义直接拒而不猜）/ `worker_close`（放掉 pane，transcript 留着）；`resolveWorkerRole` 从 `~/.pi/review-gate.json` 的 `agents` 段解析预设（缺配置 fail-closed，`model` 可临时覆盖链首但绝不越过「必须配置」）；依赖全注入（tmux/文件/时钟/通道），所以整套协议在无 pane 的测试里跑完；pane 也和 judge 一样被装饰（`workerPaneDecor`，label = `<workerId>@<owner>`，owner 走 `paneOwner()` seam） | `test/worker-tools.test.ts`（17 条，覆盖四个工具、resume、注册表解析、投影）· `test/templates.test.ts` 的同族断言 | 没有配置就拒绝派活（不许静默用别的模型）；`workerId` 合法字符集 `[a-z0-9][a-z0-9-]{0,40}`（它同时是文件名、pane 标题与 session id）；活 pane ⇒ 追加消息、死 pane ⇒ 同 id 重开；关掉不丢上下文 |
| `workspace-branch.ts` | 保护分支检测（main/master/dev/develop）：checkpoint 与 ship 一律拒绝（2026-09-07 起 `setup_workspace`/工作分支/squash 落地全部退役，只剩这个硬护栏；2026-09-16 起 checkpoint 不再弹确认框，直接拒） |
| `verdict-host.ts` | **记录一轮 reviewer 裁决**（t7 从扩展拆出）：`recordReviewVerdict`（STALE 目标、验证绑定、cwd、扣下 vs 拒绝、tree 绑定、基线 commit、轮次记录、计时、自动循环解除）与三个记录器共用的 `scopeExemptionOf` |
| `worktree-presence-host.ts` | 一个 worktree 一个门禁会话的**会话侧**（t6 从扩展拆出）：presence 文件的心跳（`holdWorktree`）与退出时只删自己的凭据（`releaseWorktree`）、`applySessionExclusivity`（拒绝写进 state、按占用者去重告知、被拒会话的复查定时器）；判定在 `session-exclusivity.ts` |
| `worktree-changes.ts` | 工作区变更探测（列出「动了哪些路径、动了多少」，从不判门禁）：提示词用的廉价变更令牌 `advisoryChangeToken`、`changedFiles`、`incrementSinceTree`、`reviewCoverageFiles`；指纹本身在 `fingerprint.ts` |
| `worktree-seed.ts` | **隔离 checkout 的本地资源同步**（2026-09-15，onchain）：`git worktree add` 只复制 commit，`.pi/review-gate.json`、`.env`、`node_modules` 这些被 gitignore 的东西一律不在 —— 实测子会话读不到本仓 precommit 配置，test 步骤退化成包默认的 `yarn test`（midway 全量、143 文件失败，而改动只有 5 个文件）。清单分**复制**（`.pi/*.json` 配置与 `.pi/agents`，副本改不回主 checkout）与 **symlink**（`.env`、`.env.local`、`node_modules`，单一来源 + 不复制 GB 级目录），**每一条都要求 `git check-ignore` 确认被忽略**，否则跳过（未被忽略的路径带过去会污染 checkout 的 git status，而指纹、precommit 缓存与审查范围都读那棵树）；`.pi/` 运行态文件（state / cache / plan / tasks / judge-sessions）一律不带。`planWorktreeSeed`（纯）+ `seedWorktree`（IO，绝不抛，结果进 spawn 回执） |
| `session-cells.ts` | **会话的全部可变格子**（t8，2026-09-26）：扩展闭包里原来的几十个 `let` 聚成一个 `SessionCells` 对象（`createSessionCells`），外加三个跨模块共用的小动作 `armLoop`（重新武装并清掉仲裁暂停）/ `clearBypassToken` / `resetLoopBudget`。一个对象而不是每个变量一个 `Ref`：搬出去的工具体与生命周期处理体读写的是同一批格子，每个 deps 再列一遍就是第二份「共享哪个格子」的说法 |
| `session-restore-host.ts` | 会话的**持久化漏斗**（t8）：`persist`（每一次门禁状态写入都走它；judge / worker pane 与被拒会话不写、交棒后不写）、`restore`（新 session id 只继承编排注册表、接力后继者再继承 goal 契约，指纹迁移结果从 `loadSidecar` 收集）、`setTaskMode` 与 `/gate-reset` 的 `resetSessionState` |
| `session-repos-host.ts` | 会话的**多 repo 状态与审查范围**（t8）：`stateForRepo`（按 `stateOwnership` 加载次级 repo 的 sidecar）、`enforcementStateFor`（执行路径只信自己或前任的 sidecar）、`persistRepo`、`resolveToolRepo`、`repoRelative`（记录 repo 根相对路径）、`reviewScopeFor` / `settledConclusion`，以及 `copilotProblemsAcrossRepos`（`declare_done` 与 L2 读同一份按 repo 标注的 Copilot 清单） |
| `loop-goal-host.ts` | 会话对**契约**的读法（t8）：loop goal（按会话变体文件、`loopGoalConfirmed` / `goalStageSatisfied`、L8 编辑门 `loopGoalEditBlockFor`、给审查者的 goal 正文）、五个环节开关（`stageIsOn`、`ensureLoopStagesFor` 兜底弹框、`loopStageDeps` —— 清单框 `proxy: false`）与交付站点；规则都还在 `loop-goal.ts` / `loop-stages.ts` / `delivery-station.ts` |
| `judge-pane-self.ts` | **本进程作为 judge pane**（t8）：从任务文本里读回本轮范围 / 轮号 / 自有路径（`isJudgePane` / `judgeReviewScope` / `judgeOwnPaths`），以及只在 judge 面注册的 `judge_conclude` 与 pane 自己的模型自愈（`registerJudgeSide`，不是 judge pane 就什么都不注册） |
| `model-layers-host.ts` | 模型配置两层的**会话侧**（t8）：派发时读配置、每会话渲染一次两层 agent 文件（`ensureModelLayersRendered`）；规则在 `model-config.ts` |
| `handoff-host.ts` | `session_handoff` 的**会话侧接线**（t8）：两段式退休 `handoffRetirement`（先释放 worktree、落盘后才静默）、继任者环境 `handoffExtraEnv`、judge 接力请求、每轮交接提醒、`openSuccessor`；机械半边在 `session-handoff-tools.ts` |
| `orchestrator-worktree-host.ts` | 一个写者一个 checkout 的**执行侧**（t8）：`createWorktree`（带播种）与 `settleWorktree`（keep / merge / discard，分支按仓库自己的 worktree 列表 → 已记录 → 派生名依次取）；派生与计划在 `orchestrator-worktree.ts` |
| `arbitration-tool.ts` | `request_arbitration` 工具体与 **A 类文案拒绝的申诉账本**（`refuseText` 是附加申诉路径的唯一一处）（t8）；I/O 在 `arbitration-host.ts`，规则在 `arbitration.ts` / `text-appeal.ts` |
| `l2-continuation.ts` | **L2 自动续跑**（t8）：`onAgentSettled`（停止证明只在真正停下的出口发、托管 judge 等待、预算与断路器、RESUME 注入）、`onAgentEnd`（ESC 检测）、托管等待看门狗、战略重置清单 |
| `edit-tracking-hook.ts` | `tool_result` 的**编辑分支**（t8）：落地的编辑武装它所属 repo、记录本会话写过的每条路径、消耗敏感文件授权、任何文件都撤销完成记录；失败的编辑打开编辑纪律窗口并附 nudge |
| `tool-event-hooks.ts` | **工具事件钩子**（t8）：`tool_result` 分派（judge 检查证据先折叠 → 编辑 → 只读钻孔计数 → bash 分支的 re-arm / nudge / L7 武装）、`input`（用户真的说话了：解除 ESC 暂停、打断长等待、清掉 ask_user 暂停）、后台 agent 的两个终态信号、附在结果上的提示 |
| `checkpoint-tool.ts` | **内部实现** `review_checkpoint`（t8）：送审前的 checkpoint 提交 —— 保护分支拒、600 行新文件硬拦（merge 感知）、依赖论证、L5 英文、敏感路径、只提交本会话自己的新文件 |
| `precommit-tool.ts` | **内部实现** `run_precommit`（t8）：precommit PASS 的唯一来源，异步、可中止、按输入缓存；runner 在 `precommit-runner.ts` |
| `judge-submit-tool.ts` | `judge_submit` 的**注册与工具体**（t8）：角色校验（与枚举同源）、adviser / goal-auditor 任务组装、reviewer 走 `submitForReview` 链、并行两位 judge 的派发与「半轮不起」规则 |
| `judge-submit-receipt.ts` | `judge_submit` 的**两份回执文案**（t8）：没派任何 judge（环节全关）与逐个列出派出的 judge（每位一条 findings 流） |
| `judge-tools-wiring.ts` | 面向 agent 的 judge 工具（`judge_wait` / `judge_close` / `judge_spawn` …）的 **deps 装配**（t8）：从会话的注册表、lane 与 settle 路径建出来；读表时先丢死掉的外来条目 |
| `review-prepare-wiring.ts` | 三个内部 prepare 步骤的 **deps 装配**（t8）：`prepare_review` 的审查目标登记（登记即退掉上一轮扫下的 READY）与两个 advisory builder |
| `worker-wiring.ts` | worker 工具族的**会话侧接线**（t8）：哪个面注册哪些工具（派活工具只在 agent 面、`worker_report` 只在 worker 面）与会话的管道 |
| `declare-done-tool.ts` | `declare_done` 的**注册与工具体**（t8）：逐 repo 复检（编排模式只看 plan）、联关本 opener 的 judge（在飞的验收轮除外）、完成条件层（Copilot / goal / 站点）、真实验收、完成记录与收尾 |
| `gate-mode-tool.ts` | `set_gate_mode` 的**注册与工具体**（t8）：把事实交给 `task-mode.ts` 的 `evaluateModeChange`、降级确认框、orchestrator 前提（tmux、不是子会话）、同轮送达 goal 指令 |
| `session-lifecycle.ts` | **会话生命周期**（t8）：`session_start`（重导工作区、restore、非 git 短路、spawner 模式、arming、迁移提示、独占、名字接管）、`session_shutdown`（停掉本实例的每个时钟，非 reload 腾出名字）、`session_compact` |
| `turn-directive.ts` | **每轮的表面**（t8）：`before_agent_start`（L4 语言指令最先、各模式分支、环节开关块、goal 指令、编排提示、常驻决策表）、`turn_end`（心跳 + 单向对账）、思考空转熔断的消息钩子 |

---

## 六、动手前的四个自问

1. **它是判定还是接线？** 判定进 `lib/` 的纯模块（facts in, decision out）
   并配单测；只有把判定挂到事件上这一步才碰 `extensions/review-gate.ts`。
2. **它离开 pi 还必须成立吗？** 必须 → `hooks/` + `scripts/`（bash / CJS /
   MJS，不能 import TypeScript）；不必须 → `lib/`。
3. **它是新工具族吗？** 是 → 照 `lib/judge-session-tools.ts` 与
   `lib/orchestrator-*-tools.ts` 的形状：判定与工具注册都在 `lib/`，经
   `lib/tool-host.ts` 那道 seam 拿依赖，别再往扩展入口里加（它曾经就是这样长到七千余行的）。命令族
   同理，形状见 `lib/gate-command-tools.ts`（seam 是它自己的 `CommandHost`）。
4. **它测得动吗？** 同名 `test/foo.test.ts` 是常态；其余多数并进相邻的分组
   测试（`test/orchestrator-atoms.test.ts`、`test/orchestrator-tools.test.ts`、
   `test/extension-structure.test.ts`）。这里**不给计数、也不点名具体模块**
   ——上一版给了（一组「多少个模块里多少个有」的数字，外加两个被点名为
   「在 `test/` 下零引用」的模块），到 2026-09-05 复核时数字和点名**全部
   过期**，因为没有任何测试 pin 它们；同一份文档里 §五 的模块数一直是对的，
   区别只在于它有 `test/module-map.test.ts` 的双向差集看着。真正的判据也不是
   文件名对不对，而是**这条规则能不能被一个测试单独点名**——做不到，就说明它
   被埋在了工具体或接线里，`reviewer` 可以直接开 P1。

---

## 七、口径副本地图（改一处，还有哪几处要跟着改）

同一段口径——同一条规则、同一份清单、同一个数字——在这个仓库里常常有好几份
副本：权威实现一份，`AGENTS.md`、`README.md`、`QUICKSTART.md`、`docs/*.md`、
`agents/*.md` 的角色正文、`lib/*.ts` 里的提示词字符串各抄一份。**被测试 pin
住的那几对改错了会当轮红；没有 pin 的那些只会安静过期**——往往是在缺陷修好、
工具改名之后，悄悄从「说明」变成「误导」。

这张表回答的就是：**我改了这段口径，还有哪几处要跟着改、哪条测试会红。**

`test/copy-map.test.ts` 机械核对本节点名的每个测试文件与 test 名称真实存在
（2026-09-05 用户拍板加的：一份讲「别让副本安静过期」的清单自己安静过期最
难察觉）。它**核不到**「有 pin / 无 pin」这个判断本身——那一栏靠人维护，所以
下面每条都给了不随行号漂移的定位锚（小节标题、常量名、函数名），方便复核。

下面两张表的「谁 pin 它们」一栏格式是固定的：先一个反引号包住的测试文件路径
（`test/` 下、以 `.test.ts` 结尾），后面跟**零个或多个**反引号包住的双引号
test 名称，同一个文件后面跟着的名称都归它。零个是正常情况——7.2 里那些
**只 pin 行为、不 pin 任何文档**的测试本来就没有可引的断言名称，只写路径即可，
它们照样会被核对是否存在。名称则**逐字照抄**，含 em dash `—` 与撇号 `'`，
否则字面量匹配会假红。`test/copy-map.test.ts` 就是这么解析的——它**只读表格
行**，所以这段说明里写什么都不会被当成引用。

### 7.1 有 pin 的副本对（改错会当轮红）

| 同一段口径的副本处 | 谁 pin 它们 | pin 的种类 |
| --- | --- | --- |
| judge 协议正文：`docs/judge-protocol.md` ↔ `lib/judge-prompt.ts` 的 `JUDGE_COMMON_PROTOCOL` | `test/judge-prompt.test.ts` · `"F5 pin: embedded protocol keeps every rule of docs/judge-protocol.md"` · `"round 5: the protocol tells the judge what an untrusted data block may NOT do"` | bullet 块逐条包含（**单向**：嵌入副本缩水才红，文档端加一条也红；反向不管）；后者用共享常量 `UNTRUSTED_DATA_RULE` 把同一句钉在两处 |
| 判官验证口径（默认只读代码与 diff、非必要不跑测试 / lint / 外部命令；有具体怀疑才跑最小验证并说明跑了什么）：权威 `docs/judge-protocol.md` 的「验证纪律：默认只读代码，非必要不跑命令」节；嵌入副本同上一条的 `JUDGE_COMMON_PROTOCOL`；引用面 `AGENTS.md`、`agents/reviewer.md`、`lib/parallel-review.ts`（模块头注释 + 每轮任务文本）、`lib/quality-round.ts`（质量轮任务文本）、`skills/review-loop/SKILL.md`、`README.md` 只许摘要 + 指针 | `test/judge-verification-discipline.test.ts` · `"the rule has ONE substantive home, and the embedded protocol carries it"` · `"every surface points at the rule's home and names the section"` · `"no surface still teaches the removed default"` | 每个引用面出现「SHOULD verify by doing / mutation analysis included / mutation checks」即红，且必须指回 `docs/judge-protocol.md` 并写出节名；负向扫描带自证（该正则在**被删掉的老措辞**上必须命中，否则红）|
| 安全与模块规模审查项（`### E 安全` 的 `L1-E1`–`L1-E4`、`L1-C8`）：权威 `docs/code-quality-rules.md`（问题表本体）；引用面 `agents/quality-auditor.md`（把安全写成**必答**，只引 id 与要求，不复制问题表）、`lib/quality-round.ts` 的 L1 描述（只列层名）、以及 L1 层描述的三处副本 `AGENTS.md` / `README.md` / `skills/review-loop/SKILL.md` | `test/agents-structure.test.ts` · `"the quality checklist has a SECURITY section, and the quality judge must answer it"` · `"the checklist asks whether a change piles onto an ALREADY-big file (L1-C8)"` · `"the goal draft must name its key test scenarios and boundary cases, or it is P1"` | 判定表端删掉任一 id / 覆盖面即红；role body 丢掉 MUST-ANSWER 或 id 也红；三处层描述少了 `security` 同样红（“security always in scope”那句泛化提示算不上必答） |
| judge 角色集合：`lib/judge-prompt.ts` 的角色表 ↔ tmux 子进程角色 | `test/judge-prompt.test.ts` · `"judge roles are exactly the tmux-child roles"` | 两处必须一致（含 `quality-auditor`；它可被寻址、但不在 `judge_submit` 的 role 枚举里） |
| 可寻址 judge 角色的枚举：只许 `lib/judge-session-tools.ts` 的 `ROLE_PARAM` 一份；`lib/judge-spawn-tools.ts`（`judge_answer` / `judge_recover`）`import` 它 | `test/judge-session-tools.test.ts` · `"the role enum is declared ONCE in lib/ — the spawn tools import it (2026-09-17)"` · `test/judge-spawn-tools.test.ts` · `"judge_answer / judge_recover accept every addressable judge role (2026-09-17)"` | 第二处声明（或 consumer 不再 import）即红；行为面从**注册出的 schema** 读 `role.enum`，不看源码文本（两份文本各自看都对，正是它漂掉的原因）。注意 `judge_submit` 的 `SUBMITTABLE_JUDGE_ROLES` 刻意不含 `quality-auditor`（不许手工派质量轮），那是另一个事实、不属本行 |
| 角色文件集合：`agents/*.md` ↔ `lib/model-config.ts` 的 `KNOWN_AGENTS` | `test/agents-structure.test.ts` · `"agents/*.md exactly matches KNOWN_AGENTS (config/render see every agent)"` | 双向 `deepEqual`（漏注册一个角色，配置层与渲染会静默跳过它） |
| 模型链：`agents/{reviewer,quality-auditor,adviser,arbiter,goal-auditor}.md` 的 frontmatter | `test/agents-structure.test.ts` · `"L3 judge roles pin the exact strong-tier chain (model + fallbacks + max thinking)"` · `"goal-auditor is a strong-tier, READ-ONLY judge — the gate records its verdict"` | 逐字（正则钉死 `model:` / `fallbackModels:` / `thinking: max`） |
| 本文 §五的模块表 ↔ `lib/*.ts` 目录 | `test/module-map.test.ts` · `"§5 lists exactly the modules in lib/ — both directions"` · `"§5's header count matches the table it heads"` | 双向差集 + 标题里的计数（单靠计数不够：一个幽灵行加一个漏登会互相抵消） |
| 指纹算法两份实现：`lib/fingerprint.ts` ↔ `scripts/compute-fingerprint.cjs`（钩子离开 pi 也要能算） | `test/constants.test.ts` · `"TS and CJS fingerprint implementations agree (drift guard)"` · `"TS and CJS agree on FINGERPRINT_VERSION"` | 两份实现**跑出来的结果**必须一致（不是文本比对） |
| 代码扩展名清单：只许 `lib/constants.ts` 一份 | `test/constants.test.ts` · `"structural: no source file other than lib/constants.ts declares a code-extension list"` | **禁止出现第二份副本**（结构扫描全仓） |
| 增量审查契约：权威 `lib/review-carryover.ts`；`AGENTS.md`、`README.md`、`QUICKSTART.md`、`docs/judge-protocol.md`、`skills/review-loop/SKILL.md` 只许写摘要 + 指针 | `test/review-carryover.test.ts` · `"the contract's clauses appear in exactly one file"` · `"every surface that summarises the contract points at the source"` · `"the scan itself sees the files it claims to (before its verdict means anything)"` | 禁止第二份副本 + 每个摘要面必须回指权威模块；第三条是**扫描自证**（窗口先证明自己看见了要看的文件，结论才作数） |
| 「不可能性主张」规则：`agents/reviewer.md` ↔ `skills/review-loop/SKILL.md` ↔ `README.md` 的 `### "It can't be done" is a hypothesis, not a finding-free pass` | `test/impossibility-claims.test.ts` · `"reviewer treats an impossibility claim as a hypothesis to verify, not a fact"` · `"review-loop skill makes the main agent hand its impossible list to the reviewer"` · `"README documents the impossibility-claim rule for users of the gate"` | 三处都必须出现各自那几句（README 端按小节切窗后断言） |
| 「已删除的工具名不得再出现」：`AGENTS.md` + `skills/review-loop/SKILL.md` 绝对禁；`README.md` / `QUICKSTART.md` 靠历史 banner 豁免 | `test/extension-structure.test.ts` · `"the SHIPPED skill and the agent-facing docs name no deleted tool at all"` | 负向 pin，且**豁免凭据本身被 pin**（banner 没了豁免同时失效） |
| judge 握手口径（完成信号是通道报告，不是进程退出 / `tmux wait-for`）：`AGENTS.md`、`skills/review-loop/SKILL.md`、`docs/execution-model.md`、`docs/judge-protocol.md`、`lib/judge-prompt.ts`、`lib/parallel-review.ts`、`lib/loop-goal.ts`、`lib/loop-goal-directives.ts`、`lib/goal-audit-task.ts`、`lib/adviser-brief.ts` | `test/workflow-commands.test.ts` · `"the judge handshake never teaches tmux wait-for (process exit is the completion signal)"` | 八处一起负向扫描 + 正向要求出现「标准报告」「通道」 |
| 最小化准则四条：权威 `docs/coding-standards.md` §5；`docs/code-quality-rules.md`（2026-09-15 起 diff 级最小化判定的入口，只引用不复制）、`agents/goal-auditor.md`、`lib/goal-audit-task.ts` 的 goal 审计任务、`lib/orchestrator-plan-audit.ts` 的 plan 审计任务、`lib/agent-directives.ts` 的 `WRITE_TIME_REMINDERS`（2026-09-16 起是**一组**写作前提醒，§5 只是其中一行）只许引用 + 各自严重度映射 | `test/agents-structure.test.ts` · `"minimalism keeps ONE substantive home (§5), and the code-quality round defers to it"` · `test/agent-directives.test.ts` · `"the standing block carries the write-time reminders (cite, never quote)"` · `test/loop-goal.test.ts` · `"buildGoalAuditTask: the audit task carries the minimalism check (cite §5, P1 for out-of-scope work)"` · `test/orchestrator-plan-audit.test.ts` · `"the audit task carries the 7th check: minimalism (inside the checklist, mergeable tasks are P1)"` | 引用面出现四条中任一条实质表述即判失败（禁止第二份副本）；§6 那几条（安全 / 落点 / 注释嵌套 / 依赖判断提示）同属这一行的第二半 —— 同样只引用 |
| 写作时规范：权威 `docs/coding-standards.md` §6（安全、模块落点与规模、注释、嵌套、依赖与开源的判断提示）；引用面 `lib/agent-directives.ts` 的 `WRITE_TIME_REMINDERS` 只许「§号 + 一个动作」 | `test/agent-directives.test.ts` · `"the standing block carries the write-time reminders (cite, never quote)"` | 每条提醒必须自带 `§号`（没节号的提醒就是回抄的序级），条数 ≥3，且 §5 四条小标题原文一律不得出现 |
| 拒绝文案三件套（现象 / 原因 / 下一步 + 谁能解）：权威 `docs/coding-standards.md` §7；**唯一渲染器** `lib/rejection-copy.ts`（`buildRejection` / `RejectionParts` / `RejectionActor`）；调用面是本轮接入的高频路径 —— `lib/user-interaction-tools.ts`（ask_user）、`lib/loop-goal.ts`（goal 打回 + L8 编辑拦截）、`lib/restatement.ts`（goal/plan 缺反述）、`lib/ship-gate-edit-guard.ts`（edit/write）、`lib/ship-gate-copy.ts`（ship）、`lib/judge-submit-tool.ts` 与 `lib/declare-done-tool.ts`（judge_submit 与 declare_done）；**另加** `lib/session-exclusivity.ts`（会话启动时的 worktree 占用拒绝 —— 它不属于 goal 点名的六条路径，同一段文本也被 L8 编辑门当拦截理由用） | `test/rejection-copy.test.ts` · `"buildRejection renders the phenomenon, the reason and the next step — in that order"` · `"every actor renders, and renders differently (agent / user / gate)"` · `"every high-frequency refusal path renders through buildRejection"` | 三行模板按字面钉在渲染器里（第二条断言）；调用面按**调用点切窗**钉住（起点锚必须唯一，否则会切到错误的窗口 —— 第 2 轮质量轮实测过）—— 从渲染器退回手写文案会红。**未接入的拒绝点不在这条 pin 的范围**，它们随日后改动收敛 |
| 送审说明写作提示：`lib/agent-directives.ts` 的 `ROUND_NOTE_HINT` 是唯一出处，渲染到两处 —— 常驻块 `TOOL_DECISION_TABLE` 的 judge_submit 行，与 `lib/judge-submit-tool.ts` 里 `judge_submit` 的 `task` 参数描述 | `test/agent-directives.test.ts` · `"the round-note hint reaches both surfaces from ONE constant"` | 常驻块那一行必须**渲染**这个常量（不是摘要）；另一处必须 import 同一个常量 |
| 等待纪律三句话：主会话版 ↔ 项目经理版，权威是 `lib/agent-directives.ts` 的 `buildWaitDiscipline` | `test/agent-directives.test.ts` · `"both renderings come from ONE builder — no second copy of the wording"` | 两处渲染必须出自同一个 builder（**结构上**杜绝手抄，不是比对文本） |
| 「wave 机制已删除」：`AGENTS.md` ↔ `skills/review-loop/SKILL.md` | `test/agents-structure.test.ts` · `"AGENTS.md states read-only parallel exploration and NO wave protocol"` · `"SKILL.md states read-only exploration rules and NO wave protocol"` | 正向要求写明已删除 + 负向禁止指令式提及 |
| 单 reviewer / 再审携带上轮结论 / findings 只带 blockers：散在 `agents/*.md`、`docs/judge-protocol.md`、`lib/judge-prompt.ts`、`skills/review-loop/SKILL.md` | `test/agents-structure.test.ts` · `"REGRESSION: the single-review protocol states ONE reviewer per round"` · `"REGRESSION: every re-review must carry the previous round's conclusion"` · `"every judge role is told that findings carry BLOCKERS ONLY"` | 多文件循环断言：每一处都必须出现这句 |
| 交付站点定义句（precommit / commit / pr 各是什么）：权威 `lib/delivery-station.ts`（`describeDeliveryStation` 带 `StationAudience` —— 同一份定义两种称谓：对话框对用户说第二人称，工具拒绝/回执对 agent 说第三人称；外加 `describeDeliveryStationEn` / `DELIVERY_STATION_CHOICES_EN` / `deliveryStationChoiceLines` / `deliveryStationLine`）；`lib/restatement.ts`、`lib/loop-goal-directives.ts`、`lib/goal-tools.ts`、`lib/orchestrator-plan.ts`、`lib/orchestrator-tools.ts`、`lib/orchestrator-plan-messages.ts` 一律**渲染**，`AGENTS.md`、`README.md`、`QUICKSTART.md`、`docs/dev-flow.md`、`skills/review-loop/SKILL.md` 只许摘要 + 指针 | `test/delivery-station.test.ts` · `"the station definitions live in ONE file — no other source restates them"` · `"every surface that summarises the station points at the module that defines it"` · `"the rendered choice lists are derived, not typed out again"` | 全仓（`lib/` + `extensions/` + `scripts/` + `hooks/` + 全部散文面，**含本文件**）禁止第二份定义句：扫的是**定义片段**（称谓词插值后整句不再是字面量，片段才抓得住手抄——所以这一栏也不敢把那几句抄进来）+ 两种受众的完整渲染；再加摘要面必须回指模块、渲染器结构自证、以及「谁 commit」不许被渲染反（round-1/2 P2 的真实缺陷：面向 agent 的文案说成了「由你自己 commit」） |
| orchestrator 工具清单：`AGENTS.md` 的「工具集（N 个）」、`README.md` **两处**（角色表 + 工具参考表那一行）、`QUICKSTART.md` 的十工具段 | 实际注册（`lib/orchestrator-*-tools.ts`，测试从 fake world 的注册表取真值） | `test/copy-convergence.test.ts` · `"every doc inventory of the orchestration tools is the set the gate registers"` · `"no doc presents a DELETED orchestration tool as one you can still call"` | 每份清单只在**它自己那段窗口**里判（切窗后带长度自证）——扫全文会让「删掉表格里一行、名字在别处还在」蒙混过关（round-1 P1 的实测变异）；窗口里若声明了数目（「（10 个）」「十个工具」）必须等于注册数。第二条覆盖全部散文面：非注册的 `orchestrator_*` 只能出现在带「已删除/上一版/原来的…」标记的段落里（2026-09-17 实测：`docs/execution-model.md` 里三个死工具都在历史段落里，合规） |
| 子会话状态清单（八态）：`AGENTS.md`、`README.md`、`docs/execution-model.md`、`docs/orchestrator-supervision.md` §2、`docs/hierarchical-session-design.md` | `lib/orchestrator-child-state.ts` 的 `CHILD_STATES`（`satisfies` + `ChildStateGap` 双向编译期钉住 union） | `test/copy-convergence.test.ts` · `"a doc that COUNTS the child states counts the union"` · `"the docs that enumerate the child states enumerate ALL of them"` | 数数的地方必须数对（全散文面扫「N 态 / N states」）+ 三处声称完整的清单必须列全；两条都带自证（计数扫描至少命中 3 处、切窗结果非空且小于全文） |
| 600 行硬拦的**数字**：`AGENTS.md` 架构规范段、本文 §三与 §五、`docs/orchestrator-supervision.md` | `lib/file-size-gate.ts` 的 `NEW_FILE_HARD_LIMIT` | `test/copy-convergence.test.ts` · `"every prose copy of the new-file line limit is the gate's own number"` | 全散文面扫「谈上限/硬拦的那一行里紧跟 行 / -line 的数字」，必须等于常量；自证要求至少扫到 3 处（扫不到就说明正则坏了，而不是副本没了） |
| precommit 步骤名清单（lint / typecheck / build / test）：`README.md` 的 lane 表与耗时表、`skills/review-loop/SKILL.md` | `scripts/precommit-runner.mjs` 的 `collectStep(...)`（**不是** `precommit-plan.mjs` —— 那个模块只按步骤名规划缓存范围，名字是传进去的参数；2026-09-17 更正） | `test/copy-convergence.test.ts` · `"every doc that lists the precommit steps lists the ones the runner runs"` | 只判「写出整条阶梯」的行（`lint + typecheck` / `lint/typecheck` 形状），每个步骤名都必须在场；`test` 允许写成 "suite"（口径是 lane，不是脚本名）。自证：至少扫到 3 行 |
| 三份「照抄填空」骨架（需求反述 / loop goal / plan 任务书）：权威分别是 `lib/restatement.ts` 的 `RESTATEMENT_SKELETON`、`lib/loop-goal.ts` 的 `LOOP_GOAL_SKELETON`、`lib/orchestrator-directives.ts` 的 `PLAN_TASK_SKELETON`；渲染面是 `lib/goal-tools.ts`（`propose_loop_goal` 的说明）、`lib/loop-goal.ts`（`buildGoalPrereviewRefusal` 的拒绝文案）、`lib/orchestrator-tools.ts`（`orchestrator_plan` 的说明 + `plan.tasks[].note` 的描述）、`lib/orchestrator-directives.ts` 的 `ORCHESTRATOR_DIRECTIVE`；`lib/agent-directives.ts` 的 `REQUIREMENT_PROTOCOL` 只许一句指针。**「代码落点」永远只是 `plan.tasks[].note` 的自由文本** —— `canonicalPlanText` 排除 note（2026-09-17 用户决定：把落点做成结构化字段会重新引入「改个文件就要重新批准」的死锁）；顶层 `note`（set-status 的参数）不挂模板 | `test/templates.test.ts` · `"the goal template reaches the agent BEFORE it drafts and again when an audit rejects the draft"` · `"the plan task book reaches both surfaces the manager writes it on"` · `"the three skeletons are ONE family — same opening line, same blanks"` · `"the standing block POINTS at the templates instead of quoting a second copy"` · `"the task book stays free text — canonicalPlanText carries no note (2026-09-17 user decision)"` | 模板必须在**每一处该看到它的面**都在场（goal 两处、plan 三处）；三份骨架同形按**循环**钉住（日后加第四份不合形会红）；常驻块回抄模板正文、或连那句「照抄这个骨架填即可」一起抄，都红；最后一条是**反向断言** —— note 正文一个字符都不许进 `canonicalPlanText` |
| 审核三方并行与取消矩阵（质量轮 / 功能轮 / 全量 precommit **同一时刻启动**，谁先判不过谁收口；reviewer 先交卷的 READY **扣下**等质量轮结论）：权威 `docs/execution-model.md` §「并行三方与取消矩阵」；引用面 `AGENTS.md`、`docs/coding-standards.md` §4、`README.md`（角色表 + precommit 段）、`skills/review-loop/SKILL.md`、`agents/reviewer.md`、`agents/quality-auditor.md` 只许摘要 + 指针（2026-09-16 起；这六处曾各写一份「质量轮先跑」，而代码已改成并行） | `test/copy-convergence.test.ts` · `"the cancel matrix has ONE substantive home, and it states all three rows"` · `"every surface that summarises the cancel matrix says the NEW order and points home"` · `"no surface still teaches the SERIAL round this replaced (negative, with a self-proof)"` | 权威必须写出三行矩阵 + 扣下规则 + 「同一时刻启动」；每个引用面必须回指该节（只写指针不够：还要写出自己那句改成了什么）；负向扫描禁止旧串行措辞，并**带自证**（该正则在被删掉的老措辞上必须命中） |
| 编排的收尾口径（plan 的**最后两环**：倒数第二个 = 收尾任务，汇合 → 一次整体审核 → commit，按同 repo 规则收窄；最后一个 = 独立验收任务，不产出新需求、不改业务代码，只做真实验收并交付 push → 开 PR，站点 = plan 的 `deliveryStation`、不受同 repo 多任务收窄）：规则权威 `lib/repo-pr-policy.ts`（`acceptanceTaskId` / `effectiveTaskStation`）；正文**唯一**一份是 `lib/orchestrator-directives.ts` 的 `PLAN_FINISH_TASK_BRIEF`（渲染到 `ORCHESTRATOR_DIRECTIVE`、`orchestrator_plan` 的工具说明与 `note` 描述，另有「PM 全程保持编排身份」那条硬约束）；`lib/orchestrator-plan-audit.ts` 的第 10 条审计要点与 `lib/orchestrator-plan.ts` 的最后一环标记只许引用；散文面 `AGENTS.md` §2b、`README.md`（One requirement, one PR per repo 那段）、`docs/orchestrator-supervision.md` §六乙与本文件 §5 | `test/templates.test.ts` · `"the finish-task rule reaches every surface the task book reaches — from ONE constant"` · `test/orchestrator-plan-audit.test.ts` · `"the audit task carries the 10th check: the plan ENDS with an independent acceptance task"` · `"the 10th check states the shape it P1s: a last task that is not an acceptance task"` · `"the 10th check is inside the checklist — before the conclude instructions"` · `test/repo-pr-policy.test.ts` · `"the plan's LAST task is the acceptance task, and it is NEVER narrowed"` · `"the acceptance task still COUNTS as a task of its repo (2026-09-18, user decision)"` · `"a one-task plan's acceptance task is that task — position, not a search"` · `test/orchestrator-plan.test.ts` · `"the summary marks WHICH task accepts and delivers — and only that one"` · `test/orchestrator-plan-approval.test.ts` · `"REORDERING is authority: whoever is last may publish"` · `"a reorder that moves no authority is not news"` · `"dropping a sibling can widen the survivor — the count is what capped it"` · `test/extension-structure.test.ts` · `"nothing writes the loop mode by itself — the plan's finish task delivers"` | 正文只有一份：三处模板面必须**渲染**同一常量（手抄即红），且它按**位置**而不按新字段（prompt 里不许出现填充式骨架）；规则必须按任务回答（验收任务 = plan 站点、其余（含倒数第二个收尾任务）仍收窄、单任务 repo 不受影响、验收任务仍计入该 repo 的任务数）；审计要点必须在 checklist 内、且在 `judge_conclude` 指令之前；「编排卡在交付上就切回 loop」这条被用户否掉的出路，由源码扫描（`setTaskMode("loop"` 零命中）钉死不能加回来 |
| 会话模式枚举（loop / explore / normal / orchestrator）：权威 `lib/task-mode.ts` 的 `TaskMode` + `normalizeTaskMode`，注册表是 `lib/gate-modes.ts` 的 `GATE_MODES` / `MODE_REGISTRY`（`internalOnly` 区分会话模式与 judge 模式）；**唯一副本**是 git hook 的 CJS 侧 `scripts/pre-commit-check.cjs` 的 `TASK_MODES`（钩子在没有扩展进程的 checkout 里也要判 sidecar 形状） | `test/pre-commit-check.test.ts` · `"the hook accepts every session mode the TS registry declares (drift guard)"` · `"an orchestrator-mode sidecar is VALIDATED, not reported as corrupt (2026-09-18)"` · `"a forged taskMode still fails closed — and SAYS so (a whitelist, not 'anything else')"` | 会话模式集合从 `GATE_MODES` **派生**（不手抄）后逐个驱动 hook 真跑：TS 侧加了模式而 CJS 不跟即红（2026-09-18 实测漏过 `orchestrator` —— 编排模式下每个 push 都被报成 `gate state shape/verdict invalid`，state 是每工作区一份所以用户手动 push 也中招）；explore/normal（source user）必须仍是 advisory exit 11，而 `orchestrator` 必须**不是**；伪造值仍 fail-closed |

### 7.2 无 pin 的副本（会安静过期的那些）

改这些口径时**没有任何测试会红**——只能靠这张表。

| 同一段口径的副本处 | 权威在哪 | 实测备注 |
| --- | --- | --- |
| L1–L9 分层清单：`README.md` 的 ASCII 图（`L1 Ship gate` … `L8 Loop-goal approval`、`L9 Real acceptance`）↔ 本文 §二的表 | 无单一权威（分散在各层实现） | `test/module-map.test.ts` 只覆盖 §五；README 端只有零散句子被别的测试 pin，层级表本身不在其中。**L9（验收轮）自 2026-09-22 起在场：给分层表加层时两层都要加**，否则「代码里的 L9」在两张表里都找不到 |
| judge 默认模型链：`scripts/install-package.mjs` 的 `DEFAULT_AGENTS`、`AGENTS.md` 正文、`README.md` 的配置示例 | `agents/*.md` 的 frontmatter（这一端有 pin，见 7.1）；**且自 2026-09-10 起它就是运行时输入**：派发与 pane 都读这条链（`lib/model-health.ts` / `lib/judge-model-rotation.ts`） | `test/install-package.test.ts` 只验安装**行为**，从不校验 `DEFAULT_AGENTS` 的内容与 `agents/*.md` 一致。**2026-09-17 实测已经漂了**：`DEFAULT_AGENTS.arbiter` 是 `onekey/gpt-5.6-sol:max`（与 `lib/project-config.ts` 的 `DEFAULT_ARBITER_MODEL` 同源），而 `agents/arbiter.md` 与 AGENTS.md 都写 `claude-fable-5` → `claude-opus-5`。收敛前要先由用户拍板哪一份是对的（跨模型仲裁是不是刻意的），所以本轮只记录、不动 |
| 整份文档从未被任何测试读到：`docs/coding-standards.md` | —— | 2026-09-08 起 §5 最小化准则进入多个测试的扫描面（见 §7.1 最小化行），其余章节仍只被 `review-carryover.test.ts` 查增量契约一项。（`docs/orchestrator-supervision.md`、`docs/hierarchical-session-design.md`、`docs/dev-flow.md` 已于 2026-09-17 进入 `test/copy-convergence.test.ts` 与 `test/delivery-station.test.ts` 的扫描面，不再是「零测试读到」）|
| 五个环节开关的口径（默认全开＝今天的行为；未勾的环节在它每一个卡点放行；编排模式与其子会话不提供）：`AGENTS.md` §Single-review loop、`README.md` 的「Five stages, switchable — and all five ON by default」段、`/gate-status` 与底部 widget 的读数文案（`lib/gate-command-tools.ts` / `lib/ui-widget.ts`） | `lib/loop-stages.ts`（`stageOpen` / `LOOP_STAGES`、框的标题与正文、以及工具注册都在同一模块） | 实现侧有 pin（`test/loop-stages.test.ts`、`test/gate-state.test.ts`、`test/extension-structure.test.ts`），散文副本没有任何测试扫到 —— 改文案与改常量是两件事，回头把两边对齐 |
| 验收轮口径（门禁在 `declare_done` 里自己派、READY 绑**工作区指纹**、只拦完成不进 `unmetRequirements`、不在取消矩阵里）：`AGENTS.md` §Single-review loop、`README.md`（角色表 + `declare_done` 那行）、`docs/judge-protocol.md` 的验证纪律、`docs/execution-model.md` §「验收轮：完成时刻的单人轮」 | `lib/acceptance-round.ts`（判定表与三个产物）+ `lib/acceptance-host.ts` 的 `armAcceptanceRound`（派发、指纹）+ `lib/sibling-verdict-host.ts` 的 `recordAcceptanceVerdict`（记录） | 实现侧有 pin（`test/extension-structure.test.ts` 的「armed from declare_done… never ships」与「`unmetRequirements` 里不许出现 acceptance」、`test/acceptance-round.test.ts`），散文面未扫：一处口径改了就顺手改其余三处 |
| **当轮抓到的活样本**：2026-09-17 第一次拿代码去核这张表的三行，三行**全是错的** —— 子会话状态 union 早已是八个（`mode-changed`），而 `README.md`、`docs/execution-model.md`、`docs/orchestrator-supervision.md` 连同 union 自己上面那句注释都还写「七」；`docs/execution-model.md` 点名了三个一个月前就删掉的工具、却从没提过 `orchestrator_plan`；`lib/restatement.ts` 里的交付站点定义句是手抄的第二份 | 无 | 这三行当轮收敛并进了 7.1（前一版的活样本是 §六第 4 条那组过期计数与点名，已在 2026-09-05 改成不带计数、不点名的表述）。教训不变：**一张讲「副本会安静过期」的表，自己也会安静过期** —— 所以每次动它，顺手拿代码核一行 |

### 7.3 一条否定结论（省得后来人再扫一遍）

**三条哲学不是多副本。** 全仓只有 `AGENTS.md` 的「三条哲学」一份正文；
`docs/dev-flow.md`、`docs/execution-model.md`、`lib/hierarchy.ts`、
`lib/judge-lifecycle.ts`、`extensions/review-gate.ts` 等处出现的「（哲学三）」
都是**理由标签**，不是复述。它没有 pin，但也没有副本可漂。

### 7.4 这张表的边界（诚实说明）

它**不是穷尽的**：`extensions/review-gate.ts` 近九千行的注释级复述只抽查过、
`agents/*.md` 各角色正文彼此之间没做交叉比对、`docs/rounds/*.md` 作为历史
存档一律不比对。发现新的一对就往 7.1 / 7.2 加一行——加行时顺手确认引用格式，
`test/copy-map.test.ts` 会替你核对名称是否真实存在。
