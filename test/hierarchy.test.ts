/**
 * Cross-level calls are refused HERE — PM reaching into a child's review,
 * two children touching each other's reviews, an unknown caller, an
 * unregistered judge, and a second opener claiming one judge.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  emptyHierarchy,
  registerJudge,
  checkCaller,
  removeJudge,
  listByOpener,
  judgeIdsByOpener,
  parseHierarchySnapshot,
  tmuxServerFrom,
  judgeLive,
  paneClosable,
  type JudgeEntry,
} from "../lib/hierarchy.ts";

function entry(over: Partial<JudgeEntry> = {}): JudgeEntry {
  return {
    judgeId: "rg-reviewer-abc123",
    openerId: "session-child-1",
    role: "reviewer",
    repoRoot: "/repo",
    title: "reviewer",
    sessionDir: "/repo/.pi/judge-sessions/reviewer-abc-def/sessions",
    spawnedAt: "2026-09-04T00:00:00.000Z",
    ...over,
  };
}

test("opener registers its judge and operates it", () => {
  const reg = registerJudge(emptyHierarchy(), entry());
  assert.equal(reg.ok, true);
  if (!reg.ok) return;
  assert.equal(checkCaller(reg.table, "rg-reviewer-abc123", "session-child-1").ok, true);
});

test("PM cannot wait/answer/close a child's review (cross-level refused)", () => {
  const reg = registerJudge(emptyHierarchy(), entry());
  assert.equal(reg.ok, true);
  if (!reg.ok) return;
  const verdict = checkCaller(reg.table, "rg-reviewer-abc123", "orch-pm-9");
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /跨级/);
});

test("two children cannot touch each other's reviews", () => {
  let table = emptyHierarchy();
  const a = registerJudge(table, entry({ judgeId: "j-a", openerId: "child-a" }));
  assert.equal(a.ok, true);
  if (!a.ok) return;
  const b = registerJudge(a.table, entry({ judgeId: "j-b", openerId: "child-b" }));
  assert.equal(b.ok, true);
  if (!b.ok) return;
  assert.equal(checkCaller(b.table, "j-a", "child-b").ok, false);
  assert.equal(checkCaller(b.table, "j-b", "child-a").ok, false);
  assert.equal(checkCaller(b.table, "j-a", "child-a").ok, true);
  assert.equal(checkCaller(b.table, "j-b", "child-b").ok, true);
});

test("a second opener claiming one judge is refused at registration", () => {
  const first = registerJudge(emptyHierarchy(), entry());
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = registerJudge(first.table, entry({ openerId: "session-other" }));
  assert.equal(second.ok, false);
});

test("same opener may re-register the same judge id (pane reuse across rounds)", () => {
  const first = registerJudge(emptyHierarchy(), entry());
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = registerJudge(first.table, entry({ paneId: "%7" }));
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.table["rg-reviewer-abc123"].paneId, "%7");
});

test("unknown caller identity is fail-closed", () => {
  const reg = registerJudge(emptyHierarchy(), entry());
  assert.equal(reg.ok, true);
  if (!reg.ok) return;
  for (const caller of [undefined, "", "   "]) {
    assert.equal(checkCaller(reg.table, "rg-reviewer-abc123", caller).ok, false);
  }
});

test("unregistered judge id is fail-closed (reclaimed or never ours)", () => {
  assert.equal(checkCaller(emptyHierarchy(), "rg-reviewer-nope", "session-child-1").ok, false);
});

test("empty judge id cannot be registered or checked", () => {
  assert.equal(registerJudge(emptyHierarchy(), entry({ judgeId: "  " })).ok, false);
  const reg = registerJudge(emptyHierarchy(), entry());
  assert.equal(reg.ok, true);
  if (!reg.ok) return;
  assert.equal(checkCaller(reg.table, "  ", "session-child-1").ok, false);
});

test("registration without an opener is refused", () => {
  assert.equal(registerJudge(emptyHierarchy(), entry({ openerId: "" })).ok, false);
});

test("removal forgets the judge; removing unknown ids is a no-op", () => {
  const reg = registerJudge(emptyHierarchy(), entry());
  assert.equal(reg.ok, true);
  if (!reg.ok) return;
  const dropped = removeJudge(reg.table, "rg-reviewer-abc123");
  assert.equal(checkCaller(dropped, "rg-reviewer-abc123", "session-child-1").ok, false);
  assert.equal(removeJudge(dropped, "rg-reviewer-nope"), dropped);
});

test("tmuxServerFrom takes the SERVER out of $TMUX, ignoring the session index", () => {
  assert.equal(tmuxServerFrom({ TMUX: "/private/tmp/tmux-501/default,12345,0" }), "/private/tmp/tmux-501/default,12345");
  // Same server, a different session of it — still the same server.
  assert.equal(tmuxServerFrom({ TMUX: "/private/tmp/tmux-501/default,12345,7" }), "/private/tmp/tmux-501/default,12345");
  assert.equal(tmuxServerFrom({}), undefined, "outside tmux there is no server");
  assert.equal(tmuxServerFrom({ TMUX: "   " }), undefined);
  assert.equal(tmuxServerFrom({ TMUX: "garbage-without-commas" }), undefined, "an unparseable value is not a server");
});

test("judgeLive: missing information keeps a judge ALIVE, a foreign server does not", () => {
  const live = { paneId: "%7", tmuxServer: "sock,1" };
  assert.equal(judgeLive(live, ["%7", "%9"], "sock,1"), true, "listed by its own server ⇒ running");
  assert.equal(judgeLive(live, ["%9"], "sock,1"), false, "not listed ⇒ gone");
  // The never-kill-on-missing-info direction: an unreadable pane list must not
  // end a wait on a judge that is working.
  assert.equal(judgeLive(live, undefined, "sock,1"), true, "unreadable pane list keeps it alive");
  assert.equal(judgeLive({ paneId: "%7" }, undefined, "sock,1"), true, "no recorded server ⇒ still comparable");
  // …but a KNOWN-different server means %7 is somebody else's pane, and no
  // amount of missing information makes it this judge's.
  assert.equal(judgeLive(live, ["%7"], "sock,2"), false, "after a server restart the id is not comparable");
  assert.equal(judgeLive(live, undefined, "sock,2"), false);
  assert.equal(judgeLive({ tmuxServer: "sock,1" }, ["%7"], "sock,1"), false, "no pane ⇒ not running");
});

test("paneClosable: the OPPOSITE default — unverifiable means do not kill", () => {
  assert.equal(paneClosable({ paneId: "%7", tmuxServer: "sock,1" }, "sock,1"), true);
  assert.equal(paneClosable({ paneId: "%7", tmuxServer: "sock,1" }, "sock,2"), false, "another server's pane id");
  // These two are exactly where the pair diverges: judgeLive says "alive"
  // (missing info must not end a wait), paneClosable says "do not kill"
  // (missing info must not act). Asserting them side by side is the point.
  assert.equal(paneClosable({ paneId: "%7" }, "sock,1"), false, "no recorded server ⇒ not killable");
  assert.equal(judgeLive({ paneId: "%7" }, undefined, "sock,1"), true, "…while the same entry stays alive");
  assert.equal(paneClosable({ paneId: "%7", tmuxServer: "sock,1" }, undefined), false, "we are not in tmux ⇒ not killable");
  assert.equal(paneClosable({ tmuxServer: "sock,1" }, "sock,1"), false, "no pane id ⇒ nothing to close");
});

test("listByOpener returns exactly the opener's judges for cascade-close", () => {
  let table = emptyHierarchy();
  for (const [judgeId, openerId] of [["j-1", "pm"], ["j-2", "child-1"], ["j-3", "pm"]] as const) {
    const reg = registerJudge(table, entry({ judgeId, openerId }));
    assert.equal(reg.ok, true);
    if (!reg.ok) return;
    table = reg.table;
  }
  assert.deepEqual(judgeIdsByOpener(table, "pm").sort(), ["j-1", "j-3"]);
  assert.deepEqual(judgeIdsByOpener(table, "child-1"), ["j-2"]);
  assert.deepEqual(listByOpener(table, ""), []);
  assert.deepEqual(listByOpener(table, "nobody"), []);
});

test("registration does not mutate the input table", () => {
  const before = emptyHierarchy();
  const reg = registerJudge(before, entry());
  assert.equal(reg.ok, true);
  assert.deepEqual(before, {});
});

test("a persisted snapshot round-trips through parse", () => {
  const snap = {
    version: 1,
    judges: { "rg-reviewer-abc123": entry({ paneId: "%7", lastReportId: "rep-1" }) },
    audit: { kind: "goal", draft: "目标", startedAt: "2026-09-04T00:00:00.000Z" },
  };
  const parsed = parseHierarchySnapshot(JSON.stringify(snap));
  assert.deepEqual(parsed, snap);
});

test("a corrupt snapshot is dropped, never trusted", () => {
  assert.equal(parseHierarchySnapshot("not json"), undefined);
  assert.equal(parseHierarchySnapshot(JSON.stringify({ version: 2, judges: {} })), undefined);
  assert.equal(parseHierarchySnapshot(JSON.stringify({ version: 1 })), undefined);
  assert.equal(parseHierarchySnapshot(JSON.stringify({ version: 1, judges: null })), undefined);
});

test("entries whose key disagrees with their id are dropped", () => {
  const parsed = parseHierarchySnapshot(JSON.stringify({
    version: 1,
    judges: { "j-right": entry({ judgeId: "j-right" }), "j-wrong": entry({ judgeId: "j-other" }) },
  }));
  assert.deepEqual(Object.keys(parsed!.judges), ["j-right"]);
});

test("an entry written before the registries merged is DROPPED, not half-adopted", () => {
  // The pre-merge disk format: no title, no sessionDir, and the timestamp
  // under its old name. Half-adopting one would put a judge in the table that
  // the wait receipt, the health snapshot and the cascade-close each read
  // differently — so it is dropped whole and its round simply re-runs
  // (哲学三: only the new format is read, no compatibility layer).
  const legacy = {
    judgeId: "j-old", openerId: "session-1", role: "reviewer", repoRoot: "/repo",
    createdAt: "2026-09-04T00:00:00.000Z", paneId: "%7",
  };
  const parsed = parseHierarchySnapshot(JSON.stringify({
    version: 1,
    judges: { "j-old": legacy, "j-new": entry({ judgeId: "j-new" }) },
  }));
  assert.deepEqual(Object.keys(parsed!.judges), ["j-new"],
    "the legacy entry must not survive in any form");
});

test("each merged-in field is individually required", () => {
  // Positive control first: the full entry DOES parse. Without it, a
  // derivation that rejects everything would pass the rejections below.
  const full = parseHierarchySnapshot(JSON.stringify({
    version: 1, judges: { "j": entry({ judgeId: "j" }) },
  }));
  assert.deepEqual(Object.keys(full!.judges), ["j"], "the check itself must accept a complete entry");

  for (const missing of ["title", "sessionDir", "spawnedAt"] as const) {
    const partial = { ...entry({ judgeId: "j" }) } as Record<string, unknown>;
    delete partial[missing];
    const parsed = parseHierarchySnapshot(JSON.stringify({ version: 1, judges: { "j": partial } }));
    assert.deepEqual(Object.keys(parsed!.judges), [], `a missing ${missing} must drop the entry`);
  }
});

test("a malformed pending audit is dropped while good judges survive", () => {
  const parsed = parseHierarchySnapshot(JSON.stringify({
    version: 1,
    judges: { "j": entry({ judgeId: "j" }) },
    audit: { kind: "goal", draft: 42, startedAt: "t" },
  }));
  assert.deepEqual(Object.keys(parsed!.judges), ["j"]);
  assert.equal(parsed!.audit, undefined);
});

test("a well-formed pending audit survives, per kind", () => {
  const goal = parseHierarchySnapshot(JSON.stringify({
    version: 1,
    judges: {},
    audit: { kind: "goal", draft: "d", startedAt: "t" },
  }));
  assert.deepEqual(goal!.audit, { kind: "goal", draft: "d", startedAt: "t" });
  const plan = parseHierarchySnapshot(JSON.stringify({
    version: 1,
    judges: {},
    audit: { kind: "plan", hash: "h", planText: "p", startedAt: "t" },
  }));
  assert.deepEqual(plan!.audit, { kind: "plan", hash: "h", planText: "p", startedAt: "t" });
});

// The two-field shape is NOT read (2026-09-05, user decision): no compatibility
// layer, and the audit a stale file named simply re-runs — fail-closed, never
// mis-recorded.
test("the retired goalAudit/planAudit fields are not read", () => {
  const parsed = parseHierarchySnapshot(JSON.stringify({
    version: 1,
    judges: { "j": entry({ judgeId: "j" }) },
    goalAudit: { draft: "d", startedAt: "t" },
    planAudit: { hash: "h", planText: "p", startedAt: "t" },
  }));
  assert.deepEqual(Object.keys(parsed!.judges), ["j"]);
  assert.equal(parsed!.audit, undefined);
});
