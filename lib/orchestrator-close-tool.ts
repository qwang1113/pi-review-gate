/**
 * `orchestrator_close` — the tool body that SETTLES a child: it records the
 * child as closed (no longer supervised, no longer blocking `declare_done`)
 * and settles the isolated checkout it may have left behind.
 *
 * A FINISHED child's window is kept (2026-09-27, user decision): it stays on
 * screen for the user to read, and the orchestrator's own `declare_done` (or
 * process exit) reclaims it with the rest of its tmux session
 * (`closeOwnSession`). A child that has NOT finished is still a writer, so
 * closing it is an ABORT and its window is killed as before — un-supervising
 * a running writer and leaving it alive would be worse than either.
 * {@link closeKeepsWindow} is that one decision.
 *
 * Split from lib/orchestrator-session-tools.ts, which keeps the registration
 * of every orchestration session tool; the git half of a settlement lives in
 * lib/orchestrator-worktree.ts and is reached through `deps.settleWorktree`.
 */

import type { OrchestratorDeps, ToolReply } from "./orchestrator-deps.ts";
import {
  closableChild,
  markChildClosed,
  type OrchestratorRuntime,
} from "./orchestrator-registry.ts";
import {
  WORKTREE_SETTLEMENTS,
  repoRootOfWorktree,
  type WorktreeSettlement,
} from "./orchestrator-worktree.ts";
import { childChannelProjection, currentPlan } from "./orchestrator-tool-kit.ts";
import { closeSessionWindow, windowAlreadyGone } from "./session-factory.ts";

/**
 * Does closing this child SETTLE it (keep the window) or ABORT it (kill it)?
 *
 * Only a child whose own last report says it stopped — `done` or `idle` — is
 * finished. Anything else (working, waiting on a question or a judge, no
 * report at all) may still be writing, so the close stops it.
 */
export function closeKeepsWindow(lastReportedState: string | undefined): boolean {
  return lastReportedState === "done" || lastReportedState === "idle";
}
import { toolFail as fail, toolReply as reply } from "./tool-host.ts";

/**
 * Forget a worktree that has been dealt with.
 *
 * A REPEAT of the same settlement must not re-run it: the second `discard`
 * would remove a checkout that is already gone and report the failure as
 * 「没能回收」（round-7 Nit）—— for work that was cleaned up correctly the first
 * time. Clearing the record is what makes the settlement idempotent.
 *
 * The field is REMOVED, not set to `undefined`: the registry sanitizes its
 * children and deep-equality matters there.
 */
function forgetWorktree(runtime: OrchestratorRuntime, childId: string): OrchestratorRuntime {
  return {
    ...runtime,
    children: runtime.children.map((c) => {
      if (c.id !== childId) return c;
      const { worktree: _settled, ...rest } = c;
      return rest as typeof c;
    }),
  };
}

