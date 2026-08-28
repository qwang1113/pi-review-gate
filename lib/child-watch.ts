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
 *   (b) the child's pane is dead (`#{pane_dead}` — remain-on-exit keeps the pane
 *       around precisely so this is observable);
 *   (c) the child has been silent past `STALL_MOTION_MAX_AGE_SEC` (a live pane
 *       that stopped being evidence of motion).
 *
 * Any of them means: stop waiting, read what the child DID produce, and carry
 * on. Pure decision logic so every branch is testable without tmux.
 */

import { STALL_MOTION_MAX_AGE_SEC } from "./loop-stall.ts";

/** What the extension knows about one judge child at decision time. */
export interface ChildSnapshot {
  title: string;
  paneId: string;
  role: string;
  /** ISO timestamp of the spawn. */
  spawnedAt: string;
  /** `#{pane_dead} === "0"` — false when the pane is dead OR unresolvable. */
  alive: boolean;
  /**
   * ISO timestamp of the child's last OBSERVED activity (finding stream write,
   * inbox append, pane output change). Absent ⇒ fall back to `spawnedAt`.
   */
  lastActivityAt?: string;
}

export type ChildWaitReason = "pane-dead" | "silent-timeout";

export interface ChildWaitVerdict {
  /** Children that are demonstrably still working (fresh + alive). */
  inFlight: ChildSnapshot[];
  /** Children whose wait must END even though no signal arrived. */
  terminated: Array<{ child: ChildSnapshot; reason: ChildWaitReason }>;
}

function ageSec(child: ChildSnapshot, nowMs: number): number {
  const stamp = Date.parse(child.lastActivityAt ?? child.spawnedAt);
  if (!Number.isFinite(stamp)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - stamp) / 1000);
}

/**
 * Split the children into "still working" and "wait is over".
 *
 * A dead pane is terminal immediately — there is nothing left to wait for. A
 * live pane that has been silent past the freshness bound is treated the same
 * way: it either finished without signalling (the measured case) or hung, and
 * both are resolved by reading its output rather than by waiting longer.
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
      terminated.push({ child, reason: "pane-dead" });
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
  doneChannels: ReadonlyMap<string, string>,
): string | undefined {
  if (verdict.terminated.length === 0 && verdict.inFlight.length === 0) return undefined;

  const lines: string[] = [];
  if (verdict.terminated.length > 0) {
    lines.push(
      "子会话的等待已结束（未依赖它主动发信号）：",
      ...verdict.terminated.map(({ child, reason }) =>
        `- ${child.role} ${child.title}（pane ${child.paneId}）— ${
          reason === "pane-dead"
            ? "pane 已退出/死亡"
            : "静默超过上限"
        }。用 review_read 读取它已产出的输出：有结论就据此继续（record_review / record_goal_prereview），没有结论就 review_close 后重新派发。`,
      ),
    );
  }
  if (verdict.inFlight.length > 0) {
    lines.push(
      "以下子会话仍在工作：",
      ...verdict.inFlight.map((child) => {
        const channel = doneChannels.get(child.paneId);
        return `- ${child.role} ${child.title}（pane ${child.paneId}${channel ? `, done channel ${channel}` : ""}）`;
      }),
      "等待纪律：先做完可以做的确定性工作；确认没有可做的工作后，用 bash 托管等待——" +
        "在一次 bash 调用里同时盯三件事（done channel 信号、`tmux display-message -p -t <pane> '#{pane_dead}'`、" +
        "以及 capture-pane 里是否已经出现 verdict fence），任一命中就结束等待并继续。" +
        "不要结束 turn 把唤醒责任交给子会话：它可能已经退出或永远不会发信号。",
    );
  }
  return lines.join("\n");
}
