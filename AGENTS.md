# AGENTS.md

Project-level agent instructions for pi-review-gate.

## Product principles

Personal, local-first project — everything ships **default-on**. A new
feature is integrated directly and enabled by default; it never hides
behind an opt-in flag or a config toggle. If a feature cannot be safe by
default, make it safe by default rather than adding a switch.

### 三条哲学（2026-08-30 · 本项目的根本约束）

它们排在本文其余所有条目之前。此后每一轮改动都按它们判断对错 —— 包括判断
本文件里其他段落是不是已经过时。

> **哲学一 · 能由门禁提供工具的，就不要让 agent 自己拼命令。**
>
> 判断标准只有一句：这件事需要 agent 拼 shell / git / tmux 命令吗？需要，
> 那就是门禁的缺口，不是 agent 的失误。agent 只表达**意图**，门禁负责
> **怎么做**。一条要 agent 记住的多步流程，等价于一个迟早会漏掉某一步的缺陷。
>
> **哲学二 · 工具集要简洁、无歧义：一件事只有一个工具。**
>
> 不提供功能重叠的多个入口让 agent 挑 ——「用 A 也行、用 B 也可以」本身就是
> 设计失败：agent 每一轮都要停下来判断该用哪个，而它判断错的那次没人会发现。
> 多阶段流程（A→B→C）整合进**一个**工具，门禁在内部走完，中间态不暴露。
> 工具名要让 agent 一眼看出用途，不能靠读描述才明白。
>
> **哲学三 · 永不并行两套实现，只保留最新的。**
>
> 个人项目，不承担任何历史兼容负担。新方案落地时旧实现**删除** —— 不保留、
> 不加开关、不留兼容层、不做「advanced entry」这类后门。留着的旧路径不会
> 安静地待着：它会被人用、会漂移、会在某一轮变成事故的那一半。


### Single-review loop (the only execution path, agent-initiated)

**Judge roles run as their own pi processes** — the review is the only parallel
loop, and each round runs in its OWN non-interactive pi process (`pi -p`
with a deterministic `--session-id`), spawned by the extension itself
(`judge_submit`). The judge child loads NO review-gate extension and runs with
It runs with
`--exclude-tools edit,write`; its session id is DETERMINISTIC per role+repo,
so re-spawning with the same `--session-id` continues the same session — its
context is reused across rounds until a READY lands. Each review round is ONE
reviewer over the WHOLE change:

