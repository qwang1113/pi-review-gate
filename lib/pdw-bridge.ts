/**
 * Hard dependency bridge to `@quintinshaw/pi-dynamic-workflows` (pdw).
 *
 * pdw is THE execution engine of this extension: the review loop and the
 * decompose module loop run through it, period. There is deliberately NO
 * serial fallback — if the engine cannot be loaded, the tools report a clear
 * installation error instead of silently degrading.
 *
 * RUNTIME CONTRACT:
 *  - `loadPdw()` resolves once per process; a failed import is cached as an
 *    error and rethrown with installation guidance on every later call
 *    (retrying a broken install is futile and would only add latency to every
 *    gate round).
 *  - `loadPdw()` NEVER returns null. Callers do not branch on availability;
 *    they either get a working engine or a descriptive error to surface.
 *  - `runWorkflow` is invoked with an explicit cwd and the caller's own agent
 *    runner when provided; without one, pdw builds its default WorkflowAgent
 *    (which resolves model specs against the registry and agent types
 *    against `~/.pi/agent/agents` + project `.pi/agents`).
 */
export interface PdwModule {
  /** Run a workflow script; returns the structured run result. */
  runWorkflow: (
    script: string,
    options?: Record<string, unknown>,
  ) => Promise<{
    result: unknown;
    logs: string[];
    phases: string[];
    agentCount: number;
    durationMs: number;
    runId?: string;
  }>;
}

/** Error thrown when the pdw engine cannot be loaded (never a fallback). */
export class PdwUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      "pdw engine (@quintinshaw/pi-dynamic-workflows) is not available. " +
        "It ships with this extension — re-install it (`pi install` the package, " +
        "or run `scripts/install-package.mjs` / `npm install` in the package) so its " +
        "node_modules land next to the extension code." +
        (cause ? ` Original error: ${(cause as Error).message}` : ""),
    );
    this.name = "PdwUnavailableError";
  }
}

/**
 * pdw's workflow-script validator runs a PLAIN-REGEX determinism blocklist
 * (`Date.now` / `Math.random` / `new Date()`) over the whole script source and
 * does not understand string literals — so DATA injected into the script
 * (diff text, goal text, worklog excerpts) that merely CONTAINS those tokens
 * trips SCRIPT_VALIDATION_ERROR even though no script code uses them. Insert a
 * zero-width space into such tokens in the injected data (keeps the text
 * readable, defeats the regex) so the validator passes. Only ever applied to
 * injected DATA strings, never to script code.
 */
export function sanitizeInjectedWorkflowText(text: string): string {
  // Mirror the engine's whitespace-tolerant blocklist (\bDate\s*\.\s*now\b,
  // \bMath\s*\.\s*random\b, \bnew\s+Date\s*\(\s*\)\b) so spaced-out
  // spellings like `Date\n  .now()` are caught too. The original whitespace
  // is preserved — only a zero-width space is inserted inside the token.
  return text
    .replace(/Date(\s*\.\s*)now/g, (_m, ws: string) => `Date\u200b${ws}now`)
    .replace(/Math(\s*\.\s*)random/g, (_m, ws: string) => `Math\u200b${ws}random`)
    .replace(/(new\s+Date)(\s*\(\s*\))/g, (_m, p1: string, p2: string) => `${p1}\u200b${p2}`);
}

let cachedPdw: PdwModule | null | undefined;
let cachedError: Error | undefined;

/**
 * Load the pdw module once. Resolves the engine, or THROWS
 * `PdwUnavailableError` with installation guidance. Never returns null.
 */
export async function loadPdw(): Promise<PdwModule> {
  if (cachedPdw !== undefined && cachedPdw !== null) return cachedPdw;
  if (cachedError) throw cachedError;
  try {
    const mod = (await import("@quintinshaw/pi-dynamic-workflows")) as {
      runWorkflow?: unknown;
    };
    if (typeof mod.runWorkflow !== "function") {
      throw new Error("module loaded but runWorkflow is not exported");
    }
    cachedPdw = { runWorkflow: mod.runWorkflow as PdwModule["runWorkflow"] };
    return cachedPdw;
  } catch (err) {
    cachedError = new PdwUnavailableError(err);
    throw cachedError;
  }
}

/** Reset the cached module handle (tests only). */
export function resetPdwCacheForTests(): void {
  cachedPdw = undefined;
  cachedError = undefined;
}

/**
 * True when a model registry actually has models to resolve against. pi's
 * ModelRegistry is a sync facade over an async runtime — before the fallback
 * warms, `getAll()` returns `[]`, and handing that empty registry to pdw makes
 * every agent call fail with "No models available". Callers must then let pdw
 * build its own disk-backed registry from ~/.pi/agent/models.json instead.
 */
export function registryHasModels(registry: unknown): boolean {
  try {
    const all = (registry as { getAll?: () => unknown[] } | undefined)?.getAll?.();
    return Array.isArray(all) && all.length > 0;
  } catch {
    return false;
  }
}
/**
 * Resolve the best available model from a list of candidates against the
 * pdw model registry. Each candidate is tried in order: the first one that
 * can be resolved AND has configured auth wins. When the registry is
 * unavailable or none of the candidates resolve, returns candidates[0]
 * (fail-safe: pdw reports its own error, never silently degraded).
 *
 * This exists because the wave worker's module model (e.g. "claude-sonnet-5")
 * is a bare model name that may not exist in the user's models.json; pdw
 * would then fall back to amazon-bedrock with no API key, causing every worker
 * to return null (all modules failed). Resolving against the registry first
 * lets the engine pick a model that actually has configured credentials.
 */
