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

test("buildGateWidget falls back to 未初始化 for an unset mode", () => {
  const lines = buildGateWidget({
    edited: true,
    unmet: [],
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^门禁 · mode 未初始化 · 已编辑$/);
});

test("buildGateWidget shows 非 git 目录 and no branch outside a repository", () => {
  // 2026-09-02 (user decision): outside a git repository the strip leads
  // with 非 git 目录 — mode and branch are both meaningless there, and
  // rendering them would require git calls that leak fatal noise.
  const lines = buildGateWidget({
    mode: "normal",
    nonGit: true,
    branch: undefined,
    edited: false,
    unmet: [],
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^门禁 · 非 git 目录 · 未编辑$/);
  assert.doesNotMatch(lines[0]!, /mode|branch/);
});
