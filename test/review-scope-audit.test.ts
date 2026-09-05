/**
 * THE AUDIT PAIR — what a finished round says it reviewed, on the record.
 *
 * A verdict whose scope nobody wrote down cannot be checked afterwards for
 * either failure mode: a round that read less than it was sent to read, and a
 * round that re-derived what a previous verdict had already settled. So the
 * scope is stamped in two places by two different parties — the GATE registers
 * what it dispatched, the JUDGE stamps what it says it reviewed — and both
 * halves are kept side by side.
 *
 * This file pins the three layers that carry them, because they fail
 * separately: the channel record (judge → opener), the sidecar round record
 * (survives the channel file), and the wake-up text (the only place the opener
 * actually reads it).
 *
 * The hard constraint behind every assertion here: this extension loads from
 * source with no build step, so a running opener holds an older build than the
 * panes it opens. Everything below is therefore OPTIONAL on the wire, and a
 * record without it must stay perfectly readable.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  reportConclusion,
  sanitizeScopeStamp,
  type ChannelIO,
  type ChannelReportRecord,
} from "../lib/orchestrator-channel.ts";
import {
  emptyState,
  loadSidecar,
  sanitizeRoundScope,
  saveSidecar,
  sidecarPath,
  type RoundRecord,
} from "../lib/gate-state.ts";
import { buildStandardReport } from "../lib/judge-report.ts";

const tempDirs: string[] = [];
function makeTemp(): string {
  const d = mkdtempSync(join(tmpdir(), "rg-scope-audit-"));
  tempDirs.push(d);
  return d;
}
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** A channel IO that never has to touch the disk (no spill files are used). */
const io: ChannelIO = {
  ensureDir() {},
  appendLine() {},
  readText() { return undefined; },
  writeText() {},
  now: () => 0,
};

function report(scope: unknown): ChannelReportRecord {
  return {
    kind: "report",
    from: "child",
    at: "2026-09-05T00:00:00.000Z",
    id: "rec-1",
    reportId: "rep-1",
    verdict: "READY",
    findings: [],
    ...(scope === undefined ? {} : { scope: scope as ChannelReportRecord["scope"] }),
  } as ChannelReportRecord;
}

// ---------------------------------------------------------------------------
// Layer 1 — the channel record
// ---------------------------------------------------------------------------

test("a report's scope reaches the opener as data", () => {
  const c = reportConclusion(io, report({ range: "1234567..89abcde", kind: "incremental" }));
  assert.deepEqual(c.scope, { range: "1234567..89abcde", kind: "incremental" });
});

test("a report written by a build that never heard of the stamp still reads", () => {
  // The compatibility promise the optional field exists for.
  const c = reportConclusion(io, report(undefined));
  assert.equal(c.verdict, "READY");
  assert.equal(c.scope, undefined);
  assert.ok(!("scope" in c), "absent, not present-and-empty");
});

test("an unrecognisable stamp is dropped rather than passed on", () => {
  // A channel file is untrusted input: another build, a truncated write, a
  // hand edit. Evidence that cannot be recognised is ABSENT, not approximated.
  assert.equal(sanitizeScopeStamp(undefined), undefined);
  assert.equal(sanitizeScopeStamp("aaa..bbb"), undefined, "a bare string is not a stamp");
  assert.equal(sanitizeScopeStamp({}), undefined, "an empty stamp claims nothing");
  assert.equal(sanitizeScopeStamp({ range: "   " }), undefined, "blank is not a range");
  assert.equal(sanitizeScopeStamp({ kind: "partial" }), undefined, "an unknown kind is not a kind");
  assert.deepEqual(sanitizeScopeStamp({ range: 7, kind: "full" }), { kind: "full" });
  assert.deepEqual(
    sanitizeScopeStamp({ range: " a..b ", kind: "incremental", extra: 1 }),
    { range: "a..b", kind: "incremental" },
    "trimmed, and nothing but the two known fields survives",
  );
  // …and the same rule applies through the conclusion reader.
  assert.equal(reportConclusion(io, report({ kind: "sort-of" })).scope, undefined);
});

// ---------------------------------------------------------------------------
// Layer 2 — the sidecar round record (both halves)
// ---------------------------------------------------------------------------

test("a round records BOTH halves of the pair, and they survive a save/load", () => {
  const dir = makeTemp();
  const path = sidecarPath(dir);
  const st = emptyState("sess-audit", 10);
  const round: RoundRecord = {
    round: 1,
    findingsTotal: 0,
    fingerprints: [],
    verdict: "READY",
    at: "2026-09-05T00:00:00.000Z",
    scope: {
      dispatched: { range: "1111111..2222222", kind: "incremental" },
      reported: { range: "1111111..2222222", kind: "incremental" },
    },
  };
  st.rounds.push(round);
  saveSidecar(path, st);
  const back = loadSidecar(path);
  assert.ok(back);
  assert.deepEqual(back.rounds[0]!.scope, round.scope);
});

