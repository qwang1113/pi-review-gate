/**
 * Shared repo fixture for the fingerprint race suites (fingerprint-race*.test.ts,
 * 2026-09-08). Each race file spawns its own repos; this module owns the temp
 * bookkeeping so five parallel files do not each re-implement it. The hermetic
 * neutralisation call must still appear IN each test file's own code (the
 * hermetic-git guard requires it there).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const tempDirs: string[] = [];

/** Fresh git repo (one init + one empty commit), registered for cleanup. */
export function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-fp-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], {
    cwd: dir, stdio: "ignore",
  });
  return dir;
}

/** Remove every repo this process's suites created. */
export function cleanupRaceDirs(): void {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
}

/**
 * One group of racily-clean rounds (2026-09-08). The 300-round regression
 * runs as 4 parallel groups × 75 rounds, each in its own repo — see the
 * file-top note in fingerprint-race.test.ts for the window-sampling rationale
 * and the mutation evidence. The loop body lives HERE, once, so a future edit
 * to this P0 safety loop cannot silently leave stale copies behind in the
 * other three group files.
 *
 * `computeFingerprint` is the lib function under test (each test file imports
 * it and hands it in — helpers stay dependency-free). `label` names the group
 * in failure messages (e.g. "group 2/4"); the seed repo is created inside so
 * each group samples an independent window.
 */
export type FingerprintFn = (dir: string) => { unavailable: boolean; digest: string };

export function assertRacyCleanWindow(computeFingerprint: FingerprintFn, rounds: number, label: string): void {
  const dir = makeRepo();
  // Seed the stat baseline: content v0 staged, then the digest that a
  // size/mtime-trusting cache would wrongly reuse after a bare rewrite.
  writeFileSync(join(dir, "file.ts"), "// v0a");
  execFileSync("git", ["add", "file.ts"], { cwd: dir, stdio: "ignore" });
  const seed = computeFingerprint(dir);
  if (seed.unavailable) {
    throw new Error(`${label}: seed fingerprint unavailable`);
  }
  let previous = seed.digest;
  for (let i = 1; i <= rounds; i++) {
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
    if (fp.unavailable) {
      throw new Error(`${label} iteration ${i}: fingerprint unavailable`);
    }
    if (fp.digest === previous) {
      throw new Error(
        `${label} iteration ${i}: a real edit was invisible to the fingerprint ` +
        "(racily-clean fail-open) — the shadow index mtime must be backdated",
      );
    }
    previous = fp.digest;
    execFileSync("git", ["add", "file.ts"], { cwd: dir, stdio: "ignore" });
  }
}
