import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "extensions", "review-gate.ts"), "utf8");
/**
 * THE LOOP'S `agent_settled` HANDLER — the anchor every window in this file
 * scans from.
 *
 * NOT the bare event literal. The extension registers MORE THAN ONE handler
 * for `agent_settled`: a judge pane has its own (the model-fallback wiring,
 * 2026-09-10, registered EARLIER in the file) and the thinking-loop notice has
 * a third. `indexOf('pi.on("agent_settled"')` therefore stopped meaning "the
 * loop's handler" the moment that landed — this signature is the loop's alone
 * (async, with the ctx parameter), and every window below is about the loop.
 */
const LOOP_SETTLED = 'pi.on("agent_settled", async (_event, ctx) => {';
/**
 * The judge tools that observe/end a session moved to lib/ (they are wired
 * from the extension, not written in it). Their structural rules did not
 * move with them — they are asserted here, against the module that now owns
 * them, so a rule cannot quietly disappear along with the code it covers.
 */
/** The mode registry owns the static prompt sections the extension used to inline. */
const GATE_MODES_SRC = readFileSync(join(ROOT, "lib", "gate-modes.ts"), "utf8");
const JUDGE_TOOLS_SRC = readFileSync(join(ROOT, "lib", "judge-session-tools.ts"), "utf8");
/** The audit-round engine: one round, four kinds, one cursor write. */
const AUDIT_ROUND_SRC = readFileSync(join(ROOT, "lib", "audit-round.ts"), "utf8");
/** The child side of the channel — where the state derivation lives (2026-09-09). */
const CHILD_CHANNEL_SRC = readFileSync(join(ROOT, "lib", "orchestrator-child-channel.ts"), "utf8");
/** The ship authority every ship path shares, and the sidecar writer. */
const GATE_STATE_SRC = readFileSync(join(ROOT, "lib", "gate-state.ts"), "utf8");
const JUDGE_SESSION_TOOLS = new Set(["judge_close", "judge_wait"]);

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
const SESSION_TOOLS_SRC = readFileSync(join(ROOT, "lib", "orchestrator-session-tools.ts"), "utf8");
const HANDOFF_TOOLS_SRC = readFileSync(join(ROOT, "lib", "session-handoff-tools.ts"), "utf8");
const EXCLUSIVITY_SRC = readFileSync(join(ROOT, "lib", "session-exclusivity.ts"), "utf8");
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
const COPILOT_TOOLS = new Set(["copilot_review"]);
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
const CONSENT_TOOLS = new Set(["request_scope_limit", "request_sensitive_edit", "request_tmux_access"]);
/**
 * The GOAL family moved the same way, split by the same rule: the APPROVAL
 * (`propose_loop_goal` — run the audit, ask the user, write the file) in one
 * module, the AUDIT RECORD (`recordGoalPrereview` — read the auditor's
 * structured conclusion, adjudicate it, persist it) plus the checks they share
 * in the
 * other. lib/goal-tools.ts is the family's single registration entry point —
 * it registers the ONE tool there is — so the
 * extension wires them exactly once. Their structural rules did not move with
 * them: they are asserted below against the module that now owns each one.
 */
const GOAL_TOOLS_SRC = readFileSync(join(ROOT, "lib", "goal-tools.ts"), "utf8");
const GOAL_TOOLS = new Set(["propose_loop_goal"]);
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
    "evaluateToolCall(shipGateHookDeps, event, ctx);",
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
 * `windowOf`, anchored on the LOOP's `agent_settled` handler.
 *
 * There is MORE THAN ONE handler for that event in the extension — a judge
 * pane has its own with the model-fallback wiring (2026-09-10) and it is
 * registered EARLIER in the file — so a bare
 * `windowOf('pi.on("agent_settled"', …)` started landing on the judge's handler
 * and every assertion below it was reading the wrong body.
 */
function loopSettledWindow(end: string | RegExp, label = "agent_settled"): string {
  return windowOf('pi.on("agent_settled"', end, label, SRC.indexOf(LOOP_SETTLED));
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

  judge_close: "async function doClose(",
  judge_wait: "async function doWait(",
  prepare_review: "async function doPrepareReview(",
  prepare_adviser: "async function doPrepareAdviser(",
  prepare_goal_audit: "async function doPrepareGoalAudit(",
  copilot_review: "async function doCopilotReview(",
  ask_user: "export async function doAskUser(",
  request_scope_limit: "export async function doRequestScopeLimit(",
  request_sensitive_edit: "export async function doRequestSensitiveEdit(",
  propose_loop_goal: "export async function doProposeLoopGoal(",
};

/**
 * The handler of a tool whose REGISTRATION and BODY are in different lib/
 * modules. The goal family used to split that way: lib/goal-tools.ts is the
 * single registration entry point, while the audit record it dispatches to
 * lives in lib/goal-prereview-tools.ts. Since 2026-09-04 that record is a
 * plain function rather than a second tool, so the map is EMPTY — kept because
 * naming the source explicitly is what keeps the "same source" rule intact
 * everywhere else: a tool can still never be matched against another module's
 * handler by accident, and the next split has a place to declare itself.
 */
const LIB_HANDLER_SOURCES: Record<string, string> = {};


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
  return windowOf("const judgeSessionDeps: JudgeSessionToolDeps = {", "\n  };", "judge tools wiring");

}

/**
 * THE TEN ADVANCED ENTRIES ARE NOT REGISTERED (2026-08-30, philosophy three).
 *
 * FIVE of them still EXIST as implementations, captured into `internalHost`
 * so `judge_submit` and `propose_loop_goal` call the ONE copy of each
 * mechanical check; three were deleted outright, and the two RECORDERS are
 * plain functions on no host at all (2026-09-04). What must be true
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
 * ONE host, and the anchor pins that: the family registers only the
 * agent-visible `propose_loop_goal`. Its audit recorder is a plain function
 * the gate calls itself, on no tool surface at all (2026-09-04).
 */
function GOAL_WIRING(): string {
  return windowOf(
    "registerGoalTools(pi, {",
    "\n  });",
    "goal tools wiring",
  );
}

/**
 * The reviewer verdict recorder — a plain function since 2026-09-04, so it has
 * no `name:` anchor. Everything the OPENER owns lives in this window: the
 * STALE check, the cwd check, the tree binding, the round record.
 */
function recordVerdictBody(): string {
  return windowOf(
    "async function recordReviewVerdict(",
    "\n  // ---------- review tooling",
    "recordReviewVerdict",
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
  // argument is spelled. Since 2026-09-22 the paragraph itself is built by
  // `loopGoalDirectiveText()` — the ONE reader of the goal stage switch — so
  // the anchor is that helper's call site inside this handler.
  const injectAt = SRC.indexOf("loopGoalDirectiveText()", handlerAt);
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
  const toolInjectAt = SRC.indexOf('const goalNote = effective === "loop"');

  assert.ok(toolInjectAt > 0 && toolInjectAt < handlerAt, "set_gate_mode must inject the goal too");
  assert.match(SRC.slice(toolInjectAt, toolInjectAt + 200), /loopGoalDirectiveText\(\)/,
    "…through the stage-aware helper (2026-09-22): an OFF goal stage must not be told to negotiate");
});

test("loop goal: the read-only NUDGE teaches the restatement step, in the right order", () => {
  // 2026-09-06 (reviewer round 2). This is the FOURTH copy of the
  // goal-negotiation instruction (the other three live in lib/loop-goal.ts and
  // lib/orchestrator-delivery.ts). It is appended to read-only tool results, so
  // it is often the only version a busy session actually reads — and while it
  // still said "先用 propose_loop_goal" it pointed at a call that now refuses.
  const at = SRC.indexOf("const GOAL_REMINDER_TEXT");
  assert.ok(at > 0, "the nudge must still exist under this name");
  const end = SRC.indexOf('";', at);
  assert.ok(end > at, "the constant must be terminated — otherwise this window proves nothing");
  const text = SRC.slice(at, end);
  // The window really does cover the whole constant (both ends), so a partial
  // read cannot make the assertions below pass by accident.
  assert.match(text, /\[review-gate\]/, "the window must contain the nudge's own prefix");
  assert.match(text, /L8 会拦下 edit\/write/, "…and its closing sentence");
  assert.match(text, /propose_restatement/);
  assert.ok(text.indexOf("propose_restatement") < text.indexOf("propose_loop_goal"),
    "the earlier step must be named first — the nudge IS the order a session follows");
});


test("loop goal: the force-negotiate directive is injected in before_agent_start once the turn threshold is hit", () => {
  // 2026-09-17 (user decision): past GOAL_FORCE_NEGOTIATE_TURN_THRESHOLD un-goaled
  // turns, the EVERY-TURN prompt (not only the RESUME injection) must escalate
  // the goal directive — the agent cannot miss that negotiation is the only
  // acceptable next action.
  const handlerAt = SRC.indexOf('pi.on("before_agent_start"');
  assert.ok(handlerAt > 0, "handler must exist");
  const injectAt = SRC.indexOf("buildGoalForceNegotiateDirective(", handlerAt);
  assert.ok(injectAt > 0, "the force-negotiate directive must be injected in before_agent_start");
  const guard = SRC.slice(injectAt - 300, injectAt);
  assert.match(guard, /goalNegotiationOverdue\(state\.turnsWithoutGoal\)/,
    "it must be guarded on the threshold, not unconditional");
  assert.match(guard, /!goalConfirmed/,
    "and only while the goal is still unconfirmed");
});

