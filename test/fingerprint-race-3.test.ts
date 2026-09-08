import { test, after } from "node:test";
import { join, resolve } from "node:path";
import { neutraliseHostGitConfig } from "./helpers/git.ts";
import { cleanupRaceDirs, assertRacyCleanWindow } from "./helpers/fingerprint-race.ts";

// Racily-clean regression — GROUP 3 OF 4 (75 rounds in its own repo). The
// full rationale (window timing, the rejected deterministic version, the
// round-cost optimization, and why 4 parallel groups × 75 rounds strengthen
// the single-repo 300-round shape) lives in test/fingerprint-race.test.ts's
// file-top note, and the loop body lives ONCE in
// test/helpers/fingerprint-race.ts (assertRacyCleanWindow) — these group
// files only bind the shared loop to a group label.
neutraliseHostGitConfig();

const {
  computeFingerprint,
} = await import(
  join(resolve(import.meta.dirname ?? "."), "..", "lib", "fingerprint.ts")
);

after(cleanupRaceDirs);

test("a same-size edit in the racy window is never invisible to the fingerprint (racily-clean, group 3/4)", () => {
  assertRacyCleanWindow(computeFingerprint, 75, "group 3/4");
});
