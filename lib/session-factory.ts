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
 * RELAY (the host's `openBeside`): a successor orchestrator splits off the
 * opener's own pane, because that is the spot the human is already watching.
 * Under the desktop host the same two placements are `own-group` and
 * `beside-opener` (docs/desktop/host-protocol.md §6).
 *
 * ── WHAT IS NOT HERE ──
 *
 * HOW a window is opened, labelled and closed is the HOST's (lib/gate-host.ts:
 * tmux windows in lib/gate-host-tmux.ts, desktop sessions in
 * lib/gate-host-desktop.ts, 2026-09-30) — the ORDER is this module's, and it
 * is the same for both. The colour/label/title STRINGS stay in
 * lib/orchestrator-pane-decor.ts, and the role prompt/tool policy stays in
 * lib/gate-modes.ts. The pane's identity and environment (a cross-process
 * contract) live in lib/session-env.ts, and the judge argv plus the judge /
 * worker border in lib/session-launch-specs.ts. This module sequences them; it
 * invents nothing.
 *
 * Pure-ish: the host enters as an injected {@link GateHost} and delivery
 * evidence through an injected probe, so every branch runs with fakes.
 */

import { paneTitleFor } from "./orchestrator-pane-decor.ts";
import type { GateHost } from "./gate-host.ts";
import type { ChildState } from "./orchestrator-child-state.ts";
import { buildSessionEnv, type SessionPaneRole } from "./session-env.ts";
import { mkdirSync } from "node:fs";
import { withGateExtension } from "./session-launch-specs.ts";


// ---------------------------------------------------------------------------
// Decoration — identical for every kind of pane (C1)
// ---------------------------------------------------------------------------

/** Everything the border says about a pane. */
export interface SessionPaneDecor {
  /** `t2@pm:title` for a child, `reviewer@t6` for a judge. */
  label: string;
  /**
   * The tmux WINDOW name (`reviewer`, `worker-x`, `s1-tmux-sidebar`) — the
   * owner half is left out because the session name already says it.
   * Absent ⇒ the label.
   */
  windowName?: string;
  /** What the colour hashes on — the child id or the judge id. */
  colorSeed: string;
  state: ChildState;
  stateForSeconds?: number;
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
 * screen. Returns whether the host was actually asked to paint.
 */
export function refreshSessionPaneTitle(
  host: Pick<GateHost, "paintLabel">,
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
  host.paintLabel(opts.paneId, title);
  return true;
}

/**
 * Did this close failure mean “it is already gone” rather than “tmux refused”?
 *
 * ONE READING FOR EVERY CLOSE PATH (2026-09-25, quality round P2).
 * `orchestrator_close` had this regex inline and `worker_close` had nothing at
 * all, so the same fact was reported two different ways — and the worker path's
 * version told a caller a window might still be on screen when it had simply
 * been closed already, while leaving the coordinates in the registry forever.
 * The distinction belongs beside the close it describes. (The desktop host's
 * close is idempotent: a session already gone is simply `ok`.)
 */
export function windowAlreadyGone(error: string | undefined): boolean {
  return /can't find window|no such window|no server running/i.test(error ?? "");
}

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
 * of the opener's own session.
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
 * closed by nobody but its own occupant (the host's `closePane`).
 */
export interface SessionPaneCoords {
  paneId: string;
  windowId?: string;
  sessionName?: string;
}

export interface SessionPaneSpec {
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
 * Coordinates come back from the host itself (tmux: `-P -F '#{window_id}
 * #{pane_id}'`; desktop: the `session.open` result), never from
 * listing-and-diffing.
 */
export async function openSessionWindow(
  host: GateHost,
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
    const pinned = host.pinChildren("handed-off");
    if (!pinned.ok) return { ok: false, error: `交接前未能铉住专属 session：${pinned.error}` };
  }
  const command = withGateExtension(spec.command);
  let coords;
  if (spec.layout === "beside-opener") {
    coords = spec.ownPane
      ? host.openBeside({ ownPane: spec.ownPane, cwd: spec.cwd, env, command, role: spec.role })
      : { ok: false as const, error: "接力后继者需要 opener 自己的 pane 作落点（ownPane 缺失）" };
  } else {
    coords = host.openWindow({
      ...(spec.role.kind === "orchestration-child" ? { pin: "orchestration-child" } : {}),
      cwd: spec.cwd,
      env,
      command,
      role: spec.role,
      // THE WINDOW NAME IS THE LABEL (user decision, 2026-09-25). `tmux ls`
      // and `prefix w` are the only ways to see a child without attaching to
      // it, and a list of identical `pi` entries tells nobody anything.
      ...(spec.decor === undefined ? {} : { windowName: spec.decor.windowName ?? spec.decor.label }),
    });
  }
  if (!coords.ok) {
    // A FAILED OPEN YIELDS NO COORDINATES, and there is nothing to keep
    // (2026-09-25, quality round P2). The case it LOOKED like it handled —
    // opened, but the delivery check failed — is the `deliveryFailed` branch
    // below, which has real coordinates to keep.
    return { ok: false, error: coords.error };
  }
  // EXPLICIT FIELDS, never a spread of the host's own result (2026-09-25):
  // that result carries an `ok` of its own, and spreading it here silently
  // overwrote the outcome of a FAILED delivery check with `ok: true` — caught
  // by the failure-path test, which is why the coordinates are copied by hand.
  const place: SessionPaneCoords = {
    paneId: coords.paneId,
    ...(coords.windowId === undefined ? {} : { windowId: coords.windowId }),
    ...(coords.sessionName === undefined ? {} : { sessionName: coords.sessionName }),
  };
  spec.register?.(place);
  const decorWarning = spec.decor ? host.decorate(place.paneId, spec.decor) : undefined;
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
  /** The host is unreadable: missing information is never evidence of death. */
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
  /** true / false / undefined = the host unreadable. */
  paneAlive?: boolean | undefined;
}): RecoverabilityCode {
  if (!input.registered) return "unknown";
  if (input.closedAt) return "closed";
  if (!input.paneId) return "no-pane";
  if (input.paneAlive === true) return "alive";
  if (input.paneAlive === undefined) return "unknown-liveness";
  return "recoverable";
}
