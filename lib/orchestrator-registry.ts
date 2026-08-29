/**
 * The CHILD REGISTRY — what the orchestration owns, and therefore what it is
 * allowed to touch.
 *
 * Everything the orchestrator may act on has to be something the GATE created
 * for it: a pane it split, a worktree it added, a task it started. The
 * registry is that record, and it is what turns two constraints from good
 * intentions into mechanical facts:
 *
 *  - constraint 13 — a child session must have come from `orchestrator_spawn`.
 *    The bash guard stops the agent typing `split-window`; this record is the
 *    other half, because a pane nobody registered is a pane the tools refuse
 *    to address.
 *  - "never break the user's tmux" — `orchestrator_close` can only kill a pane
 *    that is IN here. The user's own panes, and panes belonging to another
 *    orchestration, are simply not addressable.
 *
 * LIVENESS IS OBSERVED, NEVER ASSUMED. A pane can disappear because the child
 * exited, because the user closed it, or because the machine slept and tmux
 * was restarted. So every question about "what is still running" takes the
 * CURRENT pane list as an argument (the caller runs `list-panes`) instead of
 * trusting a stored status field — a stale "running" flag is exactly what
 * would make `declare_done` pass with a live child still working
 * (constraint 4).
 *
 * Pure module: it holds no state and performs no IO. The extension persists
 * the returned runtime into the gate sidecar.
 */

import { EMPTY_NOTIFY_HISTORY, type NotifyHistory } from "./orchestrator-notify.ts";

/** One child session, as the orchestration knows it. */
export interface ChildSession {
  /** Registry handle — what every tool argument names. */
  id: string;
  /** The plan task this child was spawned for. */
  taskId: string;
  /** tmux pane it runs in (the only pane the gate may kill for it). */
  paneId: string;
  /** Working directory it was started in (repo root or a worktree). */
  cwd: string;
  /**
   * Set when the GATE created a worktree for this child (constraint 7). The
   * gate that created it is the one that removes it — a worktree the agent
   * assembled by hand is not in here and is not cleaned up here either.
   */
  worktree?: string;
  createdAt: string;
  /** ISO time the child reported its task finished. */
  doneAt?: string;
  /** ISO time the gate closed its pane. */
  closedAt?: string;
}

/** Everything an orchestration session carries across turns and relays. */
export interface OrchestratorRuntime {
  /** Stable address of this orchestration (lib/orchestration-id.ts). */
  orchestrationId: string;
  /** The orchestrator's OWN pane: the left column, and its blast-radius limit. */
  ownPane?: string;
  children: ChildSession[];
  notify: NotifyHistory;
  /**
   * The plan hash the USER approved (constraint 1). Absent ⇒ no spawning:
   * writing the plan file grants nothing, exactly like the loop goal.
   */
  approvedPlanHash?: string;
  approvedPlanAt?: string;
  /** A relay in progress — see lib/orchestrator-relay.ts. */
  relay?: {
    handoffPath: string;
    successorPane?: string;
    at: string;
  };
}

export function emptyRuntime(orchestrationId: string): OrchestratorRuntime {
  return {
    orchestrationId,
    children: [],
    notify: { ...EMPTY_NOTIFY_HISTORY, sentAt: [], lastByKey: {} },
  };
}

const CHILD_ID_SAFE = /[^A-Za-z0-9._-]/g;

/** A readable, unique handle: `<taskId>-<base36 time>`. */
export function newChildId(taskId: string, now: number = Date.now()): string {
  const safe = taskId.replace(CHILD_ID_SAFE, "-").slice(0, 32);
  return `${safe}-${Math.floor(now).toString(36)}`;
}

/** Add a child. Never mutates its input. */
export function registerChild(
  runtime: OrchestratorRuntime,
  child: ChildSession,
): OrchestratorRuntime {
  return { ...runtime, children: [...runtime.children, child] };
}

/** Look a child up by its handle. */
export function findChild(runtime: OrchestratorRuntime, id: string): ChildSession | undefined {
  return runtime.children.find((c) => c.id === id);
}

/** Look a child up by the pane it occupies (registered panes only). */
export function findChildByPane(runtime: OrchestratorRuntime, paneId: string): ChildSession | undefined {
  return runtime.children.find((c) => c.paneId === paneId && !c.closedAt);
}

