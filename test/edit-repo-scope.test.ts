import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyEditRepoScope } from "../lib/edit-repo-scope.ts";

// The judgement behind the seven-round bug "a READY is demoted by an edit no
// reviewer can see". Two directions are tested throughout, and they are not
// symmetric: calling an outside file `primary` costs one wasted review round,
// while calling an in-repo file `outside` would let a real edit keep a stale
// READY alive. Everything doubtful therefore has to land on `primary`.

const ROOT = "/work/repo";

function classify(absPath: string, editRepo: string | null, opts: {
  root?: string;
  resolveFile?: (p: string) => string;
  resolveDir?: (p: string) => string;
} = {}) {
  return classifyEditRepoScope({
    absPath,
    primaryRepoRoot: opts.root ?? ROOT,
    editRepo,
    // Default seam: identity, i.e. "the path is already physical". The real
    // realpath helpers get their own filesystem-backed test at the bottom.
    resolveFile: opts.resolveFile ?? ((p) => p),
    resolveDir: opts.resolveDir ?? ((p) => p),
  });
}

// ---------------------------------------------------------------------------
// git's own answer wins whenever it has one.

test("git attributing the edit to the session repo means primary", () => {
  assert.deepEqual(classify(`${ROOT}/lib/x.ts`, ROOT), { scope: "primary" });
});

test("git attributing the edit to ANOTHER repo means other-repo, carrying its root", () => {
  assert.deepEqual(
    classify("/work/other/lib/x.ts", "/work/other"),
    { scope: "other-repo", root: "/work/other" },
  );
});

test("a nested repository inside the session repo is still other-repo", () => {
  // The path IS under the session root, but git says it belongs to the nested
  // checkout — git wins, exactly as before this module existed.
  assert.deepEqual(
    classify(`${ROOT}/vendor/dep/x.ts`, `${ROOT}/vendor/dep`),
    { scope: "other-repo", root: `${ROOT}/vendor/dep` },
  );
});

// ---------------------------------------------------------------------------
// git has NO answer (the /tmp case, and the new-nested-directory case).

test("a path under no repository at all is outside", () => {
  assert.deepEqual(classify("/tmp/report.md", null), { scope: "outside" });
});

test("a sibling sharing the root's path PREFIX is outside, not a prefix match", () => {
  assert.deepEqual(classify("/work/repo-backup/x.ts", null), { scope: "outside" });
  assert.deepEqual(classify("/work/repo2/y.ts", null), { scope: "outside" });
  assert.deepEqual(classify("/work/repository/y.ts", null), { scope: "outside" });
});

test("a file in the repo git could not attribute is primary (new nested dir)", () => {
  // `git rev-parse` fails on a directory that does not exist yet, so editRepo
  // is null for a brand-new nested file — it is still a file in the repo.
  assert.deepEqual(classify(`${ROOT}/brand/new/deep/y.ts`, null), { scope: "primary" });
});

test("an unattributed path that resolves into ANOTHER repo arms that repo, not nothing", () => {
  // Round-2 reviewer P1: "no repository" and "another repository" are
  // different answers, and only the first may be skipped. A path git could
  // not attribute (a symlink out of /tmp, a new file in a directory that does
  // not exist) still belongs to whichever checkout it resolves into.
  assert.deepEqual(
    classifyEditRepoScope({
      absPath: "/tmp/into-b.ts",
      primaryRepoRoot: ROOT,
      editRepo: null,
      resolveFile: () => "/work/other/lib/x.ts",
      resolveDir: (p) => p,
      resolveRepoRoot: () => "/work/other",
    }),
    { scope: "other-repo", root: "/work/other" },
  );
});

test("a second opinion naming the SESSION repo is primary, not a second repo", () => {
  assert.deepEqual(
    classifyEditRepoScope({
      absPath: "/tmp/into-a.ts",
      primaryRepoRoot: ROOT,
      editRepo: null,
      // Resolves outside the root STRING but git says it is the session repo
      // (a symlinked worktree the resolvers could not normalize).
      resolveFile: () => "/elsewhere/lib/x.ts",
      resolveDir: (p) => p,
      resolveRepoRoot: () => ROOT,
    }),
    { scope: "primary" },
  );
});

test("a second opinion that throws falls back to primary, never outside", () => {
  assert.deepEqual(
    classifyEditRepoScope({
      absPath: "/tmp/x.ts",
      primaryRepoRoot: ROOT,
      editRepo: null,
      resolveFile: (p) => p,
      resolveDir: (p) => p,
      resolveRepoRoot: () => { throw new Error("git exploded"); },
    }),
    { scope: "primary" },
  );
});

test("a path that RESOLVES into the repo is primary however it was spelled", () => {
  // The resolver is what decides: a symlink from outside, or a `..` climb.
  assert.deepEqual(
    classify("/tmp/link.ts", null, { resolveFile: () => `${ROOT}/lib/x.ts` }),
    { scope: "primary" },
  );
  assert.deepEqual(
    classify(`${ROOT}/lib/../lib/x.ts`, null, { resolveFile: () => `${ROOT}/lib/x.ts` }),
    { scope: "primary" },
  );
});

