/**
 * Snapshot isolation for reviewers.
 *
 * PROBLEM. A reviewer in this repo is not a passive reader: it runs `bash`,
 * it runs the test suite, and its strongest check is MUTATION analysis —
 * delete the code under review and confirm the test actually fails. Today it
 * does all of that in the LIVE worktree, which has three consequences:
 *
 *   1. It fights the main agent. Nothing may be fixed while a review runs,
 *      so the loop is strictly serial: review (minutes) THEN fix (minutes).
 *   2. It fights the other reviewer. The small-diff path spawns TWO
 *      cross-family reviewers in parallel, both allowed to write, both doing
 *      mutation analysis on the same files.
 *   3. It fights the gate. Every write changes the very tree being judged and
 *      can invalidate the precommit PASS; a reviewer that dies mid-mutation
 *      leaves the user's code in the mutated state.
 *
 * WHAT THIS DOES. Each reviewer instance gets its own throwaway git worktree
 * whose content is EXACTLY the tree the gate fingerprints (same shadow-index
 * pass, `worktreeTreeOid`), with `node_modules` symlinked so the suite runs.
 * The reviewer may then read, run and mutate freely: it is holding a copy.
 * The main agent keeps sole ownership of the real worktree and may start
 * fixing streamed findings immediately.
 *
 * WHY THIS CANNOT LOOSEN THE GATE. The snapshot only changes WHERE a reviewer
 * runs, never what a verdict means. A verdict still binds to the worktree
 * fingerprint: if the main agent fixed something while the review ran, a READY
 * simply no longer matches the worktree and the gate demands another round —
 * the existing, unchanged fail-closed rule. On top of that, `verifySnapshot`
 * re-derives the snapshot's tree afterwards: a reviewer that left its mutation
 * in place was verifying against code it had modified itself, so its READY is
 * not trustworthy (BLOCKED still is — findings stay valid and BLOCKED never
 * ships anything).
 *
 * FAIL-SOFT. Every failure returns `undefined` instead of throwing: a host
 * where `git worktree` is unavailable simply reviews in place, exactly as
 * before. Isolation is an optimization and a safety net, never a gate.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitBaseEnv, worktreeTreeOid } from "./fingerprint.ts";

/** Directory name (under the repo's gate-owned `.pi/`) for finding streams. */
export const REVIEW_STREAM_DIR = "review-stream";

/** Prefix of every snapshot directory, so orphans are identifiable. */
export const SNAPSHOT_PREFIX = "rg-review-snap-";

/** Orphan snapshots older than this are reclaimed on the next create/prune. */
export const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Directory (under the repo's gate-owned `.pi/`) that holds the snapshots. */
export const SNAPSHOT_DIR = "review-snapshots";

/**
 * Where snapshots live: inside the repo's gate-owned `.pi/`, NOT in `/tmp`.
 *
 * `/tmp` was the obvious choice and it was wrong: a snapshot's absolute path is
 * visible to the code under review, and path-sensitive behaviour then differs
 * between the snapshot and the real worktree. Measured here — this repo's own
 * `pi-self` guard treats any `/tmp/…` path as a scratch location, so reviewing
 * THIS repository inside a `/tmp` snapshot produced 4 failures that do not
 * exist in the real tree: pure false-BLOCKED noise that costs a whole round.
 *
 * `.pi/` is excluded from the fingerprint (GATE_EXCLUDE_PATHSPECS), so
 * snapshots living there cannot disturb the tree under review, and they sit on
 * the same filesystem as the repo (fast `checkout-index`, working symlinks).
 * Falls back to the system temp dir when `.pi/` cannot be created.
 */
export function snapshotBaseDir(repoRoot: string): string {
  const preferred = join(repoRoot, ".pi", SNAPSHOT_DIR);
  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    return tmpdir();
  }
}

/**
 * Paths the snapshot ADDS for the reviewer's benefit, and which therefore
 * must not count as "the reviewer modified the snapshot".
 *
 * `node_modules` is a symlink we create so the suite can run. A `.gitignore`
 * almost always spells it `node_modules/`, which matches a DIRECTORY and not a
 * symlink — so `git add -A` stages it and the snapshot looks modified the
 * instant it is built. Left unhandled, every verification returned DRIFTED and
 * every READY would have been downgraded.
 */
export const SNAPSHOT_ADDED_PATHSPECS: readonly string[] = Object.freeze([":/node_modules"]);