test("a MISMATCHED pair is recorded, not corrected and not refused", () => {
  // The gate cannot tell a legitimate divergence (the judge escalated to a
  // full read on its own) from a lazy one, so it records what each side said
  // and leaves the judgement to a human. Silently normalising the two would
  // destroy the only evidence the pair exists to provide.
  const dir = makeTemp();
  const path = sidecarPath(dir);
  const st = emptyState("sess-audit-2", 10);
  st.rounds.push({
    round: 1,
    findingsTotal: 0,
    fingerprints: [],
    verdict: "READY",
    at: "2026-09-05T00:00:00.000Z",
    scope: {
      dispatched: { range: "1111111..2222222", kind: "incremental" },
      reported: { range: "3333333..4444444", kind: "full" },
    },
  });
  saveSidecar(path, st);
  const back = loadSidecar(path);
  assert.deepEqual(back!.rounds[0]!.scope, {
    dispatched: { range: "1111111..2222222", kind: "incremental" },
    reported: { range: "3333333..4444444", kind: "full" },
  });
});

test("the round sanitizer keeps recognisable halves and drops the rest", () => {
  assert.equal(sanitizeRoundScope(undefined), undefined);
  assert.equal(sanitizeRoundScope("full"), undefined);
  assert.equal(sanitizeRoundScope({}), undefined, "a pair with no halves records nothing");
  assert.equal(
    sanitizeRoundScope({ dispatched: { kind: "nonsense" } }),
    undefined,
    "a pair whose only half is junk is not a record",
  );
  assert.deepEqual(
    sanitizeRoundScope({ dispatched: { kind: "full" }, reported: { kind: "nope" } }),
    { dispatched: { kind: "full" } },
    "one good half survives alone — half the evidence is still evidence",
  );
});

test("a sidecar carrying a forged scope loads with the forgery removed", () => {
  // loadSidecar is the boundary between a file anyone can edit and the state
  // the gate reasons about; a round whose other fields are fine must survive.
  const dir = makeTemp();
  const path = sidecarPath(dir);
  const st = emptyState("sess-audit-3", 10);
  st.rounds.push({
    round: 1,
    findingsTotal: 0,
    fingerprints: ["abc"],
    verdict: "BLOCKED",
    at: "2026-09-05T00:00:00.000Z",
    scope: { dispatched: { kind: "sideways" } } as unknown as RoundRecord["scope"],
  });
  saveSidecar(path, st);
  const back = loadSidecar(path);
  assert.ok(back, "the round is still loadable");
  assert.equal(back.rounds[0]!.scope, undefined, "the unrecognisable stamp is gone");
  assert.deepEqual(back.rounds[0]!.fingerprints, ["abc"], "…and the rest of the round is intact");
});

// ---------------------------------------------------------------------------
// Layer 3 — the wake-up the opener actually reads
// ---------------------------------------------------------------------------

test("the wake-up prints what the round says it reviewed", () => {
  const text = buildStandardReport({
    role: "reviewer",
    judgeId: "j1",
    verdict: "READY",
    findingsCount: 0,
    scope: { range: "1234567..89abcde", kind: "incremental" },
  });
  assert.match(text, /本轮审查范围（judge 自报）：1234567\.\.89abcde（增量）/);
  const full = buildStandardReport({
    role: "reviewer",
    judgeId: "j1",
    verdict: "READY",
    scope: { range: "1234567..89abcde", kind: "full" },
  });
  assert.match(full, /（全量深审）/);
});

test("a round with no stamp prints no scope line at all", () => {
  const text = buildStandardReport({ role: "reviewer", judgeId: "j1", verdict: "READY" });
  assert.doesNotMatch(text, /本轮审查范围/, "silence, not a line that says nothing");
  const empty = buildStandardReport({ role: "reviewer", judgeId: "j1", verdict: "READY", scope: {} });
  assert.doesNotMatch(empty, /本轮审查范围/);
});

test("a half stamp says which half is missing instead of inventing it", () => {
  const noKind = buildStandardReport({
    role: "reviewer",
    judgeId: "j1",
    verdict: "READY",
    scope: { range: "1234567..89abcde" },
  });
  assert.match(noKind, /范围标记缺失/, "an absent decision is named, never defaulted to full");
  const noRange = buildStandardReport({
    role: "reviewer",
    judgeId: "j1",
    verdict: "READY",
    scope: { kind: "incremental" },
  });
  assert.match(noRange, /未标注（增量）/);
});
