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
