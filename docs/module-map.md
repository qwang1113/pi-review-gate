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
`extensions/review-gate.ts` 的七千余行就是几十次「只加 100 行」累积出来的。

---

## 一、`extensions/review-gate.ts` 是什么

它是**扩展入口**：pi 的生命周期事件在这里接线，绝大多数 gate 工具在这里注册。
它**不是**「所有关卡与所有工具的唯一入口」——这个误解会直接把新代码引到错误
的文件里。

### 1.1 它接线的生命周期事件

| 事件 | 门禁在这里做什么 |
| --- | --- |
| `session_start` | 恢复 sidecar 状态、判定会话模式、装配常驻指令 |
| `before_agent_start` | 每轮注入 L4 语言指令、goal 摘要、per-turn 协议提醒 |
| `tool_call` | L1 ship 拦截、敏感文件拦截、L5 文案判定 —— **正文已搬进 `lib/ship-gate-hook.ts` + 两条臂**，扩展只留一行接线与注入的 deps |
| `tool_result` | 追踪本轮编辑、记录 precommit 结果、编辑纪律 nudge、附加提示 |
| `input` | 用户真的说话了：重置编辑失败 nudge、解除 ESC 暂停 |
| `agent_end` | ESC 中止检测，喂给 L2 的暂停判定 |
| `agent_settled` | L2 自动续跑（递归保护、轮次上限、平台期停止） |
| `turn_end` | 本轮编辑/提交状态对账（哪些改动仍在武装门禁） |
| `session_shutdown` | 收尾清理（watcher、临时资源） |
| `session_compact` | 压缩后重新注入门禁状态与 git 记忆 |

核对（这张表的完整判据）：`grep -n 'pi\.on("' extensions/review-gate.ts` —— 当前 10 个。

### 1.2 工具注册分两处（重要）

- **扩展直接注册 4 个** gate 工具：`judge_submit`、
  `declare_done`、`set_gate_mode`、`request_arbitration`（`setup_workspace` 于
  2026-09-07 退役）。
  核对：`grep -c '^  pi.registerTool({' extensions/review-gate.ts` → 当前 4。

- **19 个工具已经搬进 `lib/`，不在扩展里**——而且这是这个仓库正在走的方向：
  - `lib/goal-tools.ts`：`propose_loop_goal`（L8：跑 goal 审计 → 问用户 →
    写文件），并且是这一族的**唯一注册入口**——它同时把内部实现
    `record_goal_prereview` 注册到 internalHost，所以扩展里只有一次
    `registerGoalTools({ agent: pi, internal: internalHost }, {...})` 接线。
    工具体在 `lib/goal-prereview-tools.ts`（审计裁决落成记录，外加两个工具
    共用的提交检查）。
  - `lib/user-interaction-tools.ts`：`ask_user`（采访本身），并且是这一族的
    **唯一注册入口**——它自己调 `lib/consent-request-tools.ts`，所以扩展里只有
    一次 `registerUserInteractionTools(pi, {...})` 接线。
  - `lib/consent-request-tools.ts`：`request_scope_limit`、
    `request_sensitive_edit`（两个「请用户放宽门禁」的工具；对话、门禁状态与
    授权表都经注入的 deps 拿，所以「对话弹不出来 ≠ 用户拒绝」这类分支能用假
    实现单测）。
  - `lib/copilot-review-tools.ts`：`request_copilot_review`、
    `check_copilot_review`（L7 的两个工具；它们要打的 gh 电话在
    `lib/copilot-gh.ts`，经注入的 `gh` seam 调用，所以每条分支都能用假实现单测）。
  - `lib/judge-session-tools.ts`：`judge_read` / `judge_close` / `judge_wait`
    （作用于一个**已存在**的 judge 会话的三个工具）。
  - `lib/orchestrator-tools.ts`：`orchestrator_plan`、`orchestrator_notify`。
  - `lib/orchestrator-session-tools.ts`：`orchestrator_spawn`、
    `orchestrator_instruct`、`orchestrator_wait`、`orchestrator_close`、
    `orchestrator_handoff`（并从这里转注册下面两个模块，所以「有哪些编排工具」
    只有一个地方回答）。
  - `lib/orchestrator-answer-tools.ts`：`orchestrator_answer`。
  - `lib/orchestrator-recovery-tools.ts`：`orchestrator_recover`、
    `orchestrator_attach`。
  核对：`grep -rh 'name: "' lib/*.ts | grep -oE 'name: "[a-z_]+"' | sort -u | wc -l`
  → 21，其中 3 个是下面说的**内部实现**，不注册给 pi；6 + 18 = **24**。

- **7 个实现存在，但不是工具**（2026-08-30，哲学三）。`run_precommit`、
  `review_checkpoint`、`record_review`、`record_goal_prereview`、
  `prepare_review`、`prepare_adviser`、`prepare_goal_audit` 的**代码还在**——
  它们持有 precommit 回执校验、L5 文案规则、checkpoint 标记、审计裁决这些机械
  检查，`judge_submit` 与 `propose_loop_goal` 在内部调用它们，所以每条检查只有
  一份实现。但它们注册到扩展内部的 `internalHost` 而不是 `pi`：**agent 看不到
  这些名字**，因此没有第二条路可选。另外三个（`review_spawn` / `review_watch` /
  `review_send`）连实现一起删了 —— 它们连内部都没人调。
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
  `/precommit` 那条门禁自己跑的 lane，以及 `/gate-status`、`/gate-bypass`、
  `/gate-mode`、`/gate-reset`、`/gate-lesson` 五个命令的正文；它自己转注册下面
  那个模块，所以「有哪些命令」只有一个地方回答。命令 host 的 seam
  （`CommandHost` / `CommandContext`）也定义在这里 —— 工具走
  `lib/tool-host.ts`，命令是另一个面，两者不混用。
