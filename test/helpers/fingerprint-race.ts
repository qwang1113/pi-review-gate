/**
 * Shared repo fixture for the fingerprint race suites (fingerprint-race*.test.ts,
 * 2026-09-08). Each race file spawns its own repos; this module owns the temp
 * bookkeeping so five parallel files do not each re-implement it. The hermetic
 * neutralisation call must still appear IN each test file's own code (the
 * hermetic-git guard requires it there).
 */
import { mkdtempSync, rmSync } from "node:fs";
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
