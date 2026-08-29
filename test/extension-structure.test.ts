import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "extensions", "review-gate.ts"), "utf8");

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
  // this session" hint and force consent for a later mode change.
  const toolCallAt = SRC.indexOf('pi.on("tool_call"');
  const callSkipAt = SRC.indexOf("isGateOwnedPath(abs", toolCallAt);
  const sessionEditAt = SRC.indexOf("sessionEdited = true", toolCallAt);
  assert.ok(toolCallAt > 0 && callSkipAt > 0 && sessionEditAt > 0, "tool_call must apply the same skip");
  assert.ok(callSkipAt < sessionEditAt, "the skip must precede the session-edit attribution");
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

test("L2 STALL BREAKER: a running subagent counts as motion (never orphan a live review)", () => {
  // Without this, the breaker trips on the loop's OWN review: while an async
  // reviewer runs, the fingerprint, both verdicts, the round count and the
  // unmet list are all necessarily unchanged.
  const start = SRC.indexOf('pi.on("agent_settled"');
  const breakerAt = SRC.indexOf("evaluateStall(", start);
  const injectAt = SRC.indexOf("REVIEW_GATE_RESUME", start);
  const call = SRC.slice(breakerAt, injectAt);
  assert.match(call, /inMotion:\s*subagentInMotion\(\)\s*\|\|\s*judgeChildInMotion\(\)/,
    "the breaker must be told about work in flight (subagents OR tmux judge children)");
  // The motion probe must be bounded in age, or a hung run would disable the
  // breaker permanently — the exact failure it exists to catch.
  const probeAt = SRC.indexOf("function subagentInMotion(");
  assert.ok(probeAt > 0, "subagentInMotion must exist");
  const probe = SRC.slice(probeAt, probeAt + 900);
  assert.match(probe, /STALL_MOTION_MAX_AGE_SEC/, "motion credit must expire with age");
  assert.match(probe, /state === "running"/, "only RUNNING subagents count as motion");
  // Round-16 P2: tmux judge children are motion too — and their probe must
  // carry the SAME freshness bound (a hung-but-alive pane must not disable
  // the breaker forever; the goal-auditor flagged exactly that hazard).
  const judgeAt = SRC.indexOf("function judgeChildInMotion(");
  assert.ok(judgeAt > 0, "judgeChildInMotion must exist");
  const judgeProbe = SRC.slice(judgeAt, judgeAt + 900);
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

test("MODEL WIDGET: deployed lookup is project-first, frontmatter-scoped, with slots[0]/'?' fallback", () => {
  // round-1 P2: modelConfigWidgetLines had NO coverage at all. The data path
  // matters because it decides what the belowEditor widget CLAIMS is in force.
  const at = SRC.indexOf("function modelConfigWidgetLines(");
  assert.ok(at > 0, "modelConfigWidgetLines must exist");
  const fn = SRC.slice(at, at + 2600);
  assert.match(fn, /findProjectAgentText\(projectDir, name\)/, "project layer must be looked up FIRST, by identity");
  // `model:` must be scoped to the frontmatter block, and the block must come
  // from the SHARED delimiter authority (round-12 R3 P2: a local strict regex
  // here disagreed with the lenient identity lookup two lines above, so a file
  // found by identity could still fail to yield its deployed model).
  assert.match(fn, /frontmatterBlock\(text\)/, "the frontmatter block must come from lib/model-config.ts");
  assert.doesNotMatch(fn, /\^---\\r\?\\n/, "no local delimiter regex may compete with the shared one");
  assert.match(fn, /\^model:\\s\*\(\.\+\)\$\/m/, "`model:` must be matched only inside that block");
  assert.match(
    fn,
    /deployed\(name\) \?\? \(s\.auto === false && s\.slots\.length > 0 \? s\.slots\[0\]! : "\?"\)/,
    "fallback order: deployed file → slots[0] (auto OFF) → '?'",
  );
  assert.match(fn, /\["reviewer", "adviser"\]/, "the widget shows exactly reviewer + adviser");
  assert.match(fn, /display-only/, "never breaks the TUI");
});

test("MODEL WIDGET wiring reaches the real updateWidget path", async () => {
  const at = SRC.indexOf("function updateWidget(");
  assert.ok(at > 0);
  const body = SRC.slice(at, at + 2200);
  assert.match(body, /modelConfigWidgetLines\(\)/);
  assert.match(body, /ctx\.ui\.setWidget\("review-gate-agents"/);
});

test("MODEL DIAGNOSIS: project outranks global, registry auth gates, disk fallback", () => {
  // round-1 P2: the rewritten modelDiagnosisLines had no coverage either.
  const at = SRC.indexOf("function modelDiagnosisLines(");
  assert.ok(at > 0, "modelDiagnosisLines must exist");
  const fn = SRC.slice(at, at + 4200);
  assert.match(fn, /findProjectAgentText\(projectAgentsDir, name\)/, "effective chain = project file first (by identity)");
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
  const fnAt = SRC.indexOf("function settledConclusion(");
  assert.ok(fnAt > 0, "settledConclusion must exist");
  const fn = SRC.slice(fnAt, fnAt + 500);
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
  assert.match(SRC, /name: "ask_user"/);
  assert.doesNotMatch(SRC, /name: "pause_for_question"/,
    "the second asking entry point must not come back");
  const toolStart = SRC.indexOf('name: "ask_user"');
  const toolBody = SRC.slice(toolStart, SRC.indexOf('name: "request_scope_limit"', toolStart));
  // Calling it PAUSES when anything is left unanswered, and the pause persists
  // (it must survive a restart while the user is away).
  assert.match(toolBody, /const pending = needsUserReply\(answers\)/);
  assert.match(toolBody, /state\.pausedQuestion = \{/);
  assert.match(toolBody, /loopArmed = false/);
  assert.match(toolBody, /persist\(/);
  // …but it must NEVER touch the ship authority: unmetRequirements takes no
  // pause input, and no call site filters its problems on pausedQuestion.
  assert.doesNotMatch(SRC, /unmetRequirements\([^)]*pausedQuestion/);
});

test("ask_user: the QUESTIONS reach the user, and silence is never an answer", () => {
  // REGRESSION this inherits: a question used to be written to
  // `state.pausedQuestion` and nowhere else, while the tool result told the
  // agent it had been "delivered to the user verbatim" — the user saw a
  // warning with no question in it.
  const toolStart = SRC.indexOf('name: "ask_user"');
  const toolBody = SRC.slice(toolStart, SRC.indexOf('name: "request_scope_limit"', toolStart));
  assert.match(toolBody, /showToUser\(uiCtx, "───── AI 有问题要问你 ─────"/,
    "the questions themselves are shown, not just filed");
  // The interview: one dialog per question, with its N / M progress.
  assert.match(toolBody, /progressLabel\(index, questions\.length\)/);
  assert.match(toolBody, /uiCtx\.ui\?\.select\?\.\(/, "options ⇒ a choice dialog");
  assert.match(toolBody, /uiCtx\.ui\?\.input\?\.\(/, "no options ⇒ free text");
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
  assert.match(toolBody, /state\.askUser = \{ at: new Date\(\)\.toISOString\(\), answers: \[\.\.\.answers\] \};[\s\S]{0,120}persist\(/,
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
  // The L8 explore short-circuit lives in the helper loopGoalEditBlockFor
  // (kept OUT of the handler body on purpose — see its docblock): it only
  // lets EDITS pass in explore. Pin that it exists and that it can never
  // block (it returns undefined — the ship path is untouched).
  const helperAt = SRC.indexOf("function loopGoalEditBlockFor");
  assert.ok(helperAt > 0, "loopGoalEditBlockFor must exist");
  const helperBody = SRC.slice(helperAt, helperAt + 700);
  const exploreAt = helperBody.indexOf('state.taskMode === "explore"');
  assert.ok(exploreAt >= 0, "the helper must short-circuit explore (edits only)");
  assert.match(helperBody.slice(exploreAt, exploreAt + 120), /return undefined/,
    "the explore short-circuit must pass edits through, never block them");
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

test("L5 is HARD: commit & PR title/body language checks BLOCK (majority policy, escape hatch named)", () => {
  // commit messages AND gh pr create title/body are language-checked.
  assert.match(SRC, /firstNonEnglish/);
  assert.match(SRC, /extractPrTextFields/);
  // Applied to both ship kinds.
  assert.match(SRC, /s\.kind === "pr-create" \|\| s\.kind === "pr-edit"/);
  // User policy (2026-08-16): L5 upgraded from advisory to HARD — a
  // predominantly non-English commit message or PR title/body returns
  // block:true. The majority-body policy keeps minority foreign tokens
  // passing, and the reason names the escape hatch so a wrong guess never
  // strands a legitimate commit.
  assert.match(SRC, /L5 HARD/);
  assert.doesNotMatch(SRC, /l5Advisories/,
    "the advisory collection must be gone — every language branch blocks");
  assert.doesNotMatch(SRC, /review-gate \(L5 advisory\)/,
    "the advisory notify must be gone");

  // Both language branches must actually return block:true.
  const commitLangAt = SRC.indexOf("firstNonEnglish(msgs)");
  const prLangAt = SRC.indexOf("firstNonEnglish(prTexts)");
  assert.ok(commitLangAt > 0 && prLangAt > commitLangAt,
    "commit language check → PR language check, in order");
  const commitRegion = SRC.slice(commitLangAt, prLangAt);
  assert.match(commitRegion, /block: true/,
    "a non-English commit message must block the ship");
  assert.match(commitRegion, /\/gate-bypass <reason>/,
    "the commit block must name the in-session escape hatch");
  assert.match(commitRegion, /REVIEW_GATE_BYPASS=1/,
    "the commit block must also name the out-of-session hook bypass");
  const prRegion = SRC.slice(prLangAt, prLangAt + 1600);
  assert.match(prRegion, /block: true/,
    "a non-English PR title/body must block the ship");
  assert.match(prRegion, /gh pr edit --title\/--body/,
    "the PR block must point at the fix");

  // AI-attribution stays a hard block too (double barrier).
  assert.match(SRC, /AI attribution[\s\S]*?block:\s*true/);
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
  // `_onUpdate` travels too: the runner's log is streamed while it runs, so a
  // multi-minute precommit is no longer a silent tool call.
  assert.match(SRC, /await runTrustedPrecommit\(targetDir, targetRoot, mode, _signal, _onUpdate\)/);
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
  const body = SRC.slice(start, start + 8000);
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

test("L8b: record_goal_prereview is TRUSTED — the extension parses the verdict and hashes the text", () => {
  const start = SRC.indexOf('name: "record_goal_prereview"');
  assert.ok(start > 0, "the pre-review tool must be registered");
  const nextTool = SRC.indexOf('name: "propose_loop_goal"', start);
  assert.ok(nextTool > start, "propose_loop_goal must follow record_goal_prereview");
  const body = SRC.slice(start, nextTool);
  // The verdict is READ, never accepted: no `passed`/`verdict` parameter may
  // exist, or the pre-review becomes an agent self-certification again.
  assert.match(body, /parseReviewOutput\(params\.auditor_output\)/, "the extension must parse the auditor output itself");
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
  const proposeAt = SRC.indexOf('name: "propose_loop_goal"');
  const propose = SRC.slice(proposeAt, proposeAt + 12000);
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
  // Same repo resolution as propose_loop_goal (never resolveToolRepo, which
  // requires an already-edited repo and would dead-end a second repo's goal).
  assert.match(body, /gitRootOfDir\(abs\)/);
  assert.doesNotMatch(body, /resolveToolRepo\(/, "it must not CALL resolveToolRepo (naming it in the rationale is fine)");
});

test("goal criterion 3: prepare_adviser is registered and hands back a brief with artifact + session pointer", () => {
  const start = SRC.indexOf('name: "prepare_adviser"');
  assert.ok(start > 0, "the adviser brief tool must be registered");
  const body = SRC.slice(start, start + 9000); // room for the done-channel wiring at the tool's tail
  assert.match(body, /buildAdviserBrief\(/, "the brief comes from the shared pure builder");
  assert.match(body, /adviser-\$\{goalHash\}\.jsonl/, "the artifact path is per goal");
  assert.match(body, /mkdirSync\(pathDirname\(artifactPath\), \{ recursive: true \}\)/, "the artifact dir is created before the first consultation");
  assert.match(body, /adviserBaselines/, "the changed-files baseline is persisted per goal for the next consultation");
  assert.match(body, /readLastAdviserConclusion\(artifactPath, goalHash\)/, "readback goes through the tested pure parser (parseAdviserConclusions)");
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
  // (review_wait's own reply), so the header no longer teaches it. What must
  // survive is the truncated-goal pointer: a brief with half a goal in it
  // sends the adviser off the wrong contract.
  assert.match(body, /需要全文时读 \$\{pathJoin\(target\.root, LOOP_GOAL_RELPATH\)\}/,
    "a truncated goal is pointed at its file");
});

test("goal criterion 2: prepare_goal_audit hands back the ready-made auditor task BEFORE dispatch", () => {
  // The round-5 P1: record_goal_prereview only runs AFTER the audit, so it
  // could never supply the task that produced the audit it records. The
  // task template therefore lives in a PRE-dispatch tool.
  const start = SRC.indexOf('name: "prepare_goal_audit"');
  assert.ok(start > 0, "the pre-dispatch audit task tool must be registered");
  const body = SRC.slice(start, start + 9000); // room for the done-channel wiring at the tool's tail
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
  const start = SRC.indexOf('name: "prepare_review"');
  const body = SRC.slice(start, start + 24000);
  assert.match(body, /precommitBaselineFor\(root, st\)/, "the baseline rides the task text");
  assert.match(body, /extractPrecommitBaseline\(st\.precommit, digest, cacheRaw\)/, "the safety decision is the pure function");
  assert.match(body, /computeFingerprint\(root\)/, "the current tree fingerprint is measured, not guessed");
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
  const proseEnd = body.indexOf("        TASK_TEXT_MARKER,");
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
  assert.match(body, /落盘 task 文件时请用 read 读取 \$\{pathJoin\(root, LOOP_GOAL_RELPATH\)\}/,
    "a truncated goal must be completed from the file when writing the task");
});

test("attention stays DIRECTED and file-based — no tmux signal, no global broadcast", () => {
  // SIGNAL side: the event is published through lib/attention.ts with the
  // PARENT from the environment (RG_PARENT_SESSION) — never a global bell.
  const fnAt = SRC.indexOf("function notifyUserAttention(");
  assert.ok(fnAt > 0, "notifyUserAttention must exist");
  const fn = SRC.slice(fnAt, fnAt + 450);
  assert.match(fn, /publishAttention\(\{/, "the event goes through the payload publisher");
  assert.match(fn, /fromSessionId: attentionIdentity\(\)/, "the payload identifies the sender (self-wake filter)");
  assert.match(fn, /toSessionId: parentSessionId\(\)/, "the payload is addressed to the PARENT from the environment");
  assert.match(fn, /reason,/, "the payload carries the reason");
  assert.doesNotMatch(fn, /osascript/, "no macOS notification is fired from the extension");
  assert.doesNotMatch(fn, /waitForSignalAsync|wait-for/, "no tmux signal is fired from the extension");
  // The address derives from the parent session id — no global broadcast.
  assert.doesNotMatch(SRC, /rg-user-attention/, "the global broadcast channel is GONE");
  assert.doesNotMatch(SRC, /createWatchRegistry\(/, "the tmux channel watcher registry is GONE");
  // propose_loop_goal: signalled right before the approval dialog renders.
  const goalAt = SRC.indexOf('name: "propose_loop_goal"');
  const goalBody = SRC.slice(goalAt, goalAt + 24000);
  const dialogAt = goalBody.indexOf("confirmBounded(");
  const signalAt = goalBody.indexOf("notifyUserAttention(\"等待 goal 批准\"");
  assert.ok(signalAt > 0 && signalAt < dialogAt, "the approval dialog signals attention before rendering");
  // ask_user: signalled when the interview starts, with its own reason.
  const pauseAt = SRC.indexOf('name: "ask_user"');
  const pauseBody = SRC.slice(pauseAt, pauseAt + 8000);
  assert.match(pauseBody, /notifyUserAttention\(\"等待回答提问\"\)/, "a pause signals attention with its reason");
  // Spawn side: the child receives RG_PARENT_SESSION so it knows who to wake.
  const spawnAt = SRC.indexOf("function dispatchJudgeRound(");
  const spawn = SRC.slice(spawnAt, spawnAt + 9000);
  assert.match(spawn, /parentSessionId: state\.sessionId \?\? undefined/, "the child is told who spawned it");
});

test("round-18: prepare_review carries the polish-gate reason — parameter, refusal, persistence, reviewer injection", () => {
  const start = SRC.indexOf('name: "prepare_review"');
  assert.ok(start > 0, "prepare_review must exist");
  const body = SRC.slice(start, start + 9000);
  // The tool accepts a `reason` parameter.
  assert.match(body, /reason: Type\.Optional\(Type\.String\(/, "prepare_review accepts a reason");
  // The refusal path consults the pure decision module and demands the reason.
  assert.match(body, /polishReasonRequired\(st\.rounds\)/, "the polish gate decides from the recorded rounds");
  assert.match(body, /prepare_review REFUSED/, "the refusal text is explicit");
  assert.match(body, /params\.reason \?\? ""\)\.trim\(\)/, "the reason is trimmed before judging");
  // A supplied reason is persisted into gate state for the NEXT reviewer.
  assert.match(body, /st\.lastPolishReason = \{/, "the reason is persisted");
  assert.match(body, /lastPolishReason/, "the reviewer task receives the stored reason");
  // record_review records per-file finding severities for the file streak.
  const recAt = SRC.indexOf('name: "record_review"');
  assert.ok(recAt > 0);
  const recBody = SRC.slice(recAt, recAt + 10000);
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
  const closeAt = SRC.indexOf('name: "review_close"');
  const closeBody = SRC.slice(closeAt, closeAt + 3000);
  assert.match(closeBody, /cancelChildWaitTimer\(\)/, "review_close cancels the watchdog");
  const shutdownAt = SRC.indexOf('pi.on("session_shutdown"');
  const shutdownBody = SRC.slice(shutdownAt, shutdownAt + 500);
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
  const at = SRC.indexOf('name: "judge_submit"');
  assert.ok(at > 0, "judge_submit must be registered");
  const body = SRC.slice(at, SRC.indexOf('name: "review_spawn"', at));
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

test("review_read / review_close / review_wait address a judge by ROLE", () => {
  for (const tool of ["review_read", "review_close", "review_wait"]) {
    const at = SRC.indexOf(`name: "${tool}"`);
    assert.ok(at > 0, `${tool} must be registered`);
    const body = SRC.slice(at, at + 4000);
    assert.match(body, /role: Type\.Optional\(Type\.Enum\(\{ reviewer/, `${tool} takes a role`);
    assert.match(body, /findJudgeChild\(root, role, /, `${tool} resolves the child by role`);
  }
});

test("review_wait applies the three end-of-round criteria and returns the wait discipline", () => {
  const at = SRC.indexOf('name: "review_wait"');
  const body = SRC.slice(at, at + 4000);
  assert.match(body, /clampWaitTimeout\(params\.timeoutMs\)/, "the blocking window is clamped by the gate");
  assert.match(body, /probeJudgeRound\(child\)/, "the loop probes with the shared criteria");
  assert.match(body, /WAIT_DISCIPLINE_HINT/, "the reply carries the wait discipline");
  const probeAt = SRC.indexOf("function probeJudgeRound(");
  const probe = SRC.slice(probeAt, probeAt + 1200);
  assert.match(probe, /evaluateJudgeWait\(\{/, "the criteria live in the pure module");
  assert.match(probe, /existsSync\(child\.exitCodePath\)/, "the exit-code file is one criterion");
  assert.match(probe, /child\.stdoutPath/, "the fence criterion reads stdout, where the fence is plain text");
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

  // review_read: live process ⇒ tail of the stdout log; ended ⇒ the
  // transcript + stderr, because the process is gone but its records are not.
  const readAt = SRC.indexOf('name: "review_read"');
  assert.ok(readAt > 0);
  const read = SRC.slice(readAt, readAt + 4500);
  assert.match(read, /readJudgeSessionState\(/, "liveness comes from the session's artifacts");
  assert.match(read, /judgeProcessAlive\(child\.child\)/, "the live PROCESS's exitCode decides running");
  assert.match(read, /readJudgeConclusion\(child\.sessionDir\)/,
    "the conclusion is parsed from the RECORDED session dir");
  assert.match(read, /readStderrTail\(child\.stderrPath\)/, "crash context survives the process");

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

  // review_close: terminate the PROCESS (SIGTERM), then drop the registry.
  const closeAt = SRC.indexOf('name: "review_close"');
  assert.ok(closeAt > 0);
  const close = SRC.slice(closeAt, closeAt + 3600);
  assert.match(close, /kill\?\.\("SIGTERM"\)/, "the live process is SIGTERMed");
  assert.match(close, /closed: true/,
    "closing an already-finished child still reports success (idempotent)");
  assert.match(close, /transcript and logs stay/, "the records remain inspectable after close");
});

test("L8b: propose_loop_goal checks the pre-review BEFORE any user-facing surface", () => {
  const start = SRC.indexOf('name: "propose_loop_goal"');
  const nextTool = SRC.indexOf('name: "request_copilot_review"', start);
  // Without these, a renamed/removed tool would silently make `body` the whole
  // file (or empty) and every ordering assertion below would pass vacuously.
  assert.ok(start > 0, "propose_loop_goal must be registered");
  assert.ok(nextTool > start, "the window must end at the next tool registration");
  const body = SRC.slice(start, nextTool);
  const check = body.indexOf("goalPrereviewPassed(");
  assert.ok(check > 0, "the gate must consult the pre-review record");
  // Order is the whole point: a check placed after showToUser/confirmBounded
  // would still parade an unaudited draft in front of the user.
  const show = body.indexOf("showToUser(");
  const confirm = body.indexOf("confirmBounded(");
  const write = body.indexOf("writeFileSync(goalPath");
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
  const start = SRC.indexOf('name: "propose_loop_goal"');
  assert.ok(start > 0, "the tool must be registered");
  // Bound at the next tool registration so an assertion can never be
  // satisfied by request_copilot_review's code (round P2: the flat window
  // overshot into the next tool).
  const nextTool = SRC.indexOf('name: "request_copilot_review"', start);
  assert.ok(nextTool > start, "request_copilot_review must follow propose_loop_goal");
  const body = SRC.slice(start, nextTool);
  assert.match(body, /confirmBounded\(/,
    "the extension must render the approval dialog itself");
  assert.doesNotMatch(body, /confirmed\s*:\s*Type\./,
    "no agent-supplied 'confirmed' parameter — that would be self-approval");
  // The approval must describe text the USER saw: the extension writes the
  // file, and the sidecar records the hash of exactly that text.
  assert.match(body, /writeFileSync\(goalPath/);
  assert.match(body, /(?:state|goalSt)\.loopGoal = \{ hash: goalTextHash\(goalText\)/);
  assert.match(body, /LOOP_GOAL_MAX_WRITE_CHARS/, "the goal must be length-bounded");
});

test("propose_loop_goal: confirm/reject may carry a user REASON (input after the dialog)", () => {
  // The user can answer "确认 + 原因" / "拒绝 + 原因" — a reason input follows
  // the Yes/No dialog. A rejection reason must be handed back to the agent so
  // it renegotiates against the real objection; an approval reason is
  // persisted with the confirmation and echoed to the agent.
  const start = SRC.indexOf('name: "propose_loop_goal"');
  assert.ok(start > 0);
  // Bound at the next tool registration (round P2: the flat window overshot
  // into request_copilot_review's code).
  const nextTool = SRC.indexOf('name: "request_copilot_review"', start);
  assert.ok(nextTool > start);
  const body = SRC.slice(start, nextTool);
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
      const used = new RegExp(`(?<![A-Za-z0-9_$.])${name}(?![A-Za-z0-9_$])`);
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
  const body = SRC.slice(at, at + 8000);
  // the gate semantics: bypasses READY only, never precommit
  assert.match(body, /bypasses READY only, never precommit/);
  assert.match(body, /firstNonEnglish/, "L5: message must be English");
  assert.match(body, /COMMIT_MSG_FORBIDDEN/, "round-4 P2: AI-attribution guard replicated");
  assert.match(body, /testScope !== "full"/, "round-4 P2: full precommit required");
  assert.match(body, /isSensitiveFile/, "round-4 P2: sensitive paths refused");
  assert.match(body, /st\.checkpoint = \{ sha/, "round-4 P2: sha persisted to gate state");
  assert.match(body, /REVIEW_GATE_BYPASS: "1"/, "hook bypass is scoped to the child process");
});

test("review_watch: the wake-up watcher is registered with triggerTurn semantics", () => {
  const at = SRC.indexOf('name: "review_watch"');
  assert.ok(at >= 0, "review_watch must be registered");
  // Round-14 (user ask): the registration logic lives in the shared
  // registerWatch helper; review_spawn calls it AUTOMATICALLY, review_watch
  // only re-registers with a custom label. The wake must be a new turn —
  // never polling, never sleeping on the agent side.
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
  const body = SRC.slice(settledStart, settledStart + 9000);
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
  assert.ok(SRC.includes('../lib/edit-projection.ts'), "must import lib/edit-projection.ts");
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
    // 2200: declare_done's own description + the merge-waiver dialog sit
    // between the tool name and its first fingerprint call.
    ['name: "declare_done"', 2200],
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

test("REGRESSION: resolveOpenPr must fall back for gh versions without headRefOid", () => {
  // gh 2.4.0 rejects `--json number,headRefOid,url,state` with
  // `Unknown JSON field: "headRefOid"` — the audit log showed every Copilot
  // cycle released UNSUPPORTED on request because resolveOpenPr never
  // retried. The modern attempt must be followed by a legacy retry.
  const at = SRC.indexOf("async function resolveOpenPr(");
  assert.ok(at > 0, "resolveOpenPr must exist");
  const body = SRC.slice(at, SRC.indexOf("\n  }\n", at) + 4);
  assert.match(body, /PR_VIEW_JSON_FIELDS\.modern/, "the first attempt must use the modern field set");
  assert.match(body, /PR_VIEW_JSON_FIELDS\.legacy/, "the legacy retry must use the legacy field set");
  assert.match(body, /decidePrView\(/, "the control flow must delegate to the pure decision helper");
  assert.match(body, /isUnknownJsonFieldError\(modern\.stderr\)/,
    "the legacy retry must be conditional on the field-whitelist error (P2: never retry for a real failure)");
});

test("L5 is HARD: non-English commit/PR text blocks the ship with the escape hatch named", () => {
  // User policy (2026-08-16): L5 upgraded from advisory to hard block — the
  // same majority-body detection, but a hit now returns block:true, and the
  // reason must name the escape hatch so a wrong guess never strands a
  // legitimate commit.
  const callStart = SRC.indexOf('pi.on("tool_call"');
  const callBody = SRC.slice(callStart, SRC.indexOf('pi.on("tool_result"', callStart));
  assert.match(callBody, /L5 HARD: a predominantly non-English/,
    "the L5 section must be marked HARD");
  assert.match(callBody, /commit message is predominantly non-English/,
    "a non-English commit message must block");
  assert.match(callBody, /\/gate-bypass <reason>/,
    "the commit block reason must name the in-session escape hatch");
  assert.match(callBody, /REVIEW_GATE_BYPASS=1/,
    "the out-of-session hook bypass must be named too");
  assert.match(callBody, /PR title\/description is predominantly non-English/,
    "a non-English PR title/body must block");
  assert.match(callBody, /gh pr edit --title\/--body/,
    "the PR block reason must point at the fix");
  assert.doesNotMatch(callBody, /advisory only — never a block/,
    "the advisory-only rationale must be gone");
  const blocks = callBody.split("block: true").length - 1;
  assert.ok(blocks >= 6, `expected the L5 blocks to exist alongside the others (got ${blocks} total block:true sites)`);
});

test("REGRESSION: /gate-bypass actually disarms the L1 ship gate in-session", () => {
  // The /gate-bypass command wrote state.bypass but L1 never consulted it —
  // a bypassed session still blocked every ship command at tool_call (only
  // the git hooks honored it). The bash branch must step aside on
  // state.bypass.active BEFORE any ship detection.
  const callStart = SRC.indexOf('pi.on("tool_call"');
  const callBody = SRC.slice(callStart, SRC.indexOf('pi.on("tool_result"', callStart));
  const normalAt = callBody.indexOf('state.taskMode === "normal"');
  const bypassAt = callBody.indexOf("state.bypass.active");
  assert.ok(normalAt > 0 && bypassAt > normalAt,
    "the bypass check must come after the normal-mode early return");
  const detectAt = callBody.indexOf("detectShipCommands(command)");
  assert.ok(detectAt > bypassAt,
    "the bypass check must run BEFORE ship detection");
  assert.match(callBody.slice(bypassAt, bypassAt + 120), /return;/,
    "bypass must early-return the bash branch");
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
  const statusAt = SRC.indexOf('pi.registerCommand("gate-status"');
  assert.ok(statusAt > 0, "gate-status must exist");
  const statusBody = SRC.slice(statusAt, SRC.indexOf("pi.registerCommand(", statusAt + 1));
  assert.match(statusBody, /tests were NOT run in this lane/,
    "gate-status must surface the skipped test step");
  assert.match(statusBody, /testScope === "skipped"/,
    "the gate-status warning must be keyed on the skipped scope");
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
  assert.match(SRC, /reviewTargets\.set\(\s*root,\s*\{\s*baseline,\s*head,\s*tree\s*\}\)/);
  // The registration must carry the tree, because that is what a READY binds to.
  assert.match(SRC, /reviewTargets\.set\([^)]*\btree\b/);
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

test("P2: judge-role subagent block covers ALL three dispatch channels", () => {
  // Round-8 P1: top-level input.agent is not the only channel — a judge role
  // named inside a workflowScript string (runs.run({agent:"reviewer"})) or a
  // workflowScriptPath file would bypass a top-level-only check. The block
  // must scan the script text with the retired guard's own detector.
  const segment = SRC.slice(SRC.indexOf("judge-role subagent block"));
  assert.match(segment, /input\.workflowScript/);
  assert.match(segment, /input\.workflowScriptPath/);
  assert.match(segment, /judgeRoleInScript/);
  // The refusal text must steer to the review_spawn flow, never to a retry of subagent.
  assert.match(segment, /runs ONLY as its own pi process/);
  assert.match(segment, /review_checkpoint/);
  assert.doesNotMatch(segment, /tmux judge child|tmux flow/);
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

test("a dirty worktree the session did not create blocks edits until it is settled", () => {
  const start = SRC.indexOf("function loopGoalEditBlockFor(");
  const body = SRC.slice(start, start + 3000);
  assert.match(body, /state\.worktreeDirty && !state\.worktreeDirty\.settled/,
    "unsettled pre-existing changes block edits");
  assert.match(body, /setup_workspace/, "and the block names the tool that settles them");
  // Recorded at session start, from git itself — not from anything the agent says.
  const startAt = SRC.indexOf("function recordSessionStartWorkspace(");
  const record = SRC.slice(startAt, startAt + 1500);
  assert.match(record, /dirtyFiles\(primaryRepoRoot\)/);
  assert.match(record, /op: "checkout", from: null, to: branch/,
    "the starting branch opens the audit trail");
});

test("setup_workspace settles the worktree and the branches, and records both", () => {
  const at = SRC.indexOf('name: "setup_workspace"');
  assert.ok(at > 0, "setup_workspace must be registered");
  const body = SRC.slice(at, SRC.indexOf('name: "ask_user"', at));
  // The three-way choice is the USER's, and a dismissed dialog settles nothing.
  assert.match(body, /interpretWorktreeChoice\(picked\)/);
  assert.match(body, /if \(!choice\) \{/, "no choice ⇒ nothing is settled");
  // "I handled it" is verified, not believed.
  assert.match(body, /choice === "handled"[\s\S]{0,400}?dirtyFiles\(root\)/);
  // Discarding is the GATE's action, and it is recorded.
  assert.match(body, /"checkout", "--", "\."/);
  assert.match(body, /"clean", "-fd"/);
  assert.match(body, /op: "worktree_discard"/);
  // Branch decisions are recorded as they happen.
  assert.match(body, /op: "base_branch_set"/);
  assert.match(body, /op: "work_branch_set"/);
  assert.match(body, /isProtectedBranch\(here\)/, "main/master is never worked on directly");
});

test("a commit may only land on this session's OWN work branch (fail-closed)", () => {
  // Checked PER REPO, inside the ship loop: a commit in repo B must never be
  // judged against repo A's work branch.
  const start = SRC.indexOf("// WHERE the commit lands, per repo");
  assert.ok(start > 0, "the per-repo branch check must exist in the ship loop");
  const body = SRC.slice(start, start + 1200);
  assert.match(body, /ships\.some\(\(s\) => s\.kind === "commit"\)/);
  assert.match(body, /commitBranchAllowed\(\{/);
  assert.match(body, /workBranch: \(root === primaryRepoRoot \? state : stateForRepo\(root\)\)\.workBranch/,
    "each repo answers with its OWN work branch");
  assert.match(body, /currentBranch: currentBranch\(root\)/);
  // The pure decision refuses when no work branch is on record — pinned in
  // test/workspace-branch.test.ts; here we only pin that the gate ASKS.
  assert.match(body, /if \(!where\.allowed\) \{/);
});

test("declare_done lands the work itself, and a conflict stops it honestly", () => {
  const at = SRC.indexOf('name: "declare_done"');
  const body = SRC.slice(at, at + 9000);
  assert.match(body, /const finish = finishWorkBranch\(/, "the gate merges, the agent does not");
  const finishAt = SRC.indexOf("function finishWorkBranch(");
  const finish = SRC.slice(finishAt, finishAt + 3000);
  assert.match(finish, /decideFinish\(\{/, "the decision is the pure function's");
  assert.match(finish, /"merge", "--no-ff"/);
  // A conflict leaves NOTHING half-applied: abort, return to the work branch,
  // record what conflicted, refuse.
  assert.match(finish, /"merge", "--abort"/);
  assert.match(finish, /st\.mergeConflict = \{/);
  assert.match(finish, /ok: false/);
  assert.match(finish, /st\.mergeWaived/, "a waiver already on record skips the merge");
  // A merge failure that is NOT a conflict must not be reported as one.
  assert.match(finish, /const conflicted = files\.length > 0/);
  // …and the waiver must be WRITABLE, by the user, or the escape hatch the
  // refusal points at does not exist (round-4 P1: it was read-only).
  assert.match(body, /waiveMerge/, "declare_done takes the waiver request");
  assert.match(body, /confirmBounded\(/, "the USER grants it, in a dialog");
  assert.match(body, /state\.mergeWaived = \{ at: new Date\(\)\.toISOString\(\), reason:/,
    "a granted waiver is recorded with its reason");
});

test("review_checkpoint is fail-closed about the branch it commits on", () => {
  const at = SRC.indexOf('name: "review_checkpoint"');
  const body = SRC.slice(at, at + 4000);
  assert.match(body, /const checkpointState = root === primaryRepoRoot \? state : stateForRepo\(root\)/,
    "the TARGET repo's own work branch decides");
  assert.match(body, /commitBranchAllowed\(\{ workBranch: checkpointState\.workBranch/);
  assert.doesNotMatch(body, /if \(state\.workBranch\) \{[\s\S]{0,200}?commitBranchAllowed/,
    "no work branch on record must REFUSE, not exempt (round-4 P1)");
});



test("judge_submit builds the task for EVERY role, and a goal audit streams its findings", () => {
  const at = SRC.indexOf('name: "judge_submit"');
  const body = SRC.slice(at, SRC.indexOf('name: "review_spawn"', at));
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
  const at = SRC.indexOf("async function submitForReview(");
  assert.ok(at > 0, "the chain must exist");
  const body = SRC.slice(at, at + 3500);
  // Each step is the TOOL's own execute — one implementation, one set of
  // mechanical checks.
  assert.match(body, /callTool\("run_precommit", \{ mode: "full"/);
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
  const submitAt = SRC.indexOf('name: "judge_submit"');
  const submit = SRC.slice(submitAt, submitAt + 5000);
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
    const at = SRC.indexOf(`name: "${tool}"`);
    assert.ok(at > 0, `${tool} must be registered`);
    const desc = SRC.slice(at, SRC.indexOf("parameters: Type.Object({", at));
    assert.match(desc, /ADVANCED \/ internal/, `${tool}'s description must say it is an advanced entry`);
    assert.match(desc, /judge_submit|the gate records/, `${tool} must point at the normal path`);
    assert.doesNotMatch(desc, /review_spawn/, `${tool} must not teach the retired spawn call`);
    assert.doesNotMatch(desc, /ALWAYS call this before|Call this before dispatching|Call after every review round/,
      `${tool} must not teach the retired manual ordering`);
  }
});

