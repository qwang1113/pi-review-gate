/**
 * Patch-first parallel workers — wave daily (plane 2 of the parallel loop).
 *
 * Serial module execution (/plan-next, one worker at a time) is the other
 * latency bottleneck. Plane 2 keeps the "exactly one writer in the worktree"
 * invariant while parallelizing the expensive part:
 *
 *   wave workers (read-only, edit/write AND bash excluded) each produce unified
 *   git diffs for their module → the main agent VALIDATES every patch (declared
 *   path ∪ diff headers ⊆ owned_paths, `git apply --check`) and applies them
 *   in sequence with per-patch validation (no cross-patch rollback transaction)
 *   → records status/worklog. The worktree still has exactly one writer: the
 *   main agent.
 *
 * Wave daily: the agent may dispatch wave workers for ANY task that can be
 * split into ≤4 modules with disjoint owned_paths, not just decompose plans.
 *
 * Wave scheduling is a pure function over `depends_on`: all pending modules
 * whose dependencies are implemented/ accepted form the next wave and run
 * concurrently (bounded by `maxWaveSize`).
 *
 * HARD DEPENDENCY: like plane 1, the pdw engine is the only execution path —
 * a missing engine throws `PdwUnavailableError` (installation guidance), never
 * a serial one-worker-per-step protocol.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLAN_DIR } from "./plan-state.ts";
import { sanitizeInjectedWorkflowText } from "./pdw-bridge.ts";
import type { PdwModule } from "./pdw-bridge.ts";
import { buildRunProgressCallbacks, createProgressSink, newPdwRunId } from "./pdw-progress.ts";

/** A module's minimal shape for wave planning. */
export interface WaveModule {
  id: string;
  status: string;
  depends_on: string[];
}

export interface WavePlan {
  /** Module ids of the current wave, in a stable order. */
  wave: string[];
  /** True when no pending module remains outside this wave (all pending are scheduled or none left). */
  allDone: boolean;
}

const READY_STATUSES = new Set(["implemented", "accepted"]);

/**
 * Compute the next executable wave: every pending module whose dependencies
 * are all implemented/accepted. Pure and deterministic (input order kept).
 * Defensive against cycles (a module whose dependency never reaches READY
 * simply never enters a wave — the plan validator already rejects cycles).
 */
export function computeWave(
  modules: readonly WaveModule[],
  opts?: { maxWaveSize?: number },
): WavePlan {
  const maxWaveSize = Math.max(1, opts?.maxWaveSize ?? 4);
  const statusBy = new Map(modules.map((m) => [m.id, m.status]));
  const wave: string[] = [];
  for (const m of modules) {
    if (m.status !== "pending") continue;
    const depsReady = m.depends_on.every((d) => {
      const s = statusBy.get(d);
      return s !== undefined && READY_STATUSES.has(s);
    });
    if (!depsReady) continue;
    wave.push(m.id);
    if (wave.length >= maxWaveSize) break;
  }
  const remainingPending = modules.some((m) => m.status === "pending" && !wave.includes(m.id));
  return { wave, allDone: !remainingPending };
}

/** One patch produced by a wave worker. */
export interface WorkerPatch {
  path: string;
  diff: string;
}

export interface WaveWorkerResult {
  moduleId: string;
  patches: WorkerPatch[];
  summary: string;
  selfcheck: Array<{ must_have: string; met: boolean; evidence: string }>;
}

/** Schema enforced on every wave worker's structured output. */
export const WAVE_WORKER_SCHEMA = {
  type: "object",
  properties: {
    patches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          diff: { type: "string" },
        },
        required: ["path", "diff"],
      },
    },
    summary: { type: "string" },
    selfcheck: {
      type: "array",
      items: {
        type: "object",
        properties: {
          must_have: { type: "string" },
          met: { type: "boolean" },
          evidence: { type: "string" },
        },
        required: ["must_have", "met", "evidence"],
      },
    },
  },
  required: ["patches", "summary", "selfcheck"],
} as const;

