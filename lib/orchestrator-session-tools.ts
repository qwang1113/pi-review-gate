/**
 * The SESSION tools — everything that touches somebody else's process:
 * spawn, send, wait, close, relay.
 *
 * The invariant that shapes all five: the orchestrator expresses INTENT and
 * the gate performs the ACT. It names a task, not a split direction; a child,
 * not a pane id; "wait", not a polling loop. Every tmux argv is built by
 * lib/orchestrator-tmux.ts, every pane it may touch is one the registry
 * created, and the blast radius is one window.
 *
 * Read this alongside lib/orchestrator-tools.ts (plan / status / notify),
 * which is the half that never leaves the sidecar.
 */

import { Type } from "typebox";
import { pollUntil } from "./poll-wait.ts";
import { ORCHESTRATION_ID_ENV } from "./orchestration-id.ts";
import { GATE_MODE_ENV } from "./task-mode.ts";
import type { OrchestratorDeps, ToolHost, ToolReply } from "./orchestrator-deps.ts";
import {
  buildKillPaneArgv,
  buildRelayPaneArgv,
  buildSendMessageArgv,
  buildSpawnPaneArgv,
  parseSpawnedPaneId,
} from "./orchestrator-tmux.ts";
import { applyTaskStatus, scheduleNextTasks, type PlanTask } from "./orchestrator-plan.ts";
import { proxyGoalProblems, spawnAuthorization, worktreeRequirement } from "./orchestrator-gate.ts";
import {
  closableChild,
  findChild,
  lastChildPane,
  markChildClosed,
  newChildId,
  registerChild,
  runningTaskIds,
} from "./orchestrator-registry.ts";
import {
  predecessorCloseAuthorization,
  readInheritance,
  relayPreconditions,
  successorEnv,
} from "./orchestrator-relay.ts";
import {
  clampChildWaitTimeout,
  evaluateChildWait,
  type ChildWaitObservation,
} from "./orchestrator-wait.ts";
// Short local aliases; see the note in lib/orchestrator-tools.ts.
import {
  alivePanes,
  currentPlan,
  toolFail as fail,
  toolReply as reply,
  requireOrchestratorMode,
} from "./orchestrator-tool-kit.ts";

/**
 * May THIS task start right now, and will it run alongside anything?
 *
 * Answered by the same scheduler the plan uses, so the tool cannot disagree
 * with what `orchestrator_status` reports: a task the scheduler defers is
 * refused here with the scheduler's own reason (constraint 6).
 */
function schedulingVerdict(
  deps: OrchestratorDeps,
  task: PlanTask,
  alive: readonly string[],
): { ok: true; execution: "serial" | "parallel" } | { ok: false; reason: string } {
  const { plan } = currentPlan(deps);
  if (!plan) return { ok: false, reason: "没有 plan" };
  const running = runningTaskIds(deps.runtime(), alive);
  const schedule = scheduleNextTasks(plan, running);
  const picked = schedule.start.find((s) => s.task.id === task.id);
  if (picked) return { ok: true, execution: picked.execution };
  const deferred = schedule.deferred.find((d) => d.task.id === task.id);
  if (deferred) return { ok: false, reason: deferred.reason };
  if (running.length >= plan.maxParallel) {
    return { ok: false, reason: `并行上限 ${plan.maxParallel} 已满（正在跑：${running.join(", ")}）` };
  }
  const blockers = task.dependsOn.filter((d) => plan.tasks.find((t) => t.id === d)?.status !== "done");
  if (blockers.length) return { ok: false, reason: `前置任务未完成：${blockers.join(", ")}` };
  return { ok: false, reason: `任务 "${task.id}" 当前状态是 ${task.status}，只有 pending 的任务可以开工` };
}

