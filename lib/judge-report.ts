/**
 * The opener-side standard report — what a wake-up carries.
 *
 * (This module used to ALSO scrape the judge's transcript tail for verdict fences
 * on every settle; that path is gone — a round ends exactly one way, judge_conclude
 * (lib/judge-conclude.ts). What stays is the report the opener builds when a round
 * ends: verdict, evidence pointers, record note, open questions. Pure, so tests pin it.)
 *
 * ONE FORMAT, TWO WAKE-UP PATHS (2026-09-05, user decision). The settle path
 * (the gate noticing a finished round on its own) and `judge_wait` (the opener
 * blocking on purpose because it has nothing else to do) both speak through
 * THIS builder — a second report text would be a second thing to keep
 * truthful. The wait is MESSAGE-DRIVEN, so the builder has to say more than
 * "a round ended": a new streamed finding, a judge's question, a dead pane and
 * an expired window each get their own headline and their own next step, and
 * every one of them carries the PAYLOAD (the finding bodies, the question with
 * its options) rather than a path the opener would have to go read.
 */

import { WAIT_DISCIPLINE_HINT } from "./agent-directives.ts";
import type { ReviewScopeStamp } from "./orchestrator-channel.ts";



/**
 * Why the opener is being woken.
 *
 * `report` is the classic one — a round ended. The other four exist because
 * the wait is message-driven: it returns the moment a judge streams a finding,
 * asks a question, loses its pane, or the blocking window expires with nothing
 * new. Each is a DIFFERENT next step, so none of them may render as "a round
 * ended".
 */
export type StandardReportReason = "report" | "finding" | "question" | "pane-dead" | "pending";

/** First line per reason — the opener reads this one and knows what happened. */
const HEADLINE: Record<StandardReportReason, string> = {
  report: "本轮已有 channel report：",
  finding: "本轮流出新 findings：",
  question: "本轮有新提问等你回答：",
  "pane-dead": "pane 消失且 verdict 未落盘 —— 本轮不算结束：",
  pending: "本轮仍在运行，这段时间没有新消息：",
};


/** One open question surfaced from the channel (text + options, never the transcript). */
export interface OpenQuestionBrief {
  title: string;
  options: ReadonlyArray<string>;
  requestId: string;
}

/** Everything a wake-up needs, nothing it must go read elsewhere. */
export interface StandardReportInput {
  role: string;
  judgeId: string;
  verdict?: string | undefined;
  findingsCount?: number | undefined;
  /** Bounded conclusion excerpt from the report bytes (an adviser's whole deliverable). */
  conclusionExcerpt?: string | undefined;
  streamPath?: string | undefined;
  /** recordRoundOutput's note; absent with unrecorded=true means retry later. */
  recordedNote?: string | undefined;
  unrecorded?: boolean | undefined;
  /**
   * The round ran under a WEAKER binding, in its own words.
   *
   * Printed as its own line rather than folded into `recordedNote`, which is
   * shown first-line-only: a degradation announced somewhere the wake-up never
   * prints is indistinguishable from one that was never announced.
   */
  bindingNote?: string | undefined;
  openQuestions?: ReadonlyArray<OpenQuestionBrief> | undefined;
  /** Why this wake-up happened (default `report` — the settle path's case). */
  reason?: StandardReportReason | undefined;
  /**
   * Findings that are NEW since the opener's cursor, one formatted line each
   * (`[P1] lib/a.ts:12 — issue`). The BODIES travel, not a count and a path:
   * a wake-up the opener has to go read is not a wake-up.
   */
  newFindings?: ReadonlyArray<string> | undefined;
  /**
   * A report the channel HOLDS that is not this round's (an older round, or one
   * stamped no later than this round's checkpoint).
   *
   * It is reported and never adopted. Saying nothing about it is what made the
   * old behaviour dangerous in both directions: silence reads as "the reviewer
   * has not answered yet", while ADOPTING it bound a READY to a commit the
   * reviewer never saw (2026-09-05).
   */
  notThisRound?: { reportId: string; round?: number; at?: string; detail: string } | undefined;
  /** The judge's own last self-reported state, e.g. `working（自 …）`. */
  stateLine?: string | undefined;
  /** How long a blocking wait actually waited, in seconds. */
  waitedSeconds?: number | undefined;
  /**
   * WHAT THE ROUND REVIEWED, as the judge itself stamped on its report
   * (`ChannelReportRecord.scope`): the commit range and the full/incremental
   * decision. Absent for a round that carried neither — a goal audit, or a
   * judge on a build that predates the stamp.
   */
  scope?: ReviewScopeStamp | undefined;

}

/** Cap for the excerpt: a report is a wake-up, not a reprint. */
export const STANDARD_REPORT_EXCERPT_CHARS = 3000;

/** Cap for streamed finding bodies: the newest ones travel, the rest are counted. */
export const STANDARD_REPORT_FINDINGS_MAX = 20;

/**
 * The gate-built standard report: the opener learns WHAT happened (a round
 * ended, a finding streamed, a question was asked, a pane died, or nothing
 * did), its verdict, where the evidence is, what was recorded, and which
 * questions are still open — without reading any transcript or stream file.
 * Pure, so tests pin it.
 */
