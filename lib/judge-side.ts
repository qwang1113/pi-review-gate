/**
 * THE JUDGE SIDE of the channel — what the gate does when IT is the review.
 *
 * A judge pane loads this extension with `RG_JUDGE_ID` in its environment.
 * In that mode the gate is a reporting shell, not an enforcer: it reports
 * heartbeats, races its dialogs against the opener's answers, drains round
 * tasks, and writes one `report` record per finished round — all through the
 * SAME primitives an orchestration child uses
 * (lib/orchestrator-child-channel.ts). A judge pane is a child process with
 * a gate; there is deliberately no second channel implementation for it.
 *
 * WHAT WRITES THE REPORT. The opener records verdicts (STALE checks, tree
 * binding — opener-owned), but only the judge side sees its own finish. On
 * settle it scans its transcript tail for a verdict fence and appends the
 * `report`; the opener learns it through its own `wait` receipt. The full
 * fence text rides as the (possibly spilled) summary, so the opener feeds
 * the EXACT bytes the recorder parses — no prose round-trip, no truncation.
 *
 * Pure-ish: env parsing and report building are pure; IO (transcript tail,
 * stream count, channel) arrives injected at the call sites.
 */
import {
  judgeChannelTarget,
  newChannelId,
  type ChannelIO,
} from "./orchestrator-channel.ts";
import type { ChildChannelBinding } from "./orchestrator-child-channel.ts";
import {
  JUDGE_ID_ENV,
  JUDGE_OPENER_ENV,
  JUDGE_ROLE_ENV,
} from "./judge-pane.ts";
import { parseReviewOutput } from "./verdict-parse.ts";

/** Task file the pane was opened with (round 1), if the opener passed one. */
export const JUDGE_TASK_ENV = "RG_JUDGE_TASK";
/** Findings stream path the round publishes, for the report's count. */
export const JUDGE_STREAM_ENV = "RG_JUDGE_STREAM";

/** Who this judge pane is, read from its own environment. */
export interface JudgeSideConfig {
  openerId: string;
  judgeId: string;
  role: string;
}

/**
 * Parse the judge identity out of the environment. `undefined` means this
 * session is NOT a judge — the normal gate applies untouched.
 */
export function readJudgeSideEnv(env: NodeJS.ProcessEnv): JudgeSideConfig | undefined {
  const openerId = (env[JUDGE_OPENER_ENV] ?? "").trim();
  const judgeId = (env[JUDGE_ID_ENV] ?? "").trim();
  const role = (env[JUDGE_ROLE_ENV] ?? "").trim();
  if (!openerId || !judgeId) return undefined;
  return { openerId, judgeId, role: role || "reviewer" };
}

/** The channel binding this judge reports, asks and drains through. */
export function judgeSideBinding(
  io: ChannelIO,
  config: JudgeSideConfig,
  sessionId?: string,
  home?: string,
): ChildChannelBinding {
  return {
    io,
    target: judgeChannelTarget(config.openerId, config.judgeId, home),
    ...(sessionId ? { sessionId } : {}),
  };
}

export interface VerdictReportInput {
  /** Bounded transcript tail — the caller caps it, the fence decides. */
  transcriptTail: string;
  /** Stream line count, when the stream file was readable. */
  findingsCount?: number;
  /** Clock for the record stamp. */
  now: number;
}

/**
 * Build the round's `report` from a transcript tail, or `undefined` when no
 * verdict fence is in it. Pure: the caller reads the tail and appends.
 */
export function buildVerdictReport(input: VerdictReportInput): {
  reportId: string;
  kind: "report";
  from: "child";
  at: string;
  verdict: string;
  findingsCount?: number;
  summary: string;
} | undefined {
  const parsed = parseReviewOutput(input.transcriptTail);
  if (!parsed) return undefined;
  return {
    reportId: newChannelId("rep", input.now),
    kind: "report",
    from: "child",
    at: new Date(input.now).toISOString(),
    verdict: parsed.verdict,
    ...(input.findingsCount === undefined ? {} : { findingsCount: input.findingsCount }),
    summary: input.transcriptTail,
  };
}


/**
 * Tools a judge session must never run. A judge is a reporting shell: it
 * reviews, it does not open sub-reviews, manage orchestrations, negotiate
 * goals, or finish tasks. `ask_user` is deliberately ABSENT — questions
 * are the one thing a judge must ask, and they race through the channel.
 */
export const JUDGE_DENIED_TOOLS: ReadonlySet<string> = new Set([
  "judge_submit", "judge_spawn", "judge_answer", "judge_recover", "judge_close", "judge_wait", "judge_read",
  "orchestrator_spawn", "orchestrator_instruct", "orchestrator_wait", "orchestrator_close",
  "orchestrator_handoff", "orchestrator_plan", "orchestrator_notify", "orchestrator_answer",
  "orchestrator_recover", "orchestrator_attach",
  "propose_loop_goal", "request_copilot_review", "check_copilot_review",
  "request_scope_limit", "request_sensitive_edit", "set_gate_mode", "declare_done",
  "request_arbitration",
]);

/** Why this tool is refused in a judge session, or undefined when allowed. */
export function judgeDeniedReason(toolName: string): string | undefined {
  if (!JUDGE_DENIED_TOOLS.has(toolName)) return undefined;
  return `review-gate: ${toolName} 在 review 会话里不可用——review 只负责评审（heartbeat 上报、答 opener 的问题、落 report），不开子 review、不管编排、不收尾任务。`;
}
/** Dedup key: one verdict + count + size is one report, never two. */
export function verdictReportKey(report: { verdict: string; findingsCount?: number; summary: string }): string {
  return `${report.verdict}#${report.findingsCount ?? "-"}#${report.summary.length}`;
}
