import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStallNotice,
  classifyStallCause,
  evaluateStall,
  negotiationFingerprint,
  progressSignature,
  stallInMotion,
  STALL_REPEAT_LIMIT,
  type ProgressInputs,
  type StallState,
  type StallVerdict,
} from "../lib/loop-stall.ts";

const base: ProgressInputs = {
  fingerprint: "abc123",
  reviewVerdict: "PENDING",
  precommitVerdict: "NOT_RUN",
  rounds: 0,
  problems: ["code review gate is PENDING (need READY)", "precommit has not run"],
  contract: negotiationFingerprint({}),
};

test("progressSignature is stable for identical inputs and unique per field", () => {
  assert.equal(progressSignature(base), progressSignature({ ...base }));
  const variants: Array<Partial<ProgressInputs>> = [
    { fingerprint: "def456" },
    { reviewVerdict: "READY" },
    { precommitVerdict: "PASS" },
    { rounds: 1 },
    { problems: ["precommit has not run"] },
  ];
  const seen = new Set([progressSignature(base)]);
  for (const v of variants) {
    const sig = progressSignature({ ...base, ...v });
    assert.ok(!seen.has(sig), `changing ${Object.keys(v)[0]} must change the signature`);
    seen.add(sig);
  }
});

test("problem ORDER is part of the signature (a reordered unmet list is still change)", () => {
  const reordered = progressSignature({ ...base, problems: [...base.problems].reverse() });
  assert.notEqual(reordered, progressSignature(base));
});

test("a field separator cannot be forged by problem text", () => {
  // Two different problem lists must not collide just because one contains
  // the separator the other implies.
  const a = progressSignature({ ...base, problems: ["x", "y"] });
  const b = progressSignature({ ...base, problems: ["x|y"] });
  assert.notEqual(a, b);
});

test("repeated identical signatures accumulate and trip exactly at the limit", () => {
  const sig = progressSignature(base);
  let state: StallState | undefined;
  for (let i = 1; i < STALL_REPEAT_LIMIT; i++) {
    const v = evaluateStall(state, sig);
    assert.equal(v.repeats, i);
    assert.equal(v.stalled, false, `must not trip before the limit (i=${i})`);
    state = v;
  }
  const tripped = evaluateStall(state, sig);
  assert.equal(tripped.repeats, STALL_REPEAT_LIMIT);
  assert.equal(tripped.stalled, true);
});

test("stall persists while the situation persists (notice is caller-gated, not re-armed)", () => {
  const sig = progressSignature(base);
  let state: StallState | undefined;
  for (let i = 0; i < STALL_REPEAT_LIMIT + 3; i++) state = evaluateStall(state, sig);
  const v = evaluateStall(state, sig);
  assert.equal(v.stalled, true);
  assert.ok(v.repeats > STALL_REPEAT_LIMIT);
});

test("REGRESSION: any real progress resets the counter and re-arms the full budget", () => {
  // The quota-burn scenario: 7 identical rounds. Once an edit lands (new
  // fingerprint) or a verdict is recorded, the loop must get its budget back.
  const sig = progressSignature(base);
  let state: StallState | undefined;
  let stalled = false;
  for (let i = 0; i < STALL_REPEAT_LIMIT; i++) {
    const v = evaluateStall(state, sig);
    state = v;
    stalled = v.stalled;
  }
  assert.equal(stalled, true, "precondition: the loop is stalled before progress lands");

  const afterEdit = evaluateStall(state, progressSignature({ ...base, fingerprint: "NEW" }));
  assert.equal(afterEdit.repeats, 1);
  assert.equal(afterEdit.stalled, false);

  const afterVerdict = evaluateStall(afterEdit, progressSignature({ ...base, reviewVerdict: "READY" }));
  assert.equal(afterVerdict.repeats, 1);
  assert.equal(afterVerdict.stalled, false);
});

test("a custom limit is honored (limit 1 trips immediately)", () => {
  const v = evaluateStall(undefined, progressSignature(base), 1);
  assert.equal(v.stalled, true);
});

