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
  type JudgeEntry,
} from "../lib/hierarchy.ts";

function entry(over: Partial<JudgeEntry> = {}): JudgeEntry {
  return {
    judgeId: "rg-reviewer-abc123",
    openerId: "session-child-1",
    role: "reviewer",
    repoRoot: "/repo",
    createdAt: "2026-09-04T00:00:00.000Z",
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
