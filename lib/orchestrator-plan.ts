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
 *  - A REPO per task (2026-09-07), which decides the child's cwd and what may
 *    run beside what: same-repo tasks are serialized, only different repos run
 *    in parallel. Tasks used to declare FILE BOUNDARIES too; they were removed
 *    2026-09-17 (user decision) — with same-repo children serialized they
 *    prevented no collision, and their only remaining effect was to revoke the
 *    approval whenever a child discovered it needed a new directory.
 *  - PENDING DECISIONS. Anything the orchestrator escalated to the human is
 *    recorded here, and an unresolved decision the user was never TOLD about
 *    blocks the exit (constraint 11) — the failure mode this closes is an
 *    unattended overnight run finishing quietly on a question nobody saw.
 *
 * A STATE MACHINE, not free-form status writes: `applyTaskStatus` is
 * the only way a task changes state, and it refuses transitions that would
 * make the plan lie (a task cannot go straight from pending to done without
 * ever having run, and a done task cannot silently become running again).
 * That machine, the scheduler and the exit conditions live in
 * lib/orchestrator-plan-progress.ts — what EXECUTING a plan produces; this
 * module keeps what a plan IS (shape, validation, approved content, rendering).
 *
 * Pure module: parses, validates, decides. It never reads or writes a file —
 * the extension owns IO, exactly as it does for the loop goal.
 */

import { isAbsolute } from "node:path";
import { sha256 } from "./hash.ts";
import {
  deliveryStationLine,
  parseDeliveryStation,
  type DeliveryStation,
  type StationAudience,
} from "./delivery-station.ts";
import { acceptanceTaskId, narrowedRepoLines, normalizeRepoPath } from "./repo-pr-policy.ts";
import { openDecisions } from "./orchestrator-plan-progress.ts";

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
  /**
   * THE TASK BOOK — the assignment this task's child session is handed.
   *
   * Five sections, per {@link PLAN_TASK_SKELETON}: goal / deliverable / which
   * module the code lands in / how the child knows it is done / what is out of
   * scope. Written at PLAN time, so the plan AUDIT can refuse a task book too
   * vague to negotiate a goal from, and the user can read every assignment in
   * the approval transcript.
   *
   * This comment said "why blocked, what was decided, which child ran it" — a
   * STATUS REMARK — until 2026-09-21. The field was re-pointed at the task book
   * on 2026-09-17 (when file boundaries left the plan and the landing place
   * moved here as free text) while the old comment and a second writer stayed
   * behind: `set-status` wrote its reason onto this very field, overwriting the
   * assignment. The status writer is gone now (`lib/orchestrator-plan-action.ts`);
   * status reasons go to the gate log.
   *
   * Deliberately NOT part of {@link canonicalPlanText}: it grants nothing (no
   * repo, no dependency, no parallelism, no station), so revising it must not
   * revoke the user's approval.
   */
  note?: string;
}

/** A question only the human can settle (constraint 11 / constraint 14). */
export interface PlanDecision {
  id: string;
  question: string;
  /** ISO time the user was actually NOTIFIED (the gate sends the banner). */
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
   * approved option required widening a task's repo, and `declare_done`
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
  /**
   * WHERE THIS ORCHESTRATION STOPS (2026-09-06) — one of the three stations
   * DEFINED in lib/delivery-station.ts (`describeDeliveryStation` /
   * `describeDeliveryStationEn`). This comment deliberately does not repeat
   * what each one means: that sentence has ONE home.
   *
   * Always present after {@link parsePlan}: a plan file written before the
   * field existed, or carrying an unreadable value, is READ as `precommit`
   * (lib/delivery-station.ts) — the strictest station, allowing no ship
   * command at all. Part of {@link canonicalPlanText}, so raising it is a
   * change the user is asked about again.
   */
  deliveryStation: DeliveryStation;
  /**
   * REPOS WHOSE TASKS MAY EACH OPEN THEIR OWN PR (2026-09-15, user decision).
   *
   * The default — an empty list — is the rule: a requirement that lands in one
   * repository comes out as ONE pull request, so a repo holding more than one
   * task has its station narrowed to `commit` and the manager merges locally
   * before anything is published (lib/repo-pr-policy.ts). Measured need: three
   * tasks in one repo shipped three PRs (#1217/#1218/#1219) and the user had
   * to close them and ask for a single combined branch.
   *
   * Splitting is the USER's call, never the orchestrator's, which is why the
   * list is approved content: it is part of {@link canonicalPlanText}, and
   * ADDING a repo to it is a widening that revokes the approval
   * (lib/orchestrator-plan-approval.ts) — removing one only narrows.
   */
  allowMultiplePrs: string[];
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
 * on-disk file). Fail-closed: anything that would make the scheduling
 * unsound is a problem, and a plan with problems is not a
 * plan — callers must not fall back to a partially-understood one.
 */
