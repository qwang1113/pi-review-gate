# 层级化会话通信方案（设计约定，2026-09-04）

> 状态：已实现（pane 化落地轮 READY）。本文是过程快照，部分机制已被
> 「门禁做中间人的统一会话模型」轮取代：提问走 `ask_user`（不再经 question
> fence）、管理入口（`judge_wait`/`judge_read`/`judge_close`）收归门禁；
> 以模式注册表（`lib/gate-modes.ts`）与实现为准。
> 背景结论见调研（三种通信：judge 落 verdict fence 即完成 / 编排文件通道 / 人机框），
> 本文把前两者统一为**上下级调用树**。
>
> 又一处已被取代（2026-09-04 同日第二轮）：**verdict fence 与 `record_review`
> 都没了**。judge 调 `judge_conclude` 交卷，结构化字段直写 channel report，opener
> 当数据消费；记录侧是普通函数 `recordReviewVerdict` / `recordGoalPrereview`，
> 不在任何工具面上。下文凡出现 `verdict fence` / `record_review` /
> `record_goal_prereview` 的地方，读作「`judge_conclude` 交卷 / 门禁自己的记录
> 函数」——判定语义（STALE、tree 绑定、adviser 不进 recorder）逐条不变。

## 一、调用链（唯一合法形状）

```
项目经理 ── orchestrator_spawn ──> 子会话 ── judge_spawn ──> goal review pane
                                    │  ├──────── judge_submit（内部 spawn）──> checkpoint review pane
                                    │  └────────（向 PM 上报：report 记录）
                                    │
                                    └──（PM 自开） judge_spawn ──> plan review pane
```

* 项目经理能开的：子会话（`orchestrator_spawn`）、plan review（`judge_spawn`，plan 是 PM 自己的产出，自开不算越级）。
* 子会话名下的 review 分两路：goal review 用 `judge_spawn` 自开；checkpoint review 用 `judge_submit` 自提（precommit → checkpoint → prepare → 内部 spawn 全链）。一个 review 一个独立 pane（用户选 1A）。
* 严禁跨级：项目经理**不能**直接开子会话名下的 review，不能 `wait` / `answer` / `close` 别人的 review，只能读子会话上报的结论；子会话之间不能互相操作对方的 review。

## 二、谁开谁负责，上报逐级走

* opener（父级 session id 或 orchestration id）在 spawn 那一刻由门禁记下来，全程不可改。
* review 只向它的 opener 报告：结束时写一条 `report` 记录（见 §五）进双方通道，opener 经自己的 `wait` 回执收到 verdict 摘要 + findings 计数。
* 子会话向 PM 报告自己名下 review 的结论时，同样走 `report` 记录经编排通道上浮，不贴原文 stdout（大字段 spill，沿用 `MAX_INLINE_RECORD_CHARS=1500` 规则）。
* PM 与子会话的审核（goal 批准框、consent 框）本来就走子会话通道 `request`（`askThroughChannel` 已实现），保持不变——这就是“项目经理和子会话的审核也走类似于子会话的通道”。

## 三、Judge pane 化（用户选 1A）

* 每个 review 独立 pane，标题沿用装饰规则 `@<task> · review-<state> <secs>`（`orchestrator-pane-decor.ts` 复用），颜色按 judge id 稳定派发。
* 启动 argv 与今天 `judge-process.ts` 同一机制（`pi --session-id <id> @<taskfile>`，无 shell），只是落点从“后台进程”换成“新 pane 里的交互进程”。
* 上下文复用不变：同 role + 同 repo 同一 session id，重开 pane 即续接同一 transcript（与 `orchestrator_recover` 的 `rg-child-<childId>` 同理）。
* 回收：review 对象终结时由门禁 `kill-pane` + 按“关最后一个才撤销 window 设置”规则收尾；transcript 与裁决记录保留，pane 不保留。终结指三者之一：verdict 为 READY、opener 放弃、换 review 对象。verdict 为 BLOCKED（还有下一轮）时 pane 保留，下一轮复用——落 verdict 不等于终结。
* 提问：走 `ask_user`（人坐 pane 前可答，opener 经通道可代答，先答生效），等答案时停下、不退出 pane；question fence 已废弃。
* 意外停止恢复：pane 消失（`dead`）但 verdict 未落盘时，本轮不算结束。opener 用 `judge_recover` 以同一 session id 重开 pane 续接 transcript 继续本轮（不新开一轮、不丢上下文），跨级禁令同样适用——只有 opener 能恢复自己的 review。
* 多轮复用：pane 是承载体，轮是任务。同一 review（如同一 checkpoint 的连续复审轮）复用同一个 pane + 同一 transcript；只有换 review 对象（新 baseline、新 goal 草稿）才开新 pane。
* 父级联关：opener `declare_done` 时门禁先关它名下全部 judge pane 再走正常 done 流程——已结束（verdict 已落盘）的直接回收；仍在跑的按 `judge_close` 语义放弃本轮再回收（未落盘的轮不记入 review 链）。opener 不手拼 `kill-pane`，联关全程门禁执行。本条取代现行“有名下未关闭 judge 即拒 done”规则，实现时同步改掉它，不并行两套 done 门槛。
* 重启接管：opener 注册表与两类 pending 落盘（`<repo>/.pi/judge-hierarchy.json`，按 repo 分片），新会话启动与每次触达 repo 时懒合并（内存优先、坏文件丢弃）。死 pane 的异主条目由触达者自动过户（无活着的对端可冲突，pending 随行）；活 pane 或心跳新鲜的异主条目保持严格拒绝（那可能是活着的对端）。绝不为同一 session id 再开第二个 pi。

