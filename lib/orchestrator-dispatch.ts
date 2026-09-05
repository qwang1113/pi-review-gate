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
import { ORCHESTRATOR_WAIT_DISCIPLINE } from "./agent-directives.ts";

import {
  openSessionPane,
  type SessionPaneDecor,
} from "./session-factory.ts";
import {
  paneColorFor,
  paneLabelFor,
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
  taskFileRelPath,
  type DeliveryEvidence,
} from "./orchestrator-delivery.ts";
import {
  appendRecord,
  newChannelId,
  type ChannelInstructRecord,
} from "./orchestrator-channel.ts";
import {
  alivePanes,
  childChannelProjection,
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
 * What this child's border says — the strings, not the tmux calls.
 *
 * WHERE THE DECORATION RUNS IS PART OF THE REQUIREMENT, not an implementation
 * taste (user, 2026-08-30). It is not a tool, not an action, and not a second
 * step the orchestrator takes after `orchestrator_spawn` returns — it is one
 * of the atomic things a spawn already does, exactly like writing the task
 * file. Since 2026-09-05 that atomicity is structural: the decoration happens
 * inside `openSessionPane` (lib/session-factory.ts) for EVERY kind of pane, so
 * this function only says what to write.
 *
 * FAILURE IS COSMETIC, ALWAYS — the factory downgrades every tmux failure here
 * to a warning string, which becomes the note below.
 */
function childPaneDecor(taskId: string, title: string, childId: string): SessionPaneDecor {
  return {
    label: paneLabelFor(taskId, title),
    colorSeed: childId,
    state: "working",
    stateForSeconds: 0,
  };
}

/** The receipt line about the border, warning included. */
function decorNote(label: string, childId: string, warning: string | undefined): string {
  if (!warning) {
    return `pane 已标记为 ${label}（${paneColorFor(childId).name}边框，标题随状态自动刷新）。`;
  }
  // The warning already says it is display-only (the factory frames it), so
  // this adds what is specific to a CHILD and nothing more — wrapping it again
  // produced "装饰没能全部生效（装饰失败（仅显示降级）：…）".
  return `${warning} —— 纯展示层，子会话本身不受影响，健康快照与通道判定照常。`;
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
  // IDENTITY CHECK FIRST (2026-09-17, user decision). This session holds an
  // orchestration identity; the sidecar may hold ANOTHER orchestration's
  // runtime (a stale plan + child registry from a previous run). Spawning
  // under the wrong identity would split panes the old orchestration still
  // owns and register children nobody can address. Refuse loudly instead of
  // silently adopting the stale runtime.
  const conflict = deps.runtimeConflict?.();
  if (conflict) {
    return fail(`review-gate: 当前会话持有新编排身份（${deps.runtime().orchestrationId}），无法继续旧编排（${conflict}）。` +
      "sidecar 里登记的是另一个 orchestration 的 runtime —— 不接管、不开 pane。" +
      "若要接手旧编排，请用同一个 RG_ORCHESTRATION_ID 启动会话（或 relay 交接）。");
  }
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
  //
  // 2026-09-15: the declared repo is resolved from the PATH itself, not
  // from knownRepoRoots membership — a task may target a checkout this
  // session has not edited yet, and the child's cwd (and therefore its
  // gate's primaryRepoRoot) must still bind to THAT repo. An unresolvable
  // repo is a fail-closed refusal, never a silent fallback to our own.
  let cwd = deps.repoRoot;
  if (task.repo) {
    const resolved = deps.resolveTaskRepo(task.repo);
    if (!resolved.ok) {
      return fail(`review-gate: 任务 "${taskId}" 声明的 repo 无法使用 —— ${resolved.reason}；` +
        "一个 pane 都没开。修正 plan 里该任务的 repo 声明后再试。");
    }
    cwd = resolved.root;
  }
  const childId = newChildId(taskId, deps.now());
  const marker = buildDeliveryMarker(taskId, deps.now());
  // CROSS-REPO FIX (2026-09-17, measured): the task file MUST land in the
  // TASK's repo (the child resolves `@.pi/tasks/<file>` against ITS cwd,
  // which is `cwd` above). Writing it into the ORCHESTRATOR's repo made a
  // cross-repo spawn hand the child a relative path it could not find —
  // pi exited at boot, the pane died, and the delivery check found nothing.
  const written = deps.writeTaskFile(
    taskFileName(marker),
    buildTaskDocument({ marker, taskId, title: task.title, brief }),
    cwd,
  );
  if (!written.ok) {
    return fail(`review-gate: 任务书写不出来（${written.error}）—— 一个 pane 都没开。`);
  }

  const decor = childPaneDecor(taskId, task.title, childId);
  const lastPane = lastChildPane(deps.runtime(), panes.panes);
  let evidence: DeliveryEvidence | undefined;
  const opened = await openSessionPane(deps.tmux, {
    ownPane: self,
    cwd,
    layout: "child-column",
    ...(lastPane === undefined ? {} : { lastChildPane: lastPane }),
    // The environment is assembled by the factory — one place for a contract
    // three different processes read (orchestration id so wake-ups survive a
    // relay, `loop` so the child does not classify itself into something else,
    // its OWN sidecar variant so supervisor and worker never overwrite each
    // other's state — F4).
    role: {
      kind: "orchestration-child",
      orchestrationId: deps.runtime().orchestrationId,
      stateVariant: childId,
    },
    // F7/F8 — the task rides in on the argv. No typing, nothing to truncate,
    // no Enter to forget. The reference is REPO-RELATIVE: the pane starts in
    // `cwd` (the task's repo), and pi expands `@.pi/tasks/<file>` against that
    // cwd — no absolute path ever reaches the child's first prompt.
    command: buildChildCommand(taskFileRelPath(taskFileName(marker)), childId),
    decor,
    // Registration rides INSIDE the open (an unregistered pane is
    // unaddressable, and the delivery probe below runs right after it).
    register: (paneId) => {
      deps.saveRuntime(registerChild(deps.runtime(), {
        id: childId,
        taskId,
        paneId,
        cwd,
        stateVariant: childId,
        taskFile: taskFileRelPath(taskFileName(marker)),
        createdAt: new Date(deps.now()).toISOString(),
        // The spawn IS the first assignment: a completion record older than
        // this belongs to whatever ran this task before (round-1 P1).
        lastAssignedAt: new Date(deps.now()).toISOString(),
      }));
      const started = applyTaskStatus(plan!, taskId, "running", { now: new Date(deps.now()).toISOString() });
      if (started.ok) deps.savePlan(started.plan);
    },
    // F8 — EARN the receipt. Nothing below claims delivery that was not seen.
    verify: async () => {
      const check = await verifyDelivery(deps, {
        kind: "spawn",
        childId,
        cwd,
        stateVariant: childId,
      });
      evidence = check.evidence;
      return check.verdict.ok
        ? { ok: true, detail: check.verdict.summary }
        : { ok: false, detail: check.verdict.reason };
    },
  });
  const evidenceLine = evidence ? describeDeliveryEvidence(evidence) : "（一条观察结果都没拿到）";
  if (!opened.ok) {
    if (!opened.deliveryFailed || !opened.paneId) {
      return fail(`review-gate: 开子会话失败 —— ${opened.error}（未登记的 pane 不可寻址，已放弃本次开会话）。`);
    }
    const failedPane = opened.paneId;
    const current = currentPlan(deps).plan;
    if (current) {
      const back = applyTaskStatus(current, taskId, "pending", {
        note: `spawn 未能确认子会话起跑（${evidenceLine}）`,
        now: new Date(deps.now()).toISOString(),
      });
      if (back.ok) deps.savePlan(back.plan);
    }
    return fail(
      `review-gate: ${opened.error}\n` +
      `观察到的证据：${evidenceLine}。\n` +
      `pane ${failedPane} 和子会话登记 ${childId} 都**保留**着（不误杀一个可能其实活着的会话），` +
      `任务 ${taskId} 已退回 pending。\n` +
      `下一步：\`orchestrator_wait({ timeoutMs: 0 })\` 看它在健康快照里是什么状态；` +
      `确认没救就 \`orchestrator_close({ childId: "${childId}" })\` 再重开。\n` +
      `任务书在：${written.path}（随 \`pi @${taskFileRelPath(taskFileName(marker))}\` 传入）`,
      { childId, paneId: failedPane, delivered: false, ...(evidence === undefined ? {} : { evidence }) },
    );
  }
  const paneId = opened.paneId;

  return reply(
    `review-gate: 子会话 ${childId} 已在 pane ${paneId} 启动（共享主工作区，同一 repo 内串行）。\n` +
    `子会话工作目录（cwd）：${cwd} —— 它的 gate 绑定这个仓库，goal 也绑这里。\n` +
    `任务 ${taskId} 已置为 running，任务书已随 \`pi @${taskFileRelPath(taskFileName(marker))}\` 带进去（落盘：${written.path}）。\n` +
    `投递已核实：${opened.deliveryNote ?? "（本次没有核实项）"}。\n` +
    `${decorNote(decor.label, childId, opened.decorWarning)}\n` +

    `${ORCHESTRATOR_WAIT_DISCIPLINE}\n` +
    "它有事找你时，wait 的回执里会直接带上完整的问题与选项，用 `orchestrator_answer` 回。",


    {
      childId,
      paneId,
      cwd,
      execution: verdict.execution,
      taskFile: taskFileRelPath(taskFileName(marker)),
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

  // STOP-FIRST (2026-09-01): the child's gate dismisses an OPEN dialog when
  // the instruction lands. Tell the PM what just got cancelled — a goal box,
  // a question, a consent — and that answering is the other tool's job.
  // STOP-FIRST (2026-09-01): steer/interrupt dismiss an OPEN dialog;
  // followUp does NOT (its whole meaning is "read this when you are done"),
  // so the cancellation notice only applies to the two stopping modes.
  const open = mode === "followUp" ? undefined : childChannelProjection(deps, childId).openRequests[0];
  const cancelledLine = open
    ? `\n本次打断同时取消了子会话的待答请求「${open.title}」—— 它不再等这个回答了；若你的本意是回答它，请用 orchestrator_answer。`
    : "";
  return reply(
    `review-gate: 已通过通道下发给子会话 ${childId}（mode=${mode}）。${check.verdict.summary}。\n` +
    (mode === "interrupt"
      ? "它已中断当前这一轮，并立即收到这条消息（最高优先级）。"
      : mode === "steer"
        ? "它会在当前这一轮里就读到这条消息。"
        : "它会在跑完手上这一轮之后读到这条消息。") +
    cancelledLine,
    { childId, instructId, mode, delivered: true },
  );
}

