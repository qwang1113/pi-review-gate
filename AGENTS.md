# AGENTS.md

Project-level agent instructions for pi-review-gate.

## Product principles

Personal, local-first project — everything ships **default-on**. A new
feature is integrated directly and enabled by default; it never hides
behind an opt-in flag or a config toggle. If a feature cannot be safe by
default, make it safe by default rather than adding a switch.

### Parallel loop (the only execution path, agent-initiated)

The review loop, the decompose module loop, and **wave daily** (ad-hoc parallel
editing) all run through the `@quintinshaw/pi-dynamic-workflows` engine — a
HARD dependency that ships with this extension (installed via the package's
`postinstall` — `scripts/install-package.mjs`, which also copies `agents/*.md`
to `~/.pi/agent/agents/`, registers the companion pi packages
(`pi-subagents` for the spawn-reviewer protocol, `pi-opencode-bridge` for the
opencode-go provider) via `pi install` when missing, and installs the git hooks
when the current dir is a
repo). `/review` auto-shards large diffs
(`run_parallel_shard_review`); `/plan-next` dispatches patch-first wave
workers (`run_wave_workflow`). The agent decides when a task is large enough
to propose `/decompose` (evidence + estimate → user consent → module-table
approval) — there is no serial protocol and no fallback: a missing engine is
an installation error, never a slow lane. Design record:
`docs/parallel-execution-plan.md` §8; runtime contract: `lib/pdw-bridge.ts`.

### Model tiers — capability × cost × cross-family diversity

Every sub-agent role is pinned to a real, available model id (see
`~/.pi/agent/models.json` / `models-store.json`) in one of three tiers; the
frontmatter in `agents/*.md` is the single source of truth and
`lib/model-ranking.ts` ranks the families:

- **Strong tier — judging** (`reviewer`, `adviser`, `module-reviewer`,
  `arbiter`): `claude-fable-5` primary, fallback chain `claude-opus-5 →
  opencode-go/deepseek-v4-flash`, `thinking: max`.
- **Mid tier — coding & orchestration** (`worker`, `planner`, `fixer`):
  `claude-sonnet-5` primary, fallback `claude-opus-5 →
  opencode-go/deepseek-v4-flash`, `thinking: max`.
- **Cheap tier — reading & scanning** (`triage`, `recon`): `claude-haiku-4-5`
  primary, fallback `opencode-go/deepseek-v4-flash`, `thinking: low`/off. `recon` is the
  strictly read-only recon agent (tools: read/grep/find/ls) — delegate heavy
  reading, code search and doc exploration to it so expensive models never pay
  token cost for scanning.

> **Why the chains are short.** pi-subagents requires every fallback in the
> chain to RESOLVE in the active model registry — one unresolvable pin
> (a provider that is not configured) fails the whole agent launch. The
> chains therefore pin only providers the package can rely on (anthropic /
> opencode-go) plus the flash fallback; a user who configures onekey /
> deepseek / oc-sdk-go can extend the chains in `~/.pi/agent/agents/*.md`
> (the postinstall copies them from this repo — edits there are
> overwrite-owned on the next install).

**Cross-review protocol (user policy):** (a) BEFORE calling
`propose_loop_goal`, run the draft goal through ONE cross-family reviewer;
fix BLOCKED objections before submitting. (b) The review that ends a round
runs **two reviewers from different model families by default** —
`claude-fable-5` (anthropic) + the best available different-family model
(e.g. `onekey/gpt-5.6-sol` once onekey is configured; without it, a single
reviewer is the accepted fallback and is declared in a Note), both `max`
thinking, falling down the pinned chains if unavailable — record BOTH
outputs via `record_review` (worst wins; fail-closed semantics
unchanged). A single reviewer is acceptable only when no different-family
model is available, and that must be stated in a Note.
(c) **Never two reviewers of the same family.** The count is computed by the
gate from this host's real model registry (`planFanoutFromFacts`,
`lib/review-fanout.ts`) and injected into both the `/review` prompt and the
auto-continuation resume text: two judge-eligible families ⇒ two reviewers,
one per family; one family ⇒ ONE reviewer plus the plan's note copied into the
recorded review. Two same-family reviewers cost double for zero extra signal.
This governs the reviewers YOU spawn (small-diff pair, integration reviewer);
Phase A shard counts come from the engine's sharding. (d) **Every re-review
carries the previous round's conclusion**: the adviser's goal re-review gets
the old draft + its own objections + what changed; round N+1 gets the previous
verdict and findings (the gate injects them as the `Review scope for this
round` block). Settled-and-unchanged material gets a consistency scan, not a
re-derivation — it never narrows what a reviewer may look at, and a settled
conclusion may always be reopened with evidence.

### Wave daily — parallel editing for everyday tasks (not just decompose)

Wave workers are **not decompose-exclusive**. The agent may dispatch a wave for
ANY task that can be split into 2–4 independent sub-tasks with disjoint file
ownership. The patch-first protocol is the same:

1. **Define modules ad-hoc** — each with an id, title, `owned_paths` (disjoint),
   and a task description. No formal plan state needed.
2. **Dispatch the wave** — call `run_wave_workflow` with the module list.
   Workers run in parallel (read-only, edit/write excluded), each producing
   unified git diffs.
3. **Validate and apply** — `validatePatchOwnership` + `git apply --check`,
   then `git apply`. Failed patches are sent back for one retry.
4. **The worktree still has exactly one writer: the main agent.**

Read-only exploration (recon, code reading, `adviser`) is inherently
parallel-safe: spawn multiple read-only subagents concurrently, and overlap
exploration with editing. Only the main agent writes to the worktree.

Both loops are AGENT-DRIVEN: you start the review loop yourself once edits
are complete (auto-sharded via the engine) and you propose `/decompose`
yourself when a task outgrows one session — the slash commands are only
optional explicit triggers, never the expected entry. The user approves at
two points only: decompose initiation and the module table.

## Git workflow guardrails

Hard rules for every git operation in this repo. On top of these rules, the
pi-review-gate extension hard-blocks ship commands (`git commit`, `git push`,
`gh pr create/edit`) until the quality gates pass.

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
