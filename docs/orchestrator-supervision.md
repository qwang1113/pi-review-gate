# 编排监督（orchestrator supervision）契约

**这份文档回答一个问题：项目经理会话怎么知道某个子会话此刻在干什么，以及门禁凭什么这么判。**

监督能力由四块代码组成，各自的职责边界是硬的：

| 模块 | 职责 | 纯度 |
| --- | --- | --- |
| `lib/orchestrator-child-state.ts` | 五态判定、重提退避、健康快照的数据形状与渲染 | 纯函数（观测进、状态出；时钟由 `at` 传入） |
| `lib/orchestrator-probe.ts` | 周期观测的 IO 外壳：抓屏、读 sidecar、维护每个子会话的记忆、堆事件队列 | 有 IO，无判定 |
| `lib/orchestrator-wait.ts` | `orchestrator_wait` 的判定优先级、attention 归属校验、等待预算边界 | 纯函数 |
| `lib/orchestrator-session-tools.ts` | 把上面三者接成 `orchestrator_wait` 一次调用（`doWait`） | 装配 + 回执文案 |

等待循环本身不在这里：`lib/poll-wait.ts` 的 `pollUntil` 是通用骨架（探测 → 发布 → 命中判据或预算到点），
judge 等待与子会话等待共用它，只是判据不同。

> 历史溯源：本文出现的 R-xx / F-xx 编号沿用上面这几个模块**头注释里**的编号（编排能力两轮端到端复盘的内部编号，
> 逐条现象与证据就写在那些头注释里，本仓库没有一份收录这套编号的独立复盘文档）。
> 每一条保守规则都对应一次实测死锁，去掉它们不是"简化"，是把死锁装回去。

---

## 1. 子会话的五种状态

判定入口是纯函数 `classifyChildState(observation, memory, opts)`，返回 `ChildStateVerdict`
（`state` / `reason` / `stableMs` / 下一轮要带的 `memory`）。

| 状态 | 含义 | 谁来处理 |
| --- | --- | --- |
| `working` | 在产出，或可证明地阻塞在它自己发起的工作上 | 没人，等着就行 |
| `waiting-input` | 有对话框（或门禁的提问暂停）在等回答 | 项目经理必须去答 |
| `done` | 它自己的 sidecar 记着 `declare_done` 已被接受，且画面已静止 —— 任务完成 | 项目经理验收：派下一条任务，或 `orchestrator_close` |
| `idle` | 活着、屏幕不动、也没有任何在途工作 —— 它停了（**没有**完成记录） | 项目经理去问它为什么停 |
| `dead` | pane 没了 | 项目经理去善后 |

> **`done` 是第三轮补上的（R3-5，P0）。** 在此之前"完成"根本没有判据：一个 reviewer READY、
> full precommit、`declare_done` 已接受、分支已合并的子会话被判成 `working`，画面静止 **725 秒**
> 仍不产生任何事件。而同样完成的另一个子会话因为屏幕上恰好残留了别的字被判成 `idle`，47 秒后
> 正确唤醒了项目经理 —— **一个有信号、一个永远没有，取决于终端上留了什么字**。
> `working` 是"一切正常"，没人会去看它；那一轮是人盯着"已静止 718s"这个数字**起疑**才发现的。
> 发现任务做完了，必须是一个信号，而不是一次怀疑。

### 1.1 判定顺序（顺序即设计）

`classifyChildState` 自上而下短路，命中即返回：

1. **`paneAlive === false` → `dead`。** pane 明确不在了，别的都不看。
2. **`paneAlive === undefined` → 沿用上一次的状态**（没有上一次记录、或上一次是 `dead`，都退回 `working`）。
   存活"读不到"不是"死了"（F14）：`tmux list-panes` 读失败一次就宣告死亡，会永久终止对一个健康子会话的监督。
3. **`dialogOpen === true` 且 `stableMs >= WAIT_INPUT_STABLE_MS` → `waiting-input`。**
   要求画面已经静止，是为了把"正在重绘的一帧"和"真的在等人答"分开。
4. **`sidecar.pausedQuestion` 为真 → `waiting-input`。** 这是子会话自己写下的结构化事实（`ask_user` 暂停），
   比屏幕更可信，屏幕滚走了它也还在。
5. **`dialogOpen === true` 但画面还在动 → `working`。** 先按在跑处理，下一轮探针再定。
6. **`sidecar.judgeRunning` 为真 → `working`。** 阻塞在 judge 子进程上是正常工作态。
7. **`sidecar.completedAt` 存在（或登记表已记 `doneAt`），且指纹相对上一次没变、屏幕末尾也没有在跑的标志
   → `done`。** 这一步的排位就是全部设计：它**之下**全是屏幕文本 —— 正是把一个已完成子会话判成
   `working` 725 秒的那些字；它**之上**全是"轮不到它说了算"的情况（有人在等它答、judge 还在跑）。
   要求画面静止，是为了把"它做完了"和"它做完了又立刻开始下一件事"分开，代价只有一个探针周期。
