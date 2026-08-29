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
import { ORCH_BASE_BRANCH_ENV, STATE_VARIANT_ENV } from "./gate-state.ts";
import { ORCHESTRATION_ID_ENV } from "./orchestration-id.ts";
import { GATE_MODE_ENV } from "./task-mode.ts";
import {
  buildSendMessageArgv,
  buildSpawnPaneArgv,
  parseSpawnedPaneId,
} from "./orchestrator-tmux.ts";
import { applyTaskStatus, scheduleNextTasks, type PlanTask } from "./orchestrator-plan.ts";
import { proxyApprovalProblems, spawnAuthorization, worktreeRequirement } from "./orchestrator-gate.ts";
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
  echoMarker,
  planSend,
  SEND_INLINE_MAX_CHARS,
  taskFileName,
} from "./orchestrator-delivery.ts";
import {
  describeStartupEvidence,
  dialogIsOpen,
  formatPaneSnapshot,
  type PaneSnapshot,
} from "./orchestrator-pane-read.ts";
import { APPROVE_LABEL_PATTERN } from "./orchestrator-keys.ts";
import { screenLooksBusy } from "./orchestrator-child-state.ts";
import { normalizeGoalText } from "./loop-goal.ts";
import { captureDialog, selectOptionInChild } from "./orchestrator-read-tools.ts";
import type { ChildSession } from "./orchestrator-registry.ts";
import {
  alivePanes,
  capturePane,
  childGateFacts,
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

  // Read BEFORE the worktree is created: `addWorktree` checks out a fresh
  // `orch/...` branch, and reading the base afterwards from a child's own
  // directory would hand it exactly the wrong answer (R3-6).
  const orchestrationBase = deps.currentBranch();


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
    // R3-6 — WHERE ITS WORK HAS TO LAND. A child in a gate-created worktree
    // stands on `orch/<task>-<stamp>`, so "the branch I am on" is the wrong
    // default for its base: the third run had a whole lane merge into that
    // scratch branch and stop there. The orchestration's base is known HERE,
    // so it is stated here rather than guessed there.
    ...(orchestrationBase ? { [ORCH_BASE_BRANCH_ENV]: orchestrationBase } : {}),
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
    // The spawn IS the first assignment: a completion record older than this
    // belongs to whatever ran in that worktree before (round-1 P1).
    lastAssignedAt: new Date(deps.now()).toISOString(),
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

/**
 * CONSTRAINT 8, done against the TRUTH (R-7).
 *
 * What it used to do: boundary-check the text the CALLER typed into
 * `approveGoal`, and then press "认可" on whatever was actually on screen.
 * Those are two different documents. Measured on 2026-08-30: the orchestrator
 * passed an abridged goal (3 exit criteria, no non-goals section), the check
 * passed, and the FULL goal (7 criteria) was approved on the user's behalf —
 * so the mechanical guarantee of constraint 8 rested entirely on the
 * orchestrator transcribing honestly. Worse, R-6's path false-positives were
 * actively pushing it to rewrite the text to get through.
 *
 * Now the caller expresses INTENT ("approve it") and the gate reads the draft
 * from the child's own sidecar (`goalPrereview.draft` — the data F10 pointed
 * at) and checks THAT. A caller-supplied text is not compared and cannot
 * widen anything; when it differs from the sidecar, the receipt says so,
 * because a mismatch means the orchestrator was looking at something else.
 */
async function approveChildGoal(
  deps: OrchestratorDeps,
  child: ChildSession,
  supplied: unknown,
): Promise<ToolReply> {
  const childId = child.id;
  const { plan } = currentPlan(deps);
  const task = plan?.tasks.find((t) => t.id === child.taskId);
  if (!task) {
    return fail(`review-gate: 找不到子会话 "${childId}" 对应的任务 "${child.taskId}"，无法做边界比对。`);
  }
  const facts = childGateFacts(deps, child);
  const draft = facts.goalDraft;
  if (!draft) {
    return fail(
      `review-gate: 代批被拒 —— 读不到子会话 ${childId} sidecar 里的 goal 草稿` +
      "（`goalPrereview.draft`）。门禁只批**它自己读到的那一份**，不批调用方手抄的文本（R-7）。\n" +
      "先确认它确实已经把草稿提交给了 goal-auditor / 正在等批准，再重试。",
      { childId, approved: false, boundaryOk: false },
    );
  }
  // R3-1 — CONSTRAINT 8 IS JUDGED ON FILES, NOT ON PROSE. The draft is still
  // read from the child's own sidecar (R-7) and still echoed in the receipt,
  // but what decides the approval is where this child has actually written:
  // a documentation goal that quotes the modules it documents is not a scope
  // change, and treating it as one cost two bypasses in the third run.
  const check = proxyApprovalProblems(facts.editedFiles, task);
  if (!check.ok) return fail("review-gate: " + check.reason, { outside: check.outside });

  // R3-2 — this note is about a STRING the caller passed, so it may only
  // appear when one was passed. `approveGoal: true` (the normal call) carries
  // no text at all, and the third run still saw "你传进来的文本与 sidecar 不
  // 一致" on a boolean call — sending the orchestrator off to re-read a child
  // for a copy it never held.
  const suppliedText = typeof supplied === "string" ? supplied.trim() : "";
  const mismatchNote =
    suppliedText && normalizeGoalText(suppliedText) !== normalizeGoalText(draft)
      ? "\n注意：你在 `approveGoal` 里传的那段**字符串**与 sidecar 里的真实草稿不一致 —— " +
        "门禁比对并批准的是 sidecar 那一份（你手上的可能已经过时了，建议 `orchestrator_read` 重看一遍）。"
      : "";

  // F11 — the boundary check is only HALF the job. The old code stopped here
  // and reported "已过边界比对", which the caller reasonably read as
  // "approved"; in reality the approval dialog was sitting untouched in the
  // child's pane. Approving means ANSWERING that dialog, verifiably.
  const snapshot = await captureDialog(deps, child.paneId);
  const approveIndex = findApprovalOption(snapshot);
  if (approveIndex === undefined) {
    // R-18 — do NOT bounce the caller to a path that just failed. The screen
    // has already been re-read several times here; say which of the two
    // situations it actually is.
    const options = snapshot?.dialog?.options ?? [];
    return fail(
      "review-gate: 边界比对通过（约束 8，比的是 sidecar 里的真实草稿），**但代批没有真的执行** —— " +
      (options.length === 0
        ? "重读了几次，子会话屏幕上都没有待答的对话框（它可能还没提交批准、或者已经被答掉了）。\n" +
          `先 \`orchestrator_read({ childId: "${childId}" })\` 确认它到底在等什么。`
        : "屏幕上的框里找不到唯一一个「认可/批准」选项，不能盲按。现有选项：" +
          options.map((o) => `${o.index}. ${o.label}`).join(" / ") +
          `\n用 \`orchestrator_key({ childId: "${childId}", index: <第几项> })\` 亲自答它（那条路径带命中校验）。`),
      { childId, boundaryOk: true, approved: false, options: options.length },
    );
  }
  const answered = await selectOptionInChild(deps, child, { index: approveIndex });
  if (answered.isError) return answered;
  return reply(
    "review-gate: 代批完成 —— 先拿子会话 sidecar 里的真实 goal 草稿过任务边界比对（约束 8），" +
    "再在它的对话框上选中并提交了「认可」项。" + mismatchNote + "\n" +
    `被批准的草稿（来源：sidecar goalPrereview.draft，共 ${draft.length} 字）前 200 字：\n${draft.slice(0, 200)}\n\n` +
    answered.content.map((c) => c.text).join("\n"),
    { childId, boundaryOk: true, approved: true, draftChars: draft.length },
  );
}


/**
 * How long the gate waits for a busy child to free up before it gives up on
 * delivering a COMMAND (R-20).
 *
 * A command typed into a busy session does not run — it lands in the steering
 * queue as an ordinary message, which is how a `/gate-bypass` "took effect"
 * without taking effect. Rather than making the orchestrator poll the screen
 * by hand for the idle window (the hand-run's downgrade), the gate waits for
 * it here, and REFUSES honestly if it never comes.
 */
export const COMMAND_WINDOW_ATTEMPTS = 15;
export const COMMAND_WINDOW_INTERVAL_MS = 2000;

/** Wait until the child is not visibly running a tool. */
async function waitForIdleWindow(
  deps: OrchestratorDeps,
  paneId: string,
  attempts = COMMAND_WINDOW_ATTEMPTS,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    if (attempt > 0) await deps.sleep(COMMAND_WINDOW_INTERVAL_MS);
    const snapshot = capturePane(deps, paneId);
    if (!snapshot) return { ok: false, reason: "读不到它的屏幕（capture-pane 失败），不敢投命令" };
    if (dialogIsOpen(snapshot)) return { ok: false, reason: "它现在有一个打开的对话框，先答框再说" };
    if (!screenLooksBusy(snapshot.text)) return { ok: true };
  }
  return {
    ok: false,
    reason:
      `等了 ${Math.round((COMMAND_WINDOW_INTERVAL_MS * attempts) / 1000)}s 它一直在跑工具 —— ` +
      "此刻投过去的命令只会排进 steering 队列、当成普通消息读掉，**不会**被执行",
  };
}

