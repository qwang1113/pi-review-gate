/**
 * BACKGROUND-AGENT WAIT TRACKING — "is this session waiting on an Agent it
 * spawned in the background" (2026-09-09).
 *
 * WHY IT EXISTS
 *
 * An orchestration child that spawns a background subagent (the `Agent` tool
 * with `run_in_background` left true — its default) gets the tool result
 * back immediately ("Agent started in background"), keeps or ends its turn,
 * and then simply WAITS: pi-subagents will inject a completion notification
 * and start a new turn when the agent is done. While it waits, the child's
 * own `ctx.isIdle()` is true — the same reading a genuinely stopped child
 * gives — so the heartbeat reported `idle`, and after
 * `IDLE_PROGRESS_GRACE_MS` of no forward progress the project manager read
 * "停下了（没有 declare_done）" for a child that was doing exactly what it
 * should: waiting on work it started itself. The fix is to name the wait:
 * while at least one background agent has not reported a terminal state, the
 * child reports `working` instead of `idle`.
 *
 * THE CONTRACT THIS FILE OWNS — start and end, nothing else.
 *
 * A wait STARTS when a tool result says an agent was launched in the
 * background (`started in background … Agent ID: <id>` — pi-subagents' own
 * wording, matched here because the tool result is the one place the id is
 * handed out). A failed launch (an error result, or text without the launch
 * wording) never starts a wait.
 *
 * A wait ENDS ONLY on that agent's own terminal signal. Two are recognised,
 * both keyed by the agent id:
 *
 *   - a `subagent-notification` message whose `details` carry the id (group
 *     notifications list the other finished agents in `details.others`);
 *   - a `get_subagent_result` result whose text names the agent and is NOT a
 *     "still running" report (pi-subagents prints `Status: running` for the
 *     non-terminal poll and `Status: completed | error | …` for a terminal
 *     one — matched as "has the agent's line and no `Status: running`").
 *
 * There is deliberately NO timeout and NO "a new turn started, clear
 * everything" fallback: both clear waits without a completion signal, and a
 * cleared wait turns the wait right back into a false "idle". An agent whose
 * terminal signal never arrives stays a wait — the safe direction, because
 * the cost of a false `working` is a supervisor that does not nudge, while
 * the cost of a false `idle` is a supervisor that interrupts a running
 * review (measured round-4 P0). The only removal path is the agent's own
 * terminal signal, even across turns and with several agents in flight
 * (goal-auditor round 1: "按 agent id 消费终态信号").
 *
 * Pure module: observations in, an immutable id list out. No filesystem, no
 * clock, no process state of its own.
 */

/** One tool result, as the extension's event delivers it (name + fate + text). */
export interface BackgroundWaitToolResult {
  toolName: string;
  isError: boolean;
  /** The result's text content. */
  text: string;
}

/** One custom message, as delivered by pi's message_start/end. */
export interface BackgroundWaitMessage {
  customType?: string;
  /** `details` of a `subagent-notification`: `{ id, …, others?: [{ id, … }] }`. */
  details?: unknown;
}

/** A wait event: a tool finished, or a custom message arrived. */
export type BackgroundWaitEvent =
  | { kind: "tool_result"; tool: BackgroundWaitToolResult }
  | { kind: "message"; message: BackgroundWaitMessage };

/** The ids of background agents still waiting on a terminal signal. */
export type BackgroundWaits = readonly string[];

/** No background agents in flight. */
export const NO_BACKGROUND_WAITS: BackgroundWaits = [];

/** pi-subagents' launch wording: `Agent started in background. Agent ID: <id>`. */
const LAUNCH_RE = /started in background[^]*?Agent ID:\s*([A-Za-z0-9._-]+)/i;
/** pi-subagents names the agent in every status report: `Agent: <id>` on its own line. */
const NAMED_AGENT_RE = /Agent:\s*([A-Za-z0-9._-]+)/;
/** A non-terminal poll prints `Status: running`; a terminal one prints completed/error/…. */
const STILL_RUNNING_RE = /Status:\s*running\b/i;

/** True when the tool result launched a background agent — the wait's start. */
function launchedBy(result: BackgroundWaitToolResult): string | undefined {
  if (result.isError) return undefined;
  const match = LAUNCH_RE.exec(result.text);
  if (!match) return undefined;
  // The wording is pi-subagents' own; only its tools speak it. Keeping the
  // name check is what stops an unrelated tool result that happens to quote
  // the phrase from starting a wait.
  if (result.toolName !== "Agent" && result.toolName !== "NestedAgent") return undefined;
  return match[1] ? match[1].trim() : undefined;
}

/** The agents a `get_subagent_result` result reports as TERMINAL. */
function terminalFromResult(result: BackgroundWaitToolResult): readonly string[] {
  if (result.isError || result.toolName !== "get_subagent_result") return [];
  if (STILL_RUNNING_RE.test(result.text)) return [];
  const match = NAMED_AGENT_RE.exec(result.text);
  return match ? [match[1]!.trim()] : [];
}

/** The agent ids a `subagent-notification` message reports as terminal. */
function terminalFromMessage(message: BackgroundWaitMessage): readonly string[] {
  if (message.customType !== "subagent-notification") return [];
  const ids: string[] = [];
  const collect = (details: unknown): void => {
    if (typeof details !== "object" || details === null) return;
    const d = details as { id?: unknown; others?: unknown };
    if (typeof d.id === "string" && d.id.trim() !== "") ids.push(d.id.trim());
    if (Array.isArray(d.others)) for (const other of d.others) collect(other);
  };
  collect(message.details);
  return ids;
}

/** Fold one event into the wait list — pure, immutable. */
export function foldBackgroundWaits(
  waits: BackgroundWaits,
  event: BackgroundWaitEvent,
): BackgroundWaits {
  if (event.kind === "message") {
    const done = terminalFromMessage(event.message);
    return done.length === 0 ? waits : waits.filter((id) => !done.includes(id));
  }
  const launched = launchedBy(event.tool);
  if (launched !== undefined && !waits.includes(launched)) return [...waits, launched];
  const done = terminalFromResult(event.tool);
  return done.length === 0 ? waits : waits.filter((id) => !done.includes(id));
}

/** Whether any background agent is still waiting on its terminal signal. */
export function hasBackgroundWaits(waits: BackgroundWaits): boolean {
  return waits.length > 0;
}
