import test from "node:test";
import assert from "node:assert/strict";

import {
  boundariesConflict,
  boundaryCovers,
  declarationsOverlap,
  normalizeBoundaries,
  normalizeBoundary,
  overlappingBoundaries,
  pathWithinBoundaries,
  pathsOutsideBoundaries,
} from "../lib/orchestrator-boundaries.ts";

function value(raw: string): string {
  const result = normalizeBoundary(raw);
  assert.ok(result.ok, `expected ${raw} to normalize: ${result.ok ? "" : result.reason}`);
  return result.value;
}

test("the shapes people actually write all normalize to the same thing", () => {
  for (const raw of ["lib", "lib/", "./lib", "lib/**", "lib/*", "lib//"]) {
    assert.equal(value(raw), "lib", `${raw} must mean the lib directory`);
  }
  assert.equal(value("lib/foo.ts"), "lib/foo.ts");
  assert.equal(value("."), ".", "the whole repo is legal, but it has to be explicit");
});

test("a boundary that cannot be compared safely is REFUSED, not guessed at", () => {
  for (const [raw, hint] of [
    ["", /空/],
    ["   ", /空/],
    ["/etc/passwd", /仓库相对/],
    ["C:\\Windows", /仓库相对/],
    ["../outside", /\.\./],
    ["lib/*.ts", /通配/],
    ["lib/foo*/bar", /通配/],
  ] as const) {
    const result = normalizeBoundary(raw);
    assert.equal(result.ok, false, `${JSON.stringify(raw)} must be refused`);
    if (!result.ok) assert.match(result.reason, hint);
  }
});

test("normalizing a declaration collects EVERY problem and de-duplicates the rest", () => {
  const { boundaries, problems } = normalizeBoundaries(["lib/", "lib", "/abs", "../up", "test/"]);
  assert.deepEqual(boundaries, ["lib", "test"], "duplicates collapse");
  assert.equal(problems.length, 2, "one round-trip should be enough to fix a declaration");
  assert.deepEqual(problems.map((p) => p.boundary), ["/abs", "../up"]);
});

test("containment is SEGMENT-aware — a shared string prefix is not a shared directory", () => {
  assert.equal(boundaryCovers("lib", "lib/a.ts"), true);
  assert.equal(boundaryCovers("lib", "lib"), true);
  assert.equal(boundaryCovers("lib", "library/a.ts"), false,
    "this is the bug a naive startsWith would have");
  assert.equal(boundaryCovers("lib/a.ts", "lib"), false, "containment has a direction");
  assert.equal(boundaryCovers(".", "anything/at/all.ts"), true, "the repo root covers everything");
  assert.equal(boundaryCovers("lib", "."), false, "nothing but the root covers the root");
});

test("two boundaries CONFLICT when either one covers the other", () => {
  assert.equal(boundariesConflict("lib", "lib/a.ts"), true, "the parent reaches the child");
  assert.equal(boundariesConflict("lib/a.ts", "lib"), true, "and the child is reachable from the parent");
  assert.equal(boundariesConflict("lib", "test"), false);
  assert.equal(boundariesConflict(".", "lib"), true, "a whole-repo task conflicts with everything");
});

test("overlap between declarations names the concrete pair", () => {
  const hits = overlappingBoundaries(["lib", "docs"], ["docs/api.md", "scripts"]);
  assert.deepEqual(hits, [{ a: "docs", b: "docs/api.md" }],
    "the report says WHICH boundaries collide, so the plan can be fixed");
  assert.equal(declarationsOverlap(["lib"], ["test"]), false);
  assert.equal(declarationsOverlap(["lib"], ["lib/deep/thing.ts"]), true);
  assert.equal(declarationsOverlap([], ["lib"]), false, "an empty declaration overlaps nothing");
});

test("a goal's paths are checked against the task boundary (constraint 8's predicate)", () => {
  const boundaries = ["lib/orchestrator", "test"];
  assert.equal(pathWithinBoundaries("lib/orchestrator/plan.ts", boundaries), true);
  assert.equal(pathWithinBoundaries("test/plan.test.ts", boundaries), true);
  assert.equal(pathWithinBoundaries("extensions/review-gate.ts", boundaries), false);
  assert.deepEqual(
    pathsOutsideBoundaries(["lib/orchestrator/a.ts", "extensions/review-gate.ts", "README.md"], boundaries),
    ["extensions/review-gate.ts", "README.md"],
  );
});

test("an unusable path is treated as OUTSIDE — fail-closed", () => {
  // A path we cannot normalize must never be silently accepted as in-scope:
  // the whole point of the boundary is that an unclear case does not pass.
  assert.equal(pathWithinBoundaries("../escape.ts", ["."]), false);
  assert.equal(pathWithinBoundaries("/etc/passwd", ["."]), false);
});
