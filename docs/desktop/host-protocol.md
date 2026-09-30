# prg ↔ 桌面客户端 宿主协议（v1）

> 日期：2026-09-30 · 任务 t2-host-protocol。
> 机器半边（唯一事实来源）：`lib/desktop-host-protocol.ts` 的 `METHODS` 字段表 ——
> 运行时校验、TS 类型（`Params<M>` / `Result<M>`）与 Rust 端对照用的
> `desktop/protocol/host-protocol.schema.json` 都从它派生，`test/desktop-host-protocol.test.ts`
> 在 schema 与派生结果不一致时失败。本文是它的散文半边：传输、生命周期、语义与 fail-closed。
> 字段的长度上限、正则与必填性**以字段表为准**，本文只列字段名与含义。

## 1. 它是什么

门禁（prg，本仓库的扩展）在 tmux 下自己开 window、判存活、关窗、上色、发通知。桌面客户端
用 `pi --mode rpc` 启动 pi 进程时，这些事改由**客户端**做：prg 通过一个 unix socket 向客户端
发请求，客户端执行并回答。prg 仍然决定**做什么、什么时候做、失败了怎么办**；客户端只负责
**怎么在桌面上做**（哲学一的同一条分工：一方表达意图，另一方负责实现）。

两条通道，各管一件事：

| 通道 | 方向 | 管什么 |
| --- | --- | --- |
| pi 官方 RPC（stdin/stdout JSONL） | 客户端 ↔ pi 进程 | 对话流、`extension_ui_request`（`notify` / `setStatus` / `setWidget` / `setTitle` 的 fire-and-forget、pi 原生 `select`/`confirm`/`input`/`editor`） |
| 本协议（unix socket JSONL） | prg → 客户端请求、客户端 → prg 响应 | 开/列/关会话、装饰、焦点、系统通知、**门禁的结构化对话框** |

## 2. 环境变量（客户端启动每个 pi 进程时注入）

| 变量 | 值 | 含义 |
| --- | --- | --- |
| `RG_HOST` | `desktop` | 宿主类型。未设或 `tmux` ⇒ 走现有 tmux 路径 |
| `RG_HOST_SOCKET` | 绝对路径，≤103 字节 | 客户端监听的 unix socket |
| `RG_HOST_SESSION` | `^[A-Za-z0-9._-]{1,64}$` | 客户端给**这个进程**分配的会话 id（hostSessionId） |

判定只有一处：`resolveHostEnv(env)` → `tmux` / `desktop` / `invalid`。`invalid`（值不认识、
socket 不是绝对路径或超长、缺 session id）**fail-closed**：prg 拒绝一切宿主操作并报原因，
**绝不回退 tmux**（回退会在桌面用户看不见的地方开出窗口）。

这三个变量只由客户端写：`session.open` 的 `env` 里出现其中任何一个，编码端与解码端都拒绝
（`bad-request`）——子会话的 hostSessionId 必须由客户端现发，prg 传过去就是把别人的身份交给子会话。

客户端给子进程拼 env 的规则：客户端自己的进程 env **去掉所有 `RG_` 开头的键，但保留
`x-inheritedGateEnv` 列出的**（即 `INHERITED_GATE_ENV_NAMES`，目前只有 `RG_NO_SIDE_EFFECTS`：它说明一个
进程整棵树被静音，剥掉就会 fail OPEN，让被静音的门禁开出的子会话重新产生副作用）→ 叠加
`session.open.params.env` → 最后写上它自己的三个 `RG_HOST*`。（tmux 下同一件事由
`envCommand` 剥离 + `healSessionEnv` 清 session env 保证；桌面下每个进程的 env 都是客户端
当场拼的，没有「session 级 env」可被污染。）反方向同样成立：三个 `RG_HOST*` 已列入
`orchestrator-tmux.ts` 的 `GATE_ENV_NAMES`，tmux 下开出的子会话会被剥掉它们，绝不会误以为自己在桌面宿主下。

## 3. 传输与帧

- 客户端创建并监听 socket（权限 `0600`，放在只有当前用户可写的目录）；接受连接时应核对对端 uid
  与自己相同（`getpeereid`），不同即断开。
