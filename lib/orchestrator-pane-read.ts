/**
 * READING a child session — the atomic capability the orchestration layer was
 * missing, and the reason the first hand-run deadlocked (F3).
 *
 * The measured failure: a child raised an attention event, the orchestrator
 * received it, and the event carried a REASON ("等待回答提问") and nothing
 * else. The orchestrator knew somebody was calling it and had no way on earth
 * to learn WHAT was being asked — so it did the only thing left and asked the
 * human to go read the pane and relay it. An unattended run dies right there.
 *
 * TWO CHANNELS, NEVER CONFLATED (user decision, 2026-08-29):
 *
 *   capture-pane   what is literally on the child's screen. Universal — it
 *                  sees ordinary questions the gate knows nothing about — but
 *                  the structure has to be RECOVERED from rendered text, so
 *                  everything this module infers is a HEURISTIC.
 *   sidecar        the child's own `.pi/review-gate-state.*.json`. Narrow (it
 *                  only knows the gate's own dialogs) but exact — F10 proved
 *                  the goal draft was sitting there in `goalPrereview.draft`
 *                  the whole time.
 *
 * The rule that keeps the two honest is that the tool LABELS which channel
 * each fact came from, and this module never upgrades a guess into a claim:
 * {@link parsePaneSnapshot} always returns the raw lines, so an orchestrator
 * whose dialog parse came back empty can still read the screen itself. The
 * lesson of F8/F11 is that a confident wrong answer is worse than no answer.
 *
 * Pure module: text in, structure out. No tmux, no filesystem, no clock.
 */

/** How many lines of scrollback a read asks tmux for by default. */
export const PANE_CAPTURE_LINES = 120;
/** Hard cap on what a single read hands back to the agent (context budget). */
export const PANE_READ_MAX_LINES = 200;

/**
 * Glyphs a TUI puts in front of the CURRENTLY SELECTED row.
 *
 * `→` is first because it is the one that matters here: pi's own `SelectList`
 * renders `prefix = isSelected ? "→ " : "  "` (verified against the installed
 * bundle, 2026-08-29), and an extension's `ui.confirm(title, message)` is a
 * SelectList over `["Yes", "No"]`. The rest cover the other renderers a child
 * session can put on screen (inquirer-style prompts, fzf-style pickers).
 *
 * A marker is only ever read at the START of a line, after indentation — the
 * same glyph inside prose is ordinary text.
 */
const SELECTED_MARKERS = ["→", "❯", "▶", "▸", "➤", "●", "◉", "◆", ">", "*"] as const;
/** Glyphs that mark a row of the SAME list which is not selected. */
const UNSELECTED_MARKERS = ["○", "◯", "◇", "·", "•", "-"] as const;

/**
 * What may appear BEFORE a row's label besides a marker: indentation and the
 * vertical rules a framed dialog draws.
 */
const PREFIX_DECORATION = /^[\s│|┃╎┆]*$/;

/** Longest option list this recognizes — pi shows at most ~12 rows at once. */
const MAX_BLOCK_ROWS = 14;

/** `1.` / `1)` / `[1]` / `(1)` prefixes — a numbered list is a list too. */
const NUMBERED = /^\(?\[?(\d{1,2})[\].)]\s+(.*)$/;

/**
 * The FOOTER a live choice list draws under its rows, and the single fact
 * that decides whether this module reports a dialog AT ALL (R-1, R-9).
 *
 * The measured failure: with no dialog on screen the parser anchored on the
 * `▶` of the belowEditor sub-agent widget (`▶ reviewer | # Task for reviewer`)
 * and reported it as "the dialog and its only option". Twice that was merely
 * noise; the third time a REAL setup_workspace dialog was on screen, the
 * widget row won (it is further down the pane), `orchestrator_key({match})`
 * refused because no option matched, and the orchestrator had no way left to
 * answer — the 25-minute deadlock.
 *
 * A rendered choice list always prints its key hints below the rows
 * (`↑↓ navigate  enter select  esc cancel`), and nothing else in a pane does.
 * So the footer is the anchor: everything BELOW the last footer line is not
 * part of a dialog and is cut away before parsing, and a pane with no footer
 * has NO dialog — reported as such, never guessed at.
 */
