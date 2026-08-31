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
  buildSpawnPaneArgv,
  buildPaneStyleArgv,
  buildPaneTitleArgv,
  buildShowPaneLabelsArgv,
  parseSpawnedPaneId,
} from "./orchestrator-tmux.ts";
import {
  paneColorFor,
  paneLabelFor,
  paneStyleFor,
  paneTitleFor,
  PANE_BORDER_FORMAT,
  PANE_BORDER_STATUS,
} from "./orchestrator-pane-decor.ts";

import { applyTaskStatus, scheduleNextTasks, type PlanTask } from "./orchestrator-plan.ts";
import { spawnAuthorization } from "./orchestrator-gate.ts";
import {
  findChild,
  lastChildPane,
  liveChildren,
  markChildAssigned,
  newChildId,
  registerChild,
  runningTaskIds,
  type OrchestratorRuntime,
} from "./orchestrator-registry.ts";
import {
  buildChildCommand,
  buildDeliveryMarker,
  buildTaskDocument,
  taskFileName,
  type DeliveryEvidence,
} from "./orchestrator-delivery.ts";
import {
  appendRecord,
  newChannelId,
  type ChannelInstructRecord,
} from "./orchestrator-channel.ts";
import {
  alivePanes,
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
  const schedule = scheduleNextTasks(plan, running, deps.repoRoot);
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
 * Give this child's pane its colour and its label — INSIDE the spawn.
 *
 * WHERE THIS RUNS IS PART OF THE REQUIREMENT, not an implementation taste
 * (user, 2026-08-30). It is not a tool, not an action, and not a second step
 * the orchestrator takes after `orchestrator_spawn` returns — not even
 * through an internal helper it would have to remember to call. It is one of
 * the atomic things a spawn already does, exactly like writing the task file,
 * manager's call sequence did not change by one character when this landed.
 *
 * FAILURE IS COSMETIC, ALWAYS. Every tmux result here is checked and then
 * DOWNGRADED to a note in the reply: a child that is running with a plain
 * border is a child that is running, while a spawn that failed because tmux
 * would not set a colour would be the gate breaking real work over decoration.
 */
function decorateChildPane(
  deps: OrchestratorDeps,
  opts: { paneId: string; childId: string; taskId: string; title: string },
): { label: string; note: string } {
  const label = paneLabelFor(opts.taskId, opts.title);
  const failures: string[] = [];
  const run = (argv: readonly string[]): void => {
    try {
      const result = deps.tmux(argv);
      if (!result.ok) failures.push(result.stderr || argv.join(" "));
    } catch (error) {
      failures.push((error as Error).message);
    }
  };
  run(buildPaneStyleArgv(opts.paneId, paneStyleFor(opts.childId)));
  run(buildPaneTitleArgv(opts.paneId, paneTitleFor({ label, state: "working", stateForSeconds: 0 })));
  for (const argv of buildShowPaneLabelsArgv(opts.paneId, PANE_BORDER_STATUS, PANE_BORDER_FORMAT)) {
    run(argv);
  }
  if (failures.length === 0) {
    return {
      label,
      note: `pane 已标记为 ${label}（${paneColorFor(opts.childId).name}边框，标题随状态自动刷新）。`,
    };
  }
  return {
    label,
    note:
      `pane 装饰没能全部生效（${failures[0]}）—— 纯展示层，子会话本身不受影响，` +
      "健康快照与通道判定照常。",
  };
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

  // 2026-09-07 (user decision): no isolated worktrees anymore. Children
  // share the main worktree and run SERIALLY within a repo (see
  // schedulingVerdict); the only parallelism left is across repos, so a
  // task's declared `repo` picks the checkout the child works in.
  const cwd = task.repo && deps.knownRepoRoots().includes(task.repo)
    ? task.repo
    : deps.repoRoot;
  const childId = newChildId(taskId, deps.now());
  const marker = buildDeliveryMarker(taskId, deps.now());
  const written = deps.writeScratchFile(
    taskFileName(marker),
    buildTaskDocument({ marker, taskId, title: task.title, brief }),
  );
  if (!written.ok) {
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
      command: buildChildCommand(written.path, childId),
    }));
    if (!result.ok) throw new Error(result.stderr || "tmux split-window 失败");
    paneId = parseSpawnedPaneId(result.stdout);
  } catch (error) {
    return fail(`review-gate: 开子会话失败 —— ${(error as Error).message}`);
  }
  if (!paneId) {
    return fail("review-gate: tmux 没有回报新 pane id，无法登记这个子会话 —— 已回滚（未登记的 pane 不可寻址）。");
  }

  deps.saveRuntime(registerChild(deps.runtime(), {
    id: childId,
    taskId,
    paneId,
    cwd,
    stateVariant: childId,
    taskFile: written.path,
    createdAt: new Date(deps.now()).toISOString(),
    // The spawn IS the first assignment: a completion record older than this
    // belongs to whatever ran this task before (round-1 P1).
    lastAssignedAt: new Date(deps.now()).toISOString(),
  }));

  // One of the spawn's own atomic actions (see decorateChildPane): the child
  // gets its colour and its `@task · state` border here, not in a step the
  // caller has to remember.
  const decor = decorateChildPane(deps, {
    paneId,
    childId,
    taskId,
    title: task.title,
  });

  const started = applyTaskStatus(plan!, taskId, "running", { now: new Date(deps.now()).toISOString() });
  if (started.ok) deps.savePlan(started.plan);

  // F8 — EARN the receipt. Nothing below claims delivery that was not seen.
  const check = await verifyDelivery(deps, {
    kind: "spawn",
    childId,
    cwd,
    stateVariant: childId,
  });
  if (!check.verdict.ok) {
    const current = currentPlan(deps).plan;
    if (current) {
      const back = applyTaskStatus(current, taskId, "pending", {
        note: `spawn 未能确认子会话起跑（${describeDeliveryEvidence(check.evidence)}）`,
        now: new Date(deps.now()).toISOString(),
      });
      if (back.ok) deps.savePlan(back.plan);
    }
    return fail(
      `review-gate: ${check.verdict.reason}\n` +
      `观察到的证据：${describeDeliveryEvidence(check.evidence)}。\n` +
      `pane ${paneId} 和子会话登记 ${childId} 都**保留**着（不误杀一个可能其实活着的会话），` +
      `任务 ${taskId} 已退回 pending。\n` +
      `下一步：\`orchestrator_wait({ timeoutMs: 0 })\` 看它在健康快照里是什么状态；` +
      `确认没救就 \`orchestrator_close({ childId: "${childId}" })\` 再重开。\n` +
      `任务书在：${written.path}`,
      { childId, paneId, delivered: false, evidence: check.evidence },
    );
  }

  return reply(
    `review-gate: 子会话 ${childId} 已在 pane ${paneId} 启动（共享主工作区，同一 repo 内串行）。\n` +
    `任务 ${taskId} 已置为 running，任务书 ${written.path} 已随 \`pi @file\` 带进去。\n` +
    `投递已核实：${check.verdict.summary}。\n` +
    `${decor.note}\n` +

    "接下来用 `orchestrator_wait` 等它 —— 不要结束 turn 把盯梢责任丢给用户。" +
    "它有事找你时，wait 的回执里会直接带上完整的问题与选项，用 `orchestrator_answer` 回。",

    {
      childId,
      paneId,
      execution: verdict.execution,
      taskFile: written.path,
      delivered: true,
    },
  );
}

