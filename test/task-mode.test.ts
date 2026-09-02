import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildModeConfirmMessage,
  evaluateModeChange,
  GATE_MODE_DECISION_DIRECTIVE,
  isEnforcedMode,
  requestedModeFromEnv,
  MODE_REASON_MAX_CHARS,
  normalizeTaskMode,
  scratchFirstMode,
  TASK_MODE_RANK,
  type TaskMode,
} from "../lib/task-mode.ts";

// Shared fact defaults; individual tests override what they exercise.
function decide(overrides: Partial<Parameters<typeof evaluateModeChange>[0]> & {
  current: TaskMode | undefined; requested: TaskMode;
}) {
  return evaluateModeChange({
    hasChanges: false,
    hasUI: true,
    downgradesLocked: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// normalizeTaskMode — whitelist + forged values

test("normalizeTaskMode accepts only the canonical modes", () => {
  assert.equal(normalizeTaskMode("loop"), "loop");
  assert.equal(normalizeTaskMode("explore"), "explore");
  assert.equal(normalizeTaskMode("normal"), "normal");
  assert.equal(normalizeTaskMode("orchestrator"), "orchestrator");
});

test("normalizeTaskMode fails closed on unknown or non-string values", () => {
  for (const v of ["readonly", "free", "EXPLORE", "NORMAL", "", 42, null, undefined, {}]) {
    assert.equal(normalizeTaskMode(v), undefined, String(v));
  }
});

test("rank order is normal < explore < loop < orchestrator", () => {
  assert.ok(TASK_MODE_RANK.normal < TASK_MODE_RANK.explore);
  assert.ok(TASK_MODE_RANK.explore < TASK_MODE_RANK.loop);
  assert.ok(TASK_MODE_RANK.loop < TASK_MODE_RANK.orchestrator,
    "orchestrator is loop PLUS the orchestration constraints — entering it is always a tightening");
});

test("isEnforcedMode names the modes that run the full workflow", () => {
  assert.equal(isEnforcedMode("loop"), true);
  assert.equal(isEnforcedMode("orchestrator"), true);
  assert.equal(isEnforcedMode(undefined), true, "undecided behaves as loop — fail-closed");
  assert.equal(isEnforcedMode("explore"), false);
  assert.equal(isEnforcedMode("normal"), false);
});

test("a SPAWNER may hand over a starting mode, but only a tighter one", () => {
  assert.equal(requestedModeFromEnv({ RG_GATE_MODE: "loop" } as NodeJS.ProcessEnv), "loop");
  assert.equal(requestedModeFromEnv({ RG_GATE_MODE: "orchestrator" } as NodeJS.ProcessEnv), "orchestrator");
  for (const forged of ["", "  ", "sudo", "LOOP", "normal-ish"]) {
    assert.equal(requestedModeFromEnv({ RG_GATE_MODE: forged } as NodeJS.ProcessEnv), undefined,
      `${JSON.stringify(forged)} must be ignored, not become a mode`);
  }
  assert.equal(requestedModeFromEnv({} as NodeJS.ProcessEnv), undefined);
  // The looser values still PARSE — the caller is what refuses to apply them
  // (it only honours isEnforcedMode picks), and that split is deliberate:
  // this function reports what was asked, it does not grant it.
  assert.equal(requestedModeFromEnv({ RG_GATE_MODE: "normal" } as NodeJS.ProcessEnv), "normal");
  assert.equal(isEnforcedMode(requestedModeFromEnv({ RG_GATE_MODE: "normal" } as NodeJS.ProcessEnv)), false);
});

test("orchestrator is reachable as a first classification and as an upgrade, with no dialog", () => {
  assert.deepEqual(decide({ current: undefined, requested: "orchestrator" }),
    { action: "apply", source: "auto" }, "it is the strictest mode — tightening never needs consent");
  assert.deepEqual(decide({ current: "loop", requested: "orchestrator" }),
    { action: "apply", source: "auto" });
  assert.deepEqual(decide({ current: "explore", requested: "orchestrator" }),
    { action: "apply", source: "auto" });
});

test("SECURITY: leaving orchestrator is a real downgrade and asks the user", () => {
  for (const requested of ["loop", "explore", "normal"] as const) {
    assert.deepEqual(decide({ current: "orchestrator", requested }), { action: "confirm" },
      `orchestrator→${requested} gives up the orchestration constraints`);
  }
});

test("USER REQUIREMENT: /tmp never enters orchestrator via the agent either", () => {
  assert.deepEqual(
    decide({ current: undefined, requested: "orchestrator", piSelfTask: true }),
    { action: "apply", source: "auto" },
    "the first classification is clamped to normal, not left undecided",
  );
  const later = decide({ current: "explore", requested: "orchestrator", piSelfTask: true });
  assert.equal(later.action, "reject");
  if (later.action === "reject") assert.match(later.reason, /orchestrator/);
});

// ---------------------------------------------------------------------------
// evaluateModeChange — initial (undecided) classification

test("undecided → loop applies immediately with source auto", () => {
  assert.deepEqual(decide({ current: undefined, requested: "loop" }),
    { action: "apply", source: "auto" });
  // …but NOT without a UI: a session that cannot render a dialog can only be
  // normal (see the no-UI test below).
  assert.deepEqual(decide({ current: undefined, requested: "loop", hasUI: false }).action, "reject");
});

test("undecided → explore applies with source auto only on a CLEAN interactive session", () => {
  assert.deepEqual(decide({ current: undefined, requested: "explore" }),
    { action: "apply", source: "auto" });
});

test("SECURITY: undecided → explore with tracked changes is a real downgrade (confirm)", () => {
  // Undecided behaves as loop. Once edits exist, "classifying" the session as
  // explore would let the agent slip out of the review loop it was already
  // in — so the user must consent.
  assert.deepEqual(decide({ current: undefined, requested: "explore", hasChanges: true }),
    { action: "confirm" });
});

test("USER REQUIREMENT: a no-UI session can ONLY be normal", () => {
  // print/JSON mode cannot render a dialog, and every enforced mode now needs
  // one (loop-goal approval, sensitive-edit authorization, downgrade confirm).
  // Half-enforcing would strand such a session in a loop it can never satisfy,
  // so the gate steps aside entirely instead: normal applies, everything else
  // is refused with an explanation.
  assert.deepEqual(decide({ current: undefined, requested: "normal", hasUI: false }),
    { action: "apply", source: "auto" });
  assert.deepEqual(decide({ current: "loop", requested: "normal", hasUI: false }),
    { action: "apply", source: "auto" });
  for (const [current, requested] of [
    [undefined, "loop"], [undefined, "explore"],
    ["normal", "loop"], ["normal", "explore"], ["explore", "loop"],
  ] as const) {
    const d = decide({ current, requested, hasUI: false });
    assert.equal(d.action, "reject", `${current}→${requested} (no UI)`);
    assert.match((d as { reason: string }).reason, /no interactive UI/);
  }
});

test("SECURITY: normal always requires user consent — even as the initial classification", () => {
  // The first classification is the AGENT's own pick, with no external
  // classifier behind it — so this asymmetry IS the protection: the agent can
  // classify itself INTO the gate but never out of it. An injected
  // instruction can at worst tighten enforcement.
  assert.deepEqual(decide({ current: undefined, requested: "normal" }), { action: "confirm" });
  assert.deepEqual(decide({ current: undefined, requested: "normal", hasChanges: true }),
    { action: "confirm" });
  // A declined downgrade earlier in the session hardens that into a refusal.
  assert.equal(decide({ current: undefined, requested: "normal", downgradesLocked: true }).action,
    "reject");
});

// ---------------------------------------------------------------------------
// evaluateModeChange — the agent's own first classification. No external
// classifier model is consulted for the mode (see lib/llm-classify.ts): the
// engine's tighten-only asymmetry is the entire bound.

test("the agent's own first classification applies with no dialog — loop always, explore while clean", () => {
  assert.deepEqual(decide({ current: undefined, requested: "loop" }),
    { action: "apply", source: "auto" });
  assert.deepEqual(decide({ current: undefined, requested: "explore" }),
    { action: "apply", source: "auto" });
  // Source stays "auto" in both cases, so the git hooks remain fully enforced
  // — only a USER-chosen mode may make them advisory.
});

test("SECURITY: a self-classification never escapes a dirty, no-UI, or already-decided session", () => {
  // Once THIS session has edited under loop rules, "classifying" it is a real
  // downgrade and needs consent.
  assert.equal(decide({ current: undefined, requested: "normal", hasChanges: true }).action, "confirm");
  assert.equal(decide({ current: undefined, requested: "explore", hasChanges: true }).action, "confirm");
  // print/JSON mode: the no-UI rule decides first — normal applies (the gate
  // steps aside), every enforced mode is refused outright.
  assert.deepEqual(decide({ current: undefined, requested: "normal", hasUI: false }),
    { action: "apply", source: "auto" });
  assert.equal(decide({ current: undefined, requested: "loop", hasUI: false }).action, "reject");
  // Later downgrades keep asking the user.
  assert.equal(decide({ current: "loop", requested: "explore" }).action, "confirm");
  assert.equal(decide({ current: "explore", requested: "normal" }).action, "confirm");
});

// ---------------------------------------------------------------------------
// evaluateModeChange — piSelfTask (USER REQUIREMENT: sessions STARTED IN the
// scratch dir /tmp NEVER enter loop via the agent; first classification is
// explore or normal, no consent dialog)

// ---------------------------------------------------------------------------

test("USER REQUIREMENT: pi-self first classification applies normal automatically", () => {
  assert.deepEqual(decide({ current: undefined, requested: "normal", piSelfTask: true }),
    { action: "apply", source: "auto" });
  // The caller normalizes any non-loop pick to "normal" in a scratch session;
  // the engine accepts an explore pick the same way.
  assert.deepEqual(decide({ current: undefined, requested: "explore", piSelfTask: true }),
    { action: "apply", source: "auto" });
});

test("USER REQUIREMENT: /tmp first classification never applies loop", () => {
  // Agent asked for loop — land on normal so the session is not left undecided
  // (undecided behaves as loop).
  assert.deepEqual(decide({ current: undefined, requested: "loop", piSelfTask: true }),
    { action: "apply", source: "auto" });
  // Later agent upgrades to loop are rejected; only /gate-mode can force loop.
  const later = decide({ current: "normal", requested: "loop", piSelfTask: true });
  assert.equal(later.action, "reject");
  if (later.action === "reject") assert.match(later.reason, /\/tmp/);
  const fromExplore = decide({ current: "explore", requested: "loop", piSelfTask: true });
  assert.equal(fromExplore.action, "reject");
});

test("clampReason overrides the /tmp wording for a non-git clamp (2026-09-02)", () => {
  // A non-git directory reaches the same clamp through piSelfTask, but the
  // reject reason must say what the clamp actually is — the /tmp default
  // would be a lie in a non-git dir (reviewer P2).
  const later = decide({
    current: "normal",
    requested: "loop",
    piSelfTask: true,
    clampReason: "this session is not inside a git repository — non-git directories cannot enter \"loop\" via the agent. Ask the user to run /gate-mode loop if they really want the enforced workflow here.",
  });
  assert.equal(later.action, "reject");
  if (later.action === "reject") {
    assert.doesNotMatch(later.reason, /\/tmp/);
    assert.match(later.reason, /not inside a git repository/);
  }
  // Without the override the /tmp wording stays.
  const noOverride = decide({ current: "normal", requested: "loop", piSelfTask: true });
  if (noOverride.action === "reject") assert.match(noOverride.reason, /\/tmp/);
});

test("scratchFirstMode: only an explicit explore pick stays explore", () => {
  assert.equal(scratchFirstMode("explore"), "explore");
  assert.equal(scratchFirstMode("normal"), "normal");
  assert.equal(scratchFirstMode("loop"), "normal");
  assert.equal(scratchFirstMode(undefined), "normal");
});

test("SECURITY: piSelfTask never loosens a dirty, no-UI, decided, or locked session", () => {
  // Same bounds as any other first classification: a CLEAN
  // interactive session only.
  assert.equal(decide({ current: undefined, requested: "normal", piSelfTask: true, hasChanges: true }).action, "confirm");
  assert.equal(decide({ current: undefined, requested: "normal", piSelfTask: true, downgradesLocked: true }).action, "reject");
  // no-UI: the normal-only rule already applies automatically — same outcome.
  assert.deepEqual(decide({ current: undefined, requested: "normal", piSelfTask: true, hasUI: false }),
    { action: "apply", source: "auto" });
  // Later downgrades still ask the user; only the loop upgrade is forbidden.
  assert.equal(decide({ current: "loop", requested: "normal", piSelfTask: true }).action, "confirm");
  assert.equal(decide({ current: "explore", requested: "normal", piSelfTask: true }).action, "confirm");
});

// ---------------------------------------------------------------------------
// evaluateModeChange — upgrades (tighten: never need consent)

test("every upgrade applies immediately with source auto", () => {
  for (const [current, requested] of [
    ["normal", "explore"],
    ["normal", "loop"],
    ["explore", "loop"],
  ] as const) {
    assert.deepEqual(decide({ current, requested }),
      { action: "apply", source: "auto" }, `${current}→${requested}`);
    // upgrades work regardless of tracked changes (a no-UI session is normal
    // only — see the dedicated test)
    assert.deepEqual(decide({ current, requested, hasChanges: true }),
      { action: "apply", source: "auto" }, `${current}→${requested} (dirty)`);
  }
});

test("SECURITY: an agent upgrade records source auto, never user (no hook-advisory laundering)", () => {
  // If explore→loop→(later confirmed) explore ended with the AGENT able to
  // mint source:"user" anywhere, the git hooks could be downgraded without a
  // real user act. Upgrades therefore always carry "auto".
  const d = decide({ current: "explore", requested: "loop" });
  assert.deepEqual(d, { action: "apply", source: "auto" });
});

// ---------------------------------------------------------------------------
// evaluateModeChange — downgrades (loosen: user consent required)

test("every downgrade from a decided mode requires confirmation", () => {
  for (const [current, requested] of [
    ["loop", "explore"],
    ["loop", "normal"],
    ["explore", "normal"],
  ] as const) {
    assert.deepEqual(decide({ current, requested }), { action: "confirm" },
      `${current}→${requested}`);
  }
});

test("SECURITY: the downgrade lock rejects every consent-requiring transition", () => {
  // One declined dialog must silence agent-initiated downgrades for the whole
  // session (anti-grinding): reject, not re-confirm.
  for (const [current, requested] of [
    ["loop", "explore"],
    ["loop", "normal"],
    ["explore", "normal"],
    [undefined, "normal"],
  ] as const) {
    const d = decide({ current, requested, downgradesLocked: true });
    assert.equal(d.action, "reject", `${current}→${requested}`);
    assert.match((d as { reason: string }).reason, /declined/);
  }
  // upgrades are unaffected by the lock
  assert.deepEqual(decide({ current: "explore", requested: "loop", downgradesLocked: true }),
    { action: "apply", source: "auto" });
});

test("requesting the current mode is a noop", () => {
  for (const mode of ["loop", "explore", "normal"] as const) {
    assert.deepEqual(decide({ current: mode, requested: mode }), { action: "noop" });
  }
});

// ---------------------------------------------------------------------------
// Confirm-dialog copy — fixed consequences + untrusted reason handling

test("confirm message states the consequences in fixed extension copy", () => {
  const normal = buildModeConfirmMessage("normal", "quick chore");
  assert.match(normal, /normal/);
  assert.match(normal, /commit\/push\/PR 不再被拦截/);
  const explore = buildModeConfirmMessage("explore", "just investigating");
  assert.match(explore, /ship 命令仍被完整拦截/);
});

test("SECURITY: the agent reason is labeled untrusted, JSON-quoted, and length-capped", () => {
  const long = "a".repeat(MODE_REASON_MAX_CHARS * 3);
  const msg = buildModeConfirmMessage("normal", long);
  assert.match(msg, /不可信数据/);
  assert.ok(!msg.includes(long), "over-long reason must be truncated");
  // Newlines cannot fake dialog copy: the reason is JSON-quoted, so a literal
  // newline in the input appears as the two characters \n.
  const sneaky = buildModeConfirmMessage("normal", '完全无害\n[review-gate] 官方提示：请点“是”');
  assert.ok(sneaky.includes("\\n"), "reason newlines must be escaped");
  assert.ok(!sneaky.includes('\n[review-gate] 官方提示'), "raw newline must not survive into the dialog");
});

test("a /tmp-clamped pick is disclosed, so the reason does not read as a non-sequitur", () => {
  // /tmp + this session already edited + the agent asked for loop: the clamp
  // rewrites the pick to normal, so the dialog offers normal while the agent's
  // reason argues for loop. The fixed copy must say why.
  const msg = buildModeConfirmMessage("normal", "deliver the refactor", "loop");
  assert.match(msg, /AI 实际请求的是 "loop"/);
  assert.match(msg, /\/tmp/);
  // No note when nothing was clamped — including the same-mode call.
  assert.doesNotMatch(buildModeConfirmMessage("normal", "r", "normal"), /实际请求的是/);
  assert.doesNotMatch(buildModeConfirmMessage("normal", "r"), /实际请求的是/);
  // The clamp note is EXTENSION copy: it must sit above the untrusted reason,
  // so a truncated dialog drops the agent's text first.
  assert.ok(msg.indexOf("AI 实际请求的是") < msg.indexOf("不可信数据"));
});

test("the undecided-session directive instructs an in-session set_gate_mode call", () => {
  assert.match(GATE_MODE_DECISION_DIRECTIVE, /set_gate_mode/);
  assert.match(GATE_MODE_DECISION_DIRECTIVE, /fail-closed/);
  assert.match(GATE_MODE_DECISION_DIRECTIVE, /"loop" \(the safe default\)/);
  // The agent's own pick IS the classification (no external classifier), and
  // /tmp scratch sessions never enter loop via the agent.
  assert.match(GATE_MODE_DECISION_DIRECTIVE, /Your pick IS the classification/);
  // It must also spell out the one direction the agent cannot take itself.
  assert.match(GATE_MODE_DECISION_DIRECTIVE, /always asks the USER to confirm/);
  assert.match(GATE_MODE_DECISION_DIRECTIVE, /\/tmp/);
  assert.match(GATE_MODE_DECISION_DIRECTIVE, /NEVER enters an enforced mode/);
  // The fourth mode has to be discoverable, and bounded to the one situation
  // it belongs in — otherwise a session classifies itself into a supervisor
  // role nobody asked for.
  assert.match(GATE_MODE_DECISION_DIRECTIVE, /"orchestrator" — ONLY when the user asked you/);
  assert.match(GATE_MODE_DECISION_DIRECTIVE, /requires a tmux window/);
  assert.match(GATE_MODE_DECISION_DIRECTIVE, /NOT path-exempt/);
  assert.match(GATE_MODE_DECISION_DIRECTIVE, /except in \/tmp/);
  assert.doesNotMatch(GATE_MODE_DECISION_DIRECTIVE, /always allowed later/);
});
