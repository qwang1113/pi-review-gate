/**
 * `orchestrator_close` — the tool body that closes a child's window and
 * settles the isolated checkout it may have left behind.
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
import { closeSessionWindow, windowAlreadyGone } from "./session-factory.ts";
import {
  WORKTREE_SETTLEMENTS,
  repoRootOfWorktree,
  type WorktreeSettlement,
} from "./orchestrator-worktree.ts";
import { currentPlan } from "./orchestrator-tool-kit.ts";
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
    // Nothing else is owed: the pane is already gone and the registry already
    // says so. The caller gets the settlement and no close narrative.
    return reply(`review-gate: 子会话 ${child.id} 早已关闭 —— 本次只结算它的 worktree。` + settlementNote, { childId: child.id });
  }
  // THE LABEL BAR IS NOT TOUCHED HERE ANY MORE (2026-09-17, user decision).
  // This used to be the fourth of five close paths asking one shared
  // question ("is this the last decorated pane I can see"), and every answer
  // it could give toggled `pane-border-status` — which resizes EVERY pane in
  // the window (measured: SIGWINCH, rows 84 ↔ 83) and was measured to be
  // wrong across sessions besides. Under the window topology a child's bar
  // belongs to the child's own window and disappears with it.
  //
  // A child is closed by WINDOW, not by pane (2026-09-25), and only when the
  // registry can prove the window is one the gate owns: the target is written
  // `<tmuxSession>:<windowId>` from the SAME record, so a stale id can only
  // reach a window of the gate's own session.
  //
  // A RECORD WITH NO COORDINATES IS NOT A DEAD END (2026-09-25, quality round
  // P2). A row written by an older build has neither half — it cannot be
  // addressed at all — and the first version of this code FAILED the whole
  // close there, leaving the child `running` forever and contradicting the
  // sentence above it. It takes the same direction as the judge path: the
  // window is LEFT ALONE (nothing is killed by a guess), the registration is
  // cleared, and the reply says which of the two happened.
  let killNote: string | undefined;
  if (child.windowId && child.tmuxSession) {
    const killed = closeSessionWindow(deps.tmux, { ownSession: child.tmuxSession, windowId: child.windowId });
    if (!killed.ok && !windowAlreadyGone(killed.error)) {
      return fail(`review-gate: 关闭 window 失败 —— ${killed.error}`);
    }
    if (!killed.ok) killNote = "（它的 window 已经不在了）";
  } else {
    killNote = "（登记里没有 window/session 坐标 —— 旧版登记，只清登记，没去关窗）";
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
    `review-gate: 子会话 ${child.id}（window ${child.windowId ?? "（无记录）"}）已关闭${killNote ?? ""}` + statusNudge + settlementNote,
    { childId: child.id },
  );

}
