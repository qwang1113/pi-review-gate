> 2026-09-04 更新：judge 运行形态已从非交互进程迁为独立 pane（层级化调用：
> 项目经理 → 子会话 → review，跨级调用由门禁拒绝），完成信号从进程退出改为
> 通道 report。本文其余部分的进程-era 描述（`pi -p`、exit-code、stdout 扫描）
> 已失效，以 `docs/hierarchical-session-design.md` 与实现为准；本文件的 commit
> 审核单元、STALE/tree 绑定等判定语义不变。
>
> 同日第二处更新：**verdict fence 也退役了**。judge 调 `judge_conclude` 交卷，
> 结构化字段（verdict / findings / cwd / docSync）**直接写进 channel report**，
> opener 当数据读——没有 fence 合成，也没有 fence 解析。原本只存在于解析器里的
> reviewer 裁决规则搬到了 `lib/review-adjudicate.ts`（READY 携带未解决 P0/P1 →
> BLOCKED、findings 计数、跨轮 fingerprint），语义逐条不变。下文凡说「fence」
> 的地方一律读作「`judge_conclude` 交卷」。

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

2026-09-04 起，进程退役：judge 是用户 window 里与主会话同窗的独立 pane
中的**交互 pi 进程**（门禁以 judge 模式加载，只给 reporting-shell 工具集）。
`--session-id` 按 role+repo 确定性派生；judge 调 `judge_conclude` 交卷并停下
（不退出进程，pane 留给下一轮复用），交卷把结构化结论直接写进 channel report，
opener 凭它记录结论；
同一 id 重开 pane 即续接同一段上下文。隔离仍来自 **commit 本身**：每次送审前主会话把改动
提交为 checkpoint commit，审核者审 `baseline..HEAD`（不可变历史）。

## 运行形态：pane 承载，轮是任务

- judge = 用户 window 里的独立 pane 中的**交互 pi 进程**
  （`pi --session-id <id> @<task文件>`，门禁以 judge 模式加载：reporting-shell
  工具集 + heartbeat 上报 + `judge_conclude` 落 report）。stdout/stderr 由扩展 tee
  到本轮 `stdout.log` / `stderr.log`。
- **session id 是 resume 键**：`rg-<role>-<repoHash>`（确定性派生）。
  同 role + 同 repo 再 spawn 同一 id ⇒ 延续同一段对话（跨轮、跨主会话
  重启、跨天都成立——pi 把上下文存成 `.jsonl`，不依赖进程存活）。
- **任务文本**走 `@file` argv 引用（写入 `sessionDir/task-<ts>-<rand>.md`）：
  无 argv 长度问题，也无 TUI 撕多行的问题（非交互模式本来就没有 TUI）。
- **值直接进 argv**（spawn 数组），没有 shell，没有插值面——配置提供的
  model spec / 路径不可能变成 shell 语法。
- 角色正文从三层解析：repo `agents/` → 包内置 `agents/` →
  `~/.pi/agent/agents/`。模型：`auto:false` 取 `slots` 整条链；`auto:true`
  取角色 frontmatter 的 `model:` + `fallbackModels:`。链不是装饰：派发取
  「第一个不在冷却期内的槽」（`lib/model-health.ts`），跑起来之后模型
  provider 挂了就由 pane 自己往链上走（`lib/judge-model-rotation.ts`）——
  详见下方「模型失败与 fallback」。

## 模型失败与 fallback（2026-09-10）

背景（rebate 实测）：`agents.<role>.slots` 写了一条链，派发却只取 `slots[0]`；
`fallbackModels:` 渲染进了 agent frontmatter，却**没有任何运行时消费者**
（pi 本体与 pi-subagents 都不认这个 key，judge pane 只收 `--system-prompt`）。
一个 provider 连续 503 之后，轮次能挂好几个小时，而 opener 卡在工具调用里
（无回执、无超时），只能由人去 pane 里手动换模型。现在链的两半都真了：

