/**
 * SESSION FACTORY — the one place a pi session is given a pane.
 *
 * ── WHY THIS MODULE EXISTS ──
 *
 * "Open a pi session in a role" was never one act: it is a tmux split, an
 * identity (session id, cwd, the environment that tells the far side WHAT it
 * is), a registration, a channel to reach it on, a border that says which
 * rectangle is which, and — since the receipt must be earned — proof that the
 * process actually came up. Six call sites did all of that separately
 * (judge round dispatch, judge_spawn, judge_recover, orchestrator_spawn,
 * orchestrator_recover, orchestrator_handoff), and the divergence between them
 * was not theoretical:
 *
 *  - C1: a judge pane got a colour but never the WINDOW option that renders
 *    the border line, because turning it on lived in the orchestration spawn
 *    only. With no project manager in the window, nobody ever turned it on and
 *    the label was invisible.
 *  - C2: a judge pane's title was written once at spawn and then overwritten by
 *    pi itself, because the "repaint on every health reading" loop also lived
 *    on the orchestration side only.
 *  - Delivery verification (does the far side actually exist?) existed for
 *    orchestration children and not for judges — the one kind of session whose
 *    silence deadlocks its opener.
 *
 * Each of those is the same defect: a step that one caller performs and another
 * forgets. So the steps stop being callers' business. {@link openSessionPane}
 * performs the whole sequence — spawn, register, decorate, verify — in one
 * fixed order, and the callers express only WHAT they want opened.
 *
 * ── WHAT IS NOT HERE ──
 *
 * tmux argv construction stays in lib/orchestrator-tmux.ts (this module is its
 * only consumer), the colour/label/title STRINGS stay in
 * lib/orchestrator-pane-decor.ts, and the role prompt/tool policy stays in
 * lib/gate-modes.ts. This module sequences them; it invents nothing.
 *
 * ── THE ENVIRONMENT IS A CROSS-PROCESS CONTRACT ──
 *
 * {@link buildSessionEnv} is the ONLY place a pane's environment is assembled,
 * and every variable in it is read by a DIFFERENT process running a DIFFERENT
 * build of this extension: `RG_JUDGE_*` by the judge side (lib/judge-side.ts),
 * `RG_ORCHESTRATION_ID` / `RG_STATE_VARIANT` by an orchestration child's own
 * gate. Two of them additionally decide whether the session-exclusivity guard
 * lets the pane live at all (a judge is exempt because it carries `RG_JUDGE_*`,
 * an orchestration child because it carries a non-empty `RG_STATE_VARIANT`), so
 * a dropped variable does not degrade a feature — it kills the pane at boot.
 * Names and value semantics are frozen; tests pin the key set per role.
 *
 * Pure-ish: tmux enters through the injected {@link PaneRunner} and delivery
 * evidence through an injected probe, so every branch runs with fakes.
 */

import {
  buildHandoffPaneArgv,
  buildKillPaneArgv,
  buildHidePaneLabelsArgv,
  buildPaneStyleArgv,
  buildPaneTitleArgv,
  buildShowPaneLabelsArgv,
  buildSpawnPaneArgv,
  parseSpawnedPaneId,
} from "./orchestrator-tmux.ts";
import {
  paneStyleFor,
  paneTitleFor,
  PANE_BORDER_FORMAT,
  PANE_BORDER_STATUS,
} from "./orchestrator-pane-decor.ts";
import type { ChildState } from "./orchestrator-child-state.ts";
import { JUDGE_ID_ENV, JUDGE_OPENER_ENV, JUDGE_ROLE_ENV } from "./judge-pane.ts";
import { JUDGE_STREAM_ENV, JUDGE_TASK_ENV } from "./judge-side.ts";
import { STATE_VARIANT_ENV } from "./gate-state.ts";
import { ORCHESTRATION_ID_ENV } from "./orchestration-id.ts";
import { GATE_MODE_ENV } from "./task-mode.ts";

/** One tmux invocation through the injected runner. */
export interface PaneRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run one tmux argv; never a shell string. */
export type PaneRunner = (argv: readonly string[]) => PaneRunResult;

// ---------------------------------------------------------------------------
// Identity: what a pane IS, and the environment that tells it so
// ---------------------------------------------------------------------------