- **帧 = 一个 JSON object + `\n`**（JSONL，与 pi RPC 同格式），UTF-8，单帧（不含换行）≤
  `MAX_FRAME_BYTES`（1 MiB）。超长、非 JSON、非 object、`v` 不等于协议版本 ⇒ `bad-frame`。
- 所有对象**封闭**：出现未知字段即拒绝。任何一端加字段都是**协议版本升级**，不是静默扩展。

请求（prg → 客户端）：

```json
{"v":1,"type":"request","id":"r-17","method":"session.list","params":{}}
```

响应（客户端 → prg），成功 / 失败二选一：

```json
{"v":1,"type":"response","id":"r-17","ok":true,"result":{"sessions":[]}}
{"v":1,"type":"response","id":"r-17","ok":false,"error":{"code":"forbidden","message":"not yours"}}
```

- `id` 由 prg 生成，每条连接内唯一；客户端原样带回。响应可乱序（`dialog.open` 可能挂几十分钟，
  其间其他请求照常往返）。
- v1 **没有**客户端主动推送的事件：一切都是 prg 发起的请求 + 对应响应。存活靠 `session.list`
  按需读（与 tmux 的 `list-panes -a` 同一读法），不靠推送。

## 4. 连接生命周期

1. **何时连**：prg 在会话启动（`session_start`）且 `resolveHostEnv` 为 `desktop` 时立即连接
   并 `hello`——尽早失败，而不是等到第一次开子会话。
2. **握手**：第一条请求必须是 `hello {protocol, pid, hostSessionId, piSessionId?, cwd}`。
   客户端核对 `hostSessionId` 是它发给这个 pid 的那个（不符 ⇒ `forbidden` 并断开）、`protocol`
   它支持（不支持 ⇒ `version-mismatch`）。**这条连接从此绑定这个 hostSessionId**：之后所有请求的
   「请求者」就是它，任何请求都不带「我是谁」字段，因此无法冒名。握手前的其他请求 ⇒ `forbidden`。
3. **一条连接用到进程结束**；prg 不开第二条。
4. **断开**：任一方关闭或 socket 出错 ⇒ 所有在途请求立即以本地错误 `disconnected` 结束
   （见 §8），在途 `dialog.open` 以 `unavailable` 结束。
5. **重连**：不设定时器（门禁不得为旧事实反复唤醒，`lib/wake-governor.ts`）。断开后的**下一次**
   宿主请求先尝试重连 + `hello` 一次；失败即以 `disconnected` 失败，不排队、不重试循环。
6. **客户端崩溃 / 退出**：它启动的所有 pi 进程的 stdin 收到 EOF，pi 自己退出——这是桌面下的
   「tmux server 没了」。存活不变量不变：prg 的存在以进程为准（`lib/opener-process.ts`），
   opener 进程没了，它派出的 judge / worker / 子会话自己 shutdown。
7. **超时**：除 `dialog.open` 外，每个请求 `REQUEST_TIMEOUT_MS`（5s）无响应 ⇒ 本地错误
   `timeout`（`requestTimeoutMs(method)`）。`dialog.open` 在等人，没有超时；撤框由 prg 发
   `dialog.close`。

## 5. 会话模型

- **会话** = 客户端启动的一个 pi 进程，用 hostSessionId 寻址。用户在客户端里直接开的那个是
  `role: "root"`，其余都是 prg 用 `session.open` 开的。
- **父子**：`session.open` 开出的会话，父会话就是请求者（连接绑定的那个 hostSessionId），
  客户端记录，`session.list` 里如实回报 `parent`。父会话退出后记录仍保留（孩子成了孤儿，`parent`
  仍指向那个已不在列表里的 id）。
- **子会话组** = 一个会话的全部 `own-group` 孩子，对应 tmux 下 opener 懒建的专属 session
  `rg-<repo>-<尾>`。客户端怎么摆（标签页、侧栏树）是它自己的事；协议只保证组的归属。
