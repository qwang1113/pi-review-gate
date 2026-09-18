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

**Judge roles run in their own panes** — the review is the only parallel
loop, and each review runs in its OWN tmux pane (interactive pi with a
deterministic `--session-id`), opened by whoever owns it (hierarchy:
project manager → child session → review; plan review opened by the project
manager itself). The judge pane loads the review-gate extension in judge mode
(a reporting shell: heartbeat, dialog race, verdict report — never an
enforcer). It runs with
`--exclude-tools edit,write`; its session id is DETERMINISTIC per role+repo,
so re-opening with the same `--session-id` continues the same session — its
context is reused across rounds until a READY lands. Each review round is ONE
reviewer over the WHOLE change:

- **The quality round runs BESIDE the functional one (2026-09-16).** One
  `judge_submit` starts all three over the same `baseline..HEAD` at the same
  moment: `quality-auditor` (the CODE ITSELF — philosophy, architecture,
  correctness, security, performance, then simplicity, readability,
  maintainability — against `docs/code-quality-rules.md`, a language-neutral
  checklist whose cross-repository clauses make the WHOLE repo its reference),
  the functional `reviewer`, and the full precommit lane. Who concludes what
  stops whom is the cancel matrix, whose ONE substantive home is
  `docs/execution-model.md` §「并行三方与取消矩阵」 — a non-READY quality round
  kills the reviewer's pane and the lane, a non-READY reviewer kills the quality
  pane and the lane, a FAILED lane kills the reviewer and leaves the quality
  round running (it reads code, not test results). A reviewer that concludes
  READY before the quality round does is HELD (parked) and recorded the moment
  the quality round passes — never recorded early, never re-reviewed.
  P0/P1 BLOCKS; P2 is recorded only. A finding whose fix needs PRE-EXISTING
  code changed is a question for the USER — the judge puts it through
  `ask_user` (fold it in / only this round's own lines / out of scope) and
  never widens the round itself. The agent never calls `judge_submit` twice for
  one round, and `quality-auditor` is NOT a role it can name. Two rounds skip
  the quality judge legitimately, and the skip is RECORDED and self-reported: a
  round with no code at all (docs/data only, or the empty exit-goal round), and
  a re-submission whose HEAD already carries a quality READY.

- **Review → ONE call**: `judge_submit({role:"reviewer", task:<what you
  changed this round>})`. The gate runs the whole chain itself — full
  precommit, the checkpoint commit, the
  `baseline..HEAD` computation, the dispatch — and any step that fails sends
  the round back with the reason instead of leaving it half-submitted. The
  full precommit is the exception, because it is started to run BESIDE the
  chain instead of in front of it: when it fails it arrives as its own
  `steer` message, never `followUp` — that queue is drained only when you
  stop, and the loop invariant above forbids stopping, so a follow-up here
  lands hours late and reads as a verdict on a round that is long over
  (`lib/async-precommit-report.ts`). The message names its round and the
  content it verified; a lane whose content has already been replaced reports
  itself as that OLD round, not as the current one. The
  full precommit ALREADY ran typecheck + build + the complete suite on that
  exact content — **never manually re-run the full suite or `tsc`** before
  submitting (the runner caches by input: unchanged content reuses the
  recorded PASS in seconds). Develop with targeted tests only.
  The reviewer judges the IMMUTABLE commit range `baseline..HEAD` — the range
  starts at the last commit a round **concluded** about (READY or BLOCKED),
  and at the BRANCH BASE when no round ever has — a round without a conclusion
  must never let the baseline step past its content (round-9 P1, round-10 P1);
  there is no second reviewer of
  kind. When the round's channel report lands, the opener records the verdict
  itself (the gate's settle path records it and wakes you with the standard report; audit chains do the same) — you never carry
  a verdict from one tool to another. The recording keeps every mechanical
  check: HEAD must still be the reviewed commit (a new checkpoint after
  prepare ⇒ STALE ⇒ BLOCKED), and a READY binds to the reviewed commit's TREE
  (content binding — squash preserves it); the ship gates additionally refuse
  content-changing commits after the reviewed one (unreviewed content can
  never ship). `run_precommit` / `review_checkpoint` / `prepare_review`
  are **not tools** (2026-08-30, 哲学三): the gate still runs
  every one of those steps inside `judge_submit`, but none of them is
  registered, so there is no second path to sequence by hand. The two
  RECORDERS went further (2026-09-04, 用户决定 D4): `record_review` and
  `record_goal_prereview` are no longer registered on any host at all, not even
  the internal one, and what remains are plain gate-side functions invoked when
  a round's channel report lands. Their tool shape existed only to carry text
  that had to be parsed back into a verdict; the conclusion arrives structured
  now, so there was nothing left for a caller to pass.
  `review_diff` / `review_sandbox` were **evaluated and formally NOT built**
  (2026-08-31, 哲学三): the reviewer's own `git
  diff` / `git show` are simple read-only commands (not the multi-step ship/tmux
  flows 哲学一 targets), and its sandbox verification is an inherently
  reviewer-owned judgement call, not a mechanical sequence the gate can own
  without becoming the reviewer. The reviewer's throwaway worktrees are the
  gate's to CLEAN, though, not to build: `judge_submit` points the judge's
  `$TMPDIR` at a per-session dir and reclaims any worktree under it when the pane
  is closed or cascade-closed (谁创建谁回收).

- **No decompose, no module loop, no wave daily.** The module-planning
  machinery and its wave tools were removed 2026-08-26. Large tasks are
  still sliced by YOU into sequential rounds of the same single review
  loop; there is no module table, no plan state, no planner.

Detail: `docs/execution-model.md` + `docs/judge-protocol.md` +
`docs/hierarchical-session-design.md`; runtime
contract: `lib/judge-pane.ts` + `lib/hierarchy.ts` + `lib/judge-prompt.ts`.

The review loop is AGENT-DRIVEN: you start it yourself once edits
are complete (one `judge_submit`) — the slash commands are only optional
explicit triggers, never the expected entry. The user is asked at three points
only: `ask_user` (the ONE way to reach them — it runs the interview, which is
optional and uncapped, and pauses the loop), the RESTATEMENT confirmation and
the loop-goal approval dialog.

**提问只有一种形状（2026-09-08，用户决定）.** 门禁向用户提问的每一个对话框
都是同一个模板：**2–4 个选项 + 一个「（推荐）」标记 + 一行「✎ 不选，我说明
原因」**；选中追加行会弹出**多行编辑器**（2026-09-17 起用 pi 自己的编辑器组件：
可换行、可粘贴、`ctrl+g` 进 `$EDITOR`），输入的原因随答案回传（人类侧、通道侧同一
条规则）。`ask_user`、门禁自己每一处是/否框（goal 批准、plan 批准、plan 归档、
需求反述确认、`request_sensitive_edit`、`request_scope_limit`、`set_gate_mode`
降级确认、`/gate-bypass`、`/gate-grant`）与两处手写 `ui.select` 全部走它，
`ui.confirm` 在门禁里已无调用点。agent 提交的问题缺选项（<2）或缺推荐 ⇒
**整批被拒、一个框都不弹**；选项超 4 个只截断并告知。规则唯一出处：
`lib/choice-dialog.ts`。

**需求反述与交付站点（2026-09-06，机械前置）.** 谈契约之前先把需求反述给用户
确认：`propose_restatement({restatement, station})`。没有一份用户确认过的反述，
`propose_loop_goal` 与 `orchestrator_plan({action:"submit"})` **直接被拒且不弹
任何对话框**。同一次确认里定下**本轮交付站点** —— `precommit`（门禁跑通，用户
自己 commit）/ `commit`（提交完成，用户自己 push）/ `pr`（做到 PR 开出来）——
它随 goal 的批准落进 sidecar，之后由 L1 ship 门禁按站点放行、由 `declare_done`
判「到站」。规则细节只有两处权威出处，本文不复述：`lib/restatement.ts`（什么算
反述、缺了怎么拒）与 `lib/delivery-station.ts`（站点解析、缺省、放行表、到站
判定）。

**协商被用户插话时的口径（2026-09-14，用户决定）.** 「打断」是语义上的插话，不是按
ESC：用户在反述 / 协商 goal / 协商 plan 的框里**没有作答**，而是在框外提了别的问题或
补充。这时先把他说的处理掉，再用 `ask_user` 问一句「还有别的要补充或要问的吗？没有
了我就继续」，得到「没有了」才继续协商 —— 写进提示词（`lib/agent-directives.ts` 的
`REQUIREMENT_PROTOCOL` + `lib/orchestrator-directives.ts`），**不做机械硬拦**；三处工具
在「用户没有作答」时返回的文案同样指向这一步，不再读成「用户否决」。同轮：三份协商
正文在对话区**不截断**（正文永不进对话框），对话框高度按真实终端行数受控 —— 细节见
`docs/execution-model.md` 的「通信」节。


Where work lands is yours again (2026-09-07, user decision): the workspace
settlement layer (`setup_workspace`, the mandatory work branch, declare_done's
squash-merge) is gone. You work directly on the branch you are on. Two
mechanical facts replace the old enforcement, and they are DIFFERENT from
each other:

- **The gate's own checkpoint** (`judge_submit` commits it) lands on the
  current branch, whatever it is — EXCEPT on a PROTECTED branch
  (main/master/dev/develop), where it is REFUSED outright, no dialog
  (2026-09-16, user decision: "无论如何都不能在保护分支上面做 commit，
  checkpoint 也不行"). Checkpointing requires a feature branch.
- **Your own `git commit`** on a protected branch is REFUSED by the ship
  gate (a shell command cannot show a dialog, so it fails closed).

`declare_done` closes the gates and leaves the work where it is;
merging/rebasing/pushing is your git workflow, guided by the guardrails
below — which still prefer a feature branch over working on main.

## Git workflow guardrails

These guardrails are the WORKFLOW this repo prefers — a feature branch is
the normal place for a change. They are not the gate's enforcement: the gate
only refuses your own `git commit` on a protected branch — and now its own
checkpoint refuses them too, without asking (2026-09-16). On top of these
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

- **Strong tier — judging** (`reviewer`, `quality-auditor`, `adviser`,
  `arbiter`, `goal-auditor`): `claude-fable-5` primary, fallback chain
  `claude-opus-5`, `thinking: max`.
  `goal-auditor` is the dedicated pre-reviewer of the loop GOAL (read-only
  tools) whose verdict the gate records mechanically; `quality-auditor` is the
  pre-reviewer of the CODE, running in the SAME round as the functional reviewer
  (2026-09-16; one `judge_submit` starts both, and the cancel matrix decides who
  stops whom — `docs/execution-model.md` §「并行三方与取消矩阵」).
  The L1/L2 execution tiers (`recon` / `fixer`) were retired — the gate
  ships the five judging roles only.

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
default 5-role `agents` section to `~/.pi/review-gate.json` when the file is
absent, and merges in ONLY the roles missing from an existing file (never
overwrites a user's own pins). At session start the gate HARD-CHECKS every
role (reviewer/quality-auditor/adviser/arbiter/goal-auditor): a missing entry, an
empty slot list, or an unresolvable spec STOPS the session with the reason
(`validateAgentsForStartup`). The launch resolver returns an EMPTY chain for an
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
- The pi widget (`belowEditor`) is a SINGLE-LINE status strip (mode/branch/
  edited, plus `轮 N` — the rounds THIS session sent out, shown only in a loop
  session or a judge pane — and the unmet count); the full readout — verdicts,
  config, model chains — lives in the `/gate-status` command. The config
  itself is plain JSON in `review-gate.json`.
- A missing/corrupt `agents` section is a startup error, not a silent
  pass-through: the session stops and names every role that lacks a
  resolvable chain (`validateAgentsForStartup` + the before_agent_start
  hard check). Project/global layer diagnostics are surfaced when an
  `agents` section is malformed; invalid model specs never replace the last
  generated chain.

**Review protocol (single-review).** The review that ends
a round is ONE reviewer — by design. There is no second reviewer, no split
plan. The fallback chain in a judge role's slots IS a runtime selector since
2026-09-10, and it changes nothing about the one-reviewer rule: the dispatch
launches the first slot that is not cooling down (`lib/model-health.ts`, 10
minute TTL, persisted in `.pi/judge-hierarchy.json`), and a pane whose own
provider fails for a whole run switches to the next slot itself, says so in
the channel, and carries on — an exhausted chain ENDS the round as a failure
(`judge_wait` reason `model-exhausted`) instead of hanging. A single reviewer
is the norm, and no Note is required about it.
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
block in the reviewer's task text). That block IS the incremental review
contract — first round full, later rounds focused on the increment — and its
terms are NOT restated here or anywhere else: `lib/review-carryover.ts` is
their single authoritative source, and every other surface (this file, the
skill, the `/review` prompt, the reviewer role body, the judge protocol) may
carry a summary and a pointer only. Two consequences worth knowing without
reading it: the contract never narrows what a reviewer may look at, and a
settled conclusion may always be reopened with evidence.
(b2) **Fresh context, read on demand — MECHANICALLY.** The four review
roles (reviewer, quality-auditor, adviser, goal-auditor) each run in their OWN pane (interactive
pi with `--session-id`) — they never
transcript location (`~/.pi/agent/sessions/<encoded-cwd>/<sessionId>.jsonl`)
to grep on demand. `judge_submit({role:"adviser"})` builds that brief itself:
transcript pointer + a conclusion artifact the adviser appends to, plus —
from the second consultation of a goal on — the previous conclusion and the
files changed since (no history ⇒ full brief).

(c) **The reviewer judges a COMMIT RANGE, and findings stream.** The chain
inside `judge_submit` computes `baseline..HEAD` (the
immutable commits under review) and a finding-stream file. The reviewer READS
the range and runs nothing by default; a concrete doubt buys the MINIMAL
verification, done in its own throwaway copy and restored before finishing
(`docs/judge-protocol.md` 「验证纪律」 is the only substantive home of that rule;
every surface here only points at it). Because the reviewed range is immutable,
**you keep fixing the real worktree while it runs**: take streamed P0/P1/P2
that carry evidence (confirm each in the code first), leave Nits for the
verdict. WAITING-WINDOW DISCIPLINE（2026-09-05 起的口径，`lib/agent-directives.ts`
的 `buildWaitDiscipline` 是唯一出处）：
(1) 有确定性工作(代码/测试/文档/其他 repo 事务)→ 先做掉，尤其 goal / plan
审计期间：读代码、调查、补上下文；送 reviewer 前应已准备充分，送完往往没事可做——
这时可以看看下一轮要什么、或先准备收尾报告（**提示，不强求**）;
(2) 确实没活可做了，才调 `judge_wait({role})` 等——不是手写 sleep 轮询，也不是
结束 turn（主会话是门禁的最后监督者，门禁未通过前不得停止自动循环，存活不变量）;
(3) `judge_wait` 是**消息驱动**的：新 finding、judge 提问、本轮结论、pane 消失，
以及 `settled`（本轮已交卷、已记录且已消费而 pane 空闲 —— 立即回一个「没有可等的
了」而不是阻塞到超时；2026-09-16），
任一到达即返回，拿到就继续干——它不是「等它跑完」的轮询。没在等的时候，
settle 唤醒仍是兜底：新消息落盘时门禁会用同一份标准报告叫你
（结论、证据位置、记录情况、待答问题）。

The round ends when its channel report lands: the opener records the verdict
from the report's exact bytes (the gate's settle path records it and wakes you with the standard report). The reviewer may ask
questions through the channel (human in the pane and opener race, first answer
wins) — answer with judge_answer, or resubmit the same role
(`judge_submit` resumes the session, context intact).
(d) **The judge child runs in its own pane — MECHANICALLY ENFORCED.**
`judge_submit` opens the judge in a tmux pane (interactive pi, same deterministic
session id, no second dispatch surface). The `subagent` dispatch surface was retired
pi-subagents companion — a judge role can only be dispatched through
`judge_submit`, so there is no second path to sequence by hand (the
workflow-sandbox block that used to guard `subagent` calls died with it: the
tool the block protected no longer exists). The
single reviewer is one `judge_submit` call per round; you never pass a session
id, a title or a directory — the gate derives all three from role+repo.
**One session per role, continued across rounds**: the session id is
deterministic per role+repo, so the next round re-opens the SAME transcript
(that is how a judge's context carries over until a READY). A living pane takes
every new round through its channel (a pane judge reads each round via its
drain); `fresh: true` kills the pane first. The recording withholds a READY
unless the round was PREPARED (a
registered `baseline..HEAD` target) and the verdict carries the child's `cwd`
(measured with `pwd`, a required field of the verdict schema). While a judge
pane is open, `declare_done` cascade-closes it (a recorded verdict stays
recorded; an unrecorded round is abandoned — abandon explicitly by resubmitting with
`fresh: true`).

### 项目经理（orchestrator）模式 —— 编排层，2026-08-29 新增

一轮上下文做不完的大需求，交给一个**只负责统筹**的会话：
`set_gate_mode("orchestrator")`（需要 tmux；子会话就是用户那个 window 里的
pane）。它是 `loop` **加上**编排约束，所以严格度排在 loop 之上：进入不需要确认，
离开要用户确认。

设计铁律只有一句（用户原话）：**能提供工具的，就不要让会话自己组装。** 项目经理
只表达意图，门禁负责实现 —— 它不手写 tmux 命令、不写等待脚本、不自己拼通知。
工具集（8 个）：`orchestrator_plan` / `_spawn` / `_wait` / `_answer` /
`_instruct` / `_close` / `_recover` / `_attach`
（判定逻辑在 `lib/orchestrator-*.ts`，`extensions/review-gate.ts` 只接线）。
交接**不是**编排专属的第十个工具：**每一类会话**（loop 主会话、编排子会话、
项目经理、judge）共用同一个 `session_handoff()`（`lib/session-handoff-tools.ts`）
—— 阈值、骨架文档、开 pane 与接手判定都是门禁的，见「单次审查循环」一节。

**2026-08-30 通道重构：tmux 退回显示器。** 前三轮端到端验证的 40+ 条缺陷里约
三分之二源于同一个根因 —— 拿 tmux 屏幕当 API。已全部换成 pi 官方结构化通道：

- **点对点通道**（`lib/orchestrator-channel.ts`）：每个子会话一条专属文件
  `<orch-id>/<child-id>.jsonl`，物理隔离，因此没有收件人过滤这回事。通道是
  **文件路径、不属于任何进程** —— 项目经理换人时打开同一批路径即可，子会话
  完全无感。旧的全局广播队列已删除。
- **状态取真值**：子会话侧门禁用 `ctx.isIdle()` / `ctx.getContextUsage()` 上报
  working / waiting-input / **waiting-judge** / idle / done / mode-changed；`dead` 由 pane
  消失判定，`stalled` 由心跳超时判定（这八个状态的权威清单是
  `lib/orchestrator-child-state.ts` 的 `CHILD_STATES`，本文不再另立一份）。
  `working` 还带一个**进展维度**（第五轮 E）：
  健康快照给出「自上次推进（工具调用 / turn 边界，不含心跳）以来的时长」，让长时间
  无进展的 `working` 与卡死可被区分 —— 它只是回执里的一个**读数**，不改变
  `isNewsworthy`、不叫醒项目经理。`screenLooksBusy`、屏幕解析与按键模拟全部删除，
  tmux 在编排层只剩三件事：**判 pane 存活**、**开关 pane**、**给 pane 上色与标题**
  （纯展示，`select-pane -P/-T` + window 级 `setw pane-border-*`，一律不带 `-g`）。
- **心跳是独立定时器，不是 agent 事件**（2026-08-30，第四轮 P0）：门禁内部等待、
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
  同一通道：项目经理可代答（先答先生效）。**但敏感编辑与 tmux 授权的代答需要用户显式授权**
  （2026-09-16 起 sensitive-edit、2026-09-17 起 tmux-access：`orchestrator_answer` 对这两类
  无授权时弹三选框给用户：「允许并记住 / 仅允许这一次 / 拒绝」，**推荐拒绝** —— tmux 的
  爆炸半径与敏感文件同级：`kill-server` 能带走用户整个 tmux 会话）；`request_sensitive_edit`
  与 `request_tmux_access` 在项目经理自己的会话里被**直接拒绝**（它没有通道侧可答自己的框，
  曾把 PM 卡死 2 小时），改走 `orchestrator_answer`。三个授权入口：ask_user 带 `grantScope`
  的提问、`/gate-grant <scope>` 命令（作用域：`sensitive-edit`、`tmux-access`）、首次代答的三选框。
- **一次 `ask_user` 的多题整批上送、整批回答**（2026-09-06）：子会话在弹出第一个
  框之前，就把本次采访的全部问题一次性写成 N 条 request 记录（新增可选字段
  `batchId` / `batchIndex` / `batchTotal`，只增不改，旧上级照旧当 N 条普通待答
  请求处理），因此它们同在项目经理的**第一份**回执里；`orchestrator_answer` 的
  可选 `answers` 数组一次答完整批，**裁决仍只有一份实现**（单问与批量共用同一
  条校验链，批量不是绕过 crosscheck / 约束 8 的后门），每条独立成败、写进通道的
  不回滚。子会话那边**仍逐个弹框**，先答者生效这条不变；用户关掉对话框（＝停整台
  采访）或采访被 instruct 打断时，没展示的题就地销账（分别记 `dismissed` /
  `interrupted`），
  不会在回执里挂成永远没人答的请求。同理，`judge_answer` 在有多个待答问题时也
  必须指明 `requestId`（judge pane 与子会话走同一条通道）。
- **投递走 `pi.sendUserMessage`**：`orchestrator_instruct({mode})` 把文本写进
  通道，子会话自己的门禁用 pi 的 API 注入。`mode` 即优先级，**缺省是 `interrupt`**
  （2026-09-17 用户决定：上级发话就是要它立刻知道）——中断当前 turn 并带正文立即
  投递，一次调用表达「停下、做这个」。唯一的另一个选项是 `steer`（切进当前这一轮、
  不 abort，给「带着这条继续做」用）。`followUp`（等本轮跑完）**已从参数面取消**，
  传了直接被拒。**judge 次轮派发也不用它**（2026-09-16）：那条排队投递让任务停在
  通道上、而 opener 登记表已经把轮号推到了下一轮，于是旧轮交卷时盖上了新一轮的号
  —— 旧结论落到新轮名下，真正的新轮结论被当「重复调用」丢弃；现在派发即 interrupt，
  轮号随任务一起送过去（`roundSeq` 写在那条 instruct 记录里）。
  `send-keys` 投递路径已删除。
- **派活戳无模式豁免**（2026-09-17）：每一条**写进通道**的 instruct 都更新
  `lastAssignedAt`（不等回执 —— 只 `received` 的消息回执会失败，但子会话稍后照样
  读到，它确实被重新派了活），而「它完成了没有」读的是子会话那段 `done` 状态的**起点**
  （`lastStateSince`）而不是最新一条心跳记录 —— 否则心跳每分钟重报一次 `done`
  就能让上一轮的完成记录永远显得比新派的活还新。
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
   重新惊动用户**：删任务、加依赖、并行改串行、降并行度、收紧交付站点
   都让批准平移到新内容并记一条审计条目；新增任务、删依赖、串行改并行、
   提高并行度、任务改到另一个 repo（新写面）、**某任务自己的交付站点变宽**
   （改任务顺序或删掉一个兄弟任务，都可能让「plan 最后一环不受收窄」那份豁免
   落到别的任务头上，2026-09-18）一律重批（`lib/orchestrator-plan-approval.ts`）。
   任务改哪些**文件**不再是 plan 的一部分（2026-09-17 用户决定）：同一 repo 内的任务
   本来就被门禁串行调度，文件边界防不住任何冲突，只让每次新开一个目录都得重新审计 + 重批。
   这个 plan 审计者是
   门禁的**内部实现**：项目经理从没派过它、也在任何 `orchestrator_wait` 回执里见不到
   它，所以裁决记完门禁**自己把它收掉**（谁派谁负责，第五轮 O-6）——`declare_done`
   不再被一个它从未被告知的 judge child 拦住。`propose_loop_goal` 内部的 goal 审计者
   同理，也是门禁自收。

   提交 plan 之前还要有一份用户确认过的**需求反述**（`propose_restatement`），
   否则 submit 同样直接被拒、不弹框；同一次确认里定下的交付站点就是 plan 的
   `deliveryStation`（提高它属于扩权，要重批）。

1b. **项目经理代批不是橡皮图章**（2026-09-06，用户要求）：代用户批准子会话的
   goal、或代确认它的需求反述，都必须给 `orchestrator_answer` 带上 `crosscheck`
   —— 写出该 plan 任务 id，并对「任务目标 / 交付站点」两项各给一句
   判断；缺任一项即退回，并把 plan 里那个任务与子会话提交的正文**并排**贴回。
   拒绝不需要对照（说不永远是自由的）。子会话请求确认的站点若**宽于**已批准
   plan 的 `deliveryStation`，代答一律被拒 —— 放宽站点只有用户能决定。判定与
   词表在 `lib/orchestrator-answer-tools.ts`（`PROXY_CROSSCHECK_TOKENS`）。


2. **子会话就是普通 loop 会话**：由 `orchestrator_spawn` 启动，带 `loop` 模式，
   只被多注入「有项目经理在管这轮任务」一句 + 任务书末尾门禁追加的
   `TASK_GOAL_DIRECTIVE`（plan 批准 ≠ goal 批准，必须先协商自己的 loop goal，
   2026-09-01）。plan、调度细节一律不注入 —— 知道
   plan 会让它为 plan 而不是为自己的任务做优化。它在**任务声明的 repo** 里工作
   （plan 任务**必须**声明 `repo` 字段——子会话 cwd 就落在那里；2026-09-01 实测
   漏写导致子会话被开在项目经理仓库、goal 绑错、编辑被 L8 拦的死锁，写 plan 时
   强制），同一 repo 的任务由门禁
   **各自开一个隔离 checkout**（`git worktree`，由 `orchestrator_spawn` 在发现
   同 repo 已有在跑的 child 时自动创建；建不出来就**拒绝启动**，不会让两个写者
   共用一个工作区），不同 repo 的任务本来就并行。

   **建出来的 checkout 由门禁自己播种**（`lib/worktree-seed.ts`，2026-09-15，
   onchain 实测）：`git worktree add` 只复制 commit，而 `.pi/review-gate.json`、
   `.env`、`node_modules` 这些被 gitignore 的本地前提一律不在。后果是子会话读到
   一个「不是它父亲规划的那个」仓库：它读不到本仓的 precommit 配置，test 步骤
   退化成包默认的 `yarn test`（midway 全量，143 个文件失败，而它的改动只有 5 个），
   项目经理只得手动指挥它补拷配置。现在：复制 `.pi/` 的配置类文件（`review-gate.json`、
   `settings.json`、`subagents.json`、`agents/`），symlink `.env`、`.env.local`
   与 `node_modules`，**每一条都先要求 `git check-ignore` 确认被忽略**（未被忽略的
   路径带过去会污染 checkout 的 git status，而指纹、precommit 缓存与审查范围都读
   那棵树）；`.pi/` 的运行态文件（state / cache / plan / tasks / judge-sessions）
   一律不带。播种结果进 spawn 回执。**分支指令由门禁按派发上下文写进任务书**
   （`buildBranchLine`，2026-09-18 起；此前是 `TASK_GOAL_DIRECTIVE` 里一句固定的
   「先给自己开一个功能分支」—— 对收尾任务直接是错的，会让交付分支再叉一条）：
   同一 checkout ⇒ 点明它实际在的那条分支、不要新开；门禁自建隔离 checkout ⇒ 点明
   门禁的 `rg-child-…` 分支，站点低于 `pr` 的不许 push / 开 PR，站点到 `pr` 的先
   `git branch -m` 改成给人看的名字再交付（`orchestrator_close` 的 merge / discard
   按 checkout 的**实际分支**结算，所以改名不会让结算失败）；只有保护分支或门禁
   读不到分支时，才给 kebab-case 命名规范（如 `feat/aum-blacklist-purge`）—— 实测
   三个 PR 的 head 分支都是 `rg-child-<sessionId>`，所以那个 handle 永不作为 PR head。

   完工后由 `orchestrator_close({ worktree:"keep"|"merge"|"discard" })` 决定那个
   checkout 的去向（默认 `keep`，因为里面的成果常常是唯一副本）；**`merge` 在合并
   成功后自动回收那个目录**（2026-09-15，用户决定：结算过的子会话会把
   `<repo>-rg-<child>` 越堆越多，而它们对 `git branch` 不可见），只留分支 ——
   分支是 `git merge --abort` 的唯一回退锚且不占磁盘，确认提交后再用 `discard`
   连分支一起收回（对已回收的目录幂等）。孤儿 checkout 在 `orchestrator_attach`
   的回执里列出、**不自行回收**。

2b. **同一个 repo 的一个需求只出一个 PR**（2026-09-15，用户决定）：plan 里同一
   repo 有 ≥2 个任务、且该 repo 没有被写进 `allowMultiplePrs` ⇒ **该 repo 的交付
   站点收窄为 `commit`**（子会话提交完就停，不 push、不开 PR）。**唯一例外是 plan 的
   最后一环 —— 收尾任务**（2026-09-18，用户决定）：它按 plan 的 `deliveryStation`
   交付（汇合其余任务的分支 → 走一次整体审核 → commit → push → 开**一个** PR），
   被一起收窄就没有能 ship 的一方了（PM 被禁止写代码，实测过整轮卡在交付上的事故）。
   收尾任务是**位置约定**（plan 顺序的最后一个），不是 plan 的新字段；它照旧计入该
   repo 的任务数，所以「1 个工作任务 + 收尾任务」里那个工作任务仍然收窄为 `commit`。
   收窄是收紧、不是扩权，按既有规则平移 plan 批准（不额外弹框），但它在 plan
   的批准对话框、plan 摘要、子会话的反述/goal 对话框与任务书里都写明；
   `allowMultiplePrs`（repo 绝对路径列表）是**唯一的放行入口**，把它加进 plan 属于
   扩权、必须重新问用户，而移除只是收紧。站点上界随 spawn 走环境变量
   `RG_STATION_CAP` 注入子会话（那是提示词写不进去的通道），子会话 goal 协商的站点
   展示与记录都不超过它；**`orchestrator_recover` 重开 pane 与 `session_handoff`
   接力都重新注入同一个上界**（一个新进程不该比原进程能做更多）。规则只有一处
   实现：`lib/repo-pr-policy.ts`（`finishTaskId` / `effectiveTaskStation`）。
3. **寻址用 orchestration id**（`RG_ORCHESTRATION_ID`），不是 session id：接力
   换人后子会话无感，通知不失联（这正是手工编排那一晚 0 条送达的根因）。而「交棒」
   本身分**两个阶段**：开新 pane **之前**释放 worktree 占用（否则继任者被自己前任的
   心跳挡在门外），relay 记录落盘**之后**才静默（停两个推进定时器 + 设退休标记；
   先静默会让 relay 记录被 `persist()` 的退休守卫拦住，只存在内存里）。交不成则回滚
   占用，编排始终只有一个持有者；继任者带着**前任的 session id** 接管 worktree 占用，
   所以前任没来得及释放也接得上。权威出处只有一处：`docs/execution-model.md`
   的「接力的不断档保证」。
4. **接力继承的是记录，不是权力**（2026-09-16）：继任者（`lib/session-inheritance.ts`
   的 `isHandoffSuccessorOf` —— 有交接标记**且** sidecar 里记的 sessionId 就是那个前任，
   两者缺一不可）保留用户已经确认过的两份记录：plan 批准五件套，与会话的 `restatement`
   / `loopGoal` / 轮次预算（`rounds` / `turnsWithoutGoal`）。每一条仍绑着它当初绑的
   **内容**（canonical plan / goal 文本 / 反述 text+hash），内容一变既有校验立刻失效；
   `bypass`、scope limit、`taskMode` 一律不继承。`orchestrator_attach` 接管没有交接标记
   ⇒ 任何东西都不继承（2026-09-06 的「批准不随会话转移」只收窄、没被推翻）。规则落在
   `lib/orchestrator-registry.ts` / `lib/gate-state.ts`，扩展里只做接线。

系统通知（macOS 原生，经 `terminal-notifier`）**由门禁自己发**，不由 agent 决定，且只有
三类事件：项目经理/独立 loop 会话**完成**或**异常结束**（你手动结束的不算），以及**停
下来等你回答**（`ask_user` + 门禁自己的每一个对话框，外加每登记一条待你拍板的 plan 决策）。
其余时候一声不响；`orchestrator_notify` 工具已删除（agent 想找你就只能用 `ask_user`）。
点击通知会回到发通知那个 tmux pane。策略与 argv 在 `lib/user-notify.ts`；接线在扩展里
（`declare_done` 被接受、`process.on("exit")` 无 `session_shutdown` 记录、`askChoice`、
以及 plan 的 `add-decision`）—— 详见 `docs/orchestrator-supervision.md`。

### 架构规范：新建文件 600 行硬拦，存量只提醒

`judge_submit` 内部的 checkpoint 步骤会拦下**本次新增**且超过
600 行的源文件（`lib/file-size-gate.ts`）。判定发生在提交 checkpoint 那一刻，
而不是编辑当下（那时文件还写了一半，硬拦只会逼人盲目重构），且只判源码扩展名
——Markdown、JSON、锁文件与 fixture 不判长度。

「本次新增」的判定是 **merge 感知**的（2026-09-15，dashboard 实测的死锁）：基线是
`HEAD` **加上** `.git/MERGE_HEAD` 里的每一个 parent。只问 `HEAD` 就等于把「不在分支
tip 里」当成「是本会话新建的」—— 而 merge 冲突刚解决、merge commit 还没落下的那
一刻，`HEAD` 仍然是分支 tip，于是 `main` 带进来的文件全部被算成本次新建：实测 104 个
staged 新增全部来自 `main`，其中 3 个超过 600 行，checkpoint 被硬拦，而 checkpoint 是
review 循环的唯一入口 —— 一条门禁自己要求的提交被门禁自己拒绝，用户只能切 `normal`
模式绕过。同一处判定还被依赖论证检查（`package.json` 的比较基线）使用，唯一出处：
`lib/change-baseline.ts`。

存量大文件只输出提醒 ——
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
