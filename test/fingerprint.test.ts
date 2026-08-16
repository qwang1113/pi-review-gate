import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);

const {
  computeFingerprint,
  changedFiles,
  advisoryChangeToken,
  isGateOwnedPath,
  mayBeGateOwned,
  GATE_EXCLUDE_DIRS,
  GATE_EXCLUDE_PATHSPECS,
  worktreeTreeOid,
  incrementSinceTree,
  reviewCoverageFiles,
  FINGERPRINT_VERSION,
} = await import(
  join(resolve(import.meta.dirname ?? "."), "..", "lib", "fingerprint.ts")
);

/**
 * WHY THE RACE LOOPS BELOW ARE NOT TUNABLE (a rejected optimization).
 *
 * These two loops dominate the suite — the 300-round one alone is ~73s of a
 * ~100s `npm test`, paid on every review round — so an env-scaled
 * `RG_RACE_ITERS` (25 for a commit-time fast path) was implemented, with a
 * measured justification: against a mutated implementation (shadow-index
 * backdate AND `--renormalize` both removed) the loop missed the edit in
 * 83/100 rounds, which would put the escape probability at 25 rounds around
 * 0.17^25.
 *
 * An independent reviewer reproduced that experiment on the same machine and
 * got a materially different result: at 25 rounds the mutated implementation
 * PASSED 3 of 5 runs. The rounds are not independent trials — they share one
 * repository, and the window depends on filesystem timestamp granularity,
 * machine load and pacing — so a per-round rate measured once cannot be
 * exponentiated into a guarantee. The knob was therefore REMOVED rather than
 * kept with a weaker claim: a safety loop whose strength cannot be stated
 * honestly should not be reducible by an environment variable.
 *
 * If these loops must get cheaper, the sound route is to make each ROUND
 * cheaper rather than to run fewer of them (dropping the per-round commit
 * measured 112ms/round vs 219ms/round), and to prove the new construction
 * still fails reliably against the mutated implementation before adopting it.
 *
 * Coverage note, so the next reader does not over-trust these loops: they only
 * fail when BOTH safeguards are gone. Removing just `--renormalize` is caught
 * deterministically by "an edit to a file with an ancient preserved mtime is
 * not invisible"; removing just the backdate is caught by NEITHER, because
 * `--renormalize` re-reads content unconditionally, which makes the backdate a
 * deliberate redundant second line of defence.
 */

const tempDirs: string[] = [];
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-fp-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], {
    cwd: dir, stdio: "ignore",
  });
  return dir;
}
after(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

test("clean repo fingerprint is stable", () => {
  const dir = makeRepo();
  const a = computeFingerprint(dir);
  const b = computeFingerprint(dir);
  assert.equal(a.digest, b.digest);
  assert.equal(a.unavailable, false);
});

test("brand-new UNTRACKED file changes the fingerprint", () => {
  const dir = makeRepo();
  const a = computeFingerprint(dir);
  writeFileSync(join(dir, "new.ts"), "// new file");
  const b = computeFingerprint(dir);
  assert.notEqual(a.digest, b.digest);
});

test("untracked file inside a new directory is seen", () => {
  const dir = makeRepo();
  const a = computeFingerprint(dir);
  mkdirSync(join(dir, "deep", "nested"), { recursive: true });
  writeFileSync(join(dir, "deep", "nested", "lib.ts"), "// deep");
  const b = computeFingerprint(dir);
  assert.notEqual(a.digest, b.digest);
});

// P0 regression (INVERTED on purpose — this assertion used to be notEqual).
// The old digest mixed `git diff --cached` in, so `git add` alone changed it.
// That is not a safety property: it made the L3 pre-commit hook reject a
// commit the gate had JUST approved, with zero bytes changed, pushing users
// toward REVIEW_GATE_BYPASS=1 (which disarms far more than the false
// mismatch it works around). The real guarantee — "content changed ⇒ binding
// invalidated" — is asserted by the content tests above/below, which still
// pass. Staging is bookkeeping; it must NOT invalidate a review binding.
test("staging an edit does NOT change the fingerprint (content is identical)", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "file.ts"), "// v1");
  const a = computeFingerprint(dir);
  execFileSync("git", ["add", "file.ts"], { cwd: dir, stdio: "ignore" });
  const b = computeFingerprint(dir);
  assert.equal(a.digest, b.digest, "git add must be fingerprint-invisible");
  // ...but changing the STAGED content still invalidates it.
  writeFileSync(join(dir, "file.ts"), "// v2");
  assert.notEqual(computeFingerprint(dir).digest, b.digest);
});

// The other half of the same P0: committing reviewed content must not
// invalidate its own binding (the old digest hashed HEAD, so pre-push
// rejected every commit pre-commit had just let through).
test("committing already-reviewed content does NOT change the fingerprint", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "file.ts"), "// v1");
  execFileSync("git", ["add", "file.ts"], { cwd: dir, stdio: "ignore" });
  const beforeCommit = computeFingerprint(dir);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "w"], {
    cwd: dir, stdio: "ignore",
  });
  const afterCommit = computeFingerprint(dir);
  assert.equal(beforeCommit.digest, afterCommit.digest, "commit must be fingerprint-invisible");
  assert.notEqual(beforeCommit.head, afterCommit.head, "HEAD did move (digest just must not depend on it)");
});

// NOTE ON A REJECTED TEST (kept as a warning, not as code).
//
// An attempt to replace the probabilistic loop below with a "deterministic"
// version — rewrite the file with same-size content, then restore the cached
// atime/mtime so the stat cache would consider it clean — does NOT work and
// was removed after an independent review challenged it. Measured on macOS/
// APFS: even with `core.checkStat=minimal` and `core.trustctime=false`, a
// plain `git add` with NO safeguards still sees such an edit, because ctime
// (which user space cannot forge) and sub-second mtime precision both move.
// The test therefore passed with every safeguard removed — it asserted
// nothing. Any future "deterministic race test" must first be shown to FAIL
// against a mutated implementation.

