/**
 * Review fan-out planning — decide BEFORE dispatch whether this environment
 * can actually run the cross-family double review, or whether a single
 * reviewer is the honest (and only) option.
 *
 * WHY: the protocol says "two reviewers from different model families by
 * default; a single reviewer is the accepted fallback, declared in a Note".
 * That rule used to live only in prose the reviewer agent reads, with nothing
 * enforcing it at DISPATCH time. The observed failure mode: an environment
 * with exactly one judge-eligible family still got two reviewers spawned —
 * twice the cost, and the second "independent" audit shared the first one's
 * blind spots entirely, so the diversity the second reviewer was paid for did
 * not exist.
 *
 * This module answers, from the registry facts alone: which specs should be
 * spawned, and — when the answer is one — the exact Note the recorded review
 * must carry. Pure, no I/O, no network.
 */
import { familyOf, capabilityOf, capabilityOfFamily, type ModelFamily } from "./model-ranking.ts";

/**
 * Models that must never judge, regardless of availability. The flash tier is
 * a cheap scanner (see AGENTS.md tiers): fast and inexpensive, but not a
 * gatekeeper — letting it emit the recorded verdict would put the weakest
 * model in the most consequential seat. `opencode-go/deepseek-v4-flash` is
 * also the ONLY model allowed on that provider (cost allowlist), so on a
 * host where opencode-go is the second provider there is, by construction,
 * no second judge family.
 */
export const NON_JUDGE_MODEL_IDS: readonly string[] = Object.freeze(["deepseek-v4-flash"]);

export interface FanoutPlan {
  /** Specs to spawn, best-first. Length 0 (no judge), 1 (single) or 2 (cross-family). */
  reviewers: string[];
  /** Family of each spawned reviewer, index-aligned with `reviewers`. */
  families: ModelFamily[];
  /** True only when two DIFFERENT families are dispatched. */
  crossFamily: boolean;
  /**
   * Present whenever the default (cross-family pair) could not be honored.
   * The agent MUST copy this into the recorded review, so a single-reviewer
   * verdict is never silently passed off as a double review.
   */
  note?: string;
}

/** Strip a `provider/` prefix and any `:thinking` suffix from a model spec. */
export function bareModelId(spec: string): string {
  const noThinking = spec.split(":").shift() ?? spec;
  const parts = noThinking.split("/");
  return parts[parts.length - 1] ?? noThinking;
}

/** False for the cheap/fast tier that must never emit a recorded verdict. */
export function isJudgeEligible(spec: string): boolean {
  return !NON_JUDGE_MODEL_IDS.includes(bareModelId(spec));
}

/**
 * Plan the review fan-out from the judge-capable specs available on this host.
 *
 * `available` is the caller's preference order (e.g. the pinned reviewer
 * chain followed by any other authenticated models). Within one family the
 * FIRST listed spec wins, so the caller's pin is honored; families are then
 * ordered by capability so the strongest available family leads.
 */
