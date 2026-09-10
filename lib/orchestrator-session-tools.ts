/**
 * The SESSION LIFECYCLE tools — what a child is doing, and when it ends:
 * wait, close, relay. Plus the registration of all seven session tools.
 *
 * The DISPATCH half — spawn and send, i.e. getting work INTO a child — lives
 * in lib/orchestrator-dispatch.ts. The two were one file until this round's
 * delivery-verification work pushed it past the 600-line standard the
 * repository holds itself to, and the split follows a real seam: dispatch
 * answers "did the other side actually receive this" (F1/F7/F8/F11), while
 * this half answers "what is it doing now, and is it still alive"
 * (F12/F14).
 *
 * The invariant both halves share: the orchestrator expresses INTENT and the
 * gate performs the ACT. It names a task, not a split direction; a child, not
 * a pane id; "wait", not a polling loop. Every tmux argv is built by
 * lib/orchestrator-tmux.ts, every pane it may touch is one the registry
 * created, and the blast radius is one window.
 *
 * Read this alongside lib/orchestrator-tools.ts (plan / status / notify),
 * which is the half that never leaves the sidecar.

 */

import { Type } from "typebox";
import { pollUntil, type PollWaitResult } from "./poll-wait.ts";
import { ORCHESTRATOR_WAIT_DISCIPLINE } from "./agent-directives.ts";

import { GATE_MODE_ENV } from "./task-mode.ts";
import type { OrchestratorDeps, ToolHost, ToolReply } from "./orchestrator-deps.ts";

/**
 * The orchestration deps plus ONE thing lib/orchestrator-deps.ts has no reason
 * to know about: how many JUDGE panes this session has decorated.
 *
 * It exists for a single decision — may this close take the window's shared
 * label bar down (`releasesWindowLabels`)? A project manager's window holds
 * both kinds of decorated pane, and counting only one kind is how the release
 * went wrong twice: it blanked a running review's border, or it left the bar
 * switched on forever. OPTIONAL, so a deps object that predates this (a test
 * fixture, another caller) simply reports no judge panes.
 */
export interface OrchestratorSessionDeps extends OrchestratorDeps {
  decoratedJudgePanes?(): number;
}
import {
  closeSessionPane,
  countDecoratedPanes,
  openSessionPane,
  releasesWindowLabels,
} from "./session-factory.ts";

import { spawnAuthorization } from "./orchestrator-gate.ts";
import {
  WORKTREE_SETTLEMENTS,
  repoRootOfWorktree,
  type WorktreeSettlement,
} from "./orchestrator-worktree.ts";
import {
  closableChild,
  findChild,
  markChildClosed,
} from "./orchestrator-registry.ts";
import {
  formatInheritanceBrief,
  predecessorCloseAuthorization,
  readInheritance,
  relayPreconditions,
  successorEnv,
} from "./orchestrator-relay.ts";
import { orchestratorDoneProblems } from "./orchestrator-gate.ts";
import {
  buildWaitReceipt,
  clampChildWaitTimeout,
  evaluateChildWait,
  type ChildWaitDecision,
  type ChildWaitObservation,
} from "./orchestrator-wait.ts";
import {
  decideSupervisionEvents,
  reportedDoneIds,
  superviseChildren,
  type SupervisionSnapshot,
} from "./orchestrator-supervisor.ts";
import { dispatchInstruct, dispatchSpawn } from "./orchestrator-dispatch.ts";
import { registerOrchestratorAnswerTool } from "./orchestrator-answer-tools.ts";
import { registerOrchestratorRecoveryTools } from "./orchestrator-recovery-tools.ts";
// Short local aliases; see the note in lib/orchestrator-tools.ts.
import {
  alivePanes,
  childAssets,
  currentPlan,
  refreshPaneLabels,
  toolFail as fail,
  toolReply as reply,
  requireOrchestratorMode,
} from "./orchestrator-tool-kit.ts";


