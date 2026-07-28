#!/usr/bin/env node
/**
 * Staged-vs-reviewed divergence check (CJS, no Pi dependency).
 *
 * WHY THIS EXISTS
 * ---------------
 * The worktree fingerprint (scripts/compute-fingerprint.cjs) is deliberately
 * staging-invariant: `git add` must never invalidate a READY review, because
 * staging changes no content. That leaves exactly one gap the digest cannot
 * close on its own — `git commit` (without `-a`) ships the **index**, not the
 * worktree. So if a path is staged with content A while the worktree holds the
 * reviewed content B, the commit ships A even though the gate reviewed and
 * bound B, and the fingerprint never moves.
 *
 * Folding the index tree into the digest is NOT a fix: it reintroduces the
 * staging-sensitivity this whole change exists to remove (measured: `git add`
 * once again changed the digest, and untracked detection broke). Instead the
 * divergence is enforced here, as a separate commit-time condition.
 *
 * HOW (content, not status flags)
 * -------------------------------
 * We build two trees and compare them per path:
 *
 *   indexTree    — the real index, exactly what `git commit` would write
 *   worktreeTree — the worktree, i.e. what the review actually bound
 *                  (same algorithm as the fingerprint)
 *
 * A path is DIVERGENT when the commit would change it (index != HEAD) *and*
 * the index blob differs from the worktree blob.
 *
 * Comparing CONTENT rather than `git status` output is what makes this sound.
 * `assume-unchanged` / `skip-worktree` suppress status reporting, so an
 * earlier status-based version silently passed a staged blob that differed
 * from the reviewed worktree — a full fail-open. Reading trees is immune to
 * that, and to a broken `status.*` config that made the old version exit 0.
 *
 * BLOCKED (unreviewed content would ship):
 *   staged content A, worktree content B     (includes partial `git add -p`)
 *   staged delete, worktree recreated it
 *   staged rename, source path recreated
 *   divergence hidden by assume-unchanged / skip-worktree
 *
 * ALLOWED (all safe; blocking them would obstruct ordinary work):
 *   edited but unstaged      — index == HEAD, so the commit changes nothing
 *   edited and fully staged  — index == worktree
 *   staged delete, file gone — commit matches the worktree
 *   untracked files          — not committed
 *
 * Partial staging (`git add -p`) IS blocked: it is precisely the "index differs
 * from the reviewed worktree" state. Under a model where READY binds one
 * worktree tree, allowing it would reopen the hole.
 *
 * Paths are read NUL-delimited, so names with spaces, newlines and non-ASCII
 * characters are handled as raw bytes rather than relying on git's quoting.
 *
 * Exit: 0 = no divergence (or not a git repository at all — nothing to check
 * and nothing can be committed); 1 = divergence found, OR any internal
 * failure. An installed-but-broken safety check must never report success: an
 * earlier version exited 0 on ANY git error, which a bad
 * `status.showUntrackedFiles` config turned into a reproducible fail-open.
 * A MISSING script is handled by the hook FAILING CLOSED (this check guards a
 * safety invariant, so a partial install must block rather than silently
 * downgrade), not by this script swallowing errors.
 */