export async function resolveBestModel(candidates: readonly string[], registry?: unknown): Promise<string> {
  if (!candidates || candidates.length === 0) return "";
  // No registry → bail out: return the first candidate, pdw reports its own error.
  if (registry === undefined || registry === null) return candidates[0];

  // The model resolver is pdw's OWN function (resolveModelSpecWithThinking), not
  // a registry method: it takes (spec, registry) and RETURNS {model?, error?}
  // instead of throwing, so an earlier implementation that called a registry
  // method and ignored the return value silently picked candidates[0] — the
  // unauthenticated pinned default — and every shard/worker failed.
  let resolver:
    | ((spec: string, reg: unknown) => { model?: unknown; error?: string })
    | undefined;
  try {
    const mod = (await import("@quintinshaw/pi-dynamic-workflows")) as {
      resolveModelSpecWithThinking?: (
        spec: string,
        reg: unknown,
      ) => { model?: unknown; error?: string };
    };
    resolver = mod.resolveModelSpecWithThinking;
  } catch {
    resolver = undefined;
  }

  const reg = registry as Record<string, unknown>;
  const hasAuth = typeof reg.hasConfiguredAuth === "function";
  if (!resolver && !hasAuth) return candidates[0];

  for (const candidate of candidates) {
    try {
      // A bare claude id ("claude-fable-5") fuzzy-matches amazon-bedrock's
      // us.anthropic.claude-* entries in pdw's resolver, which has no auth —
      // the subagent then fails with "No API key found for amazon-bedrock"
      // (or worse, silently runs an unauthenticated fallback). Pin the
      // anthropic provider explicitly for bare claude-* specs.
      const specs =
        candidate.includes("/") || !candidate.startsWith("claude-")
          ? [candidate]
          : [`anthropic/${candidate}`, candidate];
      for (const spec of specs) {
        let model: unknown;
        if (resolver) {
          const resolved = resolver(spec, registry);
          if (!resolved || !resolved.model || resolved.error) continue;
          model = resolved.model;
        }
        // Provider allowlist (USER REQUIREMENT): opencode-go may only run
        // deepseek-v4-flash — a resolved model outside the allowlist is
        // skipped, never returned (an expensive opencode-go fallback would
        // otherwise silently win here).
        if (model && !isModelAllowed(model)) continue;
        // hasConfiguredAuth takes a MODEL OBJECT, not a spec string — passing
        // the string made every candidate look unauthenticated and the loop
        // fell through to candidates[0].
        if (hasAuth && !(reg.hasConfiguredAuth as (m: unknown) => boolean)(model ?? candidate)) continue;
        return spec;
      }
    } catch {
      // Resolution failed — try the next candidate.
    }
  }

  // All candidates failed → fall back to a model the registry can ACTUALLY
  // run instead of returning candidates[0] (a spec that pdw will promptly
  // reject with MODEL_NOT_FOUND and kill the whole parallel run). The pinned
  // candidates (e.g. anthropic/claude-fable-5:max, onekey/*) are judged-tier
  // models that exist in the user's full registry but NOT in a minimal
  // one — a wave / shard review must degrade to an authenticatable model
  // present in this registry, not die. Only when the registry offers nothing
  // usable does the legacy fail-safe (candidates[0], pdw reports its own
  // error) kick in.
  if (hasAuth || typeof reg.getAll === "function") {
    try {
      const all = (reg.getAll as () => unknown[] | undefined)?.();
      if (Array.isArray(all)) {
        const usable = all.find((m) => {
          const obj = m as { provider?: unknown; id?: unknown } | null;
          if (!obj || typeof obj.provider !== "string" || typeof obj.id !== "string") return false;
          // Provider allowlist (USER REQUIREMENT): opencode-go only flash.
          if (!isModelAllowed(obj)) return false;
          if (hasAuth && !(reg.hasConfiguredAuth as (m: unknown) => boolean)(obj)) return false;
          return true;
        });
        if (usable) {
          const { provider, id } = usable as { provider: string; id: string };
          // Keep any :thinking suffix the caller pinned (e.g. "...:max");
          // if none, pdw uses its default thinking.
          const suffix = candidates.some((c) => c.includes(":")) ? ":max" : "";
          return `${provider}/${id}${suffix}`;
        }
      }
    } catch {
      // Registry introspection failed — fall through to the legacy path.
    }
  }
  // All candidates failed (or nothing usable in the registry) → return first
  // candidate, pdw will report its own error.
  return candidates[0];
}

/**
 * USER REQUIREMENT — provider-level allowlist: opencode-go bills per model
 * and ONLY `deepseek-v4-flash` is approved for use there. Every other model
 * under that provider is rejected here, so a candidate resolved THROUGH the
 * registry can never silently land on an expensive opencode-go model (the
 * registry lists them all, which is exactly why the naive "first
 * resolvable" pick is unsafe). The last-resort `return candidates[0]` paths
 * (registry null / no resolver / nothing usable) still pass the caller's
 * own pinned spec through unchanged — that is an explicit pin, not a
 * silent choice. All other providers (claude, onekey, ...) are
 * unrestricted.
 */
export function isModelAllowed(model: unknown): boolean {
  if (typeof model !== "object" || model === null) return false;
  const obj = model as { provider?: unknown; id?: unknown };
  if (typeof obj.provider !== "string" || typeof obj.id !== "string") return false;
  if (obj.provider === "opencode-go") return obj.id === "deepseek-v4-flash";
  return true;
}
