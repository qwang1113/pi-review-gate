/**
 * DOES THIS PLAN EDIT STILL NEED THE USER? — the narrow interface that stops
 * "one task dispatched, one human woken up".
 *
 * ── THE MEASURED FAILURE (round-4 P0) ──
 *
 * A plan approval binds to CONTENT, and that is right: without it an
 * orchestrator could hand a task a different repo after the fact and spawn a
 * child with powers nobody granted. But the ONLY way to change the plan was to
 * rewrite the whole plan, and rewriting the plan dropped the approval — so the
 * fourth end-to-end run popped the approval dialog THREE times in one
 * orchestration, the second one to an empty chair for 425 seconds.
 *
 * The edits that caused it were not power grabs. Both were the same honest
 * discovery: the work had to land in a file the plan had not named. An
 * orchestrator CANNOT know that at planning time. So "editing the plan" was
 * being treated as one thing when it is really two, and only one of them
 * concerns the user.
 *
 * ── WHAT THIS MODULE DECIDES ──
 *
 * Given the snapshot of what the user APPROVED and the plan being written now,
 * does the new plan grant anything the old one did not? Every difference is
 * classified into exactly one of:
 *
 *   - a WIDENING — a new task, a task's `repo` changed, a dependency removed,
 *     serial→parallel, a higher `maxParallel`, a raised `deliveryStation`, a
 *     repo ADDED to `allowMultiplePrs`, or a task whose own STATION got wider
 *     (2026-09-18: the plan's last task is exempt from the same-repo
 *     narrowing, so the order carries authority too). Any single one of these
 *     revokes the approval, and the user is asked again.
 *   - an AMENDMENT — a task dropped, a dependency ADDED (more serial, never
 *     less), parallel→serial, a lower `maxParallel`, a lowered station, a
 *     repo REMOVED from `allowMultiplePrs`, a task whose station tightened.
 *     The approval carries over, and the amendment is recorded so the change
 *     is never silent.
 *
 * WHAT IS NO LONGER HERE (2026-09-17, user decision). The FILE-BOUNDARY
 * algebra used to be the bulk of this comparison: a new path inside an
 * approved directory was an amendment, anything else a widening. The
 * boundaries are gone — same-repo tasks are serialized, so a boundary
 * prevented no collision, and its only remaining effect was exactly the
 * dialog storm above. A child may now write anywhere inside its own repo
 * without the plan changing at all; what still needs the user is a change of
 * REPO, which is a genuinely new write surface.
 *
 * Pure module: two plans in, a verdict and human-readable reasons out. It
 * reads nothing, writes nothing, and never decides on its own whether to show
 * a dialog — lib/orchestrator-plan-action.ts does that with this verdict in hand.
 */

import { isPlanHash, type OrchestratorPlan, type TaskExecution } from "./orchestrator-plan.ts";
import {
  DEFAULT_DELIVERY_STATION,
  deliveryStationRank,
  isStationWidening,
  type DeliveryStation,
} from "./delivery-station.ts";
import { allowsMultiplePrs, effectiveTaskStation, taskRepoOf, type RepoPrPlanInput } from "./repo-pr-policy.ts";

/** The authorization-relevant shape of one task, as the user approved it. */
export interface ApprovedTaskSnapshot {
  id: string;
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
  /**
   * The repos the user allowed to open more than one PR (2026-09-15).
   *
   * Optional for the same reason `deliveryStation` is: a runtime written
   * before the field existed has none, and a MISSING list is read as EMPTY —
   * the strictest reading — so an old approval can only make the next edit
   * look like a widening (a repo "newly" allowed to split), never like less
   * of one. That direction is the whole point: allowing a split is authority
   * the user grants, never something an orchestrator discovers.
   */
  allowMultiplePrs?: string[];
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
    allowMultiplePrs: [...plan.allowMultiplePrs],
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      dependsOn: [...task.dependsOn],
      execution: task.execution,
      ...(task.repo ? { repo: task.repo } : {}),
    })),
  };
}

