# 交接:增量核验架构(adviser/goal-auditor/reviewer 复用上轮上下文)

**交接日期**: 2026-08-27
**交接人**: 上一会话(pi-review-gate 仓库,分支 `feat/incremental-review-context`)
**接手事项**: 完成 review 确认与发布(commit → PR),以及标准 6 的遗留测量。

## 一、任务背景(用户原始诉求)

用户提出:gate 的三个评审角色(adviser、goal-auditor、reviewer)每轮都是全量核验,浪费大量时间。要求:
1. 首轮全量,后续轮次复用上次核验上下文、只审增量(聚焦增量与未解决 findings,已判定且未变的部分只做一致性扫描)
2. 三个角色不 fork 主会话全量上下文,改为 `context:"fresh"` + 主会话 transcript 路径按需读取
3. **核心目标是缩短评审轮次的墙钟耗时(省时间);token 节省是副产品**
4. 顺带:companion 包用 `npm:pi-hashline-edit-pro` 代替 `npm:pi-hashline-readmap`(用户 2026-08-27 追加要求,原 readmap 0.13.0 的 Node 20 引擎基线相应升至 ≥22.19)

loop goal 全文在 `.pi/loop-goal.md`(用户已批准,6 条退出标准)。

## 二、分支与工作树状态

- 分支:`feat/incremental-review-context`(从 main `0566b92` 开出)
- 工作树:39 个文件改动(含新文件 `lib/session-dir.ts`、`test/session-dir.test.ts` 及两份 docs 文档),**全部未提交**
- 门禁状态:
  - review:**BLOCKED**(round 10 已记录;round 10 的 3 条 P1 已修复但未再验证——轮次上限 10 已用尽)
  - precommit:本会话未跑(上个任务的 PASS 属于旧树,不匹配当前指纹)
  - 未 push、未开 PR

## 三、已完成(实现清单,全部有测试)

### 1. reviewer 增量注入(goal 标准 1,核心)
- `lib/review-scope.ts`:`formatReviewScopeDirective` 新增 `audience` 参数(`"agent"` | `"reviewer"`),同源文本两种口吻
- `lib/parallel-review.ts`:`buildReviewPrompt` 新增 `scopeDirective`、`session`、`precommitBaseline` 三个参数
- `extensions/review-gate.ts`:`prepare_review` 接通——任务文本机械包含 "Review scope for this round" 块(SETTLED + 增量清单 + 上轮 findings 复检)+ transcript 指针 + precommit 基线

### 2. goal-auditor 重审增量(标准 2)
- `GoalPrereviewRecord` 扩展:持久化 `findings`(逐条原文)、`draft`(被审文本)、`durationMs`
- `record_goal_prereview`:接受可选 `auditStartedAt` 计算本次审计耗时;重审(不同 hash)时响应附"距上次审计分钟数"
- 新工具 **`prepare_goal_audit`**(预派发):dispatch auditor 之前调用,返回完整任务文本(carryover 块 + `diffDraftLines` 机械草稿差异 + fresh transcript 指针)——修复了"record 之后才有模板"的时序缺陷
- `formatGoalPrereviewCarryover`:零 findings 也携带 verdict;旧 draft 原文随行
- `lib/verdict-parse.ts`:`parseFenceFindings`(含控制字符 salvage)

### 3. adviser 结论存储与注入(标准 3)
- 新工具 **`prepare_adviser`**:返回 brief(transcript 指针 + artifact 路径 + 上次结论注入 + 变更清单)
- artifact 身份:**raw 文件内容 hash**(非截断显示文本);no-goal 时 session 稳定(`no-goal-<sessionId>`,anon 兜底)
- per-goal 基线 `adviserBaselines`(map,不同 goal 互不覆盖)
- `changedFiles` 三态:null(增量无法计算)→ brief 要求**全量核对**(不假装"无变更")
- `parseAdviserConclusions`:verdict 白名单(SUPPORTS/OBJECTS/NEUTRAL)+ points 形状校验
- `shellSingleQuote`:brief 的 bash 追加指令 shell-safe(真 round-trip 测试)

### 4. 上下文模式切换(标准 4)
- `agents/reviewer.md`、`agents/adviser.md`、`agents/goal-auditor.md` frontmatter 全部 `defaultContext: fresh`
- 全局层已渲染(运行过 `node scripts/install-package.mjs`):`~/.pi/agent/agents/*.md` 已是 fresh

### 5. precommit 基线注入(用户 2026-08-27 追加要求)
- `formatPrecommitBaseline` + **`extractPrecommitBaseline`**(纯函数):指纹匹配(旧树 PASS 永不冒充本轮证据)+ 过期 cache 条目过滤 + lane-aware 措辞(full 才劝"别跑全量",fast/related 提示可重跑)
- `prepare_review` 在 precommit PASS 且指纹匹配时注入基线块,指示 reviewer 只跑针对性测试

