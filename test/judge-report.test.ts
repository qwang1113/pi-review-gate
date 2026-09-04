/**
 * Opener-side standard report — what a wake-up carries.
 *
 * (The transcript-scraping collector tests lived here until the conclude
 * tool replaced that path; a round ends exactly one way now —
 * judge_conclude — so only the report builder is pinned.)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildStandardReport } from "../lib/judge-report.ts";

test("buildStandardReport: verdict, evidence, record note, questions, next step", async () => {
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
