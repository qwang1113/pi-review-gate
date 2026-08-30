# 任务：judge 工具改名 + 全链路流式进度 + L5 统一判定与申诉口子

你在 pi-review-gate 仓库工作。上一轮已完成「重门禁、轻 Agent」重构（judge_submit 一体化、
setup_workspace、ask_user、branchOps、precommit fail-fast），本轮是它的三块延伸。全程走 loop
门禁流程。

## 0. 总纲（沿用上一轮，仍是最高准则）

**重门禁、轻 Agent**：流程性/状态性/生命周期性事务归门禁；Agent 只做创造性工作 + 按需调门禁
工具。门禁不管流程之外的事。沟通风格 = 高级助理（言简意赅、不啰嗦、不弱智），适用于 agent
输出、代码与文档、以及门禁的所有文案。

**本轮新增的一条哲学（用户原话）**：硬拦截不要卡死 Agent 做事 —— 凡是**门禁自己可能判错**的
地方，都要留申诉口子；但申诉不能太频繁，否则 Agent 会拿申诉当快捷方式。

## 1. judge 工具改名（用户已定：三个一起改，旧名删除）

`review_wait` 等的是任一 judge 角色（reviewer / adviser / goal-auditor），叫 "review" 名不副实。

- `review_wait` → `judge_wait`
- `review_read` → `judge_read`
- `review_close` → `judge_close`

与 `judge_submit` 成对。按本仓「无兼容层」原则**旧名直接删除**，不保留别名。注意同步：工具
描述、注入文本、AGENTS.md、docs/execution-model.md、docs/judge-protocol.md、
skills/review-loop/SKILL.md，以及所有 source-pin 测试。

`review_spawn` / `review_send` / `review_watch` 已是内部/高级入口，本轮不改名（除非同步文案时
顺手对齐口径）。

## 2. 流式进度：让等待不再是黑盒（用户已定：全做）

### 2.1 技术前提（已核实，不必再调研）

扩展工具的 `execute(toolCallId, params, signal, onUpdate, ctx)` 第 4 个参数 `onUpdate` 就是
pi 内置 bash 工具做实时输出用的同一个回调：
- 类型：`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:371`
- 参考实现（累积 + 节流 + `onUpdate({content:[{type:"text",text:snapshot}]})`）：
  `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js:245-280`

本仓目前**所有**工具都把它写成 `_onUpdate` 丢弃了。

关键语义：`onUpdate` 只影响**用户在界面看到的** partialResult 渲染，**不改变 agent 最终收到
的 tool result**。所以流式是纯粹的「让人看得见」，不污染 agent 上下文 —— 实现时不要把进度
文本混进最终返回值。

### 2.2 实测耗时（来自 .pi/gate-timings.jsonl，262 次 precommit / 172 次 review）

| 操作 | 中位 | 最大 |
|---|---|---|
| review 一轮 | **8.9 分钟** | 2.2 小时 |
| precommit 全量 | **92 秒** | 13 分钟 |
| ├ test | 93s | — |
| └ typecheck | 3s | — |

### 2.3 落地范围（优先级即实施顺序）

1. **`judge_wait`** —— 最黑的盒子。等待循环里每轮读 stdout 尾部 + findings 流增量，有变化就
   `onUpdate`，节流 ~2s。
2. **`judge_submit(reviewer)` 的同步链** —— 价值最高，每轮必经：
   `precommit: test 运行中…` → `checkpoint <sha> 已提交` → `reviewer 已 spawn`。
3. **`run_precommit` 单独调用** —— 复用同一进度源（步骤名 + 已耗时）。
4. **`declare_done`** —— 合并 + 全门禁复检，冲突时尤其需要看得见。
5. **LLM 判定**（checkTestLabels / classifyNonEnglish / classifyShipCommand / classifyAiAttribution，
   共 6 处，每次数秒，在编辑与提交热路径上）—— **不做完整流式**；只在超过 ~3s 时发一次
   `onUpdate` 提示「正在做 L6 分类 / L5 语义判定」，避免「编辑卡住了」的错觉。
6. **copilot 等待**（request_copilot_review / check_copilot_review）—— 网络分钟级，顺手做。

## 3. L5 英文判定：单一实现 + 硬标准 + 申诉口子

### 3.1 收敛到单一实现（用户要求：一个实现，多处调用）

当前判定散在 4 处、口径不一：

