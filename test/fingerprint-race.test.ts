import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { neutraliseHostGitConfig } from "./helpers/git.ts";
import { makeRepo, cleanupRaceDirs } from "./helpers/fingerprint-race.ts";

// These stat-cache race regressions each carry a long timing loop and were
// split out of test/fingerprint.test.ts (2026-09-08) so the loops run in
// their own file while node --test parallelizes the remaining fingerprint
// suites.
//
// SPLIT INTO PARALLEL GROUPS (2026-09-08, same day): the 300-round racily-clean
// loop is now 4 groups × 75 rounds, each in its OWN repo, spread over
// fingerprint-race.test.ts (group 1) + fingerprint-race-2/3/4.test.ts. The
// tracked-but-gitignored loop lives in fingerprint-race-gitignore.test.ts.
// See the note below for why the split is a STRENGTHENING, not a reduction.

neutraliseHostGitConfig();

const {
  computeFingerprint,
} = await import(
  join(resolve(import.meta.dirname ?? "."), "..", "lib", "fingerprint.ts")
);

after(cleanupRaceDirs);

/**
 * WHY THE RACE LOOPS ARE SHAPED THE WAY THEY ARE (history + 2026-09-08
 * decision).
 *
 * Historical: an env-scaled `RG_RACE_ITERS` (25 for a commit-time fast path)
 * was implemented and REMOVED. Against a mutated implementation (shadow-index
 * backdate AND `--renormalize` both removed) the loop missed the edit in
 * 83/100 rounds; but an independent reviewer reproduced that experiment and
 * at 25 rounds the mutated implementation PASSED 3 of 5 runs. The rounds are
 * not independent trials — they share one repository, and the window depends
 * on filesystem timestamp granularity, machine load and pacing — so a
 * per-round rate measured once cannot be exponentiated into a guarantee. The
 * knob was removed: a safety loop whose strength cannot be stated honestly
 * should not be reducible by an environment variable.
 *
 * The sound route was to make each ROUND cheaper, not to run fewer of them,
 * and to prove the new construction still fails reliably against the mutated
 * implementation before adopting it. Adopted first: one `git add` + one
 * fingerprint per round instead of add + commit + two fingerprints
 * (62s -> 29s, mutation-verified). The 300 rounds stayed in ONE repo.
 *
 * 2026-09-08 SECOND MEASUREMENT (why one-repo-300 gave way to 4×75): 12 runs
 * against the mutated implementation showed the single-repo loop misses the
 * window ENTIRELY in 2 of 12 runs (17%) — the window is a repo/timing-level
 * event whose arrival is not guaranteed within any round budget, so the late
 * rounds of a windowless run are pure waiting. Splitting the 300 rounds over
 * FOUR independent repos samples four windows instead of waiting for one:
 * full-suite-form mutation runs (node --test, ~70 files concurrent, ×3) were
 * caught by EVERY group in every run (~iteration 16-30), versus 10/12 for the
 * single-repo shape — and the groups run in parallel (~8s vs 29s). Guards
 * intact, all groups pass all rounds (7/7). Same 300 rounds, same per-round
 * semantics; only the window sampling changed (1 repo -> 4), which is a
 * strengthening of what the loop asserts, not a reduction of it.
 *
 * Coverage note, so the next reader does not over-trust these loops: they only
 * fail when BOTH safeguards are gone. Removing just `--renormalize` is caught
 * deterministically by "an edit to a file with an ancient preserved mtime is
 * not invisible"; removing just the backdate is caught by NEITHER, because
 * `--renormalize` re-reads content unconditionally, which makes the backdate a
 * deliberate redundant second line of defence. The 4×75 groups are the ONLY
 * probabilistic guard for a backdate regression.
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

// P0 RACE REGRESSION (git "racily clean") — GROUP 1 OF 4 (75 rounds).
// The shadow index is seeded from the real index for speed. copyFileSync
// stamps the copy with a NEW mtime, which suppressed git's racily-clean
// re-hash: an edit landing in the same mtime granularity bucket as the index,
// with the size unchanged, was INVISIBLE to the digest -> a stale READY
// binding stayed valid across a real code change (the worst failure mode this
// gate has). The loop exists because the window is a TIMING property, not a
// constructible one: an attempt to force it deterministically (restore the
// cached stat after a same-size rewrite) provably asserts nothing, because
// ctime and sub-second mtime still move and git re-hashes on its own — see the
// rejected-test note above. (Historically: 25/1500 fail-opens before the
// original fix, 0/1500 after.)
//
// Shape matters: same-size content (`// v1` -> `// v2`) written IMMEDIATELY
// after staging is what lands in the racy window.
//
// ROUND-COST OPTIMIZATION (2026-09-08, mutation-verified before adopting):
// the racy window is opened by `git add` recording the content's stat, not by
// HEAD moving; the round is bare rewrite -> fingerprint (must see it) -> add
// (re-baselines for the next round) — one add + one fingerprint, no commit.
// See the file-top note for the 4×75 group split and its mutation evidence.
test("a same-size edit in the racy window is never invisible to the fingerprint (racily-clean, group 1/4)", () => {
  // ONE repo per GROUP, reused within the group: the race lives in the (index
  // mtime vs file mtime) relationship, re-established by every add; repeated
  // edit+stage cycles in a single repo probe the window cheaply. Four groups
  // in parallel each probe their own repo = four window samples.
  const ITERATIONS = 75;
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
