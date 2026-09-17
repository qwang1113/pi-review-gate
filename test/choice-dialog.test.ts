import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHOICE_REASON_HINT,
  DECLINE_ROW,
  MAX_CHOICE_OPTIONS,
  REVISE_ROW,
  choiceRows,
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

// ---- rendering ----

function fakeUi(picks: { select?: string | undefined; editor?: string | undefined }): {
  ui: ChoiceUi;
  calls: { selects: string[][]; reasons: string[]; signals: (AbortSignal | undefined)[] };
} {
  const calls = { selects: [] as string[][], reasons: [] as string[], signals: [] as (AbortSignal | undefined)[] };
  return {
    ui: {
      select: async (_title, options) => { calls.selects.push(options); return picks.select; },
      editor: async (title, opts) => {
        calls.reasons.push(title);
        calls.signals.push(opts?.signal);
        return picks.editor;
      },
    },
    calls,
  };
}

test("the signal reaches the reason editor — that is what takes the box down", async () => {
  const { ui, calls } = fakeUi({ select: DECLINE_ROW, editor: "x" });
  const controller = new AbortController();
  await renderChoice(ui, spec(), { signal: controller.signal });
  assert.equal(calls.signals[0], controller.signal);
});

test("picking an option returns it and never opens the reason box", async () => {
  const { ui, calls } = fakeUi({ select: "B" });
  assert.equal(await renderChoice(ui, spec()), "B");
  assert.deepEqual(calls.reasons, []);
});

test("picking the decline row opens the reason EDITOR and returns row + reason", async () => {
  const { ui, calls } = fakeUi({ select: DECLINE_ROW, editor: "  两个都不行  " });
  assert.equal(await renderChoice(ui, spec()), `${DECLINE_ROW}：两个都不行`);
  assert.equal(calls.reasons.length, 1);
  assert.match(calls.reasons[0] ?? "", /不选的原因/);
  assert.match(calls.reasons[0] ?? "", /!chat/, "the hint travels with the editor's title");
});

test("an empty reason still returns the bare decline row", async () => {
  const { ui } = fakeUi({ select: DECLINE_ROW, editor: "   " });
  assert.equal(await renderChoice(ui, spec()), DECLINE_ROW);
});

test("a dismissed reason box is a dismissal — the user backed out of both halves", async () => {
  const { ui } = fakeUi({ select: DECLINE_ROW, editor: undefined });
  assert.equal(await renderChoice(ui, spec()), undefined);
});

test("no UI at all is a dismissal, never an invented answer", async () => {
  assert.equal(await renderChoice(undefined, spec()), undefined);
  assert.equal(await renderChoice({}, spec()), undefined);
});

test("the body rides on BOTH titles: the list's and the reason editor's", async () => {
  const { ui, calls } = fakeUi({ select: DECLINE_ROW, editor: "x" });
  await renderChoice(ui, spec(), { body: "补充说明" });
  assert.deepEqual(calls.selects, [["A（推荐）", "B", DECLINE_ROW]]);
  // An interview question's list title is a bare `问题 n / m`, so an editor
  // that repeated only that would ask the user to explain themselves about a
  // question it never showed (user decision, 2026-09-17).
  assert.match(calls.reasons[0] ?? "", /补充说明/);
});

test("the default reason hint advertises no escape that is not honored", () => {
  assert.match(CHOICE_REASON_HINT, /!chat/);
  assert.doesNotMatch(CHOICE_REASON_HINT, /skip/i,
    "the skip-the-rest escape is gone with the row that used to advertise it");
  assert.ok(MAX_CHOICE_OPTIONS >= 2);
});
