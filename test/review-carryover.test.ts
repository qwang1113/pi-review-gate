/**
 * THE INCREMENTAL REVIEW CONTRACT — its wording and its ORDER.
 *
 * Two things are pinned here, and they fail differently.
 *
 * ORDER. The contract is defined as "the previous verdict, then the findings
 * it left open, then the mechanically computed delta, then the clauses that
 * bound them". A block that carries the same five facts in a different order
 * reads as a different instruction — the increment first, and the settled
 * conclusion becomes a footnote to it — so the sequence is asserted, not just
 * the presence of each part.
 *
 * WORDING. Two clauses do real work and are easy to lose in a reword: the
 * exemption covers only what the increment neither TOUCHED nor AFFECTED (and
 * deciding what it affects is the reviewer's job, not the gate's), and a
 * settled conclusion may always be reopened with evidence. Both were, at
 * different times, weakened into "skip what did not change" in one of the five
 * copies this module replaced.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decideReviewScope } from "../lib/review-scope.ts";
import {
  SCOPE_BLOCK_HEADING,
  SCOPE_MARKER_FULL,
  SCOPE_MARKER_INCREMENTAL,
  buildReviewCarryover,
  formatReviewScopeDirective,
} from "../lib/review-carryover.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const reviewed = ["src/a.ts", "src/b.ts"];

/** A decision that comes out incremental, for the adapter-facing tests. */
function incrementalDecision() {
  return decideReviewScope({
    baseTree: "T",
    changedFiles: ["src/a.ts"],
    changedLines: 3,
    previouslyReviewedFiles: reviewed,
  });
}

/** Index of a substring, asserted to exist — so ordering never compares -1s. */
function at(text: string, needle: string): number {
  const i = text.indexOf(needle);
  assert.ok(i >= 0, `the block must contain: ${needle}`);
  return i;
}

// ---------------------------------------------------------------------------
// The contract's structure and order
// ---------------------------------------------------------------------------

test("the incremental block states its five parts in the contract's order", () => {
  const text = formatReviewScopeDirective(incrementalDecision(), ["f1", "f2"], {
    verdict: "READY",
    at: "2026-08-17T01:00:00.000Z",
    rounds: 2,
  });
  const decision = at(text, SCOPE_MARKER_INCREMENTAL);
  const settled = at(text, "SETTLED last round");
  const findings = at(text, "MUST be re-checked one by one");
  const delta = at(text, "This round's increment");
  const clauses = at(text, "Outside the increment");
  const reopen = at(text, "Reopening is always allowed");
  assert.ok(
    decision < settled && settled < findings && findings < delta && delta < clauses && clauses < reopen,
    `contract order violated:\n${text}`,
  );
  // The heading is the block's first line — the marker is on the second.
  assert.ok(text.startsWith(SCOPE_BLOCK_HEADING), "the block announces itself first");
});

