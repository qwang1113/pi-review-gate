# 任务：pi-review-gate 门禁体系重构 —— 重门禁、轻 Agent

你在 pi-review-gate 仓库工作。工作区有一批**未提交的迁移改动**（tmux → `pi -p --session-id`
judge 子会话迁移，29 个已跟踪改动 + 3 个未跟踪新文件）——这是已完成并验证过的上一轮工作，
**不要回退**。你的任务是：按「重门禁、轻 Agent」哲学重构门禁体系。全程走 loop 门禁流程。

## 0. 总纲：重门禁、轻 Agent（用户设计哲学，一切改动的最高准则）

**用户原话**：整个门禁这一套都采用类似的东西——重门禁轻 Agent。门禁用来鞭策 Agent
按照我们规定的流程去执行；在这个范围之内，除了流程，门禁就不要管 Agent 的任何事情；
Agent 有事情可以按需去调用门禁提供的工具。

**推论**：
1. **流程性/状态性/生命周期性事务全部收归门禁**：judge 角色的创建/复用/销毁、工作区检查、
   分支管理、等待与唤醒、goal 流程、review 循环——都是门禁的机械职责（gate-state 记录 +
   工具拦截/注入 + 对话框保证）。
2. **Agent 只做两件事**：(a) 在流程范围内做创造性工作（写代码、改文档、决策）；
   (b) 按需无脑调用门禁工具（如 `judge_submit({role, task})`）。不自己管理 sessionId/目录/
   等待脚本/分支切换等任何流程细节。
3. **门禁不管流程之外的事**：agent 怎么写代码、怎么组织思路、用哪些 bash 命令——门禁不干预。
4. **工具设计**：参数只表达「提交给谁 + 审什么 / 确认什么」；返回「已受理 + 完成时唤醒」；
   绝不要求 agent 回传中间状态。

**O13（用户新增 · 沟通风格）**：全程沟通风格 = **高级助理**——言简意赅、不啰嗦、
但不弱智。适用于：agent 的所有输出（解释、总结、提问、findings 描述）、**agent 写的
代码和文档**（代码命名/注释/结构清晰直接，文档简洁不废话）、门禁的所有沟通（注入
文本、工具返回、对话框文案、block 原因、唤醒消息）。检查标准：一句话能说清的不说
两句；有信息量、无废话；不说教、不重复已知内容；用户介入点上的问题要清晰带选项和
推荐。落地：所有新增/修改的注入文本与工具返回按此风格写；既有啰嗦文案顺手收敛
（尤其 block 原因、goal 指令、等待纪律）。

**O14（用户新增 · 用户介入）**：**所有需要用户介入的地方，统一通过 `ask_user` 完成**
（用户要求：包括门禁和 agent 双方，约定目标、工作区确认、分支确认、冲突决策…）。
不限于「真正阻塞」才问。任何需要用户决策/信息/确认的节点（需求澄清、范围取舍、
交付方式、风险决策、冲突处理…），agent 都可以主动调 `ask_user` 让用户介入。
一个工具、一个入口：**调用即暂停**——门禁停下来等用户回答（1 个问题直接问，
多个问题逐个问完再一次性返回），答完恢复循环。门禁自身需要用户决策的对话框
（goal 批准、合并冲突等）也走 ask_user 的展示通道。

## 0.1 起点

1. `set_gate_mode("loop")` 并协商 loop goal（goal 草稿必须覆盖下面全部工作项）。
2. 工作区迁移改动是上一轮成果：先把它提交为基线（checkpoint），再开始你的修改。
3. 参考文档：`docs/e2e-findings-2026-08-29.md`（问题记录）、`docs/execution-model.md`、
   `docs/judge-protocol.md`（当前实现描述，改后要同步）。

## 1. 【核心重构，最高优先级】judge 角色生命周期收归门禁：单一提交工具

**目标形态**：
```
agent 唯一入口：judge_submit({ role: "reviewer"|"adviser"|"goal-auditor", task, fresh? })
门禁内部：
  ├─ sessionId / sessionDir 按 role+repoHash 稳定派生（根治 B5：当前按 title 漂移）
  ├─ 查该 role 的存活会话：有 → 复用（resume 续接同一段上下文）；无 → 创建
  ├─ 提交 task（@file）、注册进程 exit 监听（完成自动唤醒主会话）
  ├─ 返回：已提交 + 本次 run 的 stdout/exit-code 路径
  └─ 销毁（fresh:true / close / declare_done 收尾）也是门禁管
```

