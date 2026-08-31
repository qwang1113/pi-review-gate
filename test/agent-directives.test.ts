import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentDirectives,
  EXPLORE_MODE_NOTE,
} from "../lib/agent-directives.ts";

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