/**
 * Paths that must be carried into the snapshot even though the fingerprint
 * excludes them.
 *
 * DELIBERATELY EMPTY since 2026-08-23. It used to carry `.pi/loop-goal.md`
 * (the reviewer's acceptance contract), but a snapshot that contains ANY
 * `.pi/` directory is misdetected by pi-subagents as a project root: its
 * nearest-project-root probe walks up from the spawn cwd and the first
 * directory that HAS a `.pi/` wins — and that directory is the snapshot
 * itself. A snapshot-as-project-root has no `.pi/agents/`, so the project
 * layer of the model config (the user's per-agent slots) silently vanishes
 * and every reviewer falls back to the GLOBAL agent definition. The goal
 * text is injected into the spawn task verbatim by `buildShardPrompt`
 * (prepare_review), so carrying the file buys nothing that a snapshot
 * without `.pi/` does not already provide.
 */
export const SNAPSHOT_CARRIED_FILES: readonly string[] = Object.freeze([]);

/**
 * Is `abs` a review-snapshot path? Snapshot worktrees live under
 * `rg-review-snap-*` + `/` + `<instance>` either inside
 * `<repo>/.pi/review-snapshots/` or (fallback) directly under the system
 * temp dir. The extension
 * uses this to stay INERT inside a reviewer's disposable copy: a session
 * whose cwd is a snapshot must not initialize gate state or write a sidecar
 * into the snapshot — that would both disturb the judged tree and (by
 * recreating `.pi/`) re-arm pi-subagents' project-root misdetection.
 */
export function isReviewSnapshotPath(abs: string): boolean {
  const normalized = abs.replace(/\\/g, "/");
  // Match on the unique prefix segment, not the full layout: the primary
  // layout is `<repo>/.pi/review-snapshots/rg-review-snap-*/<instance>`,
  // but snapshotBaseDir falls back to the system temp dir when `.pi/` is
  // unwritable, yielding `<tmpdir>/rg-review-snap-*/<instance>`. The prefix
  // appears in both, and `rg-review-snap-` is unique to this gate. (The
  // segment match is deliberately not anchored tighter: a real checkout
  // whose path contains the segment is vanishingly unlikely, and the
  // consequence of a MISS is a fully-active extension inside a snapshot
  // (workflow layers wrongly enforcing) while a FALSE POSITIVE only makes
  // the extension inert in an ordinary session — the false-positive
  // direction is the safer one to err toward.)
  return normalized.includes("/" + SNAPSHOT_PREFIX);
}

export interface ReviewSnapshot {
  /** Absolute path of the throwaway worktree the reviewer must run in. */
  dir: string;
  /** Tree OID the snapshot was materialized from (the fingerprinted tree). */
  tree: string;
  /** Instance label, unique per reviewer of one round. */
  instance: string;
  /**
   * ABSOLUTE path, inside the REAL repo, of this instance's finding stream.
   *
   * Absolute on purpose: the reviewer's cwd is the snapshot, so a relative
   * `.pi/review-stream/...` would land in the snapshot's own `.pi/` where the
   * main agent never looks — the stream would appear to work and deliver
   * nothing.
   */
  streamPath: string;
}

export interface CreateSnapshotOptions {
  /** Repo root whose worktree is under review. */
  repoRoot: string;
  /** Unique label for this reviewer instance (e.g. "shard-1", "integration"). */
  instance: string;
  /** Run id grouping the instances of one round. */
  runId: string;
  /** Pre-computed fingerprint tree, when the caller already has one. */
  tree?: string;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: env ?? gitBaseEnv(),
  }).trim();
}

/**
 * Sanitize an instance label so it is safe inside a filename and a directory
 * name.
 *
 * EXPORTED because the caller must sanitize BEFORE it plans: the snapshot
 * records the sanitized label, so a caller comparing its raw labels against the
 * created snapshots would think `a/b` (→ `a-b`) had failed and refuse a
 * perfectly good plan.
 */
export function safeLabel(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "instance";
}

/**
 * Absolute path of an instance's finding stream inside the REAL repo.
 *
 * Lives under `.pi/`, which the fingerprint excludes — so a reviewer writing
 * its findings can never disturb the tree it is judging.
 */
export function streamPathFor(repoRoot: string, runId: string, instance: string): string {
  return join(repoRoot, ".pi", REVIEW_STREAM_DIR, `${safeLabel(runId)}-${safeLabel(instance)}.jsonl`);
}

/**
 * Materialize a snapshot for ONE reviewer instance, or `undefined` when the
 * host cannot provide one (no git, no commit yet, worktree add refused).
 */