## 四、监听三件套（用户已确认粒度）

opener 能从门禁拿到的关于自己 review 的信息，只有三件，不多不少：

1. 状态（`working` / `waiting-input` / `idle` / `done` / `dead` / `stalled`，沿用 `orchestrator-child-state.ts` 七态判定，心跳仍是子会话侧独立定时器）；
2. findings 流计数（读 `.pi/review-stream/<round>.jsonl` 行数，不推内容）；
3. 结束 verdict（`record_review` 落盘后的结论正文）。

实时 stdout **不推**。排查路径：人直接 attach 进 pane 看；opener 侧按需经 `tmux pipe-pane` 抓屏（带转义序列、仅排查用，不做任何判定）。今天后台进程那种干净 `stdout.log` tee 在 pane 模型下不存在——pane 内扩展无法 tee 自己的 TUI，不虚构它。

## 五、工具清单

| 工具 | 动作 | 说明 |
|---|---|---|
| `judge_spawn` | 新增（限 goal / plan） | 只开无需 checkpoint 前置链的 review（goal / plan）。checkpoint review **不能**经此直开——precommit → checkpoint → prepare 链（AGENTS.md 现行保证）仍只能由 `judge_submit` 内部持有。是 goal / plan review 的唯一 agent 可见入口 |
| `judge_wait` | 复用并泛化 | 今天的 `judge_wait` 只懂进程三判据；改为同一骨架（`poll-wait.ts`）换判据：读通道回执三件套。未结束返回进度（状态 + findings 计数） |
| `judge_answer` | 新增 | 对应 `orchestrator_answer`：opener 代答自己 review 的框（原文/序号/唯一子串，歧义拒绝）。非 opener 调用直接拒绝 |
| `judge_close` | 复用 | 语义不变（起不来/卡死的回收），加一条 opener 校验 |
| `judge_recover` | 新增 | 对应 `orchestrator_recover`：pane 消失但 verdict 未落盘时，opener 以同一 session id 重开 pane 续接 transcript 继续本轮。pane 还活着或 tmux 读不出时拒绝（与 orchestrator_recover 同理），非 opener 调用直接拒绝 |
| `judge_submit` | 重实现为编排糖 | 对外语义不变（一次调用跑 precommit → checkpoint → prepare → spawn → wait → record）。checkpoint review 的 spawn 走门禁内部实现（agent 不可见、无第二条手调路径），goal / plan review 走 `judge_spawn` 新链。按哲学三：旧进程直启路径删除，不并行两套实现 |
| `judge_read` | 保留但限范围 | reviewer / goal-auditor 走 record + `report`，不再需要它读；但 adviser 从不经过 `record_review`，其结论仍靠它读。限为 adviser 专用 reader，不再是通用第二入口 |

跨级调用的拒绝是 fail-closed：`judge_wait` / `judge_answer` / `judge_close` / `judge_recover` 先验 `caller ∈ {opener}`，不是即拒，无对话框。

## 六、模块落点（`lib/`）

| 落点 | 职责 |
|---|---|
| `lib/judge-pane.ts`（新建） | pane 版 judge 启动/回收/恢复/联关。argv 构造复用 `judge-process.ts`，开/关 pane 复用 `orchestrator-tmux.ts`，装饰复用 `orchestrator-pane-decor.ts`；`judge_recover` 同 id 重开续 transcript，`declare_done` 联关名下全部 pane |
| `lib/hierarchy.ts`（新建） | opener 注册表 + `caller is opener` 校验（纯函数，IO 经 seam，便于单测）。这是“门禁维持秩序”的唯一实现点 |
| `lib/orchestrator-channel.ts`（改） | 通道 key 从 `<orch-id>/<child-id>` 泛化为 `<opener-id>/<judge-id>`（opener 可以是 session id）；新增 `report` 记录种（verdict 摘要 + findings 计数 + payload spill 引用）。不另起 judge-channel 模块：记录/spill/游标/IO seam 是同一套原语，另起即重复实现，分 planes 只在 key 命名上区分 |
| `lib/judge-lifecycle.ts`（改） | dispatch 改走 pane（调 `judge-pane.ts`）；verdict 记录（`record_review`、STALE 判定、tree 绑定）原样保留 |
| `lib/orchestrator-child-state.ts`（复用，不改） | 七态判定给 review 通道直接用 |
| `extensions/review-gate.ts`（只改接线） | 注册新工具 + 注入 deps（opener 身份、registry）。判定逻辑一律不在扩展里 |
| `test/hierarchy.test.ts`（新建） | 跨级拒绝矩阵（PM 动子会话的 review、子会话互操作、opener 自操作）纯函数单测 |

## 七、落地状态（2026-09-04 同轮实现完毕）

* 已按迁移顺序一次性落地：`hierarchy.ts` + 单测 → 通道泛化 + `report` →
  `judge-pane.ts`（启动/回收/恢复/联关）→ `judge_spawn/wait/answer/recover` 接线 →
  `judge_submit` 切新链并删旧路径（`spawnJudgeProcess` / `decideJudgeDispatch` /
  `evaluateJudgeWait` / `lib/judge-watch.ts` 整模块）→ `judge_read` 收窄为 adviser
  专用 → `declare_done` 联关取代旧拒规则。另加 judge 侧 reporting shell
  （`judge-side.ts`）与 judge 会话工具中央拒绝表。
* 与 `feat/improvement-plan` 的 JUDGE-1 pane 栈的关系：本线是 main 上唯一的落地
  路径，那条线的 judge 栈废弃不合并（用户决策），局部成果如需吸收只以移植单取。
