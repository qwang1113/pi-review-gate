/**
 * The PLAN IN EXECUTION — how its tasks move, what may start next, and what
 * still keeps the orchestration open.
 *
 * lib/orchestrator-plan.ts owns what a plan IS (its shape, its validation, the
 * content the user approves and how it is rendered); this module owns what
 * EXECUTING it produces: the task state machine, the survival of that record
 * across a plan rewrite, the scheduler, and the exit conditions (constraints 3
 * and 11). None of it is approved content — statuses are deliberately outside
 * `canonicalPlanText` — which is why it lives apart from the approval binding.
 *
 * Pure module: decides, never reads or writes a file.
 */

import type {
  OrchestratorPlan,
  PlanDecision,
  PlanTask,
  TaskExecution,
  TaskStatus,
} from "./orchestrator-plan.ts";

// ---------------------------------------------------------------------------
// The task state machine
// ---------------------------------------------------------------------------

/**
 * Legal transitions. The two REFUSED ones are the plan's honesty guarantees:
 *  - pending → done skips the run, so "everything is done" could be declared
 *    without anything having happened (constraint 3 would be vacuous);
 *  - done → running re-opens a finished task silently; rework is legal but it
 *    must go through `pending`, so the plan shows the task came back.
 */
const LEGAL_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  pending: ["running", "blocked"],
  running: ["done", "blocked", "pending"],
  blocked: ["pending", "running"],
  done: ["pending"],
});

export function isLegalTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * Carry the EXECUTION RECORD across a plan rewrite (round-4 P1).
 *
 * `write` replaces the plan wholesale, and the tool's own parameter shape
 * never mentioned `status` — so an orchestrator that rewrote one task
 * reset every task to `pending`, twice in one run, including two tasks whose
 * branches were already merged. The damage is not cosmetic: constraint 3
 * counts these statuses, and the state machine refuses `pending → done`, so
 * recovering meant walking each task back through `running` by hand.
 *
 * The rule follows from what a status IS. Boundaries, dependencies and
 * parallelism are what the USER approved (they are in `canonicalPlanText`);
 * a status is what EXECUTION produced (it is deliberately excluded from it).
 * Rewriting the approved content therefore has no business destroying the
 * record of what already ran — so the STATUS is taken from the task with the
 * same id, and only a genuinely NEW task starts at `pending`. A task that
 * disappeared from the plan takes its status with it.
 *
 * The NOTE is different and used to be lumped in with the status, which is the
 * defect: a note is prose for a human, it is excluded from `canonicalPlanText`
 * and from the approval snapshot exactly as a status is, but unlike a status
 * nothing else can write it during a rewrite. Pinning it to the old value made
 * every note update a `write` carried disappear without a word. So a note the
 * caller SUPPLIES wins, and only an omitted one inherits the previous value.
 *
 * `applyTaskStatus` stays the only way a status CHANGES; this is the only way
 * one SURVIVES. Never mutates either input.
 */
export function mergeTaskProgress(
  previous: OrchestratorPlan | undefined,
  next: OrchestratorPlan,
): OrchestratorPlan {
  if (!previous) return next;
  const before = new Map(previous.tasks.map((task) => [task.id, task]));
  return {
    ...next,
    tasks: next.tasks.map((task) => {
      const kept = before.get(task.id);
      if (!kept) return task;
      return {
        ...task,
        status: kept.status,
        // The NOTE is the caller's to rewrite (2026-09-06, user decision).
        // Keeping the old one unconditionally silently dropped every note
        // update a `write` carried — measured in four consecutive rounds, and
        // the reason this very task id ends in `-v2`. A note grants nothing:
        // it is absent from `canonicalPlanText`, from the approved snapshot
        // and from `decideApprovalCarry`, so accepting it cannot widen what
        // the user approved. An omitted note still inherits the old one, so a
        // rewrite that simply does not mention notes does not wipe them.
        ...(task.note === undefined && kept.note !== undefined ? { note: kept.note } : {}),
      };
    }),
  };
}


/**
 * Move ONE task, returning a NEW plan (the caller persists it) or the reason
 * the move was refused. Never mutates its input.
 *
 * NO `note` OPTION (2026-09-21). There used to be one, and it wrote straight
 * onto the task — which since 2026-09-17 is the TASK BOOK. So a status change
 * carried a reason and silently REPLACED the assignment the plan had been
 * audited and approved for, and `orchestrator_spawn`'s fallback ("use the task
 * book when no `task` was typed") then handed that remark to a child session
 * as its first message: measured, a re-dispatched child opened with 「上一个
 * 子会话已经不在了（pane 消失或已关闭）…」 instead of its assignment. A status
 * reason is a log line; the field has exactly one writer (`write`).
 */
