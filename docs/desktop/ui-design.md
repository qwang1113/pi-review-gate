# 桌面客户端 UI/UX 设计规格（GPUI · macOS）

本文是 GPUI（Rust）桌面客户端的界面规格，实现直接照本文与 `desktop/design/tokens.json` 做。
设计判断由 `gemini-3.8-flash`（antigravity，thinking high）两轮给出，本文在其基础上统一了数值、
删掉了与门禁对话框模板冲突的部分。

**修订 2（参照 Qoder）**：用户反馈「太生硬不流畅」。本版参照本机 Qoder 的设计语言（提取事实与出处见
`docs/desktop/qoder-reference.md`），并再次咨询 `gemini-3.8-flash` 后改了五件事：侧栏可**完全收起**（§4.4）；
所有对话框改为**右侧抽屉**（§6）；新增**配置页**（§7）；状态条的**未满足项浮卡与 ANSI 彩色文本**（§9）；
**全局动效清单**重写（§11），每处都写明「减少动态效果」下的降级。

**GPUI 能力边界**（本版所有动效都在这个边界内设计）：没有背景模糊、没有 squircle、**不能缩放一个 div**
（`desktop/src/ui/dialogs.rs` 的注释）。所以本文不用 `scale` 做进出场或按下反馈，一律用 opacity、位移
（相对定位偏移）、宽高与颜色插值；图标类元素的「弹一下」用**图标尺寸**插值代替缩放。弹簧用
`motion.spring.*` 的解析解做 easing 函数，时长取它的 `settle`（§11.2）。

**唯一数值来源**：`desktop/design/tokens.json`。本文所有「Token 表」行（首列是反引号 token 名的表格行）
与 JSON 逐项一致；改数值时两处一起改。Rust 端从 JSON 读取或生成常量，组件代码里不写字面色值/尺寸。

约定：尺寸单位 px，时长单位 ms，缓动是 `cubic-bezier(x1, y1, x2, y2)` 的四个控制点；颜色是 `#RRGGBB`
或带透明度的 `#RRGGBBAA`。「深色 / 浅色」跟随 macOS 外观设置切换，不提供应用内开关。

---

## 1. 信息架构与布局网格

```
┌──────────────────────────────────────────────────────────────────────┐
│ ● ● ● [≡]   标题栏 38px（红绿灯保护区 78，侧栏开关 x=80，标题从 x=116 起）   │
├───────────────┬─────────────────────────────────────┬────────────────┤
│ 会话/标签列表  │  聊天区（内容最大宽 840，居中）      │ 右侧抽屉       │
│ 默认 260      │   用户消息 / assistant / thinking     │ （只在有问题时） │
│ (200–400 拖拽) │   工具卡片 / diff                    │ 单选/多选 440  │
│ ⌘B 收到 0    │                                    │ 长文本 640     │
│               │  ┌ composer 44–180 ───────────────┐  │                │
│               │  └────────────────────────────────┘  │                │
├───────────────┴─────────────────────────────────────┴────────────────┤
│ 状态条 28px：mode · 分支 · 轮 N · 未满足项（点击向上弹浮卡） · setStatus 彩色文本  │
└──────────────────────────────────────────────────────────────────────┘
所有门禁提问与 pi 原生 select/input/confirm/editor 都在右侧抽屉里（§6）；抽屉把聊天区向左挤，不盖住 composer。
⌘, 把主区域切成配置页（§7）。
```

- 基线网格 4px：`space.*` 间距 token 与布局级尺寸（侧栏、行高、按钮、对话框、输入框）落在 4 的倍数上。
  组件内部的细部数值按视觉对齐取值、不受此限：标题栏 38 / 18 / 78 / 80 / 116 对齐 macOS 红绿灯与侧栏开关，侧栏行高 30（参照 Qoder 的紧凑行），徽标高 18、
  文字内边距（10/14、2/5、2/6 等）、Markdown 标题上下外边距、描边 1/1.5/2、进度条 3、段间距 2。
- 抽屉属于**某个会话**：切到别的会话时抽屉随之收起（不走退场动画，跟着聊天区一起换掉），切回来原样恢复
  （含理由编辑器里的草稿与滚动位置）。这样一个子会话在等回答时，用户仍能去看别的会话。
