# pi-review-gate

**Quality gates for [Pi](https://github.com/earendil-works/pi-coding-agent)** — ship-gate hard blocking, persistent gate state, auto-continuing review loop. Globally installable.

> Quality gates the model can't skip: `git commit`, `git push`, `gh pr create`, and `gh pr edit`
> are **hard-blocked** at the `tool_call` layer until an independent review is
> READY **and** precommit PASSes — both bound to the exact worktree state they
> verified.

## Why

Pi has no `Stop` event to prevent the model from quitting — but it has something better: `tool_call` blocking. Instead of intercepting "the model wants to stop", we intercept "the model wants to ship". Combined with `agent_settled` auto-continuation, the model fixes → re-reviews → re-runs precommit until every gate is green, and *cannot* commit around it.

At the first task in each interactive session, the extension classifies the prompt to pick a workflow. When the LLM guard layer is enabled (default), a **semantic classifier** (DeepSeek V4 Flash, ~2s) judges the *intent* of the prompt — quoted logs, pasted notifications, and error messages are treated as context rather than intent, which a word-matching regex cannot do. If the model is unreachable or answers garbage, the decision **falls back** to the original fast deterministic classifier. When the (fallback) regex signal is clear it **auto-selects** the workflow and just notifies you — write intent (fix/implement/修改…) selects the full enforced **loop** workflow, and *pure* analysis/investigation intent (explain/review/分析/排查…) selects a conservative **explore** workflow. Explore auto-selection is deliberately strict: it requires an analysis hint **and** the absence of every known mutation/ship verb (commit, deploy, merge, save, upload, sync, 提交, 部署, 上传…); any mixed or unrecognized prompt pops the selection dialog instead.

**Explore mode** is the investigation/troubleshooting workflow. Its one essential difference from loop: **the agent may end the task on its own judgment** — `declare_done` is always accepted (gate status is reported as advisory) and auto-continuation is off. Edits and `bash` stay **available** — the injected system prompt merely instructs the agent to prefer read-only work — because troubleshooting routinely needs diagnostic commands. Ship commands (`git commit/push`, `gh pr create/edit`) remain **fully gated by L1 in every mode**: explore never weakens the in-session ship gate, so an auto-misclassification only relaxes auto-continuation — the safe direction. For the *git hooks* (defense-in-depth outside Pi), the sidecar records *who* chose the mode (`taskModeSource`): pre-commit/pre-push treat explore as advisory **only when the user chose it explicitly** (dialog or `/gate-mode`) — this protects the user's own manual commits during an explore session, while an auto-classified explore keeps the hooks fully enforced. An LLM-decided mode also keeps `taskModeSource: "auto"` — semantic classification never downgrades the commit hooks either. You can override the decision anytime with `/gate-mode loop|explore`. In print/JSON mode, where no selection UI is available, the extension defaults safely to the loop workflow (without consulting the LLM); cancelling the dialog also defaults to loop.

### LLM semantic guard layer (DeepSeek V4 Flash)

Four guards get an additional **semantic layer** backed by a fast, cheap model (`deepseek/deepseek-v4-flash`, configurable via `llmGuards.model`). Design invariants, enforced by construction in `lib/llm-classify.ts`:

1. **Tighten-only** — an LLM verdict can only *add* a block or pick the safer side of an ambiguous case. Deterministic checks run first and short-circuit; the LLM is never asked to *approve* something a deterministic check blocked.
2. **Fail-back** — timeout (8s), spawn failure, or unparseable output degrade each guard to its exact pre-LLM deterministic behavior. No network ⇒ no regression.
3. **Injection-resistant** — classified text is wrapped in `<data>` tags as untrusted data; a hostile prompt can at worst flip one classification, which by (1)+(2) cannot open the gate.

| Guard | Deterministic base | What the LLM layer adds |
|---|---|---|
| Task-mode (`llmGuards.taskMode`) | regex hints + dialog | Semantic intent judgment; quoted text no longer pollutes the decision |
| AI attribution (`llmGuards.aiAttribution`) | `COMMIT_MSG_FORBIDDEN` regexes | Paraphrases: “pair-programmed with an assistant”, “drafted by a language model” |
| English check L5/L6 (`llmGuards.englishCheck`) | Unicode non-Latin-script detection | The romanization blind spot: pure-Latin pinyin/romaji commit messages, PR text, and test labels |
| Ship detect (`llmGuards.shipDetect`) | ~static shell parser (`lib/ship-detect.ts`) | Suspicious git/gh commands with dynamic constructs (base64-piped shells, inline-defined aliases) the static parser cannot resolve — a positive answer *adds* a detection; “none” changes nothing |

The L6 test-label check also moves **left**: the same lexer the git hook uses now runs at *edit time* in the extension (immediate feedback + the semantic layer), while the zero-dependency hook remains the deterministic backstop at commit time — hooks never call an LLM, so offline commits behave exactly as before. Edit-time scanning works on the **full projected post-edit file** (`lib/edit-projection.ts`): the current file content with every `oldText→newText` applied — so an edit that replaces only a label *string* still exposes the surrounding `it(...)` call to the lexer, and a fragment that cannot be applied is still appended and scanned rather than skipped.

The classifier child process is **fully isolated**: `pi -p --no-session --no-extensions --no-skills --no-tools --no-context-files --no-prompt-templates`, argv-array spawn (never a shell string), stdin closed immediately, 8s timeout. No extensions means the child cannot recursively load review-gate; no tools means a prompt-injected classifier can at worst emit wrong JSON — and the verdict parse is strict (the entire stdout must be exactly the one-key JSON object; echoed data or chatty prefixes ⇒ fail-back to deterministic behavior).

## Architecture — three enforcement layers

```
L1  Ship gate (HARD)      tool_call → block git commit/push, gh pr create/edit
                          until review READY + precommit PASS on the
                          current worktree fingerprint
L2  Auto-continuation     agent_settled → if gates unmet, inject
                          [REVIEW_GATE_RESUME] follow-up (recursion-guarded,
                          max 10 rounds, plateau detection)
L3  Git hooks             pre-commit / pre-push / commit-msg verify the gate
                          sidecar even for commits made outside Pi
L4  Output-language gate  before_agent_start → UNCONDITIONALLY inject a
                          strict Simplified-Chinese directive every turn
                          (thinking in Chinese too; protocol English tokens
                          READY/BLOCKED/commit-msg/code stay exempt)
L5  Commit/PR English     tool_call → ADVISORY warning when a git commit message
                          or PR title/body is PREDOMINANTLY non-English (majority
                          body); the language directive (L4) + reviewer enforce
                          English ship text; a minority foreign token passes
L6  Test-label English    pre-commit → block a staged it/test/describe label
                          that is PREDOMINANTLY non-Latin, unless a
                          `// review-gate: allow-non-english` (line) or `-file`
                          marker exempts it
```

**Arbiter (circular-block escape).** Layered on top of L1: when the ship gate
blocks a lone `gh pr edit` (PR text) whose only fix is that same blocked action,
the agent may call `request_arbitration`. An independent arbiter rules
GATE_WINS / AGENT_WINS (a single-use, tightly-bound bypass of that one command)
/ HUMAN. It can never release a commit/push/pr-create and fails closed to
GATE_WINS — see [Arbiter](#arbiter-a-narrow-fail-closed-gate-exception).

State lives in **two places**: Pi session entries (`pi.appendEntry`, survives
context compaction) and a sidecar file `.pi/review-gate-state.json` (readable
by the git hooks without Pi).

## Judges on a stronger model, pinned at `max`

The gate is only as good as the brain judging the work. Three independent roles
run on a **top-tier reasoning model at `max` thinking**, each with a fallback
priority list (first available wins). The models are **pinned in the agent
definitions** — decided up front, not re-selected per task:

| Role | When | Gates? | Model priority (first = preferred) | Thinking |
|------|------|--------|-------------------------------------|----------|
| **`adviser`** (`agents/adviser.md`) | *before / during* work — the main agent is **encouraged to proactively consult** it on design, tradeoffs, risks, hard decisions | no, advises only | Fable 5 → GPT-5.6 Sol → Opus 4.8 → GPT-5.5 | `max` |
| **`reviewer`** (`agents/reviewer.md`) | *after* a diff exists — independent audit that emits the recorded verdict | yes (READY/BLOCKED) | GPT-5.6 Sol → Fable 5 → GPT-5.5 → Opus 4.8 | `max` |
| **`arbiter`** (`agents/arbiter.md`) | *only* when the agent contests a **circular** ship block via `request_arbitration` | rules GATE_WINS / AGENT_WINS / HUMAN on one `gh pr edit` | GPT-5.6 Sol → Fable 5 → GPT-5.5 → Opus 4.8 | `max` |

`thinking` is a single value, not a fallback list; `max` is the highest valid
pi level (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` — pi clamps
models that lack a level down automatically). Proactively consulting the
adviser early is cheaper
than a failed review later, so the extension's per-turn reminder and the
`review-loop` skill both nudge for it.

