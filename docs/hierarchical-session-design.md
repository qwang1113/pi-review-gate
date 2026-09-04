# 层级化会话通信方案（设计约定，2026-09-04）

> 状态：方案约定轮，只定形状，不改行为。
> 本轮交付仅本文档；实现分后续轮按此文档执行。
> 背景结论见调研（三种通信：judge 进程退出即完成 / 编排文件通道 / 人机框），本文把前两者统一为**上下级调用树**。

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
* 回收：review 结束（verdict 记录落盘）由门禁 `kill-pane` + 按“关最后一个才撤销 window 设置”规则收尾；transcript 与裁决记录保留，pane 不保留。
* 提问：沿用 question fence 语义，但 pane 化后走通道 `request`/`answer` 竞态（人坐 pane 前可答，opener 经通道可代答，先答生效），不再要求“输出 fence 并退出”。

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
| `judge_submit` | 重实现为编排糖 | 对外语义不变（一次调用跑 precommit → checkpoint → prepare → spawn → wait → record）。checkpoint review 的 spawn 走门禁内部实现（agent 不可见、无第二条手调路径），goal / plan review 走 `judge_spawn` 新链。按哲学三：旧进程直启路径删除，不并行两套实现 |
| `judge_read` | 保留但限范围 | reviewer / goal-auditor 走 record + `report`，不再需要它读；但 adviser 从不经过 `record_review`，其结论仍靠它读。限为 adviser 专用 reader，不再是通用第二入口 |

跨级调用的拒绝是 fail-closed：`judge_wait` / `judge_answer` / `judge_close` 先验 `caller ∈ {opener}`，不是即拒，无对话框。

## 六、模块落点（`lib/`）

| 落点 | 职责 |
|---|---|
| `lib/judge-pane.ts`（新建） | pane 版 judge 启动/回收。argv 构造复用 `judge-process.ts`，开/关 pane 复用 `orchestrator-tmux.ts`，装饰复用 `orchestrator-pane-decor.ts` |
| `lib/hierarchy.ts`（新建） | opener 注册表 + `caller is opener` 校验（纯函数，IO 经 seam，便于单测）。这是“门禁维持秩序”的唯一实现点 |
| `lib/orchestrator-channel.ts`（改） | 通道 key 从 `<orch-id>/<child-id>` 泛化为 `<opener-id>/<judge-id>`（opener 可以是 session id）；新增 `report` 记录种（verdict 摘要 + findings 计数 + payload spill 引用）。不另起 judge-channel 模块：记录/spill/游标/IO seam 是同一套原语，另起即重复实现，分 planes 只在 key 命名上区分 |
| `lib/judge-lifecycle.ts`（改） | dispatch 改走 pane（调 `judge-pane.ts`）；verdict 记录（`record_review`、STALE 判定、tree 绑定）原样保留 |
| `lib/orchestrator-child-state.ts`（复用，不改） | 七态判定给 review 通道直接用 |
| `extensions/review-gate.ts`（只改接线） | 注册新工具 + 注入 deps（opener 身份、registry）。判定逻辑一律不在扩展里 |
| `test/hierarchy.test.ts`（新建） | 跨级拒绝矩阵（PM 动子会话的 review、子会话互操作、opener 自操作）纯函数单测 |

## 七、本轮非目标（后续轮按此文档执行，不在本文展开）

* 不实现任何新工具与通道改动；`judge_submit` / `orchestrator_*` 现有行为零改动；扩展接线与 pane 管理零改动。
* 迁移顺序建议（仅记录）：先 `hierarchy.ts` + 单测 → 通道泛化 + `report` → `judge-pane.ts` → `judge_spawn/wait/answer` 接线 → `judge_submit` 切新链并删旧路径 → `judge_read` 收窄为 adviser 专用。每步各一轮送审。