8. **屏幕末尾若干行里有在跑的标志（`screenLooksBusy`）→ `working`。**
9. **屏幕指纹相对上一次发生变化 → `working`。**
10. **指纹读不到（`capture-pane` 失败）→ 沿用上一次的状态**（同第 2 条：没有记录或上次是 `dead` 时退回 `working`）。
11. **`stableMs >= IDLE_AFTER_MS` → `idle`。** 到这一步才允许说"它停了"：没有对话框、没有在跑标志、
    没有 judge 子进程、没有完成记录、屏幕指纹也一直没变。判定文案里会带上它是否已经 `declare_done`。
12. 以上都不满足 → `working`（静止时间还没到阈值）。

被重新派活的已完成子会话会回到 `working`（屏幕变了），干完新的一轮再静下来时又是 `done` ——
所以这是"每进入一次 `done` 就响一轮铃"，不是一次性开关。

**但完成记录必须是关于「当前这次派活」的**（第一轮 review 的 P1）：`declare_done` 写下的记录没有任何路径会清掉它，
如果不比时间，一个被派了第二件事的子会话只要屏幕一静止就又被判 `done` —— 而那和它**卡在新任务上**长得一模一样，
于是唯一不响铃的状态会吞掉唯一必须被听见的情况。所以：
`orchestrator_spawn` 与每一次送达的 `orchestrator_send` 都会在登记表上盖一个 `lastAssignedAt`，
并**清掉 `doneAt`**（那条 `doneAt` 还会把子会话从编排退出检查里滤掉，等于允许项目经理在它仍在干活时收工）；
`classifyChildState` 只承认**不早于**这个时间戳的完成记录，早于它的一律当历史 ——
此时子会话静止到阈值就是 `idle`，判据文案会写明"那条完成记录属于上一轮任务"。
时间戳解析不出来时退回旧行为（任何完成记录都算数），因为"永远到不了的 `done`"就是 R3-5 那次停摆本身。

### 1.2 阈值与常量

| 常量 | 值 | 作用 |
| --- | --- | --- |
| `WAIT_INPUT_STABLE_MS` | 2 000 ms | 对话框要静止这么久，才算"在等人答"而不是"在重绘" |
| `IDLE_AFTER_MS` | 45 000 ms | 一切都不动这么久，活着的子会话才被判 `idle` |
| `ACTIVITY_TAIL_LINES` | 12 行 | "在跑的标志"只在屏幕**末尾**这么多行里找（R3-5a） |
| `DONE_REPORT_LIMIT` / `DONE_REWAKE_MS` | 2 次 / 60 s | `done` 最多响两次铃，间隔 60 秒，之后闭嘴 |

`IDLE_AFTER_MS` 故意给得宽：把在跑的子会话误判成 `idle`，代价是一次假唤醒加一次对真实工作的打断；
判得慢的代价只是多等一个探针周期。两者不对称，所以偏慢。
两个阈值都可以通过 `opts.idleAfterMs` / `opts.waitInputStableMs` 注入覆盖（测试用）。

### 1.3 三种真值，按可信度排序

判定用到的观测（`ChildObservation`）来自三个独立通道，可信度依次递减：

1. **结构化真值（最可信）** —— `ChildSidecarFacts`，由 `lib/orchestrator-probe.ts` 的 `structuredFacts()` 组装：
   - `judgeRunning`：从 judge run 目录读出来的（`OrchestratorDeps.childJudgeRunning`），
     即使子会话还没写过 sidecar 也成立；
   - `pausedQuestion` / `reviewVerdict` / `precommitVerdict` / **`completedAt`**：从子会话自己的门禁 sidecar
     （`OrchestratorDeps.childGateState(cwd, stateVariant)`）里取。
     `completedAt` 来自子会话 `declare_done` 被接受时写下的 `completion` 记录（`at` / `merge` / `summary`），
     它是 `done` 态的唯一判据 —— 门禁本来就知道这件事，以前只是没写下来（R3-5）。
     损坏或伪造的 `completion` 在 `loadSidecar` 里被丢掉，方向是安全的：读不出完成记录 = 继续监督。
     这里刻意只取这几项：sidecar 里别的都是诊断信息，全解析一遍会让探针随 schema 演进而反复破。
     （另有一项**不参与状态判定**：`sessionEditedFiles`，见 §2.6 的约束 8 落点监测。）