/**
 * The three kinds of session the gate opens. They differ in what the far side
 * reads out of its environment, and in nothing else — layout, decoration and
 * verification are separate axes of {@link SessionPaneSpec} precisely so that
 * "a judge is decorated like a child" cannot drift back apart.
 */
export type SessionPaneRole =
  | {
      kind: "judge";
      openerId: string;
      judgeId: string;
      role: string;
      /** Round-1 task file, when the opener passed one (judge_spawn does). */
      taskPath?: string;
      /** This round's findings stream, when there is one. */
      streamPath?: string;
    }
  | {
      kind: "orchestration-child";
      orchestrationId: string;
      /** Its OWN gate sidecar variant — also its exclusivity-guard exemption. */
      stateVariant: string;
    }
  | {
      kind: "successor";
      /** A relay hands over its own inheritance env, built by the relay module. */
      env: Readonly<Record<string, string>>;
    };

/**
 * The pane's environment. One assembly point for a cross-process contract:
 * see the module header for why a missing key here is fatal rather than
 * cosmetic.
 */
export function buildSessionEnv(role: SessionPaneRole): Record<string, string> {
  if (role.kind === "judge") {
    return {
      [JUDGE_OPENER_ENV]: role.openerId,
      [JUDGE_ID_ENV]: role.judgeId,
      [JUDGE_ROLE_ENV]: role.role,
      ...(role.taskPath === undefined ? {} : { [JUDGE_TASK_ENV]: role.taskPath }),
      ...(role.streamPath === undefined ? {} : { [JUDGE_STREAM_ENV]: role.streamPath }),
    };
  }
  if (role.kind === "orchestration-child") {
    return {
      // Wake-ups are addressed to the ORCHESTRATION, so they keep arriving
      // after a relay — the whole point of the id.
      [ORCHESTRATION_ID_ENV]: role.orchestrationId,
      // An ordinary loop session, told so explicitly rather than left to
      // classify itself into something else.
      [GATE_MODE_ENV]: "loop",
      // Its OWN gate sidecar, so supervisor and worker never overwrite each
      // other's mode, Q&A record and unmet-gate list.
      [STATE_VARIANT_ENV]: role.stateVariant,
    };
  }
  return { ...role.env };
}

// ---------------------------------------------------------------------------
// Decoration — identical for every kind of pane (C1)
// ---------------------------------------------------------------------------

/** Everything the border says about a pane. */
export interface SessionPaneDecor {
  /** `@t2-title` for a child, `@review-reviewer` for a judge. */
  label: string;
  /** What the colour hashes on — the child id or the judge id. */
  colorSeed: string;
  state: ChildState;
  stateForSeconds?: number;
}

/**
 * Colour, title, AND the window option that renders the border line.
 *
 * THE THIRD STEP IS THE FIX FOR C1. Turning `pane-border-status` on used to be
 * the orchestration spawn's private business, so a judge pane opened by an
 * ordinary loop session had a colour nobody could see. It is a window-level
 * option shared by every pane in the window, which is exactly why it must be
 * set by whoever opens a decorated pane rather than by one privileged caller.
 *
 * Failure is ALWAYS cosmetic: a session that works is worth more than a
 * coloured border, so this returns a warning and never an error.
 */
export function decorateSessionPane(
  run: PaneRunner,
  paneId: string,
  decor: SessionPaneDecor,
): string | undefined {
  const failures: string[] = [];
  const attempt = (argv: readonly string[]): void => {
    try {
      const result = run(argv);
      if (!result.ok) failures.push(result.stderr || argv.join(" "));
    } catch (error) {
      failures.push((error as Error).message);
    }
  };
  attempt(buildPaneStyleArgv(paneId, paneStyleFor(decor.colorSeed)));
  attempt(buildPaneTitleArgv(paneId, paneTitleFor({
    label: decor.label,
    state: decor.state,
    ...(decor.stateForSeconds === undefined ? {} : { stateForSeconds: decor.stateForSeconds }),
  })));
  for (const argv of buildShowPaneLabelsArgv(paneId, PANE_BORDER_STATUS, PANE_BORDER_FORMAT)) {
    attempt(argv);
  }
  // The WORDING matters as much as the fact: a bare tmux stderr in a receipt
  // reads like the session failed. Every caller pastes this straight into its
  // reply, so the "display only" framing belongs here rather than in each of
  // them (the retired openJudgePane wrapped it; nothing else did).
  return failures.length === 0
    ? undefined
    : `pane 装饰失败（仅显示降级）：${failures[0]}`;
}

