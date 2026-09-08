/**
 * THE JUDGE SIDE of the channel — what the gate does when IT is the review.
 *
 * A judge pane loads this extension with `RG_JUDGE_ID` in its environment.
 * In that mode the gate is a reporting shell, not an enforcer: it reports
 * heartbeats, races its dialogs against the opener's answers, drains round
 * tasks, and writes one `report` record per finished round — all through the
 * SAME primitives an orchestration child uses
 * (lib/orchestrator-child-channel.ts). A judge pane is a child process with
 * a gate; there is deliberately no second channel implementation for it.
 *
 * WHAT WRITES THE REPORT. The opener records verdicts (STALE checks, tree
 * binding — opener-owned), but only the judge side sees its own finish. It ends the
 * round by calling judge_conclude (lib/judge-conclude.ts), which writes its
 * STRUCTURED fields (verdict / findings / cwd / docSync) straight into the
 * `report` record; the opener learns it through its own `wait` receipt and
 * consumes those fields as data — no serialization, no parsing, no truncation
 * (an oversized findings array spills to a side file, it is never cut).
 * Pure-ish: env parsing and channel binding are pure; IO (stream count,
 * channel) arrives injected at the call sites.
 */
import {
  judgeChannelTarget,
  type ChannelIO,
} from "./orchestrator-channel.ts";
import type { ChildChannelBinding } from "./orchestrator-child-channel.ts";
import {
  JUDGE_ID_ENV,
  JUDGE_OPENER_ENV,
  JUDGE_ROLE_ENV,
} from "./judge-pane.ts";

/** Task file the pane was opened with (round 1), if the opener passed one. */
export const JUDGE_TASK_ENV = "RG_JUDGE_TASK";
/** Findings stream path the round publishes, for the report's count. */
export const JUDGE_STREAM_ENV = "RG_JUDGE_STREAM";

/** Who this judge pane is, read from its own environment. */
export interface JudgeSideConfig {
  openerId: string;
  judgeId: string;
  role: string;
}

/**
 * Parse the judge identity out of the environment. `undefined` means this
 * session is NOT a judge — the normal gate applies untouched.
 */
export function readJudgeSideEnv(env: NodeJS.ProcessEnv): JudgeSideConfig | undefined {
  const openerId = (env[JUDGE_OPENER_ENV] ?? "").trim();
  const judgeId = (env[JUDGE_ID_ENV] ?? "").trim();
  const role = (env[JUDGE_ROLE_ENV] ?? "").trim();
  if (!openerId || !judgeId) return undefined;
  return { openerId, judgeId, role: role || "reviewer" };
}

/** Why a write to the repo's gate state was skipped — the audit record's content. */
export interface GateStatePersistSkip {
  judgeId: string;
  role: string;
  /** One line, for the judge's own session record and its pane notice. */
  reason: string;
}

/**
 * Must THIS session keep its hands off the repo's gate state?
 *
 * A judge is "a reporting shell … never an enforcer": it reports heartbeats,
 * answers questions and writes one report per round. The gate sidecar
 * (`.pi/review-gate-state.json`) is the OPENER's — its mode, its verdicts, its
 * unmet list, and the only thing the git hooks can see.
 *
 * A judge pane is opened without `RG_STATE_VARIANT` (an orchestration child
 * gets one and therefore writes its own file), so its gate wrote to the
 * opener's file: measured 2026-09-05, the sidecar's `sessionId` became
 * `rg-reviewer-…` and its `taskMode` fell from `orchestrator` to none — the
 * reviewing session quietly overwriting the state of the session being
 * reviewed.
 *
 * Fail-closed on the WRITE side, which for once means writing nothing: the
 * judge has no state of its own that anybody reads, so skipping costs it
 * nothing and protects the one record that decides whether code may ship.
 * Returning `undefined` means "not a judge — persist normally".
 */
export function gateStatePersistSkip(env: NodeJS.ProcessEnv): GateStatePersistSkip | undefined {
  const cfg = readJudgeSideEnv(env);
  if (!cfg) return undefined;
  return {
    judgeId: cfg.judgeId,
    role: cfg.role,
    reason:
      `review-gate: 本会话是 ${cfg.role} review（${cfg.judgeId}），已跳过对仓库门禁状态的写入——` +
      "review 只负责评审（心跳、答 opener、落 report），主 sidecar 与 .blocked marker 属于 opener，" +
      "judge 写它会把 opener 的 sessionId 与 taskMode 覆盖掉。",
  };
}

/** The channel binding this judge reports, asks and drains through. */
export function judgeSideBinding(
  io: ChannelIO,
  config: JudgeSideConfig,
  sessionId?: string,
  home?: string,
): ChildChannelBinding {
  return {
    io,
    target: judgeChannelTarget(config.openerId, config.judgeId, home),
    ...(sessionId ? { sessionId } : {}),
  };
}

/** Re-exported single source: the deny set lives in lib/gate-modes.ts (mode registry). */
export { JUDGE_DENIED_TOOLS, judgeDeniedReason } from "./gate-modes.ts";
