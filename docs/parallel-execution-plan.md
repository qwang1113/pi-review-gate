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
Small-diff rounds avoid the pdw orchestration overhead entirely — the 3×
cost bug where small diffs were unnecessarily sharded is gone.

## 6. Boundaries (never cross)

- Binding, fail-closed, fingerprint, verdict/docSync parsing, receipt
  validation: **zero changes** (structural tests pin this).
- Timing-regression tests: iteration count and mechanism untouched; their
  stability under parallel scheduling is verified (see §7).
- Single-writer: L2 fixes are merged by the main agent; concurrent writers
  never share one worktree. (Parallel wave workers are read-only and deliver
  patches — see §8.)
- **One runtime npm dependency, required and shipped with the package**: `@quintinshaw/pi-dynamic-workflows`
  (the engine — a HARD dependency, there is no serial fallback).
  `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` / `typebox` are
  `peerDependencies` ("*") provided by the pi host. `lib/pdw-bridge.ts` loads
the engine once per
  process; a missing/broken engine THROWS an installation error that the
  tools surface — it never silently degrades. No network I/O in the gate.
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

## 8. Parallel loop & decompose on pi-dynamic-workflows (plane 1 + plane 2)

**Status**: implemented 2026-08-15 (landing branch: a semantic feature branch, per AGENTS.md; never main).

The two remaining serial bottlenecks were (a) the single full-diff reviewer
round and (b) one-worker-at-a-time module implementation. Both are now
parallelized on top of `@quintinshaw/pi-dynamic-workflows` (pdw), the
engine — the ONLY execution path (§6): there is no serial protocol to fall
back to.

### 8.1 Plane 1 — parallel shard review (read-only fan-out)

`lib/parallel-review.ts`. The review uses a **tiered trigger**
(`shouldShardReview(fileCount, lineCount)`, thresholds exported as
`SHARD_THRESHOLD_FILES` / `SHARD_THRESHOLD_LINES`):

- **Small diff** (<20 files AND <500 changed lines): TWO cross-family
  reviewers over the full change — no pdw engine, no sharding. Each attests
  `docSync` itself (no separate integration review on this path).
- **Large diff** (≥20 files OR ≥500 changed lines): the diff is split into
  ≤4 disjoint shards (`planReviewShards`, weight-balanced); a pdw workflow
  runs one L3 reviewer per shard in parallel (no `agentType` binding — the
  shard prompt itself carries the reviewer role and the engine-level
  excludeTools list is the write protection; the model is resolved from
  `DEFAULT_REVIEWER_MODEL` with a fallback candidate list via
  `resolveBestModel`, so a pinned model missing from the user's models.json
  never falls back to an unauthenticated provider; `resolveBestModel` also
  enforces the hard-coded cost allowlist `isModelAllowed` — the opencode-go
  provider may only run `deepseek-v4-flash` (every other opencode-go model
  is billed per-use and explicitly forbidden), while all other providers are
  unrestricted), each with a
  structured-output schema that carries NO docSync (a shard cannot attest the
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
with disjoint file ownership). pdw's own `isolation: "worktree"` was
investigated and rejected for writers: v3.5.1 never auto-merges, deletes the
worktree and branch in a finally block right after each agent, forbids worker
`git commit` (so edits would be destroyed), and silently degrades to the
shared worktree when isolation fails. Patch-first instead: `computeWave`
selects every pending module whose dependencies are implemented/accepted (≤4
per wave); `runWaveWorkflow` runs one READ-ONLY worker per module in parallel
(edit/write tools excluded engine-wide), each returning unified git diffs;
the main agent validates (`validatePatchOwnership` ⊆ owned_paths, then
`git apply --check`), persists patches under `.pi/plan/patches/`, and applies
them in sequence with per-patch validation (no cross-patch rollback
transaction — a failed patch is sent back to its worker, never silently
edited). Single-writer is preserved: the worktree is only ever written by the
main agent.

### 8.3 Run visibility (live progress + persisted artifacts)

**Status**: implemented 2026-08-16.

