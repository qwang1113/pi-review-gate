import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildContractLines,
  buildContractReadout,
  buildGateWidget,
  planContractRows,
  showsRoundReading,
} from "../lib/ui-widget.ts";

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

// ---------------------------------------------------------------------------
// The contract list, shown ON DEMAND by `/gate-contract` (2026-09-18): plan
// rows for a project manager, goal-criterion rows for a loop session. No theme
// argument and no width: the surface is a `notify` block, which takes one color
// for the whole message and wraps by itself.
// ---------------------------------------------------------------------------

test("buildContractLines shows plan tasks in the plan's own four states", () => {
  assert.deepEqual(
    buildContractLines({
      kind: "plan",
      rows: [
        { text: "t1 建索引", state: "pending" },
        { text: "t2 回填", state: "running" },
        { text: "t3 报告", state: "blocked", waitingOn: ["t2"] },
        { text: "t4 文档", state: "done" },
      ],
    }),
    [
      "plan · 4 项 · 1 完成",
      "○ t1 建索引",
      "▸ t2 回填",
      "✕ t3 报告 · 等 t2",
      "✓ t4 文档",
    ],
  );
});

test("buildContractLines names EVERY unfinished dependency of a blocked task, not just the first", () => {
  const lines = buildContractLines({
    kind: "plan",
    rows: [{ text: "t5 收尾", state: "blocked", waitingOn: ["t1", "t4"] }],
  });
  assert.equal(lines[1], "✕ t5 收尾 · 等 t1 t4");
});

test("buildContractLines keeps every goal row pending: it reports the contract, never progress", () => {
  const lines = buildContractLines({
    kind: "goal",
    // A `done` row is what a caller COULD pass for a criterion it believes is
    // met; the builder must not turn that into a tick, so goal rows are `○`
    // whatever the state says — the only truth here is "the user asked for this".
    rows: [{ text: "一条标准", state: "pending" }, { text: "另一条", state: "done" }],
  });
  assert.deepEqual(lines, ["loop goal · 退出标准", "○ 一条标准", "○ 另一条"]);
});

test("buildContractLines prints the contract verbatim: colon, paths, code spans, length", () => {
  const long =
    "**条目来源**是 goal 文件原文，不是 `LoopGoal.text` —— 详见 docs/execution-model.md §「并行三方与取消矩阵」。";
  const lines = buildContractLines({ kind: "goal", rows: [{ text: long, state: "pending" }] });
  const row = lines[1]!;
  assert.ok(row.includes("原文，不是") && row.includes("docs/execution-model.md"), "nothing is cut");
  assert.ok(row.includes("——") && row.includes("。"), "and nothing is reworded or reordered");
  // The one mechanical edit: `**` is markdown the terminal cannot render.
  assert.ok(!row.includes("**"), row);
  assert.ok(row.startsWith("○ "), "the glyph and the text are all else on the line");
});

test("buildContractLines lists EVERY row it is given — no fold, no budget", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ text: `c${i + 1}`, state: "pending" as const }));
  const lines = buildContractLines({ kind: "goal", rows });
  assert.equal(lines.length, 41, "header + all 40 criteria");
  assert.ok(!lines.some((l) => l.includes("还有")), "nothing is hidden behind a fold");
});

test("buildContractLines renders nothing for every case that owns no contract", () => {
  // Each of these is what the extension hands in for a real situation; the
  // builder has ONE empty path, and the command turns it into a reason.
  const empty = (facts: Parameters<typeof buildContractLines>[0]) =>
    assert.deepEqual(buildContractLines(facts), []);
  empty({ rows: [] });                     // goal unapproved, or edited after approval
  empty({ kind: "plan", rows: [] });       // no plan file / unreadable JSON / archived plan
  empty({ kind: undefined, rows: [] });    // judge pane, explore/normal/undecided, non-git directory
  empty({ kind: "goal", rows: [{ text: "  ", state: "pending" }] }, );
});

test("planContractRows names only the dependencies still open, and nothing without a plan", () => {
  const rows = planContractRows([
    { id: "t1", title: "甲", status: "done", dependsOn: [] },
    { id: "t2", title: "乙", status: "blocked", dependsOn: ["t1", "t3"] },
    { id: "t3", title: "丙", status: "pending", dependsOn: [] },
  ]);
  assert.deepEqual(rows.map((r) => [r.text, r.state, r.waitingOn]), [
    ["t1 甲", "done", []],
    ["t2 乙", "blocked", ["t3"]],
    ["t3 丙", "pending", []],
  ]);
  assert.deepEqual(planContractRows(undefined), [], "no plan (absent, corrupt, archived) is no rows");
  assert.deepEqual(planContractRows([]), []);
});

test("a whitespace-only row is not a contract row, and a real row is not dropped by it", () => {
  // A blank line under 退出标准 must not reach the screen as a bare `○ `.
  assert.deepEqual(
    buildContractLines({ kind: "goal", rows: [{ text: "  ", state: "pending" }] }),
    [],
  );
  assert.equal(
    buildContractLines({
      kind: "goal",
      rows: [{ text: "空白", state: "pending" }, { text: "\t ", state: "pending" }],
    }).length,
    2,
    "header + the one real row",
  );
});

test("buildContractReadout: an empty list ALWAYS carries a reason", () => {
  // Reviewer P2 (2026-09-19): the command falls back to «本会话不持有一份
  // plan/goal 契约» for an unexplained empty list, which is TRUE of a session
  // that owns no contract and false of one whose contract rendered to nothing.
  const shown = buildContractReadout(
    { kind: "goal", rows: [{ text: "第一条", state: "pending" }] },
    "不该出现的理由",
  );
  assert.deepEqual(shown.lines, ["loop goal · 退出标准", "○ 第一条"]);
  assert.equal(shown.absent, undefined, "lines beat any reason");

  const explained = buildContractReadout({ rows: [] }, "goal 还是一份草稿");
  assert.deepEqual(explained.lines, []);
  assert.equal(explained.absent, "goal 还是一份草稿", "the caller's reason travels through");

  const blank = buildContractReadout({ kind: "goal", rows: [{ text: "   ", state: "pending" }] }, undefined);
  assert.deepEqual(blank.lines, [], "every row was blank, so the renderer dropped them all");
  assert.match(blank.absent ?? "", /空白/, "and the empty list is never handed over unexplained");
});
