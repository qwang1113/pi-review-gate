# pi-review-gate — 5 分钟上手

质量门禁：**未通过独立 review + precommit，`git commit` / `git push` / `gh pr create` 一律被硬拦截**。本文件是快速上手；完整设计、威胁模型与全部命令见 [README.md](README.md)。

## 1. 安装

```bash
pi install /absolute/path/to/pi-review-gate   # 或 npm:pi-review-gate
# postinstall 自动：复制 agents、注册依赖包、安装 git hooks（当前目录是 git 仓库时）
```

然后 `/reload`（或重启 Pi）。其他仓库想装 hooks（会话外的防御）：

```bash
bash <package-root>/scripts/install-git-hooks.sh   # 在目标仓库内执行
```

## 2. 四种会话模式（agent 启动时自行分类，也可你随时 `/gate-mode` 切换）

| 模式 | 行为 | 适用 |
|------|------|------|
| `loop` | 完整门禁：review READY + precommit PASS 才能 ship；未满足时自动继续 | 写代码、改文档、交付 |
| `explore` | 门禁 advisory，ship 命令仍被拦；agent 可自行结束 | 调查、分析、排障 |
| `normal` | 门禁完全关闭（agent 不能自己选，需你确认） | 闲聊、杂事 |
| `orchestrator` | loop **加上**编排约束：本会话只统筹、不写代码，先要你批准一份 plan 才能开子会话；`declare_done` 还要求任务队列清空、没有活着的子会话 | 一轮上下文做不完的大需求 |

`orchestrator`（项目经理）模式需要 tmux —— 它的子会话就是你那个 window 里的 pane。
它自己不拼 tmux 命令，全部走十个工具：`orchestrator_plan`（写/提交 plan，提交时门禁
先派 `goal-auditor` 审一轮）、`orchestrator_spawn`（按 plan 任务开子会话）、
`orchestrator_wait`（它唯一的信息入口，`timeoutMs: 0` 即快照）、`orchestrator_answer`
（代答子会话弹出的问题）、`orchestrator_instruct`（给子会话发话/打断）、
`orchestrator_close`（关掉某个 pane）、`orchestrator_recover`（pane 死了原地复活）、
`orchestrator_attach`（换人接手一次读回全局）、`orchestrator_handoff`（上下文快满时接力）、
`orchestrator_notify`（**只有它**能发系统通知，且有节流）。

## 3. 一个典型 loop 会话长什么样

```
你：实现分页功能
agent：调 set_gate_mode("loop")
  → setup_workspace（**一次调用**：问你工作区里已有的改动怎么办，再定下基准分支、
     建好本会话的工作分支；没有工作分支时 commit 一律被拒）
  → 用 ask_user 问你目标（一次一题，N of M）→ 用简体中文起草目标
  → propose_loop_goal（**一次调用**：门禁自己起 goal-auditor 子进程预审这份草案、
     等它退出、记录裁决；不通过就把 findings 退回来让你改，**不弹任何对话框**骚扰你）
  → 过了才弹窗让你批准（窗中会显示「goal-auditor 预审: PASS @ …」）
  → 改代码
  → judge_submit({role:"reviewer", task:<本轮改动说明>})
     **这一次调用**里门禁依次跑完：full precommit → checkpoint 提交（READY 前唯一
     的 commit 通道）→ 算不可变审核范围 baseline..HEAD + 开 findings 流 → 派 reviewer。
     任一步失败就带原因打回，不留半提交状态。
     同时：agent 边读流式 findings 边修（不用等审完）
  → judge 进程退出时门禁自己读结论、机械校验（未 prepare ⇒ 不授予；HEAD 已移动 ⇒
     STALE ⇒ BLOCKED）、记录裁决并唤醒 agent
  → BLOCKED？修 → 再来一轮；READY？declare_done（门禁自己把工作分支合回你在
     setup_workspace 里确认的基准分支；冲突就中止、列出文件交还给你）
```

- **工作区与分支归门禁管**：`setup_workspace` 一次问清工作区里已有的改动怎么办、
  基准分支是哪个，并建好本会话的工作分支（在那之前 edit 被拦、commit 被拒）；
  READY 之后 `declare_done` 自己把工作分支合回那个基准分支，冲突则中止并把文件
  列给 agent —— 你不用手动 checkout / merge。