/**
 * The `timeoutMs: 0` snapshot, expressed as the waiting skeleton's own result:
 * a wait that did not wait. Nothing is invented — `done` is the SAME criterion
 * the blocking path polls on, so the two branches cannot drift apart.
 */
function snapshotResult(observation: ChildWaitObservation): PollWaitResult<ChildWaitObservation> {
  return {
    observation,
    done: evaluateChildWait(observation).done,
    aborted: false,
    stalledInProbe: false,
    waitedMs: 0,
  };
}


/**
 * WAIT — the orchestrator's ONE information channel, and the only call it
 * makes every round.
 *
 * ── WHAT IT USED TO BE, AND WHY THAT FAILED (R-16, R-4, R3-5) ──
 *
 * It consumed events from a global queue, re-checked their addressing in
 * code, then decided from an UNPARSED SCREEN whether the question behind an
 * event was still open. Measured: two children sat in front of dialogs
 * nobody was coming to answer while the orchestrator's token count did not
 * move for 17 minutes, and an external Escape was the only way out. The
 * receipt could not even say WHICH child was calling.
 *
 * ── WHAT IT IS NOW ──
 *
 * Three things, and none of them touches a rendered line:
 *
 *  1. THE GATE LOOKS FOR ITSELF. Every poll re-reads every child's channel
 *     (lib/orchestrator-supervisor.ts), so `waiting-input`, `done`, `idle`,
 *     `stalled` and `dead` produce events even when no child ever rang — and
 *     an unanswered question rings AGAIN on the 10s→30s→60s backoff.
 *  2. NOTHING IS SWALLOWED, because nothing has to be filtered: each child's
 *     traffic is its own file. There is no foreign event to drop and no
 *     ownership to re-derive.
 *  3. THE BUDGET IS INDEPENDENT (lib/poll-wait.ts): the loop races every
 *     await against its own timer, so a probe that never returns cannot hold
 *     the call.
 *
 * ── `timeoutMs: 0` IS THE OLD `orchestrator_status` ──
 *
 * Snapshot and blocking wait were two tools answering the same question, and
 * an agent had to choose between them (philosophy two: that is a design
 * failure). They are one tool now; blocking is a parameter. The reply is
 * IDENTICAL either way — the four-block receipt — so nothing an orchestrator
 * needs is reachable only from one of them.
 */
