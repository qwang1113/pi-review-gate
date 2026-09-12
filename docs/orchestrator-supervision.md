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

### 1.1b 通道有主人：外来的 `state` 不算数（2026-09-09）

子会话用 `Agent` 工具派出的 subagent **继承** `RG_ORCHESTRATION_ID` + `RG_STATE_VARIANT`，
它加载的门禁扩展因此会把自己也当成这个子会话，往**同一个通道文件**追加自己的心跳。
实测：363 个通道文件里 12 个混入 2–5 个不同 session 的 `state` 记录，subagent 干完活后
每 40 秒一条 `idle` 覆盖真子会话的 `working`，项目经理的回执因此把正在干活的孩子报成
「停下了（没有 declare_done）」（一个 PM 会话累计收到 115 次）。

两道闸，都在读写两侧：

- **读侧**（`projectChannel`，2026-09-09）：投影只采纳**通道主人**的 `state` 记录 ——
  主人 = 第一条带 session id 的 `state` 记录的作者；没带 session id 的记录无法归属，
  照收（主人自己早期的心跳、旧版扩展的写入）。外来 session 的记录被忽略，`lastActivityAt`
  也不再被它们刷新。所以已经污染的通道**无需清理**：重读时脏记录自动不算数。
- **写侧**（子会话的 `childBinding`，2026-09-09）：光有 env 不再足以自称子会话 ——
  门禁开子会话 pane 时用确定性的 `--session-id rg-child-<childId>`，而 subagent 跑在 pi
  现生成的随机 uuid 下；两者不一致就不绑定：不写通道、不读指令。

### 1.2 记录种类

| kind | 方向 | 说明 |
| --- | --- | --- |
| `state` | 子 → 编排 | 我现在是 working / waiting-input / idle / done；带上下文用量、session id |
| `request` | 子 → 编排 | 我弹了一个框：标题、**全部选项（原文、按序）**、正文 payload、topic |
| `request-settled` | 子 → 编排 | 这个请求结束了，结束者是 human / orchestrator / dismissed / **interrupted**（instruct 打断时解除的框，不是拒绝） |
| `answer` | 编排 → 子 | 这个请求的答案 |
| `instruct` | 编排 → 子 | 打断你并立即投递（`interrupt`，缺省）或切进你当前这一轮（`steer`）；`followUp` 只剩 judge 通道在用 |
| `instruct-ack` | 子 → 编排 | 我注入了（或没能注入，附原因） |

两个方向共用一个文件，每条记录自报 `from`。分成两个文件只会让要同步的路径翻倍：
读取方本来就按 `kind` 过滤，而一个文件让「这个子会话身上依次发生了什么」变成一次读。

### 1.3 为什么每行都很小（spill 规则）

两个进程并发追加同一个文件。POSIX 的 `O_APPEND` 只在 `PIPE_BUF`（4 KiB）以下保证
原子性，而真正重要的 payload —— 一份 loop goal 草稿、一份任务书 —— 恰恰会超过它。
所以超过 `MAX_INLINE_RECORD_BYTES`（1500 **字节**）的记录会把大字段**溢出到旁边的
文件**，JSONL 那一行只留一个引用。预算按字节算不是细节：`PIPE_BUF` 是字节上限，而
`String.length` 数的是 UTF-16 单元——通道里写的几乎都是简体中文（每码点 3 字节），
按字符算会让一条 1500 字符的记录悄悄涨到 4400 字节并被撕开。读取方经同一个 IO seam
解引用，所以测试里也不碰真磁盘。

---

## 二、状态：八态，全部来自真值

`lib/orchestrator-child-state.ts`（判定，其中 `CHILD_STATES` 是这份清单的唯一权威）
+ `lib/orchestrator-child-channel.ts`（子会话侧上报）

| 状态 | 判据 | 谁测的 |
| --- | --- | --- |
| `working` | 子会话自报（`ctx.isIdle() === false`，或有 pending 消息）、自报 `idle` 但**既无 settled 证据又**在 `IDLE_PROGRESS_GRACE_MS`（120s）内有推进，**或有未返回的后台 subagent**（§2.5） | 它自己（见 §2.4 / §2.5） |
| `waiting-input` | 通道里有**未销账的 request** | 它自己 |
| `waiting-judge` | 它在等门禁**自己派出去**的活（reviewer / 全量 precommit），附已等秒数与在等谁 | 它自己（见 §2.3） |
| `idle` | 自报停下了、没有完成记录、**没有未返回的后台 subagent**，且 **①子会话自己给出了 settled 证据（`settledSince`，见 §2.4）或 ②已 120s 没有推进** | 它自己 + settled 证据 / 进展戳 |
| `done` | 自报停下了，且它的门禁写下了 `declare_done` 的完成记录 | 它自己 |
| `mode-changed` | 它换了门禁模式（loop→explore/normal/orchestrator）——项目经理必须知道 | 它自己 |
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
   「已完成」—— 而卡住恰恰是监督者唯一必须听到的事。约束的两端在 2026-09-17 一起补齐：
   **写的一端**，每一条**写进通道**的 `orchestrator_instruct` 都打派活戳（`interrupt` 曾是
   唯一的豁免，而它恰恰是「停下、改做这个」；戳记也不等回执 —— 只拿到 `received` 的消息
   回执会失败，可子会话稍后照样读到它）；**读的一端**，比的是子会话进入这段 `done`
   的**起点**（`projection.lastStateSince`）而不是最新那条记录 —— 子会话完成后心跳每分钟
   会用新时间戳重报一次 `done`，拿最新一条去比，等于派活后一分钟内约束自动作废。
4. **沉默（`stalled`）排在任何正面自报之前**：比心跳预算更旧的报告不再是关于当下的证据。
5. **`waiting-judge`**：它在等门禁**自己派出去**的活（reviewer / precommit）。
6. `idle` / `working` —— 而这两者之间还要过一道**进展**关（§2.4）。

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