const DIALOG_FOOTER = /(↑↓|↑\/↓|up\/down)|(\benter\b[^\n]{0,24}\b(select|confirm|submit)\b)/i;

/** Index of the LAST footer line, i.e. the live dialog's. */
export function findDialogFooter(lines: readonly string[]): number | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (DIALOG_FOOTER.test(lines[i]!)) return i;
  }
  return undefined;
}



/** One row of a choice list, as it was rendered. */
export interface PaneOption {
  /** 1-based position in the list — what `orchestrator_key` addresses. */
  index: number;
  /** The row text with its marker and numbering stripped. */
  label: string;
  /** Was this the highlighted row at capture time? */
  selected: boolean;
}

/** A choice list found on screen, plus whatever looked like its title. */
export interface PaneDialog {
  title?: string;
  options: PaneOption[];
  /** 1-based index of the highlighted row; undefined when none was marked. */
  selectedIndex?: number;
}

/** Everything one `capture-pane` told us. */
export interface PaneSnapshot {
  /** Trailing blank lines removed; nothing else is altered. */
  lines: string[];
  /** The same content as one string — the agent's fallback when parsing fails. */
  text: string;
  /** The choice list, when one was recognized. */
  dialog?: PaneDialog;
  /** The pane is not empty: something has been rendered into it. */
  hasContent: boolean;
}

/** One recognized row, with the column its label starts at. */
interface Row {
  raw: string;
  label: string;
  selected: boolean;
}

function stripTrailingBlanks(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  return lines.slice(0, end);
}

function stripNumbering(label: string): string {
  const numbered = NUMBERED.exec(label);
  return numbered ? numbered[2]!.trim() : label;
}

/**
 * The LAST highlighted row on screen, and the column its label starts at.
 *
 * The last one, not the first: a pane holds scrollback, so dialogs that were
 * already answered are still visible above. The live question is always the
 * bottom one, and answering a scrolled-off dialog is exactly the class of
 * mistake this layer exists to stop.
 */
function findSelectedAnchor(lines: readonly string[]): { index: number; contentCol: number } | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const indent = line.length - line.trimStart().length;
    const body = line.slice(indent);
    const marker = SELECTED_MARKERS.find((m) => body.startsWith(m));
    if (!marker) continue;
    const after = body.slice(marker.length);
    const gap = after.length - after.trimStart().length;
    if (after.trim().length === 0) continue;
    return { index: i, contentCol: indent + marker.length + gap };
  }
  return undefined;
}

/**
 * Is this line a row of the list anchored at `contentCol`?
 *
 * THE RULE IS COLUMN ALIGNMENT, and that is what makes it work against a real
 * renderer: pi pads unselected rows with spaces to the same column the marker
 * occupies on the selected one (`"→ "` vs `"  "`), so an unselected row has NO
 * glyph of its own and can only be recognized by where its text begins.
 *
 * The residual risk is prose that happens to be indented to exactly that
 * column. It is bounded three ways: a framed dialog indents its title and
 * message by ONE column while the rows sit at two, a blank line ends the
 * block, and — the real backstop — lib/orchestrator-keys.ts re-reads the
 * screen after moving the highlight and refuses to submit if it did not land
 * where the caller aimed.
 */
function rowAt(line: string, contentCol: number): Row | undefined {
  if (line.length <= contentCol) return undefined;
  const prefix = line.slice(0, contentCol);
  const label = stripNumbering(line.slice(contentCol).trim());
  if (!label) return undefined;
  const selected = SELECTED_MARKERS.some((m) => prefix.includes(m));
  const unselected = UNSELECTED_MARKERS.some((m) => prefix.includes(m));
  if (!selected && !unselected && !PREFIX_DECORATION.test(prefix)) return undefined;
  return { raw: line, label, selected };
}

