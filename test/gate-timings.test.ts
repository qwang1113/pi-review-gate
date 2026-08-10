/**
 * Gate observability log.
 *
 * This file is diagnostics-only, so the properties that matter are the ones
 * that keep it from ever hurting: it must not throw, must not grow without
 * bound, and must survive a torn line. Nothing here may influence a verdict.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  TIMINGS_MAX_RECORDS,
  TIMINGS_RELPATH,
  appendTiming,
  formatPrecommitSummary,
  lastPrecommitTiming,
  readTimings,
  type PrecommitTiming,
} from "../lib/gate-timings.ts";

const tempDirs: string[] = [];
function makeTemp(): string {
  const d = mkdtempSync(join(tmpdir(), "rg-timings-"));
  tempDirs.push(d);
  return d;
}
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function precommit(over: Partial<PrecommitTiming> = {}): PrecommitTiming {
  return {
    kind: "precommit",
    at: "2026-08-10T00:00:00.000Z",
    repo: "/repo",
    mode: "fast",
    testScope: "related",
    verdict: "PASS",
    totalMs: 1200,
    steps: [
      { name: "lint", status: "pass", durationMs: 900, cached: false },
      { name: "typecheck", status: "pass", durationMs: 0, cached: true },
      { name: "build", status: "skip", durationMs: 0, cached: false },
    ],
    fingerprint: "abc123def456",
    ...over,
  };
}

test("records round-trip and keep their order", () => {
  const dir = makeTemp();
  appendTiming(dir, precommit());
  appendTiming(dir, {
    kind: "review",
    at: "2026-08-10T00:01:00.000Z",
    repo: dir,
    round: 1,
    verdict: "BLOCKED",
    scope: "incremental",
    changedFiles: 2,
    changedLines: 30,
    approxMs: 45_000,
    approximate: true,
    fingerprint: "abc123def456",
  });
  const all = readTimings(dir);
  assert.equal(all.length, 2);
  assert.equal(all[0].kind, "precommit");
  assert.equal(all[1].kind, "review");
  // The review duration is an upper bound and must be labelled as such, or a
  // reader would take it for the reviewer's own runtime.
  assert.equal((all[1] as { approximate: boolean }).approximate, true);
});

test("the log is trimmed back to the cap, keeping the NEWEST records", () => {
  const dir = makeTemp();
  const total = TIMINGS_MAX_RECORDS + 150;
  for (let i = 0; i < total; i++) appendTiming(dir, precommit({ totalMs: i }));
  const all = readTimings(dir);
  assert.ok(all.length <= TIMINGS_MAX_RECORDS, `kept ${all.length}`);
  assert.equal((all[all.length - 1] as PrecommitTiming).totalMs, total - 1, "the newest record survives");
});

test("a torn or hand-edited line is skipped, not fatal", () => {
  const dir = makeTemp();
  appendTiming(dir, precommit());
  appendFileSync(join(dir, TIMINGS_RELPATH), '{"kind":"precommit","at":\n');
  appendTiming(dir, precommit({ totalMs: 77 }));
  const all = readTimings(dir);
  assert.equal(all.length, 2);
  assert.equal((all[1] as PrecommitTiming).totalMs, 77);
});

test("unknown record kinds are ignored (only the gate's own shapes are read back)", () => {
  const dir = makeTemp();
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, TIMINGS_RELPATH), '{"kind":"something-else"}\n');
  assert.deepEqual(readTimings(dir), []);
});

test("an unwritable location never throws — losing a timing must not cost a verdict", () => {
  // A path whose parent is a FILE cannot hold a directory.
  const dir = makeTemp();
  writeFileSync(join(dir, "blocker"), "x");
  assert.doesNotThrow(() => appendTiming(join(dir, "blocker"), precommit()));
  assert.deepEqual(readTimings(join(dir, "blocker")), []);
});

test("reading a directory that has no log yields nothing", () => {
  assert.deepEqual(readTimings(makeTemp()), []);
  assert.equal(lastPrecommitTiming(makeTemp()), undefined);
});

test("the summary names the slowest steps and marks reuse", () => {
  const lines = formatPrecommitSummary(precommit());
  assert.match(lines[0], /fast\/related 1200ms \(PASS/);
  assert.match(lines[1], /lint 900ms/);
  // A skipped step is not a timing; a cached one is, and must be labelled or
  // "0ms" reads as "did not run".
  assert.doesNotMatch(lines[1], /build/);
  assert.match(lines[1], /typecheck 0ms \(cached\)/);
  assert.match(lines[2], /1\/2 step\(s\) reused/);
});

test("the summary degrades gracefully when nothing has been recorded", () => {
  assert.match(formatPrecommitSummary(undefined)[0], /no precommit recorded/);
});

test("lastPrecommitTiming skips review records", () => {
  const dir = makeTemp();
  appendTiming(dir, precommit({ totalMs: 5 }));
  appendTiming(dir, {
    kind: "review", at: "t", repo: dir, round: 1, verdict: "READY", scope: "full",
    changedFiles: 0, changedLines: 0, approxMs: 1, approximate: true, fingerprint: "f",
  });
  assert.equal(lastPrecommitTiming(dir)?.totalMs, 5);
});

test("the log lives under .pi/ so writing it cannot invalidate the run it describes", () => {
  // `.pi` is in GATE_EXCLUDE_PATHSPECS: if this path ever moved out of it,
  // every precommit would invalidate its own fingerprint binding.
  assert.ok(TIMINGS_RELPATH.startsWith(".pi/"), TIMINGS_RELPATH);
  const dir = makeTemp();
  appendTiming(dir, precommit());
  assert.ok(readFileSync(join(dir, TIMINGS_RELPATH), "utf8").includes("precommit"));
});
