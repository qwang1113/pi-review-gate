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

function gitOrNull(cwd, args) {
  try {
    return git(cwd, args);
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
function submoduleDigest(cwd, depth) {
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
    parts.push(`${path}:${worktreeTree(subCwd, depth + 1)}`);
  }
  return parts.join("\n");
}

// Content tree of one repository's worktree (parent or submodule).
// Throws on any failure so callers fail CLOSED.
function worktreeTree(cwd, depth) {
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
    // TWO passes (see lib/fingerprint.ts): `--renormalize` re-reads TRACKED
    // file CONTENT (defeating a stale stat cache from an ancient preserved
    // mtime) but adds no untracked files; the plain `-A` pass then picks those
    // up. Running only the first silently dropped every untracked file.
    git(cwd, ["add", "-A", "--renormalize", "--", REPO_ROOT_PATHSPEC], env);
    git(cwd, ["add", "-A", "--", REPO_ROOT_PATHSPEC], env);
    git(cwd, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...GATE_EXCLUDE_PATHSPECS], env);

    const tree = git(cwd, ["write-tree"], env);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(tree)) {
      throw new FingerprintUnavailable("write-tree returned a non-object-id");
    }

    const submodules = submoduleDigest(cwd, depth);
    return submodules === "" ? tree : sha256(`${tree}\0${submodules}`);
  } finally {
    if (shadowDir) {
      try { rmSync(shadowDir, { recursive: true, force: true }); } catch { /* temp dir */ }
    }
  }
}

function compute(cwd) {
  try {
    const digest = worktreeTree(cwd, 0);
    const head = gitOrNull(cwd, ["rev-parse", "HEAD"]) ?? "NO_HEAD";
    return { digest, head, unavailable: false, version: FINGERPRINT_VERSION };
  } catch {
    // Every failure path — git error, unreadable index, unrestorable mtime,
    // unreadable submodule — lands here and fails CLOSED.
    return UNAVAILABLE;
  }
}

const cwd = process.argv[2] || process.cwd();
console.log(JSON.stringify(compute(cwd)));
