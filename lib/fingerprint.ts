/**
 * Worktree fingerprint — a stable hash of "what the code looks like right now".
 *
 * A gate pass is only valid for the exact worktree CONTENT it reviewed. Any
 * subsequent content change (tracked or untracked) invalidates the pass.
 *
 * CONTENT-ADDRESSED, STAGING-INVARIANT (P0 fix)
 * ---------------------------------------------
 * The digest is a real git tree hash of the whole worktree, built in a private
 * shadow index. It therefore depends ONLY on file contents and paths — never
 * on where those contents currently live (unstaged / staged / committed).
 *
 * The previous implementation hashed `git diff --cached` + `git diff HEAD` +
 * `git status --porcelain` + HEAD, which made the digest depend on STAGING
 * STATE and on HEAD. That broke the gate's core promise in the most common
 * workflow of all:
 *
 *   1. agent edits code → review runs → READY bound to fingerprint F1
 *   2. `git add -A`     → digest becomes F2 (same bytes!) → the L3 pre-commit
 *                         hook rejects: "code was modified after the last
 *                         READY review (fingerprint mismatch)"
 *   3. `git commit`     → HEAD moves, worktree goes clean → F3 → the L3
 *                         pre-push hook rejects the very commit it just passed
 *
 * So every `git add` and every `git commit` demanded a fresh, fully redundant
 * review round even though not one byte of code had changed — burning tokens
 * and training the user to reach for REVIEW_GATE_BYPASS=1, which disarms the
 * gate far more thoroughly than the false mismatch it works around.
 *
 * A git tree hash fixes this at the root: staging and committing are pure
 * bookkeeping moves that leave the tree bit-identical, so a binding survives
 * them, while any real edit (including creating an untracked file) changes the
 * tree and still correctly invalidates the pass.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Gate-owned paths excluded from the fingerprint (and from changedFiles).
 *
 * P0 self-deadlock fix: the gate itself WRITES files under .pi/ (the state
 * sidecar on every persist, the lessons log, the arbitration audit log) and
 * subagent runs write artifacts under .pi-subagents/. If those writes
 * participate in the fingerprint, recording a READY review immediately
 * invalidates its own binding in any repo that does not gitignore .pi
 * (record_review → persist() rewrites the sidecar → next fingerprint
 * differs → "code was modified after the last READY review" forever).
 * Reviews judge PROJECT code, never Pi's own state/artifact dirs.
 *
 * The `:/` prefix anchors each path at the REPO ROOT, so the exclusion covers
 * the real gate dirs no matter which subdirectory the session cwd is in (a
 * cwd-relative spelling would miss `<root>/.pi` from inside `<root>/sub`, and
 * would wrongly exclude an unrelated `<root>/sub/.pi`). Keep in sync with
 * scripts/compute-fingerprint.cjs — a parity test enforces it.
 */
export const GATE_EXCLUDE_PATHSPECS: readonly string[] = Object.freeze([
  ":/.pi",
  ":/.pi-subagents",
]);

/**
 * Whole-repo pathspec. The session cwd may be a subdirectory, and a plain
 * `git add -A` there stages only that subtree; changes elsewhere in the repo
 * would then be invisible to the digest — a fail-open the gate must not have.
 */
export const REPO_ROOT_PATHSPEC = ":/";

/**
 * Status pathspecs for changedFiles(). `:(top,exclude)` = "exclude this path
 * measured from the repo root", the exclusion counterpart of `:/`.
 * (`git status` reports repo-root-relative paths already, so no `:/` include
 * spec is needed to widen its scope.)
 */
const STATUS_EXCLUDE_PATHSPECS: readonly string[] = Object.freeze([
  ":(top,exclude).pi",
  ":(top,exclude).pi-subagents",
]);