- **客户端从不自己杀会话**（客户端退出除外）：生命周期归 prg——孩子因 opener 进程消失而自行退出，
  残留由 prg 的孤儿清扫用 `session.close` 回收。
- **授权**（客户端强制，prg 自己的归属校验照旧）：写操作 `session.close` / `session.decorate`
  只许作用于 **请求者自己、它的后代、或父会话已不在的孤儿**，否则 `forbidden`；`session.pin` 只作用于
  请求者自己的组。`focus` 与 `session.list` 对任何会话开放（通知点击要跳到别的会话；接手的项目经理
  要看见前任的孩子）。

## 6. 方法清单

| 方法 | params | result | 对应的 tmux 职责 |
| --- | --- | --- | --- |
| `hello` | `protocol, pid, hostSessionId, piSessionId?, cwd` | `protocol, client{name, version}` | （握手，无对应） |
| `session.open` | `argv[], cwd, env{}, title, role, placement` | `hostSessionId, pid?` | new-session / new-window / split-window |
| `session.list` | `{}` | `sessions[{hostSessionId, parent, role, title, pid?, groupPin}]` | list-panes -a / list-sessions / 读归属标记 |
| `session.pin` | `reason` | `{}` | `@rg_scope_pinned` |
| `session.close` | `{target:"session", hostSessionId}` 或 `{target:"children"}` | `closed[]` | kill-window / kill-session / kill-pane |
| `session.decorate` | `hostSessionId, label?, colorSeed?, state?, stateAt?, kind?, repo?, piSessionId?, sessionName?` | `{}` | 上色、标题、pane 状态选项、会话展示名 |
| `focus` | `hostSessionId` | `{}` | 通知点击的 select-window + select-pane |
| `focus.state` | `{}` | `focusedHostSessionId \| null, appFrontmost` | list-clients + display-message -c、`lsappinfo front` |
| `notify` | `kind, title, body, group?, focusHostSessionId?` | `shown` | terminal-notifier |
| `dialog.open` | 见 §7 | 见 §7 | （tmux 下是 TUI 里的 `ui.select`/`ui.custom`） |
| `dialog.close` | `dialogId` | `{}` | （AbortSignal 撤框） |

逐条语义：

- **`session.open`**：`argv` 是完整命令数组（客户端 **exec，不经 shell**；客户端负责在 argv 里
  加 `--mode rpc` 的方式由 t4 定，但不得改写 prg 给的其余参数）。`role` ∈
  `judge | worker | orchestration-child | successor`（`SessionPaneRole.kind`）。`placement`：
  `own-group`（放进请求者的子会话组，所有常规子会话）/ `beside-opener`（接力后继者：放在请求者
  当前所在的位置旁边，用户正看着的地方——对应 `buildHandoffPaneArgv`）。`title` 是窗口/标签名
  （tmux 的 window name）。返回的 `hostSessionId` 就是以后寻址它的唯一句柄。
- **`session.list`**：列出**当前活着**的全部会话。某个 id 不在一份**成功的**列表里 = 已死；
  列表请求失败 = **未知**，绝不等于已死（`livenessOf`，与 `paneRecoverability` 的
  `unknown-liveness` 同一规则）。`groupPin` 是它父会话给子会话组下的铉住理由（没有为 `null`），
  父会话退出后仍保留——孤儿清扫据它跳过「有继承者」的孩子。
- **`session.pin`**：给请求者自己的子会话组下铉住（交接前 `pinOwnSession`、开编排子会话时的
  `pin: "orchestration-child"`）。tmux 下写失败会拒绝开窗；桌面下 prg 先 `session.pin`、成功后
  再 `session.open`，pin 失败同样拒绝开窗。
- **`session.close`**：`session` 关一个会话（也可以是请求者自己：接力前任关自己）；`children`
  关请求者的整个子会话组（`closeOwnSession`，`declare_done` 收尾）。**幂等**：目标已不在 ⇒
  `ok` 且 `closed` 不含它（对应 `windowAlreadyGone`）。关 = 客户端结束该进程（先关 stdin 让 pi
  正常退出，宽限期后强杀，宽限期由 t4 定）。
