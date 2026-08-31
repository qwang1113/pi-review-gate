import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "extensions", "review-gate.ts"), "utf8");
/**
 * The judge tools that observe/end a session moved to lib/ (they are wired
 * from the extension, not written in it). Their structural rules did not
 * move with them — they are asserted here, against the module that now owns
 * them, so a rule cannot quietly disappear along with the code it covers.
 */
const JUDGE_TOOLS_SRC = readFileSync(join(ROOT, "lib", "judge-session-tools.ts"), "utf8");
const JUDGE_SESSION_TOOLS = new Set(["judge_read", "judge_close", "judge_wait"]);
/**
 * The other half of the same family: the tools that RELAY to a judge session
 * (a round, a follow-up, a completion watcher) are DELETED (2026-08-30,
 * philosophy three): `judge_submit` dispatches a round and registers its own
 * completion watcher, so `review_spawn` / `review_watch` / `review_send` were
 * purely a second way to ask for the same thing. Their absence is asserted
 * below rather than their behavior.
 */

/**
 * The PREPARE family moved the same way, split by responsibility: the round a
 * reviewer judges (a commit range, a findings stream, a review target) in one
 * module, the two advisory task builders in the other.
 */
const REVIEW_PREPARE_SRC = readFileSync(join(ROOT, "lib", "review-prepare-tools.ts"), "utf8");
const REVIEW_PREPARE_TOOLS = new Set(["prepare_review"]);
const ADVISORY_PREPARE_SRC = readFileSync(join(ROOT, "lib", "advisory-prepare-tools.ts"), "utf8");
const ADVISORY_PREPARE_TOOLS = new Set(["prepare_adviser", "prepare_goal_audit"]);
/**
 * The L7 Copilot family moved next, split the same way: the two tools that
 * drive the post-PR review loop in one module, and the `gh` access they run on
 * in another. The tools reach that access through an injected seam, so a rule
 * about a gh CALL is asserted against the module that owns the call, and a
 * rule about what a TOOL does against the module that owns the tool.
 */
const COPILOT_TOOLS_SRC = readFileSync(join(ROOT, "lib", "copilot-review-tools.ts"), "utf8");
const COPILOT_TOOLS = new Set(["request_copilot_review", "check_copilot_review"]);
const COPILOT_GH_SRC = readFileSync(join(ROOT, "lib", "copilot-gh.ts"), "utf8");
/**
 * The USER-INTERACTION family moved the same way, split by responsibility:
 * the interview (`ask_user`) in one module, the two tools that ask the user
 * to RELAX the gate in the other. lib/user-interaction-tools.ts is the
 * family's single registration entry point — it registers `ask_user` and
 * calls the consent module itself — so the extension wires all three exactly
 * once. Their structural rules did not move with them: they are asserted
 * here, against the module that now owns each one.
 */
const ASK_USER_SRC = readFileSync(join(ROOT, "lib", "user-interaction-tools.ts"), "utf8");
const ASK_USER_TOOLS = new Set(["ask_user"]);
const CONSENT_SRC = readFileSync(join(ROOT, "lib", "consent-request-tools.ts"), "utf8");
const CONSENT_TOOLS = new Set(["request_scope_limit", "request_sensitive_edit"]);
/**
 * The GOAL family moved the same way, split by the same rule: the APPROVAL
 * (`propose_loop_goal` — run the audit, ask the user, write the file) in one
 * module, the AUDIT RECORD (`record_goal_prereview` — read the auditor's
 * fence, adjudicate it, persist it) plus the checks both tools share in the
 * other. lib/goal-tools.ts is the family's single registration entry point —
 * it registers BOTH tools, each on the host that may see it — so the
 * extension wires them exactly once. Their structural rules did not move with
 * them: they are asserted below against the module that now owns each one.
 */
const GOAL_TOOLS_SRC = readFileSync(join(ROOT, "lib", "goal-tools.ts"), "utf8");
const GOAL_TOOLS = new Set(["propose_loop_goal", "record_goal_prereview"]);
const GOAL_PREREVIEW_SRC = readFileSync(join(ROOT, "lib", "goal-prereview-tools.ts"), "utf8");
/**
 * The COMMAND layer moved the same way, split by the same rule: the commands
 * that READ (the model-chain readout /gate-status embeds, and /gate-doctor)
 * in one module, everything else in the other. lib/gate-command-tools.ts is
 * the layer's single registration entry point — it registers the workflow
 * catalog and the five state/status commands and calls the diagnosis module
 * itself — so the extension wires all of them exactly once. Their structural
 * rules did not move with them: they are asserted below against the module
 * that now owns each one.
 */
const CMD_SRC = readFileSync(join(ROOT, "lib", "gate-command-tools.ts"), "utf8");
const DIAG_SRC = readFileSync(join(ROOT, "lib", "gate-diagnosis-commands.ts"), "utf8");

/**
 * The L1 `tool_call` HOOK moved out too — the first hook to follow the tool
 * families, and the biggest thing that was left in the extension. It is split
 * three ways by responsibility: the dispatch plus the judge-role subagent
 * refusal (lib/ship-gate-hook.ts), the edit/write arm (lib/ship-gate-edit-guard.ts)
 * and the bash ship gate itself (lib/ship-gate-bash.ts). The extension keeps
 * one `pi.on("tool_call", …)` wiring line and the injected deps.
 *
 * Every structural rule that used to be sliced out of the extension's handler
 * is asserted below against the module that now owns the code — the WINDOW
 * moved, the rule did not. `HOOK_BODY` is the concatenation used by the rules
 * that are about the hook AS A WHOLE (mode branches, "the Copilot cycle never
 * reaches L1"), which no single arm can answer on its own; rules about ORDER
 * inside one arm are asserted against that arm alone, because concatenating
 * would let an ordering hold across a module boundary where it means nothing.
 */
const SHIP_HOOK_SRC = readFileSync(join(ROOT, "lib", "ship-gate-hook.ts"), "utf8");
const SHIP_EDIT_SRC = readFileSync(join(ROOT, "lib", "ship-gate-edit-guard.ts"), "utf8");
const SHIP_BASH_SRC = readFileSync(join(ROOT, "lib", "ship-gate-bash.ts"), "utf8");
const HOOK_BODY = [SHIP_HOOK_SRC, SHIP_EDIT_SRC, SHIP_BASH_SRC].join("\n");
/** The extension's wiring of the L1 hook — deps and the one `pi.on` line. */
function shipHookWiring(): string {
  return windowOf(
    "const shipGateHookDeps: ShipGateHookDeps = {",
    "evaluateToolCall(shipGateHookDeps, event, ctx));",
    "L1 hook wiring",
  );
}

/**
 * The body of one registered COMMAND, from its `registerCommand("name"` line
 * to the next registration (or the end of the registering function).
 *
 * The same anchored-window discipline as `windowIn`: a fixed byte count would
 * rot silently as the command grows.
 */
function commandBodyOf(src: string, name: string): string {
  return windowIn(
    src,
    `registerCommand("${name}"`,
    /\n  host\.registerCommand\(|\n\}/,
    `command /${name}`,
  );
}



/** Which source owns a given tool's body. */
function sourceOf(tool: string): string {
  if (JUDGE_SESSION_TOOLS.has(tool)) return JUDGE_TOOLS_SRC;
  if (REVIEW_PREPARE_TOOLS.has(tool)) return REVIEW_PREPARE_SRC;
  if (ADVISORY_PREPARE_TOOLS.has(tool)) return ADVISORY_PREPARE_SRC;
  if (COPILOT_TOOLS.has(tool)) return COPILOT_TOOLS_SRC;
  if (ASK_USER_TOOLS.has(tool)) return ASK_USER_SRC;
  if (CONSENT_TOOLS.has(tool)) return CONSENT_SRC;
  if (GOAL_TOOLS.has(tool)) return GOAL_TOOLS_SRC;
  return SRC;
}

/**
 * The source window from `start` up to the next `end` anchor, with BOTH
 * anchors asserted.
 *
 * A fixed byte window (`SRC.slice(at, at + 900)`) rots silently: the source
 * grows, the window stops reaching the code it was written to cover, and the
 * test keeps passing while asserting nothing. An end ANCHOR cannot rot
 * quietly — when it stops closing the window, this fails and says so.
 */
function windowIn(src: string, start: string, end: string | RegExp, label: string, from = 0): string {
  const at = src.indexOf(start, from);
  assert.ok(at >= 0, `${label}: start anchor ${JSON.stringify(start)} not found`);
  const rest = src.slice(at + start.length);
  const rel = typeof end === "string" ? rest.indexOf(end) : rest.search(end);
  assert.ok(rel >= 0, `${label}: end anchor ${String(end)} no longer closes the window`);
  return src.slice(at, at + start.length + rel);
}

function windowOf(start: string, end: string | RegExp, label: string, from = 0): string {
  return windowIn(SRC, start, end, label, from);
}

/**
 * The same source with every comment removed.
 *
 * For the rules that are about what the gate READS rather than what it says:
 * a docblock naming another module is documentation, and a test that reddened
 * on it would only teach people to reword the comment.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/**
 * A lib/ tool module splits a tool in two: the REGISTRATION (name, label,
 * description, schema) and the HANDLER it dispatches to. A rule about what a
 * tool does would land in neither window alone, so the two are read together.
 */
const LIB_TOOL_HANDLERS: Record<string, string> = {
  judge_read: "async function doRead(",
  judge_close: "async function doClose(",
  judge_wait: "async function doWait(",
  prepare_review: "async function doPrepareReview(",
  prepare_adviser: "async function doPrepareAdviser(",
  prepare_goal_audit: "async function doPrepareGoalAudit(",
  request_copilot_review: "async function doRequestCopilotReview(",
  check_copilot_review: "async function doCheckCopilotReview(",
  ask_user: "export async function doAskUser(",
  request_scope_limit: "export async function doRequestScopeLimit(",
  request_sensitive_edit: "export async function doRequestSensitiveEdit(",
  propose_loop_goal: "export async function doProposeLoopGoal(",
  record_goal_prereview: "export async function doRecordGoalPrereview(",
};

/**
 * The handler of a tool whose REGISTRATION and BODY are in different lib/
 * modules. The goal family is the one that splits that way: lib/goal-tools.ts
 * is the single registration entry point (two tools, two hosts), while the
 * audit record it dispatches to lives in lib/goal-prereview-tools.ts. Naming
 * the source explicitly keeps the "same source" rule intact everywhere else —
 * a tool can still never be matched against another module's handler by
 * accident.
 */
const LIB_HANDLER_SOURCES: Record<string, string> = {
  record_goal_prereview: GOAL_PREREVIEW_SRC,
};


/**
 * The body of one registered tool: from its `name:` line to the next one,
 * plus — for a lib/ tool module — the handler that registration points at.
 *
 * Registration reads `pi.registerTool` in the extension and `host.registerTool`
 * in a lib/ tool module; the last tool of a module is closed by the end of
 * its registration function (`\n}`). The handler is read from the SAME source
 * as the registration unless LIB_HANDLER_SOURCES names another one, so a tool
 * cannot be matched against another module's handler of the same name.
 */