export function createReviewSnapshot(opts: CreateSnapshotOptions): ReviewSnapshot | undefined {
  const { repoRoot, instance, runId } = opts;
  let dir: string | undefined;
  try {
    const tree = opts.tree ?? worktreeTreeOid(repoRoot);
    // mkdtemp reserves the name; `git worktree add` insists the path is empty
    // or absent, so hand it a fresh child of the reserved directory.
    const parent = mkdtempSync(join(snapshotBaseDir(repoRoot), SNAPSHOT_PREFIX));
    dir = join(parent, safeLabel(instance));

    // --no-checkout: start EMPTY. Checking out HEAD first and overlaying the
    // tree would leave files that HEAD has and the change under review
    // deleted — the reviewer would then judge a tree that never existed.
    git(repoRoot, ["worktree", "add", "--detach", "--no-checkout", "-q", dir, "HEAD"]);

    // Populate from the fingerprinted tree using the snapshot's OWN index.
    //
    // A linked worktree already has a private index
    // (`.git/worktrees/<name>/index`), so nothing leaks into the shared repo —
    // and using it is load-bearing rather than merely tidy. An earlier version
    // wrote through a temporary GIT_INDEX_FILE, which left the worktree's real
    // index EMPTY: inside the snapshot `git diff HEAD` then reported the whole
    // repository as deleted (measured: "123 files changed, 50344 deletions").
    // The reviewer's very first orientation command would have been garbage.
    //
    // With the tree read into the worktree's own index, `git diff HEAD` inside
    // the snapshot shows EXACTLY the change under review — the reviewer gets
    // the diff for free, and `git status` stays honest.
    git(dir, ["read-tree", tree]);
    git(dir, ["checkout-index", "-a", "-f"]);

    // The suite must actually run: node_modules is gitignored, so it is not in
    // the tree. A symlink is enough (Node resolves through it) and costs
    // nothing, unlike copying a dependency tree per reviewer.
    //
    // SHARED PATH #1 of 2 — stated honestly rather than glossed over. This
    // symlink points at the REAL node_modules, so a reviewer that wrote under
    // `node_modules/` would write into the live repository, and the drift
    // check cannot see it (the path is excluded, or every snapshot would look
    // modified). Hardlink-copying was measured as a fix and rejected: it costs
    // 1.2s and 50k inodes per snapshot here, and does NOT protect against
    // in-place writes anyway (verified — appending through a hardlink changed
    // the original). So the boundary is a rule the prompts state explicitly:
    // never write under node_modules; everything else is a private copy.
    //
    // SHARED PATH #2 is `.git` itself: a linked worktree shares the common git
    // dir, so `.git/hooks` is the REAL repo's L3 hook layer. A reviewer that ran
    // the hook installer inside its snapshot repointed those hooks at a
    // directory that was deleted with the round, and every later commit died on
    // a missing hook (observed while committing this change). Both installers
    // now REFUSE to run from any path containing an `rg-review-snap-` segment
    // (both the .pi/review-snapshots/ layout and the tmpdir fallback;
    // scripts/install-git-hooks.sh, scripts/install-package.mjs), and the
    // reviewer prompts name `.git` as shared.
    const modules = join(repoRoot, "node_modules");
    if (existsSync(modules)) {
      try { symlinkSync(modules, join(dir, "node_modules"), "dir"); } catch { /* optional */ }
    }

    // SNAPSHOT_CARRIED_FILES is deliberately EMPTY (see its docblock: a
    // snapshot containing .pi/ is misdetected by pi-subagents as a project
    // root). The loop stays as a mechanical guard: re-adding any carry here
    // trips the "snapshot contains no .pi" test.
    for (const rel of SNAPSHOT_CARRIED_FILES) {
      const src = join(repoRoot, rel);
      if (!existsSync(src)) continue;
      const dest = join(dir, rel);
      try {
        mkdirSync(join(dest, ".."), { recursive: true });
        copyFileSync(src, dest);
      } catch { /* best-effort: the spawn path also injects the goal text */ }
    }

    const streamPath = streamPathFor(repoRoot, runId, instance);
    try { mkdirSync(join(streamPath, ".."), { recursive: true }); } catch { /* stream is optional */ }

    return { dir, tree, instance: safeLabel(instance), streamPath };
  } catch {
    // Fail-soft: the caller reviews in the live worktree, as it always did.
    if (dir) { try { removeReviewSnapshot({ dir } as ReviewSnapshot, opts.repoRoot); } catch { /* ignore */ } }
    return undefined;
  }
}

