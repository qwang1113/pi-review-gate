/**
 * SIDECAR SANITIZATION for the orchestrator runtime — the one place where the
 * runtime read back from the gate sidecar is validated before anything trusts
 * it (split out of lib/orchestrator-registry.ts, which owns the types and the
 * registry operations).
 *
 * Pure module: it holds no state and performs no IO.
 */

import {
  MAX_APPROVAL_LINEAGE,
  type ApprovedPlanSnapshot,
} from "./orchestrator-plan-approval.ts";
import { isPlanHash } from "./orchestrator-plan.ts";
import { isDeliveryStation } from "./delivery-station.ts";
import { isPaneId, parseWindowCoords } from "./orchestrator-tmux.ts";
import type { ChildSession, OrchestratorRuntime } from "./orchestrator-registry.ts";

/**
 * Sanitize a runtime read back from the gate sidecar.
 *
 * The sidecar is an ordinary repo-local file, so everything in it is
 * UNTRUSTED — the same reason `lastReviewedTree.treeOid` is validated before it
 * reaches `git diff`. Two things in here have authority and are therefore
 * checked hardest:
 *
 *  - `approvedPlanHash` IS the user's approval (constraint 1). A forged one
 *    would let a session spawn children against a plan nobody agreed to, so
 *    ANY doubt about the blob drops it: the orchestrator simply has to ask
 *    the user again, which is the fail-closed direction.
 *  - `paneId` becomes a tmux target. A malformed child is dropped rather than
 *    kept, because an unaddressable pane cannot be closed or waited on
 *    anyway — and the builders would refuse it downstream regardless.
 *
 * Well-formed children SURVIVE even when the approval is dropped: they are
 * what `declare_done` counts (constraint 4), and forgetting them would be the
 * fail-OPEN direction — an orchestration exiting with live work behind it.
 */