async function doWait(
  deps: OrchestratorDeps,
  params: Record<string, unknown>,
  signal: { readonly aborted: boolean } | undefined,
): Promise<ToolReply> {
  const childId = String(params.childId ?? "").trim();
  const budgetMs = clampChildWaitTimeout(params.timeoutMs);

  // Waiting on NOTHING is a mistake, not an end state: without this the
  // "no live pane" observation below would report `pane-gone` and the
  // orchestrator would be told a child died when it never opened one. A
  // SNAPSHOT of an empty orchestration is legitimate, though — that is how a
  // successor looks around before it spawns anything.
  const openChildren = deps.runtime().children.filter((c) => !c.closedAt);
  if (openChildren.length === 0 && budgetMs > 0) {
    return fail(
      "review-gate: 没有可等的子会话 —— 先用 `orchestrator_spawn` 开一个，" +
      "或者用 `orchestrator_wait({ timeoutMs: 0 })` 看一眼现状。",
      { done: false, reason: "no-children" },
    );
  }
  if (childId && !findChild(deps.runtime(), childId)) {
    return fail(`review-gate: 没有登记过子会话 "${childId}"。`, { done: false, reason: "no-such-child" });
  }

  let snapshot: SupervisionSnapshot | undefined;
  // The pane reading THIS receipt is built from. Block 5 used to take its own,
  // a second `list-panes` at a different instant than the probe's, so the two
  // halves of one receipt could describe two different moments (B4).
  let panesRead: { panes: string[]; ok: boolean } | undefined;

  const probe = (): ChildWaitObservation => {
    const runtime = deps.runtime();
    const panes = alivePanes(deps);
    panesRead = panes;
    const open = runtime.children.filter((c) => !c.closedAt);
    snapshot = superviseChildren({
      orchestrationId: runtime.orchestrationId,
      children: open,
      livePanes: panes.ok ? new Set(panes.panes) : undefined,
      io: deps.channelIO(),
      ...(deps.channelHome() === undefined ? {} : { home: deps.channelHome()! }),
      at: deps.now(),
      assetsFor: (child) => childAssets(deps, child),
    });
    // The border labels are repainted from the health that was just measured
    // — the probe is already here, so the screen never lags the receipt.
    refreshPaneLabels(deps, snapshot);


    // The event rules carry a memory across polls, and it lives in the
    // sidecar rather than in this closure: a wait that rebuilt it would see
    // every state as "changed" and re-ring the same question forever.
    const decided = decideSupervisionEvents(snapshot, deps.supervisionMemory(), deps.now());
    deps.saveSupervisionMemory(decided.memory);
    // A wait scoped to ONE child reports only that child's events; its
    // siblings' stay in the memory as un-reported and ring on the next call.
    const events = childId ? decided.events.filter((e) => e.childId === childId) : decided.events;
    if (events.length > 0) return { events, paneAlive: true };

    // F14 — an unreadable pane list is UNKNOWN liveness, never a death.
    if (!panes.ok) return { paneAlive: false, livenessUnknown: true };

    if (!childId) {
      const live = open.filter((c) => panes.panes.includes(c.paneId));
      return {
        paneAlive: live.length > 0,
        note: `${live.length} 个子会话在跑`,
      };
    }
    const child = findChild(runtime, childId)!;
    return {
      paneAlive: !child.closedAt && panes.panes.includes(child.paneId),
      note: `子会话 ${child.id} 仍在 pane ${child.paneId}`,
    };
  };

  // Typed as the skeleton's own result on BOTH branches: the snapshot path is
  // "a wait that did not wait", not a different shape — so every field the
  // reply reads (`abortReason` included) exists on it too.
  const waited: PollWaitResult<ChildWaitObservation> = budgetMs === 0
    ? snapshotResult(probe())
    : await pollUntil({
        probe,
        isDone: (observation) => evaluateChildWait(observation).done,
        budgetMs,
        signal,
      });
  const observation = waited.observation;
  const decision: ChildWaitDecision = observation
    ? evaluateChildWait(observation)
    : { done: false, reason: "pending", summary: "本次预算内一次探针都没跑完" };
  const receipt = buildWaitReceipt({
    snapshot: snapshot ?? emptySnapshot(),
    decision,
    ...(deps.contextPercent() === undefined ? {} : { contextPercent: deps.contextPercent()! }),
    exitBlockers: exitBlockers(deps, snapshot, panesRead),
    ...(inheritanceBrief(deps) === undefined ? {} : { inheritance: inheritanceBrief(deps)! }),
    waitedMs: waited.waitedMs,
  });
  const details = {
    reason: decision.reason,
    waitedMs: waited.waitedMs,
    done: decision.done,
    handoffUrgency: receipt.advice.urgency,
    openRequests: (snapshot?.requests ?? []).length,
    health: snapshot?.health ?? [],
    ...(decision.childId ? { childId: decision.childId } : {}),
  };

  // F14 — every path below RETURNS, and every one of them carries the SAME
  // four-block receipt. An abort is reported as an abort and a spent budget
  // as a spent budget; neither is an error, and neither leaves the caller
  // without a next step.
  if (waited.aborted) {
    const waitedSeconds = Math.round(waited.waitedMs / 1000);
    // TWO interrupts, and the difference matters to whoever reads this. ESC is
    // the host cancelling the call. A user message is somebody TALKING TO YOU
    // — but WHEN it lands depends on how it was sent, and the receipt must not
    // paper over that: a `steer` (plain Enter, the default) cuts into this very
    // turn, so simply carrying on with the work reads it; a `followUp`
    // (Alt+Enter) is delivered only once the turn ENDS, and a manager that
    // dives straight back into a 900s wait shuts that one out a second time —
    // the original defect wearing a different hat (round-2 P2).
    //
    // AND IT MUST NOT CONTRADICT THE STANDING DISCIPLINE (round-3 P2). The
    // wait discipline forbids ENDING THE TURN AS A WAY OF WAITING — handing
    // the watch back to the user and hoping to be woken. Letting a message
    // that is ALREADY QUEUED through is the opposite of that: nobody is being
    // asked to watch anything, the turn boundary is a doorway rather than a
    // parking spot, and the manager resumes immediately. The receipt says so
    // in as many words, because the two would otherwise read as opposites at
    // the very same decision point.
    if (waited.abortReason === "user-input") {
      return reply(
        `review-gate: 等待被外部消息打断（已等 ${waitedSeconds}s）—— ` +
        "有人正在跟本会话说话，消息已经在宿主队列里。回车发的 steer 会切进你当前这一轮：" +
        "照常继续干活就会读到它。Alt+Enter 发的 followUp 要等这一轮 turn 结束才送达 —— " +
        "只有这一种情况别再一头扎回长阻塞，先把手上这一轮收掉让它进来。" +
        "（这不违反等待纪律②：那条禁的是「用结束 turn 代替等待、把盯梢责任丢回用户」；" +
        "这里消息已经在队列里，turn 边界只是它进来的门，你随即继续盯。）" +
        "子会话还在跑，没有任何东西被取消。\n\n" + receipt.text,
        { ...details, done: false, reason: "aborted", abortedBy: "user-input" },
      );
    }
    return reply(
      `review-gate: 等待被中断（已等 ${waitedSeconds}s）—— ` +
      "子会话还在跑，没有任何东西被取消。\n\n" + receipt.text,
      { ...details, done: false, reason: "aborted", abortedBy: "signal" },
    );
  }
  if (!decision.done && budgetMs > 0) {
    const stalled = waited.stalledInProbe
      ? "（注意：预算用完时探针一次都没返回 —— tmux 很可能卡住了，先自己看一眼 pane）"
      : "";
    return reply(
      `review-gate: 本次预算用完。${stalled}\n${ORCHESTRATOR_WAIT_DISCIPLINE}\n\n` + receipt.text,

      details,
    );
  }
  return reply(`review-gate: ${receipt.text}`, details);
}

