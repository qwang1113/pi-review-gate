/**
 * WHO MAY TYPE tmux WITHOUT ASKING — one table, one place.
 *
 * The tmux gate (lib/orchestrator-guard.ts, refused in lib/ship-gate-bash.ts)
 * is a PERMISSION, and until 2026-10-21 there was exactly one way to hold it:
 * the user's own dialog (`request_tmux_access`). That left two roles parked on
 * a box they could not answer for themselves:
 *
 *  - the ACCEPTANCE window (2026-09-29, user decision) — standing the changed
 *    system up for real means nested sessions on their own socket;
 *  - the PROJECT MANAGER (2026-10-21, user decision) — when the gate itself is
 *    what broke (a child stuck on a dead dialog, a registry that no longer
 *    matches its pane), the orchestration tools are exactly the ones that stop
 *    working, and the manager is the only one who could clean up by hand.
 *
 * THE PM TRIGGER IS THE USER'S APPROVAL, NOT THE MODE. `set_gate_mode` moves a
 * session INTO orchestrator without a dialog (it is a tightening, not a
 * widening), so keying the permission on the mode alone would let any loop
 * session hand itself `kill-server` with one tool call. A plan the user
 * approved (OrchestratorRuntime.approvedPlanHash) is the fact that says "the
 * user made THIS session the manager"; without it the manager asks the way
 * every other session does, and a revoked approval takes the permission away
 * again.
 *
 * ONE ACCESSOR, TWO CONSUMERS. The ship gate reads `access`; the consent tool
 * reads `standing` so it can answer "you already have it, and here is why"
 * instead of raising a box nobody can satisfy. Both call this module, so the
 * table cannot drift between them.
 *
 * Pure: no env, no IO — the caller parses its own identity (judge role, task
 * mode, plan approval) and passes the facts in.
 */

import type { TaskMode } from "./task-mode.ts";

/** A tmux authorization as the ship gate reads it (lib/gate-state.ts tmuxAccess). */
export interface TmuxAccess {
  at: string;
  scope: "session" | "once";
}

/** Where a STANDING permission (never asked, never persisted) comes from. */
export type StandingTmuxSource = "acceptance-window" | "orchestrator-plan";

export interface StandingTmuxAuthority {
  source: StandingTmuxSource;
  /** Why THIS session holds it — the reply `request_tmux_access` gives instead of a dialog. */
  why: string;
  access: TmuxAccess;
}

/**
 * The `why` lines, per source. Written for the agent that calls
 * `request_tmux_access` out of habit: it has to learn both that the permission
 * already exists and what earned it, or it will paste the same reasoning into
 * its next round.
 */
const WHY: Readonly<Record<StandingTmuxSource, string>> = Object.freeze({
  "acceptance-window":
    "你在验收窗口（acceptance judge）里 —— 真实验收要起真实系统、可能开嵌套会话，这一档由门禁直接给，不弹框",
  "orchestrator-plan":
    "你是这个编排的项目经理（orchestrator 模式，plan 已由用户批准）—— 门禁自己出问题、工具拒绝、子会话卡住时，你要能直接操作 tmux 处理现场，这一档由门禁直接给，不弹框",
});

/** The facts the caller knows about itself. */
export interface TmuxPermissionInput {
  /** Judge role from the pane's own env (lib/judge-side.ts readJudgeSideEnv), if any. */
  judgeRole?: string | undefined;
  /** This session's gate mode. */
  taskMode?: TaskMode | undefined;
  /**
   * Does this session hold a plan the USER approved
   * (OrchestratorRuntime.approvedPlanHash)? The only evidence that the user
   * made it the manager — see the module docblock.
   */
  planApproved?: boolean | undefined;
  /** The sidecar's own grant, minted by `request_tmux_access`. */
  granted?: TmuxAccess | undefined;
}

export interface TmuxPermission {
  /** What the ship gate consults. A standing permission WINS over a sidecar grant. */
  access?: TmuxAccess;
  /** Present ⇒ this session may type tmux without asking, and this is why. */
  standing?: StandingTmuxAuthority;
}

/**
 * The standing table. Two rows, in this order — the acceptance window first
 * because it is the narrower one (a judge pane is never a project manager).
 */
export function standingTmuxAuthority(
  input: Omit<TmuxPermissionInput, "granted">,
): StandingTmuxAuthority | undefined {
  const role = (input.judgeRole ?? "").trim().toLowerCase();
  if (role === "acceptance") {
    return {
      source: "acceptance-window",
      why: WHY["acceptance-window"],
      access: { at: "acceptance-window", scope: "session" },
    };
  }
  if (input.taskMode === "orchestrator" && input.planApproved === true) {
    return {
      source: "orchestrator-plan",
      why: WHY["orchestrator-plan"],
      access: { at: "orchestrator-plan", scope: "session" },
    };
  }
  return undefined;
}

/**
 * Resolve one session's tmux permission: the standing table first, then the
 * user's own grant. Returns BOTH so each consumer takes the half it needs
 * without re-deriving the other.
 */
export function resolveTmuxPermission(input: TmuxPermissionInput): TmuxPermission {
  const standing = standingTmuxAuthority(input);
  const access = standing?.access ?? input.granted;
  return {
    ...(standing ? { standing } : {}),
    ...(access ? { access } : {}),
  };
}