// P0 RACE REGRESSION (git "racily clean").
// The shadow index is seeded from the real index for speed. copyFileSync
// stamps the copy with a NEW mtime, which suppressed git's racily-clean
// re-hash: an edit landing in the same mtime granularity bucket as the index,
// with the size unchanged, was INVISIBLE to the digest -> a stale READY
// binding stayed valid across a real code change (the worst failure mode this
// gate has). The loop exists because the window is a TIMING property, not a
// constructible one: an attempt to force it deterministically (restore the
// cached stat after a same-size rewrite) provably asserts nothing, because
// ctime and sub-second mtime still move and git re-hashes on its own — see the
// rejected-test note above. Keep the full 300 rounds: a single measurement of
// the per-round detection rate (83/100 with both safeguards removed) does NOT
// license running fewer of them — an independent re-run of that same
// experiment let a mutated implementation pass 3 of 5 times at 25 rounds,
// because the rounds share one repository and depend on filesystem timestamp
// granularity, load and pacing rather than being independent trials.
// (Historically: 25/1500 fail-opens before the original fix, 0/1500 after.)
//
// Shape matters: same-size content (`// v1` -> `// v2`) written IMMEDIATELY
// after the commit is what lands in the racy window.
test("same-size edit right after a commit is never invisible to the fingerprint (racily-clean)", () => {
  // ONE repo, reused: the race lives in the (index mtime vs file mtime)
  // relationship, which is re-established by every commit, so repeated
  // edit+commit cycles in a single repo probe the same window far more
  // cheaply than building 300 repos. Verified to still catch the bug
  // (reintroducing it fails this test well before the loop ends).
  const ITERATIONS = 300;
  const dir = makeRepo();
  for (let i = 0; i < ITERATIONS; i++) {
    // Alternate between two SAME-SIZE contents so each write is a real change
    // that a size/mtime-trusting stat cache would miss.
    const content = i % 2 === 0 ? `// v${i % 10}a` : `// v${i % 10}b`;
    writeFileSync(join(dir, "file.ts"), content);
    execFileSync("git", ["add", "file.ts"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", `c${i}`], {
      cwd: dir, stdio: "ignore",
    });
    const before = computeFingerprint(dir);
    // Same length, written immediately after the commit -> lands in the racy
    // window where the index mtime and the file mtime share a bucket.
    writeFileSync(join(dir, "file.ts"), content.slice(0, -1) + "Z");
    const after = computeFingerprint(dir);
    // Assert availability FIRST and separately. Two "__UNAVAILABLE__" results
    // compare equal, so folding this into the notEqual below would report a
    // spurious fail-closed as a fail-open and send the next reader chasing the
    // wrong bug (it did exactly that once).
    assert.equal(before.unavailable, false, `iteration ${i}: fingerprint unavailable before the edit`);
    assert.equal(after.unavailable, false, `iteration ${i}: fingerprint unavailable after the edit`);
    assert.notEqual(
      after.digest,
      before.digest,
      `iteration ${i}: a real edit was invisible to the fingerprint (racily-clean fail-open) — ` +
        "the shadow index mtime must be backdated",
    );
  }
});

// P0 CLOCK-SKEW REGRESSION (found by independent review).
// The shadow index mtime is backdated so git re-hashes racily-clean entries.
// Backdating a fixed margin from the REAL index mtime is not enough: if that
// mtime is in the FUTURE (clock skew, a rolled-back system clock, a copied
// tree), index-5s is still in the future, entries keep looking safely clean,
// and a same-size edit stays invisible to the digest — a fail-open on content
// that can then be committed. The base must be clamped to `now`.
test("a FUTURE index mtime (clock skew) does not hide a same-size edit", () => {
  const dir = makeRepo();
  execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "x.ts"), "AAAA\n");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], {
    cwd: dir, stdio: "ignore",
  });

  // Push the real index mtime an hour into the future.
  const indexPath = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], {
    cwd: dir, encoding: "utf8",
  }).trim();
  const future = new Date(Date.now() + 3_600_000);
  utimesSync(indexPath, future, future);

  const before = computeFingerprint(dir);
  // Same-size edit, with the file's original mtime preserved so it stays
  // inside the window a future-dated index would wrongly trust.
  const fileStat = statSync(join(dir, "x.ts"));
  writeFileSync(join(dir, "x.ts"), "BBBB\n");
  utimesSync(join(dir, "x.ts"), fileStat.atime, fileStat.mtime);
  const after = computeFingerprint(dir);

  assert.equal(before.unavailable, false);
  assert.equal(after.unavailable, false);
  assert.notEqual(
    after.digest,
    before.digest,
    "a real edit was invisible to the fingerprint when the index mtime was in the future — " +
      "the backdate base must be clamped to min(indexMtime, now)",
  );
});

// P1 STALE-MTIME REGRESSION (found by independent review).
// Backdating the shadow index only makes entries whose mtime is NEAR the index
// look racy. A file carrying an ANCIENT preserved mtime — restored from backup,
// copied with `rsync -a`, unpacked from an archive — still looks confidently
// clean, so git trusts the copied stat cache and a same-size edit stays
// invisible to the digest. (`git add --renormalize` re-reads content and closes
// this.) The content is genuinely committable, so this was a real fail-open.
test("an edit to a file with an ancient preserved mtime is not invisible", () => {
  const dir = makeRepo();
  execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: dir, stdio: "ignore" });
  const ancient = new Date("2020-01-01T00:00:00Z");
  writeFileSync(join(dir, "x.ts"), "AAAA\n");
  utimesSync(join(dir, "x.ts"), ancient, ancient);
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], {
    cwd: dir, stdio: "ignore",
  });
  utimesSync(join(dir, "x.ts"), ancient, ancient);

  const before = computeFingerprint(dir);
  writeFileSync(join(dir, "x.ts"), "BBBB\n"); // same size
  utimesSync(join(dir, "x.ts"), ancient, ancient); // mtime unchanged, as a restore would leave it
  const after = computeFingerprint(dir);

  assert.equal(before.unavailable, false);
  assert.equal(after.unavailable, false);
  assert.notEqual(
    after.digest,
    before.digest,
    "a same-size edit to a file with a preserved ancient mtime was invisible to the fingerprint — " +
      "the index build must re-read content (--renormalize), not trust the stat cache",
  );
});

// P0 REGRESSION (found by independent review, then root-caused):
// a file that matches .gitignore but is nonetheless TRACKED (`git add -f`)
// is real, shippable content — `git commit -a` will commit changes to it.
// Two distinct bugs made such edits invisible to the digest:
//   1. `git add` refuses to stage an ignored path, so an EMPTY shadow index
//      drops the file from the tree entirely; only a SEEDED index keeps it.
//   2. an over-eager mtime-verification fallback deleted the seeded index on
//      ~57% of runs (utimesSync loses sub-ms precision), silently producing
//      case 1.
// Net effect was a ~50% fail-open on shippable content.
test("edits to a TRACKED but gitignored file still change the fingerprint", () => {
  const ITERATIONS = 25; // was ~50% fail-open; any regression shows up fast
  for (let i = 0; i < ITERATIONS; i++) {
    const dir = makeRepo();
    // Neutralize any ambient global ignore file on the developer's machine.
    execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, ".gitignore"), "*.gen.ts\n");
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "ignore rule"], {
      cwd: dir, stdio: "ignore",
    });
    // Force-add + commit => genuinely tracked, therefore shippable.
    writeFileSync(join(dir, "gen.gen.ts"), "export const v = 1;\n");
    execFileSync("git", ["add", "-f", "gen.gen.ts"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "track generated"], {
      cwd: dir, stdio: "ignore",
    });

    const before = computeFingerprint(dir);
    writeFileSync(join(dir, "gen.gen.ts"), "export const v = 9;\n");
    const after = computeFingerprint(dir);

    assert.equal(before.unavailable, false, `iteration ${i}: fingerprint unexpectedly unavailable`);
    assert.equal(after.unavailable, false, `iteration ${i}: fingerprint unexpectedly unavailable`);
    assert.notEqual(
      after.digest,
      before.digest,
      `iteration ${i}: an edit to a tracked-but-gitignored file was invisible to the fingerprint — ` +
        "this is shippable content (`git commit -a` commits it), so it must invalidate a READY binding",
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

// SUBMODULES (found by independent review): a parent tree stores only each
// submodule's committed gitlink, so edits INSIDE a checked-out submodule leave
// the parent tree bit-identical. The pre-change diff/status fingerprint DID
// catch this, so relying on the tree hash alone was a regression.
test("an edit inside a checked-out submodule changes the fingerprint", (t) => {
  const parent = makeRepo();
  const sub = makeRepo();
  writeFileSync(join(sub, "s.ts"), "// sub v1\n");
  execFileSync("git", ["add", "s.ts"], { cwd: sub, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "sub"], {
    cwd: sub, stdio: "ignore",
  });
  try {
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", sub, "sm"], {
      cwd: parent, stdio: "ignore",
    });
  } catch {
    // Some git builds/policies forbid local-path submodules outright.
    t.skip("submodule add unsupported in this environment");
    return;
  }
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add sm"], {
    cwd: parent, stdio: "ignore",
  });

  const before = computeFingerprint(parent);
  writeFileSync(join(parent, "sm", "s.ts"), "// sub v2 CHANGED\n");
  const after = computeFingerprint(parent);
  assert.notEqual(
    after.digest,
    before.digest,
    "an edit inside a submodule must invalidate the parent's READY binding",
  );

  // ...and the submodule probe must not break staging-invariance.
  const dirty = computeFingerprint(parent);
  execFileSync("git", ["add", "-A"], { cwd: parent, stdio: "ignore" });
  assert.equal(
    computeFingerprint(parent).digest,
    dirty.digest,
    "staging in the parent repo must not change the digest",
  );

  // ROUND-2 FINDING: hashing `git status` TEXT bound only the state, not the
  // content. A SECOND edit to an already-dirty file leaves the status line
  // ("M s.ts") byte-identical, so the digest did not move and the unreviewed
  // second version could still be committed inside the submodule.
  const dirtyA = computeFingerprint(parent);
  writeFileSync(join(parent, "sm", "s.ts"), "// DIRTY version B, entirely different\n");
  assert.notEqual(
    computeFingerprint(parent).digest,
    dirtyA.digest,
    "a second edit to an already-dirty submodule file must still change the digest " +
      "(the probe must bind CONTENT, not `git status` text)",
  );
});

