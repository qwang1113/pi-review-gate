# 与 pi-subagents 的协作:现状盘点、刻意不用的机制、本次增强

> 本文档回答一个问题:**pi-review-gate 的流程与 pi-subagents(子代理系统)的接口边界在哪里,哪些协作已经建立,哪些机制是刻意不用的,为什么。**
>
> 背景:gate 的强制力全部来自扩展侧(extension hooks + 注册工具 + git hooks),而**扩展永远不能 spawn 子代理**——spawn 是主 agent 的行为。因此两者协作的唯一形态是:**扩展把"事实 + 任务文本 + schema"准备好,agent 照着 spawn,扩展再验证产物**。每一次协作增强都在减少 agent 在两者之间的猜测与编排错误。

## 1. 已建立的协作(按流程)

### 1.1 Review 循环(最深的协作)

| 环节 | 扩展负责(事实) | agent 负责(spawn) | 扩展验证 |
| --- | --- | --- | --- |
| 分片 | `prepare_review` 用 `planReviewShards` 把大 diff 切成 ≤4 个不相交组(纯函数,测试锁定) | 每 shard spawn 一个 reviewer,同 turn async,各自带 cwd | — |
| 快照隔离 | 每个 reviewer 一个**可写**的 disposable snapshot worktree(含未提交改动)+ finding-stream 文件 | spawn 时传 snapshot 的 cwd | `record_review` 重派生每个 snapshot 的树,拒绝"留下编辑痕迹的 READY" |
| 评审契约 | 每 shard 的 ready-made 任务文本(`buildShardPrompt`,含快照契约、mutation 许可/禁止、stream 指令、**goal 文本**) | 原样使用,不重打 | — |
| 结构化输出 | `SHARD_VERDICT_SCHEMA` 作为每个 spawn 的 outputSchema | 填到 spawn 上 | `record_review` 用全 fence 解析器(worst wins) |
| 双评审 | `planFanoutFromFacts`(模型注册表)→ fan-out 计划注入 prompt + **prepare_review 返回推荐 model**(本次新增) | 按计划数 spawn,跨 family | 计划注明单评审 fallback 及 Note |
| 活跃度 | `subagentInMotion()` 扫描 `.pi-subagents/artifacts` 判断子代理是否在动 | — | 喂给 L2 自动继续,避免误判停滞 |

关键设计:**reviewer 的快照不是 pi-subagents 的 `worktree` 隔离**。原因见 §2.1。

### 1.2 Wave 并行编辑(第二深的协作)

| 环节 | 扩展负责 | agent 负责 | 扩展验证 |
| --- | --- | --- | --- |
| 波次计算 | `prepare_wave` fail-closed:模块列表必须等于 `computeWave(state)`;worklog 必须存在 | 同 turn async spawn 每模块一个 `worker-readonly` | — |
| 只读性 | —(pi-subagents 无 per-call tool denylist) | 用 `agents/worker-readonly.md`(tools allowlist 无 edit/write/bash) | `apply_wave_patches` 校验声明路径 ∪ diff 头 ⊆ owned_paths |
| 结构化输出 | `WAVE_WORKER_SCHEMA` 作为 outputSchema | 填到 spawn | 解析 + `git apply --check`(带 `--recount`) |
| 编排减负 | 返回每模块 ready-made 任务文本 + **可粘贴 workflowScript 骨架**(本次新增) | 填 task 文本即可 | — |

### 1.3 模型配置层

- `agents/*.md` 是 pi-subagents 加载 agent 定义的单一来源。
- 扩展的模型配置层(`.pi/review-gate.json` → `<project>/.pi/agents/*.md` 与 `~/.pi/agent/agents/*.md`)按层渲染 frontmatter:auto 开 = 内置链;auto 关 = 用户 slots(每个可带 `:thinking`)。渲染前用 `validateSpec` 校验,拒绝落盘无效 spec。
- 这就是"扩展不能控制 spawn 用什么模型"问题的答案:**它控制 agent 定义文件,pi-subagents 在 spawn 时读取**——单写者,无运行时打架。

### 1.4 计划/分解(decompose)

- `lib/plan-state.ts` 是 `.pi/plan/state.json` 的 schema 权威;planner / module-reviewer / integration reviewer 都由 agent spawn,扩展提供 schema、任务契约与 worklog 约定。
- 与 mission 机制的关系:wave worklog(`.pi/plan/worklog/`)是 repo 内持久化,pi-subagents 的 mission 是运行时记录;两者互补,不做合并。

## 2. 刻意不用的机制(以及为什么)

### 2.1 pi-subagents 的 `worktree: true` 隔离 — review 不用

`worktree` 隔离 checkout 的是 **HEAD**,不含未提交的改动——而 review 的正是未提交的改动。用它做 reviewer 隔离,reviewer 看到的树就没有被评审的内容。因此 `prepare_review` 自己创建 snapshot(基于当前工作树,含改动),`record_review` 再用 git 对象重派生验证。

### 2.2 pi-subagents 的 `gate` 参数(host-run 验证命令)— 主流程不用

`gate: "npm test"` 让运行时在 host 跑一条命令并记为 evidence。但本 gate 的**唯一可信 PASS** 是 `run_precommit`(私有 nonce receipt + 指纹绑定,扩展直接跑 runner);`git hooks` 也只信 sidecar。让 pi-subagents 的 evidence 参与判决会引入第二个信任源,反而削弱"一个权威"的设计。`gate` 参数可用于 agent 自己的轻量预检(例如 spawn 前 `git apply --check`),但绝不进入门禁裁决。

### 2.3 子代理的 turn/tool 预算 — mutation-capable 角色不用

