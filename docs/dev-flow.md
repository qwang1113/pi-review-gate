# 开发流程约定（dev-flow）

本文件是 pi-review-gate 的**开发与审核流程约定**：主会话如何推进一个任务、
各审核角色如何运行、门禁如何配合。所有角色（主会话、审核者、目标审核者、
建议者）都必须遵守。它描述"流程怎么走"，代码规范见
`docs/coding-standards.md`，Judge 角色的共同契约见 `docs/judge-protocol.md`。

## 执行模型

- **主会话**：带门禁的 pi 会话，负责全部写操作与流程协调。
- **子会话**：用户 window 里与主会话同窗的独立 pane 中的**交互 pi 进程**
  （门禁以 judge 模式加载：reporting-shell 工具集 + heartbeat 上报 +
  `judge_conclude` 落 report），承载所有 Judge 角色（goal-auditor / reviewer /
  adviser）。同一工作区、
  同一分支；cwd 为仓库根目录。session id 按 role+repo 确定性派生，所以同一角色
  跨轮复用同一段上下文；judge 调 `judge_conclude` 交卷并停下（不退出进程），
  结构化结论直接进 channel report，opener 凭它记录结论。
- **只读探查**：并行的只读代码/文档探查并行安全（读者不写工作树，
  不会失效审查绑定）。L1/L2 执行层（recon / fixer）及其 subagent 派发已随
  pi-subagents companion 退役（2026-09-06）。
- **门禁**：`git commit` / `git push` / `gh pr` 在 READY + precommit 通过前
  一律硬拦；`review_checkpoint` 是送审前唯一的提交通道。

## 阶段 0：目标起草

用户提出任务 → 主会话调研（查代码/文档，可并行只读探查）→ 起草目标文本
（任务标题、意图、3–7 条可检查的验收标准、非目标、ISO 日期），简体中文
（标识符/路径/代码 token 保持英文）。

## 阶段 1：目标审核（judge pane · goal-auditor）

1. 目标文本送审 → goal-auditor 子会话按 `docs/judge-protocol.md` 审核。
2. 审核期间主会话继续做确定性工作（必做的修改/查询/调研），不空等。
3. 驳回 → 修改目标 → **同一子会话**复审（上下文复用）→ 通过。
4. 通过后由用户在确认框批准——这是全程唯一的人工审批点。

## 阶段 2：开发实现

主会话按已批准的目标开发，遵守 `docs/coding-standards.md`；实现中可按需
咨询 adviser（子会话，多轮对话）。

## 阶段 3：送审循环（每轮）

1. 改完调**一次** `judge_submit({role:"reviewer", task:<本轮改动说明>})`：
   门禁自己按顺序跑 precommit（全量）→ `review_checkpoint`（英文 message）→
   `prepare_review`（算 `baseline..HEAD`）→ 派 reviewer，任一步失败就带原因
   打回，不留半提交状态。
2. reviewer 的任务文本携带本轮 commit range、目标、上一轮结论。
   审核者只审 **commit 内容**（`git diff <range>`），不重跑全量检查；
   需要验证行为时把被审 commit 临时 checkout 到 `$TMPDIR` 的 worktree 里跑
   （或在工作区直接跑并视为 ADVISORY——主会话可能同时在编辑，结果可能被污染）。
3. 审核者边审边把 P0/P1/P2 **流式**写入 findings 文件，主会话边收边修
   （先自己确认再改）。
4. **BLOCKED** → 修复 → 回第 1 步（同一子会话复审，增量聚焦本轮改动）；
   **READY** → 进入阶段 4。

## 阶段 4：收尾

1. READY 时检查工作区：还有未提交修改就停下确认内容，必要时问用户。
2. Squash checkpoint 链成干净历史（READY 后 commit 放行）。
3. `git push` / `gh pr create`（READY + precommit 均绑定最终 commit）。

## 贯穿机制

- **状态同步（标准报告唤醒，非轮询）**：judge 调 `judge_conclude` 交卷并停下（不退出
  进程，pane 留给下一轮复用）；交卷把结构化结论写进 channel report，门禁在每次
  settle 时看到新 report 即记录 verdict，再用标准报告唤醒主会话。父会话不手写轮询、
  不直读 transcript——确实没活可做时调 `judge_wait`（消息驱动：新 finding / judge 提问 /
  本轮结论 / pane 消失任一到达即返回，返回的是同一份标准报告）。
  pane 消失但 verdict 未落盘时本轮不算结束，opener 以同一 session id

  重开 pane 续接（`judge_recover`）。judge 有疑问时调 `ask_user`（人与 opener 经通道
  竞态，先答先生效），等答案时停下、不退出 pane。
