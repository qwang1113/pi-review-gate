import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DIALOG_ASSUMED_COLUMNS,
  DIALOG_BODY_MAX_LINES,
  displayWidth,
  fitDialogMessage,
  renderedRowCount,
  wrappedRowCount,
} from "../lib/dialog-budget.ts";

test("width counts CELLS, not characters: CJK is double-width", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("中文"), 4);
  assert.equal(displayWidth("中a文"), 5);
  // Full-width punctuation and CJK punctuation are wide too.
  assert.equal(displayWidth("（）"), 4);
  assert.equal(displayWidth("，。"), 4);
  // Combining marks and variation selectors add no cells.
  assert.equal(displayWidth("e\u0301"), 1);
  assert.equal(displayWidth("\u2500\ufe0f"), 1);
});

test("ANSI escapes and tabs do not lie about width", () => {
  assert.equal(displayWidth("\x1b[31mred\x1b[0m"), 3);
  assert.equal(displayWidth("\ta"), 5, "a tab is charged 4 cells");
});

test("soft wrapping is what costs rows — a CJK line wraps at half the characters", () => {
  // 80 columns: 80 ASCII chars = 1 row, 41 CJK chars = 82 cells = 2 rows.
  assert.equal(wrappedRowCount("x".repeat(80), 80), 1);
  assert.equal(wrappedRowCount("x".repeat(81), 80), 2);
  assert.equal(wrappedRowCount("中".repeat(40), 80), 1);
  assert.equal(wrappedRowCount("中".repeat(41), 80), 2);
  // An empty line still occupies a row.
  assert.equal(wrappedRowCount("", 80), 1);
  assert.equal(renderedRowCount("a\n\nb", 80), 3);
});

test("a dialog that fits is passed through untouched", () => {
  const msg = "第一行\n第二行\n第三行";
  const fitted = fitDialogMessage("标题", msg);
  assert.equal(fitted.message, msg);
  assert.equal(fitted.truncated, false);
  assert.ok(fitted.rows <= DIALOG_BODY_MAX_LINES);
});

test("an oversized dialog is cut to the budget WITH a pointer to the full text", () => {
  const msg = Array.from({ length: 60 }, (_, i) => `行 ${i}`).join("\n");
  const fitted = fitDialogMessage("标题", msg, "（完整内容见上方消息）");
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.rows <= DIALOG_BODY_MAX_LINES,
    `budget must hold (was ${fitted.rows} > ${DIALOG_BODY_MAX_LINES})`);
  assert.match(fitted.message, /完整内容见上方消息/);
  // The pointer is charged to the budget, not added on top of it.
  assert.ok(renderedRowCount("标题\n" + fitted.message) <= DIALOG_BODY_MAX_LINES);
});

test("ONE runaway line cannot blow the budget (hard character cut)", () => {
  // A single line with no newlines at all: dropping "whole lines" would either
  // keep all of it or none of it, so it has to be cut by characters.
  const fitted = fitDialogMessage("标题", "中".repeat(5000));
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.rows <= DIALOG_BODY_MAX_LINES,
    `budget must hold (was ${fitted.rows} > ${DIALOG_BODY_MAX_LINES})`);
});

test("a CJK dialog costs twice the rows of the same ASCII dialog", () => {
  // The bug this guards: budgeting by CHARACTERS lets a Chinese dialog render
  // at double the height it was budgeted for — which is exactly the flicker.
  const line = "字".repeat(DIALOG_ASSUMED_COLUMNS); // 160 cells = 2 rows each
  const msg = Array.from({ length: 8 }, () => line).join("\n");
  assert.equal(renderedRowCount(msg), 16, "8 CJK lines cost 16 rows, not 8");
  const fitted = fitDialogMessage("标题", msg);
  assert.ok(fitted.rows <= DIALOG_BODY_MAX_LINES,
    `budget must hold for wide text (was ${fitted.rows} > ${DIALOG_BODY_MAX_LINES})`);
});

test("a pathological title never makes the dialog taller", () => {
  const fitted = fitDialogMessage("标".repeat(2000), "正文");
  assert.equal(fitted.message, "", "nothing sane is left to show");
  assert.equal(fitted.truncated, true);
});