test("REGRESSION: an in-flight subagent is motion — the breaker must not orphan a running review", () => {
  // The dangerous shape: while an async reviewer runs, NOTHING in the
  // signature can move (no verdict exists yet), so a naive breaker trips on
  // the loop's own review and stops the turns that would collect it.
  const sig = progressSignature(base);
  let state: StallState | undefined;
  for (let i = 0; i < STALL_REPEAT_LIMIT + 5; i++) {
    const v = evaluateStall(state, sig, STALL_REPEAT_LIMIT, { inMotion: true });
    assert.equal(v.stalled, false, `a running subagent can never be a stall (i=${i})`);
    assert.equal(v.repeats, 1, "motion keeps the budget fully re-armed");
    state = v;
  }
  // …and when the run finishes without recording anything, the breaker takes
  // over again from a clean count: motion never grants permanent immunity.
  let after: StallState | undefined = state;
  let stalled = false;
  for (let i = 0; i < STALL_REPEAT_LIMIT; i++) {
    const v = evaluateStall(after, sig);
    after = v;
    stalled = v.stalled;
  }
  assert.equal(stalled, true, "once nothing is running, an unchanged signature stalls normally");
});

test("REGRESSION: recovery after a stall — the recorded verdict re-arms the loop", () => {
  // The recovery path the breaker depends on: it stops the gate from talking
  // to ITSELF, while a user message or a completed background task still
  // wakes the agent. The moment that wake produces real progress (here: the
  // reviewer's verdict is recorded), injections must resume.
  const sig = progressSignature(base);
  let state: StallVerdict | undefined;
  for (let i = 0; i < STALL_REPEAT_LIMIT; i++) state = evaluateStall(state, sig);
  assert.equal(state!.stalled, true, "precondition: stalled");

  const recorded = evaluateStall(
    state,
    progressSignature({
      ...base,
      reviewVerdict: "BLOCKED",
      rounds: 1,
      problems: ["code review gate is BLOCKED (need READY)"],
    }),
  );
  assert.equal(recorded.stalled, false, "a recorded verdict must resume the loop");
  assert.equal(recorded.repeats, 1);

  // And the fix that follows (an edit) keeps it running.
  const afterFix = evaluateStall(recorded, progressSignature({ ...base, fingerprint: "FIXED", rounds: 1 }));
  assert.equal(afterFix.stalled, false);
});

test("the notice names the cause the gate observed, and refuses to imply the gate relaxed", () => {
  const notice = buildStallNotice(3, "unexplained");
  assert.match(notice, /熔断/);
  assert.match(notice, /429|额度/, "the unexplained branch is where the provider belongs");
  assert.match(notice, /gate-doctor/, "must offer the diagnostic path");
  assert.match(notice, /未\*\*被放宽|未.{0,4}放宽/, "must state the gate is NOT relaxed");
  assert.match(notice, /ship/i);
  // The three parts every gate refusal carries (lib/rejection-copy.ts).
  assert.match(notice, /^review-gate: .*熔断/m);
  assert.match(notice, /\n原因：/);
  assert.match(notice, /\n下一步：/);
});

// ---------------------------------------------------------------------------
// The 2026-09-16 fix: negotiation is progress, and the notice names the real
// cause instead of blaming the provider first.
// ---------------------------------------------------------------------------

test("REGRESSION: revising the requirement contract is progress, even with zero code change", () => {
  // Measured (OneKeyHQ notification, 01a0a99e): 80 minutes of rewriting the
  // restatement and the goal draft, seven revisions, no code. The old
  // signature could not see any of it and called it a stall.
  const v1 = progressSignature({ ...base, contract: negotiationFingerprint({ restatementHash: "a" }) });
  const v2 = progressSignature({ ...base, contract: negotiationFingerprint({ restatementHash: "a", goalDraftHash: "b" }) });
  const v3 = progressSignature({ ...base, contract: negotiationFingerprint({ restatementHash: "a", goalDraftHash: "c" }) });
  assert.notEqual(v1, v2, "a first audited draft is progress");
  assert.notEqual(v2, v3, "a REVISED draft is progress too");
  assert.equal(progressSignature(base), progressSignature({ ...base }), "still stable for identical inputs");
});

test("negotiationFingerprint: never-restated cannot collide with restated-and-hashed", () => {
  assert.notEqual(negotiationFingerprint({}), negotiationFingerprint({ restatementHash: "-" }));
  assert.equal(negotiationFingerprint({}), negotiationFingerprint({}));
});

