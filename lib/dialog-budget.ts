/**
 * Rendered-line budget for extension confirmation dialogs.
 *
 * WHY THIS EXISTS. `pi.ui.confirm(title, message)` looks like a modal, but the
 * host renders it as `title + "\n" + message` inside ONE unclipped, unscrollable
 * `Text` component placed in the editor container at the bottom of the screen
 * (`showExtensionConfirm` -> `ExtensionSelectorComponent`). Nothing truncates it.
 * So the dialog's height is whatever the extension passes in.
 *
 * That matters because of how pi-tui's differential renderer works. While a tool
 * awaits the dialog the agent is still mid-turn, so the working spinner keeps
 * animating — and the spinner row sits ABOVE the editor container. Once the
 * dialog plus everything under it is at least as tall as the terminal, the
 * spinner row falls above `prevViewportTop`, and every animation frame hits
 * this branch in `tui-main-screen.ts`:
 *
 *     if (firstChanged < prevViewportTop) { fullRender(true); return; }
 *
 * `fullRender(true)` emits `\x1b[2J\x1b[H\x1b[3J` — clear screen, home, clear
 * SCROLLBACK. At ~10 spinner frames per second that is a screen wiped ten times
 * a second: the user sees the terminal flickering, and their scrollback is
 * repeatedly erased, while they are trying to read the very dialog that caused
 * it.
 *
 * MEASURED (40-row terminal, 30 spinner frames, driving the real TuiMainScreen):
 *
 *     dialog + rows below = 39  ->  0/30 full clears
 *     dialog + rows below = 40  -> 29/30 full clears   <- terminal height
 *
 * The trigger is purely geometric, so the fix is purely geometric: keep every
 * dialog short enough that the spinner stays inside the viewport. Long content
 * does not belong in a dialog at all — it goes to the transcript, which
 * scrolls, and the dialog keeps only what the decision needs.
 *
 * THE BUDGET. The extension cannot query the terminal size (the extension UI
 * API exposes no columns/rows), so the budget is a conservative constant sized
 * for a small terminal:
 *
 *     24 rows assumed
 *   -  8 rows of ExtensionSelectorComponent chrome (2 borders, 3 spacers,
 *        2 options, 1 key hint)
 *   -  2 rows for the footer / status line
 *   -  2 rows of slack (spinner row, prompt line)
 *   = 12 rows for `title + message` together
 *
 * Anything longer is cut with a pointer to where the full text lives.
 *
 * PURITY. No IO, no clock, no host objects: these are string functions. The
 * extension owns the dialogs; this module owns the geometry.
 */

/** Terminal size the budget assumes (the UI API cannot tell us the real one). */
export const DIALOG_ASSUMED_ROWS = 24;
export const DIALOG_ASSUMED_COLUMNS = 80;

/** Rows `ExtensionSelectorComponent` spends on its own chrome. */
export const DIALOG_CHROME_ROWS = 8;
/** Rows reserved for the footer/status line under the dialog. */
export const DIALOG_FOOTER_ROWS = 2;
/** Extra slack so the spinner row stays inside the viewport. */
export const DIALOG_SLACK_ROWS = 2;

/**
 * Max rendered rows for `title + "\n" + message` combined.
 * Keep this in sync with the arithmetic in the module docblock.
 */
export const DIALOG_BODY_MAX_LINES =
  DIALOG_ASSUMED_ROWS - DIALOG_CHROME_ROWS - DIALOG_FOOTER_ROWS - DIALOG_SLACK_ROWS;

/**
 * Display width of one code point in terminal cells.
 *
 * A full Unicode East Asian Width table is not worth carrying here: this budget
 * only has to be SAFE, and safety is one-sided — overestimating width
 * overestimates the line count, which truncates earlier. So anything plausibly
 * wide counts as 2.
 */
function codePointWidth(cp: number): number {
  // Zero-width: combining marks, ZWJ/ZWNJ, variation selectors.
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
  if (cp >= 0xe0100 && cp <= 0xe01ef) return 0;
  // Wide / fullwidth ranges (approximate, deliberately generous).
  if (cp >= 0x1100 && cp <= 0x115f) return 2; // Hangul Jamo
  if (cp >= 0x2e80 && cp <= 0x303e) return 2; // CJK radicals, Kangxi, punctuation
  if (cp >= 0x3041 && cp <= 0x33ff) return 2; // Kana, Hangul compat, CJK symbols
  if (cp >= 0x3400 && cp <= 0x4dbf) return 2; // CJK Ext A
  if (cp >= 0x4e00 && cp <= 0x9fff) return 2; // CJK Unified
  if (cp >= 0xa000 && cp <= 0xa4cf) return 2; // Yi
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2; // Hangul syllables
  if (cp >= 0xf900 && cp <= 0xfaff) return 2; // CJK compatibility ideographs
  if (cp >= 0xfe10 && cp <= 0xfe19) return 2; // vertical forms
  if (cp >= 0xfe30 && cp <= 0xfe6f) return 2; // CJK compatibility forms
  if (cp >= 0xff00 && cp <= 0xff60) return 2; // fullwidth forms
  if (cp >= 0xffe0 && cp <= 0xffe6) return 2; // fullwidth signs
  if (cp >= 0x1f300 && cp <= 0x1f64f) return 2; // emoji
  if (cp >= 0x1f900 && cp <= 0x1f9ff) return 2; // supplemental emoji
  if (cp >= 0x20000 && cp <= 0x3fffd) return 2; // CJK Ext B+
  return 1;
}

