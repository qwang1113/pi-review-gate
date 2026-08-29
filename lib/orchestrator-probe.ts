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
import type { ChildSession } from "./orchestrator-registry.ts";

import { buildListPanesArgv, parsePaneIds } from "./orchestrator-tmux.ts";
import {
  classifyChildState,
  decideChildEvent,
  type ChildHealth,
  type ChildSidecarFacts,
  type ChildState,
  type ChildStateMemory,
} from "./orchestrator-child-state.ts";

/** One manufactured event: a child entered (or is stuck in) a newsworthy state. */
export interface ProbeEvent {
  childId: string;
  taskId?: string;
  paneId?: string;
  state: ChildState;
  reason: string;
  /** ms — when the probe raised it. */
  at: number;
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
  drain(opts?: { now?: number; childId?: string }): ProbeEvent[];

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
): ChildSidecarFacts {
  const facts: ChildSidecarFacts = { judgeRunning: deps.childJudgeRunning(child.cwd) };
  const raw = deps.childGateState(child.cwd, child.stateVariant);
  if (!raw) return facts;
  const nested = (key: string): Record<string, unknown> | undefined => {
    const value = raw[key];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  };
  const review = nested("review");
  const precommit = nested("precommit");
  return {
    ...facts,
    pausedQuestion: Boolean(nested("pausedQuestion")),
    ...(typeof review?.verdict === "string" ? { reviewVerdict: review.verdict } : {}),
    ...(typeof precommit?.verdict === "string" ? { precommitVerdict: precommit.verdict } : {}),
  };
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

  return {
    observe(nowArg?: number) {
      const now = nowArg ?? deps.now();
      const runtime = deps.runtime();
      const open = runtime.children.filter((c) => !c.closedAt);
      const panes = alivePaneIds();
      const raised: ProbeEvent[] = [];
      const snapshot: ChildHealth[] = [];

      for (const child of open) {
        const snapshotOfPane = capturePane(deps, child.paneId);
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
            sidecar: structuredFacts(deps, child),

            done: Boolean(child.doneAt),
            at: now,
          },
          previous,
        );
        const decision = decideChildEvent(verdict, previous?.state, now);
        memories.set(child.id, decision.memory);
        if (decision.raise) {
          raised.push({
            childId: child.id,
            taskId: child.taskId,
            paneId: child.paneId,
            state: verdict.state,
            reason: decision.reason,
            at: now,
          });
        }
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
          ...(child.doneAt ? { done: true } : {}),
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

    drain(opts?: { now?: number; childId?: string }) {
      const now = opts?.now ?? deps.now();
      prune(now);
      const wanted = opts?.childId;
      if (!wanted) {
        const taken = queue;
        queue = [];
        return taken;
      }
      const taken = queue.filter((e) => e.childId === wanted);
      queue = queue.filter((e) => e.childId !== wanted);
      return taken;
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
  return `子会话 ${event.childId}（task=${event.taskId ?? "?"}，pane ${event.paneId ?? "?"}）进入 ${event.state}：${event.reason}`;
}

