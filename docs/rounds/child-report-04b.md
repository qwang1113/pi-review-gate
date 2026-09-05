# 子会话完成报告 · t4b-session-factory-r2

日期：2026-09-05 ｜ 分支：`docs/hierarchical-session-design` ｜ 基线 HEAD：`2c77a2e`

课题：把「开一个带角色的 pi 子会话」收敛成唯一入口 `lib/session-factory.ts`，
让 C1（judge pane 边框行不渲染）、C2（judge 标题只写一次）与「投递核实只有编排侧有」
三个缺陷因收敛而消失。

---

## 一、退出标准逐条自证

### 1. 唯一入口存在，六个开 pane 的调用点全部改走它

新增 `lib/session-factory.ts`（502 行，未触及 600 行硬拦）。六处调用点：

| 调用点 | 文件 |
|---|---|
| judge 轮次派发 `dispatchJudgeRound` | `extensions/review-gate.ts` |
| `judge_spawn` → `doSpawn` | `lib/judge-spawn-tools.ts` |
| `judge_recover` → `doRecover` | `lib/judge-spawn-tools.ts` |
| `orchestrator_spawn` → `dispatchSpawn` | `lib/orchestrator-dispatch.ts` |
| `orchestrator_recover` → `doRecover` | `lib/orchestrator-recovery-tools.ts` |
| `orchestrator_handoff` → `doHandoff` | `lib/orchestrator-session-tools.ts` |

结构测试 `test/session-factory-structure.test.ts` 里 “all six pane-opening call
sites go through openSessionPane” 逐个断言：每个函数窗口内 `openSessionPane(` 恰好
出现 1 次，窗口以「下一个函数声明」为界并断言不越到同文件的另一个站点。

```
$ npx tsx --test test/session-factory-structure.test.ts
✔ the scan itself covers both ends before its verdict means anything
✔ (a) the split-window literal lives in exactly two files, and neither is a caller
✔ (b) the spawn argv builders have exactly one consumer: the session factory
✔ all six pane-opening call sites go through openSessionPane
✔ nothing opens a pane behind the factory's back
✔ both recover tools reach the same recovery judgement
✔ the judge probe repaints the border from the channel projection (C2)
ℹ pass 7  ℹ fail 0
```

### 2. 两条 grep 判据（用户 2026-09-05 认可的措辞）

```
$ grep -rn '"split-window"' lib/*.ts extensions/*.ts
lib/orchestrator-guard.ts:60:  splitw: "split-window",
lib/orchestrator-guard.ts:77:  "split-window",
lib/orchestrator-guard.ts:84:  "split-window": "orchestrator_spawn（接力用 orchestrator_handoff，救活死掉的用 orchestrator_recover）",
lib/orchestrator-tmux.ts:124:    "split-window",
lib/orchestrator-tmux.ts:152:    "split-window",

$ grep -rl "buildSpawnPaneArgv\|buildHandoffPaneArgv" lib/*.ts extensions/*.ts
lib/orchestrator-tmux.ts
lib/session-factory.ts
```

(a) 字面量只在两个文件：`orchestrator-tmux.ts`（构造）与 `orchestrator-guard.ts`
（bash 守卫的**禁令别名表**，非执行点，边界外，本轮一行未改）——测试写成白名单
`assert.deepEqual(holders, [...])`，白名单外任何文件出现即失败。
(b) 两个 spawn argv 构造函数的使用者恰好只有 `session-factory.ts`。

扫描面自证：结构测试用 `readdirSync` 枚举 `lib/` 与 `extensions/` 全部 `.ts`，并有
一条前置测试断言「两端都被扫到」（含 `lib/` 数量 > 100、每个文件确实读到了内容）——
这是上一轮 skill 里「窗口漏掉一半输入时它不报错、只会安静地小一点」那条经验的落实。

### 3. 旧实现删除，不留兼容层

```
$ grep -rn "openJudgePane" lib extensions test
（无输出）
```

