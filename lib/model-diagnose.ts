/**
 * Model-chain diagnosis — pure reference for "which judge model will my
 * review actually run on?" (P2.1). The extension feeds it the agent
 * frontmatters and the model registry facts; it answers, per agent, which
 * model the chain resolves to and whether the chain is usable at all.
 *
 * Nothing here decides a gate verdict — it is diagnostics only. The
 * provider allowlist (opencode-go → deepseek-v4-flash only, USER
 * REQUIREMENT, `lib/model-allowlist.ts`) is applied the same way the
 * resolver applies it, so the diagnosis never names a model the resolver
 * would refuse.
 */
import { KNOWN_THINKING_LEVELS, frontmatterBlock } from "./model-config.ts";
export interface ModelChainEntry {
  /** Agent role — the agents/*.md basename (reviewer, adviser, ...). */
  role: string;
  /** [model, ...fallbackModels] exactly as pinned in the frontmatter. */
  chain: string[];
  /** Per-candidate verdict against the registry facts. */
  candidates: Array<{ spec: string; ok: boolean; reason?: string }>;
  /** First usable spec (canonical provider/id), or null when the chain is dead. */
  usable: string | null;
  /** True when no candidate resolves — a review on this agent cannot start. */
  blocked: boolean;
}

export interface RegistryFacts {
  /**
   * Every model the registry knows: { provider, id }. `thinkingLevelMap` is
   * optional (registry-provided only): level → mapped level, null when the
   * level is unsupported — lets the slotted fan-out skip a slot whose pinned
   * `:thinking` level the renderer would refuse (round-4 P2).
   */
  models: Array<{
    provider: string;
    id: string;
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
  }>;
  /** Providers with configured credentials (auth.json keys). */
  authedProviders: ReadonlySet<string>;
  /**
   * Provider allowlist predicate (lib/model-allowlist.ts isModelAllowed): a
   * model the resolver would refuse must not show as usable here.
   */
  allowed: (model: { provider: string; id: string }) => boolean;
}

/** Parse the YAML-ish frontmatter of an agent definition. Best-effort. */
export function parseAgentFrontmatter(
  text: string,
): { model?: string; fallbackModels?: string[]; thinking?: string } | undefined {
  // Same delimiter authority as the loadable check (lib/model-config.ts): a
  // stricter local regex meant a project agent the runtime DOES load could be
  // dropped from the diagnosis, so a dead live chain looked healthy.
  const block = frontmatterBlock(text);
  if (block === undefined) return undefined;
  const unquote = (s: string): string =>
    (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) ? s.slice(1, -1) : s;
  const out: { model?: string; fallbackModels?: string[]; thinking?: string } = {};
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const kv = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.trim();
    if (key === "model" && value) out.model = unquote(value);
    else if (key === "thinking" && value) out.thinking = unquote(value);
    else if (key === "fallbackModels") {
      if (value) out.fallbackModels = value.split(",").map((s) => unquote(s.trim())).filter(Boolean);
      else {
        // YAML block list: collect `- item` lines.
        //
        // A COMMENT line does not end the block upstream (parseFrontmatter
        // keeps `# note` as a list entry, which then simply fails to resolve),
        // so skipping it here reports the same usable chain while dropping a
        // candidate that could never work (round-11 P2).
        //
        // A genuinely BLANK line, however, ENDS the block upstream: a plain
        // (non-folded, non-literal) block fails the continuation test, so the
        // items AFTER the blank line are never part of the value and never
        // deploy. Verified directly against pi-subagents' parseFrontmatter:
        // `fallbackModels:\n  - c/d\n\n  - e/f` yields ONLY `c/d`. Skipping
        // the blank line here reported `e/f` as a usable fallback that the
        // runtime will never start (deployed ≠ diagnosed).
        const items: string[] = [];
        for (const next of lines.slice(i + 1)) {
          const t = next.trim();
          if (t === "") break;
          if (t.startsWith("#")) continue;
          const match = /^-\s+(.+?)\s*$/.exec(t);
          if (!match) break;
          items.push(unquote(match[1]!));
        }
        if (items.length > 0) out.fallbackModels = items;
      }
    }
  }
  return out;
}

/** Canonicalize a spec, preserving colon-bearing ids unless the suffix is a known thinking level. */
export function resolveSpec(
  spec: string,
  facts: RegistryFacts,
): { provider: string; id: string; ambiguous?: boolean } | undefined {
  // First-slash split, and a LEADING slash is malformed (the whole spec is
  // the id, which resolves nowhere) — parity with lib/model-config
  // parseModelSpec (round-3 P1: an empty provider fell into the bare-id path
  // and could bless a chain the renderer refuses).
  const slash = spec.indexOf("/");
  const split = slash > 0;
  const provider = split ? spec.slice(0, slash) : undefined;
  const rawId = split ? spec.slice(slash + 1) : spec;
  const colon = rawId.lastIndexOf(":");
  const suffix = colon === -1 ? null : rawId.slice(colon + 1);
  // Single source for the level list (lib/model-config.ts): an inlined copy
  // here drifted from the renderer's list, so the doctor could bless a level
  // the renderer refuses (deployed ≠ diagnosed).
  const base = colon !== -1 && suffix !== null && KNOWN_THINKING_LEVELS.has(suffix) ? rawId.slice(0, colon) : rawId;
  if (provider) return { provider, id: base };
  const matches = facts.models.filter((m) => m.id === base);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) return { provider: matches[0]!.provider, id: base, ambiguous: true };
  return matches[0]!;
}

