/**
 * THE AUDIT ROUND ENGINE — one implementation of "dispatch a judge, wait for
 * THIS round, pick its report, adjudicate it, record it, reclaim the pane".
 *
 * ── WHY THIS MODULE EXISTS (2026-09-05) ──
 *
 * That single round was written THREE times inside
 * `extensions/review-gate.ts`: once for the goal audit (`runGoalAudit`), once
 * for the plan audit (`auditPlanRound`), once for the code review's recording
 * half (`recordRoundOutput`). The three copies did not drift apart in some
 * harmless cosmetic way — the last three P0 fixes in this repository
 * (`8ea7eec`, `a150055`, and the round-binding fix before them) all landed on
 * the SAME defect in that chain, and each had to be applied to whichever copy
 * the bug was noticed in. A defect class that must be fixed three times is a
 * defect class that will be half-fixed.
 *
 * So: the ENGINE is shared, the WORDING is not (task book, philosophy two).
 * What differs per kind is a small `AuditRoundSpec` — the role it dispatches,
 * how its report is bound to a round, and the sentences the caller reads when
 * the round fails closed. What is shared is everything mechanical: which
 * report belongs to this round, the fail-closed rule, the pending bookkeeping,
 * and the ONE `judge_close` that reclaims a pane the gate opened itself (O-6).
 *
 * ── THE TWO HALVES, AND WHY THEY ARE TWO ──
 *
 * `runAuditRound` is the SYNCHRONOUS round: goal and plan audits block inside
 * `propose_loop_goal` / `orchestrator_plan({action:"submit"})` for minutes,
 * because the alternative is the multi-step dance an agent has to sequence by
 * hand. `settleAuditRound` is its CONCLUSION half — select, adjudicate,
 * record — and it is separate because a code review does NOT block: it is
 * dispatched by `judge_submit` and concluded later, when the settle path sees
 * its report land. Forcing a code review through the synchronous shape would
 * change a real behaviour, so it is not forced (user decision, 2026-09-05):
 * review enters the engine at the conclusion half only.
 *
 * ── WHAT THIS MODULE DOES NOT OWN ──
 *
 * The record WRITERS stay where they are: `recordGoalPrereview`
 * (lib/goal-prereview-tools.ts) and the extension's `recordReviewVerdict`.
 * They carry bindings this refactor must not touch — a review READY binds to
 * the reviewed commit's TREE and refuses a moved HEAD — so the engine calls
 * them through the spec's `record`, and their bodies are untouched. Only the
 * PLAN record is built here, because it existed twice and had nowhere else to
 * live.
 *
 * Everything the engine cannot own (channel reads, the opener registry,
 * dispatch, waiting, closing) arrives through injected deps, so all three
 * kinds are exercisable end-to-end with a fake channel and a fake hierarchy.
 */

import type { ChannelRecord, ChannelReportRecord, ReportConclusion } from "./orchestrator-channel.ts";
import {
  adjudicatePlanAudit,
  formatPlanAuditRefusal,
  type PlanAuditRecord,
} from "./orchestrator-plan-audit.ts";
import { normalizeConcludedVerdict, severityFindingsFrom } from "./review-adjudicate.ts";
// The WORDING half of the round, and the two facts that select it. It lives in
// its own module because merging the mechanics was the point of this one and
// merging the sentences would have been a mistake.
import {
  specForRound,
  type AuditKind,
  type AuditRoundSpec,
  type PendingAudit,
  type ReportBinding,
} from "./audit-round-specs.ts";

/** Why the channel held no report this round may be adjudicated against. */
export type RoundReportMiss = "no-report" | "already-consumed" | "round-mismatch";

/** The outcome of asking "which report closes THIS round?". */
export type RoundReportSelection =
  | { ok: true; report: ChannelReportRecord }
  | { ok: false; reason: RoundReportMiss; reportId?: string; round?: number };

/**
 * WHICH REPORT CLOSES THIS ROUND — the ONE selector.
 *
 * It used to have two entry points in the extension (`staleAuditGuard` and an
 * inline call inside `auditPlanRound`), which is how the goal path and the
 * plan path ended up fail-closing on subtly different conditions. There is one
 * now, and every kind reaches it through `settleAuditRound`.
 *
 * The round source of truth is `judge-conclude.ts` (`roundSeq`, stamped on
 * every report); no second round tracker lives here. A report that pre-dates
 * round numbering counts as round 0, so it can never match a real round.
 * `expectedRound === undefined` (an entry from before round numbering) falls
 * back to the cursor check alone.
 */
