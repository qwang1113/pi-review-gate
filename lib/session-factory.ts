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
 * forgets. So the steps stop being callers' business. {@link openSessionWindow}
 * performs the whole sequence — open the window (splitting the user's window
 * only for a relay), register, decorate, verify — in one fixed order, and the
 * callers express only WHAT they want opened.
 *
 * ── WHERE A SESSION LANDS (2026-09-25, user decision) ──
 *
 * A child is a WINDOW of the opener's own dedicated tmux session
 * (`rg-<repo>-<id tail>`, lib/session-tmux-scope.ts), created lazily the first
 * time a child is needed. The user's window is left exactly as it was: the
 * three-column layout planning, the geometry probe and the equaliser that used
 * to squeeze panes into it are DELETED, not bypassed. The one exception is the
 * RELAY ({@link buildHandoffPaneArgv}): a successor orchestrator splits off the
 * opener's own pane, because that is the spot the human is already watching.
 *
 * ── WHAT IS NOT HERE ──
 *
 * tmux argv construction stays in lib/orchestrator-tmux.ts (this module and
 * lib/session-tmux-scope.ts are its only consumers — one for a child's window,
 * one for the session itself), the colour/label/title STRINGS stay in
 * lib/orchestrator-pane-decor.ts, and the role prompt/tool policy stays in
 * lib/gate-modes.ts. The pane's identity and environment (a cross-process
 * contract) live in lib/session-env.ts, and the judge argv plus the judge /
 * worker border in lib/session-launch-specs.ts. This module sequences them; it
 * invents nothing.
 *
 * Pure-ish: tmux enters through the injected {@link TmuxRunner} and delivery
 * evidence through an injected probe, so every branch runs with fakes.
 */

import {
  buildHandoffPaneArgv,
  buildKillPaneArgv,
  buildPaneLabelArgv,
  buildPaneStyleArgv,
  buildShowPaneLabelsArgv,
  parseSpawnedPaneId,
  type TmuxRunner,
  type TmuxRunResult,
} from "./orchestrator-tmux.ts";
import { buildKillWindowArgv } from "./tmux-session-argv.ts";
import {
  openScopeWindow,
  pinOwnSession,
  type TmuxScope,
} from "./session-tmux-scope.ts";
import {
  paneStyleFor,
  paneTitleFor,
  PANE_BORDER_FORMAT,
  PANE_BORDER_STATUS,
} from "./orchestrator-pane-decor.ts";
import type { ChildState } from "./orchestrator-child-state.ts";
import { buildSessionEnv, type SessionPaneRole } from "./session-env.ts";
import { mkdirSync } from "node:fs";


// ---------------------------------------------------------------------------
// Decoration — identical for every kind of pane (C1)
// ---------------------------------------------------------------------------

