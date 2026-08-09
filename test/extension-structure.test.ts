import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "extensions", "review-gate.ts"), "utf8");

test("loop goal: injected ONLY in loop mode, before the unarmed early-return", () => {
  // The Step 0 directive has to reach the agent while the worktree is still
  // clean (that is the whole point — set the exit contract BEFORE editing), so
  // it must sit after the explore early-return and before the
  // `!gateArmed && problems.length === 0` early-return.
  assert.match(SRC, /from "\.\/lib\/loop-goal\.ts"/);
  // Anchor on the REGISTRATION, not the bare word: "before_agent_start" also
  // appears in the file header comment, which would put the explore anchor
  // above the whole handler and make the ordering assertion vacuous.
  const handlerAt = SRC.indexOf('pi.on("before_agent_start"');
  assert.ok(handlerAt > 0, "handler registration must exist");
  const injectAt = SRC.indexOf("buildLoopGoalDirective(readLoopGoal(", handlerAt);
  assert.ok(injectAt > 0, "loop-goal directive must be injected in before_agent_start");
  const exploreReturnAt = SRC.indexOf('state.taskMode === "explore"', handlerAt);
  const unarmedReturnAt = SRC.indexOf("if (!gateArmed && problems.length === 0)", handlerAt);
  assert.ok(exploreReturnAt > 0 && unarmedReturnAt > 0, "both early-returns must exist");
  assert.ok(exploreReturnAt < injectAt, "explore must return before the loop-goal injection");
  assert.ok(injectAt < unarmedReturnAt, "loop goal must be injected before the unarmed early-return");
  // Guarded on loop mode only (explore/normal never see it).
  const guard = SRC.slice(injectAt - 200, injectAt);
  assert.match(guard, /state\.taskMode === "loop"/);
});

test("loop goal: set_gate_mode(loop) delivers Step 0 in the same turn it decides", () => {
  // before_agent_start only injects on the NEXT turn, and the mode is decided
  // as the session's first action — without this the agent could edit for a
  // whole turn before ever seeing the exit contract.
  const handlerAt = SRC.indexOf('pi.on("before_agent_start"');
  const toolInjectAt = SRC.indexOf("buildLoopGoalDirective(readLoopGoal(");
  assert.ok(toolInjectAt > 0 && toolInjectAt < handlerAt, "set_gate_mode must inject the goal too");
  assert.match(SRC.slice(toolInjectAt - 200, toolInjectAt), /effective === "loop"/);
});

