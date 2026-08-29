/**
 * WAIT CRITERIA for an orchestration child — the other half of the generic
 * waiting skeleton, rewritten after the first real orchestration deadlocked
 * inside it (F12, F14).
 *
 * lib/poll-wait.ts owns the LOOP (probe, publish, stop on a criterion or the
 * budget); this module owns what "something happened" MEANS for an
 * interactive child session. The two waiters differ on every criterion even
 * though the loop is identical, which is why the skeleton is generic:
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
 * WHAT THE REWRITE FIXED, and each of these was a measured deadlock:
 *
 *  - ADDRESSING (F12). Events are taken only when they are addressed to THIS
 *    orchestration and come from a pane this orchestration registered. The
 *    hand-run consumed eight events belonging to somebody else's session and
 *    returned instantly from each, burning the whole round budget on nothing.
 *  - "DEQUEUED" IS NOT "DONE" (F12). Marking an event handled says a listener
 *    saw it; it says nothing about the dialog that raised it. A human who
 *    answers the box in the pane leaves the event unhandled forever, and the
 *    old waiter reported that stale event as news. Now the child's SCREEN is
 *    re-read: a closed dialog means the matter is settled and waiting
 *    continues instead of ending on a ghost.
 *  - UNKNOWN ≠ GONE (F14). When `list-panes` cannot be read the old probe saw
 *    an empty pane list and concluded the child had died — an instant,
 *    permanent "pane-gone". Liveness that could not be measured is now its own
 *    state and keeps the wait alive.
 *
 * Pure module: an observation in, a decision out.
 */

import type { AttentionEvent } from "./attention.ts";
import type { ChildHealth, ChildState } from "./orchestrator-child-state.ts";
import { describeProbeEvent, type ProbeEvent } from "./orchestrator-probe.ts";

export type ChildWaitReason =
  /** The child raised an attention event and its dialog is still open. */
  | "attention"
  /** The gate's own probe manufactured the news (waiting-input / idle / dead). */
  | "probe"
  /** The child reported its task complete. */
  | "child-done"
  /** Its pane is gone — it died, or the user closed it. */
  | "pane-gone"
  /** An event arrived, but whatever raised it was already dealt with. */
  | "settled-elsewhere"
  /** Nothing yet. */
  | "pending";


export interface ChildWaitObservation {
  /** The attention event addressed to this orchestration, if one arrived. */
  attention?: AttentionEvent;
  /**
   * Is the thing that raised the event STILL waiting?
   *
   * `undefined` means it could not be checked (no pane read) — treated as
   * "still open", because failing to confirm that something was handled must
   * never silence a request for help.
   */
  attentionStillOpen?: boolean;
  /**
   * What the ORIGIN child is doing right now, per the probe.
   *
   * An event may only be written off as "the user answered it themselves"
   * when the child has demonstrably MOVED ON (it is working again). R-16 was
   * exactly this judgement made on one weaker fact — "I cannot see a dialog"
   * — while the dialog was on screen the whole time and merely unparsed.
   */
  originState?: ChildState;
  /** Events the gate's own probe manufactured (already drained). */
  probeEvents?: ProbeEvent[];
  /** The child reported done (registry doneAt is set). */
  done: boolean;
  /** Its pane still exists right now. */
  paneAlive: boolean;
  /** tmux could not be read: liveness is UNKNOWN, which is not "dead". */
  livenessUnknown?: boolean;
  /** Free-form progress line for the live snapshot (never a criterion). */
  note?: string;
  /** The health of every open child at this instant (R-4/R-11/R-23). */
  health?: ChildHealth[];
}

export interface ChildWaitDecision {
  done: boolean;
  reason: ChildWaitReason;
  /** One line the tool can hand straight back to the agent. */
  summary: string;
  /** WHICH child this is about — the question the old receipt left open. */
  childId?: string;
}

/**
 * Evaluate ONE observation.
 *
 * ORDER MATTERS, and every step of it was paid for:
 *
 *  1. the gate's OWN probe events come first — they name the child and the
 *     state, and they are the only signal that exists for a child that
 *     stopped without asking anything (R-23);
 *  2. an attention event ends the wait unless the child provably moved on;
 *  3. `done`, then UNKNOWN liveness (never a death, F14), then a vanished
 *     pane, so a dead child is never waited on to the end of the budget.
 */
export function evaluateChildWait(observation: ChildWaitObservation): ChildWaitDecision {
  const manufactured = observation.probeEvents ?? [];
  if (manufactured.length > 0) {
    const first = manufactured[0]!;
    const rest = manufactured.length > 1 ? `（另有 ${manufactured.length - 1} 条同类事件）` : "";
    return {
      done: true,
      reason: "probe",
      childId: first.childId,
      summary: `${describeProbeEvent(first)}${rest}`,
    };
  }
  if (observation.attention) {
    const from = observation.attention.fromPane;
    const settled =
      observation.attentionStillOpen === false && observation.originState === "working";
    if (settled) {
      return {
        done: false,
        reason: "settled-elsewhere",
        summary:
          `收到一条 attention（${observation.attention.reason}），但那个子会话屏幕上已经没有待答的框、而且又在跑了 ——` +
          "多半是用户本人当场答掉了。事件已销账≠事情没办成：继续等（真没办成的话，探针会按 10s→30s→60s 再叫你）。",
      };
    }
    return {
      done: true,
      reason: "attention",
      ...(from ? { childId: from } : {}),
      summary: `子会话有事找你：${observation.attention.reason}`,
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
// Addressing (F12) — whose event is this?
// ---------------------------------------------------------------------------

export interface AttentionAcceptance {
  accept: boolean;
  /** Why it was dropped — reported, never swallowed silently. */
  reason?: string;
}

/**
 * Is this event ours to act on?
 *
 * lib/attention.ts already filters by `toSessionId`, but that filter alone
 * was not enough in the field: the queue is a GLOBAL file shared by every
 * session on the machine, so a mis-addressed or leftover event still reaches
 * the reader, and an orchestrator that returns from `wait` on somebody else's
 * business is exactly the F12 spin. The second filter is ownership: the event
 * must come from a pane this orchestration created.
 *
 * An event with NO origin pane is accepted (older publishers did not stamp
 * one) but flagged, because refusing it could silence a genuine child.
 */
export function acceptAttention(
  event: AttentionEvent,
  opts: { orchestrationId: string; childPanes: readonly string[] },
): AttentionAcceptance {
  if (event.toSessionId !== opts.orchestrationId) {
    return {
      accept: false,
      reason: `事件是发给 ${event.toSessionId} 的，不是本编排（${opts.orchestrationId}）—— 已忽略`,
    };
  }
  const from = event.fromPane?.trim();
  if (!from) return { accept: true, reason: "事件没带来源 pane（旧版本发布者），无法核对归属，暂且采信" };
  if (!opts.childPanes.includes(from)) {
    return {
      accept: false,
      reason: `事件来自 pane ${from}，不是本编排登记过的子会话 —— 已忽略`,
    };
  }
  return { accept: true };
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
/** Nobody benefits from a wait shorter than one poll interval. */
export const CHILD_WAIT_MIN_MS = 1_000;

export function clampChildWaitTimeout(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : CHILD_WAIT_DEFAULT_MS;
  return Math.min(CHILD_WAIT_MAX_MS, Math.max(CHILD_WAIT_MIN_MS, n));
}
