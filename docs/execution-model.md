# 执行模型：tmux 子会话 + commit 审核（execution-model）

本文记录 pi-review-gate 的 review 执行模型重构（2026-08-27 起）——
judge 角色从 pi-subagents 的 subagent 调用迁移到 tmux 子会话中的独立 pi
进程，审核单元从"工作区树 + 快照 worktree"改为"checkpoint commit"。
它是实现与审核的参照；流程约定见 `docs/dev-flow.md`，Judge 角色契约见
`docs/judge-protocol.md`，代码规范见 `docs/coding-standards.md`。

## 为什么

旧模型有两个测量过的失败模式：

1. **subagent 黑盒**：reviewer 以一次性 subagent 运行，主会话看不见它
   在做什么，无法中途对话，每轮从零开始。
2. **快照 worktree 隔离**：`prepare_review` 创建一次性 git worktree，
   主会话可以边审边修——但"审核者是否真的进了快照"依赖 spawn 观察与
   verdict 自报，且工作区树指纹（worktree 树哈希）作为审核绑定。

新模型把两者都换掉：

- judge 是 **tmux 子会话里的独立 pi 进程**（不带 review-gate 门禁），
  可见、可中断、跨多轮复用上下文；
- 隔离来自 **commit 本身**：每次送审前主会话把改动提交为 checkpoint
  commit，审核者审 `baseline..HEAD`（不可变历史），工作区树指纹退役。

## 布局：pane 而非 session

- 主会话在 tmux 内（`$TMUX` 存在）：第一个 judge 在**本会话自己的 window**
  切右列（`split-window -h -p 35 -t <ownPaneId()>`），后续 judge 以第一个
  judge 的 pane id 为 target 垂直切分（`split-window -v -p 50 -t <paneId>`）。
- **所有 tmux 调用一律显式 `-t`，禁止依赖“当前 pane”语义**（split-window、
  display-message、select-pane、respawn 等）。根因（2026-08-28 用数据确证）：
  无 `-t` 时 tmux 回退到 **server 的 active pane**，而它就是“用户此刻聚焦的
  窗口”——于是 judge pane 跟着用户焦点跑，落对落错全看 spawn 那一刻用户在看
  哪个窗口，这解释了此前全部“间歇性”。锚点定位见 `ownPaneId()`：
  `TMUX_PANE`（实测在扩展进程里有值）为快路径，进程祖先链（`list-panes -a -F
  '#{pane_pid} #{pane_id}'` 建 pid→pane 映射后沿 ppid 上溯）为 env 缺失/失效
  时的回退；“当前窗口”一律走 `ownWindowId()`（`display-message -p -t`）。
- **验收实验（唯一能证伪归属修复的实验）**：先把用户焦点切到*别的*窗口
  （`tmux select-window -t <other>`），再 `review_spawn` 一个 judge，断言
  `tmux display-message -p -t <新paneId> '#{window_id}'` 等于**本会话自己的
  window**而不是被聚焦的那个；做完把焦点还回去。**这个实验是唯一的端到端
  证伪手段，必须人工跑**：`test/tmux-session.test.ts` 里的自动化部分是
  **源码文本 pin**（断言 split-window / set-option 带 `-t`、所有
  display-message 带 `-t`、ownPaneId 两条解析路径存在）加一个真 tmux 下的
  ownPaneId 集成用例；模块内的 tmux 执行器不可注入，所以祖先链回退路径未被
  自动化覆盖。
  2026-08-28 实测：用户聚焦 `@39/@4`，新 judge pane 落在本会话的 `@365` —— 通过。
- `split-window -d`：新 pane 不抢焦点。
- pane id（`%N`）是显示句柄：send/capture 按 pane id。
- 主会话不在 tmux 内时降级为独立 session（同样不设任何保留选项）。
- **pane 只是壳子，被管理的是 pi 会话**（2026-08-28，用户要求）：不再设置
  `remain-on-exit`。该选项是 **window 级**的，为 judge 设置会连带影响
  同一 window 里**用户自己的 pane**——退出后不消失、显示
  `Pane is dead (status 0)`，这正是它被移除的原因。judge 退出后 pane 随之
  消失，右列不再堆积死 pane。
- liveness 与结论都来自**会话自身的落盘物**（`lib/judge-session.ts`）：
  `pid`（launcher 自身 PID，进程组 leader）、`exit-code`（pi 退出码，其
  **存在**即"已结束"的权威事实）、`stderr.log`（崩溃诊断）、
  `sessions/*.jsonl`（结论所在）。`exit-code` 优先于 pid 判定，避免 PID 复用
  把已结束的会话误判为运行中。

## 子会话

- 启动：`pi --no-extensions --no-skills -e npm:pi-subagents` +
  `--system-prompt`（角色正文 + judge 协议）+ `--model <配置链头>` +
  `--exclude-tools edit,write`（共享工作区里 judge 无写面）。
- **值一律走环境变量**（`tmux -e RG_*`），launcher 脚本零插值——
  配置提供的 model spec 不可能变成 shell 语法（round-2 P1）。
- 角色正文从三层解析：repo `agents/` → 包内置 `agents/` →
  `~/.pi/agent/agents/`。正文已从 subagent 时代迁移（无快照 /
  contact_supervisor 描述）。
- 模型：`auto:false` 取 `slots[0]`；`auto:true` 取角色 frontmatter
  默认。子会话是单模型进程，fallback 链是 subagent 概念。

## 通信

- **送达**：`tmux send-keys -l <单行> Enter`（Enter 必须独立调用，
  `-l` 后一切按字面）。多行文本会按行拆成多条消息（实测），所以任务
  文本一律落盘，send 只发"读取文件 X 并执行"。
