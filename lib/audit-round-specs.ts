/**
 * WHAT EACH KIND OF ROUND *SAYS* — the half of the audit round that is
 * deliberately NOT shared.
 *
 * `lib/audit-round.ts` is the engine: one implementation of "dispatch a judge,
 * wait for THIS round, pick its report, adjudicate, record, reclaim the pane".
 * This file is its counterweight. Merging the mechanics was the whole point of
 * that module; merging the WORDING would have been a mistake, because the
 * sentence an agent reads has to tell it what to do next, and that differs per
 * kind — an agent whose plan audit just failed must be told to `submit` again,
 * not to call `propose_loop_goal`.
 *
 * So the split is: everything mechanical lives in the engine, everything a
 * human or an agent reads lives here, plus the two facts that decide which
 * wording applies (the judge role, and how that kind binds a report to a
 * round). A new kind of round is a new entry in this file and nothing else.
 *
 * It is also where the type a spec is written against lives, so the engine can
 * depend on this file and not the other way round.
 */

/**
 * The kinds of round a judge can close.
 *
 * `goal` / `plan` / `review` are the three that RECORD something. `advice` is
 * here because the adviser's round has to answer the same question — "which
 * report closes it?" — and answering that question in a second place is
 * exactly the duplication the engine removes. It records nothing.
 */
export type AuditKind = "goal" | "plan" | "review" | "advice";

/**
 * The audit a repo has DISPATCHED and not yet recorded.
 *
 * ONE per repo, deliberately (2026-09-05, user decision). Goal and plan audits
 * share a single `goal-auditor` judge id per repo, so at most one of them can
 * be in flight — the old two-map arrangement (`pendingGoalAudits` +
 * `pendingPlanAudits`) could REPRESENT a state the system cannot be in, and
 * paid for it with a "both pending" self-heal branch that guessed which one to
 * drop by timestamp. A single map makes that state unrepresentable, so the
 * branch is gone rather than fixed.
 *
 * The payload still differs by kind, because the RECORD BINDING differs: a
 * goal verdict binds to the sha256 of the draft text, a plan verdict to the
 * canonical plan hash. Merging the maps never meant merging the bindings.
 */
export type PendingAudit =
  | { kind: "goal"; draft: string; startedAt: string }
  | { kind: "plan"; hash: string; planText: string; startedAt: string };

/**
 * HOW A REPORT IS BOUND TO A ROUND — a per-kind binding, not a shared rule.
 *
 * - `round-bound` (goal / plan): the report must carry THIS dispatch's
 *   `roundSeq` AND be newer than the wait cursor. Both audits re-dispatch into
 *   the same judge session, so the channel's newest report is routinely the
 *   PREVIOUS round's; adjudicating it recorded stale findings against a new
 *   draft (the measured P0 behind `8ea7eec`).
 * - `cursor-only` (advice): the cursor alone. An adviser's round records no
 *   verdict at all, so there is nothing a stale report could misbind.
 * - `round-and-content` (review): the cursor, the ROUND, and the CONTENT this
 *   round judges — the report must carry THIS dispatch's `roundSeq` AND be
 *   stamped strictly later than the checkpoint the round was submitted on.
 *
 *   Cursor-only was measured to be not enough (2026-09-05, four reproductions
 *   in one session): a reviewer's report that lands while the agent is still
 *   editing is not delivered until the NEXT `judge_submit` settles, and the
 *   cursor accepted that leftover report as the new round's verdict — a READY
 *   bound to a commit the reviewer never saw, which is the one invariant the
 *   whole gate exists to hold. Both halves are required (user decision,
 *   2026-09-05): the round is the structural truth the judge stamps at
 *   conclude time, the content stamp is what makes "this verdict judged this
 *   tree" observable, and a coarse clock or a same-second race defeats the
 *   timestamp alone. A round that cannot be checked (no `roundSeq`, no report
 *   round, an unreadable report stamp against a checkpoint that DOES exist)
 *   fails CLOSED — it is never recorded on the strength of the other half.
 *
 *   The ONE exception, and it is not a weakening: a repo with no checkpoint at
 *   all is the "audit the exit goal" round (`prepare_review`, empty range,
 *   clean worktree), where nothing is frozen for a verdict to lag behind.
 *   Refusing it would not fail closed, it would make that round unclosable —
 *   no record, no round end, no reachable READY. The round binding and the
 *   cursor still carry it (reviewer P1 + user decision, 2026-09-05).
 */
