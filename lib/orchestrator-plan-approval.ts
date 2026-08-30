/**
 * DOES THIS PLAN EDIT STILL NEED THE USER? — the narrow interface that stops
 * "one task dispatched, one human woken up".
 *
 * ── THE MEASURED FAILURE (round-4 P0) ──
 *
 * A plan approval binds to CONTENT, and that is right: without it an
 * orchestrator could widen a task's file boundary after the fact and spawn a
 * child with powers nobody granted. But the ONLY way to change a boundary was
 * to rewrite the whole plan, and rewriting the plan dropped the approval — so
 * the fourth end-to-end run popped the approval dialog THREE times in one
 * orchestration, the second one to an empty chair for 425 seconds.
 *
 * The boundary edits that caused it were not power grabs. Both were the same
 * honest discovery: a task declared `lib/user-interaction-tools.ts`, the child
 * read the code, and the module had to become two files because the gate's own
 * 600-line rule refused one. An orchestrator CANNOT know that at planning
 * time. So "widening a boundary" was being treated as one thing when it is
 * really two, and only one of them concerns the user.
 *
 * ── WHAT THIS MODULE DECIDES ──
 *
 * Given the snapshot of what the user APPROVED and the plan being written now,
 * does the new plan grant anything the old one did not? Every difference is
 * classified into exactly one of:
 *
 *   - a WIDENING — new task, a directory nobody approved, a dependency
 *     removed, serial→parallel, a higher `maxParallel`. Any single one of
 *     these revokes the approval, and the user is asked again.
 *   - an AMENDMENT — the boundary shrank, a task was dropped, a dependency was
 *     ADDED (more serial, never less), parallel→serial, or a new path that
 *     lands inside the directory prefix of a boundary this task already had
 *     AND collides with no other task. The approval carries over, and the
 *     amendment is recorded so the change is never silent.
 *
 * ── WHY THE DIRECTORY-PREFIX RULE IS SAFE, AND WHERE IT STOPS ──
 *
 * The user was asked (2026-08-30) and accepted the semantics explicitly: an
 * approved boundary covers new files in ITS OWN directory that no other task
 * claims. `lib/user-interaction-tools.ts` therefore admits
 * `lib/consent-request-tools.ts`, and the approval dialog says so in as many
 * words — the one thing that must never happen is a user discovering the rule
 * afterwards.
 *
 * Three hard stops keep that from becoming "anywhere":
 *
 *  1. A boundary with no slash (`README.md`, or a top-level `lib` directory)
 *     yields NO prefix. Normalization cannot tell a top-level file from a
 *     top-level directory, and guessing wrong would turn one approved file
 *     into the whole repository. A declared directory does not need the rule
 *     anyway: `lib` already COVERS `lib/anything.ts` outright.
 *  2. The new path must not touch any other task's boundaries — neither in the
 *     approved snapshot nor in the plan being written. Constraint 6's whole
 *     point is that two writers never share a file, and buying parallelism by
 *     quietly annexing a sibling's directory is exactly the move this refuses.
 *  3. Only tasks that ALREADY EXIST may be amended. A new task has no approved
 *     boundary to take a prefix from, so it can only ever be a widening.
 *
 * Pure module: two plans in, a verdict and human-readable reasons out. It
 * reads nothing, writes nothing, and never decides on its own whether to show
 * a dialog — lib/orchestrator-tools.ts does that with this verdict in hand.
 */

import {
  boundaryCovers,
  boundariesConflict,
  type NormalizedBoundary,
} from "./orchestrator-boundaries.ts";
import type { OrchestratorPlan, TaskExecution } from "./orchestrator-plan.ts";

/** The authorization-relevant shape of one task, as the user approved it. */
export interface ApprovedTaskSnapshot {
  id: string;
  fileBoundaries: NormalizedBoundary[];
  dependsOn: string[];
  execution: TaskExecution;
}