- **完成信号**：子会话完成时运行 `tmux wait-for -S <chan>`；主会话
  侧（扩展进程内）`waitForSignalAsync` 监听，exit 回调
  `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`
  主动唤醒主会话——不轮询。
- **提问**：子会话写 inbox 文件（一行 JSON）后运行
  `tmux wait-for -S <inbox-chan>`；inbox-chan = inboxChannelFor(title)，
  即 `rg-<title>-inbox`（独立 channel，**不是** done channel 字面加
  "-inbox" 后缀）；主会话监听 inbox 通道回复。
- **流式 findings**：追加到 `.pi/review-stream/<round>.jsonl`
  （仅证据，禁止 verdict 形状的行）。
- **定向 parent 用户注意**（round-18）：`propose_loop_goal` 弹窗与
  `pause_for_question` 只通知**启动本会话的那个会话**（parent），不再全局广播。
  parent 标识在启动时经环境变量 `RG_PARENT_SESSION` 传入；子会话发布到
  `rg-attention-<parentSessionId>`（`attentionChannelFor()` 派生，按目标
  session id 寻址，两个会话永不共享一个 bell）；每个会话只在 `session_start`
  注册**自己的** channel（无 session id 的匿名宿主不注册，也无地址可被唤醒）。
  没有 parent 的独立会话 `publishAttention` 直接返回 `no-parent`，不写文件、
  不发信号——**永远不会唤醒无关会话**（round-17 实测：`nvim(@1) onchain：等待
  回答提问` 打进毫无关系的会话）。事件仍走旁路文件（全局
  `~/.pi/agent/review-gate-attention.json`，跨 repo 可读）：载荷含
  `fromSessionId/toSessionId/fromPane/fromWindow/repo/reason/createdAt/
  handledAt`；消费端只取**发给自己的**事件。同一 `(repo, reason, parent)` 在
  节流窗口内只发一次；已 handled / 超时事件忽略。**无 macOS 通知**：
  `osascript` 已从代码中移除（用户要求），唤醒就是 parent 会话 transcript 里
  的一条消息。所有外部副作用（tmux 信号、监听注册）统一经
  `sideEffectsEnabled()`——测试 / CI / 非 TTY / 无 tmux 一律静默。
- **主会话存活不变量**（round-18，用户硬约束）：门禁未通过前主会话**不得**
  停止自动循环。`agent_settled` 不再 `if (judgeChildInMotion()) return;` 放任
  idle——改为 `classifyChildren()`（lib/child-watch.ts）托管：会话已结束或静默
  超时的子会话**立即结束等待**（注入 `REVIEW_GATE_CHILD_ENDED`：review_read
  读取已有输出继续 / review_close 后重新派发）；仍在飞的子会话注入
  `REVIEW_GATE_CHILD_HOST_WAIT`（先做确定性工作；无可做时用一次 bash 同时盯
  三条判据，见下）。仅三类情形允许停止：用户显式中止（ESC）、
  `pause_for_question` 等待用户回答、所有门禁与 goal 均完成。
- **子会话终止的三条独立判据**（round-18，实测失败模式：子会话已输出 verdict
  但未发完成信号，主会话阻塞空等）：(a) done channel 信号；(b) **pi 会话已结束**
  （`exit-code` 文件出现，或记录的 `pid` 已消失——2026-08-28 起不再用
  `#{pane_dead}`：pane 已随 judge 一起消失，且启动即崩的 judge 本就无 pane
  可查）；(c) 静默超过
  `STALL_MOTION_MAX_AGE_SEC`（lib/loop-stall.ts，600 秒，按 spawnedAt/
  lastActivityAt 计时）。任一命中主会话自行恢复推进——子会话的完成信号是
  **加速器，不是前提**。
- **结论取数**：子会话仍在运行时读 pane 屏幕；**已结束时读它自己的 transcript**
  ——`sessionDir`（**启动时记录**，绝不按当前 title 反推：复用 pane 会重绑
  title，而 jsonl 仍写在首轮目录）下**顶层**（不递归，避开
  `subagent-artifacts/`）mtime 最新的 `*.jsonl`，取**最后一条含 verdict fence
  的 assistant 文本**——实测最后一条常是"已发出完成信号"之类的收尾语，取
  "最后一条"会丢掉 verdict 本身。
- **复用与 channel 重绑**：每轮 `prepare_review` 生成新 title 与新 channel，
  而 `review_spawn` 复用同角色 pane；复用时会把 pane **重绑**到本轮 channel
  （取消旧监听、注册新监听、inbox 路径随之迁移），因此 prepare_review 的
  任务文本可直接使用，不需手工改 channel 名。

## 审核单元

- `review_checkpoint`（门禁工具）：要求 precommit PASS → `git add -A
  && git commit`（英文 message 校验）→ 记录 commit sha。只绕过
  READY，不绕过 precommit。普通 `git commit` 在 READY 前仍被拦。
- `prepare_review`：计算 `baseline..HEAD`（自上次审核基线以来的
  commit），生成任务文本，注册审核目标。
- `record_review`：身份证据 = review_spawn 注册的 tmux pane id +
  子会话产出文件；审核目标仍是 HEAD（审核期间新增 checkpoint ⇒
  STALE ⇒ BLOCKED）；READY 绑定审核 commit 的 **tree**（内容绑定，
  squash 重写历史不改变内容时绑定存活；`reset --soft` 实测 tree oid
  不变）。
- ship 授权（unmetRequirements）：READY 与 precommit PASS 均绑定
  commit tree；push/PR 时验证 HEAD commit tree 与绑定 tree 一致且自
  基线以来无未审核 commit。