**judge_submit 是「提交-审计-记录」一体化入口（用户要求合并）**：
- goal 审计：agent 只需 `judge_submit({role:"goal-auditor", task:<完整 goal 草稿>})`——
  **prepare_goal_audit 与 record_goal_prereview 并入内部**。门禁：生成审计任务文本 →
  spawn/复用 auditor → 监听完成 → 机械解析 verdict → 直接记录 PASS/BLOCKED 到
  gate-state → 返回「审计结果：PASS/BLOCKED + findings 摘要 + 是否可 propose」。
  agent 不再单独调 prepare_goal_audit / record_goal_prereview。
- 代码审查：agent 只需 `judge_submit({role:"reviewer", task:<prepare_review 的任务文本>})`——
  **prepare_review 与 record_review 并入内部**。门禁：计算 review 目标（baseline..HEAD）→
  spawn/复用 reviewer → 监听完成 → 机械解析 verdict → 直接记录到 gate-state →
  返回「verdict：READY/BLOCKED + findings 摘要」。agent 不再单独调 prepare_review /
  record_review（这两个工具保留为纯内部函数，或降级为可选的高级入口）。
- 注意：record_review 现有的机械校验（无 prepare 拒绝 / HEAD 移动 STALE / cwd 校验 /
  tree 绑定）全部保留，只是移到 judge_submit 内部执行。

**目标审计也支持 findings 流（与 reviewer 一致）**：goal-auditor 在审计过程中发现
问题（如标准不可证伪、与仓库冲突）时，先流式追加到 findings 流文件，agent 可边读
边修草案；最终 verdict 到达后门禁机械裁决。

**提交一体化（用户进一步要求：减少 agent 工作量）**：`judge_submit({role:"reviewer", task})`
再进一步——**agent 改完代码只需调用一次提交审查**，门禁内部自动执行完整送审链：
```
agent：judge_submit({role:"reviewer", task:<本轮改动说明>})   ← 唯一入口
门禁内部自动：
  ├─ ① run_precommit（未跑或失败 → 打回 + 明确原因，不进入后续；
  │     **precommit 内部各小任务并行执行（用户要求）——任一任务出错 → 整个 precommit
  │     立即结束 → 整体打回**，不等待其余任务）
  ├─ ② review_checkpoint（precommit 过 → 自动提交为 checkpoint，英文 message
  │     校验失败也打回；**commit title 必须标明是 checkpoint**（如前缀 "checkpoint: "
  │     或 "chore(checkpoint): "，门禁校验并强制）；branchOps 记录 checkpoint_commit）
  ├─ ③ prepare_review（计算 baseline..HEAD + 任务文本）→ spawn/复用 reviewer → 监听
  └─ 返回：「已送审（checkpoint sha + range + findings 流路径）」或「被打回（原因）」
```
- `run_precommit` / `review_checkpoint` / `prepare_review` 变为门禁内部步骤（工具保留为
  可选高级入口，但标准流程 agent 不再单独调）。
- agent 的工作流因此变成：编辑 → judge_submit(reviewer) → （BLOCKED 就修 → 再
  judge_submit）→ READY → declare_done。提交/检测/送审的固定流程全部在门禁里。
- goal 审计同理已经是 judge_submit 一体化，不再重复。

**对现有工具的重构**：
- `review_spawn`（agent 传 title、自管复用）→ 并入 judge_submit 内部；title 不再是 agent
  关心的东西（内部按 role 派生，仅作显示名）。
- `review_send`（传 sessionId resume）→ 并入 judge_submit（同 role 再提交 = resume）。
- 等待：judge_submit 自动注册完成监听（完成即唤醒，agent 无需等待）；另保留
  `review_wait({ role/sessionId, timeout? })` 兜底工具（见 P1b）。
- `review_read({ role/sessionId })` / `review_close({ role/sessionId })` 按 role 定位，
  agent 不传 sessionId（或传也行，门禁解析）。
- **验收**：连续两次提交同一 role，第二次 jsonl 续接第一次（行数增长、含前文）；agent
  工作流中不再出现手写 kill -0/grep/sleep 等待脚本；主会话重启后同 role 会话仍可 resume。

**B5（必须随此修复）**：当前 `workDir = .pi/judge-sessions/rg-<title>`（title 每轮变）→
sessionDir 漂移 → pi resume 失效（实测第二轮 jsonl 从零开始）。sessionDir 改为按
role+repoHash 稳定派生（`.pi/judge-sessions/<role>-<repoHash>/sessions`），title 只用于
显示和 `runs/<ts>/` 命名。

## 2. 【机械裁决】goal-auditor「打地鼠」根治（B2）

