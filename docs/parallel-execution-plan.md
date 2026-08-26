# Single-review loop & model tiers — implemented design

**Status**: single-review loop implemented 2026-08-26, replacing the
earlier multi-reviewer and module-planning machinery. One reviewer per
round, one disposable snapshot, one `record_review` call.

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

```
edit code (batch related edits — the loop is billed per ROUND, not per line)
  → run_precommit first (cheap checks before the expensive judge)
  → prepare_review (ONE snapshot of the change; returns cwd, stream, file list, task)
  → spawn ONE reviewer as its own top-level subagent call carrying that cwd
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
- **Snapshot pin is mechanical**: `lib/reviewer-spawn-guard.ts` blocks a
  reviewer spawn naming no snapshot, blocks `workflowScript` dispatch of
  reviewers entirely (no per-child `cwd`), and `record_review` withholds a
  READY for a snapshot with no evidence it was entered (`SNAPSHOT UNUSED`).

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

## 8. Architecture: one reviewer, one snapshot, no engine

**Status**: implemented 2026-08-26.

The serial bottlenecks of the old design (multi-reviewer, module-loop)
were removed by user decision. What remains:

### 8.1 The single review round

`lib/parallel-review.ts` holds the pure reviewer contract: the verdict schema
(`REVIEW_VERDICT_SCHEMA`, with the required `cwd` evidence field) and the
prompt builder (`buildReviewPrompt`). `extensions/review-gate.ts`'s
`prepare_review` materializes ONE disposable WRITABLE snapshot per round,
regardless of diff size, and returns the reviewer's cwd, finding-stream path,
file list and ready-made task text. The reviewer audits the whole change.

### 8.2 Snapshot integrity, mechanically

`lib/review-snapshot.ts` creates and verifies the snapshot; `record_review`
re-derives its tree (a READY from a reviewer that left edits behind is
downgraded) and demands evidence the snapshot was entered (the spawn the gate
observed, or the `cwd` the reviewer reports — `SNAPSHOT UNUSED` otherwise).

### 8.3 No engine — subagents only

Reviews are dispatched as ordinary subagents: pi-subagents honors a per-call
`cwd` and enforces a structured `outputSchema`, so the reviewer gets its own
disposable WRITABLE snapshot. A missing engine is not a concern — there is no
engine to miss.

#### Post-install verification checklist

1. Install the package (`pi install <path-or-npm-spec>` — its `postinstall`
   runs `scripts/install-package.mjs`: agents → `~/.pi/agent/agents/`, and
   git hooks when the current dir is a repo), then restart Pi / `/reload`.
2. In a real pi session on this repo: run `/review` on any change and confirm
   ONE reviewer runs inside its own snapshot, then record its verdict in one
   `record_review` call.
3. Record wall-clock numbers and compare against the ~190 s baseline; update
   this section when measured.
