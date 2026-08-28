# AGENTS.md

Project-level agent instructions for pi-review-gate.

## Product principles

Personal, local-first project — everything ships **default-on**. A new
feature is integrated directly and enabled by default; it never hides
behind an opt-in flag or a config toggle. If a feature cannot be safe by
default, make it safe by default rather than adding a switch.

### Single-review loop (the only execution path, agent-initiated)

**Judge roles run as tmux children** — the review is the only parallel
loop, and each round runs in its OWN pi process: a tmux pane of the main
session's right column, spawned by the extension itself (`review_spawn`).
The judge child loads NO review-gate extension and runs with
`--exclude-tools edit,write`; it stays alive across rounds, so its context
is reused until a READY lands. Each review round is ONE reviewer over the
WHOLE change:

- **Review → tmux judge child** (`review_checkpoint` → `prepare_review` →
  `review_spawn` → `review_send` → `review_watch` → `record_review`). You
  commit the change as a checkpoint FIRST (`review_checkpoint` — the only
  commit allowed before a READY; it requires a full precommit PASS). The
  full precommit ALREADY ran typecheck + build + the complete suite on that
  exact content — **never manually re-run the full suite or `tsc`** before a
  checkpoint (the runner caches by input: unchanged content reuses the
  recorded PASS in seconds). Develop with targeted tests only; let
  `run_precommit` be the single full gate. The
  reviewer judges the IMMUTABLE commit range `baseline..HEAD` — the range
  starts at the last REVIEWED commit, so a chain of checkpoints since the
  last READY is all covered (round-9 P1); there is no second reviewer of
  any kind. `record_review` verifies HEAD is still the reviewed commit (a
  new checkpoint after prepare ⇒ STALE ⇒ BLOCKED) and binds a READY to the
  reviewed commit's TREE (content binding — squash preserves it); the ship
  gates additionally refuse content-changing commits after the reviewed one
  (unreviewed content can never ship).
- **No decompose, no module loop, no wave daily.** The module-planning
  machinery and its wave tools were removed 2026-08-26. Large tasks are
  still sliced by YOU into sequential rounds of the same single review
  loop; there is no module table, no plan state, no planner.

Detail: `docs/execution-model.md` + `docs/judge-protocol.md`; runtime
contract: `lib/tmux-session.ts` + `lib/judge-prompt.ts`.

The review loop is AGENT-DRIVEN: you start it yourself once edits
are complete (one `prepare_review` → one spawn → one `record_review`) — the
slash commands are only optional explicit triggers, never the expected
entry. The user approves at one point only: the loop goal.

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
approve it, and this is no longer a protocol the agent could skip:
`record_goal_prereview` records the auditor's JSON fence (PASS ⇔ a `READY`
verdict), bound to the sha256 of the audited text, and `propose_loop_goal`
refuses — without rendering any dialog — unless that PASS matches the
submitted text exactly. A FAIL means: fix the objections and re-audit; the
revised text needs its own PASS (the record binds to content). The goal text
must be written in **Simplified Chinese** (identifiers, paths and code tokens
stay English) — the auditor blocks a draft that is not.
(b) **Every re-review carries the previous round's conclusion — MECHANICALLY**:
the goal-auditor's re-audit gets the old draft + its own objections + what
changed (`record_goal_prereview` persists every audit's verdict, findings
verbatim and the judged draft; `prepare_goal_audit` — called BEFORE
dispatching the auditor — returns the ready-made task text carrying the
previous verdict + findings + previous draft and the mechanically computed
draft delta); round N+1 gets the
previous verdict and findings (the gate injects them as the 'Review scope
for this round' block, now embedded in `prepare_review`'s ready-made task
text). Settled-and-unchanged material gets a consistency scan, not a
re-derivation — it never narrows what a reviewer may look at, and a settled
conclusion may always be reopened with evidence. This is the INCREMENTAL
review contract: first round full, later rounds focused on the increment.
(b2) **Fresh context, read on demand — MECHANICALLY.** The three review
roles (reviewer, adviser, goal-auditor) run `context:"fresh"` — they never
fork the main session's whole conversation. Their task text carries the
transcript location (`~/.pi/agent/sessions/<encoded-cwd>/<sessionId>.jsonl`)
to grep on demand. `prepare_adviser` hands back the adviser's ready-made
brief: transcript pointer + a conclusion artifact the adviser appends to,
plus — from the second consultation of a goal on — the previous conclusion
and the files changed since (no history ⇒ full brief).
(c) **The reviewer judges a COMMIT RANGE, and findings stream.** Call
`prepare_review` AFTER the checkpoint — it computes `baseline..HEAD` (the
immutable commits under review) and a finding-stream file. Inside its own
copy a reviewer SHOULD verify by doing — mutation analysis included — and
must restore before finishing. Because the reviewed range is immutable,
**you keep fixing the real worktree while it runs**: take streamed P0/P1/P2
that carry evidence (confirm each in the code first), leave Nits for the
verdict. WAITING-WINDOW DISCIPLINE (v3): (1) 有可实现的确定性工作(代码/测试/
文档/其他 repo 事务)→ 优先做掉,不要进入等待;(2) 确认没有可做的工作后
才阻塞等待——bash 里 `tmux wait-for <doneChannel>`(turn 不结束;macOS 无
timeout 时用轮询变体 `while ! tmux wait-for -t 5 <chan>; do :; done`);
(3) 兜底:必须结束 turn 时,registerWatch 唤醒与 RESUME 都会拉起你——那
不算错误,但空转应避免。
The verdict arrives through the done channel and wakes this
session (`review_watch`); the reviewer may ask questions through its inbox.
(d) **The judge child runs as a tmux pane — MECHANICALLY ENFORCED.**
`review_spawn` creates a fresh pi process in a pane of the main session's
tmux (right column, stacked below the first judge); a judge role dispatched
through `subagent` / `workflowScript` / `workflowScriptPath` is HARD-blocked
(the workflow sandbox has no per-child isolation, so the judge would land in
one shared cwd — your live worktree, the exact failure this ends). The
single reviewer is one `review_spawn` call per round. `record_review`
withholds a READY unless the round was PREPARED (a registered
`baseline..HEAD` target) and the verdict carries the pane's `cwd` (measured
with `pwd`, a required field of the verdict schema). While a judge child is
open, `declare_done` requires closing it out (`record_review` /
`review_close`). No tmux available ⇒ fail-closed (no judge can run).

### Read-only exploration — parallel-safe

Read-only subagents (recon, code reading, analysis) are inherently
parallel-safe: they never write to the worktree, so they cannot invalidate
a binding or race with each other. Spawn several concurrently, overlap
exploration with your own edits, and merge the findings. Only the main
agent writes to the worktree. (Adviser consultations run as tmux judge
children, not subagents — see the review protocol above.)

### Wave daily — removed

The wave workers and module-planning tools were removed on 2026-08-26. When
a task outgrows a session, slice it into sequential rounds of the same
single review loop — there is no module table and no wave scheduling left
to consult.
