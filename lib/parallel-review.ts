/**
 * Parallel shard review (plane 1 of the parallel loop).
 *
 * Replaces the single full-diff reviewer round with a pdw workflow that fans
 * the change out across several L3 reviewers, each auditing a DISJOINT shard
 * of the changed files, then returns every shard's full raw output so the main
 * agent can record them (Phase A semantics: shard verdicts carry NO docSync —
 * the integration review that follows attests it). Worst verdict wins — the
 * same rule as the former single-reviewer round.
 *
 * HARD DEPENDENCY: the pdw engine is the ONLY execution path. A missing or
 * broken engine throws `PdwUnavailableError` (installation guidance) — there
 * is no serial fallback.
 *
 * All shard planning is a pure function over file names so it can be pinned by
 * tests without a workflow engine.
 */

import type { PdwModule } from "./pdw-bridge.ts";

/** One shard: a disjoint set of changed files one reviewer audits. */
export interface ReviewShard {
  label: string;
  files: string[];
  /** One-line context for the shard reviewer (why this shard exists). */
  note: string;
}

export interface ShardReviewPlan {
  shards: ReviewShard[];
  fileCount: number;
}

export interface ShardVerdict {
  gate: "READY" | "BLOCKED" | "NEEDS_HUMAN";
  findings: Array<{
    file: string;
    line: number;
    severity: "P0" | "P1" | "P2" | "Nit";
    issue: string;
  }>;
  notes?: string;
}

export const DEFAULT_REVIEWER_MODEL = "claude-fable-5:max";

/**
 * Split changed files into balanced, disjoint review shards.
 *
 * Balancing uses per-file weights (default 1 per file; callers may pass a
 * size estimate such as changed line counts). The greedy sweep keeps at most
 * `maxShards` shards and never produces an empty shard. A single file always
 * lands in exactly one shard.
 */
export function planReviewShards(
  files: readonly string[],
  opts?: { maxShards?: number; weights?: Record<string, number> },
): ShardReviewPlan {
  const maxShards = Math.max(1, Math.min(opts?.maxShards ?? 4, files.length || 1));
  const weights = opts?.weights ?? {};
  const weightOf = (f: string): number => {
    const w = weights[f];
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 1;
  };
  const total = files.reduce((acc, f) => acc + weightOf(f), 0);
  if (total <= 0 || files.length === 0) return { shards: [], fileCount: 0 };

  const target = total / maxShards;
  const shards: ReviewShard[] = [];
  let current: string[] = [];
  let currentWeight = 0;
  const pushCurrent = (): void => {
    if (current.length > 0) {
      shards.push({
        label: `shard-${shards.length + 1}`,
        files: current,
        note: `${current.length} file(s)`,
      });
      current = [];
      currentWeight = 0;
    }
  };
  for (const file of files) {
    const w = weightOf(file);
    if (current.length > 0 && currentWeight + w > target && shards.length < maxShards - 1) {
      pushCurrent();
    }
    current.push(file);
    currentWeight += w;
  }
  pushCurrent();
  return { shards, fileCount: files.length };
}

/**
 * Verdict JSON schema enforced on every shard reviewer (no docSync: a shard
 * cannot attest the whole change — the integration review does).
 */
export const SHARD_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    gate: { type: "string", enum: ["READY", "BLOCKED", "NEEDS_HUMAN"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          severity: { type: "string", enum: ["P0", "P1", "P2", "Nit"] },
          issue: { type: "string" },
        },
        required: ["file", "line", "severity", "issue"],
      },
    },
    notes: { type: "string" },
  },
  required: ["gate", "findings"],
} as const;

