/**
 * THE CONCLUSION HALF of the audit-round engine (lib/audit-round.ts) —
 * `settleAuditRound`: pick this round's report, adjudicate it, record it,
 * advance the cursor once, and free the pane.
 *
 * Every path that concludes a judge round goes through here: the synchronous
 * goal / plan audits (`runAuditRound`), `judge_wait` when it observes a
 * report, and the settle sweep that wakes the agent. Its own module because
 * a code review enters the engine at THIS half only — it is dispatched by
 * `judge_submit` and concluded later — so the half has callers the
 * synchronous round never sees. Which report closes a round is
 * lib/audit-round-report.ts.
 */
import type {
  ChannelRecord,
  ChannelReportRecord,
  ReportConclusion,
  ReviewScopeStamp,
} from "./orchestrator-channel.ts";
import {
  adjudicatePlanAudit,
  formatPlanAuditRefusal,
  type PlanAuditRecord,
} from "./orchestrator-plan-audit.ts";
import { normalizeConcludedVerdict, severityFindingsFrom } from "./review-adjudicate.ts";
import { specForRound, type AuditKind, type PendingAudit } from "./audit-round-specs.ts";
import type { JudgePaneReclaimOutcome } from "./judge-pane-policy.ts";
import {
  describeRoundMiss,
  roundBindingFor,
  selectRoundReport,
  type RoundReportMiss,
} from "./audit-round-report.ts";

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
  /**
   * The CONTENT stamp of this repo's current round — `checkpoint.at`.
   *
   * A review verdict may not be older than the content it claims to judge, and
   * the checkpoint is when that content came into existence. Only the review
   * binding reads it (`roundBindingFor`), so a goal or plan audit dispatched
   * before any checkpoint exists is unaffected. `undefined` (no checkpoint on
   * record) means no content STAMP: there is no moment for a verdict to lag
   * behind, so the round binding carries it alone. The round's RANGE is a
   * separate question — `prepare_review` may resolve a branch base for it
   * (2026-09-15). Refusing that round instead would make it unclosable, not safe
   * (reviewer P1 + user decision, 2026-09-05).
   */
  checkpointAt(root: string): string | undefined;
  /**
   * Free the pane of the judge whose round JUST closed (2026-09-21).
   *
   * CALLED ONLY AFTER A VERDICT IS ON RECORD — that ordering is the whole
   * safety argument: the conclusion is already the opener's, so the pane is
   * screen space and nothing else. Freeing it does not cost the conversation
   * either: the next dispatch of the same role re-opens the SAME session id
   * (`judge_submit` falls through to a fresh open when the registered pane is
   * dead, and the transcript continues by session id).
   *
   * Optional so the conclusion half stays drivable without tmux — absent ⇒
   * nothing is reclaimed.
   */
  reclaimJudgePane?(root: string, judgeId: string, role: string): Promise<JudgePaneReclaimOutcome>;
  /** Persist one repo's plan-audit record (the extension owns gate state). */
  savePlanAudit(root: string, record: PlanAuditRecord): void;
  /**
   * Append one line to the repo's audit log (B2, 2026-09-06).
   *
   * The plan audit's verdict is an authority record: it is what stands
   * between a draft plan and the user's approval dialog. It was persisted
   * ONLY into the gate sidecar, which the next session to open the repo
   * resets — so the answer to "was this plan audited, and what did the
   * auditor say" disappeared exactly when it started to matter. Written here,
   * beside the record itself, so the two can never disagree.
   */
  log(message: string): void;
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
  /**
   * Write down the QUALITY round's verdict (2026-09-15). Separate from
   * `recordReview` for the same reason the two rounds are separate: what is
   * recorded differs (a quality standing the reviewer's dispatch is gated on,
   * with no ship binding and no round-history entry) — while WHICH report
   * closes the round stays one implementation, here.
   */
  recordQuality(input: { root: string; concluded: ReportConclusion }): Promise<string | undefined>;
  /**
   * Write down the ACCEPTANCE round's verdict (2026-09-22). The sixth
   * recorder, beside the quality one and for the same reason: what gets
   * written differs (a fingerprint-bound release the COMPLETION gate reads
   * with no ship binding at all), while WHICH report closes the round stays
   * one implementation, here.
   */
  recordAcceptance(input: { root: string; concluded: ReportConclusion }): Promise<string | undefined>;
}

