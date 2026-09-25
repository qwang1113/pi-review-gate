/**
 * tmux COMMAND CONSTRUCTION — the gate never writes a tmux command by hand,
 * so this module writes all of them.
 *
 * WHY (user requirement, 2026-08-29: "if a tool can be provided, do not make
 * the session assemble it"). Every tmux failure measured in the hand-run
 * orchestration came from an improvised command, and the cost of an improvised
 * tmux command is not a wrong answer — it is the USER'S WORKING ENVIRONMENT.
 * A stray `kill-session` ends the window they are watching from. So the rules
 * live here, once, as argv arrays, and the agent only expresses intent.
 *
 * ARGV, NOT A SHELL STRING. Every builder returns an argument ARRAY for
 * execFile-style spawning: no shell parses it, so an id or a message body can
 * never become another command.
 *
 * ── THE TOPOLOGY (2026-09-25, user decision) ──
 *
 * A session's children no longer share the user's window. The opener keeps the
 * pane it already had — the one the human is watching — and every child it
 * opens lives as a WINDOW of the opener's own dedicated tmux session
 * (`rg-<repo>-<session id 尾 10 位>`, derived and owned by
 * lib/session-tmux-scope.ts — the TAIL, not the head: pi's ids are UUIDv7, so
 * their leading bits are a millisecond timestamp every session of the same
 * minute shares): one child per window, created lazily the first
 * time a child is needed, closed by `kill-window` when it is done.
 *
 * WHAT THAT REPLACED, and why nothing of it is left: the three-column layout
 * planner, the window-geometry probe and the equaliser that spread a column's
 * space. They existed to squeeze every child into the user's window without
 * nesting panes. They are DELETED, not kept "for the relay": with one child per
 * window there is no geometry to plan, and a second implementation of "where
 * does a session go" would be the drift this repository refuses (哲学三).
 * (They are not named here on purpose — the round's exit criterion is that the
 * identifiers are gone from the tree, and a mention kept "for history" is
 * exactly how a removed name comes back as a search hit somebody trusts.)
 *
 * THE ONE PATH THAT STILL SPLITS THE USER'S WINDOW is the RELAY
 * ({@link buildHandoffPaneArgv}): a successor orchestrator opens beside its
 * predecessor, where the human is already looking, so a handover does not move
 * the screen (user decision, 2026-09-25, explicitly NOT moved into the
 * dedicated session).
 *
 * ── THE SAFETY DOOR ──
 *
 * `new-session` / `new-window` / `kill-window` / `kill-session` are commands
 * the agent must never improvise (lib/orchestrator-guard.ts refuses them at
 * the bash layer) and the gate now genuinely needs. They are therefore not
 * "forbidden" but SCOPED: {@link assertSafeTmuxArgv} refuses any of them unless
 * the caller declares the session it owns AND the argv's own target names that
 * session (`<name>` or `<name>:@id`). `kill-server` is refused unconditionally
 * — no session name makes it safe.
 *
 * Pure module: builds and validates argv. It never spawns anything.
 */

/** A tmux pane id as tmux itself prints it: `%` followed by digits. */
const PANE_ID = /^%\d{1,10}$/;

/** A tmux window id as tmux itself prints it: `@` followed by digits. */
const WINDOW_ID = /^@\d{1,10}$/;

/**
 * The shape of a session the GATE created for itself.
 *
 * Deliberately narrower than "any string": everything here is emitted by
 * {@link ./session-tmux-scope.ts deriveSessionName}, and the character class is
 * what keeps a target from carrying tmux syntax of its own — no `:` (the
 * session/window separator an attacker would use to escape the scope), no `.`
 * (tmux rejects it in session names anyway), no whitespace, no leading dash.
 */
const OWN_SESSION_NAME = /^rg-[a-z0-9-]{1,48}$/;

/** Subcommands no session name can make safe: they destroy the whole server. */
export const NEVER_ALLOWED_TMUX_SUBCOMMANDS: readonly string[] = Object.freeze([
  "kill-server",
]);

