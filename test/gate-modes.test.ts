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
  assert.ok(!JUDGE_DENIED_TOOLS.has("judge_conclude"), "concluding its own round is the judge's own job");
  assert.ok(!JUDGE_DENIED_TOOLS.has("ask_user"), "questions race through the channel");
  assert.equal(judgeDeniedReason("ask_user"), undefined);
  assert.match(judgeDeniedReason("judge_submit")!, /reporting shell|评审/);
});

test("opening the appeal route opened EXACTLY one name", () => {
  // The deny set as it stood before the judge-side inspection gate
  // (2026-09-05), written out in full on purpose. The inspection refusal needs
  // `request_arbitration` to be reachable from inside a pane; this pins that
  // nothing else was opened along with it — and that nothing new was denied
  // without a decision.
  const BEFORE = new Set([
    "judge_submit", "judge_spawn", "judge_answer", "judge_recover", "judge_close", "judge_wait",
    "orchestrator_spawn", "orchestrator_instruct", "orchestrator_wait", "orchestrator_close",
    "orchestrator_handoff", "orchestrator_plan", "orchestrator_notify", "orchestrator_answer",
    "orchestrator_recover", "orchestrator_attach",
    "propose_loop_goal", "request_copilot_review", "check_copilot_review",
    "request_scope_limit", "request_sensitive_edit", "set_gate_mode", "declare_done",
    "request_arbitration",
  ]);
  const opened = [...BEFORE].filter((tool) => !JUDGE_DENIED_TOOLS.has(tool));
  const added = [...JUDGE_DENIED_TOOLS].filter((tool) => !BEFORE.has(tool));
  assert.deepEqual(opened, ["request_arbitration"], "only the appeal route was opened");
  // ONE tool was denied since that snapshot, deliberately: `propose_restatement`
  // (2026-09-06) is the requirement-negotiation step, and a reporting shell
  // judges a change against a contract somebody else agreed — it does not
  // negotiate one. Anything else appearing here is an undecided denial.
  assert.deepEqual(added, ["propose_restatement"],
    "the only tool denied since the 2026-09-05 snapshot is the restatement step");
  // The ship commands are not in this set at all — they are refused by L1, and
  // no appeal class can ever authorize them.
  for (const ship of ["git commit", "git push", "gh pr create"]) {
    assert.ok(!JUDGE_DENIED_TOOLS.has(ship));
  }
});

test("completion discipline teaches conclude-and-stop, never exit-and-reopen", () => {
  assert.match(JUDGE_COMPLETION_DISCIPLINE, /judge_conclude 交卷并停下/);
  assert.match(JUDGE_COMPLETION_DISCIPLINE, /一轮只能交一次/);
  assert.match(JUDGE_COMPLETION_DISCIPLINE, /不需要退出进程/);
  assert.match(JUDGE_COMPLETION_DISCIPLINE, /ask_user/);
  assert.doesNotMatch(JUDGE_COMPLETION_DISCIPLINE, /verdict fence 收尾/, "no fence may come back");
  for (const mode of ["review", "plan", "goal"] as const) {
    assert.ok(MODE_REGISTRY[mode].prompt.includes(JUDGE_COMPLETION_DISCIPLINE), mode);
  }
});
