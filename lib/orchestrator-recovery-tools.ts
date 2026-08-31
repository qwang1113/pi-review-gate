/**
 * DEATH IS SURVIVABLE — `orchestrator_recover` and `orchestrator_attach`.
 *
 * THE PREMISE (task book §4): a process is a replaceable OPERATOR, and all
 * the state is on disk. A child's work branch, its checkpoints, its review
 * verdict and its whole transcript belong to git and to the sidecar, and none
 * of them noticed that a pane went away. So there are exactly three deaths
 * and they share one mechanism:
 *
 *  - THE CHILD DIED (crash, a stray kill-pane, a machine that slept). Its
 *    pane is gone, everything else is not. `orchestrator_recover` re-opens
 *    `pi --session-id <its own id>` in a fresh pane: the transcript continues,
 *    the registry is re-pointed at the new pane, and the plan task stays
 *    `running` because nothing about it stopped being true.
 *  - THE ORCHESTRATOR DIED. Its children never noticed — their dialogs are
 *    still up and a human can still answer them, which is the fallback the
 *    channel design gets for free. `orchestrator_attach` lets a NEW session
 *    take the orchestration over by its id: same plan, same channels, same
 *    children, nothing restarted.
 *  - THE TMUX SERVER DIED / THE MACHINE REBOOTED. Same as the above, both at
 *    once. `orchestrator_attach` reports the ORPHANS it finds — tasks marked
 *    `running` with no live pane — because that is the only inconsistency a
 *    reboot can leave behind, and an orchestrator that is not told about it
 *    will wait forever on a child that no longer exists.
 *
 * WHY RECOVERY IS A TOOL AND NOT A RECIPE (philosophy one): doing it by hand
 * is a split-window with the right env, the right cwd, the right session id,
 * a registry write and a plan write — five steps, each of which silently
 * breaks supervision if it is skipped. The orchestrator expresses INTENT
 * ("bring c1 back"); the gate does all five.
 */

import { Type } from "typebox";
import type { OrchestratorDeps, ToolHost, ToolReply } from "./orchestrator-deps.ts";
import { STATE_VARIANT_ENV } from "./gate-state.ts";
import { ORCHESTRATION_ID_ENV, normalizeOrchestrationId } from "./orchestration-id.ts";
import { GATE_MODE_ENV } from "./task-mode.ts";
import { buildSpawnPaneArgv, parseSpawnedPaneId } from "./orchestrator-tmux.ts";
import {
  buildRecoverCommand,
  buildRecoveryNote,
  childSessionId,
  taskFileName,
} from "./orchestrator-delivery.ts";
import {
  findChild,
  lastChildPane,
  type ChildSession,
  type OrchestratorRuntime,
} from "./orchestrator-registry.ts";
import { superviseChildren, formatSupervisionReceipt } from "./orchestrator-supervisor.ts";
import {
  alivePanes,
  childAssets,
  currentPlan,
  requireOrchestratorMode,
  toolFail as fail,
  toolReply as reply,
} from "./orchestrator-tool-kit.ts";

/** A task the plan believes is running while nothing is. */
export interface OrphanTask {
  taskId: string;
  childId?: string;
  reason: string;
}

/**
 * Tasks marked `running` that no live child is working on.
 *
 * Two shapes, and the receipt must distinguish them: a task whose child is
 * registered but dead can be RECOVERED, while a task with no child at all
 * (the registry was lost, or the child was never registered) can only be
 * re-spawned. Pure: facts in, a list out.
 */
export function detectOrphans(
  runtime: OrchestratorRuntime,
  runningTaskIds: readonly string[],
  livePaneIds: ReadonlySet<string> | undefined,
): OrphanTask[] {
  if (livePaneIds === undefined) return []; // liveness unknown ⇒ claim nothing
  const orphans: OrphanTask[] = [];
  for (const taskId of runningTaskIds) {
    const child = runtime.children.find((c) => c.taskId === taskId && !c.closedAt);
    if (!child) {
      orphans.push({ taskId, reason: "plan 说它在跑，但登记表里没有任何还开着的子会话" });
      continue;
    }
    if (!livePaneIds.has(child.paneId)) {
      orphans.push({
        taskId,
        childId: child.id,
        reason: `子会话 ${child.id} 的 pane ${child.paneId} 已经不在了`,
      });
    }
  }
  return orphans;
}

/** Environment a recovered (or freshly attached) child pane is given. */
function childEnv(deps: OrchestratorDeps, child: ChildSession): Record<string, string> {
  return {
    [ORCHESTRATION_ID_ENV]: deps.runtime().orchestrationId,
    [GATE_MODE_ENV]: "loop",
    [STATE_VARIANT_ENV]: child.stateVariant ?? child.id,
  };
}

