/**
 * The opener-side standard report — what a wake-up carries.
 *
 * (This module used to ALSO scrape the judge's transcript tail for verdict fences
 * on every settle; that path is gone — a round ends exactly one way, judge_conclude
 * (lib/judge-conclude.ts). What stays is the report the opener builds when a round
 * ends: verdict, evidence pointers, record note, open questions. Pure, so tests pin it.)
 */
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
  openQuestions?: ReadonlyArray<OpenQuestionBrief> | undefined;
}

/** Cap for the excerpt: a report is a wake-up, not a reprint. */
export const STANDARD_REPORT_EXCERPT_CHARS = 3000;

/**
 * The gate-built standard report: the opener learns a round ended, its
 * verdict, where the evidence is, what was recorded, and which questions
 * are still open — without reading any transcript. Pure, so tests pin it.
 */
export function buildStandardReport(input: StandardReportInput): string {
  const lines = [`[REVIEW_GATE_REPORT] ${input.role}（${input.judgeId}）本轮已有 channel report：`];
  if (input.verdict !== undefined) {
    lines.push(`- 结论：${input.verdict}${input.findingsCount === undefined ? "" : `，findings ${input.findingsCount} 条`}（P0/P1 边审边修走 findings 流）`);
  }
  if (input.unrecorded) {
    lines.push("- 记录：本轮 report 到达但尚未记入 review 链（记录时无可用上下文）——保持 armed，下次 settle 重试，不要重开一轮。");
  } else if (input.recordedNote !== undefined && input.recordedNote.trim().length > 0) {
    lines.push(`- 记录：${input.recordedNote.trim().split("\n")[0]}`);
  }
  if (input.conclusionExcerpt !== undefined && input.conclusionExcerpt.trim().length > 0) {
    const excerpt = input.conclusionExcerpt.trim().slice(0, STANDARD_REPORT_EXCERPT_CHARS);
    lines.push(`- 结论原文（截断）：${excerpt}`);
  }
  if (input.streamPath !== undefined) lines.push(`- 流证据：${input.streamPath}`);
  const questions = input.openQuestions ?? [];
  for (const q of questions) {
    const opts = q.options.length > 0 ? `（选项：${q.options.join(" / ")}）` : "";
    lines.push(`- 待答问题：${q.title}${opts} —— 用 judge_answer 回答（request ${q.requestId}）。`);
  }
  if (input.verdict === "READY") lines.push("下一步：收尾（declare_done 前确认工作区干净）。");
  else if (input.verdict === "BLOCKED") lines.push("下一步：按 findings 修完再 judge_submit 同一 role（同 pane 续接）。");
  return lines.join("\n");
}
