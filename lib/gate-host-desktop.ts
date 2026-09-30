/**
 * THE DESKTOP HOST — the gate's sessions and banners as requests to the
 * desktop client (docs/desktop/host-protocol.md; wire shapes in
 * lib/desktop-host-protocol.ts; the connection in lib/desktop-host-client.ts).
 *
 * Every primitive is one request (appendix A of the protocol doc maps each
 * tmux act to its message). What happens when one fails is the protocol's
 * fail-closed table (§8), and it is the same table the tmux host follows:
 * an open that fails refuses the child, an unreadable list is UNKNOWN (never
 * "dead"), a failed close keeps the record, a failed decoration is a cosmetic
 * warning. Nothing here falls back to tmux.
 *
 * Handles are `desktop:<id>` (lib/gate-host.ts `desktopHandle`): a child's
 * pane and window are the same session, and the group it belongs to is named
 * after THIS session, which is who the client records as its parent.
 */

import { CHILD_STATES, type ChildState } from "./orchestrator-child-state.ts";
import { paneTitleFor } from "./orchestrator-pane-decor.ts";
import {
  PANE_KIND_OPTION,
  PANE_REPO_OPTION,
  PANE_SID_OPTION,
  PANE_STATE_AT_OPTION,
  PANE_STATE_OPTION,
} from "./tmux-pane-state.ts";
import type { DesktopClient, DesktopReply } from "./desktop-host-client.ts";
import type { Method, Params } from "./desktop-host-protocol.ts";
import {
  DESKTOP_HANDLE_PREFIX,
  desktopHandle,
  desktopIdOf,
  type GateHost,
  type HostOpened,
  type HostResult,
} from "./gate-host.ts";

export interface DesktopHostOptions {
  socketPath: string;
  /** The client-minted id of THIS process (`RG_HOST_SESSION`). */
  hostSessionId: string;
  client: DesktopClient;
}

/** What the client shows when `notify` has no binary to find: it IS the notifier. */
export const DESKTOP_NOTIFIER = "desktop-client";

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

