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

test("a judge pane cannot run outward tools, but it can always ask — and conclude", () => {
  for (const tool of ["judge_submit", "judge_spawn", "judge_wait", "orchestrator_spawn", "propose_loop_goal", "declare_done", "set_gate_mode", "request_arbitration"]) {
    assert.match(judgeDeniedReason(tool) ?? "", /review 会话里不可用/, `${tool} is refused in a judge pane`);
  }
  assert.equal(judgeDeniedReason("ask_user"), undefined, "questions race through the channel");
  assert.equal(judgeDeniedReason("bash"), undefined, "reviewing by doing stays available");
  assert.equal(judgeDeniedReason("judge_conclude"), undefined, "concluding its own round is the judge's own job");
});
