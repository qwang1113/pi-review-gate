/**
 * Judge-child liveness arbitration — the main session never waits on a child's
 * good manners.
 *
 * THE MEASURED FAILURE (round-18, reproduced twice in one session). A judge
 * child finished its audit, published its verdict — and never ran
 * `tmux wait-for -S <doneChannel>`. The main session was blocked on that signal,
 * so it waited on a child that had nothing left to do. The same hole swallows a
 * child that dies at startup, crashes mid-run, or loses its provider: no signal
 * is ever emitted, and nobody is left to notice.
 *
 * THE RULE THIS ENCODES. A child's completion signal is an ACCELERATOR, never a
 * precondition. Three INDEPENDENT criteria end a wait, and the main session owns
 * all three:
 *
 *   (a) the done channel fired (the fast path);
 *   (b) the child's SESSION is gone — the caller supplies that as `alive`. In
 *       production today that is `judgeLive` (lib/hierarchy.ts): the child's
 *       pane is absent from tmux's pane list, on the same tmux server that
 *       minted the id. Exactly three things make it say "gone": a readable
 *       pane list that does not contain the pane, an entry carrying NO pane id
 *       at all, and an entry whose recorded tmux server differs from this one
 *       (after a server restart that id names somebody else's pane, so it is
 *       not this judge under any reading). An UNREADABLE pane list is none of
 *       those and counts as ALIVE — and so does an entry whose server is
 *       simply unknown on either side, which `paneIdComparable` treats as
 *       comparable rather than as a mismatch.
 *
 *       This used to be a process probe — the child's own `exitCode`, backed
 *       by a pid-identity check — and the header used to argue that a pane
 *       probe would be wrong here. Both are gone: the process model was
 *       retired with the pane model, and the pid-identity module was deleted
 *       (2026-09-06) as a second implementation with no production caller.
 *       What survives from that argument is the DIRECTION: a failed LOOK never
 *       ends a wait. An empty record does, which is a different thing — there
 *       is nothing left to look at;
 *   (c) the child has been silent past `STALL_MOTION_MAX_AGE_SEC` (a running
 *       session that stopped being evidence of motion).
 *
 * Any of them means: stop waiting, read what the child DID produce, and carry
 * on. Pure decision logic so every branch is testable without tmux.
 */

import { STALL_MOTION_MAX_AGE_SEC } from "./loop-stall.ts";
import { WAIT_DISCIPLINE_HINT } from "./agent-directives.ts";


export interface ChildSnapshot {
  title: string;
  sessionId: string;
  role: string;
  /** ISO timestamp of the spawn. */
  spawnedAt: string;
  /**
   * Is the child's session still there? Supplied by the caller; in production
   * `judgeLive` (lib/hierarchy.ts) — its pane is still listed, on the tmux
   * server that minted the id. `true` when the list cannot be read at all,
   * which is why "not alive" is a positive finding rather than a failed look.
   * (It was the process's `exitCode` under the old process model; that
   * spelling, and the `judgeProcessAlive` it named, are both gone.)
   */
  alive: boolean;
  /**
   * ISO timestamp of the child's last OBSERVED activity — in production the
   * newest line in the child's own CHANNEL (`channelLastActivity`, the
   * projection in extensions/review-gate.ts). It used to be the newest mtime
   * among the child's transcript and log files; that reader was deleted with
   * lib/judge-session.ts (2026-09-06), and the channel is the better source
   * anyway — it is a record the child WROTE, not a file somebody touched.
   *
   * Absent ⇒ fall back to `spawnedAt`. Anything OLDER than `spawnedAt` is
   * ignored as well: not every watched source is per-run, so a stale stamp must
   * not be mistaken for this run's activity.
   */
  lastActivityAt?: string;
}

export type ChildWaitReason = "session-ended" | "silent-timeout";

