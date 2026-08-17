# pi-review-gate — 5 分钟上手

质量门禁：**未通过独立 review + precommit，`git commit` / `git push` / `gh pr create` 一律被硬拦截**。本文件是快速上手；完整设计、威胁模型与全部命令见 [README.md](README.md)。

## 1. 安装

```bash
pi install /absolute/path/to/pi-review-gate   # 或 npm:pi-review-gate
# postinstall 自动：复制 agents、注册依赖包、安装 git hooks（当前目录是 git 仓库时）
```

然后 `/reload`（或重启 Pi）。其他仓库想装 hooks（会话外的防御）：

```bash
bash <package-root>/scripts/install-git-hooks.sh   # 在目标仓库内执行
```

## 2. 三种会话模式（agent 启动时自行分类，也可你随时 `/gate-mode` 切换）

| 模式 | 行为 | 适用 |
|------|------|------|
| `loop` | 完整门禁：review READY + precommit PASS 才能 ship；未满足时自动继续 | 写代码、改文档、交付 |
| `explore` | 门禁 advisory，ship 命令仍被拦；agent 可自行结束 | 调查、分析、排障 |
| `normal` | 门禁完全关闭（agent 不能自己选，需你确认） | 闲聊、杂事 |

## 3. 一个典型 loop 会话长什么样

```
你：实现分页功能
agent：调 set_gate_mode("loop")
  → 问你目标（一次一题，N of M）→ propose_loop_goal 弹窗让你批准
  → 改代码
  → run_precommit（fast）→ 全绿
  → prepare_review（每个 reviewer 一个一次性快照 + 一个 findings 流文件）
  → reviewer 在快照里审（本机有两个可判模型族就跑两个，只有一族就跑一个并在 Note 里声明）
     同时：agent 边读流式 findings 边修（不用等审完）
  → record_review（顺带机械校验快照有没有被 reviewer 改脏）
  → BLOCKED？修 → 再来一轮；READY？declare_done → 提交
```

- **先 precommit 后 review**：便宜的检查先跑，贵的审核只花在绿树上。
- 每轮按 ROUND 计费：**把相关改动批量做完再触发一轮**，比十个小轮省十倍。
- 最终轮用 `run_precommit mode=full`（push/PR/declare_done 要求测试没被收窄）。
- **指纹是内容寻址且 staging-invariant**：`git add`、`git commit`、以及**不改写工作区文件的**切分支
  都**不会**动它，READY + PASS 依然有效——**不要为了"重建绑定"而重跑一轮 review**（那是纯浪费）。
  只有工作区文件内容变化才会让指纹变化（编辑、lint:fix、或一次会改写文件的 checkout）。
- **复审要带上一轮结论**：第 N+1 轮把上一轮的 verdict 与 findings 交给 reviewer；
  已定论且未改动的部分只做一致性扫描，不重新论证（门禁会自动注入这段 scope）。
- **reviewer 跑在一次性快照里，你可以边审边修**：`prepare_review` 给每个 reviewer 开一个独立
  git worktree（内容 = 待审改动，`node_modules` 软链）。它在里面随便改、随便跑变异测试，
  碰不到你的工作树；你则可以把它已确认的 P0/P1/P2（带证据的）当场修掉。代价：边修边审会让
  工作树变动，READY 可能对不上指纹 → 门禁要求再来一轮（但那一轮的修复工作你已经做完了）。
- **快照完整性是机械校验的**：reviewer 必须在结束前还原所有变异；`record_review` 会重算快照
  tree，发现没还原就把该审的 READY 降为 BLOCKED（findings 仍然算数）。

## 4. 配置（可选）

- 项目配置：`.pi/review-gate.json`（每克隆一份）
- 用户全局兜底：`~/.pi/review-gate.json`（同一文件格式；项目字段优先，逐字段合并）
- 可用字段：`maxRounds`(3–50)、`thinkHarder`、`gitMemory`、`docSync`(默认开)、
  `llmGuards`、`arbiter`、`copilotReview`、`precommit`（各步骤的 script/command/skip）
- 生成器：`/gate-init` 交互式生成 precommit 段。

## 5. 常见"被 block"场景与逃生

