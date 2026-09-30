/**
 * THE TMUX HOST — the gate's sessions as windows of the opener's own tmux
 * session, its banners as `terminal-notifier` (lib/gate-host.ts `GateHost`).
 *
 * This is where every tmux act the gate performs lives, byte for byte what it
 * was before the host factory existed (2026-09-30): the argv builders are
 * lib/orchestrator-tmux.ts and lib/tmux-session-argv.ts, the dedicated session
 * is lib/session-tmux-scope.ts, the banner is lib/gate-host-tmux-notify.ts and
 * the orphan reclaim is lib/gate-host-tmux-sweep.ts. Everything that decides
 * WHEN to do these things is host-neutral and lives elsewhere.
 *
 * THE RUNNER DECLARES ITS SESSIONS (2026-09-25): every tmux call carries the
 * sessions this process may address (its own, its lineage's judges, its
 * children, its workers — {@link createDeclaringTmuxRunner}), so `new-session`
 * / `new-window` / `kill-window` / `kill-session` are refused unless their
 * target is one of them. The raw {@link runTmux} is exported for that wrapper
 * and its own tests only.
 */

import { execFileSync } from "node:child_process";

import {
  assertSafeTmuxArgv,
  buildHandoffPaneArgv,
  buildKillPaneArgv,
  buildListServerPanesArgv,
  buildPaneLabelArgv,
  buildPaneStyleArgv,
  buildShowPaneLabelsArgv,
  parsePaneIds,
  parseSpawnedPaneId,
  tmuxServerFrom,
  type SafeTmuxOptions,
  type TmuxRunner,
  type TmuxRunResult,
} from "./orchestrator-tmux.ts";
import {
  buildKillWindowArgv,
  buildReadOwnCoordsArgv,
  buildRenameWindowArgv,
  buildSetSessionNameOptionArgv,
  buildUnsetSessionNameOptionArgv,
  parseOwnCoords,
} from "./tmux-session-argv.ts";
import {
  addressableSessions,
  closeOwnSession,
  createOwnershipProbe,
  openScopeWindow,
  pinOwnSession,
  type TmuxScope,
} from "./session-tmux-scope.ts";
import { paneStyleFor, paneTitleFor, PANE_BORDER_FORMAT, PANE_BORDER_STATUS } from "./orchestrator-pane-decor.ts";
import { buildSetPaneOptionArgv, buildUnsetPaneOptionArgv } from "./tmux-pane-state.ts";
import { reclaimTmuxScope, sweepUnnamedTmuxScopes } from "./gate-host-tmux-sweep.ts";
import { createTmuxNotifier } from "./gate-host-tmux-notify.ts";
import type { SessionPaneDecor } from "./session-factory.ts";
import type { GateHost, HostNotifier, HostOpened, HostResult } from "./gate-host.ts";

/**
 * Run one tmux argv — WITHOUT a shell (execFileSync with an argv array), and
 * re-validated through {@link assertSafeTmuxArgv} first: the gate's own
 * execution path is bound by the same forbidden list the bash guard enforces
 * against the agent, so "the gate is exempt from the guard" can never mean
 * "the gate may do the forbidden thing".
 */
