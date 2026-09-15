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
  自报上下文 70%（= 统一交接阈值 `HANDOFF_PERCENT`）或同对象派满 8 轮，任一命中门禁自己开新 transcript（lane 代次 +1）
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

- **协商被用户插话时的口径**（2026-09-14，用户要求）：需求反述、协商 goal、协商 plan
  这三个环节里，用户常见的动作不是点选项，而是**在框外说别的事**（语义打断 —— 不是
  按 ESC）。这时 agent 必须先把他说的处理掉，再用 `ask_user` 问一句「还有别的要补充
  或要问的吗？没有了我就继续」，得到「没有了」才继续协商。规则写进
  `lib/agent-directives.ts` 的 `REQUIREMENT_PROTOCOL` 与 `lib/orchestrator-directives.ts`
  的项目经理指令，是**提示词层**的约定（用户明确「不用做得特别死」）—— 门禁不做硬拦，
  也不为此新增状态。三处工具在「用户没有作答」（关框 / 被消息打断）时返回的文案同样
  指向这一步，**不再**把它读成「用户否决」。
- **协商正文只走对话区，且不截断**（2026-09-14，用户要求）：三份全文（反述 / goal /
  plan）由 `showToUser` 完整打印，**没有任何字符数上限** —— 对话区可滚动，实测一次
  追加 400 行触发 0 次清屏（`test/tui-flicker.test.ts` 用真实 `TuiMainScreen` 验证）。
  被行数预算约束的只有**对话框**，而它只承载决策文案（正文永不进框）。对话框的行预算
  按**真实终端行数**算（`lib/dialog-budget.ts` 的 `dialogTextMaxLines`，来源与 pi 一致：
  `process.stdout.rows` → `$LINES` → 24），**折行宽度同样按真实列数**
  （`process.stdout.columns` → `$COLUMNS` → 80 —— 行数决定闪不闪，列数决定一个逻辑行折
  成几行，对宽窗口按 80 列假设排版就会裁掉本来放得下的正文），标题也在同一份预算内
  裁剪 —— 小窗口不再因「预算按 24 行写死」而整屏闪烁。终端级的替代路径是 pi 的 `--tui-mode fullscreen`
  （`TuiAltScreen`：pi 自己拥有屏幕与滚动）；Claude Code 的 `CLAUDE_CODE_NO_FLICKER`
  只是它渲染切换的遗留 env，对应的是它的 fullscreen 渲染器。
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
  合并）、`copilot_review`（每次网络调用一
  步；等待本身不在这里——它归后台监视器）。进度只进 partialResult，**不进** agent 拿到的 tool result——两条通
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

**接力的不断档保证**（2026-09-14 起，每一类会话共用同一条链路）：门禁自己监测上下文
用量，达到窗口的 **70%**（唯一阈值，本机 1M 窗口 ⇒ 700k tokens）后每轮注入提醒，并把
交接文档的**机械骨架**写好（契约 / 未完成工作 / transcript 指针 + 一段留给 agent 的
「自述」）。agent 只做两件事：补写那一段，调 `session_handoff()`。

调用之后全部是门禁的步骤：开新 pane（继承同一个 orchestration id、交接文档路径、
**老会话 transcript 路径**、**老会话的 session id** —— 最后一项是接手 worktree 占用的
依据）→ **新会话的第一条消息就指向交接文档** → 老会话**退休** → 新会话「**读过交接文档 且 完成过至少一次成功工具调用**」即判定接手（普通路径下 `read` 文档那一次就同时满足两条），**由门禁自动关掉老会话 pane**。

上一版（`orchestrator_handoff`，已退役）的失败就在这里：它开的是一个**裸 `pi`（没有第一条消息）**，
新会话根本不知道有文档要读、也不知道要 attach，两个会话互相干等；而关老会话这件事
被交给了新会话「记得去调 `orchestrator_close({predecessorPane})`」—— 一个没人提醒的
承诺。现在关它的是门禁（`lib/session-handoff.ts` 定义什么叫接手），继任者的 brief 里
明写「不用你做任何事」。

接力的**时机**也不靠会话自觉：`orchestrator_wait` 回执第四块、以及每一轮的系统提示
都直接给判断（≥70% 就是「接力是现在的动作」）。

**退休分两个阶段，不是一个标记**（2026-09-10 实测修复 + 同轮 review 的两条 P2）：

- **阶段一（开新 pane 之前）——释放 worktree 占用**（`.pi/session-presence.json`）。
  新会话在**同一个 worktree** 里启门禁，占用不释放它就会被自己前任的心跳拒绝
  （实测报错「这个 worktree 已被另一个会话占用，本会话不启动门禁」，点名刚交棒的
  会话，新会话的 pi 随即退出）。必须在新 pane 打开**之前**——晚一步就是和新会话的
  启动赛跑。