2. **pane 存活**：`tmux list-panes` 的结果，三值 —— 在 / 不在 / **读不到**。读不到单独成一档，绝不折叠成"不在"。
3. **屏幕（最弱）** —— `capturePane`（默认抓 `PANE_CAPTURE_LINES` = 120 行 scrollback）：
   - `dialogOpen` 来自 `dialogIsOpen(snapshot)`，见下条；
   - `screenText` 只用于 `screenLooksBusy` 与指纹比较。

**对话框判定是 footer 锚定的**（`lib/orchestrator-pane-read.ts`，R-1/R-9）：只有当屏幕上出现选择列表的按键提示
（`↑↓ navigate  enter select …`，正则 `DIALOG_FOOTER`）时才认为有对话框，并且只解析**该 footer 上方**
最多 `DIALOG_REGION_LINES` = 30 行的区域；`dialogIsOpen` 还要求解析出的选项 ≥ 2 个。
没有这层锚定，`belowEditor` 的子代理小部件（`▶ reviewer | # Task for reviewer`）会被当成"对话框和它唯一的选项"，
真对话框反而被它挤掉 —— 那是一次 25 分钟的死锁。

### 1.4 为什么不能用"token 零增长"或屏幕启发式判 `idle`

这是整个模块围绕着建的陷阱（R-23），且有实测反例：

- **计数器冻结 ≠ 停了。** 阻塞在 `judge_wait` 里 550 秒的子会话、跑 700 秒轮询循环的子会话，
  屏幕和 token 计数都一动不动，两者都完全健康。把它们判成 `idle` 就是去打断真实工作。
- **计数器在动 ≠ 在干活。** pi 的 pane 会自己渲染 token 数、花费、已用秒数、上下文百分比，这些数字自己就会跳。
  拿原始文本逐字比较，永远都是"变了"，于是什么都不会被判成 `idle`。

所以有了 `screenFingerprint(text)`：**把所有数字替换成 `#`**，再折叠空白、裁掉行尾空格。
它是"这块屏幕除了自走的计数器以外有没有变"的可比形式，而且**只是三种信号里最弱的一个** ——
只有在结构化真值全部否定了"在途工作"之后，指纹静止才被允许推出 `idle`。

`screenLooksBusy(text)` 是另一半：命中 `IN_FLIGHT_SIGNATURES`（`esc to interrupt` / `Working` /
`Thinking` / `Running` / `esc to cancel` 等）就算有一轮在飞。它被导出，是因为投递侧也要问同一个问题（R-20）：
往忙碌的子会话里投一条 slash 命令不会执行，只会排进 steering 队列，所以门禁自己等空闲窗口。

**它只看屏幕末尾 `ACTIVITY_TAIL_LINES` 行（R3-5a）。** 以前是整屏 `includes` 匹配，而 pane 上留着这个会话
打印过的一切 —— 每一轮都会出现的 `Working` / `esc to interrupt` 一旦出现过就永远命中，于是子会话余生都是
`working`。活动指示是 composer 渲染的，就在屏幕底部；12 行足够覆盖它加上 `belowEditor` 小部件和状态行，
又把上面的历史输出排除在外。刻意不取 1–2 行：抓屏抓到一帧重绘就会读成"停了"，那是更贵的错误方向
（去打断真实工作）。末尾的空行会先被剪掉，免得把活动指示挤出窗口。

---

## 2. 周期探针：把"不会自己发事件"的状态变成事件

项目经理只能对**事件**做反应，而四种要紧情况里有三种根本不产生事件：
没人答的对话框、悄悄停下的子会话（R-23）、消失的 pane。所以门禁自己按时看，并**制造**这些缺失的事件。
等待语义没有变 —— `orchestrator_wait` 仍然是在等事件，只是多了一个不依赖子会话主动喊的事件源。

### 2.1 一次 `observe()` 做什么

`createChildProbe(deps)` 返回的 `ChildProbe.observe(now?)`，对每个**未关闭**（`closedAt` 为空）的子会话：

1. `capturePane` 抓屏、**读一次**子会话 sidecar（状态真值与落点比对共用这一次读）、`list-panes` 查存活
   （读不到就是 `undefined`）；
2. 调 `classifyChildState`，用**上一轮存下来的 memory** 比对，并把 `lastAssignedAt`（没有就退回 `createdAt`）
   一起传进去，让完成记录能和"当前这次派活"比时间；
3. 调 `decideChildEvent` 决定要不要响铃，并把新的 memory 写回；
4. 判成 `done` 且登记表里还没有 `doneAt` 时，**把完成写回登记表**（`markChildDone`）——
   在此之前这个函数全仓没有任何调用方，`doneAt` 永远是空的，于是 `orchestrator_status` 的完成显示、
   调度里的"这条任务还在跑吗"、`declare_done` 的存活检查读的全是死字段（R3-5）；
