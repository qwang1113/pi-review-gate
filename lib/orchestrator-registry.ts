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

import { emptyNotifyHistory, type NotifyHistory } from "./orchestrator-notify.ts";
import type { ApprovedPlanSnapshot } from "./orchestrator-plan-approval.ts";
import { isPaneId } from "./orchestrator-tmux.ts";


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
  /**
   * The sidecar variant this child was started with (`RG_STATE_VARIANT`, F4).
   *
   * Recorded rather than recomputed because it is how the orchestrator finds
   * the child's OWN gate state on disk: the file is
   * `<cwd>/.pi/review-gate-state.<variant>.json`, and guessing it from the id
   * would silently break the moment the naming changes.
   */
  stateVariant?: string;
  /**
   * The task document handed to this child at spawn (F7). Kept so a later
   * read can point a human at what the child was actually asked to do.
   */
  taskFile?: string;

  createdAt: string;
  /**
   * ISO time this child was last GIVEN something to do.
   *
   * Set at spawn and again by every `orchestrator_send` that reaches it. It
   * exists because a completion is only evidence about the work it finished:
   * `declare_done` leaves a record in the child's sidecar that nothing ever
   * clears, so a child re-tasked after finishing would be reported `done`
   * again the moment its screen settled — including when it had simply got
   * STUCK on the new work (round-1 P1). A completion older than this stamp is
   * history, not a verdict.
   */
  lastAssignedAt?: string;
  /**
   * ISO time the child reported its task finished.
   *
   * Cleared when it is assigned new work: "this session finished something
   * once" must never keep an ACTIVE child out of the exit check (round-1 P1 —
   * an orchestration could `declare_done` while a child was still working).
   */
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
  /**
   * WHAT the user approved, not just its hash (round-4 P0).
   *
   * The hash answers "is this the same plan"; it cannot answer "is this plan
   * WEAKER than the one that was approved", and that second question is the
   * one that decides whether a human has to be woken up for an edit that
   * granted nothing. lib/orchestrator-plan-approval.ts compares against this
   * snapshot; without it, every boundary refinement is indistinguishable from
   * a power grab and costs an approval dialog.
   */
  approvedPlan?: ApprovedPlanSnapshot;
  /**
   * Edits that kept the approval alive, newest last — the audit trail for
   * "why was I not asked about this?".
   *
   * Carrying an approval across an edit is a decision the gate makes on the
   * user's behalf, and a decision nobody can inspect afterwards is exactly
   * the kind of quiet authority this project refuses to build. Bounded, so a
   * long orchestration cannot grow the sidecar without limit.
   */
  approvalAmendments?: Array<{ at: string; changes: string[] }>;

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
    notify: emptyNotifyHistory(),
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

/**
 * Record that a child was GIVEN new work, which un-finishes it.
 *
 * Both halves matter and they are the same defect (round-1 P1). A completion
 * is written once — into the child's sidecar by `declare_done`, and into this
 * registry by the probe — and nothing ever invalidated either:
 *
 *  - the probe would call a re-tasked child `done` again as soon as its
 *    screen settled, which is indistinguishable from it having got STUCK on
 *    the new work: the one state that produces no alarm would swallow the one
 *    situation a supervisor must hear about;
 *  - `doneAt` filters the child out of the orchestration exit check, so the
 *    orchestration could `declare_done` while that child was still working.
 *
 * Stamping the assignment and dropping `doneAt` fixes both: from here on the
 * child counts as ACTIVE again, and only a completion NEWER than this stamp
 * is evidence about the new work.
 */
export function markChildAssigned(
  runtime: OrchestratorRuntime,
  id: string,
  at: string = new Date().toISOString(),
): OrchestratorRuntime {
  return {
    ...runtime,
    children: runtime.children.map((c) => {
      if (c.id !== id) return c;
      // `doneAt` is DELETED rather than set to undefined: the runtime is
      // compared and persisted as plain JSON, and an undefined key would
      // survive a round-trip as a key that was never there.
      const { doneAt: _finished, ...rest } = c;
      return { ...rest, lastAssignedAt: at };
    }),
  };
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

/**
 * Sanitize a runtime read back from the gate sidecar.
 *
 * The sidecar is an ordinary repo-local file, so everything in it is
 * UNTRUSTED — the same reason `lastReadyReview.treeOid` is validated before it
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
    const worktree = str(c.worktree);
    const doneAt = str(c.doneAt);
    const lastAssignedAt = str(c.lastAssignedAt);
    const closedAt = str(c.closedAt);
    // The variant only ever names a FILE inside `.pi/`, so it is sanitized on
    // the way back in exactly as `sidecarPath` sanitizes it on the way out —
    // the sidecar is untrusted input, and a `../` in here would otherwise be
    // handed to a path join.
    const stateVariant = str(c.stateVariant)?.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 64);
    const taskFile = str(c.taskFile);
    children.push({
      id, taskId, cwd, createdAt,
      paneId: c.paneId,
      ...(worktree ? { worktree } : {}),
      ...(stateVariant ? { stateVariant } : {}),
      ...(taskFile ? { taskFile } : {}),
      ...(lastAssignedAt ? { lastAssignedAt } : {}),
      ...(doneAt ? { doneAt } : {}),
      ...(closedAt ? { closedAt } : {}),
    });
  }

  const notify = obj.notify as Record<string, unknown> | undefined;
  const sentAt = Array.isArray(notify?.sentAt)
    ? notify.sentAt.filter((t): t is number => typeof t === "number" && Number.isFinite(t))
    : [];
  const lastByKey: Record<string, number> = {};
  if (notify?.lastByKey && typeof notify.lastByKey === "object" && !Array.isArray(notify.lastByKey)) {
    for (const [k, v] of Object.entries(notify.lastByKey as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) lastByKey[k] = v;
    }
  }

  const hash = str(obj.approvedPlanHash);
  const approvalIntact = !dropped && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash);

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
  const successorPane = isPaneId(rawRelay?.successorPane) ? rawRelay.successorPane : undefined;
  return {
    orchestrationId,
    children,
    notify: { sentAt, lastByKey },
    ...(ownPane ? { ownPane } : {}),
    ...(approvalIntact && hash ? { approvedPlanHash: hash } : {}),
    ...(approvedPlanAt ? { approvedPlanAt } : {}),
    ...(approvedPlan ? { approvedPlan } : {}),
    ...(approvalAmendments.length > 0 ? { approvalAmendments } : {}),

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
 * boundary the user never saw look "already approved", which is precisely the
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

  const tasks: ApprovedPlanSnapshot["tasks"] = [];
  for (const entry of obj.tasks) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const task = entry as Record<string, unknown>;
    const id = typeof task.id === "string" && task.id.length > 0 ? task.id : undefined;
    const execution = task.execution === "serial" || task.execution === "parallel"
      ? task.execution
      : undefined;
    if (!id || !execution || !Array.isArray(task.fileBoundaries)) return undefined;
    const fileBoundaries = task.fileBoundaries.filter((b): b is string => typeof b === "string" && b.length > 0);
    if (fileBoundaries.length !== task.fileBoundaries.length) return undefined;
    const dependsOn = Array.isArray(task.dependsOn)
      ? task.dependsOn.filter((d): d is string => typeof d === "string" && d.length > 0)
      : [];
    tasks.push({ id, fileBoundaries, dependsOn, execution });
  }
  return { hash: snapshotHash, at, maxParallel, tasks };
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


/** One-screen rendering for `orchestrator_attach`'s takeover report. */
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