- **派发侧**（`lib/model-health.ts`）：取**第一个不在冷却期内的槽**；
  冷却记录以 `provider/id` 为键，写进 `.pi/judge-hierarchy.json` 的 `modelHealth`，
  10 分钟后自愈。全在冷却时仍按链头派发（fail-open）并在会话里警告。
- **pane 侧**（`lib/judge-model-rotation.ts`）：本轮以模型错误终结（pi 自己
  的重试已耗尽）时，pane 自己切到链上的下一个槽（模型 + 该槽 thinking），
  自注入一句「继续本轮」——transcript、任务与已查到的证据全部保留——并把
  `ModelEvent` 写进通道。链走完时标 `exhausted`：`judge_wait` 以
  `model-exhausted` **结束本轮**（没有结论、写清原因），而不是无限等。
- **配置即时生效**：派发前重读 `.pi/review-gate.json` 与 `~/.pi/review-gate.json`
  的 agents 段，内容变了就重渲染 `.pi/agents/*.md`——磁盘上的链与实际启动的
  模型不再互相矛盾（重开会话也不再是必须的）。

## 生命周期与 liveness

- **完成 = `judge_conclude` 落 channel report**。pane 是承载体、轮是任务：verdict 为
  BLOCKED（还有下一轮）时 pane 保留复用；终结（READY、opener 放弃、换 review 对象）
  时门禁回收 pane，transcript 与裁决记录保留。
- **存活由 pane 名单判定**：opener 的运行期检查一次拉取本 window 的 pane 列表
  （`listJudgePanes`），记录在但名单里没有 ⇒ pane 死亡；名单读不出 ⇒ 按活着处理
  （缺信息永不结束等待，fail-closed）。心跳（channel state 记录）是第二信号。
- **一轮一 pane**：同 judge 仍有活 pane ⇒ 新一轮走复用/排队语义，由门禁在派发时
  决定（`dispatchJudgeRound`），opener 不手选。
- **上下文复用靠 session，不靠 pane**：同一 role + 同一 repo + 同一 lane 同一 session id，重开
  pane 即追加进同一个 jsonl，上下文原样延续。「是否续接」由该 role 的 sessionDir
  里是否已有 transcript 决定。
- **复用是有界的（`lib/judge-rotation.ts`，2026-09-05）**：复用单元是一个**已批准的
  review 对象**（编排会话取 plan hash、其余取 goal hash，都没批准时是稳定占位对象，
  占位对象同样受闸）；释放点是对象 id 变了（惰性判定，下次派发时比对）；上限是 judge
  自报上下文 60% 或同对象派满 8 轮，任一命中门禁自己开新 transcript（lane 代次 +1）
  并只带压缩交接。上下文读数缺失时不因它轮转（fail-open），轮次在**派发时**计数所以
  放弃的轮也算。旧 lane 的 pane 当场回收、目录原地保留走既有 TTL；agent 侧无感、无开关。
- **重启接管**：opener 注册表落盘（`<repo>/.pi/judge-hierarchy.json`，按 repo 分片），
  新会话启动与每次触达时懒合并；死 pane 的异主条目由触达者过户，活 pane 保持拒绝。
  绝不为同一 session id 再开第二个 pi。

## 通信

- **完成信号**：`judge_conclude` 交卷。pane 调完就停下（不退出进程，留给下一轮
  复用）；交卷把结构化结论写进 channel report，门禁在每次 settle 时看到新 report
  即记录结论、用标准报告唤醒 opener——父会话不轮询、不直读 transcript。
- **提问**：judge 调 `ask_user`（人与 opener 经通道竞态，先答先生效）；等答案时停下，
  不自行假定、不退出 pane。问答闭环由门禁中转，父会话收到的永远是整理后的报告，
  不是 judge 原文。
- **流式 findings**：追加到 `.pi/review-stream/<round>.jsonl`
  （仅证据，禁止 verdict 形状的行）。