- **阶段二（新会话的 relay 记录落盘之后）——静默**：设退休标记、停两个推进定时器
  （supervision / revival），从此**四条唤醒路径**都不再叫它：`orchestratorSettled` 的
  `agent_settled` 路径、supervision 定时器、revival、以及 `settleFinishedRounds`
  （一份已完成报告唤醒的是 opener，而开了自己 judge 的退休项目经理就是 opener）。
  并且 `persist()` 对它直接返回（**不再写共享 sidecar**——两个会话写一份 sidecar 正是
  占用判定要防的事，而继任者是被**故意**放进来的，所以停下来的是前任）。

**阶段的界线不是风格，是两条实测缺陷**：（a）`saveRuntime` 写的 relay 记录要走
`persist()`，而 `persist()` 对已退休会话拒绝写入——先静默会让继任者自己的登记行
只存在于内存里，重启即丢；（b）回滚一个尚未开始的静默没有任何东西要撤——单阶段
把“停定时器”和“释放占用”绑在一起，导致交棒失败时定时器已停而回滚无法重新 arm
（回滚需要 ctx），前任就变成了“静默且无人接替”。两阶段之后，**回滚只有一件事要
做**：把占用拿回来。

接力若因前置条件不满足或开 pane 失败而中止，阶段一被回滚（前任重新占用），阶段二
根本未执行——没交出去的编排不能留下一个已退休的前任。

新会话一侧另有一道保险：它带着**前任的 session id** 启动，worktree 占用判定认这条
继任关系（`lib/session-exclusivity.ts` 的 `successorOf`，判定排在**心跳新鲜度之前**），
所以即使前任没来得及释放，接手依然成立。

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
门禁在这一次调用里跑完下面四步，任一步失败就带原因打回（不留半提交状态）。
这四步的实现**还在**，但 2026-08-30 起**不再注册成工具**（哲学三）：
门禁在内部调用它们，agent 看不到这些名字，因此没有第二条路可选。

**顺序不是 1-2-3-4 了（2026-09-10）**：full precommit 从“卡在链条最前面”
改成**与链条并行**（`startPrecommitBeside`）。理由：reviewer 判的是**不可变的
commit range**，所以真正必须在 dispatch 之前的只有 checkpoint；而 precommit
中位数 33s（旧数据 92s）全是 agent 被阻塞的时间。现在链条是：
**启动 full lane（不 await）→ checkpoint → prepare → dispatch（立即返回）**。

这带来两个必须机械成立的事：

- **checkpoint 门槛接受“正在验证中”**：凭据是**本进程里那个活的 promise**，不是
  文件。重启过的会话没有它，于是回到旧规则——没有 PASS 就不收（fail-closed）。
  同一 repo 同时只跑一条 lane；**后续轮次等它安静下来再启动自己那条，绝不 join**——
  join 意味着用一个更早内容的 PASS 背书本轮的 checkpoint（裁决记录只看 verdict）。
- **时间上确实重叠了**：lane 在跑的同时 checkpoint 会执行 `git add -A`。本 repo 的
  lane 只跑 typecheck 与测试，不往工作区写东西；但一个 `precommit.build` 会写产物的
  repo 里，未进 `.gitignore` 的构建输出可能被扫进这次 checkpoint。把那条 lane 的产物
  留在工作区外（或写进 ignore）是仓自己的事，这里只把重叠写明白。
