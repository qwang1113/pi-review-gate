# pi-review-gate

**Quality gates for [Pi](https://github.com/earendil-works/pi-coding-agent)** — ship-gate hard blocking, persistent gate state, auto-continuing review loop. Globally installable.

**Requires Node ≥ 22.19.0** (declared in `package.json` `engines`; the
`pi-hashline-edit-pro` companion needs it — the previous readmap companion
accepted Node 20).

> **新用户？先读 [QUICKSTART.md](QUICKSTART.md)（5 分钟上手），再看本文件。**

> Quality gates the model can't skip: `git commit`, `git push`, `gh pr create`, and `gh pr edit`
> are **hard-blocked** at the `tool_call` layer until an independent review is
> READY **and** precommit PASSes — both bound to the exact worktree state they
> verified.

## Why

Pi has no `Stop` event to prevent the model from quitting — but it has something better: `tool_call` blocking. Instead of intercepting "the model wants to stop", we intercept "the model wants to ship". Combined with `agent_settled` auto-continuation, the model fixes → re-reviews → re-runs precommit until every gate is green, and *cannot* commit around it.

Each session runs in one of **four gate modes** (strictness order `normal < explore < loop < orchestrator`), decided via the `set_gate_mode` tool — and the agent's own pick **is** the classification: no external classifier model is consulted for the mode. What makes that safe is not a second opinion but the rule engine's asymmetry (`lib/task-mode.ts`) — the agent can classify itself **into** the gate but never **out of** it. A first `loop` (or `orchestrator`) always applies, a first `explore` applies while this session is still clean, and all of them record `source: "auto"` so the git hooks stay fully enforced; a first `normal` (the gate switching off entirely) always pops the user's confirmation dialog. Outside `/tmp` that is the whole story; in `/tmp`, `scratchFirstMode` still cannot apply an enforced mode (only an explicit `explore` stays, otherwise `normal`). While the mode is undecided the gate behaves exactly like `loop` (fail-closed) and the per-turn system prompt instructs the agent to call `set_gate_mode` as its first action; “the agent never decides” therefore costs nothing.

**Only `/tmp` scratch sessions are path-exempt, and they never enter `loop` via the agent.** A session **started in `/tmp`** (macOS `/private/tmp` is the same dir through a symlink) is classified `explore` (investigation) or `normal` (local pi-config work / chores) on the first `set_gate_mode` call (`lib/pi-self.ts` + `scratchFirstMode`). Path detection is deterministic: the session cwd is chosen by the user — which is exactly why this is the one place a consent-free `normal` is allowed, since nothing the agent (or an injected prompt) asserts can reach it. A `loop` pick, or a missing one, becomes `normal`. A later agent `set_gate_mode loop` is rejected; only the user can force loop (`/gate-mode loop`). **Nothing else is path-exempt** — a session started in `~/.pi` or in this repository runs the full loop. Editing `~/.pi` *from* a `/tmp` session is the intended scratch case and stays out of loop.

- **`orchestrator`** — the **project-manager** role: everything `loop` enforces, plus the orchestration constraints. This session plans the work and supervises child sessions instead of doing it: it may not write code at all (only its plan under `.pi/` and `docs/orchestrator-*.md` handoff documents), it needs a plan the **user approved** before it may spawn anything, and `declare_done` additionally requires an empty task queue, no live children and no user decision it never reported. It requires tmux — its children are panes of the user's own window. See [The orchestrator role](#the-orchestrator-role-a-project-manager-inside-the-gate).
- **`loop`** — the full enforced workflow: review READY + precommit PASS gate every ship, auto-continuation drives the fix→review loop.
- **`explore`** — investigation/troubleshooting. Its one essential difference from loop: **the agent may end the task on its own judgment** — `declare_done` is always accepted (gate status is reported as advisory) and auto-continuation is off. Edits and `bash` stay **available** — the injected system prompt merely instructs the agent to prefer read-only work — because troubleshooting routinely needs diagnostic commands. Ship commands (`git commit/push`, `gh pr create/edit`) remain **fully gated by L1**: explore never weakens the in-session ship gate, so a misclassification only relaxes auto-continuation — the safe direction.
- **`normal`** — for non-development, non-research tasks: the extension steps aside as if it were not installed. No workflow prompt injection, no ship blocking, no auto-continuation, no L6 edit-time check, no LLM guard calls. Two things deliberately survive: the **output-language directive (L4)** — it is standing user policy, orthogonal to the gate — and the **sensitive-file guard** (`.env`/keys), a security floor — lifted only per file, per user dialog, via `request_sensitive_edit` (available in every mode). Because normal fully opens the in-session gate, **every interactive path into it requires the user's explicit consent** (a confirm dialog or `/gate-mode normal`) — including the agent's own first classification. Exactly two entries are consent-free, and neither is anything the agent asserts (source stays `"auto"` so the git hooks remain fully enforced): (1) a **`/tmp` scratch session**, where `scratchFirstMode` applies `explore` or `normal` automatically from the deterministic session cwd (a `loop` pick or a missing one becomes `normal`); (2) a **print/JSON (no UI) session**, which `session_start` switches to `normal` because the enforced modes cannot render their dialogs.

**Mode switching is asymmetric by design.** *Upgrades* (toward `loop`) apply immediately — tightening never needs consent — except in a `/tmp` session, where the agent cannot enter `loop` at all (first classification is remapped; later upgrades reject; only `/gate-mode` can force it). Agent-applied upgrades record `taskModeSource: "auto"`. *Downgrades* (toward `normal`) pop a confirmation dialog that the **extension** renders with fixed consequence copy; the agent's stated reason is shown as clearly-labeled untrusted data, and the tool deliberately has **no “confirmed” parameter**, so consent can never be claimed by the caller. A **declined** dialog locks agent-initiated downgrades for the rest of the session (anti-grinding); only `/gate-mode` or `/gate-reset` clears the lock. The **first** classification is consent-free only below `loop` in the gate-neutral direction: an `explore` pick applies automatically on an interactive session in which **this session has made no edits yet** — pre-existing worktree/branch changes from before the session do NOT block it (they arm the ship gate, but the mode records `source: "auto"` so the git hooks stay fully enforced); once the session itself edits, slipping into explore is a real downgrade and asks the user. A first `normal` is **never** consent-free for the agent (in `/tmp`, `scratchFirstMode` maps loop / missing picks to `normal` on the deterministic cwd signal instead). Print/JSON mode (no UI) cannot render those dialogs, so the session can **only** run `normal` (`evaluateModeChange` refuses every other mode; `session_start` switches headless sessions to `normal`).

For the *git hooks* (defense-in-depth outside Pi), the sidecar records *who* chose the mode (`taskModeSource`): pre-commit/pre-push treat explore/normal as advisory **only when the user chose it explicitly** (`"user"` — a confirmed dialog or `/gate-mode`) — this protects the user's own manual commits during such a session, while an agent-set mode keeps the hooks fully enforced (`"auto"`). You can override the mode anytime with `/gate-mode loop|explore|normal`.

### The orchestrator role: a project manager inside the gate

Some requirements do not fit in one session's context. The answer is not a bigger context — it is a session whose whole job is **supervising other sessions**: it plans the work, opens a child session per task, watches them, reports to the human, and hands over to a successor when its own context runs out. That is `set_gate_mode("orchestrator")`.

The design rule behind every tool below is one line from the user who asked for it: **if a tool can be provided, do not make the session assemble it.** Every failure measured in a hand-run orchestration came from improvised glue — a forgotten environment variable that silently broke the notification channel for a whole night, a waiting loop rewritten (wrongly) three times, a `split-window` typed at the wrong target. So the orchestrator expresses *intent* and the gate performs the *act*; it never types a tmux command, never writes a polling loop, never rolls its own notification.

| Tool | What the orchestrator asks for |
|---|---|
| `orchestrator_plan` | Read/replace the plan, submit it (the gate **audits** it with a judge process first and only then asks the **user** to approve), move a task through its state machine, record and resolve decisions only the human can settle. A rewrite that grants nothing new — a narrowed boundary, a file refined inside a directory the task already had, an added dependency — keeps the approval and records why; real widening still asks. |
| `orchestrator_spawn` | “Open a child session for task X.” The gate picks the split direction, injects the orchestration id, starts it in `loop` mode, creates an isolated worktree when the task will run in parallel, and registers the pane. |
| `orchestrator_wait` | The orchestrator's **one** information channel — call it every round. Blocking or, with `timeoutMs: 0`, an instant snapshot; the reply is the same either way (see below). |
| `orchestrator_answer` | Answer the question a child is holding. The question, every option and the full payload are already in the wait receipt — the child wrote them there, so nothing was read off a screen. Approving a child's loop goal happens here too, boundary-checked against the draft the CHILD wrote. |
| `orchestrator_instruct` | Say something to a child (`steer` / `followUp`) or stop it (`interrupt`). Nothing is typed at a terminal: the text goes through the child's channel and its own gate injects it with `pi.sendUserMessage`. |
| `orchestrator_notify` | The **only** channel to the human who is not watching the terminal. |
| `orchestrator_recover` | Bring a child back after its pane vanished — same `--session-id`, so its transcript continues rather than starting over. |
| `orchestrator_attach` | Take over a running orchestration: plan, children, unanswered questions, and the orphan tasks a crash left behind. |
| `orchestrator_handoff` | Hand the whole orchestration to a successor session. |
| `orchestrator_close` | Close a pane this orchestration owns — nothing else is addressable. |


**The plan is the exit contract**, and it is the orchestration-layer twin of the loop goal: writing `.pi/orchestrator-plan.json` grants nothing, because the approval binds to the **content hash** the user saw in a dialog the extension rendered. Widen a boundary or add a task afterwards and the approval is gone. Every task must declare the files it may touch — that one field is what makes parallel scheduling and proxy-approval decidable at all: two tasks whose boundaries overlap are never co-scheduled (they are deferred, with the reason reported), and a goal the orchestrator approves for a child may not name a path outside its task (that is a scope change, and scope belongs to the human).

**Addressing is by orchestration, not by session.** A child's wake-ups are stamped with `RG_ORCHESTRATION_ID`, not with the id of the session that spawned it — so when a relay hands the role to a successor, every running child keeps reaching whoever holds it now, with nothing restarted and nothing re-stamped. The relay's closing move is the guarantee that there is no gap: **only the successor may close the predecessor**, which means the old session stays alive until something demonstrably running has taken over. It inherits three things — the id, the handoff document, and a pointer to the predecessor's **transcript**, because a handoff document is a self-report and the raw record is what you need when the plan later goes wrong.

**Waiting is a tool, not a loop — and its receipt is the interface.** `orchestrator_wait` reuses the generic skeleton (`lib/poll-wait.ts`) with its own criteria, and they are not a judge's: an orchestration child is interactive, so it does **not** exit when it finishes — waiting for a process to end would hang forever. The end states are reports. Because it is the one call an orchestrator makes every round, **everything it needs is pushed into the reply** rather than left for it to go and fetch: (1) the health of every child, (2) the questions waiting for it — full text, every option, structured, because the child wrote them into its channel, (3) dead or silent children with the assets that survived them (branch, checkpoint, review verdict) and the action that recovers each, (4) the orchestrator's **own** context usage with the handover call the gate computed for it, and (5) what still blocks `declare_done`. Making an agent remember to check something is not a plan; it is a defect waiting for a busy round.

**Supervision reads a channel, never a screen.** Each child has one file of its own (`~/.pi/agent/rg-channels/<orchestration>/<child>.jsonl`), so isolation is a property of the medium rather than a recipient filter every reader has to remember. The child's own gate reports there — from an **independent timer**, not from agent events, because `judge_wait`, a full precommit and any long tool call all happen inside one turn, and a heartbeat that rode on `agent_settled` / `turn_end` went silent for minutes while the process was perfectly healthy. A known long block is reported as its own state, `waiting-judge` ("waiting for reviewer, 220s in"), which wakes nobody; `dead` is pane existence and `stalled` is a missing heartbeat, which now means what it says. A dialog is raised with an `AbortSignal` and answerable by **either** the human in the pane or the orchestrator through the channel — whoever answers first wins and the other side's box is withdrawn. There is no timeout anywhere in that path: the box staying up *is* the fallback if the orchestrator dies, and a timeout would turn "nobody is watching right now" into a permanent wrong answer.


**tmux is never typed.** All of it is argv built by `lib/orchestrator-tmux.ts` and executed without a shell; the layout rules (orchestrator alone in the left column, children stacked in the right one) live there once. A bash-layer backstop catches a session that goes around the tools: `kill-session`, `kill-server`, `kill-window`, `new-session`, `new-window`, a global option write and `kill-pane -a` are refused in every gated mode — they destroy or escape the one window the orchestration was agreed in — while `split-window`, `send-keys` and `kill-pane` are redirected to the tool that does the same thing properly. The gate holds **itself** to the same list: its own executor re-validates every argv, so “the gate is exempt from the guard” can never mean “the gate may do the forbidden thing”.

**Decision authority is explicit.** The orchestrator decides technical trade-offs, `/gate-bypass`, and a child's goal inside its task boundary — all on the record. Anything irreversible or security-relevant (discarding a worktree, authorizing a sensitive file) is the human's, and the gate refuses to let it be answered by proxy. A question it escalated but never actually **told** the user about blocks `declare_done`, which is the whole point for an unattended overnight run.

### LLM semantic guard layer (DeepSeek V4 Flash)

A fast, cheap model (`deepseek/deepseek-v4-flash`, configurable via `llmGuards.model`) gives **three guards** an additional **semantic layer**. It is deliberately **not** used to classify the gate mode — that decision belongs to the agent, bounded by the rule engine (see Gate modes). Design invariants, enforced by construction in `lib/llm-classify.ts`:

1. **Tighten-only** — an LLM verdict can only *add* a block or pick the safer side of an ambiguous case. Deterministic checks run first and short-circuit; the LLM is never asked to *approve* something a deterministic check blocked.
2. **Fail-back** — timeout (8s), spawn failure, or unparseable output degrade each guard to its exact pre-LLM deterministic behavior. No network ⇒ no regression.
3. **Injection-resistant** — classified text is wrapped in `<data>` tags as untrusted data; a hostile prompt can at worst flip one classification, which by (1)+(2) cannot open the gate.

| Guard | Deterministic base | What the LLM layer adds |
|---|---|---|
| Gate-mode classification (session start) | the rule engine (`lib/task-mode.ts`) alone | **nothing — deliberately.** The mode is the agent's own `set_gate_mode` pick; the engine's tighten-only asymmetry bounds it (a first `normal` still needs the user's dialog, `source: "auto"` keeps the git hooks enforced). In `/tmp`, the agent cannot enter `loop`: `scratchFirstMode` keeps only an explicit `explore` and otherwise applies `normal`. |
| AI attribution (`llmGuards.aiAttribution`) | `COMMIT_MSG_FORBIDDEN` regexes | Paraphrases: “pair-programmed with an assistant”, “drafted by a language model” |
| English check L5/L6 (`llmGuards.englishCheck`) | Unicode non-Latin-script detection | The romanization blind spot: pure-Latin pinyin/romaji commit messages, PR text, and test labels |
| Ship detect (`llmGuards.shipDetect`) | ~static shell parser (`lib/ship-detect.ts`) | Suspicious git/gh commands with dynamic constructs (base64-piped shells, inline-defined aliases) the static parser cannot resolve — a positive answer *adds* a detection; “none” changes nothing |

The L6 test-label check also moves **left**: the same lexer the git hook uses now runs at *edit time* in the extension (immediate feedback + the semantic layer), while the zero-dependency hook remains the deterministic backstop at commit time — hooks never call an LLM, so offline commits behave exactly as before. Edit-time scanning works on the **full projected post-edit file** (`lib/edit-projection.ts`): the current file content with every `oldText→newText` applied — so an edit that replaces only a label *string* still exposes the surrounding `it(...)` call to the lexer, and a fragment that cannot be applied is still appended and scanned rather than skipped.

The classifier child process is **fully isolated**: `pi -p --no-session --no-extensions --no-skills --no-tools --no-context-files --no-prompt-templates`, argv-array spawn (never a shell string), stdin closed immediately, 8s timeout. No extensions means the child cannot recursively load review-gate; no tools means a prompt-injected classifier can at worst emit wrong JSON — and the verdict parse is strict (the entire stdout must be exactly the one-key JSON object; echoed data or chatty prefixes ⇒ fail-back to deterministic behavior).

## Architecture — the enforcement layers

```
L1  Ship gate (HARD)      tool_call → block git commit/push, gh pr create/edit
                          until review READY + precommit PASS bound to the
                          reviewed HEAD commit tree (content binding);
                          publishing (push, gh pr, declare_done) additionally
                          requires a precommit run whose tests were NOT narrowed
L2  Auto-continuation     agent_settled → if gates unmet, inject
                          [REVIEW_GATE_RESUME] follow-up (recursion-guarded,
                          max 10 rounds, plateau detection; a user ESC abort
                          — "Operation aborted" — pauses the loop until the
                          user's next message). A STALL BREAKER stops the
                          injections when nothing moves (same fingerprint,
                          verdicts, round count and unmet list 3x in a row —
                          i.e. an external blocker such as provider quota);
                          a freshly running subagent counts as motion, so a
                          live review is never orphaned. Tighten-only: no
                          verdict is granted and ship stays blocked.
                          The resume text also carries the single-review
                          contract: ONE reviewer per round, no exceptions
                          (one reviewer, one commit range, one verdict)
L3  Git hooks             pre-commit / pre-push / commit-msg verify the gate
                          sidecar even for commits made outside Pi
L4  Output-language gate  before_agent_start → UNCONDITIONALLY inject a
                          strict Simplified-Chinese directive every turn
                          (thinking in Chinese too; protocol English tokens
                          READY/BLOCKED/commit-msg/code stay exempt)
L5  Commit/PR English     tool_call → HARD block when a commit subject/body or
                          a PR title/body contains ANY non-Latin letter (one
                          rule, one implementation: lib/lang-detect.ts). A
                          misjudgement is contestable with request_arbitration
                          (content-bound single-use pass, 3 per session);
                          in-session escape: /gate-bypass, outside:
                          REVIEW_GATE_BYPASS=1 (git hooks only). The language
                          directive (L4) + reviewer enforce English ship text
L6  Test-label English    pre-commit → block a staged it/test/describe label
                          containing ANY non-Latin letter, unless a
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
                          (`propose_loop_goal`). L8b: that dialog is not even
                          rendered until a dedicated `goal-auditor` audit of the
                          exact text is recorded as a PASS (a recorded FAIL, or
                          any edit to the text, still blocks)
                          (`propose_loop_goal` dispatches that audit
                          itself and parses the verdict itself);
                          an unapproved goal blocks
                          commit/push/PR at L1, blocks edit/write tool calls at
                          the tool_call layer (per repo — each repo checks its
                          own goal; undecided mode gates edits too, and the
                          goal body is withheld from the prompt)
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

### Two precommit lanes: cheap commits, honest ships

Binding every verdict to worktree content has one unavoidable consequence: a
one-character fix invalidates the previous PASS, so everything runs again. On a
large repo that is minutes per loop round, nearly all of it re-testing code the
round never touched. The runner therefore has **two lanes**: `/precommit-fast`
and `/precommit` pick one explicitly, and the gate picks `full` itself for a
review round and for every ship command.

| Lane | Runs | Satisfies |
|---|---|---|
| `fast` (default) | lint + typecheck + build + the tests **related to the changed files** | `git commit` |
| `full` | the same checks with the **complete** suite | `git push`, `gh pr create/edit`, `declare_done` |

The receipt reports `testScope`: `related` (narrowed), `full` (nothing was
narrowed away), or `skipped` (a runnable suite exists but no related set could
be derived). The **ship gate reads the coverage, not the lane** — a repo whose
suite cannot be narrowed reports `full` from the fast lane too, and requiring
the lane instead would deadlock it. An older sidecar with no `testScope` counts
as *not* full: the guarantee did not exist when it was written.

Related tests are derived per runner: **jest** is enumerated with
`--listTests --findRelatedTests` and then intersected with the script's own
path filter (jest *ignores* `--testPathPattern` next to `--findRelatedTests`,
so a `jest test/unit` project would otherwise have integration suites pulled
into its commit-time check); **vitest** uses `vitest related`. Anything else —
`node --test`, an unrecognized runner, a compound script — yields `skipped`,
and the fast lane simply does not run tests. One exception keeps that from
bricking a repo: if the underivable suite is the **only** runnable check,
it runs in full rather than leaving the run with zero checks.

The git hooks mirror the split exactly: `pre-commit` accepts any PASS,
`pre-push` re-execs it with `REVIEW_GATE_REQUIRE_FULL=1`.

One more hard refusal lives in the hooks (defense-in-depth, legacy): a
commit/push whose cwd is **inside a review snapshot** (a path segment
`rg-review-snap-*`, covering the default
`~/.pi/review-snapshots/<repo-key>/rg-review-snap-*` layout plus the
repo-local `*/.pi/review-snapshots/` and `<tmp>/` fallbacks) is rejected even
without a sidecar — a snapshot from an older install carries no `.pi/` but
shares the real repo's `.git`, so the "no sidecar → allow" rule would let a
reviewer's push ship the real repo. The 2026-08-27 execution model no longer
creates snapshots (reviewers judge immutable commit ranges as their own pi
processes), so this check only guards leftovers of older installs.
`REVIEW_GATE_BYPASS=1` still applies (human escape hatch).

### Project-level step configuration (`.pi/review-gate.json`)

A project can override which commands the runner executes per step — useful
when the default detection (package.json script priority table, ecosystem
fallbacks) does not match the project's actual commands. The `precommit`
section of `.pi/review-gate.json` is parsed per step; a missing config file,
unparseable JSON, or an invalid section falls back to the default detection
unchanged (fail-safe — a broken config can never change what the gate runs):

```jsonc
{
  "precommit": {
    "lint": "lint:fix",                 // string = package.json script name
    "typecheck": { "command": "tsc --noEmit" },  // raw shell command
    "build": null,                      // null = explicitly skipped
    "test": {
      "fast": { "script": "test:unit", "narrow": true },
      "full": { "command": "yarn test" }
    }
  }
}
```

- Each step (`lint` / `typecheck` / `build` / `test`) accepts: a string
  (package.json script name), `{ "script": "name" }`, `{ "command": "..." }`
  (run as-is, works without package.json), `null` or `{ "skip": true }`
  (explicitly skip), or omit it (default detection for that step). When both
  `command` and `script` are present, `command` wins.
- `test` may also be written per lane as `{ "fast": ..., "full": ... }`; a
  missing lane falls back to default detection.
- `narrow` only affects the **fast** test lane: `false` runs the configured
  command in full (testScope `full` — this fast PASS may then authorize a
  push, because nothing was narrowed); `true`/omitted tries to narrow and,
  when the command is not a single jest/vitest invocation, runs it in full
  rather than dropping it — an explicitly configured command is executed,
  never silently skipped. Only the default (unconfigured) fast lane drops the
  test step when narrowing is impossible.
- A configured `script` that does not exist in package.json skips that step
  with a visible reason in the log (never a silent fallback).
- **Skipping the test step is lane-honest**: `"test": null` / `{ "skip": true }`
  (or a missing configured script) reports `skipped` on the fast lane but
  `full` on the full lane — a `full` run covers the same (config-diminished)
  set, exactly like a project with no test script at all. This keeps the
  protocol invariant "mode full ⇒ testScope full" intact; a push is then
  authorized on the checks that did run.
- **No package.json**: the ecosystem fallback (Cargo/go/pytest/deno/just/make)
  still applies to an unconfigured test step under a partial config — a
  partial config never silently drops the project's real test suite. A
  configured `test` command replaces it.
- `lint:fix` keeps its special scheduling (runs first, alone) only when it is
  configured as the `lint:fix` script; a raw `command` runs in parallel with
  the other checks.

The status bar shows where the commands come from (`precommit: … · cfg` for
an active project section, `… · auto` for the default detection) and the
runner's summary line and the `run_precommit` reply carry the same
`config: project|default` tag.

> Note: `.pi/` is typically git-ignored (a common global rule ignores `.pi*`),
> so the config is a per-machine local file — write it once per clone; a
> missing file simply means "default detection".

### Generating the config: `/gate-init`

Run `/gate-init` (when the agent is idle) to generate `.pi/review-gate.json`
interactively — a **one-shot wizard**, not a step-by-step interrogation. The
agent detects the project's checks (package.json scripts, or ecosystem markers
when there is no package.json), reads any existing config as the **baseline**
(project-configured fields always win, never overwritten), and presents ONE
complete default configuration JSON covering every configurable field:

- **precommit** — each step (lint, typecheck, build, test.fast, test.full) as a
  script name, a raw shell command, or an explicit skip, plus the fast lane's
  `narrow` flag;
- **agents** — *optional*: only roles you explicitly name to customize, as
  `{ "auto": false, "slots": [...] }` (slot 0 = main model, slots 1.. =
  fallback chain, max 4, each with an optional `:thinking` suffix). An
  all-auto agents section is deliberately NOT written: an explicit `auto: true`
  renders a default-chain overlay in the project layer that silently shadows
  your **global** per-agent slots (`~/.pi/review-gate.json`) in this project;
  no `agents` section behaves exactly like all-auto without the shadowing;
- **scalar fields** — *optional*: only fields you explicitly name
  (`maxRounds`, `thinkHarder`, `gitMemory`, `docSync`, `llmGuards`, `arbiter`,
  `copilotReview`). Defaults for unnamed fields are deliberately NOT written:
  a project-layer default silently shadows your **global**
  `~/.pi/review-gate.json` value for that project (the same shadowing the
  `agents` section avoids).

You reply with **ALL your overrides in one message**; the agent applies them,
validates every model spec (`validateSpec`/`validateSlots` — an unresolvable
spec, unsupported thinking level, or opencode-go allowlist violation is
refused and reported back, never written) and every precommit script against
package.json, then writes the **merged** result: the `precommit` section is
always written (the required minimum), and `agents`/scalar fields only for
what you named — never defaults for unnamed fields, they would shadow your
global config. It then reports: the config takes effect immediately (the
runner reads the file on every run), the status bar shows `precommit: cfg`,
and a project `agents`
section (only when present) is rendered by the extension at session start
into `<project>/.pi/agents/*.md` — the `~/.pi/agent/agents/*.md` render comes
from the **global** `~/.pi/review-gate.json`, not from this file — so
`/reload` is needed for the `cfg`/`auto` indicator and the rendered chains to
appear in the current session.

**Maintenance contract:** the wizard is the single interactive entry point for
`.pi/review-gate.json` — whenever a new configurable field is added to the
config schema, `/gate-init` must be extended to cover it.

### Per-step result cache

Each step records the digest of the inputs it consumes; a later run whose
inputs are byte-identical reuses the recorded PASS and marks the step `cached`.
The run's verdict is still bound to the **current** worktree fingerprint, so
the gate's meaning is unchanged — "every check is green for exactly this tree"
— only the recomputation is removed.

The keys are **materialized git trees**, not `stat()` data: a cache hit skips
real work, so a key that can miss a change is a fail-open, and mtime/size
heuristics have a documented racily-clean blind spot (same-size edits in the
same mtime bucket — exactly what a "fix one character" loop produces). Steps
that provably do not consume documentation (`typecheck`, `build`, `test`) key
on the tree **minus** doc blobs, so a README edit leaves them cached; `lint`
never gets that narrowing, because linters and formatters do read Markdown.
A repo with a Markdown-consuming build (Astro, Docusaurus, VitePress…) or a
code step that itself invokes a Markdown-aware tool loses the narrowing too.
Only a PASS is cacheable, submodules disable the cache entirely (the parent
tree records only their gitlink), and every failure path — no git, corrupt
cache, unreadable tree — results in the step simply running.

### Incremental review rounds

The gate remembers the git tree the last READY review approved and the files
that review covered. When a new round starts it computes the increment and
injects a **review scope** block naming what was already approved, what is new,
and which of the previous round's findings must be re-checked one by one. The
reviewer still receives the full diff — the narrowing is in what must be
*re-derived*, never in what may be looked at, and the verdict still covers the
whole change (`agents/reviewer.md` spells this out).

It escalates back to a full deep review whenever the increment exceeds **20
files or 500 changed lines**, touches a file no previous review covered, or
cannot be computed at all. Incremental is never the default and never inferred:
it is granted only when every precondition holds.


The same economy now covers the other two review roles. The **goal-auditor**
persists every audit's verdict, findings (verbatim) and judged draft; a
re-audit of a revised draft gets a carryover block with the previous verdict,
findings and draft, and `prepare_goal_audit` replies with the complete
ready-made auditor task. The **adviser** runs on `prepare_adviser`, which
hands back a brief carrying the transcript pointer (fresh context — read on
demand, never inherited), the conclusion artifact the adviser appends to with
its `bash` tool, and — from the second consultation of a goal — the previous
conclusion plus the files changed since. All three roles are separate pi
processes and read the main session's transcript on demand
(`~/.pi/agent/sessions/<encoded-cwd>/<sessionId>.jsonl`) instead of inheriting
it. First audits/consultations are full; later ones are incremental, exactly
like reviewer rounds.
## Judges on a stronger model, pinned at `max`

The gate is only as good as the brain judging the work. Four independent roles
run on a **top-tier reasoning model at `max` thinking**, each with a fallback
priority list (first available wins). Those chains are the **built-in
defaults in the agent definitions** — decided up front, not re-selected per
task — and the `agents` config layer (see [Model configuration layer](#model-configuration-layer--per-agent-slots-and-the-auto-switch))
can override any of them per agent:

| Role | When | Gates? | Model priority (first = preferred) | Thinking |
|------|------|--------|-------------------------------------|----------|
| **`adviser`** (`agents/adviser.md`) | *before / during* work — the main agent is **encouraged to proactively consult** it on design, tradeoffs, risks, hard decisions | no, advises only | Fable 5 → Opus 5 → opencode-go/flash | `max` |
| **`reviewer`** (`agents/reviewer.md`) | *after* a diff exists — independent audit that emits the recorded verdict | yes (READY/BLOCKED) | Fable 5 → Opus 5 → opencode-go/flash | `max` |
| **`arbiter`** (`agents/arbiter.md`) | *only* when the agent contests a **circular** ship block via `request_arbitration` | rules GATE_WINS / AGENT_WINS / HUMAN on one `gh pr edit` | Fable 5 → Opus 5 → opencode-go/flash | `max` |
| **`goal-auditor`** (`agents/goal-auditor.md`) | *before the user sees a goal* — audits the DRAFT exit contract (checkable criteria, scope, non-goals, match with the ask, Simplified-Chinese rule) | yes — `propose_loop_goal` dispatches it and records its verdict itself, and shows no dialog without a matching PASS | Fable 5 → Opus 5 → opencode-go/flash | `max` |

`thinking` is a single value, not a fallback list; `max` is the highest valid
pi level (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` — pi clamps
models that lack a level down automatically). Proactively consulting the
adviser early is cheaper
than a failed review later, so the extension's per-turn reminder and the
`review-loop` skill both nudge for it.

### Execution tiers (L1/L2) — cheap models read, mid models execute

Beyond the L3 judges, two cheaper tiers do the mechanical work; design record
and numbers in `docs/parallel-execution-plan.md` (historical):

| Tier | Models (first = preferred) | Role | Verdict power |
|---|---|---|---|
| **L1 cheap/fast** | `claude-haiku-4-5` → `opencode-go/deepseek-v4-flash` | `agents/recon.md` — strictly read-only code/doc search and heavy reading. Thinking `low`/off. | none — advisory input for the reviewer |
| **L2 execution** | `claude-sonnet-5` → `claude-opus-5` → `opencode-go/deepseek-v4-flash` | `agents/fixer.md` — implements findings into a diff the main agent merges. Thinking `max`. | none — output reviewed by the main agent |

The chains are deliberately short: pi-subagents requires every fallback to
resolve in the active registry, so the pinned chains name only providers the
package can rely on (anthropic / opencode-go) plus the flash fallback. A user
who configures a onekey gateway / oc-sdk-go (`pi-opencode-bridge`) / a
DeepSeek subscription can extend the chains in
`~/.pi/agent/agents/*.md`. Protocol rules (in the
`review-loop`
skill, all default-on): every review round is ONE
reviewer over the whole change.

### "Which model is strongest?" — pinned chains, chosen up front

The model chains above are the single source of truth for every role.
They were chosen by capability reasoning (public leaderboards such as
Artificial Analysis, LMArena, LiveBench) but are **pins, not a runtime
selector**: the extension is fail-closed and network-free, and the agent
frontmatter (with its `agents` config layer) is what actually runs. Refresh
the pins deliberately — there is no out-of-band fetcher to re-score them.


### Model configuration layer — per-agent slots and the `auto` switch

You edit agent models more often than the extension re-renders them, so the
models are **configurable per agent** — layered like precommit (project
`.pi/review-gate.json` overrides global `~/.pi/review-gate.json`, then the
built-in frontmatter default), with an **`auto` switch** per agent:

```json
{
  "agents": {
    "reviewer": { "auto": false, "slots": ["onekey/gpt-5.6-sol:high", "claude-fable-5:max", "onekey/glm-5.3:high"] },
    "fixer":    { "auto": false, "slots": ["opencode-go/deepseek-v4-flash:high"] }
  }
}
```

- **`auto: true` (default)** — the agent runs on its built-in default chain.
  When set EXPLICITLY at a layer, the renderer writes a *default-chain
  overlay* (generated marker + the built-in default models) so that layer
  SHADOWS a lower layer's slot render — flipping a slot off always lands the
  built-in default, never a leftover lower-priority render. Unconfigured
  agents are cleaned up instead (any stale generated copy is deleted).
- **`auto: false`** — `slots[0]` becomes the main model, `slots[1..]` the
  fallback chain. With the reviewer's switch OFF the first usable slot
  (authenticated + allowed + judge-eligible) is the reviewer's model —
  your order is the priority. An `auto: false` entry
  with an EMPTY slot list is never a silent no-review state: it renders the
  built-in default chain (shadowing any lower layer's slots), with a
  diagnostic at render time so the deployed default is never a surprise.
- **Per-model thinking levels.** Every slot may carry its own `:thinking`
  suffix (`claude-fable-5:max`, `onekey/gpt-5.6-sol:high`); the renderer keeps
  the suffix on each candidate so pi-subagents applies the requested level per
  retry. A level the registry EXPLICITLY maps to null is refused on save —
  except `:off` on a `reasoning: false` model, which is always usable (the
  renderer never consults the map there); missing metadata follows
  pi-subagents defaults (all levels except `max`, while metadata-backed
  `xhigh`/`max` must be explicitly listed).

Rendering is layered the way pi-subagents loads agents: the project layer
renders into `<project>/.pi/agents/*.md` (which outranks user-global) and the
global layer into `~/.pi/agent/agents/*.md`. `scripts/install-package.mjs`
applies only the GLOBAL layer (its cwd is not trustworthy), rendering it
through a stripped data-URL import of `lib/model-config.ts`; the **extension**
re-applies BOTH layers at every session start — unconditionally, from a repo
checkout and on a published install alike — so the global layer plus the
current repo's project layer are always in force. That session-start pass is
also what sweeps stale generated overrides after you delete the `agents`
section, and what restores the upstream default when the global layer is
freed. Every write is validated first and refuses to land on failure.

The same session-start pass also **self-heals missing agent files**: any
`KNOWN_AGENTS` file absent from `~/.pi/agent/agents/` is copied back from the
package's own `agents/` directory (gaps only — an existing file is never
touched, so a configured chain cannot be clobbered). That directory is located
by PROBING the install layouts (`resolvePackageAgentsDir`: `<here>/agents`,
`<here>/../agents`, `<here>/../../agents`), the same three-layout approach
`resolveTrustedRunner` uses for the precommit runner. A candidate counts only
when it actually holds this package's roles (it must contain `reviewer.md`):
the third probe reaches two levels up, where an unrelated `agents/` folder can
live, and adopting one would feed foreign files to the renderer AND the heal.
A single relative path
resolves only in the dev repo, and a source that silently fails to resolve
would make both the render and the heal quiet no-ops. Without the heal a newly
shipped role only appears after the next postinstall, which for `goal-auditor`
would mean no goal could be approved (and, in loop mode, no edit made) until
then; when the probe fails, that is reported by `/gate-doctor` and by the goal
refusal copy rather than passing silently.

You configure it by editing the JSON directly — the `agents` section of the
global layer (`~/.pi/review-gate.json`) or the project layer
(`.pi/review-gate.json`, which outranks it). The extension validates and
renders both layers at session start (see above). The pi TUI's below-editor
widget shows the effective `adviser`/`reviewer` model, its auto state and its
source layer.

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
  "agents": {
    "reviewer": { "auto": false, "slots": ["onekey/gpt-5.6-sol:high", "claude-fable-5:max"] }
  },
  "llmGuards": {       // LLM semantic guard layer (all tighten-only + fail-back)
    "model": "deepseek/deepseek-v4-flash",
    "aiAttribution": true,
    "englishCheck": true,
    "shipDetect": true
  }
}
```

Every field is validated independently; a missing/corrupt config silently
falls back to defaults and can never loosen the gate. The `agents`
section is the one exception: a corrupt file (or a non-object `agents`
section) keeps the last rendered model chains instead of restoring
defaults — corrupt ≠ absent, and the sweep must never clobber a valid
render (fail-safe, same rule the postinstall applies).

**User-global config (`~/.pi/review-gate.json`) is the fallback layer.** The
same file shape may be placed in the user's home directory; the effective
config is merged **field-by-field** in the order defaults ← global ← project
(project values win). Sub-objects merge at their own level: `llmGuards` /
`arbiter` / `copilotReview` merge field-by-field, and `precommit` merges
**per step** (`lint` / `typecheck` / `build` / `test` — a step the project
mentions replaces that step only; an explicit `null` skip wins). The git
pre-commit hook reads the same two files for its `docSync` mirror (project
wins, then global, then the enforced default), so the extension and the hook
never disagree. A project that states nothing uses the user's global
preferences; a machine without either file runs the documented defaults.

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

### "It can't be done" is a hypothesis, not a finding-free pass

A weaker model — or the same model with too small a thinking budget — tends to
stop at the first local optimum and then justify it: *"the framework doesn't
support it"*, *"this can't be tested"*, *"the API has no such option"*. Every
layer above judges the diff, but nothing judges the **excuse** attached to it,
so the cheapest way to get a downgraded implementation past a review is to
assert that the good version was impossible.

The reviewer therefore treats impossibility claims as first-class review
material (`agents/reviewer.md`):

- **Find them.** They rarely arrive labeled: `TODO`/`FIXME`/"not supported"
  comments, tests skipped/`xfail`/deleted/gutted with "hard to test", the
  `[NIT_DEFERRED]` log, loop-goal non-goals that exist *because* something was
  judged impossible, and the agent's own handoff prose ("blocked by", "would
  require a rewrite").
- **Verify with hard evidence**, never by reasoning about the author's
  reasoning: the dependency source line that actually imposes the limit, the
  documented type signature, the output of a reproducible read-only command, or
  a minimal counter-example that makes the "impossible" thing work.
- **Grade it.** Refuted **and** it caused a degraded implementation, a skipped
  test, or a bypassed requirement ⇒ **P1** (⇒ `BLOCKED`). Refuted but harmless
  (a stale comment) ⇒ **P2**. Evidence insufficient either way ⇒ a Note naming
  the cheapest check that would settle it — "I did not verify" never silently
  becomes acceptance, and an unevidenced hunch never becomes a P1.

The main agent's side of the deal (`skills/review-loop`): hand the reviewer an
explicit list of everything you gave up on, worked around, or declared
infeasible this round, with your evidence — as claims to check, not as
conclusions. This is prompt-level enforcement by the judges, not a new gate
requirement: no verdict field was added, and the fail-closed machinery below is
unchanged.

## Install

### As a pi package (recommended — extensions, skills, agents, hooks in one step)

This repo is a standard **pi package** (`pi` manifest in `package.json`):

```bash
# Development / local-path install (no copy — edits apply on reload)
pi install /absolute/path/to/pi-review-gate

# Published form (when the repo is published to npm)
pi install npm:pi-review-gate
# or from git
pi install git:github.com/<you>/pi-review-gate
```

The package's `postinstall` (`scripts/install-package.mjs`) runs automatically
on `pi install` / `npm install` and:

1. copies `agents/*.md` → `~/.pi/agent/agents/` (pi-subagents loads them there),
2. registers the **companion pi packages** this extension needs at runtime —
   the pinned platform in `package.json` `dependencies` — via `pi install` when
   they are missing from `~/.pi/agent/settings.json` (idempotent:
   already-present packages are left untouched): `pi-subagents` (the
   spawn-reviewer protocol), `pi-opencode-bridge` (the opencode-go provider),
   `pi-anthropic-oauth`, `pi-mcp-adapter`, `pi-notify`, `pi-vim`,
   `pi-web-access`, `@narumitw/pi-lsp` and `pi-hashline-edit-pro`.
3. if the current directory is a git repo, installs the git hooks into it
   (idempotent; chained, never clobbered).
4. writes pi-subagents' **fleet-inspector keybindings** into the global subagent config
   (`~/.pi/agent/extensions/subagent/config.json`) — vim-style page bindings
   (`Ctrl+b` up / `Ctrl+f`, `Ctrl+d` down) for scrolling a subagent's session
   history on keyboards without PageUp/PageDown. Smart-merged, never clobbered:
   the file is created when missing, `fleetKeybindings` is added when absent
   (all other fields preserved), and an existing `fleetKeybindings` is left
   untouched — your own bindings win. To customize, edit that file's
   `fleetKeybindings`; to restore the defaults, delete the field (or the file)
   and reinstall.

So a fresh `pi install pi-review-gate` on a pi with a working provider setup
gives a working loop out of the box — no manual companion installs needed.

Then restart Pi or run `/reload`. Per-repo git hooks in other repositories:

```bash
bash <package-root>/scripts/install-git-hooks.sh   # inside the repo
# or, with the package installed locally as a dependency:
npx pi-review-gate-install-hooks
```

### Legacy global installer (deprecated)

`scripts/install-global.sh` was retired when the repo became a pi package;
use `pi install` above instead.

### Single-review loop: judge roles as their own pi processes (2026-08-28 model)

**Judge roles (reviewer / adviser / goal-auditor) run as their own
non-interactive pi processes (`pi -p --session-id`) — no tmux pane, no
workflow engine, no subagent dispatch.**

**Review runs one reviewer per round, and the gate runs the whole chain.**
The agent makes ONE call — `judge_submit({role:"reviewer", task})` — and the
gate does the rest: a full precommit, the checkpoint commit (the only commit
allowed before a READY), the `baseline..HEAD` computation, and the dispatch.
The review unit is that immutable COMMIT RANGE. The judge child is a fresh pi
process with no review-gate extension loaded and `--exclude-tools edit,write`;
its session id is deterministic per role+repo, so the next round continues the
same conversation. Completion is the process EXIT: the gate reads that round's
output, records the verdict itself (binding a READY to the reviewed commit's
TREE — content binding, so a squash preserves it; a READY whose HEAD moved is
STALE ⇒ BLOCKED) and wakes the main session with it. Because the reviewed
range is immutable, the agent keeps fixing the real worktree while the
reviewer runs. Subagent dispatch of judge roles is HARD-blocked (a judge as a
subagent would run in the live worktree with no isolation). One reviewer, one
commit range, no second reviewer.

**The decompose module loop and wave daily were removed (2026-08-26).**
There is no module table, no wave scheduling, and no plan state to consult:
large tasks are sliced by the agent into sequential rounds of the same
single-review loop.

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
setup_workspace()            # settle the worktree, create this session's work branch
ask_user(...) → propose_loop_goal(...)   # negotiate the exit contract (the gate audits it)
edit code (batch related edits — the loop is billed per ROUND, not per line)
  → judge_submit({role:"reviewer", task})   # ONE call: the gate runs precommit →
                                            # checkpoint → baseline..HEAD → dispatch
  → the judge's process EXIT wakes this session; the gate already recorded the verdict
  → BLOCKED? fix the findings, then judge_submit again
  → READY?  call declare_done                             # re-validated server-side, merges the branch
  → ship    (git commit now passes the gate)
```

**One reviewer per round, whatever the diff size.** There is no tiering:
the gate registers ONE commit range for the whole change, regardless
of how many files or lines it spans, and the reviewer audits it all.
The verdict schema is `REVIEW_VERDICT_SCHEMA` in `lib/parallel-review.ts`.

**Precommit runs FIRST, review second — never concurrently.** The runner
schedules itself (no flags): any `lint:fix` script runs FIRST — it edits
files, so the worktree stabilizes before anything reads it — then the
remaining checks (lint/typecheck/build/test) run in parallel with
declaration-order output. The review then spends the expensive judges'
(max thinking) time only on a tree the cheap checks already confirmed
green. This order is deliberate: a precommit FAIL is cheaper to fix before
the expensive judge looks, and a review spent on a red tree is a fully
wasted round — an earlier design ran both concurrently to save wall time
and was abandoned for exactly that reason. Design record:
`docs/execution-model.md`.

The reviewer should end with a fenced JSON verdict:

```json
{"gate": "READY" | "BLOCKED" | "NEEDS_HUMAN",
 "cwd": "<the judge child's own pwd — checked against the reviewed repo>",
 "docSync": "UPDATED" | "NOT_NEEDED",
 "findings": [{"file": "src/x.ts", "line": 42, "severity": "P1", "issue": "..."}]}
```

Review verdicts require **JSON fences**. Precommit verdicts are NOT parsed from
bash output at all: the gate spawns the trusted runner itself
and records the result from a verified nonce receipt, so a `## Overall: ✅ PASS`
sentinel printed by any other command can never grant a PASS.

### Loop goal — the exit contract, negotiated with the user (L8; the edit gate also covers undecided mode)

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

- **Grill first.** The directive tells the agent to interview the user one
  question per turn — each labeled "N of M" and carrying its own recommended
  answer, all at once only when the user asks for it — until nothing is left
  silently assumed. Facts are the agent's job (read the repo, run the tools);
  only decisions go to the user.
- **Then the goal-auditor — mechanically (since 2026-08-25).** The agent makes
  ONE call, `judge_submit({role:"goal-auditor", task:<the full draft>})`: the
  gate builds the auditor task (with the previous audit's carryover + the draft
  delta on a re-audit), dispatches the judge as its own pi process, and records
  the verdict when it exits.
  The **extension** parses the auditor's JSON fence
  itself (PASS ⇔ a `READY` verdict, which verdict-parse already withholds from
  a fence carrying unresolved P0/P1, and a salvaged fence can never be READY)
  and hashes the audited text itself — there is no `passed` parameter, so the
  agent cannot ATTEST the outcome (it can only carry the auditor's output, the
  same trust boundary as `record_review`: a hand-written `auditor_output` is
  not defended against, see the limits list below). A FAIL means: fix the
  objections and re-audit; the revised text needs its own PASS. The goal text
  is written in **Simplified Chinese** (identifiers, paths and code tokens stay
  English); the auditor blocks a draft that is not.
- **Then `propose_loop_goal`.** It first checks the sidecar's pre-review record
  and REFUSES — with no transcript echo, no dialog and no file write — unless a
  PASS is bound to the exact submitted text (missing or hash-mismatched both
  fail closed; there is no TTL). The refusal names the repo it checked and the
  submitted first line; on a HASH MISMATCH it also echoes both hash prefixes,
  so an invisible whitespace edit is diagnosable. Only
  then does the **extension** show the negotiated text in
  a confirm dialog, and only if the user approves does the extension write
  `.pi/loop-goal.md` and record the sha256 of exactly that text in the sidecar.
  There is no `confirmed` parameter the model could set. The dialog also shows
  the pre-review fact (`goal-auditor 预审: PASS @ …`), appended AFTER the
  repo-binding line so the 200-char `extraUntrusted` cap eats the pre-review
  sentence FIRST. The repo binding itself is only at risk from a
  pathologically long repo path (measured: it survives up to ~182 chars), which
  is a property of that line's own length, not of the appended sentence.
- **Approval binds to CONTENT.** Editing the file afterwards changes the hash
  and drops the approval — the contract the user agreed to no longer exists.
- **Unapproved ⇒ blocked and unquoted.** In loop mode an unapproved goal blocks
  `git commit` / `git push` / `gh pr` at **L1**, and its body is *withheld* from
  the prompt (only a "a draft exists, renegotiate it" note is injected).
  Blocking at ship time is the point: by `declare_done` the code is already
  pushed and agreeing on the goal would be theatre.
- **Edits are gated too (since 2026-08-23).** In loop mode (and while the mode
  is undecided, which behaves as loop) an unconfirmed goal ALSO blocks
  `edit`/`write` tool calls at the `tool_call` layer — the negotiation must
  happen BEFORE the work starts, not after. Each repo checks its own goal
  (one repo's approval never opens another's write surface); `.pi/` and
  `.pi-subagents/` writes stay exempt so the gate cannot deadlock on its own
  files. The block message points at the full path: grill → draft in Simplified
  Chinese → `propose_loop_goal` (that ONE call runs the `goal-auditor`
  audit itself, then shows the dialog). The confirm dialog no longer asks
  for an optional reason (approval is the whole signal); a REJECTION still asks
  for the reason, which is carried back to the agent for renegotiation.
  (One deliberate exception: a judge child's own THROWAWAY worktree is inert —
  the L8 edit gate does not block a reviewer's mutation analysis inside the
  disposable checkout it made of the reviewed range; the L1 sensitive-file
  floor and the bash ship gate stay active there.
  See `docs/subagents-collaboration.md` §5.)

**What deliberately did NOT change.** The L3 git hooks and the verdict logic
stay blind to the goal: an approval is a *dialog* fact, and a hook cannot show
a dialog — a hook that failed on an unapproved goal would block commits it can
never unblock. So the requirement lives in the extension's L1 path and in
`declare_done`, never in `unmetRequirements()` (a structural test pins this).

- **Who uses it.** The main agent slices the work against the goal (write
  subagents serially in the same worktree — their edits move the worktree
  fingerprint, so a review recorded earlier can no longer ship them; read-only
  subagents may run in parallel), `adviser` advises against it, and `reviewer`
  accepts against it criterion by criterion. Reviewers get the goal through the
  spawn task text — the judge child never reads the sidecar directly,
  so the goal file is not readable inside one (see `prepare_review`). The main
  agent stays the writer of record: it runs precommit, the review, and the
  fixes.
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
- **An unhandled finding outranks everything else**, including head drift and a
  `SATISFIED` verdict from an earlier cycle: as long as a Copilot thread is
  unresolved and Copilot spoke last, the status is `OPEN`. This cannot
  deadlock — replying or resolving needs nobody but you. It is also the fix
  for a real bug: GitHub does **not** re-review a new head by default, so
  after you push, the old thread is frequently the ONLY feedback that exists.
  The state machine used to ask "has Copilot reviewed the current head?"
  first, answer no, report `AWAITING`, and let the wait budget expire —
  releasing the task with the comment never handled. A cycle can still be
  released with findings open — but only by a fail-safe path that cannot see
  the PR any more (it vanished, `gh` lost its credentials, the API refused).
  Those paths report the count they are abandoning and tell you to take it to
  the user; they never go quiet.
- **Completion-only, never the ship gate.** Fixing a Copilot finding requires a
  commit and a push, so a Copilot requirement inside the ship authority would
  block its own remedy. It gates `declare_done` (hard in loop mode, advisory in
  explore) and rides the auto-continuation on its **own** budget, so waiting for
  Copilot never eats the rounds the fix→review loop needs.
- **It can never strand a task — and there is no round cap.** No `gh`, no
  GitHub remote, no PR, an API refusal, or an unreadable thread query ⇒
  `UNSUPPORTED`, requirement released. A Copilot that never answers ends as
  `EXHAUSTED` after the 20-minute **wait** budget, with an explicit "escalate
  to the user" note. There is deliberately **no cap on review cycles**: a cap
  could only ever end a task with the reviewer's comments unhandled, and
  another round costs nothing but your own work. The wait budget is the one
  remaining bound, and it fires exactly when there is no feedback to lose.
- **"Can this repo do Copilot review?" is answered by evidence, because nothing
  else works.** GitHub exposes no capability API (`RepositorySuggestedActorFilter`
  only has `CAN_BE_ASSIGNED`/`CAN_BE_AUTHOR`, neither of which is about
  reviewing), and — measured on a repository where the request is silently
  dropped — `gh pr edit --add-reviewer @copilot` exits 0, the REST
  review-request endpoint answers 200, and `reviewRequests` then stays empty on
  **every** surface (gh JSON, GraphQL, REST) with no `ReviewRequestedEvent` in
  the timeline. So neither exit codes nor request read-backs can distinguish
  "dropped" from "not visible yet"; both were removed after they declared
  healthy repositories unsupported. What is left is positive evidence, in
  order:
  1. **CONFIRMED** — a Copilot review or thread exists on this PR, or on any of
     the repository's last 20 PRs (one GraphQL query, then remembered in the
     sidecar);
  2. **ASSUMED** — the repository owner is listed in `copilotReview.owners`
     (default `["onekeyhq"]`): the cold-start case, where a repo that does
     support Copilot has simply never been asked;
  3. **UNKNOWN** — neither. The requirement is released as `UNSUPPORTED`
     **immediately** rather than burning the 20-minute wait, with a note
     naming the config key that would change the answer.

  A repository is self-healing: one real Copilot review anywhere in its recent
  PRs flips it to CONFIRMED for good.
- **The wait budget belongs to the cycle, not to the last request.** Calling
  `request_copilot_review` again does not push the 20-minute deadline out: it
  is anchored on the cycle's *first* request (`firstRequestedAt`). Only a new
  PR-affecting ship — which legitimately re-arms the cycle — starts a fresh
  wait.
- **A released cycle stays released.** `SATISFIED` / `UNSUPPORTED` /
  `EXHAUSTED` are decisions, not snapshots: `evaluateCopilot` short-circuits on
  them and `check_copilot_review` reports the stored outcome without spending
  `gh` calls or rewriting it. **Nothing re-opens a released cycle by
  observation** — re-entry is an explicit act: a new PR-affecting ship
  (`armCopilotReview` on a push, `gh pr create` or `gh pr edit` seen by the
  gate, with the cumulative round count carried over), or the agent calling
  `request_copilot_review` again. The state machine also
  still re-arms a `SATISFIED` cycle whose head moved (the review no longer
  describes the code), but that is now defense in depth rather than a live
  path: the check returns before it could fire, so in practice the ship is
  what re-opens the cycle. Observed for real: the very next check after a
  release re-derived `ARMED` and blocked `declare_done` on a requirement the
  gate had already let go.
- **Known limit, stated honestly.** The gate verifies the *structure* (resolved,
  or answered by you), never the *substance* of a reply — "won't fix: out of
  scope" and "ok" are indistinguishable to it. That limit is inherent to the
  rule it enforces, the same way `docSync` trusts the reviewer's attestation
  instead of counting touched files.

Configure per project in `.pi/review-gate.json`: `"copilotReview": { "enabled":
false }` turns it off, `"owners": ["acme"]` replaces the owner allow-list (an
empty list means "evidence only").

### Dialogs stay short, long text goes to the transcript

Two user-visible channels, and the rule for choosing between them is not
cosmetic — it is a rendering constraint:

- **`ui.confirm` = the decision only.** The host renders `title + "\n" +
  message` as *one unclipped, unscrollable block* in the editor container at
  the bottom of the screen. Nothing truncates it, so the dialog is exactly as
  tall as the extension makes it.
- **`ui.notify` = anything long.** The transcript scrolls; the dialog does not.

**Why `ui.notify` and not `pi.sendMessage`.** Inside a tool the session is
streaming, so `sendMessage` is *queued*, not rendered. With
`deliverAs: "followUp"` it lands in the follow-up queue, which `agent-loop.ts`
drains at the point the agent would otherwise STOP — so it silently buys
another LLM turn (fatal for `ask_user`, whose entire job is to stop
the loop) and still shows nothing until the turn ends, which would make a
dialog saying "full text above" a lie. Interactive `ui.notify` is synchronous:
it appends a `Text` to the chat container and requests a render immediately, so
the content is on screen *before* the dialog that asks about it.

Why it matters: while a tool awaits a dialog the agent is still mid-turn, so
the working spinner keeps animating — and the spinner row sits *above* the
editor container. Once the dialog plus everything under it is as tall as the
terminal, the spinner row falls above pi-tui's `prevViewportTop` and every
animation frame takes the `firstChanged < prevViewportTop` branch in
`tui-main-screen.ts`, i.e. `fullRender(true)` → `\x1b[2J\x1b[H\x1b[3J`:
clear screen, clear **scrollback**. Ten spinner frames a second means ten
screen wipes a second — the terminal appears to flicker while the user is
trying to read the very dialog that caused it.

Measured against the real `TuiMainScreen` (40-row terminal, 30 spinner frames):

| dialog + rows below | full-screen clears |
|---|---|
| 39 rows | 0 / 30 |
| **40 rows (= terminal height)** | **29 / 30** |

So `lib/dialog-budget.ts` bounds every dialog by **rendered rows** — CJK is
double-width, and soft wrapping means a 40-character Chinese line costs a full
80-column row — sized for a 24-row terminal: 24 − 8 (selector chrome) − 2
(footer) − 2 (slack) = **12 rows for title + message together**. Every
`ui.confirm` in the extension goes through `confirmBounded`, which applies it;
`test/extension-structure.test.ts` fails the build if a call site bypasses it.
Where truncation is possible, the fixed consequence copy is written *first* and
the agent's untrusted text last, so what gets dropped is never the statement of
what "yes" grants.

Guards: `test/dialog-budget.test.ts` (always runs) and
`test/tui-flicker.test.ts`, which drives the real renderer and asserts both
directions — a budgeted dialog never wipes, the pre-fix height still does. The
latter skips when pi-tui cannot be resolved (it ships with the globally
installed pi, not with this repo).

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
- **Per-repo loop goal (L8)**: editing repo B requires a goal the user
  approved **for repo B** — `propose_loop_goal`'s `repo` parameter binds a
  goal to a specific repo (default: the session repo); approving only repo
  A's goal leaves B's edit/write calls blocked.
- **Explicit target repo**: the judge tools (`judge_submit` / `judge_read` /
  `judge_wait` / `judge_close`) take a `repo` argument, and it is **mandatory
  once the session has edited more than one repo** — they refuse to guess, and
  so do the internal steps a round runs (`record_review` / `run_precommit`).
  Run the loop once per repo, naming it.
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
| `/gate-status` | Show workflow mode, verdicts (including the precommit lane and its `testScope`), rounds, fingerprint, unmet requirements, and the last precommit's slowest steps from `.pi/gate-timings.jsonl` |
| `/gate-mode loop\|explore\|normal\|orchestrator` | Switch the session workflow in any direction without a dialog (user-invoked = explicit consent; also clears the agent-downgrade lock). `explore` makes gates advisory and lets the AI self-complete (ship commands stay gated). `normal` switches the gate off entirely for this session. `orchestrator` puts the session in the project-manager role (requires tmux; refused without it). |
| `/gate-bypass <reason>` | Disable ship blocking (user-confirmed, reason required, logged in state) |
| `/gate-reset` | Reset gate state (mode returns to undecided — the agent re-decides via `set_gate_mode`; also clears the agent-downgrade lock) |
| `/gate-lesson <text>` | Append a lesson to `.pi/review-gate-lessons.md` (self-improvement log) |
| `/gate-doctor` | Read-only health check: verifies every optimization this package ships actually works in the current environment — agent model chains, `goal-auditor` dispatchability (the role that gates goal approval), opencode-go models-store prune, precommit runner, git hooks, user-global config fallback, L5 language gate, Copilot gh compatibility, workflow command registry. Prints `PASS / FAIL / WARN` per check with evidence and repair advice; writes nothing and never feeds a gate verdict |

### sd0x-dev-flow workflow commands

These high-value commands are native Pi extension commands, so they work as short
aliases without loading a large skill catalog into every session. Commands that
can ship default to a dry run and still pass through the same hard review gate.

| Command | Effect |
|---------|--------|
| `/review [focus]` | Explicit trigger for one review round: `judge_submit({role:"reviewer"})` runs precommit → checkpoint → `baseline..HEAD` → dispatch, and the gate records the verdict when the judge's process exits. The agent starts this loop itself — the command is only the manual entry |
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

> **This table lists only what a model can actually call.**
> Ten entries left this table on 2026-08-30 (philosophy three: never run two
> implementations of the same thing). `run_precommit`, `review_checkpoint`,
> `prepare_review`, `prepare_adviser`, `prepare_goal_audit`, `record_review` and
> `record_goal_prereview` are **still the implementations** the gate runs —
> `judge_submit` and `propose_loop_goal` call them internally, so every
> mechanical check lives in exactly one place — but they are registered into
> the extension's own `internalHost` instead of into pi, and a model cannot
> see the names. What they do is still exactly how the gate works, so their
> descriptions were not deleted: they moved to
> [Internal implementations](#internal-implementations--not-registered),
> below the table. Anything in them that reads like an instruction to the
> agent ("ADVANCED / internal — call this only when…") is describing the
> gate's own internal step. `review_spawn`, `review_watch` and `review_send`
> were deleted outright, module included.

| Tool | Purpose |
|------|---------|
| `set_gate_mode` | The agent's in-session mode decision/switch (`loop`/`explore`/`normal`/`orchestrator` + a reason). The agent's pick IS the classification — no classifier model reviews it. On the FIRST call (mode undecided, this session has made no edits yet — pre-existing changes from before the session don't count — interactive session) `loop`, `orchestrator` and `explore` apply directly with source `auto`, while `normal` still pops the confirm dialog. Everything delegates to the pure rule engine in `lib/task-mode.ts`: upgrades apply immediately (source `auto`); every downgrade pops an extension-rendered confirm dialog (fixed consequence copy, agent reason labeled untrusted); a declined dialog locks agent-initiated downgrades for the session. `orchestrator` additionally has two environment preconditions checked before the engine runs: no `$TMUX` (its children ARE panes) and "this session is itself somebody's orchestration child" (it would take over the channel of the orchestration supervising it) are both refused. |
| `setup_workspace` | Settles in ONE call where this session works: what happens to changes that were already in the worktree (adopt them as this session's baseline / the user handled them / the gate discards them) and which branch is the BASE the work must end up in. The **extension** asks the user, executes what they chose — including creating the work branch — and records every step in its branch log, which `declare_done` later follows back to merge. Call it once, early: while a dirty worktree is unsettled edits are refused, and without a work branch commits are refused. |
| `ask_user` | The ONE way to reach the user — requirement ambiguity, a product/design decision, scope trade-offs, the loop-goal interview. Calling it **pauses** the loop until the answers come back, which is why a question written into the reply and an ended turn is not an alternative: that costs a whole iteration and may not even read as a question. The extension runs the interview itself (one question at a time with its `N / M` progress, choices when the call supplied options, free text otherwise, plus "answer in chat" and "skip the rest"), and every answer returns at once with the unanswered ones marked. It replaced `pause_for_question`, which was deleted on 2026-08-30: that tool only *paused*, leaving the agent to restate the question itself — two ways to reach the user, one of which delivered nothing. Asking permission to continue routine loop work is still prohibited. |
| `judge_submit` | The ONE entry point for a judge round (`reviewer` / `adviser` / `goal-auditor`). The call passes WHO and WHAT; the gate owns everything procedural — session id, working directory, spawn vs. resume vs. kill, the completion listener — so no session id, title or directory is ever passed in. For `reviewer` it runs the whole chain itself: the FULL precommit, the checkpoint commit (it stamps the checkpoint marker), the `baseline..HEAD` computation and the finding-stream file, then the dispatch; any step that fails sends the round back with the reason instead of leaving it half-submitted. The judge child is a fresh non-interactive pi process (`pi -p --session-id`, deterministic per role+repo, no review-gate extension loaded, `--exclude-tools edit,write`); dispatching a judge role through `subagent` / `workflowScript` / `workflowScriptPath` is hard-blocked instead. It returns as soon as the round is SUBMITTED, not when the judge is done: the child's process EXIT wakes this session, and the gate reads that round's output and records the verdict itself. A role whose process is still RUNNING refuses the round (nothing is silently dropped) unless `fresh: true` kills it first. POLISH GATE: after two consecutive READYs, or the same file polished for three rounds, a reviewer round without a `reason` is refused, and the reason travels into the reviewer's task text. |
| `judge_read` | Snapshot of a judge role — never a wait: its session state (running / finished + exit code), the tail of its stdout log, the conclusion parsed from its transcript (the last assistant text carrying a verdict fence), and its stderr tail. The process may already be gone; the transcript and the logs are not. |
| `judge_wait` | Block until a role's current round is over, then return what it produced. This is the FALLBACK, not the normal path — `judge_submit` already wakes the session on completion, so it is for when there is genuinely nothing else to do. Three independent criteria end the wait: the process exited, its exit-code file landed, or a verdict/question fence is already in that round's stdout. On timeout it returns the current state instead of failing, so the decision stays with the agent. |
| `judge_close` | Terminate a judge role's pi PROCESS (SIGTERM) and drop it from the registry. Not a memory wipe: the transcript stays on disk, so the next dispatch of that role resumes the same conversation. Idempotent — an already-finished child still closes successfully. `declare_done` requires an open judge child to be closed out (its verdict is recorded on exit, or by this tool). |
| `orchestrator_plan` / `orchestrator_spawn` / `orchestrator_wait` / `orchestrator_answer` / `orchestrator_instruct` / `orchestrator_notify` / `orchestrator_recover` / `orchestrator_attach` / `orchestrator_handoff` / `orchestrator_close` | The orchestration layer, available only in `orchestrator` mode — see [The orchestrator role](#the-orchestrator-role-a-project-manager-inside-the-gate). The decisions live in `lib/orchestrator-*.ts` (plan state machine, the plan pre-audit, whether an edit widened anything, file-boundary algebra, the supervision channel and its seven states, pane decoration, tmux argv construction, the bash backstop, the 14 constraints, the handoff protocol); the extension only wires them up. |
| `declare_done` | Completion claim, **re-validated server-side** — rejects with `isError` if any gate is unmet (the reject hint reminds you that late doc/handoff edits invalidate the READY fingerprint, so finish all edits before the final review). "Declaring ≠ executing." It also enforces the two COMPLETION-only requirements the ship gate deliberately does not carry: an open Copilot review cycle (L7) and an unapproved loop goal (L8). On accept it **lands** the work: the gate merges this session's work branch into the base the user confirmed in `setup_workspace`, following the branch log that call wrote — a merge conflict is reported with its files and REFUSES completion (resolve it and call again, or use `waiveMerge` to ask the user to finish with the branch unmerged, which is recorded with its reason). It also clears the per-task round history so a subsequent task in the same session starts its round counter fresh. |
| `propose_loop_goal` | Submit the **negotiated** loop goal for the user's approval (L8). Interview the user first with `ask_user` (ONE question per turn, labeled "N of M", each with your recommended answer — all at once only when the user asks for it), and draft it in Simplified Chinese. **REQUIRED FIRST (L8b):** the draft must pass an audit by the dedicated `goal-auditor` role — and **this one call runs that audit itself**: it builds the auditor's task (carrying the previous verdict, its findings and the computed draft delta when this is a re-audit), dispatches the judge, waits for it, adjudicates the verdict (**only P0/P1 block**, so a READY carrying P2/Nit findings is a PASS and never buys another round) and records the PASS bound to the sha256 of the audited text. A failed audit comes back with the objections and renders **NO dialog at all** — fix them and call this again, which makes this a minutes-long call. Only on a PASS does the **extension** show the text in a confirm dialog (**no `confirmed` parameter**), and only on approval does the extension write `.pi/loop-goal.md` itself and record the sha256 of exactly that text. Approval binds to CONTENT: editing the file afterwards drops it. In loop mode an unapproved goal blocks commit/push/PR at L1 AND blocks edit/write tool calls until approved (each repo checks its own goal; the `repo` parameter binds the goal to a specific repo — required to unlock edit/write in a second repo, `gitRootOfDir(repo)` decides which one); the confirm dialog no longer asks for an optional reason (a rejection still asks for the reason, carried back for renegotiation). An unapproved goal's body is withheld from the prompt. |
| `request_copilot_review` | Ask GitHub Copilot to review the current branch's PR (L7). The extension resolves the PR and requests the review itself (`gh pr edit --add-reviewer @copilot`, with the documented REST review-request endpoint as fallback for older `gh`), stamping the authoritative request time and head SHA. It also decides **availability from evidence** (a Copilot review on this PR or in the repo's last 20 PRs ⇒ CONFIRMED; owner in `copilotReview.owners` ⇒ ASSUMED; neither ⇒ UNKNOWN, and a silent Copilot is then released instead of waited for). The request itself is never vetoed by a read-back — those cannot see a dropped request. No gh / no GitHub remote / no PR / API refusal ⇒ `UNSUPPORTED`, requirement released — it can never strand the task. There is **no round cap**; the only budget is the 20-minute wait for a review that never arrives. |
| `check_copilot_review` | Verify what Copilot's review left open (L7). The extension runs the GraphQL query itself and classifies each thread: resolved ⇒ handled, answered by you ⇒ handled, Copilot spoke last ⇒ still yours (listed with thread IDs and the exact `resolveReviewThread` / reply mutations) — regardless of which commit the review was submitted against, so a push cannot bury a finding. Returns AWAITING / OPEN / SATISFIED — an outcome the agent cannot report for itself. A cycle released with findings still open lists them for you to report to the user. |
| `request_arbitration` | Contest a ship block the agent believes is **circular** (the only remedy is an action the block forbids). Narrow + fail-closed — see [Arbiter](#arbiter-a-narrow-fail-closed-gate-exception). |
| `request_scope_limit` | Agent-requested **gate fence narrowing** for the "pre-existing changes" complaint: the gate arms on dirty files / branch commits that pre-date the session (P0-2), so it can demand review coverage of work the session never did. Instead of silently complying (or bypassing), the agent calls this tool and the **extension renders a user confirm dialog** (fixed consequence copy; the agent's reason labeled untrusted; **no `confirmed` parameter** the model could set). Granted → the non-session changed files are snapshotted as `scopeLimit.preexistingFiles` in the sidecar and stop arming the gate at **every** re-arm site (session_start P0-2, bash stash/checkout re-arm, turn_end reconciliation); a file the session later edits is **reclaimed** out of the snapshot by the edit handler — the grant never covers the session's own work — and branch-commit arming is suspended for as long as the grant stands (a new commit under a standing grant is either the exempted pre-existing work being shipped — exactly what the user consented to — or a user/bypass action; the session's own NEW edits re-arm the gate before any further agent commit). With no session edits the ship gate disarms entirely; with session edits the review scope narrows to `sessionFiles` (the per-turn prompt instructs the reviewer: out-of-scope findings are advisory). Session edit attribution is persisted (`sessionEditedFiles`), so a process restart cannot re-label the session's own edits as pre-existing. A dialog that cannot be shown fails closed WITHOUT counting as a decline. Verdicts/bindings are untouched — narrowing the fence never fabricates a READY/PASS, and the session's OWN edits stay fully gated. Declined → scope requests lock for the session (anti-grinding, mirrors the mode-downgrade lock). Malformed persisted shapes fail closed to ABSENT = full-scope gate (extension loader + git hook both validate). |
| `request_sensitive_edit` | Agent-requested **one-shot authorization** to edit ONE sensitive file (`.env`, private keys, credentials) that the guard blocks by default. Same consent shape as the tools above: the **extension** renders the confirm dialog (fixed consequence copy, agent reason labeled untrusted, **no `confirmed` parameter**). A grant is **path-exact** (normalized absolute path), **single-use** (burned by the first edit that *succeeds* — a failed edit stays retryable), **10-minute TTL**, and **in-memory only** (never written to the sidecar, so a crash/resume/second session starts fail-closed). `.git/` internals are refused **before** any dialog — they are the gate's own L3 enforcement, not the user's secrets. A **declined** path is locked for the session (per-path anti-grinding, unlike the session-wide `request_scope_limit` lock); a dialog that could not be *shown* is not a decline. `/gate-reset` revokes outstanding grants and lifts the decline locks. |

### Internal implementations — not registered

These four are **not tools**: they are registered into the extension's own
`internalHost`, so no model can see or call them. `judge_submit` runs the first
three as steps of its chain and `propose_loop_goal` runs the fourth, which is
how every mechanical check ends up living in exactly one place. Their
descriptions are kept because they are still exactly how the gate behaves — but
read them as the gate's internal steps, not as things to sequence by hand.
(`review_checkpoint`, `prepare_adviser` and `prepare_goal_audit` moved the same
way; `review_spawn`, `review_watch` and `review_send` were deleted outright.)

| Internal step | What it does |
|---------------|--------------|
| `record_review` | Feed the raw reviewer output into the gate. Parses every fence; worst verdict wins; records round history for plateau/oscillation detection. A fence whose JSON is broken by an unescaped quote is salvaged fail-closed (its gate word is recovered, but a salvaged READY is downgraded to BLOCKED). It verifies the COMMIT TARGET mechanically (2026-08-27 model): a READY is withheld when the round was never prepared (no registered `baseline..HEAD` target), downgraded to BLOCKED as STALE when HEAD moved past the reviewed commit (a new checkpoint landed after prepare), and bound to the reviewed commit's TREE (content binding — a later squash of the checkpoint chain preserves it). A READY must also carry the judge's own `pwd` (a required field of the verdict schema), which the gate compares with the repo the round was prepared for — this catches a verdict produced against the wrong repo or carried over from another review; it does not measure the pane, so it is not proof against a fabricated value. Mechanical, so the agent cannot forget it. |
| `prepare_review` | ADVANCED / internal — `judge_submit({role:"reviewer"})` runs this itself as step 3 of the chain. Registers the COMMIT target for the single reviewer of this round: requires the checkpoint from `review_checkpoint` (the only commit allowed before a READY), computes the immutable range `baseline..HEAD`, writes the append-only finding-stream file and returns the ready-made task text. In a copy of its own the reviewer SHOULD verify by doing — mutation analysis included — while the main agent keeps fixing the real worktree and consumes the stream as it lands. A READY recorded after HEAD moved (a new checkpoint during the review) does NOT bind: `record_review` compares HEAD with the registered reviewed commit and downgrades to BLOCKED (STALE), so an approval can never cover commits no reviewer saw. A READY must also carry the judge's own `pwd`, which `record_review` compares with the reviewed repo (see its row above). Round-18 POLISH GATE: when the last two recorded rounds both verdict READY, or the same file has carried P2/Nit findings in three consecutive rounds, the tool REFUSES a `reason`-less call; the supplied reason is persisted (`lastPolishReason`) and injected into the next reviewer's task text, so a "polish" round is visible to the independent judge. |
| `run_precommit` | The ONLY way to record a precommit PASS. The extension spawns the bundled runner with argv (no shell) and trusts only a private, nonce-stamped receipt the runner wrote — bash stdout can never forge a PASS. `mode` picks the lane: `fast` (default — lint + typecheck + build + the tests related to the changed files) clears a `git commit`; `full` is required before `git push` / `gh pr create/edit` / `declare_done`. The receipt's `testScope` (`related`/`full`/`skipped`) is validated like every other field and travels into the sidecar, so a narrowed run can never authorize a publish. The runner's **complete** output is captured to `<repo>/.pi/precommit-last.log` on every run (gate-owned, so writing it never moves the fingerprint); the reply names the lane, the coverage, that path, and the checks that failed. The full output is never inlined into the reply — a failing suite can emit megabytes — but the run is **no longer silent while it happens**: the runner writes a **plan preamble** (every step and the exact command, plus the ones it is skipping and why) BEFORE the first check starts, then streams the running step's stdout/stderr as it arrives, and the extension **tails that log and forwards it through the tool's `onUpdate`**, so a multi-minute precommit shows live progress instead of nothing. Liveness is a *read* of the log, never a second write channel: the runner's stdio stays a file descriptor (a pipe would deadlock the detached runner at its 64KB buffer), and the tail's final flush on stop is what makes an aborted or timed-out run's log complete. The ordered `▶ … ◀` blocks still read in declaration order — only the step the log is currently at streams, so nothing is printed twice. Receipt and cache tails are bounded in BYTES as well as lines (one un-newlined 64 MiB line is still one line, and a receipt over 1 MiB is refused — which would turn a passing run into ERROR). The **test** step additionally gets `<rootDir>/.pi/` excluded so a run never executes the disposable test copies under `.pi/review-snapshots/`. That rewrite is deliberately narrow, because the jest CLI flag OVERRIDES the config value: it happens only for a single simple `jest` command that uses **default config discovery**, and the repo's own `testPathIgnorePatterns` (read from `jest --showConfig`) are merged in rather than replaced. A command that selects its own config (`--config`, `--rootDir`, `--projects`, `--selectProjects`, …), a compound or non-jest script, or a `--showConfig` that cannot be read are all left **verbatim**, with the reason recorded in the log — reproducing jest's own CLI parsing well enough to query the right config is not something the gate should be guessing at, and a wrong guess would silently drop the exclusions the project actually relies on. |
| `record_goal_prereview` | Record the dedicated `goal-auditor` role's audit of a DRAFT goal (L8b). Pass the draft text plus the auditor's FULL raw output: the **extension** parses the JSON fence itself (PASS ⇔ a `READY` verdict — verdict-parse already downgrades a READY carrying unresolved P0/P1, and a salvaged fence is never READY) and computes the text hash itself, so there is no `passed`/`hash` parameter an agent could set. No parseable fence ⇒ `isError` and **nothing** is written (fail-closed). BLOCKED/NEEDS_HUMAN ⇒ a FAIL record. Latest-only by design, and repo-resolved exactly like `propose_loop_goal` (`gitRootOfDir`, never `resolveToolRepo` — a goal is audited before the first edit lands). |

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
- Commit/push whose cwd is inside a review snapshot worktree (an `rg-review-snap-*` path segment) → blocked even with no sidecar (legacy guard for older installs' leftovers: such a worktree carries no `.pi/` but shares the real repo's `.git`; the 2026-08-27 model creates no snapshots)
- Judge roles (`reviewer` / `adviser` / `goal-auditor`) dispatched through `subagent` / `workflowScript` / `workflowScriptPath` → the dispatch is **blocked at `tool_call`** (the workflow sandbox has no per-child isolation, so the judge would land in the live worktree); the agent is steered to `judge_submit`. Management actions and non-judge roles (`recon`) keep running
- Round never prepared (no registered `baseline..HEAD` target when the verdict arrives) → any READY is recorded as **BLOCKED** — a verdict with nothing to bind to cannot ship. HEAD moved past the prepared commit → **BLOCKED** (STALE): the reviewer judged an older commit and the change has since grown
- Loop-mode (or undecided) `edit`/`write` tool call while no USER-approved loop goal exists for the target repo → blocked at tool_call: the negotiation must happen before the work starts, and each repo checks its own goal (see the [Loop goal](#loop-goal--the-exit-contract-negotiated-with-the-user-l8-the-edit-gate-also-covers-undecided-mode) section)
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
- Editing `.pi/precommit-cache.json`. The per-step cache decides which checks
  may be SKIPPED as already-passed, so an entry forged against the current
  tree buys a PASS with **zero checks executed** — the same class of reward as
  a forged sidecar, and excluded for the same reason (a signature would only
  move the problem to the key). Two things narrow it in practice: the file is
  in `SENSITIVE_FILE_PATTERNS` and in `isGateIntegrityPath`, so the AGENT
  cannot reach it through the edit/write tools and **no user dialog can unlock
  it**; and only a PASS is ever reusable, so a forged cache cannot turn a
  failing check into a passing one for a tree that was never checked — it can
  only skip work. A human who really wants to reset it can delete the file.
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
- Fabricating the reviewer output fed to `record_review` — or the
  `auditor_output` fed to `record_goal_prereview` — the reviewer and the
  goal-auditor are judge processes whose output necessarily transits the main
  agent, so both verdicts rest on the cooperative assumption (the main agent
  can equally write the sidecar directly). What the extension DOES guarantee is
  that no agent-attested boolean is accepted: it parses the verdict fence and
  computes the text hash itself, so a forgery has to counterfeit a whole
  reviewer output rather than flip a flag. Making it unforgeable would require
  the extension to spawn the judge itself and verify a receipt, like
  `run_precommit` (future hardening), not a runtime source check.
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
   in normal mode (the step-aside adds no extension text).

### Commit/PR English gate (L5, HARD)

Complementary to L4: while L4 makes user-facing *chat* Simplified Chinese, L5
requires **commit messages and PR title/description in English**, and it is a
**hard block**.

**One rule, one implementation** (`judgeEnglish` in `lib/lang-detect.ts`,
mirrored in the CJS scanner for L6): a text containing **any non-Latin letter**
(CJK, Kana, Hangul, Cyrillic, …) is refused. The four call sites — the
`git commit` tool_call guard, `review_checkpoint`, PR title/body, test labels —
differ only in the `kind` they pass, which decides the wording of the block.
The whole text is scanned, markup included, so wrapping a body in a code fence
is not a bypass. ASCII, identifiers, digits, punctuation, URLs, emoji and
Latin-with-diacritics (café, naïve) all pass. Each text (a PR title, a PR body,
one whole commit message) is judged **separately**, never concatenated, so a
long English text cannot mask a short non-English one; within one commit
message the **subject** is reported separately from the body, because that is
the line every `git log`, blame and changelog shows. The subject is taken the
way `git stripspace` takes it (leading blank lines skipped), and repeated `-m`
paragraphs are **joined** first — only the first paragraph's first line is a
subject.

The **ratio policy is retired** (2026-08-29). It failed a text only when a
non-Latin script was the majority of its letters, which let a long English body
dilute a fully Chinese subject below the threshold and ship (observed), and it
forced every reader to know which of two policies applied where.

A hard rule is only humane when a wrong one can be contested, so **every L5/L6
refusal is appealable**: `request_arbitration` puts the refused text to an
independent arbiter, and a granted appeal issues a **content-bound, single-use
pass** for exactly that text (`lib/text-appeal.ts`). Four brakes keep it from
becoming the cheap path: only a block that actually happened can be contested;
the appeal binds to the sha256 of the content and a refused content is locked;
a per-session quota of 3, **shared** with `gh pr edit` arbitration and persisted
in the sidecar; and each appeal costs a real arbiter call. The same line divides
the rest of the gate: a **fact** it observed (no workspace, no approved goal,
unmet review gate, sensitive file) is never appealable — those have a correct
next step.

The pure-Latin **romanized** semantic layer (pinyin/romaji written in Latin
letters) runs only when the text has **zero** non-Latin letters, and its
refusals are appealable too. Enforcement stays layered: the L4 directive
instructs the agent to write ship text in English every turn, the tool layer
blocks, and the reviewer treats a non-English commit message or PR title/body as
a **P1 finding**. If a non-English PR body can only be fixed by an action the
gate itself blocks (the circular deadlock), the agent can also escalate via the
[arbiter](#arbiter-a-narrow-fail-closed-gate-exception).

### Test-label English gate (L6)

Test descriptions must be **English** too. Enforced at the `pre-commit` hook
(L3) layer by `scripts/scan-test-labels.cjs`, which scans the **staged** content
of test files (`*.test.*`, `*.spec.*`, or under `__tests__/`, JS/TS only) for
`it(…)` / `test(…)` / `describe(…)` (incl. `.only`/`.skip` chains) whose
string-literal description contains **any non-Latin letter**. Same hard rule as
L5 (`lib/lang-detect.ts`, mirrored in the CJS scanner because a git hook runs
that file with plain node), so diacritics, emoji and digits pass while any
CJK/Kana/Hangul/Cyrillic letter is blocked.

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
npm install     # devDependencies: typescript + the Pi extension API types
npm test        # 990+ tests, node:test native TS (no build step)
npm run typecheck  # tsc --noEmit
```

`typecheck` is not optional politeness. Pi loads these `.ts` sources with
node's type stripping, so a bare identifier that is never imported or declared
is **not** an error at load time — it throws `X is not defined` the first time
that line runs, in front of the user. That shipped twice (`propose_loop_goal`
crashed on `LOOP_GOAL_MAX_WRITE_CHARS`, then on `log`), and no test caught it
because every tool body is reachable only at runtime. `tsc --noEmit` reports
both as TS2304, and the precommit runner picks the script up automatically in
`full` mode.

`tsconfig.json` sets `rootDirs: [".", "./extensions"]` because the extension
imports `./lib/*.ts` — a path that only exists in the INSTALLED layout, where
the pi package keeps `lib/` at the package root next to `extensions/`. rootDirs
makes tsc resolve the same specifiers the runtime does, with no build step or
symlink.

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
| `run_precommit --mode fast` (this repo) | ~2 s cold, ~0.1 s fully cached | lint + typecheck + build + related tests only |
| `run_precommit --mode full` (this repo) | ~100 s | Dominated by the two timing loops in the suite; typecheck runs CONCURRENTLY with `npm test` — the timing loops themselves are not reducible |
| **A review round (any diff size)** | **~3 min reviewer, precommit first** | ONE reviewer, one commit range, no engine — precommit runs BEFORE the review (see the loop protocol); see `docs/execution-model.md` |

**Parallel-stability verification (2026-08-10)**: `run_precommit --mode full`
ran six consecutive times on this repo (typecheck concurrent with `npm test`,
which contains the two timing regressions) — all six PASS; wall clock
138–157 s, on par with the serial baseline (`npm test` ~137 s + typecheck
~2 s). The parallel win lands on multi-step repos; see
`docs/parallel-execution-plan.md` §7 (historical).

The practical consequence: batching edits into fewer, larger review rounds
saves far more wall time than any micro-optimization here, because the loop is
billed per round.

**Where the time actually went, per run**: `.pi/gate-timings.jsonl` records one
line per precommit and per review round — lane, `testScope`, total wall clock,
every step's duration and whether it was a cache hit, and (for reviews) the
scope and increment size. `/gate-status` prints the last run's slowest steps.
It is diagnostics only: nothing reads it back into a decision, it is capped at
500 records, and it lives under `.pi/` so writing it cannot invalidate the run
it describes. Review durations are recorded as **upper bounds** (`approximate:
true`) — the reviewer runs as its own non-interactive pi process, which the
extension does not watch turn by turn, so all it can measure is the wall clock
since the previous gate event.

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
agents/adviser.md             consulting judge child, pinned model @ max (proactively consulted)
agents/reviewer.md            gatekeeper reviewer override, pinned model @ max
agents/goal-auditor.md        dedicated loop-GOAL pre-reviewer (read-only tools), pinned model @ max
lib/shell-lex.ts              quote-aware shell lexer (segments + dequoted tokens)
lib/lang-detect.ts            L5: non-Latin-script detection for the commit/PR English hard gate
scripts/scan-test-labels.cjs  L6: non-English test-label scanner (pre-commit, staged content)
lib/precommit-receipt.ts      pure receipt validator (exit/verdict/count/testScope table → PASS/FAIL/ERROR) + failedStepNames / stepTimings (diagnostics only)
lib/ship-detect.ts            bash → ship-command detection (+evasion & de-obfuscation)
lib/fingerprint.ts            worktree fingerprint (content-addressed git tree hash; staging-invariant) + tree increments for incremental review
lib/gate-state.ts             state machine, sidecar, unmetRequirements, plateau
lib/review-scope.ts           incremental-review scoping + escalation thresholds + the previous round's settled conclusion (pure)
lib/loop-stall.ts             L2 stall breaker: no-progress signature, motion credit for a running subagent, notice text (pure)
lib/review-stream.ts          streamed findings: append-only jsonl protocol, verdict-key refusal, actionable filter (pure)
lib/judge-process.ts          judge-child lifecycle: `pi -p --session-id` spawn (argv, no shell), stdout/stderr tee, liveness from the child's own exitCode
lib/judge-lifecycle.ts        judge round decisions (pure): work dir per role+repo, dispatch vs. refuse-busy, the three end-of-round criteria, judge_wait's reply, goal-audit adjudication
lib/poll-wait.ts              the wait skeleton with its criteria injected (pure loop: probe → publish → stop on a criterion, the budget or an abort)
lib/progress-stream.ts        live tool progress: pure frame rendering + a throttled reporter over `onUpdate`, and the slow-call notice for the LLM guards
lib/text-appeal.ts            A-class text appeals (pure): content digest, quota + re-roll brakes, the single-use pass, the arbiter brief
lib/git-rewrite.ts            message-only rewrites (pure): tree-equality test, `--amend` recognition, the branch a rebase will land on
lib/judge-prompt.ts            judge role resolution (repo → package → ~/.pi/agent/agents), model spec, launcher files, judge-role dispatch detection for the subagent block
lib/parallel-review.ts        single-review contract: reviewer prompt + verdict schema (pure, no engine)
docs/subagents-collaboration.md how the gate and pi-subagents cooperate: what is established, what is deliberately NOT used (gate param / worktree isolation), what was added (the single-review spawn shape, the L8b goal pre-review collaboration)
lib/model-diagnose.ts         agent model-chain diagnosis against the registry (advisory)
lib/gate-doctor.ts            /gate-doctor read-only health checks (advisory)
lib/gate-timings.ts           .pi/gate-timings.jsonl observability log (diagnostics only)
lib/blocked-marker.ts         .blocked marker ownership (record failure, reclaim only our own/orphans)
lib/verdict-parse.ts          all-fence worst-wins verdict parser
scripts/precommit-runner.mjs  PASS/FAIL/NO_CHECKS_RUN runner; fast/full lanes, per-step cache, nonce receipt, streamed step output
scripts/precommit-plan.mjs    pure lane planning: related-test derivation + per-step cache scope
scripts/precommit-cache.mjs   per-step result cache keyed on git trees
scripts/install-git-hooks.sh  chained installer for L3
hooks/pre-commit|pre-push|commit-msg
skills/review-loop/SKILL.md   the loop protocol as a Pi skill
test/                         990+ tests incl. PR #7 regression suite
```

## License

MIT
