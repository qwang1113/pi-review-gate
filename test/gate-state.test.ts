import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  emptyState,
  isPlateaued,
  loadSidecar,
  saveSidecar,
  sidecarPath,
  unmetRequirements,
  type GateState,
  type RoundRecord,
} from "../lib/gate-state.ts";

const tempDirs: string[] = [];
function makeTemp(): string {
  const d = mkdtempSync(join(tmpdir(), "rg-state-"));
  tempDirs.push(d);
  return d;
}
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const FP = "f".repeat(64);
const OTHER_FP = "0".repeat(64);

function readyState(): GateState {
  const s = emptyState("sess1", 10);
  s.hasCodeChange = true;
  s.review = { verdict: "READY", fingerprint: FP, at: "t" };
  s.precommit = { verdict: "PASS", fingerprint: FP, at: "t" };
  return s;
}

// ---------------------------------------------------------------------------
// unmetRequirements — the single ship authority
// ---------------------------------------------------------------------------

test("all gates met on same fingerprint → ship allowed", () => {
  assert.deepEqual(unmetRequirements(readyState(), FP, false), []);
});

test("missing state → fail closed", () => {
  assert.ok(unmetRequirements(undefined, FP, false).length > 0);
});

test("no changes tracked → ship allowed (pre-existing work)", () => {
  const s = emptyState("sess1", 10);
  assert.deepEqual(unmetRequirements(s, FP, false), []);
});

test("review PENDING blocks", () => {
  const s = readyState();
  s.review.verdict = "PENDING";
  assert.ok(unmetRequirements(s, FP, false).some((p) => p.includes("PENDING")));
});

test("review READY but fingerprint mismatch blocks (edit-after-review)", () => {
  const s = readyState();
  assert.ok(unmetRequirements(s, OTHER_FP, false).some((p) => p.includes("fingerprint mismatch")));
});

test("precommit NOT_RUN blocks", () => {
  const s = readyState();
  s.precommit = { verdict: "NOT_RUN", fingerprint: null, at: null };
  assert.ok(unmetRequirements(s, FP, false).some((p) => p.includes("not run")));
});

test("precommit FAIL blocks", () => {
  const s = readyState();
  s.precommit = { verdict: "FAIL", fingerprint: null, at: "t" };
  assert.ok(unmetRequirements(s, FP, false).some((p) => p.includes("FAILED")));
});

test("PR #7 lesson 3: precommit NO_CHECKS_RUN blocks (not a pass)", () => {
  const s = readyState();
  s.precommit = { verdict: "NO_CHECKS_RUN", fingerprint: null, at: "t" };
  assert.ok(unmetRequirements(s, FP, false).some((p) => p.includes("NO_CHECKS_RUN")));
});

test("precommit PASS on stale fingerprint blocks", () => {
  const s = readyState();
  s.precommit.fingerprint = OTHER_FP;
  assert.ok(unmetRequirements(s, FP, false).some((p) => p.includes("precommit PASS (fingerprint mismatch)")));
});

test("fingerprint unavailable → fail closed even when verdicts look good", () => {
  const s = readyState();
  assert.ok(unmetRequirements(s, "__UNAVAILABLE__", true).length > 0);
});

test("doc-only change: needs doc review READY, no precommit requirement", () => {
  const s = emptyState("sess1", 10);
  s.hasDocChange = true;
  assert.ok(unmetRequirements(s, FP, false).some((p) => p.includes("doc review")));
  s.review = { verdict: "READY", fingerprint: FP, at: "t" };
  assert.deepEqual(unmetRequirements(s, FP, false), []);
});

test("bypass overrides everything", () => {
  const s = emptyState("sess1", 10);
  s.hasCodeChange = true;
  s.bypass = { active: true, reason: "hotfix", at: "t" };
  assert.deepEqual(unmetRequirements(s, FP, false), []);
});

// ---------------------------------------------------------------------------
// Sidecar persistence — fail-closed on corruption
// ---------------------------------------------------------------------------

test("sidecar round-trip", () => {
  const dir = makeTemp();
  const path = sidecarPath(dir);
  const s = readyState();
  saveSidecar(path, s);
  const loaded = loadSidecar(path);
  assert.equal(loaded?.review.verdict, "READY");
  assert.equal(loaded?.precommit.verdict, "PASS");
});