const { execFileSync } = require("node:child_process");
const { copyFileSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { tmpdir } = require("node:os");

// Mirror of lib/fingerprint.ts GIT_LOCATION_ENV — variables that relocate the
// repository, worktree, index or object store. Inheriting them let an ambient
// GIT_DIR/GIT_WORK_TREE redirect this check at ANOTHER repository, so a real
// staged/worktree divergence in the target repo went unreported (reproduced:
// exit 1 normally, exit 0 with the variables set). Discovery falls back to the
// cwd, which is what the hook already runs in.
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

/**
 * Does this path sit anywhere inside git metadata?
 *
 * Used ONLY to classify a failed `rev-parse`, where the question is "is this
 * genuinely outside any repository, or is it a repository we cannot inspect?".
 * Structural and language-independent, unlike matching git's stderr text.
 *
 * Detects both shapes: a `.git` directory or gitfile in the path or any
 * ancestor (ordinary worktrees, submodules, linked worktrees), and a
 * bare-repo-shaped directory (HEAD + objects + refs), which has no `.git`.
 */
function hasGitMetadata(startDir) {
  let dir;
  try { dir = resolve(startDir); } catch { return true; } // unusable input ⇒ fail closed
  for (;;) {
    // lstat, NOT existsSync: existsSync FOLLOWS symlinks, so a DANGLING `.git`
    // symlink (a broken worktree) read as "no metadata here" and the whole
    // repository was dismissed as an ordinary directory — a fail-open of the
    // same family as the missing-gitdir gitfile. lstat sees the link itself.
    // Any error other than "the entry is not there" (ENOENT/ENOTDIR) means we
    // cannot tell, which must fail closed.
    try {
      lstatSync(join(dir, ".git"));
      return true;
    } catch (err) {
      const code = err && err.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return true;
    }
    // Bare repositories have no `.git` at all. This must be checked at EVERY
    // level, not just the starting directory: a call from inside a bare repo
    // whose config git cannot parse would otherwise look like a plain
    // directory and skip.
    if (looksBare(dir)) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Canonical path with symlinks resolved, tolerating a path that does not exist
 * yet: the deepest existing ancestor is canonicalized and the remaining
 * (non-existent) segments are appended. Used for containment checks, where a
 * lexical path would let a planted symlink escape the directory it claims to
 * be in.
 */
function realpathNearest(p) {
  let head = p;
  const tail = [];
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(head) : join(realpathSync(head), ...tail);
    } catch (err) {
      const code = err && err.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err; // real I/O problem ⇒ fail closed
      const parent = dirname(head);
      if (parent === head) return p; // reached the root without resolving anything
      tail.unshift(head.slice(parent.length + 1));
      head = parent;
    }
  }
}

/** Bare-repo shape: HEAD plus the objects/ and refs/ directories. */
function looksBare(dir) {
  try {
    lstatSync(join(dir, "HEAD"));
    return statSync(join(dir, "objects")).isDirectory() && statSync(join(dir, "refs")).isDirectory();
  } catch (err) {
    const code = err && err.code;
    // Cannot tell (permissions, I/O) ⇒ treat as metadata ⇒ fail closed.
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

// The fingerprint implementation is the single source of truth for "what does
// this worktree contain". Requiring it (instead of re-implementing the shadow
// index here) keeps the divergence comparison and the fingerprint provably
// about the same bytes, and lets ONE process materialize the tree once for
// both. A partial install that lacks it must fail closed — this checker
// guards a safety invariant and cannot silently fall back to a private copy.
let sharedWorktreeTreeOid;
let sharedCompute;
try {
  ({ worktreeTreeOid: sharedWorktreeTreeOid, compute: sharedCompute } = require("./compute-fingerprint.cjs"));
} catch (err) {
  console.error("[review-gate] staged-divergence check cannot load the fingerprint implementation " +
    `(scripts/compute-fingerprint.cjs): ${err && err.message ? err.message : err}`);
  console.error("[review-gate] Failing closed — reinstall the hooks to restore it.");
  process.exit(1);
}

const GATE_EXCLUDE_PATHSPECS = [":/.pi", ":/.pi-subagents"];
const REPO_ROOT_PATHSPEC = ":/";
const RACE_BACKDATE_MS = 5000;

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

function gitOrNull(cwd, args, env) {
  try {
    return git(cwd, args, env);
  } catch {
    return null;
  }
}

/**
 * Run git and report WHY it failed, so a caller can tell "this is not a
 * repository" apart from "git could not run". Collapsing both into null is
 * exactly how the entry check below used to fail OPEN: a repo with a corrupt
 * config (`core.bare = definitely-not-a-bool`) made `rev-parse` exit 128, the
 * error became null, and the checker reported "nothing to check" — exit 0 —
 * for a repository it could not inspect at all.
 */
function gitProbe(cwd, args) {
  try {
    return { ok: true, out: git(cwd, args), stderr: "" };
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr) : "";
    return { ok: false, out: "", stderr };
  }
}

function withScratchIndex(cwd, fn) {
  const dir = mkdtempSync(join(tmpdir(), "rg-div-"));
  try {
    return fn(join(dir, "index"));
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

/**
 * The index this commit would actually publish.
 *
 * Normally `$GIT_DIR/index`. But git runs pre-commit with GIT_INDEX_FILE
 * pointing at a TEMPORARY index whenever the commit does not publish the plain
 * one — measured: `git commit -a` → `<gitdir>/index.lock`, `git commit -- path`
 * → `<gitdir>/next-index-<pid>.lock`. Comparing the plain index in those cases
 * judges content the commit will not ship, which BLOCKS a safe `git commit -a`
 * (its temporary index already equals the reviewed worktree).
 *
 * The path is taken from an explicit ARGUMENT the hook passes
 * (`"${GIT_INDEX_FILE-}"`), never from the ambient environment, and it is
 * accepted only after it is verified to live inside this repository's git dir
 * or common dir. A standalone run without the argument keeps using the plain
 * index, so an ambient variable still cannot redirect anything.
 */
/**
 * Index to read for `cwd`.
 *
 * The forwarded commit index describes ONE repository — the one git is
 * committing in. Submodule recursion calls these helpers with the submodule's
 * own checkout as cwd, where that path is meaningless (it would compare the
 * parent's index against a submodule worktree and report every file as
 * divergent). Anything but the top-level repo therefore uses its own index.
 */
function indexPathFor(cwd) {
  if (COMMIT_INDEX.repo && resolve(cwd) === COMMIT_INDEX.repo) return COMMIT_INDEX.path;
  return git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
}

function commitIndexPath(cwd, explicitIndexFile) {
  const plain = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  if (!explicitIndexFile) return plain;

  // REAL paths, not lexical ones. resolve() only normalizes text, so a symlink
  // planted inside the git dir (`.git/forwarded-index -> /tmp/foreign/index`)
  // passed the containment test while copyFileSync then followed it out of the
  // repository. The index file itself may legitimately not exist yet (git's
  // temporary indexes are created as the commit proceeds), so canonicalize the
  // nearest EXISTING ancestor and test containment on that.
  const candidate = realpathNearest(resolve(cwd, explicitIndexFile));
  const owned = ["--git-dir", "--git-common-dir"]
    .map((flag) => gitOrNull(cwd, ["rev-parse", "--path-format=absolute", flag]))
    .filter((d) => typeof d === "string" && d.length > 0)
    .map((d) => realpathNearest(resolve(d)));
  const inside = owned.some((d) => candidate === d || candidate.startsWith(d + "/"));
  if (!inside) {
    // The hook handed us an index outside this repository's metadata. That is
    // never a legitimate git-provided value, so refuse rather than guess.
    throw new Error(`refusing an index file outside the repository: ${candidate}`);
  }
  return candidate;
}

/**
 * Copy the index that would be committed to `scratch`. A brand-new repo that
 * has never staged anything has NO index file; an empty scratch index is
 * correct there, so ENOENT is expected rather than fatal. Any other I/O error
 * propagates and fails closed. (Mirrors lib/fingerprint.ts.)
 */
function seedScratchIndex(cwd, scratch) {
  try {
    copyFileSync(indexPathFor(cwd), scratch);
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
}

/** Tree the real index would commit (gate-owned paths removed). */
function indexTree(cwd) {
  return withScratchIndex(cwd, (scratch) => {
    seedScratchIndex(cwd, scratch);
    const env = { ...gitBaseEnv(), GIT_INDEX_FILE: scratch };
    git(cwd, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...GATE_EXCLUDE_PATHSPECS], env);
    return git(cwd, ["write-tree"], env);
  });
}

/**
 * Tree of the worktree — what the review bound.
 *
 * Delegates to the FINGERPRINT's materialization (scripts/compute-fingerprint
 * .cjs) rather than keeping a second copy: the two must describe the same
 * bytes, and two near-identical implementations of a security-critical
 * shadow-index pass are exactly how they drift apart.
 *
 * Memoized per repository path, so one hook invocation materializes each
 * worktree ONCE. That is not only ~half the git work: a repository-configured
 * `clean` filter is an arbitrary program, and running it twice over the same
 * unchanged worktree could legitimately produce two different trees, which
 * would make the divergence comparison and the fingerprint disagree about what
 * the worktree even contains. Submodule recursion passes a different cwd and
 * therefore gets its own entry.
 */
const worktreeTreeCache = new Map();
function worktreeTree(cwd) {
  const key = resolve(cwd);
  if (!worktreeTreeCache.has(key)) {
    worktreeTreeCache.set(key, sharedWorktreeTreeOid(cwd));
  }
  return worktreeTreeCache.get(key);
}

/**
 * Map of path -> "<mode> <type> <oid>" for every entry in a tree.
 *
 * The full entry matters, not just the object id: a git tree entry's identity
 * is <mode, type, oid, path>. Comparing only the oid (e.g. via
 * `rev-parse <tree>:<path>`) misses a staged executable bit or a
 * symlink<->regular-file type change whose object content happens to match —
 * both are real, committable differences from the reviewed worktree.
 *
 * `-z` keeps paths NUL-delimited so newlines/spaces/non-ASCII are safe. In
 * that form each record is "<mode> <type> <oid>\t<path>".
 *
 * `--full-tree` is a CORRECTNESS requirement, not a convenience: `ls-tree`
 * otherwise implicitly limits its listing to the CURRENT DIRECTORY's prefix.
 * Called from a subdirectory (which this script accepts as an argument) the
 * listing came back EMPTY, so every comparison below found nothing and the
 * checker exited 0 — a silent fail-open on the one condition it exists to
 * catch. Reproduced: same repo, staged A / worktree B, exit 1 from the repo
 * root and exit 0 from `deep/work`. `--full-tree` makes the listing
 * repo-root-relative and cwd-independent.
 */
function treeEntries(cwd, tree) {
  const out = git(cwd, ["ls-tree", "-r", "-z", "--full-tree", tree]);
  const entries = new Map();
  for (const record of out.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    entries.set(record.slice(tab + 1), record.slice(0, tab).trim());
  }
  return entries;
}

/**
 * Does the commit `publishedCommit` differ from what is CHECKED OUT at `cwd`?
 *
 * Recursive, because a git tree stores only a gitlink per submodule: an outer
 * submodule can match its staged commit exactly while a NESTED submodule
 * underneath holds different, reviewed-but-unpublished content. Comparing only
 * the top tree passes that state (measured: parent `Mm outer`, outer
 * `m nested`, nested `M i.txt` — the checker exited 0).
 *
 * At each level: compare the checkout's real worktree tree against the
 * published tree, then recurse into every gitlink that published tree names.
 * `git status` is deliberately not used at any level — it would reintroduce
 * the `assume-unchanged` / `skip-worktree` blind spot; worktreeTree() clears
 * those bits in its scratch index and re-reads content.
 *
 * Anything unresolvable returns true (fail closed): if we cannot determine
 * what would be published, the commit must not proceed.
 */
function publishedDiffersFromCheckout(cwd, publishedCommit, depth) {
  if (depth > 10) return true; // bounded, mirroring the fingerprint's recursion

  const publishedTree = gitOrNull(cwd, ["rev-parse", `${publishedCommit}^{tree}`]);
  if (publishedTree === null) return true;
  if (worktreeTree(cwd) !== publishedTree) return true;

  // Trees match at this level; now verify each nested submodule's CONTENT
  // against the gitlink this published tree names.
  let entries;
  try {
    entries = treeEntries(cwd, publishedTree);
  } catch {
    return true;
  }
  const selfTop = gitOrNull(cwd, ["rev-parse", "--show-toplevel"]);
  for (const [subPath, entry] of entries) {
    if (!entry.startsWith("160000 ")) continue;
    // Tree paths are repo-root-relative, so they must be joined against the
    // toplevel. The hook always invokes us there, but resolving it explicitly
    // keeps the checker correct if it is ever called from a subdirectory
    // (the fingerprint had exactly that latent cwd dependency).
    const nestedCwd = join(selfTop ?? cwd, subPath);
    const nestedTop = gitOrNull(nestedCwd, ["rev-parse", "--show-toplevel"]);
    // Uninitialized nested submodule: no checkout, so no local content can
    // diverge from the gitlink that would be published.
    if (nestedTop === null || nestedTop === selfTop) continue;
    const nestedCommit = entry.split(/\s+/)[2];
    if (publishedDiffersFromCheckout(nestedCwd, nestedCommit, depth + 1)) return true;
  }
  return false;
}

function divergentPaths(cwd) {
  const idx = indexTree(cwd);
  const work = worktreeTree(cwd);

  const hasHead = gitOrNull(cwd, ["rev-parse", "--verify", "HEAD"]) !== null;
  const idxEntries = treeEntries(cwd, idx);
  const workEntries = treeEntries(cwd, work);
  const headEntries = hasHead
    ? treeEntries(cwd, git(cwd, ["rev-parse", "HEAD^{tree}"]))
    : new Map();

  const divergent = new Set();

  // NOTE: there is deliberately NO "identical trees ⇒ return early" fast path.
  // A parent tree stores only a submodule's gitlink, so the index and worktree
  // trees are byte-identical whenever they agree on that OID — exactly the
  // state the submodule check below exists to catch. An earlier version
  // short-circuited here and silently skipped it.
  if (idx !== work) {
    for (const [path, indexEntry] of idxEntries) {
      if (indexEntry === workEntries.get(path)) continue;
      // Only dangerous when the COMMIT would actually change this path. If the
      // index still matches HEAD the path is merely edited-but-unstaged, and
      // that worktree content is not committed.
      if (indexEntry !== headEntries.get(path)) divergent.add(path);
    }

    // A path the worktree still has (and HEAD had) that the index would DELETE:
    // committing drops content the review approved.
    for (const path of workEntries.keys()) {
      if (idxEntries.has(path)) continue;
      if (headEntries.has(path)) divergent.add(path);
    }
  }

  // SUBMODULES. A parent tree stores only a gitlink (the submodule's committed
  // OID), so the comparison above sees identical entries whenever the index and
  // the worktree agree on that OID — even if the submodule's actual CHECKOUT
  // holds different, reviewed content. Concretely: the submodule advances to
  // commit B, the reviewer then approves further uncommitted content C, and
  // `git add sm` stages gitlink B. The parent commit publishes B while the
  // READY fingerprint bound C, and neither the digest nor the entry comparison
  // moves.
  //
  // So for every submodule whose gitlink the COMMIT would change (index entry
  // != HEAD entry), require the submodule's own worktree to be clean: only then
  // does the staged commit actually contain the reviewed content. A dirty
  // submodule whose gitlink is NOT being changed is the safe analogue of an
  // ordinary unstaged edit — that content is not published by this commit — so
  // it must not block.
  for (const [path, indexEntry] of idxEntries) {
    if (!indexEntry.startsWith("160000 ")) continue;
    if (indexEntry === headEntries.get(path)) continue; // gitlink unchanged by this commit
    // Repo-root-relative tree path ⇒ join against the toplevel, not the cwd.
    const parentTop = gitOrNull(cwd, ["rev-parse", "--show-toplevel"]);
    const subCwd = join(parentTop ?? cwd, path);
    // An uninitialized submodule has no checkout, so there is no local content
    // that could diverge from the staged gitlink.
    const subTop = gitOrNull(subCwd, ["rev-parse", "--show-toplevel"]);
    if (subTop === null || subTop === parentTop) continue;

    // Compare what the parent would PUBLISH for this submodule against what is
    // actually checked out (= what the review bound), recursively.
    const stagedCommit = indexEntry.split(/\s+/)[2];
    if (publishedDiffersFromCheckout(subCwd, stagedCommit, 0)) divergent.add(path);
  }

  return [...divergent].sort();
}

// `--emit-fingerprint` makes this script ALSO print the worktree fingerprint
// (as compute-fingerprint.cjs would) on stdout, so the git hook needs a single
// process for both decisions and the worktree is materialized once. Without
// the flag the behaviour is unchanged, which keeps an older hook working
// against a newer checker.
const EMIT_FINGERPRINT = process.argv.includes("--emit-fingerprint");

/**
 * Exit, first printing the fingerprint when the hook asked for it.
 *
 * The digest REUSES the tree materialized for the divergence comparison
 * (worktreeTree caches per repo path), so one hook invocation runs the
 * shadow-index pass — and therefore any repository `clean` filter — exactly
 * once. Emitting an UNAVAILABLE result rather than nothing keeps the hook's
 * contract total: it always gets parseable JSON and fails closed on
 * `unavailable`.
 */
function finish(code) {
  if (EMIT_FINGERPRINT) {
    // May run BEFORE the toplevel is resolved (the non-repo / bare-repo
    // skips), so fall back to the requested path rather than touching `cwd`
    // in its temporal dead zone. compute() fails closed on its own for a
    // directory it cannot fingerprint.
    const target = repoTop || argCwd;
    let result;
    try {
      // Hand over the MEMOIZED resolver, not one tree: the fingerprint
      // recurses into submodules, and each of those must reuse whatever the
      // divergence comparison already materialized for that same repository.
      result = sharedCompute(target, repoTop ? { treeOidForCwd: worktreeTree } : undefined);
    } catch {
      result = sharedCompute(target); // materialize independently rather than guess
    }
    console.log(JSON.stringify(result));
  }
  process.exit(code);
}

/** Repository toplevel once resolved; "" until then (see finish()). */
let repoTop = "";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const argCwd = positional[0] || process.cwd();

// "Not a git repository" is not a check FAILURE — there is simply nothing to
// check, and no commit can ship from here either. Anything else that goes
// wrong is a real failure and must fail closed. (This is the one narrow
// exception; an earlier version swallowed ALL git errors, which a bad
// `status.showUntrackedFiles` config turned into a reproducible fail-open.)
const inside = gitProbe(argCwd, ["rev-parse", "--is-inside-work-tree"]);
if (!inside.ok) {
  // git could not answer. Decide the ONE narrow skip STRUCTURALLY, never from
  // the wording of an error message:
  //
  //   - Matching stderr against "not a git repository" is wrong in both
  //     directions. git emits that same phrase for a BROKEN worktree — a
  //     `.git` gitfile whose target gitdir is gone prints
  //     "fatal: not a git repository: /missing/path" — which would be treated
  //     as "nothing to check" (fail-open) even though a commit could still be
  //     attempted there. And under a localized git the phrase does not match
  //     at all, so an ordinary non-repo directory would be blocked instead.
  //
  // So: only a path that exists AND carries no git metadata anywhere up the
  // tree is a verified "outside any repository". Everything else — a missing
  // path, a `.git` we can see but git cannot use, a bare-repo-shaped directory
  // — is an inspection FAILURE and fails closed.
  if (existsSync(argCwd) && !hasGitMetadata(argCwd)) finish(0);
  console.error("[review-gate] staged-divergence check could not inspect the repository:");
  console.error(inside.stderr.trim() || "[review-gate] (git produced no diagnostics)");
  console.error("[review-gate] Failing closed — cannot verify that the staged content matches the reviewed worktree.");
  process.exit(1);
}
// A bare repo answers "false": no worktree exists, so there is no
// staged-vs-reviewed-worktree comparison to make and nothing can be committed
// from here. That is a genuine, verified skip.
if (inside.out !== "true") finish(0);

// Run EVERYTHING from the repository toplevel.
//
// Several git commands used below are implicitly cwd-scoped, and each one of
// them was a silent fail-open when this script was pointed at a subdirectory:
// `ls-tree` limits its listing to the cwd prefix (empty listing ⇒ "no
// divergence" ⇒ exit 0), `ls-files` returns cwd-relative paths, and the
// `update-index` calls built from them then failed outright. Normalizing once,
// here, removes the whole class instead of relying on every future call site
// remembering a --full-tree / --full-name flag (they are kept as well, as
// defence in depth). Failure to resolve the toplevel is fatal: it means git
// could not answer a question it just answered, so fail closed.
const cwd = gitOrNull(argCwd, ["rev-parse", "--show-toplevel"]);
if (cwd === null) {
  console.error("[review-gate] cannot resolve repository toplevel — failing closed.");
  process.exit(1);
}
repoTop = cwd;

// argv[3] is the index git told the HOOK this commit will publish (the hook
// forwards "${GIT_INDEX_FILE-}"). Empty/absent ⇒ the plain index. Resolved and
// ownership-checked once, here, so every later reader shares one verified
// value. An invalid path fails closed rather than silently falling back.
const COMMIT_INDEX = { repo: "", path: "" };
try {
  COMMIT_INDEX.path = commitIndexPath(cwd, positional[1] || "");
  COMMIT_INDEX.repo = resolve(cwd);
} catch (err) {
  console.error(`[review-gate] staged-divergence check failed: ${err && err.message ? err.message : err}`);
  console.error("[review-gate] Failing closed — cannot verify that the staged content matches the reviewed worktree.");
  process.exit(1);
}

let paths;
try {
  paths = divergentPaths(cwd);
} catch (err) {
  // Fail CLOSED. An installed safety check that cannot do its job must not
  // report success.
  console.error(`[review-gate] staged-divergence check failed: ${err && err.message ? err.message : err}`);
  console.error("[review-gate] Failing closed — cannot verify that the staged content matches the reviewed worktree.");
  process.exit(1);
}

if (paths.length > 0) {
  console.error("[review-gate] commit blocked: these paths are staged with content that differs from the reviewed worktree:");
  for (const p of paths) console.error(`  - ${p}`);
  console.error("[review-gate] The commit would ship the STAGED version, not the version the gate reviewed.");
  console.error("[review-gate] Fix by making the index match the reviewed worktree:");
  console.error("[review-gate]   git add -- <path>              # stage the reviewed content (keeps the review valid)");
  console.error("[review-gate]   git restore --staged -- <path> # unstage, keep the reviewed worktree");
  console.error("[review-gate]   git restore -- <path>          # DISCARDS the reviewed worktree copy;");
  console.error("[review-gate]                                  # the fingerprint then changes, so re-run review + precommit");
  process.exit(1);
}
finish(0);