/** Build the task prompt for one wave worker. */
export function buildWaveWorkerPrompt(args: {
  moduleId: string;
  title: string;
  ownedPaths: readonly string[];
  worklogPath: string;
  goalText?: string;
}): string {
  const lines = [
    "You are a PARALLEL wave worker (patch-first). Every module in your wave runs concurrently; the worktree must stay untouched by you.",
    "",
    `Module: ${args.moduleId} — ${args.title}`,
    `Owned paths (write surface limit): ${args.ownedPaths.join(", ")}`,
    `Task brief + worklog: ${args.worklogPath} (read it first)`,
  ];
  if (args.goalText && args.goalText.trim()) {
    lines.push("", "Loop goal:", args.goalText.trim(), "",
      "Wave daily protocol: you may be part of a non-decompose wave — the same patch-first rules apply. " +
      "Produce unified git diffs for your owned_paths; the main agent validates and applies them.");
  }
  lines.push(
    "",
    "CONSTRAINTS:",
    "- You CANNOT edit, write, or run any shell command: edit/write AND bash tools are disabled. The main agent applies your patches.",
    "- Read whatever you need (brief, code, tests). Reading is free.",
    "- Every file you change must be inside owned_paths. If a fix genuinely needs a path you do not own, omit it and say so in summary.",
    "",
    "OUTPUT (structured):",
    "- patches: one entry per file you change, with path (repo-relative, inside owned_paths) and diff = a complete unified git diff for that file.",
    "  * Modified file: use standard `--- a/<path>` / `+++ b/<path>` headers with @@ hunks and 3 context lines, exactly as git apply expects.",
    "  * New file: `--- /dev/null` / `+++ b/<path>` followed by `@@ -0,0 +1,N @@` and every line prefixed with +.",
    "  * Deleted file: `--- a/<path>` / `+++ /dev/null` and `@@ -1,N +0,0 @@` with - lines.",
    "  Do NOT include diff headers like `diff --git ...`, index lines, or ---/+++ timestamps.",
    "- summary: one line — what you implemented and any deviation or out-of-scope need.",
    "- selfcheck: for EVERY must_have in your brief, met (true/false) and evidence (a command you ran and its output, a test that would fail without the change, the exact symbol).",
  );
  return lines.join("\n");
}

export interface WaveWorkflowOptions {
  cwd: string;
  modules: Array<{
    id: string;
    title: string;
    ownedPaths: string[];
    worklogPath: string;
    model: string;
    goalText?: string;
  }>;
  concurrency?: number;
  agentRegistry?: unknown;
  /** Injected agent runner (tests; production uses pdw's default WorkflowAgent). */
  agent?: unknown;
  /** Shared model registry from the host session (pdw resolves models against it). */
  modelRegistry?: unknown;
  /**
   * Forced engine handle (tests). When provided, bypasses loadPdw entirely:
   * null forces the PdwUnavailableError path deterministically.
   */
  pdwOverride?: PdwModule | null;
  /**
   * Live progress callback (the tool layer's `onUpdate`). `text` is a
   * one-line status; `progress` is a 0-100 percentage when known.
   */
  onProgress?: (text: string, progress?: number) => void;
}

export type WaveWorkflowOutcome =
  | {
      ok: true;
      results: WaveWorkerResult[];
      /** Module ids whose worker agent call failed (recoverable-null per pdw contract). */
      failedModules?: string[];
      durationMs: number;
      agentCount: number;
      /** Run identity — the engine log and the ndjson progress file share it. */
      runId: string;
      /** Absolute path of the live ndjson progress file (.pi/pdw-progress/). */
      progressFile: string;
      /** Best-effort engine log path (~/.pi/workflows/projects/<key>/runs/). */
      engineLogFile: string;
    }
  | {
      ok: false;
      reason: "workflow-failed";
      error?: string;
      /** Run identity + artifacts, also on failure so the caller can locate them. */
      runId: string;
      progressFile: string;
      engineLogFile: string;
    };

/**
 * Run one wave of parallel workers via pdw. Workers are read-only (edit/write
 * excluded at the engine level); their structured output carries the patches.
 */
