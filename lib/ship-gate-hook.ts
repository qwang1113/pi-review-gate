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
 * included (the edit arm answers first and returns before the bash arm).
 * The orderings inside each arm are documented in that arm's module and
 * pinned in test/extension-structure.test.ts.
 */

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


  if (event.toolName !== "bash") return undefined;
  return evaluateShipCommand(deps, input, ctx);
}
