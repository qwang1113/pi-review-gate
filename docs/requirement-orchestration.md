# Requirement orchestration — decompose a large requirement into gated modules

**Status**: design (PR1). The MVP implementation follows in PR2.
**Date**: 2026-08-12.

This document is the contract for turning one oversized requirement into a
serial, module-by-module execution run whose output is accepted by the existing
review gate. It states the roles, the state files, the loop, the gate binding,
and the boundaries that must not be crossed.

## 1. Problem

A large requirement handed to a single session fails in known ways: the context
fills with stale reasoning, scope quietly shrinks, nothing is verifiable per
piece, and a crash loses everything. The main session's context is the scarcest
resource in the system, and today it is spent on implementation detail.

The answer is not a bigger context. It is: **put the authoritative state on
disk, keep every agent short-lived, and let the main session carry only
pointers.**

## 2. Decisions (and what they rule out)

| # | Decision | Consequence |
|---|---|---|
| D1 | **Serial execution.** Modules run one at a time. | No git worktrees, no wave scheduling, no write-collision guard. The single-writer invariant the gate already depends on holds for free. |
| D2 | **Precommit is merged, not per-module: one full run per verify round.** | Module-level churn never triggers a precommit. It cannot be "one run for the whole requirement": a precommit PASS is bound to the worktree fingerprint (`lib/gate-state.ts`), so every remediation invalidates it and the next round must re-run it. |
| D3 | **Review is sharded and parallel, then integrated.** N module reviewers (one per worklog) run concurrently, read-only; a single integration reviewer then judges the whole change. | Each module is genuinely reviewed against its own `must_haves` instead of drowning in one giant diff, and the seams still get a global read. |
| D4 | **The planner is short-lived, not long-running.** It answers "what is the next step" from the plan state and exits. | The "planner runs out of context and must hand off" problem disappears: every planner turn is already a cold start from disk. Handoff is a property, not a mechanism. |
| D5 | **The main session is a thin driver that may still think.** It spawns, collects one-line results, merges verdicts, runs the gate, ships. | It never reads diffs or source files. Detail lives in worklogs. Its one unavoidable bulk intake is the reviewers' raw output at verify time (§5.3). |
| D6 | **Authoritative state is machine-readable; the human view is rendered.** | `state.json` is the source of truth; `PLAN.md` and `/plan-status` are projections of it and are never parsed back. |
| D7 | **Escalate silently, interrupt rarely.** Auto-retry with model/thinking escalation; ask the human only after a module accumulates **more than 8** BLOCKED rounds, on a plan-level error, or on an explicit worker request. | Repeated BLOCKED is normal in this repo; interrupting at 2 would make the tool unusable. |

Ruled out for this iteration (see §11): parallel execution, worktree isolation,
TUI dashboards, run GC, cross-session memory, cost budgeting.

## 3. Roles

| Role | Lifetime | Tools | Reads | Writes |
|---|---|---|---|---|
| **main session** (driver) | whole run | spawn, gate tools, git | `state.json`; reviewer output at verify time | `state.json` transitions, the worklog `## Review` sections |
| **planner** | one question, then exits | read, grep, find, ls, write | `PLAN.md` (the rendered view), `.pi/loop-goal.md`, the requirement brief | `state.json`, the task brief of the module it dispatches |
| **worker** | one module (or one remediation) | read, grep, find, ls, bash, edit, write | its own task brief + the code it owns | source files inside `owned_paths`, its own worklog |
| **module reviewer** | one module, read-only | read, grep, find, ls, bash | `worklog/M-xx.md`, the module diff, its `must_haves` | nothing (returns a verdict) |
| **integration reviewer** | once per verify round, read-only | read, grep, find, ls, bash | `PLAN.md`, `.pi/loop-goal.md`, the whole diff, cross-module seams | nothing (returns a verdict) |

The integration reviewer is the repo's existing `agents/reviewer.md`, briefed
with the seam checklist of §5.3; the three roles above it are defined in
`agents/planner.md`, `agents/worker.md` and `agents/module-reviewer.md`.