test("corrupt sidecar JSON → undefined (fail closed)", () => {
  const dir = makeTemp();
  const path = sidecarPath(dir);
  saveSidecar(path, readyState());
  writeFileSync(path, '{"schema": 1, "review": {'); // truncate
  assert.equal(loadSidecar(path), undefined);
});

test("unknown schema → undefined (fail closed)", () => {
  const dir = makeTemp();
  const path = sidecarPath(dir);
  saveSidecar(path, readyState());
  writeFileSync(path, JSON.stringify({ schema: 99, review: { verdict: "READY" } }));
  assert.equal(loadSidecar(path), undefined);
});

test("missing sidecar → undefined", () => {
  assert.equal(loadSidecar(join(makeTemp(), "nope.json")), undefined);
});

// ---------------------------------------------------------------------------
// Plateau detection
// ---------------------------------------------------------------------------

function round(n: number, total: number | null, fps: string[]): RoundRecord {
  return { round: n, findingsTotal: total, fingerprints: fps, at: "t" };
}

test("plateau: same findings 3 rounds, non-decreasing → true", () => {
  const rounds = [
    round(1, 3, ["a#1#x", "b#2#y", "c#3#z"]),
    round(2, 3, ["a#1#x", "b#2#y", "c#3#z"]),
    round(3, 3, ["a#1#x", "b#2#y", "d#4#w"]),
  ];
  assert.ok(isPlateaued(rounds, 3));
});

test("converging (totals decreasing) → not plateaued", () => {
  const rounds = [round(1, 5, ["a#1#x"]), round(2, 3, ["a#1#x"]), round(3, 1, ["a#1#x"])];
  assert.ok(!isPlateaued(rounds, 3));
});

test("new issues each round (low overlap) → not plateaued", () => {
  const rounds = [
    round(1, 2, ["a#1#x", "b#1#y"]),
    round(2, 2, ["c#1#z", "d#1#w"]),
    round(3, 2, ["e#1#v", "f#1#u"]),
  ];
  assert.ok(!isPlateaued(rounds, 3));
});

test("unparseable totals (null) → not plateaued (rely on hard cap)", () => {
  const rounds = [round(1, null, []), round(2, null, []), round(3, null, [])];
  assert.ok(!isPlateaued(rounds, 3));
});

test("fewer rounds than window → not plateaued", () => {
  assert.ok(!isPlateaued([round(1, 3, ["a#1#x"])], 3));
});

// ---------------------------------------------------------------------------
// P1 fail-closed regression: unknown/forged verdicts must never fail-open.

test("loadSidecar rejects forged precommit.verdict='READY' (not a precommit enum)", () => {
  const p = sidecarPath(makeTemp());
  const bad = emptyState("sess1", 10);
  bad.hasCodeChange = true;
  bad.review = { verdict: "READY", fingerprint: FP, at: "t" };
  // "READY" is a REVIEW verdict, not a valid PRECOMMIT verdict.
  (bad.precommit as unknown as { verdict: string }).verdict = "READY";
  saveSidecar(p, emptyState("sess1", 10)); // create the .pi dir + a valid file first
  writeFileSync(p, JSON.stringify(bad));    // then overwrite with the forged payload
  assert.equal(loadSidecar(p), undefined, "forged precommit verdict must be rejected");
});

test("loadSidecar rejects unknown review.verdict", () => {
  const p = sidecarPath(makeTemp());
  const bad = emptyState("sess1", 10);
  (bad.review as unknown as { verdict: string }).verdict = "APPROVED";
  saveSidecar(p, emptyState("sess1", 10));
  writeFileSync(p, JSON.stringify(bad));
  assert.equal(loadSidecar(p), undefined);
});

test("unmetRequirements blocks an in-memory unknown precommit verdict (default-deny)", () => {
  const s = emptyState("sess1", 10);
  s.hasCodeChange = true;
  s.review = { verdict: "READY", fingerprint: FP, at: "t" };
  // Simulate a value that somehow bypassed the loader, bound to current FP.
  (s.precommit as unknown as { verdict: string; fingerprint: string }).verdict = "READY";
  s.precommit.fingerprint = FP;
  const problems = unmetRequirements(s, FP, false);
  assert.ok(problems.some((p) => /unrecognized/.test(p)), "unknown precommit verdict must block");
});
