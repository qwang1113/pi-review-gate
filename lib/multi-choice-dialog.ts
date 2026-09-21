/**
 * THE GATE'S SECOND DIALOG SHAPE — the MULTIPLE-CHOICE (checkbox) list.
 *
 * WHY THIS IS A SECOND FILE. `lib/choice-dialog.ts` is the ONE home of the
 * dialog RULES — the letters, the decline row, the recommended marker, the
 * position reader, the reason box — and this shape shares every one of them.
 * What it does not share is a paragraph of code: a checkbox list has its own
 * parser, its own state machine, its own renderer and its own TUI component,
 * and the file-size rule hard-blocks a NEW file over 600 lines while that one
 * is already past 500. One module per SHAPE, one vocabulary between them.
 *
 * WHAT A CROSS-TYPE INVARIANT LOOKS LIKE HERE (user decision, 2026-09-22):
 * 「直接回车 ＝ 接受提问方的推荐」 holds for both shapes. A radio question
 * carries a REQUIRED `recommended`; a checkbox question carries a REQUIRED
 * `defaultChecked` — the group the question author recommends, and therefore
 * exactly what a user who presses Enter without touching anything submits.
 * That is why `defaultChecked` is the field that MAKES a question multiple:
 * `spec.defaultChecked !== undefined` is the shape test everywhere below.
 *
 * SURFACE. Three layers, so every branch is testable without a terminal:
 *   - `multiChoiceRows` / `multiSelectionLabel` / `parseMultiChoice` — text;
 *   - `multiChoiceStart` / `multiChoiceKey` — the pure state machine;
 *   - `renderMultiChoice` — the async dialog (list, then maybe the reason box);
 *   - `buildMultiChoiceBox` — the TUI component itself, plain `render(width)`
 *     lines with no pi import (the host mounts it via `ui.custom`).
 */

import {
  BACK_ROW,
  declineReason,
  declineRowOf,
  optionLabel,
  optionRow,
  parseChoice,
  type ChoiceSpec,
  type ChoiceUi,
} from "./choice-dialog.ts";

/** How a SELECTED option is drawn, and how an unselected one is. */
export const MULTI_CHECKED_MARK = "[x]";
export const MULTI_UNCHECKED_MARK = "[ ]";

/**
 * THE SEPARATOR BETWEEN TWO PICKED OPTIONS — `A. 甲 / C. 丙` (2026-09-22).
 *
 * It is the WIRE format as well as the on-screen one: the component, the
 * channel answer (`lib/orchestrator-answer-tools.ts` normalizes a project
 * manager's `A, C` into this) and the record all speak one string, so nothing
 * has to parse a second dialect. The spaces are load-bearing — a `/` inside an
 * option's own text is not a separator.
 */
export const MULTI_ANSWER_SEPARATOR = " / ";

/** A question is multiple iff it carries a `defaultChecked` (possibly empty). */
export function isMultipleChoice(spec: ChoiceSpec): boolean {
  return spec.defaultChecked !== undefined;
}

/** The options a multiple-choice question starts on. */
export function defaultCheckedOf(spec: ChoiceSpec): string[] {
  return [...(spec.defaultChecked ?? [])];
}

/** One checkbox row: `[x] A. text（推荐）`. */
export function multiChoiceRow(
  option: string,
  spec: ChoiceSpec,
  index: number,
  checked: boolean,
): string {
  return `${checked ? MULTI_CHECKED_MARK : MULTI_UNCHECKED_MARK} ${optionRow(option, spec.recommended, index)}`;
}

/**
 * Every row the list shows, in order: the options (each carrying its own
 * checkbox), then the decline row, then — only for an interview — the way back.
 *
 * The decline row and the back row carry NO checkbox: they are not answers a
 * user ticks, and a box in front of them would say they are.
 */
export function multiChoiceRows(
  spec: ChoiceSpec,
  checked: readonly string[],
  opts: { back?: boolean } = {},
): string[] {
  const rows = spec.options.map((option, index) => multiChoiceRow(option, spec, index, checked.includes(option)));
  return [...rows, declineRowOf(spec), ...(opts.back ? [BACK_ROW] : [])];
}

/**
 * The picked options as the record and the wire write them: `A. 甲 / C. 丙`,
 * in the OPTION LIST'S OWN ORDER (never the order the user happened to tick),
 * and `""` when nothing was picked — which is a legitimate answer here
 * (t5-stages' “every stage off”), not a missing one.
 */
export function multiSelectionLabel(selected: readonly string[], all: readonly string[]): string {
  const picked = all.filter((option) => selected.includes(option));
  return picked.map((option) => optionLabel(option, all)).join(MULTI_ANSWER_SEPARATOR);
}