| 位置 | 现状 |
|---|---|
| `extensions/review-gate.ts:2073` | commit message（tool_call 层）—— 上一轮已收敛为 `firstNonEnglishCommitMessage` |
| `extensions/review-gate.ts:3062` | review_checkpoint —— 与上者共用 ✓ |
| `extensions/review-gate.ts:2103` | PR title/body —— 仍是旧的 `firstNonEnglish` |
| `extensions/review-gate.ts:1794` | labels —— 走 `classifyNonEnglish` |

目标：**一个纯函数**（放 `lib/lang-detect.ts`）表达全部 L5 判定，四处只是调用点差异
（subject / body / PR 文案 / labels 各自传入自己的 kind）。可单测。

### 3.2 所有 L5 拦截改硬标准

含任何非拉丁字母即拒（`containsNonLatinLetter` 口径），不再用 majority 稀释策略 —— 正因为
下面开了申诉口子，硬标准才敢一刀切。合理的非英文场景（body 里粘贴中文报错日志等）走申诉。

### 3.3 申诉口子：只给「启发式判定」，不给「流程事实判定」

**分界线**：门禁**可能判错**的才开口子；**事实判定**（你有没有做某步）不开 —— 否则等于教
agent 用申诉逃避流程。

**A 类 · 必须带申诉指引**（block reason 里点明「若确属误判，可申诉」）：

| 拦截点 | 位置 | 误判场景 |
|---|---|---|
| commit subject 非英文 | 2076 | subject 合法引用中文文件名/错误串 |
| commit body 非英文 | 同函数 | body 粘贴中文报错日志 |
| PR title/body 非英文 | 2106 | 同上 |
| romanized 非英文（LLM 语义） | 2094 / 2117 | `feat: add pinyin support` 被判成拼音 |
| AI attribution（LLM 语义） | 2059 | 正常提到 "Claude" 的技术改动被判成署名 |
| L6 test label 检查（LLM 分类） | 1891 | 测试内容被误分类 |

**B 类 · 一个都不加**（事实判定，已有正确出路）：

| 拦截点 | 位置 | 出路 |
|---|---|---|
| 工作区未确认 | 2696 | `setup_workspace` |
| goal 未批准 | 2719 | `propose_loop_goal` |
| judge 走 subagent | 1935 | 用 `judge_submit` |
| ship 门禁未满足 | 2246 | 满足门禁；`request_arbitration` 已覆盖「循环阻塞」这一真例外 |
| 敏感文件 | 1828 | `request_sensitive_edit` |

### 3.4 防滥用四道闸（用户已定：配额 3 次）

1. **只能申诉已实际发生的 block**（沿用现有 `request_arbitration` 的设计）
2. **内容绑定 + 一次性**：申诉绑定被拒文本的 sha256；驳回后同一内容不得再申诉（改了内容 =
   新事实，才允许再来）
3. **会话配额 3 次**：A 类申诉每会话上限 3 次，用尽后只能改文案或找用户
4. **天然成本**：一次申诉 = 一次 arbiter 调用（强模型、几十秒），agent 有成本感知

裁决沿用现有三种结论：GATE_WINS（照办）/ AGENT_WINS（一次性放行这条内容）/ HUMAN（用户定）。
放行必须是**内容绑定的一次性**，不是命令绑定 —— 防止拿到通行证后换文案。

### 3.5 【本轮实证的循环阻塞 · 必须解决】修非英文 message 的路径被门禁自己堵死


验证会话跑出的真实死锁，是 3.3 那条哲学最硬的证据：

- 门禁要求 commit message 必须英文；
- 但历史里已有一条中文主题的 commit 时，**修它的两条路都被门禁自己拦死**：
  - verdict=BLOCKED 时 `git commit --amend` 被 L1 拦（合理）；
  - verdict=READY 后 `git rebase -i` reword，在 rebase **必经的 detached HEAD 中间态**被拦，
    理由是「无法确定当前分支」+ fingerprint mismatch。
- `request_arbitration` 只受理 `gh pr edit`，够不到这里。**唯一出口是只有用户能跑的
  `/gate-bypass`** —— 等于门禁把自己的规则变成了不可修复的死结。

要求：

1. **识别「只改 message 不改 tree」的改写**（amend / rebase reword）：逐条比对改写前后的
   tree hash，全等即视为无内容变更，**不重新 arm ship gate、不判 fingerprint mismatch**。
