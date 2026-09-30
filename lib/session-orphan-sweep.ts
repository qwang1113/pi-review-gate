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
 *   2. if the entry names a dedicated session, ask the HOST to reclaim it
 *      (lib/gate-host.ts `reclaimScope`; under tmux lib/gate-host-tmux-sweep.ts):
 *      read that session's
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
  /** The UNNAMED sessions' dedicated sessions (the host's `sweepUnnamedScopes`). */
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
      // Unreadable ⇒ kept: only a proven owner's group is ever killed, and
      // only a proven-gone one lets the registration go without a kill.
      const reclaimed = deps.gateHost.reclaimScope(scopeSession, entry.sessionId);
      if (reclaimed.outcome === "kept") {
        report.kept.push({ name: entry.name, reason: reclaimed.reason });
        continue;
      }
      sessionKilled = reclaimed.outcome === "killed";
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
  // The groups no registration points at are judged by the host from the facts
  // on the groups themselves (tmux: lib/gate-host-tmux-sweep.ts).
  deps.gateHost.sweepUnnamedScopes(self ?? {}, named, report, (pid) => deps.alive(pid));
  return report;
}