/** What a repaint remembers, so an unchanged title is not re-painted. */
export interface PaneTitleMemory {
  get(key: string): { title: string; at: number } | undefined;
  set(key: string, value: { title: string; at: number }): void;
}

/**
 * Shortest gap between two repaints of the same pane.
 *
 * The wait loops probe every couple of seconds and the title carries a SECONDS
 * counter, so comparing rendered strings would never dedupe anything: without a
 * floor, decoration would fork a tmux process per pane per probe.
 */
export const PANE_REPAINT_MIN_MS = 5_000;

/** Panes repainted by callers that keep no memory of their own (judges). */
const DEFAULT_TITLE_MEMORY: PaneTitleMemory = new Map<string, { title: string; at: number }>();

/**
 * Repaint one pane's title — THE fix for C2, and the only title writer.
 *
 * pi overwrites the pane title with its own after boot, so a title written once
 * at spawn is gone within seconds. The cure is the one the orchestration side
 * already had: rewrite it from every health reading. Judges now share this
 * function, so a judge border ages exactly like a child's one.
 *
 * The state comes from the CHANNEL projection at the call site — never from a
 * screen. Returns whether tmux was actually asked to paint.
 */
export function refreshSessionPaneTitle(
  run: PaneRunner,
  opts: {
    paneId: string;
    label: string;
    state: ChildState;
    stateForSeconds?: number;
    now: number;
    /** Repaint memory; omitted ⇒ this module's own (per-pane) memory. */
    memory?: PaneTitleMemory;
  },
): boolean {
  const title = paneTitleFor({
    label: opts.label,
    state: opts.state,
    ...(opts.stateForSeconds === undefined ? {} : { stateForSeconds: opts.stateForSeconds }),
  });
  const memory = opts.memory ?? DEFAULT_TITLE_MEMORY;
  const painted = memory.get(opts.paneId);
  if (painted && painted.title === title) return false;
  if (painted && opts.now - painted.at < PANE_REPAINT_MIN_MS) return false;
  memory.set(opts.paneId, { title, at: opts.now });
  try {
    run(buildPaneTitleArgv(opts.paneId, title));
  } catch {
    /* cosmetic only — never allowed to affect supervision */
  }
  return true;
}

/**
 * Close one pane the gate itself opened (谁创建谁回收).
 *
 * `hideLabelsVia` takes the window-level label bar down first, and it takes a
 * pane id to ADDRESS THE WINDOW WITH — not a boolean, on purpose (reviewer P2,
 * 2026-09-05). `setw -t <pane>` uses the pane only to name a window, and the
 * pane being closed is the one id that may already be gone: a user who closed
 * the review pane by hand leaves a registry row whose id tmux no longer knows,
 * the option write fails, and the bar stays switched on in the user's window
 * forever. The CALLER'S OWN pane is in the same window and is provably alive —
 * the caller is running in it.
 *
 * Passing it also expresses the decision: labels come down only when the
 * caller has established that this is the last decorated pane (see
 * `releasesWindowLabels`); undoing them while a sibling still needs them
 * blanks a border that is in use.
 */
