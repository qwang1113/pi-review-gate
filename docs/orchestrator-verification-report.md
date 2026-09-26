# 编排验证报告（orch-f3eb4277-mugy6j3o，2026-09-26）

本轮编排共有 12 个任务：5 个独立修复任务（l1 / h1 / j1 / n1 / s1），以及 7 个大文件拆分任务（p1–p7）。本报告只做**记录**，报告中的缺陷一律没有在本轮修复，修复状态逐条标注。

来源：
- `.pi/orchestrator-pm-notes.md`（项目经理笔记，未提交）；
- 各子会话 transcript（`~/.pi/agent/sessions/*/…rg-child-<任务 id>-*.jsonl`）中最后一次 `declare_done` 的 summary；
- p7 在真实会话中自己观察到的现象（来源标注为 **p7**）。

每条缺陷的写法固定为：**现象 / 出现步骤 / 影响 / 建议 / 修复状态**。几个任务报的是同一个根因时合并成一条，并在「来源」里列出全部出处；这样的条目只写在第一次出现的那一节，其余小节只写一个指针。

PR 一览：l1 [#81](https://github.com/qwang1113/pi-review-gate/pull/81)（已合并）、h1 [#80](https://github.com/qwang1113/pi-review-gate/pull/80)（已合并）+ [#82](https://github.com/qwang1113/pi-review-gate/pull/82)（open）、n1 [#83](https://github.com/qwang1113/pi-review-gate/pull/83)（open）、j1 [#84](https://github.com/qwang1113/pi-review-gate/pull/84)（open）、s1 [#85](https://github.com/qwang1113/pi-review-gate/pull/85)（open）、p1–p7 为分支 `refactor/split-large-libs` 上开出的 PR（链接见 PR 本身）。

## 独立 loop 路径（l1）

**任务结果**：会话崩溃后，未命名会话遗留的专属 tmux session 现在会在下次启动时被回收。`openScopeWindow` 写入 `@rg_scope_owner_pid` / `@rg_scope_owner_pane`，`sweepOrphans` 新增 `sweepUnnamedScopes`；只有全部事实都成立（owner 派生出的名字相符、pid 已死、pane 已不在、没有被 pin）才执行 kill，被继承的 session 会打上 `@rg_scope_pinned` 保护。已在私有 tmux server 上做过真实验证。PR [#81](https://github.com/qwang1113/pi-review-gate/pull/81)，**已合并**。

**L1-1 异步 precommit 消息的轮号标错**（来源：l1）
- 现象：第 2 轮内容的全量 precommit FAIL 消息标的是「第 1 轮」；后来重记的 PASS / READY 也写「round 1」。
- 出现步骤：`judge_submit` 旁路的全量 precommit lane 回报时，以及被扣下的 READY 重记时。
- 影响：agent 无法把结论对应到自己提交的那一轮，容易误判哪一份内容失败了。
- 建议：lane 消息与重记文案一律用发起时绑定的 `roundSeq` 和树哈希，不要读当前计数。
- 修复状态：未修。

**L1-2 迟到的 FAIL 杀掉下一轮 reviewer，措辞看不出针对哪次提交**（来源：l1；与 j1-4 相关）
- 现象：第 1 轮 lane 的 FAIL 到达时，第 2 轮已经派出，结果第 2 轮的 reviewer 被杀；消息里看不出它说的是哪一次提交。
- 出现步骤：连续两次 `judge_submit` 之间，前一轮 lane 仍在跑。
- 影响：浪费一轮 reviewer，agent 还要花时间反推原因。
- 建议：lane 取消只作用于和它绑定同一内容的那一轮；消息里写明提交哈希。
- 修复状态：未修。

**L1-3 `copilot_review` 对本 repo 返回 off**（来源：l1(3)、h1(5)、j1(5)、PM#2 的后半）
- 现象：任务要求跑 Copilot 审查循环，`copilot_review` 却报「off for this repo/mode」。
- 出现步骤：PR 开出后，子会话调用 `copilot_review` 时。
- 影响：站点为 `pr` 的任务无法完成任务书里写的这一步，只能如实说明。
- 建议：off 的原因（仓库能力 / 编排子会话 / 模式）要在回执里写明；如果编排子会话是有意关闭的，任务书模板里就不应再要求这一步。
- 修复状态：未修。

## 交接修复（h1）

**任务结果**：空白交接（补充段仍是占位）会被拒绝，拒绝时不开任何 pane；交接文档新增「前任最后的用户消息（原文）」一节；接任会话第一次 `declare_done` 会被拒一次，并附上前任最后的用户消息。跟进 PR 让 `lastUserMessages` 跳过门禁自己的注入（`[REVIEW_GATE_*]` / `[ORCHESTRATION*]` / `THINKING_LOOP_INJECTION`）。已用隔离 agent 目录在真实会话中验证。PR [#80](https://github.com/qwang1113/pi-review-gate/pull/80)（**已合并**）+ [#82](https://github.com/qwang1113/pi-review-gate/pull/82)（open）。

**H1-1 交接文档里的 transcript 指针指向不存在的文件**（来源：h1(1)，p7 复现）
- 现象：`ownTranscriptPath` 拼出的是 `<dir>/<id>.jsonl`，而实际文件名是 `<时间戳>_<id>.jsonl`。
- 出现步骤：`session_handoff` 生成骨架文档时（「前任 transcript」一行）。p7 在 main 与本分支上都复现了：文档写的是 `…/01a0deb4-77e1-….jsonl`，磁盘上的文件是 `2026-09-26T17-12-44-258Z_01a0deb4-77e1-….jsonl`。
- 影响：接任者照着指针 grep 找不到文件；「有问题自己 grep」这条建议因此失效。
- 建议：用 pi 给出的 `PI_SESSION_FILE`（或在目录里 glob `*_<id>.jsonl`），不要自己拼路径。
- 修复状态：未修（#80 已合并，但 main 上仍复现）。

**H1-2 70% 交接提醒要求 judge / worker 写补充段**（来源：h1(2)）
- 现象：judge / worker pane 没有 edit/write 工具，70% 提醒却要它们去填补充段。
- 出现步骤：judge / worker 的上下文用量越过 70% 时。
- 影响：提醒要求的动作根本做不到，只会误导。
- 建议：提醒文案按会话类型区分，judge / worker 不提补充段。
- 修复状态：未修。

**H1-3 全量 precommit 尚未落盘时，`git push && gh pr create` 被拦**（来源：h1(3)）
- 现象：本轮全量 precommit 还在落盘，合并在一条命令里的 push + 开 PR 被拦，理由是「precommit has not run」。
- 出现步骤：review READY 之后立即 ship。
- 影响：agent 必须拆开命令再重试；文案「has not run」与事实（正在跑）不符。
- 建议：lane 在跑时文案改成「precommit 正在跑，等它落盘」，并给出可以阻塞等待的工具。
- 修复状态：未修。

**H1-4 非最后任务的验收方案被静默跳过**（来源：h1(4)、j1(1)、s1(a)、PM#2）
- 现象：`RG_ACCEPTANCE_GATE` 只对 plan 的最后一个任务写 `on`；其他子会话 goal 里经过用户批准的「真实验收方案」，到 `declare_done` 时被跳过，没有任何提示。
- 出现步骤：非最后任务的 `declare_done`。
- 影响：批准过的验收契约变成一纸空文，只能靠 PM 逐个提醒子会话手动去跑（h1、s1 都是这样做的）。
- 建议：goal 里写了验收方案就照跑；或者在 goal 协商阶段就告诉子会话「本任务不设验收关卡」，让验收方案不进入 goal。
- 修复状态：未修。

**H1-5 `copilot_review` off** —— 见 L1-3。

**H1-6 门禁注入与真实用户消息无法区分**（来源：h1(6)）
- 现象：transcript 里门禁通过 `sendUserMessage` 注入的内容和用户原话混在一起，把用户的话挤出了交接文档。
- 出现步骤：`session_handoff` 收集「前任最后的用户消息」时。
- 影响：接任者看到的是门禁提示，而不是用户的要求。
- 建议：按标签族过滤（#82 的做法）。
- 修复状态：**已在 PR #82 修复**（open，未合并）。

**H1-7 judge 模型 fallback 提示也以用户消息注入，未被过滤**（来源：h1 补记，quality P2）
- 现象：「（门禁自愈 · 模型 fallback）」同样作为用户消息注入，#82 的过滤没有覆盖它。
- 出现步骤：judge 切换模型之后。
- 影响：与 H1-6 相同，只是范围较小。
- 建议：给它加上同一个标签族前缀，或者纳入过滤列表。
- 修复状态：未修。

**H1-8 `pi -e` 无法把门禁单独隔离出来；子会话派出的 judge / worker 跑的是主仓代码**（来源：h1(7)、s1(e)、j1 验收 C 段）
- 现象：`pi -e <path> --no-extensions` 仍会加载 settings 里的 packages；在 worktree 分支上起的子会话，派出的 judge / worker 加载的是主仓 build，不是 worktree 分支的代码；接力的接任者以裸 `pi` 启动。
- 出现步骤：验收 worktree 分支的门禁改动时。
- 影响：分支改动没法通过自身的派发实测；h1 与 p7 只能另建一个 `PI_CODING_AGENT_DIR`，j1 的验收 C 段干脆没有跑。
- 建议：派发 judge / worker / 接任者时带上当前会话实际加载的扩展路径；或者提供一个官方的「以某个 checkout 为门禁源」开关。
- 修复状态：未修。

## 审计卡死修复（j1）

**任务结果**：共享的 `.pi/judge-hierarchy.json` 改为三方合并，并在 pid 锁下写盘（`lib/judge-hierarchy-store.ts`），先登记、后开窗；门禁在自己等审计期间每 2s 刷新一行进度（含 `<session>:<window>`），审计者提问时转给用户，没等到裁决时分类说明原因（`lib/audit-wait-watch.ts`）。6 进程并发写同一个文件的真实脚本：新代码 0 丢失，旧代码多处丢条目。PR [#84](https://github.com/qwang1113/pi-review-gate/pull/84)（open）。

**J1-1 非最后任务的验收方案被跳过** —— 见 H1-4。

**J1-2 tmux 授权被锁死后没有能生效的授权路径；代答被打断即记为拒绝**（来源：j1(2)、PM#5）
- 现象：PM 代答 j1 的 tmux 授权时，同一时刻发出的 steer 打断了子会话的对话框；门禁把 `request-settled by "interrupted"` 当成拒绝并锁死后续申请。之后 PM 口头「已批」也无效，只能由用户手动 `/gate-grant`。
- 出现步骤：`request_tmux_access` → `orchestrator_answer` 与 `orchestrator_instruct(steer)` 几乎同时发生。
- 影响：一次时序意外就永久锁死了一类操作，子会话只好放弃真实验收的一部分。
- 建议：「被打断」应让请求重新挂起，而不是记为拒绝；被锁死时回执要写明唯一可行的出路。
- 修复状态：未修。

**J1-3 审计 FAIL 回执里的 findings 流路径不存在**（来源：j1(3)、s1(b)、p6、p1、p7 复现）
- 现象：`propose_loop_goal` 审计 FAIL 时，回执写的是 `.pi/review-stream/goal-<hash>.jsonl`，这个文件在磁盘上不存在，findings 只能去 `.pi/review-gate-state.<variant>.json` 的 `goalPrereview.findings` 里读。p1 的 reviewer 报告写「findings 1 条」，对应的 `.pi/review-stream/review-muij1nug-review.jsonl` 同样不存在。p7 第一次 goal 审计 FAIL 时也复现了（`goal-c266b6c53730.jsonl` 不存在）。
- 出现步骤：goal 审计 FAIL 回执；reviewer 报告的 findings 指针。
- 影响：agent 看不到被打回的原因，只能去翻内部状态文件，违背哲学一。
- 建议：回执里直接内联 findings 原文；或者保证指针指向的文件确实写了盘。
- 修复状态：未修。

**J1-4 precommit 失败反复取消 `judge_submit`，质量轮前两轮被腰斩**（来源：j1(4)；与 L1-2 相关）
- 现象：连续两轮 lane FAIL，按取消矩阵杀掉 reviewer，质量轮也没能出结论。
- 出现步骤：`judge_submit` 并行三方。
- 影响：符合设计，但开销很大（模型费用 + 时间）。
- 建议：lane 在短时间内就 FAIL 时（t8 已处理「派发前 FAIL」的情况），可以考虑推迟质量轮，等 lane 先过。
- 修复状态：未修（属于设计取舍，只记录）。

**J1-5 Copilot 循环关闭** —— 见 L1-3。

**J1-6 审计窗口 prefix+s 看不到**（来源：j1 ③、PM#4 的后半）
- 现象：审计进行中，用户按 prefix+s 看不到审计窗口。j1 推测是：最后一个窗口被回收时 session 被连带回收，事后又被重建。
- 出现步骤：plan submit 等待审计期间。
- 影响：用户无法确认审计是否还活着。
- 建议：进度行写明 `<session>:<window>`（#84 已做）；侧边栏可以直接列出（#85）。
- 修复状态：现场证据丢失，**未确认根因**；#84 与 #85 提供了缓解，均为 open。

## 通知时效（n1）

**任务结果**：同一时刻最多只有一条监督通知在途；`orchestrator_wait` 阻塞期间通知让位；通知在送达（`message_end`）那一刻按通道 / plan / registry 的现状改写正文，已销账或已关闭的子会话不会再被提起。新增纯函数模块 `lib/orchestration-notice.ts`，另有一个真实 `AgentSession` 宿主测试。PR [#83](https://github.com/qwang1113/pi-review-gate/pull/83)（open）。

**N1-1 quality-auditor 报「范围标记缺失」**（来源：n1(1)）
- 现象：quality-auditor 自报的审查范围没有带范围标记。
- 出现步骤：质量轮交卷。
- 影响：结论不受影响，但记录的可追溯性变差。
- 建议：交卷 schema 里把范围标记设为必填，缺了就当场退回。
- 修复状态：未修。

（n1 自报的第 (2) 条已确认属于正常路径、不是缺陷，不列入。）

## tmux 侧边栏（s1）

**任务结果**：prefix+e 打开 / 关闭侧边栏，按「等你回答 / repo / 会话 / judge 窗口 / 其他」分组展示，支持键盘和鼠标跳转。每个 pi 会话每 5s 把 `@rg_sid/@rg_repo/@rg_kind/@rg_state/@rg_state_at` 写到自己的 pane 上。专属 session 改名为 `rg-<repo>-<role>-<tail>`，窗口名改成可读形式。已在真实 tmux 3.7c 的测试 session 上验证（没有碰 session 0，也没有碰真实的 `~/.tmux.conf`）。PR [#85](https://github.com/qwang1113/pi-review-gate/pull/85)（open）。

**S1-1 验收方案被静默跳过** —— 见 H1-4。

**S1-2 goal 审计 findings 只能从 state 文件读** —— 见 J1-3。

**S1-3 同一条消息里并行发出的 edit 没进 checkpoint**（来源：s1(c)、p5）
- 现象：同一条 assistant 消息里同时发出 edit 和 `judge_submit`，edit 在 checkpoint 之后才落盘。
- 出现步骤：送审时。
- 影响：多出一轮只改文档的审查。
- 建议：`judge_submit` 在做 checkpoint 之前，先等同一批次里其他工具调用结束；或者直接拒绝与写工具并行的 `judge_submit`。
- 修复状态：未修。

**S1-4 /tmp scratch 仓库里的 `git commit` 被 ship 门禁拦下**（来源：s1(d)，p7 复现）
- 现象：在 `/tmp` 临时仓库里执行 `git init && … git commit`，被当成会话仓库的 ship 命令拦下。p7 复现时，整条复合命令（其中还有 `git archive`、软链、写 settings 等与会话仓库无关的步骤）一步都没有执行。
- 出现步骤：真实验收时准备临时仓库。
- 影响：验收脚本只能绕开 commit（p7 最后用了没有 commit 的空仓库）。
- 建议：ship 门禁先解析命令的实际 cwd / `-C` 目标，不属于会话仓库的直接放行。
- 修复状态：未修。

**S1-5 子会话派发的 judge / worker 跑的是主仓代码** —— 见 H1-8。

## 项目经理路径（p1–p7）

**任务结果**：在分支 `refactor/split-large-libs` 上，把 5 个超过 600 行的大文件按职责拆成 12 个模块。代码逐字搬迁（各任务都用 diff 核对过），不留转发层，调用方直接改 import，`docs/module-map.md` 同步更新（§5 = 248 个模块）：

| 原文件 | 拆分后 |
| --- | --- |
| `lib/orchestrator-registry.ts`（777） | `orchestrator-registry.ts`（527）+ `orchestrator-registry-normalize.ts`（260） |
| `lib/session-factory.ts`（768） | `session-factory.ts`（541）+ `session-env.ts`（156）+ `session-launch-specs.ts`（83） |
| `lib/orchestrator-plan.ts`（753） | `orchestrator-plan.ts`（519）+ `orchestrator-plan-progress.ts`（259） |
| `lib/orchestrator-session-tools.ts`（711） | `orchestrator-session-tools.ts`（191）+ `orchestrator-wait-tool.ts`（372）+ `orchestrator-close-tool.ts`（160） |
| `lib/user-interaction-tools.ts`（703） | `user-interaction-tools.ts`（259）+ `ask-user-interview.ts`（467） |

p1–p5 每个任务拆一个文件；p6 收尾时审核整个 `main..HEAD`，修掉陈旧的注释指针，并删除一个死掉的 re-export。每个任务都拿到了 reviewer + quality READY，全量 precommit 均为 PASS。p7 只做真实验收并交付，本 PR 即交付物。

### p7 真实验收（本分支 vs main 对照）

环境：
- 两个临时 agent 目录 `/tmp/p7acc/agent-{branch,main}`：除 `settings.json` 以外全部软链到 `~/.pi/agent`；`settings.json` 里 `extensions` 分别只放本分支的 `extensions/review-gate.ts` 和 main（`0189b01`，用 `git archive` 导出到 `/tmp/p7acc/main-src`）的同名文件，`packages` 只留 `npm:pi-anthropic-oauth`。
- 两个空的临时 git 仓库 `/tmp/p7acc/repo-{branch,main}`，分别在独立 server `tmux -L rg-p7` 的两个 session 里起 `PI_CODING_AGENT_DIR=… pi --thinking low`，启动前 unset 掉本会话所有 `RG_*` / `PI_SESSION_*` / `TMUX*` 变量。
- 用 `send-keys` 下发同一份指令，工具返回值从两个会话的 transcript 里原样抽取。

| 步骤 | 覆盖的拆分模块 | 本分支 | main | 结论 |
| --- | --- | --- | --- | --- |
| `set_gate_mode orchestrator` | — | `gate mode set to "orchestrator"` | 相同 | 一致 |
| `orchestrator_plan write` + `read` | plan / plan-progress / registry / registry-normalize | 写入 `.pi/orchestrator-plan.json`，摘要、站点、「未获批准」均正确；read 读回同一份内容 | 相同；两份 plan JSON 去掉路径和时间戳后逐字节相同 | 一致 |
| `name_session` 登记 | session-name-tools / session-registry | `p7-probe-branch 已登记`，写入 `rg-sessions/*.json` 与 window title | 相同 | 一致 |
| `name_session` 撞名 | 同上 | 拒绝并点名占用者（repo / 状态 / 心跳 / pid） | 代码逐字相同（见 P7-1） | 一致 |
| `ask_user` 缺 recommended | ask-user-interview | 「第 1 个问题没有 recommended」，整批拒绝，不弹框 | 逐字相同 | 一致 |
| `ask_user` 正常对话框 | ask-user-interview / user-interaction-tools | 弹出 `A. alpha（推荐） / B. beta / ✎ 不选，我说明原因`，选 B 后返回 `→ B. beta` | 逐字相同 | 一致 |
| `session_handoff`（补充段为占位） | session-handoff / session-env / session-factory | 生成骨架文档（标题：接手后第一件事 / 当前契约 / 未完成的工作 / 前任最后的用户消息（原文）/ 前任补充），拒绝交接、不开 pane | 骨架去掉路径、session id 和本轮提示原文后逐行相同 | 一致 |
| `orchestrator_wait timeoutMs:0` | wait-tool | 五块回执齐全 | 逐字相同（见 P7-3） | 一致 |

结论：拆分覆盖到的真实路径，行为和 main 完全一致；两边唯一的差异是各自的路径和 session id。验收结束后已 `tmux -L rg-p7 kill-server`，名字登记随进程退出自动腾出，没有碰默认 server 与用户的 session 0。

**P2-1 并发会话覆盖共享登记表，`judge_conclude` 报「登记表里没有本 review」**（来源：p2(1)、PM#4）
- 现象：两个 judge pane 两次报告登记表里没有本 review，而条目其实在文件里；同一 checkout 里的另一个会话把 `.pi/judge-hierarchy.json` 整份覆盖或删除了。PM 这边表现为 plan 审计交卷被拒、submit 只显示 Working，超时后也说不清原因。
- 出现步骤：judge 交卷；plan submit 审计。
- 影响：审计卡死，结论丢失。
- 建议：合并写 + 锁（#84 的做法）。
- 修复状态：**由 PR #84 修复**（open）。

**P2-2 测试注释仍指向旧文件**（来源：p2(2)）
- 现象：`test/orchestrator-plan-approval.test.ts:597`、`test/worker-tools.test.ts:626` 的注释仍然指向 `lib/orchestrator-registry.ts`。
- 出现步骤：拆分之后。
- 影响：读代码的人会被带到错误的文件。
- 建议：在收尾任务里统一修掉。
- 修复状态：**已在本分支修复**（p6，`cebc4be`，随本 PR 交付）。

**P3-1 非本会话写的未跟踪文件被计入本会话指纹**（来源：p3(1)、PM#8）
- 现象：PM 写在主仓 `docs/` 下的未跟踪笔记，在 p3 审查期间有变动；p3 的指纹因此对不上，被扣下的 READY 作废，只能靠 `request_scope_limit` 解围。
- 出现步骤：子会话与 PM 共用同一个 checkout 时，judge 结论落盘前后。
- 影响：一次有效的 READY 被浪费，还需要用户介入。
- 建议：指纹排除 PM 放行的汇报文档；或者让 PM 的文档默认落在 `.pi/`（PM 已手动挪过去）。
- 修复状态：未修（已用把笔记移到 `.pi/` 的方式规避）。

**P3-2 两份报告对被扣 READY 的说法矛盾**（来源：p3(2)）
- 现象：reviewer 报告说「挂起的 READY 已作废，重送一轮即可」，同一时刻的 quality 报告却说「这一步就是补记它的时刻」。
- 出现步骤：指纹不符之后。
- 影响：agent 不知道该重送还是该等。
- 建议：两份报告的这段文案由同一个函数按同一份事实生成。
- 修复状态：未修。

**P5-1 并行 edit 没进 checkpoint** —— 见 S1-3。

**P6-1 goal 审计 findings 流路径不存在** —— 见 J1-3。

**P7-1 改名撞上活着的占用者时，旧名字已经被腾出**（来源：p7，新观察）
- 现象：已经叫 `p7-probe-branch` 的会话调用 `name_session p7-probe-main`（被另一个活会话占用），回执是「已被别的活会话占用……请另选一个名字。（旧名字 p7-probe-branch 已腾出）」。于是会话变成**没有名字**；另一个会话紧接着就拿走了 `p7-probe-branch`。
- 出现步骤：`name_session` 改名；`lib/session-name-tools.ts` 先 `releaseInternal()` 再 `claimName()`。
- 影响：一次失败的改名让会话丢掉原来的名字，发给 `@旧名` 的消息也随之失效。main 上是同一段代码（不是拆分引入的）。
- 建议：先判断新名字能不能拿到，再腾出旧名字；拿不到就保留旧名字。
- 修复状态：未修。

**P7-2 plan 未获批准且没有子会话时，续跑提示连推 10 次**（来源：p7，新观察）
- 现象：只写了 plan、没有 submit 时，门禁连续注入 `[ORCHESTRATION_RESUME]`（1/10…10/10），之后又来一次 `[REVIEW_GATE_REVIVE]`。每次给出的三个下一步（spawn / 处理子会话 / `orchestrator_wait`）都做不了。main 上也一样。
- 出现步骤：PM 模式下写完 plan、提交之前结束 turn。
- 影响：白白消耗上下文和模型费用，agent 每次都只能回一句「什么都没做」。
- 建议：plan 未批准时，续跑提示的下一步应当指向 `propose_restatement` / `orchestrator_plan submit`；已经明确在等用户时不再续跑。
- 修复状态：未修。

**P7-3 没有任何子会话时，`orchestrator_wait` 的标题却写「子会话的 pane 已经消失」**（来源：p7，新观察）
- 现象：还没 spawn 过任何子会话，`orchestrator_wait({timeoutMs:0})` 的标题是「子会话的 pane 已经消失（异常退出或被用户关掉）」，而健康快照写的是「没有存活的子会话」、死亡段写的是「没有 dead」。main 上也一样。
- 出现步骤：PM 在 spawn 前调用 wait。
- 影响：标题与正文自相矛盾，容易误导 PM 去 recover 一个不存在的子会话。
- 建议：零子会话时用单独的标题（例如「还没有子会话」）。
- 修复状态：未修。

**P7-4 单任务 plan 的唯一任务被标成「独立验收任务（push → 开 PR）」，而站点是 precommit**（来源：p7，新观察）
- 现象：plan 只有 1 个任务、交付站点是 `precommit`，摘要里仍然给它挂上「plan 的最后一环 = 独立验收任务（真实验收 → push → 开 PR）」。
- 出现步骤：`orchestrator_plan write/read` 的摘要。
- 影响：提示与站点矛盾，在小 plan 里显得多余。
- 建议：只有站点为 `pr` 且任务数 ≥ 2 时才挂这条注记，或者注记里按站点改写。
- 修复状态：未修。

**P7-5 tmux 放行提醒里仍写「只允许在约定的那一个 window 内 split」**（来源：p7，新观察）
- 现象：已授权的 `tmux kill-server` 之后，提醒写的是「编排只允许在用户与你约定的那一个 window 内 split」；但 2026-09-25 起子会话住在 opener 懒建的专属 session 里，已经不再 split 用户的 window。
- 出现步骤：`request_tmux_access` 授权后执行 tmux 命令时。
- 影响：文案过时，会误导人对编排落点的理解。
- 建议：同步成专属 session 的说法。
- 修复状态：未修。

（p7 复现的另外三条已并入 H1-1、J1-3、S1-4。p4 自报无缺陷。）

## 项目经理自身观察

以下内容来自 `.pi/orchestrator-pm-notes.md`「缺陷（PM 视角）」与「PM 复验发现」。

**PM-1 空白交接后，接任者直接收工**（来源：PM#1）
- 现象：前任 PM 没写补充段就调了 `session_handoff`；文档只列了旧 plan（全部 done），开场提示又说「plan 做完就可以 declare_done」，接任 PM 没有核对 transcript 就收工了。
- 出现步骤：PM 接力。
- 影响：用户的新要求丢失。
- 建议：拒绝空白交接，并把用户最后的原话带给接任者。
- 修复状态：**由 PR #80（已合并）+ #82（open）修复**，p7 在两边都实测到了空白交接被拒。

**PM-2 非最后任务的验收关卡被静默跳过；`copilot_review` off** —— 见 H1-4 与 L1-3。

**PM-3 过期通知反复注入、积压**（来源：PM#3）
- 现象：请求已经销账、子会话也已关闭，「子会话需要你」仍然反复到达。
- 出现步骤：PM 的监督定时器往 steer 队列里塞通知。
- 影响：浪费 PM 的上下文，还可能让 PM 去处理早已解决的事。
- 建议：同一时刻只留一条在途，送达时再复核内容（#83 的做法）。
- 修复状态：**由 PR #83 修复**（open，合并后生效）。

**PM-4 plan 审计卡死** —— 见 P2-1（登记表覆盖）与 J1-6（窗口看不到）；「审计者提问后没人能答、submit 只显示 Working」由 #84 的 `audit-wait-watch` 修复（open）。

**PM-5 代答被打断即记为拒绝** —— 见 J1-2。

**PM-6 plan 审计与 set-status 回执过长**（来源：PM#6）
- 现象：每次 `set-status` 都回显整份 plan，连同全部任务书。
- 出现步骤：PM 推进任务状态时。
- 影响：大量消耗 PM 的上下文，逼它更早交接。
- 建议：`set-status` 只回显变更的那一行，以及接下来可以派发的任务。
- 修复状态：未修。

**PM-7 独立 PR 的 worktree 要 PM 手工准备**（来源：PM#7）
- 现象：独立 PR 的任务要放进单独的 worktree，PM 只能手工执行 `git worktree add`，再自己播种 `node_modules` 与 `.pi` 配置；门禁的播种只在 spawn 自动建 worktree 时才发生。
- 出现步骤：plan 里多个 repo 目录指向同一个仓库的不同 worktree 时。
- 影响：违背哲学一，漏播种会让子会话读到错误的 precommit 配置。
- 建议：plan 任务允许声明「独立分支 / 独立 PR」，由 spawn 负责建 worktree 并播种。
- 修复状态：未修。

**PM-8 PM 写的汇报文档污染子会话门禁** —— 见 P3-1。

**PM-9 `orchestrator_wait` 漏掉 done 事件**（来源：PM#9）
- 现象：p6 在等待窗口内报了完成，但 900s 的 wait 直到预算用完才返回，回执写「没有新事件」，健康快照却已经显示「已完成」；随后才收到注入的完成通知。
- 出现步骤：PM 阻塞等待期间。
- 影响：PM 白等 15 分钟。
- 建议：wait 的新事件判定不要被后台定时器抢先消费。
- 修复状态：疑似由 PR #83 修复（n1 已定位到定时器抢事件），**待合并后验证**。

**PM-10 子会话没传 message 时，门禁派生的 checkpoint 标题不合规**（来源：PM 复验）
- 现象：s1 的提交标题是从任务文本里拼出来的，例如 `chore: Round 1 of s1-tmux-sidebar …`、`chore: Round 3 fixes both round-2 reviewer P1s:`，不是合格的 Conventional Commits 主题。
- 出现步骤：`judge_submit` 省略 `message` 时的 checkpoint。
- 影响：history 可读性差，PR 里还要人工整理。
- 建议：派生标题只用固定的缺省主题，不截取任务文本；或者把 `message` 设为必填。
- 修复状态：未修。

## 附：pm-notes 逐条核对

pm-notes 共 39 条缺陷记录：子任务摘要 29 条（l1 3、h1 8、p1 1、p2 2、p3 2、p5 1、p6 1、n1 1、j1 5、s1 5），PM 复验 1 条，PM 视角 9 条。p4 自报「无」，不计。上面共 39 条逐一有对应条目，同源合并后是 27 个独立条目；另有 p7 自己观察到的新条目 5 个（P7-1…P7-5），外加 3 条复现（已并入 H1-1、J1-3、S1-4）。n1(2) 已经自证不是缺陷，不在上述计数内。
