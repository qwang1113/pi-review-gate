/**
 * Incremental review scoping — the escalation rules.
 *
 * An incremental round tells the reviewer "everything outside this increment
 * was already approved". That claim is only safe under conditions this module
 * has to enforce exactly, so every escalation path is pinned here: a missing
 * baseline, an unreadable increment, a too-large increment, and — the subtle
 * one — an increment that reaches into files the previous review never saw.
 *
 * There is also a precondition that is NOT about the code: the judge taking
 * the round has to be the one that settled the last, or the carry-forward is
 * taken on trust. It is pinned in its own block at the bottom; every test
 * above it goes through `decideReviewScope` below, which supplies that fact so
 * a CONTENT rule is what each of them actually measures.
 *
 * The TEXT the decision turns into is not tested here any more: it moved to
 * lib/review-carryover.ts (its one authoritative source), and so did its
 * tests — test/review-carryover.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INCREMENT_MAX_FILES,
  INCREMENT_MAX_LINES,
  decideReviewScope as decideReviewScopeRaw,
  type IncrementInput,
} from "../lib/review-scope.ts";

/**
 * The content rules, with the READER-side precondition already satisfied.
 *
 * Without it every case below would escalate for the same reason and none of
 * them would measure what it names. A test that means to exercise the reader
 * rule calls `decideReviewScopeRaw` directly.
 */
function decideReviewScope(input: IncrementInput) {
  return decideReviewScopeRaw({ judgeRemembersPreviousRound: true, ...input });
}

const reviewed = ["src/a.ts", "src/b.ts"];


test("incremental: a small increment inside already-reviewed files", () => {
  const d = decideReviewScope({
    baseTree: "T",
    changedFiles: ["src/a.ts"],
    changedLines: 3,
    previouslyReviewedFiles: reviewed,
  });
  assert.equal(d.scope, "incremental");
  assert.deepEqual(d.unreviewedFiles, []);
  assert.match(d.reason, /1 file/);
});

test("full: no previous READY review to build on", () => {
  const d = decideReviewScope({ changedFiles: ["src/a.ts"], changedLines: 1 });
  assert.equal(d.scope, "full");
  assert.match(d.reason, /no previous READY review/);
});

test("full: the increment could not be computed (git unreadable)", () => {
  const d = decideReviewScope({ baseTree: "T", changedFiles: undefined, previouslyReviewedFiles: reviewed });
  assert.equal(d.scope, "full");
  assert.match(d.reason, /could not be computed/);
});

test("full: nothing changed since the last READY (a re-review covers everything)", () => {
  const d = decideReviewScope({ baseTree: "T", changedFiles: [], changedLines: 0, previouslyReviewedFiles: reviewed });
  assert.equal(d.scope, "full");
});

test("full: too many files in the increment", () => {
  const files = Array.from({ length: INCREMENT_MAX_FILES + 1 }, (_, i) => `src/f${i}.ts`);
  const d = decideReviewScope({
    baseTree: "T",
    changedFiles: files,
    changedLines: 10,
    previouslyReviewedFiles: files,
  });
  assert.equal(d.scope, "full");
  assert.match(d.reason, new RegExp(`> ${INCREMENT_MAX_FILES}`));
});

test("exactly at the file threshold is still incremental (the limit is exclusive)", () => {
  const files = Array.from({ length: INCREMENT_MAX_FILES }, (_, i) => `src/f${i}.ts`);
  const d = decideReviewScope({
    baseTree: "T",
    changedFiles: files,
    changedLines: 10,
    previouslyReviewedFiles: files,
  });
  assert.equal(d.scope, "incremental");
});

test("full: too many changed lines", () => {
  const d = decideReviewScope({
    baseTree: "T",
    changedFiles: ["src/a.ts"],
    changedLines: INCREMENT_MAX_LINES + 1,
    previouslyReviewedFiles: reviewed,
  });
  assert.equal(d.scope, "full");
  assert.match(d.reason, new RegExp(`> ${INCREMENT_MAX_LINES}`));
});

test("exactly at the line threshold is still incremental", () => {
  const d = decideReviewScope({
    baseTree: "T",
    changedFiles: ["src/a.ts"],
    changedLines: INCREMENT_MAX_LINES,
    previouslyReviewedFiles: reviewed,
  });
  assert.equal(d.scope, "incremental");
});

test("full: the increment touches a file the previous review never covered", () => {
  // The whole premise of an incremental round is "the rest was already
  // approved". A brand-new file has no such status to inherit.
  const d = decideReviewScope({
    baseTree: "T",
    changedFiles: ["src/a.ts", "src/new.ts"],
    changedLines: 5,
    previouslyReviewedFiles: reviewed,
  });
  assert.equal(d.scope, "full");
  assert.deepEqual(d.unreviewedFiles, ["src/new.ts"]);
  assert.match(d.reason, /never covered/);
});

