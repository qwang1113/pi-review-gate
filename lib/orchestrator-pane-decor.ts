/**
 * WHICH PANE IS WHICH — colour, label, and the state written on the border.
 *
 * ── WHY THE GATE DOES THIS AT ALL ──
 *
 * A window with four `pi` panes in it is four identical black rectangles. The
 * user asked (2026-08-30) for each child to be recognizable at a glance, and
 * the honest reading of that request is that IDENTITY ALONE IS NOT ENOUGH: a
 * border that says only `@t1-user-interaction` still forces a human (or an
 * orchestrator) to call `orchestrator_wait` to learn what that pane is doing.
 * So the border carries the state and how long it has lasted —
 * `@t1-user-interaction · waiting-judge 220s` — and the supervision probe,
 * which already re-reads every channel on a timer, refreshes it for free.
 *
 * ── WHERE THIS IS ALLOWED TO LIVE (philosophy one and two, explicitly) ──
 *
 * The decoration is applied INSIDE `orchestrator_spawn`, as one more of the
 * atomic things that call already does (create the pane, create the worktree,
 * write the task file, register the child), and undone inside
 * `orchestrator_close`. The user stated both halves of that as hard criteria
 * (2026-08-30):
 *
 *   1. it is NOT a tool and NOT an action — a presentation feature must never
 *      grow the tool set back (philosophy two);
 *   2. it is NOT "spawn returns, then the caller decorates" — not even with an
 *      internal helper. The orchestrator's call sequence is byte-for-byte what
 *      it was before this feature existed.
 *
 * Decoration failure is therefore ALWAYS a downgrade to a note, never an
 * error: a session that works is worth more than a coloured border, and a
 * spawn that failed because tmux refused a cosmetic option would be the worst
 * possible trade.
 *
 * ── WHY IT CANNOT MEAN ANYTHING ──
 *
 * Nothing here is ever read back. The border is an OUTPUT of the channel
 * projection, never an input to it: no decision in this repository consults a
 * pane title, because that would be reading the screen again — the exact
 * mistake the 2026-08-30 rewrite removed. If the title is stale or missing,
 * every judgement is unchanged.
 *
 * Pure module: strings in, strings out. The argv lives in
 * lib/orchestrator-tmux.ts and the execution in the dispatch/lifecycle tools.
 */

import type { ChildHealth, ChildState } from "./orchestrator-child-state.ts";

/** One entry of the palette: what tmux is told, and what a human is told. */
export interface PaneColor {
  /** tmux colour token, e.g. `colour81`. */
  token: string;
  /** Readable name, so the receipt and the screen can be matched by eye. */
  name: string;
}

/**
 * The palette.
 *
 * Chosen from the 256-colour cube rather than the 8 base colours on purpose:
 * base colours are what the USER'S theme redefines, so `red` is whatever their
 * terminal says it is, while `colour209` is the same orange everywhere. They
 * are also all light-ish mid-tones, which stay legible on both dark and light
 * backgrounds — a border nobody can read is not an identifier.
 */
export const PANE_PALETTE: readonly PaneColor[] = Object.freeze([
  { token: "colour81", name: "青" },
  { token: "colour209", name: "橙" },
  { token: "colour114", name: "绿" },
  { token: "colour170", name: "紫" },
  { token: "colour221", name: "黄" },
  { token: "colour147", name: "蓝紫" },
  { token: "colour211", name: "粉" },
  { token: "colour180", name: "杏" },
]);

/**
 * FNV-1a over the child id.
 *
 * A HASH rather than "the next colour in the list" because the requirement is
 * that a child keeps its colour: the counter would have to be persisted, and
 * would drift the moment a registry was rebuilt, a session was recovered, or
 * an orchestration was taken over by a successor. A pure function of the id
 * cannot drift — the same child is the same colour in every process that ever
 * looks at it.
 */