- **precommit 在 review 之前**：这个顺序由门禁保证，不需要谁记着 —— 便宜的检查先跑，
  贵的审核只花在绿树上。
- 每轮按 ROUND 计费：**把相关改动批量做完再触发一轮**，比十个小轮省十倍。
- 只想知道「能不能构建」而不开一轮审查：用 `/precommit`（full）或 `/precommit-fast`
  —— 这两条命令由**门禁自己执行**并直接打印裁决，不消耗 agent 的一轮。

- **绑定是内容寻址的 commit tree**：`git add`、`git commit`、切分支、以及 squash checkpoint
  链（内容不变）都不会破坏绑定，READY + PASS 依然有效——**不要为了"重建绑定"而重跑一轮
  review**（那是纯浪费）。只有提交内容变化（新的 checkpoint / 编辑 / lint:fix 改写）才会
  让绑定失效。
- **复审要带上一轮结论**：第 N+1 轮把上一轮的 verdict 与 findings 交给 reviewer；
  已定论且未改动的部分只做一致性扫描，不重新论证（门禁会自动注入这段 scope）。
- **reviewer 审的是不可变 commit 范围，你可以边审边修**：`judge_submit` 先把改动提交成
  checkpoint（READY 前唯一的 commit 通道，要求 precommit full 通过），reviewer 审
  `baseline..HEAD`。被审历史不可变，你边读流式 findings 边修真实工作树，互不干扰。
- **审核目标是机械校验的**：门禁在记录裁决时验证本轮确实 prepare 过（否则不授予 READY）、
  HEAD 没有越过被审提交（越了 ⇒ STALE ⇒ BLOCKED，findings 仍然算数）；READY 绑定被审
  commit 的 TREE（内容绑定——之后把 checkpoint 链 squash 成一个提交，READY 依然有效）。

## 4. 配置（可选）

- 项目配置：`.pi/review-gate.json`（每克隆一份）
- 用户全局兜底：`~/.pi/review-gate.json`（同一文件格式；项目字段优先，逐字段合并）
- 可用字段：`maxRounds`(3–50)、`thinkHarder`、`gitMemory`、`docSync`(默认开)、
  `llmGuards`、`arbiter`、`copilotReview`、`agents`（各角色的 auto/slots 模型槽位，
  可选）、`precommit`（各步骤的 script/command/skip）
- 生成器：`/gate-init` 一次性向导生成配置（precommit 各步骤 + 用户点名的 agents
  槽位与标量字段），项目已有配置为准合并；未点名的字段不写默认值（会遮蔽全局
  配置）；无效模型 spec 拒绝写入，`/reload` 后渲染生效。

## 5. 常见"被 block"场景与逃生