/** The receipt still renders when supervision never ran (an empty snapshot). */
function emptySnapshot(): SupervisionSnapshot {
  return { children: [], health: [], requests: [], troubled: [], malformed: 0 };
}

/**
 * What still stands between this orchestration and `declare_done`.
 *
 * This is block 5 of the receipt, and it is the whole of what
 * `orchestrator_status` used to be for. A separate tool for it was a
 * philosophy-two failure twice over: the orchestrator had to choose between
 * two overlapping readouts, and — worse — "am I allowed to finish yet" is a
 * question it only thinks to ask once it already believes it is finished.
 * Pushing it into the call that happens every round means it is answered
 * before that belief forms.
 *
 * IT READS THE SAME SNAPSHOT BLOCK 1 DOES (B4). Completion is a channel fact,
 * and this block used to answer it from a registry field nothing wrote — so
 * one receipt could report a child as finished at the top and as "still
 * alive, go wait for it" at the bottom, and the manager had to arbitrate
 * between its own gate's two answers. The snapshot (and the pane reading it
 * was built from) is passed in for the same reason: two readings taken at two
 * instants are two different moments in one receipt.
 */
function exitBlockers(
  deps: OrchestratorDeps,
  snapshot: SupervisionSnapshot | undefined,
  panesRead: { panes: string[]; ok: boolean } | undefined,
): string[] {
  const { plan } = currentPlan(deps);
  const panes = panesRead ?? alivePanes(deps);
  const reportedDone = snapshot ? reportedDoneIds(snapshot) : [];
  return orchestratorDoneProblems({
    ...(plan ? { plan } : {}),
    runtime: deps.runtime(),
    alivePaneIds: panes.panes,
    ...(reportedDone.length > 0 ? { reportedDone } : {}),
    ...(panes.ok ? {} : { livenessUnknown: true }),
  });
}

