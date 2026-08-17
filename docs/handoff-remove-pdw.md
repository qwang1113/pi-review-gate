# Handoff: retire the pdw engine (step 2)

Step 1 (shipped in the PR that adds this file) moved **review** off
`@quintinshaw/pi-dynamic-workflows` and onto plain subagents with per-reviewer
snapshots. This document hands over step 2: doing the same for the remaining two
consumers and dropping the dependency.

Read it with `docs/parallel-execution-plan.md` (the original design) and
`AGENTS.md` (the project principles that change at the end of step 2).

## Motivation

Two orchestration layers do the same job. The gate spawns subagents directly
(reviewer, adviser, recon, triage, fixer) **and** drives a workflow engine
(wave workers, decompose module loop). Every capability therefore has to be
built twice, and the two layers have different, non-overlapping gaps:

| | pdw engine | pi-subagents |
|---|---|---|
| per-call `cwd` | **dropped** (see Evidence) | supported |
| per-call tool denylist | `excludeTools` | **absent** (static `tools:` per agent) |
| structured output | `schema` per `agent()` | `outputSchema` per call |
| parallel fan-out | `parallel()` in a script | N async spawns, or `runs.all` |
| progress surface | `.pi/pdw-progress/*.ndjson` | `.pi-subagents/artifacts` (already what the TUI widget reads) |
| script constraints | determinism blocklist ⇒ every injected string must be sanitized | none (no script) |

Keeping only the subagent layer removes the sanitizer, the progress sink, the
bridge, and one hard dependency — and it is the layer whose gap (no per-call
denylist) can be closed with a static read-only agent definition, as step 1
demonstrated with `agents/reviewer-readonly.md`.

## Evidence

The engine **discards a per-agent `cwd`**. In
`node_modules/@quintinshaw/pi-dynamic-workflows/dist/workflow.js`, the value
handed to the runner is computed only from the engine's own isolation option:

```js
const resolvedIsolation = agentOptions.isolation ?? agentDef?.isolation;
if (resolvedIsolation === "worktree") { worktree = await createWorktree(baseCwd, …); }
const runCwd = worktree?.isolated ? worktree.cwd : undefined;   // ← nothing else feeds it
…
const runPromise = agentRunner.run(prompt, { …, cwd: runCwd, … });
```

Measured with a stub runner: a script passing `agent(prompt, { cwd })` reached
the runner with `cwd: undefined`, and two shards received the *same* (undefined)
directory. And the engine's own isolation cannot substitute: `createWorktree`
runs `git worktree add -b <branch> <path> HEAD`, i.e. a checkout of **HEAD** —
it does not contain the uncommitted change a review exists to judge.

Consequence for step 1: shard reviewers could not hold their own copy of the
change, so they shared the live worktree. Since the prompt had (wrongly) started
telling them "you are in a disposable snapshot, edit freely", that was a
fail-open — a reviewer following instructions would rewrite the user's files
through `bash`, which the engine's `excludeTools` does not cover.

Workflow-level `cwd` **is** honored (`WorkflowAgent`: `this.cwd = options.cwd`),
so a single shared snapshot would have been possible — but N shards mutating one
directory reintroduces shard-vs-shard interference (false findings from code
another shard broke mid-run, and drift that cannot be attributed).

## Validated pattern

Step 1 proves the replacement end to end, in production, on this repository:

- `prepare_review` (extensions/review-gate.ts) computes the shard plan with the
  pure `planReviewShards`, materializes ONE writable snapshot per reviewer
  (`lib/review-snapshot.ts`), and returns each reviewer's `cwd`, stream path,
  file list and ready-made task text. The split is mechanical: the tool does it,
  not the prompt.
- Reviewers run as ordinary subagents with that `cwd`. Two dogfooded rounds ran
  4+ mutations inside their snapshots and restored them byte-for-byte; the live
  worktree was untouched while the main agent kept fixing streamed findings.
- Integrity is mechanical, not honour-based: `record_review` re-derives every
  snapshot's tree (drifted ⇒ that reviewer's READY becomes BLOCKED) and compares
  the tree the reviewers read with the tree at record time (`STALE TREE` ⇒ a
  READY cannot bind to code no reviewer saw).
- The fallback is mechanical too: no snapshot ⇒ spawn `reviewer-readonly`, whose
  `tools:` allowlist cannot write.

Copy that shape: **tool computes the plan → tool materializes isolation → agent
spawns N subagents with per-call `cwd` → tool verifies afterwards.**

## Remaining work

1. **Wave workers** — `lib/plan-parallel.ts` (`runWaveWorkflow`) and the
   `run_wave_workflow` tool in `extensions/review-gate.ts`. Workers are
   read-only and return unified diffs. Replace the engine call with N async
   subagent spawns; the engine's `excludeTools: ["bash","edit","write",…]` must
   become a **static read-only worker definition** (see the last section).
   Keep: `computeWave`, ownership validation (`validatePatchOwnership`) and the
   `git apply --check` gate — they are pure and already tested.
