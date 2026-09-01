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

## 二、状态：七态，全部来自真值

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
5. **`waiting-judge`**：它在等门禁**自己派出去**的活（reviewer / precommit）。
6. `idle` / `working`。

`paneAlive === undefined`（tmux 读不出来）**永远不判死**（F14）：读不到是信息缺失，
而误判死亡与漏判死亡一样会终结监督。

### 2.2 心跳从哪来（2026-08-30 重写：定时器，不是 agent 事件）

心跳由**子会话侧扩展自己的定时器**发（`startChildHeartbeat`，10s 一跳，状态没变时
每 60s 落一条记录）。只要进程活着它就跳，与 agent 在不在产生事件无关。

**为什么必须这样。** 原来的心跳挂在 `agent_settled` / `turn_end` 上 —— 那是 **agent**
事件。而 `judge_wait`、full precommit、任何长命令都发生在**同一个 turn 内部**：agent
既不 settle 也不结束 turn，通道里就不再有新记录。于是 180 秒的 `HEARTBEAT_STALE_MS`
必然超时，一个正在等自己 reviewer 的健康子会话被报成「失联」。第四轮实测：2 次误报、
约 14 分钟、12 次无效唤醒。**更糟的是回执给出的动作是 `interrupt` / `close` ——
照做就会把正在跑的那一轮审查腰斩**，这是唯一一条「照门禁说的做反而出事」的缺陷。

`turn_end` / `agent_settled` 仍然上报，但它们现在只是**下限**，不再是唯一来源。

### 2.3 长阻塞如实上报：`waiting-judge`

沉默与「正在等一件已知的事」是两回事。门禁**自己**派出了 judge，所以它百分之百知道
在等谁、等了多久 —— 于是它就这么说：健康快照显示「在等 reviewer（已等 220s）——
正常，别打断」，pane 边框上也是 `@t2-gate-commands · waiting-judge 220s`。

两条随之而来的性质：

- `waiting-judge` **不算 newsworthy**，不会叫醒项目经理（为它自己派的活叫醒它不是监督，
  是噪音）；
- `stalled` 因此回到它本来的含义 —— **扩展真的不在了**。它的建议动作里**不再有
  `interrupt`**：门禁都不应答的进程，打断不会让它复活，而万一它其实还在跑 reviewer，
  打断就是把那一轮审查腰斩。`orchestrator_recover` 拒绝重开一个活着的 pane 时也一样，
  它现在给的是「去看健康快照」而不是「先打断它」。

上报里还带上 `ctx.getContextUsage()` 的读数，所以项目经理不必去问「你还剩多少上下文」。


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

**回执依然要挣**，但它分两级（2026-08-30）：子会话的 `instruct-ack` 带 `stage` ——
`received`（门禁拿到并入队了）与 `injected`（pi 真的收下了）。

- **`followUp` 认 `received`**。它的定义就是「等你跑完这轮再读」，一个正忙的子会话
  按定义**不可能**立刻注入。原来要求注入，于是这个 mode 恰恰在它为之设计的场景里
  必然失败 —— 而消息其实已经写进通道了，就此沉底丢失（第四轮实测丢了一条补充授权，
  只能改用 `orchestrator_answer` 的选项文本绕过去）。
- **`steer` / `interrupt` 仍要求 `injected`**：它们承诺的是「当前这一轮」，排队不算。

投影里也只有 `injected` 才把指令移出子会话的收件箱 —— 只 `received` 的消息必须留着，
否则恢复时就会丢掉它。没有任何回执 ⇒ 调用失败，且文案第一句是「先看它是不是
`waiting-judge`」，而不是建议去 close 或 interrupt。


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

## 六甲、plan：不扩权的改动不惊动人，扩权一律重批

`lib/orchestrator-plan-approval.ts`（判定）+ `orchestrator_plan({action:"write"})`