// ROUND-2 FINDING: submodule detection read `git config --file .gitmodules`,
// which returns the same empty result for "no submodules" and "this file is
// corrupt" — so a malformed .gitmodules silently disabled submodule coverage
// entirely. Detection now reads gitlinks from the index, which is
// authoritative and survives a broken .gitmodules.
test("a malformed .gitmodules does not silently disable submodule coverage", (t) => {
  const parent = makeRepo();
  const sub = makeRepo();
  writeFileSync(join(sub, "s.ts"), "// sub v1\n");
  execFileSync("git", ["add", "s.ts"], { cwd: sub, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "sub"], {
    cwd: sub, stdio: "ignore",
  });
  try {
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", sub, "sm"], {
      cwd: parent, stdio: "ignore",
    });
  } catch {
    t.skip("submodule add unsupported in this environment");
    return;
  }
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add sm"], {
    cwd: parent, stdio: "ignore",
  });
  // Corrupt .gitmodules while the gitlink stays valid.
  writeFileSync(join(parent, ".gitmodules"), '[submodule "sm"\n  broken = \n');
  execFileSync("git", ["add", ".gitmodules"], { cwd: parent, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "break"], {
    cwd: parent, stdio: "ignore",
  });

  const before = computeFingerprint(parent);
  writeFileSync(join(parent, "sm", "s.ts"), "// changed despite malformed .gitmodules\n");
  assert.notEqual(
    computeFingerprint(parent).digest,
    before.digest,
    "submodule edits must still be detected when .gitmodules is unparseable",
  );
});

// An uninitialized / deinit'd submodule is a legitimate, common state (CI,
// shallow checkouts). It has no working content to review, and the parent's
// gitlink already pins it, so it must NOT make the fingerprint unavailable —
// that would brick every commit (the B2 lesson: a new sub-gate must never make
// legitimate work impossible).
test("a deinit'd submodule does not brick the fingerprint", (t) => {
  const parent = makeRepo();
  const sub = makeRepo();
  writeFileSync(join(sub, "s.ts"), "// sub\n");
  execFileSync("git", ["add", "s.ts"], { cwd: sub, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "sub"], {
    cwd: sub, stdio: "ignore",
  });
  try {
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", sub, "sm"], {
      cwd: parent, stdio: "ignore",
    });
  } catch {
    t.skip("submodule add unsupported in this environment");
    return;
  }
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add sm"], {
    cwd: parent, stdio: "ignore",
  });
  execFileSync("git", ["submodule", "deinit", "-f", "sm"], { cwd: parent, stdio: "ignore" });

  const fp = computeFingerprint(parent);
  assert.equal(fp.unavailable, false, "a deinit'd submodule must not make the fingerprint unavailable");
  assert.match(fp.digest, /^[0-9a-f]{40,64}$/);
  // Still stable across repeated calls (bindable).
  assert.equal(computeFingerprint(parent).digest, fp.digest);
});

test("unstaged edit changes fingerprint", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "file.ts"), "// v1");
  execFileSync("git", ["add", "file.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add"], { cwd: dir, stdio: "ignore" });
  const a = computeFingerprint(dir);
  writeFileSync(join(dir, "file.ts"), "// v2");
  const b = computeFingerprint(dir);
  assert.notEqual(a.digest, b.digest);
});

// Renamed from "HEAD move changes fingerprint": under the content-addressed
// digest a HEAD move is NOT what changes it (see the commit test above) —
// adding f.ts is. Keeping the old name would assert a property the gate
// deliberately no longer has.
test("adding a new file changes the fingerprint (even via a commit)", () => {
  const dir = makeRepo();
  const a = computeFingerprint(dir);
  writeFileSync(join(dir, "f.ts"), "//");
  execFileSync("git", ["add", "f.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add"], { cwd: dir, stdio: "ignore" });
  const b = computeFingerprint(dir);
  assert.notEqual(a.digest, b.digest);
});

test("non-git directory → unavailable=true (fail closed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-nogit-"));
  tempDirs.push(dir);
  const fp = computeFingerprint(dir);
  assert.equal(fp.unavailable, true);
});

// Pre-existing defect found while adding the advisory token: `-z` porcelain
// entries are `XY <path>`, and an UNSTAGED modification starts with a space
// (" M f.ts"). The shared git() helper trimmed its output, so the FIRST entry
// lost that space and slice(3) returned ".ts" instead of "f.ts". Invisible to
// the old consumers (which only look at the extension) and to the old test
// (which used untracked "?? x.ts" entries, no leading space), but wrong for
// anything that must open the path.
test("changedFiles: an unstaged modification keeps its FULL path (no leading-space trim)", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "f.ts"), "// v1");
  execFileSync("git", ["add", "f.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "c"], {
    cwd: dir, stdio: "ignore",
  });
  writeFileSync(join(dir, "f.ts"), "// v2 (unstaged edit)");
  assert.deepEqual(changedFiles(dir), ["f.ts"]);
});