- **子会话的问题走点对点通道**（2026-08-30）：`propose_loop_goal` 的批准框、
  `propose_restatement` 的反述确认框（2026-09-06）与
  `ask_user` 的每一问都写进**本子会话专属的通道文件**
  （`~/.pi/agent/rg-channels/<orch-id>/<child-id>.jsonl`），带完整选项与正文。
  项目经理与坐在 pane 前的人**任意一方先答即生效**，另一边的框自动撤下。
  上一版的全局 attention 队列（`~/.pi/agent/review-gate-attention.json`）已删除
  —— 它靠记录上的一个收件人字段区分归属，等待方会消费到别人的事件；现在隔离是
  **物理的**（一个子会话一个文件），记录里根本没有收件人字段可填错。**这条路径
  不发任何桌面通知**：给人发通知是编排层独有的另一条通道（`orchestrator_notify`，
  OSC 777/9/99，只有项目经理能发，且带节流）。

- **主会话存活不变量**（round-18，用户硬约束）：门禁未通过前主会话**不得**
  停止自动循环。`agent_settled` 先跑 `settleFinishedRounds()`：有新 channel report 的
  子会话**立即**以标准报告唤醒（结论、证据位置、记录情况、待答问题）并记入链；
  再跑 `classifyChildren()`（lib/child-watch.ts）托管其余：pane 死亡或静默超时的
  子会话**立即结束等待**（注入 `REVIEW_GATE_CHILD_ENDED`，按有无 report 分别处理）；
  仍在飞的子会话注入 `REVIEW_GATE_CHILD_HOST_WAIT`（等待纪律见下）。
  **等待纪律**（2026-09-05 起，唯一出处 `lib/agent-directives.ts` 的
  `buildWaitDiscipline`）：①有确定性工作先做掉（提示、不强求：送完 reviewer 往往
  没事可做，可以看看下一轮要什么或先备收尾报告）；②确实没活了才调
  `judge_wait`——不是手写 sleep 轮询，也不是结束 turn（存活不变量仍然成立）；
  ③`judge_wait` 消息驱动：新 finding / judge 提问 / 本轮结论 / pane 消失任一到达即返回。

  仅三类情形允许停止：用户显式中止（ESC）、`ask_user` 等待用户回答、
  所有门禁与 goal 均完成。
- **一轮结束的三条独立判据**：(a) **本轮自己的** channel report 落盘
  （`settleFinishedRounds` 以标准报告唤醒并记入链）—— 对 code review 而言「本轮自己的」
  是有判据的（2026-09-05）：report 的 `round` 必须等于本轮 dispatch 登记的 `roundSeq`，
  且在本仓库已有 checkpoint 时 `report.at` 必须严格晚于 `state.checkpoint.at`；不满足
  的 report **不结束本轮**，只在唤醒文本里报成「未采纳的 report」（判据出处
  `selectRoundReport` / `roundBindingFor`，`lib/audit-round.ts`，记录侧与探测侧共用）；
  (b) **pane 死亡**（本 window 名单里没有记录的 pane id——名单读不
  出按活着处理，缺信息永不结束等待）；(c) 静默超过 `STALL_MOTION_MAX_AGE_SEC`
  （lib/loop-stall.ts，600 秒），按 `lastActivityAt` 计时——取自子会话的 channel 写入，
  只有一次都没写过时才回退到 `spawnedAt`。任一命中主会话自行恢复推进——子会话的
  完成信号是**加速器，不是前提**。
- **结论取数**：读该 report 的结构化字段——`verdict` / `findings[]` / `cwd` /
  `docSync` 就是 judge 交卷时给的原值，opener 直接消费；只有 adviser 的 report
  带 `summary`（它的产出就是正文）。transcript 是长记忆，不是信号。
- **排查**：`tail -f <runDir>/stdout.log`（实时）、grep sessionDir 的
  jsonl（结构化输入输出）、`pi --export <jsonl> <out.html>`（完整回顾）。
