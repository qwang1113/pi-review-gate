/**
 * RECLAIMING WHAT DEAD SESSIONS LEFT BEHIND — the tmux session, the
 * registration and the inbox, one entry at a time.
 *
 * ── WHY THIS IS NOT PART OF THE REGISTRY ITSELF (2026-09-25) ──
 *
 * lib/session-registry.ts answers "who holds this name, and is that holder
 * alive" — a question about ONE name, with no tmux session to kill. The sweep
 * answers a different one ("what did the sessions that are gone leave on this
 * machine"), it acts on OTHER sessions' leftovers, and the act is destructive.
 * Keeping the two together pushed the registry past the 600-line hard block
 * (AGENTS.md §架构规范) and, more to the point, would have made the module that
 * only ever READS a name the module that also kills sessions. The dependency
 * runs one way: this file uses the registry, never the reverse.
 *
 * ── WHAT IT DOES, IN ORDER, PER ENTRY ──
 *
 *   1. classify (lib/session-registry.ts) — `live` and `unknown` are left
 *      alone, with the reason recorded;
 *   2. if the entry names a dedicated tmux session, read that session's
 *      `@rg_scope_owner` marker and compare it with the DEAD session's id: only
 *      a match authorizes the kill (a name that looks like ours is not ours).
 *      THE MARKER IS READ THROUGH THE SAME NAME RESOLUTION THE KILL USES:
 *      measured on tmux 3.7c, a session target with no exact match falls back to
 *      a PREFIX match (with only `rg-…-dead000000x` left, `-t rg-…-dead000000`
 *      answers about it). That is exactly why the kill is gated on a READ rather
 *      than on the name — what gets killed is never a session whose marker was
 *      not just seen to be the dead holder's, and a session of somebody else's
 *      answers with another owner (or with nothing) and is left alone;
 *   3. kill it (only when step 2 proved it is the dead session's own), then MOVE
 *      the registration aside and remove it. Moving first is what catches a
 *      registration somebody re-created in the meantime: its session id differs
 *      from the one we classified, so it is put straight back instead of
 *      deleted;
 *   4. and NO INBOX DELETION (2026-09-25, reviewer P1 twice): the registration
 *      move above is what frees the name, and a fresh session can claim it and
 *      be sent a message before any cleanup here could run. Mail left by the
 *      dead holder stays; the next session to take the name reads it (skipping
 *      what was addressed to the previous holder) and reclaims the space. The
 *      reasoning is in full at the removal site below.
 *
 * A scope session that is ALREADY GONE is neither an error nor a reason to keep
 * the registration: step 2 says so through the server's own name list, and the
 * cleanup runs without the kill. A session that crashed before creating any
 * child has no scope session at all — that is the ordinary case, not an edge
 * case, and it is the one where a stale registration would otherwise sit
 * occupied forever.
 *
 * AFTER THE REGISTRATIONS, the dedicated sessions of UNNAMED sessions — which
 * no registration points at — are judged from the facts on the session itself
 * ({@link sweepUnnamedScopes}).
 *
 * FAIL-CLOSED THROUGHOUT: an unreadable tmux, an unreadable marker and an
 * unreadable registration all leave the entry alone, reported in
 * {@link SweepReport}.kept / `notes`. A name that is reclaimed twice is cheaper
 * than a session that is killed once by mistake.
 */

import {
  buildKillSessionArgv,
  buildReadSessionOwnerArgv,
  SESSION_OWNER_PANE_OPTION,
  SESSION_OWNER_PID_OPTION,
  SESSION_PINNED_OPTION,
  type SessionOwnerOption,
} from "./tmux-session-argv.ts";
import { isOwnSessionName, isPaneId } from "./orchestrator-tmux.ts";
import { listServerPanes } from "./judge-pane.ts";
import { readSessionNames, scopeNameOwnedBy, writeOwnerFacts } from "./session-tmux-scope.ts";
import {
  classifyEntry,
  listEntries,
  parseEntryText,
  sessionEntryPath,
  type RegistryDeps,
} from "./session-registry.ts";

/** What the orphan sweep did, per name — reported, never silently swallowed. */
export interface SweepReport {
  examined: number;
  reaped: { name: string; sessionId: string; sessionKilled: boolean }[];
  kept: { name: string; reason: string }[];
  notes: string[];
  /** The UNNAMED sessions' dedicated tmux sessions ({@link sweepUnnamedScopes}). */
  scopes: { reaped: { session: string; owner: string }[]; kept: { session: string; reason: string }[] };
}

/** The session running the sweep — whose own leftovers are never reclaimed. */
export interface SweepSelf {
  sessionId?: string;
  name?: string;
  /** This process's liveness facts: its own dedicated session is refreshed with them. */
  pid?: number;
  pane?: string;
}

/**
 * Reclaim every registration whose holder is provably gone.
 *
 * `self` is the session running the sweep: its OWN registration is skipped (a
 * session that adopted a name a moment ago must not have it collected from
 * under it), and unnamed sessions pass nothing.
 */