test("changedFiles: clean repo → [], dirty repo lists paths", () => {
  const dir = makeRepo();
  assert.deepEqual(changedFiles(dir), []);
  writeFileSync(join(dir, "x.ts"), "//");
  writeFileSync(join(dir, "y.md"), "//");
  const files = changedFiles(dir);
  assert.ok(files!.includes("x.ts"));
  assert.ok(files!.includes("y.md"));
});

// ---------------------------------------------------------------------------
// P0 self-deadlock regression: the gate's OWN writes must not invalidate the
// fingerprint they were bound to. In a repo that does NOT gitignore .pi, the
// old fingerprint included the untracked sidecar (size+mtime), so persist()
// after record_review immediately broke the READY binding.

/** Disable the developer's global gitignore for a test repo so an ambient
 *  `.pi*` exclude (present on some machines) can't mask the regression. */
function disableGlobalExcludes(dir: string): void {
  execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: dir, stdio: "ignore" });
}

test("P0: gate-owned .pi files do NOT affect the fingerprint (sidecar self-deadlock)", () => {
  const dir = makeRepo();
  disableGlobalExcludes(dir);
  writeFileSync(join(dir, "code.ts"), "// change\n"); // some real change
  const before = computeFingerprint(dir);
  // Simulate persist(): create + rewrite the sidecar, lessons, arbitration log.
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), JSON.stringify({ schema: 1 }));
  writeFileSync(join(dir, ".pi", "review-gate-lessons.md"), "### L1\nlesson\n");
  writeFileSync(join(dir, ".pi", "review-gate-arbitration.log"), "entry\n");
  // Plus the two newer gate-owned writers. The precommit run log is the
  // sharpest case: run_precommit writes it and then binds its PASS to the
  // fingerprint computed right after — if the log counted, every PASS would
  // be born already invalid.
  writeFileSync(join(dir, ".pi", "precommit-last.log"), "▶ test\nfailing output\n");
  writeFileSync(join(dir, ".pi", "review-gate-audit.log"), "2026-01-01 [s] goal approved\n");
  const after = computeFingerprint(dir);
  assert.equal(before.digest, after.digest, "gate-owned .pi writes must be fingerprint-invisible");
  // Rewriting the sidecar again (new mtime + content) still changes nothing.
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), JSON.stringify({ schema: 1, updatedAt: "t2" }));
  writeFileSync(join(dir, ".pi", "precommit-last.log"), "▶ test\ndifferent output\n");
  assert.equal(computeFingerprint(dir).digest, after.digest);
});

test("P0: .pi-subagents artifacts do NOT affect the fingerprint", () => {
  const dir = makeRepo();
  disableGlobalExcludes(dir);
  const before = computeFingerprint(dir);
  mkdirSync(join(dir, ".pi-subagents", "artifacts"), { recursive: true });
  writeFileSync(join(dir, ".pi-subagents", "artifacts", "x_output.md"), "transcript");
  assert.equal(computeFingerprint(dir).digest, before.digest);
});

test("P0: changedFiles ignores gate-owned .pi paths (turn_end reconciliation)", () => {
  const dir = makeRepo();
  disableGlobalExcludes(dir);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), "{}");
  assert.deepEqual(changedFiles(dir), []);
});

test("real project files still change the fingerprint after the exclusion", () => {
  const dir = makeRepo();
  disableGlobalExcludes(dir);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), "{}");
  const a = computeFingerprint(dir);
  writeFileSync(join(dir, "new.ts"), "// real change");
  assert.notEqual(computeFingerprint(dir).digest, a.digest);
});

test("isGateOwnedPath matches exactly the dirs the fingerprint excludes", () => {
  const root = "/repo";
  // Gate-owned: fingerprint-invisible, so edit tracking must skip these too.
  assert.equal(isGateOwnedPath(join(root, ".pi", "loop-goal.md"), root), true);
  assert.equal(isGateOwnedPath(join(root, ".pi", "review-gate-state.json"), root), true);
  assert.equal(isGateOwnedPath(join(root, ".pi-subagents", "artifacts", "x.md"), root), true);
  // Project files, including a nested .pi that the `:/` pathspecs do NOT cover.
  assert.equal(isGateOwnedPath(join(root, "lib", "loop-goal.ts"), root), false);
  assert.equal(isGateOwnedPath(join(root, "sub", ".pi", "x.md"), root), false);
  assert.equal(isGateOwnedPath(join(root, ".pilot", "x.md"), root), false);
  // Outside the repo entirely (another checkout's .pi must not be swallowed).
  assert.equal(isGateOwnedPath("/other/.pi/loop-goal.md", root), false);
  assert.equal(isGateOwnedPath(root, root), false);
  // Derived from the pathspecs, so the two lists cannot drift.
  assert.deepEqual([...GATE_EXCLUDE_DIRS], GATE_EXCLUDE_PATHSPECS.map((s: string) => s.replace(/^:\//, "")));
});

test("isGateOwnedPath survives a symlinked worktree (logical cwd vs git's physical root)", () => {
  // Edit paths are built from the session cwd (may run through a symlink),
  // repo roots come from `git rev-parse --show-toplevel` (always physical).
  // Comparing them raw would miss the exclusion and arm the gate on a file no
  // review can see — the bug the .pi/ exclusion exists to prevent.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rg-sym-")));
  tempDirs.push(base);
  const physical = join(base, "physical");
  mkdirSync(join(physical, ".pi"), { recursive: true });
  writeFileSync(join(physical, ".pi", "loop-goal.md"), "# goal\n");
  const link = join(base, "link");
  symlinkSync(physical, link, "dir");

  assert.equal(isGateOwnedPath(join(link, ".pi", "loop-goal.md"), physical), true);
  assert.equal(isGateOwnedPath(join(physical, ".pi", "loop-goal.md"), link), true);
  // The symlink must not smuggle in a project file.
  writeFileSync(join(physical, "a.ts"), "export const a = 1;\n");
  assert.equal(isGateOwnedPath(join(link, "a.ts"), physical), false);
});

test("isGateOwnedPath normalizes paths that do not exist yet (first write of the goal)", () => {
  // tool_call fires BEFORE the file exists, and the very first loop goal is
  // written before `.pi/` itself exists — resolving only existing ancestors
  // must still normalize the symlinked prefix.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rg-sym2-")));
  tempDirs.push(base);
  const physical = join(base, "physical");
  mkdirSync(physical, { recursive: true });
  const link = join(base, "link");
  symlinkSync(physical, link, "dir");

  // Neither `.pi/` nor the file exist yet.
  assert.equal(isGateOwnedPath(join(link, ".pi", "loop-goal.md"), physical), true);
  assert.equal(isGateOwnedPath(join(link, "lib", "new.ts"), physical), false);
});

test("a symlink inside a gate dir cannot hide a project file from edit tracking", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rg-sym3-")));
  tempDirs.push(root);
  mkdirSync(join(root, "lib"), { recursive: true });
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, "lib", "x.ts"), "export const x = 1;\n");
  // `.pi/x.ts` -> `lib/x.ts`: judged by where the file really lives, so edits
  // made through the link still arm the gate.
  symlinkSync(join(root, "lib", "x.ts"), join(root, ".pi", "x.ts"));
  assert.equal(isGateOwnedPath(join(root, ".pi", "x.ts"), root), false);
  // A real file under .pi/ is still gate-owned.
  writeFileSync(join(root, ".pi", "loop-goal.md"), "# goal\n");
  assert.equal(isGateOwnedPath(join(root, ".pi", "loop-goal.md"), root), true);
});

