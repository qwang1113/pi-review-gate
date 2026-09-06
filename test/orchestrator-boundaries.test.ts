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
  editedPathsOutsideBoundaries,
  isOutsideRepoPath,
  isSensitiveOutsideRepoPath,
  OUT_OF_REPO_SENSITIVE_SEGMENTS,
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
    editedPathsOutsideBoundaries(["lib/orchestrator/a.ts", "extensions/review-gate.ts", "README.md"], boundaries),
    ["extensions/review-gate.ts", "README.md"],
  );
});

test("an unusable path is treated as OUTSIDE — fail-closed", () => {
  // A path we cannot normalize must never be silently accepted as in-scope:
  // the whole point of the boundary is that an unclear case does not pass.
  assert.equal(pathWithinBoundaries("../escape.ts", ["."]), false);
  assert.equal(pathWithinBoundaries("/etc/passwd", ["."]), false);
});

// ---------------------------------------------------------------------------
// Out-of-repo process artifacts (2026-09-06 user decision 方案 C)

test("an out-of-repo process artifact is NOT a boundary violation", () => {
  // Measured twice in round 4: a child writing its completion report to /tmp
  // was reported as out-of-boundary, because an absolute path can never be
  // covered by a repo-relative declaration. It is a process artifact — it
  // cannot pollute the worktree, enter a checkpoint, or reach a tracked file.
  assert.deepEqual(
    editedPathsOutsideBoundaries(["lib/a.ts", "/tmp/rg-task-report.md", "/tmp/scratch/notes.txt"], ["lib"]),
    [],
  );
});

test("the exemption is only for out-of-repo paths: in-repo judgements are unchanged", () => {
  assert.deepEqual(
    editedPathsOutsideBoundaries(["lib/a.ts", "extensions/review-gate.ts", "/tmp/report.md"], ["lib"]),
    ["extensions/review-gate.ts"],
  );
});

test("a relative `..` escape stays a violation — it is not resolvable without IO, so it fails closed", () => {
  assert.deepEqual(editedPathsOutsideBoundaries(["../sibling-repo/x.ts"], ["lib"]), ["../sibling-repo/x.ts"]);
});

test("empty and whitespace entries are dropped rather than reported", () => {
  assert.deepEqual(editedPathsOutsideBoundaries(["", "   "], ["lib"]), []);
});

// ---------------------------------------------------------------------------
// THE SAFETY EDGE (P0): out-of-repo SENSITIVE paths are still violations

test("out-of-repo sensitive paths are still violations — real, home-EXPANDED absolute paths", () => {
  // The paths are written the way `sessionEditedFiles` actually holds them:
  // the shell expanded `~` long before the gate saw them, so a rule written
  // against the literal tilde would never fire. Every one of these must be
  // reported even though it is outside the repo.
  const sensitive = [
    "/Users/someone/.ssh/id_rsa",
    "/Users/someone/.ssh/config",
    "/Users/someone/.pi/review-gate.json",
    "/Users/someone/.pi/agent/agents/reviewer.md",
    "/Users/someone/.aws/credentials",
    "/Users/someone/.gnupg/secring.gpg",
    "/Users/someone/.config/gh/hosts.yml",
    "/Users/someone/.kube/config",
    "/Users/someone/.docker/config.json",
    "/tmp/staging/.env",
    "/tmp/leak/id_ed25519",
    "/tmp/leak/server.pem",
    "/tmp/leak/credentials",
    "/var/tmp/other-repo/.git/hooks/pre-commit",
  ];
  for (const p of sensitive) {
    assert.equal(isSensitiveOutsideRepoPath(p), true, p);
    assert.deepEqual(editedPathsOutsideBoundaries([p], ["lib"]), [p], p);
  }
});

test("the sensitive-segment rule matches wherever the directory sits, not just under $HOME", () => {
  // Fail-closed direction: a backup copy of a key ring somewhere else is no
  // less sensitive than the one in the home directory.
  assert.equal(isSensitiveOutsideRepoPath("/tmp/backup/.ssh/id_rsa"), true);
  assert.equal(isSensitiveOutsideRepoPath("/srv/data/.aws/credentials"), true);
  // … and a same-named file that is NOT inside such a directory is not.
  assert.equal(isSensitiveOutsideRepoPath("/tmp/ssh-notes.md"), false);
  assert.equal(isSensitiveOutsideRepoPath("/tmp/config"), false);
});

test("every declared sensitive segment is honoured — the list is not decoration", () => {
  for (const segment of OUT_OF_REPO_SENSITIVE_SEGMENTS) {
    const p = `/Users/someone/${segment}/thing.conf`;
    assert.equal(isSensitiveOutsideRepoPath(p), true, p);
    assert.deepEqual(editedPathsOutsideBoundaries([p], ["."]), [p], p);
  }
});

test("a harmless out-of-repo artifact is not swept up by the sensitive rule", () => {
  for (const p of ["/tmp/report.md", "/tmp/rg-task/notes.txt", "/var/folders/T/scratch.json"]) {
    assert.equal(isSensitiveOutsideRepoPath(p), false, p);
  }
});

test("isOutsideRepoPath reads the one signal the sidecar actually carries: absoluteness", () => {
  assert.equal(isOutsideRepoPath("/tmp/report.md"), true);
  assert.equal(isOutsideRepoPath("C:\\Users\\x\\report.md"), true);
  assert.equal(isOutsideRepoPath("lib/a.ts"), false);
  assert.equal(isOutsideRepoPath("../escape.ts"), false, "a `..` escape is left to the ordinary check");
});
