import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentDirectives,
  buildWaitDiscipline,
  MINIMALISM_REMINDER,
  GATE_ANOMALY_PROTOCOL,
  BATCH_READ_DISCIPLINE,

  EXPLORE_MODE_NOTE,
  ORCHESTRATOR_WAIT_DISCIPLINE,
  WAIT_DISCIPLINE_HINT,
} from "../lib/agent-directives.ts";
import { JUDGE_COMMON_PROTOCOL } from "../lib/judge-prompt.ts";

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

// ---------------------------------------------------------------------------
// MINIMALISM REMINDER (2026-09-08). The write-time half of the doctrine: a
// nudge, never a block. The rules live in docs/coding-standards.md §5 — this
// block cites, never quotes (a second copy of the four checks here would
// drift, and the copy map is the record of how often that has happened).
// ---------------------------------------------------------------------------

test("the standing block carries the minimalism reminder (cite, never quote)", () => {
  const text = buildAgentDirectives();
  assert.ok(text.includes(MINIMALISM_REMINDER), "the reminder renders in the standing block");
  assert.ok(MINIMALISM_REMINDER.includes("docs/coding-standards.md"), "it cites the standards file");
  assert.ok(MINIMALISM_REMINDER.includes("§5"), "it cites the section, not the rules");
  assert.match(MINIMALISM_REMINDER, /只提醒、不阻塞/, "write-time is advisory by contract");
  assert.match(MINIMALISM_REMINDER, /送审说明/, "it tells the agent where a dependency justification goes");
  for (const rule of ["YAGNI", "复用优先", "能删就删", "新依赖须论证"]) {
    assert.ok(!MINIMALISM_REMINDER.includes(rule), `the four checks must not be quoted here (found: ${rule})`);
  }
});

test("the standing block carries the two-layer gate-anomaly protocol (2026-09-08)", () => {
  const text = buildAgentDirectives();
  assert.ok(text.includes(GATE_ANOMALY_PROTOCOL), "the protocol renders in the standing block");
  // Layer 1: retryable failures → fix and continue, never report (the user's
  // clarification: simple retryable errors must not interrupt flow).
  assert.match(GATE_ANOMALY_PROTOCOL, /可重试.*直接继续|①.*直接继续/, "retryable failures continue");
  assert.match(GATE_ANOMALY_PROTOCOL, /oldText 不匹配|参数校验/, "it names retryable shapes");
  // Layer 2: genuine anomalies (deadlock / blocking) → stop, report, no
  // self-diagnosis / workaround / blind retry.
  assert.ok(GATE_ANOMALY_PROTOCOL.includes("ask_user"), "reporting goes through ask_user");
  assert.match(GATE_ANOMALY_PROTOCOL, /同一方式.*拒绝|看不出还能怎么修/, "it defines the escalation test");
  assert.match(GATE_ANOMALY_PROTOCOL, /未命中本轮 report/, "the measured deadlock shape is named");
  assert.match(GATE_ANOMALY_PROTOCOL, /禁止自主探索|禁止自主诊断/, "self-diagnosis is prohibited at the anomaly layer");
  // The prohibitions must NOT cover the retryable layer (over-escalation is a
  // failure mode) — the "禁止" wording sits under the anomaly heading only.
  const anomalyOnly = GATE_ANOMALY_PROTOCOL.slice(GATE_ANOMALY_PROTOCOL.indexOf("②"));
  assert.match(anomalyOnly, /禁止/, "the prohibitions live under the anomaly layer");
  const retryLayer = GATE_ANOMALY_PROTOCOL.slice(0, GATE_ANOMALY_PROTOCOL.indexOf("②"));
  assert.doesNotMatch(retryLayer, /禁止/, "the retryable layer must not forbid anything");
  assert.match(retryLayer, /直接继续/, "…it says continue");
  assert.match(GATE_ANOMALY_PROTOCOL, /request_arbitration/, "the sanctioned appeal stays");
  assert.match(GATE_ANOMALY_PROTOCOL, /gate-doctor/, "diagnostics stay with the user's command");
});

// ---------------------------------------------------------------------------
// READING IN PARALLEL (2026-09-10). MEASURED across every reviewer session in
// this repo: 92.5% of assistant messages carried exactly ONE tool call (mean
// 1.08), each round took 17-59 model round-trips at 11-13s, and tool execution
// was 6% of the round — the time went to the number of MESSAGES, not to the
// reads. The main session is no better (85.3%, mean 1.16).
//
// One rule, two audiences — the agent block and the judge protocol. This pin
// is what keeps the two copies from becoming two different rules.
// ---------------------------------------------------------------------------

test("the batch-read rule is ONE wording, in the agent block and the judge protocol alike", () => {
  const shared = "**一条 assistant 消息里的多个工具调用是并行执行的**";
  assert.ok(BATCH_READ_DISCIPLINE.includes(shared), "the agent block states the rule");
  assert.ok(JUDGE_COMMON_PROTOCOL.includes(shared), "the judge protocol states the same sentence");
  for (const copy of [BATCH_READ_DISCIPLINE, JUDGE_COMMON_PROTOCOL]) {
    assert.match(copy, /92\.5%/, "the measurement travels with the rule — it is the reason to obey it");
    assert.match(copy, /17–59/, "…including how many round-trips a round actually took");
  }
  assert.match(BATCH_READ_DISCIPLINE, /一个工具调用就是一个完整来回/,
    "and WHY a single read costs one: one tool call is one full round-trip");
});

test("the agent block carries the batch-read rule into every session", () => {
  for (const mode of ["loop", "explore"] as const) {
    assert.ok(buildAgentDirectives(mode).includes(BATCH_READ_DISCIPLINE), `sent in ${mode} mode`);
  }
  assert.ok(buildAgentDirectives().includes(BATCH_READ_DISCIPLINE), "and with no mode at all");
});

test("the judge protocol points at the index the gate pre-builds", () => {
  // The rule alone would still leave the reviewer deciding what to read. The
  // gate ships a pre-split batch plan by the same name (lib/parallel-review.ts
  // formatChangeIndex), and the protocol must name it — otherwise the two
  // halves of the same fix would not meet.
  assert.match(JUDGE_COMMON_PROTOCOL, /CHANGE INDEX/,
    "the protocol names the block the task text carries");
  assert.match(JUDGE_COMMON_PROTOCOL, /最大的文件优先/,
    "…and the property that makes it usable (largest first)");
});