/** Build the review prompt handed to one shard reviewer. */
export function buildShardPrompt(shard: ReviewShard, goalText?: string): string {
  const lines = [
    "You are a shard reviewer in a PARALLEL review run. Audit ONLY the files listed below — other files are covered by other reviewers. Read each file in the worktree, verify from the code (never guess), and report findings with file paths and line numbers.",
    "",
    `Shard ${shard.label} (${shard.note}):`,
    shard.files.map((f) => `- ${f}`).join("\n"),
    "",
    "Review for: correctness, edge cases, test coverage quality, doc sync for THIS shard's behavior, unintended side effects, and impossibility claims (TODO/FIXME/skipped tests).",
    "Do NOT edit any file. Do NOT run tests that write files. bash is read-only inspection only.",
  ];
  if (goalText && goalText.trim()) {
    lines.push("", "Loop goal (accept the change against it, criterion by criterion):", goalText.trim());
  }
  lines.push(
    "",
    "OUTPUT: fenced JSON verdict FIRST (the gate parses it; no docSync field — the integration reviewer attests docs), then a prose review below the fence.",
    'Verdict shape: {"gate": "READY"|"BLOCKED"|"NEEDS_HUMAN", "findings": [{"file": "...", "line": 1, "severity": "P0|P1|P2|Nit", "issue": "..."}], "notes": "<prose review>"}',
    "Severity: P0 = must fix now, P1 = must fix before ship, P2 = should fix, Nit = optional. Any open P0/P1 ⇒ BLOCKED.",
  );
  return lines.join("\n");
}

export interface ShardWorkflowOptions {
  /** Absolute path of the worktree the reviewers read. */
  cwd: string;
  shards: readonly ReviewShard[];
  goalText?: string;
  /** Per-agent model (default claude-fable-5:max). */
  model?: string;
  concurrency?: number;
  /** Injected agent registry (tests). */
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
}

export type ShardReviewOutcome =
  | {
      ok: true;
      shards: Array<{ label: string; output: string; verdict: ShardVerdict | null }>;
      durationMs: number;
      agentCount: number;
      /** Shard labels whose agent call failed (recoverable-null per pdw contract). */
      failedShards?: string[];
    }
  | { ok: false; reason: "workflow-failed"; error?: string };

/**
 * Run the parallel shard review via pdw. The engine is a hard dependency:
 * a missing engine THROWS PdwUnavailableError (installation guidance). A
 * workflow that throws (bad script, agent failure) resolves
 * `ok: false` with `workflow-failed` and the error message.
 */
export async function runParallelShardReview(
  opts: ShardWorkflowOptions,
): Promise<ShardReviewOutcome> {
  const { loadPdw, PdwUnavailableError } = await import("./pdw-bridge.ts");
  // Hard dependency: no serial fallback. A missing/broken engine throws
  // PdwUnavailableError (installation guidance) instead of degrading.
  if (opts.pdwOverride === null) throw new PdwUnavailableError(new Error("forced by test"));
  const pdw = opts.pdwOverride !== undefined ? opts.pdwOverride : await loadPdw();

  const script = generateShardReviewScript({
    shards: opts.shards,
    goalText: opts.goalText,
    model: opts.model ?? DEFAULT_REVIEWER_MODEL,
  });

  const runOptions: Record<string, unknown> = {
    cwd: opts.cwd,
    args: {},
    mainModel: opts.model ?? DEFAULT_REVIEWER_MODEL,
    concurrency: opts.concurrency ?? Math.min(4, Math.max(1, opts.shards.length)),
    agentRetries: 1,
    persistLogs: false,
    // Shard reviewers audit a live worktree: they must never write to it.
    // (agents/reviewer.md allows edit/write; the engine-level denylist is the
    // mechanical backstop on top of the prompt.)
    excludeTools: ["edit", "write", "Edit", "Write", "NotebookEdit", "notebook_edit"],
  };
  if (opts.agentRegistry) runOptions.agentRegistry = opts.agentRegistry;
  if (opts.agent) runOptions.agent = opts.agent;
  if (opts.modelRegistry) runOptions.modelRegistry = opts.modelRegistry;

  // NOTE: PdwUnavailableError is intentionally NOT caught here — it propagates
  // to the tool layer, which reports the installation error. Only workflow
  // execution failures resolve as ok:false.
  try {
    const result = await pdw.runWorkflow(script, runOptions);
    const raw = Array.isArray(result.result) ? result.result : [];
    const entries = raw.filter(
      (entry): entry is { label: string; result: unknown } =>
        typeof entry === "object" && entry !== null && typeof (entry as { label?: unknown }).label === "string",
    );
    const failedLabels = entries.filter((e) => e.result === null).map((e) => e.label);
    const shards = entries
      .filter((e) => e.result !== null)
      .map((entry) => {
        // PRODUCTION SHAPE: pdw's default WorkflowAgent returns the structured
        // value ITSELF for a schema'd agent() (resolveStructuredOutput's
        // capture.value) — not a {text, structured} wrapper. Tests inject a
        // runner that mirrors that shape; tolerate both defensively.
        const result = entry.result as unknown;
        const structured =
          typeof result === "object" && result !== null && "structured" in (result as Record<string, unknown>)
            ? (result as Record<string, unknown>).structured
            : result;
        const text =
          typeof result === "object" && result !== null && typeof (result as Record<string, unknown>).text === "string"
            ? ((result as Record<string, unknown>).text as string)
            : JSON.stringify(structured ?? null);
        return {
          label: entry.label,
          output: text,
          verdict: parseShardVerdict(structured),
        };
      });
    if (shards.length === 0 && failedLabels.length > 0) {
      return {
        ok: false,
        reason: "workflow-failed",
        error: `all shard reviewers failed (${failedLabels.join(", ")})`,
      };
    }
    return {
      ok: true,
      shards,
      durationMs: result.durationMs,
      agentCount: result.agentCount,
      failedShards: failedLabels,
    };
  } catch (err) {
    return { ok: false, reason: "workflow-failed", error: (err as Error).message };
  }
}