- 侧栏只有两档：**展开**或**完全收起（0 宽）**，没有图标栏。窗口宽 < `breakpoint.sidebar_overlay`（960）时
  侧栏自动收起，展开它得到的是覆盖式左抽屉；规则全在 §4.4。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.window.default_width` | 1280 | 首次启动窗口宽 |
| `size.window.default_height` | 800 | 首次启动窗口高 |
| `size.window.min_width` | 720 | 最小宽 |
| `size.window.min_height` | 560 | 最小高 |
| `size.breakpoint.sidebar_overlay` | 960 | 小于它侧栏自动收起、展开时为覆盖式抽屉 |
| `size.titlebar.height` | 38 | 透明标题栏高 |
| `size.titlebar.traffic_light_inset` | 18 | 红绿灯左边距 |
| `size.titlebar.traffic_light_reserve` | 78 | 红绿灯保护区宽 |
| `size.titlebar.title_x` | 116 | 标题文本起点（侧栏开关之后） |
| `size.titlebar.toggle_x` | 80 | 侧栏开关按钮左沿 |
| `size.titlebar.button` | 28 | 标题栏按钮边长 |
| `size.titlebar.badge_pill_height` | 14 | 开关上「等你回答」计数胶囊高 |
| `size.sidebar.width_default` | 260 | 侧栏默认宽 |
| `size.sidebar.width_min` | 200 | 拖拽下限 |
| `size.sidebar.width_max` | 400 | 拖拽上限 |
| `size.sidebar.resize_handle` | 4 | 拖拽手柄可见宽 |
| `size.sidebar.resize_hit` | 8 | 拖拽热区宽 |
| `size.statusbar.height` | 28 | 状态条高 |
| `size.statusbar.padding_x` | 12 | 状态条左右内边距 |
| `size.chat.max_width` | 840 | 聊天内容最大宽 |
| `size.chat.padding_x` | 32 | 聊天区左右内边距 |
| `size.chat.padding_top` | 16 | 聊天区顶部内边距 |
| `size.chat.padding_bottom` | 24 | 聊天区底部内边距 |

---

## 2. 设计 Token

### 2.1 颜色

| Token | 深色 | 浅色 | 用途 |
|:---|:---|:---|:---|
| `color.bg.app` | #121214 | #F4F4F6 | 窗口底层 |
| `color.bg.surface` | #18181B | #FFFFFF | 侧栏、状态条、输入容器、选项行 |
| `color.bg.elevated` | #222226 | #F9F9FB | hover 底、卡片 |
| `color.bg.overlay` | #27272C | #FFFFFF | 抽屉、浮卡、横幅 |
| `color.bg.scrim` | #00000080 | #0000004D | 覆盖式侧栏抽屉的遮罩（§4.4） |
| `color.bg.scrim_drawer` | #00000033 | #0000001A | 右侧抽屉打开时压暗聊天消息流（§6.1，只压暗、不拦截指针） |
| `color.border.subtle` | #27272A | #E4E4E7 | 弱分割线 |
| `color.border.default` | #3F3F46 | #D4D4D8 | 标准边框、树状引导线 |
| `color.border.strong` | #52525B | #A1A1AA | 强边框、未勾选复选框 |
| `color.border.focus` | #6366F1 | #4F46E5 | 键盘焦点边框 |
| `color.text.primary` | #F4F4F5 | #09090B | 主文字 |
| `color.text.secondary` | #A1A1AA | #52525B | 次级文字 |
| `color.text.muted` | #71717A | #71717A | 时间戳、辅助说明 |
| `color.text.disabled` | #52525B | #A1A1AA | 禁用文字 |
| `color.text.on_accent` | #FFFFFF | #FFFFFF | 强调色底上的文字 |
| `color.accent.primary` | #6366F1 | #4F46E5 | 品牌强调（Indigo） |
| `color.accent.hover` | #4F46E5 | #4338CA | 强调 hover |
| `color.accent.pressed` | #3730A3 | #3730A3 | 强调 pressed |
| `color.accent.subtle` | #1E1B4B | #EEF2FF | 选中底色 |
| `color.focus.ring` | #818CF880 | #6366F166 | 焦点外发光 |
| `color.status.working` | #38BDF8 | #0284C7 | working |
| `color.status.waiting_input` | #FB923C | #EA580C | waiting-input |
| `color.status.waiting_judge` | #A855F7 | #9333EA | waiting-judge |
| `color.status.idle` | #94A3B8 | #64748B | idle |
| `color.status.done` | #22C55E | #16A34A | done |
| `color.status.dead` | #EF4444 | #DC2626 | dead |
| `color.semantic.success` | #22C55E | #16A34A | 成功 |
| `color.semantic.warning` | #F59E0B | #D97706 | 警告、未满足项 |
| `color.semantic.danger` | #EF4444 | #DC2626 | 错误、中止按钮 |
| `color.semantic.info` | #38BDF8 | #0284C7 | 提示 |
| `color.badge.rec.bg` | #082F49 | #E0F2FE | 「（推荐）」标牌底 |
| `color.badge.rec.text` | #38BDF8 | #0284C7 | 「（推荐）」标牌字 |
| `color.badge.rec.border` | #0369A1 | #BAE6FD | 「（推荐）」标牌边 |
| `color.diff.add.bg` | #143521 | #E6F6EC | 新增行底 |
| `color.diff.add.text` | #4ADE80 | #15803D | 新增行字 |
| `color.diff.add.gutter` | #166534 | #BBF7D0 | 新增行号栏 |
| `color.diff.add.word` | #235A36 | #ACE7C4 | 行内新增高亮 |
| `color.diff.del.bg` | #3E1818 | #FEE8E8 | 删除行底 |
| `color.diff.del.text` | #F87171 | #B91C1C | 删除行字 |
| `color.diff.del.gutter` | #991B1B | #FECACA | 删除行号栏 |
| `color.diff.del.word` | #5E2626 | #F8B4B4 | 行内删除高亮 |
| `color.diff.header.bg` | #1E1E22 | #EAEAEF | diff 文件头 |
| `color.diff.hunk.bg` | #1A202C | #EFF6FF | hunk 头底 |
| `color.diff.hunk.text` | #60A5FA | #2563EB | hunk 头字 |
| `color.chat.user.bg` | #27272A | #E4E4E7 | 用户消息气泡 |
| `color.chat.avatar.bg` | #312E81 | #E0E7FF | assistant 头标底 |
| `color.chat.avatar.fg` | #818CF8 | #4F46E5 | assistant 头标图标 |
| `color.code.inline.bg` | #27272A | #E4E4E7 | 行内代码底 |
| `color.code.inline.text` | #F4F4F5 | #18181B | 行内代码字 |
| `color.code.block.bg` | #1E1E22 | #F1F1F4 | 代码块底 |
| `color.thinking.bg.collapsed` | #18181B | #F4F4F5 | thinking 折叠条底 |
| `color.thinking.bg.expanded` | #141416 | #F8F8FA | thinking 展开底 |
| `color.thinking.border` | #3F3F46 | #D4D4D8 | thinking 左边框 |
| `color.thinking.text` | #A1A1AA | #71717A | thinking 正文 |
| `color.tool.result.bg` | #121214 | #ECECEF | 工具结果区底 |
| `color.tool.error.border` | #7F1D1D | #FCA5A5 | 失败工具卡边框 |
| `color.tool.error.header_bg` | #2A1215 | #FEF2F2 | 失败工具卡头部底 |
| `color.tool.error.text` | #FCA5A5 | #991B1B | 失败工具结果字 |
| `color.button.danger.bg` | #7F1D1D | #FEE2E2 | danger 按钮底 |
| `color.button.danger.text` | #FCA5A5 | #B91C1C | danger 按钮字 |
| `color.button.danger.border` | #991B1B | #FCA5A5 | danger 按钮边 |
| `color.button.danger.hover_bg` | #991B1B | #DC2626 | danger hover 底 |
| `color.button.danger.hover_text` | #FFFFFF | #FFFFFF | danger hover 字 |
| `color.button.danger.pressed_bg` | #B91C1C | #B91C1C | danger pressed 底 |
| `color.mode.orchestrator.bg` | #581C87 | #F3E8FF | 状态条 mode 徽标 |
| `color.mode.orchestrator.text` | #E9D5FF | #7E22CE | 〃 |
| `color.mode.loop.bg` | #1E3A8A | #DBEAFE | 〃 |
| `color.mode.loop.text` | #BFDBFE | #1D4ED8 | 〃 |
| `color.mode.explore.bg` | #78350F | #FEF3C7 | 〃 |
| `color.mode.explore.text` | #FDE68A | #B45309 | 〃 |
| `color.mode.normal.bg` | #3F3F46 | #F4F4F5 | 〃 |
| `color.mode.normal.text` | #F4F4F5 | #3F3F46 | 〃 |
| `color.doc.restatement.bg` | #1E293B | #E0F2FE | 长文本框类型徽标：需求反述 |
| `color.doc.restatement.text` | #38BDF8 | #0369A1 | 〃 |
| `color.doc.restatement.border` | #0369A1 | #BAE6FD | 〃 |
| `color.doc.goal.bg` | #2E1065 | #F3E8FF | 类型徽标：goal |
| `color.doc.goal.text` | #C084FC | #7E22CE | 〃 |
| `color.doc.goal.border` | #7E22CE | #D8B4FE | 〃 |
| `color.doc.plan.bg` | #064E3B | #D1FAE5 | 类型徽标：plan |
| `color.doc.plan.text` | #34D399 | #047857 | 〃 |
| `color.doc.plan.border` | #047857 | #6EE7B7 | 〃 |
| `color.ansi.0` | #52525B | #18181B | ANSI black（§9.3） |
| `color.ansi.1` | #F87171 | #DC2626 | ANSI red |
| `color.ansi.2` | #4ADE80 | #16A34A | ANSI green |
| `color.ansi.3` | #FACC15 | #CA8A04 | ANSI yellow |
| `color.ansi.4` | #60A5FA | #2563EB | ANSI blue |
| `color.ansi.5` | #C084FC | #9333EA | ANSI magenta |
| `color.ansi.6` | #22D3EE | #0891B2 | ANSI cyan |
| `color.ansi.7` | #D4D4D8 | #52525B | ANSI white（浅色下换成深灰，否则白底白字） |
| `color.ansi.8` | #71717A | #71717A | ANSI bright black |
| `color.ansi.9` | #FCA5A5 | #B91C1C | ANSI bright red |
| `color.ansi.10` | #86EFAC | #15803D | ANSI bright green |
| `color.ansi.11` | #FDE047 | #A16207 | ANSI bright yellow |
| `color.ansi.12` | #93C5FD | #1D4ED8 | ANSI bright blue |
| `color.ansi.13` | #D8B4FE | #7E22CE | ANSI bright magenta |
| `color.ansi.14` | #67E8F9 | #0E7490 | ANSI bright cyan |
| `color.ansi.15` | #FAFAFA | #09090B | ANSI bright white（浅色下是近黑） |

品牌色保持 Indigo，不跟 Qoder 换墨绿：绿色在本仓是 `status.done`，换过来会和「完成」混淆。

### 2.2 字体与字号阶梯

- **UI 正文**：`SF Pro Text`（macOS 系统字体，随系统提供，不打包）；回退 `Inter`（SPDX `OFL-1.1`，随应用打包）。
  中文由系统回退到 PingFang SC。
- **等宽**：`JetBrains Mono`（SPDX `OFL-1.1`，随应用打包，许可证文本放进应用的 licenses 目录）；
  回退 `SF Mono`、`Menlo`（系统自带）。
- 斜体一律不用（中文斜体失真）；thinking 也用正体，靠颜色弱化。

| Token | 字号 | 行高 | 字重 | 用途 |
|:---|:---|:---|:---|:---|
| `font.caption` | 10 | 14 | 500 | 徽标、计数、「（推荐）」标牌 |
| `font.small` | 12 | 16 | 400 | 侧栏副标、时间戳、状态条 |
| `font.code` | 12 | 18 | 400 | 代码块、diff、工具名与参数 |
| `font.code_small` | 11 | 16 | 400 | 工具结果、行号、hunk 头 |
| `font.body` | 13 | 20 | 400 | 聊天正文、选项文字、理由编辑器、h3（加粗时用 body_strong） |
| `font.body_strong` | 13 | 20 | 600 | 选项字母前缀、h3、会话名 |
| `font.base` | 14 | 22 | 400 | 抽屉标题 |
| `font.h2` | 15 | 22 | 600 | Markdown h2、长文本框标题 |
| `font.title` | 16 | 24 | 600 | 分区标题 |
| `font.display` | 18 | 26 | 700 | Markdown h1 |

### 2.3 间距、圆角

| Token | 值 |
|:---|:---|
| `space.1` | 4 |
| `space.2` | 8 |
| `space.3` | 12 |
| `space.4` | 16 |
| `space.5` | 20 |
| `space.6` | 24 |
| `space.8` | 32 |
| `space.10` | 40 |
| `radius.none` | 0 |
| `radius.xs` | 2 |
| `radius.sm` | 4 |
| `radius.md` | 6 |
| `radius.lg` | 8 |
| `radius.xl` | 12 |
| `radius.full` | 9999 |

圆角用法：`sm` 复选框、行内代码、徽标；`md` 按钮、输入框、侧栏项；`lg` 选项行、工具卡、代码块、composer；
`xl` 浮卡、配置分组卡；`full` 状态点、未读点、计数胶囊。

### 2.4 阴影（elevation）

GPUI 用 `Vec<BoxShadow>` 表达多层阴影；每层写作 `x y blur spread color`（深色 / 浅色各一组）。

| Token | 深色 | 浅色 | 用途 |
|:---|:---|:---|:---|
| `shadow.subtle` | 0 1 2 0 #00000073 | 0 1 2 0 #0000000D | 悬浮标签、浮卡 |
| `shadow.low` | 0 4 6 -1 #00000080; 0 2 4 -2 #00000059 | 0 4 6 -1 #00000014; 0 2 4 -2 #0000000A | 工具卡、菜单 |
| `shadow.mid` | 0 10 15 -3 #000000A6; 0 4 6 -4 #00000073 | 0 10 15 -3 #0000001F; 0 4 6 -4 #0000000F | 未满足项浮卡 |
| `shadow.high` | 0 20 25 -5 #000000CC; 0 8 10 -6 #00000099 | 0 20 25 -5 #00000029; 0 8 10 -6 #00000014 | 窄窗口覆盖式侧栏抽屉（§4.4） |

```rust
// shadow.low（深色）→ GPUI
vec![
    BoxShadow { offset: point(px(0.), px(4.)), blur_radius: px(6.), spread_radius: px(-1.), color: rgba(0x00000080).into() },
    BoxShadow { offset: point(px(0.), px(2.)), blur_radius: px(4.), spread_radius: px(-2.), color: rgba(0x00000059).into() },
]
```

**不用 backdrop blur**：GPUI 没有背景模糊，所有「磨砂」处一律用实色 `bg.overlay` + 顶部 1px `border.subtle` 分割线。

---

## 3. 图标

图标库 **Lucide**（https://lucide.dev），许可证 **ISC**（SPDX `ISC`；Lucide 中派生自 Feather 的部分为 MIT，
同在其 LICENSE 文件里）。只打包下表用到的 SVG，连同 LICENSE 文本一起放进应用资源；描边宽 1.5，颜色跟随文字色。

| 场景 | Lucide 图标 | 用在哪 |
|:---|:---|:---|
| 角色 | `bot` | 主会话 |
| | `crown` | 项目经理（orchestrator 主会话） |
| | `git-branch` | 编排子会话 |
| | `file-check-2` | reviewer |
| | `shield-alert` | quality-auditor |
| | `badge-check` | acceptance |
| | `target` | goal-auditor |
| | `sparkles` | adviser |
| | `wrench` | worker |
| 状态 | `loader-2`（旋转） | 工具 running |
| | `check-circle-2` | 工具 ok |
| | `alert-circle` | 工具 error、状态条未满足项 |
| | `x-circle` | dead 状态标记 |
| 聊天 | `brain` | thinking |
| | `terminal` | bash 工具 |
| | `file-text` | read 工具 |
| | `file-pen` | edit / write 工具 |
| | `plug` | 其余工具（MCP 等） |
| | `copy` / `check` | 复制 / 已复制 |
| | `chevron-right` / `chevron-down` | 折叠 / 展开 |
| | `arrow-up` | 发送 |
| | `square` | 中止 |
| 抽屉 | `circle` / `circle-dot` | 单选未选 / 已选 |
| | `square` / `square-check` | 多选未勾 / 已勾 |
| | `pencil` | 「✎ 不选，我说明原因」 |
| | `arrow-left` | 「← 返回上一题」 |
| | `message-circle-question` | 抽屉标题 |
| 状态条 | `layers` | mode |
| | `git-branch` | 分支 |
| | `refresh-cw` | 轮 N |
| | `check` | 未满足项为 0 |
| 通知 | `bell` | 应用内横幅 |
| 外壳 | `panel-left` | 标题栏侧栏开关 |
| | `settings` | 配置页入口、配置页导航 |
| | `braces` | 配置页「JSON」视图 |
| | `list` | 配置页「表单」视图 |
| | `save` | 保存 |
| | `x` | 未满足项浮卡关闭 |
| | `eye` | 配置页敏感值临时显示 |
| | `arrow-down` | 「↓ 回到最新」「↓ 还有 N 行未读」 |

---

## 4. 左侧会话 / 标签列表

### 4.1 结构与分组

```
▾ 会话
  ● [bot]    主会话 · pi-review-gate            ← 一级
▾ JUDGES                              2/5
  ◉ [file-check-2] reviewer                     ← 二级（缩进 24，左侧 1px 引导线）
  ● [shield-alert] quality-auditor
  ○ [badge-check]  acceptance
  ○ [target]       goal-auditor
  ○ [sparkles]     adviser
▾ WORKERS                             1/1
  ● [wrench] worker-1
▾ 子任务                               3/4
  ● [git-branch] t1-ui-design
  ✕ [git-branch] t2-host-protocol   [dead]
```

- 分组顺序固定：会话（主会话 / 项目经理）→ JUDGES → WORKERS → 子任务（编排子会话）。空分组不显示。
- 分组标题：高 24，`font.caption` 600、字距 0.5、英文全大写，颜色 `text.muted`，左右内边距 8；
  左侧 10px `chevron`，点击整行折叠/展开；右侧计数胶囊「活动数/总数」（活动 = working / waiting-input /
  waiting-judge），`font.caption`，底 `bg.elevated`，圆角 `full`。
- 子任务下若还开了自己的 judge / worker，它们挂在该子任务下再缩进一级（缩进 24 × 层级），不进顶层分组。
- 行：高 32，圆角 `md`，左右内边距 8，图标 16 与文字间距 8。行内从左到右：角色图标（状态点压在图标
  右下角，偏移 -2/-2）→ 会话名（`font.body`，单行省略）→ 右侧附加（未读点 / dead 胶囊 / 计数）。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.sidebar.item_height` | 30 | 行高（参照 Qoder 的 30，比 32 多放一成多的行） |
