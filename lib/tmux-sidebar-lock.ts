/**
 * THE SIDEBAR'S INPUT LOCK (2026-09-27, t7): while a sidebar is open, every
 * other pane of its window has its input switched off (`select-pane -d`), so
 * a stray click or `prefix + arrow` cannot type into a session by accident.
 *
 * The panes WE switched off are recorded on the WINDOW (`@rg_sidebar_locked`,
 * a window option) — a pane that was already off before is never in that
 * list, so restoring (`select-pane -e`) gives back exactly what was there.
 * The record lives in tmux, not in the TUI process, and not on the sidebar
 * pane either: a TUI killed hard takes its pane with it, while the window
 * keeps the record, and the next `toggle` restores from it.
 *
 * Pure: argv and decisions. The script (scripts/tmux-sidebar.ts) runs them.
 */

import { SIDEBAR_PANE_OPTION } from "./tmux-sidebar-collect.ts";

/** The window option listing the panes a sidebar switched off. */
export const SIDEBAR_LOCKED_OPTION = "@rg_sidebar_locked";

const PANE_ID = /^%\d+$/;

/** One pane of the sidebar's window. */
export interface WindowPane {
  paneId: string;
  inputOff: boolean;
  sidebar: boolean;
}

/** A window as the lock sees it: its panes and the record it carries. */
export interface WindowLock {
  panes: WindowPane[];
  locked: string[];
}

/**
 * Every pane of `target`'s window. The record is a window option, and a user
 * option in a pane format resolves pane → window, so it rides on every row.
 */
export function buildWindowPanesArgv(target: string): readonly string[] {
  return [
    "list-panes", "-t", target, "-F",
    `#{pane_id}\t#{pane_input_off}\t#{${SIDEBAR_PANE_OPTION}}\t#{${SIDEBAR_LOCKED_OPTION}}`,
  ];
}

export function decodeLocked(value: string): string[] {
  return String(value ?? "").split(",").map((id) => id.trim()).filter((id) => PANE_ID.test(id));
}

export function parseWindowPanes(stdout: string): WindowLock {
  const panes: WindowPane[] = [];
  let locked: string[] = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const [paneId = "", off = "", mark = "", record = ""] = line.split("\t").map((part) => part.trim());
    if (!PANE_ID.test(paneId)) continue;
    panes.push({ paneId, inputOff: off === "1", sidebar: mark === "1" });
    if (panes.length === 1) locked = decodeLocked(record);
  }
  return { panes, locked };
}

/**
 * What to switch off now, and the record afterwards. A pane whose input is
 * already off is left alone — either we locked it on an earlier pass, or the
 * user did, and then it is not ours to give back. Panes that have gone drop
 * out of the record. `record` is undefined when it did not change.
 */
export function planLock(window: WindowLock, sidebarId: string): { lock: string[]; record?: string } {
  const present = new Set(window.panes.map((p) => p.paneId));
  const lock = window.panes.filter((p) => p.paneId !== sidebarId && !p.sidebar && !p.inputOff).map((p) => p.paneId);
  const after = [...window.locked.filter((id) => present.has(id)), ...lock];
  return after.join(",") === window.locked.join(",") ? { lock } : { lock, record: after.join(",") };
}

export function lockArgv(paneId: string): readonly string[] {
  return ["select-pane", "-d", "-t", paneId];
}

export function unlockArgv(paneId: string): readonly string[] {
  return ["select-pane", "-e", "-t", paneId];
}

/** `target` is any pane of the window — `-w` writes the window's option. */
export function recordArgv(target: string, record: string): readonly string[] {
  return ["set", "-w", "-t", target, SIDEBAR_LOCKED_OPTION, record];
}

/** Reads the window's record; its output goes through {@link decodeLocked}. */
export function readRecordArgv(target: string): readonly string[] {
  return ["display-message", "-p", "-t", target, `#{${SIDEBAR_LOCKED_OPTION}}`];
}

/** Everything that gives the recorded panes their input back, record cleared last. */
export function restoreArgvs(target: string, locked: readonly string[]): (readonly string[])[] {
  return [...locked.map(unlockArgv), ["set", "-w", "-u", "-t", target, SIDEBAR_LOCKED_OPTION]];
}