test("mayBeGateOwned is a cheap pre-filter: no gate dir name ⇒ no filesystem work", () => {
  assert.equal(mayBeGateOwned("/repo/lib/x.ts"), false);
  assert.equal(mayBeGateOwned("/repo/.pilot/x.md"), false);
  assert.equal(mayBeGateOwned("/repo/.pi/loop-goal.md"), true);
  // Over-inclusive by design: the exact check rejects nested ones.
  assert.equal(mayBeGateOwned("/repo/sub/.pi/x.md"), true);
  assert.equal(isGateOwnedPath("/repo/sub/.pi/x.md", "/repo"), false);
});

// The CJS mirror (scripts/compute-fingerprint.cjs, used by the git hooks) must
// produce the IDENTICAL digest — drift between the two implementations makes
// every hook fail closed on fingerprint mismatch.
test("parity: compute-fingerprint.cjs emits the same digest as lib/fingerprint.ts", () => {
  const dir = makeRepo();
  disableGlobalExcludes(dir);
  writeFileSync(join(dir, "code.ts"), "// change\n");
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), "{}");
  execFileSync("git", ["add", "code.ts"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "code.ts"), "// v2\n"); // staged + unstaged + untracked mix
  writeFileSync(join(dir, "notes.md"), "docs\n");
  const tsFp = computeFingerprint(dir);
  const cjsOut = execFileSync("node", [
    join(resolve(import.meta.dirname ?? "."), "..", "scripts", "compute-fingerprint.cjs"), dir,
  ], { encoding: "utf8" });
  const cjsFp = JSON.parse(cjsOut);
  assert.equal(cjsFp.unavailable, false);
  assert.equal(cjsFp.digest, tsFp.digest, "TS and CJS fingerprint implementations drifted");
});

// ---------------------------------------------------------------------------
// advisoryChangeToken — the PROMPT-ONLY cheap probe (see lib/fingerprint.ts).
// It exists to skip a redundant ~575ms re-hash per turn; its correctness bar
// is "moves whenever the worktree moves", NOT "staging-invariant".

test("advisory token is stable while nothing changes", () => {
  const dir = makeRepo();
  assert.equal(advisoryChangeToken(dir), advisoryChangeToken(dir));
});

test("advisory token moves for a new untracked file and for a delete", () => {
  const dir = makeRepo();
  const clean = advisoryChangeToken(dir);
  writeFileSync(join(dir, "new.ts"), "// new");
  const added = advisoryChangeToken(dir);
  assert.notEqual(added, clean);

  writeFileSync(join(dir, "tracked.ts"), "// v1");
  execFileSync("git", ["add", "tracked.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add"], {
    cwd: dir, stdio: "ignore",
  });
  const beforeDelete = advisoryChangeToken(dir);
  rmSync(join(dir, "tracked.ts"));
  assert.notEqual(advisoryChangeToken(dir), beforeDelete);
});

// THE case that makes a status-only token worthless: the second edit to a file
// that is ALREADY dirty leaves the porcelain line byte-identical (" M f.ts").
// Without the size+mtime stamps the memo would keep serving a stale prompt for
// the whole editing burst.
test("advisory token moves on a SECOND edit to an already-dirty file", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "f.ts"), "// v1");
  execFileSync("git", ["add", "f.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "c"], {
    cwd: dir, stdio: "ignore",
  });
  writeFileSync(join(dir, "f.ts"), "// v1 edited once");
  const first = advisoryChangeToken(dir);
  writeFileSync(join(dir, "f.ts"), "// v1 edited once and then twice");
  assert.notEqual(advisoryChangeToken(dir), first);
});

test("advisory token ignores the gate's own dirs, exactly like the fingerprint", () => {
  // The gate writes .pi/ on every persist; if that moved the token, the memo
  // would never hit (and, worse, invite someone to 'fix' it by weakening the
  // fingerprint's own exclusions).
  const dir = makeRepo();
  const before = advisoryChangeToken(dir);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), '{"schema":1}');
  mkdirSync(join(dir, ".pi-subagents"), { recursive: true });
  writeFileSync(join(dir, ".pi-subagents", "artifact.md"), "x");
  assert.equal(advisoryChangeToken(dir), before);
});

test("advisory token is null (never a stale reuse) outside a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-nongit-"));
  tempDirs.push(dir);
  assert.equal(advisoryChangeToken(dir), null);
});

test("advisory token is NOT a fingerprint substitute — it is staging-variant", () => {
  // Documents why enforcement must never key off this value: `git add` alone
  // moves it, which is precisely the P0 bug the content-addressed fingerprint
  // was introduced to fix.
  const dir = makeRepo();
  writeFileSync(join(dir, "f.ts"), "// v1");
  const unstaged = advisoryChangeToken(dir);
  const fpUnstaged = computeFingerprint(dir).digest;
  execFileSync("git", ["add", "f.ts"], { cwd: dir, stdio: "ignore" });
  assert.notEqual(advisoryChangeToken(dir), unstaged, "token tracks staging");
  assert.equal(computeFingerprint(dir).digest, fpUnstaged, "fingerprint does not");
});

// ---------------------------------------------------------------------------
// CWD PARITY (found by independent review). The extension computes the
// fingerprint from the SESSION cwd, which may be a subdirectory; the git hooks
// always run at the repo toplevel. If the two disagree, the hook rejects a
// binding the extension just made — "code was modified after the last READY
// review" with no way to satisfy it. `git ls-files` reports cwd-relative paths
// by default ("../../sm"), and submoduleDigest() mixes the path text into the
// digest, so this was reproducible: fp(root) != fp(deep/work).

test("fingerprint is identical from the repo root and from a subdirectory", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, "deep", "work"), { recursive: true });
  writeFileSync(join(dir, "deep", "work", "a.ts"), "// a");
  writeFileSync(join(dir, "top.ts"), "// top");
  assert.equal(
    computeFingerprint(join(dir, "deep", "work")).digest,
    computeFingerprint(dir).digest,
    "a plain repo must hash identically from any directory inside it",
  );
});

test("fingerprint with a SUBMODULE is identical from the root and a subdirectory", (t) => {
  const parent = makeRepo();
  const sub = makeRepo();
  writeFileSync(join(sub, "s.ts"), "// sub v1\n");
  execFileSync("git", ["add", "s.ts"], { cwd: sub, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "sub"], {
    cwd: sub, stdio: "ignore",
  });
  try {
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", sub, "sm"], {
      cwd: parent, stdio: "ignore",
    });
  } catch {
    t.skip("submodule add unsupported in this environment");
    return;
  }
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add sm"], {
    cwd: parent, stdio: "ignore",
  });
  mkdirSync(join(parent, "deep", "work"), { recursive: true });

  const fromRoot = computeFingerprint(parent);
  const fromSubdir = computeFingerprint(join(parent, "deep", "work"));
  assert.equal(fromSubdir.digest, fromRoot.digest,
    "the submodule path must enter the digest repo-root-relative, not cwd-relative");

  // Parity must survive an actual submodule edit, not just the clean state.
  writeFileSync(join(parent, "sm", "s.ts"), "// sub v2 CHANGED\n");
  const dirtyRoot = computeFingerprint(parent);
  const dirtySubdir = computeFingerprint(join(parent, "deep", "work"));
  assert.notEqual(dirtyRoot.digest, fromRoot.digest, "the edit must still be seen");
  assert.equal(dirtySubdir.digest, dirtyRoot.digest, "and both cwds must still agree");
});