第四轮最贵的一条缺陷：一轮验证里用户被弹了 **3 次** plan 批准框，第 2 次弹出时无人
在屏幕前，干等 425 秒。根因不是「状态变化让批准失效」（那早就排除在 hash 之外），
而是**唯一能改边界的入口是整份重写 plan，而扩一个文件是常态**：3 个任务里有 2 个在
实施中发现模块必须拆成两个文件（门禁自己的 600 行硬拦），项目经理在定 plan 时根本
无从预知。于是「派一个任务 → 撞边界 → 重写 plan → 叫醒真人」成了稳定循环。

现在 `write` 内部比对**已批准 plan 的授权快照**（runtime 里的 `approvedPlan`）与新
plan，把每一处差异归入两类之一：

| 判为**不扩权**（批准迁移到新内容，记一条审计条目，不弹框） | 判为**扩权**（批准失效，重新征求用户） |
| --- | --- |
| 边界收窄、任务被删 | 新增任务 |
| 新增路径落在该任务**已批准边界的目录前缀内**，且不与其他任务边界相交 | 碰到新目录前缀 |
| 增加依赖（更串行） | 删除依赖 |
| `parallel` → `serial` | `serial` → `parallel` |
| 降低 `maxParallel` | 提高 `maxParallel` |

三条硬止损：**无斜杠的边界不产生前缀**（`README.md` 或顶层 `lib` —— 归一化后无法
区分顶层文件与顶层目录，猜错就等于把一个文件放大成整个仓库）；新增路径**不得与任何
其他任务**（快照里的和新 plan 里的）相交；**只有已存在的任务**能走细化，新任务没有
可比对的已批准边界。读不到授权快照时一律判扩权 —— fail-closed 的代价只是多弹一次框。

这条规则**放宽了「批准」的含义**，所以它写在用户批准的那份文本里（`orchestrator_plan`
的 transcript 消息），不是事后才让人发现的规则。每次迁移都记进
`runtime.approvalAmendments`，用户随时能查「为什么这次没问我」。

## 六乙、plan 也要先过审计

`lib/orchestrator-plan-audit.ts` + `orchestrator_plan({action:"submit"})`

原来的不对称：loop goal 必须先过 `goal-auditor` 才能弹批准框，plan 却直接送到人面前。
而 plan 错的代价更高 —— 边界划错会让子会话互相踩、依赖写错会让串行变并行、并行度
定高会烧资源，且这些都不是读文本能看出来的，得对着仓库查。

`submit` 内部吞掉整条链（与 `propose_loop_goal` 同一形状）：建审计任务 → 派
`goal-auditor`（**不新增角色**：审的都是「动手前的契约」）→ 等它退出 → 解析 fence →
裁决（**只 P0/P1 阻塞**）→ 记录。**审计不过就把 findings 退回给项目经理，一个框都不弹**；
过了才渲染批准框。裁决绑定 canonical plan 文本的 sha256，所以改任务状态不会让它失效，
改一个边界就要重审；重审时门禁自动把上一轮的结论与 findings 带给审计者。

审计要点（写在任务模板里）：任务拆分是否完整、边界是否覆盖真实落点（测试/文档/安装
脚本/注册入口这些最容易漏）、边界重叠与 `execution` 是否自洽、依赖是否成环或缺失、
`maxParallel` 是否安全、每个任务是否可独立验收。

## 六乙、任务书的最后一句话是门禁的

`buildTaskDocument` 生成的任务书，在项目经理的 brief **之后**由门禁追加一段
**硬指示**（`TASK_GOAL_DIRECTIVE`，2026-09-01）：

> 本会话的退出条约是你自己的 loop goal。任务书只是 plan 的任务边界，不是你的 goal；
> plan 批准 ≠ goal 批准。开始改代码前，你必须先用 `propose_loop_goal` 协商并获批
> 你自己的 goal（goal-auditor 审计 + 用户批准）。未批准 goal 前，L8 edit gate 会拦下
> 所有 edit/write。

**为什么是门禁追加而不是项目经理写**：2026-09-01 onchain 事故里，项目经理在
brief 里写了一句「目标文本见 .pi/loop-goal.md（已批准）。开始工作。」，子会话——一个
有自己 goal 要协商的全新 loop 会话——把 plan 的批准当成了自己的，跳过
`propose_loop_goal` 直接读代码，读了四分钟进程就消失了，一次协商都没发生。
L8 edit gate 拦得住 edit，拦不住「读着读着忘了协商」。