export function planReviewFanout(available: readonly string[]): FanoutPlan {
  const eligible = available.filter(isJudgeEligible);
  if (eligible.length === 0) {
    return {
      reviewers: [],
      families: [],
      crossFamily: false,
      note:
        "NO judge-eligible model is available on this host (every candidate is " +
        "cheap-tier or unauthenticated). A recorded review cannot be produced — " +
        "fix the model configuration before relying on the gate.",
    };
  }

  // First spec per family, families ranked by capability (stable for ties).
  const firstOfFamily = new Map<ModelFamily, string>();
  for (const spec of eligible) {
    const family = familyOf(bareModelId(spec));
    if (!firstOfFamily.has(family)) firstOfFamily.set(family, spec);
  }
  // Score the FAMILY directly. Re-deriving it from its own name through
  // capabilityOf() looked equivalent but is not: familyOf("meta") is "unknown"
  // (the id tokens are `meta-`/`llama`), so that family scored 0 and could be
  // dropped in favour of a weaker one.
  const families = [...firstOfFamily.keys()].sort((a, b) => {
    const diff = capabilityOfFamily(b) - capabilityOfFamily(a);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  if (families.length === 1) {
    const only = families[0]!;
    return {
      reviewers: [firstOfFamily.get(only)!],
      families: [only],
      crossFamily: false,
      note:
        (only === "unknown"
          ? "Only ONE judge-eligible model FAMILY can be identified on this host, and its vendor is " +
            "unrecognized — models from different unknown vendors all collapse into one family here, " +
            "so the real diversity may be higher than this plan can prove. "
          : `Only ONE judge-eligible model family is available on this host (${only}). `) +
        "The cross-family double review is therefore NOT possible: this verdict comes " +
        "from a SINGLE reviewer, which the protocol accepts only as a declared fallback. " +
        "Spawning a second reviewer on the same family would double the cost while " +
        "sharing the first one's blind spots.",
    };
  }

  const picked = families.slice(0, 2);
  return {
    reviewers: picked.map((f) => firstOfFamily.get(f)!),
    families: picked,
    crossFamily: true,
  };
}

/** One line for the dispatch log / status readout. Pure. */
export function formatFanoutPlan(plan: FanoutPlan): string {
  if (plan.reviewers.length === 0) return "review fan-out: NONE (no judge-eligible model)";
  const pairs = plan.reviewers.map((r, i) => `${r} (${plan.families[i]})`).join(" + ");
  return `review fan-out: ${plan.crossFamily ? "cross-family pair" : "SINGLE (fallback)"} — ${pairs}`;
}

/**
 * The registry facts this module needs. Structurally compatible with
 * `RegistryFacts` (lib/model-diagnose.ts) so the extension can pass the SAME
 * facts object it already builds for /gate-status — one facts source, so the
 * fan-out plan can never disagree with the model diagnosis.
 */
export interface JudgeFacts {
  models: ReadonlyArray<{ provider: string; id: string }>;
  authedProviders: ReadonlySet<string>;
  /** The resolver's provider/model allowlist (lib/model-allowlist.ts isModelAllowed). */
  allowed: (model: { provider: string; id: string }) => boolean;
}

/**
 * Judge-capable model specs this host can actually launch, best-first.
 *
 * A model qualifies only when all three hold: its provider has configured
 * credentials, the resolver's allowlist would accept it, and it is not the
 * cheap tier. Families are ordered by capability and, within a family, ids
 * sort alphabetically so the result is deterministic (the CONCRETE model a
 * reviewer runs on still comes from the pinned agent chain — this list decides
 * how many reviewers and from which families, not which pin to override).
 */
export function judgeCandidatesFromFacts(facts: JudgeFacts): string[] {
  const specs: string[] = [];
  const seen = new Set<string>();
  for (const model of facts.models) {
    if (!facts.authedProviders.has(model.provider)) continue;
    if (!facts.allowed(model)) continue;
    if (!isJudgeEligible(model.id)) continue;
    const spec = `${model.provider}/${model.id}`;
    if (seen.has(spec)) continue;
    seen.add(spec);
    specs.push(spec);
  }
  return specs.sort((a, b) => {
    const diff = capabilityOf(bareModelId(b)) - capabilityOf(bareModelId(a));
    return diff !== 0 ? diff : a.localeCompare(b);
  });
}

/**
 * Plan the fan-out from registry facts, or `undefined` when the facts are not
 * usable at all (an empty registry — a headless host, a session whose registry
 * exposes nothing).
 *
 * The distinction matters: "this host has NO judge" is a real, alarming finding
 * worth injecting into the agent's prompt, while "the gate could not read the
 * registry" is a diagnostic blind spot that must stay SILENT rather than raise
 * a false alarm. Fail-soft, like every other advisory the gate emits.
 */
export function planFanoutFromFacts(facts: JudgeFacts): FanoutPlan | undefined {
  if (facts.models.length === 0) return undefined;
  return planReviewFanout(judgeCandidatesFromFacts(facts));
}

/**
 * The block injected into the agent's prompt (both the `/review` command and
 * the auto-continuation resume text), so the reviewer count is a fact the gate
 * computed rather than a rule the agent may reinterpret.
 *
 * It never picks the reviewer's model — that stays pinned in the agent file —
 * and it never touches the ship gate.
 */
export function formatFanoutDirective(plan: FanoutPlan): string {
  const lines = ["Reviewer fan-out for this round (computed by the gate from this host's model registry):"];
  if (plan.reviewers.length === 0) {
    lines.push(
      "- NONE: no judge-eligible model is available here, so a recorded verdict cannot be produced.",
      "- Fix the model configuration (`/gate-doctor`) before relying on the gate. The gate stays CLOSED.",
    );
  } else if (plan.crossFamily) {
    lines.push(
      `- CROSS-FAMILY PAIR: spawn exactly TWO reviewers, one per family (${plan.families.join(", ")}), in the SAME turn.`,
      "- Record BOTH raw outputs (worst verdict wins). Do not spawn a third.",
    );
  } else {
    lines.push(
      `- SINGLE reviewer (declared fallback): ${plan.families[0]} is the only judge-eligible family on this host.`,
      "- Do NOT spawn a second reviewer on that same family: it doubles the cost, shares the first one's blind spots, " +
        "and reporting it as a cross-family double review would be false.",
    );
  }
  if (plan.note) lines.push(`- Copy this note into the recorded review: "${plan.note}"`);
  return lines.join("\n");
}
