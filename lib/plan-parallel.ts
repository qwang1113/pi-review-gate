/**
 * Patch-first parallel workers — wave daily (plane 2 of the parallel loop).
 *
 * Serial module execution (/plan-next, one worker at a time) is the other
 * latency bottleneck. Plane 2 keeps the "exactly one writer in the worktree"
 * invariant while parallelizing the expensive part:
 *
 *   wave workers (read-only: tools allowlist has no edit/write/bash) each
 *   produce unified git diffs for their module → the main agent VALIDATES
 *   every patch (declared path ∪ diff headers ⊆ owned_paths, `git apply
 *   --check`) and applies them in sequence with per-patch validation (no
 *   cross-patch rollback transaction) → records status/worklog. The worktree
 *   still has exactly one writer: the main agent.
 *
 * Wave daily: the agent may dispatch wave workers for ANY task that can be
 * split into ≤4 modules with disjoint owned_paths, not just decompose plans.
 *
 * Wave scheduling is a pure function over `depends_on`: all pending modules
 * whose dependencies are implemented/ accepted form the next wave and run
 * concurrently (bounded by `maxWaveSize`).
 *
 * NO ENGINE HERE. The wave runs as N ordinary subagents of the static
 * READ-ONLY agent `agents/worker-readonly.md` (pi-subagents has no per-call
 * tool denylist, so the worker's read-only-ness lives in its `tools:`
 * allowlist — see `agents/worker.md` for the SERIAL single-writer role, which
 * a wave must never launch). What remains in this file is pure and tested:
 * the wave computation, the worker prompt, the structured-output schema, the
 * patch-ownership validation and the git-apply helpers. The plan/apply flow
 * lives in the extension tools `prepare_wave` + `apply_wave_patches` (see
 * docs/handoff-remove-pdw.md, step 2).
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLAN_DIR } from "./plan-state.ts";

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
    "- selfcheck: for EVERY must_have in your brief, met (true/false) and evidence (a command you would run and its expected output, a test that would fail without the change, the exact symbol).",
  );
  return lines.join("\n");
}

// NOTE: `runWaveWorkflow` and the pdw engine wrapper used to live here. The
// engine is gone (docs/handoff-remove-pdw.md, step 2): a wave now runs as N
// ordinary subagents of `agents/worker-readonly.md` — one per module, spawned
// by the MAIN AGENT in the SAME turn (async), with `WAVE_WORKER_SCHEMA` as
// each spawn's outputSchema. The extension tools `prepare_wave` (plan + per-
// module ready-made task text) and `apply_wave_patches` (ownership validation
// + patch persistence + git apply --check + failedModules) split the old
// runWaveWorkflow contract into the prepare → spawn → verify shape that
// reviews already use. The pure layer below (prompt, schema, ownership,
// apply) is unchanged and still unit-tested.

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

// ---------- apply_wave_patches reconciliation (pure, tested) ----------

/**
 * Wave modules whose id is NOT in the plan. With a plan in play, the wave may
 * only contain planned modules — an unplanned id means the driver invented
 * the wave (or passed a stale list), and its owned_paths were never
 * user-approved. Fail-closed: apply_wave_patches refuses such a list.
 */
export function unplannedModuleIds(
  modules: readonly { id: string }[],
  planIds: ReadonlySet<string>,
): string[] {
  return modules.filter((m) => !planIds.has(m.id)).map((m) => m.id);
}

/**
 * Result entries whose moduleId is not part of the wave. A worker answering
 * for the wrong module (or the driver mixing two waves' results) must never
 * be silently dropped — that would mislead the failedModules report.
 */
export function unknownResultModuleIds(
  results: readonly { moduleId: string }[],
  waveIds: ReadonlySet<string>,
): string[] {
  return results.filter((r) => !waveIds.has(r.moduleId)).map((r) => r.moduleId);
}

/**
 * ModuleIds that appear more than once in the results array. A driver passing
 * two results for one module is a handoff defect (two workers answering the
 * same module, or a duplicated entry); the previous behavior silently
 * last-wins via the Map — fail-closed instead.
 */
export function duplicateResultModuleIds(results: readonly { moduleId: string }[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const r of results) {
    if (seen.has(r.moduleId)) dupes.add(r.moduleId);
    else seen.add(r.moduleId);
  }
  return [...dupes];
}

/**
 * Owned paths for the wave, taken from the plan when one is given: the driver
 * cannot redefine a module's owned paths after the user approved them.
 * Falls back to the caller-declared paths only for modules absent from the
 * plan (defensive; callers that pass a state_file already reject those).
 */
export function ownedPathsFromPlan(
  modules: readonly { id: string; ownedPaths: string[] }[],
  plan?: { modules: readonly { id: string; owned_paths: string[] }[] },
): Map<string, string[]> {
  const ownedBy = new Map(modules.map((m) => [m.id, m.ownedPaths]));
  if (!plan) return ownedBy;
  const byState = new Map(plan.modules.map((m) => [m.id, m.owned_paths]));
  for (const m of modules) {
    const owned = byState.get(m.id);
    if (owned) ownedBy.set(m.id, owned);
  }
  return ownedBy;
}
