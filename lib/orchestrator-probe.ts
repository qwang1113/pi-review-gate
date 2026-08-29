/**
 * THE PROBE — the gate's own answer to "somebody has to keep looking at those
 * panes".
 *
 * WHAT IT REPLACES. Through the whole second orchestration run a human ran
 * this loop by hand: `tmux capture-pane` every N seconds on both children,
 * decide from the rendered text whether each was working, waiting or stuck,
 * and press Escape when the orchestrator itself had gone silent. The
 * verification calls that a DOWNGRADE, not a capability (R-17) — the contract
 * says the project manager never touches tmux — and names it the single
 * blocker for unattended runs.
 *
 * THE ONE IDEA. An orchestrator can only react to EVENTS, and three of the
 * four situations that matter produce none: a dialog nobody answers, a child
 * that quietly stops (R-23), a pane that vanishes. So the gate looks for
 * itself, on a timer, and MANUFACTURES the missing events. Nothing about the
 * waiting semantics changes — `orchestrator_wait` still waits for events —
 * there is simply now a second source of them that does not depend on a child
 * remembering to ring.
 *
 * WHAT LIVES WHERE. The four-state judgement is a pure function in
 * lib/orchestrator-child-state.ts (fake screens, unit tests, no terminal).
 * This module is the small IO shell around it: capture each pane, read each
 * sidecar, ask whether a judge process is in flight, and keep the per-child
 * memory between rounds. The queue it fills is drained by whoever DELIVERS
 * the news to the agent — the waiter, or the background timer's wake-up —
 * so an event is reported exactly once.
 */

import type { OrchestratorDeps } from "./orchestrator-deps.ts";
import { capturePane } from "./orchestrator-tool-kit.ts";
import { dialogIsOpen } from "./orchestrator-pane-read.ts";
import { markChildDone, type ChildSession } from "./orchestrator-registry.ts";
import { pathsOutsideBoundaries } from "./orchestrator-boundaries.ts";
import type { OrchestratorPlan } from "./orchestrator-plan.ts";

import { buildListPanesArgv, parsePaneIds } from "./orchestrator-tmux.ts";
import {
  classifyChildState,
  decideChildEvent,
  type ChildHealth,
  type ChildSidecarFacts,
  type ChildState,
  type ChildStateMemory,
} from "./orchestrator-child-state.ts";

/** What a manufactured event is ABOUT. */
export type ProbeEventKind =
  /** The child entered (or is stuck in) a newsworthy state. */
  | "state"
  /**
   * It edited a file outside its task's declared boundary (R3-1).
   *
   * A separate kind because it is not a state at all: a child can breach its
   * boundary while perfectly healthy, and the supervisor must hear about it
   * exactly once per new path rather than on every probe.
   */
  | "boundary-breach";

/** One manufactured event: a child entered (or is stuck in) a newsworthy state. */
export interface ProbeEvent {
  childId: string;
  taskId?: string;
  paneId?: string;
  kind?: ProbeEventKind;
  state: ChildState;
  reason: string;
  /** The out-of-boundary paths, on a `boundary-breach` event. */
  paths?: string[];
  /** ms — when the probe raised it. */
  at: number;
}

/**
 * An event that was queued and is NOT worth delivering any more (R3-3).
 *
 * Measured three times in the third run: an answered dialog, and then a
 * CLOSED child, each produced a `wait` that returned in 0s announcing news
 * that the same receipt's health snapshot already contradicted. The event is
 * dropped — but named, because silently swallowing events is the other half
 * of the same bug (R-16).
 */
export interface StaleProbeEvent {
  event: ProbeEvent;
  reason: string;
}

/** What `drain` hands back: what to act on, and what was written off. */
export interface DrainedEvents {
  events: ProbeEvent[];
  stale: StaleProbeEvent[];
}

/** How often the background timer runs the probe (user decision, 2026-08-30). */
export const PROBE_INTERVAL_MS = 10_000;

/** Nothing older than this is worth waking anybody for. */
export const PROBE_EVENT_TTL_MS = 5 * 60_000;

/** At most this many manufactured events are held for a consumer. */
export const PROBE_QUEUE_MAX = 20;