5. 比对 `sessionEditedFiles` 与该任务的 `fileBoundaries`，有新的越界落点就再产生一条事件（§2.6）；
6. 把这一轮的判定塞进健康快照 `ChildHealth[]`。

收尾还做两件事：**已经关闭的子会话的 memory 会被删掉**（否则它的退避会永远活着），
以及队列按 TTL 与上限裁剪。

memory 存在闭包里而不是落盘，是有意的：它是**观测缓存**（上次屏幕长什么样），不是重启后必须恢复的事实。
新进程重新开始观测，第一轮会把所有子会话都判成"变了" → `working`，这是安全方向 —— 只会错向"在跑"，
绝不会错向"停了"。也正因如此，探针实例是**共享的**（`OrchestratorDeps.probe()` 惰性单例）：
在 `orchestrator_wait` 里新建一个探针，会把每一屏都看成"变了"，于是永远观测不到子会话已经停了。

### 2.2 节奏与容量

| 常量 | 值 | 位置 | 含义 |
| --- | --- | --- | --- |
| `PROBE_INTERVAL_MS` | 10 s | `orchestrator-probe.ts` | 后台定时器跑探针的间隔 |
| `PROBE_EVENT_TTL_MS` | 5 min | `orchestrator-probe.ts` | 比这更旧的事件不值得再叫醒任何人 |
| `PROBE_QUEUE_MAX` | 20 | `orchestrator-probe.ts` | 最多为消费者留这么多条事件 |
| `REWAKE_BACKOFF_MS` | `[10s, 30s, 60s]` | `orchestrator-child-state.ts` | 同一个未解决状态的重提间隔 |
| `DEFAULT_POLL_MS` | 2 s | `poll-wait.ts` | 等待循环内部两次探测的间隔 |

### 2.3 什么时候响铃：边沿触发 + 电平重提

`isNewsworthy(state)` 认四种状态：`waiting-input`、`done`、`idle`、`dead`（`working` 从不响铃）。

`decideChildEvent(verdict, previousState, now)` 的规则：

- **进入**一个 newsworthy 状态（`previousState !== verdict.state`）→ 必响；
- 状态**没变但仍未解决** → 距上次上报 ≥ `nextRewakeDelayMs(alreadyReported)` 才再响。
  `alreadyReported` 是**已经报过的次数**，所以第一次重提等 10s，第二次 30s，之后每次 60s，
  而且是**从上次上报**开始算，不是从状态变化开始算；
- **`done` 是终态，单独一套**（用户拍板，2026-08-30）：最多响 `DONE_REPORT_LIMIT` = 2 次，
  第二次在 `DONE_REWAKE_MS` = 60 秒后，之后彻底闭嘴。理由是两头的：反复催一个已完成的子会话毫无意义
  （项目经理做什么都不会让它"更完成"），但只响一次又太脆 —— 项目经理可能正卡在**另一个**子会话的长 `wait` 里。
  `reported` 在状态切换时清零，所以"被重新派活 → 再次完成"会重新获得两次响铃；
- 响铃时把 `reported + 1` 和 `lastReportedAt` 写进 memory 一起返回 —— 调用方没有"忘记记录已响过"的机会。

为什么要重提：**"事件被取走"不等于"事情被办了"**（F12）。第二轮实测里，一个没人答的对话框在被消费一次之后
就再也不产生事件，子会话在框前面干等了六分钟。所以未解决的等待会反复叫，间隔越来越大 ——
够响到不会被忽略，又不至于淹掉项目经理自己的工作。

### 2.4 事件怎么送到项目经理面前

制造出来的事件进一个队列，**由谁投递谁来 `drain`**，因此每条事件只被送达一次。两个投递者：

- **`orchestrator_wait` 内部的每一次 poll**（`doWait` 的 `probe()` 里先 `childProbe.observe()` 再 `drain()`）；
- **后台定时器**（`extensions/review-gate.ts`，仅在 `taskMode === "orchestrator"` 时武装，间隔 `PROBE_INTERVAL_MS`）：
  它只在会话**空闲**时（`ctx.isIdle?.()`）才 `drain`，并以 `[ORCHESTRATION_PROBE]` 前缀的消息
  `triggerTurn` 唤醒项目经理 —— 轮次进行中投递只会变成噪音，而等待中的那条路径本来就自己在跑探针。
  定时器 `unref()`，绝不为了监督而吊住进程；探针整体是"便利设施，永远不是门禁条件"，抛错被吞掉。
- 此外，项目经理会话的 `agent_settled` 续跑（`orchestratorSettled`）也会 drain 一次，把新消息连同健康快照
  一起塞回下一轮。

