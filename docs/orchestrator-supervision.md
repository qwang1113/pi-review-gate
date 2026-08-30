# 无人值守的编排监督：通道、状态、等待

> 日期：2026-08-30 · 本文描述 **通道重构之后** 的监督层。上一版（2026-08-29）
> 描述的是「抓 tmux 屏幕 + 全局 attention 队列」的实现，那套东西已经整体删除，
> 本文不再保留它的行为说明 —— 只在每一节开头点明**被替换掉的是什么、为什么**。

监督层要回答的只有三个问题：

1. **那个子会话现在在干什么？**
2. **它在等我做什么？**
3. **它出事了吗？出事之后还剩下什么？**

前三轮端到端验证共暴露 40+ 条缺陷，其中约三分之二源于同一个根因：**这三个问题
都是拿 tmux 屏幕回答的**。屏幕是给人看的渲染结果，不是 API —— 它会折行、会滚动、
会把状态栏渲染得像菜单、会把历史输出一直留在那里。本轮把三个问题全部换成结构化
真值。

---

## 一、通道：点对点，是文件，不属于任何进程

`lib/orchestrator-channel.ts`

每个子会话有**一条专属通道文件**：

```
~/.pi/agent/rg-channels/<orchestration-id>/<child-id>.jsonl
```

**被替换掉的是什么**：一个全局队列 `~/.pi/agent/review-gate-attention.json`，
所有会话往里写、所有会话从里读，靠记录上的 `toSessionId` 字段区分收件人。它带来
两个必然的缺陷：等待者会消费到别人的事件（F12/R-16，实测一轮里连续消费 8 条不属于
自己的事件、每条都立刻返回，把整轮预算烧光），而「按收件人过滤」是一条**写在代码里
的规则**，每个新的读取方都得记得应用它。

现在隔离是**物理的**。子会话 `c` 与编排 `o` 的全部往来就是那一个文件，别人既不写
也不读，所以记录里根本没有收件人字段 —— 没有需要消歧的东西。

### 1.1 通道是路径，不是进程

这一条是**接管为什么是免费的**。项目经理进程死掉（或主动接力）不会带走任何通道
状态：后继者打开同一批路径就继续，子会话完全不知道发生过什么 —— 它还在往同一个
文件里追加。旧设计寻址的是一个 session，所以换人就等于悄悄退掉了那个铃铛（实测：
一整夜 0 条送达）。

### 1.2 记录种类

| kind | 方向 | 说明 |
| --- | --- | --- |
| `state` | 子 → 编排 | 我现在是 working / waiting-input / idle / done；带上下文用量、session id |
| `request` | 子 → 编排 | 我弹了一个框：标题、**全部选项（原文、按序）**、正文 payload、topic |
| `request-settled` | 子 → 编排 | 这个请求结束了，结束者是 human / orchestrator / dismissed |
| `answer` | 编排 → 子 | 这个请求的答案 |
| `instruct` | 编排 → 子 | 跟你说句话（steer / followUp）或打断你（interrupt） |
| `instruct-ack` | 子 → 编排 | 我注入了（或没能注入，附原因） |

两个方向共用一个文件，每条记录自报 `from`。分成两个文件只会让要同步的路径翻倍：
读取方本来就按 `kind` 过滤，而一个文件让「这个子会话身上依次发生了什么」变成一次读。

### 1.3 为什么每行都很小（spill 规则）

两个进程并发追加同一个文件。POSIX 的 `O_APPEND` 只在 `PIPE_BUF`（4 KiB）以下保证
原子性，而真正重要的 payload —— 一份 loop goal 草稿、一份任务书 —— 恰恰会超过它。
所以超过 `MAX_INLINE_RECORD_CHARS`（1500）的记录会把大字段**溢出到旁边的文件**，
JSONL 那一行只留一个引用。读取方经同一个 IO seam 解引用，所以测试里也不碰真磁盘。

---

## 二、状态：六态，全部来自真值

`lib/orchestrator-child-state.ts`（判定）+ `lib/orchestrator-child-channel.ts`（子会话侧上报）