/**
 * Algorithm version of the digest produced here.
 *
 * A verdict binding is only meaningful under the algorithm that produced it,
 * and a Pi extension is a RESIDENT process: it loads this module at session
 * start and does not hot-reload. So right after an upgrade the extension still
 * writes v1 digests while the freshly installed git hook computes v2 ones, and
 * the hook rejected the commit it had just approved with "code was modified
 * after the last READY review" — a dead end no amount of re-reviewing inside
 * that session could clear (reproduced during this very change: extension
 * `7505ba86…` vs hook `2d758793…`, byte-identical worktree).
 *
 * Bindings therefore record this version, mismatches are INVALIDATED rather
 * than silently trusted or reinterpreted (a v1 digest says nothing about v2
 * coverage), and both the extension and the hook explain what to do instead of
 * blaming the code.
 *
 * BUMP THIS whenever a change can alter the digest for unchanged content:
 * the tree construction, the excluded pathspecs, the submodule mixing, or the
 * sanitized environment.
 *
 *   1 — pre-versioning implementations (recorded as "absent").
 *   2 — content-addressed tree hash: staging-invariant, repo-root-relative
 *       submodule paths, sanitized git environment.
 */
export const FINGERPRINT_VERSION = 2;

export interface Fingerprint {
  digest: string;
  /**
   * Current HEAD, for diagnostics/telemetry only. Deliberately NOT part of the
   * digest: committing already-reviewed content must not invalidate its
   * binding (see the file header).
   */
  head: string;
  unavailable: boolean;
}

const UNAVAILABLE: Fingerprint = Object.freeze({
  digest: "__UNAVAILABLE__",
  head: "__UNAVAILABLE__",
  unavailable: true,
});

/**
 * Git environment variables that RELOCATE the repository, the worktree, the
 * index or the object store. They must never be inherited.
 *
 * Reproduced fail-open: with `GIT_DIR`/`GIT_WORK_TREE` pointing at another
 * repository, `computeFingerprint(A)` returned a digest describing repo B — so
 * a real edit in A left "its" fingerprint unchanged and a stale READY binding
 * stayed valid. The gate must describe the repository it was asked about, not
 * whatever an ambient variable points at. Discovery falls back to the cwd,
 * which is what every caller means (and what git hooks already run in).
 *
 * `GIT_INDEX_FILE` is included because the shadow-index passes below set it
 * explicitly; inheriting an outer value would let a caller substitute the
 * index the digest is built from.
 */
export const GIT_LOCATION_ENV: readonly string[] = Object.freeze([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
]);

/**
 * Any variable matching this prefix injects CONFIG into the git invocation:
 * `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`,
 * `GIT_CONFIG_PARAMETERS`, and the `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` /
 * `GIT_CONFIG_NOSYSTEM` source overrides.
 *
 * This is a second, independent way to reach the same fail-open as GIT_DIR:
 * `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.excludesFile
 * GIT_CONFIG_VALUE_0=/tmp/patterns` makes the named files invisible to
 * `git add`, so a real untracked edit never enters the digest and a stale
 * READY binding stays valid — with no GIT_DIR involved. Matched by PREFIX
 * because the numbered forms are unbounded.
 */
const GIT_CONFIG_ENV_PREFIX = /^GIT_CONFIG(_|$)/;

/**
 * process.env minus every variable that can relocate the repository or inject
 * configuration. The user's real `~/.gitconfig` still applies (that is the
 * user's own, deliberate configuration); what is removed is the ability of an
 * AMBIENT variable to substitute or add to it for this process only.
 */
export function gitBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_LOCATION_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (GIT_CONFIG_ENV_PREFIX.test(key)) delete env[key];
  }
  return env;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: env ?? gitBaseEnv(),
  }).trim();
}

/**
 * `env` is NOT optional decoration: the shadow-index passes must reach git
 * through GIT_INDEX_FILE. An earlier version of this helper silently dropped
 * the argument, so `update-index --no-skip-worktree` ran against the USER'S
 * REAL INDEX and wiped their skip-worktree / assume-unchanged bits (verified:
 * `S a.ts` / `h b.ts` became `H a.ts` / `H b.ts` after one fingerprint).
 */