async function doRecover(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const childId = String(params.childId ?? "").trim();
  const runtime = deps.runtime();
  const child = findChild(runtime, childId);
  if (!child) return fail(`review-gate: 没有登记过子会话 "${childId}"。`);
  if (child.closedAt) {
    return fail(
      `review-gate: 子会话 "${childId}" 是被 orchestrator_close 主动关掉的（${child.closedAt}），` +
      "不是死掉的。要重做这个任务就 `orchestrator_spawn` 开一个新的。",
    );
  }
  const panes = alivePanes(deps);
  if (!panes.ok) {
    return fail(
      "review-gate: 读不到 tmux pane 列表，无法确认它到底死没死 —— 不敢重开（重开一个其实还活着的会话，" +
      "会得到两个进程写同一个工作区）。先修好 tmux 再试。",
    );
  }
  if (panes.panes.includes(child.paneId)) {
    // ROUND-4 P0 — THE LINE THAT USED TO BE HERE WAS THE DEFECT. It said
    // "if it is just stuck, interrupt it first", and both children it was
    // ever printed about were healthy: they were sitting in `judge_wait`
    // waiting for their own reviewers, misreported as `stalled` because the
    // heartbeat rode on agent events. An orchestrator that had followed this
    // advice would have aborted a running review round — the only measured
    // case of the gate's own instructions making things worse. Interrupting
    // is NEVER suggested here now: a live pane means there is nothing to
    // recover, and what to do about it is a question for the health snapshot.
    return fail(
      `review-gate: 子会话 ${childId} 的 pane ${child.paneId} 还活着 —— 拒绝重开` +
      "（重开一个还活着的会话，会得到两个进程写同一个工作区）。\n" +
      "先看 `orchestrator_wait({timeoutMs:0})` 的健康快照：\n" +
      "  - `waiting-judge`：它在等自己派出去的 reviewer / precommit，**完全正常，不要打断**，等着就好；\n" +
      "  - `waiting-input`：它在等回答，用 `orchestrator_answer` 回它；\n" +
      "  - `working`：它在干活；\n" +
      "  - `stalled`：心跳真的停了 —— 那就是放弃它（`orchestrator_close`）的场景，" +
      "而不是打断：门禁都不应答的进程，打断不会让它复活。",
      { childId, recovered: false },
    );

  }

  const reason = String(params.reason ?? "").trim() || "pane 消失";
  const note = deps.writeScratchFile(
    taskFileName(`rg-recover-${childId}-${Math.floor(deps.now()).toString(36)}`),
    buildRecoveryNote({ childId, taskId: child.taskId, reason }),
  );
  if (!note.ok) return fail(`review-gate: 恢复说明写不出来（${note.error}）—— 什么都没做。`);

  const self = deps.ownPane();
  if (!self) return fail("review-gate: 读不到自己的 pane（$TMUX_PANE），无法开新 pane。");
  const last = lastChildPane(runtime, panes.panes);
  let paneId: string;
  try {
    const result = deps.tmux(buildSpawnPaneArgv({
      orchestratorPane: self,
      ...(last ? { lastChildPane: last } : {}),
      cwd: child.cwd,
      env: childEnv(deps, child),
      command: buildRecoverCommand(child.id, note.path),
    }));
    if (!result.ok) return fail(`review-gate: 重开 pane 失败 —— ${result.stderr || "tmux split-window 出错"}`);
    const spawned = parseSpawnedPaneId(result.stdout);
    if (!spawned) return fail("review-gate: tmux 没有回报新 pane 的 id —— 无法登记，已放弃。");
    paneId = spawned;
  } catch (error) {
    return fail(`review-gate: 重开 pane 失败 —— ${(error as Error).message}`);
  }

  // The registry is re-pointed rather than re-created: the child KEEPS its id,
  // its worktree and its task, because none of those died with the process.
  // Its completion record is cleared for the same reason a new assignment
  // clears it — whatever it had finished, it is being asked to carry on now.
  const now = new Date(deps.now()).toISOString();
  deps.saveRuntime({
    ...runtime,
    children: runtime.children.map((c) =>
      c.id === child.id
        ? { ...c, paneId, lastAssignedAt: now, taskFile: note.path, doneAt: undefined }
        : c,
    ),
  });

  const assets = childAssets(deps, child);
  return reply(
    `review-gate: 子会话 ${childId} 已用同一个 session id（\`${childSessionId(childId)}\`）在 pane ${paneId} 重开 —— ` +
    "它的 transcript 是接着上次的，不是从头来。\n" +
    `任务 ${child.taskId} 保持 running（它本来就没有停止成立）；登记表已指向新 pane。\n` +
    "它死前留下的资产：" +
    `${assets?.reviewVerdict ? `review 裁决 ${assets.reviewVerdict}` : ""}` +
    `${assets?.checkpoint ? `、checkpoint \`${assets.checkpoint.slice(0, 12)}\`` : ""}。\n` +
    "接着用 `orchestrator_wait` 等它 —— 它重开后会自己在通道上报状态。",
    { childId, paneId, recovered: true, sessionId: childSessionId(childId) },
  );
}

async function doAttach(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const wanted = normalizeOrchestrationId(params.orchestrationId);
  if (!wanted) {
    return fail(
      "review-gate: orchestrationId 不像一个门禁铸造的编排 id（形如 `orch-<repoHash>-<stamp>`）。" +
      "它写在上一任项目经理的交接文档里，也在每个子会话的 RG_ORCHESTRATION_ID 环境变量里。",
    );
  }
  const runtime = deps.runtime();
  if (runtime.orchestrationId !== wanted) {
    return fail(
      `review-gate: 本会话持有的编排是 ${runtime.orchestrationId}，不是 ${wanted}。\n` +
      "接管一个编排的正确做法是**带着它的 id 启动**（`RG_ORCHESTRATION_ID=<id> pi`）—— " +
      "这正是 orchestrator_handoff 给后继者做的事。一个会话不能在运行中改换编排身份：" +
      "它已经登记的子会话会瞬间失去归属。",
      { attached: false },
    );
  }

  const panes = alivePanes(deps);
  const live = panes.ok ? new Set(panes.panes) : undefined;
  const open = runtime.children.filter((c) => !c.closedAt);
  const snapshot = superviseChildren({
    orchestrationId: runtime.orchestrationId,
    children: open,
    livePanes: live,
    io: deps.channelIO(),
    ...(deps.channelHome() === undefined ? {} : { home: deps.channelHome()! }),
    at: deps.now(),
    assetsFor: (child) => childAssets(deps, child),
  });
  const { plan, problem } = currentPlan(deps);
  if (problem) return problem;
  const running = (plan?.tasks ?? []).filter((t) => t.status === "running").map((t) => t.id);
  const orphans = detectOrphans(runtime, running, live);

  const lines = [
    `review-gate: 已接管编排 ${runtime.orchestrationId}。子会话完全无感 —— 通道是文件路径，不属于任何进程。`,
    "",
    "### 0. plan",
    plan
      ? `《${plan.title}》共 ${plan.tasks.length} 个任务：` +
        plan.tasks.map((t) => `${t.id}(${t.status ?? "pending"})`).join("、")
      : "（还没有 plan —— 先 `orchestrator_plan` 写一份并请用户批准）",
    "",
    formatSupervisionReceipt(snapshot),
    "",
    "### 4. 孤儿任务",
  ];
  if (!panes.ok) {
    lines.push("读不到 tmux pane 列表，本次不做孤儿判定（读不到不等于死了）。");
  } else if (orphans.length === 0) {
    lines.push("（没有「plan 说在跑、实际没人在做」的任务）");
  } else {
    for (const orphan of orphans) {
      lines.push(
        `- 任务 ${orphan.taskId}：${orphan.reason}。` +
        (orphan.childId
          ? `恢复：\`orchestrator_recover({childId:"${orphan.childId}"})\`（续同一 transcript）。`
          : `恢复：\`orchestrator_spawn({taskId:"${orphan.taskId}"})\` 重新派活。`),
      );
    }
  }
  return reply(lines.join("\n"), {
    attached: true,
    orchestrationId: runtime.orchestrationId,
    children: open.length,
    openRequests: snapshot.requests.length,
    orphans: orphans.length,
  });
}

