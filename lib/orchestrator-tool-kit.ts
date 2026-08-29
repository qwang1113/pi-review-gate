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
import { buildListPanesArgv, parsePaneIds } from "./orchestrator-tmux.ts";
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