- `lib/gate-diagnosis-commands.ts`：两个**只读**诊断 —— `/gate-status` 内嵌的
  模型链读数（`modelDiagnosisLines`）与 `/gate-doctor` 体检正文。它只做环境探测
  （模型注册表、两层 agent 目录、git 钩子目录、`gh` 可执行），判定规则仍在
  `lib/model-diagnose.ts` / `lib/gate-doctor.ts`。它不写任何状态，也不喂任何裁决。
  → 改一个命令的文案或时机：改 `lib/gate-command-tools.ts`，不必碰扩展。

- 门禁命令共 6 个：`/gate-status`、`/gate-bypass`、`/gate-mode`、`/gate-reset`、
  `/gate-lesson`、`/gate-doctor`。
- 工作流命令（`/review`、`/precommit`、`/precommit-fast`、`/verify`、
  `/next-step`、`/risk-assess`、`/smart-commit`、`/create-pr`、
  `/load-pr-review`、`/watch-ci`、`/gate-init`）的**定义与提示词**在
  `lib/workflow-commands.ts`，`gate-command-tools.ts` 只是循环注册它们。
  → 加一条工作流命令：改 `lib/workflow-commands.ts`，命令层与扩展都不必碰。
- `/gate-reset` 清掉的那一堆会话可变量仍然留在扩展里（它们本来就是扩展闭包的
  绑定），聚成一个 `resetSessionState()`，命令经 `deps.resetSession()` 一个口子
  调用它 —— 命令模块只拥有「reset → persist → notify」这个顺序。

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
  逐 repo 门禁检查、一次性仲裁令牌，以及拦截文案
  （`describeShips` / `buildShipBlockReason`）。次序同样是契约：tmux backstop
  在 `/gate-bypass` 之上，`/gate-bypass` 在 ship 检测之上。

→ 改 L1 的任何判定：改这三个模块，不必碰扩展；扩展只在 deps 里补一个新的口子。
纯判定的单测在 `test/ship-gate-hook.test.ts`，结构断言在
`test/extension-structure.test.ts`（它扫的是这三个模块的源码，不是扩展）。


---

## 二、L1–L8：每层落在哪

关卡不是一层一个文件，而是「判定在 `lib/`、接线在扩展、纵深防御在
`hooks/` 与 `scripts/`」的分工。

| 层 | 是什么 | 接线/执行在哪 | 判定逻辑在哪 |
| --- | --- | --- | --- |
| **L1** ship gate（硬拦） | 未过门禁前拦下 `git commit` / `git push` / `gh pr create` / `gh pr edit` | `lib/ship-gate-hook.ts`（`evaluateToolCall`），扩展只留一行 `pi.on("tool_call", …)` 接线 | `lib/ship-gate-bash.ts`（ship 臂）、`lib/ship-gate-edit-guard.ts`（edit 臂）、`lib/ship-detect.ts`、`lib/shell-lex.ts`、`lib/constants.ts`、`lib/repo-resolve.ts`、`lib/fingerprint.ts` |
| **L2** 自动续跑 | 门禁未满足时重新触发一轮；事件链断掉时由存活不变量兜底（60s 周期唤醒） | 扩展 `agent_settled` + `lib/session-revival.ts` 驱动的独立定时器 | `lib/gate-state.ts`（未满足项）、`lib/loop-stall.ts`（断路器，只管事件注入路径）、`lib/session-revival.ts`（兜底唤醒，无视预算与断路器、尊重人的叫停） |
| **L3** git 钩子 | 离开 pi 也有效的纵深防御 | `hooks/pre-commit`、`hooks/pre-push`、`hooks/commit-msg` | `scripts/compute-fingerprint.cjs`、`scripts/check-staged-divergence.cjs`（钩子不依赖 TypeScript） |
| **L4** 输出语言 | 每轮无条件注入简体中文指令 | 扩展 `before_agent_start` | `lib/constants.ts` 的 `LANGUAGE_DIRECTIVE` |
| **L5** commit/PR 英文 | 命令行传的文案由工具层判；编辑器里写的由钩子判 | `lib/ship-gate-bash.ts`（ship 命令上的 commit message / PR 文案）+ 扩展的 checkpoint 路径 + `hooks/commit-msg` | `lib/lang-detect.ts`（唯一实现）、`lib/llm-classify.ts`（只能加拦）、`lib/text-appeal.ts`（申诉） |
| **L6** 测试标签英文 | 暂存内容里的 `it/test/describe` 标签必须英文 | `hooks/pre-commit` → `scripts/scan-test-labels.cjs`；扩展侧在编辑时预检 | `lib/edit-projection.ts`（投影改后全文，避免只看片段漏判） |
| **L7** Copilot 审查 | PR 之后的审查闭环：请求、等待、逐 thread 消账 | `lib/copilot-review-tools.ts`（工具 `request_copilot_review` / `check_copilot_review`）+ `lib/copilot-gh.ts`（gh 访问），扩展只接线 | `lib/copilot-review.ts` |
| **L8** loop goal | 用户批准的退出契约，未批准则 ship 被拦 | `lib/goal-tools.ts`（工具 `propose_loop_goal`，内部自跑 goal 审计）+ `lib/goal-prereview-tools.ts`（内部实现 `record_goal_prereview`：裁决落成记录），扩展只接线 | `lib/loop-goal.ts` |

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
（normal < explore < loop < orchestrator）与升降级规则，`pi-self.ts` 让
`/tmp` 草稿会话不自动进 loop，`workspace-branch.ts` 是保护分支
（main/master/dev/develop）检测：会话开始提示、checkpoint 前弹确认框。
`copilot-review.ts`（L7，PR 之后的 Copilot 审查闭环）与 `loop-goal.ts`（L8，
用户批准的退出契约）——两者的**判定**在这里，工具体分别在
`copilot-review-tools.ts` 与 `goal-tools.ts` / `goal-prereview-tools.ts`，
接线见 §2 的层表。

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

