# 桌面客户端 UI/UX 设计规格（GPUI · macOS）

本文是 GPUI（Rust）桌面客户端的界面规格，实现直接照本文与 `desktop/design/tokens.json` 做。
设计判断由 `gemini-3.8-flash`（antigravity，thinking high）两轮给出，本文在其基础上统一了数值、
删掉了与门禁对话框模板冲突的部分。

**唯一数值来源**：`desktop/design/tokens.json`。本文所有「Token 表」行（首列是反引号 token 名的表格行）
与 JSON 逐项一致；改数值时两处一起改。Rust 端从 JSON 读取或生成常量，组件代码里不写字面色值/尺寸。

约定：尺寸单位 px，时长单位 ms，缓动是 `cubic-bezier(x1, y1, x2, y2)` 的四个控制点；颜色是 `#RRGGBB`
或带透明度的 `#RRGGBBAA`。「深色 / 浅色」跟随 macOS 外观设置切换，不提供应用内开关。

---

## 1. 信息架构与布局网格

```
┌──────────────────────────────────────────────────────────────────────┐
│ ● ● ●   标题栏 38px（红绿灯保护区 78px，标题从 x=88 起）               │
├───────────────┬──────────────────────────────────────────────────────┤
│ 会话/标签列表  │  聊天区（内容最大宽 840，居中；左右内边距 32）          │
│ 默认 260      │   用户消息（右侧气泡）                                  │
│ (200–400 拖拽) │   assistant 文本 / thinking / 工具卡片 / diff          │
│               │                                                      │
│               │  ┌ composer 44–180 ─────────────────────────────┐    │
│               │  └──────────────────────────────────────────────┘    │
├───────────────┴──────────────────────────────────────────────────────┤
│ 状态条 28px：mode · 分支 · 轮 N · 未满足项                              │
└──────────────────────────────────────────────────────────────────────┘
门禁对话框 / 长文本确认框：以模态浮层盖在聊天区之上（遮罩只盖所属会话的主工作区，不盖侧栏）。
```

- 基线网格 4px：所有间距、尺寸落在 4 的倍数上（例外：1px/1.5px/2px 描边、3px 进度条、2px 段间距）。
- 模态浮层属于**某个会话**：切到别的会话时浮层随之隐藏，切回来原样恢复（含理由编辑器里的草稿）。
  这样一个子会话在等回答时，用户仍能去看别的会话。
