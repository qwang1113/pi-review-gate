import { test } from "node:test";
import assert from "node:assert/strict";

const { parseReviewOutput, parsePrecommitOutput, parseFenceFindings, parseFenceFileFindings } = await import(
  new URL("../lib/verdict-parse.ts", import.meta.url).pathname
);

// ---- review (JSON fences only, no sentinels) ----

test("multi-fence: READY first, BLOCKED second → BLOCKED wins", () => {
  const out = "```json\n{\"gate\":\"READY\",\"findings\":[]}\n```\n```json\n{\"gate\":\"BLOCKED\",\"findings\":[{\"file\":\"a.ts\",\"line\":1,\"severity\":\"P1\",\"issue\":\"x\"}]}\n```";
  const p = parseReviewOutput(out);
  assert.equal(p!.verdict, "BLOCKED");
});

test("multi-fence: BLOCKED first, READY second → still BLOCKED", () => {
  const out = "```json\n{\"gate\":\"BLOCKED\",\"findings\":[]}\n```\n```json\n{\"gate\":\"READY\",\"findings\":[]}\n```";
  const p = parseReviewOutput(out);
  assert.equal(p!.verdict, "BLOCKED");
});

test("malformed fence does not poison later valid fence", () => {
  const out = "```json\n{truncated\n```\n```json\n{\"gate\":\"READY\",\"findings\":[]}\n```";
  const p = parseReviewOutput(out);
  assert.equal(p!.verdict, "READY");
});

test("zero recognizable verdicts → undefined (fail-closed)", () => {
  assert.equal(parseReviewOutput("no gates here"), undefined);
});

// P1: sentinel lines are NOT accepted by parseReviewOutput (review ≠ precommit).
test("review parser rejects ## Overall: sentinels", () => {
  assert.equal(parseReviewOutput("## Overall: ✅ PASS"), undefined);
  assert.equal(parseReviewOutput("## Gate: ✅ Ready"), undefined);
  assert.equal(parseReviewOutput("⛔ Blocked"), undefined);
});

test("READY with P0/P1 findings → downgraded to BLOCKED", () => {
  const out = '```json\n{"gate":"READY","findings":[{"file":"a.ts","line":1,"severity":"P1","issue":"crash"}],"findings_total":1}\n```';
  const p = parseReviewOutput(out);
  assert.equal(p!.verdict, "BLOCKED");
});

test("READY with only P2/Nit findings → stays READY", () => {
  const out = '```json\n{"gate":"READY","findings":[{"file":"a.ts","line":1,"severity":"P2","issue":"nit"}],"findings_total":1}\n```';
  const p = parseReviewOutput(out);
  assert.equal(p!.verdict, "READY");
});

test("findings counted and fingerprinted with line bucketing", () => {
  const out = '```json\n{"gate":"BLOCKED","findings":[{"file":"src/x.ts","line":42,"severity":"P1","issue":"null check"}]}\n```';
  const p = parseReviewOutput(out)!;
  assert.equal(p.findingsTotal, 1);
  assert.ok(p.findingFingerprints.some((f: string) => f.includes("src/x.ts") && f.includes("null check")));
});

test("verdict synonyms normalize", () => {
  assert.equal(parseReviewOutput('```json\n{"gate":"BLOCK","findings":[]}\n```')!.verdict, "BLOCKED");
  assert.equal(parseReviewOutput('```json\n{"status":"PASS","findings":[]}\n```')!.verdict, "READY");
});

// ---- malformed-fence recovery (fail-closed) ----

test("recovery: unescaped straight quotes break JSON but BLOCKED is salvaged", () => {
  // A real failure mode: a straight " inside the issue string breaks JSON.parse.
  const out = '```json\n{"gate":"BLOCKED","findings":[{"issue":"asserts "no reread" but does not"}]}\n```';
  const p = parseReviewOutput(out);
  assert.equal(p!.verdict, "BLOCKED");
  assert.equal(p!.findingsTotal, null, "salvaged findings are unparseable, not trusted");
});

test("recovery: salvaged READY is downgraded to BLOCKED (never fail-open)", () => {
  // Broken JSON (trailing junk) whose only readable token says READY must NOT
  // unlock the gate — a fence we could not fully parse may hide P0/P1.
  const out = '```json\n{"gate":"READY","findings":[{"issue":"broken "quote" here"}] TRAILING\n```';
  const p = parseReviewOutput(out);
  assert.equal(p!.verdict, "BLOCKED");
});

