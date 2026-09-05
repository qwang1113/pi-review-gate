---
name: orchestrating-child-sessions
description: 项目经理（orchestrator）编排子会话时的三处已实测陷阱——子会话拿到 READY 后的任何一次编辑（含仓库外的完成报告）都会把门禁打回 PENDING，PM 据此误判「它没收尾」并催它重做；fileBoundaries 漏掉沿转发链路的间接注入面；orchestrator_plan 对已存在 task id 的 note 更新被静默丢弃。在 set_gate_mode("orchestrator") 之后写 plan 之前加载；子会话报告完成而门禁显示 PENDING 时加载；准备用 orchestrator_instruct 催子会话返工前加载。
---

# 编排子会话

三条都来自 2026-09-05 的真实编排轮次，每条都带可自查的现场证据。它们的共同形状是：**门禁的读数与现实之间隔着一层**，照读数直接行动会做出错误的指令。

## 1. 子会话说收尾了，门禁却显示 PENDING —— 先查三项，再开口

子会话报告「已收尾」，PM 去看门禁却是 `review: PENDING` / `precommit: NOT_RUN`，于是读成「它根本没通过审查」，用 `orchestrator_instruct` 催它重做——而子会话真去重做时，门禁自己会拒绝它。**这是一次「照门禁说的做反而出事」**。

**触发源不是 `declare_done`。** `declare_done`（`extensions/review-gate.ts:5800` 起）会复检每一道门禁、清掉本任务的轮次与续跑预算、写下 completion 记录——但它**不碰 `state.review` / `state.precommit`**，也就是不动裁决本身。真正把 READY 打下去的是**拿到 READY 之后的任何一次编辑**——`invalidateBindings`（`lib/gate-state.ts:428`）自述得很清楚：

> Content-change invalidation — the **ONE place** a session's own edit downgrades standing bindings. READY → PENDING and PASS → NOT_RUN, and the fingerprint goes with the verdict.

它的三处调用点（`extensions/review-gate.ts:3508` / `:3562` / `:3690`）全是编辑路径：编辑工具的跨 repo 分支、同 repo 分支，以及从 bash 侧观察到文件变化的兜底。

**而编辑追踪不区分 repo 内与 repo 外**，这是让 PM 最容易误判的一环：子会话拿到 READY 后**只写一份仓库外的完成报告**，`invalidateBindings` 照样触发，门禁读数瞬间变成「从没通过的样子」。

### 识别法：三项一起看

判定「通过之后被一次编辑打下去」而不是「从未通过」，查这三项，全中即是前者：

1. `lastReadyReview.treeOid` 与当前 `git rev-parse HEAD^{tree}` 一致；
2. `checkpoint.sha` 与当前 `HEAD` 一致；
3. 工作区干净（`git status --porcelain` 无输出）。

sidecar 在 `.pi/review-gate-state.<child-task-id>.json`。三项全中，就**不要催重做**——那一轮的成果是有效的。

### 实证

2026-09-05，子会话 `t3a-audit-round-engine` 拿到 READY 后只编辑了仓库**外**的 `/tmp/pm-rounds/child-report-03a.md`（`git status` 全程干净），`declare_done` 即被拒，理由是「code review gate is PENDING (need READY)」「precommit has not run」。

当时的 sidecar 里 `review` 看着**自相矛盾**：`verdict: "PENDING"`，却带着只有 `verdict === "READY"` 分支才会写入的 `commitSha` 与 `docSync`，`fingerprint` 被清空；同一份 sidecar 的 `rounds` 数组如实记着那一轮 `"verdict":"READY"`。`precommit` 同样被降级（`verdict: "NOT_RUN"` 却带着 `at` / `mode` / `testScope`）。原始记录：`/tmp/pm-rounds/child-report-03a.md:196-200`。

**这个「矛盾」恰恰是 `invalidateBindings` 跑过的指纹**：它只改 `verdict` 与 `fingerprint` 两个字段，READY 分支写下的其余字段原封不动地留在原地。所以看到「PENDING 却带着 `commitSha`」时，答案不是「记录坏了」，而是「它曾经 READY，被一次编辑降级了」——这本身就是识别法的第四个佐证。

**决定性反证（可在本仓库直接自查）**：同一份 sidecar `.pi/review-gate-state.t3a-audit-round-engine-mtnk0tlj.json` 现在的读数是 `completion.at = 2026-09-05T01:15:48Z`（`declare_done` 成功）、`rounds.length = 0`（预算被清空），而 `review.verdict` 仍是 `READY`（`at` 为 01:15:32）、`precommit.verdict` 仍是 `PASS`（`at` 为 01:15:02）。**一次成功的 `declare_done` 之后，READY 与 PASS 都原样站着** —— 它清的是轮次预算，不是裁决。所以「declare_done 会重置门禁」这个说法是错的，别照它排查。

