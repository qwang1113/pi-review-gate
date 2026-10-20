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

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkpointCommitPaths, planCheckpointSweep } from "../lib/checkpoint-sweep.ts";
import { repoRelativeTo } from "../lib/checkpoint-tool.ts";

test("the session's own paths are compared in GIT'S form — absolute ones are made repo-relative (2026-10-20)", () => {
  // The edit handler records ABSOLUTE paths; `git ls-files --others` answers
  // repo-relative ones. Exact matching therefore never hit, and every file the
  // session CREATED was left out of the checkpoint — invisible to the reviewer
  // while the commit still went through.
  const root = mkdtempSync(join(tmpdir(), "rg-sweep-"));
  try {
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib", "new.ts"), "export const x = 1;\n");
    // The macOS /tmp -> /private/tmp seam: the same file reached under two names.
    const viaSymlink = root.replace(/^\/private/, "");
    assert.equal(repoRelativeTo(root, join(root, "lib", "new.ts")), "lib/new.ts");
    assert.equal(repoRelativeTo(realpathSync(root), join(viaSymlink, "lib/new.ts")), "lib/new.ts",
      "a checkout reached through a symlink is the same file");
    assert.equal(repoRelativeTo(root, "lib/trimmed.ts"), "lib/trimmed.ts", "a relative path is already right");
    const outside = repoRelativeTo(root, join(tmpdir(), "elsewhere.txt"));
    assert.ok(outside.startsWith("/"), "a path outside the repo is NOT silently re-based — it stays unmatched (left out)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("N1: only foreign untracked paths left ⇒ nothing to commit (the fingerprint's answer)", () => {
  const sweep = planCheckpointSweep({ untracked: [".pi/notes.md"], own: [] });
  assert.deepEqual(checkpointCommitPaths([], sweep), [], "a foreign file alone is no work to commit");
  const mixed = planCheckpointSweep({ untracked: ["lib/new.ts", ".pi/notes.md"], own: ["lib/new.ts"] });
  assert.deepEqual(checkpointCommitPaths(["lib/a.ts", "lib/new.ts"], mixed), ["lib/a.ts", "lib/new.ts"],
    "tracked changes plus the session's own untracked, each once, never the stranger");
});