test("a full round keeps the same order for the parts it does have", () => {
  const text = formatReviewScopeDirective(decideReviewScope({}), ["f1"]);
  assert.ok(at(text, SCOPE_MARKER_FULL) < at(text, "MUST be re-checked one by one"));
  // …and claims nothing about settled material, because it settles nothing.
  assert.doesNotMatch(text, /SETTLED/);
  assert.doesNotMatch(text, /This round's increment/);
  assert.doesNotMatch(text, /Outside the increment/);
});

// ---------------------------------------------------------------------------
// The two clauses that do the work
// ---------------------------------------------------------------------------

test("the exemption covers only what the increment neither touched NOR AFFECTED", () => {
  const text = formatReviewScopeDirective(incrementalDecision(), [], { verdict: "READY" });
  // The carry-forward sentence and the consistency-scan sentence both state
  // the tightened condition — one of them alone would leave the other read as
  // the old "everything outside the increment" exemption.
  assert.match(text, /neither touched nor\s+affected stays settled/);
  assert.match(text, /neither TOUCHED nor AFFECTED gets a consistency/);
  // Whose job it is to decide that, said explicitly: the gate computed a file
  // list, not a blast radius.
  assert.match(text, /Deciding what the increment affects is YOUR/);
  assert.match(text, /it did not compute the blast radius/);
  // And it is never a licence to skip.
  assert.match(text, /not a re-derivation — and not a skip either/);
});

test("a settled conclusion can always be reopened with evidence", () => {
  const text = formatReviewScopeDirective(incrementalDecision(), [], { verdict: "READY" });
  assert.match(text, /Reopening is always allowed/);
  assert.match(text, /an economy, not a bar on your authority/);
  // The reviewer is told what does NOT justify looking away.
  assert.match(text, /"the last round said so" is never a reason/);
});

test("a wrong-looking block is overridable — the reviewer reviews in full and says so", () => {
  const text = formatReviewScopeDirective(incrementalDecision(), [], { verdict: "READY" }, "reviewer");
  assert.match(text, /If this block looks wrong/);
  assert.match(text, /review the change in full, and say so in the verdict/);
});

// ---------------------------------------------------------------------------
// The facts the block carries
// ---------------------------------------------------------------------------

test("an incremental block names the increment and still demands the full diff as context", () => {
  const text = formatReviewScopeDirective(incrementalDecision(), ["f1", "f2"]);
  assert.match(text, /INCREMENTAL/);
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /FULL diff as context/);
  assert.match(text, /re-checked one by one/);
  assert.match(text, /"f1"; "f2"/);
  // The delta says WHAT IT IS: a computed diff, not the reviewer's own triage.
  assert.match(text, /computed mechanically as the diff between the content/);
  assert.match(text, /1 file\(s\) \/ 3 line\(s\)/);
});

test("a full block says so plainly and never claims anything is pre-approved", () => {
  const text = formatReviewScopeDirective(decideReviewScope({}), []);
  assert.match(text, /FULL deep review/);
  assert.doesNotMatch(text, /consistency scan/);
  assert.doesNotMatch(text, /re-checked one by one/);
});