export function sweepOrphans(deps: RegistryDeps, self?: SweepSelf): SweepReport {
  const report: SweepReport = { examined: 0, reaped: [], kept: [], notes: [], scopes: { reaped: [], kept: [] } };
  const listed = listEntries(deps);
  if (listed.error) {
    report.notes.push(`${listed.error} —— 本次不回收任何东西`);
    return report;
  }
  for (const name of listed.unreadable) report.notes.push(`登记 ${name} 读不出来 —— 留着不动`);
  for (const entry of listed.entries) {
    report.examined += 1;
    if (self?.sessionId !== undefined && entry.sessionId === self.sessionId) {
      report.kept.push({ name: entry.name, reason: "是本会话自己的登记" });
      continue;
    }
    const occupancy = classifyEntry(deps, entry);
    if (occupancy !== "dead") {
      report.kept.push({ name: entry.name, reason: occupancy === "live" ? "占用者还活着" : "占用者判不出来（fail-closed）" });
      continue;
    }
    let sessionKilled = false;
    const scopeSession = entry.scopeSession;
    if (scopeSession !== undefined) {
      const markerRead = (() => {
        try {
          return deps.runTmux(buildReadSessionOwnerArgv(scopeSession));
        } catch (error) {
          return { ok: false, stdout: "", stderr: (error as Error).message };
        }
      })();
      if (!markerRead.ok) {
        // A FAILED READ HAS TWO CAUSES, and they are not the same fact: the
        // session may be GONE (nothing left to kill — the cleanup below still
        // has a registration and an inbox to reclaim) or tmux may be
        // unreadable. The server-wide NAME LIST separates them without parsing
        // tmux's stderr, which this repository refuses to do. Absent from a
        // readable list ⇒ gone; anything else ⇒ unknown, and unknown does not
        // touch the registration.
        const names = readSessionNames(deps.runTmux);
        if (names === undefined || names.includes(scopeSession)) {
          report.kept.push({ name: entry.name, reason: `专属 session ${scopeSession} 的归属标记读不到 —— 不杀` });
          continue;
        }
      } else if (markerRead.stdout.trim() !== entry.sessionId) {
        const marker = markerRead.stdout.trim();
        report.kept.push({
          name: entry.name,
          reason: `专属 session ${scopeSession} 的归属标记是 ${marker || "(空)"}，不是 ${entry.sessionId} —— 不杀`,
        });
        continue;
      } else {
        const killed = deps.runTmux(buildKillSessionArgv(scopeSession), undefined, [scopeSession]);
        if (!killed.ok) {
          report.kept.push({ name: entry.name, reason: `回收 ${scopeSession} 失败：${killed.stderr || "tmux 拒绝"}` });
          continue;
        }
        sessionKilled = true;
      }
    }
    // REMOVE BY MOVING: a registration that changed hands between the
    // classification and this moment is put straight back.
    const path = sessionEntryPath(deps.root, entry.name);
    const aside = `${path}.swept-${deps.now()}`;
    if (deps.io.rename(path, aside)) {
      const moved = parseEntryText(deps.io.readText(aside));
      if (moved === undefined || moved.sessionId !== entry.sessionId) {
        deps.io.rename(aside, path);
        report.kept.push({ name: entry.name, reason: "登记在回收过程中被重新登记 —— 已放回" });
        continue;
      }
      deps.io.remove(aside);
    } else {
      // Could not even move it: another sweeper got there first, or the file is
      // gone. Either way this entry is not ours to delete now.
      report.kept.push({ name: entry.name, reason: "登记已被另一个回收者处理" });
      continue;
    }
    // THE INBOX IS NOT TOUCHED (reviewer P1 twice, 2026-09-25).
    //
    // “The holder is dead, so delete its mail” reads safe and is not. Removing
    // the registration — the move above already did it — is what FREES the
    // name, and a fresh session can claim it and be SENT a message between that
    // moment and any deletion here. That message would be destroyed after its
    // sender was told it had been delivered. Re-reading the registration first
    // only narrows the window (the reviewer said so, correctly); the only thing
    // that would close it is making a name and its mail ONE atomic unit, which
    // would rewrite t2's path contract for a race whose loser is somebody's
    // message.
    //
    // So the mail stays where it is. A name nobody holds cannot be sent
    // anything (the sender requires a live recipient), so the leftovers cannot
    // grow; whoever takes the name next reads them and skips what was addressed
    // to the previous holder (lib/session-message-tools.ts), which is also where
    // the file's space is finally reclaimed.
    report.notes.push(`${entry.name}: inbox 留在原地（名字与邮件无法原子清理，删它会丢新持有者的信）`);
    report.reaped.push({ name: entry.name, sessionId: entry.sessionId, sessionKilled });
  }
  // A NAMED session's dedicated session is the registration path's business,
  // decided above against the registration's own facts; the unnamed pass never
  // judges it a second time.
  const named = {
    owners: new Set(listed.entries.map((entry) => entry.sessionId)),
    sessions: new Set(listed.entries.flatMap((entry) => (entry.scopeSession === undefined ? [] : [entry.scopeSession]))),
  };
  sweepUnnamedScopes(deps, self ?? {}, named, report);
  return report;
}

/**
 * THE DEDICATED SESSIONS NOBODY REGISTERED (2026-09-27).
 *
 * A session that never took a name has no registration, so the pass above
 * never sees the `rg-…` session it created — and one that died by `kill -9`
 * never ran its own exit cleanup. The session itself carries what is needed:
 * the `@rg_scope_owner` marker (who built it) and the owner's pid and pane
 * (lib/session-tmux-scope.ts writeOwnerFacts). It is killed only when ALL of
 * these hold:
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
export function sweepUnnamedScopes(
  deps: Pick<RegistryDeps, "runTmux" | "alive">,
  self: SweepSelf,
  named: { owners: ReadonlySet<string>; sessions: ReadonlySet<string> },
  report: SweepReport,
): void {
  const run = deps.runTmux;
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
    if (panes === null) panes = listServerPanes(run);
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