所以：**任务书里任何「goal 已批准」的宣称，都会被紧随其后的门禁硬指示否定**。
项目经理写不写这句都无所谓——写了对子会话是噪声，不写也不丢信息，因为硬指示
恒在。真正的机械兜底是 L8 edit gate（`loopGoalEditGate`）：子会话不协商出
自己批准过的 goal，任何 edit/write 都过不去。硬指示只是让第一轮就把这句话
说出口。

配套的 advisory（同一天）：loop 且无已批准 goal 时，read-only 工具（read/grep/ls
等）的结果会被追加一行提醒——每 5 分钟最多一次、每会话最多 2 次，explore/normal
不触发。不拦，只是把「你还没协商 goal」放回视线里。

## 六丙、哪个 pane 是哪个：颜色 + 状态标签

`lib/orchestrator-pane-decor.ts`（纯逻辑）+ `orchestrator-tmux.ts`（argv）

一个 window 里四个 `pi` pane 就是四个一样的黑框。所以 `orchestrator_spawn`
**在它自己内部**（和建 pane、建 worktree、写任务书、登记 registry 同一层级）给子会话：

- 按 `childId` 派一个稳定颜色（纯函数 —— 同一个子会话在任何进程里看到的都是同一色），
  `select-pane -P fg=colourN` 设边框；
- `select-pane -T` 设标题，形如 `@t2-gate-commands · waiting-judge 220s` ——
  **任务名 + 当前状态 + 该状态已持续多久**；
- window 级 `setw pane-border-status top` / `pane-border-format '#{pane_title}'`
  打开顶部标签栏（**一律不带 `-g`**，不碰用户全局配置；argv 仍过 `assertSafeTmuxArgv`）。

标题由本来就在周期跑的监督探针顺带刷新，所以不看回执也知道谁在干什么。健康快照每行
带同一个颜色名（`- [青] t1-… `），屏幕上的色块与回执条目能对上。`orchestrator_close`
在关掉**最后一个**被装饰的子会话时用 `setw -u` 撤销 window 级设置（早撤会把还在用的
兄弟 pane 的标签抹掉，不撤就是留垃圾），且撤销发生在 `kill-pane` **之前** —— pane 一死
它的 id 就不再是合法的 `setw` 目标。

两条边界：它**不是工具、不是 action**（一个展示需求不该让工具集重新长回去），装饰失败
**只降级成一句提示**，绝不让 spawn 或探针失败。而且它**只出不进**：没有任何判定读
pane 标题 —— 那就是回到读屏幕了。

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
| `lib/orchestrator-child-state.ts` | 七态判定（含 `waiting-judge`）、健康行、退避常量 | 纯函数 |
| `lib/orchestrator-supervisor.ts` | 编排侧：读所有通道、判定、决定什么算新闻、渲染回执 1–3 块 | 纯（IO 经 seam） |
| `lib/orchestrator-handoff-advice.ts` | 上下文用量 → 接力时机 | 纯函数 |
| `lib/orchestrator-wait.ts` | 等待判据、预算、回执装配（含第 4、5 块） | 纯函数 |
| `lib/orchestrator-answer-tools.ts` | `orchestrator_answer`（含约束 8 的代批边界） | 判定可单测 |
| `lib/orchestrator-recovery-tools.ts` | `orchestrator_recover` / `orchestrator_attach`、孤儿检测 | 孤儿判定是纯函数 |
| `lib/orchestrator-tmux.ts` | 仅剩的 tmux 构造：开/关/列 pane + pane 装饰（不带 `-g`） | 纯函数 |

协议级测试（不依赖真实 tmux、不依赖 pi 进程、不碰磁盘）：
`test/orchestrator-channel.test.ts`、`test/orchestrator-child-state.test.ts`、
`test/orchestrator-handoff-advice.test.ts`、`test/orchestrator-tools.test.ts`。
