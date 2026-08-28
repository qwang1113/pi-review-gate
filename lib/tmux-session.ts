/**
 * tmux judge-child substrate — PANE mode with session fallback.
 *
 * WHY PANES, NOT SESSIONS (user requirement, 2026-08-27). A detached tmux
 * session is invisible until you `tmux attach`; a pane in the main session's
 * own window is ALWAYS visible — the main pi keeps the left column (~2/3
 * width), judge children share the right column, split evenly. The human sees
 * every judge working, can interrupt any of them, and never has to attach.
 *
 * LAYOUT. The main session lives in tmux (detected via $TMUX): the first
 * judge carves the right column (-h 35%), each later judge stacks on the
 * anchor (-v 50% of the previous pane — so three judges fill 50/25/25 of
 * the column; the header's "split evenly" claim is retired, round-7 P2).
 * When the host has no $TMUX, the module falls back to detached sessions so
 * the gate still works headless.
 *
 * THE MEASURED PITFALLS THIS FILE EXISTS TO PREVENT (all reproduced during
 * round 1 of the tmux migration):
 *  - a pane/session is a DISPLAY, never the record of what ran in it: a judge
 *    that dies at startup takes its pane with it, so its outcome must be read
 *    from the session's own artifacts (lib/judge-session.ts), not from tmux;
 *  - '.' in a session name makes every -t target fail (tmux parses it as the
 *    pane separator) — an unkillable orphan that listGateSessions keeps
 *    reporting; '.' and ':' are therefore forbidden in names;
 *  - multi-line input into pi's TUI arrives as one message per line, so
 *    sendMessage enforces a single line and rejects anything else;
 *  - `send-keys -l text Enter` sends the WORD "Enter" literally (everything
 *    after -l is literal), so Enter is always a separate send-keys call.
 *
 * FAIL-SOFT. Every function returns undefined/false instead of throwing —
 * with ONE deliberate exception: sendMessage rejects multi-line input with a
 * throw, because silently shredding a task into per-line messages is worse
 * than failing loudly (round-2 P2). A host without tmux degrades to "cannot
 * spawn a judge" rather than crashing the extension. Structured data
 * (verdicts, findings, inbox questions) rides FILES inside the repo, never
 * the pane — a pane is a screen, not a channel.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";

/** Prefix of every gate-owned session / pane title, so orphans are identifiable. */
export const TMUX_SESSION_PREFIX = "rg-";

/** Max tmux session/pane title length (tmux caps at 200; keep well under). */
export const MAX_SESSION_NAME = 60;

/** Is the CURRENT process running inside tmux (i.e. may we split panes)? */
export function hostInTmux(): boolean {
  return typeof process.env.TMUX === "string" && process.env.TMUX.length > 0;
}

/** Is tmux installed and usable on this host? */
export function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize an arbitrary label into a valid, identifiable gate name.
 *
 * Order is load-bearing: forbid '.' and ':' (tmux target separators), then
 * replace everything else unsafe, then TRIM and SLICE — trimming before
 * slicing could reintroduce a trailing '-', so the slice happens first and
 * the trim last.
 */
export function safeSessionName(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._:-]/g, "-")
    .replace(/[.:]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, MAX_SESSION_NAME)
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "rg-child";
}

// ---------------------------------------------------------------------------
// PANE mode (primary)
// ---------------------------------------------------------------------------

export interface SpawnPaneOptions {
  /**
   * Gate-owned label shown to the human via the pane title (sanitized
   * internally, "rg-…" prefix added). NOT used for targeting — panes are
   * targeted by their tmux pane id.
   */
  title: string;
  /** Working directory of the pane. */
  cwd: string;
  /** Shell command the pane runs (a `pi …` invocation in practice). */
  command: string;
  /**
   * Environment pairs delivered to the pane (tmux -e KEY=VAL). THE ONLY
   * channel for dynamic values into the child's launcher (round-2 P1: the
   * launcher reads every value from RG_* env vars, and nothing delivered
   * them — a child silently launched without system prompt / model / cwd).
   */
  env?: Record<string, string>;
  /**
   * DEPRECATED (round-7 P2): layout is decided INTERNALLY — a window with no
   * live anchor carves the right column (35% width), later judges stack on
   * the anchor. Kept for callers that still pass it (review_spawn), where it
   * is now IGNORED; remove once every caller stops.
   */
  widthPercent?: number;
  /**
   * tmux target for the split (session/window, or a pane id).
   *
   * WITHOUT an explicit target tmux resolves the split against the SERVER'S
   * ACTIVE pane — whichever window the USER currently focuses (round-17,
   * confirmed with data; the older "it follows TMUX_PANE" reading is
   * REFUTED). The module therefore always names a target itself: the
   * remembered first judge pane of our window, else ownPaneId().
   * Later judges stack on that remembered pane automatically; pass a target
   * explicitly only
   * to redirect a split elsewhere (tests use an isolated session).
   */
  target?: string;
}

