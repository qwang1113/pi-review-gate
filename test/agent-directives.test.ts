import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentDirectives,
  buildWaitDiscipline,

  EXPLORE_MODE_NOTE,
  ORCHESTRATOR_WAIT_DISCIPLINE,
  WAIT_DISCIPLINE_HINT,
} from "../lib/agent-directives.ts";

// ---------------------------------------------------------------------------
// The WAIT DISCIPLINE (2026-09-05). One wording, two waiters: the loop session
// waits on its judge, the project manager on its children. What it replaced
// was a self-contradiction — "never end the turn to be woken" with no waiting
// tool on the agent surface — which cost a measured nine minutes inside a bash
// sleep while a finished review sat unrecorded.
// ---------------------------------------------------------------------------

test("the discipline is the three sentences, and names a tool that EXISTS", () => {
  assert.match(WAIT_DISCIPLINE_HINT, /等待纪律/);
  // ① do the deterministic work you have — including the soft half the user
  // insisted on: after a submission there is often nothing left, and the gate
  // SUGGESTS rather than demands.
  assert.match(WAIT_DISCIPLINE_HINT, /有确定性工作/);
  assert.match(WAIT_DISCIPLINE_HINT, /下一轮要什么|收尾报告/);
  assert.match(WAIT_DISCIPLINE_HINT, /不强求/);
  // ② wait through the tool — not a sleep loop, and not by ending the turn.
  assert.match(WAIT_DISCIPLINE_HINT, /judge_wait/);
  assert.match(WAIT_DISCIPLINE_HINT, /sleep/);
  assert.match(WAIT_DISCIPLINE_HINT, /也不是结束 turn/);
  // ③ message-driven: the first message returns.
  assert.match(WAIT_DISCIPLINE_HINT, /消息驱动/);
  assert.match(WAIT_DISCIPLINE_HINT, /任一到达即返回/);
  // The self-contradiction that caused the lock is gone.
  assert.doesNotMatch(WAIT_DISCIPLINE_HINT, /禁止.*结束 turn|没有轮询工具/);
});

test("the project manager gets the SAME three sentences, its own tool, and its own clause", () => {
  // C2 (user correction): the orchestrator wording is not the child's wording.
  // "Do not hand the watch back to the user" is the failure mode this role has
  // actually shown, and it must survive the unification verbatim in meaning.
  assert.match(ORCHESTRATOR_WAIT_DISCIPLINE, /有确定性工作/);
  assert.match(ORCHESTRATOR_WAIT_DISCIPLINE, /不强求/);
  assert.match(ORCHESTRATOR_WAIT_DISCIPLINE, /orchestrator_wait/);
  assert.doesNotMatch(ORCHESTRATOR_WAIT_DISCIPLINE, /judge_wait/, "the PM has no judge of its own to wait for");
  assert.match(ORCHESTRATOR_WAIT_DISCIPLINE, /盯梢责任丢回给用户/, "the supervision clause is preserved");
  assert.match(ORCHESTRATOR_WAIT_DISCIPLINE, /消息驱动/);
  assert.match(ORCHESTRATOR_WAIT_DISCIPLINE, /子会话提问/);
});

test("both renderings come from ONE builder — no second copy of the wording", () => {
  assert.equal(WAIT_DISCIPLINE_HINT, buildWaitDiscipline("judge_wait"));
  assert.equal(ORCHESTRATOR_WAIT_DISCIPLINE, buildWaitDiscipline("orchestrator_wait"));
  // The invariant part is literally identical across the two renderings.
  const shared = "①有确定性工作（代码/测试/文档/其他 repo 事务）就先做掉";
  assert.ok(WAIT_DISCIPLINE_HINT.includes(shared) && ORCHESTRATOR_WAIT_DISCIPLINE.includes(shared));
});

test("the decision table sends an agent with NOTHING to do to judge_wait", () => {
  const text = buildAgentDirectives();
  assert.match(text, /确实没活可做 \| `judge_wait\(\{role\}\)`/, "the row names the tool it must call");
  assert.match(text, /还有活可做 \| 先把活做掉/, "…and the row before it keeps work ahead of waiting");
});




// ---------------------------------------------------------------------------
// buildAgentDirectives — the standing situation→tool block (2026-08-31: mode
// parameter pins the explore-mode extra guidance; the structure test pins the
// call sites, this file pins the CONTENT the explore branch renders).
// ---------------------------------------------------------------------------

test("buildAgentDirectives() without a mode renders the standing block only", () => {
  const text = buildAgentDirectives();
  assert.ok(text.includes("情况 → 工具"), "decision table header");
  assert.ok(text.includes("judge_submit"), "decision table row");
  assert.ok(!text.includes("explore"), "no explore note in the loop rendering");
});

test("buildAgentDirectives('explore') appends the explore-mode guidance", () => {
  const text = buildAgentDirectives("explore");
  assert.ok(text.includes(EXPLORE_MODE_NOTE), "explore note is appended verbatim");
  assert.match(text, /先调用 `set_gate_mode\("loop"\)`/,
    "delivery escalation reminder (distinct from the decision-table token)");
  assert.match(text, /只有纯分析\/只读调查才留在 explore/,
    "explore stays the investigation mode");
  assert.ok(text.includes("升级到完整门禁循环"), "loop upgrade wording");
});

test("EXPLORE_MODE_NOTE carries the delivery-escalation reminder", () => {
  // The reminder is what an explore session receiving a fix request was
  // measured to skip (onchain session, 2026-08-31): escalate to loop before
  // editing.
  assert.match(EXPLORE_MODE_NOTE, /先调用 `set_gate_mode\("loop"\)`/,
    "delivery work must escalate to the full loop (distinct phrasing)");
  assert.match(EXPLORE_MODE_NOTE, /ship 命令/,
    "the note keeps the ship-gate reminder visible in explore");
});