/** Parse a structured shard result into a verdict, tolerating malformed data. */
export function parseShardVerdict(structured: unknown): ShardVerdict | null {
  if (typeof structured !== "object" || structured === null) return null;
  const s = structured as Record<string, unknown>;
  if (s.gate !== "READY" && s.gate !== "BLOCKED" && s.gate !== "NEEDS_HUMAN") return null;
  const findings = Array.isArray(s.findings)
    ? s.findings.filter((f): f is ShardVerdict["findings"][number] => {
        if (typeof f !== "object" || f === null) return false;
        const rec = f as Record<string, unknown>;
        return (
          typeof rec.file === "string" &&
          typeof rec.line === "number" &&
          (rec.severity === "P0" || rec.severity === "P1" || rec.severity === "P2" || rec.severity === "Nit") &&
          typeof rec.issue === "string"
        );
      })
    : [];
  return {
    gate: s.gate,
    findings,
    notes: typeof s.notes === "string" ? s.notes : undefined,
  };
}

/**
 * Render every shard's full raw output as one recordable review block — the
 * Phase A record the main agent feeds to `record_review` (shard fences omit
 * docSync by design; the integration review's record carries it).
 *
 * record_review's parser only recognizes fenced JSON, and a production shard
 * result arrives as a bare structured value — so any shard output that does
 * not already carry a ```json fence gets wrapped in one. The verdict object
 * inside is preserved verbatim.
 */
export function formatShardReviewRecord(
  shards: Array<{ label: string; output: string }>,
): string {
  return shards
    .map((s) => {
      const raw = s.output.trim();
      const fenced = /```(?:json)?\s*\n/.test(raw) ? raw : "```json\n" + raw + "\n```";
      return `### ${s.label}\n\n${fenced}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Generate the workflow script source for a parallel shard review run.
 * Pure string builder so tests can pin the script's shape without an engine.
 */
export function generateShardReviewScript(args: {
  shards: readonly ReviewShard[];
  goalText?: string;
  model?: string;
}): string {
  const model = args.model ?? DEFAULT_REVIEWER_MODEL;
  const shardDefs = args.shards.map((shard) => ({
    label: shard.label,
    prompt: buildShardPrompt(shard, args.goalText),
  }));
  return `export const meta = {
  name: 'parallel_shard_review',
  description: 'Parallel L3 shard review of a change',
  phases: [{ title: 'Shard reviews' }],
}

const VERDICT_SCHEMA = ${JSON.stringify(SHARD_VERDICT_SCHEMA, null, 2)}

const shardDefs = ${JSON.stringify(shardDefs, null, 2)}

phase('Shard reviews')
const results = await parallel(shardDefs.map((def) => () =>
  agent(def.prompt, {
    label: def.label,
    model: ${JSON.stringify(model)},
    agentType: 'reviewer',
    schema: VERDICT_SCHEMA,
  }).then((r) => ({ label: def.label, result: r })),
))

return results
`;
}
