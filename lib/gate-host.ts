/**
 * THE HOST FACTORY — where the gate's sessions and banners actually live
 * (2026-09-30, t3-host-factory).
 *
 * The gate decides WHAT to open, watch, label, close and announce; a HOST
 * decides HOW. Two hosts exist, and one process runs under exactly one of them,
 * chosen once from its environment ({@link createGateHost}):
 *
 *  - `tmux` (lib/gate-host-tmux.ts) — the terminal: windows of the opener's own
 *    tmux session, `terminal-notifier` banners. Byte-for-byte what the gate did
 *    before this module existed.
 *  - `desktop` (lib/gate-host-desktop.ts) — the desktop client, asked over the
 *    unix socket protocol of lib/desktop-host-protocol.ts.
 *
 * An environment that names neither correctly gets the `unavailable` host:
 * every act fails with the reason and nothing falls back to tmux, which would
 * open windows a desktop user cannot see (docs/desktop/host-protocol.md §2).
 *
 * WHAT IS NOT HERE: sequencing. Opening a session is open → register →
 * decorate → verify for BOTH hosts (lib/session-factory.ts), and the repaint
 * throttle, the pane-state reporter, the naming runtime, the banner policy and
 * the orphan sweep are host-neutral too. A host only answers primitives.
 */

import type { SessionPaneCoords, SessionPaneDecor } from "./session-factory.ts";
import type { SessionPaneRole } from "./session-env.ts";
import type { PaneOption } from "./tmux-pane-state.ts";
import type { SweepReport, SweepSelf } from "./session-orphan-sweep.ts";
import type { UserNotifyKind } from "./user-notify.ts";
import { ID_PATTERN, resolveHostEnv } from "./desktop-host-protocol.ts";
import { isPaneId, parseWindowCoords, tmuxServerFrom } from "./orchestrator-tmux.ts";

export type HostKind = "tmux" | "desktop" | "unavailable";
export type HostResult = { ok: true } | { ok: false; error: string };
export type HostOpened = ({ ok: true } & SessionPaneCoords) | { ok: false; error: string };

/** A child window of this session's own group. */
export interface HostWindowSpec {
  cwd: string;
  env: Readonly<Record<string, string>>;
  command: readonly string[];
  role: SessionPaneRole;
  /** What `tmux ls` / the desktop tab calls it. */
  windowName?: string;
  /** Pin the group first (a reason): somebody inherits it, so no sweep may reclaim it. */
  pin?: string;
}

/** The relay successor, beside the opener's own seat. */
export interface HostBesideSpec {
  ownPane: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  command: readonly string[];
  role: SessionPaneRole;
}

/** What a dead holder's group came to, when the orphan sweep asked. */
export type ScopeReclaim = { outcome: "killed" | "gone" } | { outcome: "kept"; reason: string };

/** The banner half of a host. */
export interface HostNotifier {
  /** Where the notifier is; `undefined` ⇒ not installed (reported, never assumed). */
  path(): string | undefined;
  /** tmux's click target for this pane; hosts that focus by handle answer `undefined`. */
  address(): { paneId: string; windowId?: string | undefined; socket?: string | undefined } | undefined;
  /**
   * Is the user looking at this session right now? Unknown ⇒ `false` (fail
   * open: send). `address` is this banner's own {@link address} reading, read
   * once per banner by the caller.
   */
  watching(address: { paneId: string } | undefined, sessionBundle: string | undefined): boolean;
  /** Deliver one planned banner. `argv` is tmux's; other hosts use the fields. */
  send(banner: { kind: UserNotifyKind; title: string; body: string; group?: string | undefined; argv: readonly string[] }, blocking: boolean): HostResult;
}

export interface GateHost {
  readonly kind: HostKind;
  /** Reach the host now (session start): fail early, not at the first child. */
  ready(): HostResult;
  /** The server a handle is only meaningful on — recorded beside every handle. */
  server(): string | undefined;
  /** This process's own handle (tmux pane / desktop session). */
  ownPane(): string | undefined;
  /** Every live session handle; `undefined` = unreadable, never "all dead". */
  livePanes(): string[] | undefined;
  pinChildren(reason: string): HostResult;
  openWindow(spec: HostWindowSpec): HostOpened;
  openBeside(spec: HostBesideSpec): HostOpened;
  /** Colour + label. Failure is cosmetic: a warning, never an error. */
  decorate(paneId: string, decor: SessionPaneDecor): string | undefined;
  /** Rewrite one label. Cosmetic, never throws. */
  paintLabel(paneId: string, title: string): void;
  closeWindow(coords: { ownSession: string; windowId: string }): HostResult;
  /** The relay predecessor closing its own seat. */
  closePane(paneId: string): HostResult;
  /** Every child of this session (`declare_done`, process exit). Idempotent. */
  closeChildren(): { ok: true; killed: boolean; note: string } | { ok: false; error: string };
  /** One state fact on this pane (the sidebar reads them). */
  setPaneFact(pane: string, option: PaneOption, value: string): boolean;
  unsetPaneFact(pane: string, option: PaneOption): void;
  /** Where a pane is, as the name registry records it (and what it currently shows). */
  paneCoords(pane: string): { session: string; window: string; windowName: string; option: string } | undefined;
  /** Show `name_session`'s name on this session; the notes say what failed. */
  showSessionName(pane: string, name: string): string[];
  /** `current` is this session's own {@link paneCoords} reading, taken just before. */
  clearSessionName(
    pane: string,
    current: { windowName: string; option: string } | undefined,
    name: string,
    originalWindowName?: string,
  ): string[];
  /** A dead named holder's own group. */
  reclaimScope(scopeSession: string, ownerSessionId: string): ScopeReclaim;
  /** Groups no registration points at. `alive` is the sweep's own pid check. */
  sweepUnnamedScopes(
    self: SweepSelf,
    named: { owners: ReadonlySet<string>; sessions: ReadonlySet<string> },
    report: SweepReport,
    alive: (pid: number) => boolean,
  ): void;
  readonly notifier: HostNotifier;
}

