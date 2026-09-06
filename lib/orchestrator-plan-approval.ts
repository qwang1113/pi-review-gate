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
import {
  DEFAULT_DELIVERY_STATION,
  isStationWidening,
  type DeliveryStation,
} from "./delivery-station.ts";

/** The authorization-relevant shape of one task, as the user approved it. */
export interface ApprovedTaskSnapshot {
  id: string;
  fileBoundaries: NormalizedBoundary[];
  dependsOn: string[];
  execution: TaskExecution;
  repo?: string;
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
  /**
   * The station the user approved (2026-09-06).
   *
   * Optional because runtimes written before the field existed have none —
   * and a missing value is read as the STRICTEST station (`precommit`), so an
   * old snapshot can only ever make the next edit look like a widening, never
   * like less of one.
   */
  deliveryStation?: DeliveryStation;
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
    deliveryStation: plan.deliveryStation,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      fileBoundaries: [...task.fileBoundaries],
      dependsOn: [...task.dependsOn],
      execution: task.execution,
      ...(task.repo ? { repo: task.repo } : {}),
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

/**
 * The APPROVED DIRECTORY TREE of one task — every prefix its approved
 * boundaries may absorb a new path into, which is also the list a refusal has
 * to name to be actionable.
 *
 * `lib/a.ts` admits `lib/`; a declared directory (`test`) admits itself; a
 * top-level FILE (`README.md`) admits only itself, because normalization
 * cannot tell it from a top-level directory and guessing wrong would turn one
 * approved file into the whole repository (hard stop 1).
 */
export function approvedTree(boundaries: readonly NormalizedBoundary[]): NormalizedBoundary[] {
  const tree: NormalizedBoundary[] = [];
  for (const boundary of boundaries) {
    const prefix = boundaryDirPrefix(boundary) ?? boundary;
    if (!tree.includes(prefix)) tree.push(prefix);
  }
  return tree;
}

/** A boundary another task holds — with WHO holds it, so a refusal can name them. */
export interface ForeignBoundary {
  /** The task that declared it. */
  taskId: string;
  boundary: NormalizedBoundary;
  /**
   * The plan records that task as `done` (2026-09-06, user decision).
   *
   * A finished task's declaration no longer keeps anyone out: it exists to
   * stop two LIVE writers from sharing a file, and nothing is writing under
   * it any more. Without this, a task's boundaries went on blocking every
   * later task for the rest of the orchestration — measured in round 8, where
   * moving two files from a DONE task to the one that needed them was judged
   * a power grab and cost an approval dialog.
   */
  releasedByDone: boolean;
}

/** Boundaries belonging to every task EXCEPT `taskId`, from both plans. */
function foreignBoundaries(
  approved: ApprovedPlanSnapshot,
  next: OrchestratorPlan,
  taskId: string,
  doneTaskIds: ReadonlySet<string>,
): ForeignBoundary[] {
  const all: ForeignBoundary[] = [];
  const collect = (id: string, boundaries: readonly NormalizedBoundary[]) => {
    if (id === taskId) return;
    for (const boundary of boundaries) {
      all.push({ taskId: id, boundary, releasedByDone: doneTaskIds.has(id) });
    }
  };
  for (const task of approved.tasks) collect(task.id, task.fileBoundaries);
  for (const task of next.tasks) collect(task.id, task.fileBoundaries);
  return all;
}

/**
 * Classify one edit of one task's boundaries.
 *
 * Returns the widenings it produced (empty ⇒ the edit is amendable) plus the
 * amendments worth recording. Exported so the protocol test can drive exactly
 * this rule instead of a whole plan.
 *
 * Every line it produces NAMES ITS REASON, because the receipt is the only
 * thing the orchestrator sees: a carry says which approved directory absorbed
 * the path (and, if a finished task used to hold it, that this is why it no
 * longer clashes), and a refusal says either which task stands in the way or
 * which directories the task actually holds.
 */
export function classifyBoundaryChange(opts: {
  taskId: string;
  approvedBoundaries: readonly NormalizedBoundary[];
  nextBoundaries: readonly NormalizedBoundary[];
  /** Boundaries owned by OTHER tasks (approved and proposed alike). */
  foreign: readonly ForeignBoundary[];
}): { widenings: string[]; amendments: string[] } {
  const widenings: string[] = [];
  const amendments: string[] = [];

  for (const dropped of opts.approvedBoundaries) {
    if (!opts.nextBoundaries.includes(dropped)) {
      amendments.push(`任务 "${opts.taskId}" 收回了边界 ${dropped}`);
    }
  }

  const tree = approvedTree(opts.approvedBoundaries);
  for (const added of opts.nextBoundaries) {
    // Already inside something the user approved (`lib/` ⇒ `lib/a.ts`, or an
    // unchanged entry): this is a refinement, not a grant.
    if (opts.approvedBoundaries.some((approved) => boundaryCovers(approved, added))) continue;

    const host = tree.find((prefix) => boundaryCovers(prefix, added));
    if (!host) {
      widenings.push(
        `任务 "${opts.taskId}" 新增边界 ${added} —— 不在该任务已批准的目录树（${
          tree.join("、") || "无"
        }）内`,
      );
      continue;
    }
    // A LIVE task's claim blocks; a DONE task's claim does not (see
    // ForeignBoundary.releasedByDone). Both are looked up, because the
    // released one is what makes the carry explainable.
    const clash = opts.foreign.find((other) => !other.releasedByDone && boundariesConflict(other.boundary, added));
    if (clash) {
      widenings.push(
        `任务 "${opts.taskId}" 新增边界 ${added} 与任务 "${clash.taskId}" 已声明的 ${clash.boundary} 相交 —— 免批准不覆盖「把别人的地盘划过来」`,
      );
      continue;
    }
    const released = opts.foreign.find((other) => other.releasedByDone && boundariesConflict(other.boundary, added));
    amendments.push(
      released
        ? `任务 "${opts.taskId}" 在已批准的 ${host}/ 内细化出 ${added}（原持有者 "${released.taskId}" 已 done，退出相交判定）`
        : `任务 "${opts.taskId}" 在已批准的 ${host}/ 内细化出 ${added}（未与其他任务相交）`,
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

  // TASKS THAT ARE FINISHED STOP HOLDING GROUND (2026-09-06, user decision).
  //
  // A `done` task's boundaries are excluded from the intersection check, so
  // the files it needed can move to whoever needs them next without waking
  // the user. Two conditions keep this from being a way to MINT the release:
  // the status must come from the plan's execution record (`write` never sets
  // one — mergeTaskProgress carries the previous status forward, and
  // `set-status` is the only way one changes), and the task must exist in the
  // APPROVED snapshot, so a brand-new task declaring itself `done` in the
  // same edit releases nothing (adding it is a widening in its own right).
  const approvedById = new Map(approved.tasks.map((task) => [task.id, task]));
  const doneTaskIds = new Set(
    next.tasks.filter((task) => task.status === "done" && approvedById.has(task.id)).map((task) => task.id),
  );


  if (next.maxParallel > approved.maxParallel) {
    widenings.push(`并行上限从 ${approved.maxParallel} 提到 ${next.maxParallel}`);
  } else if (next.maxParallel < approved.maxParallel) {
    amendments.push(`并行上限从 ${approved.maxParallel} 降到 ${next.maxParallel}`);
  }

  // THE DELIVERY STATION (2026-09-06) is authority, so it is classified the
  // same way parallelism is: raising it (precommit → commit → pr) hands the
  // orchestration ship commands the user never granted and revokes the
  // approval; lowering it takes authority away and carries. A snapshot with
  // no station at all is read as the strictest one, so an approval predating
  // the field can only be asked about again, never silently widened.
  const approvedStation = approved.deliveryStation ?? DEFAULT_DELIVERY_STATION;
  if (isStationWidening(approvedStation, next.deliveryStation)) {
    widenings.push(`交付站点从 ${approvedStation} 提到 ${next.deliveryStation}（放开了更多 ship 命令）`);
  } else if (approvedStation !== next.deliveryStation) {
    amendments.push(`交付站点从 ${approvedStation} 收紧到 ${next.deliveryStation}`);
  }

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
    // 2026-09-07: a task's `repo` decides which checkout it writes in. A
    // change of repo is a NEW write surface — always a widening, never an
    // amendment (the user approved the task in one repo; moving it to
    // another must be re-approved).
    if ((before.repo ?? undefined) !== (task.repo ?? undefined)) {
      widenings.push(`任务 "${task.id}" 的工作 repo 从 ${before.repo ?? "(主 repo)"} 改为 ${task.repo ?? "(主 repo)"}`);
    }

    const boundaries = classifyBoundaryChange({
      taskId: task.id,
      approvedBoundaries: before.fileBoundaries,
      nextBoundaries: task.fileBoundaries,
      foreign: foreignBoundaries(approved, next, task.id, doneTaskIds),
    });
    widenings.push(...boundaries.widenings);
    amendments.push(...boundaries.amendments);
  }

  return { carries: widenings.length === 0, widenings, amendments };
}

// ---------------------------------------------------------------------------
// THE APPROVAL LINEAGE — undoing a widening must not cost a second approval
// ---------------------------------------------------------------------------
//
// ── THE MEASURED FAILURE (round-8) ──
//
// An orchestrator added `README.md` to a task, the gate correctly called it a
// widening and revoked the approval, and the orchestrator immediately wrote
// the plan back the way it was. The bytes it wrote were IDENTICAL to the
// content the user had signed — and the approval did not come back, because
// the runtime remembered exactly one hash and that hash had just been
// cleared. The price of one mistaken keystroke was a full re-submit: a
// goal-auditor round plus another dialog for the human.
//
// The lineage fixes that by remembering the whole chain of contents this
// approval has legitimately bound to. Two invariants keep it from becoming a
// way to acquire authority rather than to recover it:
//
//  1. It starts EMPTY at every explicit user approval, which then becomes its
//     only entry. The user's newest decision supersedes everything before it,
//     so a plan they later NARROWED can never be widened back to an earlier
//     carried version — the earlier hashes are gone the moment they sign.
//  2. It only ever grows through a carry, i.e. through `decideApprovalCarry`
//     saying the content granted nothing new. Every hash in it therefore
//     describes content that WAS authorized, not content that might be.
//
// Its trust boundary is the one `approvedPlanHash` already has, and no
// stronger: both live in the gate sidecar, which is a file no agent may edit
// (the gate refuses it and the refusal is not grantable). Shape validation on
// the way back in (lib/orchestrator-registry.ts) drops a malformed list
// WHOLE — it cannot recognize a well-formed forgery, and this module does not
// pretend otherwise.

/** How many contents one approval remembers. Bounded: the sidecar is not a log. */
export const MAX_APPROVAL_LINEAGE = 20;

const PLAN_HASH_SHAPE = /^[0-9a-f]{64}$/;

/** True when this exact content was already authorized under the live approval. */
export function lineageAuthorizes(lineage: readonly string[] | undefined, hash: string): boolean {
  if (!PLAN_HASH_SHAPE.test(hash)) return false;
  return (lineage ?? []).includes(hash);
}

/** The user just approved `hash`: their decision replaces every earlier one. */
export function beginApprovalLineage(hash: string): string[] {
  return [hash];
}

/** Record one more content the approval legitimately moved to. Never mutates. */
export function extendApprovalLineage(lineage: readonly string[] | undefined, hash: string): string[] {
  return [...(lineage ?? []).filter((entry) => entry !== hash), hash].slice(-MAX_APPROVAL_LINEAGE);
}

/** The amendment line recorded when an approval returns to content it already had. */
export function formatApprovalRestored(hash: string): string {
  return `plan 写回了此前已获授权的内容（hash ${hash.slice(0, 12)}…），批准随之平移回来 —— 撤回一次扩权不必重走批准`;
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