- **Review → ONE call**: `judge_submit({role:"reviewer", task:<what you
  changed this round>})`. The gate runs the whole chain itself — full
  precommit, the checkpoint commit (it stamps the checkpoint marker), the
  `baseline..HEAD` computation, the dispatch — and any step that fails sends
  the round back with the reason instead of leaving it half-submitted. The
  full precommit ALREADY ran typecheck + build + the complete suite on that
  exact content — **never manually re-run the full suite or `tsc`** before
  submitting (the runner caches by input: unchanged content reuses the
  recorded PASS in seconds). Develop with targeted tests only.
  The reviewer judges the IMMUTABLE commit range `baseline..HEAD` — the range
  starts at the last REVIEWED commit, so a chain of checkpoints since the
  last READY is all covered (round-9 P1); there is no second reviewer of
  any kind. When the judge's process exits, the gate reads THIS round's
  output, records the verdict itself and wakes you with it — you never carry
  a verdict from one tool to another. The recording keeps every mechanical
  check: HEAD must still be the reviewed commit (a new checkpoint after
  prepare ⇒ STALE ⇒ BLOCKED), and a READY binds to the reviewed commit's TREE
  (content binding — squash preserves it); the ship gates additionally refuse
  content-changing commits after the reviewed one (unreviewed content can
  never ship). `run_precommit` / `review_checkpoint` / `prepare_review` /
  `record_review` are **not tools** (2026-08-30, 哲学三): the gate still runs
  every one of those steps inside `judge_submit`, but none of them is
  registered, so there is no second path to sequence by hand.
  `review_diff` / `review_sandbox` were **evaluated and formally NOT built**
  (2026-08-31, 哲学三): the judge runs `--no-extensions` so there is nowhere to
  register them without a judge-side extension entry, and that would re-open the
  recursion surface `--no-extensions` exists to close. The reviewer's own `git
  diff` / `git show` are simple read-only commands (not the multi-step ship/tmux
  flows 哲学一 targets), and its sandbox verification is an inherently
  reviewer-owned judgement call, not a mechanical sequence the gate can own
  without becoming the reviewer. The reviewer's throwaway worktrees are the
  gate's to CLEAN, though, not to build: `judge_submit` points the judge's
  `$TMPDIR` at a per-session dir and reclaims any worktree under it when the
  judge exits (谁创建谁回收).

- **No decompose, no module loop, no wave daily.** The module-planning
  machinery and its wave tools were removed 2026-08-26. Large tasks are
  still sliced by YOU into sequential rounds of the same single review
  loop; there is no module table, no plan state, no planner.

Detail: `docs/execution-model.md` + `docs/judge-protocol.md`; runtime
contract: `lib/judge-process.ts` + `lib/judge-prompt.ts`.

The review loop is AGENT-DRIVEN: you start it yourself once edits
are complete (one `judge_submit`) — the slash commands are only optional
explicit triggers, never the expected entry. The user is asked at two points
only: `ask_user` (the ONE way to reach them — it runs the interview and
pauses the loop) and the loop-goal approval dialog.

Where work lands is yours again (2026-09-07, user decision): the workspace
settlement layer (`setup_workspace`, the mandatory work branch, declare_done's
squash-merge) is gone. You work directly on the branch you are on. Two
mechanical facts replace the old enforcement, and they are DIFFERENT from
each other:

- **The gate's own checkpoint** (`judge_submit` commits it) lands on the
  current branch, whatever it is. On a PROTECTED branch (main/master/dev/
  develop) it pops a confirmation dialog first — the user (or, in an
  orchestration, the project manager through the channel) confirms before it
  commits.
- **Your own `git commit`** on a protected branch is REFUSED by the ship
  gate (a shell command cannot show a dialog, so it fails closed).

`declare_done` closes the gates and leaves the work where it is;
merging/rebasing/pushing is your git workflow, guided by the guardrails
below — which still prefer a feature branch over working on main.

## Git workflow guardrails

These guardrails are the WORKFLOW this repo prefers — a feature branch is
the normal place for a change. They are not the gate's enforcement: the gate
only refuses your own `git commit` on a protected branch (its own checkpoint
confirms with the user instead, per above). On top of these rules, the
pi-review-gate extension hard-blocks ship commands (`git commit`, `git push`,
`gh pr create`) until the quality gates pass.

### Never work directly on main

- `main` only receives commits via merged PRs — never commit or develop
  directly on main, regardless of change size.
- Never push `main` (or `master`) to the remote, in any form: bare
  `git push` while on main, `git push origin main`, `git push origin master`,
  `git push --force origin main`, etc.
- If you find yourself on main with uncommitted changes: stop, create a
  feature branch via the flow below, and carry the changes over.
- If main holds commits that need to reach the remote: move them onto a
  feature branch (or cherry-pick them onto one), push from there, then reset
  local main back to `origin/main` (`git branch -f main origin/main` once
  checked out elsewhere) so main never keeps unmerged commits.

### Create branches from a confirmed base

Before creating a new branch:

1. `git fetch origin` to get the latest remote state.
2. Check for uncommitted changes (`git status --porcelain`); if any, stash
   them first (`git stash push -u`) or confirm with the user how to handle
   them.
3. Decide the base branch:
   - If the current branch is `main`: `git pull --ff-only origin main` so
     local main matches the remote, then branch off the updated main. If
     the ff-only pull fails (local main has diverged with exclusive
     commits), stop and tell the user — never force-push or merge main
     locally on your own.
   - If the current branch is **not** `main`: ask the user whether the new
     branch should branch off the current branch or off an updated `main`
     (pull `--ff-only` first if they choose main). Do not silently pick a
     base.
4. Create the new branch from the confirmed base: `git checkout -b
   <branch-name>`. Use kebab-case English branch names that summarize the
   change, e.g. `feat/add-pagination`, `fix/auth-token-expiry`.
5. If you stashed in step 2, restore with `git stash pop`.

Exception: skip the main update **only** when the user explicitly says not
to update main; in that case, honestly confirm that local main may be
behind the remote.

### Commit messages: Conventional Commits + English

- Format: `<type>(<scope>): <subject>` (scope optional). Full spec:
  https://github.com/conventional-changelog/conventional-changelog
- Common types: `feat` (new feature), `fix` (bug fix), `refactor`
  (refactoring), `docs` (documentation), `test` (tests), `chore`
  (maintenance), `perf` (performance), `build` (build system), `ci` (CI),
  `style` (formatting).
- Subject in **English**: imperative mood, lowercase start, concise (~50
  chars), no trailing period. Write the body in English too — explain *why*,
  not what the diff already says.
- Forbidden: non-English commit messages; uninformative subjects (`update`,
  `fix`, `changes`); boilerplate unrelated to the change.

Examples:

```
feat(api): add pagination to list endpoints
fix(auth): handle expired refresh tokens
docs(readme): document environment variables
```

### Pull requests

- Open PRs from a feature branch, never from main — `base`: main (or the
  project's default branch), `head`: the current feature branch.
- Make sure the current branch is pushed before opening the PR:
  `git push -u origin <current-branch>` for a new branch, `git push origin
  <current-branch>` once it is already tracked.
- Title follows the Conventional Commits style, written in **English**.
- Description in English summarizing: what changed, why, and how it was
  verified/tested.
- Forbidden: a PR whose head branch is main; non-English or empty
  title/description.

## Model tiers — capability × cost

Every sub-agent role is pinned to a real, available model id (see
`~/.pi/agent/models.json` / `models-store.json`) in one of three tiers; the
frontmatter in `agents/*.md` is the single source of truth and
`lib/model-config.ts` renders/validates the chains:

- **Strong tier — judging** (`reviewer`, `adviser`, `arbiter`,
  `goal-auditor`): `claude-fable-5` primary, fallback chain
  `claude-opus-5`, `thinking: max`.
  `goal-auditor` is the dedicated pre-reviewer of the loop GOAL (read-only
  tools) whose verdict the gate records mechanically.
  The L1/L2 execution tiers (`recon` / `fixer`) were retired — the gate
  ships the four judging roles only.

> **Why the chains are short.** every fallback in the
> (a provider that is not configured) fails the whole agent launch. The
> chains therefore pin only providers the package can rely on (anthropic);
> a user who configures onekey / deepseek / oc-sdk-go can extend the
> chains in `~/.pi/agent/agents/*.md`
> (the postinstall copies them from this repo — edits there are
> overwrite-owned on the next install).

**Model configuration layer (per-agent slots, NO built-in defaults).**
Every role's model chain comes from the `agents` section of `review-gate.json` —
there is no silent built-in fallback. `scripts/install-package.mjs` writes a
default 4-role `agents` section to `~/.pi/review-gate.json` when the file is
absent, and merges in ONLY the roles missing from an existing file (never
overwrites a user's own pins). At session start the gate HARD-CHECKS every
role (reviewer/adviser/arbiter/goal-auditor): a missing entry, an
empty slot list, or an unresolvable spec STOPS the session with the reason
(`validateAgentsForStartup`). `modelSpecFor` returns undefined for an
unconfigured role and the dispatch fails closed instead of spawning a default.

- `agents.<name>.auto` — `false` uses `slots: [spec, ...]` (`slots[0]` =
  main model, rest = fallbacks). Every slot may carry its own `:thinking`
  suffix (`claude-fable-5:max`, `onekey/gpt-5.6-sol:high`) for per-model
  thinking. `auto: true` keeps the upstream default chain as a shadow
  overlay (so a higher layer can shadow a lower layer's slot render), but
  the STARTUP check still requires an explicit slot list for every role —
  an unconfigured role is an error, never a silent default.
- **Arbiter goes through the same config layer**: `agents.arbiter.slots[0]`
  is the arbiter model (project-config's legacy `arbiter.model` field is a
  fallback only). An unconfigured arbiter fails closed (GATE_WINS).
- **Rendering is layered**: project → `<project>/.pi/agents/*.md`, global →
  `~/.pi/agent/agents/*.md`; `scripts/install-package.mjs` applies only the
  global layer. Writes validate (resolvable spec, supported thinking level)
- The pi widget (`belowEditor`) always shows the effective
  `adviser`/`reviewer` models (spec, auto state, deciding layer) — a
  read-only surface; the config itself is plain JSON in `review-gate.json`.
- A missing/corrupt `agents` section is a startup error, not a silent
  pass-through: the session stops and names every role that lacks a
  resolvable chain (`validateAgentsForStartup` + the before_agent_start
  hard check). Project/global layer diagnostics are surfaced when an
  `agents` section is malformed; invalid model specs never replace the last
  generated chain.

**Review protocol (single-review).** The review that ends
a round is ONE reviewer — by design. There is no second reviewer, no split
plan. The fallback chain inside the pinned reviewer agent definition exists
only because the package must resolve wherever a judge-eligible family
exists; it is NOT a runtime selector and does NOT change the one-reviewer
rule. A single reviewer is the norm, and no Note is required about it.
(a) **Goal pre-review — MECHANICALLY ENFORCED.** The draft goal must pass an
audit by the dedicated `goal-auditor` role before the user is ever asked to
approve it, and the gate runs that audit itself: `judge_submit({role:
"goal-auditor", task:<the full draft>})` builds the auditor's task, dispatches
it, adjudicates the verdict and records it. The adjudication is one rule —
**only P0/P1 block** — so a READY carrying P2/Nit findings is a PASS and
never buys another audit round (B2: the agent used to volunteer one). The
record is bound to the sha256 of the audited text, and `propose_loop_goal`
refuses — without rendering any dialog — unless that PASS matches the
submitted text exactly. A failed audit means: fix the objections and submit
the revised draft the same way (it needs its own PASS — the record binds to
content). The goal text must be written in **Simplified Chinese** (identifiers,
paths and code tokens stay English) — the auditor blocks a draft that is not.
(b) **Every re-review carries the previous round's conclusion — MECHANICALLY**:
the goal-auditor's re-audit gets the old draft + its own objections + what
changed (the gate persists every audit's verdict, findings verbatim and the
judged draft, and builds the re-audit task with that carryover plus the
mechanically computed draft delta); round N+1 of a code review gets the
previous verdict and findings the same way (the 'Review scope for this round'
block in the reviewer's task text). Settled-and-unchanged material gets a
consistency scan, not a
re-derivation — it never narrows what a reviewer may look at, and a settled
conclusion may always be reopened with evidence. This is the INCREMENTAL
review contract: first round full, later rounds focused on the increment.
(b2) **Fresh context, read on demand — MECHANICALLY.** The three review
roles (reviewer, adviser, goal-auditor) each run as their OWN pi process (`pi -p --session-id`) — they never
transcript location (`~/.pi/agent/sessions/<encoded-cwd>/<sessionId>.jsonl`)
to grep on demand. `judge_submit({role:"adviser"})` builds that brief itself:
transcript pointer + a conclusion artifact the adviser appends to, plus —
from the second consultation of a goal on — the previous conclusion and the
files changed since (no history ⇒ full brief).

(c) **The reviewer judges a COMMIT RANGE, and findings stream.** The chain
inside `judge_submit` computes `baseline..HEAD` (the
immutable commits under review) and a finding-stream file. Inside its own
copy a reviewer SHOULD verify by doing — mutation analysis included — and
must restore before finishing. Because the reviewed range is immutable,
**you keep fixing the real worktree while it runs**: take streamed P0/P1/P2
that carry evidence (confirm each in the code first), leave Nits for the
verdict. WAITING-WINDOW DISCIPLINE: (1) 有可实现的确定性工作(代码/测试/
文档/其他 repo 事务)→ 优先做掉,不要进入等待;(2) 确认没有可做的工作后再调
`judge_wait({role})`——门禁在里面跑三条判据(进程退出 / exit-code 落盘 /
本轮 stdout 里出现明文 fence,任一命中即返回)并把已读结论带回来,不需要你
手写 bash;(3) **禁止**用结束 turn 把唤醒责任交给子会话——子会话可能报错/
崩溃/永远不退,而主会话是门禁的最后监督者,门禁未通过前不得停止自动循环
(存活不变量)。
The verdict arrives through the process EXIT: the gate reads THIS round's
output, records it and wakes this session with the result. The reviewer may ask
questions by outputting a question fence and exiting — answer by submitting the
same role again (`judge_submit` resumes the session, context intact).
(d) **The judge child runs as its own pi process — MECHANICALLY ENFORCED.**
`judge_submit` runs the judge as `pi -p --session-id <id>` (non-interactive,
no tmux). The `subagent` dispatch surface was retired 2026-09-06 with the
pi-subagents companion — a judge role can only be dispatched through
`judge_submit`, so there is no second path to sequence by hand (the
workflow-sandbox block that used to guard `subagent` calls died with it: the
tool the block protected no longer exists). The
single reviewer is one `judge_submit` call per round; you never pass a session
id, a title or a directory — the gate derives all three from role+repo.
**One session per role, continued across rounds**: the session id is
deterministic per role+repo, so the next round re-opens the SAME transcript
(that is how a judge's context carries over until a READY). A role whose
process is still RUNNING refuses the new round rather than dropping it
(a non-interactive judge reads its task once, at spawn); `fresh: true` kills
it first. The recording withholds a READY unless the round was PREPARED (a
registered `baseline..HEAD` target) and the verdict carries the child's `cwd`
(measured with `pwd`, a required field of the verdict schema). While a judge
child is open, `declare_done` requires closing it out (its verdict is
recorded on exit, or `judge_close({role})`).

### 项目经理（orchestrator）模式 —— 编排层，2026-08-29 新增

一轮上下文做不完的大需求，交给一个**只负责统筹**的会话：
`set_gate_mode("orchestrator")`（需要 tmux；子会话就是用户那个 window 里的
pane）。它是 `loop` **加上**编排约束，所以严格度排在 loop 之上：进入不需要确认，
离开要用户确认。

设计铁律只有一句（用户原话）：**能提供工具的，就不要让会话自己组装。** 项目经理
只表达意图，门禁负责实现 —— 它不手写 tmux 命令、不写等待脚本、不自己拼通知。
工具集（10 个）：`orchestrator_plan` / `_spawn` / `_wait` / `_answer` /
`_instruct` / `_close` / `_recover` / `_attach` / `_handoff` / `_notify`
（判定逻辑在 `lib/orchestrator-*.ts`，`extensions/review-gate.ts` 只接线）。

**2026-08-30 通道重构：tmux 退回显示器。** 前三轮端到端验证的 40+ 条缺陷里约
三分之二源于同一个根因 —— 拿 tmux 屏幕当 API。已全部换成 pi 官方结构化通道：

- **点对点通道**（`lib/orchestrator-channel.ts`）：每个子会话一条专属文件
  `<orch-id>/<child-id>.jsonl`，物理隔离，因此没有收件人过滤这回事。通道是
  **文件路径、不属于任何进程** —— 项目经理换人时打开同一批路径即可，子会话
  完全无感。旧的全局广播队列已删除。
- **状态取真值**：子会话侧门禁用 `ctx.isIdle()` / `ctx.getContextUsage()` 上报
  working / waiting-input / **waiting-judge** / idle / done；`dead` 由 pane 消失
  判定，`stalled` 由心跳超时判定。`working` 还带一个**进展维度**（第五轮 E）：
  健康快照给出「自上次推进（工具调用 / turn 边界，不含心跳）以来的时长」，让长时间
  无进展的 `working` 与卡死可被区分 —— 它只是回执里的一个**读数**，不改变
  `isNewsworthy`、不叫醒项目经理。`screenLooksBusy`、屏幕解析与按键模拟全部删除，
  tmux 在编排层只剩三件事：**判 pane 存活**、**开关 pane**、**给 pane 上色与标题**
  （纯展示，`select-pane -P/-T` + window 级 `setw pane-border-*`，一律不带 `-g`）。
- **心跳是独立定时器，不是 agent 事件**（2026-08-30，第四轮 P0）：`judge_wait`、
  full precommit、任何长命令都发生在**同一个 turn 内部**，agent 既不 settle 也不
  结束 turn，挂在 `agent_settled` / `turn_end` 上的心跳因此必然超时 —— 一个正在等
  自己 reviewer 的健康子会话被报成「失联」，而回执建议的 `interrupt` / `close`
  照做就会把那一轮审查腰斩（唯一一条「照门禁说的做反而出事」的缺陷）。现在心跳由
  子会话侧扩展的定时器发（10s），只要进程活着就发；已知的长阻塞如实上报成
  `waiting-judge`（附已等秒数、在等谁），它**不叫醒项目经理**，`stalled` 也因此
  回到只表示「扩展不在了」，其建议动作里**不再出现 `interrupt`**。

- **提问任意一方先答即生效**：子会话侧用 `AbortController` + `Promise.race`
  把「人在框里答」与「项目经理经通道答」并列，谁先答谁生效，另一边的框自动
  撤下。框始终弹着 —— 这就是项目经理死亡时的天然回退，因此**没有任何超时机制**。
  2026-08-31 起 `request_scope_limit` / `request_sensitive_edit` 的 consent 框也走
  同一通道：项目经理可代答（先答先生效），工具描述与本文已同步这个信任模型。
- **投递走 `pi.sendUserMessage`**：`orchestrator_instruct({mode})` 把文本写进
  通道，子会话自己的门禁用 pi 的 API 注入。`mode` 即优先级：`interrupt`（最高，
  2026-08-31 起可带正文 —— 中断当前 turn 并立即投递，一次调用表达「停下、做
  这个」；旧版是空 abort，还要第二次 followUp 才说得了话）、`steer`（当前轮切
  入）、`followUp`（等本轮跑完）。`send-keys` 投递路径已删除。
- **`orchestrator_wait` 是项目经理的唯一信息入口**：它必然被调，所以凡是项目
  经理需要知道的都从回执里**推给它** —— 五块：健康快照、待答请求（结构化，
  含全部选项与正文）、死亡/僵死与可执行恢复动作、它自己的上下文用量与带时机
  判断的接力提醒、以及还差什么才能 `declare_done`。`timeoutMs: 0` 即快照
  （原 `orchestrator_status` 已并入）。让 agent「记得去查」本身就是设计缺陷。



对**其他会话**来说，只有三件事需要知道：

1. **plan 是编排层的 loop goal，而且和它一样要先过审计**：
   `.pi/orchestrator-plan.json` 自己写不算数，批准绑定在内容 hash 上（与 loop goal
   同一机制）；`orchestrator_plan({action:"submit"})` 内部先派 `goal-auditor` 用
   plan 专用模板审一轮（只 P0/P1 阻塞，裁决绑定 canonical plan 文本），**审计不过
   直接退 findings、一个框都不弹**，过了才请用户批准。反过来，**不扩权的改动不再
   重新惊动用户**：边界收窄、同目录内且不与他人相交的文件细化、加依赖、降并行度
   都让批准平移到新内容并记一条审计条目；新增任务、新目录、删依赖、串行改并行、
   提高并行度、任务改到另一个 repo（新写面）一律重批（`lib/orchestrator-plan-approval.ts`）。这个 plan 审计者是
   门禁的**内部实现**：项目经理从没派过它、也在任何 `orchestrator_wait` 回执里见不到
   它，所以裁决记完门禁**自己把它收掉**（谁派谁负责，第五轮 O-6）——`declare_done`
   不再被一个它从未被告知的 judge child 拦住。`propose_loop_goal` 内部的 goal 审计者
   同理，也是门禁自收。

2. **子会话就是普通 loop 会话**：由 `orchestrator_spawn` 启动，带 `loop` 模式，
   只被多注入一句「有项目经理在管这轮任务」。plan、调度细节一律不注入 —— 知道
   plan 会让它为 plan 而不是为自己的任务做优化。它在**任务声明的 repo** 里工作
   （plan 任务可带 `repo` 字段；不声明就用主 repo），同一 repo 的任务由门禁
   串行调度，只有不同 repo 的任务可以并行。
3. **寻址用 orchestration id**（`RG_ORCHESTRATION_ID`），不是 session id：接力
   换人后子会话无感，通知不失联（这正是手工编排那一晚 0 条送达的根因）。

系统通知（OSC 777/9/99）**只有项目经理能发**，且带节流 —— 单一入口 + 只推给
用户本人，与 `lib/attention.ts` 禁止的「任何会话都能广播」是相反的形态。

### 架构规范：新建文件 600 行硬拦，存量只提醒

`judge_submit` 内部的 checkpoint 步骤会拦下**本次新增**且超过
600 行的源文件（`lib/file-size-gate.ts`）。判定发生在提交 checkpoint 那一刻，
而不是编辑当下（那时文件还写了一半，硬拦只会逼人盲目重构），且只判源码扩展名
——Markdown、JSON、锁文件与 fixture 不判长度。存量大文件只输出提醒 ——
近 9000 行（截至 2026-08-29）的 `extensions/review-gate.ts` 不是一次写出来的，
是几十次「只加 100 行」累积的；收尾时硬逼着拆只会拆得更烂。

配套的两道人审关卡：`goal-auditor` 在**目标阶段**就否掉会造成架构劣化的方案
（往超大文件里堆新职责、复制门禁已有的规则、把逻辑埋在无法单测的入口里、
根本没说新代码落在哪），`reviewer` 把架构/抽象/模块化/语义化写进**代码改动
审查主清单**，可以直接出 P1。写新功能时先想清楚它落在哪个模块，而不是落在
「我正好打开的那个文件」。

「落在哪个模块」不该靠猜：`docs/module-map.md` 是这份地图 —— 它写清了
`extensions/review-gate.ts` 与 `lib/` 各模块的职责分工（含 L1–L8 每层落在哪、
工具族为什么注册在 `lib/orchestrator-*-tools.ts` 而不是扩展里），以及 `hooks/`
/ `scripts/` / `agents/` / `test/` 的落点约定。动手前先查它，别先打开编辑器；
新增或删除 `lib/` 模块时，同一轮改动里顺手同步它那张速查表。

### Read-only exploration — parallel-safe

Parallel read-only exploration (code reading, analysis) is inherently
safe: readers never write to the worktree, so they cannot invalidate
a binding or race with each other. Spawn several concurrently, overlap
exploration with your own edits, and merge the findings. Only the main
agent writes to the worktree. (Adviser consultations run as judge
child processes — see the review protocol above.)

### Wave daily — removed

The wave workers and module-planning tools were removed on 2026-08-26. When
a task outgrows a session, slice it into sequential rounds of the same
single review loop — there is no module table and no wave scheduling left
to consult.