export function createDesktopHost(opts: DesktopHostOptions): GateHost {
  const { client } = opts;
  const own = opts.hostSessionId;
  const ownHandle = desktopHandle(own);
  /** The name this process last showed — the client keeps no readable copy for us. */
  let shownName: string | undefined;

  const ask = <M extends Method>(method: M, params: Params<M>): DesktopReply<M> => client.request(method, params);
  const why = (reply: { ok: false; error: { code: string; message: string } }): string =>
    `桌面客户端 ${reply.error.code}：${reply.error.message}`;
  const done = (reply: DesktopReply<Method>): HostResult => (reply.ok ? { ok: true } : { ok: false, error: why(reply) });

  function target(handle: string): string | { error: string } {
    return desktopIdOf(handle) ?? { error: `不是桌面宿主的会话句柄：${JSON.stringify(handle)}` };
  }

  function open(spec: {
    cwd: string;
    env: Readonly<Record<string, string>>;
    command: readonly string[];
    role: { kind: Params<"session.open">["role"] };
    title: string;
    placement: Params<"session.open">["placement"];
  }): { ok: true; id: string } | { ok: false; error: string } {
    const opened = ask("session.open", {
      argv: [...spec.command],
      cwd: spec.cwd,
      env: { ...spec.env },
      title: clip(spec.title, 200) || spec.role.kind,
      role: spec.role.kind,
      placement: spec.placement,
    });
    return opened.ok ? { ok: true, id: opened.result.hostSessionId } : { ok: false, error: why(opened) };
  }

  function decorateSelf(fields: Omit<Params<"session.decorate">, "hostSessionId">): HostResult {
    return done(ask("session.decorate", { hostSessionId: own, ...fields }));
  }

  function listing() {
    return ask("session.list", {});
  }

  return {
    kind: "desktop",
    ready: () => {
      const up = client.connect();
      return up.ok ? { ok: true } : { ok: false, error: `桌面客户端 ${up.error.code}：${up.error.message}` };
    },
    server: () => `${DESKTOP_HANDLE_PREFIX}${opts.socketPath}`,
    ownPane: () => ownHandle,
    livePanes: () => {
      const listed = listing();
      return listed.ok ? listed.result.sessions.map((s) => desktopHandle(s.hostSessionId)) : undefined;
    },
    pinChildren: (reason) => done(ask("session.pin", { reason: clip(reason, 200) })),
    openWindow: (spec): HostOpened => {
      // PIN FIRST, AND A FAILED PIN REFUSES THE WINDOW (§6 `session.pin`).
      if (spec.pin !== undefined) {
        const pinned = done(ask("session.pin", { reason: clip(spec.pin, 200) }));
        if (!pinned.ok) return pinned;
      }
      const opened = open({ ...spec, title: spec.windowName ?? spec.role.kind, placement: "own-group" });
      if (!opened.ok) return opened;
      const handle = desktopHandle(opened.id);
      return { ok: true, paneId: handle, windowId: handle, sessionName: ownHandle };
    },
    openBeside: (spec): HostOpened => {
      const opened = open({ ...spec, title: spec.role.kind, placement: "beside-opener" });
      return opened.ok ? { ok: true, paneId: desktopHandle(opened.id) } : opened;
    },
    decorate: (paneId, decor) => {
      const id = target(paneId);
      const reply = typeof id === "string"
        ? done(ask("session.decorate", {
            hostSessionId: id,
            label: clip(paneTitleFor({
              label: decor.label,
              state: decor.state,
              ...(decor.stateForSeconds === undefined ? {} : { stateForSeconds: decor.stateForSeconds }),
            }), 200),
            colorSeed: clip(decor.colorSeed, 128) || "gate",
          }))
        : { ok: false as const, error: id.error };
      return reply.ok ? undefined : `pane 装饰失败（仅显示降级）：${reply.error}`;
    },
    paintLabel: (paneId, title) => {
      const id = desktopIdOf(paneId);
      if (id !== undefined) ask("session.decorate", { hostSessionId: id, label: clip(title, 200) });
    },
    closeWindow: ({ windowId }) => {
      const id = target(windowId);
      return typeof id === "string" ? done(ask("session.close", { target: "session", hostSessionId: id })) : { ok: false, error: id.error };
    },
    closePane: (paneId) => {
      const id = target(paneId);
      return typeof id === "string" ? done(ask("session.close", { target: "session", hostSessionId: id })) : { ok: false, error: id.error };
    },
    closeChildren: () => {
      const closed = ask("session.close", { target: "children" });
      if (!closed.ok) return { ok: false, error: why(closed) };
      const count = closed.result.closed.length;
      return { ok: true, killed: count > 0, note: count > 0 ? `已关掉本会话的 ${count} 个子会话` : "本会话没有还开着的子会话" };
    },
    setPaneFact: (pane, option, value) => {
      if (pane !== ownHandle) return false;
      switch (option) {
        case PANE_SID_OPTION: return decorateSelf({ piSessionId: clip(value, 128) }).ok;
        case PANE_REPO_OPTION: return decorateSelf({ repo: value }).ok;
        case PANE_KIND_OPTION: return decorateSelf({ kind: clip(value, 32) }).ok;
        case PANE_STATE_OPTION:
          return (CHILD_STATES as readonly string[]).includes(value) && decorateSelf({ state: value as ChildState }).ok;
        case PANE_STATE_AT_OPTION: {
          const at = Number(value);
          return Number.isSafeInteger(at) && at >= 0 && decorateSelf({ stateAt: at }).ok;
        }
      }
      return false;
    },
    // The protocol has no unset: the facts leave with the session itself.
    unsetPaneFact: () => {},
    paneCoords: (pane) => (pane === ownHandle
      ? { session: ownHandle, window: ownHandle, windowName: shownName ?? "", option: shownName ?? "" }
      : undefined),
    showSessionName: (_pane, name) => {
      const shown = decorateSelf({ sessionName: name });
      if (!shown.ok) return [`会话名没显示出来：${shown.error}`];
      shownName = name;
      return [];
    },
    clearSessionName: (_pane, _current, name) => {
      if (shownName !== name) return [];
      const cleared = decorateSelf({ sessionName: null });
      if (!cleared.ok) return [`会话名没清掉：${cleared.error}`];
      shownName = undefined;
      return [];
    },
    // A dead holder's children are orphans of the client's parent record; the
    // unnamed pass reclaims every orphan, named holder or not. So the
    // registration may go — but only once the client has ANSWERED, and never for
    // a group this host cannot address (a tmux `rg-…` left by an earlier
    // terminal session is the tmux host's to reclaim, not a fact to guess).
    reclaimScope: (scopeSession) => {
      if (desktopIdOf(scopeSession) === undefined) {
        return { outcome: "kept", reason: `${scopeSession} 不是桌面宿主的子会话组 —— 留给它自己的宿主回收` };
      }
      const listed = listing();
      return listed.ok ? { outcome: "gone" } : { outcome: "kept", reason: `读不到桌面客户端的会话列表（${why(listed)}）` };
    },
    sweepUnnamedScopes: (_self, _named, report) => {
      const listed = listing();
      if (!listed.ok) {
        report.notes.push(`读不到桌面客户端的会话列表（${why(listed)}）—— 孤儿子会话本次不回收`);
        return;
      }
      const alive = new Set(listed.result.sessions.map((s) => s.hostSessionId));
      for (const s of listed.result.sessions) {
        if (s.parent === null || alive.has(s.parent)) continue;
        const session = desktopHandle(s.hostSessionId);
        if (s.groupPin !== null) {
          report.scopes.kept.push({ session, reason: `已铉住（${s.groupPin}），由继承者收尾` });
          continue;
        }
        const closed = done(ask("session.close", { target: "session", hostSessionId: s.hostSessionId }));
        if (!closed.ok) {
          report.scopes.kept.push({ session, reason: `回收失败：${closed.error}` });
          continue;
        }
        report.scopes.reaped.push({ session, owner: desktopHandle(s.parent) });
        report.notes.push(`已回收父会话 ${s.parent} 已不在的孤儿子会话 ${s.hostSessionId}`);
      }
    },
    notifier: {
      path: () => DESKTOP_NOTIFIER,
      address: () => undefined,
      // Unknown ⇒ nobody is looking ⇒ send (§8 `focus.state`).
      watching: () => {
        const state = ask("focus.state", {});
        return state.ok && state.result.appFrontmost && state.result.focusedHostSessionId === own;
      },
      send: (banner) => {
        const sent = ask("notify", {
          kind: banner.kind,
          title: banner.title,
          body: banner.body,
          ...(banner.group ? { group: clip(banner.group, 128) } : {}),
          focusHostSessionId: own,
        });
        if (!sent.ok) return { ok: false, error: why(sent) };
        return sent.result.shown ? { ok: true } : { ok: false, error: "桌面客户端没有显示这条通知（系统拒绝，例如通知权限被关）" };
      },
    },
  };
}
