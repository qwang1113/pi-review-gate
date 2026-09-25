/**
 * `name_session` — ONE tool, and the lifecycle that keeps the name true.
 *
 * ── WHY A SESSION NEEDS A NAME (2026-09-25, user decision) ──
 *
 * Everything else in this gate refers to a session by an opaque id, which is
 * right for the gate and useless for a human: the tmux status line showed the
 * working directory, so two sessions in one repo looked identical, and no
 * process on the machine could say which sessions were running. A NAME fixes
 * both — it is what the window title and the status line render
 * (`@rg_session_name`, lib/orchestrator-tmux.ts) and what another session
 * addresses (`@名字`, t3).
 *
 * ── THE ONE TOOL ──
 *
 * `name_session({name})` claims a name for THIS session, renames its window and
 * writes the window option the status line reads. A second call with a
 * DIFFERENT name is a rename: the old name is given back before the new one is
 * claimed, so a name never has two holders. There is no `release_session_name`
 * and no `list_sessions` here on purpose: a release is `declare_done`'s job (and
 * the process exiting), and the listing belongs to whoever needs to CHOOSE a
 * name to address (t3's send), which reads the registry directly.
 *
 * ── WHAT IT REFUSES, AND WHY THAT IS THE FEATURE ──
 *
 * Names are globally unique, and uniqueness is not enforced by winning: a name
 * a live session holds is REFUSED, with the occupant named (repo, state, when it
 * registered). The gate never appends a suffix, never overwrites the holder and
 * never evicts one — a session that suddenly finds itself renamed would have no
 * way to know it, which is exactly the kind of silent reassignment this project
 * refuses. A name whose holder is PROVABLY gone is reclaimed, which is a
 * different act and is decided in lib/session-registry.ts.
 *
 * ── THE LIFECYCLE, WHICH IS THE OTHER HALF ──
 *
 * A registration nobody renews is a lie within minutes, and a name nobody gives
 * back is stuck forever. So the runtime here owns all four moments:
 *
 *   - `onSessionStart` — adopt the entry this session id already owns (a
 *     restart keeps its name) and SWEEP the orphans other sessions left behind;
 *   - `tick` — renew the heartbeat (the extension arms this on a timer, and the
 *     timer is what makes a blocked session still look alive);
 *   - `release` — `declare_done` and process exit both give the name back and
 *     put the window back the way it was;
 *   - `nameSession` — the tool.
 *
 * Pure-ish: tmux, the registry, the clock and the pid check all arrive through
 * {@link SessionNamingDeps}, so the whole protocol runs in a test with fakes.
 */

import { Type } from "typebox";

import type { ToolHost, ToolReply } from "./tool-host.ts";
import {
  buildReadOwnCoordsArgv,
  buildRenameWindowArgv,
  buildSetSessionNameOptionArgv,
  buildUnsetSessionNameOptionArgv,
  parseOwnCoords,
} from "./orchestrator-tmux.ts";
import {
  claimName,
  classifyEntry,
  findEntryBySessionId,
  listEntries,
  nodeRegistryIO,
  pidAlive,
  releaseName,
  renewName,
  sessionEntryPath,
  sessionNameProblem,
  sessionRegistryRoot,
  SESSION_HEARTBEAT_MS,
  type RegistryIO,
  type RegistryTmuxResult,
  type SessionRegistryEntry,
} from "./session-registry.ts";
import { sweepOrphans, type SweepReport } from "./session-orphan-sweep.ts";

/** Everything the naming runtime needs from the session it runs in. */
export interface SessionNamingDeps {
  /** Registry root; defaults to `~/.pi/agent/rg-sessions`. */
  root?: string;
  /** File IO; defaults to the real one. */
  io?: RegistryIO;
  /** Runs one tmux argv through the extension's own declared runner. The second
   * argument declares gate sessions the caller has just PROVEN are gate
   * sessions (a dead session's own), which the runner's own list cannot know. */
  runTmux(argv: readonly string[], ownSessions?: readonly string[]): RegistryTmuxResult;
  /** THIS session's pi session id. */
  sessionId(): string | undefined;
  /** THIS session's own tmux pane (`$TMUX_PANE`), when it runs inside tmux. */
  ownPane(): string | undefined;
  /**
   * The tmux SERVER this process talks to (`<socket>,<server pid>` from
   * `$TMUX`), recorded with the coordinates so a stale registration's pane id
   * is never read against a DIFFERENT server (t4 review P1). Undefined when
   * outside tmux or unreadable — both leave the pane comparison as it was.
   */
  tmuxServer?(): string | undefined;
  /** Primary repo root (what a human reads as "which project"). */
  repoRoot(): string;
  /** Working directory. */
  cwd(): string;
  /** loop | orchestrator | child | judge | worker | normal | explore. */
  mode(): string;
  /** working | idle. Read live: the heartbeat reports it. */
  state(): string;
  /** The dedicated tmux session this session created (t1's sidecar record), when it has one. */
  scopeSession(): string | undefined;
  now?: () => number;
  alive?: (pid: number) => boolean;
  log?(message: string): void;
  /** The name was taken away from us (an error worth surfacing). */
  onLost?(reason: string): void;
}