test("an incremental block carries the SETTLED conclusion of the previous round", () => {
  const text = formatReviewScopeDirective(incrementalDecision(), ["f1"], {
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
  assert.match(text, /Report it as MET\/unchanged instead of re-deriving it/);
});

test("no settled conclusion is claimed when none was passed, or on a FULL round", () => {
  const incremental = formatReviewScopeDirective(incrementalDecision(), []);
  assert.doesNotMatch(incremental, /SETTLED/, "without a previous verdict nothing is settled");

  // A full round re-derives everything by definition: a settled claim there
  // would be exactly the false reassurance the escalation exists to prevent.
  const full = formatReviewScopeDirective(decideReviewScope({}), [], { verdict: "READY", rounds: 9 });
  assert.match(full, /FULL deep review/);
  assert.doesNotMatch(full, /SETTLED/);
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

test("reviewer audience rewords the addressed sentences without duplicating the block", () => {
  // The SAME contract rides the reviewer's own task text. Only the sentences
  // that address the reader change — the decision, the increment, the settled
  // conclusion and the findings must stay identical, or the two surfaces
  // drift apart.
  const d = incrementalDecision();
  const settled = { verdict: "READY", at: "2026-08-27T00:00:00.000Z", rounds: 2 };
  const agent = formatReviewScopeDirective(d, ["f1"], settled, "agent");
  const reviewer = formatReviewScopeDirective(d, ["f1"], settled, "reviewer");
  assert.match(reviewer, /You still have the FULL diff as context/);
  assert.match(reviewer, /files were reviewed that you can see were not/);
  assert.doesNotMatch(reviewer, /Hand the reviewer the FULL diff/);
  assert.match(agent, /Hand the reviewer the FULL diff as context/);
  assert.match(agent, /files were reviewed that the reviewer can see were not/);
  for (const fact of ["INCREMENTAL", "src/a.ts", "SETTLED last round", '"f1"']) {
    assert.match(agent, new RegExp(fact));
    assert.match(reviewer, new RegExp(fact));
  }
});

test("reviewer audience: a full decision still says FULL deep review", () => {
  const text = formatReviewScopeDirective(decideReviewScope({}), [], undefined, "reviewer");
  assert.match(text, /FULL deep review/);
  assert.doesNotMatch(text, /Hand the reviewer/);
});

test("the settled file list elides past 20 names instead of pasting a branch diff", () => {
  const files = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
  const text = buildReviewCarryover({
    kind: "incremental",
    reason: "r",
    settled: { verdict: "READY" },
    delta: { files: ["src/f0.ts"], lines: 2, reviewedFiles: files },
  });
  assert.match(text, /25 file\(s\)/);
  assert.match(text, /, …/, "the list is elided, not printed whole");
  assert.ok(!text.includes("src/f24.ts"), "the 25th name is past the cut");
});

// ---------------------------------------------------------------------------
// The builder stands on its own inputs
// ---------------------------------------------------------------------------

test("the builder renders the contract from explicit facts, with no ReviewScopeDecision", () => {
  // The reason this is a builder and not a private renderer: a caller that
  // only holds a verdict, a findings list and a delta — a hand-off written
  // when a judge's transcript is rotated — must be able to produce the SAME
  // contract without inventing a decision object.
  const text = buildReviewCarryover({
    kind: "incremental",
    reason: "carried over after a transcript rotation",
    settled: { verdict: "READY", rounds: 4 },
    openFindings: ["lib/x.ts:12 — leaks a handle"],
    delta: { files: ["lib/x.ts", "lib/y.ts"], lines: 42 },
  });
  assert.ok(text.startsWith(SCOPE_BLOCK_HEADING));
  assert.match(text, /INCREMENTAL\. carried over after a transcript rotation\./);
  assert.match(text, /SETTLED last round — verdict READY, 4 round\(s\) recorded so far/);
  assert.match(text, /"lib\/x\.ts:12 — leaks a handle"/);
  assert.match(text, /2 file\(s\) \/ 42 line\(s\): lib\/x\.ts, lib\/y\.ts/);
  assert.match(text, /Outside the increment/);
  // With no reviewed-file list it must still be honest about what was covered.
  assert.match(text, /covering the change as it stood then/);
  // And the order holds on this path too — it is one renderer, not two.
  assert.ok(at(text, "SETTLED last round") < at(text, "MUST be re-checked one by one"));
  assert.ok(at(text, "MUST be re-checked one by one") < at(text, "This round's increment"));
});

test("the builder omits a delta it was not given, without pretending the round is full", () => {
  const text = buildReviewCarryover({
    kind: "incremental",
    reason: "no file list available",
    settled: { verdict: "READY" },
  });
  assert.match(text, /INCREMENTAL/);
  assert.doesNotMatch(text, /This round's increment/, "no delta was passed, so none is claimed");
  // The bounding clauses still apply: an increment nobody listed is not a
  // licence to skip anything.
  assert.match(text, /Outside the increment/);
  assert.match(text, /Reopening is always allowed/);
});

test("the line count is omitted rather than guessed when it was not counted", () => {
  const text = buildReviewCarryover({
    kind: "incremental",
    reason: "r",
    delta: { files: ["a.ts"] },
  });
  assert.match(text, /1 file\(s\): a\.ts/);
  assert.doesNotMatch(text, /line\(s\)/, "an uncounted delta must not report 0 lines");
});

// ---------------------------------------------------------------------------
// The markers are a wire format
// ---------------------------------------------------------------------------

test("each decision marker opens its own line — the judge side parses them back", () => {
  const inc = formatReviewScopeDirective(incrementalDecision(), []);
  const full = formatReviewScopeDirective(decideReviewScope({}), []);
  assert.ok(
    inc.split("\n").some((l) => l.startsWith(SCOPE_MARKER_INCREMENTAL)),
    "the incremental marker is a line prefix, not buried mid-sentence",
  );
  assert.ok(full.split("\n").some((l) => l.startsWith(SCOPE_MARKER_FULL)));
  // The two must not be confusable with each other.
  assert.ok(!inc.includes(SCOPE_MARKER_FULL));
  assert.ok(!full.includes(SCOPE_MARKER_INCREMENTAL));
});

// ---------------------------------------------------------------------------
// One authoritative source (philosophy three)
// ---------------------------------------------------------------------------

/**
 * Every prose surface that could restate the contract, read WHOLE.
 *
 * The REPO ROOT is in the list because that is where the copy this scan first
 * missed lived (AGENTS.md, round 1 P2): a scan whose reach stops one directory
 * short of the file everyone reads is a scan that reports "one source" while
 * six exist.
 */
function proseSurfaces(): Array<{ path: string; text: string }> {
  const roots = [
    { dir: ROOT, ext: ".md" },
    { dir: join(ROOT, "lib"), ext: ".ts" },
    { dir: join(ROOT, "agents"), ext: ".md" },
    { dir: join(ROOT, "docs"), ext: ".md" },
    { dir: join(ROOT, "skills", "review-loop"), ext: ".md" },
  ];
  const out: Array<{ path: string; text: string }> = [];
  for (const { dir, ext } of roots) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(ext)) continue;
      const rel = dir === ROOT ? name : `${dir.slice(ROOT.length + 1)}/${name}`;
      out.push({ path: rel, text: readFileSync(join(dir, name), "utf8") });
    }
  }
  return out;
}

test("the scan itself sees the files it claims to (before its verdict means anything)", () => {
  // A scan that quietly reads nothing passes every "nobody else says this"
  // assertion below. So: the surfaces must include the five known copies, and
  // the authoritative module must be among them with the clauses in it.
  const files = proseSurfaces();
  const paths = files.map((f) => f.path);
  for (const expected of [
    "lib/review-carryover.ts",
    "AGENTS.md",
    "QUICKSTART.md",
    "README.md",
    "lib/parallel-review.ts",
    "lib/workflow-commands.ts",
    "lib/judge-prompt.ts",
    "agents/reviewer.md",
    "docs/judge-protocol.md",
    "skills/review-loop/SKILL.md",
  ]) {
    assert.ok(paths.includes(expected), `the scan must cover ${expected}`);
  }
  const source = files.find((f) => f.path === "lib/review-carryover.ts")!;
  assert.ok(source.text.length > 2000, "…and read it whole, not a window of it");
});

test("the contract's clauses appear in exactly one file", () => {
  // These are the sentences that DO the work. Five copies of them existed
  // before this module; two had already drifted (one still granted a "skip").
  // A second copy anywhere is the drift starting again.
  const clauses = [
    "Reopening is always allowed",
    "not a re-derivation — and not a skip either",
    "Deciding what the increment affects is YOUR",
    "MUST be re-checked one by one",
    "This round's increment (deep-review these)",
  ];
  for (const clause of clauses) {
    const holders = proseSurfaces().filter((f) => f.text.includes(clause)).map((f) => f.path);
    assert.deepEqual(
      holders,
      ["lib/review-carryover.ts"],
      `"${clause}" must live only in the authoritative source`,
    );
  }
});

test("every surface that summarises the contract points at the source", () => {
  // Philosophy three does not forbid a summary — it forbids a SECOND
  // authority. A summary that never names the real one is indistinguishable
  // from a second authority to whoever reads it.
  //
  // DERIVED, NOT ALLOWLISTED (round-2 P2). This used to iterate a hardcoded
  // list of files, which is exactly how the seventh copy hid: a paraphrase in
  // a file nobody had listed passed a scan that had already read it. So the
  // set is COMPUTED — anything that talks about the contract, in either
  // language, must name its source — and a new surface is caught the day it
  // is written rather than the day someone remembers to list it.
  const TALKS_ABOUT_IT = /一致性扫描|consistency[ -]scan|Review scope for this round/i;
  const surfaces = proseSurfaces();
  const talkers = surfaces.filter(
    (f) => f.path !== "lib/review-carryover.ts" && TALKS_ABOUT_IT.test(f.text),
  );
  // The derivation must not have silently collapsed to nothing: a rule that
  // matches no files passes vacuously, which is the failure this whole test
  // exists to prevent. These are the surfaces known to summarise it today.
  for (const known of [
    "AGENTS.md",
    "QUICKSTART.md",
    "README.md",
    "docs/judge-protocol.md",
    "lib/parallel-review.ts",
    "skills/review-loop/SKILL.md",
  ]) {
    assert.ok(
      talkers.some((f) => f.path === known),
      `${known} summarises the contract, so the derivation must pick it up`,
    );
  }
  for (const file of talkers) {
    assert.match(
      file.text,
      /review-carryover\.ts/,
      `${file.path} talks about the incremental contract, so it must name lib/review-carryover.ts as its source`,
    );
  }
});

