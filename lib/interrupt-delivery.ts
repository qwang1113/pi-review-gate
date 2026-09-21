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
 * So the text was neither delivered nor lost-with-an-error: it sat in a queue
 * nobody would ever drain, the ack said `injected`, and the opener waited
 * forever. The same drain serves orchestration children, so
 * `orchestrator_instruct({ mode: "interrupt" })` could lose a message the same
 * way.
 *
 * ── THE TWO STEPS ──
 *
 * `abort()` first, then WAIT for the pane to actually be idle, and only then
 * hand the text over WITHOUT `deliverAs`. pi's contract is explicit about what
 * each shape does (docs/extensions.md, `pi.sendUserMessage`):
 *
 *   - not streaming → the message is sent immediately and triggers a new turn;
 *   - streaming → `deliverAs` is REQUIRED, and omitting it throws.
 *
 * That is the whole fix: after the wait, "no `deliverAs`" is not a shortcut, it
 * is the only form that starts the round. The wait is bounded, because a turn
 * that refuses to stop must not wedge the drain (the re-entrancy guard in the
 * caller would then swallow every later instruction) — and a bounded wait must
 * never drop the text, so the fallback QUEUES it: a queued message is
 * recoverable, a dropped one is not.
 *
 * PURE: every effect is injected (sleep, clock), so the whole timing contract
 * is drivable from a test with no timer and no pane.
 */

/**
 * How long to wait for a turn to actually stop before falling back to a queued
 * delivery. Long enough for a tool call to finish and an abort to land; short
 * enough that a wedged pane does not hold the drain (and the messages behind
 * it) hostage.
 */
export const INTERRUPT_IDLE_WAIT_MS = 30_000;

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
   * `deliverAs`. Throws if the agent is streaming again (pi's contract), which
   * the caller's implementation must let escape: this module falls back rather
   * than dying.
   */
  sendNow: (text: string) => void;
  /**
   * Queue the text behind the running turn — `deliverAs: "steer"`. The
   * fallback, used only when the wait could not reach idle: a queued message
   * can still be retrieved, a dropped one cannot.
   */
  sendQueued: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
  pollMs?: number;
}

export interface InterruptDeliveryResult {
  /**
   * `turn` — the pane reached idle and the text opened a new turn (the
   * normal, correct path). `queued` — the wait expired (or the pane started
   * streaming again mid-handoff) and the text was queued instead.
   */
  delivered: "turn" | "queued";
  /** Time spent waiting for idle, in ms. */
  waitedMs: number;
}

/** `sleep` that a test can replace; the default is the real one. */
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

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
 * The whole interrupt handoff: request the stop, wait for it, then speak in the
 * one form that starts a round.
 *
 * ORDER IS THE FIX. Reversing the first two lines (or dropping the wait) is the
 * deadlock above; skipping the abort leaves the old turn running and the text
 * queued behind it.
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
  if (waited.idle) {
    try {
      deps.sendNow(text);
      return { delivered: "turn", waitedMs: waited.waitedMs };
    } catch {
      // The pane started streaming again between the check and the handoff.
      // Not an error worth surfacing: the fallback still carries the text.
    }
  }
  deps.sendQueued(text);
  return { delivered: "queued", waitedMs: waited.waitedMs };
}
