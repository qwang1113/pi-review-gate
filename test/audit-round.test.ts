/**
 * THE AUDIT ROUND ENGINE — one round, four kinds, one implementation.
 *
 * These tests exist because the round used to be written three times and the
 * last three P0s all landed on the same binding defect in it. They run every
 * kind end to end against a fake channel and a fake registry, so the rules
 * that used to need a spawned judge to exercise are now plain assertions.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  describeRoundMiss,
  runAuditRound,
  roundBindingFor,
  roundHasReported,
  type RoundBinding,
  selectRoundReport,
  settleAuditRound,
  type AuditRoundEntry,
  type RunAuditRoundDeps,
  type SettleAuditRoundDeps,
} from "../lib/audit-round.ts";
import {
  ADVICE_ROUND_SPEC,
  GOAL_AUDIT_SPEC,
  PLAN_AUDIT_SPEC,
  REVIEW_ROUND_SPEC,
  specForRound,
  type PendingAudit,
} from "../lib/audit-round-specs.ts";
import type { ChannelRecord, ChannelReportRecord, ReportConclusion } from "../lib/orchestrator-channel.ts";
import type { PlanAuditRecord } from "../lib/orchestrator-plan-audit.ts";
import { judgePaneReclaim, type JudgePaneReclaimOutcome } from "../lib/judge-pane-policy.ts";

const NOW = "2026-09-05T12:00:00.000Z";
/** The checkpoint this round reviews — an hour BEFORE the reports above. */
const CHECKPOINT_AT = "2026-09-05T11:00:00.000Z";
const ROOT = "/work/pi-review-gate";

function childReport(
  reportId: string,
  opts: { round?: number; verdict?: string; at?: string | undefined } = {},
): ChannelRecord {
  return {
    kind: "report",
    from: "child",
    // `{ at: undefined }` is passed on purpose by the fail-closed cases: a
    // report with no usable stamp must be refused, not defaulted.
    at: "at" in opts ? (opts.at as string) : NOW,
    reportId,
    ...(opts.round === undefined ? {} : { round: opts.round }),
    verdict: opts.verdict ?? "BLOCKED",
  };
}

function orchestratorNote(): ChannelRecord {
  return {
    kind: "instruct",
    from: "orchestrator",
    at: NOW,
    instructId: "in-1",
    mode: "followUp",
    text: "下一轮任务",
  };
}

// ---------- which report closes this round ----------

test("selectRoundReport: an empty channel closes nothing", () => {
  assert.deepEqual(
    selectRoundReport([], { binding: "round-bound", expectedRound: 1, consumedReportId: undefined }),
    { ok: false, reason: "no-report" },
  );
});

test("selectRoundReport: the P0 — an older round's BLOCKED never closes a resubmit", () => {
  // Round 1 BLOCKED, recorded and consumed; the resubmit dispatches round 2.
  // The channel still holds only round 1: selecting for round 2 must miss.
  //
  // THIS IS THE COMBINED CELL, and the reason the ROUND is checked first: the
  // report is BOTH already-consumed AND from another round. Were the cursor
  // checked first, `already-consumed` would MASK the round mismatch — harmless
  // while nothing treats that reason as a pass, and an exact rerun of the P0
  // `8ea7eec` fixed the moment something does. The round is what makes a
  // report this round's; the cursor is the second net, not the safety.
  const records = [childReport("rep-round-1", { round: 1 })];
  assert.deepEqual(
    selectRoundReport(records, { binding: "round-bound", expectedRound: 2, consumedReportId: "rep-round-1" }),
    { ok: false, reason: "round-mismatch", reportId: "rep-round-1", round: 1, at: NOW, expectedRound: 2 },
    "a consumed report from ANOTHER round is refused as a round mismatch, not as a consumed one",
  );
});

// The same cell for a CURSOR-ONLY kind (advice), where the answer is
// deliberately different: an adviser's round has no round binding at all, so
// its consumed report is refused for being consumed. Pinning both keeps the
// per-kind difference visible instead of looking like an inconsistency.
test("selectRoundReport: a cursor-only kind refuses that same report as consumed", () => {
  const records = [childReport("rep-round-1", { round: 1 })];
  assert.deepEqual(
    selectRoundReport(records, { binding: "cursor-only", expectedRound: 2, consumedReportId: "rep-round-1" }),
    { ok: false, reason: "already-consumed", reportId: "rep-round-1" },
  );
});

// AND THE CELL THAT MUST STAY A PASS: this round's own report, consumed or
// not, is only ever refused for the cursor — never for its round.
test("selectRoundReport: THIS round's report is never refused on round grounds", () => {
  const records = [childReport("rep-round-2", { round: 2 })];
  const fresh = selectRoundReport(records, {
    binding: "round-bound",
    expectedRound: 2,
    consumedReportId: "rep-round-1",
  });
  assert.equal(fresh.ok, true, "unconsumed and this round's ⇒ it closes the round");
  assert.deepEqual(
    selectRoundReport(records, { binding: "round-bound", expectedRound: 2, consumedReportId: "rep-round-2" }),
    { ok: false, reason: "already-consumed", reportId: "rep-round-2" },
    "consumed but this round's ⇒ refused for the cursor, which is the only safe way to reach that reason",
  );
});

test("selectRoundReport: an unconsumed report from another round is still a miss", () => {
  const records = [childReport("rep-round-1", { round: 1 })];
  assert.deepEqual(
    selectRoundReport(records, { binding: "round-bound", expectedRound: 2, consumedReportId: undefined }),
    { ok: false, reason: "round-mismatch", reportId: "rep-round-1", round: 1, at: NOW, expectedRound: 2 },
  );
});

test("selectRoundReport: pre-tool reports without a round never match a real round", () => {
  const selected = selectRoundReport([childReport("rep-legacy")], {
    binding: "round-bound",
    expectedRound: 1,
    consumedReportId: undefined,
  });
  assert.equal(selected.ok, false);
  assert.equal((selected as { reason: string }).reason, "round-mismatch");
});