/** The approval snapshot in the shape the station rule reads. */
function snapshotAsPlan(approved: ApprovedPlanSnapshot): RepoPrPlanInput {
  return {
    deliveryStation: approved.deliveryStation ?? DEFAULT_DELIVERY_STATION,
    ...(approved.allowMultiplePrs === undefined ? {} : { allowMultiplePrs: approved.allowMultiplePrs }),
    tasks: approved.tasks,
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
 * Compare what was approved with what is being written.
 *
 * Fail-closed by construction: every difference must be recognized as an
 * amendment to survive, and anything this function does not understand falls
 * through to a widening — the direction that asks the user.
 */
export function decideApprovalCarry(
  approved: ApprovedPlanSnapshot,
  next: OrchestratorPlan,
  /** The orchestration's own repo — where a task without `repo` lands. */
  defaultRepo: string,
): ApprovalCarryDecision {
  const widenings: string[] = [];
  const amendments: string[] = [];

  const approvedById = new Map(approved.tasks.map((task) => [task.id, task]));
  const nextTaskIds = new Set(next.tasks.map((task) => task.id));
  // The approved side of every per-task comparison, in the shape the station
  // rule reads: a snapshot from before `deliveryStation` / `allowMultiplePrs`
  // existed reads as the STRICTEST values, so it can only ever ask the user.
  const approvedAsPlan = snapshotAsPlan(approved);




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

  // ALLOWING A REPO TO SPLIT INTO SEVERAL PRs IS AUTHORITY TOO (2026-09-15,
  // user decision). The field looks like bookkeeping and is not: it decides
  // whether a repo's children may push and open PRs of their own or stop at
  // `commit` for a local merge (lib/repo-pr-policy.ts). So the same asymmetry
  // as the station applies — ADDING a repo hands out publish authority and
  // revokes the approval, REMOVING one takes that authority back and carries.
  // A snapshot with no list at all reads as empty, so an approval predating
  // the field can only ever be asked about again.
  const approvedAllow = new Set(approved.allowMultiplePrs ?? []);
  const nextAllow = new Set(next.allowMultiplePrs);
  const newlyAllowed = [...nextAllow].filter((repo) => !approvedAllow.has(repo));
  if (newlyAllowed.length > 0) {
    widenings.push(
      `allowMultiplePrs 新增了 ${newlyAllowed.join("、")} —— 该 repo 的任务从此可以各自开 PR（放开了发布面）`,
    );
  }
  for (const repo of [...approvedAllow].filter((entry) => !nextAllow.has(entry))) {
    amendments.push(`allowMultiplePrs 移除了 ${repo}（该 repo 回到「一个需求只出一个 PR」）`);
  }


  for (const gone of approved.tasks) {
    if (!nextTaskIds.has(gone.id)) amendments.push(`任务 "${gone.id}" 已从 plan 中删除`);
  }

  for (const task of next.tasks) {
    const before = approvedById.get(task.id);
    if (!before) {
      // A task the user never saw: adding it is a widening in its own right.
      widenings.push(`新增任务 "${task.id}"（用户从未批准过它）`);
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

    // HOW FAR A TASK MAY SHIP IS AUTHORITY TOO, AND THE PLAN'S LAST TASK HAS
    // THE PLAN'S OWN STATION (2026-09-18). The same-repo narrowing exempts the
    // LAST task, so an edit that only REORDERS the list can hand a task the
    // user approved at `commit` the right to push and open the PR — and a
    // dropped sibling can do the same thing without touching the order at all
    // (its repo falls back under the two-task threshold). Comparing each
    // task's STATION instead of the order is what the user actually signed: a
    // reorder that moves no authority is not news, and a change that is real
    // shows up here whatever edit produced it.
    //
    // …AND ONLY WHAT THIS TASK'S OWN CONTEXT DID (round-2 P2). When the plan's
    // own station moved, or this task's repo gained or lost a split
    // permission, every task's station moves WITH it: that change is already
    // stated once, at the plan level above, and repeating it per task would
    // drown the one real reason in N restatements — each of them naming a
    // cause (the last-task exemption) that had nothing to do with it. What is
    // left to report here is exactly the news that is THIS task's: the count
    // and the order.
    const taskRepo = taskRepoOf(task, defaultRepo);
    if (approvedStation === next.deliveryStation &&
        allowsMultiplePrs(approvedAsPlan, taskRepo) === allowsMultiplePrs(next, taskRepo)) {
      const beforeStation = effectiveTaskStation(approvedAsPlan, before, defaultRepo);
      const nextStation = effectiveTaskStation(next, task, defaultRepo);
      if (deliveryStationRank(nextStation) > deliveryStationRank(beforeStation)) {
        widenings.push(
          `任务 "${task.id}" 的交付站点从 ${beforeStation} 提到 ${nextStation}` +
          "（plan 的最后一环不受同一 repo 多任务的收窄：改任务顺序、或删掉一个兄弟任务都可能把它提上去）",
        );
      } else if (deliveryStationRank(nextStation) < deliveryStationRank(beforeStation)) {
        amendments.push(`任务 "${task.id}" 的交付站点从 ${beforeStation} 收紧到 ${nextStation}`);
      }
    }
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
// A consequence worth stating, because it looks like a widening and is not:
// after the approval NARROWS through a carry, writing the user's own signed
// content back restores it — the narrowing was the orchestrator's decision,
// not theirs, and only THEIR decision resets the lineage.
//
// Its trust boundary is the one `approvedPlanHash` already has, and no
// stronger: both live in the gate sidecar, which is a file no agent may edit
// (the gate refuses it and the refusal is not grantable). Shape validation on
// the way back in (lib/orchestrator-registry.ts) drops a malformed list
// WHOLE — it cannot recognize a well-formed forgery, and this module does not
// pretend otherwise.

/** How many contents one approval remembers. Bounded: the sidecar is not a log. */
export const MAX_APPROVAL_LINEAGE = 20;

/** True when this exact content was already authorized under the live approval. */
export function lineageAuthorizes(lineage: readonly string[] | undefined, hash: string): boolean {
  if (!isPlanHash(hash)) return false;
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
