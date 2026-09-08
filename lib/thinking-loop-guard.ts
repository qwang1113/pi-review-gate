/**
 * Thinking-loop guard — detection of "pure thinking" spinning.
 *
 * WHY. A reasoning model can enter a degenerate loop at long context + max
 * effort: a turn produces ONLY thinking deltas, never a text block and never a
 * tool call, so the turn never completes and Pi never ends it — the user has
 * to abort by hand while the screen fills with tens of thousands of thinking
 * chunks (measured upstream: deepseek-ai/deepseek-harness#5976 — ~67k events in
 * 2m15s, zero tool calls, zero reply text). The dsh side fixed it with a plugin
 * that watches the assistant stream; this is the same guard for Pi, where
 * `message_update` carries an `assistantMessageEvent` with `thinking_delta` /
 * `text_delta` / `toolcall_delta` chunks.
 *
 * WHAT TRIPS IT — three conditions, ALL required, so ordinary long thinking is
 * never cut short:
 *   1. the turn has produced ZERO text and ZERO tool-call content so far;
 *   2. its thinking has grown past `minThinkingChars`;
 *   3. the tail window is LOW ENTROPY: at least `minDistinctNgrams` DISTINCT
 *      n-grams each repeat `minRepeats` times. Real reasoning repeats an
 *      8-character phrase twelve times inside 800 characters essentially never;
 *      the upstream sample ("好。执行。好。（输出）好。好。") does it constantly.
 *      The distinct-count half is what keeps a single repeated RUN out of the
 *      verdict: one long `--------` rule repeats the same 8-gram dozens of
 *      times while the rest of the window is ordinary prose, and that is a
 *      drawing, not a loop. A real loop repeats a whole cycle, so MANY
 *      different n-grams cross the threshold at once.
 *
 * PURE, NO I/O. This module owns only the decision (and the display cut that
 * keeps the loop from flooding the terminal); the caller owns the stream
 * subscription, the abort and the injected notice. Everything here is a
 * function of the delta sequence, so it is testable without Pi.
 */

/** Streaming delta kinds the guard distinguishes. */
export type StreamDeltaKind = "thinking" | "text" | "toolcall";

export interface ThinkingLoopConfig {
  /** Thinking characters a turn must accumulate before the guard judges it. */
  minThinkingChars: number;
  /** Tail window (characters) the repeat check runs over. */
  windowChars: number;
  /** n-gram length for the repeat check. */
  ngramChars: number;
  /** How often an n-gram must repeat in the window to count as high-frequency. */
  minRepeats: number;
  /** How many DISTINCT high-frequency n-grams the window needs (a single run is not a loop). */
  minDistinctNgrams: number;
}

export const THINKING_LOOP_DEFAULTS: ThinkingLoopConfig = Object.freeze({
  minThinkingChars: 1200,
  windowChars: 800,
  ngramChars: 8,
  minRepeats: 12,
  // 2, not 3: a two-character cycle ("好。好。好。") yields exactly two distinct
  // 8-grams, and that is the fastest-spinning shape there is. One is the floor
  // that still excludes a drawn run — see `repeatedNgrams`.
  minDistinctNgrams: 2,
});

/**
 * The repeat check is O(window); re-running it on every one-character delta
 * would burn CPU for no extra precision, so it runs at most once per this many
 * newly observed thinking characters.
 */
export const THINKING_LOOP_CHECK_INTERVAL = 64;

export interface ThinkingLoopVerdict {
  /** Thinking characters observed in the turn when the guard tripped. */
  thinkingChars: number;
  /** Repetitions of the most frequent n-gram in the tail window. */
  repeats: number;
  /** How many distinct n-grams crossed `minRepeats`. */
  distinct: number;
}

export interface ThinkingLoopSnapshot {
  thinkingChars: number;
  textChars: number;
  toolCallChars: number;
  tripped: boolean;
}

export interface ThinkingLoopDetector {
  /**
   * Fold one stream delta in. Returns a verdict exactly ONCE per turn — on
   * the delta that crosses all three conditions — and undefined otherwise
   * (including every delta after the trip, so the caller cannot double-abort).
   */
  observe(kind: StreamDeltaKind, delta: string): ThinkingLoopVerdict | undefined;
  /** Start a fresh turn. */
  reset(): void;
  /** What the turn has produced so far (used by the controller). */
  snapshot(): ThinkingLoopSnapshot;
}

export interface NgramRepeatStats {
  /** Count of the most repeated n-gram in the window. */
  max: number;
  /** How many DISTINCT n-grams repeat at least `minRepeats` times. */
  distinct: number;
}

