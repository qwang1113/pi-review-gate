import test from "node:test";
import assert from "node:assert/strict";

import { classifyChildren, buildChildWaitNotice, type ChildSnapshot } from "../lib/child-watch.ts";
import { STALL_MOTION_MAX_AGE_SEC } from "../lib/loop-stall.ts";

const NOW = Date.parse("2026-08-28T06:00:00.000Z");
const fresh = (over: Partial<ChildSnapshot> = {}): ChildSnapshot => ({
  title: "review-abc",
  sessionId: "rg-reviewer-abc",
  role: "reviewer",
  spawnedAt: new Date(NOW - 60_000).toISOString(),
  alive: true,
  ...over,
});

test("an alive fresh child is in flight", () => {
  const v = classifyChildren([fresh()], NOW);
  assert.equal(v.inFlight.length, 1);
  assert.equal(v.terminated.length, 0);
});

test("an ENDED pi session ends the wait immediately (no signal needed)", () => {
  const child = fresh({ alive: false });
  const v = classifyChildren([child], NOW);
  assert.equal(v.inFlight.length, 0);
  assert.equal(v.terminated.length, 1);
  assert.equal(v.terminated[0]!.reason, "session-ended");
  assert.equal(v.terminated[0]!.child.sessionId, "rg-reviewer-abc");
});

/**
 * Round-6 P1 (reviewer, reproduced): not every watched file is per-run — the
 * inbox lives at `<workDir>/inbox.jsonl` and survives a same-title respawn. A
 * stale mtime from the PREVIOUS run was therefore read as this run's activity,
 * and a judge spawned seconds ago was declared silent-timeout immediately.
 */
test("activity older than the spawn is ignored (a stale inbox must not kill a fresh child)", () => {
  const child = fresh({
    spawnedAt: new Date(NOW - 5_000).toISOString(),                    // just started
    lastActivityAt: new Date(NOW - 60 * 60 * 1000).toISOString(),      // last run's file
  });
  const v = classifyChildren([child], NOW);
  assert.equal(v.terminated.length, 0, "a child spawned seconds ago is never silent");
  assert.equal(v.inFlight.length, 1);
});

test("activity NEWER than the spawn still counts (that is the whole point of the stamp)", () => {
  const child = fresh({
    spawnedAt: new Date(NOW - (STALL_MOTION_MAX_AGE_SEC + 600) * 1000).toISOString(),
    lastActivityAt: new Date(NOW - 5_000).toISOString(),
  });
  assert.equal(classifyChildren([child], NOW).inFlight.length, 1,
    "a long-running judge that just wrote is working, not silent");
});

test("a live child SILENT past STALL_MOTION_MAX_AGE_SEC ends the wait (the measured no-signal finish)", () => {
  const child = fresh({ spawnedAt: new Date(NOW - (STALL_MOTION_MAX_AGE_SEC + 1) * 1000).toISOString() });
  const v = classifyChildren([child], NOW);
  assert.equal(v.inFlight.length, 0);
  assert.equal(v.terminated.length, 1);
  assert.equal(v.terminated[0]!.reason, "silent-timeout");
});

test("lastActivityAt overrides spawnedAt for the silence clock", () => {
  const old = fresh({ spawnedAt: new Date(NOW - 3600_000).toISOString() });
  assert.equal(classifyChildren([old], NOW).terminated.length, 1, "old spawn alone is silent");
  const active = fresh({
    spawnedAt: new Date(NOW - 3600_000).toISOString(),
    lastActivityAt: new Date(NOW - 30_000).toISOString(),
  });
  assert.equal(classifyChildren([active], NOW).inFlight.length, 1, "recent activity keeps it in flight");
});

test("an unparseable timestamp is treated as infinitely silent (fail-safe to terminated)", () => {
  const child = fresh({ spawnedAt: "not-a-date" });
  const v = classifyChildren([child], NOW);
  assert.equal(v.terminated.length, 1);
  assert.equal(v.terminated[0]!.reason, "silent-timeout");
});

test("empty input is a no-op (undefined notice — never 'idle' advice)", () => {
  const v = classifyChildren([], NOW);
  assert.equal(v.inFlight.length, 0);
  assert.equal(v.terminated.length, 0);
  assert.equal(buildChildWaitNotice(v, new Map()), undefined);
});

test("buildChildWaitNotice names the terminated child, the recovery action and the remaining in-flight ones", () => {
  const v = classifyChildren(
    [
      fresh({ title: "review-dead", sessionId: "rg-reviewer-dead", role: "reviewer", alive: false }),
      fresh({ title: "audit-silent", sessionId: "rg-auditor-silent", role: "goal-auditor", spawnedAt: new Date(NOW - 3600_000).toISOString() }),
      fresh({ title: "review-live", sessionId: "rg-reviewer-live", role: "reviewer" }),
    ],
    NOW,
  );
  const notice = buildChildWaitNotice(v, new Map([["rg-reviewer-live", "review-live"]]));
  assert.ok(notice, "a notice is produced");
  assert.match(notice, /review-dead/, "the dead child is named");
  assert.match(notice, /进程已退出/, "session-ended reason is stated in PROCESS terms");
  assert.doesNotMatch(notice, /pane_dead|capture-pane/, "the hosted wait no longer teaches pane-level probes");
  assert.match(notice, /audit-silent/, "the silent child is named");
  assert.match(notice, /静默超过上限/, "silent-timeout reason is stated");
  assert.match(notice, /review_read/, "the recovery action (read its output) is stated");
  assert.match(notice, /review-live/, "the in-flight child is named");
  assert.match(notice, /review-live/, "its session id is named");
  assert.match(notice, /不要结束 turn/, "the hosted-wait discipline is explicit");
});
