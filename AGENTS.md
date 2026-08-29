# AGENTS.md

Project-level agent instructions for pi-review-gate.

## Product principles

Personal, local-first project — everything ships **default-on**. A new
feature is integrated directly and enabled by default; it never hides
behind an opt-in flag or a config toggle. If a feature cannot be safe by
default, make it safe by default rather than adding a switch.

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
  `record_review` stay registered as advanced entries for the rare case where
  you need one on its own.
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

Where work lands is the gate's business too: `setup_workspace` settles a
dirty worktree and creates this session's work branch (a commit may only land
on it), and `declare_done` merges that branch back into the base the user
confirmed — a conflict stops it, records the files and hands them to you.

## Git workflow guardrails

Hard rules for every git operation in this repo. On top of these rules, the
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
  `claude-opus-5 → opencode-go/deepseek-v4-flash`, `thinking: max`.
  `goal-auditor` is the dedicated pre-reviewer of the loop GOAL (read-only
  tools) whose verdict the gate records mechanically.
- **Mid tier — coding & execution** (`fixer`): `claude-sonnet-5` primary,
  fallback `claude-opus-5 → opencode-go/deepseek-v4-flash`, `thinking: max`.
- **Cheap tier — reading & scanning** (`recon`): `claude-haiku-4-5`
  primary, fallback `opencode-go/deepseek-v4-flash`, `thinking: low`/off.
  `recon` is the strictly read-only reconnaissance agent (tools:
  read/grep/find/ls) — delegate heavy reading, code search and doc
  exploration to it so expensive models never pay token cost for scanning.

> **Why the chains are short.** pi-subagents requires every fallback in the
> chain to RESOLVE in the active model registry — one unresolvable pin
> (a provider that is not configured) fails the whole agent launch. The
> chains therefore pin only providers the package can rely on (anthropic /
> opencode-go) plus the flash fallback; a user who configures onekey /
> deepseek / oc-sdk-go can extend the chains in `~/.pi/agent/agents/*.md`
> (the postinstall copies them from this repo — edits there are
> overwrite-owned on the next install).

**Model configuration layer (per-agent slots + auto switch, default-on).**
The agent frontmatter stays the single thing pi-subagents reads, but editing
models by hand is a frequent, error-prone chore, so a config layer renders
frontmatter for you — project `.pi/review-gate.json` overrides global
`~/.pi/review-gate.json` (like precommit), then the built-in default:

- `agents.<name>.auto` — `true` (default) keeps the built-in chain. When set
  EXPLICITLY at a layer the renderer writes a *default-chain overlay* (marker
  + the built-in default models) so that layer SHADOWS a lower layer's slot
  render — flipping a slot off always lands the built-in default, never a
  leftover lower-priority render. Unconfigured agents are cleaned up instead
  (any stale generated copy is deleted; the global layer restores the upstream
  default rather than leaving no file);
  `false` uses `slots: [spec, ...]` (`slots[0]` = main model, rest =
  fallbacks). Every slot may carry its own `:thinking` suffix
  (`claude-fable-5:max`, `onekey/gpt-5.6-sol:high`) for per-model thinking.
- **Rendering is layered**: project → `<project>/.pi/agents/*.md`, global →
  `~/.pi/agent/agents/*.md`; `scripts/install-package.mjs` applies only the
  global layer. Writes validate (resolvable spec, supported thinking level,
  opencode-go allowlist) and refuse to land on failure.
- The pi widget (`belowEditor`) always shows the effective
  `adviser`/`reviewer` models (spec, auto state, deciding layer) — a
  read-only surface; the config itself is plain JSON in `review-gate.json`.
- All of this is inert until you configure it: no `agents` section (or all
  `auto: true`) behaves exactly like today.
- Project/global layer diagnostics are surfaced when an `agents` section is
  malformed; invalid model specs never replace the last generated chain.

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
to grep on demand. `prepare_adviser` hands back the adviser's ready-made
brief: transcript pointer + a conclusion artifact the adviser appends to,
plus — from the second consultation of a goal on — the previous conclusion
and the files changed since (no history ⇒ full brief).
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
no tmux); a judge role dispatched
through `subagent` / `workflowScript` / `workflowScriptPath` is HARD-blocked
(the workflow sandbox has no per-child isolation, so the judge would land in
one shared cwd — your live worktree, the exact failure this ends). The
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
工具集：`orchestrator_plan` / `_spawn` / `_send` / `_wait` / `_notify` /
`_relay` / `_close` / `_status`（判定逻辑在 `lib/orchestrator-*.ts`，
`extensions/review-gate.ts` 只接线）。

对**其他会话**来说，只有三件事需要知道：

1. **plan 是编排层的 loop goal**：`.pi/orchestrator-plan.json` 自己写不算数，
   批准绑定在内容 hash 上（与 loop goal 同一机制）。
2. **子会话就是普通 loop 会话**：由 `orchestrator_spawn` 启动，带 `loop` 模式，
   只被多注入一句「有项目经理在管这轮任务」。plan、调度细节一律不注入 —— 知道
   plan 会让它为 plan 而不是为自己的任务做优化。
3. **寻址用 orchestration id**（`RG_ORCHESTRATION_ID`），不是 session id：接力
   换人后子会话无感，通知不失联（这正是手工编排那一晚 0 条送达的根因）。

系统通知（OSC 777/9/99）**只有项目经理能发**，且带节流 —— 单一入口 + 只推给
用户本人，与 `lib/attention.ts` 禁止的「任何会话都能广播」是相反的形态。

### 架构规范：新建文件 600 行硬拦，存量只提醒

`review_checkpoint` / precommit 会拦下**本次新增**且超过 600 行的源文件
（`lib/file-size-gate.ts`）。存量大文件只输出提醒 —— 8659 行的
`extensions/review-gate.ts` 不是一次写出来的，是几十次「只加 100 行」累积的；
收尾时硬逼着拆只会拆得更烂。

配套的两道人审关卡：`goal-auditor` 在**目标阶段**就否掉会造成架构劣化的方案
（往超大文件里堆新职责、复制门禁已有的规则、把逻辑埋在无法单测的入口里、
根本没说新代码落在哪），`reviewer` 把架构/抽象/模块化/语义化写进**代码改动
审查主清单**，可以直接出 P1。写新功能时先想清楚它落在哪个模块，而不是落在
「我正好打开的那个文件」。

### Read-only exploration — parallel-safe

Read-only subagents (recon, code reading, analysis) are inherently
parallel-safe: they never write to the worktree, so they cannot invalidate
a binding or race with each other. Spawn several concurrently, overlap
exploration with your own edits, and merge the findings. Only the main
agent writes to the worktree. (Adviser consultations run as judge
child processes, not subagents — see the review protocol above.)

### Wave daily — removed

The wave workers and module-planning tools were removed on 2026-08-26. When
a task outgrows a session, slice it into sequential rounds of the same
single review loop — there is no module table and no wave scheduling left
to consult.
