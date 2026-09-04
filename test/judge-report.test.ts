/**
 * Verdict collection end to end (the E2E P0 shape): a fenced verdict sitting
 * in the pane's REAL session dir (an explicit --session-dir the cwd encoding
 * never points at) must still become exactly one channel report; prose
 * without a fence stays silent; collecting twice appends once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  collectVerdictReport,
  readNewestTranscriptTail,
  type VerdictCollectDeps,
} from "../lib/judge-report.ts";
import { sessionDirForCwd, sessionDirFromContext } from "../lib/session-dir.ts";
import {
  channelPathFor,
  judgeChannelTarget,
  projectChannel,
  readChannel,
  type ChannelIO,
} from "../lib/orchestrator-channel.ts";
import { memoryChannelIO } from "./helpers/fake-orchestration.ts";

const FENCE = '```json\n{"gate":"READY","findings":[]}\n```\nanalysis text';

function workdirWithTranscript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "judge-report-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "sessions", "2026-09-04T00-00-00-000Z_rg-reviewer-abc.jsonl"),
    `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":${JSON.stringify(body)}}]}}\n`);
  return join(dir, "sessions");
}

/** One assistant transcript line, the only shape the collector reads. */
function assistantLine(text: string): string {
  return `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":${JSON.stringify(text)}}]}}\n`;
}

function deps(io: ChannelIO): VerdictCollectDeps {
  return { channelIO: () => io, channelHome: () => undefined };
}

function lastReportFor(io: ChannelIO, opener: string, judge: string) {
  const target = judgeChannelTarget(opener, judge, undefined);
  return projectChannel(readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home)).records).lastReport;
}

test("reviewer repro: prose appended after a collected READY re-reports nothing", () => {
  // Round N collected; the pane keeps deliberating into round N+1 without a
  // new fence. The tail grows (key on tail length would shift: READY#-#107 →
  // READY#-#162) but the newest fence bytes are unchanged ⇒ silence.
  const io = memoryChannelIO(() => 1);
  const dir = mkdtempSync(join(tmpdir(), "judge-report-"));
  const file = join(dir, "s.jsonl");
  const line = assistantLine;
  writeFileSync(file, line(`round N done\n${FENCE}`));
  const input = { sessionDir: dir, openerId: "op1", judgeId: "jr", now: 1 };
  assert.equal(collectVerdictReport(deps(io), input, new Set()).collected, true);
  appendFileSync(file, line("round N+1 deliberating: re-reading the diff, no fence yet"));
  assert.equal(collectVerdictReport(deps(io), input, new Set()).collected, false);
});

test("two sequential fences: only the newest is the round conclusion", () => {
  const io = memoryChannelIO(() => 1);
  const dir = mkdtempSync(join(tmpdir(), "judge-report-"));
  const file = join(dir, "s.jsonl");
  const line = assistantLine;
  const BLOCKED = '```json\n{"gate":"BLOCKED","findings":[{"severity":"P1","issue":"x"}]}\n```';
  writeFileSync(file, line(`first pass\n${BLOCKED}`));
  const input = { sessionDir: dir, openerId: "op1", judgeId: "js", now: 1 };
  const r1 = collectVerdictReport(deps(io), input, new Set());
  assert.equal(r1.collected, true);
  assert.equal(r1.collected && r1.verdict, "BLOCKED");
  appendFileSync(file, line(`second pass\n${FENCE}`));
  const r2 = collectVerdictReport(deps(io), input, new Set());
  assert.equal(r2.collected, true);
  assert.equal(r2.collected && r2.verdict, "READY");
});

test("a fence in the authoritative dir becomes exactly one report", () => {
  const io = memoryChannelIO(() => 1);
  const sessionDir = workdirWithTranscript(`done\n${FENCE}`);
  const r1 = collectVerdictReport(deps(io),
    { sessionDir, openerId: "op1", judgeId: "j1", now: 1 }, new Set());
  assert.equal(r1.collected, true);
  assert.equal(r1.collected && r1.verdict, "READY");
  const last = lastReportFor(io, "op1", "j1");
  assert.ok(last, "report landed in the channel");
  assert.equal(last!.verdict, "READY");
  // Idempotent across settles: same fence, fresh memory set, still one line.
  const r2 = collectVerdictReport(deps(io),
    { sessionDir, openerId: "op1", judgeId: "j1", now: 2 }, new Set());
  assert.equal(r2.collected, false);
});

test("prose without a fence stays silent", () => {
  const io = memoryChannelIO(() => 1);
  const sessionDir = workdirWithTranscript("still thinking, no fence yet");
  const r = collectVerdictReport(deps(io),
    { sessionDir, openerId: "op1", judgeId: "j2", now: 1 }, new Set());
  assert.equal(r.collected, false);
  assert.equal(lastReportFor(io, "op1", "j2"), undefined);
});