export interface ChildProbe {
  /** Observe every open child once; queue whatever is newsworthy. */
  observe(now?: number): { health: ChildHealth[]; events: ProbeEvent[] };
  /**
   * Take the queued events (they are then considered delivered).
   *
   * `childId` narrows it to ONE child and LEAVES the rest queued — a
   * supervisor waiting on a single child must not silently drop the news
   * about its siblings, which is the same class of loss R-16 was.
   */
  drain(opts?: { now?: number; childId?: string }): DrainedEvents;

  /** How many events are waiting to be delivered. */
  pending(now?: number): number;
  /** The most recent snapshot, without re-observing. */
  lastHealth(): ChildHealth[];
}

/**
 * The STRUCTURED facts about one child — the half that is exact.
 *
 * Two independent sources, and neither depends on the other: whether a judge
 * process is in flight is read from the judge run directories (it is true
 * even for a child that has not written a sidecar yet), and the rest comes
 * from the child's own gate state. Deliberately tiny: everything else a child
 * records is diagnostics, and a probe that parsed the whole gate state would
 * break every time that schema grew a field.
 */
function structuredFacts(
  deps: OrchestratorDeps,
  child: ChildSession,
  raw: Record<string, unknown> | undefined,
): ChildSidecarFacts {
  const facts: ChildSidecarFacts = { judgeRunning: deps.childJudgeRunning(child.cwd) };
  if (!raw) return facts;
  const nested = (key: string): Record<string, unknown> | undefined => {
    const value = raw[key];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  };
  const review = nested("review");
  const precommit = nested("precommit");
  // R3-5 — the completion record. This is the ONLY reason the `done` state can
  // exist: the child's gate wrote down that `declare_done` was accepted, so a
  // supervisor never has to infer completion from leftover terminal text.
  const completion = nested("completion");
  return {
    ...facts,
    pausedQuestion: Boolean(nested("pausedQuestion")),
    ...(typeof review?.verdict === "string" ? { reviewVerdict: review.verdict } : {}),
    ...(typeof precommit?.verdict === "string" ? { precommitVerdict: precommit.verdict } : {}),
    ...(typeof completion?.at === "string" && completion.at ? { completedAt: completion.at } : {}),
  };
}

/**
 * The files a child has actually EDITED, from its own sidecar (R3-1).
 *
 * Constraint 8 used to be judged from path-like words in the child's goal
 * TEXT, which cost two proxy approvals in the third run: a documentation task
 * whose goal quoted the modules it describes ("可逐条对照
 * `lib/orchestrator-probe.ts`") was refused for "leaving its boundary" while
 * its non-goals section promised not to touch a single line of code. What a
 * child WROTE is a fact; what its goal mentions is prose.
 */
function editedFiles(raw: Record<string, unknown> | undefined): string[] {
  const list = raw?.sessionEditedFiles;
  if (!Array.isArray(list)) return [];
  return list.filter((f): f is string => typeof f === "string" && f.trim().length > 0);
}

/**
 * The child's out-of-boundary landings, if its task declared boundaries.
 *
 * Returns nothing when the plan (or the task) cannot be read: a missing
 * declaration is not evidence of a breach, and manufacturing one would train
 * the supervisor to ignore this event.
 */
function boundaryBreach(
  child: ChildSession,
  plan: OrchestratorPlan | undefined,
  raw: Record<string, unknown> | undefined,
): string[] {
  const task = plan?.tasks.find((t) => t.id === child.taskId);
  if (!task || task.fileBoundaries.length === 0) return [];
  return pathsOutsideBoundaries(editedFiles(raw), task.fileBoundaries);
}

/**
 * When this child was last given work, in ms — `lastAssignedAt`, else its
 * creation time (a child that was never re-tasked was assigned at spawn).
 *
 * Unparseable stamps answer `undefined`, which keeps the old behavior (any
 * completion record counts) rather than silently making completion
 * unreachable — a `done` that can never be reached is the R3-5 outage again.
 */
