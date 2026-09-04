import { test } from "node:test";
import assert from "node:assert/strict";

import {
  adjudicateReviewConclusion,
  fileFindingsFrom,
  findingFingerprint,
  normalizeConcludedVerdict,
  severityFindingsFrom,
  type ReviewFinding,
} from "../lib/review-adjudicate.ts";

// These are the reviewer adjudication rules that used to live inside
// `parseReviewOutput` (lib/verdict-parse.ts) and travelled through a
// synthesised ```json fence. The fence round trip is gone; the RULES are not,
// and each test below pins one against the behaviour it replaced.

// ---- rule 1: a READY carrying an open P0/P1 is contradictory ----

test("READY with an open P0 or P1 finding is downgraded to BLOCKED", () => {
  for (const severity of ["P0", "P1", "p0", "p1", "P1 (blocker)"]) {
    const out = adjudicateReviewConclusion({
      verdict: "READY",
      findings: [{ severity, issue: "x", file: "a.ts", line: 3 }],
    });
    assert.equal(out.verdict, "BLOCKED", severity);
  }
});

test("READY with only P2/Nit findings stays READY", () => {
  const out = adjudicateReviewConclusion({
    verdict: "READY",
    findings: [
      { severity: "P2", issue: "polish", file: "a.ts", line: 3 },
      { severity: "Nit", issue: "style", file: "b.ts", line: 9 },
    ],
  });
  assert.equal(out.verdict, "READY");
  assert.equal(out.findingsTotal, 2);
});

test("the downgrade is TIGHTEN-ONLY: a BLOCKED or NEEDS_HUMAN never becomes READY", () => {
  assert.equal(adjudicateReviewConclusion({ verdict: "BLOCKED", findings: [] }).verdict, "BLOCKED");
  assert.equal(adjudicateReviewConclusion({ verdict: "NEEDS_HUMAN", findings: [] }).verdict, "NEEDS_HUMAN");
});

// ---- rule 2: the finding count ----

test("findingsTotal is the number of findings concluded — no self-reported total exists", () => {
  assert.equal(adjudicateReviewConclusion({ verdict: "READY", findings: [] }).findingsTotal, 0);
  assert.equal(
    adjudicateReviewConclusion({
      verdict: "BLOCKED",
      findings: [
        { severity: "P1", issue: "a" },
        { severity: "P2", issue: "b" },
        { severity: "P2", issue: "c" },
      ],
    }).findingsTotal,
    3,
  );
});

// ---- rule 3: the COARSE cross-round fingerprint ----

test("fingerprints bucket the line by ten and truncate the issue at 80 chars", () => {
  // Same shape the fence parser produced: `file # line÷10 # issue.slice(0,80)`.
  assert.equal(findingFingerprint({ severity: "P1", file: "a.ts", line: 17, issue: "boom" }), "a.ts#1#boom");
  assert.equal(findingFingerprint({ severity: "P1", file: "a.ts", line: 11, issue: "boom" }), "a.ts#1#boom",
    "a small drift inside the same bucket still matches itself next round");
  assert.equal(findingFingerprint({ severity: "P1", file: "a.ts", line: 23, issue: "boom" }), "a.ts#2#boom");
  const long = "x".repeat(100);
  assert.equal(findingFingerprint({ severity: "P2", file: "a.ts", line: 0, issue: long }), `a.ts#0#${"x".repeat(80)}`);
});

test("a finding with neither file nor issue produces no fingerprint (but is still counted)", () => {
  assert.equal(findingFingerprint({ severity: "P2", issue: "" }), undefined);
  const out = adjudicateReviewConclusion({
    verdict: "BLOCKED",
    findings: [{ severity: "P2", issue: "" }, { severity: "P1", issue: "real", file: "a.ts", line: 4 }],
  });
  assert.equal(out.findingsTotal, 2, "the count is the array length, not the fingerprint count");
  assert.deepEqual(out.findingFingerprints, ["a.ts#0#real"]);
});