根因：重审决策权在 agent 手里（agent 每轮采纳 P2 重审）。**门禁机械裁决，不是提示词劝说**：
- judge_submit(goal-auditor) 内部裁决：**只要没有 P0/P1，无论 findings 是什么级别
  （P2/Nit/建议…）都直接记 PASS**（用户要求：不只 P2）。返回文本机械声明：
  「PASS —— 含 N 条非阻塞 findings，P0/P1 才阻塞，禁止仅因非阻塞 findings 再审一轮」。
- 门禁记录同一 goal 的审计轮次；达上限（如 3 轮）后 READY+非阻塞 findings **强制放行**
  （findings 转交 reviewer）。
- P0/P1 未解决仍 BLOCKED（不变）。
- **judge 提示词同步（用户要求）**：所有审核角色（goal-auditor / reviewer / adviser）的
  提示词里尽量要求：**不要输出「READY 但带 P2/Nit findings」这种形态**——凡是不阻塞的
  问题（P2/Nit/建议）就不要写进 findings；写进 findings 的必须是阻塞项（P0/P1）。
  理由：(a) 裁决放宽后非阻塞 findings 只会增加噪音（仍要转交/处理）；(b) 防止 judge
  用 P2/Nit 逃避真正该说的 P1（降级标注）。口头建议/可选优化不占 findings 位，
  可放 notes 或直接不提。

## 3. 【门禁】工作区检查（需求 1）

会话开始（session_start / 首次进 loop）时**机械检测** `git status --porcelain`；
有未提交内容（含未跟踪）⇒ 阻塞 edit/write 工具（与 loop-goal 未批准同层），
必须先与用户沟通处置。

- 新工具 `confirm_worktree_baseline`：弹框列出脏文件清单，用户三选一：
  (i) 接受为本会话基线（agent 随后提交成 checkpoint，走 review 流程）；
  (ii) 已自行处理，重新检测（仍脏则不放行）；
  (iii) 丢弃——**门禁直接代执行**（如 `git checkout .` + 清理未跟踪，工具内部完成并复检），
  agent 不做 git 决策。
- **合并（用户要求）**：`confirm_worktree_baseline` 与 `setup_work_branch` **合并为一个工具**
  （名字可保留 confirm_worktree_baseline 或新名 setup_workspace）：
  - 调用时弹一组问题（走 ask_user 通道）：「脏文件三选一」+「基准分支确认」；
  - 用户选择完（无论选什么），门禁**自动执行后续 setup**（建工作分支、记 branchOps）；
  - agent 只调一次，不分成两步。
- 与现有 `hasCodeChange/hasDocChange`（arm ship gate）并存各司其职，不改旧逻辑；
  `request_scope_limit` 语义不变。

## 4. 【门禁】分支管理（需求 2）

规则：每次会话必须先确定工作分支；main/master → 先拉基准开发分支；非 main → 用户确认
「是否把当前分支作为基准」；会话基于基准拉工作分支；declare_done 时合并回基准；
**禁止会话直接 commit 当前分支**（防污染原改动）。

**实现（升级为门禁提供工具，agent 不手写 git 分支命令）**：
- gate-state 记录 `state.baseBranch` / `state.workBranch`；ship 门禁（commit/push）检查
  当前分支是否被授权。
- 新工具 `setup_work_branch`：内部检测当前分支——
  - 在 main/master ⇒ 返回指令/执行从 main 拉基准开发分支（门禁代执行或给出精确命令）；
  - 非 main ⇒ 弹用户确认框「是否把当前分支作为基准分支」；确认后从基准派生工作分支
    （名字如 `session-<短标识>` 或按 agent 提议），记录到 gate-state。
  - 未记录 workBranch 时 commit 门禁行为：fail-closed（阻塞并提示先 setup_work_branch）。
- declare_done：**门禁自动执行合并检查与合并**（用户要求：finish_work_branch 由门禁负责，
  agent 只调 declare_done）——见下「分支操作审计日志」与「合并与冲突」。
- 单分支/新仓库场景：提示从 main 派生工作分支即可，**不设 /tmp 豁免**（用户明确不要豁免，
  但流程要能走通单分支 repo）。

**分支操作审计日志（数据层面，用户重点要求）**：
gate-state 记录一个 append-only 的 `branchOps` 数组（或等价结构），**门禁在每次
分支/工作区操作时记录**，作为 finish 合并与 declare_done 的依据：
- `{ op: "checkout", from: "<原分支>", to: "<新分支>", at }` —— 会话开始不在基准分支、
  切到基准分支、从基准切到工作分支，每次切换都记。
- `{ op: "worktree_discard", files: [...], at, reason }` —— confirm_worktree_baseline
  选丢弃时记录丢了什么。