function assignedAtMs(child: ChildSession): number | undefined {
  for (const stamp of [child.lastAssignedAt, child.createdAt]) {
    if (!stamp) continue;
    const ms = Date.parse(stamp);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}


/**
 * Create the probe for one orchestration.
 *
 * The memory lives in the closure rather than in the sidecar on purpose: it is
 * an OBSERVATION cache (what the screen looked like last time), not a fact
 * anybody must be able to recover after a restart. A fresh process simply
 * starts observing again, and the first round of a restarted probe reports
 * everything as "changed", which is the safe direction — it errs toward
 * "working", never toward a false "idle".
 */
export function createChildProbe(deps: OrchestratorDeps): ChildProbe {
  const memories = new Map<string, ChildStateMemory>();
  let queue: ProbeEvent[] = [];
  let health: ChildHealth[] = [];

  function alivePaneIds(): { panes: string[]; ok: boolean } {
    const self = deps.ownPane();
    if (!self) return { panes: [], ok: false };
    try {
      const result = deps.tmux(buildListPanesArgv(self));
      if (!result.ok) return { panes: [], ok: false };
      return { panes: parsePaneIds(result.stdout), ok: true };
    } catch {
      return { panes: [], ok: false };
    }
  }

  function prune(now: number): void {
    queue = queue.filter((e) => now - e.at <= PROBE_EVENT_TTL_MS).slice(-PROBE_QUEUE_MAX);
  }

  /**
   * R3-3 — judge every queued event against the CURRENT truth before it wakes
   * anybody.
   *
   * Three reproductions in the third run: right after a dialog was answered,
   * and twice after a child had been CLOSED, `orchestrator_wait` returned in
   * 0s announcing "it entered waiting-input / idle" — while the health
   * snapshot in the SAME receipt said otherwise. Nothing was lost by it, but
   * the supervisor paid an `orchestrator_read` for a box that no longer
   * existed, and a receipt that contradicts itself is a receipt nobody can
   * rely on.
   *
   * Dropped events are RETURNED, never swallowed: R-16 was the mirror-image
   * bug, and the cure for one must not be the other.
   */
  function review(taken: readonly ProbeEvent[]): DrainedEvents {
    const runtime = deps.runtime();
    const events: ProbeEvent[] = [];
    const stale: StaleProbeEvent[] = [];
    for (const event of taken) {
      const child = runtime.children.find((c) => c.id === event.childId);
      if (!child || child.closedAt) {
        stale.push({ event, reason: "这个子会话已经关闭 / 不在登记表里了" });
        continue;
      }
      const current = memories.get(event.childId)?.state;
      // A boundary breach is about files already written: it does not expire
      // when the child moves to another state. Only STATE news can go stale.
      if (event.kind !== "boundary-breach" && current !== undefined && current !== event.state) {
        stale.push({ event, reason: `它现在是 ${current}，已经不是事件里的 ${event.state} 了` });
        continue;
      }
      events.push(event);
    }
    return { events, stale };
  }

  return {
    observe(nowArg?: number) {
      const now = nowArg ?? deps.now();
      const runtime = deps.runtime();
      const open = runtime.children.filter((c) => !c.closedAt);
      const panes = alivePaneIds();
      const raised: ProbeEvent[] = [];
      const snapshot: ChildHealth[] = [];
      // Read ONCE per round: the boundary check below needs the task
      // declarations, and re-reading the plan per child would multiply the IO
      // by the number of panes for a file that cannot change mid-round.
      const plan = deps.readPlan().plan;

      for (const child of open) {
        const snapshotOfPane = capturePane(deps, child.paneId);
        // ONE read of the child's sidecar per round: the state facts and the
        // boundary check both come out of it, and re-reading it per question
        // would multiply the file IO by the number of children every 10s.
        const sidecarRaw = deps.childGateState(child.cwd, child.stateVariant);
        const assignedAt = assignedAtMs(child);
        const previous = memories.get(child.id);
        const verdict = classifyChildState(
          {
            childId: child.id,
            // UNKNOWN liveness is not death (F14): when `list-panes` cannot be
            // read, the state machine keeps whatever it decided last time.
            paneAlive: panes.ok ? panes.panes.includes(child.paneId) : undefined,
            ...(snapshotOfPane ? { screenText: snapshotOfPane.text } : {}),
            dialogOpen: dialogIsOpen(snapshotOfPane),
            ...(snapshotOfPane?.dialog?.title ? { dialogTitle: snapshotOfPane.dialog.title } : {}),
            sidecar: structuredFacts(deps, child, sidecarRaw),

            done: Boolean(child.doneAt),
            // A completion older than the child's current assignment says
            // nothing about the work it is doing NOW (round-1 P1). Spawn
            // stamps this too, so the first assignment is covered as well.
            ...(assignedAt !== undefined ? { assignedAt } : {}),
            at: now,
          },
          previous,
        );
        const decision = decideChildEvent(verdict, previous?.state, now);
        let memory = decision.memory;
        if (decision.raise) {
          raised.push({
            childId: child.id,
            taskId: child.taskId,
            paneId: child.paneId,
            kind: "state",
            state: verdict.state,
            reason: decision.reason,
            at: now,
          });
        }
        // R3-5 — a completion the probe has SEEN becomes a registry fact.
        // `markChildDone` had no caller at all, so `doneAt` was never set and
        // every consumer of it (status, scheduling, the exit check) was dead
        // code. The probe is the one component that reads the child's sidecar
        // on a timer, so it is where the fact lands.
        if (verdict.state === "done" && !child.doneAt) {
          deps.saveRuntime(markChildDone(deps.runtime(), child.id, new Date(now).toISOString()));
        }
        // R3-1 — constraint 8, judged against what the child actually wrote.
        const outside = boundaryBreach(child, plan, sidecarRaw);
        const fresh = outside.filter((p) => !(memory.breachReported ?? []).includes(p));
        if (fresh.length > 0) {
          memory = { ...memory, breachReported: [...(memory.breachReported ?? []), ...fresh] };
          raised.push({
            childId: child.id,
            taskId: child.taskId,
            paneId: child.paneId,
            kind: "boundary-breach",
            state: verdict.state,
            paths: fresh,
            reason:
              `它改到了任务 ${child.taskId} 边界之外的文件：${fresh.slice(0, 8).join("、")}` +
              (fresh.length > 8 ? ` 等 ${fresh.length} 个` : "") +
              " —— 这是范围变更（约束 8），按实际落点判定，不是按 goal 正文",
            at: now,
          });
        }
        memories.set(child.id, memory);
        const changedAt = decision.memory.changedAt;
        snapshot.push({
          childId: child.id,
          taskId: child.taskId,
          paneId: child.paneId,
          state: verdict.state,
          reason: verdict.reason,
          ...(changedAt !== undefined
            ? {
                lastActivityAt: new Date(changedAt).toISOString(),
                secondsSinceActivity: Math.max(0, Math.round((now - changedAt) / 1000)),
              }
            : {}),
          ...(snapshotOfPane?.dialog?.title ? { dialogTitle: snapshotOfPane.dialog.title } : {}),
          ...(child.doneAt || verdict.state === "done" ? { done: true } : {}),
          ...(outside.length > 0 ? { outsideBoundaries: outside } : {}),
        });
      }

      // A child that was closed between two probes must not keep a memory
      // (and therefore a backoff) alive forever.
      for (const id of [...memories.keys()]) {
        if (!open.some((c) => c.id === id)) memories.delete(id);
      }

      health = snapshot;
      queue = [...queue, ...raised];
      prune(now);
      return { health: snapshot, events: raised };
    },

    drain(opts?: { now?: number; childId?: string }): DrainedEvents {
      const now = opts?.now ?? deps.now();
      prune(now);
      const wanted = opts?.childId;
      let taken: ProbeEvent[];
      if (!wanted) {
        taken = queue;
        queue = [];
      } else {
        taken = queue.filter((e) => e.childId === wanted);
        queue = queue.filter((e) => e.childId !== wanted);
      }
      return review(taken);
    },



    pending(nowArg?: number) {
      prune(nowArg ?? deps.now());
      return queue.length;
    },

    lastHealth() {
      return health;
    },
  };
}

/**
 * One line naming who is calling and why — the sentence the old waiter could
 * not produce (R-4).
 */
export function describeProbeEvent(event: ProbeEvent): string {
  const who = `子会话 ${event.childId}（task=${event.taskId ?? "?"}，pane ${event.paneId ?? "?"}）`;
  if (event.kind === "boundary-breach") return `${who} 越界改文件：${event.reason}`;
  return `${who}进入 ${event.state}：${event.reason}`;
}

/** One line per event that was dropped instead of delivered (R3-3). */
export function describeStaleEvent(stale: StaleProbeEvent): string {
  return `${describeProbeEvent(stale.event)} —— 已作废：${stale.reason}`;
}

