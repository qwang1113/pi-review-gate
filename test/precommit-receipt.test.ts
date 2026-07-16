import { test } from "node:test";
import assert from "node:assert/strict";

import { validatePrecommitReceipt, type ReceiptExpectation } from "../lib/precommit-receipt.ts";

const EXP: ReceiptExpectation = {
  nonce: "N", cwd: "/repo", mode: "fast", exitStatus: 0, signal: null, spawnError: false,
};
function receipt(over: Record<string, unknown> = {}) {
  return { schema: 1, verdict: "PASS", mode: "fast", checksRun: 2, checksFailed: 0, nonce: "N", cwd: "/repo", ...over };
}

// --- happy paths -----------------------------------------------------------

test("valid PASS (exit 0, checks ran, none failed)", () => {
  const r = validatePrecommitReceipt(receipt(), EXP);
  assert.equal(r.verdict, "PASS");
});
test("valid FAIL (exit 1, a check failed)", () => {
  const r = validatePrecommitReceipt(receipt({ verdict: "FAIL", checksFailed: 1 }), { ...EXP, exitStatus: 1 });
  assert.equal(r.verdict, "FAIL");
});
test("valid NO_CHECKS_RUN (exit 2, zero checks)", () => {
  const r = validatePrecommitReceipt(receipt({ verdict: "NO_CHECKS_RUN", checksRun: 0, checksFailed: 0 }), { ...EXP, exitStatus: 2 });
  assert.equal(r.verdict, "NO_CHECKS_RUN");
});

// --- crashes / spawn problems ---------------------------------------------

test("spawn error → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt(), { ...EXP, spawnError: true }).verdict, "ERROR");
});
test("killed by signal → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt(), { ...EXP, signal: "SIGKILL", exitStatus: null }).verdict, "ERROR");
});

// --- identity / schema mismatches -----------------------------------------

test("wrong nonce → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt({ nonce: "X" }), EXP).verdict, "ERROR");
});
test("wrong cwd → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt({ cwd: "/evil" }), EXP).verdict, "ERROR");
});
test("wrong mode → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt({ mode: "full" }), EXP).verdict, "ERROR");
});
test("bad schema → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt({ schema: 2 }), EXP).verdict, "ERROR");
});
test("non-object → ERROR", () => {
  assert.equal(validatePrecommitReceipt(null, EXP).verdict, "ERROR");
  assert.equal(validatePrecommitReceipt("PASS", EXP).verdict, "ERROR");
});
test("invalid verdict value → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt({ verdict: "READY" }), EXP).verdict, "ERROR");
});

// --- exit / verdict / count contradictions → ERROR (the whole table) -------

test("exit 0 + FAIL → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt({ verdict: "FAIL", checksFailed: 1 }), { ...EXP, exitStatus: 0 }).verdict, "ERROR");
});
test("exit 0 + NO_CHECKS_RUN → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt({ verdict: "NO_CHECKS_RUN", checksRun: 0 }), { ...EXP, exitStatus: 0 }).verdict, "ERROR");
});
test("exit 1 + PASS → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt(), { ...EXP, exitStatus: 1 }).verdict, "ERROR");
});
test("exit 2 + PASS → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt(), { ...EXP, exitStatus: 2 }).verdict, "ERROR");
});
test("PASS with zero checks → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt({ checksRun: 0 }), EXP).verdict, "ERROR");
});
test("PASS with failed checks → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt({ checksFailed: 1 }), EXP).verdict, "ERROR");
});
test("FAIL with zero failed → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt({ verdict: "FAIL", checksFailed: 0 }), { ...EXP, exitStatus: 1 }).verdict, "ERROR");
});
test("NO_CHECKS_RUN with checks that ran → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt({ verdict: "NO_CHECKS_RUN", checksRun: 3 }), { ...EXP, exitStatus: 2 }).verdict, "ERROR");
});
test("checksFailed > checksRun → ERROR", () => {
  assert.equal(validatePrecommitReceipt(receipt({ verdict: "FAIL", checksRun: 1, checksFailed: 2 }), { ...EXP, exitStatus: 1 }).verdict, "ERROR");
});

// --- malformed counts ------------------------------------------------------

for (const bad of [1.5, -1, NaN, Infinity, "2", null]) {
  test(`checksRun=${String(bad)} → ERROR`, () => {
    assert.equal(validatePrecommitReceipt(receipt({ checksRun: bad }), EXP).verdict, "ERROR");
  });
}