**恢复办法：跑一轮「纯重新绑定」。** 被这个坑打中时不需要重做任何工作——工作区内容没变，缺的只是绑定。`t3a-audit-round-engine` 就是这么脱身的：仓库零改动（`HEAD` 仍是 `8a007c1`、`git status` 干净、测试与上一次 READY 逐字节相同）的情况下重跑一次 `judge_submit`，01:15:02 拿回 `PASS`、01:15:32 拿回 `READY`，01:15:48 `declare_done` 成功。**PM 该给的指令是「重新绑定」，不是「重做」。**

（那个自相矛盾的中间态本身**不可原地复现**了——它已被后来这轮重新绑定覆盖，只留在同期记录 `/tmp/pm-rounds/child-report-03a.md:196-200` 里。仍可自查的残留是该 sidecar 的 `sessionEditedFiles` 至今列着 `/tmp/pm-rounds/child-report-03a.md`，这是「repo 外的编辑也被算作编辑」的直接证据。）

**同一现象的第二个、更容易自查的实例**：写这条 skill 的会话（`t3b-skills-writeup-r2`）只用编辑工具在 `$TMPDIR` 下建了一个探针文件，它的 sidecar `sessionEditedFiles` 里就出现了 `/tmp/pm-rounds/evidence/t3b/insert-probe.ts`——一个**完全不在仓库里**的路径，照样被算作「本会话的编辑」并触发降级。

### 对子会话的操作含义：把报告排进时序

完成报告按定义只有拿到 READY 之后才写得完整，而「写报告」这个动作本身会打掉刚拿到的 READY。可行的顺序只有一个：

```
写完报告 → 之后不再碰任何文件 → 跑最后一轮 review → 拿到 READY → 立刻 declare_done
```

任何仓库外的副作用（删全局文件、写 /tmp 产物）都要**排在最后一轮 review 之前**做完。PM 给子会话下任务书时就把这个时序写进去，别等它踩了再解释。

## 2. 划 fileBoundaries 时，顺着转发链路多找一层

`fileBoundaries` 要覆盖的不只是「实现这个功能的文件」，还有**内容会被原样转发给 agent 的文件**——它们是注入面，改了工具行为却没改它们，注入文本就会和现实脱节。

### 实证

`prepare_review` 等 `prepare_*` 不是注册给 agent 的工具，但它们的**拒绝文本被 extension 原样拼进给 agent 的回复**：

- `extensions/review-gate.ts:4125` — `"review-gate: 本轮未送审 — prepare_review 被拒。\n" + toolText(prepared)`
- 同类还有 `:4082`（precommit 未过）与 `:4107`（checkpoint 被拒）

所以 `lib/review-prepare-tools.ts`、`lib/advisory-prepare-tools.ts` 属于注入面。2026-09-05 的一份 plan 第一版就漏掉了它们，被 plan 审计员报 **P1**。`test/extension-structure.test.ts` 里那条「every tool name in agent-readable text is a tool that EXISTS」的测试把这层写进了注释，并明说「narrowing the scan is not an available fix」。

### 同一条的第二个形态：文档里逐项枚举目录内容的表格

一张**把目录内容一项项列出来**的表也是边界的一部分：往那个目录里加东西，同一次改动里就得更新它，否则留下陈旧枚举。实例（2026-09-05）——`docs/module-map.md` 的 `skills/` 行原本只列 `skills/review-loop`，新增 skill 目录时必须同步改它。

**但不是每张枚举表都欠你一次同步。** 先分清两类，否则你会把边界划得比实际大：

| | 策展式速查表 | 全量表 |
|---|---|---|
| 自我声明 | 不声称穷举 | 明写「全量」，常带一条**自检指令** |
| 同步责任 | 无 | 有，新增/删除必须同轮改 |
| 判法 | 数一下覆盖率 | 把它自己的自检指令跑一遍 |

**实证（2026-09-05，同一个仓库里的一正一反）**：一份任务书只点名了 `docs/module-map.md` 的 `skills/` 行，而实际存在三处枚举：

- `README.md:1964`（围栏块 `1925-1966`）列了 `skills/review-loop/SKILL.md`——但同一个块里 `lib/` 只列了 **27** 条而实际有 **107** 个模块（`ls lib/*.ts | wc -l`），`test/` 只写一句概数。覆盖率 27/107 ≈ 25% ⇒ **策展式，不欠同步**。
- `docs/module-map.md` 的 `skills/` 行 ⇒ 枚举了目录内容，**欠同步**。
- 同一文件的「`lib/` 全量速查表」——自称全量，并附了自检指令「`ls lib/*.ts | wc -l`（当前 88，与本表条目一一对应）」。真去跑一遍：声称 **88**、实际模块 **107**、表里 **109** 行——**三个数两两不等**。