### 2.4 自报 `idle` 要过证据关：先是结构化证据，120s 是兜底（B3）

子会话上报 `working` / `idle` 的依据是 `ctx.isIdle()`，而这个读数**在两次工具调用
之间为真**：一个正在连续调 bash / read 做只读调查的会话，几乎每一跳心跳都是 idle。
2026-09-04 实测：一个 45 秒里 transcript 涨了 23.7KB 的子会话，被连续四次报成
「**停下了（没有 declare_done）**」，而同一行里写着「最后活动 0s 前」。代价有两份：
项目经理据此两次多余打断；`idle` 又算 newsworthy，于是**每次 `orchestrator_wait`
都立即返回**，它唯一的等待工具退化成忙轮询。

**① 结构化证据（2026-09-10 起，用户决定）——先看这个。** 子会话在最能说明问题的事件上
打一个戳：`agent_settled`（一个 turn **真的结束了**，pi 不会自己接着跑）时写
`settledSince`；此后**任何一次工具返回或 turn 边界都清掉它**（工作又开始了）。于是
「已 settled 且此后无工具调用」是一句**关于结构**的话，不是关于时间的：一个正在
bash → read → bash 的子会话不可能带着这个戳 —— 那正是 2026-09-04 要防的那件事。
带戳的 `idle` **立即采信**，项目经理在孩子停下的那一刻就知道，而不是两分钟后。

**但「settle 了」不等于「门禁不再给它活」**（2026-09-10 第三轮 review 的 P1）。
`agent_settled` 这个 handler **自己会注入下一轮**（L2 自动续跑、子会话等待提醒），
所以戳不是在这个 handler 开头打上的 —— 那样一个「马上要被叫醒的子会话」会先发布一份
结构上成立的「我停了」，而项目经理（现在会立即采信它）就会照着一个从未发生的停下
行动。戳由**确实以停下收场的出口**发布：那些决定**不**续跑的 early return
（explore/normal、暂停等用户、`!loopArmed`、`/gate-bypass`），而会交出下一轮的出口
要么什么都不发布（它从未设过），要么明确不是停下
（`settleFinishedRounds` 可能刚用一份已完成报告叫醒它）。`!ctx.isIdle()` 那条也不行：
agent 还在干活，那不是停下。

**② 120 秒是兜底，不是主判据。** 没有戳的子会话（旧版扩展、或自启动以来从未 settle
过的会话）走原来的规则：`lastProgressAt`（只有真实 agent 事件才推进，心跳不推进）在
**120 秒**（`IDLE_PROGRESS_GRACE_MS`，**用户 2026-09-04 拍板的数字**，本轮未改动）以内
推进 ⇒ 判 `working`，健康行写成「在干活（自上次推进 3s**·自报停下未满 120s**）」
—— 被推翻的那条自报**显式留在行里**，不替它藏 120 秒（用户决定，2026-09-17）。它还是
一个**预告**：项目经理看到这个标记就知道，孩子若不再推进，这一行过会儿会翻成「停下了」，
于是可以决定继续等还是准备介入。标注**刻意压到最短**（同一次用户决定）：这一行是每隔
几分钟就要扫一遍的东西、一个孩子一行、外面还套着五块回执，信息保留、字数压缩；
- 满 120 秒没有推进 ⇒ 它的 `idle` 成立，照旧报「停下了（没有 declare_done）」；
- **没有进展戳**（还没跑过工具的新会话、或旧版扩展）⇒ **采信自报**。没有信息就不要
  凭空造出一个矛盾 —— 否则一个真的停下的子会话会永远显示 `working`，那正是 R3-5。
- **戳畸形**（不是能解析的 ISO 时间）按**没有戳**处理：从乱码里猜「是」是唯一能让
  项目经理**漏掉**一个已停子会话的方向。

顺序上它排在 `dead` / `waiting-input` / `done` / `stalled` **之后**：证据与进展戳只能把
「自报停下」降级成「还在干活」，不能把一具尸体说活。

### 2.5 等自己派出去的后台 subagent：也算 `working`（2026-09-09）

子会话用 `Agent` 工具派**后台** subagent 时（`run_in_background` 缺省即后台），工具
立刻返回「Agent started in background」—— 它自己的 turn 可能就此结束，`ctx.isIdle()`
随之变真，120 秒后就会被报成「停下了」。可它明明在等一件自己发起的事，和
`waiting-judge` 是同一个形状：一个健康的等待不该叫醒项目经理。

判据在 `lib/background-wait.ts`（纯模块，事件进、按 agent id 的待完成集合出）：

- **开始**：某个工具结果含 pi-subagents 的启动措辞（`started in background … Agent ID:
  <id>`）、不是错误结果、且该调用是**后台**的（`run_in_background` 非显式 `false` ——
  前台 Agent 的结果即使引用了启动措辞也不算）；启动失败不记；
- **结束**：**只有该 agent 自己的终态信号**移除它 —— `subagent-notification` 自定义
  消息的 `details.id`（成组通知的 `details.others[]` 一起算），或 `get_subagent_result`
  的**状态行**（`Agent: <id>` 下一行 `Type: … | Status: …`）落在终态集
  （`completed` / `steered` / `aborted` / `stopped` / `error`；`running` / `queued`
  是非终态轮询，状态行匹配不到也保持等待 —— 状态行锚定而非全文扫描，因为结果正文
  可能引用任意字样）。**没有超时、没有「新一轮开始就清空」**：一个没报终态的后台
  agent 就一直是等待 —— 宁可多报 `working`，不可把健康的等待报成停下（后者会让
  项目经理打断一轮还在跑的活）。

期间子会话上报 `working`，健康行显示「在干活（自上次推进 Ns）」。

**`idle` 行的读数也顺带修了**：它过去印的是**心跳时间**（「最后活动 11s 前」—— 心跳
每 40 秒一次，与「停下了」并排是自相矛盾），现在印「自上次推进 Ns」—— 一个刚结束
turn 的孩子（几十秒）和一个真停了 25 分钟的孩子（上千秒）一眼可分。



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

