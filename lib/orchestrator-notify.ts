/**
 * DESKTOP notification to the HUMAN — the orchestration layer's only channel
 * to a person who is not looking at the terminal.
 *
 * WHY THIS IS NOT A REGRESSION. lib/attention.ts deliberately has no system
 * notifications, and that rule stands: the thing the user banned was a
 * BROADCAST — any session could raise a banner and every session heard it, so
 * an unrelated task's dialog interrupted whoever was working. This channel is
 * the opposite shape and is bounded by three properties:
 *
 *  1. SINGLE ENTRY (constraint 9). Only an ORCHESTRATOR session may send, and
 *     only through `orchestrator_notify`. Nothing else in the gate calls it.
 *  2. ONE RECIPIENT. It targets the human at this terminal, not other pi
 *     sessions — no session can be interrupted by it, because sessions are
 *     not listening on this channel at all.
 *  3. THROTTLED. An overnight run must be able to say "I need you" without
 *     being able to turn into a pager storm — see {@link decideNotify}.
 *
 * WHY WE WRITE THE ESCAPE SEQUENCES OURSELVES (user decision 7). `pi-notify`
 * is an extension that fires on `agent_end`; it exposes no callable API, so
 * there is nothing to reuse but the protocol itself — which is 4 lines. Doing
 * it here keeps the dependency count at zero and puts the SANITIZATION under
 * our own control, which matters: the payload is agent-written text going
 * into a terminal control sequence, and an unescaped ESC or BEL in it would
 * end the sequence early and let the rest reach the terminal as commands.
 *
 * Pure module except {@link writeNotification}, which is the single line that
 * touches stdout and is injected in tests.
 */

/** Longest title/body actually rendered by the notification daemons. */
export const NOTIFY_TITLE_MAX = 80;
export const NOTIFY_BODY_MAX = 300;

/** Identical text is not repeated inside this window. */
export const NOTIFY_DEDUP_MS = 10 * 60_000;
/** At most this many notifications inside {@link NOTIFY_RATE_WINDOW_MS}. */
export const NOTIFY_RATE_MAX = 5;
export const NOTIFY_RATE_WINDOW_MS = 5 * 60_000;

export type NotifyProtocol = "osc777" | "osc9" | "osc99";

/**
 * Which escape sequence this terminal understands. Same detection order as
 * the reference implementation: Kitty and iTerm2 identify themselves, and
 * OSC 777 is the broad default (Ghostty, WezTerm, rxvt-unicode). A terminal
 * that supports none of them simply ignores the sequence — it is inert text,
 * never garbage on screen, so there is no "unsupported" branch to take.
 */
export function detectNotifyProtocol(env: NodeJS.ProcessEnv = process.env): NotifyProtocol {
  if (env.KITTY_WINDOW_ID) return "osc99";
  if (env.TERM_PROGRAM === "iTerm.app") return "osc9";
  return "osc777";
}

/**
 * Strip everything that could terminate or hijack the escape sequence.
 *
 * The payload is agent-written, so this is a security boundary, not tidying:
 * ESC (0x1b), BEL (0x07), and the C1 string terminator all END an OSC
 * sequence, and `;` separates its fields. Control characters are removed and
 * semicolons are replaced, so the text can only ever be a field VALUE.
 */