最后这条是这个形态里最值得记的：**一条自检指令本身也会陈旧，而且它陈旧时没任何声音**——写它的人指望它招手，而它只在有人真去敲那行命令时才招手。差集一做就清楚了：不缺任何模块（107 个全在表里），多出两行已删模块的行。所以碰到带自检指令的表，**先把那条指令跑一遍再下结论**，别相信它括号里的那个数。

**发现边界外的枚举时，停下来问，不要越界。** 上例里 `README.md` 不在子会话的 `fileBoundaries` 内，它拿着数据（覆盖率）去问项目经理而不是自己动手，经理据此判定不改、列入遗留。这才是边界该有的用法：**边界约束的是你的手，不是你的眼睛**——看到了就报，改不改由划边界的人决定。

### 边界**内**的顺手修，判据不是「值不值得改」，而是「要不要为它再走一轮 review」

上面那条管的是边界**外**。边界**内**另有一个陷阱，而且难防得多：你本就有权改它。

**实证（2026-09-05）**：一个只改 Markdown 的任务，在 `docs/module-map.md` 里连着往外推了三格——

| # | 顺手修了什么 | 当时的理由 |
|---|---|---|
| 1 | 计数 88 → 107 | 自检指令跑不通 |
| 2 | 删两行幽灵条目 | 不删的话计数仍不自洽 |
| 3 | 「安装脚本写入 6 角色」→ 4 | 同一段、同一类缺陷、三方证据一致 |

**每一格单独看都成立**，三次也都请示过且获准。但项目经理在第三格后画了线，理由不是“那些修得不对”，而是：**合起来就是一个任务在无限漂移，而每一次扩张都让 reviewer 重新审一遍它已经审过的文件**。

顺手修的诱惑总是以同一副面孔出现：**「同一段、同一类、改动极小」**。这三个形容词都在描述**改动本身**的大小，而真正的成本不在那里——在于它会作废现有裁决、再抄一轮审查。所以判据要换一个：

> 不是「这一处值不值得改」，而是「**我还要不要为它再走一轮 review**」。

两个问题的答案经常相反：一个错字当然「值得改」，但很少值得为它再花一轮审查。

**具体怎么做**：已经在改的那一轮里发现、且不需要额外一轮的，顺手修；**已经拿到 READY 之后才发现的，一律只进「遗留待办」**——哪怕它就在你刚改过的那一行旁边。把它写进报告，下一轮一并收，比今天再搭进去便宜得多。

### 检查法

改一个工具/模块前，问「谁把它的输出转发出去」：

```
grep -rn '"<工具名>"' extensions/ lib/
```

把命中里**会拼进 agent 可读文本**的文件一并划进边界。

## 3. 改 note 必须换 task id —— 而换 id 要重新批准

`orchestrator_plan({action:"write"})` 对**已存在**的 task id，会用旧 note 覆盖你写的新 note，没有任何提示。

### 精确边界（比「一律丢弃」更准）

根因在 `lib/orchestrator-plan.ts` 的 `mergeTaskProgress`（约 363–381 行）：

```ts
return {
  ...task,
  status: kept.status,
  ...(kept.note === undefined ? {} : { note: kept.note }),
};
```

`kept` 是同 id 的旧任务。所以：

- 旧任务**没有** note → 新 note 正常落盘；
- 旧任务**已有** note → `write` 里的新 note 被静默丢弃。

这是设计意图的溢出——该行的用意是「重写用户批准过的内容，不该销毁执行留下的记录」，status 与 note 一起被保护了。

### 实证

2026-09-05，一位 PM 两次需要改 note（改口径、审计打回后补三条 findings），**两次都靠换新 task id 才落盘**：`t2-message-driven-wait` → `t2-msg-driven-wait-c2` → `t2-msg-driven-wait-r2`。

### 代价：换 id 会触发重新批准

换 id 等于删掉旧任务、新增一个任务，而**新增任务是扩权**：`lib/orchestrator-plan-approval.ts:243` 把它记为 widening——`新增任务 "<id>"（用户从未批准过它，也没有它的边界）`——于是要重新惊动用户批准一次。

### 做法

**第一次写 plan 就把 note 写全**。note 是子会话任务书的依据，返工成本落在用户的批准框上，不是落在你身上。
