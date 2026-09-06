/**
 * WHEN A JUDGE'S PANE IS RECLAIMED — two policies, on purpose, written down.
 *
 * The gate runs judges in tmux panes, and there are exactly TWO answers to
 * "when does that pane go away". They are different because the panes are
 * different, and the user settled it on 2026-09-06: keep both, do not unify
 * them. What was missing was not the behaviour — it was a place that says
 * WHICH is which and WHY, so the next reader cannot mistake the split for an
 * accident and "tidy it up".
 *
 * ── THE TWO POLICIES ──
 *
 *  (a) THE GATE'S OWN AUDITOR — reclaimed at ROUND END ("谁派谁收", O-6).
 *      `propose_loop_goal` and `orchestrator_plan({action:"submit"})` open a
 *      `goal-auditor` as their OWN implementation. The agent never asked for
 *      it, never sees it in an `orchestrator_wait` or `judge_wait` receipt,
 *      and therefore has no way to know it exists — so nobody but the chain
 *      that opened it can close it, and a leftover would block `declare_done`
 *      on a judge the agent was never told about. Its life is the CALL that
 *      opened it, not the session.
 *
 *  (b) THE AGENT'S REVIEW PANE — reclaimed at DECLARE_DONE.
 *      `judge_submit({role:"reviewer"})` opens a pane the agent asked for and
 *      a HUMAN reads. Closing it when the round ends would take the findings
 *      off the screen at the exact moment somebody wants to look at them, so
 *      it lives until the task does.
 *
 * ── WHY THIS MODULE HAS EXACTLY ONE EXECUTION POINT ──
 *
 * Only (a) is a decision anything makes at runtime, and it is made in ONE
 * place: `runAuditRound`'s reclaim step (lib/audit-round.ts). Policy (b) is
 * not enforced by a branch anywhere — it is enforced by the TOOL TOPOLOGY,
 * which is stronger:
 *
 *  - `judge_close` is registered on the INTERNAL host only, so the agent
 *    cannot close a judge pane at all (extensions/review-gate.ts: "its only
 *    callers are the gate's own audit chains");
 *  - `declare_done`'s cascade closes every judge of this opener, blind to who
 *    dispatched it, which is the terminus for anything still standing.
 *
 * So a "second execution point" would have to be `declare_done` asking this
 * module a question and then doing what it was going to do anyway. That is a
 * DECORATIVE call site, and a decorative call site is worse than none: it
 * tells the next reader the rule is enforced there when it is not. The
 * `declare_done` side is pinned by a TEST instead — the sweep is source-blind
 * and closes by opener — and that test and this docblock point at each other.
 *
 * A NOTE ON A DESIGN THAT WAS REJECTED (2026-09-06, adviser P1). Stamping the
 * dispatcher onto the registry entry was considered and dropped: the three
 * paths that can open a `goal-auditor` (this engine, `judge_submit`,
 * `judge_spawn`) all land on the SAME row (one per role+repo+opener+lane), so
 * the field would describe the last dispatch rather than the pane — and the
 * failure it was meant to expose cannot happen anyway, because `judge_close`
 * drops the row even when the kill fails.
 *
 * Pure: no filesystem, no clock, no process — the caller acts, this decides.
 */

/** Who opened the pane. The answer to "when is it reclaimed" follows from it. */
export type JudgePaneDispatcher =
  /** The gate itself, inside one of its own synchronous audit chains. */
  | "gate"
  /** The agent, through a tool it called on purpose. */
  | "agent";

/** The two moments a judge pane can be reclaimed at. */
export type JudgePaneReclaimPoint = "round-end" | "declare-done";

/** What the policy says about one dispatcher's panes. */
export interface JudgePaneReclaimPolicy {
  at: JudgePaneReclaimPoint;
  /**
   * Does the ROUND that opened it reclaim it? The one question a caller can
   * act on — pre-answered here so no call site compares strings and none of
   * them can disagree about what `"round-end"` spells.
   */
  atRoundEnd: boolean;
  /** Why, in one sentence — it goes into the audit log beside the outcome. */
  why: string;
}

const GATE_POLICY: JudgePaneReclaimPolicy = {
  at: "round-end",
  atRoundEnd: true,
  why: "门禁自派的审计员：agent 从没要求过它、也在任何回执里看不到它，只能谁派谁收",
};

const AGENT_POLICY: JudgePaneReclaimPolicy = {
  at: "declare-done",
  atRoundEnd: false,
  why: "agent 自派、人要看的 review pane：留到 declare_done 由级联关统一收",
};

/**
 * WHEN IS THIS DISPATCHER'S PANE RECLAIMED?
 *
 * The whole policy, as one lookup. Callers act on `atRoundEnd`; the two other
 * fields exist so a log line or a receipt can say what was decided and why
 * without re-deriving either.
 */
export function judgePaneReclaim(dispatcher: JudgePaneDispatcher): JudgePaneReclaimPolicy {
  return dispatcher === "gate" ? GATE_POLICY : AGENT_POLICY;
}

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
