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

/** The job a worker pane runs — the argv a runner executes. */
export type WorkerPaneRunner = (argv: readonly string[]) => PaneRunResult;

/** Repo-root-relative location of the worker registry (gate-excluded via `.pi/`). */
export const WORKER_REGISTRY_RELPATH = ".pi/worker-sessions.json";

/**
 * Where a worker's own files live under `.pi/` — its prompt, its task book, and
 * the pi transcript that makes a reopen CONTINUE the conversation.
 *
 * DELIBERATELY NOT `.pi/judge-sessions/` (reviewer P2, 2026-09-21). That root
 * is swept by the judge lifecycle, whose staleness rule deletes a directory
 * whose name ends in `-<8 hex>` and is not in the judge registry — and a
 * perfectly legal worker id like `abc12345` renders `rg-worker-worker-abc12345`,
 * which is exactly that shape. A worker's transcript being removed by another
 * feature's cleanup is a silent loss of the thing resume is made of.
 */
export const WORKER_SESSION_ROOT = "worker-sessions";

/** One dispatched worker. Every field is needed to close or resume it. */
export interface WorkerEntry {
  workerId: string;
  /**
   * WHO OWNS THIS WORKER'S CHANNEL — written at dispatch and read back from
   * here afterwards, never re-derived from the environment (reviewer P1,
   * 2026-09-21). Deriving it meant `TMUX_PANE`, which every restart, every
   * re-attach and every handover changes: the worker's report would land on a
   * channel nobody reads any more, and the caller would wait forever on an
   * empty one. It is stored so the conversation survives the opener's pane
   * changing under it.
   */
  openerId: string;
  /** The configured preset it was launched as (`worker`, `worker-recon`, …). */
  role: string;
  /** The model spec that was actually launched, for the record and the receipt. */
  model: string;
  /**
   * The pane this worker currently runs in, or `undefined` when its pane has
   * been CLOSED (2026-09-21, reviewer P1).
   *
   * Closing a pane is not forgetting the worker: the entry keeps the channel
   * owner, the session id and the report cursor, which is exactly what a later
   * `worker_submit` with the same id needs to RESUME the same conversation
   * instead of forking a new one on a new channel.
   */
  paneId?: string;
  /**
   * The tmux SERVER this pane id came from, when the caller knows it.
   *
   * A pane id is minted by a server: after a restart `%42` can belong to
   * somebody else's session entirely, so `worker_close` compares this before
   * killing (reviewer P2, 2026-09-21). Same rule as the judge registry.
   */
  tmuxServer?: string;
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
    const openerId = str(e.openerId);
    const role = str(e.role);
    const model = str(e.model);
    const sessionId = str(e.sessionId);
    const repoRoot = str(e.repoRoot);
    const createdAt = str(e.createdAt);
    // `paneId` is OPTIONAL since 2026-09-21: a closed worker keeps its entry
    // (channel owner, session id, report cursor) with no pane.
    if (!openerId || !role || !model || !sessionId || !repoRoot || !createdAt) continue;
    const paneId = str(e.paneId);
    const reportedAt = str(e.reportedAt);
    const tmuxServer = str(e.tmuxServer);
    out[id] = {
      workerId: id, openerId, role, model, sessionId, repoRoot, createdAt,
      ...(paneId === undefined ? {} : { paneId }),
      ...(reportedAt === undefined ? {} : { reportedAt }),
      ...(tmuxServer === undefined ? {} : { tmuxServer }),
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

/* `withoutWorker` WAS HERE, AND IS DELETED (2026-09-21, reviewer P1).
 *
 * It removed a worker from the registry outright, and `worker_close` was its
 * only caller — which was the bug: closing a pane releases SCREEN SPACE, not
 * the conversation, and the entry carries the channel owner, the session id
 * and the consumed-report cursor a later resume needs. The close path now
 * clears `paneId` and keeps everything else. It is deleted rather than kept
 * for a hypothetical caller, because its obvious use IS the mistake. */

/**
 * The argv a worker pane runs.
 *
 * ── THE READ-ONLY SET IS THREE TOOLS WIDE, NOT TWO (reviewer P1, 2026-09-21) ──
 *
 * `--exclude-tools edit,write` is what every reviewing role in this gate gets,
 * and for a JUDGE it is enough to call the pane read-only in the sense that
 * matters there: a judge does not write, and its `bash` exists to VERIFY (run
 * the test, check the build) — the gate's own arbitration proxy, which must not
 * run anything, appends `bash` to the same list (`PROXY_ISOLATION_FLAGS`,
 * lib/arbitration.ts).
 *
 * A WORKER'S contract is stronger than a judge's — the user asked for sessions
 * that cannot write at all, which is what makes several of them safe to run
 * beside the main agent — and `edit`/`write` alone cannot deliver it: `bash`
 * writes files (`echo > f`, `sed -i`, `git checkout --`), so a worker that kept
 * it could quietly invalidate the very review binding this design exists to
 * protect. Excluding it is what makes the promise true rather than nominal.
 *
 * WHAT A WORKER LOSES, said plainly: it cannot run commands. Read, grep, find
 * and ls are the whole surface, which covers what a worker is FOR (read these
 * files, list those call sites, tell me which of them parse the config). A
 * question that genuinely needs a command run — a test, a git history — is the
 * main session's to answer, and a worker that hit one writes down that it did
 * instead of guessing.
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
    "--exclude-tools", "edit,write,bash",
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
