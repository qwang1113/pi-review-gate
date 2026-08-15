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
  // Anchored on the call, not on its argument expression: the goal is now read
  // into a local (the oversized-requirement checkpoint reads the same value),
  // and this assertion is about WHERE the directive is injected, not how the
  // argument is spelled.
  const injectAt = SRC.indexOf("buildLoopGoalDirective(", handlerAt);
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
  const toolBody = SRC.slice(toolStart, SRC.indexOf('name: "request_scope_limit"', toolStart));
  assert.match(toolBody, /state\.pausedQuestion = \{/);
  assert.match(toolBody, /loopArmed = false/);
  assert.match(toolBody, /persist\(/);
  // …but it must NEVER touch the ship authority: unmetRequirements takes no
  // pause input, and no call site filters its problems on pausedQuestion.
  assert.doesNotMatch(SRC, /unmetRequirements\([^)]*pausedQuestion/);
});

test("pause_for_question: the QUESTION reaches the user, not just the state file", () => {
  // REGRESSION (the bug this test exists for): the question was written to
  // `state.pausedQuestion` and nowhere else, while the tool result told the
  // agent it had been "delivered to the user verbatim". The agent then wrote
  // "see the question above" and the user saw a warning with no question in it.
  const toolStart = SRC.indexOf('name: "pause_for_question"');
  const toolBody = SRC.slice(toolStart, SRC.indexOf('name: "request_scope_limit"', toolStart));

  // The SAME text that is filed into state must be the text the user is shown
  // — the regression was precisely that only the state copy existed.
  assert.match(toolBody, /const askUser = \([^)]*\)[^=]*=>\s*showToUser\(ctx, lead, [^;]*question\)/,
    "the question itself must be handed to showToUser");
  assert.match(toolBody, /state\.pausedQuestion = \{ question: question\.slice\(/,
    "the state copy and the shown copy must come from the same `question`");
  // Every return path must show it BEFORE returning: no branch may file the
  // pause away and answer the agent without the user ever seeing the question.
  // (`\s+` matters: the branch returns are indented deeper than the tail one.)
  const beforeReturns = toolBody.split(/\n\s+return \{/).slice(0, -1);
  assert.equal(beforeReturns.length, 4,
    `expected 4 return paths (empty-question reject + 3 ask paths), found ${beforeReturns.length}`);
  for (const branch of beforeReturns) {
    assert.ok(/= askUser\(/.test(branch) || /if \(!question\)/.test(branch),
      "each return path either rejects an empty question or shows it first");
  }

  // The tool result must report what ACTUALLY happened rather than asserting
  // delivery unconditionally: a headless session can show nothing.
  assert.match(toolBody, /const delivered = askUser\(/);
  assert.match(toolBody, /deliveryNote\(delivered\)/, "the reply text must branch on real delivery");
  assert.doesNotMatch(toolBody, /ALREADY been delivered to the user verbatim/,
    "never claim delivery that did not happen");

  // Every return path (loop, explore/normal, already-paused) shows the
  // question — a mode difference must not silently swallow it.
  const showCalls = [...toolBody.matchAll(/= askUser\(/g)].length;
  assert.equal(showCalls, 3,
    `all three return paths (explore/normal, already-paused, loop) must show it (found ${showCalls})`);
});

test("showToUser renders SYNCHRONOUSLY — sendMessage would queue it and buy an extra turn", () => {
  // pi.sendMessage inside a tool is queued, not rendered: with
  // deliverAs:"followUp" agent-loop drains the queue when the agent would
  // STOP, silently buying another LLM turn — fatal for a tool whose job is to
  // PAUSE the loop, and it shows the user nothing until the turn ends anyway.
  // ui.notify appends to the chat container and requests a render right away.
  const start = SRC.indexOf("function showToUser");
  assert.ok(start > 0, "the helper must exist");
  const body = SRC.slice(start, start + 800);
  assert.match(body, /notify\(`\$\{lead\}\\n\$\{clipped\}`, "warning"\)/,
    "the full text must go through ui.notify");
  assert.match(body, /return false/, "no UI must be reported honestly, not swallowed");
  assert.doesNotMatch(body, /sendMessage/, "sendMessage is queued, not rendered");
  // Nothing in the extension may deliver user-facing text via the follow-up
  // queue: that is the extra-turn trap.
  assert.doesNotMatch(SRC, /deliverAs: "followUp", triggerTurn: false \}\);[\s\S]{0,40}pausedQuestion/,
    "the pause path must never enqueue a follow-up message");
});

test("FLICKER: every confirm dialog goes through the row budget", () => {
  // An oversized ui.confirm makes the dialog taller than the terminal, which
  // pushes the animating spinner row out of the viewport and turns EVERY
  // spinner frame into a full-screen clear (measured: 29 of 30 frames).
  // confirmBounded applies lib/dialog-budget.ts; nothing may bypass it.
  const helperAt = SRC.indexOf("async function confirmBounded");
  assert.ok(helperAt > 0, "confirmBounded must exist");
  assert.match(SRC.slice(helperAt, helperAt + 700), /fitDialogMessage\(/,
    "confirmBounded must apply the budget");

  // The ONLY places `.confirm(` may appear are the helper's own call and its
  // parameter type; every other dialog must call confirmBounded instead.
  const callSites = [...SRC.matchAll(/\.confirm\?\.\(|\.confirm\(/g)].map((m) => m.index ?? 0);
  const helperEnd = SRC.indexOf("\n  }", helperAt);
  const strays = callSites.filter((i) => i < helperAt || i > helperEnd);
  assert.deepEqual(strays, [],
    `every ui.confirm must go through confirmBounded (stray call sites at ${strays.join(", ")})`);
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
  assert.match(body, /confirmBounded\(/);
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

test("gate mode is decided by the agent itself in set_gate_mode — no LLM classifier", () => {
  // The mode is the agent's own pick, bounded by lib/task-mode.ts (tighten
  // only — a first "normal" still needs the user's dialog). No external
  // classifier is consulted for it, and the old input-handler decision flow
  // stays gone. The input handler is CACHE-ONLY (it feeds the user's real
  // first message to the requirement-size hint).
  assert.doesNotMatch(SRC, /decideTaskMode/);
  assert.doesNotMatch(SRC, /classifyTaskMode/,
    "gate mode must not be classified by an LLM");
  assert.doesNotMatch(SRC, /firstDecideAuto/,
    "the LLM-only consent bypass must be gone from the rule-engine call");
  assert.match(SRC, /let effective = requested;/,
    "the agent's requested mode must be the starting point of the decision");
  // The cache-only input capture must never decide anything itself.
  const inputAt = SRC.indexOf('pi.on("input"');
  assert.ok(inputAt >= 0, "first-input capture handler must exist");
  const inputBody = SRC.slice(inputAt, inputAt + 600);
  assert.doesNotMatch(inputBody, /classify|evaluateModeChange|setTaskMode/,
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
  assert.match(region, /confirmBounded\(\s*ctx as unknown as ExtensionContext,\s*MODE_CONFIRM_TITLE,\s*buildModeConfirmMessage\(/);
  const confirmAt = region.indexOf("confirmBounded");
  const userMint = region.indexOf('setTaskMode(effective, "user"');
  assert.ok(userMint > confirmAt, 'source "user" may only be set after the confirm dialog');
  // A declined dialog locks agent-initiated downgrades (anti-grinding).
  assert.match(region, /agentDowngradesLocked = true/);
  // Apply-path modes carry the rule engine's source (always "auto").
  assert.match(region, /setTaskMode\(\w+, decision\.source/);
});

test("USER REQUIREMENT: /tmp first classification clamps via scratchFirstMode; /gate-mode never goes through it", () => {
  // Agent path: /tmp sessions clamp the first verdict and keep piSelfTask true
  // so later agent upgrades to loop are rejected.
  assert.match(SRC, /scratchFirstMode\(/);
  assert.match(SRC, /piSelfTask:\s*piSelf/);
  // setTaskMode must not be able to receive loop on a /tmp first classification
  // even if the classifier block was skipped (session already edited).
  assert.match(SRC, /piSelf && state\.taskMode === undefined && effective === "loop"/);
  assert.match(SRC, /apply immediately except in \/tmp/);
  assert.doesNotMatch(SRC, /Upgrades \(toward loop\) apply immediately;/);
  assert.doesNotMatch(SRC, /ALWAYS user-confirmed/);
  assert.doesNotMatch(SRC, /always user-consented/);
  const README = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.match(README, /scratchFirstMode/);
  // The consent-free entries into normal must be enumerated, and the agent's
  // own first classification must NOT be one of them.
  assert.match(README, /Exactly two entries are consent-free/);
  assert.match(README, /including the agent's own first classification/);
  assert.match(README, /print\/JSON \(no UI\) session/);
  assert.doesNotMatch(README, /ONE exception/);
  assert.doesNotMatch(README, /two consent-free first-classification exceptions/);
  assert.doesNotMatch(SRC, /failed model call falls back to the normal consent rules\. /);
  assert.match(README, /Outside `\/tmp`/);
  assert.doesNotMatch(README, /undecided→loop/);
  assert.match(README, /Print\/JSON mode \(no UI\) cannot render those dialogs/);
  const TASK_MODE = readFileSync(join(ROOT, "lib", "task-mode.ts"), "utf8");
  const PI_SELF = readFileSync(join(ROOT, "lib", "pi-self.ts"), "utf8");
  assert.match(PI_SELF, /Explore still keeps the L1 ship gate/);
  assert.doesNotMatch(PI_SELF, /the gate steps aside there/);
  assert.doesNotMatch(PI_SELF, /Everything under \/tmp is exempt/);
  assert.doesNotMatch(PI_SELF, /gate-exempt/);
  assert.doesNotMatch(README, /user-consented step-aside/);
  assert.doesNotMatch(SRC, /user-consented step-aside/);
  assert.match(TASK_MODE, /print\/JSON no-UI/);
  assert.match(TASK_MODE, /even on a dirty worktree/);
  // Only the HEADLESS normal force skips arming. An interactive normal session
  // still arms, so pre-existing changes stay inside the fence if the user later
  // switches the session to loop via /gate-mode.
  assert.match(SRC, /const headlessNormal = state\.taskMode === "normal" && !ctx\.hasUI;/);
  assert.match(SRC, /!headlessNormal && !state\.hasCodeChange && !state\.hasDocChange && !state\.bypass\.active/);
  assert.doesNotMatch(SRC, /taskMode !== "normal" && !state\.hasCodeChange/,
    "a blanket normal exemption would strand pre-existing changes outside the gate");
  // No user-facing text may still claim an external model decides the mode.
  for (const [name, text] of [["README", README], ["review-gate.ts", SRC], ["task-mode.ts", TASK_MODE]] as const) {
    assert.doesNotMatch(text, /DeepSeek V4 (?:first )?classification/, `${name} still credits a model for the gate mode`);
    assert.doesNotMatch(text, /failed classifier/, `${name} still describes a gate-mode classifier failure path`);
    assert.doesNotMatch(text, /LLM verdict wins/, `${name} still claims an LLM overrides the agent's pick`);
  }
  // /tmp makes NO classifier call at all: it can never reach loop, and the
  // /decompose hint is only ever surfaced under loop.
  assert.match(SRC, /if \(piSelf\) \{[\s\S]{0,600}?effective = scratchFirstMode\(requested\);[\s\S]{0,40}?\} else \{[\s\S]{0,400}?await classifyRequirementSize\(/);
  // The guard layer must document that it deliberately holds NO gate-mode
  // classifier, so a future round does not "restore" one.
  const CLASSIFY = readFileSync(join(ROOT, "lib", "llm-classify.ts"), "utf8");
  assert.match(CLASSIFY, /there is deliberately NO gate-mode classifier here/);
  assert.doesNotMatch(CLASSIFY, /classifyTaskMode/);


  // User path: /gate-mode writes source "user" directly and must not consult
  // evaluateModeChange — that is what lets the user force loop in /tmp.
  const gateModeAt = SRC.indexOf('registerCommand("gate-mode"');
  assert.ok(gateModeAt >= 0, "/gate-mode must exist");
  const gateModeBody = SRC.slice(gateModeAt, SRC.indexOf("registerCommand", gateModeAt + 20));
  assert.doesNotMatch(gateModeBody, /evaluateModeChange/,
    "/gate-mode must not consult the agent rule engine");
  assert.doesNotMatch(gateModeBody, /piSelfTask|scratchFirstMode/,
    "/gate-mode must not apply the /tmp loop ban");
  assert.match(gateModeBody, /setTaskMode\(mode, "user"/);
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
  //   normal — the early return (consent-free first classification, /tmp
  //            clamp, no-UI session_start, or later user consent);
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
  // Both nudge sites are skipped in normal mode (the step-aside must not
  // add extension text to tool results).
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

  assert.match(body, /confirmBounded\(/, "the extension must render the confirm dialog itself");
  assert.doesNotMatch(body, /confirmed\s*:\s*Type\./,
    "no agent-supplied 'confirmed' parameter — that would be self-approval");
  assert.match(body, /if \(!ctx\.hasUI\)/, "no UI must fail closed instead of granting");
  assert.match(body, /dialogFailed/, "a dialog that could not be shown is not a decline");
});

test("SECURITY: request_sensitive_edit refuses .git internals before showing any dialog", () => {
  const start = SRC.indexOf('name: "request_sensitive_edit"');
  const body = SRC.slice(start, start + 6000);
  const integrityAt = body.indexOf("isGateIntegrityPath");
  const confirmAt = body.indexOf("confirmBounded");
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
  assert.match(body, /confirmBounded\(/,
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
  // 7000: the P-multi reset block, no-UI mode forcing, and the normal-mode
  // no-arm comment at the handler head push the notice section past 6000.
  const body = SRC.slice(at, at + 7000);
  assert.match(body, /if \(fingerprintMigrated\)/,
    "an invalidated binding must be explained, not silently applied");
  assert.match(body, /FINGERPRINT_MIGRATION_NOTICE/);
  assert.match(body, /fingerprintMigrated = false/,
    "the flag must be cleared so the notice is not repeated");
});

test("availability is judged by evidence, never by surfaces that cannot see a dropped request", () => {
  // Measured on a repo where GitHub silently drops the request: the CLI exits
  // 0, REST answers 200, and `reviewRequests` is empty on gh JSON, GraphQL and
  // REST alike, with no ReviewRequestedEvent. So none of those can tell
  // "dropped" from "not visible yet" — and the old code used exactly them to
  // declare repos unsupported. They must not come back.
  for (const gone of [
    "probeCopilotActor",
    "copilotRequestLanded",
    "copilotRequestLandedViaRest",
    "COPILOT_ACTOR_QUERY",
    "parseRestReviewRequests",
    "COPILOT_LANDING_RECHECK_DELAY_MS",
  ]) {
    assert.equal(SRC.includes(gone), false, `${gone} was disproven by measurement and must stay gone`);
  }

  const at = SRC.indexOf("const requested = await requestCopilotReviewer(");
  assert.ok(at > 0, "the request path must exist");
  const before = SRC.slice(Math.max(0, at - 900), at);
  assert.match(before, /resolveCopilotSupport\(dir, slug, st, \{ signal \}\)/,
    "availability must be resolved BEFORE a round is spent");

  // The request itself is never vetoed by a read-back any more: whatever the
  // availability verdict, the round is recorded and the wait length is what
  // changes.
  const recordAbs = SRC.indexOf("recordCopilotRequest(st.copilot,", at);
  assert.ok(recordAbs > at, "the request must still be recorded");
  const body = SRC.slice(at, recordAbs);
  assert.doesNotMatch(body, /releaseCopilotReview\(st\.copilot, "UNSUPPORTED",[\s\S]{0,200}land/,
    "a request that 'did not land' must no longer release the requirement");
  assert.match(SRC.slice(recordAbs, recordAbs + 400), /supportConfirmed: support\.confirmed/,
    "confirmed evidence must be remembered in the sidecar");
});

test("the Copilot availability probe fails CLOSED: an unreadable gh answer decides nothing", () => {
  const fn = "probeCopilotHistory";
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
});

test("an abort proves nothing about Copilot: it can never release the requirement", () => {
  // ESC is the user leaving, not GitHub refusing.
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
});

test("a released Copilot cycle still has to report what it left unhandled", () => {
  // Releasing stops the GATE from blocking; it does not make open findings
  // disappear. The user must hear about them.
  assert.ok(SRC.indexOf("function copilotUnhandledText(") > 0,
    "the unhandled-thread reporter must exist");
  assert.ok(SRC.indexOf("function copilotAbandonedText(") > 0,
    "the payload-less paths need their own reporter (they have only the count)");
  const checkAt = SRC.indexOf('name: "check_copilot_review"');
  const checkBody = SRC.slice(checkAt);
  assert.match(checkBody, /copilotUnhandledText\(analysis\.actionable\)/,
    "the released branch of check_copilot_review must list them");

  // The paths that ACTUALLY release with findings open are the fail-safe ones:
  // no PR, no slug, unreadable payload, a refused request, a spent budget.
  // Each of them released in total silence before, even with a sidecar that
  // still recorded open threads. Every `releaseCopilotReview` call in the two
  // tools must be accompanied by the abandoned-findings notice.
  const requestAt = SRC.indexOf('name: "request_copilot_review"');
  const toolsBody = SRC.slice(requestAt, SRC.indexOf('name: "pause_for_question"'));
  const releases = toolsBody.split("releaseCopilotReview(st.copilot,").length - 1;
  const notices = toolsBody.split("copilotAbandonedText(st.copilot)").length - 1;
  assert.ok(releases >= 5, `expected the fail-safe release paths to still exist (got ${releases})`);
  assert.equal(notices, releases,
    "every terminal release in the tools must report the findings it abandons");

  // …and each of them must leave an audit trail: this whole diagnosis had to
  // be reconstructed from GitHub's API because the sidecar transitions were
  // never logged.
  assert.ok((toolsBody.match(/log\(`copilot /g) ?? []).length >= releases,
    "each Copilot state transition must be written to the audit log");
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

// ---------------------------------------------------------------------------
// Precommit lanes + incremental review — structural invariants
// ---------------------------------------------------------------------------

test("publishing paths require a full precommit run; a commit does not", () => {
  // The split has to be applied at BOTH decision points. A missing
  // `requireFullTests` on either would let a narrowed run publish.
  assert.match(SRC, /requiresFullPrecommit/, "the ship gate must consult the lane rule");
  const shipAt = SRC.indexOf("const requireFullTests = ships.some(");
  assert.ok(shipAt > 0, "the ship path must derive the lane requirement from the detected commands");

  // declare_done publishes by implication, so it hardcodes the strict side.
  const doneAt = SRC.indexOf('name: "declare_done"');
  assert.ok(doneAt > 0);
  const doneBody = SRC.slice(doneAt, doneAt + 4000);
  assert.match(doneBody, /requireFullTests:\s*true/, "declare_done must demand a full run");
});

test("the incremental baseline records only what the review actually covered", () => {
  // Under a user-granted scope limit the review only read the session's own
  // files; recording the whole branch diff would later let the scoper call
  // never-reviewed files "already reviewed" and skip escalating to full.
  const at = SRC.indexOf("st.lastReadyReview = {");
  assert.ok(at > 0, "record_review must set the baseline");
  const before = SRC.slice(at - 900, at);
  assert.match(before, /st\.scopeLimit\s*\n?\s*\?\s*st\.scopeLimit\.sessionFiles/,
    "a scope-limited review must record sessionFiles, not the whole branch diff");
});

test("the baseline is written only for a READY verdict", () => {
  // A BLOCKED round must not move the baseline — nothing was approved.
  const at = SRC.indexOf("st.lastReadyReview = {");
  const guard = SRC.slice(SRC.lastIndexOf('parsed.verdict === "READY"', at), at);
  assert.ok(guard.length > 0 && guard.length < 900, "the baseline write must sit inside a READY guard");
});

test("timings are appended, never read back into a decision", () => {
  // The observability log is diagnostics-only. `readTimings`/`lastPrecommitTiming`
  // may only feed the status command's rendering.
  const statusAt = SRC.indexOf('pi.registerCommand("gate-status"');
  assert.ok(statusAt > 0);
  const readAt = SRC.indexOf("lastPrecommitTiming(");
  assert.ok(readAt > statusAt, "the only timings read must be inside /gate-status");
  assert.ok(!/unmetRequirements\([^)]*Timing/.test(SRC), "no timing value may enter the ship authority");
});
