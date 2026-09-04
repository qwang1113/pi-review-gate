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

import {
  appendRecord,
  channelPathFor,
  judgeChannelTarget,
  projectChannel,
  readChannel,
  reportText,
  type ChannelIO,
} from "./orchestrator-channel.ts";
import { buildVerdictReport, verdictReportKey } from "./judge-side.ts";

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

/** One transcript line → the text a human would read from it. */
function transcriptLineText(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  try {
    const parts: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") parts.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(JSON.parse(trimmed));
    return parts.join("\n");
  } catch { return line; }
}

function countFindings(streamPath: string | undefined): number | undefined {
  if (!streamPath) return undefined;
  try {
    return readFileSync(streamPath, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
  } catch { return undefined; }
}

/**
 * Scan → build → dedupe → append. Idempotent: a fence already collected
 * (same key in `alreadyReported`, or the channel's lastReport already
 * carrying it) appends nothing. Never throws.
 */
export function collectVerdictReport(
  deps: VerdictCollectDeps,
  input: VerdictCollectInput,
  alreadyReported: ReadonlySet<string>,
): VerdictCollectResult {
  try {
    const tail = readNewestTranscriptTail(input.sessionDir);
    if (!tail) return { collected: false };
    const built = buildVerdictReport({
      transcriptTail: tail,
      findingsCount: countFindings(input.streamPath),
      now: input.now,
    });
    if (!built) return { collected: false };
    const key = verdictReportKey(built);
    if (alreadyReported.has(key)) return { collected: false };
    const io = deps.channelIO();
    const target = judgeChannelTarget(input.openerId, input.judgeId, deps.channelHome());
    const read = readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home));
    const last = projectChannel(read.records).lastReport;
    if (last) {
      const lastKey = verdictReportKey({
        verdict: last.verdict,
        findingsCount: last.findingsCount,
        summary: reportText(io, last) ?? "",
      });
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