test("the loop goal gates SHIP at L1 only — hooks and verdict logic stay blind to it", () => {
  // USER REQUIREMENT (L8): an unapproved goal blocks commit/push/PR, because
  // negotiating the contract after the code is pushed is theatre. What did NOT
  // change: the gate's other layers still rest on objective facts they can
  // verify themselves. The approval is a DIALOG fact, and a git hook cannot
  // show a dialog — so the hook, the verdict parser and the fingerprint must
  // remain unaware of the goal entirely.
  const blindSources = [
    join(ROOT, "lib", "verdict-parse.ts"),
    join(ROOT, "lib", "fingerprint.ts"),
    join(ROOT, "hooks", "pre-commit"),
  ];
  for (const file of blindSources) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /loop-goal|loopGoal/, file + " must not depend on the loop goal");
  }
  // gate-state may STORE the approval, but unmetRequirements() — the single
  // ship authority the hooks share — must never read it: a hook that failed on
  // an unapproved goal would block commits it can never unblock.
  const gateState = readFileSync(join(ROOT, "lib", "gate-state.ts"), "utf8");
  const reqAt = gateState.indexOf("export function unmetRequirements");
  assert.ok(reqAt > 0, "unmetRequirements must exist");
  const reqBody = gateState.slice(reqAt, gateState.indexOf("\nexport ", reqAt + 10));
  assert.doesNotMatch(reqBody, /loopGoal|copilot/i,
    "the ship authority must not read the goal approval or the Copilot cycle");
  // The ship block itself lives in the extension's L1 tool_call path.
  assert.match(SRC, /LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK/);
  // …and the goal file must remain inside the fingerprint-excluded .pi/ scope,
  // otherwise writing a goal would invalidate the session's own review.
  const fp = readFileSync(join(ROOT, "lib", "fingerprint.ts"), "utf8");
  assert.match(fp, /GATE_EXCLUDE_PATHSPECS[\s\S]{0,200}":\/\.pi"/);
});
test("blocked marker: every call site reclaims by ownership, none unlinks unconditionally", () => {
  // The old code deleted `.blocked` outright on session start and after every
  // successful write, which erased a CONCURRENT session's fail-closed signal
  // (its state never reached disk) and left the hooks verifying a stale but
  // well-formed sidecar — fail-closed degraded to fail-open.
  assert.doesNotMatch(SRC, /unlinkSync/, "the extension must not delete the marker directly");
  assert.doesNotMatch(SRC, /FAILED_WRITE/, "the legacy content-free marker must be gone");
  assert.match(SRC, /from "\.\/lib\/blocked-marker\.ts"/);

  const reclaims = SRC.match(/reconcileBlockedMarker\(/g) ?? [];
  assert.equal(reclaims.length, 3,
    "session start, persist() and persistRepo() must all reclaim through the shared logic");
  const records = SRC.match(/recordBlockedMarker\(/g) ?? [];
  assert.equal(records.length, 2, "both write-failure paths must record an owner");

  // Session start must reclaim on its own: an early return (explore/normal) or
  // a throw can mean persist() never runs that turn.
  const sessionStartAt = SRC.indexOf('pi.on("session_start"');
  assert.ok(sessionStartAt > 0, "session_start handler must exist");
  assert.ok(SRC.indexOf("reconcileBlockedMarker(", sessionStartAt) > 0,
    "session_start must reclaim orphan owners");
});

test("edits under gate-owned dirs do NOT arm the gate (writing a loop goal must not demote READY)", () => {
  // The fingerprint already excludes .pi/; edit tracking must skip the same
  // scope, or writing .pi/loop-goal.md sets hasDocChange and demotes
  // READY→PENDING over a file no reviewer can even see.
  const toolResultAt = SRC.indexOf('pi.on("tool_result"');
  assert.ok(toolResultAt > 0, "tool_result handler must exist");
  const skipAt = SRC.indexOf("isGateOwnedPath(absEditPath", toolResultAt);
  assert.ok(skipAt > 0, "edit tracking must skip gate-owned paths");
  const armAt = SRC.indexOf("hasDocChange = true", toolResultAt);
  assert.ok(armAt > 0 && skipAt < armAt, "the skip must precede every arming write in the edit path");
  assert.match(SRC.slice(skipAt, skipAt + 120), /\breturn\b/, "the skip must return, not fall through");

  // Same scope on the tool_call side: a gate-owned write must not count as
  // this session's edit either, or it would suppress the "changes pre-date
  // this session" hint and force consent for a later mode change.
  const toolCallAt = SRC.indexOf('pi.on("tool_call"');
  const callSkipAt = SRC.indexOf("isGateOwnedPath(abs", toolCallAt);
  const sessionEditAt = SRC.indexOf("sessionEdited = true", toolCallAt);
  assert.ok(toolCallAt > 0 && callSkipAt > 0 && sessionEditAt > 0, "tool_call must apply the same skip");
  assert.ok(callSkipAt < sessionEditAt, "the skip must precede the session-edit attribution");
});

test("extension imports from local lib/ (single source of truth)", () => {
  assert.ok(SRC.includes('./lib/constants.ts'), "should import from ./lib/constants.ts");
  assert.match(SRC, /\bisCodeFile\b/);
  assert.match(SRC, /\bisDocFile\b/);
  assert.match(SRC, /\bcoalesceToolPath\b/);
});

test("extension declares no inline extension alternation", () => {
  for (const line of SRC.split("\n")) {
    const hits = ["tsx", "ipynb", "pyw", "kts", "hpp"].filter((t) => line.includes('"' + t + '"') || line.includes("|" + t + "|")).length;
    assert.ok(hits < 3, `inline extension list suspected:\n${line.trim()}`);
  }
});

test("NotebookEdit is in the edit-tool set", () => {
  assert.match(SRC, /EDIT_TOOL_NAMES.*NotebookEdit/);
});

test("L1: tool_call handler exists and can block", () => {
  assert.match(SRC, /pi\.on\(["']tool_call["']/);
  assert.match(SRC, /block:\s*true/);
  assert.match(SRC, /detectShipCommands/);
});

test("L2: agent_settled auto-continuation with recursion guard", () => {
  assert.match(SRC, /pi\.on\(["']agent_settled["']/);
  assert.match(SRC, /state\.taskMode === "explore"/);
  assert.match(SRC, /continuationsInjected/);
  assert.match(SRC, /REVIEW_GATE_RESUME/);
});

test("L2 ORDER: explore check precedes loopArmed in agent_settled (explore edits arm the loop flag)", () => {
  // Explore-mode edits set loopArmed = true in tool_result; only the explore
  // early-return keeps auto-continuation off. If someone reorders the checks,
  // explore would silently regain forced continuation.
  const start = SRC.indexOf('pi.on("agent_settled"');
  assert.ok(start >= 0, "agent_settled handler must exist");
  const body = SRC.slice(start, start + 900);
  const exploreAt = body.indexOf('state.taskMode === "explore"');
  const loopArmedAt = body.indexOf("!loopArmed");
  assert.ok(exploreAt >= 0 && loopArmedAt >= 0, "both checks must exist");
  assert.ok(exploreAt < loopArmedAt, "explore early-return must precede the loopArmed check");
});

test("pause_for_question: agent-requested loop pause is registered and tighten-only", () => {
  assert.match(SRC, /name: "pause_for_question"/);
  // The pause persists (survives a restart while waiting for the user)…
  const toolStart = SRC.indexOf('name: "pause_for_question"');
  const toolBody = SRC.slice(toolStart, toolStart + 3500);
  assert.match(toolBody, /state\.pausedQuestion = \{/);
  assert.match(toolBody, /loopArmed = false/);
  assert.match(toolBody, /persist\(/);
  // …but it must NEVER touch the ship authority: unmetRequirements takes no
  // pause input, and no call site filters its problems on pausedQuestion.
  assert.doesNotMatch(SRC, /unmetRequirements\([^)]*pausedQuestion/);
});

test("PAUSE ORDER: pausedQuestion early-return precedes the RESUME injection in agent_settled", () => {
  // A stale ordering would let the auto-continuation steamroll the agent's
  // question with a [REVIEW_GATE_RESUME] follow-up instead of waiting.
  const start = SRC.indexOf('pi.on("agent_settled"');
  assert.ok(start >= 0, "agent_settled handler must exist");
  const injectAt = SRC.indexOf("REVIEW_GATE_RESUME", start);
  assert.ok(injectAt > start, "agent_settled must contain the RESUME injection");
  const beforeInject = SRC.slice(start, injectAt);
  assert.match(beforeInject, /if \(state\.pausedQuestion\) return;/);
});

test("pause resume: any non-extension input clears the pause (interactive AND rpc users)", () => {
  // source === "extension" is how the gate injects its own follow-ups; a
  // narrower filter (interactive-only) would deadlock RPC-driven sessions.
  const start = SRC.indexOf('pi.on("input"');
  assert.ok(start >= 0, "input handler must exist");
  const body = SRC.slice(start, start + 1400);
  assert.match(body, /event\.source !== "extension"/);
  assert.match(body, /delete state\.pausedQuestion/);
});

test("stale pause liveness: cleared when the agent proves it is not waiting", () => {
  // A pause left behind while the agent keeps looping must not silently
  // swallow auto-continuation: edits, record_review and run_precommit all
  // clear it (plus setTaskMode — a fresh mode decision supersedes it).
  // P-multi: record_review/run_precommit clear the ACTIVE repo's state via a
  // local `st` (no global swap), so both spellings count.
  const clears = SRC.match(/delete (?:state|st)\.pausedQuestion/g) ?? [];
  assert.ok(clears.length >= 5, `expected >=5 clear sites, found ${clears.length}`);
  const recordStart = SRC.indexOf('name: "record_review"');
  const recordEnd = SRC.indexOf('name: "run_precommit"');
  assert.ok(SRC.slice(recordStart, recordEnd).includes(".pausedQuestion"), "record_review must clear the pause");
  const precommitEnd = SRC.indexOf('name: "declare_done"');
  assert.ok(SRC.slice(recordEnd, precommitEnd).includes(".pausedQuestion"), "run_precommit must clear the pause");
});

test("session_compact while paused re-injects the WAITING state, never a resume nudge", () => {
  const start = SRC.indexOf('pi.on("session_compact"');
  assert.ok(start >= 0);
  const body = SRC.slice(start, SRC.indexOf("pi.on", start + 10));
  assert.match(body, /REVIEW_GATE_PAUSED/);
});

test("ESC abort (Operation aborted) pauses auto-continuation until the next real user input", () => {
  // USER REQUIREMENT: a double-ESC abort is an explicit human stop — the L2
  // loop must NOT steamroll it with a [REVIEW_GATE_RESUME] follow-up.
  assert.match(SRC, /pi\.on\(["']agent_end["']/);
  assert.match(SRC, /stopReason === "aborted"/);
  // agent_settled checks the abort flag BEFORE injecting the continuation…
  const start = SRC.indexOf('pi.on("agent_settled"');
  assert.ok(start >= 0, "agent_settled handler must exist");
  const injectAt = SRC.indexOf("REVIEW_GATE_RESUME", start);
  assert.ok(injectAt > start, "agent_settled must contain the RESUME injection");
  assert.ok(SRC.slice(start, injectAt).includes("lastRunAborted"), "abort check must precede the RESUME injection");
  // …and any non-extension user input clears the pause again.
  const inputStart = SRC.indexOf('pi.on("input"');
  assert.ok(inputStart >= 0, "input handler must exist");
  const inputBody = SRC.slice(inputStart, inputStart + 1800);
  assert.match(inputBody, /lastRunAborted = false/);
});

test("request_scope_limit: extension-driven user consent, no 'confirmed' parameter, declined locks", () => {
  const toolStart = SRC.indexOf('name: "request_scope_limit"');
  assert.ok(toolStart >= 0, "request_scope_limit tool must be registered");
  const toolEnd = SRC.indexOf("pi.registerTool", toolStart);
  const body = SRC.slice(toolStart, toolEnd > toolStart ? toolEnd : toolStart + 7000);
  // Consent is obtained by the EXTENSION (dialog) — the tool schema exposes
  // only a reason; there is no parameter the model could set to claim consent.
  assert.match(body, /ctx\.ui\.confirm/);
  assert.match(body, /parameters: Type\.Object\(\{\s*reason: Type\.String/);
  assert.doesNotMatch(body, /confirmed/);
  // No UI ⇒ fail-closed deny; a declined dialog locks further requests — but
  // a dialog that could not be SHOWN fails closed without burning the lock.
  assert.match(body, /hasUI/);
  assert.match(body, /scopeLimitDeclined = true/);
  assert.match(body, /dialogFailed/);
  assert.match(body, /state\.scopeLimit = \{/);
});

test("a session edit RECLAIMS an exempt file — the grant never covers the session's own work", () => {
  // P1 regression guard: without the reclaim, a session that edits ONLY
  // pre-existing dirty files would see turn_end filter them all out, disarm
  // the gate, and ship its own edits unreviewed.
  const start = SRC.indexOf('pi.on("tool_result"');
  assert.ok(start >= 0, "tool_result handler must exist");
  const body = SRC.slice(start, SRC.indexOf("pi.registerTool", start));
  assert.match(body, /preexistingFiles\.indexOf/);
  assert.match(body, /preexistingFiles\.splice/);
  // Session edit attribution is persisted (restart cannot re-label the
  // session's own edits as pre-existing) and re-seeded at session_start.
  assert.match(body, /state\.sessionEditedFiles/);
  const sessionStart = SRC.indexOf('pi.on("session_start"');
  const startBody = SRC.slice(sessionStart, SRC.indexOf('pi.on("session_compact"', sessionStart));
  assert.match(startBody, /state\.sessionEditedFiles/);
});

test("scope limit exempts pre-existing files at EVERY re-arm site (session_start + bash re-arm + turn_end)", () => {
  // A grant that only disarmed once would silently re-arm at the next
  // stash/checkout or restart; every arming path must apply the exempt filter.
  const hits = SRC.match(/scopeLimit\?\.preexistingFiles/g) ?? [];
  assert.ok(hits.length >= 3, `expected >=3 exempt-filter sites, found ${hits.length}`);
  // The grant never touches verdicts/bindings — only the arming flags.
  const toolStart = SRC.indexOf('name: "request_scope_limit"');
  const toolEnd = SRC.indexOf("pi.registerTool", toolStart);
  const body = SRC.slice(toolStart, toolEnd > toolStart ? toolEnd : toolStart + 7000);
  assert.doesNotMatch(body, /state\.review\.verdict\s*=/);
  assert.doesNotMatch(body, /state\.precommit\.verdict\s*=/);
});

test("gate mode is decided via set_gate_mode with a DeepSeek V4 first classification", () => {
  // USER REQUIREMENT: the first classification is automated — the tool asks
  // the DeepSeek V4 classifier (lib/llm-classify.ts) while undecided and
  // applies the verdict without a confirmation dialog. The input handler is
  // CACHE-ONLY (feeds the classifier the user's real first message) — the
  // old input-handler decision flow stays gone.
  assert.doesNotMatch(SRC, /decideTaskMode/);
  assert.match(SRC, /classifyTaskMode\(/);
  assert.match(SRC, /firstDecideAuto:/);
  // The cache-only input capture must never decide anything itself.
  const inputAt = SRC.indexOf('pi.on("input"');
  assert.ok(inputAt >= 0, "first-input capture handler must exist");
  const inputBody = SRC.slice(inputAt, inputAt + 600);
  assert.doesNotMatch(inputBody, /classifyTaskMode|evaluateModeChange|setTaskMode/,
    "the input handler must cache only — decisions stay in set_gate_mode");
  assert.match(inputBody, /editFailurePending = false/,
    "new user input must close the edit-failure nudge window");
  assert.match(SRC, /name:\s*["']set_gate_mode["']/);
  // USER REQUIREMENT: "no changes" means THIS session's own edits
  // (sessionEdited), NOT pre-existing worktree/branch changes — a new session
  // on a dirty worktree still gets the consent-free first classification.
  assert.match(SRC, /!sessionEdited/);
  assert.match(SRC, /sessionEdited = false/); // session_start reset
  assert.match(SRC, /sessionEdited = true/);  // tool_call passed-edit arm
  // The tool must delegate to the pure, unit-tested rule engine and inject
  // the undecided directive from the same module.
  assert.match(SRC, /evaluateModeChange\(\{/);
  assert.match(SRC, /GATE_MODE_DECISION_DIRECTIVE/);
  assert.match(SRC, /registerCommand\(["']gate-mode["']/);
});

test("SECURITY: set_gate_mode consent is extension-driven — no 'confirmed' parameter, decline locks downgrades", () => {
  const at = SRC.indexOf('name: "set_gate_mode"');
  assert.ok(at >= 0, "set_gate_mode tool must exist");
  const region = SRC.slice(at, SRC.indexOf("registerTool", at + 10));
  // The tool's parameters must be exactly mode + reason — a caller-supplied
  // consent flag would let the model approve its own downgrade.
  const paramsAt = region.indexOf("parameters: Type.Object(");
  const paramsRegion = region.slice(paramsAt, region.indexOf("async execute", paramsAt));
  const paramKeys = [...paramsRegion.matchAll(/^\s*(\w+):\s*Type\./gm)]
    .map((m) => m[1])
    .filter((k) => k !== "parameters"); // the `parameters: Type.Object(` wrapper itself
  assert.deepEqual(paramKeys.sort(), ["mode", "reason"],
    "set_gate_mode parameters must be exactly {mode, reason}");
  // Consent comes from ctx.ui.confirm rendered by the EXTENSION, with the
  // fixed-copy dialog builder; only that branch may mint source "user".
  assert.match(region, /ctx\.ui\.confirm\(MODE_CONFIRM_TITLE, buildModeConfirmMessage\(/);
  const confirmAt = region.indexOf("ctx.ui.confirm");
  const userMint = region.indexOf('setTaskMode(effective, "user"');
  assert.ok(userMint > confirmAt, 'source "user" may only be set after the confirm dialog');
  // A declined dialog locks agent-initiated downgrades (anti-grinding).
  assert.match(region, /agentDowngradesLocked = true/);
  // Apply-path modes carry the rule engine's source (always "auto").
  assert.match(region, /setTaskMode\(\w+, decision\.source/);
});

test("the downgrade lock is cleared ONLY by user actions (/gate-mode, gate-reset)", () => {
  // (the `let … = false` declaration is excluded — only assignment sites count)
  const clears = [...SRC.matchAll(/(?<!let )agentDowngradesLocked = false/g)].map((m) => m.index!);
  assert.equal(clears.length, 2, "exactly two clear sites: /gate-mode and /gate-reset");
  const gateModeAt = SRC.indexOf('registerCommand("gate-mode"');
  const gateResetAt = SRC.indexOf('registerCommand("gate-reset"');
  assert.ok(clears.some((i) => i > gateModeAt && i < gateModeAt + 1200), "/gate-mode must clear the lock");
  assert.ok(clears.some((i) => i > gateResetAt && i < gateResetAt + 800), "/gate-reset must clear the lock");
});

test("explore workflow: advisory completion, no edit/bash blocking, ship gate intact", () => {
  // declare_done is self-accepted in explore.
  assert.match(SRC, /explore task completed by AI judgment/);
  // The system prompt guides toward read-only work instead of hard-blocking.
  assert.match(SRC, /## Explore workflow/);
  assert.match(SRC, /PREFER read-only work/);
  // The old hard blocks must be gone: no mode-based edit/bash/run_precommit
  // refusal may remain anywhere in the extension.
  assert.doesNotMatch(SRC, /current task is in read-only workflow/);
  assert.doesNotMatch(SRC, /bash is disabled/);
  assert.doesNotMatch(SRC, /run_precommit is unavailable/);
});

test("SECURITY: explore never weakens the L1 ship gate; only user-confirmed normal may", () => {
  // Ship commands (git commit/push, gh pr) must stay fully gated in explore:
  // it only relaxes declare_done and auto-continuation. Two mode branches are
  // permitted in tool_call, and neither loosens anything for explore:
  //   normal — the early return (every path into normal is user-confirmed, or
  //            a no-UI session where the gate steps aside entirely);
  //   loop   — the L8 loop-goal ship block, which only ADDS a requirement.
  const start = SRC.indexOf('pi.on("tool_call"');
  assert.ok(start >= 0, "tool_call handler must exist");
  // Slice the HANDLER only (it closes with `\n  });` at handler indentation),
  // not everything up to the next handler — helper functions live in between.
  const end = SRC.indexOf("\n  });", start);
  assert.ok(end > start, "tool_call handler must be closed");
  const body = SRC.slice(start, end);
  assert.doesNotMatch(body, /taskMode\s*===\s*"explore"/,
    "tool_call must never branch on explore");
  assert.doesNotMatch(body, /taskMode\s*!==/,
    "tool_call must not use negated mode branches");
  const modeBranches = [...body.matchAll(/taskMode\s*===\s*"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(modeBranches)].sort(), ["loop", "normal"],
    "the only tool_call mode branches are normal (step aside) and loop (goal block)");
  // The loop branch must only PUSH a requirement — its own block body must not
  // return (i.e. it can never wave a ship through, only add to `problems`).
  const loopAt = body.indexOf('taskMode === "loop"');
  const loopBlock = body.slice(loopAt, body.indexOf("\n    }", loopAt));
  assert.match(loopBlock, /problems\.push\(/);
  assert.doesNotMatch(loopBlock, /return|block:\s*false/);
});

test("SECURITY: the sensitive-file guard runs BEFORE the normal-mode edit return (security floor)", () => {
  // Normal mode skips workflow checks but must never skip the .env/keys
  // guard — the early return has to come after isSensitiveFile.
  const start = SRC.indexOf('pi.on("tool_call"');
  const body = SRC.slice(start, SRC.indexOf('pi.on("tool_result"', start));
  const sensitiveAt = body.indexOf("isSensitiveFile");
  const normalEditReturn = body.indexOf('state.taskMode === "normal"');
  assert.ok(sensitiveAt >= 0 && normalEditReturn >= 0, "both checks must exist");
  assert.ok(sensitiveAt < normalEditReturn,
    "sensitive-file guard must precede the normal-mode early return");
});

test("normal mode: prompt-transparent except the language directive; loop resume paths skip it", () => {
  // before_agent_start returns the language-directive-only prompt for normal
  // BEFORE any gate text is appended.
  const promptAt = SRC.indexOf('pi.on("before_agent_start"');
  assert.ok(promptAt >= 0);
  const promptBody = SRC.slice(promptAt, promptAt + 2500);
  const langAt = promptBody.indexOf("LANGUAGE_DIRECTIVE");
  const normalAt = promptBody.indexOf('state.taskMode === "normal"');
  const directiveAt = promptBody.indexOf("GATE_MODE_DECISION_DIRECTIVE");
  assert.ok(langAt >= 0 && normalAt > langAt, "normal early-return must come after the language directive");
  assert.ok(directiveAt > normalAt, "the undecided directive must not be injected in normal mode");
  // agent_settled and session_compact both skip normal (no auto-continuation,
  // no loop-resume nudge).
  for (const anchor of ['pi.on("agent_settled"', 'pi.on("session_compact"']) {
    const at = SRC.indexOf(anchor);
    assert.ok(at >= 0, anchor);
    assert.match(SRC.slice(at, at + 700), /taskMode === "explore" \|\| state\.taskMode === "normal"/, anchor);
  }
});

test("restore validates persisted taskMode through normalizeTaskMode", () => {
  assert.match(SRC, /normalizeTaskMode/);
});

test("edit-discipline nudges: prompt-only guidance, wired at the three sites", () => {
  // USER REQUIREMENT: prompt-level correction (no enforcement) for the
  // recurring "edit failed → bash edits the file" workaround. Three sites:
  // 1. before_agent_start injects the discipline paragraph in every
  //    non-normal mode (after the normal early return).
  const promptAt = SRC.indexOf('pi.on("before_agent_start"');
  const promptBody = SRC.slice(promptAt, promptAt + 2500);
  const normalAt = promptBody.indexOf('state.taskMode === "normal"');
  const disciplineAt = promptBody.indexOf("EDIT_DISCIPLINE_DIRECTIVE");
  assert.ok(disciplineAt > normalAt, "discipline directive must be injected after the normal-mode return");
  assert.ok(normalAt > promptBody.indexOf("editFailurePending = false"),
    "the nudge window must reset BEFORE the normal-mode early return (no cross-turn leak)");
  // 2. tool_result: a FAILED edit arms the window and appends the nudge.
  const resultAt = SRC.indexOf('pi.on("tool_result"');
  const resultEnd = SRC.indexOf('pi.on("session_start"', resultAt);
  const resultBody = SRC.slice(resultAt, resultEnd);
  assert.match(resultBody, /EDIT_FAILURE_NUDGE/);
  assert.match(resultBody, /editFailurePending = true/);
  // 3. tool_result bash: same-turn write-looking command gets the nudge once.
  assert.match(resultBody, /BASH_WRITE_NUDGE/);
  assert.match(resultBody, /editFailurePending = false/);
  // Both nudge sites are skipped in normal mode (user-consented step-aside
  // must not add extension text to tool results).
  const normalGuards = (resultBody.match(/state\.taskMode === "normal"/g) ?? []).length;
  assert.ok(normalGuards >= 2, "both nudge sites must carry a normal-mode guard");
});

test("compaction recovery: session_compact re-injects state", () => {
  assert.match(SRC, /pi\.on\(["']session_compact["']/);
  assert.match(SRC, /survived/i);
});

test("state persisted via appendEntry AND sidecar", () => {
  assert.match(SRC, /pi\.appendEntry\(ENTRY_TYPE/);
  assert.match(SRC, /saveSidecar/);
});

test("declare_done validates server-side and rejects on unmet gates", () => {
  assert.match(SRC, /name:\s*["']declare_done["']/);
  assert.match(SRC, /REJECTED/);
  assert.match(SRC, /isError:\s*true/);
});

test("declare_done resets BOTH per-task loop budgets (rounds AND continuationsInjected)", () => {
  // P1 regression: rounds was reset but the L2 continuation budget was not,
  // so task B in a session inherited task A's exhausted auto-continuation cap.
  const at = SRC.indexOf('name: "declare_done"');
  assert.ok(at >= 0);
  const region = SRC.slice(at, SRC.indexOf("registerTool", at + 10));
  assert.match(region, /state\.rounds = \[\]/);
  assert.match(region, /continuationsInjected = 0/);
});

test("run_precommit maps runner-protocol ERROR to a VALID sidecar verdict (never persists 'ERROR')", () => {
  // P0 regression: persisting verdict:"ERROR" (not in PRECOMMIT_VERDICTS) made
  // loadSidecar AND the git pre-commit hook reject the whole sidecar as forged.
  assert.match(SRC, /outcome\.verdict === "ERROR" \? "NOT_RUN" : outcome\.verdict/);
});

test("edit-time L6 scanner probes every install layout (not just the dev repo path)", () => {
  // P1 regression: the lone "../scripts/…" require only resolved in the dev
  // repo; global installs (extensions/pi-review-gate/) need ../../scripts/.
  assert.match(SRC, /\.\.\/scripts\/scan-test-labels\.cjs/);
  assert.match(SRC, /\.\.\/\.\.\/scripts\/scan-test-labels\.cjs/);
});

test("record_review parses full output through verdict-parse", () => {
  assert.match(SRC, /name:\s*["']record_review["']/);
  assert.match(SRC, /parseReviewOutput/);
});

test("request_arbitration is registered and is a NARROW, fail-closed capability", () => {
  assert.match(SRC, /name:\s*["']request_arbitration["']/);
  // It must only ever act on a real recorded block, and only on an arbitrable
  // action (parseArbitrableAction rejects commit/push/pr-create).
  assert.match(SRC, /lastBlockedShip/);
  assert.match(SRC, /parseArbitrableAction/);
  // The arbiter is spawned by the extension (agent cannot hand-write it).
  assert.match(SRC, /runArbiter/);
  assert.match(SRC, /buildArbiterPrompt/);
  // Fail-closed: any missing/invalid verdict resolves to GATE_WINS.
  assert.match(SRC, /verdict\?\.decision \?\? "GATE_WINS"/);
  // No-UI HUMAN path fails closed to GATE_WINS.
  assert.match(SRC, /!ctx\.hasUI[\s\S]{0,200}GATE_WINS/);
});

test("arbiter bypass token is in-memory ONLY, never persisted to the sidecar", () => {
  // The token is a replayable capability ticket; it must not be written to the
  // sidecar (a process restart legitimately loses it). Prove it is not part of
  // the persisted GateState shape or the save path.
  assert.match(SRC, /bypassToken:\s*BypassToken\s*\|\s*null/);
  assert.doesNotMatch(SRC, /state\.bypassToken/);
  assert.doesNotMatch(SRC, /saveSidecar\([^)]*bypassToken/);
});

test("arbiter bypass only ever matches a lone gh pr edit, never commit/push/pr-create", () => {
  // The token-consumption branch is guarded on kind === "pr-edit"; there is no
  // token path for other ship kinds (they are never arbitrable).
  assert.match(SRC, /ships\[0\]\.kind === "pr-edit" && bypassToken/);
  // An AGENT_WINS decision never sets review READY or precommit PASS.
  const arbAt = SRC.indexOf('name: "request_arbitration"') >= 0
    ? SRC.indexOf("request_arbitration") : SRC.indexOf("request_arbitration");
  const arbRegion = SRC.slice(arbAt, arbAt + 4000);
  assert.doesNotMatch(arbRegion, /verdict\s*=\s*"READY"/);
  assert.doesNotMatch(arbRegion, /precommit\.verdict\s*=\s*"PASS"/);
});

test("arbiter evidence queries the SAME PR the blocked command targets (selector/repo/hostname)", () => {
  // Reviewer P1: the arbiter must not be shown the current-branch default PR
  // when the command targets a different one.
  assert.match(SRC, /function gatherPrText\(action: ArbitrableAction\)/);
  assert.match(SRC, /action\.selector/);
  assert.match(SRC, /action\.repo/);
  assert.match(SRC, /action\.hostname/);
});

test("re-roll is blocked for ANY prior decision (including AGENT_WINS)", () => {
  // Reviewer P1: a granted-then-consumed AGENT_WINS must not be re-mintable.
  const at = SRC.indexOf("arbitrationDecisions.get(decisionKey)");
  const region = SRC.slice(at, at + 300);
  assert.match(region, /if \(cached\) \{/);
  // The decision key binds command digest + round + body-file content.
  assert.match(SRC, /decisionKey = `\$\{parsed\.action\.commandDigest\}#\$\{state\.rounds\.length\}#\$\{bodyDigest\}`/);
});

test("a standing arbiter token is cleared on any edit / new round / gate-reset", () => {
  assert.match(SRC, /clearBypassToken\(\);\s*\/\/ any edit invalidates/);
  // gate-reset clears it and the arbitration bookkeeping.
  const resetAt = SRC.indexOf('registerCommand("gate-reset"');
  // Window sized to the whole handler — it grows as more session state is reset.
  const resetRegion = SRC.slice(resetAt, resetAt + 900);
  assert.match(resetRegion, /clearBypassToken\(\)/);
  assert.match(resetRegion, /arbitrationsUsed = 0/);
  assert.match(resetRegion, /arbitrationDecisions\.clear\(\)/);
});

test("L5: commit & PR title/body language check is ADVISORY (warns, never blocks)", () => {
  // commit messages AND gh pr create title/body are language-checked.
  assert.match(SRC, /firstNonEnglish/);
  assert.match(SRC, /extractPrTextFields/);
  // Applied to both ship kinds.
  assert.match(SRC, /s\.kind === "pr-create" \|\| s\.kind === "pr-edit"/);
  // Findings are collected as advisories and surfaced via notify — the L5
  // branch must NOT return a block (extraction heuristics can mis-read
  // heredoc/substitution commit commands; a wrong guess must not stop a ship).
  assert.match(SRC, /l5Advisories/);
  assert.match(SRC, /review-gate \(L5 advisory\)/);

  // Reviewer P2 hardening: prove the LANGUAGE branches themselves cannot
  // block, independent of any reason wording. Each language check appends to
  // l5Advisories; between the deterministic check and its advisory push there
  // must be NO `block: true` — and the segment from the LAST language check to
  // the notify call must be block-free too.
  const commitLangAt = SRC.indexOf("firstNonEnglish(msgs)");
  const prLangAt = SRC.indexOf("firstNonEnglish(prTexts)");
  const notifyAt = SRC.indexOf("review-gate (L5 advisory)");
  assert.ok(commitLangAt > 0 && prLangAt > commitLangAt && notifyAt > prLangAt,
    "commit language check → PR language check → advisory notify, in order");
  const langRegion = SRC.slice(commitLangAt, notifyAt);
  assert.doesNotMatch(langRegion, /block:\s*true/,
    "no blocking return may exist between the language checks and the advisory notify");
  // The advisory must be surfaced through ctx.ui.notify at warning level.
  const notifyCall = SRC.slice(SRC.lastIndexOf("ctx.ui.notify", notifyAt), notifyAt + 400);
  assert.match(notifyCall, /ctx\.ui\.notify\(/);
  assert.match(notifyCall, /"warning"/);

  // AI-attribution BEFORE the language region STAYS a hard block.
  const attrRegion = SRC.slice(SRC.indexOf("const l5Advisories"), commitLangAt);
  assert.match(attrRegion, /AI attribution[\s\S]*?block:\s*true/);
});

test("commands registered: gate-status, gate-bypass, gate-mode, gate-reset", () => {
  for (const cmd of ["gate-status", "gate-bypass", "gate-mode", "gate-reset"]) {
    assert.match(SRC, new RegExp(`registerCommand\\(["']${cmd}["']`), cmd);
  }
});

test("high-value sd0x-dev-flow commands are registered from a shared catalog", () => {
  assert.match(SRC, /WORKFLOW_COMMANDS/);
  assert.match(SRC, /registerWorkflowCommand/);
  assert.match(SRC, /buildWorkflowPrompt/);
  assert.match(SRC, /pi\.sendUserMessage/);

  const catalog = readFileSync(join(ROOT, "lib", "workflow-commands.ts"), "utf8");
  for (const cmd of [
    "review", "precommit", "precommit-fast", "verify", "next-step",
    "risk-assess", "smart-commit", "create-pr", "load-pr-review", "watch-ci",
  ]) {
    assert.match(catalog, new RegExp(`["']?${cmd}["']?\\s*:`), cmd);
  }
});

test("precommit PASS is granted ONLY by the run_precommit tool (trusted spawn + nonce receipt)", () => {
  // Root-cause fix: bash stdout can never grant a PASS. The single authority is
  // the run_precommit tool, which spawns the trusted runner and verifies a
  // private nonce receipt.
  assert.match(SRC, /name:\s*["']run_precommit["']/);
  assert.match(SRC, /runTrustedPrecommit/);
  assert.match(SRC, /resolveTrustedRunner/);
  // Receipt protocol validation lives in lib/precommit-receipt.ts (pure).
  assert.match(SRC, /validatePrecommitReceipt/);
  const PR = readFileSync(join(ROOT, "lib", "precommit-receipt.ts"), "utf8");
  assert.match(PR, /receipt nonce mismatch/);
  // The old forgeable path (grant PASS from parsed stdout) must be gone: stdout
  // may only INVALIDATE a prior PASS, never set one.
  assert.doesNotMatch(SRC, /verdict === "PASS" && !event\.isError/);
});

test("run_precommit spawns with argv, never shell:true", () => {
  assert.match(SRC, /spawn\(/);
  assert.match(SRC, /shell:\s*false/);
  assert.doesNotMatch(SRC, /shell:\s*true/);
});

test("run_precommit is async and abortable — never a sync spawn that freezes the event loop", () => {
  // Root-cause fix for "run_precommit hangs, ESC can't cancel": spawnSync blocks
  // the extension host's event loop for up to 20 minutes. The runner must be
  // spawned async, detached (own process group), with abort + timeout killing
  // the whole process tree.
  assert.doesNotMatch(SRC, /spawnSync\s*\(/);
  assert.match(SRC, /async function runTrustedPrecommit/);
  assert.match(SRC, /abortSignal\?\.addEventListener\("abort"/);
  assert.match(SRC, /detached:\s*true/);
  assert.match(SRC, /killProcessTree/);
  // The tool must pass the target repo root and its AbortSignal through
  // (P1 fix: process.cwd() can differ from ctx.cwd under pi --cwd; P-multi:
  // the target may be the active non-session repo).
  assert.match(SRC, /await runTrustedPrecommit\(targetDir, targetRoot, mode, _signal\)/);
  assert.doesNotMatch(SRC, /async function runTrustedPrecommit[^{]*\{\s*\n\s*const cwd = process\.cwd\(\)/);
});

// ---------------------------------------------------------------------------
// Precommit observability — the run output must survive, and be findable.

test("the runner's output is CAPTURED to a file descriptor, never discarded", () => {
  // It used to be stdio: ["ignore", "ignore", "ignore"], so a FAIL told the
  // agent "1/3 checks failed" and nothing else — no check name, no error text.
  assert.doesNotMatch(SRC, /stdio:\s*\["ignore",\s*"ignore",\s*"ignore"\]/,
    "the precommit runner's output must not be thrown away");
  const start = SRC.indexOf("async function runTrustedPrecommit");
  assert.ok(start > 0);
  const body = SRC.slice(start, start + 6000);
  assert.match(body, /openSync\(tmpLog/, "capture via a file descriptor");
  // A pipe would deadlock: the runner is detached and long-lived, and a full
  // 64KB pipe buffer blocks its next write forever if nobody drains it.
  assert.doesNotMatch(body, /stdio:\s*\[[^\]]*"pipe"/, "never a pipe for the detached runner");
  assert.match(body, /rmSync\(dir, \{ recursive: true, force: true \}\)/,
    "the temp receipt dir is still destroyed after every run");
});

test("the run log is anchored to the REPO ROOT, or it would invalidate its own PASS", () => {
  // `.pi/` is gate-owned only at the repo root (GATE_EXCLUDE_PATHSPECS uses
  // `:/.pi`). The primary repo's precommit may run in a SUBDIRECTORY; a log
  // written to <root>/sub/.pi/ is an ordinary worktree file, so every run
  // would change the fingerprint and void the PASS it just recorded.
  assert.match(SRC, /const PRECOMMIT_LOG_RELPATH = "\.pi\/precommit-last\.log"/);
  assert.match(SRC, /function keepRunLog\(repoRoot: string, tmpLog: string\)/);
  assert.match(SRC, /pathJoin\(repoRoot, PRECOMMIT_LOG_RELPATH\)/);
  assert.doesNotMatch(SRC, /pathJoin\((?:cwd|targetDir), PRECOMMIT_LOG_RELPATH\)/);
  // Kept BEFORE the abort/timeout early-returns: those are exactly the runs
  // whose output the agent cannot otherwise see.
  const keptAt = SRC.indexOf("logPath = keepRunLog(repoRoot, tmpLog)");
  const abortAt = SRC.indexOf('if (res.aborted) return fail("aborted by user');
  assert.ok(keptAt > 0 && abortAt > keptAt, "the log must be kept before the abort/timeout returns");
});

test("precommit replies POINT AT the log; they never inline the runner's output", () => {
  // A failing suite can emit megabytes, and only the agent knows how much of
  // it it needs — so the reply carries the path plus the failed check NAMES,
  // and the agent reads the file itself.
  const start = SRC.indexOf('name: "run_precommit"');
  assert.ok(start > 0);
  const body = SRC.slice(start, SRC.indexOf('name: "declare_done"'));
  assert.match(body, /Full output: \$\{outcome\.logPath\}/, "every reply names the log");
  assert.match(body, /outcome\.failedSteps/, "failed check names help locate the section");
  assert.doesNotMatch(body, /\.tail/, "step output must never be inlined into the reply");
});

test("failed-step names are diagnostics: read AFTER the verdict, never fed into it", () => {
  const start = SRC.indexOf("async function runTrustedPrecommit");
  const body = SRC.slice(start, start + 6000);
  const verdictAt = body.indexOf("validatePrecommitReceipt(parsed");
  const stepsAt = body.indexOf("failedStepNames(parsed)");
  assert.ok(verdictAt > 0 && stepsAt > verdictAt,
    "the verdict must be decided before the steps are even looked at");
});

test("the audit log anchors on the REPO ROOT, not the session cwd", () => {
  // `:/.pi` excludes the ROOT `.pi` only. Pi started in a subdirectory has a
  // cwd where `.pi/` is an ordinary worktree path, so a writer anchored there
  // moves the fingerprint on every write — silently voiding a recorded READY.
  //
  // Scope: the audit log (added here) and the precommit run log (covered by
  // its own test above). The older `.pi/` writers — appendLesson and
  // /gate-lesson — still anchor on cwd; that is pre-existing behaviour, left
  // alone deliberately rather than widened into this change.
  assert.match(SRC, /pathJoin\(primaryRepoRoot, "\.pi", "review-gate-audit\.log"\)/,
    "the audit log must live in the repo root's .pi/");
  assert.doesNotMatch(SRC, /pathJoin\(cwd, "\.pi", "review-gate-audit\.log"\)/);
});

test("stale-state reconciliation is one-way", () => {
  assert.match(SRC, /git-clean can clear.*only edits/i);
});

test("sensitive-file guard wired into tool_call", () => {
  assert.match(SRC, /isSensitiveFile/);
});

test("request_sensitive_edit: the user decides in an extension dialog, not the agent", () => {
  const start = SRC.indexOf('name: "request_sensitive_edit"');
  assert.ok(start > 0, "the tool must be registered");
  const body = SRC.slice(start, start + 6000);

  assert.match(body, /ctx\.ui\.confirm\(/, "the extension must render the confirm dialog itself");
  assert.doesNotMatch(body, /confirmed\s*:\s*Type\./,
    "no agent-supplied 'confirmed' parameter — that would be self-approval");
  assert.match(body, /if \(!ctx\.hasUI\)/, "no UI must fail closed instead of granting");
  assert.match(body, /dialogFailed/, "a dialog that could not be shown is not a decline");
});

test("SECURITY: request_sensitive_edit refuses .git internals before showing any dialog", () => {
  const start = SRC.indexOf('name: "request_sensitive_edit"');
  const body = SRC.slice(start, start + 6000);
  const integrityAt = body.indexOf("isGateIntegrityPath");
  const confirmAt = body.indexOf("ctx.ui.confirm");
  assert.ok(integrityAt > 0 && confirmAt > 0, "both must exist");
  assert.ok(integrityAt < confirmAt,
    "a user must never be asked to authorize a write to .git/hooks — that would disarm L3");
});

test("SECURITY: a declined sensitive path is locked, and grants never reach the sidecar", () => {
  assert.match(SRC, /sensitiveDeclinedPaths\.add\(absPath\)/,
    "a decline must lock that path against re-asking");
  assert.match(SRC, /sensitiveDeclinedPaths\.has\(absPath\)/,
    "a locked path must be refused before any dialog");
  // In-memory only: persisting a grant would let a write authorization survive
  // a crash/resume, i.e. outlive the conversation the user consented in.
  assert.doesNotMatch(SRC, /state\.sensitiveGrants/,
    "sensitive-file grants must never be written into the persisted gate state");
});

// ---------------------------------------------------------------------------
// L8 — the loop goal is negotiated with the user, not written by the agent

test("propose_loop_goal: the USER approves in an extension dialog, and the EXTENSION writes the file", () => {
  const start = SRC.indexOf('name: "propose_loop_goal"');
  assert.ok(start > 0, "the tool must be registered");
  const body = SRC.slice(start, start + 6000);
  assert.match(body, /ui\?\.confirm\?\.\(|ctx\.ui\.confirm\(/,
    "the extension must render the approval dialog itself");
  assert.doesNotMatch(body, /confirmed\s*:\s*Type\./,
    "no agent-supplied 'confirmed' parameter — that would be self-approval");
  // The approval must describe text the USER saw: the extension writes the
  // file, and the sidecar records the hash of exactly that text.
  assert.match(body, /writeFileSync\(goalPath/);
  assert.match(body, /state\.loopGoal = \{ hash: goalTextHash\(goalText\)/);
  assert.match(body, /LOOP_GOAL_MAX_WRITE_CHARS/, "the goal must be length-bounded");
});

// ---------------------------------------------------------------------------
// Structural: the extension's `lib/` bindings must actually be imported.
//
// REGRESSION: `LOOP_GOAL_MAX_WRITE_CHARS` was used inside propose_loop_goal but
// missing from the import list. ESM does not fail on load for an unresolved
// bare identifier — it throws `... is not defined` the first time that line
// runs, so the bug only surfaced when a user actually proposed a goal, while
// the structural test above (a plain substring match) happily passed. Every
// tool body in this extension is reachable only at runtime, so a missing
// import is invisible without this check.

test("every lib export referenced by the extension is imported (no runtime ReferenceError)", () => {
  // Comments mention plenty of exported names in prose ("ONE CODE_EXTENSIONS
  // list", "PrecommitVerdict enum member"); only real code counts.
  //
  // The comment stripper is deliberately crude: it can also eat the rest of a
  // line after a " // " that lives INSIDE a string literal. That direction is
  // safe — it can only hide a usage (a missed finding), never invent one — and
  // `npm run typecheck` covers the gap with TS2304. A precise stripper would
  // mean writing a tokenizer to guard one assertion.
  const code = SRC
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

  const imported = new Set<string>();
  for (const m of code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"[^"]+"/g)) {
    for (const clause of m[1].split(",")) {
      const spec = clause.trim().replace(/^type\s+/, "");
      if (!spec) continue;
      const parts = spec.split(/\s+as\s+/);
      imported.add((parts[1] ?? parts[0]).trim());
    }
  }
  assert.ok(imported.size > 10, "the import scan must find the extension's bindings");

  const libDir = join(ROOT, "lib");
  const missing: string[] = [];
  for (const file of readdirSync(libDir)) {
    if (!file.endsWith(".ts")) continue;
    const libSrc = readFileSync(join(libDir, file), "utf8");
    const exportDecl =
      /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm;
    for (const m of libSrc.matchAll(exportDecl)) {
      const name = m[1];
      if (imported.has(name)) continue;
      // Referenced as a bare identifier (not a property access, not a substring
      // of a longer name) and not declared locally in the extension itself?
      const used = new RegExp(`(?<![A-Za-z0-9_$.])${name}(?![A-Za-z0-9_$])`);
      const declared = new RegExp(`(?:const|let|var|function|class|interface|type|enum)\\s+${name}\\b`);
      if (used.test(code) && !declared.test(code)) missing.push(`${file} → ${name}`);
    }
  }
  assert.deepEqual(missing, [],
    `these lib exports are used by extensions/review-gate.ts but never imported: ${missing.join(", ")}`);
});

test("SECURITY: the goal approval binds to CONTENT, so a later edit drops it", () => {
  // If the check were "a confirmation exists", the agent could approve a
  // one-line goal and then rewrite the file into whatever it wanted to ship.
  assert.match(SRC, /function loopGoalConfirmed\(\)/);
  assert.match(SRC, /isLoopGoalConfirmed\(goal, state\.loopGoal, raw\)/);
  assert.match(SRC, /return false; \/\/ unreadable/, "an unreadable goal file must fail closed");
});

// ---------------------------------------------------------------------------
// L7 — the post-PR Copilot review loop

test("the Copilot tools are TRUSTED: the extension runs gh, the agent cannot report the outcome", () => {
  for (const name of ["request_copilot_review", "check_copilot_review"]) {
    const start = SRC.indexOf(`name: "${name}"`);
    assert.ok(start > 0, `${name} must be registered`);
    const body = SRC.slice(start, start + 7000);
    // The only parameter is the repo selector — no status, no thread list, no
    // "I handled it" flag the model could fill in.
    assert.doesNotMatch(body, /status\s*:\s*Type\.|threads\s*:\s*Type\.|resolved\s*:\s*Type\./,
      `${name} must not accept an agent-reported outcome`);
    assert.match(body, /await (resolveOpenPr|fetchCopilotPayload|requestCopilotReviewer)\(/,
      `${name} must gather its own evidence via gh`);
  }
  // gh runs as argv through the async spawn helper (never a shell string, and
  // never a sync spawn that would freeze the host).
  assert.match(SRC, /async function runGh\(/);
  assert.match(SRC, /spawn\(argv\[0\], argv\.slice\(1\)/);
  assert.doesNotMatch(SRC, /runGh\([^)]*shell/);
});

test("SECURITY: the Copilot requirement never touches the SHIP gate (it would deadlock)", () => {
  // Fixing a Copilot finding requires a commit and a push. A Copilot
  // requirement inside the ship authority would therefore block its own
  // remedy — so it may appear only in the completion paths.
  const callStart = SRC.indexOf('pi.on("tool_call"');
  const callBody = SRC.slice(callStart, SRC.indexOf("\n  });", callStart));
  assert.doesNotMatch(callBody, /copilot/i, "the L1 ship gate must not consult the Copilot cycle");
  // …and it must be wired into both completion surfaces instead.
  const doneStart = SRC.indexOf('name: "declare_done"');
  assert.match(SRC.slice(doneStart, doneStart + 6000), /copilotProblemsFor\(/);
  const settledStart = SRC.indexOf('pi.on("agent_settled"');
  assert.match(SRC.slice(settledStart, settledStart + 4000), /copilotProblemsFor\(/);
});

test("a FAILED ship arms nothing; a successful PR ship arms the repo it ran in", () => {
  const at = SRC.indexOf("L7: a SUCCESSFUL PR-affecting ship");
  assert.ok(at > 0, "the arming site must be documented");
  const body = SRC.slice(at, at + 1400);
  assert.match(body, /event\.isError !== true/, "a failed command must not arm a cycle");
  assert.match(body, /detectShipCommands\(cmd\)/, "reuse the audited ship detector");
  assert.match(body, /kinds\.has\("pr-create"\)/);
  assert.match(body, /kinds\.has\("push"\)/);
  assert.match(body, /armCopilotReview\(st\.copilot, nowIso\)/);
});

test("waiting for Copilot spends its OWN continuation budget, not the review loop's", () => {
  // Otherwise a slow Copilot would burn the rounds the fix→review loop needs,
  // and the session would run out of continuations before fixing anything.
  assert.match(SRC, /let completionContinuations = 0/);
  assert.match(SRC, /COMPLETION_CONTINUATION_CAP/);
  const settledStart = SRC.indexOf('pi.on("agent_settled"');
  const body = SRC.slice(settledStart, settledStart + 4000);
  assert.match(body, /problems\.length > 0 && continuationsInjected >= state\.maxRounds/);
  assert.match(body, /problems\.length === 0 && completionContinuations >= COMPLETION_CONTINUATION_CAP/);
});
test("SECURITY: a sensitive-file grant is consumed on the RESULT, not at tool_call", () => {
  const callStart = SRC.indexOf('pi.on("tool_call"');
  const resultStart = SRC.indexOf('pi.on("tool_result"');
  assert.ok(callStart > 0 && resultStart > callStart);
  const callBody = SRC.slice(callStart, resultStart);
  const resultBody = SRC.slice(resultStart);

  assert.match(callBody, /findGrant\(sensitiveGrants/,
    "tool_call only checks the grant");
  assert.doesNotMatch(callBody, /consumeGrant\(/,
    "burning the grant before the edit lands would force a new dialog after any retry");
  assert.match(resultBody, /consumeGrant\(/,
    "a landed edit must burn the one-shot grant");
});

test("SECURITY: a new session and /gate-reset both start with no sensitive-file grants", () => {
  const resets = [...SRC.matchAll(/sensitiveGrants = \[\]/g)];
  assert.ok(resets.length >= 2,
    "session_start and gate-reset must each clear outstanding grants");
});

test("no network fetch anywhere in the extension", () => {
  // The extension has "npx" in regex patterns (anti-forgery detection),
  // and import("node:child_process") — both are fine. Only block actual network calls.
  assert.doesNotMatch(SRC, /\bfetch\b/);
  assert.doesNotMatch(SRC, /import\("https?:/);
  // "npx" inside regex patterns is OK; "npx " (command invocation) is not.
  assert.doesNotMatch(SRC, /['"]npx\s/);
});

test("P0-2: branch commit detection via commitsAheadOfBase", () => {
  assert.match(SRC, /commitsAheadOfBase/);
});

test("P0-5: detectShipCommands returns array", () => {
  assert.match(SRC, /ships\.length/);
});

test("P1: stash/checkout/merge/rebase re-arming exists in tool_result bash handler", () => {
  assert.match(SRC, /stash\\s\+\(pop\|apply\)/);
  assert.match(SRC, /checkout.*switch.*restore.*reset/);
  assert.match(SRC, /merge\|pull\|rebase\|cherry-pick\|am/);
});

test("P1: turn_end awaits commitsAheadOfBase", () => {
  assert.match(SRC, /await\s+commitsAheadOfBase/);
});

test("R6/R9/R10: project config, git memory, strategic reset wired in", () => {
  // R6 — per-project maxRounds loaded (clamped in lib/project-config.ts).
  assert.match(SRC, /loadProjectConfig/);
  assert.match(SRC, /state\.maxRounds = projectConfig\.maxRounds/);
  // R9 — git memory appended to the compaction resume message (default on,
  // knob-guarded so an explicit "gitMemory": false still disables it).
  assert.match(SRC, /projectConfig\.gitMemory \? buildGitMemory/);
  // R10 — strategic reset is one-shot and persisted via strategicResetFired.
  assert.match(SRC, /maybeStrategicReset/);
  assert.match(SRC, /strategicResetFired/);
  assert.match(SRC, /STRATEGIC_RESET_CHECKLIST/);
  // R10 regression: the L2 auto-continuation path called maybeStrategicReset
  // bare after the st: GateState signature change, so
  // shouldStrategicReset(undefined, ...) threw "Cannot read properties of
  // undefined (reading 'strategicResetFired')". A bare call must never
  // reappear.
  assert.doesNotMatch(SRC, /maybeStrategicReset\s*\(\s*\)/);
});

test("auto-loop prohibited behaviors are in the per-turn reminder (sd0x-dev-flow port)", () => {
  assert.match(SRC, /Prohibited while gates are unmet/);
  assert.match(SRC, /completion-style summary/);
});

test("the multi-repo reminder teaches the CURRENT record_review/run_precommit contract", () => {
  // This exact string once told the agent that those tools "target the repo you
  // most recently edited". They no longer do (an explicit `repo` is required
  // once several repos are edited), and a per-turn prompt outranks every doc:
  // a session that believed the old wording recorded round after round of
  // READY against the wrong repo and read the resulting block as sabotage.
  assert.match(SRC, /REQUIRE an explicit `repo`/);
  assert.doesNotMatch(SRC, /target the repo you most recently edited/);
});

test("gate-lesson command registered (self-improvement loop port)", () => {
  assert.match(SRC, /registerCommand\(["']gate-lesson["']/);
  assert.match(SRC, /review-gate-lessons\.md/);
});

test("precommit trust does NOT depend on parsing bash command text (root-cause fix)", () => {
  // The old forgeable approach inferred a PASS from whether a bash command
  // "looked like" a runner invocation. That whole trust path is gone; PASS now
  // comes only from run_precommit spawning the runner + verifying a receipt.
  // Guard against regressing to a command-text trust heuristic.
  assert.doesNotMatch(SRC, /isPrecommitRunnerCommand/);
});

// ---------------------------------------------------------------------------
// LLM semantic guard layer — call-site safety invariants (structural)

test("LLM guards: deterministic checks precede every LLM call (tighten-only order)", () => {
  // Guard #2: COMMIT_MSG_FORBIDDEN regex loop must appear BEFORE the semantic
  // attribution call in the commit branch.
  const forbidden = SRC.indexOf("COMMIT_MSG_FORBIDDEN.some");
  const semanticAttr = SRC.indexOf("classifyAiAttribution(");
  assert.ok(forbidden > 0 && semanticAttr > forbidden,
    "regex attribution check must precede classifyAiAttribution");

  // L5 (advisory): Unicode firstNonEnglish must precede the semantic english
  // check — anchored to the commit-msg branch (`msgs`), because the L6
  // edit-time branch also calls classifyNonEnglish earlier in the file.
  const unicodeCheck = SRC.indexOf("firstNonEnglish(msgs)");
  const semanticEnglish = SRC.indexOf("classifyNonEnglish(classifier(), msgs)");
  assert.ok(unicodeCheck > 0 && semanticEnglish > unicodeCheck,
    "Unicode script check must precede classifyNonEnglish in the commit branch");
  // same ordering in the PR branch
  const unicodePr = SRC.indexOf("firstNonEnglish(prTexts)");
  const semanticPr = SRC.indexOf("classifyNonEnglish(classifier(), prTexts)");
  assert.ok(unicodePr > 0 && semanticPr > unicodePr,
    "Unicode script check must precede classifyNonEnglish in the PR branch");
  // L6: the deterministic violations check must precede the semantic layer
  // inside checkTestLabels.
  const l6Deterministic = SRC.indexOf("res.violations.length > 0");
  const l6Semantic = SRC.indexOf("classifyNonEnglish(classifier(), labels)");
  assert.ok(l6Deterministic > 0 && l6Semantic > l6Deterministic,
    "deterministic L6 violations must precede the semantic label check");

  // Guard #4: the ship LLM layer only runs inside the ships.length === 0
  // branch (it can only ADD detections, never lift one).
  const staticShips = SRC.indexOf("detectShipCommands(command)");
  const shipLlm = SRC.indexOf("classifyShipCommand(");
  assert.ok(staticShips > 0 && shipLlm > staticShips,
    "static ship detection must precede classifyShipCommand");
  const between = SRC.slice(staticShips, shipLlm);
  assert.match(between, /ships\.length === 0/,
    "LLM ship layer must be gated on the static detector finding nothing");
});

test("LLM guards: every call site is gated on its llmGuards config flag", () => {
  assert.match(SRC, /projectConfig\.llmGuards\.aiAttribution/);
  assert.match(SRC, /projectConfig\.llmGuards\.englishCheck/);
  assert.match(SRC, /projectConfig\.llmGuards\.shipDetect/);
});

test("L6 edit-time check scans the FULL projected file, not newText fragments", () => {
  // P1 regression guard: the extension must project via lib/edit-projection.ts.
  assert.match(SRC, /projectEditedContent\(/);
  assert.ok(SRC.includes('./lib/edit-projection.ts'), "must import lib/edit-projection.ts");
  // and the label check runs inside the edit-tool branch before returning
  const editBranch = SRC.indexOf("EDIT_TOOL_NAMES.has(event.toolName)");
  const labelCheck = SRC.indexOf("checkTestLabels(");
  assert.ok(editBranch > 0 && labelCheck > 0, "checkTestLabels must exist");
});

// ---------------------------------------------------------------------------
// Advisory fingerprint memo (perf): may inform the PROMPT, never a decision.

test("the advisory fingerprint memo has exactly one caller: the prompt renderer", () => {
  // A second caller is how this optimization would turn into a fail-open:
  // the memo can serve a value computed before an untracked-by-events edit,
  // which is harmless for prompt text and unacceptable for a gate decision.
  const calls = [...SRC.matchAll(/advisoryFingerprint\(\)/g)].map((m) => m.index!);
  // One definition (`function advisoryFingerprint()`) is excluded by the
  // `()` + no `function` prefix match below.
  const invocations = calls.filter((i) => !/function\s+$/.test(SRC.slice(Math.max(0, i - 20), i)));
  assert.equal(invocations.length, 1,
    `advisoryFingerprint() must have exactly ONE call site (found ${invocations.length})`);
  const promptRenderer = SRC.indexOf('pi.on("before_agent_start"');
  assert.ok(promptRenderer >= 0, "prompt renderer must exist");
  assert.ok(invocations[0] > promptRenderer,
    "the only call site must be inside the before_agent_start prompt renderer");
});

test("every enforcement path computes a FRESH fingerprint", () => {
  // Each of these can block a ship, end a task, or bind a verdict, so none of
  // them may read a memoized value.
  const anchors: Array<[string, number]> = [
    ['name: "declare_done"', 1200],
    ['name: "record_review"', 6000],
    ['name: "request_arbitration"', 4000],
    ['pi.on("agent_settled"', 1200],
    // 9000: the P-multi per-repo fingerprint loop sits ~130 lines after the
    // ship-detection anchor inside the tool_call handler.
    ["detectShipCommands(command)", 9000],
  ];
  for (const [anchor, window] of anchors) {
    const at = SRC.indexOf(anchor);
    assert.ok(at >= 0, `anchor not found: ${anchor}`);
    const body = SRC.slice(at, at + window);
    // P-multi: enforcement paths may target a non-session repo, so the
    // fingerprint arg is a variable (root), not the cwd literal — what must
    // hold is a DIRECT computeFingerprint call, never the advisory memo.
    assert.match(body, /computeFingerprint\(/,
      `${anchor} must call computeFingerprint() directly`);
    assert.ok(!body.includes("advisoryFingerprint()"),
      `${anchor} must NOT use the advisory memo`);
  }
});

test("the advisory memo never caches an UNAVAILABLE fingerprint", () => {
  // Caching the fail-closed sentinel would keep reporting "git unreadable"
  // after git recovers, and (worse) invite someone to 'fix' that by ignoring
  // the sentinel.
  const at = SRC.indexOf("function advisoryFingerprint()");
  assert.ok(at >= 0, "advisoryFingerprint must exist");
  const body = SRC.slice(at, at + 900);
  assert.match(body, /fp\.unavailable\s*\?\s*null\s*:/);
});

// The lifecycle wiring that no unit test can reach: restore() must COLLECT the
// migration result from loadSidecar (which consumes it) and OR it into the
// flag session_start reports. Asking migrateFingerprintVersion() again would
// always answer "false" for the sidecar path, so the notice was silently dead
// on the most common restore route.
test("restore() collects the migration result from loadSidecar, not from a second call", () => {
  const restoreAt = SRC.indexOf("function restore(");
  assert.ok(restoreAt >= 0, "restore() must exist");
  const body = SRC.slice(restoreAt, restoreAt + 4000);

  assert.match(body, /loadSidecar\(sidecarPath\(cwd\),\s*\w+\)/,
    "loadSidecar must be given an out-parameter to report the migration");
  assert.match(body, /fingerprintMigrated\s*=\s*migrateFingerprintVersion\(state\)\s*\|\|\s*\w+\.migrated/,
    "the sidecar's migration result must be OR'd into the reported flag");
});

test("session_start surfaces the migration notice and clears the flag", () => {
  const at = SRC.indexOf('pi.on("session_start"');
  assert.ok(at >= 0, "session_start handler must exist");
  // 6000: the P-multi reset block and the no-UI mode forcing at the handler
  // head push the notice section past the older windows.
  const body = SRC.slice(at, at + 6000);
  assert.match(body, /if \(fingerprintMigrated\)/,
    "an invalidated binding must be explained, not silently applied");
  assert.match(body, /FINGERPRINT_MIGRATION_NOTICE/);
  assert.match(body, /fingerprintMigrated = false/,
    "the flag must be cleared so the notice is not repeated");
});

test("a Copilot request that never lands is released, not parked in AWAITING", () => {
  // The bug this pins: `gh pr edit --add-reviewer @copilot` exits 0 and the
  // REST fallback answers 200 even where GitHub drops the bot, so the request
  // recorded AWAITING and the task waited out the whole 20-minute budget.
  const at = SRC.indexOf("const requested = await requestCopilotReviewer(");
  assert.ok(at > 0, "the request path must exist");
  const before = SRC.slice(Math.max(0, at - 600), at);
  assert.match(before, /probeCopilotActor\(dir, slug, signal\)/,
    "the capability probe must run BEFORE a round is spent");

  // Bound the window on the code itself (where AWAITING is recorded) rather
  // than on a character count that silently truncates as the block grows.
  const recordAbs = SRC.indexOf("recordCopilotRequest(st.copilot,", at);
  const landingAbs = SRC.indexOf("copilotRequestLanded(", at);
  assert.ok(landingAbs > 0, "the request must be read back from the PR");
  assert.ok(recordAbs > landingAbs, "the read-back must happen before AWAITING is recorded");
  const body = SRC.slice(at, recordAbs);
  // Released ONLY on hard evidence: probe says no AND both read-backs say no.
  assert.match(body, /if \(hasActor === false\)/,
    "a positive/unknown probe must not trigger the release path");
  assert.match(body, /copilotRequestLandedViaRest\(dir, slug, pr\.number, signal\)/,
    "the release must be confirmed by a second read from a different API surface");
  assert.match(body, /COPILOT_LANDING_RECHECK_DELAY_MS/,
    "review requests are eventually consistent: the confirming read must wait first");
  // The confirming pass asks BOTH surfaces: REST alone cannot see a Copilot
  // that reviewed and left the request list during the pause.
  assert.match(body, /viaCli === true \|\| viaRest === true/,
    "either surface saying 'landed' must keep the requirement");
  assert.match(body, /viaCli === false && viaRest === false \? false : undefined/,
    "only BOTH surfaces saying 'not there' may resolve to a release");
  assert.equal((body.match(/copilotRequestLanded\(dir, pr\.number, signal\)/g) ?? []).length, 2,
    "the JSON-export surface must be read twice: once first, once to confirm");
  assert.match(body, /if \(landed === false\)[\s\S]{0,200}releaseCopilotReview\(st\.copilot, "UNSUPPORTED"/,
    "only an explicit 'did not land' may release the requirement");
});

test("the Copilot probes fail CLOSED: an unreadable gh answer releases nothing", () => {
  for (const fn of ["probeCopilotActor", "copilotRequestLanded", "copilotRequestLandedViaRest"]) {
    const at = SRC.indexOf(`async function ${fn}(`);
    assert.ok(at > 0, `${fn} must exist`);
    // Bound the window at this function's own closing brace: a fixed character
    // count spills into the neighbour and lets a mutant in THIS function pass
    // unnoticed (only the neighbour's identical line is then matched).
    const rest = SRC.slice(at + 10);
    const end = rest.indexOf("\n  }\n");
    assert.ok(end > 0, `${fn} must have a recognizable body`);
    const body = rest.slice(0, end);
    assert.ok(body.length < 1200, `${fn} body window must stay local (got ${body.length})`);
    assert.match(body, /if \(!res\.ok\) return undefined;/,
      `${fn} must report 'cannot tell' when gh fails, never a negative answer`);
    assert.match(body, /Promise<boolean \| undefined>/,
      `${fn} must keep the third value in its type`);
  }
});

test("an abort proves nothing about Copilot: it can never release the requirement", () => {
  // ESC is the user leaving, not GitHub refusing. Two places used to read it
  // as evidence: a gh call that returns !ok after an abort, and the confirming
  // read being skipped while the first negative read was kept.
  const runGhAt = SRC.indexOf("async function runGh(");
  assert.ok(runGhAt > 0, "runGh must exist");
  const spawnAt = SRC.indexOf("spawn(argv[0]", runGhAt);
  const guardAt = SRC.indexOf("if (opts.signal?.aborted)", runGhAt);
  assert.ok(guardAt > 0 && guardAt < spawnAt,
    "an already-aborted signal must short-circuit BEFORE spawning (its listener never fires)");

  const requestAt = SRC.indexOf("const requested = await requestCopilotReviewer(");
  const body = SRC.slice(requestAt, requestAt + 3500);
  assert.match(body, /if \(!requested\.ok\)[\s\S]{0,200}if \(signal\?\.aborted\)[\s\S]{0,400}return \{/,
    "a failed request that was merely aborted must return without releasing");
  assert.doesNotMatch(body, /if \(landed === false && !signal\?\.aborted\)/,
    "an abort must downgrade the first read, not skip the confirmation and release on it");
  assert.match(body, /if \(signal\?\.aborted\) \{\s*\n\s*landed = undefined;/,
    "an aborted confirmation means 'cannot tell'");
});

test("check_copilot_review leaves a released cycle alone (no resurrection, no gh calls)", () => {
  // The loop this closes: request released the cycle as EXHAUSTED, the next
  // check re-derived it as ARMED, and declare_done was blocked again.
  const at = SRC.indexOf('name: "check_copilot_review"');
  assert.ok(at > 0, "the check tool must exist");
  // Bound the window on the next tool registration, not on a character count.
  const end = SRC.indexOf("pi.registerTool({", at);
  const body = SRC.slice(at, end === -1 ? SRC.length : end);
  const guardAt = body.indexOf("!isCopilotOutstanding(settled)");
  assert.ok(guardAt > 0, "a released cycle must short-circuit the whole check");
  for (const laterWork of ["resolveOpenPr(", "fetchCopilotPayload(", "evaluateCopilot("]) {
    const workAt = body.indexOf(laterWork);
    assert.ok(workAt > guardAt, `${laterWork} must come AFTER the released short-circuit`);
  }
  assert.doesNotMatch(body.slice(guardAt, body.indexOf("}", body.indexOf("details:", guardAt))),
    /persistRepo|releaseCopilotReview|armCopilotReview/,
    "the short-circuit must not rewrite the state it reports");
});
