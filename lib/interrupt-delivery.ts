/**
 * STOP, THEN SPEAK — the two-step that an `interrupt` has to be.
 *
 * ── THE MEASURED DEADLOCK (2026-09-21) ──
 *
 * Two judges of one round sat frozen for 552 seconds with `judge_wait` polling
 * an empty channel. Their panes were alive and their transcripts ended on
 *
 *     Operation aborted
 *     Steering: You are the reviewer of this round …
 *     ↳ Option+Up to edit all queued messages
 *
 * The next round HAD been dispatched. What happened to it is a race that loses
 * every time the pane is busy, and the pane is busy exactly when a round is
 * running — which is the normal case, because a round is dispatched as soon as
 * the previous one reported:
 *
 *   1. `ctx.abort()` is SYNCHRONOUS on the extension side (`abort(): void` —
 *      pi's own `AgentSession.abort()` returns a promise, but the context
 *      handed to an extension does not). Calling it requests an abort; it does
 *      NOT wait for the turn to stop.
 *   2. The message was then handed to `pi.sendUserMessage(text, { deliverAs:
 *      "steer" })` while the agent was STILL streaming, so pi queued it as
 *      steering.
 *   3. pi injects steering only after the current assistant turn finishes its
 *      tool calls — but the abort ends the run at `shouldStopAfterTurn` and
 *      RETURNS, skipping the drain. The queue is never read again.
 *
 * ── THE ANSWER IS "WAIT", NOT "QUEUE" (corrected 2026-09-21) ──
 *
 * The first version of this module waited for idle and, if the wait ran out,
 * handed the text to `deliverAs: "steer"` as a fallback — on the theory that a
 * queued message is at least not a lost one. THAT WAS WRONG, and it is the
 * same deadlock wearing a different hat: the queue it falls back to is exactly
 * the one the abort skipped draining, so a timeout would park the text
 * forever while reporting it as delivered. (The fallback was also unreachable
 * in practice: pi's own `sendUserMessage` swallows the streaming-without-mode
 * throw, so the `try/catch` that was supposed to route around it never fired.)
 *
 * So a wait that does not reach idle DELIVERS NOTHING. It returns `deferred`,
 * the caller acknowledges the instruction as `received` (not `injected`), and
 * the text simply STAYS IN THE CHANNEL — where the next drain (a heartbeat, an
 * `agent_settled`, the next round) picks it up and tries again. Nothing is
 * lost, nothing sits in an unread queue, and the ack tells the truth about
 * which stage the delivery reached.
 *
 * The wait is short on purpose (3s): an abort lands in milliseconds, so a pane
 * that is still busy after that is not "about to stop" — it is running a tool
 * call, and the honest move is to come back later rather than to hold the
 * caller's drain hostage.
 *
 * PURE: every effect is injected (sleep, clock), so the whole timing contract
 * is drivable from a test with no timer and no pane.
 */

/**
 * How long to wait for a turn to actually stop before DEFERRING the delivery
 * to the next drain. An abort lands in milliseconds; a pane still busy after
 * this is running a tool call, and waiting longer only delays the ack.
 */
export const INTERRUPT_IDLE_WAIT_MS = 3_000;

/** Polling interval. `ctx.isIdle()` is a synchronous local read — this is a
 *  cheap check, not a network round-trip. */
export const INTERRUPT_POLL_MS = 50;

export interface InterruptDeliveryDeps {
  /** pi's extension-side abort: requests the stop, does NOT wait for it. */
  abort: () => void;
  /** Is the agent idle right now? (`ctx.isIdle()`) */
  isIdle: () => boolean;
  /**
   * Open a NEW turn with the text — `pi.sendUserMessage(text)` with no
   * `deliverAs`. pi's contract: not streaming ⇒ sent immediately as a new
   * turn; streaming ⇒ no `deliverAs` is an error. Only ever called once the
   * pane has been OBSERVED idle.
   */
  sendNow: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
  pollMs?: number;
}

export interface InterruptDeliveryResult {
  /**
   * `turn` — the pane reached idle and the text opened a new turn (the
   * normal, correct path). `deferred` — the wait expired first, so NOTHING
   * was delivered: the text stays in the channel and the next drain retries
   * it. A `deferred` result must NOT be acknowledged as `injected`.
   */
  delivered: "turn" | "deferred";
  /** Time spent waiting for idle, in ms. */
  waitedMs: number;
}

/** `sleep` that a test can replace; the default is the real one. */
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---------------------------------------------------------------------------
// "THE ROUND NEVER STARTED" — silence, told apart from work
// ---------------------------------------------------------------------------