- **`session.decorate`**：**补丁语义**——只改出现的字段。`label` 是边框身份
  （`<干什么>@<谁启动>:<名字>`，`@rg_label`）；`colorSeed` 是配色种子，客户端自己把它哈希成颜色
  （同一种子永远同色，与 `paneStyleFor` 同一意图）；`state`/`stateAt`/`kind`/`repo`/`piSessionId`
  是 `tmux-pane-state.ts` 写的 `@rg_state` / `@rg_state_at` / `@rg_kind` / `@rg_repo` / `@rg_sid`；
  `sessionName`（`name_session` 的名字，`null` = 清除）对应 `@rg_session_name` + rename-window。
  prg 视装饰失败为**外观问题**：记警告，不影响会话本身（与 `decorateSessionPane` 同一口径）。
- **`focus`**：把客户端带到这个会话（前台 + 选中）。
- **`focus.state`**：用户此刻在看哪个会话、客户端是否前台 app——给 `isWatchingPane` 的两个事实。
- **`notify`**：`kind` ∈ `finished | failed | needs-user`；`title`/`body` 由 prg 按
  `NOTIFY_TITLE_MAX` / `NOTIFY_BODY_MAX` 清洗截断后发送；`group` 相同的通知互相替换
  （`-group`）；`focusHostSessionId` 是点击后要 `focus` 的会话。客户端**不做**抑制判断，prg 在发之前
  自己用 `focus.state` 判（策略只有一处：`lib/user-notify.ts`）。`shown:false` = 系统拒绝显示
  （如通知权限被关），prg 报告成「没发出去」，不当成功。

## 7. 门禁的结构化对话框

### 7.1 为什么不用 pi RPC 自带的 `select` / `editor`

- RPC 下 `ui.custom()` 返回 `undefined`：多选清单与「ESC 退回列表」的理由编辑器都画不出来
  （`MULTI_UNAVAILABLE` 就是这个事实）。
- `select` 只收一组字符串：「（推荐）」标记、decline 行、返回上一题、长正文都要拼进字符串，客户端
  没法按结构渲染。
- 项目经理先答时 prg 要**撤框**；RPC 的对话框没有 prg 侧的撤回消息。

所以门禁的每一个对话框（`askChoice` 这条唯一漏斗上的全部：`ask_user` 采访、goal / plan 批准、
需求反述确认、授权框、降级确认……）在 desktop 宿主下都走 `dialog.open`。pi 原生的
`extension_ui_request` 对话框仍由客户端照 pi 文档处理（门禁之外的扩展可能会用到）。

### 7.2 `dialog.open`

params 以 `shape` 区分：

| 字段 | choice（单选） | multi（多选） | 含义 |
| --- | --- | --- | --- |
| `dialogId` | ✓ | ✓ | prg 生成；`dialog.close` 用它 |
| `title` | ✓ | ✓ | 问题（采访时为 `问题 n / m` + 题面） |
| `body` | 可选 | 可选 | 长正文（反述、goal、plan 全文）——**整段传，客户端滚动显示，永不截断** |
| `options` | 2–16 | 2–16 | 选项原文，**不带** `A.` 编号——编号、「（推荐）」标记由客户端画。上限不是 agent 提问的 4 项：门禁自己的框可以更多（五环节清单有 5 项），16 只是尺寸护栏 |
| `recommended` | 可选 | — | 推荐项（必须是 `options` 之一，prg 侧 `validateChoice` 已保证） |
| `defaultChecked` | — | ✓ | 清单打开时勾好的一组（`[]` = 一项不勾） |
| `declineRow` | ✓ | ✓ | 「✎ 不选，我说明原因」这一行的文案（可能被调用方换掉，所以随请求走） |
| `back` | ✓ | ✓ | 是否画「← 返回上一题」 |

客户端渲染：选项行 → decline 行 → （`back` 时）返回行。选中 decline 行 ⇒ 打开**多行理由编辑器**
（标题带上完整题面与提示，见 `reasonTitleOf`）；编辑器里 ESC ⇒ **回到选项列表并保留已输入文字**；
选项列表里 ESC ⇒ 关框。两步交互都在客户端内部完成，prg 只收到一个最终结果。

