/**
 * Judge-child completion watchers — the wake-up registry behind
 * review_spawn / review_watch, extracted from the extension so the
 * re-arm/shutdown race is testable without a pi runtime.
 *
 * Lifecycle contract:
 *  - `register(channel, label)`: one listener per channel (a re-registration
 *    cancels the old handle). When the child signals `tmux wait-for -S
 *    <channel>`, the wake callback fires and the listener RE-ARMS ITSELF for
 *    the next round on the same pane (round-14 P1: a judge pane is reused for
 *    every round of its life — the same title ⇒ same channel — and a one-shot
 *    listener would leave rounds 2..N with no wake-up).
 *  - Re-arm happens only when the agent did not replace the handle in the
 *    meantime (the identity check on the registry), so a manual
 *    review_watch with a custom label keeps its label until the next signal.
 *  - `shutdown()`: session teardown. Stops further re-arms and cancels every
 *    outstanding handle. Without the shuttingDown latch the race would be:
 *    signal resolves the promise → session_shutdown cancels + clears the
 *    registry → the .then callback runs and sees the channel absent →
 *    re-registers → an orphan tmux wait-for for a session that is tearing
 *    down (round-16 Nit). `reset()` re-opens registration for a NEW session
 *    (session_start) on the same extension instance.
 */

import type { WaitHandle } from "./tmux-session.ts";

/** Waits on a channel; returns a cancellable handle (waitForSignalAsync). */
export type WatchWaiter = (channel: string, timeoutMs?: number) => WaitHandle;

/** Delivers the wake message to the pi session (pi.sendMessage). */
export type WatchWake = (label: string, channel: string) => void;

export interface WatchRegistry {
  /** Currently registered handles, keyed by channel. */
  active: ReadonlyMap<string, WaitHandle>;
  /** Register (or replace) the listener for one channel. No-op after shutdown. */
  register(channel: string, label: string): void;
  /** session_shutdown: latch shutdown, cancel handles, clear the registry. */
  shutdown(): void;
  /** session_start: a new session may register watchers again. */
  reset(): void;
}

export function createWatchRegistry(waiter: WatchWaiter, wake: WatchWake): WatchRegistry {
  const active = new Map<string, WaitHandle>();
  let shuttingDown = false;

  function register(channel: string, label: string): void {
    if (shuttingDown) return;
    active.get(channel)?.cancel();
    const handle = waiter(channel);
    active.set(channel, handle);
    handle.promise.then((signalled) => {
      if (active.get(channel) === handle) active.delete(channel);
      if (!signalled) return;
      try {
        wake(label, channel);
      } catch {
        /* the session may be shutting down — the listener is gone anyway */
      }
      // Re-arm for the NEXT round on the same pane (round-14 P1) — unless
      // shutdown began while the signal was in flight (round-16 Nit): the
      // registry was cleared, and re-registering would spawn an orphan tmux
      // wait-for for a session that is tearing down.
      if (active.get(channel) === undefined && !shuttingDown) register(channel, label);
    });
  }

  function shutdown(): void {
    shuttingDown = true;
    for (const handle of active.values()) handle.cancel();
    active.clear();
  }

  function reset(): void {
    shuttingDown = false;
  }

  return { active, register, shutdown, reset };
}