test("recovery: salvaged NEEDS_HUMAN is preserved", () => {
  const out = '```json\n{"gate":"NEEDS_HUMAN","note":"unescaped "x" breaks parse"}\n```';
  const p = parseReviewOutput(out);
  assert.equal(p!.verdict, "NEEDS_HUMAN");
});

test("recovery: a well-formed later fence still wins over a salvaged one", () => {
  // First fence is broken (salvages BLOCKED); second is clean READY. worst wins
  // → BLOCKED, so this is safe either way, but confirms recovery participates.
  const out =
    '```json\n{"gate":"BLOCKED","findings":[{"issue":"bad "q" mark"}]}\n```\n' +
    '```json\n{"gate":"READY","findings":[]}\n```';
  assert.equal(parseReviewOutput(out)!.verdict, "BLOCKED");
});

test("recovery: fence with no gate token at all → still undefined", () => {
  assert.equal(parseReviewOutput('```json\n{"notes":"just prose, no verdict"}\n```'), undefined);
});

// ---- raw-control-character salvage (string-internal newlines/tabs) ----

test("salvage: READY fence with raw newlines in a string stays READY with findings", () => {
  const out = "```json\n{\"gate\":\"READY\",\"findings\":[{\"severity\":\"P2\",\"issue\":\"line1\nline2\"}]}\n```";
  const p = parseReviewOutput(out);
  assert.equal(p!.verdict, "READY");
  assert.equal(p!.findingsTotal, 1);
});

test("salvage: BLOCKED fence with raw newlines stays BLOCKED", () => {
  const out = "```json\n{\"gate\":\"BLOCKED\",\"findings\":[{\"severity\":\"P1\",\"issue\":\"a\nb\"}]}\n```";
  const p = parseReviewOutput(out);
  assert.equal(p!.verdict, "BLOCKED");
  assert.equal(p!.findingsTotal, 1);
});

test("salvage: body damaged beyond raw control chars still recovers fail-closed", () => {
  // Unterminated string: escaping cannot repair it, so recoverFenceVerdict
  // salvages the gate word — READY downgrades to BLOCKED, findings untrusted.
  const out = "```json\n{\"gate\":\"READY\",\"findings\":[{\"severity\":\"P2\",\"issue\":\"unterminated\n}]}\n```";
  const p = parseReviewOutput(out);
  assert.equal(p!.verdict, "BLOCKED");
  assert.equal(p!.findingsTotal, null);
});

test("salvage: properly escaped backslash-n sequences are unaffected", () => {
  const out = "```json\n{\"gate\":\"READY\",\"findings\":[{\"severity\":\"P2\",\"issue\":\"line1\\nline2\"}]}\n```";
  const p = parseReviewOutput(out);
  assert.equal(p!.verdict, "READY");
  assert.equal(p!.findingsTotal, 1);
});

test("salvage: salvaged READY carrying P0/P1 findings still downgrades to BLOCKED", () => {
  // Escaping succeeds, but the shared P1 fix must not fail open: a READY
  // fence with unresolved P0/P1 findings is contradictory and becomes BLOCKED.
  const out = "```json\n{\"gate\":\"READY\",\"findings\":[{\"severity\":\"P1\",\"issue\":\"x\ny\"}]}\n```";
  const p = parseReviewOutput(out);
  assert.equal(p!.verdict, "BLOCKED");
});

// ---- docSync attestation parsing ----

test("docSync: valid attestations parse (docSync and doc_sync spellings, case-insensitive)", () => {
  assert.equal(parseReviewOutput('```json\n{"gate":"READY","docSync":"UPDATED","findings":[]}\n```')!.docSync, "UPDATED");
  assert.equal(parseReviewOutput('```json\n{"gate":"READY","doc_sync":"NOT_NEEDED","findings":[]}\n```')!.docSync, "NOT_NEEDED");
  assert.equal(parseReviewOutput('```json\n{"gate":"READY","docSync":"not_needed","findings":[]}\n```')!.docSync, "NOT_NEEDED");
});

