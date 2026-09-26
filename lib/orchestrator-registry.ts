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
 * the returned runtime into the gate sidecar; reading it back is
 * lib/orchestrator-registry-normalize.ts (`normalizeRuntime`).
 */

import type { ApprovedPlanSnapshot } from "./orchestrator-plan-approval.ts";


/** One child session, as the orchestration knows it. */
export interface ChildSession {
  /** Registry handle — what every tool argument names. */
  id: string;
  /** The plan task this child was spawned for. */
  taskId: string;
  /** tmux pane it runs in (what liveness is read from, never what is killed). */
  paneId: string;
  /**
   * The WINDOW the child runs in, and the session that owns it (2026-09-25).
   *
   * A child is a window of the MANAGER's own tmux session
   * (lib/session-tmux-scope.ts), so closing it is `kill-window -t
   * <tmuxSession>:<windowId>` — and the session half is what keeps a stale
   * window id from reaching a window the user owns. Both are optional in the
   * type because a sidecar written by an older build has neither; an entry
   * without them is never closed by a guess.
   */
  windowId?: string;
  tmuxSession?: string;
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
  /**
   * WHICH SESSION holds this orchestration (2026-09-17).
   *
   * It exists so "may I resume MY orchestration after a reload" can be
   * answered by a fact that cannot be re-stamped — see
   * `startupOrchestrationId` in lib/orchestration-id.ts. The sidecar's own
   * `sessionId` LOOKS like that fact and is not: `successorRuntime` keeps a
   * foreign runtime when a NEW session takes over the file (the 2026-09-06 B1
   * rule, so a takeover has something to take over), and the very next persist
   * writes that runtime under the new session's id. Answering the question with
   * `state.sessionId` therefore told a fresh session, one reload later, that a
   * previous session's children were its own — a takeover with no
   * `orchestrator_attach` and no dialog.
   *
   * Written only by a session that LEGITIMATELY holds the address: the one that
   * minted it, the one it was inherited by, and the one that adopted it through
   * `orchestrator_attach`. Absent (an older sidecar) ⇒ nobody may resume it
   * implicitly, and the takeover path asks.
   */
  ownerSessionId?: string;
  /** The orchestrator's OWN pane: the left column, and its blast-radius limit. */
  ownPane?: string;
  children: ChildSession[];
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

  /** A handover in progress — see lib/session-inheritance.ts. */
  relay?: {
    handoffPath: string;
    successorPane?: string;
    at: string;
  };
}
/** One proxy authority the user granted the project manager. */
export interface OrchestrationGrant {
  /** What the PM may do on the user's behalf: `sensitive-edit` or `tmux-access`. */
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
 * Take a grant back — the user changed their mind (user decision, 2026-09-19).
 *
 * WHY THIS EXISTS AT ALL. The grants were add-only, which was true enough
 * while the only way to authorize was to pick a row in a dialog the user could
 * not re-open. `← 返回上一题` ends that: an authorization question can be
 * answered again, and an approval that outlived the answer that minted it
 * would be authority the user believes they took back. Returns the SAME
 * runtime when the scope was not granted, so a caller can persist blindly.
 */
export function removeGrant(runtime: OrchestratorRuntime, scope: string): OrchestratorRuntime {
  const grants = runtime.grants ?? [];
  const kept = grants.filter((g) => g.scope !== scope);
  return kept.length === grants.length ? runtime : { ...runtime, grants: kept };
}

/**
 * The runtime a DIFFERENT session inherits: the facts about the world, and —
 * only for a genuine handoff successor — the user's approval with them.
 *
 * The child REGISTRY always carries: those panes are alive whatever any
 * process believes, and a relay that dropped them would leave its successor
 * supervising nothing. The APPROVAL is the field with two sources of truth:
 *
 *  - `fromHandoff: false` — an ordinary new session, or a takeover through
 *    `orchestrator_attach`. The approval was permission the user gave to a
 *    session that is gone, and re-obtaining it costs one dialog; inheriting it
 *    silently would let a session nobody approved spawn children. (The user's
 *    own standing decision, 2026-09-06.)
 *  - `fromHandoff: true` — the successor the predecessor's own
 *    `session_handoff` opened, in this same worktree, to finish the work the
 *    user already authorized. Here re-obtaining it is NOT one dialog: it is
 *    the restatement dialog, the plan re-audit and the plan approval dialog,
 *    for a requirement not one word of which changed (measured: this is what
 *    a project-manager handover actually cost the user). The 2026-09-06
 *    decision is narrowed to the sessions it was about, not overturned —
 *    WHICH sessions those are is `lib/session-inheritance.ts`'s one answer
 *    (`isHandoffSuccessorOf`), never this module's guess.
 *
 * Carrying the approval is not a relaxation: every consumer compares the
 * RECORD against the CONTENT it names (`approvedPlanHash` against the
 * canonical plan, the lineage against the plan's history), so an edit to the
 * plan invalidates an inherited approval exactly as fast as a fresh one.
 *
 * The stripping used to be spelled out inline at the call site, which is
 * exactly the shape that goes stale: `approvedPlanHistory` would have ridden
 * into a new session untouched and let it write the plan back to a content
 * the PREVIOUS session was authorized for. One function, one place to add the
 * next authorizing field, and a test that can drive it directly.
 */
export function successorRuntime(
  runtime: OrchestratorRuntime,
  fromHandoff: boolean,
): OrchestratorRuntime {
  if (fromHandoff) return { ...runtime };
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
  };
}

