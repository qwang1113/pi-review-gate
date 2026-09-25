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
 *   4. remove that name's inbox file (`<名字>.inbox.jsonl`, the convention
 *      lib/session-registry.ts defines for t3's `@名字` messages) together with
 *      the parked copy a half-consumed one leaves behind (`<inbox>.taken`,
 *      derived by lib/session-message-tools.ts — a message nobody will read
 *      belongs to the dead session like everything else it left).
 *
 * A scope session that is ALREADY GONE is neither an error nor a reason to keep
 * the registration: step 2 says so through the server's own name list, and the
 * cleanup runs without the kill. A session that crashed before creating any
 * child has no scope session at all — that is the ordinary case, not an edge
 * case, and it is the one where a stale registration would otherwise sit
 * occupied forever.
 *
 * FAIL-CLOSED THROUGHOUT: an unreadable tmux, an unreadable marker and an
 * unreadable registration all leave the entry alone, reported in
 * {@link SweepReport}.kept / `notes`. A name that is reclaimed twice is cheaper
 * than a session that is killed once by mistake.
 */

import {
  buildKillSessionArgv,
  buildListSessionsArgv,
  buildReadSessionOwnerArgv,
  parseSessionNames,
} from "./orchestrator-tmux.ts";
import {
  classifyEntry,
  listEntries,
  parseEntryText,
  sessionEntryPath,
  sessionInboxPath,
  type RegistryDeps,
} from "./session-registry.ts";
import { inboxTakenPath } from "./session-message-tools.ts";

/** What the orphan sweep did, per name — reported, never silently swallowed. */
export interface SweepReport {
  examined: number;
  reaped: { name: string; sessionId: string; sessionKilled: boolean; inboxRemoved: boolean }[];
  kept: { name: string; reason: string }[];
  notes: string[];
}

/**
 * Reclaim every registration whose holder is provably gone.
 *
 * `self` is the session running the sweep: its OWN registration is skipped (a
 * session that adopted a name a moment ago must not have it collected from
 * under it), and unnamed sessions pass nothing.
 */
export function sweepOrphans(deps: RegistryDeps, self?: { sessionId?: string; name?: string }): SweepReport {
  const report: SweepReport = { examined: 0, reaped: [], kept: [], notes: [] };
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
        const names = ((): string[] | undefined => {
          try {
            const list = deps.runTmux(buildListSessionsArgv());
            return list.ok ? parseSessionNames(list.stdout) : undefined;
          } catch {
            return undefined;
          }
        })();
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
        const killed = deps.runTmux(buildKillSessionArgv(scopeSession), [scopeSession]);
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
    const inbox = sessionInboxPath(deps.root, entry.name);
    const inboxRemoved = deps.io.remove(inbox);
    // The parked copy goes with it (t3): a `.taken` file is the inbox
    // mid-consumption, and the session that owned it is gone.
    deps.io.remove(inboxTakenPath(inbox));
    report.reaped.push({ name: entry.name, sessionId: entry.sessionId, sessionKilled, inboxRemoved });
  }
  return report;
}
