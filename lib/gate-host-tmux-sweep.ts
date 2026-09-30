/**
 * THE TMUX HOST'S HALF OF THE ORPHAN SWEEP — reading `@rg_scope_*` markers and
 * killing a dead session's dedicated `rg-…` session.
 *
 * The sweep itself (which registrations are dead, the move-aside removal, the
 * inbox rule) is host-neutral and lives in lib/session-orphan-sweep.ts; its
 * header explains the order and why every unreadable fact keeps the session.
 * These two functions are what "reclaim the group a dead session left" means
 * on tmux, reached through lib/gate-host.ts `reclaimScope` /
 * `sweepUnnamedScopes`.
 *
 * THE MARKER IS READ THROUGH THE SAME NAME RESOLUTION THE KILL USES: measured
 * on tmux 3.7c, a session target with no exact match falls back to a PREFIX
 * match, so the kill is gated on a READ rather than on the name — what gets
 * killed is never a session whose marker was not just seen to be the dead
 * holder's.
 */

import {
  buildKillSessionArgv,
  buildReadSessionOwnerArgv,
  SESSION_OWNER_PANE_OPTION,
  SESSION_OWNER_PID_OPTION,
  SESSION_PINNED_OPTION,
  type SessionOwnerOption,
} from "./tmux-session-argv.ts";
import { isOwnSessionName, isPaneId, type TmuxRunner } from "./orchestrator-tmux.ts";
import { readSessionNames, scopeNameOwnedBy, writeOwnerFacts } from "./session-tmux-scope.ts";
import type { SweepReport, SweepSelf } from "./session-orphan-sweep.ts";
import type { ScopeReclaim } from "./gate-host.ts";

/** A NAMED dead holder's own dedicated session: kill it only when its marker names that holder. */
export function reclaimTmuxScope(run: TmuxRunner, scopeSession: string, ownerSessionId: string): ScopeReclaim {
  const markerRead = (() => {
    try {
      return run(buildReadSessionOwnerArgv(scopeSession));
    } catch (error) {
      return { ok: false, stdout: "", stderr: (error as Error).message };
    }
  })();
  if (!markerRead.ok) {
    // A FAILED READ HAS TWO CAUSES, and they are not the same fact: the
    // session may be GONE (nothing left to kill — the cleanup still has a
    // registration and an inbox to reclaim) or tmux may be unreadable. The
    // server-wide NAME LIST separates them without parsing tmux's stderr,
    // which this repository refuses to do. Absent from a readable list ⇒
    // gone; anything else ⇒ unknown, and unknown does not touch the
    // registration.
    const names = readSessionNames(run);
    if (names === undefined || names.includes(scopeSession)) {
      return { outcome: "kept", reason: `专属 session ${scopeSession} 的归属标记读不到 —— 不杀` };
    }
    return { outcome: "gone" };
  }
  const marker = markerRead.stdout.trim();
  if (marker !== ownerSessionId) {
    return { outcome: "kept", reason: `专属 session ${scopeSession} 的归属标记是 ${marker || "(空)"}，不是 ${ownerSessionId} —— 不杀` };
  }
  const killed = run(buildKillSessionArgv(scopeSession), undefined, [scopeSession]);
  if (!killed.ok) return { outcome: "kept", reason: `回收 ${scopeSession} 失败：${killed.stderr || "tmux 拒绝"}` };
  return { outcome: "killed" };
}

/**
 * THE DEDICATED SESSIONS NOBODY REGISTERED (2026-09-27).
 *
 * A session that never took a name has no registration, so the registration
 * pass never sees the `rg-…` session it created — and one that died by
 * `kill -9` never ran its own exit cleanup. The session itself carries what is
 * needed: the `@rg_scope_owner` marker (who built it) and the owner's pid and
 * pane (lib/session-tmux-scope.ts writeOwnerFacts). It is killed only when ALL
 * of these hold:
 *
 *   - its name is exactly what its marker's owner derives (scopeNameOwnedBy) —
 *     a name that merely looks like ours is not ours;
 *   - the owner is neither this session nor a named one;
 *   - the session is not PINNED (`@rg_scope_pinned`: a handed-off seat or an
 *     orchestration manager's — somebody inherits it, so a dead owner is
 *     expected there);
 *   - the recorded pid is not a running process AND the recorded pane is not on
 *     this server's pane list.
 *
 * Every missing or unreadable fact keeps the session (an old build wrote no
 * pid/pane, so its sessions stay until their owner closes them). The owner
 * pane needs no server comparison: the session lives on this server, and its
 * owner opened it from a pane of the same server.
 *
 * THIS SESSION'S OWN dedicated session, left by an earlier process under the
 * same id, is refreshed with this process's pid/pane instead — otherwise it
 * would read as dead to every other sweeper until the next spawn refreshes it.
 */
