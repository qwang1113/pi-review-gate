/**
 * Git memory (sd0x-dev-flow R9 port) — after context compaction, re-inject a
 * small, filtered snapshot of git state so the model can recover its working
 * context without re-exploring the repo.
 *
 * Default ON; disable via .pi/review-gate.json `"gitMemory": false`
 * (see project-config.ts).
 *
 * Safety properties mirrored from the sd0x-dev-flow hook, hardened:
 *  - basic secret-pattern line filtering (.env/.pem/.key/.secret/credential/
 *    token) — NOT a comprehensive scanner; disable the knob for repos where
 *    git output must never re-enter context;
 *  - hard 40-line output cap;
 *  - read-only `git` invocations via execFileSync argv (no shell, unlike the
 *    original's `eval "$_FILTER"` pipeline);
 *  - any git failure → empty string (this is a convenience, never a gate).
 */

import { execFileSync } from "node:child_process";

/** Lines matching any of these never enter the injected context. */
const SECRET_LINE = /\.(env|pem|key|secret)\b|credential|token/i;

export const GIT_MEMORY_MAX_LINES = 40;

function gitLines(cwd: string, args: string[], cap: number): string[] {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .filter((l) => l.trim().length > 0 && !SECRET_LINE.test(l))
      .slice(0, cap);
  } catch {
    return [];
  }
}

/**
 * Assemble the `[GIT_CONTEXT]` block from pre-fetched section lines. Pure and
 * directly unit-testable at the cap boundary (reviewer P2: the git-backed test
 * could never reach 40+ lines because each git source is pre-capped).
 * TOTAL output (header included) is capped at GIT_MEMORY_MAX_LINES lines.
 */
export function assembleGitMemory(
  commits: string[],
  diffStat: string[],
  status: string[],
): string {
  const sections: string[] = [];
  if (commits.length) sections.push("Recent commits:", ...commits);
  if (diffStat.length) sections.push("Uncommitted changes:", ...diffStat);
  if (status.length) sections.push("Working tree:", ...status);
  if (sections.length === 0) return "";
  return ["[GIT_CONTEXT]", ...sections].slice(0, GIT_MEMORY_MAX_LINES).join("\n");
}

/**
 * Build the `[GIT_CONTEXT]` block, or "" when there is nothing to show / git
 * is unavailable.
 */
export function buildGitMemory(cwd: string): string {
  return assembleGitMemory(
    gitLines(cwd, ["log", "--oneline", "--no-merges", "-5"], 10),
    gitLines(cwd, ["diff", "--stat"], 15),
    gitLines(cwd, ["status", "--short"], 15),
  );
}
