# AGENTS.md

Project-level agent instructions for pi-review-gate.

## Product principles

Personal, local-first project — everything ships **default-on**. A new
feature is integrated directly and enabled by default; it never hides
behind an opt-in flag or a config toggle. If a feature cannot be safe by
default, make it safe by default rather than adding a switch.

### Parallel loop (the only execution path, agent-initiated)

The review loop and the decompose module loop run through the
`@quintinshaw/pi-dynamic-workflows` engine — a HARD dependency that ships
with this extension (installed into the extension directory by
`scripts/install-global.sh`). `/review` auto-shards large diffs
(`run_parallel_shard_review`); `/plan-next` dispatches patch-first wave
workers (`run_wave_workflow`). The agent decides when a task is large enough
to propose `/decompose` (evidence + estimate → user consent → module-table
approval) — there is no serial protocol and no fallback: a missing engine is
an installation error, never a slow lane. Design record:
`docs/parallel-execution-plan.md` §8; runtime contract: `lib/pdw-bridge.ts`.

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