test("the loop goal gates SHIP at L1 only — hooks and verdict logic stay blind to it", () => {
  // USER REQUIREMENT (L8): an unapproved goal blocks commit/push/PR, because
  // negotiating the contract after the code is pushed is theatre. What did NOT
  // change: the gate's other layers still rest on objective facts they can
  // verify themselves. The approval is a DIALOG fact, and a git hook cannot
  // show a dialog — so the hook, the verdict parser and the fingerprint must
  // remain unaware of the goal entirely.
  const blindSources = [
    join(ROOT, "lib", "precommit-parse.ts"),
    join(ROOT, "lib", "review-adjudicate.ts"),
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
  const toolResultAt = SRC.indexOf('pi.on("tool_result", async (event, ctx)');
  assert.ok(toolResultAt > 0, "the edit-tracking tool_result handler must exist");
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
  // The extension WIRES the hook; lib/ship-gate-hook.ts is what decides. The
  // handler is one block, not a one-liner, because it also refreshes the
  // activity line a supervisor reads (`describeToolActivity`, 2026-09-17) —
  // and the gate call itself is still the last thing it does, so a blocked
  // tool call is still recorded as the last thing the session tried.
  assert.match(SRC, /pi\.on\(["']tool_call["'], \(event, ctx\) => \{[\s\S]{0,400}?return evaluateToolCall\(shipGateHookDeps, event, ctx\);/,
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
  const start = SRC.indexOf(LOOP_SETTLED);
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
  const start = SRC.indexOf(LOOP_SETTLED);
  const breakerAt = SRC.indexOf("evaluateStall(", start);
  const injectAt = SRC.indexOf("REVIEW_GATE_RESUME", start);
  const call = SRC.slice(breakerAt, injectAt);
  assert.match(call, /inMotion:\s*stallInMotion\(motion\)/,
    "the breaker's motion verdict is the ONE pure decision (lib/loop-stall.ts), not an inline ||");
  const facts = SRC.slice(SRC.indexOf("const motion = {", start), breakerAt);
  assert.match(facts, /judgeInFlight:\s*judgeChildInMotion\(\)/,
    "the breaker must be told about judge work in flight");
  // The motion probe must be bounded in age, or a hung run would disable the
  // breaker permanently — the exact failure it exists to catch.
  const judgeProbe = windowOf("function judgeChildInMotion(", "\n  }", "judgeChildInMotion");
  assert.match(judgeProbe, /STALL_MOTION_MAX_AGE_SEC/, "judge-child motion credit must expire with age");
  assert.match(judgeProbe, /Date\.parse\(c\.spawnedAt\)/, "freshness is measured from the spawn timestamp");
  assert.match(judgeProbe, /Number\.isFinite/, "an unparseable spawnedAt must fail closed (no motion)");
});

test("L2 STALL BREAKER: an overdue goal negotiation counts as motion (never swallow the force-negotiate directive)", () => {
  // 2026-09-17 P1 (reviewer): the force-negotiate directive exists for the
  // read-only probe loop — no edits, no review, no rounds — which is EXACTLY
  // the signature the stall breaker trips on (~4 unchanged settles). If the
  // breaker returned before the RESUME injection, the directive at turn 60
  // would never fire in the scenario it was built for. An overdue negotiation
  // must therefore be treated as in-motion, the same exemption a running
  // reviewer gets.
  const start = SRC.indexOf(LOOP_SETTLED);
  const breakerAt = SRC.indexOf("evaluateStall(", start);
  const injectAt = SRC.indexOf("REVIEW_GATE_RESUME", start);
  const facts = SRC.slice(SRC.indexOf("const motion = {", start), breakerAt);
  assert.match(facts, /^\s*forceNegotiate,\s*$/m,
    "an overdue negotiation must reach the motion verdict");
  assert.match(facts, /stallInMotion|pausedForUser/, "the motion facts are assembled in one place before the breaker");
  // The fact is computed earlier in the handler (before the fingerprint, at the
  // turn counter), so it exists by the time the stall check reads it.
  const settledWindow = SRC.slice(start, injectAt);
  assert.match(settledWindow, /const forceNegotiate = goalNegotiationOverdue\(state\.turnsWithoutGoal\)/,
    "the forceNegotiate fact must be computed before the stall check");
});

test("L2 STALL BREAKER: an answered gate dialog is motion — a live negotiation is not a stall", () => {
  // 2026-09-16, measured: 80 minutes of goal negotiation (seven restatement /
  // goal revisions, repeated questions answered) tripped the breaker and the
  // notice blamed the provider. The writer and the reader must both stay wired:
  // `askChoice` is the ONE dialog path, and the breaker reads the stamp as an
  // EVENT (after the previous observation), never as a grace period.
  const askChoice = windowOf("async function askDialog(", "\n  }", "askDialog");
  assert.match(askChoice, /if \(answer !== undefined && answer !== MULTI_UNAVAILABLE\)[\s\S]{0,90}?lastUserInteractionAt = new Date\(\)\.toISOString\(\)/,
    "the dialog path must record the exchange — a dismissed box does not count, and neither does the checklist sentinel " +
    "(it means NO host could draw the question: quality round P2, 2026-09-22)");
  const start = SRC.indexOf(LOOP_SETTLED);
  const breakerAt = SRC.indexOf("evaluateStall(", start);
  const facts = SRC.slice(SRC.indexOf("const motion = {", start), breakerAt);
  assert.match(facts, /lastUserInteractionAt,/, "the stamp must reach the motion facts");
  assert.match(facts, /previousObservationAt:\s*lastStallObservedAt/, "the EVENT boundary is the previous observation");
  assert.match(facts, /pausedForUser:\s*state\.pausedQuestion !== undefined/,
    "a parked dialog is waiting on a person, not spinning");
  // The NOTICE's attribution needs the clock too: "we talked to the user" is
  // only an explanation while it is RECENT (functional round P2, 2026-09-16 —
  // without the window the provider branch is unreachable for the rest of the
  // session).
  assert.match(SRC.slice(breakerAt, SRC.indexOf("REVIEW_GATE_RESUME", start)), /nowMs: Date\.now\(\)/,
    "the cause classifier is given the time it must judge recency against");
  // The observation stamp is written after the decision, so an interaction that
  // lands later belongs to the NEXT observation (that is what makes it an event).
  assert.match(SRC.slice(breakerAt, SRC.indexOf("REVIEW_GATE_RESUME", start)),
    /lastStallObservedAt = new Date\(\)\.toISOString\(\)/);
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
    /if \((\w+)\.agentsGlobalCorrupt\) \{[\s\S]{0,400}?\} else \{[\s\S]{0,900}?applyAgentConfigLayer\(/,
    "a corrupt GLOBAL layer must skip its render, not fall through to applyAgentConfigLayer",
  );
  assert.match(
    layers,
    // The project branch carries the cross-layer reviewer-readonly guard
    // between the `else` and its render call, hence the wider window. The flag
    // is read off the CONFIG OBJECT the function renders from (a parameter
    // since 2026-09-10 — the dispatch re-renders from a fresh read), so the
    // guard names that object rather than the session snapshot.
    /if \((\w+)\.agentsProjectCorrupt\) \{[\s\S]{0,400}?\} else \{[\s\S]{0,5000}?applyAgentConfigLayer\(/,
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
  assert.match(fn, /effectiveAgentsConfig\(cfg\.agentsGlobal \?\? undefined, undefined\)/);
  assert.match(fn, /effectiveAgentsConfig\(undefined, cfg\.agentsProject \?\? undefined\)/);
  assert.match(fn, /applyAgentConfigLayer\(/);
  // The project layer is rendered for the ROOT the config was read for (a
  // parameter since 2026-09-10), not unconditionally for the primary repo.
  assert.match(fn, /pathJoin\(root, "\.pi", "agents"\)/);
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

test("MODEL LAUNCH: every judge dispatch re-reads the config and picks a slot that is not cooling down", () => {
  // 2026-09-10 (measured in rebate): `projectConfig` is a SESSION-START
  // snapshot, so a user who edited ~/.pi/review-gate.json mid-session kept
  // getting the OLD chain launched for hours — while the judge pane's own
  // session start re-rendered `.pi/agents/*.md` from the new one, leaving the
  // file on disk and the running model contradicting each other.
  const fresh = windowOf("function freshProjectConfig(", "\n  }", "freshProjectConfig");
  assert.match(fresh, /loadProjectConfig\(root\)/, "the agents layer is re-read from disk");
  // CORRUPT ≠ ABSENT: a corrupt layer keeps the snapshot's value, or the
  // renderer would sweep a valid chain back to the built-in default.
  assert.match(fresh, /agentsGlobalCorrupt \? projectConfig\.agentsGlobal : fresh\.agentsGlobal/);
  assert.match(fresh, /agentsProjectCorrupt \? projectConfig\.agentsProject : fresh\.agentsProject/);

  const launch = windowOf("function resolveJudgeLaunch(", "\n  }", "resolveJudgeLaunch");
  assert.match(launch, /freshProjectConfig\(root\)/, "the launch reads THAT, never the snapshot");
  assert.doesNotMatch(launch, /projectConfig\.agentsGlobal/, "no stale read on the launch path");
  assert.match(launch, /ensureModelLayersRendered\(latestCtx, cfg, root\)/,
    "and the rendered `.pi/agents/*.md` chain follows the config that launches");
  assert.match(launch, /selectHealthySlot\(files\.chain, judgeModelHealth\(root\)/,
    "the slot is picked from the WHOLE chain by health, not `slots[0]`");
  assert.match(launch, /files\.chain\.length === 0/, "an unresolvable chain still fails closed");
  // ONE resolver for both dispatch surfaces — a second one is the drift this
  // whole change exists to end.
  assert.equal((SRC.match(/resolveJudgeLaunch\(/g) ?? []).length, 3, "definition + judge_submit's chain + judge_spawn's launchConfig");
  assert.match(SRC, /const launch = resolveJudgeLaunch\(root, role, workDir, title, judgeId\)/);
  assert.match(SRC, /const launch = resolveJudgeLaunch\(root, role, workDir, role, judgeId\)/);
});

test("MODEL FALLBACK: only a judge pane installs the pane-side rotation", () => {
  // The pane is the only party that sees its own provider errors, and a
  // reporting shell must not grow an enforcing surface: the handler is
  // registered inside the judge-side branch, nowhere else.
  const call = SRC.indexOf("installJudgeModelRotation(readJudgeSideEnv(process.env)!.role)");
  assert.ok(call > 0, "the judge side installs it");
  const judgeBlock = SRC.lastIndexOf("if (readJudgeSideEnv(process.env)) {", call);
  assert.ok(judgeBlock > 0 && judgeBlock < call, "…and it is inside the judge-side block");
  assert.ok(SRC.indexOf("registerJudgeSpawnTools(pi,") > call, "which ends after it");
  const install = windowOf("function installJudgeModelRotation(", "\n  }", "installJudgeModelRotation");
  assert.match(install, /pi\.on\("agent_end"/, "the run's terminal error is read from agent_end");
  assert.match(install, /pi\.on\("agent_settled"/, "and acted on once pi has nothing left to retry");
  assert.match(install, /createModelRotation\(/, "the policy lives in lib/judge-model-rotation.ts");
  assert.match(install, /pi\.setModel\(/, "the pane switches its own model");
  assert.match(install, /reportState\(binding, event\.exhausted \? "idle" : "working", \{ modelEvent: event \}\)/,
    "and REPORTS it — the opener cannot see provider errors itself");
});

test("MODEL EVENTS: the cursor never moves past an event the opener did not act on", () => {
  // P1 (reviewer, 2026-09-10): the wait advanced the cursor while the side
  // effect ran later (or never), so the cooldown was silently never written.
  // The absorber is now the wait's own dep, called BEFORE the cursor write.
  const deps = windowOf("const judgeSessionDeps: JudgeSessionToolDeps = {", "\n  };", "judgeSessionDeps");
  assert.match(deps, /absorbModelEvents: \(root, judgeId\) => absorbJudgeModelEvents\(root, judgeId\)/,
    "the wait's absorber is wired to the one implementation");
  // ONE implementation, whichever trigger calls it (the wait, the settle
  // sweep, the dispatch). NOTE: the assertion must be able to FAIL — an
  // earlier version matched a literal that never appears and passed for any
  // implementation at all (P2, reviewer round 2).
  assert.equal((SRC.match(/function absorbJudgeModelEvents\(/g) ?? []).length, 1,
    "exactly one absorber implementation");
  assert.notEqual(SRC.indexOf("function absorbJudgeModelEvents("), -1, "…and it is really there");

  // The other half of the same defect: a re-dispatch REPLACES the registry
  // entry, so the cursor must be carried (reuse) or seeded from the channel
  // watermark (fresh open) — the channel is append-only, and a replay of an
  // old `exhausted` event would end a healthy round on its first probe.
  const reuse = SRC.slice(SRC.indexOf("const keptCursor = existing.lastReportId;"), SRC.indexOf("const keptCursor = existing.lastReportId;") + 3000);
  assert.match(reuse, /const live = judgeHierarchy\[judgeId\] \?\? existing;/,
    "the reuse registration reads the entry AGAIN — `existing` predates this dispatch's absorb");
  assert.match(reuse, /lastModelEventCount: live\.lastModelEventCount/, "reuse carries the live cursor");
  const fresh = SRC.slice(SRC.indexOf("let freshCursor: string | undefined;"), SRC.indexOf("let freshCursor: string | undefined;") + 900);
  assert.match(fresh, /freshModelEventCount = freshProjection\.modelEvents\.length/,
    "a fresh open seeds it at the channel watermark (the same rule as the report cursor)");
  assert.match(SRC, /lastModelEventCount: freshModelEventCount/, "…and the registration carries it");
  // The OTHER dispatch surface (judge_spawn: goal/plan audits) has its own
  // registration and needs the same watermark — a stale `exhausted` event there
  // ends the first probe of every later audit (P1, reviewer round 2).
  const spawnSrc = readFileSync(join(ROOT, "lib", "judge-spawn-tools.ts"), "utf8");
  assert.match(spawnSrc, /modelEventCount: projectChannel\(records\)\.modelEvents\.length/,
    "the spawn birth facts include the channel's model-event watermark");
  assert.equal((spawnSrc.match(/lastModelEventCount: birthModelEventCount/g) ?? []).length, 2,
    "both spawn registrations (pre-open and inside the open) carry it");
  // Absorbing at dispatch is what covers the round that ends WITHOUT a report
  // (an exhausted chain) — before the entry it reads the cursor from is gone.
  const dispatchAt = SRC.indexOf("const existing = judgeHierarchy[judgeId];");
  assert.match(SRC.slice(dispatchAt, dispatchAt + 400), /absorbJudgeModelEvents\(root, judgeId\)/,
    "the dispatch absorbs before it rewrites the entry");
  // …and WITHOUT an entry there is nothing to absorb against: "read the whole
  // channel" would re-record a historical failure with a fresh timestamp on
  // every dispatch — a cooldown that can never expire.
  const absorb = windowOf("function absorbJudgeModelEvents(", "\n  }", "absorbJudgeModelEvents");
  assert.match(absorb, /if \(!entry\) return;/, "no cursor, no absorb — never replay history");
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
  assert.match(fn, /st\.lastReviewedTree/, "the settled conclusion reads the review baseline");
  assert.match(fn, /base\.verdict !== "READY"/, "…and only an APPROVED tree has settled anything");
});

test("L2 ORDER: explore check precedes loopArmed in agent_settled (explore edits arm the loop flag)", () => {
  // Explore-mode edits set loopArmed = true in tool_result; only the explore
  // early-return keeps auto-continuation off. If someone reorders the checks,
  // explore would silently regain forced continuation.
  const start = SRC.indexOf(LOOP_SETTLED);
  assert.ok(start >= 0, "agent_settled handler must exist");
  // Wide enough to cover the child-state hooks and the continuation
  // withdrawals at the handler top: the pinned property is the ORDER of the
  // two checks, not the distance.
  const body = SRC.slice(start, start + 2800);
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

test("SECURITY: a grantScope must be VISIBLE to the user and minted by EXACT pick only (reviewer P1, 2026-09-16)", () => {
  // P1 fix: the sensitive-edit proxy grant used to be minted from an
  // INVISIBLE grantScope + substring match on free text ("grant me a few
  // minutes" harvested it). Three structural guards pin the fix:
  //  1. The user-visible notice exists and is wired into the dialog/transcript.
  //  2. Minting is exact-pick: answer === recommended, never a substring.
  //  3. A grantScope without options is DROPPED at normalization (free text
  //     can never carry a grant) — asserted in the schema module.
  assert.match(ASK_USER_SRC, /function grantNotice\(q: AskQuestion\): string/,
    "the grant notice helper exists");
  // The helper existing is NOT the property — the user must SEE it. Assert
  // the INTERPOLATION at every rendering call site (reviewer P2, 2026-09-16:
  // a helper left intact in dead code proved nothing).
  //
  // 2026-09-06: the interview builds ONE `prompt` per question and every
  // surface renders THAT string, so the notice can no longer be present in
  // the channel title and missing from the box (or vice versa). The call
  // sites are asserted through the prompt rather than four times over.
  const interpolations = (ASK_USER_SRC.match(/grantNotice\(q\)/g) ?? []).length;
  assert.ok(interpolations >= 2, `the notice is interpolated at the dialog/transcript call sites (got ${interpolations})`);
  assert.match(ASK_USER_SRC, /const prompt = `问题 \$\{progressLabel\(index, questions\.length\)\}\\n\$\{q\.text\}\$\{grantNotice\(q\)\}`/,
    "the ONE prompt every surface renders interpolates the notice");
  assert.match(ASK_USER_SRC, /title: prompt,/,
    "the CHANNEL title is that prompt");
  assert.match(ASK_USER_SRC, /await askWithBacks\(index, signal\)/,
    "the pane dialog renders the template through the ONE renderer — and reads its result, so a box no host could draw is not counted as shown");
  assert.match(ASK_USER_SRC, /const picked = q\.multiple[\s\S]{0,140}?await deps\.askMultiChoice\(uiCtx,[\s\S]{0,140}?await deps\.askChoice\(uiCtx,/,
    "…both shapes dispatched from the walk-back loop, which is where `← 返回上一题` is handled (2026-09-19): " +
    "the checkbox question goes to its OWN renderer, the radio one to the template");
  // THE QUESTION RIDES IN THE BODY, NOT THE TITLE (2026-09-14). A title is the
  // short label; the question is the long half and belongs in the body. (When a
  // row budget existed this also kept a long question from sizing the box — the
  // budget is gone, the placement is not: the REASON box renders the title
  // alone, so what the user is answering has to be readable there.)
  // The title carries the progress label, the question's own headline (so the
  // REASON box, which renders the title alone, says what is being answered)
  // and the grant notice — all three ahead of the body rather than in its
  // tail, because the box is read top-down. The ORDER inside that title is its
  // own rule (questionDialogTitle): the ⚠️ notice must come FIRST or it hides
  // under the progress label, while the recommended row still mints the grant.
  // (Before 2026-09-16 a title budget decided what survived; the budget is
  // gone, the order is not.)
  assert.match(ASK_USER_SRC, /title: questionDialogTitle\(q, cursor, questions\.length\)/,
    "the dialog title is built by the ONE title rule");
  assert.match(ASK_USER_SRC,
    /function questionDialogTitle\(q: AskQuestion, index: number, total: number\): string \{\s*const notice = grantNotice\(q\)\.trim\(\);/,
    "…and that rule puts the grant notice first, where it cannot be missed");
  assert.match(ASK_USER_SRC, /body: q\.text,/,
    "the question text itself rides in the body");
  // WHY THE NOTICE IS NOT IN THE BODY (reviewer P1, 2026-09-14): appending ⚠️
  // after a long question let the question push the authorization notice out of
  // sight — while picking the recommended row still minted the proxy grant. The
  // title is read first. (Until 2026-09-16 it was ALSO the only part a cut could
  // not reach, so the placement was belt and braces; the budget is gone and the
  // placement remains, because reading order is what makes it work.)
  assert.doesNotMatch(ASK_USER_SRC, /body: `\$\{q\.text\}\$\{grantNotice\(q\)\}`/,
    "the grant notice must never sit in the body, after the question");
  assert.doesNotMatch(ASK_USER_SRC, /extraRows/,
    "no caller-owned dialog rows any more — closing the box is the way out");
  assert.doesNotMatch(ASK_USER_SRC, /uiCtx\.ui!\.input!/,
    "no free-text dialog any more — the template's reason box is the only text box");
  assert.match(ASK_USER_SRC, /\$\{q\.text\}\$\{grantNotice\(q\)\}` \+/,
    "the transcript interpolates the notice");
  assert.match(ASK_USER_SRC, /明确授予项目经理/,
    "the notice text states the grant in plain Chinese");
  assert.match(ASK_USER_SRC, /if \(answer\.option === q\.recommended\) deps\.grantProxyScope\(q\.grantScope, "ask-user"\);/,
    "minting is an EXACT pick of the recommended row — no substring match");
  assert.match(ASK_USER_SRC, /else deps\.revokeProxyScope\(q\.grantScope\);/,
    "and a re-answered authorization question takes the scope back (2026-09-19)");
  assert.doesNotMatch(ASK_USER_SRC, /同意\|允许\|授权\|授予\|yes\|allow\|grant/,
    "the old substring predicate must not come back");

  const askSrc = readFileSync(join(ROOT, "lib", "ask-user.ts"), "utf8");
  assert.match(askSrc, /isGrantableScope\(grantScope\) \? \{ grantScope \} : \{\}/,
    "only a recognized scope survives normalization — an agent cannot invent one");
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
  assert.match(toolBody, /deps\.askChoice\(/, "the pane dialog renders the gate's one template");
  assert.doesNotMatch(toolBody, /uiCtx\.ui!\.input!/,
    "no free-text dialog: the template's reason box is the only text box");
  // Both go through the channel funnel, so an orchestration child's project
  // manager can answer the same question the human can (2026-08-30) — and
  // whichever of them answers first takes the box off the other's screen.
  assert.match(toolBody, /deps\.askEitherSide\(/, "every gate question is answerable by EITHER side");
  assert.match(toolBody, /topic: "ask-user"/, "the request is LABELLED by the gate that raised it");

  // THE WHOLE INTERVIEW GOES UP FIRST (2026-09-06): every remaining question
  // is handed to the funnel in one synchronous burst — each call writes its
  // channel request record before it awaits anything — so a project manager
  // sees all of them on its first receipt instead of one per round trip.
  assert.match(toolBody, /const asks = remaining\.map\(/,
    "the batch is started in one burst, not one question per await");
  assert.match(toolBody, /batch: \{ id: batchId, index, total: questions\.length \}/,
    "each question carries its place in the interview");
  // …and the USER's own window is still one box at a time: renderer i waits
  // for gate i, which the consuming loop opens only when i-1 has settled.
  assert.match(toolBody, /await gates\[offset\]!\.opened;/,
    "a dialog is raised only when it is that question's turn");
  assert.match(toolBody, /gates\[offset \+ 1\]\?\.open\(\);/,
    "…and the next turn starts only after this one settled");
  // A question already settled by the project manager, or one the interview
  // will never show, must not put a dead box on the user's screen.
  assert.match(toolBody, /if \(signal\.aborted \|\| stopped\) return undefined;/,
    "a settled or abandoned question renders nothing");

  // A dismissed dialog or a broken UI is NOT consent: it becomes an
  // unanswered question, which pauses the loop.
  assert.match(toolBody, /\.catch\(\(\): ChannelDialogOutcome => \(\{ answer: undefined, by: "dismissed", requestId: "" \}\)\)/,
    "a broken dialog is silence, never an answer");
  assert.match(toolBody, /: resolveQuestion\(q, picked, opts\);/,
    "what a settled question MEANS is the one pure rule in lib/ask-user.ts" +
    " — reached for every question that was actually shown, which is what the ternary above it is about (a question no host could draw settles as unanswered WITHOUT a stop)");

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
  assert.match(body, /notify\(`\$\{lead\}\\n\$\{body\}`, "warning"\)/,
    "the full text must go through ui.notify");
  // NO CHARACTER CAP (user decision, 2026-09-14). What this used to cut — at
  // 4000 characters — was the restatement / goal / plan the user is being
  // asked to APPROVE: exactly the text they have to read. The flicker it was
  // guarding against does not apply to the transcript (appending 400 rows
  // triggers no full clears; test/tui-flicker.test.ts measures it), and the
  // dialog is the only constrained surface.
  assert.doesNotMatch(body, /slice\(0,/,
    "no character cap may come back: the transcript scrolls");
  assert.doesNotMatch(body, /已截断/);
  assert.match(body, /return false/, "no UI must be reported honestly, not swallowed");
  assert.doesNotMatch(body, /sendMessage/, "sendMessage is queued, not rendered");
  // Nothing in the extension may deliver user-facing text via the follow-up
  // queue: that is the extra-turn trap.
  assert.doesNotMatch(SRC, /deliverAs: "followUp", triggerTurn: false \}\);[\s\S]{0,40}pausedQuestion/,
    "the pause path must never enqueue a follow-up message");
});

test("FLICKER: dialogs are no longer fitted, and a regular-renderer session is told", () => {
  // An oversized dialog makes it taller than the terminal, which pushes the
  // animating spinner row out of the viewport and turns EVERY spinner frame
  // into a full-screen clear (measured: 29 of 30 frames) — which is why the
  // session on that renderer is TOLD to switch (lib/renderer-mode.ts) instead
  // of being fitted. askChoice renders the gate's ONE template whole; nothing
  // may bypass it, and no ui.confirm exists any more (2026-09-08).
  // The BODY lives in `askDialog` since 2026-09-22: the checkbox shape is the
  // same dialog with a different renderer, so `askChoice` / `askMultiChoice`
  // are one-line forwarders and every structural rule below is asserted
  // against the body they share.
  const helperAt = SRC.indexOf("async function askDialog");
  const askChoiceBody = windowOf("async function askDialog", "\n  }", "askDialog");
  // NO FITTING ANY MORE (user decision, 2026-09-16). The row budget existed
  // because an oversized dialog pushed the animating spinner out of the
  // viewport and turned EVERY spinner frame into a full-screen clear (measured:
  // 29 of 30). The user runs every session on the fullscreen renderer, which
  // owns the screen and never takes that branch — so the budget is GONE and
  // this pins its absence: nothing here may silently reintroduce a fit, because
  // a partial one would cut exactly the lines the dialog is asking about.
  assert.doesNotMatch(askChoiceBody, /fitDialogMessage\(|fitDialogTitle\(|dialogTextMaxLines\(/,
    "the dialog must reach the renderer whole");
  assert.doesNotMatch(SRC, /from "\.\.\/lib\/dialog-budget\.ts"/,
    "…and the module is deleted, not just unused");
  // WHAT REPLACES IT: a session on the DEFAULT renderer is TOLD once, from the
  // host's own `TUI.mode` (a config re-derivation would be a copy of pi's
  // precedence that gets the corners wrong — lib/renderer-mode.ts). The mode
  // reaches this extension only through the setWidget FACTORY form, used here
  // as a one-shot PROBE that is removed immediately: the factory component
  // would have to wrap its own lines, and pi's RPC host ignores factories
  // altogether — the status strip stays the string[] form.
  assert.match(SRC, /setWidget\("review-gate-renderer-probe", \(tui\) => \{[\s\S]{0,160}?noteRendererMode\(tui\.mode, ctx\)/,
    "the renderer mode comes from the host, through a one-shot widget-factory probe");
  assert.match(SRC, /setWidget\("review-gate-renderer-probe", undefined\)/,
    "…and the probe leaves nothing behind");
  assert.match(SRC, /setWidget\("review-gate-agents", lines, \{ placement: "belowEditor" \}\)/,
    "the status strip itself stays the string[] form (it is what wraps per line, and RPC keeps it)");
  assert.match(SRC, /rendererModeNoticeDue\(mode, rendererModeNoticeShown\)/,
    "…and whether to speak is the module's pure decision");
  assert.match(SRC, /ctx\.ui\.notify\(RENDERER_MODE_NOTICE, "warning"\);[\s\S]{0,120}?rendererModeNoticeShown = true;/,
    "the once-only flag is set AFTER the notice is out, never before it");
  assert.doesNotMatch(SRC, /process\.stdout\?\.rows|process\.env\.LINES/,
    "no row arithmetic may come back: the terminal is no longer consulted");
  // ui.confirm is GONE: the template renders a select, so a stray confirm
  // would be a second dialog shape nobody reviewed.
  const confirms = [...SRC.matchAll(/\.confirm\?\.\(|\.confirm\(/g)].map((m) => m.index ?? 0);
  assert.deepEqual(confirms, [], `no ui.confirm may remain (found at ${confirms.join(", ")})`);

  // ui.select exists in exactly ONE place: the template's own renderer.
  const selects = [...SRC.matchAll(/\.select\?\.\(|\.select\(/g)].map((m) => m.index ?? 0);
  assert.deepEqual(selects, [],
    `the extension must render dialogs through askChoice only (stray ui.select at ${selects.join(", ")})`);
  assert.ok(helperAt > 0, "the one renderer must exist");
  // NO render path may bypass it — `ask_user` used to call renderChoice
  // directly, which is how a long question kept sizing its own dialog. The
  // extension has exactly ONE renderChoice call site, and it is this helper.
  const directRenders = [...SRC.matchAll(/renderChoice\(/g)].length;
  assert.equal(directRenders, 1,
    `askChoice must be the only renderChoice call site (found ${directRenders})`);
  assert.match(SRC, /renderChoice\(/, "…and the ONE radio render call site is the dialog body");
  assert.match(askChoiceBody, /renderMultiChoice\(/, "…with the checkbox shape beside it, on the same seam");
});

test("DIALOG QUEUE: one box at a time, with the host's abort and the question in the banner", () => {
  // MEASURED (rebate session 01a0b328, 2026-09-18): pi runs the tool calls of
  // one assistant message in PARALLEL, and the host has a single dialog slot —
  // `ask_user` + `request_scope_limit` in one message meant the second box
  // replaced the first, whose promise was never settled again, so the first
  // tool never returned and the turn hung with no way out (an abort does not
  // interrupt pi's `Promise.all` over the batch). Every dialog the gate shows
  // goes through this ONE function, so the fix belongs here.
  const askChoiceBody = windowOf("async function askDialog", "\n  }", "askDialog");
  // The queue call is no longer RETURNED directly (2026-09-19): its promise is
  // held as `asked` so the thirty-minute proxy race can wait on the SAME one.
  // The property this line protects is unchanged — one queue, and everything
  // (list and reason box) inside it.
  assert.match(askChoiceBody, /const asked = scheduleDialog\(async \(\) => \{/,
    "the whole dialog — list AND reason box — runs under the ONE queue");
  assert.match(askChoiceBody, /direct: asked,/,
    "…and that one promise is the human side of the race, so a dialog still has exactly one answer path");
  assert.match(SRC, /const scheduleDialog = createDialogQueue\(\);/,
    "…and there is one queue per session, not one per call");
  assert.match(askChoiceBody, /dialogSignal\(uiCtx\.signal, opts\.signal,/,
    "the host's abort signal (ESC: ExtensionContext.signal) is merged with the caller's own");
  assert.match(askChoiceBody, /\}, signal\);/,
    "the merged signal (host + caller + the race's own) is what the queue waiter is registered under");
  assert.match(
    askChoiceBody,
    /const signal = dialogSignal\(uiCtx\.signal, opts\.signal, settledBy\.signal\);/,
    "…because the race's signal is merged into the one BOTH the queue and the box receive",
  );
  assert.match(askChoiceBody, /settledBy\.abort\(\);/,
    "…and the race aborts it on EVERY way out, so a settled dialog never leaves a live box behind");
  // THE WINDOW IS ARMED WHEN THE BOX APPEARS, NOT WHEN IT WAS QUEUED (review
  // round 1 P1): the dialog queue shows ONE box at a time, so a queued
  // question's thirty minutes must not be running before the user has ever
  // seen it.
  assert.match(askChoiceBody, /markDisplayed\?\.\(\);/, "the box's own first line marks the window open");
  assert.match(askChoiceBody, /displayed,/, "…and the race is handed that promise");
  assert.match(askChoiceBody, /dialogNotifyDetail\(spec, opts\.body\)/,
    "the banner carries the question itself, not only the `问题 1 / 4` label");
});

test("judge_submit refuses a round when the session has no edits of its own under a scope limit", () => {
  // THE THIRD HALF OF THE SCOPE-LIMIT FIX (2026-09-19). Telling the reviewer
  // about the exemption fixes what a round CONCLUDES; this is what stops the
  // round from being dispatched at all when there is nothing of its own to
  // judge. Without it the chain still ran a full precommit, a checkpoint and a
  // reviewer over the branch's pre-existing content — minutes per round, every
  // round ending BLOCKED on findings the session may not fix (prime's
  // t3-report-update, which then deadlocked on `declare_done`).
  const at = SRC.indexOf('refused: "no-session-edits-under-scope-limit"');
  assert.ok(at > 0, "the refusal must exist");
  const guard = SRC.slice(Math.max(0, at - 1400), at);
  assert.match(guard, /params\.role === "reviewer"/, "it applies to the review round only, never to advisers or goal audits");
  assert.match(guard, /scoped\.scopeLimit !== undefined/, "…and only when the user actually granted a scope limit");
  assert.match(
    guard,
    /!scoped\.hasCodeChange && !scoped\.hasDocChange/,
    "…and only when this session has changed nothing at all",
  );
});

test("declare_done prints the proxy's decisions itself, and the audit wait has its own budget", () => {
  // TWO FACTS THE GATE MUST STATE RATHER THAN TRUST TO PROSE.
  //
  // (a) A decision the proxy took on the user's behalf is INVISIBLE unless the
  //     gate says so — downstream it is indistinguishable from their own, and
  //     the agent's summary is not a record. So the completion report prints it
  //     from the state, mechanically (empty in the ordinary case).
  const doneBody = toolBodyOf("declare_done");
  assert.match(
    doneBody,
    /formatProxyDecisionReport\(allProxyDecisions\(\)\)/,
    "the completion report must print the proxy's decisions from the state, not from the summary",
  );
  // (b) The gate's own audit wait must NOT borrow `judge_wait`'s ten minutes:
  //     measured 2026-09-19, an eleven-minute goal audit was reported as
  //     「等待未命中本轮 report」 because the borrowed budget ran out, and the
  //     agent had to re-run the audit to collect a verdict already on disk.
  const waitFn = windowOf("async function selfAuditWait", "\n  }", "selfAuditWait");
  assert.match(waitFn, /budgetMs: AUDIT_SELF_WAIT_BUDGET_MS/, "the gate's own wait carries its own budget");
  assert.doesNotMatch(waitFn, /JUDGE_WAIT_MAX_TIMEOUT_MS/, "…and not the agent-facing one");
});

test("PAUSE ORDER: pausedQuestion early-return precedes the RESUME injection in agent_settled", () => {
  // A stale ordering would let the auto-continuation steamroll the agent's
  // question with a [REVIEW_GATE_RESUME] follow-up instead of waiting.
  const start = SRC.indexOf(LOOP_SETTLED);
  assert.ok(start >= 0, "agent_settled handler must exist");
  const injectAt = SRC.indexOf("REVIEW_GATE_RESUME", start);
  assert.ok(injectAt > start, "agent_settled must contain the RESUME injection");
  const beforeInject = SRC.slice(start, injectAt);
  assert.match(beforeInject, /if \(state\.pausedQuestion\) \{ confirmStop\(\); return; \}|if \(state\.pausedQuestion\) return;/,
    "a pause for the user still precedes the continuation injection");
});

test("RESUME text: the unmet-gates branch points a waiting agent at ask_user", () => {
  // An agent that needs the user but has not asked yet gets the
  // auto-continuation. The resume text must name the tool that asks AND
  // pauses, or the follow-up just steers it back into working blind (live
  // regression: agent asked "决策 3 of 3" in prose, RESUME said only
  // "Continue: fix → re-review …").
  const start = SRC.indexOf(LOOP_SETTLED);
  const end = SRC.indexOf("// ---------- lifecycle ----------", start);
  const body = SRC.slice(start, end);
  assert.match(body, /problems\.length > 0[\s\S]{0,800}?ask_user/s,
    "unmet-gates resume must point at ask_user when the agent needs the user");
});

test("pause resume: any non-extension input clears the pause (interactive AND rpc users)", () => {
  // source === "extension" is how the gate injects its own follow-ups; a
  // narrower filter (interactive-only) would deadlock RPC-driven sessions.
  // The window is ANCHORED at the handler's closing brace, not 1400 bytes
  // wide: the fixed window rotted the moment the handler grew (B5 added the
  // wait interrupt to it) and pushed the very line below out of range.
  const body = windowOf('pi.on("input"', "\n  });", "input handler");
  assert.match(body, /event\.source !== "extension"/);
  assert.match(body, /delete state\.pausedQuestion/);
});

test("stale pause liveness: cleared when the agent proves it is not waiting", () => {
  // A pause left behind while the agent keeps looping must not silently
  // swallow auto-continuation: edits, the reviewer verdict recorder and
  // run_precommit all clear it (plus setTaskMode — a fresh mode decision
  // supersedes it).
  // P-multi: the recorder / run_precommit clear the ACTIVE repo's state via a
  // local `st` (no global swap), so both spellings count.
  const clears = SRC.match(/delete (?:state|st)\.pausedQuestion/g) ?? [];
  assert.ok(clears.length >= 5, `expected >=5 clear sites, found ${clears.length}`);
  const recordStart = SRC.indexOf("async function recordReviewVerdict(");
  assert.ok(recordStart > 0, "the reviewer verdict recorder must exist");
  const recordEnd = SRC.indexOf("// ---------- review tooling", recordStart);
  assert.ok(SRC.slice(recordStart, recordEnd).includes(".pausedQuestion"), "recording a verdict must clear the pause");
  const precommitStart = SRC.indexOf('name: "run_precommit"');
  const precommitEnd = SRC.indexOf('name: "declare_done"');
  assert.ok(SRC.slice(precommitStart, precommitEnd).includes(".pausedQuestion"), "run_precommit must clear the pause");
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
  const start = SRC.indexOf(LOOP_SETTLED);
  assert.ok(start >= 0, "agent_settled handler must exist");
  const injectAt = SRC.indexOf("REVIEW_GATE_RESUME", start);
  assert.ok(injectAt > start, "agent_settled must contain the RESUME injection");
  assert.ok(SRC.slice(start, injectAt).includes("lastRunAborted"), "abort check must precede the RESUME injection");
  // …and any non-extension user input clears the pause again.
  const inputBody = windowOf('pi.on("input"', "\n  });", "input handler");
  assert.match(inputBody, /lastRunAborted = false/);
});

test("request_scope_limit: extension-driven user consent, no 'confirmed' parameter, declined locks", () => {
  assert.match(CONSENT_SRC, /name: "request_scope_limit"/, "request_scope_limit tool must be registered");
  const body = toolBodyOf("request_scope_limit");
  // Consent is obtained by the EXTENSION (dialog) — the tool schema exposes
  // only a reason; there is no parameter the model could set to claim consent.
  //
  // THE DIALOG IS ONE IMPLEMENTATION (2026-09-17, user decision): the third
  // consent tool had copied this dance again, so the guard moved from "this
  // body calls askChoice" to "askChoice has exactly ONE call site" — which is
  // what a fourth tool cannot quietly duplicate.
  assert.equal((CONSENT_SRC.match(/deps\.askChoice\(/g) ?? []).length, 1,
    "the consent dialog is rendered in exactly one place (askConsent)");
  assert.match(body, /askConsent\(deps, uiCtx,/);
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
  assert.match(body, /unshowable/, "a dialog that could not be shown is not a decline");
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
  const inputBody = windowOf('pi.on("input"', "\n  });", "first-input capture handler");
  assert.doesNotMatch(inputBody, /classify|evaluateModeChange|setTaskMode/,
    "the input handler must cache only — decisions stay in set_gate_mode");
  // 2026-09-08: the nudge window NO LONGER closes on new user input — it
  // closes on a successful edit or after one nudge (see lib/edit-discipline.ts).
  // The input handler must not carry the old clearing semantics.
  assert.doesNotMatch(inputBody, /editFailurePending = false/,
    "new user input must NOT close the edit-failure nudge window");
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
  assert.match(region, /await askChoice\(\s*asChoiceHost\(ctx\),\s*spec,\s*\{ body: buildModeConfirmMessage\(/);
  const confirmAt = region.indexOf("askChoice(");
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

test("set_gate_mode(orchestrator) no longer refuses because somebody else's plan exists (B1)", () => {
  // THE RULE DID NOT CHANGE, ITS PLACE DID (2026-09-06). A session that never
  // inherited an orchestration must still not become the holder of one that
  // is already recorded here — but entering the ROLE grants nothing, and
  // refusing the mode locked the two tools that resolve the situation
  // (`orchestrator_attach`, `orchestrator_plan({action:"archive"})`) behind
  // the door being held shut. The only executable advice left was `rm` on the
  // gate's own plan file, and three sessions took it.
  const at = SRC.indexOf('name: "set_gate_mode"');
  const region = SRC.slice(at, SRC.indexOf("registerTool", at + 10));
  assert.doesNotMatch(region, /不接管旧编排/,
    "the mode-level plan refusal must be gone, not merely reworded");
  assert.doesNotMatch(region, /先清掉旧 plan/,
    "and with it the advice that made deleting the gate's state file the way out");
  // The preconditions that ARE about the environment stay where they were.
  assert.match(region, /ORCHESTRATOR_NEEDS_TMUX/, "no tmux still refuses the role");
  assert.match(region, /isOrchestrationChild\(\)/, "an orchestration child still may not become a manager");

  // And the rule now lives on the acts that need an identity.
  const planTools = readFileSync(join(ROOT, "lib/orchestrator-tools.ts"), "utf8");
  assert.match(planTools, /runtimeConflict\?\.\(\)/,
    "orchestrator_plan must refuse write/submit while the repo records another orchestration");
  assert.match(planTools, /PLAN_ACTIONS\.write \|\| action === PLAN_ACTIONS\.submit/,
    "and only those two actions — read/archive must stay reachable");
  const dispatch = readFileSync(join(ROOT, "lib/orchestrator-dispatch.ts"), "utf8");
  assert.match(dispatch, /runtimeConflict\?\.\(\)/, "spawn keeps its own identity check");
  for (const source of [planTools, dispatch]) {
    assert.match(source, /buildTakeoverRoute\(/,
      "every identity refusal must hand back the two commands that resolve it");
  }
});

test("USER REQUIREMENT: Temp dirs are nudged, never clamped; only non-git clamps (criterion 6)", () => {
  // Agent path: /tmp sessions are NOT rewritten — the gate only nudges via the
  // classification directive. The engine exemption covers non-git dirs alone.
  assert.doesNotMatch(SRC, /scratchFirstMode\(/);
  assert.match(SRC, /piSelfTask: !sessionInGit/);
  // setTaskMode must not be able to receive loop on a /tmp first classification
  // setTaskMode receives the agent's pick unrewritten in /tmp; only the non-git
  // short-circuit may still rewrite loop/orchestrator to normal.
  assert.doesNotMatch(SRC, /piSelf && state\.taskMode === undefined && effective === "loop"/);
  assert.match(SRC, /Temp dirs are NOT clamped/);
  assert.match(SRC, /Upgrades \(toward loop\) apply immediately \(a non-git directory still/);
  const README = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.doesNotMatch(README, /scratchFirstMode/);
  // The consent-free entries into normal must be enumerated, and the agent's
  // own first classification must NOT be one of them.
  assert.match(README, /Exactly two entries are consent-free/);
  assert.match(README, /including the agent's own first classification/);
  assert.match(README, /non-git directory/, "the first entry is non-git, not /tmp");
  assert.match(README, /print\/JSON \(no UI\) session/);
  assert.doesNotMatch(README, /ONE exception/);
  assert.doesNotMatch(README, /two consent-free first-classification exceptions/);
  assert.doesNotMatch(SRC, /failed model call falls back to the normal consent rules\. /);
  assert.match(README, /Temp dirs \(`\/tmp`\) are NOT exempt/);
  assert.doesNotMatch(README, /undecided→loop/);
  assert.match(README, /Print\/JSON mode \(no UI\) cannot render those dialogs/);
  const TASK_MODE = readFileSync(join(ROOT, "lib", "task-mode.ts"), "utf8");
  // lib/pi-self.ts is deleted (criterion 6): Temp dirs are nudged, never detected.
  assert.ok(!existsSync(join(ROOT, "lib", "pi-self.ts")), "lib/pi-self.ts must be deleted, not left unused");
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
  // the /tmp clamp (scratchFirstMode) is gone too (criterion 6) — the
  // classification directive only nudges Temp-dir sessions toward normal.
  assert.match(TASK_MODE, /Temp dirs \(\/tmp\) are NOT clamped/);
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
  // Since the mode registry, the static sections live in lib/gate-modes.ts
  // and the extension references them by registry key: assert both halves.
  const handlerAt = SRC.indexOf('pi.on("before_agent_start"');
  assert.ok(handlerAt > 0);
  const loopAt = SRC.indexOf("MODE_REGISTRY.loop.prompt", handlerAt);
  assert.ok(loopAt > 0, "loop branch must inject the registry loop prompt");
  // The decision table is injected in BOTH enforced loop and advisory explore
  // (explore gained it 2026-08-31: it used to early-return before the loop
  // injection, so an explore session never saw the situation→tool table).
  const exploreAt = SRC.indexOf("MODE_REGISTRY.explore.prompt", handlerAt);
  assert.ok(exploreAt > 0, "explore branch must inject the registry explore prompt too");
  assert.ok(exploreAt < loopAt, "the explore early-return injection sits before the loop one");
  // The registry wires the table itself: loop unconditionally, explore with note.
  assert.ok(GATE_MODES_SRC.includes("buildAgentDirectives(undefined, { scopeEscalation: false })"),
    "registry loop prompt carries the table");
  assert.ok(GATE_MODES_SRC.includes('buildAgentDirectives("explore")'), "registry explore prompt carries the table");
  // THE SCOPE-ESCALATION ROW IS TOP-LEVEL ONLY (2026-09-21): the shared loop
  // block also reaches orchestration CHILDREN, whose `set_gate_mode("orchestrator")`
  // the gate refuses — a rule there would send them to a call that cannot
  // succeed. It is appended where the session that can act on it gets it.
  assert.match(SRC, /isOrchestrationChild\(\) \? "" : "\\n\\n" \+ SCOPE_ESCALATION_PROTOCOL/,
    "the scope-escalation row is appended only where it can be acted on");
  // The undecided-clean early return (added round 3) must sit AFTER the
  // injection, so a loop session never loses the decision table: loop mode
  // falls through regardless of gateArmed.
  const earlyAt = SRC.indexOf("state.taskMode === undefined && !gateArmed && problems.length === 0", handlerAt);
  assert.ok(earlyAt > 0, "undecided-clean early return must exist");
  assert.ok(loopAt < earlyAt,
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
  // The 收尾 line is gated on the LOOP'S SEMANTICS: explore/normal get the
  // plain "you may ship." — and an UNDECIDED session gets the 收尾 line,
  // because it runs those semantics (lib/task-mode.ts: undecided behaves as
  // loop, fail-closed). The historical P2-4 note here said an undecided
  // session must NOT see it; the gate's own behaviour contradicts that —
  // `loopGoalEditGate` answers `goalConfirmed` for undecided, i.e. it HOLDS
  // the session to the approved goal, and this round's real-session P1 showed
  // what the same `=== "loop"` spelling did to the acceptance round.
  assert.match(SRC.slice(greenAt - 80, greenAt), /isEnforcedMode\(state\.taskMode\)/,
    "the 收尾 line is gated on the loop's semantics, undecided included");
  assert.match(greenLine, /declare_done/, "green branch names declare_done as the next step");
  assert.match(greenLine, /copilot_review/, "green branch names the Copilot cycle");
});
test("explore workflow: advisory completion, no edit/bash blocking, ship gate intact", () => {
  // declare_done is self-accepted in explore.
  assert.match(SRC, /explore task completed by AI judgment/);
  // The workflow copy lives in the mode registry since the registry move.
  assert.match(GATE_MODES_SRC, /## Explore 工作流/);
  assert.match(GATE_MODES_SRC, /优先只读工作/);
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
    "// tmux PERMISSION GATE (user decision, 2026-09-17)",
    "deps.hint(tmuxHit.reason);",
    "tmux permission gate tier",
  );
  assert.match(guardSite, /detectForbiddenTmux\(/,
    "the second orchestrator site selects the tmux permission tier");
  // THE RULE INVERTED (user decision 2026-09-17): the arm used to be REQUIRED
  // to contain no return at all (it only advised). It now has to carry the
  // refusal — an unauthorized tmux operation is blocked, and the message names
  // `request_tmux_access`. What must NOT come back is a silent pass-through:
  // the only two exits are the refusal and the advice.
  assert.match(guardSite, /if \(!access\) return \{ block: true, reason: tmuxHit\.refusal \}/,
    "unauthorized tmux is REFUSED — not hinted at");
  assert.match(guardSite, /detectForbiddenTmux\([\s\S]*?tmuxAccess\(\)/,
    "the permission is read per call: a grant minted mid-session must count");
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
  // The handler's REAL end, not a fixed-width window: the check is an order
  // inside THIS handler, so the slice must cover the handler and nothing else.
  // (A magic window silently moved the anchors out of scope whenever the
  // startup check grew.)
  const promptEnd = SRC.indexOf('\n  pi.on("', promptAt + 10);
  const promptBody = SRC.slice(promptAt, promptEnd > 0 ? promptEnd : undefined);
  const langAt = promptBody.indexOf("LANGUAGE_DIRECTIVE");
  const normalAt = promptBody.indexOf('state.taskMode === "normal"');
  const directiveAt = promptBody.indexOf("GATE_MODE_DECISION_DIRECTIVE");
  assert.ok(langAt >= 0 && normalAt > langAt, "normal early-return must come after the language directive");
  assert.ok(directiveAt > normalAt, "the undecided directive must not be injected in normal mode");
  // agent_settled and session_compact both skip normal (no auto-continuation,
  // no loop-resume nudge).
  for (const [anchor, window, from] of [['pi.on("agent_settled"', 2800, SRC.indexOf(LOOP_SETTLED)], ['pi.on("session_compact"', 1000, 0]] as const) {
    const at = from === 0 ? SRC.indexOf(anchor) : from;
    assert.ok(at >= 0, anchor);
    // agent_settled's window covers the child-state hooks and the
    // continuation withdrawals at its top; the pinned property is that normal
    // is SKIPPED, not the distance.
    assert.match(SRC.slice(at, at + window), /taskMode === "explore" \|\| state\.taskMode === "normal"/, anchor);
  }
});

test("restore validates persisted taskMode through normalizeTaskMode", () => {
  assert.match(SRC, /normalizeTaskMode/);
});

test("startup self-heal reports the roles it merged, from the same handler that refuses", () => {
  // Goal criterion: a heal that REWRITES the user's ~/.pi/review-gate.json must
  // say so — a silent rewrite is the one outcome nobody could debug. The
  // behavior face (which roles, gaps only) is asserted in
  // test/model-config.test.ts; this pins the wiring that reports it.
  const promptAt = SRC.indexOf('pi.on("before_agent_start"');
  const promptEnd = SRC.indexOf('\n  pi.on("', promptAt + 10);
  const handler = SRC.slice(promptAt, promptEnd > 0 ? promptEnd : undefined);
  assert.match(handler, /startupAgentsCheck\(\{/, "the startup check is the healing entry point");
  assert.match(handler, /if \(healed\.length > 0\)/, "a heal is announced…");
  assert.match(
    handler,
    /log\(`self-healed missing agent slots into \$\{globalConfigPath\(\)\}: \$\{healed\.join\(", "\)\}`\)/,
    "…with the roles it merged and the file it wrote",
  );
  // The heal's own failures ride the refusal instead of disappearing.
  assert.match(handler, /const healNote = healProblems\.length > 0/, "a failed heal is surfaced with the refusal");
  // …and the session's own snapshot follows the file, or every downstream
  // reader keeps the pre-heal state while the check reports a pass.
  assert.match(handler, /projectConfig = \{ \.\.\.projectConfig, agentsGlobal: agentsSection \}/,
    "the healed section is adopted by the session (arbiter resolution, dispatch)");
});

test("edit-discipline nudges: prompt-only guidance, wired at the three sites", () => {
  // USER REQUIREMENT: prompt-level correction (no enforcement) for the
  // recurring "edit failed → bash edits the file" workaround. Three sites:
  // 1. before_agent_start injects the discipline paragraph in every
  //    non-normal mode (after the normal early return).
  const promptAt = SRC.indexOf('pi.on("before_agent_start"');
  const promptEnd = SRC.indexOf('\n  pi.on("', promptAt + 10);
  const promptBody = SRC.slice(promptAt, promptEnd > 0 ? promptEnd : undefined);
  const normalAt = promptBody.indexOf('state.taskMode === "normal"');
  const disciplineAt = promptBody.indexOf("EDIT_DISCIPLINE_DIRECTIVE");
  assert.ok(disciplineAt > normalAt, "discipline directive must be injected after the normal-mode return");
  // 2026-09-08: the window no longer resets at turn boundaries (a broken edit
  // tool must not cross turns into silent bash edits), so the declaration
  // comment and the two clear sites must both state the NEW semantics —
  // clearing lives ONLY at a successful edit and after a nudge.
  const decl = SRC.slice(SRC.indexOf("let editFailurePending = false;") - 600, SRC.indexOf("let editFailurePending = false;"));
  assert.match(decl, /cleared ONLY on a successful edit|cleared only on a successful edit/,
    "the declaration comment must state the new close-on-edit/nudge semantics");
  const beforeAgent = SRC.slice(promptAt, promptEnd > 0 ? promptEnd : undefined);
  assert.doesNotMatch(beforeAgent, /editFailurePending = false/,
    "before_agent_start must NOT clear the window any more");
  // 2. tool_result: a FAILED edit arms the window and appends the nudge.
  const resultAt = SRC.indexOf('pi.on("tool_result"');
  const resultEnd = SRC.indexOf('pi.on("session_start"', resultAt);
  const resultBody = SRC.slice(resultAt, resultEnd);
  assert.match(resultBody, /EDIT_FAILURE_NUDGE/);
  assert.match(resultBody, /editFailurePending = true/);
  // 3. tool_result bash: a write-looking command while the window is armed
  //    (cross-turn since 2026-09-08) gets the nudge once.
  assert.match(resultBody, /BASH_WRITE_NUDGE/);
  assert.match(resultBody, /editFailurePending = false/);
  // Both nudge sites are skipped in normal mode (the step-aside must not
  // add extension text to tool results).
  const normalGuards = (resultBody.match(/state\.taskMode === "normal"/g) ?? []).length;
  assert.ok(normalGuards >= 2, "both nudge sites must carry a normal-mode guard");
});

test("readonly-drill stall guard: in-memory nudge wired at the read-family and bash sites", () => {
  // USER REQUIREMENT (2026-09-18): a session can spend many minutes in
  // read-only tool calls (grepping node_modules/ source) that never produce
  // anything, and neither the L2 stall breaker (turn-boundary only) nor the
  // child-health progress reading (counts ANY tool call) trips. The guard
  // counts consecutive successful read-only calls and nudges at the limit.
  const resultAt = SRC.indexOf('pi.on("tool_result"');
  const resultEnd = SRC.indexOf('pi.on("session_start"', resultAt);
  const resultBody = SRC.slice(resultAt, resultEnd);
  // 1. The read-family branch (1.5 D) carries the counter + nudge.
  const readAt = resultBody.indexOf("READ_ONLY_TOOL_NAMES.has(event.toolName)");
  assert.ok(readAt >= 0);
  assert.ok(resultBody.indexOf("evaluateReadonlyStall", readAt) > readAt, "read-family branch must fold the counter");
  // The nudge TEXT comes from readonlyStallNudgeFor(state.taskMode) — the
  // module decides who hears it (normal + orchestrator hear nothing), so the
  // extension must never inline the constant at a call site again.
  assert.ok(
    resultBody.indexOf("readonlyStallNudgeFor(state.taskMode)", readAt) > readAt,
    "read-family branch must take the nudge text from the mode-aware selector",
  );
  // 2. The bash branch carries the counter + nudge too (drill workhorse).
  assert.ok(resultBody.indexOf('event.toolName === "bash"') > readAt);
  const bashAt = resultBody.indexOf('event.toolName === "bash"');
  assert.ok(resultBody.indexOf("evaluateReadonlyStall", bashAt) > bashAt, "bash branch must fold the counter");
  assert.ok(
    resultBody.indexOf("readonlyStallNudgeFor(state.taskMode)", bashAt) > bashAt,
    "bash branch must take the nudge text from the mode-aware selector",
  );
  assert.equal(
    (resultBody.match(/READONLY_STALL_NUDGE/g) ?? []).length,
    0,
    "no call site may inline the constant — the selector is the only source of the text",
  );
  // 3. Three fold sites total: edit-success reset, read-family count, bash count.
  const stallSites = resultBody.split("evaluateReadonlyStall").length - 1;
  assert.equal(stallSites, 3, "counter must be folded at exactly three sites (edit reset + read + bash)");
  const normalGuards = (resultBody.match(/state\.taskMode === "normal"/g) ?? []).length;
  assert.ok(normalGuards >= 4, "both new sites plus the two nudge sites carry a normal-mode guard");
  // 4. The counter state is a plain in-memory `let`, not a persisted field.
  assert.match(SRC, /let readonlyStallState: ReadonlyStallState \| undefined;/);
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

test("declare_done asks whether the round ARRIVED at its delivery station", () => {
  // The gates above it answer "is the work good enough"; this answers the
  // other half of the contract. It is wired ONCE, from the loop branch only:
  // an orchestrator has no repos of its own, so the same check there would be
  // an empty judgement at best and a deadlock at worst (the PR its child
  // opened is recorded in the CHILD's sidecar, which it cannot see).
  const calls = SRC.split("stationArrivalProblems(").length - 1;
  assert.equal(calls, 1, "exactly one call site — a second reading would be a second contract");
  const body = toolBodyOf("declare_done");
  assert.match(body, /stationArrivalProblems\(/, "…and it is inside declare_done");
  assert.match(body, /isEnforcedMode\(state\.taskMode\) && goalStageSatisfied\(\)/,
    "the station is only known once the user approved a goal that carries one — or switched the goal stage off; " +
    "the loop question is isEnforcedMode's, so an UNDECIDED session is judged too (real-session P1, 2026-09-22)");
  assert.match(body, /changedFiles\(root\)/, "committed-ness is measured, not asserted by the agent");
  assert.match(body, /st\.shippedKinds\?\.includes\("pr-create"\)/,
    "a `pr` round arrives on a `gh pr create` the GATE watched succeed — not on a claim");
  assert.match(body, /st\.copilot\?\.pr/,
    "…with the Copilot-resolved PR number as the second, independent proof");
  // EVIDENCE 3 (2026-09-16): neither of those exists when the PR was ALREADY
  // open and this round only appended to it — gh calls "already exists" an
  // error, and `copilotReview: false` resolves no number — so the gate asks
  // GitHub itself. The question runs ONLY when the two free facts are silent.
  assert.match(body, /probeOpenPr\(repoDirFor\(root\)\)/,
    "the third evidence is a question the GATE asks, never one the agent answers");
  // …and WHETHER it still has to ask, and whether the round arrived at all,
  // are the MODULE's two rules rather than a second expression written here
  // (round-1 quality P1, 2026-09-16): the extension used to re-derive "no local
  // evidence" in the OPPOSITE polarity, which is the kind of duplicate that
  // goes wrong silently when only one side is fixed.
  assert.match(body, /prEvidencePresent\(\{ observedPrCreate, recordedPr \}\)/,
    "…and the decision to ask GitHub is taken by the module's own predicate");
  assert.doesNotMatch(codeOnly(body), /station === "pr" && !observedPrCreate && recordedPr === null/,
    "the opposite-polarity copy of that rule must not come back");
  // The push reading is asked of EVERY `pr` round, not of one evidence
  // (round-1 quality P1, 2026-09-16): a checkpoint commit the gate lands after
  // the PR was opened is invisible to all three evidences alike.
  assert.match(body, /unpushed = hasUnpushedCommits\(repoDirFor\(root\)\)/,
    "every `pr` round reads the local upstream — no evidence stands in for it");
  assert.match(body, /^\s+unpushed,$/m, "…and that reading is what the judgement receives");
});

test("a FAILED `gh pr create` gets the answer the gate can look up itself", () => {
  // gh reports "a pull request for branch … already exists" as an ERROR, so the
  // success-only evidence has never seen it, and the agent is left reading
  // gh's stderr and guessing between appending to the PR and opening another.
  // The measured cost (user report, 2026-09-16) was an open PR closed and
  // reopened under a new number — so the gate asks GitHub and says the answer.
  const window = windowOf(
    "// A FAILED `gh pr create`",
    "const bashReadonlyNudgeText",
    "failed pr create",
  );
  assert.match(window, /event\.isError === true/,
    "only a failure needs this — a success is already evidence");
  assert.match(window, /observedShipKinds\(cmd\)\.includes\("pr-create"\)/,
    "the same narrowed evidence entry point, never the over-matching detector");
  assert.match(window, /existingPrNotice\(await probeOpenPr\(root\)\)/,
    "…and the sentence that names the PR comes from the module that asked GitHub");
  assert.match(codeOnly(window), /state\.taskMode !== "normal"/, "normal mode steps aside");
});

test("the ship-kind evidence is recorded on SUCCESS, and never behind the Copilot switch", () => {
  // Round-1 reviewer P1: the first version read `state.copilot.pr`, which is
  // only ever filled in by copilot_review — so
  // a repo with no `gh`, or one with copilotReview disabled, could open a real
  // PR and never satisfy the `pr` station. The evidence therefore has its own
  // recording site, above the Copilot block and independent of its switch.
  const window = windowOf(
    "// DELIVERY-STATION EVIDENCE",
    "// L7: a SUCCESSFUL PR-affecting ship",
    "ship-kind evidence",
  );
  // The comments in that window NAME the switch (they explain why it is not
  // used), so the "never behind the switch" rule is checked on the CODE only.
  const code = codeOnly(window);
  assert.match(code, /event\.isError !== true/,
    "an exit code is the whole point — a failed command proves nothing");
  assert.doesNotMatch(code, /copilotReview\.enabled/,
    "the evidence must not depend on a feature switch that has nothing to do with it");
  assert.match(code, /st\.shippedKinds = merged/);
  assert.match(code, /persistRepo\(/, "…and it survives the turn it was observed in");
  // Round-2/3 P2: the SAME detection both blocks and (now) grants, and it
  // over-matches on purpose — a heredoc body, a `node -e '…'` string and a
  // `python3 -c "…"` argument were all detected as `pr-create`. Evidence
  // therefore comes from the narrowed entry point, never from the raw
  // detector (teaching THAT about quoting would be a real ship-gate bypass).
  assert.match(code, /observedShipKinds\(cmd\)/,
    "arrival evidence must come from the evidence entry point");
  assert.doesNotMatch(code, /detectShipCommands\(cmd\)/,
    "…and never from the deliberately over-matching detector");

  // The evidence is per TASK: declare_done clears it with the rest of the
  // per-task bookkeeping, or task B inherits task A's PR.
  const done = toolBodyOf("declare_done");
  assert.match(done, /st\.shippedKinds = undefined/);
  assert.match(done, /state\.shippedKinds = undefined/);



});

test("request_arbitration refuses a STATION block before it can spend an appeal", () => {
  // The arbiter rules on whether a QUALITY block is circular; it was never
  // asked how far a round may travel, and the ship gate does not consult a
  // token while a station refusal stands. Accepting the appeal would spend one
  // of three and leave the command blocked with no explanation.
  const body = toolBodyOf("request_arbitration");
  const denyAt = body.indexOf("lastBlockedShip.stationBlocked");
  assert.ok(denyAt >= 0, "the station case must be handled at all");
  const quotaAt = body.indexOf("arbitration limit reached");
  const spendAt = body.indexOf("spendArbitration(ctx);");
  assert.ok(quotaAt > denyAt && spendAt > denyAt,
    "…and it must refuse BEFORE the quota check and before the appeal is spent");
  assert.match(body.slice(denyAt, quotaAt), /STATION_SHIP_NEXT_STEPS/,
    "the refusal hands over the two routes that actually move a station");
});


test("the ship gate reads the station from the APPROVED contract, and from nothing else", () => {
  const fn = windowOf("function deliveryStationFor(root: string)", "\n  }", "deliveryStationFor");
  assert.match(fn, /state\.taskMode === "orchestrator"/);
  assert.match(fn, /approvedPlan\?\.deliveryStation/,
    "an orchestration's ceiling is the plan the USER approved, not the plan file on disk");
  assert.match(fn, /!isEnforcedMode\(state\.taskMode\)\) return undefined/,
    "explore and normal have no contract — undefined, never the strictest station; " +
    "undecided carries the loop's contract (real-session P1, 2026-09-22), so it is NOT in this branch");
  assert.match(fn, /loopGoalConfirmed\(root, st\)\) return undefined/,
    "…and neither does a repo whose goal was never approved (L8 refuses that ship on its own terms)");
  assert.match(fn, /st\.loopGoal\?\.station \?\? DEFAULT_DELIVERY_STATION/,
    "an approved goal written before stations existed reads as the strictest one");
  assert.match(SRC, /deliveryStation: \(root\) => deliveryStationFor\(root\)/,
    "…and the ship gate is actually wired to it");
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

test("the reviewer verdict is recorded from the structured conclusion, and `record_review` is gone", () => {
  // 2026-09-04 (user decision D4): the recorder is a plain function taking the
  // judge's own structured conclusion. Its only reason to be a tool was that a
  // verdict had to be parsed back out of text the gate itself serialised.
  assert.match(SRC, /async function recordReviewVerdict\(/);
  assert.match(SRC, /adjudicateReviewConclusion\(/, "one adjudication decides the recorded verdict");
  assert.doesNotMatch(SRC, /name:\s*["']record_review["']/, "no tool surface may carry it back");
});

test("no fence is synthesised and none is parsed — anywhere in lib/ or the extension", () => {
  // Philosophy three, the whole point of this round: the gate used to
  // serialise a judge's structured conclusion into a ```json fence purely so
  // that its own parser could read it back. Both halves are deleted, and this
  // is the ratchet that keeps either from creeping back — a re-added parser
  // would be a second implementation of something the channel record already
  // carries as data.
  const GONE = [
    "parseReviewOutput", "parseFenceFindings", "parseFenceFileFindings",
    "extractNewestFenceText", "buildConcludeFence", "hasJudgeFence", "VERDICT_FENCE",
  ];
  const sources = [
    ...readdirSync(join(ROOT, "lib")).filter((f) => f.endsWith(".ts")).map((f) => join("lib", f)),
    join("extensions", "review-gate.ts"),
  ];
  const offences: string[] = [];
  for (const rel of sources) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    for (const symbol of GONE) {
      if (text.includes(symbol)) offences.push(`${rel}: ${symbol}`);
    }
  }
  assert.deepEqual(offences, [],
    `a deleted fence symbol came back:\n${offences.join("\n")}`);
  // `parsePrecommitOutput` is the ONE parser that stays: it reads a trusted
  // runner's `## Overall:` sentinel, which has nothing to do with a review.
  assert.match(SRC, /parsePrecommitOutput/, "the precommit sentinel parser must survive");
  assert.match(
    readFileSync(join(ROOT, "lib", "precommit-parse.ts"), "utf8"),
    /export function parsePrecommitOutput/,
  );
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
  // The template's decline row is NOT one of the three rulings (reviewer P1):
  // the human's own objection is carried back to the caller instead of being
  // reported as "human ruled GATE_WINS".
  assert.match(SRC, /if \(humanNote !== undefined\) \{[\s\S]{0,400}?用户的意见：\$\{humanNote\}/,
    "a typed objection must reach the agent, not just the audit log");
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
    ["命中敏感文件模式", SHIP_EDIT_SRC],
  ] as const) {
    const at = src.indexOf(factBlock);
    assert.ok(at > 0, `the B-class block must exist: ${factBlock}`);
    assert.ok(!src.slice(at, at + 600).includes("APPEAL_HINT"),
      `a FACT must not offer an appeal: ${factBlock}`);
  }
});

test("the checkpoint message is delegated to the pure, unit-tested lib module", () => {
  // Round-2 P2 (the impossible default) and the L5 non-English fallback both
  // live in lib/checkpoint-message.ts now, exercised by
  // test/checkpoint-message.test.ts (the conventional-commit fallback, the
  // body rules and the L5 fallback). The marker that used to be injected into
  // the scope is GONE (user decision, 2026-09-16). The extension only names
  // the call site — pin the delegation so the logic cannot silently move back
  // inline.
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
  //
  // NO SYNCHRONOUS SPAWN MAY COME BACK HERE. The one the gate allows — the
  // exit-path banner, an `exit` handler cannot await — lives in
  // lib/user-notify-runtime.ts, a module of its own (quality round P2: the
  // runtime half moved out of this file precisely because it was a new job in
  // an already huge one). A blocking spawn in the extension host freezes every
  // session, every judge pane and every child in the window.
  assert.doesNotMatch(SRC, /\bspawnSync\s*\(/, "a blocking spawn in the extension host freezes everything");
  const runnerBody = SRC.slice(SRC.indexOf("async function runTrustedPrecommit"));
  assert.ok(runnerBody.length > 0, "the runner must still be in this file");
  assert.doesNotMatch(runnerBody, /spawnSync\s*\(/,
    "the precommit runner may never spawn synchronously — it runs for minutes");
  // …AND THE EXIT PATH IS WIRED HERE, because it is what a test cannot reach:
  // the blocking spawn itself lives in the runtime module, and the two things
  // the extension owns are the registration and the clean-shutdown flag.
  const runtimeSrc = readFileSync(join(ROOT, "lib", "user-notify-runtime.ts"), "utf8");
  const syncSpawns = [...runtimeSrc.matchAll(/\bspawnSync\s*\(/g)];
  assert.equal(syncSpawns.length, 1,
    "exactly one synchronous spawn in the runtime — the exit banner, and nothing else");
  assert.match(runtimeSrc, /process\.on\("exit"/, "the exit handler lives with it");
  assert.match(runtimeSrc.slice(runtimeSrc.indexOf('process.on("exit"')),
    /exitNotifyKind\(\{ cleanShutdown \}\)/,
    "the handler must consult the rule in lib/user-notify.ts, not re-implement it");
  assert.match(runtimeSrc, /spawnSync\(bin!, args, \{ stdio: "ignore", timeout: 10_000 \}\)/,
    "bounded — a stuck notifier must not hold the process open");
  assert.match(SRC, /notifyRuntime\.armExitHandler\(\)/, "the extension registers it once, for the process");
  const shutdownAt = SRC.indexOf('pi.on("session_shutdown"');
  assert.ok(shutdownAt >= 0, "the shutdown handler must still exist");
  assert.match(SRC.slice(shutdownAt, shutdownAt + 700), /notifyRuntime\.markCleanShutdown\(\)/,
    "every clean shutdown reason (quit | reload | new | resume | fork) records itself, and the handler reads that");
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

  assert.match(body, /askConsent\(deps, uiCtx,/, "the extension must render the dialog itself");
  assert.doesNotMatch(body, /confirmed\s*:\s*Type\./,
    "no agent-supplied 'confirmed' parameter — that would be self-approval");
  assert.match(body, /if \(!uiCtx\.hasUI\)/, "no UI must fail closed instead of granting");
  assert.match(body, /unshowable/, "a dialog that could not be shown is not a decline");
});

test("SECURITY: request_sensitive_edit refuses .git internals before showing any dialog", () => {
  const body = toolBodyOf("request_sensitive_edit");
  const integrityAt = body.indexOf("isGateIntegrityPath");
  // The dialog itself lives in `askConsent` (2026-09-17); what matters here is
  // that the integrity refusal comes before the tool reaches for it.
  const confirmAt = body.indexOf("askConsent");
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

test("L8b: the goal audit recorder is TRUSTED — the extension reads the verdict and hashes the text", () => {
  // The recorder is a plain function in lib/goal-prereview-tools.ts (2026-09-04:
  // it was an internalTool named `record_goal_prereview` only because a verdict
  // had to be parsed out of text). The rule follows the code: read its window
  // plus the shared submission checks (`checkGoalDraft`), because the repo
  // binding and the length cap are asserted below and live there.
  const body =
    windowIn(GOAL_PREREVIEW_SRC, "export async function recordGoalPrereview(", "\n}", "recordGoalPrereview") + "\n" +
    windowIn(GOAL_PREREVIEW_SRC, "export function checkGoalDraft(",
      "\nexport function buildGoalRecordReply(", "checkGoalDraft");
  // The verdict is READ, never accepted: no `passed`/`verdict` parameter may
  // exist, or the pre-review becomes an agent self-certification again. It
  // arrives as the auditor's own structured conclusion off the channel report,
  // and the gate normalizes it itself — fail-closed on anything else.
  assert.match(body, /normalizeConcludedVerdict\(params\.conclusion\.verdict\)/,
    "the verdict comes from the auditor's structured conclusion");
  assert.match(body, /if \(!verdict\) \{/, "an unrecognised verdict records NOTHING");
  assert.match(body, /severityFindingsFrom\(params\.conclusion\.findings\)/,
    "the objections are taken verbatim, not re-derived from text");
  assert.doesNotMatch(body, /auditor_output|extractNewestFenceText|parseReviewOutput/,
    "no text is parsed for a verdict anymore");
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
  // Fail-closed: a round that never concluded records NOTHING (a wiped record
  // would silently downgrade a standing PASS, and a recorded one would be a
  // forgery).
  const noVerdict = body.indexOf("if (!verdict) {");
  const write = body.indexOf("goalSt.goalPrereview =");
  assert.ok(noVerdict > 0 && write > noVerdict, "the no-verdict guard must precede the sidecar write");
  // Same repo resolution as propose_loop_goal — literally the same function
  // now (never resolveToolRepo, which requires an already-edited repo and
  // would dead-end a second repo's goal).
  assert.match(body, /gitRootOfDir\)\(abs\)/);
  assert.doesNotMatch(body, /resolveToolRepo\(/, "it must not CALL resolveToolRepo (naming it in the rationale is fine)");
  // NOT A TOOL, on any host: pi must never learn a name for it, and neither
  // may the gate's own internal host (D4 — the tool wrapper existed only for
  // the text-parsing shape that is gone).
  assert.doesNotMatch(GOAL_TOOLS_SRC, /name: "record_goal_prereview"/,
    "the audit recorder must not be registered anywhere");
  assert.match(GOAL_TOOLS_SRC, /export function registerGoalTools\(host: ToolHost/,
    "…so the family entry point takes ONE host");
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
  // Wide enough for the whole function: the ownership check (2026-09-09) and
  // its why-comment sit between the orchestration branch and the judge
  // fallback, so a tight window would miss the fallback it must also assert.
  const binding = SRC.slice(bindingAt, bindingAt + 2600);
  assert.match(binding, /supervisionTarget\(\)/,
    "addressed to the ORCHESTRATION, so a handoff never retires the channel");
  assert.match(binding, /STATE_VARIANT_ENV/, "and to this session's own child id");
  assert.match(binding, /readJudgeSideEnv\(process\.env\)/,
    "a judge pane falls back to its opener's file — same medium, no second channel");
  assert.match(binding, /if \(!judgeSide\) return undefined/,
    "a standalone session reports nowhere");
  // The report itself is pi's own truth, never a screen.
  const reportAt = SRC.indexOf("function reportChildState(");
  assert.ok(reportAt > 0, "the child reports its own state");
  const report = SRC.slice(reportAt, reportAt + 1600);
  assert.match(report, /ctx\.isIdle\?\.\(\) === false/, "streaming is asked, not inferred");
  // 2026-09-09: the derivation itself moved to lib/orchestrator-child-channel.ts
  // (decideReportedChildState — pure, behaviour-tested); the wiring here feeds
  // it the four facts. The branch assertions that used to read this window now
  // read that function's source below, so the rules cannot quietly disappear.
  assert.match(report, /decideReportedChildState\(/, "the pure derivation is called, not re-derived");
  assert.match(report, /state\.completion\?\.at/,
    "R3-5: a finished child is `done`, and one that merely stopped is `idle`");
  assert.match(report, /hasBackgroundWaits\(backgroundWaits\)/,
    "waiting on its own background agent feeds the derivation");
  // Round-4 P0 — a judge round of its own is neither `working` nor `idle`.
  assert.match(report, /activeJudgeWait\(\)/,
    "a judge THIS session dispatched is a fact the gate holds, never something to infer from silence");
  assert.doesNotMatch(report, /capture-pane|screenLooksBusy/, "no screen is consulted, in any state");
  // The branch rules, where they live now — order is load-bearing (forced >
  // waiting-judge > streaming > done > background wait > idle). The 2026-09-17
  // move put the RECORDED COMPLETION above the background wait: a child that
  // declared done while one of its subagents never sent a terminal signal used
  // to report `working` for the rest of its life.
  const decideAt = CHILD_CHANNEL_SRC.indexOf("export function decideReportedChildState(");
  assert.ok(decideAt > 0, "the pure derivation lives in lib/orchestrator-child-channel.ts");
  const decide = CHILD_CHANNEL_SRC.slice(decideAt, decideAt + 900);
  assert.match(decide, /"waiting-judge"/,
    "a healthy review round is reported as its own state, never read as a hang");
  assert.match(decide, /if \(args\.streaming\) return "working"/,
    "a turn actually in flight is working");
  assert.match(decide, /if \(args\.completedAt\) return "done"/,
    "…and a recorded declare_done outranks everything below it, including a background wait nobody is coming back for");
  assert.match(decide, /if \(args\.waitingOnBackground\) return "working"/,
    "waiting on its own still-running subagent is work, not a stop");
  assert.ok(
    decide.indexOf("if (args.completedAt) return") < decide.indexOf("if (args.waitingOnBackground) return"),
    "the completion is decided before the leftover wait — the whole fix",
  );
  assert.match(decide, /return "idle"/);

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
  const settled = loopSettledWindow("\n  });");
  assert.match(settled, /reportChildState\(ctx\)/);
  assert.match(settled, /drainChildInstructions\(ctx\)/, "and the orchestrator's messages are applied there");
  const turnEnd = windowOf('pi.on("turn_end"', "\n  });", "turn_end");
  assert.match(turnEnd, /reportChildState\(ctx\)/, "turn_end still reports — the timer is a floor, not a replacement");

  // Delivery is pi's API, never a keyboard.
  const drainAt = SRC.indexOf("async function drainChildInstructions(");
  const drain = SRC.slice(drainAt, drainAt + 6500);
  assert.match(drain, /pi\.sendUserMessage\(text, \{ deliverAs: instruction\.mode \}\)/,
    "delivery is pi's own API, raced against a short bound so the ack is not minutes late");
  assert.match(drain, /await deliverInterrupt\(interruptText, \{/,
    "an interrupt WITH text goes through the stop-then-speak handoff (2026-09-21): abort, WAIT for the pane to be idle, and only then send");
  assert.match(drain, /sendNow: \(text\) => pi\.sendUserMessage\(text\)/,
    "…and the delivery is the BARE call — `deliverAs` is what queued the text into the queue the abort stopped draining");
  assert.doesNotMatch(drain, /deliverAs: "steer"/,
    "the losing race must not come back: `abort()` then `steer` is the 552-second deadlock (lib/interrupt-delivery.ts)");
  assert.match(drain, /delivered\.delivered === "turn" \? "injected" : "received"/,
    "a deferred delivery is acknowledged as RECEIVED, never as injected");
  assert.match(drain, /ctx\.abort\?\.\(\)/, "interrupt is ctx.abort(), not a Ctrl-C keystroke");
  // STOP-FIRST (2026-09-01): an open dialog is dismissed BEFORE the message
  // is injected — the measured deadlock was the box staying up while the
  // child wedged on it.
  assert.match(drain, /gateInterruptController\.abort\(\)/,
    "interrupt/steer dismiss an open dialog first");
  assert.match(drain, /gateInterruptController = new AbortController\(\)/,
    "and a FRESH controller so one interrupt never cancels a later dialog");
  assert.match(drain, /acknowledgeInstruct\(binding, instruction\.instructId, false/,
    "a failure is acknowledged AS a failure — the receipt the orchestrator builds on");
  // Round-4 P1 — the two-stage handshake. `received` is written BEFORE any
  // injection is attempted: that is what lets a `followUp` to a busy child be
  // reported as delivered instead of silently lost.
  assert.match(drain, /"received"/, "the child says it HAS the instruction first");
  assert.match(drain, /"injected"/, "and separately that pi actually took it");
  assert.match(drain, /acknowledgedReceipts/,
    "the receipt is written once per instruction, not once per heartbeat tick");


  // Spawn side: the judge pane is still told who opened it — as channel
  // identity in its environment, not as a parent session pointer. Since the
  // session factory landed the env is ASSEMBLED there (one place for a
  // cross-process contract), so the dispatch names the opener as the judge
  // role's `openerId` and lib/session-factory.ts turns it into RG_JUDGE_OPENER.
  const spawnAt = SRC.indexOf("function dispatchJudgeRound(");
  // Sized to the whole function (it grew when the spawn learned to verify its
  // delivery, and again when the reuse branch started stamping the round number
  // into the instruction record); a window that stopped short would silently
  // assert about half a function and pass for the wrong reason.
  const spawn = SRC.slice(spawnAt, spawnAt + 19000);
  assert.match(spawn, /kind: "judge",\s*\n\s*openerId: opener,/, "the pane is told who opened it");
  assert.match(
    readFileSync(new URL("../lib/session-factory.ts", import.meta.url), "utf8"),
    /\[JUDGE_OPENER_ENV\]: role\.openerId/,
    "…and the factory is what writes it into the pane's environment",
  );
});

test("every gate dialog is answerable by EITHER the human or the project manager", () => {
  const funnelAt = SRC.indexOf("async function askEitherSide(");
  assert.ok(funnelAt > 0, "there is ONE funnel every gate question goes through");
  const funnel = SRC.slice(funnelAt, funnelAt + 900);
  assert.match(funnel, /askThroughChannel\(binding, \{ \.\.\.request, hasUI \}, render, currentInterruptSignal\(\)\)/,
    "the race lives in the pure module, not in the extension — and the dialog listens to the gate's interrupt source");
  assert.match(funnel, /if \(!binding\) \{/, "a session with no orchestration falls back to rendering the dialog");

  // The goal approval is the one dialog constraint 8 applies to, so its
  // request must carry the DRAFT — that is the text the crosscheck reads.
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
  // The verdict recorder derives per-file finding severities for the file streak.
  const recBody = recordVerdictBody();
  assert.match(recBody, /fileFindingsFrom\(concluded\.findings as ReviewFinding\[\]\)/,
    "severity+file come straight off the judge's own findings");
  assert.match(recBody, /recordedFindingsFrom\(fileFindingsFrom\(/, "the file lists are derived for the streak");
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
  // The recheck itself is what this protects; the registry it reads is now the
  // merged table, scoped to this opener (the `childSessions` Map is deleted).
  assert.match(schedule, /ownJudges\(\)\.length === 0/, "watchdog rechecks that children still exist");
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
  const settledAt = SRC.indexOf(LOOP_SETTLED);
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
  assert.match(body, /role: Type\.Enum\(SUBMITTABLE_JUDGE_ROLES\)/, "the role is the addressing key");
  assert.match(body, /task: Type\.String\(/, "the task text is the other input");
  assert.doesNotMatch(body, /sessionId: Type\./, "the agent never passes a session id");
  assert.doesNotMatch(body, /title: Type\./, "the agent never passes a title");
  // The title is derived from the role ACTUALLY dispatched, which the chain
  // decides (`reviewer` for a docs-only round or a standing quality pass,
  // `quality-auditor` otherwise) — the agent still passes no title at all.
  assert.match(body, /const title = `\$\{judge\.role\}-/, "the gate derives the display title itself");
  assert.match(body, /dispatchJudgeRound\(\{[\s\S]{0,400}?role: judge\.role,/, "dispatch is delegated to the one spawn owner");
  // The quality round is NOT a role the agent may name: it is routed to. The
  // enum and the second validation come from ONE constant, or they disagree
  // about what "unknown role" means (reviewer P2, 2026-09-15).
  assert.match(body, /Object\.hasOwn\(SUBMITTABLE_JUDGE_ROLES, role\)/, "the validation uses the same list as the enum");
  assert.doesNotMatch(body, /JUDGE_ROLES\.includes\(role/, "JUDGE_ROLES is not the agent-facing list");
  assert.doesNotMatch(body, /quality-auditor: "quality-auditor"/, "judge_submit's role enum does not expose the quality judge");
});

test("dispatchJudgeRound owns identity: stable dir per role+repo+opener, pane reuse, fresh-kill", () => {
  const at = SRC.indexOf("function dispatchJudgeRound(");
  assert.ok(at > 0, "the single dispatch owner must exist");
  // BOTH ENDS ASSERTED, no fixed slice length. This window used to be
  // `SRC.slice(at, at + 14000)`, and the function outgrew it — a truncated
  // window does not fail, it just quietly stops covering the tail, so every
  // `doesNotMatch` below would pass on text nobody read.
  const body = windowOf("function dispatchJudgeRound(", "\n  function readRoundStdout(", "dispatchJudgeRound body");
  // B5: the work dir is derived from role+repo+opener+lane — NEVER from the round's title,
  // which gave pi a new --session-dir every round and restarted the session.
  assert.match(body, /judgeWorkDirFor\(role, shortRepoHash\(root\), opener, lane\)/,
    "the work dir is a function of role+repo+opener+lane");
  assert.doesNotMatch(body, /judge-sessions", `rg-\$\{title\}`/, "no title-derived session dir may come back");
  // ONE lane per dispatch, resolved before anything is derived from it: the id
  // and the dir must name the SAME lane, and a second resolution could both
  // hand back a different one and advance the round count twice.
  assert.match(body, /const rotation = resolveJudgeLane\(root, role, opener\);/,
    "the lane comes from the one resolver");
  assert.equal(body.match(/resolveJudgeLane\(/g)?.length, 1,
    "the lane is resolved exactly once per dispatch");
  assert.match(body, /const lane = rotation\.decision\.lane;/,
    "every derivation reads that one lane");
  // Opener-scoped ids cannot collide across sessions: a second opener derives a
  // different id and opens its own review — there is no cross-opener refusal here.
  assert.match(body, /callerIdentity\(\)/, "the opener is the caller's own identity, never a parameter");
  assert.match(body, /judgeSessionIdFor\(role, shortRepoHash\(root\), opener, lane\)/,
    "the session id carries the opener and the lane");
  assert.doesNotMatch(body, /owned\.openerId !== opener/,
    "no second-opener refusal may come back: scoped ids cannot collide");
  assert.match(body, /sweepStaleJudgeSessionDirs\(root\)/,
    "dispatch sweeps the session dirs nobody owns");
  // A living pane takes the round through its channel — there is no
  // refuse-busy anymore (that belonged to the one-shot process).
  assert.match(body, /kind: "instruct"/, "reuse delivers the round as a channel record");
  assert.match(body, /mode: "interrupt"/,
    "…as an INTERRUPT: a re-dispatch means the content changed, so the round in flight is already obsolete "+
    "(user decision 2026-09-16) — waiting for it only waits out a verdict on code that is gone");
  assert.doesNotMatch(body, /mode: "followUp"/,
    "the queued delivery is what let the numbering race: the task sat on the wire while the entry moved on");
  assert.match(body, /const roundSeq = nextJudgeRound\(opener, judgeId\);/,
    "the round number is computed BEFORE the record is written, so the task can carry it");
  assert.match(body, /mode: "interrupt",\s*\n\s*roundSeq,/, "…and it travels with the task");
  assert.doesNotMatch(body, /refuse-busy/, "no busy refusal may come back");
  assert.doesNotMatch(body, /spawnJudgeProcess\(\{/, "no process spawn may come back");
  assert.doesNotMatch(body, /registerWatch\(|rememberChildProcess/, "no process watcher may come back");
  // Context reuse is a property of the SESSION: a re-open under the same
  // session id continues the transcript that is already on disk.
  assert.match(body, /hasTranscript\(sessionDir\)/,
    "reuse is decided by the transcript, not by a live pane");
  assert.match(body, /await openSessionPane\(run, \{/,
    "a real pane open still exists for the no-reuse case — through the ONE factory");
  // fresh:true kills the living pane FIRST (singleton per role+repo+opener),
  // and since 2026-09-05 it goes through ONE helper rather than carrying its
  // own copy of the close. That helper used to ask the shared label-bar
  // question too; the release is deleted (2026-09-17, user decision), so all
  // that is left of it is the close itself.
  assert.match(body, /closeJudgePaneOf\(existing, \{ ownPane, tmuxServer, run \}\)/,
    "fresh kills the pane through the shared close helper");
  assert.doesNotMatch(body, /releasesWindowLabels\(\{/,
    "…and does not re-inline the label-bar rule");
  const closeHelper = windowOf("function closeJudgePaneOf(", "\n  /**\n   * Retire a lane the gate has stopped using",
    "closeJudgePaneOf body");
  assert.match(closeHelper, /closeSessionPane\(ctx\.run, entry\.paneId\)/, "the helper is what closes the pane");
  assert.doesNotMatch(closeHelper, /setw|-u |hideLabelsVia/,
    "…and writes no window option: the bar is never released (user decision 2026-09-17)");
  assert.match(body, /reapReviewScratch\(sessionId\)/, "a dead pane's scratch worktrees are reclaimed");
});

test("judge_close / judge_wait address a judge by ROLE", () => {
  // One role enum, shared by both tools (a third spelling of it is how

  // two of them would silently start accepting different roles).
  // Five roles: the judge roles an AGENT may address. `arbiter` runs outside
  // this surface, and `quality-auditor` / `acceptance` are here even though the
  // agent never REQUESTS those rounds — a round that can ask a question must be
  // answerable.
  assert.match(
    JUDGE_TOOLS_SRC,
    /export const ADDRESSABLE_JUDGE_ROLES: Readonly<Record<string, string>> = Object\.freeze\(\{\s*reviewer: "reviewer",\s*"quality-auditor": "quality-auditor",\s*adviser: "adviser",\s*"goal-auditor": "goal-auditor",\s*acceptance: "acceptance",\s*\}\);/,
    "the named shared role list is the judge roles an agent can address",
  );
  // …and BOTH consumers come from it. The enum and the "needs a role" refusal
  // text were two literals, and adding `acceptance` to only one of them is
  // exactly the drift this pins (reviewer P2, 2026-09-22).
  assert.match(JUDGE_TOOLS_SRC, /const ROLE_PARAM = Type\.Optional\(Type\.Enum\(ADDRESSABLE_JUDGE_ROLES\)\)/,
    "the parameter enum is built from the list");
  assert.match(JUDGE_TOOLS_SRC, /needs a role \(\$\{Object\.keys\(ADDRESSABLE_JUDGE_ROLES\)\.join\(" \/ "\)\}\)/,
    "the refusal text is built from the same list");
  for (const tool of ["judge_close", "judge_wait"]) {

    const body = toolBodyOf(tool);
    assert.match(body, /role: ROLE_PARAM/, `${tool} takes a role`);
    assert.match(
      JUDGE_TOOLS_SRC,
      new RegExp(`addressJudge\\(deps, params, "${tool}"(, gateSelf)?\\)`),
      `${tool} addresses its judge through the shared resolver`,
    );
  }
  // The lookup itself is the extension's (the registries live there) — the
  // tools only ever ASK for it, then check the opener before touching it.
  assert.match(
    JUDGE_TOOLS_SRC,
    /deps\.findChild\(addressed\.root, addressed\.role, addressed\.judgeId\)/,
    "the child is resolved by role first, in the repo that was addressed",
  );
  assert.match(judgeToolsWiring(), /findChild: \(root, role, judgeId\) => \{/,
    "…and the wiring answers it from the extension's own registry");
  assert.match(JUDGE_TOOLS_SRC, /function checkOpener\(/, "the opener check is one shared helper");
  assert.equal(
    (JUDGE_TOOLS_SRC.match(/checkOpener\(deps, /g) ?? []).length,
    2,
    "close and wait each pass the opener check before touching the judge",
  );
  // `judge_read` is DELETED (2026-09-05, D4): a zero-caller path, invisible to
  // agents and called by no gate chain, whose only remaining effect was to
  // give injected texts a tool name nobody could reach.
  assert.ok(!JUDGE_TOOLS_SRC.includes(`name: "judge_read"`), "judge_read must not be registered anywhere");
  assert.ok(!JUDGE_TOOLS_SRC.includes("async function doRead("), "judge_read's implementation is gone, not orphaned");
  assert.ok(!SRC.includes(`name: "judge_read"`), "the extension must not register it either");
  assert.ok(!SRC.includes(`callTool("judge_read"`), "…and no gate chain may still call it");


  // The old names are RETIRED — no alias, no compatibility shim.
  for (const gone of ["review_read", "review_close", "review_wait"]) {
    assert.ok(!SRC.includes(`name: "${gone}"`), `${gone} must no longer be registered in the extension`);
    assert.ok(!JUDGE_TOOLS_SRC.includes(`name: "${gone}"`), `${gone} must no longer be registered in lib/`);
  }
});

test("the TEN advanced entries are not registered anywhere an agent can see", () => {
  // Philosophy three, mechanically. FIVE of them still exist as
  // implementations (captured into `internalHost` so `judge_submit` and
  // `propose_loop_goal` call ONE copy of each mechanical check); three were
  // deleted outright; the two RECORDERS are plain functions on no host at all
  // (2026-09-04). Either way `pi` never learns the name.
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

test("judge_close stays gate-internal; judge_wait is ONE implementation on BOTH hosts", () => {
  // Closing a pane belongs to the gate: its only callers are the audit chains
  // closing the auditor they opened. WAITING does not — an opener with nothing
  // left to do must be able to wait for its judge's next message through a
  // tool, or it writes a `sleep` loop and locks itself out of its own wake-up
  // (measured 2026-09-05: nine minutes, one unrecorded report).
  assert.ok(!SRC.includes(`pi.registerTool({\n    name: "judge_close"`),
    "judge_close must not be registered with pi");
  assert.ok(JUDGE_TOOLS_SRC.includes(`name: "judge_close"`),
    "judge_close's implementation must stay (gate chains call it)");
  assert.ok(JUDGE_TOOLS_SRC.includes(`name: "judge_wait"`), "judge_wait's implementation stays in lib/");
  // ONE implementation, TWO hosts (D1): the agent registration must go through
  // the same registrar, over the same deps object — a second `registerTool`
  // written inline in the extension would be the second implementation.
  assert.match(SRC, /registerJudgeSessionTools\(internalHost, judgeSessionDeps\)/,
    "the family is wired through internalHost, not pi");
  assert.doesNotMatch(SRC, /registerJudgeSessionTools\(pi,/,
    "pi must never receive the whole management family");
  assert.match(SRC, /registerJudgeWaitTool\(pi, judgeSessionDeps\)/,
    "the agent surface gets judge_wait — the SAME implementation, over the SAME deps");
  assert.equal(
    (JUDGE_TOOLS_SRC.match(/name: "judge_wait"/g) ?? []).length,
    1,
    "…and it is registered from exactly one place in lib/",
  );

  // …while the intent entries stay visible: submit spawns rounds, spawn opens
  // goal/plan audits, answer replies through the gate.
  assert.ok(SRC.includes(`pi.registerTool({\n    name: "judge_submit"`),
    "judge_submit stays agent-visible");
  assert.match(SRC, /registerJudgeSpawnTools\(pi,/,
    "the spawn family (spawn/answer/recover) stays agent-visible");
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

/**
 * Every tool an AGENT can actually call — DERIVED from the registrations, not
 * declared in a list a human keeps in sync.
 *
 * Two shapes reach `pi`: a direct `pi.registerTool({ name: … })` in the
 * extension, and a lib registrar the extension wires with `pi` (the same
 * registrar wired with `internalHost` is invisible, which is the whole point
 * of the split). `judge_conclude` lands here too — it registers with `pi`
 * behind a judge-side env check, so it is callable by SOME session; a text
 * naming it is not naming a tool nobody has.
 *
 * Registration also CHAINS: a registrar wired with `pi` may register a second
 * family with the same host (`registerUserInteractionTools` → the consent
 * tools, `registerOrchestratorSessionTools` → the recovery tools), so the
 * walk follows `register…(host, …)` calls out of each body it accepts.
 */
function agentVisibleTools(): Set<string> {
  const defs = new Map<string, string>();
  for (const file of readdirSync(join(ROOT, "lib")).filter((f) => f.endsWith(".ts"))) {
    const code = readFileSync(join(ROOT, "lib", file), "utf8");
    for (const m of code.matchAll(/export function (register\w+)\(/g)) defs.set(m[1]!, code);
  }
  const names = new Set<string>();
  for (const m of SRC.matchAll(/pi\.registerTool\(\{\s*\n?\s*name: "([a-z_]+)"/g)) names.add(m[1]!);
  const queue = [...defs.keys()].filter((r) => new RegExp(`\\b${r}\\(pi,`).test(SRC));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const registrar = queue.shift()!;
    if (seen.has(registrar)) continue;
    seen.add(registrar);
    const code = defs.get(registrar);
    if (code === undefined) continue;
    const body = windowIn(code, `export function ${registrar}(`, /\n\}\n/, registrar);
    for (const n of body.matchAll(/name: "([a-z_]+)"/g)) names.add(n[1]!);
    // A name can also be a CONSTANT (`name: JUDGE_CONCLUDE_TOOL`) — resolve it
    // in the module that declares it, or the tool reads as unregistered.
    for (const n of body.matchAll(/name: ([A-Z][A-Z0-9_]+)\b/g)) {
      const literal = code.match(new RegExp(`${n[1]!}\\s*=\\s*"([a-z_]+)"`));
      if (literal) names.add(literal[1]!);
    }

    for (const n of body.matchAll(/\b(register\w+)\(host,/g)) queue.push(n[1]!);
  }
  return names;
}


test("every tool name in agent-readable text is a tool that EXISTS on the agent surface", () => {
  // THE DEFECT THIS EXISTS FOR (measured 2026-09-05). `judge_wait` was taken
  // off the agent surface, and three injected texts kept telling the agent to
  // call it — a tool receipt ("用 judge_wait 等结论"), a stall hint ("用
  // judge_read 看一眼"), and the judge-side deny list. An instruction pointing
  // at a tool the reader cannot call is worse than no instruction: it reads as
  // "there is a way to do this" and there is not.
  //
  // COVERAGE IS THE POINT (user decision D5). It is not enough to scan the
  // texts the extension injects directly: `prepare_review`'s refusal is
  // CONCATENATED into an agent-facing reply by the extension
  // ("review-gate: 本轮未送审 — prepare_review 被拒。" + toolText(prepared)),
  // so lib/review-prepare-tools.ts and lib/advisory-prepare-tools.ts are in
  // scope as well. Every lib module plus the extension is scanned; narrowing
  // the scan is not an available fix.
  const surface = agentVisibleTools();
  assert.ok(surface.has("judge_submit") && surface.has("judge_wait") && surface.has("ask_user"),
    "the derivation itself must work before its verdict means anything");
  assert.ok(!surface.has("judge_close"), "…and it must NOT see what only internalHost got");

  // Names that may legitimately appear WITHOUT being callable: the ones the
  // gate deleted or kept internal. They are governed by the ratchet above
  // (count frozen per file) and by `deletedToolInstructions` (no imperative),
  // so this test hands them over rather than judging them twice.
  const governedElsewhere = new Set([...DELETED_TOOL_NAMES, "judge_read", "judge_close"]);
  const TOOL_TOKEN = /\b(?:judge|orchestrator|prepare|record|propose|declare|request|check)_[a-z][a-z_]*\b/g;
  const offences: string[] = [];
  const sources = [
    ...readdirSync(join(ROOT, "lib")).filter((f) => f.endsWith(".ts")).map((f) => join("lib", f)),
    join("extensions", "review-gate.ts"),
  ];
  for (const rel of sources) {
    readFileSync(join(ROOT, rel), "utf8").split("\n").forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      if (!line.includes('"') && !line.includes("'") && !line.includes("`")) return;
      for (const m of line.match(TOOL_TOKEN) ?? []) {
        if (surface.has(m) || governedElsewhere.has(m)) continue;
        offences.push(`${rel}:${i + 1} — ${m}`);
      }
    });
  }
  assert.deepEqual(offences, [],
    "agent-readable text names a tool that is registered nowhere an agent can reach it. " +
    "Either register it, or stop naming it.");
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
    // 2026-09-04: −1 — the reviewer task text stopped naming `record_review`
    // (it is no longer a tool on any host; the sentence now says "the gate
    // re-checks … when it records your verdict").
    "review-prepare-tools.ts": 4,
    // The `/precommit` command's `callTool("run_precommit", …)` wiring moved
    // here with the command layer.
    "gate-command-tools.ts": 1,
    // 2026-09-04: `record_goal_prereview` and `record_review` are no longer
    // tools on ANY host (user decision D4) — the goal family's own mentions
    // and the extension's `callTool("record_review", …)` wiring went with
    // them, so both counts drop.
    // 2026-09-02: the non-git short-circuit refusals named the two internal
    // steps they disable; the review one now speaks for a plain function and
    // names nothing.
    // 2026-09-04: judge_spawn 的 buildGoalAuditTask 走同一条
    // callTool("prepare_goal_audit") 接线（门禁内部组装审计任务，agent 只给
    // 意图）。接线引用，不是调用指令。
    // 2026-09-05: 19 → 17。goal 审计任务的三份逐字副本合成了一份
    // (`buildGoalAuditRound`)，所以 callTool("prepare_goal_audit") 的接线引用
    // 也从三处降到一处。
    // 2026-09-08: 17 → 18。submitForReview 把 round note 传给 review_checkpoint
    // (`{ message, note: input.note, ... }`)——依赖论证门禁从 agent 自己的话里读
    // 论证。接线引用，不是调用指令。
    "review-gate.ts": 18,
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

/** The sixteen names that are no longer registered with pi. */
const DELETED_TOOL_NAMES = [
  "run_precommit", "review_checkpoint", "prepare_review", "prepare_adviser",
  "prepare_goal_audit", "record_review", "record_goal_prereview",
  "review_spawn", "review_watch", "review_send",
  "orchestrator_read", "orchestrator_key", "orchestrator_status",
  "orchestrator_send", "orchestrator_relay",
  // 2026-09-05 (D4): deleted outright, implementation and all — it had no
  // caller on either host. Saying so in a document stays allowed; telling
  // anyone to call it does not.
  "judge_read",
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







test("judge_wait applies the MESSAGE-DRIVEN criteria and returns the standard report", () => {
  const body = toolBodyOf("judge_wait");
  assert.match(body, /clampWaitTimeout\(.*params\.timeoutMs/, "the blocking window is clamped by the gate");
  assert.match(body, /probeJudgeWait\(deps, child, cursors\)/, "the loop probes with the shared criteria");
  // The wait SKELETON is generic (lib/poll-wait.ts) and this tool only injects
  // its own criteria — the next waiter reuses the loop instead of copying it.
  assert.match(body, /await pollUntil\(\{/, "the loop itself comes from the shared waiter");
  assert.match(body, /isDone: \(o\) => o\.done/, "…with this tool's criteria injected");
  assert.doesNotMatch(body, /while \(!outcome\.done/, "no hand-rolled wait loop may come back");
  // The RETURN carries the recorded verdict — a NEW channel report ends the
  // round, a dead pane ends it as failed. Since 2026-09-05 the wait does NOT
  // pick that report itself: it hands the round to the audit-round engine,
  // which selects, records and consumes it for every kind in one place.
  assert.match(body, /deps\.settleRound\(child\.judgeId, addressed\.root\)/, "a new report goes through the ONE round engine");
  assert.doesNotMatch(body, /reportConclusion\(io, projection\.lastReport\)/,
    "the wait may not read the channel a second time — that was the second entry point");
  assert.doesNotMatch(body, /rememberCursors\(deps, child\.judgeId, \{ lastReportId/,
    "…nor keep its own report cursor: the engine advances it, and only after a record landed");
  assert.match(body, /pane-dead/, "a dead pane ends the wait as failed");
  assert.match(body, /lastFindingCount: observation\.seenFindingCount/, "…and a shown finding cannot end the next one");
  const probe = windowIn(JUDGE_TOOLS_SRC, "export function probeJudgeRound(", "\n}", "probeJudgeRound");
  // The report criterion is the ENGINE's, not the probe's own comparison
  // (2026-09-05): while the probe picked "newest report ≠ cursor" by itself, it
  // ended rounds on reports the recorder refused, and the opener acted on the
  // announcement.
  assert.match(probe, /selectRoundReport\(read\.records, \{ \.\.\.binding, consumedReportId \}\)/,
    "the report criterion is the shared selector, applied to this round's binding");
  assert.doesNotMatch(probe, /projection\.lastReport/,
    "…and the probe may not pick a report on its own again");
  assert.match(probe, /judgePaneAlive\(deps\.tmux/, "pane death is probed from tmux, not inferred");
  // The two NEW criteria read what the gate ALREADY writes (P0: the judge-side
  // record format is untouched) — the round's stream file and the channel's
  // own open requests, never a new record kind.
  const waitProbe = windowIn(JUDGE_TOOLS_SRC, "export function probeJudgeWait(", "\n}", "probeJudgeWait");
  assert.match(waitProbe, /recentStreamFindings\(deps, child\.streamPath\)/, "findings come from the existing stream file");
  assert.match(waitProbe, /cursors\.announcedQuestions\.has\(q\.requestId\)/, "questions come from the channel's open requests");
  assert.match(waitProbe, /seenFindingCount > cursors\.findingCount/, "…and only what is NEW ends the wait");
  // ONE report format for both wake-up paths (D2): the wait must not grow its
  // own prose.
  assert.match(body, /buildStandardReport\(\{/, "the reply is the gate's standard report");
  assert.doesNotMatch(body, /本轮已结束（判据/, "no second report text may come back");
  // …and the OTHER wake-up path — the gate noticing a finished round on its
  // own at settle time — speaks through the same builder. Two formats would be
  // two things to keep truthful, and the opener would have to learn both.
  const settle = windowOf("async function settleFinishedRounds(", "\n  /**", "settleFinishedRounds");
  assert.match(settle, /buildStandardReport\(\{/, "the settle wake-up uses the same builder");
});

test("ONE report is recorded ONCE — the wait and the settle share a single cursor", () => {
  // THE RISK THE TWO WAKE-UP PATHS CREATE. Since 2026-09-05 a finished round
  // can be picked up by either `judge_wait` (the opener was blocking) or the
  // settle sweep (it was not). Both RECORD, so a report seen by both would be
  // recorded twice — a second verdict for a round that only happened once.
  //
  // What makes that impossible is that neither path owns a cursor of its own:
  // both write and read `JudgeEntry.lastReportId`. This is the assertion the
  // report's own §7 said was missing — the behaviour is unit-tested on the
  // wait side (test/judge-session-tools.test.ts: "the consumed report does not
  // end a second wait"), and pinned HERE on the settle side, where driving the
  // extension's hook from a unit test is not practical.
  // Since 2026-09-05 NEITHER path selects the report: both hand the round to
  // the engine, which selects, records and consumes it. "Recorded once" is
  // therefore structural — there is one cursor write, in one function.
  const recorder = windowOf("async function recordJudgeConclusion(", "\n  /**", "recordJudgeConclusion");
  assert.match(recorder, /settleAuditRound\(auditRoundDeps\(ctx\), \{ judgeId: sessionId, root: childRoot \}\)/,
    "the settle path closes the round through the engine");
  assert.doesNotMatch(recorder, /last\.reportId === entry\?\.lastReportId/,
    "…and no longer decides for itself which report is this round's");
  const settleFn = windowIn(AUDIT_ROUND_SRC, "export async function settleAuditRound(", "\n}", "settleAuditRound");
  assert.match(settleFn, /selectRoundReport\(deps\.readRoundRecords\(entry\), \{/,
    "the engine picks this round's report through the ONE selector");
  // THE ORDERING IS THE GUARANTEE: an unrecorded round returns before the
  // cursor moves, so a verdict that could not be written is retried rather
  // than silently consumed. `lastIndexOf` because the advice branch advances
  // the same cursor earlier in the function.
  const advanceAt = settleFn.lastIndexOf("deps.advanceCursor(entry.judgeId, report.reportId)");
  const unrecordedAt = settleFn.indexOf('status: "unrecorded"');
  assert.ok(advanceAt > 0 && unrecordedAt > 0 && unrecordedAt < advanceAt,
    "the unrecorded return must come BEFORE the cursor advance");
  const advance = windowOf("function advanceReportCursor(", "\n  }", "advanceReportCursor");
  assert.match(advance, /lastReportId: reportId/, "the settle cursor IS JudgeEntry.lastReportId");
  // The wait writes the same field, through its own small helper — still used
  // for the FINDING cursor, which is not the engine's business.
  const waitCursor = windowIn(JUDGE_TOOLS_SRC, "function rememberCursors(", "\n}", "rememberCursors");
  assert.match(waitCursor, /\.\.\.entry, \.\.\.patch/, "the wait patches the SAME registry entry");
  assert.doesNotMatch(toolBodyOf("judge_wait"), /rememberCursors\(deps, child\.judgeId, \{ lastReportId/,
    "the wait may NOT write the report cursor itself — that is the engine's single write");
  // A cursor per path would be the defect this pins against — and it would be
  // BORN where the cursors are written and typed: lib/judge-session-tools.ts
  // (rememberCursors / JudgeWaitCursors) or the registry entry in
  // lib/hierarchy.ts. The extension only READS `lastReportId`, so scanning it
  // alone would have been a guard aimed at the wrong file (round-5 Nit).
  for (const [label, src] of [
    ["judge-session-tools", JUDGE_TOOLS_SRC],
    ["hierarchy", readFileSync(join(ROOT, "lib", "hierarchy.ts"), "utf8")],
    ["review-gate", SRC],
  ] as const) {
    assert.doesNotMatch(src, /lastWaitReportId|waitConsumedReportId/,
      `no second, wait-private report cursor may appear in ${label}`);
  }

});




test("STREAMING: every long-running gate tool publishes progress on its own onUpdate", () => {
  // Measured (.pi/gate-timings.jsonl): a review round is 8.9 min at the
  // median, a full precommit 92s. Each of these used to be a silent call.
  for (const tool of [
    "judge_wait", "judge_submit", "run_precommit", "declare_done",
    "copilot_review",
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
test("the verdict recorder actually runs the cwd check it demands", () => {
  const body = recordVerdictBody();
  assert.match(body, /parsed\.cwd/, "the claimed cwd is read from the adjudicated conclusion");
  assert.match(body, /canonicalPath\(claimed\) !== canonicalPath\(targetRoot\)/,
    "…and compared with the repo the round was prepared for, through realpath");
  assert.match(body, /cwdMismatch = "the verdict carries no `cwd`/,
    "a missing cwd is itself a failure (fail-closed), not a pass");
  assert.match(body, /if \(cwdMismatch\) parsed\.verdict = "BLOCKED";/,
    "a READY reporting the wrong directory is downgraded");
  assert.match(body, /CWD CHECK FAILED/, "and the agent is told why");
});

test("user ask 2026-08-28: the judge SESSION is the managed entity, the pane is the carrier", () => {
  // The dispatcher must RECORD the session-side paths at spawn time (the
  // transcript dir and the pane), plus WHO opened it.
  const spawnAt = SRC.indexOf("function dispatchJudgeRound(");
  const spawn = SRC.slice(spawnAt, spawnAt + 11000);
  for (const field of ["sessionDir", "paneId", "openerId"]) {
    assert.ok(spawn.includes(field), `a dispatched round must record ${field} at spawn time`);
  }

  // judge_wait: liveness and the round's end both come from what the gate
  // itself wrote — the channel state and tmux — read through deps bound to the
  // RECORDED record, never from a transcript scrape.
  const wait = toolBodyOf("judge_wait");
  const wiring = judgeToolsWiring();
  assert.match(JUDGE_TOOLS_SRC, /projection\.lastState\?\.state/, "liveness comes from the channel state");
  assert.match(wiring, /announcedQuestions: \(\) => announcedRequestIds/,
    "the announced-question cursor is the SESSION's, so a wait and a settle never double-announce");
  assert.match(JUDGE_TOOLS_SRC, /judgePaneAlive\(deps\.tmux/, "pane death is probed from tmux, not inferred");
  assert.match(wait, /probeJudgeWait\(deps, child, cursors\)/, "the wait polls the message-driven criteria");


  // Round-5 P1, pane edition: the child snapshot must SUPPLY lastActivityAt.
  // It comes from the channel now (heartbeat, questions, reports).
  const settledAt = SRC.indexOf("const childSnapshots: ChildSnapshot[] = []");
  assert.ok(settledAt > 0, "the snapshot construction must exist");
  const snapshots = SRC.slice(settledAt, settledAt + 2200);
  assert.match(snapshots, /lastActivityAt: channelLastActivity\(c\)/,
    "activity is read from the channel, not left undefined");
  const helperAt = SRC.indexOf("function channelLastActivity(");
  assert.ok(helperAt > 0, "the channel-activity helper must exist");
  // Same two RECORDED fields as before; the record is the registry entry now,
  // where the judge's id is `judgeId` (the Map called the same value sessionId).
  assert.match(SRC.slice(helperAt, helperAt + 600), /judgeChannelTarget\(judge\.openerId, judge\.judgeId\)/,
    "…from THAT judge's own channel file");

  // judge_close: kill the PANE, then drop the registry. Idempotent.
  const close = toolBodyOf("judge_close");
  assert.match(close, /closeSessionPane\(deps\.tmux, child\.paneId\)/, "the pane is killed, not a process");
  // …and NOTHING else: the window's label bar used to come down with the last
  // decorated pane, and that write resizes every pane in the window (measured:
  // SIGWINCH, rows 84 ↔ 83). The release is deleted (2026-09-17, user decision).
  assert.doesNotMatch(close, /releasesWindowLabels|hideLabelsVia|setw/,
    "no window option is touched by a close");
  assert.match(close, /closed: true/,
    "closing an already-finished child still reports success (idempotent)");
  assert.match(close, /transcript 保留/, "the records remain inspectable after close");
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
  const confirm = body.indexOf("askChoice(");
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
  // The DELIVERY STATION (2026-09-06) joins them, between the repo binding and
  // the audit line: the box is read top-down, and the two consent-critical
  // facts (which repo, how far this round goes) come before the label of what
  // is being approved.
  // …and it is the USER's rendering of the station that the dialog prints
  // (2026-09-17): the same sentence exists in a second person for the user and
  // a third person for the agent, and a dialog that printed the agent's copy
  // would tell the user that "the user" commits — about themselves.
  const stationLine = body.indexOf('repoLine + "\\n" + stationLineForUser + "\\n" + prereviewLine');
  assert.ok(repoFact > 0 && stationLine > 0, "repo, station and audit must all reach the dialog");
  assert.match(body, /const stationLineForUser = deliveryStationLine\(station, "user"\)/,
    "the dialog's station line must be the one addressed to the user");
});
// ---------------------------------------------------------------------------
// L8 — the loop goal is negotiated with the user, not written by the agent

test("propose_loop_goal: the USER approves in an extension dialog, and the EXTENSION writes the file", () => {
  // The tool moved to lib/goal-tools.ts (registration + `doProposeLoopGoal`);
  // the window is both, so an assertion can never be satisfied by a
  // neighbouring tool's code (round P2: the old flat window overshot into it).
  const body = toolBodyOf("propose_loop_goal");
  assert.match(body, /askChoice\(/,
    "the extension must render the approval dialog itself");
  assert.doesNotMatch(body, /confirmed\s*:\s*Type\./,
    "no agent-supplied 'confirmed' parameter — that would be self-approval");
  // The approval must describe text the USER saw: the extension writes the
  // file, and the sidecar records the hash of exactly that text. The syscall
  // itself is the injected seam (the extension wires it to writeFileSync).
  assert.match(body, /writeGoalFile\(goalPath/);
  assert.match(GOAL_WIRING(), /writeFileSync\(path, text, "utf8"\)/,
    "…and the wiring really writes the file the module was handed");
  assert.match(body, /(?:state|goalSt)\.loopGoal = \{\s*\n\s+hash: goalTextHash\(goalText\),/);
  // …and the record carries the station the user was shown in that same dialog
  // (2026-09-06), taken from the variable both surfaces printed — never
  // re-derived afterwards.
  assert.match(body, /const stationLine = deliveryStationLine\(station\)/);
  assert.match(body, /\n\s+station,\n/);
  // Length-bounded, through the check BOTH goal tools share: the cap lives in
  // one place now, so the audit can never accept a draft the approval refuses.
  assert.match(body, /checkGoalDraft\(\{\n\s+tool: "propose_loop_goal"/,
    "the submission goes through the shared check");
  assert.match(GOAL_PREREVIEW_SRC, /goalText\.length > LOOP_GOAL_MAX_WRITE_CHARS/,
    "the goal must be length-bounded");
});

test("propose_loop_goal: a rejection may carry a user REASON — typed into the same dialog", () => {
  // Since 2026-09-08 the reason is NOT a second input box: the template's
  // decline row ("✎ 我要改，我说明原因") opens a text box inside the SAME
  // dialog, and that text is the objection the agent renegotiates against.
  const body = toolBodyOf("propose_loop_goal");
  assert.match(body, /declineRow: REVISE_ROW/, "the approval dialog offers the revise row");
  assert.match(body, /parseChoice\(outcome\.answer, spec\)/, "the answer is read through the one parser");
  assert.match(body, /pick\.kind === "declined" && pick\.reason/, "the typed reason becomes the rejection reason");
  assert.match(body, /did NOT approve this goal\."/, "rejection path must exist");
  assert.match(body, /Reason: \$\{reason\}/, "rejection reason must reach the agent");
  assert.doesNotMatch(body, /dialogKind: "input"/, "no second box for the reason any more");
  assert.doesNotMatch(body, /User's note on approval/, "an approval carries no separate note");
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

test("completion arrives as a channel report consumed by the wait — no process watcher", () => {
  // A pane has no exit event to listen on, so the process-exit watcher
  // (lib/judge-watch.ts) is deleted with the pane migration — module and
  // test. What stays load-bearing: every dispatched round is consumable
  // through judge_wait, and nothing reintroduces a process listener.
  assert.doesNotMatch(SRC, /registerWatch\(|watchRegistry\.|createProcessWatchRegistry\(|waitForProcessExit\(|rememberChildProcess\(|forgetChildProcess\(/,
    "no process watcher may come back");
  assert.ok(!existsSync(join(ROOT, "lib", "judge-watch.ts")), "the watcher module stays deleted");
  const dispatchAt = SRC.indexOf("function dispatchJudgeRound(");
  assert.ok(dispatchAt > 0);
  assert.match(SRC.slice(dispatchAt, dispatchAt + 9000), /judgeChannelTarget\(opener, judgeId\)/,
    "reuse delivers the round into the channel the wait consumes");
  // The wait still ENDS on a channel report — it just no longer reads the
  // channel twice: the probe observes the report, the engine records it.
  assert.match(toolBodyOf("judge_wait"), /observation\.reason === "report" && observation\.reportId/,
    "the wait ends on the channel report");
  assert.match(windowIn(JUDGE_TOOLS_SRC, "export function probeJudgeRound(", "\n}", "probeJudgeRound"),
    /readChannel\(io, channelPathFor\(/, "…observed straight off the channel");
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
  for (const name of ["copilot_review"]) {
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
  // Anchored, not measured: this used to be `slice(start, start + 7000)`, and
  // every edit inside declare_done pushed the wiring further away until the
  // window silently stopped reaching it (a too-small window fails for a reason
  // that has nothing to do with the rule). `toolBodyOf` ends at the next
  // registration, so it cannot drift with the body's length.
  const doneBody = toolBodyOf("declare_done");
  assert.match(doneBody, /summary: Type\.String/, "window sanity: this really is declare_done's body");
  assert.doesNotMatch(doneBody, /name: "request_arbitration"/, "…and it stopped at the end of that body");
  assert.match(doneBody, /copilotProblemsFor\(/);
  const settledStart = SRC.indexOf(LOOP_SETTLED);
  assert.match(SRC.slice(settledStart, settledStart + 6400), /copilotProblemsFor\(/); // +1200 for the settle-wake and judge-pane blocks, +1200 for the stop-proof block at the handler's top
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
  // Anchored to the NEXT handler registration, not a character count: the old
  // `+ 11000` had to be re-tuned by every edit inside the settle path, and it
  // fails for a reason that has nothing to do with this rule (the same trap
  // the declare_done window fell into, 2026-09-05).
  const body = loopSettledWindow(/\n  pi\.on\(/, "agent_settled handler");
  assert.match(body, /unmetRequirements\(/, "window sanity: the settle body really is in this window");
  assert.doesNotMatch(body, /pi\.on\("session_start"/, "…and it stopped at the next handler");
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
    ['name: "declare_done"', "// L7/L8 — completion-only requirements"],
    ["async function recordReviewVerdict(", "// ---------- review tooling"],
    // END ANCHOR, not a byte window (2026-09-06): the station-block deny added
    // above the quota check pushed the fingerprint call past 4000 bytes, which
    // is precisely the vacuous-coverage failure this comment warns about. The
    // anchor closes on the call that SPENDS the appeal, so the window can only
    // grow with the handler.
    ['name: "request_arbitration"', "spendArbitration(ctx);"],

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
  // ANCHORED, NOT A FIXED SLICE (2026-09-06). A `restoreAt + 4000` window was
  // a reading heuristic pretending to be a contract: the assertion below sits
  // near the END of restore(), so any comment added earlier in the function
  // pushed it out of the window and the test failed for a reason that had
  // nothing to do with the rule. Both facts are anchored on themselves and
  // only their ORDER and their membership in restore() are asserted — which
  // is what the rule actually says.
  const nextFunctionAt = SRC.indexOf("\n  function ", restoreAt + 1);
  const end = nextFunctionAt > restoreAt ? nextFunctionAt : SRC.length;
  const body = SRC.slice(restoreAt, end);

  assert.match(body, /loadSidecar\(sidecarPath\(cwd\),\s*\w+\)/,
    "loadSidecar must be given an out-parameter to report the migration");
  assert.match(body, /fingerprintMigrated\s*=\s*migrateFingerprintVersion\(state\)\s*\|\|\s*\w+\.migrated/,
    "the sidecar's migration result must be OR'd into the reported flag");
});

test("a NEW session keeps the orchestration registry but never its approval (B1)", () => {
  // THE ASYMMETRY IS THE RULE. Everything else in a sidecar describes the
  // session's own round and is rightly reset for a new session id. The
  // orchestration runtime describes the WORLD — which orchestration this repo
  // runs and which child panes are registered under it — and resetting it
  // cost the same bug twice: a relay successor (a plain `pi`, so a fresh
  // session id) lost the predecessor's whole registry, and a takeover had
  // nothing left to take over, which is how `rm` became the only move.
  //
  // The APPROVAL survives ONLY for the predecessor's own handoff successor:
  // for anybody else it is permission the user gave to a session that is
  // gone, and re-obtaining it costs one dialog. The 2026-09-06 rule is
  // narrowed to the sessions it was about — WHICH those are is
  // `isHandoffSuccessorOf`'s one answer (the marker AND the sidecar's own
  // session id), so the approval cannot ride into a session a third session's
  // state happens to be sitting there for.
  const at = SRC.indexOf("restored.sessionId !== sessionId");
  assert.ok(at > 0, "the new-session reset branch must exist");
  const branch = SRC.slice(at, SRC.indexOf("} else if (sidecarCorrupt)", at));
  assert.ok(branch.length > 0 && branch.length < 4000, "the branch window must be the branch");

  assert.match(branch, /const relaySuccessor = isHandoffSuccessorOf\(process\.env, restored\.sessionId\)/,
    "the heir check overlays the marker on the sidecar's owner — one call, both facts");
  assert.match(branch, /state\.orchestrator = successorRuntime\(restored\.orchestrator, relaySuccessor\)/,
    "the orchestration runtime must be carried into the fresh state, minus the permission");
  assert.match(branch, /if \(relaySuccessor\) state = inheritGoalContract\(state, restored\)/,
    "a handoff successor also carries the user's contracts and the round budget");
  // WHICH fields grant power is the registry module's to know. Spelled out
  // here as a destructure, the list went stale the moment the approval grew a
  // field: `approvedPlanHistory` (round 9) would have ridden into a session
  // the user never approved and let it write the plan back to a content the
  // PREVIOUS session was authorized for. The field-by-field contract lives in
  // test/orchestrator-registry.test.ts, where it can be driven directly.
  assert.doesNotMatch(branch, /approvedPlanHash:\s*_/,
    "the strip list must not be re-inlined here — one place, or it goes stale again");
});


test("a relay successor inherits in EVERY repo, not just the primary one", () => {
  // P2 (round 1): `stateForRepo` builds a fresh state for a second repo whose
  // sidecar belongs to a different session id. For the predecessor's own
  // successor that sidecar is not foreign at all — refusing it would ask the
  // successor to negotiate a goal it already holds, in the repo it was told to
  // keep working in. One rule, one function: `stateOwnership` (whose three
  // answers are pinned in test/session-inheritance.test.ts), never a second
  // inlined comparison here.
  const at = SRC.indexOf("function stateForRepo(");
  assert.ok(at > 0, "stateForRepo must exist");
  const body = SRC.slice(at, SRC.indexOf("repoStateCache.set(root, s)", at));
  assert.ok(body.length > 0, "the window must cover the loader");
  assert.match(body, /if \(owner === "inherited" && existing\) s = inheritGoalContract\(s, existing\);/,
    "a secondary repo's sidecar is inherited by the predecessor's successor — same rule, same function");
  assert.match(body, /const owner = stateOwnership\(process\.env, state\.sessionId, existing\?\.sessionId\)/,
    "…and the answer comes from the shared rule, not from a second comparison");
});

test("the persisted repo set is re-armed BEFORE anything can persist — a relay successor keeps its repos", () => {
  // Quality round P1 (2026-09-16): `persist` DERIVES `state.sessionReposPaths`
  // from the in-memory `sessionRepos` set, so the re-arming loop has to run
  // before the session's first persist. It used to sit far below `setTaskMode`
  // (which persists) — and since every relay successor is handed its mode by
  // the spawner, every successor persisted first, the inherited list was
  // overwritten with the empty set, and the inheritance was dead code that
  // nothing could observe.
  const restoreAt = SRC.indexOf("restore(ctx, sessionId)");
  const reseedAt = SRC.indexOf("for (const r of state.sessionReposPaths ?? [])");
  assert.ok(restoreAt > 0 && reseedAt > 0, "both anchors must exist");
  assert.ok(reseedAt > restoreAt, "the loop re-arms what restore() produced");
  const firstModeCall = SRC.indexOf("setTaskMode(", restoreAt);
  assert.ok(firstModeCall === -1 || reseedAt < firstModeCall,
    "…and it runs before the first setTaskMode call, which persists the (still empty) set");
  assert.match(SRC.slice(reseedAt, reseedAt + 200), /sessionRepos\.add\(r\)/,
    "the loop re-adds each repo to the in-memory set persist reads");
});

test("repo-state ownership is ONE rule for the loader AND the enforcement reader", () => {
  // Quality round P1 (2026-09-16): `enforcementStateFor` returned whatever
  // `repoStateCache` held, and the cache is filled by `stateForRepo` for any
  // repo this session merely READ — so the same repo was "mine" or "not mine"
  // depending on who looked first, and `declare_done` waved a never-recorded
  // repo through on a warm cache while a cold one refused it.
  const enforceAt = SRC.indexOf("function enforcementStateFor(");
  assert.ok(enforceAt > 0, "the enforcement reader must exist");
  const enforce = SRC.slice(enforceAt, SRC.indexOf("/** Normalize a tool/git path", enforceAt));
  assert.ok(enforce.length > 0, "the window must cover the function");
  assert.match(enforce, /stateOwnership\(process\.env, state\.sessionId, onDisk\?\.sessionId\)/,
    "ownership comes from the DISK, through the shared rule");
  assert.doesNotMatch(enforce, /if \(cached\) return cached/,
    "the cache must not answer the ownership question — that is what made the answer order-dependent");
  assert.match(enforce, /return stateForRepo\(root\);/,
    "…and the state comes from the ONE loader, so an inherited repo gets the NARROWED state");
  assert.doesNotMatch(enforce, /\?\? onDisk/,
    "the raw sidecar must never be handed out — it still carries the predecessor's READY / PASS / bypass");

  const loaderAt = SRC.indexOf("function stateForRepo(");
  const loader = SRC.slice(loaderAt, SRC.indexOf("repoStateCache.set(root, s)", loaderAt));
  assert.match(loader, /stateOwnership\(process\.env, state\.sessionId, existing\?\.sessionId\)/,
    "the loader takes the same three answers");
  assert.doesNotMatch(loader, /sessionId === state\.sessionId/,
    "…and never re-derives them inline");
});

test("session_start surfaces the migration notice and clears the flag", () => {
  const at = SRC.indexOf('pi.on("session_start"');
  assert.ok(at >= 0, "session_start handler must exist");
  // The window is a reading heuristic, not a contract: the P-multi reset
  // block, no-UI mode forcing, the normal-mode no-arm comment and the
  // snapshot cleanup at the handler head keep pushing the notice section down.
  // The window is a reading heuristic, not a contract: the P-multi reset
  // block, no-UI mode forcing, the normal-mode no-arm comment, the
  // non-git short-circuit (2026-09-02) and the snapshot cleanup at the
  // handler head keep pushing the notice section down. Anchor on the
  // NOTICE itself instead of a fixed slice so a growing handler head
  // cannot push the assertion out of the window.
  const noticeAt = SRC.indexOf("if (fingerprintMigrated) {", at);
  assert.ok(noticeAt > at && noticeAt < at + 20000, "the migration notice must live inside session_start");
  const body = SRC.slice(noticeAt, noticeAt + 600);
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

  const supportAt = COPILOT_TOOLS_SRC.indexOf(
    "deps.gh.resolveCopilotSupport(dir, slug, st.copilot?.supportConfirmed === true, { signal })");
  const recordAt = COPILOT_TOOLS_SRC.indexOf("recordCopilotRequest(st.copilot, {");
  assert.ok(supportAt > 0, "availability must be resolved before the request");
  const requestCallAt = COPILOT_TOOLS_SRC.indexOf("return await doRequestPhase({");
  assert.ok(requestCallAt > 0, "the tool must call the request phase");
  assert.ok(requestCallAt > supportAt, "availability must be resolved BEFORE a round is spent");

  // The request itself is never vetoed by a read-back: whatever the
  // availability verdict, the round is recorded and the wait length is what
  // changes. What a MISSING queue flag buys is one more attempt (2026-09-14:
  // the user's decision) — and only after that does the gate release.
  const phaseAt = COPILOT_TOOLS_SRC.indexOf("async function doRequestPhase(");
  const phaseEnd = COPILOT_TOOLS_SRC.indexOf("\nasync function doCopilotReview(", phaseAt);
  assert.ok(phaseAt > 0 && phaseEnd > phaseAt, "the request phase must be its own function");
  const phase = COPILOT_TOOLS_SRC.slice(phaseAt, phaseEnd);
  const firstRequest = phase.indexOf("const requested = await deps.gh.requestCopilotReviewer(");
  const retryRequest = phase.indexOf("const again = await deps.gh.requestCopilotReviewer(");
  const notLandedRelease = phase.indexOf('verdict.state === "not-landed"');
  assert.ok(firstRequest > 0, "the request path must exist");
  assert.ok(retryRequest > firstRequest, "a request GitHub never queued is re-sent once");
  assert.ok(notLandedRelease > retryRequest, "and released only after that retry also fails");
  assert.match(COPILOT_TOOLS_SRC.slice(recordAt, recordAt + 400), /supportConfirmed: support\.confirmed/,
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
  const checkBody = toolBodyOf("copilot_review");
  assert.match(checkBody, /copilotUnhandledText\(analysis\.actionable\)/,
    "the released branch of copilot_review must list them");

  // The paths that ACTUALLY release with findings open are the fail-safe ones:
  // no PR, no slug, unreadable payload, a refused request, a spent retry, an
  // expired budget. Each of them released in total silence before, even with a
  // sidecar that still recorded open threads. They now all funnel through
  // `releaseReply`, which is the ONE place the abandoned-findings notice is
  // attached — so a new release path cannot be added without it, which is what
  // the old per-call count was approximating.
  const toolsBody = COPILOT_TOOLS_SRC;
  const funnelAt = toolsBody.indexOf("function releaseReply(");
  assert.ok(funnelAt > 0, "the release funnel must exist");
  assert.ok(toolsBody.indexOf("const abandoned = copilotAbandonedText(args.st.copilot)", funnelAt) > funnelAt,
    "the funnel attaches the unhandled-findings duty");
  assert.equal((toolsBody.match(/releaseCopilotReview\(/g) ?? []).length, 1,
    "exactly one place releases the requirement — the funnel");
  assert.ok(toolsBody.indexOf("releaseCopilotReview(", funnelAt) > funnelAt,
    "and the funnel is that place");
  assert.ok(toolsBody.split("return releaseReply({").length - 1 >= 4,
    "the fail-safe release paths must still exist (no PR, no slug, unreadable payload, a refused " +
    "request, a spent retry, an expired budget)");

  // …and each of them must leave an audit trail: this whole diagnosis had to
  // be reconstructed from GitHub's API because the sidecar transitions were
  // never logged.
  assert.ok((toolsBody.match(/log\(`copilot /g) ?? []).length >= 2,
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

test("the Copilot wait blocks inside copilot_review and reads as a gate-owned wait (2026-09-23)", () => {
  // The background watcher that woke an idle session is GONE: it was why the
  // tool told the agent to end its turn, and an orchestration child that did
  // so read as `idle` — its manager was woken every minute for the whole wait.
  assert.doesNotMatch(SRC, /copilotTick|deliverCopilotWake|copilotWoken|syncCopilotWatch|watchedAwait/,
    "no background Copilot watcher may come back");
  // Every caller reads the one unfiltered list: a wait is never hidden from a nudge.
  assert.doesNotMatch(SRC, /copilotProblemsFor\(st, \{/, "no nudge-only filter");
  // The blocking call is reported on the child heartbeat as a gate-owned wait,
  // so a supervising manager is not woken by it.
  assert.match(SRC, /if \(copilotWaitSince !== undefined\) return \{ role: "copilot", since: copilotWaitSince \}/);
  assert.match(SRC, /onWaiting: \(active\) => \{\n\s+copilotWaitSince = active \? Date\.now\(\) : undefined;/);
});

test("copilot_review leaves a released cycle alone (no resurrection, no gh calls)", () => {
  // The loop this closes: request released the cycle as EXHAUSTED, the next
  // check re-derived it as ARMED, and declare_done was blocked again.
  // The window is the tool's own registration plus its handler, read from the
  // module that owns them (lib/copilot-review-tools.ts) — no character count.
  const body = toolBodyOf("copilot_review");
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
  const at = SRC.indexOf("st.lastReviewedTree = {");
  assert.ok(at > 0, "the verdict recorder must set the baseline");
  const before = SRC.slice(at - 900, at);
  assert.match(before, /st\.scopeLimit\s*\n?\s*\?\s*st\.scopeLimit\.sessionFiles/,
    "a scope-limited review must record sessionFiles, not the whole branch diff");
});

test("the incremental DEPTH baseline moves on any concluded round; the RANGE baseline does not", () => {
  // TWO QUESTIONS, TWO RULES, and confusing them is what this pins.
  //
  // DEPTH (2026-09-19): `lastReviewedTree` answers "what has this session
  // READ?" and is written for EVERY recorded verdict — requiring a READY here
  // is what made a session whose first round concluded BLOCKED re-review the
  // whole branch, three times over one diff in prime. The write must therefore
  // NOT sit inside a READY guard any more.
  const depthAt = SRC.indexOf("st.lastReviewedTree = {");
  const depthGuard = SRC.lastIndexOf('parsed.verdict === "READY"', depthAt);
  assert.ok(
    depthGuard === -1 || depthAt - depthGuard > 900,
    "a BLOCKED round read those files too — the depth baseline must not be READY-gated",
  );
  assert.match(
    SRC.slice(depthAt, depthAt + 400),
    /verdict: parsed\.verdict/,
    "…and it records WHICH verdict, so the settled-conclusion rule can still demand a READY",
  );

  // RANGE: `st.review.commitSha` is the range baseline, and it still advances
  // only when the QUALITY half concluded. A round whose quality judge was
  // cancelled has content that never entered a quality round; letting the range
  // step past it would ship it on a later READY (2026-09-17 quality P1).
  const rangeAt = SRC.indexOf("const concludedCommit = (qualityHalfConcluded");
  assert.ok(rangeAt > 0, "the range baseline must be derived from the quality standing");
  // `qualityStandingFor` answers the question ABOVE the write, and the carried
  // value IS the write — so the window spans both.
  assert.match(
    SRC.slice(Math.max(0, rangeAt - 500), rangeAt + 320),
    /qualityStandingFor\(/,
    "…which is what qualityStandingFor answers",
  );
  assert.match(SRC.slice(rangeAt, rangeAt + 320), /\?\? st\.review\.commitSha/, "…and otherwise the previous value is carried forward");
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
  // it in the map the verdict recorder reads.
  // The registration also carries the round's DISPATCHED scope (t6a): the
  // gate's half of the audit pair, captured at dispatch time rather than
  // recomputed when the verdict lands (by then the worktree has moved).
  assert.match(
    REVIEW_PREPARE_SRC,
    /deps\.registerReviewTarget\(root, \{ baseline, head, tree, scope: \{ range, kind: scopeNow\.scope \}, files \}, ctx\)/,
    "the ctx travels with it (2026-09-15): registering a target also RETIRES the previous round's parked READY, and that is a write to the sidecar",
  );
  // The changed FILES ride the same registration: the quality precondition is
  // decided at dispatch time and must not re-run `git diff` to learn what this
  // round touched.
  assert.match(
    REVIEW_PREPARE_SRC,
    /files\?: readonly string\[\];/,
    "the review target carries the changed files",
  );
  assert.match(
    REVIEW_PREPARE_WIRING(),
    /registerReviewTarget: \(root, target, ctx\) => \{\s*reviewTargets\.set\(root, target\);\s*\/\/[^\n]*\n(?:[^\n]*\n)*?\s*const st = stateForRepo\(root\);/,
    "and the wiring clears the parked conclusion it did not dispatch",
  );
  // And the map must be consulted inside the recorder, not just written.
  assert.match(recordVerdictBody(), /reviewTargets\.get\(targetRoot\)/);
});

test("P2: the recorder withholds a READY when the round was never prepared", () => {
  // No registered target ⇒ the round was never prepared ⇒ a READY has nothing
  // to bind to ⇒ withheld (BLOCKED). The mechanical guard, not honour-based.
  const segment = recordVerdictBody();
  assert.match(segment, /if \(!target_\)/);
  assert.match(segment, /nothing to bind/);
});

test("P2: the recorder downgrades a READY to BLOCKED when HEAD moved past the prepared commit (STALE)", () => {
  // A new checkpoint after prepare_review means the reviewer judged an older
  // commit and the change under review has since grown — READY must not bind.
  const segment = recordVerdictBody();
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
  // 2026-09-05: both paths are now ONE call — `runAuditRound` — so the close
  // is no longer "one per return branch" (which is how a branch leaks a pane)
  // but a single `finally` in the engine, and the extension holds exactly one
  // judge_close wiring for it.
  // 2026-09-06 (t9d): that `finally` is also where the pane-lifecycle policy is
  // applied, so the close is gated by `JUDGE_PANE_RECLAIM` rather than written
  // as an unconditional statement — and the reclaim's outcome is
  // no longer discarded. What must not change is the property this test has
  // always been about: it runs on every path out of the round.
  const engineRun = windowIn(AUDIT_ROUND_SRC, "export async function runAuditRound(", "\n}", "runAuditRound");
  const finallyBlock = engineRun.slice(engineRun.indexOf("} finally {"));
  assert.ok(finallyBlock.startsWith("} finally {"), "the round still ends in a finally");
  // 2026-09-21: the policy is a CONSTANT now — every judge pane is freed at
  // round end, so there is no dispatcher to look up (`lib/judge-pane-policy.ts`
  // explains what replaced the 2026-09-06 two-policy split).
  assert.match(finallyBlock, /const policy = JUDGE_PANE_RECLAIM;/,
    "the policy is consulted here — this call site does not decide for itself");
  assert.match(finallyBlock, /if \(policy\.atRoundEnd\)/,
    "…and what it says is what runs");
  assert.match(finallyBlock, /await deps\.closeJudge\(root, spec\.role\)/,
    "the close runs on EVERY path out of the round, fail-closed ones included");
  assert.match(finallyBlock, /reclaimAuditLine\(/,
    "…and a reclaim that did not do what the policy promises is written down, not dropped");
  // No return branch may take the reclaim into its own hands again: one pane,
  // one owner, one place it is released.
  assert.equal(engineRun.slice(0, engineRun.indexOf("} finally {")).includes("closeJudge"), false,
    "nothing before the finally closes the judge");


  const goalAt = SRC.indexOf("async function runGoalAudit(");
  const goal = SRC.slice(goalAt, SRC.indexOf("async function runPlanAudit("));
  assert.ok(goalAt > 0 && goal.length > 0, "the goal-audit function exists");
  assert.match(goal, /runAuditRound\(auditRunDeps\(ctx, input\.progress, input\.signal\), \{/,
    "the goal audit runs the engine");
  assert.match(goal, /spec: GOAL_AUDIT_SPEC/, "…with its own spec");

  const planAt = SRC.indexOf("async function auditPlanRound(");
  const plan = SRC.slice(planAt, planAt + 3500);
  assert.ok(planAt > 0, "the plan-audit function exists");
  assert.match(plan, /runAuditRound\(auditRunDeps\(latestCtx, onUpdate, signal\), \{/,
    "the plan audit runs the SAME engine");
  assert.match(plan, /spec: PLAN_AUDIT_SPEC/, "…differing only in its spec");

  // Exactly ONE gate-internal close wiring exists — a second one would be a
  // second, unaccounted-for path out of a round.
  const internalCloses = [...SRC.matchAll(/callTool\("judge_close"/g)];
  assert.equal(internalCloses.length, 1, "one close wiring, injected into the engine");

  // ENGINE MERGED, WORDING NOT. The four specs live in their own module, so a
  // fifth kind is a new entry there and nothing else — and the engine cannot
  // quietly grow a per-kind sentence of its own.
  assert.doesNotMatch(AUDIT_ROUND_SRC, /export const \w+_SPEC: AuditRoundSpec = \{/,
    "the wording belongs to lib/audit-round-specs.ts — the engine only imports it");
  const specs = readFileSync(join(ROOT, "lib", "audit-round-specs.ts"), "utf8");
  for (const name of ["GOAL_AUDIT_SPEC", "PLAN_AUDIT_SPEC", "REVIEW_ROUND_SPEC", "ADVICE_ROUND_SPEC"]) {
    assert.match(specs, new RegExp(`export const ${name}: AuditRoundSpec = \\{`), `${name} lives there`);
  }
});

test("BOTH audit paths check the WAIT RESULT before adjudicating (stale-verdict P0)", () => {
  // The measured deadlock: an audit waited, then read the channel's newest
  // report unconditionally. A re-dispatch wiped the wait cursor, so that report
  // was the PREVIOUS round's — every resubmit after a BLOCKED verdict
  // re-adjudicated the old findings and the plan/goal could never pass again.
  // Behaviour of the selection rule is unit-tested on the pure function
  // (test/audit-round.test.ts); THIS pins that the extension has no second
  // place where a round is closed.
  //
  // 2026-09-05: "both paths" is now ONE path. Keeping the wait result and
  // refusing to adjudicate without THIS round's report is written once, in the
  // engine, so a future kind cannot get its own subtly different version.
  const engineRun = windowIn(AUDIT_ROUND_SRC, "export async function runAuditRound(", "\n}", "runAuditRound");
  assert.match(engineRun, /const waited = await deps\.awaitRoundEnd\(root\);/,
    "the round KEEPS its wait result, it does not discard it");
  assert.match(engineRun, /if \(!waited\.ok\) return \{ ok: false, text: spec\.unfinished\(waited\.detail\) \};/,
    "…and proceeds only when the wait ended on this round's report");
  // The round is settled by whoever got there first — the wait inside
  // `awaitRoundEnd` closes it through this same engine — so "already recorded"
  // is the NORMAL path and only a genuinely stale round fails closed. Getting
  // this backwards fail-closes every audit while looking correct (adviser,
  // 2026-09-05); the behaviour itself is pinned in test/audit-round.test.ts.
  //
  // And it must NOT be detected by settling a second time: a successful record
  // consumes the pending entry that picks the kind, so the second settle comes
  // back `unknown` (reviewer P0, same day). The detector starts from the
  // pending entry a record consumes…
  assert.match(engineRun, /if \(!roundClosedDuringWait\(deps, \{ judgeId, root, cursorBefore, pending: input\.pending \}\)\)/,
    "a round the wait already recorded is not settled (or judged stale) a second time");
  const detector = windowIn(AUDIT_ROUND_SRC, "function roundClosedDuringWait(", "\n}", "roundClosedDuringWait");
  assert.match(detector, /if \(deps\.pendingAudit\(input\.root\) !== undefined\) return false;/,
    "an armed pending entry means no record landed");
  // …and then asks the RECORD, which the round-end reclaim cannot erase
  // (2026-09-21): freeing the pane drops the registry row, so the cursor half
  // alone answered "nothing was recorded" for exactly the round it was written
  // to detect — three PASSed plan audits came back fail-closed in a row.
  assert.match(detector, /if \(deps\.recordedThisRound\(input\.root, input\.pending\)\) return true;/,
    "a record bound to this round's content closes it, registry row or not");
  assert.match(detector, /cursorNow !== undefined && cursorNow !== input\.cursorBefore/,
    "…and a cursor that never moved is not a record either — the pending entry must be gone for both");
  // The EXTENSION supplies that evidence, and both halves of it are load-
  // bearing. Content alone would let the PREVIOUS round's record for an
  // identical draft (resubmitting one is the common case) close a round that
  // has not reported yet; the timestamp alone would let any record of any
  // draft do it. And it must stay blind to the verdict: a recorded FAIL closes
  // the round too, and reading it as "not recorded" is what swallowed the
  // auditor's findings whole.
  const evidence = windowIn(SRC, "      recordedThisRound: (root, pending) => {", "\n      },", "recordedThisRound");
  assert.match(evidence, /st\.goalPrereview\?\.hash === goalTextHash\(pending\.draft\)/,
    "a goal's record is bound to the draft this round dispatched");
  assert.match(evidence, /st\.planAudit\?\.hash === pending\.hash/,
    "…and a plan's to its hash");
  assert.match(evidence, /record !== undefined && record\.at >= pending\.startedAt/,
    "…and an EARLIER round's record for identical content closes nothing");
  assert.doesNotMatch(evidence, /verdict/,
    "a recorded FAIL closes the round as much as a PASS — this may not read the verdict");
  assert.match(engineRun, /if \(settled\.status !== "recorded"\)/,
    "…and anything the engine itself did not record fails closed");
  // The done/reason judgement itself is wired ONCE, in the run deps.
  const doneChecks = [...SRC.matchAll(/details\.reason === "report"/g)];
  assert.equal(doneChecks.length, 1, "one place decides that a wait ended on a report");
  // …and the waiter they share must keep calling until the round really ends.
  // `judge_wait` is message-driven for the agent (2026-09-05), so a single call
  // can return on a streamed finding — which every auditor emits before it
  // concludes. Adjudicating that as "no report" closed the auditor mid-round
  // and made any draft with findings fail closed forever (P0).
  // 2026-09-08: the gate's own chains wait through `selfAuditWait`, which keeps
  // the shared `awaitRoundReport` decision but addresses the auditor by judgeId
  // via `doWait` (the tool path would refuse an unedited repo — measured five
  // consecutive "等待未命中本轮 report"). The agent-facing `judge_wait` tool
  // keeps the full repo check.
  const waiter = SRC.slice(SRC.indexOf("async function selfAuditWait("), SRC.indexOf("/** The text a tool result carries"));
  assert.match(waiter, /awaitRoundReport\(\{/, "the chains wait through the shared decision, not a hand-rolled loop");
  assert.match(waiter, /doWait\(/, "…through the shared wait implementation, addressed by judgeId");
  // 2026-09-08 second round (reviewer P1): the marker is a FUNCTION ARGUMENT on
  // doWait/doClose, never a params field — params arrive from the agent verbatim
  // (unknown keys stripped nowhere), so a marker in params would be agent-settable.
  assert.match(waiter, /,\n?\s*true, \/\/ gateSelf/, "…with the gate-self function argument (agents cannot set it)");
  assert.doesNotMatch(waiter, /gateSelf: true/, "…and never as a params field");
  assert.doesNotMatch(waiter, /callTool\(\s*\n?\s*"judge_wait"/, "the gate chain must not re-enter the repo-checked tool path");
  assert.doesNotMatch(waiter, /for \(;;\)|while \(/, "no second waiting loop may come back here");
  // The decision itself (what ends a round, and the ONE shared budget) is
  // pinned in test/judge-lifecycle.test.ts, where it can be driven directly.


  // AND THE SELECTOR HAS ONE IMPLEMENTATION, WITH NAMED CALLERS. Two entry
  // points (`staleAuditGuard` plus an inline call in the plan audit) is exactly
  // how the goal path and the plan path ended up fail-closing on different
  // conditions, so this scans every module rather than the extension alone.
  //
  // The PROBE was added to the caller list on 2026-09-05, deliberately: it used
  // to answer "did this round end?" with its own comparison, which is how a
  // wait could announce a verdict the recorder then refused. Sharing the ONE
  // selector is the fix — a second selector is still forbidden everywhere.
  assert.doesNotMatch(SRC, /staleAuditGuard/,
    "the second stale-report entry point may not come back");
  const SELECTOR_SITES = new Set([
    join("lib", "audit-round.ts"),          // where it lives
    join("lib", "judge-session-tools.ts"),  // the probe, which must agree with it
  ]);
  for (const rel of [
    ...readdirSync(join(ROOT, "lib")).filter((f) => f.endsWith(".ts")).map((f) => join("lib", f)),
    join("extensions", "review-gate.ts"),
  ]) {
    if (SELECTOR_SITES.has(rel)) continue;
    assert.doesNotMatch(readFileSync(join(ROOT, rel), "utf8"), /selectRoundReport\(|selectCurrentAuditReport\(/,
      `${rel} must not decide which report closes a round — the engine does`);
  }
  // The probe CALLS it and does not re-derive it: no second "newest report vs
  // the cursor" comparison may live in the waiting module.
  assert.doesNotMatch(JUDGE_TOOLS_SRC, /projection\.lastReport/,
    "lib/judge-session-tools.ts may not pick a round's report on its own");
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
  // The goal-auditor's task comes from the ONE assembler (three verbatim
  // copies of it were the whole point of the 2026-09-05 convergence).
  assert.match(body, /buildGoalAuditRound\(task, root, ctx\)/);
  assert.match(body, /callTool\("prepare_adviser", \{ repo: root \}/);
  const assembler = windowOf("async function buildGoalAuditRound(", "\n  /**", "buildGoalAuditRound");
  assert.match(assembler, /callTool\("prepare_goal_audit", \{ goal: draft, repo: root \}/);
  assert.match(assembler, /extractTaskText\(toolText\(prepared\)\)/);
  // Criterion 2: a goal audit streams findings, so the draft can be fixed
  // while the auditor is still working.
  assert.match(assembler, /buildStreamDirective\(streamPath\)/);
  assert.match(assembler, /review-stream", `goal-\$\{goalTextHash\(draft\)/);
  const assemblers = [...SRC.matchAll(/callTool\("prepare_goal_audit"/g)];
  assert.equal(assemblers.length, 1, "ONE assembler — the three verbatim copies are gone");
  // The audited DRAFT is remembered: the verdict binds to its content, and
  // the auditor's output alone cannot say what it judged.
  assert.match(body, /pendingAudits\.set\(root, \{ kind: "goal", draft: task, startedAt:/);
  // Criterion 1: the stream path comes BACK to the agent — a channel written
  // but never read is not a channel.
  assert.match(body, /streamPath,/, "the reply carries the stream path");
  assert.match(body, /findings 流（边审边修）/, "and names it in the text too");
  // The audited draft is remembered only after the dispatch is ACCEPTED: a
  // refused submission must not overwrite what a running audit is judging.
  const acceptedAt = body.indexOf("if (!d.ok)");
  const setAt = body.indexOf("pendingAudits.set(root");
  assert.ok(acceptedAt > 0 && setAt > acceptedAt, "the draft is recorded after the dispatch is accepted");
  // …and the recording side closes the loop with that same draft, through the
  // engine's goal recorder — the pending entry IS what it records against.
  const goalRecorder = windowOf("      recordGoal: async ({ root, pending, concluded }) => {", "\n      }", "recordGoal dep");
  assert.match(goalRecorder, /recordGoalPrereview\(goalPrereviewDeps, \{/, "recording routes through the ONE audit recorder");
  assert.match(goalRecorder, /goal: pending\.draft/, "the recorded draft is the pending one");
  assert.match(goalRecorder, /auditStartedAt: pending\.startedAt/);
  const settleFn = windowIn(AUDIT_ROUND_SRC, "export async function settleAuditRound(", "\n}", "settleAuditRound");
  assert.match(settleFn, /deps\.forgetPending\(input\.root\)/,
    "a recorded audit does not linger (and the extension's dep persists the drop)");
});


test("settlement reads the branch the checkout is on, and REMEMBERS it for the next call (reviewer P2, 2026-09-18)", () => {
  const body = windowOf("settleWorktree: ({ childId, taskId, repoRoot, settlement }) => {", "\n    knownRepoRoots:", "settleWorktree");
  // Three sources, in order: what the REPOSITORY lists for that checkout, what
  // this session recorded when it last read one, and the name the gate derived.
  // The first is the repository's own registry (asking the DIRECTORY would let
  // git climb to an enclosing repo and hand a destructive `branch -D` the wrong
  // name); the second is what makes the SECOND call work at all — a merge
  // reclaims the directory, so the `discard` its receipt asks for has nothing
  // left to list, and the derived name would delete a branch a renamed child no
  // longer has.
  assert.match(body, /listedWorktreeBranch\(repoRoot, worktreePath\) \?\? registered \?\? childWorktreeBranch\(childId\)/,
    "the repository's own listing wins; the recorded name covers a reclaimed one; the derived name is the last resort");
  assert.doesNotMatch(body, /currentBranch\(worktreePath\)/,
    "…and the directory is never asked: git would walk up to an enclosing repository");
  assert.match(SRC, /branchOfListedWorktree\(out, resolved\)/,
    "the path is matched in BOTH spellings — git records a worktree symlink-resolved (`/tmp` reads back as `/private/tmp`)");
  assert.match(body, /noteWorktreeBranch\(runtime, childId, branch\)/,
    "…and what was read is remembered, so the next settlement deletes the branch that exists");
});

test("a parallel round's receipt carries BOTH findings streams (B1, 2026-09-18)", () => {
  const body = windowOf('name: "judge_submit"', "\n  // `review_spawn`", "judge_submit body");
  // The text used to name only the ROUTED judge's stream, so a parallel round's
  // functional findings — the ones the agent fixes WHILE both judges work — had
  // no path on the reply, nor in `details`.
  assert.match(body, /streamPath: judge\.streamPath/,
    "every accepted judge keeps its own stream");
  assert.match(body, /\[`- \$\{a\.role\} 的 findings 流（边审边修）: \$\{a\.streamPath\}`\]/,
    "and the receipt prints one line per judge, matched by role");
});

test("judge_submit runs the whole submission chain, and cannot dead-end on it", () => {
  const body = windowOf("async function submitForReview(", "\n  /**", "submitForReview");
  // Each step is the TOOL's own execute — one implementation, one set of
  // mechanical checks. Since B1 (2026-09-10) the precommit runs BESIDE the
  // chain instead of in front of it, so it is started through
  // `startPrecommitBeside` (which calls the same tool, unawaited) — the
  // serial `await callTool("run_precommit"...)` is what 33s of agent-blocking
  // looked like, and the assertion for its absence lives in the B1 block
  // below.
  assert.match(body, /startPrecommitBeside\(input\.root, input\.ctx\)/);
  // …and each step reports itself, so a stalled round shows WHERE it stalled.
  for (const step of [/step\("precommit \(full/, /step\("checkpoint 提交"\)/, /step\("prepare/]) {
    assert.match(body, step, "every chain step publishes progress");
  }
  // 2026-09-08: the round NOTE travels to the checkpoint alongside the message —
  // the dependency-justification gate reads the justification from the agent\'s own
  // words (L5 may have dropped them from the English-only message).
  assert.match(body, /callTool\("review_checkpoint", \{ message, note: input\.note, repo: input\.root \}/);
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

test("a judge's verdict is recorded from THIS round's report, never an older one", () => {
  const body = windowOf("async function recordJudgeConclusion(", "\n  /**", "recordJudgeConclusion");
  // The channel accumulates every round, so its newest report can belong to
  // a PREVIOUS one — recording that would bind a verdict to work nobody
  // judged. Since 2026-09-05 that decision is the ENGINE's, in one place, and
  // this settle path only relays what it decided.
  assert.match(body, /settleAuditRound\(auditRoundDeps\(ctx\), \{ judgeId: sessionId, root: childRoot \}\)/,
    "the settle path closes the round through the engine");
  assert.doesNotMatch(body, /projectChannel\(read\.records\)\.lastReport/,
    "…so it must not read the channel itself anymore");
  const settleFn = windowIn(AUDIT_ROUND_SRC, "export async function settleAuditRound(", "\n}", "settleAuditRound");
  assert.match(settleFn, /consumedReportId: entry\.lastReportId/, "an already-consumed report is not recorded twice");
  assert.match(settleFn, /deps\.proseOf\(report\)/, "an ADVISER's prose is read from its report");
  assert.match(settleFn, /deps\.recordReview\(\{ root: input\.root, concluded \}\)/,
    "a review verdict goes to the review recorder, on the STRUCTURED conclusion");
  // The record writers stay where they were — the engine calls them, and the
  // review one still names its repo explicitly.
  const reviewRecorder = windowOf("      recordReview: async ({ root, concluded }) => {", "\n      }", "recordReview dep");
  assert.match(reviewRecorder, /recordReviewVerdict\(concluded, root, recordCtx\)/,
    "the record names its repo explicitly");
  // Advice is not a verdict: an adviser's report is surfaced, never recorded —
  // but its cursor still advances so the next settle does not re-announce it.
  assert.match(settleFn, /spec\.kind === "advice"/, "advice is surfaced, not recorded");
});


test("a judge's PROSE never reaches the opener's context, except from the adviser", () => {
  // The report record itself carries no prose for a reviewer / goal-auditor
  // (lib/judge-conclude.ts, pinned in test/judge-conclude.test.ts). This is the
  // OTHER half: even if one somehow did, the opener would not quote it — the
  // excerpt is passed for exactly one role, and the wake-up is otherwise built
  // from structured fields plus the gate's own recorded note.
  const body = windowOf("async function settleFinishedRounds(", "\n  /**", "settleFinishedRounds");
  assert.match(body, /conclusionExcerpt: entry\.role === "adviser" \? conclusion\.text : undefined/,
    "only an adviser's conclusion is quoted back");
  assert.match(body, /verdict: obs\.verdict/, "the verdict travels structured");
  assert.match(body, /findingsCount: obs\.findingsCount/, "so does the count");
  // And the recorded note is the GATE's sentence, not the judge's: it comes
  // from the recorder's return value, never from the report's text.
  assert.match(body, /recordedNote: conclusion\.recorded \? conclusion\.text : undefined/);
  // The report's own TEXT is read on exactly one branch of the engine — the
  // advice one — and the extension never reads it while recording at all.
  const settleFn = windowIn(AUDIT_ROUND_SRC, "export async function settleAuditRound(", "\n}", "settleAuditRound");
  assert.match(settleFn, /if \(spec\.kind === "advice"\) \{[\s\S]*?deps\.proseOf\(report\)/,
    "the report's own text is read ONLY on the advice branch");
  const proseReads = [...settleFn.matchAll(/deps\.proseOf\(/g)];
  assert.equal(proseReads.length, 1, "…and exactly once");
});


test("every advanced entry says it is one, and none teaches the retired manual flow", () => {
  // The tool list is the surface an agent reads EVERY turn: a description
  // still saying "call this before spawning the reviewer" is enough to send
  // it back to the four-step dance judge_submit replaced.
  const advanced = [
    "run_precommit", "review_checkpoint", "prepare_review",
    "prepare_goal_audit", "prepare_adviser",
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
  // The session tools take the orchestration deps as they are: the extra
  // capability they used to be handed (how many judge panes this window has,
  // for the shared label-bar release) is gone with the release itself.
  assert.match(SRC, /registerOrchestratorSessionTools\(pi, sessionDeps\)/);
  assert.match(SRC, /const sessionDeps: OrchestratorSessionDeps = orchestratorDeps/,
    "the live deps object is passed on — a spread copy would freeze every other field");
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
  // THE SUCCESSOR BRIEF MOVED OUT OF THIS BRANCH (2026-09-14, measured): it
  // belongs to EVERY kind of session — a loop session's successor is the
  // ordinary case — and it is injected at the top of `before_agent_start` so
  // no mode branch or early return can drop it.
  assert.doesNotMatch(block, /formatInheritanceBrief/, "the brief is no longer orchestrator-only");
  const beforeStartAt = SRC.indexOf('pi.on("before_agent_start"');
  const briefAt = SRC.indexOf('formatInheritanceBrief(readInheritance(), orchestrationIdFromEnv())', beforeStartAt);
  const orchAt = SRC.indexOf('if (state.taskMode === "orchestrator") {', beforeStartAt);
  assert.ok(briefAt > 0 && briefAt < orchAt,
    "every successor is briefed before any mode branch, and the brief really is rendered there");
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
  // THE DELIVERY STATION IS DELIBERATELY ABSENT HERE (user decision,
  // 2026-09-06) — and it looks exactly like a gap, which is why both halves
  // are pinned: the check must not appear, and the REASON must stay next to
  // the place someone would add it. A project manager has no repos of its own
  // and cannot read the child sidecar that holds the PR evidence, so a
  // `deliveryStation: "pr"` orchestration would be held at declare_done by a
  // condition it can never satisfy while being told to "go open a PR" — the
  // same "follow the gate and make it worse" failure the round-4 heartbeat
  // produced. The plan's station is enforced by each CHILD's ship gate.
  assert.doesNotMatch(helper, /stationArrivalProblems|deliveryStationFor/,
    "an orchestrator's exit contract is the PLAN, never a station it cannot verify");
  const rationale = windowOf(
    "Constraints 3, 4 and 11 — the orchestration's own exit contract",
    "function orchestrationDoneProblems()",
    "orchestrationDoneProblems rationale",
  );
  assert.match(rationale, /WHY THERE IS NO DELIVERY-STATION CHECK HERE/,
    "the next reader must find the reason before they 'complete' the check");
  assert.match(rationale, /CHILD's ship gate/,
    "…including who DOES enforce the plan's station");
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
  const settled = loopSettledWindow("// L7/L8 — completion-only requirements");
  assert.match(settled, /if \(state\.taskMode === "orchestrator"\) \{\s*\n\s*orchestratorSettled\(ctx\);\s*\n\s*return;/,
    "it branches BEFORE the loop's own unmet-requirement computation");
  const own = windowOf("function orchestratorSettled(", "\n  }", "orchestratorSettled");
  assert.match(own, /buildOrchestratorResume\(/, "and it has a continuation of its own");
  assert.match(own, /sessionExitProblems\(\)/, "built from the UNIFIED exit criterion");
  assert.match(own, /startSupervisionTimer\(\)/, "which also arms the background supervisor");
  assert.doesNotMatch(own, /unmetRequirements|LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK/,
    "and never from the loop's gates");
});

test("round-7 P1: a judge pane never receives the LOOP's continuation either", () => {
  // Measured in the certification e2e: the reviewer pane got the OPENER's
  // RESUME ("code review gate is PENDING"), answered it with a second conclude
  // 8s after its first, and the gate recorded a DRAFT verdict from the first
  // report. A reporting shell has no gates of its own — and since the conclude
  // tool, no settle-time scraping either.
  const settled = loopSettledWindow("// L7/L8 — completion-only requirements");
  assert.match(settled, /if \(readJudgeSideEnv\(process\.env\)\) return;/,
    "a judge pane returns before the RESUME injection");
  assert.doesNotMatch(settled, /maybeWriteVerdictReport/,
    "no settle-time verdict scraping may come back");
});

test("judge_conclude is registered judge-side only (anti-forgery by surface)", () => {
  // The main session must never see the tool: a main session that could
  // self-certify a verdict breaks the gate. The guard is the registration.
  const calls = [...SRC.matchAll(/registerJudgeConcludeTool\(pi,/g)];
  assert.equal(calls.length, 1, "exactly one registration, on the agent-visible host");
  const at = calls[0]!.index!;
  const window = SRC.slice(Math.max(0, at - 900), at);
  assert.match(window, /if \(readJudgeSideEnv\(process\.env\)\) \{/,
    "the registration sits inside the judge-side branch");
});

test("the inspection observer is fed IN PROCESS, from successful judge tool results", () => {
  // The evidence must be gathered where the round happens (a judge pane runs
  // THIS extension), not scraped from a transcript afterwards — a transcript
  // is written by the very session being checked.
  const handler = windowOf('pi.on("tool_result"', "// 1. Edits: only arm gate on success.", "tool_result observer");
  assert.match(handler, /isJudgePane\(\) && event\.isError !== true/,
    "judge panes only, successful calls only — a failed read inspected nothing");
  assert.match(handler, /judgeInspection = observeInspection\(/,
    "the fold itself lives in lib/judge-inspection.ts");
  // It must sit BEFORE the branches, all of which return early.
  const feedAt = SRC.indexOf("judgeInspection = observeInspection(");
  const firstBranchAt = SRC.indexOf("if (EDIT_TOOL_NAMES.has(event.toolName)) {");
  assert.ok(feedAt >= 0 && firstBranchAt >= 0 && feedAt < firstBranchAt,
    "an early-returning branch must not be able to skip the observation");

  // Every action is stamped with the round it belongs to: a pane outlives its
  // rounds, and an abandoned one would otherwise lend its reads to the next.
  assert.match(handler, /judgeCurrentRound\(\)/, "the fold carries the round");
  const roundReader = windowOf("function judgeCurrentRound(", "\n  }", "judgeCurrentRound");
  assert.match(roundReader, /readFileSync\(pathJoin\(cwd, "\.pi", HIERARCHY_FILENAME\)/,
    "the round comes from the registry FILE — the in-memory copy is loaded once and would go stale");
  assert.doesNotMatch(roundReader, /judgeHierarchy/);

  // The round's OWN paperwork must be excluded, or the gate is decorative: the
  // probe says "conclude READY and do nothing else", and a judge reads its own
  // task regardless — crediting that read would clear the gate for free.
  assert.match(handler, /ownPaths: judgeOwnPaths\(\)/, "the fold knows the round's own files");
  const ownPaths = windowOf("function judgeOwnPaths(", "\n  }", "judgeOwnPaths");
  assert.match(ownPaths, /JUDGE_TASK_ENV/, "the task file this round was opened with");
  assert.match(ownPaths, /JUDGE_STREAM_ENV/, "the findings stream this round publishes to");


  // The judge_conclude wiring must actually pass the evidence in: an unwired
  // host would leave the rule asserting nothing.
  const wiring = windowOf("registerJudgeConcludeTool(pi, {", "\n    });", "judge_conclude deps");
  for (const dep of ["inspection: () => judgeInspection", "inspectionPass:", "noteInspectionRefusal:", "noteConcluded:"]) {
    assert.ok(wiring.includes(dep), `judge_conclude is wired with ${dep}`);
  }
  assert.match(wiring, /judgeInspection = emptyInspection\(\)/,
    "a round's evidence must not carry into the next round");
});

test("the zero-inspection refusal has an appeal, and it grants only that round", () => {
  // Reachability: the appeal route must be dispatched from request_arbitration,
  // and it contests the MOST RECENT block like the other two classes.
  const dispatch = windowOf(
    "// Must contest a REAL, recent block",
    "const parsed = parseArbitrableAction(",
    "request_arbitration dispatch",
  );
  assert.match(dispatch, /lastBlockedInspection && lastBlockedInspection\.at === newest/);
  assert.match(dispatch, /return arbitrateInspection\(/);

  const appeal = windowOf("async function arbitrateInspection(", "\n  }\n", "arbitrateInspection");
  assert.match(appeal, /admitInspectionAppeal\(/, "quota and no-re-rolling come from the pure module");
  assert.match(appeal, /spendArbitration\(/, "an appeal costs a slot of the SHARED quota");
  assert.match(appeal, /INSPECTION_APPEAL_SYSTEM_PROMPT/, "its own standing instructions");
  assert.match(appeal, /verdict\?\.decision \?\? "GATE_WINS"/, "fail-closed on any arbiter failure");
  assert.match(appeal, /inspectionPass = issueInspectionPass\(/, "AGENT_WINS mints the round-bound pass");
  // What it can NEVER do: mint a ship bypass token.
  assert.doesNotMatch(appeal, /bypassToken/, "no appeal class may authorize a ship command");

  // A user reset drops the pass with the rest of the appeal state.
  const reset = windowOf("lastBlockedShip = null;", "arbitrationDecisions.clear();", "gate reset");
  assert.match(reset, /lastBlockedInspection = null;/);
  assert.match(reset, /inspectionPass = undefined;/);
});

test("the background supervisor is wired, default-on in orchestrator mode, and cleaned up", () => {
  const start = windowOf("function startSupervisionTimer(", "\n  }", "startSupervisionTimer");
  assert.match(start, /SUPERVISION_INTERVAL_MS/, "the cadence is a named constant, not a literal at the call site");
  assert.match(start, /state\.taskMode !== "orchestrator"/, "it exists only for the supervising role");
  // BUSY OR IDLE, EVERY CHILD EVENT GOES THROUGH (user decision, 2026-09-14).
  // The idle requirement WAS the reported bug: a manager that was working
  // never heard about a child asking a question, so the child waited for an
  // `orchestrator_wait` that might come much later.
  assert.doesNotMatch(start, /isIdle/, "no idle pre-condition may come back");
  assert.match(start, /deliverAs: "steer"/,
    "…and the delivery cuts into the next turn WITHOUT aborting work in flight");
  assert.match(start, /triggerTurn: true/, "an idle supervisor is WOKEN, not merely written to");
  // What it reads is the CHANNELS — no pane is captured anywhere in the loop.
  const drain = windowOf("function drainSupervisionNews(", "\n  }", "drainSupervisionNews");
  assert.match(drain, /superviseNow\(/, "the read is the ONE supervision read (B4)");
  assert.match(drain, /deps\.supervisionMemory\(\)|orchestratorDeps\.supervisionMemory\(\)/,
    "the event memory is SHARED with orchestrator_wait, so neither re-rings what the other reported");
  assert.doesNotMatch(drain, /capture-pane/, "and nothing in it renders a terminal");
  const read = windowOf("function superviseNow(", "\n  }", "superviseNow");
  assert.match(read, /superviseChildren\(\{/, "and that read is the supervisor module's");
  assert.match(read, /io: channelIO/, "over the channels, never a pane");
  // ONE TRUTH ABOUT "IS ANYONE WAITING FOR A REPLY" (2026-09-22). This read
  // feeds the `[ORCHESTRATION] 子会话需要你` injection and `orchestrator_wait`
  // builds its receipt from the same module — but the wait passes
  // `deps.channelHome()` and this one did not, so the two agreed only for as
  // long as no host bound a channel home.
  assert.match(read, /channelHome\(\)/,
    "the timer must read the SAME channel root the wait receipt does");
  // …and the pane reading is the tool-kit's one implementation, rather than a
  // second hand-assembled tmux call.
  const panes = windowOf("function alivePaneIdsForSupervision(", "\n  }", "alivePaneIdsForSupervision");
  assert.match(panes, /alivePanes\(orchestratorDeps\)/, "one pane measurement, shared with the wait");
  assert.doesNotMatch(panes, /orchestratorDeps\.tmux\(/, "the duplicated argv is gone");
  const shutdown = windowOf('pi.on("session_shutdown"', "\n  });", "session_shutdown");
  assert.match(shutdown, /stopSupervisionTimer\(\)/, "a leaked timer would keep waking a session that is gone");
});

test("B4/F14: the INJECTED wrap-up block reads the same channels and never invents a corpse", () => {
  // This block is the one an orchestrator sees every turn, and it is not
  // reachable from a tool test — so its wiring is asserted from source, the
  // way the rest of this file asserts extension wiring.
  const block = windowOf("function orchestrationDoneProblems(", "\n  }", "orchestrationDoneProblems");
  assert.match(block, /return orchestratorDoneProblems\(\{/,
    "the window really does reach the call it is about");

  // ONE pane reading, shared with the background supervisor…
  assert.match(block, /alivePaneIdsForSupervision\(\)/,
    "not a second private `list-panes` — that is how the two readings drifted apart");
  // …and F14: unknown liveness is declared, never flattened into an empty list.
  assert.match(block, /livenessUnknown: true/,
    "an unreadable pane list used to be passed as `[]`, which means 'every pane vanished'");

  // Completion comes from the CHANNEL snapshot, through the one derivation.
  assert.match(block, /superviseNow\(/);
  assert.match(block, /reportedDoneIds\(/,
    "block 5 answers 'who finished' from the same reading block 1 does (B4)");
  assert.doesNotMatch(block, /doneAt/,
    "the registry cache it used to read is gone — completion is a channel fact");

  // And the pane reading itself must fail to UNKNOWN, not to empty.
  const panes = windowOf("function alivePaneIdsForSupervision(", "\n  }", "alivePaneIdsForSupervision");
  // The measurement itself is `alivePanes` (lib/orchestrator-tool-kit.ts),
  // which swallows both a failed call and a throw into `ok: false`; UNKNOWN
  // has to survive the conversion to a Set.
  assert.match(panes, /read\.ok \? new Set\(read\.panes\) : undefined/,
    "a failed measurement stays UNKNOWN rather than becoming an empty set");
  assert.doesNotMatch(panes, /return new Set\(\);/, "an empty set here would read as a graveyard");
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
  // THE ONE NON-ENFORCED REQUEST (2026-09-21): a WORKER pane asking for
  // explore. Undecided behaved as loop, and the measured cost was a worker
  // being continued 1/15, 2/15 … after it had already reported. It is not a
  // relaxation: the worker identity is REQUIRED, so an ordinary session that
  // sets RG_GATE_MODE=explore in its own environment is still ignored.
  assert.match(block, /requestedBySpawner === "explore" && readWorkerSideEnv\(process\.env\)/,
    "a worker pane's explore is honoured — and only a worker pane's");
  assert.match(block, /setTaskMode\("explore", "auto", ctx\)/);
});

test("the file-size gate runs at the CHECKPOINT, and only new files can block it", () => {
  const body = toolBodyOf("review_checkpoint");
  assert.match(body, /fileSizeVerdict\(sizeFacts\)/);
  // "WHICH FILES ARE NEW" IS NOT A HEAD QUESTION ALONE (2026-09-15): mid-merge
  // HEAD is still the branch tip, so everything the OTHER side brings in would
  // count as this session's creation — measured: 104 staged additions, all of
  // them main's, three of them over the limit, and the checkpoint is the only
  // way into the review loop. The bases are read once,
  // through the module that owns the rule.
  assert.match(body, /const changeBases = readChangeBaseRefs\(root\)/,
    "the comparison bases come from the merge-aware reader, not from HEAD by hand");
  assert.match(body, /isNew: isNewInWorktree\(root, p, changeBases\)/,
    "membership in ANY base is what makes a file NOT new");
  assert.doesNotMatch(body, /cat-file", "-e", `HEAD:\$\{p\}`/,
    "the HEAD-only reading is the bug this replaced");
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


test("non-git directory: the gate short-circuits entirely (user decision 2026-09-02)", () => {
  // Root cause this fixes: outside a git repository, the extension's git
  // reads (symbolic-ref / rev-parse) threw and LEAKED "fatal: not a git
  // repository" to the terminal (they had no stdio ignore), once at
  // startup and on every widget tick. The user decision: in a non-git
  // directory, do not call git AT ALL — no branch, no loop goal, no
  // checkpoint/review/precommit/ship machinery.
  //
  // sessionInGit is derived ONCE from gitRootOfDir(cwd) (which itself
  // silences stderr), so the probe never leaks; every git-backed path
  // then branches on it BEFORE any git call.
  assert.match(SRC, /let sessionInGit = gitRootOfDir\(cwd\) !== null;/,
    "sessionInGit must be derived from gitRootOfDir (the stderr-silenced probe)");
  assert.match(SRC, /sessionInGit = gitRootOfDir\(cwd\) !== null;/,
    "session_start re-derives sessionInGit for a switched session");
  // The widget must not call currentBranch (the fatal source) outside a repo.
  const widget = windowOf("function gateWidgetFacts()", "function updateWidget", "gateWidgetFacts");
  assert.match(widget, /sessionInGit \? currentBranch\(primaryRepoRoot\)/,
    "the status strip must not run git outside a repository");
  assert.match(widget, /branch: sessionInGit/, "non-git branch must be absent, not \"(detached)\"");
  // The loop goal is a per-repo contract — not an unmet requirement outside one.
  assert.match(widget, /sessionInGit && !goalStageSatisfied\(\)/,
    "the loop-goal unmet must not surface outside a repository, nor when the user released the goal stage");
  // The widget WIRING is pinned too: `nonGit: !sessionInGit` — flipping it
  // to a constant would render the 非 git 目录 strip for repo sessions.
  assert.match(widget, /nonGit: !sessionInGit,/,
    "the strip's nonGit flag must be wired to sessionInGit (reviewer P2)");
  // The clampReason CALL SITE is pinned the same way (reviewer P2, round 3):
  // replacing it with `clampReason: undefined` would silently regress the
  // reject wording to the /tmp lie while every test stays green.
  const modeChange = windowOf("const decision = evaluateModeChange({", "      });", "set_gate_mode decision");
  assert.match(modeChange, /clampReason: !sessionInGit/,
    "the non-git clamp reason must be passed to evaluateModeChange");
  // session_start forces normal mode and returns before any git-backed step.
  const start = windowOf("pi.on(\"session_start\"", "pi.on(\"session_shutdown\"", "session_start");
  assert.match(start, /if \(!sessionInGit\) \{/, "session_start must branch on sessionInGit");
  assert.match(start, /setTaskMode\(\"normal\", \"auto\", ctx\)/,
    "a non-git session is forced to normal mode");
  // The review/checkpoint/precommit tools refuse outside a repository.
  for (const tool of ["checkpoint", "judge_submit", "run_precommit", "record_review", "declare_done"]) {
    assert.match(SRC, new RegExp(`非 git 目录 —— ${tool} 不可用|非 git 目录 —— 门禁不介入`),
      `non-git refusal copy must exist for ${tool}`);
  }
});

test("restart does not strand pane judges: registry + pendings persist per repo", () => {
  // The process era's pid/exit-code takeover is gone; without a durable
  // registry a restart would leave live panes unaddressable and fork a
  // second pi onto one session id. Slices live under each repo's `.pi/`.
  assert.match(SRC, /function persistJudgeHierarchy\(\)/, "one writer persists every mutation");
  assert.match(SRC, /function ensureHierarchyLoaded\(root: string\)/, "restore merges one repo's slice");
  assert.match(SRC, /function setHierarchy\(next: HierarchyTable\)/, "table writes funnel through one setter");
  assert.match(SRC, /judge-hierarchy\.json/, "the file name is pinned");
  // Every table write goes through the funnel — a direct assignment that
  // skips persistence reopens the strand gap.
  const direct = [...SRC.matchAll(/judgeHierarchy = (?!next;)/g)]
    .filter((m) => !/let judgeHierarchy/.test(SRC.slice(Math.max(0, m.index! - 60), m.index)));
  assert.deepEqual(direct.map((m) => m[0]), [], "no direct table assignment outside the declaration");
  // …and session_start restores before any tool can run. ANCHORS INSTEAD OF A
  // WINDOW: a fixed slice of characters is a reading heuristic that breaks
  // every time a comment above the merge grows (it did, twice, in one round) —
  // what the rule actually says is "inside session_start, before any tool can
  // run", so that is what is asserted.
  const startAt = SRC.indexOf('pi.on("session_start"');
  const mergeAt = SRC.indexOf("ensureHierarchyLoaded(root)", startAt);
  assert.ok(mergeAt > startAt, "a restarted session merges previous slices");
  assert.ok(mergeAt - startAt < 8000, "…early in session_start, before any tool can run");
});

test("restart does not deadlock on a dead opener: dead foreign entries are dropped", () => {
  // Persisting without a drop trades the strand gap for a refusal deadlock:
  // a restarted session id never equals the dead opener. Dead foreign
  // entries (pane gone + channel silent) are dropped by whoever touches
  // them — adopting them would resurrect a review whose opener-scoped
  // transcript the new session must never read. A live pane or fresh
  // heartbeat keeps the strict refusal.
  assert.match(SRC, /function dropDeadForeignJudges\(\)/, "the drop exists");
  assert.match(SRC, /e\.openerId === caller\) continue;/, "own entries are never touched");
  assert.match(SRC, /panes\.includes\(e\.paneId\)\) continue;/, "a live pane keeps the refusal");
  assert.match(SRC, /if \(channelFresh\(e\)\) continue;/, "a fresh heartbeat keeps the refusal");
  assert.match(SRC, /delete judgeHierarchy\[id\];/, "the dead entry is dropped, never adopted");
  assert.doesNotMatch(SRC, /openerId: caller \};/, "no adoption may come back");
  // …and it runs on every hierarchy read, so no tool path can deadlock.
  const reads = [...SRC.matchAll(/hierarchy: \(\) => \{ dropDeadForeignJudges\(\); return judgeHierarchy; \},/g)];
  assert.equal(reads.length, 2, "both judge tool families drop on read");
  const dispatchAt = SRC.indexOf("function dispatchJudgeRound(");
  assert.match(SRC.slice(dispatchAt, dispatchAt + 800), /dropDeadForeignJudges\(\);/,
    "dispatch drops before deriving its own id");
});

/**
 * ONE registry (哲学三): the in-memory `childSessions` Map is deleted and every
 * reader goes through the persisted table.
 *
 * The Map's scope was implicit — it could only ever hold judges THIS process
 * opened. The merged table holds neither guarantee: it carries entries
 * restored from disk AND entries belonging to other openers. So the scope has
 * to be spelled out at each reader, and that is a property of the SOURCE, not
 * of any single call: a reader that forgets `ownJudges()` still compiles, still
 * passes every behavior test, and quietly reports a peer's review as its own.
 */
function judgeReaderBody(name: string): string {
  const raw = windowOf(`function ${name}(`, /\n  \}\n/, `own-judge reader ${name}`);
  // Self-proof (both directions): the window must reach the reader's real
  // work, and must NOT have swallowed whatever function follows it. A window
  // that is too small satisfies "contains ownJudges()" for the wrong reason,
  // and one that is too large satisfies it using the NEXT function's code.
  assert.ok(raw.length > 40, `${name}: window collapsed to nothing`);
  assert.doesNotMatch(raw.slice(raw.indexOf("{")), /\n  function /,
    `${name}: window ran past the end of the function`);
  // CODE ONLY. Without this the rule is satisfiable by a COMMENT: the body of
  // judgeChildInMotion explains why it uses ownLiveJudges(), so swapping the
  // real call for ownJudges() left the assertion green (reviewer P1,
  // 2026-09-05). A structural test that a docblock can satisfy protects the
  // wording, not the behaviour.
  const body = codeOnly(raw);
  assert.doesNotMatch(body, /ownLiveJudges\(\)[^\n]*\/\//, "comments must already be gone");
  return body;
}

test("the judge registry is ONE table: every own-judge reader is opener-scoped", () => {
  // The Map itself is gone — name included, so a half-finished revival is loud.
  const codeSrc = codeOnly(SRC);
  assert.doesNotMatch(codeSrc, /childSessions/, "the in-memory Map must not come back");
  assert.doesNotMatch(codeSrc, /interface JudgeChild\b/, "its record type goes with it");

  // Positive control for the derivation: these two helpers must exist, or
  // every assertion below is vacuously satisfiable by a source that has no
  // readers at all.
  assert.match(SRC, /function ownJudges\(\): JudgeEntry\[\]/, "the opener scope has one definition");
  assert.match(SRC, /function ownLiveJudges\(\): JudgeEntry\[\]/, "the liveness scope has one definition");
  assert.match(SRC, /listByOpener\(judgeHierarchy, id\)/,
    "the filter is lib/hierarchy.ts's, not a re-implementation");

  // "Is a judge RUNNING?" — must additionally exclude entries whose pane died
  // with a previous process, or a restarted session waits forever on a pane
  // nobody can answer from.
  for (const name of ["activeJudgeWait", "judgeChildInMotion"]) {
    assert.match(judgeReaderBody(name), /ownLiveJudges\(\)/,
      `${name} must read live own judges, never the raw table`);
  }
  // "Which judge is mine?" — opener scope is enough; both branches need it,
  // since the id lookup used to run against a Map that was own-only by
  // construction.
  for (const name of ["judgeChildByRole", "findJudgeChild"]) {
    assert.match(judgeReaderBody(name), /ownJudges\(\)/,
      `${name} must not hand back another opener's review`);
  }
  // declare_done's cascade-close deliberately uses the WIDER scope: a dead
  // pane still leaves an entry, a scratch worktree and a pending audit to
  // reclaim. What must never widen is the opener.
  assert.match(SRC, /const ownedJudges = ownJudges\(\)\.filter\(\(child\) =>/, "cascade-close is opener-scoped");
  // The health snapshot the hosted wait is built from.
  assert.match(SRC, /for \(const c of ownJudges\(\)\) \{/, "the child snapshot lists own judges only");
});

/**
 * PANE LIFECYCLE: THE SECOND POLICY IS TOPOLOGY, NOT A BRANCH (t9d, 2026-09-06).
 *
 * `lib/judge-pane-policy.ts` states both answers to "when does a judge pane go
 * away" and is EXECUTED in exactly one place — `runAuditRound`'s reclaim. The
 * other policy ("the agent's review pane lives until declare_done") has no
 * branch to test, because nothing decides it at runtime: the agent cannot call
 * `judge_close` at all, and `declare_done`'s sweep closes everything of this
 * opener without asking who dispatched it.
 *
 * That is a real invariant and it is what this test pins. A future round that
 * teaches the sweep to consult the policy and skip something would break the
 * guarantee that finishing a task can never strand a pane — and a round that
 * makes it consult the policy and then close everything anyway would add the
 * decorative call site the policy module explicitly argues against.
 *
 * THE ONE EXEMPTION (2026-09-22, reviewer P1): the pane of the round the gate
 * is ITSELF waiting on is filtered out of the list — the acceptance round, and
 * only while its own record still says AWAITING. Closing it first made
 * `acceptanceRoundAlive()` answer “gone”, and `acceptanceDecision`'s own
 * `roundAlive === false` rule then dispatched a SECOND round on top of a
 * working judge (the first one killed and paid for twice). The guarantee above
 * is untouched, and the reason is mechanical: while a record says AWAITING the
 * decision is `wait` and `declare_done` returns that refusal, so the
 * completion path — the only path the sweep runs on — is UNREACHABLE with an
 * exempted pane. The policy module calls the sweep “the terminus for a pane
 * whose round never concluded”; an in-flight round has a terminus of its own.
 */
test("declare_done's cascade is SOURCE-BLIND: it closes by opener, never by dispatcher", () => {
  const sweep = windowOf("const ownedJudges = ownJudges()", "progress.step(`联关", "declare_done cascade");
  // It closes what it owns, one by one, with no question about provenance.
  assert.match(sweep, /for \(const child of ownedJudges\) \{/, "every owned judge is visited");
  for (const dispatcherish of ["judgePaneReclaim", "dispatchedBy", "atRoundEnd", "judge-pane-policy"]) {
    assert.equal(sweep.includes(dispatcherish), false,
      `the sweep must not consult "${dispatcherish}" — a decorative call site is worse than none`);
  }
  // …and it must not learn to skip. A `continue` guarded by the role is
  // exactly how "finishing can never strand a pane" would quietly stop being
  // true, and `goal-auditor` is the role such a guard would name.
  assert.doesNotMatch(sweep, /role === "goal-auditor"[^\n]*continue/,
    "no role may be exempted from the terminal sweep");

  // THE OTHER HALF OF THE TOPOLOGY: the agent has no way to close a pane, so
  // there is nothing for it to get wrong. `judge_close` is registered on the
  // internal host only.
  const registration = windowOf("judge_close", "judge_wait", "judge tool host split",
    SRC.indexOf("// WHERE EACH ONE LIVES."));
  assert.match(registration, /INTERNAL host/,
    "judge_close stays off the agent's tool surface — that IS policy (b)");
});

/**
 * THE GATE'S OWN RECLAIM NO LONGER THROWS ITS EVIDENCE AWAY (t9d).
 *
 * `closeJudge` used to `await callTool("judge_close", …)` and drop the reply.
 * That reply is the ONLY place a half-done reclaim is visible: the tool clears
 * the registry row even when the kill fails, so once the text is gone the
 * leftover pane cannot be found by anything — the row it would be found by no
 * longer exists.
 */
test("the audit chain's close path reports what the reclaim achieved", () => {
  // THE CLOSE MOVED INTO ONE HELPER (2026-09-21): the gate's synchronous
  // chains (`closeJudge`) and the round-end reclaim that now frees an
  // agent-dispatched review pane both call `closeOwnedJudge`, because "read
  // hadPane before the close, close by judgeId, map the reply" is exactly the
  // sequence whose two copies drift.
  const dep = windowOf("async function closeOwnedJudge(", /\n  \}\n/, "closeOwnedJudge helper");
  assert.match(dep, /return \{/, "the outcome is returned, never discarded");
  // 2026-09-08: the close goes through `doClose` directly (gate-self bypass
  // of the repo check) — the terminated reading is a cast-guarded property
  // read off the same reply shape. What is pinned is that the value comes
  // from the TOOL's reply, not from an assumption.
  assert.match(dep, /terminated:/, "the outcome reports termination");
  assert.match(dep, /closed\.details/, "…read off the tool reply");
  assert.match(dep, /doClose\(selfSessionDeps\(\)/, "the gate closes its own auditor directly");
  // `hadPane` is only knowable BEFORE the close: the row is dropped by it.
  const hadPaneAt = dep.indexOf("const hadPane =");
  const callAt = dep.indexOf("doClose(selfSessionDeps()");
  assert.ok(hadPaneAt >= 0 && callAt >= 0, "both halves are present");
  assert.ok(hadPaneAt < callAt, "hadPane must be read before the row is dropped");
  // …and BOTH callers go through it, so a reclaim cannot report an outcome
  // the close never produced.
  assert.match(SRC,
    /closeJudge: async \(root, role\) => closeOwnedJudge\(/,
    "the gate's own chains use the shared close path");
  assert.match(SRC,
    /reclaimJudgePane: async \(root, judgeId, role\) => \{[\s\S]*?closeOwnedJudge\(root, judgeId, role\)/,
    "…and so does the round-end reclaim");
});


test("a judge session writes NO gate state, and says so outside the repo", () => {
  // A judge is a reporting shell. Its pane carries no RG_STATE_VARIANT, so
  // before this it wrote the OPENER's sidecar — the one file the git hooks
  // read (measured 2026-09-05: sessionId became rg-reviewer-…, taskMode fell
  // from orchestrator to none).
  //
  // The guard has to sit AHEAD of the writes, not merely somewhere in the
  // function, so each window is checked for order rather than membership.
  for (const fn of ["persist", "persistRepo"]) {
    const body = windowOf(`function ${fn}(`, /\n  \}\n/, `${fn} body`);
    const guardAt = body.indexOf("noteGateStatePersistSkip(ctx)");
    assert.ok(guardAt > 0, `${fn} must consult the write-skip decision`);
    // Window self-proof: this really is a persisting function (if the window
    // missed the writes, "the guard comes first" would be vacuously true).
    const writeAt = body.search(/saveSidecarPreservingConcurrent|recordBlockedMarker/);
    assert.ok(writeAt > 0, `${fn}: window does not reach the writes it is supposed to guard`);
    assert.ok(guardAt < writeAt, `${fn}: the skip must be decided BEFORE anything is written`);
  }

  // The decision itself lives in lib/session-exclusivity.ts, where it is
  // unit-tested — the extension must not re-derive "am I a judge / a worker"
  // with its own condition.
  assert.match(SRC, /gateStateWriteSkip\(process\.env\)/, "the rule has one home");
  assert.doesNotMatch(codeOnly(SRC), /gateStatePersistSkip\(process\.env\)/,
    "the judge-only predecessor is gone, not kept beside it");

  // And the audit record must not become the very thing it reports: no file
  // write of any kind inside the recorder.
  const recorder = windowOf("function noteGateStatePersistSkip(", /\n  \}\n/, "skip recorder");
  assert.match(recorder, /pi\.appendEntry\(GATE_STATE_SKIP_ENTRY/, "it lands in pi's own session store");
  assert.doesNotMatch(recorder, /writeFileSync|appendFileSync|mkdirSync|writeFileAtomic/,
    "a judge must not write into the repo it is reviewing — not even to log that it did not");
  assert.match(recorder, /gateStateSkipAnnounced/, "said once, not once per persist");

  // EVERY write to the repo's gate state, not just the ones inside persist().
  // The `.blocked` marker is reconciled from session_start too — deliberately,
  // because an early return can mean persist() never runs — and that call sat
  // outside the guard (reviewer P1, 2026-09-05). Derive the sites instead of
  // listing them, so a NEW one outside a guarded funnel is caught too.
  const guardedFunnels = ["function persist(", "function persistRepo("];
  const markerCalls = [...codeOnly(SRC).matchAll(/reconcileBlockedMarker\(|recordBlockedMarker\(/g)];
  assert.ok(markerCalls.length >= 3, "derivation sanity: the marker is written from several places");
  for (const call of markerCalls) {
    const before = codeOnly(SRC).slice(0, call.index);
    // Which function is this call in? The last funnel opened before it, if the
    // funnel's closing brace has not been passed.
    const inFunnel = guardedFunnels.some((fn) => {
      const at = before.lastIndexOf(fn);
      return at >= 0 && !before.slice(at).includes("\n  }\n");
    });
    if (inFunnel) continue;
    // Outside a funnel ⇒ the call must carry both guards itself.
    const window = codeOnly(SRC).slice(Math.max(0, call.index! - 700), call.index);
    assert.match(window, /gateStateWriteSkip\(process\.env\)/,
      `a gate-state write at offset ${call.index} is not behind the reporting-shell guard`);
    assert.match(window, /state\.exclusivityRefusal/,
      `a gate-state write at offset ${call.index} is not behind the worktree guard`);
  }
});

test("ONE gate session per worktree: refuse, hold, release — and only ONE liveness rule", () => {
  // The decision lives in lib/session-exclusivity.ts (unit-tested there). What
  // this pins is the WIRING, which no unit test can see.
  assert.match(SRC, /applySessionExclusivity\(ctx\)/, "session_start decides it");
  assert.match(SRC, /checkSessionExclusivity\(\{/, "…through the module that owns the rule");

  // Refused ⇒ blocked on BOTH surfaces. Edits go through the extension's
  // per-edit hook; ships go through unmetRequirements, the authority every
  // ship path already shares (lib/gate-state.ts).
  const editHook = codeOnly(windowOf("function loopGoalEditBlockFor(", /\n  \}\n/, "edit hook"));
  const refusalAt = editHook.indexOf("state.exclusivityRefusal");
  assert.ok(refusalAt > 0, "a refused session must not be able to edit this worktree");
  // BEFORE the explore short-circuit: an explore session writes files too, and
  // it would otherwise slip past on the very first line.
  const exploreAt = editHook.indexOf('taskMode === "explore"');
  assert.ok(exploreAt > 0, "window sanity: the explore short-circuit is in this window");
  assert.ok(refusalAt < exploreAt, "the worktree check must come before the mode branches");
  assert.match(GATE_STATE_SRC, /if \(state\.exclusivityRefusal\) return \[state\.exclusivityRefusal\]/,
    "…and the ship authority refuses on the same fact");

  // A refused session must not write the HOLDER's sidecar — that file is the
  // holder's, and the refusal is memory-only in both directions.
  const persistBody = codeOnly(windowOf("function persist(", /\n  \}\n/, "persist body"));
  assert.match(persistBody, /if \(state\.exclusivityRefusal\) return;/, "refused ⇒ persist nothing");
  assert.match(GATE_STATE_SRC, /const \{ exclusivityRefusal: _refusal, \.\.\.persisted \} = state;/,
    "…and saveSidecar strips it even if something reaches it");

  // The claim: written only by a session that PASSED and actually claims the
  // sidecar, and dropped on the way out only when it is ours.
  const apply = codeOnly(windowOf("function applySessionExclusivity(", /\n  \}\n/, "apply body"));
  assert.match(apply, /claimsMainSidecar\(process\.env\)\) holdWorktree\(\)/,
    "a judge / orchestration child must not claim the worktree it shares by design");
  assert.match(SRC, /releaseWorktree\(\);/, "shutdown lets go");
  const release = codeOnly(windowOf("function releaseWorktree(", /\n  \}\n/, "release body"));
  assert.match(release, /presenceIsOurs\(/, "…and never deletes another session's claim");

  // The gate's OWN writes are refused too. These are the paths the agent
  // cannot reach directly, which is exactly why they were missed: the ship
  // gate refuses the agent's `git commit`, while the gate's own checkpoint
  // does `git add -A` with hooks silenced, and propose_loop_goal writes
  // .pi/loop-goal.md (reviewer P1, 2026-09-05).
  const checkpoint = codeOnly(toolBodyOf("review_checkpoint"));
  // The commit is located by its ARGV alone. Spelling the spawn itself would
  // make test/hermetic-git.test.ts read this file as one that runs git (it
  // detects on raw text, by design) — and this file never runs anything.
  const ADD_ALL = '["add", "-A"]';
  assert.ok(checkpoint.includes(ADD_ALL), "window sanity: this really is the body that commits");
  const ckRefusalAt = checkpoint.indexOf("state.exclusivityRefusal");
  const addAt = checkpoint.indexOf(ADD_ALL);
  assert.ok(ckRefusalAt > 0 && ckRefusalAt < addAt,
    "a refused session must be stopped BEFORE the gate's own commit sweeps the holder's work");
  const goalWrite = codeOnly(windowOf("writeGoalFile: (path, text) => {", /\n    \},/, "goal file writer"));
  assert.match(goalWrite, /state\.exclusivityRefusal/,
    "…and before overwriting the holder's approved goal file");

  // The refusal must be able to LIFT on its own: its own text promises that
  // closing the other session is enough, so a re-check has to exist.
  assert.match(apply, /startExclusivityRecheck\(\)/, "a refused session keeps watching");
  assert.match(SRC, /function startExclusivityRecheck\(\)/, "…on a timer it owns");
  assert.match(SRC, /stopExclusivityRecheck\(\);/, "…which is stopped when it lifts and at shutdown");
  // The complaint is deduped on WHO holds it. The refusal text quotes the
  // holder's heartbeat, which is rewritten every few seconds, so comparing the
  // TEXT would pop a fresh error box on every re-check tick (reviewer P2).
  assert.match(apply, /refusedHolderId !== verdict\.holder\.sessionId/,
    "the refusal is announced once per holder, not once per heartbeat");

  // normal = the gate is off by definition, so no refusal is raised there —
  // but it must not take the claim either. The `normal` branch therefore sits
  // INSIDE the refused case (a normal session on a FREE worktree still holds,
  // by falling through to the bottom); holding unconditionally there would
  // steal the holder's record and delete it on exit (reviewer P2).
  const refusedBlockAt = apply.indexOf("if (!verdict.ok)");
  const normalAt = apply.indexOf('state.taskMode === "normal"');
  const holdAt = apply.lastIndexOf("holdWorktree()");
  assert.ok(refusedBlockAt > 0 && normalAt > refusedBlockAt,
    "the normal exemption belongs INSIDE the refused case");
  assert.ok(holdAt > normalAt, "…and the only hold is the one after the check passed");
  assert.equal((apply.match(/holdWorktree\(\)/g) ?? []).length, 1,
    "exactly one place takes the claim, and it is reached only when the check passed");

  // 哲学三: the OLD "another session wrote this sidecar within 4h" warning is
  // gone. Two definitions of "a session is alive" is one too many.
  const code = codeOnly(SRC);
  assert.doesNotMatch(code, /concurrentSessionNotice/, "the old recency warning must not survive");
  assert.doesNotMatch(code, /CONCURRENT_SESSION_WINDOW_MS/,
    "…nor its window, which was the second liveness definition");
  // …and not merely its NAMES. The judgement was "how recently did another
  // session write this sidecar", and its only possible input is the sidecar's
  // own `updatedAt`; re-deriving it under fresh names would pass the two
  // assertions above. The extension therefore reads that field NOWHERE — the
  // deleted warning was the only thing that ever wanted it.
  //
  // Self-proof for the derivation: the same pattern DOES find the field in
  // lib/gate-state.ts, which owns it. Without that control, a typo'd regex
  // would "prove" the absence of anything at all.
  assert.match(GATE_STATE_SRC, /updatedAt/, "derivation sanity: the field exists and the scan can see it");
  assert.doesNotMatch(code, /updatedAt/,
    "no session-recency judgement may be rebuilt from the sidecar's timestamp — liveness is the heartbeat");
});

/**
 * Round 5 (2026-09-05) — the two judge tasks the EXTENSION assembles inline
 * (the reviewer's note, the adviser's question) must go through the shared
 * untrusted-data seam, not hand-rolled string concatenation.
 *
 * The seam's own ordering is proved by unit tests over the pure function
 * (test/untrusted-data.test.ts); what those cannot see is whether these two
 * call sites still use it, which is exactly how the old shape would come back.
 */
test("round 5: both inline judge-task assemblies go through the untrusted-data seam", () => {
  const code = codeOnly(SRC);
  assert.match(SRC, /import \{ composeWithUntrustedData \} from "\.\.\/lib\/untrusted-data\.ts"/,
    "the extension imports the seam");
  // Derivation self-proof: the pattern finds the call sites at all before its
  // count means anything.
  const calls = [...code.matchAll(/composeWithUntrustedData\(/g)];
  assert.ok(calls.length > 0, "derivation sanity: the scan can see a call at all");
  assert.equal(calls.length, 2, "exactly the reviewer note and the adviser question");
  assert.match(code, /tag: "main_session_note"/, "the reviewer note is a labelled block");
  assert.match(code, /tag: "main_session_question"/, "so is the adviser question");
  // The pre-round-5 shape — agent text pasted BEFORE the gate's own task text
  // — must be gone, not merely supplemented.
  assert.doesNotMatch(code, /本轮改动说明（来自主会话）：\\n\$\{input\.note\}/,
    "the reviewer note may not open the task any more");
  assert.doesNotMatch(code, /你要回答的问题（来自主会话）：\\n\$\{task\}/,
    "…nor may the adviser question");
});

/**
 * ROTATION LEAVES NOTHING BEHIND (t6b, 2026-09-05).
 *
 * When the gate rotates a judge's transcript, the lane it stops using still
 * has a live pane and a registry row. Nothing downstream would ever look at
 * them again — the registry is keyed by judge id and the new round's id is a
 * different one — so a rotation that does not retire the old lane leaks one
 * pane every time. The unit tests cover the DECISION (test/judge-rotation.ts);
 * only the source can show that the decision is acted on.
 */
test("rotation retires the lane it replaces: pane closed, scratch reaped, row dropped", () => {
  const resolver = windowOf("function resolveJudgeLane(", "\n  /**\n   * The facts a rotated REVIEWER round",
    "resolveJudgeLane body");
  assert.match(resolver, /findJudgeLane\(judgeHierarchy, \{ role, repoRoot: root, openerId: opener \}\)/,
    "the previous lane is looked up in the ONE registry");
  assert.match(resolver, /decideJudgeRotation\(\{/, "the policy decides, not this call site");
  // The retire test is the ID, never the policy's verdict: a pre-rotation
  // entry has no lane, so the policy says `first` while the derived id already
  // grows a suffix — gating on `rotated` there strands the old row, and the
  // role lookup (first match wins) then addresses the stale judge.
  assert.match(resolver, /previous\.judgeId === nextId\) return;/,
    "any lane whose id changed is retired, rotation or not");
  assert.doesNotMatch(resolver, /decision\.rotated/,
    "the policy's verdict is not what decides a retire");
  assert.doesNotMatch(resolver, /if \(decision\.rotated && previous\)/,
    "the verdict-gated shape must not come back");
  assert.match(resolver, /retireJudgeLane\(previous, \{/, "through the shared retire path");
  // AND ONLY WHEN THE REPLACEMENT IS REGISTERED. Retiring at resolution time
  // drops the row before the dispatch can still fail (no tmux, no model
  // chain); the next dispatch would then see no previous lane, decide `first`
  // at generation 0, and resume the transcript that was just rotated away with
  // its round count back at one (reviewer P2, 2026-09-05).
  assert.match(resolver, /const retirePrevious = \(\): void => \{/,
    "the retire is handed to the caller, not performed here");
  assert.match(resolver, /if \(retired \|\| !previous \|\| previous\.judgeId === nextId\) return;/,
    "…idempotent, and a no-op when the lane did not change");
  const dispatchBody = windowOf("function dispatchJudgeRound(", "\n  function readRoundStdout(",
    "dispatchJudgeRound body");
  const retireCalls = dispatchBody.match(/rotation\.retirePrevious\(\)/g) ?? [];
  assert.equal(retireCalls.length, 3,
    "each of the dispatch's three outcomes that REGISTERED a lane retires the old one");
  assert.match(dispatchBody, /if \(opened\.deliveryFailed\) rotation\.retirePrevious\(\);/,
    "a pane that exists but never reported still replaced the old lane");


  const retire = windowOf("function retireJudgeLane(", "\n  /**\n   * Dispatch ONE round to a judge role",
    "retireJudgeLane body");
  assert.match(retire, /judgePaneAlive\(/, "a pane is probed before it is closed");
  assert.match(retire, /if \(alive === true\) closeJudgePaneOf\(entry, ctx\)/,
    "the live pane is closed through the ONE close helper (label-bar rule included)");
  assert.match(retire, /reapReviewScratch\(entry\.judgeId\)/, "its scratch worktrees are reclaimed");
  assert.match(retire, /removeJudge\(judgeHierarchy, entry\.judgeId\)/, "and the row is dropped");
  assert.match(retire, /if \(entry\.role === "goal-auditor"\) dropAudits\(/,
    "a pending audit dies with the lane that was judging it");
  // Archived IN PLACE: the dir is left for the TTL sweep, never deleted here.
  assert.doesNotMatch(retire, /rmSync\(/, "a retired lane's transcript is kept, not deleted");
});

/**
 * The judge's own context reading is the only fact in the rotation policy the
 * opener cannot measure. It rides the report; this is the wiring that lands it
 * in the registry, where the next dispatch reads it.
 */
test("the judge's context reading travels report → registry → next dispatch", () => {
  const code = codeOnly(SRC);
  assert.match(code, /contextPercent: \(\) => contextPercentOf\(latestCtx/,
    "the judge side reports its own usage at the conclusion");
  assert.match(code, /noteJudgeContextFrom\(entry\.judgeId, records\)/,
    "the opener records it when it reads the round's channel");
  const noting = windowOf("function noteJudgeContextFrom(", "\n  /**\n   * Close one judge's round",
    "noteJudgeContextFrom body");
  assert.match(noting, /sanitizeContextPercent\(/, "an unusable reading is dropped, never rounded into one");
  assert.match(noting, /if \(reading !== undefined\) percent = reading;/,
    "the NEWEST usable reading wins — a report without one leaves the last alone");
  assert.match(noting, /registerJudge\(judgeHierarchy, \{ \.\.\.entry, contextPercent: percent \}\)/,
    "it lands on the entry the lane lookup reads");
});

test("test-run discipline nudge: wired into the bash branch, judge panes exempt", () => {
  // 2026-09-08 (goal criterion 2): a manual full-suite/typecheck in the MAIN
  // session gets the nudge; a judge pane's full run is its job and stays
  // silent. Both halves must be structurally pinned.
  assert.match(SRC, /looksLikeFullLaneRun\(cmd\)/, "the bash branch consults the recogniser");
  assert.match(SRC, /text: FULL_LANE_NUDGE/, "…and appends the nudge when it hits");
  // Judge exemption sits in the same condition — readJudgeSideEnv(process.env)
  // === undefined means "main session, not a judge pane".
  const bashSite = SRC.slice(SRC.indexOf("Test-run discipline nudge"), SRC.indexOf("Test-run discipline nudge") + 700);
  assert.match(bashSite, /readJudgeSideEnv\(process\.env\) === undefined/,
    "judge panes must not hear the full-lane nudge");
  assert.match(bashSite, /state\.taskMode !== "normal"/,
    "normal mode stays silent too");
});

test("thinking-loop guard: the extension forwards the assistant stream, the state machine lives in lib/", () => {
  // 2026-09-09 (goal criteria 1–3): the DECISION lives in
  // lib/thinking-loop-guard.ts and the ACTIONS in lib/thinking-loop-controller.ts;
  // the extension is only allowed to forward. Both halves are pinned here.
  const start = SRC.indexOf('pi.on("message_update"');
  assert.ok(start > 0, "message_update must be wired");
  const body = SRC.slice(start, SRC.indexOf('pi.on("', start + 10));
  for (const kind of ["thinking", "text", "toolcall"]) {
    assert.match(body, new RegExp(`observe\\("${kind}"`), `${kind} deltas must reach the detector`);
  }
  assert.match(SRC, /createThinkingLoopController\(/, "the extension constructs the controller");
  assert.match(
    SRC,
    /pi\.on\("agent_settled", \(_event, ctx\) => \{\s*\n\s*const text = thinkingLoopInjection;/,
    "the model-facing notice is delivered only once the session is idle again",
  );
  assert.match(
    SRC,
    /pi\.on\("message_start", \(event, ctx\) => \{\s*\n\s*if \(event\.message\.role !== "assistant"\) return;\s*\n\s*thinkingLoopCtx = ctx;\s*\n\s*thinkingLoop\.startTurn\(\);/,
    "a new assistant message starts a fresh turn",
  );
  assert.match(
    SRC,
    /registerMarkdownTransformer\(\(markdown, context\) =>\s*\n\s*thinkingLoop\.truncateDisplay\(markdown, context\.messageType\)/,
    "the display cut rides the markdown transformer",
  );
  assert.doesNotMatch(SRC, /recoveries/, "the recovery counter belongs to the controller, not the extension");
});

// ---------------------------------------------------------------------------
// A HANDOFF MUST ACTUALLY HAND OVER (2026-09-10, rebate).
//
// MEASURED failure, two defects that compounded:
//   1. `orchestrator_handoff` reported success, and the successor's gate then
//      refused itself IN THE SAME WORKTREE ("这个 worktree 已被另一个会话占用",
//      naming the predecessor it had just been started to replace); its pi
//      exited, leaving the pane on a bare shell.
//   2. The PREDECESSOR was woken back into `orchestrator_wait` TWO SECONDS
//      after the handoff, because `orchestratorSettled` had no retired guard
//      while the revival path already had one.
// The two are one root cause: retiring a session was a flag, and a flag does
// not stop a timer, release a worktree, or survive `agent_settled`.
//
// WHAT IS PINNED HERE AND WHAT IS NOT. The relay's own behaviour — the order
// of release / boot / silence, the rollback, the heirship claim travelling in
// the successor's environment — is exercised END TO END by the fake world in
// test/orchestrator-tools.test.ts, against the real tool. What stays here is
// the half a tool-level test cannot see: the extension's wake-up paths, which
// are event-driven and have no seam to fake.
// ---------------------------------------------------------------------------

test("retiring is TWO phases, and the split is what makes each half safe", () => {
  const start = SRC.indexOf("function handoffRetirement(");
  assert.ok(start > 0, "the retirement function is present");
  const site = SRC.slice(start, start + 1400);
  // Phase one, and it must come first: the successor's boot races a heartbeat
  // we have not stopped yet.
  assert.match(site, /releaseWorktree\(\)/, "phase one releases the worktree claim");
  assert.ok(site.indexOf("releaseWorktree()") < site.indexOf("committed:"),
    "release comes BEFORE the silence — the successor arms its gate in this same worktree");
  // Phase two: the flag and the timers, together, and only behind the
  // commit callback (see the next test for why they cannot be earlier).
  const committed = site.slice(site.indexOf("committed:"), site.indexOf("rolledBack:"));
  assert.match(committed, /handedOffSession = true/, "phase two silences the session");
  assert.match(committed, /stopSupervisionTimer\(\)/, "the supervision timer goes quiet");
  assert.match(committed, /stopRevivalTimer\(\)/, "the revival timer goes quiet");
  assert.match(committed, /stopChildHeartbeat\(\)/, "and the child heartbeat a loop session may own");
  // And a rollback therefore has exactly ONE thing to undo.
  const rolled = site.slice(site.indexOf("rolledBack:"));
  assert.match(rolled, /if \(claimsMainSidecar\(process\.env\)\) holdWorktree\(\)/,
    "the rollback re-takes the claim — and only a session that claims one may write a heartbeat");
  assert.doesNotMatch(rolled, /stopSupervisionTimer|handedOffSession = false/,
    "phase two never ran on this path, so there is nothing else to undo (the old single-phase rollback could not re-arm a stopped timer)");
});

test("the handover is recorded BEFORE the session goes silent", () => {
  // MEASURED (review round 1, P2): whatever a session persists goes through
  // `persist()`, which refuses to write for a retired session — two sessions,
  // one sidecar. Marking retirement first made the successor's own relay row
  // memory-only. The behaviour is pinned end to end in
  // test/session-handoff-tools.test.ts; this is the one-line invariant that
  // makes it possible.
  const saveAt = HANDOFF_TOOLS_SRC.indexOf("deps.recordHandoff?.(");
  const commitAt = HANDOFF_TOOLS_SRC.indexOf("retirement?.committed()");
  assert.ok(saveAt > 0 && commitAt > 0, "runSessionHandoff records the handover then commits the retirement");
  assert.ok(saveAt < commitAt, "the record must be on disk before the writer is switched off");
  // …and the document itself is written before the pane opens, so the
  // successor's first message points at something that exists.
  const docAt = HANDOFF_TOOLS_SRC.indexOf("ensureHandoffDoc(deps, sessionId, docPath)");
  const openAt = HANDOFF_TOOLS_SRC.indexOf("await deps.openSuccessor(");
  assert.ok(docAt > 0 && openAt > 0 && docAt < openAt,
    "the document the successor is told to read must exist by the time its pane opens");
});

test("every wake-up path respects a retired session", () => {
  const start = SRC.indexOf("function orchestratorSettled(");
  assert.ok(start > 0);
  const settled = SRC.slice(start, start + 2000);
  const guardAt = settled.indexOf("if (handedOffSession) return;");
  const armAt = settled.indexOf("startSupervisionTimer()");
  assert.ok(guardAt > 0,
    "agent_settled must not revive a session that handed its orchestration over — this is the defect that put two project managers on one plan");
  assert.ok(armAt > 0 && guardAt < armAt, "the guard runs BEFORE the timers are re-armed");

  const supStart = SRC.indexOf("function startSupervisionTimer(");
  assert.ok(supStart > 0);
  assert.match(SRC.slice(supStart, supStart + 2000),
    /if \(handedOffSession\) \{ stopSupervisionTimer\(\); return; \}/,
    "an already-armed supervision tick stops itself instead of waking the retired session");

  // …and the FOURTH path, which the doc block above it used to over-claim
  // (round-1 P2): a finished round's report wakes the OPENER, and a retired
  // project manager that opened its own judge is an opener. The anchor is the
  // L2 settle handler, not `orchestratorSettled` — the two are different
  // functions and only one of them calls `settleFinishedRounds`.
  const settleStart = SRC.indexOf(LOOP_SETTLED);
  assert.ok(settleStart > 0);
  assert.match(SRC.slice(settleStart, settleStart + 3400),
    /if \(state\.taskMode !== "normal" && !handedOffSession && \(await settleFinishedRounds\(ctx\)\)\)/,
    "settleFinishedRounds must not wake a retired session either");

  // The sidecar writer too: two sessions writing one sidecar is what the
  // exclusivity guard exists to prevent, and the successor is admitted into
  // this worktree ON PURPOSE — so the predecessor stops writing.
  const persistAt = SRC.indexOf("function persist(ctx?: ExtensionContext)");
  assert.ok(persistAt > 0);
  assert.match(SRC.slice(persistAt, persistAt + 2500), /if \(handedOffSession\) return;/,
    "a retired session stops writing the sidecar the successor now owns");
});

test("the successor's heirship is read from its own environment, and the guard honours it", () => {
  assert.match(SRC, /process\.env\[PREDECESSOR_SESSION_ENV\]/,
    "the takeover claim is read from the successor's own environment");
  assert.match(SRC, /\.\.\.\(successorOf \? \{ successorOf \} : \{\}\)/,
    "and handed to the decision as the heirship relation");
  assert.match(SRC, /ownSessionId: \(\) => state\.sessionId \?\? undefined/,
    "the predecessor's OWN id is what travels (state.sessionId is string|null, the contract is string|undefined)");
  assert.match(EXCLUSIVITY_SRC, /if \(heir && holder\.sessionId === heir\) return \{ ok: true \}/,
    "the decision itself lives in lib/session-exclusivity.ts, unit-tested there");
});

// ---------------------------------------------------------------------------
// THE CHANGE INDEX'S GIT READS (round-2 P1, both of them reproduced against
// real git before they were fixed).
//
//   git diff --numstat  T1 T2  →  `2  0  dir_a.txt => dir_b.txt`
//   git diff --numstat --no-renames T1 T2 → `0 3 dir_a.txt` + `5 0 dir_b.txt`
//
// Rename detection is ON by default, so the first form is what a RENAMED FILE
// produces — and that string was rendered into a command the reviewer is told
// to paste into a shell, where `>` TRUNCATES A FILE. Non-ASCII paths went the
// other way: without core.quotePath=false git prints a C-escaped byte string
// (`"\344\270\255"`) that no shell would resolve back to the file.
// ---------------------------------------------------------------------------

test("both change-index git reads are rename-safe and shell-safe", () => {
  for (const probe of ["numstatInRange", "changedFilesInRange"]) {
    const at = SRC.indexOf(`${probe}: (root, baseline, head) =>`);
    assert.ok(at > 0, `${probe} is implemented in the extension`);
    const body = SRC.slice(at, at + 700);
    assert.match(body, /--no-renames/,
      `${probe} must not hand the reviewer a rename's \`old => new\` pseudo-path`);
    assert.match(body, /core\.quotePath=false/,
      `${probe} must emit the path bytes git will accept back, not a C-escaped string`);
  }
  // …and the two must AGREE about which files moved: name-only reports a
  // rename as the NEW path alone unless it is told the same thing, while
  // numstat --no-renames reports both halves. The loop above is what enforces
  // that, since both probes now carry both flags.
});

// ---------------------------------------------------------------------------
// B1 — THE FULL LANE RUNS BESIDE THE CHAIN (2026-09-10).
//
// The chain used to be strictly serial: 33s of full precommit, THEN freeze,
// THEN dispatch — and the agent was blocked for every one of those seconds.
// The precommit does not have to come first: the reviewer judges an IMMUTABLE
// COMMIT RANGE, so only the checkpoint must precede the dispatch.
//
// Three lines make that safe, and no tool-level test can see any of them:
// the lane is started WITHOUT being awaited, the checkpoint gate accepts a
// LIVE verification (and only a live one — a restarted session has no
// promise, and is refused exactly as before), and the verdict recorder
// refuses a READY that never passed. `readyLacksVerification`
// (lib/review-adjudicate.ts) is the rule, unit-tested there.
// ---------------------------------------------------------------------------

test("the full lane is started WITHOUT being awaited, and the checkpoint accepts a live verification", () => {
  // BOUNDED BY THE NEXT DECLARATION, NOT BY A BYTE COUNT (2026-09-22): the
  // window used to be `submitAt + 4000`, so a type-doc comment growing inside
  // the chain pushed the very calls these assertions name out of view and the
  // test failed for a reason that has nothing to do with the rule it pins —
  // exactly the failure mode `windowIn`'s own docblock describes.
  const submit = windowIn(SRC, "async function submitForReview(", /\n  (?:async )?function /, "the review chain");
  assert.match(submit, /void startPrecommitBeside\(input\.root, input\.ctx\)/,
    "the long lane starts and the chain runs beside it — awaiting here is exactly the 33s the agent used to lose");
  assert.doesNotMatch(submit, /await callTool\(\s*"run_precommit"/,
    "the serial shape is GONE, not merely bypassed (philosophy three)");

  const gateAt = SRC.indexOf("const precommitBypassed = st.bypass.active;");
  assert.ok(gateAt > 0, "the checkpoint gate is here");
  const gate = SRC.slice(gateAt, gateAt + 3000);
  assert.match(
    gate,
    /const verifyingNow =[\s\S]{0,120}?inFlightPrecommit\?\.root === root[\s\S]{0,80}?st\.precommit\.verdict === "NOT_RUN"/,
    "the receipt for a pending checkpoint is the LIVE promise in THIS process AND a verdict that has not landed yet — the promise is cleared in a microtask, so the verdict is what makes the test exact",
  );
  assert.match(gate, /if \(precommitStageOn && !precommitBypassed && !verifyingNow && st\.precommit\.verdict !== "PASS"\)/,
    "no live verification ⇒ the old rule, unchanged (fail-closed) — plus the one release the USER owns: a stage switched off");
  assert.match(gate, /if \(precommitStageOn && !precommitBypassed && !verifyingNow && st\.precommit\.testScope !== "full"\)/,
    "…and the lane requirement with it");
});

test("a FAIL that arrives after dispatch is reported, and it withholds the READY", () => {
  assert.match(SRC, /function reportAsyncPrecommit\(/,
    "the failure has a channel of its own — the round was dispatched before this verdict existed, so returning early is no longer available");
  // BOTH verdicts reach the agent (2026-09-16): a silent PASS is what stranded a
  // `judge_wait` for 6 minutes 47 seconds — the event had no delivery, and the
  // wait's own sources are the JUDGE's.
  assert.match(SRC, /function reportAsyncPrecommitPass\(/, "a PASS lands too, and something has to say so");
  assert.match(
    SRC,
    /if \(verdict === "PASS"\) \{\s*\n\s*reportAsyncPrecommitPass\([\s\S]{0,900}?\} else \{[\s\S]{0,400}?reportAsyncPrecommit\(\{/,
    "PASS through the short notice, every other verdict through the failure one — including a thrown runner (the parked-READY handling above runs first and must not swallow it)",
  );
  assert.match(
    SRC,
    /readyLacksVerification\(\{\s*precommitVerdict: st\.precommit\.verdict,[\s\S]{0,500}?lastFullPassTree: st\.precommit\.lastFullPassTree,[\s\S]{0,80}?reviewedTree: reviewTargets\.get\(targetRoot\)\?\.tree,[\s\S]{0,400}?bypassActive: laneVerificationWaived\(targetRoot, st\),\s*\}\)/,
    "the verdict recorder refuses a READY on content that never passed the full lane — and answers it from the round's OWN tree, not from the live binding the next edit resets",
  );
  assert.match(SRC, /unverified = true;/, "…and names the reason in the reply the agent reads");
});

test("a parked READY is replayed by the lane that lands on its tree, and retired by one that does not", () => {
  // 2026-09-15. `parkedReadyFate` is the pure decision (three trees, three
  // outcomes — test/review-adjudicate.test.ts). What this pins is the WIRING,
  // because the two things that make a hold safe are structural: the replay
  // goes through the SAME recorder the normal order uses (a second
  // implementation of the recording rules would drift), and the agent is woken
  // with a steered notice (this is a gate state change nobody else reports).
  //
  // AND THE HOLD NEEDS A LANE THAT CAN COME BACK FOR IT (round-1 P1): with no
  // lane in flight, parking the conclusion would stop the round forever while
  // the reply told the agent not to re-submit — the caller passes that fact in
  // and `classifyReadyWithholding` answers `unverified-idle` (a REFUSAL).
  assert.match(SRC, /laneStillRunning: inFlightPrecommit\?\.root === targetRoot/);
  // …and the refusal tells the agent WHICH way it went, because the two cases
  // need opposite advice (round-8): a running lane will replay this very
  // conclusion, an absent one never will.
  assert.match(SRC, /withholding === "unverified-idle"/,
    "the UNVERIFIED reply distinguishes 'a lane is still running' from 'nothing is coming'");
  assert.match(SRC, /const fate = parkedReadyFate\(\{/);
  // …AND THE RE-ASK IS ONE PLACE, CALLED FROM EVERY LANDING (2026-09-16): the
  // lane's landing, the quality round's settlement, and the settle sweep. The
  // first version decided the fate at the lane's landing alone, which was
  // right while the lane was the only thing a hold could wait for — with two
  // preconditions landing in either order it would strand half of them.
  assert.match(SRC, /async function resumeParkedReady\(\s*\n\s*root: string,/, "ONE re-ask of the parked conclusion's two preconditions");
  // …and the lane's own callback hands it what it MEASURED: the recorded tree
  // cannot say "that lane failed", and leaving a parked record behind after
  // the lane it was waiting for has landed is exactly what round-2 P2 banned.
  assert.match(SRC, /await resumeParkedReady\(root, ctx, \{ laneVerdict: verdict, coveredTree \}\)/,
    "the lane's landing passes its own verdict through");
  assert.match(SRC, /lane: parkedLaneHalf\(\{/, "the lane's half is computed by the pure rule");
  assert.match(SRC, /quality: qualityPrecondition\(\{/, "…and so is the quality round's");
  const resumeAt = SRC.indexOf("async function resumeParkedReady(");
  const resume = SRC.slice(resumeAt, SRC.indexOf("async function applyRoundCancel(", resumeAt));
  assert.match(resume, /if \(fate === "none" \|\| fate === "hold"\) return \[\];/, "a hold leaves the record where it is");
  // THE CTX GUARD COMES FIRST (quality round P1, 2026-09-16): deleting the
  // pending record without a context to persist the delete loses a READY the
  // agent has already been told not to re-submit. The record must be left
  // untouched when nobody can act on it.
  const guardAt = resume.indexOf("if (!liveCtx) return [];");
  const deleteAt = resume.indexOf("delete st.pendingReady;");
  assert.ok(guardAt > 0 && deleteAt > guardAt,
    "no context ⇒ nothing changes (the guard precedes the delete)");
  assert.match(resume, /await recordReviewVerdict\(parked\.conclusion as ReportConclusion, root, liveCtx\)/,
    "the replay IS the recorder — one implementation of the recording rules");
  assert.match(resume, /buildParkedReadyReplayNotice\(\{ round: parked\.round, tree: parked\.tree, recorded \}\)/,
    "and the wording lives in lib/, like the failure notice beside it");
  assert.match(resume, /deliverAs: "steer"/, "steered, not queued behind a long turn");
  // The BACKSTOP: a hold whose second precondition can never land (the quality
  // pane died after the record was parked) must be retired by the settle sweep,
  // not left to rot while the reply says "do not re-submit".
  const sweepAt = SRC.indexOf("async function settleFinishedRounds(");
  assert.match(SRC.slice(sweepAt, sweepAt + 2000), /for \(const root of sessionRepos\) await resumeParkedReady\(root, ctx\);/,
    "every settle re-asks a parked conclusion");
  // The parked record must carry the judge's own SCOPE (round-1 P2): the
  // recorder pairs it with the dispatched half, so a replay that lost it would
  // write a different audit pair than a straight record of the same round.
  assert.match(SRC, /concluded\.scope === undefined \? \{\} : \{ scope: concluded\.scope \}/);
});

test("the pass-coverage record cites the tree the lane STARTED on, never the post-run one", () => {
  // Reviewer/auditor finding (2026-09-14): the runner's fingerprint is
  // recomputed AFTER it finished (lint:fix may have edited files) and the code
  // says so itself — writing THAT into a record that never expires would mark a
  // tree no lane ever ran on as verified. The tree captured before the run is
  // the one the lane actually judged.
  const laneAt = SRC.indexOf("function startPrecommitBeside(");
  assert.ok(laneAt > 0, "the lane starter is here");
  // The window covers the whole lane (it grew with the abort path below, and a
  // truncated window does not fail — it silently stops covering the tail).
  const lane = SRC.slice(laneAt, laneAt + 8000);
  assert.match(lane, /const verified = worktreeTree\(root\) \?\? ""/,
    "the pre-run tree is captured before the run (it is also what the FAIL notice names)");
  assert.match(lane, /nextFullPassTree\(\{[\s\S]{0,200}?startedTree: verified,/,
    "and it — not the runner's post-run fingerprint — is what the coverage record cites");
  assert.doesNotMatch(lane, /lastFullPassTree\s*=\s*outcome\.fingerprint/,
    "the post-run fingerprint must never become the record");
  // The rule itself is pure and lives in one place.
  assert.match(SRC, /^\s*invalidateBindings,\n(?:\s*\w+,\n)*\s*nextFullPassTree,\n\} from "\.\.\/lib\/gate-state\.ts";/m,
    "one imported rule, not a second copy of the branches here");
  // AND THE THIRD INPUT: what the lane COVERED has to reach the rule.
  // The first attempt read it off the tool's reply (`pre.details?.testScope`)
  // — a field that reply never carried (reviewer P1, 2026-09-14), so the rule
  // never matched, the record was never written, and every test above stayed
  // green because they all exercised the rule and none exercised this
  // dataflow. It now reads the GATE'S OWN record: `run_precommit` writes
  // `st.precommit.testScope` (the ship gate reads the same field, so it cannot
  // vanish unnoticed) and `test/extension-structure.test.ts`'s precommit
  // section pins that write.
  assert.match(lane, /testScope: laneState\.precommit\.testScope,/,
    "the caller takes what the lane covered from the gate's own record");
  assert.doesNotMatch(lane, /pre\.details\?\.testScope/,
    "and NOT from a reply field nothing else reads — that is exactly how the record went silently unwritten");
});

test("the async FAIL notice never waits for the agent to stop, and names what it verified", () => {
  // MEASURED 2026-09-12 (notification session): `followUp` is drained only when
  // the agent has no more tool calls, and this gate's own loop invariant forbids
  // stopping while a gate is unmet — so three notices queued behind ONE 2.5-hour
  // turn and were delivered at 05:14/05:21/05:24 for failures from 03:01/03:15/
  // 03:23, when the gate's own records already said PASS + READY. The agent read
  // that as the gate contradicting itself and spent ten minutes on forensics.
  const reportAt = SRC.indexOf("function reportAsyncPrecommit(");
  assert.ok(reportAt > 0, "the reporter is here");
  const report = SRC.slice(reportAt, reportAt + 1400);
  assert.match(report, /deliverAs: "steer"/,
    "steer lands at the next tool-batch boundary — a time-sensitive verdict cannot ride the stop-driven queue");
  assert.doesNotMatch(report, /deliverAs: "followUp"/,
    "the follow-up queue is exactly the channel that delayed this notice by hours");
  assert.match(report, /buildAsyncPrecommitReport\(input\)/,
    "the wording lives in lib/ (philosophy one) — the extension only delivers it");

  // Identity is read BEFORE the runner starts: the outcome's own fingerprint is
  // recomputed after it (lint:fix may have edited files), i.e. by then it can
  // already be the NEXT round's content.
  const besideAt = SRC.indexOf("function startPrecommitBeside(");
  // The lane's whole body, bounded by the next declaration rather than by a
  // magic character count: every rule below is about THIS function, and a
  // window that has to grow with the comments fails for the wrong reason
  // (round-2: a comment added INSIDE the lane pushed the notice's own call out
  // of the 6400-character window and turned this red).
  const beside = SRC.slice(besideAt, SRC.indexOf("function reportAsyncPrecommit(", besideAt));
  const verifiedAt = beside.indexOf("const verified = worktreeTree(root)");
  const runAt = beside.indexOf('callTool("run_precommit"');
  assert.ok(verifiedAt > 0 && runAt > verifiedAt,
    "the verified content is captured before the lane runs, not read off its outcome");
  assert.match(beside, /const round = stateForRepo\(root\)\.rounds\.length \+ 1/,
    "and the notice names the round it belongs to, so a late one can be matched");
  assert.match(beside, /current: worktreeTree\(root\) \?\? ""/,
    "the delivery-time content is measured too — that comparison is what downgrades a superseded notice");
});

test("ONE full lane per repo: a second round waits for a quiet lane, and NEVER joins one", () => {
  // Two full suites side by side fight for the same cores and the same cache
  // file. The first version JOINED the running lane — same repo, so "this repo
  // is being verified" — which is true and not enough (round-4 P2): the
  // running lane verifies an EARLIER content, and its PASS would then satisfy
  // the verification binding for a round whose checkpoint holds something
  // else.
  const startAt = SRC.indexOf("async function waitForQuietLane(");
  assert.ok(startAt > 0, "the waiting is its own named act");
  // Same anchor-bounded window as the sibling test above, and for the same
  // reason: the rule is about THIS function, so the window must end where the
  // function does rather than at a byte count that rots.
  const submit = windowIn(SRC, "async function submitForReview(", /\n  (?:async )?function /, "the review chain");
  const waitAt = submit.indexOf("await waitForQuietLane(input.root)");
  const startLaneAt = submit.indexOf("void startPrecommitBeside(input.root, input.ctx)");
  assert.ok(waitAt > 0 && startLaneAt > waitAt,
    "the round waits for the older lane to finish BEFORE starting its own");
  const besideAt = SRC.indexOf("function startPrecommitBeside(");
  // The lane's whole body, bounded by the next declaration instead of a magic
  // character count: every rule below is about THIS function, and a window that
  // has to grow with the comments would fail for the wrong reason.
  const body = SRC.slice(besideAt, SRC.indexOf("function reportAsyncPrecommit(", besideAt));
  assert.doesNotMatch(body, /return running\.settled;/,
    "no joining: a PASS written by someone else's lane is not this round's proof");
  assert.match(body, /if \(inFlightPrecommit\?\.settled === settled\) inFlightPrecommit = undefined;/,
    "and the slot is cleared by the promise that owns it, not by whoever finishes last");
});

// ---------------------------------------------------------------------------
// A SETTLE IS NOT A STOP UNTIL THE GATE IS DONE WITH IT (round-3 P1).
//
// MEASURED: `settledSince` was published at the TOP of `agent_settled` — and
// that very handler may inject the NEXT TURN itself. A loop child about to be
// resumed therefore announced a structurally-proven stop first, and the
// supervisor (which believes that proof instantly, that being its whole point)
// could act on a stop that never happened.
// ---------------------------------------------------------------------------

test("a settle publishes its stop proof only at the exits that MEAN it", () => {
  const start = SRC.indexOf(LOOP_SETTLED);
  assert.ok(start > 0, "the L2 settle handler is the anchor, not the first agent_settled registration");
  // The whole handler: it is long, and the stops it must publish are spread
  // from its top (the empty-problems exit) to its bottom (the stall breaker).
  const body = SRC.slice(start, SRC.indexOf("// ---------- persistence", start));
  const confirmAt = body.indexOf("const confirmStop");
  assert.ok(confirmAt > 0, "the proof has one issuing site, named");
  assert.match(body.slice(confirmAt, confirmAt + 200), /noteChildProgress\("settled"\)/);

  // The TOP clears the stamp and never sets it: nothing below may inherit a
  // previous settle's proof, and nothing here claims a stop before the handler
  // has decided whether to continue.
  const top = body.slice(0, confirmAt);
  assert.doesNotMatch(top, /noteChildProgress\("settled"\)/, "no proof is published before the decision");
  assert.match(top, /noteChildProgress\("tool"\)/, "the top CLEARS it instead");

  // Every exit that decides NOT to continue publishes the proof…
  for (const exit of [
    /if \(state\.taskMode === "explore" \|\| state\.taskMode === "normal"\) \{ confirmStop\(\); return; \}/,
    /if \(state\.pausedQuestion\) \{ confirmStop\(\); return; \}/,
    /if \(!loopArmed\) \{ confirmStop\(\); return; \}/,
    /if \(state\.bypass\.active\) \{ confirmStop\(\); return; \}/,
  ]) {
    assert.match(body, exit, "a settle that continues nothing says so");
  }

  // …and the exits that HAND OVER more work do not. `settleFinishedRounds`
  // can wake this session with a finished round's report, and the two
  // `sendUserMessage` injections below it hand it a next turn outright.
  assert.match(body, /NOT a stop: nothing is published here/,
    "the round-report exit is explicitly not a stop");
  assert.equal((body.match(/confirmStop\(\)/g) ?? []).length, 9,
    "NINE exits publish it — the four 'cannot continue' ones, the ordinary all-gates-satisfied stop, ESC, both exhausted budgets, and the stall breaker. Round-4 P1: the first version wired only the RARE four, so an ordinary child stop (an orchestration child in loop mode reaches the empty-problems exit on nearly every normal stop) fell back to the 120s constant — exactly what this criterion exists to remove");
  // …and the agent that is still working is not a stop either.
  assert.match(body, /\/\/ NOT a stop: the agent is still working, so no proof is published here\.[\s\S]{0,40}?if \(!ctx\.isIdle\(\)\) return;/);
});

test("2026-09-16: the quality round runs BESIDE the reviewer — routing, cancel matrix, precondition", () => {
  // ── 1. ROUTING: inside the ONE submission chain, after prepare ──────────
  const submitAt = SRC.indexOf("async function submitForReview(");
  assert.ok(submitAt > 0, "the submission chain exists");
  const submit = SRC.slice(submitAt, SRC.indexOf("\n  async function ", submitAt + 10));
  // The file list comes off prepare's own numstat (carried on the review
  // target) — never a second `git diff` at dispatch time.
  assert.match(submit, /Array\.isArray\(prepared\.details\?\.files\)/, "the chain takes the changed files from prepare");
  assert.match(submit, /qualityRoundSkip\(changedFiles\)/, "…asks whether this round carries code at all");
  assert.match(submit, /qualityStandingFor\(\{/, "…and whether a pass already stands for this head");
  assert.match(submit, /role: QUALITY_ROLE/, "a code round routes to the QUALITY judge");
  // THE WHOLE POINT OF 2026-09-16: the functional brief travels WITH the
  // quality one, so the two judges start from one submission instead of the
  // reviewer waiting out the whole quality round.
  assert.match(submit, /parallelReviewer: \{/, "the functional brief ships with it — the two judges start together");
  assert.doesNotMatch(SRC, /pendingReviewAfterQuality/, "the serial hold is DELETED, not left beside the parallel path (哲学三)");
  assert.doesNotMatch(SRC, /handOffAfterQuality|handOffQualityIfAny/, "…and so is the second dispatcher it existed for");
  assert.match(submit, /skippedQualityRecord\(\{/, "a code-free round records the skip, never silently");
  assert.match(submit, /if \(skip\.skip\) \{/, "the skip branch is the pure rule's own answer, not a re-derived one");
  assert.doesNotMatch(submit, /isSourceFile\(/, "the file classification is NOT re-implemented in the extension");

  // ── 2. THE TWO SPAWNS: back to back, and never half a round ────────────
  const judgesAt = SRC.indexOf("const judges = [");
  assert.ok(judgesAt > 0, "one loop starts the round's judges");
  // THE END ANCHOR MUST EXIST — AND BE CHECKED (quality round P2, 2026-09-18).
  // It used to be `const child = judgeChildByRole(root, dispatchRole);`, which
  // the parallel-dispatch round deleted: `indexOf` returned -1 and
  // `slice(start, -1)` silently grew this window to the END OF THE FILE (4200
  // lines of "the two spawns, back to back" that were not the two spawns). The
  // assertions happened to keep biting, but the boundary was gone — the exact
  // wrong-window failure this file warns about elsewhere. So: anchor on a
  // statement the block really ends at, and assert it was found.
  const judgesEnd = SRC.indexOf("const routed = accepted.find(", judgesAt);
  assert.ok(judgesEnd > judgesAt,
    "the end anchor is gone — an unchecked indexOf would widen this window to EOF and every assertion below it would read the wrong body");
  const judges = SRC.slice(judgesAt, judgesEnd);
  assert.match(judges, /await dispatchJudgeRound\(\{/, "the dispatch owner is reused, not bypassed");
  // A round never starts HALF: if the quality spawn fails, its error returns
  // before the reviewer is dispatched (a reviewer whose quality half never
  // started could only ever be refused at recording time).
  const failAt = judges.indexOf("if (!d.ok) {");
  const qualityNoteAt = judges.indexOf("noteQualityRoundDispatched(root, d.judgeId)");
  assert.ok(failAt > 0 && qualityNoteAt > failAt, "a failed spawn returns before the next judge is started");
  assert.match(judges, /noteQualityRoundDispatched\(root, d\.judgeId\)/,
    "the round records WHICH quality judge it dispatched — the fact the hold reads");
  // …AND IN EITHER DIRECTION (functional round P2, 2026-09-16): a round whose
  // SECOND judge cannot start must not leave the first one judging a head the
  // agent was told had failed. The distinction is `delivered`, NOT `paneId`
  // (quality round P2, same day): both failure paths keep a pane, but a
  // boot-check timeout delivered the task on the argv while a failed channel
  // write into a REUSED pane delivered nothing.
  assert.match(judges, /if \(d\.delivered !== true\) \{\s*for \(const already of accepted\) \{\s*cancelJudgeRound\(root, already\.role,/,
    "only a round whose task was NOT delivered abandons its siblings");
  assert.doesNotMatch(judges, /if \(!d\.paneId\) \{/, "a kept pane is not the test — the two failures mean opposite things");
  // …and the fact is set by each failure site, never inferred by the caller.
  assert.match(SRC, /delivered: opened\.deliveryFailed === true/, "the boot-check timeout DID deliver the round (the task rode in on argv)");
  assert.match(SRC, /delivered: false, sessionId, sessionDir, paneId: existing\.paneId/, "a failed channel write did NOT");
  // …AND THE DRAFT RECORD FOLLOWS THE SAME FACT (quality round P2, 2026-09-16):
  // `paneId` was still the test one line below the comment explaining why it
  // cannot be — an audited draft would go on record for a task the auditor
  // never received.
  assert.match(SRC, /if \(d\.delivered === true && role === "goal-auditor"\)/, "an undelivered audit draft is never recorded as pending");
  assert.doesNotMatch(SRC, /if \(d\.paneId && role === "goal-auditor"\)/, "…and paneId never returns as that test");

  // ── 3. THE PRECONDITION: dispatch keeps it, RECORDING enforces it ───────
  const dispatchAt = SRC.indexOf("function dispatchJudgeRound(");
  assert.ok(dispatchAt > 0, "the one dispatch owner exists");
  const dispatch = SRC.slice(dispatchAt, dispatchAt + 3000);
  assert.match(
    dispatch,
    /if \(role === "reviewer" && opts\.qualityRoundDispatched !== true\) \{[\s\S]{0,900}?qualityStandingFor\(/,
    "dispatch still refuses a reviewer with no quality standing — except the parallel path, which says so explicitly",
  );
  assert.match(dispatch, /没有登记在案的审查范围/, "…and refuses one with no registered target at all");
  assert.doesNotMatch(dispatch, /judgeChildByRole\(root, QUALITY_ROLE\)/,
    "the permission is NEVER inferred from the registry: the quality pane is reused and outlives its verdict, so that test would be always true",
  );
  // THE PARALLEL PATH IS THE ONLY CALLER that may pass it.
  assert.equal((SRC.match(/qualityRoundDispatched:\s*true/g) ?? []).length, 1,
    "exactly one call site grants it");
  const recordAt = SRC.indexOf("async function recordReviewVerdict(");
  assert.ok(recordAt > 0, "the recorder exists");
  const record = SRC.slice(recordAt, SRC.indexOf("    st.review = {", recordAt));
  assert.match(record, /decideQualityHold\(\{/, "the READY is answered against the quality standing at RECORD time");
  assert.match(record, /qualityRoundInFlight: qualityRoundInFlight\(targetRoot\)/,
    "…with THIS round's dispatched judge as the in-flight fact");
  assert.match(record, /if \(qualityHold === "refuse"\) \{[\s\S]{0,120}?parsed\.verdict = "BLOCKED";/,
    "nobody coming back ⇒ REFUSE (fail-closed)");
  assert.match(record, /qualityHold === "hold"/, "…somebody coming back ⇒ HOLD, never record yet");
  // ── 3b. A ROUND IS NOT A CONCLUSION WITHOUT ITS QUALITY HALF ────────────
  // A recorded verdict carries the reviewed COMMIT so the next prepare can
  // baseline from it. A round whose quality half never concluded has no
  // conclusion to carry: recording its head there moved the next round's
  // BASELINE onto it, and THIS round's content then entered no quality range
  // at all — a dead pane was enough to walk unreviewed code past the quality
  // gate.
  // …AND IT MUST CARRY THE PREVIOUS CONCLUSION FORWARD rather than drop the
  // field: `st.review` is replaced wholesale, so an absent commitSha would
  // erase that too and rebase the next round on the BRANCH BASE (reviewer P2,
  // same day — the whole-branch re-review a wrong first fix produces).
  // THE PREDICATE IS THE STANDING, NOT A LIST OF CASES (quality round P1,
  // 2026-09-17): special-casing the recorder's own `refuse` left the OTHER door
  // to the same state open — a non-READY functional verdict, whose row in the
  // cancel matrix kills the quality round. One reading answers both.
  const concludedAt = SRC.indexOf("const qualityHalfConcluded = ", recordAt);
  assert.ok(concludedAt > 0, "the commit the baseline stops at is decided in one place");
  const concluded = SRC.slice(concludedAt, SRC.indexOf('if (parsed.verdict === "READY")', concludedAt));
  assert.match(concluded, /qualityStandingFor\(\{/,
    "the baseline advances only when a quality conclusion STANDS for this head");
  assert.match(concluded, /\?\? st\.review\.commitSha/,
    "the last CONCLUDED commit is carried forward — a round with no quality half must not move the baseline");
  assert.doesNotMatch(concluded, /qualityHold === "refuse"/,
    "`refuse` is one way to fail that test, not a branch of its own");
  assert.match(concluded, /commitSha: concludedCommit/);
  // The in-flight predicate reads the ROUND's own record, and needs a LIVE
  // pane: a judge that died can never land a verdict, so a hold there would be
  // forever.
  const inFlightAt = SRC.indexOf("function qualityRoundInFlight(");
  assert.ok(inFlightAt > 0, "the in-flight predicate exists");
  const inFlight = SRC.slice(inFlightAt, inFlightAt + 1400);
  assert.match(inFlight, /reviewTargets\.get\(root\)/, "the ROUND's own record makes it this round's judge");
  assert.match(inFlight, /ownLiveJudges\(\)/, "…a live pane is what makes the verdict still possible");
  assert.match(inFlight, /quality\?\.commitSha === target\.head && !isSkippedQualityRecord\(quality\)/,
    "once a JUDGE's verdict stands for this head, nothing is owed — a SKIP record is not one (functional P1, 2026-09-22: a skip bound here read as concluded while its quality judge was still running, so the functional READY was refused into BLOCKED and the cancel matrix killed that live pane)");
  // …and the round records that judge only after the spawn was ACCEPTED.
  const noteAt = SRC.indexOf("function noteQualityRoundDispatched(");
  const note = SRC.slice(noteAt, noteAt + 500);
  assert.match(note, /target\.qualityRound = \{ judgeId, head: target\.head \}/, "the round owns the pair (judge, head)");

  // ── 4. THE CANCEL MATRIX: applied on the settle path, from ONE decision ──
  const applyAt = SRC.indexOf("async function applyRoundCancel(");
  assert.ok(applyAt > 0, "one place applies the matrix");
  const apply = SRC.slice(applyAt, SRC.indexOf("\n  /**", applyAt));
  assert.match(apply, /const party = roundCancelParty\(kind\)/, "the audit KIND is translated, never compared to a role (functional round P1, 2026-09-16: `kind === \"reviewer\"` was dead — the kind is `review`)");
  assert.doesNotMatch(apply, /kind === "reviewer"/, "the unreachable comparison may not come back");
  assert.match(apply, /roundCancelPlan\(landing\)/, "the decision comes from the pure table, not from branches here");
  assert.match(apply, /verdict: st\.quality\?\.verdict \?\? ""[\s\S]{0,120}?: \{ party, verdict: st\.review\.verdict, held: reviewVerdictIsParked\(root\) \}/,
    "…and it reads the RECORDED verdict, never the word a judge printed");
  // A PARKED CONCLUSION REACHES THE TABLE AS `held` (quality round P0,
  // 2026-09-16): a held round leaves `st.review` at PENDING, and without this
  // fact the matrix read that as a non-READY verdict and cancelled the quality
  // round the hold was waiting for.
  assert.match(apply, /held: reviewVerdictIsParked\(root\)/, "the parked fact is part of the decision");
  const parkedAt = SRC.indexOf("function reviewVerdictIsParked(");
  assert.ok(parkedAt > 0, "the parked predicate exists");
  const parked = SRC.slice(parkedAt, parkedAt + 900);
  assert.match(parked, /st\.pendingReady\.tree === target\.tree/,
    "matched to THIS round by tree — a leftover record from an earlier round must not excuse a real non-READY verdict");
  assert.match(apply, /applyCancelPlan\(/, "the effect comes from the ONE applier");
  // The LANE goes through the same table and the same applier — INCLUDING its
  // PASS case, which the table answers with "nothing" (quality round P1,
  // 2026-09-16: a hand-written `if (verdict !== "PASS")` at the landing was
  // the lane's row implemented a second time).
  assert.match(SRC, /applyCancelPlan\(roundCancelPlan\(\{ party: "lane", verdict \}\), root\)/,
    "the lane's row is the table's, not a branch beside it");
  const applierAt = SRC.indexOf("function applyCancelPlan(");
  const applier = SRC.slice(applierAt, SRC.indexOf("async function applyRoundCancel(", applierAt));
  assert.match(applier, /plan\.cancelReviewer[\s\S]{0,200}?cancelJudgeRound\(root, "reviewer"/, "a plan's reviewer row terminates the pane");
  assert.match(applier, /plan\.cancelQuality[\s\S]{0,200}?cancelJudgeRound\(root, QUALITY_ROLE/, "…and its quality row does too");
  assert.match(applier, /plan\.abortLane[\s\S]{0,200}?abortPrecommitLane\(root,/, "…and its lane row aborts the lane");
  // The hand-written lane copy may not come back.
  assert.doesNotMatch(SRC, /if \(verdict !== "PASS"\) \{\s*cancelJudgeRound\(root, "reviewer"/,
    "the lane's row lives in the table alone");
  assert.match(apply, /await resumeParkedReady\(root, ctx\)/, "every landing re-asks any parked conclusion");
  // BOTH record paths apply it, through the one wrapper (reviewer P1,
  // 2026-09-15: wired into the sweep alone, a round closed by a `judge_wait`
  // never stopped anything).
  assert.equal((SRC.match(/await applyRoundCancel\(settled\.kind,/g) ?? []).length, 2,
    "the settle sweep AND judge_wait's settleRound both apply it");
  assert.doesNotMatch(SRC, /settled\.kind === "quality" \? await/, "no second copy of the kind test");
  // THE KILL IS REAL (user requirement): closing the pane is the existing
  // close path, and dropping the row is what keeps the watchdog from
  // announcing the cancelled round as a judge that DIED.
  const cancelAt = SRC.indexOf("function cancelJudgeRound(");
  const cancel = SRC.slice(cancelAt, cancelAt + 2000);
  assert.match(cancel, /closeJudgePaneOf\(entry, \{/, "the pane's process is terminated through the one close path");
  assert.match(cancel, /setHierarchy\(removeJudge\(judgeHierarchy, entry\.judgeId\)\)/,
    "…and the registry row goes, so the death is never announced and `judge_recover` cannot revive it");
  assert.match(cancel, /absorbJudgeModelEvents\(root, entry\.judgeId\)/, "model events are absorbed BEFORE the row (and its cursors) goes");
  assert.match(cancel, /reapReviewScratch\(entry\.judgeId\)/, "its throwaway worktrees are reclaimed by whoever created them");
  // The lane's row of the matrix is applied at the lane's own landing, through
  // the table (see the applier assertions above) — and the hand-off note still
  // travels as its OWN field: the standard report prints the recorded note
  // first-line-only, so a note appended there is invisible to the one reader it
  // exists for.
  assert.match(SRC, /handOffNote: conclusion\.handOffNote,/, "the settle sweep prints it");

  // ── 5. THE LANE ABORT: a stopped lane is not a result ──────────────────
  const laneAt = SRC.indexOf("function startPrecommitBeside(");
  // Wide enough to reach the failure notice at the END of the lane — a
  // truncated window does not fail, it silently stops covering the tail.
  const lane = SRC.slice(laneAt, laneAt + 12000);
  assert.match(lane, /new AbortController\(\)/, "the lane owns a kill switch");
  assert.match(lane, /undefined, controller\.signal\)/, "…and hands it to the runner (AbortSignal reaches the process)");
  assert.match(lane, /if \(controller\.signal\.aborted\) \{/, "an aborted lane is recognized before anything is recorded");
  // The REVOCATION is the wholesale replacement: the fresh object carries no
  // `lastFullPassTree` / `testScope` / PASS fingerprint. A separate `delete`
  // after it was dead code against the object just built (reviewer Nit,
  // 2026-09-15), so this asserts the SHAPE that actually does the work.
  assert.match(
    lane.slice(lane.indexOf("if (controller.signal.aborted) {")),
    /st\.precommit = \{ verdict: "NOT_RUN", fingerprint: null,[^}]*\};/,
    "nothing may ship on the aborted lane's content",
  );
  assert.doesNotMatch(lane, /delete st\.precommit\.lastFullPassTree;/, "no dead delete behind the replacement");
  // It returns BEFORE the failure notice: a FAIL nobody ran would be blamed on
  // a change that was never verified (the user's rule: a quality failure ends
  // precommit, it does not turn it into a failure).
  const abortedAt = lane.indexOf("if (controller.signal.aborted) {");
  const noticeAt = lane.indexOf("reportAsyncPrecommit({");
  assert.ok(abortedAt > 0, "the abort branch is inside the lane");
  assert.ok(noticeAt > abortedAt, "the abort branch precedes the failure notice");
  assert.match(lane.slice(abortedAt, noticeAt), /return;/, "…and returns, so no FAIL is reported");
});

// ---------------------------------------------------------------------------
// NOTHING DOWNGRADES AN ORCHESTRATION TO LOOP (2026-09-18)
//
// The tempting fix for "the orchestration is finished and nobody can publish"
// — the manager may not ship (constraint 2), its children of a multi-task repo
// are capped at `commit` — is to let the manager drop into loop mode and
// finish the delivery itself. The USER REFUSED it: the fix is a finish TASK in
// the plan (lib/orchestrator-directives.ts, lib/repo-pr-policy.ts). This scan
// keeps the refused version from arriving later as a convenience.
//
// What the gate DOES do on its own is place a session in `normal` (headless,
// non-git) and honour a mode a SPAWNER asked for — neither is `loop`, and a
// relay successor inherits the orchestrator's ROLE rather than being demoted to
// a loop session (pinned behaviourally in test/session-handoff-tools.test.ts).
test("nothing writes the loop mode by itself — the plan's finish task delivers", () => {
  const files = ["extensions", "lib"].flatMap((dir) =>
    readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f)));
  assert.ok(files.length > 50, `the scan must actually walk the source (saw ${files.length} files)`);
  const autoLoop = files.filter((rel) => /setTaskMode\(\s*["']loop["']/.test(readFileSync(join(ROOT, rel), "utf8")));
  assert.deepEqual(autoLoop, [],
    "no path may write `loop` on its own: an orchestration ends through its plan's finish task, not through a mode change");
});

// ---------------------------------------------------------------------------
// The reason box has TWO ways out (user decision, 2026-09-19)
//
// ESC in the `✎ …` box hands the question BACK to its own list — carrying the
// half-written reason, so backing out costs nothing — while the LIST's ESC
// stays what closes the question (and, in an interview, stops the rest). Both
// halves meet in one wiring (`reasonBoxUi`'s `build`), and that wiring is not
// reachable from a lib/ unit test: the lib tests drive the seam with a fake
// component, so nothing there would notice the extension dropping the sentinel
// or the prefill.
test("the reason box is wired for BOTH ways out", () => {
  assert.match(SRC, /REASON_EDITOR_BACK/,
    "the extension knows the sentinel that means 'back to the list'");
  assert.match(SRC, /done\(`\$\{REASON_EDITOR_BACK\}\$\{editorTextOf\(component\)\}`\)/,
    "and cancelling the box carries the text typed so far back with it");
  assert.match(SRC, /prefill,/, "the box opens with the text the user came back with");
});

test("the row-position rule has ONE implementation — the channel parser imports it", () => {
  // Quality round P2 (2026-09-19, both the letter and the digit half): the
  // pane's `parseChoice` and the channel's `resolveAnswer` read `A` and `1`
  // through the same two regexes, written twice. Two copies of one rule drift
  // apart the first time one of them is touched.
  const answerTools = readFileSync(join(ROOT, "lib", "orchestrator-answer-tools.ts"), "utf8");
  assert.doesNotMatch(answerTools, /charCodeAt\(0\) - 65/,
    "the letter index is computed in lib/choice-dialog.ts (`rowIndexOf`) and imported, never re-derived");
  assert.doesNotMatch(answerTools, /Number\(text\) - 1/,
    "and so is the 1-based index — the same function reads both shorthands");
  assert.match(answerTools, /rowIndexOf\(/, "…and that is what this parser resolves a position with (one shared reader, called once per token)");
});

// ─────────────────────────────────────────────────────────────────────────────
// DRILL F1–F4 (2026-09-20) — the defects the real-session drill measured.
// ─────────────────────────────────────────────────────────────────────────────

test("F1: arming and its reconciliation ask the SAME question, of both facts", () => {
  // The fail-open (drill F1): arming had two sources — a dirty code/doc file,
  // and commits ahead of the base — and the reconciliation at `turn_end` read
  // only the first. One untracked non-code file (the seeded `node_modules`
  // symlink) cleared `hasCodeChange` while eight unreviewed commits sat on the
  // branch, and the ship gate let everything through.
  assert.match(
    SRC,
    /import \{ armingFromFacts, couldReconcile, reconcileArming \} from "\.\.\/lib\/gate-arming\.ts"/,
    "the rule lives in lib/gate-arming.ts and both sites import it — 哲学三: no second copy",
  );

  const armAt = SRC.indexOf("const armed = armingFromFacts({");
  assert.ok(armAt > 0, "the ARMING sites ask the shared rule");
  assert.equal(
    SRC.match(/armingFromFacts\(/g)?.length,
    3,
    "three arming sites (session_start, the git re-arm, a secondary repo) — one rule, one implementation",
  );
  assert.equal(
    SRC.match(/commitsAhead: state\.scopeLimit \? 0 : await commitsAheadOfBase\(cwd\)/g)?.length,
    2,
    "…and the branch-commit fact is read at the two sites that can see it: arm and reconcile",
  );

  const turnEnd = windowOf('pi.on("turn_end", async (_event, ctx) => {', "\n  });", "turn_end handler");
  assert.match(turnEnd, /reconcileArming\(current, \{/, "the reconciliation asks the same rule");
  assert.match(
    turnEnd,
    /commitsAhead: state\.scopeLimit \? 0 : await commitsAheadOfBase\(cwd\)/,
    "…and pays for the git call the old kind-only clearing never made",
  );
  assert.match(turnEnd, /couldReconcile\(current, files\)/, "…skipped when nothing could be cleared");
  assert.match(
    turnEnd,
    /for \(const root of sessionRepos\) \{\n      if \(root === primaryRepoRoot\) continue;/,
    "…and every OTHER repo the session worked in is reconciled by the same rule (quality round 2 P2): a secondary repo's flags had no clearing path at all",
  );
  assert.match(turnEnd, /reconcileArming\(repoCurrent, \{/, "…with the same two facts");
  assert.doesNotMatch(
    turnEnd,
    /!files\.some\(isCodeFile\)/,
    "the file-kind-only clearing is GONE — that is the line that disarmed the branch",
  );
  // The two RE-ARM sites (a git command restoring dirty state, a secondary
  // repo's first sidecar) took the same function, so no site composes the rule
  // out of file kinds any more — that composition was the drift F1 exploited.
  assert.doesNotMatch(SRC, /some\(isCodeFile\)/, "no site decides arming from file kinds itself");
  assert.doesNotMatch(SRC, /some\(isDocFile\)/, "…nor for the doc half");
  // The secondary-repo site is a SYNCHRONOUS state factory, and it needs the
  // branch fact too (review round 1 P1): a repo whose only work is already
  // committed must not read as "nothing to review" to ITS ship gate.
  assert.match(
    SRC,
    /armingFromFacts\(\{ files: files \?\? \[\], commitsAhead: commitsAheadOfBaseSync\(root\) \}\)/,
    "the secondary-repo arming supplies the branch-ahead fact, not a hard-coded 0",
  );
  assert.equal(
    SRC.match(/"rev-list", "--count"/g)?.length,
    3,
    "'how far ahead is this branch' has ONE implementation — the async dep seam wraps the sync one",
  );
  assert.match(
    SRC,
    /async function commitsAheadOfBase\(cwd: string\): Promise<number> \{\n  return commitsAheadOfBaseSync\(cwd\);\n\}/,
    "…and that wrapper only delegates",
  );
  assert.equal(
    SRC.match(/armingFromFacts\(/g)?.length,
    3,
    "three arming sites plus this file's import — one rule, one implementation",
  );
});

test("F3: the checkpoint commits this session's own files, and NAMES what it leaves", () => {
  const body = windowOf('name: "review_checkpoint"', "\n  });", "review_checkpoint tool");
  assert.match(body, /"ls-files", "--others", "--exclude-standard", "-z"/,
    "the untracked set comes from git in its RAW path form");
  assert.match(body, /planCheckpointSweep\(\{ untracked, own: st\.sessionEditedFiles \?\? \[\] \}\)/,
    "…and the split is the pure rule in lib/checkpoint-sweep.ts");
  assert.match(body, /"reset", "-q", "--", \.\.\.leftOut/,
    "`add -A` still sweeps the tracked half; the leftovers are UNSTAGED again");
  assert.doesNotMatch(body, /\["add", "-A"\] \}?, \{ cwd: root, encoding: "utf8" \}\);\n\s+execFileSync\("git", \["commit"/,
    "nothing commits straight after the bare sweep any more");
  assert.match(body, /"diff-tree", "-r", "--no-commit-id", "--name-only", "-z", "--root", sha/,
    "the receipt's file list is read FROM THE COMMIT, not from the worktree (drill F4)");
  assert.match(body, /未提交（\$\{leftOut\.length\}）/, "…and the leftovers are named, not silently dropped");
  assert.match(body, /files: sweptIn, leftOut/, "both lists travel in `details`, for the round receipt");
});

test("F3: every path the edit tools wrote is recorded, code or not", () => {
  // The checkpoint can only recognise the session's OWN new files if the
  // recording covers them: a `.json` fixture or a `.yaml` config is as much
  // this round's work as a `.ts` file, and extension-based classification left
  // it looking like a stranger's file.
  assert.match(
    SRC,
    /EVERY PATH THIS SESSION WROTE IS RECORDED, code\/doc or not/,
    "the rule says what it is for",
  );
  const at = SRC.indexOf("const rel = repoRelative(path);\n      sessionEditedPaths.add(rel);");
  assert.ok(at > 0, "recording happens for every edit, before the code/doc branch");
  const before = SRC.slice(Math.max(0, at - 900), at);
  assert.match(before, /if \(isCodeFile\(path\) && !state\.hasCodeChange\)/, "…after the ARMED flags, which stay code/doc-only");
  const after = SRC.slice(at, at + 500);
  assert.doesNotMatch(
    after.slice(0, after.indexOf("sessionEditedPaths.add(rel)")),
    /isCodeFile\(path\) \|\| isDocFile\(path\)\) \{/,
    "the recording itself is not behind a file-kind test",
  );
  // …and the SAME is true of a SECONDARY repo (review round 1 P1): its new
  // `.json`/`.yaml` files were recorded only when they were project files.
  const otherRepo = SRC.slice(
    SRC.indexOf('if (editScope.scope === "other-repo")'),
    SRC.indexOf("// P-multi: an edit in the PRIMARY repo makes it the active repo again"),
  );
  assert.ok(otherRepo.length > 0, "the other-repo branch exists");
  assert.ok(
    otherRepo.indexOf("s.sessionEditedFiles.push(rel)") < otherRepo.lastIndexOf("if (isProjectFile) {"),
    "a secondary repo records EVERY path this session wrote, not only its project files",
  );
  assert.ok(
    otherRepo.indexOf("sessionRepos.add(otherRepo)") < otherRepo.indexOf("if (isProjectFile) {"),
    "…and the REPO SET follows the recording (review round 2 P1): a repo this session wrote into belongs in declare_done's coverage even when the file is not a project file",
  );
  // RECORDED IN THE FORM GIT ANSWERS IN (review round 1 P1): `cwd`-relative
  // paths matched nothing, so a session started in a subdirectory left its own
  // new file out of its own checkpoint — and an in-repo file outside that cwd
  // was recorded absolute, which `lib/out-of-repo-paths.ts` reads as a
  // violation.
  assert.match(
    SRC,
    /return abs\.startsWith\(primaryRepoRoot \+ "\/"\) \? abs\.slice\(primaryRepoRoot\.length \+ 1\) : abs;/,
    "recorded paths are REPO-root-relative, never cwd-relative",
  );
});

test("F4: the round's receipt names the checkpoint and the files in it", () => {
  assert.match(
    SRC,
    /checkpoint\?: \{ sha: string; files: string\[\]; leftOut: string\[\] \}/,
    "the chain carries the checkpoint facts out to the caller",
  );
  assert.match(SRC, /checkpointFacts = chain\.checkpoint;/, "…the caller keeps them");
  const receiptAt = SRC.indexOf("const routed = accepted.find((a) => a.role === dispatchRole)");
  assert.ok(receiptAt > 0, "the receipt exists");
  const receipt = SRC.slice(receiptAt, receiptAt + 5000);
  assert.match(receipt, /- checkpoint \$\{checkpointFacts\.sha\.slice\(0, 12\)\} 已冻结/, "the commit is named on the receipt");
  assert.match(receipt, /未提交（\$\{checkpointFacts\.leftOut\.length\}）/, "and so is what stayed out of it");
  assert.match(
    SRC,
    /\.\.\.\(checkpointFacts === undefined \? \{\} : \{ checkpoint: checkpointFacts \}\)/,
    "…and it is in `details` too, not only in prose",
  );
});

test("the arming rule itself exists ONCE — the reconciliation calls it, never re-spells it", () => {
  // Quality round 2 P2: the whole point of the module is that the rule cannot
  // drift, so a second copy of its two expressions inside `reconcileArming`
  // (they were there) is the same defect one level down.
  const arming = readFileSync(join(ROOT, "lib", "gate-arming.ts"), "utf8");
  const reconcile = arming.slice(
    arming.indexOf("export function reconcileArming"),
    arming.indexOf("export function couldReconcile"),
  );
  assert.ok(reconcile.length > 0, "the reconciliation is in this module");
  assert.doesNotMatch(
    reconcile,
    /files\.some\(/,
    "…and it re-spells neither expression — that copy was the finding",
  );
  assert.match(reconcile, /: armingFromFacts\(facts\);/, "the non-empty branch CALLS the rule");
  // The two `files.some(isCodeFile/isDocFile)` expressions that remain are the
  // rule's own definition and `couldReconcile`'s cheap guard — different
  // questions with the same input, not a second copy of the rule.
  assert.equal(arming.match(/files\.some\(isCodeFile\)/g)?.length, 2, "the code-file test is not scattered");
});

test("F2: the seeder re-checks gitignore in the DESTINATION, and tells the truth when it cannot", () => {
  const seed = readFileSync(join(ROOT, "lib", "worktree-seed.ts"), "utf8");
  assert.match(seed, /ignoreVerdict\(worktreeRoot, action\.path\) === "not-ignored"/,
    "the destination answers, not the source checkout that was asked at plan time");
  assert.match(seed, /export function ignoreVerdict\(/, "…through the three-way verdict, so `not ignored` and `could not ask` stay different");
  assert.match(seed, /rmQuietly\(to\);/, "a path the destination does not ignore is removed again");
  assert.match(seed, /没有带过去/, "…and the receipt says so");
});

test("editing ANY project file un-finishes the task — completion does not survive a .json edit (2026-09-22)", () => {
  // The completion record is what the survival invariant reads (lib/session-revival.ts)
  // AND what a supervising orchestrator reads to call a child `done`. It used to be
  // deleted only inside the code/doc branch, so a `.json`/`.yaml` edit after
  // `declare_done` stranded the session: the invariant stayed silent (nothing had
  // un-finished it) while the ship gate kept blocking on the moved fingerprint.
  const primaryBook = SRC.indexOf(
    "if (!state.sessionEditedFiles.includes(rel)) { state.sessionEditedFiles.push(rel); dirty = true; }");
  const primaryDelete = SRC.indexOf("if (state.completion) { delete state.completion; dirty = true; }", primaryBook);
  const primaryBranch = SRC.indexOf("if (isCodeFile(path) || isDocFile(path)) {", primaryBook);
  assert.ok(primaryBook > 0 && primaryBranch > primaryBook, "the primary edit branch exists");
  assert.ok(primaryDelete > primaryBook && primaryDelete < primaryBranch,
    "the deletion sits between the bookkeeping and the code/doc gate — outside it");

  const crossBook = SRC.indexOf(
    "if (!s.sessionEditedFiles.includes(rel)) { s.sessionEditedFiles.push(rel); dirty = true; }");
  const crossDelete = SRC.indexOf("if (state.completion) { delete state.completion; sessionUnfinished = true; }", crossBook);
  const crossBranch = SRC.indexOf("if (isProjectFile) {", crossBook);
  assert.ok(crossBook > 0 && crossBranch > crossBook, "the cross-repo edit branch exists");
  assert.ok(crossDelete > crossBook && crossDelete < crossBranch,
    "…and it clears the SESSION's record — `declare_done` writes completion on the PRIMARY state " +
      "only, so clearing a per-repo one left the session looking finished while this repo's " +
      "bindings had just been invalidated (quality round P1, 2026-09-22)");
  assert.match(SRC.slice(crossDelete, crossDelete + 1600), /if \(sessionUnfinished\) persist\(ctx/,
    "…and the PRIMARY sidecar is written, or a restart would resurrect the record");

  // WHAT DID NOT CHANGE: the ARMING is still code/doc-only ("is there anything to
  // review?" is a different question, and its answer did not change).
  assert.match(SRC.slice(primaryBranch, primaryBranch + 1200), /armLoop\(\)/);
  assert.match(SRC.slice(crossBranch, crossBranch + 800), /armLoop\(\)/);
});

test("the acceptance round is armed from declare_done, on the EXISTING engine, and never ships (2026-09-22)", () => {
  const code = codeOnly(SRC);
  // 1. THE TRIGGER is completion, under LOOP semantics — and an UNDECIDED
  // session runs those too (real-session P1, 2026-09-22): the first version
  // asked `state.taskMode === "loop"` in so many words, which matched nothing
  // for a session whose agent never called `set_gate_mode`, and released the
  // round SILENTLY (no dispatch, no SKIPPED note). `lib/task-mode.ts` owns the
  // answer — `isEnforcedMode` — and says why callers must ask it instead of
  // comparing to "loop".
  assert.match(
    code,
    /if \(isEnforcedMode\(state\.taskMode\) && !orchestratorMode\) \{\s*progress\.step\("真实验收"\);\s*const acceptance = await armAcceptanceRound\(ctx, progress, acceptanceNotes\);/,
    "the step is wired into declare_done's own body, for loop semantics (undecided included)",
  );
  // …AND THE MODE IS NOT RE-DERIVED HERE — a second spelling of “is this the
  // loop?” is exactly how the two answers drifted apart and released the round.
  const acceptanceStep = windowOf(
    "const acceptanceNotes: string[] = [];",
    'progress.done("全部满足")',
    "declare_done 的验收步骤",
  );
  assert.doesNotMatch(
    acceptanceStep,
    /taskMode\s*===\s*"loop"/,
    "the loop question has ONE home: isEnforcedMode",
  );
  assert.match(code, /acceptanceDecision\(\{/, "the decision comes from the module, not from a branch here");
  // 2. ONE ROUND ENGINE (哲学三): the dispatch goes through dispatchJudgeRound
  // and the round closes through the settle engine's recorder seam — neither is
  // re-implemented for this round.
  const dispatch = windowOf("async function dispatchAcceptanceRound", "\n  /**", "dispatchAcceptanceRound");
  assert.match(dispatch, /dispatchJudgeRound\(\{/);
  assert.match(dispatch, /role: "acceptance",/);
  assert.doesNotMatch(dispatch, /openSessionPane|runTmux\(|appendRecord\(/,
    "a second pane/dispatch path is exactly what the third philosophy forbids");
  assert.match(SRC, /recordAcceptance: async \(\{ root, concluded \}\) =>/, "the recorder is wired beside recordQuality's");
  const arm = windowOf("async function armAcceptanceRound", "\n  /**", "armAcceptanceRound");
  assert.match(arm, /for \(const root of \[\.\.\.sessionRepos\]\)/,
    "PER REPO (2026-09-22): every repo this session edited is walked, not just the primary");
  assert.match(arm, /await acceptanceStepForRepo\(ctx, root, progress, notes\)/);
  assert.match(arm, /const judgeId = results\.find/, "one refusal carries every repo's outcome");
  const step = windowOf("async function acceptanceStepForRepo", "\n  // ---------- declare_done tool", "acceptanceStepForRepo");
  assert.match(step, /acceptanceProblems\(decision\)/, "what blocks is the module's projection, not a second reading");
  assert.match(step, /dispatchAcceptanceRound\(ctx, root, fingerprint, goalText \?\? ""\)/,
    "the goal text is handed to the dispatch (one read for both halves, 2026-09-22) — dispatched in ITS repo");
  assert.match(step, /const st = stateForRepo\(root\)/, "each repo's OWN state, never the primary's");
  assert.doesNotMatch(step, /primaryRepoRoot/,
    "nothing in the per-repo step may fall back to the primary repo (that is the bug it fixes)");
  assert.match(step, /hasPlan: false/, "no approved acceptance plan ⇒ SKIP, never a plan-less dispatch");
  // 4c. THE AGGREGATE REFUSAL HAS TO BE USABLE (reviewer + quality round P2,
  //     2026-09-22): `judge_wait` refuses to guess the repo once a session has
  //     edited more than one (lib/repo-resolve.ts), and an armed repo beside a
  //     blocking one means both must be settled before completion.
  assert.match(arm, /const waitLine = \(rows: typeof armedRows\)/,
    "the wait copy is composed from which repos actually ARMED");
  assert.match(arm, /repo:\$\{JSON\.stringify\(r\.root\)\}/, "…and names that repo");
  assert.match(arm, /不会因为验收 READY 而消失/,
    "…and says the other repo's blocking problem survives the acceptance READY");
  // 4b. THE PLAN IS READ FROM THE WHOLE FILE, NEVER FROM THE PROMPT COPY
  //     (real-session P1, 2026-09-22): `goal.text` is capped at
  //     LOOP_GOAL_MAX_CHARS for prompt injection, and the acceptance plan is
  //     the skeleton's LAST section — measured on the round that found this, a
  //     3130-character goal put「真实验收方案」at offset 2164, so the capped copy
  //     ended before it, the plan read as absent, and a SIZE LIMIT silently
  //     released the stricter gate.
  const goalTextRead = windowOf("function acceptanceGoalText", "\n  /**", "acceptanceGoalText");
  assert.match(goalTextRead, /readFileSync\(loopGoalPathIn\(root\), "utf8"\)/,
    "the approved file is read whole; the capped prompt copy cannot carry the plan");
  // 5. A SKIP THE USER HAS TO ACT ON IS NOT LEFT IN THE SIDECAR (quality round
  //    P2, 2026-09-22): the reason rides into the completion reply, and the
  //    status command renders the record. The other two skips stay quiet —
  //    they are the design's steady state.
  assert.match(step, /notes\.push\(skippedReason\)/);
  assert.match(SRC, /acceptanceNotes\.length \?/, "the reason reaches the outcome the human reads");
  const statusCmd = readFileSync(join(ROOT, "lib", "gate-command-tools.ts"), "utf8");
  assert.match(statusCmd, /acceptanceStatusLine\(state\.acceptance\)/, "…and /gate-status renders the record");
  // 3. NEVER IN THE SHIP AUTHORITY: fixing an acceptance finding requires a
  // commit, so a requirement in `unmetRequirements` would block its own remedy.
  const unmet = GATE_STATE_SRC.slice(GATE_STATE_SRC.indexOf("export function unmetRequirements("));
  const unmetBody = unmet.slice(0, unmet.indexOf("\nexport function", 10));
  assert.ok(unmetBody.length > 0, "the ship authority is in gate-state.ts");
  assert.doesNotMatch(unmetBody, /acceptance/i, "the acceptance round answers completion, never shipping");
  // 4. A SECOND declare_done MUST REACH THE WAIT BRANCH (reviewer P1,
  //    2026-09-22). The cascade-close that abandons unrecorded rounds must not
  //    reclaim the pane the gate is ITSELF waiting on: closing it first made
  //    `acceptanceRoundAlive` answer false, and the module's own
  //    `roundAlive === false` rule then dispatched a second round on top of a
  //    working judge — the first one killed and paid for twice.
  const cascade = windowOf(
    "const ownedJudges = ownJudges()",
    "progress.step(`联关",
    "acceptance cascade-close",
  );
  assert.match(
    cascade,
    /child\.role === "acceptance" && acceptanceRoundInFlight\(stateForRepo\(child\.repoRoot\)\.acceptance\)/,
    "an IN-FLIGHT acceptance round is filtered out of the cascade-close",
  );
  // ..and the reading itself stays in the module (哲学二): a literal
  // `status === "AWAITING"` here would be a second answer to one question.
  const acceptanceSrc = readFileSync(join(ROOT, "lib", "acceptance-round.ts"), "utf8");
  assert.match(acceptanceSrc, /export function acceptanceRoundInFlight\(/);
  assert.doesNotMatch(
    code,
    /acceptance\?\.status === "AWAITING"/,
    "the extension asks the module, never the raw status",
  );
});
