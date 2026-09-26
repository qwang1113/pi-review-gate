/**
 * THE BANNER THAT REACHES A PERSON WHO IS NOT LOOKING AT THE TERMINAL.
 *
 * WHAT THIS REPLACED, AND WHY (user decision, 2026-09-17). The gate used to
 * write an OSC 777/9/99 escape to stdout and trust tmux's `allow-passthrough`
 * to forward it. Measured on tmux 3.7c with a real client attached to a pty we
 * captured: with `on` — the value on this machine — the sequence reaches the
 * terminal ONLY while the pane is visible, and is DROPPED (not buffered, not
 * delayed) when the client is showing another window, which is exactly the
 * situation a notification exists for. `off` forwards nothing at all. The
 * other candidate, `osascript -e 'display notification'`, arrives reliably but
 * is delivered by Script Editor, so CLICKING IT OPENS SCRIPT EDITOR. The user
 * asked for the click to come back to the terminal, and that is the whole
 * reason this module drives `terminal-notifier` (a 1MB MIT CLI):
 *
 *     terminal-notifier -title … -message … -activate "$__CFBundleIdentifier" \
 *                       -execute "tmux select-window -t @3; tmux select-pane -t %7"
 *
 * Clicking the banner therefore activates the terminal AND jumps to the very
 * pane that raised it. WHICH app is raised is the session's own
 * (`defaultActivateBundle`), never a guess: the value in that example is the
 * macOS `__CFBundleIdentifier`, and an unknown one drops `-activate` entirely
 * so the click can still jump panes. (No buttons and no custom icon: both were
 * offered and the user declined — macOS has no API for a notification's icon,
 * and an action button needs a process parked on the click.)
 *
 * WHO MAY RAISE ONE (user decision, 2026-09-17): exactly three kinds of event,
 * and only in a session that has no supervisor above it — a project manager,
 * or a loop session running on its own. An orchestration CHILD is never one of
 * them: its manager answers its questions, and the manager is the one who
 * decides that the human is needed. The kinds are {@link UserNotifyKind}:
 *
 *   - `finished`   — `declare_done` was accepted (the round's exit contract met);
 *   - `failed`     — the process ended with NO record of a clean shutdown
 *                    (pi fires `session_shutdown` for quit, reload, new,
 *                    resume and fork, and the extension records it): a crash
 *                    rather than a quit. That record is the WHOLE judge —
 *                    {@link exitNotifyKind} reads nothing else — so the banner
 *                    says "abnormal end", never "you never declared done";
 *   - `needs-user` — the gate has stopped and is waiting for an answer that
 *                    only the human can give (every gate dialog, `ask_user`
 *                    included, funnels through one call site).
 *
 * THERE IS NO TOOL ANY MORE. `orchestrator_notify` let the manager choose when
 * to interrupt the human, which is the thing this rule exists to prevent; it
 * is deleted rather than restricted. A manager that needs a person calls
 * `ask_user`, which IS kind `needs-user`.
 *
 * STILL THROTTLED (constraint 9): identical text is not repeated inside
 * {@link NOTIFY_DEDUP_MS}, and at most {@link NOTIFY_RATE_MAX} banners go out
 * inside {@link NOTIFY_RATE_WINDOW_MS} — an overnight run must be able to say
 * "I need you" without becoming a pager storm.
 *
 * TWO MORE RULES FROM THE USER'S SAME REPORT (2026-09-18), both of which keep
 * a CORRECT banner from still being the wrong one:
 *
 *   - NOT WHILE THEY ARE LOOKING. A banner is for a person who is NOT at that
 *     pane: if this session's pane is the active one on an attached tmux client
 *     AND the session's own app is frontmost, the user is already reading the
 *     box and a banner is pure interruption ({@link isWatchingPane}).
 *   - ONE BANNER PER SESSION. Every send carries `-group <session id>`, and the
 *     notifier removes an older banner with the same group — so a four-question
 *     interview leaves ONE banner in Notification Center, not four
 *     ({@link buildNotifierArgv}).
 *
 * PURE. Every decision lives in {@link planUserNotify}: it takes the state and
 * returns the argv to run or the reason not to. The caller owns the two side
 * effects (`spawn` and persisting the history), so no test can put a banner on
 * somebody's screen.
 */

