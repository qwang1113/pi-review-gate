# 开发流程约定（dev-flow）

本文件是 pi-review-gate 的**开发与审核流程约定**：主会话如何推进一个任务、
各审核角色如何运行、门禁如何配合。所有角色（主会话、审核者、目标审核者、
建议者）都必须遵守。它描述"流程怎么走"，代码规范见
`docs/coding-standards.md`，Judge 角色的共同契约见 `docs/judge-protocol.md`。

## 执行模型

- **主会话**：带门禁的 pi 会话，负责全部写操作与流程协调。
- **子会话**：tmux 里的独立 pi 会话（不带 review-gate 门禁），承载所有
  Judge 角色（goal-auditor / reviewer / adviser）。同一工作区、同一分支；
  cwd 为仓库根目录。
  **布局（pane 而非 session）**：不新建 tmux session，而是在主会话所在的
  window 内切 pane——主会话独占左列（约 2/3 宽），右侧列按角色数等分高度；
  所有子会话全程可见，无需 attach。主会话不在 tmux 内（无 $TMUX）时降级为
  新建独立 session。可见、可中断、跨多轮复用上下文。
- **探查 subagent**：廉价的只读探查角色（recon）保持 subagent 形态，
  只读、并行安全，主会话和子会话都可以派。
- **门禁**：`git commit` / `git push` / `gh pr` 在 READY + precommit 通过前
  一律硬拦；`review_checkpoint` 是送审前唯一的提交通道。

## 阶段 0：目标起草

用户提出任务 → 主会话调研（查代码/文档，可派 recon 并行）→ 起草目标文本
（任务标题、意图、3–7 条可检查的验收标准、非目标、ISO 日期），简体中文
（标识符/路径/代码 token 保持英文）。

## 阶段 1：目标审核（tmux 子会话 · goal-auditor）

1. 目标文本送审 → goal-auditor 子会话按 `docs/judge-protocol.md` 审核。
2. 审核期间主会话继续做确定性工作（必做的修改/查询/调研），不空等。
3. 驳回 → 修改目标 → **同一子会话**复审（上下文复用）→ 通过。
4. 通过后由用户在确认框批准——这是全程唯一的人工审批点。

## 阶段 2：开发实现

主会话按已批准的目标开发，遵守 `docs/coding-standards.md`；实现中可按需
咨询 adviser（子会话，多轮对话）。

## 阶段 3：送审循环（每轮）

1. 改完先跑 **precommit**（lint + typecheck + build + test 全量）——不通过
   就继续修，**通过了才允许送审**。
2. `review_checkpoint` 提交当前改动（门禁特批通道，英文 message）。
3. 送审到 reviewer 子会话：任务文本携带本轮 commit range、目标、上一轮
   结论。审核者只审 **commit 内容**（`git diff <range>`），不重跑全量检查；
   需要验证行为时把被审 commit 临时 checkout 到 `$TMPDIR` 的 worktree 里跑
   （或在工作区直接跑并视为 ADVISORY——主会话可能同时在编辑，结果可能被污染）。
4. 审核者边审边把 P0/P1/P2 **流式**写入 findings 文件，主会话边收边修
   （先自己确认再改）。
5. **BLOCKED** → 修复 → 回第 1 步（同一子会话复审，增量聚焦本轮改动）；
   **READY** → 进入阶段 4。

## 阶段 4：收尾

1. READY 时检查工作区：还有未提交修改就停下确认内容，必要时问用户。
2. Squash checkpoint 链成干净历史（READY 后 commit 放行）。
3. `git push` / `gh pr create`（READY + precommit 均绑定最终 commit）。

## 贯穿机制

- **状态同步（主动唤醒，非轮询）**：子会话完成时按协议执行 `tmux wait-for -S <chan>`（通过 bash）。
  主会话每轮发送任务后调用 **`review_watch`**（参数：channel、可选 label）注册后台监听——
  扩展在进程内 `waitForSignalAsync` 等待信号，exit 回调调用
  `pi.sendMessage({customType:"review-gate", ...}, { triggerTurn: true, deliverAs: "steer" })`，
  主会话空闲时立即被唤醒（官方 file-trigger 模式），不需要轮询或碰巧检查。
  session_shutdown 时取消全部监听。子会话退出/崩溃由 `tmux set-hook -t <pane> pane-exited` 通知，
  wait 超时后查 `paneAlive` 兜底。子会话有疑问时写入
  inbox 文件（`.pi/tmux-sessions/<id>/inbox.jsonl`），主会话读到后回复。
- **消息送达（单行 + 文件）**：pi TUI 会把粘贴的多行文本按行拆成多条消息，所以任务文本一律落盘
  （`.pi/tmux-sessions/<id>/task-<n>.md`），send 只发单行指令（"读取文件 X 并执行"）。
- **清理（时机是关键）**：judge 子会话的生命周期 = 整个任务周期，**不在任务中途关闭**——目标可能因
  新需求而修订（goal-auditor 要复审）、代码可能被打回（reviewer 要复审），它们的上下文就是复审
  时的记忆。只在以下时机关闭：任务收尾（READY 记录后 / declare_done 前，`review_close`）、
  显式重建（换角色 / 换视角）、或子会话崩溃。declare_done 检查残留会话并提示；崩溃遗留的 tmux
  会话可手动 kill，新会话启动时清理孤儿。
- **公正与收敛**：每轮送审的提示词只带本轮范围；客观中立、一类问题列全
  的要求在子会话**系统提示词**中一次性注入（见 judge-protocol.md），主会话
  发现走偏时直接 send 纠正。
- **配置保留**：`.pi/review-gate.json`（项目层）→ `~/.pi/review-gate.json`
  （全局层）→ 内置默认的三层配置原样保留：precommit 的
  lint/typecheck/build/test 配置、agents 的模型槽位（auto / slots /
  继承语义）不变，只是消费方式从渲染 agent frontmatter 变为子会话的
  `--model` / `--thinking` / `--system-prompt`。子会话是单模型进程：
  `auto:false` 取 `slots[0]`（链头），`auto:true` 取角色定义自身的
  frontmatter 默认；fallback 链是 subagent 启动概念，不适用于子会话。

## 审核单元：commit 而非工作区

- 每一轮审核只针对**送审的那个 commit**（自上次审核基线以来的
  `baseline..HEAD`），不针对工作区。
- commit 不可变，天然隔离：审核期间主会话可以继续修改工作区，互不干扰。
- 审核期间产生的新改动并入下一轮 checkpoint，随下一轮送审。
- READY 记录时若工作区仍有未提交内容：停下确认内容，必要时问用户，
  处理完再收尾。最终 push 前工作区必须是干净的。