/** What a returned multiple-choice line MEANS. */
export type MultiChoicePick =
  | { kind: "chose"; options: string[] }
  | { kind: "declined"; reason: string }
  | { kind: "dismissed" }
  /**
   * A line this parser cannot read. It is NOT silently dropped: the caller
   * decides what an answer nobody can interpret means (the arbiter proxy can
   * answer a dialog with prose, and inventing ticks from prose is how a gate
   * approves what the user never chose).
   */
  | { kind: "unreadable"; text: string };

/** The checkbox a row may still carry when a channel answer quotes it back. */
const ROW_MARK = /^\[[ xX]\]\s+/;

/**
 * Read a returned line. STRICT on purpose: it accepts exactly what this module
 * and the channel's own answer normalizer produce — `""`, the decline row
 * (with or without a reason), and `A. text` segments joined by
 * {@link MULTI_ANSWER_SEPARATOR}. A project manager's own loose spelling
 * (`A, C`) is made canonical BEFORE it gets here, by
 * `lib/orchestrator-answer-tools.ts`'s `resolveAnswer`.
 *
 * A QUOTED ROW MAY CARRY ITS CHECKBOX (2026-09-22): the rows a checklist puts
 * on the channel are the ones the user sees (`[ ] A. 预检`), so a manager that
 * copies one back must not thereby be unreadable. The mark is stripped HERE,
 * once, and every comparison below runs on the bare `A. text`.
 */
export function parseMultiChoice(picked: string | undefined, spec: ChoiceSpec): MultiChoicePick {
  if (picked === undefined) return { kind: "dismissed" };
  const decline = declineRowOf(spec);
  if (picked === decline) return { kind: "declined", reason: "" };
  if (picked.startsWith(decline)) {
    return { kind: "declined", reason: picked.slice(decline.length).replace(/^[：:]\s*/, "").trim() };
  }
  if (picked.trim() === "") return { kind: "chose", options: [] };
  const options: string[] = [];
  for (const segment of picked.split(MULTI_ANSWER_SEPARATOR)) {
    // EVERY segment goes through the radio parser — that is what makes `A`,
    // `a`, `1`, `A. text` and a bare option text all mean the same tick, with
    // no second copy of the position rule.
    const parsed = parseChoice(segment.trim().replace(ROW_MARK, ""), spec);
    const option = parsed.kind === "chose" ? parsed.option : undefined;
    if (option === undefined || !spec.options.includes(option)) {
      return { kind: "unreadable", text: picked };
    }
    if (!options.includes(option)) options.push(option);
  }
  return { kind: "chose", options: spec.options.filter((option) => options.includes(option)) };
}

// ---------- the state machine ----------

/** Where the cursor is and what is ticked. */
export interface MultiChoiceState {
  /** Cursor row: an option (0..options.length-1), the decline row, or `back`. */
  cursor: number;
  checked: string[];
}

/** How many rows the list has, given whether the way back is drawn. */
export function multiChoiceRowCount(spec: ChoiceSpec, opts: { back?: boolean } = {}): number {
  return spec.options.length + 1 + (opts.back ? 1 : 0);
}

export function multiChoiceStart(spec: ChoiceSpec): MultiChoiceState {
  return { cursor: 0, checked: defaultCheckedOf(spec) };
}

/** What one key press does — the whole interaction, as data. */
export type MultiChoiceAction =
  /** The key is not ours; nothing changes. */
  | { kind: "none" }
  /** Redraw with this state. */
  | { kind: "redraw"; state: MultiChoiceState }
  /** Enter on an option row (or `space`-then-Enter anywhere): confirm. */
  | { kind: "submit"; options: string[] }
  /** Enter on the decline row. */
  | { kind: "decline" }
  /** Enter on `← 返回上一题`. */
  | { kind: "back" }
  /** ESC — the box is closed, nobody decided anything. */
  | { kind: "close" };

/** The rows of the cursor's neighbourhood, read as one value. */
const UP_KEYS = ["\u001b[A", "\u001bOA", "k"];
const DOWN_KEYS = ["\u001b[B", "\u001bOB", "j"];
const ENTER_KEYS = ["\r", "\n"];
const SPACE = " ";
const ESCAPE = "\u001b";

/**
 * ONE KEY PRESS, as a pure step. Positions are read in the SAME order the rows
 * are drawn (options, decline, back), and the cursor WRAPS — a list longer than
 * the screen must never have an unreachable end.
 */