export function sanitizeNotifyText(raw: string, max: number): string {
  const cleaned = String(raw ?? "")
    // eslint-disable-next-line no-control-regex -- removing controls is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/;/g, ",")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

/**
 * tmux passthrough: a terminal escape sent from inside tmux is swallowed
 * unless it is wrapped in a DCS passthrough, with every inner ESC doubled.
 * (This requires `set -g allow-passthrough on` in the user's tmux config —
 * their configuration to make, never ours to write: the gate refuses global
 * option writes, including its own.)
 */
export function wrapForTmux(sequence: string, insideTmux: boolean): string {
  if (!insideTmux) return sequence;
  const escaped = sequence.split("\u001b").join("\u001b\u001b");
  return `\u001bPtmux;${escaped}\u001b\\`;
}

/** Build the raw sequence for one protocol (already-sanitized text). */
export function buildNotifySequence(
  protocol: NotifyProtocol,
  title: string,
  body: string,
): string {
  switch (protocol) {
    case "osc99":
      // Kitty: i=id, d=0 "more to come", p=title then p=body.
      return `\u001b]99;i=1:d=0:p=title;${title}\u001b\\\u001b]99;i=1:d=1:p=body;${body}\u001b\\`;
    case "osc9":
      return `\u001b]9;${title}: ${body}\u0007`;
    case "osc777":
    default:
      return `\u001b]777;notify;${title};${body}\u0007`;
  }
}

/** Everything needed to emit one notification, already assembled. */
export interface NotifyPayload {
  title: string;
  body: string;
  protocol: NotifyProtocol;
  sequence: string;
}

/** Sanitize + detect + build, in one call. */
export function prepareNotification(opts: {
  title: string;
  body: string;
  env?: NodeJS.ProcessEnv;
}): NotifyPayload {
  const env = opts.env ?? process.env;
  const title = sanitizeNotifyText(opts.title, NOTIFY_TITLE_MAX) || "review-gate";
  const body = sanitizeNotifyText(opts.body, NOTIFY_BODY_MAX);
  const protocol = detectNotifyProtocol(env);
  return {
    title,
    body,
    protocol,
    sequence: wrapForTmux(buildNotifySequence(protocol, title, body), Boolean(env.TMUX)),
  };
}

// ---------------------------------------------------------------------------
// Throttling (constraint 9)
// ---------------------------------------------------------------------------

/** What the throttle remembers between calls (persisted in the sidecar). */
export interface NotifyHistory {
  /** Epoch ms of recent sends, oldest first. */
  sentAt: number[];
  /** Text key → epoch ms of the last time that exact text was sent. */
  lastByKey: Record<string, number>;
}

export type NotifyDecision =
  | { send: true }
  | { send: false; reason: string };

/**
 * A fresh, empty history.
 *
 * A FUNCTION rather than a frozen constant on purpose: a shared frozen object
 * invites `{ ...EMPTY, sentAt: [], lastByKey: {} }` at every call site — the
 * spread reads as if it did something while the override is what actually
 * makes the containers safe to mutate. Handing back new containers removes
 * the trap instead of documenting it.
 */
export function emptyNotifyHistory(): NotifyHistory {
  return { sentAt: [], lastByKey: {} };
}

/** The identity used for de-duplication: the rendered text, nothing else. */
export function notifyKey(title: string, body: string): string {
  return `${title}\u0000${body}`;
}

/**
 * Should this notification actually fire?
 *
 * Two independent limits, and they answer different failure modes:
 *  - DEDUP kills the "same unanswered question every loop iteration" pattern,
 *    which is what actually reaches a sleeping user as a pager storm;
 *  - the RATE limit bounds a run that has many DIFFERENT things to say, so a
 *    misbehaving orchestration cannot empty its plan into someone's phone.
 *
 * Pure: history in, decision out. The caller records the send.
 */
export function decideNotify(opts: {
  history: NotifyHistory;
  key: string;
  now: number;
}): NotifyDecision {
  const last = opts.history.lastByKey[opts.key];
  if (last !== undefined && opts.now - last < NOTIFY_DEDUP_MS) {
    const waitS = Math.ceil((NOTIFY_DEDUP_MS - (opts.now - last)) / 1000);
    return { send: false, reason: `同样的通知 ${Math.round(NOTIFY_DEDUP_MS / 60000)} 分钟内已发过，还需等待约 ${waitS}s` };
  }
  const recent = opts.history.sentAt.filter((t) => opts.now - t < NOTIFY_RATE_WINDOW_MS);
  if (recent.length >= NOTIFY_RATE_MAX) {
    return {
      send: false,
      reason: `通知频率超限（${NOTIFY_RATE_WINDOW_MS / 60000} 分钟内最多 ${NOTIFY_RATE_MAX} 条）——请把要说的合并成一条`,
    };
  }
  return { send: true };
}

/** Fold a send into the history (pure; the caller persists the result). */
export function recordNotify(history: NotifyHistory, key: string, now: number): NotifyHistory {
  const sentAt = [...history.sentAt, now].filter((t) => now - t < NOTIFY_RATE_WINDOW_MS);
  // Keep the dedup table bounded: only keys still inside the dedup window can
  // ever suppress anything, so older entries are dead weight.
  const lastByKey: Record<string, number> = {};
  for (const [k, t] of Object.entries(history.lastByKey)) {
    if (now - t < NOTIFY_DEDUP_MS) lastByKey[k] = t;
  }
  lastByKey[key] = now;
  return { sentAt, lastByKey };
}

/**
 * The ONE side effect. Split out so every decision above stays testable and
 * no test can put an escape sequence on a real terminal.
 */
export function writeNotification(
  sequence: string,
  write: (chunk: string) => void = (chunk) => { process.stdout.write(chunk); },
): void {
  try {
    write(sequence);
  } catch {
    /* best-effort: a notification is never a gate condition */
  }
}
