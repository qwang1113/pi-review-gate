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
  assert.match(call, /inMotion:\s*subagentInMotion\(\)/, "the breaker must be told about work in flight");
  // The motion probe must be bounded in age, or a hung run would disable the
  // breaker permanently — the exact failure it exists to catch.
  const probeAt = SRC.indexOf("function subagentInMotion(");
  assert.ok(probeAt > 0, "subagentInMotion must exist");
  const probe = SRC.slice(probeAt, probeAt + 900);
  assert.match(probe, /STALL_MOTION_MAX_AGE_SEC/, "motion credit must expire with age");
  assert.match(probe, /state === "running"/, "only RUNNING subagents count as motion");
});

test("FAN-OUT: the reviewer count is injected on BOTH dispatch paths", () => {
  // The observed waste (two same-family reviewers billed as a cross-family
  // pair) happened in the AUTONOMOUS loop, where nobody types /review — so
  // the command prompt alone is not enough.
  assert.match(SRC, /from "\.\.\/lib\/review-fanout\.ts"/);

  const cmdAt = SRC.indexOf("function registerWorkflowCommand(");
  assert.ok(cmdAt > 0, "the workflow command registrar must exist");
  const cmdBody = SRC.slice(cmdAt, cmdAt + 1200);
  assert.match(cmdBody, /name === "review"/, "only /review carries the fan-out decision");
  assert.match(cmdBody, /fanoutDirective\(\)/, "/review must append the computed plan");

  // (a) the literal [REVIEW_GATE_RESUME] message the autonomous loop runs on.
  const settledAt = SRC.indexOf('pi.on("agent_settled"');
  assert.ok(settledAt > 0, "agent_settled handler must exist");
  const resumeAt = SRC.indexOf("REVIEW_GATE_RESUME", settledAt);
  const sendEnd = SRC.indexOf('{ deliverAs: "followUp" }', resumeAt);
  assert.ok(sendEnd > resumeAt, "the resume sendUserMessage must be locatable");
  const resumeMessage = SRC.slice(resumeAt, sendEnd);
  assert.match(resumeMessage, /fanoutDirective\(\)/, "the RESUME message itself must carry the plan");
  assert.match(
    resumeMessage,
    /state\.review\.verdict !== "READY"/,
    "only while a review is outstanding",
  );

  // (b) the per-turn prompt, which is the only carrier on user-driven turns
  // (paused loop, exhausted continuation budget, a plain "go review it").
  const promptAt = SRC.indexOf('pi.on("before_agent_start"');
  assert.ok(promptAt > 0);
  const promptBody = SRC.slice(promptAt);
  assert.match(promptBody, /fanoutDirective\(\)/, "the per-turn prompt must carry the plan too");
  const fanoutInPrompt = promptBody.indexOf("fanoutDirective()");
  const guard = promptBody.slice(Math.max(0, fanoutInPrompt - 400), fanoutInPrompt);
  assert.match(guard, /state\.review\.verdict !== "READY"/, "only inject while a review is outstanding");
});

