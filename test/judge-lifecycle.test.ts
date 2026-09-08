import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeWorkDirFor,
  isLegacyJudgeSessionDirName,
  isCurrentJudgeSessionDirName,
  selectStaleJudgeSessionDirs,
  JUDGE_SESSION_DIR_TTL_MS,

  awaitRoundReport,
  clampWaitTimeout,

  adjudicateGoalAudit,
  isBlockingSeverity,
  JUDGE_WAIT_MAX_TIMEOUT_MS,
  JUDGE_WAIT_DEFAULT_TIMEOUT_MS,

} from "../lib/judge-lifecycle.ts";


// ---- B5: the work dir is a function of role+repo+opener, never of the round ----

test("judgeWorkDirFor is stable across rounds for the same role, repo and opener", () => {
  const first = judgeWorkDirFor("goal-auditor", "f3eb4277", "opener-1");
  const second = judgeWorkDirFor("goal-auditor", "f3eb4277", "opener-1");
  assert.equal(first, second);
  assert.match(first, /^\.pi\/judge-sessions\/goal-auditor-f3eb4277-[0-9a-f]{8}$/);
});

test("judgeWorkDirFor separates roles, repos and openers", () => {
  assert.notEqual(judgeWorkDirFor("reviewer", "abc", "opener"), judgeWorkDirFor("adviser", "abc", "opener"));
  assert.notEqual(judgeWorkDirFor("reviewer", "abc", "opener"), judgeWorkDirFor("reviewer", "def", "opener"));
  assert.notEqual(judgeWorkDirFor("reviewer", "abc", "opener-1"), judgeWorkDirFor("reviewer", "abc", "opener-2"));
});

test("judgeWorkDirFor refuses path traversal in its inputs", () => {
  const dir = judgeWorkDirFor("../../etc", "../passwd", "../../evil");
  assert.ok(!dir.includes(".."), dir);
});

// ---- t1: reclaim of judge session dirs nobody owns ----

test("legacy (pre-opener) dir names are recognised, new and foreign ones are not", () => {
  assert.equal(isLegacyJudgeSessionDirName("goal-auditor-f3eb4277"), true);
  assert.equal(isLegacyJudgeSessionDirName("reviewer-12345678"), true);
  assert.equal(isLegacyJudgeSessionDirName("goal-auditor-f3eb4277-a1b2c3d4"), false);
  assert.equal(isLegacyJudgeSessionDirName("archive"), false);
  assert.equal(isLegacyJudgeSessionDirName("reviewer-abc"), false);
});

test("reclaim: a referenced dir is never selected, even when old or legacy", () => {
  const now = 1_700_000_000_000;
  const old = now - JUDGE_SESSION_DIR_TTL_MS - 1000;
  const entries = [
    { name: "reviewer-12345678", mtimeMs: old },
    { name: "reviewer-12345678-a1b2c3d4", mtimeMs: old },
  ];
  assert.deepEqual(
    selectStaleJudgeSessionDirs(entries, new Set(["reviewer-12345678", "reviewer-12345678-a1b2c3d4"]), now),
    [],
  );
});

test("reclaim: an unreferenced legacy dir is selected immediately, TTL notwithstanding", () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(
    selectStaleJudgeSessionDirs([{ name: "goal-auditor-f3eb4277", mtimeMs: now }], new Set(), now),
    ["goal-auditor-f3eb4277"],
  );
});

test("reclaim: an unreferenced new-format dir is selected only past the TTL", () => {
  const now = 1_700_000_000_000;
  const fresh = [{ name: "reviewer-12345678-a1b2c3d4", mtimeMs: now - 1000 }];
  const old = [{ name: "reviewer-12345678-a1b2c3d4", mtimeMs: now - JUDGE_SESSION_DIR_TTL_MS - 1000 }];
  assert.deepEqual(selectStaleJudgeSessionDirs(fresh, new Set(), now), []);
  assert.deepEqual(selectStaleJudgeSessionDirs(old, new Set(), now), ["reviewer-12345678-a1b2c3d4"]);
});

test("current-format names are recognised, legacy and foreign ones are not", () => {
  assert.equal(isCurrentJudgeSessionDirName("goal-auditor-f3eb4277-a1b2c3d4"), true);
  assert.equal(isCurrentJudgeSessionDirName("goal-auditor-f3eb4277"), false);
  assert.equal(isCurrentJudgeSessionDirName("archive"), false);
  assert.equal(isCurrentJudgeSessionDirName("reviewer-abc"), false);
});

test("reclaim: an unrecognised shape is NEVER selected, however old (fail-closed)", () => {
  // Round-1 P1 (reviewer): the TTL branch accepted anything, so the kept-transcript
  // `archive/` dir would have been rm -rf'd once past the TTL. Only current-format
  // dirs are TTL-eligible now.
  const now = 1_700_000_000_000;
  const ancient = now - JUDGE_SESSION_DIR_TTL_MS - 1000;
  const entries = [
    { name: "archive", mtimeMs: ancient },
    { name: "reviewer-abc", mtimeMs: ancient },
  ];
  assert.deepEqual(selectStaleJudgeSessionDirs(entries, new Set(), now), []);
});