result 以 `kind` 区分：

| kind | 何时 | prg 映射成现有的答案形状 |
| --- | --- | --- |
| `picked {option}` | 单选选中一项 | 该选项所在行（`parseChoice`） |
| `checked {options[]}` | 多选确认（可为空） | `A. 甲 / C. 丙`（`renderMultiChoice`） |
| `decline {reason}` | decline 行 + 理由（可为空） | `✎ 不选，我说明原因：<reason>` |
| `back` | 返回上一题 | `← 返回上一题` |
| `dismissed` | 用户关框 | `undefined`（停整场采访） |
| `aborted` | prg 发了 `dialog.close` | 忽略（另一方已先答） |
| `unavailable` | 客户端此刻画不出这个框 | **不是**关框：同 `MULTI_UNAVAILABLE`，题目交还 agent |

prg 收到结果后先过 `checkDialogOutcome`：选项不在 `options` 里、单选框回 `checked`、多选框回
`picked`、多选有重复项、没画返回行却回 `back` ⇒ 一律当**没有作答**（fail-closed，客户端编造的
答案永远进不来）。

### 7.3 「人和项目经理谁先答谁生效」

竞速仍然在 **prg 侧**，由现有的 `AbortController` + `Promise.race` 完成，协议只提供两个动作：

1. prg 发 `dialog.open`，同时（编排子会话里）把同一问题写进通道给项目经理、（无人作答时）
   启动 arbiter 代答计时——与 tmux 下完全一样。
2. **人先答**：`dialog.open` 的响应到达 ⇒ 胜出，prg 照旧撤掉通道侧与代答。
3. **另一方先答**（项目经理、arbiter、instruct 打断、ESC 取消整轮）：prg 发
   `dialog.close {dialogId}`；客户端撤框，并以 `{kind:"aborted"}` 结束那条挂着的 `dialog.open`。
   `dialog.close` **幂等**：框已经答完或 id 不认识 ⇒ 仍然 `ok`。
4. 两边几乎同时：先被 prg 处理的那个赢；晚到的 `dialog.open` 响应（哪怕是 `picked`）被丢弃。
   这与 tmux 下「框已撤、用户那一下没生效」是同一语义。

一次只有一个门禁对话框在屏幕上：prg 的 `createDialogQueue` 串行化不变，客户端不必排队。

### 7.4 状态条

状态条（`lib/status-strip.ts` 的单行 widget）与进度提示走 **pi RPC 的 `setWidget` / `setStatus`**
（fire-and-forget，本来就是结构化字符串数组），**不进本协议**。`setWidget` 的组件工厂形式在 RPC
下被忽略（渲染器探测 `review-gate-renderer-probe` 因此拿不到读数），由 t3b 处理。

## 8. 错误语义与 fail-closed

线上错误码（客户端可回）：

| code | 含义 |
| --- | --- |
| `bad-request` | params 不符合字段表 |
| `unknown-method` | 客户端不认识这个方法 |
| `version-mismatch` | `hello.protocol` 不被支持 |
| `not-found` | hostSessionId 不认识（`session.close` 的「已不在」不用它，见幂等） |
| `forbidden` | 未握手、身份不符、或目标不在请求者可写范围内 |
| `unavailable` | 客户端此刻做不到（如系统拒绝开进程） |
| `internal` | 客户端内部错误 |

本地错误码（只由 prg 自己产生，出现在线上即为 `bad-response`）：`disconnected`、`timeout`、
`bad-frame`（收到的行坏了）、`bad-response`（响应形状不对、id 没人在等、错误码非法）。
**形状不对的成功响应绝不当成功用**。

每类操作失败时 prg 的表现（任何错误码同等对待，唯一区别是报告里的原因）：

