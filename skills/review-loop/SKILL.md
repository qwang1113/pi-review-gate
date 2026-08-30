---
name: review-loop
description: Run the pi-review-gate quality loop — independent review, record verdict, fix, precommit, declare done. Use after completing code changes when the user wants review-until-confident before commit/PR.
---

# Review Loop

Drive changes through the review gate until every gate passes. The gate is
enforced by the pi-review-gate extension: `git commit`, `git push`, and
`gh pr create` are hard-blocked until the loop completes.

## One independent judge, on a stronger model than you

Good judgement comes from a *stronger, independent* brain than the one that
wrote the code. The single review role is pinned to a top-tier reasoning model
at `max` thinking, with a fallback priority list (first available wins):

- **`adviser`** (`agents/adviser.md`, consultant, *before/during* work) —
  you should **proactively consult** it whenever a decision is non-trivial,
  ambiguous, risky, or you feel stuck. It does not gate; it advises on
  direction. Consulting early is cheaper than a failed review later.
  Model priority: Fable 5 → Opus 5 → deepseek-v4-flash.
- **`reviewer`** (`agents/reviewer.md`, gatekeeper, *after* a diff exists) —
  independent audit that emits the JSON verdict the gate records.
  Model priority: Fable 5 → Opus 5 → deepseek-v4-flash.

Thinking is a single value (`max`, the highest valid pi level); it is not a
fallback list. If a model doesn't support `max`, pi clamps it down.

**Single-reviewer round.** Each review round is ONE reviewer over the WHOLE
change — no second reviewer, no split, no different-family audit. One
checkpoint commit range, one verdict, one `judge_submit` call. This is by
design (user decision 2026-08-26): parallel/multi-judge patterns were removed
because they multiplied cost without adding an independent signal that a single
strong reviewer does not already provide.

The pinned chains above are the single source of truth for model selection (agent
frontmatter in `agents/*.md`); refresh decisions for those pins are a human
choice, not a runtime selector.

## The loop goal — the exit contract

The gates say the code is *sound*; they say nothing about whether the user's
goal was *met*. The loop goal closes that hole: one short file, written before
the work starts, listing the checkable facts that mean **done**. The same file
then drives both roles — you slice work against it, `adviser` advises
against it, `reviewer` accepts against it.

**Negotiated, not assumed**: you do NOT write this file. Grill the user
first — unless they asked for them all at once, ask ONE question per turn,
labeled "N of M", give your own recommended answer, wait for the reply, repeat
until nothing is silently assumed — then call **`propose_loop_goal`** with what they
agreed to. The extension shows it in a confirm dialog and, on approval, writes
the file itself and records the hash of that exact text. In loop mode an
unapproved goal **blocks commit/push/PR** and its body is withheld from your
prompt (a leftover goal from a previous task is exactly what that prevents).
Editing the file afterwards drops the approval — renegotiate and re-submit.

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

**Pre-review the draft goal (MECHANICAL, goal-auditor).** Before you submit a
goal for approval, hand the draft to the gate:

```
judge_submit({ role: "goal-auditor", task: "<the full draft>" })
```

It builds the auditor's task (carrying the previous audit's findings and the
draft delta on a re-audit), dispatches the dedicated `goal-auditor` as its own
read-only pi process (see `agents/goal-auditor.md`), parses the verdict and
records it. **Only P0/P1 block** — a READY carrying P2/Nit findings is a PASS,
and non-blocking findings never buy another audit round. `propose_loop_goal`
REFUSES to show the user's approval dialog unless a PASS is recorded for the
IDENTICAL text (bound by content hash). A failed audit means fix the objections
and submit the revised text the same way — it needs its own
PASS. The goal text must be written in **Simplified Chinese**; identifiers,
paths and code tokens stay English.
**Shape**: task title · one-line intent · 3–7 checkable exit criteria ·
non-goals · ISO date. A criterion must be judgeable by a command or a concrete
observation — "code quality is good" is not a criterion, "`node --test` passes
and `lib/x.ts` no longer reads the sidecar" is.

**Staleness**: a goal file older than 24h may be left over from a previous
session. The gate flags it in the prompt; confirm it against what the user is
asking for now, and renegotiate it (`ask_user` →
`judge_submit({role:"goal-auditor"})` → `propose_loop_goal`) if it no longer matches — the
audit binds to the revised text, so any edit needs a fresh PASS.

**Slicing the work to subagents**: turn each criterion (or vertical slice) into
a subagent task and hand the goal text to every subagent you spawn.