| `size.sidebar.child_indent` | 24 | 每级缩进 |
| `size.sidebar.group_header_height` | 24 | 分组标题高 |
| `size.status_dot` | 8 | 状态点直径 |
| `size.unread_dot` | 6 | 未读点直径 |

### 4.2 六种状态

| 状态 | 状态点 | 动画 | 附加 |
|:---|:---|:---|:---|
| working | `status.working` 实心 | 呼吸（`motion.duration.pulse_working`） | — |
| waiting-input | `status.waiting_input` 实心 | 双跳心跳（`motion.duration.pulse_waiting_input`） | 行名加粗；分组折叠时分组标题也带同色点 |
| waiting-judge | `status.waiting_judge` 实心 | 无 | 悬停浮卡写「在等 <role>，已等 Ns」 |
| idle | `status.idle` **空心环**（1.5px 描边） | 无 | — |
| done | `status.done` 实心 | 无 | — |
| dead | 用 `x-circle` 图标（`status.dead`）替换状态点 | 无 | 行尾红色 `dead` 胶囊（`font.caption`，底 `button.danger.bg`、字 `button.danger.text`）；会话名变 `text.secondary` |

**dead 与 idle 必须一眼分开**：idle 是灰色空心环、名字颜色不变；dead 是红色叉号 + 文字胶囊 + 名字变暗。
形状和文字双重区分，不只靠颜色（色盲可辨）。

### 4.3 行的交互状态

| 状态 | 样式 |
|:---|:---|
| default | 底透明，字 `text.secondary` |
| hover | 底 `bg.elevated`，字 `text.primary`（`motion.duration.hover`，`motion.easing.standard`） |
| focus（键盘） | 1.5px `border.focus` 内描边 + `focus.ring` 2px 外发光 |
| pressed | 底 `border.subtle` |
| selected | 底 `accent.subtle`，左侧 3px `accent.primary` 竖条，字 `text.primary` |
| disabled | 不存在（会话行总可点） |
| unread | 行尾 6px `accent.primary` 实心点；选中该行即清除 |

**选中底色会滑**（参照 Qoder 设置导航）：选中底色与左竖条是**一块**覆盖层，换选中行时它从旧行的 y 滑到新行的 y
（`motion.spring.gentle`），不是旧行淡出、新行淡入。跨分组、或旧行已被折叠不可见时，退回原来的淡入
（`motion.duration.sidebar_select`）。未读点出现时直径 0→6（`motion.spring.snappy`），清除时 6→0（同一弹簧）。

### 4.4 侧栏完全收起

**入口**：`⌘B`，或标题栏左上角 28×28 的 `panel-left` 按钮（x = `titlebar.toggle_x`，垂直居中，ghost 样式，
悬停提示「收起侧栏 ⌘B」/「展开侧栏 ⌘B」）。按钮始终在标题栏里，不随侧栏消失。

**宽窗口（≥ 960）—— 推挤式**：

- 收起：侧栏宽从当前宽度 → 0，主区域同步变宽并占满窗口（聊天内容仍遵守 840 最大宽、居中）。
  时长 `motion.duration.sidebar_toggle`，曲线 `motion.easing.smooth`。侧栏容器裁剪内容，内容保持展开时的宽度不重排。
- **内容跟宽度联动**（参照 Qoder，让收起像「退到幕后」而不是被切掉）：设当前动画宽为 w，
  opacity = clamp(w / `sidebar.fade_span`, 0, 1)；横移 x = −`sidebar.slide_offset` × (1 − clamp(w / `sidebar.slide_span`, 0, 1))。
  收起时宽跌破 96 前文字已淡出、向左退 12；展开时反过来。
- 展开：回到**收起前记住的宽度**（用户拖拽过的值），同一时长曲线。动画中途再按 ⌘B 从当前宽度反向，不跳变。
- 收起状态跨启动记住。拖拽手柄把宽度拖到低于 `sidebar.width_min` 的一半并松手 = 收起。

**窄窗口（< 960）—— 覆盖式**：

- 窗口变窄跨过 960 时侧栏自动收起（走同一条收起动画）；变宽跨回 960 时恢复用户在宽窗口下最后选的状态。
- 此时 ⌘B / 按钮打开的是**覆盖式左抽屉**：宽 `sidebar.width_default`，高度从标题栏底到状态条顶，底 `bg.surface`，
  `shadow.high`，下面是 `bg.scrim` 遮罩（盖住主区域）。抽屉进场 = translateX(−100% → 0) + 上面同一条内容联动，
  `motion.duration.drawer_enter` / `motion.easing.smooth`；退场 `motion.duration.drawer_exit` / `motion.easing.exit`。
- 点遮罩、按 Esc、或选中一个会话后抽屉自动收起。

**收起时不漏掉「等你回答」**：侧栏收起（任一种）且有会话处于 waiting-input 时，开关按钮右上角叠一个
`size.unread_dot` 的 `status.waiting_input` 实心点，带与侧栏状态点相同的双跳心跳（§4.2）；≥ 2 个会话在等时换成
高 `titlebar.badge_pill_height` 的胶囊写数字（`font.caption`，底 `status.waiting_input`、字 `text.on_accent`）。⌘⇧A
任何时候都能跳到下一个在等的会话，不必先展开侧栏。

**减少动态效果**：宽度与内容直接到终态；覆盖式抽屉只做 `reduced_motion_fade` 的 opacity；角标心跳换成静态双环（§11.3）。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.sidebar.fade_span` | 96 | 内容 opacity 从 0 到 1 对应的宽度区间 |
| `size.sidebar.slide_span` | 156 | 内容横移归零对应的宽度区间 |
| `size.sidebar.slide_offset` | 12 | 内容最大左移 |
| `motion.duration.sidebar_toggle` | 220 | 收起 / 展开 |

---

## 5. 中间流式聊天区

### 5.1 消息

- **用户消息**：右对齐气泡，最大宽 = 聊天内容宽 × `ratio.chat.user_max_width`，且 ≤ `size.chat.user_max_width`；
  底 `chat.user.bg`，内边距 10/14，圆角 12/12/4/12（左上/右上/右下/左下，右下收尖）；正文 `font.body`。
  气泡上方右对齐时间戳（`font.small`，颜色 `text.muted`，下间距 4）。
- **assistant 文本**：无气泡，左对齐通栏；顶部头标 24×24（圆角 `md`，底 `chat.avatar.bg`，`bot` 图标
  `chat.avatar.fg`）+ 8px + 名称 `pi`（`font.small` 600）+ 时间（`text.muted`），下间距 8 进入正文。
- Markdown：h1 `font.display`（上 16 下 12）；h2 `font.h2`（上 14 下 8）；h3 `font.body_strong`（上 10 下 6）；
  行内代码等宽 12px（`font.code`）、底 `code.inline.bg`、字 `code.inline.text`、内边距 2/5、圆角 `sm`；
  代码块 `font.code`、底 `code.block.bg`、1px `border.subtle`、内边距 12/16、圆角 `lg`、右上角悬停出 `copy` 按钮。
- 间距：用户与 assistant 消息之间 `size.chat.message_gap`；同一条消息段落之间 `size.chat.paragraph_gap`。
- 自动跟随：视口在底部时新内容自动滚到底；用户上滚后停止跟随，右下角出「↓ 回到最新」胶囊按钮
  （胶囊进出场同§11 的 popover；会话仍在生成时胶囊的 `arrow-down` 按 `pulse_working` 呼吸，参照 Qoder）。跟随中的
  自动滚动不动画（逐帧贴底，否则流式时会拖尾）；点胶囊是程序式滚动，见 §11.4。
- **消息出现**：一条新消息（用户气泡、assistant 块、工具卡、diff）插入时整块 opacity 0→1、向下偏移
  `message.enter_shift` → 0，`motion.duration.message_enter` / `motion.easing.smooth`。加载历史消息、切换会话时已有的消息**不播**
  （只播「此刻新来的」）。
- **流式文字按词淡入**（参照 Qoder 的 streamdown `blurIn`；GPUI 没有 blur，只做 opacity）：
  1. 新到的 delta 按词切（空白与标点为界；CJK 每个字算一词），每词记一个出现时刻
     t₀ = 到达时刻 + 序号 × `motion.duration.word_stagger`，同一批的错峰总和封顶 `limit.stream.word_stagger_cap`
     （超过的词与封顶那个词同时出现，大块文字一次到达时不会越排越晚）。
  2. 每帧词的 alpha = smooth((now − t₀) / `motion.duration.word_fade`)，用文字 run 的颜色 alpha 实现
     （同一段文字拆成多个 `TextRun`，不动布局）。已成熟（≥ word_fade）的词并回普通 run。
  3. 只在还有未成熟的词时请求下一帧；全部成熟就停，空闲不占 CPU。已经显示过的文字永不重播。
  4. Markdown 结构变化（一段变成代码块等）导致重排时按字符偏移保留每词的 t₀，不重播。
  流式光标跟在最后一个词后面。减少动态效果：不淡入，文字到达即显示。
- **流式光标**：正在生成的 assistant 文本末尾一个 2×16 的竖条（`accent.primary`），按 `motion.duration.cursor_blink`
  周期闪烁（前一半显示、后一半隐藏，阶跃无渐变）；生成结束立即移除。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.chat.user_max_width` | 672 | 用户气泡最大宽 |
| `ratio.chat.user_max_width` | 0.8 | 用户气泡占内容宽比例上限 |
| `size.chat.avatar` | 24 | assistant 头标 |
| `size.chat.message_gap` | 24 | 消息间距 |
| `size.chat.paragraph_gap` | 12 | 段落间距 |
| `size.message.enter_shift` | 6 | 新消息进场的下偏移 |
| `motion.duration.message_enter` | 200 | 新消息进场 |
| `motion.duration.word_fade` | 160 | 每词淡入 |
| `motion.duration.word_stagger` | 20 | 词间错峰 |
| `limit.stream.word_stagger_cap` | 120 | 一批错峰总和上限（ms） |

### 5.2 thinking

- 默认**折叠**成一行：高 32，底 `thinking.bg.collapsed`，左边框 2px `thinking.border`，右侧圆角 6；
  内容：`brain` 14px + 摘要「思考中…」（生成中）/「已思考 14s」（结束后），`font.small`、`text.muted`，右端 `chevron-right`。
- 展开：底 `thinking.bg.expanded`，左边框贯通，内边距 8/12/8/14，正文用 UI 字体 12/18（字号行高同 `font.code`）正体，颜色 `thinking.text`。
- 生成中的 thinking 不自动展开；用户展开后流式内容在里面继续追加（同样按词淡入）。
- 折叠 / 展开：高度在 折叠条 ↔ 内容高 之间插值（裁剪），内容 opacity 同步，`chevron` 旋转 0↔90°；
  `motion.duration.collapse` / `motion.easing.smooth`。摘要文字从「思考中…」变成「已思考 14s」时两段文字交叉淡化
  （`motion.duration.hover`），不跳变。生成中 `brain` 图标按 `pulse_working` 呼吸（只变 opacity 0.5↔1）。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.thinking.collapsed_height` | 32 | 折叠条高 |

### 5.3 工具调用卡片

```
┌────────────────────────────────────────────────────────────────┐
│ [terminal] bash   git status --porcelain…          142ms  ✓  ▸ │ ← 头部 36
├────────────────────────────────────────────────────────────────┤
│ （结果区，默认折叠；展开后最大 320，内部滚动）                     │
└────────────────────────────────────────────────────────────────┘
```

- 容器：1px `border.subtle`，圆角 `lg`，底 `bg.elevated`，阴影无（聊天流里不叠阴影）。
- 头部：左右内边距 10；图标 14 + 工具名（`font.code` 600）+ 参数摘要（`font.code`、`text.muted`、单行省略、
  最大宽 420）；右侧耗时（`font.code_small`、`text.muted`；运行中实时计秒）+ 状态图标 14 + 折叠箭头 12。
- 状态：running = `loader-2` 旋转（`motion.duration.spinner_rotation` 一圈，线性）颜色 `status.working`；
  ok = `check-circle-2` `status.done`；error = `alert-circle` `status.dead`。
- 结果区：**默认折叠**；展开后内边距 10/12，`font.code_small`，底 `tool.result.bg`，最大高 320 内部滚动。
- error 态：边框 `tool.error.border`，头部底 `tool.error.header_bg`，结果文字 `tool.error.text`；**error 结果默认展开**
  （失败原因是用户最需要看的）。
- 工具参数与结果都是纯文本渲染，不解析 Markdown。
- 动效：结果区折叠展开同 thinking（高度 + opacity + 箭头 90°，`collapse` / `smooth`）。running → ok / error 时
  状态图标交叉淡化（`motion.duration.dot_color`），完成图标尺寸 10→14 走 `motion.spring.snappy`（轻轻「落定」一下）；
  error 卡自动展开也走同一条折叠动画。卡头 hover / 按下同 §8。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.tool.header_height` | 36 | 头部高 |
