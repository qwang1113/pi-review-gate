# 执行模型：独立 pi 进程子会话 + commit 审核（execution-model）

本文记录 pi-review-gate 的 review 执行模型（2026-08-28 起）——judge
角色（reviewer / adviser / goal-auditor）以**非交互 pi 进程**
（`pi -p --session-id <id>`）运行，审核单元为 "checkpoint commit"。
它是实现与审核的参照；流程约定见 `docs/dev-flow.md`，Judge 角色契约见
`docs/judge-protocol.md`，代码规范见 `docs/coding-standards.md`。

## 为什么

模型经历过两次迁移，各解决了上一版一个测量过的失败模式：

1. **subagent 黑盒**（2026-08-27 前）：reviewer 以一次性 subagent 运行，
   主会话看不见它在做什么，无法中途对话，每轮从零开始。
2. **tmux pane 壳子**（2026-08-27 ~ 08-28）：judge 是 tmux 子会话里的
   独立 pi 进程，可见、可中断、跨多轮复用上下文——但 pane 是**显示壳**，
   生命周期、信号、布局、`wait-for` 无超时、多行输入被 TUI 撕碎、
   崩溃后「pane 没了但 exit-code 没写」的歧义，全部成本都在这一层。

2026-08-28 起，壳子退役：judge 是 `pi -p --session-id` **非交互进程**，
`--session-id` 按 role+repo 确定性派生，进程退出即完成，同一 id 再拉起
即续接同一段上下文。隔离仍来自 **commit 本身**：每次送审前主会话把改动
提交为 checkpoint commit，审核者审 `baseline..HEAD`（不可变历史）。

## 运行形态：进程，不是 pane

- judge = `pi -p --no-extensions --no-skills --exclude-tools edit,write
  --system-prompt <SP> --model <M> --session-dir <dir> --session-id <id>
  @<task文件>`。非交互：处理完 prompt 即退出；stdout/stderr 由扩展 tee
  到本轮 `stdout.log` / `stderr.log`。
- **session id 是 resume 键**：`rg-<role>-<repoHash>`（确定性派生）。
  同 role + 同 repo 再 spawn 同一 id ⇒ 延续同一段对话（跨轮、跨主会话
  重启、跨天都成立——pi 把上下文存成 `.jsonl`，不依赖进程存活）。
- **任务文本**走 `@file` argv 引用（写入 `sessionDir/task-<ts>-<rand>.md`）：
  无 argv 长度问题，也无 TUI 撕多行的问题（非交互模式本来就没有 TUI）。
- **值直接进 argv**（spawn 数组），没有 shell，没有插值面——配置提供的
  model spec / 路径不可能变成 shell 语法。
- 角色正文从三层解析：repo `agents/` → 包内置 `agents/` →
  `~/.pi/agent/agents/`。模型：`auto:false` 取 `slots[0]`；`auto:true`
  取角色 frontmatter 默认。子会话是单模型进程，fallback 链是 subagent 概念。

## 生命周期与 liveness

- **完成 = 进程退出**（操作系统保证）。扩展持有 ChildProcess 对象本身：
  `child.exitCode === null` ⇔ 存活——没有 PID 复用歧义、没有 pane 探针。
- 每轮 spawn 写 `runs/<ts>/`：`pid`（`<pid> <启动时刻>`，供跨会话接管）、
  `exit-code`（**存在**即"已结束"的权威事实）、`stdout.log`、`stderr.log`。
  `lib/judge-session.ts` 的读取逻辑（exit-code 优先、pid 身份三态判定）
  保留，用于**主会话重启后**按 pid 文件接管/清扫孤儿。
- **一轮只能交给一个空闲的 role**：同 role 进程仍在跑 ⇒ 本轮**拒绝受理**
  （非交互 judge 只在 spawn 时读一次任务，没有中途投递的通道；假装受理
  就会让主会话等一个从未送达的轮次）。等它退出后再提交，或 `fresh: true`
  先 SIGTERM 旧进程。
- **上下文复用靠 session，不靠进程**：已结束的进程先清出 registry，下一轮
  用同一个 session id 重新 spawn —— pi 追加进同一个 jsonl，上下文原样延续。
  「是否续接」由该 role 的 sessionDir 里是否已有 transcript 决定。
- **孤儿接管**：主会话重启后 registry 重建，按 `.pi/judge-sessions/`
  下的 pid/exit-code 文件判定旧进程是否还活着，活着的可继续（同 id
  resume），死了的清理。

## 通信

- **完成信号**：没有信号——进程退出即完成。扩展在 spawn 时注册
  `child.on("exit")`，回调 `pi.sendMessage(..., { triggerTurn: true,
  deliverAs: "steer" })` 主动唤醒主会话——不轮询。
- **提问**：judge 把问题作为**最后一个 fenced JSON 输出**并退出
  （`{"question": "...", "context": "..."}`）；主会话读到 question fence
  后带着答案用**同一个 session id** 重新拉起（再 `judge_submit` 同一 role 即可），
  上下文原样延续。没有 inbox 文件、没有 channel。
- **流式 findings**：追加到 `.pi/review-stream/<round>.jsonl`
  （仅证据，禁止 verdict 形状的行）。