test("selectRoundReport: the current round's fresh report closes it", () => {
  const records = [childReport("rep-round-1", { round: 1 }), childReport("rep-round-2", { round: 2 })];
  const selected = selectRoundReport(records, {
    binding: "round-bound",
    expectedRound: 2,
    consumedReportId: "rep-round-1",
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.ok && selected.report.reportId, "rep-round-2");
});

test("selectRoundReport: only child reports count, newest one wins", () => {
  const records = [childReport("rep-round-2", { round: 2 }), orchestratorNote()];
  const selected = selectRoundReport(records, {
    binding: "round-bound",
    expectedRound: 2,
    consumedReportId: undefined,
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.ok && selected.report.reportId, "rep-round-2");
});

test("selectRoundReport: entries that pre-date round numbering fall back to the cursor", () => {
  const selected = selectRoundReport([childReport("rep-round-9", { round: 9 })], {
    binding: "round-bound",
    expectedRound: undefined,
    consumedReportId: undefined,
  });
  assert.equal(selected.ok, true);
});

// Advice binds on the cursor alone — nothing records it, so there is no
// verdict a stale report could misbind. The review path used to share this
// binding and no longer does (see the review section below); the per-kind
// difference is pinned on both sides.
test("selectRoundReport: a cursor-only kind ignores the round number entirely", () => {
  const records = [childReport("rep-round-1", { round: 1 })];
  const selected = selectRoundReport(records, {
    binding: "cursor-only",
    expectedRound: 7,
    consumedReportId: undefined,
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.ok && selected.report.reportId, "rep-round-1");
});

test("selectRoundReport: a cursor-only kind still refuses its own consumed report", () => {
  const records = [childReport("rep-1", { round: 1 })];
  assert.deepEqual(
    selectRoundReport(records, { binding: "cursor-only", expectedRound: 1, consumedReportId: "rep-1" }),
    { ok: false, reason: "already-consumed", reportId: "rep-1" },
  );
});

// ---------- the review binding: round AND content, both fail-closed ----------

/**
 * THE FOUR MEASURED MISBINDINGS (2026-09-05, one session).
 *
 * Each is a reviewer report that landed while the agent was still editing, was
 * never delivered, and was then adopted as the NEXT round's verdict — binding a
 * READY to a commit that reviewer never saw. The invariant they all break is
 * the same one line: the report was stamped BEFORE the checkpoint of the round
 * it got recorded against.
 */
const MEASURED_MISBINDINGS: ReadonlyArray<{ report: string; checkpoint: string }> = [
  { report: "2026-09-05T01:46:14.000Z", checkpoint: "2026-09-05T01:49:10.000Z" },
  { report: "2026-09-05T02:23:16.000Z", checkpoint: "2026-09-05T02:24:26.000Z" },
  { report: "2026-09-05T02:35:10.000Z", checkpoint: "2026-09-05T02:36:06.000Z" },
  { report: "2026-09-05T02:37:39.000Z", checkpoint: "2026-09-05T02:38:45.000Z" },
];

test("review binding: every measured misbinding is refused as stale content", () => {
  MEASURED_MISBINDINGS.forEach((m, i) => {
    // The ROUND matches on purpose here: this pins the CONTENT half on its own,
    // so a later refactor cannot delete it and still pass on the round check.
    const selected = selectRoundReport(
      [childReport(`rep-${i + 1}`, { round: 4, verdict: "READY", at: m.report })],
      { binding: "round-and-content", expectedRound: 4, consumedReportId: undefined, contentAt: m.checkpoint },
    );
    assert.equal(selected.ok, false, `misbinding #${i + 1} must not close the round`);
    assert.equal(selected.ok === false && selected.reason, "stale-content");
    assert.equal(selected.ok === false && selected.at, m.report, "the miss names the report it refused");
    assert.equal(selected.ok === false && selected.contentAt, m.checkpoint);
  });
});

test("review binding: a report stamped after this round's checkpoint closes it", () => {
  const selected = selectRoundReport(
    [childReport("rep-fresh", { round: 4, verdict: "READY", at: "2026-09-05T01:50:40.419Z" })],
    {
      binding: "round-and-content",
      expectedRound: 4,
      consumedReportId: undefined,
      contentAt: "2026-09-05T01:49:10.000Z",
    },
  );
  assert.equal(selected.ok, true, "the faithful timeline is recorded — zero false positives");
  assert.equal(selected.ok && selected.report.reportId, "rep-fresh");
});

test("review binding: equal stamps are refused — strictly newer, not 'not older'", () => {
  const selected = selectRoundReport([childReport("rep-tie", { round: 1, at: CHECKPOINT_AT })], {
    binding: "round-and-content",
    expectedRound: 1,
    consumedReportId: undefined,
    contentAt: CHECKPOINT_AT,
  });
  assert.equal(selected.ok === false && selected.reason, "stale-content");
});

// NO FALLBACK BETWEEN THE TWO HALVES (user decision, 2026-09-05). A stamp that
// clears the checkpoint says nothing about which round the report closes: the
// judge re-reads the registered round when it concludes, so a report from the
// previous round can be arbitrarily fresh.
test("review binding: a round mismatch is refused even when the stamp is fresh", () => {
  const selected = selectRoundReport([childReport("rep-prev", { round: 3, verdict: "READY", at: NOW })], {
    binding: "round-and-content",
    expectedRound: 4,
    consumedReportId: undefined,
    contentAt: CHECKPOINT_AT,
  });
  assert.equal(selected.ok === false && selected.reason, "round-mismatch");
  assert.equal(selected.ok === false && selected.round, 3);
  assert.equal(selected.ok === false && selected.expectedRound, 4);
});

test("review binding: a report with no round of its own never closes a round", () => {
  const selected = selectRoundReport([childReport("rep-legacy", { at: NOW })], {
    binding: "round-and-content",
    expectedRound: 4,
    consumedReportId: undefined,
    contentAt: CHECKPOINT_AT,
  });
  assert.equal(selected.ok === false && selected.reason, "round-mismatch");
});

test("review binding: an unregistered round fails closed instead of trusting the stamp", () => {
  const selected = selectRoundReport([childReport("rep-1", { round: 4, at: NOW })], {
    binding: "round-and-content",
    expectedRound: undefined,
    consumedReportId: undefined,
    contentAt: CHECKPOINT_AT,
  });
  assert.equal(selected.ok === false && selected.reason, "round-unknown");
});

test("review binding: an unreadable report stamp fails closed against a real checkpoint", () => {
  const base = { binding: "round-and-content" as const, expectedRound: 4, consumedReportId: undefined };
  const noReportStamp = selectRoundReport([childReport("rep-1", { round: 4, at: undefined })], {
    ...base,
    contentAt: CHECKPOINT_AT,
  });
  assert.equal(noReportStamp.ok === false && noReportStamp.reason, "content-unknown");
  const unparseable = selectRoundReport([childReport("rep-2", { round: 4, at: "昨天下午" })], {
    ...base,
    contentAt: CHECKPOINT_AT,
  });
  assert.equal(unparseable.ok === false && unparseable.reason, "content-unknown");
});

// THE ONE CASE THAT IS NOT REFUSED, and why (reviewer P1 + user decision,
// 2026-09-05). `prepare_review` supports a round with NO checkpoint at all —
// the "audit the exit goal" round: empty range, clean worktree, the reviewer
// judges whether the task is done. Refusing it would not fail closed, it would
// make it UNCLOSABLE: nothing recorded, the probe never ends the round, no
// reachable READY. The round binding still carries it.
test("review binding: no checkpoint at all is the exit-goal round, not a refusal", () => {
  const base = { binding: "round-and-content" as const, expectedRound: 4, consumedReportId: undefined };
  const exitGoal = selectRoundReport([childReport("rep-exit", { round: 4, at: NOW })], {
    ...base,
    contentAt: undefined,
  });
  assert.equal(exitGoal.ok, true, "an exit-goal round can still reach a verdict");
  // …and the round half is untouched by the exception.
  const stillRoundBound = selectRoundReport([childReport("rep-prev", { round: 3, at: NOW })], {
    ...base,
    contentAt: undefined,
  });
  assert.equal(stillRoundBound.ok === false && stillRoundBound.reason, "round-mismatch");
});

test("review binding: its own consumed report is still just 'already recorded'", () => {
  // The settle sweep re-observes the round it just recorded on every pass. That
  // must stay SILENT (the engine drops the text for this reason), or every
  // sweep would nag about a verdict that is already on record.
  const selected = selectRoundReport([childReport("rep-4", { round: 4, at: NOW })], {
    binding: "round-and-content",
    expectedRound: 4,
    consumedReportId: "rep-4",
    contentAt: CHECKPOINT_AT,
  });
  assert.deepEqual(selected, { ok: false, reason: "already-consumed", reportId: "rep-4" });
});

test("roundBindingFor: only the review kind carries a content stamp", () => {
  assert.deepEqual(roundBindingFor({ role: "reviewer", roundSeq: 3, checkpointAt: CHECKPOINT_AT }), {
    binding: "round-and-content",
    expectedRound: 3,
    contentAt: CHECKPOINT_AT,
  });
  // A goal or plan audit runs before any checkpoint exists — handing it the
  // content stamp (or refusing it for the lack of one) would strand the first
  // audit of every session.
  assert.deepEqual(roundBindingFor({ role: "goal-auditor", pendingKind: "goal", roundSeq: 3, checkpointAt: CHECKPOINT_AT }), {
    binding: "round-bound",
    expectedRound: 3,
    contentAt: undefined,
  });
  assert.deepEqual(roundBindingFor({ role: "goal-auditor", pendingKind: "plan", roundSeq: 3 }), {
    binding: "round-bound",
    expectedRound: 3,
    contentAt: undefined,
  });
  assert.deepEqual(roundBindingFor({ role: "adviser", roundSeq: 3, checkpointAt: CHECKPOINT_AT }), {
    binding: "cursor-only",
    expectedRound: 3,
    contentAt: undefined,
  });
  // No spec (a goal-auditor with nothing pending): the probe keeps its old
  // cursor-only behaviour, and the RECORDER never gets this far — it refuses
  // the round for having no kind to record against.
  assert.equal(roundBindingFor({ role: "goal-auditor" }).binding, "cursor-only");
});

// The yes/no form of the SAME question, for the two callers that only need
// "is this judge still working?" (the wait-discipline hint and the stall
// breaker). They used to compare a report against the PANE's spawn time, which
// the pane outliving the round makes wrong in the ordinary case.
test("roundHasReported: only THIS round's report — or the cursor — counts as answered", () => {
  const binding: RoundBinding = { binding: "round-and-content", expectedRound: 2, contentAt: CHECKPOINT_AT };
  assert.equal(roundHasReported([], binding, undefined), false, "no report at all");
  const thisRound = [childReport("rep-2", { round: 2, at: NOW })];
  assert.equal(roundHasReported(thisRound, binding, undefined), true, "this round's report answers it");
  assert.equal(roundHasReported(thisRound, binding, "rep-2"), true, "…and so does the cursor, once recorded");
  // THE CASE THE OLD COMPARISON GOT WRONG: round 1's report is newer than the
  // pane's spawn, but round 2 has just started and is owed an answer.
  assert.equal(
    roundHasReported([childReport("rep-1", { round: 1, at: NOW })], binding, "rep-1"),
    false,
    "a previous round's report does not answer the round the judge is on now",
  );
  assert.equal(
    roundHasReported([childReport("rep-stale", { round: 2, at: "2026-09-05T10:00:00.000Z" })], binding, undefined),
    false,
    "…nor does one that predates this round's content",
  );
});



test("describeRoundMiss names both sides of whatever did not match", () => {
  assert.match(describeRoundMiss({ reason: "round-mismatch", round: 3, expectedRound: 4 }), /第 3 轮/);
  assert.match(describeRoundMiss({ reason: "round-mismatch", round: 3, expectedRound: 4 }), /第 4 轮/);
  assert.match(describeRoundMiss({ reason: "no-report" }), /还没有本轮 report/);
  assert.match(describeRoundMiss({ reason: "round-unknown", reportId: "rep-1" }), /roundSeq/);
  // The stale-content sentence has to carry BOTH stamps: it is the one a human
  // checks against the channel file and the gate state.
  const stale = describeRoundMiss({
    reason: "stale-content",
    reportId: "rep-1",
    at: "2026-09-05T01:46:14.000Z",
    contentAt: "2026-09-05T01:49:10.000Z",
  });
  assert.match(stale, /rep-1/);
  assert.match(stale, /01:46:14/);
  assert.match(stale, /01:49:10/);
  assert.match(describeRoundMiss({ reason: "content-unknown", reportId: "rep-1" }), /无法比对/);
});

// ---------- which spec a round runs under ----------

test("specForRound: the role decides, except for the two that share one judge", () => {
  assert.equal(specForRound("reviewer"), REVIEW_ROUND_SPEC);
  assert.equal(specForRound("adviser"), ADVICE_ROUND_SPEC);
  assert.equal(specForRound("goal-auditor", "goal"), GOAL_AUDIT_SPEC);
  assert.equal(specForRound("goal-auditor", "plan"), PLAN_AUDIT_SPEC);
  // No pending audit ⇒ nothing this round could be recorded against. The kind
  // is never guessed from the role alone.
  assert.equal(specForRound("goal-auditor"), undefined);
  assert.equal(specForRound("something-else", "goal"), undefined);
});

// ---------- the conclusion half, per kind ----------

interface FakeState {
  records: ChannelRecord[];
  entry: AuditRoundEntry | undefined;
  pending: PendingAudit | undefined;
  cursors: string[];
  forgotten: string[];
  planRecords: PlanAuditRecord[];
  /** Lines the engine wrote to `.pi/review-gate-audit.log` (B2). */
  auditLog: string[];
  goalDrafts: string[];
  reviewRounds: number;
  /** undefined = "could not record right now" (no usable tool context). */
  recordResult: string | undefined;
  /**
   * `checkpoint.at` of the repo — the content stamp a REVIEW verdict must be
   * newer than. Default: an hour before the reports, i.e. a healthy round.
   */
  checkpointAt: string | undefined;
}

function makeSettleDeps(over: Partial<FakeState> = {}): { state: FakeState; deps: SettleAuditRoundDeps } {
  const state: FakeState = {
    records: [],
    entry: { judgeId: "j-1", openerId: "o-1", role: "reviewer", roundSeq: 2, lastReportId: "rep-round-1" },
    pending: undefined,
    cursors: [],
    forgotten: [],
    planRecords: [],
    auditLog: [],
    goalDrafts: [],
    reviewRounds: 0,
    recordResult: "recorded",
    checkpointAt: CHECKPOINT_AT,
    ...over,
  };
  const deps: SettleAuditRoundDeps = {
    judgeEntry: (judgeId) => (state.entry?.judgeId === judgeId ? state.entry : undefined),
    readRoundRecords: () => state.records,
    conclusionOf: (report: ChannelReportRecord): ReportConclusion => ({
      verdict: report.verdict ?? "",
      findings: [{ severity: "P1", issue: "边界没覆盖真实落点" }],
    }),
    proseOf: (report) => (report.reportId === "rep-empty" ? "" : "建议：先切分模块"),
    advanceCursor: (_judgeId, reportId) => { state.cursors.push(reportId); },
    pendingAudit: () => state.pending,
    // FAITHFUL: the extension's dep really deletes the entry. A fake that only
    // records the call would let the engine keep seeing a pending audit that
    // production has already consumed — and that is exactly the branch the
    // synchronous chain walks after its wait recorded the round (reviewer P1).
    forgetPending: (root) => { state.forgotten.push(root); state.pending = undefined; },
    nowIso: () => NOW,
    checkpointAt: () => state.checkpointAt,
    savePlanAudit: (_root, record) => { state.planRecords.push(record); },
    log: (message) => { state.auditLog.push(message); },
    recordGoal: async ({ pending }) => {
      state.goalDrafts.push(pending.draft);
      return state.recordResult;
    },
    recordReview: async () => {
      state.reviewRounds += 1;
      return state.recordResult;
    },
  };
  return { state, deps };
}

test("settle/review: the round is recorded and its cursor consumed exactly once", async () => {
  const { state, deps } = makeSettleDeps({ records: [childReport("rep-2", { round: 2, verdict: "READY" })] });
  const first = await settleAuditRound(deps, { judgeId: "j-1", root: ROOT });
  assert.equal(first.status, "recorded");
  assert.equal(first.status === "recorded" && first.kind, "review");
  assert.equal(first.status === "recorded" && first.hasVerdict, true);
  assert.equal(state.reviewRounds, 1);
  assert.deepEqual(state.cursors, ["rep-2"]);
  // A code review has no pending audit to forget — that bookkeeping belongs to
  // the two contract audits alone.
  assert.deepEqual(state.forgotten, []);

  // THE SAME REPORT, A SECOND PATH (the wait and the settle sweep both close
  // rounds). The cursor the first one wrote is what makes this a no-op.
  state.entry = { ...state.entry!, lastReportId: "rep-2" };
  const second = await settleAuditRound(deps, { judgeId: "j-1", root: ROOT });
  assert.equal(second.status, "miss");
  assert.equal(second.status === "miss" && second.reason, "already-consumed");
  // Silence, not a fail-closed notice: it IS recorded, just not by this call.
  assert.equal(second.status === "miss" && second.text, undefined);
  assert.equal(state.reviewRounds, 1, "one report, one record");
});

// THE P0 AT THE RECORDING LEVEL (2026-09-05). The selector tests above pin the
// rule; these pin that the RECORDER obeys it — nothing written, nothing
// forgotten, cursor untouched, and the agent told which report was set aside.
test("settle/review: a report older than this round's checkpoint records NOTHING", async () => {
  const { state, deps } = makeSettleDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "reviewer", roundSeq: 2, lastReportId: undefined },
    records: [childReport("rep-stale", { round: 2, verdict: "READY", at: "2026-09-05T01:46:14.000Z" })],
    checkpointAt: "2026-09-05T01:49:10.000Z",
  });
  const settled = await settleAuditRound(deps, { judgeId: "j-1", root: ROOT });
  assert.equal(settled.status, "miss");
  assert.equal(settled.status === "miss" && settled.reason, "stale-content");
  const text = settled.status === "miss" ? settled.text ?? "" : "";
  assert.match(text, /rep-stale/, "the refusal names the report it did not adopt");
  assert.match(text, /01:49:10/, "…and the checkpoint it was measured against");
  assert.equal(state.reviewRounds, 0, "a leftover verdict is never recorded");
  assert.deepEqual(state.cursors, [], "and it is not consumed either — it stays in the channel");
});

