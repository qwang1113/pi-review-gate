# pi-review-gate

**Quality gates for [Pi](https://github.com/earendil-works/pi-coding-agent)** — ship-gate hard blocking, persistent gate state, auto-continuing review loop. Globally installable.

> Quality gates the model can't skip: `git commit`, `git push`, `gh pr create`, and `gh pr edit`
> are **hard-blocked** at the `tool_call` layer until an independent review is
> READY **and** precommit PASSes — both bound to the exact worktree state they
> verified.

## Why

Pi has no `Stop` event to prevent the model from quitting — but it has something better: `tool_call` blocking. Instead of intercepting "the model wants to stop", we intercept "the model wants to ship". Combined with `agent_settled` auto-continuation, the model fixes → re-reviews → re-runs precommit until every gate is green, and *cannot* commit around it.

Each session runs in one of **three gate modes** (strictness order `normal < explore < loop`), decided via the `set_gate_mode` tool — and the **first** classification is automated (user requirement): while the mode is undecided the tool asks the **DeepSeek V4** classifier (`llmGuards.model`, `lib/llm-classify.ts`) to pick the mode from the agent's stated reason plus session facts, and the verdict is applied **automatically — no confirmation dialog for the first classification**. A failed model call falls back to the pure rule engine exactly as before (fail-back). While the mode is undecided the gate behaves exactly like `loop` (fail-closed) and the per-turn system prompt instructs the agent to call `set_gate_mode` as its first action; “the agent never decides” therefore costs nothing.

- **`loop`** — the full enforced workflow: review READY + precommit PASS gate every ship, auto-continuation drives the fix→review loop.
- **`explore`** — investigation/troubleshooting. Its one essential difference from loop: **the agent may end the task on its own judgment** — `declare_done` is always accepted (gate status is reported as advisory) and auto-continuation is off. Edits and `bash` stay **available** — the injected system prompt merely instructs the agent to prefer read-only work — because troubleshooting routinely needs diagnostic commands. Ship commands (`git commit/push`, `gh pr create/edit`) remain **fully gated by L1**: explore never weakens the in-session ship gate, so a misclassification only relaxes auto-continuation — the safe direction.
- **`normal`** — for non-development, non-research tasks: the extension steps aside as if it were not installed. No workflow prompt injection, no ship blocking, no auto-continuation, no L6 edit-time check, no LLM guard calls. Two things deliberately survive: the **output-language directive (L4)** — it is standing user policy, orthogonal to the gate — and the **sensitive-file guard** (`.env`/keys), a security floor — lifted only per file, per user dialog, via `request_sensitive_edit` (available in every mode). Because normal fully opens the in-session gate, **every path into it requires the user's explicit consent** (a confirm dialog or `/gate-mode normal`) — with ONE exception: the DeepSeek V4 **first classification** of a clean interactive session applies automatically (user requirement; source stays `"auto"` so the git hooks remain fully enforced).

**Mode switching is asymmetric by design.** *Upgrades* (toward `loop`) apply immediately — tightening never needs consent — and record `taskModeSource: "auto"`. *Downgrades* (toward `normal`) pop a confirmation dialog that the **extension** renders with fixed consequence copy; the agent's stated reason is shown as clearly-labeled untrusted data, and the tool deliberately has **no “confirmed” parameter**, so consent can never be claimed by the caller. A **declined** dialog locks agent-initiated downgrades for the rest of the session (anti-grinding); only `/gate-mode` or `/gate-reset` clears the lock. The **first** classification is the one consent-free path below loop: the DeepSeek V4 verdict applies automatically on an interactive session in which **this session has made no edits yet** — pre-existing worktree/branch changes from before the session do NOT block it (they arm the ship gate, but the verdict records `source: "auto"` so the git hooks stay fully enforced); once the session itself edits, slipping into explore is a real downgrade and asks the user — and in print/JSON mode (no UI) nothing can be confirmed, so only upgrades and `undecided→loop` are possible there (fail-closed).

For the *git hooks* (defense-in-depth outside Pi), the sidecar records *who* chose the mode (`taskModeSource`): pre-commit/pre-push treat explore/normal as advisory **only when the user chose it explicitly** (`"user"` — a confirmed dialog or `/gate-mode`) — this protects the user's own manual commits during such a session, while an agent-set mode keeps the hooks fully enforced (`"auto"`). You can override the mode anytime with `/gate-mode loop|explore|normal`.

### LLM semantic guard layer (DeepSeek V4 Flash)

The same fast, cheap model (`deepseek/deepseek-v4-flash`, configurable via `llmGuards.model`) powers the **session-start gate-mode classification** (see Gate modes) and gives **three guards** an additional **semantic layer**. Design invariants, enforced by construction in `lib/llm-classify.ts`:

1. **Tighten-only** — an LLM verdict can only *add* a block or pick the safer side of an ambiguous case. Deterministic checks run first and short-circuit; the LLM is never asked to *approve* something a deterministic check blocked.
2. **Fail-back** — timeout (8s), spawn failure, or unparseable output degrade each guard to its exact pre-LLM deterministic behavior. No network ⇒ no regression.
3. **Injection-resistant** — classified text is wrapped in `<data>` tags as untrusted data; a hostile prompt can at worst flip one classification, which by (1)+(2) cannot open the gate.

| Guard | Deterministic base | What the LLM layer adds |
|---|---|---|
| Gate-mode classification (session start) | none — the rule engine (`lib/task-mode.ts`) fallbacks | The FIRST `set_gate_mode` call (undecided + clean interactive session) is classified by DeepSeek V4 and applied automatically, no confirmation dialog (user requirement; `source: "auto"` keeps the git hooks enforced; a failed call falls back to the agent's pick under the normal consent rules) |
| AI attribution (`llmGuards.aiAttribution`) | `COMMIT_MSG_FORBIDDEN` regexes | Paraphrases: “pair-programmed with an assistant”, “drafted by a language model” |
| English check L5/L6 (`llmGuards.englishCheck`) | Unicode non-Latin-script detection | The romanization blind spot: pure-Latin pinyin/romaji commit messages, PR text, and test labels |
| Ship detect (`llmGuards.shipDetect`) | ~static shell parser (`lib/ship-detect.ts`) | Suspicious git/gh commands with dynamic constructs (base64-piped shells, inline-defined aliases) the static parser cannot resolve — a positive answer *adds* a detection; “none” changes nothing |

The L6 test-label check also moves **left**: the same lexer the git hook uses now runs at *edit time* in the extension (immediate feedback + the semantic layer), while the zero-dependency hook remains the deterministic backstop at commit time — hooks never call an LLM, so offline commits behave exactly as before. Edit-time scanning works on the **full projected post-edit file** (`lib/edit-projection.ts`): the current file content with every `oldText→newText` applied — so an edit that replaces only a label *string* still exposes the surrounding `it(...)` call to the lexer, and a fragment that cannot be applied is still appended and scanned rather than skipped.

The classifier child process is **fully isolated**: `pi -p --no-session --no-extensions --no-skills --no-tools --no-context-files --no-prompt-templates`, argv-array spawn (never a shell string), stdin closed immediately, 8s timeout. No extensions means the child cannot recursively load review-gate; no tools means a prompt-injected classifier can at worst emit wrong JSON — and the verdict parse is strict (the entire stdout must be exactly the one-key JSON object; echoed data or chatty prefixes ⇒ fail-back to deterministic behavior).

## Architecture — the enforcement layers

```
L1  Ship gate (HARD)      tool_call → block git commit/push, gh pr create/edit
                          until review READY + precommit PASS on the
                          current worktree fingerprint
L2  Auto-continuation     agent_settled → if gates unmet, inject
                          [REVIEW_GATE_RESUME] follow-up (recursion-guarded,
                          max 10 rounds, plateau detection; a user ESC abort
                          — "Operation aborted" — pauses the loop until the
                          user's next message)
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
L7  Copilot review loop   after a PR is created/updated → request GitHub
                          Copilot's review, work every thread off (fix +
                          resolve, or reply with the reason), verified by the
                          extension itself. COMPLETION-only: it gates
                          declare_done and keeps the loop running, and never
                          the ship gate (fixing a finding needs a commit)
L8  Loop-goal approval    loop mode → the exit contract must be NEGOTIATED with
                          the user and approved in an extension dialog
                          (`propose_loop_goal`); an unapproved goal blocks
                          commit/push/PR at L1 and its body is withheld from
                          the prompt
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
(PR #7's `-uno` regression), and **atomic sidecar writes** (temp+rename
so a crash can't leave truncated JSON for a fail-open parser).

The fingerprint is **content-addressed and staging-invariant**: it is a real
git *tree hash* of the whole worktree, computed in a private shadow index, so
it depends only on file contents and paths — never on whether those contents
are currently unstaged, staged, or committed. This matters because the gate
binds a READY review to a fingerprint: an earlier implementation hashed
`git diff --cached` + `git diff HEAD` + `git status` + HEAD, so a plain
`git add` (and again `git commit`) changed the digest **without a single byte
of code changing**, and the L3 hooks rejected the very commit the gate had just
approved. That forced a redundant full review round on every staging operation
and pushed users toward `REVIEW_GATE_BYPASS=1`, which disarms the gate far more
thoroughly than the false mismatch it worked around. A tree hash makes staging
and committing invisible while any real edit — including a new untracked
file — still changes the digest and correctly invalidates the pass.

> Implementation note: the shadow index is seeded from the real index and its
> mtime is **backdated to `min(indexMtime, now) - 5s`**. `copyFileSync` stamps a
> newer mtime, which defeats git's
> [racily-clean](https://git-scm.com/docs/racy-git) re-hash and makes a
> same-size edit in the same mtime bucket invisible to the digest — a genuine
> fail-open (measured 25/1500) covered by a dedicated regression test.
> An older-looking index makes git re-hash *more*, never less. The clamp to
> `now` matters: backdating a fixed margin from a **future** index mtime (clock
> skew, a rolled-back clock, a copied tree) still lands in the future and
> re-arms the same fail-open — also covered by a regression test.
>
> Backdating alone is still not sufficient, because it only makes entries whose
> mtime is *near* the index look racy. A file carrying an **ancient preserved
> mtime** (restored from backup, `rsync -a`, an unpacked archive) keeps looking
> clean, so the index is built in **two passes**: `git add -A --renormalize`
> re-reads tracked file *content* rather than trusting the stat cache, then a
> plain `git add -A` picks up untracked/new/deleted paths (`--renormalize`
> alone adds no untracked files — running only that pass silently dropped every
> untracked file, a worse fail-open than the one it fixed). Both passes plus the
> backdate cost ~340ms on a 9k-file repo.
>
> Seeding is **required for correctness**, not just speed (~78ms vs ~385ms on a
> 9k-file repo): `git add` will not stage a path matching `.gitignore`, so an
> empty index silently drops files that are gitignored yet **tracked**
> (`git add -f`) — which `git commit -a` still ships.

### Staged vs. reviewed content

The digest is worktree-based so `git add` cannot invalidate a review — but
`git commit` (without `-a`) ships the **index**. If a path is staged with
content A while the worktree holds the reviewed content B, the commit would
ship A while the gate bound B, and the digest never moves. Folding the index
tree into the digest would simply reintroduce staging-sensitivity, so this is
enforced as a separate commit-time condition
(`scripts/check-staged-divergence.cjs`). It builds two trees — the real index
(what the commit would write) and the worktree (what the review bound) — and
blocks any path the commit would change whose staged **tree entry** differs
from the worktree entry. It compares the full entry (mode, type and object id),
not just the object id: a staged executable bit, or a symlink↔regular-file type
change whose object content happens to match, is still a different committable
tree. Blocked states include a partially staged edit (`git add -p`), a staged
delete whose path was recreated, and a staged rename whose source path was
recreated. A merely unstaged edit is safe (the index still matches HEAD, so
the commit changes nothing), as is a staged edit or delete that matches the
worktree, so the check is per-path rather than global.

For **submodules** the parent tree holds only a gitlink, so index and worktree
trees look identical whenever they agree on that OID — even if the checkout
holds different reviewed content. So whenever a commit would change a
submodule's gitlink, the content that gitlink *publishes* is compared against
what is actually checked out, **recursively** through nested submodules (an
outer submodule can match its staged commit exactly while a nested one holds
unpublished content). A dirty submodule whose gitlink is *not* being committed
is the safe analogue of an unstaged edit and does not block.

It compares **content, not `git status` output**: `assume-unchanged` and
`skip-worktree` suppress status reporting, and a status-based version silently
passed a staged blob that differed from the reviewed worktree. Paths are read
NUL-delimited, so names with spaces, newlines or non-ASCII characters are
handled as raw bytes. Any internal failure exits non-zero (fail closed) — only
a genuinely non-git directory is a clean skip. A **missing** script makes the
hook fail closed too (it guards a safety invariant, so a partial install must
block rather than silently downgrade); the script itself never swallows errors.

That "genuinely non-git" decision is **structural, never text-based**. When
`git rev-parse` itself fails, the script skips only if the path exists *and*
carries no git metadata anywhere up the tree — checking, at every level, both a
`.git` entry (via `lstat`, so a **dangling symlink** counts as metadata rather
than as "nothing here") and the bare-repo shape (`HEAD` + `objects/` + `refs/`).
Matching git's stderr for "not a git repository" was wrong in both directions:
git prints that same phrase for a **broken** worktree (a `.git` gitfile whose
target gitdir is gone) — which would fail open — and a localized git prints
none of it, which would block ordinary non-repo directories. Exercised
branches: plain directory → skip; bare repo → skip; missing gitdir target →
block; malformed gitfile → block; dangling `.git` symlink → block;
subdirectory of an unparseable bare repo → block; unparseable config → block;
nonexistent path → block.

### Ambient git environment variables are stripped

Every git invocation in the fingerprint, its CJS mirror and the divergence
checker runs with two families of variables **removed**, so the repository is
always discovered from the path the caller asked about and the configuration is
the repository's own:

| Family | Variables | Reproduced fail-open |
|---|---|---|
| Relocation | `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM` | With `GIT_DIR`/`GIT_WORK_TREE` pointing at a decoy repo, `computeFingerprint(A)` returned a digest describing the decoy — a real edit in A left "its" fingerprint unchanged — and the divergence checker inspected the decoy and exited 0 while A held staged content differing from the reviewed worktree |
| Config injection (matched by prefix `^GIT_CONFIG(_\|$)`) | `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG` | `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.excludesFile GIT_CONFIG_VALUE_0=…` made a real untracked edit invisible to `git add`, so the digest never moved — no `GIT_DIR` needed |

The numbered config forms are unbounded, so they are matched by **prefix**, not
by a fixed list. The user's own `~/.gitconfig` still applies; what is removed is
an ambient variable's ability to substitute or extend it for this process.
Parity tests assert the TS and CJS sides never drift apart, and behavioural
tests run the actual injection against both.

### One materialization per hook decision

The pre-commit hook needs two answers about the same bytes: does the index
match the reviewed worktree, and what is the worktree's digest. It used to run
two processes that each built their own shadow-index tree. Now
`check-staged-divergence.cjs` `require`s the fingerprint implementation, so the
tree is materialized once per repository and reused for both; the hook calls it
with `--emit-fingerprint` and reads the digest from stdout. Measured on a
9k-file repository: **~1765 ms → ~984 ms**.

The sharing is a **per-cwd resolver**, not one tree: the fingerprint recurses
into submodules, so handing it a single top-level OID would leave every
submodule materializing itself again — precisely where a `clean` filter could
still make the divergence verdict and the digest disagree. A test injects a
counting resolver and asserts each repository (parent *and* submodule) is asked
for exactly once, because that degradation is invisible in the resulting
digest.

Beyond speed this closes a correctness gap: a repository `clean` filter is an
arbitrary program, so two separate materializations of an *unchanged* worktree
could legitimately produce different trees — leaving the divergence verdict and
the fingerprint describing different content. A partial install that lacks the
fingerprint implementation makes the checker fail closed; an older checker that
does not understand `--emit-fingerprint` prints nothing, and the hook falls back
to computing the fingerprint separately rather than bricking the commit.

### The gate never writes to your index

Every pass runs in a private shadow index; the real one is read-only to the
gate. This is enforced by test, because it was violated once: when the
scratch-index passes were extended to clear `assume-unchanged` / `skip-worktree`
bits, the helper running them dropped its environment argument, so
`update-index` hit the **user's real index** and wiped those bits (`S a.ts` /
`h b.ts` → `H a.ts` / `H b.ts` after a single fingerprint).

Clearing those bits *inside the shadow index* also fixed a pre-existing
limitation: on a sparse-checkout repository `git add` aborted with "outside of
your sparse-checkout definition", so the fingerprint failed closed and such a
repository could never pass the gate at all. It now produces a usable digest
that still tracks edits to `skip-worktree` paths.

### The index a commit will actually publish

`git commit -a` and `git commit -- <path>` do **not** publish `.git/index`:
git stages into a temporary index (measured: `<gitdir>/index.lock` and
`<gitdir>/next-index-<pid>.lock`) and points the hook at it via
`GIT_INDEX_FILE`. Comparing the plain index there judges content the commit
will never ship, which blocked a perfectly safe `git commit -a` whose temporary
index already equalled the reviewed worktree.

The hook therefore forwards that path **explicitly** as an argument
(`"${GIT_INDEX_FILE-}"`), and the checker accepts it only after verifying its
**canonical** path (symlinks resolved, via the nearest existing ancestor so
git's not-yet-created temporary indexes still validate) resolves inside the
repository's git dir or common dir — anything else fails closed. A lexical
check was not enough: a symlink planted inside the git dir passed containment
while the copy followed it out of the repository. A standalone run without the argument uses the plain index, so an
ambient variable still cannot redirect the check. Submodule recursion keeps
using each submodule's own index, since the forwarded path describes exactly
one repository.

Everything runs from the repository **toplevel**, resolved once at startup.
Several git commands are implicitly cwd-scoped, and each was a silent
fail-open when the checker was pointed at a subdirectory: `ls-tree` lists only
the cwd prefix (empty listing ⇒ "no divergence" ⇒ exit 0), `ls-files` returns
cwd-relative paths, and the `update-index` calls built from them then failed
outright.

Three content sources sit outside a plain tree hash and are handled explicitly:

- **Submodules** — a parent tree records only each submodule's committed
  gitlink, so edits inside a checked-out submodule leave it bit-identical. Each
  submodule is hashed **recursively with the same worktree-tree algorithm**, so
  its real file content is bound (hashing `git status` text instead would miss a
  second edit to an already-dirty file, whose status line is unchanged).
  Submodule paths are read from the **index** (gitlinks), which stays
  authoritative even when `.gitmodules` is malformed — `git config --file` would
  report “no submodules” and “file is corrupt” identically. An uninitialized /
  deinit’d submodule has no checkout to review and is recorded as such rather
  than failing closed. Repos without submodules keep the bare tree hash.
  Recursion is capped at 10 levels; deeper nesting fails closed
  (`unavailable`) rather than recursing without bound.
- **Tracked-but-gitignored files** — shippable (`git commit -a` commits them),
  so they must be hashed; see the seeding note above.
- **CRLF / clean filters** — the digest binds *the content git will commit*.
  Under `core.autocrlf`, a line-ending-only change is normalized away and git
  itself reports “nothing to commit”, so the shipped artifact is byte-identical
  to what was reviewed. Without `autocrlf`, such a change is genuine content
  and does move the digest.

The fingerprint **excludes gate-owned paths** (`.pi/`, `.pi-subagents/` — via
repo-root-anchored git pathspecs, mirrored in the CJS hook script with a digest
parity test): the gate itself rewrites `.pi/review-gate-state.json` on every
persist, so including it would let `record_review` immediately invalidate its
own READY binding in any repo that does not gitignore `.pi`. Reviews judge
project code, never Pi's state dirs. (Recommended anyway: add
`.pi/review-gate-state.json`
and `.pi-subagents/` to the project's `.gitignore` — gate state is per-machine
and has no business in version control.)

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

### Upgrading: fingerprint algorithm migrations

**Restart Pi (or `/reload`) after upgrading — before your next commit.**

A Pi extension is a resident process: it loads its modules once at session
start and does not hot-reload. The git hooks, in contrast, execute the files on
disk. So if an upgrade changes the fingerprint algorithm, a still-running
session computes bindings with the OLD algorithm while the freshly installed
hook computes the NEW one, and the hook rejects the very commit the gate just
approved.

That is why every binding records a `fingerprintVersion`:

- **The extension** invalidates bindings from another version on load (READY →
  `PENDING`, PASS → `NOT_RUN`) and tells you why. Change flags are kept, so the
  gate re-arms rather than disarms. Old digests are never converted or
  inherited: a v1 digest says nothing about what v2 covers.
- **The hook** reports the mismatch as a *migration*, not as "code was modified
  after the last READY review", and prints the three recovery steps: restart Pi
  → re-run the precommit runner → get a fresh READY review.

So after upgrading, expect **one** extra review round. If a commit keeps being
rejected with `fingerprint algorithm mismatch`, the resident extension is still
on the old algorithm — restart Pi first.

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
edit code (batch related edits — the loop is billed per ROUND, not per line)
  → call the run_precommit tool FIRST                     # extension spawns the trusted runner
  → run an independent review (subagent / codex MCP / second model)
  → call record_review with the FULL reviewer output      # all fences parsed, worst wins
  → BLOCKED? fix everything, then start again from precommit
  → READY?  call declare_done                             # re-validated server-side
  → ship    (git commit now passes the gate)
```

**Why precommit runs before the review.** The runner executes `lint`/`lint:fix`
in *both* modes, and `lint:fix` edits files. Every edit re-arms the gate
(`READY → PENDING`), so a review obtained before the runner reformats anything
is thrown away — a wasted round at ~3 min of reviewer wall time. Running the
cheap, deterministic checks first also keeps the expensive judge from spending
minutes on defects a 15s test run reports for free.

The reviewer should end with a fenced JSON verdict:

```json
{"gate": "READY" | "BLOCKED" | "NEEDS_HUMAN",
 "findings": [{"file": "src/x.ts", "line": 42, "severity": "P1", "issue": "..."}]}
```

Review verdicts require **JSON fences**. Precommit verdicts are NOT parsed from
bash output at all: the `run_precommit` tool spawns the trusted runner itself
and records the result from a verified nonce receipt, so a `## Overall: ✅ PASS`
sentinel printed by any other command can never grant a PASS.

### Loop goal — the exit contract, negotiated with the user (L8, loop mode only)

The gates prove the change is *sound*; they say nothing about whether the
user's *goal* was met. In `loop` mode the extension therefore injects a **Step
0** directive: before editing, agree on the session's exit contract — task
title, one-line intent, 3–7 **checkable** exit criteria, non-goals, ISO date,
sized to the change (a one-line bugfix deserves one criterion and three lines).

**The goal is negotiated, not assumed.** The agent used to write
`.pi/loop-goal.md` on its own, which made the exit contract self-issued: it
guessed what "done" meant, worked to its guess, and graded itself against it.
And because a *leftover* goal file was injected verbatim for 24h, a new session
could silently inherit the previous task's contract. Both holes are closed by
one fact:

- **Grill first.** The directive tells the agent to interview the user in
  rounds of numbered questions, each carrying its own recommended answer, until
  nothing is left silently assumed. Facts are the agent's job (read the repo,
  run the tools); only decisions go to the user.
- **Then `propose_loop_goal`.** The **extension** shows the negotiated text in
  a confirm dialog, and only if the user approves does the extension write
  `.pi/loop-goal.md` and record the sha256 of exactly that text in the sidecar.
  There is no `confirmed` parameter the model could set.
- **Approval binds to CONTENT.** Editing the file afterwards changes the hash
  and drops the approval — the contract the user agreed to no longer exists.
- **Unapproved ⇒ blocked and unquoted.** In loop mode an unapproved goal blocks
  `git commit` / `git push` / `gh pr` at **L1**, and its body is *withheld* from
  the prompt (only a "a draft exists, renegotiate it" note is injected).
  Blocking at ship time is the point: by `declare_done` the code is already
  pushed and agreeing on the goal would be theatre.

**What deliberately did NOT change.** The L3 git hooks and the verdict logic
stay blind to the goal: an approval is a *dialog* fact, and a hook cannot show
a dialog — a hook that failed on an unapproved goal would block commits it can
never unblock. So the requirement lives in the extension's L1 path and in
`declare_done`, never in `unmetRequirements()` (a structural test pins this).

- **Who uses it.** The main agent slices the work against the goal (write
  subagents serially in the same worktree — their edits move the worktree
  fingerprint, so a review recorded earlier can no longer ship them; read-only
  subagents may run in parallel), `adviser` advises against it, and `reviewer`
  accepts against it criterion by criterion. Both agents also read
  `.pi/loop-goal.md` by default. The main agent stays the writer of record: it
  runs precommit, the review, and the fixes.
- **It cannot deadlock the gate.** `.pi/loop-goal.md` lives inside the
  gate-owned `.pi/` scope, which is both excluded from the fingerprint and
  skipped by the extension's edit tracking, so writing or rewriting the goal
  changes no digest, arms no doc gate, and never invalidates a READY review or
  a precommit PASS. Reading it is best-effort (IO errors degrade to "no goal"),
  and the injected text is capped at 1500 characters and framed as untrusted
  repo data that cannot relax the gate rules. A goal older than 24h is flagged
  as possibly stale so even an approved contract is re-confirmed against what
  the user is asking for now.

`explore` and `normal` sessions never see this directive.

### Copilot code review after the PR (L7)

Every other layer stops at the moment the PR opens. L7 is the tail of the
workflow the gate used to ignore: once a PR is **created or updated**, GitHub
Copilot's review has to be requested, waited for, and *worked off* — every
thread either fixed and resolved, or answered with the reason it will not be
fixed — before the task counts as done.

- **Arming.** A *successful* `gh pr create`, `gh pr edit` or `git push`
  (detected with the same audited `detectShipCommands` the ship gate uses) opens
  a cycle for the repo the command ran in. A failed command arms nothing. Any
  new ship re-arms from a terminal state — without that, the usual order (push
  the branch, *then* open the PR) would resolve to "no PR" and stay there.
- **Trusted tools.** `request_copilot_review` and `check_copilot_review` are
  the L7 equivalents of `run_precommit`: the **extension** runs `gh` itself
  (argv, no shell, timeout, abortable) and interprets the payload with the pure
  rules in `lib/copilot-review.ts`. The agent drives the loop but can never
  report its own review outcome.
- **"Copilot reviewed this" is anchored on the commit**, not on a clock: a
  Copilot review submitted against the PR's current head proves it saw this
  code. Timestamps are only a fallback (with a skew tolerance), and if the
  anchor time is unparseable ONLY the commit-anchored proof counts.
- **A thread waits on you while Copilot spoke last.** Resolved ⇒ handled;
  answered by you ⇒ handled (the user's rule: an explanation is a valid
  outcome); Copilot commenting again after your reply ⇒ yours again. An
  `isOutdated` thread is still yours — moved code is not a fixed concern — but
  the hint is surfaced so you can resolve it if the change did fix it.
- **Completion-only, never the ship gate.** Fixing a Copilot finding requires a
  commit and a push, so a Copilot requirement inside the ship authority would
  block its own remedy. It gates `declare_done` (hard in loop mode, advisory in
  explore) and rides the auto-continuation on its **own** budget, so waiting for
  Copilot never eats the rounds the fix→review loop needs.
- **It can never strand a task.** No `gh`, no GitHub remote, no PR, an API
  refusal, or an unreadable thread query ⇒ `UNSUPPORTED`, requirement released.
  A Copilot that never answers, or a PR that keeps producing new findings, ends
  as `EXHAUSTED` (round budget `copilotReview.maxRounds`, default 3, clamped to
  1–10; wait budget 20 min) with an explicit "escalate to the user" note.
- **Known limit, stated honestly.** The gate verifies the *structure* (resolved,
  or answered by you), never the *substance* of a reply — "won't fix: out of
  scope" and "ok" are indistinguishable to it. That limit is inherent to the
  rule it enforces, the same way `docSync` trusts the reviewer's attestation
  instead of counting touched files.

Turn it off per project with `"copilotReview": { "enabled": false }` in
`.pi/review-gate.json`.

### No UI ⇒ the gate runs in `normal` mode

Every enforced mode now depends on dialogs the extension must be able to render
(loop-goal approval, sensitive-edit authorization, downgrade confirmation). A
print/JSON session (`pi -p …`, CI) can render none of them, so it would enter
the loop with no way to satisfy it. Rather than half-enforce, the gate steps
aside entirely there: at `session_start` a session without a UI is switched to
`normal`, `set_gate_mode` refuses every other mode with that explanation, and
normal mode does not even arm the sidecar — so the git hooks see an unarmed
state and the headless run can commit. **Run the task in an interactive session
to get the full gate.**

### Multi-repo sessions (the gate follows the checkout, not the cwd)

The gate binds its verdicts to a *worktree fingerprint of a specific git
repository*. The session cwd's repo is the primary repo, but when the model
`cd`s into a **different** git repository (a sibling checkout, a submodule, a
frontend repo next to the backend one), edits and ships there are tracked and
gated **per repo**:

- **Per-repo sidecars**: every repo this session edits gets its own
  `.pi/review-gate-state.json` + fingerprint binding, written by the extension
  when a file in that repo is edited through the edit/write tools.
- **Ship resolution**: a ship command (`git commit`/`push`, `gh pr create`) is
  resolved to the repo(s) it actually operates on — `cd <dir>` chains,
  `git -C <dir>`, `git --git-dir` / `--work-tree`, and a leading `GIT_DIR=`
  env assignment. That repo's own review + precommit must be satisfied; a
  READY+PASS on the session repo **does not** legitimate a commit in another
  repo. Constructs that cannot be resolved statically (`cd $VAR`, quoted paths
  with spaces, `pushd`, nested `sh -c`) widen the check to every repo the
  session has edited (fail-closed).
- **Explicit target repo**: `record_review` / `run_precommit` take a `repo`
  argument, and it is **mandatory once the session has edited more than one
  repo** — they refuse to guess. Run the loop once per repo, naming it.
  Historically they wrote to whichever repo was edited LAST, and only an edit
  could move that target: a session whose last edit was in repo B could never
  record a verdict for repo A again, so A's commit stayed blocked through
  unlimited review rounds while every round reported success. That failure is
  indistinguishable from the gate corrupting itself, so the ambiguity is now
  rejected (fail-closed) instead of resolved by guessing. Tool results name
  the repo they wrote to, and a block message says where the last READY
  actually landed.
- **Every block line is labelled** once several repos are in play (including
  the session repo, which used to print unprefixed), and `/gate-status` lists
  every repo the session touched with its own verdicts — a repo with no usable
  state is shown as such rather than omitted.
- **declare_done** requires *every* repo this session edited to pass its own
  review + precommit. The repo set survives a same-session resume
  (`sessionReposPaths` in the primary sidecar).
- **Sidecars from other sessions are not trusted**: a stale READY left by a
  previous session is discarded on first edit; pre-existing uncommitted work
  in a never-edited repo still blocks shipping from it (fail-closed).
- **Two live sessions in one worktree**: the sidecar names a single session and
  each write replaces the file, so session B's write used to erase the READY +
  PASS session A had just earned — and since the L3 hooks read only that file,
  A's commit was then rejected for a review it had passed. A foreign verdict is
  now carried over on write, but **only after its fingerprint is checked
  against the worktree as it stands** (a content digest carries no session
  identity, so it still proves exactly what it always proved: this tree was
  reviewed). Anything staler is dropped, and our own BLOCKED/FAIL is never
  upgraded by someone else's READY/PASS. The carry-over is short-lived by
  design: once the carrying session writes again the verdict is
  indistinguishable from a stale one of its own and is dropped, so a
  deliberately invalidated binding does not climb back out of the file (it can
  outlive that write only where it is still recognizably foreign, or where a
  session was restored from that sidecar — in both cases still bound to the
  fingerprint of a reviewed tree). Sharing a worktree therefore remains
  unreliable by design — the two sessions keep re-arming each other's gate —
  so the gate warns at session start when it sees another recent session; use
  `git worktree add` for parallel work.
- **The `.blocked` fail-closed marker has owners**: when the extension cannot
  write the sidecar it drops `.pi/review-gate-state.json.blocked`, and the L3
  hooks refuse to commit while that file exists (the sidecar they would
  otherwise verify is stale). The marker used to be content-free and deleted
  unconditionally — on session start and after every successful write — so one
  session routinely erased a *concurrent* session's fail-closed signal, leaving
  the hooks verifying a stale but well-formed sidecar (fail-closed degraded to
  fail-open). It now carries its owners (`{ sessionId, pid, host, at }`, written
  atomically) and is reclaimed only for owners that are **ours** or that have
  been silent past the concurrent-session window; anything else survives, and
  the file disappears only once no owner is left. There is deliberately no pid
  liveness probe: it is meaningless for a checkout shared across hosts and pid
  reuse can point at a stranger. A marker whose content does not parse (the
  legacy plain-text one from an older install, or a hand-edited/corrupt file) is
  **never** removed or rewritten — clear it once by hand, or commit with
  `REVIEW_GATE_BYPASS=1`. The hook itself still tests existence only and never
  reads the file: during an upgrade an older extension still writes the legacy
  marker, and a hook that had to interpret unparsable content is exactly where
  a guess would become a fail-open.
- **L3 git hooks are not auto-installed into other repos**: they cover the
  repo(s) where `scripts/install-git-hooks.sh` (or the global installer) ran.
  For a repo you know the model will work in, install the hooks there too for
  defense-in-depth outside Pi.

### Commands

| Command | Effect |
|---------|--------|
| `/gate-status` | Show workflow mode, verdicts, rounds, fingerprint, unmet requirements |
| `/gate-mode loop\|explore\|normal` | Switch the session workflow in any direction without a dialog (user-invoked = explicit consent; also clears the agent-downgrade lock). `explore` makes gates advisory and lets the AI self-complete (ship commands stay gated). `normal` switches the gate off entirely for this session. |
| `/gate-bypass <reason>` | Disable ship blocking (user-confirmed, reason required, logged in state) |
| `/gate-reset` | Reset gate state (mode returns to undecided — the agent re-decides via `set_gate_mode`; also clears the agent-downgrade lock) |
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
| `set_gate_mode` | The agent's in-session mode decision/switch (`loop`/`explore`/`normal` + a reason). On the FIRST call (mode undecided, this session has made no edits yet — pre-existing changes from before the session don't count — interactive session) the tool asks the **DeepSeek V4** classifier and applies its verdict **automatically — no confirmation dialog** (user requirement; the LLM may override the agent's pick; a failed call falls back to the rule engine). Later changes delegate to the pure rule engine in `lib/task-mode.ts`: upgrades apply immediately (source `auto`); every downgrade pops an extension-rendered confirm dialog (fixed consequence copy, agent reason labeled untrusted); a declined dialog locks agent-initiated downgrades for the session. |
| `record_review` | Feed the raw reviewer output into the gate. Parses every fence; worst verdict wins; records round history for plateau/oscillation detection. A fence whose JSON is broken by an unescaped quote is salvaged fail-closed (its gate word is recovered, but a salvaged READY is downgraded to BLOCKED). |
| `run_precommit` | The ONLY way to record a precommit PASS. The extension spawns the bundled runner with argv (no shell) and trusts only a private, nonce-stamped receipt the runner wrote — bash stdout can never forge a PASS. |
| `declare_done` | Completion claim, **re-validated server-side** — rejects with `isError` if any gate is unmet (the reject hint reminds you that late doc/handoff edits invalidate the READY fingerprint, so finish all edits before the final review). "Declaring ≠ executing." It also enforces the two COMPLETION-only requirements the ship gate deliberately does not carry: an open Copilot review cycle (L7) and an unapproved loop goal (L8). On accept it clears the per-task round history so a subsequent task in the same session starts its round counter fresh. |
| `propose_loop_goal` | Submit the **negotiated** loop goal for the user's approval (L8). Grill the user first; then the **extension** shows the text in a confirm dialog (**no `confirmed` parameter**), and only on approval does the extension write `.pi/loop-goal.md` itself and record the sha256 of exactly that text. Approval binds to CONTENT: editing the file afterwards drops it. In loop mode an unapproved goal blocks commit/push/PR at L1 and its body is withheld from the prompt. |
| `request_copilot_review` | Ask GitHub Copilot to review the current branch's PR (L7). The extension resolves the PR and requests the review itself (`gh pr edit --add-reviewer @copilot`, with the documented REST review-request endpoint as fallback for older `gh`), stamping the authoritative request time and head SHA. No gh / no GitHub remote / no PR / API refusal ⇒ `UNSUPPORTED`, requirement released — it can never strand the task. Spending the last round of `copilotReview.maxRounds` releases it as `EXHAUSTED` with an escalate-to-the-user note. |
| `check_copilot_review` | Verify what Copilot's review left open (L7). The extension runs the GraphQL query itself and classifies each thread: resolved ⇒ handled, answered by you ⇒ handled, Copilot spoke last ⇒ still yours (listed with thread IDs and the exact `resolveReviewThread` / reply mutations). Returns AWAITING / OPEN / SATISFIED — an outcome the agent cannot report for itself. |
| `request_arbitration` | Contest a ship block the agent believes is **circular** (the only remedy is an action the block forbids). Narrow + fail-closed — see [Arbiter](#arbiter-a-narrow-fail-closed-gate-exception). |
| `request_scope_limit` | Agent-requested **gate fence narrowing** for the "pre-existing changes" complaint: the gate arms on dirty files / branch commits that pre-date the session (P0-2), so it can demand review coverage of work the session never did. Instead of silently complying (or bypassing), the agent calls this tool and the **extension renders a user confirm dialog** (fixed consequence copy; the agent's reason labeled untrusted; **no `confirmed` parameter** the model could set). Granted → the non-session changed files are snapshotted as `scopeLimit.preexistingFiles` in the sidecar and stop arming the gate at **every** re-arm site (session_start P0-2, bash stash/checkout re-arm, turn_end reconciliation); a file the session later edits is **reclaimed** out of the snapshot by the edit handler — the grant never covers the session's own work — and branch-commit arming is suspended for as long as the grant stands (a new commit under a standing grant is either the exempted pre-existing work being shipped — exactly what the user consented to — or a user/bypass action; the session's own NEW edits re-arm the gate before any further agent commit). With no session edits the ship gate disarms entirely; with session edits the review scope narrows to `sessionFiles` (the per-turn prompt instructs the reviewer: out-of-scope findings are advisory). Session edit attribution is persisted (`sessionEditedFiles`), so a process restart cannot re-label the session's own edits as pre-existing. A dialog that cannot be shown fails closed WITHOUT counting as a decline. Verdicts/bindings are untouched — narrowing the fence never fabricates a READY/PASS, and the session's OWN edits stay fully gated. Declined → scope requests lock for the session (anti-grinding, mirrors the mode-downgrade lock). Malformed persisted shapes fail closed to ABSENT = full-scope gate (extension loader + git hook both validate). |
| `request_sensitive_edit` | Agent-requested **one-shot authorization** to edit ONE sensitive file (`.env`, private keys, credentials) that the guard blocks by default. Same consent shape as the tools above: the **extension** renders the confirm dialog (fixed consequence copy, agent reason labeled untrusted, **no `confirmed` parameter**). A grant is **path-exact** (normalized absolute path), **single-use** (burned by the first edit that *succeeds* — a failed edit stays retryable), **10-minute TTL**, and **in-memory only** (never written to the sidecar, so a crash/resume/second session starts fail-closed). `.git/` internals are refused **before** any dialog — they are the gate's own L3 enforcement, not the user's secrets. A **declined** path is locked for the session (per-path anti-grinding, unlike the session-wide `request_scope_limit` lock); a dialog that could not be *shown* is not a decline. `/gate-reset` revokes outstanding grants and lifts the decline locks. |
| `pause_for_question` | Agent-requested **loop pause** for a genuine blocker only the user can resolve (ambiguous requirement, a product decision, missing access). Without it, an agent that ends its turn with a question gets steamrolled by the L2 auto-continuation. The pause is **tighten-only**: it disarms auto-continuation ONLY — `unmetRequirements()` never reads it, so the L1 ship gate and the git hooks stay fully enforced. Persisted in the sidecar (survives a restart while waiting); clears automatically on the user's next message (any non-`extension` input source, so RPC-driven sessions don't deadlock), on the agent's next code/doc edit, `record_review`, `run_precommit`, or a mode change (stale-pause liveness: an agent that keeps looping has proven it is not waiting). During `session_compact` a paused loop re-injects the *waiting* state (`[REVIEW_GATE_PAUSED]`) instead of a resume nudge. Prohibited use — asking permission to continue routine loop work — stays prohibited; the per-turn prompt spells out the exemption. |

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
- Any code/doc edit after READY/PASS → fingerprint mismatch → ship blocked (`git add` / `git commit` alone are NOT edits: the fingerprint is content-addressed, so pure staging/committing preserves the binding)
- Unknown/forged verdict enum in the sidecar (e.g. `precommit:"READY"`) → rejected by the loader **and** default-denied in `unmetRequirements` and the git hook → ship blocked
- Gate state carries a binding from a DIFFERENT fingerprint algorithm (upgrade with a still-resident old extension) → commit blocked and reported as a **migration**, with recovery steps — never silently trusted, never converted, and never misreported as a code modification; the extension invalidates such bindings on load while keeping the change flags, so the gate re-arms instead of disarming
- Advisory (prompt-only) fingerprint memo goes stale, or `advisoryChangeToken()` cannot be computed → no effect on any decision: the memo has a single call site (structurally asserted) and every enforcement path recomputes the fingerprint; an unavailable token or an UNAVAILABLE fingerprint is never memoized
- `scripts/check-staged-divergence.cjs` missing from the hook's install tree → commit blocked (**fail-closed**, not warn-and-skip): it is the only guard for "staged content ≠ reviewed worktree", which the staging-invariant fingerprint cannot see. The L6 label scanner keeps warn-and-skip because it is a style gate, not a safety invariant
- Session started in a repo SUBDIRECTORY → same digest as the repo root: submodule paths enter the digest repo-root-relative (`git ls-files --full-name`) and are resolved against the toplevel, so the extension and the root-run hooks cannot disagree (a cwd-dependent digest used to reject every commit from a subdirectory of a repo with submodules)
- Ambient `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / … pointing at another repository → ignored: every git call in the fingerprint, its CJS mirror and the divergence checker runs with those variables stripped, so neither the digest nor the staged-divergence verdict can be redirected at a decoy repo
- Ambient `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` / `GIT_CONFIG_PARAMETERS` / … injecting `core.excludesFile` (or any other setting) → ignored: the whole `GIT_CONFIG*` family is stripped by prefix, so configuration injection cannot hide a real edit from the digest
- `git commit -a` / `git commit -- <path>` (git publishes a TEMPORARY index) → correctly judged: the hook forwards git's own `GIT_INDEX_FILE` as an explicit argument and the checker verifies it belongs to this repository, so these commits are neither wrongly blocked nor able to ship unreviewed content
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
  (Note the sidecar reward grew with `normal` mode: forging
  `taskMode: "normal", taskModeSource: "user"` makes the git hooks advisory.
  In-session enforcement is unaffected — L1 reads the in-memory state — and
  this is the same excluded class as forging `explore`+`user` or `bypass`
  today: a same-UID writer could equally delete the hooks.)
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
- A commit message supplied via `-F <file>` / `--file <file>` (or an editor
  session) — the in-session extractor only reads inline `-m`/`--message`
  payloads, so file-based messages skip the in-session attribution/L5 checks.
  The commit-msg git hook (L3) still scans the FINAL message file and remains
  the deterministic backstop for attribution.
- Fabricating the reviewer output fed to `record_review` — the reviewer is a
  subagent whose transcript necessarily transits the main agent, so the verdict
  rests on the cooperative assumption (the main agent can equally write the
  sidecar directly). Making it unforgeable would require the extension to spawn
  the reviewer itself and verify a receipt, like `run_precommit` (future
  hardening), not a runtime source check.
- **Git's content-transformation pipeline as a hidden fingerprint input.** The
  digest asks *git* what the worktree contains, so anything that reconfigures
  git's answer — `core.excludesFile`, `.gitattributes` filters/eol with the
  filter definition living in `~/.gitconfig` or `.git/config`, or a substituted
  `HOME`/`XDG_CONFIG_HOME` at invocation time — changes what the digest sees.
  Ambient `GIT_DIR`-style relocation and `GIT_CONFIG_*` injection ARE stripped
  (see above); these two remain, deliberately:

  1. An injected ignore rule can hide a **new untracked file** from the digest.
     Measured bound: such a file also cannot enter any commit — `git add -A`
     skips it, and the only way to ship it, `git add -f`, writes it into the
     real index, which moves the fingerprint and **fails closed** (verified).
     So a stale READY can never *publish* it; the blind spot is prompt-level,
     not ship-level.
  2. A **non-deterministic clean filter** can make the committed blob differ
     from every tree the gate hashed. Its definition must live in git config,
     which is the same privilege as editing the hooks themselves — the
     already-excluded control-plane class (a principal who can write
     `.git/config` can more cheaply delete `.git/hooks/pre-commit`). Note also
     that such a filter makes the digest of an *unchanged* worktree unstable
     (measured: A/B/A across three consecutive runs), so it mostly manifests as
     repeated fail-closed mismatches; publishing unreviewed content requires
     deliberately tuning the filter's state machine.

  Check your own machine with
  `git config --show-origin --get-all core.excludesFile` and
  `git config --show-origin --get-regexp '^filter\.'` — these list every active
  source. Treat a repo whose `.gitattributes` names a filter you did not
  knowingly install as hostile input during review (the `.gitattributes` edit
  itself always moves the fingerprint and lands in front of the reviewer).
  *Partially mitigated since:* one hook decision now materializes the worktree
  **once** and reuses it for both the divergence comparison and the digest (see
  below), so those two can no longer disagree with each other. A filter that
  varies between the review-time fingerprint and the commit-time one is still
  out of scope.

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

### Edit discipline (prompt-only nudges)

A recurring bad habit across sessions: when an `edit`/`write` tool call fails
(validation error, `oldText` mismatch, wrong tool name), some agents fall back
to `bash`/python to modify files directly (`sed -i`, `cat >`, `python -c`
writes, …) instead of fixing the tool call. This is corrected with **nudges
only — no blocking, no command rewriting** (`lib/edit-discipline.ts`):

1. **Standing guidance** — an `EDIT_DISCIPLINE_DIRECTIVE` paragraph is injected
   into the system prompt every turn in every non-normal mode: all file changes
   go through the `edit`/`write` tools; a failed call is fixed and retried, not
   worked around with bash.
2. **Failure feedback** — a failed `edit`/`write` tool result gets
   `EDIT_FAILURE_NUDGE` appended, telling the agent to retry the tool call.
3. **Workaround detection** — if the same turn then runs a bash command that
   looks like a direct file write (`sed -i`, `cat >`, `tee`, `python`/`node`
   writes, heredocs, …), that bash result gets `BASH_WRITE_NUDGE` appended.
   The window opens only on an edit failure and closes at turn start, on new
   user input, on a successful edit, and after one nudge — ordinary bash usage
   never pays for it, and nothing is ever blocked. All three sites are skipped
   in normal mode (the user-consented step-aside adds no extension text).

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
`file:line`. (Warn-and-skip is specific to this **style** gate. The
staged-divergence checker, which guards a safety invariant, fails closed when
it is missing — see the fail-closed inventory.)

## Development

```bash
npm test        # 600+ tests, node:test native TS (no build step)
```

### Why the suite is slow, and two rejected ways to speed it up

Two fingerprint regressions are reproduced by TIMING, not by construction, so
they loop (300 and 25 rounds). The 300-round loop alone is ~73s of a ~100s
`npm test`, and the review loop pays it on every round. Both attempts to cut
that cost were tried and withdrawn — they are documented here so they are not
re-attempted naively:

1. **An env knob (`RG_RACE_ITERS=25`) for a commit-time fast path.** Justified
   by a measurement — a mutated implementation (shadow-index backdate **and**
   `--renormalize` removed) missed the edit in 83/100 rounds — which would put
   the escape probability at 25 rounds near 0.17^25. An independent reviewer
   re-ran the same experiment and the mutated implementation **passed 3 of 5
   runs** at 25 rounds. The rounds are not independent trials (one shared
   repository; the window depends on filesystem timestamp granularity, load and
   pacing), so a per-round rate cannot be exponentiated into a guarantee. The
   knob was removed rather than kept with a vaguer claim.
2. **A "deterministic" replacement** — restore the cached stat after a
   same-size rewrite so the stat cache would consider the file clean. It does
   not fool git: ctime cannot be forged from user space and sub-second mtime
   still moves, even with `core.checkStat=minimal` and `core.trustctime=false`.
   The test passed against a fully mutated implementation, i.e. it asserted
   nothing. `test/fingerprint.test.ts` keeps a note so the next reader does not
   rebuild it.

The sound route, if these loops must get cheaper, is to make each ROUND cheaper
rather than run fewer of them (dropping the per-round commit measured
112ms/round vs 219ms/round) — and to prove the new construction still fails
reliably against the mutated implementation before adopting it.

Coverage boundary, stated explicitly: these loops fail only when **both**
safeguards are gone. Removing just `--renormalize` is caught deterministically
by `an edit to a file with an ancient preserved mtime is not invisible`;
removing just the backdate is caught by neither, because `--renormalize`
re-reads content unconditionally — the backdate is a deliberate redundant
second line of defence.

### Latency: where the gate actually costs you time

| Layer | Cost | Notes |
|---|---|---|
| Per-turn prompt fingerprint | ~65 ms (56 files) / ~575 ms (9k files) | Skipped entirely when the session tracks no change; otherwise memoized behind `advisoryChangeToken()` (~10 ms / ~47 ms) |
| Edit-time L6 label check | ~45 ms + one ~2 s model call | The model call is memoized per label set |
| `git commit` hooks | ~0.4 s (56 files) / ~2 s (9k files) | Four checks, each fail-closed |
| `run_precommit` (this repo) | ~100 s | Dominated by the two timing loops above; see the note on why they are not reducible |
| **A review round** | **~3 min reviewer + precommit run** | Dominates everything above by two orders of magnitude |

The practical consequence: batching edits into fewer, larger review rounds
saves far more wall time than any micro-optimization here, because the loop is
billed per round.

The fingerprint deliberately defeats git's stat cache (`git add --renormalize`,
~80% of its cost) because trusting that cache reintroduced a measured 25/1500
fail-open. It is therefore **not** cached across turns by any event-based
heuristic — `sed -i`, an external editor, or a background process all change
the worktree with no event to observe. The only memo is
`advisoryChangeToken()`: a filesystem probe (porcelain status + size/mtime of
every changed path) that gates a *prompt-rendering* recompute. Every
enforcement path — ship blocks, `declare_done`, `record_review`, arbitration,
and the git hooks — recomputes the real fingerprint unconditionally, so a
stale memo can only produce a stale prompt, never a stale gate decision.

Layout:

```
extensions/review-gate.ts     Pi extension (L1 + L2 + L4, tools, commands)
lib/workflow-commands.ts      sd0x-dev-flow command catalog and safe dispatcher prompts
lib/constants.ts              THE code-ext list, sensitive patterns, msg regexes, LANGUAGE_DIRECTIVE (L4)
lib/sensitive-grant.ts        one-shot user authorization for a sensitive-file edit (path-exact, TTL, in-memory)
lib/copilot-review.ts         L7 post-PR Copilot review cycle: bot identity, payload parsing, thread
                              classification, state machine (pure; no IO, no clock, never throws)
agents/adviser.md             consulting subagent, pinned model @ max (proactively consulted)
agents/reviewer.md            gatekeeper reviewer override, pinned model @ max
lib/model-ranking.ts          leaderboard-scored judge ranking (reference for the pins)
scripts/fetch-leaderboard.mjs opt-in, gate-external leaderboard fetcher (the only network I/O)
lib/shell-lex.ts              quote-aware shell lexer (segments + dequoted tokens)
lib/lang-detect.ts            L5: non-Latin-script detection for commit/PR English advisory
scripts/scan-test-labels.cjs  L6: non-English test-label scanner (pre-commit, staged content)
lib/precommit-receipt.ts      pure receipt validator (exit/verdict/count table → PASS/FAIL/ERROR)
lib/ship-detect.ts            bash → ship-command detection (+evasion & de-obfuscation)
lib/fingerprint.ts            worktree fingerprint (content-addressed git tree hash; staging-invariant)
lib/gate-state.ts             state machine, sidecar, unmetRequirements, plateau
lib/blocked-marker.ts         .blocked marker ownership (record failure, reclaim only our own/orphans)
lib/verdict-parse.ts          all-fence worst-wins verdict parser
scripts/precommit-runner.mjs  PASS/FAIL/NO_CHECKS_RUN runner; writes nonce receipt for run_precommit
scripts/install-project.sh    per-project installer (same layout as global)
scripts/install-git-hooks.sh  chained installer for L3
hooks/pre-commit|pre-push|commit-msg
skills/review-loop/SKILL.md   the loop protocol as a Pi skill
test/                         560+ tests incl. PR #7 regression suite
```

## License

MIT