`lib/judge-pane.ts` 从 205 行收窄到 72 行，只剩两样东西：judge 的跨进程契约常量
（`RG_JUDGE_OPENER` / `_ID` / `_ROLE`）与 pane 探活（`listJudgePanes` /
`judgePaneAlive`）。开 pane / 关 pane / 装饰 / 判据全部搬进 factory；
`closeJudgePane` 改名为 `closeSessionPane` 并落在 factory（关是开的对偶，谁创建谁回收）。
没有新增任何开关、环境变量或 “advanced entry”。

### 4. C1 / C2

- **C1**：`decorateSessionPane` 一次下发四条 argv —— pane style、pane title，以及
  window 级 `pane-border-status` / `pane-border-format`。单测
  “combination 1 — a judge SPAWN…” 断言 judge 组合下这四条都出现（收敛前 judge 只有
  前两条，边框行要等一个项目经理路过才会被打开）。
- **C2**：`refreshSessionPaneTitle` 是全仓**唯一**写 pane 标题的函数（带节流 5s 与
  重绘记忆），编排侧 `refreshPaneLabels` 与 judge 侧 `probeJudgeRound` 都调它。
  judge 侧的调用点选在 `probeJudgeRound`，因为 `judge_wait` 的轮询与 settle 唤醒
  **都**经过它——没有第三条「读了 judge 状态却不刷新边框」的路径。状态取自
  `projection.lastState`（通道投影），一轮结束时额外刷成 `done`。

### 5. 投递核实两侧一致

`verifyDeliveryOn`（`lib/orchestrator-tool-kit.ts`）从 `OrchestratorDeps` 收窄为
`DeliveryProbeDeps`（只要 `channelIO` + `sleep`），通道路径作为参数传入：

- 编排侧入口 `verifyDelivery(deps, {childId,…})` —— 路径仍由 runtime 推导，两个既有
  调用点（spawn / instruct）语义一字未变；
- judge 侧入口 `verifyJudgeBoot(deps, {channelPath, baselineRecordCount})` ——
  judge 的通道**跨 pane 长存**，所以「有记录」不构成新 pane 起跑的证据，必须是水位线
  **之上**的记录。budget 也更长（30 次 × 1s，判据是它自己的心跳节拍比子会话慢）。

核实失败时 **pane 与登记都保留**（不误杀一个只是起得慢的会话），回执带证据行；
`judge_spawn` 里连 `rememberGoalAudit` / `rememberPlanAudit` 也照常执行，否则一个
迟到才上报的 judge 交的卷将无法绑定记录。

测试：`test/delivery-probe.test.ts` 六条，覆盖三类调用者（编排 spawn 保持旧语义、
judge spawn 的水位线、instruct 的 ack 不受影响），外加「读不出通道 = 缺回执而不是抛
异常」「attempts 是 N 次读 N-1 次睡」。`test/session-factory.test.ts` 里
“a failed delivery check KEEPS the pane and its registration” 钉住失败语义。

### 6. 跨进程契约逐字不变

- 五个 env 变量名与取值语义未改：`buildSessionEnv` 是唯一拼装点，单测
  “the env builder is the only assembly point…” 与五条组合测试逐一断言 key 集合
  （judge spawn 五个、judge recover 三个、编排三个、successor 原样透传）。
  `test/judge-pane.test.ts` 另有一条把三个常量的字面值钉死。
- `judgeChannelTarget` 输入输出未动。
- 会话独占豁免：judge 看 `RG_JUDGE_*`、编排子会话看 `RG_STATE_VARIANT`，
  组合 3 / 4 的断言明确写了「这也是豁免依据」。编排 recover 的 env 由
  `stateVariant: child.stateVariant ?? child.id` 给出，与收敛前的 `childEnv` 一致。
- 改动文件清单（`git status --porcelain`）不含 `lib/judge-conclude.ts` /
  `lib/orchestrator-channel.ts` / `lib/orchestrator-child-channel.ts`，也不含
  `lib/orchestrator-guard.ts`。
