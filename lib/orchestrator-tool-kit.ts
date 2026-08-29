/**
 * Shared plumbing for the orchestration tools — the three questions every one
 * of them has to answer before it does anything.
 *
 *  1. Am I even allowed to run? (only in orchestrator mode)
 *  2. What panes exist RIGHT NOW? (liveness is observed, never assumed)
 *  3. Is there a usable plan? (a broken plan file must report WHY, not vanish)
 *
 * Keeping them here means a new tool cannot accidentally skip one, and the
 * refusal wording stays identical across all eight — which matters, because
 * these messages are the agent's only documentation at the moment it is
 * blocked.
 */

import type { OrchestratorDeps, ToolReply } from "./orchestrator-deps.ts";
import { buildCapturePaneArgv, buildListPanesArgv, parsePaneIds } from "./orchestrator-tmux.ts";
import {
  emptyStartupEvidence,
  parsePaneSnapshot,
  readStartupEvidence,
  type PaneSnapshot,
  type StartupEvidence,
} from "./orchestrator-pane-read.ts";
import { deliveryVerdict, type DeliveryKind, type DeliveryVerdict } from "./orchestrator-delivery.ts";

import type { ChildSession } from "./orchestrator-registry.ts";
import type { OrchestratorPlan } from "./orchestrator-plan.ts";


/**
 * The two result builders.
 *
 * Named `toolReply` / `toolFail` rather than `reply` / `fail` deliberately:
 * a shared helper with a one-word generic name collides with ordinary prose
 * everywhere else in the repository, including the structural test that scans
 * for lib exports referenced without an import. A slightly longer name buys a
 * name that only ever means one thing.
 */
export function toolReply(text: string, details?: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details };
}

export function toolFail(text: string, details?: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details, isError: true };
}

/**
 * The orchestration tools exist only in orchestrator mode. A loop session
 * calling them would be improvising a supervisor role nobody agreed to, so
 * the refusal points at how the role is actually entered.
 */
export function requireOrchestratorMode(deps: OrchestratorDeps): ToolReply | undefined {
  if (deps.taskMode() === "orchestrator") return undefined;
  return toolFail(
    "review-gate: 编排工具只在 orchestrator（项目经理）模式下可用。" +
    "当前模式是 " + (deps.taskMode() ?? "undecided") + "。" +
    "如果用户确实要你当项目经理，先 set_gate_mode(\"orchestrator\")（需要在 tmux window 里）。",
  );
}

/**
 * Pane ids that exist at this instant.
 *
 * Asked fresh on every call rather than cached: between two tool calls a
 * child can die, and a cached "alive" is exactly what would let
 * `declare_done` pass with work still running (constraint 4). An empty list
 * means tmux could not be read — the caller treats that as "nothing is
 * provably alive", which is the fail-closed direction for spawning and the
 * fail-open one for exiting, so both callers check it explicitly.
 */
