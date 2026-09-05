/**
 * THE REUSE POLICY, pinned behaviour by behaviour.
 *
 * A judge transcript is reused on purpose (that is how a reviewer keeps its
 * context across rounds) and the failure mode of unbounded reuse was measured,
 * not imagined: one transcript that absorbed a whole project's reviews reached
 * 2.8MB and 74.8% of its window. So each of the three answers this module
 * gives — the unit, the release point, the cap — gets its own test, plus the
 * three holes the project manager named when the goal was negotiated
 * (priority, the `none` bucket, abandoned rounds).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  decideJudgeRotation,
  judgeObjectId,
  laneOfEntry,
  rotationHandoffTask,
  JUDGE_ROTATION_CONTEXT_PERCENT,
  JUDGE_ROTATION_MAX_ROUNDS,
  NO_JUDGE_OBJECT,
} from "../lib/judge-rotation.ts";
import { judgeSessionIdFor, laneSuffix, shortObjectId } from "../lib/judge-process.ts";
import {
  isCurrentJudgeSessionDirName,
  isLegacyJudgeSessionDirName,
  judgeWorkDirBasename,
  selectStaleJudgeSessionDirs,
  JUDGE_SESSION_DIR_TTL_MS,
} from "../lib/judge-lifecycle.ts";
import { SCOPE_BLOCK_HEADING } from "../lib/review-carryover.ts";

const GOAL = "a".repeat(64);
const OTHER_GOAL = "b".repeat(64);
const PLAN = "c".repeat(64);

test("the object id has a WRITTEN priority: an orchestration takes its plan, everyone else their goal", () => {
  // Both present is the interesting case — read order must never decide it.
  assert.equal(judgeObjectId({ orchestrator: true, planHash: PLAN, goalHash: GOAL }), PLAN);
  assert.equal(judgeObjectId({ orchestrator: false, planHash: PLAN, goalHash: GOAL }), GOAL);
  assert.equal(judgeObjectId({ planHash: PLAN, goalHash: GOAL }), GOAL);
  // Nothing approved yet ⇒ the stable placeholder, never an empty string.
  assert.equal(judgeObjectId({}), NO_JUDGE_OBJECT);
  assert.equal(judgeObjectId({ orchestrator: true }), NO_JUDGE_OBJECT);
  assert.equal(judgeObjectId({ orchestrator: true, goalHash: GOAL }), NO_JUDGE_OBJECT);
  assert.equal(judgeObjectId({ goalHash: "   " }), NO_JUDGE_OBJECT);
});

test("RELEASE POINT: a changed object starts a new transcript — new id, new dir", () => {
  const first = decideJudgeRotation({ objectId: GOAL });
  assert.deepEqual(first, {
    lane: { objectId: GOAL, generation: 0 },
    rotated: false,
    reason: "first",
    roundsInObject: 1,
  });

  const after = decideJudgeRotation({
    objectId: OTHER_GOAL,
    previous: { objectId: GOAL, generation: 3, roundsInObject: 5, contextPercent: 10 },
  });
  assert.equal(after.rotated, true);
  assert.equal(after.reason, "object-changed");
  // A NEW object starts at generation 0 — the old object's generation count is
  // not a running total across objects.
  assert.deepEqual(after.lane, { objectId: OTHER_GOAL, generation: 0 });
  assert.equal(after.roundsInObject, 1);

  const idBefore = judgeSessionIdFor("reviewer", "abcd1234", "opener-1", first.lane);
  const idAfter = judgeSessionIdFor("reviewer", "abcd1234", "opener-1", after.lane);
  const dirBefore = judgeWorkDirBasename("reviewer", "abcd1234", "opener-1", first.lane);
  const dirAfter = judgeWorkDirBasename("reviewer", "abcd1234", "opener-1", after.lane);
  assert.notEqual(idBefore, idAfter, "a new object must resume a DIFFERENT session");
  assert.notEqual(dirBefore, dirAfter, "and write into a different dir");
  // The id and the dir name the SAME lane — the failure this suffix exists to
  // prevent is a transcript id from one lane beside a dir from another.
  assert.ok(idAfter.endsWith(laneSuffix(after.lane)));
  assert.ok(dirAfter.endsWith(laneSuffix(after.lane)));
});

test("CAP 1: the judge's own context reading rotates the transcript, generation +1", () => {
  const at = decideJudgeRotation({
    objectId: GOAL,
    previous: { objectId: GOAL, generation: 1, roundsInObject: 2, contextPercent: JUDGE_ROTATION_CONTEXT_PERCENT },
  });
  assert.equal(at.rotated, true, "the threshold is inclusive");
  assert.equal(at.reason, "context");
  assert.deepEqual(at.lane, { objectId: GOAL, generation: 2 });
  assert.equal(at.roundsInObject, 1, "a new transcript counts rounds from one");

  const below = decideJudgeRotation({
    objectId: GOAL,
    previous: { objectId: GOAL, generation: 1, roundsInObject: 2, contextPercent: JUDGE_ROTATION_CONTEXT_PERCENT - 1 },
  });
  assert.equal(below.rotated, false);
  assert.equal(below.reason, "reuse");
  assert.deepEqual(below.lane, { objectId: GOAL, generation: 1 }, "reuse keeps the generation");
  assert.equal(below.roundsInObject, 3);
});

test("CAP 2: the round cap rotates on its own, with no context reading at all", () => {
  const at = decideJudgeRotation({
    objectId: GOAL,
    previous: { objectId: GOAL, generation: 0, roundsInObject: JUDGE_ROTATION_MAX_ROUNDS },
  });
  assert.equal(at.rotated, true);
  assert.equal(at.reason, "rounds");
  assert.deepEqual(at.lane, { objectId: GOAL, generation: 1 });

  const below = decideJudgeRotation({
    objectId: GOAL,
    previous: { objectId: GOAL, generation: 0, roundsInObject: JUDGE_ROTATION_MAX_ROUNDS - 1 },
  });
  assert.equal(below.rotated, false);
  assert.equal(below.roundsInObject, JUDGE_ROTATION_MAX_ROUNDS);
});

test("FAIL-OPEN: an unreadable context does NOT rotate — only the round cap bounds it", () => {
  for (const contextPercent of [undefined, Number.NaN]) {
    const decision = decideJudgeRotation({
      objectId: GOAL,
      previous: { objectId: GOAL, generation: 0, roundsInObject: 1, ...(contextPercent === undefined ? {} : { contextPercent }) },
    });
    assert.equal(decision.rotated, false, `no reading (${String(contextPercent)}) must not rotate`);
    assert.equal(decision.reason, "reuse");
  }
  // Rotating on a missing reading would cancel reuse entirely (every round a
  // fresh transcript), which is why the cap below is the one that still fires.
  const capped = decideJudgeRotation({
    objectId: GOAL,
    previous: { objectId: GOAL, generation: 0, roundsInObject: JUDGE_ROTATION_MAX_ROUNDS },
  });
  assert.equal(capped.reason, "rounds");
});

test("the `none` object is a real object: both caps apply to the pre-approval rounds", () => {
  const byContext = decideJudgeRotation({
    objectId: NO_JUDGE_OBJECT,
    previous: { objectId: NO_JUDGE_OBJECT, generation: 0, roundsInObject: 1, contextPercent: 61 },
  });
  assert.equal(byContext.rotated, true);
  assert.equal(byContext.reason, "context");
  assert.deepEqual(byContext.lane, { objectId: NO_JUDGE_OBJECT, generation: 1 });

  const byRounds = decideJudgeRotation({
    objectId: NO_JUDGE_OBJECT,
    previous: { objectId: NO_JUDGE_OBJECT, generation: 2, roundsInObject: JUDGE_ROTATION_MAX_ROUNDS + 4 },
  });
  assert.equal(byRounds.rotated, true);
  assert.equal(byRounds.reason, "rounds");
  assert.deepEqual(byRounds.lane, { objectId: NO_JUDGE_OBJECT, generation: 3 });

  // And the approval that ends the negotiation releases it, lazily.
  const approved = decideJudgeRotation({
    objectId: GOAL,
    previous: { objectId: NO_JUDGE_OBJECT, generation: 3, roundsInObject: 2 },
  });
  assert.equal(approved.reason, "object-changed");
  assert.deepEqual(approved.lane, { objectId: GOAL, generation: 0 });
});

test("ABANDONED ROUNDS COUNT: the counter advances at dispatch, so re-opening cannot dodge the cap", () => {
  // Simulate a judge that is dispatched over and over and never concludes:
  // nothing but the dispatch itself advances the count.
  let previous: { objectId: string; generation: number; roundsInObject: number } | undefined;
  let rotations = 0;
  for (let round = 0; round < JUDGE_ROTATION_MAX_ROUNDS + 1; round++) {
    const decision = decideJudgeRotation({ objectId: GOAL, ...(previous ? { previous } : {}) });
    if (decision.rotated) rotations++;
    previous = {
      objectId: decision.lane.objectId,
      generation: decision.lane.generation,
      roundsInObject: decision.roundsInObject,
    };
  }
  assert.equal(rotations, 1, "the ninth dispatch under one object rotates, concluded or not");
  assert.equal(previous?.generation, 1);
});

test("a lane-less registry entry degrades to `first` instead of throwing or guessing", () => {
  assert.equal(laneOfEntry(undefined), undefined);
  assert.equal(laneOfEntry({}), undefined);
  assert.equal(laneOfEntry({ objectId: "  " }), undefined);
  assert.deepEqual(laneOfEntry({ objectId: GOAL }), { objectId: GOAL, generation: 0 });
  assert.deepEqual(laneOfEntry({ objectId: GOAL, generation: 4 }), { objectId: GOAL, generation: 4 });
  // Untrusted persisted numbers never reach arithmetic.
  assert.deepEqual(laneOfEntry({ objectId: GOAL, generation: -3 }), { objectId: GOAL, generation: 0 });
  // …and neither do untrusted persisted STRINGS. The registry passes unknown
  // fields through when it parses a snapshot (that is what lets a new field
  // survive an older build), so a truncated or hand-edited file can put a
  // number where the object id belongs. That must degrade, not throw inside a
  // dispatch.
  const dirty = { objectId: 42 as unknown as string, generation: "3" as unknown as number };
  assert.equal(laneOfEntry(dirty), undefined);
  assert.equal(decideJudgeRotation({ objectId: GOAL, previous: dirty }).reason, "first");
  assert.equal(
    decideJudgeRotation({ objectId: "   ", previous: { objectId: NO_JUDGE_OBJECT, generation: 0, roundsInObject: 1 } }).reason,
    "reuse",
    "an empty object id IS the placeholder, not a third object",
  );

  const decision = decideJudgeRotation({ objectId: GOAL, previous: { generation: 9, roundsInObject: 99 } });
  assert.equal(decision.reason, "first");
  assert.equal(decision.lane.generation, 0);
});

test("omitting the lane reproduces the pre-lane id and dir byte for byte", () => {
  assert.equal(laneSuffix(undefined), "");
  const bare = judgeSessionIdFor("reviewer", "abcd1234", "opener-1");
  const bareDir = judgeWorkDirBasename("reviewer", "abcd1234", "opener-1");
  assert.match(bare, /^rg-reviewer-abcd1234-[0-9a-f]{8}$/, "no lane ⇒ the pre-lane id, unchanged");
  assert.match(bareDir, /^reviewer-abcd1234-[0-9a-f]{8}$/, "no lane ⇒ the pre-lane dir, unchanged");
  // And a lane is exactly that id plus the shared suffix — one renderer, two
  // consumers, so the id and the dir can never disagree about the lane.
  const lane = { objectId: GOAL, generation: 2 };
  assert.equal(judgeSessionIdFor("reviewer", "abcd1234", "opener-1", lane), bare + laneSuffix(lane));
  assert.equal(judgeWorkDirBasename("reviewer", "abcd1234", "opener-1", lane), bareDir + laneSuffix(lane));
  // The lane suffix is always the same recognisable shape: 8 hex + generation.
  assert.match(laneSuffix({ objectId: GOAL, generation: 0 }), /^-[0-9a-f]{8}-g0$/);
  assert.match(laneSuffix({ objectId: NO_JUDGE_OBJECT, generation: 7 }), /^-[0-9a-f]{8}-g7$/);
  assert.equal(shortObjectId(GOAL), GOAL.slice(0, 8));
});

test("ARCHIVED IN PLACE: a rotated-away dir is still OURS, so the TTL sweep can reclaim it", () => {
  const live = judgeWorkDirBasename("reviewer", "abcd1234", "opener-1", { objectId: GOAL, generation: 2 });
  const preLane = judgeWorkDirBasename("reviewer", "abcd1234", "opener-1");
  assert.equal(isCurrentJudgeSessionDirName(live), true, "the lane shape is recognised");
  assert.equal(isCurrentJudgeSessionDirName(preLane), true, "so is the pre-lane shape");
  assert.equal(isLegacyJudgeSessionDirName(live), false);
  assert.equal(isLegacyJudgeSessionDirName("reviewer-abcd1234"), true, "the pre-opener shape is unchanged");
  // Fail-closed: anything that is not one of the known shapes stays untouched.
  assert.equal(isCurrentJudgeSessionDirName("archive"), false);
  assert.equal(isLegacyJudgeSessionDirName("archive"), false);
  assert.equal(isCurrentJudgeSessionDirName("reviewer-abcd1234-notahex-g1"), false);
  assert.equal(isCurrentJudgeSessionDirName("reviewer-abcd1234-deadbeef-gx"), false);

  // The sweep: the LIVE lane is protected by the known set (identity, not
  // mtime); the rotated-away one ages out like any other unowned dir.
  const now = 10 * JUDGE_SESSION_DIR_TTL_MS;
  const old = now - JUDGE_SESSION_DIR_TTL_MS - 1;
  const retired = judgeWorkDirBasename("reviewer", "abcd1234", "opener-1", { objectId: GOAL, generation: 1 });
  const stale = selectStaleJudgeSessionDirs(
    [{ name: live, mtimeMs: old }, { name: retired, mtimeMs: old }, { name: "archive", mtimeMs: old }],
    new Set([live]),
    now,
  );
  assert.deepEqual(stale, [retired]);
});

test("the ROTATION HAND-OFF is rendered by review-carryover, and never doubled", () => {
  const rotated = decideJudgeRotation({
    objectId: GOAL,
    previous: { objectId: GOAL, generation: 0, roundsInObject: 2, contextPercent: 88 },
  });
  const handoff = rotationHandoffTask({
    role: "reviewer",
    task: "REVIEW baseline..HEAD",
    decision: rotated,
    settled: { verdict: "READY", at: "2026-09-05T00:00:00Z", rounds: 4 },
    openFindings: ["lib/a.ts:12 stale guard"],
    delta: { files: ["lib/a.ts"], lines: 30, reviewedFiles: ["lib/b.ts"] },
  });
  assert.ok(handoff.includes("REVIEW baseline..HEAD"), "the round's own task survives");
  assert.ok(handoff.includes(SCOPE_BLOCK_HEADING), "the contract block is the hand-off");
  assert.ok(handoff.includes("verdict READY"), "the previous verdict travels");
  assert.ok(handoff.includes("lib/a.ts:12 stale guard"), "so do the open findings");
  assert.ok(handoff.includes("lib/a.ts"), "and the mechanical delta");
  assert.ok(handoff.startsWith("你手上的任务书与交接，就是这一轮的全部上下文"),
    "the round opens with the one operational fact the judge needs");
  assert.equal(handoff.split(SCOPE_BLOCK_HEADING).length - 1, 1, "exactly one contract block");

  // A task that already carries the block (every prepared reviewer round does)
  // gets the sentence only: two blocks would make the judge's own scope read
  // ambiguous.
  const prepared = `${SCOPE_BLOCK_HEADING}\n- FULL deep review. first round.\n\nREVIEW`;
  const once = rotationHandoffTask({
    role: "reviewer",
    task: prepared,
    decision: rotated,
    settled: { verdict: "READY" },
    openFindings: ["x"],
  });
  assert.equal(once.split(SCOPE_BLOCK_HEADING).length - 1, 1, "no second block is rendered");
  assert.ok(once.includes("REVIEW"));

  // Another role's hand-off is that role's own module's job.
  const auditor = rotationHandoffTask({
    role: "goal-auditor",
    task: "AUDIT this draft",
    decision: rotated,
    settled: { verdict: "READY" },
    openFindings: ["x"],
  });
  assert.equal(auditor.includes(SCOPE_BLOCK_HEADING), false, "a review contract is the wrong document here");
  assert.ok(auditor.includes("AUDIT this draft"));

  // An unrotated round passes through untouched — this is a no-op on the
  // normal path, which is where it runs on every single dispatch.
  const reuse = decideJudgeRotation({ objectId: GOAL, previous: { objectId: GOAL, generation: 0, roundsInObject: 1 } });
  assert.equal(rotationHandoffTask({ role: "reviewer", task: "T", decision: reuse }), "T");
});

/**
 * WHAT THE JUDGE IS NEVER TOLD (user, 2026-09-05).
 *
 * The text a rotated round is sent names no mechanism: not the rotation, not
 * the thresholds, not that a transcript ended or that anything was measured.
 * A judge that knows it is being managed starts managing itself — budgeting
 * its reading, hedging a verdict on "limited context", asking for more room —
 * and each of those is a worse review than the one it was asked for. This test
 * is the ratchet on that wording; it covers every role and both hand-off
 * shapes, because one uncovered branch is where the leak would come back.
 */