/** What this session's naming state is, for the extension to report. */
export interface SessionNaming {
  readonly heartbeatMs: number;
  register(host: ToolHost): void;
  onSessionStart(): { adopted?: string; sweep: SweepReport };
  tick(): void;
  release(): { released: boolean; name?: string; error?: string };
  currentName(): string | undefined;
}

/** What a claim left in memory: the name, and how to give the window back. */
interface HeldName {
  name: string;
  registeredAt: string;
  /** The window title as it was BEFORE the rename, when this process saw it. */
  originalWindowName?: string;
  /** The pane the display was written to, so a release can undo exactly that. */
  pane?: string;
}

export function createSessionNaming(deps: SessionNamingDeps): SessionNaming {
  const root = deps.root ?? sessionRegistryRoot();
  const io = deps.io ?? nodeRegistryIO(root);
  const now = deps.now ?? (() => Date.now());
  const alive = deps.alive ?? pidAlive;
  const registry = {
    root,
    io,
    runTmux: (argv: readonly string[], ownSessions?: readonly string[]) => deps.runTmux(argv, ownSessions),
    alive,
    now,
    ...(deps.tmuxServer === undefined ? {} : { currentServer: deps.tmuxServer }),
  };
  let held: HeldName | undefined;

  /** My own tmux coordinates, read from tmux — never derived from the topology. */
  function readOwn(): { session: string; window: string; windowName: string; option: string } | undefined {
    const pane = deps.ownPane();
    if (pane === undefined || pane.length === 0) return undefined;
    try {
      const result = deps.runTmux(buildReadOwnCoordsArgv(pane));
      if (!result.ok) return undefined;
      return parseOwnCoords(result.stdout);
    } catch {
      return undefined;
    }
  }

  /** The entry as it must be stored right now. */
  function entryFor(name: string, registeredAt: string): SessionRegistryEntry {
    const coords = readOwn();
    const pane = deps.ownPane();
    const scopeSession = deps.scopeSession();
    // THE SERVER RIDES WITH THE COORDINATES: a pane id is only an id within one
    // tmux server, so a stamp without this half would be read against whatever
    // server happens to be running later (t4 review P1).
    const server = deps.tmuxServer?.();
    return {
      schema: 1,
      name,
      sessionId: deps.sessionId() ?? "",
      pid: process.pid,
      repo: deps.repoRoot(),
      cwd: deps.cwd(),
      mode: deps.mode(),
      state: deps.state(),
      ...(coords === undefined || pane === undefined
        ? {}
        : { tmux: { session: coords.session, window: coords.window, pane, ...(server === undefined ? {} : { server }) } }),
      ...(scopeSession === undefined ? {} : { scopeSession }),
      registeredAt,
      heartbeatAt: new Date(now()).toISOString(),
    };
  }

  /** Write the display half: the window title and the option the status line reads. */
  function writeDisplay(name: string, pane: string): string[] {
    const notes: string[] = [];
    try {
      const renamed = deps.runTmux(buildRenameWindowArgv(pane, name));
      if (!renamed.ok) notes.push(`window title 没写成：${renamed.stderr || "tmux 拒绝"}`);
      const option = deps.runTmux(buildSetSessionNameOptionArgv(pane, name));
      if (!option.ok) notes.push(`@rg_session_name 没写成：${option.stderr || "tmux 拒绝"}`);
    } catch (error) {
      notes.push(`展示写入失败：${(error as Error).message}`);
    }
    return notes;
  }

  /** Take both halves back, and only where they still say OUR name. */
  function clearDisplay(name: string, pane: string, originalWindowName?: string): string[] {
    const notes: string[] = [];
    const current = readOwn();
    try {
      if (current?.option === name) {
        const unset = deps.runTmux(buildUnsetSessionNameOptionArgv(pane));
        if (!unset.ok) notes.push(`@rg_session_name 没清掉：${unset.stderr || "tmux 拒绝"}`);
      }
      // The title is put back only when it is still OURS: a window somebody
      // renamed in the meantime is not this session's to rename again.
      if (current?.windowName === name && originalWindowName !== undefined && originalWindowName.length > 0) {
        const restored = deps.runTmux(buildRenameWindowArgv(pane, originalWindowName));
        if (!restored.ok) notes.push(`window title 没还原：${restored.stderr || "tmux 拒绝"}`);
      }
    } catch (error) {
      notes.push(`展示还原失败：${(error as Error).message}`);
    }
    return notes;
  }

  function ok(text: string, details: Record<string, unknown> = {}): ToolReply {
    return { content: [{ type: "text", text }], details };
  }

  function fail(text: string): ToolReply {
    return { content: [{ type: "text", text }], details: { ok: false }, isError: true };
  }

  /** Claim (or rename to) one name, and report exactly what happened. */
  function nameSession(rawName: unknown): ToolReply {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const problem = sessionNameProblem(name);
    if (problem !== undefined) return fail(`review-gate: 名字不合法 —— ${problem}`);
    const sessionId = deps.sessionId()?.trim();
    if (sessionId === undefined || sessionId.length === 0) {
      return fail("review-gate: 本会话没有 session id（pi 没给出），无法登记名字。");
    }
    const notes: string[] = [];
    // RENAMING FREES THE OLD NAME FIRST (user decision, 2026-09-25): a session
    // must never hold two names, and a name must never have two holders. If the
    // old one cannot be given back, the rename is REFUSED instead of leaving two
    // registrations for one session behind (the leftover would look "live" to
    // the sweep forever, because its pid is this very process).
    if (held !== undefined && held.name !== name) {
      const oldName = held.name;
      if (!releaseInternal().ok) {
        return fail(`review-gate: 改名失败 —— 旧名字 ${oldName} 腾不出来（见上面的日志），本会话仍叫 ${oldName}`);
      }
      notes.push(`旧名字 ${oldName} 已腾出`);
    }
    const registeredAt = held !== undefined && held.name === name ? held.registeredAt : new Date(now()).toISOString();
    const entry = entryFor(name, registeredAt);
    const claimed = claimName(registry, entry);
    if (!claimed.ok) {
      const tail = notes.length === 0 ? "" : `\n（${notes.join("；")}）`;
      return fail(`review-gate: ${claimed.error}${tail}`);
    }
    const pane = deps.ownPane();
    const before = readOwn();
    const displayNotes = pane === undefined || pane.length === 0
      ? ["不在 tmux 里（没有 $TMUX_PANE）—— 名字已登记，但没有窗口可以显示它"]
      : writeDisplay(name, pane);
    held = {
      name,
      registeredAt,
      ...(before?.windowName === undefined || before.windowName === name ? {} : { originalWindowName: before.windowName }),
      ...(pane === undefined ? {} : { pane }),
    };
    const where = entry.tmux === undefined ? "不在 tmux 里" : `${entry.tmux.session}:${entry.tmux.window} (${entry.tmux.pane})`;
    return ok(
      `review-gate: ${claimed.note}。\n` +
      `名字：${name}\n` +
      `登记：${sessionEntryPath(root, name)}\n` +
      `位置：${where}\n` +
      `展示：window title + @rg_session_name 已写入（状态栏显示「目录名 · 会话名」）\n` +
      `心跳：每 ${Math.round(SESSION_HEARTBEAT_MS / 1000)} 秒续期一次；declare_done 或进程退出时自动腾出。` +
      (notes.length ? `\n${notes.join("；")}` : "") +
      (displayNotes.length ? `\n注意：${displayNotes.join("；")}` : ""),
      { ok: true, name, outcome: claimed.outcome, entry },
    );
  }

  /**
   * The shared release path: registry first, then the window.
   *
   * ALL OR NOTHING, and that is why the order is this one (quality round P2,
   * 2026-09-25): the registration is given back FIRST, and only when that
   * succeeded is the window put back. A registry delete that failed leaves the
   * entry ours — clearing the title/option anyway would leave the registry
   * saying "this session holds X" while the screen says nothing of the sort,
   * and (worse) `held` would have been dropped, so nothing would renew or
   * retry: the entry would sit there looking LIVE (its pid is this very
   * process) until the process ended. So a failure keeps the name, keeps the
   * display, and reports.
   */
  function releaseInternal(): { ok: boolean; error?: string } {
    const current = held;
    if (current === undefined) return { ok: true };
    const sessionId = deps.sessionId()?.trim() ?? "";
    const released = releaseName(registry, current.name, sessionId);
    if (!released.ok) {
      const error = released.error ?? `名字 ${current.name} 释放失败`;
      deps.log?.(error);
      return { ok: false, error };
    }
    const pane = current.pane;
    const notes = pane === undefined ? [] : clearDisplay(current.name, pane, current.originalWindowName);
    for (const note of notes) deps.log?.(note);
    held = undefined;
    return { ok: true };
  }

  return {
    heartbeatMs: SESSION_HEARTBEAT_MS,

    register(host: ToolHost): void {
      host.registerTool({
        name: "name_session",
        label: "Name This Session",
        description:
          "Give THIS session a globally unique name. The name is registered in the machine-wide session " +
          "registry (~/.pi/agent/rg-sessions/<name>.json), written to the tmux window title, and written to " +
          "the window option `@rg_session_name` the tmux status line renders as「目录名 · 会话名」— it is also " +
          "how another session addresses this one (`@名字`). kebab-case, 2–32 characters. A name a LIVE " +
          "session holds is REFUSED and the refusal names the occupant (repo, state, when it registered): pick " +
          "another one. A name whose holder is provably gone is reclaimed automatically. Calling it again with " +
          "a different name renames: the old name is given back first. The name is released on " +
          "`declare_done` and when the process exits.",
        parameters: Type.Object({
          name: Type.String({ description: "kebab-case, 2–32 chars, e.g. `t2-registry`. Globally unique." }),
        }),
        execute: (_id, params) => Promise.resolve(nameSession(params.name)),
      });
    },

    onSessionStart(): { adopted?: string; sweep: SweepReport } {
      const sessionId = deps.sessionId()?.trim();
      // ADOPT BEFORE SWEEPING would be wrong: the sweep's job is other people's
      // leftovers, and it is told which entry is ours so it never touches it.
      const sweep = sweepOrphans(registry, sessionId === undefined ? {} : { sessionId });
      for (const note of sweep.notes) deps.log?.(`孤儿回收：${note}`);
      if (sessionId === undefined || sessionId.length === 0) return { sweep };
      const mine = findEntryBySessionId(registry, sessionId);
      if (mine === undefined) return { sweep };
      // A RESTART KEEPS ITS NAME. The window title was already set by the
      // process that died, so there is no "original" left to remember: a later
      // release clears the option (the status line falls back to the directory)
      // and leaves a title that still says the name it still has.
      held = { name: mine.name, registeredAt: mine.registeredAt, ...(mine.tmux === undefined ? {} : { pane: mine.tmux.pane }) };
      return { adopted: mine.name, sweep };
    },

    tick(): void {
      const current = held;
      if (current === undefined) return;
      const renewed = renewName(registry, entryFor(current.name, current.registeredAt));
      if (renewed.ok) return;
      if (renewed.lost === true) {
        held = undefined;
        deps.onLost?.(renewed.error);
        return;
      }
      deps.log?.(renewed.error);
    },

    release(): { released: boolean; name?: string; error?: string } {
      const name = held?.name;
      const result = releaseInternal();
      return {
        released: result.ok,
        ...(name === undefined ? {} : { name }),
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    },

    currentName(): string | undefined {
      return held?.name;
    },
  };
}

/**
 * The named sessions a caller may address: registered AND still alive, plus the
 * ones whose liveness could not be read (reported, never silently dropped).
 *
 * It lives here rather than in t3's sender because "which of these entries is
 * still a session" is this module's question — the sender picks a name, it does
 * not get to invent a second answer to liveness.
 */
export function liveSessionNames(
  deps: Pick<SessionNamingDeps, "runTmux" | "now" | "alive" | "root" | "io">,
): { live: SessionRegistryEntry[]; unknown: SessionRegistryEntry[] } {
  const root = deps.root ?? sessionRegistryRoot();
  const registry = {
    root,
    io: deps.io ?? nodeRegistryIO(root),
    runTmux: (argv: readonly string[]) => deps.runTmux(argv),
    alive: deps.alive ?? pidAlive,
    now: deps.now ?? (() => Date.now()),
  };
  const live: SessionRegistryEntry[] = [];
  const unknown: SessionRegistryEntry[] = [];
  for (const entry of listEntries(registry).entries) {
    const occupancy = classifyEntry(registry, entry);
    if (occupancy === "live") live.push(entry);
    else if (occupancy === "unknown") unknown.push(entry);
  }
  return { live, unknown };
}
