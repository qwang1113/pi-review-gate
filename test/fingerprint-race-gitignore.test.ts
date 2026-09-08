import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { neutraliseHostGitConfig } from "./helpers/git.ts";
import { makeRepo, cleanupRaceDirs } from "./helpers/fingerprint-race.ts";

// P0 REGRESSION (found by independent review, then root-caused): a file that
// matches .gitignore but is nonetheless TRACKED (`git add -f`) is real,
// shippable content — `git commit -a` will commit changes to it. Two distinct
// bugs made such edits invisible to the digest:
//   1. `git add` refuses to stage an ignored path, so an EMPTY shadow index
//      drops the file from the tree entirely; only a SEEDED index keeps it.
//   2. an over-eager mtime-verification fallback deleted the seeded index on
//      ~57% of runs (utimesSync loses sub-ms precision), silently producing
//      case 1.
// Net effect was a ~50% fail-open on shippable content.
//
// Split into its own file (2026-09-08) so its 25 repo-building rounds run in
// parallel with the racily-clean groups instead of serially after them.
neutraliseHostGitConfig();

const {
  computeFingerprint,
} = await import(
  join(resolve(import.meta.dirname ?? "."), "..", "lib", "fingerprint.ts")
);

after(cleanupRaceDirs);

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