`mode` 就是 pi 自己的 `deliverAs`，**缺省 `interrupt`**（2026-09-17 用户决定）：

- `interrupt` —— 默认，最高优先级：`ctx.abort()` 停掉当前轮 + 解除挂着的框 + 带正文立即投递；
- `steer` —— 切进它当前这一轮（不 abort）；同时解除它挂着的框（by:`interrupted`）再投递；
- ~~`followUp`~~ —— **已从参数面取消**，传了直接被拒，拒绝文案指回 `interrupt` / `steer`。

取消它的理由是这个工具的语义：上级发话是因为子会话**现在**就该知道，一条在它要纠正的
那一轮之后才到的纠正，等于没人执行的纠正。默认值若是「最晚到」的那一种，那么最常见的
一次调用恰恰最没用。`followUp` 作为**通道枚举值**仍然存在，因为 judge 次轮派发用的就是
它（一轮任务确实是「你忙完再读」），子会话侧的读取/注入路径也照旧 —— 取消的只是项目
经理的参数面。

文本写进通道，由**子会话自己的门禁**用 pi 的 API 注入。**被替换掉的是什么**：
`tmux send-keys`，它产出过四条独立缺陷 —— 任务书被截断（F7）、没有 Enter 提交（F8）、
落到输入框还是 steering 队列全看时机（R-20），以及最糟的一条：消息里的换行被打开着
的对话框当成「提交当前高亮项」，替子会话答了一个它根本没打算选的选项（R-13）。
现在这四种都不可能发生，而且「框开着不许投文本」这条防御也不需要了 —— 框用
`orchestrator_answer` 回，消息只会排在它后面。

**回执依然要挣**，但它分两级（2026-08-30）：子会话的 `instruct-ack` 带 `stage` ——
`received`（门禁拿到并入队了）与 `injected`（pi 真的收下了）。

- **`steer` / `interrupt` 要求 `injected`**：它们承诺的是「当前这一轮」，排队不算。
  未指明 mode 的判定也按这条最严的走 —— 少写一个参数买不到更松的「已送达」。
  只拿到 `received` 时文案说的是**继续等**（消息在它的收件箱里没丢、先看是不是
  `waiting-judge`、别重发），而不是「改用 followUp」—— 指回一个工具自己拒收的模式，
  是取消 followUp 那一轮必须一起堵上的假出路。
- **两级回执本身仍然必要**，虽然 2026-09-17 之后**没有任何 mode 满足于 `received`**：
  它是「消息在它收件箱里、还没注入」这个事实的唯一记录 —— 投影靠它把消息留住（见下），
  文案靠它说「继续等」而不是「它从没收到」。曾经认 `received` 的是 `followUp`：它的定义
  就是「等你跑完这轮再读」，一个正忙的会话按定义**不可能**立刻注入，原来要求注入，于是
  这个 mode 恰恰在它为之设计的场景里必然失败，而消息其实已经写进通道了，就此沉底丢失
  （第四轮实测丢了一条补充授权）。这条规则随 mode 一起从判定里删掉了：judge 通道虽然
  仍写 `followUp`，但它那次派发是按 **pane 是否起来**验证的，从不经过这个判定函数 ——
  留着就是一条没有调用方的分支。

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
   子会话一次 `ask_user` 提交的多题是**一整批一起到**的（2026-09-06）：它在弹出
   第一个框之前就把全部问题写进通道，所以它们在**同一份回执**里，每条标着
   「采访 `<batchId>` 第 i/N 题」。答法也是一次：
   `orchestrator_answer({childId, answers:[{requestId, answer}, …]})` —— 每条
   独立裁决（某条被拒不挡其余条，已写进通道的不回滚），逐条 `requestId` 地答也
   照旧可用。子会话那边**仍然一次只弹一个框**，人随时可以介入，先答者生效；
   用户中途选「跳过后续」或你下发 instruct 打断，剩下那些没展示的题会被就地
   销账，不会挂在这里反复响铃。
3. **死亡与恢复** —— `dead` / `stalled` 的子会话、**未丢失的资产**（分支 / checkpoint /
   review 裁决 / 完成记录）、以及可直接执行的动作（`orchestrator_recover` 或 `orchestrator_close`）；
4. **你自己的上下文用量与接力时机**（见 §5.1）；
5. **还差什么才能 `declare_done`**（见 §5.3 —— 它与第 1 块读同一份 snapshot）。

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

### 5.3 收尾块与健康快照读同一份真值（B4）

`lib/orchestrator-gate.ts` 的 `orchestratorDoneProblems` + `lib/orchestrator-session-tools.ts` 的 `exitBlockers`

2026-09-04 实测，**同一份回执**里：第 1 块「t8a：**已完成**」，第 5 块「plan 还有 4 个
任务未完成：t8a(**running**)」+「还有 **1 个子会话活着**：t8a@%238」。两块都没算错 ——
它们算的是**两份不同的读数**：第 1 块读通道（子会话自己写的完成记录），第 5 块读
registry 的 `doneAt` 字段。而 `doneAt` 的写点在旧 probe 被删时一起消失了（b6492c5），
字段和它的 5 个读者留了下来，从此**恒为 undefined**。项目经理只能自己在两块之间仲裁，
再手工 `set-status` + `orchestrator_close` 收尾。

修法不是把写点补回去（那等于重埋同一颗雷：完成缓存必须在每一条重新派活路径上失效，
而当时 `orchestrator_instruct({mode:"interrupt"})` 带正文派新活时并不打派活戳 —— 那个
豁免已于 2026-09-17 取消，见 §2.1 第 3 条），而是
**删掉那份缓存**：`ChildSession.doneAt`、`markChildDone` 与 `orchestrator_wait` 里那条
读它的 `child-done` 判据全部移除（那条判据本身还是个忙轮询：标志永不清除，只要有一个
孩子报过完成，之后每次 wait 都会立刻返回）。完成只有一处真值 —— **通道**，由
`superviseChildren` 读一次，健康快照与收尾块都吃这一份。

