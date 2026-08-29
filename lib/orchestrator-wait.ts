/**
 * WAIT CRITERIA for an orchestration child — the other half of the generic
 * waiting skeleton.
 *
 * lib/poll-wait.ts owns the LOOP (probe, publish, stop on a criterion or the
 * budget); this module owns what "something happened" MEANS for an
 * interactive child session. The two waiters differ on every criterion even
 * though the loop is identical, which is exactly why the skeleton was made
 * generic (task book §6.3):
 *
 *              judge child (`pi -p`)        orchestration child (interactive)
 *   shape      one-shot process             long-lived pane
 *   "news"     the process exited           an ATTENTION event arrived
 *   normal end verdict printed, exits       declare_done, and it stays alive
 *   failure    exit-code file missing       the pane vanished
 *
 * The consequence worth stating: a child that FINISHES does not exit, so
 * "waiting for the process to end" would hang forever here. The end states
 * are events, not exits.
 *
 * Pure module: an observation in, a decision out.
 */

import type { AttentionEvent } from "./attention.ts";

export type ChildWaitReason =
  /** The child raised an attention event (a dialog, a question, a report). */
  | "attention"
  /** The child reported its task complete. */
  | "child-done"
  /** Its pane is gone — it died, or the user closed it. */
  | "pane-gone"
  /** Nothing yet. */
  | "pending";

export interface ChildWaitObservation {
  /** The attention event addressed to this orchestration, if one arrived. */
  attention?: AttentionEvent;
  /** The child reported done (registry doneAt is set). */
  done: boolean;
  /** Its pane still exists right now. */
  paneAlive: boolean;
  /** Free-form progress line for the live snapshot (never a criterion). */
  note?: string;
}

export interface ChildWaitDecision {
  done: boolean;
  reason: ChildWaitReason;
  /** One line the tool can hand straight back to the agent. */
  summary: string;
}

/**
 * Evaluate ONE observation. Order matters: an attention event is the most
 * informative outcome (the child is asking for something specific), and a
 * vanished pane is checked before "still pending" so a dead child can never
 * be waited on to the end of the budget.
 */
export function evaluateChildWait(observation: ChildWaitObservation): ChildWaitDecision {
  if (observation.attention) {
    return {
      done: true,
      reason: "attention",
      summary: `子会话有事找你：${observation.attention.reason}`,
    };
  }
  if (observation.done) {
    return { done: true, reason: "child-done", summary: "子会话报告任务完成（它仍然活着，可继续派活或关闭）" };
  }
  if (!observation.paneAlive) {
    return {
      done: true,
      reason: "pane-gone",
      summary: "子会话的 pane 已经消失（异常退出或被用户关掉）—— 它的任务多半没做完，先确认状态",
    };
  }
  return { done: false, reason: "pending", summary: observation.note ?? "子会话仍在工作" };
}

/** Default blocking window, and the hard cap the tool clamps to. */
export const CHILD_WAIT_DEFAULT_MS = 300_000;
export const CHILD_WAIT_MAX_MS = 1_800_000;

export function clampChildWaitTimeout(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : CHILD_WAIT_DEFAULT_MS;
  return Math.min(CHILD_WAIT_MAX_MS, Math.max(1_000, n));
}
