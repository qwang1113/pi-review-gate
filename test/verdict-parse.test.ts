import { test } from "node:test";
import assert from "node:assert/strict";

const { parseReviewOutput, parsePrecommitOutput } = await import(
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
