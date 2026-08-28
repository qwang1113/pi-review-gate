# Single-review loop & model tiers — implemented design

> **SUPERSEDED 2026-08-27** — the execution model moved to **checkpoint
> commits + tmux judge children**: judge roles run as their own pi processes
> in tmux panes (`review_spawn`), the review unit is the immutable commit
> range `baseline..HEAD` (`review_checkpoint` → `prepare_review`), and
> `record_review` binds a READY to the reviewed commit's TREE (STALE when
> HEAD moves). See `docs/execution-model.md` + `docs/judge-protocol.md` for
> the current model. This file is kept as the historical design record of
> the snapshot-based loop (2026-08-26 → 2026-08-27).

**Status (historical)**: single-review loop implemented 2026-08-26,
replacing the earlier multi-reviewer and module-planning machinery. One
reviewer per round, one disposable snapshot, one `record_review` call.

## 1. Three principles

1. **One judge per round.** A single independent reviewer over the WHOLE
   change is the review. No second reviewer, no split, no integration
   pass — the multi-judge machinery was removed because it multiplied cost
   without adding an independent signal a single strong reviewer does not
   already provide (user decision 2026-08-26).
2. **Reviewers verify in a disposable snapshot.** `prepare_review`
   materializes ONE writable git worktree holding exactly the change under
   review; the reviewer may edit and mutate freely inside it, but must
   restore before finishing — `record_review` re-derives the tree and
   downgrades a READY from a reviewer that left edits behind.
3. **Strong models judge, cheap models read.** Verdict emission is pinned to
   a top-tier reasoning model at `max` thinking; the cheap tier only does
   mechanical scanning.

## 2. Model tiers

| Tier | Models (first = preferred) | Role | Verdict power |
|---|---|---|---|
| **L1 cheap/fast** | `claude-haiku-4-5` → `opencode-go/deepseek-v4-flash` | recon pre-scan, code/doc search, heavy reading | none (advisory input) |
| **L2 execution** | `claude-sonnet-5` → `claude-opus-5` → `opencode-go/deepseek-v4-flash` | fixes, docs, Copilot-thread prep | none (output reviewed by main agent) |
| **L3 judgment** | `claude-fable-5` (per role) → `claude-opus-5` → `opencode-go/deepseek-v4-flash` | reviewer / adviser / arbiter / goal-auditor | **the only tier that emits verdicts** |

Agents: `agents/recon.md` (L1), `agents/fixer.md` (L2), `agents/reviewer.md`
+ `agents/adviser.md` + `agents/arbiter.md` + `agents/goal-auditor.md` (L3,
`thinking: max`).

Model IDs resolve against the configured providers (`~/.pi/agent/models.json`).
The runtime source of truth is the configuration, not any models-store cache.

## 3. The pipeline (one round)

> Current (2026-08-27) pipeline — snapshot pipeline below is historical:

```
edit code (batch related edits — the loop is billed per ROUND, not per line)
  → run_precommit first (cheap checks before the expensive judge)
  → review_checkpoint (commits the change; the only commit before a READY)
  → prepare_review (registers baseline..HEAD; returns stream path + task text)
  → review_spawn / review_send (ONE tmux judge child; the wake-up listener comes with the spawn)
  → read the finding stream while it works; fix streamed P0/P1/P2 with evidence
  → record_review with the FULL reviewer output (all fences parsed; worst wins)
  → BLOCKED? fix everything, then start again from precommit
  → READY?  call declare_done
  → ship    (git commit now passes the gate)
```

## 4. Protocol additions (skills/review-loop/SKILL.md)

- **Precommit first**: `run_precommit` (fast lane for intermediates, full for
  the final round) must PASS before the reviewer runs.
- **Isolation + streaming**: the reviewer holds a frozen copy, so the main
  agent keeps fixing the real worktree from streamed findings (confirm each in
  the code first; leave Nits for the verdict).
