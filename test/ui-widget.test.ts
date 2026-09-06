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

// ---------------------------------------------------------------------------
// Round reading (2026-09-17, user decision A): `轮 N/M` on the same one line

test("buildGateWidget shows the review round and its ceiling, before the unmet count", () => {
  const lines = buildGateWidget({
    mode: "loop",
    branch: "feat/x",
    edited: true,
    rounds: 3,
    maxRounds: 25,
    unmet: ["code review gate is PENDING (need READY)"],
  });
  assert.equal(lines.length, 1, "the strip stays exactly one line");
  assert.match(lines[0]!, /^门禁 · mode loop · feat\/x · 已编辑 · 轮 3\/25 · 1 项未满足$/);
});

test("buildGateWidget shows round 0 before the first review — the reading is always on, not conditional", () => {
  // The zero is informative: it says "no round has been recorded yet",
  // which is exactly what a reader wants to know at the start of a session.
  const lines = buildGateWidget({ mode: "loop", branch: "feat/x", edited: false, rounds: 0, maxRounds: 25, unmet: [] });
  assert.match(lines[0]!, /^门禁 · mode loop · feat\/x · 未编辑 · 轮 0\/25$/);
});

test("buildGateWidget degrades to a bare count when the ceiling is unknown or nonsensical", () => {
  // No denominator is invented: an absent, zero or non-finite ceiling
  // renders the count alone rather than `轮 3/0` or `轮 3/NaN`.
  for (const maxRounds of [undefined, 0, Number.NaN]) {
    const lines = buildGateWidget({ mode: "loop", edited: false, rounds: 3, maxRounds, unmet: [] });
    assert.match(lines[0]!, /^门禁 · mode loop · 未编辑 · 轮 3$/, String(maxRounds));
  }
});

test("buildGateWidget omits the reading entirely when the round count is unknown", () => {
  // Absent ≠ zero: an unknown count is a silence, never a claim that no
  // round has run. (This is also the pre-existing shape, so every caller
  // that has not been taught the new facts keeps its old strip.)
  const lines = buildGateWidget({ mode: "loop", branch: "feat/x", edited: true, unmet: [] });
  assert.match(lines[0]!, /^门禁 · mode loop · feat\/x · 已编辑$/);
  assert.doesNotMatch(lines[0]!, /轮/);
});

test("buildGateWidget keeps the non-git strip free of the round reading", () => {
  // Outside a repository there is no review to count; the short-circuit
  // branch must stay byte-identical to what it was.
  const lines = buildGateWidget({ mode: "loop", nonGit: true, edited: false, rounds: 7, maxRounds: 25, unmet: [] });
  assert.match(lines[0]!, /^门禁 · 非 git 目录 · 未编辑$/);
  assert.doesNotMatch(lines[0]!, /轮/);
});
