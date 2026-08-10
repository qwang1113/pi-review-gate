/**
 * Per-step result cache for the precommit runner.
 *
 * PROBLEM. Every gate binding is content-addressed, so a single edited
 * character invalidates the previous PASS and the whole check set runs again.
 * On a large repo that is minutes of wall clock for a change that provably
 * cannot affect most of the checks (a README typo cannot break `tsc`).
 *
 * SOLUTION. Each step records the digest of the inputs it actually consumes.
 * A later run whose inputs are byte-identical reuses the recorded PASS and
 * marks the step `cached`. The RUN's verdict is still bound by the extension
 * to the CURRENT worktree fingerprint, so the gate's meaning is unchanged:
 * "every check is green for exactly this tree". Only redundant computation is
 * removed, never a requirement.
 *
 * WHY THE KEYS ARE GIT TREES, NOT stat() DATA. A cache hit skips real work, so
 * a key that can miss a change is a fail-OPEN. `git status`/mtime heuristics
 * have a documented racily-clean blind spot (see lib/fingerprint.ts), which is
 * exactly the class of change — same size, same mtime bucket — that a "fix one
 * character" loop produces. Keys are therefore derived from a materialized git
 * tree, the same content-addressed construction the gate binds verdicts to.
 *
 * FAIL-SAFE. Every failure (unreadable cache, corrupt JSON, unavailable tree,
 * submodules present) results in NO cache hit, i.e. the step runs. There is no
 * path in which a problem here can skip a check.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDocFile } from "./precommit-plan.mjs";

const CACHE_RELPATH = ".pi/precommit-cache.json";
const CACHE_SCHEMA = 1;

function gitOrNull(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function gitRawOrNull(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

/** Repository root for `cwd`, or null when it is not a git worktree. */
export function repoRootOf(cwd) {
  return gitOrNull(cwd, ["rev-parse", "--show-toplevel"]);
}

/**
 * Compute the two input digests every step key is built from.
 *
 * `all`       — the whole worktree tree (the gate-owned `.pi` dirs excluded by
 *               the shared fingerprint implementation).
 * `code-only` — the same tree minus documentation blobs, so a README edit
 *               leaves it untouched.
 *
 * Returns `null` when no trustworthy digest can be produced, which disables
 * the cache for that run:
 *   - the repo has submodules (the bare tree records only their gitlink, so an
 *     edit INSIDE a submodule would not move either digest — a fail-open);
 *   - git is unreadable, or `ls-tree` cannot be parsed.
 *
 * @param {string} cwd            run directory
 * @param {() => string} treeOid  materialize the worktree tree (shared impl)
 */
export function computeInputDigests(cwd, treeOid) {
  // Submodules: the parent tree pins only the committed gitlink, so content
  // edits inside a submodule are invisible here. Disable the cache instead of
  // trusting a digest that cannot see them.
  if (existsSync(join(repoRootOf(cwd) ?? cwd, ".gitmodules"))) return null;

  let tree;
  try {
    tree = treeOid();
  } catch {
    return null;
  }
  if (typeof tree !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(tree)) return null;

  // `--full-tree` is load-bearing: without it `ls-tree` is implicitly scoped to
  // the cwd's path prefix, so a run started in a SUBDIRECTORY would hash only
  // that subtree — and a change anywhere else in the repo would leave the key
  // untouched, reusing a PASS for code the step never saw.
  const listing = gitRawOrNull(cwd, ["ls-tree", "-r", "-z", "--full-tree", tree]);
  if (listing === null) return null;

  const codeParts = [];
  for (const entry of listing.split("\0")) {
    if (!entry) continue;
    // "<mode> <type> <oid>\t<path>"
    const tab = entry.indexOf("\t");
    if (tab === -1) return null; // unexpected shape → no cache, never a guess
    const meta = entry.slice(0, tab);
    const path = entry.slice(tab + 1);
    const oid = meta.split(/\s+/)[2];
    if (!oid) return null;
    if (isDocFile(path)) continue;
    codeParts.push(`${oid} ${path}`);
  }

  return { all: tree, "code-only": sha256(codeParts.join("\n")) };
}

function cachePath(repoRoot) {
  return join(repoRoot, CACHE_RELPATH);
}

/** Load the cache, or an empty one for any unreadable/corrupt/foreign file. */
export function loadCache(repoRoot) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(repoRoot), "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.schema !== CACHE_SCHEMA) return { schema: CACHE_SCHEMA, entries: {} };
    if (!parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) {
      return { schema: CACHE_SCHEMA, entries: {} };
    }
    return { schema: CACHE_SCHEMA, entries: parsed.entries };
  } catch {
    return { schema: CACHE_SCHEMA, entries: {} };
  }
}

/**
 * A previously recorded PASS for this exact step, or null.
 *
 * Every field must match: a changed command (different flags, a narrowed test
 * run vs the full suite) is a DIFFERENT check and must not inherit the other's
 * result.
 */
export function lookup(cache, { name, command, scope, digests, isFix }) {
  if (!digests) return null;
  const key = digests[scope];
  if (!key) return null;
  const e = cache.entries?.[name];
  if (!e || typeof e !== "object") return null;
  if (e.status !== "pass") return null;              // only a PASS is reusable
  if (e.command !== command) return null;
  if (e.scope !== scope) return null;
  if (e.key !== key) return null;
  if (typeof e.durationMs !== "number") return null;
  // A FIX step (lint:fix) is reusable only when its previous run left the tree
  // untouched. Its value is a SIDE EFFECT, not a verdict: skipping a fix that
  // edited files last time would leave those edits unapplied while the later
  // steps happily reused results earned on the fixed tree. `postKey` is
  // recorded by recordFixOutcome(); absent (an entry written before this rule,
  // or a run that could not re-key) means "unknown" and therefore no reuse.
  if (isFix && (typeof e.postKey !== "string" || e.postKey !== e.preKey)) return null;
  return e;
}

/**
 * Note what a fix step left behind, so a later run can tell a no-op fix (safe
 * to reuse) from one that edited the worktree (must run again).
 *
 * `before`/`after` are the digest sets from before and after the fix ran.
 * Anything unknown — caching disabled, re-keying failed, the fix did not pass
 * — leaves no `postKey`, which lookup() reads as "not reusable".
 */
export function recordFixOutcome(cache, name, before, after) {
  const e = cache.entries?.[name];
  if (!e || e.status !== "pass") return cache;
  if (!before || !after) return cache;
  // Compared on the whole-tree digest rather than the step's own scope: "did
  // this fix change anything at all" is a question about the worktree, not
  // about the subset of it the step is keyed on.
  e.preKey = before.all;
  e.postKey = after.all;
  return cache;
}

/** Record a PASS. Non-pass results are dropped so a fix always re-runs. */
export function record(cache, { name, command, scope, digests, status, durationMs, tail }) {
  if (!digests) return cache;
  const key = digests[scope];
  if (!key) return cache;
  if (status !== "pass") {
    delete cache.entries[name];
    return cache;
  }
  cache.entries[name] = {
    command,
    scope,
    key,
    status: "pass",
    durationMs,
    at: new Date().toISOString(),
    tail: typeof tail === "string" ? tail.split("\n").slice(-10).join("\n") : "",
  };
  return cache;
}

/** Persist the cache (temp + atomic rename). Best effort: never throws. */
export function saveCache(repoRoot, cache) {
  try {
    const dest = cachePath(repoRoot);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ schema: CACHE_SCHEMA, entries: cache.entries }));
    renameSync(tmp, dest);
  } catch {
    /* diagnostics-grade artifact: a failed write only costs a re-run */
  }
}