test("docSync: unknown values fail closed to absent (whitelist only)", () => {
  for (const bad of ['"YES"', '"SKIPPED"', "true", "1", "null", '{"v":"UPDATED"}']) {
    const p = parseReviewOutput('```json\n{"gate":"READY","docSync":' + bad + ',"findings":[]}\n```');
    assert.equal(p!.docSync, undefined, bad);
  }
});

test("docSync: absent stays absent", () => {
  assert.equal(parseReviewOutput('```json\n{"gate":"READY","findings":[]}\n```')!.docSync, undefined);
});

test("docSync: agreeing equal-severity fences keep it; disagreeing fences drop it (fail-closed)", () => {
  const agree = parseReviewOutput(
    '```json\n{"gate":"READY","docSync":"UPDATED","findings":[]}\n```\n' +
    '```json\n{"gate":"READY","docSync":"UPDATED","findings":[]}\n```',
  );
  assert.equal(agree!.docSync, "UPDATED");

  const disagree = parseReviewOutput(
    '```json\n{"gate":"READY","docSync":"UPDATED","findings":[]}\n```\n' +
    '```json\n{"gate":"READY","docSync":"NOT_NEEDED","findings":[]}\n```',
  );
  assert.equal(disagree!.docSync, undefined, "contradiction → absent → blocks under enforcement");
});

test("docSync: worse fence wins wholesale — its attestation is kept", () => {
  const p = parseReviewOutput(
    '```json\n{"gate":"READY","docSync":"UPDATED","findings":[]}\n```\n' +
    '```json\n{"gate":"BLOCKED","docSync":"NOT_NEEDED","findings":[]}\n```',
  );
  assert.equal(p!.verdict, "BLOCKED");
  assert.equal(p!.docSync, "NOT_NEEDED");
});

// ---- precommit (## Overall: sentinels only) ----

test("precommit: PASS", () => {
  assert.equal(parsePrecommitOutput("## Overall: ✅ PASS"), "PASS");
});

test("precommit: FAIL", () => {
  assert.equal(parsePrecommitOutput("## Overall: ❌ FAIL"), "FAIL");
  assert.equal(parsePrecommitOutput("## Overall: ⛔ FAIL"), "FAIL");
});

test("precommit: NO_CHECKS_RUN", () => {
  assert.equal(parsePrecommitOutput("## Overall: ⚠️ NO CHECKS RUN"), "NO_CHECKS_RUN");
});

test("precommit: worst wins (FAIL > NO_CHECKS_RUN > PASS)", () => {
  // FAIL + PASS → FAIL
  assert.equal(parsePrecommitOutput("## Overall: ✅ PASS\n## Overall: ❌ FAIL"), "FAIL");
  // NO_CHECKS_RUN + PASS → NO_CHECKS_RUN
  assert.equal(parsePrecommitOutput("## Overall: ✅ PASS\n## Overall: ⚠️ NO CHECKS RUN"), "NO_CHECKS_RUN");
});

test("precommit: no sentinel → null", () => {
  assert.equal(parsePrecommitOutput("random output"), null);
});

// ---- parseFenceFindings (goal criterion 2: re-audit carryover) ----

test("parseFenceFindings extracts severity + issue from a single fence", () => {
  const out =
    '```json\n{"gate":"READY","findings":[{"severity":"P2","issue":"one"},{"severity":"P1","issue":"two"}]}\n```';
  assert.deepEqual(parseFenceFindings(out), [
    { severity: "P2", issue: "one" },
    { severity: "P1", issue: "two" },
  ]);
});

test("parseFenceFindings merges findings across multiple fences", () => {
  const out =
    '```json\n{"gate":"BLOCKED","findings":[{"severity":"P1","issue":"a"}]}\n``` ' +
    '```json\n{"gate":"READY","findings":[{"severity":"P2","issue":"b"}]}\n```';
  assert.deepEqual(parseFenceFindings(out), [
    { severity: "P1", issue: "a" },
    { severity: "P2", issue: "b" },
  ]);
});

test("parseFenceFindings: no findings, no fences, or unparseable fences → empty", () => {
  assert.deepEqual(parseFenceFindings('```json\n{"gate":"READY"}\n```'), []);
  assert.deepEqual(parseFenceFindings("no fence here"), []);
  // An unparseable fence is skipped, not fatal.
  assert.deepEqual(parseFenceFindings("```json\n{broken\n```"), []);
  // Findings without an `issue` string are skipped (cannot be carried).
  assert.deepEqual(parseFenceFindings('```json\n{"gate":"BLOCKED","findings":[{"severity":"P1"}]}\n```'), []);
});