「完成」这个事实由 `completionReported()` 单独回答，**不是**从状态里读的（`state === "done"`）。
两者的差别正好是一种真实情形：一个报完成之后 pane 才消失的子会话，状态是 `dead`（尸体
必须是监督者第一眼看到的东西），但它**确实做完了**。按状态读会把它从「已完成」里漏掉，
于是收尾块会对着一个交了活的子会话说「从未报告完成…必要时把任务改回 pending 重开」，
而第 3 块同时正把它的 `declare_done` 记录列为幸存资产 —— 又一次两块打架。取用入口也只有
一个：`reportedDoneIds(snapshot)`。


于是收尾块现在这么说（用户拍板，2026-09-17）：

- 「有 N 个子会话**已报完成、pane 还开着**：… —— 待你复验后用
  `orchestrator_plan({action:"set-status", …})` 收尾，再 `orchestrator_close` 关掉它」；
- 对应的 plan 行也写成 `t8a(running，孩子已报完成，待你复验后 set-status)`；
- **门禁不替项目经理把任务标成 done** —— 独立复验是契约要求的动作，自动标 done 会把它架空；
- 已报完成但 pane 还开着的子会话**仍然阻塞** `declare_done`（与修复前的实际行为一致，
  变的只是它不再自相矛盾）。

同一处还修了 F14 的第三扇门：注入提示词的收尾块过去在 `list-panes` 读失败时把存活
pane 列表传成 `[]` —— 空列表在这里的含义是「每一个登记过的 pane 都消失了」，于是一次
tmux 抖动就会告诉项目经理它的孩子全死了。现在读不到就是**未知**：不宣称任何死亡，把所有
未关闭的子会话按「都还活着」计入（保守方向是**挡住**收尾，绝不是凭空造一具尸体），
并在块里明说存活状态未知。

### 5.4 等待可以被人打断：外部消息就是第二个中断源（B5）

`lib/poll-wait.ts` 的 `notifyUserInput()` + `extensions/review-gate.ts` 里**已有的**
`pi.on("input")`

**事故形状（2026-09-04 第一轮端到端实测）**：项目经理调
`orchestrator_wait({timeoutMs: 900000})` 盯子会话，用户往它的 pane 里敲了一条消息 ——
消息进了宿主的 steer 队列，**排了 14 分钟不生效**：ESC 只切编辑器模式，只有 `Ctrl+C`
落地。这 15 分钟里项目经理对用户完全不可达。对照组刺眼：
`orchestrator_instruct(interrupt)` 对**子会话**秒到且有回执，项目经理自己却没有对应的门。

**实测（2026-09-06，`/tmp/b5-probe`：真实 pi TUI + expect 驱动 + 一个阻塞 90s 的探针
工具 + 从外部敲入的消息）**：

```
TOOL start seconds=90
INPUT source=interactive behavior=steer waitLive=true …   ← 阻塞进行到 23.0s
TOOL end reason=input-abort elapsedMs=23041               ← 170ms 后返回
```

所以宿主**确实**在工具阻塞期间派发 `input` 事件（`prompt()` 在检查 `isStreaming`
之前就调 `emitInput`），扩展里那个已经存在的 `pi.on("input")` 处理器就是全部所需的
扳机。**没有新工具、没有新通道、更没有「谁都能广播」的入口** —— 能拉动它的只有坐在
这个会话键盘前的人。

规则三条：

- **谁能拉**：`event.source !== "extension"`。门禁自己注入的
  `[REVIEW_GATE_RESUME]`、项目经理 `orchestrator_instruct` 的 `steer` 投递、以及 judge
  通道那条 `followUp` 次轮派发都**不算** —— `steer` 的语义是「带着这条继续做」，而
  `interrupt` 在宿主层本来
  就会 abort 当前 turn。否则一条例行注入就能腰斩一轮 review。
- **打断谁**：本进程里**每一个正在阻塞的 `pollUntil`**。它是等待骨架的第二个中断源
  （第一个是 `signal`，即 ESC），所以 `judge_wait` 与 `orchestrator_wait` 一起受益 ——
  子会话在 `judge_wait` 里被用户叫一声同样会提前返回（走它今天 ESC 中断走的那条
  `pending` 分支：`done: false`、附已等秒数，不会被误报成有结论）。
- **多快**：中断参与 probe 与 sleep 的 `Promise.race`，**毫秒级**，不是「下一个
  poll 间隙」。计数器是**基线**不是标志位：进入等待时读一次，因此等待**开始之前**
  到达的消息永远不会打断它，也没有任何东西需要「记得复位」。

回执因此分两种中断说话（`abortReason` / `details.abortedBy`）：ESC 是宿主取消了这次
调用；外部消息是**有人正在跟本会话说话**。后者的回执不含糊其辞地说「马上就到」——
**什么时候到取决于它是怎么发的**：回车发的 `steer` 切进当前这一轮（照常继续干活就会
读到），Alt+Enter 发的 `followUp` 要等这一轮 turn **结束**才送达。只有后一种情况回执
才说「别再一头扎回长阻塞，先把手上这一轮收掉让它进来」—— 否则项目经理会掉进同一个坑
的第二跳：被消息叫醒、转身又进 900s 阻塞，那条 followUp 仍在队列里等 turn 边界。

这句话与常驻的等待纪律②（「不是手写 sleep 轮询，**更不要结束 turn 把盯梢责任丢回给
用户**」，`lib/agent-directives.ts`）落在**同一个决策点**上，所以回执把两者的关系
写明，而不是留给项目经理自己调和：纪律②禁的是**用结束 turn 代替等待** —— 撒手不管、
指望被用户叫醒；而这里消息**已经在队列里**，turn 边界只是它进来的门，进来之后立刻
继续盯。两者要的是同一件事：盯梢责任一秒钟都不回到用户身上。

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