The worker is the only role that writes source code, and only one worker runs at
a time. That is the whole concurrency model.

### Why the planner does not spawn workers

`pi-subagents` allows nesting (main → planner → worker) when the child's
frontmatter grants the `subagent` tool. We deliberately do not use it: the gate
tools (`record_review`, `run_precommit`, `declare_done`) and the ship commands
bind to the **main session plus this repo's worktree**, so the main session can
never fully leave the loop. Putting the dispatch loop one level down would make
failures a black box while buying nothing. The planner decides; the main session
dispatches.

## 4. State model

Everything lives under `.pi/plan/`, which is git-ignored alongside the other
per-run gate artifacts. `.pi/` is already excluded from the worktree
fingerprint (`lib/fingerprint.ts`), which is what makes it safe for the main
session to append to a worklog between review rounds without invalidating a
bound verdict.

```
.pi/plan/
  state.json        authoritative machine-readable state (lib/plan-state.ts)
  PLAN.md           rendered human view — generated, never parsed back
  brief.md          the requirement text, verbatim, written once
  worklog/M-01.md   one audit-trail shard per module
```

### 4.1 `state.json` — the authoritative index

The source of truth is JSON, not YAML frontmatter. The gate takes no npm
dependencies, so a YAML source of truth would mean hand-rolling a YAML subset
parser and then trusting the run's only durable record to it; `JSON.parse` is
in the platform and cannot silently misread a document. `PLAN.md` is rendered
from this state for humans and is never read back — which is also what keeps
D6 honest: one machine-readable truth, one projection.

```json
{
  "schema": 1,
  "requirement": "one-line intent of the whole requirement",
  "brief": "brief.md",
  "created": "2026-08-12",
  "status": "drafting | approved | executing | verifying | done | blocked",
  "cursor": "M-03",
  "verify_round": 0,
  "integration_blocked_rounds": 0,
  "modules": [
    {
      "id": "M-01",
      "title": "short imperative title",
      "intent": "one paragraph: what this module must achieve",
      "owned_paths": ["lib/plan-state.ts", "test/plan-state.test.ts"],
      "depends_on": [],
      "must_haves": [
        {
          "id": "mh-1",
          "kind": "artifact | behavior | test | doc",
          "statement": "lib/plan-state.ts exports parsePlanState and writePlanState",
          "risk": "low | normal | high"
        }
      ],
      "model": "claude-sonnet-5",
      "thinking": "low | medium | high | max",
      "risk": "low | normal | high",
      "est_context_tokens": 80000,
      "status": "pending | running | implemented | reviewing | blocked | accepted",
      "blocked_rounds": 0,
      "worklog": "worklog/M-01.md",
      "result": "one line, written whenever the module changes status",
      "seam": "true only on a seam module created during a verify round (omitted otherwise)"
    }
  ]
}
```

#### Field rules

- `owned_paths` is a declaration, not an enforcement (D1 removed the need for
  enforcement). It is still required: it is what the module reviewer uses to
  scope its diff, and what the post-module check compares against
  `git diff --name-only` to surface scope drift as a review input.
- `must_haves` are the module's acceptance criteria. A module reviewer's verdict
  is rendered criterion by criterion against this list — the same discipline the
  repo-level reviewer applies to the loop goal.
- `est_context_tokens` is advisory. "About 100k of context" is not an executable
  split criterion; the executable ones are **disjoint `owned_paths`** (across
  plan-time modules; seam modules created during a verify round are exempt, see
  §5.3) and a
  **`depends_on` DAG without cycles**. The estimate exists to catch a module
  that is obviously too big, and `/decompose` warns above ~120k.
- `blocked_rounds` is **cumulative for that module across all verify rounds**,
  not a consecutive streak: an oscillating module must not be able to reset its
  own escalation by passing once. It resets only when the module reaches
  `accepted` (§5.3 step 3, Phase B READY). The loop goal phrases the threshold
  as "consecutive"; cumulative is the stricter reading and is chosen
  deliberately, because a module that alternates BLOCKED/READY is exactly the
  case a human should look at.
