/**
 * Verdict collection — the gate-owned half of a judge round's ending.
 *
 * A reporting shell never delivers its own verdict: on every settle the
 * gate scans the pane's transcript tail for a fenced verdict and appends
 * exactly one channel `report` per verdict. The opener consumes reports
 * (cursor `lastReportId`); the transcript stays the long memory, never the
 * signal. Reporting never throws — a failure here must not break the
 * judge's own work.
 *
 * The session dir is an INPUT, resolved by the caller from the authoritative
 * source (the live session manager via sessionDirFromContext — it honors the
 * pane's explicit `--session-dir`). Resolving it from the cwd encoding here
 * would repeat the E2E P0: a pane launched with --session-dir keeps its
 * transcript somewhere the encoding never points at, and the fence would
 * never be found.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  appendRecord,
  channelPathFor,
  judgeChannelTarget,
  projectChannel,
  readChannel,
  reportText,
  type ChannelIO,
} from "./orchestrator-channel.ts";
import { buildVerdictReport } from "./judge-side.ts";
import { extractNewestFenceText } from "./verdict-parse.ts";
/** Tail window: a fence older than this is not "this round just ended". */
const TRANSCRIPT_TAIL_CHARS = 32768;

export interface VerdictCollectInput {
  /** Authoritative session dir of the judge pane (NOT cwd-encoded). */
  sessionDir: string;
  openerId: string;
  judgeId: string;
  /** Findings-stream path (RG_JUDGE_STREAM); findings are counted, never parsed. */
  streamPath?: string | undefined;
  now: number;
}

export interface VerdictCollectDeps {
  channelIO(): ChannelIO;
  channelHome(): string | undefined;
}

export type VerdictCollectResult =
  | { collected: false }
  | { collected: true; verdict: string; findingsCount?: number | undefined; reportId: string; key: string };

/** Newest top-level `*.jsonl` as human-readable text, or undefined.
 *
 * A transcript line is a JSON envelope: the fence inside assistant text is
 * JSON-escaped (`{\"gate\":...}` with `\n` newlines), which no fence parser
 * matches. Each line is therefore parsed and all string values are joined;
 * unparseable lines are kept raw. The result is what the judge wrote.
 */
export function readNewestTranscriptTail(sessionDir: string): string | undefined {
  let newest: { f: string; m: number } | undefined;
  try {
    for (const f of readdirSync(sessionDir)) {
      if (!f.endsWith(".jsonl")) continue;
      let m = 0;
      try { m = statSync(join(sessionDir, f)).mtimeMs; } catch { continue; }
      if (!newest || m > newest.m) newest = { f, m };
    }
  } catch { return undefined; }
  if (!newest) return undefined;
  try {
    const raw = readFileSync(join(sessionDir, newest.f), "utf8");
    const text = raw.split("\n").map(transcriptLineText).join("\n");
    return text.slice(-TRANSCRIPT_TAIL_CHARS);
  } catch { return undefined; }
}

/**
 * One transcript line → what the JUDGE said in it, or "" for everything else.
 *
 * ASSISTANT TEXT ONLY, deliberately (round-7 Note). A tool result routinely
 * carries a fenced verdict that is not a verdict at all — this repository's
 * own tests and docs are full of them — and a walk over every string in the
 * line would let a fixture become “the newest fence”. Thinking blocks are
 * excluded for the same reason: a draft the judge reasoned about is not what
 * it published.
 */
function transcriptLineText(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as {
      type?: string;
      message?: { role?: string; content?: unknown };
    };
    if (parsed.type !== "message" || parsed.message?.role !== "assistant") return "";
    const content = parsed.message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((b): b is { type: string; text: string } =>
        typeof b === "object" && b !== null
        && (b as { type?: unknown }).type === "text"
        && typeof (b as { text?: unknown }).text === "string")
      .map((b) => b.text)
      .join("\n");
  } catch { return ""; }
}

function countFindings(streamPath: string | undefined): number | undefined {
  if (!streamPath) return undefined;
  try {
    return readFileSync(streamPath, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
  } catch { return undefined; }
}

/**
 * Scan → build → dedupe → append. Idempotent: the dedup key is the verdict
 * plus the NEWEST fence's bytes (stable while the round deliberates) — never
 * the tail length, which shifts as the transcript grows and would re-report
 * the previous round's fence on a reused pane. Never throws.
 */
export function fenceReportKey(verdict: string, findingsCount: number | undefined, fenceText: string): string {
  return createHash("sha256")
    .update(`${verdict}#${findingsCount ?? "-"}#${fenceText}`, "utf8")
    .digest("hex");
}

export function collectVerdictReport(
  deps: VerdictCollectDeps,
  input: VerdictCollectInput,
  alreadyReported: ReadonlySet<string>,
): VerdictCollectResult {
  try {
    const tail = readNewestTranscriptTail(input.sessionDir);
    if (!tail) return { collected: false };
    const fenceText = extractNewestFenceText(tail);
    if (!fenceText) return { collected: false };
    const findingsCount = countFindings(input.streamPath);
    const built = buildVerdictReport({
      transcriptTail: tail,
      fenceText,
      findingsCount,
      now: input.now,
    });
    if (!built) return { collected: false };
    const key = fenceReportKey(built.verdict, findingsCount, fenceText);
    if (alreadyReported.has(key)) return { collected: false };
    const io = deps.channelIO();
    const target = judgeChannelTarget(input.openerId, input.judgeId, deps.channelHome());
    const read = readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home));
    const last = projectChannel(read.records).lastReport;
    if (last) {
      const lastFence = extractNewestFenceText(reportText(io, last) ?? "");
      const lastKey = lastFence === undefined
        ? undefined
        : fenceReportKey(last.verdict, last.findingsCount, lastFence);
      if (lastKey === key) return { collected: false };
    }
    appendRecord(io, target, built);
    return {
      collected: true,
      verdict: built.verdict,
      findingsCount: built.findingsCount,
      reportId: built.reportId,
      key,
    };
  } catch { return { collected: false }; }
}

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
