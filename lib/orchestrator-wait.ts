/**
 * WAIT CRITERIA and THE RECEIPT for an orchestration child.
 *
 * lib/poll-wait.ts owns the LOOP (probe, publish, stop on a criterion or the
 * budget); this module owns two things the loop cannot know:
 *
 *  1. what "something happened" MEANS for an interactive child session, and
 *  2. what the orchestrator is TOLD when the wait returns.
 *
 * The two waiters in this repository differ on every criterion even though
 * the loop is identical, which is why the skeleton is generic:
 *
 *              judge child (`pi -p`)        orchestration child (interactive)
 *   shape      one-shot process             long-lived pane
 *   "news"     the process exited           its channel state changed
 *   normal end verdict printed, exits       declare_done, and it stays alive
 *   failure    exit-code file missing       the pane vanished, or it went mute
 *
 * The consequence worth stating: a child that FINISHES does not exit, so
 * "waiting for the process to end" would hang forever here. The end states
 * are reports, not exits.
 *
 * ── WHAT THE 2026-08-30 REWRITE REMOVED ──
 *
 * Every criterion used to be an inference about a global event queue and a
 * rendered screen, and the addressing had to be re-checked in code because
 * the queue was shared by the whole machine (F12: eight events belonging to
 * somebody else consumed in one round, each returning instantly and burning
 * the budget). Both problems are gone by construction: a child's channel is
 * its own file, so there is nothing to address-filter, and its state is what
 * it SAID rather than what its terminal looked like.
 *
 * What survives from that era is the one lesson that was not about screens:
 * UNKNOWN ≠ GONE (F14). When `list-panes` cannot be read, liveness is
 * unmeasured, and an unmeasured child keeps being waited on.
 *
 * ── THE RECEIPT IS THE INTERFACE (task book §3.5) ──
 *
 * {@link buildWaitReceipt} assembles all four blocks every single time —
 * health, pending questions, deaths with their recovery actions, and the
 * orchestrator's own context budget with the handover call. Whether the wait
 * blocked or returned instantly (`timeoutMs: 0`, which is the old
 * `orchestrator_status`) changes nothing about what comes back: one shape,
 * one call, nothing the orchestrator has to remember to go and ask for.
 *
 * Pure module: observations in, a decision and a string out.
 */

import { handoffAdvice, type HandoffAdvice } from "./orchestrator-handoff-advice.ts";
import {
  formatSupervisionReceipt,
  type SupervisionEvent,
  type SupervisionSnapshot,
} from "./orchestrator-supervisor.ts";

export type ChildWaitReason =
  /** The supervisor saw a state worth waking the orchestrator for. */
  | "supervision"
  /** The child reported its task complete. */
  | "child-done"
  /** Its pane is gone — it died, or the user closed it. */
  | "pane-gone"
  /** Nothing yet. */
  | "pending";

export interface ChildWaitObservation {
  /** Newsworthy states the supervisor manufactured on this poll. */
  events?: SupervisionEvent[];
  /** The child under watch reported done (registry `doneAt` is set). */
  done: boolean;
  /** Its pane still exists right now. */
  paneAlive: boolean;
  /** tmux could not be read: liveness is UNKNOWN, which is not "dead". */
  livenessUnknown?: boolean;
  /** Free-form progress line for the live snapshot (never a criterion). */
  note?: string;
}

export interface ChildWaitDecision {
  done: boolean;
  reason: ChildWaitReason;
  /** One line the tool can hand straight back to the agent. */
  summary: string;
  /** WHICH child this is about. */
  childId?: string;
}

/**
 * Evaluate ONE observation.
 *
 * ORDER MATTERS, and every step of it was paid for:
 *
 *  1. supervision events come first — they name the child and the state, and
 *     they are the only signal that exists for a child that stopped without
 *     asking anything (R-23) or finished without saying so (R3-5);
 *  2. `done` for the specific child being waited on;
 *  3. UNKNOWN liveness (never a death, F14) before a vanished pane, so a
 *     transient tmux failure cannot end supervision.
 */
