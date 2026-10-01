# pi-gate daemon —— 用户视角

> 这份文件讲**怎么用**。HTTP 契约（每个 endpoint、每个字段、鉴权、冻结的在线判定规则）
> 是 `docs/daemon/api.md`，那是唯一权威出处，本文不重复、也不覆盖它。

一个常驻的 Node 进程（**不是 pi 扩展**），只监听 `127.0.0.1`，把本机所有 pi 会话聚合起来，
对外提供 web 面板与 macOS 菜单栏所需的一切：会话列表与实时输出、待答问题、发消息、起任务、
配置读写、通知事件与去重台账。

它自己不做决定：状态从 pi 自己的登记、tmux 与转写里读（唯一权威是 `docs/daemon/api.md` §5），
通知是否该发由门禁自己的节流规则裁。

---

## 1. 三种启动方式（都在，互不打架）

| 方式 | 怎么做 | 适合 |
| --- | --- | --- |
| **launchd 登录项** | `pi-gate daemon install` | 长期常驻：登录自启、**崩溃才重起** |
| **手动** | `pi-gate daemon start` / `stop` / `status` | 一次性控制、调试 |
| **会话自动拉起** | 什么都不用做 | 门禁在 `session_start` 时发现它不在线，就在后台把它拉起来 |

三者共用同一份实现与同一把锁（`~/.pi/agent/rg-daemon/start.lock`），所以**永远只有一份**：
已经在跑时再 `start` 只会打印它、退 0；两个进程同时启动也只有一个会 spawn。
自动拉起失败只写日志（`review-gate[daemon] …`），**绝不阻塞、也绝不影响你的会话**。

```bash
pi-gate daemon status     # 在线判定结果与理由（在线退 0，离线退 1）
pi-gate daemon start      # 已在线则不起第二份
pi-gate daemon stop       # SIGTERM，等它真的退出再清 state；不强杀
pi-gate daemon install    # launchd 登录项：写 plist 并 bootstrap
pi-gate daemon uninstall  # bootout 并删除 plist
```

`start` 的两种形态：默认后台（脱离终端，日志进 `~/.pi/agent/rg-daemon/daemon.log`），
`--foreground` 用于调试。`--port <n>` 改端口（默认 **4597**）、`--workspace-root <path>`
把某个目录下的一级 git 仓库加进「候选仓库」（面板「发起任务」用，可重复）。

### launchd 那一份的准确行为

- `install` 写 `~/Library/LaunchAgents/com.pi.review-gate.daemon.plist`，内容是事实拼出来的：
  绝对路径的 node + `scripts/pi-gate.mjs` + `daemon run --port …`，并把 `RG_DAEMON_HOME` 一起写进去。
  plist 的位置**永远是真实的 `~/Library/LaunchAgents`**（launchd 只看那里）——
  `RG_DAEMON_HOME` 改的是 daemon 自己读哪个 home，不会把登录项搬到别处。
- **`RunAtLoad` + `KeepAlive.SuccessfulExit = false`**：登录起来；进程**崩溃**（非 0 退出）会被重起；
  而 `pi-gate daemon stop` 的干净退出（0）**不会**被拉回来 —— 否则这个命令就永远停不下来。
  实测（2026-10-01）：`launchctl kickstart -k` 后 4 秒内就起来了；`kill -9` 之后约 30 秒自动重起
  （`ThrottleInterval` 是重起的下限，不是上限：崩溃不会立刻回来）；`pi-gate daemon stop` 之后等 35 秒仍不在。
- `ThrottleInterval` 30 秒：起不来的情况最多每 30 秒重试一次，不会疯狂刷日志（崩溃重起同样受它限制）。
- 如果你在 install 之前已经手动起了一份：那一份继续服务，launchd 的这份发现端口已有人答
  **以 0 退出**（不会变成「地址被占用」的重启循环）。想让它接管：
  `pi-gate daemon stop && launchctl kickstart -k gui/$(id -u)/com.pi.review-gate.daemon`。
- 排查：`launchctl print gui/$(id -u)/com.pi.review-gate.daemon`；日志在 `daemon.log`（plist 里也指向它）。

---

## 2. web 面板

daemon 会在 `http://127.0.0.1:<port>/` 上托管面板（`npm run build:web` 的产物；
没有产物时会返回一页说明，不是 500）。鉴权是所有 `/api/*` 用 token，见 `docs/daemon/api.md` §2。

面板的会话详情页地址是：

```
http://127.0.0.1:<port>/sessions/<sessionId>
```

菜单栏 app 的会话行、以及系统通知的点击，用的都是这个地址。端口变了（`--port`）地址跟着变，
但路径不变。

---

## 3. macOS 菜单栏 app

源码在 `menubar/Sources/*.swift`，用本机 `swiftc` 直接编成一个小 `.app`（**没有 Xcode 工程、
没有 Electron、没有 Rust/Tauri**）：

```bash
bash menubar/build.sh          # 产出 menubar/build/PiGate.app（并 ad-hoc 签名）
bash menubar/build.sh --run    # 顺带启动
open menubar/build/PiGate.app
```