export function normalizeRuntime(raw: unknown, orchestrationId: string): OrchestratorRuntime | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

  // `dropped` is the doubt flag: anything we could not read means the blob is
  // not the one the gate wrote, so the APPROVAL in it is not trusted either.
  let dropped = obj.children !== undefined && !Array.isArray(obj.children);
  const rawChildren = Array.isArray(obj.children) ? obj.children : [];
  const children: ChildSession[] = [];
  for (const entry of rawChildren) {
    if (typeof entry !== "object" || entry === null) { dropped = true; continue; }
    const c = entry as Record<string, unknown>;
    const id = str(c.id);
    const taskId = str(c.taskId);
    const cwd = str(c.cwd);
    const createdAt = str(c.createdAt);
    if (!id || !taskId || !cwd || !createdAt || !isPaneId(c.paneId)) { dropped = true; continue; }
    // Conditional spreads, not `field: str(...)`: writing an explicit
    // `undefined` would add a KEY that the original object never had, so a
    // sanitized runtime would no longer deep-equal the one the gate wrote.
    const lastAssignedAt = str(c.lastAssignedAt);
    const closedAt = str(c.closedAt);
    // The variant only ever names a FILE inside `.pi/`, so it is sanitized on
    // the way back in exactly as `sidecarPath` sanitizes it on the way out —
    // the sidecar is untrusted input, and a `../` in here would otherwise be
    // handed to a path join.
    const stateVariant = str(c.stateVariant)?.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 64);
    const taskFile = str(c.taskFile);
    // The window/session coordinates are sanitized by SHAPE through the shared
    // parser, not merely by "is a string": they become a tmux target, and the
    // sidecar is untrusted input. Either half being wrong drops BOTH — the entry
    // then reads as "predates the window topology", which is the fail-closed
    // direction (it simply cannot be closed by id).
    const coords = parseWindowCoords({ windowId: c.windowId, tmuxSession: c.tmuxSession });
    // The isolated checkout, sanitized like everything else that becomes a
    // PATH: the sidecar is untrusted input, and this one is handed to git.
    // Both halves must be present — a path without its branch cannot be
    // settled, and a branch without its path cannot be removed.
    const worktreePath = str((c.worktree as Record<string, unknown> | undefined)?.path);
    const worktreeBranch = str((c.worktree as Record<string, unknown> | undefined)?.branch);
    const worktree = worktreePath && worktreeBranch ? { path: worktreePath, branch: worktreeBranch } : undefined;
    children.push({
      id, taskId, cwd, createdAt,
      paneId: c.paneId,
      ...(coords === undefined ? {} : coords),
      ...(stateVariant ? { stateVariant } : {}),
      ...(taskFile ? { taskFile } : {}),
      ...(worktree ? { worktree } : {}),
      ...(lastAssignedAt ? { lastAssignedAt } : {}),
      // A `doneAt` in an OLD sidecar is dropped here rather than carried: the
      // field is gone (B4), and re-admitting it would put a value nothing
      // writes and nothing reads back into the runtime.
      ...(closedAt ? { closedAt } : {}),
    });
  }

  const hash = str(obj.approvedPlanHash);
  const approvalIntact = !dropped && isPlanHash(hash);

  const rawRelay = obj.relay as Record<string, unknown> | undefined;
  const relayHandoff = rawRelay ? str(rawRelay.handoffPath) : undefined;
  const relayAt = rawRelay ? str(rawRelay.at) : undefined;

  const ownPane = isPaneId(obj.ownPane) ? obj.ownPane : undefined;
  const approvedPlanAt = approvalIntact ? str(obj.approvedPlanAt) : undefined;
  // The SNAPSHOT carries the same authority as the hash — it is what decides
  // whether a later edit needs a new dialog — so it is validated as hard and
  // dropped on the same doubt. A snapshot whose hash does not match the
  // recorded approval is not this approval's snapshot and is discarded: the
  // fail-closed direction simply costs one dialog.
  const approvedPlan = approvalIntact ? normalizeApprovedPlan(obj.approvedPlan, hash) : undefined;
  const approvalAmendments = normalizeAmendments(obj.approvalAmendments);
  // THE LINEAGE IS NOT GATED ON `approvalIntact`, and that is deliberate: its
  // whole job is to restore an approval that was REVOKED, so requiring a live
  // `approvedPlanHash` beside it would delete it exactly when it is needed.
  // The `dropped` doubt still kills it — a blob we could not fully read is
  // not the one the gate wrote, so nothing authorizing in it is trusted.
  const approvedPlanHistory = dropped ? [] : normalizeApprovalLineage(obj.approvedPlanHistory);

  const successorPane = isPaneId(rawRelay?.successorPane) ? rawRelay.successorPane : undefined;
  // The owner is an identity, not a path: non-empty and nothing else. It is
  // never inferred, and never defaulted to anything.
  const ownerSessionId = str(obj.ownerSessionId);
  return {
    orchestrationId,
    children,
    ...(ownerSessionId ? { ownerSessionId } : {}),
    ...(ownPane ? { ownPane } : {}),
    ...(approvalIntact && hash ? { approvedPlanHash: hash } : {}),
    ...(approvedPlanAt ? { approvedPlanAt } : {}),
    ...(approvedPlan ? { approvedPlan } : {}),
    ...(approvalAmendments.length > 0 ? { approvalAmendments } : {}),
    ...(approvedPlanHistory.length > 0 ? { approvedPlanHistory } : {}),


    ...(relayHandoff && relayAt
      ? {
          relay: {
            handoffPath: relayHandoff,
            at: relayAt,
            ...(successorPane ? { successorPane } : {}),
          },
        }
      : {}),
  };
}

/**
 * Validate the approved-plan snapshot read back from the sidecar.
 *
 * It is untrusted input with real authority: a forged snapshot could make a
 * task repo the user never saw look "already approved", which is precisely the
 * power grab the approval exists to prevent. So every field is checked, the
 * whole thing is dropped on any doubt, and it must belong to the SAME
 * approval as the hash beside it — otherwise it is a leftover from an older
 * plan and comparing against it would authorize the wrong content.
 *
 * Dropping it is safe by construction: without a snapshot, `write` cannot
 * prove an edit is a narrowing, so the approval is revoked and the user is
 * asked. One extra dialog is the correct price for an unreadable record.
 */