### "Which model is strongest?" — leaderboard reference for the pins

`lib/model-ranking.ts` is the *reference* used to choose the pinned models. It
scores model **families** from public capability leaderboards and can rank
candidates by **capability × cross-family diversity** (a strong different-family
model doesn't share the main agent's blind spots):

- **Artificial Analysis** — Intelligence Index (0–100), free API key
- **OpenRouter** — keyless catalog (family/availability)
- **LMArena Elo**, **LiveBench** — keyless datasets

It is a decision aid, **not a runtime selector** — the judge models are fixed in
the agent frontmatter above. The extension itself is **fail-closed and
network-free**; ranking is a *pure function over an offline snapshot*. Refresh
the snapshot out-of-band with
the **opt-in, gate-external** fetcher:

```bash
export ARTIFICIAL_ANALYSIS_API_KEY=...   # free key from artificialanalysis.ai/api
node scripts/fetch-leaderboard.mjs           # dry-run: print the family table
node scripts/fetch-leaderboard.mjs --write   # rewrite the snapshot, then: npm test
# after a GLOBAL install the ranking lib lives elsewhere; point the fetcher at it:
node ~/.pi/agent/scripts/pi-review-gate-fetch-leaderboard.mjs --write \
  --snapshot-file ~/.pi/agent/extensions/pi-review-gate/lib/model-ranking.ts
```