| `size.tool.args_max_width` | 420 | 参数摘要最大宽 |
| `size.tool.result_max_height` | 320 | 展开结果最大高 |

### 5.4 diff

- 统一视图（unified）。文件头高 32，底 `diff.header.bg`，下边框 1px `border.subtle`；左侧相对路径（`font.code` 600，
  过长从左侧省略保留文件名），右侧 `+N`（底 `diff.add.bg` 字 `diff.add.text`）与 `-M`（底 `diff.del.bg`
  字 `diff.del.text`）两枚胶囊 + `copy` 路径按钮。
- 行号栏：旧/新两列各 40，右对齐、右内边距 8，`font.code_small`、`text.muted`；新增行号栏底 `diff.add.gutter`，
  删除行号栏底 `diff.del.gutter`。
- 行：`font.code`；新增行底 `diff.add.bg`、字 `diff.add.text`，行内变化词底 `diff.add.word`；删除行同理用 `diff.del.*`；
  上下文行无底色、字 `text.secondary`。
- hunk 头 `@@ … @@`：高 24，底 `diff.hunk.bg`，字 `diff.hunk.text`，`font.code_small`。
- 超过 `limit.diff.collapse_lines` 行的 diff 默认折叠，只显示文件头 + 前 20 行，底部「展开全部 N 行」按钮。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.diff.header_height` | 32 | 文件头高 |
| `size.diff.gutter_column` | 40 | 每列行号宽 |
| `size.diff.hunk_height` | 24 | hunk 头高 |
| `limit.diff.collapse_lines` | 200 | 默认折叠阈值（行） |

### 5.5 composer（底部输入框）

- 高度随内容 44 → 180，超出内部滚动；底 `bg.surface`，1px `border.default`，圆角 `lg`；focus 时 1.5px `border.focus`
  + 2px `focus.ring`。
- 占位文字「向 pi 发送消息（Enter 发送，Shift+Enter 换行）」，`font.body`、`text.muted`。
- 右下角 28×28 按钮（圆角 `md`）：空闲有文字 = `arrow-up`，底 `accent.primary`；空闲无文字 = 禁用（底 `bg.elevated`，
  图标 `text.disabled`）；会话生成中 = `square` 10px 实心，底 `semantic.danger`，悬停提示「中止（Esc）」。
- 会话有抽屉（§6）打开时 composer 仍可输入（用户可以在框外补充；这正是门禁的「协商被插话」路径），不禁用、
  不被遮罩覆盖——抽屉是推挤式的，composer 跟聊天列一起变窄、始终可见。抽屉打开时焦点默认在抽屉；点击
  composer 或按 ⌘L 把焦点移到 composer，此后按键（含 A–D、Enter、Esc）都作用于 composer；点击抽屉或在
  composer 里按 ⌘J 把焦点移回抽屉（回到上次聚焦的那一行）。焦点在 composer 时抽屉左边框从 `border.focus`
  降为 `border.subtle`（`motion.duration.hover` 过渡），表示按键不再进入它。
- 动效：高度随内容增长时插值（`motion.duration.hover` / `smooth`）；发送后输入框清空不动画，进入消息流的气泡走
  §5.1 的消息出现；发送 ↔ 中止按钮两个图标交叉淡化、底色插值（`dot_color`）。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.composer.min_height` | 44 | 最小高 |
| `size.composer.max_height` | 180 | 最大高 |
| `size.composer.button` | 28 | 发送/中止按钮边长 |

---

## 6. 右侧抽屉（门禁提问与 pi 原生对话框）

客户端**没有居中对话框**。门禁的每一个提问（`dialog.open`：`ask_user`、goal/plan 批准、需求反述、敏感编辑、
scope 限制、模式降级等）和 pi 原生的 `select` / `input` / `confirm` / `editor`（`extension_ui_request`）都在
**同一个右侧抽屉**里出现：它不挡住聊天上下文，用户可以边看左边的讨论边作答。门禁模板规则一条不变：
字母编号 A/B/C…、「（推荐）」、「✎ 不选，我说明原因」行与多行理由编辑器、「← 返回上一题」（第 2 题起）、N / M。

### 6.1 抽屉外壳

- **位置**：主区域右侧，高度从标题栏底到状态条顶。**推挤式**：聊天列（含 composer）宽 = 主区域宽 − 抽屉宽，
  所以 composer 永远不被盖住（§5.5 的插话路径）。
- **宽度**：选择题 / 多选 / pi `select` `input` `confirm` 用 `drawer.choice_width`；长文本（反述 / goal / plan）与 pi
  `editor` 用 `drawer.confirm_width`。实际宽 W = min(目标宽, 主区域宽 − `drawer.min_chat_width`)。打开时若侧栏展开且
  主区域宽 − 目标宽 < `drawer.min_chat_width`，就**顺带收起侧栏**（§4.4 动画与抽屉进场同时跑），抽屉关闭后恢复；
  窗口最小 720，所以 W 最小也有 360。
- **外观**：底 `bg.overlay`，左边框 1.5px `border.focus`（焦点在抽屉内）/ 1px `border.subtle`（焦点在 composer），
  无圆角、无阴影（它是并排的一栏，不是浮层）。内边距 `drawer.padding`。
- **遮罩**：只压暗左边的聊天消息流（`bg.scrim_drawer`），不压 composer、不压侧栏与状态条；遮罩**不拦截指针**
  ——消息流仍可滚动、选中、复制（作答时要对照上下文）；点它也不关抽屉（关抽屉 = 停整场采访，不能误触）。
- **结构**（自上而下）：顶沿进度条（多题时，§6.2）→ 头部 `drawer.header_height`（`message-circle-question` +
  「等你回答 · <会话名>」`font.base` 600；右侧「第 N / M 题」`font.small` `text.muted`；下边框 1px `border.subtle`）→
  滚动正文 → 粘滞底栏 `drawer.footer_height`（上边框 1px `border.subtle`，放按钮或快捷键提示）。正文顶/底有
  `scroll.fade_height` 的渐隐提示还有内容（§11.1）。
- **进场**：抽屉宽 0→W（聊天列同步变窄），抽屉内容跟着 translateX(+`drawer.content_shift` → 0) 与 opacity 0→1，
  `motion.duration.drawer_enter` / `motion.easing.smooth`；遮罩 opacity 0→1（`scrim_enter` / `emphasized`）。
  **退场**反向，`motion.duration.drawer_exit` / `motion.easing.exit`，遮罩 `scrim_exit`。
- **关闭的三种原因**走同一条退场：用户作答；Esc（`dismissed`，停整场采访）；prg 发 `dialog.close`
  （`aborted`，项目经理 / 代答先答了）——最后这种额外弹一条应用内横幅「这道题已由另一方作答」（§10），
  免得用户以为自己的输入丢了。
- **属于会话**（§1）：切走时不播退场，跟聊天区一起换；切回时直接在位。同一会话同时只有一个抽屉，
  后来的请求排队，前一个关闭后直接在原抽屉里切换内容（走 §6.2 的前进切换，不关了再开）。
- **焦点**：打开时落到推荐项（单选）/ 第一行（多选）/ 输入框（input、editor）/ 推荐按钮（长文本）。
  Tab / ⇧Tab 只在抽屉内循环；⌘L / 点击 composer 把焦点交给 composer，⌘J / 点击抽屉拿回来（§5.5）。抽屉关闭后
  焦点回到 composer。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.drawer.choice_width` | 440 | 选择题 / 多选 / pi select·input·confirm 抽屉宽 |
| `size.drawer.confirm_width` | 640 | 长文本 / pi editor 抽屉宽 |
| `size.drawer.min_chat_width` | 360 | 抽屉打开时聊天列至少保留的宽 |
| `size.drawer.padding` | 20 | 抽屉内边距 |
| `size.drawer.header_height` | 48 | 头部高 |
| `size.drawer.footer_height` | 60 | 粘滞底栏高 |
| `size.drawer.content_shift` | 24 | 进场时内容的右偏移 |
| `motion.duration.drawer_enter` | 240 | 抽屉进场 |
| `motion.duration.drawer_exit` | 200 | 抽屉退场 |

### 6.2 门禁单选

```
┌ 3px 分段进度条：■■■□□（N=3, M=5）───────────────────────┐
│ [message-circle-question] 等你回答 · reviewer    第 3 / 5 题 │ ← 头部 48
│                                                          │
│ 问题正文（Markdown，完整显示，和选项一起在正文区滚动）          │
│                                                          │
│ ┌ A.  方案甲                                  （推荐）  ┐ │
│ ┌ B.  方案乙                                            ┐ │
│ ┌ C.  方案丙                                            ┐ │
│ ┌ ✎   不选，我说明原因                          （虚线框） ┐ │
│ ┌ ←   返回上一题                               （仅第 2 题起）┐ │
│──────────────────────────────────────────────────────────│
│              ↑↓ 选择 · 字母直选 · Enter 确认 · ⌘← 上一题 · Esc 关闭 │ ← 底栏 60
└──────────────────────────────────────────────────────────┘
```

- 头部见 §6.1。单题（M = 1）时不显示进度条和「第 N / M 题」。
- 进度条：贴抽屉顶沿，高 `dialog.progress_height`，M 段、段间距 `dialog.progress_gap`；第 1..N 段 `accent.primary`，
  其余 `border.subtle`。题号变化时变色的那一段做颜色插值（`motion.duration.question_in`）。
- 选项：一律竖排（不做网格）。agent 的提问是 2–4 项，门禁自己的框最多 16 项（`host-protocol.md` §7.2），
  字母按 A–P 顺延。每行最小高 `choice.row_min_height`，圆角 `lg`，内边距 10/12，行间距 `choice.row_gap`。
  行内：字母前缀（`font.body_strong`，宽 20）→ 选项文字（`font.body`，可换行）→ 推荐项右侧「（推荐）」标牌
  （高 20，圆角 `sm`，内边距 2/6，`font.caption`，`badge.rec.*` 三色）。打开时焦点落在推荐项上。
- 「✎ 不选，我说明原因」行：永远在选项之后，`pencil` 图标代替字母，文字 `text.secondary`，1px **虚线**
  `border.default`。文案取 `dialog.open` 的 `declineRow`。选中后进入理由编辑器（§6.3）。
- 「← 返回上一题」行：只在 `back` 为真（多题采访**第 2 题起**）时出现，在最后一行，`arrow-left` 图标，ghost 样式。
- 底栏放快捷键提示（`font.small`、`text.muted`，右对齐）。
- **题间切换**（只换正文，头部与底栏不动；头部里的 N 数字交叉淡化）：
  - 前进 N→N+1：旧题 translateX 0→−`drawer.question_shift`、opacity 1→0（`question_out` / `exit`）；紧接着新题
    translateX +`drawer.question_shift`→0、opacity 0→1（`question_in` / `smooth`）。正文滚动位置回到顶部。
  - 后退（← 行或 ⌘←）：方向镜像（旧题向右退出、上一题从左进来），上一题恢复它当时的选中态与草稿。
  - 连按时新动画从当前帧接着走，不排队。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.dialog.progress_height` | 3 | 进度条高 |
