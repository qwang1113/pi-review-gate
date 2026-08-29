/**
 * DISPATCH — getting work INTO a child session: `orchestrator_spawn` and
 * `orchestrator_send`.
 *
 * Split from lib/orchestrator-session-tools.ts (which keeps the LIFECYCLE
 * half — wait, close, relay) after this round's fixes pushed that file past
 * the 600-line standard the repository now holds itself to. The seam is a
 * real one rather than a size-driven cut: everything here answers "did the
 * other side actually receive this", which is the question the first real
 * orchestration got wrong four different ways (F1, F7, F8, F11), while the
 * other half answers "what is that child doing now".
 *
 * The invariant both halves share: the orchestrator expresses INTENT and the
 * gate performs the ACT. It names a task, not a split direction; a child, not
 * a pane id. Every tmux argv is built by lib/orchestrator-tmux.ts, every pane
 * it may touch is one the registry created, and the blast radius is one
 * window.
 */

import type { OrchestratorDeps, ToolReply } from "./orchestrator-deps.ts";
import { STATE_VARIANT_ENV } from "./gate-state.ts";
import { ORCHESTRATION_ID_ENV } from "./orchestration-id.ts";
import { GATE_MODE_ENV } from "./task-mode.ts";
import {
  buildSendMessageArgv,
  buildSpawnPaneArgv,
  parseSpawnedPaneId,
} from "./orchestrator-tmux.ts";
import { applyTaskStatus, scheduleNextTasks, type PlanTask } from "./orchestrator-plan.ts";
import { proxyGoalProblems, spawnAuthorization, worktreeRequirement } from "./orchestrator-gate.ts";
import {
  findChild,
  lastChildPane,
  liveChildren,
  newChildId,
  registerChild,
  runningTaskIds,
  type OrchestratorRuntime,
} from "./orchestrator-registry.ts";
import {
  buildChildCommand,
  buildDeliveryMarker,
  buildTaskDocument,
  echoMarker,
  planSend,
  taskFileName,
} from "./orchestrator-delivery.ts";
import { describeStartupEvidence, type PaneSnapshot } from "./orchestrator-pane-read.ts";
import { APPROVE_LABEL_PATTERN } from "./orchestrator-keys.ts";
import { selectOptionInChild } from "./orchestrator-read-tools.ts";
import {
  alivePanes,
  capturePane,
  currentPlan,
  toolFail as fail,
  toolReply as reply,
  verifyDelivery,
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

/**
 * CONSTRAINT 1's awkward corner (F1) — a task sitting in `running` with
 * nothing actually running.
 *
 * `running` is a status `orchestrator_spawn` sets ITSELF, so when a spawn
 * half-failed (or the child's pane was closed by hand) the task was left in a
 * state only spawn produces, and spawn was the one tool that refused it. The
 * hand-run hit this and the error message offered no way out.
 *
 * The recovery is deliberately narrow: the task returns to `pending` only
 * when no LIVE child is working on it. A task with a live child is still
 * refused — that refusal is doing its job.
 */
export function abandonedRunningTask(
  runtime: OrchestratorRuntime,
  task: PlanTask,
  alivePaneIds: readonly string[],
): { abandoned: boolean; note?: string } {
  if (task.status !== "running") return { abandoned: false };
  const working = liveChildren(runtime, alivePaneIds).some((c) => c.taskId === task.id && !c.doneAt);
  if (working) return { abandoned: false };
  return {
    abandoned: true,
    note: "上一个子会话已经不在了（pane 消失或已关闭），任务自动退回 pending 以便重开（F1 恢复路径）",
  };
}

export async function dispatchSpawn(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const first = currentPlan(deps);
  if (first.problem) return first.problem;
  let plan = first.plan;

  const auth = spawnAuthorization(deps.runtime(), plan);
  if (!auth.ok) return fail("review-gate: " + auth.reason);

  const taskId = String(params.taskId ?? "").trim();
  let task = plan!.tasks.find((t) => t.id === taskId);
  if (!task) return fail(`review-gate: plan 里没有任务 "${taskId}"。`);

  // The task text is no longer typed into a pane — it IS the child's first
  // message, carried in the argv (F7). An empty one would open a session with
  // nothing to do, which is exactly the state the hand-run deadlocked in.
  const brief = String(params.task ?? "").trim();
  if (!brief) {
    return fail(
      "review-gate: `task`（给子会话的任务说明）不能为空 —— 它现在是子会话启动时的第一条消息" +
      "（写成任务文件、用 `pi @file` 带进去），没有它就等于开了一个空会话，正是上一轮 F8 的死锁现场。",
    );
  }

  const self = deps.ownPane();
  if (!self) {
    return fail("review-gate: 读不到自己的 tmux pane（$TMUX_PANE）—— 项目经理必须在 tmux window 里运行。");
  }
  const panes = alivePanes(deps);
  if (!panes.ok) {
    return fail("review-gate: 读不到 tmux pane 列表，拒绝开新 pane（宁可不开，也不能在不确定的布局里乱 split）。");
  }

  // F1 — recover a task whose child is gone before the scheduler judges it.
  // Status and note are excluded from the plan's approval hash, so this
  // cannot invalidate the user's approval.
  const nowIso = new Date(deps.now()).toISOString();
  const abandoned = abandonedRunningTask(deps.runtime(), task, panes.panes);
  if (abandoned.abandoned) {
    const back = applyTaskStatus(plan!, taskId, "pending", { note: abandoned.note, now: nowIso });
    if (!back.ok) {
      return fail(`review-gate: 任务 "${taskId}" 卡在 running 且退不回 pending —— ${back.reason}`);
    }
    plan = back.plan;
    deps.savePlan(plan);
    task = plan.tasks.find((t) => t.id === taskId)!;
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
  const childId = newChildId(taskId, deps.now());
  const marker = buildDeliveryMarker(taskId, deps.now());
  const written = deps.writeScratchFile(
    taskFileName(marker),
    buildTaskDocument({ marker, taskId, title: task.title, brief }),
  );
  if (!written.ok) {
    if (worktree) deps.removeWorktree(worktree);
    return fail(`review-gate: 任务书写不出来（${written.error}）—— 一个 pane 都没开。`);
  }

  const env: Record<string, string> = {
    // The child's wake-ups are addressed to the ORCHESTRATION, so they keep
    // arriving after a relay — the whole point of the id.
    [ORCHESTRATION_ID_ENV]: deps.runtime().orchestrationId,
    // It is an ordinary loop session, and it is told so explicitly rather
    // than left to classify itself into something else.
    [GATE_MODE_ENV]: "loop",
    // F4 — its OWN gate sidecar, so supervisor and worker never overwrite
    // each other's mode, Q&A record and unmet-gate list.
    [STATE_VARIANT_ENV]: childId,
  };

  let paneId: string | undefined;
  try {
    const result = deps.tmux(buildSpawnPaneArgv({
      orchestratorPane: self,
      lastChildPane: lastChildPane(deps.runtime(), panes.panes),
      cwd,
      env,
      // F7/F8 — the task rides in on the argv. No typing, nothing to
      // truncate, no Enter to forget.
      command: buildChildCommand(written.path),
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

  deps.saveRuntime(registerChild(deps.runtime(), {
    id: childId,
    taskId,
    paneId,
    cwd,
    ...(worktree ? { worktree } : {}),
    stateVariant: childId,
    taskFile: written.path,
    createdAt: new Date(deps.now()).toISOString(),
  }));
  const started = applyTaskStatus(plan!, taskId, "running", { now: new Date(deps.now()).toISOString() });
  if (started.ok) deps.savePlan(started.plan);

  // F8 — EARN the receipt. Nothing below claims delivery that was not seen.
  const check = await verifyDelivery(deps, {
    kind: "spawn",
    paneId,
    marker,
    cwd,
    stateVariant: childId,
  });
  if (!check.verdict.ok) {
    const current = currentPlan(deps).plan;
    if (current) {
      const back = applyTaskStatus(current, taskId, "pending", {
        note: `spawn 未能确认子会话起跑（${describeStartupEvidence(check.evidence)}）`,
        now: new Date(deps.now()).toISOString(),
      });
      if (back.ok) deps.savePlan(back.plan);
    }
    return fail(
      `review-gate: ${check.verdict.reason}\n` +
      `观察到的证据：${describeStartupEvidence(check.evidence)}。\n` +
      `pane ${paneId} 和子会话登记 ${childId} 都**保留**着（不误杀一个可能其实活着的会话），` +
      `任务 ${taskId} 已退回 pending。\n` +
      `下一步：\`orchestrator_read({ childId: "${childId}" })\` 看那个 pane 到底怎么了；` +
      `确认没救就 \`orchestrator_close({ childId: "${childId}" })\` 再重开。\n` +
      `任务书在：${written.path}`,
      { childId, paneId, delivered: false, evidence: check.evidence },
    );
  }

  return reply(
    `review-gate: 子会话 ${childId} 已在 pane ${paneId} 启动（${verdict.execution}${worktree ? `，worktree=${worktree}` : ""}）。\n` +
    `任务 ${taskId} 已置为 running，任务书 ${written.path} 已随 \`pi @file\` 带进去。\n` +
    `投递已核实：${check.verdict.summary}。\n` +
    "接下来用 `orchestrator_wait` 等它 —— 不要结束 turn 把盯梢责任丢给用户。" +
    "它一旦有事找你，用 `orchestrator_read` 看它到底在问什么，用 `orchestrator_key` 答它的选项框。",
    {
      childId,
      paneId,
      execution: verdict.execution,
      worktree,
      taskFile: written.path,
      delivered: true,
    },
  );
}

/** The affirmative row of a goal-approval dialog, when exactly one looks like it. */
function findApprovalOption(snapshot: PaneSnapshot | undefined): number | undefined {
  const options = snapshot?.dialog?.options ?? [];
  const hits = options.filter((o) => APPROVE_LABEL_PATTERN.test(o.label));
  return hits.length === 1 ? hits[0]!.index : undefined;
}

export async function dispatchSend(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const childId = String(params.childId ?? "").trim();
  const child = findChild(deps.runtime(), childId);
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

    // F11 — the boundary check is only HALF the job. The old code stopped
    // here and reported "已过边界比对", which the caller reasonably read as
    // "approved"; in reality the approval dialog was sitting untouched in the
    // child's pane. Approving means ANSWERING that dialog, verifiably.
    const snapshot = capturePane(deps, child.paneId);
    const approveIndex = findApprovalOption(snapshot);
    if (approveIndex === undefined) {
      return fail(
        "review-gate: 边界比对通过（约束 8），**但代批没有真的执行** —— " +
        "在子会话屏幕上找不到唯一一个「认可/批准」选项，不能盲按。\n" +
        `请 \`orchestrator_read({ childId: "${childId}" })\` 看清那个框，` +
        `再用 \`orchestrator_key({ childId: "${childId}", index: <第几项> })\` 亲自答它（那条路径带命中校验）。`,
        { childId, boundaryOk: true, approved: false },
      );
    }
    const answered = await selectOptionInChild(deps, child, { index: approveIndex });
    if (answered.isError) return answered;
    return reply(
      `review-gate: 代批完成 —— 先过任务边界比对（约束 8），再在子会话的对话框上选中并提交了「认可」项。\n` +
      (answered.content.map((c) => c.text).join("\n")),
      { childId, boundaryOk: true, approved: true },
    );
  }

  // F7 — long or multi-line text never goes through the keyboard.
  const mode = planSend(message);
  let typed: string;
  let marker: string;
  if (mode.kind === "inline") {
    typed = mode.text;
    marker = echoMarker(mode.text);
  } else {
    const fileMarker = buildDeliveryMarker(child.taskId, deps.now());
    const written = deps.writeScratchFile(
      taskFileName(fileMarker),
      buildTaskDocument({
        marker: fileMarker,
        taskId: child.taskId,
        title: "项目经理的说明",
        brief: mode.body,
      }),
    );
    if (!written.ok) return fail(`review-gate: 说明文件写不出来（${written.error}）—— 什么都没发。`);
    typed = mode.pointer(written.path);
    marker = written.path.split("/").pop() ?? written.path;
  }

  try {
    for (const argv of buildSendMessageArgv(child.paneId, typed)) {
      const result = deps.tmux(argv);
      if (!result.ok) return fail(`review-gate: 发送失败 —— ${result.stderr || "tmux send-keys 出错"}`);
    }
  } catch (error) {
    return fail(`review-gate: 发送失败 —— ${(error as Error).message}`);
  }

  const check = await verifyDelivery(deps, { kind: "send", paneId: child.paneId, marker });
  if (!check.verdict.ok) {
    return fail(
      `review-gate: ${check.verdict.reason}\n观察到的证据：${describeStartupEvidence(check.evidence)}。`,
      { childId, delivered: false, evidence: check.evidence },
    );
  }
  return reply(
    `review-gate: 已发给子会话 ${childId}（pane ${child.paneId}）` +
    (mode.kind === "file" ? "，正文写成文件、只把路径敲了进去（长文本不走键盘）" : "") +
    `。投递已核实：${check.verdict.summary}。`,
    { childId, delivered: true },
  );
}
