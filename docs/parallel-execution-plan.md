# Parallel execution & model-tier plan (implemented)

**Status**: implemented 2026-08-10 (branch `feat/parallel-pipeline-model-tiers`).

This document is the design record for the parallel pipeline and the L1/L2/L3
model-tier split. It states what was decided, why, and the boundaries that
must never be crossed while extending the workflow.

## 1. Three principles

1. **Default-on.** This is a personal, local-first project: every feature is
   integrated directly and enabled by default — no opt-in flags, no config
   toggles (see AGENTS.md "Product principles"). The precommit runner's
   parallel scheduling is simply what `run_precommit` does now.
2. **Binding semantics beat parallelism.** Any optimization may overlap wall
   clock, never correctness: a verdict stays bound to the exact worktree
   fingerprint it verified, and the gate fails closed. A parallel race can
   waste a round; it can never release an unverified ship.
3. **Cheap models execute, strong models judge.** L1/L2 may produce findings
   and fixes; only L3 (pinned, `max` thinking) emits READY/BLOCKED verdicts
   that `record_review` accepts — with one narrow, protocol-level exception:
   low-risk changes may be reviewed by L1 (see §4).

## 2. Model tiers

| Tier | Models (first = preferred) | Role | Verdict power |
|---|---|---|---|
| **L1 cheap/fast** | `claude-haiku-4-5` → `deepseek-v4-flash` | triage pre-scan, mechanical checklist, failure triage, recon | none (advisory input) |
| **L2 execution** | `claude-sonnet-5` → `deepseek-v4-pro` → `grok-4.5` | implement fixes from findings, write tests, docs, Copilot-thread prep | none (output reviewed by main agent) |
| **L3 judgment** | `claude-fable-5` / `onekey/gpt-5.6-sol` (per role) → `claude-opus-5` → `claude-opus-4-6` → … | reviewer / arbiter / major adviser consultation | **the only tier that emits verdicts** |

Agents: `agents/triage.md` (L1), `agents/fixer.md` (L2), `agents/reviewer.md`
+ `agents/adviser.md` + `agents/arbiter.md` (L3, `thinking: max`).

Model IDs resolve against the configured providers (`~/.pi/agent/models.json`,
onekey gateway); `grok-4.5` is configured there but is absent from the
read-only `models-store.json` cache — the runtime source of truth is the
configuration, not the store.

## 3. The pipeline (one round)

```
edit (batched; L2 fixer output merged by the main agent)
  → [run_precommit]  runner: lint:fix FIRST (edits files → stabilizes the
                     worktree), then lint/typecheck/build/test in PARALLEL,
                     output + receipt steps in declaration order
  ⇄  [reviewer subagent, spawned async]  reads the same worktree concurrently
  ⇄  [triage subagent, async]  mechanical sweep → findings fed to reviewer
  → record_review (worst verdict wins; triage findings are input, not verdict)
  → BLOCKED? fix → repeat    READY? declare_done → ship
```

Key facts of the implementation:

- **No flags.** The runner schedules: any `lint:fix` script runs first and
  alone (it edits files, so nothing may read the worktree before it finishes);
  the remaining checks run concurrently via `Promise.all`.
- **Declaration-order presentation.** The log and the receipt `steps` array
  read in declaration order (lint, typecheck, build, test), never completion
  order. A killed run's log therefore stops at the FIRST unfinished check —
  the hung step stays identifiable (regression-tested).
- **Receipt contract unchanged.** `schema: 1`, `mode` fast/full, nonce, exit
  0/1/2, `checksRun`/`checksFailed` — `lib/precommit-receipt.ts` validation
  logic is untouched (pinned by test).
- **Parallel-review race is a wasted round, not a wrong ship.** If a check
  writes files (snapshots, build artifacts) while the reviewer reads, the
  fingerprint moves and the verdict is discarded — the gate re-arms and the
  round repeats. Bound, accepted, documented.

## 4. Protocol additions (skills/review-loop/SKILL.md)

- **Parallel round**: spawn the reviewer (and triage) async, run
  `run_precommit` while they work; record only after both finished.
- **Multi-repo**: loops for independent repos run concurrently (no shared
  state; `record_review`/`run_precommit` bind per-repo).
- **Waiting-window discipline**: while the reviewer runs (~3 min), do useful
  work — other repos, PR drafts, `[NIT_DEFERRED]` log, triage.
- **Triage input**: L1 findings go to the reviewer as input, never straight
  to `record_review`.
- **Low-risk L1 review** (the one exception to principle 3): a change that is
  purely docs/formatting/one-line may be reviewed by an L1 agent whose verdict
  IS recorded. Judgment of "low-risk" belongs to the main agent and is
  auditable by the L3 reviewer (a misjudged low-risk call is a P1 finding).
- **Split review** (very large diffs): parallel reviewers over disjoint file
  groups or dimensions; the main agent merges — any BLOCKED wins (worst
  wins), consistent findings are merged, and the merged result is recorded.

## 5. Latency & cost

| Stage | Before | After |
|---|---|---|
| One review round (this repo) | ~280 s serial | ~190 s (review ⇄ precommit overlap) |
| Precommit (multi-step repos) | serial steps | parallel steps, declaration-order output |
| Multi-repo session | one repo at a time | N repos concurrently |
| Token cost | ~all on the strong model | ~80% of tokens on L1/L2 (~10% of cost) |

## 6. Boundaries (never cross)

- Binding, fail-closed, fingerprint, verdict/docSync parsing, receipt
  validation: **zero changes** (structural tests pin this).
- Timing-regression tests: iteration count and mechanism untouched; their
  stability under parallel scheduling is verified (see §7).
- Single-writer: L2 fixes are merged by the main agent; concurrent writers
  never share one worktree.
- No new npm dependencies, no network I/O in the gate.
- Verdicts only from L3 (with the low-risk exception above).

## 7. Parallel-stability verification

The two fingerprint timing regressions (300/25 rounds) are sensitive to load
and pacing by design. Verification on 2026-08-10 (branch
`feat/parallel-pipeline-model-tiers`): `run_precommit --mode full` six
consecutive runs — three before and three after adding the `nice` yield for
non-test steps — all six PASS. Wall-clock on this repo: ~138-157 s, i.e.
par with the serial baseline (`npm test` ~137 s + typecheck ~2 s); the
parallel win lands on multi-step repos, where independent checks overlap.
Non-test parallel steps run `nice -n 10` so a timing-sensitive `test` keeps
its pacing when a CPU-heavy check (tsc, build) is concurrent.