/**
 * The contiguous run of rows around the anchor, WITH WRAPPED LABELS MERGED
 * (R-12).
 *
 * The measured failure: in a 59-column pane the third option of a three-option
 * dialog wrapped, its remainder was rendered at column 0, the downward walk
 * stopped there and the parser reported two options — so `match:"C 不修根因"`
 * was refused for an option that was plainly on screen.
 *
 * A wrapped remainder is recognizable: it is non-empty, it does not start a
 * row of this list, and it directly follows one. It is appended to that row's
 * label instead of ending the block. A BLANK line still ends the block (that
 * is the frame), and two consecutive unattachable lines end it too, so prose
 * below the list cannot be swallowed.
 */
function collectBlock(lines: readonly string[], anchor: { index: number; contentCol: number }): Row[] {
  let first = anchor.index;
  for (;;) {
    const prev = first - 1;
    if (prev < 0) break;
    if (rowAt(lines[prev]!, anchor.contentCol)) { first = prev; continue; }
    // A wrapped remainder of the row above it is part of the list too.
    if (lines[prev]!.trim() !== "" && prev - 1 >= 0 && rowAt(lines[prev - 1]!, anchor.contentCol)) {
      first = prev - 1;
      continue;
    }
    break;
  }


  const rows: Row[] = [];
  for (let i = first; i < lines.length && rows.length <= MAX_BLOCK_ROWS; i++) {
    const line = lines[i]!;
    if (line.trim() === "") break;
    const row = rowAt(line, anchor.contentCol);
    if (row) {
      if (rows.length === MAX_BLOCK_ROWS) break;
      rows.push(row);
      continue;
    }
    // Not a row: a wrapped remainder of the previous one, or the end.
    const last = rows[rows.length - 1];
    if (!last) break;

    last.label = `${last.label}${line.trim()}`.slice(0, WRAPPED_LABEL_MAX);
  }
  return rows;
}

/** Longest label a merged (wrapped) row may reach. */
const WRAPPED_LABEL_MAX = 300;


/**
 * FALLBACK for a list with no visible highlight: a run of two or more lines
 * that each carry their own glyph or number at the same indentation.
 *
 * It yields options with `selectedIndex` undefined, which
 * lib/orchestrator-keys.ts treats as "cannot compute arrow presses" and
 * refuses to act on — the point is to SHOW the agent the choices, not to let
 * it press blind.
 */
function findGlyphBlock(lines: readonly string[]): Row[] {
  let best: Row[] = [];
  let current: Row[] = [];
  let currentIndent = -1;
  const flush = (): void => {
    if (current.length >= 2) best = current;
    current = [];
    currentIndent = -1;
  };
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const body = line.slice(indent);
    const marker =
      SELECTED_MARKERS.find((m) => body.startsWith(m)) ??
      UNSELECTED_MARKERS.find((m) => body.startsWith(m));
    const numbered = NUMBERED.exec(body);
    if (!marker && !numbered) {
      if (line.trim() !== "" || current.length === 0) flush();
      continue;
    }
    const label = marker ? stripNumbering(body.slice(marker.length).trim()) : numbered![2]!.trim();
    if (!label) { flush(); continue; }
    if (currentIndent !== -1 && indent !== currentIndent) flush();
    if (currentIndent === -1) currentIndent = indent;
    current.push({
      raw: line,
      label,
      selected: Boolean(marker && SELECTED_MARKERS.includes(marker as (typeof SELECTED_MARKERS)[number])),
    });
  }
  flush();
  return best;
}

/** The nearest non-empty line above the block that is not itself a row. */
function findTitle(lines: readonly string[], blockStart: number, contentCol: number): string | undefined {
  for (let i = blockStart - 1; i >= 0 && i >= blockStart - 6; i--) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (rowAt(line, contentCol)) continue;
    const cleaned = line.trim().replace(/^[│|┃╎┆]\s*/, "").replace(/[│|┃╎┆]$/, "").trim();
    if (cleaned.length > 0) return cleaned.slice(0, 200);
  }
  return undefined;
}