export interface ChildWaitVerdict {
  /** Children that are demonstrably still working (fresh + alive). */
  inFlight: ChildSnapshot[];
  /** Children whose wait must END even though no signal arrived. */
  terminated: Array<{ child: ChildSnapshot; reason: ChildWaitReason }>;
}

/**
 * How long has this child been silent?
 *
 * ACTIVITY OLDER THAN THE SPAWN IS NOT ACTIVITY (round-6 P1, reviewer,
 * reproduced): the watched files are not all per-run — the inbox lives at
 * `<workDir>/inbox.jsonl` and survives a same-title respawn — so a stale mtime
 * from a PREVIOUS run would otherwise be read as this run's last sign of life.
 * A judge spawned seconds ago was declared silent-timeout on the spot.
 *
 * Clamping to `spawnedAt` is the honest reading: whatever happened before this
 * process existed says nothing about it. A missing or unparseable stamp falls
 * back to the spawn time the same way.
 */
function ageSec(child: ChildSnapshot, nowMs: number): number {
  const spawned = Date.parse(child.spawnedAt);
  const activity = child.lastActivityAt === undefined ? NaN : Date.parse(child.lastActivityAt);
  const usable = Number.isFinite(activity) && (!Number.isFinite(spawned) || activity > spawned)
    ? activity
    : spawned;
  if (!Number.isFinite(usable)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - usable) / 1000);
}

/**
 * Split the children into "still working" and "wait is over".
 *
 * An ended session is terminal immediately — there is nothing left to wait
 * for. A session still running but silent past the freshness bound is treated
 * the same way: it either finished without signalling (the measured case) or
 * hung, and both are resolved by reading its output rather than by waiting
 * longer.
 */
export function classifyChildren(
  children: readonly ChildSnapshot[],
  nowMs: number,
  maxSilenceSec: number = STALL_MOTION_MAX_AGE_SEC,
): ChildWaitVerdict {
  const inFlight: ChildSnapshot[] = [];
  const terminated: Array<{ child: ChildSnapshot; reason: ChildWaitReason }> = [];
  for (const child of children) {
    if (!child.alive) {
      terminated.push({ child, reason: "session-ended" });
      continue;
    }
    if (ageSec(child, nowMs) > maxSilenceSec) {
      terminated.push({ child, reason: "silent-timeout" });
      continue;
    }
    inFlight.push(child);
  }
  return { inFlight, terminated };
}

/**
 * The continuation text for a hosted wait.
 *
 * `undefined` means "no judge child is involved" — the caller falls through to
 * its normal handling. It NEVER means "return to idle": the liveness invariant
 * (the main session must keep driving while gates are unmet) is the caller's,
 * and this module only supplies the words for the child-related case.
 */
export function buildChildWaitNotice(
  verdict: ChildWaitVerdict,
  sessionIds: ReadonlyMap<string, string>,
): string | undefined {
  if (verdict.terminated.length === 0 && verdict.inFlight.length === 0) return undefined;

  const lines: string[] = [];
  if (verdict.terminated.length > 0) {
    lines.push(
      "子会话的等待已结束（未依赖它主动发信号）：",
      ...verdict.terminated.map(({ child, reason }) =>
        `- ${child.role} ${child.title}（session ${child.sessionId}）— ${
          reason === "session-ended"
            ? "pane 已消失"
            : "静默超过上限"
        }。若它的 report 已落盘，标准报告会送达并记入链；没有结论就修完重派（judge_recover 同 id 续接）。`,
      ),
    );
  }
  if (verdict.inFlight.length > 0) {
    lines.push(
      "以下子会话仍在工作：",
      ...verdict.inFlight.map((child) => {
        const label = sessionIds.get(child.sessionId);
        return `- ${child.role} ${child.title}（session ${child.sessionId}${label ? `, label ${label}` : ""}）`;
      }),
      WAIT_DISCIPLINE_HINT,
    );
  }
  return lines.join("\n");
}

