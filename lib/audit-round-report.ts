/**
 * WHICH REPORT CLOSES A ROUND — the one selector the audit-round engine
 * (lib/audit-round.ts, lib/audit-round-settle.ts) and the wait criteria
 * (lib/judge-wait-criteria.ts) share, the binding it is asked with, and the
 * sentence a miss is described by.
 *
 * Its own module because two different callers must reach the SAME rule:
 * the recorder asks "may this report be recorded?", the probe behind
 * `judge_wait` asks "did this round end?", and the two answers drifting apart
 * is how a wait announced a verdict the recorder then refused (2026-09-05).
 */
import type { ChannelRecord, ChannelReportRecord } from "./channel-records.ts";
import { specForRound, type AuditKind, type ReportBinding } from "./audit-round-specs.ts";

/** Why the channel held no report this round may be adjudicated against. */
export type RoundReportMiss =
  | "no-report"
  | "already-consumed"
  | "round-mismatch"
  /** The round cannot be verified at all (no `roundSeq` registered). */
  | "round-unknown"
  /** The report is not newer than the content this round judges. */
  | "stale-content"
  /** One of the two timestamps is missing or unparseable. */
  | "content-unknown";

/**
 * The outcome of asking "which report closes THIS round?".
 *
 * A miss carries BOTH sides of whatever did not match — the report's id, round
 * and stamp, and what the round expected — because the sentence the agent
 * reads has to name them. "Not this round's report" with no ids is a fact the
 * reader cannot check.
 */
export type RoundReportSelection =
  | { ok: true; report: ChannelReportRecord }
  | {
      ok: false;
      reason: RoundReportMiss;
      reportId?: string;
      round?: number;
      at?: string;
      expectedRound?: number;
      contentAt?: string;
    };

/**
 * THE THREE FACTS that decide whether a report may close a round, derived in
 * ONE place from the kind of round it is.
 *
 * It exists so the SELECTOR and the PROBE cannot drift: `judge_wait` and the
 * settle sweep ask "did this round end?" and `settleAuditRound` asks "may this
 * report be recorded?", and those two questions must have the same answer or
 * the wait announces a verdict the recorder refuses (measured 2026-09-05).
 * Both call `selectRoundReport` with a binding built here.
 *
 * `contentAt` is populated ONLY for the kind that binds to content (review).
 * A goal or plan audit runs before any checkpoint exists — feeding it a
 * content stamp, or refusing it for the lack of one, would strand the very
 * first audit of a session.
 */
export interface RoundBinding {
  binding: ReportBinding;
  /** The round number THIS dispatch registered (`roundSeq`). */
  expectedRound: number | undefined;
  /** The content stamp the round judges — a review's `checkpoint.at`. */
  contentAt: string | undefined;
}

/** Build this round's binding from the role, its pending audit and gate state. */
export function roundBindingFor(input: {
  role: string;
  pendingKind?: AuditKind;
  roundSeq?: number;
  /** `checkpoint.at` of the repo — used by the review binding only. */
  checkpointAt?: string;
}): RoundBinding {
  const binding = specForRound(input.role, input.pendingKind)?.binding ?? "cursor-only";
  return {
    binding,
    expectedRound: input.roundSeq,
    contentAt: binding === "round-and-content" ? input.checkpointAt : undefined,
  };
}

/**
 * WHICH REPORT CLOSES THIS ROUND — the ONE selector.
 *
 * It used to have two entry points in the extension (`staleAuditGuard` and an
 * inline call inside `auditPlanRound`), which is how the goal path and the
 * plan path ended up fail-closing on subtly different conditions. There is one
 * now, and every kind reaches it through `settleAuditRound` — including the
 * PROBE behind `judge_wait` and the settle sweep, which used to compare the
 * cursor on their own (2026-09-05).
 *
 * The round source of truth is `judge-conclude.ts` (`roundSeq`, stamped on
 * every report); no second round tracker lives here. A report that pre-dates
 * round numbering counts as round 0, so it can never match a real round.
 * `expectedRound === undefined` (an entry from before round numbering) falls
 * back to the cursor alone for a `round-bound` audit — but NOT for a review,
 * whose binding fails closed rather than trusting its other half.
 */
