/**
 * The SEAM every tool-registration module in lib/ registers through.
 *
 * It used to live inside lib/orchestrator-deps.ts, because the orchestration
 * tools were the first ones to move out of `extensions/review-gate.ts`. They
 * are not the last: the judge tools follow (lib/judge-session-tools.ts), and a
 * judge module importing its host type from a file named after the
 * ORCHESTRATOR would be a false dependency — the two share a host, not a
 * domain.
 *
 * lib/orchestrator-deps.ts re-exports both names, so every existing import
 * keeps working; this file is now where they are defined.
 *
 * Types only: no behavior at all.
 */

import type { TSchema } from "typebox";

/** Result shape the pi tool runtime expects. */
export interface ToolReply {
  content: Array<{ type: "text"; text: string }>;
  /** Present-but-undefined is required by the host's own result type. */
  details: Record<string, unknown> | undefined;
  isError?: boolean;
}

/**
 * Just enough of the pi extension API to register a tool.
 *
 * `parameters` is typed as typebox's `TSchema` (rather than `unknown`) so the
 * real `ExtensionAPI` satisfies this interface structurally: the host's own
 * signature is generic over the schema, and a widened `unknown` would make it
 * incompatible.
 */
export interface ToolHost {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute: (
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<ToolReply>;
  }): void;
}