/**
 * Subcommands that create or destroy surface, allowed ONLY against the
 * caller's own session ({@link SafeTmuxOptions.ownSession}).
 *
 * Aliases are listed beside their long form on purpose: the check runs on the
 * canonical name, so `killw` cannot slip past a rule written for `kill-window`.
 */
export const OWN_SESSION_TMUX_SUBCOMMANDS: readonly string[] = Object.freeze([
  "kill-session",
  "kill-window",
  "killw",
  "new",
  "new-session",
  "new-window",
  "neww",
]);

const SUBCOMMAND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  new: "new-session",
  neww: "new-window",
  killw: "kill-window",
});

export class UnsafeTmuxCommand extends Error {}

function canonicalSubcommand(sub: string): string {
  return SUBCOMMAND_ALIASES[sub] ?? sub;
}

/** True for a syntactically valid pane id. Fail-closed: anything else is refused. */
export function isPaneId(value: unknown): value is string {
  return typeof value === "string" && PANE_ID.test(value);
}

/** True for a syntactically valid window id. Same fail-closed rule. */
export function isWindowId(value: unknown): value is string {
  return typeof value === "string" && WINDOW_ID.test(value);
}

/** True for a session name the gate could have derived for itself. */
export function isOwnSessionName(value: unknown): value is string {
  return typeof value === "string" && OWN_SESSION_NAME.test(value);
}

function requirePane(value: string, what: string): string {
  if (!isPaneId(value)) {
    throw new UnsafeTmuxCommand(`${what} 不是合法的 tmux pane id（形如 %12）：${JSON.stringify(value)}`);
  }
  return value;
}