- `{ op: "checkpoint_commit", sha, branch, at, message }` —— 每个 checkpoint 落在哪条
  分支上。
- `{ op: "base_branch_set", branch, at }` —— 基准分支何时确定、从哪个分支来的。
- `{ op: "work_branch_set", branch, base, at }` —— 工作分支何时创建、基于谁。
- 目的：门禁随时知道「当前在哪条分支、从哪来的、动过什么」，finish 时据此把工作分支
  合并回**正确的原始分支**（可能是用户确认的基准分支，也可能用户后续改了基准）。

**合并与冲突机制（用户重点要求）**：
- declare_done 时门禁**自动**：检查 workBranch 相对 baseBranch 的差异 →
  `git merge-base --is-ancestor workBranch baseBranch` 已合并则直接通过；
  未合并则执行合并（`git merge --no-ff workBranch` 到 baseBranch 或按项目约定）。
- **冲突处理**：合并产生冲突时，门禁**不能自动解决**（不可逆破坏面）——
  机制：合并中止并**退回给用户/agent 修复**：
  - 门禁记录冲突状态（`mergeConflict: { branch, files: [...], at }`）到 gate-state；
  - declare_done 拒绝 + 明确指令：冲突文件清单 + 「修复后重试」；
  - agent 收到指令后解决冲突（创造工作，门禁不管怎么解）→ 重新 declare_done；
  - 或用户选择「本次不合并，直接完成」（逃生路径，理由留档），分支留在原地下次处理。
- 单分支/无分支场景：workBranch === baseBranch 时跳过合并。

## 5. 【门禁】`/gate-mode` 切 loop 的时序（B4）

`set_gate_mode` 工具与 `/gate-mode` 命令两条进入 loop 的路径，都执行：工作区检测 +
分支检测 + 目标协商注入。切到 loop 且无已批准 goal 时，注入「先走 judge_submit(goal-auditor) 审计 →
propose_loop_goal，批准前禁止编辑（edit/write 会被机械拒绝）」的指令。
注：`lib/loop-goal.ts` 的 LOOP_GOAL_MISSING_DIRECTIVE 措辞仍是 tmux（"tmux judge child"），
同步改为独立 pi 进程。

## 6. 【兜底工具】review_wait（P1b，含等待纪律提示）

1. 新工具 `review_wait({ sessionId/role, timeout? })`：内部三判据（进程退出 / exit-code 落盘 /
   stdout.log 明文 fence），任一命中返回；顺带返回已读结论（verdict fence / stdout 尾部）。
2. 同步阻塞式为主；tool 超时上限（5-10 分钟），超时返回当前状态让 agent 决定。
3. **等待纪律提示（用户要求）**：调用时若还有可做的确定性工作（代码/测试/文档/其他 repo
   事务），工具返回文本**机械提示 agent 先去做**，不傻等。
4. 教学文本更新：AGENTS.md / skills/review-loop/SKILL.md / docs/execution-model.md 从
   「手写 bash 三判据」改为「judge_submit 自动监听 + review_wait 兜底」；bash 判据仅留
   fallback 说明。注意 source-pin 测试（workflow-commands.test.ts 等）。
5. 判据逻辑纯函数化 + 单测（可注入 fake 进程/文件）。

## 7. 其他

- **B3（首轮 fence 未识别导致重复 spawn）**：被第 1 节吸收（门禁自己识别 fence、自己决定复用），
  不单独修；验收时回归确认不再重复 spawn。
- **B6（编辑锚点错）**：**不修**——编辑精度是 agent 创造能力范畴，门禁不管流程之外的事。
- **B7（precommit 配置）**：不修，符合设计。
- `docs/judge-protocol.md` / `docs/execution-model.md` / AGENTS.md 全文同步新架构与新工具。

## 8. 验证要求

- 新增逻辑有单测（gate-state 新字段、分支/工作区检测、review_wait 判据，纯函数化）。
- 现有 1558 测试保持全绿（提示词/文档改动有 source-pin 测试，改时同步）。
- `npm run typecheck`（tsc --noEmit）+ `npm test`（~90s，racily 测试别动）。
- 走完整门禁流程：checkpoint → judge_submit(reviewer)（一体化：prepare+record 内部）→ READY。
- 大任务切分多轮：每轮一个 checkpoint + 一次 review；按 0.6 的执行顺序推进。
- 完成后在 docs/e2e-findings-2026-08-29.md 追加「修复记录」段，逐条标注每个 bug/需求的处置。

## 9. 【全面审视发现 · 一并修改】按新哲学检查当前实现的不符之处

