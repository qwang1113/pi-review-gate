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

启动方式：`pi-gate daemon start`（`npm run daemon:start` 等价）。CLI 见 §9。

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
| 方法不对 | `405` | `{"error":"<METHOD> 不被这个 endpoint 支持"}` |
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

---

## 5. 会话观测

### 5.1 三个数据源（合并后以 `sessionId` 为主键）

| 数据源 | 提供 |
| --- | --- |
| `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl` | 真实 `cwd`（只在首行 `session` 记录里）、最近输出、会话自己写的门禁 state |
| `~/.pi/agent/rg-sessions/*.json` | 名字、repo、cwd、模式、pid、心跳（`lib/session-registry.ts` 的格式与存活判定） |
| `tmux list-panes -a` 的 `@rg_*` 用户选项 | 活着的 pane、`kind`、状态词、`@rg_session_name` |

**状态词表复用 `CHILD_STATES`**（`lib/orchestrator-child-state.ts`）：
`working | waiting-input | waiting-judge | done | idle | mode-changed | dead | stalled`。

判定顺序（`stateSource` 说明它来自哪里）：

1. pane 上的 `@rg_state` 且 `@rg_state_at` 距今 < 90 s（`PANE_STATE_STALE_S`）⇒ 该词，`stateSource: "pane"`；
2. pane 上有状态词但已过期 ⇒ `stalled`，`stateSource: "pane"`；
3. 没有 pane 状态词 ⇒ 用注册表里的 `state`（心跳新鲜时），`stateSource: "registry"`；
4. 没有注册表信息 ⇒ 转写文件 120 s 内有更新为 `working`，否则 `idle`，`stateSource: "transcript"`。

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
| `rounds` | `{sent,recorded,lastVerdict}` | 轮次：`sent` 读会话写下的 `sentReviewRounds`（本轮**发出**的）、`recorded` 是已落库条数、`lastVerdict` 是最后一条裁决 |
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
"windowId": "@3", "paneId": "%9", "windowName": "kebab-name" }`

实现：在自己**专属的 tmux session**（`rg-<slug>-daemon-<id尾>`，复用
`lib/session-tmux-scope.ts` 的派生与归属标记）里 `tmux new-window` 起交互式 `pi`：

```
pi --session-id <uuid> [--name <name>] -- <任务描述> [+ 起名提示]
```

环境变量：`RG_GATE_MODE=<mode>`、`RG_STATION_CAP=<station>`（交付站点上限）。

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
| `topic` | ✖ | 默认 `other`；与门禁渠道的 topic 词表一致（`ask-user`/`goal-approval`/…） |
| `title` | ✅ | 非空；对话框正文 |
| `options` | ✖ | 选项文本（**不带** `A. ` 前缀；门禁自己渲染编号）。空数组 = 自由文本题 |
| `multiple` | ✖ | 默认 `false`；`true` 时是复选框题 |
| `recommended` | ✅(单选) | 单选必填且必须**逐字**等于 `options` 之一；多选可省 |
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

- 答案按 **`resolveAnswer`**（`lib/orchestrator-answer-rules.ts`，与编排层代答同一条规则）归一：
  选项原文、字母（`A`/`a`/`A.`）、1 起序号都接受；单选只收一行，多选可收多行（逗号/顿号/
  空格/`+`/`/` 分隔）；超出范围或读不出来**整条拒绝**，不猜。
- 成功 `200`：`{ "ok": true, "requestId": "q-3f2a", "answer": "甲", "path": "/…/q-3f2a.answer.json" }`
- 拒绝 `400`：问题读不到 / 已经答过（答案文件已存在）/ 答案不在选项里 / 缺 `sessionId`。

**先答者生效，且原子**：答案先写成临时文件，再用 **`link(2)`** 链到 `*.answer.json` —— 目标已存在时
链接失败（EEXIST），同时那个名字**只会以完整文档的形式出现**（不会留下写一半的答案）。已经存在的答案
文件**不会被覆盖**。

---

## 8. 通知：事件面 + 去重存储

### 8.1 谁发通知（唯一规则）

- **daemon 在线**（§3）时：**由菜单栏 app 独家发出**，终端侧 `terminal-notifier` **抑制**。
- **daemon 不在线**时：终端侧照旧发（现状不变）。

「在线」的判定只有 §3 那一条；探测失败一律按不在线处理，因此**抑制必须由「探测成功」触发**，
不能由「探测没报错」触发。

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

`title`/`body`/`key` 由门禁自己的 `buildUserNotifyMessage` + `notifyKey` 生成 ——
**与终端侧 `terminal-notifier` 对同一条事实算出的 key 完全相同**（这正是去重能跨两个发送方生效的原因）。

### 8.3 去重存储

`~/.pi/agent/rg-daemon/notifications/`（0600）：一目录，每 key 一个 claim 文件 + 一份追加式历史（形状见下）。
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

每个 key 的决定是**那个文件自己的 `link(2)`**（原子且互斥，不需要锁）；历史是追加写，两个进程的
claim 不会互相覆盖。去重窗口与频率上限仍用门禁自己的 `NOTIFY_DEDUP_MS` / `NOTIFY_RATE_MAX`。
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

- 目录：`<包根>/web/dist`（web 工作区的构建输出；`npm run build:web` 生成）。
- **构建脚本由 web-panel 任务落地**：本任务只提供接口（`build:web`）与占位 `web/package.json`。
  在它实现之前 `npm run build:web` **会正常退出并说明没有产出**，于是本目录不存在——那正是下面的说明页要讲的事（不是故障）。
- 发布包里也带上它（`package.json` 的 `files` 含 `web/dist/`），否则装出来的包永远只有说明页。
  构建产物由 web-panel 任务产生：**发布前必须先 `npm run build:web`**。
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
| `~/.pi/agent/rg-daemon/questions/…` | — | 待答问题协议（§7） |
| `~/.pi/agent/rg-daemon/notifications/claims/<hash>.json` | 0600 | 每个通知 key 的 claim 记录（§8.3） |
| `~/.pi/agent/rg-daemon/notifications/history.jsonl` | 0600 | 速率限制用的追加式历史（§8.3） |
| `~/.pi/agent/rg-daemon/start.lock` | 0600 | `daemon start` 期间持有、结束即删；超过 30 s 可被接管（§12） |

默认端口 **4597**（`--port` 可改）。`RG_DAEMON_HOME` 可覆盖 agent home（默认 `$HOME`），
后台子进程靠它继承同一个 home。

## 12. CLI

```
pi-gate daemon start [--port <n>] [--foreground] [--workspace-root <path>]…
pi-gate daemon stop
pi-gate daemon status
pi-gate daemon install      # 占位：launchd 实装由 menubar-and-boot 提供
pi-gate daemon uninstall    # 同上
```

- `start` 先探测：**已在线就打印它、退 0，不启第二份**；离线才 spawn 后台进程，
  并在**探测成功之后**才报「已启动」（10 s 预算，超时报错并指向日志）。
- `stop` 先做**带 token 的健康检查**确认那个 pid 仍是 daemon（pid 会被复用，杀错进程是这条命令唯一的破坏性动作）；
  健康检查没确认且 pid 还活着 ⇒ **拒绝发 SIGTERM**并说明原因。确认后才 SIGTERM，等它真的退出（≤8 s），
  然后清掉自己那条 state 记录；不强杀。
- `status` 打印 state 与在线判定理由，在线退 0、离线退 1。
