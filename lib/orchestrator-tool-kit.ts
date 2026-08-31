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
import { buildListPanesArgv, buildPaneTitleArgv, parsePaneIds } from "./orchestrator-tmux.ts";
import { paneLabelFor, paneTitleForHealth } from "./orchestrator-pane-decor.ts";
import { channelPathFor, projectChannel, readChannel } from "./orchestrator-channel.ts";
import type { ChildAssets, SupervisionSnapshot } from "./orchestrator-supervisor.ts";

import {
  deliveryVerdict,
  emptyDeliveryEvidence,
  type DeliveryEvidence,
  type DeliveryKind,
  type DeliveryVerdict,
  type InstructDeliveryMode,

} from "./orchestrator-delivery.ts";


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
  // Symmetric re-arm (2026-08-30): every orchestration-tool execution counts
  // as the project manager's WORK, the same way an edit is a loop session's
  // work. Fired only when the call is LEGITIMATE (orchestrator mode), so a
  // loop session mis-calling an orchestration tool cannot re-arm its own loop.
  if (deps.taskMode() === "orchestrator") deps.onToolCall?.("orchestrator");
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
 * READING A CHILD'S SCREEN IS GONE (2026-08-30).
 *
 * `capturePane` used to live here and every state question went through it.
 * It is deleted along with its parsers: a child now REPORTS on its channel
 * (lib/orchestrator-child-channel.ts) and lib/orchestrator-supervisor.ts
 * reads that. The only thing tmux is still asked is {@link alivePanes} —
 * which panes exist — because a dead process cannot file a report.
 */


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
/**
 * WHAT SURVIVED A CHILD THAT DIED — read from its own gate sidecar.
 *
 * A dead child is not a lost task, and the receipt has to say so in the same
 * breath as the death (task book §4): its branch, its last checkpoint and its
 * last review verdict are all on disk, owned by git and by the sidecar, and
 * none of them cared that the process went away. Without this block the
 * orchestrator's only honest move on a crash is to assume the worst.
 */
export function childAssets(deps: OrchestratorDeps, child: ChildSession): ChildAssets | undefined {
  const raw = deps.childGateState(child.cwd, child.stateVariant);
  if (!raw) return undefined;
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const nested = (key: string): Record<string, unknown> | undefined => {
    const value = raw[key];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  };
  const review = nested("review");
  return {
    ...(str(raw.lastCheckpointSha) === undefined ? {} : { checkpoint: str(raw.lastCheckpointSha)! }),
    ...(review && str(review.verdict) !== undefined ? { reviewVerdict: str(review.verdict)! } : {}),
    ...(str(raw.completedAt) === undefined ? {} : { completedAt: str(raw.completedAt)! }),
  };
}


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
  evidence: DeliveryEvidence;
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
 * WHAT IS POLLED IS THE CHANNEL, not a screen. For a spawn, any record at all
 * proves the process started AND its gate is alive; for an instruction, the
 * child's own acknowledgement proves it was injected. The judgement itself is
 * lib/orchestrator-delivery.ts's — this function only gathers.
 */
export async function verifyDelivery(
  deps: OrchestratorDeps,
  opts: {
    kind: DeliveryKind;
    childId: string;
    /** Present for `instruct`: the record whose acknowledgement is awaited. */
    instructId?: string;
    /** Present for `instruct`: what was promised decides which ack suffices. */
    instructMode?: InstructDeliveryMode;
    /** Where the child's own sidecar would appear, when it has one. */
    cwd?: string;
    stateVariant?: string;
    attempts?: number;
    intervalMs?: number;
  },
): Promise<DeliveryCheck> {
  const attempts = Math.max(1, opts.attempts ?? DELIVERY_VERIFY_ATTEMPTS);
  const interval = Math.max(0, opts.intervalMs ?? DELIVERY_VERIFY_INTERVAL_MS);
  const verdictOpts = opts.instructMode === undefined ? {} : { instructMode: opts.instructMode };
  let evidence = emptyDeliveryEvidence();
  let verdict: DeliveryVerdict = deliveryVerdict(opts.kind, evidence, verdictOpts);

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await deps.sleep(interval);
    evidence = readDeliveryEvidence(deps, opts);
    verdict = deliveryVerdict(opts.kind, evidence, verdictOpts);
    if (verdict.ok) break;
  }
  return { verdict, evidence };
}

