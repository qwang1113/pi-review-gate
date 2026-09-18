import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGateWidget, showsRoundReading } from "../lib/ui-widget.ts";

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

test("buildGateWidget falls back to the uninitialized label for an unset mode", () => {
  const lines = buildGateWidget({
    edited: true,
    unmet: [],
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^门禁 · mode 未初始化 · 已编辑$/);
});

test("buildGateWidget shows the non-git strip and no branch outside a repository", () => {
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
// Round reading (2026-09-17, user decision): how many rounds THIS session
// SENT OUT — `轮 N`, no denominator, and only in reviewing sessions.

test("buildGateWidget shows the rounds sent, before the unmet count", () => {
  const lines = buildGateWidget({
    mode: "loop",
    branch: "feat/x",
    edited: true,
    rounds: 3,
    unmet: ["code review gate is PENDING (need READY)"],
  });
  assert.equal(lines.length, 1, "the strip stays exactly one line");
  assert.match(lines[0]!, /^门禁 · mode loop · feat\/x · 已编辑 · 轮 3 · 1 项未满足$/);
});

test("buildGateWidget shows round 0 before the first submission — in a loop session the reading is always on, not conditional", () => {
  // The zero is informative: it says "nothing has been sent yet", which is
  // exactly what a reader wants at the start of a session — and it stops being
  // 0 the moment a round is submitted, which is the whole point of counting
  // submissions rather than recorded verdicts.
  const lines = buildGateWidget({ mode: "loop", branch: "feat/x", edited: false, rounds: 0, unmet: [] });
  assert.match(lines[0]!, /^门禁 · mode loop · feat\/x · 未编辑 · 轮 0$/);
});

test("buildGateWidget never renders a denominator", () => {
  // The old ceiling was `maxRounds`, the auto-loop BRAKE — a different
  // quantity from the count, and one no reader could tell apart from a review
  // limit. The brake still bites exactly as before; it is just not on the
  // strip, so no numerator/denominator shape is left to misread.
  const lines = buildGateWidget({ mode: "loop", edited: false, rounds: 7, unmet: [] });
  assert.match(lines[0]!, /^门禁 · mode loop · 未编辑 · 轮 7$/);
  assert.doesNotMatch(lines[0]!, /\//);
});

test("buildGateWidget omits the reading entirely when the round count is unknown", () => {
  // Absent ≠ zero: an unknown count is a silence, never a claim that nothing
  // was sent. That is the judge pane whose task never named a round, and
  // every caller that passes no count at all.
  const lines = buildGateWidget({ mode: "loop", branch: "feat/x", edited: true, unmet: [] });
  assert.match(lines[0]!, /^门禁 · mode loop · feat\/x · 已编辑$/);
  assert.doesNotMatch(lines[0]!, /轮/);
});

test("buildGateWidget keeps the non-git strip free of the round reading", () => {
  // Outside a repository there is no review to count; the short-circuit
  // branch must stay byte-identical to what it was.
  const lines = buildGateWidget({ mode: "loop", nonGit: true, edited: false, rounds: 7, unmet: [] });
  assert.match(lines[0]!, /^门禁 · 非 git 目录 · 未编辑$/);
  assert.doesNotMatch(lines[0]!, /轮/);
});

test("showsRoundReading: only reviewing sessions — a judge pane, or a loop session", () => {
  // 2026-09-17, user decision: an orchestrator never reviews (its children
  // do), and explore / normal send nothing to review — a permanent `轮 0`
  // there is noise a reader has to learn to ignore.
  assert.equal(showsRoundReading({ judge: true }), true, "a judge pane counts its own rounds");
  assert.equal(showsRoundReading({ mode: "loop" }), true, "a loop session counts its own submissions");
  assert.equal(showsRoundReading({ mode: "orchestrator" }), false);
  assert.equal(showsRoundReading({ mode: "explore" }), false);
  assert.equal(showsRoundReading({ mode: "normal" }), false);
  assert.equal(showsRoundReading({}), false, "an undecided mode is not a licence to show 轮 0");
  assert.equal(showsRoundReading({ mode: "orchestrator", judge: true }), true,
    "…but a judge pane is a judge pane whatever mode its state happens to hold");
});