/** What one closing round did. `text`, where present, is for the agent. */
export type SettleAuditRoundOutcome =
  | {
      status: "recorded";
      kind: AuditKind;
      reportId: string;
      hasVerdict: boolean;
      verdict: string;
      text: string;
      /**
       * The round ran under a WEAKER binding, in the round's own words.
       *
       * It is a field of its own and not just a paragraph of `text` because
       * the wake-up the agent actually reads (`buildStandardReport`) prints
       * only the FIRST line of the recorded note — an announcement appended to
       * the end of that note would be true, recorded, and invisible, which is
       * the exact failure the announcement exists to prevent.
       */
      bindingNote?: string;
      /**
       * The scope the JUDGE reported for this round (range + full/incremental),
       * when its report carried one. Travels on the outcome so the wake-up can
       * print what the round says it reviewed — the opener already knows what
       * it dispatched, and seeing both is the whole point of stamping it.
       */
      scope?: ReviewScopeStamp;

    }
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
  // B2 — the same fact, in the log a human greps. Bound to the hash, so a
  // later reader can tell WHICH draft this verdict judged.
  deps.log(
    `orchestrator plan audit ${record.verdict} for ${root} ` +
    `(hash ${record.hash}, findings ${record.findingsTotal ?? "?"})`,
  );
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
  // The binding is built by the SHARED derivation, so the recorder and the
  // probe behind `judge_wait` answer "is this report this round's?" the same
  // way — a wait that announces a verdict the recorder then refuses is the
  // failure mode this whole change exists to remove.
  const checkpointAt = deps.checkpointAt(input.root);
  const binding = roundBindingFor({
    role: entry.role,
    ...(pending?.kind === undefined ? {} : { pendingKind: pending.kind }),
    ...(entry.roundSeq === undefined ? {} : { roundSeq: entry.roundSeq }),
    ...(checkpointAt === undefined ? {} : { checkpointAt }),
  });
  const selected = selectRoundReport(deps.readRoundRecords(entry), {
    ...binding,
    consumedReportId: entry.lastReportId,
  });
  if (!selected.ok) {
    // A kind that is NOT round-bound and whose newest report is its OWN
    // consumed one has simply been recorded already: silence, not a
    // fail-closed notice. For a goal or plan audit the same observation means
    // the opposite — this round's verdict has not arrived — so it is reported.
    if (selected.reason === "already-consumed" && spec.binding !== "round-bound") {
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
  } else if (spec.kind === "quality") {
    text = await deps.recordQuality({ root: input.root, concluded });
  } else if (spec.kind === "acceptance") {
    text = await deps.recordAcceptance({ root: input.root, concluded });
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
  // A DEGRADED BINDING ANNOUNCES ITSELF, in the same text that carries the
  // verdict it let through (project manager, 2026-09-05).
  //
  // The exception below the content check is legitimate — a session with no
  // checkpoint record has no content TIMESTAMP for a verdict to lag behind
  // (its range may still be a real one, see `prepare_review`) — but an exception
  // only the code knows about is how "this round was bound by round and cursor
  // alone" quietly becomes what everyone assumes every round is. The condition
  // here is EXACTLY the one `selectRoundReport` skipped on, so the sentence
  // cannot drift away from the branch it describes.
  let bindingNote: string | undefined;
  if (binding.binding === "round-and-content" && binding.contentAt === undefined && spec.degradedContentBinding) {
    bindingNote = spec.degradedContentBinding();
    // Both, on purpose: the note rides the recorded text for whoever prints it
    // whole, and travels as its own field for the wake-up that prints one line.
    text = `${text}\n\n${bindingNote}`;
  }
  // The audit is on record now, so what it was judging can be forgotten. This
  // is deliberately AFTER the write (the old code dropped it before, which
  // lost the binding if the write failed).
  // Only the kinds that HAVE a pending entry forget it here: a review and a
  // quality round never register one (calling this would be a no-op today, and
  // a call whose meaning is "it happens to be safe" is how a later change to
  // `forgetPending` turns two rounds into one that silently drops state).
  if (spec.kind === "goal" || spec.kind === "plan") deps.forgetPending(input.root);
  deps.advanceCursor(entry.judgeId, report.reportId);
  // ── AND NOW THE PANE GOES (2026-09-21, user decision) ──
  //
  // AFTER the verdict is on record, never before: that ordering is the whole
  // safety argument. The conclusion is the opener's now, so the pane is screen
  // space — and freeing it costs no context, because the next dispatch of this
  // role re-opens the SAME session id (`judge_submit` falls through to a fresh
  // open when the registered pane is dead; the transcript continues by session
  // id, so the review never starts from zero).
  //
  // Best effort, and LOUD when it is not enough: a throw here must not replace
  // the round's verdict with an exception raised by its cleanup, so it is
  // caught into the same audit line a failed close produces.
  if (deps.reclaimJudgePane) {
    try {
      await deps.reclaimJudgePane(input.root, entry.judgeId, entry.role);
    } catch {
      // A throw from cleanup must never replace the round's verdict with an
      // exception — the verdict is already recorded, and the CALLER's own
      // `reclaimJudgePane` is where a half-done reclaim becomes a log line
      // (`reclaimAuditLine`), because that side knows which log it belongs in.
    }
  }
  return {
    status: "recorded",
    kind: spec.kind,
    reportId: report.reportId,
    hasVerdict,
    verdict: concluded.verdict,
    text,
    ...(bindingNote === undefined ? {} : { bindingNote }),
    // Straight off the report the recorder just accepted — never re-derived
    // here, so what the wake-up prints is what the judge actually stamped.
    ...(concluded.scope === undefined ? {} : { scope: concluded.scope }),
  };
}
