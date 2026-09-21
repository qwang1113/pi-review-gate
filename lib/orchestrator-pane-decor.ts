/**
 * WHICH PANE IS WHICH — colour, label, and the state written on the border.
 *
 * ── WHY THE GATE DOES THIS AT ALL ──
 *
 * A window with four `pi` panes in it is four identical black rectangles. The
 * user asked (2026-08-30) for each child to be recognizable at a glance, and
 * the honest reading of that request is that IDENTITY ALONE IS NOT ENOUGH: a
 * border that says only `t1@pm:user-interaction` still forces a human (or an
 * orchestrator) to call `orchestrator_wait` to learn what that pane is doing.
 * So the border carries the state and how long it has lasted —
 * `t1@pm:user-interaction · waiting-judge 220s` — and the supervision probe,
 * which already re-reads every channel on a timer, refreshes it for free.
 *
 * ── THE IDENTITY GRAMMAR (2026-09-18, user decision) ──
 *
 * `<what>@<who started it>:<name>`, and the identity NEVER carries a space.
 * The user's own words: 「谁启动, 干什么, 中间最好不要有空格, 空间很宝贵」 — the two
 * facts they need at a glance, in the order that scans best, with no room
 * spent on padding. It replaced a grammar that carried neither: `@t6-eng-i18n-
 * ci-cd-review-ga` said nothing about who opened the pane, and a reviewer's
 * title was the role and nothing else — so two goal-auditors opened by
 * different sessions had IDENTICAL borders, the ambiguity the user hit in
 * their own window (measured: one window held two of them, one per opener,
 * with byte-identical titles).
 *
 * The owner is not a parameter anyone types: each opener derives it from its
 * OWN identity ({@link selfPaneOwner}) — the project manager is `pm`, an
 * orchestration child is its task id, and any other loop session is `self`.
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
 * ── THE LABEL BAR IS A WINDOW-LEVEL SHARED RESOURCE (2026-09-06) ──
 *
 * `PANE_BORDER_STATUS` / `PANE_BORDER_FORMAT` below are not pane options.
 * tmux applies them per WINDOW, and one window routinely holds a project
 * manager, several child sessions, several judge panes, and the user's own
 * shell — belonging to DIFFERENT sessions, none of which can see the others'
 * registries. Everything else in this file is per-pane and private; these two
 * are the shared surface, so their ownership is stated here rather than left
 * to be reconstructed from the code that writes them.
 *
 * WHO TURNS IT ON: every DECORATED pane open, and it does not check first.
 * `openSessionPane` (lib/session-factory.ts) calls `decorateSessionPane` when
 * — and only when — that open asked for decoration (`spec.decor`), which is
 * how a pane that wants no border, such as the relay successor, takes none.
 * For the opens that DO decorate, the two window options are set again every
 * time; re-opening an already-open bar is a no-op, and paying for it on each
 * spawn is what makes the ON state independent of who arrived first.
 *
 * WHO TURNS IT OFF: NOBODY (2026-09-17, user decision). A release path existed
 * — the last decorated pane a session could see took the bar down with `setw
 * -u` — and it is DELETED, not fixed. Turning `pane-border-status` on or off
 * changes EVERY PANE'S HEIGHT: measured on a scratch tmux as SIGWINCH with
 * `rows 84 → 83` on the way on and `83 → 84` on the way off, while re-setting
 * the same value triggers nothing at all. So every close of the last gate pane
 * re-laid out every application in the user's window — their editor, their
 * shells, a manager's pi — and the next spawn put it back. On top of that, two
 * of the release's inputs were wrong across sessions (below). One line of
 * border for the window's lifetime is the cheaper half of that trade.
 *
 * WHAT THIS COSTS THE BYSTANDERS, and it is accepted: a window option applies
 * to panes the gate never opened, so the user's own shell pane in that window
 * grows a border showing its own `#{pane_title}` — for as long as the window
 * lives, since nothing takes it down any more.
 *
 * TWO CROSS-SESSION MISFIRES WERE REMOVED WITH THE RELEASE ITSELF (measured
 * 2026-09-06; they were display-only before, and now cannot happen at all):
 *
 *   (a) A manager running `orchestrator_close` counts its own children and its
 *       own judges — it cannot see a reviewer pane the CHILD opened, because
 *       that pane lives in the child's registry. Closing the last child while
 *       that review was still running took the bar down under it.
 *   (b) An ordinary loop session opened by hand in a manager's window carries
 *       no `RG_ORCHESTRATION_ID`, so it was not a "guest" by that test.
 *       Closing its own last judge pane released the bar under the manager's
 *       children.
 *
 * Both had ONE root cause — a session can only see panes in its own registry —
 * which is why the fix that stuck was deleting the decision rather than
 * teaching a counter to see further.
 *
 * Pure module: strings in, strings out. The argv lives in
 * lib/orchestrator-tmux.ts and the execution in the dispatch/lifecycle tools.
 */

import type { ChildState } from "./orchestrator-child-state.ts";
import { taskIdFromChildId } from "./orchestrator-registry.ts";
import { PANE_LABEL_OPTION } from "./orchestrator-tmux.ts";

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

/**
 * Longest identity kept: a border that is cut off mid-word still reads, a
 * border that wraps does not. 44 fits `<taskId>@pm:` plus a normal task slug.
 */
const LABEL_MAX = 44;

/** Identity segments are capped individually too, so no one field eats the
 * whole label (`what` is a task id or a judge role, `who` a task id). */
const SEGMENT_MAX = 24;

/** The owner word for the project manager's own session. */
export const PANE_OWNER_PM = "pm";
/** The owner word for a plain loop session — the person, not a manager. */
export const PANE_OWNER_SELF = "self";