| 操作 | 失败时 | 对应的现有规则 |
| --- | --- | --- |
| 连接 / `hello` | 宿主不可用：拒绝一切会话操作并报原因，不回退 tmux | — |
| `session.open` | 拒绝开子会话（spawn / judge 派发返回错误），不假装成功 | `openScopeWindow` 失败 |
| `session.pin` | 不开那个窗口 | 写 pin 失败即拒 |
| `session.list` | 存活 = **未知**；recover 拒绝（`unknown-liveness`），不判死、不重开 | `listServerPanes` 返回 `undefined` |
| `session.close` | 报「没关掉」，登记保留，不当已关 | `closeSessionWindow` 失败 |
| `session.decorate` | 外观警告，会话照常 | `decorateSessionPane` |
| `focus` | 点击无效果，无副作用 | — |
| `focus.state` | 当作「没人在看」⇒ 照常发通知（fail-open 方向是多发一条，不是静默） | `isWatchingPane` |
| `notify` | 报告「没发出去」 | `describeNotifyOutcome` |
| `dialog.open` 断连 / 超时以外的失败 | 当作 `unavailable`：人这一侧没作答，通道侧（项目经理）与代答照常可答 | `MULTI_UNAVAILABLE` |
| `dialog.close` | 忽略（prg 已经采纳了另一方的答案） | — |

## 9. Schema 与再生成

`desktop/protocol/host-protocol.schema.json` 是 `buildJsonSchema()` 的输出（draft 2020-12；
`x-` 开头的键是 schema 表达不了的事实：版本、帧上限、超时、环境变量名、方法清单、信封形状）。
每个方法的 params / result 在 `$defs["<method>.params"]` / `$defs["<method>.result"]`。

改了 `METHODS` 之后测试会失败；用下面这条输出新内容，再用编辑工具写回该文件：

```sh
node -e 'import("./lib/desktop-host-protocol.ts").then(m=>console.log(JSON.stringify(m.buildJsonSchema(),null,2)))'
```

Rust 端的回归建议：用同一个 schema 校验自己产出的每种响应（至少覆盖本文 §6、§7 的每个 kind）。

---

## 附录 A · tmux 操作 → 协议消息 逐项对照

判据：`rg -n '"(new-window|new-session|split-window|kill-window|kill-session|kill-pane|list-panes|list-sessions|list-clients|display-message|select-pane|send-keys|set|setw|show-options|capture-pane|rename-window)"' lib`
列出的每一个调用点（2026-09-30 快照），外加 `set-environment` / `show-environment`（按变量名拼）
与 `terminal-notifier`。「N/A」一栏写明为什么桌面下没有对应消息。