/** What a handoff gave this session, when it is a successor. */
function inheritanceBrief(deps: OrchestratorDeps): string | undefined {
  const brief = formatInheritanceBrief(readInheritance(deps.env()), deps.runtime().orchestrationId);
  return brief && brief.length > 0 ? brief : undefined;
}



async function doClose(deps: OrchestratorSessionDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const runtime = deps.runtime();
  const childId = String(params.childId ?? "").trim();
  const predecessorPane = String(params.predecessorPane ?? "").trim();

  // CONSTRAINT 12 — the relay's closing move. Only a SUCCESSOR may close the
  // orchestrator it replaced, and its own environment is what says so.
  if (predecessorPane) {
    const auth = predecessorCloseAuthorization(predecessorPane, deps.env());
    if (!auth.ok) return fail("review-gate: " + auth.reason);
    const killed = closeSessionPane(deps.tmux, predecessorPane);
    if (!killed.ok) return fail(`review-gate: 关闭前任 pane 失败 —— ${killed.error}`);
    return reply(
      `review-gate: 前任项目经理 pane ${predecessorPane} 已关闭，接力完成 —— 你现在是这个 orchestration 的持有者。`,
      { closed: predecessorPane },
    );
  }

  const closable = closableChild(runtime, childId);
  if (!closable.ok) return fail("review-gate: " + closable.reason);
  const child = closable.child;
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
  }
  // THE SAME JUDGEMENT THE OTHER THREE CLOSE PATHS MAKE (reviewer P2,
  // 2026-09-05 — "the answer to (c) is: unify them"). This one used to have
  // its own rule (`isLastDecoratedChild`), and it carried both defects the
  // others had already shed:
  //
  //  - it counted registry ROWS, so a child whose pane the user closed by hand
  //    kept the bar up forever;
  //  - it could not see JUDGE panes at all, so closing the last child while a
  //    review was open blanked the review's border.
  //
  // Both are now one question — how many decorated panes can I still see —
  // asked with the shared counter. `insideOrchestration` is false by
  // construction: only a project manager reaches this tool (the mode guard),
  // and a manager is never a guest in its own window.
  //
  // Addressed through the ORCHESTRATOR'S OWN pane when it can read it, else
  // the child's: `setw -t <pane>` only names a window, and the pane being
  // closed is the id that may already be gone — but the release itself must
  // not become conditional on a diagnostic.
  const panes = alivePanes(deps);
  const releasesLabels = releasesWindowLabels({
    remainingDecoratedPanes:
      countDecoratedPanes(
        runtime.children
          .filter((c) => c.id !== child.id && !c.closedAt)
          .map((c) => c.paneId),
        panes.ok ? panes.panes : undefined,
      )
      + (deps.decoratedJudgePanes?.() ?? 0),
    insideOrchestration: false,
  });
  const labelsVia = deps.ownPane() ?? child.paneId;
  const killed = closeSessionPane(deps.tmux, child.paneId, {
    ...(releasesLabels ? { hideLabelsVia: labelsVia } : {}),
  });
  if (!killed.ok && !/can't find pane|no such pane/i.test(killed.error)) {
    return fail(`review-gate: 关闭 pane 失败 —— ${killed.error}`);
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
    `review-gate: 子会话 ${child.id}（pane ${child.paneId}）已关闭` + statusNudge + settlementNote,
    { childId: child.id },
  );

}

