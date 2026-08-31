/**
 * The PLAN — an orchestrator session's exit contract, and the only thing that
 * authorizes it to spawn anything.
 *
 * It is the orchestration-layer twin of the loop goal (lib/loop-goal.ts) and
 * deliberately reuses that design, because the same hole would otherwise open
 * here: a plan the agent wrote for itself is a self-issued contract, and an
 * agent that grades itself against its own guess never fails. So the file is
 * an ordinary repo file, but WRITING it grants nothing — a plan counts only
 * while the sidecar holds the hash of exactly this content, recorded when the
 * USER approved it in a dialog the extension rendered (constraint 1).
 *
 * WHAT IT ADDS over a loop goal, and why the shape is what it is:
 *
 *  - TASKS, not prose. The orchestrator's exit condition is mechanical
 *    ("nothing left to run", constraint 3), so the unit has to be countable.
 *  - FILE BOUNDARIES per task (constraint 5), which decide what may run in
 *    parallel (constraint 6) and bound what the orchestrator may approve on a
 *    child's behalf (constraint 8). See lib/orchestrator-boundaries.ts.
 *  - PENDING DECISIONS. Anything the orchestrator escalated to the human is
 *    recorded here, and an unresolved decision the user was never TOLD about
 *    blocks the exit (constraint 11) — the failure mode this closes is an
 *    unattended overnight run finishing quietly on a question nobody saw.
 *
 * A STATE MACHINE, not free-form status writes: {@link applyTaskStatus} is
 * the only way a task changes state, and it refuses transitions that would
 * make the plan lie (a task cannot go straight from pending to done without
 * ever having run, and a done task cannot silently become running again).
 *
 * Pure module: parses, validates, decides. It never reads or writes a file —
 * the extension owns IO, exactly as it does for the loop goal.
 */

import { createHash } from "node:crypto";
import {
  declarationsOverlap,
  normalizeBoundaries,
  type NormalizedBoundary,
} from "./orchestrator-boundaries.ts";

/** Repo-root-relative location of the plan (gate-excluded via `.pi/`). */
export const PLAN_RELPATH = ".pi/orchestrator-plan.json";

/** Default / hard cap on children running at once (user decision: 2). */
export const DEFAULT_MAX_PARALLEL = 2;
export const MAX_MAX_PARALLEL = 4;

/** Upper bound on a plan the extension will accept (dialog + prompt budget). */
export const PLAN_MAX_TASKS = 40;

export type TaskStatus = "pending" | "running" | "done" | "blocked";
export type TaskExecution = "serial" | "parallel";

export interface PlanTask {
  /** Stable, agent-chosen id — how every other tool addresses this task. */
  id: string;
  title: string;
  /** Normalized repo-relative boundaries. Never empty (constraint 5). */
  fileBoundaries: NormalizedBoundary[];
  /**
   * Repo root this task works in (2026-09-07). Absent ⇒ the orchestration's
   * own repo. The scheduler serializes WITHIN a repo and parallelizes
   * ACROSS repos — two children may never edit the same checkout at once.
   */
  repo?: string;
  /** Task ids that must be `done` before this one may start. */
  dependsOn: string[];
  /** What the plan ASKED for; the scheduler may downgrade it (constraint 6). */
  execution: TaskExecution;
  status: TaskStatus;
  /** Free-form: why blocked, what was decided, which child ran it. */
  note?: string;
}

/** A question only the human can settle (constraint 11 / constraint 14). */
export interface PlanDecision {
  id: string;
  question: string;
  /** ISO time the user was actually NOTIFIED (orchestrator_notify). */
  notifiedAt?: string;
  /** ISO time the answer landed. */
  resolvedAt?: string;
  /** The answer, once it landed. */
  answer?: string;
  /**
   * What the PLAN has to become once this is answered (R-29).
   *
   * The measured gap: a decision was registered, the user was notified, the
   * user answered — and nothing connected that answer back to the plan. The
   * answer was only written down at wrap-up, nobody was reminded that an
   * approved option required widening a task's boundary, and `declare_done`
   * checked only that the user had been TOLD, never that the question had
   * been settled. Recording the intended effect at registration time is what
   * makes "the plan still does not reflect what you decided" visible.
   */
  planEffect?: string;

}

