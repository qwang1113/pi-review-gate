/**
 * THE CHILD'S GATE RECORD — written at dispatch, read by the child's own gate.
 *
 * A child session used to negotiate its own loop goal, and that goal was the
 * contract every checkpoint read: the reviewer judged against it, the
 * acceptance round took its checklist from it, and the L8 edit gate waited for
 * its approval. None of that is true any more (2026-10-20, user decision): a
 * child works ONE task of a plan the user already approved, so its contract is
 * the task book and the plan's own acceptance checklist, and the GATE writes
 * what the checkpoints need into the child's sidecar before the pane opens.
 *
 * WHY THE SIDECAR AND NOT THE PANE'S ARGV. The child may run in its own git
 * worktree under /tmp, where the manager's `.pi/` does not exist — so the plan
 * text has to travel with the dispatch. The sidecar is the one file the child's
 * gate already reads for every decision, and writing it is exactly what makes
 * the five-switch box never appear there: `ensureLoopStages` sees a record and
 * `choose_loop_stages` stays refused.
 *
 * THE STAGES ARE `childStagesRecord`'s: goal off (no restatement, no goal
 * negotiation, no goal audit, no L8 goal block), acceptance on ONLY for the
 * plan's last task (one acceptance round per plan, lib/acceptance-round.ts).
 *
 * FAIL-CLOSED. A write that fails is reported to the dispatcher, which refuses
 * the spawn: opening a pane whose gate would then ask it to negotiate a goal is
 * the exact defect this module exists to end.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomic } from "./atomic-write.ts";
import type { ChildGateContext } from "./gate-state.ts";
import { emptyState } from "./gate-state.ts";
import { sidecarPath } from "./gate-state-io.ts";
import { childStagesRecord } from "./loop-stages.ts";
import { childSessionId } from "./orchestrator-delivery.ts";
import { deliveryTaskId } from "./repo-pr-policy.ts";
import { DEFAULT_MAX_ROUNDS } from "./constants.ts";

/** Everything the dispatch hands the child's gate. */
export interface ChildGateRecordInput {
  /** The child's checkout (its `cwd`) — the sidecar lives under it. */
  repo: string;
  /** The child's own state variant (its registry id). */
  variant: string;
  /** ISO time, supplied by the caller so the record is assertable. */
  at: string;
  plan: { intent: string; acceptancePlan: string; tasks: readonly { id: string }[] };
  taskId: string;
  /** The task book as the child receives it — the reviewer's judgement basis. */
  taskBrief: string;
}

/** The sidecar path the gate will read in that child's process. */
export function childSidecarPath(repo: string, variant: string): string {
  return sidecarPath(repo, ".pi", variant);
}

/**
 * Write the child's sidecar. Returns the refusal text when it cannot be
 * written — never a silent success.
 */
export function writeChildGateRecord(input: ChildGateRecordInput): { ok: true; path: string } | { ok: false; error: string } {
  const path = childSidecarPath(input.repo, input.variant);
  // The position rule has ONE home (lib/repo-pr-policy.ts); a copy here is how
  // the record and the environment could start disagreeing about who accepts.
  const accepts = input.taskId === deliveryTaskId(input.plan);
  // THE SESSION ID IS THE CHILD'S OWN, NOT NULL (quality round P0, 2026-10-20).
  // `session-restore-host` adopts a sidecar only when `restored.sessionId`
  // equals the running session id; with `null` there the child's very first
  // boot reset the file to an empty state, so the switches and the plan texts
  // were gone before the first turn — the whole mechanism, silently inert.
  const sessionId = childSessionId(input.variant);
  const state = emptyState(sessionId, DEFAULT_MAX_ROUNDS);
  state.stages = childStagesRecord({ accepts, at: input.at });
  const context: ChildGateContext = {
    planIntent: input.plan.intent,
    acceptancePlan: input.plan.acceptancePlan,
    taskBrief: input.taskBrief,
  };
  state.childContext = context;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, JSON.stringify(state, null, 2) + "\n");
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

