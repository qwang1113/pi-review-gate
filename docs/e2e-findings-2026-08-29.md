# E2E 验证发现的问题清单（process-based judge 迁移）

> 日期：2026-08-29 · 验证方式：`/tmp/rg-e2e-test` 独立仓库 + tmux 新会话 +
> `pi install /Users/qwang/workspace/pi-review-gate`（本地路径）+ `/gate-mode loop` +
> 实际需求「给 todo app 加 toggleTodo 功能」。
>
> 结论先行：**新架构（`pi -p --session-id` judge 子会话）端到端跑通了完整门禁流程**
> —— goal 预审（4 轮审计收敛）→ 用户批准 → 编辑 → precommit PASS →
> checkpoint → reviewer READY（6/6 标准 MET、0 findings）→ declare_done。
> 以下问题按严重度排列，供下一轮修复。

---

## P1 — 托管等待的 jsonl-fence 判据永不触发（转义盲区）

**现象**：主会话的托管等待脚本用 `grep -q '"gate":"READY"' "$SD"/sessions/*.jsonl`
判断 verdict 是否已出现。实测 **grep 永远匹配不到**——jsonl 是单行 JSON，fence 文本
在 JSON 字符串里被转义为 `\"gate\":\"READY\"`，字面 `"gate"` 不存在于原始字节中。
（python 解析 jsonl 后能看到 fence，但 grep 不能。）

**证据**：4 个 goal-auditor + 1 个 reviewer 的 jsonl 全部 `grep -c '"gate":"READY"' = 0`，
但 python 解析最后一条 assistant 消息 `has_fence=True`（行 22，628 chars）。

**影响**：
- 托管等待的三判据里「jsonl 出现 verdict fence」这一条**形同虚设**，只能靠
  (a) 进程退出和 (b) 静默超时兜底——正好退化成旧 tmux 时代「信号可能不来」的
  问题形态，只是换成了「fence 判据看不见」。
- 主会话最终能拿到 verdict 是因为脚本同时 `tail stdout.log`（fence 在 stdout 里），
  但**等待循环提前结束的能力**被削弱：judge 已输出 fence 但进程未退时，主会话
  会一直等到进程退出，而不是在 fence 出现时立刻结束等待。

**修复方向**：
1. 托管等待脚本改用 `python3 -c` 解析 jsonl（或 grep 转义后的 `\\\"gate\\\"`）；
2. 或 `review_read` 提供「读最新 fence」的机械入口，主会话用它而非手写 grep；
3. 更好：等待判据直接盯 **stdout.log 尾部**（fence 在 stdout 里是明文，grep 有效），
   因为 fence 输出即完成语义上等价。

---

## P2 — goal-auditor「打地鼠」：P2 findings 触发无限重审倾向

**现象**：goal 草案审计了 4 轮才收敛。前 3 轮 goal-auditor 都返回
`{"gate":"READY","findings":[{"severity":"P2",...}]}`——按协议 **READY 且无 P0/P1
即应通过**，但主会话**主动采纳每个 P2 建议、修改草案、重新审计**，直到第 4 轮
`findings:[]` 才 propose。主会话自己在思考里说「审计员每轮都能找到一个 P2，我
在打地鼠」。

**影响**：
- 每轮重审 = 一次完整的 judge 进程 spawn + 模型调用（~40-50s），4 轮 goal 审计
  花了 ~3 分钟，其中大部分是被 P2 驱动的重审。
- 有收敛风险：如果 goal-auditor 每轮都能提出新的 P2（草案越改越细，挑剔空间
  越大），理论上可能不收敛。本次靠「P2 建议空间有限」自然收敛，但无机制保证。

**根因（待确认）**：`record_goal_prereview` 的判定逻辑——READY 带 P2 findings
是否被机械记录为 PASS？还是主会话被 findings 字段的存在误导、自行决定重审？
需要看 `record_goal_prereview` 的解析（P0/P1 未解决 ⇒ BLOCKED；P2 应不阻塞）。

**修复方向**：
1. 确认 `record_goal_prereview` 对「READY + P2 findings」的记录语义——若已是 PASS，
   则是主会话行为问题（提示词应告诉它 P2 不必阻塞、可一次性采纳或明确拒绝）；
2. 在 goal 协商提示词里加「P2 findings 可选采纳，不必每轮重审；README 级建议
   可合并进草案一次吸收」；
3. 或设 goal 审计轮次上限（如 3 轮后 READY+P2 即提交批准，findings 留给 reviewer）。

---

## P2 — 首轮 goal-auditor 的 fence 未被主会话识别（重复 spawn）

**现象**：第一个 goal-auditor（`rg-goal-audit-b07fc9`）exit 0，stdout.log 里有
完整 READY fence（含 2 个 P2），但主会话**没有用它的输出**，而是重新 spawn 了
`rg-goal-audit-56a279`（新 session 目录）。