test("E2E P0 regression: the cwd encoding sees nothing, the manager dir sees the fence", () => {
  const sessionDir = workdirWithTranscript(`done\n${FENCE}`);
  const fakeCtx = { sessionManager: { getSessionDir: () => sessionDir } };
  const authoritative = sessionDirFromContext(fakeCtx, "/tmp/does-not-exist-judge-report");
  assert.equal(authoritative, sessionDir);
  // The encoding points at a global sessions dir that holds no transcript.
  const encoded = sessionDirForCwd("/tmp/does-not-exist-judge-report");
  assert.notEqual(encoded, sessionDir);
  assert.equal(readNewestTranscriptTail(encoded), undefined);
  // …so collecting from the encoding stays silent while the authoritative
  // dir collects — exactly the production failure and its fix.
  const io = memoryChannelIO(() => 1);
  assert.equal(collectVerdictReport(deps(io),
    { sessionDir: encoded, openerId: "op1", judgeId: "j3", now: 1 }, new Set()).collected, false);
  assert.equal(collectVerdictReport(deps(io),
    { sessionDir: authoritative, openerId: "op1", judgeId: "j3", now: 1 }, new Set()).collected, true);
});

test("findings stream lines become the count, never the content", () => {
  const io = memoryChannelIO(() => 1);
  const sessionDir = workdirWithTranscript(`done\n${FENCE}`);
  const stream = join(mkdtempSync(join(tmpdir(), "judge-report-stream-")), "stream.jsonl");
  writeFileSync(stream, '{"id":"a"}\n{"id":"b"}\n');
  const r = collectVerdictReport(deps(io),
    { sessionDir, openerId: "op1", judgeId: "j4", streamPath: stream, now: 1 }, new Set());
  assert.equal(r.collected, true);
  assert.equal(r.collected && r.findingsCount, 2);
});

test("buildStandardReport: verdict, evidence, record note, questions, next step", async () => {
  const { buildStandardReport } = await import("../lib/judge-report.ts");
  const text = buildStandardReport({
    role: "reviewer",
    judgeId: "j1",
    verdict: "BLOCKED",
    findingsCount: 2,
    streamPath: "/s/stream.jsonl",
    recordedNote: "recorded verdict BLOCKED for /repo (round 1/15)",
    openQuestions: [{ title: "选 A 还是 B？", options: ["A", "B"], requestId: "q1" }],
  });
  assert.match(text, /\[REVIEW_GATE_REPORT\] reviewer（j1）/);
  assert.match(text, /结论：BLOCKED，findings 2 条/);
  assert.match(text, /流证据：\/s\/stream\.jsonl/);
  assert.match(text, /记录：recorded verdict BLOCKED/);
  assert.match(text, /待答问题：选 A 还是 B？（选项：A \/ B）/);
  assert.match(text, /judge_answer/);
  assert.match(text, /下一步：按 findings 修完再 judge_submit/);
});

test("buildStandardReport: adviser carries its conclusion, unrecorded stays armed", async () => {
  const { buildStandardReport } = await import("../lib/judge-report.ts");
  const adviser = buildStandardReport({
    role: "adviser",
    judgeId: "j2",
    verdict: "READY",
    conclusionExcerpt: "建议：拆小步提交",
    recordedNote: undefined,
  });
  assert.match(adviser, /结论原文（截断）：建议：拆小步提交/);
  assert.match(adviser, /下一步：收尾/);
  const pending = buildStandardReport({ role: "reviewer", judgeId: "j3", unrecorded: true });
  assert.match(pending, /尚未记入 review 链/);
  assert.match(pending, /不要重开一轮/);
});

test("a fence inside a TOOL RESULT is never the round's verdict (round-7 Note)", () => {
  // This repo's own tests and docs are full of fenced verdicts. A collector
  // that walked every string in a transcript line would let a fixture the
  // judge merely READ become "the newest fence" and be recorded as its verdict.
  const io = memoryChannelIO(() => 1);
  const dir = mkdtempSync(join(tmpdir(), "judge-report-"));
  const file = join(dir, "s.jsonl");
  const FIXTURE = '```json\n{"gate":"BLOCKED","findings":[{"severity":"P0","issue":"from a fixture"}]}\n```';
  writeFileSync(file,
    assistantLine(`round done\n${FENCE}`) +
    // The judge then reads a test file whose content contains a fence.
    JSON.stringify({
      type: "message",
      message: { role: "toolResult", content: [{ type: "text", text: `file body\n${FIXTURE}` }] },
    }) + "\n");
  const r = collectVerdictReport(deps(io),
    { sessionDir: dir, openerId: "op1", judgeId: "jt", now: 1 }, new Set());
  assert.equal(r.collected, true);
  assert.equal(r.collected && r.verdict, "READY", "the judge's own fence decides, not the fixture it read");
});

test("thinking blocks are not the judge's word either", () => {
  const io = memoryChannelIO(() => 1);
  const dir = mkdtempSync(join(tmpdir(), "judge-report-"));
  writeFileSync(join(dir, "s.jsonl"), JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: `maybe\n${FENCE}` }],
    },
  }) + "\n");
  assert.equal(collectVerdictReport(deps(io),
    { sessionDir: dir, openerId: "op1", judgeId: "jk", now: 1 }, new Set()).collected, false);
});
