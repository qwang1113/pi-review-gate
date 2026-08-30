/**
 * The L1 `tool_call` hook — the single entry point pi calls before EVERY tool
 * body runs, and the dispatch between the three things it decides.
 *
 * It lives here rather than in `extensions/review-gate.ts` for the reason this
 * repository has a rule about (AGENTS.md §"架构规范"): that file is ~7600
 * lines, and it got there one "just add it to the handler" at a time. The tool
 * families moved out first (lib/orchestrator-*-tools.ts,
 * lib/judge-session-tools.ts, lib/review-prepare-tools.ts,
 * lib/copilot-review-tools.ts, lib/user-interaction-tools.ts,
 * lib/goal-tools.ts, lib/gate-command-tools.ts); this is the first HOOK to
 * follow, and it was the biggest one.
 *
 * THE BOUNDARY, which is why the hook is three modules and not one:
 *   - this module        — the dispatch, the deps every arm shares, and the
 *                          judge-role subagent refusal (which belongs to
 *                          neither arm: it is about a `subagent` call);
 *   - ship-gate-edit-guard.ts — the edit/write arm (sensitive-file floor,
 *                          gate-owned exemption, L8 goal gate, orchestrator
 *                          write restriction, L6 label check);
 *   - ship-gate-bash.ts  — the bash arm, i.e. the ship gate proper.
 * Splitting that way is also what keeps all three clear of the 600-line hard
 * block on new source files (lib/file-size-gate.ts).
 *
 * THE EXTENSION KEEPS ONE LINE: `pi.on("tool_call", (event, ctx) =>
 * evaluateToolCall(deps, event, ctx))`. pi's own event and result types stay
 * on that side of the seam — this module takes the structural minimum
 * (`toolName` + `input`) so every branch is callable from a test with an
 * object literal.
 *
 * BEHAVIOR IS FROZEN: this was moved verbatim out of the extension, ORDER
 * included (the edit arm answers first and returns before the subagent scan;
 * the subagent scan runs before the bash arm). The orderings inside each arm
 * are documented in that arm's module and pinned in
 * test/extension-structure.test.ts.
 */

import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

import { isJudgeAgentName, judgeRoleInScript, normalizeToolName } from "./judge-prompt.ts";
import {
  evaluateEditCall,
  type EditGuardDeps,
  type ToolCallBlock,
} from "./ship-gate-edit-guard.ts";
import { evaluateShipCommand, type ShipGateBashDeps } from "./ship-gate-bash.ts";

export type { ToolCallBlock } from "./ship-gate-edit-guard.ts";
export type { BlockedShipRecord } from "./ship-gate-bash.ts";

/**
 * The structural minimum of pi's `ToolCallEvent`.
 *
 * pi's own union names each builtin tool's input type; the gate only ever
 * reads `toolName` and a handful of `input` fields, and taking the union here
 * would drag the host's types into lib/ for nothing.
 */
export interface ToolCallLike {
  toolName: string;
  input: unknown;
}

/** Everything the whole hook needs — the union of what its two arms need. */
export interface ShipGateHookDeps extends EditGuardDeps, ShipGateBashDeps {
  /**
   * Hand pi's context to the extension for the orchestration tools (persist +
   * dialogs). This hook runs immediately before every tool body, including
   * theirs, so it is the freshest context there is.
   */
  noteContext(ctx: unknown): void;
  /** The edit-tool names the gate guards (`edit` / `write` / `NotebookEdit`…). */
  isEditTool(toolName: string): boolean;
}

// (Which agent names are JUDGE roles is lib/judge-prompt.ts's own
// `isJudgeAgentName` — the same module `judgeRoleInScript` comes from, and the
// same list that detector scans with. The extension used to carry a
// byte-equivalent second copy; two places to edit one list is exactly how it
// drifts, so the copy died with the move (哲学三).)