### 域 3：judge 子进程与审查协议

judge（reviewer / adviser / goal-auditor）是**自己的 pi 进程**：
`judge-process.ts` 是进程基座（`pi -p --session-id`，确定性会话 id 让同一角色
跨轮续接同一 transcript），`judge-session.ts` 把「会话」而不是「面板」当作被
管理实体，`judge-lifecycle.ts` 是 `judge_submit` 背后的纯决策（会话文件放哪、
何时算完成、审计裁决是否阻塞），`judge-prompt.ts` 装配系统提示（角色定义 +
共同协议），`judge-watch.ts` / `child-watch.ts` 负责「它退出了就唤醒主会话」
且不依赖子进程守规矩；`judge-session-tools.ts` 是作用于**已存在**会话的那三个
工具（`judge_read` / `judge_close` / `judge_wait`）的实现与注册，
——注意这三个工具都不在扩展里，见 §1.2。把一件事**转交**给 judge 进程的那三个
（`review_spawn` / `review_watch` / `review_send`）已于 2026-08-30 整体删除：
`judge_submit` 自己派单、自己登记完成 watcher，它们是同一件事的第二条路。


审查内容侧：`parallel-review.ts` 持有审查契约（一轮一个 reviewer，判不可变的
`baseline..HEAD`），`review-baseline.ts` 在链被 squash/rebase 后按内容找回基
线，`review-scope.ts` 决定增量多大就升级成整轮深审，`review-stream.ts` 让
findings 边审边流出，`verdict-parse.ts` 解析裁决（review 只认 JSON fence，
precommit 只认 `## Overall:` sentinel），`adviser-brief.ts` 组装 adviser 的
brief，`session-dir.ts` 保证 transcript 指针的编码与 pi 逐字节一致。把这些
拼成一份**判官真正收到的任务文本**的，是两个 prepare 模块 —— 它们是**内部实现**，
不再注册成工具（哲学三），由 `judge_submit` 与 `propose_loop_goal` 在内部调用：
`review-prepare-tools.ts`（算范围、开流、登记 review target）与
`advisory-prepare-tools.ts`（adviser brief 与 goal 审计任务文本，不碰 git 范围）。


> **落点**：改「judge 怎么被启动/等待/唤醒」→ `judge-*.ts`；改「它被告知
> 什么、它的产物怎么解析」→ `judge-prompt.ts` / `parallel-review.ts` /
> `verdict-parse.ts`；改角色的**行为定义** → `agents/<role>.md`，不是代码。

### 域 4：orchestrator 编排层

22 个模块，按「决策 / 通道 / 执行 / 工具」四层切开。2026-08-30 的通道重构删掉了
三个（`orchestrator-probe.ts` / `orchestrator-pane-read.ts` /
`orchestrator-keys.ts` —— 它们的全部工作就是让**终端**可读），新增了四个：

- **纯决策**：`orchestrator-gate.ts`（11 条硬约束；约束 7/10/14 已退役）、
  `orchestrator-boundaries.ts`（文件边界代数——同 repo 任务互斥、跨 repo 可并行的判据）、
  `orchestrator-plan.ts`（plan 是编排层的退出契约，批准绑定内容 hash）、
  `orchestrator-plan-approval.ts`（**这次改动扩权了吗**——不扩权的边界细化不
  重新惊动用户，扩权一律重批）、
  `orchestrator-plan-audit.ts`（plan 的前置审计：任务模板、裁决绑定 canonical
  文本、只 P0/P1 阻塞）、
  `orchestrator-pane-decor.ts`（子会话的颜色/标签/边框标题——纯展示层，只出不进）、
  `orchestrator-child-state.ts`（**子会话状态**：working / waiting-input /
  waiting-judge / idle / done / dead / stalled + mode-changed（模式切换事件，
  叫醒项目经理），判据全部是结构化真值——纯函数，
  用一串通道记录就能单测）、

  `orchestrator-handoff-advice.ts`（上下文用量 + 待答请求数 ⇒ 接力时机）、
  `orchestrator-wait.ts`（「有事发生」是什么，以及那份五块回执怎么装）、
  `orchestrator-registry.ts`（编排只能操作门禁替它创建的东西）、
  `orchestrator-relay.ts`（自我接力：只有后继者能关掉前任）、
  `orchestration-id.ts`（编排的稳定地址，接力换人后子会话无感）。
