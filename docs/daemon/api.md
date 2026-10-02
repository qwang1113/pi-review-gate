# pi-gate daemon HTTP API 契约

> **本文是契约本身。** web 面板、菜单栏 app 与终端侧通知抑制都按它开发；daemon 的实现
> 在 `lib/daemon/**`，字段名以本文为准，实现与本文不一致时按「实现有 bug」处理。
> 契约版本：`schema: 1`（见 `/api/health` 与 state 文件）。

---

## 1. 进程与归属

- 一个常驻 Node 进程，**不是 pi 扩展**，不 import 扩展运行时。
- **只监听 `127.0.0.1`**（`DAEMON_HOST`），绝不监听 `0.0.0.0`。
- 它观测本机**所有** pi 会话（三个数据源见 §5），并对外提供：会话观测、发消息、发起任务、
  配置读写、待答问题、通知去重、静态面板。

启动方式：`pi-gate daemon start`（`npm run daemon:start` 等价）。CLI 见 §12。

---

## 2. 鉴权

**每一个 `/api/*` 请求都要带 token**，两种形式：

```
Authorization: Bearer <token>          # 唯一形式，除下一个例外
?token=<token>                          # 只为 SSE（GET /api/events）保留
```

**query token 是 SSE 专属例外**：`EventSource` 不能设 header，所以那一个 endpoint 必须能从 URL 拿。
URL 会进 shell 历史 / 代理日志 / 浏览器历史，所以**其他任何 endpoint 都不接受 query token**（带了也是 401）。

token 由 daemon 首次启动时生成，写在 **`~/.pi/agent/rg-daemon.token`（权限 0600）**，
32 字节随机（base64url）。它**不写进 state 文件**、不进日志、不在任何错误响应里回显。

失败响应：

| 场景 | 状态码 | 响应 |
| --- | --- | --- |
| 缺 token / token 错 | `401` | `{"error":"缺少或错误的 token —— Authorization: Bearer <token>（SSE 可用 ?token=）"}` |
| 未知 endpoint | `404` | `{"error":"没有这个 endpoint：…"}` |
| 方法不对 | `405` | `{"error":"<METHOD> 不被这个 endpoint 支持"}`（SSE 那一条是 `{"error":"SSE 只支持 GET"}`） |
| 请求体不是合法 JSON | `400` | `{"error":"请求体不是合法 JSON"}` |
| 请求体超过 512 KiB | `400` | `{"error":"请求体超过 524288 字节"}` |

`Content-Type` 一律 `application/json; charset=utf-8`（静态资源除外）。

---

## 3. state 文件与「在线判定」（唯一真相）

`~/.pi/agent/rg-daemon.json`，权限 **0600**：

```json
{
  "schema": 1,
  "pid": 12345,
  "port": 4597,
  "startedAt": "2026-10-01T06:00:00.000Z",
  "version": "0.2.0",
  "baseUrl": "http://127.0.0.1:4597",
  "tokenFile": "/Users/me/.pi/agent/rg-daemon.token",
  "workspaceRoots": ["/Users/me/workspace"]
}
```

`workspaceRoots` 只在启动时带了 `--workspace-root` 时出现。**token 不在这个文件里**。

### 在线判定（终端通知抑制与菜单栏状态判断共同依赖的唯一规则）

**daemon 在线** ⟺ 以下三条**全部**成立：

1. state 文件存在、可读、是合法 JSON、`schema === 1`；
2. `state.pid` 进程活着（`kill(pid, 0)` 成功或 `EPERM`）；
3. 带 token 的 `GET http://127.0.0.1:<state.port>/api/health` 在 **1000 ms** 内返回 `200`。

第 3 条的地址是**算出来的**（`127.0.0.1` + 记录里的端口），**不是文件里的 `baseUrl`**：这个请求
带着 token，跟着一个被篡改/损坏的 `baseUrl` 走就是把密钥送出去。`baseUrl` 只是描述它当初在哪里起来。

**探测失败或超时的唯一含义是「不能断定在线」**，消费方必须按**不在线**处理。它：

- **不**表示进程已死（可能只是忙、端口被占、token 文件读不到）；
- **不**授权任何进程去 kill pid、删 state 文件或清理任何东西；
- 因此**终端侧 `terminal-notifier` 照旧发通知**（见 §8）。

CLI `pi-gate daemon status` 打印同一判定的结果与理由（在线返回码 0，离线 1）。

---

## 4. 端点总表

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | daemon 自己的事实（在线探测用） |
| GET | `/api/sessions` | 会话列表（`?includeRecentMs=`、`?limit=`） |
| GET | `/api/sessions/:id` | 单个会话详情（`:id` 可以是 sessionId，或 `名字` / `@名字`） |
| GET | `/api/sessions/:id/output` | 最近输出（`?tail=N`，默认 50，上限 500） |
| POST | `/api/sessions/:id/messages` | 给该会话写 inbox 消息 |
| GET | `/api/repos` | 候选仓库列表 |
| POST | `/api/tasks` | 起一个新 pi 会话 |
| GET | `/api/config` | 读配置（`?target=`、`?repo=`） |
| PUT | `/api/config` | 写一个配置项 |
| GET | `/api/questions` | 待答问题（`?sessionId=` 可选） |
| POST | `/api/questions/:requestId/answer` | 提交答案 |
| GET | `/api/notifications` | 通知历史（`?since=`、`?limit=`） |
| POST | `/api/notifications/claim` | 通知去重声明 |
| GET | `/api/events` | SSE 事件流（`?sessionId=`、`?replay=`） |
| GET | `/api/schedules` | 定时任务表，含派生字段（§13） |
| POST | `/api/schedules/author` | 起一个 authoring 会话谈契约（本 endpoint 不写表） |
| PUT | `/api/schedules/:id` | 面板只改 `cron` / `enabled` / `name` |
| DELETE | `/api/schedules/:id` | 删除一个定时任务，返回被删的那一条 |
| GET | `/api/schedules/:id/runs` | 该任务的运行台账（`?limit=`） |

---

## 5. 会话观测

### 5.1 三个数据源（合并后以 `sessionId` 为主键）

| 数据源 | 提供 |
| --- | --- |
| `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl` | 真实 `cwd`（只在首行 `session` 记录里）、最近输出、会话自己写的门禁 state |
| `~/.pi/agent/rg-sessions/*.json` | 名字、repo、cwd、模式、pid、心跳（`lib/session-registry.ts` 的格式与存活判定） |
| `tmux list-panes -a` 的 `@rg_*` 用户选项 | 活着的 pane、`kind`、状态词、`@rg_session_name` |