### Parallel exploration — read-only subagents run concurrently

Read-only subagents (recon, code reading, analysis) are inherently
parallel-safe: they never write to the worktree, so they cannot invalidate a
binding or race with each other. When you need to explore several areas of the
codebase, spawn them in parallel — each reads its own files and returns
findings; you merge the results. Exploration and editing may also overlap:
while a read-only subagent surveys the code, you can concurrently edit a
different file (the single-writer invariant still holds — only YOU write).
(Adviser consultations run as judge child processes, not subagents.)

### Serial writers — exactly one writer in the worktree

Write-capable subagents run **serially in this worktree**: their edits change
the worktree like any other, so a review recorded before them can no longer
ship (the binding tree moved), and concurrent writers would keep invalidating
the binding between precommit and review. Read-only subagents (recon,
analysis) may run in parallel. You stay the single writer of record: you run
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
   before you start editing, then work to it. Hand the goal text to every
   subagent, to `adviser`, and to `reviewer` (as TEXT in the task, never as a
   file path: the task carries the approved text, not a pointer to the
   possibly-stale file).

0b. **Autonomous protocol (no command needed)** — you drive the loop
    yourself; the slash commands are only explicit triggers, never the
    expected entry:
    - **Review**: whenever your edits are complete and the change needs the
      gate, start the review loop on your own (step 2/3 below) — do not wait
      for the user to type `/review`. ONE reviewer per round; no split plan
      needs user confirmation (there is no plan).

1. **Consult (recommended, not gated)** — before or during non-trivial work,
   `judge_submit({role:"adviser", task:<your question>})` — the gate builds
   the brief itself (it carries the fresh-context transcript pointer, the
   conclusion artifact path, and — from the second consultation of the goal
   on — the previous consultation's conclusion and the files changed since;
   the adviser appends its conclusion to the artifact for the next time).
   Feed it the real question, not your preferred answer. Fold its input in
   before you commit to an approach. Skip only for trivial, low-risk
   changes.
2. **One round — ONE call** — with the edits finished:

   ```
   judge_submit({ role: "reviewer", task: "<what you changed this round>" })
   ```

   The gate runs the whole chain inside that call and sends the round back
   with a reason if any step fails:

   - **precommit (full lane)** — a FAIL is cheaper to fix before the review,
     and the reviewer must never be the first to find a broken test. **Do NOT
     manually run the full suite or typecheck first**: the lane runs
     lint/typecheck/build/the complete suite in one shot, and its input cache
     reuses an unchanged set in seconds. Use targeted tests for files you are
     actively editing.
   - **the checkpoint commit** — the only commit allowed before a READY; the
     gate stamps the checkpoint marker on the subject and records where it
     landed. The review unit is the immutable range `baseline..HEAD`.
   - **the range + the findings stream + the reviewer's task text**.
   - **the dispatch** — ONE reviewer, as its own pi process, with the exit
     watcher registered. You never pass a session id, a title or a directory.
     The gate BLOCKS judge roles dispatched through
     `subagent`/`workflowScript`/`workflowScriptPath` entirely (that sandbox
     has no per-child isolation — the judge would land in your live worktree).

   When the reviewer's process exits, the gate reads THIS round's output,
   records the verdict itself and wakes you with it — you never copy a
   verdict from one place to another. Worst-verdict semantics still apply if
   multiple fences appear (the parser keeps the worst), and an absent
   `docSync` means the round is incomplete (fails closed).

   The precommit lane, the checkpoint commit, the range computation and the
   verdict recording are **not tools** (2026-08-30) — the gate still performs
   every one of them inside `judge_submit`, but none of them is registered,
   so there is nothing to sequence and no second path to choose between.

   **Why this is safe**: the verdict binds to the reviewed commit's TREE
   (content binding — squash/amend preserving the tree keeps the READY
   alive), and the recording re-checks HEAD is still the reviewed commit
   (a new checkpoint after prepare ⇒ STALE ⇒ BLOCKED). The worst a race can
   do is discard a verdict, never ship unverified work: the reviewed range
   is immutable, so you may keep fixing the worktree while the reviewer
   runs.

   Precommit still matters for two measured reasons: tests catch the cheap
   defect class the reviewer would otherwise spend minutes finding (a test
   failure is far cheaper to fix than a BLOCKED verdict), and a FAIL is
   cheaper to fix before the expensive judge looks.

   FAIL / `NO CHECKS RUN` ⇒ fix and re-run; only then continue to the review.
   `NO CHECKS RUN` is NOT a pass — tell the user real checks are missing.

   (Running `node scripts/precommit-runner.mjs` by hand still prints the
   human-readable report, but only the gate's own trusted lane records a
   PASS: it spawns the trusted bundled runner and verifies a private nonce receipt,
   so a PASS can NOT be forged by printing a `## Overall: ✅ PASS` sentinel.)

   **Waiting-window discipline (v4)** — 主会话是门禁的最后监督者,门禁未通过
   前不得停止自动循环(round-18 存活不变量):
   1. 有可实现的确定性工作(代码/测试/文档/其他 repo 事务)→ 优先做掉,不要进入等待。
   2. 确认没有任何可做的工作后,才进入阻塞等待——在**一次 bash 调用**里同时
      托管三条判据:
      a. 进程是否已退出:`kill -0 <pid 文件第一段>` 或 `test -s <workDir>/exit-code`
         (exit-code 的存在就是"已结束"的权威事实,里面还带着退出码);
         ⚠️ 崩溃的子会话可能**根本没来得及写 exit-code**——它同样是"已结束",
         由主会话侧按「记录的那个进程是否还在」判定(见 lib/judge-session.ts);
      c. verdict 已产出但进程未退:子会话的 session jsonl 里已出现
         verdict fence(实测失败模式——子会话完成但进程未退出,主会话空等);
      任一命中即结束等待:judge_read 读取输出继续流程,或 judge_close 后
      重新派发。
   3. **禁止**结束 turn 把唤醒责任交给子会话(它可能报错/崩溃/永远不退)。
      `agent_settled` 会注入托管等待指令;主动托管远比被动拉起可靠。
   因为审核范围是 immutable commit,工作区编辑不失效本轮。