test("settle/review: a round mismatch records nothing, with no fallback to the stamp", async () => {
  const { state, deps } = makeSettleDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "reviewer", roundSeq: 3, lastReportId: undefined },
    // Stamped AFTER the checkpoint — the content half would have let this pass.
    records: [childReport("rep-prev", { round: 2, verdict: "READY", at: NOW })],
  });
  const settled = await settleAuditRound(deps, { judgeId: "j-1", root: ROOT });
  assert.equal(settled.status === "miss" && settled.reason, "round-mismatch");
  assert.equal(state.reviewRounds, 0);
  assert.deepEqual(state.cursors, []);
});

// THE EXIT-GOAL ROUND STAYS CLOSABLE (reviewer P1, 2026-09-05). A session that
// has never checkpointed anything reviews an EMPTY range — `prepare_review`
// supports exactly that — so there is no content the verdict could lag behind.
// Refusing it would leave the round with no record, no end and no reachable
// READY, which is a deadlock rather than a safe refusal.
test("settle/review: with no checkpoint on record the round still closes", async () => {
  const { state, deps } = makeSettleDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "reviewer", roundSeq: 2, lastReportId: undefined },
    records: [childReport("rep-2", { round: 2, verdict: "READY" })],
    checkpointAt: undefined,
  });
  const settled = await settleAuditRound(deps, { judgeId: "j-1", root: ROOT });
  assert.equal(settled.status, "recorded");
  assert.equal(state.reviewRounds, 1);
  // AND IT SAYS SO, in the text the agent reads (project manager, 2026-09-05).
  // A degradation only the code knows about is the one that becomes the norm:
  // three rounds later nobody remembers the content criterion was skipped.
  const recorded = settled.status === "recorded" ? settled.text : "";
  assert.match(recorded, /本轮绑定说明/, "the recorded verdict announces the weaker binding");
  assert.match(recorded, /exit-goal/, "…names the kind of round it was");
  assert.match(recorded, /不适用/, "…says the content-time criterion did not apply");
  assert.match(recorded, /round 与 cursor/, "…and what carried the round instead");
  // The normal round must NOT carry that sentence — an announcement that shows
  // up everywhere says nothing.
  const normal = makeSettleDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "reviewer", roundSeq: 2, lastReportId: undefined },
    records: [childReport("rep-2", { round: 2, verdict: "READY" })],
  });
  const withCheckpoint = await settleAuditRound(normal.deps, { judgeId: "j-1", root: ROOT });
  assert.doesNotMatch(
    withCheckpoint.status === "recorded" ? withCheckpoint.text : "",
    /本轮绑定说明/,
    "a round that HAD a checkpoint says nothing about a degradation that did not happen",
  );
  // The round half is NOT relaxed with it: a leftover report from an earlier
  // round is still refused in a repo with no checkpoint.
  const stale = makeSettleDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "reviewer", roundSeq: 3, lastReportId: undefined },
    records: [childReport("rep-prev", { round: 2, verdict: "READY" })],
    checkpointAt: undefined,
  });
  const refused = await settleAuditRound(stale.deps, { judgeId: "j-1", root: ROOT });
  assert.equal(refused.status === "miss" && refused.reason, "round-mismatch");
  assert.equal(stale.state.reviewRounds, 0);
});