- `integration_blocked_rounds` is the run-level bound on verify rounds. It
  increments once for any aborted round that created a seam module, and always
  when Phase B returned BLOCKED. The charging rules are defined once, in §5.3
  ("Assignment and charging"); it never resets during a run.

#### State transitions

Plan `status` — every transition has exactly one producer:

| From | To | Produced by |
|---|---|---|
| — | `drafting` | `/decompose` starts |
| `drafting` | `approved` | the user approves the module table |
| `approved` / `blocked` | `executing` | the first `/plan-next` of a run |
| `executing` | `verifying` | the planner reports "all modules implemented" |
| `verifying` | `executing` | a verify round aborts (precommit FAIL, Phase A BLOCKED or Phase B BLOCKED) and hands remediation back to `/plan-next` |
| `verifying` | `done` | the integration review is READY and `declare_done` succeeds |
| any | `blocked` | escalation stops the run for a human (D7) |

Module `status` — every transition is written by a numbered step of §5.3 or by
`/plan-next`:

| From | To | Produced by |
|---|---|---|
| — | `pending` | `/decompose` (or the planner creating a seam module `M-INT-<n>`) |
| `pending` | `running` | `/plan-next` dispatches the worker |
| `running` | `implemented` | the worker finishes and writes its self-check |
| `implemented` | `reviewing` | §5.3 step 0, at the start of a verify round |
| `reviewing` | `blocked` | any §5.3 step whose assignment gives this module a finding — step 1 (a failing precommit check), step 2 (a shard finding) or step 3 (an integration finding) |
| `reviewing` | `implemented` | the ABORT rule of §5.3, for every module not charged with that round's failure |
| `reviewing` | `accepted` | §5.3 step 3, Phase B READY — the only producer of `accepted` |
| `running` | `blocked` | the worker failed its own self-check after two resume attempts, or stalled past its budget (§7) |
| `blocked` | `running` | `/plan-next` dispatches its worker again |

#### Malformed state is fail-closed

If `state.json` is missing, does not parse, `schema` is not `1`, a
`depends_on` edge points at an unknown module, or the `depends_on` graph has a
cycle, or two plan-time modules declare overlapping `owned_paths` (seam modules
are exempt, §5.3), every command except `/decompose` refuses to act and reports the exact
defect. A partially written state must never be silently "repaired" by
guessing — the run stops and the user decides. Writes are atomic (write to a
temp file in the same directory, then rename) so a crash mid-write leaves the
previous valid state intact.

### 4.2 `worklog/M-xx.md` — the per-module trace

One file per module, appended to over the module's life. It is the task brief,
the execution record, and the review record in one place — the audit trail the
whole design hangs on:

```markdown
# M-03 — <title>

## Task brief            (planner writes it when it dispatches this module)
Intent, owned_paths, depends_on, must_haves, constraints, pointers to the
existing code the worker should read first.

## Execution log         (worker appends, while working)
What it did, in order. Decisions taken and why. Anything surprising.

## Changed files         (worker writes on completion)
The real `git diff --name-only` set, plus an explicit note on any path outside
`owned_paths`.

## Self-check            (worker writes on completion)
Each must_have, marked pass/fail with the evidence that proves it.

## Review                (main session appends, per round)
Round N: the module reviewer's raw verdict, then the remediation applied and by
which worker.
```

The task brief is written by the planner **inside the `/plan-next` step that
dispatches the module**, not at `/decompose` time. This matters: writing all
briefs up front would either require the planner to hold the whole requirement
in context (the failure this design exists to prevent) or produce briefs that
are stale by the time earlier modules have changed the code they describe.

Why the index/shard split rather than one big document: the planner cold-starts
from the plan state on every single step, so it must stay a few KB forever;
the reviewer needs everything about its module, so the shard may grow freely.
One combined file would make the planner unusable within a few modules — which
is the exact failure this design exists to prevent.

## 5. The execution loop

### 5.0 Getting here at all

The expensive failure is not a bad decomposition; it is never decomposing. A
requirement too big for one session does not announce itself — it degrades, and
by the time that is obvious the cheap moment to split has passed. So the gate
judges the size itself, at two checkpoints where it costs nothing:

- **the first user message**, classified alongside the gate-mode decision (one
  model call, issued in parallel with it, so there is no extra stall);
- **the moment an approved loop goal exists**, where the exit-criteria count is
  a far better signal than any prose.

Thresholds (`lib/requirement-size.ts`), any one of which is enough — they
measure different dimensions and being big in one is reason enough to split:

| Signal | Fires at | Depends on the model? |
|---|---|---|
| exit criteria in the approved loop goal | ≥ 5 | no |
| top-level directories the requirement names | ≥ 3 | no |
| estimated modules of work | ≥ 3 | yes |

What happens then is a **suggestion, not an action**: the gate injects a
directive requiring the agent to open its next reply by proposing `/decompose`
— with the evidence that fired — and then stop. The user answers in one word.
Judgement is the gate's; the decision is the user's, so a false positive costs
a sentence rather than a workflow.

The suggestion is **not the only entry**. The main agent may **initiate**
`/decompose` itself whenever it detects a complex task — a requirement too big
for one session, or scope growing complex mid-task — with the same rule as an
invariant: **initiating is a request, not an action; the user's explicit
consent must precede any decompose step** (no brief write, no planner spawn
before it). The consent to initiate (§5.1) and the table approval are two
separate confirmations asking two different questions: "is this worth
splitting?" and "is this split the right one?". A user who says "this is
getting too big, split it" has consented by asking; an agent whose initiation
was declined carries on and does not re-raise it.

Three rules keep it from becoming noise:

- **At most one evidence-backed suggestion per session.** There is no button
  for the user to press "no" with, so a decline is invisible to the gate — but
  a user who saw the suggestion and went on to negotiate a loop goal has
  already answered. Suggesting once is the honest reading of "never ask twice".
- **A degraded signal says so, on its own budget.** If the classifier times out
  or is unavailable, the structural rules still run and the injected text is
  explicitly labelled as degraded — never dressed up as a judgement the gate
  made. When nothing measurable fired at all it still says so once, because
  silence and "nothing to report" look identical to the user. That notice is
  tracked separately: an evidence-free "the classifier is down" line must not
  consume the session's one real ask, or an offline session could never be told
  that its just-approved goal has six exit criteria.
- **"Never consulted" is not "unavailable".** A session that set its mode
  explicitly, or ran headless, never asks the model at all; that is reported as
  a plain structural verdict, not a degraded one. Inventing a failure that did
  not happen is the same dishonesty the labelling exists to prevent.

### 5.1 Decompose

```
/decompose <requirement>            (user-typed, or agent-initiated)
   → AGENT-INITIATED ENTRY: the main agent may start decompose whenever it
     detects a complex task (mid-task included, §5.0). It must FIRST present
     the evidence (signals that fired + its module-count estimate) and wait
     for the user's EXPLICIT consent — no brief write, no planner spawn
     before consent.
   → the requirement text is stored verbatim as brief.md
   → planner (cold) reads the brief + repo, proposes the module table
   → main session shows the table ONCE for the user to edit and approve
   → state.json written (and PLAN.md rendered), status: approved
```

### 5.2 Implement, one module at a time

```
repeat until the planner reports "all modules implemented":
   /plan-next
     → planner (cold) reads the plan → writes the next module's task brief and
       returns ONE instruction:
       "run M-03" | "replan: <reason>" | "all modules implemented"
     → main session spawns the worker for that module with its task brief
     → worker implements, self-checks its must_haves, writes the worklog
     → main session records status + a one-line result in state.json
```

Exactly one worker runs at a time, including during remediation. Nothing else
writes to the worktree while a worker is running.

### 5.3 Verify (one round; repeats until READY)