/**
 * One identity segment, made safe for a tmux format string.
 *
 * `#` and `,` and `:` are dropped for the same reason spaces are: the border
 * renders the label through a tmux FORMAT and a stray `#` would be read as one
 * (and a `,` would split the conditional in {@link PANE_BORDER_FORMAT}), while a
 * space is what the user explicitly ruled out. Anything left is either the
 * character class below or a dash standing in for it — never mojibake.
 */
function segment(raw: string, max: number): string {
  return String(raw ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, max);
}

/** The name half: a lowercased, dash-joined reading of a human title. */
function nameSlug(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * THE ONE GRAMMAR, and the only place a pane identity is spelled.
 *
 * The order is `what@who:name` because that is what the eye needs first when
 * scanning a column of panes: the judge's ROLE, the task's ID, the manager —
 * and only then whose it is. A non-ASCII or empty `name` leaves `what@who`
 * alone rather than transliterating it: a mangled label is worse than a plain
 * one, and `t6@pm` is already unambiguous.
 */
export function paneIdentity(opts: { what: string; owner?: string; name?: string }): string {
  const what = segment(opts.what, SEGMENT_MAX) || "pane";
  const owner = segment(opts.owner ?? "", SEGMENT_MAX);
  const head = owner ? `${what}@${owner}` : what;
  const name = opts.name === undefined ? "" : nameSlug(opts.name);
  if (!name) return head.slice(0, LABEL_MAX);
  const room = LABEL_MAX - head.length - 1;
  return room < 1 ? head.slice(0, LABEL_MAX) : `${head}:${name.slice(0, room)}`;
}

/**
 * A child session's identity: `t6@pm:eng-i18n-ci-cd-review-gate`.
 *
 * The owner defaults to `pm` because that is a fact about orchestration, not a
 * guess: children are opened by `orchestrator_spawn`, which only a project
 * manager can call.
 */
export function childPaneLabel(taskId: string, title: string, owner: string = PANE_OWNER_PM): string {
  return paneIdentity({ what: taskId, owner, name: title });
}

/**
 * A judge's identity: `reviewer@t6`, `goal-auditor@pm`, `reviewer@self`.
 *
 * The role alone was not enough — two goal-auditors in one window, opened by
 * two different sessions, had identical borders, and nothing on screen said
 * which review belonged to whom.
 */
export function judgePaneLabel(role: string, owner: string): string {
  return paneIdentity({ what: role, owner });
}

/** The project manager's own pane: `pm:pi-review-gate`. */
export function pmPaneLabel(dirname: string): string {
  return paneIdentity({ what: PANE_OWNER_PM, name: dirname });
}

/**
 * WHO AM I, as the owner half of every pane this session opens.
 *
 * Derived from the session's own facts and never passed in: an orchestration
 * child knows itself from `RG_STATE_VARIANT` (its child id, `<taskId>-<base36>`),
 * a project manager from the mode it is running in, and every other loop
 * session is simply `self`. A caller that had to supply this could supply the
 * wrong one, and nothing downstream could tell.
 */
export function selfPaneOwner(opts: { stateVariant?: string | undefined; orchestrator: boolean }): string {
  // Whitespace is not an identity: `RG_STATE_VARIANT` set to blanks (a hand-run
  // shell) must read as "no child id", not as a child whose task id is dashes.
  const childId = segment(String(opts.stateVariant ?? "").replace(/\s+/g, ""), SEGMENT_MAX);
  if (childId) return taskIdFromChildId(childId);
  return opts.orchestrator ? PANE_OWNER_PM : PANE_OWNER_SELF;
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


// (`paneTitleForHealth` is GONE, 2026-09-05. It rendered a title from a health
// reading, which is now `refreshSessionPaneTitle`'s job in
// lib/session-factory.ts — the ONE place a pane title is written, shared by the
// orchestration probe and the judge probe. Leaving a second renderer behind is
// how two spellings of the same border drift apart.)


/**
 * `pane-border-format`, in tmux's own syntax.
 *
 * TWO SOURCES, AND THE CONDITIONAL IS THE POINT (2026-09-22). A gate-opened
 * pane carries `@rg_label` — a pane user option pi cannot overwrite, unlike
 * `pane_title`, which pi rewrites at boot and on every rebind — so its border
 * renders what the gate wrote. Every OTHER pane in the window is a bystander
 * (the user's own shell), has no `@rg_label`, and keeps rendering its own
 * `#{pane_title}` exactly as before: this option is window-scoped and stays on
 * for the window's lifetime, so the fallback is not a nicety.
 */
export const PANE_BORDER_FORMAT = `#{?${PANE_LABEL_OPTION},#{${PANE_LABEL_OPTION}},#{pane_title}}`;

/** Where the label bar goes. `top` keeps it out of the status line. */
export const PANE_BORDER_STATUS = "top";

// (`isLastDecoratedChild` is GONE, 2026-09-05 — and the question that replaced
// it is gone too, 2026-09-17. It asked "is this the last decorated CHILD", one
// kind of pane counted from registry rows, and both halves were wrong once the
// same window also held decorated JUDGE panes. The replacement,
// `releasesWindowLabels` + `countDecoratedPanes`, asked it for every kind of
// pane — and is deleted as well, because its answer was always a
// `pane-border-status` write that resized every pane in the window: see this
// file's header.)


/** One line for the receipt, so a colour on screen matches a row in the text. */
export function formatPaneLegend(entries: readonly { childId: string; label: string }[]): string {
  if (entries.length === 0) return "";
  return entries
    .map((entry) => `${entry.label}（${paneColorFor(entry.childId).name}边框）= ${entry.childId}`)
    .join("；");
}
