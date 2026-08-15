#!/usr/bin/env node
/**
 * Standalone fingerprint computation (CJS, no Pi dependency).
 * Used by git hooks and other external consumers that can't import TypeScript.
 *
 * Mirrors lib/fingerprint.ts — keep them in sync. A behavioural parity test
 * (test/constants.test.ts) runs both implementations and compares digests;
 * drift makes every git hook fail closed.
 *
 * See lib/fingerprint.ts for the full rationale behind the content-addressed,
 * staging-invariant git-tree digest.
 *
 * Output: { digest, head, unavailable } as JSON on stdout.
 */

const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { copyFileSync, mkdtempSync, rmSync, statSync, utimesSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

// Mirror of lib/fingerprint.ts GATE_EXCLUDE_PATHSPECS / REPO_ROOT_PATHSPEC.
// `:/` anchors at the repo root so the digest does not depend on the cwd.
const GATE_EXCLUDE_PATHSPECS = [":/.pi", ":/.pi-subagents"];
const REPO_ROOT_PATHSPEC = ":/";

// Mirror of lib/fingerprint.ts FINGERPRINT_VERSION. Emitted with every result
// so the hook can compare the sidecar's binding version against the algorithm
// that is ACTUALLY running here, instead of hardcoding a number that could
// drift away from the implementation. A parity test keeps the two in sync.
const FINGERPRINT_VERSION = 2;

const UNAVAILABLE = {
  digest: "__UNAVAILABLE__", head: "__UNAVAILABLE__", unavailable: true, version: FINGERPRINT_VERSION,
};

/** Thrown to force the whole fingerprint to fail CLOSED. */
class FingerprintUnavailable extends Error {}

// Backdate margin for the shadow index mtime, measured from
// min(realIndexMtime, now). Mirror of lib/fingerprint.ts.
const RACE_BACKDATE_MS = 5000;

// Mirror of lib/fingerprint.ts GIT_LOCATION_ENV. Inheriting these lets an
// ambient GIT_DIR/GIT_WORK_TREE point the digest at a DIFFERENT repository
// (reproduced: an edit in the real repo left "its" fingerprint unchanged), so
// they are stripped and discovery falls back to the cwd. A parity test keeps
// this list in sync with the TS implementation.
const GIT_LOCATION_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

// Mirror of lib/fingerprint.ts GIT_CONFIG_ENV_PREFIX: GIT_CONFIG_COUNT +
// GIT_CONFIG_KEY_<n>/VALUE_<n>, GIT_CONFIG_PARAMETERS and the
// GLOBAL/SYSTEM/NOSYSTEM source overrides are a second route to the same
// fail-open (e.g. injecting core.excludesFile hides untracked edits from the
// digest). Matched by prefix because the numbered forms are unbounded.
const GIT_CONFIG_ENV_PREFIX = /^GIT_CONFIG(_|$)/;

function gitBaseEnv() {
  const env = { ...process.env };
  for (const key of GIT_LOCATION_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (GIT_CONFIG_ENV_PREFIX.test(key)) delete env[key];
  }
  return env;
}

function git(cwd, args, env) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: env || gitBaseEnv(),
  }).trim();
}