- `build.sh` 会把**当前 node 的绝对路径**写进 `Info.plist`（Finder 启动的 app 只有最小 PATH，
  找不到 nvm/Homebrew 的 node）。**换 node 之后请重新构建。**
- app 从**自己所在的位置**反推仓库根（`<repo>/menubar/build/PiGate.app`），所以它必须待在
  仓库里 —— 拷到别处就没法用「启动/停止 daemon」。
- 只出现在菜单栏（`LSUIElement`，不进 Dock）。菜单内容：daemon 在线状态与端口、
  「N 个会话 · M 个待答 · K 个异常」、每个活跃会话一行（点开面板跳到该会话）、待答问题、
  打开面板、启动/停止 daemon、退出。
- daemon 不在线时菜单显式显示「未运行」+ 原因，并给「启动 daemon」，**不会假装健康**；
  通信失败不崩（错误就写在菜单里）。
- **首次打开被拦下**：这是本地 ad-hoc 签名、没有公证的包，macOS 可能在「系统设置 → 隐私与安全性」
  里需要你点一次「仍要打开」（或在 Finder 里右键 → 打开）。这一步只做一次。

---

## 4. 通知：同一时刻只有一个发送者

规则只有一条（用户决定，`docs/daemon/api.md` §8.1）：

| daemon 状态 | 谁发通知 |
| --- | --- |
| **在线**（探测成功） | **菜单栏 app** 独家发；终端侧 `terminal-notifier` 自己抑制 |
| **不在线 / 探测不成功** | 终端侧照旧发（和没有 daemon 时完全一样） |

「在线」的定义是冻结的（`docs/daemon/api.md` §3）：state 文件可解析 + pid 活着 +
带 token 的 `/api/health` 1 秒内 200。**探测失败一律按不在线处理** —— 因为「没发出来」
比「多发一条」贵得多。所以把 daemon 停掉，终端通知立刻就恢复了。

事件与去重：

- 触发三类：会话进入 `waiting-input`、会话完成、会话异常退出（子会话 / judge / worker 不产生通知，
  它们的问题归项目经理）。
- 菜单栏订阅 daemon 的 SSE `notification` 事件，事件里带着**门禁自己算好的**标题、正文与 key，
  发送前先 `POST /api/notifications/claim`：只有 `claimed: true` 才真的发；`duplicate`
  （10 分钟内同一条事实已发过）与 `throttled`（5 分钟最多 5 条）都不发。
  台账是共享的，所以两个发送方不会各发一条同样的消息。
- 点击通知跳到该会话的面板页（`/sessions/<id>`）。
- **通知权限被拒绝时静默降级**：菜单栏与其他功能照常，只是没有横幅。
- **一个诚实的限制**：daemon 在线时若菜单栏 app 没在运行，就没人发横幅（launchd 只管 daemon，
  不会替你启动 app）；而事件是事件，补不回来。要么让 app 常驻，要么接受这一段里没有横幅
  —— 这正是「在线就是菜单栏独家发」这条规则的含义。

---

## 5. 文件与排障

| 路径 | 是什么 |
| --- | --- |
| `~/.pi/agent/rg-daemon.json` | state（0600）：pid / port / startedAt，**不含 token** |
| `~/.pi/agent/rg-daemon.token` | token（0600，32 字节 base64url） |
| `~/.pi/agent/rg-daemon/daemon.log` | 后台进程的 stdout+stderr |
| `~/.pi/agent/rg-daemon/questions/…` | 待答问题协议（生产者是门禁，见 api.md §7） |
| `~/.pi/agent/rg-daemon/notifications/` | 通知台账（每 key 一个 claim + 追加式 history） |
| `~/Library/LaunchAgents/com.pi.review-gate.daemon.plist` | launchd 登录项（`install` 写、`uninstall` 删） |
| `menubar/build/PiGate.app` | 菜单栏 app 的构建产物（`menubar/build.sh`） |

`RG_DAEMON_HOME` 覆盖 agent home（默认 `$HOME`）：CLI、daemon 后台子进程、菜单栏 app
、通知抑制探测与门禁写待答问题的位置读的都是同一个变量，所以设了它，这几处会一起走。
唯一的例外是 launchd 的 plist 落点（永远是真实的 `~/Library/LaunchAgents`，上面 §1 已说明）。

常见问题：

- **`status` 说离线但进程在**：看 `token` 文件在不在、端口是否被别的东西占了
  （`lsof -i :4597`）；判定是三条全过，缺哪一条 `status` 都会写明。
- **`stop` 拒绝发 SIGTERM**：state 里的 pid 活着，但带 token 的健康检查没确认它就是 daemon
  —— pid 会被复用，所以它宁可不杀。确认那个 pid 是什么之后再手动处理。
- **面板打不开 / 只有说明页**：跑一次 `npm run build:web`（面板构建属于 web 工作区）。
- **菜单栏图标在，但没有数据**：看菜单第一行 —— 它会写明离线原因（找不到 state 文件、HTTP 401、
  端口不通）。daemon 起来后 5 秒内自动恢复。
- **通知不响**：先确认是 daemon 在线（那就不该由终端发）→ 再看 app 是否在跑 →
  最后看系统设置里 `pi-gate` 的通知权限。
