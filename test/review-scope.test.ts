/**
 * Incremental review scoping — the escalation rules.
 *
 * An incremental round tells the reviewer "everything outside this increment
 * was already approved". That claim is only safe under conditions this module
 * has to enforce exactly, so every escalation path is pinned here: a missing
 * baseline, an unreadable increment, a too-large increment, and — the subtle
 * one — an increment that reaches into files the previous review never saw.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INCREMENT_MAX_FILES,
  INCREMENT_MAX_LINES,
  decideReviewScope,
  formatReviewScopeDirective,
} from "../lib/review-scope.ts";

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

// ---------------------------------------------------------------------------
// Directive text — what the agent actually hands the reviewer
// ---------------------------------------------------------------------------

test("an incremental directive names the increment and still demands the full diff as context", () => {
  const d = decideReviewScope({
    baseTree: "T",
    changedFiles: ["src/a.ts"],
    changedLines: 3,
    previouslyReviewedFiles: reviewed,
  });
  const text = formatReviewScopeDirective(d, ["f1", "f2"]);
  assert.match(text, /INCREMENTAL/);
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /FULL diff as context/);
  assert.match(text, /re-checked one by one/);
  assert.match(text, /"f1"; "f2"/);
});

test("a full directive says so plainly and never claims anything is pre-approved", () => {
  const text = formatReviewScopeDirective(decideReviewScope({}), []);
  assert.match(text, /FULL deep review/);
  assert.doesNotMatch(text, /Already reviewed/);
  assert.doesNotMatch(text, /re-checked one by one/);
});

test("an incremental directive carries the SETTLED conclusion of the previous round", () => {
  // The point of an incremental round: what the last verdict settled and the
  // increment did not touch is not re-argued at max thinking every round.
  const d = decideReviewScope({
    baseTree: "T",
    changedFiles: ["src/a.ts"],
    changedLines: 3,
    previouslyReviewedFiles: reviewed,
  });
  const text = formatReviewScopeDirective(d, ["f1"], {
    verdict: "READY",
    at: "2026-08-17T01:00:00.000Z",
    rounds: 2,
  });
  assert.match(text, /SETTLED last round/);
  assert.match(text, /verdict READY/);
  // A running count, worded as such: it is NOT a claim about which round
  // produced the READY verdict (later rounds are included in the count).
  assert.match(text, /2 round\(s\) recorded so far/);
  assert.match(text, /2026-08-17T01:00:00\.000Z/);
  assert.match(text, new RegExp(reviewed[0]!.replace(/[/.]/g, "\\$&")), "it must name what was covered");
  assert.match(text, /Do not re-derive or re-litigate it/);
  // …but the reviewer's authority is untouched: it may always reopen it.
  assert.match(text, /reopen it/);
  assert.match(text, /not a bar on your authority/);
});

test("no settled conclusion is claimed when none was passed, or on a FULL round", () => {
  const incremental = formatReviewScopeDirective(
    decideReviewScope({
      baseTree: "T",
      changedFiles: ["src/a.ts"],
      changedLines: 3,
      previouslyReviewedFiles: reviewed,
    }),
    [],
  );
  assert.doesNotMatch(incremental, /SETTLED/, "without a previous verdict nothing is settled");

  // A full round re-derives everything by definition: a settled claim there
  // would be exactly the false reassurance the escalation exists to prevent.
  const full = formatReviewScopeDirective(decideReviewScope({}), [], {
    verdict: "READY",
    rounds: 9,
  });
  assert.match(full, /FULL deep review/);
  assert.doesNotMatch(full, /SETTLED/);
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

test("a FULL round still lists the previous findings to re-check one by one", () => {
  // The findings block is independent of the scope branch — escalating to a
  // full review must not drop last round's open findings on the floor.
  const text = formatReviewScopeDirective(decideReviewScope({}), ["f1", "f2"]);
  assert.match(text, /FULL deep review/);
  assert.match(text, /re-checked one by one/);
  assert.match(text, /"f1"; "f2"/);
  assert.doesNotMatch(text, /SETTLED/, "a full round settles nothing in advance");
});
