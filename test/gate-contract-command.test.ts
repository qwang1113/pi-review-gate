import { test } from "node:test";
import assert from "node:assert/strict";

import { gateContractHandler } from "../lib/gate-command-tools.ts";

// `/gate-contract` (2026-09-18, user decision: 「不常驻展示, 而是通过某个命令」).
// These cases cover the HANDLER, which is where the command's behaviour lives:
// what it prints, what it prints when there is nothing to print, and what it
// does when there is no terminal. Where the lines themselves come from is
// `test/ui-widget.test.ts` (`buildContractLines`) and `test/loop-goal.test.ts`
// (`parseGoalCriteria`); the extension has no branch left that is not one of
// these three outcomes.

/** The one dep the handler reads, plus a notify that records what it got. */
function harness(readout: { lines: string[]; absent?: string }, hasUI?: boolean) {
  const notices: Array<{ text: string; type?: string }> = [];
  const ctx = { hasUI, ui: { notify: (text: string, type?: string) => void notices.push({ text, type }) } };
  return { run: () => gateContractHandler({ contract: () => readout })(ctx), notices };
}

test("a session that owns a contract gets its lines, unchanged and in order", () => {
  const h = harness({ lines: ["loop goal · 退出标准", "○ 第一条标准", "○ 第二条标准"] }, true);
  h.run();
  assert.equal(h.notices.length, 1, "exactly one block");
  assert.equal(h.notices[0]!.text, "loop goal · 退出标准\n○ 第一条标准\n○ 第二条标准");
  assert.equal(h.notices[0]!.type, "info");
});

test("no contract says so AND says why — the reason is the actionable half", () => {
  // Five different situations collapse to the same empty list, so without the
  // reason a reader cannot tell an unapproved goal from a broken command.
  const h = harness({ lines: [], absent: "goal 还是一份草稿：用户没批准过这段文本" }, true);
  h.run();
  assert.match(h.notices[0]!.text, /^review-gate: 这里没有可显示的契约 —— goal 还是一份草稿/);
  assert.equal(h.notices[0]!.type, "warning", "nothing to show is a cue, not a normal answer");
});

test("a readout with no reason still names itself rather than printing a bare nothing", () => {
  // The belt: `contractReadout()` answers for every empty case, so reaching
  // this line means a new one was added without saying why.
  const h = harness({ lines: [] }, true);
  h.run();
  assert.match(h.notices[0]!.text, /^review-gate: 这里没有可显示的契约 —— 本会话不持有一份 plan\/goal 契约$/);
});

test("no terminal means no output and no exception (print / JSON / RPC-less hosts)", () => {
  // `notify` is a no-op on those hosts anyway; the guard makes the behaviour a
  // stated fact of this command rather than something inherited from the host.
  for (const hasUI of [false, undefined] as const) {
    const h = harness({ lines: ["○ 一条"] }, hasUI);
    assert.doesNotThrow(h.run, `hasUI=${String(hasUI)} must not throw`);
    assert.equal(h.notices.length, hasUI === false ? 0 : 1, "hasUI:false prints nothing");
  }
});