以下是在总纲框架下重新审视当前门禁实现（extensions/review-gate.ts + lib/*）发现
的「流程事务仍在 agent 手里」的具体点。与第 1-6 节合并为一份修改清单。

**A. 工具面 —— 流程编排在 agent 手里**
1. `prepare_review` / `prepare_adviser` / `prepare_goal_audit` 返回「操作说明书」：
   建议 title、教 agent 调 review_spawn、传什么参数、怎么处理提问、等待纪律——
   agent 要做多步编排。→ 重构：它们只返回任务文本 + 必要上下文（range/stream 路径/
   审计轮次），提交统一走 `judge_submit({role, task})`（第 1 节）；标题/sessionId/
   监听全部门禁内部。
2. `review_spawn` / `review_send` / `review_read` / `review_close` / `review_watch`
   五个工具要求 agent 传 sessionId/title/手动注册监听。→ 并入 judge_submit /
   review_read({role}) / review_close({role})；agent 不碰 sessionId 与目录。
3. 等待靠 agent 手写 bash（kill -0 + grep + sleep 三判据）。→ judge_submit 自动
   监听（完成即唤醒）；review_wait 兜底（第 6 节）。

**B. 注入面 —— 提示词劝说 vs 机械保证**
4. before_agent_start 的 Review Gate 注入块是「你 MUST (1) precommit (2) review
   (3) record_review (4) fix (5) declare_done」——顺序靠劝说。→ 机械保证盘点：
   review_checkpoint 已要求 precommit PASS（机械✓）；record_review 无 prepare 拒绝
   （机械✓）；declare_done 检查未满足项（机械✓）。**缺口**：precommit 未跑时
   review_checkpoint 的拒绝文案是否明确？「修完必须复审」是否有机械强制（BLOCKED
   后 declare_done 会被 unmet 拦，实际已机械）？逐条确认并补机械缺口，注入文本
   降为「说明当前状态」而非「教流程」。
5. 等待纪律文本（先做确定性工作、三判据）——机械化进 review_wait 返回（第 6 节）。

**C. 状态面 —— gate-state 缺口**
6. 缺 `baseBranch` / `workBranch`（需求 2，第 4 节）。
7. 缺 `worktreeDirty` + 基线确认状态（需求 1，第 3 节）。
8. 缺 goal 审计轮次记录（B2 机械裁决，第 2 节）。

**D. 执行面 —— agent 手写本应门禁管的事**
9. 分支操作：agent 手写 `git checkout -b` / `git merge` → 门禁提供
   setup_work_branch / finish_work_branch（第 4 节）。
10. goal 重审决策：agent 自己决定采纳 P2 重审 → 门禁机械裁决（第 2 节）。
11. 工作区丢弃：agent 手写 `git checkout .` → confirm_worktree_baseline 代执行
    （第 3 节）。

**复合检查补充发现（O1-O8，按最终流程的剩余教学/入口优化）**：
- O1：`lib/loop-goal.ts` 的 `LOOP_GOAL_UNCONFIRMED_EDIT_BLOCK` / `SHIP_BLOCK` 文案仍教
  agent「prepare_goal_audit + spawn + record_goal_prereview」三步 → 改为
  「judge_submit({role:"goal-auditor", task}) 一体化」。
- O2：`extensions/review-gate.ts` 约 1692 / 3955 行教学文本仍写
  「review_checkpoint → prepare_review → review_spawn → record_review」四步 → 改为
  「judge_submit({role:"reviewer", task}) 一体化」。
- O3：before_agent_start 的 Review Gate 注入块「(1) precommit (2) review (3) record_review
  (4) fix (5) declare_done」五步教学 → 改为「改完调 judge_submit(reviewer)；打回就修；
  READY 就 declare_done」。
- O4：goal 采访 N of M 的题号由 agent 自己数 → 门禁记录采访进度（已问 N 题），注入时提示
  （可选，低收益；采访内容本质是创造性的，门禁只管进度不管内容）。
- O5：`prepare_*` 三工具描述改为「内部由 judge_submit 调用；保留为高级入口」。
- O6：`review_*` 五工具描述改为「按 role 定位；judge_submit 内部使用」。
- O7：declare_done 增加 finish_work_branch 自动合并/冲突处理（第 4 节）。
- O8：run_precommit 描述注明「judge_submit 内部自动执行；仅需单独跑时用」。
- 注意：上述文案都有 source-pin 测试（extension-structure.test.ts / workflow-commands.test.ts
  / loop-goal.test.ts 等），改时同步。

**O9（用户新增）：goal 采访收归门禁——一次性收集问题，门禁逐个问用户，最后一次性丢回**
- 现状：agent 逐轮采访（每轮 pause_for_question 问 1 题 N of M），多轮往返，且依赖 agent
  记得用对工具。
- 目标：**agent 不逐轮采访**。流程改为——
  1. agent 起草 goal 草案 + **一次性提交候选问题清单**（`ask_user({questions})`）；
  2. **门禁逐个向用户弹问**（复用对话框机制，门禁自己管理 N of M 进度，agent 不参与，
     调用即暂停循环，答完恢复）；
  3. 用户答完所有问题后，门禁**一次性把全部答案注入/返回给 agent**；
  4. agent 基于全部答案修订 goal → judge_submit(goal-auditor) 审计 → propose_loop_goal。
- 门禁记录采访进度（已问 N 题）到 gate-state，会话中断可续。
- 若 agent 认为无需提问，可直接跳过问题清单（门禁不强制问）。

**O11（用户新增）：问问题机制全程通用，不止 goal 阶段**
- 用户指出：agent 不一定只在 goal 阶段问问题——执行中任何环节都可能问（需求歧义、
  设计取舍、发现矛盾、需要用户决策）。
- 所以 O9 的 `submit_goal_questions` 泛化为**通用问题提交机制**，最终命名为 `ask_user`：
  - agent 在**任何阶段**都可调用（goal 采访、实现中、修复 findings 时、合并冲突决策…）；
  - 门禁逐个向用户弹问（管理 N of M 进度，记到 gate-state，中断可续）；
  - 用户答完 → 门禁一次性返回全部答案给 agent；
  - 单个紧急问题也可（questions 数组长度 1 即可）。
- **`submit_questions` 与 `pause_for_question` 合并为一个工具 `ask_user`（用户要求）**：
  agent 只有一个提问入口。语义：`ask_user({ questions: [...] })`——
  **调用即暂停（用户要求）**：只要调用了 ask_user，门禁就暂停循环等用户回答，
  不区分「阻塞/不阻塞」——问题已经抛给用户，agent 不该继续往下跑：
  - 1 个问题 → 显示问题、暂停循环、等用户回答（等价旧 pause_for_question）；
  - 多个问题 → 门禁逐个弹问（管理 N of M 进度）、全部答完才一次性返回全部答案、
    恢复循环；
  - 门禁根据 questions 数量决定展示方式，agent 不需要知道细节，也不需要 blocking 参数。
  - **用户可中途跳过剩余问题（用户要求）**：多个问题逐个展示时，用户回答完一个/几个后
    觉得后续问题没必要，可直接跳过后面的（门禁提供跳过入口）。跳过后，已回答的答案
    照常一次性返回，未答的标记为跳过。
  - **分多轮问（用户要求）**：如果需要用户先选范围、再根据选择问针对性问题（如先选
    架构 A/B、再问该架构的细节），agent 应**分多轮调 ask_user**——第一轮问范围，拿到
    答案后再组织第二轮针对性问题。此提示写进 ask_user 的工具描述。
- `pause_for_question` 工具删除（被 ask_user 吸收）。
- goal 采访 = ask_user 的一个用例（阶段 4），不是唯一用例。

**O12（用户新增 · 哲学）：需求采纳前的「澄清 → 反述 → 确认」协议**
- 用户原话：向会话描述需求时，背景不应该是按自己的理解直接更新需求，而是先尝试理解
  需求，看有没有没理解到的；有就通过问问题澄清到无疑点；准备采纳时先反述需求，让用户
  有一个确认过程。
- 规则（门禁注入流程保证，作为常驻指令）：
  1. **先理解，不直接采纳**：用户提出需求后，agent 不得直接按自己的理解开始实现/更新
     goal——先尝试理解，找出疑点（范围、边界、交付方式、约束、未说清的术语）。
  2. **有疑点 → 问**：用 `ask_user`（O11）一次性提交问题清单澄清，直到无疑点。
  3. **采纳前反述**：准备采纳需求时，先**反述**（复述你理解的需求：目标、范围、交付物、
     非目标），让用户确认。
  4. **用户确认后才采纳**：反述获用户确认后，才正式采纳（进入 goal 协商 judge_submit /
     开始实现）。用户对反述提出修正 → 修正后再反述确认。
- 落地：注入到系统提示（与 O10 决策表同一常驻块），并体现在 goal 协商指令里
  （propose_loop_goal 前的采访/反述环节）。
- 注意：这是「需求理解」的流程保证——门禁注入规则、检查行为（如 agent 未澄清直接
  propose goal 时，提示先澄清/反述），但问题的具体内容仍是 agent 创造。

**O10（用户新增）：保证 agent 行动前先判断有没有可调的工具**
- 现象：agent 想问用户时先直接输出 → 会话停掉 → 门禁拉起 → agent 才想起来调
  pause_for_question → 又拉一次。浪费一次循环。
- 目标：**agent 在做出任何「会结束本轮」的动作前，先对照工具决策表**。
- 机制（门禁注入，agent 无法绕过）：
  1. **决策表注入系统提示**（before_agent_start 常驻）：一张「情况 → 工具」表——
     - 要问用户/等用户回答 → `ask_user`（不是直接输出）
     - 要提交审查 → `judge_submit({role:"reviewer"})`
     - 要审计 goal → `judge_submit({role:"goal-auditor"})`
     - 决定不了 → `judge_submit({role:"adviser"})`
     - 脏工作区 → `confirm_worktree_baseline`；分支 → `setup_work_branch`
     - 任务完成 → `declare_done`
     - 需要用户授权（敏感文件/范围/合并冲突）→ 对应 request_* / declare_done 内处理
  2. **结束前检查提示**：注入「在你结束本轮（输出最终文本）之前，先检查：是否有应调
     未调的工具（问用户= ask_user，提交= judge_submit…）？有则先调。」
  3. agent_settled 拉起时若检测到「上次是直接输出结束且 gate 未满足」，注入提醒
     「如果你本来要问用户，应调 ask_user 而不是直接结束」。
- 决策表作为**单一常驻注入**（lib/ 下一个常量），与现有指令合并，避免臃肿。

**验收总则**：修改后，agent 的典型 loop 工作流应该是（详见第 10 节）——
set_gate_mode → confirm_worktree_baseline（脏时）→ setup_work_branch →
goal 协商 → judge_submit(goal-auditor)（一体化）→ propose_loop_goal → 编辑 →
judge_submit(reviewer)（提交一体化：precommit→checkpoint→送审→记录）→ declare_done
（门禁自动 finish_work_branch）。
每一步都是单一工具调用，无多步编排、无手写 git/等待脚本、无 sessionId 传递、
无 prepare/record 分离调用。

## 10. 【目标态工作流 · 从提需求到任务结束】验收参照

改完之后，一个典型任务从「用户提需求」到「任务结束」的完整过程。每一步都是**单一
门禁工具调用**，门禁机械保证流程，agent 无编排。这是第 1-9 节改动的总体验收参照。

### 阶段 0：会话启动（门禁自动）

1. **门禁检测工作区**（session_start）：`git status --porcelain`。脏 → 记
   `worktreeDirty`，edit/write 被拦，提示先沟通处置。
2. **门禁检测分支**（session_start）：记录当前分支；main → 记「需建基准」；
   非 main → 记「待确认基准」。**同时记入 branchOps：`{op:"checkout", from:null, to:<当前分支>}`**。

### 阶段 1-3：开局对齐（3 个工具 + O12 需求澄清协议）

```
用户：实现 xxx 功能
agent：先理解需求（不直接采纳）→ 有疑点用 ask_user 澄清 → 无疑点后反述需求 → 用户确认
agent：set_gate_mode("loop")                    ← ① 分类（门禁注入工作区/分支状态）
agent：setup_workspace()                        ← ② 合并工具（confirm+setup）
       弹一组问题（走 ask_user 通道）：
       - 脏文件三选一（基线/已处理/丢弃）
       - 基准分支确认
       用户选择完 → 门禁自动执行（建工作分支、记 branchOps.base/work_branch_set、
       checkout、worktree_discard 视选择而定）
```

### 阶段 4：目标协商（2 个工具，采访收归门禁）

```
agent：起草 goal 草案 + 一次性提交候选问题清单（若有）
  → ask_user({questions})                       ← ③（可选；无疑问可跳过）
门禁：逐个向用户弹问（门禁管理 N of M 进度，agent 不参与）
  → 用户答完 → 门禁一次性把全部答案返回给 agent
agent：基于答案修订 goal
judge_submit({role:"goal-auditor", task:<goal 草稿>})    ← ④ 一体化
  门禁内部：prepare_goal_audit 生成任务 → spawn/复用 auditor → 监听
    → auditor 发现问题先流式 findings，agent 可边读边修草案
    → 完成 → record_goal_prereview 机械解析（无 P0/P1 直接 PASS；auditor 提示词
      要求不输出「READY+非阻塞 findings」形态）
    → 返回「PASS/BLOCKED + findings 摘要」
  BLOCKED → agent 修草案 → 再 judge_submit（门禁记轮次，达上限强制放行）
propose_loop_goal(goal)                         ← ⑤ 弹框，用户批准 → 写 loop-goal.md
```

### 阶段 5：实现（agent 自由创造）

```
agent：编辑（门禁只拦：未批 goal/敏感文件/非英文标签/未确认工作区/非 workBranch commit）
```

### 阶段 6-7：提交与审查（1 个工具，全自动）

```
judge_submit({role:"reviewer", task:<本轮改动说明>})    ← ⑥ 提交一体化
  门禁内部自动：
    ├─ run_precommit（未跑/失败 → 打回 + 原因；内部小任务并行，任一出错整体打回）
    ├─ review_checkpoint（过 → 自动提交 checkpoint；英文校验 + title 必须标明
    │   checkpoint，记 branchOps）
    ├─ prepare_review（算 range）→ spawn/复用 reviewer → 监听
    │    → reviewer 流式 findings，agent 边读边修
    └─ record_review 机械解析（STALE/cwd/tree 绑定）
    → 返回「已送审 / 打回（原因）」或「READY/BLOCKED + findings」
  BLOCKED → 修 → 再 judge_submit；READY → declare_done
```

### 阶段 8：任务结束（1 个工具，门禁自动收尾）

```
declare_done()                                  ← ⑦
  门禁内部自动：
    ├─ 全门禁复检（review READY + precommit PASS + goal 批准）
    ├─ finish_work_branch 自动执行：
    │    ├─ 查 branchOps 知道基准分支与工作分支
    │    ├─ 已合并（merge-base --is-ancestor）→ 通过
    │    ├─ 未合并 → 门禁执行合并（--no-ff 到基准）
    │    │    ├─ 无冲突 → 合并完成 → 通过
    │    │    └─ 冲突 → 中止 + 记 mergeConflict → 拒绝 + 冲突文件清单
    │    │         → agent 修复冲突（或用户确认「本次不合并」留档）→ 重试
    │    └─ workBranch===baseBranch（单分支）→ 跳过合并
    └─ 全部通过 → 任务结束
```

### 按需工具（不在强制流程里，agent 遇到时调用）

- **adviser 咨询**（用户明确：按需，非强制）：agent 遇到自己决定不了的事
  （需求歧义、设计取舍、跨域风险）→ `judge_submit({role:"adviser", task:<咨询问题>})`——
  一体化：门禁生成 brief → spawn/复用 adviser → 监听 → 返回结论。结论进 adviser 结论
  文件（增量咨询基线沿用）。
- `ask_user({ questions })`：**全程通用提问**（O11/O14）——任何阶段需要澄清/决策/用户
  介入时都可调用（需求澄清、范围取舍、交付方式、风险决策、冲突处理…）。
  **调用即暂停**：门禁停下来等用户回答——1 个问题直接问；多个问题逐个弹问、答完
  一次性返回；全部答完恢复循环。goal 采访是它的一个用例。
- `review_read({role})`：随时查 judge 状态/输出（不等待，快照）。
- `review_wait({role, timeout?})`：兜底等待（正常流程 judge_submit 已自动唤醒，
  仅在需要阻塞拿结果时用；返回含等待纪律提示）。

### 关键特征（验收点）

1. **6 个强制工具调用点**（① ② ④ ⑤ ⑥ ⑦；③ ask_user 可选），全部单一调用
   无编排；adviser/review_read/review_wait 是按需的。（②=setup_workspace 合并了
   confirm+setup）
2. **agent 全程不出现**：手写 git 分支/合并/丢弃命令、kill -0/grep/sleep 等待脚本、
   sessionId/title 传递、prepare/record 分离调用。
3. **门禁数据面完整**：branchOps 审计日志 + worktreeDirty + baseBranch/workBranch +
   goal 审计轮次 + mergeConflict——门禁随时知道「从哪来、到哪去、动过什么」。
4. **乱序被机械拦**：无 checkpoint 不能 prepare（judge_submit 内部）、非 workBranch
   不能 commit、未合并/冲突未解不能 declare_done。
5. **O10 决策表**：agent 系统提示常驻「情况 → 工具」决策表（要问用户=ask_user、
   提交=judge_submit、决定不了=adviser、完成=declare_done…），结束本轮前先对照；
   门禁拉起时也会提醒「是否本来该调工具」。
6. **agent 自由空间**：阶段 5 完全自由；goal 内容、commit message、findings 修复方式。
7. **用户介入点**：提需求、工作区三选一、基准分支确认、goal 批准、合并冲突时的决策
   （修复或跳过）。
8. **O13 沟通风格**：全程（agent 输出 + 门禁注入/返回/对话框）高级助理风格——
   言简意赅、不啰嗦、不清淡；用户介入点上的问题清晰带选项和推荐。