// ---------------------------------------------------------------------------
// Handles — one shape per host, never interchangeable
// ---------------------------------------------------------------------------

/**
 * A desktop session as the gate's registries write it: `desktop:<id>`. The
 * prefix keeps it disjoint from every tmux id (`%12`, `@3`, `rg-…`), so a
 * handle minted under one host can never be read as the other's — tmux argv
 * builders refuse it by shape, and vice versa.
 */
export const DESKTOP_HANDLE_PREFIX = "desktop:";
const HOST_SESSION_ID = new RegExp(ID_PATTERN);

export function desktopHandle(hostSessionId: string): string {
  return `${DESKTOP_HANDLE_PREFIX}${hostSessionId}`;
}

/** The client's id inside a desktop handle, or `undefined` for anything else. */
export function desktopIdOf(handle: unknown): string | undefined {
  if (typeof handle !== "string" || !handle.startsWith(DESKTOP_HANDLE_PREFIX)) return undefined;
  const id = handle.slice(DESKTOP_HANDLE_PREFIX.length);
  return HOST_SESSION_ID.test(id) ? id : undefined;
}

/** A handle a session is watched by (tmux pane or desktop session). */
export function isSessionHandle(value: unknown): value is string {
  return isPaneId(value) || desktopIdOf(value) !== undefined;
}

/**
 * Close coordinates read back from an untrusted sidecar: a tmux pair or a
 * desktop pair, never a mix. Either half wrong drops both (fail-closed: the
 * entry then reads as one that cannot be closed by id).
 */
export function parseSessionCoords(
  raw: { windowId?: unknown; tmuxSession?: unknown },
): { windowId: string; tmuxSession: string } | undefined {
  const tmux = parseWindowCoords(raw ?? {});
  if (tmux !== undefined) return tmux;
  const { windowId, tmuxSession } = raw ?? {};
  if (desktopIdOf(windowId) !== undefined && desktopIdOf(tmuxSession) !== undefined) {
    return { windowId: windowId as string, tmuxSession: tmuxSession as string };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Environment readings (pure)
// ---------------------------------------------------------------------------

/** This process's own handle, from its environment alone. */
export function hostOwnPane(env: NodeJS.ProcessEnv): string | undefined {
  const host = resolveHostEnv(env);
  if (host.kind === "desktop") return desktopHandle(host.hostSessionId);
  if (host.kind === "invalid") return undefined;
  return env.TMUX_PANE?.trim() || undefined;
}

/** The server this process's handles belong to, from its environment alone. */
export function hostServer(env: NodeJS.ProcessEnv): string | undefined {
  const host = resolveHostEnv(env);
  if (host.kind === "desktop") return `${DESKTOP_HANDLE_PREFIX}${host.socketPath}`;
  if (host.kind === "invalid") return undefined;
  return tmuxServerFrom(env);
}

// ---------------------------------------------------------------------------
// The unavailable host
// ---------------------------------------------------------------------------

/** Every act refused with `reason`; every reading unknown. Never falls back to tmux. */
export function createUnavailableHost(reason: string): GateHost {
  const error = `宿主不可用：${reason}（不会退回 tmux）`;
  const refused = { ok: false as const, error };
  return {
    kind: "unavailable",
    ready: () => refused,
    server: () => undefined,
    ownPane: () => undefined,
    livePanes: () => undefined,
    pinChildren: () => refused,
    openWindow: () => refused,
    openBeside: () => refused,
    decorate: () => `pane 装饰失败（仅显示降级）：${error}`,
    paintLabel: () => {},
    closeWindow: () => refused,
    closePane: () => refused,
    closeChildren: () => refused,
    setPaneFact: () => false,
    unsetPaneFact: () => {},
    paneCoords: () => undefined,
    showSessionName: () => [error],
    clearSessionName: () => [error],
    reclaimScope: () => ({ outcome: "kept", reason: error }),
    sweepUnnamedScopes: (_self, _named, report) => { report.notes.push(`${error} —— 未命名会话的子会话组本次不回收`); },
    notifier: {
      path: () => undefined,
      address: () => undefined,
      watching: () => false,
      send: () => refused,
    },
  };
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

export interface GateHostFactoryDeps {
  env: NodeJS.ProcessEnv;
  tmux(): GateHost;
  desktop(opts: { socketPath: string; hostSessionId: string }): GateHost;
}

/** THE one choice of host, made from the environment (`RG_HOST`). */
export function createGateHost(deps: GateHostFactoryDeps): GateHost {
  const host = resolveHostEnv(deps.env);
  if (host.kind === "tmux") return deps.tmux();
  if (host.kind === "desktop") return deps.desktop({ socketPath: host.socketPath, hostSessionId: host.hostSessionId });
  return createUnavailableHost(host.error);
}
