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

手动 `start` 与会话自动拉起共用同一份实现（探测 → 抢 `~/.pi/agent/rg-daemon/start.lock` → 起
`daemon run`）：已经在跑时再 `start` 只会打印它、退 0；两个进程同时启动也只有一个会 spawn。
launchd 那一份直接跑同一个 `daemon run`，它**不抢锁** —— 不会打架靠的是两件事：`run` 绑端口前先探测、
已有一份在答就以 0 退出（否则在 `KeepAlive.SuccessfulExit=false` 下会变成每 30 s 重起的失败循环），
以及端口本身（绑不上的那一份以 1 退出）。自动拉起失败只写日志（`review-gate[daemon] …`），
**绝不阻塞、也绝不影响你的会话**。

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
  绝对路径的 node + `scripts/pi-gate.mjs` + `daemon run --port …`，并把 `RG_DAEMON_HOME` 与
  **装它那个 shell 的 `PATH`** 一起写进去。
  plist 的位置**永远是真实的 `~/Library/LaunchAgents`**（launchd 只看那里）——
  `RG_DAEMON_HOME` 改的是 daemon 自己读哪个 home，不会把登录项搬到别处。
- **`PATH` 必须跟着走，否则定时任务一次也起不来**：launchd 给 job 的 PATH 是
  `/usr/bin:/bin:/usr/sbin:/sbin`，里面**没有** Homebrew 的 tmux（`/opt/homebrew/bin/tmux`）。
  daemon 起一个定时会话的第一步是 `execFileSync("tmux", …)`，找不到可执行文件就断在最前面，
  每次到点只记一条 `run-skipped`（理由：「读不到 tmux server（list-sessions 失败）」，实测 2026-10-02）。
  写进去的是**装它那个 shell 的 PATH**（`buildLaunchdPlist` 的 `deps.path`，缺省 `process.env.PATH`），
  不是猜出来的 Homebrew 前缀 —— nix / macports / 自定义安装都跟着走。
  **已经装过登录项的机器要重跑一次 `pi-gate daemon install` 才会拿到这条 PATH。**
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

## 3. 定时任务

daemon 自己带一个调度器：**到点起一个普通 loop 会话**去执行那个任务，并把这次运行记进台账。
表在 `~/.pi/agent/rg-daemon/schedules.json`，台账在 `~/.pi/agent/rg-daemon/schedule-runs.jsonl`
（每个字段、每个 endpoint 见 `docs/daemon/api.md` §13）。

**怎么配**（两个入口，都不用你手写文件）：

- **面板**：「新建定时任务」填 name / repo / cron / 需求 → 面板调 `POST /api/schedules/author`，
daemon 起一个 authoring 会话跟你谈；
- **会话**：在 loop / orchestrator 会话里直接说「每天 9 点跑一次 X」，agent 调 `schedule_task` 工具
（judge / worker / 编排子会话 / normal 模式里这个工具只允许 `list` —— 契约协商要对话框，
那四类会话没有可拿来当调度契约的本会话契约）。

两条路是同一条：**先反述需求 → 你确认 → goal 审计 → 你批准 goal → 契约落表**。
面板的写路径（`PUT /api/schedules/:id`）只接受 `name` / `cron` / `enabled`；当前面板 UI 提供
启停与改周期（改名请用会话里的 `schedule_task`）；**改需求或换 repo 一律回到
 authoring 会话重谈** —— 契约绑着你批准过的那两段文本的 hash，一个文本框悄悄改掉需求，
这个定时任务就不再是你批准的那个了。

运行起来的会话里，`RG_SCHEDULE_ID` / `RG_SCHEDULE_RUN` 标着是哪个任务的哪一次运行；
门禁在 `session_start` 按它们把契约**从 `schedules.json` 读回来**（hash 校验 + 任务 repo 相符 +
台账里那条 `run-started` 就是本会话，四道闸全过才生效），**写出** `.pi/loop-goal.md` 与 sidecar 的
`restatement` / `loopGoal`；干完活照常走门禁
（有代码改动就要过 reviewer）—— 台账里**只有记录过 READY** 的那次才算 `passed`。

**两条不会变的行为**：

- **错过的时点跳过，不补跑**。到点时没有启动运行的 cron 时刻（daemon 没在跑，或本任务自己还有一次运行没结算）
  一律跳过 —— 不会「补跑一次」，更不会把停机一周的七个槽位补齐；下一次真实到点照常跑。
  跳过是**消费掉**那一槽（基准前移），所以它不会变成「从此再也不跑」。台账里有证据：
  `GET /api/schedules/:id/runs` 里能看到一条 `run-skipped`，`reason` 点名被错过的那个时刻**与成因**。
  只有距 now 10 分钟以内（`SLOT_GRACE_MS`）的迟到 tick 仍算「到点」—— 那是不误杀正常的抖动，不是补跑。
- **同一个 repo 同时只有一个写者**。上一个运行还没结算时，同一 repo 的下一个任务不启动；
  同一 repo 上还有**别的活会话**时也不启动（哪怕那个会话已经 `declare_done`、只是窗口还开着）。
  两种情况都在台账里记一条 `run-skipped`，`reason` 写明是谁占着（`runId` 或 `sessionId`）—— 理由同上：
  门禁不会为运行会话启动，那样它连契约都继承不了。（daemon 自己开的运行窗口在结算时就关掉，所以它不会变成长期占用者；
  占住 checkout 的一般是你自己的会话。）

**排障**：

