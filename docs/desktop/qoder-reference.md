# Qoder 设计语言提取要点（参照用）

本文记录从本机 Qoder（`/Applications/Qoder.app`，`package.json` 版本 `0.4.3`，Electron + React + Tailwind v4 +
`framer-motion` + `sonner` + `streamdown`）只读提取的设计事实，供 `docs/desktop/ui-design.md` 的修订引用。
**只借鉴设计语言**：不复制它的图标、插画、字体文件或任何专有资源；数值是观察值，最终数值以
`desktop/design/tokens.json` 为准。

提取方式（只读，不改 `/Applications` 下任何东西）：

```sh
npx --yes @electron/asar extract /Applications/Qoder.app/Contents/Resources/app.asar /tmp/qoder-asar
```

出处缩写：
- `CSS` = `/tmp/qoder-asar/out/renderer/assets/index-CO9JoLwe.css`（Tailwind 编译产物 + 自定义样式，变量名是哈希过的 `--qxxxxxx`）
- `JS` = `/tmp/qoder-asar/out/renderer/assets/index-nRmb_3VI.js`（渲染进程主包，组件与动效参数；按下文给出的标识符 `rg` 即可定位）

---

## 1. 布局与外壳

| 事实 | 出处 |
|:---|:---|
| 外壳是一整块圆角容器：`loop-chrome-shell … rounded-xl … p-1`，窗口内再留 4px 边，侧栏与内容区像两张卡片并排 | JS `WorkbenchFrame` |
| 左侧栏默认宽 238（主工作台传 248），最小 180 / 208，最大 420；内容区最小 320 | JS `WorkbenchFrame`（`defaultSidebarSize:M1=238`、`minSidebarSize`、`maxSidebarSize:A1=420`、`minContentSize:j1=320`） |
| 侧栏**完全收起到 0 宽**（不是图标栏）；收起/展开按钮在标题栏左上（红绿灯右侧），⌘B 切换左栏、⌘⇧B 切换右栏、⌘J 底部面板 | JS `toggleLeftSidebar` 键位注册（`key:"b",primary:!0`）、`RIGHT_SIDEBAR_SHORTCUT_LABEL`、`LayoutChrome` |
| 标题栏按钮组高 40（`h-10`），离左 16 | JS `WorkbenchFrame`（`absolute left-4 top-1 z-20 flex h-10`） |
| 侧栏会话行高 30，超过 40 条虚拟滚动 | JS `SIDEBAR_SESSION_ROW_HEIGHT=30`、`SIDEBAR_SESSION_VIRTUALIZATION_THRESHOLD=40` |
| 控件高度分布：`h-7`(28) 最多，其次 `h-8`(32)、`h-9`、`h-10`、`h-6`；紧凑是主基调 | JS 类名计数 |

## 2. 侧栏收起/展开动画

| 事实 | 出处 |
|:---|:---|
| 宽度动画：内容区与侧栏两个 panel 同时做 `flex-grow` 过渡，时长/曲线来自 `DEFAULT_WORKBENCH_MOTION = { durationMs: 220, easing: [.2,.8,.2,1] }` | JS `DEFAULT_WORKBENCH_MOTION`、`setPanelFlexTransition` |
| 侧栏内容**随宽度联动**：透明度按宽度 0→96px 映射 0→1，横移按宽度 0→156px 映射 -12→0px（先被裁剪，再淡入、滑回） | JS `useTransform(Y1,[0,96],[0,1])`、`useTransform(Y1,[0,156],[-12,0])` |
| 展开时恢复到收起前记住的宽度 | JS `h2.current`（上次非零宽） |
| 系统「减少动态效果」开启：直接 `collapse()` / `resize()`，无过渡 | JS `c2=useReducedMotion()` 分支 |
| 次级布局动效 `DEFAULT_WORKBENCH_SECONDARY_MOTION = 320ms, [.25,.1,.25,1]`（抽屉宽度变化同值） | JS 同名常量；CSS `.qoder-drawer-content{transition:width .32s cubic-bezier(.25,.1,.25,1)}` |

## 3. 抽屉（Drawer）与对话框

