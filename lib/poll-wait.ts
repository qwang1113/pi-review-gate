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
  /**
   * The BUDGET TIMER, and it is independent of everything above (R-16).
   *
   * The measured failure: a wait given `timeoutMs: 900000` was still blocking
   * past 1020s and only an external Escape ended it. Whatever the cause, a
   * deadline that is only checked BETWEEN probes cannot bound a probe that
   * does not return — so the loop now races every await against this timer,
   * and the call returns when it fires no matter what the probe is doing.
   *
   * Injectable so a test can prove that property without waiting real
   * minutes.
   */
  deadlineTimer?: (ms: number) => { promise: Promise<void>; cancel(): void };
}

export interface PollWaitResult<T> {
  /**
   * The LAST observation — the whole point of the timeout path.
   *
   * `undefined` only when the budget expired before the FIRST probe ever
   * returned (a hung probe): the caller then reports a stall instead of
   * inventing an observation it never made.
   */
  observation?: T;
  /** Did a criterion fire? False means the budget ran out (or an abort). */
  done: boolean;
  /** Did the caller's signal abort the wait? */
  aborted: boolean;
  /** The budget expired while a probe was still running. */
  stalledInProbe: boolean;
  /** How long the call actually blocked. */
  waitedMs: number;
}

export const DEFAULT_POLL_MS = 2000;

/** The default budget timer: a real `setTimeout` that is always cancelled. */
function realDeadlineTimer(ms: number): { promise: Promise<void>; cancel(): void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => { if (handle) clearTimeout(handle); },
  };
}

/** Marker resolved by the deadline race — never a value a probe can return. */
const TIMED_OUT = Symbol("poll-wait:timeout");

/**
 * Poll `probe` until `isDone`, the budget expires, or the signal aborts.
 *
 * ALWAYS RETURNS. On timeout it hands back the most recent observation, so
 * the caller can report progress instead of "not done yet"; if not even one
 * probe completed, it says so (`stalledInProbe`). Never throws for timing —
 * only a throwing `probe` propagates.
 */
export async function pollUntil<T>(opts: PollWaitOptions<T>): Promise<PollWaitResult<T>> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const startedAt = now();
  const deadline = startedAt + opts.budgetMs;
  const timer = (opts.deadlineTimer ?? realDeadlineTimer)(opts.budgetMs);
  const expired = timer.promise.then(() => TIMED_OUT as typeof TIMED_OUT);

  // Read through a function, never as a narrowed property: the signal is
  // mutated by the HOST (the user pressing ESC), so a value TypeScript
  // narrowed on the previous line is exactly the value that must be re-read.
  const aborted = (): boolean => opts.signal?.aborted === true;
  let observation: T | undefined;
  let stalledInProbe = false;

  try {
    for (;;) {
      const probed = await Promise.race([Promise.resolve(opts.probe()), expired]);
      if (probed === TIMED_OUT) {
        stalledInProbe = observation === undefined;
        break;
      }
      observation = probed as T;
      opts.onProbe?.(observation, now() - startedAt);
      if (opts.isDone(observation)) break;
      if (aborted()) break;
      if (now() >= deadline) break;
      const slept = await Promise.race([sleep(pollMs), expired]);
      if (slept === TIMED_OUT) break;
      if (aborted()) break;
      // NOTE: the budget is checked BEFORE the sleep, never after it. A probe
      // always follows a completed sleep, so the caller's last observation is
      // taken at the deadline rather than one poll interval before it.

    }
  } finally {
    timer.cancel();
  }
  return {
    ...(observation === undefined ? {} : { observation }),
    done: observation !== undefined && opts.isDone(observation),
    aborted: aborted(),

    stalledInProbe,
    waitedMs: now() - startedAt,
  };
}

