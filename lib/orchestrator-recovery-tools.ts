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
import { normalizeOrchestrationId } from "./orchestration-id.ts";
import {
  buildTakeoverRoute,
  decideTakeover,
  discoverOrchestrations,
} from "./orchestrator-takeover.ts";
import { openSessionPane, paneRecoverability } from "./session-factory.ts";
import { paneLabelFor } from "./orchestrator-pane-decor.ts";
import { findOrphanWorktrees } from "./orchestrator-worktree.ts";
import {
  buildRecoverCommand,
  buildRecoveryNote,
  childSessionId,
  taskFileName,
  taskFileRelPath,
} from "./orchestrator-delivery.ts";
import {
  findChild,
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

/**
 * The task title a recovered pane's border shows.
 *
 * The plan is the only place a human-readable title exists; without it the
 * border would read `@t1-t1`, which tells nobody anything at 3am. A missing or
 * unreadable plan degrades to the id — cosmetic, never fatal.
 */
function recoveredTaskTitle(deps: OrchestratorDeps, taskId: string): string {
  const { plan } = currentPlan(deps);
  return plan?.tasks.find((task) => task.id === taskId)?.title ?? taskId;
}

async function doRecover(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const childId = String(params.childId ?? "").trim();
  const runtime = deps.runtime();
  const child = findChild(runtime, childId);
  const panes = alivePanes(deps);
  // ONE recovery judgement, shared with `judge_recover`
  // (lib/session-factory.ts). Both tools refuse the same four situations — an
  // unknown handle, a deliberately closed session, a pane that is still alive,
  // and unreadable liveness — so the pair can no longer drift into two
  // slightly different safeties. Only the WORDING below is local.
  const verdict = paneRecoverability({
    registered: Boolean(child),
    ...(child?.closedAt === undefined ? {} : { closedAt: child.closedAt }),
    ...(child?.paneId === undefined ? {} : { paneId: child.paneId }),
    paneAlive: child && panes.ok ? panes.panes.includes(child.paneId) : undefined,
  });
  if (verdict === "unknown" || !child) return fail(`review-gate: 没有登记过子会话 "${childId}"。`);
  if (verdict === "closed") {
    return fail(
      `review-gate: 子会话 "${childId}" 是被 orchestrator_close 主动关掉的（${child.closedAt}），` +
      "不是死掉的。要重做这个任务就 `orchestrator_spawn` 开一个新的。",
    );
  }
  if (verdict === "no-pane") {
    return fail(
      `review-gate: 子会话 "${childId}" 没有登记 pane —— 它可能从来没成功开出来，` +
      "用 `orchestrator_spawn` 重新派活，而不是恢复。",
    );
  }
  if (verdict === "unknown-liveness") {
    return fail(
      "review-gate: 读不到 tmux pane 列表，无法确认它到底死没死 —— 不敢重开（重开一个其实还活着的会话，" +
      "会得到两个进程写同一个工作区）。先修好 tmux 再试。",
    );
  }
  if (verdict === "alive") {
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
  const noteName = taskFileName(`rg-recover-${childId}-${Math.floor(deps.now()).toString(36)}`);
  const note = deps.writeTaskFile(
    noteName,
    buildRecoveryNote({ childId, taskId: child.taskId, reason }),
    // The note must land in the CHILD's declared repo: the recovered pane
    // opens with cwd=child.cwd and resolves `@.pi/tasks/<note>` against it.
    child.cwd,
  );
  if (!note.ok) return fail(`review-gate: 恢复说明写不出来（${note.error}）—— 什么都没做。`);

  const self = deps.ownPane();
  if (!self) return fail("review-gate: 读不到自己的 pane（$TMUX_PANE），无法开新 pane。");
  const now = new Date(deps.now()).toISOString();
  const opened = await openSessionPane(deps.tmux, {
    ownPane: self,
    cwd: child.cwd,
    layout: "child-column",
    // Same env as the original spawn — including the sidecar variant, which is
    // ALSO what exempts a child from the session-exclusivity guard: a recovered
    // pane without it would be refused at boot as a second session in the
    // worktree.
    role: {
      kind: "orchestration-child",
      orchestrationId: deps.runtime().orchestrationId,
      stateVariant: child.stateVariant ?? child.id,
    },
    command: buildRecoverCommand(child.id, taskFileRelPath(noteName)),
    decor: {
      label: paneLabelFor(child.taskId, recoveredTaskTitle(deps, child.taskId)),
      colorSeed: child.id,
      state: "working",
      stateForSeconds: 0,
    },
    // The registry is re-pointed rather than re-created: the child KEEPS its
    // id, its cwd and its task, because none of those died with the process.
    // The new assignment stamp is what makes its OLD completion history
    // rather than a verdict (there is no cached `doneAt` to clear — B4).
    register: (paneId) => {
      deps.saveRuntime({
        ...deps.runtime(),
        children: deps.runtime().children.map((c) =>
          c.id === child.id
            ? { ...c, paneId, lastAssignedAt: now, taskFile: taskFileRelPath(noteName) }
            : c,
        ),
      });
    },
  });
  if (!opened.ok) return fail(`review-gate: 重开 pane 失败 —— ${opened.error}`);
  const paneId = opened.paneId;

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

/**
 * TAKE OVER AN ORCHESTRATION — including one this session did NOT inherit.
 *
 * WHAT CHANGED AND WHY (2026-09-06, B1). This tool used to require the id to
 * be in the session's own environment: "a session cannot change orchestration
 * identity while running". Half of that sentence is true and is still
 * enforced — a session that has ALREADY REGISTERED CHILDREN cannot change
 * identity, because those children would instantly lose their supervisor. But
 * the other half turned the tool into a no-op for the situation it was
 * written for: a project manager whose session died leaves a plan and a child
 * registry behind, and the successor is by definition a session that did NOT
 * inherit anything. It was refused here, refused at `set_gate_mode` for the
 * same reason, and the only remaining move was to delete the gate's own plan
 * file by hand (measured three times).
 *
 * So the id is now ADOPTED rather than merely confirmed, under the four
 * conditions in {@link decideTakeover} — the strongest of which is that the
 * id must be discoverable ON DISK, so naming one is never enough to mint an
 * address nobody is listening on.
 *
 * The APPROVAL is deliberately not part of the inheritance (user decision,
 * 2026-09-06): a plan approval is permission the user gave to a session that
 * is gone, so the new holder submits it again. The registry IS inherited,
 * because those panes exist whatever any session believes.
 */
async function doAttach(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const candidates = discoverOrchestrations({
    repoRoot: deps.repoRoot,
    ...(deps.recordedRuntime() === undefined ? {} : { recorded: deps.recordedRuntime()!.orchestrationId }),
    channelDirNames: () => deps.channelDirNames(),
  });
  const held = deps.runtime();
  const wanted = normalizeOrchestrationId(params.orchestrationId);
  let adopted = false;
  if (wanted !== held.orchestrationId) {
    const decision = decideTakeover({
      wanted: params.orchestrationId,
      repoRoot: deps.repoRoot,
      candidates,
      ownChildren: held.children,
      currentId: held.orchestrationId,
    });
    if (!decision.ok) {
      return fail(
        `review-gate: ${decision.reason}\n\n` +
        buildTakeoverRoute({ candidates, attempting: "接管一个编排" }),
        { attached: false },
      );
    }
    deps.adoptOrchestrationId(decision.id);
    adopted = true;
    // B2 — a takeover changes WHO holds an orchestration. That belongs in the
    // log beside the approvals: it is the event that explains why a later
    // record was written by a different session.
    deps.log(
      `orchestrator ${decision.id} taken over by this session ` +
      `(was holding ${held.orchestrationId}, id found via ${decision.source})`,
    );
  }

  // Re-read: adoption changed which runtime this session sees (the registry
  // the previous holder left behind is now ours).
  const runtime = deps.runtime();
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
    adopted
      ? `review-gate: 已接管编排 ${runtime.orchestrationId}（本会话原先持有的是另一个身份，现已改为它）。` +
        "子会话完全无感 —— 通道是文件路径，不属于任何进程。"
      : `review-gate: 已接管编排 ${runtime.orchestrationId}。子会话完全无感 —— 通道是文件路径，不属于任何进程。`,
    "",
    "### 0. plan",
    plan
      ? `《${plan.title}》共 ${plan.tasks.length} 个任务：` +
        plan.tasks.map((t) => `${t.id}(${t.status ?? "pending"})`).join("、")
      : "（还没有 plan —— 先 `orchestrator_plan` 写一份并请用户批准）",
    // THE APPROVAL DOES NOT COME WITH IT (user decision, 2026-09-06). The
    // registry is a fact about the world; the approval was permission given
    // to a session that is gone. Saying so here is the difference between a
    // manager that re-submits and one that sits waiting for a spawn that will
    // never be authorized.
    ...(plan && runtime.approvedPlanHash === undefined
      ? [
          "",
          "⚠️ 这份 plan 在门禁眼里**尚未获批**：批准是用户给上一任会话的许可，不随接管转移。" +
          "要继续派活，先 `orchestrator_plan({ action: \"submit\" })` 重新走一遍审计与用户批准" +
          "（内容没变的话，审计通常很快）。",
        ]
      : []),
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
  // ### 5 — THE CHECKOUTS NOBODY SETTLED (2026-09-10). A crash or a restart is
  // the one thing that leaves a worktree with no live child and no decision on
  // record, and an orphan nobody is told about is an orphan nobody reclaims.
  // It is REPORTED, never reaped: the work in it may be the only copy.
  const orphanWorktrees = findOrphanWorktrees(
    runtime.children,
    panes.ok ? panes.panes : undefined,
  );
  lines.push("", "### 5. 未结算的隔离 worktree");
  if (!panes.ok) {
    lines.push("（pane 列表读不到，本次不做判定 —— 读不到不等于没人用）");
  } else if (orphanWorktrees.length === 0) {
    lines.push("（没有遗留的隔离 checkout）");
  } else {
    for (const w of orphanWorktrees) {
      lines.push(
        `- ${w.childId}（任务 ${w.taskId}）：${w.path}，分支 \`${w.branch}\`。` +
        "里面可能是唯一的副本，所以门禁不会自行回收 —— 看过之后用 " +
        `\`orchestrator_close({childId:"${w.childId}", worktree:"merge"|"discard"})\` 决定它的去向。`,
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
      "child) and when tmux cannot be read at all. Its checkpoints and review verdict " +
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
      "child notices: the channels are file paths, not processes. It ADOPTS the id: a session " +
      "that never inherited one (the usual case after the previous manager died) becomes the " +
      "holder, provided the id belongs to THIS repo and is discoverable on disk — in the gate " +
      "sidecar or among the channel directories — and provided this session has not registered " +
      "children of its own yet. What it does NOT inherit is the plan's approval: that was " +
      "permission the user gave to a session that is gone, so submit the plan again before " +
      "spawning. Do not know the id? Call it with anything and the refusal lists every candidate " +
      "found on disk.",
    parameters: Type.Object({
      orchestrationId: Type.String({ description: "The orchestration to take over (orch-…)" }),
    }),
    execute: guarded((params) => doAttach(deps, params)),
  });
}
