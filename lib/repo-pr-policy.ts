/**
 * ONE PR PER REPO PER REQUIREMENT — how far each repository in an
 * orchestration is allowed to travel.
 *
 * ── THE MEASURED FAILURE (2026-09-15, onchain, user decision) ──
 *
 * A plan put three tasks in one repository, all at station `pr`. Each child
 * ran its own review loop and shipped its own branch, so a single requirement
 * arrived as THREE pull requests (#1217/#1218/#1219). The user's answer is the
 * rule this module encodes: a requirement that lands in one repository comes
 * out as ONE pull request, merged locally first, so the verification happens
 * on the combined result rather than on three slices that were never run
 * together. Splitting is not forbidden — it is exactly what a plan has to say
 * out loud (`allowMultiplePrs`), because it is the user's call.
 *
 * ── WHERE THE NARROWING HAPPENS, AND WHY IT IS A NARROWING ──
 *
 * The station of a task is `min(plan.deliveryStation, commit)` whenever its
 * repo holds more than one task and that repo is not named in
 * `allowMultiplePrs`. Lowering a station takes authority away, which is the
 * direction the whole approval model already treats as safe to apply without
 * asking again (lib/orchestrator-plan-approval.ts: raising it is a widening,
 * lowering it carries). So the plan the user approved keeps its own
 * `deliveryStation` — nothing is rewritten behind their back — and this module
 * answers the narrower question every consumer actually asks: **how far may
 * THIS child go?**
 *
 * WHY IT IS PURE AND STRUCTURAL: four callers need the same answer from three
 * different processes — the plan approval dialog (the user reads it), the
 * dispatcher (it stamps the child's ceiling), the project manager's proxy
 * answer (it may not confirm something looser) and the child's own goal
 * dialog. A copy of the rule per caller is the second implementation AGENTS.md
 * philosophy three forbids; a module with no filesystem, no clock and no plan
 * import can be called from every one of them.
 *
 * ── THE TAIL IS TWO LINKS; ONLY THE LAST ONE IS EXEMPT (2026-09-22) ──
 *
 * The rule above, applied to EVERY task, left an orchestration with nobody
 * who could publish: the manager may not ship (constraint 2 confines it to the
 * plan and the handoff docs) and every child of a multi-task repo was capped
 * at `commit`. That is not a theory — it is how a whole round ended with the
 * work committed, the plan complete, and no way to open the PR; the manager's
 * proposal to drop back to loop mode was refused by the user, who named the
 * real fix: the plan's LAST task IS the delivery.
 *
 * 2026-09-18 put that whole tail on ONE task: the last task merged the other
 * branches, was reviewed as a whole, committed, pushed and opened the PR. That
 * made the session which wrote the code the one that declared it good. The
 * tail is TWO links now (2026-09-22, user decision), split by position again:
 *
 *  - the SECOND-TO-LAST task is the WRAP-UP (收尾任务): it merges the other
 *    branches, takes the whole through one review, and commits. It is capped
 *    by the rule above like any other task — merging is work, and work stops
 *    at `commit` when its repo publishes one PR.
 *  - the LAST task is the independent ACCEPTANCE task (验收任务): no new
 *    requirement, no business code — it runs the REAL acceptance and delivers
 *    (push, PR). It is the ONE task this cap never touches, because capping it
 *    would leave nobody who may publish at all.
 *
 * Both of them still COUNT as tasks of their repo (2026-09-18): one repo
 * publishes ONE PR per requirement, so a last task that ships while a sibling
 * opens its own PR would publish the same requirement twice.
 *
 * POSITION, NOT A FIELD. There is no `kind: "finish"` / `kind: "acceptance"`
 * in the plan schema and there must not be one: `canonicalPlanText` is exactly
 * what the user approved, and a new field would be a new thing to approve (and
 * a new way to say the delivery belongs to nobody). What objects when the last
 * task is not an independent acceptance task is the plan audit —
 * `lib/orchestrator-plan-audit.ts`.
 */

import { deliveryStationRank, type DeliveryStation } from "./delivery-station.ts";

/**
 * The station every repo in a multi-task plan is capped at.
 *
 * `commit` and not `precommit`: the child's own review loop commits its work
 * (the checkpoint chain needs it), so a cap at `precommit` would forbid a
 * commit the gate itself makes. `commit` is exactly "the work is in a branch,
 * nobody published it", which is what "the manager merges it locally" needs.
 */
export const MULTI_TASK_REPO_STATION: DeliveryStation = "commit";