- **裁决记录承担验证绑定**（`lib/review-adjudicate.ts` 的 `readyLacksVerification`）：
  READY 落在一个没有 full-lane PASS 的内容上时**降级为 BLOCKED**，否则会出现
  “看着已验证、实际不可 ship”的裁决。只收紧、不放宽；`/gate-bypass` 是用户
  授权，仍然优先。**判据自 2026-09-14 起有两路**：活字段 `precommit.verdict`
  是 PASS，**或者**被审 commit 的 tree 等于 `precommit.lastFullPassTree`（一条
  历史事实：某棵 tree 曾经跑过全量 lane）。第二路存在的理由：`verdict` 是**活
  绑定**，本会话自己的编辑会（正确地）把它降级成 NOT_RUN，而“边审查边改”是
  被鼓励的正常工作方式 —— 只看活字段会把真实通过的轮次记成 BLOCKED，还会让
  agent 去修一个从未失败的 precommit。树 OID 就是内容身份，所以这条事实不过期；
  写入侧只认**lane 启动前**抓下的那棵树（`nextFullPassTree`，纯函数），同一棵树
  的 FAIL 会撤销它。

  **降级的原因是分开的，而只有一个会被挂起而不是拒绝**（2026-09-15）：
  `classifyReadyWithholding`（同一个模块，纯函数）把「为什么扣下这一轮」分成
  `blocking-finding` / `stale` / `cwd-mismatch` / `unverified` / `unverified-idle`
  五类 —— 前三类是**关于工作的事实**（等多久都不会变），立即记成 BLOCKED；
  `unverified-idle`（内容没验证，**而且现在没有任何 lane 在跑**）同样拒绝：
  挂起只能发生在「还有东西会回来处理它」的时候 —— 回来处理挂起的只有那条 lane
  自己的落地与下一轮的 prepare，两者都不来时把它挂起就是永久停在 PENDING，
  而回执还叫 agent 别重跑（round-1 P1）。只有 `unverified`（lane 正在跑）才**挂起**：结论原样存进 sidecar 的
  `pendingReady`（`lib/gate-state.ts`），`review` 保持 PENDING，然后
  - lane 落 PASS 且 tree 相同 ⇒ `parkedReadyFate` 返回 `replay`，门禁把结论
    **重新交给同一个记录器**（`recordReviewVerdict`，不是第二份实现）并 steer
    唤醒 agent；
  - **其余一切 ⇒ `clear`**，挂起被清。三条路径一个原因：lane 已经落地，
    不会再有人回来处理这份结论 —— lane 落非 PASS（这轮内容没过全量，走失败
    通道说清是**验证**而不是 findings）；PASS 但覆盖的不是那一棵（lane 在
    本轮 checkpoint 之前就抓了工作区，或会话中途又送了一轮）；PASS 但当前
    review target 的 tree 已换（新一轮 prepare 替换了它）。`none` 于是只剩
    「本来就没挂起」一种情况：留下任何一条没人接管的挂起记录，都会把那一轮挂到
    下一次 prepare，而回执早就叫过 agent 别重跑（round-2 P2）。

    **不在那一列上的，是在 lane 期间编辑工作区**：它不改变这三棵树中的任何一棵
    （挂起轮的是已提交的那一份，lane 的是启动前抓的），所以挂起照样活着、照样
    重放 —— 最初的说法写成「编辑会作废挂起」，等于告诉 agent 审查期间别改文件，
    恰好与门禁鼓励的「边审边改」相反（round-3 P2）。

  这条修的是一个实测的时序竞争（本 repo PR #62 第 4 轮：3 行 diff 的增量轮
  reviewer 16 秒交卷 READY，全量 lane 34 秒后才 PASS，差 7 秒）：旧行为把那
  7 秒写成永久的 BLOCKED，回执让 agent「fix ALL findings and re-review」，而那一轮
  唯一的 finding 是一条说「本轮无改动」的 Nit —— 唯一出路是把一字未改的内容
  再审一遍。

- **时间上确实重叠了**的另一面：lane 落下的**成功**同样需要有人处理，见上面那段；
  FAIL 不再能靠“提前 return”告知，所以它作为自己的一条消息
  送给 agent —— **走 `steer`，不是 `followUp`**（2026-09-12）：pi 只在 agent
  不再有工具调用时才 drain followUp，而本门禁的存活不变量恰好禁止它在门禁未过时
  停下，于是通知排在同一个 turn 后面不出来。实测：三条 FAIL 通知（03:01 / 03:15 /
  03:23 的三次 lane）在 agent 唯一那次 2.5 小时 turn 结束时才陆续投递，延迟
  2h13m / 2h05m / 2h00m，落地时门禁自己的记录已经是 PASS + READY，agent 把它读成
  “门禁自相矛盾”，花十分钟取证并多跑两轮审查。因为消息可能在 agent 已经改过之后
  才被读到，措辞与“这还描述不描述当前这棵树”的判定在
  `lib/async-precommit-report.ts`：带**第几轮**与**所验证内容的指纹**；当 lane 启动时
  那份内容已经不是工作区里那份时**降级**（明说它是第 N 轮启动时那份、不是工作区现在
  这份的结论，也不给“重新送审”的指令），但**绝不静默丢弃**；两侧指纹任一侧读不出时
  保持强告警。降级文案**不指控也不打发**：两份不同可能是 agent 在 lane 跑的时候改的，也
  可能是 lane 自己的 `lint:fix` 改写的（`scripts/precommit-runner.mjs` 就是让
  `lint:fix` 第一个跑，因为它会改文件）—— 树本身分不出这两种，所以两种都写出来，
  且**不说“与己无关、重跑是白做工”**：那次检查报的问题在当前这份内容上还在不在，
  只有看过原始输出的 agent 能判。

- `run_precommit`（full lane，与链条并行启动）：FAIL 时本轮不产生可 ship 的 READY。
- `review_checkpoint`：`git add -A && git commit`（英文 message 校验，
  commit 标题由门禁打上 checkpoint 标记）→ 记录 commit sha。只绕过 READY，
  不绕过 precommit；普通 `git commit` 在 READY 前仍被拦。2026-09-07 起
  直接落在**当前分支**（不再有工作分支）；在 main/master/dev/develop 上
  checkpoint 直接拒绝（2026-09-16 起不再弹确认框，与 ship 拒绝一致）。
- `prepare_review`：计算 `baseline..HEAD`（自上次审核基线以来的 commit），
  生成任务文本与 findings 流路径，注册审核目标。任务文本里的**CHANGE INDEX**
  （2026-09-10）来自一次 `git diff --numstat`：逐文件改动量 + 门禁预先分好的
  读取批次（大文件单独成批）——实测 reviewer 的 92.5% 往返只发 1 个工具调用、
  单轮 17–59 次往返 × 每次 11–13s，而工具执行只占 6%，代价在**消息条数**。
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