| `size.dialog.progress_gap` | 2 | 进度段间距 |
| `size.choice.row_min_height` | 44 | 选项行最小高 |
| `size.choice.row_gap` | 8 | 选项行间距 |
| `size.drawer.question_shift` | 24 | 题间切换的横移距离 |
| `motion.duration.question_out` | 120 | 旧题退出 |
| `motion.duration.question_in` | 200 | 新题进入 |

### 6.3 理由编辑器

- 选中「✎」行后抽屉正文原地切换：顶部是完整题面（`font.body`、`text.secondary`，与门禁 `reasonTitleOf` 同内容），
  下面是多行输入（最小高 `reason_editor.min_height`，超过 `reason_editor.max_height` 内部滚动；底 `bg.app`，
  1.5px `border.focus`，内边距 10，`font.body`），底栏提示「⌘Enter 提交 · Esc 返回选项（保留已输入）」。
- 切入：选项列表 translateY 0→−`drawer.reason_shift`、opacity→0（`reason_out` / `exit`）；编辑器 translateY
  +`drawer.reason_shift`→0、opacity 0→1（`reason_in` / `smooth`），结束时光标在文字末尾。
- Esc：反向播放，回到选项列表，焦点落回「✎」行，**草稿保留**，再次进入原样恢复。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.reason_editor.min_height` | 88 | 理由编辑器最小高 |
| `size.reason_editor.max_height` | 200 | 理由编辑器最大高 |
| `size.drawer.reason_shift` | 12 | 列表 ↔ 编辑器切换的竖向位移 |
| `motion.duration.reason_out` | 120 | 列表退出 |
| `motion.duration.reason_in` | 180 | 编辑器进入 |

### 6.4 多选（勾选清单）

- 与单选同一抽屉，差异只有：字母前缀换成 16×16 复选框（字母仍显示在复选框右侧）；**打开时默认勾选项已勾好**
  （门禁的 `defaultChecked`，直接 Enter 就是接受推荐组）；没有「（推荐）」标牌。
- 「✎ 不选，我说明原因」与「← 返回上一题」两行、题间切换、理由编辑器规则同单选。
- 底栏（`drawer.footer_height`）：左侧「已勾选 N / M 项」（`font.small`、`text.secondary`，数字变化时交叉淡化），
  右侧 primary 按钮「提交（Enter）」。一项都不勾也可以提交（空清单是有效答案），按钮不禁用。
- 勾选动效：底色插值（`motion.duration.hover`），勾号图标尺寸 0→12（`motion.spring.snappy`，会轻微过冲）；
  取消勾选时勾号 12→0、底色回退。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.checkbox` | 16 | 复选框边长 |

### 6.5 长文本确认（需求反述 / goal / plan）

```
┌ 头部 48：[需求反述] 请审阅全文后作答            第 1 / 2 题 ┐
├ 2px 阅读进度条 ──────────────────────────────────────────────────┤
│ 全文（Markdown，完整渲染，不截断，内部滚动）                   │
│ …                                                          │
│                  ( ↓ 还有 82 行未读 )                        │ ← 距底 >200 时显示
├────────────────────────────────────────────────────────────┤
│ [✎ 不选，我说明原因]            [B. 拒绝]  [A. 批准（推荐）] │ ← 底栏 60
└───────────────────────────────────────────────────────────┘
```

- 宽 `drawer.confirm_width`（§6.1 的夹紧规则同样适用）。`dialog.open` 带 `body` 就用这个变体。
- 头部：左侧类型徽标（高 20，圆角 `sm`，内边距 2/8，`font.caption`；`doc.restatement.*` / `doc.goal.*` /
  `doc.plan.*`）+ 标题（`font.h2`）。多题时右侧同样显示「第 N / M 题」，顶沿同样有分段进度条。
- 正文：完整 Markdown，内容再长也**不截断**；内部滚动。头部下沿 2px 阅读进度条（`accent.primary`，宽度 = 已滚动比例，
  跟手不动画）。距底部超过 `limit.confirm.unread_hint_px` 时，底栏上方居中浮出胶囊「↓ 还有 N 行未读」
  （进出同§11 popover），点击程序式滚到底（§11.4）。
- **不强制滚到底才能批准**：强制只会让人猛甩滚轮，换不来阅读；进度条 + 未读提示已足够。批准按钮始终可用。
- 底栏：选项 ≤ 3 个时按钮就是这道题的选项（同一模板）——推荐项 primary、其余 secondary、文字带字母前缀，
  最左侧 ghost 按钮「✎ 不选，我说明原因」，有 `back` 时再加 ghost「← 返回上一题」；选项 > 3 个放不进一行，
  就按 §6.2 的选项行排在正文末尾，底栏只放快捷键提示。
- 选中「✎」时底栏上方向上展开 `confirm.reject_drawer_height` 高的理由区（高度 0→120 + opacity，
  `motion.duration.reason_expand` / `smooth`）：多行输入 + 「提交（⌘Enter）」「返回（Esc）」；Esc 收起并保留草稿。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.confirm.reject_drawer_height` | 120 | 理由区高 |
| `size.confirm.progress_height` | 2 | 阅读进度条高 |
| `limit.confirm.unread_hint_px` | 200 | 距底多少 px 出未读提示 |
| `motion.duration.reason_expand` | 200 | 理由区展开 / 收起 |

### 6.6 pi 原生 `select` / `input` / `confirm` / `editor`

pi RPC 的 `extension_ui_request` 对话框没有「（推荐）」、decline 行与返回行，客户端**不替它们补**，只套同一个抽屉外壳
（§6.1：同样的进出场、遮罩、焦点规则）。头部写 pi 给的 `title`，没有「等你回答 ·」前缀以外的字。

| 方法 | 宽 | 正文 | 底栏 / 键盘 | 取消 |
|:---|:---|:---|:---|:---|
| `select` | `drawer.choice_width` | 选项行（§6.2 样式，没有字母前缀）；> 8 项时顶部出过滤框，输入即筛 | ↑↓ 移动、Enter 选中 | Esc |
| `input` | `drawer.choice_width` | 单行输入框（高 `button.height`，带 pi 给的 placeholder） | secondary「取消」+ primary「确定（Enter）」 | Esc |
| `confirm` | `drawer.choice_width` | `message` 正文 | secondary「取消」+ primary「确定」，焦点在「确定」，Enter 触发焦点按钮 | Esc |
| `editor` | `drawer.confirm_width` | 多行编辑器（预填 pi 给的文本，占满正文区） | 「⌘Enter 提交 · Esc 取消」 | Esc |

- 请求带 `timeout` 时，顶沿进度条位置换成一条随时间线性缩短的倒计时条（`semantic.warning`，高 `confirm.progress_height`），
  到点走退场并弹横幅「已超时」。
- 门禁对话框与 pi 对话框同属一个排队（§6.1）。

### 6.7 选项行 / 复选框的交互状态

| 组件 | default | hover | focus（键盘） | pressed | selected / checked | disabled |
|:---|:---|:---|:---|:---|:---|:---|
| 选项行 | 底 `bg.surface`，1px `border.subtle`，字 `text.primary` | 底 `bg.elevated`，1px `border.default` | 底 `bg.elevated`，1.5px `border.focus` + `focus.ring` | 底 `border.subtle` | 底 `accent.subtle`，1.5px `accent.primary`，字母变 `accent.primary`，单选图标 `circle-dot` | 字 `text.disabled`，无 hover（答案已提交、等待关闭时） |
| 复选框 | 透明底，1.5px `border.strong` | 边框 `text.primary` | 外加 2px `focus.ring` | 底 `accent.subtle` | 底 `accent.primary`，内 12px 白色勾 | 边框 `border.subtle` |

---

## 7. 配置页（pi 配置与门禁配置）

⌘, 或标题栏最右侧的 `settings` 按钮（`titlebar.button`，ghost）把主区域切成配置页。它是**页面**不是抽屉：
模型链、嵌套对象、原始 JSON 都需要整块的宽度与高度。会话侧栏照常存在（可收起），选中任一会话 = 离开配置页。

```
┌ 配置导航 200 ────┬ 头部：门禁配置 · ~/.pi/review-gate.json [copy]    [表单 | JSON] ┐
│ pi              │                                                     │
│   settings.json │  ┌ agents ────────────────────────────────────────┐  │
│ 门禁            │  │ reviewer        [slots 列表…]                  │  │
│ ▸ 全局          │  │ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │  │
│   项目          │  │ worker          [slots 列表…]                  │  │
│                 │  └────────────────────────────────────────────────┘  │
│                 ├─────────────────────────────────────────────────────┤
│                 │ 有未保存的修改 · 保存前备份到 ….bak-<时间> [放弃] [保存 ⌘S]│ ← 保存栏 56
└─────────────────┴───────────────────────────────────────────────────────┘
```

### 7.1 导航与文件

- 左导航宽 `settings.nav_width`，两组：**pi**（`~/.pi/agent/settings.json`、`~/.pi/agent/models.json`、项目
  `<repo>/.pi/settings.json`）与**门禁**（全局 `~/.pi/review-gate.json`、项目 `<repo>/.pi/review-gate.json`）；项目层两项
  只在当前会话有 repo 时出现。一项 = 一个文件；文件下按顶层键列出子项，
  点子项滚到对应分区。导航项高 `settings.nav_item_height`，`font.small`，圆角 `lg`；选中底色是一块会滑的覆盖层
  （`motion.spring.gentle`，同 §4.3）。
- 头部（`drawer.header_height` 高）：文件标题 + 完整路径（`font.code_small`、`text.muted`，带 `copy`）+ 右侧「表单 | JSON」分段控件。
  文件不存在时正文显示空态「还没有这个文件，保存后创建」。

### 7.2 表单视图

- 内容最大宽 `settings.content_max_width`，居中。每个顶层键一个分区：标题区高 `settings.section_header_height`
  （`font.title`），下面一张分组卡（底 `bg.surface`，1px `border.subtle`，圆角 `xl`，左右内边距 `settings.group_padding_x`）。
  卡内每个字段一行，行与行之间 1px **虚线** `border.subtle`（参照 Qoder），行上下内边距 `settings.row_padding_y`。
  行左：字段名（`font.body_strong`）+ 说明（`font.small`、`text.muted`，有就显示）；行右：控件。
- **控件按 JSON 值的类型生成**，不在客户端复制一份门禁的 schema：布尔 → 开关；数字 → 数字框；字符串 → 文本框；
  字符串数组（如 `agents.*.slots`）→ 有序列表（每项一行，行尾 ↑ ↓ 删除，末尾「+ 添加」）；对象 → 折叠的子分组
  （展开同 §5.2 的折叠动画）；其他（null、混合数组）→ 只读行「在 JSON 视图里编辑」。列表增删行走高度插值
  （`collapse` / `smooth`），上下移动走 `motion.spring.gentle` 的 y 位移。
- 敏感值：键名含 `key` / `token` / `secret` / `password`（不分大小写）的字符串在表单里显示为 `••••`，行尾 `eye`
  按钮临时显示；JSON 视图是原样文本，切过去时头部下方出一行提示「JSON 视图会显示明文密钥」。

### 7.3 JSON 视图与切换

- 分段控件高 `segmented.height`，选中块在两段间滑动（`motion.spring.gentle`）。两个视图交叉淡化
  （`motion.duration.page_enter`，只有 opacity）。
- JSON 视图：等宽编辑器（`font.code`），行号栏宽 `settings.json_gutter`（`font.code_small`、`text.muted`），底 `code.block.bg`。
- 表单 → JSON：把当前草稿序列化成 2 空格缩进，**保留原文件的键顺序**。
- JSON → 表单：先解析。失败就**不切**：分段控件左右抖一下（±`shake.amplitude`，共 `motion.duration.shake`，三次衰减），
  编辑器顶部出错误横条（底 `tool.error.header_bg`、字 `tool.error.text`、`alert-circle`）：「JSON 有语法错误（第 L 行第 C 列）：
  … 修好后才能切回表单」，点横条跳到该行。

### 7.4 校验与保存

- **保存前经 prg 自己的校验器**（2026-09-30 修订，r4）：客户端把 `{kind, text}` 写进 `node scripts/validate-config.ts` 的 stdin、读回 `{ok, errors}`
  （逻辑在 `lib/config-validate.ts`：门禁配置里本文件声明的每个 agent 角色用启动硬检查 `validateAgentsForStartup` 判
  slot 能否解析、`precommit` 各步用 `parsePrecommitStep` 判；pi 配置判 JSON 与已知字段类型）。**Rust 里不复制任何规则**；
  不过就不写盘，找得到对应行的 finding 标在那一行下（同表单字段错误的样式），找不到的列在正文顶部横条里；校验器跑不起来
  = 不保存（fail-closed），原因写在保存栏。改动任一字段即清掉旧 finding（它说的是上一份文本）。保存成功的横幅写
  「已保存 · 已通过 prg 校验」。可换 `PI_DESKTOP_NODE` / `PI_DESKTOP_PRG` 指定 node 与 prg 目录。
- JSON 视图语法错误：每次输入后即时判定，出 §7.3 的错误横条（写明行列，点横条把光标放到出错处），保存按钮计入错误数。
  编辑器组件不提供逐行底色，所以不做出错行底色 / 行号变色。
- 表单字段错误（数字框写了非数字等）：控件边框 `semantic.danger`，行下方展开一行说明（`font.small`、`semantic.danger`、
  `alert-circle`），高度 0→行高（`motion.duration.field_error` / `smooth`）把下面的行平滑推开。
- **保存栏**：草稿 ≠ 磁盘内容时从底部升起（高 `settings.save_bar_height`，translateY 满高→0，`motion.duration.save_bar` /
  `smooth`）：左侧「有未保存的修改 · 保存前会把原文件备份到 `<文件>.bak-<时间>`」，右侧 secondary「放弃修改」+ primary
  「保存 ⌘S」。有错误时「保存」禁用并写「N 处错误」。导航里该文件项行尾出 `size.unread_dot` 大小的
  `semantic.warning` 点。
- **备份**：写盘前先把磁盘上的原文件复制到同目录 `<文件>.bak-YYYYMMDD-HHMMSS`（本地时间；同一秒再存加 `-2`、`-3`，
  从不覆盖旧备份），再原子写入（写临时文件后 rename）。文件原本不存在则不备份、直接创建。
  备份失败 = 不保存。
- **磁盘文件在打开后被别人改过**（修改时间变了）：保存前弹 §6 抽屉单选：「A. 用我的版本覆盖（磁盘版本会先备份）」
  （推荐）/「B. 放弃我的修改，重新载入」；Esc = 暂不处理（草稿保留）。这两处是客户端自己的抽屉（同字母、同「（推荐）」标牌、
  ↑↓ / Enter），**没有 ✎ 行**：答案不回传给任何人，原因无处可去。
- **保存成功**：按钮图标换成 `check`（尺寸 10→14，`motion.spring.snappy`）、文字换成「已保存」、底色插值到
  `semantic.success`（`dot_color`），停 `motion.duration.save_hold` 后保存栏沉下；同时弹横幅「已保存 · 原文件备份在 <路径>」。
- **保存失败**（写盘错误）：保存栏抖一下（`shake`），左侧文字换成错误原因（`semantic.danger`），草稿保留。
- **未保存就离开**（选会话、再按 ⌘,、Esc、关窗）：弹 §6 抽屉单选「A. 保存并离开」（推荐）/「B. 放弃修改并离开」/
  「C. 继续编辑」；Esc = 继续编辑。
- 减少动态效果：不抖动（只出错误文字）、分段滑块直接到位、保存栏与错误行只做 `reduced_motion_fade`。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.settings.nav_width` | 200 | 配置导航宽 |
| `size.settings.nav_item_height` | 28 | 导航项高 |
| `size.settings.content_max_width` | 720 | 内容最大宽 |
| `size.settings.section_header_height` | 44 | 分区标题区高 |
| `size.settings.group_padding_x` | 16 | 分组卡左右内边距 |
| `size.settings.row_padding_y` | 14 | 字段行上下内边距 |
| `size.settings.save_bar_height` | 56 | 保存栏高 |
| `size.settings.json_gutter` | 44 | JSON 行号栏宽 |
| `size.segmented.height` | 28 | 分段控件高 |
| `size.shake.amplitude` | 4 | 抖动幅度 |
| `motion.duration.shake` | 240 | 抖动总时长 |
| `motion.duration.field_error` | 160 | 字段错误行展开 |
| `motion.duration.save_bar` | 200 | 保存栏升起 / 沉下 |
| `motion.duration.save_hold` | 1600 | 「已保存」停留 |

