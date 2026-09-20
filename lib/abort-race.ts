/**
 * RACING A PROMISE AGAINST AN ABORT — once, for the whole gate.
 *
 * WHY THIS MODULE EXISTS (quality round P2, 2026-09-18): the fix for the frozen
 * session grew the same fifteen lines twice in one round — a dialog queue that
 * gives up on its turn, and a reason box that stops being waited on. Both add
 * an abort listener with `{ once: true }`, both settle exactly once behind a
 * `settled` guard, both detach the listener on the non-abort path, and both
 * fold a rejection into the same answer as an abort. Two copies of a mechanism
 * whose whole JOB is "settle exactly once" is two chances to get that wrong
 * (AGENTS.md 哲学三: 永不并行两套实现).
 *
 * WHAT IT IS NOT: a timeout. There is no clock here and no default — this
 * module races an abort and nothing else. The GATE does have a dialog timeout
 * since 2026-09-19 (thirty minutes, then `lib/user-proxy.ts` hands the question
 * to the arbiter), but that window lives in that one module and reaches this one
 * as a plain signal; `AbortSignal.timeout` remains the standard way to supply
 * one.
 *
 * PURE and tiny on purpose: no IO, no globals, and the answer for the aborted
 * case is the caller's (`onAbort`), because "a cancelled dialog" is `undefined`
 * for a reason box and `true` for a queue waiter.
 */

/**
 * Resolve with `work`'s value, or with `onAbort` the moment `signal` aborts.
 *
 * AN ALREADY-ABORTED SIGNAL NEVER STARTS THE WAIT — and, crucially, the caller
 * decides whether to even BEGIN the work: this function takes a promise, so a
 * caller that must not RUN something on a dead signal (opening a text box
 * nobody would read) checks `signal.aborted` first or hands over a thunk. Both
 * uses are real; lib/reason-editor.ts shows the thunk shape.
 *
 * A REJECTION LANDS ON `onAbort` TOO. Neither caller has anything better to do
 * with it — the queue treats a broken predecessor as "my turn is void", the
 * reason box treats a throwing host as "no reason was written" — and leaving it
 * unhandled would take the process down over a dialog.
 */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal, onAbort: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(onAbort);
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      resolve(value);
    };
    const aborted = () => finish(onAbort);
    signal.addEventListener("abort", aborted, { once: true });
    void work.then(finish, () => finish(onAbort));
  });
}
