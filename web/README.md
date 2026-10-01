# web —— pi-gate 的浏览器面板

本地控制面板：在浏览器里看**所有** pi 会话、答门禁的审批框、发起新任务、读写 pi 与门禁的配置。
它由 pi-gate daemon 自己托管（`GET /` 之外的一切非 `/api/*` 路径都从这里取），所以打开
`http://127.0.0.1:4597/` 就是面板。

数据来源**只有** daemon 的 HTTP + SSE，契约唯一出处是 [`docs/daemon/api.md`](../docs/daemon/api.md)。
前端不读本地文件、不扫目录、不为契约缺字段另做推导。

---

## 构建与开发

```
npm install            # 仓库根目录：npm workspace 会把 web/ 一起装上
npm run build:web      # 仓库根目录：产出 web/dist/（daemon 就服务这个目录）
npm --workspace web run typecheck   # 前端自己的类型检查
npm --workspace web run dev         # Vite dev server（开发用；它不代理 /api，联调请照着上面直接构建）
```

`web/dist` 是构建产物，**不进 git**（`web/.gitignore`），但进发布包（根 `package.json` 的 `files`），
所以发布前必须先 `npm run build:web`。daemon 找不到产物时返回的是「面板还没构建」说明页（200），不是错误。

**开发时联调**：dev server 不代理 `/api`，最省事的联调方式是直接对着 daemon 构建（`npm run build:web`
后刷新 `http://127.0.0.1:4597/`）—— 构建 1 秒出头，比配 proxy 快。

### token 从哪来

daemon 的每个 `/api/*` 调用都要带 token（`Authorization: Bearer`，SSE 例外，用 `?token=`）。
契约没有规定浏览器怎么拿它，面板用两条路（`src/lib/token.ts`）：

1. `http://127.0.0.1:4597/#token=<token>` 打开一次 —— 读进 `localStorage` 后把片段从地址栏去掉：

   ```sh
   echo "http://127.0.0.1:4597/#token=$(cat ~/.pi/agent/rg-daemon.token)"
   ```

2. 都没有时显示一个门页，写明 token 文件在 `~/.pi/agent/rg-daemon.token`，粘进去即可。

401 会让面板清掉本地 token 并回到门页（控制台留一行 `[pi-gate 面板] …` 说明是哪一个请求）。

---

## 目录约定

