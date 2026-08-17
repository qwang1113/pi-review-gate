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
  /** Every model the registry knows: { provider, id }. */
  models: Array<{ provider: string; id: string }>;
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
): { model?: string; fallbackModels?: string[] } | undefined {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return undefined;
  const unquote = (s: string): string =>
    (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) ? s.slice(1, -1) : s;
  const out: { model?: string; fallbackModels?: string[] } = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.trim();
    if (key === "model" && value) out.model = unquote(value);
    else if (key === "fallbackModels" && value) {
      out.fallbackModels = value.split(",").map((s) => unquote(s.trim())).filter(Boolean);
    }
  }
  return out;
}

/** Canonicalize a spec: strip :thinking suffix, qualify a bare id with the
 *  provider that carries it (unambiguous), else leave as-is. */
export function resolveSpec(
  spec: string,
  facts: RegistryFacts,
): { provider: string; id: string; ambiguous?: boolean } | undefined {
  const base = spec.split(":").shift() ?? spec;
  if (base.includes("/")) {
    const [provider, ...rest] = base.split("/");
    const id = rest.join("/");
    return { provider: provider!, id };
  }
  // Bare id: find the unique provider carrying it; ambiguous → unknown.
  const matches = facts.models.filter((m) => m.id === base);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) return { provider: matches[0]!.provider, id: base, ambiguous: true };
  return matches[0]!;
}

function candidateOk(
  resolved: { provider: string; id: string; ambiguous?: boolean } | undefined,
  facts: RegistryFacts,
): { ok: boolean; reason?: string } {
  if (!resolved) return { ok: false, reason: "not in the model registry" };
  if (resolved.ambiguous) {
    return { ok: false, reason: "bare id is ambiguous across providers — qualify it as provider/id" };
  }
  if (!facts.allowed(resolved)) {
    return { ok: false, reason: "provider allowlist forbids it (opencode-go: deepseek-v4-flash only)" };
  }
  if (!facts.authedProviders.has(resolved.provider)) {
    return { ok: false, reason: `no configured credentials for provider "${resolved.provider}"` };
  }
  if (!facts.models.some((m) => m.provider === resolved.provider && m.id === resolved.id)) {
    return { ok: false, reason: "not in the model registry" };
  }
  return { ok: true };
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
  const candidates = chain.map((spec) => {
    const ok = candidateOk(resolveSpec(spec, facts), facts);
    return { spec, ok: ok.ok, reason: ok.reason };
  });
  const usable = candidates.find((c) => c.ok)?.spec ?? null;
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
