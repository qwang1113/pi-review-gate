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
  window**而不是被聚焦的那个；做完把焦点还回去。自动化版本见
  `test/tmux-session.test.ts`：注入假 tmux 执行器，断言 split-window 命令行
  含 `-t <ownPaneId>`，且 env 缺失时 ownPaneId 来自祖先链。
  2026-08-28 实测：用户聚焦 `@39/@4`，新 judge pane 落在本会话的 `@365` —— 通过。
- `split-window -d`：新 pane 不抢焦点。
- pane id（`%N`）是唯一操作句柄：send/capture/kill/liveness 全部按
  pane id。
- 主会话不在 tmux 内时降级为独立 session（原子 `new-session … \;`
  形式设置 remain-on-exit，快速死亡的子进程不带走会话）。
- liveness 用 `#{pane_dead}` 判别（remain-on-exit 的 pane 在进程退出后
  仍存在，`has-session`/`display-message` 会误报为活）。

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