- **通道（两侧，IO 经注入的 seam）**：`orchestrator-channel.ts`（路径、记录
  schema、追加/读取/游标、大 payload 溢出、投影、心跳）、
  `orchestrator-child-channel.ts`（子会话侧：上报、两方竞态提问、读取与确认
  指令）、`orchestrator-supervisor.ts`（编排侧：读所有通道、判定、决定什么算
  新闻、渲染回执的前三块）。
- **与真实机器打交道**：`orchestrator-tmux.ts`（tmux 命令的唯一构造处，现在
  只剩开 pane / 关 pane / 列 pane —— 没有 `send-keys`，没有 `capture-pane`）、
  `orchestrator-wiring.ts`（跑 tmux、读写 plan、持有通道 IO 与
  监督记忆）、`orchestrator-delivery.ts`（投递并**校验真的送达**才报成功，证据
  是通道记录与子会话回执）、`orchestrator-notify.ts`（桌面通知，唯一入口 +
  节流）、`orchestrator-guard.ts`（tmux backstop：拦手写 tmux）。
- **工具与接线**：`orchestrator-tools.ts`（plan / notify）、
  `orchestrator-session-tools.ts`（spawn / instruct / wait / close / handoff 的
  注册，并转注册下面两个模块，所以「有哪些编排工具」只有一个地方回答）、
  `orchestrator-answer-tools.ts`（answer，含约束 8 的代批边界）、
  `orchestrator-recovery-tools.ts`（recover / attach、孤儿检测）、
  `orchestrator-dispatch.ts`（spawn / instruct 的实现）、`orchestrator-tool-kit.ts`
  （每个工具的共用前置：模式、pane 实况、plan 可用性、子会话资产）、
  `orchestrator-deps.ts`（编排工具要的依赖集合，host 类型在 `tool-host.ts`）、
  `orchestrator-directives.ts`（项目经理拿全套契约，子会话只拿一句话）。


> **落点**：新的编排**规则** → `orchestrator-gate.ts` 或
> `orchestrator-boundaries.ts`（能被单测点名的那种）；新的**能力**（读、按
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

`gate-state.ts` 是状态机与 sidecar（`.pi/review-gate-state.json`）的读写、
未满足项计算与并发绑定合并；`fingerprint.ts` 是「代码现在长什么样」的稳定
哈希（内容寻址、暂存无关），门禁的每个裁决都绑在它上面；`atomic-write.ts`
是所有状态文件共用的「写临时文件再 rename」；`repo-resolve.ts` 让裁决绑到
编辑真正发生的那个仓库；`project-config.ts` 解析 `.pi/review-gate.json`；
`git-memory.ts` 在上下文压缩后重新注入过滤过的 git 快照。

> **落点**：新的状态字段 → `gate-state.ts`（并想清楚它是否该进指纹）；
> 新的项目级开关 → `project-config.ts`；**任何**状态文件写入都要走
> `atomic-write.ts`。注意：`lib/fingerprint.ts` 与
> `scripts/compute-fingerprint.cjs` 是同一算法的两份实现（钩子不能 import
> TypeScript），改一边必须同步另一边——`test/constants.test.ts` 会比对。

### 域 7：模型配置与诊断

`model-config.ts` 把 `review-gate.json` 的 `agents` 段渲染成 `agents/*.md`
的 frontmatter（项目层盖全局层），**无内置默认**：安装脚本写入 6 角色的默认
slots，会话启动时 `validateAgentsForStartup` 硬检查每个角色（缺失/slots 空/
spec 非法即停会话），`modelSpecFor` 对未配置角色返回 undefined（派发
fail-closed）。`model-allowlist.ts` 是 provider 级允许名单，`model-diagnose.ts`
回答「我的审查实际跑在哪个模型上」，`gate-doctor.ts` 是 `/gate-doctor` 的只读
体检，`ui-widget.ts` 构造 editor 下方那条**单行**状态条（详情在 `/gate-status`）。

> **落点**：除 `model-config.ts` 会把配置渲染进 `agents/*.md` 之外，这一域
> 全是**诊断**：它们永远不产生门禁裁决。想让某个诊断「顺手拦一下」时，请把
> 它写成域 1 的一条规则，而不是让诊断带上拦截权。

### 域 8：用户交互与提示注入

`ask-user.ts` 是采访模型（逐题推进、上限、跳过与「在聊天里回答」的语义），
`user-interaction-tools.ts` 是它的执行侧（工具 `ask_user`：什么时候暂停循环、
每答一题就落盘、人与项目经理谁先答谁生效），并且是这一族的唯一注册入口——
它自己转注册 `consent-request-tools.ts` 的两个同意工具
（`request_scope_limit` / `request_sensitive_edit`，见 §1.2）；
`agent-directives.ts` 是每轮注入的常驻指令块（「情况 → 工具」那张表），
`dialog-budget.ts` 管确认对话框的渲染行数预算（宿主不截断，长度得自己管），
跨会话的唤醒**不在**这一域：一个编排子会话经它自己的**通道**上报（见域 4），
全局广播队列已删除；
`edit-discipline.ts` 管「edit/write 失败后改用 bash 写文件」这个习惯，两条通道
都用：`tool_result` 里追加 `EDIT_FAILURE_NUDGE` / `BASH_WRITE_NUDGE`，以及每轮
随系统提示注入的 `EDIT_DISCIPLINE_DIRECTIVE`（与 `agent-directives.ts` 同一条
通道）——**两者都不拦任何东西**，是这一域里最典型的提示级手段。