```
/plan-verify                          [plan status: verifying; verify_round++]

  0. every module with status implemented → reviewing

  1. run_precommit(mode=full)                  — one merged run for the round
     FAIL → every failing check is a finding; assign and charge it by the rules
            below; ABORT the round

  2. Phase A — sharded module review, parallel, read-only:
       one reviewer per module, each judging ONLY its own must_haves, worklog
       and owned_paths diff; every Phase A fence OMITS docSync (§6.3)
     → concatenate every reviewer's FULL raw output → record_review
       (the gate parses every JSON fence and the worst verdict wins, so the
        verdict dimension needs no new merging logic)
     → BLOCKED: assign and charge every finding by the rules below — a shard
       finding whose fix needs a shared file still gets a seam module rather
       than being forced onto its own module; ABORT the round
     → READY:   the modules stay reviewing (nothing is accepted yet)

  3. Phase B — integration review, single L3 reviewer, whole change:
       cross-module seams, duplicated abstractions, interfaces implemented two
       different ways, plus the loop goal criterion by criterion, plus the ONE
       docSync attestation for the change
     → its raw output is the ONLY content of this record_review call
     → BLOCKED: assign and charge every finding by the rules below (a Phase B
       BLOCKED always charges the run-level counter); ABORT the round
     → READY:   every reviewing module → accepted (blocked_rounds reset),
                plan → done, declare_done → ship

ABORT the round (identical on every failure path):
  a. every module NOT charged with this round's failure rolls back
     reviewing → implemented
  b. plan → executing, /plan-verify returns
Remediation is NOT inlined: it runs through §5.2's /plan-next loop, which is the
only dispatcher of workers, so every fix reuses the same serial single-writer
path. When every module is `implemented` again, /plan-verify starts a NEW round
at step 0 — that is what returns the repaired modules to `reviewing`. Nothing
from the aborted round survives: the fingerprint has moved, so its precommit
PASS and its verdicts are void.
```

Phase A and Phase B are two separate `record_review` calls, so each verify round
consumes two of the gate's rounds (default cap 10). That is the price of getting
per-module verdicts into the ledger; §6.3 explains why they cannot be one call.

A module is `accepted` only when Phase B is READY in the same round — a module
reviewer's READY alone never accepts anything, because the seam review can still
send that module back. This is also why `blocked_rounds` can only reset there.

#### Assignment and charging (how any verify failure gets an owner and a bound)

This subsection is the single definition of both. Every failure in a verify
round — a failing precommit check (step 1), a Phase A shard finding (step 2) or
a Phase B integration finding (step 3) — is assigned by the planner to exactly
one of:

1. **An existing module**, when every path the fix touches is inside that one
   module's `owned_paths`. That module → `blocked`, `blocked_rounds++`, and its
   own worker remediates.
2. **A new seam module `M-INT-<n>`**, in every other case: the fix touches paths
   owned by *more than one* module, or owned by *no* module, or there is no
   path to blame at all. It is an ordinary module in every respect —
   `owned_paths` (the exact files the fix needs, empty-then-discovered when the
   failure is environmental), `must_haves` (the finding restated as acceptance
   criteria), its own worklog, its own `blocked_rounds` — created with status
   `pending`, `seam: true`, and `depends_on` listing every module it overlaps.
   When a round
   creates several seam modules, `cursor` points at the first of them; the rest
   are ordinary `pending` modules that `/plan-next` picks up in `depends_on`
   order like any other.

A module carrying `seam: true` is the **only** case where `owned_paths` may overlap another
module's. That is safe because execution is serial (D1): the overlap is a
statement about ownership for review scoping, never about concurrent access.
The `/decompose` disjointness rule (§4.1) therefore applies to plan-time modules
only, and the malformed-state validation enforces it with that exemption. The
exemption keys on the explicit `seam` field, not on the `M-INT-` naming
convention — an id prefix is a habit, and a plan-time module accidentally named
like a seam must not slip past the rule in silence. A finding is never split
across two remediations: one finding, one owner.

**Charging.** A round that aborts always increments at least one counter:

- Every finding assigned to an existing module increments that module's
  `blocked_rounds` (once per round, however many of its findings there are).
- `integration_blocked_rounds` increments once for the round when **any** of
  the round's findings did not land on a single existing module — i.e. the
  round created a seam module — and always when Phase B returned BLOCKED,
  whatever the assignment turned out to be.