- 窄窗口：窗口宽 ≥ `breakpoint.rail`（960）时侧栏完整展示；窗口宽 < 960 时侧栏收成 52px 图标栏，
  只显示角色图标 + 右下角状态点，悬停 150ms 弹出浮卡（会话名、状态、未读数）。窗口最小 720×560，
  所以没有「侧栏完全移出」的第三档。用户手动 `Cmd+B` 收起的侧栏在任何宽度下都保持收起为图标栏。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.window.default_width` | 1280 | 首次启动窗口宽 |
| `size.window.default_height` | 800 | 首次启动窗口高 |
| `size.window.min_width` | 720 | 最小宽 |
| `size.window.min_height` | 560 | 最小高 |
| `size.breakpoint.rail` | 960 | 小于它侧栏自动变图标栏 |
| `size.titlebar.height` | 38 | 透明标题栏高 |
| `size.titlebar.traffic_light_inset` | 18 | 红绿灯左边距 |
| `size.titlebar.traffic_light_reserve` | 78 | 红绿灯保护区宽 |
| `size.titlebar.title_x` | 88 | 标题文本起点 |
| `size.sidebar.width_default` | 260 | 侧栏默认宽 |
| `size.sidebar.width_min` | 200 | 拖拽下限 |
| `size.sidebar.width_max` | 400 | 拖拽上限 |
| `size.sidebar.rail_width` | 52 | 图标栏宽 |
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
| `color.bg.overlay` | #27272C | #FFFFFF | 对话框面板 |
| `color.bg.scrim` | #00000080 | #0000004D | 模态遮罩 |
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
| `font.base` | 14 | 22 | 400 | 对话框标题 |
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
`xl` 对话框面板；`full` 状态点、未读点、计数胶囊。

### 2.4 阴影（elevation）

GPUI 用 `Vec<BoxShadow>` 表达多层阴影；每层写作 `x y blur spread color`（深色 / 浅色各一组）。

| Token | 深色 | 浅色 | 用途 |
|:---|:---|:---|:---|
| `shadow.subtle` | 0 1 2 0 #00000073 | 0 1 2 0 #0000000D | 悬浮标签、浮卡 |
| `shadow.low` | 0 4 6 -1 #00000080; 0 2 4 -2 #00000059 | 0 4 6 -1 #00000014; 0 2 4 -2 #0000000A | 工具卡、菜单 |
| `shadow.mid` | 0 10 15 -3 #000000A6; 0 4 6 -4 #00000073 | 0 10 15 -3 #0000001F; 0 4 6 -4 #0000000F | 门禁选择对话框 |
| `shadow.high` | 0 20 25 -5 #000000CC; 0 8 10 -6 #00000099 | 0 20 25 -5 #00000029; 0 8 10 -6 #00000014 | 长文本确认框 |

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
| 对话框 | `circle` / `circle-dot` | 单选未选 / 已选 |
| | `square` / `square-check` | 多选未勾 / 已勾 |
| | `pencil` | 「✎ 不选，我说明原因」 |
| | `arrow-left` | 「← 返回上一题」 |
| | `message-circle-question` | 对话框标题 |
| 状态条 | `layers` | mode |
| | `git-branch` | 分支 |
| | `refresh-cw` | 轮 N |
| | `check` | 未满足项为 0 |
| 通知 | `bell` | 应用内横幅 |

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
| `size.sidebar.item_height` | 32 | 行高 |
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
- 自动跟随：视口在底部时新内容自动滚到底；用户上滚后停止跟随，右下角出「↓ 回到最新」胶囊按钮。
- **流式光标**：正在生成的 assistant 文本末尾一个 2×16 的竖条（`accent.primary`），按 `motion.duration.cursor_blink`
  周期闪烁（前一半显示、后一半隐藏，阶跃无渐变）；生成结束立即移除。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.chat.user_max_width` | 672 | 用户气泡最大宽 |
| `ratio.chat.user_max_width` | 0.8 | 用户气泡占内容宽比例上限 |
| `size.chat.avatar` | 24 | assistant 头标 |
| `size.chat.message_gap` | 24 | 消息间距 |
| `size.chat.paragraph_gap` | 12 | 段落间距 |

### 5.2 thinking

- 默认**折叠**成一行：高 32，底 `thinking.bg.collapsed`，左边框 2px `thinking.border`，右侧圆角 6；
  内容：`brain` 14px + 摘要「思考中…」（生成中）/「已思考 14s」（结束后），`font.small`、`text.muted`，右端 `chevron-right`。
