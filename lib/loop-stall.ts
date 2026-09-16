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
 * WHAT THE SIGNATURE WAS MISSING (2026-09-16, measured). The first version
 * only looked at code and verdicts, so a session spending 80 minutes
 * NEGOTIATING — rewriting the requirement restatement, revising the goal draft
 * seven times, answering the user's questions — looked exactly like a session
 * that had done nothing: no fingerprint change, no verdict, no new round. The
 * breaker tripped, and the notice blamed the provider, sending the user to
 * inspect a model chain that had never failed (OneKeyHQ notification session
 * 01a0a99e-f809-7125-914d-7d5f55ee0866, 2026-09-16). Two facts fix it:
 * negotiating IS progress (the contract on the table enters the signature),
 * and a gate↔user exchange is an EVENT that counts as motion (see
 * `stallInMotion`).
 *
 * WHAT THE FIX DOES NOT DO: it does not excuse a session that went quiet. Both
 * facts are events, not grace periods — once the conversation stops and the
 * contract stops changing, the ordinary no-progress counting resumes at the
 * very next observation.
 *
 * AND THE NOTICE NAMES THE REAL CAUSE. A breaker that always blames the
 * provider is worse than no breaker: it sends the agent and the user to look
 * in the one place that was never broken. `classifyStallCause` reads the state
 * the gate actually has (is a dialog waiting for the user? is the goal
 * unapproved? are there unreviewed changes?) and only falls back to the
 * external causes when nothing else is true. Its three parts (现象 / 原因 /
 * 下一步) are rendered by lib/rejection-copy.ts, the gate's one refusal shape
 * (docs/coding-standards.md §7).
 *
 * This is TIGHTEN-ONLY in the direction that matters: it never opens the ship
 * gate, never manufactures a verdict, and never shortens the review. It only
 * stops the extension from talking to itself. Pure, no I/O — the extension
 * owns the state and this module owns the decision.
 */

import { buildRejection, type RejectionActor } from "./rejection-copy.ts";

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
  /**
   * The requirement contract currently on the table (see
   * {@link negotiationFingerprint}). A session whose job right now is to
   * AGREE on the work has not stalled when the code does not move — it moved
   * the contract. Compare it against the goal text purely by hash: this is a
   * change detector, never a claim about the text's quality.
   */
  contract: string;
}

/**
 * The contract on the table, as one comparable string.
 *
 * Three hashes the gate already records: the confirmed requirement
 * restatement, the draft the goal auditor last judged, and the approved goal.
 * A missing part renders as JSON `null` (never as an empty string or a
 * placeholder) so "never restated" cannot collide with "restated, hash
 * absent".
 */
