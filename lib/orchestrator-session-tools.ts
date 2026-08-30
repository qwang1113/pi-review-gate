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
import { pollUntil } from "./poll-wait.ts";
import { GATE_MODE_ENV } from "./task-mode.ts";
import type { OrchestratorDeps, ToolHost, ToolReply } from "./orchestrator-deps.ts";
import {
  buildKillPaneArgv,
  buildHandoffPaneArgv,
  buildHidePaneLabelsArgv,
  parseSpawnedPaneId,
} from "./orchestrator-tmux.ts";
import { isLastDecoratedChild } from "./orchestrator-pane-decor.ts";

import { spawnAuthorization } from "./orchestrator-gate.ts";
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

  const probe = (): ChildWaitObservation => {
    const runtime = deps.runtime();
    const panes = alivePanes(deps);
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
    if (events.length > 0) return { events, done: false, paneAlive: true };

    // F14 — an unreadable pane list is UNKNOWN liveness, never a death.
    if (!panes.ok) return { done: false, paneAlive: false, livenessUnknown: true };

    if (!childId) {
      const live = open.filter((c) => panes.panes.includes(c.paneId));
      return {
        done: live.some((c) => c.doneAt),
        paneAlive: live.length > 0,
        note: `${live.length} 个子会话在跑`,
      };
    }
    const child = findChild(runtime, childId)!;
    return {
      done: Boolean(child.doneAt),
      paneAlive: !child.closedAt && panes.panes.includes(child.paneId),
      note: `子会话 ${child.id} 仍在 pane ${child.paneId}`,
    };
  };

  const waited = budgetMs === 0
    ? { observation: probe(), waitedMs: 0, aborted: false, stalledInProbe: false }
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
    exitBlockers: exitBlockers(deps),
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
    return reply(
      `review-gate: 等待被中断（已等 ${Math.round(waited.waitedMs / 1000)}s）—— ` +
      "子会话还在跑，没有任何东西被取消。\n\n" + receipt.text,
      { ...details, done: false, reason: "aborted" },
    );
  }
  if (!decision.done && budgetMs > 0) {
    const stalled = waited.stalledInProbe
      ? "（注意：预算用完时探针一次都没返回 —— tmux 很可能卡住了，先自己看一眼 pane）"
      : "";
    return reply(
      `review-gate: 本次预算用完。${stalled}有确定性的活就先做掉，没有就再调一次 ` +
      "`orchestrator_wait` —— 但不要结束 turn 把盯梢责任丢给用户。\n\n" + receipt.text,
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
 */
function exitBlockers(deps: OrchestratorDeps): string[] {
  const { plan } = currentPlan(deps);
  const panes = alivePanes(deps);
  const branch = deps.branchFacts();
  return orchestratorDoneProblems({
    ...(plan ? { plan } : {}),
    runtime: deps.runtime(),
    alivePaneIds: panes.panes,
    ...(branch.workBranch === undefined ? {} : { workBranch: branch.workBranch }),
    ...(branch.baseBranch === undefined ? {} : { baseBranch: branch.baseBranch }),
    mergeSettled: branch.mergeSettled,
    mergeWaived: branch.mergeWaived,
  });
}

/** What a handoff gave this session, when it is a successor. */
function inheritanceBrief(deps: OrchestratorDeps): string | undefined {
  const brief = formatInheritanceBrief(readInheritance(deps.env()), deps.runtime().orchestrationId);
  return brief && brief.length > 0 ? brief : undefined;
}



async function doClose(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const runtime = deps.runtime();
  const childId = String(params.childId ?? "").trim();
  const predecessorPane = String(params.predecessorPane ?? "").trim();

  // CONSTRAINT 12 — the relay's closing move. Only a SUCCESSOR may close the
  // orchestrator it replaced, and its own environment is what says so.
  if (predecessorPane) {
    const auth = predecessorCloseAuthorization(predecessorPane, deps.env());
    if (!auth.ok) return fail("review-gate: " + auth.reason);
    try {
      const result = deps.tmux(buildKillPaneArgv(predecessorPane));
      if (!result.ok) return fail(`review-gate: 关闭前任 pane 失败 —— ${result.stderr}`);
    } catch (error) {
      return fail(`review-gate: 关闭前任 pane 失败 —— ${(error as Error).message}`);
    }
    return reply(
      `review-gate: 前任项目经理 pane ${predecessorPane} 已关闭，接力完成 —— 你现在是这个 orchestration 的持有者。`,
      { closed: predecessorPane },
    );
  }

  const closable = closableChild(runtime, childId);
  if (!closable.ok) return fail("review-gate: " + closable.reason);
  const child = closable.child;
  // The window-level label bar is taken down BEFORE the pane dies, because
  // after `kill-pane` this pane id is no longer a valid `setw` target — and it
  // is taken down only for the LAST decorated child, since the option is
  // shared by every pane in the window (the orchestrator's own included).
  // Leaving it set forever would be litter in the user's window; removing it
  // while a sibling is still labelled would blank a border that is still in
  // use. Purely cosmetic either way, so every failure here is swallowed.
  if (isLastDecoratedChild(runtime.children, child.id)) {
    for (const argv of buildHidePaneLabelsArgv(child.paneId)) {
      try { deps.tmux(argv); } catch { /* cosmetic */ }
    }
  }
  try {
    const result = deps.tmux(buildKillPaneArgv(child.paneId));
    if (!result.ok && !/can't find pane|no such pane/i.test(result.stderr)) {
      return fail(`review-gate: 关闭 pane 失败 —— ${result.stderr}`);
    }
  } catch (error) {
    return fail(`review-gate: 关闭 pane 失败 —— ${(error as Error).message}`);
  }

  // R-28 — THE INCIDENT THIS BRANCH EXISTS FOR. `.git/hooks` lives in the
  // COMMON git dir, so it is shared by every linked worktree: a child that
  // installed the gate's hooks from inside its own orchestration worktree
  // repointed the WHOLE repository's hooks at a directory this call is about
  // to delete. Measured on 2026-08-30: after one `orchestrator_close`, every
  // session in the repo failed to commit ("cannot execute: No such file or
  // directory"), including an innocent third child mid-merge — and it could
  // not repair itself, because `.git/hooks` is gate-blocked and reinstalling
  // from its own temp worktree only moves the crater.
  //
  // So the resource is checked BEFORE it is removed, and repaired first:
  // there is never a window in which the repository cannot commit.
  let hookNote = "";
  if (child.worktree) {
    const referencing = deps.gitHooksReferencing(child.worktree);
    if (referencing.length > 0) {
      const repaired = deps.repairGitHooks();
      if (!repaired.ok) {
        return fail(
          `review-gate: 拒绝清理 worktree —— 仓库的 git 钩子（${referencing.join(", ")}）现在指向 ` +
          `${child.worktree}，删掉它会让**整个仓库**都提交不了（R-28 事故的复现路径）；` +
          `而门禁尝试把钩子复位到主工作区也失败了：${repaired.error}。\n` +
          "pane 与登记都保留着。请在主工作区手动跑 `bash scripts/install-git-hooks.sh` 复位钩子后重试。",
          { childId: child.id, hooksReferencing: referencing, closed: false },
        );
      }
      hookNote =
        `\n注意：仓库的 git 钩子（${referencing.join(", ")}）当时指向这个 worktree —— ` +
        "门禁已先把它们复位到主工作区，再删的 worktree（R-28：先复位、后删除，中间不留破损窗口）。";
    }
  }
  if (child.worktree) deps.removeWorktree(child.worktree);
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
    `review-gate: 子会话 ${child.id}（pane ${child.paneId}）已关闭` +
    (child.worktree ? `，worktree ${child.worktree} 已清理` : "") +
    statusNudge + hookNote,
    { childId: child.id, hooksRepaired: hookNote.length > 0 },
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

  let paneId: string | undefined;
  try {
    const result = deps.tmux(buildHandoffPaneArgv({
      orchestratorPane: self!,
      cwd: deps.repoRoot,
      env: {
        ...successorEnv({
          orchestrationId: runtime.orchestrationId,
          predecessorPane: self!,
          handoffPath,
          predecessorTranscript: deps.sessionTranscriptPath(),
        }),
        [GATE_MODE_ENV]: "orchestrator",
      },
    }));
    if (!result.ok) throw new Error(result.stderr || "tmux split-window 失败");
    paneId = parseSpawnedPaneId(result.stdout);
  } catch (error) {
    return fail(`review-gate: 开接任会话失败 —— ${(error as Error).message}`);
  }
  if (!paneId) return fail("review-gate: tmux 没有回报接任会话的 pane id —— 接力中止，你仍然是持有者。");

  deps.saveRuntime({
    ...deps.runtime(),
    relay: { handoffPath, successorPane: paneId, at: new Date(deps.now()).toISOString() },
  });
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
export function registerOrchestratorSessionTools(host: ToolHost, deps: OrchestratorDeps): void {
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
      "picks the split direction (right column, stacked downward), injects the orchestration id " +
      "so the child's wake-ups survive a relay, starts it in loop mode, creates an isolated " +
      "worktree when the task will run in parallel, and registers the pane — a pane nobody " +
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
      "Say something to a running child session, or stop it. `mode` IS pi's own delivery: " +
      "`steer` cuts into the turn it is in the middle of, `followUp` waits until it finishes and " +
      "is read next, `interrupt` aborts the current turn and carries no text. Nothing is typed at " +
      "a terminal: the text is written to the child's channel and the child's OWN gate injects it " +
      "with `pi.sendUserMessage`, so it cannot be truncated, cannot be split by a newline, and " +
      "cannot be misread by an open dialog as a menu selection (all four were measured). The " +
      "receipt is EARNED — this fails unless the child acknowledges that it injected the message. " +
      "To ANSWER a question the child is waiting on, use `orchestrator_answer`, not this.",
    parameters: Type.Object({
      childId: Type.String(),
      mode: Type.Optional(Type.String({
        description: "\"steer\" | \"followUp\" (default) | \"interrupt\"",
      })),
      message: Type.Optional(Type.String({ description: "Required unless mode is \"interrupt\"" })),
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
      "A child's gate-created worktree is cleaned up with it.",
    parameters: Type.Object({
      childId: Type.Optional(Type.String()),
      predecessorPane: Type.Optional(Type.String({
        description: "Relay only: the pane of the orchestrator you replaced",
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
