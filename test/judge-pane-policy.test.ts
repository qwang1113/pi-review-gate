/**
 * THE PANE-LIFECYCLE POLICY — one answer, pinned.
 *
 * There used to be TWO (the gate's own auditor died at round end, the agent's
 * review pane lived until `declare_done`), and this file pinned the split so a
 * refactor could not "tidy it up". The user settled the other way on
 * 2026-09-21: a recorded verdict is the deliverable, a pane is screen space,
 * and the next dispatch re-opens the SAME session id — so EVERY judge pane is
 * freed when its round is recorded.
 *
 * What is tested here is the DECISION and the audit line. That the decision is
 * acted upon lives in test/audit-round.test.ts (both execution points: the
 * gate's synchronous chains and the conclusion half that records an agent's
 * review), and that `declare_done`'s sweep is still source-blind — the
 * terminus for a pane whose round never concluded — lives in
 * test/extension-structure.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  JUDGE_PANE_RECLAIM,
  reclaimAuditLine,
  type JudgePaneReclaimOutcome,
} from "../lib/judge-pane-policy.ts";

const CLEAN: JudgePaneReclaimOutcome = { ok: true, hadPane: true, terminated: true };

test("every judge pane is reclaimed at ROUND END (2026-09-21, user decision)", () => {
  assert.equal(JUDGE_PANE_RECLAIM.at, "round-end");
  assert.equal(JUDGE_PANE_RECLAIM.atRoundEnd, true);
  // The reason has to be the one that makes closing a pane safe: the verdict is
  // already recorded, and the conversation is not lost with the pane.
  assert.match(JUDGE_PANE_RECLAIM.why, /同一 session id/);
});

test("the dispatcher no longer chooses a lifetime — the two-policy split is GONE", async () => {
  // A regression that reintroduced `judgePaneReclaim(dispatcher)` with two
  // branches would restore the rule the user replaced, and no assertion above
  // would notice. So the module is scanned for it.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(resolve(root, "lib/judge-pane-policy.ts"), "utf8");
  assert.doesNotMatch(src, /judgePaneReclaim\s*\(/, "the dispatcher lookup must not come back");
  assert.doesNotMatch(src, /declare-done/, "and neither must the policy it used to select");
  assert.match(src, /JUDGE_PANE_RECLAIM/, "the one policy is what callers read");
});

test("a reclaim that did what the policy promises says nothing", () => {
  assert.equal(reclaimAuditLine({ role: "goal-auditor", policy: JUDGE_PANE_RECLAIM, outcome: CLEAN }), undefined);
});

test("a pane that was never registered is silent too — nothing was leaked", () => {
  assert.equal(
    reclaimAuditLine({
      role: "goal-auditor",
      policy: JUDGE_PANE_RECLAIM,
      outcome: { ok: true, hadPane: false, terminated: false, note: "没有登记 pane，无需动手" },
    }),
    undefined,
  );
});

test("an unconfirmed kill is reported as UNCONFIRMED, not as a leak", () => {
  // A pane the user closed by hand lands here as well. The gate can honestly
  // say it did not see the pane go; it cannot say it leaked one.
  const line = reclaimAuditLine({
    role: "goal-auditor",
    policy: JUDGE_PANE_RECLAIM,
    outcome: { ok: true, hadPane: true, terminated: false, note: "关 pane 失败（no such pane），登记照样清除" },
  });
  assert.ok(line);
  assert.match(line, /回收未确认/);
  assert.match(line, /登记已清除/);
  assert.doesNotMatch(line, /回收失败/);
  assert.match(line, /goal-auditor/, "the role is named — a log line has to be greppable");
  assert.match(line, /同一 session id/, "…and it carries the policy it was executing");
  assert.match(line, /关 pane 失败/, "…and the closing tool's own words");
});

test("a close that failed outright says so, and warns that BOTH may remain", () => {
  const line = reclaimAuditLine({
    role: "reviewer",
    policy: JUDGE_PANE_RECLAIM,
    outcome: { ok: false, hadPane: true, terminated: false, note: "judge_close 被拒" },
  });
  assert.ok(line);
  assert.match(line, /回收失败/);
  assert.match(line, /登记与 pane 都可能残留/);
});

test("a failed close is loud even when no pane was registered", () => {
  // `ok: false` is about the operation, not about the pane: if the close did
  // not complete, what is left behind is unknown, and unknown is not silence.
  const line = reclaimAuditLine({
    role: "goal-auditor",
    policy: JUDGE_PANE_RECLAIM,
    outcome: { ok: false, hadPane: false, terminated: false },
  });
  assert.ok(line);
  assert.match(line, /回收失败/);
});

test("a missing or blank note leaves no dangling separator", () => {
  for (const note of [undefined, "", "   "]) {
    const line = reclaimAuditLine({
      role: "goal-auditor",
      policy: JUDGE_PANE_RECLAIM,
      outcome: { ok: false, hadPane: true, terminated: false, ...(note === undefined ? {} : { note }) },
    });
    assert.ok(line);
    assert.doesNotMatch(line, /：\s*$/, `a blank note must not leave a trailing colon: ${line}`);
  }
});

test("the module is pure — it names no filesystem, clock or process", async () => {
  // The policy has to be answerable in a unit test with no tmux and no repo;
  // an import that reached for one would make the rule untestable exactly
  // where it matters.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(resolve(root, "lib/judge-pane-policy.ts"), "utf8");
  assert.doesNotMatch(src, /^import /m, "no imports at all — the policy is a lookup");
  for (const forbidden of ["node:fs", "node:child_process", "Date.now(", "process."]) {
    assert.equal(src.includes(forbidden), false, `${forbidden} must not appear`);
  }
});