/**
 * Visible width of a string in terminal cells. ANSI SGR/CSI sequences are
 * skipped; a tab counts as 4 cells (this project's dialogs contain none, and
 * overcounting is the safe direction).
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === "\x1b") {
      // Skip a CSI/OSC-ish escape: ESC, optional '[', then up to the final byte.
      let j = i + 1;
      if (text[j] === "[") j++;
      while (j < text.length && !/[a-zA-Z]/.test(text[j] as string)) j++;
      i = j + 1;
      continue;
    }
    if (ch === "\t") {
      width += 4;
      i += 1;
      continue;
    }
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    width += codePointWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return width;
}

/**
 * Rows one logical line occupies after soft wrapping at `columns`.
 * An empty line still occupies one row.
 */
export function wrappedRowCount(line: string, columns: number = DIALOG_ASSUMED_COLUMNS): number {
  const width = displayWidth(line);
  if (width === 0) return 1;
  return Math.ceil(width / Math.max(1, columns));
}

/** Rows a whole block of text occupies after soft wrapping at `columns`. */
export function renderedRowCount(text: string, columns: number = DIALOG_ASSUMED_COLUMNS): number {
  const lines = text.split("\n");
  let rows = 0;
  for (const line of lines) rows += wrappedRowCount(line, columns);
  return rows;
}

export interface FitDialogResult {
  /** The message text to hand to `ui.confirm`, guaranteed within budget. */
  message: string;
  /** True when content had to be dropped. */
  truncated: boolean;
  /** Rendered rows of `title + "\n" + message` after fitting. */
  rows: number;
}

/**
 * Truncate a block to at most `maxRows` rendered rows, dropping whole logical
 * lines from the end. A line too wide to fit on its own is hard-cut by
 * characters so one runaway line cannot blow the budget.
 */
function clampToRows(text: string, maxRows: number, columns: number): { text: string; truncated: boolean } {
  if (maxRows <= 0) return { text: "", truncated: text.length > 0 };
  const lines = text.split("\n");
  const kept: string[] = [];
  let rows = 0;
  let truncated = false;
  for (const line of lines) {
    const cost = wrappedRowCount(line, columns);
    if (rows + cost <= maxRows) {
      kept.push(line);
      rows += cost;
      continue;
    }
    // Partially fit a too-long line by characters, then stop.
    const budget = maxRows - rows;
    if (budget > 0) {
      const cells = budget * columns;
      let acc = "";
      let used = 0;
      for (const ch of line) {
        const w = displayWidth(ch);
        if (used + w > cells) break;
        acc += ch;
        used += w;
      }
      if (acc.length > 0) {
        kept.push(acc);
        rows += wrappedRowCount(acc, columns);
      }
    }
    truncated = true;
    break;
  }
  if (kept.length < lines.length) truncated = true;
  return { text: kept.join("\n"), truncated };
}

/**
 * Fit `title + "\n" + message` inside {@link DIALOG_BODY_MAX_LINES} rendered
 * rows. When the message must be cut, `pointer` is appended so the user knows
 * something was dropped (it is counted against the budget, not added on top).
 *
 * The DEFAULT pointer only says that text was cut. A caller that really did
 * print the full text somewhere (e.g. via `ui.notify` before opening the
 * dialog) passes a pointer naming that place — promising a message that was
 * never shown is the exact class of bug this module exists to stop.
 *
 * The title is never truncated — it is the question being asked — but it IS
 * charged to the budget, so a long title simply leaves less room for the body.
 */
export function fitDialogMessage(
  title: string,
  message: string,
  pointer = "（内容过长，已截断）",
  columns: number = DIALOG_ASSUMED_COLUMNS,
  maxRows: number = DIALOG_BODY_MAX_LINES,
): FitDialogResult {
  const titleRows = renderedRowCount(title, columns);
  const available = maxRows - titleRows;
  if (available <= 0) {
    // Pathological title: nothing sane to show. Keep the dialog empty rather
    // than making it taller.
    return { message: "", truncated: message.length > 0, rows: titleRows };
  }
  if (renderedRowCount(message, columns) <= available) {
    return {
      message,
      truncated: false,
      rows: titleRows + renderedRowCount(message, columns),
    };
  }
  const pointerRows = wrappedRowCount(pointer, columns);
  const clamped = clampToRows(message, Math.max(0, available - pointerRows), columns);
  const withPointer = clamped.text.length > 0 ? `${clamped.text}\n${pointer}` : pointer;
  return {
    message: withPointer,
    truncated: true,
    rows: titleRows + renderedRowCount(withPointer, columns),
  };
}

