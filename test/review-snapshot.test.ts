/**
 * Snapshot isolation — against a REAL git repository.
 *
 * These are not shape tests: the whole value of the feature is a behavioural
 * claim about git ("the reviewer holds a frozen copy and cannot touch the
 * user's files"), so every assertion here runs real plumbing in a throwaway
 * repo. Hermetic: its own GIT_* env, its own tmp dir, no reliance on this
 * repository's state.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  SNAPSHOT_CARRIED_FILES,
  SNAPSHOT_DIR,
  SNAPSHOT_PREFIX,
  repoSnapshotKey,
  snapshotBaseDir,
  createReviewSnapshot,
  pruneOrphanSnapshots,
  removeReviewSnapshot,
  streamPathFor,
  verifySnapshot,
  isReviewSnapshotPath,
} from "../lib/review-snapshot.ts";

const HERMETIC_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: HERMETIC_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A repo with one commit and an uncommitted change — the gate's normal input. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-snap-test-"));
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  writeFileSync(join(dir, "committed.txt"), "v1\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.pi/\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  // The change under review: one edit, one new file.
  writeFileSync(join(dir, "committed.txt"), "v2-dirty\n");
  writeFileSync(join(dir, "added.ts"), "export const x = 1;\n");
  return dir;
}

const cleanups: string[] = [];
function track(dir: string): string {
  cleanups.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test("a snapshot holds the UNCOMMITTED change, not HEAD", () => {
  const repo = track(makeRepo());
  const snap = createReviewSnapshot({ repoRoot: repo, instance: "shard-1", runId: "run1" });
  assert.ok(snap, "snapshot must materialize in a normal git repo");
  // The dirty edit and the untracked-but-added file are both present…
  assert.equal(readFileSync(join(snap!.dir, "committed.txt"), "utf8"), "v2-dirty\n");
  assert.ok(existsSync(join(snap!.dir, "added.ts")));
  // …and the snapshot tree is exactly what verify() will compare against.
  assert.match(snap!.tree, /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
  assert.equal(verifySnapshot(snap!).clean, true);
  removeReviewSnapshot(snap!, repo);
});

test("REGRESSION: a file DELETED in the change must not reappear from HEAD", () => {
  // `git worktree add` checks out HEAD; overlaying the tree on top would leave
  // deleted files behind, so the reviewer would judge a tree that never
  // existed. --no-checkout is what prevents that.
  const repo = track(makeRepo());
  rmSync(join(repo, "committed.txt"));
  const snap = createReviewSnapshot({ repoRoot: repo, instance: "shard-1", runId: "run1" });
  assert.ok(snap);
  assert.equal(existsSync(join(snap!.dir, "committed.txt")), false, "deleted file must stay deleted");
  removeReviewSnapshot(snap!, repo);
});

test("REGRESSION: writing in a snapshot cannot touch the real worktree", () => {
  // The reason the whole feature exists: reviewers mutate files to verify
  // tests, and today they do it in the user's worktree.
  const repo = track(makeRepo());
  const snap = createReviewSnapshot({ repoRoot: repo, instance: "integration", runId: "run1" });
  assert.ok(snap);
  writeFileSync(join(snap!.dir, "committed.txt"), "MUTATED BY REVIEWER\n");
  assert.equal(readFileSync(join(repo, "committed.txt"), "utf8"), "v2-dirty\n");
  removeReviewSnapshot(snap!, repo);
});

test("two concurrent snapshots are independent (shard vs shard)", () => {
  const repo = track(makeRepo());
  const a = createReviewSnapshot({ repoRoot: repo, instance: "shard-1", runId: "run1" });
  const b = createReviewSnapshot({ repoRoot: repo, instance: "shard-2", runId: "run1" });
  assert.ok(a && b);
  assert.notEqual(a!.dir, b!.dir);
  assert.equal(a!.tree, b!.tree, "both must review the same tree");
  writeFileSync(join(a!.dir, "committed.txt"), "shard-1 mutation\n");
  assert.equal(readFileSync(join(b!.dir, "committed.txt"), "utf8"), "v2-dirty\n");
  assert.equal(verifySnapshot(b!).clean, true, "shard-2 must not be blamed for shard-1's write");
  assert.equal(verifySnapshot(a!).clean, false, "shard-1 left its mutation in place");
  removeReviewSnapshot(a!, repo);
  removeReviewSnapshot(b!, repo);
});

test("verifySnapshot: a restored mutation is clean, a left-behind one is not", () => {
  const repo = track(makeRepo());
  const snap = createReviewSnapshot({ repoRoot: repo, instance: "integration", runId: "run1" });
  assert.ok(snap);
  const original = readFileSync(join(snap!.dir, "added.ts"), "utf8");

  writeFileSync(join(snap!.dir, "added.ts"), "// mutation\n");
  const dirty = verifySnapshot(snap!);
  assert.equal(dirty.clean, false);
  assert.match(dirty.summary, /DRIFTED/);
  assert.match(dirty.summary, /READY from it is NOT accepted/);
  assert.match(dirty.summary, /BLOCKED verdict stays valid/, "BLOCKED must survive drift");

  // Mutation analysis done PROPERLY (restore afterwards) reports clean.
  writeFileSync(join(snap!.dir, "added.ts"), original);
  assert.equal(verifySnapshot(snap!).clean, true);
  removeReviewSnapshot(snap!, repo);
});

test("an untracked scratch file inside the snapshot counts as drift", () => {
  // Documented consequence, pinned so nobody 'fixes' it accidentally: the
  // check is content-addressed over the whole worktree, so scratch files must
  // go to $TMPDIR (the prompt says so). Cost of the false alarm is one re-run.
  const repo = track(makeRepo());
  const snap = createReviewSnapshot({ repoRoot: repo, instance: "shard-1", runId: "run1" });
  assert.ok(snap);
  writeFileSync(join(snap!.dir, "scratch-notes.txt"), "thinking out loud\n");
  assert.equal(verifySnapshot(snap!).clean, false);
  removeReviewSnapshot(snap!, repo);
});

test("a TRACKED .pi file is still excluded from the snapshot (worktreeTreeOid strips :/.pi)", () => {
  // The gitignored case above is the easy one. The harder case: a `.pi/`
  // file that IS committed (git add -f) must still not materialize in the
  // snapshot — worktreeTreeOid runs `git rm --cached --ignore-unmatch --
  // :/.pi :/.pi-subagents` before write-tree (lib/fingerprint.ts), and a
  // regression here would recreate the pi-subagents project-root
  // misdetection through a tracked file.
  const repo = track(makeRepo());
  mkdirSync(join(repo, ".pi"), { recursive: true });
  writeFileSync(join(repo, ".pi", "tracked.json"), "{}");
  git(repo, ["add", "-f", ".pi/tracked.json"]);
  git(repo, ["commit", "-qm", "track a .pi file"]);
  const snap = createReviewSnapshot({ repoRoot: repo, instance: "integration", runId: "run1" });
  assert.ok(snap);
  assert.equal(existsSync(join(snap!.dir, ".pi")), false,
    "even a TRACKED .pi/ must not materialize in the snapshot");
  assert.equal(verifySnapshot(snap!).clean, true);
  removeReviewSnapshot(snap!, repo);
});

test("the loop goal is NOT carried into the snapshot (goal text rides the spawn task)", () => {
  // The snapshot used to copy `.pi/loop-goal.md` so the reviewer could read
  // the acceptance contract. It stopped in 2026-08-23: a snapshot that
  // contains ANY `.pi/` directory is misdetected by pi-subagents as a
  // project root (its nearest-project-root probe walks up from the spawn cwd
  // and the first dir that HAS `.pi/` wins — which is the snapshot itself),
  // so the project layer of the model config silently vanishes and every
  // reviewer falls back to the GLOBAL agent definition. The goal text is
  // injected into the spawn task verbatim by buildShardPrompt, so the file
  // buys nothing.
  const repo = track(makeRepo());
  mkdirSync(join(repo, ".pi"), { recursive: true });
  writeFileSync(join(repo, ".pi", "loop-goal.md"), "# goal\n- criterion 1\n");
  const snap = createReviewSnapshot({ repoRoot: repo, instance: "integration", runId: "run1" });
  assert.ok(snap);
  assert.equal(SNAPSHOT_CARRIED_FILES.length, 0, "nothing may be carried under .pi/ anymore");
  assert.equal(existsSync(join(snap!.dir, ".pi")), false,
    "a snapshot must not contain a .pi/ directory (pi-subagents project-root misdetection)");
  // …and the snapshot still verifies clean.
  assert.equal(verifySnapshot(snap!).clean, true);
  // Path-recognition asserts BEFORE the cleanup: after removal they read as
  // checking a deleted dir (pure string match, but order matters for readers).
  assert.equal(isReviewSnapshotPath(snap!.dir), true,
    "the real snapshot dir must be recognized (and its parent prefix with it)");
  assert.equal(isReviewSnapshotPath(join(snap!.dir, "..")), true, "the reserved parent itself");
  removeReviewSnapshot(snap!, repo);
});

test("isReviewSnapshotPath recognizes snapshot worktrees and nothing else", () => {
  assert.equal(isReviewSnapshotPath("/repo/.pi/review-snapshots/rg-review-snap-abc/shard-1"), true);
  assert.equal(isReviewSnapshotPath("/repo/.pi/review-snapshots/rg-review-snap-abc/shard-2/sub"), true);
  assert.equal(isReviewSnapshotPath("/repo/.pi/review-snapshots/other/shard-1"), false, "not our prefix");
  assert.equal(isReviewSnapshotPath("/repo/.pi/review-stream/review-x-shard-1.jsonl"), false, "streams are not snapshots");
  assert.equal(isReviewSnapshotPath("/repo/.pi/review-gate.json"), false);
  assert.equal(isReviewSnapshotPath("/repo/lib/review-snapshot.ts"), false);
  assert.equal(isReviewSnapshotPath("/repo/.pi/review-snapshots/rg-review-snap-x"), true, "the reserved parent itself");
  assert.equal(isReviewSnapshotPath("/tmp/rg-review-snap-abc/shard-1"), true, "tmpdir fallback layout (snapshotBaseDir fallback)");
});

test("the stream path is absolute, per-instance, and inside the gate-owned dir", () => {
  const p1 = streamPathFor("/repo", "run1", "shard-1");
  const p2 = streamPathFor("/repo", "run1", "shard-2");
  assert.equal(p1, "/repo/.pi/review-stream/run1-shard-1.jsonl");
  assert.notEqual(p1, p2, "two reviewers must never share one stream file");
  // A hostile label cannot escape the stream dir: separators are stripped, and
  // the name always carries the runId prefix and the .jsonl suffix, so it can
  // never resolve to the parent directory itself.
  for (const label of ["../../etc/passwd", "..", "/abs/path", "a/b"]) {
    const p = streamPathFor("/repo", "run1", label);
    assert.ok(p.startsWith("/repo/.pi/review-stream/"), `${label} escaped: ${p}`);
    assert.equal(resolve(p).startsWith(resolve("/repo/.pi/review-stream") + "/"), true, label);
    assert.match(p, /\.jsonl$/);
  }
});

test("removal takes the worktree registration with it", () => {
  const repo = track(makeRepo());
  const snap = createReviewSnapshot({ repoRoot: repo, instance: "shard-1", runId: "run1" });
  assert.ok(snap);
  removeReviewSnapshot(snap!, repo);
  assert.equal(existsSync(snap!.dir), false);
  assert.doesNotMatch(git(repo, ["worktree", "list"]), /rg-review-snap/);
});

test("createReviewSnapshot fails SOFT outside a git repo (review in place)", () => {
  // Isolation is an optimization; a host that cannot provide it must keep
  // reviewing, not break the loop.
  const notARepo = track(mkdtempSync(join(tmpdir(), "rg-snap-norepo-")));
  assert.equal(createReviewSnapshot({ repoRoot: notARepo, instance: "x", runId: "r" }), undefined);
});

test("orphan snapshots are reclaimed by age, and only our own prefix", () => {
  // HERMETIC: prune inside a private base dir. An earlier version swept the
  // real temp dir and deleted a snapshot that a live review in ANOTHER session
  // was using — a test must never reach outside its own sandbox.
  const base = track(mkdtempSync(join(tmpdir(), "rg-prune-base-")));
  const ours = join(base, `${SNAPSHOT_PREFIX}abc123`);
  mkdirSync(join(ours, "integration"), { recursive: true });
  const foreign = join(base, "someone-elses-tmp");
  mkdirSync(foreign, { recursive: true });
  const repo = track(makeRepo());

  // Nothing is old yet.
  assert.equal(pruneOrphanSnapshots(repo, Date.now(), 60_000, base), 0);
  assert.ok(existsSync(ours));

  // Far in the future, ours is reclaimed; the foreign dir is not.
  const removed = pruneOrphanSnapshots(repo, Date.now() + 7 * 24 * 60 * 60 * 1000, 60_000, base);
  assert.equal(removed, 1);
  assert.equal(existsSync(ours), false);
  assert.equal(existsSync(foreign), true, "only directories with our prefix may be touched");
  assert.ok(SNAPSHOT_PREFIX.startsWith("rg-review-snap"));
});

test("REGRESSION: a freshly built snapshot verifies CLEAN despite the node_modules symlink", () => {
  // `.gitignore` normally says `node_modules/`, which matches a directory and
  // NOT the symlink the snapshot creates — so `git add -A` staged it and every
  // snapshot looked modified the moment it was built. Every READY would then
  // have been downgraded: the feature would have blocked its own loop.
  const repo = track(makeRepo());
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  const snap = createReviewSnapshot({ repoRoot: repo, instance: "integration", runId: "run1" });
  assert.ok(snap);
  assert.ok(existsSync(join(snap!.dir, "node_modules")), "the suite must be runnable in the snapshot");
  assert.equal(verifySnapshot(snap!).clean, true, "scaffolding we added must not read as reviewer drift");
  // …and a REAL reviewer edit is still caught.
  writeFileSync(join(snap!.dir, "added.ts"), "// mutated\n");
  assert.equal(verifySnapshot(snap!).clean, false);
  removeReviewSnapshot(snap!, repo);
});

test("the snapshot's own index is populated, so `git diff HEAD` shows the change under review", () => {
  // The reviewer's first orientation command. With the tree written through a
  // private index the worktree index stayed EMPTY and git reported the whole
  // repository as deleted ("123 files changed, 50344 deletions").
  const repo = track(makeRepo());
  const snap = createReviewSnapshot({ repoRoot: repo, instance: "integration", runId: "run1" });
  assert.ok(snap);
  const diff = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: snap!.dir,
    encoding: "utf8",
    env: HERMETIC_ENV,
  });
  assert.match(diff, /committed\.txt/, "the edited file must show as modified");
  assert.doesNotMatch(diff, /\.gitignore\s+\|\s+\d+ -+$/m, "untouched files must not read as deleted");
  assert.equal(diff.includes("deletions(-)") && !diff.includes("insertions(+)"), false);
  removeReviewSnapshot(snap!, repo);
});

test("snapshots live outside every repo: ~/.pi/review-snapshots/<repo-key>/ (user requirement 2026-08-27)", () => {
  // Outside every repo root, whole-tree test discovery (jest default testMatch
  // from rootDir, a bare `node --test`, an IDE scan) can NEVER reach the
  // snapshot's own test/ copy — no matter who runs the suite. `~/.pi` is a
  // dot-directory too, so bare `node --test` additionally skips it.
  // NOT /tmp: this repo's pi-self guard treats /tmp as scratch — measured 4
  // false failures reviewing inside a /tmp snapshot.
  const repo = track(makeRepo());
  const home = track(mkdtempSync(join(tmpdir(), "rg-snap-home-")));
  const base = join(home, ".pi", SNAPSHOT_DIR, repoSnapshotKey(repo));
  assert.equal(snapshotBaseDir(repo, home), base);
  // Home inside the repo must NOT host snapshots (round-11 P1): containment
  // guarantee — the repo-local fallback is used instead.
  const homeInRepo = track(mkdtempSync(join(tmpdir(), "rg-snap-homeinrepo-")));
  const repo2 = track(makeRepo());
  assert.equal(snapshotBaseDir(repo2, repo2), join(repo2, ".pi", SNAPSHOT_DIR));
  // Round-12/13 P1 regression: PHYSICAL containment — a home that is a
  // not-yet-existing path reached through a symlink INTO repoRoot must still
  // drop the home candidate (mkdirSync would follow the symlink into the repo).
  const repo3 = track(makeRepo());
  const linkDir = track(join(tmpdir(), "rg-snap-link-into-repo"));
  rmSync(linkDir, { recursive: true, force: true });
  symlinkSync(repo3, linkDir);
  const homeViaSymlink = join(linkDir, "not-yet", "home");
  assert.equal(snapshotBaseDir(repo3, homeViaSymlink), join(repo3, ".pi", SNAPSHOT_DIR),
    "a symlinked-into-repo home must fall back to the repo-local layout");
  rmSync(linkDir, { recursive: true, force: true });
  const snap = createReviewSnapshot({ repoRoot: repo, instance: "integration", runId: "run1", home });
  assert.ok(snap);
  assert.ok(snap!.dir.startsWith(base), `snapshot escaped the home base: ${snap!.dir}`);
  assert.ok(!snap!.dir.startsWith(join(repo, ".pi")), "snapshot must not live inside the repo");
  // Not a direct child of the temp ROOT (this test's repo happens to live in
  // the temp dir, so the check is about the snapshot's PARENT, not the prefix).
  assert.notEqual(dirname(dirname(snap!.dir)), tmpdir());
  // Living outside the repo must NOT make the repo look modified.
  assert.equal(verifySnapshot(snap!).clean, true);
  const outerTree = execFileSync("git", ["status", "--porcelain"], {
    cwd: repo, encoding: "utf8", env: HERMETIC_ENV,
  });
  assert.doesNotMatch(outerTree, /review-snapshots/, "snapshots are outside the repo; git status must stay clean");
  removeReviewSnapshot(snap!, repo);
  assert.ok(!existsSync(snap!.dir), "removeReviewSnapshot must take the worktree with it");
});