Both counters may increment in the same round; they bound different things (one
module's stubbornness versus the run's total verify attempts). Because every
aborted round increments something, and both counters stop the run above 8
(§7), no failure path can loop forever.

### 5.4 What the main session carries

Per implement step it ingests: the module id, the worker's one-line result, and
the worklog path. It does not read the diff, the source, or the worker
transcript.

Per verify round it must ingest the **full raw output of every reviewer** —
`record_review` requires the complete reviewer text, and the gate tools bind to
the main session, so this cannot be delegated. With N modules that is N+1 raw
reviews per round, accumulating across rounds. This is the design's real upper
bound on main-session context, and it is why the module count should stay
moderate (roughly ≤ 12) and why `/plan-status` never re-prints past reviews.

Resume after a crash is not a separate feature: the state is on disk, so
`/plan-next` (or `/plan-verify`) simply continues.

## 6. Gate binding

The existing gate is not modified. This design binds to it as a client.

### 6.1 Precommit

`run_precommit(mode=full)` runs once per verify round, over the integrated
worktree — never per module. A PASS is bound to the worktree fingerprint, so any
remediation voids it and the next round re-runs it. "One precommit" means one
merged run instead of N per-module runs; it does not and cannot mean one run for
the whole requirement.

### 6.2 Verdicts

Module reviewers and the integration reviewer are read-only, so they cannot
invalidate each other or the precommit while they run. `lib/verdict-parse.ts`
already parses every JSON fence and keeps the worst verdict, accumulating
findings across equal-severity fences — sharded review therefore needs no change
to the parser for the verdict dimension.

Verdict power stays L3: module reviewers and the integration reviewer run on the
L3 tier per `docs/parallel-execution-plan.md` §2; workers are L2; the planner is
L2 with high thinking (it decides sequencing, not correctness). Module
acceptance is an input to `record_review`, never a substitute for it.

### 6.3 The docSync protocol (why review is two-phase)

`lib/verdict-parse.ts` merges equal-severity fences with
`a.docSync === b.docSync ? a.docSync : undefined`, and an absent attestation
fails closed under docSync enforcement (`lib/gate-state.ts`, default ON). So if
N module reviewers and the integration reviewer all emitted fences into one
`record_review` call, a single divergent or missing `docSync` would erase the
attestation and the first all-READY round would deadlock — and §10 forbids
"fixing" this in the parser.

Hence the protocol:

- **Phase A fences omit `docSync` entirely.** A module reviewer sees one shard
  and has no basis to attest that the whole change's code↔doc relationship is
  sound. A Phase A record can therefore never unlock ship, by construction —
  that is intended, not a bug.
- **Phase B is recorded alone.** The integration reviewer's output is the only
  content of its `record_review` call, so its `docSync` value survives merging
  intact and is the single attestation for the change.
- Because no file changes between a clean Phase A and Phase B, both records bind
  to the same fingerprint and Phase B's verdict is the one that governs.

The guarantee only holds if module reviewers actually omit the field, so PR2
must write the prohibition into the module-reviewer role definition itself, not
leave it to the per-run task text — with a single module there is no merge step
to neutralise a stray attestation.

### 6.4 The loop goal still governs

The requirement itself is the loop goal; module `must_haves` are its exit
criteria expanded one level down. The integration reviewer accepts against the
loop goal, criterion by criterion, exactly as today.

## 7. Failure handling