export function alivePanes(deps: OrchestratorDeps): { panes: string[]; ok: boolean } {
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

/**
 * The current plan, or a reply explaining what is wrong with the file. The
 * distinction matters: "no plan yet" is a normal early state, while "the plan
 * file is invalid" is a bug the agent must fix before anything else works.
 */
export function currentPlan(
  deps: OrchestratorDeps,
): { plan?: OrchestratorPlan; problem?: ToolReply } {
  const read = deps.readPlan();
  if (!read.plan && read.problems.length > 0) {
    return {
      problem: toolFail(
        "review-gate: plan 文件读不出来（校验未通过）：\n" +
        read.problems.map((p) => `  - ${p}`).join("\n") +
        "\n用 `orchestrator_plan` 重新写一份合法的 plan。",
        { planProblems: read.problems },
      ),
    };
  }
  return { plan: read.plan };
}

/**
 * READ a child's screen (F3, channel 1).
 *
 * `undefined` means tmux could not be read — which is deliberately different
 * from "the pane is empty": the waiter turns the first into "liveness
 * unknown, keep waiting" and the second into evidence, and conflating them is
 * what made a live child look dead (F14).
 */
export function capturePane(
  deps: OrchestratorDeps,
  paneId: string,
  lines?: number,
): PaneSnapshot | undefined {
  try {
    const result = deps.tmux(buildCapturePaneArgv(paneId, lines ?? undefined));
    if (!result.ok) return undefined;
    return parsePaneSnapshot(result.stdout);
  } catch {
    return undefined;
  }
}

/** What a child's own gate sidecar says (F3, channel 2 — the exact one). */
export interface ChildGateFacts {
  present: boolean;
  /** Rendered, one fact per line. Empty when there is no sidecar. */
  lines: string[];
  /** The goal draft the child is currently asking about, when there is one. */
  goalDraft?: string;
  /**
   * The files this child's session has EDITED — the fact constraint 8 is
   * judged on since R3-1. Empty when it has not written anything yet (which
   * is the normal state at goal-approval time, and is not a violation).
   */
  editedFiles: string[];
}

/** Longest goal draft echoed into a read (the whole point is to see it). */
const GOAL_DRAFT_MAX = 4000;

/**
 * Read the STRUCTURED half of a child's state.
 *
 * F10 is the reason this exists: when the orchestrator could not read the
 * child's goal-approval dialog, the draft text was already sitting in the
 * child's own sidecar under `goalPrereview.draft`. The data was never
 * missing; the tool was. Everything here is best-effort and clearly labelled
 * as coming from the sidecar, because it only ever knows about the GATE's own
 * dialogs — an ordinary question from the child appears nowhere in it.
 */
export function childGateFacts(deps: OrchestratorDeps, child: ChildSession): ChildGateFacts {
  const raw = deps.childGateState(child.cwd, child.stateVariant);
  if (!raw) return { present: false, lines: [], editedFiles: [] };
  const lines: string[] = [];
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const nested = (key: string): Record<string, unknown> | undefined => {
    const value = raw[key];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  };

  const mode = str(raw.taskMode);
  if (mode) lines.push(`门禁模式：${mode}`);
  const branch = str(raw.workBranch);
  if (branch) lines.push(`工作分支：${branch}${str(raw.baseBranch) ? ` → ${str(raw.baseBranch)}` : ""}`);
  const review = nested("review");
  if (review) lines.push(`review 判决：${str(review.verdict) ?? "?"}`);
  const precommit = nested("precommit");
  if (precommit) lines.push(`precommit：${str(precommit.verdict) ?? "?"}`);
  const paused = nested("pausedQuestion");
  if (paused) lines.push(`它在等用户回答：${str(paused.question) ?? "（问题正文读不到）"}`);

  const prereview = nested("goalPrereview");
  const draft = prereview ? str(prereview.draft) : undefined;
  if (prereview) {
    lines.push(`goal 预审：${str(prereview.verdict) ?? "?"} @ ${str(prereview.at) ?? "?"}`);
  }
  // The actual landings (R3-1). Listed in the read-out too, because "what has
  // it changed so far" is the question a supervisor asks right before it
  // approves anything on the child's behalf.
  const editedFiles = Array.isArray(raw.sessionEditedFiles)
    ? raw.sessionEditedFiles.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    : [];
  if (editedFiles.length > 0) {
    lines.push(
      `已改过的文件（${editedFiles.length}）：${editedFiles.slice(0, 10).join("、")}` +
      (editedFiles.length > 10 ? " …" : ""),
    );
  }
  return {
    present: true,
    lines,
    editedFiles,
    ...(draft ? { goalDraft: draft.slice(0, GOAL_DRAFT_MAX) } : {}),
  };
}

/** How long a delivery check keeps looking for evidence, and how often. */
export const DELIVERY_VERIFY_ATTEMPTS = 15;
export const DELIVERY_VERIFY_INTERVAL_MS = 1000;

export interface DeliveryCheck {
  verdict: DeliveryVerdict;
  evidence: StartupEvidence;
  /** The last screen that was read — handed back so a failure shows it. */
  snapshot?: PaneSnapshot;
}

/**
 * WATCH a delivery until it can be believed, or until the budget runs out
 * (F7/F8 — the receipt is earned, never assumed).
 *
 * It polls rather than checking once because starting a pi session is not
 * instantaneous, and a single check right after `split-window` would fail on
 * every healthy spawn. It stops at the FIRST positive evidence: there is
 * nothing to gain by watching a child that has demonstrably started.
 *
 * The evidence itself is judged by lib/orchestrator-delivery.ts, which knows
 * that a running process proves a SPAWN (the task rode in on the argv) and
 * proves nothing at all about a typed message.
 */
export async function verifyDelivery(
  deps: OrchestratorDeps,
  opts: {
    kind: DeliveryKind;
    paneId: string;
    marker?: string;
    /** Where the child's own sidecar would appear, when it has one. */
    cwd?: string;
    stateVariant?: string;
    attempts?: number;
    intervalMs?: number;
  },
): Promise<DeliveryCheck> {
  const attempts = Math.max(1, opts.attempts ?? DELIVERY_VERIFY_ATTEMPTS);
  const interval = Math.max(0, opts.intervalMs ?? DELIVERY_VERIFY_INTERVAL_MS);
  let evidence: StartupEvidence = emptyStartupEvidence();
  let snapshot: PaneSnapshot | undefined;
  let verdict: DeliveryVerdict = deliveryVerdict(opts.kind, evidence);

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await deps.sleep(interval);
    snapshot = capturePane(deps, opts.paneId);
    const pane = readStartupEvidence(snapshot, opts.marker);
    const sidecarPresent = opts.cwd
      ? Boolean(deps.childGateState(opts.cwd, opts.stateVariant))
      : false;
    evidence = { ...pane, sidecarPresent };
    verdict = deliveryVerdict(opts.kind, evidence);
    if (verdict.ok) break;
  }
  return { verdict, evidence, ...(snapshot ? { snapshot } : {}) };
}