2. **rebase 中间态（detached HEAD）不得因「无法确定当前分支」而拦**：分支判定要能识别
   `.git/rebase-merge` / `.git/rebase-apply` 存在时的中间态，按 rebase 的原始分支判定。
3. 若上述仍拦，则该拦截**必须归入 A 类**并给出申诉口，绝不能只剩 `/gate-bypass` 这一条人肉出路。

### 3.6 【本轮实证】ask_user 的问答内容没有留痕（用户提出）

`lib/ask-user.ts:184 formatTranscriptSummary` 只往 transcript 写**计数**
（`已回答 2（共 2 问）`），问题与答案的**内容一个字都没留**。对话框一关，用户无法回溯自己
选了什么，agent 也不能引用。

要求：把每题的**问题摘要 + 用户所选答案**写进 transcript（跳过/转聊天/未作答也标注），
保持 O13 风格（一题一行，不复述整段选项文本）。

### 3.7 【本轮实证】headless/RPC 环境下 ask_user 无法弹窗

验证会话报告：在无 UI 的环境里 ask_user 弹不出对话框，只能回退成「写进回复等回答」，
白白消耗一轮迭代。要求：无对话框能力时**直接返回可读的问题清单**给 agent（并明确告知
「本环境无对话框，请把问题写进回复」），不要先尝试再失败。

### 3.8 测试切片的静默腐烂（reviewer 报告，约 18 处）

`test/extension-structure.test.ts` 里大量 `SRC.slice(at, at + N)` 魔法窗口：源码增长后窗口
会**静默停止覆盖目标**，测试照常通过。本轮已修 3 处（改为带守卫的结束锚点），reviewer 报告
同文件还有约 18 处同类无守卫切片。本轮一并清理。


## 4. 顺带清理（上一轮明确排除、本轮处理）

- `README.md:1361` 仍描述已失效的 tmux spawn 说明。
- `extensions/review-gate.ts:1900-1902` 等内部注释里的旧口径残留。
- ship 门禁未满足（2246）的 reason 现在十几行且嵌套仲裁说明 —— 按 O13 收敛。

## 5. 验证要求

- 新增逻辑纯函数化 + 单测（L5 统一判定函数、申诉配额与内容绑定、流式快照生成）。
- 现有测试全绿；改文案时同步 source-pin 测试（extension-structure / workflow-commands /
  loop-goal 等）。
- `npm run typecheck` + `npm test`。
- 走完整门禁流程；大任务按节切分多轮 checkpoint + review。
- 流式部分需人工可验证：说明在哪个工具、什么节奏能看到进度（用户会实际观察）。

## 6. 用户已拍板的决定（不必再问）

1. 三个 judge 工具一起改名，旧名删除，无兼容层。
2. `judge_wait` 返回值：完成 = 结论 + stdout 尾部；未完成/超时 = 当前进度（stdout 尾部 +
   findings 最近几条）。
3. 流式范围：上面 2.3 的 1-6 全做。
4. L5 全部硬标准；A 类开申诉口、B 类不开。
5. 申诉配额：每会话 3 次，内容绑定一次性。
6. 3.5 的循环阻塞必须解决 —— 不允许「唯一出路是用户跑 /gate-bypass」。
7. 3.6 ask_user 必须把问答内容写进 transcript（现在只写计数）。
8. 3.7 无对话框环境直接交还问题清单，不做无效尝试。
9. 3.8 清理 test/extension-structure.test.ts 里剩余约 18 处无守卫 slice 窗口。

## 7. 上一轮验证会话的实证结论（背景，不必复核）

一个小任务（修 2 条 P2 文案）跑完整新流程，结果：

- **流程本身跑通**：setup_workspace → ask_user → judge_submit(goal-auditor) → propose_loop_goal
  → 编辑 → judge_submit(reviewer) → declare_done，全部单一调用，无手写 git/等待脚本、
  无 sessionId 传递。
- **B5 修复实测有效**：sessionDir 稳定为 `.pi/judge-sessions/<role>-<repoHash>/`，同 role
  跨轮 resume 生效。
- **B2 机械裁决有效**：goal 审计一次 PASS（98s），无「打地鼠」重审。
- **L5 盲点是这轮实证发现并修掉的**：长英文 body 稀释中文主题行 → 已改为 subject 单独严格
  判定，两条路径共用。
- **暴露出 3.5 / 3.6 / 3.7 / 3.8 四个新问题** —— 即本轮任务。

其余细节按需用 `ask_user` 与用户敲定。