async function doHandoff(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const runtime = deps.runtime();
  const { plan } = currentPlan(deps);
  const handoffPath = String(params.handoffPath ?? "").trim();
  const self = deps.ownPane();
  const panes = alivePanes(deps);

  const problems = relayPreconditions({
    planApproved: Boolean(plan && runtime.approvedPlanHash && spawnAuthorization(runtime, plan).ok),
    handoffPath: handoffPath || undefined,
    handoffChars: handoffPath ? deps.fileChars(handoffPath) : undefined,
    ownPane: self,
    liveChildCount: panes.panes.length,
  });
  if (problems.length) {
    return fail(
      "review-gate: 还不能接力：\n" + problems.map((p) => `  - ${p}`).join("\n"),
      { problems },
    );
  }

  // RETIRE THE PREDECESSOR FIRST, and the ORDER is the fix (2026-09-10,
  // rebate handoff failure). The successor arms its gate in this SAME
  // worktree, and the exclusivity guard refuses a second claimant while the
  // holder's heartbeat is fresh (lib/session-exclusivity.ts). Retiring after
  // the pane opens would race the successor's boot and lose: it was measured
  // refusing itself with "这个 worktree 已被另一个会话占用", naming the very
  // session that had just handed the orchestration over.
  //
  // This is phase ONE (release the claim). Phase TWO (go silent) is owed
  // AFTER the relay record is persisted, and the reason is in
  // HandoffRetirement: `persist()` refuses to write for a retired session, so
  // marking earlier would make the successor's own registry row memory-only.
  //
  // A handoff that never happens must change NOTHING: `rolledBack` is called
  // when the pane could not be opened, and phase two never ran.
  const retirement = deps.onHandoff?.();
  // The successor's proof of heirship (lib/session-exclusivity.ts): named, it
  // may take this worktree's claim over from the session it replaces.
  const predecessorSessionId = deps.ownSessionId?.();

  // The successor is opened by the SAME factory as every other pi session —
  // it just lands BESIDE the opener instead of in the child column (tmux then
  // expands it into the left column when the old pane is closed), keeps no
  // registry row and takes no border: it is not a child, it is the next holder
  // of this orchestration.
  //
  // THE OPEN IS WRAPPED, and it is not decoration: phase one has ALREADY
  // released this session's worktree claim, so an exception escaping
  // `openSessionPane` (a tmux runner that throws rather than returning
  // `ok:false`, which the injected seam permits) would leave the claim
  // released, the relay record unwritten and the session otherwise untouched —
  // a half-retired predecessor nobody would notice. Every exit from this block
  // either commits the relay record or undoes phase one.
  let opened: Awaited<ReturnType<typeof openSessionPane>>;
  try {
    opened = await openSessionPane(deps.tmux, {
      ownPane: self!,
      cwd: deps.repoRoot,
      layout: "beside-opener",
      // A plain interactive pi: the successor reads the handoff document its
      // environment points at, so it needs no argv message of its own.
      command: ["pi"],
      role: {
        kind: "successor",
        env: {
          ...successorEnv({
            orchestrationId: runtime.orchestrationId,
            predecessorPane: self!,
            handoffPath,
            predecessorTranscript: deps.sessionTranscriptPath(),
            ...(predecessorSessionId ? { predecessorSessionId } : {}),
          }),
          [GATE_MODE_ENV]: "orchestrator",
        },
      },
    });
  } catch (error) {
    retirement?.rolledBack();
    return fail(
      `review-gate: 开接任会话时出错 —— ${(error as Error).message}（接力中止，你仍然是持有者）。`,
    );
  }
  if (!opened.ok) {
    // Undo phase one: the orchestration still has exactly one holder, and it
    // is this session. Phase two never ran, so nothing else needs undoing.
    retirement?.rolledBack();
    return fail(`review-gate: 开接任会话失败 —— ${opened.error}（接力中止，你仍然是持有者）。`);
  }
  const paneId = opened.paneId;


  // The relay record FIRST, then the silence: `saveRuntime` goes through
  // `persist()`, which refuses to write for a retired session. Persisting
  // afterwards would leave the successor's own registry row — who took over,
  // from whom — memory-only.
  deps.saveRuntime({
    ...deps.runtime(),
    relay: { handoffPath, successorPane: paneId, at: new Date(deps.now()).toISOString() },
  });
  retirement?.committed();
  return reply(
    `review-gate: 接任的项目经理已在 pane ${paneId} 启动，继承同一个 orchestration id ` +
    `(${runtime.orchestrationId})，子会话的通知会自动流向它，无需重启任何子会话。\n` +
    "**接下来你进入 idle：不要再动手**。等它读完交接文档确认接手后，由**它**来关掉你这个 pane" +
    "（只有新会话能关老会话 —— 这天然证明接手成功，中间不断档）。",
    { successorPane: paneId, handoffPath },
  );
}

