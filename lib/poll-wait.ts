/**
 * The waiting SKELETON, with its criteria injected.
 *
 * WHY IT IS GENERIC (user requirement, 2026-08-29). Waiting for a judge round
 * and waiting for an interactive orchestrator child are the same three
 * sentences — probe, publish, stop on a criterion or on the budget — and only
 * the criteria differ (a judge is done on process exit / exit-code / a verdict
 * fence; an orchestrator child on an attention event / its own declare_done /
 * a dead process). The skeleton is small enough to duplicate and just big
 * enough to get subtly wrong twice: the timeout must return the CURRENT
 * observation rather than an error, an abort must be reported rather than
 * swallowed, and the snapshot must be published on every probe INCLUDING the
 * first — otherwise the first two seconds look like a hang.
 *
 * So the loop lives here once and the caller passes `probe` + `isDone`.
 * Everything time-related is injectable, so a test drives it with a fake clock
 * and fake criteria instead of real sleeping.
 *
 * NOT a policy module: it never decides what "done" means, never formats
 * anything, and never touches the filesystem.
 */

/** Just the part of an AbortSignal this loop reads. */
export interface AbortLike {
  readonly aborted: boolean;
}

export interface PollWaitOptions<T> {
  /** Observe the world once — cheap, and safe to call repeatedly. */
  probe: () => T | Promise<T>;
  /** Is this observation an end state? */
  isDone: (observation: T) => boolean;
  /** How long the call may block, in ms. */
  budgetMs: number;
  /** Gap between probes (default 2s — the same cadence as the UI throttle). */
  pollMs?: number;
  /** Called after EVERY probe, including the first: the live snapshot. */
  onProbe?: (observation: T, elapsedMs: number) => void;
  /** The user pressing ESC. Checked before each sleep and each probe. */
  signal?: AbortLike;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface PollWaitResult<T> {
  /** The LAST observation — the whole point of the timeout path. */
  observation: T;
  /** Did a criterion fire? False means the budget ran out (or an abort). */
  done: boolean;
  /** Did the caller's signal abort the wait? */
  aborted: boolean;
  /** How long the call actually blocked. */
  waitedMs: number;
}

export const DEFAULT_POLL_MS = 2000;

/**
 * Poll `probe` until `isDone`, the budget expires, or the signal aborts.
 *
 * Always returns an observation: on timeout it is the most recent one, so the
 * caller can report progress instead of "not done yet". Never throws for
 * timing — only a throwing `probe` propagates.
 */
export async function pollUntil<T>(opts: PollWaitOptions<T>): Promise<PollWaitResult<T>> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const startedAt = now();
  const deadline = startedAt + opts.budgetMs;

  let observation = await opts.probe();
  opts.onProbe?.(observation, now() - startedAt);
  while (!opts.isDone(observation) && now() < deadline && opts.signal?.aborted !== true) {
    await sleep(pollMs);
    observation = await opts.probe();
    opts.onProbe?.(observation, now() - startedAt);
  }
  return {
    observation,
    done: opts.isDone(observation),
    aborted: opts.signal?.aborted === true,
    waitedMs: now() - startedAt,
  };
}