export function multiChoiceKey(
  state: MultiChoiceState,
  spec: ChoiceSpec,
  data: string,
  opts: { back?: boolean } = {},
): MultiChoiceAction {
  const rows = multiChoiceRowCount(spec, opts);
  const declineRow = spec.options.length;
  const backRow = declineRow + (opts.back ? 1 : 0);
  if (UP_KEYS.includes(data)) {
    return { kind: "redraw", state: { ...state, cursor: (state.cursor + rows - 1) % rows } };
  }
  if (DOWN_KEYS.includes(data)) {
    return { kind: "redraw", state: { ...state, cursor: (state.cursor + 1) % rows } };
  }
  if (data === SPACE) {
    // SPACE IS A CHECKBOX, NOT A BUTTON: on the navigation rows it does nothing,
    // so ticking the decline row (or the way back) is impossible by accident.
    const option = spec.options[state.cursor];
    if (option === undefined) return { kind: "none" };
    const checked = state.checked.includes(option)
      ? state.checked.filter((o) => o !== option)
      : [...state.checked, option];
    return { kind: "redraw", state: { ...state, checked } };
  }
  if (ENTER_KEYS.includes(data)) {
    if (state.cursor === declineRow) return { kind: "decline" };
    if (opts.back && state.cursor === backRow) return { kind: "back" };
    // THE OPTION LIST'S OWN ORDER, whatever order they were ticked in.
    return { kind: "submit", options: spec.options.filter((option) => state.checked.includes(option)) };
  }
  if (data === ESCAPE) return { kind: "close" };
  return { kind: "none" };
}

// ---------- the dialog ----------

/** What the checkbox host reports. */
export type MultiSelectOutcome =
  | { kind: "picked"; options: string[] }
  | { kind: "decline" }
  | { kind: "back" }
  | { kind: "dismissed" };

/**
 * The host seam: a checkbox list the caller may mount however it can. A host
 * that cannot render one resolves `undefined` — which is a dismissal, never an
 * invented answer, and never a silent one either (the caller reports “nothing
 * could be shown” the way it already does for a host with no dialogs).
 */
export interface MultiChoiceHost {
  multiSelect?: (
    title: string,
    spec: ChoiceSpec,
    opts: { signal?: AbortSignal; back?: boolean },
  ) => Promise<MultiSelectOutcome | undefined>;
  editor?: ChoiceUi["editor"];
}

/**
 * Render the checkbox list and return the line the user produced — the SAME
 * line shape `parseMultiChoice` reads, so the caller has one parser for the
 * human, the channel and a test:
 *
 *   `""`                      — confirmed with nothing ticked;
 *   `A. 甲 / C. 丙`           — the ticked options;
 *   `✎ 不选，我说明原因：…`    — the decline row (+ reason);
 *   `← 返回上一题`             — the interview's way back;
 *   `undefined`               — the box was closed.
 */
export async function renderMultiChoice(
  ui: MultiChoiceHost | undefined,
  spec: ChoiceSpec,
  opts: { signal?: AbortSignal; body?: string; back?: boolean } = {},
): Promise<string | undefined> {
  const title = opts.body ? `${spec.title}\n${opts.body}` : spec.title;
  let checked = defaultCheckedOf(spec);
  let prefill: string | undefined;
  for (;;) {
    const outcome = await ui?.multiSelect?.(
      title,
      { ...spec, defaultChecked: checked },
      {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.back ? { back: true } : {}),
      },
    ) ?? { kind: "dismissed" };
    if (outcome.kind === "picked") return multiSelectionLabel(outcome.options, spec.options);
    if (outcome.kind === "back") return BACK_ROW;
    if (outcome.kind === "dismissed") return undefined;
    // The decline row's second half is the SAME conversation the radio shape
    // has (lib/choice-dialog.ts): a reason box whose ESC re-opens the list,
    // with whatever was typed carried along.
    const step = await declineReason(ui, spec, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.body === undefined ? {} : { body: opts.body }),
      ...(prefill === undefined ? {} : { prefill }),
    });
    if (step.kind === "answer") return step.picked;
    if (step.kind === "dismissed") return undefined;
    prefill = step.prefill ?? prefill;
  }
}

// ---------- the TUI component ----------

/** Just enough of pi's theme to decorate a row (identity when absent). */
export interface MultiChoiceTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

