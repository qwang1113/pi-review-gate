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
import { KNOWN_THINKING_LEVELS } from "./model-config.ts";

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
   * Present whenever a plan deviates from the ideal: a single-reviewer fallback
   * (the agent MUST copy it into the recorded review, so a single verdict is
   * never silently passed off as a double review) OR a cross-family pair that
   * lost a user-preferred slot to an unsupported :thinking level (round-7 Nit:
   * the docblock used to claim note is only for non-pairs).
   */
  note?: string;
  /**
   * Present on slot-driven plans (reviewer `auto` OFF): a one-line source
   * statement rendered at the top of the directive so the agent knows the plan
   * came from user slots rather than the capability ranking.
   * `planSlottedReviewFanout` fills a generic default; the extension then
   * STAMPS layer-specific text ("REVIEWER SLOT SOURCE: project — slots: …")
   * when reviewer.source is known — a caller that knows the source should
   * overwrite it so the real layer reaches the prompt.
   */
  slotSource?: string;
}

/**
 * Strip a `provider/` prefix and any `:thinking` suffix from a model spec.
 *
 * A `:level` is only stripped when the suffix is a KNOWN thinking level
 * (`:max`, `:high`, …). An id that legitimately contains a colon with a
 * DIFFERENT shape (ollama-style `qwen3:32b` or a letter tag `qwen3:latest`)
 * is left intact (round-8 P1 / round-5 P2: naively stripping letter tags
 * silently dropped such slots).
 */
export function bareModelId(spec: string): string {
  let base = spec;
  const colonIdx = base.lastIndexOf(":");
  if (colonIdx !== -1) {
    const suffix = base.slice(colonIdx + 1);
    if (KNOWN_THINKING_LEVELS.has(suffix)) base = base.slice(0, colonIdx);
  }
  // Provider split is the FIRST slash (mirrors lib/model-config
  // parseModelSpec): an id may itself contain slashes (deepseek/v4-flash),
  // and taking the LAST segment silently rewrote such ids (round-2 P1).
  const slash = base.indexOf("/");
  return slash > 0 ? base.slice(slash + 1) : base;
}

/**
 * Extract a trailing `:thinking` suffix from a spec, or null — mirrors
 * lib/model-config `splitThinkingSuffix` so the slotted plan can carry the
 * user's per-slot thinking level forward.
 *
 * Only KNOWN thinking levels are carried (round-3 P2): a bogus suffix like
 * `:bogus` must not reach the prompt as a spawn instruction — the renderer
 * would refuse it, and the directive would then contradict the deployed
 * frontmatter.
 */
export function specThinking(spec: string): string | null {
  const colonIdx = spec.lastIndexOf(":");
  if (colonIdx === -1) return null;
  const suffix = spec.slice(colonIdx + 1);
  return KNOWN_THINKING_LEVELS.has(suffix) ? suffix : null;
}

/**
 * Note fragment naming the slots that were skipped, WITH THE TRUE REASON for
 * each group (round-5 P2: the downgrade must say WHY, not blame "only one
 * family in the slots"; goal 2026-08-22 criterion 5: an ambiguous slot must
 * not be reported as an unsupported thinking level — the two buckets are
 * different failures and were previously merged into one sentence).
 *
 * - `unsupportedLevel`: the target model refuses the pinned `:thinking` level.
 * - `ambiguous`: a provider-less id that exists under SEVERAL providers, which
 *   `validateSpec` refuses outright — nothing to do with thinking levels.
 *
 * Empty when nothing was skipped.
 */
