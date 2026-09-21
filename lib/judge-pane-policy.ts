/**
 * WHEN A JUDGE'S PANE IS RECLAIMED — ONE policy, and it is ROUND END.
 *
 * ── WHAT IT REPLACED (user decision, 2026-09-21) ──
 *
 * There used to be TWO policies, written down on purpose (2026-09-06): the
 * gate's own auditor died at round end, while an agent-dispatched review pane
 * lived until `declare_done`, because "closing it when the round ends would
 * take the findings off the screen at the exact moment somebody wants to look
 * at them".
 *
 * The user's ruling is that the pane is SCREEN SPACE, not the deliverable:
 * the verdict is already on record, readable in the wake-up report and in the
 * review documents, and a finished pane sitting in the window costs room that
 * the next round wants. So every judge pane is freed when its round is
 * recorded, and the conversation is NOT lost with it — the next dispatch of
 * the same role re-opens the SAME session id ("a dead record falls through to
 * a fresh open below, the transcript continues by session id, so the review
 * never starts from zero"), which is what makes freeing the pane free.
 *
 * ── WHY THE DISPATCHER NO LONGER MATTERS ──
 *
 * The old split existed to answer ONE question — "does the round that opened
 * it reclaim it?" — and it is now the same answer for both dispatchers, so the
 * question, the `JudgePaneDispatcher` type and the lookup that answered it are
 * GONE rather than left as a two-branch table with identical branches. What
 * survives is {@link JUDGE_PANE_RECLAIM} (the policy, for a log line's wording)
 * and {@link reclaimAuditLine} (what a half-done reclaim looks like).
 *
 * `declare_done`'s cascade still closes whatever is left, blind to who opened
 * it: it is the terminus for a pane whose round never concluded (a killed
 * round, a crashed opener), not a second implementation of this rule.
 *
 * Pure: no filesystem, no clock, no process — the caller acts, this decides.
 */

/** The moment a judge pane is reclaimed. */
export type JudgePaneReclaimPoint = "round-end";

/** What the policy says, and why — the `why` goes into the audit log. */
export interface JudgePaneReclaimPolicy {
  at: JudgePaneReclaimPoint;
  /** Does the ROUND that opened it reclaim it? Pre-answered, so no call site
   *  compares strings and none of them can disagree about the spelling. */
  atRoundEnd: boolean;
  /** Why, in one sentence. */
  why: string;
}

/**
 * THE policy (2026-09-21). One constant, because there is one answer.
 */
export const JUDGE_PANE_RECLAIM: JudgePaneReclaimPolicy = Object.freeze({
  at: "round-end" as JudgePaneReclaimPoint,
  atRoundEnd: true,
  why: "一轮结论已记录，pane 就该让位：下一轮用同一 session id 重开，屏幕留给正在跑的那一轮",
});

/** What a reclaim attempt actually achieved, as the closing tool reported it. */
export interface JudgePaneReclaimOutcome {
  /** Did the close succeed as an operation (the registry row is gone)? */
  ok: boolean;
  /** Was a pane registered when the reclaim started? */
  hadPane: boolean;
  /** Did the close CONFIRM the pane is off the screen? */
  terminated: boolean;
  /** The closing tool's own one-line note, when it gave one. */
  note?: string | undefined;
}

/**
 * THE LINE A RECLAIM LEAVES IN THE AUDIT LOG — or `undefined` for silence.
 *
 * WHY THIS EXISTS (2026-09-06). The gate's own reclaim used to `await` the
 * close and throw its whole reply away. That reply is the only place a
 * half-done reclaim is ever visible: `judge_close` drops the registry row even
 * when the kill FAILS, and says so in that text ("关 pane 失败，登记照样清除").
 * Discarded, the outcome was a pane left on the user's screen that nothing
 * downstream can see any more — the row it would have been found by is gone.
 * The evidence existed at the scene and was thrown away at the scene.
 *
 * SILENCE IS THE NORMAL CASE, deliberately: a reclaim that did what the policy
 * says is not news, and a log that records every success is a log nobody
 * greps. A line is emitted only when the pane's fate is NOT what (a) promises:
 *
 *  - the close failed outright, or
 *  - a pane was registered and the close could not confirm it is gone
 *    (a kill that failed, or an id minted by a tmux server that has restarted,
 *    which is deliberately not killed).
 *
 * "Could not confirm" is reported as exactly that. A pane the user already
 * closed by hand lands here too, and the wording must not accuse the gate of
 * leaking one when all it can honestly say is that it did not see it go.
 */
export function reclaimAuditLine(input: {
  /** The judge role whose pane this was. */
  role: string;
  /** The policy this reclaim was executing. */
  policy: JudgePaneReclaimPolicy;
  outcome: JudgePaneReclaimOutcome;
}): string | undefined {
  const { role, policy, outcome } = input;
  const note = (outcome.note ?? "").trim();
  const tail = note === "" ? "" : `：${note}`;
  if (!outcome.ok) {
    return `judge pane 回收失败（${role}，政策：${policy.why}）——登记与 pane 都可能残留${tail}`;
  }
  if (outcome.hadPane && !outcome.terminated) {
    return `judge pane 回收未确认（${role}，政策：${policy.why}）——登记已清除，但没能确认 pane 已关闭${tail}`;
  }
  return undefined;
}