## Lessons from -dev-flow PR #7, wired in

| # | PR #7 finding | How pi-review-gate handles it |
|---|---------------|-------------------------------|
| 1 | `test/**/*.test.js` under `/bin/sh` doesn't recurse — 538 tests silently skipped | precommit runner emits a loud `[glob-trap]` warning for `node --test **` scripts; our own `npm test` uses `$(find ...)`; a meta-test reproduces npm's `/bin/sh` expansion and asserts full coverage |
| 2 | First-fence-only verdict parsing (fail-open) | `parseReviewOutput` scans **all** JSON fences; **worst verdict wins** (BLOCKED > NEEDS_HUMAN > READY); READY with P0/P1 findings downgraded to BLOCKED |
| 3 | All-steps-skipped precommit showed PASS | Three distinct verdicts: `✅ PASS` / `❌ FAIL` / `⚠️ NO CHECKS RUN`. NO_CHECKS_RUN blocks the ship gate — configure real checks or explicitly `/gate-bypass` |
| 4 | NotebookEdit / `.ipynb` bypassed every gate | `ipynb` is in the single CODE_EXTENSIONS list; `coalesceToolPath` reads `path`/`file_path`/`notebook_path`/every spelling; NotebookEdit is in the edit-tool set |
| 5 | Extension lists drifted between hook sites | Exactly ONE `CODE_EXTENSIONS` list in `lib/constants.ts`; a structural test fails if any other file declares its own list |
| 6 | Prettier fetched from the network on every edit | No formatter at all; a structural test asserts the extension contains no `fetch(`/`npx` |
| 7 | Gate state lost on context compaction | State persisted via `appendEntry` (compaction-immune) + sidecar; `session_compact` re-injects a `[REVIEW_GATE_RESUME]` state summary |
| 8 | Bare `AI` matched "maintainer"/"domain" | Only `AI` is `\b`-bounded; `GPT`/`OpenAI` stay unbounded to catch ChatGPT/GPT-4 — enforced in both the extension and the commit-msg git hook, with FP regression tests |

