/**
 * Read-only drill stall guard — tool-call-layer no-progress detection.
 *
 * WHY: a session (or an orchestration child) can spend many minutes doing
 * read-only tool calls that never produce anything — grepping through
 * `node_modules/` source, reading one more file "to be sure", chasing an
 * open-ended chain of library internals. Every single call SUCCEEDS, so
 * nothing in the existing liveness machinery trips:
 *
 *  - the L2 stall breaker (lib/loop-stall.ts) only evaluates at turn
 *    boundaries — a multi-minute drill happens INSIDE one turn;
 *  - the child-health progress reading (progressStaleSeconds) counts ANY
 *    tool call as forward progress, which is exactly what a drill keeps
 *    producing.
 *
 * This module is the missing PRODUCTIVITY signal: a counter of consecutive
 * read-only calls with no edit landing in between. When the counter reaches
 * `READONLY_STALL_LIMIT`, the extension appends a NUDGE (never a block) to
 * the next result telling the agent to stop drilling and verify by doing.
 *
 * DESIGN CONSTRAINT (mirrors edit-discipline): a NUDGE ONLY — appended text
 * in a tool result. Nothing here blocks, rewrites or interrupts. Drilling
 * can be legitimate (confirming a library's behavior), so the guard must
 * steer, not police. Pure, no I/O — the extension owns the state and this
 * module owns the decision.
 *
 * What counts as "read-only" and "production" is decided by the CALL SITE
 * via the tool-name sets it already owns (EDIT_TOOL_NAMES /
 * READ_ONLY_TOOL_NAMES / bash). This module only folds observations:
 *  - `produce` (an edit/write succeeded) → reset to zero;
 *  - `read` (a read-only call succeeded) → increment;
 *  - anything else → unchanged.
 * The caller decides which observations to feed, so the guard composes with
 * the existing tool taxonomy instead of inventing a new one.
 */

/** Consecutive read-only calls with no production before the guard fires. */
export const READONLY_STALL_LIMIT = 30;

export interface ReadonlyStallState {
  /** Consecutive read-only calls observed since the last production. */
  consecutiveReads: number;
  /** True once the limit has been reached; stays true until production. */
  nudged: boolean;
}

export interface ReadonlyStallInput {
  /** The state folded so far (undefined on the first observation). */
  previous: ReadonlyStallState | undefined;
  /** True when this observation is a successful edit/write (production). */
  produced: boolean;
  /** True when this observation is a successful read-only call. */
  read: boolean;
}

export interface ReadonlyStallVerdict {
  /** The folded state, to be stored by the caller. */
  state: ReadonlyStallState;
  /** True when THIS observation crosses the limit and needs a nudge. */
  nudge: boolean;
}

/**
 * Fold one tool-call observation into the drill counter.
 *
 * Production resets everything — the guard's whole point is that a session
 * which keeps landing edits is making progress no matter how much it reads.
 * A read increments and flips `nudge` exactly when the limit is crossed
 * (once per crossing; it stays true until production so the caller can
 * decide how often to surface it — see the note on `nudged`).
 */
export function evaluateReadonlyStall(input: ReadonlyStallInput): ReadonlyStallVerdict {
  if (input.produced) {
    return { state: { consecutiveReads: 0, nudged: false }, nudge: false };
  }
  if (input.read) {
    const consecutiveReads = (input.previous?.consecutiveReads ?? 0) + 1;
    const reached = consecutiveReads >= READONLY_STALL_LIMIT;
    const nudged = reached || (input.previous?.nudged ?? false);
    return {
      state: { consecutiveReads, nudged },
      nudge: reached && !(input.previous?.nudged ?? false),
    };
  }
  // Neither production nor a read (e.g. a write-blocked tool, a failed call):
  // the counter stands still — an in-between observation is not a drill.
  return {
    state: input.previous ?? { consecutiveReads: 0, nudged: false },
    nudge: false,
  };
}

/**
 * The nudge appended to a tool result when the drill counter crosses the
 * limit. It must (a) say plainly that the session has been reading for a
 * while without producing, (b) steer toward verifying by doing — a minimal
 * implementation or a targeted test — and (c) NOT claim to block or
 * interrupt anything (a nudge can be ignored at no cost).
 */
export const READONLY_STALL_NUDGE =
  "\n\n[review-gate] 你已经连续 " +
  `${READONLY_STALL_LIMIT} 次只读工具调用而没有产出代码改动。` +
  "如果这是在库源码（如 node_modules/）里钻探，先停下来：写一个最小实现或一条测试验证你的假设，" +
  "或直接查项目内既有先例，而不是继续追读源码。门禁没有拦截你，但继续只读调用不会让任务前进。";