- **等待期的可见性（2026-08-29 起，默认开启）**：耗时工具通过 `execute` 的第
  4 个参数 `onUpdate` 发**进度快照**（`lib/progress-stream.ts`，节流 2s）：
  门禁内部等待（每次探测重发 findings 计数与状态）、`judge_submit`
  的送审链（precommit → checkpoint → prepare → spawn，逐步报）、
  `run_precommit`（runner 日志作为步骤尾部）、`declare_done`（门禁复检 →
  合并）、`request_copilot_review` / `check_copilot_review`（每次网络调用一
  步）。进度只进 partialResult，**不进** agent 拿到的 tool result——两条通
  道回答不同的问题。`tool_call` 钩子没有 `onUpdate`，所以 6 处 LLM 判定
  （L5 语义 / L6 标签 / ship 分类 / AI 署名）改用状态栏：超过 ~3s 才提示一
  次，结束即清除。
- **标准报告的内容**：新 report 落盘 ⇒ 标准报告（结论、findings 数、流证据位置、
  记录情况、待答问题）经 followUp 送达并记入链；无 report 的结束（pane 死亡、静默
  超限）如实报未记录、不认结论。它与上面的流式快照互不替代：快照给人看，报告给
  agent 干活。

## 编排层：另一种子会话（2026-08-29 引入 · 2026-08-30 通道重构）

judge 之外还有第二类子会话，两者的形态**恰好相反**，不要混在一起理解：

| | judge 子会话 | 编排子会话 |
|---|---|---|
| 形态 | 交互式 pi，占用户 window 里与主会话同窗的一个 pane | 交互式 pi，占用户 window 里的一个 pane |
| 谁开的 | `judge_submit`（意图入口；生命周期归门禁） | `orchestrator_spawn`（唯一入口） |
| 「有事了」 | 新 channel report 落盘（门禁以标准报告唤醒） | **`orchestrator_wait` 的回执**（它自己去读每条通道，把结果推给你） |
| 状态从哪来 | pane 存活（window 名单）+ channel 心跳/state/report 记录 | 八态结构化真值（权威清单：`lib/orchestrator-child-state.ts` 的 `CHILD_STATES`）：`working` / `waiting-input` / **`waiting-judge`**（在等门禁自己派的 reviewer/precommit，附已等秒数，不叫醒项目经理）/ `idle` / `done` / `mode-changed`（它改了门禁模式）由子会话自报（心跳是扩展自己的定时器，与 agent 是否活跃无关），`dead`（pane 消失）与 `stalled`（心跳超时 ⇒ 扩展真的不在了）由编排侧从外面判 |
| 正常终态 | verdict 落 channel report（pane 按终结规则回收复用） | `declare_done` 之后**仍然活着** |
| 异常终态 | pane 消失但结论未落盘（本轮不算结束，`judge_recover` 同 id 续接） | pane 消失（`dead`）或心跳停摆（`stalled`），用 `orchestrator_recover` 复活 |
| 等待 | `judge_wait`（消息驱动，确实没活可做时才调；没在等时新 report 落盘仍以标准报告唤醒） | `orchestrator_wait` |


关键推论：**编排子会话干完活不会退出**，所以「等进程结束」在这里会永远挂住。
两个等待共用 `lib/poll-wait.ts` 这一套骨架（probe / 发快照 / 判据或预算命中
即返回），只是把判据换掉 —— 这正是上一轮把骨架做成判据可注入的原因。

**回执就是话筒**（2026-08-30 通道重构）：`orchestrator_wait` 是项目经理**唯一的信息
入口**，它的回执每次都是同样的五块：全部子会话的健康快照、待答请求（问题正文与
**全部选项原文**）、死亡/僵死的子会话连同幸存资产与可直接执行的恢复动作、它自己的
上下文用量与接力时机、以及还差什么才能 `declare_done`。这些都是子会话自己写进通道
的结构化数据，不是从屏幕上解析出来的，所以醒来之后的标准动作直接就是
`orchestrator_answer({childId, answer})`，没有「先去读一眼」这一步；阻塞与否只是一个
参数（`timeoutMs: 0` 即快照），两条路径的回执一字不差。

