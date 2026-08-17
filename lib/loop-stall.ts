/**
 * Auto-continuation stall detection (L2 circuit breaker).
 *
 * WHY: the L2 loop re-triggers whenever the gate is unmet, on the assumption
 * that another turn means another attempt at progress. That assumption breaks
 * when the blocker is EXTERNAL — a provider that is out of quota, a model that
 * cannot be reached, an API that 429s. Observed failure: after the judge
 * provider hit its rate limit, seven consecutive `[REVIEW_GATE_RESUME]`
 * injections fired ("continuation 4/10 … 10/10"), each telling the agent to
 * "fix → re-review", while nothing could possibly change. The whole
 * continuation budget burned without a single unit of progress, and the real
 * cause (provider unavailable) was never surfaced to the user.
 *
 * The fix is to distinguish "the gate is unmet" from "the gate is unmet AND
 * nothing moved since last time". A progress signature captures everything a
 * productive round would have to change: the worktree fingerprint, both
 * verdicts, the round count and the unmet list. When that signature repeats
 * `STALL_REPEAT_LIMIT` times in a row, continuing is provably pointless, so
 * the loop stops injecting and tells the user what to check.
 *
 * This is TIGHTEN-ONLY in the direction that matters: it never opens the ship
 * gate, never manufactures a verdict, and never shortens the review. It only
 * stops the extension from talking to itself. Pure, no I/O — the extension
 * owns the state and this module owns the decision.
 */

/** Identical signatures in a row before the loop is declared stalled. */
export const STALL_REPEAT_LIMIT = 3;

/**
 * How long a subagent may be "running" before it stops counting as motion.
 *
 * A review subagent in flight is the one case where an unchanged signature is
 * NORMAL: nothing can move until it returns. Treating those turns as a stall
 * would cut the loop off while the expensive judge is still working. But the
 * credit has to expire, or one hung run would disable the breaker for good.
 *
 * 10 minutes is measured against the artifact's LAST WRITE, not the run's
 * start: a live reviewer keeps streaming, so it keeps its credit however long
 * it thinks, while a run that has gone silent for ten minutes has stopped
 * being evidence of motion. Losing the credit is not fatal either — it only
 * re-arms the normal no-progress counting, and the completion wake still
 * resets everything the moment the verdict is recorded.
 */
export const STALL_MOTION_MAX_AGE_SEC = 600;

export interface ProgressInputs {
  /** Worktree fingerprint digest ("" when unavailable). */
  fingerprint: string;
  reviewVerdict: string;
  precommitVerdict: string;
  /** Completed review rounds. */
  rounds: number;
  /** The unmet-requirement lines, in the order the gate produced them. */
  problems: readonly string[];
}

export interface StallState {
  signature: string;
  /** How many consecutive evaluations produced this exact signature. */
  repeats: number;
}

export interface StallVerdict extends StallState {
  /** True once the loop has provably made no progress for the limit. */
  stalled: boolean;
}

export interface StallOptions {
  /**
   * True when work the gate can OBSERVE is still in flight (a subagent that is
   * running and not older than `STALL_MOTION_MAX_AGE_SEC`). Such a turn can
   * never be a stall: the loop is waiting on purpose.
   */
  inMotion?: boolean;
}

/**
 * Everything a productive continuation must be able to change. Any real
 * progress — an edit (fingerprint), a recorded verdict, a new round, or even
 * a different unmet item — yields a different signature and resets the count.
 */
export function progressSignature(inputs: ProgressInputs): string {
  return [
    inputs.fingerprint,
    inputs.reviewVerdict,
    inputs.precommitVerdict,
    String(inputs.rounds),
    // JSON-encoded, not joined: a problem line containing the separator would
    // otherwise let two DIFFERENT unmet lists collide into one signature and
    // be mistaken for "no progress".
    JSON.stringify(inputs.problems),
  ].join("\u0000");
}

/**
 * Fold the new signature into the previous stall state.
 *
 * A CHANGED signature always resets to a single observation: progress happened,
 * so the loop has earned its full budget again. Only an unchanged signature
 * accumulates, and `stalled` flips exactly at the limit (and stays true while
 * the situation persists, so the notice is emitted once per stall, not once
 * per turn — the caller keeps the returned state).
 */
export function evaluateStall(
  previous: StallState | undefined,
  signature: string,
  limit: number = STALL_REPEAT_LIMIT,
  options: StallOptions = {},
): StallVerdict {
  // Demonstrable motion outranks the signature: while a fresh subagent is
  // running, an unchanged signature is exactly what a HEALTHY round looks like
  // (the reviewer has not returned yet, so no verdict can have been recorded).
  // Counting those turns would trip the breaker on the loop's own review.
  if (options.inMotion) return { signature, repeats: 1, stalled: false };
  const repeats = previous && previous.signature === signature ? previous.repeats + 1 : 1;
  return { signature, repeats, stalled: repeats >= limit };
}

/**
 * The message shown when the breaker trips. It must name the likely external
 * causes, because the agent cannot diagnose them from inside the loop, and it
 * must state plainly that the gate is NOT relaxed.
 */
export function buildStallNotice(repeats: number): string {
  return (
    `review-gate: 自动循环已熔断 — 连续 ${repeats} 轮没有任何进展` +
    "（指纹、review/precommit 判定、轮次、未满足项全部未变）。\n" +
    "常见原因：模型/服务商不可用或额度耗尽（429）、子代理启动失败、外部依赖阻塞。\n" +
    "请检查 provider 状态或运行 /gate-doctor 查看模型链与环境；" +
    "修复后你的下一条消息会重新开始循环。\n" +
    "注意：质量门禁**未**被放宽，ship 命令仍然被拦截。"
  );
}