/**
 * Repeat statistics of `text`'s n-grams.
 *
 * `max` alone cannot tell a loop from a drawing: one long `--------` rule
 * repeats a single 8-gram dozens of times. `distinct` is the discriminator —
 * a loop repeats a whole CYCLE, so many different n-grams cross the threshold
 * together, while a run or a single duplicated phrase contributes one.
 *
 * Both are 0 for text shorter than one n-gram.
 */
export function repeatedNgrams(
  text: string,
  ngramChars: number,
  minRepeats: number,
): NgramRepeatStats {
  if (ngramChars <= 0 || text.length < ngramChars) return { max: 0, distinct: 0 };
  const counts = new Map<string, number>();
  for (let i = 0; i + ngramChars <= text.length; i++) {
    const gram = text.slice(i, i + ngramChars);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let max = 0;
  let distinct = 0;
  for (const count of counts.values()) {
    if (count > max) max = count;
    if (count >= minRepeats) distinct += 1;
  }
  return { max, distinct };
}

export function createThinkingLoopDetector(
  config: Partial<ThinkingLoopConfig> = {},
): ThinkingLoopDetector {
  const cfg: ThinkingLoopConfig = { ...THINKING_LOOP_DEFAULTS, ...config };
  let thinkingChars = 0;
  let textChars = 0;
  let toolCallChars = 0;
  let tail = "";
  let sinceCheck = 0;
  let tripped = false;

  return {
    observe(kind, delta) {
      if (!delta) return undefined;
      if (kind === "text") {
        textChars += delta.length;
        return undefined;
      }
      if (kind === "toolcall") {
        toolCallChars += delta.length;
        return undefined;
      }
      thinkingChars += delta.length;
      sinceCheck += delta.length;
      tail = (tail + delta).slice(-cfg.windowChars);
      if (tripped) return undefined;
      // A turn that produced any text or tool-call content is WORKING, not
      // spinning — condition 1, and it stays false for the rest of the turn.
      if (textChars > 0 || toolCallChars > 0) return undefined;
      if (thinkingChars < cfg.minThinkingChars) return undefined;
      if (sinceCheck < THINKING_LOOP_CHECK_INTERVAL) return undefined;
      sinceCheck = 0;
      const stats = repeatedNgrams(tail, cfg.ngramChars, cfg.minRepeats);
      if (stats.max < cfg.minRepeats || stats.distinct < cfg.minDistinctNgrams) return undefined;
      tripped = true;
      return { thinkingChars, repeats: stats.max, distinct: stats.distinct };
    },
    reset() {
      thinkingChars = 0;
      textChars = 0;
      toolCallChars = 0;
      tail = "";
      sinceCheck = 0;
      tripped = false;
    },
    snapshot() {
      return { thinkingChars, textChars, toolCallChars, tripped };
    },
  };
}

// ---------------------------------------------------------------------------
// Display cut. Display-only: the session keeps every thinking token, only what
// the terminal renders is bounded.

/** Prepended to a truncated thinking block so the reader knows content was cut. */
export const THINKING_TRUNCATION_MARKER = "…（已省略重复思考）";

export interface ThinkingDisplayLimits {
  maxChars: number;
  maxLines: number;
}

export const THINKING_DISPLAY_LIMITS: ThinkingDisplayLimits = Object.freeze({
  maxChars: 1200,
  maxLines: 20,
});

/**
 * Cut a thinking block down to its LAST `maxLines` lines AND its last
 * `maxChars` characters (the most recent reasoning is the part a reader can
 * still act on) and mark the cut.
 *
 * BOTH limits are enforced, marker included, because a line count alone does
 * not bound anything: the upstream loop sample has no newlines at all, so a
 * `maxLines` cut would keep the entire flood on screen. Untouched input is
 * returned unchanged, so a normal thinking block is never rewritten.
 */
export function truncateThinkingForDisplay(
  markdown: string,
  limits: ThinkingDisplayLimits = THINKING_DISPLAY_LIMITS,
): string {
  const maxChars = Math.max(0, Math.floor(limits.maxChars));
  const maxLines = Math.max(1, Math.floor(limits.maxLines));
  if (markdown.length <= maxChars && markdown.split("\n").length <= maxLines) return markdown;
  const marker = THINKING_TRUNCATION_MARKER;
  // The marker and its newline are part of the budget. A budget too small to
  // hold them can only show the marker itself (clipped).
  const bodyBudget = maxChars - marker.length - 1;
  if (bodyBudget <= 0) return marker.slice(0, maxChars);
  const keepLines = Math.max(1, maxLines - 1);
  let body = markdown.split("\n").slice(-keepLines).join("\n");
  if (body.length > bodyBudget) body = body.slice(-bodyBudget);
  return `${marker}\n${body}`;
}