| 状态 | 判据 | 谁测的 |
| --- | --- | --- |
| `working` | 子会话自报（`ctx.isIdle() === false`，或有 pending 消息） | 它自己 |
| `waiting-input` | 通道里有**未销账的 request** | 它自己 |
| `idle` | 自报停下了，且没有完成记录 | 它自己 |
| `done` | 自报停下了，且它的门禁写下了 `declare_done` 的完成记录 | 它自己 |
| `dead` | pane 不在 `list-panes` 的输出里 | 编排层（从外面） |
| `stalled` | pane 还在，但通道心跳超过 `HEARTBEAT_STALE_MS`（180s） | 编排层（推断） |

**被替换掉的是什么**：整屏文本匹配 `Working` / `esc to interrupt`（历史输出里出现过
就永远命中）、归一化屏幕指纹、页脚锚定的对话框解析。R3-5 是它最贵的一次失败：一个
已经 reviewer READY、precommit 通过、`declare_done` 被接受、分支已合并的子会话，
被判为 `working`，725 秒不产生任何事件 —— 而它的完成记录一直就躺在自己的 sidecar 里。

### 2.1 判定顺序（每一步都有代价换来的理由）

1. **pane 消失 → `dead`**。它压过一切自报：进程一没，报告就停止更新了，一条陈旧的
   `working` 正是「崩溃被隐藏」的样子。
2. **有未销账的 request → `waiting-input`**。这是监督者最不能错过的状态，而现在它是
   文件里的一条记录，不是关于像素的推断。
3. **`done`**，且受 `lastAssignedAt` 约束：比当前这次派活更早的完成记录属于**上一次**
   任务（round-1 P1）。少了这条，一个做完又被重新派活、然后卡住的子会话会一直被报成
   「已完成」—— 而卡住恰恰是监督者唯一必须听到的事。
4. **沉默（`stalled`）排在任何正面自报之前**：比心跳预算更旧的报告不再是关于当下的证据。
5. `idle` / `working`。

`paneAlive === undefined`（tmux 读不出来）**永远不判死**（F14）：读不到是信息缺失，
而误判死亡与漏判死亡一样会终结监督。

### 2.2 心跳从哪来

子会话侧门禁在 **`agent_settled`** 与 **`turn_end`** 上无条件上报（`reportChildState`）。
`turn_end` 是关键：它与这个会话有没有改动无关，所以它是「扩展还活着」的证明 ——
而 `stalled` 正是这个证明的缺席。上报里还带上 `ctx.getContextUsage()` 的读数，所以
项目经理不必去问「你还剩多少上下文」。

---

## 三、提问：任意一方先答即生效

`lib/orchestrator-child-channel.ts` 的 `askThroughChannel`

一个问题同时有**两个合法的回答者**：坐在 pane 前的人，和经通道过来的项目经理。
谁也不该等谁。所以框是带 `AbortSignal` 弹的，旁边并行跑一个通道监视：

- **项目经理先答** → 监视方 abort 掉 signal，框从用户屏幕上**消失**（一个问的是已经
  定了的事的框，比没有框更糟）；
- **人先答** → 监视被取消，一条 settle 记录写进通道，于是项目经理那边的等待结束，
  而不是吊在一个再也不会有人回答的问题上。

**框在没人回答之前一直弹着**，这是刻意的，也是整个死亡回退故事：项目经理崩了、被
误杀了、接力到一半没了 —— 子会话都不会被孤立，人 attach 进去随时能答。也正因为
如此，**这条路径上没有任何超时机制**：超时会把「此刻没人在看」变成一个永久的错误答案。

**ESC 为什么算结束**：撤框是人回答了「不选」，它销账。反过来（人挥手关掉框之后还
继续等项目经理）会把项目经理吊在一个已经不在任何人屏幕上的问题上。唯一不能由人这
一侧销账的情形是**根本没有 UI**（headless）：那里 `render` 会立刻返回 `undefined`，
那不是有人做了决定，所以通道侧独自跑。

**被替换掉的是什么**：抓屏解析对话框（标题/选项/高亮项）+ 模拟方向键 + 试 Enter /
C-m / KPEnter + 按完复读校验。R-1（状态栏被当成菜单行）、R-12（折行选项丢失）、
R3-4（标题取错行）、R-8（确认框只认 `KPEnter`，靠试出来的）都是同一件事的症状：
问题本来就是子会话门禁里的一个结构化对象，而编排层在从它的**照片**里把它重建出来。

