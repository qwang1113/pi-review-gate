/**
 * ONE gate session per worktree — the presence heartbeat and the refusal
 * watch, moved out of `extensions/review-gate.ts` (t6, wave 2 of the split).
 *
 * The RULE (who may hold a worktree, when a claim lapses, who is exempt) is
 * lib/session-exclusivity.ts. What is here is the session-bound half: the
 * presence file beside the sidecar it protects, the timer that keeps it
 * fresh, and the re-check timer a refused session watches the holder with.
 */

import { readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join as pathJoin } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  PRESENCE_FILENAME,
  PRESENCE_HEARTBEAT_MS,
  checkSessionExclusivity,
  claimsMainSidecar,
  parsePresence,
  presenceFor,
  presenceIsOurs,
  type PresenceRecord,
} from "./session-exclusivity.ts";
import { PREDECESSOR_SESSION_ENV } from "./session-inheritance.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import type { Ref, SessionHost } from "./session-host.ts";

export function createWorktreePresence(
  host: SessionHost,
  deps: {
    /** The last UI context a render reached — the refusal re-check notifies there. */
    lastUiCtx: Ref<ExtensionContext | undefined>;
  },
) {
  const { lastUiCtx } = deps;

  /** This worktree's presence file — beside the sidecar it protects. */
  function presencePath(root: string): string {
    return pathJoin(root, ".pi", PRESENCE_FILENAME);
  }

  /** The record on disk, or undefined when absent/unreadable/corrupt. */
  function readPresence(root: string): PresenceRecord | undefined {
    try { return parsePresence(readFileSync(presencePath(root), "utf8")); }
    catch { return undefined; }
  }

  let presenceTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Hold this worktree: write the heartbeat now, then keep it fresh.
   *
   * Only a session that PASSED the check calls this. A refused one must never
   * write the file — that would take the claim away from the session that
   * actually holds it.
   */
  function holdWorktree(): void {
    const write = () => {
      const sessionId = host.state().sessionId;
      if (!sessionId) return;
      try {
        writeFileAtomic(presencePath(host.repos().cwd), JSON.stringify(presenceFor(sessionId, process.pid, hostname(), Date.now())));
      } catch { /* best effort: a missed heartbeat lapses, it never blocks work */ }
    };
    write();
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = setInterval(write, PRESENCE_HEARTBEAT_MS);
    // The heartbeat must not hold the process open on its own.
    presenceTimer.unref?.();
  }

  /** Stop holding, and drop the claim if it is OURS (never somebody else's). */
  function releaseWorktree(): void {
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = undefined;
    const cwd = host.repos().cwd;
    if (!presenceIsOurs(readPresence(cwd), host.state().sessionId)) return;
    try { rmSync(presencePath(cwd), { force: true }); } catch { /* the window lapses anyway */ }
  }

  /**
   * Decide whether this session may work in this worktree, and act on it.
   *
   * Refused ⇒ the refusal is put on the state, where `unmetRequirements`
   * (the authority every ship path shares) turns it into a block, and where
   * the edit gate reads it. Allowed ⇒ this session takes the claim.
   */
  function applySessionExclusivity(ctx?: ExtensionContext): void {
    const state = host.state();
    const cwd = host.repos().cwd;
    // The HEIR of the current holder takes over (2026-09-10): a successor
    // started by `orchestrator_handoff` runs in this same worktree ON PURPOSE
    // — that is how one orchestration keeps reaching its children — so
    // refusing it would kill the very handoff it exists to complete. It says
    // so by naming the session it replaces, which it carries in its own
    // environment.
    const successorOf = (process.env[PREDECESSOR_SESSION_ENV] ?? "").trim() || undefined;
    const verdict = checkSessionExclusivity({
      env: process.env,
      sessionId: state.sessionId,
      existing: readPresence(cwd),
      ...(successorOf ? { successorOf } : {}),
      repoRoot: cwd,
      now: Date.now(),
    });
    if (!verdict.ok) {
      // `normal` is the mode whose DEFINING behavior is that the gate is off:
      // both the edit guard and the bash ship gate return before any of this
      // could bite (lib/ship-gate-edit-guard.ts, lib/ship-gate-bash.ts). So no
      // refusal is raised here — it would be a message naming a rule the
      // session is not subject to.
      //
      // But it does NOT take the claim either: the record belongs to the
      // session that holds this worktree, and overwriting it with our own id
      // would both steal the holder's protection and make our own exit delete
      // it (`presenceIsOurs` would say yes) — reviewer P2, 2026-09-05.
      if (state.taskMode === "normal") {
        delete state.exclusivityRefusal;
        stopExclusivityRecheck();
        return;
      }
      // Announce it once PER HOLDER, then keep watching: the refusal PROMISES
      // that closing the other session is enough, so it has to be able to come
      // back on its own. Deduped on WHO holds it, not on the text: the text
      // carries the holder's heartbeat, which is rewritten every few seconds,
      // so comparing the message would re-notify on every re-check tick
      // (reviewer P2, 2026-09-05).
      if (refusedHolderId !== verdict.holder.sessionId) {
        refusedHolderId = verdict.holder.sessionId;
        try { ctx?.ui.notify(verdict.reason, "error"); } catch { /* headless */ }
      }
      state.exclusivityRefusal = verdict.reason;
      startExclusivityRecheck();
      return;
    }
    const wasRefused = state.exclusivityRefusal !== undefined;
    delete state.exclusivityRefusal;
    refusedHolderId = undefined;
    stopExclusivityRecheck();
    if (wasRefused) {
      try { ctx?.ui.notify("review-gate: 占用这个 worktree 的会话已消失，门禁正常启动，本会话接管这个 worktree。", "info"); }
      catch { /* headless */ }
    }
    // A judge / orchestration child does not claim the worktree, so it must
    // not write a heartbeat either — its own presence would refuse the very
    // session that opened it.
    if (claimsMainSidecar(process.env)) holdWorktree();
  }

  /** The refused session's own watch — the only way its refusal can lift. */
  let exclusivityRecheckTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * WHICH holder this session has already complained about.
   *
   * The dedupe key is the holder's session id, not the refusal text: the text
   * quotes the holder's heartbeat, which is rewritten every few seconds, so a
   * text comparison would fire a fresh error box on every re-check tick.
   */
  let refusedHolderId: string | undefined;

  function startExclusivityRecheck(): void {
    if (exclusivityRecheckTimer) return;
    exclusivityRecheckTimer = setInterval(
      () => { try { applySessionExclusivity(lastUiCtx.current); } catch { /* next tick retries */ } },
      PRESENCE_HEARTBEAT_MS,
    );
    // Never hold the process open just to watch somebody else's heartbeat.
    exclusivityRecheckTimer.unref?.();
  }

  function stopExclusivityRecheck(): void {
    if (exclusivityRecheckTimer) clearInterval(exclusivityRecheckTimer);
    exclusivityRecheckTimer = undefined;
  }

  return { holdWorktree, releaseWorktree, applySessionExclusivity, stopExclusivityRecheck };
}
