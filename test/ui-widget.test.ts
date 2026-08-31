import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGateWidget } from "../lib/ui-widget.ts";

test("buildGateWidget renders a single-line strip: mode · branch · edited + unmet count", () => {
  const lines = buildGateWidget({
    mode: "loop",
    branch: "feat/x",
    edited: true,
    unmet: ["code review gate is PENDING (need READY)", "precommit has not run"],
  });
  assert.equal(lines.length, 1, "the strip is exactly one line");
  assert.match(lines[0]!, /^门禁 · mode loop · feat\/x · 已编辑 · 2 项未满足$/);
});

test("buildGateWidget hides the unmet count when zero", () => {
  const lines = buildGateWidget({
    mode: "explore",
    edited: false,
    unmet: [],
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^门禁 · mode explore · 未编辑$/);
});

test("buildGateWidget falls back to 未知 for an unknown mode", () => {
  const lines = buildGateWidget({
    edited: true,
    unmet: [],
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^门禁 · mode 未知 · 已编辑$/);
});