---

## 四、投递：`pi.sendUserMessage`，不经键盘

`orchestrator_instruct({ childId, mode, message })`

`mode` 就是 pi 自己的 `deliverAs`：

- `steer` —— 切进它当前这一轮；
- `followUp` —— 等它跑完手上这轮再读；
- `interrupt` —— `ctx.abort()`，不带正文。

文本写进通道，由**子会话自己的门禁**用 pi 的 API 注入。**被替换掉的是什么**：
`tmux send-keys`，它产出过四条独立缺陷 —— 任务书被截断（F7）、没有 Enter 提交（F8）、
落到输入框还是 steering 队列全看时机（R-20），以及最糟的一条：消息里的换行被打开着
的对话框当成「提交当前高亮项」，替子会话答了一个它根本没打算选的选项（R-13）。
现在这四种都不可能发生，而且「框开着不许投文本」这条防御也不需要了 —— 框用
`orchestrator_answer` 回，消息只会排在它后面。

**回执依然要挣**：写进通道只证明写进去了，子会话的 `instruct-ack` 才证明注入了。
没有回执 ⇒ 这次调用**失败**，并说明为什么。

---

## 五、`orchestrator_wait`：项目经理的唯一信息入口

这是本轮的一条设计原则，优先级等同「能提供工具的就不要让会话自己拼」：

> `orchestrator_wait` 是项目经理每轮的必经路径（它必然会调）。凡是项目经理需要知道
> 的事，一律从 wait 的回执里**推给它**，而不是指望它主动去查、或自己拼查询逻辑。
> 让 agent「记得去查」本身就是设计缺陷 —— 它会忘。

回执**每次都是同样的五块**，无论这次是阻塞返回、被中断、还是 `timeoutMs: 0` 的快照：

1. **全部子会话的健康快照** —— `{childId, state, 最后活动时间, 已静默多少秒, 当前框标题, 上下文用量}`；
2. **待答请求** —— 谁在问什么、**全部选项按序原文**、正文 payload、`requestId`；
3. **死亡与恢复** —— `dead` / `stalled` 的子会话、**未丢失的资产**（分支 / checkpoint /
   review 裁决 / 完成记录）、以及可直接执行的动作（`orchestrator_recover` 或 `orchestrator_close`）；
4. **你自己的上下文用量与接力时机**（见 §5.1）；
5. **还差什么才能 `declare_done`**。

`timeoutMs: 0` 就是原来的 `orchestrator_status`。**被替换掉的是什么**：两个回答同一个
问题的工具，agent 每轮都要选一个 —— 那正是哲学二说的设计失败。现在阻塞与否是一个参数，
两条路径的回执一字不差。

### 5.1 接力时机由门禁判断，不由项目经理自觉

`lib/orchestrator-handoff-advice.ts`

| 情形 | 建议 |
| --- | --- |
| < 80% | 余量充足 |
| ≥ 80%（软阈值），且没有待答请求 | **现在是接力的好时机** → `orchestrator_handoff({handoffPath})` |
| ≥ 80%，但有 N 个待答请求 | 先把这 N 个回掉再接力 |
| ≥ 90%（硬阈值） | **接力是首要动作**，余量已不足以再带一轮任务 |
| 宿主没给读数 | 明说「没有读数」—— 绝不说成「余量充足」 |

理由是一个具体的事故形状：余量不足时还硬派下一个任务，派到一半上下文炸掉，任务状态
悬空、子会话失联。而「有待答请求时先别接力」同样具体：后继者接手一队它没有上下文的
问题，帮不上任何忙。

### 5.2 什么算「有事发生」

`lib/orchestrator-supervisor.ts` 的 `decideSupervisionEvents`

- **状态变了**永远是新闻（一个没人被告知的状态转移等于不存在）；
- **没变但仍然 newsworthy** 的按 10s → 30s → 60s 退避**再叫一次**（没人答的框不会
  只叫一次就沉默）；
- **`done` 最多叫两次**（间隔 60s）然后安静：它是终态，一直喊会淹掉还需要动作的状态。
  ——「很久没再提醒」不等于「没做完」。
- `working` 是唯一不值得叫醒任何人的状态。

