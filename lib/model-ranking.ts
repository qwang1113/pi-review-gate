/**
 * pi-review-gate — model-capability ranking for adviser/reviewer selection.
 *
 * WHY: adviser and reviewer are only as good as the model behind them. The
 * stronger the reasoning model, the better the judgement — so we want to pick
 * the highest-capability models available. But "pick the single strongest" is
 * the wrong objective: if the adviser/reviewer share the SAME model family as
 * the main agent, they share its blind spots. The right objective is
 * **capability × cross-family diversity**.
 *
 * SCOPE: this is a DECISION AID, not a runtime selector. The adviser/reviewer
 * models are PINNED in their agent frontmatter (agents/adviser.md,
 * agents/reviewer.md) — chosen up front, not re-selected per task. `rankJudges`
 * exists so a human (or the installer) can see which locally-available models
 * are the strongest cross-family judges and pin accordingly.
 *
 * This module is intentionally NETWORK-FREE. The review-gate extension is
 * fail-closed and forbidden from doing network I/O (see README "no network
 * fetch"). Live leaderboard data is fetched by the OPT-IN, gate-external
 * `scripts/fetch-leaderboard.mjs`, which only rewrites the SNAPSHOT below.
 * Ranking is a pure function over that snapshot.
 *
 * Score scale: 0–100 "capability index", normalized from public leaderboards
 * (Artificial Analysis Intelligence Index, LMArena Elo percentile, LiveBench).
 * These are FAMILY-level scores, because the local gateway model ids
 * (e.g. `deepseek-v4-pro`, `gpt-5.6-sol`) are private and do not appear on any
 * public leaderboard — only their family does.
 */

export type ModelFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "deepseek"
  | "zhipu" // GLM
  | "moonshot" // Kimi
  | "minimax"
  | "qwen"
  | "meta"
  | "mistral"
  | "xai" // Grok
  | "unknown";

export interface FamilyCapability {
  family: ModelFamily;
  /** 0–100 capability index (higher = stronger judge). */
  score: number;
  /** True for open-weight / open-source-license families. */
  openWeight: boolean;
  /** Human-readable source of the score for auditability. */
  source: string;
}

/**
 * Offline capability snapshot. Refresh via `scripts/fetch-leaderboard.mjs`.
 * Ordering is not significant; selection sorts by score.
 *
 * NOTE: values are a normalized blend of public leaderboards as of the
 * snapshot date. They are deliberately coarse (family granularity) and only
 * used to RANK candidates relative to each other — not as absolute truth.
 */
export const SNAPSHOT_DATE = "2026-07-16";

export const FAMILY_CAPABILITY: readonly FamilyCapability[] = Object.freeze([
  { family: "anthropic", score: 93, openWeight: false, source: "artificial-analysis+lmarena" },
  { family: "openai", score: 92, openWeight: false, source: "artificial-analysis+lmarena" },
  { family: "google", score: 90, openWeight: false, source: "artificial-analysis+lmarena" },
  { family: "deepseek", score: 88, openWeight: true, source: "artificial-analysis+livebench" },
  { family: "moonshot", score: 85, openWeight: true, source: "artificial-analysis+lmarena" }, // Kimi
  { family: "zhipu", score: 84, openWeight: true, source: "artificial-analysis+lmarena" }, // GLM
  { family: "qwen", score: 84, openWeight: true, source: "artificial-analysis+livebench" },
  { family: "minimax", score: 80, openWeight: true, source: "artificial-analysis" },
  { family: "meta", score: 78, openWeight: true, source: "livebench" }, // Llama
  { family: "mistral", score: 76, openWeight: true, source: "livebench" },
  { family: "xai", score: 86, openWeight: false, source: "artificial-analysis+lmarena" }, // Grok
]);

const CAP_BY_FAMILY: ReadonlyMap<ModelFamily, FamilyCapability> = new Map(
  FAMILY_CAPABILITY.map((c) => [c.family, c]),
);

/**
 * Map a model id (local gateway id OR provider/id) to its family.
 * Matching is substring-based and order-sensitive: more specific vendor tokens
 * are checked first so `gpt-5.6-sol` → openai, `glm-5.2` → zhipu, etc.
 */