export function selectRoundReport(
  records: ReadonlyArray<ChannelRecord>,
  opts: {
    binding: ReportBinding;
    expectedRound: number | undefined;
    consumedReportId: string | undefined;
  },
): RoundReportSelection {
  let last: ChannelReportRecord | undefined;
  for (const r of records) {
    if (r.kind === "report" && r.from === "child") last = r;
  }
  if (!last) return { ok: false, reason: "no-report" };
  // ROUND FIRST, CURSOR SECOND — the order is load-bearing (2026-09-05).
  //
  // For a round-bound kind the ROUND is what makes a report this round's; the
  // cursor is a second safety net, not the safety itself. Checking the cursor
  // first would let `already-consumed` MASK a round mismatch: a report from an
  // older round that happens to be the consumed one comes back as "you already
  // recorded this" rather than "this is not your round". Nothing in the engine
  // treats `already-consumed` as a pass today — but the moment someone does,
  // that masking would resurrect the P0 `8ea7eec` fixed (an older round's
  // verdict recorded against a new draft). Ordering it this way makes the
  // roundSeq binding structural instead of something the next caller has to
  // remember.
  if (opts.binding === "round-bound" && opts.expectedRound !== undefined) {
    const round =
      typeof last.round === "number" && Number.isFinite(last.round) ? Math.floor(last.round) : 0;
    if (round !== Math.floor(opts.expectedRound)) {
      return { ok: false, reason: "round-mismatch", reportId: last.reportId, round };
    }
  }
  if (last.reportId === opts.consumedReportId) {
    return { ok: false, reason: "already-consumed", reportId: last.reportId };
  }
  return { ok: true, report: last };
}

/** The human-readable half of a miss, in the gate's own voice. */
export function describeRoundMiss(selection: {
  reason: RoundReportMiss;
  round?: number;
}): string {
  switch (selection.reason) {
    case "round-mismatch":
      return `channel 最新 report 属于第 ${selection.round ?? "?"} 轮，不是本轮`;
    case "already-consumed":
      return "channel 最新 report 已是消费过的旧裁决";
    default:
      return "channel 还没有本轮 report";
  }
}

/*
 * The four kinds and their WORDING live in `./audit-round-specs.ts`. Merging
 * the mechanics is what this module is for; merging the sentences would have
 * been a different, worse refactor — so they were split apart deliberately,
 * and `specForRound` (imported above) is how a round finds its own.
 */

/* ─────────────────────────── the conclusion half ─────────────────────────── */

/** What the engine needs to know about the judge whose round is closing. */
export interface AuditRoundEntry {
  judgeId: string;
  openerId: string;
  role: string;
  /** The round number THIS dispatch registered (`roundSeq`). */
  roundSeq?: number;
  /** The wait cursor: the last report already consumed. */
  lastReportId?: string;
}

/**
 * Everything the conclusion half cannot own. Each member is a thing a test
 * replaces with three lines — which is what makes all four kinds runnable
 * end-to-end against a fake channel and a fake registry.
 */
export interface SettleAuditRoundDeps {
  /** The opener registry entry for this judge, or undefined when it is gone. */
  judgeEntry(judgeId: string): AuditRoundEntry | undefined;
  /** This judge's channel, newest last. */
  readRoundRecords(entry: AuditRoundEntry): readonly ChannelRecord[];
  /** The structured conclusion carried BY the report (nothing is parsed). */
  conclusionOf(report: ChannelReportRecord): ReportConclusion;
  /** An adviser report's prose — the one role whose report carries text. */
  proseOf(report: ChannelReportRecord): string | undefined;
  /** Consume the report: the next round must not close on it again. */
  advanceCursor(judgeId: string, reportId: string): void;
  /** The audit this repo dispatched and has not recorded yet. */
  pendingAudit(root: string): PendingAudit | undefined;
  /** Forget it — called only once its verdict IS recorded. */
  forgetPending(root: string): void;
  /** Injectable clock (ISO). */
  nowIso(): string;
  /** Persist one repo's plan-audit record (the extension owns gate state). */
  savePlanAudit(root: string, record: PlanAuditRecord): void;
  /**
   * The goal and review record WRITERS — untouched bodies, called from here.
   *
   * `undefined` means "could not record right now" (no usable tool context),
   * and the engine treats it as fail-closed: the pending entry stays armed and
   * the cursor does NOT advance, so the next settle records the same report
   * instead of losing the verdict.
   */
  recordGoal(input: {
    root: string;
    pending: Extract<PendingAudit, { kind: "goal" }>;
    concluded: ReportConclusion;
  }): Promise<string | undefined>;
  recordReview(input: { root: string; concluded: ReportConclusion }): Promise<string | undefined>;
}