| # | tmux 操作 | 调用点 | 门禁里的职责 | 桌面下 |
| --- | --- | --- | --- | --- |
| 1 | `new-session -d -s rg-… -P -F …` | `tmux-session-argv.ts` `buildNewSessionArgv` ← `session-tmux-scope.ts` `openScopeWindow` | 懒建专属 session 并开第一个子会话 | `session.open {placement:"own-group"}`（组随第一个孩子隐式出现） |
| 2 | `new-window -t rg-… -P -F …` | `buildNewWindowArgv` ← `openScopeWindow` | 在专属 session 里再开一个子会话 | `session.open {placement:"own-group"}` |
| 3 | `split-window -h -t %opener` | `orchestrator-tmux.ts` `buildHandoffPaneArgv` ← `session-factory.ts` `openRelayPane` | 接力后继者开在用户窗口里 | `session.open {placement:"beside-opener", role:"successor"}` |
| 4 | `kill-window -t rg-…:@id` | `buildKillWindowArgv` ← `closeSessionWindow`（`orchestrator_close` / `worker_close` / judge 级联） | 关一个子会话 | `session.close {target:"session"}`；已不在 ⇒ `closed` 为空（`windowAlreadyGone`） |
| 5 | `kill-session -t rg-…` | `buildKillSessionArgv` ← `closeOwnSession`（`declare_done`、进程退出） | 关掉本会话的整个专属 session | `session.close {target:"children"}` |
| 5b | `kill-session`（建后回滚） | `openScopeWindow` 写归属标记失败时 | 回收刚建却没法标记的 session | N/A：桌面下归属由连接身份当场记录，没有「建了但没标记」的中间态 |
| 5c | `kill-session`（孤儿清扫） | `session-orphan-sweep.ts` | 回收已死会话留下的专属 session | `session.list` 找父会话已不在、`groupPin` 为 `null` 的孤儿 → `session.close {target:"session"}`（孤儿授权） |
| 6 | `kill-pane -t %id` | `buildKillPaneArgv` ← `closeSessionPane` | 接力前任关掉自己那个 pane | `session.close {target:"session", hostSessionId:<自己>}` |
| 7 | `list-panes -a -F '#{pane_id}'` | `buildListServerPanesArgv` ← `judge-pane.ts` `listServerPanes` / `judgePaneAlive`、`paneRecoverability` | 判存活（失败 = 未知） | `session.list` + `livenessOf` |
| 8 | `list-panes -a -F <多字段>` | `tmux-sidebar-collect.ts` `buildListAllPanesArgv`（侧栏） | 侧栏读每个 pane 的 `@rg_*` 状态 | N/A：侧栏是客户端原生界面；它自己持有 `session.decorate` 写入的全部状态 |
| 9 | `list-panes -t <window>` | `tmux-sidebar-lock.ts` `buildWindowPanesArgv` | 侧栏锁输入前列同窗 pane | N/A：客户端原生（各会话输入框是客户端控件） |
| 10 | `list-sessions -F '#{session_name}'` | `buildListSessionsArgv` ← `readSessionNames` | 专属 session 是否已存在 | `session.list`（组 = 以请求者为 `parent` 的会话） |
| 11 | `set -t rg-… @rg_scope_owner / _pid / _pane` | `buildSetSessionOwnerArgv` ← `openScopeWindow`、`writeOwnerFacts` | 归属标记与存活事实 | N/A：客户端从连接身份记录 `parent`，`session.list` 回报 `parent` 与 `pid` |
| 12 | `set -t rg-… @rg_scope_pinned` | `writePin` ← `pinOwnSession`、`openScopeWindow {pin}` | 铉住，孤儿清扫跳过 | `session.pin {reason}` + `session.list` 的 `groupPin` |
| 13 | `show-options -t rg-… -qv @rg_scope_*` | `buildReadSessionOwnerArgv` ← `readOwner`、孤儿清扫 | 读归属 / 铉住 | `session.list`（`parent`、`groupPin`） |
| 14 | `show-environment -t rg-…` / `set-environment -u` | `buildListSessionEnvArgv` / `buildUnsetSessionEnvArgv` ← `healSessionEnv` | 清掉旧版门禁污染的 session env | N/A：客户端为每个进程当场拼 env（§2 规则），不存在 session 级 env |
| 15 | `rename-window -t %id <名字>` | `buildRenameWindowArgv` ← `session-name-tools.ts` | `name_session` 改窗口名 | `session.decorate {sessionName}` |
| 16 | `set -w @rg_session_name` / `set -wu` | `buildSetSessionNameOptionArgv` / `buildUnsetSessionNameOptionArgv` | 状态栏显示会话名 / 清除 | `session.decorate {sessionName: <名字> \| null}` |
| 17 | `display-message -p -t %id '#{session_name} #{window_id} …'` | `buildReadOwnCoordsArgv` ← `session-name-tools.ts` | 读自己的坐标 | N/A：自己的坐标就是 `RG_HOST_SESSION` |
| 18 | `select-pane -t %id -P <style>` | `buildPaneStyleArgv` ← `decorateSessionPane` | 边框配色 | `session.decorate {colorSeed}`（客户端自己按种子派色） |
| 19 | `set -p -t %id @rg_label` | `buildPaneLabelArgv` ← `decorateSessionPane` / `refreshSessionPaneTitle` / `paintPaneTitle` | 边框身份标题 | `session.decorate {label}` |
| 20 | `setw -t %id pane-border-status / pane-border-format` | `buildShowPaneLabelsArgv` ← `decorateSessionPane` | 打开窗口边框行 | N/A：客户端总是渲染 label |
| 21 | `set -p @rg_sid/@rg_repo/@rg_kind/@rg_state/@rg_state_at`、`set -pu` | `tmux-pane-state.ts` `buildSetPaneOptionArgv` / `buildUnsetPaneOptionArgv` | 每个会话 5s 一次上报自己的状态词 | `session.decorate {piSessionId, repo, kind, state, stateAt}`（目标为自己；只在变化或 30s 刷新时发，节奏不变） |
| 22 | `display-message -p -t %id '#{window_id}'` | `user-notify-runtime.ts` `ownTmuxAddress` | 通知点击要跳的窗口 | `notify {focusHostSessionId:<自己>}` |
| 23 | `list-clients` + `display-message -c <client> -p '#{pane_id}'` | `user-notify-runtime.ts` `activeClientPanes` | 用户正看着哪个 pane | `focus.state.focusedHostSessionId` |
| 24 | `select-pane -d / -e -t %id` | `tmux-sidebar-lock.ts` `lockArgv` / `unlockArgv` | 侧栏打开时锁住其他 pane 的输入 | N/A：客户端原生 |
| 25 | `set -w @rg_sidebar_locked`、`display-message -p '#{@rg_sidebar_locked}'`、`set -w -u` | `tmux-sidebar-lock.ts` `recordArgv` / `readRecordArgv` / `restoreArgvs` | 记录 / 恢复被锁的 pane | N/A：客户端原生 |
| 26 | `capture-pane -p -t %id` | `tmux-sidebar-preview.ts` `buildCaptureArgv` | 侧栏预览某会话屏幕 | N/A：客户端本来就持有每个会话的 RPC 事件流 |
| 27 | `send-keys` | 无（2026-08-30 已删除，只剩 `orchestrator-guard.ts` 拦截 agent 手写） | 投递消息 / 回答对话框 | N/A：消息与答案走通道 + `pi.sendUserMessage`，与宿主无关 |
| 28 | `orchestrator-guard.ts` 里的 tmux 子命令表 | bash 层拦截 agent 手写 tmux | 安全闸门 | 不变：agent 在桌面下手写 tmux 仍被同一闸门拦截；它不是宿主操作 |

