import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeWorkDirFor,
  hasJudgeFence,
  clampWaitTimeout,
  adjudicateGoalAudit,
  isBlockingSeverity,
  JUDGE_WAIT_MAX_TIMEOUT_MS,
  JUDGE_WAIT_DEFAULT_TIMEOUT_MS,
  WAIT_DISCIPLINE_HINT,
} from "../lib/judge-lifecycle.ts";

// ---- B5: the work dir is a function of role+repo, never of the round ----

test("judgeWorkDirFor is stable across rounds for the same role and repo", () => {
  const first = judgeWorkDirFor("goal-auditor", "f3eb4277");
  const second = judgeWorkDirFor("goal-auditor", "f3eb4277");
  assert.equal(first, second);
  assert.equal(first, ".pi/judge-sessions/goal-auditor-f3eb4277");
});

test("judgeWorkDirFor separates roles and repos", () => {
  assert.notEqual(judgeWorkDirFor("reviewer", "abc"), judgeWorkDirFor("adviser", "abc"));
  assert.notEqual(judgeWorkDirFor("reviewer", "abc"), judgeWorkDirFor("reviewer", "def"));
});

test("judgeWorkDirFor refuses path traversal in its inputs", () => {
  const dir = judgeWorkDirFor("../../etc", "../passwd");
  assert.ok(!dir.includes(".."), dir);
  assert.equal(dir, ".pi/judge-sessions/------etc----passwd");
});

// (Per-round run dirs are gone with the pane migration: the pane is the
// carrier, the session id the only identity. Round-end criteria now live in
// probeJudgeRound (lib/judge-session-tools.ts), covered there.)

test("the fence criterion reads plain stdout, not the escaped transcript form", () => {
  // The measured bug: inside the session jsonl the fence is escaped, so the
  // literal `"gate":"READY"` bytes never appear. Escaped text must NOT count.
  assert.equal(hasJudgeFence('{"text":"```json\\n{\\"gate\\":\\"READY\\"}"}'), false);
  assert.equal(hasJudgeFence('{"gate": "BLOCKED"}'), true);
  assert.equal(hasJudgeFence(""), false);
});

test("clampWaitTimeout defaults and caps", () => {
  assert.equal(clampWaitTimeout(undefined), JUDGE_WAIT_DEFAULT_TIMEOUT_MS);
  assert.equal(clampWaitTimeout(0), JUDGE_WAIT_DEFAULT_TIMEOUT_MS);
  assert.equal(clampWaitTimeout(-5), JUDGE_WAIT_DEFAULT_TIMEOUT_MS);
  assert.equal(clampWaitTimeout(Number.NaN), JUDGE_WAIT_DEFAULT_TIMEOUT_MS);
  assert.equal(clampWaitTimeout(1000), 1000);
  assert.equal(clampWaitTimeout(60 * 60 * 1000), JUDGE_WAIT_MAX_TIMEOUT_MS);
});

// ---- B2: only P0/P1 block a goal audit ----

test("READY with only P2 findings is a PASS and says re-auditing is forbidden", () => {
  const result = adjudicateGoalAudit({
    verdict: "READY",
    findings: [{ severity: "P2", issue: "wording" }, { severity: "Nit", issue: "typo" }],
    round: 2,
  });
  assert.equal(result.pass, true);
  assert.equal(result.blocking.length, 0);
  assert.equal(result.nonBlocking.length, 2);
  assert.match(result.message, /PASS/);
  assert.match(result.message, /第 2 轮审计/);
  assert.match(result.message, /禁止仅因非阻塞 findings 再审一轮/);
});

test("READY with an open P1 does not pass", () => {
  const result = adjudicateGoalAudit({
    verdict: "READY",
    findings: [{ severity: "P1", issue: "criterion is not falsifiable" }],
    round: 1,
  });
  assert.equal(result.pass, false);
  assert.equal(result.blocking.length, 1);
  assert.match(result.message, /BLOCKED/);
});

test("a BLOCKED verdict never passes, however empty its findings", () => {
  const result = adjudicateGoalAudit({ verdict: "BLOCKED", findings: [], round: 1 });
  assert.equal(result.pass, false);
});

test("NEEDS_HUMAN never passes", () => {
  assert.equal(adjudicateGoalAudit({ verdict: "NEEDS_HUMAN", findings: [], round: 1 }).pass, false);
});

// (Round deliver-or-refuse is gone with the pane migration: a living pane
// takes every round through its channel — refuse-busy belonged to the
// one-shot process that read its task once.)

test("the round number is shown and never drops below 1", () => {
  assert.match(adjudicateGoalAudit({ verdict: "READY", findings: [], round: 0 }).message, /第 1 轮审计/);
});

test("severity classification covers the forms judges actually write", () => {
  assert.equal(isBlockingSeverity("P0"), true);
  assert.equal(isBlockingSeverity(" p1 "), true);
  assert.equal(isBlockingSeverity("P1 (blocking)"), true);
  assert.equal(isBlockingSeverity("P2"), false);
  assert.equal(isBlockingSeverity("Nit"), false);
  assert.equal(isBlockingSeverity("P10"), false);
  assert.equal(isBlockingSeverity(""), false);
});

// (The shared wait formatter is gone with the pane migration: replies are
// built where the criteria live now. The discipline hint survives — and no
// longer promises a wake that panes cannot send.)
test("the wait discipline names the report wake, not a wait tool", () => {
  assert.match(WAIT_DISCIPLINE_HINT, /等待纪律/);
  assert.match(WAIT_DISCIPLINE_HINT, /标准报告唤醒/);
  assert.doesNotMatch(WAIT_DISCIPLINE_HINT, /judge_wait/);
});