// SCOPED TO THE REVIEW KIND. A goal or plan audit is dispatched before this
// session has ever checkpointed anything; if the content rule reached it, the
// first audit of every session would wait forever.
test("settle/goal: an audit is unaffected by the absence of a checkpoint", async () => {
  const { state, deps } = makeSettleDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 2, lastReportId: "rep-1" },
    pending: { kind: "goal", draft: "# 目标草稿", startedAt: NOW },
    records: [childReport("rep-2", { round: 2, verdict: "READY" })],
    checkpointAt: undefined,
  });
  const settled = await settleAuditRound(deps, { judgeId: "j-1", root: ROOT });
  assert.equal(settled.status === "recorded" && settled.kind, "goal");
  assert.deepEqual(state.goalDrafts, ["# 目标草稿"]);
});

test("settle/advice: an adviser round is unaffected by the absence of a checkpoint", async () => {
  const { state, deps } = makeSettleDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "adviser", roundSeq: 2, lastReportId: "rep-1" },
    records: [childReport("rep-2", { round: 2, verdict: "" })],
    checkpointAt: undefined,
  });
  const settled = await settleAuditRound(deps, { judgeId: "j-1", root: ROOT });
  assert.equal(settled.status, "advice");
  assert.deepEqual(state.cursors, ["rep-2"]);
});

