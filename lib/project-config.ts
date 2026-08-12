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
 *     "gitMemory": true,      // R9 — inject filtered git context after compaction
 *     "docSync": true,        // default on — code changes require a reviewer code↔doc attestation
 *     "llmGuards": {            // LLM (DeepSeek V4 Flash) semantic guard layer
 *       "model": "deepseek/deepseek-v4-flash",
 *       "aiAttribution": true,  // guard #2 — commit-msg AI attribution (regex fallback stays)
 *       "englishCheck": true,   // L5 blind spot — romanized non-English in commit/PR text
 *       "shipDetect": true      // guard #4 — extra ship-command layer on suspicious bash
 *     },
 *     "copilotReview": {        // L7 — post-PR Copilot code-review loop
 *       "enabled": true,
 *       "owners": ["onekeyhq"]  // owners assumed to have Copilot code review
 *     }
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

/**
 * LLM guard layer knobs. Every flag only controls an ADDITIVE semantic check
 * (tighten-only by construction — see lib/llm-classify.ts invariants), so a
 * missing/corrupt block falls back to defaults without weakening any
 * deterministic gate.
 */
export interface LlmGuardsConfig {
  /** "provider/model" id. Fixed default: DeepSeek V4 Flash. */
  model: string;
  /** Guard #2: commit-message AI-attribution semantic check. */
  aiAttribution: boolean;
  /** L5/L6 blind spot: romanized non-English detection in commit/PR text. */
  englishCheck: boolean;
  /** Guard #4: additional ship-command layer for suspicious bash commands. */
  shipDetect: boolean;
}

export function defaultLlmGuardsConfig(): LlmGuardsConfig {
  return {
    model: "deepseek/deepseek-v4-flash",
    // All ON by default: each check is tighten-only and fail-back, so the
    // worst case of an unreachable model is exactly the pre-LLM behavior.
    aiAttribution: true,
    englishCheck: true,
    shipDetect: true,
  };
}

/**
 * Arbitration knobs (lib/arbitration.ts). The arbiter is a NARROW, fail-closed
 * capability exception: when a gate block is genuinely circular the agent may
 * contest it and an independent arbiter may grant a single-use bypass of ONE
 * `gh pr edit` (title/body only). Never bypasses commit/push/pr-create.
 */
export interface ArbiterConfig {
  /** Master switch. When false, request_arbitration always denies (GATE_WINS). */
  enabled: boolean;
  /** "provider/model" id for the independent arbiter spawn (a strong model). */
  model: string;
  /** Per-session hard cap on arbitration requests. */
  maxPerSession: number;
}

/** Default arbiter model — a top-tier reasoning model, matching agents/arbiter.md. */
export const DEFAULT_ARBITER_MODEL = "onekey/gpt-5.6-sol";

export function defaultArbiterConfig(): ArbiterConfig {
  return { enabled: true, model: DEFAULT_ARBITER_MODEL, maxPerSession: 3 };
}

/**
 * L7 knobs — the post-PR Copilot code-review loop (lib/copilot-review.ts).
 *
 * There is deliberately no round cap here any more: a cap could only ever end
 * a task with the reviewer's comments unhandled, which is the opposite of what
 * this layer is for. The single remaining bound is the wait timeout in
 * lib/copilot-review.ts, which fires only when there is no feedback at all.
 */
export interface CopilotReviewConfig {
  /** Master switch. When false, no PR ship ever arms a Copilot cycle. */
  enabled: boolean;
  /**
   * Repository owners whose repos are ASSUMED to have Copilot code review,
   * lowercased.
   *
   * Needed because GitHub publishes no way to ask whether Copilot code review
   * is available: every request surface reports success even when the request
   * is silently dropped. Evidence (a past Copilot review in the repo) is
   * preferred and needs no configuration; this list only covers the cold
   * start, where a repo that DOES support Copilot has simply never been asked
   * — without it, the first PR in such a repo would be released as
   * UNSUPPORTED instead of waiting for the review.
   */
  owners: string[];
}

/**
 * Owners assumed to have Copilot code review out of the box.
 *
 * This is the project author's own organisation: a personal, local-first tool
 * ships the default that is right for its user, and any other org is one
 * `.pi/review-gate.json` line away. Anything not listed still gets the full
 * treatment as soon as one real Copilot review exists in the repository.
 */
export const DEFAULT_COPILOT_OWNERS = ["onekeyhq"];

