/**
 * THE JUDGE'S PANE — opening, closing and probing the tmux pane one review
 * lives in.
 *
 * A judge round used to be a `pi -p` one-shot process. It is now an
 * interactive pi in its own pane (one pane per review), opened by whoever
 * owns the review — the opener recorded in lib/hierarchy.ts. The pane is the
 * CARRIER, the round is the task: consecutive re-review rounds of one review
 * reuse the pane, and only a finished review object (READY / abandoned / a
 * new review object) gets its pane reclaimed.
 *
 * WHY A MODULE AND NOT INLINE TMUX IN THE EXTENSION. The rule is the same
 * one the orchestration side obeys: the session that WANTS a pane never
 * assembles a tmux command (philosophy one). Every argv comes from
 * lib/orchestrator-tmux.ts builders, every colour/title string from
 * lib/orchestrator-pane-decor.ts — this file only sequences them.
 *
 * FAIL-CLOSED WITHOUT tmux. There is no fallback to the retired `pi -p`
 * path: a judge that could not be given a pane is a judge that did not run.
 * Decoration failing is the opposite: it degrades to a warning and never
 * fails the spawn (a border colour must not decide whether a review runs).
 *
 * Pure-ish: tmux enters through the injected {@link JudgePaneRunner}, so
 * every branch runs with a fake instead of a terminal.
 */
import {
  buildKillPaneArgv,
  buildListPanesArgv,
  buildPaneStyleArgv,
  buildPaneTitleArgv,
  buildSpawnPaneArgv,
  parsePaneIds,
  parseSpawnedPaneId,
} from "./orchestrator-tmux.ts";
import {
  paneStyleFor,
  paneTitleFor,
} from "./orchestrator-pane-decor.ts";

/** Who opened this judge — read by the judge-side gate from its own env. */
export const JUDGE_OPENER_ENV = "RG_JUDGE_OPENER";
/** This judge's id — the channel key and the pane's resume key. */
export const JUDGE_ID_ENV = "RG_JUDGE_ID";
/** reviewer | adviser | goal-auditor. */
export const JUDGE_ROLE_ENV = "RG_JUDGE_ROLE";

/** One tmux invocation through the injected runner. */
export interface JudgePaneRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run one tmux argv; never a shell string. */
export type JudgePaneRunner = (argv: readonly string[]) => JudgePaneRunResult;

/** Flags every judge pane carries: read-only review contract, same as the retired process path. */
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
 * No task file: the transcript already holds every round. The opener
 * re-drives the round through its own wait/submit once the pane is back.
 */
export function buildJudgeRecoverCommand(sessionId: string, piBin = "pi"): string[] {
  return [piBin, "--exclude-tools", "edit,write", "--session-id", sessionId];
}

/** Stable border label for a judge pane: `@review-<role>`. */
export function judgePaneLabel(role: string): string {
  const safe = role.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 20) || "review";
  return `@review-${safe}`;
}

export interface OpenJudgePaneOpts {
  /** The opener's OWN pane — the new pane splits off it, horizontally. */
  ownPane: string;
  /** Working directory for the new pane (the reviewed repo's root). */
  cwd: string;
  /** Judge session id — the resume key across rounds and recoveries. */
  sessionId: string;
  /** Judge id (hierarchy registry key), for the stable border colour. */
  judgeId: string;
  /** reviewer | adviser | goal-auditor, for the border label. */
  role: string;
  /** Full pi argv the pane runs (built by the caller: spawn vs recover). */
  command: readonly string[];
  /** Pane environment (opener id, judge id, role…). */
  env?: Readonly<Record<string, string>>;
}

export type OpenJudgePaneOutcome =
  | { ok: true; paneId: string; decorWarning?: string }
  | { ok: false; error: string };

/**
 * Open one judge pane. Pane ids come back from tmux itself (`-P -F
 * '#{pane_id}'), never from listing-and-diffing.
 */
export function openJudgePane(
  run: JudgePaneRunner,
  opts: OpenJudgePaneOpts,
): OpenJudgePaneOutcome {
  let spawned: JudgePaneRunResult;
  try {
    spawned = run(buildSpawnPaneArgv({
      orchestratorPane: opts.ownPane,
      cwd: opts.cwd,
      env: opts.env,
      command: opts.command,
    }));
  } catch (error) {
    return { ok: false, error: `review-gate: 开 review pane 失败 —— ${(error as Error).message}` };
  }
  if (!spawned.ok) {
    return { ok: false, error: `review-gate: 开 review pane 失败 —— ${spawned.stderr || "tmux split-window 失败"}` };
  }
  const paneId = parseSpawnedPaneId(spawned.stdout);
  if (!paneId) {
    return { ok: false, error: "review-gate: 开 review pane 失败 —— tmux 没有返回新 pane id。" };
  }
  // Decoration is cosmetic: it degrades to a warning, never to a failure.
  try {
    const style = run(buildPaneStyleArgv(paneId, paneStyleFor(opts.judgeId)));
    const title = run(buildPaneTitleArgv(
      paneId,
      paneTitleFor({ label: judgePaneLabel(opts.role), state: "working" }),
    ));
    const failed = [style, title].find((r) => !r.ok);
    if (failed) {
      return { ok: true, paneId, decorWarning: `pane 装饰失败（仅显示降级）：${failed.stderr || "tmux select-pane 失败"}` };
    }
  } catch (error) {
    return { ok: true, paneId, decorWarning: `pane 装饰失败（仅显示降级）：${(error as Error).message}` };
  }
  return { ok: true, paneId };
}

/** Close ONE judge pane. Panes only — never a window, never a session. */
export function closeJudgePane(
  run: JudgePaneRunner,
  paneId: string,
): { ok: true } | { ok: false; error: string } {
  try {
    const result = run(buildKillPaneArgv(paneId));
    if (!result.ok) {
      return { ok: false, error: `review-gate: 关 review pane 失败 —— ${result.stderr || "tmux kill-pane 失败"}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `review-gate: 关 review pane 失败 —— ${(error as Error).message}` };
  }
}

/**
 * Which panes exist right now. `undefined` means the list itself is
 * unreadable — missing information, never evidence of death.
 */
export function listJudgePanes(run: JudgePaneRunner, ownPane: string): string[] | undefined {
  try {
    const result = run(buildListPanesArgv(ownPane));
    if (!result.ok) return undefined;
    return parsePaneIds(result.stdout);
  } catch {
    return undefined;
  }
}

/** Is this pane still alive? Unreadable list ⇒ undefined (never "dead"). */
export function judgePaneAlive(
  run: JudgePaneRunner,
  ownPane: string,
  paneId: string,
): boolean | undefined {
  const panes = listJudgePanes(run, ownPane);
  if (panes === undefined) return undefined;
  return panes.includes(paneId);
}