**推测原因**（未完全确认）：b07fc9 的 fence 出现在 stdout.log；主会话当时可能在
等 jsonl fence（P1 的转义问题）→ 等不到 → 判定「无结论」→ 重开。也就是说 P1
直接造成了这次重复 spawn。

**影响**：浪费一次完整 judge 运行（~50s + token）。若 P1 修复（判据能看见 fence），
此问题大概率随之消失。需在修复后回归确认。

---

## P2 — `/tmp` 会话强制 loop 后，goal 编辑门禁的生效时序

**现象**：`/gate-mode loop` 后，代理在**目标批准前**就尝试编辑（写了 toggleTodo，
还写错了位置——插进了 listTodos 函数体）。编辑实际被门禁拦下（代理随后转入 goal
协商），但**代理先试了**，且它的编辑尝试污染了工作区（todo.ts 被改坏），后续
修复又花了一轮。

**影响**：
- 符合预期的部分：编辑最终被拦（`loop mode requires an approved loop goal`），
  L8 门禁机械生效。
- 不符合预期的部分：代理在 loop 未决时**没有被系统提示充分阻止**去尝试编辑——
  它先思考了 set_gate_mode(normal/explore) 的路径豁免，然后收到 `/gate-mode loop`
  后直接动手，直到工具被拒才回头走 goal 流程。提示词对「loop 未决时禁止编辑」
  的强调可能不足，或 `/gate-mode loop` 切换后缺一次「现在进入 loop，先协商目标」
  的注入。

**修复方向**：确认 `/gate-mode` 切换到 loop 时是否注入目标协商指令；若无，补一个
「mode 切换为 loop ⇒ 下一 turn 提示先走 prepare_goal_audit 流程」的注入。

---

## P3 — 编辑错误位置（toggleTodo 插进 listTodos 函数体）

**现象**：代理第一次写 toggleTodo 时，把它插到了 `listTodos` 的 `return` 语句
之后、函数收尾 `}` 之前（TS1184 语法错误），自己发现后修复。

**性质**：这不是门禁问题，是模型编辑精度问题（`insert` 锚点选错）。旧架构下
同样会发生。列为观察项，不阻塞。若高频出现可考虑在 edit-discipline 提示里加强
「插入前确认锚点在函数体外」。

---

## P3 — precommit 需要手动配置 typecheck 步骤

**现象**：测试仓库无 package.json，`run_precommit` 初始为 NO_CHECKS_RUN，代理
手动配置了 `.pi/review-gate.json` 的 typecheck 步骤（`tsc --noEmit --strict`）
后才 PASS。

**性质**：符合设计（precommit 按项目配置），QUICKSTART 有 `/gate-init` 向导。
代理能自助完成，不算缺陷。记录为「E2E 中代理正确使用了配置机制」。

---


## P2-4（2026-08-29 实测发现）：judge 跨轮 resume 未生效 —— sessionDir 按 title 派生，与稳定 session id 不一致

**现象**：goal-auditor 第二轮审计 spawn 了新目录（`rg-goal-audit-6285aa`），其 session
jsonl 文件名为 `..._rg-goal-auditor-f3eb4277.jsonl`（与第一轮同名，session id 稳定），
但**内容从零开始**（18 行 vs 第一轮 48 行，前 3 行 hash 不同）——没有延续第一轮的上下文。

**根因**：`extensions/review-gate.ts:2967` —— `workDir = .pi/judge-sessions/rg-<title>`，
title 每轮不同（`rg-goal-audit-bbbff5` / `rg-goal-audit-6285aa`）→ sessionDir 每轮不同。
而 session id 是 `rg-goal-auditor-<repoHash>`（稳定）。pi 的 resume 语义要求
**session-dir + session-id 都稳定**才续接同一 jsonl；sessionDir 不稳定 ⇒ 每轮都是新会话。

**影响**：
- 「judge 上下文跨轮复用」（执行模型核心承诺）**实际未生效**——每轮审计/复审都从零
  读任务、重复读协议，token 浪费 + 审计变慢（首轮 593s 与此有关）。
- E2E 中「P2-2 首轮 fence 未识别导致重复 spawn」与此同源：即使 fence 识别正常，
  上下文也没在复用。

**修复方向**：sessionDir 改为按 **role+repoHash** 稳定派生（与 session id 一致），
如 `.pi/judge-sessions/<role>-<repoHash>/sessions`；title 只用于显示和 runs/ 目录命名
（每轮 `runs/<ts>/` 已有区分，不会串）。同时 review_spawn 的复用命中条件（现有
`c.role === role && c.sessionId === sessionId`）已正确，但需要让 sessionDir 匹配。

---

## 验证充分性说明（哪些已验证 / 未验证）

**已验证**：
- ✅ goal-auditor / reviewer 均以独立 pi 进程 spawn（`.pi/judge-sessions/rg-*/`，
  非 tmux pane），session id 确定性派生
- ✅ judge 完成 = 进程退出（exit-code 落盘），托管等待三判据（kill -0 + jsonl +
  stdout tail）实际运转
