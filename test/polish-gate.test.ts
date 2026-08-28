import test from "node:test";
import assert from "node:assert/strict";

import {
  FILE_STREAK_TRIGGER,
  READY_STREAK_TRIGGER,
  polishReasonRequired,
  polishStreaks,
  recordedFindingsFrom,
} from "../lib/polish-gate.ts";
import type { RoundRecord } from "../lib/gate-state.ts";

const round = (over: Partial<RoundRecord> = {}): RoundRecord => ({
  round: 1,
  findingsTotal: 0,
  fingerprints: [],
  verdict: "READY",
  at: "2026-08-28T00:00:00.000Z",
  ...over,
});

test("READY streak: fewer than 2 rounds never requires a reason", () => {
  assert.equal(polishReasonRequired([]).required, false);
  assert.equal(polishReasonRequired([round({ verdict: "READY" })]).required, false);
});

test("READY streak: 2 consecutive READY rounds require a reason", () => {
  const t = polishReasonRequired([round({ verdict: "READY" }), round({ verdict: "READY" })]);
  assert.equal(t.required, true);
  assert.match(t.why, /READY/);
});

test("READY streak: a BLOCKED round breaks the streak", () => {
  const t = polishReasonRequired([
    round({ verdict: "READY" }),
    round({ verdict: "BLOCKED" }),
    round({ verdict: "READY" }),
  ]);
  assert.equal(t.required, false, "only the TRAILING consecutive READY rounds count");
});

test("READY streak: an older sidecar round with no verdict breaks the streak (conservative)", () => {
  const t = polishReasonRequired([round({ verdict: undefined }), round({ verdict: "READY" }), round({ verdict: "READY" })]);
  // undefined verdict is not READY ⇒ the trailing streak is still 2.
  assert.equal(t.required, true);
  const t2 = polishReasonRequired([round({ verdict: "READY" }), round({ verdict: undefined }), round({ verdict: "READY" })]);
  assert.equal(t2.required, false, "an unknown verdict in the middle is not READY ⇒ streak broken");
});

test("file streak: 3 consecutive rounds with the same file in P2/Nit require a reason", () => {
  const rounds = [
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
  ];
  const t = polishReasonRequired(rounds);
  assert.equal(t.required, true);
  assert.match(t.why, /src\/a\.ts/);
});

test("file streak: 2 consecutive rounds are NOT enough", () => {
  const rounds = [
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
  ];
  assert.equal(polishReasonRequired(rounds).required, false);
});

test("file streak: a round WITHOUT the file resets it (streak must be consecutive)", () => {
  const rounds = [
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
    round({ verdict: "BLOCKED", polishFiles: [] }), // reset
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
  ];
  assert.equal(polishReasonRequired(rounds).required, false, "the reset makes the final streak 2, not 4");
});

test("file streak: a P0/P1 finding ON THE FILE resets it", () => {
  const rounds = [
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"], blockingFiles: ["src/a.ts"] }), // reset
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
  ];
  assert.equal(polishReasonRequired(rounds).required, false, "the blocking round resets to 2");
});

test("file streak: a P0/P1 on ANOTHER file does not reset this file", () => {
  const rounds = [
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"], blockingFiles: ["src/b.ts"] }),
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
  ];
  assert.equal(polishReasonRequired(rounds).required, true);
});

test("file streak: severity comes from the finding, not line counts (P2 and Nit both count)", () => {
  const rec = recordedFindingsFrom([
    { severity: "P2", file: "src/a.ts" },
    { severity: "Nit", file: "src/a.ts" },
    { severity: "P1", file: "src/b.ts" },
    { severity: "P2", file: "" }, // no file ⇒ ignored
  ]);
  assert.deepEqual(rec.polishFiles.sort(), ["src/a.ts"]);
  assert.deepEqual(rec.blockingFiles, ["src/b.ts"]);
});

test("file streak: old sidecar rounds without the new fields are treated as 'no P2/Nit' (reset, never trigger)", () => {
  const old = round({ verdict: "READY" }); // no polishFiles / blockingFiles
  const rounds = [
    { ...old, round: 1 },
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
  ];
  assert.equal(polishReasonRequired(rounds).required, false, "the legacy round resets the streak");
});

test("polishStreaks returns only files with count >= 1", () => {
  const streaks = polishStreaks([
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts", "src/b.ts"] }),
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
  ]);
  assert.equal(streaks.get("src/a.ts"), 2);
  assert.equal(streaks.get("src/b.ts"), undefined, "b dropped to 0 and was pruned");
});

test("READY + file triggers are independent (a file streak fires even without a READY streak)", () => {
  const rounds = [
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
    round({ verdict: "BLOCKED", polishFiles: ["src/a.ts"] }),
  ];
  const t = polishReasonRequired(rounds);
  assert.equal(t.required, true);
  assert.match(t.why, /src\/a\.ts/);
});

test("thresholds are exported and sane", () => {
  assert.equal(READY_STREAK_TRIGGER, 2);
  assert.equal(FILE_STREAK_TRIGGER, 3);
});