> **落点**：想让 agent 改掉某个行为习惯，先问这是不是**提示**能解决的——
> 是就改 `agent-directives.ts`，不是就写成域 1 的机械规则。系统级通知只有
> 编排层能发（`orchestrator-notify.ts`），任何会话都能广播的形态不要再回来。

### 域 9：通用基础设施

`constants.ts` 是全仓唯一的共享常量（代码/文档扩展名、敏感文件模式、ship 命
令种类、语言指令、轮次上限）——`test/constants.test.ts` 用结构性测试逼着每个
消费方 import 它而不是自己再写一份列表。`poll-wait.ts` 是通用等待骨架（探
测、发布、按判据或预算停），判据由调用方注入：judge 等待与编排等待共用它。
`workflow-commands.ts` 定义工作流命令及其提示词，含 `--execute` 授权字的严格
解析。`tool-host.ts` 是每个 `lib/` 工具注册模块共用的 host 类型 seam。

> **落点**：任何「扩展名列表」「敏感路径」类的常量 → `constants.ts`，不要
> 在本地再声明一份（这是被明文记过的历史事故）。任何新的等待循环 →
> 复用 `poll-wait.ts` 并只写自己的判据。

---

## 四、`lib/` 之外的目录

| 目录 | 承担什么 | 什么时候往这里加东西 |
| --- | --- | --- |
| `hooks/` | L3 纵深防御：`pre-commit`（校验 sidecar 与指纹、跑标签扫描与暂存分叉检查）、`pre-push`（同一套 + full lane 要求）、`commit-msg`（AI 署名 + L5 英文，覆盖编辑器里写的 message） | 新增一条**离开 pi 也必须成立**的检查；bash 写成，不能 import TypeScript |
| `scripts/` | 跑得起来的执行体：`precommit-runner.mjs`（确定性质量门）、`precommit-plan.mjs`（纯规划，可单测）、`precommit-cache.mjs`（按输入摘要缓存每步）、`precommit-config.mjs`（读 `.pi/review-gate.json` 的 precommit 段）、`compute-fingerprint.cjs`（钩子用的指纹，镜像 `lib/fingerprint.ts`）、`check-staged-divergence.cjs`、`scan-test-labels.cjs`（L6）、`install-git-hooks.sh`、`install-package.mjs` | **新增一条 precommit 检查**（改 runner + plan）；新增钩子要用的、不能依赖 TypeScript 的逻辑（CJS/MJS） |
| `agents/` | 四个角色定义：`reviewer`、`adviser`、`goal-auditor`、`arbiter`。frontmatter 是模型链、thinking、工具集的**单一事实源** | **新增或调整一个 judge 角色**：先改这里的 md，模型链由 `lib/model-config.ts` 渲染/校验 |
| `skills/` | `skills/review-loop`：随包分发给 pi 的技能，描述审查循环怎么跑 | 面向**使用者**的操作指南（而不是门禁自身的判定）放这里 |

---

## 五、`lib/` 全量速查表（88 个模块）

**维护指令（这张表没有机械约束，只有这一条）**：在 `lib/` 下**新增或删除**一个
模块时，**同一轮改动里**顺手加/删这里的一行——否则这张表会静静地过时。
随时可核对条目数：`ls lib/*.ts | wc -l`（当前 88，与本表条目一一对应）。