**被替换掉的是什么**：上一版是「attention 只是门铃，不是话筒」—— 全局 attention 队列
里的事件只带一句 reason，醒来后必须 `orchestrator_read` 抓屏解析、再 `orchestrator_key`
模拟方向键作答；旁边还并排站着一个 `orchestrator_status`，与 wait 回答同一个问题，
agent 每轮都要先挑一个。这三个工具连同它们依赖的抓屏与按键模块已整体删除，取而代之
的是「凡是项目经理需要知道的，都从它必然会调的那次 wait 里推给它」—— 让 agent
「记得去查」本身就是设计缺陷。监督层的完整描述见 `docs/orchestrator-supervision.md`。

**投递不走键盘**：`orchestrator_spawn` 把任务正文写成仓库外的任务文件、以
`pi --session-id <id> @<taskfile>` argv 启动子会话（与 `lib/judge-process.ts`
同一机制），因此不存在截断、也不需要补 Enter；后续消息走
`orchestrator_instruct`，写进通道由子会话自己的门禁用 `pi.sendUserMessage`
注入。两者在回执成功前都必须观察到「对方真的收到」的证据 —— spawn 看通道里是否
有它自己的上报，instruct 看它的 `instruct-ack` —— 观察不到就回执失败并把任务标回
`pending`（保留 pane，不误杀）。

**寻址**：judge 子会话寻址派它的那个 session（`RG_PARENT_SESSION`）是对的
—— 它活不过这一轮。编排子会话会**活过**开它的会话（接力换人），所以它寻址的
是稳定的 orchestration id（`RG_ORCHESTRATION_ID`）。`supervisionTargetId()`
是唯一的解析规则：orchestration id 优先，回退 parent session，两者都无则
静默（独立会话叫不醒任何人）。接力时新会话继承同一个 id，因此**子会话完全
无感、无需重启**。

**接力的不断档保证**：老会话写交接文档 + plan 落盘 →
`orchestrator_handoff({handoffPath})` 把**这份编排**交给一个新会话（它继承同一个
orchestration id、交接文档路径，以及**老会话 transcript 路径** —— 交接文档是自述，
原始记录才是查问题时要的）→ 老会话进入 idle → **由新会话**调
`orchestrator_close({predecessorPane})` 关掉老会话。只有接任者能关前任（前任自己没有
那个环境变量），这天然证明新会话已经起来并接手成功。接力的**时机**也不靠项目经理
自觉：wait 回执第四块按上下文用量直接给判断（≥80% 且手上没有待答请求就是好时机，
≥90% 则是首要动作）。工具名从上一版的 `orchestrator_relay` 改成 `orchestrator_handoff`，
因为它交出去的是这份编排本身，不是一个 pane。

接手现场的另一半是 `orchestrator_attach({orchestrationId})`：后继者带着同一个 id 启动
之后，一次拿回 plan 与任务状态、每个子会话的状态与资产、通道里还没人答的请求，以及
**孤儿任务**（plan 说 running、却没有存活 pane 在做）—— 那是崩溃或重启唯一会留下的
不一致，也是项目经理唯一会永远等下去的东西，所以由门禁主动报出来而不是等它自己发现。
子会话对这一切完全无感：通道是文件路径、不属于任何进程，换人只是换了个打开它们的人。

