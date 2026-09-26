/**
 * tmux argv for the gate's OWN SESSION — creating it, opening and closing its
 * windows, marking it as ours, cleaning its environment, and the name a
 * session shows on screen.
 *
 * Split out of lib/orchestrator-tmux.ts (2026-09-26) by responsibility: that
 * module keeps the SAFETY DOOR ({@link assertSafeTmuxArgv}, the id shapes, the
 * runner contract, the child-environment strip) and the pane-level builders;
 * this one holds everything addressed to a session the gate derived for
 * itself (lib/session-tmux-scope.ts). Every builder here still ends in
 * `assertSafeTmuxArgv` — the door is not moved, only the rooms behind it.
 *
 * Pure module: builds and validates argv. It never spawns anything.
 */

import {
  assertSafeTmuxArgv,
  envCommand,
  isPaneId,
  isWindowId,
  requireOwnSession,
  requirePane,
  UnsafeTmuxCommand,
} from "./orchestrator-tmux.ts";

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
 * The two LIVENESS facts written beside the marker: the owner process's pid and
 * the tmux pane it runs in. The marker says WHO built a session; these say
 * whether that builder can still be alive — which is what lets a later session
 * reclaim the dedicated session of one that crashed without ever being named
 * (lib/session-orphan-sweep.ts). A session without them is never reclaimed.
 */
export const SESSION_OWNER_PID_OPTION = "@rg_scope_owner_pid";
export const SESSION_OWNER_PANE_OPTION = "@rg_scope_owner_pane";

/**
 * A session somebody ELSE is meant to inherit when its owner is gone — an
 * orchestration child's window (`orchestrator_attach` adopts it) or a seat that
 * was handed off (the successor adopts the judges). Its owner being dead is then
 * the expected state, not a crash, so a pinned session is never swept; it is
 * closed by whoever inherits it, exactly as before the sweep existed.
 */
export const SESSION_PINNED_OPTION = "@rg_scope_pinned";

/** The session user options the gate writes about a session's owner. */
export type SessionOwnerOption =
  | typeof SESSION_OWNER_OPTION
  | typeof SESSION_OWNER_PID_OPTION
  | typeof SESSION_OWNER_PANE_OPTION
  | typeof SESSION_PINNED_OPTION;

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
 * Read a SESSION's own environment — one `KEY=VALUE` per line.
 *
 * The reading exists for one job: finding the gate's own variables that an
 * earlier build left in a session's environment, so they can be removed before
 * they are inherited by a child of another kind (`healSessionEnv`,
 * lib/session-tmux-scope.ts).
 */
export function buildListSessionEnvArgv(ownSession: string): readonly string[] {
  const session = requireOwnSession(ownSession, "ownSession");
  return assertSafeTmuxArgv(["show-environment", "-t", session], { ownSessions: [session] });
}

/**
 * Remove ONE variable from a session's environment.
 *
 * The name is checked for the two things an ARGV cannot survive, not for
 * looking like an identifier (quality round P2, then acceptance round P2,
 * 2026-09-25): there is no shell here, so an odd-but-real name is perfectly
 * removable — including one with a SPACE in it, which tmux accepts and an argv
 * element carries verbatim. Refusing such a name would BRICK the session:
 * `healSessionEnv` selects by the `RG_` prefix, so a key it cannot remove is a
 * key that stays inherited, and (because the heal fails closed) every later
 * spawn of that session would be refused with no way out. What is still refused
 * is what would change the meaning of the argv: a leading `-` (tmux would read
 * it as a flag) and a name carrying `=` (which is really two arguments).
 */
export function buildUnsetSessionEnvArgv(ownSession: string, key: string): readonly string[] {
  const session = requireOwnSession(ownSession, "ownSession");
  const name = String(key ?? "");
  if (name.length === 0 || name.startsWith("-") || name.includes("=")) {
    throw new UnsafeTmuxCommand(`环境变量名不能作为 argv 传递：${JSON.stringify(key)}`);
  }
  return assertSafeTmuxArgv(["set-environment", "-t", session, "-u", name], { ownSessions: [session] });
}

/**
 * Write the ownership marker into a session the gate just created.
 *
 * Cosmetic-looking, load-bearing in fact: it is what makes "is this session
 * mine?" a READ rather than a guess, both when the session is reused
 * (`rg-<repo>-<id 尾>` colliding across two processes) and before the one
 * destructive act the gate performs on it.
 *
 * `option` defaults to the marker (`value` = the owner's session id); the other
 * {@link SessionOwnerOption}s carry the owner's pid / pane or the pin reason.
 */
export function buildSetSessionOwnerArgv(
  ownSession: string,
  value: string,
  option: SessionOwnerOption = SESSION_OWNER_OPTION,
): readonly string[] {
  const session = requireOwnSession(ownSession, "ownSession");
  return assertSafeTmuxArgv(
    ["set", "-t", session, option, value],
    { ownSessions: [session] },
  );
}

/**
 * Read the marker (or another {@link SessionOwnerOption}) back. An unset option prints NOTHING and exits 0 (measured:
 * tmux 3.7c), so an empty reading is "no owner recorded", never a failed call.
 */
export function buildReadSessionOwnerArgv(
  ownSession: string,
  option: SessionOwnerOption = SESSION_OWNER_OPTION,
): readonly string[] {
  const session = requireOwnSession(ownSession, "ownSession");
  return assertSafeTmuxArgv(["show-options", "-t", session, "-qv", option], { ownSessions: [session] });
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

/** Session names, one per line, trimmed. Blank lines are not names. */
export function parseSessionNames(stdout: string): string[] {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