const CHILD_ID_SAFE = /[^A-Za-z0-9._-]/g;

/** A readable, unique handle: `<taskId>-<base36 time>`. */
export function newChildId(taskId: string, now: number = Date.now()): string {
  const safe = taskId.replace(CHILD_ID_SAFE, "-").slice(0, 32);
  return `${safe}-${Math.floor(now).toString(36)}`;
}

/**
 * The task a child handle was minted for — the inverse of {@link newChildId}.
 *
 * A child session that has no registry of its own still knows its handle:
 * `RG_STATE_VARIANT` IS the child id (lib/orchestrator-dispatch.ts), and that
 * is how it names itself on the border of every pane it opens, as the `@<owner>`
 * half. The grammar is owned here rather than re-derived at the call site, so
 * the two halves cannot drift.
 */
export function taskIdFromChildId(childId: string): string {
  const raw = String(childId ?? "").trim();
  const cut = raw.lastIndexOf("-");
  return cut > 0 ? raw.slice(0, cut) : raw;
}

/** Add a child. Never mutates its input. */
export function registerChild(
  runtime: OrchestratorRuntime,
  child: ChildSession,
): OrchestratorRuntime {
  return { ...runtime, children: [...runtime.children, child] };
}

/**
 * Point children at the panes their `session_handoff` successors run in
 * (lib/orchestrator-supervisor.ts `relayedPane` decides which). Never mutates
 * its input; returns the SAME object when nothing moved, so a caller can skip
 * the write.
 */
export function repointChildPanes(
  runtime: OrchestratorRuntime,
  moves: ReadonlyArray<{ childId: string; paneId: string }>,
): OrchestratorRuntime {
  if (moves.length === 0) return runtime;
  const to = new Map(moves.map((m) => [m.childId, m.paneId]));
  return {
    ...runtime,
    children: runtime.children.map((c) => (to.has(c.id) ? { ...c, paneId: to.get(c.id)! } : c)),
  };
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
 * REMEMBER THE BRANCH A CHECKOUT TURNED OUT TO BE ON (reviewer P2, 2026-09-18).
 *
 * `registerChild` records the branch the GATE created; a child whose station
 * reaches `pr` is asked to rename it before it pushes (lib/orchestrator-
 * delivery.ts `buildBranchLine`). That rename is invisible from here — but a
 * SETTLEMENT sees it, because it reads the checkout, and this is where the
 * reading is kept: merging reclaims the DIRECTORY (2026-09-15, user decision),
 * so the `discard` the merge receipt asks for next has nothing left to read a
 * branch from. Without this the later call deletes the DERIVED name, a renamed
 * child no longer has it, `looksLikeAlreadyGone` reads that failure as "already
 * reclaimed", and the receipt reports the branch as gone while it is still
 * right there.
 *
 * A no-op when nothing changed or the child is unknown: this records a
 * reading, it never invents a record.
 */
export function noteWorktreeBranch(
  runtime: OrchestratorRuntime,
  id: string,
  branch: string,
): OrchestratorRuntime {
  const child = findChild(runtime, id);
  if (!child?.worktree || child.worktree.branch === branch) return runtime;
  return patchChild(runtime, id, { worktree: { ...child.worktree, branch } });
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