/**
 * The children that are still ALIVE: registered, not closed by us, and their
 * pane still exists in the window right now.
 */
export function liveChildren(
  runtime: OrchestratorRuntime,
  alivePaneIds: readonly string[],
): ChildSession[] {
  return runtime.children.filter((c) => !c.closedAt && alivePaneIds.includes(c.paneId));
}

/**
 * Children whose pane VANISHED without the gate closing it — the child died,
 * or the user closed the pane. Reported rather than hidden: an orchestrator
 * waiting on such a child would otherwise wait forever (the "process died"
 * criterion of orchestrator_wait).
 */
export function vanishedChildren(
  runtime: OrchestratorRuntime,
  alivePaneIds: readonly string[],
): ChildSession[] {
  return runtime.children.filter((c) => !c.closedAt && !alivePaneIds.includes(c.paneId));
}

/** Plan task ids with a live child — the input to scheduling. */
export function runningTaskIds(
  runtime: OrchestratorRuntime,
  alivePaneIds: readonly string[],
): string[] {
  return [...new Set(liveChildren(runtime, alivePaneIds).filter((c) => !c.doneAt).map((c) => c.taskId))];
}

/**
 * The pane a new child should be stacked under (layout: the right column
 * grows downward). The most recently created LIVE child, or undefined when
 * the right column does not exist yet — in which case the caller splits off
 * the orchestrator's own pane instead.
 */
export function lastChildPane(
  runtime: OrchestratorRuntime,
  alivePaneIds: readonly string[],
): string | undefined {
  const live = liveChildren(runtime, alivePaneIds);
  return live.length > 0 ? live[live.length - 1]!.paneId : undefined;
}

function patchChild(
  runtime: OrchestratorRuntime,
  id: string,
  patch: Partial<ChildSession>,
): OrchestratorRuntime {
  return {
    ...runtime,
    children: runtime.children.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  };
}

/** Record that a child reported its task complete (it may still be alive). */
export function markChildDone(
  runtime: OrchestratorRuntime,
  id: string,
  at: string = new Date().toISOString(),
): OrchestratorRuntime {
  return patchChild(runtime, id, { doneAt: at });
}

/** Record that the gate closed a child's pane. */
export function markChildClosed(
  runtime: OrchestratorRuntime,
  id: string,
  at: string = new Date().toISOString(),
): OrchestratorRuntime {
  return patchChild(runtime, id, { closedAt: at });
}

/**
 * May this pane be closed by `orchestrator_close`?
 *
 * The refusal message names the reason, because the two failure modes need
 * different answers: an unknown pane means "that is not yours" (the user's
 * own pane, or another orchestration's), while an already-closed one is
 * simply a no-op the caller should not retry.
 */
export function closableChild(
  runtime: OrchestratorRuntime,
  id: string,
): { ok: true; child: ChildSession } | { ok: false; reason: string } {
  const child = findChild(runtime, id);
  if (!child) {
    return {
      ok: false,
      reason:
        `没有登记过子会话 "${id}" —— 只能关闭由 orchestrator_spawn 开出来、并登记在案的 pane。` +
        "用户自己的 pane 与别的编排的 pane 都不在可寻址范围内。",
    };
  }
  if (child.closedAt) return { ok: false, reason: `子会话 "${id}" 已经关闭（${child.closedAt}）` };
  return { ok: true, child };
}

/** The worktrees the gate created and still has to clean up. */
export function pendingWorktrees(runtime: OrchestratorRuntime): ChildSession[] {
  return runtime.children.filter((c) => c.worktree && !c.closedAt);
}

/** One-screen rendering for `orchestrator_status`. */
export function formatChildren(
  runtime: OrchestratorRuntime,
  alivePaneIds: readonly string[],
): string {
  if (runtime.children.length === 0) return "（还没有开过子会话）";
  return runtime.children
    .map((c) => {
      const state = c.closedAt
        ? "closed"
        : alivePaneIds.includes(c.paneId)
          ? (c.doneAt ? "done（pane 仍在）" : "alive")
          : "pane 已消失（异常退出或被用户关掉）";
      return `- ${c.id} [${state}] task=${c.taskId} pane=${c.paneId}` +
        (c.worktree ? ` worktree=${c.worktree}` : "") +
        ` 开始于 ${c.createdAt}`;
    })
    .join("\n");
}