`drain({ now, childId })` 的**指名语义很重要**：带 `childId` 时只取该子会话的事件，
**兄弟子会话的事件继续留在队列里**。在这里丢掉它们，就是 R-16 那一类静默丢失换个队列重演。

`drain` 返回的是 `{ events, stale }`（R3-3）：出队时会拿**当下**的真值再核一遍，
子会话已经关闭、或它现在的状态已经不是事件里那个状态，这条就不再当成新闻。
第三轮复现了三次"回执自相矛盾"：刚答完框、以及 `orchestrator_close` 之后，`orchestrator_wait` 立刻以 0s 返回
「它进入 waiting-input / idle」，而同一份回执里的健康快照说的是另一回事 —— 没有丢东西，但项目经理会为一个
已经消失的框白跑一次 `orchestrator_read`。被作废的事件**照样点名**（回执里进"已消费但判为已办成"那一段，
后台定时器则标成"（已作废，不用处理）"）：静默吞掉正是 R-16 的反面错误。
越界事件（`kind: "boundary-breach"`）不随状态过期 —— 它说的是已经写下去的文件，不是此刻的状态。

`ChildProbe` 的其余两个方法是只读的：`pending(now?)` 报队列长度，`lastHealth()` 返回最近一次快照而不重新观测。

### 2.5 与 attention 事件的合流

两个事件源在 `doWait` 的一次 poll 里按固定顺序合流：

1. 先 `observe()` + `drain()` 取**探针事件**；只要有，立刻返回，attention 这一轮不看；
2. 没有探针事件，才去消费 attention（`deps.consumeAttention()`，每次 poll 最多取
   `ATTENTION_DRAIN_PER_PROBE` = 8 条，取到第一条**归属通过**的就停）。

探针事件优先，是因为它自带"哪个子会话 + 什么状态 + 判据"；而 attention 只有一句 reason。

### 2.6 约束 8 的落点监测（R3-1）

代批子会话的 goal（`orchestrator_send({ approveGoal: true })`）要求这个 goal 不越出任务边界 —— 那是约束 8。
判据现在是**子会话 sidecar 里 `sessionEditedFiles` 的实际落点**，不再是 goal 正文里出现过哪些路径。

为什么换：正文判定被打过两次补丁仍然失败。第二轮它把 `running/ended`、`slice/window` 当成路径；
补丁之后它又拿"非目标"章节里承诺**不碰**的路径去拒绝同一个 goal；第三轮它拒绝了一个文档任务 ——
退出标准写着「可逐条对照 `lib/orchestrator-probe.ts`」，非目标写着一行代码都不改 ——
于是那一轮**两次代批只能绕过机械比对**。根因是同一个：**正文不是计划**。一份 goal 提到某个文件可以是引用、
对照、或者承诺不碰，语法层面分不出来。

代价与补偿：代批发生在子会话的 Step 0，那时它通常一个文件都还没改，落点集合为空 → 事前那道拦截确实消失了。
所以拦截被挪成**持续监测**：探针每轮比对落点与边界，出现**新的**越界文件就产生一条 `boundary-breach` 事件
并在健康快照里以「⚠ 越界落点」点名（已经报过的不再重复响铃）。
这比原来的文本扫描更强而不是更弱 —— 改写 goal 文本绕不过它，而且批准之后它也不会停止监督。
越界是**范围变更**，仍然是人的决定：项目经理拿 `orchestrator_notify` 通知用户，由用户决定扩边界还是回滚。

---

## 3. `orchestrator_wait` 的返回契约

参数只有两个：`childId`（省略 = 等任意子会话）与 `timeoutMs`。

### 3.1 前置拒绝

- **一个开着的子会话都没有** → 直接失败（`reason: "no-children"`）。没有这条，下面的存活探测会报
  `pane-gone`，等于告诉项目经理"子会话死了"，而它根本没开过。
- **`childId` 没登记过** → 直接失败（`reason: "no-such-child"`）。

### 3.2 判定优先级

`evaluateChildWait(observation)` 自上而下：

| 顺序 | 条件 | `reason` | 是否结束等待 |
| --- | --- | --- | --- |
| 1 | 有探针事件 | `probe` | 是（取第一条，其余在文案里注明"另有 N 条"） |
| 2 | 有 attention 事件，且**不能**证明已办成 | `attention` | 是 |
| 2' | 有 attention 事件，且证明已办成 | `settled-elsewhere` | 否，继续等 |
| 3 | 子会话报告完成（登记表的 `doneAt`） | `child-done` | 是 |
| 4 | 存活读不到（`livenessUnknown`） | `pending` | 否，按"还活着"继续等 |
| 5 | pane 不在了 | `pane-gone` | 是 |
| 6 | 其余 | `pending` | 否 |

第 4 条在第 5 条之前，是 F14 的直接产物：**读不到 ≠ 死了**。