test("fingerprints are ONE PER FINDING, in order — never collapsed", () => {
  // The old fence parser deduplicated only across two fences of one output.
  // A round is one structured call now, so this is the within-one-fence case,
  // where it kept one entry per finding. Collapsing them here would be a new
  // behaviour that `isPlateaued` can see: it compares consecutive rounds'
  // fingerprint sets AND their sizes.
  const out = adjudicateReviewConclusion({
    verdict: "BLOCKED",
    findings: [
      { severity: "P1", file: "a.ts", line: 1, issue: "boom" },
      { severity: "P1", file: "b.ts", line: 1, issue: "other" },
      { severity: "P2", file: "a.ts", line: 3, issue: "boom" }, // same COARSE key, different finding
    ],
  });
  assert.deepEqual(out.findingFingerprints, ["a.ts#0#boom", "b.ts#0#other", "a.ts#0#boom"]);
  assert.equal(out.findingsTotal, 3);
});

// ---- docSync and cwd travel verbatim, whitelist-guarded ----

test("docSync accepts only the whitelist, case-insensitively; anything else is absent", () => {
  assert.equal(adjudicateReviewConclusion({ verdict: "READY", findings: [], docSync: "UPDATED" }).docSync, "UPDATED");
  assert.equal(adjudicateReviewConclusion({ verdict: "READY", findings: [], docSync: "not_needed" }).docSync, "NOT_NEEDED");
  for (const bad of ["", "yes", "UPDATED!", "PARTIAL"]) {
    assert.equal(
      adjudicateReviewConclusion({ verdict: "READY", findings: [], docSync: bad }).docSync,
      undefined,
      bad,
    );
  }
  assert.equal(adjudicateReviewConclusion({ verdict: "READY", findings: [] }).docSync, undefined);
});

test("cwd travels verbatim (trimmed); blank is absent — the gate does the comparing", () => {
  assert.equal(adjudicateReviewConclusion({ verdict: "READY", findings: [], cwd: " /repo " }).cwd, "/repo");
  assert.equal(adjudicateReviewConclusion({ verdict: "READY", findings: [], cwd: "   " }).cwd, undefined);
  assert.equal(
    adjudicateReviewConclusion({ verdict: "READY", findings: [], cwd: "/evil/elsewhere" }).cwd,
    "/evil/elsewhere",
    "this module does not judge the value",
  );
});

// ---- the fail-closed edge for a record the gate does not recognise ----

test("normalizeConcludedVerdict recognises exactly the three verdicts, nothing else", () => {
  assert.equal(normalizeConcludedVerdict("READY"), "READY");
  assert.equal(normalizeConcludedVerdict(" blocked "), "BLOCKED");
  assert.equal(normalizeConcludedVerdict("needs_human"), "NEEDS_HUMAN");
  // No salvage, no synonyms: an unrecognised verdict records NOTHING, which
  // leaves the gate PENDING rather than open.
  for (const bad of [undefined, "", "PASS", "FAIL", "MERGEABLE", "READY-ish", "## Overall: ✅ PASS"]) {
    assert.equal(normalizeConcludedVerdict(bad), undefined, String(bad));
  }
});

// ---- the two projections the recorders consume ----

test("fileFindingsFrom keeps severity+file and drops findings with no file", () => {
  const findings: ReviewFinding[] = [
    { severity: "P2", file: "a.ts", line: 1, issue: "polish" },
    { severity: "P1", issue: "no file at all" },
    { severity: "P1", file: "   ", issue: "blank file" },
    { severity: "  ", file: "b.ts", issue: "no severity" },
  ];
  assert.deepEqual(fileFindingsFrom(findings), [{ severity: "P2", file: "a.ts" }]);
});

test("severityFindingsFrom keeps the objections verbatim, defaulting a missing severity to P2", () => {
  const findings = [
    { severity: "P1", issue: "阻塞项" },
    { severity: "", issue: "无严重度" },
    { severity: "P2", issue: "" },
  ] as ReviewFinding[];
  assert.deepEqual(severityFindingsFrom(findings), [
    { severity: "P1", issue: "阻塞项" },
    { severity: "P2", issue: "无严重度" },
  ]);
});