test("stallInMotion: waiting on an external input — or an exchange since the last look — is motion", () => {
  const none = { judgeInFlight: false, forceNegotiate: false, pausedForUser: false };
  assert.equal(stallInMotion(none), false, "nothing observed: the ordinary counting applies");
  assert.equal(stallInMotion({ ...none, judgeInFlight: true }), true);
  assert.equal(stallInMotion({ ...none, forceNegotiate: true }), true);
  assert.equal(stallInMotion({ ...none, pausedForUser: true }), true, "a parked dialog is waiting on a person");
  // The EVENT rule: an answer that landed after the previous observation.
  assert.equal(
    stallInMotion({ ...none, lastUserInteractionAt: "2026-09-16T10:10:00Z", previousObservationAt: "2026-09-16T10:05:00Z" }),
    true,
  );
  // …and NOT a grace period: an answer from before the last observation proves
  // nothing about this turn, however recent it looks.
  assert.equal(
    stallInMotion({ ...none, lastUserInteractionAt: "2026-09-16T10:00:00Z", previousObservationAt: "2026-09-16T10:05:00Z" }),
    false,
  );
  // Unreadable or missing stamps never grant the exemption (fail-closed).
  assert.equal(stallInMotion({ ...none, lastUserInteractionAt: "not-a-date", previousObservationAt: "2026-09-16T10:05:00Z" }), false);
  assert.equal(stallInMotion({ ...none, lastUserInteractionAt: "2026-09-16T10:10:00Z" }), false);
});

test("REGRESSION: a live negotiation does not trip the breaker — and stops counting the moment the user goes quiet", () => {
  // The concrete incident: the gate keeps exchanging dialogs with the user
  // while the contract changes. Every observation must be motion.
  const sig = progressSignature(base);
  let state: StallState | undefined;
  for (let i = 0; i < STALL_REPEAT_LIMIT + 5; i++) {
    const v = evaluateStall(state, sig, STALL_REPEAT_LIMIT,{
      inMotion: stallInMotion({
        judgeInFlight: false,
        forceNegotiate: false,
        pausedForUser: false,
        lastUserInteractionAt: "2026-09-16T10:10:00Z",
        previousObservationAt: "2026-09-16T10:05:00Z",
      }),
    });
    assert.equal(v.stalled, false, `a conversation is not a stall (i=${i})`);
    assert.equal(v.repeats, 1, "motion re-arms the full budget");
    state = v;
  }
  // Nobody answered between the last two observations, so the SAME facts now
  // count as stillness: the exemption is an event, not a permanent shield.
  let after: StallState | undefined = state;
  let stalled = false;
  for (let i = 0; i < STALL_REPEAT_LIMIT; i++) {
    const v = evaluateStall(after, sig, STALL_REPEAT_LIMIT, {
      inMotion: stallInMotion({
        judgeInFlight: false,
        forceNegotiate: false,
        pausedForUser: false,
        lastUserInteractionAt: "2026-09-16T10:00:00Z",
        previousObservationAt: "2026-09-16T10:05:00Z",
      }),
    });
    after = v;
    stalled = v.stalled;
  }
  assert.equal(stalled, true, "once the user goes quiet the ordinary counting resumes");
});

test("classifyStallCause: the most specific observable fact wins, provider last", () => {
  const baseCause = { pausedForUser: false, goalConfirmed: true, hasUnreviewedChanges: false };
  assert.equal(classifyStallCause({ ...baseCause, pausedForUser: true }), "waiting-user");
  assert.equal(classifyStallCause({ ...baseCause, pausedForUser: true, goalConfirmed: false }), "waiting-user");
  assert.equal(classifyStallCause({ ...baseCause, goalConfirmed: false }), "goal-unapproved");
  assert.equal(classifyStallCause({ ...baseCause, hasUnreviewedChanges: true }), "gates-unmet");
  assert.equal(
    classifyStallCause({ ...baseCause, lastUserInteractionAt: "2026-09-16T10:10:00Z" }),
    "waiting-user",
    "nothing else outstanding but the session has been talking to a person",
  );
  assert.equal(classifyStallCause(baseCause), "unexplained", "only here does the provider get named");
});

test("the notice for a non-provider cause does NOT send the reader to the provider first", () => {
  const goal = buildStallNotice(3, "goal-unapproved");
  assert.match(goal, /propose_restatement/);
  assert.match(goal, /propose_loop_goal/);
  assert.doesNotMatch(goal, /429/, "the goal branch must not claim a provider failure");
  const gates = buildStallNotice(3, "gates-unmet");
  assert.match(gates, /judge_submit/);
  assert.match(gates, /gate-doctor/, "…but it still says where to look when repeating the action changes nothing");
  const waiting = buildStallNotice(3, "waiting-user");
  assert.match(waiting, /ask_user/);
  assert.doesNotMatch(waiting, /429/);
});
