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

test("buildStandardReport: a REVIEWER's report carries structured conclusion only — no judge prose", async () => {
  // The opener's context is the scarce resource this whole design protects: a
  // reviewer / goal-auditor round reaches it as verdict + count + evidence
  // pointer + next step, and nothing the judge wrote in words. That holds at
  // two levels — the report record itself carries no prose for those roles
  // (test/judge-conclude.ts), and the opener only ever passes an excerpt for
  // an adviser (pinned structurally in test/extension-structure.test.ts).
  const text = buildStandardReport({
    role: "reviewer",
    judgeId: "j9",
    verdict: "BLOCKED",
    findingsCount: 3,
    streamPath: "/repo/.pi/review-stream/r.jsonl",
    recordedNote: "review-gate: recorded verdict BLOCKED for /repo (round 2/10, findings: 3).",
  });
  assert.match(text, /结论：BLOCKED，findings 3 条/);
  assert.match(text, /流证据：/);
  assert.match(text, /下一步：按 findings 修完再 judge_submit/);
  assert.doesNotMatch(text, /结论原文/, "no judge prose section may appear for a reviewer");
  // Every line is either the header or one of the gate's own structured
  // bullets — there is no place for a paragraph to hide.
  for (const line of text.split("\n").slice(1)) {
    assert.ok(/^- |^下一步：/.test(line), `unstructured line reached the opener: ${line}`);
  }
});