function slotSkipNote(unsupportedLevel: readonly string[], ambiguous: readonly string[]): string {
  let note = "";
  if (unsupportedLevel.length > 0) {
    note += ` The following slots were skipped because their :thinking level is unsupported by the target model: ${unsupportedLevel.join(", ")}.`;
  }
  if (ambiguous.length > 0) {
    note += ` The following slots were skipped because the id has no provider prefix and exists under several providers (write them as provider/id): ${ambiguous.join(", ")}.`;
  }
  return note;
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
  models: ReadonlyArray<{
    provider: string;
    id: string;
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
  }>;
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
    if (model.reasoning === false) continue;
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

/** Effective reviewer settings used by the production fan-out branch. */
export interface ReviewerFanoutSettings {
  auto: boolean;
  slots: readonly string[];
  source?: string;
}

/** Keep the production auto/slot decision in a pure, testable helper. */
export function planConfiguredReviewFanout(
  facts: JudgeFacts,
  settings: ReviewerFanoutSettings | undefined,
): FanoutPlan | undefined {
  if (settings?.auto === false && settings.slots.length > 0) {
    const plan = planSlottedReviewFanout(facts, settings.slots);
    if (plan) {
      plan.slotSource =
        `REVIEWER SLOT SOURCE: ${settings.source ?? "unknown"} — slots: ${settings.slots.join(" | ")}. ` +
        "The first two usable slots win — capability ranking is bypassed.";
    }
    return plan;
  }
  return planFanoutFromFacts(facts);
}

/**
 * Slot-based fan-out: with the user's reviewer `auto` switch OFF, the double
 * review takes the first TWO usable models from the user-ordered slot list,
 * one per family (same-family duplicates are skipped so the cross-family
 * protocol holds). "Usable" means authenticated + allowlist-approved +
 * judge-eligible, checked against the SAME registry facts as the default
 * path. Slots may carry a `:thinking` suffix (matched on the bare id, kept on
 * the picked spec) and may omit the provider prefix (matched by id against
 * the facts).
 *
 * NOTE (id grammar): a spec is `[provider/]id[:thinking]`. `:thinking` is
 * stripped only when the suffix is a letter-headed level word (`:max`, `:high`);
 * an id that itself contains a colon with a DIFFERENT shape (ollama-style
 * `qwen3:32b`) is preserved as part of the id and CAN be matched by a slot
 * (rounds 8/9). A slot whose id does not resolve simply lands in the
 * NONE/SINGLE note path with no per-slot diagnostic.
 *
 * This is the only path that honors user pinning as an ABSOLUTE priority:
 * the capability ranking is bypassed entirely. Notes explain any shortfall so
 * a recorded single-reviewer verdict is never passed off silently.
 */
export function planSlottedReviewFanout(facts: JudgeFacts, slots: readonly string[]): FanoutPlan {
  const slotSource =
    "REVIEWER SLOTS (user config, auto switch OFF). The first two usable slots win — " +
    "capability ranking is bypassed.";

  // First usable spec per family, in slot order. Skipped slots are collected
  // per REASON so the note can say WHY a family collapsed — an unsupported
  // `:thinking` level and a provider-less ambiguous id are different failures
  // and must not be reported as one.
  const firstOfFamily = new Map<ModelFamily, string>();
  const skippedUnsupportedLevel: string[] = [];
  const skippedAmbiguous: string[] = [];
  for (const spec of slots) {
    const specId = bareModelId(spec);
    const provider = spec.includes("/") ? spec.slice(0, spec.indexOf("/")) : undefined;
    const matches = facts.models.filter((model) => {
      if (model.id !== specId) return false;
      if (provider && model.provider !== provider) return false;
      if (!facts.authedProviders.has(model.provider)) return false;
      if (!facts.allowed(model)) return false;
      // Parity with validateSpec (round-5 P1 + round-8 P1): a reasoning:false
      // model is usable with a BARE slot or :off — only other levels are
      // refused. The user EXPLICITLY pinned this slot; deployed = planned.
      // (The DEFAULT fan-out excludes reasoning:false via
      // judgeCandidatesFromFacts — that is the auto path's cheap-tier guard,
      // not a veto on explicit user configuration.)
      if (model.reasoning === false) {
        const lvl = specThinking(spec);
        if (lvl !== null && lvl !== "off") return false;
      }
      return isJudgeEligible(model.id);
    });
    // Provider-less ambiguity parity (round-4 P1 + round-6 order fix):
    // validateSpec REFUSES a bare id that exists under several providers —
    // BEFORE any auth/allowlist filtering. Checking it on the FILTERED list
    // let exactly-one-authenticated hide the ambiguity (validateSpec would
    // refuse the same slot, so deployed ≠ planned).
    if (!provider) {
      const providers = new Set(facts.models.filter((m) => m.id === specId).map((m) => m.provider));
      if (providers.size > 1) {
        skippedAmbiguous.push(spec);
        continue;
      }
    }
    const usable = matches[0];
    if (!usable) {
      // A reasoning:false model pinned with a level other than `:off` is
      // dropped INSIDE the predicate above, so it used to leave no trace and
      // the NONE/SINGLE note then blamed reasons that were all false
      // (unauthenticated / allowlist-blocked / cheap-tier / absent). Record it
      // in the unsupported-level bucket — that IS the true reason — but only
      // when the slot would otherwise have been usable, so a genuinely absent
      // or unauthenticated model keeps the generic message.
      const lvl = specThinking(spec);
      if (lvl !== null && lvl !== "off") {
        const refusedForLevel = facts.models.some(
          (model) =>
            model.id === specId &&
            (!provider || model.provider === provider) &&
            facts.authedProviders.has(model.provider) &&
            facts.allowed(model) &&
            model.reasoning === false &&
            isJudgeEligible(model.id),
        );
        if (refusedForLevel) skippedUnsupportedLevel.push(spec);
      }
      continue;
    }
    const family = familyOf(usable.id);
    if (firstOfFamily.has(family)) continue;
    // Missing metadata follows pi-subagents: every level except max is
    // accepted; with metadata, xhigh/max require an explicit mapping.
    const thinking = specThinking(spec);
    if (thinking) {
      // NOTE: :off is NOT universally exempt — validateSpec refuses it when a
      // REASONING model's map EXPLICITLY nulls it (verified by direct call).
      // The ONE special case is reasoning:false: validateSpec short-circuits
      // to `level === "off"` before consulting the map (round-8 P1).
      if (!(usable.reasoning === false && thinking === "off")) {
        const mapped = usable.thinkingLevelMap?.[thinking];
        if (mapped === null || (mapped === undefined && (thinking === "max" || (thinking === "xhigh" && usable.thinkingLevelMap)))) {
          skippedUnsupportedLevel.push(`${usable.provider}/${usable.id}:${thinking}`);
          continue;
        }
      }
    }
    firstOfFamily.set(family, `${usable.provider}/${usable.id}${thinking ? `:${thinking}` : ""}`);
    if (firstOfFamily.size >= 2) break;
  }

  if (firstOfFamily.size === 0) {
    return {
      reviewers: [],
      families: [],
      crossFamily: false,
      note:
        "NONE of the configured slots is usable (unauthenticated, allowlist-blocked, " +
        "cheap-tier, or absent from the registry). A recorded review cannot be produced — " +
        "fix the slot configuration before relying on the gate." +
        slotSkipNote(skippedUnsupportedLevel, skippedAmbiguous),
      slotSource,
    };
  }
  if (firstOfFamily.size === 1) {
    const only = [...firstOfFamily.entries()][0]!;
    return {
      reviewers: [only[1]],
      families: [only[0]],
      crossFamily: false,
      note:
        `Only ONE distinct usable family (${only[0]}) is configured in the slots, so the ` +
        "cross-family double review is NOT possible: this verdict comes from a SINGLE " +
        "reviewer (same-family duplicates in the slots are skipped by policy)." +
        (only[0] === "unknown"
          ? " Because that family is UNRECOGNIZED, two different unknown vendors collapse into one family here — " +
            "the real diversity may be higher than this plan can prove (same caveat as the default path)."
          : "") +
        slotSkipNote(skippedUnsupportedLevel, skippedAmbiguous),
      slotSource,
    };
  }
  const picked = [...firstOfFamily.entries()].slice(0, 2);
  const note = slotSkipNote(skippedUnsupportedLevel, skippedAmbiguous);
  return {
    reviewers: picked.map(([, spec]) => spec),
    families: picked.map(([family]) => family),
    crossFamily: true,
    // Even a real pair may have lost a user-preferred slot to an unsupported
    // :thinking level — that must be visible (round-6 P2).
    ...(note ? { note } : {}),
    slotSource,
  };
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
  const lines: string[] = [];
  if (plan.slotSource) lines.push(plan.slotSource);
  lines.push(
    plan.slotSource
      ? "Reviewer fan-out for this round (computed by the gate from your reviewer slots):"
      : "Reviewer fan-out for this round (computed by the gate from this host's model registry):",
  );
  if (plan.reviewers.length === 0) {
    lines.push(
      `- NONE: no judge-eligible model is available ${plan.slotSource ? "in your reviewer slots" : "here"}, so a recorded verdict cannot be produced.`,
      plan.slotSource
        ? "- Fix your reviewer slot list (`agents.reviewer.slots`) before relying on the gate. The gate stays CLOSED."
        : "- Fix the model configuration (`/gate-doctor`) before relying on the gate. The gate stays CLOSED.",
    );
  } else if (plan.crossFamily) {
    lines.push(
      `- CROSS-FAMILY PAIR: spawn exactly TWO reviewers, one per family (${plan.families.join(", ")}), in the SAME turn.`,
      // The concrete spec pair is only meaningful on the SLOT path, where the
      // user pinned it (round-3 P1: on the default path these lines overrode
      // the agent-file pin and could seat a cheap-tier model as judge). The
      // default path deliberately says nothing about which model to spawn —
      // the pin in the agent file stays the single source of truth there.
      ...(plan.slotSource
        ? [`- Picked reviewers: ${plan.reviewers.join(", ")}. Spawn exactly those two specs.`]
        : []),
      "- Record BOTH raw outputs (worst verdict wins). Do not spawn a third.",
    );
  } else {
    lines.push(
      `- SINGLE reviewer (declared fallback): ${plan.families[0]} is the only judge-eligible family ${plan.slotSource ? "in your reviewer slots" : "on this host"}.`,
      ...(plan.slotSource
        ? [`- Picked reviewer: ${plan.reviewers.join(", ")}. Spawn exactly that spec.`]
        : []),
      "- Do NOT spawn a second reviewer on that same family: it doubles the cost, shares the first one's blind spots, " +
        "and reporting it as a cross-family double review would be false.",
    );
  }
  if (plan.note) lines.push(`- Copy this note into the recorded review: "${plan.note}"`);
  return lines.join("\n");
}
