import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHOICE_REASON_HINT,
  DECLINE_ROW,
  MAX_CHOICE_OPTIONS,
  REVISE_ROW,
  choiceRows,
  formatChoice,
  isDeclineLine,
  looksLikeDeclineRow,
  optionRow,
  parseChoice,
  renderChoice,
  validateChoice,
  type ChoiceSpec,
  type ChoiceUi,
} from "../lib/choice-dialog.ts";

const spec = (over: Partial<ChoiceSpec> = {}): ChoiceSpec => ({
  title: "选一个？",
  options: ["A", "B"],
  recommended: "A",
  ...over,
});

// ---- the shape ----

test("the rows are the options (recommended marked) plus the decline row", () => {
  assert.deepEqual(choiceRows(spec()), ["A（推荐）", "B", DECLINE_ROW]);
});

test("a caller may rename the decline row — the approval wording", () => {
  assert.deepEqual(choiceRows(spec({ declineRow: REVISE_ROW })), ["A（推荐）", "B", REVISE_ROW]);
  assert.ok(looksLikeDeclineRow(REVISE_ROW));
  assert.ok(looksLikeDeclineRow(DECLINE_ROW));
  assert.equal(looksLikeDeclineRow("A"), false);
});

test("only the recommended option carries the marker", () => {
  assert.equal(optionRow("A", "A"), "A（推荐）");
  assert.equal(optionRow("A", "B"), "A");
});

test("headless text carries the same rows as the dialog", () => {
  const text = formatChoice(spec());
  assert.match(text, /选一个？/);
  assert.match(text, /- A（推荐）/);
  assert.match(text, /- B/);
  assert.match(text, new RegExp(`- ${DECLINE_ROW}`));
});

// ---- validation ----

test("a well-formed question passes", () => {
  assert.equal(validateChoice(["A", "B"], "A"), undefined);
});

test("fewer than two options is refused, with the reason", () => {
  assert.match(validateChoice(["A"], "A", "第 2 个问题") ?? "", /第 2 个问题只有 1 个选项/);
  assert.match(validateChoice([], "A") ?? "", /只有 0 个选项/);
  assert.match(validateChoice(undefined, "A") ?? "", /只有 0 个选项/);
});

test("a missing or unknown recommendation is refused", () => {
  assert.match(validateChoice(["A", "B"], undefined) ?? "", /没有 recommended/);
  assert.match(validateChoice(["A", "B"], "C") ?? "", /不在选项里/);
});

test("duplicate options are refused", () => {
  assert.match(validateChoice(["A", "A"], "A") ?? "", /重复选项/);
});

// ---- parsing ----

test("a chosen option comes back as the caller wrote it", () => {
  assert.deepEqual(parseChoice("A（推荐）", spec()), { kind: "chose", option: "A" });
  assert.deepEqual(parseChoice("B", spec()), { kind: "chose", option: "B" });
});

test("the decline row comes back with its reason", () => {
  assert.deepEqual(parseChoice(`${DECLINE_ROW}：太贵了`, spec()),
    { kind: "declined", reason: "太贵了" });
  assert.deepEqual(parseChoice(`${DECLINE_ROW}: too expensive`, spec()),
    { kind: "declined", reason: "too expensive" });
});

test("an empty reason is still a decline, not a dismissal", () => {
  assert.deepEqual(parseChoice(DECLINE_ROW, spec()), { kind: "declined", reason: "" });
});

test("nothing picked is a dismissal", () => {
  assert.deepEqual(parseChoice(undefined, spec()), { kind: "dismissed" });
});

test("an unknown line is returned verbatim — the caller decides what it means", () => {
  assert.deepEqual(parseChoice("自由文本", spec()), { kind: "chose", option: "自由文本" });
});

test("isDeclineLine recognizes both halves of the row", () => {
  assert.equal(isDeclineLine(DECLINE_ROW, spec()), true);
  assert.equal(isDeclineLine(`${DECLINE_ROW}：x`, spec()), true);
  assert.equal(isDeclineLine("A", spec()), false);
});

// ---- rendering ----

function fakeUi(picks: { select?: string | undefined; input?: string | undefined }): {
  ui: ChoiceUi;
  calls: { selects: string[][]; inputs: string[] };
} {
  const calls = { selects: [] as string[][], inputs: [] as string[] };
  return {
    ui: {
      select: async (_title, options) => { calls.selects.push(options); return picks.select; },
      input: async (title) => { calls.inputs.push(title); return picks.input; },
    },
    calls,
  };
}

test("picking an option returns it and never opens the reason box", async () => {
  const { ui, calls } = fakeUi({ select: "B" });
  assert.equal(await renderChoice(ui, spec()), "B");
  assert.deepEqual(calls.inputs, []);
});

test("picking the decline row opens the reason box and returns row + reason", async () => {
  const { ui, calls } = fakeUi({ select: DECLINE_ROW, input: "  两个都不行  " });
  assert.equal(await renderChoice(ui, spec()), `${DECLINE_ROW}：两个都不行`);
  assert.equal(calls.inputs.length, 1);
  assert.match(calls.inputs[0] ?? "", /不选的原因/);
});

test("an empty reason box still returns the bare decline row", async () => {
  const { ui } = fakeUi({ select: DECLINE_ROW, input: "   " });
  assert.equal(await renderChoice(ui, spec()), DECLINE_ROW);
});

test("a dismissed reason box is a dismissal — the user backed out of both halves", async () => {
  const { ui } = fakeUi({ select: DECLINE_ROW, input: undefined });
  assert.equal(await renderChoice(ui, spec()), undefined);
});

test("no UI at all is a dismissal, never an invented answer", async () => {
  assert.equal(await renderChoice(undefined, spec()), undefined);
  assert.equal(await renderChoice({}, spec()), undefined);
});

test("the body is appended to the title and the rows stay the template's", async () => {
  const { ui, calls } = fakeUi({ select: "A" });
  await renderChoice(ui, spec(), { body: "补充说明" });
  assert.deepEqual(calls.selects, [["A（推荐）", "B", DECLINE_ROW]]);
});

test("extra rows ride along without becoming part of the template", async () => {
  const { ui, calls } = fakeUi({ select: "⏭ 跳过后续问题" });
  assert.equal(await renderChoice(ui, spec(), { extraRows: ["⏭ 跳过后续问题"] }), "⏭ 跳过后续问题");
  assert.deepEqual(calls.selects, [["A（推荐）", "B", DECLINE_ROW, "⏭ 跳过后续问题"]]);
});

test("the default reason hint names the interview escapes", () => {
  assert.match(CHOICE_REASON_HINT, /!chat/);
  assert.match(CHOICE_REASON_HINT, /!skip/);
  assert.ok(MAX_CHOICE_OPTIONS >= 2);
});
