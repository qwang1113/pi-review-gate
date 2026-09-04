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
 * round by calling judge_conclude (lib/judge-conclude.ts), which synthesises the
 * canonical fence and appends the `report`; the opener learns it through its own
 * `wait` receipt. The fence rides as the (possibly spilled) summary, so the opener
 * feeds the EXACT bytes the recorder parses — no prose round-trip, no truncation.
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