/** One line naming what was and was not observed about a delivery. */
function describeDeliveryEvidence(evidence: DeliveryEvidence): string {
  const parts = [
    `通道有记录=${evidence.channelReported ? "是" : "否"}`,
    `sidecar 存在=${evidence.sidecarPresent ? "是" : "否"}`,
  ];
  if (evidence.ack) {
    const stage = evidence.ack.stage ?? "injected";
    const said = evidence.ack.delivered
      ? (stage === "received" ? "已收到并入队" : "已注入")
      : "未注入";
    parts.push(`子会话回执=${said}${evidence.ack.detail ? `（${evidence.ack.detail}）` : ""}`);
  }

  return parts.join("，");
}

/** The three delivery modes, and what each one means to the child's gate. */
const INSTRUCT_MODES = new Set(["steer", "followUp", "interrupt"]);

/**
 * `orchestrator_instruct` — say something to a running child, or stop it.
 *
 * ── WHY THIS IS ONE TOOL WITH A MODE (philosophy two) ──
 *
 * It used to be `orchestrator_send` plus a separate `kind: "command"` lane
 * plus an `approveGoal` flag plus no interrupt at all, and the orchestrator
 * had to work out which of them applied. Every one of those distinctions was
 * really the same question — HOW should this text reach the agent — and pi
 * answers it with one parameter. So the mode IS `deliverAs`:
 *
 *   steer      cut into the current turn (pi.sendUserMessage, deliverAs steer)
 *   followUp   let it finish, then read this (deliverAs followUp)
 *   interrupt  HIGHEST priority: stop what it is doing (ctx.abort()) and read
 *              the message immediately. Since 2026-08-31 it carries a text —
 *              a bare abort needed a second followUp to say anything; one call
 *              now means "stop and do THIS instead, now".
 * ── WHY NOTHING IS TYPED ──
 *
 * The old path was `tmux send-keys`, and it produced four separate measured
 * defects: truncation (F7), no submit (F8), landing in the composer or the
 * steering queue by luck (R-20), and — worst — newlines inside a message
 * being read by an open dialog as "submit the highlighted row", which
 * answered a question on the child's behalf with an option nobody chose
 * (R-13). None of that is possible now: the text is written to the child's
 * channel as data, and the child's OWN gate injects it through pi's API. A
 * dialog is no longer something to guard against here either — an open
 * dialog is answered with `orchestrator_answer`, and a message delivered
 * while one is open simply queues behind it.
 *
 * THE RECEIPT IS STILL EARNED. Writing to the channel proves nothing; the
 * child's acknowledgement record does. No acknowledgement ⇒ this FAILS, and
 * says so.
 */
