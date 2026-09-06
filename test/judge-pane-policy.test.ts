/**
 * THE TWO PANE-LIFECYCLE POLICIES, pinned so the split cannot be "tidied up".
 *
 * The gate reclaims its OWN auditor when the round that opened it ends, and
 * leaves the agent's review pane alone until `declare_done`. The user settled
 * that on 2026-09-06 — keep both, do not unify — and until now it existed only
 * as prose scattered across three files, which is the state a refactor eats.
 *
 * What is tested here is the DECISION and the audit line. That the decision is
 * acted upon lives in test/audit-round.test.ts (the one execution point), and
 * that `declare_done`'s sweep is deliberately source-blind lives in
 * test/extension-structure.test.ts — see this module's docblock for why the
 * second policy is enforced by tool topology rather than by a branch.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  judgePaneReclaim,
  reclaimAuditLine,
  type JudgePaneReclaimOutcome,
} from "../lib/judge-pane-policy.ts";

const CLEAN: JudgePaneReclaimOutcome = { ok: true, hadPane: true, terminated: true };
const GATE = judgePaneReclaim("gate");

test("the gate's own auditor is reclaimed by the round that opened it", () => {
  assert.equal(GATE.at, "round-end");
  assert.equal(GATE.atRoundEnd, true);
  assert.match(GATE.why, /谁派谁收/);
});

test("the agent's review pane lives until declare_done", () => {
  const agent = judgePaneReclaim("agent");
  assert.equal(agent.at, "declare-done");
  assert.equal(agent.atRoundEnd, false);
  assert.match(agent.why, /declare_done/);
});

test("the two policies are genuinely different — that is the whole point", () => {
  // A regression that collapsed them into one answer would make every test
  // above pass individually while destroying the rule.
  assert.notEqual(GATE.at, judgePaneReclaim("agent").at);
  assert.notEqual(GATE.atRoundEnd, judgePaneReclaim("agent").atRoundEnd);
});

test("`atRoundEnd` agrees with `at` — no call site has to compare strings", () => {
  for (const dispatcher of ["gate", "agent"] as const) {
    const policy = judgePaneReclaim(dispatcher);
    assert.equal(policy.atRoundEnd, policy.at === "round-end", dispatcher);
  }
});

test("a reclaim that did what the policy promises says nothing", () => {
  assert.equal(reclaimAuditLine({ role: "goal-auditor", policy: GATE, outcome: CLEAN }), undefined);
});

test("a pane that was never registered is silent too — nothing was leaked", () => {
  assert.equal(
    reclaimAuditLine({
      role: "goal-auditor",
      policy: GATE,
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
    policy: GATE,
    outcome: { ok: true, hadPane: true, terminated: false, note: "关 pane 失败（no such pane），登记照样清除" },
  });
  assert.ok(line);
  assert.match(line, /回收未确认/);
  assert.match(line, /登记已清除/);
  assert.doesNotMatch(line, /回收失败/);
  assert.match(line, /goal-auditor/, "the role is named — a log line has to be greppable");
  assert.match(line, /谁派谁收/, "…and it carries the policy it was executing");
  assert.match(line, /关 pane 失败/, "…and the closing tool's own words");
});

test("a close that failed outright says so, and warns that BOTH may remain", () => {
  const line = reclaimAuditLine({
    role: "goal-auditor",
    policy: GATE,
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
    policy: GATE,
    outcome: { ok: false, hadPane: false, terminated: false },
  });
  assert.ok(line);
  assert.match(line, /回收失败/);
});

test("a missing or blank note leaves no dangling separator", () => {
  for (const note of [undefined, "", "   "]) {
    const line = reclaimAuditLine({
      role: "goal-auditor",
      policy: GATE,
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