## 附录 B · 通知与焦点

| 现有实现 | 桌面下 |
| --- | --- |
| `terminal-notifier -title -message` | `notify {title, body}` |
| `-group <sessionId>`（同会话通知互相替换） | `notify {group}` |
| `-execute 'tmux select-window …; tmux select-pane …'`（`buildFocusCommand`） | `notify {focusHostSessionId}`；客户端在点击时执行 `focus` 语义 |
| `-activate <bundle>` | 客户端点击时把自己带到前台（它就是那个 app） |
| `lsappinfo front`（前台 app） | `focus.state.appFrontmost` |
| 找不到 `terminal-notifier`（`MISSING_NOTIFIER_HINT`） | `notify` 失败 / `shown:false`，报告「没发出去」 |

## 附录 C · 对话框能力对照

| 门禁对话框能力 | 现有实现 | 桌面下 |
| --- | --- | --- |
| 单选模板（2–4 项 + 推荐 + decline 行） | `choice-dialog.ts` `renderChoice` 经 `ui.select` | `dialog.open {shape:"choice"}` |
| 多选清单（`defaultChecked`） | `multi-choice-dialog.ts` 经 `ui.custom` | `dialog.open {shape:"multi"}` |
| 理由编辑器（多行、ESC 回列表保留文字） | `reason-editor.ts` 经 `ui.custom`（`REASON_EDITOR_BACK`） | 客户端在 `dialog.open` 内部完成，结果 `decline {reason}` |
| 返回上一题 | `BACK_ROW` | `back: true` ⇒ 结果 `back` |
| 长文本确认（反述 / goal / plan 全文） | `body` 整段拼进标题 | `body` 字段整段传、不截断 |
| 先答者生效撤框 | `AbortSignal` → 框卸载 | `dialog.close` → 结果 `aborted` |
| 画不出来 | `MULTI_UNAVAILABLE` | 结果 `unavailable` |
| 状态条 | `setWidget`（单行） | pi RPC `setWidget` / `setStatus`，不进本协议 |