test("parseFenceFindings salvages raw control chars inside strings, like parseReviewOutput does", () => {
  // A fence whose issue string contains a REAL newline parses via the verdict
  // parser's salvage; the findings extractor must not lose what the verdict
  // parser keeps — the carryover depends on it.
  const out =
    '```json\n{"gate":"BLOCKED","findings":[{"severity":"P1","issue":"line one\nline two"}]}\n```';
  const got = parseFenceFindings(out);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.severity, "P1");
  assert.equal(got[0]!.issue, "line one\nline two");
});

// ---- parseFenceFileFindings (round-18 polish gate: severity + file) ----

test("parseFenceFileFindings extracts severity + file per finding (polish gate input)", () => {
  const out =
    '```json\n{"gate":"READY","findings":[{"file":"src/a.ts","severity":"P2","issue":"one"},{"file":"src/b.ts","severity":"Nit","issue":"two"}]}\n```';
  assert.deepEqual(parseFenceFileFindings(out), [
    { severity: "P2", file: "src/a.ts" },
    { severity: "Nit", file: "src/b.ts" },
  ]);
});

test("parseFenceFileFindings: findings without a severity or a file are skipped", () => {
  const out =
    '```json\n{"gate":"BLOCKED","findings":[{"file":"a.ts","severity":"P1","issue":"x"},{"file":"b.ts","issue":"no-sev"},{"severity":"P2","issue":"no-file"}]}\n```';
  assert.deepEqual(parseFenceFileFindings(out), [
    { severity: "P1", file: "a.ts" },
  ]);
});

/**
 * Round-10 P1 (reviewer, reproduced): equal-severity aggregation rebuilt the
 * verdict WITHOUT cwd, so a reviewer that repeats its identical verdict first
 * and last — a format `agents/reviewer.md` explicitly calls safe — lost the
 * proof and was blocked by the very check meant to protect it. A gate that
 * punishes the format it recommends is worse than no gate.
 */
test("cwd survives equal-severity aggregation, and contradictions drop it", () => {
  const fence = (cwd: string): string =>
    '```json\n{"gate":"READY","cwd":"' + cwd + '","docSync":"NOT_NEEDED","findings":[]}\n```';

  const repeated = parseReviewOutput(`${fence("/repo")}\n\nprose in between\n\n${fence("/repo")}`);
  assert.equal(repeated.verdict, "READY");
  assert.equal(repeated.cwd, "/repo", "agreeing fences must keep the proof");

  // Two fences that disagree about where the review ran prove nothing —
  // dropping it is fail-closed (the gate blocks a READY with no cwd).
  const contradictory = parseReviewOutput(`${fence("/repo")}\n${fence("/evil/elsewhere")}`);
  assert.equal(contradictory.cwd, undefined, "a contradiction is not evidence");

  // But SILENCE is not contradiction: a terse fence that omits cwd must not
  // erase the value the other one reported. Treating absence as disagreement
  // reintroduced the same false rejection, in a shape reviewers actually
  // produce (short opening fence, full closing fence).
  const terse = '```json\n{"gate":"READY","docSync":"NOT_NEEDED","findings":[]}\n```';
  assert.equal(parseReviewOutput(`${terse}\n${fence("/repo")}`).cwd, "/repo", "terse first");
  assert.equal(parseReviewOutput(`${fence("/repo")}\n${terse}`).cwd, "/repo", "terse last");
  assert.equal(parseReviewOutput(`${terse}\n${terse}`).cwd, undefined, "nobody reported one");

  // A contradiction never un-happens. Folding is PAIRWISE, so remembering it
  // only as `undefined` let the next agreeing fence resurrect the value:
  // /evil + /repo + /repo folded back to "/repo" — the contradiction, washed
  // out by repetition. It must survive from ANY position in the sequence.
  for (const [label, fences] of [
    ["first", [fence("/evil"), fence("/repo"), fence("/repo")]],
    ["middle", [fence("/repo"), fence("/evil"), fence("/repo")]],
    ["last", [fence("/repo"), fence("/repo"), fence("/evil")]],
  ] as Array<[string, string[]]>) {
    assert.equal(parseReviewOutput(fences.join("\n")).cwd, undefined,
      `a contradiction in ${label} position must stick`);
  }
  // …while three genuinely agreeing fences still keep it.
  assert.equal(
    parseReviewOutput([fence("/repo"), terse, fence("/repo")].join("\n")).cwd,
    "/repo",
    "agreement interrupted by silence is still agreement",
  );
});

