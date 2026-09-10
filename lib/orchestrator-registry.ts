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
import {
  MAX_APPROVAL_LINEAGE,
  type ApprovedPlanSnapshot,
} from "./orchestrator-plan-approval.ts";
import { isPlanHash } from "./orchestrator-plan.ts";
import { isDeliveryStation } from "./delivery-station.ts";
import { isPaneId } from "./orchestrator-tmux.ts";


/** One child session, as the orchestration knows it. */
export interface ChildSession {
  /** Registry handle — what every tool argument names. */
  id: string;
  /** The plan task this child was spawned for. */
  taskId: string;
  /** tmux pane it runs in (the only pane the gate may kill for it). */
  paneId: string;
  /** Working directory it was started in (the repo root, or an isolated worktree). */
  cwd: string;
  /**
   * The ISOLATED CHECKOUT this child runs in, when it got one (2026-09-10).
   *
   * Present only when another child was already working in the same repo: two
   * writers in one checkout overwrite each other, so the second one gets its
   * own `git worktree`, on its own branch, sharing the object store. `cwd`
   * above is then that worktree's path — this field is what lets the manager
   * find the branch to merge or discard when the child is done
   * (lib/orchestrator-worktree.ts owns every derivation).
   */
  worktree?: { path: string; branch: string };
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
   * Set at spawn, and again by EVERY `orchestrator_instruct` written into the
   * child's channel — no mode is exempt since 2026-09-17 (`interrupt`, the one
   * that literally means "stop and do THIS instead", used to be), and it does
   * not wait for the receipt: a message the child's gate merely queued fails
   * the receipt and is still read moments later. It exists
   * because a completion is only evidence about the work it finished:
   * `declare_done` leaves a record in the child's sidecar that nothing ever
   * clears, so a child re-tasked after finishing would be reported `done`
   * again the moment its screen settled — including when it had simply got
   * STUCK on the new work (round-1 P1). A completion older than this stamp is
   * history, not a verdict — and "older" is measured from when the child
   * ENTERED that `done` run, because its heartbeat re-reports the same state
   * with a fresh timestamp every minute (lib/orchestrator-child-state.ts).
   */
  lastAssignedAt?: string;
  /*
   * THERE IS DELIBERATELY NO `doneAt` HERE ANY MORE (B4, 2026-09-17).
   *
   * There was one, and it was a CACHE of a fact that lives in the child's
   * channel ("I finished"). Its writer was the old screen-scraping probe;
   * when the probe was deleted (b6492c5) the writer went with it and the
   * field plus its five readers stayed. From then on it was permanently
   * undefined, and the receipt said two different things about the same
   * child in the same breath: block 1 read the channel and printed
   * "已完成", block 5 read this field and printed "还有 1 个子会话活着".
   *
   * Re-adding the writer would re-bury the same mine: a cache of a
   * completion has to be invalidated on EVERY path that gives the child new
   * work — including an `interrupt` carrying text, which only started
   * stamping `lastAssignedAt` on 2026-09-17. Completion is read from the
   * channel,
   * once, by lib/orchestrator-supervisor.ts — and everything that needs it
   * takes it from that ONE snapshot.
   */
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
   * snapshot; without it, every harmless edit is indistinguishable from
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
  /**
   * Every plan content THIS approval has legitimately bound to, oldest first
   * (lib/orchestrator-plan-approval.ts owns the rule).
   *
   * It is what lets an orchestrator UNDO a widening: writing the plan back to
   * a content the user already signed restores the approval instead of
   * costing a whole re-submit. It carries the same authority as
   * `approvedPlanHash` and is therefore validated as hard — and it survives a
   * REVOCATION on purpose, because the revoked state is exactly when it has
   * work to do.
   */
  approvedPlanHistory?: string[];



  /**
   * User-granted proxy authorities (2026-09-16, user decision).
   *
   * The project manager may NOT answer a child's sensitive-edit consent
   * request unless the USER explicitly granted that scope — "I give you
   * full power" is a chat message, not an authorization. Each grant is
   * minted by the gate itself (never by the PM writing a file) through one
   * of three doors: an `ask_user` answer with a grant scope, the
   * `/gate-grant` command, or the PM's first proxy answer when the user
   * picks "allow and remember". Persisted with the runtime, so a relay
   * successor inherits them.
   */
  grants?: OrchestrationGrant[];

  /** A relay in progress — see lib/orchestrator-relay.ts. */
  relay?: {
    handoffPath: string;
    successorPane?: string;
    at: string;
  };
}
/** One proxy authority the user granted the project manager. */
export interface OrchestrationGrant {
  /** What the PM may do on the user's behalf: `sensitive-edit` today. */
  scope: string;
  /** ISO time the user granted it. */
  grantedAt: string;
  /** Which door minted it: ask_user / gate-grant / first-answer. */
  via: "ask-user" | "gate-grant" | "first-answer";
}