2. **Decompose module loop** — the `/plan-next` path in
   `lib/workflow-commands.ts` plus `agents/planner.md`, `agents/worker.md`,
   `agents/module-reviewer.md`. Same substitution; `lib/plan-state.ts` stays.
3. **Bridge and progress** — delete `lib/pdw-bridge.ts` (`loadPdw`,
   `PdwUnavailableError`, `resolveBestModel`, `registryHasModels`,
   `sanitizeInjectedWorkflowText`, `isModelAllowed`) and `lib/pdw-progress.ts`.
   **`isModelAllowed` must survive** — the opencode-go cost allowlist is a user
   requirement and is used by `lib/review-fanout.ts` and `lib/gate-doctor.ts`;
   move it to its own module. `sanitizeInjectedWorkflowText` dies with the last
   generated script (check `test/workflow-script-sanitize.test.ts`).
4. **Doctor check** — `lib/gate-doctor.ts` still has a `pdw-engine` check, now
   scoped to "wave daily / decompose" (review was removed from its wording in
   step 1). Drop the check entirely when the dependency goes, and update
   `test/gate-doctor.test.ts`, which asserts that scope.
5. **Package + install** — remove the dependency from `package.json` and its
   registration from `scripts/install-package.mjs`; `pi-subagents` stays.
6. **Docs and principles** — `AGENTS.md` still calls the engine "a HARD
   dependency … the only execution path"; that paragraph becomes "subagents are
   the only execution path". Also update `README.md` (layer table and file
   list), `QUICKSTART.md`, `skills/review-loop/SKILL.md` and
   `docs/parallel-execution-plan.md` §8.
7. **Tests** — `test/pdw-integration.test.ts` currently holds only wave +
   model-resolution cases (the review cases were removed in step 1); split or
   rename it, and keep the model-allowlist assertions wherever `isModelAllowed`
   lands.

## Risks & verification

| Risk | Why it matters | How to verify |
|---|---|---|
| A wave worker gains write access | patch-first collapses; concurrent writers in one worktree | a structural test asserting the worker agent's `tools:` has no `edit`/`write`/`bash`, plus a behavioural test that a wave run produces patches and leaves `git status` unchanged |
| A snapshot leaks into the real repo through a SHARED path | `node_modules` is a symlink, and `.git` (hence `.git/hooks`, the L3 layer) is shared by every linked worktree — a reviewer that ran an installer inside its snapshot repointed the real repo's hooks at a directory that was then deleted, breaking every later commit (happened once, during step 1) | both installers refuse to run from `.pi/review-snapshots/` (`scripts/install-git-hooks.sh`, `scripts/install-package.mjs`), locked by a behavioural test in `test/git-hooks.test.ts` that runs the installer inside a real linked worktree; keep that guard when the wave workers move, since they will get snapshots too |
| Losing the opencode-go cost allowlist | user requirement: only `deepseek-v4-flash` on that provider | keep the existing behavioural tests and point them at the new module |
| Parallelism silently degrades to serial | the whole point of waves/shards | assert the launches happen in ONE turn (async), and compare wall-clock in a dogfooded run |
| Structured verdicts stop being enforced | a malformed verdict fails closed, so this is noisy rather than unsafe | pass `SHARD_VERDICT_SCHEMA` as the spawn's `outputSchema` (`prepare_review` prints it) and keep its shape test in `test/parallel-review.test.ts`. Note `parseShardVerdict` is gone: the engine parsed structured results itself, whereas a recorded verdict is parsed by `lib/verdict-parse.ts` |
| Progress/telemetry regressions | the TUI widget and `/gate-status` read run state | the widget already scans `.pi-subagents/artifacts`; verify with a live wave that the widget lists the workers |
| Half-migrated state | two layers at once is worse than either | migrate one consumer per PR (wave, then decompose), each with its own review round |

## New readonly worker variant

Wave workers need what `reviewer-readonly` needed: the engine used to strip
their tools, and subagents cannot. Add `agents/worker-readonly.md`:

- `tools: read, grep, find, ls` — **no** `bash`, `edit` or `write` (the engine
  denied all three for wave workers; `bash` was denied because a worker could
  otherwise write through a shell).
- Body: the patch-first contract from `agents/worker.md` — produce a unified
  diff for the module's `owned_paths` in the reply, never touch the worktree,
  never ship — plus the same "no channel to ask, report the blocker in the
  worklog" wording, since it has no messaging tool either.
- Keep `agents/worker.md` as the SERIAL single-writer role (decompose module
  work) and make the distinction explicit in both files, so a wave never
  launches the writable one.