/**
 * How far above the footer a dialog's rows may start.
 *
 * Bounded so an old, already-answered list further up the scrollback can
 * never be attached to the CURRENT footer.
 */
const DIALOG_REGION_LINES = 30;

/**
 * Parse one `capture-pane` payload.
 *
 * Never throws and never returns "nothing": the raw lines are always part of
 * the result, so a caller whose dialog parse came back empty still has the
 * screen to show the agent.
 *
 * A dialog is reported ONLY when the footer is on screen (R-1/R-9), and only
 * the region ABOVE that footer is parsed — which is what keeps the belowEditor
 * widget (`▶ reviewer | # Task for reviewer`) out of the option list.
 */
export function parsePaneSnapshot(raw: string): PaneSnapshot {
  const lines = stripTrailingBlanks(String(raw ?? "").split(/\r?\n/));
  const snapshot: PaneSnapshot = {
    lines,
    text: lines.join("\n"),
    hasContent: lines.some((l) => l.trim().length > 0),
  };
  const footer = findDialogFooter(lines);
  if (footer === undefined) return snapshot;
  const regionStart = Math.max(0, footer - DIALOG_REGION_LINES);
  const region = lines.slice(regionStart, footer);
  // Preferred path: anchor on the highlighted row and read the whole list off
  // its column. Fallback: a glyph/number list with no visible highlight,
  // which is shown but never acted on automatically.
  const anchor = findSelectedAnchor(region);
  const block = anchor ? collectBlock(region, anchor) : findGlyphBlock(region);
  if (block.length === 0) return snapshot;

  const options: PaneOption[] = block.map((row, i) => ({
    index: i + 1,
    label: row.label,
    selected: row.selected,
  }));
  const selected = options.find((o) => o.selected);
  const dialog: PaneDialog = {
    options,
    ...(selected ? { selectedIndex: selected.index } : {}),
  };
  const blockStart = region.indexOf(block[0]!.raw);
  const title = anchor
    ? findTitle(region, blockStart, anchor.contentCol)
    : findTitle(region, blockStart, 0);
  if (title) dialog.title = title;
  return { ...snapshot, dialog };
}


/**
 * Is a choice list waiting for an answer RIGHT NOW?
 *
 * Used by the waiter to tell "the event was dequeued" from "the matter was
 * settled" (F12): a human who answered the dialog in the pane themselves
 * leaves no trace in the event file, but the list is gone from the screen.
 */
export function dialogIsOpen(snapshot: PaneSnapshot | undefined): boolean {
  return Boolean(snapshot?.dialog && snapshot.dialog.options.length >= 2);
}

/**
 * WHICH dialog this is — title plus the option labels, as one string.
 *
 * The identity, not the presence, is what tells "answered" from "still
 * waiting" when a session asks several questions in a row (R-5): the old
 * check was "is a dialog still on screen", so answering question 1 of a
 * 3-question interview — which immediately opens question 2 — was reported as
 * "could not confirm it was submitted". An orchestrator that believed that
 * receipt and retried would have answered question 2 with question 1's key.
 */
export function dialogSignature(dialog: PaneDialog | undefined): string | undefined {
  if (!dialog) return undefined;
  return [dialog.title ?? "", ...dialog.options.map((o) => o.label)].join("␟");
}


// ---------------------------------------------------------------------------
// Startup evidence (F7 / F8 — the receipt must not lie)
// ---------------------------------------------------------------------------

/**
 * Signatures that mean a pi session is RUNNING in this pane rather than a
 * bare shell prompt.
 *
 * They are matched against the whole capture, and any ONE of them is enough:
 * the question this answers is "did something start", not "which screen is
 * it on". Kept as substrings (not anchored patterns) because a TUI reflows
 * its status line freely.
 */
const PI_RUNNING_SIGNATURES: readonly string[] = Object.freeze([
  "review-gate",
  "Context",
  "context",
  "esc to interrupt",
  "ctrl+c",
  "/help",
  "tokens",
  "Thinking",
  "thinking",
]);