事件记忆（`SupervisionMemory`）由**调用方持有**并在 `orchestrator_wait` 与后台定时器
之间共享，所以两者不会重复叫同一件事；它绝不是模块级变量，这样测试可以直接构造它。

---

## 六、死亡与接管：三类，同一套机制

前提：**进程是可替换的操作者，状态全部落盘。**

### 6.1 子会话死了

`orchestrator_recover({ childId })`。门禁用**同一个 `--session-id`**（`rg-child-<childId>`）
在新 pane 里重开 pi —— transcript 是接着上次的，不是从头来 —— 然后把登记表指向新 pane，
plan 里的任务**保持 running**（它本来就没有停止成立）。

它会**拒绝**两种情况：pane 其实还活着（两个进程写同一个 worktree 比一个卡住的子会话更糟），
以及 tmux 根本读不出来（那时无法确认它到底死没死）。

它死前的分支、checkpoint、review 裁决都在，回执里逐条点名。

### 6.2 项目经理死了

子会话不受影响 —— 框一直弹着，人随时能答（§3 的天然回退）。新会话**带着同一个
`RG_ORCHESTRATION_ID` 启动**，然后 `orchestrator_attach({ orchestrationId })` 接管现场：
plan、每个 child 的状态与资产、通道里未答的请求、孤儿检测结果，一次交还。

注意 `attach` **拒绝**在运行中改换编排身份：一个会话已经登记的子会话会瞬间失去归属。
正确的接管方式是带着那个 id 启动，而这正是 `orchestrator_handoff` 给后继者做的事。

### 6.3 tmux server 挂了 / 机器重启

上面两种同时发生。plan、登记表、通道、sidecar、git 分支全在。接管后门禁自动识别
**孤儿任务**：plan 说 running、却没有存活 pane 在做。这是崩溃/重启唯一会留下的不一致，
也是项目经理唯一会永远等下去的东西 —— 所以 `attach` 主动报出来，并给出恢复动作
（有登记的子会话 → `recover`，没有的 → 重新 `spawn`）。

tmux 读不出来时**一条孤儿都不报**：信息缺失不是证据。

---

## 七、tmux 还剩什么

两件事，都不涉及渲染：

- **`list-panes`** —— pane 是否存活（`dead` 的唯一来源）；
- **`split-window` / `kill-pane`** —— 开一个 pane、关一个 pane。

`lib/orchestrator-tmux.ts` 里已经没有 `send-keys` 也没有 `capture-pane` 的构造器，
`test/orchestrator-tmux.test.ts` 直接对源码断言这一点 —— 一个「留着没人用」的构造器
正是被删掉的路径回来的方式。

---

## 八、模块速查

| 模块 | 职责 | 纯度 |
| --- | --- | --- |
| `lib/orchestrator-channel.ts` | 通道路径、记录 schema、追加/读取/游标、spill、投影、心跳判定 | IO 经注入的 seam |
| `lib/orchestrator-child-channel.ts` | 子会话侧：上报、两方竞态提问、读取与确认指令 | IO/对话框/计时器全注入 |
| `lib/orchestrator-child-state.ts` | 六态判定、健康行、退避常量 | 纯函数 |
| `lib/orchestrator-supervisor.ts` | 编排侧：读所有通道、判定、决定什么算新闻、渲染回执 1–3 块 | 纯（IO 经 seam） |
| `lib/orchestrator-handoff-advice.ts` | 上下文用量 → 接力时机 | 纯函数 |
| `lib/orchestrator-wait.ts` | 等待判据、预算、回执装配（含第 4、5 块） | 纯函数 |
| `lib/orchestrator-answer-tools.ts` | `orchestrator_answer`（含约束 8 的代批边界） | 判定可单测 |
| `lib/orchestrator-recovery-tools.ts` | `orchestrator_recover` / `orchestrator_attach`、孤儿检测 | 孤儿判定是纯函数 |
| `lib/orchestrator-tmux.ts` | 仅剩的 tmux 构造：开/关/列 pane | 纯函数 |

协议级测试（不依赖真实 tmux、不依赖 pi 进程、不碰磁盘）：
`test/orchestrator-channel.test.ts`、`test/orchestrator-child-state.test.ts`、
`test/orchestrator-handoff-advice.test.ts`、`test/orchestrator-tools.test.ts`。