### 6. 文档
- `AGENTS.md`(b)/(b2) 协议段、`skills/review-loop/SKILL.md`、`README.md`、`QUICKSTART.md`、`docs/incremental-review-measurements.md`(含 Exit-criterion 6 status 节)

### 7. readmap → edit-pro 切换(用户追加要求)
- `package.json` dependencies:`pi-hashline-edit-pro ^2.7.1`(readmap 已移除)
- `scripts/install-package.mjs`:COMPANION_PACKAGES 已是 edit-pro(外部已改),注释已同步
- `test/install-package.test.ts` 期望、`README.md` companion 列表已同步
- 环境:`~/.pi/agent/settings.json` 已移除 readmap(另:4 个评审角色保留 `extensions: []` 禁用 ambient 扩展,防未来冲突)

## 四、测试状态

- `npm test`: **1496 pass / 0 fail / 3 skip**;`npm run typecheck` 通过
- 新增测试文件:`test/adviser-brief.test.ts`
- 新增用例分布于:`review-scope`、`parallel-review`、`loop-goal`、`verdict-parse`、`gate-state`、`agents-structure`、`extension-structure`、`install-package`

## 五、未决事项(接手 agent 的 TODO)

1. **【首要】review 确认与发布**:
   - 新会话扩展会加载新代码(旧会话是启动时加载的旧扩展,新工具未生效)
   - 流程:先 `run_precommit`(full,同树跑,使 precommit PASS 指纹匹配)→ `prepare_review`(验证任务文本含 "Review scope for this round" 块 + PRE-COMMIT BASELINE 块)→ spawn reviewer(任务文本需带 loop goal 全文 + round 10 的 3 条 P1 复检清单:①adviser changedFiles 三态 ②extractPrecommitBaseline 纯函数化 ③Exit-criterion 6 文档)→ `record_review` → 修复(如有)→ `run_precommit` → commit → push → PR(base: main)
   - **commit message(英文,Conventional Commits)**:`feat(review): incremental context reuse for adviser/goal-auditor/reviewer`
   - **PR 描述需包含**:测量数据(goal-auditor 206s→61s→54s,−70/−74%;reviewer round1 10m10s→round2 8m57s→round3 9m31s,归因见测量文档)+ 标准 6 (b)(c) 下会话实测计划 + readmap→edit-pro 切换说明
2. **轮次上限**:`.pi/review-gate-state.json` 的 `rounds` 已累计 10(跨会话共享)。若新会话 record_review 被 maxRounds 拦截,需用户批准调高 `.pi/review-gate.json` 的 `maxRounds`(合法范围 3–50)
3. **标准 6 (b)(c) 墙钟测量**(软指标,但数据必须记录):
   - (b) reviewer:取得 READY 后做一处小改动(decideReviewScope 阈值内)→ round 2,记录两轮耗时
   - (c) adviser:同一 goal 下两次咨询(prepare_adviser 两次调用),记录耗时
   - 结果记入 `docs/incremental-review-measurements.md`
4. **验证新工具**:新会话可直接调用 `prepare_goal_audit` / `prepare_adviser` 冒烟(旧会话无法——扩展未重载)

## 六、关键代码位置

| 关注点 | 文件 |
|---|---|
| reviewer 任务文本/基线 | `lib/parallel-review.ts` |
| 增量范围判定/口吻 | `lib/review-scope.ts` |
| goal-auditor 记录/模板/草稿差异 | `lib/loop-goal.ts` |
| adviser brief/解析/转义 | `lib/adviser-brief.ts` |
| findings 提取 | `lib/verdict-parse.ts` |
| 工具接线(prepare_review/adviser/goal_audit/record) | `extensions/review-gate.ts` |
| state 字段 | `lib/gate-state.ts`(`adviserBaselines`、`goalPrereview` 扩展) |
| 测量文档 | `docs/incremental-review-measurements.md` |

## 七、陷阱与教训(踩过的坑)

- **扩展进程不热更新**:会话启动时加载旧扩展,改完代码要新会话才生效(本会话因此无法端到端验证新工具)
- **模板字面量转义**:TS 模板字符串里 `'\''` 会丢反斜杠,需写 `'\\''`(shell 转义 round-trip 测试抓到的)
- **gate-state loadSidecar 括号嵌套**:多条件 if 极易括号失衡,改后必跑 typecheck
- **node:test 函数内禁止 `await import`**:模块级顶层 import 才能用
- **reviewer 流式 findings 全部是真问题**:9 轮共 39 条,每轮都抓到实质缺陷(时序、转义、指纹、缓存关联、措辞)
- 测试断言跨行文本时用两个 match,不要跨行正则

## 八、Non-goals(明确不做)

- 不迁移 @tintinweb/pi-subagents(另立 goal)
- 不引入真 session resume
- 不改快照隔离/fingerprint/binding 等 fail-closed 语义