export async function runWaveWorkflow(
  opts: WaveWorkflowOptions,
): Promise<WaveWorkflowOutcome> {
  const { loadPdw, PdwUnavailableError, resolveBestModel, registryHasModels } = await import("./pdw-bridge.ts");  // Hard dependency: no serial fallback. A missing/broken engine throws
  // PdwUnavailableError (installation guidance) instead of degrading.
  if (opts.pdwOverride === null) throw new PdwUnavailableError(new Error("forced by test"));
  const pdw = opts.pdwOverride !== undefined ? opts.pdwOverride : await loadPdw();

  const defs = await Promise.all(
    opts.modules.map(async (m) => ({
      moduleId: m.id,
      prompt: sanitizeInjectedWorkflowText(buildWaveWorkerPrompt({
        moduleId: m.id,
        title: m.title,
        ownedPaths: m.ownedPaths,
        worklogPath: m.worklogPath,
        goalText: m.goalText,
      })),
      model: await resolveBestModel(
        [m.model, "onekey/deepseek-v4-pro", "onekey/grok-4.6"],
        opts.modelRegistry,
      ),
    })),
  );

  const script = `export const meta = {
  name: 'wave_workers',
  description: 'Parallel patch-first module workers',
  phases: [{ title: 'Wave workers' }],
}

const WAVE_SCHEMA = ${JSON.stringify(WAVE_WORKER_SCHEMA, null, 2)}

const defs = ${JSON.stringify(defs, null, 2)}

phase('Wave workers')
const results = await parallel(defs.map((def) => () =>
  agent(def.prompt, {
    label: def.moduleId,
    model: def.model,
    schema: WAVE_SCHEMA,
  }).then((r) => ({ moduleId: def.moduleId, result: r })),
))

return results
`;

  // Run identity + live progress (same wiring as runParallelShardReview).
  const runId = newPdwRunId();
  const sink = createProgressSink(opts.cwd, runId);
  sink.setTotal(opts.modules.length);
  const progressCallbacks = buildRunProgressCallbacks(sink, {
    total: opts.modules.length,
    onProgress: opts.onProgress,
  });

  const runOptions: Record<string, unknown> = {
    cwd: opts.cwd,
    args: {},
    runId,
    concurrency: opts.concurrency ?? Math.min(4, Math.max(1, opts.modules.length)),
    agentRetries: 1,
    persistAgentSessions: true,
    // Wave workers must be READ-ONLY: edit/write AND bash are excluded at the
    // engine level. agents/worker.md's "only writer" system prompt describes
    // the SERIAL role and must not leak into concurrent waves — so no
    // agentType binding here, the task prompt carries the read-only role.
    excludeTools: [
      "bash",
      "edit", "write", "Edit", "Write", "NotebookEdit", "notebook_edit",
    ],
    ...progressCallbacks,
  };
  if (opts.agentRegistry) runOptions.agentRegistry = opts.agentRegistry;
  if (opts.agent) runOptions.agent = opts.agent;
  // Same sync-facade guard as runParallelShardReview: an unwarmed pi
  // ModelRegistry reports no models and pdw fails every worker with
  // "No models available"; let pdw build its own disk-backed registry.
  if (opts.modelRegistry && registryHasModels(opts.modelRegistry)) {
    runOptions.modelRegistry = opts.modelRegistry;
  }

  try {
    const result = await pdw.runWorkflow(script, runOptions);
    const raw = Array.isArray(result.result) ? result.result : [];
    const entries = raw.filter(
      (entry): entry is { moduleId: string; result: unknown } =>
        typeof entry === "object" && entry !== null && typeof (entry as { moduleId?: unknown }).moduleId === "string",
    );
    // A recoverable-null worker call (pdw's parallel contract) means the
    // module FAILED — it must never be mistaken for "nothing to change".
    const failedModules = entries.filter((e) => e.result === null).map((e) => e.moduleId);
    const results = entries
      .filter((e) => e.result !== null)
      .map((entry) => {
        const r = entry.result as { structured?: unknown } | null;
        return parseWaveWorkerResult(entry.moduleId, r?.structured ?? entry.result);
      });
    return {
      ok: true,
      results,
      failedModules,
      durationMs: result.durationMs,
      agentCount: result.agentCount,
      runId,
      progressFile: sink.progressFile,
      engineLogFile: sink.engineLogFile,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "workflow-failed",
      error: (err as Error).message,
      runId,
      progressFile: sink.progressFile,
      engineLogFile: sink.engineLogFile,
    };
  } finally {
    // Terminal event: the ndjson file is complete and tail -f readers can stop.
    sink.done();
  }
}

/** Parse a worker's structured result, tolerating malformed output. */
export function parseWaveWorkerResult(moduleId: string, structured: unknown): WaveWorkerResult {
  if (typeof structured !== "object" || structured === null) {
    return { moduleId, patches: [], summary: "worker returned no structured result", selfcheck: [] };
  }
  const s = structured as Record<string, unknown>;
  const patches = Array.isArray(s.patches)
    ? s.patches.filter((p): p is WorkerPatch => {
        if (typeof p !== "object" || p === null) return false;
        const rec = p as Record<string, unknown>;
        return typeof rec.path === "string" && typeof rec.diff === "string";
      })
    : [];
  const selfcheck = Array.isArray(s.selfcheck)
    ? s.selfcheck.filter(
        (c): c is WaveWorkerResult["selfcheck"][number] =>
          typeof c === "object" && c !== null &&
          typeof (c as Record<string, unknown>).must_have === "string" &&
          typeof (c as Record<string, unknown>).met === "boolean" &&
          typeof (c as Record<string, unknown>).evidence === "string",
      )
    : [];
  return {
    moduleId,
    patches,
    summary: typeof s.summary === "string" ? s.summary : "",
    selfcheck,
  };
}

