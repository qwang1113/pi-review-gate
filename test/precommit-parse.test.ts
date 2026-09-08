import { test } from "node:test";
import assert from "node:assert/strict";

// The precommit half of the old test/verdict-parse.test.ts, moved with its
// module (lib/verdict-parse.ts → lib/precommit-parse.ts). The review half of
// that file went away with the fence round trip it tested; what a reviewer
// round now decides is pinned in test/review-adjudicate.test.ts.
const { parsePrecommitOutput } = await import(
  new URL("../lib/precommit-parse.ts", import.meta.url).pathname
);

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

test("precommit sentinels are the ONLY thing this parser recognises", () => {
  // Review and precommit are separate gates and always were: a judge's
  // conclusion never reaches this parser (it arrives structured on the channel
  // report), and prose that merely mentions a verdict is not a sentinel.
  assert.equal(parsePrecommitOutput('{"gate":"READY"}'), null);
  assert.equal(parsePrecommitOutput("## Gate: ✅ Ready"), null);
  assert.equal(parsePrecommitOutput("⛔ Blocked"), null);
  // The emoji is part of the sentinel — a bare word is not a receipt.
  assert.equal(parsePrecommitOutput("## Overall: PASS"), null);
});