export interface SpawnPaneResult {
  ok: boolean;
  /** tmux pane id (e.g. "%103") when ok — this is the targeting handle. */
  paneId?: string;
  /** Human-readable failure reason when `ok` is false. */
  error?: string;
}

function tmuxSync(args: string[], timeoutMs = 15_000): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("tmux", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * The pane this extension process runs IN — the deterministic anchor for
 * untargeted split-window / window_id queries (round-17 P1: judge panes
 * intermittently landed in the WRONG window because untargeted tmux calls
 * fall back to the server's ACTIVE pane, which other windows' activity
 * steals).
 *
 * ROOT CAUSE, confirmed with data (2026-08-28): the server's active pane is
 * whatever window the USER currently focuses, so every untargeted tmux call
 * followed the user's focus — a judge spawned while the user looked at the
 * main-session window (@39) landed THERE; the ones that landed correctly were
 * spawned while the user happened to focus this session's window. That is the
 * whole "intermittency". Hence: every tmux call passes an explicit -t and
 * "current pane" semantics are banned.
 *
 * Measured in this host (2026-08-28): process.env.TMUX_PANE IS set in the
 * extension process, so path 1 hits; path 2 is the fallback for a missing or
 * stale value (pi respawned into another pane, env inherited from a dead one).
 *
 * Resolution order:
 *  1. process.env.TMUX_PANE — when set and still alive, it is exactly the
 *     pane pi runs in;
 *  2. process-ancestry match — `tmux list-panes -a -F '#{pane_pid}
 *     #{pane_id}'` builds a pid→pane map, then walk process.pid up via ppid
 *     (bounded) until a pid owned by a pane is hit (works when TMUX_PANE is
 *     missing or stale);
 *  3. undefined — callers keep the legacy behavior.
 * Never throws.
 */
export function ownPaneId(): string | undefined {
  const env = process.env.TMUX_PANE?.trim();
  if (env && paneAlive(env)) return env;
  try {
    const out = execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_pid} #{pane_id}"], { encoding: "utf8", timeout: 10_000 });
    const byPid = new Map<string, string>();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\S+)$/);
      if (m) byPid.set(m[1]!, m[2]!);
    }
    let pid = String(process.pid);
    for (let depth = 0; depth < 32; depth++) {
      const pane = byPid.get(pid);
      if (pane) return pane;
      const ppid = execFileSync("ps", ["-o", "ppid=", "-p", pid], { encoding: "utf8", timeout: 5_000 }).trim();
      if (!ppid || ppid === pid) break;
      pid = ppid;
    }
  } catch { /* fall through to legacy */ }
  return undefined;
}

/**
 * The window THIS session's pane lives in (ownPaneId anchored) — the key
 * for per-window judge-anchor bookkeeping. Round-17 P1: never a bare
 * display-message (that reads the server's active pane); always -t.
 */
export function ownWindowId(): string | undefined {
  const pane = ownPaneId();
  if (!pane) return undefined;
  const res = tmuxSync(["display-message", "-p", "-t", pane, "#{window_id}"], 10_000);
  return res.status === 0 && res.stdout.trim() !== "" ? res.stdout.trim() : undefined;
}

/**
 * `name(@id)` of the window a pane lives in — the human-facing origin label
 * for cross-session attention (round-17 P0: a notification with no session
 * identity told the user nothing about WHERE to go). Always -t, and only ever
 * for a real pane id: an arbitrary string here would resolve to SOME session
 * (measured round-2: `paneWindowLabel("unrelated")` labelled an unrelated
 * one), so the notification would point the user at the wrong window.
 */