export type ReportBinding = "round-bound" | "cursor-only" | "round-and-content";

/**
 * What the engine needs to know about a kind that is NOT mechanical: the role
 * it dispatches, how its reports bind to rounds, and the sentences a caller
 * reads.
 */
export interface AuditRoundSpec {
  kind: AuditKind;
  /** The judge role this kind dispatches (goal and plan share `goal-auditor`). */
  role: string;
  binding: ReportBinding;
  /**
   * Pane-title prefix — a DISPLAY label only. Goal and plan share the
   * `goal-auditor` role, so this is the one thing on screen that tells the two
   * apart; it must never reach the session directory (that is derived from
   * role+repo, and a per-round title would start a new session every round).
   */
  titlePrefix: string;
  /** The round ended without THIS round's report: nothing was recorded. */
  unfinished(detail: string): string;
  /** The judge could not even be started — nothing was dispatched. */
  notDispatched(reason: string): string;
  /** It was dispatched, but the registry cannot address it (a gate defect). */
  unaddressable(): string;
  /** The round was recorded and the verdict did NOT pass. */
  rejected(note: string | undefined, extra: { streamPath?: string }): string;
  /**
   * THE ROUND RAN UNDER A WEAKER BINDING, AND IT SAYS SO.
   *
   * Only the review kind has one, because only it can degrade: with no
   * checkpoint anywhere in the repo there is no content stamp to compare, so
   * the content half does not apply and round + cursor carry the round alone.
   *
   * It is a SENTENCE, not a flag, and it travels with the recorded verdict on
   * purpose (project manager, 2026-09-05): what makes a degradation dangerous
   * is not the degradation, it is an INVISIBLE one — an exception nobody sees
   * reads as the rule three rounds later.
   */
  degradedContentBinding?(): string;
}

export const GOAL_AUDIT_SPEC: AuditRoundSpec = {
  kind: "goal",
  role: "goal-auditor",
  binding: "round-bound",
  titlePrefix: "goal-auditor",
  unfinished: (detail) =>
    `review-gate: goal 审计没有等到本轮裁决（${detail}），什么都没有记录（fail-closed）——` +
    "草稿 **没有**被送到用户面前，也没有任何新 findings 要你改。\n" +
    "直接再调一次 `propose_loop_goal` 即可重跑审计。",
  notDispatched: (reason) => `review-gate: goal 审计没能启动 — ${reason}`,
  unaddressable: () =>
    "review-gate: goal 审计已启动，但登记表里找不到它 —— 这是门禁自身的缺陷，请重试。",
  rejected: (note, extra) =>
    "review-gate: goal 审计**没过**，用户那一关连问都没问 —— 先按下面的 findings 改草稿，" +
    "改完直接再调一次 `propose_loop_goal`（门禁会重新审计；裁决绑定文本，改一个字就要重审）。\n\n" +
    (note ?? "审计记录：NONE") +
    (extra.streamPath ? `\n\nfindings 流：${extra.streamPath}` : ""),
};

export const PLAN_AUDIT_SPEC: AuditRoundSpec = {
  kind: "plan",
  role: "goal-auditor",
  binding: "round-bound",
  titlePrefix: "plan-auditor",
  unfinished: (detail) =>
    `review-gate: plan 审计没有等到本轮裁决（${detail}），什么都没有记录` +
    "（fail-closed）——plan **没有**被送到用户面前。\n" +
    "直接再 `submit` 一次即可重跑审计。",
  notDispatched: (reason) =>
    `review-gate: plan 审计没能启动 —— ${reason}。plan 没有被送到用户面前。`,
  unaddressable: () =>
    "review-gate: plan 审计已启动，但登记表里找不到它 —— 这是门禁自身的缺陷，请重试。",
  // The plan's refusal text is BUILT from its record (findings and all) by
  // `formatPlanAuditRefusal`, so the recorded note IS the refusal.
  rejected: (note) =>
    note ??
    "review-gate: plan 审计没过，但门禁没能取回它的记录——直接再 `submit` 一次即可重跑审计。",
};