test("fingerprint with a NESTED submodule is identical from the root and a subdirectory", (t) => {
  const inner = makeRepo();
  writeFileSync(join(inner, "i.ts"), "// inner v1\n");
  execFileSync("git", ["add", "i.ts"], { cwd: inner, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "inner"], {
    cwd: inner, stdio: "ignore",
  });
  const outer = makeRepo();
  const parent = makeRepo();
  try {
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", inner, "nested"], {
      cwd: outer, stdio: "ignore",
    });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "nest"], {
      cwd: outer, stdio: "ignore",
    });
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", outer, "sm"], {
      cwd: parent, stdio: "ignore",
    });
  } catch {
    t.skip("submodule add unsupported in this environment");
    return;
  }
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add sm"], {
    cwd: parent, stdio: "ignore",
  });
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"], {
    cwd: parent, stdio: "ignore",
  });
  mkdirSync(join(parent, "deep", "work"), { recursive: true });

  assert.equal(
    computeFingerprint(join(parent, "deep", "work")).digest,
    computeFingerprint(parent).digest,
    "nested submodule recursion must also be cwd-independent",
  );
});

// ---------------------------------------------------------------------------
// AMBIENT GIT LOCATION VARIABLES (found while fixing the same class in the
// divergence checker). git resolves the repository from GIT_DIR/GIT_WORK_TREE
// before falling back to the cwd, so inheriting them made computeFingerprint()
// describe a DIFFERENT repository: a real edit in the repo the caller asked
// about left "its" digest unchanged, keeping a stale READY binding valid.

test("fingerprint ignores an ambient GIT_DIR/GIT_WORK_TREE", () => {
  const target = makeRepo();
  const decoy = makeRepo();
  writeFileSync(join(decoy, "d.ts"), "// decoy");
  execFileSync("git", ["add", "d.ts"], { cwd: decoy, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "d"], {
    cwd: decoy, stdio: "ignore",
  });

  const before = computeFingerprint(target).digest;
  writeFileSync(join(target, "real.ts"), "// a real edit in the target repo");

  const saved = { dir: process.env.GIT_DIR, work: process.env.GIT_WORK_TREE };
  try {
    process.env.GIT_DIR = join(decoy, ".git");
    process.env.GIT_WORK_TREE = decoy;
    const poisoned = computeFingerprint(target).digest;
    assert.notEqual(poisoned, before,
      "an edit in the target repo must move its digest even with a decoy GIT_DIR set");
  } finally {
    if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
    if (saved.work === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.work;
  }

  assert.equal(computeFingerprint(target).digest,
    (() => {
      const saved2 = process.env.GIT_DIR;
      try {
        process.env.GIT_DIR = join(decoy, ".git");
        return computeFingerprint(target).digest;
      } finally {
        if (saved2 === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved2;
      }
    })(),
    "the digest must be identical with and without the ambient variable");
});

test("advisory change token also ignores an ambient GIT_DIR", () => {
  const target = makeRepo();
  const decoy = makeRepo();
  // The file must be TRACKED in target and absent from decoy, so the two repos
  // disagree about it: target reports " M t.ts", a decoy index reports
  // "?? t.ts". A merely untracked file would look identical in both and the
  // test would pass even with the environment leaking through.
  writeFileSync(join(target, "t.ts"), "// v1");
  execFileSync("git", ["add", "t.ts"], { cwd: target, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "t"], {
    cwd: target, stdio: "ignore",
  });
  writeFileSync(join(target, "t.ts"), "// v2 modified");
  const clean = advisoryChangeToken(target);
  assert.ok(clean, "precondition: the token must be computable");

  const saved = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = join(decoy, ".git");
    assert.equal(advisoryChangeToken(target), clean,
      "the token must describe the requested repo, not the one an env var points at");
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
  }
});

// ---------------------------------------------------------------------------
// GIT CONFIG INJECTION (found by independent review). Stripping GIT_DIR is not
// enough: `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` (and
// GIT_CONFIG_PARAMETERS / _GLOBAL / _SYSTEM) inject configuration into the git
// invocation itself. Injecting `core.excludesFile` made a real untracked edit
// invisible to `git add`, so the digest never moved and a stale READY binding
// stayed valid — with no GIT_DIR involved.

test("injected core.excludesFile cannot hide an edit from the fingerprint (TS)", () => {
  const dir = makeRepo();
  const patterns = join(mkdtempSync(join(tmpdir(), "rg-pat-")), "ignore");
  tempDirs.push(dirname(patterns));
  writeFileSync(patterns, "target.txt\n");

  const before = computeFingerprint(dir).digest;
  writeFileSync(join(dir, "target.txt"), "a real untracked edit");
  const honest = computeFingerprint(dir).digest;
  assert.notEqual(honest, before, "precondition: the edit must move the digest normally");

  const saved = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0,
  };
  try {
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.excludesFile";
    process.env.GIT_CONFIG_VALUE_0 = patterns;
    assert.equal(computeFingerprint(dir).digest, honest,
      "config injection must not remove a real edit from the digest");
  } finally {
    for (const [k, v] of [
      ["GIT_CONFIG_COUNT", saved.count], ["GIT_CONFIG_KEY_0", saved.key], ["GIT_CONFIG_VALUE_0", saved.value],
    ] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("injected core.excludesFile cannot hide an edit from the CJS mirror either", () => {
  const dir = makeRepo();
  const patterns = join(mkdtempSync(join(tmpdir(), "rg-pat2-")), "ignore");
  tempDirs.push(dirname(patterns));
  writeFileSync(patterns, "target.txt\n");
  const script = join(resolve(import.meta.dirname ?? "."), "..", "scripts", "compute-fingerprint.cjs");
  const run = (env: Record<string, string>) =>
    JSON.parse(execFileSync("node", [script, dir], {
      encoding: "utf8", env: { ...process.env, ...env },
    })).digest;

  writeFileSync(join(dir, "target.txt"), "a real untracked edit");
  const honest = run({});
  const injected = run({
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.excludesFile",
    GIT_CONFIG_VALUE_0: patterns,
  });
  assert.equal(injected, honest,
    "the hook-side implementation must resist the same injection as the extension side");
});

// ---------------------------------------------------------------------------
// THE REAL INDEX IS READ-ONLY TO THE GATE.
//
// Everything the fingerprint does happens in a private shadow index. When the
// scratch-index passes were extended to clear assume-unchanged/skip-worktree,
// the helper that ran them silently DROPPED its env argument, so
// `update-index` hit the user's real index instead and wiped those bits
// (verified: `S a.ts` / `h b.ts` became `H a.ts` / `H b.ts` after a single
// fingerprint). Destroying user state is worse than any performance win.

/** `git ls-files -v` flags, which encode assume-unchanged (h) / skip-worktree (S). */
function indexFlags(dir: string): string {
  return execFileSync("git", ["ls-files", "-v"], { cwd: dir, encoding: "utf8" }).trim();
}

/** Repo with one skip-worktree and one assume-unchanged path. */
function repoWithIndexBits(): string {
  const dir = makeRepo();
  writeFileSync(join(dir, "a.ts"), "// v1");
  writeFileSync(join(dir, "b.ts"), "// v1");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "c"], {
    cwd: dir, stdio: "ignore",
  });
  execFileSync("git", ["update-index", "--skip-worktree", "a.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["update-index", "--assume-unchanged", "b.ts"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("computeFingerprint does not mutate the user's real index", () => {
  const dir = repoWithIndexBits();
  const before = indexFlags(dir);
  assert.match(before, /^S a\.ts$/m, "precondition: skip-worktree is set");
  assert.match(before, /^h b\.ts$/m, "precondition: assume-unchanged is set");

  computeFingerprint(dir);

  assert.equal(indexFlags(dir), before,
    "the gate must never clear the user's index bits — those passes belong in the shadow index");
});

test("the CJS mirror does not mutate the user's real index either", () => {
  const dir = repoWithIndexBits();
  const before = indexFlags(dir);
  execFileSync("node", [
    join(resolve(import.meta.dirname ?? "."), "..", "scripts", "compute-fingerprint.cjs"), dir,
  ], { encoding: "utf8" });
  assert.equal(indexFlags(dir), before, "the hook-side implementation must be read-only too");
});

test("a skip-worktree repo produces a usable fingerprint that still tracks edits", () => {
  // Before clearing the bit in the SHADOW index, `git add` aborted with
  // "outside of your sparse-checkout definition" and the fingerprint failed
  // closed, so a sparse-checkout repo could never pass the gate at all.
  const dir = repoWithIndexBits();
  const first = computeFingerprint(dir);
  assert.equal(first.unavailable, false, "a sparse-checkout repo must be fingerprintable");

  // And the bit must not hide a real edit from the digest.
  writeFileSync(join(dir, "a.ts"), "// v2 edited behind skip-worktree");
  assert.notEqual(computeFingerprint(dir).digest, first.digest,
    "an edit to a skip-worktree path must still move the digest");
});

// ---------------------------------------------------------------------------
// SHARED MATERIALIZATION, PROVEN AT THE FUNCTION BOUNDARY.
//
// Counting `clean` filter invocations is not a stable observable (git re-runs
// the filter a variable number of times per pass: measured 2 for the checker
// and 5 for the fingerprint through the SAME function). Injecting the tree
// resolver instead counts the project's OWN materialization boundary, which is
// exactly the property the hook depends on — including the submodule
// recursion, where an earlier version silently fell back to a fresh
// materialization per submodule.

test("compute() asks the injected resolver once per repository, submodules included", (t) => {
  const inner = makeRepo();
  writeFileSync(join(inner, "i.ts"), "// inner v1\n");
  execFileSync("git", ["add", "i.ts"], { cwd: inner, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "inner"], {
    cwd: inner, stdio: "ignore",
  });
  const parent = makeRepo();
  try {
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", inner, "sm"], {
      cwd: parent, stdio: "ignore",
    });
  } catch {
    t.skip("submodule add unsupported in this environment");
    return;
  }
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add sm"], {
    cwd: parent, stdio: "ignore",
  });

  const cjs = requireCjs(join(resolve(import.meta.dirname ?? "."), "..", "scripts", "compute-fingerprint.cjs"));

  // Baseline: no injection at all.
  const plain = cjs.compute(parent);
  assert.equal(plain.unavailable, false);

  // Injected resolver that memoizes exactly like the divergence checker does.
  // Canonicalize: git reports /private/var/... where mkdtemp returned
  // /var/... on macOS, so a lexical compare would silently never match.
  const canon = (d: string) => { try { return realpathSync(d); } catch { return resolve(d); } };
  const calls: string[] = [];
  const cache = new Map<string, string>();
  const treeOidForCwd = (dir: string) => {
    const key = canon(dir);
    calls.push(key);
    if (!cache.has(key)) cache.set(key, cjs.worktreeTreeOid(dir));
    return cache.get(key)!;
  };

  const shared = cjs.compute(parent, { treeOidForCwd });
  assert.equal(shared.digest, plain.digest,
    "sharing must not change the digest");

  // The parent AND the submodule must both go through the resolver...
  assert.ok(calls.includes(canon(parent)), "the parent tree must come from the resolver");
  assert.ok(calls.includes(canon(join(parent, "sm"))),
    "the SUBMODULE tree must come from the resolver too (it used to bypass it)");
  // ...and neither may be materialized twice within one run.
  for (const dir of new Set(calls)) {
    assert.equal(calls.filter((c) => c === dir).length, 1,
      `${dir} was materialized more than once in a single decision`);
  }
});

