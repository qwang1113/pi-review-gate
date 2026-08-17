/**
 * Progress sink for pdw embedded runs — now only `run_wave_workflow` (review
 * left the engine, so `run_parallel_shard_review` no longer exists; this file
 * retires with the engine, see docs/handoff-remove-pdw.md).
 *
 * The engine's runWorkflow accepts live callbacks (onLog / onPhase /
 * onRuntimeEvent / onAgentStart / onAgentEnd) that pi-review-gate previously
 * ignored — the parallel tools were a black box until the workflow returned.
 * This helper converts those callbacks into:
 *
 *   1. a live ndjson event file under `.pi/pdw-progress/<runId>.ndjson` —
 *      tail -f from another terminal while the tool call is still blocking;
 *   2. compact one-line status summaries for the tool's `onUpdate` streaming
 *      (the parallel tools are synchronous by contract, so streaming is the
 *      ONLY live progress surface inside the chat).
 *
 * The sink OWNS its runId: the caller must pass the same runId into the
 * runWorkflow options so the engine's own log file
 * (~/.pi/workflows/projects/<key>/runs/<runId>.log — persistLogs defaults
 * true) and the ndjson share one identity. The engine accepts an explicit
 * runId verbatim (workflow.ts: `options.runId ?? run-...`), so the caller
 * always mints one via `newPdwRunId()`.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { gitRootOfDir } from "./repo-resolve.ts";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** One line of the ndjson progress file. */
export type PdwProgressEvent =
  | { t: string; runId: string; type: "phase"; title: string }
  | { t: string; runId: string; type: "log"; message: string }
  | { t: string; runId: string; type: "runtime"; detail: string }
  | { t: string; runId: string; type: "agent-start"; label: string; phase?: string; model?: string }
  | { t: string; runId: string; type: "agent-end"; label: string; phase?: string; model?: string; tokens?: number; durationMs?: number }
  | { t: string; runId: string; type: "agent-fail"; label: string; phase?: string; model?: string; tokens?: number; durationMs?: number; error?: string; errorCode?: string; recoverable?: boolean }
  | { t: string; runId: string; type: "run-end" };

/** Minimal structural view of the engine's onAgentStart event. */
export interface AgentStartEvent {
  id?: string;
  label: string;
  phase?: string;
  prompt?: string;
  model?: string;
}

/** Minimal structural view of the engine's onAgentEnd event. */
export interface AgentEndEvent {
  id?: string;
  label: string;
  phase?: string;
  model?: string;
  tokens?: number;
  error?: string;
  errorCode?: string;
  recoverable?: boolean;
}

export interface PdwProgressSink {
  runId: string;
  /** Absolute path of the live ndjson event file. */
  progressFile: string;
  /** Best-effort engine log path (persistLogs defaults true). */
  engineLogFile: string;
  events: readonly PdwProgressEvent[];
  /** Total agent() calls expected (shard count / module count). */
  setTotal(total: number): void;
  /** One-line human status for tool streaming. */
  summary(): string;
  append(event: PdwProgressEvent): void;
  /** Append the terminal run-end event. Call in a finally. */
  done(): void;
  /** Spread into runWorkflow options to wire the engine to the sink. */
  callbacks: {
    onLog(message: string): void;
    onPhase(title: string): void;
    onRuntimeEvent(event: unknown): void;
    onAgentStart(event: AgentStartEvent): void;
    onAgentEnd(event: AgentEndEvent): void;
  };
}

/** Mint a runId safe for use in file names (engine uses it verbatim). */
export function newPdwRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Mirror of pdw's workflowProjectKey (basename slug + sha256 prefix) so the
 * sink can point at the engine's own `<runId>.log` without importing engine
 * internals. If the engine ever changes the scheme, this stays a best-effort
 * hint — the ndjson progressFile is the authoritative artifact.
 */
