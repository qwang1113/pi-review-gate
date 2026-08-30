# 调研：用 `pi -p --session-id` 替代 tmux 承载 judge 子会话

> 状态：**方案（PoC 前置）** · 日期：2026-08-28
>
> 结论先行：judge 子会话（reviewer / adviser / goal-auditor）可以从
> tmux pane 迁移到 pi 原生 `-p --session-id` 进程，**同时删掉 tmux 依赖**，
> 并获得 pi-subagents 都做不到的「跨主会话 resume」。本文件给出迁移方案、
> 协议变化、风险与分步落地路径。

---

## 1. 背景与动机

### 1.1 现状：tmux pane 承载 judge

```
主会话 (pi, 带 review-gate)
  └─ review_spawn → tmux split-window → start.sh (launcher)
        └─ pi --no-extensions --no-skills -e npm:pi-subagents \
             --system-prompt <SP> --model <M> --exclude-tools edit,write \
             --session-dir <runDir>/sessions
```

judge 的**实体**是 pi 会话（`lib/judge-session.ts` 早已把 pid/exit-code/
stderr/transcript 视为事实来源），tmux pane 只是它的**屏幕**。这套设计的
问题全部集中在「屏幕」这一层：

| 痛点 | 根源 | 位置 |
|---|---|---|
| `tmux wait-for` 没有 `-t` 超时，要包空转轮询 | tmux API 限制 | `lib/tmux-session.ts` |
| 多行输入被 pi TUI 撕成一行一条 | 交互式 TUI | `sendMessage` 强制单行 |
| pane 生命周期/单例复用/rebind 复杂 | pane 是显示句柄，不是记录 | `spawnJudgePane` |
| 崩溃后「pane 没了但 exit-code 没写」的歧义 | 显示层与记录层分离 | `judge-session.ts` 三态 |
| 主会话必须托管等待（三判据 v4 纪律） | 信号可能永远不来 | `child-watch.ts` |
| 无 tmux 的主机直接 fail-closed | 环境依赖 | `review_spawn` 拒绝 |
| pane 无法跨主会话复用（会话重启即失联） | tmux 目标绑定当前会话窗口 | 整体 |

### 1.2 为什么 `--session-id` 是答案

2026-08-28 实测（`/tmp/pi-resume-probe`）：

```bash
# 进程 A：新建会话
pi -p --session-dir /tmp/p --session-id probe-judge-1 --no-tools \
    "记住暗号：ZEBRA-7741"
# 进程 B：全新进程，同一 session-id —— 完整上下文续接
pi -p --session-dir /tmp/p --session-id probe-judge-1 --no-tools \
    "暗号是什么？"  →  ZEBRA-7741
```

- **resume 是 pi 原生一等公民**：`--session-id` 决定会话归属，跨进程、
  跨主会话、跨天都有效；会话文件（`.jsonl`）在磁盘上，进程退出后依然可续。
- **不需要 tmux**：`-p` 非交互，stdout 可直接重定向、解析。
- **不需要 pi-subagents**：judge 单进程、单会话，没有编排需求。
- **对比 pi-subagents 的 resume**（`subagent({action:"resume"})`）：那个方案
  校验 `status.sessionId === 当前主会话 sessionId`（源码
  `src/runs/background/async-resume.ts:431`），主会话重启后旧 run 直接
  「not found in the active session」——**这正是本仓库「judge 跨轮活到
  READY」场景下 resume 用不起来的根因**。`--session-id` 不受此限。

### 1.3 可见性不降反升

tmux pane 是**无结构屏幕**；`--session-id` 方案的三层记录都是文件：

1. `--session-dir` 下的 `.jsonl` —— 结构化完整输入输出（role/type/时间戳/
   thinking/工具调用），`pi --export <jsonl> <out.html>` 可导出浏览器视图；
2. 每次 spawn 的 `stdout.log` / `stderr.log` —— 本轮原始输出（实时 tail）；
3. judge 的 `sessionDir` 本身可被 `review_read` 直接读。

排查路径：`tail -f output.log`（它在干什么）→ grep jsonl 的 toolCall
（它看了什么）→ `pi --export`（完整回顾）。全部比 capture-pane 更强。

---

## 2. 目标形态

### 2.1 一条命令，一个文件

```ts
// lib/judge-session.ts（新）——spawn 一行
const child = spawn("pi", [
  "-p",                                // 非交互：处理完退出
  "--no-extensions",                   // 不加载 review-gate（防递归）
  "--no-skills",                       // 保持现状
  "--exclude-tools", "edit,write",     // 只读审查契约（实测生效）
  "--system-prompt", sysPromptPath,    // role + 协议（现状不变）
  "--model", modelSpec,
  "--session-dir", judgeSessionDir,
  "--session-id", judgeSessionId,      // ← 唯一新增：确定性会话身份
  taskFilePath,                        // ← 任务文本直接走 argv/文件，不再 send-keys
], {
  cwd: repoRoot,
  detached: true,
  stdio: ["ignore", outFd, errFd],     // stdout/stderr 落盘
});
```