test("a SYMLINKED worktree root is normalized on both sides", () => {
  // The session cwd may be logical (/work/repo) while git reports the physical
  // root (/private/work/repo). Resolving only one side would call every edit
  // outside — the exact hole this must not open.
  const scope = classifyEditRepoScope({
    absPath: "/work/repo/lib/x.ts",
    primaryRepoRoot: "/work/repo",
    editRepo: null,
    resolveFile: (p) => p.replace("/work/", "/private/work/"),
    resolveDir: (p) => p.replace("/work/", "/private/work/"),
  });
  assert.deepEqual(scope, { scope: "primary" });
});

test("a trailing slash on the root does not create a doubled boundary", () => {
  assert.deepEqual(classify("/work/repo/lib/x.ts", null, { root: "/work/repo/" }), { scope: "primary" });
  assert.deepEqual(classify("/work/repo-backup/x.ts", null, { root: "/work/repo/" }), { scope: "outside" });
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED: everything unresolvable keeps the pre-existing behaviour.

test("an unresolvable path is primary, never outside", () => {
  assert.deepEqual(classify("", null), { scope: "primary" }, "empty path");
  assert.deepEqual(classify("relative/x.ts", null), { scope: "primary" }, "non-absolute path");
  assert.deepEqual(classify("/tmp/x.md", null, { root: "relative-root" }), { scope: "primary" },
    "a root that is not absolute");
  assert.deepEqual(
    classify("/tmp/x.md", null, { resolveFile: () => { throw new Error("boom"); } }),
    { scope: "primary" },
    "a resolver that throws",
  );
  assert.deepEqual(
    classify("/tmp/x.md", null, { resolveDir: () => { throw new Error("boom"); } }),
    { scope: "primary" },
    "a root resolver that throws",
  );
  assert.deepEqual(classify("/tmp/x.md", null, { resolveFile: () => "" }), { scope: "primary" },
    "a resolver that answers nothing");
  assert.deepEqual(classify("/tmp/x.md", null, { resolveDir: () => "" }), { scope: "primary" },
    "a root resolver that answers nothing");
});

test("the repo root itself is primary, not outside", () => {
  assert.deepEqual(classify(ROOT, null), { scope: "primary" });
});

// ---------------------------------------------------------------------------
// The DEFAULT resolvers (no seam) against a real filesystem — the behaviour the
// extension actually gets.

test("default resolvers: real symlinks and real absent paths are judged correctly", (t) => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "rg-ers-")));
  t.after(() => { try { rmSync(parent, { recursive: true, force: true }); } catch { /* */ } });
  const repo = join(parent, "repo");
  mkdirSync(join(repo, "lib"), { recursive: true });
  writeFileSync(join(repo, "lib", "x.ts"), "export const a = 1;\n");
  const link = join(parent, "link.ts");
  symlinkSync(join(repo, "lib", "x.ts"), link);
  mkdirSync(join(parent, "repo-backup"), { recursive: true });
  writeFileSync(join(parent, "repo-backup", "x.ts"), "export const a = 2;\n");

  const at = (p: string) => classifyEditRepoScope({ absPath: p, primaryRepoRoot: repo, editRepo: null });

  assert.deepEqual(at(link), { scope: "primary" }, "a symlink pointing into the repo is in the repo");
  assert.deepEqual(at(join(repo, "lib", "..", "lib", "x.ts")), { scope: "primary" }, "`..` climbing back in");
  assert.deepEqual(at(join(repo, "no", "such", "dir", "y.ts")), { scope: "primary" },
    "a file in a repo directory that does not exist yet");
  assert.deepEqual(at(join(parent, "report.md")), { scope: "outside" }, "a report beside the repo");
  assert.deepEqual(at(join(parent, "repo-backup", "x.ts")), { scope: "outside" }, "a prefix-sharing sibling");
  // An UNNORMALIZED absolute path: /tmp is itself a symlink to /private/tmp on
  // macOS, so the resolved file and the resolved root must both be physical
  // before they are compared.
  assert.deepEqual(at("/tmp/rg-ers-no-such-report.md"), { scope: "outside" },
    "a path under a symlinked system dir is still outside");
});

test("default resolvers: a case-variant spelling of the repo root stays INSIDE", (t) => {
  // THE ONE REAL HOLE (adviser, round 1): on a case-INSENSITIVE filesystem
  // (APFS by default) `<REPO>/newdir/x.ts` spelled with different case is the
  // same file, and `git rev-parse` fails on the not-yet-existing directory —
  // so containment is decided by the resolver alone. Plain `realpathSync`
  // preserves the caller's spelling; only `realpathSync.native` normalizes it,
  // which is why this module reuses lib/fingerprint.ts's helpers instead of
  // resolving paths itself.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "rg-ers-case-")));
  t.after(() => { try { rmSync(parent, { recursive: true, force: true }); } catch { /* */ } });
  const repo = join(parent, "RepoX");
  mkdirSync(join(repo, "lib"), { recursive: true });
  writeFileSync(join(repo, "lib", "x.ts"), "export const a = 1;\n");

  const flippedRoot = join(parent, "repox");
  if (!existsSync(flippedRoot)) {
    t.skip("case-sensitive filesystem — the ambiguity this guards against cannot occur");
    return;
  }
  const at = (p: string) => classifyEditRepoScope({ absPath: p, primaryRepoRoot: repo, editRepo: null });
  assert.deepEqual(at(join(flippedRoot, "lib", "x.ts")), { scope: "primary" },
    "an existing repo file spelled with other case is still in the repo");
  assert.deepEqual(at(join(flippedRoot, "brand", "new", "y.ts")), { scope: "primary" },
    "…and so is a new file under a not-yet-existing directory of it");
});
