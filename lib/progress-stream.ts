/**
 * Live progress for long-running gate tools.
 *
 * WHY THIS EXISTS (measured, .pi/gate-timings.jsonl): a review round takes 8.9
 * minutes at the median and a full precommit 92 seconds — and every one of
 * those calls used to be a silent tool invocation. The silence is not a
 * cosmetic problem: a user watching a frozen call cannot tell a running suite
 * from a hung process, and that is exactly when a healthy run gets killed.
 *
 * The channel is the tool's own `onUpdate` (the 4th argument of `execute`,
 * the same one pi's built-in bash tool uses for live output). It renders a
 * PARTIAL RESULT for the human — it never changes what the agent finally
 * receives, so progress text must never be folded into the tool's return
 * value: the two channels say different things on purpose.
 *
 * The rendering is a pure function; the reporter around it only throttles.
 */

/** The `onUpdate` sink a tool's `execute` receives as its 4th argument. */
export type ToolUpdate = (partial: {
  content: { type: "text"; text: string }[];
  details: undefined;
}) => void;

/** How often a reporter may publish. Fast enough to look live, slow enough
 *  not to spam the UI with a frame per log line. */
export const PROGRESS_THROTTLE_MS = 2000;

/** A blocking call slower than this earns ONE notice — the point is to kill
 *  the "the editor is stuck" illusion, not to narrate a 200ms round-trip. */
export const SLOW_NOTICE_MS = 3000;

export type ProgressState = "running" | "done" | "failed";

export interface ProgressStep {
  label: string;
  state: ProgressState;
  /** Short outcome note ("PASS", a sha, a count) — never a paragraph. */
  detail?: string;
  /** Wall-clock ms this step has taken so far. */
  elapsedMs: number;
}

const MARKERS: Record<ProgressState, string> = { running: "…", done: "✓", failed: "✗" };

