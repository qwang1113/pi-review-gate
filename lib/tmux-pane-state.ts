/**
 * WHAT THIS PANE IS DOING, written where tmux can show it (2026-09-27, s1).
 *
 * Every pi session — loop, project manager, orchestration child, judge,
 * worker — writes a handful of PANE user options onto its own pane, and the
 * sidebar (lib/tmux-sidebar-*.ts) reads them back with one `list-panes -a`.
 * Nothing else is shared: no file, no socket, no registry to keep in sync.
 *
 *   @rg_sid       this session's pi session id  (links a child window to its opener
 *                 through the session's `@rg_scope_owner` marker)
 *   @rg_repo      the primary repo root          (the sidebar groups by it)
 *   @rg_kind      loop | orchestrator | child | judge | worker …
 *   @rg_state     a {@link ChildState} word      (the orchestration vocabulary)
 *   @rg_state_at  epoch seconds of the last write (older than {@link PANE_STATE_STALE_S} ⇒ `stalled`)
 *
 * `set -p` only, never `-g`: the options live on ONE pane, the session's own.
 *
 * ── WHY ITS OWN 5s CLOCK ──
 *
 * The naming heartbeat is 30s, and "waiting for your answer" that shows up
 * half a minute late is the one row the sidebar exists for. The reporter
 * writes only when the word CHANGED or {@link PANE_STATE_REFRESH_MS} passed, so
 * a quiet session costs one tmux call per 30s.
 */

import { decideReportedChildState } from "./orchestrator-child-channel.ts";
import type { ChildState } from "./orchestrator-child-state.ts";
import { assertSafeTmuxArgv, requirePane, type TmuxRunner } from "./orchestrator-tmux.ts";

export const PANE_SID_OPTION = "@rg_sid";
export const PANE_REPO_OPTION = "@rg_repo";
export const PANE_KIND_OPTION = "@rg_kind";
export const PANE_STATE_OPTION = "@rg_state";
export const PANE_STATE_AT_OPTION = "@rg_state_at";

export const PANE_STATE_TICK_MS = 5_000;
export const PANE_STATE_REFRESH_MS = 30_000;
/** Three missed refreshes: the pane is still there, the reporter is not. */
export const PANE_STATE_STALE_S = 90;

type PaneOption =
  | typeof PANE_SID_OPTION
  | typeof PANE_REPO_OPTION
  | typeof PANE_KIND_OPTION
  | typeof PANE_STATE_OPTION
  | typeof PANE_STATE_AT_OPTION;

/** The facts the word is decided from, read live on every tick. */
export interface PaneStateFacts {
  /** A gate dialog is on screen (lib/gate-dialogs.ts `dialogsOnScreen`). */
  dialogOpen: boolean;
  /** Blocked on a judge round this session started. */
  judging: boolean;
  /** The agent is streaming or has messages queued. */
  streaming: boolean;
  /** `declare_done` was accepted. */
  completed: boolean;
}

/**
 * The word, by the SAME precedence an orchestration child reports with
 * (lib/orchestrator-child-channel.ts) — an open dialog forces `waiting-input`.
 */
export function decidePaneState(facts: PaneStateFacts): ChildState {
  return decideReportedChildState({
    ...(facts.dialogOpen ? { forced: "waiting-input" as const } : {}),
    judging: facts.judging,
    streaming: facts.streaming,
    waitingOnBackground: false,
    ...(facts.completed ? { completedAt: "done" } : {}),
  });
}

/** Printable, short, and nothing tmux would expand when a format renders it. */
function safeValue(value: string): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/#/g, "").slice(0, 256);
}

/** `set -p -t <pane> <option> <value>` — one pane, never global. */
export function buildSetPaneOptionArgv(pane: string, option: PaneOption, value: string): readonly string[] {
  return assertSafeTmuxArgv(["set", "-p", "-t", requirePane(pane, "pane"), option, safeValue(value)]);
}

/** `set -pu`: take an option back when the session ends. */
export function buildUnsetPaneOptionArgv(pane: string, option: PaneOption): readonly string[] {
  return assertSafeTmuxArgv(["set", "-pu", "-t", requirePane(pane, "pane"), option]);
}

export interface PaneStateDeps {
  run: TmuxRunner;
  /** `$TMUX_PANE`, or undefined outside tmux (then nothing is written). */
  pane(): string | undefined;
  identity(): { sessionId: string | undefined; repo: string; kind: string };
  facts(): PaneStateFacts;
  now?: () => number;
}

export interface PaneStateReporter {
  tick(): void;
  /** Remove every option this reporter wrote (process exit). */
  clear(): void;
}

export function createPaneStateReporter(deps: PaneStateDeps): PaneStateReporter {
  const now = deps.now ?? (() => Date.now());
  let written: { pane: string; word: ChildState; at: number; identity: string } | undefined;

  const set = (pane: string, option: PaneOption, value: string): boolean => {
    try {
      return deps.run(buildSetPaneOptionArgv(pane, option, value)).ok;
    } catch {
      return false;
    }
  };

  return {
    tick(): void {
      const pane = deps.pane();
      if (pane === undefined) return;
      const word = decidePaneState(deps.facts());
      const at = now();
      const id = deps.identity();
      const identity = `${id.sessionId ?? ""}\n${id.repo}\n${id.kind}`;
      const due = written === undefined
        || written.pane !== pane
        || written.word !== word
        || at - written.at >= PANE_STATE_REFRESH_MS;
      if (!due && written?.identity === identity) return;
      // Identity first: a row the sidebar cannot place is worse than a late one.
      if (written?.identity !== identity || written.pane !== pane) {
        if (id.sessionId) set(pane, PANE_SID_OPTION, id.sessionId);
        set(pane, PANE_REPO_OPTION, id.repo);
        set(pane, PANE_KIND_OPTION, id.kind);
      }
      const ok = set(pane, PANE_STATE_OPTION, word) && set(pane, PANE_STATE_AT_OPTION, String(Math.floor(at / 1000)));
      // A failed write is retried on the next tick rather than remembered.
      written = ok ? { pane, word, at, identity } : undefined;
    },

    clear(): void {
      const pane = written?.pane ?? deps.pane();
      written = undefined;
      if (pane === undefined) return;
      for (const option of [PANE_STATE_OPTION, PANE_STATE_AT_OPTION, PANE_SID_OPTION, PANE_REPO_OPTION, PANE_KIND_OPTION] as const) {
        try { deps.run(buildUnsetPaneOptionArgv(pane, option)); } catch { /* best effort at exit */ }
      }
    },
  };
}