**judge session id 的派生**（确定性、跨进程稳定）：

```ts
// 每个 role 一个稳定 id ——「resume = 用同一个 id 再跑一次」
const judgeSessionId = `rg-${role}-${repoHash(root)}`;
// 每轮任务不同，但会话身份不变 ⇒ 上下文跨轮延续（与 READY 绑定）
```

> 对比现状：`--session-dir` 里每轮一个 `runs/<ts>-<rand>/sessions` 子目录。
> 新方案反过来——**session 目录按 role 稳定**，一轮一个 `runs/<ts>` 只放
> 本轮 spawn 的 stdout/stderr/pid/exit-code；jsonl 落在稳定的 session 文件
> 上（`--session-id` 决定文件名），跨轮 append。

### 2.2 生命周期

```
① review_spawn(role,title)
   ├─ 复用：同 role 的 session-id 已存在 ⇒ 直接用（上下文延续）
   ├─ fresh:true ⇒ 删除/跳过旧 session 文件（等价杀掉旧 pane）
   └─ spawn pi -p ... → 立即返回 { pid, sessionId }
② 主会话把任务文本写文件，spawn 时作为 argv 传入（或首行引用）
③ judge 跑完 → 进程退出（exit 事件 + exit-code 文件）
   ├─ 输出在 stdout.log + jsonl 里（verdict fence 解析不变）
   └─ 唤醒：不再靠 tmux wait-for，改由扩展监听 child exit / 轮询 jsonl
④ 下一轮/回答提问 ⇒ 同 session-id 再 spawn（上下文自动延续）
⑤ review_close ⇒ kill(pid, SIGTERM)（进程组）+ 保留/清理 session 文件
```

### 2.3 唤醒机制（替代 done channel）

现在：judge 跑 `tmux wait-for -S rg-<title>-done`，主会话注册监听。

新方案三条路（按复杂度递增，建议先 1 后 2）：

1. **进程退出事件**（最简单）：扩展持有 `child`，`child.on("exit")` 即唤醒。
   不需要 judge 发任何信号——pi `-p` 处理完必退出，退出即完成。
2. **文件轮询**（兜底）：`child-watch.ts` 的三判据仍可用——但「进程是否
   还在」从 `kill -0 <pid>` 变成 `child.exitCode !== null`，不再需要
   pid 身份防回收（我们持有 ChildProcess 对象本身）。
3. **jsonl fence 轮询**（可选加速）：`sessionDir` 的 jsonl 出现 verdict
   fence 即完成——即使进程还活着（judge 输出完但没收尾）。

> 关键简化：**不再有「子会话可能永远不发信号」的问题**。`pi -p` 的退出是
> 操作系统保证的；三判据里 (a) 变成 exit 事件，(b) 变成 `exitCode !== null`，
> (c) 静默超时保留。`child-watch.ts` 的决策逻辑基本原样，只是判据换源。

### 2.4 提问通道（替代 inbox channel）

现在：judge 写 inbox.jsonl + `tmux wait-for -S rg-<title>-inbox`。

新方案：**提问 = 一次 resume**（第 1.2 节已实测）。

```
① judge 有疑问 → 输出 question fence → 进程退出
   ```json
   {"question": "...", "context": "..."}
   ```
② 主会话读 stdout：有 question fence 无 verdict ⇒ 进入回答流程
   （问用户 / 自行决策），拿到答案
③ 主会话同 session-id 再 spawn：`pi -p --session-id rg-reviewer-<hash> \
   "<答案文件>"` —— judge 带着全部记忆醒来继续
④ 循环直到 verdict fence
```

- 不需要「进程活着等回复」——没有 live channel 要维护；
- 崩溃恢复免费：主会话任何时候回来，`--session-id` 都能接上；
- `prepare_review`/`prepare_adviser` 的任务文本里不再需要嵌 channel 名。

### 2.5 协议文本变化（`JUDGE_COMMON_PROTOCOL`）

`lib/judge-prompt.ts` 里的「运行形态（tmux 子会话）」段改为「独立 pi 进程」：

- ~~运行 `tmux wait-for -S <channel>`~~ → 「你的最终输出就是你的回复正文；
  进程退出即完成，主会话以你的 stdout/jsonl 为准」；
- 「提问写入 inbox.jsonl + 信号」→ 「有疑问时输出 question fence 并退出，
  主会话会带着答案 resume 你」；
- 「你的上下文跨多轮复用」→ 保持（这就是 `--session-id` 的语义，写进协议
  让 judge 理解「再次被拉起 = 继续之前的对话」）。

