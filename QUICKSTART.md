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
  → 双 reviewer（两个不同模型族的 max 思考模型）→ record_review
  → BLOCKED？修 → 再来一轮；READY？declare_done → 提交
```

- **先 precommit 后 review**：便宜的检查先跑，贵的审核只花在绿树上。
- 每轮按 ROUND 计费：**把相关改动批量做完再触发一轮**，比十个小轮省十倍。
- 最终轮用 `run_precommit mode=full`（push/PR/declare_done 要求测试没被收窄）。

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

## 7. 成本须知

- review 用顶级推理模型（默认跨族双审），**按轮计费**——批量编辑再触发；
- `opencode-go` provider 在代码层面**只允许 deepseek-v4-flash**（其余模型按次计费且被显式禁止）；
- 小 diff（<20 文件且 <500 行）不经过并行引擎，直接双 reviewer；
- 大 diff 自动分片（≤4 片并行）+ 一次集成 review。