function normalizeApprovedPlan(raw: unknown, hash: string | undefined): ApprovedPlanSnapshot | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const snapshotHash = typeof obj.hash === "string" ? obj.hash : undefined;
  if (!snapshotHash || !hash || snapshotHash !== hash) return undefined;
  const at = typeof obj.at === "string" && obj.at.length > 0 ? obj.at : undefined;
  const maxParallel = typeof obj.maxParallel === "number" && Number.isFinite(obj.maxParallel)
    ? Math.floor(obj.maxParallel)
    : undefined;
  if (!at || maxParallel === undefined || !Array.isArray(obj.tasks)) return undefined;

  // The approved DELIVERY STATION (2026-09-06). Authorizing, like `repo` on a
  // task: it decides which ship commands the orchestration may reach, so it
  // has to survive the round trip or `decideApprovalCarry` would read a plan
  // approved at `pr` as one approved at the default and misjudge a later
  // change. Unreadable ⇒ left undefined, which the carry check reads as the
  // STRICTEST station — the fail-closed direction (it can only cost a dialog).
  const deliveryStation = isDeliveryStation(obj.deliveryStation) ? obj.deliveryStation : undefined;

  // The repos allowed to split into several PRs (2026-09-15). Same argument as
  // the station one line up: the permission decides whether a repo's children
  // may push and open PRs of their own or stop at `commit` for a local merge
  // (lib/repo-pr-policy.ts), so a round trip that dropped it would make the
  // user's own exemption vanish and every child stop short. A runtime written
  // before the field existed simply has none, and an EMPTY list is the strict
  // reading the carry check wants — the same fail-closed direction.
  const allowMultiplePrs = Array.isArray(obj.allowMultiplePrs)
    ? obj.allowMultiplePrs.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : undefined;

  const tasks: ApprovedPlanSnapshot["tasks"] = [];
  for (const entry of obj.tasks) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const task = entry as Record<string, unknown>;
    const id = typeof task.id === "string" && task.id.length > 0 ? task.id : undefined;
    const execution = task.execution === "serial" || task.execution === "parallel"
      ? task.execution
      : undefined;
    if (!id || !execution) return undefined;
    const dependsOn = Array.isArray(task.dependsOn)
      ? task.dependsOn.filter((d): d is string => typeof d === "string" && d.length > 0)
      : [];
    // The declared repo is authorizing: it decides WHICH checkout a task's
    // child writes in. Written by snapshotApprovedPlan, so read it back with
    // the same shape — a snapshot that dropped it would read a task approved
    // with a repo as one approved without, and the carryover check would
    // misjudge a later repo change as a widening (fail-closed, but wrong).
    const repo = typeof task.repo === "string" && task.repo.length > 0 ? task.repo : undefined;
    tasks.push({ id, dependsOn, execution, ...(repo ? { repo } : {}) });
  }
  return {
    hash: snapshotHash,
    at,
    maxParallel,
    tasks,
    ...(deliveryStation ? { deliveryStation } : {}),
    ...(allowMultiplePrs !== undefined && allowMultiplePrs.length > 0 ? { allowMultiplePrs } : {}),
  };
}

/** How many amendment entries are kept — enough to explain, bounded on purpose. */
const MAX_APPROVAL_AMENDMENTS = 20;

/** Validate the amendment trail. Purely informational, so a bad entry is skipped. */
function normalizeAmendments(raw: unknown): Array<{ at: string; changes: string[] }> {
  if (!Array.isArray(raw)) return [];
  const entries: Array<{ at: string; changes: string[] }> = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const at = typeof entry.at === "string" && entry.at.length > 0 ? entry.at : undefined;
    const changes = Array.isArray(entry.changes)
      ? entry.changes.filter((c): c is string => typeof c === "string" && c.length > 0)
      : [];
    if (!at || changes.length === 0) continue;
    entries.push({ at, changes });
  }
  return entries.slice(-MAX_APPROVAL_AMENDMENTS);
}

/**
 * Validate the approval lineage read back from the sidecar.
 *
 * Authorizing input, so it is read the way the hash beside it is: ANY entry
 * that is not a plan hash means this list is not the one the gate wrote, and
 * the WHOLE list goes — a half-trusted permission record is worse than none.
 * Losing it only ever costs a re-submit, which is the direction that asks the
 * user. What this cannot do is recognize a well-formed forgery; the defence
 * against that is the same one `approvedPlanHash` relies on — the sidecar is
 * a file the gate refuses to let an agent edit, and that refusal is not
 * grantable.
 */
function normalizeApprovalLineage(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [];
  for (const entry of raw) {
    if (!isPlanHash(entry)) return [];
  }
  return (raw as string[]).slice(-MAX_APPROVAL_LINEAGE);
}
