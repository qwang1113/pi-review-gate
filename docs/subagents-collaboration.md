# 门禁与 pi-subagents 的协作

> **SUPERSEDED 2026-08-27** — judge 角色不再以子代理形式派发：它们作为
> tmux 子会话（独立 pi 进程，`review_spawn`）运行，审核单元是 checkpoint
> commit 范围（`baseline..HEAD`）；子代理调度 judge 角色被硬拦截。当前
> 模型见 `docs/execution-model.md` + `docs/judge-protocol.md`。本文保留为
> 2026-08-26 快照模型的协作记录。

> 本文记录 gate 与 pi-subagents 协作的**已建立事实**与**刻意不用**的部分，
> 供 review 与维护者对照实现。2026-08-26 起审阅流程为**单审**（一个
> reviewer / 一轮 / 一次 record_review）；多审、多模块计划均已移除。

## 1. 协作总览

门禁无法自行 spawn 子代理（主会话仍是唯一 writer），因此审阅/执行的派发
由 `extensions/review-gate.ts` 的 prepare 工具出 ready-made 任务 + 输出 schema，
主会话再逐个 spawn。核心约束：**reviewer 必须跑在自己的快照 cwd 里**。

### 1.1 cwd 强制（mechanical）

| 机制 | gate 侧 | pi-subagents 侧 | 备注 |
|---|---|---|---|
| 快照 | `prepare_review` 建 1 个 disposable WRITABLE worktree，返回 cwd/stream/files/task | 子代理 `cwd` 参数可用 | — |
| 强制 | `lib/reviewer-spawn-guard.ts`：无 cwd 命中某快照 → `block` | 子代理默认继承父进程 cwd | — |
| workflowScript | 存在快照时**整体拦截** reviewer 派发 | 沙箱 `runs.run` 无 per-child `cwd` | — |
| record 校验 | `record_review` 要求快照被进入（spawn 观测或 verdict 的 `cwd`），否则 `SNAPSHOT UNUSED` 降级 | — | — |

## 2. 单审契约与角色

| 角色 | 模型 | 思考 | 说明 |
|---|---|---|---|
| reviewer | claude-fable-5 → claude-opus-5 → opencode-go/deepseek-v4-flash | max | 唯一产生裁决的角色；每轮只 spawn 一个 |
| reviewer-readonly | 同 reviewer | max | 隔离不可用时的 fallback；tools 无 edit/write |
| adviser | 同 reviewer | max | 咨询，不 gate |
| arbiter | 同 reviewer | max | 仅 request_arbitration 时裁决 |
| goal-auditor | claude-fable-5（只读） | max | loop goal 预审，裁决被 gate 机械记录 |
| recon | claude-haiku-4-5 → opencode-go/deepseek-v4-flash | low/off | 只读扫描，不裁决 |
| fixer | claude-sonnet-5 → claude-opus-5 → opencode-go/deepseek-v4-flash | max | 执行层 |

`lib/parallel-review.ts` 提供单审契约：`REVIEW_VERDICT_SCHEMA`（带必填
`cwd` 字段）与 `buildReviewPrompt`；`prepare_review` 直接用它生成 ready-made
任务文本，避免重打导致的漂移。

## 3. 派发形状

### 3.1 单审 spawn（唯一允许的 reviewer 派发）

```
prepare_review → (snapshotDir, streamPath, files, taskText, REVIEW_VERDICT_SCHEMA)
  → subagent({ agent: "reviewer", async: true, context: "fresh", cwd: snapshotDir,
               task: taskText, outputSchema: REVIEW_VERDICT_SCHEMA })
  # context: "fresh" 是显式的（round-10 P1）：全局 defaultSubagentContext
  # 会覆盖 agent 的 defaultContext，只有显式字段才赢；transcript 指针
  # 在 taskText 内按需读取
  → record_review(reviewer output)   # 一轮一次
```

### 3.2 只读并发探索

`recon` / `adviser` 读真实 worktree 设计使然，可与编辑并行；只有主会话写
worktree。

## 4. 移除的机制（2026-08-26）

- **多审/多分片**：删除；任何 diff 都单审。
- **多 reviewer 双审**：删除；单 reviewer 是常态，无需 Note。
- **多模块计划与波次执行**：删除；大任务切成单审循环的连续轮次。

## 5. 何时派发子代理（决策表）

| 目的 | 角色 | 并行度 |
|---|---|---|
| 代码/文档搜索、重读 | recon | 可并发，可与编辑重叠 |
| 设计咨询 | adviser | 可并发 |
| 审阅（唯一） | reviewer / reviewer-readonly | 每轮 1 个 |
| 执行修复 | fixer | 串行（写 worktree） |