| 事实 | 出处 |
|:---|:---|
| 抽屉默认从**右侧**滑出，`inset-y-0` 贴满高度，左侧圆角 `rounded-l-lg`，1px 边框 + `shadow-lg`；宽 `md` = 384（`w-96`），`lg` = 560；详情抽屉用 620 | JS `DrawerContent`（`side:t1="right"`、`n1==="lg"?"w-[560px]":"w-96"`），`w-[620px]` |
| 抽屉头部高 40（`h-10`），左右内边距 12 | JS `DrawerHeader` |
| slide 进场 240ms / 退场 200ms，曲线 `cubic-bezier(.2,.8,.2,1)`，位移 100%（左侧抽屉 -100%） | CSS `qoder-drawer-enter` / `qoder-drawer-exit` |
| reveal 变体：240ms `cubic-bezier(.22,1,.36,1)`，从 94px 外 + `blur(2px)` + 透明度 0 滑入；视觉效果关时 blur 为 0 | CSS `.qoder-drawer-content[data-drawer-motion=reveal]` |
| 抽屉「展开态」背后是 35% 表面色 + `blur(2px)` 的轻遮罩；遮罩退场 240ms 同曲线 | CSS `.qoder-drawer-expanded-backdrop`、`.qoder-drawer-overlay` |
| 抽屉展开态把兄弟节点设为 `inert`（焦点圈在抽屉内）；关闭后焦点回到触发元素 | JS `DrawerContent`（`y1.inert=!0`、`f1.current?.focus`） |
| 居中对话框：遮罩 `bg-mask/60` + `blur(16px)`；面板 `rounded-xl` + 1px 边 + `shadow-lg`，内边距 24；宽档 sm/default/lg/xl = 384/512/672/896 | JS `DialogOverlay`、`DialogContent`；CSS `--qed37fb:blur(16px)` |
| 对话框进场：opacity 0→1、scale .95→1、y 8→0，220ms（`LAYOUT_TRANSITION`）；退场 150ms（`MICRO_TRANSITION`），曲线都是 `EASE_OUT = [.2,.8,.2,1]` | JS `EASE_OUT`、`MICRO_TRANSITION`、`LAYOUT_TRANSITION` |
| 打开时焦点落到内容里第一个可聚焦元素，关闭时焦点回到打开前的元素 | JS `onOpenAutoFocus` / `onCloseAutoFocus` |
| 减少动态效果：所有进出场 `duration: 0`，只保留 opacity；抽屉 `animation:none; transition:none` | JS `useReducedMotion` 分支；CSS `@media(prefers-reduced-motion:reduce)` |

## 4. 聊天流

| 事实 | 出处 |
|:---|:---|
| 正文 `text-sm leading-6`（14/24） | JS `markdown-body text-sm leading-6` |
| **流式文字按「词」逐个淡入**：每个新词 `blurIn`（opacity 0→1 + `blur(4px)`→0），160ms `ease-out`，词间错峰 20ms；已出现的部分不重放 | JS `STREAMDOWN_STREAM_ANIMATE={animation:"blurIn",duration:160,easing:"ease-out",sep:"word",stagger:20}`；CSS `@keyframes sd-blurIn` |
| thinking / 工具 / 子 agent 块：折叠头 `min-h-6`，展开体 `height 0↔auto` + opacity，200ms `[.2,.8,.2,1]`；展开体左缩进 20、圆角 6、底 `fill-tertiary`、等宽 11/18、最大高 400 内部滚动 | JS `AnimatePresence` + `height:"auto"` 的多处调用（`chatActivity.thinking` 附近） |
| 折叠箭头 `rotate 0↔90°`，160ms | JS `animate:{rotate:i1?90:0},transition:{duration:l1?0:.16}` |
| 运行中的摘要文字切换用 opacity 交叉淡化 | JS `subagent-running-summary` |
| 生成中 assistant 头像做「停-转-停」旋转，2.8s 循环 | CSS `chat-assistant-avatar-generating` |
| 生成中「回到底部」箭头做 2.4s 呼吸（opacity .62↔1 + 光晕） | CSS `chat-timeline-scroll-generating-arrow-breath` |
| composer 占位文字轮换：旧的上移淡出、新的自下而上淡入，180ms `[.2,.8,.2,1]` | CSS `chat-composer-placeholder-enter/exit` |
| 滚动容器边缘用渐隐遮罩（scroll-driven `scroll-fade-y-start/end`）暗示还有内容 | CSS `scroll-fade-*` |

## 5. 页面切换与设置页

| 事实 | 出处 |
|:---|:---|
| 页面/会话切换进场：opacity 0→1、y 8→0，180ms `[.2,.8,.2,1]`；减少动态效果时 `duration: 0` | JS `pageEnterMotionTransition={duration:.18,ease:[.2,.8,.2,1]}`、`getPageEnterInitial` |
| 设置页复用同一个 `WorkbenchFrame`：左侧导航 248 宽（最小 208），右侧内容区 | JS `SettingsView` 调 `WorkbenchFrame` |
| 设置导航项 28 高、12px 字、圆角 lg；**选中底色是一块会滑动的背景**（spring stiffness 420 / damping 26 / mass .75，scale .9→1 + opacity） | JS `settingsSidebarNavButtonClass`、`settingsSidebarNavMotionVariants`、`SettingsSidebarNavMotionBackground` |
| 设置分区：标题区高 44、左右内边距 16；分组卡片 `rounded-xl` + 1px 边 + 极浅阴影 + 内边距 16；行之间是**虚线**分隔，行上下内边距 14 | JS `SettingsSectionHeader`、`SettingsGroup`、`SettingsItem` |
| 设置行展开详情：220ms `[.2,.8,.2,1]`；小元素（图标/徽标）140ms | JS `SettingsItem`（`x1` / `y1`） |
| 写进 settings.json 之前把**将写入的完整 JSON 摆给用户确认**，并提示「无法自动恢复旧配置」 | JS i18n `settingsJson`、`replaceWarning` 文案 |