async function doSpawn(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const { plan, problem } = currentPlan(deps);
  if (problem) return problem;
  const runtime = deps.runtime();

  const auth = spawnAuthorization(runtime, plan);
  if (!auth.ok) return fail("review-gate: " + auth.reason);

  const taskId = String(params.taskId ?? "").trim();
  const task = plan!.tasks.find((t) => t.id === taskId);
  if (!task) return fail(`review-gate: plan 里没有任务 "${taskId}"。`);

  const self = deps.ownPane();
  if (!self) {
    return fail("review-gate: 读不到自己的 tmux pane（$TMUX_PANE）—— 项目经理必须在 tmux window 里运行。");
  }
  const panes = alivePanes(deps);
  if (!panes.ok) {
    return fail("review-gate: 读不到 tmux pane 列表，拒绝开新 pane（宁可不开，也不能在不确定的布局里乱 split）。");
  }

  const verdict = schedulingVerdict(deps, task, panes.panes);
  if (!verdict.ok) return fail(`review-gate: 现在还不能开 "${taskId}" —— ${verdict.reason}`);

  // CONSTRAINT 7 — a child that will run alongside another gets its own
  // worktree, created BY THE GATE (the agent never assembles a git command).
  let worktree: string | undefined;
  const need = worktreeRequirement(verdict.execution);
  if (need.needed) {
    const created = deps.addWorktree(taskId);
    if (!created.ok) {
      return fail(`review-gate: ${need.reason}，但 worktree 创建失败：${created.error}`);
    }
    worktree = created.path;
  }

  const cwd = worktree ?? deps.repoRoot;
  const env: Record<string, string> = {
    // The child's wake-ups are addressed to the ORCHESTRATION, so they keep
    // arriving after a relay — the whole point of the id.
    [ORCHESTRATION_ID_ENV]: runtime.orchestrationId,
    // It is an ordinary loop session, and it is told so explicitly rather
    // than left to classify itself into something else.
    [GATE_MODE_ENV]: "loop",
  };

  let paneId: string | undefined;
  try {
    const result = deps.tmux(buildSpawnPaneArgv({
      orchestratorPane: self,
      lastChildPane: lastChildPane(runtime, panes.panes),
      cwd,
      env,
    }));
    if (!result.ok) throw new Error(result.stderr || "tmux split-window 失败");
    paneId = parseSpawnedPaneId(result.stdout);
  } catch (error) {
    if (worktree) deps.removeWorktree(worktree);
    return fail(`review-gate: 开子会话失败 —— ${(error as Error).message}`);
  }
  if (!paneId) {
    if (worktree) deps.removeWorktree(worktree);
    return fail("review-gate: tmux 没有回报新 pane id，无法登记这个子会话 —— 已回滚（未登记的 pane 不可寻址）。");
  }

  const nowIso = new Date(deps.now()).toISOString();
  const childId = newChildId(taskId, deps.now());
  deps.saveRuntime(registerChild(deps.runtime(), {
    id: childId,
    taskId,
    paneId,
    cwd,
    worktree,
    createdAt: nowIso,
  }));
  const moved = applyTaskStatus(plan!, taskId, "running", { now: nowIso });
  if (moved.ok) deps.savePlan(moved.plan);

  const brief = String(params.task ?? "").trim();
  if (brief) {
    for (const argv of buildSendMessageArgv(paneId, brief)) deps.tmux(argv);
  }

  return reply(
    `review-gate: 子会话 ${childId} 已在 pane ${paneId} 启动（${verdict.execution}${worktree ? `，worktree=${worktree}` : ""}）。\n` +
    `任务 ${taskId} 已置为 running。` +
    (brief ? "任务说明已发过去。" : "用 `orchestrator_send` 把任务说明发给它。") +
    "\n接下来用 `orchestrator_wait` 等它 —— 不要结束 turn 把盯梢责任丢给用户。",
    { childId, paneId, execution: verdict.execution, worktree },
  );
}

async function doSend(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const runtime = deps.runtime();
  const childId = String(params.childId ?? "").trim();
  const child = findChild(runtime, childId);
  if (!child) return fail(`review-gate: 没有登记过子会话 "${childId}"。`);
  if (child.closedAt) return fail(`review-gate: 子会话 "${childId}" 已经关闭了。`);

  const message = String(params.message ?? "").trim();
  const goalText = String(params.approveGoal ?? "").trim();
  if (!message && !goalText) return fail("review-gate: 要发的内容是空的。");

  // CONSTRAINT 8 — proxy-approving a child's goal is allowed, but only inside
  // the task's declared boundary. Outside it, this is a scope change, and
  // scope is the user's.
  if (goalText) {
    const { plan } = currentPlan(deps);
    const task = plan?.tasks.find((t) => t.id === child.taskId);
    if (!task) return fail(`review-gate: 找不到子会话 "${childId}" 对应的任务 "${child.taskId}"，无法做边界比对。`);
    const check = proxyGoalProblems(goalText, task);
    if (!check.ok) return fail("review-gate: " + check.reason, { outside: check.outside });
  }

  const text = message || goalText;
  try {
    for (const argv of buildSendMessageArgv(child.paneId, text)) {
      const result = deps.tmux(argv);
      if (!result.ok) return fail(`review-gate: 发送失败 —— ${result.stderr || "tmux send-keys 出错"}`);
    }
  } catch (error) {
    return fail(`review-gate: 发送失败 —— ${(error as Error).message}`);
  }
  return reply(
    `review-gate: 已发给子会话 ${childId}（pane ${child.paneId}）。` +
    (goalText ? "代批 goal 已过任务边界比对（约束 8）。" : ""),
    { childId },
  );
}