| Situation | Response |
|---|---|
| Worker's self-check fails a `must_have` | Resume the same worker session with the failing criterion, twice at most. If it still fails, the module → `blocked` and `blocked_rounds++`; `/plan-next` dispatches it again under the §7 escalation ladder. |
| Precommit FAILs in a verify round | Each failing check is a finding, assigned and charged by §5.3 like any other. A check with no path to blame at all becomes a seam module carrying that check as its `must_have`, so even an environmental failure has an owner. |
| Module reviewer returns BLOCKED | The round aborts and each finding is assigned and charged by §5.3 — usually to the reviewed module itself, but to a seam module when the fix reaches outside its `owned_paths`. The owner's worker (a fresh session seeded with its task brief, the finding, and its worklog) applies the fix on the next `/plan-next`, one worker at a time; `/plan-verify` then starts a fresh round from step 0. |
| Integration reviewer returns BLOCKED | The round aborts and always charges `integration_blocked_rounds`. Every finding gets exactly one owner per §5.3: an existing module when the fix stays inside that one module's `owned_paths`, otherwise a new seam module `M-INT-<n>`. Seam modules are dispatched, implemented and reviewed like any other module, so no fix escapes the ownership model. |
| `blocked_rounds` reaches 3 | Escalate: raise the module's `thinking`, then its `model` tier, on subsequent rounds. |
| `blocked_rounds` exceeds **8** for any module, or `integration_blocked_rounds` exceeds **8** | Stop and ask the human (D7); plan `status: blocked`. Every failure row in this table either charges one of these two counters (§5.3, "Assignment and charging") or stops the run outright, so no failure mode can loop forever. |
| Worker reports it must change files outside `owned_paths`, or that the plan is wrong | Stop the loop immediately, run the planner in `replan` mode, and get the user's approval for the amended module table before continuing. Silent cross-module edits are the one thing serial execution cannot recover from. |
| Worker stalls or runs away | Bound it with `pi-subagents`' `turnBudget`/`toolBudget`, and have the main session treat a run with no completion inside its budget as failed: interrupt it, module → `blocked` with `blocked_rounds++` (so repeated stalls escalate and eventually reach the human like any other failure), and keep the worklog. Note that `pi-subagents`' watchdog is an opt-in end-of-run change reviewer, **not** a stall detector, and a single hung tool call is outside any turn budget — so the main session's own timeout is the real backstop. |

## 8. Commands

All commands are prompt-injecting workflow commands registered in
`lib/workflow-commands.ts`, consistent with the existing `/review`,
`/precommit`, `/gate-init` surface. None of them can ship.

| Command | Effect |
|---|---|
| `/decompose [requirement or path]` | Store the requirement as `brief.md`; a cold planner proposes the module table; the main session presents it **once** for approval; writes `.pi/plan/state.json` and renders `PLAN.md`. Also the agent-initiated entry: the main agent may start it when it detects a complex task (mid-task included), but only after the user's **explicit consent to the initiation** — a separate confirmation from the table approval (§5.0/§5.1). |
| `/plan-next` | One step of §5.2: the cold planner writes the next task brief and returns one instruction, the main session dispatches one worker and records the result. |
| `/plan-status` | Render the plan state as a progress table. Read-only, and never re-prints past review text. |
| `/plan-verify` | One verify round per §5.3: merged precommit, Phase A sharded review, Phase B integration review. Any failure aborts the round, returns the plan to `executing`, and hands remediation back to `/plan-next`; it never dispatches a worker itself. |

Negotiation happens exactly once, at `/decompose`, over the whole table (module
id / title / owned_paths / depends_on / must_haves / model / thinking / risk).
Per-module interrogation is rejected on purpose: it would spend the main
session's context on the same conversation N times.

These commands require `pi-subagents` to be installed and its `subagent` tool
available. It is not an npm dependency of this repo (§10), but it is a hard
functional prerequisite: if the tool is absent, the commands must fail fast with
an explicit message naming the missing capability rather than silently
degrading into the main session doing the work itself.

## 9. What we take from the ecosystem

Nothing here is invented where something proven exists. This design is a thin
orchestration + gate-binding layer over `pi-subagents`, with the methodology
borrowed from the projects below. Claims about `pi-subagents` were verified
against the installed copy; the other rows are attributions of ideas we adapted,
not statements we depend on.