子会话不受影响 —— 框一直弹着，人随时能答（§3 的天然回退）。新会话直接
`set_gate_mode("orchestrator")`，再 `orchestrator_attach({ orchestrationId })` 接管现场：
plan、每个 child 的状态与资产、通道里未答的请求、孤儿检测结果，一次交还。

**id 不用你记**（2026-09-06，B1）：门禁自己去盘上找本仓库的候选编排 —— 先看门禁
sidecar 里记的那个，再看 `~/.pi/agent/rg-channels/` 下的通道目录名（编排 id 自带
repo 哈希，所以「哪些编排属于本仓库」是 id 自己回答的问题）。随便调一次 attach，
拒绝文案里就列着全部候选与可照抄的命令。

`attach` 会**采用**（adopt）那个 id，四个条件缺一不可：形状合法、属于本仓库、**盘上
能找到**（凭空编一个 id 会被拒 —— 那条通道上没有任何子会话在听）、且本会话还没有以
自己的身份登记过子会话（这最后一条是旧拒绝里唯一正确的那半：已登记的子会话会瞬间
失去归属）。

**批准不随接管转移**（用户 2026-09-06 拍板）：登记表是关于世界的事实，批准是用户
给上一任**会话**的许可。接管后 plan 在门禁眼里未获批，必须重新 `submit`（重跑审计 +
用户批准框）；回执会明说这一点。

**进入模式不再被旧 plan 挡住**：身份判定挂在真正需要身份的动作上 ——
`orchestrator_plan` 的 `write` / `submit` 与 `orchestrator_spawn`；`read` 与 `archive`
始终开放。旧版把这道判定放在 `set_gate_mode`，结果是「解开死锁的两个工具都在死锁
里面」，唯一可执行的建议变成手删门禁自己的 plan 文件（实测发生三次，监督者自己也
删过）。

### 6.2b 不接管、另起一轮：归档

`orchestrator_plan({ action: "archive" })`。门禁把 plan **连同编排登记表**写进
`.pi/orchestrator-plan.archived-<时间戳>.json`，并把原 plan 文件改名到它旁边的
`.raw.json`（**绝不 rm**：结构化归档对合法 plan 是忠实的，对解析不了的 plan 是有损的，
而那恰恰是原始字节最值钱的时候）。三道闸：

- 盘上登记的子会话 pane **还活着** ⇒ 拒绝，并指向接管（它们正在这份 plan 下干活）；
- 动手前**弹确认框**给用户（用户 2026-09-06 拍板）；没有 UI 时按拒绝处理，什么都不动；
- 登记表**随之清空**（副本已在归档文件里）—— 留着它，新编排的每一次 spawn 都会被
  `runtimeConflict` 永远拒绝，等于「清理」进了一个出不来的角落。

plan 与登记表**各自可能单独存在**（`rm` 时代留下的仓库就只剩登记表），所以任一半在
都能归档。

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
而是**唯一能改文件范围的入口是整份重写 plan，而扩一个文件是常态**：3 个任务里有 2 个
在实施中发现模块必须拆成两个文件（门禁自己的 600 行硬拦），项目经理在定 plan 时根本
无从预知。于是「派一个任务 → 撞边界 → 重写 plan → 叫醒真人」成了稳定循环。

**文件边界于 2026-09-17 被用户从 plan 中删除**，这一整类编辑因此不再存在：边界防不住
冲突，只剩「每次新开一个目录都要重新审计 + 重批」这一个作用。（当时同 repo 任务按
`repo` 键串行，边界确实什么都不防；**2026-09-10 起同 repo 任务各自拿到独立
`git worktree`，并行的真问题变成「会不会改到同一批文件」，而那由提交时的合并去回答**。）
`lib/orchestrator-boundaries.ts` 的边界代数、`approvedTree` / 目录树吸收 / done 任务
让出地盘这几条规则一并删除；留下的只有 `lib/out-of-repo-paths.ts` 的「仓库外 + 敏感
路径」判定（约束 8 的那道安全底线）。

现在 `write` 内部比对**已批准 plan 的授权快照**（runtime 里的 `approvedPlan`）与新
plan，把每一处差异归入两类之一：

| 判为**不扩权**（批准迁移到新内容，记一条审计条目，不弹框） | 判为**扩权**（批准失效，重新征求用户） |
| --- | --- |
| 任务被删 | 新增任务 |
| 增加依赖（更串行） | 删除依赖 |
| `parallel` → `serial` | `serial` → `parallel` |
| 降低 `maxParallel` | 提高 `maxParallel` |
| 收紧 `deliveryStation` | 提高 `deliveryStation`（放开更多 ship 命令） |
| 写回**此前已获授权**的内容（见下「撤回一次扩权」） | 任务改到另一个 `repo`（新写面，含改到 plan 里已有的另一个 repo） |

读不到授权快照时一律判扩权 —— fail-closed 的代价只是多弹一次框。

**撤回一次扩权不必重走批准**（2026-09-06）。第八轮实测：项目经理把某任务的 repo 改错了，
门禁正确判扩权、作废批准，它随即把 plan **原样写回** —— 与已批准
内容逐字节相同，批准却回不来，必须重走一次完整 submit（审计 + 用户批准框）。
现在 runtime 里存一条**批准世系** `approvedPlanHistory`：这份批准合法绑定过的
全部内容 hash（用户批准的那个 + 每次平移后的）。写回其中任一内容即把
`approvedPlanHash`、**授权快照与时间戳一并**恢复（只恢复 hash 的话，下一次细化会
撞上「没有授权快照」分支，等于把上面那条规则又废掉），并记一条审计条目。
它的安全边有三条：**用户每次新的显式批准会重置世系**（新决定覆盖旧决定，堵死
「先平移变宽 → 用户后来收窄 → 再写回宽版本」）；世系从 sidecar 读回时按
`approvedPlanHash` 的同等强度校验，**一条不合形状就整份丢弃**；换了新会话时它跟
批准一起被 `withoutPlanApproval()` 剥离（登记表与 grants 留下，许可一样不留）。
它的信任边界与 `approvedPlanHash` **完全相同、防线同一** —— 都在门禁不可授权编辑
的 sidecar 里；形状校验只做 fail-closed，不假装能识破一个格式合法的伪造项。