export function applyTaskStatus(
  plan: OrchestratorPlan,
  taskId: string,
  to: TaskStatus,
  opts: { now?: string } = {},
): { ok: true; plan: OrchestratorPlan } | { ok: false; reason: string } {
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, reason: `plan 里没有任务 "${taskId}"` };
  if (!isLegalTransition(task.status, to)) {
    return {
      ok: false,
      reason:
        `任务 "${taskId}" 不能从 ${task.status} 直接变成 ${to}` +
        (task.status === "pending" && to === "done"
          ? "（没跑过就说做完了，plan 的完成度会失真；先置 running）"
          : task.status === "done" && to === "running"
            ? "（已完成的任务要返工，先置 pending，让 plan 记录它回炉了）"
            : ""),
    };
  }
  if (to === "running") {
    const blockers = task.dependsOn.filter((dep) => plan.tasks.find((t) => t.id === dep)?.status !== "done");
    if (blockers.length > 0) {
      return { ok: false, reason: `任务 "${taskId}" 的前置任务尚未完成：${blockers.join(", ")}` };
    }
  }
  const tasks = plan.tasks.map((t) => (t.id === taskId ? { ...t, status: to } : t));
  return { ok: true, plan: { ...plan, tasks, updatedAt: opts.now ?? new Date().toISOString() } };
}

// ---------------------------------------------------------------------------
// Scheduling (constraint 6) and the exit conditions (constraints 3 and 11)
// ---------------------------------------------------------------------------

export interface ScheduleDecision {
  task: PlanTask;
  /** What will actually happen — may differ from what the plan asked for. */
  execution: TaskExecution;
}

/** A task that could run, but not in THIS batch — and why. */
export interface DeferredTask {
  task: PlanTask;
  /** The id of the task it has to wait for. */
  blockedBy: string;
  reason: string;
}

export interface ScheduleResult {
  start: ScheduleDecision[];
  deferred: DeferredTask[];
}

/**
 * Which tasks may start right now, and how.
 *
 * CONSTRAINT 6 is enforced by DEFERRAL, not refusal: a task whose REPO is
 * already occupied — by something running, or by something picked earlier in
 * this same batch — is held back and runs later, serially. Refusing the plan
 * instead would punish a perfectly good plan for a scheduling detail, and
 * forcing the agent to invent a workaround to buy parallelism is exactly
 * the "invent your own workaround" pressure this layer exists to remove.
 *
 * The deferrals are RETURNED rather than swallowed: the orchestrator has to
 * be able to tell the user "B waits for A" instead of silently doing less
 * than the plan promised.
 */
export function scheduleNextTasks(
  plan: OrchestratorPlan,
  runningTaskIds: readonly string[],
  repoRoot: string,
): ScheduleResult {
  const running = plan.tasks.filter((t) => runningTaskIds.includes(t.id));
  const slots = Math.max(0, plan.maxParallel - running.length);
  const doneIds = new Set(plan.tasks.filter((t) => t.status === "done").map((t) => t.id));
  const candidates = plan.tasks.filter(
    (t) => t.status === "pending" && t.dependsOn.every((d) => doneIds.has(d)),
  );
  if (slots === 0) return { start: [], deferred: [] };

  const start: ScheduleDecision[] = [];
  const deferred: DeferredTask[] = [];
  // SAME-REPO TASKS RUN IN PARALLEL NOW, each in its own checkout
  // (2026-09-10, user decision). The old rule serialized them by repo key
  // because two writers in ONE checkout overwrite each other — true, and the
  // cure was already in the toolbox: `git worktree add` gives the second
  // writer its own directory on its own branch, sharing the object store
  // (lib/orchestrator-worktree.ts). The coordinator assigns that checkout at
  // spawn; this function only decides WHAT may start.
  //
  // `deferred` therefore comes back empty and the field stays for the callers
  // that render it: a plan whose tasks all depend on unfinished work has an
  // EMPTY `start` (those tasks never become candidates), and that is the shape
  // a caller must still be able to describe.
  const occupied: PlanTask[] = [...running];
  for (const task of candidates) {
    if (start.length >= slots) break;
    // It runs in parallel exactly when something else is in flight beside it.
    start.push({ task, execution: occupied.length > 0 ? "parallel" : "serial" });
    occupied.push(task);
  }
  return { start, deferred };
}

/** CONSTRAINT 3 — anything not `done` keeps the orchestration open. */
export function unfinishedTasks(plan: OrchestratorPlan): PlanTask[] {
  return plan.tasks.filter((t) => t.status !== "done");
}

/**
 * CONSTRAINT 11 — decisions the user was never told about.
 *
 * A decision that is unresolved but WAS notified does not block: the user has
 * the question and can answer whenever they like. One that was never notified
 * would vanish with the session, which is precisely the overnight-run failure
 * this blocks.
 */
export function unreportedDecisions(plan: OrchestratorPlan): PlanDecision[] {
  return plan.decisions.filter((d) => !d.resolvedAt && !d.notifiedAt);
}

/**
 * The next decision id (F5) — minted by the GATE, never by the caller.
 *
 * Sequential and short (`d1`, `d2`, …) because a human reads it: it appears
 * in the desktop notification that asks them to decide, and in
 * `orchestrator_status`. The scan for the highest existing number (rather
 * than `decisions.length + 1`) keeps it unique even after a decision was
 * removed by hand from the plan file.
 */
export function nextDecisionId(plan: OrchestratorPlan): string {
  let highest = 0;
  for (const decision of plan.decisions) {
    const match = /^d(\d+)$/.exec(decision.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `d${highest + 1}`;
}


/** Decisions still waiting on the human (notified or not) — for status output. */
export function openDecisions(plan: OrchestratorPlan): PlanDecision[] {
  return plan.decisions.filter((d) => !d.resolvedAt);
}