/**
 * Files a worker's patches DECLARE (the `path` field).
 *
 * NOTE: git apply writes whatever the diff's own `+++ b/...` headers say,
 * not the declared path — so ownership validation must check the diff
 * headers too (see `diffHeaderFiles`). This function exists for the declared
 * surface; the effective surface is `validatePatchOwnership`'s union.
 */
export function patchFileList(patches: readonly WorkerPatch[]): string[] {
  const files: string[] = [];
  for (const p of patches) {
    if (p.path.trim()) files.push(p.path.trim());
  }
  return files;
}

/**
 * Parse the files a unified diff ACTUALLY touches, from its own headers
 * (`--- a/x` / `+++ b/x`, with `/dev/null` meaning add/delete). This is the
 * effective write surface git apply will honor — validating it is what makes
 * owned_paths mechanically binding rather than a worker's self-report.
 */
export function diffHeaderFiles(diff: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const re = /^[+-]{3}\s+(?:a\/|b\/)?(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    const raw = m[1].trim();
    if (!raw || raw === "/dev/null") continue;
    // Reject path traversal in the header outright.
    if (raw.includes("..")) {
      const marker = "<traversal:" + raw + ">";
      if (!seen.has(marker)) {
        seen.add(marker);
        files.push(marker);
      }
      continue;
    }
    const clean = raw.replace(/^\/\/+/, "").replace(/^[ab]\//, "");
    if (!seen.has(clean)) {
      seen.add(clean);
      files.push(clean);
    }
  }
  return files;
}

/**
 * Validate that every patch's EFFECTIVE write surface (declared path AND the
 * diff's own `+++ b/...`/`--- a/...` headers) is inside the module's owned
 * paths. Pure check over strings; caller applies it before `git apply`.
 */
export function validatePatchOwnership(
  patches: readonly WorkerPatch[],
  ownedPaths: readonly string[],
): { ok: true } | { ok: false; violations: string[] } {
  const violations: string[] = [];
  const owned = (path: string): boolean => {
    const p = path.trim().replace(/^\/+/, "");
    return ownedPaths.some((o) => {
      const owner = o.trim().replace(/^\/+/, "").replace(/\/+$/, "");
      return p === owner || p.startsWith(owner + "/");
    });
  };
  for (const patch of patches) {
    const declared = patch.path.trim().replace(/^\/+/, "");
    if (declared && !owned(declared)) violations.push(declared);
    for (const headerFile of diffHeaderFiles(patch.diff)) {
      if (!owned(headerFile)) violations.push(headerFile);
    }
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/**
 * Run `git apply --check` for a patch file. Resolves true when it applies
 * cleanly. `--recount` is load-bearing: LLM-generated diffs routinely
 * miscount the `@@ -a,b +c,d @@` hunk line counts (measured: 9 of 13 wave
 * patches in the first parallel run), which makes a plain `git apply`
 * report "corrupt patch" even though the content is exact. --recount makes
 * git re-count from the actual lines instead of trusting the header.
 */
export function checkPatchApplies(cwd: string, patchFile: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["apply", "--recount", "--check", "--verbose", patchFile], { cwd }, (err) => {
      resolve(!err);
    });
  });
}

/** Apply a validated patch file. Resolves the git error on failure. */
export function applyPatchFile(cwd: string, patchFile: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile("git", ["apply", "--recount", patchFile], { cwd }, (err) => {
      resolve(err ? { ok: false, error: String(err.message ?? err) } : { ok: true });
    });
  });
}

/**
 * Persist one worker's patches under `.pi/plan/patches/<moduleId>/<n>.patch`
 * (gate-owned dir: excluded from the fingerprint). Returns the written paths.
 */
export function writeWavePatches(planDir: string, moduleId: string, patches: readonly WorkerPatch[]): string[] {
  const out: string[] = [];
  patches.forEach((p, i) => {
    const dir = join(planDir, "patches", moduleId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${String(i + 1).padStart(2, "0")}.patch`);
    writeFileSync(file, p.diff.trimEnd() + "\n", "utf8");
    out.push(file);
  });
  return out;
}

/** Resolve the plan directory for a repo (repo-root-relative `.pi/plan`). */
export function planDirFor(cwd: string): string {
  return join(cwd, PLAN_DIR);
}