import type { TaskMode } from "./task-mode.ts";
// THE PANE-ID SHAPE HAS ONE IMPLEMENTATION (quality round P2, 2026-09-18). This
// module reads pane ids that tmux itself printed, and the gate's canonical
// predicate is the one lib/orchestrator-tmux.ts exports — a local `^%\d+$`
// accepted widths the canonical check rejects, in a repo that then held four
// copies of the rule.
import { isPaneId } from "./orchestrator-tmux.ts";

/** Longest title/body a notification actually renders. */
export const NOTIFY_TITLE_MAX = 80;
export const NOTIFY_BODY_MAX = 300;

/** Identical text is not repeated inside this window. */
export const NOTIFY_DEDUP_MS = 10 * 60_000;
/** At most this many notifications inside {@link NOTIFY_RATE_WINDOW_MS}. */
export const NOTIFY_RATE_MAX = 5;
export const NOTIFY_RATE_WINDOW_MS = 5 * 60_000;

/** The CLI that actually delivers (brew, MIT). */
export const NOTIFIER_BINARY = "terminal-notifier";

/**
 * WHERE THE CLICK LANDS: the macOS app this session actually runs in.
 *
 * `__CFBundleIdentifier` is set by LaunchServices for every process a GUI app
 * spawns, and a tmux server inherits it from the terminal that started it —
 * which is what makes it the right source here. `TERM_PROGRAM` is NOT:
 * measured 2026-09-17, inside tmux it is literally `tmux`, so a session in
 * tmux cannot name its terminal that way at all. The constant this replaced —
 * a hard-coded `com.mitchellh.ghostty` — sent every click to Ghostty whether
 * or not that is where the session lives (reviewer Nit, carried two rounds).
 *
 * Absent (a tmux server started outside a GUI session, a non-macOS host) ⇒
 * the banner carries no `-activate`: the click still runs `-execute`'s tmux
 * focus command, it just does not raise the terminal window.
 */
export function defaultActivateBundle(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = (env["__CFBundleIdentifier"] ?? "").trim();
  return id.length > 0 ? id : undefined;
}

/** Said once, at session start, when the binary is missing. */
export const MISSING_NOTIFIER_HINT =
  `通知是关的：没找到 \`${NOTIFIER_BINARY}\`。装上它是这一行：\`brew install ${NOTIFIER_BINARY}\``;

/** The three — and only three — things worth interrupting a person for. */
export type UserNotifyKind = "finished" | "failed" | "needs-user";

/**
 * Strip what a notification daemon cannot render, and cap the length.
 *
 * The payload is agent-written text. It no longer travels inside a terminal
 * escape sequence (the OSC path is gone), so this is no longer a security
 * boundary — but a title with a newline in it still renders as a broken
 * banner, and an unbounded body is silently truncated by macOS anyway. What
 * the user reads should be what the gate decided to say.
 */