`buildReviewPrompt` / `buildAdviserBrief` / `buildGoalAuditTask` 的
doneChannel/inbox 参数全部删除，换成 session-id 说明。

---

## 3. 落地路径（分步，每步可独立验证）

### Step 1：新增 `lib/judge-process.ts`（纯新增，不动 tmux 路径）

- `spawnJudgeProcess(opts)`：上述 spawn 一行 + stdout/stderr 落盘 +
  `ChildProcess` 句柄；
- `judgeSessionIdFor(role, repoRoot)`：确定性 id 派生；
- `isFinished(child)` / `readQuestionFence(stdoutPath)` 等纯函数；
- 配套单测（不碰 tmux）。

### Step 2：`review_spawn` 加 `backend: "process" | "tmux"` 开关

- 默认 `"process"`；`"tmux"` 保留旧路径（回滚/对照）；
- judge 注册表 `JudgeChild` 增加 `backend` 判别 + `child?` / `sessionId?`
  字段，`review_read` / `review_close` 按 backend 分支；
- 唤醒：process 路径用 `child.on("exit")` 调同一 `pi.sendMessage(triggerTurn)`
  回调（`registerWatch` 的 wake 函数复用）。

### Step 3：协议文本与任务文本生成切换

- `JUDGE_COMMON_PROTOCOL` 改版（2.5 节）；
- `buildReviewPrompt` 等去掉 doneChannel/inbox 参数（或按 backend 注入）；
- `prepare_review` 的输出文案从「spawn tmux pane + review_send」改为
  「spawn process + 任务文本已随 argv 传入」。

### Step 4：删除 tmux 路径（整体退役）

- 删除 `lib/tmux-session.ts` 中 pane/session 全部函数；
- `lib/judge-watch.ts` 的 tmux wait-for waiter 换成 exit 监听；
- `child-watch.ts` 判据换源（2.3 节）；
- `attention.ts`：子会话不再需要 `RG_PARENT_SESSION` + tmux 信号——
  attention 事件改为读 jsonl（或保留文件侧通道，删除 tmux 信号侧）；
- 清理 `test/tmux-session.test.ts` 等，新增 process 版测试；
- `docs/execution-model.md` / `docs/judge-protocol.md` 同步改版。

---

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| **失去 pane 实时可见性** | 三层文件记录（1.3 节）+ 可选 `/judge-log` tail 命令 + belowEditor 状态 widget（`lib/ui-widget.ts` 已有模型 widget，扩展三行状态） |
| **无法打断运行中的 judge**（现在可 `tmux send-keys C-c`） | `child.kill("SIGINT")`（同效果）；需要更强时 SIGTERM 进程组 |
| **judge 卡死（provider 挂起）不退出** | 静默超时判据保留（三判据 (c)）+ `child.kill` 兜底；`pi -p` 的 provider 重试超时机制与交互模式一致 |
| **`--session-id` 会话文件无限增长** | 每个 role 一个文件；`review_close` 时可清理；一轮一个 `runs/<ts>` 的 stdout 日志可保留 N 轮后清理 |
| **argv 长度限制**（任务文本很大） | 任务文本写文件、argv 传文件路径（现状 send-keys 也是引文件；argv 传路径无长度问题） |
| **扩展自身崩溃后 child 成孤儿** | `detached: true` + 每次 `review_spawn` 时按 session-id 扫描/接管既有进程（registry 持久化到 `.pi/`，同 gate state 一起） |
| **多 repo / 多 role 并发** | session-id 含 repoHash + role，天然隔离；并发上限沿用现有 spawn budget |
| **`--no-extensions` 之外的扩展隔离** | 实测 `--no-extensions` 后 jsonl 无 `review-gate-state` 注入（probe 验证）；`--no-skills` 保留现状 |

---

## 5. 附带收益

- **删除约 1060 行**（`tmux-session.ts` 618 + `judge-session.ts` 442 的主体），
  新增约 200-300 行；
- **无 tmux 主机也能 review**（headless/CI 直接可用，不再 fail-closed）；
- **主会话重启后 judge 上下文仍在**——「随时 resume」从 pi-subagents 的
  会话绑定限制中解放出来，直接对齐本仓库「judge 活到 READY」的执行模型；
- **judge 提问与跨轮复用统一为同一个原语**（同 session-id 再拉起）；
- 排查从「无结构屏幕」升级为「结构化 jsonl + HTML 导出」。

## 6. 决策点（需要用户拍板）

1. **tmux 路径是否完全删除**，还是保留 `backend:"tmux"` 作为可选观察层
   （用户 attach 看实时输出）一段时间？
2. **judge 完成唤醒**用「进程 exit 事件」即可，还是要加 jsonl fence 轮询
   加速（judge 输出完但进程未退的窗口）？
3. **孤儿接管**：扩展重启后按 session-id 接管既有 judge 进程，还是简单
   要求 review_close 后重派？
