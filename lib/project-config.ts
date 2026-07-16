/**
 * Per-project gate configuration — sd0x-dev-flow `auto-loop-project.md` port.
 *
 * sd0x-dev-flow lets a host project override auto-loop knobs (R6 max-rounds
 * override, R9 git-memory, R10 think-harder) via a markdown rule file parsed
 * by bash hooks. Here the same knobs live in ONE small JSON file that both the
 * extension and (future) hooks can read without a markdown parser:
 *
 *   .pi/review-gate.json
 *   {
 *     "maxRounds": 10,        // 3..50, R6 — loop hard cap for this project
 *     "thinkHarder": true,    // R10 — one-shot strategic-reset checklist near cap
 *     "gitMemory": false      // R9 — inject filtered git context after compaction
 *   }
 *
 * Fail-safe philosophy: a missing / corrupt / out-of-range config NEVER
 * loosens the gate — every field falls back to its default independently and
 * maxRounds is clamped to [MIN_MAX_ROUNDS, MAX_MAX_ROUNDS] so a forged
 * `"maxRounds": 100000` cannot turn the loop cap into "practically never".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MAX_ROUNDS } from "./constants.ts";

/** sd0x-dev-flow documents the same range: "Range: 3-50". */
export const MIN_MAX_ROUNDS = 3;
export const MAX_MAX_ROUNDS = 50;

export interface ProjectConfig {
  maxRounds: number;
  /** R10: inject the strategic-reset checklist once near the round cap. */
  thinkHarder: boolean;
  /** R9: append filtered git context to the post-compaction resume message. */
  gitMemory: boolean;
}

export function defaultProjectConfig(): ProjectConfig {
  return {
    maxRounds: DEFAULT_MAX_ROUNDS,
    // R10 defaults ON here (it is a pure text nudge, cannot loosen the gate).
    thinkHarder: true,
    // R9 defaults OFF (mirrors sd0x-dev-flow opt-in: commit messages might
    // contain text the user does not want re-injected into context).
    gitMemory: false,
  };
}

export function projectConfigPath(cwd: string, configDirName = ".pi"): string {
  return join(cwd, configDirName, "review-gate.json");
}

/**
 * Load the per-project config. Each field is validated independently; an
 * invalid field silently keeps its default (fail-safe, never fail-open).
 */
export function loadProjectConfig(cwd: string): ProjectConfig {
  const cfg = defaultProjectConfig();
  let raw: string;
  try {
    raw = readFileSync(projectConfigPath(cwd), "utf8");
  } catch {
    return cfg; // no config file — defaults
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return cfg; // corrupt JSON — defaults (the gate itself stays untouched)
  }
  if (typeof parsed !== "object" || parsed === null) return cfg;
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.maxRounds === "number" && Number.isInteger(obj.maxRounds)) {
    // Clamp instead of reject: 1 → 3 and 500 → 50, so a typo still yields a
    // sane cap rather than silently reverting to the default.
    cfg.maxRounds = Math.min(MAX_MAX_ROUNDS, Math.max(MIN_MAX_ROUNDS, obj.maxRounds));
  }
  if (typeof obj.thinkHarder === "boolean") cfg.thinkHarder = obj.thinkHarder;
  if (typeof obj.gitMemory === "boolean") cfg.gitMemory = obj.gitMemory;
  return cfg;
}