/** Whole seconds, floored — a progress line is not a stopwatch. */
function secs(ms: number): string {
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

/**
 * One progress frame: the title with the total elapsed time, one line per
 * step, and (optionally) the live output tail underneath.
 *
 * Pure and total: no step list, no tail and a zero elapsed time all render
 * something honest rather than throwing.
 */
export function renderProgress(
  title: string,
  steps: readonly ProgressStep[],
  totalElapsedMs: number,
  tail?: string,
): string {
  const lines = [`${title}（已耗时 ${secs(totalElapsedMs)}）`];
  for (const s of steps) {
    lines.push(`  ${MARKERS[s.state]} ${s.label}${s.detail ? ` — ${s.detail}` : ""} ${secs(s.elapsedMs)}`);
  }
  const trimmed = tail?.replace(/\s+$/, "");
  if (trimmed) lines.push("--- 实时输出 ---", trimmed);
  return lines.join("\n");
}

export interface ProgressReporter {
  /** Start a step; the previous running step is closed as done. */
  step(label: string): void;
  /** Attach an outcome to the current step and close it. */
  done(detail?: string): void;
  /** Close the current step as FAILED (the frame is published immediately). */
  fail(detail?: string): void;
  /** Replace the live output tail shown under the steps. */
  tail(text: string): void;
  /** Publish the current frame now, ignoring the throttle. */
  flush(): void;
}

/**
 * A throttled reporter over `onUpdate`.
 *
 * No timers: every frame is published from a call the tool is already making
 * (a step transition, a log line), so a reporter cannot outlive its tool call
 * or keep the event loop alive. Steps therefore stop ticking when nothing
 * happens — which is the honest reading: nothing HAS happened.
 *
 * A missing `onUpdate` (an internal call, a host without partial results)
 * makes every method a no-op, so callers never branch on it.
 */
export function createProgressReporter(opts: {
  title: string;
  onUpdate?: ToolUpdate;
  now?: () => number;
  throttleMs?: number;
}): ProgressReporter {
  const now = opts.now ?? Date.now;
  const throttleMs = opts.throttleMs ?? PROGRESS_THROTTLE_MS;
  const startedAt = now();
  const steps: ProgressStep[] = [];
  let tailText = "";
  let lastPublishedAt = 0;
  let lastText = "";

  const closeCurrent = (state: ProgressState, detail?: string): void => {
    const current = steps[steps.length - 1];
    if (!current || current.state !== "running") return;
    current.state = state;
    if (detail !== undefined) current.detail = detail;
  };

  const publish = (force: boolean): void => {
    if (!opts.onUpdate) return;
    const at = now();
    if (!force && at - lastPublishedAt < throttleMs) return;
    // Re-time the running step from ITS start, not from the frame's.
    const text = renderProgress(opts.title, steps, at - startedAt, tailText);
    if (text === lastText) return; // nothing moved — do not repaint
    lastPublishedAt = at;
    lastText = text;
    try {
      opts.onUpdate({ content: [{ type: "text", text }], details: undefined });
    } catch { /* a broken sink must never fail the tool it decorates */ }
  };

  return {
    step(label) {
      // Time the outgoing step BEFORE closing it, or it would report 0s.
      stampElapsed();
      closeCurrent("done");
      steps.push({ label, state: "running", elapsedMs: 0 });
      stampElapsed();
      publish(true);
    },
    done(detail) {
      stampElapsed();
      closeCurrent("done", detail);
      publish(true);
    },
    fail(detail) {
      stampElapsed();
      closeCurrent("failed", detail);
      publish(true);
    },
    tail(text) {
      tailText = text;
      stampElapsed();
      publish(false);
    },
    flush() {
      stampElapsed();
      publish(true);
    },
  };

  /** Keep the running step's elapsed time current before every frame. */
  function stampElapsed(): void {
    const at = now();
    let consumed = 0;
    for (const s of steps) if (s.state !== "running") consumed += s.elapsedMs;
    const current = steps[steps.length - 1];
    if (current && current.state === "running") current.elapsedMs = at - startedAt - consumed;
  }
}

/**
 * Where a slow-call notice goes. Two surfaces, because the two callers have
 * two different channels: a TOOL has `onUpdate` (partial results), while a
 * `tool_call` HOOK has none at all and must use the status bar.
 */
export interface SlowNoticeSink {
  /** Fires once, only if the work outlives the threshold. */
  announce: (message: string) => void;
  /** Fires when the work settles, only if `announce` fired. */
  clear?: () => void;
}

/** A tool's partial-result channel as a slow-notice sink. */
export function toolNotice(onUpdate: ToolUpdate | undefined): SlowNoticeSink | undefined {
  if (!onUpdate) return undefined;
  return { announce: (message) => onUpdate({ content: [{ type: "text", text: message }], details: undefined }) };
}

/**
 * The status bar as a slow-notice sink, for hooks. `key` scopes the line so
 * the gate only ever clears its own, and the clear is what keeps a finished
 * check from leaving "classifying…" on screen forever.
 */
export function statusNotice(
  ui: { setStatus?: (key: string, text: string | undefined) => void } | undefined,
  key: string,
): SlowNoticeSink | undefined {
  const setStatus = ui?.setStatus;
  if (!setStatus) return undefined;
  return {
    announce: (message) => setStatus(key, message),
    clear: () => setStatus(key, undefined),
  };
}

/**
 * Announce ONE notice if `work` is still running after `thresholdMs`.
 *
 * For the LLM guards (L5 semantics, L6 labels): they sit on the edit and
 * commit hot paths, take a few seconds, and their silence reads as a frozen
 * editor. A full progress stream would be noise — one line, only when the
 * call is actually slow, is the whole requirement.
 *
 * The timer is `unref`ed and always cleared, so a fast call costs nothing, a
 * slow one never holds the process open, and a call that THREW still takes
 * its notice down with it.
 */
export async function withSlowNotice<T>(
  sink: SlowNoticeSink | undefined,
  message: string,
  work: () => Promise<T>,
  thresholdMs: number = SLOW_NOTICE_MS,
): Promise<T> {
  if (!sink) return work();
  let announced = false;
  const timer = setTimeout(() => {
    announced = true;
    try { sink.announce(message); } catch { /* a broken sink must never fail the work */ }
  }, thresholdMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    return await work();
  } finally {
    clearTimeout(timer);
    if (announced) {
      try { sink.clear?.(); } catch { /* same */ }
    }
  }
}
