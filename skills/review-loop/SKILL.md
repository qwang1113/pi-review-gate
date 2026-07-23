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

## Protocol

0. **Consult (recommended, not gated)** — before or during non-trivial work,
   ask the `adviser` subagent about the design, tradeoffs, and risks. Feed it
   the real question, not your preferred answer. Fold its input in before you
   commit to an approach. Skip only for trivial, low-risk changes.

1. **Review** — spawn an independent reviewer over the current diff
   (`git diff HEAD` + untracked files). The reviewer must NOT be fed your own
   conclusions (fresh eyes only) and must end its output with a fenced JSON
   verdict:

   ```json
   {"gate": "READY" | "BLOCKED" | "NEEDS_HUMAN", "docSync": "UPDATED" | "NOT_NEEDED", "findings": [{"file": "...", "line": 1, "severity": "P0|P1|P2|Nit", "issue": "..."}]}
   ```

   Severity: P0 = must fix now, P1 = must fix before ship, P2 = should fix,
   Nit = optional. Any P0/P1 open ⇒ gate BLOCKED.

   `docSync` is the reviewer's code↔doc attestation, required for code
   reviews: `UPDATED` (project docs — requirement / plan / feature docs under
   `docs/`, README, specs; NOT agent memory files: CLAUDE.md, AGENTS.md,
   progress.md — meaningfully updated for the behavior change) or `NOT_NEEDED` (with a
   one-line reason in prose). Enforced by default; the gate fails closed
   without it (disable per project via `"docSync": false` in
   `.pi/review-gate.json`).

2. **Record** — call the `record_review` tool with the reviewer's FULL raw
   output (the gate parses every fence; the worst verdict wins — never
   summarize or trim it).

3. **Fix** — if BLOCKED: fix ALL findings (P0-P2; Nits at your judgment),
   then go to step 1 again. Fixing without re-reviewing is a violation.
   When you deliberately leave a Nit unfixed, log it in a structured line so
   the decision is auditable (sd0x-dev-flow Nit exemption log):

   ```
   [NIT_DEFERRED] file:line | issue | reason: <why> | <ISO date>
   ```

4. **Precommit** — once READY: call the **`run_precommit`** tool (optionally
   `{ "mode": "full" }`; default is fast). This is the ONLY way to record a
   precommit PASS: the extension spawns the trusted bundled runner itself and
   verifies a private nonce receipt — a PASS can NOT be forged by printing a
   `## Overall: ✅ PASS` sentinel from bash. FAIL ⇒ fix and return to step 1.
   `NO CHECKS RUN` is NOT a pass — tell the user real checks are missing.

   (Running `node scripts/precommit-runner.mjs` by hand still prints the
   human-readable report, but only the `run_precommit` tool records the gate.)

5. **Done** — call `declare_done`. It re-validates everything server-side and
   rejects if any gate is unmet.

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
- When the user corrects a recurring mistake, record it with `/gate-lesson`
  (appends to `.pi/review-gate-lessons.md`); promote lessons recurring 3+
  times into project rules.