export function familyOf(modelId: string): ModelFamily {
  const id = modelId.toLowerCase();
  // Distinctive, collision-free vendor tokens FIRST. These are unambiguous, so
  // a codename like `...-terra` on one of these vendors can never be misread as
  // OpenAI (the generic-codename branch is only reached if none of these hit).
  if (/deepseek/.test(id)) return "deepseek";
  if (/(glm|zhipu|chatglm)/.test(id)) return "zhipu";
  if (/(kimi|moonshot)/.test(id)) return "moonshot";
  if (/minimax/.test(id)) return "minimax";
  if (/qwen/.test(id)) return "qwen";
  if (/(llama|meta-)/.test(id)) return "meta";
  if (/(mistral|mixtral|codestral)/.test(id)) return "mistral";
  if (/(grok|xai)/.test(id)) return "xai";
  if (/(gemini|palm|bard|google)/.test(id)) return "google";
  if (/(claude|opus|sonnet|haiku|fable|anthropic)/.test(id)) return "anthropic";
  // OpenAI: strong tokens, then o-series and product codenames ANCHORED to a
  // token boundary so bare substrings can't false-match (e.g. `o4` only as a
  // standalone token, `sol/luna/terra` only as a hyphen-delimited suffix).
  if (/(gpt|codex|openai)/.test(id)) return "openai";
  if (/(^|[-_/\s])o[1-9]([-_/\s]|$)/.test(id)) return "openai";
  if (/(^|[-_/\s])(sol|luna|terra)([-_/\s]|$)/.test(id)) return "openai";
  return "unknown";
}

export function capabilityOf(modelId: string): number {
  const cap = CAP_BY_FAMILY.get(familyOf(modelId));
  return cap ? cap.score : 0;
}

export interface Candidate {
  /** Model id as it appears in the local registry (e.g. "deepseek-v4-pro"). */
  id: string;
  family: ModelFamily;
  score: number;
  openWeight: boolean;
}

export interface SelectionOptions {
  /** The main agent's model id, so we can prefer a DIFFERENT family. */
  mainModelId: string;
  /** Candidate model ids available in the local registry. */
  available: readonly string[];
  /**
   * Weight of cross-family diversity vs. raw capability, 0..1.
   * 0   = pick the single strongest model regardless of family overlap.
   * 1   = only reward being a different family (still tie-broken by score).
   * Default 0.35: capability dominates, but a strong different-family model
   * beats a marginally stronger same-family one.
   */
  diversityWeight?: number;
}

export interface SelectionResult {
  /** Ranked best-first. */
  ranked: Candidate[];
  /** Convenience: the top pick (or undefined if no candidates). */
  best?: Candidate;
  mainFamily: ModelFamily;
  diversityWeight: number;
}

/**
 * Rank candidate models for an adviser/reviewer role.
 *
 * Effective score = capability + diversityWeight * DIVERSITY_BONUS when the
 * candidate is a DIFFERENT family than the main agent. This encodes the core
 * judgement principle: a strong model from a different family is a better
 * independent judge than a marginally stronger model that shares the main
 * agent's blind spots.
 */
export function rankJudges(opts: SelectionOptions): SelectionResult {
  const diversityWeight = clamp01(opts.diversityWeight ?? 0.35);
  const mainFamily = familyOf(opts.mainModelId);
  const DIVERSITY_BONUS = 30; // max points a full cross-family match can add

  const seen = new Set<string>();
  const ranked = opts.available
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((id): Candidate & { effective: number } => {
      const family = familyOf(id);
      const cap = CAP_BY_FAMILY.get(family);
      const score = cap ? cap.score : 0;
      const openWeight = cap ? cap.openWeight : false;
      const different = family !== mainFamily && family !== "unknown";
      const effective = score + (different ? diversityWeight * DIVERSITY_BONUS : 0);
      return { id, family, score, openWeight, effective };
    })
    .sort((a, b) => {
      if (b.effective !== a.effective) return b.effective - a.effective;
      if (b.score !== a.score) return b.score - a.score; // tie-break on raw capability
      return a.id.localeCompare(b.id); // stable, deterministic
    })
    .map(({ effective: _effective, ...c }) => c);

  return { ranked, best: ranked[0], mainFamily, diversityWeight };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