第 3 条在第三轮之前是**死判据**：`doneAt` 从来没有被写过（`markChildDone` 全仓无调用方）。
现在探针判出 `done` 时会写它，所以完成有两条互补的路径能结束等待 —— 探针事件（第 1 条，带判据文案），
以及登记表事实（第 3 条，即使那条事件已经被别的投递者取走）。

### 3.3 销账：`handledAt` 与"已销账 ≠ 已办成"

attention 事件存在一个**全局**文件里（`lib/attention.ts`，`~/.pi/agent/review-gate-attention.json`）。
`consumeAttention(selfSessionId)` 取走"发给我、不是我自己发的、未销账、未过 `ATTENTION_TTL_MS`（10 min）"的最新一条，
**取的同时写上 `handledAt`**，所以同一条事件只会叫醒一个会话一次。
（发布侧另有 `ATTENTION_THROTTLE_MS` = 60 s 的节流：同一 repo + 同一 reason + 同一收件人，且只对**未销账**的事件生效；
状态文件只保留最新 `ATTENTION_KEEP` = 20 条。）

但**销账只说明有监听者看见了它，完全没说明引发它的那个对话框被处理了**（F12）。
所以拿到一条 attention 之后，`doWait` 会回读现场，只有**两个正面证据同时成立**才把它写掉：

- `attentionStillOpen === false`：重新抓屏，解析出来**没有**待答对话框；且
- `originState === "working"`：探针说这个子会话**又在跑了**。

两者齐备才判 `settled-elsewhere`（多半是用户本人当场答掉了），等待**继续**而不是结束在一个幽灵事件上。
`attentionStillOpen` 为 `undefined`（抓屏失败、读不到）一律按"框还开着"处理 —— 没能确认"已办成"，
绝不能拿来让一次求助闭嘴。R-16 正是把这个判断建立在更弱的单一事实上（"我没解析到对话框"），
而那个框自始至终就在屏幕上，只是没被解析出来。

被判为 `settled-elsewhere` 的事件也不会消失在暗处：它们会以"本次消费掉、但判定为已经办成的事件 N 条"
出现在回执里；万一判错了，探针会按 10s→30s→60s 重新叫。

### 3.4 哪些事件被丢弃

`acceptAttention(event, { orchestrationId, childPanes })` 做**双重寻址**校验：

1. `event.toSessionId !== orchestrationId` → 丢弃。事件是发给别的编排的。
2. `event.fromPane` 不在本编排**登记过的**子会话 pane 列表里 → 丢弃。
3. `event.fromPane` 缺失（老版本发布者没盖来源）→ **采信**，拒收它可能让一个真实的求助失声。
   注意这条**不会在回执里留下任何痕迹**：`acceptAttention` 给出的说明只有走拒收分支时才会被记进 `ignored`。
   而且这时 `doWait` 找不到来源子会话，只能回退 —— 指名等待就用那个 `childId`，否则用第一个开着的子会话 ——
   所以随后的"是否已办成"回读可能读的是**别的**子会话的屏幕。回执此时也说不出是谁在找你
   （`childId` 取自事件的 `fromPane`，缺失就没有）：只能自己按健康快照逐个 `orchestrator_read` 确认。

`lib/attention.ts` 自己已经按 `toSessionId` 过滤过一遍，但那不够：队列是全机器共享的文件，
错址或残留的事件照样能被读到，而一个因为**别人的事**从 `wait` 里返回的项目经理，就是 F12 那种空转。

丢弃的事件**永远被报出来，不静默吞掉**：回执尾部会写"本次丢弃了 N 条不属于本编排的 attention 事件"，
并列出前 3 条的原因。

### 3.5 必然返回：独立预算计时器

`pollUntil`（`lib/poll-wait.ts`）把**每一次 await 都和自己的 deadline 计时器赛跑** ——
探测和睡眠都参与这场 race。只在两次探测**之间**检查 deadline 是拦不住一个不返回的探测的：
实测有过 `timeoutMs: 900000` 的等待跑到 1020 秒还不返回，最后只能靠外部 Escape 结束。

预算边界（`lib/orchestrator-wait.ts`，`clampChildWaitTimeout`）：

| 常量 | 值 |
| --- | --- |
| `CHILD_WAIT_DEFAULT_MS` | 300 000 ms（默认） |
| `CHILD_WAIT_MAX_MS` | 900 000 ms（上限） |
| `CHILD_WAIT_MIN_MS` | 1 000 ms（下限） |

上限从 30 分钟降到 900 秒不是把功能削小，而是**决定项目经理多久被强制拉回一个可被引导的决策点**。

于是回执恰好三条路径，每条都有明确下一步：