- ✅ verdict fence 从 stdout 读取成功，record_review 绑定 commit tree 生效
  （READY + commitSha 64b1263b + docSync UPDATED）
- ✅ propose_loop_goal 对话框带「goal-auditor 预审: PASS」标记，Yes 后写 loop-goal.md
- ✅ checkpoint 提交（英文 Conventional Commit）→ prepare_review → reviewer READY
  → declare_done 全链通过
- ✅ 无 tmux 依赖：整个 E2E 的 judge 子会话都是纯进程，主会话在 tmux 里只是
  「用户界面」角色

**未验证**（后续轮次补充）：
- ❌ judge 提问（question fence → 主会话 resume 回答）—— 本次 goal-auditor 和
  reviewer 都没提问
- ❌ 跨主会话 resume（主会话重启后同 session id 续接）—— 本次没触发重启
- ❌ `fresh: true` 杀旧进程、多 repo 并发 judge
- ❌ BLOCKED 路径（reviewer 出 BLOCKED → 修复 → 复审）—— 本次 reviewer 直接 READY
- ❌ `review_send` resume 语义（进程退出后同 id 带新消息）—— 本次没用它

---

## 修复记录（2026-08-29，「重门禁、轻 Agent」重构）

逐条对应上面的问题。「机械」= 门禁自己做，不再依赖 agent 记得做。

| 编号 | 处置 | 落在哪 |
| --- | --- | --- |
| P1 jsonl-fence 判据永不触发 | **已修**：判据改看本轮 `stdout.log`（fence 在那里是明文），三条判据（进程退出 / exit-code 落盘 / stdout 明文 fence）做成纯函数 `evaluateJudgeWait`，并由新工具 `review_wait({role})` 在门禁里跑——agent 不再手写 bash 三判据 | `lib/judge-lifecycle.ts`、`review_wait` |
| P2 goal-auditor「打地鼠」 | **已修（机械裁决）**：`adjudicateGoalAudit` 一条规则——无 P0/P1 即 PASS，不论 findings 是 P2/Nit；返回文本明说「禁止仅因非阻塞 findings 再审一轮」，并显示**本 goal 的**审计轮次（`goalAuditRound`，批准或新会话后归零）。三个 judge 的提示词同步要求 findings 只写阻塞项 | `lib/judge-lifecycle.ts`、`agents/*.md`、`docs/judge-protocol.md` |
| P2 首轮 fence 未识别导致重复 spawn | **已随 P1/B5 消失**：结论只从本轮 stdout 读，且 sessionDir 稳定后同一 role 一直是同一段会话；另外「同 role 进程仍在跑」现在是**明确拒绝本轮**，不会再出现「以为没结论就重开一个」 | `dispatchJudgeRound` |
| P2 `/tmp` 会话切 loop 后编辑时序 | **已修**：`set_gate_mode("loop")` 与 `/gate-mode loop` 两条路径都会记录工作区与分支状态；未确认的脏工作区与未批准的 goal 一样机械拦截 edit/write | `recordSessionStartWorkspace`、`loopGoalEditBlockFor` |
| P3 编辑锚点错 | **不修**（用户明确）：编辑精度属 agent 能力，门禁不管流程之外的事 | — |
| P3 precommit 需手动配置 | **不修**：符合设计（按项目配置，`/gate-init` 有向导） | — |
| P2-4 judge 跨轮 resume 失效（B5） | **已修**：workDir 改为按 role+repoHash 稳定派生（`.pi/judge-sessions/<role>-<repoHash>/`），title 只用于显示与 `runs/<ts>/`；`review_send` 的 resume 走同一条派生。实测同一 role 第二轮续接同一 jsonl（22 → 25 行） | `judgeWorkDirFor`、`dispatchJudgeRound` |

同轮一并落地的用户需求（不在上面的 bug 列表里）：

- **`judge_submit` 单一入口**：agent 只说「交给谁 + 审什么」，门禁管 sessionId /
  目录 / 复用 / 监听 / 记录。reviewer 的一次调用内跑完 precommit → checkpoint →
  prepare → 送审，任一步失败带原因打回；judge 退出时门禁自己记录 verdict。
- **`ask_user` 单一提问入口**（取代 `pause_for_question`）：调用即暂停，门禁逐题
  弹框、管 N / M 进度、支持「跳过后续」与「改在聊天里答」，答完一次性返回；
  中断可续问；没有对话框的环境如实把问题交还给 agent。
- **工作区与分支收归门禁**：`setup_workspace` 一次调用敲定脏工作区（三选一，
  丢弃由门禁代执行）与基准/工作分支；`branchOps` 审计日志让 `declare_done` 知道
  把哪条分支合回哪里；冲突则中止、记录、交还。
- **precommit fail-fast**：任一检查失败立刻终止其余检查（每个 step 独立进程组，
  杀得干净），被中止的 step 报 `skip` 而不是 `fail`。