export function evaluateChildWait(observation: ChildWaitObservation): ChildWaitDecision {
  const events = observation.events ?? [];
  if (events.length > 0) {
    const first = events[0]!;
    const rest = events.length > 1 ? `（另有 ${events.length - 1} 条事件）` : "";
    return {
      done: true,
      reason: "supervision",
      childId: first.childId,
      summary: `${first.summary}${rest}`,
    };
  }
  if (observation.done) {
    return { done: true, reason: "child-done", summary: "子会话报告任务完成（它仍然活着，可继续派活或关闭）" };
  }
  if (observation.livenessUnknown) {
    return {
      done: false,
      reason: "pending",
      summary: "读不到 tmux pane 列表，子会话存活状态未知 —— 按「还活着」继续等（读不到不等于死了）",
    };
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

// ---------------------------------------------------------------------------
// The receipt — the orchestrator's ONE information channel
// ---------------------------------------------------------------------------

/** Everything the receipt is built from. */
export interface WaitReceiptInput {
  snapshot: SupervisionSnapshot;
  decision: ChildWaitDecision;
  /** The orchestrator's OWN context usage, measured by the gate. */
  contextPercent?: number;
  /**
   * What still blocks `declare_done` — the block that absorbed the old
   * `orchestrator_status`.
   *
   * It rides here for the same reason the handoff advice does: an
   * orchestrator that has to REMEMBER to go and ask "am I finished yet"
   * finds out at the wrong moment. Empty ⇒ the orchestration may end.
   */
  exitBlockers?: string[];
  /** What a handoff gave this session, when it is a successor. */
  inheritance?: string;
  /** How long the call actually blocked, in ms. */
  waitedMs: number;

}

/** The receipt, plus the advice block so a caller can act on it structurally. */
export interface WaitReceipt {
  text: string;
  advice: HandoffAdvice;
}

/**
 * Assemble the whole reply.
 *
 * Blocks 1–3 come from the supervisor; block 4 is computed here from the
 * orchestrator's own context reading and the number of questions outstanding
 * — deliberately NOT left to the orchestrator to look up, because "remember
 * to check your context" is a rule an agent forgets exactly when it matters.
 */
export function buildWaitReceipt(input: WaitReceiptInput): WaitReceipt {
  const advice = handoffAdvice({
    ...(input.contextPercent === undefined ? {} : { percent: input.contextPercent }),
    openRequests: input.snapshot.requests.length,
  });
  const lead = input.decision.done
    ? `**${input.decision.summary}**`
    : `（等了 ${Math.round(input.waitedMs / 1000)}s，没有新事件）${input.decision.summary}`;
  const blockers = input.exitBlockers ?? [];
  const text = [
    lead,
    "",
    formatSupervisionReceipt(input.snapshot),
    "",
    "### 4. 你自己的上下文与接力时机",
    advice.line,
    "",
    "### 5. 还差什么才能收尾（declare_done）",
    blockers.length > 0 ? blockers.map((p) => `- ${p}`).join("\n") : "- 没有了，可以 declare_done",
    ...(input.inheritance ? ["", input.inheritance] : []),
  ].join("\n");

  return { text, advice };
}

// ---------------------------------------------------------------------------
// The budget (F14) — every call returns
// ---------------------------------------------------------------------------

/**
 * Default blocking window, and the hard cap the tool clamps to.
 *
 * The cap was 30 minutes and the hand-run experienced it as "the session is
 * gone": no output, no way in, and the orchestrator could not even be asked
 * to close its children. The user set the new bounds (2026-08-29): 300s
 * default, 900s ceiling. A shorter ceiling is not a smaller feature — it is
 * how often the orchestrator is forced back to a decision point where it can
 * be steered.
 */
export const CHILD_WAIT_DEFAULT_MS = 300_000;
export const CHILD_WAIT_MAX_MS = 900_000;
/** Nobody benefits from a blocking wait shorter than one poll interval. */
export const CHILD_WAIT_MIN_MS = 1_000;

/**
 * Clamp the requested window.
 *
 * ZERO IS SPECIAL and is passed through untouched: it is the snapshot mode
 * that absorbed `orchestrator_status` (philosophy two — blocking or not is a
 * PARAMETER, not a second tool). Anything else is clamped into the blocking
 * range, so a mistyped `5` cannot produce a busy-poll.
 */
export function clampChildWaitTimeout(value: unknown): number {
  if (value === 0) return 0;
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : CHILD_WAIT_DEFAULT_MS;
  if (n <= 0) return 0;
  return Math.min(CHILD_WAIT_MAX_MS, Math.max(CHILD_WAIT_MIN_MS, n));
}