export function paneWindowLabel(pane: string | undefined): string | undefined {
  if (!isPaneId(pane)) return undefined;
  const res = tmuxSync(["display-message", "-p", "-t", pane, "#{window_name}(#{window_id})"], 5_000);
  const out = res.status === 0 ? res.stdout.trim() : "";
  return out === "" ? undefined : out;
}

/*
 * (round-17) `signalChannel` was removed with the attention rewrite: the only
 * caller published a BARE broadcast, which is exactly what caused the self-wake
 * loop. Signalling now belongs to lib/attention.ts, where the bell always
 * carries a payload and passes the sideEffectsEnabled() gate.
 */

/**
 * Create a judge pane in the main session's current window: right column for
 * the first child, vertical split for subsequent ones. Returns the pane id —
 * the ONLY targeting handle for every later operation.
 */
export function spawnJudgePane(opts: SpawnPaneOptions): SpawnPaneResult {
  const title = `${TMUX_SESSION_PREFIX}${safeSessionName(opts.title)}`;
  // `target` may name a session, a window or a pane — but an EMPTY one is not
  // "no preference", it is "the user's active pane" as far as tmux is
  // concerned, and the split would land in whatever window they are watching.
  if (opts.target !== undefined && opts.target.trim() === "") {
    return { ok: false, error: "spawnJudgePane: empty target — refusing to split the user's active pane" };
  }

  try {
    // NO RETENTION OPTION IS SET HERE — deliberately (2026-08-28).
    //
    // This used to set `remain-on-exit on`, and because that is a WINDOW
    // option it applied to EVERY pane of the window the judge landed in —
    // including the MAIN session's own pane. The measured consequence: the
    // user's own pane stopped closing on exit ("Pane is dead (status 0)")
    // and every finished judge left a dead pane stacking up in the column.
    //
    // A judge's exit is now observed from the SESSION's own artifacts
    // (`pid` / `exit-code` / `stderr.log` written by its launcher, read via
    // lib/judge-session.ts), so the pane no longer has to survive its child
    // to stay diagnosable. The pane is a display shell: it appears with the
    // judge and disappears with it.

    // Column ownership (round-2 Nit → round-7 P2): ONE decision, made here.
    // A window with no live anchor CARVES the right column (-h 35%); later
    // judges STACK on the anchor (-v 50%, -t anchor). Callers never pass a
    // target for layout purposes, so the module is the single owner and the
    // extension cannot disagree with it.
    // Layout is ONE decision, made here (round-7 P2):
    //  - an explicit `target` means "stack vertically on THAT pane" (the
    //    tests' isolation idiom — a judge below the previous one, same
    //    column);
    //  - no target: a window with no live anchor CARVES the right column
    //    (-h 35%); later judges STACK on the anchor (-v 50%, -t anchor).
    // The module is the single layout owner either way.
    const args = ["split-window", "-d"]; // -d: keep focus on the main pane
    if (opts.target) args.push("-v", "-p", "50", "-t", opts.target);
    else {
      const anchor = firstJudgePaneOfWindow();
      if (anchor) args.push("-v", "-p", "50", "-t", anchor);
      else {
        // Round-17 P1: an untargeted split falls back to the server's ACTIVE
        // pane — other windows' activity steals it and the judge lands in the
        // WRONG window. Anchor the split on OUR OWN pane (deterministic).
        const own = ownPaneId();
        if (own) args.push("-h", "-p", "35", "-t", own);
        else args.push("-h", "-p", "35");
      }
    }
    if (opts.env) for (const [k, v] of Object.entries(opts.env)) args.push("-e", `${k}=${v}`);
    args.push("-P", "-F", "#{pane_id}", "-c", opts.cwd, opts.command);
    const res = tmuxSync(args);
    if (res.status !== 0) {
      return { ok: false, error: res.stderr.trim() || `tmux split-window exited ${res.status}` };
    }
    const paneId = res.stdout.trim().split("\n").pop() ?? "";
    if (!paneId.startsWith("%")) {
      return { ok: false, error: `split-window returned no pane id (got "${res.stdout.trim()}")` };
    }
    rememberJudgePane(paneId);
    // Human-readable title; ignored on failure (pi may overwrite it anyway).
    tmuxSync(["select-pane", "-t", paneId, "-T", title], 10_000);
    return { ok: true, paneId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Per-window column ownership: the first judge pane of the current window
 * becomes the anchor that later judges stack on. In-memory only (the gate
 * rebuilds it per session); entries are dropped when their pane dies.
 */
const judgePaneByWindow = new Map<string, string>();

function windowIdOfCurrentPane(): string | undefined {
  // Round-17 P1: never a bare display-message (server-active dependent);
  // always anchored on our own pane.
  return ownWindowId();
}

function firstJudgePaneOfWindow(): string | undefined {
  const win = windowIdOfCurrentPane();
  if (!win) return undefined;
  const pane = judgePaneByWindow.get(win);
  // The anchor is remembered only while its pane EXISTS. Panes now disappear
  // with their judge, so a vanished anchor simply means the column is free to
  // be carved again by the next spawn.
  if (pane) {
    const exists = tmuxSync(["display-message", "-p", "-t", pane, "#{pane_id}"], 10_000);
    if (exists.status === 0 && exists.stdout.trim() === pane) return pane;
    judgePaneByWindow.delete(win);
  }
  return undefined;
}

function rememberJudgePane(paneId: string): void {
  // Key by the window the pane ACTUALLY landed in, not the caller's current
  // window (an explicit-target spawn may target another session; round-3 P2).
  // Round-7 P2: the FIRST judge is the anchor and stays it — a later judge
  // must never overwrite it, or closing the first while others live would
  // silently hand the column back to the main pane.
  const res = tmuxSync(["display-message", "-p", "-t", paneId, "#{window_id}"], 10_000);
  if (res.status === 0 && res.stdout.trim() !== "") {
    const win = res.stdout.trim();
    if (!judgePaneByWindow.has(win)) judgePaneByWindow.set(win, paneId);
  }
}

/**
 * A tmux pane id is `%<digits>` — and NOTHING else may reach a `-t` flag.
 *
 * THE INCIDENT THIS PREVENTS (2026-08-28, measured on a throwaway server).
 * `tmux send-keys -t "" -l hello` does NOT fail: an empty target means "no
 * target given", so tmux delivers to the server's ACTIVE pane — whichever
 * window the USER happens to be looking at. A judge child ran exactly that
 * (its shell variable had come out empty) and typed `hello` into the user's
 * unrelated session, which then submitted it as a real message.
 *
 * An empty or malformed pane id must therefore never be handed to tmux and
 * quietly turned into "the user's current pane". Writes fail loudly, reads
 * report a pane that does not exist — both are safe; delivering it somewhere
 * else is not.
 */
export function isPaneId(paneId: unknown): paneId is string {
  return typeof paneId === "string" && /^%\d+$/.test(paneId);
}

/**
 * Does a pane with this id still EXIST?
 *
 * PANE EXISTENCE IS THE WHOLE TEST (2026-08-28). The judge panes carry no
 * retention option any more, so a pane whose process exits is torn down by
 * tmux immediately: `display-message -t <gone pane>` fails, and that failure
 * IS the liveness answer. The old discriminator (a retained pane that had to
 * be told apart from a live one) no longer has anything to discriminate.
 *
 * This is a DISPLAY-level probe only. Whether the judge SESSION finished —
 * and with which exit code — is answered by the session's own artifacts
 * (`pid` / `exit-code` under its workDir, see lib/judge-session.ts), never by
 * the shell that happens to display it.
 */
export function paneAlive(paneId: string): boolean {
  if (!isPaneId(paneId)) return false; // never let a bad id resolve to the user's pane
  const res = tmuxSync(["display-message", "-p", "-t", paneId, "#{pane_id}"], 10_000);
  return res.status === 0 && res.stdout.trim() === paneId;
}


/**
 * Is ANY of the given judge children alive? Pure over an injected liveness
 * predicate (defaults to paneAlive) so the stall-breaker's motion check is
 * testable without a tmux server. The fresh-age bound lives at the caller
 * (spawnedAt vs STALL_MOTION_MAX_AGE_SEC) — a hung-but-alive pane must not
 * count as motion forever (round-16 P2).
 */
export function anyPaneAlive(
  children: ReadonlyArray<{ paneId: string }>,
  isAlive: (paneId: string) => boolean = paneAlive,
): boolean {
  return children.some((c) => isAlive(c.paneId));
}

/**
 * Send ONE message to a pane: a single line of text plus Enter.
 *
 * SINGLE-LINE BY DESIGN (measured pitfall): pi's TUI treats an embedded
 * newline in pasted input as a SUBMIT, so a multi-line paste arrives as one
 * message per line — the child sees a shredded task. Multi-line content
 * therefore rides FILES (written by the gate, referenced by a one-line
 * instruction like "read /path/task.md and execute it"). Anything containing
 * a newline is REJECTED here, loudly, rather than silently shredded.
 *
 * Enter is a SEPARATE send-keys call: after `-l` every following argument is
 * literal, so the word "Enter" would be typed as text (measured).
 */
export function sendMessage(paneId: string, text: string): boolean {
  // A WRITE to a bad target is the dangerous case: tmux would deliver it to
  // whatever pane the user is looking at (measured). Fail loudly instead.
  if (!isPaneId(paneId)) {
    throw new Error(`sendMessage: refusing to send to an invalid pane id ${JSON.stringify(paneId)} — tmux would deliver it to the user's active pane`);
  }
  if (text.includes("\n") || text.includes("\r")) {
    throw new Error("sendMessage: multi-line text would be shredded by pi's TUI — write it to a file and reference the file in a single line instead");
  }
  const textRes = tmuxSync(["send-keys", "-t", paneId, "-l", text], 10_000);
  if (textRes.status !== 0) return false;
  const enterRes = tmuxSync(["send-keys", "-t", paneId, "Enter"], 10_000);
  return enterRes.status === 0;
}

/** Send raw key names (e.g. "C-c") — for interrupting a stuck child. */
export function sendRawKeys(paneId: string, keys: string): boolean {
  if (!isPaneId(paneId)) {
    throw new Error(`sendRawKeys: refusing to send to an invalid pane id ${JSON.stringify(paneId)} — tmux would deliver it to the user's active pane`);
  }
  const res = tmuxSync(["send-keys", "-t", paneId, keys], 10_000);
  return res.status === 0;
}

export interface CaptureOptions {
  /** How many scrollback lines to include before the visible screen. */
  history?: number;
}

/** Read the pane's current visible text (plus optional scrollback). */
export function capturePane(paneId: string, opts: CaptureOptions = {}): string | undefined {
  if (!isPaneId(paneId)) return undefined; // reading the user's pane is not "capture"
  const args = ["capture-pane", "-p", "-t", paneId];
  if (opts.history && opts.history > 0) args.push("-S", `-${opts.history}`);
  const res = tmuxSync(args, 15_000);
  return res.status === 0 ? res.stdout : undefined;
}

/**
 * The pane's current working directory, reported by tmux itself.
 * #{pane_current_path} resolves symlinks (/var → /private/var on macOS), so
 * comparisons must canonicalize on both sides.
 */
export function paneCurrentPath(paneId: string): string | undefined {
  if (!isPaneId(paneId)) return undefined;
  const res = tmuxSync(["display-message", "-p", "-t", paneId, "#{pane_current_path}"], 10_000);
  if (res.status !== 0) return undefined;
  const out = res.stdout.trim();
  return out.length > 0 ? out : undefined;
}

/** Kill a judge pane. Best-effort; false when it was already gone. */
export function killPane(paneId: string): boolean {
  // A kill aimed at "" would close the pane the USER is looking at.
  if (!isPaneId(paneId)) return false;
  const res = tmuxSync(["kill-pane", "-t", paneId], 10_000);
  return res.status === 0;
}

// ---------------------------------------------------------------------------
// Session mode (fallback when the host is not inside tmux)
// ---------------------------------------------------------------------------

export interface SpawnSessionOptions {
  /** tmux session name (sanitized internally). */
  name: string;
  /** Working directory of the pane. */
  cwd: string;
  /** Shell command the pane runs. */
  command: string;
  /**
   * Environment pairs delivered to the pane (tmux -e KEY=VAL). Same
   * contract as SpawnPaneOptions.env — the fallback path must deliver the
   * launcher's RG_* values too (round-2 P1: without -e the launcher ran
   * with everything unset, failing open as a default pi).
   */
  env?: Record<string, string>;
}

export interface SpawnSessionResult {
  ok: boolean;
  /** The SANITIZED session name actually used (callers need it for targeting). */
  name?: string;
  /** Human-readable failure reason when `ok` is false. */
  error?: string;
}

/** Create a detached session running `command` with cwd `cwd`. */
export function spawnSession(opts: SpawnSessionOptions): SpawnSessionResult {
  const name = safeSessionName(opts.name);
  try {
    // No retention option (2026-08-28): the session's pane closes with its
    // child, exactly like the pane path. What the child DID is recorded by
    // the child itself (pid / exit-code / stderr.log + its session jsonl),
    // so nothing has to be kept alive for the main session to read it.
    const args = ["new-session", "-d", "-s", name, "-c", opts.cwd];
    if (opts.env) for (const [k, v] of Object.entries(opts.env)) args.push("-e", `${k}=${v}`);
    args.push(opts.command);

    const res = tmuxSync(args, 20_000);
    if (res.status !== 0) {
      return { ok: false, error: res.stderr.trim() || `tmux new-session exited ${res.status}` };
    }
    return { ok: true, name };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Does a gate-owned session with this name still exist? Same rule as
 * paneAlive: with no retention option a session whose child exits is torn
 * down by tmux, so resolving the target IS the liveness answer. The judge
 * session's own outcome (finished? which exit code?) comes from its
 * artifacts, not from this probe.
 */
export function sessionAlive(name: string): boolean {
  const res = tmuxSync(["has-session", "-t", safeSessionName(name)], 10_000);
  return res.status === 0;
}


/** Kill a gate-owned session. Best-effort; false when it was already gone. */
export function killSession(name: string): boolean {
  const res = tmuxSync(["kill-session", "-t", safeSessionName(name)], 10_000);
  return res.status === 0;
}

// ---------------------------------------------------------------------------
// Signals + inventory (shared)
// ---------------------------------------------------------------------------

/**
 * Block until the child signals completion via `tmux wait-for -S <channel>`.
 * Returns true when the signal arrived, false on timeout — on timeout the
 * caller asks the child's SESSION whether it finished (`exit-code` / `pid`
 * via lib/judge-session.ts), never the pane: the signal is an accelerator,
 * and a child that ended without signalling took its pane with it.
 * Synchronous on purpose for tool handlers; extension background listeners
 * should use waitForSignalAsync instead (round-1 F12: spawnSync would block
 * the whole extension process for the full timeout).
 */
export function waitForSignal(channel: string, timeoutMs: number): boolean {
  const res = tmuxSync(["wait-for", channel], timeoutMs);
  return res.status === 0;
}

export interface WaitHandle {
  /** Resolves true on signal, false on timeout / spawn failure. */
  promise: Promise<boolean>;
  /** Kill the underlying tmux wait-for process (cleanup / session shutdown). */
  cancel: () => void;
}

/**
 * Async wait on a done/inbox channel: spawns `tmux wait-for <channel>` and
 * resolves on exit. The returned handle lets the extension cancel the
 * listener on session_shutdown — without a handle, an unsignalled channel
 * leaks one tmux wait-for process per spawn forever (round-2 P2).
 */
export function waitForSignalAsync(channel: string, timeoutMs = 0): WaitHandle {
  let cancelled = false;
  let child: ReturnType<typeof spawn> | undefined;
  const promise = new Promise<boolean>((resolve) => {
    child = spawn("tmux", ["wait-for", channel], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    // P0 (round-17): a listener must NEVER keep the event loop alive —
    // headless / test / CI processes would hang forever on an unsignalled
    // channel (measured: precommit workers stuck in uv__io_poll with 30
    // leaked `tmux wait-for` children). unref lets the
    // process exit; the child dies with the tmux server or on cancel.
    child.unref();
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          cancelled = true;
          child?.kill();
          resolve(false);
        }, timeoutMs)
      : undefined;
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve(false);
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      resolve(code === 0 && !cancelled);
    });
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      child?.kill();
    },
  };
}

/**
 * Names of every gate-owned live session (prefix match), for cleanup sweeps
 * and the declare_done residual check. Session mode only; pane mode keeps its
 * inventory in gate state (pane ids carry no prefix once pi rewrites titles).
 */
export function listGateSessions(): string[] {
  const res = tmuxSync(["ls", "-F", "#{session_name}"], 10_000);
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(TMUX_SESSION_PREFIX));
}