export function parsePlan(raw: unknown, now: string = new Date().toISOString(), strictRepo = false): PlanParseResult {
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

    // CONSTRAINT 6 (strict write path) — every task declares WHICH repo it
    // works in. `repo` decides the child's cwd (orchestrator_dispatch), and a
    // task without it silently lands in the orchestrator's OWN repo — the
    // measured 2026-09-01 t2 deadlock (child spawned in onchain, goal bound
    // to onchain, edits blocked for server-service-dashboard). The READ path
    // stays lenient (strictRepo=false): legacy plans predating the field keep
    // loading, scheduling against `a.repo ?? repoRoot` as before.
    if (strictRepo) {
      const repo = asString(t.repo);
      if (!repo) {
        problems.push(`${label} ("${id}") 必须声明 repo（该任务工作的仓库绝对路径）——未声明时子会话 cwd 会落在项目经理自己的仓库`);
      } else if (!isAbsolute(repo)) {
        // A relative repo (e.g. "lib") would resolve through gitRootOfDir
        // against the PM's cwd — silently landing the child in the
        // orchestrator's OWN repo, the exact deadlock this constraint kills.
        problems.push(`${label} ("${id}") 的 repo 必须是绝对路径（当前是相对路径 "${repo}"）——相对路径会按项目经理的 cwd 解析，可能落到错误的仓库`);
      }
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
    // Absent / misspelled ⇒ `precommit`, exactly like `clampMaxParallel`
    // clamps rather than refuses: a plan is rejected over things a human has
    // to fix (a missing repo, a dependency cycle), never over a field
    // whose safe reading is the strictest one.
    deliveryStation: parseDeliveryStation(obj.deliveryStation),
    // Read leniently (a non-array or junk entries degrade to the empty list,
    // the STRICT reading) and normalized so that a trailing slash cannot make
    // the same repository look like two. Duplicates collapse: this list is a
    // set of permissions, not a log.
    allowMultiplePrs: [
      ...new Set(
        asStringArray(obj.allowMultiplePrs)
          .map((entry) => normalizeRepoPath(entry))
          .filter((entry) => entry.length > 0),
      ),
    ],
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
// Content binding (constraint 1) and human-readable rendering
// ---------------------------------------------------------------------------

/**
 * Canonical serialization the approval hash is taken over.
 *
 * `updatedAt` and per-task `status`/`note` are EXCLUDED on purpose: the user
 * approves the WORK (tasks, repos, dependencies, parallelism), and
 * executing that work necessarily rewrites statuses. Including them would
 * invalidate the approval on the first status change and make the plan
 * unusable — while excluding them keeps the guarantee that matters: nobody
 * can add a task, move it to another repo or raise the parallelism without asking.
 */
export function canonicalPlanText(plan: OrchestratorPlan): string {
  return JSON.stringify({
    schema: plan.schema,
    title: plan.title,
    intent: plan.intent,
    maxParallel: plan.maxParallel,
    // The delivery station IS approved content: `pr` grants the orchestration
    // the authority to publish, which nobody may hand it silently.
    deliveryStation: plan.deliveryStation,
    // SORTED, so reordering the list is not a content change that revokes an
    // approval nobody meant to touch. The PERMISSIONS are what the user
    // signed; the order they happen to be written in grants nothing.
    allowMultiplePrs: [...plan.allowMultiplePrs].sort(),
    tasks: plan.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      ...(t.repo ? { repo: t.repo } : {}),
      dependsOn: [...t.dependsOn].sort(),
      execution: t.execution,
    })),
  });
}

/** sha256 of the canonical text — what the sidecar approval record binds to. */
export function planHash(plan: OrchestratorPlan): string {
  return sha256(canonicalPlanText(plan));
}

/**
 * Does this value have the shape {@link planHash} produces?
 *
 * The PRODUCER owns the shape. Every record that carries authority — the
 * approved hash, its lineage — is read back from an untrusted sidecar and has
 * to be shape-checked first, and the check was being written out again at
 * each of those sites. A rule copied per caller drifts, and an authorization
 * rule that drifts drifts open: one site relaxing to a 63-char or
 * upper-case digest would admit a record the others refuse.
 */