test("FAN-OUT: a partial (disk) model view may confirm judges, never deny them", () => {
  // Reading only models-store.json misses built-in catalogs (anthropic), so a
  // "no judge available" conclusion drawn from it would be a false alarm —
  // the same mistake that once reported every built-in chain as BLOCKED.
  const at = SRC.indexOf("function fanoutDirective(");
  assert.ok(at > 0, "fanoutDirective must exist");
  const body = SRC.slice(at, at + 3000);
  assert.match(body, /registryJudgeFacts/, "the authoritative registry view must be preferred");
  assert.match(
    body,
    /plan\.crossFamily \? formatFanoutDirective/,
    "the disk fallback may only CONFIRM a cross-family pair — claiming SINGLE from it " +
      "would suppress a double review that was actually possible and record a false note",
  );
  // The slot-aware planner gates the user-slot path on the reviewer auto switch
  // OFF and keeps the capability planner for the default — so auto:true stays
  // identical to today's path by construction.
  const planAt = SRC.indexOf("function planForFacts(");
  assert.ok(planAt > 0, "planForFacts must exist");
  const planner = SRC.slice(planAt, planAt + 1600);
  assert.match(planner, /planConfiguredReviewFanout/, "production planner must use the shared configured helper");
  assert.match(planner, /reviewer\.auto === false/, "slot path must be gated on auto OFF");
  assert.match(planner, /slots\.length > 0/, "empty slot list must fall back to the default path");
  assert.match(planner, /planFanoutFromFacts/, "default path must keep the capability planner");
  // The slot-source sentence lives ONCE, in the helper (round-12 Nit): a second
  // copy here silently drifted from what lib/review-fanout.ts stamps.
  assert.doesNotMatch(planner, /REVIEWER SLOT SOURCE/, "the slot-source stamp must not be duplicated in the extension");
  assert.doesNotMatch(
    body.slice(body.indexOf("factsFromRegistry(undefined")),
    /plan\.reviewers\.length > 0/,
    "a non-empty plan is NOT enough: a SINGLE plan from the partial view is a denial",
  );
  // The authoritative view is warmed from real ctx registries, not invented.
  assert.match(SRC, /rememberJudgeFacts\(\(ctx as \{ modelRegistry\?: unknown \}\)\.modelRegistry\)/);
});

