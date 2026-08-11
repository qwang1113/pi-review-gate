/**
 * Real-render regression: an oversized confirm dialog makes pi-tui wipe the
 * screen on every spinner frame.
 *
 * This test drives the ACTUAL renderer (`TuiMainScreen`) rather than asserting
 * on our own arithmetic, because the failure lives in pi-tui's differential
 * renderer, not in our code:
 *
 *   - `ui.confirm` renders `title + "\n" + message` as one unclipped block in
 *     the editor container at the bottom of the screen;
 *   - the working spinner keeps animating while a tool awaits the dialog, and
 *     the spinner row sits ABOVE that container;
 *   - once the dialog plus everything under it is as tall as the terminal, the
 *     spinner row falls above `prevViewportTop`, and pi-tui answers every
 *     one-line change with `fullRender(true)` -> `\x1b[2J\x1b[H\x1b[3J`
 *     (clear screen + clear scrollback).
 *
 * pi-tui is not a dependency of this repo (it ships inside the globally
 * installed pi), so the test SKIPS when it cannot be resolved. It is a
 * regression net for the machine that has pi installed, not a CI gate — the
 * always-on guards are the row budget unit tests (test/dialog-budget.test.ts)
 * and the structural assertions (test/extension-structure.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { DIALOG_BODY_MAX_LINES, DIALOG_CHROME_ROWS, DIALOG_FOOTER_ROWS } from "../lib/dialog-budget.ts";

const TUI_RELATIVE = join("@earendil-works", "pi-tui", "dist", "tui-main-screen.js");

/** Locate pi-tui without depending on it: nested in pi-coding-agent, or global. */
function resolveTuiMainScreen(): string | undefined {
  const candidates: string[] = [];
  const require = createRequire(import.meta.url);
  try {
    const agentPkg = require.resolve("@earendil-works/pi-coding-agent/package.json");
    candidates.push(join(dirname(agentPkg), "node_modules", TUI_RELATIVE));
  } catch { /* not installed here */ }
  // Globally installed pi: <node prefix>/lib/node_modules/...
  const prefix = resolve(dirname(process.execPath), "..");
  const globalAgent = join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  candidates.push(join(globalAgent, "node_modules", TUI_RELATIVE));
  candidates.push(join(prefix, "lib", "node_modules", TUI_RELATIVE));
  return candidates.find((p) => existsSync(p));
}

class FakeTerminal {
  writes: string[] = [];
  rows: number;
  columns: number;
  constructor(rows: number, columns: number) {
    this.rows = rows;
    this.columns = columns;
  }
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  get kittyProtocolActive(): boolean { return false; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

class Lines {
  lines: string[];
  constructor(lines: string[]) {
    this.lines = lines;
  }
  render(): string[] { return this.lines; }
  invalidate(): void {}
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface Scenario {
  rows: number;
  transcriptLines: number;
  dialogRows: number;
  frames: number;
}

/** Render `frames` spinner animation frames and count full-screen clears. */
async function countFullClears(TuiMainScreen: new (t: unknown, c: boolean, d: string) => {
  addChild(c: unknown): void;
  doRender(): void;
}, s: Scenario): Promise<number> {
  const term = new FakeTerminal(s.rows, 100);
  const tui = new TuiMainScreen(term, false, "/tmp");

  const transcript = new Lines(Array.from({ length: s.transcriptLines }, (_, i) => `transcript ${i}`));
  // The working loader: one row, changes every frame, ABOVE the dialog.
  const spinner = new Lines(["⠋ working"]);
  // The confirm dialog: one unclipped block in the editor container.
  const dialog = new Lines(Array.from({ length: s.dialogRows }, (_, i) => `dialog ${i}`));
  const footer = new Lines(Array.from({ length: DIALOG_FOOTER_ROWS }, () => "gate: loop · review: PENDING"));

  tui.addChild(transcript);
  tui.addChild(spinner);
  tui.addChild(dialog);
  tui.addChild(footer);

  tui.doRender(); // first paint
  term.writes.length = 0;
  for (let f = 0; f < s.frames; f++) {
    spinner.lines = [`${SPINNER[f % SPINNER.length]} working`];
    tui.doRender();
  }
  return term.writes.join("").split("\x1b[2J").length - 1;
}

const tuiPath = resolveTuiMainScreen();

test("FLICKER: a dialog within the row budget never triggers a full-screen clear", async (t) => {
  if (!tuiPath) {
    t.skip("pi-tui not resolvable (it ships with the globally installed pi, not with this repo)");
    return;
  }
  const { TuiMainScreen } = await import(tuiPath);
  // The budget is sized for a 24-row terminal; the dialog is chrome + body.
  const clears = await countFullClears(TuiMainScreen, {
    rows: 24,
    transcriptLines: 30,
    dialogRows: DIALOG_CHROME_ROWS + DIALOG_BODY_MAX_LINES,
    frames: 30,
  });
  assert.equal(clears, 0, "a budgeted dialog must not wipe the screen while the spinner animates");
});

test("FLICKER: the pre-fix dialog height reproduces the wipe (regression is real)", async (t) => {
  if (!tuiPath) {
    t.skip("pi-tui not resolvable (it ships with the globally installed pi, not with this repo)");
    return;
  }
  const { TuiMainScreen } = await import(tuiPath);
  // What propose_loop_goal used to send: chrome + a full goal inlined.
  const clears = await countFullClears(TuiMainScreen, {
    rows: 24,
    transcriptLines: 30,
    dialogRows: DIALOG_CHROME_ROWS + 45,
    frames: 30,
  });
  assert.ok(clears >= 20,
    `an oversized dialog must still reproduce the wipe (got ${clears}/30 — if this dropped to 0, ` +
    "pi-tui changed and the budget's justification should be re-measured)");
});

test("FLICKER: the threshold is geometric — it flips when the dialog reaches terminal height", async (t) => {
  if (!tuiPath) {
    t.skip("pi-tui not resolvable (it ships with the globally installed pi, not with this repo)");
    return;
  }
  const { TuiMainScreen } = await import(tuiPath);
  const rows = 24;
  // "dialog + everything under it" is what matters: at rows-1 it is safe, at
  // rows the spinner leaves the viewport and every frame clears the screen.
  const safe = await countFullClears(TuiMainScreen, {
    rows, transcriptLines: 30, dialogRows: rows - 1 - DIALOG_FOOTER_ROWS, frames: 10,
  });
  const over = await countFullClears(TuiMainScreen, {
    rows, transcriptLines: 30, dialogRows: rows - DIALOG_FOOTER_ROWS, frames: 10,
  });
  assert.equal(safe, 0, "one row below the terminal height is safe");
  assert.ok(over > 0, "at terminal height the wipe starts");
});