function workflowProjectKey(cwd: string): string {
  const projectPath = resolve(cwd);
  const slug =
    (basename(projectPath) || "project")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project";
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

/** Absolute path of the engine's persisted log for a run (persistLogs true). */
export function engineLogFileFor(cwd: string, runId: string): string {
  return join(homedir(), ".pi", "workflows", "projects", workflowProjectKey(cwd), "runs", `${runId}.log`);
}

/**
 * Resolve the directory that owns the `.pi` progress tree. The gate's
 * fingerprint excludes `:/.pi` at the GIT ROOT — so anchoring the ndjson to
 * `opts.cwd` would leave it INSIDE the fingerprint when the session cwd is a
 * repo subdirectory, invalidating the very READY binding the run serves.
 * Resolve the git root and fall back to the cwd when it is not a repo
 * (tests, non-git worktrees).
 */
export function resolveProgressRoot(cwd: string): string {
  // Reuse the hardened repo-root resolver: it runs git with a sanitized env
  // (gitBaseEnv strips GIT_DIR/GIT_WORK_TREE/GIT_CONFIG*) so an ambient
  // variable cannot relocate the progress root outside the fingerprint's
  // `:/.pi` exclusion and reopen the very self-deadlock this fix targets.
  const root = gitRootOfDir(cwd);
  if (root) return root;
  return resolve(cwd);
}

export interface ProgressAttachOptions {
  /** Total agent() calls expected (shard count / module count). */
  total: number;
  /** Live progress callback (the tool layer's `onUpdate`). */
  onProgress?: (text: string, progress?: number) => void;
  /** Throttle window for log-driven pushes (default 500ms). */
  throttleMs?: number;
}

/**
 * Build the runWorkflow callback set wired to a sink + the caller's
 * onProgress — shared by runParallelShardReview and runWaveWorkflow so the
 * ~35 lines of identical wiring cannot drift between the two files.
 */
export function buildRunProgressCallbacks(sink: PdwProgressSink, opts: ProgressAttachOptions): {
  onLog(message: string): void;
  onPhase(title: string): void;
  onRuntimeEvent(event: unknown): void;
  onAgentStart(event: AgentStartEvent): void;
  onAgentEnd(event: AgentEndEvent): void;
} {
  const progress = (text: string, pct?: number): void => {
    opts.onProgress?.(text, pct);
  };
  let lastLogPushAt = 0;
  const throttleMs = opts.throttleMs ?? 500;
  const settled = (): number =>
    sink.events.filter((e) => e.type === "agent-end" || e.type === "agent-fail").length;
  return {
    onLog(message: string) {
      sink.callbacks.onLog(message);
      // Throttle log-driven summary pushes (logs can be chatty; the ndjson
      // file still records every line).
      const nowMs = Date.now();
      if (nowMs - lastLogPushAt >= throttleMs) {
        lastLogPushAt = nowMs;
        progress(sink.summary());
      }
    },
    onPhase(title: string) {
      sink.callbacks.onPhase(title);
      progress(sink.summary());
    },
    onRuntimeEvent(event: unknown) {
      sink.callbacks.onRuntimeEvent(event);
    },
    onAgentStart(event: AgentStartEvent) {
      sink.callbacks.onAgentStart(event);
      progress(sink.summary());
    },
    onAgentEnd(event: AgentEndEvent) {
      sink.callbacks.onAgentEnd(event);
      progress(sink.summary(), Math.min(100, Math.round((settled() / Math.max(1, opts.total)) * 100)));
    },
  };
}

const now = (): string => new Date().toISOString();

export function createProgressSink(cwd: string, runId: string): PdwProgressSink {
  const base = resolveProgressRoot(cwd); // git root, so the gate fingerprint excludes it
  const progressFile = join(base, ".pi", "pdw-progress", `${runId}.ndjson`);
  const progressDir = join(base, ".pi", "pdw-progress");
  // Progress is best-effort, period: a read-only cwd, ENOSPC or a `.pi` that
  // is a regular file must NEVER abort the review/wave run itself. mkdir is
  // as fallible as the appends below — keep it inside the same silent
  // degradation so createProgressSink cannot throw.
  try {
    mkdirSync(progressDir, { recursive: true });
    // Create the file eagerly so `tail -f` from another terminal works before
    // the first event lands (appendFileSync creates it on demand otherwise).
    appendFileSync(progressFile, "", "utf8");
  } catch {
    // Progress is best-effort; never fail a run over it.
  }

  const events: PdwProgressEvent[] = [];
  let total = 0;
  let doneCount = 0;
  let failedCount = 0;
  // Per-agent bookkeeping keyed by the ENGINE event id (`${runId}:${callIndex}`,
  // unique per agent() call) — the engine contract explicitly says to key on
  // id, never on label, because concurrent fan-out may reuse a label. Events
  // without an id (tests, defensive path) fall back to the label.
  const active = new Map<string, string>(); // id → label (for the active list)
  let lastEvent = "";
  // Per-agent wall-clock timing: the engine events carry no duration, so the
  // sink times agents itself (start time → end time, keyed by label).
  const startTimes = new Map<string, number>(); // id → wall-clock start

  const formatDuration = (ms: number): string =>
    ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

  const append = (event: PdwProgressEvent): void => {
    events.push(event);
    try {
      appendFileSync(progressFile, `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      // Progress is best-effort; never fail a run over it.
    }
  };

  const describeLast = (label: string, ok: boolean, extra: string): void => {
    lastEvent = `${label} ${ok ? "done" : "FAILED"}${extra ? ` (${extra})` : ""}`;
  };

  const sink: PdwProgressSink = {
    runId,
    progressFile,
    engineLogFile: engineLogFileFor(cwd, runId),
    events,
    setTotal(n: number) {
      total = n;
    },
    summary() {
      const parts: string[] = [];
      if (total > 0) parts.push(`${doneCount + failedCount}/${total} agents`);
      if (active.size > 0) parts.push(`active: ${[...active.values()].join(", ")}`);
      if (lastEvent) parts.push(`last: ${lastEvent}`);
      return `[${runId}] ${parts.join(" · ")}`;
    },
    append,
    done() {
      append({ t: now(), runId, type: "run-end" });
    },
    callbacks: {
      onLog(message: string) {
        append({ t: now(), runId, type: "log", message: String(message).slice(0, 500) });
      },
      onPhase(title: string) {
        append({ t: now(), runId, type: "phase", title: String(title).slice(0, 200) });
      },
      onRuntimeEvent(event: unknown) {
        let detail = "";
        try {
          detail = JSON.stringify(event) ?? String(event);
        } catch {
          detail = String(event);
        }
        // JSON.stringify(undefined) returns undefined rather than throwing —
        // the ?? above keeps detail a string so .slice can never throw.
        append({ t: now(), runId, type: "runtime", detail: detail.slice(0, 400) });
      },
      onAgentStart(event: AgentStartEvent) {
        const label = String(event?.label ?? "?");
        const key = event?.id ?? label;
        active.set(key, label);
        startTimes.set(key, Date.now());
        append({ t: now(), runId, type: "agent-start", label, phase: event.phase, model: event.model });
      },
      onAgentEnd(event: AgentEndEvent) {
        const label = String(event?.label ?? "?");
        const key = event?.id ?? label;
        active.delete(key);
        if (event?.error) {
          const startedAt = startTimes.get(key);
          startTimes.delete(key);
          const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
          const model = event?.model ? `[${event.model}] ` : "";
          const dur = durationMs !== undefined ? formatDuration(durationMs) : "";
          failedCount += 1;
          const code = event.errorCode ?? event.error;
          describeLast(label, false, `${model}${code}${dur ? ` ${dur}` : ""}`);
          append({
            t: now(),
            runId,
            type: "agent-fail",
            label,
            phase: event.phase,
            model: event.model,
            tokens: event.tokens,
            durationMs,
            error: String(event.error).slice(0, 300),
            errorCode: event.errorCode,
            recoverable: event.recoverable,
          });
        } else {
          const startedAt = startTimes.get(key);
          startTimes.delete(key);
          const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
          const model = event?.model ? `[${event.model}] ` : "";
          const dur = durationMs !== undefined ? formatDuration(durationMs) : "";
          const tok = event?.tokens ? `, ${event.tokens} tok` : "";
          doneCount += 1;
          describeLast(label, true, `${model}${dur}${tok}`);
          append({
            t: now(),
            runId,
            type: "agent-end",
            label,
            phase: event.phase,
            model: event.model,
            tokens: event.tokens,
            durationMs,
          });
        }
      },
    },
  };

  return sink;
}