function gitOrNull(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string | null {
  try {
    return git(cwd, args, env);
  } catch {
    return null;
  }
}

/**
 * Like gitOrNull(), but WITHOUT the trailing/leading trim.
 *
 * Required for `--porcelain -z` output: a porcelain entry is `XY <path>`, and
 * for an unstaged modification X is a SPACE (" M f.ts"). Trimming ate that
 * leading space on the FIRST entry only, so `entries[0].slice(3)` returned
 * ".ts" instead of "f.ts" — a silently corrupted path. It stayed invisible
 * because the existing consumers only test the extension (".ts" still looks
 * like a code file) and the existing test happened to use untracked files
 * ("?? x.ts", no leading space). It is a real defect for anything that must
 * open the path, such as the advisory token's stat probe.
 */
function gitRawOrNull(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: gitBaseEnv(),
    });
  } catch {
    return null;
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Thrown to force the whole fingerprint to fail CLOSED. */
class FingerprintUnavailable extends Error {}

/**
 * How far to backdate the shadow index mtime, measured from
 * `min(realIndexMtime, now)`. Any margin comfortably larger than filesystem
 * timestamp granularity works; git only asks "is this entry's mtime older than
 * the index mtime", so a larger value is simply more conservative (more
 * re-hashing, never less).
 */
const RACE_BACKDATE_MS = 5000;

/**
 * Submodule paths, read from the INDEX (gitlink entries, mode 160000).
 *
 * The index is the authoritative record of which paths are submodules and it
 * survives a malformed/absent `.gitmodules`. An earlier version asked
 * `git config --file .gitmodules`, which returns the SAME "no output" signal
 * for "no submodules" and for "this file is corrupt" — so a broken
 * `.gitmodules` silently disabled submodule coverage entirely (a reproducible
 * fail-open: edits inside the submodule stopped moving the digest).
 *
 * `--full-name` is REQUIRED, not cosmetic. Without it `git ls-files` reports
 * paths relative to the CURRENT DIRECTORY, so a session started in a
 * subdirectory sees `../../sm` where the repo root sees `sm`. That text is
 * mixed into the digest by submoduleDigest(), which made the fingerprint
 * depend on the cwd it was computed from: the extension (session cwd) and the
 * git hooks (always the repo toplevel) then produced DIFFERENT digests for
 * byte-identical content, and every commit from a subdirectory of a repo with
 * submodules was rejected as "code was modified after the last READY review"
 * — permanently, with no way to satisfy it. Reproduced before the fix:
 * fp(root) 0d49cee2… vs fp(deep/work) 8a698993… on one unchanged repo.
 *
 * Throws (fail closed) if the index cannot be listed at all.
 */
function submodulePaths(cwd: string): string[] {
  const out = gitOrNull(cwd, ["ls-files", "--stage", "-z", "--full-name", "--", REPO_ROOT_PATHSPEC]);
  if (out === null) throw new FingerprintUnavailable("cannot list index entries");
  const paths: string[] = [];
  for (const entry of out.split("\0")) {
    if (!entry.startsWith("160000 ")) continue; // gitlink = submodule
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    paths.push(entry.slice(tab + 1));
  }
  return paths.sort();
}

/**
 * Content digest for every submodule, recursively.
 *
 * Returns "" when there are no submodules (the overwhelmingly common case), so
 * ordinary repos keep the bare tree hash and their fingerprints are unchanged.
 *
 * Each submodule is hashed with the SAME worktree-tree algorithm as the parent
 * (`worktreeTree`), so its actual FILE CONTENT is bound — including content
 * that is merely modified-but-uncommitted. A previous version hashed
 * `git status --porcelain` output instead; because that text names paths and
 * states but not contents, a second edit to an already-dirty file left the
 * status line (`M s.ts`) identical and the digest unchanged, so unreviewed
 * submodule content could still be committed.
 *
 * Every failure path throws, so a submodule whose content cannot be read makes
 * the WHOLE fingerprint unavailable rather than collapsing to a stable,
 * bindable value.
 */
function submoduleDigest(cwd: string, depth: number, opts?: WorktreeDigestOptions): string {
  // Bound recursion: pathological/cyclic setups must not hang the gate.
  if (depth > 10) throw new FingerprintUnavailable("submodule nesting too deep");

  const paths = submodulePaths(cwd);
  if (paths.length === 0) return "";

  // Repo root. Two jobs:
  //  1. Tell a real submodule checkout apart from an uninitialized one. A
  //     deinit'd submodule leaves an EMPTY directory that still answers
  //     `rev-parse --is-inside-work-tree` with "true" — the query falls through
  //     to the PARENT repo. Comparing toplevels is unambiguous and needs no
  //     output-format parsing.
  //  2. Resolve submodule paths. They are repo-root-relative (--full-name), so
  //     they MUST be joined against the toplevel, never against a session cwd
  //     that may be a subdirectory.
  const parentTop = gitOrNull(cwd, ["rev-parse", "--show-toplevel"]);
  if (parentTop === null) throw new FingerprintUnavailable("cannot resolve repo toplevel");

  const parts: string[] = [];
  for (const path of paths) {
    const subCwd = join(parentTop, path);
    // UNINITIALIZED (never `git submodule update --init`, or deinit'd): there
    // is no checkout, so there is no working content to review and the
    // parent's gitlink — already part of the parent tree — fully pins it.
    // This is a legitimate, common state (CI, shallow checkouts) and must NOT
    // fail closed, or it would make normal commits impossible.
    const subTop = gitOrNull(subCwd, ["rev-parse", "--show-toplevel"]);
    if (subTop === null || subTop === parentTop) {
      parts.push(`${path}:UNINITIALIZED`);
      continue;
    }
    // Recurse with the identical algorithm: real content, nested submodules,
    // and the same fail-closed guarantees.
    parts.push(`${path}:${worktreeDigest(subCwd, depth + 1, opts)}`);
  }
  return parts.join("\n");
}

/**
 * Content tree of one repository's worktree: a git tree hash covering every
 * tracked and untracked file, plus a recursive content digest of any
 * submodules. Used for the parent repo AND (recursively) for each submodule,
 * so both get identical guarantees.
 *
 * Throws FingerprintUnavailable / any git error so callers fail CLOSED.
 */
/** Chunk size for update-index argv (a huge repo would blow the argv limit). */
const UPDATE_INDEX_CHUNK = 500;

/**
 * Materialize the worktree as a git tree and return its OID.
 *
 * Returns the BARE tree (no submodule mixing) so callers that must inspect
 * entries with `ls-tree` can use it directly; worktreeDigest() adds the
 * submodule binding on top.
 */
function worktreeTreeOid(cwd: string): string {
  let shadowDir: string | undefined;
  try {
    // --path-format=absolute is REQUIRED: bare `--git-path index` is relative
    // to the repo root, so from a subdirectory — or in a linked worktree,
    // where it resolves into .git/worktrees/<name>/ — joining it to cwd would
    // yield a bogus path and fail every fingerprint closed.
    const indexPath = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);

    shadowDir = mkdtempSync(join(tmpdir(), "rg-fp-shadow-"));
    const shadowIndex = join(shadowDir, "index");
    // Seed the shadow index from the real one. This is required for BOTH
    // speed and correctness:
    //   speed — `git add` reuses the stat cache (~78ms vs ~385ms on a
    //     9k-file repo);
    //   correctness — `git add` refuses to stage a path matching .gitignore,
    //     so an EMPTY index silently drops files that are gitignored yet
    //     TRACKED (added with `git add -f`). Those files are shippable
    //     (`git commit -a` commits them), so dropping them is a fail-open.
    //
    // P0 RACE FIX — the mtime BACKDATE below is load-bearing, not cosmetic.
    // Git's "racily clean" rule re-hashes a cached entry only when its stat
    // mtime is NOT older than the index file's own mtime; otherwise it trusts
    // the stat cache. copyFileSync stamps the copy with a NEW (later) mtime,
    // which makes genuinely-racy entries look safely clean, so `git add` skips
    // re-hashing them. An edit landing in the same mtime granularity bucket as
    // the index, with the file size unchanged (`// v1` → `// v2`), then became
    // INVISIBLE to the digest: measured 25/1500 fail-opens — a real code change
    // silently keeping a stale READY binding valid, the worst failure mode this
    // gate can have.
    //
    // We deliberately set the shadow index mtime into the PAST rather than
    // merely restoring the original: the older the index looks, the MORE
    // entries git treats as racy, so it re-hashes more and can never re-hash
    // less. This makes the invariant true by construction, with no
    // verification step to mis-tune. (An earlier version verified the restore
    // instead: raw-millisecond comparison misfired ~57% of the time because
    // utimesSync loses sub-ms precision, and the whole-second replacement
    // produced spurious UNAVAILABLE under parallel load.)
    //
    // The base is min(indexMtime, now), NOT the index mtime alone. Backdating
    // 5s from a FUTURE index mtime — which clock skew or a rolled-back system
    // clock can produce — still lands in the future, leaving entries looking
    // safely clean and re-arming the fail-open (independently reproduced: a
    // same-size edit stayed invisible with the index mtime an hour ahead).
    // Clamping to `now` removes that case at O(1) cost. A file whose own mtime
    // is in the future is already treated as racy by git, so it needs no
    // special handling.
    //
    // Only a MISSING index (fresh repo, never staged) may be swallowed; an
    // empty index is correct there and has no stale stat cache to trust. Any
    // other I/O failure propagates and fails CLOSED.
    try {
      const st = statSync(indexPath);
      copyFileSync(indexPath, shadowIndex);
      const base = Math.min(st.mtimeMs, Date.now());
      utimesSync(shadowIndex, st.atime, new Date(base - RACE_BACKDATE_MS));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") throw err; // real I/O problem → fail closed
      // ENOENT: no index file yet — start from an empty index.
    }

    // GIT_INDEX_FILE redirects every index write to the shadow copy, so the
    // user's real staging area is never touched.
    // gitBaseEnv() first: an inherited GIT_DIR/GIT_WORK_TREE would otherwise
    // build this tree from a DIFFERENT repository than the caller asked about.
    const env: NodeJS.ProcessEnv = { ...gitBaseEnv(), GIT_INDEX_FILE: shadowIndex };

    // Stage the whole worktree, THEN drop the gate-owned paths. Removing them
    // afterwards — rather than passing `:(exclude)` pathspecs to `git add` —
    // is deliberate: when .pi is gitignored, `git add` with an exclude
    // pathspec exits 1 with an "ignored by .gitignore" advisory even though
    // staging fully succeeded. That non-zero exit is indistinguishable from a
    // REAL failure, so honoring it would fail every commit closed, while
    // ignoring it would fail open on genuine errors. This form keeps every
    // exit code meaningful, so the catch below is a true fail-closed path.
    // TWO passes, in this order — each covers what the other cannot:
    //
    //  1. `--renormalize` re-reads every TRACKED file's CONTENT instead of
    //     trusting the copied stat cache. Backdating alone only makes entries
    //     whose mtime is NEAR the index look racy; a file carrying an ancient
    //     preserved mtime (restored from backup, `rsync -a`, an unpacked
    //     archive) still looks confidently clean, so a same-size edit to it
    //     stayed invisible — a fail-open that predates this change.
    //     This pass does NOT add untracked files.
    //  2. plain `-A` then picks up untracked/new/deleted paths.
    //
    // Running only pass 1 silently dropped every untracked file from the tree
    // (a worse fail-open than the one it fixed), so both are required.
    // Clear assume-unchanged / skip-worktree in the SCRATCH index only (never
    // the user's), so `git add` genuinely re-reads every file.
    //
    // Measured, so this is not guesswork: `--renormalize` already re-reads
    // content through an `assume-unchanged` bit, so that is not what this
    // buys. What it does buy is `skip-worktree`: without clearing, `git add`
    // ABORTS with "outside of your sparse-checkout definition" and the whole
    // fingerprint fails closed — i.e. a sparse-checkout repository could not
    // pass the gate at all (reproduced: fingerprint threw while the divergence
    // checker, which already cleared the bits, produced a correct tree).
    //
    // Note this cannot LOOSEN the digest: clearing the bits only makes git
    // read more of the worktree. On repositories without those bits the tree
    // is byte-identical (verified across plain/untracked/assume-unchanged
    // scenarios), which is why FINGERPRINT_VERSION does not need to change:
    // the only repositories whose result differs are those that previously
    // produced no usable digest at all, so no existing binding can be
    // reinterpreted.
    const tracked = git(cwd, ["ls-files", "-z", "--full-name", "--", REPO_ROOT_PATHSPEC], env)
      .split("\0")
      .filter(Boolean);
    for (let i = 0; i < tracked.length; i += UPDATE_INDEX_CHUNK) {
      const chunk = tracked.slice(i, i + UPDATE_INDEX_CHUNK);
      // Best-effort: a path that cannot be unmarked still gets re-read by the
      // `--renormalize` pass below, and a hard failure here would fail closed
      // on repositories that merely use an unusual bit combination.
      gitOrNull(cwd, ["update-index", "--no-assume-unchanged", "--", ...chunk], env);
      gitOrNull(cwd, ["update-index", "--no-skip-worktree", "--", ...chunk], env);
    }

    git(cwd, ["add", "-A", "--renormalize", "--", REPO_ROOT_PATHSPEC], env);
    git(cwd, ["add", "-A", "--", REPO_ROOT_PATHSPEC], env);
    git(cwd, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...GATE_EXCLUDE_PATHSPECS], env);

    const tree = git(cwd, ["write-tree"], env);
    // Guard against a future git printing warnings on stdout: only a bare
    // object id is a usable tree id (sha1 = 40 hex, sha256 = 64).
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

/** Options for worktreeDigest(); mirrors the CJS implementation's `opts`. */
export interface WorktreeDigestOptions {
  /**
   * Resolve the bare tree OID for a repository path, letting a caller that has
   * ALREADY materialized it hand the result over instead of running the whole
   * shadow-index pass again.
   *
   * It is a per-cwd RESOLVER, not one OID, because this function RECURSES into
   * submodules: a single top-level tree would leave every submodule
   * materializing itself again — which is exactly where a repository `clean`
   * filter could still make two passes over an unchanged worktree disagree.
   * (The CJS mirror shipped that bug; an independent review caught it.)
   */
  treeOidForCwd?: (cwd: string) => string;
}

/**
 * Full digest for `cwd`: the worktree tree, with every submodule's real
 * content mixed in.
 *
 * Split from worktreeTreeOid() so the tree can be materialized once per
 * repository and reused. The git hook does exactly that through the CJS
 * mirror: the divergence checker needs the tree OID to compare entries and the
 * fingerprint needs a digest over the same content, so materializing it twice
 * doubled the cost and ran any `clean` filter twice.
 *
 * The TS side keeps the identical signature on purpose. These two
 * implementations are asserted to stay mirrors of each other, and a divergence
 * in the sharing API is invisible in the resulting digest — it only shows up
 * as a silently reintroduced double materialization.
 */
function worktreeDigest(cwd: string, depth: number, opts?: WorktreeDigestOptions): string {
  const resolveTree = opts?.treeOidForCwd ?? worktreeTreeOid;
  const tree = resolveTree(cwd);
  // SUBMODULES: a tree records only each submodule's gitlink (its committed
  // OID), so edits INSIDE a checked-out submodule leave the tree
  // bit-identical — a real code change that would keep a stale READY
  // binding valid. The pre-change diff/status fingerprint DID catch this, so
  // the bare tree hash alone is a regression. Bind the submodules' actual
  // content by recursing with this same function.
  const submodules = submoduleDigest(cwd, depth, opts);
  return submodules === "" ? tree : sha256(`${tree}\0${submodules}`);
}

export function computeFingerprint(cwd: string): Fingerprint {
  try {
    const digest = worktreeDigest(cwd, 0);
    const head = gitOrNull(cwd, ["rev-parse", "HEAD"]) ?? "NO_HEAD";
    return { digest, head, unavailable: false };
  } catch {
    // Every failure path — git error, unreadable index, unrestorable mtime,
    // unreadable submodule — lands here and fails CLOSED.
    return UNAVAILABLE;
  }
}

/**
 * ADVISORY-ONLY change token — a ~10ms stand-in for "has the worktree moved
 * since the last fingerprint?", used SOLELY to skip a redundant recompute
 * when rendering the per-turn system prompt.
 *
 * ####################################################################
 * # NEVER use this to decide whether a gate is SATISFIED. It is not a #
 * # fingerprint and it is not staging-invariant. Enforcement paths    #
 * # (ship blocks, declare_done, record_review, arbitration, the git   #
 * # hooks) MUST call computeFingerprint() directly, every time.       #
 * ####################################################################
 *
 * Why a token instead of caching computeFingerprint() behind edit events:
 * an event-driven cache keyed on "the extension saw no edit tool call" is
 * unsound — `sed -i` in bash, an external editor, format-on-save, or a
 * background process all change the worktree without any event, and this
 * gate's threat model explicitly includes an agent editing files through
 * arbitrary bash. This token instead observes the FILESYSTEM:
 *
 *   sha256( porcelain status of the whole repo  ||  size+mtime of every
 *           path that status reports as changed )
 *
 * so it moves for every change the gate can normally see, including repeated
 * edits to a file that was ALREADY dirty (whose status line does not change —
 * the case that would make a status-only token useless in practice).
 *
 * Residual blind spot, deliberately accepted: an edit that keeps the file's
 * size AND lands in the same filesystem mtime bucket can leave the token
 * unchanged (exactly the racily-clean window that computeFingerprint spends
 * its ~466ms/9k-files defeating). The consequence is bounded to a STALE
 * PROMPT — the agent may be told "all gates satisfied" one turn too long —
 * because every path that can actually ship, end the task, or record a
 * verdict recomputes the real fingerprint. It can never turn a stale READY
 * into a commit.
 *
 * Returns null when the token cannot be computed (git unreadable): callers
 * must then fall back to computing the real fingerprint, never to reusing a
 * previous one.
 */
export function advisoryChangeToken(cwd: string): string | null {
  // --no-optional-locks: never let this convenience probe write the user's
  // index (a status refresh normally may). Keeps it read-only and cheap.
  const porcelain = gitRawOrNull(cwd, [
    "--no-optional-locks", "status", "--porcelain", "-uall", "-z", "--", ...STATUS_EXCLUDE_PATHSPECS,
  ]);
  if (porcelain === null) return null;

  const files = parsePorcelain(porcelain);

  // Stat every changed path so a SECOND edit to an already-dirty file (whose
  // status line is unchanged) still moves the token. A vanished/unreadable
  // path contributes a marker rather than being skipped, so deletes count too.
  const parts: string[] = [porcelain];
  for (const f of files.slice().sort()) {
    let stamp = "missing";
    try {
      const st = statSync(join(cwd, f));
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch { /* keep "missing" */ }
    parts.push(`${f}\u0000${stamp}`);
  }
  return sha256(parts.join("\u0001"));
}

/**
 * Parse NUL-delimited porcelain into changed paths. Shared by changedFiles()
 * and advisoryChangeToken() so the token needs only ONE `git status` call.
 */
function parsePorcelain(porcelain: string): string[] {
  if (!porcelain) return [];
  const entries = porcelain.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    const path = entries[i].slice(3);
    if (!path) continue;
    // P0-6: rename in -z format: "R  orig\0dest". Include BOTH paths
    // so a code→doc rename arms both gates, not just the destination.
    if (status.startsWith("R") && i + 1 < entries.length && entries[i + 1].length > 0 && !entries[i + 1].startsWith("?")) {
      files.push(path);            // old path
      files.push(entries[++i]);    // new path (destination)
    } else {
      files.push(path);
    }
  }
  return files;
}

/** List changed file paths (repo-root-relative) from NUL-delimited porcelain. */
export function changedFiles(cwd: string): string[] | undefined {
  try {
    const porcelain = gitRawOrNull(cwd, ["status", "--porcelain", "-uall", "-z", "--", ...STATUS_EXCLUDE_PATHSPECS]);
    if (porcelain === null) return undefined;
    return parsePorcelain(porcelain);
  } catch {
    return undefined;
  }
}
