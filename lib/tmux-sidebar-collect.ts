/**
 * THE SIDEBAR'S ONE READ (2026-09-27, s1): every pane on the server, with the
 * options the gate's sessions write about themselves (lib/tmux-pane-state.ts)
 * and the marker a dedicated session carries (`@rg_scope_owner`,
 * lib/tmux-session-argv.ts). A user option named in a pane format resolves
 * pane → window → session, so the session's marker and the window's
 * `@rg_session_name` arrive on every pane row without a second call.
 *
 * Pure: the argv and the parser. The script (scripts/tmux-sidebar.ts) runs it.
 */

import {
  PANE_KIND_OPTION,
  PANE_REPO_OPTION,
  PANE_SID_OPTION,
  PANE_STATE_AT_OPTION,
  PANE_STATE_OPTION,
} from "./tmux-pane-state.ts";
import { SESSION_NAME_OPTION, SESSION_OWNER_OPTION } from "./tmux-session-argv.ts";

/** The pane option that marks a sidebar pane, so it never lists itself. */
export const SIDEBAR_PANE_OPTION = "@rg_sidebar";

/** One pane, as the sidebar sees it. Empty strings are "not set". */
export interface PaneRow {
  session: string;
  windowId: string;
  windowIndex: string;
  windowName: string;
  paneId: string;
  sid: string;
  repo: string;
  kind: string;
  state: string;
  stateAt: string;
  scopeOwner: string;
  sessionName: string;
  sidebar: boolean;
}

const FIELDS: readonly (keyof PaneRow)[] = [
  "session", "windowId", "windowIndex", "windowName", "paneId",
  "sid", "repo", "kind", "state", "stateAt", "scopeOwner", "sessionName", "sidebar",
];

const FORMATS: readonly string[] = [
  "#{session_name}", "#{window_id}", "#{window_index}", "#{window_name}", "#{pane_id}",
  `#{${PANE_SID_OPTION}}`, `#{${PANE_REPO_OPTION}}`, `#{${PANE_KIND_OPTION}}`,
  `#{${PANE_STATE_OPTION}}`, `#{${PANE_STATE_AT_OPTION}}`,
  `#{${SESSION_OWNER_OPTION}}`, `#{${SESSION_NAME_OPTION}}`, `#{${SIDEBAR_PANE_OPTION}}`,
];

/** Tab-separated: none of the fields the gate writes can carry one. */
const SEP = "\t";

export function buildListAllPanesArgv(): readonly string[] {
  return ["list-panes", "-a", "-F", FORMATS.join(SEP)];
}

/** Parse what {@link buildListAllPanesArgv} printed; a short line is skipped. */
export function parsePaneRows(stdout: string): PaneRow[] {
  const rows: PaneRow[] = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const parts = line.split(SEP);
    if (parts.length < FIELDS.length) continue;
    // The window NAME is free-form: whatever overflows belongs to it.
    const extra = parts.length - FIELDS.length;
    const merged = [...parts.slice(0, 3), parts.slice(3, 4 + extra).join(SEP), ...parts.slice(4 + extra)];
    const get = (i: number): string => (merged[i] ?? "").trim();
    if (!get(4).startsWith("%")) continue;
    rows.push({
      session: get(0),
      windowId: get(1),
      windowIndex: get(2),
      windowName: get(3),
      paneId: get(4),
      sid: get(5),
      repo: get(6),
      kind: get(7),
      state: get(8),
      stateAt: get(9),
      scopeOwner: get(10),
      sessionName: get(11),
      sidebar: get(12) === "1",
    });
  }
  return rows;
}