/**
 * Register the eight orchestration session tools.
 *
 * Six live in this file (spawn / instruct / wait / close / handoff) and two
 * are delegated to their own modules (`orchestrator_answer`,
 * `orchestrator_recover` + `orchestrator_attach`) — registered from here so
 * there is ONE place that answers "which orchestration tools exist".
 */
export function registerOrchestratorSessionTools(host: ToolHost, deps: OrchestratorSessionDeps): void {
  const guarded = (
    run: (params: Record<string, unknown>, signal: { readonly aborted: boolean } | undefined) => Promise<ToolReply>,
  ) => async (
    _id: string,
    params: Record<string, unknown>,
    signal: { readonly aborted: boolean } | undefined,
  ): Promise<ToolReply> => {
    const refusal = requireOrchestratorMode(deps);
    if (refusal) return refusal;
    return run(params, signal);
  };

  registerOrchestratorAnswerTool(host, deps);
  registerOrchestratorRecoveryTools(host, deps);


  host.registerTool({
    name: "orchestrator_spawn",
    label: "Spawn Child Session",
    description:
      "Open an interactive CHILD SESSION for one plan task, in a pane of THIS window. The gate " +
      "picks the pane from the WINDOW's own layout (three columns: the first two hold one session " +
      "each, the third shares its height), injects the orchestration id " +
      "so the child's wake-ups survive a relay, starts it in loop mode in the repo its task " +
      "declares (same-repo children are serialized by the gate; only different repos run " +
      "in parallel), and registers the pane — a pane nobody " +
      "registered cannot be addressed later. Requires a plan the USER approved.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Plan task id this child will work on" }),
      task: Type.Optional(Type.String({ description: "Opening message sent to the child right away" })),
    }),
    execute: guarded((params) => dispatchSpawn(deps, params)),
  });

  host.registerTool({
    name: "orchestrator_instruct",
    label: "Instruct A Child Session",
    description:
      "Say something to a running child session, or stop it. `mode` IS pi's own delivery, and it " +
      "DEFAULTS to `interrupt` — a supervisor writes because the child should know NOW, so the " +
      "ordinary call aborts the turn it is in the middle of and the message is read immediately " +
      "(an interrupt carries its text in this same call). The one alternative is `steer`: it cuts " +
      "into the current turn WITHOUT aborting it, for a nudge the child should carry on with. " +
      "`followUp` (\"finish first, then read this\") is REFUSED here — a correction that arrives " +
      "after the round it was meant to correct is a correction nobody applied. Nothing is typed at " +
      "a terminal: the text is written to the child's channel and the child's OWN gate injects it " +
      "with `pi.sendUserMessage`, so it cannot be truncated, cannot be split by a newline, and " +
      "cannot be misread by an open dialog as a menu selection (all four were measured). The " +
      "receipt is EARNED — this fails unless the child acknowledges that it injected the message. " +
      "To ANSWER a question the child is waiting on, use `orchestrator_answer`, not this.",
    parameters: Type.Object({
      childId: Type.String(),
      mode: Type.Optional(Type.String({
        description: "\"interrupt\" (default) | \"steer\". \"followUp\" is refused.",
      })),
      message: Type.Optional(Type.String({ description: "The text to deliver. Required for every mode (interrupt included) — say what the child should do instead." })),
    }),
    execute: guarded((params) => dispatchInstruct(deps, params)),
  });


  host.registerTool({
    name: "orchestrator_wait",
    label: "Wait For A Child Session",
    description:
      "The orchestrator's ONE information channel — call it every round instead of ending your " +
      "turn. It blocks until something happens to a child of THIS orchestration, and the gate " +
      "looks for itself rather than only listening: every poll re-reads each child's channel, so " +
      "a child that raised a question (waiting-input), one that FINISHED (done), one that quietly " +
      "STOPPED (idle), one that went silent while its pane lives (stalled) and one whose pane " +
      "vanished (dead) each produce an event even when nothing rang. An unanswered question rings " +
      "again on a 10s→30s→60s backoff; a completion rings twice, 60s apart, then stays quiet. " +
      "EVERY reply — blocked, interrupted or instant — carries the same four blocks: (1) the " +
      "health of every child, (2) the questions waiting for you, with their full text and every " +
      "option, structured (nothing is read off a screen), (3) dead / stalled children with the " +
      "assets that survived them and the action that recovers each, and (4) YOUR OWN context " +
      "usage with the handover call, computed by the gate — you never look that up yourself. " +
      "Pass `timeoutMs: 0` for an instant snapshot (this replaced the separate status tool). " +
      "Unlike a judge child, an orchestration child does NOT exit when it finishes, so waiting " +
      "for a process to end would hang forever.",
    parameters: Type.Object({
      childId: Type.Optional(Type.String({ description: "Omit to wait on any child" })),
      timeoutMs: Type.Optional(Type.Integer({
        description: "Blocking window (default 300000, max 900000). 0 = instant snapshot.",
      })),
    }),

    execute: guarded((params, signal) => doWait(deps, params, signal)),
  });

  host.registerTool({
    name: "orchestrator_close",
    label: "Close A Child Session",
    description:
      "Close a pane this orchestration owns: a registered child (`childId`), or — only when you " +
      "are the SUCCESSOR of a relay — the predecessor orchestrator (`predecessorPane`). Nothing " +
      "else is addressable: the user's own panes and other orchestrations' panes are refused. " +
      "A child's pane is killed; its transcript and gate state survive on disk.",
    parameters: Type.Object({
      childId: Type.Optional(Type.String()),
      predecessorPane: Type.Optional(Type.String({
        description: "Relay only: the pane of the orchestrator you replaced",
      })),
      worktree: Type.Optional(Type.Enum({
        keep: "keep",
        merge: "merge",
        discard: "discard",
      }, {
        description:
          "What happens to a child's ISOLATED CHECKOUT, when it had one (it gets one whenever " +
          "another child was already working in the same repo). `keep` (default) leaves it and says " +
          "so — the work in it is often the only copy. `merge` commits whatever the child left " +
          "uncommitted and squash-merges its branch into YOUR checkout, staged and uncommitted; a " +
          "conflict aborts and leaves your checkout exactly as it was, with the child's work still " +
          "in its own worktree. `discard` removes the checkout and its branch.",
      })),
    }),
    execute: guarded((params) => doClose(deps, params)),
  });

  host.registerTool({
    name: "orchestrator_handoff",
    label: "Hand Over To A Successor",
    description:
      "Hand this orchestration to a fresh orchestrator session when your context is running out — " +
      "`orchestrator_wait` tells you when that is, in block 4 of every receipt. Requires an " +
      "approved plan on disk and a handoff document you already wrote. The successor inherits the " +
      "SAME orchestration id, so every child keeps reaching whoever holds the orchestration with " +
      "nothing restarted and nothing re-stamped; it also gets the handoff path and a pointer to " +
      "your transcript — the raw record, because a handoff document is a self-report. After this " +
      "you go idle; the SUCCESSOR closes your pane (only a successor can, which is what proves " +
      "the takeover worked).",
    parameters: Type.Object({
      handoffPath: Type.String({ description: "Repo-relative path, e.g. docs/orchestrator-handoff.md" }),
    }),
    execute: guarded((params) => doHandoff(deps, params)),
  });

}

/** Re-exported for the extension's own child-session directive injection. */
export { readInheritance };