/** What one closing round did. `text`, where present, is for the agent. */
export type SettleAuditRoundOutcome =
  | { status: "recorded"; kind: AuditKind; reportId: string; hasVerdict: boolean; verdict: string; text: string }
  | { status: "advice"; reportId: string; text: string }
  | { status: "miss"; reason: RoundReportMiss; text?: string }
  | { status: "unrecorded"; reportId: string; hasVerdict: boolean; verdict: string }
  /** Nothing addressable: no registry entry, an unknown role, or no pending audit. */
  | { status: "unknown" };

/** The plan record — built HERE because it used to be built in two places. */
function recordPlanRound(
  deps: SettleAuditRoundDeps,
  root: string,
  pending: Extract<PendingAudit, { kind: "plan" }>,
  concluded: ReportConclusion,
): string {
  const verdict = normalizeConcludedVerdict(concluded.verdict);
  if (!verdict) {
    return "review-gate: plan 审计没有产出可识别的裁决，什么都没有记录（fail-closed）——" +
      "plan **没有**被送到用户面前。\n直接再 `submit` 一次即可重跑审计。";
  }
  const findings = severityFindingsFrom(concluded.findings);
  const adjudication = adjudicatePlanAudit(verdict, findings);
  const record: PlanAuditRecord = {
    hash: pending.hash,
    verdict: adjudication.verdict,
    at: deps.nowIso(),
    findingsTotal: concluded.findings.length,
    ...(findings.length ? { findings } : {}),
    planText: pending.planText,
  };
  deps.savePlanAudit(root, record);
  if (adjudication.verdict === "PASS") {
    return `plan 审计 PASS（hash ${pending.hash.slice(0, 12)}）——可以送用户批准了。`;
  }
  return formatPlanAuditRefusal(record);
}

/**
 * CLOSE ONE ROUND: pick this round's report, adjudicate it, record it.
 *
 * Every path that concludes a judge round goes through here — the synchronous
 * audits above, `judge_wait` when it observes a report, and the settle sweep
 * that wakes the agent. That is what makes "one report is recorded once" a
 * structural fact rather than a convention: the cursor is advanced in ONE
 * place, and only after a record actually landed.
 */
export async function settleAuditRound(
  deps: SettleAuditRoundDeps,
  input: { judgeId: string; root: string },
): Promise<SettleAuditRoundOutcome> {
  const entry = deps.judgeEntry(input.judgeId);
  if (!entry) return { status: "unknown" };
  const pending = deps.pendingAudit(input.root);
  const spec = specForRound(entry.role, pending?.kind);
  if (!spec) return { status: "unknown" };
  const selected = selectRoundReport(deps.readRoundRecords(entry), {
    binding: spec.binding,
    expectedRound: entry.roundSeq,
    consumedReportId: entry.lastReportId,
  });
  if (!selected.ok) {
    // A cursor-bound kind whose newest report is its OWN consumed one has
    // simply been recorded already: silence, not a fail-closed notice. For a
    // round-bound audit the same observation means the opposite — this
    // round's verdict has not arrived — so it is reported.
    if (selected.reason === "already-consumed" && spec.binding === "cursor-only") {
      return { status: "miss", reason: selected.reason };
    }
    return { status: "miss", reason: selected.reason, text: spec.unfinished(describeRoundMiss(selected)) };
  }
  const report = selected.report;
  if (spec.kind === "advice") {
    const advice = (deps.proseOf(report) ?? "").trim();
    deps.advanceCursor(entry.judgeId, report.reportId);
    return { status: "advice", reportId: report.reportId, text: advice || spec.rejected(undefined, {}) };
  }
  const concluded = deps.conclusionOf(report);
  const hasVerdict = normalizeConcludedVerdict(concluded.verdict) !== undefined;
  let text: string | undefined;
  if (spec.kind === "review") {
    text = await deps.recordReview({ root: input.root, concluded });
  } else if (spec.kind === "goal" && pending?.kind === "goal") {
    text = await deps.recordGoal({ root: input.root, pending, concluded });
  } else if (spec.kind === "plan" && pending?.kind === "plan") {
    text = recordPlanRound(deps, input.root, pending, concluded);
  }
  // Nothing was written: keep the pending entry armed and the cursor where it
  // is. Losing a verdict is worse than reporting the same report twice.
  if (text === undefined) {
    return { status: "unrecorded", reportId: report.reportId, hasVerdict, verdict: concluded.verdict };
  }
  // The audit is on record now, so what it was judging can be forgotten. This
  // is deliberately AFTER the write (the old code dropped it before, which
  // lost the binding if the write failed).
  if (spec.kind !== "review") deps.forgetPending(input.root);
  deps.advanceCursor(entry.judgeId, report.reportId);
  return {
    status: "recorded",
    kind: spec.kind,
    reportId: report.reportId,
    hasVerdict,
    verdict: concluded.verdict,
    text,
  };
}

