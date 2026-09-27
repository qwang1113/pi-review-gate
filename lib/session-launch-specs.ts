/**
 * SESSION LAUNCH SPECS — the argv a judge pane runs, and the border a judge or
 * worker pane gets.
 *
 * Split out of lib/session-factory.ts (2026-09-27). These describe WHAT a
 * judge/worker pane is opened with; the factory is what opens it. (They had
 * already moved once, from lib/judge-pane.ts, which keeps the cross-process
 * env contract and pane-liveness probing.)
 */

import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { judgePaneLabel, judgeWindowName, paneIdentity, workerWindowName } from "./orchestrator-pane-decor.ts";
import type { ChildState } from "./orchestrator-child-state.ts";
import type { SessionPaneDecor } from "./session-factory.ts";

/**
 * The gate extension file THIS process loaded — its sibling `extensions/`, since
 * this module is only ever reached through that extension's own imports.
 */
export const OWN_GATE_EXTENSION = fileURLToPath(new URL("../extensions/review-gate.ts", import.meta.url));

/**
 * Every pane the gate opens runs THE SAME GATE CODE as its opener (D11).
 *
 * A bare `pi` loads whatever the settings register — the main checkout — so a
 * session started on a worktree's gate (`pi -e <worktree>/extensions/…`) used
 * to open judges, workers, children and successors that enforced different
 * rules than itself. `-e` names the file actually loaded here; when that is
 * the settings package's own file, pi dedupes the two by canonical path and
 * nothing changes; when it is not, pi loads both and `claimGateInstance` makes
 * the settings copy stand down. A `--no-extensions` on this process travels too, so the
 * pane loads exactly what its opener did. Only a `pi` argv is touched.
 */
export function withGateExtension(
  command: readonly string[],
  extensionPath: string = OWN_GATE_EXTENSION,
  hostArgv: readonly string[] = process.argv,
): string[] {
  const [bin, ...rest] = command;
  if (bin === undefined || basename(bin) !== "pi") return [...command];
  const noExtensions = hostArgv.includes("--no-extensions") || hostArgv.includes("-ne");
  return [bin, ...(noExtensions ? ["--no-extensions"] : []), "-e", extensionPath, ...rest];
}

const GATE_INSTANCE = Symbol.for("pi-review-gate.instance");

/**
 * May THIS copy of the gate register itself in this process? (D11)
 *
 * `-e` alone is not enough: without `--no-extensions` pi also loads the copy
 * the settings register, dedupes only by canonical path, and runs BOTH copies'
 * handlers. pi loads CLI extensions first, so the first copy to ask is the one
 * the pane was opened with; every other path stands down. Keyed by path, not
 * by a bare flag, so a `/reload` of the same copy in the same process passes.
 */
export function claimGateInstance(
  path: string = OWN_GATE_EXTENSION,
  store: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>,
): boolean {
  const winner = store[GATE_INSTANCE];
  if (typeof winner === "string" && winner !== path) return false;
  store[GATE_INSTANCE] = path;
  return true;
}

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
  return { label: judgePaneLabel(role, owner), windowName: judgeWindowName(role), colorSeed: judgeId, state };
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
  return { label: paneIdentity({ what: workerId, owner }), windowName: workerWindowName(workerId), colorSeed: workerId, state };
}