/** One observation of a delivery, straight from the channel and the sidecar. */
function readDeliveryEvidence(
  deps: OrchestratorDeps,
  opts: { childId: string; instructId?: string; cwd?: string; stateVariant?: string },
): DeliveryEvidence {
  const sidecarPresent = opts.cwd
    ? Boolean(deps.childGateState(opts.cwd, opts.stateVariant))
    : false;
  try {
    const io = deps.channelIO();
    const path = channelPathFor(deps.runtime().orchestrationId, opts.childId, deps.channelHome());
    const read = readChannel(io, path);
    // The LAST matching ack, not the first: the handshake is two records now
    // (`received`, then `injected`), and reading the first one would report a
    // queued message forever as merely queued — including in the receipt of a
    // `steer` that has since landed.
    const acks = opts.instructId
      ? read.records.filter(
          (record) => record.kind === "instruct-ack" && record.instructId === opts.instructId,
        )
      : [];
    const ack = acks[acks.length - 1];
    return {
      channelReported: read.records.length > 0,
      sidecarPresent,
      ...(ack && ack.kind === "instruct-ack"
        ? {
            ack: {
              delivered: ack.delivered,
              ...(ack.stage === undefined ? {} : { stage: ack.stage }),
              ...(ack.detail === undefined ? {} : { detail: ack.detail }),
            },
          }
        : {}),
    };
  } catch {
    return { channelReported: false, sidecarPresent };
  }
}


/** Everything still outstanding on one child's channel. */
export function childChannelProjection(deps: OrchestratorDeps, childId: string) {
  try {
    const path = channelPathFor(deps.runtime().orchestrationId, childId, deps.channelHome());
    return projectChannel(readChannel(deps.channelIO(), path).records);
  } catch {
    return projectChannel([]);
  }
}



/** Shortest gap between two repaints of the SAME pane. */
const PANE_REPAINT_MIN_MS = 5_000;


/**
 * Repaint every child's border label from the health that was just measured.
 *
 * WHY IT RIDES THE PROBE. The supervision pass already re-reads every channel
 * on a timer and inside every `orchestrator_wait`, so it already knows each
 * child's state and how long it has held it. Writing that onto the border
 * costs one tmux call per child and gives the human the answer without a tool
 * call at all — which is the entire point of putting the state on the border
 * rather than only in the receipt.
 *
 * STRICTLY ONE-WAY. Nothing ever reads these titles back: they are an output
 * of the projection, never an input to it. A tmux failure is swallowed for
 * the same reason — supervision must not degrade because a cosmetic write
 * failed, and a child whose pane is `dead` is skipped rather than written to.
 *
 * Returns the legend (childId → label) so a caller can print the same names
 * it just painted.
 *
 * THROTTLED, and it has to be. The wait loop probes every 2 seconds, so an
 * unthrottled repaint would spawn a tmux process per child per probe — 150
 * of them per child over one default wait — and the title carries a SECONDS
 * counter, so comparing the rendered string would never dedupe anything
 * either. A border that lags by a few seconds costs nothing; a supervisor
 * that forks a process every two seconds for decoration is a real cost.

 */
export function refreshPaneLabels(
  deps: OrchestratorDeps,
  snapshot: SupervisionSnapshot,
): Array<{ childId: string; label: string }> {
  const plan = (() => {
    try { return deps.readPlan().plan; } catch { return undefined; }
  })();
  const legend: Array<{ childId: string; label: string }> = [];
  for (const supervision of snapshot.children) {
    const child = supervision.child;
    const taskTitle = plan?.tasks.find((task) => task.id === child.taskId)?.title ?? child.taskId;
    const label = paneLabelFor(child.taskId, taskTitle);

    legend.push({ childId: child.id, label });
    if (supervision.state === "dead") continue;
    const title = paneTitleForHealth(label, supervision.health);
    const painted = deps.paneDecorMemory().get(child.id);
    const now = deps.now();
    if (painted && painted.title === title) continue;
    if (painted && now - painted.at < PANE_REPAINT_MIN_MS) continue;
    deps.paneDecorMemory().set(child.id, { title, at: now });

    try {
      deps.tmux(buildPaneTitleArgv(child.paneId, title));
    } catch {
      /* cosmetic only — never allowed to affect supervision */
    }
  }

  return legend;
}