export function defaultCopilotReviewConfig(): CopilotReviewConfig {
  // Default ON (user policy: features ship enabled). A repo without gh, a
  // GitHub remote, a PR, or Copilot code review resolves to UNSUPPORTED on
  // the first check and stops asking — so "on" costs nothing where the
  // feature does not exist.
  return {
    enabled: true,
    owners: [...DEFAULT_COPILOT_OWNERS],
  };
}

// --------------------------------------------------------------------------
// precommit step configuration (`.pi/review-gate.json` → `precommit`)
//
// Lets a project override which commands the precommit runner executes for
// fast/full lanes. Each step may be:
//   - omitted           → default detection (package.json script priority table)
//   - null              → explicitly skipped
//   - "script-name"     → shorthand for { "script": "script-name" }
//   - { "script" }      → run `<pm> <script>` (must exist in package.json)
//   - { "command" }     → raw shell command, run as-is (works without package.json)
//   - { "skip": true }  → explicitly skipped
// `narrow` is only meaningful on the FAST test lane (see scripts/precommit-config.mjs).
// When `command` and `script` are both present, `command` wins.
// --------------------------------------------------------------------------

export interface PrecommitStepConfig {
  /** package.json script name to run (resolved like the default detection). */
  script?: string;
  /** Raw shell command — takes precedence over `script`. */
  command?: string;
  /** Explicitly skip this check. */
  skip?: boolean;
  /** Fast test lane only: narrow to related tests (default: try, fall back to full). */
  narrow?: boolean;
}

/** Per-lane test configuration; a missing lane falls back to default detection. */
export interface PrecommitTestConfig {
  fast?: PrecommitStepConfig | null;
  full?: PrecommitStepConfig | null;
}

/**
 * A project's precommit step overrides. `null` (the default) means "no
 * project configuration — run the default detection logic" for the whole
 * section; an individual step being absent means "default for that step".
 */
export interface PrecommitConfig {
  lint?: PrecommitStepConfig | null;
  typecheck?: PrecommitStepConfig | null;
  build?: PrecommitStepConfig | null;
  test?: PrecommitTestConfig | PrecommitStepConfig | null;
}

export function parsePrecommitStep(value: unknown): PrecommitStepConfig | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") {
    const s = value.trim();
    return s ? { script: s } : undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (o.skip === true) return { skip: true }; // skip wins over any command
  const out: PrecommitStepConfig = {};
  if (typeof o.command === "string" && o.command.trim()) out.command = o.command;
  else if (typeof o.script === "string" && o.script.trim()) out.script = o.script;
  if (typeof o.narrow === "boolean") out.narrow = o.narrow;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parsePrecommitConfig(raw: Record<string, unknown>): PrecommitConfig {
  const cfg: PrecommitConfig = {};
  for (const key of ["lint", "typecheck", "build"] as const) {
    const step = parsePrecommitStep(raw[key]);
    if (step !== undefined) cfg[key] = step;
  }
  const test = raw.test;
  if (test !== undefined) {
    const isLanes =
      typeof test === "object" && test !== null && !Array.isArray(test) &&
      ((test as Record<string, unknown>).fast !== undefined || (test as Record<string, unknown>).full !== undefined);
    if (isLanes) {
      const lanes: PrecommitTestConfig = {};
      const fast = parsePrecommitStep((test as Record<string, unknown>).fast);
      const full = parsePrecommitStep((test as Record<string, unknown>).full);
      if (fast !== undefined) lanes.fast = fast;
      if (full !== undefined) lanes.full = full;
      if (Object.keys(lanes).length > 0) cfg.test = lanes;
    } else {
      const step = parsePrecommitStep(test);
      if (step !== undefined) cfg.test = step;
    }
  }
  return cfg;
}

export interface ProjectConfig {
  maxRounds: number;
  /** R10: inject the strategic-reset checklist once near the round cap. */
  thinkHarder: boolean;
  /** R9: append filtered git context to the post-compaction resume message. */
  gitMemory: boolean;
  /**
   * Code↔doc sync enforcement (default ON): a code change requires the READY
   * review to carry a docSync attestation (UPDATED | NOT_NEEDED) — see
   * lib/gate-state.ts unmetRequirements. "Docs" means the project's
   * requirement / plan / feature documentation (docs/, README, …), NOT agent
   * memory files (CLAUDE.md, AGENTS.md, progress.md). Set `"docSync": false` in
   * .pi/review-gate.json to disable for a project.
   */
  docSync: boolean;
  /** LLM semantic guard layer (DeepSeek V4 Flash) — see LlmGuardsConfig. */
  llmGuards: LlmGuardsConfig;
  /** Arbiter capability-exception config — see ArbiterConfig. */
  arbiter: ArbiterConfig;
  /** L7 post-PR Copilot review loop — see CopilotReviewConfig. */
  copilotReview: CopilotReviewConfig;
  /**
   * Precommit step overrides — see PrecommitConfig. `null` (default) means
   * the runner uses its default detection (package.json scripts / ecosystem
   * fallback) unchanged.
   */
  precommit: PrecommitConfig | null;
}

