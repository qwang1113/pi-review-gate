/**
 * THE SIDEBAR'S PREVIEW (2026-09-27, t7): the right-hand side of the sidebar
 * shows the selected row's pane as plain text (`capture-pane -p`, no colour —
 * the user's choice), cut to the room there is and put beside the list.
 *
 * Pure: argv and text. The script (scripts/tmux-sidebar.ts) captures and draws.
 */

import { fitWidth } from "./tmux-sidebar-render.ts";

/** Columns the list keeps; the rest of the sidebar (60% of the window) previews. */
export const LIST_WIDTH = 30;
/** Below this many columns a preview is not worth drawing. */
const MIN_PREVIEW = 10;

export function buildCaptureArgv(paneId: string): readonly string[] {
  return ["capture-pane", "-p", "-t", paneId];
}

/** How the sidebar's `columns` split: the list, and the preview (0 ⇒ none). */
export function splitColumns(columns: number): { list: number; preview: number } {
  const list = Math.min(LIST_WIDTH, columns);
  const preview = columns - list - 1;
  return preview >= MIN_PREVIEW ? { list, preview } : { list: columns, preview: 0 };
}

/**
 * The bottom of what was captured — that is where a terminal's latest output
 * is — with the trailing blank rows dropped, every row cut to `width`, and
 * control characters removed so nothing captured can move the cursor.
 */
export function previewLines(captured: string, width: number, height: number): string[] {
  const rows = String(captured ?? "").split(/\r?\n/).map((row) => row.replace(/[\x00-\x1f\x7f]/g, " ").trimEnd());
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows.slice(Math.min(rows.length, Math.max(0, rows.length - height))).map((row) => fitWidth(row, width));
}

/**
 * The list and the preview side by side, `height` rows. `left` rows are
 * already painted to `listWidth` columns (paintLines pads them); a missing one
 * is blank. The divider is dim so it reads as chrome, not content.
 */
export function joinColumns(left: readonly string[], right: readonly string[], listWidth: number, height: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < height; i += 1) {
    out.push(`${left[i] ?? " ".repeat(listWidth)}\x1b[2m│\x1b[0m${right[i] ?? ""}`);
  }
  return out;
}