test("settle/goal: the verdict is recorded against the draft the gate dispatched", async () => {
  const { state, deps } = makeSettleDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 2, lastReportId: "rep-1" },
    pending: { kind: "goal", draft: "# 目标草稿", startedAt: NOW },
    records: [childReport("rep-2", { round: 2, verdict: "READY" })],
  });
  const settled = await settleAuditRound(deps, { judgeId: "j-1", root: ROOT });
  assert.equal(settled.status === "recorded" && settled.kind, "goal");
  assert.deepEqual(state.goalDrafts, ["# 目标草稿"]);
  assert.deepEqual(state.cursors, ["rep-2"]);
  assert.deepEqual(state.forgotten, [ROOT], "the pending audit is dropped once it IS recorded");
});

test("settle/plan: the record binds to the dispatched hash and adjudicates P0/P1", async () => {
  const { state, deps } = makeSettleDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 2, lastReportId: "rep-1" },
    pending: { kind: "plan", hash: "a".repeat(64), planText: "计划正文", startedAt: NOW },
    records: [childReport("rep-2", { round: 2, verdict: "READY" })],
  });
  const settled = await settleAuditRound(deps, { judgeId: "j-1", root: ROOT });
  assert.equal(settled.status === "recorded" && settled.kind, "plan");
  assert.equal(state.planRecords.length, 1);
  const record = state.planRecords[0]!;
  assert.equal(record.hash, "a".repeat(64));
  // A READY carrying a P1 is contradictory — only P0/P1 block, and one is here.
  assert.equal(record.verdict, "FAIL");
  assert.equal(record.planText, "计划正文");
  assert.match(settled.status === "recorded" ? settled.text : "", /审计\*\*没过\*\*/);
  // B2 (2026-09-06): the verdict also leaves the sidecar. The sidecar is
  // reset by the next session that opens this repo, so a record that lives
  // only there cannot answer "was this plan audited, and what was said".
  const logged = state.auditLog.find((line) => line.includes("plan audit"));
  assert.ok(logged, `the verdict must reach the audit log: ${state.auditLog.join(" | ")}`);
  assert.match(logged!, /FAIL/, "the logged verdict is the adjudicated one");
  assert.match(logged!, new RegExp("a".repeat(64)), "bound to the hash that was judged");
});

test("settle/plan: a PASS says so, and it is the text the caller relays", async () => {
  const { deps } = makeSettleDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 2, lastReportId: "rep-1" },
    pending: { kind: "plan", hash: "b".repeat(64), planText: "计划正文", startedAt: NOW },
    records: [childReport("rep-2", { round: 2, verdict: "READY" })],
  });
  // No blocking findings this time.
  deps.conclusionOf = () => ({ verdict: "READY", findings: [] });
  const settled = await settleAuditRound(deps, { judgeId: "j-1", root: ROOT });
  assert.match(settled.status === "recorded" ? settled.text : "", /plan 审计 PASS/);
});

test("settle/advice: prose is surfaced, never recorded, cursor still consumed", async () => {
  const { state, deps } = makeSettleDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "adviser", roundSeq: 2, lastReportId: "rep-1" },
    records: [childReport("rep-2", { round: 2, verdict: "" })],
  });
  const settled = await settleAuditRound(deps, { judgeId: "j-1", root: ROOT });
  assert.equal(settled.status, "advice");
  assert.match(settled.status === "advice" ? settled.text : "", /先切分模块/);
  assert.deepEqual(state.cursors, ["rep-2"]);
  assert.equal(state.reviewRounds, 0);
  assert.deepEqual(state.planRecords, []);
});

// ---------- fail-closed: no report for THIS round records nothing ----------