| 症状 | 看哪里 |
| --- | --- |
| 到点没动静 | `GET /api/schedules` 的 `nextRunAt`：它**不会停在很久以前**（错过的时点被跳过，这个字段已经滑到下一个）—— 如果 `GET /api/schedules/:id/runs` 里最后一条 `run-started` 没有对应的 `run-settled`，它是在等那次运行结束；如果那里面有一条点名该时点的 `run-skipped`，那一次就是被跳过的那一次（成因写在 `reason` 里：daemon 当时不在跑，或本任务自己还有一次运行没结算）；`enabled:false` 则根本没有下一次 |
| 没跑起来 | `GET /api/schedules/:id/runs`：`run-skipped` 的 `reason` 说清为什么 —— repo 上还有**未结算的运行**（点名 `runId`）、repo 上还有**别的活会话**（点名 `sessionId` 与最后心跳；哪怕它已经 `declare_done`，只要进程还在就算）、或起会话失败 |
| 会话起来了但不干活 | 面板打开那个会话（`GET /api/sessions` 里找 `RG_SCHEDULE_RUN` 对应的那条）—— 它就是一个普通会话，等回答 / 卡住都照旧显示 |
| outcome 看不懂 | `passed` 只来自 READY；`gone` = 读不到门禁 state 或会话异常消失；`failed` = 结束了但结论不是 READY/BLOCKED |
| 表坏了 | daemon **不会**把损坏的表当成空表：`GET /api/schedules` 报 500、`daemon.log` 里有原因；修好之前调度停摆（这是故意的） |

---

## 4. macOS 菜单栏 app

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

## 5. 通知：同一时刻只有一个发送者

规则只有一条（用户决定，`docs/daemon/api.md` §8.1）：

| 情况 | 谁发通知 |
| --- | --- |
| **菜单栏 app 在跑、它自己发得出来（`canPost`）、且 daemon 在线** | **菜单栏 app** 独家发；终端侧 `terminal-notifier` 自己抑制 |
| 其余任何情况（app 没跑 / app 发不出来 / daemon 不在线 / 读不出来） | 终端侧照旧发（和没有 daemon 时完全一样） |

三条判定：**daemon 在线**是冻结的那一条（`docs/daemon/api.md` §3：state 文件可解析 + pid 活着 +
带 token 的 `/api/health` 1 秒内 200）；**app 在跑而且发得出来**是 app 自己写的心跳
（`~/.pi/agent/rg-daemon/menubar.json`，每 5 s 一次，20 s 内算新鲜；pid 要是正整数且活着，`canPost` 要为真）。
**任一条读不出来一律按「不是它发」处理**
—— 因为「没发出来」比「多发一条」贵得多。所以把 daemon 停掉、把菜单栏 app 关掉、
或者在系统设置里撤掉它的通知权限，终端通知立刻就恢复了。

事件与去重：

- 触发三类：会话进入 `waiting-input`、会话完成、会话异常退出（子会话 / judge / worker 不产生通知，
  它们的问题归项目经理）。
- 菜单栏订阅 daemon 的 SSE `notification` 事件，事件里带着**门禁自己算好的**标题、正文与 key，
  发送前先 `POST /api/notifications/claim`：只有 `claimed: true` 才真的发；`duplicate`
  （10 分钟内同一条事实已发过）与 `throttled`（5 分钟最多 5 条）都不发。
  台账是**app 自己**的：终端侧走的是会话 sidecar 里它自己的历史，而且两边对同一条事实算出的 `key`
  并不相同 —— 两个发送方不会各发一条，靠的是上面那条选举（app 在场时终端侧整体抑制），
  不是这份台账。
- 点击通知跳到该会话的面板页（`/sessions/<id>`）。
- **通知权限被拒绝时静默降级**：菜单栏与其他功能照常，只是没有横幅 —— 而且**终端侧会接管**：
  app 把系统的授权状态写进心跳（`canPost`，每次都重新问 `getNotificationSettings`），
  终端侧只在这一项为真时才抑制，所以「权限关掉的 app」不会把终端也一起锁死。
- **app 关掉也还有横幅**：app 每次刷新（5 秒）写一个心跳，终端侧只在「心跳新鲜 + pid 活着 + `canPost` 为真 + daemon 在线」
  时才抑制；把 app 退出（或撤掉它的通知权限）后，最多 20 秒终端通知就接管了 —— 两边都不会出现「谁都发不出来」的窗口。

---

## 6. 文件与排障

| 路径 | 是什么 |
| --- | --- |
| `~/.pi/agent/rg-daemon.json` | state（0600）：pid / port / startedAt，**不含 token** |
| `~/.pi/agent/rg-daemon.token` | token（0600，32 字节 base64url） |
| `~/.pi/agent/rg-daemon/daemon.log` | 后台进程的 stdout+stderr |
| `~/.pi/agent/rg-daemon/questions/…` | 待答问题协议（生产者是门禁，见 api.md §7） |
| `~/.pi/agent/rg-daemon/menubar.json` | 菜单栏 app 的心跳（`{schema,pid,at,canPost}`，每 5 秒重写；终端侧靠它决定要不要抑制，api.md §8.1） |
| `~/.pi/agent/rg-daemon/notifications/` | 通知台账（每 key 一个 claim + 追加式 history） |
| `~/.pi/agent/rg-daemon/schedules.json` | 定时任务表（0600，原子写；上面 §3） |
| `~/.pi/agent/rg-daemon/schedule-runs.jsonl` | 定时运行的台账（0600，只追加；上面 §3） |
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
