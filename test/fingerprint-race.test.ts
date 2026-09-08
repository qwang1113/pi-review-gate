import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { neutraliseHostGitConfig } from "./helpers/git.ts";

// These stat-cache race regressions each carry a long timing loop and were
// split out of test/fingerprint.test.ts (2026-09-08) so the loops run in
// their own file while node --test parallelizes the remaining fingerprint
// suites. The loops themselves are NOT parallelizable and NOT reducible —
// see the note below.

neutraliseHostGitConfig();

const {
  computeFingerprint,
} = await import(
  join(resolve(import.meta.dirname ?? "."), "..", "lib", "fingerprint.ts")
);

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
 * cheaper rather than to run fewer of them, and to prove the new
 * construction still fails reliably against the mutated implementation
 * before adopting it. Adopted 2026-09-08: the 300-round loop now pays one
 * `git add` + one fingerprint per round instead of add + commit + two
 * fingerprints, with the bare-rewrite window preserved — mutation-verified
 * (see the racily-clean test below) before the change landed.
 *
 * Coverage note, so the next reader does not over-trust these loops: they only
 * fail when BOTH safeguards are gone. Removing just `--renormalize` is caught
 * deterministically by "an edit to a file with an ancient preserved mtime is
 * not invisible"; removing just the backdate is caught by NEITHER, because
 * `--renormalize` re-reads content unconditionally, which makes the backdate a
 * deliberate redundant second line of defence.
 */

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
//
// ROUND-COST OPTIMIZATION (2026-09-08, mutation-verified before adopting —
// the prove-before-adopt the rejected-test note above demands). Each round
// used to pay one `git commit` + TWO fingerprints (before/after pair). The
// commit turned out to be incidental: the racy window is opened by `git add`
// recording the content's stat, not by HEAD moving (the fingerprint never
// reads HEAD), and the before-fingerprint merely re-baselined a stat that the
// previous round's add had already recorded. The new round is: bare rewrite
// (lands in the window the previous add opened) -> fingerprint (must see the
// rewrite) -> add (re-baselines for the next round) — one add + one
// fingerprint per round. Mutation evidence on this machine (14 cores, load
// ~3): with both safeguards removed, the old loop failed within 25s and the
// new loop fails at iteration ~93 of 300 (8s) — the rewrite is still
// detected, so the loop still asserts something. With safeguards intact both
// loops pass all 300 rounds. Same repo, same window, same 300 rounds — only
// the per-round cost dropped (~62s -> ~29s measured, same load).
test("a same-size edit in the racy window is never invisible to the fingerprint (racily-clean)", () => {
  // ONE repo, reused: the race lives in the (index mtime vs file mtime)
  // relationship, which is re-established by every add, so repeated
  // edit+stage cycles in a single repo probe the same window far more
  // cheaply than building 300 repos. Mutation-verified to still catch the
  // bug (reintroducing it fails this test well before the loop ends).
  const ITERATIONS = 300;
  const dir = makeRepo();
  // Seed the stat baseline: content v0 staged, then the digest that a
  // size/mtime-trusting cache would wrongly reuse after a bare rewrite.
  writeFileSync(join(dir, "file.ts"), "// v0a");
  execFileSync("git", ["add", "file.ts"], { cwd: dir, stdio: "ignore" });
  const seed = computeFingerprint(dir);
  assert.equal(seed.unavailable, false, "seed fingerprint unavailable");
  let previous = seed.digest;
  for (let i = 1; i < ITERATIONS; i++) {
    // Alternate between two SAME-SIZE contents so each write is a real change
    // that a size/mtime-trusting stat cache would miss. Written immediately
    // after the previous round's add -> lands in the racy window where the
    // index mtime and the file mtime share a bucket (no commit needed: the
    // add below already recorded this round's content for the NEXT rewrite).
    const content = i % 2 === 0 ? `// v${i % 10}a` : `// v${i % 10}b`;
    writeFileSync(join(dir, "file.ts"), content);
    const fp = computeFingerprint(dir);
    // Assert availability FIRST and separately. Two "__UNAVAILABLE__" results
    // compare equal, so folding this into the notEqual below would report a
    // spurious fail-closed as a fail-open and send the next reader chasing the
    // wrong bug (it did exactly that once).
    assert.equal(fp.unavailable, false, `iteration ${i}: fingerprint unavailable`);
    assert.notEqual(
      fp.digest,
      previous,
      `iteration ${i}: a real edit was invisible to the fingerprint (racily-clean fail-open) — ` +
        "the shadow index mtime must be backdated",
    );
    previous = fp.digest;
    execFileSync("git", ["add", "file.ts"], { cwd: dir, stdio: "ignore" });
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