```
web/
  index.html            Vite 入口；`#root` 挂载点
  vite.config.ts        react + @tailwindcss/vite；`@/*` → src/*
  tsconfig.json         自己的 tsconfig（根 tsconfig 的 include 刻意不含 web/）
  src/
    main.tsx            createRoot + BrowserRouter + DaemonProvider
    App.tsx             外壳：侧栏 / 顶栏 / 路由 / 新建任务 Sheet（开关是 URL 的 ?new=1）
    index.css           Tailwind v4 主题层（:root 变量 + @theme inline 映射）
    lib/                非 UI 的全部逻辑
      api.ts            fetch 封装 + ApiError + SSE URL 拼装（唯一的出网口）
      token.ts          token 的读/存/清与变更事件
      types.ts          契约的类型镜像（字段名以 docs/daemon/api.md 为准）
      daemon-context.tsx 唯一的 SSE 订阅 + 会话表 + 待答问题轮询 + 答题动作
      format.ts         时间/路径/状态词的展示帮助（都对 null 有防御）
      utils.ts          cn()
    components/
      ui/               shadcn 组件（源码在本仓库，不是依赖）
      …                 业务组件：侧栏、顶栏、会话行、问题卡/批、输出流、门禁卡、启动跟踪条、错误边界
    pages/              路由页面：会话 / 详情 / 待处理 / 发起任务 / 历史 / 设置 / token 门页
```

**新增一块功能放哪里**：数据形状进 `lib/types.ts`，出网调用进 `lib/api.ts`（不要在组件里直接 `fetch`），
跨页共享的实时状态进 `lib/daemon-context.tsx`。一个页面里超过一个职责就拆成 `components/` 里的组件 ——
`pages/*` 只负责组装。

---

## 页面 → 契约

| 页面 | 数据来源 |
| --- | --- |
| 会话列表 `/` | `GET /api/sessions` 快照 + SSE `session` 事件（added/updated/removed） |
| 会话详情 `/sessions/:id` | 上面的会话表 + SSE `output`（`?sessionId=` 带 replay，首帧即历史）+ `GET /api/questions` |
| 待处理 `/questions` | `GET /api/questions`（5 秒轮询，SSE 里没有 question 事件）+ `POST /api/questions/:requestId/answer` |
| 发起任务 `/new` 与 Sheet | `GET /api/repos`（候选仓库）+ `POST /api/tasks` |
| 历史 `/history` | `GET /api/notifications?limit=200` |
| 设置 `/settings` | `GET /api/config?target=…` + `PUT /api/config` |
| 详情页发送区 | `POST /api/sessions/:name/messages` |

SSE 的 `session` 事件里 `removed` **只带 `sessionId`**（没有 `session` 对象，§9 的括号里写了）——
`lib/types.ts` 用联合类型把这件事钉住，读错它曾经让整个面板白屏。

---

## 联调状态（2026-10-01）

- **门禁侧的 answer channel 不在本分支**：生产者与消费者（`lib/external-answer.ts` 等）是
  `feat/pi-gate-daemon` 分支上的提交（`3f3ee155` / `4191e92a`），**不是本轮工作分支的祖先**。
  面板按 `docs/daemon/api.md` §7 的契约实现；闭环是在那个环境里验证的 ——
  真实会话在门禁里等回答 → `~/.pi/agent/rg-daemon/questions/<sessionId>/<requestId>.json` 出现 →
  **从面板**提交答案 → `.answer.json` 落盘 → 门禁消费后两个文件都消失、会话继续（门禁模式被改掉、名字被登记）。
  在本分支单独跑面板时，「待处理」没有生产者喂它 —— 答题链路要等 answer-channel 合入后才完整。
- **答题的两种形状**：选了选项 ⇒ `answer` 是选项原文（多选是 `answers` 数组，逐个逐字匹配）；没选选项只写了理由 ⇒ 走门禁模板的退路行，
  提交的是 `✎ 不选，我说明原因：<理由>` 这一整行 —— `resolveAnswer` 只认以退路行开头的自由文本，其他任何
  非选项文本都会被拒（`lib/orchestrator-answer-rules.ts`）。所以**问题选项里没有退路行时，面板不把「写理由」
  当作答**：那一题必须先选一项，理由只能作为附注随答案回传。
- **本轮顺带修的两个 daemon bug**（面板的两条核心路径各自卡在它们上，用户批准本轮一起修）：
  `lib/daemon/events.ts` 的订阅书签在 transcript 还不存在时会丢失（发起任务后立刻进详情页 = 永久收不到输出）；
  `lib/daemon/questions.ts` + `lib/daemon/server.ts` 不再把已拆分的 `answers` 数组拼接后重新当人类文本解析。
  运行中的 daemon 要**重启**才会加载它们——已跑的那个进程装的是它启动时的代码。
- 待答问题的轮询间隔是 5 秒；没有 SSE 事件推它（契约里没有 question 帧），所以刚提交完会在本地立刻移除，
  服务端状态由下一次轮询对齐。

---

## 契约里没有、因此面板没做的东西

每一条都是**缺口**，不是省事；面板宁可不放那个控件，也不放一个点了没用的按钮。要么 daemon 补字段，要么用户接受现状：
| 想做的事 | 现状 |
| --- | --- |
| 给会话发 **interrupt**（立刻打断当前 turn） | `POST /api/sessions/:id/messages` 的 body 只有 `{text}`，写进 inbox 后由接收方门禁以 `deliverAs: "steer"` 注入。面板只提供这一种投递并写明原因，不做假的模式开关（`send-keys` 那条路早已被明确否决）。 |
| **结束**一个会话 | 没有任何 endpoint。详情页因此只有「复制 tmux 跳转命令」与「发消息」。 |
| 发起任务时指定**模型槽位 / thinking 级别** | `POST /api/tasks` 只接受 `repo/task/mode/station/name`；模型与 thinking 由会话自己的 `review-gate.json` 决定（高级区如实这么写）。 |
| 发起任务时**新建功能分支** | 同上，没有对应字段；分支由会话自己（和门禁的提交规则）决定。 |
| 独立 **worktree 隔离** | `POST /api/tasks` 直接在所选 repo 里 `tmux new-window` 起 pi（编排层的隔离是另一套机制）。面板在「该 repo 已有活会话」时显示的是**共用同一个 checkout** 的警告，而不是「会隔离运行」。 |
| 候选仓库的**当前分支 / dirty** | `GET /api/repos` 只给 `path/name/source/lastSeenAt`。分支取自该 repo 上活跃会话报告的 `branch`（界面上标注了来源）；dirty 没有来源，不显示。 |
| 已批准 goal / precommit 明细 / 模型健康 | 契约对门禁只暴露 `rounds`（sent/recorded/lastVerdict）、`unmet`、`gateStateFound`。门禁栏只渲染这些，没有凭空造的三张卡。 |
| 启动失败的 stderr | 面板看不到 pane 里的输出，启动跟踪条只能给 tmux 跳转命令让用户自己去看。 |
| 全局 SSE 会带上每个会话的 output | 契约的 `?sessionId=` 只能收窄到**一个**会话，收窄不到「只要 session 事件」—— 面板的全局订阅是为了会话列表，因此 daemon 会把每个会话的 output 增量也推过来（前端直接丢弃，但字节已经发出来了）。本地回环、会话数量有限，暂时接受。 |
| `GET /api/repos` 从不返回 `source: "history"` | 契约 §5.6 声明 `session`/`history`/`root` 三种来源，daemon 实际只产出 `session` 与 `root`（`lib/daemon/control.ts`），所以「最近使用」分组在当前 daemon 上永不出现，且已退出会话的仓库被列进「正在运行」。面板按契约实现了三个分组。 |

---

## 验证记录（2026-10-01）

- `npm run build:web` 产出 `dist/index.html` + `dist/assets/*`；`npm --workspace web run typecheck` 干净。
- 真机（daemon `127.0.0.1:4597`）走过：会话列表（按 repo 分组、`waiting-input` 排前）、详情页实时流
  （Markdown / thinking 折叠 / 工具卡）+ 门禁栏、待处理页的**真实**门禁审批框（多题整批提交）、
  发起任务 Sheet（Combobox 分组、`repoK` 起了一个会话）、设置页真实写入
  （`theme: dark → light → dark`，两次都生成 `settings.json.bak-<UTC>`）、详情页发送区真的把一条消息
  写进了会话的 inbox（`已写进 inbox（msg-…）`）。
- 离线：把静态产物挂在一个没有 API 的服务器上打开，面板显示「daemon 未连接 / SSE 已断开 —— 正在自动重连」
  与 `读取会话列表失败：404`，不白屏。
- 无 token：显示 token 门页。
- 渲染异常：一个真实的崩溃（`NotificationEntry.repo` 不存在于 §8.3）被 `ErrorBoundary` 接住，
  侧栏与连接状态存活，页面给出错误原文而不是白屏。
- **门禁模板的退路行**：从面板只写理由、不选选项提交，落盘的 `answer` 是
  `✎ 不选，我说明原因：<理由>`（`resolveAnswer` 唯一接受的自由文本形状）；选项列表里没有退路行时，
  那一题就不允许用「只写理由」作答（提交按钮保持禁用）。
- **daemon 的两个修复**由新用例覆盖：`test/daemon-events.test.ts`「a subscription made before the
  transcript exists still receives its first output」、`test/daemon-questions.test.ts`「a structured
  answers list is read row by row」、`test/daemon-server.test.ts`「a structured answers list is matched
  row by row, never re-split as text」。