| 模块 | 一句话职责 |
| --- | --- |
| `adviser-brief.ts` | 组装 adviser 咨询的 brief：主会话 transcript 指针 + 结论落盘路径，第二次起带上轮结论与其后改动 |
| `advisory-prepare-tools.ts` | **内部实现**（不注册给 pi）：组装 adviser brief 与 goal 审计任务文本，由 `judge_submit` / `propose_loop_goal` 调用 |
| `agent-directives.ts` | 门禁对主会话的常驻指令块，每轮注入的「情况 → 工具」表 |
| `arbitration.ts` | 仲裁：由独立 arbiter 裁决「循环无解」的门禁拦截，fail-closed 且有次数上限；模型走 `agents.arbiter.slots[0]`（配置层），不再硬编码 |
| `ask-user.ts` | `ask_user` 的采访模型：问题上限、逐题推进、跳过与「在聊天里回答」的语义 |
| `atomic-write.ts` | 写临时文件再 rename 的原子替换，门禁所有状态文件共用 |
| `blocked-marker.ts` | sidecar 写失败时落 `.blocked` 标记，`hooks/pre-commit` 据此拒绝提交 |
| `checkpoint-message.ts` | checkpoint 提交信息（纯函数）：把 `checkpoint` 注入 **scope** 产出合法 Conventional Commits（`type(checkpoint-<scope>)` / `type(checkpoint)` / 非 CC→`chore(checkpoint)` / 已含则幂等），并对非英文 round note 回落英文默认、丢正文（L5 自洽） |
| `child-watch.ts` | judge 子进程存活仲裁：主会话不依赖子进程「守规矩」地发完成信号 |
| `constants.ts` | 全仓唯一的共享常量：代码/文档扩展名、敏感文件模式、ship 命令种类、语言指令、轮次上限 |
| `consent-request-tools.ts` | 工具 `request_scope_limit` / `request_sensitive_edit`：两个「请用户放宽门禁」的同意口子，对话与门禁状态经注入的 deps；由 `user-interaction-tools.ts` 转注册 |
| `copilot-gh.ts` | L7 的 gh 访问层：`gh` 以 argv 异步 spawn（超时 + abort），PR / 线程 payload / 可用性探测都在这里 |
| `copilot-review-tools.ts` | 工具 `request_copilot_review` / `check_copilot_review`：L7 状态机的两个驱动端，gh 访问经注入的 seam |
| `copilot-review.ts` | L7：PR 之后的 Copilot 审查闭环（请求、等待、逐 thread 消账） |
| `dialog-budget.ts` | 确认对话框的渲染行数预算——宿主不截断，长度必须自己管 |
| `edit-discipline.ts` | 识别绕过 edit/write 的 bash 写文件命令，只提示不拦截 |
| `edit-projection.ts` | 从 edit/write 入参投影出改后完整文件内容，供标签检查看到上下文 |
| `file-size-gate.ts` | 新建源码文件 600 行硬拦、存量超阈值只提醒的纯判定 |
| `fingerprint.ts` | 工作区指纹：内容寻址、暂存无关，门禁裁决与它绑定 |
| `gate-command-tools.ts` | 命令层的**唯一注册入口**：工作流命令的注册包装、`/precommit` lane，以及 `/gate-status` / `/gate-bypass` / `/gate-mode` / `/gate-reset` / `/gate-lesson` 五个命令正文；命令 host 的 seam（`CommandHost` / `CommandContext`）也在这里；自己转注册 `gate-diagnosis-commands.ts` |
| `gate-diagnosis-commands.ts` | 两个只读诊断命令面：`/gate-status` 内嵌的模型链读数（`modelDiagnosisLines`）与 `/gate-doctor` 正文；只做环境探测，不写状态、不喂裁决；由 `gate-command-tools.ts` 转注册 |
| `gate-doctor.ts` | `/gate-doctor` 的只读体检：模型链、provider 允许名单、precommit runner、git 钩子、命令注册表 |
| `gate-state.ts` | 门禁状态机与 sidecar 读写、未满足项计算、并发绑定合并 |
| `gate-timings.ts` | `.pi/gate-timings.jsonl` 可观测日志，每个门禁事件一行 |
| `git-memory.ts` | 上下文压缩后重新注入过滤、截断过的 git 状态快照 |
| `git-rewrite.ts` | 识别「只改 message」的历史重写，解开 L5 与门禁互锁的死结 |
| `goal-prereview-tools.ts` | **内部实现**（注册在 internalHost）：`record_goal_prereview`——把 goal-auditor 的裁决落成绑定草稿 sha256 的记录；外加两个 goal 工具共用的提交检查（空稿、长度上限、goal 绑定哪个 repo） |
| `goal-tools.ts` | 工具 `propose_loop_goal`（跑 goal 审计 → 用户批准对话 → 门禁自己写文件），并且是 goal 工具族的**唯一注册入口**：两个 host，agent 侧只看得见 `propose_loop_goal` |
| `judge-lifecycle.ts` | `judge_submit` 背后的纯决策：会话文件放哪、何时算完成、审计裁决是否阻塞 |
| `judge-process.ts` | judge 子进程基座：`pi -p --session-id` 的确定性会话 id 与进程管理；并把 judge 的 `$TMPDIR` 指向**每会话专属**的 scratch 目录（`judgeScratchDir`）——reviewer 的临时 review worktree 落在那里，门禁按 `reviewScratchWorktrees` 在 judge 退出后精确回收，绝不误删并行 lane 的活 worktree |
| `judge-prompt.ts` | judge 子会话的系统提示装配：角色定义 + 共同协议 |
| `judge-session.ts` | 把 judge「会话」当作被管理实体：transcript、run 目录、自述状态文件 |
| `judge-session-tools.ts` | 作用于**已存在**的 judge 会话的三个工具（`judge_read` / `judge_close` / `judge_wait`）及其注册 |
| `judge-watch.ts` | judge 完成的唤醒登记，键在进程退出事件上 |
| `lang-detect.ts` | L5 英文判定的唯一实现：任何非拉丁字母即拒，调用方只决定措辞 |
| `llm-classify.ts` | 语义第二意见（DeepSeek V4 Flash），契约上只能加拦（TIGHTEN-ONLY） |
| `loop-goal.ts` | L8：loop 会话退出契约的文件、审批记录与注入 |
| `loop-stall.ts` | L2 自动续跑的断路器：外部阻塞（限流、模型不可达）时停止空转 |
| `model-allowlist.ts` | provider 级模型允许名单，独立模块以便跨引擎存活 |
| `model-config.ts` | 每个 agent 的模型链配置层：把 `review-gate.json` 的 `agents` 段渲染成 frontmatter；`validateAgentsForStartup` 启动硬检查（无内置默认） |
| `model-diagnose.ts` | 纯诊断：「我的审查实际会跑在哪个模型上、这条链可用吗」 |
| `orchestration-id.ts` | 编排 id：编排的稳定地址（不是 session id），接力换人后子会话无感 |
| `orchestrator-boundaries.ts` | 文件边界代数：两个任务能否并行的唯一判据 |
| `orchestrator-channel.ts` | 点对点通道：路径、记录 schema、追加/读取/行游标、大 payload 溢出到旁文件、投影（还欠着什么）、心跳超时判定 |
| `orchestrator-child-channel.ts` | 子会话侧：状态上报、「人与项目经理任意一方先答即生效」的竞态提问、读取与确认编排下发的指令 |
| `orchestrator-child-state.ts` | 子会话状态（working / waiting-input / **waiting-judge** / idle / done / dead / stalled + mode-changed）与再唤醒退避；`waiting-judge` 是「在等门禁自己派出去的 reviewer/precommit」，不叫醒项目经理；`mode-changed` 是模式切换事件，叫醒项目经理。也让 `stalled` 回到只表示「扩展不在了」。判据全部是结构化真值，不看屏幕 |
| `orchestrator-pane-decor.ts` | 子会话的可视化区分：按 childId 派色（纯函数，同一子会话永远同色）、`@task-slug · state 220s` 的边框标题、window 级标签栏开关判定。**纯展示层**：只写不读，任何判定都不看它 |
| `orchestrator-plan-approval.ts` | 「这次 plan 改动扩权了吗」：目录前缀内的边界细化、收窄、加依赖、降并行度⇒批准迁移并记审计；新任务/新目录/删依赖/串行改并行/提并行度⇒重新批准 |
| `orchestrator-plan-audit.ts` | plan 的前置审计（`goal-auditor` 角色 + plan 专用模板）：审计要点、裁决绑定 canonical plan 文本的 sha256、只 P0/P1 阻塞、退回 findings 的文案 |
| `orchestrator-handoff-advice.ts` | 上下文用量 + 待答请求数 ⇒ 接力时机（软/硬阈值，没读数就明说没读数） |
| `orchestrator-answer-tools.ts` | 工具 `orchestrator_answer`：把答案写进通道（选项原文/序号/唯一子串，含糊即拒），代批 goal 时按约束 8 比对任务边界 |
| `orchestrator-delivery.ts` | 投递：任务文件 + `pi --session-id @file` 启动、恢复用的 argv 与说明，以及「什么才算送达」的判据（通道记录 / 子会话回执）。任务书在 brief 之后追加 `TASK_GOAL_DIRECTIVE`（门禁硬指示：plan 批准 ≠ goal 批准，必须先协商自己的 loop goal） |
| `orchestrator-deps.ts` | 编排工具需要的依赖集合；host 类型本身住在 `tool-host.ts`，这里只 re-export |
| `orchestrator-directives.ts` | 编排两侧的指令：项目经理拿全套契约，子会话只拿一句话 |
| `orchestrator-dispatch.ts` | dispatch 半边：`orchestrator_spawn` / `orchestrator_instruct`；spawn 时按任务声明的 `repo` 解析子会话 cwd（`resolveTaskRepo`，fail-closed——解析不了就拒绝，绝不回退到项目经理自己的 repo） |
| `orchestrator-gate.ts` | 编排的 11 条硬约束（约束 7/10/14 于 2026-09-07 退役），写成纯决策以便逐条单测 |
| `orchestrator-guard.ts` | tmux backstop：拦截绕过工具手写的 tmux 命令 |
| `orchestrator-notify.ts` | 桌面通知：唯一入口 + 节流，只有项目经理能发 |
| `orchestrator-plan.ts` | plan：编排层的退出契约，批准绑定内容 hash |
| `orchestrator-recovery-tools.ts` | 工具 `orchestrator_recover` / `orchestrator_attach`：同 session id 续开一个死掉的子会话、接管一整个编排，以及「plan 说 running 但没人在做」的孤儿检测 |
| `orchestrator-registry.ts` | 子会话登记表：编排只能操作门禁替它创建的东西 |
| `orchestrator-relay.ts` | 自我接力：只有后继者能关掉前任 |
| `orchestrator-session-tools.ts` | 会话生命周期决策（wait / close / handoff）并注册全部八个编排会话工具——spawn / instruct 的实现在 `orchestrator-dispatch.ts`，answer 与 recover/attach 在各自的 `*-tools.ts` |
| `orchestrator-supervisor.ts` | 编排侧监督：读遍所有通道、逐个判定、决定什么算「有事发生」（含退避与完成上限）、渲染回执的前三块 |
| `orchestrator-tmux.ts` | 仅剩的 tmux 命令构造：开 pane / 关 pane / 列 pane，加上 pane 装饰（`select-pane -P/-T` 与 window 级 `setw pane-border-*`，一律不带 `-g`，且都会过 `assertSafeTmuxArgv`）—— 没有 send-keys，也没有 capture-pane |
| `orchestrator-tool-kit.ts` | 编排工具的共用前置：模式校验、pane 实况、plan 可用性 |
| `orchestrator-tools.ts` | plan / notify 两个不碰 tmux 的工具 |
| `orchestrator-wait.ts` | 「有事发生」对编排子会话意味着什么（等待判据），以及那份五块回执的装配 |
| `orchestrator-wiring.ts` | 编排层与真实机器的接线：跑 tmux、读写 plan、持有本编排唯一的通道 IO 与监督记忆；`resolveTaskRepo` 默认实现用 git 的 `--show-toplevel` 把任务声明的 repo 解析成仓库根（子目录/符号链接路径都归一） |
| `parallel-review.ts` | 审查契约：一轮一个 reviewer、判不可变的 `baseline..HEAD`，以及交给它的任务文本 |
| `pi-self.ts` | `/tmp` 草稿会话识别：这类会话不由 agent 自行进入 loop |
| `polish-gate.ts` | 连续 READY 或同一文件反复打磨时，再审必须给出理由 |
| `poll-wait.ts` | 通用等待骨架（探测、发布、按判据或预算停），判据由调用方注入 |
| `precommit-receipt.ts` | precommit 回执的纯校验：真 PASS/FAIL 还是协议错误 |
| `precommit-tail.ts` | precommit runner 日志的实时 tail（runner 走文件而非管道） |
| `progress-stream.ts` | 长耗时门禁工具的实时进度输出 |
| `project-config.ts` | 每项目门禁配置 `.pi/review-gate.json` 的解析与层叠 |
| `repo-resolve.ts` | 多仓解析：裁决绑定到编辑真正发生的那个仓库 |
| `review-baseline.ts` | 审查基线解析：链被 squash/rebase 后按内容找回基线 |
| `review-prepare-tools.ts` | **内部实现**（不注册给 pi）：算不可变的 `baseline..HEAD`、polish gate、findings 流，并登记裁决要绑定的 review target；由 `judge_submit` 调用 |
| `review-scope.ts` | 增量审查定档：增量多大就升级为整轮深审的阈值 |
| `review-stream.ts` | findings 流：reviewer 边审边发，主会话边修 |
| `sensitive-grant.ts` | 敏感文件的一次性用户授权：限定路径、限时、用后即焚 |
| `session-revival.ts` | 存活不变量（2026-08-30）：会话在退出契约未满足时停下，门禁就周期性唤醒它。纯判定：看不见续跑预算与 loop-stall 断路器（它们管注入路径，管不了「停下」），但尊重人的叫停（ESC / ask_user / bypass / 仲裁 pause）与 handoff 交接 |
| `session-dir.ts` | pi 的 session-dir 编码约定，fresh-context 角色据此找到主会话 transcript |
| `side-effects.ts` | 唯一一处「本进程能不能碰外部世界」的判定（测试 / CI / 无 TTY / 显式关闭一律不能），通知与编排共用 |
| `shell-lex.ts` | 最小的引号感知 shell 词法器，命令类判定的共同底座 |
| `ship-detect.ts` | 判断一条命令行是否含 ship 操作（git commit/push、gh pr create/edit） |
| `ship-gate-hook.ts` | **L1 `tool_call` 钩子的入口**：`evaluateToolCall` 分派到两条臂，`ShipGateHookDeps` 汇总两条臂的 deps |
| `ship-gate-edit-guard.ts` | L1 的 **edit/write 臂**：敏感文件安全底线（`sensitiveEditBlock`，`normal` 模式也生效）、gate-owned 豁免、L8 目标门、orchestrator 写限制、L6 标签检查；检查次序即契约 |
| `ship-gate-bash.ts` | L1 的 **bash 臂 = ship gate 本体**：tmux backstop、`/gate-bypass`、ship 识别、L5/AI 署名、message-only rewrite 豁免、逐 repo 门禁、一次性仲裁令牌、拦截文案（`describeShips` / `buildShipBlockReason`） |
| `task-mode.ts` | 会话门禁模式模型：normal < explore < loop < orchestrator 与升降级规则 |
| `text-appeal.ts` | 启发式文本拦截的申诉口子（A 类） |
| `tool-host.ts` | 每个 `lib/` 工具注册模块共用的 host 类型 seam（`orchestrator-deps.ts` 只是 re-export 它） |
| `ui-widget.ts` | TUI widget 的纯内容构造（editor 下方那条**单行**状态条，详情在 `/gate-status`） |
| `user-interaction-tools.ts` | 工具 `ask_user`（采访的执行侧：暂停循环、逐题落盘、双方抢答），并且是「用户交互工具族」的**唯一注册入口**（自己转注册 `consent-request-tools.ts`） |
| `verdict-parse.ts` | 裁决解析：review 只认 JSON fence，precommit 只认 `## Overall:` sentinel |
| `workflow-commands.ts` | 工作流命令的定义与提示词组装，含 `--execute` 授权字的严格解析 |
| `workspace-branch.ts` | 保护分支检测（main/master/dev/develop）：checkpoint 前的确认框与 ship 拒绝（2026-09-07 起 `setup_workspace`/工作分支/squash 落地全部退役，只剩这个软护栏） |