export function negotiationFingerprint(input: {
  restatementHash?: string | undefined;
  goalDraftHash?: string | undefined;
  goalApprovalHash?: string | undefined;
}): string {
  // JSON, not a joined sentinel: "never restated" (null) can then never be
  // confused with a hash that happens to look like the placeholder.
  return JSON.stringify([
    input.restatementHash ?? null,
    input.goalDraftHash ?? null,
    input.goalApprovalHash ?? null,
  ]);
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
    // Same reason as the problems list: a contract is a hash triple joined by
    // the same separator, so encode it rather than trusting its shape.
    JSON.stringify(inputs.contract),
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
 * The observed facts that make an unchanged signature believable — or not.
 *
 * Every one of them is EXTERNAL INPUT the loop is legitimately waiting on, or
 * an event that happened since the last look. "Nothing the gate can see moved"
 * and "nothing happened at all" are different claims, and only the second one
 * justifies stopping the loop.
 */
export interface StallMotionFacts {
  /** A judge child is running and not older than STALL_MOTION_MAX_AGE_SEC. */
  judgeInFlight: boolean;
  /** The gate's own directive to negotiate the goal is overdue (lib/loop-goal.ts). */
  forceNegotiate: boolean;
  /**
   * The gate's own dialog is up, WAITING FOR THE USER'S ANSWER (ask_user, the
   * restatement confirmation, the goal approval, the plan approval).
   *
   * A NOTE FOR THE CALLER'S READER: `agent_settled` returns before the stall
   * evaluation while a question is parked, so this input never fires at
   * TODAY's single call site. It is in the contract on purpose — "waiting for
   * the user is not a stall" is a rule of the breaker, not a side effect of
   * the order of two guards in a 12k-line file, and the next caller must not
   * have to rediscover it. It is also what keeps the two "waiting on a person"
   * facts (a dialog parked, a dialog answered) in one place.
   */
  pausedForUser: boolean;
  /** ISO of the last gate↔user exchange that came back with an answer. */
  lastUserInteractionAt?: string | undefined;
  /** ISO of the PREVIOUS stall observation; undefined on the first one. */
  previousObservationAt?: string | undefined;
}

/**
 * IS THIS TURN IN MOTION? — the ONE place that answers it for the breaker.
 *
 * Three of the four facts are "the loop is waiting on purpose": a judge's
 * verdict, the gate's own negotiation directive, the user's answer to a
 * dialog. The fourth is an EVENT: the gate exchanged a dialog with the user
 * after the previous observation, which is what a negotiation looks like when
 * nothing in the contract changed (the user interrupted with an unrelated
 * question, say).
 *
 * WHY AN EVENT AND NOT A GRACE PERIOD (user decision, 2026-09-16): a window
 * measured from the last interaction would keep excusing a session that had
 * gone to sleep for as long as the window is long — the fail-open direction.
 * An interaction that happened BEFORE the previous observation proves nothing
 * about this turn, so it does not count, no matter how recent it is.
 */
export function stallInMotion(facts: StallMotionFacts): boolean {
  if (facts.judgeInFlight || facts.forceNegotiate || facts.pausedForUser) return true;
  const at = facts.lastUserInteractionAt;
  const since = facts.previousObservationAt;
  if (!at || !since) return false;
  const answered = Date.parse(at);
  const previous = Date.parse(since);
  // An unreadable timestamp is NOT a match (fail-closed: the ordinary counting
  // resumes rather than the exemption being granted on a parse failure).
  if (!Number.isFinite(answered) || !Number.isFinite(previous)) return false;
  return answered >= previous;
}

/** WHY the loop stopped moving — the attribution the notice owes its reader. */
export type StallCause = "waiting-user" | "goal-unapproved" | "gates-unmet" | "unexplained";

/**
 * HOW RECENT an exchange with the user has to be for "we are waiting on a
 * person" to be the honest reading of a stalled loop.
 *
 * WHY A WINDOW IS NEEDED AT ALL (functional round P2, 2026-09-16): the first
 * version asked only whether the session had EVER answered a gate dialog, which
 * is true for the rest of the session once the goal approval closes — so the
 * `unexplained` branch (the only one that names the provider) became
 * unreachable, and a real provider outage would be reported as "waiting for
 * you, not the provider". Recency is what separates the two.
 *
 * It is a REPORTING threshold, never an exemption: whether the loop is excused
 * is `stallInMotion`'s event rule, and nothing here can keep the breaker off.
 */
export const STALL_WAITING_USER_WINDOW_SEC = 30 * 60;

/**
 * WHICH CAUSE THE GATE CAN ACTUALLY SEE — most specific first.
 *
 * The order is the contract: every fact below is read from the sidecar, and a
 * cause may only be claimed when nothing narrower is true. "Provider is down"
 * is the LAST resort, not the first guess — it is the one cause the agent
 * cannot verify from inside the loop, so naming it wrongly costs a round of
 * looking in the wrong place. And every other branch has to be REACHABLE for
 * that last one to mean anything: see the window above.
 *
 * `hasUnreviewedChanges` is "this session edited something and no READY covers
 * it" — the case where the agent has an obvious next action and was simply not
 * doing it. It is NOT a claim that the provider is fine; the notice's own
 * next-step text says what to do when repeating that action changes nothing.
 */
export function classifyStallCause(input: {
  pausedForUser: boolean;
  goalConfirmed: boolean;
  hasUnreviewedChanges: boolean;
  /** ISO of the last gate↔user exchange that got an answer. */
  lastUserInteractionAt?: string | undefined;
  /** Now, in ms — passed in so the rule stays pure and testable. */
  nowMs: number;
  /** The recency window; see STALL_WAITING_USER_WINDOW_SEC. */
  windowSec?: number;
}): StallCause {
  if (input.pausedForUser) return "waiting-user";
  if (!input.goalConfirmed) return "goal-unapproved";
  if (input.hasUnreviewedChanges) return "gates-unmet";
  return withinWindow(input.lastUserInteractionAt, input.nowMs, input.windowSec ?? STALL_WAITING_USER_WINDOW_SEC)
    ? "waiting-user"
    : "unexplained";
}

/**
 * Did this ISO stamp land inside the window? Unreadable stamps are NOT recent
 * (fail-closed: the message falls back to the external causes rather than
 * claiming a conversation it cannot date).
 */
function withinWindow(at: string | undefined, nowMs: number, windowSec: number): boolean {
  if (!at) return false;
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return false;
  return nowMs - parsed <= windowSec * 1000;
}

/**
 * The message shown when the breaker trips.
 *
 * It must state the CAUSE THE GATE OBSERVED and the next step that clears it —
 * the same three parts every gate refusal carries (lib/rejection-copy.ts,
 * docs/coding-standards.md §7) — and it must say plainly that the gate is NOT
 * relaxed. Provider troubleshooting survives only where it belongs: in the
 * `unexplained` branch, where every gate-visible fact was checked and none
 * explained the stall.
 */
const CAUSE_COPY: Record<StallCause, { why: string; by: RejectionActor; next: string }> = Object.freeze({
  "waiting-user": {
    why: "最近一次推进来自与用户的对话：之后既没有代码改动，也没有新的裁决或协商版本 —— 是在等用户，不是 provider。",
    by: "agent",
    next: "还有没问清的决定就用 `ask_user` 问（它会暂停循环等回答，别把问题写进回复等消息）；" +
      "用户答完就继续做，门禁不会因为对话而放松要求。",
  },
  "goal-unapproved": {
    why: "本轮还没有获批的 loop goal —— 门禁在 goal 批准前不会放行收尾，代码改没改都不影响这一条。",
    by: "agent",
    next: "先协商 goal：有疑点用 `ask_user` 问，`propose_restatement` 把理解反述给用户确认，" +
      "再 `propose_loop_goal`（门禁自己跑 goal 审计并请用户批准）。",
  },
  "gates-unmet": {
    why: "门禁还有未满足项（review / precommit 没通过），而签名连续若干轮一字未变 —— " +
      "你很可能在重复同一件没有生效的事。",
    by: "agent",
    next: "先按上面那份未满足清单把该做的做完（review 未 READY 就 `judge_submit({role:\"reviewer\"})` 送审并修 findings；" +
      "precommit FAIL 先修失败项）。**如果这一步你已经反复做过而记录毫无变化**，那就不是清单的问题：" +
      "运行 `/gate-doctor` 检查模型链与环境、确认 provider 可用，再重试。",
  },
  unexplained: {
    why: "签名里的每一项都没动，也没有等待用户回答的问题或未获批的 goal —— " +
      "这种停滞通常来自外部：模型/服务商不可用或额度耗尽（429）、子代理启动失败、外部依赖阻塞。",
    by: "agent",
    next: "运行 `/gate-doctor` 查看模型链与环境、确认 provider 状态；修复后你的下一条消息会重新开始循环。",
  },
});

export function buildStallNotice(repeats: number, cause: StallCause): string {
  const copy = CAUSE_COPY[cause];
  return (
    buildRejection({
      what:
        `自动循环已熔断 —— 连续 ${repeats} 轮没有任何进展` +
        "（指纹、review/precommit 判定、轮次、未满足项、协商内容全部未变）。",
      why: copy.why,
      by: copy.by,
      next: copy.next,
    }) +
    "\n注意：质量门禁**未**被放宽，ship 命令仍然被拦截。"
  );
}