test("a resolver is used for the top-level repo even without submodules", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "a.ts"), "// content");
  const cjs = requireCjs(join(resolve(import.meta.dirname ?? "."), "..", "scripts", "compute-fingerprint.cjs"));
  const calls: string[] = [];
  const result = cjs.compute(dir, {
    treeOidForCwd: (d: string) => { calls.push(realpathSync(d)); return cjs.worktreeTreeOid(d); },
  });
  assert.equal(result.unavailable, false);
  assert.deepEqual(calls, [realpathSync(dir)], "exactly one materialization, for the requested repo");
});

// ---------------------------------------------------------------------------
// worktreeTreeOid — the bare tree OID (no submodule mixing)
// ---------------------------------------------------------------------------

test("worktreeTreeOid returns a valid 40-char hex OID", () => {
  const dir = makeRepo();
  const oid = worktreeTreeOid(dir);
  assert.match(oid, /^[0-9a-f]{40}$/, "must be a valid git tree OID");
});

test("worktreeTreeOid is stable across repeated calls", () => {
  const dir = makeRepo();
  assert.equal(worktreeTreeOid(dir), worktreeTreeOid(dir));
});

test("worktreeTreeOid changes when content changes", () => {
  const dir = makeRepo();
  const a = worktreeTreeOid(dir);
  writeFileSync(join(dir, "new.ts"), "// new file");
  const b = worktreeTreeOid(dir);
  assert.notEqual(b, a, "a new file must change the tree OID");
});

test("worktreeTreeOid is the same from a subdirectory", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, "deep", "work"), { recursive: true });
  writeFileSync(join(dir, "deep", "work", "a.ts"), "// a");
  assert.equal(
    worktreeTreeOid(join(dir, "deep", "work")),
    worktreeTreeOid(dir),
    "the tree OID must be cwd-independent",
  );
});

test("worktreeTreeOid is staging-invariant", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "file.ts"), "// v1");
  const unstaged = worktreeTreeOid(dir);
  execFileSync("git", ["add", "file.ts"], { cwd: dir, stdio: "ignore" });
  assert.equal(worktreeTreeOid(dir), unstaged, "git add must not change the tree OID");
});