test("the rotated round's text names no mechanism — no thresholds, no rotation, no lost history", () => {
  const rotated = decideJudgeRotation({
    objectId: GOAL,
    previous: { objectId: GOAL, generation: 0, roundsInObject: 2, contextPercent: 88 },
  });
  const byRounds = decideJudgeRotation({
    objectId: GOAL,
    previous: { objectId: GOAL, generation: 1, roundsInObject: JUDGE_ROTATION_MAX_ROUNDS },
  });
  const byObject = decideJudgeRotation({ objectId: OTHER_GOAL, previous: { objectId: GOAL, generation: 0, roundsInObject: 1 } });

  const texts = [rotated, byRounds, byObject].flatMap((decision) => [
    // with a carryover…
    rotationHandoffTask({
      role: "reviewer",
      task: "REVIEW",
      decision,
      settled: { verdict: "READY" },
      openFindings: ["lib/a.ts:1 x"],
      delta: { files: ["lib/a.ts"] },
    }),
    // …and without one (nothing settled yet, and every non-reviewer role)
    rotationHandoffTask({ role: "reviewer", task: "REVIEW", decision }),
    rotationHandoffTask({ role: "adviser", task: "ADVISE", decision }),
    rotationHandoffTask({ role: "goal-auditor", task: "AUDIT", decision }),
  ]);

  // Derivation self-proof: the scan must actually be looking at rendered text,
  // or every "does not contain" below passes on nothing.
  assert.equal(texts.length, 12);
  for (const text of texts) {
    assert.ok(text.includes("你手上的任务书与交接"), `every rotated round opens with the same fact: ${text.slice(0, 40)}`);
    // SCOPED TO WHAT THIS MODULE AUTHORS: the opening paragraph and the
    // decision line it feeds `buildReviewCarryover`. The rest of the contract
    // block belongs to lib/review-carryover.ts and legitimately says things
    // like "the FULL diff as context" — banning words there would be a rule
    // about someone else's text, and it would fail on wording this round
    // never wrote.
    const preamble = text.split("\n\n")[0]!;
    const decisionLine = text.split("\n").find((line) => line.startsWith("- INCREMENTAL.")) ?? "";
    assert.ok(preamble.length > 0, "derivation sanity: the preamble is non-empty");
    // …and when this text HAS a contract block, its decision line must have
    // been found: a `find` that silently returned nothing would quietly shrink
    // this check to the preamble alone, which is the half that was never at
    // risk of naming a threshold.
    assert.equal(
      decisionLine !== "",
      text.includes(SCOPE_BLOCK_HEADING),
      "the decision line is located exactly when a contract block is present",
    );
    const authored = `${preamble}\n${decisionLine}`;
    for (const leak of [
      "轮转", "rotat", "代次", "generation",
      "transcript", "上下文占用", "上下文预算", "上下文不够",
      String(JUDGE_ROTATION_CONTEXT_PERCENT), String(JUDGE_ROTATION_MAX_ROUNDS),
      "门禁", "历史", "截断", "先前轮次", "新一条", "对象",
    ]) {
      assert.equal(authored.includes(leak), false, `"${leak}" must not reach the judge: ${authored.slice(0, 120)}`);
    }
  }
});