| 现象 | 原因 | 处理 |
|------|------|------|
| `code review gate is PENDING` | 改完没 review | 走 review 循环（或 `/review`） |
| `precommit not run` / `FAILED` | 没跑或跑挂了 | `run_precommit`；修失败项 |
| `fingerprint mismatch` | 审核后又改了文件 | 再 review + 再 precommit |
| `docSync enforced` | 代码改动缺文档 attestation | reviewer 在 verdict 里给 `UPDATED`/`NOT_NEEDED` |
| commit/PR 文案非英文 | L5 硬拦截（majority-body 判定） | 改成英文；或你执行 `/gate-bypass <reason>` |
| `Unknown JSON field: "headRefOid"` | gh 版本过老 | 已自动 fallback（升级 gh 更佳） |
| 模型 429 / 额度耗尽，循环空转 | provider 限流，注入再多也没用 | 熔断器会在连续无进展后停止注入并提示；`/model` 切到其它 provider（如 anthropic），你的下一条消息即恢复循环 |
| agents 副本与仓库不同步（正文过时） | `~/.pi/agent/agents/*.md` 落后于本仓库 | 重跑 `node scripts/install-package.mjs`（幂等）；用 `/gate-doctor` 检出 |
| `SNAPSHOT INTEGRITY: … DRIFTED` | reviewer 做完变异测试没还原（或把草稿文件写进了快照） | 重新 `prepare_review` 拿一个干净快照，重跑那一个 reviewer；它的 findings 仍然有效 |
| `snapshot isolation UNAVAILABLE` | 本机 `git worktree` 不可用（无提交、权限、非 git 目录） | 按老规矩走：reviewer 不许改文件，你也别在审核期间修；门禁本身不受影响 |
| `.pi/review-snapshots/` 里堆了 `rg-review-snap-*` | 会话崩溃留下的孤儿快照 | 下次 `prepare_review` 或新会话启动会按时效自动回收；手动清理：`git worktree prune` + `rm -rf .pi/review-snapshots/rg-review-snap-*` |
| reviewer 改了依赖导致后续 precommit 诡异失败 | 快照里 `node_modules` 是指向真仓库的软链（共享路径之一），写它会穿透 | 重装依赖（`npm ci`）；reviewer 的提示词已明确禁止写 `node_modules` |
| `git commit` 报 `.git/hooks/pre-commit: No such file or directory` | 有人在快照里跑了安装脚本：快照是 linked worktree，**`.git/hooks` 与真仓库共享**，于是 hook 被指向了随轮删除的快照目录 | 在**真工作树**重跑 `bash scripts/install-git-hooks.sh`；两个安装器现已拒绝从 `.pi/review-snapshots/` 下运行 |
| 想完全绕过 | — | 你执行 `/gate-bypass <reason>`（会话内）或会话外用 `REVIEW_GATE_BYPASS=1`（仅 hooks 层） |

## 6. 常用命令

| 命令 | 作用 |
|------|------|
| `/gate-status` | 模式、verdict、轮数、未满足项 |
| `/gate-mode loop\|explore\|normal` | 你手动切换模式 |
| `/gate-bypass <reason>` | 你授权本会话跳过 ship 拦截 |
| `/review`、`/precommit` | 显式触发 review / precommit |
| `/gate-reset` | 重置门禁状态 |
| `/gate-lesson <text>` | 记录经验教训 |
| `/gate-doctor` | 只读体检：逐项检查优化是否生效（pdw 引擎、模型链、opencode-go 白名单、precommit runner、git hooks、全局配置、L5 门、Copilot gh、命令注册），输出 PASS/FAIL/WARN + 证据 + 修复建议 |

## 7. 成本须知

- review 用顶级推理模型（有两族就跨族双审，只有一族就单审 + Note），**按轮计费**——批量编辑再触发；
- `opencode-go` provider 在代码层面**只允许 deepseek-v4-flash**（其余模型按次计费且被显式禁止）；
- review 不跑 pdw 引擎（引擎不支持 per-agent cwd，reviewer 就拿不到自己的快照）：全部由 `prepare_review` + 子代理直接 spawn；
- 小 diff（<20 文件且 <500 行）：你传的 label 就是 reviewer 数量；
- 大 diff：`prepare_review` 自己分片（最多 4 片、不重叠且覆盖全量）+ 一次集成 review；
- wave/decompose 仍跑引擎（待拆，见 `docs/handoff-remove-pdw.md`）。