/**
 * What the user actually signed, kept beside the hash.
 *
 * The HASH alone answers "is this the same plan"; it cannot answer "is this
 * plan weaker than the one that was approved", which is the question that
 * spares the human a dialog. So the authorizing FIELDS are stored too — and
 * only those: titles, statuses and notes are excluded exactly as they are from
 * `canonicalPlanText`, because they grant nothing.
 */
export interface ApprovedPlanSnapshot {
  /** `planHash` of the approved content — what the runtime binds to. */
  hash: string;
  /** ISO time the user approved it. */
  at: string;
  maxParallel: number;
  tasks: ApprovedTaskSnapshot[];
}

/** Capture the authorizing fields of a plan the user just approved. */
export function snapshotApprovedPlan(
  plan: OrchestratorPlan,
  hash: string,
  at: string,
): ApprovedPlanSnapshot {
  return {
    hash,
    at,
    maxParallel: plan.maxParallel,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      fileBoundaries: [...task.fileBoundaries],
      dependsOn: [...task.dependsOn],
      execution: task.execution,
    })),
  };
}

/** The verdict: may the approval survive this edit, and what changed? */
export interface ApprovalCarryDecision {
  /** True ⇒ no dialog: the edit granted nothing new. */
  carries: boolean;
  /** Every power the new plan would add. Non-empty ⇒ `carries` is false. */
  widenings: string[];
  /** Changes that kept the approval, recorded for the audit trail. */
  amendments: string[];
}

/**
 * The directory an approved boundary may absorb new files into.
 *
 * `undefined` when the boundary has no slash — see hard stop 1 in the header.
 * A boundary of `.` (the whole repo) also yields `undefined`, and loses
 * nothing by it: it already covers every path outright.
 */
export function boundaryDirPrefix(boundary: NormalizedBoundary): NormalizedBoundary | undefined {
  if (boundary === ".") return undefined;
  const cut = boundary.lastIndexOf("/");
  return cut > 0 ? boundary.slice(0, cut) : undefined;
}

/** Boundaries belonging to every task EXCEPT `taskId`, from both plans. */
function foreignBoundaries(
  approved: ApprovedPlanSnapshot,
  next: OrchestratorPlan,
  taskId: string,
): NormalizedBoundary[] {
  const all: NormalizedBoundary[] = [];
  for (const task of approved.tasks) {
    if (task.id !== taskId) all.push(...task.fileBoundaries);
  }
  for (const task of next.tasks) {
    if (task.id !== taskId) all.push(...task.fileBoundaries);
  }
  return all;
}

/**
 * Classify one edit of one task's boundaries.
 *
 * Returns the widenings it produced (empty ⇒ the edit is amendable) plus the
 * amendments worth recording. Exported so the protocol test can drive exactly
 * this rule instead of a whole plan.
 */
export function classifyBoundaryChange(opts: {
  taskId: string;
  approvedBoundaries: readonly NormalizedBoundary[];
  nextBoundaries: readonly NormalizedBoundary[];
  /** Boundaries owned by OTHER tasks (approved and proposed alike). */
  foreign: readonly NormalizedBoundary[];
}): { widenings: string[]; amendments: string[] } {
  const widenings: string[] = [];
  const amendments: string[] = [];

  for (const dropped of opts.approvedBoundaries) {
    if (!opts.nextBoundaries.includes(dropped)) {
      amendments.push(`任务 "${opts.taskId}" 收回了边界 ${dropped}`);
    }
  }

  for (const added of opts.nextBoundaries) {
    // Already inside something the user approved (`lib/` ⇒ `lib/a.ts`, or an
    // unchanged entry): this is a refinement, not a grant.
    if (opts.approvedBoundaries.some((approved) => boundaryCovers(approved, added))) continue;

    const host = opts.approvedBoundaries.find((approved) => {
      const prefix = boundaryDirPrefix(approved);
      return prefix !== undefined && boundaryCovers(prefix, added);
    });
    if (!host) {
      widenings.push(
        `任务 "${opts.taskId}" 新增边界 ${added} —— 不在任何已批准边界（${
          opts.approvedBoundaries.join("、") || "无"
        }）的目录内`,
      );
      continue;
    }
    const clash = opts.foreign.find((other) => boundariesConflict(other, added));
    if (clash) {
      widenings.push(
        `任务 "${opts.taskId}" 新增边界 ${added} 与其他任务已声明的 ${clash} 相交 —— 免批准不覆盖「把别人的地盘划过来」`,
      );
      continue;
    }
    amendments.push(
      `任务 "${opts.taskId}" 在已批准的 ${boundaryDirPrefix(host)}/ 内细化出 ${added}（未与其他任务相交）`,
    );
  }

  return { widenings, amendments };
}

