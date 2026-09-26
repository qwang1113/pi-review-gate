/**
 * SESSION LAUNCH SPECS — the argv a judge pane runs, and the border a judge or
 * worker pane gets.
 *
 * Split out of lib/session-factory.ts (2026-09-27). These describe WHAT a
 * judge/worker pane is opened with; the factory is what opens it. (They had
 * already moved once, from lib/judge-pane.ts, which keeps the cross-process
 * env contract and pane-liveness probing.)
 */

import { judgePaneLabel, paneIdentity } from "./orchestrator-pane-decor.ts";
import type { ChildState } from "./orchestrator-child-state.ts";
import type { SessionPaneDecor } from "./session-factory.ts";

/** Flags every judge pane carries: the read-only review contract. */
export interface JudgePaneCommandOpts {
  sessionId: string;
  /** Absolute task file path, passed as pi's `@` argv message. */
  taskPath: string;
  /** Transcript dir (stable per role+repo) — resume key alongside the id. */
  sessionDir: string;
  /** Absolute system-prompt file for the role. */
  sysPromptPath: string;
  /** Resolved model spec. */
  model: string;
  piBin?: string;
}

/** The argv a judge pane runs: interactive pi, resumed by session id. */
export function buildJudgePaneCommand(opts: JudgePaneCommandOpts): string[] {
  const piBin = opts.piBin ?? "pi";
  return [
    piBin,
    "--no-skills",
    "--exclude-tools", "edit,write",
    "--system-prompt", opts.sysPromptPath,
    "--model", opts.model,
    "--session-dir", opts.sessionDir,
    "--session-id", opts.sessionId,
    `@${opts.taskPath}`,
  ];
}

/**
 * The argv that RESUMES a judge after its pane died.
 *
 * No task file: the transcript already holds every round. The opener re-drives
 * the round through its own wait/submit once the pane is back.
 */
export function buildJudgeRecoverCommand(sessionId: string, piBin = "pi"): string[] {
  return [piBin, "--exclude-tools", "edit,write", "--session-id", sessionId];
}

/**
 * The decoration a judge pane gets — the same shape a child gets, and the
 * owner it carries is the OPENER's own identity (lib/orchestrator-pane-decor.ts
 * `selfPaneOwner`), never a string a caller made up.
 */
export function judgePaneDecor(
  judgeId: string,
  role: string,
  owner: string,
  state: ChildState = "working",
): SessionPaneDecor {
  return { label: judgePaneLabel(role, owner), colorSeed: judgeId, state };
}

/**
 * The decoration a WORKER pane gets: `x@self`, `probe@t3`.
 *
 * Same shape and same owner rule as a judge's, and it is written ONCE — a
 * worker has no health probe to repaint it, which is exactly why the label is
 * a pane user option pi cannot overwrite (lib/orchestrator-tmux.ts
 * `PANE_LABEL_OPTION`). Without this, a worker pane was the one gate-opened
 * pane on screen with nothing on its border.
 */
export function workerPaneDecor(
  workerId: string,
  owner: string,
  state: ChildState = "working",
): SessionPaneDecor {
  return { label: paneIdentity({ what: workerId, owner }), colorSeed: workerId, state };
}