export function defaultProjectConfig(): ProjectConfig {
  return {
    maxRounds: DEFAULT_MAX_ROUNDS,
    // R10 defaults ON here (it is a pure text nudge, cannot loosen the gate).
    thinkHarder: true,
    // R9 default ON (user policy: features ship enabled). The snapshot is
    // secret-line-filtered and 40-line capped; disable per project with
    // `"gitMemory": false` if git output must never re-enter context.
    gitMemory: true,
    // Default ON: every code change needs an explicit reviewer attestation
    // (UPDATED | NOT_NEEDED); NOT_NEEDED keeps small fixes low-friction.
    docSync: true,
    llmGuards: defaultLlmGuardsConfig(),
    arbiter: defaultArbiterConfig(),
    copilotReview: defaultCopilotReviewConfig(),
    precommit: null,
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
  if (typeof obj.docSync === "boolean") cfg.docSync = obj.docSync;
  if (typeof obj.llmGuards === "object" && obj.llmGuards !== null && !Array.isArray(obj.llmGuards)) {
    const lg = obj.llmGuards as Record<string, unknown>;
    // Field-independent validation, same fail-safe style as the other knobs.
    // model must be "provider/id" — anything else keeps the fixed default.
    if (typeof lg.model === "string" && /^[^\/\s]+\/[^\s]+$/.test(lg.model)) {
      cfg.llmGuards.model = lg.model;
    }
    // (An old config's "taskMode" key is simply ignored — the task-mode
    // decision moved in-session; see lib/task-mode.ts.)
    if (typeof lg.aiAttribution === "boolean") cfg.llmGuards.aiAttribution = lg.aiAttribution;
    if (typeof lg.englishCheck === "boolean") cfg.llmGuards.englishCheck = lg.englishCheck;
    if (typeof lg.shipDetect === "boolean") cfg.llmGuards.shipDetect = lg.shipDetect;
  }
  if (typeof obj.arbiter === "object" && obj.arbiter !== null && !Array.isArray(obj.arbiter)) {
    const ab = obj.arbiter as Record<string, unknown>;
    if (typeof ab.enabled === "boolean") cfg.arbiter.enabled = ab.enabled;
    if (typeof ab.model === "string" && /^[^\/\s]+\/[^\s]+$/.test(ab.model)) cfg.arbiter.model = ab.model;
    if (typeof ab.maxPerSession === "number" && Number.isInteger(ab.maxPerSession)) {
      // Clamp to a sane range so a forged huge value can't make re-rolling free.
      cfg.arbiter.maxPerSession = Math.min(10, Math.max(1, ab.maxPerSession));
    }
  }
  if (typeof obj.precommit === "object" && obj.precommit !== null && !Array.isArray(obj.precommit)) {
    const pc = parsePrecommitConfig(obj.precommit as Record<string, unknown>);
    if (Object.keys(pc).length > 0) cfg.precommit = pc;
  }
  if (typeof obj.copilotReview === "object" && obj.copilotReview !== null && !Array.isArray(obj.copilotReview)) {
    const cr = obj.copilotReview as Record<string, unknown>;
    if (typeof cr.enabled === "boolean") cfg.copilotReview.enabled = cr.enabled;
    // `maxRounds` is intentionally NOT read any more. A project that still
    // carries the old key keeps its config valid — the key is simply inert,
    // because no number of rounds is a reason to abandon review comments.
    if (Array.isArray(cr.owners)) {
      // REPLACES the default rather than extending it: a project that lists
      // owners is stating its own policy, and silently keeping someone else's
      // organisation in the list would be surprising. An array of only junk
      // yields an empty list — i.e. "evidence only", which is the safe end.
      cfg.copilotReview.owners = cr.owners
        .filter((o): o is string => typeof o === "string")
        .map((o) => o.trim().toLowerCase())
        .filter((o) => o.length > 0);
    }
  }
  return cfg;
}