export interface SnapshotVerification {
  /** True when the snapshot still holds exactly the tree it was built from. */
  clean: boolean;
  /** Tree OID observed after the run ("" when it could not be computed). */
  observedTree: string;
  /** Human-readable one-liner for the review record. */
  summary: string;
}

/**
 * Did the reviewer leave the snapshot as it found it?
 *
 * A mutation left in place means the reviewer's LAST verification ran against
 * code it had altered itself, so a READY from that run cannot be trusted. This
 * is deliberately asymmetric: BLOCKED stays fully valid (its findings are
 * still real, and BLOCKED ships nothing), and the only cost of a false alarm —
 * a reviewer that left a stray draft file behind — is re-running one reviewer
 * against a freshly materialized snapshot. Tighten-only by construction: it
 * can withhold trust, never grant it.
 */
export function verifySnapshot(snapshot: ReviewSnapshot): SnapshotVerification {
  let observedTree = "";
  try {
    // Same tree computation the gate uses, minus the paths the snapshot itself
    // added (SNAPSHOT_ADDED_PATHSPECS) — the reviewer is judged on what IT
    // changed, not on the scaffolding we handed it.
    observedTree = worktreeTreeOid(snapshot.dir, SNAPSHOT_ADDED_PATHSPECS);
  } catch {
    return {
      clean: false,
      observedTree: "",
      summary:
        `snapshot ${snapshot.instance}: tree could not be re-derived — treat a READY from this ` +
        `reviewer as unverified and re-run it in a fresh snapshot`,
    };
  }
  if (observedTree === snapshot.tree) {
    return {
      clean: true,
      observedTree,
      summary: `snapshot ${snapshot.instance}: clean (tree ${observedTree.slice(0, 12)} unchanged)`,
    };
  }
  return {
    clean: false,
    observedTree,
    summary:
      `snapshot ${snapshot.instance}: DRIFTED (built ${snapshot.tree.slice(0, 12)}, ended ` +
      `${observedTree.slice(0, 12)}) — the reviewer left its own edits in place, so its final ` +
      `checks ran against code it had modified: a READY from it is NOT accepted, re-run the ` +
      `reviewer in a fresh snapshot. A BLOCKED verdict stays valid.`,
  };
}

/** Remove one snapshot (worktree registration included). Best-effort. */
export function removeReviewSnapshot(snapshot: Pick<ReviewSnapshot, "dir">, repoRoot: string): void {
  // Drop the symlink first: `rm -rf` never follows one, but leaving it while
  // git prunes the directory has no upside either.
  try { rmSync(join(snapshot.dir, "node_modules"), { force: true }); } catch { /* ignore */ }
  try {
    git(repoRoot, ["worktree", "remove", "--force", snapshot.dir]);
  } catch {
    try { rmSync(snapshot.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  // The parent is the mkdtemp reservation; it holds the private index too.
  try { rmSync(join(snapshot.dir, ".."), { recursive: true, force: true }); } catch { /* ignore */ }
  try { git(repoRoot, ["worktree", "prune"]); } catch { /* ignore */ }
}

/**
 * Reclaim snapshots a crashed session left behind.
 *
 * Age-based rather than pid-based on purpose: a snapshot is worthless once its
 * reviewer is gone, and the failure this guards against — /tmp filling up over
 * weeks of loops — is silent. Only our own prefix is ever touched.
 *
 * `baseDir` exists so a TEST can reclaim inside its own directory. Without it
 * the suite swept the real temp dir and deleted a snapshot a live review was
 * using in another session — the test was a wrecking ball aimed at the
 * developer's own machine.
 */
export function pruneOrphanSnapshots(
  repoRoot: string,
  now: number = Date.now(),
  maxAgeMs: number = SNAPSHOT_MAX_AGE_MS,
  baseDir?: string,
): number {
  // Default to this repo's own snapshot dir; a test passes its own sandbox.
  const dir = baseDir ?? snapshotBaseDir(repoRoot);
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith(SNAPSHOT_PREFIX)) continue;
    const path = join(dir, name);
    try {
      const age = now - lstatSync(path).mtimeMs;
      if (age < maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch { /* another session may be removing it concurrently */ }
  }
  if (removed > 0) { try { git(repoRoot, ["worktree", "prune"]); } catch { /* ignore */ } }
  return removed;
}