function toolBodyOf(tool: string): string {
  const src = sourceOf(tool);
  const registration = windowIn(
    src,
    `name: "${tool}"`,
    /\n  pi\.registerTool\(\{|\n  host\.registerTool\(\{|\n  \/\/ -{4,}|\n\}/,
    `tool ${tool}`,
  );
  const handler = LIB_TOOL_HANDLERS[tool];
  if (!handler) return registration;
  const handlerSrc = LIB_HANDLER_SOURCES[tool] ?? src;
  return `${registration}\n${windowIn(handlerSrc, handler, "\n}", `handler of ${tool}`)}`;
}

/** The extension's wiring of the judge session tools — deps, nothing else. */
function judgeToolsWiring(): string {
  return windowOf("registerJudgeSessionTools(pi, {", "\n  });", "judge tools wiring");
}

/**
 * THE TEN ADVANCED ENTRIES ARE NOT REGISTERED (2026-08-30, philosophy three).
 *
 * Seven of them still EXIST as implementations, captured into `internalHost`
 * so `judge_submit` and `propose_loop_goal` call the ONE copy of each
 * mechanical check; the other three were deleted outright. What must be true
 * either way is that `pi` never learns the names — an agent that can see a
 * step can be tempted to sequence the steps by hand, which is the whole cost
 * philosophy two is about.
 */
const DELETED_TOOL_ENTRIES = [
  "run_precommit", "review_checkpoint", "prepare_review", "prepare_adviser",
  "prepare_goal_audit", "record_review", "record_goal_prereview",
  "review_spawn", "review_watch", "review_send",
];


/** The extension's wiring of `prepare_review` — deps, nothing else. */
function REVIEW_PREPARE_WIRING(): string {
  return windowOf("registerReviewPrepareTools(internalHost, {", "\n  });", "review prepare tools wiring");
}

/** The extension's wiring of the two advisory prepare tools — deps, nothing else. */
function ADVISORY_WIRING(): string {
  return windowOf("registerAdvisoryPrepareTools(internalHost, {", "\n  });", "advisory prepare tools wiring");
}

/** The extension's wiring of the two Copilot review tools — deps, nothing else. */
function COPILOT_WIRING(): string {
  return windowOf("registerCopilotReviewTools(pi, {", "\n  });", "copilot review tools wiring");
}

/**
 * The extension's wiring of the goal family — deps, nothing else.
 *
 * TWO hosts here, unlike every other family: the agent-visible
 * `propose_loop_goal` goes to `pi`, the internal `record_goal_prereview` to
 * the capture-only `internalHost`. The start anchor pins exactly that.
 */
function GOAL_WIRING(): string {
  return windowOf(
    "registerGoalTools({ agent: pi, internal: internalHost }, {",
    "\n  });",
    "goal tools wiring",
  );
}

test("loop goal: injected ONLY in loop mode, before the unarmed early-return", () => {
  // The Step 0 directive has to reach the agent while the worktree is still
  // clean (that is the whole point — set the exit contract BEFORE editing), so
  // it must sit after the explore early-return and before the
  // `!gateArmed && problems.length === 0` early-return.
  assert.match(SRC, /from "\.\.\/lib\/loop-goal\.ts"/);
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
  // The unarmed early-return was REMOVED 2026-08-30: the loop directives (goal +
  // decision table) must reach the FIRST turn before any edit arms the gate.
  assert.ok(exploreReturnAt > 0, "explore early-return must exist");
  assert.doesNotMatch(SRC, /if \(!gateArmed && problems\.length === 0\)/,
    "unarmed early-return removed: loop directives inject on every turn");
  assert.ok(exploreReturnAt < injectAt, "explore must return before the loop-goal injection");
  // Guarded on loop mode only (explore/normal never see it).
  const guard = SRC.slice(injectAt - 200, injectAt);
  assert.match(guard, /state\.taskMode === "loop"/);
});

test("loop goal: set_gate_mode(loop) delivers Step 0 in the same turn it decides", () => {
  // before_agent_start only injects on the NEXT turn, and the mode is decided
  // as the session's first action — without this the agent could edit for a
  // whole turn before ever seeing the exit contract.
  const handlerAt = SRC.indexOf('pi.on("before_agent_start"');
  const toolInjectAt = SRC.indexOf("buildLoopGoalDirective(readSessionLoopGoal(");

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
  // The ship block itself lives in the L1 bash arm (lib/ship-gate-bash.ts).
  assert.match(SHIP_BASH_SRC, /LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK/);
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
  assert.match(SRC, /from "\.\.\/lib\/blocked-marker\.ts"/);

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
  // this session" hint and force consent for a later mode change. The edit arm
  // now lives in lib/ship-gate-edit-guard.ts — the ordering is asserted there.
  const callSkipAt = SHIP_EDIT_SRC.indexOf("isGateOwnedPath(abs,");
  const sessionEditAt = SHIP_EDIT_SRC.indexOf("deps.markSessionEdited()");
  assert.ok(callSkipAt > 0 && sessionEditAt > 0, "the edit arm must apply the same skip");
  assert.ok(callSkipAt < sessionEditAt, "the skip must precede the session-edit attribution");
  assert.match(SHIP_EDIT_SRC.slice(callSkipAt, callSkipAt + 160), /return undefined;/,
    "the skip must return, not fall through");
  // …and the extension may no longer set the flag itself: it is a dep now, so
  // a second copy of the attribution cannot drift back in.
  assert.match(shipHookWiring(), /markSessionEdited: \(\) => \{ sessionEdited = true; \}/,
    "the session-edit attribution reaches the arm through the injected dep");
});

test("extension imports from local lib/ (single source of truth)", () => {
  assert.ok(SRC.includes('../lib/constants.ts'), "should import from ../lib/constants.ts (package-root lib/)");
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
  // The extension WIRES the hook; lib/ship-gate-hook.ts is what decides.
  assert.match(SRC, /pi\.on\(["']tool_call["'], \(event, ctx\) => evaluateToolCall\(shipGateHookDeps, event, ctx\)\)/,
    "the extension keeps exactly the wiring line");
  assert.match(SHIP_HOOK_SRC, /export async function evaluateToolCall\(/);
  assert.match(HOOK_BODY, /block:\s*true/);
  assert.match(SHIP_BASH_SRC, /detectShipCommands/);
});

test("L2: agent_settled auto-continuation with recursion guard", () => {
  assert.match(SRC, /pi\.on\(["']agent_settled["']/);
  assert.match(SRC, /state\.taskMode === "explore"/);
  assert.match(SRC, /continuationsInjected/);
  assert.match(SRC, /REVIEW_GATE_RESUME/);
});

test("L2 STALL BREAKER: no-progress circuit breaker precedes every continuation injection", () => {
  // REGRESSION: when the judge provider ran out of quota, seven consecutive
  // continuations fired ("4/10 … 10/10") while nothing could change, burning
  // the whole budget on an external blocker the agent could not fix.
  const start = SRC.indexOf('pi.on("agent_settled"');
  assert.ok(start >= 0, "agent_settled handler must exist");
  const injectAt = SRC.indexOf("REVIEW_GATE_RESUME", start);
  const breakerAt = SRC.indexOf("evaluateStall(", start);
  const bumpAt = SRC.indexOf("continuationsInjected += 1", start);
  assert.ok(breakerAt > 0, "the stall breaker must run in agent_settled");
  assert.ok(breakerAt < bumpAt, "the breaker must precede the budget increment");
  assert.ok(breakerAt < injectAt, "the breaker must precede the RESUME injection");
  // It may only STOP the loop talking to itself — never grant a verdict.
  const body = SRC.slice(breakerAt, injectAt);
  assert.doesNotMatch(body, /verdict\s*=\s*"(READY|PASS)"/, "the breaker must never grant a verdict");
  assert.doesNotMatch(body, /bypass\.active\s*=\s*true/, "the breaker must never open the ship gate");
  assert.match(body, /buildStallNotice\(/, "the user must be told why the loop stopped");
  // Real progress must re-arm it: every reset site clears the stall state.
  const clears = SRC.match(/loopStall = undefined/g) ?? [];
  assert.ok(clears.length >= 3, `stall state must be cleared at every progress site (found ${clears.length})`);
});

test("L2 STALL BREAKER: a running judge child counts as motion (never orphan a live review)", () => {
  // Without this, the breaker trips on the loop's OWN review: while an async
  // reviewer runs, the fingerprint, both verdicts, the round count and the
  // unmet list are all necessarily unchanged.
  const start = SRC.indexOf('pi.on("agent_settled"');
  const breakerAt = SRC.indexOf("evaluateStall(", start);
  const injectAt = SRC.indexOf("REVIEW_GATE_RESUME", start);
  const call = SRC.slice(breakerAt, injectAt);
  assert.match(call, /inMotion:\s*judgeChildInMotion\(\)/,
    "the breaker must be told about judge work in flight");
  // The motion probe must be bounded in age, or a hung run would disable the
  // breaker permanently — the exact failure it exists to catch.
  const judgeProbe = windowOf("function judgeChildInMotion(", "\n  }", "judgeChildInMotion");
  assert.match(judgeProbe, /STALL_MOTION_MAX_AGE_SEC/, "judge-child motion credit must expire with age");
  assert.match(judgeProbe, /Date\.parse\(c\.spawnedAt\)/, "freshness is measured from the spawn timestamp");
  assert.match(judgeProbe, /Number\.isFinite/, "an unparseable spawnedAt must fail closed (no motion)");
});



test("corrupt config layer keeps the last render — BOTH layers, fail-safe (round-12 P1)", () => {
  // Goal criterion 3: a corrupt/malformed `agents` section in EITHER layer must
  // keep the last rendered chains. Round-12 P1 mutation: turning both guards
  // into `if (false)` kept the WHOLE suite green — the consumer of
  // agentsGlobalCorrupt / agentsProjectCorrupt had no coverage at all
  // (test/project-config.test.ts only proves the flags are SET), so the
  // restoreDefault sweep could silently clobber a valid render.
  const layersAt = SRC.indexOf("function ensureModelLayersRendered(");
  assert.ok(layersAt > 0, "ensureModelLayersRendered must exist");
  const layers = SRC.slice(layersAt, layersAt + 6500);
  // Each guard must read the PARSED flag (an `if (false)` / inlined re-parse
  // no longer matches) and must SKIP its own render via the else branch —
  // falling through to applyAgentConfigLayer is exactly the clobber.
  assert.match(
    layers,
    /if \(projectConfig\.agentsGlobalCorrupt\) \{[\s\S]{0,400}?\} else \{[\s\S]{0,900}?applyAgentConfigLayer\(/,
    "a corrupt GLOBAL layer must skip its render, not fall through to applyAgentConfigLayer",
  );
  assert.match(
    layers,
    // The project branch carries the cross-layer reviewer-readonly guard
    // between the `else` and its render call, hence the wider window.
    /if \(projectConfig\.agentsProjectCorrupt\) \{[\s\S]{0,400}?\} else \{[\s\S]{0,5000}?applyAgentConfigLayer\(/,
    "a corrupt PROJECT layer must skip its render, not fall through to applyAgentConfigLayer",
  );
  // The user must SEE the fail-safe (both messages feed the bounded notify).
  assert.match(layers, /global: ~\/\.pi\/review-gate\.json is corrupt/, "the global fail-safe must be reported");
  assert.match(layers, /project: \.pi\/review-gate\.json is corrupt/, "the project fail-safe must be reported");
  // Goal criterion 5: strings added by this change are English.
  assert.doesNotMatch(layers, /[\u4e00-\u9fff]/, "the model-config layer must not add non-English diagnostics");
});

test("WIDGET: the model-config block is gone from the belowEditor strip", () => {
  // The strip is deliberately minimal — mode/branch/edited + unmet count.
  assert.doesNotMatch(SRC, /modelConfigWidgetLines/, "the widget must not build model-config lines anymore");
  assert.doesNotMatch(SRC, /buildModelConfigWidget/, "the model-config widget builder must be gone");
  const body = windowOf("function updateWidget(", "\n  }", "updateWidget");
  assert.match(body, /buildGateWidget\(gateWidgetFacts\(\)\)/, "the strip comes from the single gate facts");
  assert.match(body, /ctx\.ui\.setWidget\("review-gate-agents"/, "the strip still renders through setWidget");
});

test("MODEL DIAGNOSIS: project outranks global, registry auth gates, disk fallback", () => {
  // round-1 P2: the rewritten modelDiagnosisLines had no coverage either.
  const fn = windowIn(DIAG_SRC, "export function modelDiagnosisLines(", "\n}", "modelDiagnosisLines");
  assert.match(fn, /deps\.findProjectAgentText\(projectAgentsDir, name\)/, "effective chain = project file first (by identity)");
  assert.match(fn, /hasConfiguredAuth/, "registry auth must gate the authed set");
  assert.match(fn, /models-store\.json/, "disk fallback reads the provider store");
  assert.match(fn, /auth\.json/, "disk fallback reads auth");
});

test("GLOBAL LAYER: the extension re-applies model config (both layers) at session start", () => {
  // Publish-path fallback for exit criterion 2: scripts/install-package.mjs
  // cannot import the TS module under node_modules, so the extension must own
  // the layer render — and must do so for BOTH layers (global AND the current
  // repo's project layer, which outranks global), EVEN when the `agents`
  // section is absent, to sweep stale generated overrides after the user
  // deletes it.
  const at = SRC.indexOf("function ensureModelLayersRendered(");
  assert.ok(at > 0, "ensureModelLayersRendered must exist (renamed from ensureGlobalModelLayerRendered)");
  assert.ok(SRC.indexOf("ensureGlobalModelLayerRendered") === -1, "the old name must be gone");
  // Slice to the function's REAL end (the next top-level `function ` at the
  // same indentation), not a guessed byte count: a fixed window that stops
  // short lets a second probe call hide in the tail and defeats the
  // "called exactly once" assertion below.
  const fnEnd = SRC.indexOf("\n  function ", at + 1);
  assert.ok(fnEnd > at, "the next function declaration must bound the window");
  const fn = SRC.slice(at, fnEnd);
  assert.match(fn, /effectiveAgentsConfig\(projectConfig\.agentsGlobal \?\? undefined, undefined\)/);
  assert.match(fn, /effectiveAgentsConfig\(undefined, projectConfig\.agentsProject \?\? undefined\)/);
  assert.match(fn, /applyAgentConfigLayer\(/);
  assert.match(fn, /pathJoin\(primaryRepoRoot, "\.pi", "agents"\)/);
  // BOOTSTRAP SELF-HEAL: a role the gate REQUIRES (goal-auditor gates every
  // goal approval) must be restored when it is missing, or the session
  // deadlocks with no exit but switching the gate off. The source dir is
  // PROBED, never a single relative path — an unresolvable source makes the
  // heal a silent no-op, which is how the deadlock survived review twice.
  assert.match(fn, /ensureAgentFilesPresent\(\{/, "session start must self-heal missing agent files");
  assert.match(fn, /sourceDir: existsSync\(packageAgentsDir\) \? packageAgentsDir : null/, "the heal source must be the PROBED package agents dir");
  assert.match(fn, /agents: KNOWN_AGENTS/, "the heal covers every shipped role, not just goal-auditor");
  // ONE probe, shared by the renderer and the heal: two independent calls with
  // different null handling let the render succeed while the heal silently
  // no-ops (or vice versa) — the failure mode this whole guard exists for.
  assert.match(fn, /const probedAgentsDir = resolvePackageAgentsDir\(\);/, "the probe runs once");
  assert.match(fn, /const packageAgentsDir = probedAgentsDir \?\?/, "and both consumers share its result");
  assert.equal((fn.match(/resolvePackageAgentsDir\(\)/g) ?? []).length, 1, "the probe must not be called twice");
  const sessionAt = SRC.indexOf("pi.on(\"session_start\"");
  assert.ok(sessionAt > 0);
  // The call sits a few thousand chars past the handler head, so the window
  // must be wide enough to cover it (round-2 P1: deleting the assertion
  // instead of widening the window left the guard dead).
  const body = SRC.slice(sessionAt, sessionAt + 4600);
  assert.match(body, /ensureModelLayersRendered\(ctx\)/, "must be invoked at session start with the UI context");
  // Project-layer base must be the BUILT-IN package agents dir, never the
  // already-rendered global layer. Scope BOTH asserts to the PROJECT block
  // (round-9 P2: the old window was 800 chars while the sourceDir line sits
  // ~3400 chars past the block comment — the mutation sailed through). The
  // window below is sized from that measured offset, so keep it comfortably
  // ahead of the line it must cover.
  const layerBlock = SRC.slice(at, at + 9000);
  const projStart = layerBlock.indexOf("// Project layer of the CURRENT repo");
  assert.ok(projStart > 0, "the project-layer block must be inside the window");
  // To the END of the layer block, not a byte count: the asserted sourceDir
  // line sits ~3415 chars in, so a fixed 3500-char window left ~50 chars of
  // slack and would fail for the wrong reason after any small edit here.
  const projectBlock = layerBlock.slice(projStart);
  assert.match(
    projectBlock,
    /sourceDir: packageAgentsDir/,
    "the project sourceDir must be the built-in defaults (the PROBED package agents dir)",
  );
  assert.doesNotMatch(
    projectBlock,
    /sourceDir: pathJoin\(homedir\(/,
    "the global rendered dir must never be the project source",
  );
});

test("INCREMENTAL: the settled conclusion of the previous round is handed to the reviewer", () => {
  // A re-review that starts from zero pays full price for questions already
  // answered. The gate must state what the last READY verdict settled.
  const at = SRC.indexOf("formatReviewScopeDirective(reviewScopeFor(");
  assert.ok(at > 0, "the scope directive must be injected");
  assert.match(
    SRC.slice(at, at + 240),
    /settledConclusion\(state\)/,
    "the previous conclusion must travel with the scope block",
  );
  const fn = windowOf("function settledConclusion(", "\n  }", "settledConclusion");
  assert.match(fn, /lastReadyReview/, "only an APPROVED tree has settled anything");
  assert.match(fn, /if \(!base\) return undefined/, "no approved review ⇒ nothing is settled");
});

test("L2 ORDER: explore check precedes loopArmed in agent_settled (explore edits arm the loop flag)", () => {
  // Explore-mode edits set loopArmed = true in tool_result; only the explore
  // early-return keeps auto-continuation off. If someone reorders the checks,
  // explore would silently regain forced continuation.
  const start = SRC.indexOf('pi.on("agent_settled"');
  assert.ok(start >= 0, "agent_settled handler must exist");
  const body = SRC.slice(start, start + 1400);
  const exploreAt = body.indexOf('state.taskMode === "explore"');
  const loopArmedAt = body.indexOf("!loopArmed");
  assert.ok(exploreAt >= 0 && loopArmedAt >= 0, "both checks must exist");
  assert.ok(exploreAt < loopArmedAt, "explore early-return must precede the loopArmed check");
});

test("ask_user is the ONE way to reach the user, and pause_for_question is gone", () => {
  assert.match(ASK_USER_SRC, /name: "ask_user"/);
  assert.doesNotMatch(SRC, /name: "pause_for_question"/,
    "the second asking entry point must not come back");
  assert.doesNotMatch(ASK_USER_SRC, /name: "pause_for_question"/,
    "…and it must not reappear in the module that now owns the asking tool");
  // ONE registration call wires the whole family; the extension registers
  // none of the three itself any more.
  assert.match(SRC, /registerUserInteractionTools\(pi, \{/,
    "the extension wires the family exactly once");
  assert.doesNotMatch(SRC, /name: "ask_user"/,
    "the tool body moved to lib/ — a second registration here would be a second path");
  const toolBody = toolBodyOf("ask_user");
  // Calling it PAUSES when anything is left unanswered, and the pause persists
  // (it must survive a restart while the user is away).
  assert.match(toolBody, /const pending = needsUserReply\(answers\)/);
  assert.match(toolBody, /state\.pausedQuestion = \{/);
  assert.match(toolBody, /deps\.setLoopArmed\(false\)/);
  assert.match(toolBody, /deps\.persist\(/);
  // The pause is written into the EXTENSION's own state object, not a copy:
  // several handlers there clear `pausedQuestion`, and a captured/duplicated
  // state would let the tool pause a session nobody can un-pause.
  assert.match(toolBody, /const state = deps\.state\(\);/,
    "the gate state is read through the injected getter, per call");
  assert.match(windowOf("registerUserInteractionTools(pi, {", "\n  });", "user-interaction wiring"),
    /state: \(\) => state,/, "and the extension hands over its LIVE state, not a snapshot");
  // …but it must NEVER touch the ship authority: unmetRequirements takes no
  // pause input, and no call site filters its problems on pausedQuestion.
  assert.doesNotMatch(SRC, /unmetRequirements\([^)]*pausedQuestion/);
});

test("ask_user: the QUESTIONS reach the user, and silence is never an answer", () => {
  // REGRESSION this inherits: a question used to be written to
  // `state.pausedQuestion` and nowhere else, while the tool result told the
  // agent it had been "delivered to the user verbatim" — the user saw a
  // warning with no question in it.
  const toolBody = toolBodyOf("ask_user");
  assert.match(toolBody, /deps\.showToUser\(uiCtx, "───── AI 有问题要问你 ─────"/,
    "the questions themselves are shown, not just filed");
  // The interview: one dialog per question, with its N / M progress.
  assert.match(toolBody, /progressLabel\(index, questions\.length\)/);
  assert.match(toolBody, /uiCtx\.ui!\.select!\(/, "options ⇒ a choice dialog");
  assert.match(toolBody, /uiCtx\.ui!\.input!\(/, "no options ⇒ free text");
  // Both go through the channel funnel, so an orchestration child's project
  // manager can answer the same question the human can (2026-08-30) — and
  // whichever of them answers first takes the box off the other's screen.
  assert.match(toolBody, /deps\.askEitherSide\(/, "every gate question is answerable by EITHER side");
  assert.match(toolBody, /topic: "ask-user"/, "the request is LABELLED by the gate that raised it");

  // A dismissed dialog or a broken UI is NOT consent: it becomes an
  // unanswered question, which pauses the loop.
  assert.match(toolBody, /picked = undefined; \/\/ a broken dialog is silence, never an answer/);
  assert.match(toolBody, /kind: "deferred-to-chat"/);
  // The answers come back in one piece, unanswered ones marked.
  assert.match(toolBody, /formatAnswers\(answers\)/);
  assert.doesNotMatch(toolBody, /ALREADY been delivered to the user verbatim/,
    "never claim delivery that did not happen");
  // Progress is persisted after EVERY question, so an interview that dies
  // mid-way resumes instead of asking the user everything again.
  assert.match(toolBody, /resumeFrom\(state\.askUser, questions\)/, "an interrupted interview resumes");
  assert.match(toolBody, /state\.askUser = \{ at: new Date\(\)\.toISOString\(\), answers: \[\.\.\.answers\] \};[\s\S]{0,120}deps\.persist\(/,
    "each answer is persisted as it arrives");
  // NO UI at all (print / json / headless RPC): pi's no-op UI still HAS a
  // notify, so "did notify exist?" proves nothing — `hasUI` is the
  // discriminator, and the questions go back to the agent unasked.
  assert.match(toolBody, /if \(uiCtx\.hasUI !== true\) \{/, "headless is detected by hasUI");
  assert.doesNotMatch(toolBody, /!anyDialog && !shown/,
    "a notify-based headless probe must not come back");
  // A UI that rendered nothing (every dialog dismissed / refused) is the same
  // fact from the other side.
  assert.match(toolBody, /if \(!anyDialog\) \{/, "an interview nobody answered is reported as such");
  assert.match(toolBody, /buildNoDialogNotice\(questions\)/, "and hands the questions back to the agent");
});



test("showToUser renders SYNCHRONOUSLY — sendMessage would queue it and buy an extra turn", () => {
  // pi.sendMessage inside a tool is queued, not rendered: with
  // deliverAs:"followUp" agent-loop drains the queue when the agent would
  // STOP, silently buying another LLM turn — fatal for a tool whose job is to
  // PAUSE the loop, and it shows the user nothing until the turn ends anyway.
  // ui.notify appends to the chat container and requests a render right away.
  const body = windowOf("function showToUser", "\n  }", "showToUser");
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
  assert.match(windowOf("async function confirmBounded", "\n  }", "confirmBounded"), /fitDialogMessage\(/,
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

test("RESUME text: the unmet-gates branch points a waiting agent at ask_user", () => {
  // An agent that needs the user but has not asked yet gets the
  // auto-continuation. The resume text must name the tool that asks AND
  // pauses, or the follow-up just steers it back into working blind (live
  // regression: agent asked "决策 3 of 3" in prose, RESUME said only
  // "Continue: fix → re-review …").
  const start = SRC.indexOf('pi.on("agent_settled"');
  const end = SRC.indexOf("// ---------- lifecycle ----------", start);
  const body = SRC.slice(start, end);
  assert.match(body, /problems\.length > 0[\s\S]{0,800}?ask_user/s,
    "unmet-gates resume must point at ask_user when the agent needs the user");
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
  assert.match(CONSENT_SRC, /name: "request_scope_limit"/, "request_scope_limit tool must be registered");
  const body = toolBodyOf("request_scope_limit");
  // Consent is obtained by the EXTENSION (dialog) — the tool schema exposes
  // only a reason; there is no parameter the model could set to claim consent.
  assert.match(body, /deps\.confirmBounded\(/);
  assert.match(body, /parameters: Type\.Object\(\{\s*reason: Type\.String/);
  assert.doesNotMatch(body, /confirmed/);
  // No UI ⇒ fail-closed deny; a declined dialog locks further requests — but
  // a dialog that could not be SHOWN fails closed without burning the lock.
  assert.match(body, /hasUI/);
  assert.match(body, /deps\.declineScopeLimit\(\)/);
  // …and the lock is the EXTENSION's session flag, set through that seam.
  assert.match(windowOf("registerUserInteractionTools(pi, {", "\n  });", "user-interaction wiring"),
    /declineScopeLimit: \(\) => \{ scopeLimitDeclined = true; \}/,
    "the decline must land on the session lock the gate actually reads");
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
  const body = toolBodyOf("request_scope_limit");
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
  // …set from the L1 edit arm through the injected markSessionEdited dep.
  assert.match(shipHookWiring(), /markSessionEdited: \(\) => \{ sessionEdited = true; \}/);
  // The tool must delegate to the pure, unit-tested rule engine and inject
  // the undecided directive from the same module.
  assert.match(SRC, /evaluateModeChange\(\{/);
  assert.match(SRC, /GATE_MODE_DECISION_DIRECTIVE/);
  // The USER-invoked path lives in the command module now (the extension only
  // wires it), so the command's existence is asserted against that module.
  assert.match(CMD_SRC, /registerCommand\(["']gate-mode["']/);
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
  // Criterion 3: every set_gate_mode return path reports the change to the
  // supervisor as mode-changed (setTaskMode's apply path + noop + declined
  // + rejected). Stripping any one of them must turn this red.
  const modeChangedHits = SRC.match(/reportChildState\([^)]*state: "mode-changed"/g) ?? [];
  assert.ok(modeChangedHits.length >= 4,
    `expected 4 mode-changed reports (apply/noop/declined/rejected), got ${modeChangedHits.length}`);
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
  // The decompose hint and its requirement-size classifier are gone (2026-08-26);
  // the /tmp clamp (scratchFirstMode) stays.
  assert.match(SRC, /if \(piSelf\) \{[\s\S]{0,600}?effective = scratchFirstMode\(requested\);/);
  // The guard layer must document that it deliberately holds NO gate-mode
  // classifier, so a future round does not "restore" one.
  const CLASSIFY = readFileSync(join(ROOT, "lib", "llm-classify.ts"), "utf8");
  assert.match(CLASSIFY, /there is deliberately NO gate-mode classifier here/);
  assert.doesNotMatch(CLASSIFY, /classifyTaskMode/);


  // User path: /gate-mode writes source "user" directly and must not consult
  // evaluateModeChange — that is what lets the user force loop in /tmp.
  const gateModeBody = commandBodyOf(CMD_SRC, "gate-mode");
  assert.doesNotMatch(gateModeBody, /evaluateModeChange/,
    "/gate-mode must not consult the agent rule engine");
  assert.doesNotMatch(gateModeBody, /piSelfTask|scratchFirstMode/,
    "/gate-mode must not apply the /tmp loop ban");
  assert.match(gateModeBody, /setTaskMode\(mode, "user"/);
});

test("the downgrade lock is cleared ONLY by user actions (/gate-mode, gate-reset)", () => {
  // Both commands moved to lib/gate-command-tools.ts, but the flag itself is
  // an extension binding, so the two CLEAR SITES are still in the extension:
  // the `unlockAgentDowngrades` seam /gate-mode reaches through, and the
  // per-session reset /gate-reset reaches through. A third assignment
  // anywhere would be a non-user path and fails here.
  // (the `let … = false` declaration is excluded — only assignment sites count)
  const clears = [...SRC.matchAll(/(?<!let )agentDowngradesLocked = false/g)].map((m) => m.index!);
  assert.equal(clears.length, 2, "exactly two clear sites: the unlock seam and the session reset");
  const unlockAt = SRC.indexOf("unlockAgentDowngrades: () =>");
  const resetFnAt = SRC.indexOf("function resetSessionState(");
  assert.ok(unlockAt > 0, "the unlock seam must exist");
  assert.ok(resetFnAt > 0, "resetSessionState must exist");
  assert.ok(clears.some((i) => i > unlockAt && i < unlockAt + 200), "the unlock seam must clear the lock");
  assert.ok(clears.some((i) => i > resetFnAt && i < resetFnAt + 1500), "the session reset must clear the lock");
  // And only the two USER commands reach those seams.
  assert.match(commandBodyOf(CMD_SRC, "gate-mode"), /deps\.unlockAgentDowngrades\(\)/,
    "/gate-mode must clear the lock");
  assert.match(commandBodyOf(CMD_SRC, "gate-reset"), /deps\.resetSession\(\)/,
    "/gate-reset must clear the lock (through the session reset)");
  assert.equal((CMD_SRC.match(/deps\.unlockAgentDowngrades\(\)/g) ?? []).length, 1,
    "no command other than /gate-mode may reach the unlock seam");
});


test("loop directives: decision table injects on every turn, incl. unarmed first turn", () => {
  // The situation→tool table must be visible BEFORE the first edit arms the
  // gate — that is when the loop's standing flow is first established. It may
  // no longer sit inside the gateArmed-only return branch.
  const handlerAt = SRC.indexOf('pi.on("before_agent_start"');
  assert.ok(handlerAt > 0);
  const injectAt = SRC.indexOf('state.taskMode === "loop"', handlerAt);
  assert.ok(injectAt > 0, "loop branch must inject directives");
  // The decision table is injected in BOTH enforced loop and advisory explore
  // (explore gained it 2026-08-31: it used to early-return before the loop
  // injection, so an explore session never saw the situation→tool table).
  const exploreAt = SRC.indexOf('buildAgentDirectives("explore")', handlerAt);
  assert.ok(exploreAt > 0, "explore branch must inject the decision table too");
  assert.ok(exploreAt < injectAt, "the explore early-return injection sits before the loop one");
  // buildAgentDirectives is called unconditionally for loop, outside any
  // gateArmed guard.
  const directivesAt = SRC.indexOf("buildAgentDirectives()", handlerAt);
  assert.ok(directivesAt > 0, "decision table must be injected in before_agent_start");
  // The undecided-clean early return (added round 3) must sit AFTER the
  // injection, so a loop session never loses the decision table: loop mode
  // falls through regardless of gateArmed.
  const earlyAt = SRC.indexOf("state.taskMode === undefined && !gateArmed && problems.length === 0", handlerAt);
  assert.ok(earlyAt > 0, "undecided-clean early return must exist");
  assert.ok(directivesAt < earlyAt,
    "the decision table is injected BEFORE the undecided early return");
});

test("loop directives: all-gates-green block names the completion steps", () => {
  // When problems.length === 0 the injected text must point at the remaining
  // completion work (declare_done + the Copilot cycle) instead of a bare
  // "you may ship".
  const handlerAt = SRC.indexOf('pi.on("before_agent_start"');
  const greenAt = SRC.indexOf("All gates satisfied", handlerAt);
  assert.ok(greenAt > 0, "all-green branch must exist");
  const greenLine = SRC.slice(greenAt, greenAt + 220);
  // The 收尾 line is LOOP-only: an undecided session must not see it
  // (reviewer P2-4 — the loop block presumes a chosen mode).
  assert.match(SRC.slice(greenAt - 80, greenAt), /state\.taskMode === "loop"/,
    "the 收尾 line is gated on loop mode");
  assert.match(greenLine, /declare_done/, "green branch names declare_done as the next step");
  assert.match(greenLine, /request_copilot_review/, "green branch names the Copilot cycle");
});
test("explore workflow: advisory completion, no edit/bash blocking, ship gate intact", () => {
  // declare_done is self-accepted in explore.
  assert.match(SRC, /explore task completed by AI judgment/);
  // The system prompt guides toward read-only work instead of hard-blocking.
  assert.match(SRC, /## Explore 工作流/);
  assert.match(SRC, /优先只读工作/);
  // The old hard blocks must be gone: no mode-based edit/bash/run_precommit
  // refusal may remain anywhere in the extension.
  assert.doesNotMatch(SRC, /current task is in read-only workflow/);
  assert.doesNotMatch(SRC, /bash is disabled/);
  assert.doesNotMatch(SRC, /run_precommit is unavailable/);
});

test("SECURITY: explore never weakens the L1 ship gate; only user-confirmed normal may", () => {
  // Ship commands (git commit/push, gh pr) must stay fully gated in explore:
  // it only relaxes declare_done and auto-continuation. Three mode branches are
  // permitted in tool_call, and none loosens anything for explore:
  //   normal       — the early return (consent-free first classification, /tmp
  //                  clamp, no-UI session_start, or later user consent);
  //   loop         — the L8 loop-goal ship block, which only ADDS a requirement;
  //   orchestrator — the write restriction and the tmux backstop tier, both of
  //                  which only ADD a refusal (pinned individually below).
  // The hook body is lib/ship-gate-hook.ts + its two arms; the mode question
  // is about the hook AS A WHOLE, so it is asked of all three together.
  const body = HOOK_BODY;
  // `(?:\(\)\s*)?` in all three patterns: the arms read the mode through the
  // injected `deps.taskMode()` getter, and a pattern written for the old bare
  // `state.taskMode` spelling cannot match a CALL — it would be always-true,
  // which is exactly how a negated branch (or an explore carve-out) would get
  // back in unnoticed. Round-1 P1 of this move: two migrated patterns had that
  // defect and a `deps.taskMode() !== "loop"` mutation passed the whole suite.
  const modeExpr = String.raw`taskMode\s*(?:\(\)\s*)?`;
  assert.doesNotMatch(body, new RegExp(`${modeExpr}===\\s*"explore"`),
    "tool_call must never branch on explore");
  assert.doesNotMatch(body, new RegExp(`${modeExpr}!==`),
    "tool_call must not use negated mode branches");
  const modeBranches = [...body.matchAll(new RegExp(`${modeExpr}===\\s*"(\\w+)"`, "g"))].map((m) => m[1]);
  assert.deepEqual([...new Set(modeBranches)].sort(), ["loop", "normal", "orchestrator"],
    "the only tool_call mode branches are normal (step aside), loop (goal block) and " +
    "orchestrator (which only ADDS restrictions)");
  // The loop branch must only PUSH a requirement — its own block body must not
  // return (i.e. it can never wave a ship through, only add to `problems`).
  const loopBlock = windowIn(SHIP_BASH_SRC, 'deps.taskMode() === "loop"', "\n  }", "L8 ship branch");
  assert.match(loopBlock, /problems\.push\(/);
  assert.doesNotMatch(loopBlock, /return|block:\s*false/);
  // The two ORCHESTRATOR sites, pinned individually. Both can only tighten:
  // one refuses a write outside the plan/handoff surface (constraint 2), the
  // other merely tells the tmux backstop which tier to apply. Neither has a
  // pass-through return, so orchestrator mode can never loosen L1.
  const orchestratorSites = [...body.matchAll(/taskMode(?:\(\))? === "orchestrator"/g)];
  assert.equal(orchestratorSites.length, 2,
    "exactly two orchestrator sites in tool_call: the write block and the tmux guard tier");
  // The window is ANCHORED at both ends (not a byte count): F2 added the
  // outside-the-repo carve-out and its reasoning, and a fixed-length window
  // would silently stop pinning the `block: true` return below.
  const writeSite = windowIn(
    SHIP_EDIT_SRC,
    'if (taskMode === "orchestrator" && path) {',
    "\n  }",
    "orchestrator write site",
  );

  assert.match(writeSite, /orchestratorWriteBlock\(\{/,
    "the first orchestrator site is the write restriction (constraint 2)");
  assert.match(writeSite, /return \{ block: true, reason: orchestratorBlock \}/,
    "the write restriction can only BLOCK, never wave a write through");
  const guardSite = windowIn(
    SHIP_BASH_SRC,
    // Open at the SECTION comment, not at the call: the old window reached
    // ~300 bytes back from the orchestrator site, so a return smuggled in
    // just above the tier selection was inside it. Anchoring at the call
    // would have quietly narrowed that.
    "// tmux BACKSTOP (task book §4.3)",
    "if (tmuxHit) return { block: true, reason: tmuxHit.reason };",
    "tmux backstop tier",
  );
  assert.match(guardSite, /detectForbiddenTmux\(/,
    "the second orchestrator site only selects the tmux backstop tier");
  // ANY return, not the old `/return;/` spelling: the extracted arm writes
  // every exit as `return undefined;`, so a pattern looking for a bare
  // `return;` is dead (round-1 P1). The window ends BEFORE the tier's own
  // `return { block: true, … }`, so nothing legitimate can match here.
  assert.doesNotMatch(guardSite, /\breturn\b/,
    "the tmux backstop must not contain a pass-through return");
  // The L8 explore short-circuit lives in the helper loopGoalEditBlockFor
  // (kept OUT of the handler body on purpose — see its docblock): it only
  // lets EDITS pass in explore. Pin that it exists and that it can never
  // block (it returns undefined — the ship path is untouched).
  const helperBody = windowOf("function loopGoalEditBlockFor", "\n  }", "loopGoalEditBlockFor");
  const exploreAt = helperBody.indexOf('state.taskMode === "explore"');
  assert.ok(exploreAt >= 0, "the helper must short-circuit explore (edits only)");
  assert.match(helperBody.slice(exploreAt, exploreAt + 120), /return undefined/,
    "the explore short-circuit must pass edits through, never block them");
});

test("SECURITY: the sensitive-file guard runs BEFORE the normal-mode edit return (security floor)", () => {
  // Normal mode skips workflow checks but must never skip the .env/keys
  // guard — the early return has to come after isSensitiveFile.
  //
  // The window is the EDIT ARM ONLY (lib/ship-gate-edit-guard.ts's
  // evaluateEditCall), never a concatenation: an ordering that held only
  // because another module happens to be appended afterwards would pin
  // nothing at all.
  const body = windowIn(
    SHIP_EDIT_SRC,
    "export async function evaluateEditCall(",
    "\n}",
    "edit arm",
  );
  const sensitiveAt = body.indexOf("isSensitiveFile");
  const normalEditReturn = body.indexOf('taskMode === "normal"');
  assert.ok(sensitiveAt >= 0 && normalEditReturn >= 0, "both checks must exist");
  assert.ok(sensitiveAt < normalEditReturn,
    "sensitive-file guard must precede the normal-mode early return");
  // …and the refusal it produces must sit BEFORE that return too: matching the
  // pattern and then falling through to normal mode would be the same hole.
  const refusalAt = body.indexOf("return sensitiveEditBlock(");
  assert.ok(refusalAt > sensitiveAt && refusalAt < normalEditReturn,
    "the sensitive refusal must be returned before the normal-mode early return");
});

test("normal mode: prompt-transparent except the language directive; loop resume paths skip it", () => {
  // before_agent_start returns the language-directive-only prompt for normal
  // BEFORE any gate text is appended.
  const promptAt = SRC.indexOf('pi.on("before_agent_start"');
  assert.ok(promptAt >= 0);
  const promptBody = SRC.slice(promptAt, promptAt + 5000);
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
    assert.match(SRC.slice(at, at + 1000), /taskMode === "explore" \|\| state\.taskMode === "normal"/, anchor);
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
  const promptBody = SRC.slice(promptAt, promptAt + 5000);
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
  // Criterion 1: an unconfigured arbiter (no agents.arbiter.slots[0]) is
  // refused BEFORE any spawn — no hard-coded default model.
  assert.match(SRC, /if \(!resolveArbiterModel\(\)\)/, "an unconfigured arbiter fails closed");
  assert.match(SRC, /仲裁者未配置模型链/, "the refusal names the missing config");
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
  assert.match(SHIP_BASH_SRC, /ships\[0\]\.kind === "pr-edit" && token/);
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

  // /gate-reset moved to lib/gate-command-tools.ts, but everything it clears
  // is an EXTENSION binding, so the list itself stayed here as one function
  // the command reaches through one seam. Anchored on the function's real
  // end, not a byte count: the reset list grows as more session state appears.
  assert.match(commandBodyOf(CMD_SRC, "gate-reset"), /deps\.resetSession\(\)/,
    "/gate-reset must go through the extension's session reset");
  const resetRegion = windowOf("function resetSessionState(", "\n  }", "resetSessionState");
  assert.match(resetRegion, /clearBypassToken\(\)/);
  // The appeal ledger (quota + decided contents + live pass) is persisted, so
  // the reset must delete it rather than zero an in-memory counter.
  assert.match(resetRegion, /delete state\.appeals/);
  assert.match(resetRegion, /lastBlockedText = null/);
  assert.match(resetRegion, /arbitrationDecisions\.clear\(\)/);
});

test("L5 is ONE hard rule: every call site judges through the shared function", () => {
  // 2026-08-29: the four call sites used to run three different policies
  // (strict subject, majority body, majority PR text, scanner labels). They
  // now differ only in the `kind` they pass.
  assert.match(SHIP_BASH_SRC, /extractPrTextFields/);
  assert.match(SHIP_BASH_SRC, /s\.kind === "pr-create" \|\| s\.kind === "pr-edit"/);
  assert.match(SHIP_BASH_SRC, /nonEnglishCommitMessage\(whole\)/, "bash commit path");
  assert.match(SRC, /nonEnglishCommitMessage\(message\)/, "review_checkpoint path");
  assert.match(SHIP_BASH_SRC, /firstNonEnglishText\("pr-text", prTexts\)/, "PR title/body path");
  assert.match(SRC, /l5BlockReason\(\{ kind: "test-label"/, "L6 label path");
  // The retired majority machinery must be gone — a leftover call would
  // reintroduce the dilution hole it was removed for.
  for (const gone of [/\bisNonEnglishText\b/, /\bfirstNonEnglish\(/, /\banalyzeLanguageMix\b/]) {
    assert.doesNotMatch(SRC, gone, `the majority-policy API must be retired (${gone})`);
    assert.doesNotMatch(HOOK_BODY, gone, `the majority-policy API must be retired in L1 (${gone})`);
  }
  const langDetect = readFileSync(join(ROOT, "lib", "lang-detect.ts"), "utf8");
  for (const gone of ["analyzeLanguageMix", "stripNonProse", "NON_LATIN_MAJORITY"]) {
    assert.ok(!langDetect.includes(gone), `${gone} must be gone from lib/lang-detect.ts`);
  }
  // Advisory L5 died long ago; it must not come back.
  assert.doesNotMatch(SRC, /l5Advisories/);
  assert.doesNotMatch(SRC, /review-gate \(L5 advisory\)/);
});

test("a message-only rewrite is not a content change, at L1 and in the branch rule", () => {
  // The observed deadlock (2026-08-29): a non-English commit message could not
  // be fixed from inside a session — `git commit --amend` was refused as a
  // commit, and `git rebase -i` reword was refused because a detached HEAD
  // names no branch. Both refusals are now answered by facts.
  const callBody = windowIn(
    SHIP_BASH_SRC,
    "export async function evaluateShipCommand(",
    "\n}",
    "ship gate (bash arm)",
  );
  assert.match(callBody, /hasAmendFlag\(s\.segment\)/, "the exemption is scoped to an amend");
  assert.match(callBody, /isMessageOnlyRewrite\(\{/, "…and decided by the pure tree comparison");
  const exemptionAt = callBody.indexOf("isMessageOnlyRewrite({");
  const l5At = callBody.indexOf("nonEnglishCommitMessage(whole)");
  assert.ok(l5At > 0 && l5At < exemptionAt,
    "L5 must judge the NEW message BEFORE the rewrite is let through");
  // Round-3 P1: the exemption skips the CONTENT gates and nothing else. It
  // used to `return` from the whole ship gate, which also dropped the branch
  // rule — so an amend could land on main. The protected-branch rule is one
  // of the survivors.
  //
  // Round-4 P1: the first guard written here was VACUOUS — it matched the
  // literal shape of that `return` with a regex the real call could never
  // satisfy, so re-adding the return kept the suite green. The guard is now a
  // WINDOW: whatever the exemption block ends up containing, no `return` may
  // stand between the decision and the LAST check it must not skip. Round-5
  // P2: the window used to stop at `const problems`, so a return one line
  // later escaped it and skipped exactly the same three checks.
  const lastCheckAt = callBody.indexOf("LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK", exemptionAt);
  assert.ok(lastCheckAt > exemptionAt, "the loop-goal ship gate must follow the exemption");
  const beforeTheChecksAreDone = callBody.slice(exemptionAt, lastCheckAt);
  assert.doesNotMatch(beforeTheChecksAreDone, /\breturn\b/,
    "the exemption must never return from the ship gate — that drops the branch rule with it");
  assert.match(callBody, /const unmet = messageOnlyRewrite \? \[\] : unmetRequirements\(/,
    "only the content requirements are skipped");
  // …and the checks that must survive are all downstream of the decision.
  for (const [what, anchor] of [
    ["the branch rule", "isProtectedBranch("],
    ["the fail-closed sidecar check", "gate state missing (fail-closed)"],
    ["the loop-goal ship gate", "LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK"],
  ] as const) {
    const at = callBody.indexOf(anchor, exemptionAt);
    assert.ok(at > exemptionAt, `${what} must still run after the exemption was decided`);
  }
  // Every repo the command touches must qualify, and an unresolvable repo set
  // never does (a compound `git -C A … && git -C B …` must not ride on A).
  assert.match(callBody, /\[\.\.\.checkRoots\]\.every\(\(root\) => isMessageOnlyRewrite\(\{/);
  assert.match(callBody, /!resolution\.ambiguous &&/);
  // The INDEX is what an amend publishes, so the worktree tree alone is not
  // evidence: staging a change and restoring the worktree must not qualify.
  assert.match(callBody, /stagedChanges: deps\.hasStagedChanges\(root\)/);
  // The branch rule reads where a rebase will land instead of refusing.
  const branchFn = windowOf("function currentBranch(", "\n  }", "currentBranch");
  assert.match(branchFn, /rebaseBranch\(root\)/, "a detached rebase HEAD still names its branch");
  const rebaseFn = windowOf("function rebaseBranch(", "\n  }", "rebaseBranch");
  assert.match(rebaseFn, /rebase-merge/, "the sequencer backend");
  assert.match(rebaseFn, /rebase-apply/, "…and the am backend");
  assert.match(rebaseFn, /rebaseBranchName\(/, "the parsing is the pure function's");
});


test("A-class blocks are appealable; B-class facts are NOT", () => {
  // The dividing line (user requirement): a HEURISTIC the gate can get wrong
  // gets an appeal route; a FACT it observed does not, or the appeal becomes
  // the way to argue past the process.
  // The four ship-text refusals live in the L1 bash arm and reach `refuseText`
  // through the injected dep; the L6 test-label one is still the extension's.
  const aClass: Array<[string, string, RegExp]> = [
    ["commit subject/body", SHIP_BASH_SRC, /deps\.refuseText\(\s*\n?\s*nonEn\.part === "subject" \? "commit-subject" : "commit-body"/],
    ["PR text", SHIP_BASH_SRC, /deps\.refuseText\("pr-text"/],
    ["romanized", SHIP_BASH_SRC, /deps\.refuseText\("romanized"/],
    ["AI attribution", SHIP_BASH_SRC, /deps\.refuseText\("ai-attribution"/],
    ["test label", SRC, /refuseText\("test-label"/],
  ];
  for (const [what, src, pattern] of aClass) {
    assert.match(src, pattern, `${what} must refuse through the appealable path`);
  }
  // refuseText is the ONLY place the hint is attached, so the route and the
  // record of the block can never drift apart.
  const refuse = windowOf("function refuseText(", "\n  }", "refuseText");
  assert.match(refuse, /APPEAL_HINT/, "the reason carries the appeal route");
  assert.match(refuse, /lastBlockedText = \{/, "the block is recorded for the appeal");
  assert.match(refuse, /appealPassAuthorizes\(state\.appeals, digest\)/, "a granted pass is honoured");
  assert.match(refuse, /consumeAppealPass\(/, "…exactly once");
  // B-class: these reasons state the correct next step and must not offer an
  // appeal instead.
  for (const [factBlock, src] of [
    ["在受保护分支上", SRC],
    ["matches a sensitive-file pattern", SHIP_EDIT_SRC],
  ] as const) {
    const at = src.indexOf(factBlock);
    assert.ok(at > 0, `the B-class block must exist: ${factBlock}`);
    assert.ok(!src.slice(at, at + 600).includes("APPEAL_HINT"),
      `a FACT must not offer an appeal: ${factBlock}`);
  }
});

test("the checkpoint message is delegated to the pure, unit-tested lib module", () => {
  // Round-2 P2 (the impossible default) and the 2026-08-31 scope-injection fix
  // both live in lib/checkpoint-message.ts now, exercised by
  // test/checkpoint-message.test.ts (four scope cases + the L5 fallback). The
  // extension only names the call site — pin the delegation so the logic cannot
  // silently move back inline.
  assert.match(SRC, /import \{ buildCheckpointMessage \} from "\.\.\/lib\/checkpoint-message\.ts"/,
    "the extension imports the pure builder");
  const at = SRC.indexOf("function checkpointMessage(raw: string): string");
  assert.ok(at > 0, "the wrapper still exists");
  const body = SRC.slice(at, at + 200);
  assert.match(body, /return buildCheckpointMessage\(raw\);/,
    "the wrapper delegates, it does not re-implement the rule");
});



test("commands registered: gate-status, gate-bypass, gate-grant, gate-mode, gate-reset", () => {
  for (const cmd of ["gate-status", "gate-bypass", "gate-grant", "gate-mode", "gate-reset", "gate-lesson"]) {
    assert.match(CMD_SRC, new RegExp(`registerCommand\\(["']${cmd}["']`), cmd);
  }
  // /gate-doctor sits in the read-only diagnosis module, which the command
  // module registers itself — so the extension still wires the layer once.
  assert.match(DIAG_SRC, /registerCommand\(["']gate-doctor["']/);
  assert.match(CMD_SRC, /registerGateDiagnosisCommands\(host, deps\)/);
  // ONE registration call in the extension, and no command body left in it.
  assert.equal((SRC.match(/registerGateCommands\(pi, \{/g) ?? []).length, 1,
    "the extension must wire the command layer exactly once");
  assert.doesNotMatch(SRC, /registerCommand\(/,
    "no command may be registered from the extension any more");
});

test("high-value sd0x-dev-flow commands are registered from a shared catalog", () => {
  assert.match(CMD_SRC, /WORKFLOW_COMMANDS/);
  assert.match(CMD_SRC, /registerWorkflowCommand/);
  assert.match(CMD_SRC, /buildWorkflowPrompt/);
  assert.match(CMD_SRC, /host\.sendUserMessage/);

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
  // The live sink travels too, wrapped in a progress reporter: the runner's
  // log streams under a step line that names the lane and its elapsed time,
  // so a multi-minute precommit is no longer a silent tool call.
  assert.match(SRC, /await runTrustedPrecommit\(targetDir, targetRoot, mode, signal, \(partial\) => \{/);
  assert.match(SRC, /title: `review-gate: precommit \(\$\{mode\}\)`/);
  assert.doesNotMatch(SRC, /async function runTrustedPrecommit[^{]*\{\s*\n\s*const cwd = process\.cwd\(\)/);
});

// ---------------------------------------------------------------------------
// Precommit observability — the run output must survive, and be findable.

test("the runner's output is CAPTURED to a file descriptor, never discarded", () => {
  // It used to be stdio: ["ignore", "ignore", "ignore"], so a FAIL told the
  // agent "1/3 checks failed" and nothing else — no check name, no error text.
  assert.doesNotMatch(SRC, /stdio:\s*\["ignore",\s*"ignore",\s*"ignore"\]/,
    "the precommit runner's output must not be thrown away");
  const body = windowOf("async function runTrustedPrecommit", "\n}", "runTrustedPrecommit");
  assert.match(body, /openSync\(tmpLog/, "capture via a file descriptor");
  // A pipe would deadlock: the runner is detached and long-lived, and a full
  // 64KB pipe buffer blocks its next write forever if nobody drains it.
  assert.doesNotMatch(body, /stdio:\s*\[[^\]]*"pipe"/, "never a pipe for the detached runner");
  assert.match(body, /rmSync\(dir, \{ recursive: true, force: true \}\)/,
    "the temp receipt dir is still destroyed after every run");
  // Liveness comes from READING that file, never from a second write channel:
  // the tail polls the log and its stop() does a final read, so an aborted or
  // timed-out run still forwards what the killed runner wrote last.
  assert.match(body, /tailLogFile\(tmpLog/, "the run log is tailed for live output");
  assert.match(body, /tail\?\.stop\(\)/, "the tail is stopped (final flush) on every exit path");
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
  // The runner's output goes to the LIVE channel (progress.tail → onUpdate)
  // and to the log file — never into the returned text, which is what the
  // agent's context pays for.
  assert.doesNotMatch(body, /text: [^\n]*outcome\.(tail|output)/, "step output must never be inlined into the reply");
  assert.match(body, /progress\.tail\(partial\.content/, "…it goes to the live progress channel instead");
});

test("failed-step names are diagnostics: read AFTER the verdict, never fed into it", () => {
  const body = windowOf("async function runTrustedPrecommit", "\n}", "runTrustedPrecommit");
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
  // `assert.match(SRC, /isSensitiveFile/)` was VACUOUS after the hook moved:
  // the tool_result handler mentions the same symbol, so the guard could have
  // vanished from L1 entirely and this would still have been green. It now
  // names the arm that owns the guard, and the wiring that reaches it.
  assert.match(SHIP_EDIT_SRC, /isSensitiveFile\(absPath\)/,
    "the L1 edit arm matches the NORMALIZED path against the patterns");
  assert.match(SHIP_EDIT_SRC, /return sensitiveEditBlock\(\{ rawPath: path, askable \}\)/,
    "…and refuses through the pure decision");
  assert.match(shipHookWiring(), /sensitiveGrants: \(\) => sensitiveGrants/,
    "the live grants reach the arm from the extension, never a copy");
  assert.match(shipHookWiring(), /sensitiveDeclined: \(absPath\) => sensitiveDeclinedPaths\.has\(absPath\)/,
    "…and so does the declined-path lock");
});

test("request_sensitive_edit: the user decides in an extension dialog, not the agent", () => {
  const body = toolBodyOf("request_sensitive_edit");

  assert.match(body, /deps\.confirmBounded\(/, "the extension must render the confirm dialog itself");
  assert.doesNotMatch(body, /confirmed\s*:\s*Type\./,
    "no agent-supplied 'confirmed' parameter — that would be self-approval");
  assert.match(body, /if \(!uiCtx\.hasUI\)/, "no UI must fail closed instead of granting");
  assert.match(body, /dialogFailed/, "a dialog that could not be shown is not a decline");
});

test("SECURITY: request_sensitive_edit refuses .git internals before showing any dialog", () => {
  const body = toolBodyOf("request_sensitive_edit");
  const integrityAt = body.indexOf("isGateIntegrityPath");
  const confirmAt = body.indexOf("confirmBounded");
  assert.ok(integrityAt > 0 && confirmAt > 0, "both must exist");
  assert.ok(integrityAt < confirmAt,
    "a user must never be asked to authorize a write to .git/hooks — that would disarm L3");
});

test("SECURITY: a declined sensitive path is locked, and grants never reach the sidecar", () => {
  assert.match(CONSENT_SRC, /deps\.sensitiveDeclinedPaths\.add\(absPath\)/,
    "a decline must lock that path against re-asking");
  assert.match(CONSENT_SRC, /deps\.sensitiveDeclinedPaths\.has\(absPath\)/,
    "a locked path must be refused before any dialog");
  // The lock is ONE set, the extension's own: a copy handed to the tool would
  // forget the decline the moment the tool returned.
  assert.match(windowOf("registerUserInteractionTools(pi, {", "\n  });", "user-interaction wiring"),
    /\n    sensitiveDeclinedPaths,/, "the extension shares its set, it does not copy it");
  // In-memory only: persisting a grant would let a write authorization survive
  // a crash/resume, i.e. outlive the conversation the user consented in.
  assert.doesNotMatch(SRC, /state\.sensitiveGrants/,
    "sensitive-file grants must never be written into the persisted gate state");
  assert.doesNotMatch(CONSENT_SRC, /state\.sensitiveGrants/,
    "…and the module that ISSUES them must not persist them either");
});

test("L8b: record_goal_prereview is TRUSTED — the extension parses the verdict and hashes the text", () => {
  // The tool moved to lib/ (registration in lib/goal-tools.ts on the INTERNAL
  // host, body in lib/goal-prereview-tools.ts) — the rule follows the code:
  // `toolBodyOf` reads both windows, and the shared submission checks
  // (`checkGoalDraft`) are read with them, because the repo binding and the
  // length cap are asserted below and now live there.
  const body = toolBodyOf("record_goal_prereview") + "\n" +
    windowIn(GOAL_PREREVIEW_SRC, "export function checkGoalDraft(",
      "\nexport function buildGoalRecordReply(", "checkGoalDraft");
  // The verdict is READ, never accepted: no `passed`/`verdict` parameter may
  // exist, or the pre-review becomes an agent self-certification again. The
  // raw param is narrowed once at the handler boundary (the lib tool host
  // hands over `Record<string, unknown>`), then parsed by the gate itself.
  assert.match(body, /const auditorOutput = typeof params\.auditor_output === "string"/,
    "the auditor output is narrowed, not cast");
  assert.match(body, /parseReviewOutput\(auditorOutput\)/, "the extension must parse the auditor output itself");
  // B2: ONE mechanical adjudication decides PASS — a READY without P0/P1 —
  // and the same call produces the sentence the agent reads.
  assert.match(body, /adjudicateGoalAudit\(\{/, "the extension adjudicates the audit itself");
  assert.match(body, /const passed = adjudication\.pass/, "PASS comes from that single adjudication");
  // The round counter belongs to THIS goal's negotiation, not to the repo's
  // append-only audit history (which spans every goal it ever had).
  assert.match(body, /goalSt\.goalAuditRound = \(goalSt\.goalAuditRound \?\? 0\) \+ 1/,
    "the gate counts this goal's audits itself");
  assert.doesNotMatch(body, /round: \(goalSt\.goalPrereviewHistory\?\.length/,
    "the cumulative history must not be used as the round number");
  // …and the count ends with the negotiation: an approved goal resets it, so
  // the next goal's first audit is round 1.
  const propose = toolBodyOf("propose_loop_goal");
  assert.match(propose, /delete goalSt\.goalAuditRound/, "approval ends this goal's audit count");
  const sessionStartAt = SRC.indexOf('pi.on("session_start"');
  const sessionStart = SRC.slice(sessionStartAt, sessionStartAt + 4000);
  assert.match(sessionStart, /delete state\.goalAuditRound/, "a new session starts its own count");
  assert.match(body, /goalTextHash\(goalText\)/, "the extension must hash the submitted text itself");
  assert.doesNotMatch(body, /params\.(passed|verdict|hash)\b/, "no agent-attested verdict or hash may be read");
  // Fail-closed: an unparseable fence records NOTHING (a wiped record would
  // silently downgrade a standing PASS, and a recorded one would be a forgery).
  const noFence = body.indexOf("if (!parsed)");
  const write = body.indexOf("goalSt.goalPrereview =");
  assert.ok(noFence > 0 && write > noFence, "the unparseable guard must precede the sidecar write");
  // Same repo resolution as propose_loop_goal — literally the same function
  // now (never resolveToolRepo, which requires an already-edited repo and
  // would dead-end a second repo's goal).
  assert.match(body, /gitRootOfDir\)\(abs\)/);
  assert.doesNotMatch(body, /resolveToolRepo\(/, "it must not CALL resolveToolRepo (naming it in the rationale is fine)");
  // The INTERNAL host is the one it registers on: pi must never learn this name.
  const registrationAt = GOAL_TOOLS_SRC.indexOf('name: "record_goal_prereview"');
  const hostAt = GOAL_TOOLS_SRC.lastIndexOf("registerTool({", registrationAt);
  assert.ok(hostAt > 0 && !/hosts\.agent|pi\./.test(GOAL_TOOLS_SRC.slice(hostAt - 40, hostAt)),
    "record_goal_prereview must not be registered on the agent-visible host");
  assert.match(GOAL_TOOLS_SRC, /registerRecordGoalPrereview\(hosts\.internal, deps\)/,
    "…and the family entry point must hand it the internal host");
});

test("goal criterion 3: prepare_adviser is registered and hands back a brief with artifact + session pointer", () => {
  const body = toolBodyOf("prepare_adviser");
  assert.match(body, /buildAdviserBrief\(/, "the brief comes from the shared pure builder");
  assert.match(body, /adviser-\$\{goalHash\}\.jsonl/, "the artifact path is per goal");
  // The mkdir itself is now the injected `ensureDir` (the extension wires it to
  // mkdirSync recursive) — what this pins is unchanged: the directory is created
  // from the artifact's own dirname, before the first consultation reads it.
  assert.match(body, /ensureDir\(pathDirname\(artifactPath\)\)/, "the artifact dir is created before the first consultation");
  assert.match(ADVISORY_WIRING(), /mkdirSync\(path, \{ recursive: true \}\)/, "…and the wiring is a recursive mkdir");
  assert.match(body, /adviserBaselines/, "the changed-files baseline is persisted per goal for the next consultation");
  assert.match(body, /readLastAdviserConclusion\(deps, artifactPath, goalHash\)/, "readback goes through the tested pure parser (parseAdviserConclusions)");
  // The builder takes no channel params — completion is the process exit;
  // questions ride a fence + resume (2026-08-28).
  const briefCall = body.indexOf("buildAdviserBrief({");
  assert.ok(briefCall > 0);
  assert.doesNotMatch(body.slice(briefCall, briefCall + 900), /doneChannel|inboxPath|inboxChannel/,
    "the brief embeds no tmux channel (process exit is the completion signal)");
  // The brief is PAYLOAD now: judge_submit calls this tool and takes what
  // follows the marker, so the marker must be there and the header must point
  // at the normal path rather than teaching a manual spawn.
  assert.match(body, /TASK_TEXT_MARKER/, "the payload is delimited for the chain");
  assert.match(body, /judge_submit\(\{role:\\"adviser\\"/, "the header names the normal path");
  assert.doesNotMatch(body, /review_spawn\(\{ role: "adviser"/, "no manual spawn recipe");
  // The waiting discipline moved to where it is mechanically useful
  // (judge_wait's own reply), so the header no longer teaches it. What must
  // survive is the truncated-goal pointer: a brief with half a goal in it
  // sends the adviser off the wrong contract.
  assert.match(body, /需要全文时读 \$\{deps\.loopGoalPath\(target\.root\)\}/,

    "a truncated goal is pointed at its file");
});

test("goal criterion 2: prepare_goal_audit hands back the ready-made auditor task BEFORE dispatch", () => {
  // The round-5 P1: record_goal_prereview only runs AFTER the audit, so it
  // could never supply the task that produced the audit it records. The
  // task template therefore lives in a PRE-dispatch tool.
  const body = toolBodyOf("prepare_goal_audit");
  assert.match(body, /buildGoalAuditTask\(draft, \{/, "the template comes from the shared pure builder");
  assert.match(body, /formatGoalPrereviewCarryover\(prev\)/, "re-audits carry the previous audit's conclusion");
  assert.match(body, /prev\?\.draft/, "the previous draft rides along for the mechanical delta");
  // No channel params in the builder — completion is the process exit;
  // questions ride a fence + resume (2026-08-28).
  const auditCall = body.indexOf("buildGoalAuditTask(draft, {");
  assert.ok(auditCall > 0);
  assert.doesNotMatch(body.slice(auditCall, auditCall + 900), /doneChannel|inboxPath|inboxChannel/,
    "the task embeds no tmux channel (process exit is the completion signal)");
  // Same shape as the adviser brief: PAYLOAD behind the marker, header
  // pointing at the one call that dispatches and records.
  assert.match(body, /TASK_TEXT_MARKER/, "the payload is delimited for the chain");
  assert.match(body, /judge_submit\(\{role:\\"goal-auditor\\"/, "the header names the normal path");
  assert.doesNotMatch(body, /review_spawn\(\{ role: "goal-auditor"/, "no manual spawn recipe");
});

test("user ask 2026-08-27: prepare_review wires the trusted precommit baseline into the reviewer task", () => {
  // The reviewer must be handed the precommit facts (and steered to targeted
  // tests) instead of re-running the full suite. The SAFETY behavior (a PASS
  // for an OLDER tree is never this round's evidence; stale cache entries
  // are dropped) lives in the pure extractPrecommitBaseline, which is
  // behaviorally tested in test/parallel-review.test.ts; this test pins the
  // wiring: prepare_review hands the baseline to the task text.
  const body = toolBodyOf("prepare_review");
  assert.match(body, /precommitBaselineFor\(root, st, deps\.readText\)/, "the baseline rides the task text");
  // …and the decision itself lives in the helper, judged in its OWN window
  // (the tool's window used to be a byte count wide enough to swallow it,
  // which is how a "prepare_review does X" assertion could pass on code that
  // is not in prepare_review at all). The helper moved out of the extension
  // with the tool, so the window is read from the module that owns it now.
  const baselineFn = windowIn(REVIEW_PREPARE_SRC, "export function precommitBaselineFor(", "\n}", "precommitBaselineFor");
  assert.match(baselineFn, /extractPrecommitBaseline\(st\.precommit, digest, cacheRaw\)/,
    "the safety decision is the pure function");
  assert.match(baselineFn, /computeFingerprint\(root\)/, "the current tree fingerprint is measured, not guessed");
  // No channel params in the task builder — completion is the process exit;
  // questions ride a fence + resume (2026-08-28). The output names the
  // suggested title; the session id derives mechanically (role+repo).
  const promptCall = body.indexOf("const task = buildReviewPrompt(");
  assert.ok(promptCall > 0);
  assert.doesNotMatch(body.slice(promptCall, promptCall + 1200), /doneChannel|inboxPath|inboxChannel/,
    "the reviewer task embeds no tmux channel (process exit is the completion signal)");
  // 2026-08-29: prepare_review is an ADVANCED entry — its output must point at
  // the ONE normal path (judge_submit) instead of teaching the manual spawn.
  assert.match(body, /ADVANCED \/ internal：正常路径是一次 judge_submit/,
    "the output names judge_submit as the normal path");
  // One indent level shallower now that the handler is a top-level function.
  const proseEnd = body.indexOf("    TASK_TEXT_MARKER,");
  assert.ok(proseEnd > 0, "the task-text marker still separates prose from the task");
  assert.doesNotMatch(body.slice(0, proseEnd),
    /review_spawn|review_send|review_watch|建议 title/,
    "the prose above the task text no longer teaches the retired manual dispatch");
  assert.doesNotMatch(body, /const reviewTitle =/,
    "the display title is the gate's business — prepare_review computes none");
  assert.match(body, /stream=\$\{streamPath\}/,
    "the findings stream path still comes back to the caller");
  // Round-17: waiting discipline (work while the child runs) is spelled out,
  // and a truncated goal gets an explicit read-and-replace instruction.
  assert.match(body, /等待纪律/, "the waiting discipline is part of the spawn flow");
  assert.match(body, /第一次 goal 批准前编辑\/写工具仍被门禁拦截,属预期/,
    "prepare_review states the pre-approval reality too (round-17 P2: it was the one left behind)");
  assert.match(body, /落盘 task 文件时请用 read 读取 \$\{deps\.loopGoalPath\(root\)\}/,

    "a truncated goal must be completed from the file when writing the task");
});

test("supervision is a POINT-TO-POINT channel — no global queue, no broadcast", () => {
  // The global attention queue is GONE (2026-08-30). A child of an
  // orchestration now writes to ONE file that belongs to it alone, so
  // isolation is a property of the medium rather than a filter every reader
  // has to remember to apply — which is what F12/R-16 were about.
  assert.doesNotMatch(SRC, /publishAttention|consumeAttention|attentionTarget\(/,
    "the global attention queue and its recipient filter are deleted");
  assert.doesNotMatch(SRC, /review-gate-attention/, "and so is the file it rode on");
  assert.doesNotMatch(SRC, /rg-user-attention/, "the global broadcast channel is GONE");
  assert.doesNotMatch(SRC, /createWatchRegistry\(/, "the tmux channel watcher registry is GONE");

  // The binding: an orchestration id + this session's own child id. With
  // neither, every reporting function below is a silent no-op.
  const bindingAt = SRC.indexOf("function childBinding(");
  assert.ok(bindingAt > 0, "the child side needs a binding to its own channel");
  const binding = SRC.slice(bindingAt, bindingAt + 700);
  assert.match(binding, /supervisionTarget\(\)/,
    "addressed to the ORCHESTRATION, so a handoff never retires the channel");
  assert.match(binding, /STATE_VARIANT_ENV/, "and to this session's own child id");
  assert.match(binding, /if \(!orchestrationId \|\| !childId\) return undefined/,
    "a standalone session reports nowhere");

  // The report itself is pi's own truth, never a screen.
  const reportAt = SRC.indexOf("function reportChildState(");
  assert.ok(reportAt > 0, "the child reports its own state");
  const report = SRC.slice(reportAt, reportAt + 1200);
  assert.match(report, /ctx\.isIdle\?\.\(\) === false/, "streaming is asked, not inferred");
  assert.match(report, /state\.completion\?\.at/,
    "R3-5: a finished child is `done`, and one that merely stopped is `idle`");
  assert.match(report, /\? "done"/);
  assert.match(report, /: "idle"/);
  // Round-4 P0 — a judge round of its own is neither `working` nor `idle`.
  assert.match(report, /activeJudgeWait\(\)/,
    "a judge THIS session dispatched is a fact the gate holds, never something to infer from silence");
  assert.match(report, /"waiting-judge"/,
    "and it is reported as its own state, so a healthy review round is never read as a hang");
  assert.doesNotMatch(report, /capture-pane|screenLooksBusy/, "no screen is consulted, in any state");

  // Round-4 P0 — THE HEARTBEAT IS A TIMER, not an agent event. This is the
  // whole fix: `agent_settled` / `turn_end` do not fire during a judge_wait,
  // a precommit or any long tool call, so a heartbeat that rode on them went
  // silent for minutes and a healthy child was reported `stalled`.
  const heartbeatAt = SRC.indexOf("function startChildHeartbeat(");
  assert.ok(heartbeatAt > 0, "the child heartbeat must be its own timer");
  const heartbeat = SRC.slice(heartbeatAt, heartbeatAt + 600);
  assert.match(heartbeat, /setInterval\(/, "it ticks on its own, independently of the agent");
  assert.match(heartbeat, /reportChildState\(live\)/, "each tick reports liveness");
  assert.match(heartbeat, /drainChildInstructions\(live\)/,
    "and applies the orchestrator's messages, which is what makes followUp reach a BUSY child");
  assert.match(SRC, /function stopChildHeartbeat\(\)/, "and a session shutdown must be able to stop it");
  const shutdown = windowOf('pi.on("session_shutdown"', "\n  });", "session_shutdown");
  assert.match(shutdown, /stopChildHeartbeat\(\)/, "a leaked heartbeat would report for a session that is gone");


  // It is called from pi's OWN events, unconditionally and first.
  const settled = windowOf('pi.on("agent_settled"', "\n  });", "agent_settled");
  assert.match(settled, /reportChildState\(ctx\)/);
  assert.match(settled, /drainChildInstructions\(ctx\)/, "and the orchestrator's messages are applied there");
  const turnEnd = windowOf('pi.on("turn_end"', "\n  });", "turn_end");
  assert.match(turnEnd, /reportChildState\(ctx\)/, "turn_end still reports — the timer is a floor, not a replacement");

  // Delivery is pi's API, never a keyboard.
  const drainAt = SRC.indexOf("async function drainChildInstructions(");
  const drain = SRC.slice(drainAt, drainAt + 2600);
  assert.match(drain, /pi\.sendUserMessage\(text, \{ deliverAs: instruction\.mode \}\)/);
  assert.match(drain, /deliverAs: "steer"/,
    "an interrupt WITH text aborts then delivers the message immediately (2026-08-31)");
  assert.match(drain, /ctx\.abort\?\.\(\)/, "interrupt is ctx.abort(), not a Ctrl-C keystroke");
  assert.match(drain, /acknowledgeInstruct\(binding, instruction\.instructId, false/,
    "a failure is acknowledged AS a failure — the receipt the orchestrator builds on");
  // Round-4 P1 — the two-stage handshake. `received` is written BEFORE any
  // injection is attempted: that is what lets a `followUp` to a busy child be
  // reported as delivered instead of silently lost.
  assert.match(drain, /"received"/, "the child says it HAS the instruction first");
  assert.match(drain, /"injected"/, "and separately that pi actually took it");
  assert.match(drain, /acknowledgedReceipts/,
    "the receipt is written once per instruction, not once per heartbeat tick");


  // Spawn side: the judge child is still told who spawned it.
  const spawnAt = SRC.indexOf("function dispatchJudgeRound(");
  const spawn = SRC.slice(spawnAt, spawnAt + 9000);
  assert.match(spawn, /parentSessionId: state\.sessionId \?\? undefined/, "the child is told who spawned it");
});

test("every gate dialog is answerable by EITHER the human or the project manager", () => {
  const funnelAt = SRC.indexOf("async function askEitherSide(");
  assert.ok(funnelAt > 0, "there is ONE funnel every gate question goes through");
  const funnel = SRC.slice(funnelAt, funnelAt + 700);
  assert.match(funnel, /askThroughChannel\(binding, \{ \.\.\.request, hasUI \}, render\)/,
    "the race lives in the pure module, not in the extension");
  assert.match(funnel, /if \(!binding\) return hasUI \? render\(/,
    "a session with no orchestration just renders the dialog, exactly as before");

  // The goal approval is the one dialog constraint 8 applies to, so its
  // request must carry the DRAFT — that is the text the boundary check reads.
  const goalBody = toolBodyOf("propose_loop_goal");
  assert.match(goalBody, /topic: "goal-approval"/);
  assert.match(goalBody, /payload: goalText/,
    "R-7: the orchestrator approves the text the CHILD wrote, never one it retyped");
  assert.match(goalBody, /signal,/, "and the box is dismissible, so an answered question stops being asked");
});


test("round-18: prepare_review carries the polish-gate reason — parameter, refusal, persistence, reviewer injection", () => {
  const body = toolBodyOf("prepare_review");
  // The tool accepts a `reason` parameter.
  assert.match(body, /reason: Type\.Optional\(Type\.String\(/, "prepare_review accepts a reason");
  // The refusal path consults the pure decision module and demands the reason.
  assert.match(body, /polishReasonRequired\(st\.rounds\)/, "the polish gate decides from the recorded rounds");
  assert.match(body, /prepare_review REFUSED/, "the refusal text is explicit");
  // The raw param is narrowed once at the handler boundary (the lib tool host
  // hands over `Record<string, unknown>`), then trimmed everywhere it is judged.
  assert.match(body, /const reason = typeof params\.reason === "string" \? params\.reason : undefined;/,
    "the reason parameter is narrowed, not cast");
  assert.match(body, /\(reason \?\? ""\)\.trim\(\)/, "the reason is trimmed before judging");
  // A supplied reason is persisted into gate state for the NEXT reviewer.
  assert.match(body, /st\.lastPolishReason = \{/, "the reason is persisted");
  assert.match(body, /lastPolishReason/, "the reviewer task receives the stored reason");
  // record_review records per-file finding severities for the file streak.
  const recBody = toolBodyOf("record_review");
  assert.match(recBody, /parseFenceFileFindings\(params\.reviewer_output\)/, "record_review parses severity+file per round");
  assert.match(recBody, /recordedFindingsFrom\(fileFindings\)/, "the file lists are derived for the streak");
  assert.match(recBody, /polishFiles: recorded\.polishFiles/, "P2/Nit files are stored on the round");
  assert.match(recBody, /blockingFiles: recorded\.blockingFiles/, "P0/P1 files are stored on the round");
});

test("round-18: child-wait watchdog is guarded, cancellable, and gate-owned", () => {
  const scheduleAt = SRC.indexOf("function scheduleChildWaitRecheck(");
  assert.ok(scheduleAt > 0, "the child-wait watchdog must exist");
  const schedule = SRC.slice(scheduleAt, scheduleAt + 1800);
  assert.match(schedule, /state\.pausedQuestion/, "watchdog respects pause_for_question");
  assert.match(schedule, /state\.taskMode === "explore" \|\| state\.taskMode === "normal"/, "watchdog respects explore/normal mode");
  assert.match(schedule, /lastRunAborted/, "watchdog respects ESC abort");
  assert.match(schedule, /!loopArmed/, "watchdog respects the loop latch");
  assert.match(schedule, /state\.bypass\.active/, "watchdog respects bypass state");
  assert.match(schedule, /childSessions\.values\(\)/, "watchdog rechecks that children still exist");
  assert.match(schedule, /deliverAs: "followUp"/, "watchdog resumes through the normal follow-up queue");
  assert.doesNotMatch(schedule, /\.unref\(\)/, "the hosted-wait timer keeps the main session alive");
  const childAt = SRC.indexOf("const childSnapshots");
  const childBlock = SRC.slice(childAt, SRC.indexOf("// L2 circuit breaker", childAt));
  assert.match(childBlock, /if \(!notifyNow\)/, "the throttled hosted wait has a distinct branch");
  assert.match(childBlock, /scheduleChildWaitRecheck\(/, "the throttled branch schedules a self-owned recheck");
  assert.match(childBlock, /return;/, "the throttled branch does not fall through to RESUME");
  // judge_close still cancels the watchdog — the tool body now says so
  // through its dep (it lives in lib/judge-session-tools.ts), and the
  // extension's wiring is what binds that dep to the timer itself. Both
  // halves are asserted: either one alone would let the cancel silently
  // become a no-op.
  const closeBody = toolBodyOf("judge_close");
  assert.match(closeBody, /deps\.cancelWaitTimer\(\)/, "judge_close cancels the watchdog");
  assert.match(judgeToolsWiring(), /cancelWaitTimer: \(\) => cancelChildWaitTimer\(\)/,
    "…and the wiring binds that dep to the gate's own timer");
  const shutdownBody = windowOf('pi.on("session_shutdown"', "\n  });", "session_shutdown handler");
  assert.match(shutdownBody, /cancelChildWaitTimer\(\)/, "session_shutdown cancels the watchdog");
});

test("round-18: agent_settled HOSTS the judge-child wait — never returns to idle on a child in flight", () => {
  const settledAt = SRC.indexOf('pi.on("agent_settled"');
  assert.ok(settledAt > 0);
  const settled = SRC.slice(settledAt, settledAt + 16000);
  const injectAt = settled.indexOf("pi.sendUserMessage(");
  assert.ok(injectAt > 0, "agent_settled must have an injection site");
  // The liveness invariant (user requirement, round-18): while gates are unmet
  // the main session must KEEP driving, never fall back to idle. The old early
  // return (`if (judgeChildInMotion()) return;`) is GONE — a fresh child now
  // produces a HOST_WAIT injection instead.
  assert.doesNotMatch(settled, /if \(judgeChildInMotion\(\)\) return;/,
    "the old early return that left the session idle is removed");
  // The child classification drives the injection: dead/silent children end
  // the wait (recovery), live ones get the hosted-wait discipline.
  assert.match(settled, /classifyChildren\(childSnapshots, Date\.now\(\)\)/, "children are classified by the pure module");
  assert.match(settled, /REVIEW_GATE_CHILD_\$\{/, "the child injection marker is built by template");
  assert.match(settled, /"ENDED" : "HOST_WAIT"|terminated\.length > 0 \? "ENDED"/, "a dead/silent child produces the ENDED marker");
  assert.match(settled, /HOST_WAIT/, "an in-flight child produces the HOST_WAIT marker");
  assert.match(settled, /Never end the turn and leave the wake-up to the child/, "the discipline text is explicit");
  // The stall path stays reachable for children that are NOT involved.
  const stallAt = settled.indexOf("evaluateStall(");
  assert.ok(stallAt > 0, "the stall breaker still exists");
  assert.ok(injectAt < stallAt, "the injection precedes the breaker block");
});

test("judge_submit is the agent's single judge entry and hides every process detail", () => {
  assert.ok(SRC.includes('name: "judge_submit"'), "judge_submit must be registered");
  // The window ends where the relay tools' WIRING begins. The old end anchor
  // was `name: "review_spawn"` — it left this file with the tools it named,
  // and a bare indexOf of a vanished anchor returns -1, which silently widens
  // the slice to the rest of the file instead of failing. windowOf asserts
  // both ends.
  const body = windowOf('name: "judge_submit"', "\n  // `review_spawn`", "judge_submit body");
  // The agent says WHO and WHAT. Anything procedural is the gate's business.
  assert.match(body, /role: Type\.Enum\(\{ reviewer/, "the role is the addressing key");
  assert.match(body, /task: Type\.String\(/, "the task text is the other input");
  assert.doesNotMatch(body, /sessionId: Type\./, "the agent never passes a session id");
  assert.doesNotMatch(body, /title: Type\./, "the agent never passes a title");
  assert.match(body, /const title = `\$\{role\}-/, "the gate derives the display title itself");
  assert.match(body, /dispatchJudgeRound\(\{ root, role, title, task/, "dispatch is delegated to the one spawn owner");
});

test("dispatchJudgeRound owns identity: stable dir per role+repo, reuse, fresh-kill", () => {
  const at = SRC.indexOf("function dispatchJudgeRound(");
  assert.ok(at > 0, "the single dispatch owner must exist");
  const body = SRC.slice(at, at + 9000);
  // B5: the work dir is derived from role+repo — NEVER from the round's title,
  // which gave pi a new --session-dir every round and restarted the session.
  assert.match(body, /judgeWorkDirFor\(role, shortRepoHash\(root\)\)/,
    "the work dir is a function of role+repo");
  assert.doesNotMatch(body, /judge-sessions", `rg-\$\{title\}`/, "no title-derived session dir may come back");
  // Finished children are cleaned from the registry first (never block a spawn).
  assert.match(body, /childSessions\.set\(repoRoot, alive\)/,
    "ended children are filtered out of the registry");
  assert.match(body, /judgeProcessAlive\(c\.child\)/,
    "the sweep asks the live PROCESS (exitCode), not a pane");
  assert.doesNotMatch(body, /paneAlive|readJudgeSessionState\(\{ pidPath: c\.pidPath/, "no pane-level liveness may come back");
  // A RUNNING same-role judge cannot receive the round (a non-interactive pi
  // reads its task once, at spawn), so the dispatch is REFUSED rather than
  // reported as submitted — the failure this prevents is an agent waiting
  // forever on a round that was never delivered.
  assert.match(body, /judgeProcessAlive\(c\.child\)\);/, "the busy check asks the live process");
  assert.match(body, /decideJudgeDispatch\(\{/, "the deliver-or-refuse decision is the pure function's");
  assert.match(body, /if \(decision\.action === "refuse-busy"\) \{/, "a busy role refuses the round");
  assert.match(body, /busy: true/, "the refusal is flagged as busy, not as a crash");
  assert.match(body, /if \(decision\.action === "kill-and-spawn"\) \{/, "fresh:true takes the kill path");
  // Context reuse is a property of the SESSION: a re-spawn under the same
  // session id continues the transcript that is already on disk.
  assert.match(body, /hasTranscript: hasTranscript\(sessionDir\)/,
    "reuse is decided by the transcript, not by a live process");
  assert.match(body, /spawnJudgeProcess\(\{/, "a real spawn still exists for the no-reuse case");
  // fresh:true kills the old same-role process FIRST (singleton invariant).
  assert.match(body, /kill\?\.\("SIGTERM"\)/, "fresh kills the old process before spawning");
  assert.match(body, /childSessions\.set\(root, \(childSessions\.get\(root\) \?\? \[\]\)\.filter\(/,
    "the killed process leaves the registry");
});

test("judge_read / judge_close / judge_wait address a judge by ROLE", () => {
  // One role enum, shared by the three tools (a fourth spelling of it is how
  // two of them would silently start accepting different roles).
  assert.match(
    JUDGE_TOOLS_SRC,
    /const ROLE_PARAM = Type\.Optional\(Type\.Enum\(\{ reviewer: "reviewer", adviser: "adviser", "goal-auditor": "goal-auditor" \}\)\)/,
    "the shared role parameter is the three judge roles",
  );
  for (const tool of ["judge_read", "judge_close", "judge_wait"]) {
    const body = toolBodyOf(tool);
    assert.match(body, /role: ROLE_PARAM/, `${tool} takes a role`);
    assert.match(
      JUDGE_TOOLS_SRC,
      new RegExp(`addressJudge\\(deps, params, "${tool}"\\)`),
      `${tool} addresses its judge through the shared resolver`,
    );
  }
  // Role wins over a session id, and the lookup itself is the extension's
  // (the registry lives there) — the tools only ever ASK for it.
  assert.match(
    JUDGE_TOOLS_SRC,
    /deps\.findChild\(addressed\.root, addressed\.role, addressed\.sessionId\)/,
    "the child is resolved by role first, in the repo that was addressed",
  );
  assert.match(judgeToolsWiring(), /findChild: \(root, role, sessionId\) => findJudgeChild\(root, role, sessionId\)/,
    "…and the wiring answers it from the extension's own registry");
  // The old names are RETIRED — no alias, no compatibility shim.
  for (const gone of ["review_read", "review_close", "review_wait"]) {
    assert.ok(!SRC.includes(`name: "${gone}"`), `${gone} must no longer be registered in the extension`);
    assert.ok(!JUDGE_TOOLS_SRC.includes(`name: "${gone}"`), `${gone} must no longer be registered in lib/`);
  }
});

test("the TEN advanced entries are not registered anywhere an agent can see", () => {
  // Philosophy three, mechanically. Seven of them still exist as
  // implementations (captured into `internalHost` so `judge_submit` and
  // `propose_loop_goal` call ONE copy of each mechanical check); three were
  // deleted outright. Either way `pi` never learns the name.
  const LIB_SOURCES = readdirSync(join(ROOT, "lib"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, code: readFileSync(join(ROOT, "lib", f), "utf8") }));

  for (const tool of DELETED_TOOL_ENTRIES) {
    assert.ok(!SRC.includes(`pi.registerTool({\n    name: "${tool}"`),
      `${tool} must not be registered with pi`);
    for (const { file, code } of LIB_SOURCES) {
      if (!code.includes(`name: "${tool}"`)) continue;
      // A lib module may still DEFINE it, but the extension must hand that
      // module the `internalHost`, never `pi` alone. Two shapes exist: a
      // family that registers ONLY internal implementations takes the host as
      // its first parameter (`register…(internalHost, {`), and one that
      // registers both an agent-visible tool and an internal one takes both
      // hosts in an object (the goal family: `{ agent: pi, internal:
      // internalHost }`). Either way the wiring must NAME internalHost — and
      // the per-tool assertion that the deleted name landed on that host,
      // rather than beside it, lives in the tool's own test.
      const registrar = code.match(/export function (register\w+)\((?:host: ToolHost|hosts: \w+)/);
      assert.ok(registrar, `${file} registers ${tool}: it needs a named registrar to wire internally`);
      const callAt = SRC.indexOf(`${registrar![1]}(`);
      assert.ok(callAt > 0, `${file}'s ${registrar![1]} must be wired from the extension`);
      assert.match(SRC.slice(callAt, callAt + 200), /internalHost/,
        `${file}'s ${registrar![1]} must be wired through internalHost, not pi`);
    }
  }
  // The modules whose whole subject is gone leave nothing behind at all —
  // an unused file is how a removed path comes back.
  for (const gone of [
    "judge-relay-tools.ts", "orchestrator-read-tools.ts", "orchestrator-probe.ts",
    "orchestrator-pane-read.ts", "orchestrator-keys.ts", "attention.ts",
  ]) {
    assert.ok(!existsSync(join(ROOT, "lib", gone)), `lib/${gone} must be deleted, not left unused`);
  }
});

test("the internal host captures an implementation WITHOUT exposing it", () => {
  const at = SRC.indexOf("function captureInternalTool(");
  assert.ok(at > 0, "there is one capture point");
  const capture = SRC.slice(at, at + 400);
  assert.match(capture, /toolExecutes\.set\(s\.name, s\.execute as ToolExecute\)/,
    "the body is reachable by name for the chain…");
  assert.doesNotMatch(capture, /registerToolUpstream|pi\.registerTool/,
    "…and never reaches pi's registry");
});

test("a deleted tool name cannot appear in NEW agent-facing text (a ratchet)", () => {
  // THE DEFECT CLASS THIS EXISTS FOR. Round 1 unregistered ten tools; three
  // rounds of review then found, one at a time, prose that still told the
  // agent to CALL them — a per-turn multi-repo directive, a cross-repo unblock
  // hint, two tmux refusals, and a `/precommit` command whose entire content
  // was a tool name. Every one was found by a human reading, and the next was
  // always somewhere nobody had looked yet.
  //
  // A rule like "no imperative before the name" would have missed most of
  // them (`"). record_review / run_precommit now REQUIRE …"` has no verb in
  // front of it), and "no mention at all" is wrong: the seven internal
  // implementations legitimately name themselves, and `callTool("…")` IS the
  // wiring. So this is a RATCHET instead of a classifier. The remaining
  // mentions are counted per file and frozen; adding one fails until somebody
  // states, in this table, that the new mention is a description and not an
  // instruction. It cannot tell a good mention from a bad one — it makes a
  // human do that once, at the moment the mention is written.
  const DELETED = [
    "run_precommit", "review_checkpoint", "prepare_review", "prepare_adviser",
    "prepare_goal_audit", "record_review", "record_goal_prereview",
    "review_spawn", "review_watch", "review_send",
    "orchestrator_read", "orchestrator_key", "orchestrator_status",
    "orchestrator_send", "orchestrator_relay",
  ];
  /**
   * Mentions in agent-readable strings, per file, as of 2026-08-30.
   *
   *  - `review-prepare-tools.ts` / `advisory-prepare-tools.ts` — the internal
   *    implementations naming themselves in their own refusals.
   *  - `review-gate.ts` — `name: "…"` registrations on `internalHost`,
   *    `callTool("…")` wiring, and the internal steps' own refusal text.
   *
   * Anything ELSE is a new mention. Lower these numbers when you delete one;
   * raise one only with a reason you would defend in review.
   */
  const FROZEN: Record<string, number> = {
    "advisory-prepare-tools.ts": 3,
    // 2026-08-31: the no-checkpoint refusal (3 mentions) became the
    // empty-range exit-goal audit — the mentions are gone with it; the
    // dirty-worktree refusal keeps one self-describing mention.
    "review-prepare-tools.ts": 5,
    // The `/precommit` command's `callTool("run_precommit", …)` wiring moved
    // here with the command layer.
    "gate-command-tools.ts": 1,
    // The goal family took `record_goal_prereview` with it: ONE `name: "…"`
    // registration on the internal host in goal-tools.ts, and in
    // goal-prereview-tools.ts the tool-name union, the two `tool: "…"` /
    // `input.tool === "…"` discriminators of the shared submission check and
    // its own refusal text. Descriptions of an internal step, never an
    // instruction to call one.
    "goal-tools.ts": 1,
    "goal-prereview-tools.ts": 5,
    "review-gate.ts": 20,
  };

  const sources = [
    ...readdirSync(join(ROOT, "lib")).filter((f) => f.endsWith(".ts")).map((f) => join("lib", f)),
    join("extensions", "review-gate.ts"),
  ];
  const found: Record<string, number> = {};
  for (const rel of sources) {
    let n = 0;
    for (const line of readFileSync(join(ROOT, rel), "utf8").split("\n")) {
      const trimmed = line.trim();
      // Comments describe the code to a HUMAN; no model reads them.
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      // Only lines that carry a string literal can reach an agent.
      if (!line.includes('"') && !line.includes("'") && !line.includes("`")) continue;
      for (const tool of DELETED) n += line.split(tool).length - 1;
    }
    if (n > 0) found[rel.split("/").pop()!] = n;
  }
  assert.deepEqual(found, FROZEN,
    "a deleted tool name appeared in (or vanished from) agent-readable text. " +
    "If you ADDED one, it must be a description of an internal step, not an instruction — " +
    "say so and update FROZEN. If you REMOVED one, lower the count.");
});

/** The fifteen names that are no longer registered with pi. */
const DELETED_TOOL_NAMES = [
  "run_precommit", "review_checkpoint", "prepare_review", "prepare_adviser",
  "prepare_goal_audit", "record_review", "record_goal_prereview",
  "review_spawn", "review_watch", "review_send",
  "orchestrator_read", "orchestrator_key", "orchestrator_status",
  "orchestrator_send", "orchestrator_relay",
];

/**
 * Does this document tell an agent to use a tool that no longer exists?
 *
 * The one legitimate mention is a SENTENCE saying the name is gone, and the
 * two rules that make that exception hold up were both found by a reviewer
 * demonstrating an evasion:
 *
 *  - the exception is scoped to the sentence the name sits in, not to a
 *    window of following lines. A forward window lets "Call X now. It is no
 *    longer registered." through — and instruction-first, caveat-after is the
 *    most natural prose order there is. Prose still wraps, so the sentence is
 *    reassembled across line breaks and then cut at the first terminator.
 *  - an imperative ANYWHERE in that sentence cancels the exception, because
 *    the verb sits on either side of the name: "Call X now" and "X is
 *    deleted, but you can still call it" are the same defect.
 *
 * `\b` matters: "the gate still RUNS it internally" is a description and stays
 * exempt, while a bare "run" is an instruction. The Chinese side needs two
 * tokens, both two-character verbs: `可以` ("you may still…") and `调用`
 * ("invoke it"). The bare characters 调 and 用 are unusable here — they occur
 * inside ordinary words like 作用 and 使用, so they would flag normal prose.
 */
function deletedToolInstructions(text: string, label = "doc"): string[] {
  const lines = text.split("\n");
  const offences: string[] = [];
  lines.forEach((line, i) => {
    for (const tool of DELETED_TOOL_NAMES) {
      if (!line.includes(tool)) continue;
      const joined = lines.slice(i, i + 3).join(" ");
      const at = joined.indexOf(tool);
      const start = Math.max(0, joined.lastIndexOf("。", at) + 1, joined.lastIndexOf(". ", at) + 1);
      const endRel = joined.slice(at).search(/。|\.\s|$/);
      const sentence = joined.slice(start, at + (endRel < 0 ? joined.length : endRel) + 1);
      const imperative = /\b(call|run|use|invoke)\b/i.test(sentence) || /可以|调用/.test(sentence);
      const saysItIsGone =
        /不再|已删|已并入|删除|are \*\*not tools\*\*|no longer|not registered/.test(sentence);
      if (saysItIsGone && !imperative) continue;
      offences.push(`${label}:${i + 1} — ${line.trim().slice(0, 100)}`);
    }
  });
  return offences;
}

test("the deleted-tool rule catches the evasions, and still allows saying they are gone", () => {
  // A guard whose own semantics are untested is not a guard. Every CAUGHT row
  // below is a real evasion (the first two were demonstrated by a reviewer
  // against the previous version of this rule); every ALLOWED row is prose
  // that has to keep working, or the rule would force the docs to stop
  // explaining what happened.
  const CAUGHT: Array<[string, string]> = [
    ["instruction first, caveat after", "Call run_precommit now. It is no longer registered."],
    ["caveat, then 'you can still call it'", "`run_precommit` 已删除，但你还是可以 call 它。"],
    ["a plain instruction", "Just call run_precommit."],
    ["a bare mention with no negation at all", "The run_precommit tool records the gate."],
    // Measured by a reviewer against the `可以`-only version of this rule.
    ["Chinese: 'you still need to invoke it'", "`run_precommit` 已删除，你仍需调用它。"],
    ["Chinese: 'invoke it yourself when needed'", "`run_precommit` 已删除，必要时自己调用它。"],
  ];
  const ALLOWED: Array<[string, string]> = [
    ["a plain removal statement", "`run_precommit` is no longer registered."],
    ["the same in Chinese", "`run_precommit` 不再作为工具暴露。"],
    ["a removal statement that WRAPPED", "The precommit lane and\n`run_precommit` are **not tools** any more."],
    ["'the gate still RUNS it' — a description, not an imperative",
      "`run_precommit` is no longer registered; the gate still runs it internally."],
    // The reason the Chinese tokens are two characters: 调 and 用 alone live
    // inside ordinary words, and a rule built on them would flag these.
    ["Chinese prose containing 作用", "`run_precommit` 不再是工具，它的作用由门禁内部承担。"],
    ["Chinese prose containing 使用", "`run_precommit` 已删除，门禁内部使用同一份实现。"],
  ];
  for (const [why, text] of CAUGHT) {
    assert.notDeepEqual(deletedToolInstructions(text), [], `must be caught: ${why}`);
  }
  for (const [why, text] of ALLOWED) {
    assert.deepEqual(deletedToolInstructions(text), [], `must be allowed: ${why}`);
  }
});

test("the SHIPPED skill and the agent-facing docs name no deleted tool at all", () => {
  // The ratchet above covers code. These are the OTHER surfaces a model reads
  // — `skills/review-loop/SKILL.md` ships with the package and pi loads it as
  // a skill, and AGENTS.md is read by every session in this repo. They contain
  // no internal wiring, so unlike the code the bar here is ABSOLUTE.
  //
  // README.md and QUICKSTART.md are excluded on purpose: they are reference
  // documentation for a HUMAN and legitimately explain what the internal steps
  // do — but ONLY because a banner over the tool table says those rows describe
  // internal steps rather than callable tools. That banner is load-bearing, so
  // it is pinned here: delete it and the exemption it earns goes with it.
  assert.match(readFileSync(join(ROOT, "README.md"), "utf8"),
    /Ten entries left this table on 2026-08-30/,
    "the README banner is what earns README/QUICKSTART their exemption — it may not quietly vanish");

  const offences: string[] = [];
  for (const rel of [join("skills", "review-loop", "SKILL.md"), "AGENTS.md"]) {
    offences.push(...deletedToolInstructions(readFileSync(join(ROOT, rel), "utf8"), rel));
  }
  assert.deepEqual(offences, [],
    `an agent-facing document names a tool that is not registered:\n${offences.join("\n")}`);
});







test("judge_wait applies the three end-of-round criteria and returns conclusion + progress", () => {
  const body = toolBodyOf("judge_wait");
  assert.match(body, /clampWaitTimeout\(.*params\.timeoutMs/, "the blocking window is clamped by the gate");
  assert.match(body, /probeJudgeRound\(deps, child\)/, "the loop probes with the shared criteria");
  // The wait SKELETON is generic (lib/poll-wait.ts) and this tool only injects
  // its own criteria — the next waiter (orchestrator_wait: attention events, a
  // child's own completion) reuses the loop instead of copying it.
  assert.match(body, /await pollUntil\(\{/, "the loop itself comes from the shared waiter");
  assert.match(body, /isDone: \(o\) => o\.done/, "…with this tool's criteria injected");
  assert.doesNotMatch(body, /while \(!outcome\.done/, "no hand-rolled wait loop may come back");
  // User decision 6.2: the RETURN carries the round's own output — the shared
  // formatter decides which half (conclusion vs. progress), so the tool must
  // not assemble a reply of its own.
  assert.match(body, /formatJudgeWaitReply\(\{/, "the reply is built by the pure formatter");
  assert.match(body, /stdoutTail: readLogTail\(deps, child\.stdoutPath\)/, "both branches carry this round's stdout tail");
  assert.match(body, /findings: recentStreamFindings\(deps, child\.streamPath\)/,
    "the unfinished branch carries the newest streamed findings");
  const probe = windowIn(JUDGE_TOOLS_SRC, "export function probeJudgeRound(", "\n}", "probeJudgeRound");
  assert.match(probe, /evaluateJudgeWait\(\{/, "the criteria live in the pure module");
  assert.match(probe, /deps\.fileExists\(child\.exitCodePath\)/, "the exit-code file is one criterion");
  assert.match(probe, /child\.stdoutPath/, "the fence criterion reads stdout, where the fence is plain text");
  // The criterion is EXISTENCE, not readability: an empty exit-code file
  // still means the round is over, so the wiring may not answer it with a
  // content read.
  assert.match(judgeToolsWiring(), /fileExists: \(path\) => existsSync\(path\)/,
    "the wiring answers the exit-code criterion with existsSync");
});

test("STREAMING: every long-running gate tool publishes progress on its own onUpdate", () => {
  // Measured (.pi/gate-timings.jsonl): a review round is 8.9 min at the
  // median, a full precommit 92s. Each of these used to be a silent call.
  for (const tool of [
    "judge_wait", "judge_submit", "run_precommit", "declare_done",
    "request_copilot_review", "check_copilot_review",
  ]) {
    const body = toolBodyOf(tool);
    assert.match(body, /createProgressReporter\(\{/, `${tool} must open a progress reporter`);
    assert.match(body, /onUpdate: onUpdate as ToolUpdate \| undefined/,
      `${tool} must stream to the onUpdate IT was given`);
    assert.match(body, /progress\.step\(/, `${tool} must name at least one step`);
  }
});

test("STREAMING: the LLM guards announce themselves only when slow, on the status bar", () => {
  // A `tool_call` hook has no onUpdate at all (that is a tool's channel), so
  // the six guard calls use the status line — and only past the threshold,
  // or a 200ms round-trip would narrate itself.
  // Four of the five guards live in the L1 bash arm now; the L6 label one is
  // still the extension's (checkTestLabels).
  const guardSrc = SRC + "\n" + SHIP_BASH_SRC;
  const guarded = guardSrc.match(/await withSlowNotice\(/g) ?? [];
  assert.ok(guarded.length >= 5, `every LLM guard call must be wrapped (found ${guarded.length})`);
  for (const call of [
    /classifyNonEnglish\(classifier\(\), labels\)/,
    /classifyShipCommand\(deps\.classifier\(\), command\)/,
    /classifyAiAttribution\(deps\.classifier\(\), msgs\)/,
    /classifyNonEnglish\(deps\.classifier\(\), msgs\)/,
    /classifyNonEnglish\(deps\.classifier\(\), prTexts\)/,
  ]) {
    assert.match(guardSrc, new RegExp(`withSlowNotice\\([\\s\\S]{0,300}${call.source}`),
      `this classifier call must run inside a slow-notice: ${call}`);
  }
  // The sink is the gate's own status line, cleared when the call ends. The
  // bash arm receives it through the injected `notice` dep, so the extension
  // remains the ONE place that knows the status-bar key.
  assert.match(SRC, /statusNotice\(llmNoticeUi\(ctx\), LLM_STATUS_KEY\)/,
    "the sink is the gate's own status line, cleared when the call ends");
  assert.match(shipHookWiring(), /notice: \(ctx\) => statusNotice\(llmNoticeUi\(ctx\), LLM_STATUS_KEY\)/,
    "the bash arm gets that same sink injected, never one of its own");
  assert.match(SHIP_BASH_SRC, /const shipNotice = deps\.notice\(ctx\);/,
    "…and uses it for every guard in the ship path");
});

test("STREAMING: progress text is a partial result only — it never enters a tool's return", () => {
  // The two channels answer different questions: onUpdate is for the human
  // watching, the return value is what the agent's context pays for.
  for (const tool of ["judge_wait", "judge_submit", "run_precommit", "declare_done"]) {
    const body = toolBodyOf(tool);
    assert.doesNotMatch(body, /text: renderProgress\(/, `${tool} must not return a progress frame`);
  }
});


/**
 * Round-9 P1 (reviewer, reproduced with `/evil/elsewhere`): the verdict schema
 * and the task text said the gate checks the reviewer's `cwd` — and nothing
 * did. A stated check that does not run is worse than none, because it is
 * believed. Round-11: it is now described as what it is — a consistency check
 * on a self-reported value, which rejects a mismatching report and proves
 * nothing about who produced the verdict.
 */
test("record_review actually runs the cwd check it demands", () => {
  const at = SRC.indexOf('name: "record_review"');
  assert.ok(at > 0, "record_review must be registered");
  // Wide enough to reach the reply text: the check is near the top of the
  // handler, the message that explains it is far below.
  const body = SRC.slice(at, at + 14000);
  assert.match(body, /parsed\.cwd/, "the claimed cwd is read from the parsed verdict");
  assert.match(body, /canonicalPath\(claimed\) !== canonicalPath\(targetRoot\)/,
    "…and compared with the repo the round was prepared for, through realpath");
  assert.match(body, /cwdMismatch = "the verdict carries no `cwd`/,
    "a missing cwd is itself a failure (fail-closed), not a pass");
  assert.match(body, /if \(cwdMismatch\) parsed\.verdict = "BLOCKED";/,
    "a READY reporting the wrong directory is downgraded");
  assert.match(body, /CWD CHECK FAILED/, "and the agent is told why");
});

test("user ask 2026-08-28: the judge SESSION is the managed entity, the process is the substrate", () => {
  // The dispatcher must RECORD the session-side paths at spawn time (the
  // transcript dir, stdout/stderr logs, pid/exit-code for cross-session
  // takeover).
  const spawnAt = SRC.indexOf("function dispatchJudgeRound(");
  const spawn = SRC.slice(spawnAt, spawnAt + 11000);
  for (const field of ["sessionDir", "stdoutPath", "stderrPath", "pidPath", "exitCodePath"]) {
    assert.ok(spawn.includes(field), `a dispatched round must record ${field} at spawn time`);
  }

  // judge_read: live process ⇒ tail of the stdout log; ended ⇒ the
  // transcript + stderr, because the process is gone but its records are not.
  // The tool ASKS for each of those facts (it owns no filesystem of its own);
  // the extension's wiring is what points each question at the RECORDED path
  // of that child. Both halves are asserted — a dep bound to the wrong path
  // would read another round's records while the tool still looked right.
  const read = toolBodyOf("judge_read");
  const wiring = judgeToolsWiring();
  assert.match(read, /deps\.sessionState\(child\)/, "liveness comes from the session's artifacts");
  assert.match(wiring, /sessionState: \(child\) => readJudgeSessionState\(\{ pidPath: child\.pidPath, exitCodePath: child\.exitCodePath \}\)/,
    "…which are that child's own pid / exit-code records");
  assert.match(read, /judgeProcessAlive\(child\.child\)/, "the live PROCESS's exitCode decides running");
  assert.match(read, /!running \? deps\.conclusion\(child\) : undefined/,
    "the conclusion is read only once the process is gone");
  assert.match(wiring, /conclusion: \(child\) => readJudgeConclusion\(child\.sessionDir\)/,
    "the conclusion is parsed from the RECORDED session dir");
  assert.match(read, /!running \? deps\.stderrTail\(child\) : undefined/, "crash context survives the process");
  assert.match(wiring, /stderrTail: \(child\) => readStderrTail\(child\.stderrPath\)/,
    "…read from that child's own stderr log");

  // Round-5 P1: the child snapshot must SUPPLY lastActivityAt. It was declared
  // on the interface but never passed, so classifyChildren timed every judge
  // from its spawn and called a still-streaming review "silent".
  const settledAt = SRC.indexOf("const childSnapshots: ChildSnapshot[] = []");
  assert.ok(settledAt > 0, "the snapshot construction must exist");
  const snapshots = SRC.slice(settledAt, settledAt + 1600);
  assert.match(snapshots, /lastActivityAt: lastActivityAt\(/,
    "activity is read from the session's own writes, not left undefined");
  assert.match(snapshots, /sessionDir: c\.sessionDir, stderrPath: c\.stderrPath/,
    "…from the transcript and stderr of THAT child");
  assert.match(snapshots, /\[c\.stdoutPath\]/, "…and its stdout log");

  // judge_close: terminate the PROCESS (SIGTERM), then drop the registry.
  const close = toolBodyOf("judge_close");
  assert.match(close, /kill\?\.\("SIGTERM"\)/, "the live process is SIGTERMed");
  assert.match(close, /closed: true/,
    "closing an already-finished child still reports success (idempotent)");
  assert.match(close, /transcript and logs stay/, "the records remain inspectable after close");
});

test("L8b: propose_loop_goal checks the pre-review BEFORE any user-facing surface", () => {
  // The tool moved to lib/goal-tools.ts; the rule follows the code. The window
  // is its registration plus `doProposeLoopGoal` (the handler that registration
  // dispatches to), which is where every ordering below actually happens.
  const body = toolBodyOf("propose_loop_goal");
  const check = body.indexOf("goalPrereviewPassed(");
  assert.ok(check > 0, "the gate must consult the pre-review record");
  // Order is the whole point: a check placed after showToUser/confirmBounded
  // would still parade an unaudited draft in front of the user.
  const show = body.indexOf("showToUser(");
  const confirm = body.indexOf("confirmBounded(");
  // The write is an injected seam now (the module owns WHEN, the extension
  // owns the syscall) — the wiring is asserted with the other deps below.
  const write = body.indexOf("writeGoalFile(goalPath");
  assert.ok(show > check, "the transcript echo must come AFTER the pre-review check");
  assert.ok(confirm > check, "the dialog must come AFTER the pre-review check");
  assert.ok(write > check, "the goal file may only be written after the check");
  assert.match(body, /buildGoalPrereviewRefusal\(/, "the refusal must carry the recovery path");
  // The user sees that an audit happened, and the repo binding still cannot be
  // truncated away (the pre-review line is appended AFTER it).
  assert.match(body, /goal-auditor 预审: PASS @/);
  const repoFact = body.indexOf('"绑定仓库(不可信数据): " + repoLine');
  const prereviewLine = body.indexOf('repoLine + "\\n" + prereviewLine');
  assert.ok(repoFact > 0 && prereviewLine > 0, "both facts must reach the dialog");
});
// ---------------------------------------------------------------------------
// L8 — the loop goal is negotiated with the user, not written by the agent

test("propose_loop_goal: the USER approves in an extension dialog, and the EXTENSION writes the file", () => {
  // The tool moved to lib/goal-tools.ts (registration + `doProposeLoopGoal`);
  // the window is both, so an assertion can never be satisfied by a
  // neighbouring tool's code (round P2: the old flat window overshot into it).
  const body = toolBodyOf("propose_loop_goal");
  assert.match(body, /confirmBounded\(/,
    "the extension must render the approval dialog itself");
  assert.doesNotMatch(body, /confirmed\s*:\s*Type\./,
    "no agent-supplied 'confirmed' parameter — that would be self-approval");
  // The approval must describe text the USER saw: the extension writes the
  // file, and the sidecar records the hash of exactly that text. The syscall
  // itself is the injected seam (the extension wires it to writeFileSync).
  assert.match(body, /writeGoalFile\(goalPath/);
  assert.match(GOAL_WIRING(), /writeFileSync\(path, text, "utf8"\)/,
    "…and the wiring really writes the file the module was handed");
  assert.match(body, /(?:state|goalSt)\.loopGoal = \{ hash: goalTextHash\(goalText\)/);
  // Length-bounded, through the check BOTH goal tools share: the cap lives in
  // one place now, so the audit can never accept a draft the approval refuses.
  assert.match(body, /checkGoalDraft\(\{\n\s+tool: "propose_loop_goal"/,
    "the submission goes through the shared check");
  assert.match(GOAL_PREREVIEW_SRC, /goalText\.length > LOOP_GOAL_MAX_WRITE_CHARS/,
    "the goal must be length-bounded");
});

test("propose_loop_goal: confirm/reject may carry a user REASON (input after the dialog)", () => {
  // The user can answer "确认 + 原因" / "拒绝 + 原因" — a reason input follows
  // the Yes/No dialog. A rejection reason must be handed back to the agent so
  // it renegotiates against the real objection; an approval reason is
  // persisted with the confirmation and echoed to the agent.
  // Registration + handler, from the module that owns them now
  // (lib/goal-tools.ts) — never a flat window that could overshoot into a
  // neighbouring tool's code (round P2).
  const body = toolBodyOf("propose_loop_goal");
  assert.match(body, /uiCtx\.ui\?\..*input/, "a reason input must follow the confirm dialog");
  assert.match(body, /did NOT approve this goal\."/, "rejection path must exist");
  assert.match(body, /Reason: \$\{reason\}/, "rejection reason must reach the agent");
  assert.match(body, /\.\.\.\(reason \? \{ reason \} : \{\}\)/, "approval reason must be persisted");
  assert.match(body, /User's note on approval/, "approval reason must be echoed to the agent");
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
      //
      // An object-literal KEY (`parentSessionId: state.sessionId`) is not a
      // reference to anything and must not count — the extension passes such
      // keys to other libs' option objects all the time. Excluding a name
      // followed by `:` also excludes the rare `cond ? someExport : x`
      // ternary; that direction is safe (it can only HIDE a usage, never
      // invent one), and `npm run typecheck` catches the real thing as
      // TS2304, which is the guarantee this heuristic is only backing up.
      const used = new RegExp(`(?<![A-Za-z0-9_$.])${name}(?![A-Za-z0-9_$])(?!\\s*:)`);
      const declared = new RegExp(`(?:const|let|var|function|class|interface|type|enum)\\s+${name}\\b`);
      if (used.test(code) && !declared.test(code)) missing.push(`${file} → ${name}`);
    }
  }
  assert.deepEqual(missing, [],
    `these lib exports are used by extensions/review-gate.ts but never imported: ${missing.join(", ")}`);
});

test("review_checkpoint: the pre-review commit channel is registered with its contract", () => {
  const at = SRC.indexOf('name: "review_checkpoint"');
  assert.ok(at >= 0, "review_checkpoint must be registered");
  // Slice to the NEXT registered tool, not a fixed byte count: a magic window
  // silently starts missing assertions as soon as the body grows (it did —
  // 2026-08-29, when the L5 subject rule added comments above `st.checkpoint`).
  const bodyEnd = SRC.indexOf('name: "judge_submit"', at);
  assert.ok(bodyEnd > at, "the end anchor must still follow review_checkpoint");
  const body = SRC.slice(at, bodyEnd);
  // the gate semantics: bypasses READY only, never precommit
  assert.match(body, /bypasses READY only, never precommit/);
  assert.match(body, /nonEnglishCommitMessage\(message\)/,
    "L5: message must be English — subject strictly, body by majority");
  assert.match(body, /COMMIT_MSG_FORBIDDEN/, "round-4 P2: AI-attribution guard replicated");
  assert.match(body, /testScope !== "full"/, "round-4 P2: full precommit required");
  assert.match(body, /isSensitiveFile/, "round-4 P2: sensitive paths refused");
  assert.match(body, /st\.checkpoint = \{\s+sha,/, "round-4 P2: sha persisted to gate state");
  // R-22: a round that skipped precommit on the user's `/gate-bypass` records
  // that fact ON the checkpoint, so the reviewer and declare_done can see it.
  assert.match(body, /precommitBypassed: true/, "R-22: a bypassed round is recorded, never silent");
  assert.match(body, /const precommitBypassed = st\.bypass\.active/,
    "R-22: the bypass is what releases the precommit prerequisite");

  assert.match(body, /REVIEW_GATE_BYPASS: "1"/, "hook bypass is scoped to the child process");
});

test("the completion watcher is registered with triggerTurn semantics", () => {
  // `review_watch` — the tool that RE-registered a watcher by hand — is gone.
  // Every dispatched round registers one automatically, so it was a second
  // way to ask for something already done. The MECHANISM it drove is still
  // load-bearing, and it is what this asserts.
  //
  // The wake must be a NEW TURN — never polling, never sleeping on the agent
  // side.

  const helperAt = SRC.indexOf("function registerWatch(");
  assert.ok(helperAt >= 0, "registerWatch helper must exist");
  const helper = SRC.slice(helperAt, helperAt + 400);
  assert.match(helper, /watchRegistry\.register\(sessionId, label\)/,
    "the helper delegates to the watch registry (lib/judge-watch.ts)");
  // The registry is wired with the REAL process-exit waiter and the pi wake:
  // the wait + wake logic lives in lib/judge-watch.ts (pinned behaviorally
  // by test/judge-watch.test.ts), the extension only binds the runtime pieces.
  const registryAt = SRC.indexOf("createProcessWatchRegistry(");
  assert.ok(registryAt >= 0, "createProcessWatchRegistry must exist");
  const registry = SRC.slice(registryAt, registryAt + 1800);
  assert.match(registry, /waitForProcessExit/, "listens on the child's process exit");
  assert.match(registry, /triggerTurn: true/, "wakes an idle session");
  assert.match(registry, /deliverAs: "steer"/, "delivered as a steer");
  // The exit-event semantics + idempotency live in lib/judge-watch.ts.
  const watchLib = readFileSync(join(ROOT, "lib", "judge-watch.ts"), "utf8");
  assert.match(watchLib, /function register\(sessionId: string, label: string\): void \{/,
    "the watcher registers per session id");
  const dispatchAt = SRC.indexOf("function dispatchJudgeRound(");
  const dispatchBody = SRC.slice(dispatchAt, dispatchAt + 9000);
  assert.match(dispatchBody, /registerWatch\(sessionId, title\)/,
    "every dispatched round registers the completion watcher automatically");
  // session_shutdown must cancel the watchers.
  const shutdownAt = SRC.indexOf('pi.on("session_shutdown"');
  assert.ok(shutdownAt >= 0);
  const shutdown = SRC.slice(shutdownAt, shutdownAt + 1200);
  assert.match(shutdown, /watchRegistry\.shutdown\(\)/,
    "shutdown cancels the background watchers via the registry");
  // Round-16 Nit: shutdown latches the registry; a resumed session must be
  // able to arm watchers again (session_start calls reset()).
  const startAt = SRC.indexOf('pi.on("session_start"');
  assert.ok(startAt >= 0);
  assert.match(SRC.slice(startAt, startAt + 600), /watchRegistry\.reset\(\)/,
    "a new session re-opens watcher registration");
});

test("SECURITY: the goal approval binds to CONTENT, so a later edit drops it", () => {
  // If the check were "a confirmation exists", the agent could approve a
  // one-line goal and then rewrite the file into whatever it wanted to ship.
  assert.match(SRC, /function loopGoalConfirmed\(root: string = primaryRepoRoot, st: GateState = state\)/);
  assert.match(SRC, /isLoopGoalConfirmed\(goal, st\.loopGoal, raw\)/);
  assert.match(SRC, /return false; \/\/ unreadable/, "an unreadable goal file must fail closed");
});

// ---------------------------------------------------------------------------
// L7 — the post-PR Copilot review loop

test("the Copilot tools are TRUSTED: the extension runs gh, the agent cannot report the outcome", () => {
  for (const name of ["request_copilot_review", "check_copilot_review"]) {
    // The tools moved to lib/copilot-review-tools.ts; the rule follows the
    // code (registration + handler, via sourceOf/LIB_TOOL_HANDLERS).
    const body = toolBodyOf(name);
    // The only parameter is the repo selector — no status, no thread list, no
    // "I handled it" flag the model could fill in.
    assert.doesNotMatch(body, /status\s*:\s*Type\.|threads\s*:\s*Type\.|resolved\s*:\s*Type\./,
      `${name} must not accept an agent-reported outcome`);
    assert.match(body, /await deps\.gh\.(resolveOpenPr|fetchCopilotPayload|requestCopilotReviewer)\(/,
      `${name} must gather its own evidence via gh`);
  }
  // The evidence seam is not a place the agent can reach either: the extension
  // binds every `gh` member to the real lib/copilot-gh.ts implementation.
  const wiring = COPILOT_WIRING();
  for (const call of ["resolveOpenPr", "resolveRepoSlug", "fetchCopilotPayload", "requestCopilotReviewer", "resolveCopilotSupport"]) {
    assert.match(wiring, new RegExp(`${call}: \\([^)]*\\) =>\\s*\\n?\\s*${call}\\(`),
      `the wiring must bind ${call} to the extension's own gh call`);
  }
  // gh runs as argv through the async spawn helper (never a shell string, and
  // never a sync spawn that would freeze the host).
  assert.match(COPILOT_GH_SRC, /export async function runGh\(/);
  assert.match(COPILOT_GH_SRC, /spawn\(argv\[0\], argv\.slice\(1\)/);
  assert.doesNotMatch(COPILOT_GH_SRC, /runGh\([^)]*shell/);
  // …and the extension no longer keeps a second copy of any of it.
  assert.doesNotMatch(SRC, /function runGh\(/, "the gh runner lives in lib/copilot-gh.ts only");
});

test("SECURITY: the Copilot requirement never touches the SHIP gate (it would deadlock)", () => {
  // Fixing a Copilot finding requires a commit and a push. A Copilot
  // requirement inside the ship authority would therefore block its own
  // remedy — so it may appear only in the completion paths.
  // The whole L1 hook is the scope — all three modules AND the deps the
  // extension injects into it (a Copilot fact smuggled in through a dep would
  // deadlock exactly the same way).
  //
  // CODE only: a module docblock naming lib/copilot-review-tools.ts in the
  // list of families that moved out of the extension consults nothing. The
  // rule is about what the gate READS, so comments are stripped first — and
  // stripping them is what keeps this from being "rename the comment".
  assert.doesNotMatch(codeOnly(HOOK_BODY), /copilot/i,
    "the L1 ship gate must not consult the Copilot cycle");
  assert.doesNotMatch(codeOnly(shipHookWiring()), /copilot/i,
    "…and no injected dep may carry it in");
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
  const body = SRC.slice(settledStart, settledStart + 9000);
  assert.match(body, /problems\.length > 0 && continuationsInjected >= state\.maxRounds/);
  assert.match(body, /problems\.length === 0 && completionContinuations >= COMPLETION_CONTINUATION_CAP/);
});
test("SECURITY: a sensitive-file grant is consumed on the RESULT, not at tool_call", () => {
  const resultStart = SRC.indexOf('pi.on("tool_result"');
  assert.ok(resultStart > 0);
  // The two halves now live in different files: the CHECK is the L1 edit arm,
  // the CONSUMPTION is still the extension's tool_result handler.
  const callBody = HOOK_BODY;
  const resultBody = SRC.slice(resultStart);

  assert.match(SHIP_EDIT_SRC, /findGrant\(deps\.sensitiveGrants\(\)/,
    "tool_call only checks the grant");
  assert.doesNotMatch(callBody, /consumeGrant\(/,
    "burning the grant before the edit lands would force a new dialog after any retry");
  assert.doesNotMatch(shipHookWiring(), /consumeGrant\(/,
    "…and no injected dep may consume it either");
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
  assert.doesNotMatch(SRC, /(?<![.\w"'])fetch\s*\(/, "no JS fetch() network call");
  assert.doesNotMatch(SRC, /import\("https?:/);
  // "npx" inside regex patterns is OK; "npx " (command invocation) is not.
  assert.doesNotMatch(SRC, /['"]npx\s/);
});

test("P0-2: branch commit detection via commitsAheadOfBase", () => {
  assert.match(SRC, /commitsAheadOfBase/);
});

test("P0-5: detectShipCommands returns array", () => {
  assert.match(SHIP_BASH_SRC, /ships\.length/);
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

test("the multi-repo reminder teaches the CURRENT per-repo contract", () => {
  // This exact string once told the agent that the recording tools "target the
  // repo you most recently edited". They no longer do (an explicit `repo` is
  // required once several repos are edited), and a per-turn prompt outranks
  // every doc: a session that believed the old wording recorded round after
  // round of READY against the wrong repo and read the block as sabotage.
  //
  // 2026-08-30: the same reminder then had to stop naming `record_review` /
  // `run_precommit`, which are no longer registered — a per-turn instruction
  // pointing at a tool the model cannot call is that failure in a new costume.
  // The contract it states is unchanged; the entry point is `judge_submit`.
  const reminder = windowOf("Multi-repo session: this session has edited", "before shipping.", "multi-repo reminder");
  assert.match(reminder, /REQUIRES? an explicit `repo`/);
  assert.match(reminder, /judge_submit/, "the reminder names the ONE registered entry point");
  for (const gone of ["record_review", "run_precommit"]) {
    assert.ok(!reminder.includes(gone), `${gone} is not registered and must not be named per turn`);
  }

  assert.doesNotMatch(SRC, /target the repo you most recently edited/);
});

test("gate-lesson command registered (self-improvement loop port)", () => {
  assert.match(CMD_SRC, /registerCommand\(["']gate-lesson["']/);
  assert.match(CMD_SRC, /review-gate-lessons\.md/);
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
  const forbidden = SHIP_BASH_SRC.indexOf("COMMIT_MSG_FORBIDDEN.some");
  const semanticAttr = SHIP_BASH_SRC.indexOf("classifyAiAttribution(");
  assert.ok(forbidden > 0 && semanticAttr > forbidden,
    "regex attribution check must precede classifyAiAttribution");

  // L5: the deterministic script check must precede the semantic one —
  // anchored to the commit-msg branch (`msgs`), because the L6 edit-time
  // branch also calls classifyNonEnglish earlier in the file.
  const unicodeCheck = SHIP_BASH_SRC.indexOf("nonEnglishCommitMessage(whole)");
  const semanticEnglish = SHIP_BASH_SRC.indexOf("classifyNonEnglish(deps.classifier(), msgs)");
  assert.ok(unicodeCheck > 0 && semanticEnglish > unicodeCheck,
    "Unicode script check must precede classifyNonEnglish in the commit branch");
  // same ordering in the PR branch
  const unicodePr = SHIP_BASH_SRC.indexOf('firstNonEnglishText("pr-text", prTexts)');
  const semanticPr = SHIP_BASH_SRC.indexOf("classifyNonEnglish(deps.classifier(), prTexts)");
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
  const staticShips = SHIP_BASH_SRC.indexOf("detectShipCommands(command)");
  const shipLlm = SHIP_BASH_SRC.indexOf("classifyShipCommand(");
  assert.ok(staticShips > 0 && shipLlm > staticShips,
    "static ship detection must precede classifyShipCommand");
  const between = SHIP_BASH_SRC.slice(staticShips, shipLlm);
  assert.match(between, /ships\.length === 0/,
    "LLM ship layer must be gated on the static detector finding nothing");
});

test("LLM guards: every call site is gated on its llmGuards config flag", () => {
  // The three ship-path guards read the config in the L1 bash arm; the L6
  // label guard reads it in the extension's checkTestLabels.
  assert.match(SHIP_BASH_SRC, /projectConfig\.llmGuards\.aiAttribution/);
  assert.match(SHIP_BASH_SRC, /projectConfig\.llmGuards\.englishCheck/);
  assert.match(SHIP_BASH_SRC, /projectConfig\.llmGuards\.shipDetect/);
  assert.match(SRC, /projectConfig\.llmGuards\.englishCheck/);
});

test("L6 edit-time check scans the FULL projected file, not newText fragments", () => {
  // P1 regression guard: the extension must project via lib/edit-projection.ts.
  assert.match(SRC, /projectEditedContent\(/);
  assert.ok(SRC.includes('../lib/edit-projection.ts'), "must import lib/edit-projection.ts");
  // …and the label check runs inside the L1 EDIT arm, after the gate-owned
  // exemption and the L8 goal gate, before the edit is let through. Anchored
  // in lib/ship-gate-edit-guard.ts: `EDIT_TOOL_NAMES.has(...)` still occurs in
  // the extension's tool_result handler, so matching it there would pin
  // nothing about the edit arm at all.
  const editArm = windowIn(
    SHIP_EDIT_SRC,
    "export async function evaluateEditCall(",
    "\n}",
    "edit arm",
  );
  const goalGateAt = editArm.indexOf("deps.loopGoalEditBlockFor(absPath)");
  const labelCheckAt = editArm.indexOf("deps.checkTestLabels(");
  const passAt = editArm.indexOf("deps.markSessionEdited()");
  assert.ok(goalGateAt > 0 && labelCheckAt > goalGateAt,
    "the L6 label check must run after the L8 goal gate (a blocked write pays no LLM call)");
  assert.ok(passAt > labelCheckAt,
    "the L6 label check must run before the edit is let through");
  // The extension still owns the projection — it is what the check reads.
  assert.match(SRC, /checkTestLabels\(/, "the extension owns the L6 implementation");
  assert.match(shipHookWiring(), /editedTestContent\(input, path\)/,
    "the arm reaches it through the injected dep, with the projected content");
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
  // The extent is either a byte window or an END ANCHOR. Prefer the end
  // anchor: a byte window silently stops covering its target as soon as
  // comments grow above it (2026-08-29 — the L5 comments pushed
  // `computeFingerprint(` past the 9000 window, turning this test red only by
  // luck; a slightly smaller edit would have made it pass vacuously).
  const anchors: Array<[string, number | string]> = [
    // declare_done's own description, the orchestrator branch (R-30) and the
    // merge-waiver dialog sit between the tool name and its first fingerprint
    // call — bounded by the check that FOLLOWS the loop, not by a byte count.
    ['name: "declare_done"', "// Residual judge children"],
    ['name: "record_review"', 6000],
    ['name: "request_arbitration"', 4000],
    // Same reason: R-3's orchestrator branch returns before the loop's own
    // fingerprint, so the window is closed by the block after it.
    ['pi.on("agent_settled"', "// L7/L8 — completion-only requirements"],

    // (The ship path's own per-repo fingerprint loop moved to
    // lib/ship-gate-bash.ts and is asserted separately below — it is the same
    // rule, against the module that now owns the code.)
  ];
  for (const [anchor, extent] of anchors) {
    const at = SRC.indexOf(anchor);
    assert.ok(at >= 0, `anchor not found: ${anchor}`);
    let end: number;
    if (typeof extent === "number") {
      end = at + extent;
    } else {
      end = SRC.indexOf(extent, at);
      assert.ok(end > at, `end anchor not found after ${anchor}: ${extent}`);
      end += extent.length;
    }
    const body = SRC.slice(at, end);
    // P-multi: enforcement paths may target a non-session repo, so the
    // fingerprint arg is a variable (root), not the cwd literal — what must
    // hold is a DIRECT computeFingerprint call, never the advisory memo.
    assert.match(body, /computeFingerprint\(/,
      `${anchor} must call computeFingerprint() directly`);
    assert.ok(!body.includes("advisoryFingerprint()"),
      `${anchor} must NOT use the advisory memo`);
  }
  // The L1 ship path, same rule, against the module that now owns it: the
  // P-multi per-repo loop sits far below the ship-detection anchor, so the
  // window is bounded by the loop itself, not by a byte count that every
  // added comment invalidates.
  const shipLoop = windowIn(
    SHIP_BASH_SRC,
    "detectShipCommands(command)",
    "if (root === primaryRepoRoot) primaryFp = fp;",
    "L1 ship gate per-repo loop",
  );
  assert.match(shipLoop, /computeFingerprint\(/,
    "the ship gate must call computeFingerprint() directly");
  assert.ok(!shipLoop.includes("advisoryFingerprint()"),
    "the ship gate must NOT use the advisory memo");
  assert.ok(!HOOK_BODY.includes("advisoryFingerprint"),
    "the advisory memo must not reach the L1 hook at all");
});

test("the advisory memo never caches an UNAVAILABLE fingerprint", () => {
  // Caching the fail-closed sentinel would keep reporting "git unreadable"
  // after git recovers, and (worse) invite someone to 'fix' that by ignoring
  // the sentinel.
  const at = SRC.indexOf("function advisoryFingerprint()");
  assert.ok(at >= 0, "advisoryFingerprint must exist");
  const body = SRC.slice(at, at + 1600);
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
  // The window is a reading heuristic, not a contract: the P-multi reset
  // block, no-UI mode forcing, the normal-mode no-arm comment and the
  // snapshot cleanup at the handler head keep pushing the notice section down.
  const body = SRC.slice(at, at + 10500);
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
    // The Copilot family lives in three files now (the extension's arming
    // site, the tools, the gh access) — a disproven surface must be gone from
    // ALL of them, not just from the one it used to sit in.
    for (const [label, src] of [["the extension", SRC], ["the tools module", COPILOT_TOOLS_SRC], ["the gh module", COPILOT_GH_SRC]] as const) {
      assert.equal(src.includes(gone), false, `${gone} was disproven by measurement and must stay gone (${label})`);
    }
  }

  const at = COPILOT_TOOLS_SRC.indexOf("const requested = await deps.gh.requestCopilotReviewer(");
  assert.ok(at > 0, "the request path must exist");
  const before = COPILOT_TOOLS_SRC.slice(Math.max(0, at - 900), at);
  assert.match(before, /deps\.gh\.resolveCopilotSupport\(dir, slug, st\.copilot\?\.supportConfirmed === true, \{ signal \}\)/,
    "availability must be resolved BEFORE a round is spent");

  // The request itself is never vetoed by a read-back any more: whatever the
  // availability verdict, the round is recorded and the wait length is what
  // changes.
  const recordAbs = COPILOT_TOOLS_SRC.indexOf("recordCopilotRequest(st.copilot,", at);
  assert.ok(recordAbs > at, "the request must still be recorded");
  const body = COPILOT_TOOLS_SRC.slice(at, recordAbs);
  assert.doesNotMatch(body, /releaseCopilotReview\(st\.copilot, "UNSUPPORTED",[\s\S]{0,200}land/,
    "a request that 'did not land' must no longer release the requirement");
  assert.match(COPILOT_TOOLS_SRC.slice(recordAbs, recordAbs + 400), /supportConfirmed: support\.confirmed/,
    "confirmed evidence must be remembered in the sidecar");
});

test("the Copilot availability probe fails CLOSED: an unreadable gh answer decides nothing", () => {
  const fn = "probeCopilotHistory";
  // The probe moved with the gh access it makes (lib/copilot-gh.ts).
  const at = COPILOT_GH_SRC.indexOf(`export async function ${fn}(`);
  assert.ok(at > 0, `${fn} must exist`);
  // Bound the window at this function's own closing brace: a fixed character
  // count spills into the neighbour and lets a mutant in THIS function pass
  // unnoticed (only the neighbour's identical line is then matched).
  const rest = COPILOT_GH_SRC.slice(at + 10);
  const end = rest.indexOf("\n}\n");
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
  // The runner moved to lib/copilot-gh.ts, the tool body to
  // lib/copilot-review-tools.ts — the rule is asserted against each owner.
  const runGhAt = COPILOT_GH_SRC.indexOf("export async function runGh(");
  assert.ok(runGhAt > 0, "runGh must exist");
  const spawnAt = COPILOT_GH_SRC.indexOf("spawn(argv[0]", runGhAt);
  const guardAt = COPILOT_GH_SRC.indexOf("if (opts.signal?.aborted)", runGhAt);
  assert.ok(guardAt > 0 && guardAt < spawnAt,
    "an already-aborted signal must short-circuit BEFORE spawning (its listener never fires)");

  const requestAt = COPILOT_TOOLS_SRC.indexOf("const requested = await deps.gh.requestCopilotReviewer(");
  const body = COPILOT_TOOLS_SRC.slice(requestAt, requestAt + 3500);
  assert.match(body, /if \(!requested\.ok\)[\s\S]{0,200}if \(signal\?\.aborted\)[\s\S]{0,400}return \{/,
    "a failed request that was merely aborted must return without releasing");
});

test("a released Copilot cycle still has to report what it left unhandled", () => {
  // Releasing stops the GATE from blocking; it does not make open findings
  // disappear. The user must hear about them.
  assert.ok(COPILOT_TOOLS_SRC.indexOf("export function copilotUnhandledText(") > 0,
    "the unhandled-thread reporter must exist");
  assert.ok(COPILOT_TOOLS_SRC.indexOf("export function copilotAbandonedText(") > 0,
    "the payload-less paths need their own reporter (they have only the count)");
  const checkBody = toolBodyOf("check_copilot_review");
  assert.match(checkBody, /copilotUnhandledText\(analysis\.actionable\)/,
    "the released branch of check_copilot_review must list them");

  // The paths that ACTUALLY release with findings open are the fail-safe ones:
  // no PR, no slug, unreadable payload, a refused request, a spent budget.
  // Each of them released in total silence before, even with a sidecar that
  // still recorded open threads. Every `releaseCopilotReview` call in the two
  // tools must be accompanied by the abandoned-findings notice. The module
  // holds nothing BUT those two tools, so it is the whole window now (it used
  // to be sliced out of the extension, from one tool name to the next).
  const toolsBody = COPILOT_TOOLS_SRC;
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

test("REGRESSION: resolveOpenPr must fall back for gh versions without headRefOid", () => {
  // gh 2.4.0 rejects `--json number,headRefOid,url,state` with
  // `Unknown JSON field: "headRefOid"` — the audit log showed every Copilot
  // cycle released UNSUPPORTED on request because resolveOpenPr never
  // retried. The modern attempt must be followed by a legacy retry.
  // The resolution moved with the gh calls it makes (lib/copilot-gh.ts).
  const at = COPILOT_GH_SRC.indexOf("export async function resolveOpenPr(");
  assert.ok(at > 0, "resolveOpenPr must exist");
  const body = COPILOT_GH_SRC.slice(at, COPILOT_GH_SRC.indexOf("\n}\n", at) + 3);
  assert.match(body, /PR_VIEW_JSON_FIELDS\.modern/, "the first attempt must use the modern field set");
  assert.match(body, /PR_VIEW_JSON_FIELDS\.legacy/, "the legacy retry must use the legacy field set");
  assert.match(body, /decidePrView\(/, "the control flow must delegate to the pure decision helper");
  assert.match(body, /isUnknownJsonFieldError\(modern\.stderr\)/,
    "the legacy retry must be conditional on the field-whitelist error (P2: never retry for a real failure)");
});

test("L5 is HARD at the ship gate, and says how to fix or contest each refusal", () => {
  // L5 blocks the ship (user policy 2026-08-16) and now uses ONE rule
  // everywhere (2026-08-29). Because the rule is hard, every refusal has to
  // carry both routes: the fix, and the appeal for a genuine misjudgement.
  const callBody = windowIn(
    SHIP_BASH_SRC,
    "export async function evaluateShipCommand(",
    "\n}",
    "ship gate (bash arm)",
  );
  assert.match(callBody, /L5 \(HARD\)/, "the L5 section must be marked HARD");
  assert.match(callBody, /l5BlockReason\(/, "the wording comes from the shared function");
  assert.match(callBody, /git commit --amend/, "the commit refusal points at the fix");
  assert.match(callBody, /gh pr edit --title\/--body/, "the PR refusal points at the fix");
  assert.match(callBody, /deps\.refuseText\(/, "…and every refusal carries the appeal route");
  assert.doesNotMatch(callBody, /advisory only — never a block/,
    "the advisory-only rationale must be gone");
  assert.doesNotMatch(callBody, /predominantly non-English/,
    "the majority-policy wording must be gone with the policy");
});


test("REGRESSION: /gate-bypass actually disarms the L1 ship gate in-session", () => {
  // The /gate-bypass command wrote state.bypass but L1 never consulted it —
  // a bypassed session still blocked every ship command at tool_call (only
  // the git hooks honored it). The bash branch must step aside on
  // the bypass flag BEFORE any ship detection. The bash arm is the window —
  // never a concatenation, or the ordering could hold across a file boundary.
  const callBody = windowIn(
    SHIP_BASH_SRC,
    "export async function evaluateShipCommand(",
    "\n}",
    "ship gate (bash arm)",
  );
  const normalAt = callBody.indexOf('deps.taskMode() === "normal"');
  const bypassAt = callBody.indexOf("deps.bypassActive()");
  assert.ok(normalAt > 0 && bypassAt > normalAt,
    "the bypass check must come after the normal-mode early return");
  const detectAt = callBody.indexOf("detectShipCommands(command)");
  assert.ok(detectAt > bypassAt,
    "the bypass check must run BEFORE ship detection");
  assert.match(callBody.slice(bypassAt, bypassAt + 120), /return undefined;/,
    "bypass must early-return the bash branch");
  // …and the flag it reads is the gate's own `state.bypass.active`, injected.
  assert.match(shipHookWiring(), /bypassActive: \(\) => state\.bypass\.active/,
    "the bypass dep must be bound to the state /gate-bypass writes");
});

test("REGRESSION (P0b): the no-tests-warning is wired into the tool result and /gate-status", () => {
  // The runner prints its own warning; the EXTENSION must carry the same
  // message into the run_precommit tool result and /gate-status, or the
  // agent would see a bare PASS. Structural assertions pin the strings.
  const precommitAt = SRC.indexOf('name: "run_precommit"');
  assert.ok(precommitAt > 0, "run_precommit must exist");
  const toolBody = SRC.slice(precommitAt, SRC.indexOf("pi.registerTool({", precommitAt + 1));
  assert.match(toolBody, /skippedNote = outcome\.verdict === "PASS" && outcome\.testScope === "skipped"/,
    "the tool result must build a skipped warning");
  assert.match(toolBody, /NO tests ran in this lane/,
    "the warning text must name the dropped test step");
  assert.ok(toolBody.indexOf("skippedNote") > toolBody.indexOf("pushNote"),
    "the skipped warning must ride in the same PASS detail as the lane note");
  const statusBody = commandBodyOf(CMD_SRC, "gate-status");
  assert.match(statusBody, /tests were NOT run in this lane/,
    "gate-status must surface the skipped test step");
  assert.match(statusBody, /testScope === "skipped"/,
    "the gate-status warning must be keyed on the skipped scope");
});

test("check_copilot_review leaves a released cycle alone (no resurrection, no gh calls)", () => {
  // The loop this closes: request released the cycle as EXHAUSTED, the next
  // check re-derived it as ARMED, and declare_done was blocked again.
  // The window is the tool's own registration plus its handler, read from the
  // module that owns them (lib/copilot-review-tools.ts) — no character count.
  const body = toolBodyOf("check_copilot_review");
  const guardAt = body.indexOf("!isCopilotOutstanding(settled)");
  assert.ok(guardAt > 0, "a released cycle must short-circuit the whole check");
  for (const laterWork of ["resolveOpenPr(", "fetchCopilotPayload(", "evaluateCopilot("]) {
    const workAt = body.indexOf(laterWork);
    assert.ok(workAt > guardAt, `${laterWork} must come AFTER the released short-circuit`);
  }
  assert.doesNotMatch(body.slice(guardAt, body.indexOf("}", body.indexOf("details:", guardAt))),
    /deps\.persist|releaseCopilotReview|armCopilotReview/,
    "the short-circuit must not rewrite the state it reports");
});

// ---------------------------------------------------------------------------
// Precommit lanes + incremental review — structural invariants
// ---------------------------------------------------------------------------

test("publishing paths require a full precommit run; a commit does not", () => {
  // The split has to be applied at BOTH decision points. A missing
  // `requireFullTests` on either would let a narrowed run publish.
  assert.match(SHIP_BASH_SRC, /requiresFullPrecommit/, "the ship gate must consult the lane rule");
  const shipAt = SHIP_BASH_SRC.indexOf("const requireFullTests = ships.some(");
  assert.ok(shipAt > 0, "the ship path must derive the lane requirement from the detected commands");

  // declare_done publishes by implication, so it hardcodes the strict side.
  const doneBody = toolBodyOf("declare_done");
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
  // /gate-status moved to lib/gate-command-tools.ts, so the ONE read moved
  // with it: the extension must not read a timing at all any more, and the
  // command module must read it in exactly one place — the status readout.
  assert.doesNotMatch(SRC, /lastPrecommitTiming\(/,
    "the extension no longer reads timings — /gate-status owns the only read");
  assert.match(commandBodyOf(CMD_SRC, "gate-status"), /lastPrecommitTiming\(/,
    "the only timings read must be inside /gate-status");
  assert.equal((CMD_SRC.match(/lastPrecommitTiming\(/g) ?? []).length, 1,
    "exactly one timings read site");
  for (const [name, text] of [["review-gate.ts", SRC], ["gate-command-tools.ts", CMD_SRC]] as const) {
    assert.ok(!/unmetRequirements\([^)]*Timing/.test(text),
      `${name}: no timing value may enter the ship authority`);
  }
});

test("the extension never calls require() (ESM type-stripped runtime)", () => {
  // Pi loads these .ts sources with node's type stripping in ESM mode, where
  // `require` is undefined — a call would throw ReferenceError the first time
  // that line runs (a small-diff single-shard prompt did exactly this until
  // the constants were imported instead). The extension must import statically.
  assert.doesNotMatch(SRC, /require\(/);
  assert.match(SRC, /REVIEW_VERDICT_SCHEMA/);
});

test("extension entry's relative imports resolve to existing files (package layout)", () => {
  const entry = join(ROOT, "extensions", "review-gate.ts");
  const src = readFileSync(entry, "utf8");
  const imports = [...src.matchAll(/from "(\.\.[^"]+|\.\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(imports.length > 10, `expected many relative imports, found ${imports.length}`);
  const missing = imports
    .map((spec) => ({ spec, abs: resolve(dirname(entry), spec) }))
    .filter(({ abs }) => !existsSync(abs));
  assert.deepEqual(
    missing.map((m) => `${m.spec} → ${m.abs}`),
    [],
    "relative imports must resolve to real files under the package layout",
  );
});

// ---------------------------------------------------------------------------
// Round-8 P2: commit-mode machinery is present and wired (structural tests)
// ---------------------------------------------------------------------------

test("P2: prepare_review registers the commit target (baseline/head/tree) for record_review", () => {
  // The commit execution model: prepare materializes NO snapshot worktree —
  // it records the immutable baseline..HEAD range so record_review can verify
  // the reviewer judged exactly the commits that exist, and bind a READY to
  // the reviewed TREE (content binding, squash survives).
  // prepare_review moved to lib/, so the registration is now split in two and
  // BOTH halves are asserted: the tool builds the target (with the tree, which
  // is what a READY binds to), and the extension's wiring is what actually puts
  // it in the map record_review reads.
  assert.match(REVIEW_PREPARE_SRC, /deps\.registerReviewTarget\(root, \{ baseline, head, tree \}\)/);
  assert.match(REVIEW_PREPARE_WIRING(), /registerReviewTarget: \(root, target\) => \{ reviewTargets\.set\(root, target\); \}/);
  // And the map must be consulted inside record_review, not just written.
  assert.match(SRC, /reviewTargets\.get\(targetRoot\)/);
});

test("P2: record_review withholds a READY when the round was never prepared", () => {
  // No registered target ⇒ the round was never prepared ⇒ a READY has nothing
  // to bind to ⇒ withheld (BLOCKED). The mechanical guard, not honour-based.
  const segment = SRC.slice(SRC.indexOf('name: "record_review"'));
  assert.match(segment, /if \(!target_\)/);
  assert.match(segment, /nothing to bind/);
});

test("P2: record_review downgrades a READY to BLOCKED when HEAD moved past the prepared commit (STALE)", () => {
  // A new checkpoint after prepare_review means the reviewer judged an older
  // commit and the change under review has since grown — READY must not bind.
  const segment = SRC.slice(SRC.indexOf('name: "record_review"'));
  assert.match(segment, /STALE/);
  assert.match(segment, /headNow !== target_\.head/);
  assert.match(segment, /staleTarget/);
});


test("P2: checkpoint carries prevSha so the documented checkpoint→prepare flow does not self-lock", () => {
  // Round-8 P1-1: if review_checkpoint records its OWN commit as the baseline
  // start, prepare_review computes an empty baseline..HEAD and rejects the
  // documented flow. The recorded checkpoint must point at HEAD^ as prevSha.
  const gateState = readFileSync(join(ROOT, "lib", "gate-state.ts"), "utf8");
  assert.match(gateState, /prevSha/);
  const ext = SRC.slice(SRC.indexOf('name: "review_checkpoint"'));
  assert.match(ext, /prevSha/);
});




test("O-6: the gate closes the internal auditor it dispatched, in BOTH audit paths", () => {
  // Round-5 O-6: propose_loop_goal and orchestrator_plan({submit}) each dispatch
  // a goal-auditor judge INTERNALLY. Leaving it registered made declare_done
  // refuse on a judge child the caller was never told about. The mechanism is
  // "whoever dispatched it closes it": each audit calls judge_close for the
  // goal-auditor after recording. judge_close's OWN removal from the registry
  // (childSessions → []) is proven behaviourally in
  // test/judge-session-tools.test.ts; this pins that the audits actually make
  // that call, so deleting either one turns a test red (the exact gap the
  // reviewer found: without this, removing both close calls left the suite green).
  const goalAt = SRC.indexOf("async function runGoalAudit(");
  const goal = SRC.slice(goalAt, SRC.indexOf("async function auditPlanRound("));
  assert.ok(goalAt > 0 && goal.length > 0, "the goal-audit function exists");
  assert.match(goal, /callTool\("judge_close", \{ role: "goal-auditor", repo: root \}, ctx\)/,
    "the goal audit closes its auditor after recording the verdict");

  const planAt = SRC.indexOf("async function auditPlanRound(");
  const plan = SRC.slice(planAt, planAt + 3500);
  assert.ok(planAt > 0, "the plan-audit function exists");
  assert.match(plan, /const closeAuditor = \(\) => callTool\("judge_close", \{ role: "goal-auditor", repo: root \}/,
    "the plan audit defines the close");
  assert.match(plan, /await closeAuditor\(\);/, "…and calls it before every return path");

  // Exactly the two gate-internal closes exist — no more (a stray one would be a
  // second, unaccounted-for path), no fewer (the gap the reviewer found).
  const internalCloses = [...SRC.matchAll(/callTool\("judge_close", \{ role: "goal-auditor"/g)];
  assert.equal(internalCloses.length, 2, "one internal close per audit path, and only those");
});


test("review_checkpoint REFUSES outright on a PROTECTED branch — no dialog, fail-closed", () => {
  const body = toolBodyOf("review_checkpoint");
  assert.match(body, /isProtectedBranch\(here\)/, "the protected-branch guard must exist");
  assert.match(body, /currentBranch\(root\)/, "the current branch is read per repo");
  assert.match(body, /checkpoint 拒绝/, "a protected branch refuses the checkpoint");
  assert.match(body, /isError: true/, "the refusal is an error");
  assert.doesNotMatch(body, /在受保护分支上提交 checkpoint/, "no confirmation dialog is shown");
  assert.doesNotMatch(body, /askEitherSide\(/, "no channel ask for a protected branch");
  assert.doesNotMatch(body, /picked\.startsWith\("否"\)/, "no decline path — the refusal is unconditional");
});



test("judge_submit builds the task for EVERY role, and a goal audit streams its findings", () => {
  // Same asserted window as the entry test above: the relay wiring closes it.
  const body = windowOf('name: "judge_submit"', "\n  // `review_spawn`", "judge_submit body");
  // The agent hands over a draft or a question; the gate builds what the
  // judge actually receives.
  assert.match(body, /callTool\("prepare_goal_audit", \{ goal: task, repo: root \}/);
  assert.match(body, /callTool\("prepare_adviser", \{ repo: root \}/);
  assert.match(body, /extractTaskText\(toolText\(prepared\)\)/);
  // The audited DRAFT is remembered: the verdict binds to its content, and
  // the auditor's output alone cannot say what it judged.
  assert.match(body, /pendingGoalAudits\.set\(root, \{ draft: task, startedAt:/);
  // Criterion 2: a goal audit streams findings, so the draft can be fixed
  // while the auditor is still working.
  assert.match(body, /buildStreamDirective\(streamPath\)/);
  assert.match(body, /review-stream", `goal-\$\{goalTextHash\(task\)/);
  // Criterion 1: the stream path comes BACK to the agent — a channel written
  // but never read is not a channel.
  assert.match(body, /streamPath,/, "the reply carries the stream path");
  assert.match(body, /findings 流（边审边修）/, "and names it in the text too");
  // The audited draft is remembered only after the dispatch is ACCEPTED: a
  // refused submission must not overwrite what a running audit is judging.
  const acceptedAt = body.indexOf("if (!dispatch.ok)");
  const setAt = body.indexOf("pendingGoalAudits.set(root");
  assert.ok(acceptedAt > 0 && setAt > acceptedAt, "the draft is recorded after the dispatch is accepted");
  // …and the recording side closes the loop with that same draft.
  const recAt = SRC.indexOf("async function recordJudgeConclusion(");
  const rec = SRC.slice(recAt, recAt + 4000);
  assert.match(rec, /callTool\("record_goal_prereview", \{/);
  assert.match(rec, /goal: pending\.draft/);
  assert.match(rec, /auditStartedAt: pending\.startedAt/);
  assert.match(rec, /pendingGoalAudits\.delete\(/, "a recorded audit does not linger");
});


test("judge_submit runs the whole submission chain, and cannot dead-end on it", () => {
  const body = windowOf("async function submitForReview(", "\n  /**", "submitForReview");
  // Each step is the TOOL's own execute — one implementation, one set of
  // mechanical checks.
  assert.match(body, /callTool\(\s*"run_precommit",\s*\{ mode: "full"/);
  // …and each step reports itself, so a stalled round shows WHERE it stalled.
  for (const step of [/step\("precommit \(full\)"\)/, /step\("checkpoint 提交"\)/, /step\("prepare/]) {
    assert.match(body, step, "every chain step publishes progress");
  }
  assert.match(body, /callTool\("review_checkpoint", \{ message, repo: input\.root \}/);
  assert.match(body, /callTool\(\s*"prepare_review"/);
  // A CLEAN worktree means the round is already frozen — treating it as a
  // failure stranded the commit and dead-ended every retry (round-5 P1).
  assert.match(body, /if \(commit\.isError\) \{/);
  assert.doesNotMatch(body, /commit\.details\?\.committed === false/,
    "a clean worktree must not fail the chain");
  // The polish gate's reason must be able to travel, or a round after two
  // READYs could never be submitted through the one sanctioned entry (round-5 P1).
  assert.match(body, /input\.reason \? \{ reason: input\.reason \} : \{\}/);
  const submit = toolBodyOf("judge_submit");
  assert.match(submit, /reason: Type\.Optional/, "judge_submit takes the polish reason");
  assert.match(submit, /reason: params\.reason \? String\(params\.reason\) : undefined/,
    "and passes it into the chain");
});

test("a judge's verdict is recorded from THIS round's output, never the transcript's history", () => {
  const at = SRC.indexOf("async function recordJudgeConclusion(");
  const body = SRC.slice(at, at + 1800);
  // The transcript accumulates every round, so its last fence can belong to a
  // PREVIOUS one — recording that would bind a READY to a tree nobody judged.
  assert.match(body, /readRoundStdout\(child\.stdoutPath\)/);
  assert.doesNotMatch(body, /readJudgeConclusion\(child\.sessionDir\)/,
    "the whole-session transcript must not decide this round (round-5 P1)");
  assert.match(body, /hasJudgeFence\(roundOutput\)/, "no fence this round ⇒ nothing is recorded");
  const wider = SRC.slice(at, at + 3000);
  assert.match(wider, /repo: repoOfChild\(child\)/, "the record names its repo explicitly");
  // A question is not a verdict: it must NOT be pushed through the recorder,
  // where it would surface as "no recognizable verdict" (a parse error) even
  // though the judge simply asked something.
  assert.match(wider, /提了一个问题（没有 verdict）/, "a question fence is reported as a question");
  assert.match(body, /child\.role === "adviser"/, "advice is not a verdict");
});


test("every advanced entry says it is one, and none teaches the retired manual flow", () => {
  // The tool list is the surface an agent reads EVERY turn: a description
  // still saying "call this before spawning the reviewer" is enough to send
  // it back to the four-step dance judge_submit replaced.
  const advanced = [
    "run_precommit", "review_checkpoint", "prepare_review", "record_review",
    "prepare_goal_audit", "prepare_adviser", "record_goal_prereview",
  ];
  for (const tool of advanced) {
    // Three of these now live in lib/ tool modules — the rule follows the code.
    const src = sourceOf(tool);
    const at = src.indexOf(`name: "${tool}"`);
    assert.ok(at > 0, `${tool} must be registered`);
    const desc = src.slice(at, src.indexOf("parameters: Type.Object({", at));
    assert.match(desc, /ADVANCED \/ internal/, `${tool}'s description must say it is an advanced entry`);
    assert.match(desc, /judge_submit|the gate records/, `${tool} must point at the normal path`);
    assert.doesNotMatch(desc, /review_spawn/, `${tool} must not teach the retired spawn call`);
    assert.doesNotMatch(desc, /ALWAYS call this before|Call this before dispatching|Call after every review round/,
      `${tool} must not teach the retired manual ordering`);
  }
});

// ---------------------------------------------------------------------------
// The orchestration layer's WIRING.
//
// Everything it decides is unit-tested in lib/orchestrator-*.ts; what cannot
// be unit-tested is that the extension actually CALLS those decisions, and in
// the right place. These tests cover exactly that seam.
// ---------------------------------------------------------------------------

test("the orchestration layer is wired in, and its logic did NOT land in this file", () => {
  // The point of the split: this file is the repository's own worst example of
  // the architecture rule this round introduces, so the orchestration layer
  // must not grow it.
  assert.match(SRC, /registerOrchestratorStateTools\(pi, orchestratorDeps\)/);
  assert.match(SRC, /registerOrchestratorSessionTools\(pi, orchestratorDeps\)/);
  for (const banned of ["buildSpawnPaneArgv", "buildSendMessageArgv", "scheduleNextTasks", "parsePlan("]) {
    assert.ok(!SRC.includes(banned),
      `${banned} belongs in lib/orchestrator-*.ts — the extension only wires the layer up`);
  }
});

test("the orchestration deps hand over only what the EXTENSION owns", () => {
  const deps = windowOf("createOrchestratorDeps({", "});", "orchestrator deps");
  assert.match(deps, /taskMode: \(\) => state\.taskMode/);
  assert.match(deps, /loadRuntime: \(\) => state\.orchestrator/);
  assert.match(deps, /orchestrationId: currentOrchestrationId/);
  // Constraint 10 is gone (2026-09-07): no work-branch landing to settle.
});

test("PROMPTS are asymmetric: the orchestrator gets the contract, a child gets one line", () => {
  // Anchored INSIDE before_agent_start on purpose: `taskMode === "orchestrator"`
  // now also branches in agent_settled (R-3 — the loop's RESUME must never
  // reach a project manager), and that branch appears earlier in the file.
  const block = windowOf(
    'if (state.taskMode === "orchestrator") {',
    "\n    }\n",
    "orchestration prompt",
    SRC.indexOf('pi.on("before_agent_start"'),
  );

  assert.match(block, /ORCHESTRATOR_DIRECTIVE/);
  assert.match(block, /formatInheritanceBrief/, "a relay successor is told what it inherited");
  // F13 — the orchestrator branch RETURNS. Falling through appended the loop
  // block ("negotiate a loop goal → judge_submit reviewer → declare_done"),
  // which contradicts constraint 2 clause by clause and quoted the CHILD's
  // unmet gates out of a shared sidecar. Its contract is the plan.
  assert.match(block, /buildOrchestratorExitBlock\(orchestrationDoneProblems\(\)\)/,
    "an orchestrator is told the PLAN's exit contract, not the loop's");
  assert.match(block, /return \{ systemPrompt \};/,
    "and it returns before the loop block can be appended");

  // A child must NOT be handed the plan: knowing it makes it optimize for the
  // plan instead of for its own task (task book §5, a user requirement).
  // Searched from the orchestrator prompt block, not from the top of the
  // file: `isOrchestrationChild()` is also consulted elsewhere, and pinning
  // the wrong occurrence would make this assertion vacuous.
  const promptAt = SRC.indexOf('if (state.taskMode === "orchestrator") {\n      systemPrompt +=');
  assert.ok(promptAt > 0, "the orchestration prompt block must be findable");
  const childAt = SRC.indexOf("if (isOrchestrationChild()) {", promptAt);
  assert.ok(childAt > promptAt, "the child branch is its own statement now that the orchestrator returns");
  const childBranch = SRC.slice(childAt, childAt + 200);

  assert.match(childBranch, /CHILD_OF_ORCHESTRATOR_DIRECTIVE/);
  // (`(?<!CHILD_OF_)` so the child's OWN one-liner does not match the
  // orchestrator's directive by being a suffix of it.)
  assert.doesNotMatch(childBranch, /(?<!CHILD_OF_)ORCHESTRATOR_DIRECTIVE|formatPlanSummary|orchestrationDoneProblems/);

});

test("declare_done consults the ORCHESTRATION's exit contract, not just this session's gates", () => {
  const body = toolBodyOf("declare_done");
  assert.match(body, /completionProblems\.push\(\.\.\.orchestrationDoneProblems\(\)\)/,
    "an orchestrator writes no code, so every ordinary gate would pass with its plan half-run");
  const helper = windowOf("function orchestrationDoneProblems()", "\n  }", "orchestrationDoneProblems");
  assert.match(helper, /if \(state\.taskMode !== "orchestrator"\) return \[\]/,
    "it must be inert for every other mode");
});

test("R-30: declare_done and orchestrator_status answer with the SAME function, so they cannot disagree", () => {
  // Measured on 2026-08-30: with the plan complete, no live children and no
  // open decisions, `orchestrator_status` said "没有了，可以 declare_done"
  // while declare_done rejected for "code review gate is PENDING / precommit
  // has not run" — criteria a project manager can never meet, because
  // constraint 2 forbids it from writing the code a review would judge. Two
  // answers to one question; here it was a functional deadlock.
  const body = toolBodyOf("declare_done");
  assert.match(body, /const orchestratorMode = state\.taskMode === "orchestrator"/);
  assert.match(body, /if \(orchestratorMode\) \{[\s\S]{0,600}?problems\.push\(\.\.\.orchestrationDoneProblems\(\)\);/,

    "in orchestrator mode the PLAN is the whole criterion");
  assert.match(body, /orchestrator_status/,
    "and the refusal points at the tool that lists the very same items");
  // The loop-only requirements must be inside the non-orchestrator branch:
  // a supervisor has no loop goal to approve and no Copilot cycle to close.
  assert.match(body, /if \(!orchestratorMode\) \{[\s\S]*LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK/);
});

test("R-3: an orchestrator never receives the LOOP's continuation — its criteria are the plan's", () => {
  // The loop's `[REVIEW_GATE_RESUME]` fired at a project manager twice in the
  // second run, quoting unmet gates read from the SUPERVISOR's own sidecar —
  // a review and a precommit it will never have. The nudge could never be
  // satisfied, so it would have kept firing to the end of the session.
  const settled = windowOf('pi.on("agent_settled"', "// L7/L8 — completion-only requirements", "agent_settled");
  assert.match(settled, /if \(state\.taskMode === "orchestrator"\) \{\s*\n\s*orchestratorSettled\(ctx\);\s*\n\s*return;/,
    "it branches BEFORE the loop's own unmet-requirement computation");
  const own = windowOf("function orchestratorSettled(", "\n  }", "orchestratorSettled");
  assert.match(own, /buildOrchestratorResume\(/, "and it has a continuation of its own");
  assert.match(own, /sessionExitProblems\(\)/, "built from the UNIFIED exit criterion");
  assert.match(own, /startSupervisionTimer\(ctx\)/, "which also arms the background supervisor");
  assert.doesNotMatch(own, /unmetRequirements|LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK/,
    "and never from the loop's gates");
});

test("the background supervisor is wired, default-on in orchestrator mode, and cleaned up", () => {
  const start = windowOf("function startSupervisionTimer(", "\n  }", "startSupervisionTimer");
  assert.match(start, /SUPERVISION_INTERVAL_MS/, "the cadence is a named constant, not a literal at the call site");
  assert.match(start, /state\.taskMode !== "orchestrator"/, "it exists only for the supervising role");
  assert.match(start, /ctx\.isIdle\?\.\(\)/, "a wake-up mid-turn would be noise");
  assert.match(start, /triggerTurn: true/, "an idle supervisor is WOKEN, not merely written to");
  // What it reads is the CHANNELS — no pane is captured anywhere in the loop.
  const drain = windowOf("function drainSupervisionNews(", "\n  }", "drainSupervisionNews");
  assert.match(drain, /superviseChildren\(\{/, "the read is the supervisor module's");
  assert.match(drain, /deps\.supervisionMemory\(\)|orchestratorDeps\.supervisionMemory\(\)/,
    "the event memory is SHARED with orchestrator_wait, so neither re-rings what the other reported");
  assert.doesNotMatch(drain, /capture-pane/, "and nothing in it renders a terminal");
  const shutdown = windowOf('pi.on("session_shutdown"', "\n  });", "session_shutdown");
  assert.match(shutdown, /stopSupervisionTimer\(\)/, "a leaked timer would keep waking a session that is gone");
});



test("R3-5: an accepted declare_done WRITES the completion record, before the loop bookkeeping", () => {
  // The gate knew the task was finished and wrote that nowhere, so a
  // supervising orchestrator was reduced to reading the child's terminal —
  // and read "working" for 725 seconds on a child that had finished.
  const done = windowOf('name: "declare_done"', "registerGoalTools(", "declare_done");
  const write = done.indexOf("state.completion = {");
  assert.ok(write > 0, "declare_done must record its own acceptance");
  assert.match(done.slice(write, write + 200), /merge: "none"/,
    "no landing step anymore — the completion records 'none'");
  assert.ok(write < done.indexOf("st.rounds = [];"),
    "…and before the loop reset, which must never be able to erase it");
  assert.doesNotMatch(done.slice(write), /delete state\.completion|state\.completion = undefined/,
    "'this task was completed at T' stays true for the rest of the session");
});

test("R3-5: a new edit CLEARS the completion record, in both repo branches", () => {
  // The other half of "written once, never invalidated": an orchestrator
  // reads this record to call a child `done`, and a session that starts
  // editing again is working — whoever asked it to, including a human typing
  // straight into the pane, which no orchestration tool can observe.
  // Both edit branches (primary + cross-repo) must clear the completion;
  // the downgrade itself lives in invalidateBindings (2026-08-31), so the
  // anchor is the shared downgrade call.
  const edits = SRC.split("invalidateBindings(");
  assert.ok(edits.length >= 2, "the edit accounting must still exist (via invalidateBindings)");
  const clears = SRC.match(/delete (?:s|state)\.completion;/g) ?? [];
  assert.equal(clears.length, 2,
    "both the primary-repo and the cross-repo edit branches must expire it");
});





test("R-10: the loop goal file is per SESSION, and every read/write goes through the one helper", () => {
  assert.match(SRC, /function loopGoalPathIn\(root: string\): string \{\s*\n\s*return pathJoin\(root, loopGoalRelPath\(SESSION_STATE_VARIANT\)\)/);
  assert.match(SRC, /function readSessionLoopGoal\(root: string\): LoopGoal/);
  // Nothing may reach the shared path directly any more: two orchestration
  // children share one worktree, and the second approval would overwrite the
  // first — the file the reviewer verifies against.
  const direct = SRC.match(/pathJoin\((?:root|target\.root|goalRoot|primaryRepoRoot), LOOP_GOAL_RELPATH\)/g) ?? [];
  assert.deepEqual(direct, [], "every goal path is built from the session's own variant");
  const bareReads = SRC.match(/[^n]readLoopGoal\((?:root|primaryRepoRoot)\)/g) ?? [];
  assert.deepEqual(bareReads, [], "and every read carries the variant too");
});


test("set_gate_mode refuses orchestrator where the role is impossible or unsafe", () => {
  const body = toolBodyOf("set_gate_mode");
  const guard = body.slice(body.indexOf('if (requested === "orchestrator")'));
  assert.ok(guard.length > 0, "the orchestrator preconditions must exist");
  assert.match(guard, /!process\.env\.TMUX/, "its children ARE panes — no tmux, no role");
  assert.match(guard, /ORCHESTRATOR_NEEDS_TMUX/);
  assert.match(guard, /isOrchestrationChild\(\)/,
    "a child must never take over the orchestration that supervises it");
});

test("a spawner's requested mode applies only to a clean, undecided, interactive session", () => {
  const block = windowOf("const requestedBySpawner = requestedModeFromEnv()", "\n    }\n", "spawner mode");
  assert.match(SRC, /if \(ctx\.hasUI && state\.taskMode === undefined\) \{\n\s*const requestedBySpawner/,
    "it is a FIRST classification only — never a way to re-decide a session");
  assert.match(block, /isEnforcedMode\(requestedBySpawner\)/,
    "a spawner may hand over a tighter starting point, never a looser one");
  assert.match(block, /!== "orchestrator" \|\| process\.env\.TMUX/);
});

test("the file-size gate runs at the CHECKPOINT, and only new files can block it", () => {
  const body = toolBodyOf("review_checkpoint");
  assert.match(body, /fileSizeVerdict\(sizeFacts\)/);
  assert.match(body, /isNew = true/, "membership in HEAD is what makes a file new");
  const blockAt = body.indexOf("sizeCheck.blocking.length > 0");
  assert.ok(blockAt > 0, "an oversized NEW file must refuse the checkpoint");
  assert.ok(body.indexOf("git\", [\"add\", \"-A\"") > blockAt,
    "the refusal has to happen BEFORE anything is staged");
  assert.match(body, /sizeCheck\.advisory\.length \? "\\n\\n" \+ formatFileSizeVerdict/,
    "an existing oversized file is a reminder carried on the SUCCESS reply, never a block");
});

test("SURVIVAL INVARIANT: every ENFORCED mode arms the loop, orchestrator included", () => {
  // Round-1 P1: `loopArmed = mode === "loop"` disarmed L2 auto-continuation
  // the moment a session entered orchestrator mode — and that session is the
  // one that needs the invariant most (it supervises children overnight) and
  // the one that can never re-arm the old way, because constraint 2 forbids
  // it from editing code and its plan writes go through a tool, not the edit
  // path. It could end its turn with children running and gates unmet.
  const setMode = windowOf("function setTaskMode(", "\n  }", "setTaskMode");
  assert.match(setMode, /loopArmed = isEnforcedMode\(mode\)/,
    "arming must ask the helper, not compare to one mode name");
  assert.doesNotMatch(setMode, /loopArmed = mode === "loop"/);
  // The two early-return sites must exclude only the ADVISORY modes, so
  // orchestrator keeps both the watchdog and auto-continuation.
  for (const anchor of ['pi.on("agent_settled"', "childWaitTimer"]) {
    const at = SRC.indexOf(anchor);
    assert.ok(at > 0, `${anchor} must exist`);
  }
  const advisoryReturns = [...SRC.matchAll(
    /state\.taskMode === "explore" \|\| state\.taskMode === "normal"/g,
  )];
  assert.ok(advisoryReturns.length >= 2,
    "the advisory-mode early returns name explore and normal explicitly — orchestrator is never in that set");
});

test("REVIVAL TIMER: the human stops it respects are real bindings, not literals", () => {
  // P1 (2026-08-30): `arbitrationPaused: false` was a literal — the fourth
  // human stop was advertised in docs/module-map.md but never wired, so an
  // arbiter ruling that paused the gate still woke the session every 60s.
  // Every human-stop field the revival timer passes must read REAL state.
  const revival = windowOf("function startRevivalTimer(", "function stopRevivalTimer", "startRevivalTimer");
  assert.match(revival, /aborted: lastRunAborted/, "ESC pause reads the real abort flag");
  assert.match(revival, /awaitingAnswer: !!state\.pausedQuestion/, "ask_user pause reads the real paused question");
  assert.match(revival, /bypassed: state\.bypass\.active/, "bypass reads the real bypass state");
  assert.match(revival, /arbitrationPaused,/, "arbitration pause reads the real flag, not a literal false");
  assert.doesNotMatch(revival, /arbitrationPaused: false/, "no literal false may stand in for the arbitration stop");
  // And the flag is SET where the human actually pauses, CLEARED where work
  // resumes — armLoop() is the single re-arm path that clears it.
  assert.match(SRC, /if \(choice === "Pause gate and wait"\) \{[\s\S]{0,200}?arbitrationPaused = true;/,
    "the arbitration pause branch sets the flag");
  const armLoop = windowOf("function armLoop()", "let arbitrationPaused", "armLoop");
  assert.match(armLoop, /arbitrationPaused = false;/, "armLoop clears the arbitration pause");
});


test("the tmux backstop sits above /gate-bypass", () => {
  const handler = windowIn(
    SHIP_BASH_SRC,
    "export async function evaluateShipCommand(",
    "\n}",
    "ship gate (bash arm)",
  );
  const guardAt = handler.indexOf("detectForbiddenTmux(");
  const bypassAt = handler.indexOf("if (deps.bypassActive()) return undefined;");
  assert.ok(guardAt > 0 && bypassAt > 0);
  assert.ok(guardAt < bypassAt,
    "a bypass is the user's escape from the SHIP gate — it was never a licence to destroy their tmux session");
});
