/**
 * THE SIDEBAR'S SCREEN (2026-09-27, s1): the tree as lines of a fixed width,
 * which line jumps where, and how selection and clicks map onto them.
 *
 * Pure: a tree and a viewport in, ANSI lines out. The script only writes them.
 */

import type { ChildState } from "./orchestrator-child-state.ts";
import type { JumpTarget, SidebarNode, SidebarTree } from "./tmux-sidebar-tree.ts";

/** One line on screen; `target` ⇒ it can be selected and jumped to. */
export interface SidebarLine {
  text: string;
  target?: JumpTarget;
  /** Colour hint for the painter. */
  tone?: "header" | "alert" | "group" | "waiting" | "muted";
}

const STATE_WORD: Readonly<Record<ChildState, string>> = {
  "working": "working",
  "idle": "idle",
  "waiting-input": "等你回答",
  "waiting-judge": "等 judge",
  "done": "done",
  "stalled": "stalled",
  "dead": "dead",
  "mode-changed": "mode",
};

/** Display width: CJK and full-width forms take two columns. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return width;
}

/** Cut to `width` columns, marking the cut with `…`. */
export function fitWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  let out = "";
  for (const ch of text) {
    if (displayWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** `label ……… state`, the state right-aligned so a column of them scans. */
function row(indent: number, label: string, state: string, width: number): string {
  const pad = " ".repeat(indent);
  const room = width - indent - (state ? displayWidth(state) + 1 : 0);
  const name = fitWidth(label, Math.max(1, room));
  const gap = Math.max(1, width - indent - displayWidth(name) - displayWidth(state));
  return state ? `${pad}${name}${" ".repeat(gap)}${state}` : `${pad}${name}`;
}

/** Every line of the tree, top to bottom, before any scrolling. */
export function sidebarLines(tree: SidebarTree, width: number): SidebarLine[] {
  const lines: SidebarLine[] = [];
  lines.push(tree.waiting > 0
    ? { text: fitWidth(` 等你回答 ${tree.waiting}`, width), tone: "alert" }
    : { text: fitWidth(" pi 会话", width), tone: "header" });
  const walk = (node: SidebarNode, depth: number): void => {
    const state = node.state === undefined ? "" : STATE_WORD[node.state];
    const label = `${node.orphan ? "⚠ " : ""}${node.label}`;
    lines.push({
      text: row(1 + depth * 2, label, state, width),
      target: node.target,
      ...(node.state === "waiting-input" ? { tone: "waiting" as const } : node.orphan ? { tone: "muted" as const } : {}),
    });
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const group of tree.groups) {
    lines.push({ text: fitWidth(`─ ${group.repo}`, width), tone: "group" });
    for (const node of group.nodes) walk(node, 0);
  }
  if (tree.others.length > 0) {
    lines.push({ text: fitWidth("─ 其他", width), tone: "group" });
    for (const other of tree.others) {
      lines.push({ text: row(1, other.session, `${other.windows}w`, width), target: other.target, tone: "muted" });
    }
  }
  return lines;
}

/** The selectable line nearest `from` in `delta`'s direction (stays put at an end). */
export function moveSelection(lines: readonly SidebarLine[], from: number, delta: 1 | -1): number {
  for (let i = from + delta; i >= 0 && i < lines.length; i += delta) {
    if (lines[i].target) return i;
  }
  return from;
}

/** Keep a selection on a selectable line after the tree changed under it. */
export function clampSelection(lines: readonly SidebarLine[], selected: number): number {
  if (lines[selected]?.target) return selected;
  const down = moveSelection(lines, Math.min(selected, lines.length) - 1, 1);
  if (lines[down]?.target) return down;
  const up = moveSelection(lines, lines.length, -1);
  return lines[up]?.target ? up : 0;
}

/** Scroll so the selection is visible in `height` rows. */
export function scrollFor(selected: number, scroll: number, height: number): number {
  if (selected < scroll) return selected;
  if (selected >= scroll + height) return selected - height + 1;
  return Math.max(0, scroll);
}

/** The line a click on screen row `y` (1-based, SGR) lands on, if any. */
export function lineAtClick(lines: readonly SidebarLine[], y: number, scroll: number): number | undefined {
  const index = scroll + y - 1;
  return index >= 0 && index < lines.length && lines[index].target ? index : undefined;
}

const TONE: Readonly<Record<NonNullable<SidebarLine["tone"]>, string>> = {
  header: "\x1b[1m",
  alert: "\x1b[1;30;43m",
  group: "\x1b[1;34m",
  waiting: "\x1b[33m",
  muted: "\x1b[2m",
};

/** The visible window of lines, painted; the selection in reverse video. */
export function paintLines(
  lines: readonly SidebarLine[],
  opts: { width: number; height: number; selected: number; scroll: number },
): string[] {
  const out: string[] = [];
  for (let i = opts.scroll; i < Math.min(lines.length, opts.scroll + opts.height); i += 1) {
    const line = lines[i];
    const text = line.text + " ".repeat(Math.max(0, opts.width - displayWidth(line.text)));
    const tone = line.tone ? TONE[line.tone] : "";
    const select = i === opts.selected && line.target ? "\x1b[7m" : "";
    out.push(`${tone}${select}${text}\x1b[0m`);
  }
  return out;
}
