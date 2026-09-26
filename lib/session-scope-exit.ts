/**
 * CLOSING MY OWN TMUX SESSION WHEN THE SESSION ENDS WITHOUT `declare_done`.
 *
 * Why it exists (2026-09-26, t4): `declare_done` was the only path that ran
 * `closeOwnSession`. `/quit`, `/new`, `/resume`, `/fork` and a plain process
 * exit only gave the NAME back, and the startup orphan sweep walks the name
 * registry — a session that never called `name_session` is not in it — so a
 * worker or judge window opened by an unnamed session outlived it forever.
 *
 * Two exits keep the session on purpose:
 *   - HANDED OFF: the successor adopts the predecessor's judge windows, which
 *     live in the PREDECESSOR's session (see `addressableSessions`);
 *   - A PROJECT MANAGER WITH OPEN CHILDREN: `orchestrator_attach` takes those
 *     children over unchanged ("no child notices"), so killing their windows
 *     would destroy exactly what a takeover exists to inherit.
 *
 * Everything else — the ownership marker, the fail-closed reads, idempotency —
 * is `closeOwnSession`'s, not repeated here.
 */

import { closeOwnSession, type TmuxScope } from "./session-tmux-scope.ts";
import type { TmuxRunner } from "./orchestrator-tmux.ts";

export interface ExitFacts {
  /** This session handed its seat to a successor (`session_handoff` / relay). */
  handedOff: boolean;
  /** Orchestration children registered and not closed. */
  openChildren: number;
}

export function closeOwnSessionOnExit(run: TmuxRunner, scope: TmuxScope, facts: ExitFacts): { closed: boolean; note: string } {
  if (facts.handedOff) return { closed: false, note: "已交接给后继会话 —— 专属 session 留给后继接管" };
  if (facts.openChildren > 0) {
    return { closed: false, note: `还有 ${facts.openChildren} 个未关闭的编排子会话 —— 专属 session 留给 orchestrator_attach 接管` };
  }
  try {
    const result = closeOwnSession(run, scope);
    return result.ok ? { closed: result.killed, note: result.note } : { closed: false, note: result.error };
  } catch (error) {
    return { closed: false, note: (error as Error).message };
  }
}
