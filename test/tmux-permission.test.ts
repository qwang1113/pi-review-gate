/**
 * WHO may type tmux WITHOUT ASKING — the standing table (lib/tmux-permission.ts).
 *
 * Two rows, two reasons: an acceptance round has to stand the changed system up
 * for real (nested sessions on their own socket), and a project manager has to
 * be able to clean up when the gate ITSELF is what broke. Both are built on the
 * same rule, which is what the boundary cases below pin: the permission comes
 * from a fact the USER controls — an approved orchestration plan, a round the
 * gate dispatched — never from the session calling itself a project manager.
 * `set_gate_mode` moves a session into orchestrator WITHOUT a dialog, so a
 * mode-only trigger would hand any loop session `kill-server` for one tool call.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveTmuxPermission,
  standingTmuxAuthority,
  type TmuxAccess,
} from "../lib/tmux-permission.ts";

const GRANT: TmuxAccess = { at: "2026-10-20T10:00:00.000Z", scope: "once" };

test("the acceptance window is the only JUDGE that runs tmux without asking", () => {
  const acceptance = standingTmuxAuthority({ judgeRole: "acceptance" });
  assert.equal(acceptance?.source, "acceptance-window");
  assert.equal(acceptance?.access.scope, "session", "standing permissions are session-wide, never one-shot");
  for (const role of ["reviewer", "quality-auditor", "goal-auditor", "adviser", "arbiter"]) {
    assert.equal(standingTmuxAuthority({ judgeRole: role }), undefined, role);
  }
  assert.equal(standingTmuxAuthority({}), undefined, "no facts at all ⇒ nothing");
});

test("the project manager holds it only once the USER approved its plan", () => {
  const held = standingTmuxAuthority({ taskMode: "orchestrator", planApproved: true });
  assert.equal(held?.source, "orchestrator-plan");
  assert.equal(held?.access.scope, "session");
  assert.match(held?.why ?? "", /plan 已由用户批准/, "the reply has to say WHAT earned it");

  // THE SECURITY EDGE: a session that only MOVED ITSELF into orchestrator
  // (no dialog, see set_gate_mode) gets nothing.
  assert.equal(standingTmuxAuthority({ taskMode: "orchestrator", planApproved: false }), undefined);
  assert.equal(standingTmuxAuthority({ taskMode: "orchestrator" }), undefined, "an absent fact is not a yes");
  // ...and no other mode gets it, whatever it claims to hold.
  for (const taskMode of ["loop", "explore", "normal"] as const) {
    assert.equal(standingTmuxAuthority({ taskMode, planApproved: true }), undefined, taskMode);
  }
});

test("the acceptance window outranks the manager row (a judge pane is never a PM)", () => {
  const held = standingTmuxAuthority({ judgeRole: "acceptance", taskMode: "orchestrator", planApproved: true });
  assert.equal(held?.source, "acceptance-window");
});

test("a standing permission WINS over the sidecar grant, and neither is invented", () => {
  const standing = resolveTmuxPermission({ taskMode: "orchestrator", planApproved: true, granted: GRANT });
  assert.equal(standing.standing?.source, "orchestrator-plan");
  assert.equal(standing.access?.scope, "session",
    "the wider one wins: the manager's permission does not spend itself on one command");

  const grantedOnly = resolveTmuxPermission({ taskMode: "loop", granted: GRANT });
  assert.equal(grantedOnly.access, GRANT);
  assert.equal(grantedOnly.standing, undefined, "an ordinary grant is not a standing permission");

  const nothing = resolveTmuxPermission({ taskMode: "loop" });
  assert.equal(nothing.access, undefined);
  assert.equal(nothing.standing, undefined);
  assert.deepEqual(nothing, {}, "absent fields are ABSENT, not undefined-valued");
});

test("dropping out of orchestrator (or losing the approval) takes it away again", () => {
  assert.equal(resolveTmuxPermission({ taskMode: "loop", planApproved: true }).access, undefined,
    "the plan approval alone does not follow the session out of orchestrator mode");
  assert.equal(resolveTmuxPermission({ taskMode: "orchestrator", planApproved: false }).access, undefined,
    "a revoked approval is not a yes");
});