3. **Review** — the reviewer audits the COMMIT RANGE `baseline..HEAD` (the
   immutable checkpoint commits) with `git show`/`git diff`; it may verify by
   doing in a throwaway `$TMPDIR` copy (mutation analysis included) and must
   restore before finishing. The reviewer must NOT be fed your own
   conclusions (fresh eyes only) and must end its output with a fenced JSON
   verdict:

   ```json
   {"gate": "READY" | "BLOCKED" | "NEEDS_HUMAN", "docSync": "UPDATED" | "NOT_NEEDED", "cwd": "<its real pwd>", "findings": [{"file": "...", "line": 1, "severity": "P0|P1|P2|Nit", "issue": "..."}]}
   ```

   Severity: P0 = must fix now, P1 = must fix before ship, P2 = should fix,
   Nit = optional. Any P0/P1 open ⇒ gate BLOCKED.

   Every re-review carries the previous round's conclusion: the gate
   embeds a 'Review scope for this round' block in the ready-made task text
   (the prior verdict and findings, what is new since the last READY tree,
   and the findings to re-check one by one). First round = full review;
   later rounds = incremental: settled-and-unchanged material gets a
   consistency scan, not a re-derivation — it never narrows what a reviewer
   may look at, and a settled conclusion may always be reopened with
   evidence. The reviewer is its own pi process and inherits none of this
   session's conversation; the task text names the
   main session's transcript to read ON DEMAND when the conversation
   matters, instead of inheriting it.

   Goal-auditor re-audits and adviser consultations work the same way: the
   gate builds a re-audit task carrying the previous verdict and findings
   verbatim plus the draft delta, and the adviser's brief with the
   previous consultation's conclusion and the files changed since (full
   brief when there is no history).

   Give the reviewer the loop goal TEXT (as prepared — never a pointer to the
   possibly-stale file) and require criterion-by-criterion acceptance: each exit criterion
   marked MET / NOT_MET with evidence, an unmet criterion raised as a P1
   finding. A missing goal is not a blocker — the reviewer then judges the
   diff against the task intent.

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

4. **Record — the GATE does this, not you.** When the reviewer's process
   exits the gate reads THIS round's raw output, parses every fence (the
   worst verdict wins) and records the verdict, then wakes you with it. That
   same step verifies the commit target: it
   withholds a READY when the round was never prepared (no registered
   `baseline..HEAD`), downgrades a READY to BLOCKED when HEAD moved past the
   reviewed commit (STALE), and binds the READY to the reviewed commit's
   TREE — content binding, so a later squash of the checkpoint chain keeps
   it valid.

