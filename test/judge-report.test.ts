/**
 * Opener-side standard report — what a wake-up carries.
 *
 * (The transcript-scraping collector tests lived here until the conclude
 * tool replaced that path; a round ends exactly one way now —
 * judge_conclude — so only the report builder is pinned.)
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStandardReport,
  STANDARD_REPORT_FINDINGS_MAX,
} from "../lib/judge-report.ts";


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

// ---------------------------------------------------------------------------
// The MESSAGE-DRIVEN wake-ups (2026-09-05). `judge_wait` returns on the first
// thing that happened, and it speaks through THIS builder — so the builder has
// to say what happened and carry the payload, or the opener is told to go read
// a file, which is not a wake-up.

test("buildStandardReport: a streamed finding arrives WITH its bodies and its own next step", async () => {
  const text = buildStandardReport({
    role: "reviewer",
    judgeId: "j4",
    reason: "finding",
    newFindings: ["[P0] lib/a.ts:12 — unsafe", "[P2] lib/b.ts — naming"],
    stateLine: "working（自 12:00）",
    waitedSeconds: 43,
    streamPath: "/repo/.pi/review-stream/r.jsonl",
  });
  assert.match(text, /本轮流出新 findings/, "the headline says what happened, not that a round ended");
  assert.match(text, /新 findings（2 条）/);
  assert.match(text, /\[P0\] lib\/a\.ts:12 — unsafe/, "the finding BODY travels");
  assert.match(text, /\[P2\] lib\/b\.ts — naming/);
  assert.match(text, /当前状态：working（自 12:00）/);
  assert.match(text, /已阻塞等待：43s/);
  assert.match(text, /下一步：先在代码里确认这些 findings/);
  assert.doesNotMatch(text, /结论：/, "a finding is not a verdict");
});

test("buildStandardReport: a question carries its options, a dead pane its recovery, a timeout the discipline", async () => {
  const asked = buildStandardReport({
    role: "adviser",
    judgeId: "j5",
    reason: "question",
    openQuestions: [{ title: "A 还是 B？", options: ["A", "B"], requestId: "q7" }],
  });
  assert.match(asked, /本轮有新提问等你回答/);
  assert.match(asked, /待答问题：A 还是 B？（选项：A \/ B）/);
  assert.match(asked, /用 judge_answer 回答（request q7）/);


  const dead = buildStandardReport({ role: "reviewer", judgeId: "j6", reason: "pane-dead" });
  assert.match(dead, /pane 消失且 verdict 未落盘/);
  assert.match(dead, /下一步：judge_recover 同 id 重开/);

  const pending = buildStandardReport({ role: "reviewer", judgeId: "j7", reason: "pending", waitedSeconds: 300 });
  assert.match(pending, /本轮仍在运行，这段时间没有新消息/);
  assert.match(pending, /等待纪律/, "a timeout hands back the one wording of the discipline");
  assert.match(pending, /judge_wait/, "…which names a tool that exists");
});

test("buildStandardReport: an exhausted model chain is a FAILED round, with the chain in it", () => {
  // Criterion 4 of the 2026-09-10 fix: the alternative behaviour was measured
  // — a round that hung for hours while the opener sat inside one call.
  const text = buildStandardReport({
    role: "goal-auditor",
    judgeId: "j8",
    reason: "model-exhausted",
    modelEvents: [
      { spec: "anthropic/claude-opus-5:max", error: "503 auth_unavailable", to: "onekey/gpt-6-astra:xhigh" },
      { spec: "onekey/gpt-6-astra:xhigh", error: "502 status code (no body)", exhausted: true },
    ],
    waitedSeconds: 1800,
  });
  assert.match(text, /链上模型全部失败，本轮无法继续/);
  assert.match(text, /模型 fallback（2 次）：/);
  assert.match(text, /anthropic\/claude-opus-5:max 失败（503 auth_unavailable） → 已切到 onekey\/gpt-6-astra:xhigh。/);
  assert.match(text, /onekey\/gpt-6-astra:xhigh 失败（502 status code \(no body\)） —— 链上已无可用槽，本轮到此为止。/);
  assert.match(text, /本轮\*\*没有\*\*任何结论/, "the next step must not read as a judgement about the work");
});

test("buildStandardReport: a rotation that SUCCEEDED is printed on the round's report too", () => {
  const text = buildStandardReport({
    role: "reviewer",
    judgeId: "j9",
    verdict: "READY",
    findingsCount: 0,
    modelEvents: [{ spec: "onekey/gpt-6-astra:xhigh", error: "503", to: "anthropic/claude-opus-5:max" }],
  });
  assert.match(text, /结论：READY/);
  assert.match(text, /模型 fallback（1 次）：/, "a verdict reached after a rotation says which model died");
  assert.match(text, /→ 已切到 anthropic\/claude-opus-5:max。/);
  assert.doesNotMatch(text, /没有\*\*任何结论/, "a recorded verdict keeps its own next step");
  const withModel = buildStandardReport({
    role: "reviewer",
    judgeId: "j10",
    verdict: "READY",
    modelSpec: "onekey/gpt-6-astra:xhigh",
  });
  // WHICH MODEL RAN: the launch slot is printed too — an event list alone does
  // not say where the round STARTED, and a round with no failure has only this.
  assert.match(withModel, /- 本轮模型：onekey\/gpt-6-astra:xhigh（派发时选的槽）/);
});

test("buildStandardReport: a finished round outranks its reason for the NEXT STEP", async () => {
  // A report can arrive with findings in the same wake-up. Once the round has
  // ended, "go confirm these findings" is the wrong instruction — the verdict
  // decides what happens next.
  const ready = buildStandardReport({
    role: "reviewer",
    judgeId: "j8",
    reason: "report",
    verdict: "READY",
    newFindings: ["[Nit] docs/x.md — wording"],
  });
  assert.match(ready, /下一步：收尾/);
  assert.doesNotMatch(ready, /确实没别的活了再调 judge_wait/, "a finished round never sends you back to waiting");
  assert.match(ready, /\[Nit\] docs\/x\.md — wording/, "…while the evidence it carried still travels");
});

test("buildStandardReport: many findings are capped, and the cap is stated rather than silent", async () => {
  const many = Array.from({ length: STANDARD_REPORT_FINDINGS_MAX + 5 }, (_, i) => `[P2] f${i}`);
  const text = buildStandardReport({ role: "reviewer", judgeId: "j9", reason: "finding", newFindings: many });
  assert.match(text, new RegExp(`新 findings（${many.length} 条，下面列最新 ${STANDARD_REPORT_FINDINGS_MAX} 条）`));
  assert.ok(text.includes(`[P2] f${many.length - 1}`), "the NEWEST findings are the ones shown");
  assert.ok(!text.includes("[P2] f0\n"), "…and the oldest are dropped, not silently truncated mid-list");
});