// (Per-round run dirs are gone with the pane migration: the pane is the
// carrier, the session id the only identity. Round-end criteria now live in
// probeJudgeRound (lib/judge-session-tools.ts), covered there.)
//
// (`hasJudgeFence` is gone with the fence itself: no text is scanned for a
// verdict anymore — a round ends when judge_conclude writes a structured
// report into the channel. See test/review-adjudicate.test.ts.)

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
// built where the criteria live now. The DISCIPLINE moved on 2026-09-05 to
// lib/agent-directives.ts, where the project-manager wording lives beside it
// — its assertions moved with it, to test/agent-directives.test.ts.)

// ---------------------------------------------------------------------------
// awaitRoundReport — waiting for the END of a round on top of a wait that
// returns on every MESSAGE (P0, 2026-09-05). The gate's own audit chains are a
// single synchronous call with nobody there to act on a finding, and they read
// "not a report" as an unfinished audit — so a message-driven return would
// close the auditor mid-round and make any draft with findings fail forever.

test("awaitRoundReport keeps waiting through mid-round messages and returns the report", async () => {
  const windows: number[] = [];
  const replies = [
    { details: { reason: "finding" } },
    { details: { reason: "question" } },
    { details: { reason: "report" } },
    { details: { reason: "report" } }, // must never be reached
  ];
  let clock = 0;
  const slept: number[] = [];
  const got = await awaitRoundReport({
    wait: async (timeoutMs) => { windows.push(timeoutMs); clock += 1_000; return replies.shift()!; },
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); },
  });
  assert.deepEqual(got, { details: { reason: "report" } });
  assert.equal(windows.length, 3, "one call per message, then the report ends it");
  assert.ok(windows[1]! < windows[0]!, "the budget is shared across the calls, not restarted by each");
  assert.equal(replies.length, 1, "it stops at the report");
  assert.deepEqual(slept, [], "a wait that took the whole gap needs no extra pause");
});

test("awaitRoundReport cannot SPIN when the wait keeps returning instantly", async () => {
  // Round-2 P2: the loop's other termination reason (a cursor that advances)
  // is written by somebody else, and a judge with no registry entry skips that
  // write. A measured 354k iterations burned the budget, each with a tmux
  // probe and two file reads. Liveness may not depend on another module.
  //
  // THE FAKE CLOCK ONLY MOVES INSIDE `sleep`, which is deliberate: the pause
  // IS what makes progress here. That also means an implementation without the
  // pause would never reach the deadline, so this test arms its own trip wire
  // — a mutant that deletes the gap must FAIL FAST, not hang. (Measured: a
  // reviewer's mutation run sat for 22 minutes on the un-armed version before
  // it was killed by hand.)
  let clock = 0;
  let calls = 0;
  const slept: number[] = [];
  await awaitRoundReport({
    wait: async () => {
      calls++;
      if (calls > 100) throw new Error("awaitRoundReport spun: the minimum gap is gone");
      return { details: { reason: "finding" } };
    },

    now: () => clock,
    budgetMs: 10_000,
    minGapMs: 1_000,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
  });
  assert.equal(calls, 11, "the instant replies are paced by the gap, not spun through");
  assert.ok(slept.every((ms) => ms === 1_000), "each pause is the full gap the call did not take");
});


test("awaitRoundReport ends on a dead pane, an error, an abort, or the budget", async () => {
  const dead = await awaitRoundReport({
    wait: async () => ({ details: { reason: "pane-dead" } }),
    now: () => 0,
  });
  assert.equal(dead.details?.reason, "pane-dead", "a dead pane ends the round");

  const failed = await awaitRoundReport({
    wait: async () => ({ isError: true, details: { reason: "finding" } }),
    now: () => 0,
  });
  assert.equal(failed.isError, true, "a failed wait is handed back, not retried forever");

  let calls = 0;
  const aborted = await awaitRoundReport({
    wait: async () => { calls++; return { details: { reason: "finding" } }; },
    now: () => 0,
    aborted: () => true,
  });
  assert.equal(calls, 1, "an aborted caller stops after the call in flight");
  assert.equal(aborted.details?.reason, "finding");

  // The budget is what stops an auditor that streams findings forever.
  let clock = 0;
  let spins = 0;
  const expired = await awaitRoundReport({
    wait: async () => { spins++; clock += 30_000; return { details: { reason: "finding" } }; },
    now: () => clock,
    budgetMs: 60_000,
  });
  assert.equal(spins, 2, "it spends the budget and stops");
  assert.equal(expired.details?.reason, "finding", "…returning the last thing it saw");
});