test("FAN-OUT wiring: slotSource stamp, config arg order, disk-fallback guards are all asserted", () => {
  // round-2 P2: deleting the slotSource stamp or swapping the
  // effectiveAgentsConfig(global, project) argument order left the suite
  // green (shard-3 mutation); removing the notify block or reverting the disk
  // fallback to planForFacts also stayed green (shard-1 mutations).
  const planAt = SRC.indexOf("function planForFacts(");
  const planner = SRC.slice(planAt, planAt + 1600);
  // The stamp itself now lives ONCE, in planConfiguredReviewFanout
  // (lib/review-fanout.ts), where test/review-fanout.test.ts pins its FULL text
  // behaviorally. Here we only pin that the extension DELEGATES and never grows
  // a second copy of that sentence (round-12 Nit).
  assert.match(planner, /return planConfiguredReviewFanout\(facts, reviewer\)/, "the slotted path must delegate to the shared helper");
  assert.doesNotMatch(planner, /plan\.slotSource =/, "the slot-source stamp must not be duplicated in the extension");
  assert.match(planner, /effectiveAgentsConfig\(projectConfig\.agentsGlobal, projectConfig\.agentsProject\)/, "config layering must be global-first, project-second");
  // The disk-fallback branch must (1) use the DEFAULT planner, not the slotted
  // one, and (2) stay SILENT when the user pinned slots (a default-path spec
  // would contradict the pin).
  const fanoutAt = SRC.indexOf("function fanoutDirective(");
  const fn = SRC.slice(fanoutAt, fanoutAt + 3000);
  const fallbackStart = fn.indexOf("factsFromRegistry(undefined");
  assert.ok(fallbackStart > 0);
  const fallback = fn.slice(Math.max(0, fallbackStart - 700), fallbackStart + 200);
  assert.match(fallback, /planFanoutFromFacts\(factsFromRegistry\(undefined/, "the disk view must use the DEFAULT planner");
  assert.doesNotMatch(fallback, /planForFacts\(factsFromRegistry\(undefined/, "the slotted path must never run on the disk view");
  assert.match(fallback, /rv\.auto === false && rv\.slots\.length > 0\) return undefined/, "pinned slots must silence the disk fallback");
  // The round-1 notify block must stay (a rejected chain must reach the user).
  const layersAt = SRC.indexOf("function ensureModelLayersRendered(");
  // (round-2 corrupt-guard: the fail-safe branches add ~12 lines, so the
  // window must comfortably cover the whole function.)
  const layers = SRC.slice(layersAt, layersAt + 6500);
  assert.match(layers, /ctx\.ui\.notify\(/, "layer problems must be notified");
  assert.match(layers, /problems\.slice\(0, 5\)/, "the notification must be bounded");
  // And the cross-layer reviewer-readonly guard (round-2 P2) + its dedup (round-3).
  assert.match(layers, /\["reviewer-readonly"\] = \{ auto: true, slots: \[\], source: "default"/, "global explicit reviewer-readonly must not be shadowed by a project follow");
  // The guard's DECISION CONDITION itself must be asserted, not just the
  // assignment: `if (true)` would pass the assignment regex and override the
  // project's explicit config (round-3 P2 mutation).
  assert.match(
    layers,
    /if \(explicitRR\(globalRaw\) && !explicitRR\(projectRaw\) && !map\["reviewer-readonly"\]\?\.malformed\)/,
    "the cross-layer guard must gate on BOTH layers' explicit config and skip malformed entries",
  );
  assert.match(layers, /lastLayerNotifyText/, "the notify dedup guard must exist (round-3 Nit)");
  // The dedup CONDITION must be asserted too: `if (true)` would re-notify on
  // every session start (round-3 P2 mutation).
  assert.match(
    layers,
    /if \(text !== lastLayerNotifyText\)/,
    "identical problems must not re-notify on every session start",
  );
  // The STATE WRITE must be asserted too: deleting `lastLayerNotifyText = text;`
  // makes the dedup a no-op while every condition regex stays green (round-4 P2).
  assert.match(layers, /lastLayerNotifyText = text;/, "the dedup state must be recorded");
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

test("explicitRR rejects malformed values (null / array) — not just the call site (round-4 P2)", () => {
  // Round-3 P2 mutation: replacing the explicitRR body with a bare
  // `typeof raw === "object"` check kept the whole suite green — the
  // predicate BODY must be asserted, not only its call site.
  const layersAt = SRC.indexOf("function ensureModelLayersRendered(");
  assert.ok(layersAt > 0, "ensureModelLayersRendered must exist");
  const layers = SRC.slice(layersAt, layersAt + 5000);
  const fnAt = layers.indexOf("const explicitRR");
  assert.ok(fnAt > 0, "explicitRR must exist");
  const body = layers.slice(fnAt, fnAt + 1200);
  assert.match(body, /raw === null/, "null must not count as an explicit config");
  assert.match(body, /Array\.isArray\(raw\)/, "an array must not count as an explicit config");
  // The INNER guard (the reviewer-readonly VALUE itself) must also be
  // asserted — round-10 P1 mutation: weakening it to a bare typeof check
  // kept the suite green because only the OUTER raw guards were covered.
  assert.match(body, /typeof rr !== "object" \|\| rr === null \|\| Array\.isArray\(rr\)/, "the rr VALUE must be a non-null non-array object");
});

test("explicitRR: CR/LF slot strings are invalid, like parseAgentsSection (round-11)", () => {
  // Round-11 P2: parseAgentsSection rejects CR/LF slots; the cross-layer
  // guard must apply the same rule or a malformed project entry could
  // wrongly suppress the global reviewer-readonly follow.
  const layers = SRC.slice(SRC.indexOf("function ensureModelLayersRendered("), SRC.indexOf("function ensureModelLayersRendered(") + 8000);
  const fnAt = layers.indexOf("const explicitRR");
  assert.ok(fnAt > 0);
  const body = layers.slice(fnAt, fnAt + 1600);
  assert.match(body, /!\/\[\\r\\n\]\/\.test/, "CR/LF slots must not count as an explicit config");
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
  const body = SRC.slice(at, at + 900);
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
  const fn = SRC.slice(at, at + 5000);
  assert.match(fn, /effectiveAgentsConfig\(projectConfig\.agentsGlobal \?\? undefined, undefined\)/);
  assert.match(fn, /effectiveAgentsConfig\(undefined, projectConfig\.agentsProject \?\? undefined\)/);
  assert.match(fn, /applyAgentConfigLayer\(/);
  assert.match(fn, /pathJoin\(primaryRepoRoot, "\.pi", "agents"\)/);
  const sessionAt = SRC.indexOf("pi.on(\"session_start\"");
  assert.ok(sessionAt > 0);
  const body = SRC.slice(sessionAt, sessionAt + 3000);
  assert.match(body, /ensureModelLayersRendered\(ctx\)/, "must be invoked at session start with the UI context");
  // Project-layer base must be the BUILT-IN package agents dir, never the
  // already-rendered global layer. Scope BOTH asserts to the PROJECT block
  // (round-9 P2: the old window was 800 chars while the sourceDir line sits
  // ~2200 chars past the block comment — the mutation sailed through).
  const layerBlock = SRC.slice(at, at + 5000);
  const projStart = layerBlock.indexOf("// Project layer of the CURRENT repo");
  assert.ok(projStart > 0);
  const projectBlock = layerBlock.slice(projStart, projStart + 3500);
  assert.match(
    projectBlock,
    /sourceDir: pathJoin\(packageRoot, "\.\.", "agents"\)/,
    "the project sourceDir must be the built-in defaults",
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

test("RESUME text: the unmet-gates branch also tells a waiting agent to pause_for_question", () => {
  // An agent that ASKED a grill/decision question but did not (yet) call
  // pause_for_question has no pausedQuestion set, so the auto-continuation
  // fires. The unmet-gates resume text must then REMIND it to pause instead
  // of blindly continuing to work — otherwise the follow-up steers the agent
  // away from the question it is already waiting on (live regression: agent
  // asked "决策 3 of 3", RESUME said only "Continue: fix → re-review …").
  const start = SRC.indexOf('pi.on("agent_settled"');
  const end = SRC.indexOf("// ---------- lifecycle ----------", start);
  const body = SRC.slice(start, end);
  // The main branch (problems > 0) must mention pause_for_question.
  assert.match(body, /problems\.length > 0[\s\S]{0,800}?pause_for_question/s,
    "unmet-gates resume must advise pause_for_question when the agent waits on the user");
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

test("propose_loop_goal: confirm/reject may carry a user REASON (input after the dialog)", () => {
  // The user can answer "确认 + 原因" / "拒绝 + 原因" — a reason input follows
  // the Yes/No dialog. A rejection reason must be handed back to the agent so
  // it renegotiates against the real objection; an approval reason is
  // persisted with the confirmation and echoed to the agent.
  const start = SRC.indexOf('name: "propose_loop_goal"');
  assert.ok(start > 0);
  const body = SRC.slice(start, start + 8000);
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
  // The window is a reading heuristic, not a contract: the P-multi reset
  // block, no-UI mode forcing, the normal-mode no-arm comment and the
  // snapshot cleanup at the handler head keep pushing the notice section down.
  const body = SRC.slice(at, at + 8400);
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
  assert.match(SRC, /SHARD_THRESHOLD_FILES/);
  assert.match(SRC, /SHARD_THRESHOLD_LINES/);
});

// ---- Tiered parallel review trigger ----

test("tiered trigger: prepare_review shards a large diff ITSELF (mechanical, not improvised)", () => {
  // Review moved off the engine, which moved the fan-out decision to the main
  // agent — and "it split the diff into disjoint groups covering every file" is
  // not something a prompt can guarantee. So the tool computes the split.
  const at = SRC.indexOf('name: "prepare_review"');
  assert.ok(at > 0, "prepare_review must exist");
  // Window covers the whole handler: it now plans, snapshots AND renders each
  // shard's task text, so it is long by design.
  const body = SRC.slice(at, at + 16000);
  assert.match(body, /shouldShardReview\(fileCount, lineCount\)/, "the tiered threshold decides");
  assert.match(body, /planReviewShards\(/, "the split must come from the tested planner");
  assert.match(body, /listChangedFiles\(target\.root\)/);
  assert.match(body, /countDiffLines\(target\.root/);
  assert.match(body, /tier: "single"|tier = "sharded"/);
  // Each shard's ready-made task text comes from the same pure builder, so the
  // file list the reviewer is told to audit cannot drift from the plan.
  assert.match(body, /buildShardPrompt\(shard/);
  // The merged record shape stays a single source of truth.
  assert.match(body, /formatShardReviewRecord\(/);
  // And the engine path is really gone.
  assert.doesNotMatch(SRC, /runParallelShardReview/);
  assert.doesNotMatch(SRC, /run_parallel_shard_review"/);
});

test("wave tools: prepare_wave + apply_wave_patches replace the engine tool", () => {
  // Step 2 of docs/handoff-remove-pdw.md: the pdw engine tool is gone. The
  // wave flow is prepare_wave (reconcile + ready-made tasks) → the main agent
  // spawns worker-readonly subagents → apply_wave_patches (ownership +
  // persistence + git apply --check).
  const at = SRC.indexOf('name: "prepare_wave"');
  assert.ok(at > 0, "prepare_wave must exist");
  const body = SRC.slice(at, SRC.indexOf('name: "apply_wave_patches"'));
  assert.match(body, /computeWave/, "prepare_wave must reconcile the wave against the plan");
  assert.match(body, /WAVE_WORKER_SCHEMA/, "prepare_wave must hand out the worker output schema");
  assert.match(body, /worker-readonly/, "the tasks must name the read-only worker agent");
  assert.match(body, /IN THE SAME TURN/, "the spawn directive must be same-turn concurrent");
  const applyAt = SRC.indexOf('name: "apply_wave_patches"');
  assert.ok(applyAt > 0, "apply_wave_patches must exist");
  const applyBody = SRC.slice(applyAt, applyAt + 8000);
  assert.match(applyBody, /validatePatchOwnership/, "ownership is re-validated mechanically");
  assert.match(applyBody, /writeWavePatches/, "patches are persisted under .pi/plan/patches/");
  assert.match(applyBody, /checkPatchApplies/, "git apply is pre-checked");
  assert.match(applyBody, /FAILED MODULES/, "a missing result is a failed module, never applied");
  assert.match(applyBody, /unplannedModuleIds/, "unplanned-module rejection must be wired to apply_wave_patches");
  assert.match(applyBody, /unknownResultModuleIds/, "unknown-result rejection must be wired to apply_wave_patches");
  assert.match(applyBody, /duplicateResultModuleIds/, "duplicate-result rejection must be wired to apply_wave_patches");
  assert.match(applyBody, /ownedPathsFromPlan/, "ownership must come from the plan through the pure helper");
  // The engine tool must not come back.
  assert.equal(SRC.includes("run_wave_workflow"), false, "the pdw wave tool is gone");
  assert.equal(SRC.includes("runWaveWorkflow"), false, "the engine wrapper is gone from the extension");
});

test("STALE TREE: a READY cannot bind to a tree the reviewer never saw", () => {
  // The fail-open this feature would otherwise CREATE: the agent is told to
  // fix while the review runs, so at record time the worktree can differ from
  // what the reviewer read. Binding the READY to the current fingerprint would
  // approve unreviewed code, while every doc promised "the gate asks for
  // another round". The comparison makes that promise mechanical.
  const at = SRC.indexOf('name: "record_review"');
  const body = SRC.slice(at, at + 12000);
  assert.match(body, /reviewedTree\.get\(targetRoot\)/, "record_review must know what was reviewed");
  // The DECISION is a pure function now (lib/verdict-guards.ts), because the
  // inline version was only shape-locked here — a mutation neutralized it with
  // the suite still green. This asserts the WIRING; the truth table lives in
  // test/verdict-guards.test.ts, where a mutant actually dies.
  assert.match(body, /applyVerdictGuards\(\{/, "the guards must be applied");
  assert.match(body, /snapshotDrifts,/, "drift facts must be handed to the guard");
  assert.match(body, /parsed\.verdict = guarded\.verdict/, "the guarded verdict must be the one recorded");
  assert.match(body, /STALE TREE/, "the user must be told why a READY did not bind");
  // Fail closed when the tree cannot be read: unknown is never treated as same.
  assert.match(body, /catch \{ currentTree = undefined; \}/);

  // Every dispatch path must register what its reviewers saw. There is now
  // exactly ONE such path — prepare_review — because the engine path (which
  // could not give a reviewer its own snapshot) is gone.
  assert.match(SRC, /reviewedTree\.set\(target\.root, snaps\[0\]!\.tree\)/, "prepare_review path");
  // …and a dispatch WITHOUT isolation must clear it, or a stale value from an
  // earlier round would block an honest READY.
  assert.match(SRC, /reviewedTree\.delete\(target\.root\)/);
  assert.match(SRC, /reviewedTree\.clear\(\)/, "session_start must not leak a previous session's tree");
});

test("REGRESSION: splitting record_review calls cannot skip snapshot verification", () => {
  // Two reviewers = two record_review calls. An earlier version consumed and
  // deleted every snapshot on the FIRST call, so the second reviewer's verdict
  // was recorded unverified and a drifted READY could ship.
  const verifyAt = SRC.indexOf("function verifyPreparedSnapshots(");
  assert.ok(verifyAt > 0, "verification must be separable from cleanup");
  const verifyBody = SRC.slice(verifyAt, SRC.indexOf("function releasePreparedSnapshots("));
  assert.doesNotMatch(verifyBody, /preparedSnapshots\.delete/, "verifying must NOT drop the set");
  assert.doesNotMatch(verifyBody, /removeReviewSnapshot/, "verifying must not destroy the evidence");

  // record_review verifies; only a NEW round (or session start) releases.
  const recAt = SRC.indexOf('name: "record_review"');
  const recBody = SRC.slice(recAt, recAt + 12000);
  assert.match(recBody, /verifyPreparedSnapshots\(targetRoot\)/);
  assert.doesNotMatch(recBody, /releasePreparedSnapshots\(/, "record_review must not clear the round");
  const prepAt = SRC.indexOf('name: "prepare_review"');
  assert.match(SRC.slice(prepAt, prepAt + 12000), /releasePreparedSnapshots\(target\.root\)/);
});

test("REGRESSION: drift found at prepare time WITHDRAWS a standing READY", () => {
  // The laundering path: record a READY, then prepare the next round — if the
  // previous round's drift only became an informational note, the untrustworthy
  // READY would still be sitting in the state, ready to ship.
  const prepAt = SRC.indexOf('name: "prepare_review"');
  const body = SRC.slice(prepAt, prepAt + 12000);
  assert.match(body, /stale\.length > 0/);
  assert.match(body, /st\.review\.verdict === "READY"/);
  assert.match(body, /verdict: "BLOCKED", fingerprint: null/);
});
test("SNAPSHOT INTEGRITY: record_review verifies the round's snapshots MECHANICALLY", () => {
  // The check must not depend on the agent pasting a helper's output: an
  // honour-based integrity check is no check at all.
  const at = SRC.indexOf('name: "record_review"');
  assert.ok(at > 0, "record_review must exist");
  const body = SRC.slice(at, SRC.indexOf('name: "run_precommit"', at));
  assert.match(body, /verifyPreparedSnapshots\(targetRoot\)/, "every prepared snapshot must be verified here");
  // Tighten-only: drift may withhold a READY, never manufacture one. The
  // decision itself is behaviourally tested in test/verdict-guards.test.ts
  // (mutating it there fails 2 cases); here we only pin that record_review
  // routes through it and records ITS verdict.
  assert.match(body, /applyVerdictGuards\(\{/);
  assert.match(body, /parsed\.verdict = guarded\.verdict/);
  assert.doesNotMatch(body, /snapshotDrifts[\s\S]{0,120}parsed\.verdict = "READY"/);
  // Drift parked by an out-of-order prepare_review must still be consumed here,
  // or a polluted READY could be laundered by calling prepare first.
  assert.match(body, /pendingDrift\.get\(targetRoot\)/);
  assert.match(body, /pendingDrift\.delete\(targetRoot\)/);
  // The reason has to reach the transcript, not only the details payload.
  assert.match(body, /SNAPSHOT INTEGRITY/);

  // Cleanup is a SEPARATE step from verification (see the call-splitting
  // regression below): a round is released when the next one is prepared, not
  // when its first verdict is recorded.
  const releaseAt = SRC.indexOf("function releasePreparedSnapshots(");
  assert.ok(releaseAt > 0);
  const release = SRC.slice(releaseAt, releaseAt + 900);
  assert.match(release, /verifyPreparedSnapshots\(repoRoot\)/);
  assert.match(release, /removeReviewSnapshot\(snap, repoRoot\)/);
  assert.match(release, /preparedSnapshots\.delete\(repoRoot\)/);
});

test("REGRESSION: prepare_review REFUSES a partial plan, and the refusal is wired", () => {
  // Round 4 extracted the DECISION into lib/verdict-guards.ts (behaviourally
  // tested there). Round 5 found the other half: neutralizing the WIRING
  // (`if (planDecision.kind === "partial")` → `if (false)`) still left the whole
  // suite green. A guard nobody notices missing is not a guard, so the wiring is
  // pinned here — shape assertions are the only lever on extension-internal
  // control flow, so they must be specific.
  const at = SRC.indexOf('name: "prepare_review"');
  assert.ok(at > 0);
  const body = SRC.slice(at, at + 16000);

  // 1. The decision comes from the tested pure function, over SANITIZED labels
  //    on both sides (comparing raw labels to sanitized instances once flagged
  //    `a/b` as a failed reviewer and refused a perfectly good plan).
  assert.match(body, /decideSnapshotPlan\(labels, snaps\.map\(\(s\) => s\.instance\)\)/);
  assert.match(body, /\.map\(\(l\) => safeLabel\(l\)\)/, "labels must be sanitized before planning");

  // 2. Partial ⇒ refuse. The branch must exist, must be an ERROR (not a
  //    best-effort continue), must name what failed, and must not leave the
  //    successful snapshots behind.
  const partialAt = body.indexOf('planDecision.kind === "partial"');
  assert.ok(partialAt > 0, "the partial branch must exist and be keyed on the decision");
  const partialBody = body.slice(partialAt, partialAt + 1800);
  assert.match(partialBody, /removeReviewSnapshot\(snap, target\.root\)/, "clean up what was created");
  assert.match(partialBody, /isError: true/, "a partial plan must FAIL the call");
  assert.match(partialBody, /planDecision\.failedLabels/, "the failed reviewers must be named");
  assert.match(partialBody, /Refusing a/i);
  // It must NOT hand back a usable plan on this path.
  assert.doesNotMatch(partialBody, /preparedSnapshots\.set/);
  assert.doesNotMatch(partialBody, /reviewedTree\.set/);

  // 3. "none" is the other decision, and it is a SOFT fallback (not an error):
  //    reviewing in place under the old rules is still reviewing.
  const noneAt = body.indexOf('planDecision.kind === "none"');
  assert.ok(noneAt > 0 && noneAt !== partialAt, "the none branch must be distinct from partial");
});

test("prepare_review hands out per-reviewer isolation and fails SOFT", () => {
  const at = SRC.indexOf('name: "prepare_review"');
  assert.ok(at > 0, "prepare_review must be registered");
  const body = SRC.slice(at, at + 16000);
  // One snapshot per label — never one shared copy for several reviewers.
  assert.match(body, /for \(const label of labels\)[\s\S]{0,200}createReviewSnapshot\(/);
  assert.match(body, /buildStreamConsumerDirective\(/, "the agent must be told how to consume the stream");
  assert.match(body, /buildStreamDirective\(/, "the reviewer instruction must be handed over");
  // The verdict SCHEMA must reach the agent, not merely be re-exported: a
  // spawned reviewer only produces machine-checkable output if it is handed an
  // `outputSchema`. Reverting this to an unused export would otherwise be
  // invisible — the schema's own shape test would still pass.
  assert.match(body, /JSON\.stringify\(SHARD_VERDICT_SCHEMA/, "the schema must be printed for the agent");
  assert.match(body, /outputSchema/, "and named as the outputSchema to spawn with");
  // A host without worktree support must keep reviewing under the OLD rules,
  // not silently lose the safety they provided — and the mechanical half of that
  // fallback is a static read-only agent, because pi-subagents has no per-call
  // tool denylist.
  assert.match(body, /isolation UNAVAILABLE/);
  assert.match(body, /reviewer-readonly/, "the fallback must name the agent that CANNOT write");
  assert.match(body, /do NOT apply fixes until/i);
});

// P0 regression (pi package layout): pi loads the extension entry IN PLACE via
// jiti, so every relative import must resolve to a REAL sibling path — the old
// `./lib/*` specifiers only worked because install-global.sh copied lib/
// next to review-gate.ts (that installer is gone). This test would have
// caught the break immediately.
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