---

## 8. 按钮与输入框的交互状态

按钮高 32（小号 24），圆角 `md`，`font.body` 500，左右内边距 12。

| 类型 | default | hover | pressed | focus | disabled |
|:---|:---|:---|:---|:---|:---|
| primary | 底 `accent.primary`，字 `text.on_accent` | 底 `accent.hover` | 底 `accent.pressed` | 外加 2px `focus.ring`（偏移 2） | 底 `bg.elevated`，字 `text.disabled` |
| secondary | 底 `bg.elevated`，字 `text.primary`，1px `border.default` | 底 `border.subtle`，边 `border.strong` | 底 `border.default` | 边 `border.focus` + `focus.ring` | 底透明，字 `text.disabled`，边 `border.subtle` |
| ghost | 底透明，字 `text.secondary` | 底 `bg.elevated`，字 `text.primary` | 底 `border.subtle` | `focus.ring` | 字 `text.disabled` |
| danger | 底 `button.danger.bg`，字 `button.danger.text`，1px `button.danger.border` | 底 `button.danger.hover_bg`，字 `button.danger.hover_text` | 底 `button.danger.pressed_bg`，字 `button.danger.hover_text` | 边 `semantic.danger` + 2px `semantic.danger` 40% 外发光 | 底 `bg.elevated`，字 `text.disabled`，无边 |

输入框（composer、理由编辑器）：default 1px `border.default`；hover 边 `border.strong`；focus 1.5px `border.focus` +
2px `focus.ring`；disabled 底 `bg.elevated`、字 `text.disabled`（仅会话 dead 时）。

**hover / 按下的动效**（所有可点元素通用：按钮、侧栏行、选项行、卡头、分段控件）：hover 颜色过渡
`motion.duration.hover` / `standard`；按下时颜色到 pressed 并把**内容**下沉 `press.shift`（参照 Qoder 的
`active` 下沉；GPUI 不能缩放 div，所以不做 scale 0.96），`motion.duration.press` / `standard`；松开回弹
`motion.duration.release` / `smooth`。按下后拖出元素再松开 = 不触发，走同一条回弹。减少动态效果：只变色、不下沉。

**复制成功**（代码块、diff 路径、工具结果、设置路径上的 `copy`）：`copy` → `check` 交叉淡化（`hover`），`check`
尺寸 10→14（`motion.spring.snappy`）、颜色 `semantic.success`，停 `motion.duration.copy_hold` 后淡回 `copy`。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.button.height` | 32 | 按钮高 |
| `size.button.height_sm` | 24 | 小按钮高 |
| `size.button.padding_x` | 12 | 按钮左右内边距 |
| `size.press.shift` | 1 | 按下时内容下沉 |
| `motion.duration.press` | 90 | 按下 |
| `motion.duration.release` | 140 | 松开回弹 |
| `motion.duration.copy_hold` | 1500 | 「已复制」勾号停留 |

---

## 9. 底部状态条

### 9.1 布局

单行高 28，底 `bg.surface`，顶部 1px `border.subtle`，左右内边距 12，`font.small`；显示**当前选中会话**的门禁状态。
从左到右、段间距 12：

1. **mode 徽标**：高 18，圆角 `sm`，内边距 2/6，`font.caption`；`loop` / `explore` / `normal` / `orchestrator`
   分别用 `mode.<mode>.bg` / `mode.<mode>.text`。
2. **分支**：`git-branch` 12 + 分支名（`font.code_small`，最大宽 160，末尾省略）。
3. **轮次**：`refresh-cw` 12 + 「轮 N」；只在 loop / orchestrator 会话与 judge 会话显示（与门禁 widget 一致）。
4. **未满足项**：N > 0 时 `alert-circle`（`semantic.warning`）+ 「N 项未满足」；N = 0 时 `check`（`semantic.success`）+「门禁已满足」。
   是一个可点的胶囊（hover 底 `bg.elevated`），点击展开 §9.2 的浮卡。N 变化时数字交叉淡化，图标在 `alert-circle` 与
   `check` 之间切换时走 `dot_color` 交叉淡化；变成 0 的那一下 `check` 尺寸 10→12 走 `motion.spring.snappy`。
5. **setStatus 文本**：pi `setStatus` 送来的其他状态（按 key 各一段，紧跟在门禁段之后），`font.small`，带 ANSI 彩色
   （§9.3）。每段最大宽 240，末尾省略，悬停出全文。

整条不换行；窗口窄时按 5 → 4 → 3 → 2 的顺序把文字收成只剩图标（setStatus 段直接隐藏），mode 徽标永不隐藏。
段内容变化时新旧文字交叉淡化（`motion.duration.hover`），不跳变。

### 9.2 未满足项浮卡

- 形态：从状态条胶囊**向上弹出**的浮卡（不是抽屉：它是只读的短列表）。左沿与胶囊对齐（越界则贴窗口右边留 8），
  底沿在状态条上方 `popover.offset`。宽 `popover.unmet_width`，最大高 `popover.unmet_max_height`（超出内部滚动）；
  底 `bg.overlay`，1px `border.default`，圆角 `xl`，`shadow.mid`。
- 头部（高 36）：「门禁未满足项（N）」`font.body_strong` + 右侧 `copy`（复制全部条目）与 `x`。
- 条目：每条一行（可换行），行首 `alert-circle` 12（`semantic.warning`），文字 `font.small`，按门禁给出的原文与顺序
  显示（如「code review gate is PENDING (need READY)」），含 ANSI 时按 §9.3 渲染；行 hover 底 `bg.elevated`。
  条目来源由实现任务定；客户端只拿到计数、拿不到明细时，浮卡只显示计数与底部提示，不编造条目。
- 底部提示（高 28，`font.small`、`text.muted`）：「完整诊断：在会话里运行 `/gate-status`」。
- 进场：translateY +`popover.offset`→0、opacity 0→1，`motion.duration.popover_enter` / `motion.easing.smooth`；
  退场反向 `motion.duration.popover_exit` / `motion.easing.exit`。Esc、再点胶囊、点浮卡外都会关闭。打开期间数据变了
  就就地更新：新增条目走 §5.1 的消息出现，消失的条目高度收起（`collapse`）。
- 减少动态效果：只做 `reduced_motion_fade`。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.popover.unmet_width` | 380 | 浮卡宽 |
| `size.popover.unmet_max_height` | 280 | 浮卡最大高 |
| `size.popover.offset` | 8 | 与状态条间距，也是进场位移 |
| `motion.duration.popover_enter` | 180 | 浮卡进场 |
| `motion.duration.popover_exit` | 140 | 浮卡退场 |