| Source | What we keep | Where it lands |
|---|---|---|
| **pi-subagents** (installed) | async spawn without worktrees, `status`/`resume`/`steer`, acceptance ledger, `turnBudget`/`toolBudget`, intercom escalation, clarify TUI, recursion guard | The execution substrate (§3, §7) |
| **pi-gsd** | phase → plan → atomic task layering; `depends_on` / `files_modified` / `must_haves` contract; verification against reality rather than the executor's claim; on-disk state and resume | §4 state model, §5 loop, §7 self-check-vs-reality |
| **pi-conductor** | "you are not the implementer" overseer prompt with a banned-tool list; filtered context inheritance; handoff documents; failure classification with escalating retry | §3 main-session contract, §7 escalation ladder |
| **pi-agent-orchestrator** | machine-readable structured handoff; permission inheritance (a child may not silently regain a scope its parent removed); depth limits | §4.1 `state.json` as the handoff format, §3 role tool tables |
| **pi-roadmap / stepstone / ank** | a persistent, structured task store that survives sessions | `state.json` as the cross-session source of truth |
| **billion-context-pi / pi-context-prune** | model-driven compression, tool-output pruning | Deferred (§11); the index/shard split already bounds the planner's context by construction |

Deliberately not adopted: their shipping paths (`/gsd-ship`, autonomous modes,
`gh pr create` wrappers). Those bypass the fail-closed binding this repo exists
to enforce.

## 10. Boundaries (never cross)

- Binding, fail-closed, fingerprint, verdict/docSync parsing and receipt
  validation: **zero changes**, per `docs/parallel-execution-plan.md` §6. §6.3
  exists precisely because the protocol had to bend around the parser instead of
  bending the parser.
- No verdict may be recorded by anything but an L3 reviewer through
  `record_review`.
- One writer at a time in this worktree — that is what makes D1/D2 safe.
- **No new npm dependencies.** `pi-subagents` is a runtime prerequisite of these
  four commands (§8), not a package this repo installs or vendors; nothing else
  in the gate depends on it.
- `.pi/plan/` is run state, not source: git-ignored from PR2 on, and evidence for
  the reviewers during the run rather than repository history.

## 11. Open items to validate during PR2

1. Whether a subagent child process loads this extension at all, and if so
   whether its gate state interferes with the child's work. The design assumes
   it does not matter because only the main session calls gate tools — but the
   worker must not be derailed by a loop-goal negotiation prompt inside its own
   session. If it is, workers get an explicit "ignore gate negotiation" clause.
2. Whether concatenated Phase A output stays within `record_review`'s practical
   input size for a large run, and whether per-shard truncation (keeping each
   fence intact) is needed.
3. Whether the cold planner reliably produces a single actionable instruction
   from the plan state alone, or needs the previous module's `result` line
   inlined.
4. Whether two `record_review` calls per verify round exhaust the default round
   cap too quickly on a large plan, and whether the cap needs to scale with the
   module count.
5. Whether the structural `READY (Phase A) → BLOCKED (Phase B)` flip trips the
   gate's oscillation detection (3 flips) earlier than D7's threshold. It only
   tightens — it advises escalation, never releases a ship — but the interaction
   should be measured on a real run before deciding whether the two-phase split
   needs a different signal.

## 12. Delivery

- **PR1** — this document.
- **PR2** (shipped) — MVP:
  - `lib/plan-state.ts`: the §4.1 schema with fail-closed validation, atomic
    writes, the `PLAN.md` projection, the charging rule and dispatch selection;
  - `lib/workflow-commands.ts`: `/decompose`, `/plan-next`, `/plan-status`,
    `/plan-verify`;
  - `agents/planner.md`, `agents/worker.md`, `agents/module-reviewer.md` (the
    integration reviewer reuses `agents/reviewer.md`), with the §6.3 docSync
    prohibition hard-coded into the module-reviewer definition;
  - the serial loop and the two-phase verdict protocol in
    `skills/review-loop/SKILL.md`;
  - tests for the state model, the malformed-state refusals, the module-status
    transitions (including seam-module creation and the `reviewing` →
    `implemented` rollback), the charging bound, and the role definitions.

The design intentionally stays ahead of the MVP in one place: it describes the
behaviour a driver must follow, while the commands inject that behaviour as
prompts rather than executing it in code. The state module is the part that is
mechanically enforced — which is why validation, charging and dispatch live
there and not in a prompt.