export interface OrchestratorPlan {
  schema: 1;
  title: string;
  intent: string;
  tasks: PlanTask[];
  decisions: PlanDecision[];
  maxParallel: number;
  updatedAt: string;
}

export interface PlanParseResult {
  ok: boolean;
  plan?: OrchestratorPlan;
  /** Every problem, not just the first — one round-trip should fix the plan. */
  problems: string[];
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function normalizeStatus(value: unknown): TaskStatus | undefined {
  return value === "pending" || value === "running" || value === "done" || value === "blocked"
    ? value
    : undefined;
}

function normalizeExecution(value: unknown): TaskExecution | undefined {
  return value === "serial" || value === "parallel" ? value : undefined;
}

/** Clamp the parallelism to the range the layout and the cost model support. */
export function clampMaxParallel(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_PARALLEL;
  return Math.min(MAX_MAX_PARALLEL, Math.max(1, n));
}

/**
 * Parse and VALIDATE a plan from untrusted input (a tool argument or the
 * on-disk file). Fail-closed: anything that would make the scheduling or the
 * boundary checks unsound is a problem, and a plan with problems is not a
 * plan — callers must not fall back to a partially-understood one.
 */
export function parsePlan(raw: unknown, now: string = new Date().toISOString()): PlanParseResult {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, problems: ["plan 必须是一个 JSON 对象"] };
  }
  const obj = raw as Record<string, unknown>;

  const title = asString(obj.title);
  if (!title) problems.push("plan.title 不能为空");
  const intent = asString(obj.intent);
  if (!intent) problems.push("plan.intent 不能为空（一句话说明这轮编排要达成什么）");

  const rawTasks = Array.isArray(obj.tasks) ? obj.tasks : [];
  if (rawTasks.length === 0) problems.push("plan.tasks 至少要有一个任务");
  if (rawTasks.length > PLAN_MAX_TASKS) {
    problems.push(`plan.tasks 最多 ${PLAN_MAX_TASKS} 个，当前 ${rawTasks.length} 个`);
  }

  const tasks: PlanTask[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < rawTasks.length; i++) {
    const entry = rawTasks[i];
    const label = `tasks[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push(`${label} 必须是对象`);
      continue;
    }
    const t = entry as Record<string, unknown>;
    const id = asString(t.id);
    if (!TASK_ID.test(id)) {
      problems.push(`${label}.id "${id}" 非法（只允许字母数字 . _ -，1~64 字符）`);
      continue;
    }
    if (seenIds.has(id)) {
      problems.push(`${label}.id "${id}" 重复`);
      continue;
    }
    seenIds.add(id);

    const taskTitle = asString(t.title);
    if (!taskTitle) problems.push(`${label}.title 不能为空`);

    // CONSTRAINT 5 — every task declares what it may touch. This is the
    // check that makes constraints 6 and 8 possible at all, so it is hard.
    const declared = asStringArray(t.fileBoundaries);
    if (declared.length === 0) {
      problems.push(`${label} ("${id}") 必须声明 fileBoundaries（文件边界），并行调度与代批 goal 都靠它`);
    }
    const { boundaries, problems: boundaryProblems } = normalizeBoundaries(declared);
    for (const bp of boundaryProblems) {
      problems.push(`${label} ("${id}") 的边界 "${bp.boundary}" 非法：${bp.reason}`);
    }

    const status = normalizeStatus(t.status) ?? "pending";
    if (t.status !== undefined && normalizeStatus(t.status) === undefined) {
      problems.push(`${label}.status "${String(t.status)}" 非法（pending/running/done/blocked）`);
    }
    const execution = normalizeExecution(t.execution) ?? "serial";
    if (t.execution !== undefined && normalizeExecution(t.execution) === undefined) {
      problems.push(`${label}.execution "${String(t.execution)}" 非法（serial/parallel）`);
    }

    tasks.push({
      id,
      title: taskTitle,
      fileBoundaries: boundaries,
      ...(asString(t.repo) ? { repo: asString(t.repo)! } : {}),
      dependsOn: asStringArray(t.dependsOn).map((d) => d.trim()).filter(Boolean),
      execution,
      status,
      note: asString(t.note) || undefined,
    });
  }

  // Dependencies must exist and must not form a cycle: an unrunnable plan
  // would make the exit condition (constraint 3) permanently unsatisfiable.
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!seenIds.has(dep)) problems.push(`任务 "${task.id}" 依赖了不存在的任务 "${dep}"`);
      if (dep === task.id) problems.push(`任务 "${task.id}" 依赖了自己`);
    }
  }
  const cycle = findDependencyCycle(tasks);
  if (cycle) problems.push(`任务依赖成环：${cycle.join(" → ")}`);

  const decisions: PlanDecision[] = [];
  const rawDecisions = Array.isArray(obj.decisions) ? obj.decisions : [];
  for (let i = 0; i < rawDecisions.length; i++) {
    const entry = rawDecisions[i];
    if (typeof entry !== "object" || entry === null) {
      problems.push(`decisions[${i}] 必须是对象`);
      continue;
    }
    const d = entry as Record<string, unknown>;
    const id = asString(d.id);
    const question = asString(d.question);
    if (!TASK_ID.test(id)) { problems.push(`decisions[${i}].id "${id}" 非法`); continue; }
    if (!question) { problems.push(`decisions[${i}].question 不能为空`); continue; }
    decisions.push({
      id,
      question,
      notifiedAt: asString(d.notifiedAt) || undefined,
      resolvedAt: asString(d.resolvedAt) || undefined,
      answer: asString(d.answer) || undefined,
      planEffect: asString(d.planEffect) || undefined,

    });
  }

  const plan: OrchestratorPlan = {
    schema: 1,
    title,
    intent,
    tasks,
    decisions,
    maxParallel: clampMaxParallel(obj.maxParallel),
    updatedAt: asString(obj.updatedAt) || now,
  };
  return { ok: problems.length === 0, plan: problems.length === 0 ? plan : undefined, problems };
}

/** The first dependency cycle found, as a readable id chain, or undefined. */
export function findDependencyCycle(tasks: readonly PlanTask[]): string[] | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    const current = state.get(id);
    if (current === "done") return undefined;
    if (current === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    const task = byId.get(id);
    if (!task) return undefined;
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of task.dependsOn) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return undefined;
  };

  for (const task of tasks) {
    const found = visit(task.id);
    if (found) return found;
  }
  return undefined;
}

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
 * never mentioned `status` — so an orchestrator that widened one boundary
 * reset every task to `pending`, twice in one run, including two tasks whose
 * branches were already merged. The damage is not cosmetic: constraint 3
 * counts these statuses, and the state machine refuses `pending → done`, so
 * recovering meant walking each task back through `running` by hand.
 *
 * The rule follows from what a status IS. Boundaries, dependencies and
 * parallelism are what the USER approved (they are in `canonicalPlanText`);
 * a status is what EXECUTION produced (it is deliberately excluded from it).
 * Rewriting the approved content therefore has no business destroying the
 * record of what already ran — so status and note are taken from the task
 * with the same id, and only a genuinely NEW task starts at `pending`. A task
 * that disappeared from the plan takes its status with it.
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
        ...(kept.note === undefined ? {} : { note: kept.note }),
      };
    }),
  };
}


/**
 * Move ONE task, returning a NEW plan (the caller persists it) or the reason
 * the move was refused. Never mutates its input.
 */
export function applyTaskStatus(
  plan: OrchestratorPlan,
  taskId: string,
  to: TaskStatus,
  opts: { note?: string; now?: string } = {},
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
  const tasks = plan.tasks.map((t) =>
    t.id === taskId ? { ...t, status: to, note: opts.note ?? t.note } : t,
  );
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
  /** The id of the task whose boundaries it overlaps. */
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
 * CONSTRAINT 6 is enforced by DEFERRAL, not refusal: a task whose boundaries
 * overlap something already running — or something picked earlier in this
 * same batch — is held back and runs later, serially. Refusing the plan
 * instead would punish a perfectly good plan for a scheduling detail, and
 * forcing the agent to re-declare boundaries to buy parallelism is exactly
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
  // Everything a new pick must stay clear of: what is already running plus
  // what this batch has just picked. Two children may NEVER share one
  // checkout (2026-09-07): the isolation worktree is gone, so parallelism
  // exists only ACROSS repos — same-repo tasks are serialized by the repo
  // key, whatever their file boundaries say.
  const occupied: PlanTask[] = [...running];
  const sameRepo = (a: PlanTask, b: PlanTask) => (a.repo ?? repoRoot) === (b.repo ?? repoRoot);
  for (const task of candidates) {
    if (start.length >= slots) break;
    const clash = occupied.find((other) => sameRepo(task, other));
    if (clash) {
      deferred.push({
        task,
        blockedBy: clash.id,
        reason: `与 "${clash.id}" 在同一 repo（${task.repo ?? repoRoot}），同一 checkout 不能两个写者并存：等它结束后再开`,
      });
      continue;
    }
    // It runs in parallel exactly when something else is in flight beside it.
    start.push({ task, execution: occupied.length > 0 ? "parallel" : "serial" });
    occupied.push(task);
  }
  return { start, deferred };
}

/**
 * The pairs the plan asked to run in parallel but which may NOT (constraint 6).
 * Reported at approval time so the user sees the downgrade before it happens.
 */
export function conflictingParallelPairs(plan: OrchestratorPlan, repoRoot: string): Array<{ a: string; b: string }> {
  const parallel = plan.tasks.filter((t) => t.execution === "parallel");
  const pairs: Array<{ a: string; b: string }> = [];
  const sameRepo = (a: PlanTask, b: PlanTask) => (a.repo ?? repoRoot) === (b.repo ?? repoRoot);
  for (let i = 0; i < parallel.length; i++) {
    for (let j = i + 1; j < parallel.length; j++) {
      const a = parallel[i]!;
      const b = parallel[j]!;
      if (sameRepo(a, b)) pairs.push({ a: a.id, b: b.id });
    }
  }
  return pairs;
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

// ---------------------------------------------------------------------------
// Content binding (constraint 1) and human-readable rendering
// ---------------------------------------------------------------------------

/**
 * Canonical serialization the approval hash is taken over.
 *
 * `updatedAt` and per-task `status`/`note` are EXCLUDED on purpose: the user
 * approves the WORK (tasks, boundaries, dependencies, parallelism), and
 * executing that work necessarily rewrites statuses. Including them would
 * invalidate the approval on the first status change and make the plan
 * unusable — while excluding them keeps the guarantee that matters: nobody
 * can add a task, widen a boundary or raise the parallelism without asking.
 */
export function canonicalPlanText(plan: OrchestratorPlan): string {
  return JSON.stringify({
    schema: plan.schema,
    title: plan.title,
    intent: plan.intent,
    maxParallel: plan.maxParallel,
    tasks: plan.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      fileBoundaries: [...t.fileBoundaries].sort(),
      dependsOn: [...t.dependsOn].sort(),
      execution: t.execution,
    })),
  });
}

/** sha256 of the canonical text — what the sidecar approval record binds to. */
export function planHash(plan: OrchestratorPlan): string {
  return createHash("sha256").update(canonicalPlanText(plan), "utf8").digest("hex");
}

/** One-screen rendering for the approval dialog and the takeover report. */
export function formatPlanSummary(plan: OrchestratorPlan, repoRoot = ""): string {
  const lines: string[] = [
    `${plan.title}`,
    `目标：${plan.intent}`,
    `并行上限：${plan.maxParallel}`,
    "",
  ];
  for (const t of plan.tasks) {
    const deps = t.dependsOn.length ? ` ← ${t.dependsOn.join(", ")}` : "";
    lines.push(
      `- [${t.status}] ${t.id} (${t.execution})${deps}：${t.title}\n` +
      `    边界：${t.fileBoundaries.join(", ")}` +
      (t.repo ? `\n    repo：${t.repo}` : ""),
    );
  }
  const conflicts = conflictingParallelPairs(plan, repoRoot);
  if (conflicts.length) {
    lines.push("", "并行降级（同一 repo 不能并行，将改为串行）：" + conflicts.map((c) => `${c.a}↔${c.b}`).join("、"));
  }
  const open = openDecisions(plan);
  if (open.length) {
    lines.push("", "待用户决策：" + open.map((d) => `${d.id}（${d.notifiedAt ? "已通知" : "未通知"}）`).join("、"));
  }
  return lines.join("\n");
}