/**
 * The environment variable that carries a child's station CEILING.
 *
 * A child negotiates its OWN goal, in its own process, and the dialog it shows
 * must not offer a station the plan already ruled out — a user who picks `pr`
 * because nothing told them otherwise has been misled by the gate, not by
 * themselves. So the ceiling travels as an ENVIRONMENT FACT, written by the
 * dispatcher that computed it, read by the goal dialog in the child's process.
 *
 * It rides the environment rather than the task document for the usual reason:
 * the task document is text the orchestrator writes and the gate appends to,
 * while an environment variable is set by the gate and nothing else — the one
 * channel a child's own prompt cannot forge (the same argument
 * `RG_ORCHESTRATION_ID` / `RG_STATE_VARIANT` rest on).
 */
export const STATION_CAP_ENV = "RG_STATION_CAP";

/** A task, as far as this rule reads it: an id and the repo it lands in. */
export interface RepoPrTask {
  id: string;
  repo?: string;
}

/** The subset of a plan this rule reads — structural, so it imports no plan. */
export interface RepoPrPlanInput {
  deliveryStation: DeliveryStation;
  /** Repos whose multiple tasks may each open their own PR (user decision). */
  allowMultiplePrs?: readonly string[];
  tasks: readonly RepoPrTask[];
}

/**
 * Which repo a task lands in. A task without `repo` works in the
 * orchestration's own checkout, which is the same default the dispatcher and
 * the scheduler apply (`task.repo ?? repoRoot`) — restating it here keeps the
 * count and the spawn from ever disagreeing about where a child writes.
 */
export function taskRepoOf(task: { repo?: string }, defaultRepo: string): string {
  return normalizeRepoPath(task.repo ?? defaultRepo);
}

/** Trailing slashes are not a different repository. */
export function normalizeRepoPath(path: string): string {
  const trimmed = path.trim();
  return trimmed.length > 1 && trimmed.endsWith("/") ? trimmed.replace(/\/+$/, "") : trimmed;
}

/**
 * The plan's LAST task — the INDEPENDENT ACCEPTANCE task (验收任务): it runs
 * the real acceptance and delivers (push + PR). `undefined` only for a plan
 * with no tasks at all.
 *
 * ── HANDOFF: THIS IS THE DETERMINATION (t2-round consumes it) ──
 *
 * "Which child session's acceptance gate is open?" is answered HERE and
 * nowhere else: the acceptance task IS the plan's last task, by position. A
 * consumer asks for it by name (`acceptanceTaskId(plan)`) — it never
 * re-derives the index and never writes a second predicate, which is how the
 * gate and the station rule would drift apart. The wrap-up task (merge + one
 * whole review + commit) is the plan's SECOND-to-last; it is capped by the
 * rule below like any other task, and only the task this function names takes
 * `plan.deliveryStation` uncapped.
 *
 * Exported because the convention has more than one reader: the station rule
 * below, the summary the user approves (`formatPlanSummary` marks it) and the
 * plan audit's checklist. ONE function, so "which task is the acceptance
 * task" cannot be answered two ways.
 *
 * (Renamed 2026-09-22, with the split: the WRAP-UP task is the 收尾任务, so a
 * name built on "finish" pointed at two different tasks depending on who read
 * it.)
 */
export function acceptanceTaskId(plan: RepoPrPlanInput): string | undefined {
  return plan.tasks.length > 0 ? plan.tasks[plan.tasks.length - 1]!.id : undefined;
}

/** Task ids per repo, in plan order. */
export function tasksByRepo(plan: RepoPrPlanInput, defaultRepo: string): Map<string, string[]> {
  const byRepo = new Map<string, string[]>();
  for (const task of plan.tasks) {
    const repo = taskRepoOf(task, defaultRepo);
    const list = byRepo.get(repo);
    if (list) list.push(task.id);
    else byRepo.set(repo, [task.id]);
  }
  return byRepo;
}

/** Does the user's own plan text allow this repo to open more than one PR? */
export function allowsMultiplePrs(plan: RepoPrPlanInput, repo: string): boolean {
  const target = normalizeRepoPath(repo);
  return (plan.allowMultiplePrs ?? []).some((entry) => normalizeRepoPath(entry) === target);
}

/** One repo whose station is narrower than the plan's. */
export interface RepoNarrowing {
  repo: string;
  /**
   * EVERY task in this repo, in plan order — including the acceptance task,
   * which counts towards the one-PR-per-repo rule even though it is never
   * capped.
   */
  taskIds: string[];
  /** What every capped task in this repo may reach. */
  station: DeliveryStation;
}

/**
 * Every repo running more than one task without an explicit exemption — the
 * list the approval dialog prints and the test asserts on.
 */
