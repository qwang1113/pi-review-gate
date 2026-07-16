# pi-review-gate

**Quality gates for [Pi](https://github.com/earendil-works/pi-coding-agent)** — ship-gate hard blocking, persistent gate state, auto-continuing review loop. Globally installable.

> Quality gates the model can't skip: `git commit`, `git push`, and `gh pr create`
> are **hard-blocked** at the `tool_call` layer until an independent review is
> READY **and** precommit PASSes — both bound to the exact worktree state they
> verified.

## Why

Pi has no `Stop` event to prevent the model from quitting — but it has something better: `tool_call` blocking. Instead of intercepting "the model wants to stop", we intercept "the model wants to ship". Combined with `agent_settled` auto-continuation, the model fixes → re-reviews → re-runs precommit until every gate is green, and *cannot* commit around it.

## Architecture — three enforcement layers

```
L1  Ship gate (HARD)      tool_call → block git commit/push, gh pr create
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
L5  Commit/PR English     tool_call → block git commit / gh pr create whose
                          message or PR title/body contains a non-Latin script
                          (commit & PR text must be English)
L6  Test-label English    pre-commit → block a staged it/test/describe label in
                          a non-Latin script, unless a `// review-gate:
                          allow-non-english` (line) or `-file` marker exempts it
```

State lives in **two places**: Pi session entries (`pi.appendEntry`, survives
context compaction) and a sidecar file `.pi/review-gate-state.json` (readable
by the git hooks without Pi).

## Two judges on a stronger model, pinned at `xhigh`

The gate is only as good as the brain judging the work. Two independent roles
run on a **top-tier reasoning model at `xhigh` thinking**, each with a fallback
priority list (first available wins). The models are **pinned in the agent
definitions** — decided up front, not re-selected per task:

| Role | When | Gates? | Model priority (first = preferred) | Thinking |
|------|------|--------|-------------------------------------|----------|
| **`adviser`** (`agents/adviser.md`) | *before / during* work — the main agent is **encouraged to proactively consult** it on design, tradeoffs, risks, hard decisions | no, advises only | Fable 5 → GPT-5.6 Sol → Opus 4.8 → GPT-5.5 | `xhigh` |
| **`reviewer`** (`agents/reviewer.md`) | *after* a diff exists — independent audit that emits the recorded verdict | yes (READY/BLOCKED) | GPT-5.6 Sol → Fable 5 → GPT-5.5 → Opus 4.8 | `xhigh` |

`thinking` is a single value, not a fallback list; `xhigh` is the highest valid
pi level (`ultra`/`max` are **not** in `THINKING_LEVELS` — pi clamps unsupported
models down automatically). Proactively consulting the adviser early is cheaper
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
| "Git Memory" post-compaction context (R9) | `"gitMemory"` (default off, opt-in): filtered `git log/diff/status` snapshot appended to the compaction resume message — secret-pattern line filter, 40-line cap, argv-only git (no `eval` pipeline like the original) |
| Auto-loop prohibited behaviors (`rules/auto-loop.md`) | Baked into the per-turn system-prompt reminder: no "fixed" without re-review, no permission-asking, no context-length excuses, no completion-style summaries while gates are unmet |
| `pre-edit-guard` `.git/` protection | `.git/…` added to `SENSITIVE_FILE_PATTERNS` — the model can't rewrite `.git/hooks/pre-commit` to disarm L3 (`.gitignore`/`.github` still editable) |
| Self-improvement lesson log (`rules/self-improvement.md`) | `/gate-lesson <text>` appends numbered lessons to `.pi/review-gate-lessons.md`; promote 3+ recurrences into rules |

Per-project config lives in `.pi/review-gate.json`:

```jsonc
{
  "maxRounds": 10,     // 3..50 — loop hard cap (clamped, fail-safe)
  "thinkHarder": true, // one-shot [STRATEGIC_RESET] checklist near the cap
  "gitMemory": false   // opt-in [GIT_CONTEXT] after compaction
}
```

Every field is validated independently; a missing/corrupt config silently
falls back to defaults and can never loosen the gate.

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
2. Any `git commit` / `git push` / `gh pr create` is **blocked** with the exact
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
| `/gate-status` | Show verdicts, rounds, fingerprint, unmet requirements |
| `/gate-bypass <reason>` | Disable ship blocking (user-confirmed, reason required, logged in state) |
| `/gate-reset` | Reset gate state for this session |
| `/gate-lesson <text>` | Append a lesson to `.pi/review-gate-lessons.md` (self-improvement log) |

Git-hook bypass (human escape hatch): `REVIEW_GATE_BYPASS=1 git commit ...`

### Custom tools exposed to the model

| Tool | Purpose |
|------|---------|
| `record_review` | Feed the raw reviewer output into the gate. Parses every fence; worst verdict wins; records round history for plateau detection. |
| `run_precommit` | The ONLY way to record a precommit PASS. The extension spawns the bundled runner with argv (no shell) and trusts only a private, nonce-stamped receipt the runner wrote — bash stdout can never forge a PASS. |
| `declare_done` | Completion claim, **re-validated server-side** — rejects with `isError` if any gate is unmet. "Declaring ≠ executing." |

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
- `max_rounds` (10) or 3-round finding plateau → loop stops, escalates to the human — no infinite burn
- Non-English `it`/`test`/`describe` label committed without a bypass marker → pre-commit (L6) blocks with the offending `file:line` (missing scanner on an older install → warn-and-skip, never a bricked commit)

### Threat model & residual risk (explicit)

pi-review-gate defends against a **cooperative-but-fallible AI agent** taking
shortcuts or generating obfuscated shell — unintentionally or cheaply bypassing
the gate. Within that model the PASS trust path is single-entry (only
`run_precommit`), bash stdout can never forge a PASS, and the common ship-command
obfuscations above are detected.

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
depend on the sidecar existing and being untampered, and `gh pr create` is not a
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

### Commit/PR English gate (L5)

Complementary to L4: while L4 makes user-facing *chat* Simplified Chinese, L5
requires **commit messages and PR title/description to be English**. Enforced at
the `tool_call` layer — `git commit -m …` and `gh pr create --title/--body …`
are **blocked** if the message or PR text contains a **non-Latin script** (CJK,
Kana, Hangul, Cyrillic, Greek, Arabic, Hebrew, Thai, Devanagari, …). Detection
(`lib/lang-detect.ts`) is fail-closed on the unambiguous "not English" signal
(a non-Latin writing system) rather than trying to prove text *is* English, so
it **allows** ASCII, code identifiers, numbers, URLs, emoji, and Latin text with
diacritics (`café`, `naïve`) — only another script is blocked.

### Test-label English gate (L6)

Test descriptions must be **English** too. Enforced at the `pre-commit` hook
(L3) layer by `scripts/scan-test-labels.cjs`, which scans the **staged** content
of test files (`*.test.*`, `*.spec.*`, or under `__tests__/`, JS/TS only) for
`it(…)` / `test(…)` / `describe(…)` (incl. `.only`/`.skip` chains) whose
string-literal description contains a non-Latin script. Same detection as L5
(`lib/lang-detect.ts`, mirrored in the CJS scanner), so diacritics/emoji/digits
pass and only another writing system is blocked.

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
lib/constants.ts              THE code-ext list, sensitive patterns, msg regexes, LANGUAGE_DIRECTIVE (L4)
agents/adviser.md             consulting subagent, pinned model @ xhigh (proactively consulted)
agents/reviewer.md            gatekeeper reviewer override, pinned model @ xhigh
lib/model-ranking.ts          leaderboard-scored judge ranking (reference for the pins)
scripts/fetch-leaderboard.mjs opt-in, gate-external leaderboard fetcher (the only network I/O)
lib/shell-lex.ts              quote-aware shell lexer (segments + dequoted tokens)
lib/lang-detect.ts            L5: non-Latin-script detection for commit/PR English gate
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