### 9.3 ANSI 彩色文本

状态条里来自 pi 的文本（`setStatus`、浮卡条目）可能带 ANSI SGR 转义。客户端先把字符串解析成「文字段 + 样式」的
序列再画，**原始控制字符永不上屏**。

| SGR | 效果 |
|:---|:---|
| `0` | 全部复位 |
| `1` / `22` | 加粗（字重 600）/ 取消加粗与弱化 |
| `2` | 弱化：当前前景色 alpha × 0.6 |
| `3` / `23` | 斜体：**忽略**（本规格不用斜体，§2.2） |
| `4` / `24` | 下划线 1px / 取消 |
| `7` / `27` | 前景背景互换 / 取消 |
| `30`–`37`、`90`–`97` | 前景色 `ansi.0`–`ansi.7`、`ansi.8`–`ansi.15` |
| `40`–`47`、`100`–`107` | 背景色，同一套 token，文字段加圆角 `xs`、左右内边距 2 |
| `39` / `49` | 前景恢复默认（`text.secondary`）/ 背景恢复透明 |
| `38;5;n` / `48;5;n` | n < 16 用 `ansi.n`；16–231 按 xterm 6×6×6 色块、232–255 按灰阶算出 RGB |
| `38;2;r;g;b` / `48;2;r;g;b` | 直接用该 RGB |

- 其余 SGR 参数（闪烁 `5`、删除线 `9`、字体切换等）忽略该参数、继续解析同一序列里的其他参数。
- 非 SGR 的转义（光标移动、清屏、OSC 标题 / 链接等）整段丢弃，只留文字；不完整的转义（字符串末尾截断）也丢弃。
- 每段文本独立解析，上一段没复位的样式不漏到下一段。
- 颜色跟随深浅色切换（`ansi.*` 两套值，§2.1）；浅色下 `ansi.7` / `ansi.15` 换成深色，否则白底白字。

---

## 10. 原生通知

只有三类（与门禁 `lib/user-notify.ts` 的策略一致），走 macOS `UNUserNotificationCenter`：

| 类型 | 标题 | 正文 | 触发 |
|:---|:---|:---|:---|
| 等你回答 | `等你回答 · <repo>` | 问题本身（首 2 行） | 任一会话弹出门禁对话框 / 登记待拍板的 plan 决策 |
| 任务完成 | `任务完成 · <repo>` | 完成摘要 | 主会话 / 项目经理 `declare_done` 被接受 |
| 异常结束 | `异常结束 · <repo>` | 失败原因 | 会话非用户主动结束地退出 |

- 同一会话的通知互相替换：`threadIdentifier` 与请求 identifier 都用该会话的 sessionId，新通知覆盖旧通知。
- **你正看着就不发**：应用在前台且该会话就是当前选中会话时，不发系统通知，只在应用内给侧栏行加未读点。
- 应用在前台但事件来自别的会话时，弹**应用内横幅**（见下），点击切到该会话。
- 点击系统通知：激活应用并选中发出通知的会话；若是「等你回答」，同时聚焦它的抽屉。

**应用内横幅**（上面的跨会话事件，以及客户端自己的反馈：已保存、题已由另一方作答、pi 对话框超时）：

- 位置：主区域右上角（标题栏下方 8）；抽屉打开时贴在抽屉左边，不压到抽屉上。宽 `toast.width`，底 `bg.overlay`，
  1px `border.default`，圆角 `lg`，`shadow.low`；内容 = 图标（`bell` / `check`（成功）/ `alert-circle`（警告））+ 标题 +
  正文首行。
- 进场 translateY −8→0、opacity 0→1（`motion.duration.toast` / `smooth`）；停 `motion.duration.toast_hold`（指针悬停时暂停计时）；
  退场 opacity→0、translateY 0→−4（`motion.duration.toast_exit` / `exit`）。
- 同时最多 `limit.toast.max_visible` 条，纵向堆叠间距 `toast.gap`；新横幅出现时旧的向下挤（位置走 `motion.spring.gentle`），
  超出的最老一条走退场。