export function isPlanHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** One-screen rendering for the approval dialog and the takeover report. */
export function formatPlanSummary(
  plan: OrchestratorPlan,
  repoRoot = "",
  audience: StationAudience = "agent",
): string {
  const lines: string[] = [
    `${plan.title}`,
    `目标：${plan.intent}`,
    `并行上限：${plan.maxParallel}`,
    // Most of this summary's readers are AGENTS (tool replies, the audit
    // brief); the one that is not — the approval transcript — asks for the
    // user's own person explicitly (round-2 P2).
    deliveryStationLine(plan.deliveryStation, audience),
    "",
  ];
  // THE NARROWING IS STATED WHERE THE STATION IS (2026-09-15). A plan that
  // says `pr` while every child in it can only reach `commit` would be a
  // contract the user cannot read: they would approve "到 PR" and then watch
  // every child stop short by a rule nobody showed them. The lines come from
  // the ONE implementation of the rule (lib/repo-pr-policy.ts), never a copy.
  lines.push(...narrowedRepoLines(plan, repoRoot));
  // WHICH TASK ACCEPTS AND DELIVERS (2026-09-22). The plan's LAST task is the
  // independent acceptance task by convention (lib/repo-pr-policy.ts), and it
  // is the only one whose station is the plan's own — saying so is what makes
  // the two lines above read as one contract instead of two. The rule has ONE
  // home; this is a marker, not a second copy of it. (The SECOND-to-last task
  // is the wrap-up: merge → one review → commit — and it is capped like any
  // other task, which is why only the last one is marked here.)
  //
  // "按约定", not an assessment: whether that last task really IS an
  // independent acceptance task is the plan AUDIT's judgement (its 10th
  // check). Stating the convention is what lets both readers — the auditor
  // above all — check it against the task's own title, and a marker that
  // quietly asserted "this one accepts" would be the gate telling them the
  // answer it is supposed to be examining.
  const acceptance = acceptanceTaskId(plan);
  for (const t of plan.tasks) {
    const deps = t.dependsOn.length ? ` ← ${t.dependsOn.join(", ")}` : "";
    const acceptMark = t.id === acceptance
      ? "　← 按约定：plan 的最后一环 = 独立验收任务（真实验收 → push → 开 PR；汇合 / 整体审核 / commit 是倒数第二个收尾任务的事）"
      : "";
    lines.push(
      `- [${t.status}] ${t.id} (${t.execution})${deps}：${t.title}${acceptMark}` +
      (t.repo ? `\n    repo：${t.repo}` : ""),
    );
    // THE TASK BOOK IS RENDERED (2026-09-21). Two facts make this line load-
    // bearing rather than decorative, and both were measured as failures:
    //
    //  1. The plan AUDIT is told to check "is this task book complete enough for
    //     a child to negotiate its own goal" (its 8th check), "read the landing
    //     place", "read the last two tasks' notes" (9th and 10th) — while this
    //     summary, which IS the plan the auditor is given, rendered only the
    //     structured fields. The auditor reported "四个任务仍然没有 note" on four
    //     consecutive submissions of a plan whose notes were all present and
    //     600–1100 characters long, and no revision of the notes could ever
    //     change that conclusion.
    //  2. The same summary IS the text the user reads before approving and the
    //     text `orchestrator_plan({action:"read"})` returns, so the assignment
    //     every child would receive was invisible to the two parties who decide
    //     whether it is right.
    //
    // Rendering it changes NO hash: `canonicalPlanText` still excludes the note
    // (that is what keeps a note revision free of a re-approval), so this is a
    // reading-side fix and nothing else.
    const note = (t.note ?? "").trim();
    if (note) {
      lines.push("    任务书：", ...note.split("\n").map((line) => `      ${line}`));
    }
  }
  // NO "parallel downgrade" LINE ANY MORE (2026-09-10). It reported that two
  // tasks in one repo could not run at once — which stopped being true when
  // the second one started getting its own checkout
  // (lib/orchestrator-worktree.ts). A warning about a downgrade that no longer
  // happens is worse than no warning: it teaches the user to expect a slowdown
  // they will not get, and it hides the real question (whether two tasks are
  // about to touch the same files, which the worktrees make survivable but not
  // free).
  const open = openDecisions(plan);
  if (open.length) {
    lines.push("", "待用户决策：" + open.map((d) => `${d.id}（${d.notifiedAt ? "已通知" : "未通知"}）`).join("、"));
  }
  return lines.join("\n");
}