export function sanitizeNotifyText(raw: string, max: number): string {
  const cleaned = String(raw ?? "")
    // eslint-disable-next-line no-control-regex -- removing controls is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

/**
 * MAY THIS SESSION RAISE A BANNER AT ALL?
 *
 * Only a session with nobody above it: an orchestrator (project manager) or a
 * loop session running on its own. `RG_STATE_VARIANT` is what makes a session
 * an orchestration child (lib/session-env.ts sets it to the child id), and
 * a child's questions belong to its manager — the manager answers them through
 * the channel, and only IT decides that the human is needed.
 *
 * `judge` is not part of {@link TaskMode}: judge panes run `normal` with their
 * own identity, and they are covered by `RG_STATE_VARIANT` never being set for
 * them plus the mode check below.
 */
export function mayNotifyUser(opts: {
  taskMode: TaskMode | undefined;
  stateVariant: string | undefined;
}): boolean {
  if ((opts.stateVariant ?? "").trim() !== "") return false;
  return opts.taskMode === "orchestrator" || opts.taskMode === "loop";
}

/**
 * DOES THIS EXIT DESERVE A BANNER?
 *
 * The whole of user decision 2026-09-17 on failure: a session the user ended
 * themselves is not news (pi's `session_shutdown` fires for quit, reload, new,
 * resume and fork, and the extension records it), while a process that dies
 * with no such record — an uncaught exception, a broken invariant, a provider
 * failure that took it down — is exactly the thing nobody can see.
 *
 * A PURE FUNCTION because the caller is an `exit` handler, where nothing else
 * can be reached or tested: the handler asks this one question and, if the
 * answer is a kind, sends it. (It is also the only honest place to state the
 * LIMIT: SIGKILL runs no handler at all, so a hard kill is silent — and that is
 * the same case as the user's own `kill`, which they do not need told about.)
 */
export function exitNotifyKind(opts: { cleanShutdown: boolean }): UserNotifyKind | undefined {
  return opts.cleanShutdown ? undefined : "failed";
}

/** What the banner says, per kind. Pure; sanitization happens in the caller. */
export function buildUserNotifyMessage(opts: {
  kind: UserNotifyKind;
  /** The repo's directory name — what tells three running sessions apart. */
  repoName: string;
  /** The summary, the failure reason, or the question being asked. */
  detail: string;
}): { title: string; body: string } {
  const where = opts.repoName.trim() || "pi";
  const detail = opts.detail.trim();
  switch (opts.kind) {
    case "finished":
      return { title: `任务完成 · ${where}`, body: detail || "任务完成。" };
    case "failed":
      return {
        title: `异常结束 · ${where}`,
        body: detail || "会话异常结束（进程没有走正常关闭流程）。",
      };
    case "needs-user":
    default:
      return { title: `等你回答 · ${where}`, body: detail || "门禁停下来等你回答。" };
  }
}

/**
 * The click command: bring the client to the pane that raised the banner.
 *
 * BOTH HALVES ARE NEEDED. `select-window` alone moves the client to the right
 * window but leaves the pane as it was; `select-pane` alone cannot leave the
 * window the client is on. Right order, one command, so a click cannot do half
 * the job.
 *
 * Returns `undefined` for anything that is not a well-formed tmux id: the
 * command is handed to a shell by the notifier, and an id is validated rather
 * than escaped — a target that fails validation is dropped, never pasted in
 * half-built. (The values come from tmux itself, so a failure here means
 * something is wrong with our own state, not with a hostile input.)
 */
export function buildFocusCommand(opts: {
  paneId: string;
  windowId: string | undefined;
}): string | undefined {
  const pane = opts.paneId.trim();
  if (!isPaneId(pane)) return undefined;
  const window = (opts.windowId ?? "").trim();
  if (/^@\d+$/.test(window)) {
    return `tmux select-window -t ${window}; tmux select-pane -t ${pane}`;
  }
  // No window id (the lookup failed): select the pane where it lives. tmux
  // accepts a pane id for `select-window` too — MEASURED on 3.7c: with the
  // client on window 0, `select-window -t %1` (a pane in window 1) moved it to
  // window 1 — so both halves still run and the click lands the same way.
  return `tmux select-window -t ${pane}; tmux select-pane -t ${pane}`;
}

/** `terminal-notifier`'s own argv — the binary first, like exec accepts. */
export function buildNotifierArgv(opts: {
  title: string;
  body: string;
  /** From {@link buildFocusCommand}; omitted when there is no pane to jump to. */
  focusCommand?: string | undefined;
  /** From {@link defaultActivateBundle}; omitted ⇒ no `-activate` at all. */
  activateBundle?: string | undefined;
  /**
   * The banner's group (usually the session id): the notifier REMOVES an older
   * banner with the same id, so one session keeps ONE banner in Notification
   * Center instead of a stack of them (module doc, second bullet).
   * Omitted only when the session has no id to group under.
   */
  group?: string | undefined;
}): string[] {
  const argv = [
    NOTIFIER_BINARY,
    "-title", opts.title,
    "-message", opts.body,
  ];
  if (opts.group) argv.push("-group", opts.group);
  // NO `-activate` WITHOUT A KNOWN BUNDLE. There is no safe default to fall
  // back on — a guessed bundle id raises somebody else's app, or nothing —
  // and the hard-coded Ghostty did exactly that on every other terminal.
  if (opts.activateBundle) argv.push("-activate", opts.activateBundle);
  if (opts.focusCommand) argv.push("-execute", opts.focusCommand);
  return argv;
}

// ---------------------------------------------------------------------------
// Is the human already looking at it?
// ---------------------------------------------------------------------------

/**
 * IS THE USER LOOKING AT THE PANE THAT IS ASKING?
 *
 * User decision (2026-09-18): "只有我不在当前会话 panel 的才弹通知". A banner is
 * for someone who is NOT there, so when the asking session's pane is the one
 * an attached tmux client currently SHOWS *and* the session's own app is
 * frontmost, the user is reading the box already and the banner is pure
 * interruption.
 *
 * BOTH HALVES ARE REQUIRED, and they cover different ways of not looking:
 *   - the ACTIVE-PANE half catches the user driving another window or pane in
 *     the same terminal (the box is on a pane they are not looking at);
 *   - the FRONTMOST half catches the terminal being behind a browser or an
 *     editor (the pane is the active one, but it is not on screen).
 *
 * FAIL OPEN, ALWAYS. Every unknown — no pane id, no attached client, an
 * unreadable frontmost app (`lsappinfo` failing, a non-macOS host), a session
 * whose own bundle id is unknown — answers `false`, because a suppressed
 * banner is a user who is never told. Suppression has to be EARNED by two
 * facts agreeing; it is never the default.
 *
 * THE APPS ARE COMPARED LOOSELY, AND THAT IS THE SAFE DIRECTION (quality round
 * P2, 2026-09-18): `sessionBundleId` is the terminal that started the tmux
 * SERVER (`__CFBundleIdentifier` is inherited), not necessarily the app hosting
 * the client that is attached — so attaching from a second terminal app makes
 * the two differ and the banner GOES OUT. The failure is an extra notification,
 * never a silent one, and telling the two app identities apart would mean asking
 * tmux about a client's host, which it does not record.
 *
 * PURE: the caller (lib/user-notify-runtime.ts) pays for the two subprocesses
 * and passes their readings in, so every branch is drivable from a test.
 */
export function isWatchingPane(opts: {
  /** This session's own pane (`TMUX_PANE`), if it runs inside tmux at all. */
  paneId: string | undefined;
  /** What each attached tmux client is currently showing. */
  activePanes: readonly string[];
  /** Bundle id of the frontmost macOS app, when it could be read. */
  frontBundleId: string | undefined;
  /** Bundle id this session lives in (`__CFBundleIdentifier`). */
  sessionBundleId: string | undefined;
}): boolean {
  const pane = (opts.paneId ?? "").trim();
  if (!isPaneId(pane)) return false;
  if (!opts.activePanes.some((shown) => shown.trim() === pane)) return false;
  const front = (opts.frontBundleId ?? "").trim();
  const session = (opts.sessionBundleId ?? "").trim();
  if (front.length === 0 || session.length === 0) return false;
  return front === session;
}

// ---------------------------------------------------------------------------
// Throttling (constraint 9)
// ---------------------------------------------------------------------------

/** What the throttle remembers between banners (persisted in the sidecar). */
export interface NotifyHistory {
  /** Epoch ms of recent sends, oldest first. */
  sentAt: number[];
  /** Text key → epoch ms of the last time that exact text was sent. */
  lastByKey: Record<string, number>;
}

export type NotifyDecision = { send: true } | { send: false; reason: string };

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
 * Read a persisted history out of a sidecar, dropping anything malformed.
 *
 * FAIL-SOFT AND NEVER INVENTING. A history the gate cannot read means "no
 * record of recent sends", which can only ever cause one extra banner — while
 * rounding a broken record to "everything was just sent" would silence the
 * channel for ten minutes with nobody able to see why. Non-finite timestamps
 * are dropped for the same reason: `NaN` compares false against every window
 * test, so a single one would poison the arithmetic rather than merely
 * contributing nothing.
 */
export function normalizeNotifyHistory(raw: unknown): NotifyHistory {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const sentAt = Array.isArray(obj.sentAt)
    ? obj.sentAt.filter((t): t is number => typeof t === "number" && Number.isFinite(t))
    : [];
  const lastByKey: Record<string, number> = {};
  if (obj.lastByKey && typeof obj.lastByKey === "object" && !Array.isArray(obj.lastByKey)) {
    for (const [k, v] of Object.entries(obj.lastByKey as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) lastByKey[k] = v;
    }
  }
  return { sentAt, lastByKey };
}

/**
 * Should this notification actually fire?
 *
 * Two independent limits, and they answer different failure modes:
 *  - DEDUP kills the "same unanswered question every loop iteration" pattern,
 *    which is what actually reaches a sleeping user as a pager storm;
 *  - the RATE limit bounds a run that has many DIFFERENT things to say, so a
 *    misbehaving orchestration cannot empty its plan into someone's screen.
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
      reason: `通知频率超限（${NOTIFY_RATE_WINDOW_MS / 60000} 分钟内最多 ${NOTIFY_RATE_MAX} 条）`,
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

// ---------------------------------------------------------------------------
// The one decision the caller makes
// ---------------------------------------------------------------------------

/**
 * What the caller should do about one event.
 */
export type UserNotifyPlan =
  /** Nobody to tell / nothing to say: a child session, or a test run. */
  | { status: "skipped"; reason: string }
  /** The notifier is not installed — say so, never pretend it went out. */
  | { status: "missing"; hint: string }
  | { status: "throttled"; reason: string }
  /** Run this; then `recordNotify(history, key, now)`. */
  | { status: "send"; key: string; argv: string[]; title: string; body: string };

/**
 * The outcome of an ATTEMPT, as the transcript should report it.
 *
 * Four answers, and keeping them apart is the point: `sent` is a claim about
 * somebody else's screen, `missing` is a thing the user can fix, `throttled`
 * is the gate protecting them from itself, and `skipped` is the rule working.
 * Collapsing them into "done" is how the old path managed to report delivery
 * for a notification tmux had already dropped.
 */
export type UserNotifyOutcome =
  | { status: "sent" }
  | { status: "skipped" | "missing" | "throttled"; note: string };

/** One line for the transcript. */
export function describeNotifyOutcome(outcome: UserNotifyOutcome): string {
  switch (outcome.status) {
    case "sent":
      return "已发出系统通知。";
    case "throttled":
      return `通知被节流：${outcome.note}`;
    case "missing":
      return `通知没发出去：${outcome.note}`;
    default:
      return `没有发通知：${outcome.note}`;
  }
}

/**
 * The whole policy in one pure function: given an event and the session's
 * state, either the argv to run or the reason not to.
 *
 * ORDER MATTERS. `interactive` is checked FIRST: a notification is a side
 * effect on somebody's screen, and a test run (or a CI job) must never be able
 * to fire one, whatever the session's mode says. Then the session's
 * eligibility, then whether there is anything to run at all — a missing binary
 * is reported, not swallowed, because "I told you" and "I could not tell you"
 * are different outcomes and the second one is the user's to fix.
 */
export function planUserNotify(opts: {
  kind: UserNotifyKind;
  /** The repo's directory name. */
  repoName: string;
  /** The summary / reason / question. */
  detail: string;
  taskMode: TaskMode | undefined;
  stateVariant: string | undefined;
  /**
   * This session's tmux address, when it has one — asked LAZILY.
   *
   * A THUNK, not a value (reviewer P2, 2026-09-17): resolving it costs a
   * synchronous `tmux display-message`, and every gate dialog goes through the
   * notification path — including the ones in child sessions and judge panes
   * that can never raise a banner. The policy calls this only on the branch
   * that actually sends.
   */
  tmux?: (() => { paneId: string; windowId?: string | undefined } | undefined) | undefined;
  /**
   * Is the human ALREADY LOOKING at this session ({@link isWatchingPane})?
   *
   * Asked LAZILY for the same reason `tmux` is: answering costs a `list-clients`
   * plus one `display-message` per client plus two `lsappinfo` calls, and every
   * gate dialog comes through here — including the ones in child sessions and
   * judge panes that can never raise a banner.
   */
  watching?: (() => boolean) | undefined;
  /**
   * The notification-centre group (the session id): the notifier removes an
   * older banner with the same id, so one session never stacks up banners.
   */
  group?: string | undefined;
  /** Absolute path of the notifier, or undefined when it is not installed. */
  notifierPath: string | undefined;
  history: NotifyHistory;
  now: number;
  /** False for tests, CI and non-interactive hosts. */
  interactive: boolean;
  /**
   * The app a click should raise, from {@link defaultActivateBundle}.
   *
   * Passed IN rather than read from the environment here: this function is
   * pure (its callers' tests depend on that), and the resolution belongs with
   * the other host facts `lib/user-notify-runtime.ts` injects.
   */
  activateBundle?: string | undefined;
}): UserNotifyPlan {
  if (!opts.interactive) return { status: "skipped", reason: "非交互环境：不发通知" };
  if (!mayNotifyUser({ taskMode: opts.taskMode, stateVariant: opts.stateVariant })) {
    return {
      status: "skipped",
      reason: opts.stateVariant
        ? "这是编排里的子会话（问题由项目经理处理）"
        : `模式 ${opts.taskMode ?? "未知"} 不发通知`,
    };
  }
  if (!opts.notifierPath) return { status: "missing", hint: MISSING_NOTIFIER_HINT };
  const message = buildUserNotifyMessage({
    kind: opts.kind,
    repoName: opts.repoName,
    detail: opts.detail,
  });
  const title = sanitizeNotifyText(message.title, NOTIFY_TITLE_MAX) || "pi review-gate";
  const body = sanitizeNotifyText(message.body, NOTIFY_BODY_MAX);
  const key = notifyKey(title, body);
  const decision = decideNotify({ history: opts.history, key, now: opts.now });
  if (!decision.send) return { status: "throttled", reason: decision.reason };
  // ORDER — AFTER THE THROTTLE (quality round P2, 2026-09-18): answering
  // "is the user looking" costs three to five synchronous subprocesses, and a
  // banner the throttle would refuse anyway must not pay for them. A banner
  // SUPPRESSED here still records nothing, so it spends no throttle slot
  // either — the next real one goes out.
  if (opts.watching?.()) {
    return { status: "skipped", reason: "用户正在看这个 pane（终端在前台），不打扰" };
  }

  const address = opts.tmux?.();
  const focusCommand = address
    ? buildFocusCommand({ paneId: address.paneId, windowId: address.windowId })
    : undefined;
  return {
    status: "send",
    key,
    title,
    body,
    // The binary is spawned by its RESOLVED path: PATH at exit time is not the
    // PATH the session started with, and a crash is exactly when nobody is
    // around to notice that the banner silently failed to start.
    argv: [
      opts.notifierPath,
      ...buildNotifierArgv({
        title,
        body,
        focusCommand,
        activateBundle: opts.activateBundle,
        group: opts.group,
      }).slice(1),
    ],
  };
}