/**
 * How long a dispatched round may produce NOTHING before it looks unstarted.
 *
 * Measured case this exists for (01a0c22c): two judges sat frozen for 552
 * seconds with `judge_wait` polling an empty channel. The pane was alive and
 * its gate was heartbeating — a heartbeat proves a PROCESS, not a round — so
 * every available reading said "working" while nothing was happening at all.
 * The transcript is the one thing that moves only when the agent actually
 * works.
 */
export const ROUND_SILENT_MS = 180_000;

/** Everything the "did this round ever start" question needs, as readings. */
export interface RoundSilenceFacts {
  /** When the round was dispatched, ms (the registry entry's `dispatchedAt`). */
  dispatchedAtMs?: number;
  /** Last write to the judge's transcript, ms — undefined when unreadable. */
  transcriptActivityAtMs?: number;
  /** Now, ms. */
  nowMs: number;
  /** Has this round produced a report (or a settlement)? */
  hasReport: boolean;
  /**
   * Is the judge BLOCKED on a question only the opener can answer?
   *
   * Review P1, 2026-09-21: a judge waiting for an answer writes nothing to its
   * transcript — it is IDLE BY DESIGN — and a long tool call looks the same
   * from the outside. Both are the ROUND WORKING, and reporting them as "never
   * started" would tell the opener to throw away a live round (with the hint to
   * re-dispatch). A blocked-on-opener round is exactly the case where the wait
   * receipt already carries the question, so the caller knows it is alive.
   */
  blockedOnOpener?: boolean;
}

/**
 * Does this round look like it never started?
 *
 * THE ANSWER IS A SUGGESTION, NEVER AN ACTION: the caller says it out loud in
 * its receipt (with the pane and the elapsed time) and leaves the decision —
 * `judge_submit({ fresh: true })` — to the agent. Re-dispatching by itself
 * would hide the defect AND risk two rounds running at once.
 *
 * Fail-open on every missing reading, like every other liveness judgement in
 * this gate: an unreadable transcript is missing INFORMATION, not evidence of
 * silence.
 */
export function roundLooksUnstarted(facts: RoundSilenceFacts): boolean {
  if (facts.hasReport) return false;
  if (facts.blockedOnOpener) return false;
  // NO READING ⇒ NO VERDICT (fail-open, like every other liveness judgement in
  // this gate): an unreadable transcript is missing INFORMATION, not evidence
  // of silence.
  const reference = facts.transcriptActivityAtMs ?? facts.dispatchedAtMs;
  if (reference === undefined) return false;
  // A transcript that moved AFTER the dispatch is activity; the dispatch is
  // only ever a FLOOR under it (otherwise a transcript whose last line predates
  // this round would look silent from the start of time rather than from the
  // start of the round).
  const start = facts.dispatchedAtMs === undefined ? reference : Math.max(reference, facts.dispatchedAtMs);
  return facts.nowMs - start >= ROUND_SILENT_MS;
}

/**
 * Wait until `isIdle()` is true, or until the window runs out.
 *
 * Returns the time spent either way, so the caller can tell the two apart and
 * write an honest acknowledgement — and so a test can assert the wait actually
 * happened instead of trusting that it did.
 */
export async function waitForIdle(opts: {
  isIdle: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
  pollMs?: number;
}): Promise<{ idle: boolean; waitedMs: number }> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const waitMs = opts.waitMs ?? INTERRUPT_IDLE_WAIT_MS;
  const pollMs = opts.pollMs ?? INTERRUPT_POLL_MS;
  const started = now();
  // Already idle: this is the common case for a dispatch that arrives between
  // rounds, and it must cost nothing (no timer, no sleep).
  if (opts.isIdle()) return { idle: true, waitedMs: 0 };
  while (now() - started < waitMs) {
    await sleep(pollMs);
    if (opts.isIdle()) return { idle: true, waitedMs: now() - started };
  }
  return { idle: false, waitedMs: now() - started };
}

/**
 * The whole interrupt handoff: request the stop, wait for it, and ONLY THEN
 * speak — in the one form that starts a round.
 *
 * ORDER IS THE FIX. Reversing the first two steps (or dropping the wait)
 * recreates the deadlock above.
 */
export async function deliverInterrupt(
  text: string,
  deps: InterruptDeliveryDeps,
): Promise<InterruptDeliveryResult> {
  deps.abort();
  const waited = await waitForIdle({
    isIdle: deps.isIdle,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.waitMs === undefined ? {} : { waitMs: deps.waitMs }),
    ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
  });
  if (!waited.idle) {
    // NOTHING IS SENT. See the module docblock: the fallback this replaced
    // queued the text into the very queue the abort stopped draining.
    return { delivered: "deferred", waitedMs: waited.waitedMs };
  }
  deps.sendNow(text);
  return { delivered: "turn", waitedMs: waited.waitedMs };
}