// `env` must be forwarded: the shadow-index passes reach git through
// GIT_INDEX_FILE. Dropping it made `update-index --no-skip-worktree` run
// against the USER'S REAL INDEX and wipe their skip-worktree /
// assume-unchanged bits. Mirror of lib/fingerprint.ts.
function gitOrNull(cwd, args, env) {
  try {
    return git(cwd, args, env);
  } catch {
    return null;
  }
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

// Mirror of lib/fingerprint.ts submodulePaths(). Read gitlinks (mode 160000)
// from the INDEX: it is authoritative and survives a malformed/absent
// .gitmodules, whereas `git config --file .gitmodules` reports "no submodules"
// and "this file is corrupt" identically — a reproducible fail-open.
// --full-name keeps paths repo-root-relative: without it `git ls-files`
// reports them relative to the CWD (`../../sm` from a subdirectory), and since
// submoduleDigest() mixes the path text into the digest, the same content
// hashed to different values from a session subdirectory and from the repo
// toplevel where hooks run — blocking every commit as a false mismatch.
function submodulePaths(cwd) {
  const out = gitOrNull(cwd, ["ls-files", "--stage", "-z", "--full-name", "--", REPO_ROOT_PATHSPEC]);
  if (out === null) throw new FingerprintUnavailable("cannot list index entries");
  const paths = [];
  for (const entry of out.split("\0")) {
    if (!entry.startsWith("160000 ")) continue; // gitlink = submodule
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    paths.push(entry.slice(tab + 1));
  }
  return paths.sort();
}

// Mirror of lib/fingerprint.ts submoduleDigest(): bind each submodule's actual
// CONTENT by recursing with the same worktree-tree algorithm. Hashing
// `git status` text instead would miss a second edit to an already-dirty file
// (the status line stays "M path"), letting unreviewed content be committed.
function submoduleDigest(cwd, depth, opts) {
  if (depth > 10) throw new FingerprintUnavailable("submodule nesting too deep");
  const paths = submodulePaths(cwd);
  if (paths.length === 0) return "";

  const parentTop = gitOrNull(cwd, ["rev-parse", "--show-toplevel"]);
  if (parentTop === null) throw new FingerprintUnavailable("cannot resolve repo toplevel");

  const parts = [];
  for (const path of paths) {
    // Repo-root-relative (--full-name) ⇒ join against the toplevel, not cwd.
    const subCwd = join(parentTop, path);
    // A deinit'd/uninitialized submodule is an empty dir whose rev-parse falls
    // through to the PARENT repo; comparing toplevels detects that. It is a
    // legitimate, common state (CI, shallow checkouts) with no working content
    // to review, so it must NOT fail closed.
    const subTop = gitOrNull(subCwd, ["rev-parse", "--show-toplevel"]);
    if (subTop === null || subTop === parentTop) {
      parts.push(`${path}:UNINITIALIZED`);
      continue;
    }
    parts.push(`${path}:${worktreeDigest(subCwd, depth + 1, opts)}`);
  }
  return parts.join("\n");
}

// Content tree of one repository's worktree (parent or submodule).
// Throws on any failure so callers fail CLOSED.
// Chunk size for update-index argv (a huge repo would blow the argv limit).
const UPDATE_INDEX_CHUNK = 500;

// Materialize the worktree as a git tree and return its BARE OID (no submodule
// mixing), so a caller can both inspect entries with `ls-tree` and hand it to
// worktreeDigest() without paying for a second materialization.
function worktreeTreeOid(cwd) {
  let shadowDir;
  try {
    // --path-format=absolute is required (see lib/fingerprint.ts): the bare
    // path is repo-root-relative and would break in subdirs / linked worktrees.
    const indexPath = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);

    shadowDir = mkdtempSync(join(tmpdir(), "rg-fp-shadow-"));
    const shadowIndex = join(shadowDir, "index");
    // Seeding is required for speed AND correctness: `git add` refuses to
    // stage a path matching .gitignore, so an EMPTY index silently drops
    // files that are gitignored yet TRACKED (`git add -f`), which
    // `git commit -a` still ships.
    //
    // The mtime BACKDATE is load-bearing (see lib/fingerprint.ts):
    // copyFileSync bumps the index mtime forward, which defeats git's
    // racily-clean re-hash and makes same-size edits in the same mtime bucket
    // INVISIBLE to the digest (measured 25/1500 fail-opens without it).
    // Backdating makes git re-hash more, never less, so no verification step
    // is needed. The base is min(indexMtime, now): backdating from a FUTURE
    // index mtime (clock skew / rolled-back clock) would still land in the
    // future and re-arm the fail-open.
    // Only ENOENT (fresh repo, never staged) may be swallowed.
    try {
      const st = statSync(indexPath);
      copyFileSync(indexPath, shadowIndex);
      const base = Math.min(st.mtimeMs, Date.now());
      utimesSync(shadowIndex, st.atime, new Date(base - RACE_BACKDATE_MS));
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }

    const env = { ...gitBaseEnv(), GIT_INDEX_FILE: shadowIndex };

    // add-then-remove (never `git add` with an exclude pathspec): with a
    // gitignored .pi, that form exits 1 on a mere advisory, which is
    // indistinguishable from a real failure. See lib/fingerprint.ts.
    // TWO passes (see lib/fingerprint.ts): the plain `-A` pass runs FIRST so
    // worktree deletions leave the index before `--renormalize` (implied `-u`)
    // stats every tracked file — git aborts with `unable to stat` on a
    // deleted-but-indexed file, failing the fingerprint closed.
    // `--renormalize` then re-reads the remaining TRACKED file CONTENT
    // (defeating a stale stat cache from an ancient preserved mtime) but adds
    // no untracked files. Running only the second silently dropped every
    // untracked file.
    // Clear assume-unchanged / skip-worktree in the SCRATCH index only (see
    // lib/fingerprint.ts): without it `git add` ABORTS on a sparse-checkout
    // repository ("outside of your sparse-checkout definition") and the whole
    // fingerprint fails closed. It can only make git read MORE of the
    // worktree, and on repos without those bits the tree is byte-identical.
    const tracked = git(cwd, ["ls-files", "-z", "--full-name", "--", REPO_ROOT_PATHSPEC], env)
      .split("\0")
      .filter(Boolean);
    for (let i = 0; i < tracked.length; i += UPDATE_INDEX_CHUNK) {
      const chunk = tracked.slice(i, i + UPDATE_INDEX_CHUNK);
      gitOrNull(cwd, ["update-index", "--no-assume-unchanged", "--", ...chunk], env);
      gitOrNull(cwd, ["update-index", "--no-skip-worktree", "--", ...chunk], env);
    }

    git(cwd, ["add", "-A", "--", REPO_ROOT_PATHSPEC], env);
    git(cwd, ["add", "-A", "--renormalize", "--", REPO_ROOT_PATHSPEC], env);
    git(cwd, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...GATE_EXCLUDE_PATHSPECS], env);

    const tree = git(cwd, ["write-tree"], env);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(tree)) {
      throw new FingerprintUnavailable("write-tree returned a non-object-id");
    }
    return tree;
  } finally {
    if (shadowDir) {
      try { rmSync(shadowDir, { recursive: true, force: true }); } catch { /* temp dir */ }
    }
  }
}