/**
 * The sticky conflict flag is DROPPED when a worse fence replaces the fold
 * wholesale. That is safe only because the fold is monotonic — a verdict never
 * gets better — so a forgotten conflict can never reach the cwd check, which
 * runs on READY alone. This test makes that argument checkable instead of
 * merely asserted in a comment.
 */
test("a dropped cwd conflict can never resurface as an approved READY", () => {
  const F = (gate: string, cwd?: string): string =>
    '```json\n{"gate":"' + gate + '"' + (cwd ? `,"cwd":"${cwd}"` : "") +
    ',"docSync":"NOT_NEEDED","findings":[]}\n```';

  // Contradiction, then a WORSE fence (takes over and forgets the conflict),
  // then agreeing READY fences trying to bring the verdict back.
  for (const heavier of ["BLOCKED", "NEEDS_HUMAN"]) {
    const out = parseReviewOutput(
      [F("READY", "/evil"), F("READY", "/repo"), F(heavier, "/x"), F("READY", "/repo")].join("\n"),
    );
    assert.notEqual(out.verdict, "READY",
      `${heavier} must hold — the fold is monotonic, so the cwd check is never reached`);
  }
});

/**
 * Round-11 P2 (reviewer-measured): a fence whose JSON is broken falls to the
 * salvage path, which recovers ONLY the gate word — no cwd. That is correct
 * and must stay correct: salvage reads untrusted, malformed text, so a loose
 * regex "recovering" a cwd from it would fabricate a report out of
 * exactly the input we trust least. It costs no honest reviewer anything,
 * because a salvaged READY is already downgraded before the cwd check runs.
 */
test("salvage recovers the gate word but never a cwd", () => {
  const broken = '```json\n{"gate":"READY","cwd":"/repo","notes":"he said "hi" there"}\n```';
  const salvaged = parseReviewOutput(broken);
  assert.equal(salvaged.verdict, "BLOCKED", "a salvaged READY is downgraded — pre-existing rule");
  assert.equal(salvaged.cwd, undefined, "malformed text must not become a reported cwd");
});

/**
 * Round-9 P1 (reviewer, reproduced): the schema and the task text have always
 * required the judge's own `pwd` and said the gate checks it — but the parser
 * DROPPED the field, so a fence claiming any cwd at all produced an identical
 * READY. The parser now carries it verbatim; the gate does the comparing.
 */
test("cwd travels verbatim so the gate can run its check", () => {
  const withCwd = parseReviewOutput('```json\n{"gate":"READY","cwd":"/repo/root","docSync":"NOT_NEEDED","findings":[]}\n```');
  assert.equal(withCwd.cwd, "/repo/root");

  // A dishonest value is NOT the parser's call — it must reach the gate intact.
  const elsewhere = parseReviewOutput('```json\n{"gate":"READY","cwd":"/evil/elsewhere","docSync":"NOT_NEEDED","findings":[]}\n```');
  assert.equal(elsewhere.cwd, "/evil/elsewhere");

  // Absent / blank / non-string ⇒ absent, so the gate sees "nothing reported".
  for (const fence of [
    '```json\n{"gate":"READY","docSync":"NOT_NEEDED","findings":[]}\n```',
    '```json\n{"gate":"READY","cwd":"   ","docSync":"NOT_NEEDED","findings":[]}\n```',
    '```json\n{"gate":"READY","cwd":42,"docSync":"NOT_NEEDED","findings":[]}\n```',
  ]) {
    assert.equal(parseReviewOutput(fence).cwd, undefined, fence);
  }
});

test("parseFenceFileFindings: unparseable fences are skipped, not fatal", () => {
  assert.deepEqual(parseFenceFileFindings("```json\n{broken\n```"), []);
  assert.deepEqual(parseFenceFileFindings("no fence"), []);
});