/** True when the runtime carries a grant for `scope`. */
export function hasGrant(runtime: OrchestratorRuntime, scope: string): boolean {
  return (runtime.grants ?? []).some((g) => g.scope === scope);
}

/** Add a grant. Never mutates its input; keeps the list bounded. */
export function addGrant(
  runtime: OrchestratorRuntime,
  grant: OrchestrationGrant,
): OrchestratorRuntime {
  const grants = (runtime.grants ?? []).filter((g) => g.scope !== grant.scope);
  return { ...runtime, grants: [...grants, grant] };
}

/**
 * The runtime a DIFFERENT session may inherit: the facts about the world,
 * with every trace of the user's permission removed.
 *
 * A new session (a relay successor, or a takeover through
 * `orchestrator_attach`) keeps the child REGISTRY — those panes are alive
 * whatever any process believes — but never the approval: that was permission
 * the user gave to a session that is gone, and re-obtaining it costs one
 * dialog. The extension used to spell the stripping out inline, which is
 * exactly the shape that goes stale: `approvedPlanHistory` would have ridden
 * into the new session untouched and let it write the plan back to a content
 * the PREVIOUS session was authorized for. One function, one place to add the
 * next authorizing field, and a test that can drive it directly.
 */
export function withoutPlanApproval(runtime: OrchestratorRuntime): OrchestratorRuntime {
  const {
    approvedPlanHash: _hash,
    approvedPlanAt: _at,
    approvedPlan: _snapshot,
    approvalAmendments: _amendments,
    approvedPlanHistory: _lineage,
    ...carried
  } = runtime;
  return carried;
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

/**
 * Plan task ids with a live child — the input to scheduling.
 *
 * A PANE IS THE UNIT OF OCCUPANCY, not a completion report (B4). Same-repo
 * tasks are serialized because they share ONE worktree, and a child whose
 * pane is still open can still be given new work in it — so "it said it
 * finished" is not a reason to hand its repo to somebody else. The task's
 * slot frees when its pane is closed, which is a thing the orchestrator does
 * deliberately.
 */
export function runningTaskIds(
  runtime: OrchestratorRuntime,
  alivePaneIds: readonly string[],
): string[] {
  return [...new Set(liveChildren(runtime, alivePaneIds).map((c) => c.taskId))];
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

/**
 * Record that a child was GIVEN new work.
 *
 * WHAT THE STAMP IS FOR (round-1 P1). A completion is written once — into the
 * child's sidecar by `declare_done` — and nothing ever clears it, so a child
 * re-tasked after finishing would report `done` again the moment it settled,
 * INCLUDING when it had simply got stuck on the new work: the one state that
 * produces no alarm would swallow the one situation a supervisor must hear
 * about. `classifyChildState` therefore only believes a completion NEWER than
 * this stamp.
 *
 * It no longer clears a `doneAt` field, because there is none (B4): the
 * completion is not cached in this registry at all, so there is nothing here
 * that could go stale behind an assignment.
 */
export function markChildAssigned(
  runtime: OrchestratorRuntime,
  id: string,
  at: string = new Date().toISOString(),
): OrchestratorRuntime {
  return patchChild(runtime, id, { lastAssignedAt: at });
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
    const lastAssignedAt = str(c.lastAssignedAt);
    const closedAt = str(c.closedAt);
    // The variant only ever names a FILE inside `.pi/`, so it is sanitized on
    // the way back in exactly as `sidecarPath` sanitizes it on the way out —
    // the sidecar is untrusted input, and a `../` in here would otherwise be
    // handed to a path join.
    const stateVariant = str(c.stateVariant)?.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 64);
    const taskFile = str(c.taskFile);
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
  return {
    orchestrationId,
    children,
    notify: { sentAt, lastByKey },
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
  return { hash: snapshotHash, at, maxParallel, tasks, ...(deliveryStation ? { deliveryStation } : {}) };
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
          // Registered + pane present = alive. Whether it has FINISHED is a
          // channel fact, not a registry one (B4), and this rendering is
          // about the registry.
          ? "alive"
          : "pane 已消失（异常退出或被用户关掉）";
      return `- ${c.id} [${state}] task=${c.taskId} pane=${c.paneId}` +
        ` 开始于 ${c.createdAt}`;
    })
    .join("\n");
}