reviewer 在 snapshot 内可以自由 mutation;给它们硬预算会在评审中途被掐断,产出半截 verdict(不可用)。只读角色(recon/triage/worker-readonly)天然短命,不需要预算。

## 3. 本次新增的增强(2026-08-23)

### 3.1 L8 硬 gate:edit/write 前必须先有用户确认的 loop goal

- 之前:loop-goal 只是 prompt 约束("PROMPT-LEVEL ONLY")——agent 可以先编辑、后补目标,ship 时才被拦,协商变成走过场。
- 现在:`tool_call` 对 `edit`/`write` 硬拦(loop 与 undecided 模式;目标文件所属 repo 各自检查自己的 goal;`.pi/`/`.pi-subagents/` 写入豁免防自举死锁;explore/normal 不拦;敏感文件检查永远最先)。
- 协作面:拦截文案指引完整协商路径——逐轮提问 → **adviser 预审**(协议要求)→ `propose_loop_goal` 对话框。reviewer 仍逐条验收 goal(criterion → P1 → BLOCKED)。
- `propose_loop_goal` 确认流程简化:**确认不再弹"可选原因"输入框**(批准本身就是信号);**拒绝仍必填原因**(转达给 agent 供重新协商)。

### 3.2 prepare_review 返回推荐 model(仅 slot 模式)

fan-out 计划(注册表事实)决定双评审的 family 构成,但 agent 此前要从注入的 directive 文本里自己翻译成具体 model spec。现在返回文本与 `details.snapshots[].model` 直接给出 `plan.reviewers` 的映射(小 diff 1:1;sharded 时提示"每 shard 用 pinned 链,计划管 integration reviewer")。**但仅当 `plan.slotSource` 存在**(即用户显式配置了 reviewer slots、auto 关闭)时才会给出——默认路径上 `plan.reviewers` 的具体 spec 不是权威选择,reviewer 实际运行的模型来自 agent 文件的 pinned 链;把 spec 作为 `model` override 交给 agent 会重新打开"cheap-tier 模型坐上 judge 位"的漏洞。与注入的 fan-out directive 共用同一个 `fanoutPlan()`,不可能打架。

### 3.3 prepare_wave 返回可粘贴的 workflowScript 骨架

返回文本直接给出一段 `runs.all([...])` 骨架,key 即 module id,agent 只需填入任务文本与 `WAVE_WORKER_SCHEMA`——消除手工拼模块列表的错误源。

## 4. 边界原则(防回归)

1. **扩展生产事实,agent 生产 spawn,扩展验证产物**——任何"扩展直接控制子代理"的改动都违反此边界。
2. **不要重新引入 pdw 引擎**:它丢弃 per-agent cwd,reviewer 拿不到自己的快照(详见 `docs/handoff-remove-pdw.md`)。
3. **不要用 pi-subagents 的 evidence 替代 run_precommit 的 nonce receipt**——信任源必须唯一。
4. 新协作点落地的验收标准:**agent 的编排步骤是否减少了**。只增加文档不减少步骤的"协作",不做。

## 5. 教训:快照目录不能携带 `.pi/`(2026-08-23 实测)

`prepare_review` 的快照曾把 `.pi/loop-goal.md` 复制进去(reviewer 要读验收契约)。实测发现:pi-subagents 的项目根探测是从 spawn cwd 向上找"第一个含 `.pi/` 的目录"——而快照目录自己就有 `.pi/`,于是**快照被当成项目根**:`<快照>/.pi/agents/` 不存在,项目层 agents(用户配置的模型 slots,如 `reviewer: opus-5`)静默失效,评审全部回退到全局默认链(fable-5)。

修复(2026-08-23):
1. 快照不再携带任何 `.pi/` 内容——goal 全文由 `buildShardPrompt` 注入 spawn 任务文本,文件携带毫无收益;
2. 扩展在快照 cwd 的会话里 inert(`isReviewSnapshotPath` 在 session_start 置 `inertSnapshotSession` 标志):**工作流层**都尊重它——tool_call 的 L8 编辑门禁与 L6(否则会拦死 reviewer 自己的变异分析)、tool_result(否则会武装 gate 状态并向快照写 sidecar)、agent_settled(否则会注入 resume)、before_agent_start(只保留 L4 语言指令与编辑纪律提示,不注入 gate 状态/模式分类指令)、session_compact。其余事件(input/agent_end/turn_end)没有显式 guard,但它们的触发状态在快照会话中不可能出现,只是传递性 inert——未来若给它们加逻辑,须同步加 guard。不再往快照写 sidecar——否则子代理会话里扩展自己会重建 `.pi/`,误判复发。
   **例外(刻意保持活跃,2026-08-23 修复)**:tool_call 的 **L1 敏感文件底线与 bash ship gate 不 inert**——快照是共享真实 `.git` 的 linked worktree,reviewer 从快照 `git push` 会推真实仓库,`.env` 编辑也不能豁免;快照会话的 enforcement 一律按 sidecar-less fail-closed(空 state 不得被当成"无变更")。回归测试:`test/loop-goal-gate.test.ts` 的"snapshot session keeps the L1 security floor"与"snapshot IS the process cwd"两条用例。

回归防线:`test/review-snapshot.test.ts` 断言快照不含 `.pi/` 目录、`isReviewSnapshotPath` 只命中快照路径;`test/loop-goal-gate.test.ts` 断言快照会话仍保留敏感文件底线与 ship gate(含 primaryRepoRoot 即快照根的场景)。任何未来想"给快照补点 .pi 里的东西"或"把惰性放回工具层"的改动都会撞上这些测试。