A pdw run used to be a black box: the tools awaited `runWorkflow` with no
callbacks and `persistLogs: false` explicitly disabled the engine's default
log. Every parallel run now wires the engine's live callbacks
(`onLog` / `onPhase` / `onRuntimeEvent` / `onAgentStart` / `onAgentEnd`)
through `lib/pdw-progress.ts` (`createProgressSink`) to three surfaces:

1. **Live streaming in the tool card** — both tools pass `onProgress` to the
extension `onUpdate` protocol: each agent start/end pushes a one-line status
(`[run-…] 1/3 agents · active: shard-2 · last: shard-1 done ([model] 12.3s, 1234
tok)`) plus a 0–100 `details.progress` (carried on the same `onUpdate` events;
pi renders the `content` text on the tool card).
2. **ndjson event file** — every event is appended to
`.pi/pdw-progress/<runId>.ndjson` (one JSON object per line, `run-end`
terminal event in the `finally`); `tail -f` it from another terminal while
the tool call blocks. The directory is gitignored. The ndjson is anchored
at the GIT ROOT (`gitRootOfDir`, sanitized env) — never at a subdirectory
cwd — so it stays inside the fingerprint's `:/.pi` exclusion and a
recording run can never invalidate its own READY binding.
3. **Engine log + session transcripts** — `persistLogs` is back to the
engine default (true): `~/.pi/workflows/projects/<key>/runs/<runId>.log`.
`persistAgentSessions: true` persists each sub-agent's full transcript to
`~/.pi/agent/sessions/<encoded-cwd>/` named `workflow:<runId> <label>`,
openable/switchable from pi's `/resume` session picker (default-on per the
project principle; transcripts may contain sensitive context, as the engine
itself warns).

All progress writes are best-effort: a read-only cwd, ENOSPC or a `.pi` that
is a regular file silently degrades the sink (in-memory events only) — it
never aborts the review/wave run.

Every outcome (success AND failure) carries `runId`, `progressFile` and
`engineLogFile` so a failed run can still be located and replayed.

### 8.4 Hard dependency and safety

- `lib/pdw-bridge.ts` loads pdw via dynamic import once per process; any
  failure throws `PdwUnavailableError` (installation guidance) and every
  consumer propagates it — the tools report the error, they never run a
  serial protocol. The engine ships with the extension
  (`scripts/install-package.mjs` runs on `pi install` / `npm install` and
  FAILS loudly if the runtime cannot resolve).
- Gate core (binding, fail-closed, fingerprint, verdict/docSync parsing,
  receipt) untouched; pinned by the existing test suite.
- A wave patch that fails `git apply` is sent back to its worker for one
  retry, never silently edited by the main agent.
- Target: small-diff review rounds avoid the pdw orchestration overhead
  entirely (the 3× cost bug where small diffs were unnecessarily sharded is
  gone); large-diff parallel review targets ≤60% of the serial wall clock
  (~190 s baseline on this repo). A 3-module wave (decompose or wave daily)
  targets ≈ 1.5–2× a single module's serial time. Wall-clock measurements
  are NOT yet taken: end-to-end runs need a real pi session with the
  installed engine — until then the numbers above are targets, not
  measurements.

#### Post-install verification checklist

1. Install the package (`pi install <path-or-npm-spec>` — its `postinstall`
   runs `scripts/install-package.mjs`: agents → `~/.pi/agent/agents/`, and
   git hooks when the current dir is a repo), then restart Pi / `/reload`.
2. In a real pi session on this repo: run `/review` on a **small** change
   (<20 files, <500 lines) and confirm TWO cross-family reviewers run with no pdw
   engine (worst verdict wins); then run `/review` on a change with ≥20 files or ≥500 lines and
   confirm the engine auto-shards and runs the reviewers concurrently (watch
   the pdw run panel), then record Phase A and run the integration review.
3. In a real pi session with a multi-module plan: run `/plan-next` and
   confirm one wave dispatches several read-only workers concurrently and
   their patches apply. Also test a **wave daily** dispatch: define 2–4
   ad-hoc modules with disjoint owned_paths, call `run_wave_workflow`, and
   confirm the patches apply.
4. Record wall-clock numbers and compare against the ~190 s serial baseline;
   update this section when measured.