export function buildStandardReport(input: StandardReportInput): string {
  const reason: StandardReportReason = input.reason ?? "report";
  const lines = [`[REVIEW_GATE_REPORT] ${input.role}（${input.judgeId}）${HEADLINE[reason]}`];
  if (input.verdict !== undefined) {
    lines.push(`- 结论：${input.verdict}${input.findingsCount === undefined ? "" : `，findings ${input.findingsCount} 条`}（P0/P1 边审边修走 findings 流）`);
  }
  // WHAT THE ROUND SAYS IT REVIEWED. Printed right under the verdict because
  // that is the pair an audit reads: a verdict whose scope nobody wrote down
  // cannot be checked afterwards for either laziness or duplicated work. The
  // gate knows what it DISPATCHED; this line is what came back.
  if (input.scope !== undefined && (input.scope.range !== undefined || input.scope.kind !== undefined)) {
    const kind = input.scope.kind === "incremental"
      ? "增量"
      : input.scope.kind === "full" ? "全量深审" : "范围标记缺失";
    lines.push(`- 本轮审查范围（judge 自报）：${input.scope.range ?? "未标注"}（${kind}）`);
  }
  if (input.unrecorded) {
    lines.push("- 记录：本轮 report 到达但尚未记入 review 链（记录时无可用上下文）——保持 armed，下次 settle 重试，不要重开一轮。");
  } else if (input.recordedNote !== undefined && input.recordedNote.trim().length > 0) {
    lines.push(`- 记录：${input.recordedNote.trim().split("\n")[0]}`);
  }
  // Right under the record it applies to: the verdict was recorded, AND it was
  // recorded under a weaker binding than usual. Both facts or neither.
  if (input.bindingNote !== undefined && input.bindingNote.trim().length > 0) {
    lines.push(`- 绑定说明：${input.bindingNote.trim()}`);
  }
  if (input.conclusionExcerpt !== undefined && input.conclusionExcerpt.trim().length > 0) {
    const excerpt = input.conclusionExcerpt.trim().slice(0, STANDARD_REPORT_EXCERPT_CHARS);
    lines.push(`- 结论原文（截断）：${excerpt}`);
  }
  const newFindings = input.newFindings ?? [];
  if (newFindings.length > 0) {
    const shown = newFindings.slice(-STANDARD_REPORT_FINDINGS_MAX);
    const omitted = newFindings.length - shown.length;
    lines.push(`- 新 findings（${newFindings.length} 条${omitted > 0 ? `，下面列最新 ${shown.length} 条` : ""}）：`);
    for (const f of shown) lines.push(`  ${f}`);
  }
  // The report the gate SET ASIDE. It is named with its id, round and stamp so
  // the claim is checkable in the channel file — an unrecorded verdict must
  // never look like this round's conclusion, and must never vanish either.
  const stale = input.notThisRound;
  if (stale !== undefined) {
    const round = stale.round === undefined ? "" : `round ${stale.round}`;
    const at = stale.at === undefined ? "" : stale.at;
    const tag = [round, at].filter(Boolean).join("，");
    lines.push(
      `- 未采纳的 report：${stale.reportId}${tag ? `（${tag}）` : ""} —— ${stale.detail}；` +
      "**没有**记为本轮裁决，本轮仍在等自己的 report。",
    );
  }
  if (input.stateLine !== undefined && input.stateLine.trim().length > 0) {
    lines.push(`- 当前状态：${input.stateLine.trim()}`);
  }
  if (input.waitedSeconds !== undefined) lines.push(`- 已阻塞等待：${input.waitedSeconds}s`);
  if (input.streamPath !== undefined) lines.push(`- 流证据：${input.streamPath}`);
  const questions = input.openQuestions ?? [];
  for (const q of questions) {
    const opts = q.options.length > 0 ? `（选项：${q.options.join(" / ")}）` : "";
    lines.push(`- 待答问题：${q.title}${opts} —— 用 judge_answer 回答（request ${q.requestId}）。`);
  }
  lines.push(...nextStep(input, reason));
  return lines.join("\n");
}

/**
 * The one line that says what to DO — different per reason, because "a
 * finding arrived" and "the round ended" are not the same instruction. A
 * verdict always wins: once a round has ended, nothing else is the next step.
 */
function nextStep(input: StandardReportInput, reason: StandardReportReason): string[] {
  if (input.verdict === "READY") return ["下一步：收尾（declare_done 前确认工作区干净）。"];
  if (input.verdict === "BLOCKED") return ["下一步：按 findings 修完再 judge_submit 同一 role（同 pane 续接）。"];
  switch (reason) {
    case "finding":
      return ["下一步：先在代码里确认这些 findings，能修就就地修（审查范围是 immutable commit，工作区编辑不失效本轮）；确实没别的活了再调 judge_wait 继续等。"];
    case "pane-dead":
      return ["下一步：judge_recover 同 id 重开、续 transcript 继续本轮。"];
    case "pending":
      return [WAIT_DISCIPLINE_HINT];
    default:
      return [];
  }
}

