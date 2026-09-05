/**
 * Incremental review scoping — the escalation rules.
 *
 * An incremental round tells the reviewer "everything outside this increment
 * was already approved". That claim is only safe under conditions this module
 * has to enforce exactly, so every escalation path is pinned here: a missing
 * baseline, an unreadable increment, a too-large increment, and — the subtle
 * one — an increment that reaches into files the previous review never saw.
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
  decideReviewScope,
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
