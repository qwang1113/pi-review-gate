import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { neutraliseHostGitConfig } from "./helpers/git.ts";
import { makeRepo, cleanupRaceDirs } from "./helpers/fingerprint-race.ts";

// Racily-clean regression — GROUP 3 OF 4 (75 rounds in its own repo). The
// full rationale (window timing, the rejected deterministic version, the
// round-cost optimization, and why 4 parallel groups × 75 rounds strengthen
// the single-repo 300-round shape) lives in test/fingerprint-race.test.ts's
// file-top note; the mutation evidence is recorded there too.
neutraliseHostGitConfig();

const {
  computeFingerprint,
} = await import(
  join(resolve(import.meta.dirname ?? "."), "..", "lib", "fingerprint.ts")
);

after(cleanupRaceDirs);

test("a same-size edit in the racy window is never invisible to the fingerprint (racily-clean, group 3/4)", () => {
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
    const content = i % 2 === 0 ? `// v${i % 10}a` : `// v${i % 10}b`;
    writeFileSync(join(dir, "file.ts"), content);
    const fp = computeFingerprint(dir);
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