- 两处 recover 共用 `paneRecoverability`（六种码：unknown / closed / no-pane /
  alive / unknown-liveness / recoverable），各自只保留自己的措辞；结构测试断言两个
  文件都调它，单测把六种码逐一钉住。

**边界例外（用户 2026-09-05 当轮批准）**：`lib/audit-round.ts` 加进边界，只改两行——
`RunAuditRoundDeps.dispatch` 的返回类型允许 `Promise<…>`，调用处加 `await`。原因：
judge 侧投递核实要求 `dispatchJudgeRound` 变 async，而 goal/plan 审计链经过这个同步
类型。除这两行外该文件未动。

### 7. 全绿 + 文档 + 交付站点

```
$ npx tsc --noEmit ; echo EXIT=$?
EXIT=0

$ npm test
ℹ tests 2349
ℹ pass 2349
ℹ fail 0
```

（基线 2330 pass / 0 fail；本轮新增 3 个测试文件共 19 条，另改写 3 个既有文件里
随实现更名的断言。）

文档：`docs/module-map.md` §5 新增 `session-factory.ts` 一行、表头计数 108 → 109、
`judge-pane.ts` 与 `orchestrator-tool-kit.ts` 两行重写，§域3 正文改口径；
`docs/hierarchical-session-design.md` §六模块落点同步。`test/module-map.test.ts`
（双向差集 + 计数）通过。

---

## 二、关键设计决定

1. **factory 的顺序是固定的：spawn → register → decorate → verify。** 登记在核实
   之前，是为了让核实失败时 pane 仍然可寻址（它可能只是慢）；装饰在核实之前，是为了
   让人眼看到的 pane 在门禁还在等证据时就已经有身份。这个顺序写在函数文档里，不是
   调用方的自由。

2. **登记与核实以回调形式注入，而不是让 factory 认识两张注册表。** judge 写
   `judgeHierarchy`、编排子会话写 runtime 的 children，两者结构完全不同；把它们塞进
   factory 会让它认识两个领域模型。回调让「登记」成为 factory 序列里的**一步**（不会
   被调用方遗忘、且顺序由 factory 决定），同时不把领域知识搬家。

3. **env 由 factory 拼，命令由调用方给。** env 是跨进程契约（也是豁免依据），必须
   一处拼装；而命令 argv 依赖各自的任务文件/模型/会话 id，把它们搬进 factory 只会
   让它认识 `judge-process`、`orchestrator-delivery` 两套东西。judge 的两个命令构造器
   本身是「怎么开一个 judge pane」的一部分，所以随 openJudgePane 一起搬进 factory。

4. **投递核实的判据放在水位线上。** 编排子会话每次 spawn 都是新通道，水位线恒为 0，
   语义与收敛前逐字相同；judge 通道跨 pane 长存，不加水位线就会把「上一轮的记录」当成
   「这一轮的 pane 起来了」——那正是核实存在的意义被抵消的形态。

5. **handoff 也收敛进来（用户裁决 A）。** 它是唯一「不登记、不接通道、不装饰」的组合，
   所以 factory 把布局/登记/装饰/核实做成四个独立可选轴，而不是按 kind 分支。副产品是
   判据 (b) 能写成「唯一使用者」而不是「唯二」。

6. **judge 标题刷新点选 `probeJudgeRound` 而不是 `judge_wait`。** wait 的轮询与 settle
   唤醒都经过它，选它等于「凡是读了 judge 状态的路径都会刷新」，不需要记得在第二个地方
   补一次。

---

## 三、发现但未做（都要单独走一轮 review，不属于本任务）

1. **两处 recover 都不做投递核实。** goal 只要求 spawn 路径两侧一致；recover 也值得
   核实（水位线机制已经具备），但那会改变 recover 的失败语义，应当单独一轮。
2. **`dispatchJudgeRound` 复用 pane 的那条路径不核实投递。** 它是往活着的 pane 的通道里
   写一条 instruct，理论上可以等 `instruct-ack`（judge 侧走的是同一套子会话通道原语），
   但没有实测证据说明 judge 侧一定会 ack，贸然加会卡住每一轮 review。建议先测一次
   judge 侧 ack 的实际行为再决定。