这几条规则**放宽了「批准」的含义**，所以它们写在用户批准的那份文本里
（`orchestrator_plan` 的 transcript 消息与确认框），不是事后才让人发现的规则。
每次迁移都记进 `runtime.approvalAmendments`，用户随时能查「为什么这次没问我」。


## 六乙、plan 也要先过审计

`lib/orchestrator-plan-audit.ts` + `orchestrator_plan({action:"submit"})`

原来的不对称：loop goal 必须先过 `goal-auditor` 才能弹批准框，plan 却直接送到人面前。
而 plan 错的代价更高 —— 任务发到错误的 repo 会让整个子会话白跑、依赖写错会让串行变并行、并行度
定高会烧资源，且这些都不是读文本能看出来的，得对着仓库查。

`submit` 内部吞掉整条链（与 `propose_loop_goal` 同一形状）：建审计任务 → 派
`goal-auditor`（**不新增角色**：审的都是「动手前的契约」）→ 等**本轮**的 channel report 落盘
（不是等进程退出，也不是拿通道里最新那条就算数——见下文「一轮裁决只属于那一轮」）→ 读它的结构化结论 →
裁决（**只 P0/P1 阻塞**）→ 记录。**审计不过就把 findings 退回给项目经理，一个框都不弹**；
过了才渲染批准框。裁决绑定 canonical plan 文本的 sha256，所以改任务状态不会让它失效，
改任务清单、repo、依赖或并行度就要重审；重审时门禁自动把上一轮的结论与 findings 带给审计者。

审计要点（写在任务模板里，条目顺序与编号以 `lib/orchestrator-plan-audit.ts` 为准）：
任务拆分是否完整、每个任务声明的 `repo` 是否覆盖它的真实落点、声明 `parallel` 的任务
**会不会改到同一批文件**（同一 repo 本身不再是问题：第二个写者拿到自己的
`git worktree`，真撞车会在结算时中止合并、不丢工作但白跑一轮）、依赖是否成环或缺失、
`maxParallel` 是否安全、每个任务是否可独立验收、最小化检查（2026-09-08：可合并的任务、
用户没要的工作、为并行而并行拆出来的任务是 P1）。

**PM 条（2026-09-17，PM=产品经理）**：需求是否已澄清、goal 是否可派生——逐任务核对
`plan.decisions` 有无未解决（缺 `resolvedAt`）的需求决策、任务书是否达到『子会话拿到
就能独立协商 goal』的完整度（只写『做分页』没有交互/边界/验收标准就是 P1）、以及读
PM 的 transcript 里 ask_user/grillme 的 Q&A 段验证澄清结论真的落进了 plan。
项目经理同时承担产品经理角色：**plan 提交前必须把涉及的项目代码过一遍，摸清每个子
会话的 goal 才能起 plan**，禁止在需求未澄清前开工。

**需求反述已经是门禁固化的前置步骤（2026-09-06）**，不再靠这段劝导：`submit` 在派审计
之前先查「有没有一份用户确认过的反述」（`propose_restatement` 写进 gate-state 的
`restatement` 记录），没有就**直接退拒绝文案、一个框都不弹**，与审计不过同一形态。
反述要写的内容、接受哪些「改之前 → 改之后」写法、拒绝文案里那份可照抄的骨架，
唯一出处是 `lib/restatement.ts`——这里不复述。同一次确认里还定下**本轮交付站点**
（`precommit` / `commit` / `pr`），它同时是 plan 的 `deliveryStation` 字段（缺省 `precommit`，
进 canonical 文本因此进批准 hash）。

**代批不是橡皮图章（2026-09-06，用户要求）**：代用户批准子会话的 goal、或代确认它的
需求反述，`orchestrator_answer` 必须带 `crosscheck` —— 写出该 plan 任务 id，并对
「任务目标 / 交付站点」两项各给一句判断（词表与判定在
`lib/orchestrator-answer-tools.ts`，接受的写法逐条列在 `PROXY_CROSSCHECK_TOKENS`；
“文件边界”那一项已随文件边界一起删除，2026-09-17）。
缺任一项即退回，并把 plan 里那个任务与子会话提交的正文**并排**贴回，附可照抄的骨架；
门禁在这里不提供申诉出路（它不是 ship block，`request_arbitration` 受理不了），但**有一条真出路**并写在
退回文案里：认为门禁误判就让**用户本人在他自己那个框里批**——这条约束只加在「代答」上，用户不受限；
拿不准就 `ask_user` 请他拍板（2026-09-06 用户裁定：不给走不通的申诉指引，但必须给走得通的出路）。
拒绝不需要对照。子会话请求确认的站点若**宽于**已批准 plan 的 `deliveryStation`，
代答一律被拒——放宽站点是用户的决定；用户本人在自己框里批不受此约束。

