/**
 * THE ONE GATE EVERY IDLE-TIME WAKE-UP PASSES (2026-09-29, user decision).
 *
 * A wake-up the gate starts on its own — while the session sits idle — is a
 * full LLM call over the whole context. Measured: three sandbox sessions were
 * woken every ~45s for 40 hours (~1.56 billion input tokens), each time by a
 * source that was individually "throttled" (a 60s notice gap here, a 60s
 * revival interval there, a done-reminder widening to ten minutes) and none of
 * which had an upper bound. Every one of them re-announced a fact that had not
 * changed.
 *
 * The invariant: a wake-up needs a NEW fact, and one fact buys a bounded
 * number of them. `progressKey` is the caller's summary of every fact that
 * counts as progress (user message, worktree fingerprint, a verdict or round,
 * plan / child states); while it stays the same the gaps widen 1m → 2m → 4m →
 * 8m → 16m and after the fifth wake the gate falls silent — the UI is told
 * once — until the key changes. There is no other throttle: sources do not
 * keep their own clocks beside this one.
 *
 * Out of scope on purpose: the turn-driven `[REVIEW_GATE_RESUME]` and the
 * orchestrator's settle continuation answer a turn that just ended (they are
 * not idle-time wakes) and are bounded by `maxRounds` plus the loop-stall
 * breaker; one-shot event reports (a round's verdict, a dead judge) ARE the
 * new fact. test/wake-sites.test.ts pins every call site that may start a
 * turn, so a new idle wake cannot quietly bypass this module.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Gap required before the Nth wake on one unchanged key (index = wakes already spent on it). */
export const WAKE_GAPS_MS: readonly number[] = Object.freeze([60_000, 120_000, 240_000, 480_000, 960_000]);
/** Wakes one unchanged fact may buy. */
export const WAKE_LIMIT = WAKE_GAPS_MS.length;

export interface WakeMemo {
  lastWakeAt?: number;
  /** The progress key the last admitted wake was spent on. */
  key?: string;
  /** Wakes already admitted on `key`. */
  wakes: number;
}

export interface WakeDecision {
  admit: boolean;
  memo: WakeMemo;
  /** Not admitted yet, but will be after this long (when nothing else changes). */
  nextDelayMs?: number;
  /** This fact has used up its wakes: nothing more until the key changes. */
  exhausted: boolean;
}

export const EMPTY_WAKE_MEMO: WakeMemo = Object.freeze({ wakes: 0 });

export function decideWake(input: { memo: WakeMemo; now: number; progressKey: string }): WakeDecision {
  const { memo, now, progressKey } = input;
  const spent = memo.key === progressKey ? memo.wakes : 0;
  if (spent >= WAKE_LIMIT) return { admit: false, memo, exhausted: true };
  const gap = WAKE_GAPS_MS[spent]!;
  const since = memo.lastWakeAt === undefined ? Number.POSITIVE_INFINITY : now - memo.lastWakeAt;
  if (since < gap) return { admit: false, memo, nextDelayMs: gap - since, exhausted: false };
  return { admit: true, memo: { lastWakeAt: now, key: progressKey, wakes: spent + 1 }, exhausted: false };
}

export type WakeDelivery =
  | { kind: "user"; text: string; deliverAs?: "followUp" | "steer" }
  | { kind: "custom"; message: Parameters<ExtensionAPI["sendMessage"]>[0] };

/** The session's governor: one memo for every source, and the only place a governed wake is sent. */
export function createWakeGovernor(deps: {
  pi: Pick<ExtensionAPI, "sendUserMessage" | "sendMessage">;
  notify(text: string): void;
  now?: () => number;
}) {
  let memo: WakeMemo = EMPTY_WAKE_MEMO;
  let silencedKey: string | undefined;
  return {
    wake(req: { source: string; progressKey: string; delivery: WakeDelivery }): WakeDecision {
      const decision = decideWake({ memo, now: (deps.now ?? Date.now)(), progressKey: req.progressKey });
      memo = decision.memo;
      if (decision.exhausted) {
        if (silencedKey !== req.progressKey) {
          silencedKey = req.progressKey;
          try {
            deps.notify(
              `review-gate: 连续 ${WAKE_LIMIT} 次唤醒都没有新进展（最近一次来源 ${req.source}）—— ` +
              "门禁停止主动唤醒，直到出现进展或你发来消息。",
            );
          } catch { /* headless */ }
        }
        return decision;
      }
      if (!decision.admit) return decision;
      silencedKey = undefined;
      const d = req.delivery;
      if (d.kind === "user") deps.pi.sendUserMessage(d.text, { deliverAs: d.deliverAs ?? "followUp" });
      else deps.pi.sendMessage(d.message, { triggerTurn: true, deliverAs: "steer" });
      return decision;
    },
  };
}

export type WakeGovernor = ReturnType<typeof createWakeGovernor>;