export function sweepUnnamedTmuxScopes(
  deps: { run: TmuxRunner; alive(pid: number): boolean; livePanes(): string[] | undefined },
  self: SweepSelf,
  named: { owners: ReadonlySet<string>; sessions: ReadonlySet<string> },
  report: SweepReport,
): void {
  const { run } = deps;
  const read = (session: string, option?: SessionOwnerOption): string | undefined => {
    try {
      const result = run(buildReadSessionOwnerArgv(session, option));
      return result.ok ? result.stdout.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const names = readSessionNames(run);
  if (names === undefined) {
    report.notes.push("读不到 tmux session 列表 —— 未命名会话的专属 session 本次不回收");
    return;
  }
  let panes: string[] | undefined | null = null;
  const keep = (session: string, reason: string) => report.scopes.kept.push({ session, reason });
  for (const session of names) {
    if (!isOwnSessionName(session) || named.sessions.has(session)) continue;
    const owner = read(session);
    if (owner === undefined) { keep(session, "归属标记读不到"); continue; }
    // No marker, or one that did not mint this name: not a gate session we can
    // speak for — somebody else's, or a leftover no marker ever landed on.
    if (!scopeNameOwnedBy(session, owner)) { keep(session, `归属标记 ${owner || "(空)"} 推不出这个名字`); continue; }
    if (owner === self.sessionId) {
      if (self.pid !== undefined) {
        const failed = writeOwnerFacts(run, session, { pid: self.pid, pane: self.pane }, [session]);
        if (failed !== undefined) report.notes.push(`本会话的专属 session 存活事实刷新失败：${failed}`);
      }
      keep(session, "是本会话自己的专属 session");
      continue;
    }
    if (named.owners.has(owner)) continue;
    // PINNED ⇒ somebody inherits it (a handed-off seat's judges, a manager's
    // children): its owner being dead is expected. Unreadable ⇒ unknown ⇒ kept.
    const pinned = read(session, SESSION_PINNED_OPTION);
    if (pinned === undefined || pinned.length > 0) { keep(session, pinned ? `已铉住（${pinned}），由继承者收尾` : "铉住标记读不到"); continue; }
    const pidText = read(session, SESSION_OWNER_PID_OPTION);
    const pane = read(session, SESSION_OWNER_PANE_OPTION);
    if (pidText === undefined || pane === undefined) { keep(session, "存活事实读不到"); continue; }
    const pid = /^[1-9]\d*$/.test(pidText) ? Number(pidText) : undefined;
    if (pid === undefined || !isPaneId(pane)) { keep(session, "没有可用的 owner pid/pane（旧版本建的？）"); continue; }
    let alive: boolean;
    try { alive = deps.alive(pid); } catch { keep(session, `判不出 pid ${pid} 是否还在`); continue; }
    if (alive) { keep(session, `owner pid ${pid} 还在`); continue; }
    if (panes === null) panes = deps.livePanes();
    if (panes === undefined) { keep(session, "读不到 pane 列表"); continue; }
    if (panes.includes(pane)) { keep(session, `owner pane ${pane} 还在`); continue; }
    const killed = ((): { ok: boolean; stderr: string } => {
      try {
        return run(buildKillSessionArgv(session), undefined, [session]);
      } catch (error) {
        return { ok: false, stderr: (error as Error).message };
      }
    })();
    if (!killed.ok) { keep(session, `回收失败：${killed.stderr || "tmux 拒绝"}`); continue; }
    report.scopes.reaped.push({ session, owner });
    report.notes.push(`已回收未命名会话 ${owner} 遗留的专属 session ${session}（owner pid ${pid} 与 pane ${pane} 都已不在）`);
  }
}
