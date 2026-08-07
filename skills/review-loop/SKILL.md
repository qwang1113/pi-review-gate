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
wrote the code. Both roles are pinned to a top-tier reasoning model at `xhigh`
thinking, with a fallback priority list (first available wins):

- **`adviser`** (`agents/adviser.md`, consultant, *before/during* work) —
  you should **proactively consult** it whenever a decision is non-trivial,
  ambiguous, risky, or you feel stuck. It does not gate; it advises on
  direction. Consulting early is cheaper than a failed review later.
  Model priority: Fable 5 → GPT-5.6 Sol → Opus 4.8 → GPT-5.5.
- **`reviewer`** (`agents/reviewer.md`, gatekeeper, *after* a diff exists) —
  independent audit that emits the JSON verdict the gate records.
  Model priority: GPT-5.6 Sol → Fable 5 → GPT-5.5 → Opus 4.8.

Thinking is a single value (`xhigh`, the highest valid pi level); it is not a
fallback list. If a model doesn't support `xhigh`, pi clamps it down.

Why these models? `lib/model-ranking.ts` scores model families from public
capability leaderboards (Artificial Analysis Intelligence Index, LMArena Elo,
LiveBench) and can rank candidates by capability, optionally rewarding
cross-family diversity so a judge doesn't share the main agent's blind spots.
It is a **reference for choosing the pinned models**, not a runtime selector —
the models above are fixed in the agent definitions. Refresh the underlying
scores with `node scripts/fetch-leaderboard.mjs` (opt-in, network).

## The loop goal — the exit contract

The gates say the code is *sound*; they say nothing about whether the user's
goal was *met*. The loop goal closes that hole: one short file, written before
the work starts, listing the checkable facts that mean **done**. The same file
then drives all three roles — you slice work against it, `adviser` advises
against it, `reviewer` accepts against it.

**Where**: `.pi/loop-goal.md`. That path sits inside the gate-owned `.pi/`
scope (`GATE_EXCLUDE_PATHSPECS` / `isGateOwnedPath`, `lib/fingerprint.ts`),
which both halves of the gate honour: it is excluded from the fingerprint and
skipped by edit tracking. Writing or rewriting the goal therefore never changes
the worktree digest, never arms the doc gate, and can never invalidate a READY
review or a precommit PASS.

**How to produce it** — sized to the change; a one-line bugfix deserves one
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
asking for now, and rewrite it if it no longer matches.

**Slicing the work to subagents**: turn each criterion (or vertical slice) into
a subagent task and hand the goal file to every subagent you spawn.
Write-capable subagents run **serially in this worktree**: their edits change
the worktree like any other, so a review recorded before them can no longer
ship (the fingerprint moved), and concurrent writers would keep invalidating
the binding between precommit and review. Read-only subagents (recon, analysis,
`adviser`) may run in parallel. You stay the single writer of record: you run
precommit, you run the review, you fix findings — never delegate the gate
itself.

**No new hard gate.** Nothing blocks on the goal file's existence — a
self-written file is not forgery-resistant, and every hard gate here rests on
an objective fact. The goal binds through the reviewer: an unmet criterion is a
P1 finding, and any P0/P1 ⇒ BLOCKED.

## Protocol

0. **Goal first (loop mode)** — establish `.pi/loop-goal.md` as described above
   before you start editing, then work to it. Hand the goal to every subagent,
   to `adviser`, and to `reviewer`.

1. **Consult (recommended, not gated)** — before or during non-trivial work,
   ask the `adviser` subagent about the design, tradeoffs, and risks. Feed it
   the real question, not your preferred answer. Fold its input in before you
   commit to an approach. Skip only for trivial, low-risk changes.

2. **Precommit FIRST** — with the edits finished, call **`run_precommit`**
   *before* spawning the reviewer. Two concrete reasons, both measured:

   - The runner runs `lint`/`lint:fix` in **both** modes
     (`scripts/precommit-runner.mjs`), and `lint:fix` **edits files**. Any
     edit changes the worktree fingerprint, so a READY verdict obtained
     *before* precommit is invalidated the moment the runner reformats
     anything — throwing away a review that costs ~3 minutes (median
     reviewer wall time) and forcing an extra round.
   - Tests catch the cheap class of defect that the reviewer would otherwise
     spend minutes finding — and a test failure is far cheaper to fix than a
     BLOCKED verdict.

   FAIL / `NO CHECKS RUN` ⇒ fix and re-run; only then continue to the review.
   `NO CHECKS RUN` is NOT a pass — tell the user real checks are missing.

   (Running `node scripts/precommit-runner.mjs` by hand still prints the
   human-readable report, but only the `run_precommit` tool records the gate:
   it spawns the trusted bundled runner and verifies a private nonce receipt,
   so a PASS can NOT be forged by printing a `## Overall: ✅ PASS` sentinel.)

3. **Review** — spawn an independent reviewer over the current diff
   (`git diff HEAD` + untracked files). The reviewer must NOT be fed your own
   conclusions (fresh eyes only) and must end its output with a fenced JSON
   verdict:

   ```json
   {"gate": "READY" | "BLOCKED" | "NEEDS_HUMAN", "docSync": "UPDATED" | "NOT_NEEDED", "findings": [{"file": "...", "line": 1, "severity": "P0|P1|P2|Nit", "issue": "..."}]}
   ```

   Severity: P0 = must fix now, P1 = must fix before ship, P2 = should fix,
   Nit = optional. Any P0/P1 open ⇒ gate BLOCKED.

   Give the reviewer the loop goal (the file path, or quote it) and require
   criterion-by-criterion acceptance: each exit criterion marked MET / NOT_MET
   with evidence, an unmet criterion raised as a P1 finding. A missing goal is
   not a blocker — the reviewer then judges the diff against the task intent.

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

6. **Done** — call `declare_done`. It re-validates everything server-side and
   rejects if any gate is unmet. Both the precommit PASS and the READY review
   must be bound to the SAME (current) fingerprint; if anything edited the
   worktree since, run the affected step again.

   Use `{ "mode": "full" }` for the final precommit of a change that touches
   build/type surfaces: fast mode runs lint + tests, full mode adds typecheck
   and build (and prefers a project's `test` script over `test:unit`).

## Working across several repos

Every repo has its OWN gate: its own review verdict, its own precommit PASS,
its own worktree fingerprint. A verdict never transfers between repos, and the
ship gate checks the repo the command actually runs in.

So once a session has edited more than one repo, `record_review` and
`run_precommit` **require** an explicit `"repo": "<absolute path>"` — they
refuse to guess. Run the loop per repo: review repo A → `record_review(repo:
A)` → `run_precommit(repo: A)` → commit A, then the same for B.

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

## Rules

- **输出语言（L4，强制）**：所有面向用户的文字用严格简体中文，thinking 也尽量用
  中文。例外保持英文原样：代码、标识符、文件路径、shell 命令，以及协议固定英文
  标记——裁决 JSON 的 `READY`/`BLOCKED`/`NEEDS_HUMAN`、precommit 的 `## Overall:`
  sentinel、commit message（翻译它们会破坏门禁解析）。
- **Commit/PR 英文（L5，advisory）**：commit message 和 PR 的 title/description 必须用
  英文。门禁不再硬拦截（提取启发式对 heredoc 等复杂 shell 写法可能误判），但会发出
  警告，且 reviewer 审核时会把非英文的 commit/PR 文案记为 P1 finding。请直接用英文写。
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
  call `pause_for_question` with the question, ask it in your reply, and END
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