- 展开：底 `thinking.bg.expanded`，左边框贯通，内边距 8/12/8/14，正文用 UI 字体 12/18（字号行高同 `font.code`）正体，颜色 `thinking.text`。
- 生成中的 thinking 不自动展开；用户展开后流式内容在里面继续追加。

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
- 会话有门禁对话框打开时 composer 仍可输入（用户可以在框外补充；这正是门禁的「协商被插话」路径），不禁用。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.composer.min_height` | 44 | 最小高 |
| `size.composer.max_height` | 180 | 最大高 |
| `size.composer.button` | 28 | 发送/中止按钮边长 |

---

## 6. 门禁对话框（选择题）

门禁的每一个提问框（`ask_user`、goal/plan 批准、敏感编辑、scope 限制、模式降级等）都是同一个模板，
客户端只实现这一个组件（外加第 7 节的长文本变体）。

### 6.1 单选

```
┌ 3px 分段进度条：■■■□□（N=3, M=5）───────────────────────┐
│ [message-circle-question] 等你回答 · reviewer    第 3 / 5 题 │ ← 标题行 40
│                                                          │
│ 问题正文（Markdown，最大高 140，超出内部滚动）                 │
│                                                          │
│ ┌ A.  方案甲                                  （推荐）  ┐ │
│ ┌ B.  方案乙                                            ┐ │
│ ┌ C.  方案丙                                            ┐ │
│ ┌ ✎   不选，我说明原因                          （虚线框） ┐ │
│ ┌ ←   返回上一题                               （仅第 2 题起）┐ │
│                          ↑↓ 选择 · A–D 直选 · Enter 确认 · Esc 关闭 │
└──────────────────────────────────────────────────────────┘
```

- 面板：宽 480（窗口不足时 = 聊天区宽 − 64），高随内容；底 `bg.overlay`，圆角 `xl`，`shadow.mid`，内边距 20；
  位置：主工作区水平居中，垂直中线上移 10%。遮罩 `bg.scrim` 只盖主工作区。
- 标题行：高 40，`font.base` 600，写「等你回答 · <会话名>」；右侧「第 N / M 题」（`font.small`、`text.muted`）。
  单题（M = 1）时不显示进度条和「第 N / M 题」。
- 进度条：贴面板顶沿，高 3，M 段、段间距 2；第 1..N 段 `accent.primary`，其余 `border.subtle`。
- 选项：**2 个到 4 个一律竖排**（不做 2×2 网格）；每行最小高 44，圆角 `lg`，内边距 10/12，行间距 8。
  行内：字母前缀 `A.`–`D.`（`font.body_strong`，宽 20）→ 选项文字（`font.body`，可换行）→ 推荐项右侧
  「（推荐）」标牌（高 20，圆角 `sm`，内边距 2/6，`font.caption`，`badge.rec.*` 三色）。
  打开时焦点落在推荐项上。
- 「✎ 不选，我说明原因」行：永远在选项之后，`pencil` 图标代替字母，文字 `text.secondary`，1px **虚线** `border.default`。
  选中后面板内原地切换成**理由编辑器**（多行，最小高 88，最大高 200 内部滚动，底 `bg.app`，1.5px `border.focus`，
  内边距 10，`font.body`），右下角提示「⌘Enter 提交 · Esc 返回选项（保留已输入）」。Esc 回到选项列表时草稿保留，
  再次进入原样恢复。
- 「← 返回上一题」行：只在多题采访的**第 2 题起**出现，在最后一行，`arrow-left` 图标，ghost 样式。
  第 1 题没有这一行。
- 底部一行快捷键提示（`font.small`、`text.muted`，右对齐）。
- 两个选项时面板自然变矮，四个选项时变高；不设固定高度。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.dialog.choice_width` | 480 | 面板宽 |
| `size.dialog.title_height` | 40 | 标题行高 |
| `size.dialog.progress_height` | 3 | 进度条高 |
| `size.dialog.progress_gap` | 2 | 进度段间距 |
| `size.dialog.question_max_height` | 140 | 问题正文最大高 |
| `size.choice.row_min_height` | 44 | 选项行最小高 |
| `size.choice.row_gap` | 8 | 选项行间距 |
| `size.reason_editor.min_height` | 88 | 理由编辑器最小高 |
| `size.reason_editor.max_height` | 200 | 理由编辑器最大高 |

### 6.2 多选（勾选清单）

- 与单选同一面板，差异只有：字母前缀换成 16×16 复选框（字母仍显示在复选框右侧）；**打开时默认勾选项已勾好**
  （门禁的 `defaultChecked`，直接 Enter 就是接受推荐组）；没有「（推荐）」标牌。