test("settle: a report from another round records NOTHING and says why", async () => {
  const { state, deps } = makeSettleDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 3, lastReportId: undefined },
    pending: { kind: "goal", draft: "# 目标草稿", startedAt: NOW },
    records: [childReport("rep-old", { round: 1, verdict: "READY" })],
  });
  const settled = await settleAuditRound(deps, { judgeId: "j-1", root: ROOT });
  assert.equal(settled.status, "miss");
  assert.match(settled.status === "miss" ? settled.text ?? "" : "", /没有等到本轮裁决/);
  assert.deepEqual(state.goalDrafts, [], "nothing recorded");
  assert.deepEqual(state.cursors, [], "the cursor does not move on a miss");
  assert.deepEqual(state.forgotten, [], "the pending audit stays armed for the re-run");
});

test("settle: a recorder that cannot write leaves the round armed, cursor untouched", async () => {
  const { state, deps } = makeSettleDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 2, lastReportId: "rep-1" },
    pending: { kind: "goal", draft: "# 目标草稿", startedAt: NOW },
    records: [childReport("rep-2", { round: 2, verdict: "READY" })],
    recordResult: undefined,
  });
  const settled = await settleAuditRound(deps, { judgeId: "j-1", root: ROOT });
  assert.equal(settled.status, "unrecorded");
  assert.equal(settled.status === "unrecorded" && settled.hasVerdict, true);
  assert.deepEqual(state.cursors, [], "losing a verdict is worse than reporting it twice");
  assert.deepEqual(state.forgotten, []);
});

test("settle: an unknown judge, and a goal-auditor with nothing pending, record nothing", async () => {
  const { state, deps } = makeSettleDeps({ records: [childReport("rep-2", { round: 2 })] });
  assert.deepEqual(await settleAuditRound(deps, { judgeId: "nobody", root: ROOT }), { status: "unknown" });
  state.entry = { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 2 };
  state.pending = undefined;
  assert.deepEqual(await settleAuditRound(deps, { judgeId: "j-1", root: ROOT }), { status: "unknown" });
  assert.deepEqual(state.cursors, []);
});

// ---------- the synchronous round, end to end ----------

interface RunState extends FakeState {
  dispatched: Array<{ role: string; title: string; task: string; streamPath?: string }>;
  remembered: PendingAudit[];
  closed: string[];
  waitOk: boolean;
  passed: boolean;
  dispatchOk: boolean;
  /**
   * What the reclaim reports back (t9d). `undefined` is the clean case: the
   * pane was closed and confirmed gone, which the policy expects to be silent.
   * Set it to make the reclaim half-done, or throw.
   */
  closeOutcome?: JudgePaneReclaimOutcome | undefined;
  closeThrows?: boolean;
  /** What the kind can rebuild from its RECORD when the wait did the recording. */
  recordedRefusal: string | undefined;
  /** Did the registry hand back an addressable judge id? */
  addressable: boolean;
}

function makeRunDeps(over: Partial<RunState> = {}): { state: RunState; deps: RunAuditRoundDeps } {
  const base = makeSettleDeps(over);
  const state: RunState = {
    ...base.state,
    dispatched: [],
    remembered: [],
    closed: [],
    waitOk: true,
    passed: true,
    dispatchOk: true,
    recordedRefusal: undefined,
    addressable: true,
    ...over,
  };
  const deps: RunAuditRoundDeps = {
    ...base.deps,
    // The engine's own state getters must read THIS object, not the settle
    // fake's copy — the spread above cloned it.
    judgeEntry: (judgeId) => (state.entry?.judgeId === judgeId ? state.entry : undefined),
    readRoundRecords: () => state.records,
    pendingAudit: () => state.pending,
    forgetPending: (root) => { state.forgotten.push(root); state.pending = undefined; },
    advanceCursor: (_judgeId, reportId) => { state.cursors.push(reportId); },
    savePlanAudit: (_root, record) => { state.planRecords.push(record); },
    recordGoal: async ({ pending }) => { state.goalDrafts.push(pending.draft); return state.recordResult; },
    dispatch: (input) => {
      if (!state.dispatchOk) return { ok: false, error: "review pane 未能开出来" };
      state.dispatched.push({
        role: input.role,
        title: input.title,
        task: input.task,
        ...(input.streamPath === undefined ? {} : { streamPath: input.streamPath }),
      });
      return { ok: true, judgeId: "j-1" };
    },
    judgeIdOf: () => (state.addressable ? "j-1" : undefined),
    rememberPending: (_root, pending) => {
      state.remembered.push(pending);
      state.pending = pending;
    },
    awaitRoundEnd: async () =>
      state.waitOk ? { ok: true, detail: "" } : { ok: false, detail: "pane 已消失" },
    closeJudge: async (_root, role) => {
      state.closed.push(role);
      if (state.closeThrows) throw new Error("tmux 不见了");
      return state.closeOutcome ?? { ok: true, hadPane: true, terminated: true };
    },
    auditPassed: () => state.passed,
    recordedRefusal: () => state.recordedRefusal,
    verdictLabel: () => "FAIL",
  };
  return { state, deps };
}

test("run/goal: dispatch → remember → wait → record → pass, and the pane is reclaimed", async () => {
  const { state, deps } = makeRunDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 2, lastReportId: "rep-1" },
    records: [childReport("rep-2", { round: 2, verdict: "READY" })],
  });
  const outcome = await runAuditRound(deps, {
    spec: GOAL_AUDIT_SPEC,
    root: ROOT,
    task: "审计这份草稿",
    streamPath: "/tmp/goal.jsonl",
    pending: { kind: "goal", draft: "# 目标草稿", startedAt: NOW },
  });
  assert.deepEqual(outcome, { ok: true });
  assert.equal(state.dispatched.length, 1);
  assert.equal(state.dispatched[0]!.role, "goal-auditor");
  assert.match(state.dispatched[0]!.title, /^goal-auditor-\d{6}$/);
  assert.equal(state.dispatched[0]!.streamPath, "/tmp/goal.jsonl");
  assert.deepEqual(state.goalDrafts, ["# 目标草稿"]);
  assert.deepEqual(state.closed, ["goal-auditor"], "O-6: whoever dispatched it closes it");
});

test("run/plan: a FAIL comes back as the refusal text, not as a passed audit", async () => {
  const { state, deps } = makeRunDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 2, lastReportId: "rep-1" },
    records: [childReport("rep-2", { round: 2, verdict: "READY" })],
    passed: false,
  });
  const outcome = await runAuditRound(deps, {
    spec: PLAN_AUDIT_SPEC,
    root: ROOT,
    task: "审计这份 plan",
    pending: { kind: "plan", hash: "c".repeat(64), planText: "计划正文", startedAt: NOW },
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok === false ? outcome.text : "", /审计\*\*没过\*\*/);
  assert.match(state.dispatched[0]!.title, /^plan-auditor-/, "the display label still tells the two apart");
  assert.deepEqual(state.closed, ["goal-auditor"]);
});

