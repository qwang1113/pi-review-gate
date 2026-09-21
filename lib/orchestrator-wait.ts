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

import { handoffDue, HANDOFF_PERCENT } from "./session-handoff.ts";
import { nextRewakeDelayMs } from "./orchestrator-child-state.ts";
import {
  formatSupervisionReceipt,
  type PendingRequest,
  type SupervisionEvent,
  type SupervisionSnapshot,
} from "./orchestrator-supervisor.ts";

export type ChildWaitReason =
  /** The supervisor saw a state worth waking the orchestrator for. */
  | "supervision"
  /*
   * THERE IS NO `child-done` REASON ANY MORE (B4, 2026-09-17).
   *
   * A completion IS a supervision event — `done` is newsworthy, so it already
   * arrives through the branch above, named and carrying the child's id. The
   * separate criterion read a registry field instead of the channel, and that
   * second reading is exactly what made one receipt say "已完成" and "还有 1
   * 个子会话活着" at the same time. It would also have been a busy poll: the
   * flag never clears, so once any child had finished, every later wait would
   * have returned instantly with nothing new to report.
   */

  /**
   * A question is hanging RIGHT NOW — the FACT, not a state transition.
   *
   * ── WHY THIS IS NOT COVERED BY `supervision` (2026-09-22) ──
   *
   * A supervision event is manufactured by `decideSupervisionEvents`, which
   * is memory-gated: an unchanged `waiting-input` only re-rings once its
   * 10s→30s→60s backoff comes due, and the memory it consults is SHARED with
   * the background supervision timer (10s) and the `agent_settled`
   * continuation. Every backoff step is a multiple of that 10s tick, so each
   * due moment landed on a timer tick and the timer consumed it first — the
   * wait's own 2s probes fell forever between two consumptions. Measured:
   * a child's dialog opened at 12:43:23, the manager's wait started at
   * 12:43:25 and returned 910 SECONDS later with 「等人回答（已等 910s）」.
   *
   * So an open request ends the wait on its own evidence: the channel says a
   * question is unanswered. Nothing else has to agree, and nothing else can
   * take it away. The de-duplication moved WITH it — onto the requestId
   * (lib/orchestrator-session-tools.ts), which is the thing being announced,
   * instead of onto a per-child STATE that three consumers share.
   */
  | "pending-request"
  /** Its pane is gone — it died, or the user closed it. */
  | "pane-gone"
  /** Nothing yet. */
  | "pending";

export interface ChildWaitObservation {
  /** Newsworthy states the supervisor manufactured on this poll. */
  events?: SupervisionEvent[];
  /**
   * Questions that are unanswered right now AND have not been announced by a
   * wait yet. Present ⇒ this wait ends; see `pending-request`.
   */
  pendingRequests?: PendingRequest[];
  /* No `done` flag: completion arrives as a supervision event (see above). */
  /** Its pane still exists right now. */
  paneAlive: boolean;
  /** tmux could not be read: liveness is UNKNOWN, which is not "dead". */
  livenessUnknown?: boolean;
  /** Free-form progress line for the live snapshot (never a criterion). */
  note?: string;
}

/**
 * What a wait remembers about a question it has already handed over.
 *
 * Keyed by the REQUEST, which is the thing being announced. The supervision
 * memory is keyed by child+state and is drained by three consumers, and both
 * halves of that were defects: the timer ate every due re-report before the
 * wait's probe could see one (a 910-second wait beside a two-second-old
 * dialog), and a second question asked while the first was still open was not
 * "a change of state", so it was not news at all.
 */
export interface AnnouncedRequest {
  requestId: string;
  /** Epoch ms of the last time a wait handed this question over. */
  at: number;
  /** How many times it has been handed over. */
  reports: number;
}

/**
 * WHICH open questions this wait must hand over now — and what to remember.
 *
 * A question that has never been announced is due at once (that is the whole
 * fix: the first probe after a dialog opens returns). One already announced
 * re-rings on the SAME 10s→30s→60s backoff an unanswered thing always had,
 * so a question the manager chose not to answer is neither forgotten nor
 * turned into a busy poll.
 *
 * PRUNING IS STRUCTURAL: the returned memory is built from `open` alone, so a
 * question the child has settled simply is not carried forward — "答过的不再
 * 算" needs no rule of its own, and the record cannot grow without bound.
 *
 * A wait scoped to one child advances nothing that belongs to a sibling:
 * out-of-scope entries are carried through UNCHANGED, so the sibling's
 * question is still owed an announcement on the next unscoped call — the same
 * rule the event path has always had.
 */