- **消息送达（argv + 文件）**：任务文本落盘（`.pi/judge-sessions/<role-repo>/sessions/task-<ts>.md`），
  以 `@file` 形式进 argv 做首条消息——pane 内是交互进程，但任务文本不走键盘，也就没有多行被拆碎的问题。
- **清理（时机是关键）**：judge pane 的生命周期归门禁，**不在任务中途关闭**——目标可能因
  新需求而修订（goal-auditor 要复审）、代码可能被打回（reviewer 要复审），它们的上下文就是复审
  时的记忆。只在以下时机回收：verdict 终结（READY 落盘）、opener 放弃本轮（`fresh: true` 重派）、
  换 review 对象、或 `declare_done` 联关（已记录的 verdict 保留，未落盘的轮次放弃）。崩溃遗留的
  pane 由门禁按 pane 名单 + 注册表回收，无需手动 kill。
- **公正与收敛**：每轮送审的提示词只带本轮范围；客观中立、一类问题列全
  的要求在子会话**系统提示词**中一次性注入（见 judge-protocol.md），主会话
  发现走偏时在下一轮 `judge_submit` 的任务文本里直接纠正。
- **一个 worktree 一个门禁会话（2026-09-05 起，用户可见行为变更）**：同一个
  checkout 里第二个「占用主 sidecar」的会话**不再只是收到一句警告，而是被拒绝**
  ——edit/write、ship、门禁自己的 checkpoint 提交与 goal 落盘全部拦下，提示里
  指名占用者（session / pid / host / 最后心跳）并给出两条出路（`git worktree add`
  的实际命令，或关掉那个会话）。判活靠新的心跳文件 `.pi/session-presence.json`
  （随 `.pi/` 一起被 gitignore，不进版本库）：**只看心跳新鲜度**，`pid`/`host` 仅
  作诊断；文件缺失、内容损坏、时钟异常一律**放行**（这里的 fail-safe 方向与门禁
  其他处相反——被决定的是「要不要拒绝你自己的 checkout」）。占用者关闭后**无需
  手工删文件、也无需重开会话**：约一分钟内定时复检自动解除并接管。
  - **谁不受影响**：judge pane 与编排子会话——它们本来就与 opener 同处一个
    worktree，且不写主 sidecar（judge 不写门禁状态、子会话写自己的
    `RG_STATE_VARIANT` 分片），因此天然豁免。`normal` 模式也不发拒绝（该模式的
    定义就是门禁整体关闭）：worktree **空闲**时它照常写心跳，好让会 enforce 的
    会话看见它；worktree **已被占用**时它既不拒绝、也不写心跳——凭据属于占用者，
    覆盖它等于把保护抢走（而且退出时还会被自己当成「我的」删掉）。
  - **同时消失的**：旧的「another Pi session … last wrote this repo's gate state
    at …」四小时警告已删除——同一个问题只留一套存活判定（哲学三）。
- **judge 不再写主仓库门禁状态（2026-09-05，用户可见）**：`.pi/review-gate-state.json`
  的 `sessionId` / `taskMode` 不会再被 `rg-reviewer-…` 之类的 judge 会话覆盖，
  已记录的 verdict 也不会被它写回 PENDING。judge 跳过写入时只在自己的会话记录里
  留一条审计条目，不在被审仓库里落任何文件。**注意**：judge pane 跨轮复用同一个
  进程，加载的是开 pane 那一刻的磁盘代码，所以升级后**已经开着的** judge 仍是旧
  行为，新代码要等下一个新开的 pane 才生效。
- **配置保留**：`.pi/review-gate.json`（项目层）→ `~/.pi/review-gate.json`
  （全局层）→ 内置默认的三层配置原样保留：precommit 的
  lint/typecheck/build/test 配置、agents 的模型槽位（auto / slots /
  继承语义）不变，只是消费方式从渲染 agent frontmatter 变为子会话的
  `--model` / `--thinking` / `--system-prompt`。子会话是单模型进程：
  `auto:false` 取 `slots[0]`（链头），`auto:true` 取角色定义自身的
  frontmatter 默认；fallback 链只用于渲染层（`--model` 直传只取链头）。

## 审核单元：commit 而非工作区

- 每一轮审核只针对**送审的那个 commit**（自上次审核基线以来的
  `baseline..HEAD`），不针对工作区。
- commit 不可变，天然隔离：审核期间主会话可以继续修改工作区，互不干扰。
- 审核期间产生的新改动并入下一轮 checkpoint，随下一轮送审。
- READY 记录时若工作区仍有未提交内容：停下确认内容，必要时问用户，
  处理完再收尾。最终 push 前工作区必须是干净的。
