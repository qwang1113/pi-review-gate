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
  ADVICE_ROUND_SPEC,
  GOAL_AUDIT_SPEC,
  PLAN_AUDIT_SPEC,
  REVIEW_ROUND_SPEC,
  describeRoundMiss,
  runAuditRound,
  selectRoundReport,
  settleAuditRound,
  specForRound,
  type AuditRoundEntry,
  type PendingAudit,
  type RunAuditRoundDeps,
  type SettleAuditRoundDeps,
} from "../lib/audit-round.ts";
import type { ChannelRecord, ChannelReportRecord, ReportConclusion } from "../lib/orchestrator-channel.ts";
import type { PlanAuditRecord } from "../lib/orchestrator-plan-audit.ts";

const NOW = "2026-09-05T12:00:00.000Z";
const ROOT = "/work/pi-review-gate";

function childReport(reportId: string, opts: { round?: number; verdict?: string } = {}): ChannelRecord {
  return {
    kind: "report",
    from: "child",
    at: NOW,
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
  const records = [childReport("rep-round-1", { round: 1 })];
  assert.deepEqual(
    selectRoundReport(records, { binding: "round-bound", expectedRound: 2, consumedReportId: "rep-round-1" }),
    { ok: false, reason: "already-consumed", reportId: "rep-round-1" },
  );
});

test("selectRoundReport: an unconsumed report from another round is still a miss", () => {
  const records = [childReport("rep-round-1", { round: 1 })];
  assert.deepEqual(
    selectRoundReport(records, { binding: "round-bound", expectedRound: 2, consumedReportId: undefined }),
    { ok: false, reason: "round-mismatch", reportId: "rep-round-1", round: 1 },
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

// The review path has ALWAYS bound on the cursor alone. Making it round-bound
// would be a semantics change smuggled in by a refactor, so the binding is
// per kind and this pins the difference.
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

test("describeRoundMiss names the round it actually saw", () => {
  assert.match(describeRoundMiss({ reason: "round-mismatch", round: 3 }), /第 3 轮/);
  assert.match(describeRoundMiss({ reason: "no-report" }), /还没有本轮 report/);
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
  goalDrafts: string[];
  reviewRounds: number;
  /** undefined = "could not record right now" (no usable tool context). */
  recordResult: string | undefined;
}

function makeSettleDeps(over: Partial<FakeState> = {}): { state: FakeState; deps: SettleAuditRoundDeps } {
  const state: FakeState = {
    records: [],
    entry: { judgeId: "j-1", openerId: "o-1", role: "reviewer", roundSeq: 2, lastReportId: "rep-round-1" },
    pending: undefined,
    cursors: [],
    forgotten: [],
    planRecords: [],
    goalDrafts: [],
    reviewRounds: 0,
    recordResult: "recorded",
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
    savePlanAudit: (_root, record) => { state.planRecords.push(record); },
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
    closeJudge: async (_root, role) => { state.closed.push(role); },
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
