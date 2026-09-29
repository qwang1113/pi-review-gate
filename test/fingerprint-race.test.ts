import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { neutraliseHostGitConfig } from "./helpers/git.ts";
import { makeRepo, cleanupRaceDirs } from "./helpers/fingerprint-race.ts";

// The racily-clean fail-open (a same-size edit invisible to the digest) has two
// safeguards in lib/fingerprint.ts: the shadow index is BACKDATED (clamped to
// now) and `git add --renormalize` re-reads content. Both are pinned here
// deterministically. The 4 × 75-round timing loop that used to live here was
// deleted on 2026-09-29 (user decision): it failed only when BOTH safeguards
// were gone, which already fails the ancient-mtime test below — ~78 CPU-seconds
// per full run for no extra mutation coverage. README §「How the fingerprint race
// regressions are covered」 records what NOT to re-attempt.

neutraliseHostGitConfig();

const {
  computeFingerprint,
} = await import(
  join(resolve(import.meta.dirname ?? "."), "..", "lib", "fingerprint.ts")
);

after(cleanupRaceDirs);

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
