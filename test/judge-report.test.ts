/**
 * Verdict collection end to end (the E2E P0 shape): a fenced verdict sitting
 * in the pane's REAL session dir (an explicit --session-dir the cwd encoding
 * never points at) must still become exactly one channel report; prose
 * without a fence stays silent; collecting twice appends once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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

function deps(io: ChannelIO): VerdictCollectDeps {
  return { channelIO: () => io, channelHome: () => undefined };
}

function lastReportFor(io: ChannelIO, opener: string, judge: string) {
  const target = judgeChannelTarget(opener, judge, undefined);
  return projectChannel(readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home)).records).lastReport;
}

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