// A REFUSAL MUST SAY WHAT TO FIX (reviewer P1). Under observer-records the
// note lives wherever the record was made — usually inside the wait — so a
// chain that only had its own note would hand the orchestrator a bare
// "审计记录：FAIL" and drop every finding the auditor wrote. The plan rebuilds
// its refusal from the RECORD instead.
test("run/plan: a refusal recorded BY THE WAIT still carries its findings", async () => {
  const { state, deps } = makeRunDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 2, lastReportId: "rep-1" },
    records: [childReport("rep-2", { round: 2, verdict: "READY" })],
    passed: false,
    recordedRefusal: "review-gate: plan 审计**没过** —— P1: 边界没覆盖真实落点",
  });
  deps.awaitRoundEnd = async () => {
    await settleAuditRound(deps, { judgeId: "j-1", root: ROOT });
    state.entry = { ...state.entry!, lastReportId: "rep-2" };
    return { ok: true, detail: "" };
  };
  const outcome = await runAuditRound(deps, {
    spec: PLAN_AUDIT_SPEC,
    root: ROOT,
    task: "审计这份 plan",
    pending: { kind: "plan", hash: "d".repeat(64), planText: "计划正文", startedAt: NOW },
  });
  assert.equal(outcome.ok, false);
  const text = outcome.ok === false ? outcome.text : "";
  assert.match(text, /边界没覆盖真实落点/, "the findings survive a round the wait recorded");
  assert.doesNotMatch(text, /^审计记录：FAIL$/, "the bare label is the LAST resort, not the first");
});

// The pane is open from the accepted dispatch onward, so every exit past it
// must reclaim it — including the one that says the registry cannot address
// what was just opened (reviewer P2).
test("run: an unaddressable judge still gets its pane reclaimed", async () => {
  const { state, deps } = makeRunDeps({ addressable: false });
  const outcome = await runAuditRound(deps, {
    spec: GOAL_AUDIT_SPEC,
    root: ROOT,
    task: "审计这份草稿",
    pending: { kind: "goal", draft: "# 目标草稿", startedAt: NOW },
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok === false ? outcome.text : "", /登记表里找不到它/);
  assert.deepEqual(state.closed, ["goal-auditor"], "a dispatched pane is never leaked");
});


// THE SHARPEST EDGE (adviser, 2026-09-05). `awaitRoundEnd` waits through
// `judge_wait`, and that tool closes the round through this same engine — so
// the synchronous chain routinely finds THIS round already recorded and its
// cursor consumed. Treating that as a stale verdict would fail-close every
// goal and plan audit, every time, while looking perfectly correct in review.
test("run: a round the WAIT already recorded still passes (observer-records)", async () => {
  const { state, deps } = makeRunDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 2, lastReportId: "rep-1" },
    records: [childReport("rep-2", { round: 2, verdict: "READY" })],
  });
  // The wait consumes the report and records it, exactly as judge_wait does.
  deps.awaitRoundEnd = async () => {
    await settleAuditRound(deps, { judgeId: "j-1", root: ROOT });
    state.entry = { ...state.entry!, lastReportId: "rep-2" };
    return { ok: true, detail: "" };
  };
  const outcome = await runAuditRound(deps, {
    spec: GOAL_AUDIT_SPEC,
    root: ROOT,
    task: "审计这份草稿",
    pending: { kind: "goal", draft: "# 目标草稿", startedAt: NOW },
  });
  assert.deepEqual(outcome, { ok: true }, "an already-settled round is the normal path, not a stale one");
  assert.deepEqual(state.goalDrafts, ["# 目标草稿"], "recorded exactly once, by the wait");
  assert.deepEqual(state.cursors, ["rep-2"], "…and consumed exactly once");
  assert.deepEqual(state.closed, ["goal-auditor"]);
  // AND IT IS NOT DETECTED BY ASKING settleAuditRound AGAIN. A successful
  // record CONSUMES the pending entry, and the pending entry is what picks the
  // kind — so a second settle comes back `unknown`, indistinguishable from
  // "nothing was ever dispatched" (reviewer P0). The evidence used instead is
  // the pair of writes a record makes: pending gone AND cursor moved.
  assert.equal(state.pending, undefined, "the record consumed the pending audit");
  assert.deepEqual(
    await settleAuditRound(deps, { judgeId: "j-1", root: ROOT }),
    { status: "unknown" },
    "…which is exactly why a second settle cannot be the detector",
  );
});

// THE OTHER HALF OF THAT EVIDENCE. A pending entry that vanished WITHOUT the
// cursor moving is not a recorded round — nothing may ride on it.
test("run: a consumed pending with an unmoved cursor is NOT treated as recorded", async () => {
  const { state, deps } = makeRunDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 2, lastReportId: "rep-1" },
    records: [childReport("rep-2", { round: 2, verdict: "READY" })],
  });
  // The pending entry disappears (a stray judge_close, a crash) but no report
  // was ever recorded: the cursor still names the previous round.
  deps.awaitRoundEnd = async () => {
    state.pending = undefined;
    return { ok: true, detail: "" };
  };
  const outcome = await runAuditRound(deps, {
    spec: GOAL_AUDIT_SPEC,
    root: ROOT,
    task: "审计这份草稿",
    pending: { kind: "goal", draft: "# 目标草稿", startedAt: NOW },
  });
  assert.equal(outcome.ok, false, "no record landed, so the audit did not happen");
  assert.deepEqual(state.goalDrafts, []);
  assert.deepEqual(state.cursors, []);
  assert.deepEqual(state.closed, ["goal-auditor"]);
});

// …AND THE MIRROR IMAGE. A cursor that moved while the pending entry is still
// armed is not a recorded round either — a record consumes BOTH, so seeing one
// without the other means no record landed. Without this the "pending must be
// gone" half of the detector would only be pinned by a source-text regex.
test("run: an advanced cursor with an ARMED pending is NOT treated as recorded", async () => {
  const { state, deps } = makeRunDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 2, lastReportId: "rep-1" },
    records: [childReport("rep-2", { round: 2, verdict: "READY" })],
  });
  // The cursor advances (the report was surfaced) but nothing was recorded, so
  // the pending audit is still armed.
  deps.awaitRoundEnd = async () => {
    state.entry = { ...state.entry!, lastReportId: "rep-2" };
    return { ok: true, detail: "" };
  };
  const outcome = await runAuditRound(deps, {
    spec: GOAL_AUDIT_SPEC,
    root: ROOT,
    task: "审计这份草稿",
    pending: { kind: "goal", draft: "# 目标草稿", startedAt: NOW },
  });
  assert.equal(outcome.ok, false, "an armed pending means the verdict was never recorded");
  assert.match(outcome.ok === false ? outcome.text : "", /什么都没有记录/);
  assert.deepEqual(state.goalDrafts, [], "and settling again cannot record it either — the report is consumed");
  assert.deepEqual(state.closed, ["goal-auditor"]);
});