- **Commit target is mechanical** (2026-08-27): judge-role subagent dispatch
  (`subagent` / `workflowScript` / `workflowScriptPath`) is HARD-blocked;
  `record_review` withholds a READY when the round was never prepared and
  downgrades a READY to BLOCKED as STALE when HEAD moved past the reviewed
  commit. (Historical: the snapshot pin in `lib/reviewer-spawn-guard.ts`
  blocked un-pinned reviewer spawns and withheld READYs for snapshots never
  entered — that module and the snapshot machinery were retired.)

## 5. Latency & cost

| Stage | Before | After |
|---|---|---|
| One review round, any diff size | ~280 s serial | one reviewer (max thinking), precommit first (no overlap) |
| Precommit (multi-step repos) | serial steps | parallel steps, declaration-order output |
| Multi-repo session | one repo at a time | N repos concurrently |

## 6. Boundaries (never cross)

- Binding, fail-closed, fingerprint, verdict/docSync parsing, receipt
  validation: **zero changes** (structural tests pin this).
- Single-writer: the MAIN WORKTREE has exactly one writer — the main agent. Each reviewer sits in its OWN disposable snapshot worktree and restores it before finishing.
- No engine anywhere: reviews run as plain subagents; the pdw engine was
  retired entirely.
- Verdicts only from L3.

## 7. Parallel-stability verification

The two fingerprint timing regressions (300/25 rounds) are sensitive to load
and pacing by design. Verification on 2026-08-10 (branch
`feat/parallel-pipeline-model-tiers`): `run_precommit --mode full` six
consecutive runs — three before and three after adding the `nice` yield for
non-test steps — all six PASS. Wall-clock on this repo: ~138-157 s.

## 8. Architecture (historical): one reviewer, one snapshot, no engine

**Status (historical)**: implemented 2026-08-26; superseded 2026-08-27 by
tmux judge children over checkpoint commit ranges (see the banner).

The serial bottlenecks of the old design (multi-reviewer, module-loop)
were removed by user decision. What remains:

### 8.1 The single review round (current)

`lib/parallel-review.ts` holds the pure reviewer contract: the verdict schema
(`REVIEW_VERDICT_SCHEMA`, with the required `cwd` evidence field) and the
prompt builder (`buildReviewPrompt`). `extensions/review-gate.ts`'s
`prepare_review` registers ONE commit target (`baseline..HEAD`) per round,
regardless of diff size, and returns the finding-stream path, the ready-made
task text and the tmux spawn instructions. The reviewer audits the whole
commit range. (Historical: `prepare_review` used to materialize one
disposable WRITABLE snapshot worktree and return its `cwd`.)

### 8.2 Commit-target integrity, mechanically (current)

`record_review` verifies the registered target: a READY with no prepared
target is withheld, a READY whose HEAD moved past the reviewed commit is
downgraded to BLOCKED (STALE), and a READY binds to the reviewed commit's
TREE (content binding — squash preserves it). (Historical: `lib/review-snapshot.ts`
created and verified snapshots; drift and `SNAPSHOT UNUSED` checks were
retired with it.)

### 8.3 No engine — tmux judge children (current)

Reviews are dispatched as their OWN pi processes in tmux panes of the main
session (`lib/tmux-session.ts` spawns the pane; `lib/judge-prompt.ts` builds
the launcher and task files). The child loads no review-gate extension and
runs `--exclude-tools edit,write`; its context is reused across rounds until
a READY lands, and the done channel wakes the main session
(through the listener `review_spawn` registered for it). (Historical: reviews were dispatched as plain subagents
with a per-call `cwd` into the snapshot.)

#### Post-install verification checklist

1. Install the package (`pi install <path-or-npm-spec>` — its `postinstall`
   runs `scripts/install-package.mjs`: agents → `~/.pi/agent/agents/`, and
   git hooks when the current dir is a repo), then restart Pi / `/reload`.
2. In a real pi session on this repo: run `/review` on any change and confirm
   ONE reviewer runs as a tmux judge child over the checkpoint commit range,
   then record its verdict in one `record_review` call.
3. Record wall-clock numbers and compare against the ~190 s baseline; update
   this section when measured.