/**
 * The line pi renders for a message that arrived while a tool was running.
 *
 * It is the second delivery lane, and not knowing about it produced a FALSE
 * NEGATIVE that nearly caused a duplicate delivery (R-14): the message was
 * sitting in the child's steering queue — visible on screen as
 * `Steering: 项目经理给你发了一份说明…` — while the receipt said "无法确认子
 * 会话真的收到". An orchestrator that believes that receipt re-sends, and
 * re-sending into an open dialog is the R-13 accident.
 */
const STEERING_SIGNATURE = /(^|\n)\s*Steering:/;

/** What a delivery check actually observed. Every field is a measurement. */
export interface StartupEvidence {
  /** The pane rendered anything at all. */
  paneHasContent: boolean;
  /** A pi-looking status/prompt signature was on screen. */
  looksLikePi: boolean;
  /** The unique marker carried by this delivery appeared on screen. */
  markerVisible: boolean;
  /** The child wrote its own gate sidecar — it reached the extension. */
  sidecarPresent: boolean;
  /** The message is in the child's steering queue (R-14). */
  steeringQueued?: boolean;
}

export function emptyStartupEvidence(): StartupEvidence {
  return { paneHasContent: false, looksLikePi: false, markerVisible: false, sidecarPresent: false };
}

/** Collect the pane half of the evidence (the sidecar half is IO). */
export function readStartupEvidence(
  snapshot: PaneSnapshot | undefined,
  marker: string | undefined,
): Omit<StartupEvidence, "sidecarPresent"> {
  if (!snapshot) {
    return { paneHasContent: false, looksLikePi: false, markerVisible: false, steeringQueued: false };
  }
  const text = snapshot.text;
  return {
    paneHasContent: snapshot.hasContent,
    looksLikePi: PI_RUNNING_SIGNATURES.some((sig) => text.includes(sig)),
    markerVisible: Boolean(marker && marker.length > 0 && text.includes(marker)),
    steeringQueued: STEERING_SIGNATURE.test(text),
  };
}

/** One line naming exactly what was and was not observed. */
export function describeStartupEvidence(evidence: StartupEvidence): string {
  const yes = (v: boolean | undefined): string => (v ? "是" : "否");
  return (
    `pane 有内容=${yes(evidence.paneHasContent)}、` +
    `像 pi 在跑=${yes(evidence.looksLikePi)}、` +
    `任务标记可见=${yes(evidence.markerVisible)}、` +
    `进了 steering 队列=${yes(evidence.steeringQueued)}、` +
    `子会话 sidecar 已落盘=${yes(evidence.sidecarPresent)}`
  );
}


/** Render a snapshot for the agent, bounded and with the parse spelled out. */
export function formatPaneSnapshot(snapshot: PaneSnapshot, maxLines = PANE_READ_MAX_LINES): string {
  const shown = snapshot.lines.slice(-maxLines);
  const dropped = snapshot.lines.length - shown.length;
  const parts: string[] = [];
  if (snapshot.dialog) {
    const d = snapshot.dialog;
    parts.push(
      "### 解析出的对话框（来源：capture-pane 的启发式解析，可能不准；正文见下）",
      d.title ? `标题：${d.title}` : "标题：（没识别出来）",
      ...d.options.map((o) => `  ${o.selected ? "▶" : " "} ${o.index}. ${o.label}`),
      d.selectedIndex === undefined
        ? "当前高亮项：（没识别出来 —— `orchestrator_key` 无法据此计算方向键，请用低层按键）"
        : `当前高亮项：第 ${d.selectedIndex} 项`,
      "",
    );
  } else {
    parts.push("### 没有识别出选项式对话框（来源：capture-pane 解析）", "");
  }
  parts.push(
    `### pane 可见文本（来源：capture-pane，最后 ${shown.length} 行` +
    (dropped > 0 ? `，已省略更早的 ${dropped} 行` : "") + "）",
    shown.join("\n"),
  );
  return parts.join("\n");
}