export function closeSessionPane(
  run: PaneRunner,
  paneId: string,
  opts: { hideLabelsVia?: string } = {},
): { ok: true } | { ok: false; error: string } {
  if (opts.hideLabelsVia) {
    for (const argv of buildHidePaneLabelsArgv(opts.hideLabelsVia)) {
      try { run(argv); } catch { /* cosmetic */ }
    }
  }
  try {
    const result = run(buildKillPaneArgv(paneId));
    if (!result.ok) {
      return { ok: false, error: result.stderr || "tmux kill-pane 失败" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * How many of these decorated panes are still ON SCREEN.
 *
 * The registry outlives panes — one the user closed by hand is a row and
 * nothing else — so "how many rows are there" is the wrong count for deciding
 * whether the window's label bar may come down (it never would).
 *
 * An UNREADABLE pane list counts every candidate as present, and that
 * direction is deliberate: keeping the bar up costs a stale border line that
 * the next spawn re-establishes anyway, while taking it down over a live
 * sibling blanks a border somebody is reading.
 */
export function countDecoratedPanes(
  paneIds: readonly string[],
  livePanes: readonly string[] | undefined,
): number {
  if (livePanes === undefined) return paneIds.length;
  return paneIds.filter((id) => livePanes.includes(id)).length;
}


/**
 * May THIS close take the window's label bar down with it?
 *
 * WHY THE QUESTION EXISTS AT ALL. `pane-border-status` / `pane-border-format`
 * are WINDOW options: every pane in the window shares them, including panes
 * this session never opened. Turning them on is what makes a decorated border
 * visible (C1); leaving them on forever is litter in the user's window, and
 * turning them off while a sibling is still labelled blanks a border that is
 * still in use. So it is released by the LAST decorated pane, and only by a
 * session that owns them.
 *
 * "Owns them" is the second half, and it is not a detail. Two facts decide it,
 * and each was measured as a defect on its own (2026-09-05):
 *
 *  - a session that is only a GUEST in an orchestration's window cannot see
 *    the manager's panes at all (they live in another session's registry), so
 *    it can never know it is the last one and never releases;
 *  - a MANAGER can see them — they are its own children — so it counts them
 *    with `countDecoratedPanes` like any other decorated pane, instead of
 *    being exempted by role.
 *
 * All five close paths (judge_close, declare_done's cascade, judge_spawn's
 * rollback, a `fresh` round's pre-kill, orchestrator_close) ask exactly this.
 */
export function releasesWindowLabels(input: {
  /** Panes THIS session decorated that are still open once this one is gone. */
  remainingDecoratedPanes: number;
  /** True when an orchestration owns this window's label bar. */
  insideOrchestration: boolean;
}): boolean {
  return !input.insideOrchestration && input.remainingDecoratedPanes === 0;
}

// ---------------------------------------------------------------------------
// Opening a pane
// ---------------------------------------------------------------------------

/** Where the new pane goes. */
export type SessionPaneLayout =
  /** The child column: first child splits the opener, later ones stack under. */
  | "child-column"
  /** Beside the opener (a relay successor, which inherits the left column). */
  | "beside-opener";

/** Delivery verification: did the far side actually come up? */
export interface DeliveryProof {
  ok: boolean;
  /** One line for the caller's receipt — the summary or the reason. */
  detail: string;
}

export interface SessionPaneSpec {
  /** The opener's OWN pane — every layout is expressed relative to it. */
  ownPane: string;
  cwd: string;
  layout: SessionPaneLayout;
  /** Stack under this one instead of splitting the opener (child column). */
  lastChildPane?: string;
  role: SessionPaneRole;
  /** The full argv the pane runs (an interactive pi, built by the caller). */
  command: readonly string[];
  /** Omitted ⇒ undecorated (a successor orchestrator owns no border). */
  decor?: SessionPaneDecor;
  /**
   * Record the new pane BEFORE anything else looks for it. Registration is a
   * step, not a caller's afterthought: delivery evidence is polled after it,
   * and an unregistered pane is unaddressable by every later tool.
   */
  register?: (paneId: string) => void;
  /** Earn the receipt. Omitted ⇒ nothing to verify (a successor has no channel). */
  verify?: (paneId: string) => Promise<DeliveryProof>;
}

export type SessionPaneOutcome =
  | { ok: true; paneId: string; decorWarning?: string; deliveryNote?: string }
  | {
      ok: false;
      error: string;
      /** Set when the pane EXISTS and was kept: verification is what failed. */
      paneId?: string;
      deliveryFailed?: boolean;
    };

/**
 * Open one pane, in the fixed order every caller now shares:
 * spawn → register → decorate → verify.
 *
 * The order is the point. Registering before verification is what keeps a
 * pane addressable when its delivery check fails (the pane may well be alive
 * and merely slow), and decorating before verification means a pane a human is
 * staring at is already labelled while the gate is still waiting on evidence.
 *
 * Pane ids come back from tmux itself (`-P -F '#{pane_id}'`), never from
 * listing-and-diffing.
 */
export async function openSessionPane(
  run: PaneRunner,
  spec: SessionPaneSpec,
): Promise<SessionPaneOutcome> {
  const env = buildSessionEnv(spec.role);
  let spawned: PaneRunResult;
  try {
    spawned = run(spec.layout === "beside-opener"
      ? buildHandoffPaneArgv({
          orchestratorPane: spec.ownPane,
          cwd: spec.cwd,
          env,
          command: spec.command,
        })
      : buildSpawnPaneArgv({
          orchestratorPane: spec.ownPane,
          ...(spec.lastChildPane === undefined ? {} : { lastChildPane: spec.lastChildPane }),
          cwd: spec.cwd,
          env,
          command: spec.command,
        }));
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (!spawned.ok) {
    return { ok: false, error: spawned.stderr || "tmux split-window 失败" };
  }
  const paneId = parseSpawnedPaneId(spawned.stdout);
  if (!paneId) {
    return { ok: false, error: "tmux 没有返回新 pane id" };
  }
  spec.register?.(paneId);
  const decorWarning = spec.decor ? decorateSessionPane(run, paneId, spec.decor) : undefined;
  if (spec.verify) {
    const proof = await spec.verify(paneId);
    if (!proof.ok) {
      return { ok: false, error: proof.detail, paneId, deliveryFailed: true };
    }
    return {
      ok: true,
      paneId,
      ...(decorWarning === undefined ? {} : { decorWarning }),
      deliveryNote: proof.detail,
    };
  }
  return { ok: true, paneId, ...(decorWarning === undefined ? {} : { decorWarning }) };
}

// ---------------------------------------------------------------------------
// Recovery — one judgement, two tools
// ---------------------------------------------------------------------------

/** Why a recovery may not proceed, or that it may. */
export type RecoverabilityCode =
  /** Nothing was ever registered under that handle. */
  | "unknown"
  /** It was closed on purpose — a new session is the answer, not a recovery. */
  | "closed"
  /** No pane was ever recorded: it never came up, so there is nothing to re-open. */
  | "no-pane"
  /** The pane is alive — re-opening would put two processes in one worktree. */
  | "alive"
  /** tmux is unreadable: missing information is never evidence of death. */
  | "unknown-liveness"
  /** Dead pane, live record: re-open it under the same session id. */
  | "recoverable";

/**
 * THE recovery judgement, shared by `judge_recover` and
 * `orchestrator_recover`.
 *
 * The two tools speak to different audiences and keep their own wording, but
 * the DECISION — refuse a live pane, refuse an unknown handle, refuse when
 * liveness is unreadable, otherwise re-open under the same id — is one
 * function, so the pair can no longer drift into two slightly different
 * safeties. Pure: facts in, a code out.
 */
export function paneRecoverability(input: {
  /** Is there a registry record at all? */
  registered: boolean;
  /** Set when the record says the session was closed deliberately. */
  closedAt?: string | undefined;
  /** The recorded pane id, when one was ever recorded. */
  paneId?: string | undefined;
  /** true / false / undefined = tmux unreadable. */
  paneAlive?: boolean | undefined;
}): RecoverabilityCode {
  if (!input.registered) return "unknown";
  if (input.closedAt) return "closed";
  if (!input.paneId) return "no-pane";
  if (input.paneAlive === true) return "alive";
  if (input.paneAlive === undefined) return "unknown-liveness";
  return "recoverable";
}

// ---------------------------------------------------------------------------
// Judge argv + label (moved here from lib/judge-pane.ts: they describe how a
// judge pane is OPENED, which is this module's job. What stayed there is the
// cross-process env contract and pane-liveness probing.)
// ---------------------------------------------------------------------------

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

/** Stable border label for a judge pane: `@review-<role>`. */
export function judgePaneLabel(role: string): string {
  const safe = role.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 20) || "review";
  return `@review-${safe}`;
}

/** The decoration a judge pane gets — the same shape a child gets. */
export function judgePaneDecor(judgeId: string, role: string, state: ChildState = "working"): SessionPaneDecor {
  return { label: judgePaneLabel(role), colorSeed: judgeId, state };
}
