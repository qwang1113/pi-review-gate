/**
 * WHEN THE PANE'S OWN MODEL DIES — the judge side of the chain.
 *
 * A judge child is ONE pi process with ONE model, and it is the only party
 * that sees its own provider errors: the opener is blocked in a wait, and the
 * channel carries verdicts, not stack traces. Before this module the pane had
 * nothing to say about a model that answered 503 twenty-five times, so a round
 * could not end and nobody could explain why (measured 2026-09-10, rebate).
 *
 * WHAT IT DOES, in order:
 *   1. the round's run ends with `stopReason: "error"` (pi's own retries are
 *      exhausted — the transfer point is `agent_settled`, never the first
 *      failed attempt: a burst of 503s is normal and usually recovers);
 *   2. the next spec this round has not already spent is taken from the role's
 *      chain (lib/judge-prompt.ts `modelChainFor`), read FRESH — the user may
 *      have edited the config since the pane opened;
 *   3. the pane switches to it (model + that slot's thinking level) and nudges
 *      itself to carry on, so the transcript, the task and the evidence
 *      gathered so far survive the failure;
 *   4. it REPORTS the event (lib/model-health.ts `ModelEvent`, written to the
 *      channel) so the opener can cool the failed slot down and say what
 *      happened. A chain with nothing left reports `exhausted` — the round
 *      then ENDS as a failure instead of hanging, which is the whole point.
 *
 * The policy is pure functions over injected facts (chain, current model,
 * switch, nudge, report) so the state machine is testable without a pane.
 */

import { modelKeyOf, nextSlotAfter, summarizeModelError, type ModelEvent } from "./model-health.ts";

/** Everything the rotation needs from the host — all injected. */
export interface ModelRotationDeps {
  /** The role's chain, as of NOW (re-read on every failure). */
  chain: () => readonly string[];
  /** The spec this session is running, as `provider/id`. */
  currentSpec: () => string | undefined;
  /** Switch model + thinking level; false when the registry/auth refuses it. */
  switchTo: (spec: string) => Promise<boolean>;
  /** Keep the round going (a user message; the transcript is preserved). */
  nudge: (text: string) => void;
  /** Publish the event (channel record → the opener's wait). */
  report: (event: ModelEvent) => void;
  /** Say it in the pane, for the human watching. */
  notify: (text: string, level: "info" | "warning" | "error") => void;
}

export interface ModelRotation {
  /**
   * One terminal model error: rotate if there is anything left to rotate to.
   * Returns the event it published (undefined when there was no chain to
   * rotate within, or when another rotation is already in flight).
   */
  onModelFailure: (error?: string) => Promise<ModelEvent | undefined>;
  /** The specs this round has spent, in order. */
  attempted: () => readonly string[];
}

/** The nudge the pane sends ITSELF after a successful switch. */
export function buildRotationResumeNote(from: string, to: string, error?: string): string {
  const why = error ? `（${error}）` : "";
  return [
    "（门禁自愈 · 模型 fallback）",
    `你刚才的模型 ${from} 失败${why}，门禁已把本会话切到链上的下一个模型 ${to}，并保留了你已有的上下文。`,
    "请从被打断的地方继续本轮任务：不要重做已经完成的部分，也不必在结论里解释这次切换。",
  ].join("");
}

/** The note when nothing is left — the pane must not pretend it can continue. */
export function buildChainExhaustedNote(from: string, error?: string): string {
  const why = error ? `（${error}）` : "";
  return `门禁：链上的模型都试过了，最后一个 ${from} 也失败${why}。本轮已上报为失败，等 opener 处理，不要自己下结论。`;
}

export function createModelRotation(deps: ModelRotationDeps): ModelRotation {
  const attempted: string[] = [];
  let busy = false;
  return {
    attempted: () => [...attempted],
    onModelFailure: async (error?: string) => {
      if (busy) return undefined;
      const summary = summarizeModelError(error);
      const chain = [...deps.chain()];
      // No chain at all: the gate cannot name a fallback. There is nothing to
      // rotate within — the empty chain is the caller's fail-closed case.
      const failed = deps.currentSpec() ?? chain[0];
      if (!failed || chain.length === 0) return undefined;
      busy = true;
      try {
        if (!attempted.some((a) => modelKeyOf(a) === modelKeyOf(failed))) attempted.push(failed);
        let cursor = failed;
        for (;;) {
          const next = nextSlotAfter(chain, cursor, attempted);
          if (!next) {
            const event: ModelEvent = {
              spec: failed,
              ...(summary ? { error: summary } : {}),
              exhausted: true,
              attempts: attempted.length,
            };
            deps.report(event);
            deps.notify(buildChainExhaustedNote(failed, summary), "error");
            return event;
          }
          attempted.push(next.spec);
          if (await deps.switchTo(next.spec)) {
            const note = buildRotationResumeNote(failed, next.spec, summary);
            const event: ModelEvent = {
              spec: failed,
              ...(summary ? { error: summary } : {}),
              to: next.spec,
              attempts: attempted.length,
            };
            deps.report(event);
            deps.notify(note, "warning");
            deps.nudge(note);
            return event;
          }
          // The switch itself was refused (no auth, unknown model): that slot
          // is spent too — keep walking rather than give up on the chain.
          cursor = next.spec;
        }
      } finally {
        busy = false;
      }
    },
  };
}