function candidateOk(
  resolved: { provider: string; id: string; ambiguous?: boolean } | undefined,
  facts: RegistryFacts,
  suffix?: string | null,
): { ok: boolean; reason?: string } {
  if (!resolved) return { ok: false, reason: "not in the model registry" };
  if (resolved.ambiguous) {
    return { ok: false, reason: "bare id is ambiguous across providers — qualify it as provider/id" };
  }
  const model = facts.models.find((m) => m.provider === resolved.provider && m.id === resolved.id);
  if (!model) return { ok: false, reason: "not in the model registry" };
  if (!facts.allowed(resolved)) {
    return { ok: false, reason: "provider allowlist forbids it (opencode-go: deepseek-v4-flash only)" };
  }
  if (!facts.authedProviders.has(resolved.provider)) {
    return { ok: false, reason: `no configured credentials for provider "${resolved.provider}"` };
  }
  // Parity with validateSpec (round-5 P1): a reasoning:false model accepts a
  // BARE spec (no suffix — the default level) and :off; every other level is
  // refused. The old unconditional refusal made the doctor report chains
  // dead that the renderer actually deploys.
  if (model.reasoning === false && suffix !== undefined && suffix !== null && suffix !== "off") {
    return { ok: false, reason: "model does not support reasoning; only :off is usable" };
  }
  if (suffix) {
    // NOTE: :off is NOT universally exempt — validateSpec refuses it when a
    // REASONING model's map EXPLICITLY nulls it (verified by direct call).
    // The ONE special case is reasoning:false: validateSpec short-circuits
    // to `level === "off"` before consulting the map, so a null off mapping
    // there is irrelevant (round-8 P1).
    if (model.reasoning === false && suffix === "off") return { ok: true };
    const mapped = model.thinkingLevelMap?.[suffix];
    if (mapped === null || (mapped === undefined && suffix === "max") || (mapped === undefined && suffix === "xhigh" && model.thinkingLevelMap)) {
      return { ok: false, reason: `thinking level :${suffix} is unsupported by the model` };
    }
  }
  return { ok: true };
}

/**
 * Trailing `:thinking` level of a spec, or null. Mirrors `specThinking` in
 * lib/review-fanout.ts and uses the SAME level list (lib/model-config.ts).
 * A spec with NO colon has no suffix: `lastIndexOf(":") + 1` is 0 there, so
 * the old copy read the whole spec as its own suffix and a bare id that
 * happens to be a level word (`max`) was truncated to `ma` by
 * stripThinkingSuffix.
 */
function specThinkingSuffix(spec: string): string | null {
  const colon = spec.lastIndexOf(":");
  if (colon === -1) return null;
  const suffix = spec.slice(colon + 1);
  return KNOWN_THINKING_LEVELS.has(suffix) ? suffix : null;
}

/** Strip a :thinking suffix so `usable` names the model, not the deploy detail. */
function stripThinkingSuffix(spec: string): string {
  return specThinkingSuffix(spec) ? spec.slice(0, spec.lastIndexOf(":")) : spec;
}

/** Diagnose one agent's model chain against the registry facts. Pure. */
export function diagnoseChain(
  role: string,
  frontmatter: string,
  facts: RegistryFacts,
): ModelChainEntry {
  const parsed = parseAgentFrontmatter(frontmatter);
  const chain = parsed
    ? [parsed.model ?? "", ...(parsed.fallbackModels ?? [])].filter(Boolean)
    : [];
  // A standalone `thinking:` frontmatter field applies to EVERY candidate
  // at deploy time (pi-subagents appends it to each model), so the diagnosis
  // must check the chain with that level implied — a bare spec + `thinking:
  // max` is only usable if `:max` resolves (round-11 P2).
  //
  // But an UNKNOWN word is not a level: pi-subagents' resolveEffectiveThinking
  // does `THINKING_LEVELS.find((level) => level === configThinking)`
  // (node_modules/pi-subagents/src/shared/model-info.ts:40), so `thinking:
  // banana` / `thinking: false` resolves to undefined and the model deploys
  // BARE. Applying it here refused reasoning:false candidates that really do
  // run — the doctor reported a live chain as dead (deployed ≠ diagnosed).
  const declaredThinking = parsed?.thinking ?? null;
  const implicitSuffix =
    declaredThinking !== null && KNOWN_THINKING_LEVELS.has(declaredThinking) ? declaredThinking : null;
  const candidates = chain.map((spec) => {
    const suffix = specThinkingSuffix(spec) ?? implicitSuffix;
    const ok = candidateOk(resolveSpec(spec, facts), facts, suffix);
    return { spec, ok: ok.ok, reason: ok.reason };
  });
  const okCandidate = candidates.find((c) => c.ok);
  const usable = okCandidate ? stripThinkingSuffix(okCandidate.spec) : null;
  return {
    role,
    chain,
    candidates,
    usable,
    blocked: chain.length > 0 && usable === null,
  };
}

/** One text block for /gate-status. Pure. */
export function formatModelDiagnosis(entries: ModelChainEntry[]): string {
  if (entries.length === 0) return "model chains: (none found)";
  const lines = entries.map((e) => {
    const head = e.blocked
      ? `⚠️ BLOCKED (no usable model — review cannot start)`
      : `→ ${e.usable}`;
    const chain = e.chain.map((c) => {
      const cand = e.candidates.find((x) => x.spec === c);
      return cand?.ok ? `✓ ${c}` : `✗ ${c}${cand?.reason ? ` (${cand.reason})` : ""}`;
    }).join(" ");
    return `  ${e.role}: ${head}\n    ${chain}`;
  });
  return `model chains:\n${lines.join("\n")}`;
}
