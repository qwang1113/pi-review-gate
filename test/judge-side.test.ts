/**
 * The judge side is a reporting shell: env identity, channel binding, and
 * one report per fenced verdict — never two for the same finish.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  appendRecord,
  projectChannel,
  reportText,
  type ChannelIO,
} from "../lib/orchestrator-channel.ts";
import {
  buildVerdictReport,
  judgeDeniedReason,
  judgeSideBinding,
  readJudgeSideEnv,
  verdictReportKey,
} from "../lib/judge-side.ts";

function memoryIO(): ChannelIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    ensureDir() {},
    appendLine(path, line) { files.set(path, (files.get(path) ?? "") + line); },
    readText(path) { return files.get(path); },
    writeText(path, text) { files.set(path, text); },
    now: () => 1_700_000_000_000,
  };
}

const READY_TAIL = [
  "## 结论",
  "- 修齐。",
  "",
  "```json",
  '{"gate":"READY","findings":[]}',
  "```",
].join("\n");

test("judge identity comes from the environment, or not at all", () => {
  assert.equal(readJudgeSideEnv({}), undefined);
  assert.equal(readJudgeSideEnv({ RG_JUDGE_ID: "j1" }), undefined, "no opener ⇒ not a judge");
  assert.equal(readJudgeSideEnv({ RG_JUDGE_OPENER: "o1" }), undefined, "no judge id ⇒ not a judge");
  assert.deepEqual(
    readJudgeSideEnv({ RG_JUDGE_OPENER: "o1", RG_JUDGE_ID: "j1", RG_JUDGE_ROLE: "reviewer" }),
    { openerId: "o1", judgeId: "j1", role: "reviewer" },
  );
});

test("the judge binding talks through the opener's file for its judge", () => {
  const io = memoryIO();
  const config = { openerId: "o1", judgeId: "j1", role: "reviewer" };
  const binding = judgeSideBinding(io, config, "sess-1");
  assert.equal(binding.target.orchestrationId, "o1");
  assert.equal(binding.target.childId, "j1");
  assert.equal(binding.sessionId, "sess-1");
});

test("a fenced verdict becomes exactly one report", () => {
  const built = buildVerdictReport({ transcriptTail: READY_TAIL, findingsCount: 0, now: 1_700_000_000_000 });
  assert.ok(built);
  assert.equal(built.verdict, "READY");
  assert.equal(built.findingsCount, 0);
  assert.ok(built.reportId.startsWith("rep-"));

  const io = memoryIO();
  const binding = judgeSideBinding(io, { openerId: "o1", judgeId: "j1", role: "reviewer" });
  const stored = appendRecord(io, binding.target, built);
  assert.equal(projectChannel([stored]).openRequests.length, 0);
  const projection = projectChannel([stored]);
  assert.equal(projection.lastReport?.verdict, "READY");
  assert.equal(reportText(io, projection.lastReport!), READY_TAIL);
});

test("no fence ⇒ no report", () => {
  assert.equal(
    buildVerdictReport({ transcriptTail: "还在看代码，没有结论。", now: 1_700_000_000_000 }),
    undefined,
  );
});

test("the report key folds verdict, count and size — same finish, one key", () => {
  const a = { verdict: "READY", findingsCount: 0, summary: "x".repeat(10) };
  const b = { verdict: "READY", findingsCount: 0, summary: "y".repeat(10) };
  const c = { verdict: "READY", findingsCount: 1, summary: "x".repeat(10) };
  assert.equal(verdictReportKey(a), verdictReportKey(b), "same shape ⇒ same key even if prose differs");
  assert.notEqual(verdictReportKey(a), verdictReportKey(c));
});

test("a judge pane cannot run outward tools, but it can always ask", () => {
  for (const tool of ["judge_submit", "judge_spawn", "judge_wait", "orchestrator_spawn", "propose_loop_goal", "declare_done", "set_gate_mode", "request_arbitration"]) {
    assert.match(judgeDeniedReason(tool) ?? "", /review 会话里不可用/, `${tool} is refused in a judge pane`);
  }
  assert.equal(judgeDeniedReason("ask_user"), undefined, "questions race through the channel");
  assert.equal(judgeDeniedReason("bash"), undefined, "reviewing by doing stays available");
});
