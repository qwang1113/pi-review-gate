---
name: worktree-edit-discipline
description: 工作区与编辑工具的操作纪律——变异分析、「临时改一下看看」这类实验必须做在 $TMPDIR 副本或 git worktree 里，工作区只被编辑工具改（门禁在这里只提醒、不拦截）；以及 anchor 编辑工具（insert/replace）每次编辑后复查 diff 的口径。在做变异分析或任何需要「改了再还原」的实验前加载；在准备用 sed -i / python -c / cat > 改文件前加载；在连续多次 insert/replace 同一个文件前加载。
---

# 工具操作纪律

## 1. 实验做在副本里，工作区只被编辑工具改

「改一下看看会不会失败」——变异分析、二分定位、临时插一行 log——诱惑在于直接改工作区再还原。**不要。**

### 三条理由，一条比一条硬

**(a) 还原失败没人会发现。** 实证：一个子会话用 `python3` 直接改工作区再还原。还原若失败，被污染的正是**正在被审查的内容**，而审查者看的是 commit range、你看的是 diff——两边都不会把「多出来的一行」认成事故。

**(b) 它照样会打掉你的 READY，而且更难排查。** 指纹观察的是**文件系统**，不是编辑事件——`lib/fingerprint.ts` 里明写这个威胁模型：

> an event-driven cache keyed on "the extension saw no edit tool call" is unsound — `sed -i` in bash, an external editor, format-on-save, or a background process all change the worktree without any event, and this gate's threat model explicitly includes an agent editing files through arbitrary bash.

所以 bash 改工作区**一样**会让 READY 失效；区别只是它不会被归因进 `sessionEditedFiles`，于是你排查「谁动了工作区」时对不上号。

**(c) 门禁在这里只提醒、不拦截，纪律得你自己守。** `lib/edit-discipline.ts` 开头是明确的设计约束：

> DESIGN CONSTRAINT (user requirement): these are NUDGES ONLY — appended text in tool results and a system-prompt paragraph. **Nothing here blocks**, rewrites commands, or adds enforcement.

而且那条提醒只在「同一个 turn 里刚有一次 edit/write 失败」的窗口内才追加。**没有失败前置时，`sed -i` 一声不吭地就过去了。**

### 正确做法

```
git worktree add "$TMPDIR/probe" HEAD
cd "$TMPDIR/probe" && <随便改，随便跑>
```

reviewer 自己就是被这么要求的（`lib/parallel-review.ts:283`）：把被审的 commit 检出到 `$TMPDIR` 下的一次性 worktree 里跑测试与变异，**绝不碰实时工作区**，因为主会话可能正在编辑它，结果会被污染。判官的 `$TMPDIR` 由门禁指到每会话专属目录并负责回收（谁创建谁回收）。

新建**孤立**的探针文件（不是副本）时，直接写到 `$TMPDIR` 下即可——本 skill 第 2 节的四次实测就是这么做的，工作区一个字没动。

### 一条例外，说清楚再用

编辑工具无法**删除**文件，所以删文件只能用 `rm`。用的时候把「为什么必须用 bash」说出来，并在前后各留一次证据（删前 `ls -l` + 校验和，删后确认不存在）。

## 2. anchor 编辑工具：每次编辑后复查 diff

### 一条曾被报告、但未能复现的症状

一份 2026-09-05 早间的轮次复盘记录是：`insert` 会在**字符串拼接 / 参数列表中间**塞进空行；直接删那个空行是 **noop**，必须连相邻锚点一起替换。

**同日稍后的四次实测未能复现这两条。** 探针留在 `/tmp/pm-rounds/evidence/t3b/insert-probe.ts`，覆盖当时点名的两种形状：

| # | 操作 | 位置 | 结果 |
|---|---|---|---|
| 1 | `insert` after | 字符串拼接中间（`"second line " +` 之后） | 干净，无空行 |
| 2 | `insert` after，一次两行 | 参数列表中间（`beta,` 之后） | 干净，无空行 |
| 3 | `insert` before | 参数列表中间（`gamma,` 之前） | 干净，无空行 |
| 4 | `replace` 空行 → `[]` | 文件中唯一的空行 | **正常删除**，不是 noop |

最终探针文件 15 行、空行数 0。

**所以：不要把「`insert` 必然塞空行」当成既定事实去做预防性重构。** 当时的观测是真实的，但它要么已被修复、要么依赖上述四次探针未触及的特定形状——在能复现之前，它不是一条可依赖的规律。

### 仍然成立、且成本几乎为零的做法

1. **每次 `insert` / `replace` 后看一眼返回的 diff。** 工具本身就会回显带锚点的 diff（`+anchor│` / ` anchor│`），看它一眼不需要额外调用，却能当场发现任何意外行。
2. **一次一个编辑，看过 diff 再做下一个。** 锚点会随编辑更新，回显的 diff 行就是下一次编辑可用的新锚点——不必重新 `read`。
3. **要动的是「一段」而不是「一行」时，用 `replace` 覆盖整段**（`remove_from` / `remove_to` 圈住首尾锚点），而不是逐行删。整段替换的结果是你写出来的样子，不依赖对相邻行副作用的猜测。
4. **改文件一律走编辑工具**，`bash` 只用于只读诊断——理由见上一节 (b)、(c)。
