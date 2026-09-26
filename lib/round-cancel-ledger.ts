/**
 * THE LAST CANCELLATION PER REPO+ROLE — so every surface that meets a round the
 * cancel matrix ended tells the same story (2026-09-27, t3).
 *
 * `cancelJudgeRound` (lib/round-cancel-host.ts) kills the pane AND drops the
 * registry row, and the row was the only thing the other surfaces could read.
 * Measured: a lane that failed on NO_CHECKS_RUN cancelled the reviewer while
 * its dispatch was still waiting for the boot handshake, so `judge_submit`
 * reported "pane %84 opened but never reported — pane and registration kept,
 * judge_wait it" (both false), and the `judge_wait` that followed said "no
 * judge on record — submit a round first" (as if nothing had ever run). The
 * tombstone is the one fact both now read.
 *
 * LIVE-ONLY, like the cancellation itself: nothing here survives a restart.
 */

export interface RoundCancellation {
  role: string;
  judgeId: string;
  why: string;
}

export interface RoundCancelLedger {
  note(root: string, c: RoundCancellation): void;
  /** By role (preferred) or by judge id — the same addressing judge_wait takes. */
  read(root: string, role: string | undefined, judgeId: string | undefined): RoundCancellation | undefined;
  /** A new dispatch of the role starts a new round: the old tombstone is history. */
  forget(root: string, role: string): void;
}

export function createRoundCancelLedger(): RoundCancelLedger {
  const byKey = new Map<string, RoundCancellation>();
  const key = (root: string, role: string) => `${root}\n${role}`;
  return {
    note: (root, c) => { byKey.set(key(root, c.role), c); },
    read: (root, role, judgeId) => {
      if (role !== undefined) return byKey.get(key(root, role));
      return [...byKey.entries()].find(([k, c]) => k.startsWith(`${root}\n`) && c.judgeId === judgeId)?.[1];
    },
    forget: (root, role) => { byKey.delete(key(root, role)); },
  };
}

/** The shared next step — the standard report's `cancelled` case says the same. */
export const CANCELLED_NEXT_STEP =
  "先处理取消原因（precommit 没过就先修 precommit；另一个 judge 判了非 READY 就按它的 findings 修），再用 judge_submit 重新派一轮。";

/**
 * WHAT A FAILED DISPATCH SAYS — the dispatch's whole failure copy, read against
 * the ledger. The caller `forget`s the role when the dispatch starts, so a
 * tombstone present here was written WHILE the pane was booting: a lane that
 * failed fast killed it and dropped its row, and "kept, wait on it" would be
 * false twice over.
 */
export function dispatchFailureDetail(
  ledger: RoundCancelLedger,
  root: string,
  role: string,
  opened: { deliveryFailed?: boolean | undefined; paneId?: string | undefined; error?: string | undefined },
): string | undefined {
  if (!opened.deliveryFailed) return opened.error;
  const cancelled = ledger.read(root, role, undefined);
  if (cancelled) return cancelledDuringBootText(opened.paneId, cancelled.why);
  return `review pane 开出来了（${opened.paneId}）但一直没在通道上报状态 —— ${opened.error}；` +
    "pane 与登记都保留着，可以先 judge_wait 看它有没有动静，确认没起来再用 fresh:true 重来。";
}

/**
 * `judge_submit`'s side: the pane came up, and the round was cancelled before
 * it reported in — so nothing is "kept", and there is nothing to wait on.
 */
export function cancelledDuringBootText(paneId: string | undefined, why: string): string {
  return (
    `review pane 开出来了（${paneId ?? "未知 pane"}），但它报到之前本轮就被门禁取消了 —— 原因：${why}\n` +
    `pane 与登记都已收回：不要 judge_wait / judge_recover 这一轮（没有可等、可重开的东西）。下一步：${CANCELLED_NEXT_STEP}`
  );
}