export function narrowedRepoStations(
  plan: RepoPrPlanInput,
  defaultRepo: string,
): RepoNarrowing[] {
  const narrowings: RepoNarrowing[] = [];
  for (const [repo, taskIds] of tasksByRepo(plan, defaultRepo)) {
    // The COUNT is every task in the repo, the finish task included: it is one
    // PR per repo per requirement, and a plan whose last task publishes while
    // a sibling opens its own PR publishes the same requirement twice.
    if (taskIds.length < 2) continue;
    if (allowsMultiplePrs(plan, repo)) continue;
    // A plan that already stops at or below the cap is not narrowed — saying
    // "narrowed to commit" about a plan whose station IS commit would be a
    // lie the user can see through.
    if (deliveryStationRank(plan.deliveryStation) <= deliveryStationRank(MULTI_TASK_REPO_STATION)) continue;
    narrowings.push({
      repo,
      taskIds,
      station: MULTI_TASK_REPO_STATION,
    });
  }
  return narrowings;
}

/**
 * HOW FAR THIS TASK MAY GO. The single question every consumer asks; it never
 * widens — a plan at `precommit` stays at `precommit`.
 *
 * TASK-wise, not repo-wise, since 2026-09-18: the answer differs WITHIN one
 * repo once the plan ends with a delivery task. The task itself is the input
 * (not a repo string a caller looked up separately), because two spellings of
 * "which repo is this task in" is how a capped repo would hand its child an
 * unlimited station.
 */
export function effectiveTaskStation(
  plan: RepoPrPlanInput,
  task: RepoPrTask,
  defaultRepo: string,
): DeliveryStation {
  // The acceptance task delivers; capping it would leave nobody who may publish.
  if (task.id === acceptanceTaskId(plan)) return plan.deliveryStation;
  const repo = taskRepoOf(task, defaultRepo);
  const narrowed = narrowedRepoStations(plan, defaultRepo).find((n) => n.repo === repo);
  return narrowed ? narrowed.station : plan.deliveryStation;
}

/**
 * Apply a CEILING to a requested station.
 *
 * The ceiling is the child's own spawn-time cap, read from its environment —
 * the station its task was dispatched with. A requested station beyond it is
 * clamped silently, because the clamped value is what the user is shown in the
 * dialog: they are never asked about a station the plan already ruled out.
 */
export function capStationAt(
  requested: DeliveryStation,
  cap: DeliveryStation | undefined,
): DeliveryStation {
  if (cap === undefined) return requested;
  return deliveryStationRank(requested) > deliveryStationRank(cap) ? cap : requested;
}

/** One line per narrowed repo, for the approval dialog and the plan summary. */
export function narrowedRepoLines(
  plan: RepoPrPlanInput,
  defaultRepo: string,
  indent = "  - ",
): string[] {
  const acceptance = acceptanceTaskId(plan);
  return narrowedRepoStations(plan, defaultRepo).map((n) => {
    // The exemption is stated where the station is, for the same reason the
    // narrowing itself is: a plan that says "every child stops at commit" while
    // one of them is about to open the PR is a contract the user cannot read.
    const exempt = acceptance !== undefined && n.taskIds.includes(acceptance)
      ? `（最后一环 ${acceptance} 是独立验收任务、不受这条收窄）`
      : "";
    return indent + `同一 repo 一个需求只出一个 PR：${n.repo} 上有 ${n.taskIds.length} 个任务（${n.taskIds.join("、")}）` +
      `⇒ 该 repo 的交付站点收窄为 ${n.station}${exempt} —— 其余子会话提交完就停，` +
      `收尾任务汇合它们、走一次整体审核并 commit，最后的验收任务开出这一个 PR。` +
      `要分多个 PR，请在 plan 里把该 repo 写进 allowMultiplePrs 并重新批准。`;
  });
}

/**
 * The same fact, as one sentence, for a station line that needs the reason.
 *
 * `undefined` for the acceptance task: its station is the plan's, so there is
 * no narrowing to explain — and a task book that explained one anyway would
 * tell the child it may not do the very thing it was spawned for.
 */
export function narrowingReasonFor(
  plan: RepoPrPlanInput,
  task: RepoPrTask,
  defaultRepo: string,
): string | undefined {
  if (task.id === acceptanceTaskId(plan)) return undefined;
  const target = taskRepoOf(task, defaultRepo);
  const found = narrowedRepoStations(plan, defaultRepo).find((n) => n.repo === target);
  if (!found) return undefined;
  return `该 repo 有 ${found.taskIds.length} 个任务（${found.taskIds.join("、")}）—— 同一 repo 的一个需求只出一个 PR：` +
    `其余任务的成果由收尾任务汇合、由独立验收任务（${acceptanceTaskId(plan) ?? "最后一环"}）统一交付。` +
    `要分多个 PR，需要在 plan 里声明 allowMultiplePrs。`;
}