- **定向 parent 用户注意**（round-18）：`propose_loop_goal` 弹窗与
  `ask_user` 只通知**启动本会话的那个会话**（parent）。parent
  标识在启动时经环境变量 `RG_PARENT_SESSION` 传入；事件走旁路文件
  （`~/.pi/agent/review-gate-attention.json`，跨 repo 可读）。没有
  tmux 信号侧（2026-08-28 起 defaultSignal 为空操作）——文件即送达，
  parent 在自己的 turn 边界消费。**无 macOS 通知**（用户要求）。
- **主会话存活不变量**（round-18，用户硬约束）：门禁未通过前主会话**不得**
  停止自动循环。`agent_settled` 的 `classifyChildren()`（lib/child-watch.ts）
  托管等待：进程已退出或静默超时的子会话**立即结束等待**（注入
  `REVIEW_GATE_CHILD_ENDED`：judge_read 读取已有输出继续 / judge_close
  后重新派发）；仍在飞的子会话注入 `REVIEW_GATE_CHILD_HOST_WAIT`
  （先做确定性工作；确实没别的可做时调 `judge_wait({role})`，它在门禁里
  跑同样的三条判据并把结论带回来）。仅三类
  情形允许停止：用户显式中止（ESC）、`ask_user` 等待用户回答、
  所有门禁与 goal 均完成。
- **子会话终止的三条独立判据**（round-18 起，实测失败模式：子会话已输出
  verdict 但进程未退/未退出，主会话阻塞空等）：(a) 进程 exit 事件；
  (b) **进程已结束**（`exit-code` 文件出现，或记录的 pid 已不在——用
  `kill -0 <pid 文件第一段>` 判定，崩溃的子会话可能来不及写 exit-code，
  它同样算已结束）；(c) 静默超过 `STALL_MOTION_MAX_AGE_SEC`
  （lib/loop-stall.ts，600 秒），按 `lastActivityAt` 计时——取自子会话
  自己的写入（transcript / stderr / stdout 中最新 mtime），只有一次都没
  写过时才回退到 `spawnedAt`。任一命中主会话自行恢复推进——子会话的
  完成信号是**加速器，不是前提**。
- **结论取数**：进程已结束时读它自己的 transcript——`sessionDir`
  （启动时记录）下**顶层**（不递归，避开 `subagent-artifacts/`）mtime
  最新的 `*.jsonl`，取**最后一条含 verdict fence 的 assistant 文本**。
- **排查**：`tail -f <runDir>/stdout.log`（实时）、grep sessionDir 的
  jsonl（结构化输入输出）、`pi --export <jsonl> <out.html>`（完整回顾）。
- **等待期的可见性（2026-08-29 起，默认开启）**：耗时工具通过 `execute` 的第
  4 个参数 `onUpdate` 发**进度快照**（`lib/progress-stream.ts`，节流 2s）：
  `judge_wait`（每次探测重发 stdout 尾部 + findings 计数）、`judge_submit`
  的送审链（precommit → checkpoint → prepare → spawn，逐步报）、
  `run_precommit`（runner 日志作为步骤尾部）、`declare_done`（门禁复检 →
  合并）、`request_copilot_review` / `check_copilot_review`（每次网络调用一
  步）。进度只进 partialResult，**不进** agent 拿到的 tool result——两条通
  道回答不同的问题。`tool_call` 钩子没有 `onUpdate`，所以 6 处 LLM 判定
  （L5 语义 / L6 标签 / ship 分类 / AI 署名）改用状态栏：超过 ~3s 才提示一
  次，结束即清除。
- **`judge_wait` 的返回值**：本轮结束 ⇒ 结论正文 + 本轮 stdout 尾部；未结束
  或超时 ⇒ 当前进度（stdout 尾部 + findings 流最近几条）。它与上面的流式快
  照互不替代：快照给人看，返回值给 agent 读。

## 审核单元

送审是**一次调用**：`judge_submit({role:"reviewer", task:<本轮改动说明>})`。
门禁在这一次调用里依次跑完下面四步，任一步失败就带原因打回（不留半提交
状态）；这些工具本身仍然注册着，作为需要单独跑时的高级入口。

- `run_precommit`（full lane）：不过就打回。
- `review_checkpoint`：`git add -A && git commit`（英文 message 校验，
  commit 标题由门禁打上 checkpoint 标记）→ 记录 commit sha 与它落在哪条
  分支（branchOps）。只绕过 READY，不绕过 precommit；普通 `git commit`
  在 READY 前仍被拦，且只能落在本会话的工作分支上。
- `prepare_review`：计算 `baseline..HEAD`（自上次审核基线以来的 commit），
  生成任务文本与 findings 流路径，注册审核目标。
- dispatch：spawn 或续接该 role 的 session。

verdict **不在返回值里**：judge 进程退出时门禁自己读它的结论并调
`record_review`——审核目标仍是 HEAD（审核期间新增 checkpoint ⇒ STALE ⇒
BLOCKED），READY 绑定审核 commit 的 **tree**（内容绑定，squash 重写历史
不改变内容时绑定存活；`reset --soft` 实测 tree oid 不变）。主会话被唤醒时
拿到的已经是记录后的结论。
- ship 授权（unmetRequirements）：READY 与 precommit PASS 均绑定
  commit tree；push/PR 时验证 HEAD commit tree 与绑定 tree 一致且自
  基线以来无未审核 commit。
