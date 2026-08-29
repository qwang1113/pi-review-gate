/**
 * Judge-child liveness arbitration — the main session never waits on a child's
 * good manners.
 *
 * THE MEASURED FAILURE (round-18, reproduced twice in one session). A judge
 * child finished its audit, printed the verdict fence — and never ran
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
 *   (b) the child's SESSION ended — its own `exit-code` file exists, or the
 *       process it recorded is no longer there (died, or its pid was recycled
 *       and now belongs to somebody else — lib/judge-session.ts). This is
 *       deliberately
 *       NOT a pane probe: the pane is a display shell that disappears with
 *       its child, and a judge that never got to write anything is exactly
 *       the case a pane could not report either;
 *   (c) the child has been silent past `STALL_MOTION_MAX_AGE_SEC` (a running
 *       session that stopped being evidence of motion).
 *
 * Any of them means: stop waiting, read what the child DID produce, and carry
 * on. Pure decision logic so every branch is testable without tmux.
 */

import { STALL_MOTION_MAX_AGE_SEC } from "./loop-stall.ts";

export interface ChildSnapshot {
  title: string;
  sessionId: string;
  role: string;
  /** ISO timestamp of the spawn. */
  spawnedAt: string;
  /**
   * Is the child's pi PROCESS still running? Decided from the live
   * ChildProcess's exitCode (judgeProcessAlive), not from any display: an
   * exited process is finished even if its artifacts were never written.
   */
  alive: boolean;
  /**
   * ISO timestamp of the child's last OBSERVED activity — in production the
   * newest write among its transcript, `stderr.log` and stdout log
   * (`lastActivityAt()` in lib/judge-session.ts).
   *
   * Absent ⇒ fall back to `spawnedAt`. Anything OLDER than `spawnedAt` is
   * ignored as well: not every watched file is per-run, so a stale mtime must
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
            ? "进程已退出"
            : "静默超过上限"
        }。用 review_read 读取它已产出的输出：有结论就据此继续（record_review / record_goal_prereview），没有结论就 review_close 后重新派发。`,
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
      "等待纪律：先做完可以做的确定性工作；确认没有可做的工作后，用 bash 托管等待——" +
        "在一次 bash 调用里同时盯三件事（进程是否已退出——`kill -0 <pid 文件第一段>`；",
      "以及它的 session jsonl 里是否已经出现 verdict fence），任一命中就结束等待并继续。" +
        "不要结束 turn 把唤醒责任交给子会话：它可能已经退出或永远不会发信号。",
    );
  }
  return lines.join("\n");
}