export interface MultiChoiceBoxOptions {
  /** The full title — its newlines are the caller's (usually the question body). */
  title: string;
  spec: ChoiceSpec;
  /** Draw `← 返回上一题` as the last row. */
  back?: boolean;
  theme?: MultiChoiceTheme;
  /** Called EXACTLY ONCE, whichever way the box ends. */
  done: (outcome: MultiSelectOutcome) => void;
  /** Ask the TUI to redraw. Absent ⇒ nothing to ask (a test). */
  requestRender?: () => void;
  /** The footer line. The default states the four keys. */
  hint?: string;
}

/** The component as pi mounts it (a plain object — no pi import needed). */
export interface MultiChoiceBox {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose(): void;
}

const CURSOR_PREFIX = "❯ ";
const PLAIN_PREFIX = "  ";

/** The default footer — the keys are the whole interaction, so they are shown. */
export function multiChoiceHint(): string {
  return "空格 勾选 / 取消 · ↑↓ 移动 · 回车 确认 · esc 关闭";
}

export function buildMultiChoiceBox(opts: MultiChoiceBoxOptions): MultiChoiceBox {
  const spec = opts.spec;
  const back = opts.back ?? false;
  let state = multiChoiceStart(spec);
  let finished = false;
  const fg = opts.theme?.fg ?? ((_color: string, text: string) => text);
  const bold = opts.theme?.bold ?? ((text: string) => text);
  const finish = (outcome: MultiSelectOutcome) => {
    if (finished) return;
    finished = true;
    opts.done(outcome);
  };
  return {
    render(width: number): string[] {
      const lines: string[] = [];
      for (const line of opts.title.split("\n")) lines.push(truncateToWidth(bold(line), width));
      lines.push("");
      multiChoiceRows(spec, state.checked, { back }).forEach((row, index) => {
        const cursor = index === state.cursor;
        const text = `${cursor ? CURSOR_PREFIX : PLAIN_PREFIX}${row}`;
        lines.push(truncateToWidth(cursor ? fg("accent", text) : text, width));
      });
      lines.push("");
      lines.push(truncateToWidth(fg("dim", opts.hint ?? multiChoiceHint()), width));
      return lines;
    },
    handleInput(data: string): void {
      if (finished) return;
      const action = multiChoiceKey(state, spec, data, { back });
      switch (action.kind) {
        case "redraw":
          state = action.state;
          opts.requestRender?.();
          return;
        case "submit":
          finish({ kind: "picked", options: action.options });
          return;
        case "decline":
          finish({ kind: "decline" });
          return;
        case "back":
          finish({ kind: "back" });
          return;
        case "close":
          finish({ kind: "dismissed" });
          return;
        default:
          return;
      }
    },
    invalidate(): void { /* nothing is cached: every render reads the state */ },
    dispose(): void { finished = true; },
  };
}

/** Bold the title line the way every other gate box does — the one decoration. */
// ---------- width ----------

/**
 * A line that fits the terminal — and the ONLY reason this module knows about
 * cell widths at all (pi's `render(width)` contract: no line may exceed it, or
 * the box wraps and the cursor lands on the wrong row). Wide (CJK, emoji) code
 * points count 2; ANSI escapes count 0, so themed rows are measured by what is
 * visible. An over-long line is cut and marked with `…`.
 *
 * WHY NOT PI'S OWN `truncateToWidth`: this module is loaded by unit tests with
 * no pi package on disk (the same reason lib/reason-editor.ts takes its
 * component as a seam), and a static import of `@earendil-works/pi-tui` would
 * make the whole shape unloadable outside pi. The table below is the narrow
 * subset a dialog in Chinese actually hits.
 */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  const units: Array<{ text: string; cells: number }> = [];
  for (let i = 0; i < text.length;) {
    if (text.startsWith("\u001b[", i)) {
      const end = text.indexOf("m", i);
      const stop = end < 0 ? text.length : end + 1;
      units.push({ text: text.slice(i, stop), cells: 0 });
      i = stop;
      continue;
    }
    const code = text.codePointAt(i)!;
    const char = String.fromCodePoint(code);
    units.push({ text: char, cells: isWideCodePoint(code) ? 2 : 1 });
    i += char.length;
  }
  if (units.reduce((cells, unit) => cells + unit.cells, 0) <= width) return text;
  // THE ELLIPSIS NEEDS A CELL OF ITS OWN: keeping the full budget for the text
  // and appending `…` after it is how a “truncated” line still ends up one
  // column too wide — measured, and the reason this returns `a…` for width 2.
  let visible = 0;
  let out = "";
  for (const unit of units) {
    if (visible + unit.cells > width - 1) break;
    out += unit.text;
    visible += unit.cells;
  }
  return `${out}…`;
}

/** Rough East-Asian-width table: the ranges a dialog in Chinese actually hits. */
function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}
