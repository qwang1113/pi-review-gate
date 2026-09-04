/**
 * The mode registry is the single place that says what each mode IS:
 * eight entries (four session modes + undecided + three internal
 * reporting-shell modes), each with prompt + enforcement label + tool
 * policy, and one resolver from (taskMode, judgeRole, kind).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  GATE_MODES,
  JUDGE_COMPLETION_DISCIPLINE,
  JUDGE_DENIED_TOOLS,
  MODE_REGISTRY,
  judgeDeniedReason,
  resolveGateMode,
} from "../lib/gate-modes.ts";
import { isEnforcedMode } from "../lib/task-mode.ts";

test("eight entries: four session modes + undecided + three internal shells", () => {
  assert.deepEqual([...GATE_MODES].sort(), [
    "explore", "goal", "loop", "normal", "orchestrator", "plan", "review", "undecided",
  ]);
  for (const mode of GATE_MODES) {
    const spec = MODE_REGISTRY[mode];
    assert.ok(spec.prompt.length > 20, `${mode} has a prompt template`);
    assert.ok(spec.deniedTools instanceof Set, `${mode} has a tool policy`);
  }
});

test("internal-only placement: review/plan/goal (+undecided) are gate-placed, never agent-picked", () => {
  for (const mode of ["review", "plan", "goal", "undecided"] as const) {
    assert.equal(MODE_REGISTRY[mode].internalOnly, true, mode);
  }
  for (const mode of ["loop", "explore", "normal", "orchestrator"] as const) {
    assert.equal(MODE_REGISTRY[mode].internalOnly, false, mode);
  }
});

test("enforcement labels match the guard: full ⇔ isEnforcedMode, advisory/off ⇔ not", () => {
  for (const mode of ["loop", "explore", "normal", "orchestrator"] as const) {
    const label = MODE_REGISTRY[mode].enforcement;
    assert.equal(isEnforcedMode(mode), label === "full", `${mode} label ${label}`);
  }
  // explore is advisory on the workflow but L1 ship stays blocked (user
  // decision A, 2026-09-04): the label must say so where it matters.
  assert.match(MODE_REGISTRY.explore.prompt, /ship 命令.*仍被完全拦截/);
  assert.equal(MODE_REGISTRY.undecided.enforcement, "full");
  assert.equal(MODE_REGISTRY.normal.enforcement, "off");
});

test("resolver: judge roles land on reporting shells, sessions on task modes", () => {
  assert.equal(resolveGateMode({ taskMode: "loop" }), "loop");
  assert.equal(resolveGateMode({ taskMode: "explore" }), "explore");
  assert.equal(resolveGateMode({}), "undecided");
  assert.equal(resolveGateMode({ taskMode: "loop", judgeRole: "reviewer" }), "review");
  assert.equal(resolveGateMode({ taskMode: "loop", judgeRole: "Adviser" }), "review");
  assert.equal(resolveGateMode({ taskMode: "loop", judgeRole: "arbiter" }), "review");
  assert.equal(resolveGateMode({ taskMode: "loop", judgeRole: "goal-auditor" }), "goal");
  assert.equal(resolveGateMode({ taskMode: "loop", judgeRole: "goal-auditor", kind: "plan" }), "plan");
  // Fail-closed: an unknown role is not a shell, it is an ordinary session.
  assert.equal(resolveGateMode({ judgeRole: "supervisor" }), "loop");
});

test("internal shells share one tool policy: the moved judge deny set", () => {
  for (const mode of ["review", "plan", "goal"] as const) {
    assert.equal(MODE_REGISTRY[mode].deniedTools, JUDGE_DENIED_TOOLS, mode);
  }
  assert.ok(JUDGE_DENIED_TOOLS.has("set_gate_mode"), "a pane cannot reclassify itself");
  assert.ok(JUDGE_DENIED_TOOLS.has("judge_submit"), "no sub-reviews");
  assert.ok(!JUDGE_DENIED_TOOLS.has("ask_user"), "questions race through the channel");
  assert.equal(judgeDeniedReason("ask_user"), undefined);
  assert.match(judgeDeniedReason("judge_submit")!, /reporting shell|评审/);
});

test("completion discipline teaches fence-and-stop, never exit-and-reopen", () => {
  assert.match(JUDGE_COMPLETION_DISCIPLINE, /verdict fence 收尾并停下/);
  assert.match(JUDGE_COMPLETION_DISCIPLINE, /不需要退出进程/);
  assert.match(JUDGE_COMPLETION_DISCIPLINE, /ask_user/);
  assert.doesNotMatch(JUDGE_COMPLETION_DISCIPLINE, /进程退出即完成|重新拉起/);
  for (const mode of ["review", "plan", "goal"] as const) {
    assert.ok(MODE_REGISTRY[mode].prompt.includes(JUDGE_COMPLETION_DISCIPLINE), mode);
  }
});
