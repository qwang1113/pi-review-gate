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
  assert.ok(p.findingFingerprints.some(f => f.includes("src/x.ts") && f.includes("null check")));
});

test("verdict synonyms normalize", () => {
  assert.equal(parseReviewOutput('```json\n{"gate":"BLOCK","findings":[]}\n```')!.verdict, "BLOCKED");
  assert.equal(parseReviewOutput('```json\n{"status":"PASS","findings":[]}\n```')!.verdict, "READY");
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