## 6. 反馈与微交互

| 事实 | 出处 |
|:---|:---|
| 全局默认过渡 150ms `cubic-bezier(.4,0,.2,1)`（Tailwind 默认），hover 颜色过渡多数 150ms | CSS `--default-transition-duration:.15s` |
| 最常用的自定义曲线是 `cubic-bezier(.2,.8,.2,1)`（出现 18 次），其次 `.16,1,.3,1`、`.22,1,.36,1`；弹性 `.34,1.56,.64,1` 只用于少数强调 | CSS 缓动计数 |
| 时长分布：180ms 最多，其次 150、350、160ms | CSS `transition` 计数 |
| 按下反馈：`:active` 缩放 .95 / .96 / .97，图标按钮 .88；部分按钮下沉 1px | CSS `:active{scale:.96}` 等 |
| 开关（switch）拇指按下时先被「吸」宽再回弹，150ms 分段曲线 | CSS `qoder-switch-attract-width-on` |
| 通知用 `sonner`，主窗口 toast 在右下角，带成功/警告/错误/加载图标 | JS `Toaster`（`position:s1="bottom-right"`） |
| framer-motion 自带的弹簧：欠阻尼 stiffness 500 / damping 25，临界阻尼 550 | JS `underDampedSpring`、`criticallyDampedSpring` |
| 小部件（图标柱、贴纸）的弹簧：stiffness 360 / damping 24 / mass .45；260 / 24–28 / .72 | JS 对应组件 |
| 应用内另有「视觉效果」开关（`data-visual-effects=off`）去掉 blur；主题切换走 View Transition 淡入淡出 | CSS `:root[data-visual-effects=off]`、`qoder-theme-transition-fade-*` |

## 7. 配色、字体、圆角

| 事实 | 出处 |
|:---|:---|
| 多主题（light / dark / forest / bee / mint / parchment），默认主题是**低饱和墨绿**品牌色（浅色 `#4b6f5a`、深色 `#5cb870`），中性色是暖灰而不是冷灰（深色底 `#0e0e0e`、表面 `#111110`、边 `#292926`，正文 `#eeeeeb`） | CSS `:root[data-theme=light]…`、`html[data-theme=forest-dark]…` 块 |
| 大量使用半透明黑/白叠加层（4%–55% 一组梯度）做 hover/pressed/遮罩，而不是另起实色 | CSS `--q09404f:#00000008` … `--q19d5ac:#0000008c` |
| 表面阴影是「1px 描边式阴影 + 两层极浅投影」：`0 0 0 1px #0000000f, 0 1px 2px -1px #0000000f, 0 2px 4px 0 #0000000a` | CSS `--q8319e2` |
| 圆角阶梯 2/4/6/8/12/16，并用 `corner-shape: squircle`（超椭圆） | CSS `--radius-*`、`.squircle-lg` |
| 字号集中在 13 / 12 / 11 / 10，行高 18 / 22 为主 | JS 类名计数 |
| 字体：系统无衬线为主，打包 Inter、Instrument Sans | CSS `--font-sans`、`@font-face` |

## 8. 图标

| 事实 | 出处 |
|:---|:---|
| 自有图标包 `@ali/qoder-icon`，组件名 `Qoder<名字>Line` / `Qoder<名字>Fill` 成对（线性约 1767 处引用、实心约 750 处）：默认用线性，状态/强调用实心（如成功 `QoderCheckboxCircleFill`、警告 `QoderAlertFill`） | `package.json` 依赖；JS 组件名计数 |
| 图标尺寸集中在 14（`size-3.5`）与 16（`size-4`），其次 20、12；按钮内图标统一 `[&_svg]:size-3.5` | JS 类名计数 |
| 线性图标描边 2 为主；颜色跟随文字色（`text-text-tertiary` 等），hover 时随文字一起变深 | JS `strokeWidth:2` 计数；折叠箭头 `QoderArrowRightSLine` 等处 |
| 折叠箭头用右向箭头旋转 90° 表示展开；关闭用 `QoderCloseLine`；抽屉收起按钮用双右箭头 | JS 对应组件 |

---

## 采用与不采用（本仓的取舍，详见 `ui-design.md`）

- **采用**：侧栏完全收起（宽度 + 内容联动淡出横移）；右侧抽屉承载所有提问；页面进场 opacity + y 8；流式按词淡入；
  折叠块 height auto + 箭头旋转；按下缩放；设置页左导航 + 分组卡片 + 虚线分隔行；写配置前可审阅；减少动态效果一律降到 0 或纯淡入。
- 图标：本仓继续用 Lucide（线性、描边 1.5、尺寸 12/14/16，`ui-design.md` §3），与 Qoder「线性为主、14/16 为主」的做法一致，不引入它的专有图标包。
- **不采用**：品牌墨绿（本仓保留 Indigo，已有状态色语义）；`blur` 背景模糊（GPUI 不支持，见 `ui-design.md` §2.4）；
  squircle（GPUI 无 `corner-shape`，用普通圆角）；多主题；桌宠、贴纸、全息卡片等装饰性动效。