export async function dispatchInstruct(
  deps: OrchestratorDeps,
  params: Record<string, unknown>,
): Promise<ToolReply> {
  const childId = String(params.childId ?? "").trim();
  const child = findChild(deps.runtime(), childId);
  if (!child) return fail(`review-gate: 没有登记过子会话 "${childId}"。`);
  if (child.closedAt) return fail(`review-gate: 子会话 "${childId}" 已经关闭了。`);

  const rawMode = String(params.mode ?? "followUp").trim();
  if (!INSTRUCT_MODES.has(rawMode)) {
    return fail(
      `review-gate: mode 只能是 steer / followUp / interrupt，收到的是 ${JSON.stringify(params.mode)}。\n` +
      "（pi 的 sendUserMessage 只支持 steer 与 followUp 两种投递；nextTurn 属于另一套 API，本门禁不提供。）",
    );
  }
  const mode = rawMode as ChannelInstructRecord["mode"];
  const message = String(params.message ?? "").trim();
  // 2026-08-31 (UX): `interrupt` may now carry a message. It used to be a
  // bare abort ("stop what you are doing") that needed a SECOND followUp to
  // say anything — two calls for what is really one intent: "stop and do
  // THIS instead, now". With a text it becomes the highest-priority delivery:
  // the child aborts its current turn and reads the message immediately.
  if (!message) {
    return fail("review-gate: 要发的内容是空的（连 interrupt 打断也要说一句为什么/下一步是什么）。");
  }

  const instructId = newChannelId("ins", deps.now());
  try {
    appendRecord(
      deps.channelIO(),
      { orchestrationId: deps.runtime().orchestrationId, childId, ...(deps.channelHome() === undefined ? {} : { home: deps.channelHome()! }) },
      {
        kind: "instruct",
        from: "orchestrator",
        at: new Date(deps.now()).toISOString(),
        instructId,
        mode,
        ...(message ? { text: message } : {}),
      },
    );
  } catch (error) {
    return fail(`review-gate: 指令写不进通道 —— ${(error as Error).message}。什么都没发。`);
  }

  // The sidecar path is passed in FROM THE REGISTRY (round-4 P1). It used to be
  // omitted here, so `sidecarPresent` was structurally false and the failure
  // message reported "sidecar 存在=否" about a child whose sidecar was on disk
  // and being written at that very moment — evidence that pointed straight at
  // the wrong conclusion ("it died").
  const check = await verifyDelivery(deps, {
    kind: "instruct",
    childId,
    instructId,
    instructMode: mode,
    cwd: child.cwd,
    ...(child.stateVariant === undefined ? {} : { stateVariant: child.stateVariant }),
  });

  if (!check.verdict.ok) {
    return fail(
      `review-gate: ${check.verdict.reason}\n观察到的证据：${describeDeliveryEvidence(check.evidence)}。`,
      { childId, instructId, mode, delivered: false, evidence: check.evidence },
    );
  }

  // NEW WORK UN-FINISHES A CHILD (round-1 P1). Whatever this text is — the
  // next task, a correction, a question — the child has now been handed
  // something, so its previous completion stops counting: the supervisor may
  // not call it `done` again on the strength of a record from the last round,
  // and the orchestration exit check must see it as ALIVE again.
  if (mode !== "interrupt") {
    deps.saveRuntime(markChildAssigned(deps.runtime(), childId, new Date(deps.now()).toISOString()));
  }

  return reply(
    `review-gate: 已通过通道下发给子会话 ${childId}（mode=${mode}）。${check.verdict.summary}。\n` +
    (mode === "interrupt"
      ? "它已中断当前这一轮，并立即收到这条消息（最高优先级）。"
      : mode === "steer"
        ? "它会在当前这一轮里就读到这条消息。"
        : "它会在跑完手上这一轮之后读到这条消息。"),
    { childId, instructId, mode, delivered: true },
  );
}