1. **被中断**（`aborted`）：告诉你已等多久，子会话还在跑，什么都没被取消。
2. **预算用完**（`done: false`）：带上当前判据的一句话。若预算耗尽时**一次探测都没返回过**
   （`stalledInProbe`，`observation` 为空），额外提示 tmux 很可能卡住了、先自己看一眼 pane。
   文案明确要求：有确定性的活先做掉，没有就再调一次 `orchestrator_wait`，**别结束 turn 把盯梢丢回给用户**。
3. **命中判据**（`done: true`）：说明是**哪个**子会话、判据是什么；是 attention 时附事件 id 与销账时间；
   `attention` / `probe` 两种判据还会追加下一步 —— 事件里没有问题正文，去 `orchestrator_read({ childId })` 读屏，
   再用 `orchestrator_key` 答。**注意这两种判据给的 `childId` 不是同一种标识**：`probe` 给的是登记句柄
   （`ChildSession.id`，可以直接传给 `orchestrator_read`），而 `attention` 给的是事件的来源 **pane id**
   （`fromPane`）—— 先在同一条回执的健康快照里按 `paneId` 找到对应的 `childId`，再去读它。

`details` 里稳定返回：`reason`、`waitedMs`、`ignored`（丢弃条数）、`settled`（判为已办成的条数）、
`health`、`done`，以及命中时的 `childId`。

### 3.6 健康快照：每一条回执都带

**无论等待结果如何，回执末尾一定带全部子会话的健康快照** —— 即使等待是指名某一个子会话的。
"到底是哪一个在找我"曾经要靠逐个 `orchestrator_read` 去猜（R-4），而指名等待恰恰是最容易对兄弟子会话失明的时刻。

`ChildHealth` 的字段：

| 字段 | 含义 |
| --- | --- |
| `childId` / `taskId` / `paneId` | 是谁、在做 plan 里的哪条任务、在哪个 pane |
| `state` | 五态之一 |
| `reason` | 一句话说明**判据**，永远是观测事实，不是猜测 |
| `lastActivityAt` | 屏幕最后一次发生变化的 ISO 时间 |
| `secondsSinceActivity` | 距那次变化多少秒（监督者真正会读的数字） |
| `dialogTitle` | 正在等的那个框的标题（有才带）—— 取问题主干，见下 |
| `done` | 它已经报告过 `declare_done`（判成 `done` 或登记表已记 `doneAt`） |
| `outsideBoundaries` | 它改到的、任务边界之外的文件（有才带，见 §2.6） |

渲染由 `formatChildHealth(list)` 负责，一个子会话一行加一行"依据："；没有开着的子会话时输出"（当前没有开着的子会话）"。
同一份快照也出现在 `orchestrator_status` 与 `orchestrator_read` 的回执里（`orchestrator_read` 会把它标为
"结构化真值，优先于上面的屏幕启发式"）—— 三个工具给的是同一个判定，不需要读者自己去调和两种说法。

**`dialogTitle` 取的是问题主干，不是正文最后一行（R3-4）。** 以前的规则是"选项上方最近的一行非空文本"，
于是任何多行问题都被显示成它的结尾碎片 —— 第三轮的快照里出现过「论表格，不解释判据成因）。我推荐 A：…」
和「C) 单模块 + 把三个私有 helper 再拆到第三个文件里凑数。」。现在解析器会向上收集这个文本块，
遇到采访自己打印的 `问题 N / M` 表头就以它下一行为标题；**没有**这个表头时仍退回旧行为（最近一行）——
终端不标注问题从哪儿开始，硬往上取第一行会把上面的历史输出当成标题，那是把"难看的标题"换成"错的标题"。

---

## 4. 给项目经理：怎么读这份快照

### 4.1 阅读顺序

1. 先看 `state`，再看 `reason` —— `reason` 说的是"凭什么这么判"，它决定了你的下一步是答框还是去问人。
2. 再看 `secondsSinceActivity`。它**不是**健康度指标：`working` + 静止 600s 完全可能是正常的
   （在跑 judge 或长测试）。它只在配合 `state` 时有意义。
3. 有 `dialogTitle` 就说明有框在等你，标题就是问题的主题。
4. `state: done` 是**正常终态**：子会话报完 `declare_done` 不会退出，它就停在那儿等你验收。
   它会响两次铃（间隔 60s）然后安静下来，所以别把"很久没再提醒"读成"没做完"。

### 4.2 状态 → 动作