**站点在两层的含义不同，别把执行层的拦截搬到编排层**（2026-09-06 用户裁定）：在编排层，
plan 的 `deliveryStation` 是**授权面**——它划定子会话能被授予到哪一站，`orchestrator_answer`
据此拒绝宽于它的代答；真正的**拦截**发生在执行层，由每个子会话自己的 ship 门禁在它那个仓库里
兑现。因此项目经理的 `declare_done` **不判到站**：PM 名下确实有一个仓库（`sessionRepos` 一直
含主仓库），但那是**编排仓库**——约束 2 下它只能往那里写 plan 与交接文档，那个工作区干不干净
与「编排有没有走到站」无关（几条没提交的 plan 笔记会被读成「没到站」）；而 PR 证据写在
**ship 真正发生的那个仓库**、也就是子会话仓库的 sidecar 里，`declare_done` 走的是 PM 自己的
仓库集合，永远看不到它——真去判，一个 `deliveryStation: "pr"` 的编排会被一条永远
满足不了的条件卡死，回执还会一本正经叫它「去开个 PR」，正是第四轮心跳事故那种「照门禁说的做
反而出事」。理由与反证写在 `orchestrationDoneProblems()` 的 docblock 里（并有结构测试钉住，
防止下一轮当成漏项补齐）；PM 的退出契约仍然是 plan 本身：任务全 done、无活着的子会话、
未决策全部通知过。

**loop 侧配套（2026-09-17）**：loop 模式下累计 60 轮未获批 loop goal（`turnsWithoutGoal`
持久化计数，重启延续），门禁在每轮注入强提示要求先协商 goal 再干活（只注入提示、
不硬拦工具——用户决策），goal 获批后计数清零。

**一轮裁决只属于那一轮（2026-09-04，实测 P0）**：审计等待结束后，门禁**不再**无条件把
channel 里最新那条 report 当成本轮结果。`selectRoundReport`（`lib/audit-round.ts` 的纯函数，
2026-09-05 从 `orchestrator-plan-audit.ts` 搬来并改名）拿三件真值做判定 —— `judge_wait` 的
`details.done/reason`、本次 dispatch 登记的 `roundSeq`、以及等待**开始前**的 `lastReportId`
游标；只有「等到了 report」且「report 的 `round` 等于本轮」且「不是已消费过的那条」三者
同时成立才解析裁决。任何一项不成立都是**审计未完成**：`state.planAudit` 一个字都不写，
退回「什么都没有记录，直接再 `submit` 一次重跑」。

goal 审计不是「走同一个纯函数」而已 —— **它和 plan 审计现在是同一段代码**（2026-09-05）：
`runAuditRound(spec)` 一份实现，两条链只差一份 spec（措辞、pane 标题前缀、记录绑定）。
code review 的结论段也归到同一个 `settleAuditRound`，所以「哪份 report 收本轮、什么时候
推游标、谁来记录」在整个门禁里只有一处答案。

**代码审查的裁决不得滞后内容一轮（2026-09-05，一晚实测 4 次的 P0）**：review 的 report 绑定
原来只认游标，于是出现了这条时间线 —— reviewer 交卷写进通道的 report **积压不送达**（agent
在一个长 turn 里改代码，既没 settle 也没再 `judge_wait`），下一次 `judge_submit` 提交了新
checkpoint 后，settle 立刻把**上一轮**那份旧 report 当成本轮裁决记下并绑到新 commit 上：一份
「指出 P2 还在」的裁决，去放行了「声称修好那条 P2」的代码。四次误绑的共同特征只有一句 ——
**report 的生成时间早于本轮 checkpoint**。

现在 review 的绑定是 `round-and-content`，两条判据**同时**成立才记录，任一不成立都 fail-closed
（用户决策：round 对不上时**不许**退回时间戳）：

1. `report.round` 等于本轮 dispatch 登记的 `roundSeq`（judge 交卷时从登记表读同一个数，
   judge 侧代码一行没改）；
2. `report.at` **严格晚于** `state.checkpoint.at`（本轮内容诞生的时刻）。

三条 fail-closed 边界：report 没有 round、登记表没有 `roundSeq`、**在 checkpoint 确实存在的前提下**
report 没有可解析的 `at` —— 一律不记录。goal / plan / adviser 三种轮次**不受影响**
（`roundBindingFor` 只给 review 塞 content 时间戳），否则一个还没 checkpoint 过的新会话的第一次
goal 审计就会永远等不到结论。

**唯一的例外，而且它不是放水（2026-09-05，reviewer 的 P1 + 用户当场裁决）**：**门禁状态里一条
checkpoint 记录都没有**时不拒绝（注意是门禁状态、不是 git 历史 —— 记录在会话自己的 sidecar 里，
换 session 即从空开始）。那正是 `prepare_review` 明确支持的「audit the exit goal」轮 ——
空范围（HEAD..HEAD）、要求工作区干净、reviewer 判的是任务是否完成而不是 diff；这种轮次里**没有
被冻结的内容**可供裁决滞后。对它 fail-closed 换不来安全，只换来**不可收敛**：记录侧永远不记、
探测侧（本轮改动后）永远不收口、READY 永远拿不到。此时 round 绑定与游标照常强制，上一轮遗留的
report 仍然被拒。

**而且这条例外会自报家门（2026-09-05，项目经理的约束）**：走这条路记下的裁决，返回给 agent 的
文本里必带一行「本轮绑定说明：**门禁状态里**还没有可比的 checkpoint 记录（新会话 + 干净 worktree
的第一轮就是这种情况，与 git 历史里有多少 checkpoint 提交无关），这是 exit-goal 空范围轮 ——
内容时间判据**不适用**，本轮裁决只由 round 与 cursor 绑定」。措辞刻意说的是**门禁状态**而不是
「本仓库」：checkpoint 记录存在会话自己的 sidecar 里、每换一个 session 就从空开始，所以一个 git
历史里有几十个 checkpoint 提交的仓库照样会走到这条分支（reviewer 的 Nit，2026-09-05）。
它由 `REVIEW_ROUND_SPEC.degradedContentBinding` 提供措辞、由引擎在**与跳过判据完全相同的条件**下
挂上，并且作为**独立字段** `bindingNote` 一路传到 `buildStandardReport`（那里的「记录」行只打印
首行，把说明塞进记录正文等于记了但没人看见）。理由是项目经理的原话：要反对的从来不是降级，
是**看不见的**降级 —— 一个没人看得见的例外，三轮之后就会被当成规律。单测两侧都钉住：
正常轮**不得**出现这行，降级轮**必须**出现。