test("worktreeTreeOid excludes gate-owned dirs", () => {
  const dir = makeRepo();
  const before = worktreeTreeOid(dir);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), "{}");
  mkdirSync(join(dir, ".pi-subagents"), { recursive: true });
  writeFileSync(join(dir, ".pi-subagents", "artifact.md"), "x");
  assert.equal(worktreeTreeOid(dir), before, "gate-owned dirs must be excluded from the tree");
});

test("worktreeTreeOid survives a deleted tracked file (two-pass order regression)", () => {
  // P1 regression (2026-08-15): the shadow-index passes ran `--renormalize`
  // FIRST. It implies `-u`, and git's `-u` stats every tracked file — a file
  // deleted from the worktree (but still in the index) aborted with
  // `fatal: unable to stat`, failing the whole fingerprint closed and
  // blocking every commit in any repo with a deleted file. The fix swaps the
  // order: plain `-A` removes deletions from the index first, then
  // `--renormalize` only touches files that still exist. This test pins the
  // DIRECT behavior (worktreeTreeOid itself, not the increment wrapper):
  // reverting the order must fail it.
  const dir = makeRepo();
  writeFileSync(join(dir, "to_delete.ts"), "// will be deleted\n");
  execFileSync("git", ["add", "to_delete.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "base"], {
    cwd: dir, stdio: "ignore",
  });
  const before = worktreeTreeOid(dir);
  rmSync(join(dir, "to_delete.ts"));
  const after = worktreeTreeOid(dir);
  assert.match(after, /^[0-9a-f]{40}$/, "must still produce a tree OID after a delete");
  assert.notEqual(after, before, "the deleted file must move the tree");
});

// ---------------------------------------------------------------------------
// incrementSinceTree — what changed since a recorded tree OID
// ---------------------------------------------------------------------------

test("incrementSinceTree: invalid baseTree returns undefined", () => {
  const dir = makeRepo();
  assert.equal(incrementSinceTree(dir, "not-a-tree"), undefined);
  assert.equal(incrementSinceTree(dir, ""), undefined);
  assert.equal(incrementSinceTree(dir, "--upload-pack=evil"), undefined);
});

test("incrementSinceTree: empty increment when baseTree matches current", () => {
  const dir = makeRepo();
  const tree = worktreeTreeOid(dir);
  const inc = incrementSinceTree(dir, tree);
  assert.ok(inc, "must return a result, not undefined");
  assert.deepEqual(inc!.files, []);
  assert.equal(inc!.lines, 0);
});

test("incrementSinceTree: detects new and modified files", () => {
  const dir = makeRepo();
  // Create a baseline commit so the tree is not empty.
  writeFileSync(join(dir, "existing.ts"), "// line 1\n// line 2\n");
  execFileSync("git", ["add", "existing.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "base"], {
    cwd: dir, stdio: "ignore",
  });
  const baseTree = worktreeTreeOid(dir);

  // Add a new file and modify the existing one.
  writeFileSync(join(dir, "new.ts"), "// new\n");
  writeFileSync(join(dir, "existing.ts"), "// line 1 changed\n// line 2\n// line 3\n");

  const inc = incrementSinceTree(dir, baseTree);
  assert.ok(inc, "must return a result");
  assert.ok(inc!.files.includes("new.ts"), "new file must be listed");
  assert.ok(inc!.files.includes("existing.ts"), "modified file must be listed");
  assert.ok(inc!.lines > 0, "must report changed lines");
});

test("incrementSinceTree: returns undefined outside a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-nogit-"));
  tempDirs.push(dir);
  assert.equal(incrementSinceTree(dir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), undefined);
});

test("incrementSinceTree: returns undefined when baseTree is a valid OID but not in this repo", () => {
  const dir = makeRepo();
  // A valid-looking OID that does not exist in this repo.
  assert.equal(incrementSinceTree(dir, "0000000000000000000000000000000000000000"), undefined);
});

test("incrementSinceTree: a deleted file is detected", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "to_delete.ts"), "// will be deleted\n");
  execFileSync("git", ["add", "to_delete.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "base"], {
    cwd: dir, stdio: "ignore",
  });
  const baseTree = worktreeTreeOid(dir);
  rmSync(join(dir, "to_delete.ts"));

  const inc = incrementSinceTree(dir, baseTree);
  assert.ok(inc, "must return a result");
  assert.ok(inc!.files.includes("to_delete.ts"), "deleted file must be listed");
});

test("incrementSinceTree: staging does not affect the increment", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "file.ts"), "// v1\n");
  execFileSync("git", ["add", "file.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "base"], {
    cwd: dir, stdio: "ignore",
  });
  const baseTree = worktreeTreeOid(dir);

  writeFileSync(join(dir, "file.ts"), "// v2\n");
  const unstagedInc = incrementSinceTree(dir, baseTree);
  execFileSync("git", ["add", "file.ts"], { cwd: dir, stdio: "ignore" });
  const stagedInc = incrementSinceTree(dir, baseTree);

  assert.ok(unstagedInc, "unstaged increment must be computable");
  assert.ok(stagedInc, "staged increment must be computable");
  assert.deepEqual(
    stagedInc!.files,
    unstagedInc!.files,
    "staging must not change the increment files",
  );
  assert.equal(
    stagedInc!.lines,
    unstagedInc!.lines,
    "staging must not change the increment line count",
  );
});

// ---------------------------------------------------------------------------
// reviewCoverageFiles — files covered by the current change
// ---------------------------------------------------------------------------

test("reviewCoverageFiles: returns files changed since the branch base", () => {
  const dir = makeRepo();
  // Create a commit on main.
  writeFileSync(join(dir, "base.ts"), "// base\n");
  execFileSync("git", ["add", "base.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "base"], {
    cwd: dir, stdio: "ignore",
  });

  // Branch off and make changes.
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "feature.ts"), "// feature\n");
  execFileSync("git", ["add", "feature.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "feature"], {
    cwd: dir, stdio: "ignore",
  });

  const files = reviewCoverageFiles(dir);
  assert.ok(files, "must return a list, not undefined");
  assert.ok(files!.includes("feature.ts"), "the committed feature file must be covered");
  // Also covers dirty worktree files.
  writeFileSync(join(dir, "dirty.ts"), "// dirty");
  const filesWithDirty = reviewCoverageFiles(dir);
  assert.ok(filesWithDirty, "must return a list with dirty files");
  assert.ok(filesWithDirty!.includes("dirty.ts"), "dirty untracked file must be covered");
});

test("reviewCoverageFiles: returns undefined outside a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-nogit-"));
  tempDirs.push(dir);
  assert.equal(reviewCoverageFiles(dir), undefined);
});

test("reviewCoverageFiles: returns undefined in a repo with no commits", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-nogit-"));
  tempDirs.push(dir);
  // init without an initial commit — no branch base to diff against.
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  assert.equal(reviewCoverageFiles(dir), undefined);
});

// ---------------------------------------------------------------------------
// FINGERPRINT_VERSION — the algorithm version baked into every binding
// ---------------------------------------------------------------------------

test("FINGERPRINT_VERSION is a positive integer", () => {
  assert.equal(typeof FINGERPRINT_VERSION, "number");
  assert.ok(Number.isSafeInteger(FINGERPRINT_VERSION));
  assert.ok(FINGERPRINT_VERSION >= 2, "must be at least 2 (v1 was pre-versioning)");
});