**tmux 只剩显示器的活**：`lib/orchestrator-tmux.ts` 里现在只有几个构造器 ——
`list-panes`（判 pane 存活，`dead` 的唯一来源；另有带几何的一支给三列规则读窗口）、
`split-window`（开 pane）、`kill-pane`（关 pane）、`select-layout -E`（把目标 pane 所在的那一层
空间等分 —— 三列布局靠它，2026-09-08）。`send-keys` 与 `capture-pane` 的构造器已整体删除，理由是它们
各自代表一类必然出错的做法：键盘投递会被截断、会漏 Enter、消息里的换行会被开着的
对话框当成「提交当前高亮项」（等于替子会话答了一个它没打算选的选项）；而屏幕是给人
看的渲染结果、不是 API —— 它会折行、会滚动、会把状态栏渲染得像菜单，历史输出还一直
留在那里。`test/orchestrator-tmux.test.ts` 直接对源码断言这两个词不再出现 —— 一个
「留着没人用」的构造器正是被删掉的路径回来的方式。这些命令一律构造成 argv 直接
spawn（无 shell）；门禁自己的执行路径也过同一份禁止清单，所以「门禁豁免于 bash
拦截」不等于「门禁可以做被禁止的事」。

## 审核单元

送审是**一次调用**：`judge_submit({role:"reviewer", task:<本轮改动说明>})`。
门禁在这一次调用里依次跑完下面四步，任一步失败就带原因打回（不留半提交
状态）。这四步的实现**还在**，但 2026-08-30 起**不再注册成工具**（哲学三）：
门禁在内部调用它们，agent 看不到这些名字，因此没有第二条路可选。

- `run_precommit`（full lane）：不过就打回。
- `review_checkpoint`：`git add -A && git commit`（英文 message 校验，
  commit 标题由门禁打上 checkpoint 标记）→ 记录 commit sha。只绕过 READY，
  不绕过 precommit；普通 `git commit` 在 READY 前仍被拦。2026-09-07 起
  直接落在**当前分支**（不再有工作分支）；在 main/master/dev/develop 上
  checkpoint 直接拒绝（2026-09-16 起不再弹确认框，与 ship 拒绝一致）。
- `prepare_review`：计算 `baseline..HEAD`（自上次审核基线以来的 commit），
  生成任务文本与 findings 流路径，注册审核目标。
- dispatch：spawn 或续接该 role 的 session。

verdict **不在返回值里**：judge 把本轮结论写进 channel report（不再是进程退出）后，门禁自己读它并跑
verdict 记录（`recordReviewVerdict`，普通函数，不是工具）——审核目标仍是 HEAD（审核期间新增 checkpoint ⇒ STALE ⇒
BLOCKED），READY 绑定审核 commit 的 **tree**（内容绑定，squash 重写历史
不改变内容时绑定存活；`reset --soft` 实测 tree oid 不变）。主会话被唤醒时
拿到的已经是记录后的结论。
- ship 授权（unmetRequirements）：READY 与 precommit PASS 均绑定
  commit tree；push/PR 时验证 HEAD commit tree 与绑定 tree 一致且自
  基线以来无未审核 commit。
- **只改 message 不改 tree 的改写**（2026-08-29，`lib/git-rewrite.ts`）：
  `git commit --amend` / `git rebase -i` reword 产出的 commit 与被替换的
  commit **tree 相同**（且 index 无暂存改动——`--amend` 发布的是 index），
  不带来任何新内容，所以**内容类**门禁对它无话可说：L1 与 pre-commit 钩子
  都跳过内容判定（钩子只在 commit 路径跳过；push 会发布整段历史，
  `REVIEW_GATE_REQUIRE_FULL=1` 时不豁免）。**只豁免内容类**——提交落在哪条
  分支（分支规则）、sidecar 缺失的 fail-closed、goal 未批准照旧执行，因为
  它们问的都不是内容。多仓命令要求每个涉及的 repo 都成立，仓库解析不确定
  时不豁免。改写后的 message 仍要过 L5：命令行传的由 L1 判，编辑器里写的
  （含每一次 reword）由 commit-msg 钩子判。rebase 中间态的 detached HEAD
  按 `.git/rebase-merge/head-name` 还原成原分支——分支规则因此**仍然适用**
  且不再因「无法确定当前分支」误拦，这正是从前「修非英文 message 的两条路
  都被门禁堵死、只剩用户跑 /gate-bypass」的死结所在。
