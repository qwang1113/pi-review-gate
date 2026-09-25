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
 * The two result builders every tool module shares (one copy, 2026-09-26 —
 * seven modules used to carry their own).
 *
 * Named `toolReply` / `toolFail` rather than `reply` / `fail` deliberately:
 * a shared helper with a one-word generic name collides with ordinary prose
 * everywhere else in the repository, including the structural test that scans
 * for lib exports referenced without an import. A slightly longer name buys a
 * name that only ever means one thing. (Callers may still import them `as
 * reply` / `as fail` locally.)
 */
export function toolReply(text: string, details?: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details };
}

export function toolFail(text: string, details?: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details, isError: true };
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