- 减少动态效果：只做 `reduced_motion_fade`，堆叠位置直接跳。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.toast.width` | 320 | 横幅宽 |
| `size.toast.gap` | 8 | 堆叠间距 |
| `limit.toast.max_visible` | 3 | 同时可见条数 |
| `motion.duration.toast` | 240 | 横幅进场 |
| `motion.duration.toast_exit` | 160 | 横幅退场 |
| `motion.duration.toast_hold` | 4000 | 横幅停留 |

---

## 11. 全局动效清单

原则（参照 Qoder）：**凡是状态变化都有过渡，但不拖慢操作**——进场 160–240ms、退场更短；主曲线是 `smooth`
（Qoder 的 `EASE_OUT`，前快后缓），退场用 `exit`；「落定」感的小元素用弹簧。任何动画进行中来了新目标，
从当前帧的值出发往新目标走，不排队、不跳回起点。

### 11.1 总表

| 场景 | 触发 | 时长 / 弹簧 | 曲线 | 变化 | 减少动态效果 |
|:---|:---|:---|:---|:---|:---|
| 会话切换 | 选中另一个会话 | `tab_switch` | `smooth` | 聊天区 opacity 0→1、y +`space.2`→0；抽屉随会话换（§6.1） | `reduced_motion_fade` |
| 页面切换 | 聊天 ↔ 配置页（⌘,） | `page_enter` | `smooth` | 同上 | `reduced_motion_fade` |
| 侧栏收起 / 展开 | ⌘B、开关按钮、跨过 960 | `sidebar_toggle` | `smooth` | 宽度 + 内容 opacity / 横移联动（§4.4） | 直接到终态 |
| 覆盖式侧栏抽屉 | 窄窗口下 ⌘B | `drawer_enter` / `drawer_exit` | `smooth` / `exit` | translateX −100%↔0 | `reduced_motion_fade` |
| 侧栏选中底色 | 换选中行 | `spring.gentle`（跨组时 `sidebar_select`） | 弹簧 / `standard` | 底色块 y 滑到新行 | 直接到位 |
| 未读点 | 出现 / 清除 | `spring.snappy` | 弹簧 | 直径 0↔6 | 直接显隐 |
| hover | 指针移入 / 移出 | `hover` | `standard` | 背景 / 边框 / 文字色 | 保留（只是颜色） |
| 选项行焦点移动 | ↑↓、字母键 | `choice_hover` | `standard` | 背景与边框色 | 保留 |
| 按下 / 松开 | 指针按下可点元素 | `press` / `release` | `standard` / `smooth` | 颜色到 pressed，内容下沉 `press.shift` | 只变色 |
| 右侧抽屉进 / 退 | 门禁提问、pi 对话框打开 / 关闭 | `drawer_enter` / `drawer_exit` | `smooth` / `exit` | 宽 0↔W，内容 x +`drawer.content_shift`↔0、opacity | `reduced_motion_fade` |
| 抽屉遮罩 | 同上 | `scrim_enter` / `scrim_exit` | `emphasized` / `exit` | opacity | `reduced_motion_fade` |
| 题间切换 | 前进 / 返回上一题 | `question_out` → `question_in` | `exit` → `smooth` | 方向性横移 `drawer.question_shift` + opacity（§6.2） | 直接换内容 |
| 理由编辑器切入 / 退回 | 选中 ✎ / Esc | `reason_out` → `reason_in` | `exit` → `smooth` | 竖向 `drawer.reason_shift` + opacity（§6.3） | 直接换内容 |
| 长文本理由区 | 选中 ✎ / Esc | `reason_expand` | `smooth` | 高度 0↔120 + opacity | 直接展开 |
| 复选框勾选 | Space / 字母 / 点击 | `spring.snappy` | 弹簧 | 底色 + 勾号尺寸 0↔12 | 直接切换 |
| 消息出现 | 新消息块插入 | `message_enter` | `smooth` | opacity 0→1、y +`message.enter_shift`→0 | 直接出现 |
| 流式文字 | delta 到达 | `word_fade`，错峰 `word_stagger` | `smooth` | 按词 alpha 0→1（§5.1） | 到达即显示 |
| 流式光标 | 生成中 | `cursor_blink` | 阶跃 | 0–400 显示、400–800 隐藏 | 常亮 |
| 折叠 / 展开 | thinking、工具结果、diff、侧栏分组、配置子分组 | `collapse` | `smooth` | 高度（裁剪）+ opacity，箭头 0↔90° | 直接展开 |
| 工具状态变化 | running → ok / error | `dot_color` + `spring.snappy` | `standard` | 图标交叉淡化，完成图标尺寸 10→14 | 直接切换 |
| 状态点变化 | 会话状态变了 | `dot_color` + `spring.snappy` | `standard` | 颜色插值；进入 waiting-input / done 时直径 6→8 弹一下 | 只变色 |
| working 呼吸 | 会话 working | `pulse_working` | `pulse` | 直径 7.4↔8.6、opacity 0.5↔1，循环 | 静态实心点 |
| waiting-input 心跳 | 会话 waiting-input（含收起侧栏时的开关角标） | `pulse_waiting_input` | 线性关键帧 | 直径倍率 0:1.0→150:1.25→300:1.0→450:1.25→600:1.0→1200 静止 | 静态双环 |
| 工具 running | 工具执行中 | `spinner_rotation` | 线性 | `loader-2` 旋转 360° | 静态图标，计秒照走 |
| 浮卡 / 胶囊 | 未满足项浮卡、「↓ 回到最新」「↓ 还有 N 行未读」 | `popover_enter` / `popover_exit` | `smooth` / `exit` | y +`popover.offset`↔0、opacity | `reduced_motion_fade` |
| 应用内横幅 | 跨会话事件、保存、被代答、超时 | `toast` / `toast_hold` / `toast_exit`；堆叠 `spring.gentle` | `smooth` / `exit` | §10 | `reduced_motion_fade` |
| 复制成功 | 点 `copy` | `spring.snappy` + `copy_hold` | 弹簧 | `copy`→`check`，尺寸 10→14 | 直接换图标 |
| 保存栏 | 配置草稿变脏 / 保存完成 | `save_bar` | `smooth` | y 满高↔0 | `reduced_motion_fade` |
| 保存成功 | 写盘成功 | `spring.snappy` + `dot_color` + `save_hold` | 弹簧 / `standard` | `check` 弹出、底色到 `semantic.success` | 直接切换 |
| 错误抖动 | JSON 切表单失败、保存失败 | `shake` | 衰减正弦 | x ±`shake.amplitude`，三次衰减 | 不抖，只显示错误 |
| 字段错误行 | 表单字段校验失败 / 恢复 | `field_error` | `smooth` | 高度 0↔行高 + opacity | 直接出现 |
| 分段控件 | 表单 ↔ JSON | `spring.gentle` + `page_enter` | 弹簧 | 滑块 x 移动，视图交叉淡化 | 直接到位 |
| composer 高度 | 输入换行 | `hover` | `smooth` | 高度插值 | 直接变 |
| 程序式滚动 | 见 §11.4 | `spring.scroll` | 弹簧 | scrollTop → 目标 | 直接跳 |
| 滚动边缘渐隐 | 容器还有未显示内容 | `hover` | `standard` | 顶 / 底 `scroll.fade_height` 渐变遮罩显隐 | 保留（静态提示） |

时长列里的名字是 `motion.duration.*` 或 `motion.spring.*` 的简写。时长 token 与值：

| Token | 值 | 说明 |
|:---|:---|:---|
| `motion.duration.tab_switch` | 180 | 会话切换 |
| `motion.duration.page_enter` | 180 | 页面切换、视图交叉淡化 |
| `motion.duration.hover` | 120 | hover 颜色过渡、小文字交叉淡化 |
| `motion.duration.sidebar_select` | 120 | 侧栏选中淡入（弹簧不适用时） |
| `motion.duration.choice_hover` | 120 | 选项行焦点 / hover |
| `motion.duration.scrim_enter` | 150 | 遮罩进 |
| `motion.duration.scrim_exit` | 120 | 遮罩退 |
| `motion.duration.collapse` | 200 | 折叠展开 |
| `motion.duration.dot_color` | 200 | 状态色 / 图标交叉淡化 |
| `motion.duration.cursor_blink` | 800 | 光标周期 |
| `motion.duration.pulse_working` | 1800 | 呼吸周期 |
| `motion.duration.pulse_waiting_input` | 1200 | 心跳周期 |
| `motion.duration.spinner_rotation` | 1000 | 转一圈 |
| `motion.duration.reduced_motion_fade` | 60 | 减少动态效果时的进出场 |

其余时长 token 列在各自组件的 Token 表里（§4.4、§5.1、§6、§7、§8、§9.2、§10）。

| Token | 值 | 说明 |
|:---|:---|:---|
| `motion.easing.smooth` | 0.2, 0.8, 0.2, 1 | 主曲线：进场、位移、宽高（Qoder `EASE_OUT`） |
| `motion.easing.emphasized` | 0.16, 1, 0.3, 1 | 遮罩进场 |
| `motion.easing.standard` | 0.2, 0, 0, 1 | 颜色过渡、按下 |
| `motion.easing.exit` | 0.4, 0, 1, 1 | 退场 |
| `motion.easing.pulse` | 0.4, 0, 0.2, 1 | 呼吸 |

### 11.2 弹簧

| Token | stiffness | damping | mass | settle（ms） | 阻尼比 ≈ | 过冲 ≈ | 用在 |
|:---|:---|:---|:---|:---|:---|:---|:---|
| `motion.spring.snappy` | 500 | 30 | 1 | 300 | 0.67 | 6% | 勾号、复制、状态点、未读点、保存成功这类「落定」 |
| `motion.spring.gentle` | 420 | 26 | 0.75 | 260 | 0.73 | 3% | 选中底色滑动、分段滑块、列表重排、横幅堆叠（Qoder 设置导航同参数） |
| `motion.spring.scroll` | 280 | 30 | 1 | 300 | 0.90 | < 1% | 程序式滚动 |

实现：GPUI 的动画是「时长 + easing」，弹簧就用它的解析解当 easing、时长取 `settle`。设 ω₀ = √(k/m)，
ζ = c / (2√(k·m))，ωd = ω₀√(1 − ζ²)，则进度 t（秒）处的值
`x(t) = 1 − e^(−ζω₀t) · (cos ωd·t + (ζω₀/ωd) · sin ωd·t)`（三个 token 都是欠阻尼，ζ < 1）；在
`settle` 处包络已在 1% 以内，最后一帧直接写终值。中途换目标时以当前值为起点重新开始（丢弃速度，可接受）。

### 11.3 减少动态效果

读 macOS 的 `NSWorkspace.accessibilityDisplayShouldReduceMotion`，并监听
`NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification`，开关一变立刻生效（进行中的动画直接跳到终态）。
不提供应用内开关。开启时：

1. 所有位移、宽高、尺寸、弹簧、抖动、错峰取消，直接到终态；进出场只保留 `reduced_motion_fade` 的 opacity（线性）。
2. 颜色过渡（hover、状态色）保留——它们不是「运动」。
3. working 呼吸停止：静态实心点。
4. waiting-input 心跳停止：换成静态双环（内 6px 实心 + 外 12px 1.5px 描边环），仍与其他状态可分。
5. 流式文字不淡入、光标常亮不闪；工具 running 的 `loader-2` 停转，耗时计秒继续走。
6. 程序式滚动直接跳到目标。

### 11.4 滚动

- **不劫持原生惯性**：触控板 / 鼠标滚轮的滚动与惯性完全交给 macOS（GPUI 收到的就是带动量的滚动事件），客户端
  不做平滑、不加倍、不模拟惯性。
- **程序式滚动**才动画：「↓ 回到最新」、「↓ 还有 N 行未读」、⌘↑ / ⌘↓、PageUp / PageDown、查找跳转、JSON 错误行跳转，
  走 `motion.spring.scroll`。距离超过 `limit.programmatic_scroll.max_screens` 个视口高时，先瞬间跳到距目标一个视口的位置
  再动画（长距离不拖沓）。动画中用户一碰滚轮 / 触控板就立刻停下，控制权还给原生滚动。
- 流式跟随不动画（§5.1）。
- 滚动容器（聊天流、抽屉正文、浮卡、配置页、侧栏）还有未显示内容的一端，边缘叠一层高 `scroll.fade_height` 的
  渐变（容器底色 → 透明，参照 Qoder 的 `scroll-fade-*`），到头时淡出。

| Token | 值 | 说明 |
|:---|:---|:---|
| `limit.programmatic_scroll.max_screens` | 3 | 超过多少屏先跳再滚 |
| `size.scroll.fade_height` | 16 | 边缘渐隐高 |

---

## 12. 键盘操作

按键只作用于**当前焦点所在处**。抽屉打开时焦点默认在抽屉，下列抽屉键作用于它；用户点击 composer 或按
⌘L 后焦点在 composer，按键归 composer，⌘J 或点击抽屉回到抽屉（§5.5）。全局键（带 ⌘ 的会话切换）
任何时候都可用，切走后抽屉留在原会话。

**全局**

| 键 | 动作 |
|:---|:---|
| ⌘1 … ⌘9 | 选中侧栏第 1–9 个会话（按侧栏可见顺序） |
| ⌘[ / ⌘] | 上一个 / 下一个会话 |
| ⌘⇧A | 跳到下一个 waiting-input 的会话 |
| ⌘B | 侧栏展开 / 完全收起（窄窗口下打开 / 关闭覆盖式侧栏抽屉），§4.4 |
| ⌘L | 聚焦 composer |
| ⌘F | 在当前会话聊天流内查找 |
| ⌘, | 打开 / 关闭配置页（§7） |
| PageUp / PageDown | 聊天区翻一屏 |
| ⌘↑ / ⌘↓ | 聊天区到顶 / 到底 |

**composer**

| 键 | 动作 |
|:---|:---|
| Enter | 发送 |
| ⇧Enter | 换行 |
| Esc | 会话生成中：中止；否则失焦 |
| ⌘J | 当前会话有抽屉时：焦点回到抽屉 |

**单选抽屉**

| 键 | 动作 |
|:---|:---|
| ↑ / ↓ | 移动焦点（选项 → ✎ 行 → 返回行，循环） |
| A / B / C … | 焦点跳到对应选项并选中（不提交，防误触）；字母随选项数顺延到 P |
| Tab / ⇧Tab | 在抽屉内循环（不出抽屉） |
| Enter | 提交焦点所在行（焦点在 ✎ 行 = 打开理由编辑器；在返回行 = 返回上一题） |
| ⌘← | 返回上一题（仅第 2 题起） |
| Esc | 关闭抽屉 = 停止整场采访 |

**理由编辑器**

| 键 | 动作 |
|:---|:---|
| Enter | 换行 |
| ⌘Enter | 提交理由 |
| Esc | 退回选项列表，草稿保留 |

**多选抽屉**

| 键 | 动作 |
|:---|:---|
| ↑ / ↓ | 移动焦点 |
| Space 或字母 | 切换该项勾选 |
| Enter | 提交当前勾选（焦点在 ✎ / 返回行时执行该行） |
| ⌘← / Esc | 同单选 |

**长文本确认抽屉**

| 键 | 动作 |
|:---|:---|
| ↑ / ↓ / PageUp / PageDown / Space | 滚动全文 |
| Tab / ⇧Tab | 在底栏按钮间移动焦点（打开时焦点在推荐按钮上） |
| A / B … | 直接选中对应按钮（不提交） |
| Enter | 触发焦点按钮 |
| Esc | 理由区打开时收起理由区；否则关闭 = 停止采访 |

**pi 原生对话框**：见 §6.6 表格（Esc 一律 = 取消）。

**配置页**

| 键 | 动作 |
|:---|:---|
| ⌘S | 保存 |
| ⌘⇧J | 在表单 / JSON 视图之间切换 |
| Esc | 焦点不在输入框时：离开配置页（有未保存修改先问，§7.4） |

**聊天区**

| 键 | 动作 |
|:---|:---|
| Tab / ⇧Tab | 在 thinking / 工具卡 / diff 的折叠头之间移动焦点 |
| Space / Enter | 展开 / 收起焦点所在块 |
| ⌥⌘→ / ⌥⌘← | 展开 / 收起当前消息里的全部折叠块 |
| ⌘C | 焦点在代码块或工具结果上时复制其全文 |

---

## 13. 覆盖清单（实现自检用）

- 侧栏：主会话、项目经理、reviewer / quality-auditor / acceptance / goal-auditor / adviser、worker、编排子会话 ——
  §4.1；状态 working / waiting-input / waiting-judge / idle / done / dead —— §4.2。
- 聊天：assistant 文本、thinking、工具调用与折叠结果、diff、流式光标 —— §5。
- 侧栏完全收起：⌘B 与标题栏按钮、收起后主区域占满、宽度与内容联动动画、窄窗口覆盖式抽屉、收起时的等待角标 —— §4.4。
- 右侧抽屉（取代所有对话框）：外壳、宽度、遮罩、焦点、进出场 —— §6.1；门禁单选（A/B/C、（推荐）、✎ 不选我说明原因、
  ← 返回上一题、N/M、题间切换动画）—— §6.2；理由编辑器 —— §6.3；多选 —— §6.4；长文本反述 / goal / plan —— §6.5；
  pi 的 select / input / confirm / editor —— §6.6。
- 配置页：pi 与门禁配置、表单 + JSON 两视图、校验失败与保存成功反馈、备份、离开拦截 —— §7。
- 底部单行状态条：mode / 分支 / 轮次 / 未满足项 / setStatus —— §9.1；未满足项浮卡 —— §9.2；ANSI 彩色 —— §9.3。
- 原生通知与应用内横幅 —— §10。
- 组件状态 hover / focus / pressed / disabled —— §4.3、§6.7、§8；全局动效与减少动态效果 —— §11；键盘 —— §12。

---

## 14. 退役 token

下列 token 属于已删掉的设计（图标栏、居中对话框、旧理由抽屉命名）。实现本修订的那一轮删掉了它们在 `desktop/src`
的最后一处引用，并在同一轮把它们与 JSON 的 `retired` 列表一起从 `tokens.json` 删除；新代码不得再引入它们。

`size.sidebar.rail_width`、`size.breakpoint.rail`、`size.dialog.choice_width`、`size.dialog.title_height`、
`size.dialog.multi_footer_height`、`size.dialog.question_max_height`、`size.confirm.header_height`、
`size.confirm.footer_height`、`size.confirm.width_max`、`size.confirm.height_max`、`ratio.confirm.width`、
`ratio.confirm.height`、`motion.duration.dialog_enter`、`motion.duration.dialog_exit`、`motion.duration.drawer`、
`motion.duration.flyout_delay`。