3. **`lib/orchestrator-recovery-tools.ts` 的 `doAttach` 里 `childEnv` 已随收敛删除**，
   但 attach 本身不开 pane，因此没有别的欠账；提一句只是备查。
4. **`extensions/review-gate.ts` 仍有约 8200 行。** 本轮往里加的净代码很少（改造为主），
   但它离「新逻辑不要再堆进扩展」还差一次真正的拆分。
5. **`orchestrator-pane-decor.ts` 的 `paneTitleForHealth` 现在零调用者**（刷新逻辑改走
   factory 的 `refreshSessionPaneTitle`）。删它是 1 行改动 + 1 处测试，但属于顺手修，
   留给下一轮判断（它仍是「健康读数 → 标题」的语义命名，可能有保留价值）。

---

## 四、踩了什么坑

### 只对这一轮成立

- **`RunAuditRoundDeps.dispatch` 是同步类型，而它在边界外。** 「让 judge 派活也核实
  投递」这条要求，最后卡在一个跟 pane 毫无关系的类型签名上。教训是：把一条同步调用链
  改成异步，边界要按**调用链**画，不能只按「改哪些模块」画。本轮靠一次 `ask_user`
  当场扩边界解决（只改两行）。

### 项目 / 全局层面还会再遇到

- **假实现要跟着被测行为一起长。** `test/judge-spawn-tools.test.ts` 的假 tmux 在
  `split-window` 后什么也不做——收敛前无所谓，收敛后「什么也不做」= 模拟了一个**死掉的
  pane**，于是所有 spawn 测试一起红。正确的修法不是给测试塞 `attempts: 1`，而是让假的
  tmux 在 split 成功后**在通道里写一条 state 记录**（真 pane 就是这么干的），并且从
  argv 里的 `-e RG_JUDGE_ID=…` 反解身份——这样这个假实现不可能与 env 契约漂移。
  一般化：**当被测对象开始「观察副作用」时，假实现必须开始「产生副作用」，否则测试断言的
  是一个不可能发生的世界。**
- **结构测试的窗口要自证覆盖。** 我第一版用 `text.indexOf("\n}", at)` 取函数体，对
  嵌套函数（`dispatchJudgeRound` 缩进两格）会一路取到外层函数末尾，窗口大到能把邻居的
  调用算成自己的。改成「到下一个函数声明为止」+ 断言窗口内不含另一个站点的 anchor +
  断言 `openSessionPane(` 恰好 1 次。**凡是「从一个窗口里数一个数」的测试，都要先证明
  窗口的两端是对的**（这条已在 `skills/gate-changes-and-tests` 里，本轮又踩了一次）。
- **通道路径不要手写字面量。** `test/delivery-probe.test.ts` 第一版把
  `/home/test/opener-1/rg-…jsonl` 写死，与 `channelPathFor` 的真实布局不符，结果三条
  测试在一个自己发明的空文件上断言。改成从 `channelPathFor` 求值。**测试里凡是「被测
  代码也会推导」的路径/键，一律调同一个推导函数，不要抄一份。**
- **改共享返回语义前先枚举调用者、按类别验收。** `verifyDelivery` 的证据判据从
  `records.length > 0` 变成 `> baseline`，调用者有三类（编排 spawn / 编排 instruct /
  judge spawn），三类各写了测试。这条是 skill 里已有的经验，这次照做了，没出事。

---

## 五、门禁自身异常

本轮未观察到门禁自身的异常行为（无误拦、无误判、无卡死）。唯一一次被门禁挡下是
预期内的：goal 首次提交被 `goal-auditor` 以两条 P1 退回（判据里 `"split-window"`
字面量在边界外的 `lib/orchestrator-guard.ts` 也存在、以及漏了任务书要求的
verifyDelivery 两侧一致），findings 落在
`.pi/review-stream/goal-e98dd039e0a9.jsonl`，两条都属实且已修正后重提通过。