/* ─────────────────────────── the synchronous round ───────────────────────── */

/** The dispatch half's seams — only the goal and plan audits use them. */
export interface RunAuditRoundDeps extends SettleAuditRoundDeps {
  /**
   * Open (or re-use) the judge pane for this round. `fresh` is the engine's
   * decision, not the caller's: a previous audit still running is judging
   * DIFFERENT content (this one has no PASS yet), so it cannot answer the
   * question being asked now.
   */
  dispatch(input: { root: string; role: string; title: string; task: string; streamPath?: string }):
    { ok: true; judgeId: string } | { ok: false; error?: string };
  /** The judge id this repo's role is addressable by, once dispatched. */
  judgeIdOf(root: string, role: string): string | undefined;
  /** Remember what was dispatched — a verdict binds to it. */
  rememberPending(root: string, pending: PendingAudit): void;
  /** Wait for the END of the round (a report), not for its first message. */
  awaitRoundEnd(root: string): Promise<{ ok: boolean; detail: string }>;
  /**
   * O-6 — whoever dispatched it closes it. The gate opened this auditor as
   * its OWN implementation of `propose_loop_goal` / `submit`; the agent never
   * asked for it and never sees it in a receipt, so leaving it registered
   * blocks `declare_done` on a judge nobody was told about.
   */
  closeJudge(root: string, role: string): Promise<void>;
  /**
   * Did the recorded verdict actually pass — for the CONTENT this round
   * judged? The pending entry is passed in rather than re-read, because the
   * record is content-bound (a goal to its draft, a plan to its hash) and the
   * pending entry is forgotten the moment the record lands.
   */
  auditPassed(root: string, pending: PendingAudit): boolean;
  /**
   * The refusal text rebuilt FROM THE RECORD, for a round the wait settled.
   *
   * The recorded note only exists where the record was made, and under the
   * observer-records shape that is usually inside the wait — so a chain that
   * only had its own note would hand back "审计记录：FAIL" and drop every
   * finding the auditor wrote (reviewer P1, 2026-09-05). The record itself
   * still holds them, so the kind that can rebuild its refusal from the record
   * does; one that cannot returns undefined and the label is the fallback.
   */
  recordedRefusal(root: string, pending: PendingAudit): string | undefined;
  /** The verdict label for the refusal text when nothing better exists. */
  verdictLabel(root: string, pending: PendingAudit): string;
}

/**
 * DID THE WAIT ALREADY CLOSE THIS ROUND?
 *
 * `awaitRoundEnd` waits through `judge_wait`, and that tool closes the round
 * through this same engine — so by the time the synchronous chain gets control
 * back, THIS round is usually already recorded. That is the normal path, not a
 * stale verdict: an audit dispatched asynchronously (judge_submit /
 * judge_spawn) is settled by the wait or the settle sweep alone, so settling
 * must work without this chain, and this chain must tolerate being beaten to it.
 *
 * The evidence is the pair of writes `settleAuditRound` makes, and ONLY makes,
 * once a record has actually landed: it forgets the pending audit and it
 * advances the cursor. Requiring BOTH is what keeps this fail-closed —
 * a pending entry that is still armed, or a cursor that never moved, means no
 * record landed, and the chain then settles the round itself (and fails closed
 * if that does not work either).
 *
 * Asking `settleAuditRound` a second time cannot answer this question: the
 * pending entry it needs to pick a kind is exactly what a successful record
 * consumes, so a settled round comes back as `unknown` — indistinguishable
 * from "nothing was ever dispatched" (reviewer P0, 2026-09-05).
 */