/**
 * The judge-role subagent block (HARD), as a pure decision over the two
 * channels a judge role can arrive through plus the read of a script file.
 *
 * 2026-08-27 execution model: judge roles (reviewer / adviser /
 * goal-auditor) run ONLY as their own pi processes (review_spawn), never as
 * subagents. A subagent call naming a judge role is refused here — the
 * agent is told to use the review_spawn flow instead. This is the INVERTED
 * successor of the snapshot-pin guard: the same failure it blocked (a
 * judge running in the live worktree where the gate looks) is now blocked
 * by removing the dispatch shape entirely.
 */
export function judgeSubagentBlock(input: {
  /** The top-level `agent` parameter, if the call carried one. */
  agentName: string;
  /** An inline `workflowScript` body, if the call carried one. */
  script: string | undefined;
  /** A `workflowScriptPath`, if the call carried one. */
  scriptPath: string | undefined;
  /** Read that path; `undefined` on ANY failure (which fails closed below). */
  readScript: (path: string) => string | undefined;
}): ToolCallBlock | undefined {
  // Round-8 P1: the top-level agent field is NOT the only channel — a
  // workflowScript can name a judge role INSIDE its body (runs.run({
  // agent: "reviewer" })), and the sandbox still cannot give per-child
  // isolation. Scan the script text with judgeRoleInScript (the retired
  // guard's own detector, now covering all four judge roles).
  const { agentName, script, scriptPath } = input;
  const scriptText = script !== undefined
    ? script
    : scriptPath !== undefined
      ? input.readScript(scriptPath)
      : undefined;
  const judgeName = (agentName && isJudgeAgentName(agentName))
    ? agentName
    : scriptText !== undefined ? judgeRoleInScript(scriptText) : undefined;
  // Round-9 P2: a workflowScriptPath that cannot be read must FAIL CLOSED
  // — the read above yields undefined and no scan would run, letting an
  // unreadable script dispatch a judge role unchecked.
  const unreadableScript = scriptPath !== undefined && script === undefined && scriptText === undefined;
  if (judgeName || unreadableScript) {
    return {
      block: true,
      reason:
        judgeName
          ? `review-gate: \`${judgeName}\` is a judge role and runs ONLY as its own pi process — ` +
            "subagent dispatch for it is retired (2026-08-27 execution model). Submit it with " +
            "`judge_submit({role, task})`: the gate runs the whole chain and dispatches the judge itself. " +
            "(A judge dispatched as a subagent would run in your live worktree " +
            "with no isolation at all — the exact failure the model was built to end.)"
          : "review-gate: workflowScriptPath could not be read, so a judge role inside it cannot be ruled out — failing closed. Read the script, then dispatch non-judge work through it or submit judge roles with `judge_submit`.",
    };
  }
  return undefined;
}

/**
 * L1: the whole `tool_call` hook.
 *
 * Returns a refusal, or `undefined` to let the tool run.
 */
export async function evaluateToolCall(
  deps: ShipGateHookDeps,
  event: ToolCallLike,
  ctx: unknown,
): Promise<ToolCallBlock | undefined> {
  // Keep the newest context for the orchestration tools (persist + dialogs);
  // this hook runs immediately before every tool body, including theirs.
  deps.noteContext(ctx);
  const input = event.input as Record<string, unknown>;
  if (deps.isEditTool(event.toolName)) {
    return evaluateEditCall(deps, input, ctx);
  }

  // ---------- judge-role subagent block (HARD) ----------
  const subagentTool = normalizeToolName(event.toolName);
  if (subagentTool === "subagent") {
    const cwd = deps.cwd();
    const block = judgeSubagentBlock({
      agentName: typeof input.agent === "string" ? input.agent : "",
      script: typeof input.workflowScript === "string" ? input.workflowScript : undefined,
      scriptPath: typeof input.workflowScriptPath === "string" ? input.workflowScriptPath : undefined,
      readScript: (p) => {
        try {
          return readFileSync(pathResolve(cwd, p), "utf8");
        } catch { return undefined; }
      },
    });
    if (block) return block;
  }

  if (event.toolName !== "bash") return undefined;
  return evaluateShipCommand(deps, input, ctx);
}