export function dueRequests(input: {
  open: readonly PendingRequest[];
  announced: readonly AnnouncedRequest[];
  at: number;
  /** Only these requests may END this wait. */
  childId?: string;
}): { due: PendingRequest[]; memory: AnnouncedRequest[] } {
  const previous = new Map(input.announced.map((a) => [a.requestId, a]));
  const due: PendingRequest[] = [];
  const memory: AnnouncedRequest[] = [];
  for (const request of input.open) {
    const seen = previous.get(request.requestId);
    const inScope = input.childId === undefined || request.childId === input.childId;
    // `reports` counts what has already gone out, so the delay before the
    // next one is indexed from `reports - 1` — after the first announcement
    // the wait is the FIRST backoff step (10s), not the second.
    const ready = seen === undefined || input.at >= seen.at + nextRewakeDelayMs(seen.reports - 1);
    if (inScope && ready) {
      due.push(request);
      memory.push({ requestId: request.requestId, at: input.at, reports: (seen?.reports ?? 0) + 1 });
    } else if (seen !== undefined) {
      memory.push(seen);
    }
  }
  return { due, memory };
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
 *  1. an UNANSWERED QUESTION leads, on the channel's own evidence rather
 *     than on an event memory three consumers drain (`pending-request`,
 *     2026-09-22). A child blocked on a dialog is the whole orchestration
 *     standing still, and it is the one state whose next action is the
 *     manager's alone — so it names the reply even when other news arrived
 *     on the same probe (that news is in blocks 1–3 either way);
 *  2. supervision events — they name the child and the state, and they are
 *     the only signal that exists for a child that stopped without asking
 *     anything (R-23) or finished without saying so (R3-5); a completion is
 *     one of those events, not a separate criterion (B4);
 *  3. UNKNOWN liveness (never a death, F14) before a vanished pane, so a
 *     transient tmux failure cannot end supervision.
 */
export function evaluateChildWait(observation: ChildWaitObservation): ChildWaitDecision {
  // The FACT first: a question nobody has answered ends the wait whether or
  // not any memory thinks it is due, and it leads the reply.
  const pending = observation.pendingRequests ?? [];
  if (pending.length > 0) {
    const first = pending[0]!;
    const rest = pending.length > 1 ? `（另有 ${pending.length - 1} 个待答请求）` : "";
    return {
      done: true,
      reason: "pending-request",
      childId: first.childId,
      summary:
        `${first.childId} 在等回答：「${first.title}」` +
        `（${first.options.length} 个选项，requestId=${first.requestId}）${rest}`,
    };
  }

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

/**
 * Block 4, structurally — whether this session is past the handover
 * threshold, plus the sentence that says so.
 *
 * The threshold itself is NOT decided here: lib/session-handoff.ts owns 70%
 * for every kind of session, and this module only renders its answer. It used
 * to own a soft/hard pair of its own (80/90), which meant an orchestrator and
 * a judge were handed over at different points for no reason anyone could
 * state.
 */
export interface HandoffAdvice {
  due: boolean;
  percent?: number;
  line: string;
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
  const due = handoffDue(input.contextPercent === undefined ? undefined : { percent: input.contextPercent });
  const openRequests = input.snapshot.requests.length;
  const advice: HandoffAdvice = {
    due: due.due,
    ...(due.percent === undefined ? {} : { percent: due.percent }),
    line: due.percent === undefined
      ? "上下文用量：宿主未提供读数（无法判断接力时机）。"
      : due.due
        ? `上下文已用 ${due.percent}%（阈值 ${HANDOFF_PERCENT}%）：**接力是现在的动作** —— ` +
          (openRequests > 0
            ? `先把这 ${openRequests} 个待答请求回掉，再把补充段写进门禁准备好的交接文档并调 \`session_handoff()\`。`
            : "把补充段写进门禁准备好的交接文档，再调 `session_handoff()`。")
        : `上下文已用 ${due.percent}%，余量充足。`,
  };
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