**前两个源是别人的文件，读的是别人写的那个根**：`RG_DAEMON_HOME` 只搬 daemon 自己的东西（§11）。
pi 的转写跟着 pi 自己的 agent 目录（`PI_CODING_AGENT_DIR` / `TAU_CODING_AGENT_DIR` 或 `$HOME/.pi/agent`，
规则出自 `lib/session-dir.ts` 的 `piSessionsRoot`），`rg-sessions` 登记跟着 `sessionRegistryRoot()` 的 `$HOME`
—— 观测侧（与发消息时的名字寻址）读的就是这两个根，即 `lib/daemon/paths.ts` 的 `userHome()`。
待答问题（§7）不一样：它的写者是门禁会话，从 `RG_DAEMON_HOME` 拿到 daemon 的 home，所以那个两侧都读 daemon home。

**状态词表复用 `CHILD_STATES`**（`lib/orchestrator-child-state.ts`）：
`working | waiting-input | waiting-judge | done | idle | mode-changed | dead | stalled`。

判定顺序（`stateSource` 说明它来自哪里）：

1. pane 上的 `@rg_state` 且 `@rg_state_at` 距今 < 90 s（`PANE_STATE_STALE_S`）⇒ 该词，`stateSource: "pane"`；
2. pane 上有状态词但已过期 ⇒ `stalled`，`stateSource: "pane"`；
3. 没有 pane 状态词 ⇒ 用注册表里的 `state`（心跳新鲜时），`stateSource: "registry"`；
4. 没有注册表信息 ⇒ 转写文件 120 s（`TRANSCRIPT_ACTIVE_MS`）内有更新为 `working`，否则 `idle`，`stateSource: "transcript"`。

**只出现在「最近跑过」里的会话**（没有 pane、没有名字，靠转写 mtime 进列表）用的是同一条 120 s 判据，
只是停下之后那个词是 `dead` 而不是 `idle`：`working` / `dead` 都由**文件自己的新旧**决定 ——
正在被写的转写背后一定有一个活着的写者，把它读成 `dead` 会让调度器把还在跑的运行结算掉（§13.7）。

**tmux 读不到是「信息缺失」，不是「没有会话」**：`tmuxReadable: false` 出现在列表里，
pane 判定整体跳过，注册表与转写照常上报。

### 5.2 `GET /api/sessions`

```json
{
  "schema": 1,
  "now": "2026-10-01T06:00:00.000Z",
  "tmuxReadable": true,
  "problems": ["读不出来的登记：…"],
  "sessions": [ /* DaemonSession[]，按 lastActivityAt 降序 */ ]
}
```

`DaemonSession`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionId` | string | pi 会话 id |
| `name` | string \| null | `@名字`（注册表里的名字） |
| `kind` | string \| null | `loop`/`orchestrator`/`child`/`judge`/`worker`（来自 `@rg_kind`） |
| `repo` / `cwd` | string | 仓库根 / 工作目录 |
| `branch` | string \| null | `git rev-parse --abbrev-ref HEAD`（按 cwd 缓存 30 s；失败为 null） |
| `mode` | string | 门禁模式（注册表里的 `mode`） |
| `state` | string | 见 §5.1 的词表 |
| `stateAt` | string \| null | pane 状态词的写入时间（ISO） |
| `stateSource` | `pane`\|`registry`\|`transcript` | 状态来自哪一层 |
| `alive` | boolean | pane 在 · pid 在 · 注册表判活，任一成立 |
| `tmux` | `{session,window,pane}` \| null | 所在 pane |
| `pid` | number \| null | 注册表里的 pid |
| `transcript` | string \| null | 转写文件绝对路径 |
| `lastActivityAt` | string \| null | 转写 mtime 与心跳取较晚者（ISO） |
| `rounds` | `{sent,recorded,lastVerdict}` | 轮次：`sent` 读会话写下的 `sentReviewRounds`（本轮**发出**的）、`recorded` 是已落库条数、`lastVerdict` 是门禁**仍然站着**的结论（`state.review.verdict`；`PENDING` 不算结论，读作 `null`） |
| `completedAt` | string \| null | 会话自己记下的完成时刻（`state.completion.at`，即 `declare_done` 被接受）；`null` = 没完成过 |
| `gateStateFound` | boolean | 转写尾部是否读到了门禁 state。**false ⇒ `rounds`/`unmet` 是占位值，不是结论**（面板必须显示「未知」而不是「无未满足项」） |
| `unmet` | string[] | 该会话门禁自己算的未满足项（`unmetRequirements`，基于会话写进转写的 state） |
| `registeredAt` / `heartbeatAt` | string \| null | 注册时间 / 最近心跳（ISO） |

**列出范围**：有 pane、有名字、或转写文件在 `includeRecentMs`（默认 24 h）内动过的会话。
上限 `limit`（默认 200，上限 200），超出时在 `problems` 里说明。

**注意**：`unmet` 不重算工作区指纹（那是每次都要 hash 一棵树的成本），它基于会话自己最后
写下的指纹；读不出来时如实给空数组，不猜。

**门禁 state 的读取窗口**：`rounds`/`unmet` 来自转写里**最后一条** `review-gate-state` 记录，
而 daemon 只读文件尾部的 **256 KiB**（`GATE_STATE_WINDOW_BYTES`：要找的就是最后一条，所以从尾部
找是正确形状）。一条巨大的工具结果可以把最后一条记录挤出这个窗口 —— 那时 **`gateStateFound`
为 false**，消费方必须把它读作「未知」，不能读作「没有未满足项」。

### 5.3 `GET /api/sessions/:id` → `{"session": DaemonSession}`；未知 → `404`

### 5.4 `GET /api/sessions/:id/output?tail=N`

```json
{ "sessionId": "abc123", "transcript": "/…jsonl", "entries": [ … ] }
```

`OutputEntry`：`{ "at": ISO, "role": "user"|"assistant"|"system"|"tool", "kind": "text"|"thinking"|"tool"|"result", "text": "…" }`。
单条文本上限 4000 字符（超出截断并追加 `…（截断）`），thinking 上限 1500，工具调用摘要上限 600。

### 5.5 `POST /api/sessions/:id/messages`

请求：`{ "text": "…" }`。

**请求体里没有 `from`**（传了也会被忽略）：发送者恒为 daemon。历史上这里曾接受调用方自报名字，那让任何持 token 的人都能冒充别的会话 —— 面板不是 peer，也不得声称自己是。

- `:id` **必须是带名字的活会话**（名字是地址）。
- 成功 `200`：`{ "ok": true, "messageId": "msg-…", "at": ISO, "inbox": "/…/<name>.inbox.jsonl", "to": "t1-work" }`
- 会话不存在 `404`；没有名字 `400`（`{"error":"… 还没有名字 —— 门禁只投递给登记过名字的会话"}`）；
  不在活会话里/生死判不出来 `400`（附 `liveNames: [...]`）。

**记录格式与 `lib/session-message-tools.ts` 逐字段一致**（接收方门禁按它消费），一行 JSON：

```json
{"kind":"session-message","messageId":"msg-…","from":"daemon","fromSessionId":"daemon",
 "fromRepo":"","fromMode":"daemon","toSessionId":"<收件人的 sessionId>","at":"ISO","text":"…"}