**判据只有一处，等待侧与记录侧共用**：`probeJudgeRound`（`judge_wait` 与 settle 扫描的探测）
以前自己比一句「最新 report ≠ 游标」，那正是「wait 打出『本轮已有 channel report：结论 READY』
而记录侧随后拒绝它」的来源。现在它调同一个 `selectRoundReport`：不属于本轮的 report **不算本轮
结束**（继续等），并原样报成一行「未采纳的 report：<id>（round/时间）—— <原因>；没有记为本轮
裁决」。既不静默丢弃，也不冒充结论。

已知的**退化情形**（不是缺陷，是事实）：worktree 干净时 `review_checkpoint` 不提交也不刷新
`checkpoint.at`，所以「零改动重新绑定」的那一轮里时间戳判据退化，此时挡住旧 report 的是 round
与游标。两条判据都挡不住的理论情形只有一种：reviewer 拖到下一轮 checkpoint 之后才交卷 ——
它交卷时会重读最新的 `roundSeq`，两条判据都会认为它属于新的一轮。


**「已被 wait 记下」不是过期（2026-09-05，adviser 发现的 P0）**：同步审计链的等待走的就是
`judge_wait`，而它自己也经引擎记录并**消费游标**。所以链回来时本轮 report 往往已经记完了 ——
把这种情况当成过期，代价是每一次 goal/plan 审计都失败。而改这条链的会话跑的是启动时加载的
旧扩展、自己测不出来，只能靠 `test/audit-round.test.ts` 的单测钉住。

**怎么判断「已经记完了」：看记录留下的那对写入，不要再问一次 settle（2026-09-05，reviewer
发现的第二个 P0）**。第一版判据是「二次 settle 返回 `already-consumed`」，它在生产里走不到 ——
记录成功会先 `forgetPending`，而 pending 正是 `specForRound` 挑 kind 的依据，所以二次 settle
返回的是 `unknown`，和「压根没派过审计」长得一模一样。现在的判据是 `roundClosedDuringWait`：
**pending 已被消费**且**游标已从等待前的位置前进** —— 这两件事只有 `settleAuditRound` 记录
成功时才会同时发生。两个条件缺一，就由本链自己 settle，仍然 fail-closed。

配套的游标规则同样重要：`dispatchJudgeRound` 复用 pane 时**保留** `lastReportId`（重派不
等于把旧 report 变新），`fresh:true` 开新 pane 时把游标**播种**到 channel 当前最新那条
report（新 review 对象不该被上一个对象的结论终结）。原来的行为是把游标清空 —— 于是每次
重派的等待都被上一轮的 report 瞬间命中，`BLOCKED` 过一次的 plan/goal 永远拿不到新裁决，
编排层就此出工死锁。

## 六乙、任务书的最后一句话是门禁的

`buildTaskDocument` 生成的任务书，在项目经理的 brief **之后**由门禁追加一段
**硬指示**（`TASK_GOAL_DIRECTIVE`，2026-09-01）：

> 本会话的退出条约是你自己的 loop goal。任务书只是 plan 交给你的那份工作，不是你的 goal；
> plan 批准 ≠ goal 批准。顺序是两步，不能跳：**先**用 `propose_restatement` 把你对需求的
> 理解反述给用户确认（上下文、例子、改之前 → 改之后、哪几步会变得不同，外加本轮交付站点
> precommit / commit / pr），**再**用 `propose_loop_goal` 协商并获批你自己的 goal
> （goal-auditor 审计 + 用户批准）。没有已确认的反述，`propose_loop_goal` 会直接被拒、
> 一个框都不弹；未批准 goal 前，L8 edit gate 会拦下所有 edit/write。

（这段引文与 `lib/orchestrator-delivery.ts` 的 `TASK_GOAL_DIRECTIVE` 是同一份文本的摘录，
改那个常量时同轮改这里——两处说法不一致时，以常量为准。）

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
等）的结果会被追加一行提醒——每 5 分钟最多一次、每会话最多 2 次，explore/normal/orchestrator
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
| `lib/orchestrator-child-state.ts` | 状态判定与 `CHILD_STATES` 清单（八态，含 `waiting-judge` / `mode-changed`）、健康行、退避常量 | 纯函数 |
| `lib/orchestrator-supervisor.ts` | 编排侧：读所有通道、判定、决定什么算新闻、渲染回执 1–3 块 | 纯（IO 经 seam） |
| `lib/orchestrator-handoff-advice.ts` | 上下文用量 → 接力时机 | 纯函数 |
| `lib/orchestrator-wait.ts` | 等待判据、预算、回执装配（含第 4、5 块） | 纯函数 |
| `lib/orchestrator-answer-tools.ts` | `orchestrator_answer`（含约束 8 的仓库外敏感路径检查、代批必填的 `crosscheck` 对照与其词表、站点不得宽于 plan 的判定） | 判定可单测 |
| `lib/orchestrator-recovery-tools.ts` | `orchestrator_recover` / `orchestrator_attach`、孤儿检测 | 孤儿判定是纯函数 |
| `lib/orchestrator-takeover.ts` | 盘上候选编排 id 的发现、接管采用判定、接管/归档路由文案、归档载荷与确认框文案（§6.2 / §6.2b） | 纯函数 + 注入式读盘 |
| `lib/orchestrator-tmux.ts` | 仅剩的 tmux 构造：开/关/列 pane + 读窗口几何 + `select-layout -E` 等分 + pane 装饰（不带 `-g`）；三列布局的落点与等分判定在这里 | 纯函数 |

协议级测试（不依赖真实 tmux、不依赖 pi 进程、不碰磁盘）：
`test/orchestrator-channel.test.ts`、`test/orchestrator-child-state.test.ts`、
`test/orchestrator-handoff-advice.test.ts`、`test/orchestrator-tools.test.ts`。