export async function doClose(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const runtime = deps.runtime();
  const childId = String(params.childId ?? "").trim();

  const closable = closableChild(runtime, childId);
  // A CLOSED CHILD CAN STILL OWE A CHECKOUT (round-7 P1). A merge is staged,
  // not committed, so it deliberately leaves the worktree in place and the
  // receipt tells the manager to reclaim it afterwards — and refusing that
  // call is what made the advice a dead end: `closableChild` rejects anything
  // with a `closedAt`, which every child that went through this function has.
  //
  // So a settlement-only call is allowed for a child that is ALREADY closed:
  // nothing is killed (there is no pane), nothing is registered, and the
  // worktree decision is the one thing that was still owed.
  const known = runtime.children.find((c) => c.id === childId);
  const settlementOnly =
    !closable.ok && known !== undefined && known.closedAt !== undefined &&
    known.worktree !== undefined && params.worktree !== undefined;
  if (!closable.ok && !settlementOnly) return fail("review-gate: " + closable.reason);
  const child = closable.ok ? closable.child : known!;
  // THE WORKTREE'S FATE IS THE MANAGER'S CALL, AND IT IS MADE HERE (2026-09-10).
  // A child that ran in its own checkout leaves that checkout behind, and a
  // manager who has to hand-write the merge is a manager the gate failed
  // (philosophy one). `keep` is the DEFAULT because the work in a worktree is
  // often the only copy, and a default that deletes is a default that
  // eventually deletes something wanted.
  const rawSettlement = String(params.worktree ?? "keep").trim();
  let settlementNote = "";
  if (child.worktree) {
    if (!(WORKTREE_SETTLEMENTS as readonly string[]).includes(rawSettlement)) {
      return fail(`review-gate: worktree 参数不认识："${rawSettlement}"（可选 ${WORKTREE_SETTLEMENTS.join(" / ")}）。`);
    }
    const worktreeRepo = repoRootOfWorktree(child.worktree.path, child.id);
    if (!worktreeRepo) {
      return fail(
        `review-gate: 推不出这个 worktree 属于哪个 repo（${child.worktree.path}）—— 门禁不动它，避免把某人的成果合进错的 checkout。` +
        "请人工处理后再 close。",
      );
    }
    const settled = deps.settleWorktree?.({
      childId: child.id,
      taskId: child.taskId,
      repoRoot: worktreeRepo,
      worktreePath: child.worktree.path,
      settlement: rawSettlement as WorktreeSettlement,
    });
    if (!settled) return fail("review-gate: 这个会话没有接上 git 能力，无法结算它的 worktree —— 门禁拒绝在没看清现状时关掉它。");
    if (!settled.ok) return fail("review-gate: " + settled.text);
    settlementNote = "\n" + settled.text;
    // …and it is FORGOTTEN only when the checkout is actually GONE (round-8
    // Nit, tightened in round 9). `keep` leaves it by definition and `merge`
    // leaves it on purpose, so clearing the record there would STRAND it: no
    // later close could see a worktree to settle. And a discard whose removal
    // FAILED (`reclaimed: false` — the directory is still there) must keep the
    // record too, or the retry this failure deserves becomes impossible.
    if (rawSettlement === "discard" && settled.reclaimed !== false) {
      deps.saveRuntime(forgetWorktree(deps.runtime(), child.id));
    }
  }
  if (settlementOnly) {
    // Nothing else is owed: the child was already settled and the registry already
    // says so. The caller gets the settlement and no close narrative.
    return reply(`review-gate: 子会话 ${child.id} 早已结算 —— 本次只结算它的 worktree。` + settlementNote, { childId: child.id });
  }
  // `closedAt` is what every "is this child still open" reading keys on —
  // supervision, the `declare_done` live-children check, the exit-time
  // `openChildren` count. A FINISHED child's window is left for `declare_done`
  // (2026-09-27); an unfinished one is aborted by killing it, addressed as
  // `<tmuxSession>:<windowId>` from the record so a stale id can only reach a
  // window of the gate's own session. A row with no coordinates (older build)
  // is never killed by a guess.
  const keep = closeKeepsWindow(childChannelProjection(deps, child.id).lastState?.state);
  let windowNote: string;
  if (keep) {
    windowNote = `它的 window ${child.windowId ?? "（无记录）"} 保留在屏幕上，由你的 declare_done 统一回收`;
  } else if (child.windowId && child.tmuxSession) {
    const killed = closeSessionWindow(deps.tmux, { ownSession: child.tmuxSession, windowId: child.windowId });
    if (!killed.ok && !windowAlreadyGone(killed.error)) {
      return fail(`review-gate: 子会话还没报完成，关闭就是中止它 —— 但关 window 失败：${killed.error}`);
    }
    windowNote = `它还没报完成，关闭即中止：window ${child.windowId} ${killed.ok ? "已关掉" : "已经不在了"}`;
  } else {
    windowNote = "登记里没有 window/session 坐标（旧版登记）—— 没去关窗";
  }
  deps.saveRuntime(markChildClosed(deps.runtime(), child.id, new Date(deps.now()).toISOString()));
  // O-2 — only remind about the task status when it still NEEDS moving. The
  // orchestrator usually sets the task `done` before closing; repeating the
  // reminder for a task that is already terminal is exactly the "make the
  // agent remember what the gate already knows" noise we avoid. `running` and
  // `blocked` are the two states a closed child leaves stranded; a missing
  // plan falls through to the reminder (fail-safe: better a redundant nudge
  // than a silently stranded task).
  const closedTask = currentPlan(deps).plan?.tasks.find((t) => t.id === child.taskId);
  const needsStatusNudge = !closedTask || closedTask.status === "running" || closedTask.status === "blocked";
  const statusNudge = needsStatusNudge
    ? "。别忘了把它的任务状态置为 done 或 pending（`orchestrator_plan`）。"
    : `。任务 ${child.taskId} 当前是 ${closedTask.status}，无需再动。`;
  return reply(
    `review-gate: 子会话 ${child.id} 已结算（不再监督、不再阻挡 declare_done）；` + windowNote +
      statusNudge + settlementNote,
    { childId: child.id },
  );

}