/** Everything the border says about a pane. */
export interface SessionPaneDecor {
  /** `t2@pm:title` for a child, `reviewer@t6` for a judge. */
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
  run: TmuxRunner,
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
  attempt(buildPaneLabelArgv(paneId, paneTitleFor({
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
 * Repaint one pane's label, and the only writer of one.
 *
 * WHAT IT IS FOR NOW (2026-09-22): the STATE and its age. It used to be the
 * fix for C2 as well — pi overwrote `pane_title` after boot, so a label written
 * at spawn was gone within seconds and only a repaint brought it back — and
 * that half is gone with the move to the `@rg_label` pane option
 * (lib/orchestrator-tmux.ts `buildPaneLabelArgv`), which pi does not touch. The
 * label still has to age (`waiting-judge 220s`), so the repaint stays, shared
 * by judges and children alike.
 *
 * The state comes from the CHANNEL projection at the call site — never from a
 * screen. Returns whether tmux was actually asked to paint.
 */
export function refreshSessionPaneTitle(
  run: TmuxRunner,
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
  paintPaneTitle(run, opts.paneId, title);
  return true;
}

/**
 * Write one pane's title, once, with NO memory and NO throttle — the only
 * place a title reaches tmux.
 *
 * It exists for the ONE pane whose label cannot be deduplicated: the project
 * manager's OWN pane (`pm:<dir>`), which carries no state and therefore no
 * changing string to diff against. The caller repaints it unconditionally,
 * which costs one tmux call per probe for one pane; the reason it HAD to be
 * unconditional (pi rewriting `pane_title` at boot and on every extension
 * rebind, dist/modes/interactive/interactive-mode.js `updateTerminalTitle`) is
 * gone now that the label is a pane option pi never writes, so this could be
 * memoised the day that one call matters. Failures are swallowed the same way:
 * this is a cosmetic layer, and a pane that works is worth more than a border
 * that is right.
 */
export function paintPaneTitle(run: TmuxRunner, paneId: string, title: string): void {
  try {
    run(buildPaneLabelArgv(paneId, title));
  } catch {
    /* cosmetic only — never allowed to affect supervision */
  }
}

/**
 * Close ONE WINDOW the gate itself opened (谁创建谁回收) — the normal path since
 * 2026-09-25, when a child session became a window of the opener's own session.
 *
 * `kill-window` rather than `kill-pane`, and nothing else: panes are not
 * created, split or equalised here any more. There is no label bar to take down
 * either, for the reason it is turned on in the first place — a child's bar is
 * an option of the CHILD'S window, which stops existing with the child.
 *
 * The window id alone is not enough to address it: the target is built as
 * `<ownSession>:<@id>` from the coordinates the registry recorded at spawn, so a
 * stale id can only ever reach a window of the gate's own session
 * (lib/orchestrator-tmux.ts `buildKillWindowArgv`).
 */
export function closeSessionWindow(
  run: TmuxRunner,
  coords: { ownSession: string; windowId: string },
): { ok: true } | { ok: false; error: string } {
  try {
    const result = run(buildKillWindowArgv(coords.ownSession, coords.windowId));
    if (!result.ok) {
      return { ok: false, error: result.stderr || "tmux kill-window 失败" };
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  return { ok: true };
}

/**
 * Did this close failure mean “it is already gone” rather than “tmux refused”?
 *
 * ONE READING FOR EVERY CLOSE PATH (2026-09-25, quality round P2).
 * `orchestrator_close` had this regex inline and `worker_close` had nothing at
 * all, so the same fact was reported two different ways — and the worker path's
 * version told a caller a window might still be on screen when it had simply
 * been closed already, while leaving the coordinates in the registry forever.
 * The distinction belongs beside the close it describes.
 */
export function windowAlreadyGone(error: string | undefined): boolean {
  return /can't find window|no such window|no server running/i.test(error ?? "");
}

/**
 * Close ONE PANE — the RELAY path, and after 2026-09-25 the only one.
 *
 * The predecessor's own pane is not a session window: it is the rectangle in
 * the USER'S window where the retiring session sits, and the successor was
 * split off it. It is closed by the session that occupies it, once the
 * successor has demonstrably taken over; a `kill-window` there would take the
 * successor with it.
 */
export function closeSessionPane(
  run: TmuxRunner,
  paneId: string,
): { ok: true } | { ok: false; error: string } {
  try {
    const result = run(buildKillPaneArgv(paneId));
    if (!result.ok) {
      return { ok: false, error: result.stderr || "tmux kill-pane 失败" };
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  return { ok: true };
}

/**
 * How many of these decorated panes are still ON SCREEN.
 *
 * DELETED WITH ITS ONLY CALLER (2026-09-17, user decision). It answered that
 * question for the label-bar release, and the release is gone: the bar is
 * turned on by whoever opens a decorated pane and is never turned off, because
 * toggling `pane-border-status` resizes every pane in the window (measured:
 * SIGWINCH, rows 84 ↔ 83).
 */

// ---------------------------------------------------------------------------
// Opening a pane
// ---------------------------------------------------------------------------

/**
 * Where a new session goes.
 *
 * TWO LAYOUTS, and the second one is a deliberate exception the user chose
 * (2026-09-25): a relay successor keeps the old behaviour — beside its
 * predecessor, in the user's own window — because a handover is the human's
 * seat changing hands, not another child session. Everything else is a window
 * of the opener's own tmux session.
 */
export type SessionPaneLayout =
  /** A window of the opener's own session (lib/session-tmux-scope.ts). */
  | "own-session-window"
  /** Beside the opener, in the user's window — the relay path only. */
  | "beside-opener";

/** Delivery verification: did the far side actually come up? */
export interface DeliveryProof {
  ok: boolean;
  /** One line for the caller's receipt — the summary or the reason. */
  detail: string;
}

/**
 * The coordinates a child is addressed by later.
 *
 * `windowId` is what closes it and `sessionName` is the session that owns it
 * (the pair is what keeps a kill inside the gate's own session). Both are
 * ABSENT for the relay layout, whose pane lives in the user's window and is
 * closed by nobody but its own occupant (lib/orchestrator-tmux.ts
 * `buildKillPaneArgv`).
 */
export interface SessionPaneCoords {
  paneId: string;
  windowId?: string;
  sessionName?: string;
}

export interface SessionPaneSpec {
  /** The opener's OWN tmux session — created lazily by the first child. */
  scope: TmuxScope;
  cwd: string;
  layout: SessionPaneLayout;
  role: SessionPaneRole;
  /** The full argv the child runs (an interactive pi, built by the caller). */
  command: readonly string[];
  /**
   * The opener's OWN pane — REQUIRED for the relay layout, which splits it, and
   * ignored by the window layout, which never touches the user's window.
   */
  ownPane?: string;
  /** Omitted ⇒ undecorated (a successor orchestrator owns no border). */
  decor?: SessionPaneDecor;
  /**
   * Record the new coordinates BEFORE anything else looks for them.
   * Registration is a step, not a caller's afterthought: delivery evidence is
   * polled after it, and an unregistered child is unaddressable by every later
   * tool.
   */
  register?: (coords: SessionPaneCoords) => void;
  /** Earn the receipt. Omitted ⇒ nothing to verify (a successor has no channel). */
  verify?: (paneId: string) => Promise<DeliveryProof>;
}

export type SessionPaneOutcome =
  | ({ ok: true; decorWarning?: string; deliveryNote?: string } & SessionPaneCoords)
  | ({
      ok: false;
      error: string;
      /** Set when the child EXISTS and was kept: verification is what failed. */
      deliveryFailed?: boolean;
    } & Partial<SessionPaneCoords>);

/**
 * Open one child session, in the fixed order every caller shares:
 * open → register → decorate → verify.
 *
 * The order is the point. Registering before verification is what keeps a
 * child addressable when its delivery check fails (it may well be alive and
 * merely slow), and decorating before verification means the window a human is
 * about to look at is already labelled while the gate is still waiting on
 * evidence.
 *
 * Coordinates come back from tmux itself (`-P -F '#{window_id} #{pane_id}'`),
 * never from listing-and-diffing.
 */
export async function openSessionWindow(
  run: TmuxRunner,
  spec: SessionPaneSpec,
): Promise<SessionPaneOutcome> {
  const env = buildSessionEnv(spec.role);
  // THE SCRATCH ROOT HAS TO EXIST BEFORE THE CHILD USES IT (reviewer P1,
  // 2026-09-14). `TMPDIR` is the judge's throwaway-worktree root, and anything
  // that allocates a temporary directory through it (`mktemp -d`, mkdtemp)
  // fails with ENOENT when the directory is not there — including a reviewer
  // making its own scratch space. Creating it here covers every way a judge
  // window is opened (spawn, rotation, recover), and it is the same directory
  // `reapReviewScratch` removes when the window goes: whoever creates it clears
  // it. Only roles whose env carries a TMPDIR are touched, and a failure is
  // not worth refusing the child over — a judge with an unusable scratch dir
  // can still review (it just cannot build throwaway worktrees under it).
  const scratch = env.TMPDIR;
  if (scratch) {
    try { mkdirSync(scratch, { recursive: true }); } catch { /* best effort */ }
  }
  // WHAT ANOTHER SESSION WILL INHERIT IS PINNED (2026-09-27): a successor adopts
  // the judges in this session's dedicated session, and `orchestrator_attach`
  // adopts a dead manager's children — in both cases the owner's death is
  // expected, and the crash sweep must not read it as a crash.
  if (spec.role.kind === "successor") {
    const pinned = pinOwnSession(run, spec.scope, "handed-off");
    if (!pinned.ok) return { ok: false, error: `交接前未能铉住专属 session：${pinned.error}` };
  }
  const coords = spec.layout === "beside-opener"
    ? openRelayPane(run, spec, env)
    : openScopeWindow(run, spec.scope, {
        ...(spec.role.kind === "orchestration-child" ? { pin: "orchestration-child" } : {}),
        cwd: spec.cwd,
        env,
        command: spec.command,
        // THE WINDOW NAME IS THE LABEL (user decision, 2026-09-25). `tmux ls`
        // and `prefix w` are the only ways to see a child without attaching to
        // it, and a list of identical `pi` entries tells nobody anything.
        ...(spec.decor === undefined ? {} : { windowName: spec.decor.label }),
      });
  if (!coords.ok) {
    // A FAILED OPEN YIELDS NO COORDINATES, and there is nothing to keep
    // (2026-09-25, quality round P2): both openers return `{ok:false; error}`
    // and nothing else, so the `"paneId" in coords` carry-forward that used to
    // sit here could only ever produce `{}`. The case it LOOKED like it handled
    // — opened, but the delivery check failed — is the `deliveryFailed` branch
    // below, which has real coordinates to keep.
    return { ok: false, error: coords.error };
  }
  // EXPLICIT FIELDS, never a spread of the scope's own result (2026-09-25):
  // that result carries an `ok` of its own, and spreading it here silently
  // overwrote the outcome of a FAILED delivery check with `ok: true` — caught
  // by the failure-path test, which is why the coordinates are copied by hand.
  const place: SessionPaneCoords = {
    paneId: coords.paneId,
    ...(coords.windowId === undefined ? {} : { windowId: coords.windowId }),
    ...(coords.sessionName === undefined ? {} : { sessionName: coords.sessionName }),
  };
  spec.register?.(place);
  const decorWarning = spec.decor ? decorateSessionPane(run, place.paneId, spec.decor) : undefined;
  if (spec.verify) {
    const proof = await spec.verify(place.paneId);
    if (!proof.ok) {
      return { ok: false, error: proof.detail, ...place, deliveryFailed: true };
    }
    return {
      ok: true,
      ...place,
      ...(decorWarning === undefined ? {} : { decorWarning }),
      deliveryNote: proof.detail,
    };
  }
  return { ok: true, ...place, ...(decorWarning === undefined ? {} : { decorWarning }) };
}

/**
 * Split the opener's OWN pane for a relay successor — the one path that still
 * touches the user's window (user decision, 2026-09-25).
 *
 * No window id comes back, and that is correct rather than an omission: this
 * child lives in the user's window, is never closed by `kill-window`, and is
 * replaced by its own successor when it retires.
 */
function openRelayPane(
  run: TmuxRunner,
  spec: SessionPaneSpec,
  env: Readonly<Record<string, string>>,
): ({ ok: true } & SessionPaneCoords) | { ok: false; error: string } {
  const ownPane = spec.ownPane;
  if (!ownPane) {
    return { ok: false, error: "接力后继者需要 opener 自己的 pane 作落点（ownPane 缺失）" };
  }
  let spawned: TmuxRunResult;
  try {
    spawned = run(buildHandoffPaneArgv({ orchestratorPane: ownPane, cwd: spec.cwd, env, command: spec.command }));
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
  return { ok: true, paneId };
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
