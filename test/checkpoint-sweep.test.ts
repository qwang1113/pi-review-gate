/**
 * WHAT A CHECKPOINT COMMITS, and what it refuses to — drill F3, 2026-09-19.
 *
 * The gate's own commit used a bare `git add -A`, and in the drill that put the
 * seeded `node_modules` symlink into the repository (`+1/−0 node_modules` in
 * the reviewer's own CHANGE INDEX). The rule these tests pin: untracked paths
 * are the round's work only when THIS SESSION wrote them.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { planCheckpointSweep } from "../lib/checkpoint-sweep.ts";

test("a seeded symlink nobody wrote is LEFT OUT — the measured case", () => {
  const plan = planCheckpointSweep({ untracked: ["node_modules", ".env"], own: [] });
  assert.deepEqual(plan.own, [], "nothing to stage");
  assert.deepEqual(plan.leftOut, ["node_modules", ".env"], "…and both must be named, or the round looks complete");
});

test("a NEW file this session wrote through edit/write IS committed — or it could never be reviewed", () => {
  const plan = planCheckpointSweep({
    untracked: ["lib/new-thing.ts", "test/fixtures/sample.json", "node_modules"],
    own: ["lib/new-thing.ts", "test/fixtures/sample.json"],
  });
  assert.deepEqual(plan.own, ["lib/new-thing.ts", "test/fixtures/sample.json"], "the session's own new files ride along");
  assert.deepEqual(plan.leftOut, ["node_modules"], "and the stranger does not");
});

test("matching is EXACT — no glob, no prefix, no case folding", () => {
  const plan = planCheckpointSweep({
    untracked: ["lib/a.ts", "lib/a.ts.bak", "Lib/A.ts", "lib/a.ts/"],
    own: ["lib/a.ts"],
  });
  assert.deepEqual(plan.own, ["lib/a.ts"]);
  assert.deepEqual(
    plan.leftOut,
    ["lib/a.ts.bak", "Lib/A.ts", "lib/a.ts/"],
    "a near-miss is a different path, and the edit handler already answered 'did this session write it'",
  );
});

test("the same path listed twice is one path", () => {
  const plan = planCheckpointSweep({ untracked: ["node_modules", "node_modules", ""], own: [] });
  assert.deepEqual(plan.leftOut, ["node_modules"], "a rerun or a raced reader must not double-report");
});
