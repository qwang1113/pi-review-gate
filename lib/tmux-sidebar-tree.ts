/**
 * FROM PANE ROWS TO THE TREE THE SIDEBAR DRAWS (2026-09-27, s1).
 *
 *   repo group
 *   └─ pi session            (a pane carrying `@rg_sid`)
 *      └─ its child windows  (panes of a dedicated `rg-…` session whose
 *                             `@rg_scope_owner` is that session's id)
 *         └─ …and theirs     (an orchestration child opens its own judges)
 *   其他                      (sessions with no pi pane at all)
 *
 * The link from a child to its opener is the marker the gate already writes on
 * every dedicated session — nothing new has to be kept in sync. A child whose
 * opener is gone is still shown, at the top of its group, and says so.
 *
 * Pure: rows and a clock in, a tree out.
 */

import { basename } from "node:path";

import type { ChildState } from "./orchestrator-child-state.ts";
import type { PaneRow } from "./tmux-sidebar-collect.ts";
import { PANE_STATE_STALE_S } from "./tmux-pane-state.ts";

/** Where Enter / a click takes the client. */
export interface JumpTarget {
  session: string;
  windowId: string;
  paneId: string;
}

export interface SidebarNode {
  label: string;
  /** Undefined ⇒ the pane reports nothing (an older build, or still booting). */
  state?: ChildState;
  /** Its opener was expected (a marker names it) but is not on the server. */
  orphan?: boolean;
  target: JumpTarget;
  children: SidebarNode[];
}

export interface SidebarTree {
  /** Rows in `waiting-input`, anywhere in the tree. */
  waiting: number;
  groups: { repo: string; nodes: SidebarNode[] }[];
  others: { session: string; windows: number; target: JumpTarget }[];
}

const KNOWN_STATES: ReadonlySet<string> = new Set([
  "working", "waiting-input", "waiting-judge", "done", "idle", "mode-changed", "dead", "stalled",
]);

/** The word a row shows: its own, or `stalled` once the reporter went quiet. */
export function rowState(row: PaneRow, nowSec: number): ChildState | undefined {
  if (!KNOWN_STATES.has(row.state)) return undefined;
  const at = Number(row.stateAt);
  if (Number.isFinite(at) && at > 0 && nowSec - at > PANE_STATE_STALE_S) return "stalled";
  return row.state as ChildState;
}

function targetOf(row: PaneRow): JumpTarget {
  return { session: row.session, windowId: row.windowId, paneId: row.paneId };
}

/** A gate child window says what it is; a top-level session says its name or kind. */
function labelOf(row: PaneRow, isChild: boolean): string {
  if (isChild) return row.windowName || row.kind || row.paneId;
  if (row.sessionName) return row.sessionName;
  return `${row.kind || "pi"} ${row.session}:${row.windowIndex}`;
}

export function buildSidebarTree(rows: readonly PaneRow[], nowSec: number): SidebarTree {
  const panes = rows.filter((row) => !row.sidebar);
  // A pi session is a pane that says who it is; a gate window that does not
  // (yet) still belongs to its opener through the session marker.
  const members = panes.filter((row) => row.sid || row.scopeOwner);
  const bySid = new Map<string, PaneRow>();
  for (const row of members) if (row.sid && !bySid.has(row.sid)) bySid.set(row.sid, row);

  /** The opener a row hangs under — never itself, never its own descendant. */
  const parentOf = (row: PaneRow): PaneRow | undefined => {
    if (!row.scopeOwner || row.scopeOwner === row.sid) return undefined;
    const parent = bySid.get(row.scopeOwner);
    if (!parent) return undefined;
    // Walk up from the parent: meeting this row again means a cycle.
    let cursor: PaneRow | undefined = parent;
    for (let depth = 0; cursor && depth < 32; depth += 1) {
      if (cursor === row) return undefined;
      cursor = cursor.scopeOwner && cursor.scopeOwner !== cursor.sid ? bySid.get(cursor.scopeOwner) : undefined;
    }
    return parent;
  };

  const nodes = new Map<PaneRow, SidebarNode>();
  for (const row of members) {
    const parent = parentOf(row);
    const state = rowState(row, nowSec);
    nodes.set(row, {
      label: labelOf(row, parent !== undefined || row.scopeOwner !== ""),
      ...(state === undefined ? {} : { state }),
      ...(parent === undefined && row.scopeOwner !== "" && row.scopeOwner !== row.sid ? { orphan: true } : {}),
      target: targetOf(row),
      children: [],
    });
  }

  const groups = new Map<string, SidebarNode[]>();
  for (const row of members) {
    const node = nodes.get(row)!;
    const parent = parentOf(row);
    if (parent) {
      nodes.get(parent)!.children.push(node);
      continue;
    }
    const repo = basename(row.repo) || "(未知 repo)";
    const list = groups.get(repo) ?? [];
    list.push(node);
    groups.set(repo, list);
  }

  let waiting = 0;
  const count = (node: SidebarNode): void => {
    if (node.state === "waiting-input") waiting += 1;
    node.children.forEach(count);
  };
  for (const list of groups.values()) list.forEach(count);

  const piSessions = new Set(members.map((row) => row.session));
  const others = new Map<string, { windows: Set<string>; target: JumpTarget }>();
  for (const row of panes) {
    if (piSessions.has(row.session)) continue;
    const entry = others.get(row.session) ?? { windows: new Set<string>(), target: targetOf(row) };
    entry.windows.add(row.windowId);
    others.set(row.session, entry);
  }

  return {
    waiting,
    groups: [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([repo, list]) => ({ repo, nodes: list })),
    others: [...others.entries()].map(([session, entry]) => ({
      session,
      windows: entry.windows.size,
      target: entry.target,
    })),
  };
}