function roundClosedDuringWait(
  deps: SettleAuditRoundDeps,
  input: { judgeId: string; root: string; cursorBefore: string | undefined },
): boolean {
  if (deps.pendingAudit(input.root) !== undefined) return false;
  const cursorNow = deps.judgeEntry(input.judgeId)?.lastReportId;
  return cursorNow !== undefined && cursorNow !== input.cursorBefore;
}


/**
 * ONE SYNCHRONOUS AUDIT ROUND — dispatch, wait, conclude, reclaim.
 *
 * The goal and plan audits are this function, twice, differing only in their
 * spec. It blocks for minutes on purpose: the alternative is handing the agent
 * a half-finished sequence to drive by hand, which is the multi-step dance
 * philosophy one exists to delete.
 *
 * FAIL-CLOSED IS WRITTEN ONCE, HERE. Any outcome that is not "this round's
 * report was recorded and it passed" records nothing and says so — a wait that
 * timed out, a pane that died, a report from another round, a verdict that
 * could not be parsed. And the close runs on EVERY path (the `finally`),
 * because the previous shape — one close call per return branch — is precisely
 * how a branch ends up leaking a pane.
 */
export async function runAuditRound(
  deps: RunAuditRoundDeps,
  input: {
    spec: AuditRoundSpec;
    root: string;
    task: string;
    pending: PendingAudit;
    streamPath?: string;
  },
): Promise<{ ok: true } | { ok: false; text: string }> {
  const { spec, root } = input;
  const dispatched = deps.dispatch({
    root,
    role: spec.role,
    // A display label the ENGINE derives — never the caller's, and never part
    // of the session directory (that is role+repo, so the transcript carries
    // across rounds).
    title: `${spec.titlePrefix}-${deps.nowIso().slice(11, 19).replace(/:/g, "")}`,
    task: input.task,
    ...(input.streamPath === undefined ? {} : { streamPath: input.streamPath }),
  });
  if (!dispatched.ok) {
    return { ok: false, text: spec.notDispatched(dispatched.error ?? "review pane 未能开出来") };
  }
  // The dispatch was ACCEPTED — only now is what it judges on record. A
  // refused submission must never replace the draft a running audit is
  // judging: its verdict would be recorded against text no auditor ever read.
  deps.rememberPending(root, input.pending);
  // EVERYTHING PAST THE ACCEPTED DISPATCH IS INSIDE THE `try`, including the
  // registry lookup: a pane is open from here on, so every exit — even
  // "the registry cannot address what we just opened" — has to run the close.
  // A `return` placed one line above it leaks exactly that pane.
  try {
    const judgeId = deps.judgeIdOf(root, spec.role);
    if (!judgeId) return { ok: false, text: spec.unaddressable() };
    // The cursor BEFORE the wait. It is half the evidence that tells "the wait
    // already closed this round" from "nothing was recorded at all" — see
    // `roundClosedDuringWait`.
    const cursorBefore = deps.judgeEntry(judgeId)?.lastReportId;
    const waited = await deps.awaitRoundEnd(root);
    if (!waited.ok) return { ok: false, text: spec.unfinished(waited.detail) };
    // Only a round recorded HERE carries its note; one the wait recorded left
    // its verdict in the gate's state, which `auditPassed` / `verdictLabel`
    // read. (That was already true before this engine existed: the goal chain
    // recorded inside its wait and always fell back to the label.)
    let note: string | undefined;
    if (!roundClosedDuringWait(deps, { judgeId, root, cursorBefore })) {
      const settled = await settleAuditRound(deps, { judgeId, root });
      if (settled.status !== "recorded") {
        // A miss already carries the kind's own fail-closed sentence, naming
        // the round it actually saw — re-deriving it here would lose that.
        const text = settled.status === "miss" && settled.text
          ? settled.text
          : spec.unfinished("本轮裁决没能记录下来");
        return { ok: false, text };
      }
      note = settled.text;
    }
    if (deps.auditPassed(root, input.pending)) return { ok: true };
    // WHAT THE CALLER IS TOLD TO FIX. Preference order, and the order matters:
    // this round's own note if it recorded here, else the refusal rebuilt from
    // the RECORD (which still holds the findings even when the wait did the
    // recording), else the bare verdict label.
    const refusal = note ?? deps.recordedRefusal(root, input.pending);
    return {
      ok: false,
      text: spec.rejected(refusal || `审计记录：${deps.verdictLabel(root, input.pending)}`, {
        ...(input.streamPath === undefined ? {} : { streamPath: input.streamPath }),
      }),
    };
  } finally {
    await deps.closeJudge(root, spec.role);
  }
}