test("full: no recorded coverage at all means nothing can be claimed reviewed", () => {
  const d = decideReviewScope({ baseTree: "T", changedFiles: ["src/a.ts"], changedLines: 2 });
  assert.equal(d.scope, "full");
  assert.deepEqual(d.unreviewedFiles, ["src/a.ts"]);
});

test("full: unreviewedFiles is populated even when the full path is taken for too-many-lines", () => {
  const d = decideReviewScope({
    baseTree: "T",
    changedFiles: ["src/a.ts", "src/new.ts"],
    changedLines: INCREMENT_MAX_LINES + 1,
    previouslyReviewedFiles: ["src/a.ts"],
  });
  assert.equal(d.scope, "full");
  assert.match(d.reason, new RegExp(`> ${INCREMENT_MAX_LINES}`));
  assert.deepEqual(d.unreviewedFiles, ["src/new.ts"]);
});

test("reviewedFiles is echoed on every decision (the settled scope must be nameable)", () => {
  const inc = decideReviewScope({
    baseTree: "T",
    changedFiles: ["src/a.ts"],
    changedLines: 3,
    previouslyReviewedFiles: reviewed,
  });
  assert.deepEqual(inc.reviewedFiles, reviewed);
  assert.deepEqual(decideReviewScope({}).reviewedFiles, []);
});

test("the decision module renders no contract text of its own", async () => {
  // Philosophy three, mechanically: the wording has ONE home. A second
  // renderer here is exactly how the five drifted copies happened, so the
  // module's public surface is asserted to be decision-only.
  const mod = await import("../lib/review-scope.ts");
  assert.deepEqual(
    Object.keys(mod).sort(),
    ["INCREMENT_MAX_FILES", "INCREMENT_MAX_LINES", "decideReviewScope"],
    "review-scope.ts exports the thresholds and the decision — nothing that formats text",
  );
});

/*
 * ───────────── THE READER-SIDE PRECONDITION (t9d, 2026-09-06) ─────────────
 *
 * The gate rotates a judge's transcript on its own (lib/judge-rotation.ts:
 * context threshold, round cap, a changed contract). A reviewer that starts a
 * fresh transcript never derived last round's conclusion, so an incremental
 * round would be asking it to carry forward something it can only take on
 * trust. These pin that the escalation is unconditional and fail-safe — the
 * content rules above cannot buy their way past it.
 */

test("full: the judge does not continue the transcript that settled the last round", () => {
  const d = decideReviewScopeRaw({
    baseTree: "T",
    changedFiles: ["src/a.ts"],
    changedLines: 3,
    previouslyReviewedFiles: reviewed,
    judgeRemembersPreviousRound: false,
  });
  assert.equal(d.scope, "full");
  assert.match(d.reason, /does not continue the transcript/);
});

test("full: an ABSENT reader fact is a no — incremental is never inferred", () => {
  // Same input as the canonical incremental case, minus the fact. A caller
  // that forgot to wire it must not silently receive the cheaper round.
  const d = decideReviewScopeRaw({
    baseTree: "T",
    changedFiles: ["src/a.ts"],
    changedLines: 3,
    previouslyReviewedFiles: reviewed,
  });
  assert.equal(d.scope, "full");
  assert.match(d.reason, /does not continue the transcript/);
});

test("the reader precondition still reports the content facts it escalated over", () => {
  // The decision is full, but the delta and the coverage it carries are what
  // the carryover block renders — dropping them would make the escalation
  // unexplainable to the reviewer that receives it.
  const d = decideReviewScopeRaw({
    baseTree: "T",
    changedFiles: ["src/a.ts", "src/new.ts"],
    changedLines: 7,
    previouslyReviewedFiles: reviewed,
    judgeRemembersPreviousRound: false,
  });
  assert.equal(d.scope, "full");
  assert.deepEqual(d.changedFiles, ["src/a.ts", "src/new.ts"]);
  assert.equal(d.changedLines, 7);
  assert.deepEqual(d.reviewedFiles, reviewed);
  assert.deepEqual(d.unreviewedFiles, ["src/new.ts"]);
});

test("a remembering judge is NOT enough on its own — content rules still bind", () => {
  // The two preconditions are AND, not OR: continuity buys nothing when the
  // increment reaches into a file the settled review never covered.
  const d = decideReviewScopeRaw({
    baseTree: "T",
    changedFiles: ["src/a.ts", "src/new.ts"],
    changedLines: 5,
    previouslyReviewedFiles: reviewed,
    judgeRemembersPreviousRound: true,
  });
  assert.equal(d.scope, "full");
  assert.match(d.reason, /never covered/);
});

test("no settled tree outranks the reader fact — the reason names the real cause", () => {
  // A session with nothing settled has nothing to carry forward either way;
  // reporting the transcript as the cause would send the reader looking at
  // the wrong thing.
  const d = decideReviewScopeRaw({
    changedFiles: ["src/a.ts"],
    changedLines: 1,
    judgeRemembersPreviousRound: false,
  });
  assert.equal(d.scope, "full");
  assert.match(d.reason, /no previous READY review/);
});