// Full digest: the worktree tree plus every submodule's real content.
// `opts.treeOidForCwd` lets a caller that ALREADY materialized a tree hand it
// over, which is what the git hook does — materializing twice doubled the cost
// and ran any `clean` filter twice, so two passes over an unchanged worktree
// could disagree. Mirror of lib/fingerprint.ts worktreeDigest().
function worktreeDigest(cwd, depth, opts) {
  // A per-cwd RESOLVER, not a single tree: submodule recursion asks for other
  // repositories, and handing it one top-level OID would either be wrong or
  // (as an earlier version did) silently fall through to a fresh
  // materialization for every submodule — defeating the sharing exactly where
  // a `clean` filter could make the two passes disagree.
  const resolveTree = (opts && opts.treeOidForCwd) || worktreeTreeOid;
  const tree = resolveTree(cwd);
  const submodules = submoduleDigest(cwd, depth, opts);
  return submodules === "" ? tree : sha256(`${tree}\0${submodules}`);
}

function compute(cwd, opts) {
  try {
    const digest = worktreeDigest(cwd, 0, opts);
    const head = gitOrNull(cwd, ["rev-parse", "HEAD"]) ?? "NO_HEAD";
    return { digest, head, unavailable: false, version: FINGERPRINT_VERSION };
  } catch {
    // Every failure path — git error, unreadable index, unrestorable mtime,
    // unreadable submodule — lands here and fails CLOSED.
    return UNAVAILABLE;
  }
}

// Dual use: a CLI for the git hooks, and a module the divergence checker
// requires so ONE process can materialize the worktree tree once and use it
// for both the divergence comparison and the fingerprint.
module.exports = { compute, worktreeTreeOid, FINGERPRINT_VERSION };

if (require.main === module) {
  const cwd = process.argv[2] || process.cwd();
  console.log(JSON.stringify(compute(cwd)));
}
