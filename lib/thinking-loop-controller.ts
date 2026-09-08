/**
 * Thinking-loop controller — the state machine that ACTS on a trip.
 *
 * Split from `lib/thinking-loop-guard.ts` on purpose (goal-auditor P1): the
 * guard decides "is this a loop?", the controller decides "what do we do about
 * it, and how often". Everything the controller needs from Pi is INJECTED
 * (abort / notify / inject), so an event sequence — trip, trip, trip, trip —
 * is a unit test instead of a live session, and `extensions/review-gate.ts`
 * stays a registration line rather than the home of a new state machine.
 *
 * THE ACTIONS, in order:
 *   1. mark the turn's thinking for display truncation (it stays cut until the
 *      next turn starts — the finalized message is rendered once more after the
 *      stream ends, and re-rendering the whole loop would defeat the point);
 *   2. `inject()` a "stop spinning, act now" message for the model, then
 *      `abort()` the run. The ORDER is the host's business and this controller
 *      only reports both effects: Pi drains a steering message from INSIDE a
 *      running agent loop, and abort is what stops that loop, so the extension
 *      defers the actual send until the session is idle again. The upstream
 *      guard's soft `steer` alone could never arrive — the turn it would
 *      steer never finishes;
 *   3. `notify()` the human.
 *
 * WHY A RECOVERY CAP. abort → inject → the model spins again → abort … is a
 * perfectly stable loop of its own. After `maxRecoveries` consecutive
 * recoveries the controller keeps aborting and notifying but stops injecting,
 * so the session is handed back to the human instead of being restarted
 * forever. A turn that produces text or tool-call content resets the counter —
 * the model demonstrably recovered.
 */

import {
  THINKING_DISPLAY_LIMITS,
  createThinkingLoopDetector,
  truncateThinkingForDisplay,
  type StreamDeltaKind,
  type ThinkingDisplayLimits,
  type ThinkingLoopConfig,
} from "./thinking-loop-guard.ts";

/** What the controller needs from the host. */
export interface ThinkingLoopEffects {
  /** Abort the current run (Pi: `ctx.abort()`). */
  abort(): void;
  /** Tell the human (Pi: `ctx.ui.notify(text, "warning")`). */
  notify(message: string): void;
  /** Queue a message for the model (the host decides when it is actually sent). */
  inject(text: string): void;
}

export interface ThinkingLoopControllerOptions {
  detector?: Partial<ThinkingLoopConfig>;
  /** Consecutive auto-recoveries before the controller stops injecting. */
  maxRecoveries?: number;
  limits?: ThinkingDisplayLimits;
}

export interface ThinkingLoopControllerState {
  /** This turn's thinking display is cut. */
  truncating: boolean;
  /** Auto-recoveries since the last productive turn. */
  recoveries: number;
  /** The guard has tripped at least once in this session. */
  tripped: boolean;
}

export interface ThinkingLoopController {
  /** An assistant message started: fresh turn, display no longer cut. */
  startTurn(): void;
  /** One stream delta. */
  observe(kind: StreamDeltaKind, delta: string): void;
  /** The assistant message ended. */
  endTurn(): void;
  /** `pi.registerMarkdownTransformer` hook. */
  truncateDisplay(markdown: string, messageType: string): string;
  state(): ThinkingLoopControllerState;
}

export const THINKING_LOOP_MAX_RECOVERIES = 3;

/** Injected into the session after a trip, addressed to the model. */
export const THINKING_LOOP_INJECTION =
  "[review-gate] 你刚才陷入了重复的思考循环：这一轮只输出 thinking，" +
  "没有任何文本或工具调用，已被自动中止。" +
  "停止重复自己，立即行动 —— 直接给出结论，或调用完成当前任务所需的工具。";

/** Shown to the human on every trip. */
export const THINKING_LOOP_NOTICE =
  "[review-gate] 检测到思考空转（本轮只有 thinking、零文本零工具调用），" +
  "已中止本轮并提示模型立即行动。";

/** Shown instead of the notice once the recovery cap is spent. */
export const THINKING_LOOP_CAP_NOTICE =
  `[review-gate] 再次检测到思考空转，但自动续跑已达上限（${THINKING_LOOP_MAX_RECOVERIES} 次）——` +
  "只中止、不再自动提示模型。请人工介入：换模型、降低 thinking 档，或新开一个会话。";

export function createThinkingLoopController(
  effects: ThinkingLoopEffects,
  options: ThinkingLoopControllerOptions = {},
): ThinkingLoopController {
  const detector = createThinkingLoopDetector(options.detector);
  const maxRecoveries = Math.max(0, Math.floor(options.maxRecoveries ?? THINKING_LOOP_MAX_RECOVERIES));
  const limits = options.limits ?? THINKING_DISPLAY_LIMITS;
  let truncating = false;
  let recoveries = 0;
  let tripped = false;

  return {
    startTurn() {
      detector.reset();
      truncating = false;
    },
    observe(kind, delta) {
      const verdict = detector.observe(kind, delta);
      if (!verdict) return;
      tripped = true;
      truncating = true;
      if (recoveries < maxRecoveries) {
        recoveries += 1;
        effects.inject(THINKING_LOOP_INJECTION);
        effects.notify(THINKING_LOOP_NOTICE);
      } else {
        effects.notify(THINKING_LOOP_CAP_NOTICE);
      }
      effects.abort();
    },
    endTurn() {
      const snapshot = detector.snapshot();
      // A turn that produced text or tool-call content is a real recovery —
      // the counter exists to catch a model stuck in a loop, not a model that
      // had one bad turn hours ago.
      if (!snapshot.tripped && (snapshot.textChars > 0 || snapshot.toolCallChars > 0)) {
        recoveries = 0;
      }
    },
    truncateDisplay(markdown, messageType) {
      if (messageType !== "assistant-thinking" || !truncating) return markdown;
      return truncateThinkingForDisplay(markdown, limits);
    },
    state() {
      return { truncating, recoveries, tripped };
    },
  };
}