- 「✎ 不选，我说明原因」与「← 返回上一题」两行规则同单选。
- 底部固定栏高 52：左侧「已勾选 N / M 项」（`font.small`、`text.secondary`），右侧 primary 按钮「提交（Enter）」。
  一项都不勾也可以提交（空清单是有效答案），按钮不禁用。

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.checkbox` | 16 | 复选框边长 |
| `size.dialog.multi_footer_height` | 52 | 多选底栏高 |

### 6.3 选项行 / 复选框的交互状态

| 组件 | default | hover | focus（键盘） | pressed | selected / checked | disabled |
|:---|:---|:---|:---|:---|:---|:---|
| 选项行 | 底 `bg.surface`，1px `border.subtle`，字 `text.primary` | 底 `bg.elevated`，1px `border.default` | 底 `bg.elevated`，1.5px `border.focus` + `focus.ring` | 底 `border.subtle` | 底 `accent.subtle`，1.5px `accent.primary`，字母变 `accent.primary`，单选图标 `circle-dot` | 字 `text.disabled`，无 hover（答案已提交、等待关闭时） |
| 复选框 | 透明底，1.5px `border.strong` | 边框 `text.primary` | 外加 2px `focus.ring` | 底 `accent.subtle` | 底 `accent.primary`，内 12px 白色勾 | 边框 `border.subtle` |

---

## 7. 长文本确认框（需求反述 / goal / plan）

```
┌ 2px 阅读进度条 ─────────────────────────────────────────────┐
│ [需求反述] 请审阅全文后作答                          ← 头部 48   │
├───────────────────────────────────────────────────────────┤
│ 全文（Markdown，完整渲染，不截断，内部滚动）                     │
│ …                                                         │
│                  ( ↓ 还有 82 行未读 )                       │ ← 距底 >200 时显示
├───────────────────────────────────────────────────────────┤
│ [✎ 不选，我说明原因]            [B. 拒绝]  [A. 批准（推荐）]   │ ← 粘滞底栏 60
└───────────────────────────────────────────────────────────┘
```

- 尺寸：宽 = 窗口 × 0.75 且 ≤ 920；高 = 窗口 × 0.8 且 ≤ 680。底 `bg.overlay`，圆角 `xl`，`shadow.high`。
- 头部高 48：左侧类型徽标（高 20，圆角 `sm`，内边距 2/8，`font.caption`；`doc.restatement.*` / `doc.goal.*` /
  `doc.plan.*`）+ 标题（`font.h2`）。多题时右侧同样显示「第 N / M 题」。
- 正文：完整 Markdown，内容再长也**不截断**；内部滚动。顶沿 2px 阅读进度条（`accent.primary`，宽度 = 已滚动比例）。
  距底部超过 200px 时，底栏上方居中浮出胶囊「↓ 还有 N 行未读」，点击平滑滚到底。
- **不强制滚到底才能批准**：强制只会让人猛甩滚轮，换不来阅读；进度条 + 未读提示已足够。批准按钮始终可用。
- 底栏（粘滞，实色 `bg.overlay`，顶部 1px `border.subtle`）：按钮就是这道题的选项（与第 6 节同一模板）——
  推荐项是 primary，其余是 secondary，按钮文字带字母前缀；最左侧 ghost 按钮「✎ 不选，我说明原因」。
- 选中「✎」或选中带理由的否决项时，底栏上方向上展开 120 高的理由抽屉（`motion.duration.drawer`）：
  多行输入 + 「提交（⌘Enter）」「返回（Esc）」；Esc 收起抽屉并保留草稿。

| Token | 值 | 说明 |
|:---|:---|:---|
| `ratio.confirm.width` | 0.75 | 宽占窗口比例 |
| `ratio.confirm.height` | 0.8 | 高占窗口比例 |
| `size.confirm.width_max` | 920 | 宽上限 |
| `size.confirm.height_max` | 680 | 高上限 |
| `size.confirm.header_height` | 48 | 头部高 |
| `size.confirm.footer_height` | 60 | 底栏高 |
| `size.confirm.reject_drawer_height` | 120 | 理由抽屉高 |
| `size.confirm.progress_height` | 2 | 阅读进度条高 |
| `limit.confirm.unread_hint_px` | 200 | 距底多少 px 出未读提示 |

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

| Token | 值 | 说明 |
|:---|:---|:---|
| `size.button.height` | 32 | 按钮高 |
| `size.button.height_sm` | 24 | 小按钮高 |
| `size.button.padding_x` | 12 | 按钮左右内边距 |

---

## 9. 底部状态条

单行高 28，底 `bg.surface`，顶部 1px `border.subtle`，左右内边距 12，`font.small`；显示**当前选中会话**的门禁状态。
从左到右、段间距 12：

1. **mode 徽标**：高 18，圆角 `sm`，内边距 2/6，`font.caption`；`loop` / `explore` / `normal` / `orchestrator`
   分别用 `mode.<mode>.bg` / `mode.<mode>.text`。
2. **分支**：`git-branch` 12 + 分支名（`font.code_small`，最大宽 160，末尾省略）。
3. **轮次**：`refresh-cw` 12 + 「轮 N」；只在 loop / orchestrator 会话与 judge 会话显示（与门禁 widget 一致）。
4. **未满足项**：N > 0 时 `alert-circle`（`semantic.warning`）+ 「N 项未满足」；N = 0 时 `check`（`semantic.success`）+「门禁已满足」。
   点击弹出浮层列出每一项（只读）。

整条不换行；窗口窄时按 4 → 3 → 2 的顺序把文字收成只剩图标，mode 徽标永不隐藏。

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
- 应用在前台但事件来自别的会话时，右上角弹应用内横幅（`bell` + 标题 + 正文首行，宽 320，`shadow.low`，4 秒后自动收起，
  点击切到该会话）。
- 点击系统通知：激活应用并选中发出通知的会话；若是「等你回答」，同时聚焦它的对话框。

---

## 11. 动画清单

| Token | 值 | 触发 | 缓动 | 变化 |
|:---|:---|:---|:---|:---|
| `motion.duration.tab_switch` | 200 | 切换选中会话 | `emphasized` | 聊天区 opacity 0.85→1，translateY 4→0 |
| `motion.duration.hover` | 120 | 指针移入/移出侧栏行、按钮 | `standard` | 背景色过渡 |
| `motion.duration.sidebar_select` | 120 | 侧栏行被选中 | `standard` | 选中底色与左竖条（竖条高度 0→100%） |
| `motion.duration.choice_hover` | 120 | 选项行 hover / 焦点移动 | `standard` | 背景与边框色过渡 |
| `motion.duration.dialog_enter` | 180 | 门禁对话框/长文本框出现 | `emphasized` | scale 0.96→1，opacity 0→1 |
| `motion.duration.dialog_exit` | 120 | 提交 / Esc 关闭 | `exit` | scale 1→0.98，opacity 1→0 |
| `motion.duration.scrim_enter` | 150 | 遮罩出现 | `emphasized` | opacity 0→1 |
| `motion.duration.scrim_exit` | 120 | 遮罩消失 | `exit` | opacity 1→0 |
| `motion.duration.collapse` | 200 | thinking / 工具结果 / diff / 分组 折叠展开 | `emphasized` | 高度 0↔内容高（裁剪），opacity，箭头旋转 0↔90° |
| `motion.duration.drawer` | 200 | 理由抽屉展开/收起；单选框内切到理由编辑器 | `emphasized` | 高度 0↔120 / 内容淡入 |
| `motion.duration.toast` | 240 | 应用内通知横幅出现 | `emphasized` | translateY -8→0，opacity 0→1（收起用 `exit` 120） |
| `motion.duration.cursor_blink` | 800 | 流式生成中 | 阶跃 | 0–400 显示，400–800 隐藏，循环 |
| `motion.duration.pulse_working` | 1800 | 会话 working | `pulse` | 状态点 scale 0.92→1.08→0.92，opacity 0.5→1→0.5，循环 |
| `motion.duration.pulse_waiting_input` | 1200 | 会话 waiting-input | 线性关键帧 | 0:1.0 → 150:1.25 → 300:1.0 → 450:1.25 → 600:1.0 → 1200 静止，循环 |
| `motion.duration.spinner_rotation` | 1000 | 工具 running | 线性 | 旋转 360°，循环 |
| `motion.duration.flyout_delay` | 150 | 图标栏悬停 | — | 延迟后弹浮卡 |
| `motion.duration.reduced_motion_fade` | 60 | 减少动态效果时的一切进出场 | 线性 | 只有 opacity |

| Token | 值 |
|:---|:---|
| `motion.easing.emphasized` | 0.16, 1, 0.3, 1 |
| `motion.easing.standard` | 0.2, 0, 0, 1 |
| `motion.easing.exit` | 0.4, 0, 1, 1 |
| `motion.easing.pulse` | 0.4, 0, 0.2, 1 |

**减少动态效果**（macOS「辅助功能 → 显示 → 减少动态效果」开启时）：

1. 所有位移、缩放、高度动画取消，直接到终态；进出场只保留 60ms opacity。
2. working 呼吸停止：静态实心点。
3. waiting-input 心跳停止：换成静态双环（内 6px 实心 + 外 12px 1.5px 描边环），仍与其他状态可分。
4. 流式光标常亮不闪；工具 running 的 `loader-2` 停转，改为静态 `loader-2` + 耗时计秒继续走。

---

## 12. 键盘操作

焦点优先级：打开的对话框 > composer > 聊天区 > 侧栏。对话框打开时，下列对话框键只作用于对话框；
全局键（带 ⌘ 的会话切换）仍可用，切走后对话框留在原会话。

**全局**

| 键 | 动作 |
|:---|:---|
| ⌘1 … ⌘9 | 选中侧栏第 1–9 个会话（按侧栏可见顺序） |
| ⌘[ / ⌘] | 上一个 / 下一个会话 |
| ⌘⇧A | 跳到下一个 waiting-input 的会话 |
| ⌘B | 侧栏在完整 / 图标栏之间切换 |
| ⌘L | 聚焦 composer |
| ⌘F | 在当前会话聊天流内查找 |
| ⌘, | 偏好设置 |
| PageUp / PageDown | 聊天区翻一屏 |
| ⌘↑ / ⌘↓ | 聊天区到顶 / 到底 |

**composer**

| 键 | 动作 |
|:---|:---|
| Enter | 发送 |
| ⇧Enter | 换行 |
| Esc | 会话生成中：中止；否则失焦 |

**单选对话框**

| 键 | 动作 |
|:---|:---|
| ↑ / ↓ | 移动焦点（选项 → ✎ 行 → 返回行，循环） |
| A / B / C / D | 焦点跳到对应选项并选中（不提交，防误触） |
| Enter | 提交焦点所在行（焦点在 ✎ 行 = 打开理由编辑器；在返回行 = 返回上一题） |
| ⌘← | 返回上一题（仅第 2 题起） |
| Esc | 关闭对话框 = 停止整场采访 |

**理由编辑器**

| 键 | 动作 |
|:---|:---|
| Enter | 换行 |
| ⌘Enter | 提交理由 |
| Esc | 退回选项列表，草稿保留 |

**多选对话框**

| 键 | 动作 |
|:---|:---|
| ↑ / ↓ | 移动焦点 |
| Space 或 A–D | 切换该项勾选 |
| Enter | 提交当前勾选（焦点在 ✎ / 返回行时执行该行） |
| ⌘← / Esc | 同单选 |

**长文本确认框**

| 键 | 动作 |
|:---|:---|
| ↑ / ↓ / PageUp / PageDown / Space | 滚动全文 |
| Tab / ⇧Tab | 在底栏按钮间移动焦点（打开时焦点在推荐按钮上） |
| A / B … | 直接选中对应按钮（不提交） |
| Enter | 触发焦点按钮 |
| Esc | 抽屉打开时收起抽屉；否则关闭 = 停止采访 |

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
- 门禁对话框：2–4 选项 + A/B/C 字母、（推荐）、✎ 不选我说明原因 + 多行理由编辑器、← 返回上一题（第 2 题起）、
  N/M 进度 —— §6.1；多选勾选清单 —— §6.2。
- 长文本确认框：需求反述 / goal / plan 全文 + 批准 —— §7。
- 底部单行状态条：mode / 分支 / 轮次 / 未满足项 —— §9。
- 原生通知 —— §10。
- 组件状态 hover / focus / pressed / disabled —— §4.3、§6.3、§8；动画 —— §11；键盘 —— §12。