5. **Fix** — if BLOCKED: fix ALL findings (P0-P2; Nits at your judgment),
   then go to step 2 again (fixing edits files, so precommit must run again
   before the next review). Fixing without re-reviewing is a violation.
   When you deliberately leave a Nit unfixed, log it in a structured line so
   the decision is auditable (sd0x-dev-flow Nit exemption log):

   ```
   [NIT_DEFERRED] file:line | issue | reason: <why> | <ISO date>
   ```

6. **Copilot review (once a PR exists)** — a successful `gh pr create`,
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
   must be bound to the SAME (current) tree — the reviewed HEAD commit tree;
   if a new checkpoint landed since the READY, run the affected step again.
   It also rejects while a judge child session is still open: finish the
   round (let the judge exit — the gate records its verdict then — or
   `judge_close({role})`) first.

   It also rejects while a Copilot cycle is still open or the loop goal is
   unapproved — those are completion requirements, not ship requirements.

   Use `{ "mode": "full" }` for the final precommit of a change that touches
   build/type surfaces: fast mode runs lint + tests, full mode adds typecheck
   and build (and prefers a project's `test` script over `test:unit`).

## Model tiers — cheap models read, mid models execute, strong models judge

Design record: `docs/execution-model.md` + `docs/judge-protocol.md`. Three
tiers, all default-on:

- **L1 cheap/fast** (`recon`, `claude-haiku-4-5` →
  `opencode-go/deepseek-v4-flash`, **thinking `low`/off**) — mechanical
  code/doc search, heavy reading. Advisory only; carries no verdict. The main
  agent delegates heavy reading to `recon` so expensive models never pay token
  cost for scanning.
- **L2 execution** (`fixer`, `claude-sonnet-5` →
  `claude-opus-5` → `opencode-go/deepseek-v4-flash`, **thinking `max`**) —
  implements findings into a diff; you review and merge it (single writer
  stays with you).
- **L3 judgment** (reviewer / adviser / arbiter / goal-auditor, `max` thinking) — the only
  tier whose verdicts may be recorded. Never delegate the verdict to a
  cheaper model.
- No split review of any kind: one reviewer, one commit range, one verdict.

## Working across several repos

Every repo has its OWN gate: its own review verdict, its own precommit PASS,
its own reviewed tree. A verdict never transfers between repos, and the
ship gate checks the repo the command actually runs in.

So once a session has edited more than one repo, `judge_submit`
**requires** an explicit `"repo": "<absolute path>"` — it
refuses to guess. **Run the loop per repo**: repos
share no state (own sidecar, own fingerprint, own verdict), so repo A's
precommit and repo B's reviewer may interleave, but each repo's OWN
precommit must finish before its reviewer is prepared (an edit from the
lint:fix step invalidates that repo's review binding — reviewing first
throws the review away). Record each verdict against its own repo, and ship
each repo when its own gates pass. Only the final `declare_done` needs
every repo green.

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
- **Keep re-reviews focused.** For a small fix-up round, give the reviewer the
  previous findings, the fix diff, and the affected files in full — rather
  than re-reading the whole tree. Use a full review for structural changes;
  the verdict still binds to the complete worktree fingerprint either way.
  This trades review breadth for latency — do not use it to hide a change.

## Rules

- **输出语言（强制）**：所有面向用户的文字用严格简体中文，thinking 也尽量用
  中文。例外保持英文原样：代码、标识符、文件路径、shell 命令，以及协议固定英文
  标记——裁决 JSON 的 `READY`/`BLOCKED`/`NEEDS_HUMAN`、precommit 的 `## Overall:`
  sentinel、commit message（翻译它们会破坏门禁解析）。
- **Commit/PR 英文**：commit message 和 PR 的 title/description 必须用
  英文。门禁在 tool_call 层硬拦截（L5 HARD）以非英文为主的提交文案，
  且 reviewer 审核时会把非英文的 commit/PR 文案记为 P1 finding。请直接用英文写。
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
- ASKING THE USER: anything that needs a human — an ambiguous requirement, a
  product decision, scope, missing access — goes through `ask_user({questions})`.
  It runs the interview (one question at a time with its N / M progress, your
  options and recommendation, plus "answer in chat" and "skip the rest" for
  them) and PAUSES the loop until the answers come back, all at once. Never
  write the question into your reply and end the turn: that costs an iteration
  and may not even read as a question. Ship commands stay blocked throughout,
  and asking permission to continue routine loop work is still prohibited.
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
