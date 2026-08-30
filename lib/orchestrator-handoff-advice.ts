/**
 * WHEN TO HAND OVER — computed by the gate, pushed into the receipt.
 *
 * THE DESIGN PRINCIPLE THIS FILE EXISTS FOR (task book §3.5, ranked equal to
 * philosophy one): `orchestrator_wait` is the ONE call an orchestrator makes
 * every round, so anything it needs to know is PUSHED to it there. Expecting
 * an agent to remember to go and check something is not a plan — it is a
 * defect waiting for a busy round. So the orchestrator never calls
 * `ctx.getContextUsage()` itself and never decides handover timing by feel:
 * the gate measures, judges, and writes the sentence.
 *
 * WHY TIMING AND NOT JUST A NUMBER. A percentage alone leads straight to the
 * failure this prevents — dispatching one more task on a nearly full context,
 * blowing up halfway through, and leaving the task state dangling with a live
 * child nobody is addressing. But "hand over NOW" is equally wrong while
 * children are waiting on answers: the successor would inherit a queue of
 * unanswered questions it has no context for. So the advice is a function of
 * BOTH numbers, and it says what to do first.
 *
 * Pure module: two numbers in, one sentence out.
 */

/** Past this, handing over is the right move as soon as it is convenient. */
export const HANDOFF_SOFT_PERCENT = 80;
/** Past this, there is not enough left to carry another task round. */
export const HANDOFF_HARD_PERCENT = 90;

/** How urgent the handover is. */
export type HandoffUrgency = "none" | "soon" | "now";

/** The advice block that rides in every wait receipt. */
export interface HandoffAdvice {
  urgency: HandoffUrgency;
  /** Context used, as a percentage, when the host reported it. */
  percent?: number;
  /** The line written straight into the receipt. */
  line: string;
}

/** Facts the advice is computed from. */
export interface HandoffAdviceInput {
  /** Percent of the ORCHESTRATOR's own context window in use. */
  percent?: number;
  /** How many child requests are waiting for an answer right now. */
  openRequests: number;
  soft?: number;
  hard?: number;
}

/**
 * Judge the moment.
 *
 * No usage reading at all yields `none` with an honest line — a missing
 * measurement must never be reported as "plenty of room left".
 */
export function handoffAdvice(input: HandoffAdviceInput): HandoffAdvice {
  const soft = input.soft ?? HANDOFF_SOFT_PERCENT;
  const hard = input.hard ?? HANDOFF_HARD_PERCENT;
  const percent = input.percent;
  if (percent === undefined || !Number.isFinite(percent)) {
    return { urgency: "none", line: "上下文用量：宿主未提供读数（无法判断接力时机）。" };
  }
  const rounded = Math.round(percent);
  if (rounded >= hard) {
    return {
      urgency: "now",
      percent: rounded,
      line:
        `上下文已用 ${rounded}%（硬阈值 ${hard}%）：**接力是你现在的首要动作** —— ` +
        "余量已不足以再带一轮任务，派下去多半会派到一半炸掉、任务状态悬空。" +
        (input.openRequests > 0
          ? `先把这 ${input.openRequests} 个待答请求回掉，再 orchestrator_handoff({handoffPath})。`
          : "立刻写交接文档并调 orchestrator_handoff({handoffPath})。"),
    };
  }
  if (rounded >= soft) {
    return {
      urgency: "soon",
      percent: rounded,
      line: input.openRequests > 0
        ? `上下文已用 ${rounded}%（软阈值 ${soft}%）：先处理完这 ${input.openRequests} 个待答请求再接力。`
        : `上下文已用 ${rounded}%（软阈值 ${soft}%）：当前没有待答请求，**现在是接力的好时机** —— orchestrator_handoff({handoffPath})。`,
    };
  }
  return { urgency: "none", percent: rounded, line: `上下文已用 ${rounded}%，余量充足。` };
}