/** Register the two recovery tools. */
export function registerOrchestratorRecoveryTools(host: ToolHost, deps: OrchestratorDeps): void {
  const guarded = (run: (params: Record<string, unknown>) => Promise<ToolReply>) =>
    async (_id: string, params: Record<string, unknown>): Promise<ToolReply> => {
      const refusal = requireOrchestratorMode(deps);
      if (refusal) return refusal;
      return run(params);
    };

  host.registerTool({
    name: "orchestrator_recover",
    label: "Recover A Dead Child Session",
    description:
      "Bring a child session back after its pane vanished (crash, a stray kill, a machine that " +
      "slept). The gate re-opens `pi --session-id <that child's own id>` in a fresh pane, so its " +
      "TRANSCRIPT continues rather than starting over, then re-points the registry at the new " +
      "pane and leaves the plan task `running` — nothing about it stopped being true. It REFUSES " +
      "when the pane is actually still alive (two processes in one worktree is worse than a stuck " +
      "child) and when tmux cannot be read at all. Its branch, checkpoints and review verdict " +
      "survived the death and are named in the receipt.",
    parameters: Type.Object({
      childId: Type.String({ description: "Registry handle of the dead child" }),
      reason: Type.Optional(Type.String({ description: "What happened, for the child's own note" })),
    }),
    execute: guarded((params) => doRecover(deps, params)),
  });

  host.registerTool({
    name: "orchestrator_attach",
    label: "Take Over An Orchestration",
    description:
      "Take over a running orchestration and get the whole scene back in one reply: the plan and " +
      "its task states, every child with its state / branch / progress, the questions still " +
      "waiting for an answer in the channels, and the ORPHANS — tasks the plan calls `running` " +
      "with no live pane behind them, which is the one inconsistency a crash or a reboot leaves " +
      "and the one an orchestrator would otherwise wait on forever. Nothing is restarted and no " +
      "child notices: the channels are file paths, not processes. The session must already CARRY " +
      "the orchestration id in its environment (that is what `orchestrator_handoff` gives a " +
      "successor); a session cannot change orchestration identity while running.",
    parameters: Type.Object({
      orchestrationId: Type.String({ description: "The orchestration to take over (orch-…)" }),
    }),
    execute: guarded((params) => doAttach(deps, params)),
  });
}
