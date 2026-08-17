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
| **L1 cheap/fast** | `claude-haiku-4-5` → `deepseek/deepseek-v4-flash` → `oc-sdk-go/deepseek-v4-flash` → `onekey/deepseek-v4-flash` | triage pre-scan, mechanical checklist, failure triage, recon | none (advisory input) |
| **L2 execution** | `claude-sonnet-5` → `deepseek/deepseek-v4-pro` → `deepseek/deepseek-v4-flash` → `oc-sdk-go/deepseek-v4-flash` → `onekey/deepseek-v4-flash` → `onekey/grok-4.6` → `onekey/glm-5.3` → `claude-opus-5` | implement fixes from findings, write tests, docs, Copilot-thread prep | none (output reviewed by main agent) |
| **L3 judgment** | `claude-fable-5` (per role) → `claude-opus-5` → `onekey/gpt-5.6-sol` → `onekey/glm-5.3` → `onekey/grok-4.6` | reviewer / arbiter / major adviser consultation | **the only tier that emits verdicts** |

Agents: `agents/triage.md` (L1), `agents/fixer.md` (L2), `agents/reviewer.md`
+ `agents/adviser.md` + `agents/arbiter.md` (L3, `thinking: max`).

Model IDs resolve against the configured providers (`~/.pi/agent/models.json`,
onekey gateway; `oc-sdk-go` from the `pi-opencode-bridge` package;
`deepseek/…` is the user's own DeepSeek subscription). The runtime source of
truth is the configuration, not the models-store cache.

## 3. The pipeline (one round)

```
edit (batched; L2 fixer output merged by the main agent)
  → [run_precommit]  runner: lint:fix FIRST (edits files → stabilizes the
                     worktree), then lint/typecheck/build/test in PARALLEL,
                     output + receipt steps in declaration order
  → [triage subagent, async]  mechanical sweep → findings fed to reviewer
  → [reviewer subagents, spawned async, SAME turn]  audit the green tree
  → record_review (worst verdict wins; triage findings are input, not verdict)
  → BLOCKED? fix → repeat    READY? declare_done → ship
```

Key facts of the implementation:

- **Precommit runs FIRST, review second — never concurrently.** The runner
  schedules: any `lint:fix` script runs first and alone (it edits files, so
  nothing may read the worktree before it finishes); the remaining checks run
  concurrently via `Promise.all`. Only after a PASS does the expensive review
  start — a FAIL is cheaper to fix before the expensive judge looks, and a
  review spent on a red tree is a fully wasted round. (An earlier design
  overlapped them; abandoned for exactly that reason — measured in §5.)
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

- **Precommit first, review second**: `run_precommit` (fast for an
  intermediate round, full for the final round) must PASS before the
  reviewer subagents are spawned — both of them, in the SAME turn, async.
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
  As of the tiered-trigger implementation (2026-08-15), split review is
  automatic: the agent decides by diff size — small diffs (<20 files AND
  <500 lines) run the default TWO cross-family reviewers (fable-5 +
  gpt-5.6-sol chains, both max thinking), large diffs are auto-sharded ≤4 ways.

## 5. Latency & cost

| Stage | Before | After |
|---|---|---|
| One review round, small diff (<20 files, <500 lines) | ~280 s serial | ~190 s (two cross-family reviewers in parallel; precommit runs first, ~2 s fast lane — figure measured under the earlier overlap design, drift negligible) |
| One review round, large diff (auto-sharded) | ~280 s serial | ≤4 parallel shard reviewers + 1 integration review |
| Precommit (multi-step repos) | serial steps | parallel steps, declaration-order output |
| Multi-repo session | one repo at a time | N repos concurrently |
| Token cost | ~all on the strong model | ~80% of tokens on L1/L2 (~10% of cost) |
Small-diff rounds avoid any orchestration overhead entirely — the 3×
cost bug where small diffs were unnecessarily sharded is gone.

## 6. Boundaries (never cross)

- Binding, fail-closed, fingerprint, verdict/docSync parsing, receipt
  validation: **zero changes** (structural tests pin this).
- Timing-regression tests: iteration count and mechanism untouched; their
  stability under parallel scheduling is verified (see §7).
- Single-writer, restated: **the MAIN WORKTREE has exactly one writer** (the
  main agent). Concurrent writers never share it. Parallel wave workers stay
  read-only and deliver patches (see §8). Reviewers are no longer an exception
  to be argued about: each one runs in its OWN disposable snapshot worktree
  (`lib/review-snapshot.ts`), so its writes — mutation analysis, test runs —
  land in a copy that is discarded at the end of the round. That is what lets
  the main agent keep fixing while a review runs, and what removes the old
  collision between two parallel same-worktree reviewers.
  Integrity is mechanical, not honour-based: the snapshot's tree is re-derived
  when the reviewer finishes, and a READY from a reviewer that left its own
  edits behind is downgraded to BLOCKED (its findings stay valid).
- **No runtime workflow engine is shipped any more** — the
  `@quintinshaw/pi-dynamic-workflows` dependency was retired in step 2 of
  `docs/handoff-remove-pdw.md`; wave workers and reviewers are ordinary
  subagents (pi-subagents is the companion package providing the spawn
  protocol). `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` /
  `typebox` are `peerDependencies` ("*") provided by the pi host. No network
  I/O in the gate.
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

## 8. Parallel loop & decompose on subagents (plane 1 + plane 2)

**Status**: implemented 2026-08-15 (landing branch: a semantic feature branch, per AGENTS.md; never main).

The two remaining serial bottlenecks were (a) the single full-diff reviewer
round and (b) one-worker-at-a-time module implementation. Both are now
parallelized, but NOT on the same substrate — and the split is forced, not
chosen:

- **Module implementation (waves) + the decompose loop** run on plain
  subagents of the static READ-ONLY agent `agents/worker-readonly.md`
  (`prepare_wave` → N same-turn spawns → `apply_wave_patches`; the engine is
  gone, see §8.4).
- **Review** runs on plain subagents. The engine discarded a per-agent `cwd`, so
  a shard reviewer could not hold its own snapshot of the change it judges;
  `prepare_review` shards the diff and materializes one writable snapshot per
  reviewer instead. Rationale, evidence and the record of retiring the engine
  entirely: `docs/handoff-remove-pdw.md`.

### 8.1 Plane 1 — parallel shard review (snapshot-isolated fan-out)

`lib/parallel-review.ts`. The review uses a **tiered trigger**
(`shouldShardReview(fileCount, lineCount)`, thresholds exported as
`SHARD_THRESHOLD_FILES` / `SHARD_THRESHOLD_LINES`):

- **Small diff** (<20 files AND <500 changed lines): TWO cross-family
  reviewers over the full change — no engine, no sharding. Each attests
  `docSync` itself (no separate integration review on this path).
- **Large diff** (≥20 files OR ≥500 changed lines): `prepare_review` splits the
  diff into ≤4 disjoint shards (`planReviewShards`) covering every changed
  file, materializes ONE disposable writable snapshot per shard
  (`lib/review-snapshot.ts`) and returns each shard's cwd, finding-stream path,
  file list and ready-made task text. The main agent spawns one ordinary
  subagent per shard — all in the same turn, each with its own `cwd`. Write
  protection is no longer a denylist but ISOLATION: a reviewer may edit and run
  mutation analysis inside its copy, and the gate re-derives that snapshot's
  tree afterwards (a modified snapshot loses its READY). The reviewer model
  comes from the pinned agent definition (`agents/reviewer.md`), and the
  opencode-go cost allowlist (`isModelAllowed`: only `deepseek-v4-flash`) is
  enforced where judges are chosen (`lib/review-fanout.ts`). Each shard
  verdict carries NO docSync (a shard cannot attest the
  whole change). The main agent records every shard's full raw output in ONE
  `record_review` call (worst verdict wins, same as serial), then runs ONE
  integration reviewer over the whole change whose record — alone — carries
  the docSync attestation.

This mirrors the /plan-verify two-phase protocol (§6.3 of the orchestration
doc). `/review` drives it directly — the agent decides by diff size without
asking the user.

### 8.2 Plane 2 — patch-first wave workers (parallel implementation)

`lib/plan-parallel.ts`. Wave workers are **not decompose-exclusive**: the
patch-first protocol is the same for formal decompose waves and for ad-hoc
**wave daily** (any task that can be split into 2–4 independent sub-tasks
with disjoint file ownership). Engine isolation was investigated and
rejected for writers (it never auto-merges, deletes the worktree and branch
in a finally block right after each agent, and silently degrades to the
shared worktree when isolation fails). Patch-first with subagents instead:
`computeWave` selects every pending module whose dependencies are
implemented/accepted (≤4 per wave); `prepare_wave` reconciles the wave
fail-closed and hands back one ready-made task per module; the MAIN AGENT
spawns one READ-ONLY worker subagent per module in the SAME turn
(`agents/worker-readonly.md` — its `tools:` allowlist has no edit/write/bash;
`WAVE_WORKER_SCHEMA` as outputSchema), each returning unified git diffs;
`apply_wave_patches` re-validates (`validatePatchOwnership` ⊆ owned_paths,
then `git apply --check`), persists patches under `.pi/plan/patches/`, and the
main agent applies them in sequence with per-patch validation (no
cross-patch rollback transaction — a failed patch is sent back to its worker,
never silently edited). Single-writer is preserved: the worktree is only ever
written by the main agent.

### 8.3 Run visibility (live progress + persisted artifacts)

**Status**: implemented 2026-08-16.

A pdw run used to be a black box: the tools awaited `runWorkflow` with no
callbacks and `persistLogs` disabled. That layer is gone (step 2 of
`docs/handoff-remove-pdw.md`): `lib/pdw-progress.ts`, `.pi/pdw-progress/*.ndjson`
and the engine log path are deleted. Everything that runs is an ordinary
subagent now, and its visibility comes from the sub-agent runtime itself:

1. **`.pi-subagents/artifacts`** — every spawned agent (wave worker, shard
   reviewer, planner) writes its artifact there; the TUI widget and
   `/gate-status` scan it (`scanAgentArtifacts`). Worker start/end and
   outcomes are visible even while the main agent keeps editing or fixing.
2. **Structured output at the source** — each spawn carries an `outputSchema`
   (`WAVE_WORKER_SCHEMA` for wave workers, `SHARD_VERDICT_SCHEMA` for
   reviewers), so a malformed result fails at the spawn instead of arriving as
   unparseable prose.
3. **Session transcripts** — pi-subagents persists each agent's transcript
   (`~/.pi/agent/sessions/…`), switchable from pi's `/resume` picker. No
   extension-side log mirroring.

None of this is load-bearing for a verdict: the gate only ever binds on the
worktree fingerprint and the recorded review/precommit verdicts. Progress
artifacts are best-effort diagnostics.

### 8.4 No engine — subagents only

- The `@quintinshaw/pi-dynamic-workflows` dependency is REMOVED (package.json
  and `scripts/install-package.mjs`); `lib/pdw-bridge.ts` and
  `lib/pdw-progress.ts` are deleted. `.pi/plan/state.json`'s parallel ledger
  records `engine: "subagents"` — the retired legacy `"pdw"` value no longer
  parses (the parse-time compatibility was removed with the engine).
- Wave workers are read-only by construction: `agents/worker-readonly.md`'s
  `tools:` allowlist has no edit/write/bash — the mechanical guarantee
  (pi-subagents has no per-call tool denylist).
- Gate core (binding, fail-closed, fingerprint, verdict/docSync parsing,
  receipt) untouched; pinned by the existing test suite.
- A wave patch that fails `git apply` is sent back to its worker for one
  retry, never silently edited by the main agent.
- Target: small-diff review rounds avoid any orchestration overhead
  (the 3× cost bug where small diffs were unnecessarily sharded is
  gone); large-diff parallel review targets ≤60% of the serial wall clock
  (~190 s baseline on this repo). A 3-module wave (decompose or wave daily)
  targets ≈ 1.5–2× a single module's serial time. Wall-clock measurements
  are to be taken during real dogfooding of the wave flow — until then the
  numbers above are targets, not measurements.

#### Post-install verification checklist

1. Install the package (`pi install <path-or-npm-spec>` — its `postinstall`
   runs `scripts/install-package.mjs`: agents → `~/.pi/agent/agents/`, and
   git hooks when the current dir is a repo), then restart Pi / `/reload`.
2. In a real pi session on this repo: run `/review` on a **small** change
   (<20 files, <500 lines) and confirm the labels you pass to `prepare_review`
   are the reviewers that run (worst verdict wins); then run `/review` on a
   change with ≥20 files or ≥500 lines and confirm `prepare_review` returns ≤4
   disjoint shards covering every changed file, each with its own snapshot cwd
   and stream file, that the reviewers run concurrently (watch the sub-agent
   panel), and that a snapshot left modified loses its READY. Then record every
   shard output in ONE `record_review` and run the integration review.
3. In a real pi session with a multi-module plan: run `/plan-next` and
   confirm one wave dispatches several read-only workers concurrently and
   their patches apply. Also test a **wave daily** dispatch: define 2–4
   ad-hoc modules with disjoint owned_paths, call `prepare_wave`, spawn one
   `worker-readonly` subagent per module, call `apply_wave_patches`, and
   confirm the patches apply.
4. Record wall-clock numbers and compare against the ~190 s serial baseline;
   update this section when measured.
