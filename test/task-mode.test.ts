import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildModeConfirmMessage,
  evaluateModeChange,
  GATE_MODE_DECISION_DIRECTIVE,
  MODE_REASON_MAX_CHARS,
  normalizeTaskMode,
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
});

test("normalizeTaskMode fails closed on unknown or non-string values", () => {
  for (const v of ["readonly", "free", "EXPLORE", "NORMAL", "", 42, null, undefined, {}]) {
    assert.equal(normalizeTaskMode(v), undefined, String(v));
  }
});

test("rank order is normal < explore < loop", () => {
  assert.ok(TASK_MODE_RANK.normal < TASK_MODE_RANK.explore);
  assert.ok(TASK_MODE_RANK.explore < TASK_MODE_RANK.loop);
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
  assert.deepEqual(decide({ current: undefined, requested: "normal" }), { action: "confirm" });
  assert.deepEqual(decide({ current: undefined, requested: "normal", hasChanges: true }),
    { action: "confirm" });
});

// ---------------------------------------------------------------------------
// evaluateModeChange — firstDecideAuto (USER REQUIREMENT: DeepSeek V4 first
// classification applies automatically, no consent dialog)

test("USER REQUIREMENT: the first LLM classification applies automatically — even normal", () => {
  // The user opted out of the FIRST confirmation dialog: an LLM-backed first
  // verdict on a clean interactive session is applied directly with source
  // auto (the git hooks stay fully enforced).
  for (const requested of ["loop", "explore", "normal"] as const) {
    assert.deepEqual(decide({ current: undefined, requested, firstDecideAuto: true }),
      { action: "apply", source: "auto" }, requested);
  }
});

test("SECURITY: firstDecideAuto never loosens a dirty session, a no-UI session, or a decided session", () => {
  // The LLM runs only pre-work (no tracked changes) — once loop-rules edits
  // exist, "classifying" the session is a real downgrade and needs consent.
  assert.equal(decide({ current: undefined, requested: "normal", firstDecideAuto: true, hasChanges: true }).action, "confirm");
  assert.equal(decide({ current: undefined, requested: "explore", firstDecideAuto: true, hasChanges: true }).action, "confirm");
  // print/JSON mode: the no-UI rule decides first — normal applies (the gate
  // steps aside), and the LLM's other verdicts are refused outright.
  assert.deepEqual(decide({ current: undefined, requested: "normal", firstDecideAuto: true, hasUI: false }),
    { action: "apply", source: "auto" });
  assert.equal(decide({ current: undefined, requested: "loop", firstDecideAuto: true, hasUI: false }).action, "reject");
  // firstDecideAuto only covers the FIRST decision: later downgrades keep
  // asking the user even though the flag may still be passed.
  assert.equal(decide({ current: "loop", requested: "explore", firstDecideAuto: true }).action, "confirm");
  assert.equal(decide({ current: "explore", requested: "normal", firstDecideAuto: true }).action, "confirm");
});

test("SECURITY: firstDecideAuto with the downgrade lock still rejects", () => {
  const d = decide({ current: undefined, requested: "normal", firstDecideAuto: true, downgradesLocked: true });
  assert.equal(d.action, "reject");
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

test("the undecided-session directive instructs an in-session set_gate_mode call", () => {
  assert.match(GATE_MODE_DECISION_DIRECTIVE, /set_gate_mode/);
  assert.match(GATE_MODE_DECISION_DIRECTIVE, /fail-closed/);
  assert.match(GATE_MODE_DECISION_DIRECTIVE, /"loop" \(the safe default\)/);
  // USER REQUIREMENT: the first classification is automated (DeepSeek V4),
  // no confirmation dialog.
  assert.match(GATE_MODE_DECISION_DIRECTIVE, /applied AUTOMATICALLY/);
});
