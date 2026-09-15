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

/** The subset of a plan this rule reads — structural, so it imports no plan. */
export interface RepoPrPlanInput {
  deliveryStation: DeliveryStation;
  /** Repos whose multiple tasks may each open their own PR (user decision). */
  allowMultiplePrs?: readonly string[];
  tasks: readonly { id: string; repo?: string }[];
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
  taskIds: string[];
  /** What every task in this repo may reach. */
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
    if (taskIds.length < 2) continue;
    if (allowsMultiplePrs(plan, repo)) continue;
    // A plan that already stops at or below the cap is not narrowed — saying
    // "narrowed to commit" about a plan whose station IS commit would be a
    // lie the user can see through.
    if (deliveryStationRank(plan.deliveryStation) <= deliveryStationRank(MULTI_TASK_REPO_STATION)) continue;
    narrowings.push({ repo, taskIds, station: MULTI_TASK_REPO_STATION });
  }
  return narrowings;
}

/**
 * HOW FAR THIS REPO MAY GO. The single question every consumer asks; it never
 * widens — a plan at `precommit` stays at `precommit`.
 */
export function effectiveRepoStation(
  plan: RepoPrPlanInput,
  repo: string,
  defaultRepo: string,
): DeliveryStation {
  const target = normalizeRepoPath(repo);
  const narrowed = narrowedRepoStations(plan, defaultRepo).find((n) => n.repo === target);
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
  return narrowedRepoStations(plan, defaultRepo).map((n) =>
    indent + `同一 repo 一个需求只出一个 PR：${n.repo} 上有 ${n.taskIds.length} 个任务（${n.taskIds.join("、")}）` +
    `⇒ 该 repo 的交付站点收窄为 ${n.station} —— 子会话提交完就停，由项目经理本地合并，你验证后再开一个 PR。` +
    `要分多个 PR，请在 plan 里把该 repo 写进 allowMultiplePrs 并重新批准。`,
  );
}

/** The same fact, as one sentence, for a station line that needs the reason. */
export function narrowingReasonFor(
  plan: RepoPrPlanInput,
  repo: string,
  defaultRepo: string,
): string | undefined {
  const target = normalizeRepoPath(repo);
  const found = narrowedRepoStations(plan, defaultRepo).find((n) => n.repo === target);
  if (!found) return undefined;
  return `该 repo 有 ${found.taskIds.length} 个任务（${found.taskIds.join("、")}）—— 同一 repo 的一个需求只出一个 PR：` +
    `先本地合并、用户验证后再开一个 PR。要分多个 PR，需要在 plan 里声明 allowMultiplePrs。`;
}
