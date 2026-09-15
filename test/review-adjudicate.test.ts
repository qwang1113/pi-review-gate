import { test } from "node:test";
import assert from "node:assert/strict";

import {
  adjudicateReviewConclusion,
  classifyReadyWithholding,
  fileFindingsFrom,
  findingFingerprint,
  normalizeConcludedVerdict,
  parkedReadyFate,
  readyLacksVerification,
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

// ---------------------------------------------------------------------------
// THE VERIFICATION BINDING (B1, 2026-09-10). `judge_submit` starts the full
// precommit BESIDE the chain rather than in front of it — the reviewer judges
// an immutable commit range, so only the checkpoint has to precede the
// dispatch, and the agent gets back the 33s it used to spend blocked. The
// checkpoint gate therefore accepts content whose lane is still running, and
// THIS is what refuses a READY on content that never passed it.
// ---------------------------------------------------------------------------

test("a READY without a full-lane PASS is withheld — and a bypass is the user's call, not the rule's", () => {
  assert.equal(readyLacksVerification({ precommitVerdict: "PASS", bypassActive: false }), false,
    "the ordinary path: verified, so nothing is withheld");
  for (const verdict of ["NOT_RUN", "FAIL", "PENDING", ""]) {
    assert.equal(readyLacksVerification({ precommitVerdict: verdict, bypassActive: false }), true,
      `"${verdict}" is not a PASS — nothing on that content is shippable, and a recorded READY would look verified while it is not`);
  }
  // /gate-bypass is the user's own authorization and outranks this rule,
  // exactly as it outranks the checkpoint gate it is standing in for.
  assert.equal(readyLacksVerification({ precommitVerdict: "NOT_RUN", bypassActive: true }), false,
    "a bypassed session records its verdict like any other — and the bypass is recorded ON the verdict");
});

test("the round's OWN tree counts as evidence, because the live binding is designed to be reset", () => {
  // 2026-09-14. `invalidateBindings` turns PASS into NOT_RUN the moment the
  // session edits something — correct for the live binding, wrong as an answer
  // to "was THIS round's content verified?": the round judged an immutable
  // commit, and the agent editing while it runs is the documented workflow.
  // `precommit.lastFullPassTree` (a tree a full lane passed) plus the prepared
  // review target's tree answer that question without touching the live field.
  const tree = "a".repeat(40);
  const other = "b".repeat(40);
  assert.equal(
    readyLacksVerification({ precommitVerdict: "NOT_RUN", lastFullPassTree: tree, reviewedTree: tree, bypassActive: false }),
    false,
    "the reviewed content really did pass a full lane",
  );
  assert.equal(
    readyLacksVerification({ precommitVerdict: "NOT_RUN", lastFullPassTree: other, reviewedTree: tree, bypassActive: false }),
    true,
    "a PASS for a DIFFERENT tree proves nothing about this one",
  );
  // Unknown on either side ⇒ fail-closed: the live verdict decides.
  for (const args of [
    { lastFullPassTree: undefined, reviewedTree: tree },
    { lastFullPassTree: tree, reviewedTree: undefined },
    { lastFullPassTree: "", reviewedTree: tree },
    { lastFullPassTree: tree, reviewedTree: "" },
  ]) {
    assert.equal(
      readyLacksVerification({ precommitVerdict: "NOT_RUN", bypassActive: false, ...args }),
      true,
      `an unknown tree is not evidence: ${JSON.stringify(args)}`,
    );
  }
  // The live PASS still wins on its own, with no tree involved.
  assert.equal(
    readyLacksVerification({ precommitVerdict: "PASS", lastFullPassTree: undefined, reviewedTree: undefined, bypassActive: false }),
    false,
  );
  // And an old caller (neither field) behaves exactly as before.
  assert.equal(readyLacksVerification({ precommitVerdict: "NOT_RUN", bypassActive: false }), true);
});

// ---- holding a READY instead of refusing it (2026-09-15) ----

test("classifyReadyWithholding: only a fact about TIME is held; the rest are refused", () => {
  const base = {
    concluded: "READY",
    blockingFinding: false,
    staleTarget: false,
    lacksVerification: false,
    laneStillRunning: false,
    cwdMismatch: false,
  };
  assert.equal(classifyReadyWithholding(base), "none");
  // The one reason the gate HOLDS: the reviewer outran its full lane, and that
  // lane is STILL RUNNING so its landing will come back for the conclusion.
  // Measured on this repository — 16s of review against a 34s lane, seven
  // seconds short — and the old reading refused the round over it.
  assert.equal(
    classifyReadyWithholding({ ...base, lacksVerification: true, laneStillRunning: true }),
    "unverified",
  );
  // THE SAME FACT WITH NOBODY LEFT TO ACT ON IT IS A REFUSAL (round-1 P1): the
  // only things that revive a parked conclusion are that lane's landing and the
  // next round's prepare, so holding here parks the round forever — while the
  // reply tells the agent not to re-submit.
  assert.equal(
    classifyReadyWithholding({ ...base, lacksVerification: true, laneStillRunning: false }),
    "unverified-idle",
  );
  // The three that are facts about the WORK, not about time.
  assert.equal(classifyReadyWithholding({ ...base, staleTarget: true }), "stale");
  assert.equal(classifyReadyWithholding({ ...base, cwdMismatch: true }), "cwd-mismatch");
  assert.equal(classifyReadyWithholding({ ...base, blockingFinding: true }), "blocking-finding");

  // ORDER IS THE CONTRACT. A round that is both stale and unverified is
  // REFUSED, not held: the checkpoint it judged is gone, so a PASS on its tree
  // would bind a READY to content nobody is looking at any more.
  assert.equal(
    classifyReadyWithholding({ ...base, staleTarget: true, lacksVerification: true, laneStillRunning: true }),
    "stale",
  );
  assert.equal(
    classifyReadyWithholding({ ...base, blockingFinding: true, lacksVerification: true, laneStillRunning: true }),
    "blocking-finding",
  );
  // A BLOCKED conclusion is never withheld — there is nothing to hold.
  assert.equal(classifyReadyWithholding({ ...base, concluded: "BLOCKED" }), "none");
});

test("parkedReadyFate: replay needs all three ids, clear needs a failed lane, the rest is 'leave it'", () => {
  const t = "9f2c";
  // All three agree ⇒ the held round becomes the verdict it always was.
  assert.equal(
    parkedReadyFate({ parkedTree: t, laneVerdict: "PASS", coveredTree: t, currentTargetTree: t }),
    "replay",
  );
  // A lane that came back with anything but PASS retires the parked round: its
  // content is now known bad, and the failure channel already says so in the
  // language of verification.
  for (const laneVerdict of ["FAIL", "no verdict", "ERROR"]) {
    assert.equal(
      parkedReadyFate({ parkedTree: t, laneVerdict, coveredTree: undefined, currentTargetTree: t }),
      "clear",
      laneVerdict,
    );
  }
  // A PASS that covered OTHER content RETIRES it too (round-2 P2): the lane has
  // landed, so nothing will come back for this conclusion, and leaving the
  // record behind would park the round until the next prepare — with the reply
  // already telling the agent not to re-submit.
  assert.equal(
    parkedReadyFate({ parkedTree: t, laneVerdict: "PASS", coveredTree: "other", currentTargetTree: t }),
    "clear",
    "the session edited while the lane ran — that round judged a tree nobody holds",
  );
  // …and a newer round replaced the target: the parked one is history.
  assert.equal(
    parkedReadyFate({ parkedTree: t, laneVerdict: "PASS", coveredTree: t, currentTargetTree: "other" }),
    "clear",
  );
  // Nothing parked ⇒ nothing to do.
  assert.equal(
    parkedReadyFate({ parkedTree: undefined, laneVerdict: "PASS", coveredTree: t, currentTargetTree: t }),
    "none",
  );
  // An EMPTY id is unknown, not equal — the fail-closed direction.
  assert.equal(
    parkedReadyFate({ parkedTree: "", laneVerdict: "PASS", coveredTree: "", currentTargetTree: "" }),
    "none",
  );
  assert.equal(
    parkedReadyFate({ parkedTree: t, laneVerdict: "PASS", coveredTree: undefined, currentTargetTree: t }),
    "clear",
    "an unreadable tree is not evidence of a match — and the lane is gone either way",
  );
  assert.equal(
    parkedReadyFate({ parkedTree: t, laneVerdict: "PASS", coveredTree: t, currentTargetTree: undefined }),
    "clear",
  );
});
