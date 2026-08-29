import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeWorkDirFor,
  judgeRunDirName,
  evaluateJudgeWait,
  hasJudgeFence,
  clampWaitTimeout,
  adjudicateGoalAudit,
  isBlockingSeverity,
  decideJudgeDispatch,
  JUDGE_WAIT_MAX_TIMEOUT_MS,
  JUDGE_WAIT_DEFAULT_TIMEOUT_MS,
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

test("judgeRunDirName varies per round and is filesystem-safe", () => {
  const at = new Date("2026-08-29T01:44:52.970Z");
  assert.equal(judgeRunDirName(at, "a1b2c3"), "2026-08-29T01-44-52-970Z-a1b2c3");
  assert.notEqual(judgeRunDirName(at, "a1b2c3"), judgeRunDirName(at, "d4e5f6"));
});

// ---- the three wait criteria ----

test("an exit-code file ends the wait", () => {
  assert.deepEqual(
    evaluateJudgeWait({ processAlive: true, exitCodeExists: true, stdoutTail: "" }),
    { done: true, reason: "exit-code" },
  );
});

test("a vanished process ends the wait even without an exit code", () => {
  assert.deepEqual(
    evaluateJudgeWait({ processAlive: false, exitCodeExists: false, stdoutTail: "" }),
    { done: true, reason: "process-gone" },
  );
});

test("a verdict fence in stdout ends the wait before the process exits", () => {
  const probe = { processAlive: true, exitCodeExists: false, stdoutTail: '```json\n{"gate":"READY","findings":[]}\n```' };
  assert.deepEqual(evaluateJudgeWait(probe), { done: true, reason: "fence" });
});

test("a question fence also ends the wait", () => {
  const probe = { processAlive: true, exitCodeExists: false, stdoutTail: '{"question":"which branch?","context":"…"}' };
  assert.deepEqual(evaluateJudgeWait(probe), { done: true, reason: "fence" });
});

test("a running judge with no fence keeps the wait open", () => {
  assert.deepEqual(
    evaluateJudgeWait({ processAlive: true, exitCodeExists: false, stdoutTail: "reading lib/gate-state.ts…" }),
    { done: false, reason: "pending" },
  );
});

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

// ---- a round is delivered or refused, never silently dropped ----

test("a running judge REFUSES the round — it cannot receive one mid-turn", () => {
  const decision = decideJudgeDispatch({ aliveSameRole: true, fresh: false, hasTranscript: true });
  assert.equal(decision.action, "refuse-busy");
});

test("fresh:true discards the incumbent and starts the round", () => {
  const decision = decideJudgeDispatch({ aliveSameRole: true, fresh: true, hasTranscript: true });
  assert.equal(decision.action, "kill-and-spawn");
});

test("no live process ⇒ spawn, and an existing transcript means the session continues", () => {
  assert.deepEqual(
    decideJudgeDispatch({ aliveSameRole: false, fresh: false, hasTranscript: true }),
    { action: "spawn", continuesSession: true },
  );
  assert.deepEqual(
    decideJudgeDispatch({ aliveSameRole: false, fresh: false, hasTranscript: false }),
    { action: "spawn", continuesSession: false },
  );
});

test("context reuse never depends on a live process", () => {
  // The bug this pins: 'reused' used to mean 'a process was still running',
  // which silently dropped the round it claimed to have accepted.
  for (const alive of [true, false]) {
    for (const fresh of [true, false]) {
      assert.equal(
        decideJudgeDispatch({ aliveSameRole: alive, fresh, hasTranscript: true }).continuesSession,
        true,
      );
    }
  }
});


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