function requireOwnSession(value: string, what: string): string {
  if (!isOwnSessionName(value)) {
    throw new UnsafeTmuxCommand(
      `${what} 不是门禁自己派生的 session 名（形如 rg-<repo>-<id 尾>）：${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** The value of `-t` / `-s` in an argv, or undefined when the flag is absent. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at < 0 || at + 1 >= argv.length ? undefined : argv[at + 1];
}

export interface SafeTmuxOptions {
  /**
   * The tmux sessions this caller MAY ADDRESS — its own, plus any it holds
   * coordinates for.
   *
   * A list rather than one name because "mine" is not one thing (2026-09-25,
   * quality round P1): a RELAY SUCCESSOR keeps the previous seat's windows in
   * its registries (`callerIdentities()` counts the predecessor's judges as its
   * own), and those windows live in the PREDECESSOR'S session — a successor
   * that could only declare its own name could never close them. A builder
   * always passes exactly ONE name; the runner passes
   * `lib/session-tmux-scope.ts addressableSessions(...)`.
   */
  ownSessions?: readonly string[];
}

/**
 * Last line of defense before the gate spawns tmux: the argv must not name a
 * destructive subcommand, must not write a global option, and — for the four
 * session-scoped ones — may only address a session the caller declares.
 *
 * EVERY CALLER DECLARES, including the executor (2026-09-25).
 * {@link SafeTmuxOptions.ownSessions} is not optional in practice: a BUILDER
 * passes the single name it was given, and the runner that spawns tmux passes
 * every session it holds coordinates for
 * (`lib/session-tmux-scope.ts` `addressableSessions`), so "only sessions of
 * mine" holds on both sides of the seam. An argv naming one of the four WITHOUT
 * a declaration is refused even when its target looks like a gate session —
 * looking like ours is not being ours, and a refusal here costs one clear
 * message while accepting it costs somebody else's screen.
 *
 * `kill-server` is refused unconditionally: no declaration makes it safe.
 */
export function assertSafeTmuxArgv(
  argv: readonly string[],
  opts: SafeTmuxOptions = {},
): readonly string[] {
  const sub = String(argv[0] ?? "");
  if (!sub || sub.startsWith("-")) {
    // A LEADING GLOBAL FLAG is not the gate's business (2026-09-25): `-L sock
    // kill-session …` would otherwise put `-L` where the subcommand belongs and
    // slip the whole check — including `kill-server`. The gate never passes one
    // (its socket comes from the environment), so refusing is free.
    throw new UnsafeTmuxCommand(`tmux 命令必须以子命令开头，不接受全局 flag（实际：${JSON.stringify(sub)}）`);
  }
  const canonical = canonicalSubcommand(sub);
  if (NEVER_ALLOWED_TMUX_SUBCOMMANDS.includes(canonical)) {
    throw new UnsafeTmuxCommand(`tmux ${canonical} 会带走用户的整个 tmux server，任何情况都禁止`);
  }
  if (OWN_SESSION_TMUX_SUBCOMMANDS.includes(canonical)) {
    const allowed = (opts.ownSessions ?? []).filter((name) => isOwnSessionName(name));
    if (allowed.length === 0) {
      throw new UnsafeTmuxCommand(
        `tmux ${canonical} 只允许作用于本会话自己的专属 session（缺少或非法的 ownSessions 声明）：${JSON.stringify(argv)}`,
      );
    }
    // `new-session` NAMES its session with `-s`; everything else ADDRESSES one
    // with `-t`. `-t` on new-session means "group with", which is a different
    // session's business — refuse it rather than interpret it.
    const target = canonical === "new-session" ? flagValue(argv, "-s") : flagValue(argv, "-t");
    // THE TARGET MUST NAME ONE OF THE DECLARED SESSIONS — `<name>` or
    // `<name>:@window`, compared on the session half. A bare `@12` / `%3` never
    // matches (tmux would resolve it against whatever now holds that id), and
    // neither does another gate session's name.
    if (target === undefined || !allowed.includes(sessionPartOf(target))) {
      throw new UnsafeTmuxCommand(
        `tmux ${canonical} 的目标必须是本会话自己的 session 之一（${allowed.join("、")}）：${JSON.stringify(target)}`,
      );
    }
    if (canonical === "new-session" && argv.includes("-t")) {
      throw new UnsafeTmuxCommand("tmux new-session -t 是「加入别的 session 组」，门禁不做");
    }
  }
  // A global option write would change the user's own configuration.
  if ((canonical === "set" || canonical === "set-option" || canonical === "setw" || canonical === "set-window-option") && argv.includes("-g")) {
    throw new UnsafeTmuxCommand(`tmux ${canonical} -g 会改用户全局配置，禁止`);
  }
  return argv;
}

/**
 * The session a tmux target names: `<name>`, `<name>:@id` and `<name>:%id` all
 * name the same session, and that is the field the scope check compares.
 */
function sessionPartOf(target: string): string {
  const at = target.indexOf(":");
  return at < 0 ? target : target.slice(0, at);
}

/**
 * The child's environment, carried BY ITS OWN COMMAND instead of by tmux.
 *
 * WHY NOT `-e` (2026-09-25, measured in the t5 acceptance round):
 * `new-session -e K=V` writes K=V into the tmux SESSION's environment, and
 * every window opened in that session afterwards inherits it. The FIRST
 * child's identity — a worker's `RG_WORKER_ID`, its `RG_GATE_MODE=explore` —
 * was therefore stamped onto the whole session, and a judge opened later came
 * up carrying BOTH identities: it reported its state into the WORKER's channel
 * file, its own channel stayed empty, and the opener's boot verification timed
 * out — the round could never complete. (`new-window -e` does not write the
 * session environment, but it INHERITS whatever is already in it, so one leak
 * is forever.) The user's own window was never affected: a relay successor is
 * `split-window`, whose `-e` stays on the pane.
 *
 * `env K=V … <command>` puts the variables in the one place they belong — the
 * process of THIS window — and leaves tmux's own environment untouched.
 * `env(1)` execs the command, so the pane still runs the child itself.
 */
function envCommand(
  env: Readonly<Record<string, string>> | undefined,
  command: readonly string[] | undefined,
): string[] {
  const cmd = [...(command ?? ["pi"])];
  const pairs = env === undefined
    ? []
    : Object.keys(env).sort().map((key) => `${key}=${env[key]}`);
  // Sorted, so the argv stays testable.
  return pairs.length === 0 ? cmd : ["env", ...pairs, ...cmd];
}

/**
 * The session-level user option that says WHO created a session.
 *
 * It is the difference between "this name is mine because it looks like mine"
 * and "this name is mine because I wrote my id into it": before reusing or
 * killing a session, {@link buildReadSessionOwnerArgv} reads this and the
 * caller compares it with its own session id. A name collision (two sessions
 * whose ids share their first eight characters) or a leftover from a run that
 * crashed between `new-session` and the marker therefore cannot be mistaken
 * for our own.
 */
export const SESSION_OWNER_OPTION = "@rg_scope_owner";

/**
 * A WINDOW COORDINATE read back from disk — both halves or nothing.
 *
 * The pair (which window, in which session) is what a close is addressed by, and
 * the halves are meaningless apart: a window id without its session cannot be
 * scoped (`windowClosable` refuses it), and a session name without a window
 * names nothing to close. So a record where either half is missing or malformed
 * yields `undefined` — the registries then leave BOTH off, and the entry reads
 * as "this child predates the window topology" instead of half-recorded.
 *
 * It lives here because the SHAPES live here, and because two disk boundaries
 * (the orchestration sidecar and the worker registry) ask the same question:
 * one implementation, so their answers cannot drift apart (2026-09-25, quality
 * round P2 — the same fields had been shape-checked on one side only).
 */
export function parseWindowCoords(
  raw: { windowId?: unknown; tmuxSession?: unknown },
): { windowId: string; tmuxSession: string } | undefined {
  const windowId = isWindowId(raw?.windowId) ? raw.windowId : undefined;
  const tmuxSession = isOwnSessionName(raw?.tmuxSession) ? raw.tmuxSession : undefined;
  return windowId === undefined || tmuxSession === undefined ? undefined : { windowId, tmuxSession };
}

/** How many ids or windows tmux prints for one creation. */
export interface SessionWindowCoords {
  windowId: string;
  paneId: string;
}

export interface ScopeWindowOptions {
  /** The session this window belongs to — always the caller's OWN (see the header). */
  ownSession: string;
  /** Working directory for the new window (a repo root or a worktree). */
  cwd: string;
  /**
   * Environment injected into the window (orchestration id, gate mode…),
   * injected through the child's OWN command (`envCommand`) — never through
   * tmux, which would keep it for the whole session.
   */
  env?: Readonly<Record<string, string>>;
  /** The command the window runs. Defaults to an interactive `pi`. */
  command?: readonly string[];
  /**
   * The window's NAME, which is what `tmux ls` / `prefix w` shows. The gate
   * passes its own label (`reviewer@self`, `t1@pm`) so a human can tell the
   * windows apart without attaching to any of them (user decision, 2026-09-25).
   */
  windowName?: string;
}

/**
 * Open the FIRST window of the session — and the session with it.
 *
 * That is what makes the session LAZY: nothing is created until a child is
 * actually needed, and the child's own command is the session's first window,
 * so there is never a stray shell window to clean up afterwards.
 *
 * `-P -F '#{window_id} #{pane_id}'` makes tmux PRINT what it created, which is
 * how the registry learns its coordinates — guessing them (or listing and
 * diffing) is exactly the improvisation this module removes.
 */
export function buildNewSessionArgv(opts: ScopeWindowOptions): readonly string[] {
  const session = requireOwnSession(opts.ownSession, "ownSession");
  return assertSafeTmuxArgv([
    "new-session",
    "-d",
    "-s",
    session,
    "-c",
    opts.cwd,
    ...(opts.windowName === undefined ? [] : ["-n", opts.windowName]),
    "-P",
    "-F",
    "#{window_id} #{pane_id}",
    ...envCommand(opts.env, opts.command),
  ], { ownSessions: [session] });
}

/** Open ONE MORE window (`@id`) in the session the caller owns. */
export function buildNewWindowArgv(opts: ScopeWindowOptions): readonly string[] {
  const session = requireOwnSession(opts.ownSession, "ownSession");
  return assertSafeTmuxArgv([
    "new-window",
    "-t",
    session,
    "-c",
    opts.cwd,
    ...(opts.windowName === undefined ? [] : ["-n", opts.windowName]),
    "-P",
    "-F",
    "#{window_id} #{pane_id}",
    ...envCommand(opts.env, opts.command),
  ], { ownSessions: [session] });
}

/**
 * Every session on the server, by name — "who is there", read-only.
 *
 * IT IS ONE CALL ON PURPOSE. `has-session` answers "does MINE exist" and fails
 * identically for "no" and for "tmux is unreachable"; telling those apart would
 * mean parsing tmux's stderr. A server-wide list cannot fail for the boring
 * reason, so a failure is genuinely "I cannot see tmux" — and a caller that
 * cannot see tmux must not start creating sessions in what may be a new server.
 */
export function buildListSessionsArgv(): readonly string[] {
  return assertSafeTmuxArgv(["list-sessions", "-F", "#{session_name}"]);
}

/**
 * Write the ownership marker into a session the gate just created.
 *
 * Cosmetic-looking, load-bearing in fact: it is what makes "is this session
 * mine?" a READ rather than a guess, both when the session is reused
 * (`rg-<repo>-<id 尾>` colliding across two processes) and before the one
 * destructive act the gate performs on it.
 */
export function buildSetSessionOwnerArgv(ownSession: string, owner: string): readonly string[] {
  const session = requireOwnSession(ownSession, "ownSession");
  return assertSafeTmuxArgv(
    ["set", "-t", session, SESSION_OWNER_OPTION, owner],
    { ownSessions: [session] },
  );
}

/**
 * Read the marker back. An unset option prints NOTHING and exits 0 (measured:
 * tmux 3.7c), so an empty reading is "no owner recorded", never a failed call.
 */
export function buildReadSessionOwnerArgv(ownSession: string): readonly string[] {
  const session = requireOwnSession(ownSession, "ownSession");
  return assertSafeTmuxArgv(["show-options", "-t", session, "-qv", SESSION_OWNER_OPTION], { ownSessions: [session] });
}

/**
 * ── THE SESSION'S OWN NAME ON SCREEN (2026-09-25, t2) ──
 *
 * Three builders, and they are the only writes the gate makes to the surface
 * the HUMAN looks at rather than the gate's own: the window TITLE (what
 * `prefix w` and `tmux ls` show) and a window-level user option the status bar
 * renders. Both are written when a session names itself
 * (lib/session-name-tools.ts) and taken back when it releases the name.
 *
 * THE OPTION IS NOT COSMETIC AND NOT A TITLE. `pane_title`/`window_name` are
 * namespaces other programs write (pi overwrites the pane title at boot, which
 * is why the gate's labels moved to `@rg_label`); a tmux USER OPTION is a
 * namespace nothing else touches, so `#{@rg_session_name}` in the user's status
 * line renders the name the session chose, minutes after it chose it.
 * `-g` never appears: the user's own configuration is theirs, and the option
 * lives on ONE window.
 */
export const SESSION_NAME_OPTION = "@rg_session_name";

/**
 * A name that is safe to put into a tmux format and into an argv:
 * printable, no control characters, no `#{` (which tmux would EXPAND when the
 * option is rendered), and short. The product rules (kebab-case, 2–32 chars)
 * live in lib/session-registry.ts — this is only the transport floor.
 */
function requireDisplayName(value: string, what: string): string {
  const raw = String(value ?? "");
  if (raw.length === 0 || raw.length > 64 || /[\u0000-\u001f\u007f]/.test(raw) || raw.includes("#{")) {
    throw new UnsafeTmuxCommand(`${what} 不能作为 tmux 展示名：${JSON.stringify(raw)}`);
  }
  return raw;
}

/** Rename the window a pane lives in — the session's own window. */
export function buildRenameWindowArgv(target: string, name: string): readonly string[] {
  return assertSafeTmuxArgv(["rename-window", "-t", requirePane(target, "target"), requireDisplayName(name, "window name")]);
}

/** Write the window-level option the status bar reads (`set -w`, never `-g`). */
export function buildSetSessionNameOptionArgv(target: string, name: string): readonly string[] {
  return assertSafeTmuxArgv([
    "set", "-w", "-t", requirePane(target, "target"), SESSION_NAME_OPTION, requireDisplayName(name, "option value"),
  ]);
}

/**
 * Take it back: `-u` removes the window-level setting, so the status line falls
 * through to whatever the user configured for an unnamed window.
 */
export function buildUnsetSessionNameOptionArgv(target: string): readonly string[] {
  return assertSafeTmuxArgv(["set", "-wu", "-t", requirePane(target, "target"), SESSION_NAME_OPTION]);
}

/**
 * Read MY OWN coordinates: which tmux session, which window, and what that
 * window is currently CALLED (the last one so a release can put the title
 * back).
 *
 * Read, never derived: the pane id is tmux's own (`$TMUX_PANE`), and the
 * session/window it sits in are what tmux says right now — the opener's
 * dedicated session for a child, the user's own window for a loop session, a
 * relay successor's split. Nothing here guesses the topology.
 */
export function buildReadOwnCoordsArgv(pane: string): readonly string[] {
  return assertSafeTmuxArgv([
    "display-message", "-p", "-t", requirePane(pane, "pane"),
    `#{session_name}|#{window_id}|#{${SESSION_NAME_OPTION}}|#{window_name}`,
  ]);
}

/**
 * Parse what {@link buildReadOwnCoordsArgv} printed.
 *
 * The separator is `|` and the window NAME (the only free-form field, and the
 * only one that could contain it) is taken as the REST of the line, so a window
 * whose name carries a `|` still parses.
 */
export function parseOwnCoords(stdout: string):
  | { session: string; window: string; windowName: string; option: string }
  | undefined {
  const line = String(stdout ?? "").split(/\r?\n/)[0] ?? "";
  const parts = line.split("|");
  if (parts.length < 4) return undefined;
  const session = parts[0].trim();
  const window = parts[1].trim();
  const option = parts[2].trim();
  // The window NAME is the rest of the line: it is the only free-form field and
  // the only one that could itself contain the separator.
  const windowName = parts.slice(3).join("|").trim();
  if (session.length === 0 || !isWindowId(window)) return undefined;
  return { session, window, windowName, option };
}

/**
 * Close ONE window — the object a child session is, after 2026-09-25.
 *
 * The target is written `<session>:<@id>` rather than a bare `@id`, and that is
 * the point: a stale or wrong window id can then only ever reach a window of
 * the gate's OWN session, never one of the user's
 * ({@link assertSafeTmuxArgv} refuses the bare form).
 */
export function buildKillWindowArgv(ownSession: string, windowId: string): readonly string[] {
  const session = requireOwnSession(ownSession, "ownSession");
  if (!isWindowId(windowId)) {
    throw new UnsafeTmuxCommand(`不是合法的 tmux window id（形如 @12）：${JSON.stringify(windowId)}`);
  }
  return assertSafeTmuxArgv(["kill-window", "-t", `${session}:${windowId}`], { ownSessions: [session] });
}

/**
 * Close the session itself, with every window still in it — what `declare_done`
 * does to the one session this process created.
 *
 * There is no "close a session by id": tmux sessions are named, and the name is
 * derived from THIS session's own identity (lib/session-tmux-scope.ts), read
 * back from its sidecar. A caller cannot pass one in, which is what keeps this
 * from becoming "kill whatever session you are told about".
 */
export function buildKillSessionArgv(ownSession: string): readonly string[] {
  const session = requireOwnSession(ownSession, "ownSession");
  return assertSafeTmuxArgv(["kill-session", "-t", session], { ownSessions: [session] });
}

/**
 * Open the SUCCESSOR orchestrator beside the current one.
 *
 * THE ONE PLACE THE GATE SPLITS THE USER'S WINDOW (user decision, 2026-09-25).
 * A relay is the human's own seat changing hands, not another child session:
 * the successor lands where they are already looking, and when the predecessor
 * pane closes tmux expands the successor into its place.
 */
export function buildHandoffPaneArgv(opts: {
  orchestratorPane: string;
  cwd: string;
  env?: Readonly<Record<string, string>>;
  command?: readonly string[];
}): readonly string[] {
  const self = requirePane(opts.orchestratorPane, "orchestratorPane");
  return assertSafeTmuxArgv([
    "split-window",
    "-h",
    "-t",
    self,
    "-c",
    opts.cwd,
    "-P",
    "-F",
    "#{pane_id}",
    ...envCommand(opts.env, opts.command),
  ]);
}

/**
 * THERE IS NO `send-keys` BUILDER, AND THAT IS THE POINT (2026-08-30).
 *
 * Delivering text and pressing keys used to live here. Both are gone, with
 * every caller, because typing at a TUI is not an API: the measured results
 * were a truncated task document (F7), a message that was never submitted
 * (F8), text landing in the composer or the steering queue depending on
 * timing (R-20), and a confirmation dialog that ignored `Enter` and `C-m` and
 * accepted only `KPEnter` (R-8).
 *
 * Both jobs now go through the channel instead:
 *
 *  - a MESSAGE is written to the child's channel and the child's own gate
 *    injects it with `pi.sendUserMessage` (lib/orchestrator-child-channel.ts);
 *  - an ANSWER to a dialog is written to the same channel and resolves the
 *    `ui.select` the child's gate is already awaiting — no keystroke exists
 *    anywhere in that path.
 */

/** Close ONE pane — the relay path only, where the pane IS the user's own spot. */
export function buildKillPaneArgv(pane: string): readonly string[] {
  return assertSafeTmuxArgv(["kill-pane", "-t", requirePane(pane, "pane")]);
}

/**
 * List every pane on the tmux SERVER, which is the new liveness question.
 *
 * IT USED TO BE "the panes of the opener's window" (`list-panes -t %<own>`), and
 * that reading silently became a lie the moment children moved into their own
 * windows: a live child is not in the opener's window any more, so every one of
 * them would have been reported DEAD — the failure direction that sends an
 * opener off to re-do work that is running.
 *
 * `-a` cannot fail for the boring reason either. Asking about one window or
 * session fails (`can't find window`) both when that window is GONE — the
 * ordinary "it finished" — and when tmux cannot be read; distinguishing the two
 * would mean parsing tmux's stderr. A server-wide list fails only when the
 * server itself is unreachable, which is genuinely "unknown".
 */
export function buildListServerPanesArgv(): readonly string[] {
  return assertSafeTmuxArgv(["list-panes", "-a", "-F", "#{pane_id}"]);
}

/**
 * ── PANE DECORATION (2026-08-30) ──
 *
 * Four builders, all cosmetic, and they are the ONLY writes this module makes
 * that are not about creating, closing or listing a session's surface. They
 * exist because the user asked for children to be tellable apart on screen, and
 * because the gate — not the orchestrator — has to be the one that runs them
 * (philosophy one: the project manager never assembles a tmux command).
 *
 * In the window topology each of these targets the CHILD'S OWN window, so the
 * label bar a child turns on is the child's own — it used to be a window option
 * shared with the user's editor and shells.
 *
 * WHY THIS IS NOT THE FORBIDDEN KIND OF CONFIG WRITE. `assertSafeTmuxArgv`
 * refuses any option write carrying `-g`, because that is the user's GLOBAL
 * configuration and no gate has business touching it. These are window- and
 * pane-scoped: `select-pane -P` affects exactly one pane the registry created,
 * `set -p -t <pane> @rg_label` writes a USER OPTION on that same pane, and
 * `setw -t <pane>` affects the window that pane lives in.
 */

/**
 * The pane user option the gate's label lives in.
 *
 * It is spelled HERE, beside the argv that writes it, and imported by
 * lib/orchestrator-pane-decor.ts for the border format that reads it — the
 * writer and the reader must never drift into two spellings, and this module
 * imports nothing, so it is the end of the dependency chain the other way
 * round (decor → registry → tmux).
 */
export const PANE_LABEL_OPTION = "@rg_label";

/** Set one pane's border colour (`-P` is the pane style). */
export function buildPaneStyleArgv(pane: string, style: string): readonly string[] {
  return assertSafeTmuxArgv(["select-pane", "-t", requirePane(pane, "pane"), "-P", style]);
}

/**
 * Write one pane's LABEL — the string `pane-border-format` then renders.
 *
 * A PANE USER OPTION (`@rg_label`), not `select-pane -T` (2026-09-22). The
 * title was never ours: pi writes its own into `pane_title` at boot and on
 * every extension rebind, so a label written at spawn was gone within seconds.
 * The judge and orchestration panes survived that only because their health
 * probes repaint on a timer; a worker pane, which has no probe, simply stayed
 * blank. `@rg_label` is a namespace nothing else writes, so the label written
 * once at spawn is still there minutes later — and the border format falls
 * back to `#{pane_title}` for panes the gate never opened
 * (lib/orchestrator-pane-decor.ts `PANE_BORDER_FORMAT`).
 */
export function buildPaneLabelArgv(pane: string, label: string): readonly string[] {
  return assertSafeTmuxArgv(["set", "-p", "-t", requirePane(pane, "pane"), PANE_LABEL_OPTION, label]);
}

/**
 * Turn the label bar on for the WINDOW a pane belongs to.
 *
 * Two commands rather than one because tmux takes one option per call; the
 * caller runs them in order and treats any failure as cosmetic.
 *
 * THERE IS NO UNDO (2026-09-17, user decision). `buildHidePaneLabelsArgv`
 * existed and is deleted: toggling `pane-border-status` RESIZES EVERY PANE IN
 * THE WINDOW (measured on a scratch tmux: SIGWINCH, rows 84 ↔ 83, in both
 * directions; re-setting the same value triggers nothing), so releasing the
 * bar re-laid out every application in the user's window — their editor,
 * their shells, a manager's pi — once per orchestration cycle, and the next
 * spawn put it straight back. Under the window topology that whole trade is
 * moot for the user's window: a child's bar is turned on in the CHILD'S window,
 * which exists for as long as the child does.
 */
export function buildShowPaneLabelsArgv(
  pane: string,
  status: string,
  format: string,
): readonly (readonly string[])[] {

  const target = requirePane(pane, "pane");
  return [
    assertSafeTmuxArgv(["setw", "-t", target, "pane-border-status", status]),
    assertSafeTmuxArgv(["setw", "-t", target, "pane-border-format", format]),
  ];
}

/** Session names, one per line, trimmed. Blank lines are not names. */
export function parseSessionNames(stdout: string): string[] {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Read back what tmux printed for `-P -F '#{pane_id}'` (or list-panes). */
export function parsePaneIds(stdout: string): string[] {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => isPaneId(line));
}

/** The single pane id a `-P` spawn printed, or undefined when tmux said nothing. */
export function parseSpawnedPaneId(stdout: string): string | undefined {
  return parsePaneIds(stdout)[0];
}

/**
 * The window AND pane a creation printed (`-P -F '#{window_id} #{pane_id}'`).
 *
 * Both are needed and neither is guessed: the window id is what closes the
 * child later, the pane id is what the liveness probe and the border target.
 * A line that does not carry both is not a coordinate — the caller rolls back
 * instead of addressing something it did not measure.
 */
export function parseSpawnedWindow(stdout: string): SessionWindowCoords | undefined {
  for (const raw of String(stdout ?? "").split(/\r?\n/)) {
    const [windowId, paneId] = raw.trim().split(/\s+/);
    if (isWindowId(windowId) && isPaneId(paneId)) return { windowId, paneId };
  }
  return undefined;
}
