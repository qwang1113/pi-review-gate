import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGateWidget, buildModelConfigWidget, relativeAge, unmetTag } from "../lib/ui-widget.ts";

test("buildModelConfigWidget renders one line per entry with spec · auto state · source", () => {
  const lines = buildModelConfigWidget([
    { name: "reviewer", spec: "onekey/gpt-5.6-sol:high", auto: false, source: "project" },
    { name: "adviser", spec: "claude-fable-5:max", auto: true, source: "default" },
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^model reviewer: onekey\/gpt-5\.6-sol:high  \[auto OFF · project\]$/);
  assert.match(lines[1]!, /^model adviser: claude-fable-5:max  \[auto on · default\]$/);
});

test("buildModelConfigWidget maps every auto state and source label deterministically", () => {
  const states = [
    { auto: false, source: "project" as const, expect: "auto OFF · project" },
    { auto: false, source: "global" as const, expect: "auto OFF · global" },
    { auto: true, source: "global" as const, expect: "auto on · global" },
    { auto: true, source: "default" as const, expect: "auto on · default" },
  ];
  for (const { auto, source, expect } of states) {
    const [line] = buildModelConfigWidget([{ name: "reviewer", spec: "claude-fable-5", auto, source }]);
    assert.ok(line!.includes(`[${expect}]`), `${auto}/${source} should render [${expect}]`);
  }
});


test("buildGateWidget renders workspace/branch, verdicts, unmet — a status panel", () => {
  const lines = buildGateWidget({
    mode: "loop",
    baseBranch: "main",
    workBranch: "feat/x",
    dirtyCount: 3,
    edited: true,
    review: "PENDING",
    rounds: 2,
    precommit: "NOT_RUN",
    goalApproved: true,
    copilotOpen: false,
    unmet: ["code review gate is PENDING (need READY)", "precommit has not run"],
  });
  assert.ok(lines.length >= 3, "panel has at least workspace + verdicts + unmet");
  assert.match(lines[0]!, /门禁 · mode loop · base main · work feat\/x · 脏 3 · 已编辑/);
  assert.match(lines[1]!, /审核 待审核 · 第 2 轮 \| precommit 未运行 \| goal 已批准 \| copilot 关/);
  assert.match(lines[2]!, /⚠ review: code review gate is PENDING/);
  assert.match(lines[3]!, /⚠ precommit: precommit has not run/);
});

test("buildGateWidget caps unmet at three and folds the rest", () => {
  const lines = buildGateWidget({
    mode: "explore",
    edited: false,
    review: "BLOCKED",
    rounds: 1,
    precommit: "PASS",
    precommitFast: true,
    precommitAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    goalApproved: false,
    copilotOpen: true,
    unmet: ["a", "b", "c", "d", "e"],
  });
  assert.equal(lines.filter((l) => l.startsWith("  ⚠")).length, 3);
  assert.match(lines.join("\n"), /另有 2 项未满足/);
  assert.match(lines.join("\n"), /precommit 通过（fast） · 5m 前/);
});

test("relativeAge renders compact time buckets", () => {
  const now = Date.parse("2026-08-31T01:00:00Z");
  assert.equal(relativeAge(undefined, now), "");
  assert.equal(relativeAge("2026-08-31T00:59:30Z", now), "30s", "sub-minute shows seconds");
  assert.equal(relativeAge("2026-08-31T00:55:00Z", now), "5m");
  assert.equal(relativeAge("2026-08-31T00:00:00Z", now), "60m", "an hour is under the 90-minute minute bucket");
  assert.equal(relativeAge("2026-08-29T00:00:00Z", now), "2d", "two days shows days");
});

test("unmetTag maps requirement lines to short canonical tags", () => {
  assert.equal(unmetTag("code review gate is PENDING (need READY)"), "review");
  assert.equal(unmetTag("precommit has not run"), "precommit");
  assert.equal(unmetTag("loop goal is unconfirmed"), "goal");
  assert.equal(unmetTag("Copilot review is open"), "copilot");
  assert.equal(unmetTag("something unheard of"), "?");
});
