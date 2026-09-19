import { test } from "node:test";
import assert from "node:assert/strict";

import {
  adjudicateReviewConclusion,
  classifyReadyWithholding,
  fileFindingsFrom,
  findingFingerprint,
  normalizeConcludedVerdict,
  parkedLaneHalf,
  laneVerifiesTree,
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

// ---- the user-granted scope exemption (2026-09-19) ----
//
// `request_scope_limit` promises the USER that the gate "covers only this
// session's edits". Until now that promise reached the AGENT as a sentence and
// never reached the judge, so a round over a branch carrying someone else's
// 65-file diff came back BLOCKED on findings the session was not allowed to
// fix — measured in prime, where t2-auth-path-e2e and t3-report-update both
// deadlocked on `declare_done` that way.

test("scope exemption: a P0/P1 on an EXEMPTED file no longer turns a READY into BLOCKED", () => {
  const out = adjudicateReviewConclusion(
    { verdict: "READY", findings: [{ severity: "P1", issue: "x", file: "legacy/big.ts", line: 1 }] },
    { exemptFiles: ["legacy/big.ts"] },
  );
  assert.equal(out.verdict, "READY");
  assert.equal(out.findingsTotal, 1, "it is still REPORTED — recorded, not hidden");
  assert.equal(out.exemptedBlocking, 1, "…and the count lets the receipt say this READY leaned on it");
});

test("scope exemption: a P0/P1 on one of the SESSION'S OWN files still blocks", () => {
  const out = adjudicateReviewConclusion(
    {
      verdict: "READY",
      findings: [
        { severity: "P1", issue: "mine", file: "src/owned.ts", line: 1 },
        { severity: "P1", issue: "theirs", file: "legacy/big.ts", line: 1 },
      ],
    },
    { exemptFiles: ["legacy/big.ts"] },
  );
  assert.equal(out.verdict, "BLOCKED", "the exemption covers only the paths it names");
  assert.equal(out.exemptedBlocking, 1);
});

test("scope exemption FAILS CLOSED on every edge", () => {
  // No exemption in force ⇒ the old rule, byte for byte. This is the single
  // most important line in the block: the ordinary case must not move.
  assert.equal(
    adjudicateReviewConclusion({ verdict: "READY", findings: [{ severity: "P1", issue: "x", file: "legacy/big.ts" }] }).verdict,
    "BLOCKED",
  );
  // No `file` ⇒ IN SCOPE. A finding the reviewer could not locate is not a
  // finding on a file the user excused.
  assert.equal(
    adjudicateReviewConclusion(
      { verdict: "READY", findings: [{ severity: "P1", issue: "x" }] },
      { exemptFiles: ["legacy/big.ts"] },
    ).verdict,
    "BLOCKED",
  );
  // Matching is EXACT — a near-miss path stays blocking.
  for (const file of ["./legacy/big.ts", "legacy/other.ts", "legacy/big.tsx", "legacy/big.ts/"]) {
    assert.equal(
      adjudicateReviewConclusion(
        { verdict: "READY", findings: [{ severity: "P1", issue: "x", file }] },
        { exemptFiles: ["legacy/big.ts"] },
      ).verdict,
      "BLOCKED",
      file,
    );
  }
  // …and a P2 on an exempted file was never blocking in the first place.
  const p2 = adjudicateReviewConclusion(
    { verdict: "READY", findings: [{ severity: "P2", issue: "x", file: "legacy/big.ts" }] },
    { exemptFiles: ["legacy/big.ts"] },
  );
  assert.equal(p2.verdict, "READY");
  assert.equal(p2.exemptedBlocking, 0, "only P0/P1 can be exempted — there was nothing to exempt here");
});

test("scope exemption is TIGHTEN-ONLY: it never manufactures a READY the reviewer did not give", () => {
  // It removes findings from Rule 1's count. It does not rewrite a verdict —
  // a round that concluded BLOCKED, on its own files or on exempted ones, keeps
  // saying BLOCKED. Whoever wants the blocking question asked again re-runs the
  // round (which now receives the exemption in its task text).
  assert.equal(
    adjudicateReviewConclusion(
      { verdict: "BLOCKED", findings: [{ severity: "P1", issue: "theirs", file: "legacy/big.ts" }] },
      { exemptFiles: ["legacy/big.ts"] },
    ).verdict,
    "BLOCKED",
  );
  assert.equal(
    adjudicateReviewConclusion({ verdict: "NEEDS_HUMAN", findings: [] }, { exemptFiles: ["legacy/big.ts"] }).verdict,
    "NEEDS_HUMAN",
  );
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

test("parkedLaneHalf: ok needs the recorded tree to BE the round's; a landing that is not a replay vetoes", () => {
  const t = "9f2c";
  // A FRESH landing: only a PASS covering exactly the parked tree, while the
  // gate's current target is still that round, is `ok`.
  assert.equal(
    parkedLaneHalf({ parkedTree: t, laneVerdict: "PASS", coveredTree: t, currentTargetTree: t, laneRunning: false, bypassActive: false }),
    "ok",
  );
  for (const laneVerdict of ["FAIL", "no verdict", "ERROR"]) {
    assert.equal(
      parkedLaneHalf({ parkedTree: t, laneVerdict, coveredTree: undefined, currentTargetTree: t, laneRunning: false, bypassActive: false }),
      "veto",
      laneVerdict,
    );
  }
  // A PASS that covered OTHER content VETOES (round-2 P2): the lane has landed,
  // so nothing will come back for this conclusion, and leaving the record
  // behind would park the round until the next prepare — with the reply already
  // telling the agent not to re-submit.
  assert.equal(
    parkedLaneHalf({ parkedTree: t, laneVerdict: "PASS", coveredTree: "other", currentTargetTree: t, laneRunning: false, bypassActive: false }),
    "veto",
    "the lane passed a tree the round is not — nothing to replay onto it",
  );
  // …and a newer round replaced the target: the parked one is history.
  assert.equal(
    parkedLaneHalf({ parkedTree: t, laneVerdict: "PASS", coveredTree: t, currentTargetTree: "other", laneRunning: false, bypassActive: false }),
    "veto",
  );
  // NO fresh landing (the quality round's landing, the settle backstop): the
  // recorded facts decide, and a lane that is still running is what makes a
  // "not yet" answer a HOLD instead of a retirement.
  assert.equal(
    parkedLaneHalf({ parkedTree: t, coveredTree: t, currentTargetTree: t, laneRunning: false, bypassActive: false }),
    "ok",
    "the lane already passed this tree and nothing moved",
  );
  assert.equal(
    parkedLaneHalf({ parkedTree: t, coveredTree: undefined, currentTargetTree: t, laneRunning: true, bypassActive: false }),
    "pending",
  );
  assert.equal(
    parkedLaneHalf({ parkedTree: t, coveredTree: undefined, currentTargetTree: t, laneRunning: false, bypassActive: false }),
    "veto",
    "nobody is coming back to verify this content — a hold here is forever",
  );
  // An EMPTY id is unknown, not equal — the fail-closed direction.
  assert.equal(
    parkedLaneHalf({ parkedTree: "", coveredTree: "", currentTargetTree: "", laneRunning: true, bypassActive: false }),
    "veto",
  );
});

test("parkedLaneHalf: a /gate-bypass round owes no lane — 'no lane ran' is not a veto", () => {
  // THE TWO HALVES MUST AGREE (quality round P1, 2026-09-16). A bypassed
  // session never gets a full precommit lane (`submitForReview` skips it), so
  // the recorder already reads "bypass ⇒ nothing is missing"
  // (`readyLacksVerification`). The parked half did not, and the disagreement
  // was a loop: the parked READY came back as `veto`, was cleared with
  // "re-submit", and the re-submission parked into the identical state.
  const t = "9f2c";
  assert.equal(
    parkedLaneHalf({ parkedTree: t, coveredTree: undefined, currentTargetTree: t, laneRunning: false, bypassActive: true }),
    "ok",
    "no lane is owed, so the lane half is satisfied",
  );
  assert.equal(
    parkedLaneHalf({ parkedTree: t, coveredTree: "other", currentTargetTree: t, laneRunning: false, bypassActive: true }),
    "ok",
    "…and a stale covered tree from an earlier round changes nothing",
  );
  assert.equal(
    parkedLaneHalf({ parkedTree: t, coveredTree: t, currentTargetTree: "other", laneRunning: false, bypassActive: true }),
    "veto",
    "a round the gate has moved past is still not replayable",
  );
  // ONE rule, both callers: the bypass branch and the tree comparison are the
  // same function, so the recorder cannot drift away from this half again.
  assert.equal(laneVerifiesTree({ tree: t, coveredTree: undefined, bypassActive: true }), true);
  assert.equal(laneVerifiesTree({ tree: t, coveredTree: undefined, bypassActive: false }), false);
  assert.equal(laneVerifiesTree({ tree: t, coveredTree: t, bypassActive: false }), true);
  assert.equal(laneVerifiesTree({ tree: undefined, coveredTree: t, bypassActive: false }), false,
    "an unknown tree is never covered");
});

test("the recorder and the parked half answer the SAME question — one rule, so they cannot disagree again", () => {
  // THE PROPERTY THE UNIFICATION EXISTS FOR (quality round P1, 2026-09-16).
  // Every combination of bypass / covered tree / round tree goes through BOTH
  // halves: the parked half's `ok` must be exactly the recorder's "not
  // lacking", and `laneVerifiesTree` is what both of them read. Exhaustive on
  // purpose — the defect lived in one combination nobody had tried.
  const t = "9f2c";
  for (const bypassActive of [false, true]) {
    for (const coveredTree of [t, "other", undefined, ""]) {
      for (const tree of [t, "other", undefined, ""]) {
        const where = `bypass=${bypassActive} covered=${String(coveredTree)} tree=${String(tree)}`;
        const verified = laneVerifiesTree({ tree, coveredTree, bypassActive });
        assert.equal(
          readyLacksVerification({ precommitVerdict: "NOT_RUN", reviewedTree: tree, lastFullPassTree: coveredTree, bypassActive }),
          !verified,
          `the recorder disagrees with the shared rule: ${where}`,
        );
        // A round with no tree at all can never be replayed, bypass or not.
        const replayable = tree !== undefined && tree !== "";
        assert.equal(
          parkedLaneHalf({ parkedTree: tree, coveredTree, currentTargetTree: tree, laneRunning: false, bypassActive }) === "ok",
          verified && replayable,
          `the parked half disagrees with the shared rule: ${where}`,
        );
      }
    }
  }
});

test("parkedReadyFate: BOTH preconditions must be satisfied; any veto retires the record", () => {
  const t = "9f2c";
  assert.equal(parkedReadyFate({ parkedTree: t, lane: "ok", quality: "ok" }), "replay");
  // One precondition still owed ⇒ HOLD: this is the only outcome that keeps the
  // record alive for the landing that is owed, and it is why a reviewer READY
  // that arrives before the quality verdict survives instead of being refused.
  assert.equal(parkedReadyFate({ parkedTree: t, lane: "ok", quality: "pending" }), "hold");
  assert.equal(parkedReadyFate({ parkedTree: t, lane: "pending", quality: "ok" }), "hold");
  assert.equal(parkedReadyFate({ parkedTree: t, lane: "pending", quality: "pending" }), "hold");
  // Either half disproven ⇒ retired. `ok`+`veto` is the measured shape: a
  // READY parked on a running lane, whose quality round then blocked.
  assert.equal(parkedReadyFate({ parkedTree: t, lane: "veto", quality: "ok" }), "clear");
  assert.equal(parkedReadyFate({ parkedTree: t, lane: "ok", quality: "veto" }), "clear");
  assert.equal(parkedReadyFate({ parkedTree: t, lane: "pending", quality: "veto" }), "clear");
  // Nothing parked ⇒ nothing to do. An EMPTY id is unknown, not equal.
  assert.equal(parkedReadyFate({ parkedTree: undefined, lane: "ok", quality: "ok" }), "none");
  assert.equal(parkedReadyFate({ parkedTree: "", lane: "ok", quality: "ok" }), "none");
  // A WORKTREE EDIT IS NOT AN INPUT, deliberately: it moves none of these three
  // trees (the parked round's is the committed one, the lane's was captured
  // before it started), so there is nothing for a caller to pass in. The fix to
  // `docs/execution-model.md` and the skill (round-3 P2) was exactly this
  // confusion — the first wording told agents not to edit during a review,
  // which is the opposite of what this gate wants.
});