export function runTmux(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  guard: SafeTmuxOptions = {},
): TmuxRunResult {
  try {
    assertSafeTmuxArgv(argv, guard);
  } catch (error) {
    return { ok: false, stdout: "", stderr: (error as Error).message };
  }
  try {
    const stdout = execFileSync("tmux", [...argv], {
      encoding: "utf8",
      env,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: String(stdout ?? ""), stderr: "" };
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    return { ok: false, stdout: "", stderr: String(err.stderr ?? err.message ?? "tmux failed") };
  }
}

/**
 * THE RUNNER THIS PROCESS USES — the raw one plus the declaration of every
 * session it may address. `held` names the sessions some registry records
 * (judges, children, workers); each is admitted only after its
 * `@rg_scope_owner` marker proves a gate session minted it
 * (`createOwnershipProbe`, which rides the RAW runner so it cannot recurse into
 * the declaration it is building). The third argument declares sessions the
 * CALLER has just proven are gate sessions (a dead session's own).
 */
export function createDeclaringTmuxRunner(opts: {
  scope: TmuxScope;
  held(): Iterable<string | undefined>;
  env?: () => NodeJS.ProcessEnv;
}): TmuxRunner {
  const probe = createOwnershipProbe(opts.scope, (argv) => runTmux(argv));
  return (argv, env, extraSessions) =>
    runTmux(argv, env ?? opts.env?.() ?? process.env, {
      ownSessions: addressableSessions(opts.scope, opts.held(), probe, extraSessions),
    });
}

/**
 * Which panes exist right now — ON THE WHOLE SERVER. `undefined` means the
 * list itself is unreadable — missing information, never evidence of death.
 *
 * NOT SCOPED TO THE OPENER'S WINDOW (2026-09-25): children are windows of other
 * tmux sessions, so a window-scoped reading would report every live child as
 * DEAD — and an opener told its judge is gone goes and re-does the round.
 */
export function listServerPanes(run: TmuxRunner): string[] | undefined {
  try {
    const result = run(buildListServerPanesArgv());
    if (!result.ok) return undefined;
    return parsePaneIds(result.stdout);
  } catch {
    return undefined;
  }
}

/**
 * Colour, title, AND the window option that renders the border line.
 *
 * THE THIRD STEP IS THE FIX FOR C1. Turning `pane-border-status` on used to be
 * the orchestration spawn's private business, so a judge pane opened by an
 * ordinary loop session had a colour nobody could see. It is a window-level
 * option shared by every pane in the window, which is exactly why it must be
 * set by whoever opens a decorated pane rather than by one privileged caller.
 *
 * Failure is ALWAYS cosmetic: a session that works is worth more than a
 * coloured border, so this returns a warning and never an error.
 */
export function decorateSessionPane(
  run: TmuxRunner,
  paneId: string,
  decor: SessionPaneDecor,
): string | undefined {
  const failures: string[] = [];
  const attempt = (argv: readonly string[]): void => {
    try {
      const result = run(argv);
      if (!result.ok) failures.push(result.stderr || argv.join(" "));
    } catch (error) {
      failures.push((error as Error).message);
    }
  };
  attempt(buildPaneStyleArgv(paneId, paneStyleFor(decor.colorSeed)));
  attempt(buildPaneLabelArgv(paneId, paneTitleFor({
    label: decor.label,
    state: decor.state,
    ...(decor.stateForSeconds === undefined ? {} : { stateForSeconds: decor.stateForSeconds }),
  })));
  for (const argv of buildShowPaneLabelsArgv(paneId, PANE_BORDER_STATUS, PANE_BORDER_FORMAT)) {
    attempt(argv);
  }
  // The WORDING matters as much as the fact: a bare tmux stderr in a receipt
  // reads like the session failed, and every caller pastes this straight in.
  return failures.length === 0
    ? undefined
    : `pane 装饰失败（仅显示降级）：${failures[0]}`;
}

/**
 * Write one pane's title, once, with NO memory and NO throttle — the only
 * place a title reaches tmux. Failures are swallowed: this is a cosmetic layer,
 * and a pane that works is worth more than a border that is right.
 */
export function paintPaneTitle(run: TmuxRunner, paneId: string, title: string): void {
  try {
    run(buildPaneLabelArgv(paneId, title));
  } catch {
    /* cosmetic only — never allowed to affect supervision */
  }
}

/**
 * Close ONE WINDOW the gate itself opened (谁创建谁回收). The target is built
 * as `<ownSession>:<@id>` from the coordinates the registry recorded at spawn,
 * so a stale id can only ever reach a window of the gate's own session
 * (lib/tmux-session-argv.ts `buildKillWindowArgv`).
 */
export function closeSessionWindow(
  run: TmuxRunner,
  coords: { ownSession: string; windowId: string },
): { ok: true } | { ok: false; error: string } {
  try {
    const result = run(buildKillWindowArgv(coords.ownSession, coords.windowId));
    if (!result.ok) {
      return { ok: false, error: result.stderr || "tmux kill-window 失败" };
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  return { ok: true };
}

/**
 * Close ONE PANE — the RELAY path. The predecessor's own pane is the rectangle
 * in the USER'S window where the retiring session sits, and the successor was
 * split off it; a `kill-window` there would take the successor with it.
 */
export function closeSessionPane(
  run: TmuxRunner,
  paneId: string,
): { ok: true } | { ok: false; error: string } {
  try {
    const result = run(buildKillPaneArgv(paneId));
    if (!result.ok) {
      return { ok: false, error: result.stderr || "tmux kill-pane 失败" };
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  return { ok: true };
}

/**
 * Split the opener's OWN pane for a relay successor — the one path that still
 * touches the user's window (user decision, 2026-09-25). No window id comes
 * back: this child lives in the user's window and is never closed by
 * `kill-window`.
 */
function openRelayPane(
  run: TmuxRunner,
  spec: { ownPane: string; cwd: string; env: Readonly<Record<string, string>>; command: readonly string[] },
): HostOpened {
  let spawned: TmuxRunResult;
  try {
    spawned = run(buildHandoffPaneArgv({ orchestratorPane: spec.ownPane, cwd: spec.cwd, env: spec.env, command: spec.command }));
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (!spawned.ok) {
    return { ok: false, error: spawned.stderr || "tmux split-window 失败" };
  }
  const paneId = parseSpawnedPaneId(spawned.stdout);
  if (!paneId) {
    return { ok: false, error: "tmux 没有返回新 pane id" };
  }
  return { ok: true, paneId };
}

/** Write the name's display half: the window title and the option the status line reads. */
function showName(run: TmuxRunner, pane: string, name: string): string[] {
  const notes: string[] = [];
  try {
    const renamed = run(buildRenameWindowArgv(pane, name));
    if (!renamed.ok) notes.push(`window title 没写成：${renamed.stderr || "tmux 拒绝"}`);
    const option = run(buildSetSessionNameOptionArgv(pane, name));
    if (!option.ok) notes.push(`@rg_session_name 没写成：${option.stderr || "tmux 拒绝"}`);
  } catch (error) {
    notes.push(`展示写入失败：${(error as Error).message}`);
  }
  return notes;
}

/** Take both halves back, and only where they still say OUR name. */
function clearName(
  run: TmuxRunner,
  pane: string,
  current: { windowName: string; option: string } | undefined,
  name: string,
  originalWindowName?: string,
): string[] {
  const notes: string[] = [];
  try {
    if (current?.option === name) {
      const unset = run(buildUnsetSessionNameOptionArgv(pane));
      if (!unset.ok) notes.push(`@rg_session_name 没清掉：${unset.stderr || "tmux 拒绝"}`);
    }
    // The title is put back only when it is still OURS: a window somebody
    // renamed in the meantime is not this session's to rename again.
    if (current?.windowName === name && originalWindowName !== undefined && originalWindowName.length > 0) {
      const restored = run(buildRenameWindowArgv(pane, originalWindowName));
      if (!restored.ok) notes.push(`window title 没还原：${restored.stderr || "tmux 拒绝"}`);
    }
  } catch (error) {
    notes.push(`展示还原失败：${(error as Error).message}`);
  }
  return notes;
}

export interface TmuxHostOptions {
  /**
   * The sessions some registry records (judges, children, workers) — what the
   * production runner declares ({@link createDeclaringTmuxRunner}).
   */
  held?: () => Iterable<string | undefined>;
  /** Test seam: the runner every act goes through, instead of the declaring one. */
  run?: TmuxRunner;
  /** This process's own dedicated session. Absent ⇒ one that can never be derived (tests). */
  scope?: TmuxScope;
  env?: () => NodeJS.ProcessEnv;
  /** The banner half; default `terminal-notifier` through the same runner. */
  notifier?: HostNotifier;
}

/** A scope that derives no name: every scope act is a no-op or a refusal, as with no session id. */
const NO_SCOPE: TmuxScope = {
  sessionId: () => undefined,
  repoRoot: () => "/",
  read: () => undefined,
  write: () => {},
  now: () => new Date().toISOString(),
};

export function createTmuxHost(opts: TmuxHostOptions): GateHost {
  const scope = opts.scope ?? NO_SCOPE;
  const env = opts.env ?? (() => process.env);
  const run = opts.run ?? createDeclaringTmuxRunner({ scope, held: opts.held ?? (() => []), env });
  const livePanes = () => listServerPanes(run);
  const result = (outcome: { ok: true } | { ok: false; error: string }): HostResult => outcome;
  return {
    kind: "tmux",
    ready: () => ({ ok: true }),
    server: () => tmuxServerFrom(env()),
    ownPane: () => env().TMUX_PANE?.trim() || undefined,
    livePanes,
    pinChildren: (reason) => result(pinOwnSession(run, scope, reason)),
    openWindow: (spec) => {
      const opened = openScopeWindow(run, scope, {
        cwd: spec.cwd,
        env: spec.env,
        command: spec.command,
        ...(spec.windowName === undefined ? {} : { windowName: spec.windowName }),
        ...(spec.pin === undefined ? {} : { pin: spec.pin }),
      });
      if (!opened.ok) return opened;
      return {
        ok: true,
        paneId: opened.paneId,
        ...(opened.windowId === undefined ? {} : { windowId: opened.windowId }),
        sessionName: opened.sessionName,
      };
    },
    openBeside: (spec) => openRelayPane(run, spec),
    decorate: (paneId, decor) => decorateSessionPane(run, paneId, decor),
    paintLabel: (paneId, title) => paintPaneTitle(run, paneId, title),
    closeWindow: (coords) => closeSessionWindow(run, coords),
    closePane: (paneId) => closeSessionPane(run, paneId),
    closeChildren: () => closeOwnSession(run, scope),
    setPaneFact: (pane, option, value) => run(buildSetPaneOptionArgv(pane, option, value)).ok,
    unsetPaneFact: (pane, option) => { run(buildUnsetPaneOptionArgv(pane, option)); },
    paneCoords: (pane) => {
      try {
        const read = run(buildReadOwnCoordsArgv(pane));
        return read.ok ? parseOwnCoords(read.stdout) : undefined;
      } catch {
        return undefined;
      }
    },
    showSessionName: (pane, name) => showName(run, pane, name),
    clearSessionName: (pane, current, name, original) => clearName(run, pane, current, name, original),
    reclaimScope: (scopeSession, owner) => reclaimTmuxScope(run, scopeSession, owner),
    sweepUnnamedScopes: (self, named, report, alive) => sweepUnnamedTmuxScopes({ run, alive, livePanes }, self, named, report),
    notifier: opts.notifier ?? createTmuxNotifier({ run, env }),
  };
}