/**
 * The code review's spec. It has no dispatch half (a review is submitted by
 * `judge_submit` and concluded later), so only the two sentences the
 * conclusion half can produce are real; `notDispatched` / `unaddressable`
 * exist to satisfy the shape and are never reached.
 */
export const REVIEW_ROUND_SPEC: AuditRoundSpec = {
  kind: "review",
  role: "reviewer",
  binding: "round-and-content",
  titlePrefix: "reviewer",
  // The exception announces ITSELF, next to the verdict it applied to. A
  // degraded binding that only the code knows about is the one shape of this
  // exception nobody would ever catch drifting into the norm.
  degradedContentBinding: () =>
    "本轮绑定说明：本仓库还没有任何 checkpoint，这是 exit-goal 空范围轮 —— " +
    "内容时间判据（report 必须晚于本轮 checkpoint）**不适用**，本轮裁决只由 round 与 cursor 绑定。",
  // The detail TRAVELS here (2026-09-05): a review round that does not close
  // is usually "the reviewer is still working", but it can also be "a report
  // is sitting in the channel and it is not this round's". Swallowing the
  // detail is how the second case reads as the first, which is what let a
  // leftover verdict be adopted in the first place.
  unfinished: (detail) =>
    `reviewer 本轮还没有可记录的 channel report（${detail}）——门禁不会拿别的轮次的裁决顶本轮；` +
    "report 落盘后会用标准报告唤醒你，pane 已消失可用 judge_recover 重开。",
  notDispatched: (reason) => `review-gate: reviewer 本轮没能派出去 —— ${reason}`,
  unaddressable: () => "review-gate: reviewer 已启动，但登记表里找不到它 —— 这是门禁自身的缺陷，请重试。",
  rejected: (note) => note ?? "review-gate: 本轮裁决没有可读的记录。",
};

/**
 * Advice is a ROUND, but not a verdict: the adviser's whole deliverable is its
 * prose, and nothing records it. It has a spec anyway so that "which report
 * closes this round" has exactly ONE implementation — the reason the engine
 * exists. Its conclusion is surfaced, its cursor consumed, and no record is
 * ever written.
 */
export const ADVICE_ROUND_SPEC: AuditRoundSpec = {
  kind: "advice",
  role: "adviser",
  binding: "cursor-only",
  titlePrefix: "adviser",
  unfinished: () =>
    "adviser 本轮还没有落 channel report（pane 可能还在跑，或已消失）——门禁会在 report 落盘后用标准报告唤醒；pane 已消失可用 judge_recover 重开。",
  notDispatched: (reason) => `review-gate: adviser 本轮没能派出去 —— ${reason}`,
  unaddressable: () => "review-gate: adviser 已启动，但登记表里找不到它 —— 这是门禁自身的缺陷，请重试。",
  rejected: (note) => note ?? "adviser 的 report 为空——什么都没有记录。",
};

/**
 * WHICH SPEC THIS ROUND RUNS UNDER — role first, then the pending kind.
 *
 * Goal and plan audits share the `goal-auditor` role and one judge id per
 * repo, so the role alone cannot tell them apart: what the gate DISPATCHED
 * does, and that is exactly what the pending entry remembers. No pending
 * audit means there is nothing this round could be recorded against —
 * fail-closed by returning no spec at all, never by guessing a kind.
 */
export function specForRound(role: string, pendingKind?: AuditKind): AuditRoundSpec | undefined {
  if (role === "reviewer") return REVIEW_ROUND_SPEC;
  if (role === "adviser") return ADVICE_ROUND_SPEC;
  if (role !== "goal-auditor") return undefined;
  if (pendingKind === "goal") return GOAL_AUDIT_SPEC;
  if (pendingKind === "plan") return PLAN_AUDIT_SPEC;
  return undefined;
}
