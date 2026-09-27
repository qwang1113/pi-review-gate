/**
 * THE SIDEBAR'S PREVIEW (t7): capture argv, the column split, cutting the
 * captured text and putting it beside the list. Pure, no tmux.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildCaptureArgv, joinColumns, LIST_WIDTH, previewLines, splitColumns } from "../lib/tmux-sidebar-preview.ts";
import { displayWidth } from "../lib/tmux-sidebar-render.ts";

test("capture is plain text of the target pane", () => {
  assert.deepEqual(buildCaptureArgv("%4"), ["capture-pane", "-p", "-t", "%4"]);
});

test("columns: list keeps its width, the rest minus a divider previews", () => {
  assert.deepEqual(splitColumns(100), { list: LIST_WIDTH, preview: 100 - LIST_WIDTH - 1 });
  // Too narrow for a useful preview ⇒ the list takes everything.
  assert.deepEqual(splitColumns(LIST_WIDTH + 5), { list: LIST_WIDTH + 5, preview: 0 });
  assert.deepEqual(splitColumns(20), { list: 20, preview: 0 });
});

test("preview keeps the bottom rows, drops trailing blanks, cuts to width", () => {
  const captured = "one\ntwo\nthree\nfour\n\n\n";
  assert.deepEqual(previewLines(captured, 10, 2), ["three", "four"]);
  assert.deepEqual(previewLines("abcdefghijkl", 5, 3), ["abcd…"]);
  assert.deepEqual(previewLines("", 10, 3), []);
  assert.deepEqual(previewLines("x", 10, 0), []);
});

test("preview cuts CJK by display width and strips control characters", () => {
  const [row] = previewLines("中文中文中文", 7, 1);
  assert.ok(displayWidth(row) <= 7, row);
  assert.deepEqual(previewLines("a\x1b[2Jb\x07c", 20, 1), ["a [2Jb c"]);
});

test("joinColumns pads a short list and always yields `height` rows", () => {
  const rows = joinColumns(["L1        "], ["p1", "p2"], 10, 3);
  assert.equal(rows.length, 3);
  assert.equal(rows[0], "L1        \x1b[2m│\x1b[0mp1");
  assert.equal(rows[1], `${" ".repeat(10)}\x1b[2m│\x1b[0mp2`);
  assert.equal(rows[2], `${" ".repeat(10)}\x1b[2m│\x1b[0m`);
});