---

## 六、动手前的四个自问

1. **它是判定还是接线？** 判定进 `lib/` 的纯模块（facts in, decision out）
   并配单测；只有把判定挂到事件上这一步才碰 `extensions/review-gate.ts`。
2. **它离开 pi 还必须成立吗？** 必须 → `hooks/` + `scripts/`（bash / CJS /
   MJS，不能 import TypeScript）；不必须 → `lib/`。
3. **它是新工具族吗？** 是 → 照 `lib/judge-session-tools.ts` 与
   `lib/orchestrator-*-tools.ts` 的形状：判定与工具注册都在 `lib/`，经
   `lib/tool-host.ts` 那道 seam 拿依赖，别再往那个七千余行的文件里加。命令族
   同理，形状见 `lib/gate-command-tools.ts`（seam 是它自己的 `CommandHost`）。
4. **它测得动吗？** 同名 `test/foo.test.ts` 是常态（98 个模块里 75 个有）；
   其余 23 个里多数并进相邻的分组测试（`test/orchestrator-atoms.test.ts`、
   `test/orchestrator-tools.test.ts`、`test/extension-structure.test.ts`），
   但个别模块——`agent-directives.ts`、`orchestrator-dispatch.ts`——在 `test/`
   下**零引用**，正是本问说的那种情形。真正的判据不是
   文件名对不对，而是**这条规则能不能被一个测试单独点名**——做不到，就说明它
   被埋在了工具体或接线里，`reviewer` 可以直接开 P1。