| 现象 | 原因 | 处理 |
|------|------|------|
| `loop mode requires an approved loop goal BEFORE any edit/write call` | loop 模式（含未决）还没确认目标就动手编辑 | 先逐轮问清"done"的定义 → 中文起草 → `propose_loop_goal`（它自己跑 goal-auditor 预审，过了才弹对话框让你确认）；批准前 edit/write 一律被拦（`.pi/` 与 `.pi-subagents/` 门禁自有文件除外；explore/normal 模式不要求 goal） |
| `propose_loop_goal refused — no goal-auditor pre-review has been recorded` （或 `…belongs to DIFFERENT text`） | 审计没过，或过了之后又改过字（hash 变了） | 按退回来的 findings 改草稿，**再调一次 `propose_loop_goal`** —— 它会重新跑审计（重审时自动带上一轮结论与草稿差异）。没有第二个调用要做 |
| `goal-auditor` 角色不可派发（拒绝文案里的 BOOTSTRAP 段） | `~/.pi/agent/agents/goal-auditor.md` 缺失 | 开一个新会话（扩展会在启动时从包内 `agents/` 幂等自愈）；仍缺失就跑 `/gate-doctor` 看诊断行给出的 `node …/scripts/install-package.mjs` |
| `code review gate is PENDING` | 改完没 review | 走 review 循环（或 `/review`） |
| `precommit not run` / `FAILED` | 没跑或跑挂了 | 直接 `judge_submit({role:"reviewer"})`（它自己先跑 full lane）；只想看构建结果就 `/precommit`；修失败项 |
| `fingerprint mismatch` | 审核后又改了文件 | 再 review + 再 precommit |
| `docSync enforced` | 代码改动缺文档 attestation | reviewer 在 verdict 里给 `UPDATED`/`NOT_NEEDED` |
| commit/PR 文案非英文 | L5 硬拦截（majority-body 判定） | 改成英文；或你执行 `/gate-bypass <reason>` |
| `Unknown JSON field: "headRefOid"` | gh 版本过老 | 已自动 fallback（升级 gh 更佳） |
| 模型 429 / 额度耗尽，循环空转 | provider 限流，注入再多也没用 | 熔断器会在连续无进展后停止注入并提示；`/model` 切到其它 provider（如 anthropic），你的下一条消息即恢复循环 |
| agents 副本与仓库不同步（正文过时） | `~/.pi/agent/agents/*.md` 落后于本仓库 | 重跑 `node scripts/install-package.mjs`（幂等）；用 `/gate-doctor` 检出 |
| `STALE`（裁决被记成 BLOCKED） | prepare 之后又有新 checkpoint 提交，reviewer 审的是更旧的 commit | 把新改动并入，再 `judge_submit` 跑一轮；旧 findings 仍然有效 |
| `orchestrator 模式需要 tmux` | 想进项目经理模式，但 `$TMUX` 为空 —— 它的子会话就是你那个 window 里的 pane | 在一个 tmux window 里启动会话再 `/gate-mode orchestrator`。**judge 不受影响**：reviewer / adviser / goal-auditor 是 `pi -p --session-id` 非交互进程，不用 tmux |
| `~/.pi/review-snapshots/<repo-key>/` 里堆了 `rg-review-snap-*` | 旧版本遗留的孤儿快照（新模型不再创建快照） | 手动清理：`git worktree prune` + `rm -rf ~/.pi/review-snapshots/<repo-key>/rg-review-snap-*` |
| `git commit` 报 `.git/hooks/pre-commit: No such file or directory` | 有人在旧快照里跑了安装脚本：快照是 linked worktree，**`.git/hooks` 与真仓库共享** | 在**真工作树**重跑 `bash scripts/install-git-hooks.sh` |
| 想完全绕过 | — | 你执行 `/gate-bypass <reason>`（会话内）或会话外用 `REVIEW_GATE_BYPASS=1`（仅 hooks 层）；注意 `/gate-bypass` 只解除 L1 ship gate，**解除不了 L8 的 edit/write 硬拦**——未确认 goal 前编辑仍被拦 |

## 6. 常用命令

| 命令 | 作用 |
|------|------|
| `/gate-status` | 模式、verdict、轮数、未满足项 |
| `/gate-mode loop\|explore\|normal\|orchestrator` | 你手动切换模式（`orchestrator` 需要 tmux） |
| `/gate-bypass <reason>` | 你授权本会话跳过 ship 拦截 |
| `/review`、`/precommit` | 显式触发 review / precommit |
| `/gate-reset` | 重置门禁状态 |
| `/gate-lesson <text>` | 记录经验教训 |
| `/gate-doctor` | 只读体检：逐项检查优化是否生效（模型链、goal-auditor 角色可派发性、opencode-go 白名单、precommit runner、git hooks、全局配置、L5 门、Copilot gh、命令注册），输出 PASS/FAIL/WARN + 证据 + 修复建议 |

## 7. 成本须知

- review 用顶级推理模型（每轮一个 reviewer，审整个 diff），**按轮计费**——批量编辑再触发；
- `opencode-go` provider 在代码层面**只允许 deepseek-v4-flash**（其余模型按次计费且被显式禁止）；
- review 不跑 pdw 引擎，也不走子代理派发：judge 角色由 `judge_submit` 起成独立 pi 进程（不带门禁扩展）跑，**每轮一个 reviewer 一个 commit 范围**，不分片、不双审；子代理调度 judge 角色会被硬拦截；
- decompose / wave daily 已移除（2026-08-26）：大的任务切成同一单审循环的连续轮次，无模块表、无波次调度、无 plan 状态。