export async function dispatchSend(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const childId = String(params.childId ?? "").trim();
  const child = findChild(deps.runtime(), childId);
  if (!child) return fail(`review-gate: 没有登记过子会话 "${childId}"。`);
  if (child.closedAt) return fail(`review-gate: 子会话 "${childId}" 已经关闭了。`);

  const message = String(params.message ?? "").trim();
  const approveRaw = params.approveGoal;
  const wantsApproval = approveRaw !== undefined && approveRaw !== false && approveRaw !== "";
  const kind: "message" | "command" =
    String(params.kind ?? "").trim().toLowerCase() === "command" ? "command" : "message";
  if (!message && !wantsApproval) return fail("review-gate: 要发的内容是空的。");

  // CONSTRAINT 8 — proxy-approving a child's goal is allowed, but only inside
  // the task's declared boundary. Outside it, this is a scope change, and
  // scope is the user's.
  if (wantsApproval) return approveChildGoal(deps, child, approveRaw);

  // R-13 — THE ACCIDENT. A dialog was open, a long message went in through
  // `send-keys`, and the newlines inside it were read by the TUI as "submit
  // the highlighted row": the child recorded option A as the project
  // manager's answer while the user had actually decided C, and BOTH receipts
  // said only that delivery could not be confirmed. Nothing may be typed at a
  // child that is holding a question.
  const guard = await captureDialog(deps, child.paneId);
  if (dialogIsOpen(guard)) {
    return fail(
      `review-gate: 子会话 ${childId} 现在有一个**打开的对话框**，拒绝投文本。\n` +
      "原因是一次真实事故（R-13）：文本经 send-keys 打进去时，其中的换行会被 TUI 当成" +
      "「提交当前高亮项」，于是编排层替子会话答了一个它根本没打算选的选项，而两边都以为什么都没发生。\n" +
      `先用 \`orchestrator_read({ childId: "${childId}" })\` 看清这个框，用 \`orchestrator_key\` 答掉它，再发文本。\n\n` +
      (guard ? formatPaneSnapshot(guard, 40) : ""),
      { childId, delivered: false, dialogOpen: true },
    );
  }

  // R-20 — a COMMAND only runs when it is typed into an idle composer.
  if (kind === "command") {
    if (message.includes("\n") || message.length > SEND_INLINE_MAX_CHARS) {
      return fail(
        "review-gate: 命令必须是一行短文本（slash 命令走输入框提交），多行/超长内容请用 `kind: \"message\"` 发。",
        { childId, delivered: false },
      );
    }
    const window = await waitForIdleWindow(deps, child.paneId);
    if (!window.ok) {
      return fail(
        `review-gate: 命令没有投出去 —— ${window.reason}。什么都没发（宁可不发，也不把命令降级成一条消息）。\n` +
        "稍后重试，或者改用 `kind: \"message\"` 明确地只发一条说明。",
        { childId, delivered: false, kind },
      );
    }
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
  const lane = check.verdict.lane ?? "submitted";
  // NEW WORK UN-FINISHES A CHILD (round-1 P1). Whatever this text is — the
  // next task, a correction, a question — the child has now been handed
  // something, so its previous completion stops counting: the probe may not
  // call it `done` again on the strength of a record from the last round, and
  // the orchestration exit check must see it as ALIVE again. Stamped for the
  // steering-queue lane too: a queued message is still read by the child.
  deps.saveRuntime(markChildAssigned(deps.runtime(), childId, new Date(deps.now()).toISOString()));
  // A command that ended up in the queue did NOT run. Saying "delivered"
  // there is the R-20 trap: the orchestrator waits for an effect that will
  // never happen.
  if (kind === "command" && lane === "queued") {
    return fail(
      `review-gate: 这条命令**没有被执行** —— 它进了 steering 队列（子会话在投递的瞬间又忙了起来），` +
      "会被当成一条普通消息读掉。要么稍后重试，要么明确改用 `kind: \"message\"`。",
      { childId, delivered: true, executed: false, lane, evidence: check.evidence },
    );
  }
  return reply(
    `review-gate: 已发给子会话 ${childId}（pane ${child.paneId}）` +
    (mode.kind === "file" ? "，正文写成文件、只把路径敲了进去（长文本不走键盘）" : "") +
    `。投递已核实：${check.verdict.summary}。\n` +
    `送达通道：${lane === "submitted" ? "输入框已提交" : "steering 队列"}` +
    `（本次意图：${kind === "command" ? "作为命令执行" : "只是一条消息"}）。`,
    { childId, delivered: true, lane, kind, executed: kind === "command" },
  );

}