```

正文超长（整形后 > `MAX_INLINE_RECORD_BYTES`）时溢出到 `<inbox>.<messageId>.payload`，
记录里改为 `textRef: {path, chars}`。——这四条（kind/messageId/…/text|textRef）与工具
`send_message` 完全一致，接收方不需要知道消息来自面板还是会话。

发送方身份固定为 `from: "daemon"`（`fromSessionId: "daemon"`、`fromMode: "daemon"`）：
**面板不是一个 pi 会话，`@daemon` 不是一个可回复的地址**。接收方看到的是「一条塞进 inbox 的
peer 消息」，要回答用户就去问用户（`ask_user`）或在会话里说明，不要 `send_message` 回 `@daemon`。
（消息末尾那句「要回它一句：send_message({to:"@daemon"…})」是门禁通用模板的固定尾巴，
不要把它当成一个真的地址。）

### 5.6 `GET /api/repos`

```json
{ "repos": [ { "path": "/abs/repo", "name": "repo", "source": "session"|"history"|"root", "lastSeenAt": "ISO" } ] }
```

浏览器不能自己扫目录，所以由后端给候选：

- `session`：跑着的会话的 `repo`/`cwd`（是 git 仓库时）；
- `history`：最近转写文件反推出的真实 `cwd`；
- `root`：启动参数 `--workspace-root` 下的**一级** git 仓库。

去重按绝对路径，按 `lastSeenAt` 降序。

### 5.7 `POST /api/tasks`

请求：`{ "repo": "/abs", "task": "任务描述", "mode": "loop|explore|normal|orchestrator", "station": "precommit|commit|pr", "name": "kebab-name" }`
（`mode` 默认 `loop`，`station`/`name` 可省。）

成功 `200`：`{ "ok": true, "sessionId": "<pi session id>", "scopeSession": "rg-…",
"windowId": "@3", "paneId": "%9" }` —— 请求带了 `name` 时**多一个** `windowName`；没带 `name` 时这个键不存在

实现：在自己**专属的 tmux session**（`rg-<slug>-daemon-<id尾>`，复用
`lib/session-tmux-scope.ts` 的派生与归属标记）里 `tmux new-window` 起交互式 `pi`：

```
pi --session-id <uuid> [--name <name>] -- <任务描述> [+ 起名提示]
```

环境变量：`RG_GATE_MODE=<mode>`、`RG_STATION_CAP=<station>`（交付站点上限）。

**`mode` 只对 `loop` / `orchestrator` 真的生效（2026-10-01 实测）**：`RG_GATE_MODE` 是**spawner 交底**的通道，门禁只接受更**严**的起点（`lib/task-mode.ts` 的 `requestedModeFromEnv` 只把变量归一成四种模式之一，「非 enforced 不生效」的过滤在会话起步处 `lib/session-lifecycle.ts`；`explore` 只对一个 worker pane 生效）。所以用 `mode: "normal"` 起出来的会话**不是** normal：它起步时是 undecided（行为等于 loop，fail-closed），要降级得由会话里的 agent 自己走确认框问用户（或用户 `/gate-mode`）。daemon 不自行加限制，也不假称已经生效；面板对这两个值如实标注。

拒绝（`400`，附具体原因）：repo 不是存在的目录 / 任务描述为空 / mode 或 station 不认识 /
名字不合法（kebab-case，2–32）/ 名字已被活会话或生死不明者占用 / tmux 读不到。

**`repo` 的边界（明写）**：它可以是本机上的**任意**绝对目录 —— daemon 不把它限制在
`GET /api/repos` 给出的候选里。理由：持有 token 的调用方就是这台机器的同一个用户，它本来
就能在任意目录里起 pi；限制反而是假的边界（候选列表只是为了方便浏览器选）。同一句话适用于
`PUT /api/config` 带 `repo` 的 `gate-project` 目标（会在该目录下创建 `.pi/review-gate.json`）。

---

## 6. 配置读写

### 6.1 目标（`target`）

| `target` | 文件 |
| --- | --- |
| `settings` | `~/.pi/agent/settings.json` |
| `models` | `~/.pi/agent/models.json` |
| `gate-global` | `~/.pi/review-gate.json` |
| `gate-project` | `<repo>/.pi/review-gate.json`（**必须带 `repo`**，否则 `400`） |

### 6.2 `GET /api/config?target=…[&repo=…]`

```json
{
  "target": "settings",
  "path": "/Users/me/.pi/agent/settings.json",
  "exists": true,
  "value": { /* 完整解析后的 JSON，敏感字段已掩码 */ },
  "fields": [ { "path": "theme", "kind": "string", "sensitive": false, "editable": true, "current": "dark" } ],
  "backups": ["/…/settings.json.bak-20260102T030405Z"],
  "problems": ["文件存在但不是合法 JSON —— 面板只读展示，写入会被拒绝"]
}
```

**掩码规则**：任何**键名**匹配 `/(api[-_]?key|token|secret|password|passwd|credential|authorization|cookie|private[-_]?key)/i`
的键，**其下所有非 null/undefined 的值**（字符串、数字、布尔，以及整个子树里的每一项）都替换为固定掩码 `••••••••`。
掩码是常量，不保留任何后缀——明文绝不回显，类型也不是漏网的理由（`apiTokens: { retries: 3 }` 也会被掩）。

**可编辑面 = `fields` 列出的白名单**（写清单之外的路径一律拒绝）：

| target | 可写路径 | 类型 |
| --- | --- | --- |
| `settings` | `defaultProvider`、`defaultModel`、`defaultThinkingLevel`、`theme`、`tuiMode`、`quietStartup` | string / boolean |
| `models` | `providers.<provider>.apiKey`、`providers.<provider>.baseUrl`、`providers.<provider>.api` | 非空 string |
| `gate-*` | `agents.<角色>.slots`（≤4，逐个校验）、`agents.<角色>.auto`、`agents.<worker-*>.prompt` | string[] / boolean / string |

### 6.3 `PUT /api/config`

请求：`{ "target": "gate-project", "repo": "/abs", "path": "agents.reviewer.slots", "value": ["onekey/gpt-5.6-sol:high"] }`
`value: null` 表示**删除**该键。

成功 `200`：`{ "ok": true, "path": "/…/review-gate.json", "backup": "/…/review-gate.json.bak-20260102T030405Z", "value": { /* 掩码后的完整结果 */ } }`

拒绝 `400`：`{ "error": "<原因>", "path": "<你写的 path>" }`。**被拒时文件一个字节都不动。**

校验规则（复用仓库已有实现，不另立一套）：

- `agents.<角色>.slots` → **`validateSlots`**（`lib/model-spec.ts`，读 `models.json` +
  `models-store.json` 的注册表）。模型解析不到、思考级别不支持、槽位数超限都会被拒并说明原因。
- `settings.defaultThinkingLevel` → `KNOWN_THINKING_LEVELS`；`tuiMode` → `regular|fullscreen`。
- 路径本身：点分、每段 `[A-Za-z0-9_-]{1,64}`、拒绝 `__proto__`/`constructor`/`prototype`、最多 8 段。
- **`models` 只能改已存在的 provider**：`providers.<p>.…` 中的 `<p>` 必须在现有文件里（本接口可改凭据，不可凭空创建 provider）。
- **掩码不能写回**：敏感字段提交 `••••••••` 会被拒（要保留原值就别提交这个字段）。
- 文件当前不是合法 JSON ⇒ 拒写（daemon 不覆盖一个读不出来的文件）。

**备份**：写入前把原文件复制为 `<文件名>.bak-<YYYYMMDDTHHMMSSZ>`（与原文件同目录，ISO 去掉
分隔符），写完后只保留最新 10 份。原文件不存在时不产生备份。写入是**原子**的（临时文件 + rename）。

---

## 7. 待答问题文件协议（本契约冻结）

门禁侧的生产者/消费者由 `answer-channel` 任务实现；**格式与位置以本节为准**。

### 7.1 位置

```
~/.pi/agent/rg-daemon/questions/<sessionId>/<requestId>.json           问题
~/.pi/agent/rg-daemon/questions/<sessionId>/<requestId>.answer.json    答案
```

一个会话一个目录；`(sessionId, requestId)` 一起定位**一次具体询问**。
`requestId` 必须匹配 `^(?!.*\.\.)[A-Za-z0-9._-]{1,64}$`（它是一段安全路径）。

**待答 = 问题文件存在且答案文件不存在**。门禁消费答案后**删除这两个文件**（或整个会话目录），
daemon 据此不再列出它。

### 7.2 问题文件

```json
{
  "schema": 1,
  "requestId": "q-3f2a",
  "sessionId": "abc123",
  "sessionName": "t1-work",
  "topic": "ask-user",
  "title": "选哪个？",
  "options": ["甲", "乙", "丙"],
  "multiple": false,
  "recommended": "甲",
  "defaultChecked": [],
  "payload": null,
  "payloadRef": { "path": "/…/payload.txt", "chars": 1234 },
  "batchId": "b-1",
  "batchIndex": 0,
  "batchTotal": 3,
  "createdAt": "2026-10-01T06:00:00.000Z",
  "expiresAt": null
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schema` | ✅ | 必须是 `1` |
| `requestId` / `sessionId` | ✅ | 与路径一致，且能定位到一次询问 |
| `sessionName` | ✖ | 展示用；没有名字时 `null` |
| `topic` | ✖ | 默认 `other`；生产方知道时给门禁自己的 topic 词（如 `ask-user`）。**不是每个门禁对话框都带**：需求反述与 goal 批准这两个目前落在默认值 `other` 上，消费方别拿它区分对话框 |
| `title` | ✅ | 非空；对话框正文 |
| `options` | ✖ | 选项文本（**不带** `A. ` 前缀；门禁自己渲染编号）。空数组 = 自由文本题 |
| `multiple` | ✖ | 默认 `false`；`true` 时是复选框题 |
| `recommended` | ✅(单选) | 单选**且 `options` 非空**时必填，且必须**逐字**等于 `options` 之一；多选可省（`options: []` 是自由文本题，没有可推荐的项） |
| `defaultChecked` | ✖ | 多选默认勾选项（必须是 `options` 的子集） |
| `payload` / `payloadRef` | ✖ | 长正文；超长时用 `payloadRef` 指向旁文件 |
| `batchId`/`batchIndex`/`batchTotal` | ✖ | 一次采访的分组信息（与渠道的批量字段同义） |
| `createdAt` / `expiresAt` | ✖ | ISO；缺失按写入时间；`expiresAt` 只作展示，daemon 不自动删除 |

### 7.3 答案文件

```json
{
  "schema": 1,
  "requestId": "q-3f2a",
  "sessionId": "abc123",
  "answer": "甲",
  "by": "daemon",
  "reason": null,
  "at": "2026-10-01T06:01:00.000Z"
}
```

- `answer` 是**规范化后**的文本：单选是选项原文；多选是各选项原文用 `" / "` 连接；
  自由文本题就是原文。
- `by`：`daemon`（面板/HTTP）或 `user`（用户本人）。
- `reason`：用户在「✎ 不选，我说明原因」里写的原因。

### 7.4 `GET /api/questions[?sessionId=]`

```json
{ "questions": [ /* DaemonQuestion[]，按 createdAt 降序 */ ], "problems": ["<sessionId>/<file>: 原因"] }
```

### 7.5 `POST /api/questions/:requestId/answer`

请求：`{ "sessionId": "abc123", "answer": "A" }` 或 `{ "sessionId": "abc123", "answers": ["甲","丙"] }`，
外加可选 `reason`、`by`。

- **两种形状，两种读法**：
  - `answer`（字符串）是按**人类输入**读的：`resolveAnswer`（`lib/orchestrator-answer-rules.ts`，
    与编排层代答同一条规则）认选项原文、字母（`A`/`a`/`A.`）、1 起序号；单选只收一行，
    多选可收多行（逗号/顿号/空格/`+`/`/` 分隔）；超出范围或读不出来**整条拒绝**，不猜。
    唯一例外是门禁模板的退路行：整串**以退路行开头时原样接受**（理由是回答本身）。
  - `answers`（字符串数组）是**已经切分好的行**，每个元素是一行：逐个元素读（先逐字精确匹配，
    再按上面单行的读法认字母/序号），**不再按分隔符切分** —— 选项原文自己含空格或 `/` 时，
    重新拼接再解析会把它们切碎（「同时匹配 N 个选项」或拼出没人选过的组合）。元素首尾空白忽略，
    空元素跳过；单选给多行整条拒绝，退路行只能单独出现。实现是 `resolveAnswerList`，
    与字符串路径共用同一条 `readRow` 读法。
- 成功 `200`：`{ "ok": true, "requestId": "q-3f2a", "answer": "甲", "path": "/…/q-3f2a.answer.json" }`
- 拒绝 `400`：问题读不到 / 已经答过（答案文件已存在）/ 答案不在选项里 / 缺 `sessionId`。

**先答者生效，且原子**：答案先写成临时文件，再用 **`link(2)`** 链到 `*.answer.json` —— 目标已存在时
链接失败（EEXIST），同时那个名字**只会以完整文档的形式出现**（不会留下写一半的答案）。已经存在的答案
文件**不会被覆盖**。

---

## 8. 通知：事件面 + 去重存储

### 8.1 谁发通知（唯一规则）

- **菜单栏 app 在跑、而且 daemon 在线**时：**由 app 独家发出**，终端侧 `terminal-notifier` **抑制**。
- 其余任何情况（app 没在跑 / daemon 不在线 / 两条里有任一条读不出来）：终端侧照旧发（现状不变）。

两条判定的出处：**daemon 在线**只有 §3 那一条；**app 在跑而且发得出来**是 app 自己写的**心跳** ——
`~/.pi/agent/rg-daemon/menubar.json`（`{schema:1, pid, at, canPost}`，不含任何秘密），
app 活着时每 5 s 重写一次。`lib/daemon-presence.ts` 的 `bannerSenderPresence` 读它，
四条全过才算发送者在场：新鲜窗口 **20 s**、pid **是正整数且活着**、
**`canPost === true`**（app 每次刷新都问系统要的授权状态：`getNotificationSettings` 不是 `.authorized` ⇒ `false`）。
`canPost` 这个字段是 reviewer P1（2026-10-01）加的：**app 在跑 ≠ app 发得出来**，
只看见进程活着就抑制，会得到同一个「两边都不发」的后果；字段缺席（旧版 app 写的心跳）也按 `false` 算，
方向永远是「终端补上」。

**为什么需要第二个条件**（质量轮 P1，2026-10-01）：daemon 会被每个交互会话自动拉起，app 不会 ——
只看「daemon 在线」时，重启后的默认状态是「daemon 起来了、app 没跑」，于是终端侧抑制、app 又不存在，
**两边都不发**。抑制必须由「发送者在场」赚到，和在线判定必须由探测成功赚到是同一条道理；
两条中任一条读不出来 ⇒ 终端侧照常发（fail-open：最坏是多一条横幅，绝不是没人收到）。

### 8.2 事件面（SSE）

daemon 在会话状态**发生迁移**时推出 `notification` 事件（不是快照，是事件）：

| 事件 `kind` | 触发 |
| --- | --- |
| `waiting-input` | 会话状态**变成** `waiting-input` |
| `done` | 会话状态**变成** `done` |
| `exited` | 会话从存活变为消失（且不是 `done`）——即异常退出 |

**只对门口会话发**：`mayNotifyUser`（`lib/user-notify.ts`）判定通过的主会话
（`mode` 为 `loop`/`orchestrator` 且不是编排子会话）才产生事件；子会话、judge、worker
的迁移只推 `session` 事件，不产生通知。

`notification` 事件的 payload：

```json
{
  "key": "等你回答 · project\u0000@t1-work 正在等你回答。",
  "kind": "waiting-input",
  "sessionId": "abc123",
  "name": "t1-work",
  "repo": "/Users/me/project",
  "title": "等你回答 · project",
  "body": "@t1-work 正在等你回答。",
  "at": "2026-10-01T06:02:00.000Z"
}
```

`title`/`body`/`key` 由门禁自己的 `buildUserNotifyMessage` + `notifyKey` 生成（拼法两边同源），但
**两边对同一条事实算出的 key 并不相同** —— 正文那一句一边是「@名字 正在等你回答。」、一边是「对话框标题 · 正文」。
因此**跨发送方不去重**：两个发送方不会各发一条，靠的是 §8.1 的在场选举（app 在跑且发得出来时终端侧整体抑制）；
这份台账只管**app 自己**的重复（终端侧用会话 sidecar 里自己的历史）。

### 8.3 去重存储

`~/.pi/agent/rg-daemon/notifications/`（0700 —— 目录要 x 位才进得去；里面的文件才是 0600）：一目录，每 key 一个 claim 文件 + 一份追加式历史（形状见下）。
去重窗口与频率上限**用门禁自己的规则**：`decideNotify`（`lib/user-notify.ts`）——本模块只把那条规则要读的 history
现读出来（该 key 上次 claim 的时间 + 速率窗口内最近几次发送），不重写判定；`NOTIFY_DEDUP_MS` = 10 分钟、
`NOTIFY_RATE_MAX` = 5 / 5 分钟。历史保留 **24 小时**（按龄清理，没有条数上限）。

#### `POST /api/notifications/claim`

请求：`{ "key": "…", "kind": "waiting-input", "sessionId": "abc123", "name": "t1-work", "title": "…", "body": "…" }`
（`key` 必填，≤512 字符；**推荐直接用事件里的 `key` 原样回传**。）

```json
{ "schema": 1, "key": "…", "claimed": true, "status": "claimed", "firstSeenAt": "ISO", "count": 1 }
{ "schema": 1, "key": "…", "claimed": false, "status": "duplicate", "firstSeenAt": "ISO", "count": 1, "reason": "同样的通知 10 分钟内已发过，还需等待约 320s" }
{ "schema": 1, "key": "…", "claimed": false, "status": "throttled", "firstSeenAt": "ISO", "count": 1, "reason": "通知频率超限（5 分钟内最多 5 条）" }
{ "schema": 1, "key": "…", "claimed": true, "status": "claimed", "firstSeenAt": "ISO", "count": 1, "reason": "通知台账写不进去（只读 home / 磁盘满）—— 按 fail-open 处理：本条由你来发" }
```

**`claimed: false` 要看 `status`**（机器可读，不是靠 reason 猜）：

| `status` | `claimed` | 含义 |
| --- | --- | --- |
| `claimed` | true | **你发**：这一条由本次调用发出（台账写不进去时也是它 + reason —— **fail-open**，存储故障绝不静默通知） |
| `duplicate` | false | 这条事实在去重窗口内已经发过，别再发 |
| `throttled` | false | 达到频率上限（与去重是**两条规则**）；稍后再说 |

存储读不出来时按「没有任何记录」处理——只会多一条横幅，绝不静默。

**存储形状：一个目录，不是一个 JSON 文件**（`~/.pi/agent/rg-daemon/notifications/`）：

```
claims/<sha256(key) 前 32 位>.json   每个 key 一个文件：谁声明的、什么时候
history.jsonl                        只追加：每个已发的 claim 一行
```

每个 key 的决定就是**那个文件**：该 key 还没有记录时用 `link(2)` 建（原子且互斥，不需要锁），
已有记录时用 `rename(2)` **原子替换**（去重窗口过后这条事实必须还能发出去，而 `link` 会永远撞在自己的旧文件上）；
历史是追加写，两个进程的 claim 不会互相覆盖。去重窗口与频率上限仍用门禁自己的 `NOTIFY_DEDUP_MS` / `NOTIFY_RATE_MAX`。
24 小时以前的 claim 与速率窗口以外的历史行在每次 claim 时清理。

#### `GET /api/notifications?since=<ISO>&limit=<n>`

```json
{ "schema": 1, "entries": [ { "key": "…", "kind": "…", "sessionId": "…", "name": "…",
  "title": "…", "body": "…", "at": "ISO", "firstSeenAt": "ISO", "count": 2 } ] }
```

`entries` 按时间升序（最新的在最后），`limit` 默认 100、上限 500。

---

## 9. SSE 事件流 `GET /api/events`

查询参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `token` | — | **必填**（EventSource 不能设 header，这是 query token 的唯一例外） |
| `sessionId` | 全部 | 只订阅一个会话（含它的 `output`/`session`/`notification`） |
| `replay` | 30 | 订阅时先回放该会话最近 N 条输出（0 = 不回放；上限 500） |

帧格式（标准 SSE）：

```
event: <name>
data: <JSON>

```

| 事件名 | payload |
| --- | --- |
| `hello` | `{ "schema": 1, "now": "ISO", "sessionId": "…"\|null }` |
| `session` | `{ "kind": "added"\|"updated"\|"removed", "session": DaemonSession }`（`removed` 只有 `sessionId`） |
| `output` | `{ "sessionId": "…", "entries": OutputEntry[], "replay": true? }`（`replay` 只在首次回放出现） |
| `notification` | §8.2 的 payload |
| `ping` | `{ "at": "ISO" }`，每 15 s 一次保活 |

**回放与增量无缝**：订阅时 daemon 先回放最近 N 条，并把**尾部读取位置定在回放结束的那个字节**，
随后推出的都是这之后的新条目 —— 订阅后的第一个输出不会丢。`replay=0` 表示「不要给我历史」，
**不等于不建游标**。

**重复与丢失的取舍**：两个订阅者共用同一个尾部游标，第二个订阅者**不会**让游标前移（那会让
第一个订阅者丢掉还没读到的字节）。因此第二个订阅者可能把某几条既在回放里、又在增量里看到
两次 —— 重复是可恢复的，丢失不是。

订阅不限制数量；客户端断开（`close`）时自动注销。

---

## 10. 静态托管（web 面板）

- 目录：`<包根>/web/dist` —— 由 `web/` 工作区构建（`npm run build:web`，2026-10-01 起真可用：产出
  `dist/index.html` + `dist/assets/*`）。这个目录**不进 git**（`web/.gitignore`），所以刚 clone 的仓库里
  它不存在 —— 那正是下面的说明页要讲的事（不是故障）。
- 发布包里也带上它（`package.json` 的 `files` 含 `web/dist/`），否则装出来的包永远只有说明页：
  **发布前必须先 `npm run build:web`**。
- `GET /` 与任何**非 `/api/*`** 路径都从这里取文件（按扩展名给 `Content-Type`）。
- **SPA fallback**：路径在磁盘上不存在时回 `index.html`（前端路由刷新不 404）。
- 路径穿越（`../`、绝对路径、NUL）一律解析不出去，落回 fallback。
- **符号链接不能把范围放大**：命中路径会被 `realpath` 解析，解析结果必须仍在 `web/dist` 解析后的真路径之内——
  指向目录外的链接按「未命中」处理（落回 fallback），不会把目录外的文件发出去。
- **产物不存在**时返回 `200` + 说明页（告诉用户跑 `npm run build:web`），**不是 500**。

---

## 11. 端口、文件与日志一览

| 路径 | 权限 | 内容 |
| --- | --- | --- |
| `~/.pi/agent/rg-daemon.json` | 0600 | state（§3） |
| `~/.pi/agent/rg-daemon.token` | 0600 | token（§2） |
| `~/.pi/agent/rg-daemon/daemon.log` | 0600 | 后台进程的 stdout/stderr |
| `~/.pi/agent/rg-daemon/identity` | 0600 | daemon 自己的持久 id（专属 tmux session 名用它派生） |
| `~/.pi/agent/rg-daemon/scope.json` / `scope-repo` | 0600 | 专属 tmux session 的记录与锚点 repo |
| `~/.pi/agent/rg-daemon/menubar.json` | — | 菜单栏 app 的心跳（§8.1）：`{schema, pid, at, canPost}`，app 每 5 s 重写（不含秘密） |
| `~/.pi/agent/rg-daemon/questions/…` | — | 待答问题协议（§7） |
| `~/.pi/agent/rg-daemon/notifications/claims/<hash>.json` | 0600 | 每个通知 key 的 claim 记录（§8.3） |
| `~/.pi/agent/rg-daemon/notifications/history.jsonl` | 0600 | 速率限制用的追加式历史（§8.3） |
| `~/.pi/agent/rg-daemon/schedules.json` | 0600 | 定时任务表（§13） |
| `~/.pi/agent/rg-daemon/schedule-runs.jsonl` | 0600 | 定时运行的台账（§13） |
| `~/.pi/agent/rg-daemon/start.lock` | 0600 | `daemon start` 期间持有、结束即删；超过 30 s 可被接管（§12） |

默认端口 **4597**（`--port` 可改）。`RG_DAEMON_HOME` 可覆盖 agent home（默认 `$HOME`），
后台子进程靠它继承同一个 home。**它只搬 daemon 自己名下这些文件**：pi 的转写与
`rg-sessions` 登记属于别的进程，按 `$HOME` 读（§5.1），观测侧不会跟着覆盖走。

## 12. CLI

```
pi-gate daemon start [--port <n>] [--foreground] [--workspace-root <path>]…
pi-gate daemon stop
pi-gate daemon status
pi-gate daemon install [--port <n>] [--workspace-root <path>]…
pi-gate daemon uninstall
```

- `start` 先探测：**已在线就打印它、退 0，不启第二份**；离线才 spawn 后台进程，
  并在**探测成功之后**才报「已启动」（10 s 预算，超时报错并指向日志）。
  并发保护是 `start.lock`（`O_EXCL`，死主的锁可接管）—— 与门禁会话自动拉起
  （`lib/daemon/autostart.ts`）**同一份实现**。
- `stop` 先做**带 token 的健康检查**确认那个 pid 仍是 daemon（pid 会被复用，杀错进程是这条命令唯一的破坏性动作）；
  健康检查没确认且 pid 还活着 ⇒ **拒绝发 SIGTERM**并说明原因。确认后才 SIGTERM，等它真的退出（≤8 s），
  然后清掉自己那条 state 记录；不强杀。
- `status` 打印 state 与在线判定理由，在线退 0、离线退 1。
- `install` 写 `~/Library/LaunchAgents/com.pi.review-gate.daemon.plist` 并 `launchctl bootstrap`：登录自启、
  **崩溃才重起**（`KeepAlive.SuccessfulExit=false` —— `stop` 的干净退出不会把它拉回来），
  `ThrottleInterval` 30 s。`uninstall` 做 `launchctl bootout` 并删 plist（没装过时如实报「没有安装过」，不谎称已删）。
  两者都只在 macOS 上有意义，其他平台会直接拒绝并说明。
- `run` 是 launchd 与 `start` 共同用的前台进程；它**绑端口前先探测**：已有一份在答就以 0 退出，
  而不是报「地址被占用」以 1 退出 —— 后者在 launchd 的 `SuccessfulExit=false` 下会变成每 30 s 重起一次的失败循环。

---

## 13. 定时任务（scheduled tasks）

调度器是 daemon 自己的一部分（`lib/daemon/scheduler.ts`，纯判定 + IO 在 seam 后面）：
每 **20 s** 一次 tick，到点就起一个**普通 loop 会话**去干活，并把这一次运行记进台账。
契约（需求反述 + goal 批准）**只由用户在与 authoring 会话的对话框里**定，
面板永远不直接写契约 —— 那是 `schedule_task`（门禁工具）存在的理由。

**两个文件，两种真相**（§11 也列了）：

| 文件 | 内容 |
| --- | --- |
| `~/.pi/agent/rg-daemon/schedules.json` | `{schema, version, tasks[]}`：**该跑什么**。原子写、0600、每次写入 version +1 |
| `~/.pi/agent/rg-daemon/schedule-runs.jsonl` | 追加式台账：**实际跑过什么**。0600，只追加、没人重写（写入方只有 daemon 的调度 tick；会话与面板只读它）；末尾的半行会被跳过 |

### 13.1 `ScheduledTask`（`GET /api/schedules` 里每个任务的字段）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `sch-<8 位 hex>`，由 store 生成；**写入端点寻址用的就是它** |
| `name` | string | kebab-case 2–32；与 `id` **共用一个命名空间**（重名 = 歧义） |
| `repo` | string | 绝对路径，创建时必须存在 |
| `cron` | string | 5 段 `分 时 日 月 周`，本地时间 |
| `requirement` | string | 用户写的那句需求（原始描述） |
| `contract` | object | `{restatement:{text,hash,station,at}, goal:{text,hash,at}, approvedAt}`：**用户实际批准过的东西**，两段文本各绑自己的 hash |
| `enabled` | boolean | 关了就不触发 |
| `createdAt` / `updatedAt` | string | ISO |
| `lastFiredAt` | string \| null | 调度器**上一次处理这个任务**的时间（跑了、跳过、起不来都算）—— 下一个时间点从这里数；被错过的时点也会被它消费掉（见下一行） |
| `nextRunAt` | string \| null | **派生**：这个任务**按时间表下一个要处理的** cron 时刻 —— 以 `lastFiredAt`（从未处理过则以 `createdAt`）为基准的下一个。**永远不会是「很久以前」**：daemon 停机跨过的时点按用户决定**跳过、不补跑**，所以宽限窗口（`SLOT_GRACE_MS`，10 分钟）之外的过去不存在 —— 要么在未来，要么就在刚过去的 10 分钟内（「刚到点」：daemon 的下一次 tick 照常跑它）；一个已经被错过的时点，这里显示的是**它之后的下一个**（被错过的那个只出现在台账的 `run-skipped` 里，§13.7）。**这是按时间表算的，不看「这个任务是不是还有一次运行没结算」**（§13.6）：那种情况下这个槽会被推迟，原因写在 `GET /api/schedules/:id/runs` 里 —— 最后一条 `run-started` 没有对应的 `run-settled`（工具面的 `schedule_task({action:"list"})` 会直接写「已过期：本任务还有一次运行没结算」）。`enabled:false`、cron 非法、或 `createdAt` 读不出时间时是 `null` |
| `describe` | string | **派生**：`describeCron` 的一行人话，如 `每天 09:00` |
| `lastRuns` | array | **派生**：该任务最近 **5** 条**结果**（`run-settled` / `run-skipped`，旧→新；`run-started` 不是结果，不列） |

### 13.2 `GET /api/schedules`

`200`：`{ schema: 1, now, tasks: [{ …ScheduledTask, nextRunAt, describe, lastRuns }] }`。

`500`：调度表读不了（损坏、权限、形状不对）。**不当作「没有任务」** —— 那会让一次人工修复
变成一次静默停摆（`readSchedules` 是同一条规则；给「有哪些任务」用的 `listScheduledTasks` /
`findScheduledTask` 是另一回事 —— 它们把读不出来的表折成空表/未命中，调用方各自 fail-closed）。

### 13.3 `POST /api/schedules/author`

请求：`{ "action": "create" | "update", "id"?, "name", "repo", "cron", "requirement" }`

成功 `200`：`{ ok: true, sessionId, scopeSession, windowId, paneId }`（§5.7 那四个字段；author 不带 `name`，
所以不会有 `windowName`）。

**这个 endpoint 自己不写调度表**：它按 §5.7 的同一套 tmux 机制起一个 loop 会话，首条消息要求它用
`schedule_task({action:"create", …})` 把契约谈定 —— 那个工具会先弹需求反述、跑 goal 审计、
再请用户批准 goal，批准之后才把契约写进 `schedules.json`。**契约只在用户批准之后才存在**，
所以 `create` 与 `update` 走的是同一条路。

`400`：`action` 不是 `create`/`update`；`name` 不是 kebab-case 2–32、或（`create` 时）已被占用；
`repo` 不是存在的绝对目录；`cron` 解析失败；`requirement` 为空；`update` 缺 `id`。
`404`：`update` 的 `id` 不存在（`id` 精确匹配，不按 `name` 别名）。

### 13.4 `PUT /api/schedules/:id`

请求：**只接受 `cron` / `enabled` / `name`** 的任意子集。成功 `200`：`{ ok: true, task, version }`。

- body 里出现 `requirement` / `repo` / `contract` ⇒ **`400`**，文案指向 `POST /api/schedules/author`
  （这一条由 store 的 `applyScheduleEdit({from:"panel"})` 判）。
- 其它字段（含 `lastFiredAt`）⇒ **`400`**，文案列出面板能改的三个字段。这份白名单**只有一处**：
  `lib/schedule-store.ts` 导出的 `PANEL_EDITABLE_FIELDS`（name / cron / enabled）—— `PUT` 把整个 body
  交给 store 的 `applyScheduleEdit({ from: "panel" })` 判（gate 仍可盖 `lastFiredAt` 的槽位戳记）。
- 未知 `id` ⇒ `404`；值不合法（cron 解析失败、name 形状或重名）⇒ `400`。
- **`version` 冲突 ⇒ `400`**（「version 不匹配……有人同时改过，请重读」）：这次写入带走 handler 刚读到的 `version`（乐观锁）。PUT handler 从读到写是同步的，所以真正的窗口只有一个 —— **另一个进程**（会话里的 `schedule_task`、或另一个 daemon）在中间写过：那时 store 拒绝这次写入，而不是把两边合并。重读后再提交即可。

### 13.5 `DELETE /api/schedules/:id`

成功 `200`：`{ ok: true, task, version }`（`task` 是被删的那一条）。未知 `id` ⇒ `404`；`version` 与刚读到的不符 ⇒ `400`（同 §13.4 的乐观锁）。
删除**不动台账**：它名下未结算的运行仍会按 §13.7 结算（否则那个 repo 会被永远占着）。

### 13.6 `GET /api/schedules/:id/runs?limit=`

`200`：`{ schema: 1, taskId, runs: [ … ] }` —— 该任务的台账，旧→新；
`limit` 默认 **50**、下限 1、上限 **500**。未知 `id` ⇒ `404`。

| `kind` | 字段 |
| --- | --- |
| `run-started` | `runId`, `taskId`, `sessionId`, `at`，以及 `scopeSession` / `windowId`（发起回执里的窗口坐标，可选；见下） |
| `run-settled` | `runId`, `taskId`, `at`, `outcome`, `verdict`, `unmet` |
| `run-skipped` | `taskId`, `at`, `reason` |

`outcome` 的四个值：`passed`（会话**记录过 READY**）/ `blocked`（BLOCKED）/ `failed`（会话结束但结论不是这两个）/`gone`（读不到门禁 state，或会话确证消失）。**没有 READY 不记 passed** —— 这是「一次定时运行要过 reviewer」
的机械落点。`verdict` 取门禁**仍然站着的结论**（`state.review.verdict` / §5.2 的 `rounds.lastVerdict`），
不是 `state.rounds` 那段历史：`declare_done` 会清空 `rounds` 而清不掉 `review`，所以正常结束
（READY → `declare_done`）的运行记 `passed`，被撤回的判决（`PENDING`）不给 `passed`。`unmet` 原样带上。

`run-started` 里的 `scopeSession` / `windowId` 是 `launchTask` 的回执，**记下来是因为事后读不回来**：
会话的窗口平时是从它的 pane 上读的，而 pane 丢了 `@rg_sid` 就什么都没有了 —— 结算时正是靠这两个坐标
把那次运行的窗口关掉（§13.7）。旧记录没有这两个字段，那种运行只能靠 pane 坐标或等进程退出。

### 13.7 调度器的行为（不在 HTTP 面上，但同属契约）

- **到点才跑**：`enabled`、下一个 cron 时刻已经到点且仍在宽限窗口内、且该任务没有未结算的运行。
  **同一个时间点只处理一次** —— daemon 重启、tick 抖动都不重复跑（`lastFiredAt` 落在文件里，
  那是跨进程、跨重启的那一份）。写盘失败（只读 home、磁盘满）时本次进程还会把那个 slot / 那次运行
  记在内存里（`unrecordedSlots` / `unrecordedRuns`，按龄回收）：已经起出去的会话收不回来，
  「同一个时间点不重复起」因此在坏盘上也成立。
- **错过的时点跳过，不补跑**（用户决定）：到点时没有启动运行的那些 cron 时刻（daemon 没在跑，或本任务自己还有一次运行没结算），距 now 超过 `SLOT_GRACE_MS`（10 分钟）就**一律不跑**，也不会「补跑一次」（错过就是错过）；下一次真实到点照常跑。
  跳过是**消费掉**那一槽：调度器把 `lastFiredAt` 前移到处理时刻，并写一条 `run-skipped`
  （`reason` 点名被错过的那个时刻**与成因**）—— 所以「跳过」不会变成「从此再也不跑」。宽限窗口（10 分钟，
  是 20 s tick 间隔的好几倍）只用来吸收正常的迟到 tick（系统睡了/被占了几分钟），不是补跑。
- **一个 repo 同时只有一个写者**：两类占用都会让本次**不启动**，各写一条 `run-skipped`、`reason` 点名占着它的那一方：
  ① 该 repo 上还有**未结算的运行**（点名它的 `runId`）；② 该 repo 上还有**别的活会话**（点名 `sessionId` 与最后心跳）——
  判据是 `<repo>/.pi/session-presence.json` 里那条 **60 s 内**的心跳，与门禁自己拒第二个会话时用的**同一个函数**
  （`lib/session-exclusivity.ts`；哪怕那个会话已经 `declare_done`，只要进程还在就算）。② 是必需的：门禁不会为运行会话启动，
  契约继承不了，发出去的会是一辆开不动的车（quality round P1，2026-10-02）。daemon 自己开的运行窗口在结算时就关掉，所以
  daemon 留下的旧窗口不会变成长期占用者。
- **运行就是普通 loop 会话**：`RG_GATE_MODE=loop`、`RG_STATION_CAP=<契约里的 station>`、
  `RG_SCHEDULE_ID` / `RG_SCHEDULE_RUN`（本次运行的标识）；门禁在 `session_start` 按这两个变量
  把契约**从 `schedules.json` 读回来**（两个 hash 与文本相符 + 任务 repo 就是本会话 repo +
  台账里有本 runId 且 `sessionId` 就是本会话的 `run-started` 记录，四道闸全过才生效），再**写出**
  `.pi/loop-goal.md` 与 sidecar 的 `restatement` / `loopGoal`（`lib/schedule-run-contract.ts`）；
  任一道闸不过就什么都不写、只记一条日志（fail-closed）；那种情况下它没有契约可用（hash 不符、repo 不符、台账里没有本 runId 都会走到这里），
  它要么自己重新谈一份 goal，要么停在那里等人。②「repo 被人占着」在发车前就被 `liveSessionHolder` 挡下了，
  但发车到会话真正 `session_start` 之间有**几秒**（pi 冷启动）：这期间新占住这个 checkout 的会话仍会让它落到这里 ——
  窗口很小，但不是零。
- **结算**：会话 `done` / `dead`、或 `idle` 且记录过轮次 ⇒ 写 `run-settled`，**并把这次运行的窗口关掉**（`lib/daemon/control.ts` 的 `closeRunWindowAt`，只关 daemon 自己那个 scope session 里的窗口）：
  普通会话要等**进程退出**才释放 worktree 占用（`declare_done` 不释放），留着的窗口会让这个 repo 永远“被占”，以后每次运行都被跳过。
  **每一个 `outcome` 都会走这一步**，用两个地址里能用的那一个：会话还在列表里、pane 坐标读得到就用它；
  pane 丢了 `@rg_sid`（观测不到那个窗口）而 checkout 心跳还新鲜（进程确实还在）就用 `run-started` 里记下的发起回执坐标（§13.6）。
  两个地址都没有的结算（进程已经退了）本来就没什么可关的，tmux 自己会收回那个窗口。
- **「观测不到」不是「已经结束」**：列表里没有这个会话时，先问它自己的记录 —— `<repo>/.pi/session-presence.json`
  的心跳还新鲜且 `sessionId` 就是它、或它的转写还在动（`TRANSCRIPT_ACTIVE_MS`），就继续等；
  刚起的会话在观测里要过一会儿才出现，这段宽限期（120 s）内「没看见」不算消失。
  反过来，一个还占着自己 checkout 的活进程也不是「已结束」：`dead` / `idle` 的会话只有在它**没有**完成记录
  （`state.completion`，即 `declare_done` 被接受）时才会被这条证据挡住 —— 跑着的运行不会被误结算，
  而已经交卷的运行也不会因为窗口还开着就永远结算不了（t6 验收：一条活着的运行曾被提前 21 分钟结算成 `gone`）。