// …but a genuinely stale round still records nothing. The two look alike from
// the outside and the engine must keep telling them apart.
test("run: a round whose newest report belongs to ANOTHER round still fails closed", async () => {
  const { state, deps } = makeRunDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 3, lastReportId: undefined },
    records: [childReport("rep-old", { round: 1, verdict: "READY" })],
  });
  const outcome = await runAuditRound(deps, {
    spec: GOAL_AUDIT_SPEC,
    root: ROOT,
    task: "审计这份草稿",
    pending: { kind: "goal", draft: "# 目标草稿", startedAt: NOW },
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok === false ? outcome.text : "", /第 1 轮/);
  assert.deepEqual(state.goalDrafts, []);
  assert.deepEqual(state.cursors, []);
});


test("run: a wait that never saw this round's report records NOTHING and still closes", async () => {
  const { state, deps } = makeRunDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 2, lastReportId: "rep-1" },
    records: [childReport("rep-2", { round: 2, verdict: "READY" })],
    waitOk: false,
  });
  const outcome = await runAuditRound(deps, {
    spec: GOAL_AUDIT_SPEC,
    root: ROOT,
    task: "审计这份草稿",
    pending: { kind: "goal", draft: "# 目标草稿", startedAt: NOW },
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok === false ? outcome.text : "", /pane 已消失/);
  assert.deepEqual(state.goalDrafts, [], "fail-closed: nothing recorded");
  assert.deepEqual(state.cursors, []);
  assert.deepEqual(state.closed, ["goal-auditor"], "the finally-close runs on the failure path too");
});

test("run: a refused dispatch never puts a draft on record", async () => {
  const { state, deps } = makeRunDeps({ dispatchOk: false });
  const outcome = await runAuditRound(deps, {
    spec: GOAL_AUDIT_SPEC,
    root: ROOT,
    task: "审计这份草稿",
    pending: { kind: "goal", draft: "# 目标草稿", startedAt: NOW },
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok === false ? outcome.text : "", /没能启动/);
  assert.deepEqual(state.remembered, [], "a verdict must never bind to text no auditor read");
  assert.deepEqual(state.closed, [], "nothing was opened, so nothing is closed");
});

/*
 * ───── THE RECLAIM IS THE POLICY'S ONE EXECUTION POINT (t9d, 2026-09-06) ────
 *
 * `lib/judge-pane-policy.ts` says a pane the GATE opened dies with the round
 * that opened it, and it says so in exactly one place that acts: here. These
 * pin both halves — that the reclaim happens, and that a reclaim which did NOT
 * do what the policy promises stops being silent. The reply used to be awaited
 * and discarded, which is where a leftover pane went to die: `judge_close`
 * drops the registry row even when the kill fails, so once that text is gone
 * nothing downstream can find the pane at all.
 */

/** Run one passing goal round with the reclaim outcome under test. */
async function runWithReclaim(over: Partial<RunState>) {
  const { state, deps } = makeRunDeps({
    entry: { judgeId: "j-1", openerId: "o-1", role: "goal-auditor", roundSeq: 2, lastReportId: "rep-1" },
    records: [childReport("rep-2", { round: 2, verdict: "READY" })],
    ...over,
  });
  const outcome = await runAuditRound(deps, {
    spec: GOAL_AUDIT_SPEC,
    root: ROOT,
    task: "审计这份草稿",
    pending: { kind: "goal", draft: "# 目标草稿", startedAt: NOW },
  });
  const reclaimLines = state.auditLog.filter((l) => l.includes("judge pane 回收"));
  return { state, outcome, reclaimLines };
}

test("reclaim: the policy decides it, and a clean reclaim stays out of the log", async () => {
  // The rule is not inlined here — it is asked for. A policy that stopped
  // saying "round-end" would stop this close from happening at all.
  assert.equal(judgePaneReclaim("gate").atRoundEnd, true);
  const { state, outcome, reclaimLines } = await runWithReclaim({});
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(state.closed, ["goal-auditor"]);
  assert.deepEqual(reclaimLines, [], "a reclaim that did what it promised is not news");
});

test("reclaim: a kill that failed is written down — the registry row is already gone", async () => {
  const { outcome, reclaimLines } = await runWithReclaim({
    closeOutcome: { ok: true, hadPane: true, terminated: false, note: "关 pane 失败（no such pane），登记照样清除" },
  });
  assert.deepEqual(outcome, { ok: true }, "the round's own answer is unaffected by its cleanup");
  assert.equal(reclaimLines.length, 1);
  assert.match(reclaimLines[0]!, /回收未确认/);
  assert.match(reclaimLines[0]!, /登记照样清除/, "the closing tool's own words survive to the log");
});

test("reclaim: a pane that was never registered is silent — there is nothing to leak", async () => {
  const { reclaimLines } = await runWithReclaim({
    closeOutcome: { ok: true, hadPane: false, terminated: false, note: "没有登记 pane，无需动手" },
  });
  assert.deepEqual(reclaimLines, []);
});

test("reclaim: a close that failed outright is written down", async () => {
  const { reclaimLines } = await runWithReclaim({
    closeOutcome: { ok: false, hadPane: true, terminated: false, note: "judge_close 被拒" },
  });
  assert.equal(reclaimLines.length, 1);
  assert.match(reclaimLines[0]!, /回收失败/);
});

test("reclaim: a throwing close neither loses the round nor goes unrecorded", async () => {
  // A cleanup that raises must not replace the round's real answer with its
  // own exception — and must not be swallowed into silence either.
  const { state, outcome, reclaimLines } = await runWithReclaim({ closeThrows: true });
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(state.closed, ["goal-auditor"], "the reclaim was attempted");
  assert.equal(reclaimLines.length, 1);
  assert.match(reclaimLines[0]!, /回收失败/);
  assert.match(reclaimLines[0]!, /tmux 不见了/);
});

test("reclaim: a FAILED round reclaims and logs exactly like a passing one", async () => {
  // The reclaim lives in `finally` for this reason; a refusal path that
  // skipped it would leak the auditor precisely when something went wrong.
  const { state, outcome, reclaimLines } = await runWithReclaim({
    passed: false,
    recordedRefusal: "P0：草稿没说新代码落在哪",
    closeOutcome: { ok: true, hadPane: true, terminated: false, note: "关 pane 失败" },
  });
  assert.equal(outcome.ok, false);
  assert.deepEqual(state.closed, ["goal-auditor"]);
  assert.equal(reclaimLines.length, 1);
});

