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
        "It ships with this extension — re-run the installer " +
        "(scripts/install-global.sh) or `pi install` the extension so its " +
        "node_modules land next to the extension code." +
        (cause ? ` Original error: ${(cause as Error).message}` : ""),
    );
    this.name = "PdwUnavailableError";
  }
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
      // Resolve against the host registry: "model exists in the user's
      // configuration" is exactly what resolveModelSpecWithThinking checks.
      let model: unknown;
      if (resolver) {
        const resolved = resolver(candidate, registry);
        if (!resolved || !resolved.model || resolved.error) continue;
        model = resolved.model;
      }
      // hasConfiguredAuth takes a MODEL OBJECT, not a spec string — passing
      // the string made every candidate look unauthenticated and the loop
      // fell through to candidates[0].
      if (hasAuth && !(reg.hasConfiguredAuth as (m: unknown) => boolean)(model ?? candidate)) continue;
      return candidate;
    } catch {
      // Resolution failed — try the next candidate.
    }
  }
  // All candidates failed → return first candidate, pdw will report its own error.
  return candidates[0];
}