Also ported: **one-way stale-state reconciliation** (git-clean can clear change
flags, but only edits can set them), **untracked-file-aware fingerprints**
(`-uall`, PR #7's `-uno` regression), and **atomic sidecar writes** (temp+rename
so a crash can't leave truncated JSON for a fail-open parser).

### -dev-flow features ported beyond PR #7

| -dev-flow feature | pi-review-gate port |
|-----------------------|---------------------|
| `auto-loop-project.md` `## Max Rounds` override (R6) | `.pi/review-gate.json` `"maxRounds"` — JSON instead of markdown parsing; **clamped to 3–50** so a forged config can't make the cap unreachable |
| "Think Harder" strategic reset near cap (R10) | `"thinkHarder"` (default on): when the loop is still BLOCKED within 3 rounds of the cap, a one-shot `[STRATEGIC_RESET]` checklist is injected; fired-flag persisted in gate state |
| "Git Memory" post-compaction context (R9) | `"gitMemory"` (default on; `false` disables): filtered `git log/diff/status` snapshot appended to the compaction resume message — secret-pattern line filter, 40-line cap, argv-only git (no `eval` pipeline like the original) |
| Auto-loop prohibited behaviors (`rules/auto-loop.md`) | Baked into the per-turn system-prompt reminder: no "fixed" without re-review, no permission-asking, no context-length excuses, no completion-style summaries while gates are unmet |
| `pre-edit-guard` `.git/` protection | `.git/…` added to `SENSITIVE_FILE_PATTERNS` — the model can't rewrite `.git/hooks/pre-commit` to disarm L3 (`.gitignore`/`.github` still editable) |
| Self-improvement lesson log (`rules/self-improvement.md`) | `/gate-lesson <text>` appends numbered lessons to `.pi/review-gate-lessons.md`; promote 3+ recurrences into rules |

Per-project config lives in `.pi/review-gate.json`:

```jsonc
{
  "maxRounds": 10,     // 3..50 — loop hard cap (clamped, fail-safe)
  "thinkHarder": true, // one-shot [STRATEGIC_RESET] checklist near the cap
  "gitMemory": true,   // default ON — [GIT_CONTEXT] after compaction; false disables
  "docSync": true,     // default ON — reviewer code↔doc attestation; false disables
  "llmGuards": {                // LLM semantic guard layer (all tighten-only + fail-back)
    "model": "deepseek/deepseek-v4-flash", // "provider/model" — fixed default
    "taskMode": true,           // semantic loop/explore classification
    "aiAttribution": true,      // paraphrased AI attribution in commit messages
    "englishCheck": true,       // romanized non-English in commit/PR/test-label text
    "shipDetect": true          // extra ship-command layer on suspicious bash
  }
}
```

Every field is validated independently; a missing/corrupt config silently
falls back to defaults and can never loosen the gate.

### Enforced code↔doc sync (`docSync`, default ON)

A mechanical "a `.md` file was touched" rule would be satisfied by appending a
trivial line, so `docSync` enforces *judgment*, not file counts: every code
change requires the READY review's verdict JSON to carry an explicit
attestation —

```json
{"gate": "READY", "docSync": "UPDATED" | "NOT_NEEDED", "findings": []}
```

- "Docs" means the project's **requirement / plan / feature documentation**
  (`docs/`, README, specs) — NOT agent memory files (CLAUDE.md, AGENTS.md,
  progress.md); touching those does not count.
- `UPDATED` — the reviewer verified docs were *meaningfully* updated for the
  behavior change (token doc touches are a P1 finding ⇒ BLOCKED).
- `NOT_NEEDED` — the reviewer states why no doc change is required.
- The attestation is required on **every** code change — touching a doc file
  does not exempt it, so the gate cannot be gamed by a cosmetic doc edit.
- Missing/forged attestation ⇒ unmet requirement (fail-closed), enforced both
  in `unmetRequirements` and mirrored in the git pre-commit hook.
- Disable per project with `"docSync": false` in `.pi/review-gate.json`; a
  missing or corrupt config keeps the default (enforced) — fail-safe, never
  fail-open.

## Install

### Global (recommended — works on all projects)

```bash
# Option A: via npm/npx (if published)
npx pi-review-gate-install

# Option B: from local clone
bash ~/workspace/pi-review-gate/scripts/install-global.sh
```

Then restart Pi or run `/reload`. The extension auto-discovers from `~/.pi/agent/extensions/`.

### Per-project

Use the installer (it lays out `.pi/` the same way as the global install, so the
extension's relative imports and the trusted precommit runner both resolve — a
plain `cp` of `extensions,lib,skills` does NOT install the runner and breaks
`run_precommit`):

```bash
# from the target repo root
bash ~/workspace/pi-review-gate/scripts/install-project.sh
```

### Git hooks (defense-in-depth)

Per repo, idempotent, chains existing hooks, supports worktrees:

```bash
~/workspace/pi-review-gate/scripts/install-git-hooks.sh
```

## Usage

Work normally. The moment the model edits a code or doc file:

1. The gate arms (`review: PENDING`, `precommit: NOT_RUN` in the status bar).
2. Any `git commit` / `git push` / `gh pr create` / `gh pr edit` is **blocked** with the exact
   list of unmet requirements.
3. When the model settles without clearing gates, a `[REVIEW_GATE_RESUME]`
   follow-up restarts the loop (max 10 rounds, plateau-guarded).

The loop protocol (also available as the `review-loop` skill):

```
edit code
  → run an independent review (subagent / codex MCP / second model)
  → call record_review with the FULL reviewer output      # all fences parsed, worst wins
  → BLOCKED? fix everything, re-review, record again
  → READY?  call the run_precommit tool                   # extension spawns the trusted runner
  → PASS?   call declare_done                             # re-validated server-side
  → ship    (git commit now passes the gate)
```

The reviewer should end with a fenced JSON verdict:

```json
{"gate": "READY" | "BLOCKED" | "NEEDS_HUMAN",
 "findings": [{"file": "src/x.ts", "line": 42, "severity": "P1", "issue": "..."}]}
```

Review verdicts require **JSON fences**. Precommit verdicts are NOT parsed from
bash output at all: the `run_precommit` tool spawns the trusted runner itself
and records the result from a verified nonce receipt, so a `## Overall: ✅ PASS`
sentinel printed by any other command can never grant a PASS.

### Commands

| Command | Effect |
|---------|--------|
| `/gate-status` | Show workflow mode, verdicts, rounds, fingerprint, unmet requirements |
| `/gate-mode loop\|explore` | Switch the session workflow. `explore` makes gates advisory and lets the AI self-complete (edits/bash stay available but read-only work is preferred; ship commands stay gated). Only the user can invoke this command. |
| `/gate-bypass <reason>` | Disable ship blocking (user-confirmed, reason required, logged in state) |
| `/gate-reset` | Reset gate state and ask for the workflow again on the next task |
| `/gate-lesson <text>` | Append a lesson to `.pi/review-gate-lessons.md` (self-improvement log) |

### sd0x-dev-flow workflow commands

These high-value commands are native Pi extension commands, so they work as short
aliases without loading a large skill catalog into every session. Commands that
can ship default to a dry run and still pass through the same hard review gate.

| Command | Effect |
|---------|--------|
| `/review [focus]` | Start the independent review → `record_review` → fix/re-review loop |
| `/precommit` | Run the trusted full precommit gate |
| `/precommit-fast` | Run the trusted fast precommit gate |
| `/verify [focus]` | Run the strongest available lint/typecheck/build/test ladder |
| `/next-step` | Recommend the next action from git and gate state without executing it |
| `/risk-assess [focus]` | Score breaking surface, blast radius, scope, migration, and regression risk |
| `/smart-commit [--execute]` | Propose cohesive English commits; execute only with an exact standalone `--execute` token and open gates |
| `/create-pr [--execute] [base]` | Prepare an English PR by default; create/update only with an exact standalone `--execute` token and open gates |
| `/load-pr-review [PR]` | Load and triage GitHub PR review feedback without auto-fixing |
| `/watch-ci [PR or run]` | Monitor GitHub Actions to pass/fail/timeout without mutating CI |

Pi already exposes packaged skills as `/skill:<name>`. The commands above are
implemented as lightweight workflow dispatchers because their useful behavior
maps directly onto Pi's existing tools, subagents, `gh`, and trusted gate. Broad
or platform-specific sd0x skills are intentionally not copied wholesale.

Git-hook bypass (human escape hatch): `REVIEW_GATE_BYPASS=1 git commit ...`

### Custom tools exposed to the model

| Tool | Purpose |
|------|---------|
| `record_review` | Feed the raw reviewer output into the gate. Parses every fence; worst verdict wins; records round history for plateau/oscillation detection. A fence whose JSON is broken by an unescaped quote is salvaged fail-closed (its gate word is recovered, but a salvaged READY is downgraded to BLOCKED). |
| `run_precommit` | The ONLY way to record a precommit PASS. The extension spawns the bundled runner with argv (no shell) and trusts only a private, nonce-stamped receipt the runner wrote — bash stdout can never forge a PASS. |
| `declare_done` | Completion claim, **re-validated server-side** — rejects with `isError` if any gate is unmet (the reject hint reminds you that late doc/handoff edits invalidate the READY fingerprint, so finish all edits before the final review). "Declaring ≠ executing." On accept it clears the per-task round history so a subsequent task in the same session starts its round counter fresh. |
| `request_arbitration` | Contest a ship block the agent believes is **circular** (the only remedy is an action the block forbids). Narrow + fail-closed — see [Arbiter](#arbiter-a-narrow-fail-closed-gate-exception). |

### Arbiter (a narrow, fail-closed gate exception)

Every other LLM in this project is **tighten-only** — it may only ADD a block,
never lift one (`lib/llm-classify.ts`). The **arbiter** is the one deliberate,
tightly-scoped exception, added to break a real **deadlock**: a pre-existing
non-English PR body was flagged (L5/reviewer), but the only way to fix it —
`gh pr edit` — is itself hard-blocked until the gate is green, and the gate
won't go green until the body is fixed. Circular.

When the ship gate blocks a **lone `gh pr edit`** (limited to
`--title`/`--body`/`--body-file`), the agent may call `request_arbitration`
with its argument. The extension then:

1. Confirms the block is **real and arbitrable** (`lib/arbitration.ts`
   `parseArbitrableAction` requires EXACTLY one `gh pr edit` with only
   `--title`/`--body`/`--body-file` — it rejects `git commit`, `git push`,
   `gh pr create`, compound/piped commands, a second *visible* ship op detected
   inside the command, and any out-of-scope flag — so the arbiter can never
   grant a bypass for a command *shaped* as anything but a single `gh pr edit`
   (a substitution hidden in an argument still executes when the granted raw
   command re-runs — see the residual-risk note in the threat model). There is
   deliberately **no content pre-filter** that
   rejects a command just for containing `$`/backtick/substitution characters:
   that filter was the gate second-guessing the command text, and its
   over-broad form deadlocked a legitimate PR markdown body
   (`--body '… `code` … $var …'`) out of ever reaching the arbiter. Judging a
   dubious command is the **arbiter's** job — it is spawned tool-less with every
   input wrapped as untrusted data and instructed to judge content, never obey
   it, and any bypass it grants is single-use and bound to the command's exact
   raw bytes.
2. Gathers **trusted ground truth itself** (`gh pr view`, `git log`, the
   proposed body file) and spawns an **independent** arbiter subagent
   (`agents/arbiter.md`, a top-tier model) tool-less and isolated (same argv/no
   -tools discipline as the classifier) — the agent **cannot hand-write** the
   verdict, and its argument is passed as clearly-marked **untrusted** data.
3. Applies the verdict, one of three outcomes:
   - **GATE_WINS** → the agent must comply (fix the underlying problem).
   - **AGENT_WINS** → a **single-use** bypass token is issued, bound to the
     exact command digest + worktree fingerprint + review round + body-file
     content, with a short TTL. It authorizes **one** run of that exact
     `gh pr edit`, is **consumed on the attempt**, and is invalidated by any
     edit, new review round, fingerprint change, or `/gate-reset`. It never
     touches the code review loop (review stays PENDING, precommit stays
     NOT_RUN).
   - **HUMAN** → a 3-way dialog (`Gate wins` / `Allow this exact edit once` /
     `Pause gate and wait`) hands the decision to the user; **no UI → fail-closed
     to GATE_WINS**.

Fail-closed everywhere: a disabled arbiter, an out-of-scope command, the
per-session cap (default 3), a re-roll of an already-decided action, a spawn/
parse failure, or an unknown verdict all resolve to **GATE_WINS**. The token is
**in-memory only** (never persisted to the sidecar — a restart legitimately
drops it). Every decision is appended to `.pi/review-gate-arbitration.log`.
Configure via `.pi/review-gate.json` → `"arbiter": { "enabled", "model",
"maxPerSession" }`.

### Fail-closed inventory

- Gate state missing/corrupt/unknown-schema → ship blocked
- Worktree fingerprint unreadable (git broken) → ship blocked
- Review verdict unparseable → stays PENDING → ship blocked
- Precommit PASS forged from bash stdout (`printf '## Overall: ✅ PASS'`, `… || node runner`, here-docs, quoted operators) → impossible: only `run_precommit` (trusted spawn + nonce receipt) can record PASS
- Precommit receipt missing / nonce mismatch / cwd mismatch / oversized / non-zero exit → ERROR → ship blocked
- Precommit ran zero checks → `NO_CHECKS_RUN` (distinct exit code 2) → ship blocked
- Any code/doc edit after READY/PASS → fingerprint mismatch → ship blocked
- Unknown/forged verdict enum in the sidecar (e.g. `precommit:"READY"`) → rejected by the loader **and** default-denied in `unmetRequirements` and the git hook → ship blocked
- Ship command hidden in `bash -c` / `eval` / `xargs` → still detected (over-detection preferred)
- Ship command obfuscated via `g""it` / `g"i"t` / `git${IFS}commit` / `git$IFS"commit"` / `${x:=git}` / `${x:-g}${y:-it}` / `$(printf git) commit` (dynamic head) / `\g\i\t` / backslash-newline continuation → shell-dequoting + de-obfuscation + dynamic-head detection still catch it (fail-closed)
- Ship command hidden behind an INLINE git alias (`git -c "alias.ship=commit --no-verify" ship`, attached `-calias.x=commit`, shell-alias body `!git commit`, or `--config-env=alias.x=VAR`) → the alias body is scanned for `commit`/`push` and flagged (fail-closed; opaque config-env bodies default to commit)
- `max_rounds` (10), a 3-round finding plateau, or 3 READY→BLOCKED oscillations (the reviewer keeps signalling READY then finding fresh problems) → loop stops, escalates to the human — no infinite burn
- Predominantly non-English `it`/`test`/`describe` label committed without a bypass marker → pre-commit (L6) blocks with the offending `file:line` (missing scanner on an older install → warn-and-skip, never a bricked commit)
- Arbitration requested with no real block, an out-of-scope command (commit/push/pr-create/compound/piped, a second ship op detected in the command, or an out-of-scope flag), the per-session cap hit, a re-rolled decision, arbiter spawn/parse failure, unknown verdict, or a no-UI HUMAN outcome → **GATE_WINS** (block stands). An AGENT_WINS token is single-use, content+worktree+round bound, in-memory only, and never green-lights the code review loop.

### Threat model & residual risk (explicit)

pi-review-gate defends against a **cooperative-but-fallible AI agent** taking
shortcuts or generating obfuscated shell — unintentionally or cheaply bypassing
the gate. Within that model the PASS trust path is single-entry (only
`run_precommit`), bash stdout can never forge a PASS, and the common ship-command
obfuscations above are detected.

The **arbiter** (the one capability that can LIFT a block) stays inside this
model: it can only ever release a single top-level `gh pr edit` (PR text) —
never a top-level commit/push/pr-create — the extension (not the agent) spawns
it and gathers its evidence, and every failure mode falls back to GATE_WINS. Its
token is raw-command+worktree+round bound and single-use.

**Residual risk of the arbiter bypass (be explicit).** There is deliberately no
content pre-filter on the arbitrated command (removing the over-broad one that
deadlocked legitimate PR markdown). The structural guards guarantee the
authorized command is shaped as ONE `gh pr edit` with only title/body/body-file
and no *visible* second ship op — but they do NOT semantically evaluate a shell
substitution the command may contain. So a granted bypass runs the EXACT raw
command through the shell, and a substitution in an argument
(`--body "$(…)"`, `` --title "`…`" ``) executes during expansion *before*
`gh pr edit`. A hostile substitution (e.g. `--body "$(… | base64 -d | sh)"`)
could therefore run arbitrary shell — including a hidden `git push` — under a
granted token. This is bounded by: the arbiter must first grant AGENT_WINS
(it is spawned tool-less, judges every input as untrusted data, is told an
attempt to smuggle a command is itself grounds to refuse, and biases
GATE_WINS > HUMAN > AGENT_WINS); the human 3-way dialog on HUMAN; the per-session
cap; single-use raw-byte binding; and the same-user threat-model boundary below
(a same-UID agent can already run any shell directly, so this grants no new
authority it lacks — it only means the arbiter's grant is a *command execution*,
not a proven-safe "edit PR text only" operation). If you want the bypass to be
provably text-only, run the arbitrated `gh pr edit` via `shell:false` argv
instead of re-running the raw command (future hardening).

It explicitly does **not** claim to defend against a principal with the current
user's write access who deliberately tampers with the control plane. These are
**out of scope** (a same-UID actor could defeat any purely-local check,
including a content hash, by editing the checker too):

- Editing the extension, the installed runner, git hooks, or the gate sidecar.
- Arbitrary dynamic shell/scripts that construct an unknown command at runtime
  (`$(cat /tmp/x)`, `$COMMAND`, a generated executable). The ship gate blocks
  *recognizable* dynamic ship heads but cannot statically decide Turing-complete
  shell.
- Deleting/disabling local git hooks, `git --no-verify`, or `core.hooksPath`.
- Direct network/API push that never runs a local hook.
- Explicit `/gate-bypass` or `REVIEW_GATE_BYPASS=1` (user-authorized escape).
- A PRE-EXISTING git alias whose definition lives in the user's git config
  (`git ship`, not defined on the command line) — statically invisible, same
  class as editing the control plane. (An alias *defined inline* on the command
  line, e.g. `git -c alias.ship=commit ship`, IS detected.)
- Fabricating the reviewer output fed to `record_review` — the reviewer is a
  subagent whose transcript necessarily transits the main agent, so the verdict
  rests on the cooperative assumption (the main agent can equally write the
  sidecar directly). Making it unforgeable would require the extension to spawn
  the reviewer itself and verify a receipt, like `run_precommit` (future
  hardening), not a runtime source check.

The git hooks (L3) are a useful second layer, not a complete boundary: they
depend on the sidecar existing and being untampered, and `gh pr create/edit` is not a
local commit.

### Output-language gate (L4)

The model must produce **strict Simplified Chinese** for all user-facing output,
and keep its thinking in Chinese where practical. This can't be hard-blocked at
the ship layer (a `git commit` says nothing about language, and scoring prose as
"Chinese enough" would false-positive on code/paths/commands — the fail-open
trap this project avoids), so it is enforced the reliable way: a single
directive (`LANGUAGE_DIRECTIVE` in `lib/constants.ts`) injected
**unconditionally every turn** in `before_agent_start`, before any early return.
Protocol-fixed English tokens are explicitly exempted — verdict enum values
(`READY`/`BLOCKED`/`NEEDS_HUMAN`), the precommit `## Overall:` sentinel, commit
messages, code, identifiers, and paths — so the language rule can never corrupt
the review gate's own parsing.

### Commit/PR English gate (L5, advisory)

Complementary to L4: while L4 makes user-facing *chat* Simplified Chinese, L5
asks for **commit messages and PR title/description in English**. It is
**advisory, not a hard block**: `-m`/`--title`/`--body` extraction is a
heuristic and can mis-read complex shell forms (e.g. a heredoc-substituted
message `git commit -m "$(cat <<'EOF' … EOF)"`), so a wrong language guess must
never stop a legitimate ship. The check uses a **majority-body policy**
(`lib/lang-detect.ts`): after stripping non-prose (code fences, inline code,
URLs, Markdown link destinations, HTML tags) it counts letters and flags the
text only when a **non-Latin script** (CJK, Kana, Hangul, Cyrillic, …) is the
**majority** of them — so a mostly-English body with a **stray/minority** quoted
foreign term (e.g. one `确认中`) **passes**, while a predominantly non-Latin body
warns. Each text (title, body, each commit message) is judged **separately** so
a long English body can't mask a fully non-English title. The pure-Latin
romanized-language semantic layer runs only when the text has **zero** non-Latin
letters. Counting is **asymmetric** so markup can't hide a non-Latin body:
non-Latin letters are counted over the **full** text (a `确认中` inside a code
fence still counts), while Latin letters are counted over **prose only** (a big
Latin code block can't dilute the ratio). Known conservative side-effect: an
English text quoting a **large** non-Latin code sample can tip to "majority
non-Latin" — advisory-only for L5 (a warning), and a deliberate non-English test
label can be exempted with the L6 bypass marker. Enforcement lives with the humans-in-the-loop: the L4 language
directive instructs the agent to write ship text in English every turn, and the
reviewer treats a **predominantly** non-English commit message or PR title/body
as a **P1 finding** (a single minority foreign token is **not** a finding). If a
non-English PR body can only be fixed by an action the gate itself blocks (the
circular deadlock), the agent can escalate via the
[arbiter](#arbiter-a-narrow-fail-closed-gate-exception).

### Test-label English gate (L6)

Test descriptions must be **English** too. Enforced at the `pre-commit` hook
(L3) layer by `scripts/scan-test-labels.cjs`, which scans the **staged** content
of test files (`*.test.*`, `*.spec.*`, or under `__tests__/`, JS/TS only) for
`it(…)` / `test(…)` / `describe(…)` (incl. `.only`/`.skip` chains) whose
string-literal description is **predominantly** a non-Latin script. Same
majority-body detection as L5 (`lib/lang-detect.ts`, mirrored in the CJS
scanner), so diacritics/emoji/digits pass, a minority foreign token passes, and
only a label whose letters are **mostly** another writing system is blocked.

When a test description legitimately must be non-English, exempt it with a
bypass marker — recognized **only in `//` line comments**:

```js
// review-gate: allow-non-english
it('返佣金额按 currencyRate 换算', () => { /* … */ });
```

A standalone marker line exempts the **first test call on the next line**; a
trailing marker (`it('…'); // review-gate: allow-non-english`) exempts the call
on **its own line**. Each marker exempts **exactly one** call (so a marker can
never silently exempt a neighbour). To exempt an entire file, put
`// review-gate: allow-non-english-file` in a `//` comment within its first 5
lines.

Scope is deliberately narrow to keep false positives near zero. A tiny
zero-dependency JS/TS lexer classifies code vs. string vs. comment vs. regex, so
`it(` inside a comment, a string, a regex literal, or a member call
(`foo.it(...)`) is normally not mistaken for a test. Only **static** string
labels are checked; interpolated template labels (`` `runs ${n}` ``) are
skipped. Known MVP limitations (not blocked): a parenthesized label `it(('x'))`,
an `it.each([...])('x')` data label, and `/* */` block-comment markers are not
handled — use a `//` marker. Because the lexer is a heuristic (not a full
parser), regex-vs-division is resolved **fail-closed against hiding a real test
call**: a `/` after a bare `}`, or after `of`/`in` (`for (x of /re/)`), is read
as division, so a genuine regex literal in those rare positions is scanned as
code and a stray `it(` inside it could need a bypass marker — an over-report
(one marker) is preferred to swallowing a real call. The lexer is Unicode-aware
(ECMAScript ID_Start/ID_Continue), so non-ASCII identifiers are handled, and
string/template labels have their JS escapes decoded (`\uXXXX`, `\u{…}`,
`\xXX`), so a label written as `it('\u4e2d\u6587')` is still caught — decoding
matters because tool-generated code (JSON round-trips, i18n pipelines)
legitimately escapes non-ASCII, which is inside the cooperative-but-fallible
model.

Two residuals are accepted and out of scope, both requiring a DELIBERATELY
obfuscated call head, which no cooperative agent produces and which belongs to
the same excluded class as editing the control plane (see the threat model
above): a **Unicode-escaped identifier** call head (`\u0069t('中文')` for
`it('中文')` — semantically equivalent under JS identifier-escape rules, but a
plain-text `it` is never written that way except to evade), and a contextual
keyword used as a **bare identifier** in a classic sloppy script
(`var await = 5; await / it(…) / 2`), which is invalid in ESM/`async` and
vanishingly rare in real test files. Neither can cause a SECONDARY miss: an
escaped head only hides its own call, and every following plain call is still
scanned independently.
Like the other layers, L6 is short-circuited by `/gate-bypass` (state-level) and
`REVIEW_GATE_BYPASS=1`. Missing scanner (older installs) → warn-and-skip, never
a blocked commit; a violation → the commit is blocked with the offending
`file:line`.

## Development

```bash
npm test        # 340 tests, node:test native TS (no build step)
```

Layout:

```
extensions/review-gate.ts     Pi extension (L1 + L2 + L4, tools, commands)
lib/workflow-commands.ts      sd0x-dev-flow command catalog and safe dispatcher prompts
lib/constants.ts              THE code-ext list, sensitive patterns, msg regexes, LANGUAGE_DIRECTIVE (L4)
agents/adviser.md             consulting subagent, pinned model @ max (proactively consulted)
agents/reviewer.md            gatekeeper reviewer override, pinned model @ max
lib/model-ranking.ts          leaderboard-scored judge ranking (reference for the pins)
scripts/fetch-leaderboard.mjs opt-in, gate-external leaderboard fetcher (the only network I/O)
lib/shell-lex.ts              quote-aware shell lexer (segments + dequoted tokens)
lib/lang-detect.ts            L5: non-Latin-script detection for commit/PR English advisory
scripts/scan-test-labels.cjs  L6: non-English test-label scanner (pre-commit, staged content)
lib/precommit-receipt.ts      pure receipt validator (exit/verdict/count table → PASS/FAIL/ERROR)
lib/ship-detect.ts            bash → ship-command detection (+evasion & de-obfuscation)
lib/fingerprint.ts            worktree fingerprint (HEAD+staged+unstaged+untracked)
lib/gate-state.ts             state machine, sidecar, unmetRequirements, plateau
lib/verdict-parse.ts          all-fence worst-wins verdict parser
scripts/precommit-runner.mjs  PASS/FAIL/NO_CHECKS_RUN runner; writes nonce receipt for run_precommit
scripts/install-project.sh    per-project installer (same layout as global)
scripts/install-git-hooks.sh  chained installer for L3
hooks/pre-commit|pre-push|commit-msg
skills/review-loop/SKILL.md   the loop protocol as a Pi skill
test/                         340 tests incl. PR #7 regression suite
```

## License

MIT
