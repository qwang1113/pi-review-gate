/**
 * The judge side is a reporting shell: env identity, channel binding, and
 * the deny set. (Report building moved to judge_conclude — a round ends
 * through that tool, never through a scraped fence.)
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  type ChannelIO,
} from "../lib/orchestrator-channel.ts";
import {
  gateStatePersistSkip,
  judgeDeniedReason,
  judgeSideBinding,
  readJudgeSideEnv,
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

test("a judge writes NO gate state; a normal session persists as before", () => {
  // Measured 2026-09-05: the judge pane has no RG_STATE_VARIANT, so its gate
  // wrote the OPENER's sidecar — sessionId became rg-reviewer-…, taskMode fell
  // from orchestrator to none.
  const skip = gateStatePersistSkip({
    RG_JUDGE_OPENER: "session-child-1",
    RG_JUDGE_ID: "rg-reviewer-abc",
    RG_JUDGE_ROLE: "reviewer",
  });
  assert.ok(skip, "a judge pane must be barred from the repo's gate state");
  assert.equal(skip.judgeId, "rg-reviewer-abc");
  assert.equal(skip.role, "reviewer");
  assert.match(skip.reason, /rg-reviewer-abc/, "the record names WHICH review skipped");
  assert.match(skip.reason, /sidecar/, "…and what it declined to write");

  // The other direction matters just as much: this must not quietly disarm
  // persistence for ordinary sessions.
  assert.equal(gateStatePersistSkip({}), undefined, "a normal session persists");
  assert.equal(gateStatePersistSkip({ RG_STATE_VARIANT: "child-7" }), undefined,
    "an orchestration child has its OWN sidecar and keeps writing it");
  assert.equal(gateStatePersistSkip({ RG_JUDGE_ID: "rg-reviewer-abc" }), undefined,
    "half an identity is not a judge (same rule readJudgeSideEnv applies)");
});

test("a judge pane cannot run outward tools, but it can always ask — and conclude", () => {
  for (const tool of ["judge_submit", "judge_spawn", "judge_wait", "orchestrator_spawn", "propose_loop_goal", "declare_done", "set_gate_mode"]) {
    assert.match(judgeDeniedReason(tool) ?? "", /review 会话里不可用/, `${tool} is refused in a judge pane`);
  }
  assert.equal(judgeDeniedReason("ask_user"), undefined, "questions race through the channel");
  assert.equal(judgeDeniedReason("bash"), undefined, "reviewing by doing stays available");
  assert.equal(judgeDeniedReason("judge_conclude"), undefined, "concluding its own round is the judge's own job");
  assert.equal(judgeDeniedReason("request_arbitration"), undefined,
    "the inspection gate's own appeal route must be reachable from inside the pane");
});
