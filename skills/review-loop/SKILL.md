---
name: review-loop
description: Run the pi-review-gate quality loop — independent review, record verdict, fix, precommit, declare done. Use after completing code changes when the user wants review-until-confident before commit/PR.
---

# Review Loop

Drive changes through the review gate until every gate passes. The gate is
enforced by the pi-review-gate extension: `git commit`, `git push`, and
`gh pr create` are hard-blocked until the loop completes.

## Two independent judges, on a stronger model than you

Good judgement comes from a *stronger, independent* brain than the one that
wrote the code. Both roles are pinned to a top-tier reasoning model at `max`
thinking, with a fallback priority list (first available wins):

- **`adviser`** (`agents/adviser.md`, consultant, *before/during* work) —
  you should **proactively consult** it whenever a decision is non-trivial,
  ambiguous, risky, or you feel stuck. It does not gate; it advises on
  direction. Consulting early is cheaper than a failed review later.
  Model priority: Fable 5 → Opus 5 → opencode-go/flash (see the pinned
  chains in agents/*.md).
- **`reviewer`** (`agents/reviewer.md`, gatekeeper, *after* a diff exists) —
  independent audit that emits the JSON verdict the gate records.
  Model priority: Fable 5 → Opus 5 → opencode-go/flash (see the pinned
  chains in agents/*.md).

`thinking: max` in the built-in agent frontmatter is the default-chain
setting. When model-chain configuration is enabled, each configured slot may
carry its own `:thinking` suffix; the renderer validates and preserves
those suffixes per slot. The default-chain value is not a fallback list.

**Default two-reviewer final pass (cross-family).** The review that ends a
round runs **two reviewers by default**, from **different model families**:
`claude-fable-5` (anthropic) as reviewer A and the best available
different-family model as reviewer B (e.g. `onekey/gpt-5.6-sol` once onekey
is configured; without a second family, a single reviewer is the accepted
fallback — declared in a Note), both at `max` thinking — so the two audits
do not share the main agent's blind spots. If a model is unavailable, fall
down the pinned chains (see the tables above), keeping the two families
distinct. Record BOTH
full
outputs via `record_review` (worst verdict wins; the gate's fail-closed
semantics are unchanged). Pick the second reviewer with `rankJudges` from
`lib/model-ranking.ts` when a choice exists; a single reviewer is the
acceptable fallback only when a different-family model is genuinely
unavailable, and that fact goes in a Note.

**Never spawn two reviewers of the SAME family.** The count is not yours to
guess: the gate computes it from this host's real model registry
(`planFanoutFromFacts`, `lib/review-fanout.ts`) and injects the decision into
both the `/review` prompt and the auto-continuation resume text — two
judge-eligible families ⇒ spawn two, one per family; one family ⇒ spawn ONE
and copy the plan's note into the recorded review. A second same-family
reviewer doubles the cost while sharing the first one's blind spots, and
calling that a cross-family double review would be false. Scope: this governs
the reviewers YOU spawn for a small diff plus the integration reviewer; for a
large diff the shard count comes from `prepare_review`'s plan
(`planReviewShards`), not from this rule.

Why these models? `lib/model-ranking.ts` scores model families from public
capability leaderboards (Artificial Analysis Intelligence Index, LMArena Elo,
LiveBench) and can rank candidates by capability, optionally rewarding
cross-family diversity so a judge doesn't share the main agent's blind spots.
It is a **reference for choosing the pinned models**, not a runtime selector —
the chains above are the built-in defaults in the agent definitions, and the
`agents` config layer (see the **Model tiers** section) can
override them per agent. Refresh the underlying
scores with `node scripts/fetch-leaderboard.mjs` (opt-in, network).

## The loop goal — the exit contract

The gates say the code is *sound*; they say nothing about whether the user's
goal was *met*. The loop goal closes that hole: one short file, written before
the work starts, listing the checkable facts that mean **done**. The same file
then drives all three roles — you slice work against it, `adviser` advises
against it, `reviewer` accepts against it.

**Negotiated, not assumed (L8)**: you do NOT write this file. Grill the user
first — unless they asked for them all at once, ask ONE question per turn,
labeled "N of M", give your own recommended answer, wait for the reply, repeat
until nothing is silently assumed — then call **`propose_loop_goal`** with what they
agreed to. The extension shows it in a confirm dialog and, on approval, writes
the file itself and records the hash of that exact text. In loop mode an
unapproved goal **blocks commit/push/PR** and its body is withheld from your
prompt (a leftover goal from a previous task is exactly what that prevents).
Editing the file afterwards drops the approval — renegotiate and re-submit.

**Pre-review the draft goal (adviser pre-review, merged rule).** Before you
submit a goal for approval, run the draft through ONE independent **`adviser`**
review — the goal pre-review rule merged into AGENTS.md's cross-review
protocol (one rule, adviser is authoritative, not two parallel ones). "Pass" means
the adviser records **no unresolved P1**. The adviser critiques the draft
against: (a) is every criterion checkable by a command or concrete observation,
(b) is the scope sized to the change, (c) do non-goals actually fence off the
edges, (d) does it match what the user asked. If the adviser raises P1-level
objections, fix the draft and re-review before calling `propose_loop_goal` —
never submit a goal you know is uncheckable. This is protocol, not a gate: the
extension does not enforce it, but the `reviewer` WILL flag a goal whose
criteria cannot be judged objectively (P2) and an uncheckable criterion that
made the work go astray (P1).

**Every re-review carries the previous round's conclusion.** A re-review that
starts from zero pays full price for questions that were already answered, so
hand the reviewer what is already settled and let it spend its budget on what
changed:

- **Goal re-review (adviser).** When you revise a draft after BLOCKED
  objections, the second consultation gets three things: the previous draft,
  the adviser's own objection list, and what you changed for each one. Ask it
  to verify exactly that — is each objection resolved, and does the new wording
  introduce a side effect — not to re-derive the whole goal.
- **Round N+1 (reviewer).** Hand over the previous round's verdict and its
  findings. The gate already injects this as the `Review scope for this round`
  block: what a previous READY verdict settled, what is new since, and which
  findings must be re-checked one by one. Pass that block through to the
  reviewer verbatim.
- **What "settled" buys**: settled-and-unchanged material gets a consistency
  scan, not a re-derivation. It never narrows what the reviewer MAY look at,
  never weakens its authority, and it may always reopen a settled conclusion
  when it has evidence the conclusion was wrong.

**Where**: `.pi/loop-goal.md`. That path sits inside the gate-owned `.pi/`
scope (`GATE_EXCLUDE_PATHSPECS` / `isGateOwnedPath`, `lib/fingerprint.ts`),
which both halves of the gate honour: it is excluded from the fingerprint and
skipped by edit tracking. Writing or rewriting the goal therefore never changes
the worktree digest, never arms the doc gate, and can never invalidate a READY
review or a precommit PASS.

**How to produce it** — interview the user, then submit it with
`propose_loop_goal`; sized to the change, a one-line bugfix deserves one
criterion and three lines:

- *Preferred, when the user has the engineering skills installed*: `/to-spec`
  (synthesize the conversation into a spec), `/grilling` or `/grill-me`
  (sharpen it until no question remains), `/to-tickets` (slice it into
  tracer-bullet vertical slices), `/wayfinder` (an effort too big for one
  session). These are `disable-model-invocation: true` and may assume a
  configured issue tracker — they are **user-invoked accelerators**: propose
  the one that fits and let the user run it, never claim to have run one.
- *Fallback, always available*: answer three questions inline — (1) which
  observable facts prove this task is done, (2) how each one is verified (a
  command or a concrete observation), (3) what is explicitly out of scope.

**Shape**: task title · one-line intent · 3–7 checkable exit criteria ·
non-goals · ISO date. A criterion must be judgeable by a command or a concrete
observation — "code quality is good" is not a criterion, "`node --test` passes
and `lib/x.ts` no longer reads the sidecar" is.

**Staleness**: a goal file older than 24h may be left over from a previous
session. The gate flags it in the prompt; confirm it against what the user is
asking for now, and renegotiate it (grill → `propose_loop_goal`) if it no
longer matches.

**Slicing the work to subagents**: turn each criterion (or vertical slice) into
a subagent task and hand the goal file to every subagent you spawn.

### Parallel exploration — read-only subagents run concurrently

Read-only subagents (recon, code reading, analysis, `adviser`) are inherently
parallel-safe: they never write to the worktree, so they cannot invalidate a
binding or race with each other. When you need to explore several areas of the
codebase, spawn them in parallel — each reads its own files and returns
findings; you merge the results. Exploration and editing may also overlap:
while a read-only subagent surveys the code, you can concurrently edit a
different file (the single-writer invariant still holds — only YOU write).

### Serial writers — exactly one writer in the worktree

Write-capable subagents run **serially in this worktree**: their edits change
the worktree like any other, so a review recorded before them can no longer
ship (the fingerprint moved), and concurrent writers would keep invalidating
the binding between precommit and review. Read-only subagents (recon, analysis,
`adviser`) may run in parallel. You stay the single writer of record: you run
precommit, you run the review, you fix findings — never delegate the gate
itself.

**What the goal DOES gate.** In loop mode, shipping (`git commit` / `git push`
/ `gh pr`) is blocked until the user has approved the goal through
`propose_loop_goal` — negotiating the contract after the code is pushed would
be theatre. What it does NOT gate: the git hooks and the verdict logic stay
blind to it (an approval is a dialog fact a hook can never see), and the goal
file's mere existence proves nothing — only the recorded approval of its exact
text does. Beyond that, the goal binds through the reviewer: an unmet criterion
is a P1 finding, and any P0/P1 ⇒ BLOCKED.

## Protocol

0. **Goal first (loop mode)** — establish `.pi/loop-goal.md` as described above
   before you start editing, then work to it. Hand the goal to every subagent,
   to `adviser`, and to `reviewer`.

0b. **Autonomous protocol (no command needed)** — you drive both loops
    yourself; the slash commands are only explicit triggers, never the
    expected entry:
    - **Review**: whenever your edits are complete and the change needs the
      gate, start the review loop on your own (step 2/3 below) — do not wait
      for the user to type `/review`. `prepare_review` shards a large diff for
      you; the shard plan needs no user confirmation.
    - **Decompose**: whenever you detect a complex task (too big for one
      session, scope growing mid-task), propose it yourself with evidence and
      a module estimate (step 0 of the module-loop section) and wait for the
      user's consent — do not wait for `/decompose`. Once the module table is
      approved, drive the whole plan yourself: `/plan-next` waves and
      `/plan-verify` rounds run back-to-back until accepted or a human
      decision is required.

1. **Consult (recommended, not gated)** — before or during non-trivial work,
   ask the `adviser` subagent about the design, tradeoffs, and risks. Feed it
   the real question, not your preferred answer. Fold its input in before you
   commit to an approach. Skip only for trivial, low-risk changes.

2. **Precommit first, review second** — with the edits finished, run the
   trusted precommit BEFORE spending the expensive judge's time:

   - Call **`run_precommit`** first. The runner schedules itself (no flags):
     any `lint:fix` script runs FIRST and alone (it edits files, so nothing
     may read the worktree before it finishes), then lint/typecheck/build/
     test run in parallel with declaration-order output. Steps whose inputs
     have not changed reuse their previous PASS and report `cached`.
   - **Pick the lane.** The default `fast` lane runs lint + typecheck + build
     + only the tests RELATED to the changed files — seconds instead of
     minutes, and enough to clear a `git commit`. Use `mode: "full"` for the
     LAST round before you ship: `git push`, `gh pr create/edit` and
     `declare_done` all require a run whose tests were not narrowed, and the
     gate will say so if you try. Running every intermediate round in `full`
     just pays for the whole suite on every typo fix.
   - **Why precommit first, not concurrent**: precommit is cheap (seconds to
     a couple of minutes) and catches the cheap defect class the reviewer
     would otherwise spend minutes finding; the review is EXPENSIVE (two
     top-tier judges at max thinking). A FAIL is cheaper to fix before the
     expensive judge looks — the reviewer must never be the first one to
     find a test failure, and a review spent on a red tree is pure waste.
     (An earlier design ran both concurrently to save wall time; it was
     abandoned because a precommit FAIL made the concurrent review a wasted
     round — the expensive half of the loop was paid for a tree that could
     not ship.)

   FAIL / `NO CHECKS RUN` ⇒ fix and re-run; only then continue to the review.
   `NO CHECKS RUN` is NOT a pass — tell the user real checks are missing.

   (Running `node scripts/precommit-runner.mjs` by hand still prints the
   human-readable report, but only the `run_precommit` tool records the gate:
   it spawns the trusted bundled runner and verifies a private nonce receipt,
   so a PASS can NOT be forged by printing a `## Overall: ✅ PASS` sentinel.)

   **Waiting-window discipline**: while the reviewer runs (~3 min) and while
   Copilot waits (up to 20 min), do useful parallel work — first of all its
   OWN streamed findings (below), then other repos' loops, PR description
   drafts, `[NIT_DEFERRED]` bookkeeping, a triage sweep. Never idle-poll a
   running subagent.

3a. **Prepare isolation + streaming** — call `prepare_review` with one label
   per reviewer you are about to spawn (use the fan-out plan's count). It
   materializes a DISPOSABLE snapshot worktree per reviewer — holding exactly
   the change under review — and returns each one's `cwd` and finding-stream
   path. Spawn each reviewer with its own `cwd`, and paste its stream
   directive into the task.

   Why it exists: a reviewer here verifies by DOING (it mutates code to prove
   a test really fails), and it used to do that in your worktree — fighting
   you, the other reviewer, and the fingerprint. In its own copy it can verify
   as hard as it likes, and you can keep working.

   What it buys you: **fix the streamed findings while the review is still
   running.** Read each stream file between waits (`subagent_wait` with a
   ~60s timeout → read → fix → wait again; never a tight poll). Act on
   P0/P1/P2 that carry evidence — confirm each one in the code yourself first
   — and leave Nits for the verdict. Fixing mid-review moves the worktree, and
   the gate ENFORCES the consequence: it compares the tree the reviewers
   actually read with the tree at record time, so a READY that no longer covers
   your worktree is recorded as BLOCKED (`STALE TREE`). That is the normal,
   fail-closed outcome — and the next round is short, because you have already
   done its fix work.

   Stream lines are EVIDENCE, never a decision: a line carrying a verdict key
   is rejected, and only the reviewer's final output goes to `record_review`.
   `record_review` re-derives each snapshot's tree: a reviewer that left its
   mutation in place has its READY downgraded to BLOCKED (its findings still
   count), so re-run that one in a fresh snapshot.

   If `prepare_review` reports isolation UNAVAILABLE, the reviewers would be
   reading YOUR live worktree, so fall back to the old rules for that round:
   **dispatch `reviewer-readonly` instead of `reviewer`** (its `tools:` allowlist
   has no edit/write, so it physically cannot touch the worktree — that is the
   mechanical half; choosing it is yours to honor, because pi-subagents has no
   per-call tool denylist), and do NOT apply fixes until the verdict is
   recorded. If it reports a PARTIAL failure (some shards got no snapshot) it
   refuses the whole plan on purpose — retry rather than review a subset.

3. **Review** — spawn an independent reviewer over the current diff
   (`git diff HEAD` + untracked files). **By default spawn TWO reviewers from
   different model families** (see "Default two-reviewer final pass" above);
   run them in parallel and record both via `record_review` (worst wins). The
   reviewer must NOT be fed your own conclusions (fresh eyes only) and must
   end its output with a fenced JSON
   verdict:

   **Tiered trigger (small diff fast, large diff parallel)** — you do NOT decide
   this: `prepare_review` does, from the diff size
   (`shouldShardReview(fileCount, lineCount)`):

   - **Small diff** (< 20 files AND < 500 changed lines): the labels you pass
     are the reviewers — TWO cross-family ones by default (see the fan-out
     rule), each over the full change, each attesting `docSync` itself. **Spawn
     them in the SAME turn with `async: true`** — never one after the other:
     serial spawns double the review wall time for zero additional signal.
   - **Large diff** (≥ 20 files OR ≥ 500 changed lines): `prepare_review` shards
     it for you with `planReviewShards` (≤ 4 disjoint groups covering every
     changed file) and returns each shard's snapshot cwd, stream path, file list
     and ready-made task text. Spawn one reviewer per shard, all in the same
     turn, each with its own cwd; merge every shard output into ONE
     `record_review` call; then run ONE integration review over the whole change
     that carries the `docSync` attestation.

   No engine is involved anywhere — the pdw engine is retired
   (`docs/handoff-remove-pdw.md`); wave workers (`worker-readonly`) and the
   decompose module loop run on plain subagents too.

   The thresholds are exported constants (`SHARD_THRESHOLD_FILES` /
   `SHARD_THRESHOLD_LINES` in `lib/parallel-review.ts`) — never invent your
   own split rule.

   **Triage first (L1, large diffs)**: for anything but a tiny diff, spawn
   the `triage` agent (async, cheap: `claude-haiku-4-5` →
   `opencode-go/deepseek-v4-flash`) over the same diff and hand its findings to the
   reviewer as input. Triage output carries NO verdict — never feed it to
   `record_review`; the reviewer owns the verdict.

   ```json
   {"gate": "READY" | "BLOCKED" | "NEEDS_HUMAN", "docSync": "UPDATED" | "NOT_NEEDED", "findings": [{"file": "...", "line": 1, "severity": "P0|P1|P2|Nit", "issue": "..."}]}
   ```

   Severity: P0 = must fix now, P1 = must fix before ship, P2 = should fix,
   Nit = optional. Any P0/P1 open ⇒ gate BLOCKED.

   Give the reviewer the loop goal (the file path, or quote it) and require
   criterion-by-criterion acceptance: each exit criterion marked MET / NOT_MET
   with evidence, an unmet criterion raised as a P1 finding. A missing goal is
   not a blocker — the reviewer then judges the diff against the task intent.

   **Hand over your "impossible" list.** Anything you gave up on, worked
   around, or declared infeasible this round — a skipped/removed test, a
   `TODO`/`FIXME` you left, a non-goal added because it "can't be done", a
   requirement met only partially — must be listed explicitly for the reviewer,
   with your evidence. Do NOT hand over your justification as a conclusion: the
   reviewer re-verifies each claim from source, docs, or a counter-example, and
   a refuted claim that produced a degraded implementation is a P1 finding.
   Hiding the list does not make it pass — it just costs a round.

   `docSync` is the reviewer's code↔doc attestation, required for code
   reviews: `UPDATED` (project docs — requirement / plan / feature docs under
   `docs/`, README, specs; NOT agent memory files: CLAUDE.md, AGENTS.md,
   progress.md — meaningfully updated for the behavior change) or `NOT_NEEDED` (with a
   one-line reason in prose). Enforced by default; the gate fails closed
   without it (disable per project via `"docSync": false` in
   `.pi/review-gate.json`).

4. **Record** — call the `record_review` tool with the reviewer's FULL raw
   output (the gate parses every fence; the worst verdict wins — never
   summarize or trim it).

5. **Fix** — if BLOCKED: fix ALL findings (P0-P2; Nits at your judgment),
   then go to step 2 again (fixing edits files, so precommit must run again
   before the next review). Fixing without re-reviewing is a violation.
   When you deliberately leave a Nit unfixed, log it in a structured line so
   the decision is auditable (sd0x-dev-flow Nit exemption log):

   ```
   [NIT_DEFERRED] file:line | issue | reason: <why> | <ISO date>
   ```

6. **Copilot review (L7, once a PR exists)** — a successful `gh pr create`,
   `gh pr edit` or `git push` opens a Copilot review cycle for that repo. Call
   **`request_copilot_review`**, then **`check_copilot_review`** (the extension
   runs `gh` itself — you cannot report this outcome). AWAITING ⇒ do something
   useful and check again. OPEN ⇒ for each listed thread either fix it and
   `resolveReviewThread`, or reply in the thread with the reason it will not be
   fixed; then check again. SATISFIED / UNSUPPORTED / EXHAUSTED ⇒ done (a repo
   with no sign of Copilot releases itself at once instead of waiting; a
   Copilot that never answers within 20 minutes escalates to the user).
   Pushing your fixes re-arms the cycle — that is the loop, and it has **no
   round cap**: keep going until every finding is handled.

   Two things you do NOT get to skip: an open thread stays yours even after you
   push (GitHub does not re-review a new head by default, so that thread is
   often the only feedback there is), and a release that abandons open findings
   (the PR vanished, `gh` lost its credentials, the wait ran out) says so and
   names the count — carry that to the user before you finish.

7. **Done** — call `declare_done`. It re-validates everything server-side and
   rejects if any gate is unmet. Both the precommit PASS and the READY review
   must be bound to the SAME (current) fingerprint; if anything edited the
   worktree since, run the affected step again.

   **The fingerprint is content-addressed and staging-invariant.** `git add`,
   `git commit` and any branch switch that does NOT rewrite working-tree files
   leave it untouched, so a READY review and a precommit PASS survive all
   three: never re-run a review to "rebuild the binding" after staging or
   committing — that is a wasted round at top-tier model prices. Only a change
   to the WORKING TREE's file contents invalidates it (an edit, a lint:fix run,
   or a checkout that does rewrite files).

   It also rejects while a Copilot cycle is still open or the loop goal is
   unapproved — those are completion requirements, not ship requirements.

   Use `{ "mode": "full" }` for the final precommit of a change that touches
   build/type surfaces: fast mode runs lint + tests, full mode adds typecheck
   and build (and prefers a project's `test` script over `test:unit`).

## Model tiers — cheap models read, mid models execute, strong models judge

Design record: `docs/parallel-execution-plan.md`. Three tiers, all default-on:

- **L1 cheap/fast** (`triage`, `recon`, `claude-haiku-4-5` →
  `opencode-go/deepseek-v4-flash`, **thinking `low`/off**) — mechanical pre-scan, code/doc
  search, heavy reading. Advisory only; carries no verdict. The main agent
  delegates heavy reading to `recon` so expensive models never pay token cost
  for scanning.
- **L2 execution** (`worker` / `planner` / `fixer`, `claude-sonnet-5` →
  `claude-opus-5` → `opencode-go/deepseek-v4-flash`, **thinking `max`**) — implements findings / modules into a
  diff; you review and merge it (single writer stays with you).
  (Chains are short because pi-subagents requires every fallback to resolve;
  a user who configures deepseek / oc-sdk-go / onekey can extend them in
  `~/.pi/agent/agents/*.md`.)
- **L3 judgment** (reviewer / adviser / module-reviewer / arbiter, `max`
  thinking) — the only tier whose verdicts may be recorded. Never delegate
  the verdict to a cheaper model.
- **Low-risk exception**: a change that is purely docs / formatting /
  one-line may be reviewed by an L1 agent whose verdict IS recorded.
  Judging "low-risk" is yours; a misjudged call is a P1 finding for the L3
  reviewer.
- **Split review = tiered by diff size**, and it runs on plain subagents:
  `prepare_review` splits ≥20-file or ≥500-line diffs with `planReviewShards`
  into ≤4 disjoint groups covering every changed file, hands each shard its own
  writable snapshot + stream, and you spawn one subagent per shard in ONE turn
  (shard fences WITHOUT docSync) → record ALL shard outputs in ONE
  `record_review` → then ONE integration reviewer recorded alone (it carries the
  docSync attestation). Small diffs (<20 files AND <500 lines) run the default
  TWO cross-family reviewers over the whole change — see the Tiered trigger in
  step 3. Worst wins. No user confirmation is needed for the shard plan.
  No engine is involved anywhere (the pdw engine is retired —
  `docs/handoff-remove-pdw.md`).

**The reviewer models are configurable — honor the slot-driven double review.**
The double-review pair is computed by the gate from the host registry
(`planFanoutFromFacts`) UNLESS the `agents.reviewer` config (project
`.pi/review-gate.json` over `~/.pi/review-gate.json`) has its `auto` switch
OFF — then the pair is the first two usable **slots** the user pinned,
skipping same-family duplicates so the two reviewers still come from
different model families (`planSlottedReviewFanout`, whose source line is
injected in the fan-out directive). With `auto` OFF and an EMPTY slot list the gate falls back to the
capability-ranked default path — an empty slot list is never a silent
no-review state. Never second-guess the injected pair; it is a fact the gate
computed.
Model chains live in the `agents` section of those config files and
are rendered (with per-model `:thinking` suffixes) into `.pi/agents/*.md`
(project) and `~/.pi/agent/agents/*.md` (global) by the extension at session
start — so agent frontmatter can change under you; trust the directive, not
a memorized pin.

## Working across several repos

Every repo has its OWN gate: its own review verdict, its own precommit PASS,
its own worktree fingerprint. A verdict never transfers between repos, and the
ship gate checks the repo the command actually runs in.

So once a session has edited more than one repo, `record_review` and
`run_precommit` **require** an explicit `"repo": "<absolute path>"` — they
refuse to guess. **Run the loops concurrently — each repo precommit-first**:
repos share no state (own sidecar, own fingerprint, own verdict), so for
EACH repo run its precommit to a PASS first, then spawn its reviewer; the
two repos' loops may interleave (A's precommit while B's reviewer runs is
fine — that is parallelism ACROSS repos, never a review and a precommit of
the SAME repo overlapping). Record each verdict against its own repo, and
ship each repo when its own gates pass. Only the final `declare_done` needs
every repo green.

Without that argument the tools used to fall back to the repo you edited LAST,
and only an edit could move that target. Real consequence: a session that
edited B last kept recording READY for B while trying to commit A, and A
reported `code review gate is PENDING` after every single round — an
unbreakable loop that looks exactly like the gate resetting itself.

If a block message says a READY is recorded on a different repo than the one
you are shipping, that is this mistake: re-review the blocked repo and record
the verdict against it. `/gate-status` lists every repo the session touched.

One more thing to know: two Pi sessions in the SAME worktree share one gate
state file, which is all the git hooks can see. A READY/PASS that still matches
the worktree survives the other session's next write — but only that one write,
and each session's edits re-arm the other's gate. Treat a shared worktree as
unreliable: prefer one session per worktree (`git worktree add` for parallel
work). The gate warns at session start when it detects another recent session.

## Cost discipline (the loop is billed per ROUND, not per line)

A round costs ~3 min of reviewer wall time plus the precommit run, and the
gate re-arms on *every* edit (`review: READY → PENDING`,
`precommit: PASS → NOT_RUN`). So:

- **Batch the work.** Finish a coherent unit before triggering review. Ten
  one-line fixes reviewed separately cost ten rounds; reviewed together, one.
- **Pre-triage cheaply.** For a large diff, a fast cheap model can catch the
  obvious problems first. A triage pass is *not* a review: it produces no
  verdict and must never be fed to `record_review`.
- **Keep re-reviews focused.** For a small fix-up round, give the reviewer the
  previous findings, the fix diff, and the affected files in full — rather
  than re-reading the whole tree. Use a full review for structural changes;
  the verdict still binds to the complete worktree fingerprint either way.
  This trades review breadth for latency — do not use it to hide a change.

## Wave daily — parallel editing for everyday tasks

Wave workers are **not just for decompose**. The patch-first protocol described
below works for ANY task that can be split into independent sub-tasks with
disjoint file ownership. The protocol is the same; the only difference is that
decompose has a formal module table and plan state, while a daily wave is
ad-hoc — you define the modules, dispatch them, and apply their patches.

### When to wave vs when to serialize

| Condition | Decision |
|---|---|
| Task fits in one session, no module split needed | **Serialize.** One writer, one pass. |
| Task has 2–4 independent sub-tasks, each scoped to disjoint files | **Wave.** Patch-first workers in parallel. |
| Sub-tasks share files or have ordering dependencies | **Serialize.** Wave requires disjoint owned_paths and a DAG. |
| Task is a single large change with no natural split | **Serialize.** A wave with one module is just overhead. |
| Task is too large for one session (>5 modules or unknown scope) | **Decompose.** Formal module table, plan state, verify rounds. |

### Wave daily trigger

When you detect a task that can be split into 2–4 independent sub-tasks, each
with clearly disjoint file ownership:

1. **Define the modules.** Each module needs: an id, a one-line title, its
   `owned_paths` (disjoint from other modules), and its task description.
   Modules with no dependencies all run in the same wave.
2. **Dispatch the wave.** Call `prepare_wave` with the module list, then spawn
   ONE `worker-readonly` subagent per module IN THE SAME TURN (async), each
   with its ready-made task and `WAVE_WORKER_SCHEMA` as outputSchema. All
   workers run in parallel (strictly read-only — no edit/write/bash in their
   allowlist); each returns unified git diffs for its owned paths.
3. **Validate and apply.** For each worker's patches: `validatePatchOwnership`
   (declared path ∪ diff headers ⊆ owned_paths), `git apply --check`, then
   `git apply`. A patch that fails is sent back to its worker for one retry —
   never silently edited.
4. **Record.** The worktree still has exactly one writer: you. After all
   patches apply, the worktree is ready for precommit and review.

### Patch-first protocol (daily wave)

> This is the SAME protocol as the decompose wave — the workers and the
> patch-first mechanics are identical.
> The only difference is that daily waves have no formal plan state or
> verify rounds; the main agent defines the modules ad-hoc.

- **Workers are READ-ONLY.** Their `tools:` allowlist has no
  edit/write/bash (`agents/worker-readonly.md` — enforced at launch, since
  pi-subagents has no per-call tool denylist). Each worker reads its owned
  paths and produces unified git diffs.
- **≤4 modules per wave.** `computeWave` caps the wave at 4; a 5th module
  waits for the next wave.
- **Patch-first.** Workers produce diffs; the main agent validates and applies
  them. No worker ever writes to the worktree directly.
- **Ownership is mechanically binding.** `validatePatchOwnership` checks both
  the declared `path` field AND the diff's own `+++ b/...` / `--- a/...`
  headers against the module's `owned_paths`. A patch that escapes ownership
  is rejected — the main agent must not apply it.
- **No cross-patch rollback.** Patches are applied in sequence with per-patch
  validation. A failed patch is sent back to its worker for one retry, never
  silently edited by the main agent.
- **Wave workers are strictly read-only** — `agents/worker-readonly.md`'s
  `tools:` allowlist has no edit/write/bash (pi-subagents has no per-call tool
  denylist; the allowlist is the mechanical guarantee). The pdw engine that
  used to enforce this is retired (`docs/handoff-remove-pdw.md`); a worker that
  returns no result makes its module FAIL (never "nothing to change"), and
  there is no serial fallback.

### Example: daily wave dispatch

```
Task: add pagination to list endpoints (3 files, 2 independent sub-tasks)

Module A: backend pagination — owned_paths: ["src/api/list.ts", "src/db/query.ts"]
Module B: frontend pagination — owned_paths: ["src/ui/ListPage.tsx", "src/ui/ListPage.test.tsx"]

Wave: [A, B] — no dependencies, dispatch in parallel
→ Worker A returns patch for src/api/list.ts and src/db/query.ts
→ Worker B returns patch for src/ui/ListPage.tsx and src/ui/ListPage.test.tsx
→ Main agent validates ownership, git apply --check, applies both patches
→ Precommit + review as usual
```

### Wave daily vs decompose

| Aspect | Wave daily | Decompose |
|---|---|---|
| Module table | Ad-hoc, defined by the agent | Formal, approved by the user |
| Plan state | None | `.pi/plan/state.json` |
| Verify rounds | Standard review loop | Two-phase (module + integration) |
| Round cap | Standard (10 rounds) | Per-module (8 charged rounds) |
| When to use | 2–4 independent sub-tasks, one session | 5+ modules, multiple sessions |

### Exploration parallelization

Read-only exploration (recon, code reading, `adviser` consultation) is
inherently parallel-safe:

- **Spawn in parallel.** Multiple read-only subagents can read different parts
  of the codebase concurrently. Each reads its own files; no writes happen.
- **Overlap with editing.** While a read-only subagent surveys the code, you
  can concurrently edit a different file. The single-writer invariant holds —
  only YOU write to the worktree.
- **Merge results.** Collect findings from all parallel subagents; fold them
  into your decisions before committing to an approach.
- **Cost discipline.** Read-only subagents run on cheap models (L1/L2);
  parallel exploration is cheap per-agent and the wall-clock win is real.

## Very large requirements: the wave-parallel module loop

When one request is too big for a single session, do not stretch the loop —
split the requirement. The contract is SELF-CONTAINED: it lives in the
commands themselves (`lib/workflow-commands.ts`) and the state module
`lib/plan-state.ts` (the schema authority — resolve it at
`<package-root>/lib/plan-state.ts`; a local-path `pi install` points at the
repo itself, a global/npm install at `~/.pi/agent/npm/pi-review-gate/lib/`) —
no repo-local doc is required; the extension must work in any repository. `/decompose`, `/plan-next`,
`/plan-status` and `/plan-verify` drive it. The shape:

0. **Agent-initiated entry** — you may initiate `/decompose` yourself whenever
you detect a complex task (a requirement too big for one session, or scope
growing complex mid-task), not only when the gate's size hint fires.
Initiating is a REQUEST, not an action: present the evidence (exit-criteria
count, directories spanned, module estimate) plus your own module-count
estimate and wait for the user's EXPLICIT consent before writing the brief or
spawning the planner. The module-table approval below is the second, separate
confirmation.

1. `/decompose` — a cold planner proposes a module table (id, intent,
   `owned_paths`, `depends_on`, `must_haves`, model, thinking, risk). Show it
   to the user ONCE, whole, for approval. Plan-time modules must own disjoint
   paths and form a DAG; that, not a token estimate, is what makes a split
   real. Approved state lands in `.pi/plan/state.json`.
2. `/plan-next`, repeatedly — the planner cold-starts from the state, writes
   the next WAVE's task briefs, and returns one instruction per module. A wave
   is every pending module whose `depends_on` are all implemented/accepted
   (≤4 per wave). Call `prepare_wave` (`lib/plan-parallel.ts` + the extension
   tools) to reconcile the wave fail-closed and get one ready-made task per
   module; spawn ONE `worker-readonly` subagent per module IN THE SAME TURN
   (async) with `WAVE_WORKER_SCHEMA` as outputSchema — each worker is strictly
   READ-ONLY (no edit/write/bash in its allowlist) and returns unified git
   diffs for its `owned_paths`. Then call `apply_wave_patches` with your
   workers' structured outputs: it validates (`validatePatchOwnership` + `git
   apply --check`), persists patches under `.pi/plan/patches/`, and you apply
   them in sequence with per-patch validation and record each
   module's status plus a one-line result. A worker that returns no result
   means its module FAILED — never applied. **You are a driver here**: never read the diff,
   the source or the worker's transcript. The planner is disposable precisely
   because everything that matters is on disk, so a planner that runs out of
   context costs nothing.
3. `/plan-verify` — one round: `run_precommit` full ONCE, then Phase A (one
   module reviewer per module, parallel, read-only) recorded together, then
   Phase B (the integration reviewer over the whole change) recorded ALONE.

**The docSync protocol is the part that will bite you.** `record_review`
merges equal-severity fences and DROPS `docSync` when they disagree, and an
absent attestation fails closed. So Phase A fences must omit `docSync`
entirely (a shard reviewer cannot attest to the whole change), and Phase B must
be its own `record_review` call so its attestation survives intact. Two calls
per verify round is the price; it is why the round cap matters on a long plan.

On any failure the round ABORTS: every finding gets exactly one owner (an
existing module, or a seam module `M-INT-<n>` when the fix crosses ownership),
the counters are charged, uncharged modules roll back to `implemented`, and
remediation goes through `/plan-next` — never inline. Above 8 charged rounds
for a module or for the integration counter, stop and ask the user.

Serial by decision: exactly one writer in the worktree at a time. That is what
lets this skip worktrees entirely without ever putting a verdict at risk.

## Rules

- **输出语言（L4，强制）**：所有面向用户的文字用严格简体中文，thinking 也尽量用
  中文。例外保持英文原样：代码、标识符、文件路径、shell 命令，以及协议固定英文
  标记——裁决 JSON 的 `READY`/`BLOCKED`/`NEEDS_HUMAN`、precommit 的 `## Overall:`
  sentinel、commit message（翻译它们会破坏门禁解析）。
- **Commit/PR 英文（L5，强制）**：commit message 和 PR 的 title/description 必须用
  英文。门禁**硬拦截**非英文为主的文案（majority-body 判定，少数外来词可通过；
  报错信息带逃生说明：会话内由用户 `/gate-bypass <reason>` 放行，`REVIEW_GATE_BYPASS=1`
  仅对会话外的 git hooks 层提交有效），reviewer 审核时也会把非英文的
  commit/PR 文案记为 P1 finding。请直接用英文写。
  （注意：这与 L4 不矛盾——面向用户的聊天用中文，commit/PR 用英文。）
- Never edit `.env`, key files, or credentials (hard-blocked anyway).
- Never put AI attribution in commit messages (hard-blocked anyway).
- Max 10 rounds (per-project override via `.pi/review-gate.json` `maxRounds`,
  clamped to 3–50); if findings plateau 3 rounds running, stop and escalate to
  the user instead of looping.
- Near the round cap the gate injects a one-shot `[STRATEGIC_RESET]` checklist
  (sd0x-dev-flow "Think Harder"): re-read the original requirement, challenge
  assumptions, and try a fundamentally different approach before escalating.
- Prohibited while gates are unmet (auto-loop rules): claiming a fix is done
  without re-reviewing; asking permission to continue; citing context length or
  token budget to skip review; outputting a completion-style summary. Brief
  status lines ("Fixed 3 issues, re-reviewing…") are fine.
- EXCEPTION — genuine blockers: if progress is stopped by a question only the
  user can answer (ambiguous requirement, a product decision, missing access),
  put the COMPLETE question (options + your recommendation) in
  `pause_for_question`'s `question` parameter — the user sees it verbatim, so do
  NOT repeat it in your reply; write one short line pointing at it and END
  the turn. Auto-continuation pauses until the user's next message (their reply
  resumes the loop automatically); ship commands stay blocked throughout. Never
  use it to ask permission to continue routine loop work — that stays
  prohibited.
- SCOPE — pre-existing changes: if the unmet gates demand coverage of dirty
  files or branch commits that PRE-DATE this session (work you never did),
  do NOT silently review the world and do NOT bypass — call
  `request_scope_limit` with a one-line reason. The extension asks the USER
  whether session-only coverage suffices (you cannot approve it yourself).
  Granted → review only this session's own edits (out-of-scope findings are
  advisory; tell the reviewer so). Declined → cover everything; the request
  locks for the session, so do not ask again.
- When the user corrects a recurring mistake, record it with `/gate-lesson`
  (appends to `.pi/review-gate-lessons.md`); promote lessons recurring 3+
  times into project rules.