| 快照 | 含义 | 下一步 |
| --- | --- | --- |
| `waiting-input`，带 `dialogTitle` | 有选项框在等答案 | `orchestrator_read({ childId })` 读选项，再 `orchestrator_key({ childId, index \| match })` |
| `waiting-input`，判据是 sidecar 的 `pausedQuestion` | 它在 `ask_user` 上暂停 | 同上先读；框还开着时**不要**投文本（会替它答一次） |
| `done` | 它跑完了全套并被门禁接受（判据是它 sidecar 里的完成记录） | 验收：派下一条任务，或 `orchestrator_close`；worktree lane 顺手确认成果已进基准 |
| `idle`，且 `done` 为空 | 它停了但没报完成 | 读屏看它停在哪，用 `orchestrator_send` 问；确认没救就 `orchestrator_close` 后重派 |
| 任意状态 + `⚠ 越界落点` | 它改了任务边界之外的文件 | 这是范围变更：`orchestrator_notify` 让用户拍板（扩边界 or 回滚），别自己批 |
| `dead` | pane 没了（异常退出或被关） | 它的任务多半没做完：确认状态，必要时重派 |
| `working`，判据是"沿用上一次的判定" | tmux 读不到，存活未知 | 不是坏消息，但连续多轮如此就自己看一眼 pane |

### 4.3 什么叫"卡住了"

按危险程度排序，都是**组合**信号，单看一个数字都会误判：

- **同一个 `waiting-input` 被重复提醒过多次**（回执里同一子会话反复出现）：说明你答过的东西没生效，
  或者你答的是上一个框。用 `orchestrator_read` 确认**当前**框的标题与高亮项再答。
- **`idle` 且 `done` 为空、`secondsSinceActivity` 持续增长**：这是最典型的卡死 —— 它既没有在跑，也没有在等人，
  也没报完成。判据文案里会明确写"而且它并没有报告 declare_done"。
- **`orchestrator_wait` 报了 `stalledInProbe`**：预算内一次探测都没返回，是 tmux 层面的问题，不是子会话的问题。
- **回执里一直有"丢弃了 N 条不属于本编排的 attention 事件"**：你在被别人的事叫醒。这些事件不会再叫你，
  但持续出现说明有别的会话把事件发到了这个地址。
- **`working` 但屏幕静止很久、且 sidecar 没有 `judgeRunning`**：还没到 45s 阈值时是正常的；
  一直停在这个组合上，等下一轮探针把它变成 `idle` 即可 —— 不要自己抢在门禁前面下结论。

### 4.4 不要做的事

- **不要自己跑 `tmux capture-pane` 轮询。** 探针已经在做同一件事且判定更严（结构化真值优先），
  手工轮询只会得出第二套互相打架的结论 —— 那正是被复盘判为"能力降级"的做法。
- **不要用结束 turn 代替等待。** 子会话不会因为你结束了 turn 就有人管；`orchestrator_wait` 必然返回，
  拿它当循环的下一步。
- **不要把"事件已销账"当成"事情已办完"。** 门禁自己都不这么认，它要两个正面证据。
- **不要自己 `git merge` 帮子会话把成果送回基准。** 那是门禁欠的活，见 §5；项目经理不动代码仓库。

---

## 5. 并行 lane 的成果怎么回到基准分支（R3-6 / R3-7）

第三轮两条并行 lane 的成果**都是人手工 `git merge` 送回去的**，两处根因都在门禁这边，都已经修掉：

- **基准分支推导退化（R3-6）。** `setup_workspace` 默认把"当前分支"当基准，而 worktree lane 站在门禁自己刚建的
  `orch/<task>-<stamp>` 上，于是它 `declare_done` 时把成果合进了那个临时分支。现在 `orchestrator_spawn`
  会把编排的基准分支（项目经理自己所在的分支，**建 worktree 之前**读的）以 `RG_ORCH_BASE_BRANCH` 注入子会话，
  `setup_workspace` 缺省用它 —— 子会话显式传 `base` 仍然优先，**用户照样在同一个框里确认**。
- **合并路径必然失败（R3-7）。** 合并跑的是 `git checkout <base>`，而基准分支正被主 worktree 占着，
  git 直接拒绝（一个分支只能被一个 worktree 检出）。现在 `declare_done` 先判**合并在哪儿执行**
  （`lib/worktree-merge.ts`，纯函数）：没人占着就照旧在本工作区切过去合；被别的 worktree 占着，
  就**在那个工作区里就地 merge，不切分支、不动 HEAD**。安全规则是用户定的：只有那个工作区**干净且正停在基准分支上**
  才动它，否则什么都不做，明说原因（脏文件清单 / 它停在哪个分支），把选择权交回人 —— 在别人有未提交改动的
  工作区里跑 merge 可能弄丢它们，没有哪张回执值这个价。

对项目经理的意思是：lane 跑完 `declare_done` 之后，成果**应该**已经在基准分支上了。
如果 `declare_done` 报的是"合并没做"（脏工作区 / 停错分支 / 走了 `waiveMerge`），那是需要人处理的事 ——
通知用户，别自己动手补。
