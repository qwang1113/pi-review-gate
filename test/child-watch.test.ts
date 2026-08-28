import test from "node:test";
import assert from "node:assert/strict";

import { classifyChildren, buildChildWaitNotice, type ChildSnapshot } from "../lib/child-watch.ts";
import { STALL_MOTION_MAX_AGE_SEC } from "../lib/loop-stall.ts";

const NOW = Date.parse("2026-08-28T06:00:00.000Z");
const fresh = (over: Partial<ChildSnapshot> = {}): ChildSnapshot => ({
  title: "review-abc",
  paneId: "%10",
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

test("a DEAD pane ends the wait immediately (no signal needed)", () => {
  const child = fresh({ alive: false });
  const v = classifyChildren([child], NOW);
  assert.equal(v.inFlight.length, 0);
  assert.equal(v.terminated.length, 1);
  assert.equal(v.terminated[0]!.reason, "pane-dead");
  assert.equal(v.terminated[0]!.child.paneId, "%10");
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
      fresh({ title: "review-dead", paneId: "%1", role: "reviewer", alive: false }),
      fresh({ title: "audit-silent", paneId: "%2", role: "goal-auditor", spawnedAt: new Date(NOW - 3600_000).toISOString() }),
      fresh({ title: "review-live", paneId: "%3", role: "reviewer" }),
    ],
    NOW,
  );
  const notice = buildChildWaitNotice(v, new Map([["%3", "rg-review-live-done"]]));
  assert.ok(notice, "a notice is produced");
  assert.match(notice, /review-dead/, "the dead child is named");
  assert.match(notice, /pane 已退出/, "pane-dead reason is stated");
  assert.match(notice, /audit-silent/, "the silent child is named");
  assert.match(notice, /静默超过上限/, "silent-timeout reason is stated");
  assert.match(notice, /review_read/, "the recovery action (read its output) is stated");
  assert.match(notice, /review-live/, "the in-flight child is named");
  assert.match(notice, /rg-review-live-done/, "its done channel is named");
  assert.match(notice, /不要结束 turn/, "the hosted-wait discipline is explicit");
});