async function doWait(
  deps: OrchestratorDeps,
  params: Record<string, unknown>,
  signal: { readonly aborted: boolean } | undefined,
): Promise<ToolReply> {
  const childId = String(params.childId ?? "").trim();
  const budgetMs = clampChildWaitTimeout(params.timeoutMs);

  const probe = (): ChildWaitObservation => {
    const runtime = deps.runtime();
    const panes = alivePanes(deps);
    const attention = deps.consumeAttention();
    if (attention) {
      // A child reporting in is news regardless of which child asked.
      return { attention, done: false, paneAlive: true };
    }
    if (!childId) {
      const live = runtime.children.filter((c) => !c.closedAt && panes.panes.includes(c.paneId));
      const anyDone = live.find((c) => c.doneAt);
      return {
        done: Boolean(anyDone),
        paneAlive: live.length > 0,
        note: `${live.length} 个子会话在跑`,
      };
    }
    const child = findChild(runtime, childId);
    if (!child) return { done: true, paneAlive: false, note: `没有子会话 "${childId}"` };
    return {
      done: Boolean(child.doneAt),
      paneAlive: !child.closedAt && panes.panes.includes(child.paneId),
      note: `子会话 ${child.id} 仍在 pane ${child.paneId}`,
    };
  };

  const waited = await pollUntil({
    probe,
    isDone: (observation) => evaluateChildWait(observation).done,
    budgetMs,
    signal,
  });
  const decision = evaluateChildWait(waited.observation);
  const seconds = Math.round(waited.waitedMs / 1000);
  if (!decision.done) {
    return reply(
      `review-gate: 等了 ${seconds}s，子会话还在工作（${decision.summary}）。` +
      "有确定性的活就先做掉，没有就再等一轮 —— 但不要结束 turn 把盯梢责任丢给用户。",
      { done: false, reason: decision.reason, waitedMs: waited.waitedMs },
    );
  }
  return reply(
    `review-gate: ${decision.summary}（等待 ${seconds}s，判据：${decision.reason}）。`,
    { done: true, reason: decision.reason, waitedMs: waited.waitedMs },
  );
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
  try {
    const result = deps.tmux(buildKillPaneArgv(child.paneId));
    if (!result.ok && !/can't find pane|no such pane/i.test(result.stderr)) {
      return fail(`review-gate: 关闭 pane 失败 —— ${result.stderr}`);
    }
  } catch (error) {
    return fail(`review-gate: 关闭 pane 失败 —— ${(error as Error).message}`);
  }
  if (child.worktree) deps.removeWorktree(child.worktree);
  deps.saveRuntime(markChildClosed(deps.runtime(), child.id, new Date(deps.now()).toISOString()));
  return reply(
    `review-gate: 子会话 ${child.id}（pane ${child.paneId}）已关闭` +
    (child.worktree ? `，worktree ${child.worktree} 已清理` : "") +
    "。别忘了把它的任务状态置为 done 或 pending（`orchestrator_plan`）。",
    { childId: child.id },
  );
}

async function doRelay(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
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
    const result = deps.tmux(buildRelayPaneArgv({
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

/** Register the five session tools. */
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
    execute: guarded((params) => doSpawn(deps, params)),
  });

  host.registerTool({
    name: "orchestrator_send",
    label: "Message A Child Session",
    description:
      "Send a message to a registered child session. Use `approveGoal` to approve a loop goal on " +
      "the user's behalf: the gate first checks that the goal stays inside the task's declared " +
      "file boundaries and REFUSES otherwise (that is a scope change, and scope belongs to the " +
      "human — notify them instead).",
    parameters: Type.Object({
      childId: Type.String(),
      message: Type.Optional(Type.String()),
      approveGoal: Type.Optional(Type.String({
        description: "The child's proposed goal text — boundary-checked before it is sent",
      })),
    }),
    execute: guarded((params) => doSend(deps, params)),
  });

  host.registerTool({
    name: "orchestrator_wait",
    label: "Wait For A Child Session",
    description:
      "Block until something actually happens: an ATTENTION event from a child, a child " +
      "reporting its task done, its pane vanishing (it died or the user closed it), or the " +
      "timeout. Unlike a judge child, an orchestration child does NOT exit when it finishes, so " +
      "waiting for a process to end would hang forever. Call this instead of ending your turn.",
    parameters: Type.Object({
      childId: Type.Optional(Type.String({ description: "Omit to wait on any child" })),
      timeoutMs: Type.Optional(Type.Integer({ description: "Blocking window (default 300000, max 1800000)" })),
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
    name: "orchestrator_relay",
    label: "Hand Over To A Successor",
    description:
      "Hand this orchestration to a fresh orchestrator session when your context is running out. " +
      "Requires an approved plan on disk and a handoff document you already wrote. The successor " +
      "inherits the SAME orchestration id (children keep reaching it with no restart), the " +
      "handoff path, and a pointer to your transcript — the raw record, because a handoff " +
      "document is a self-report. After this you go idle; the SUCCESSOR closes your pane.",
    parameters: Type.Object({
      handoffPath: Type.String({ description: "Repo-relative path, e.g. docs/orchestrator-handoff.md" }),
    }),
    execute: guarded((params) => doRelay(deps, params)),
  });
}

/** Re-exported for the extension's own child-session directive injection. */
export { readInheritance };
