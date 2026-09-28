/**
 * Round 4: an orchestration child's goal flow has no restatement and no audit,
 * and every surface that tells a child what to do next says so.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CHILD_GOAL_FLOW, CHILD_GOAL_MISSING_DIRECTIVE, CHILD_GOAL_REMINDER_TEXT, childGoalEditBlock } from "../lib/child-goal-flow.ts";
import { buildGoalForceNegotiateDirective } from "../lib/loop-goal-directives.ts";
import { TASK_GOAL_DIRECTIVE } from "../lib/orchestrator-delivery.ts";
import { ORCHESTRATION_ID_ENV, newOrchestrationId } from "../lib/orchestration-id.ts";
import { HANDOFF_KIND_ENV, PREDECESSOR_PANE_ENV, isOrchestrationChildEnv } from "../lib/session-inheritance.ts";

test("who is a child: spawned by a manager, or a `child` handoff — never the manager's own successor", () => {
  const id = newOrchestrationId("/repo");
  assert.equal(isOrchestrationChildEnv({}), false);
  assert.equal(isOrchestrationChildEnv({ [ORCHESTRATION_ID_ENV]: id }), true);
  assert.equal(isOrchestrationChildEnv({ [ORCHESTRATION_ID_ENV]: id, [PREDECESSOR_PANE_ENV]: "%3", [HANDOFF_KIND_ENV]: "child" }), true);
  assert.equal(isOrchestrationChildEnv({ [ORCHESTRATION_ID_ENV]: id, [PREDECESSOR_PANE_ENV]: "%3", [HANDOFF_KIND_ENV]: "orchestrator" }), false);
});

test("every child surface sends it straight to propose_loop_goal, never to a restatement or an audit", () => {
  const force = buildGoalForceNegotiateDirective(5, 3, true);
  for (const text of [TASK_GOAL_DIRECTIVE, CHILD_GOAL_MISSING_DIRECTIVE, CHILD_GOAL_REMINDER_TEXT, childGoalEditBlock("/repos/b"), force]) {
    assert.match(text, /propose_loop_goal/);
    assert.doesNotMatch(text, /先用 `propose_restatement`|再用 `propose_restatement`|goal-auditor 审计 \+/);
  }
  assert.ok(TASK_GOAL_DIRECTIVE.includes(CHILD_GOAL_FLOW));
  assert.match(childGoalEditBlock("/repos/b"), /\/repos\/b/);
  // The standalone form is untouched.
  assert.match(buildGoalForceNegotiateDirective(5, 3, false), /propose_restatement/);
});
