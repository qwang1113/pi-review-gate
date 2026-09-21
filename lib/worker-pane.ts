/**
 * WORKER PANES — the registry, the deterministic session id, and the argv.
 *
 * WHY A REGISTRY AT ALL. Every promise `worker_submit` makes to the caller is
 * a promise about a LATER call: `worker_close` has to find the pane, and
 * re-submitting the same worker id has to open THE SAME session again rather
 * than a fresh one. Neither is derivable from the environment of the session
 * that dispatched it, so it is written down — one JSON file per repo, exactly
 * like the judge registry, and parsed fail-closed for the same reason: a
 * half-read entry that names the wrong pane is worse than no entry, because
 * `worker_close` would kill somebody else's session.
 *
 * THE SESSION ID IS DERIVED FROM THE WORKER ID (`rg-worker-<id>`), which is
 * what makes resume free: a closed pane is re-opened with the same
 * `--session-id`, and pi continues the same transcript — the worker keeps
 * everything it read, so the second question costs nothing to re-explain.
 * `--session-dir` is derived too, and it is the OTHER half of the key: the id
 * alone finds nothing if the transcript directory is not the one it was
 * written to.
 */

import type { PaneRunResult } from "./session-factory.ts";

/** Repo-root-relative location of the worker registry (gate-excluded via `.pi/`). */
export const WORKER_REGISTRY_RELPATH = ".pi/worker-sessions.json";

/** One dispatched worker. Every field is needed to close or resume it. */
export interface WorkerEntry {
  workerId: string;
  /** The configured preset it was launched as (`worker`, `worker-recon`, …). */
  role: string;
  /** The model spec that was actually launched, for the record and the receipt. */
  model: string;
  paneId: string;
  sessionId: string;
  repoRoot: string;
  createdAt: string;
  /**
   * When this worker's LAST report landed (opener-side write). Absent ⇒ it has
   * never reported, which is exactly the state `worker_wait` distinguishes from
   * "reported and I already consumed it".
   */
  reportedAt?: string;
}

export type WorkerRegistry = Record<string, WorkerEntry>;

/** A worker id the gate will accept: one path-safe token. */
export const WORKER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Is this a worker id a channel file, a session id and a pane title can carry? */
export function isWorkerId(value: unknown): value is string {
  return typeof value === "string" && WORKER_ID_PATTERN.test(value);
}

/**
 * The pi session id for a worker — DETERMINISTIC, which is the whole resume
 * mechanism. Two dispatches with the same worker id are the same conversation;
 * naming it after the role or the clock would silently start a new one.
 */
export function workerSessionId(workerId: string): string {
  return `rg-worker-${workerId}`;
}

/**
 * Read the registry back from disk. FAIL-CLOSED PER ENTRY: a malformed record
 * is DROPPED (the worker is treated as unknown) rather than repaired into a
 * guess — a worker entry that names a wrong pane turns `worker_close` into a
 * kill aimed at somebody else's session.
 */
export function parseWorkerRegistry(raw: unknown): WorkerRegistry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const source = (raw as { workers?: unknown }).workers;
  if (typeof source !== "object" || source === null || Array.isArray(source)) return {};
  const out: WorkerRegistry = {};
  for (const [id, value] of Object.entries(source as Record<string, unknown>)) {
    if (!isWorkerId(id)) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const e = value as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const role = str(e.role);
    const model = str(e.model);
    const paneId = str(e.paneId);
    const sessionId = str(e.sessionId);
    const repoRoot = str(e.repoRoot);
    const createdAt = str(e.createdAt);
    if (!role || !model || !paneId || !sessionId || !repoRoot || !createdAt) continue;
    const reportedAt = str(e.reportedAt);
    out[id] = {
      workerId: id, role, model, paneId, sessionId, repoRoot, createdAt,
      ...(reportedAt === undefined ? {} : { reportedAt }),
    };
  }
  return out;
}

/** The shape written back to disk — one place, so read and write cannot drift. */
export function serializeWorkerRegistry(registry: WorkerRegistry): string {
  return `${JSON.stringify({ schema: 1, workers: registry }, null, 2)}\n`;
}

/** Record a worker WITHOUT mutating the input. */
export function withWorker(registry: WorkerRegistry, entry: WorkerEntry): WorkerRegistry {
  return { ...registry, [entry.workerId]: entry };
}

/** Drop a worker WITHOUT mutating the input (a closed pane is not addressable). */
export function withoutWorker(registry: WorkerRegistry, workerId: string): WorkerRegistry {
  const { [workerId]: _gone, ...rest } = registry;
  return rest;
}

/**
 * The argv a worker pane runs.
 *
 * IT DIFFERS FROM A JUDGE PANE IN EXACTLY ONE FLAG, and that flag is the
 * contract: `--exclude-tools edit,write` is present in both (a worker is
 * read-only, and the tool surface — not a rule — is what enforces it), and a
 * worker adds nothing else. No summarised brief, no `--system-prompt` from a
 * role file: the prompt is built by lib/worker-side.ts from the configured
 * preset, and the task arrives as pi's own `@file` message, so nothing the
 * user typed is ever quoted onto a command line.
 */
export function buildWorkerPaneCommand(opts: {
  sessionId: string;
  taskPath: string;
  sessionDir: string;
  sysPromptPath: string;
  model: string;
  piBin?: string;
}): string[] {
  return [
    opts.piBin ?? "pi",
    "--no-skills",
    "--exclude-tools", "edit,write",
    "--system-prompt", opts.sysPromptPath,
    "--model", opts.model,
    "--session-dir", opts.sessionDir,
    "--session-id", opts.sessionId,
    `@${opts.taskPath}`,
  ];
}

/** What a worker pane's directory is called under the session root. */
export function workerSessionDirName(workerId: string): string {
  return `rg-worker-${workerId}`;
}

/** Unused import guard: the runner type is part of this module's contract. */
export type WorkerPaneRunner = (argv: readonly string[]) => PaneRunResult;