export function selectRoundReport(
  records: ReadonlyArray<ChannelRecord>,
  opts: {
    binding: ReportBinding;
    expectedRound: number | undefined;
    consumedReportId: string | undefined;
    /** The content this round judges (review only) — see `RoundBinding`. */
    contentAt?: string | undefined;
  },
): RoundReportSelection {
  let last: ChannelReportRecord | undefined;
  for (const r of records) {
    if (r.kind === "report" && r.from === "child") last = r;
  }
  if (!last) return { ok: false, reason: "no-report" };
  const reportRound =
    typeof last.round === "number" && Number.isFinite(last.round) ? Math.floor(last.round) : undefined;
  const reportAt = typeof last.at === "string" ? last.at : undefined;
  // Every miss below names the report it refused, so the sentence built from
  // it is checkable against the channel file.
  const seen = {
    reportId: last.reportId,
    ...(reportRound === undefined ? {} : { round: reportRound }),
    ...(reportAt === undefined ? {} : { at: reportAt }),
  };
  // ROUND FIRST, CONTENT SECOND, CURSOR LAST — the order is load-bearing
  // (2026-09-05).
  //
  // For a bound kind the ROUND is what makes a report this round's; the cursor
  // is a second safety net, not the safety itself. Checking the cursor first
  // would let `already-consumed` MASK a round mismatch: a report from an older
  // round that happens to be the consumed one comes back as "you already
  // recorded this" rather than "this is not your round". Nothing in the engine
  // treats `already-consumed` as a pass today — but the moment someone does,
  // that masking would resurrect the P0 `8ea7eec` fixed (an older round's
  // verdict recorded against a new draft). Ordering it this way makes the
  // roundSeq binding structural instead of something the next caller has to
  // remember.
  if (opts.binding === "round-bound" || opts.binding === "round-and-content") {
    if (opts.expectedRound === undefined) {
      // A review refuses what it cannot verify; a legacy round-bound entry
      // (written before round numbering) still falls back to the cursor.
      if (opts.binding === "round-and-content") return { ok: false, reason: "round-unknown", ...seen };
    } else if ((reportRound ?? 0) !== Math.floor(opts.expectedRound)) {
      return {
        ok: false,
        reason: "round-mismatch",
        ...seen,
        round: reportRound ?? 0,
        expectedRound: Math.floor(opts.expectedRound),
      };
    }
  }
  // THE CONTENT CHECK — a verdict may never lag the content by a round.
  //
  // A reviewer's report that lands while the agent is still editing is not
  // delivered until the next submission settles; without this, that leftover
  // report became the NEW round's verdict, binding a READY to a commit the
  // reviewer never saw (four reproductions, 2026-09-05). Where a content stamp
  // EXISTS it is an AND with the round check, never a fallback for it: an
  // unreadable report stamp is refused rather than waved through on the round.
  //
  // NO CONTENT STAMP AT ALL IS A DIFFERENT CASE, and it is not refused
  // (reviewer P1, 2026-09-05; user decision the same day). No `checkpoint`
  // record in the gate's STATE — which is the session's own sidecar, empty at
  // the start of every session, whatever git history holds — is the round
  // `prepare_review` treats as having no content STAMP: there is no
  // `checkpoint.at` for a verdict to lag behind, whatever range that round
  // resolved (since 2026-09-15 it may be a real branch-base..HEAD delivery).
  // Refusing it does not fail closed in any useful
  // sense, it makes that round UNCLOSABLE: the recorder never records, the
  // probe never ends the round, and a READY can never be reached. The round
  // binding and the cursor still apply, so a leftover report from an earlier
  // round is still refused here.
  if (opts.binding === "round-and-content" && opts.contentAt !== undefined) {
    const reportMs = reportAt === undefined ? Number.NaN : Date.parse(reportAt);
    const contentMs = Date.parse(opts.contentAt);
    if (!Number.isFinite(reportMs) || !Number.isFinite(contentMs)) {
      return {
        ok: false,
        reason: "content-unknown",
        ...seen,
        contentAt: opts.contentAt,
      };
    }
    if (reportMs <= contentMs) {
      return { ok: false, reason: "stale-content", ...seen, contentAt: opts.contentAt };
    }
  }
  if (last.reportId === opts.consumedReportId) {
    // `...seen` HERE TOO (2026-09-16). A caller that only asks "is this round
    // over?" does not care, but one that has to judge the report's AGE does:
    // the `settled` wait criterion compares it against the pane's last task,
    // and without `at` that comparison silently answered "no" for every REUSED
    // pane — which is exactly the case the criterion exists for (measured: the
    // 6m47s wait ran on a reused pane).
    return { ok: false, reason: "already-consumed", ...seen };
  }
  return { ok: true, report: last };
}

/**
 * HAS THIS ROUND REPORTED AT ALL — the same question, for the callers that only
 * need a yes/no.
 *
 * "Is this judge still working?" is asked in two more places — the child's own
 * heartbeat (a session waiting on its judge reports `waiting-judge`) and the
 * loop-stall breaker — and both used to answer it with their
 * OWN comparison: a report newer than the PANE's spawn time. That is the class
 * of comparison this module exists to own — and it was wrong in the ordinary
 * case, because the pane outlives the round: round 2's leftover report from
 * round 1 is newer than the spawn, so a judge that had just been given new work
 * read as finished (reviewer P2, 2026-09-05).
 *
 * A round has reported when its report may close it, or when the cursor says it
 * already did. Everything else — no report, another round's, one that predates
 * this round's content — means the judge still owes this round an answer.
 */
export function roundHasReported(
  records: ReadonlyArray<ChannelRecord>,
  binding: RoundBinding,
  consumedReportId: string | undefined,
): boolean {
  const selected = selectRoundReport(records, { ...binding, consumedReportId });
  return selected.ok || selected.reason === "already-consumed";
}


/** The human-readable half of a miss, in the gate's own voice. */
export function describeRoundMiss(selection: {
  reason: RoundReportMiss;
  reportId?: string;
  round?: number;
  at?: string;
  expectedRound?: number;
  contentAt?: string;
}): string {
  const seen = selection.reportId ? `channel 最新 report（${selection.reportId}）` : "channel 最新 report";
  switch (selection.reason) {
    case "round-mismatch":
      return `${seen} 属于第 ${selection.round ?? "?"} 轮，不是本轮（第 ${selection.expectedRound ?? "?"} 轮）`;
    case "round-unknown":
      return `${seen} 的轮次无法核对：门禁登记表里没有本轮的 roundSeq —— fail-closed，不拿时间戳顶替`;
    case "stale-content":
      return `${seen} 生成于 ${selection.at ?? "?"}，不晚于本轮 checkpoint（${selection.contentAt ?? "?"}）——它判的是本轮之前的内容`;
    case "content-unknown":
      return `${seen} 与本轮 checkpoint 的时间无法比对（report at=${selection.at ?? "无"}，checkpoint at=${selection.contentAt ?? "无"}）—— fail-closed`;
    case "already-consumed":
      return "channel 最新 report 已是消费过的旧裁决";
    default:
      return "channel 还没有本轮 report";
  }
}