/**
 * Compare what was approved with what is being written.
 *
 * Fail-closed by construction: every difference must be recognized as an
 * amendment to survive, and anything this function does not understand falls
 * through to a widening — the direction that asks the user.
 */
export function decideApprovalCarry(
  approved: ApprovedPlanSnapshot,
  next: OrchestratorPlan,
): ApprovalCarryDecision {
  const widenings: string[] = [];
  const amendments: string[] = [];

  if (next.maxParallel > approved.maxParallel) {
    widenings.push(`并行上限从 ${approved.maxParallel} 提到 ${next.maxParallel}`);
  } else if (next.maxParallel < approved.maxParallel) {
    amendments.push(`并行上限从 ${approved.maxParallel} 降到 ${next.maxParallel}`);
  }

  const approvedById = new Map(approved.tasks.map((task) => [task.id, task]));
  const nextIds = new Set(next.tasks.map((task) => task.id));
  for (const gone of approved.tasks) {
    if (!nextIds.has(gone.id)) amendments.push(`任务 "${gone.id}" 已从 plan 中删除`);
  }

  for (const task of next.tasks) {
    const before = approvedById.get(task.id);
    if (!before) {
      // Hard stop 3: a task the user never saw has no approved boundary to
      // refine, so there is nothing to compare it against.
      widenings.push(`新增任务 "${task.id}"（用户从未批准过它，也没有它的边界）`);
      continue;
    }

    const removedDeps = before.dependsOn.filter((dep) => !task.dependsOn.includes(dep));
    if (removedDeps.length > 0) {
      widenings.push(
        `任务 "${task.id}" 删除了前置依赖 ${removedDeps.join("、")} —— 会让原本串行的两个任务并起来跑`,
      );
    }
    const addedDeps = task.dependsOn.filter((dep) => !before.dependsOn.includes(dep));
    if (addedDeps.length > 0) {
      amendments.push(`任务 "${task.id}" 增加了前置依赖 ${addedDeps.join("、")}（更串行）`);
    }

    if (before.execution === "serial" && task.execution === "parallel") {
      widenings.push(`任务 "${task.id}" 从 serial 改成 parallel`);
    } else if (before.execution === "parallel" && task.execution === "serial") {
      amendments.push(`任务 "${task.id}" 从 parallel 改成 serial`);
    }

    const boundaries = classifyBoundaryChange({
      taskId: task.id,
      approvedBoundaries: before.fileBoundaries,
      nextBoundaries: task.fileBoundaries,
      foreign: foreignBoundaries(approved, next, task.id),
    });
    widenings.push(...boundaries.widenings);
    amendments.push(...boundaries.amendments);
  }

  return { carries: widenings.length === 0, widenings, amendments };
}

/** One line per amendment, for the tool reply and the runtime audit trail. */
export function formatApprovalAmendments(amendments: readonly string[]): string {
  if (amendments.length === 0) return "内容与已批准的版本一致，批准仍然有效。";
  return (
    "批准**继续有效**（这些改动没有扩大任何权限，因此没有惊动用户）：\n" +
    amendments.map((line) => `  - ${line}`).join("\n")
  );
}

/** Why the user has to be asked again — printed when the approval is dropped. */
export function formatApprovalWidenings(widenings: readonly string[]): string {
  return (
    "批准**已失效**，因为这次改动扩大了权限：\n" +
    widenings.map((line) => `  - ${line}`).join("\n") +
    "\n用 `orchestrator_plan({ action: \"submit\" })` 重新请用户批准后才能 spawn。"
  );
}