export function paneColorFor(childId: string): PaneColor {
  let hash = 0x811c9dc5;
  for (let i = 0; i < childId.length; i++) {
    hash ^= childId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // FINAL AVALANCHE, and it is not decoration. FNV-1a's low bits barely move
  // between short, similar strings, and every real child id IS one of those
  // (`t1-mtf5kc1z`, `t2-mtf5kc3a`). Taking `hash % 8` straight off the raw
  // value put five consecutive children on two colours — measured — which is
  // exactly the "four identical rectangles" problem this exists to solve. The
  // mix folds the high bits down before the modulo, and stays a pure function.
  hash = (hash ^ (hash >>> 15)) >>> 0;
  hash = Math.imul(hash, 0x2545f491) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  return PANE_PALETTE[hash % PANE_PALETTE.length]!;
}


/** The tmux style string for a child's border (`select-pane -P`). */
export function paneStyleFor(childId: string): string {
  return `fg=${paneColorFor(childId).token}`;
}

/** Longest label kept: a border that wraps stops being a one-glance read. */
const LABEL_MAX = 28;

/**
 * The stable half of a pane title: `@<taskId>-<slugged title>`.
 *
 * The task id leads because that is what every tool argument names, and the
 * slug follows because `@t2` alone tells a human nothing at 3am. Non-ASCII
 * titles collapse to the id rather than being transliterated — a mangled
 * label is worse than a plain one.
 */
export function paneLabelFor(taskId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const label = slug ? `@${taskId}-${slug}` : `@${taskId}`;
  return label.length > LABEL_MAX ? label.slice(0, LABEL_MAX) : label;
}

/** How a state reads on a border — short, English, and never translated. */
function paneStateWord(state: ChildState): string {
  return state;
}

/**
 * The full pane title: identity, state, and the age of that state.
 *
 * Seconds up to ten minutes, then minutes. The threshold is set by what the
 * number is FOR: a review round runs for a few hundred seconds and the user's
 * own example of a healthy border is `waiting-judge 220s`, so seconds have to
 * survive well past the point where a naive "switch at two minutes" would
 * have rounded them away. Past ten minutes the question stops being "is it
 * moving" and becomes "how long has this been going on", which minutes answer
 * better.
 */
export function paneTitleFor(opts: {
  label: string;
  state: ChildState;
  stateForSeconds?: number;
}): string {
  const age = opts.stateForSeconds === undefined
    ? ""
    : opts.stateForSeconds < 600
      ? ` ${Math.max(0, Math.round(opts.stateForSeconds))}s`
      : ` ${Math.round(opts.stateForSeconds / 60)}m`;
  return `${opts.label} · ${paneStateWord(opts.state)}${age}`;
}


/** The title for a child whose health has just been measured. */
export function paneTitleForHealth(label: string, health: ChildHealth): string {
  return paneTitleFor({
    label,
    state: health.state,
    ...(health.stateForSeconds === undefined ? {} : { stateForSeconds: health.stateForSeconds }),
  });
}

/**
 * `pane-border-format`, in tmux's own syntax.
 *
 * `#{pane_title}` and nothing else: the title is already the whole message,
 * and every extra token here is a format string that could break on a tmux
 * version we did not test.
 */
export const PANE_BORDER_FORMAT = "#{pane_title}";

/** Where the label bar goes. `top` keeps it out of the status line. */
export const PANE_BORDER_STATUS = "top";

/**
 * Is this the LAST decorated child in the window?
 *
 * The window-level options (`pane-border-status`, `pane-border-format`) are
 * shared by every pane in the window, including the orchestrator's own and
 * any pane the user opened themselves. So they are unset only when the last
 * child this orchestration decorated is going away — undoing them while a
 * sibling is still running would blank the labels of panes that still need
 * them, and leaving them forever would be litter in the user's window.
 */
export function isLastDecoratedChild(
  children: readonly { id: string; closedAt?: string }[],
  closingChildId: string,
): boolean {
  return children.every((child) => child.id === closingChildId || Boolean(child.closedAt));
}

/** One line for the receipt, so a colour on screen matches a row in the text. */
export function formatPaneLegend(entries: readonly { childId: string; label: string }[]): string {
  if (entries.length === 0) return "";
  return entries
    .map((entry) => `${entry.label}（${paneColorFor(entry.childId).name}边框）= ${entry.childId}`)
    .join("；");
}
