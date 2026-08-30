/**
 * Judge-child completion watchers — the wake-up registry behind review_spawn
 * / review_watch, now keyed on PROCESS EXIT EVENTS instead of tmux wait-for
 * channels.
 *
 * WHY THE CHANGE (2026-08-28, tmux removal): a judge is a non-interactive
 * `pi -p` process; its completion is its EXIT — an OS-guaranteed event, not
 * a signal the child may forget to send. The registry keeps the SAME
 * contract as the tmux version:
 *
 *  - `register(sessionId, label)`: one watcher per session id (a
 *    re-registration replaces the old one). When the child's process exits,
 *    the wake callback fires. Unlike the tmux version there is no re-arm:
 *    each spawn owns one exit event; the NEXT round's spawn registers a new
 *    watcher (judge-process.ts spawns a fresh process per round, and the
 *    registry is keyed by session id, so a reused session id gets a fresh
 *    watcher per round).
 *  - `shutdown()`: session teardown — cancels every outstanding watcher.
 *    `reset()` re-opens registration for a NEW session (session_start).
 *
 * The watcher is a thin wrapper over the ChildProcess: `child.on("exit")`
 * with a `child.exitCode` check, so a child that already exited before
 * registration (race) still fires immediately.
 */

/** A cancellable process-exit wait. */
export interface ProcessWaitHandle {
  /** Resolves true on exit, false on cancel. */
  promise: Promise<boolean>;
  /** Remove the exit listener; the promise resolves false. */
  cancel: () => void;
}

/** Watches a ChildProcess; returns a cancellable handle. */
export type ProcessWaiter = (child: { on: (ev: string, fn: (...a: unknown[]) => void) => unknown; exitCode?: number | null }) => ProcessWaitHandle;

/** Delivers the wake message to the pi session (pi.sendMessage). */
export type ProcessWake = (label: string, sessionId: string) => void;

export interface ProcessWatchRegistry {
  /** Currently registered handles, keyed by session id. */
  active: ReadonlyMap<string, ProcessWaitHandle>;
  /** Register (or replace) the watcher for one session id. No-op after shutdown. */
  register(sessionId: string, label: string): void;
  /** Drop ONE session id's watcher (cancel + forget). */
  unregister(sessionId: string): void;
  /** session_shutdown: latch shutdown, cancel handles, clear the registry. */
  shutdown(): void;
  /** session_start: a new session may register watchers again. */
  reset(): void;
}

export function createProcessWatchRegistry(waiter: ProcessWaiter, wake: ProcessWake): ProcessWatchRegistry {
  const active = new Map<string, ProcessWaitHandle>();
  const activeLabels = new Map<string, string>();
  let shuttingDown = false;

  function register(sessionId: string, label: string): void {
    if (shuttingDown) return;
    // Idempotent: same session id with the same label is never re-watched
    // (session_start re-registers the attention channel on every session).
    const existing = active.get(sessionId);
    if (existing && activeLabels.get(sessionId) === label) return;
    existing?.cancel();
    const handle = waiter(childFor(sessionId));
    active.set(sessionId, handle);
    activeLabels.set(sessionId, label);
    handle.promise.then((exited) => {
      if (active.get(sessionId) === handle) {
        active.delete(sessionId);
        activeLabels.delete(sessionId);
      }
      if (!exited) return;
      try {
        wake(label, sessionId);
      } catch {
        /* the session may be shutting down — the watcher is gone anyway */
      }
    });
  }

  function unregister(sessionId: string): void {
    active.get(sessionId)?.cancel();
    active.delete(sessionId);
    activeLabels.delete(sessionId);
  }

  function shutdown(): void {
    shuttingDown = true;
    for (const handle of active.values()) handle.cancel();
    active.clear();
    activeLabels.clear();
  }

  function reset(): void {
    shuttingDown = false;
  }

  return { active, register, unregister, shutdown, reset };
}

/**
 * The ChildProcess registry the watcher consults: session id → live child.
 * Owned by the extension (review-gate.ts), injected here so the watcher
 * stays pure and testable.
 */
const childBySession = new Map<string, { on: (ev: string, fn: (...a: unknown[]) => unknown) => unknown; exitCode?: number | null }>();

/** Remember the live child for a session id (called at spawn). */
export function rememberChildProcess(sessionId: string, child: { on: (ev: string, fn: (...a: unknown[]) => unknown) => unknown; exitCode?: number | null }): void {
  childBySession.set(sessionId, child);
}

/** Forget a session id's child (called at close / after exit). */
export function forgetChildProcess(sessionId: string): void {
  childBySession.delete(sessionId);
}

function childFor(sessionId: string): { on: (ev: string, fn: (...a: unknown[]) => unknown) => unknown; exitCode?: number | null } {
  return childBySession.get(sessionId) ?? {
    on: () => { /* no-op: no live child */ },
    exitCode: null,
  };
}

/** The default waiter: resolve on the child's exit event. */
export function waitForProcessExit(child: { on: (ev: string, fn: (...a: unknown[]) => unknown) => unknown; exitCode?: number | null }): ProcessWaitHandle {
  let cancelled = false;
  const promise = new Promise<boolean>((resolve) => {
    const onExit = () => {
      if (cancelled) return;
      resolve(true);
    };
    child.on("exit", onExit);
    // Already exited before registration (race): fire immediately.
    if (child.exitCode !== null && child.exitCode !== undefined) {
      resolve(true);
    }
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
    },
  };
}
