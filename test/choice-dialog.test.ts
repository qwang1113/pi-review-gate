import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACK_ROW,
  CHOICE_REASON_HINT,
  DECLINE_ROW,
  MAX_CHOICE_OPTIONS,
  REVISE_ROW,
  choiceRows,
  createDialogQueue,
  dialogNotifyDetail,
  dialogSignal,
  looksLikeDeclineRow,
  optionLabel,
  optionLetter,
  optionRow,
  parseChoice,
  renderChoice,
  rowIndexOf,
  validateChoice,
  type ChoiceSpec,
  type ChoiceUi,
} from "../lib/choice-dialog.ts";
import { REASON_EDITOR_BACK } from "../lib/reason-editor.ts";

const spec = (over: Partial<ChoiceSpec> = {}): ChoiceSpec => ({
  title: "选一个？",
  options: ["继续", "停止"],
  recommended: "继续",
  ...over,
});

// ---- the shape ----

test("the rows are the lettered options (recommended marked) plus the decline row", () => {
  assert.deepEqual(choiceRows(spec()), ["A. 继续（推荐）", "B. 停止", DECLINE_ROW]);
});

test("the letters run A, B, C, D from the first option", () => {
  assert.deepEqual(
    choiceRows(spec({ options: ["一", "二", "三", "四"], recommended: "二" })),
    ["A. 一", "B. 二（推荐）", "C. 三", "D. 四", DECLINE_ROW]);
  assert.equal(optionLetter(0), "A");
  assert.equal(optionLetter(3), "D");
});

test("a caller may rename the decline row — the approval wording", () => {
  assert.deepEqual(choiceRows(spec({ declineRow: REVISE_ROW })),
    ["A. 继续（推荐）", "B. 停止", REVISE_ROW]);
  assert.ok(looksLikeDeclineRow(REVISE_ROW));
  assert.ok(looksLikeDeclineRow(DECLINE_ROW));
  assert.equal(looksLikeDeclineRow("A. 继续"), false, "a lettered row is not a decline row");
});

test("the navigation rows carry no letter — they are not answers", () => {
  assert.doesNotMatch(DECLINE_ROW, /^[A-Z]\. /);
  assert.doesNotMatch(BACK_ROW, /^[A-Z]\. /);
});

test("only the recommended option carries the marker", () => {
  assert.equal(optionRow("继续", "继续", 0), "A. 继续（推荐）");
  assert.equal(optionRow("继续", "停止", 0), "A. 继续");
});

test("the record writes an option with its letter, and free text unchanged", () => {
  assert.equal(optionLabel("停止", ["继续", "停止"]), "B. 停止");
  assert.equal(optionLabel("别的话", ["继续", "停止"]), "别的话");
});

// ---- validation ----

test("a well-formed question passes", () => {
  assert.equal(validateChoice(["继续", "停止"], "继续"), undefined);
});

test("fewer than two options is refused, with the reason", () => {
  assert.match(validateChoice(["继续"], "继续", "第 2 个问题") ?? "", /第 2 个问题只有 1 个选项/);
  assert.match(validateChoice([], "继续") ?? "", /只有 0 个选项/);
  assert.match(validateChoice(undefined, "继续") ?? "", /只有 0 个选项/);
});

test("a missing or unknown recommendation is refused", () => {
  assert.match(validateChoice(["继续", "停止"], undefined) ?? "", /没有 recommended/);
  assert.match(validateChoice(["继续", "停止"], "第三个") ?? "", /不在选项里/);
});

test("duplicate options are refused", () => {
  assert.match(validateChoice(["继续", "继续"], "继续") ?? "", /重复选项/);
});

// ---- parsing ----

test("a chosen option comes back as the caller wrote it", () => {
  assert.deepEqual(parseChoice("A. 继续（推荐）", spec()), { kind: "chose", option: "继续" });
  assert.deepEqual(parseChoice("B. 停止", spec()), { kind: "chose", option: "停止" });
});

test("every shape of the same answer lands on the same option", () => {
  const s = spec();
  for (const picked of ["继续", "A", "a", "A.", "A)", "A. 继续", "A. 继续（推荐）"]) {
    assert.deepEqual(parseChoice(picked, s), { kind: "chose", option: "继续" }, picked);
  }
  assert.deepEqual(parseChoice("2", s), { kind: "chose", option: "停止" });
  assert.deepEqual(parseChoice("B. 停止", s), { kind: "chose", option: "停止" });
});

test("an option whose own text is a letter beats the letter index", () => {
  // `A` is a perfectly legal option text; the exact match must win over the
  // positional reading, or the row labelled `B. A` could never be chosen.
  const s = spec({ options: ["B", "A"], recommended: "B" });
  assert.deepEqual(parseChoice("A", s), { kind: "chose", option: "A" });
});

test("the position rule is ONE function, shared by the pane parser and the channel parser", () => {
  assert.equal(rowIndexOf("A"), 0);
  assert.equal(rowIndexOf("b"), 1);
  assert.equal(rowIndexOf("C."), 2);
  assert.equal(rowIndexOf("d、"), 3);
  assert.equal(rowIndexOf("  A  "), 0, "the answer is trimmed like every other form");
  assert.equal(rowIndexOf("1"), 0, "the 1-based index is the same rule, read the same way");
  assert.equal(rowIndexOf(" 2 "), 1);
  assert.equal(rowIndexOf("AB"), undefined, "two letters are not an answer");
  assert.equal(rowIndexOf("A1"), undefined);
  assert.equal(rowIndexOf("继续"), undefined);
  assert.equal(rowIndexOf(""), undefined);
});

test("a letter past the end of the list is not an answer", () => {
  assert.deepEqual(parseChoice("D", spec()), { kind: "chose", option: "D" },
    "beyond the options it is just text, and text is the caller's to interpret");
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

/**
 * A dialog host driven from a script: one entry per call, the last one
 * repeating. The interview asks the SAME question more than once (`← 返回上一题`
 * back to the list), so a single fixed answer can no longer express what the
 * user did.
 */
function fakeUi(picks: {
  selects?: Array<string | undefined>;
  editors?: Array<string | undefined>;
} = {}): {
  ui: ChoiceUi;
  calls: {
    selects: string[][];
    reasons: string[];
    prefills: (string | undefined)[];
    signals: (AbortSignal | undefined)[];
  };
} {
  const calls = {
    selects: [] as string[][],
    reasons: [] as string[],
    prefills: [] as (string | undefined)[],
    signals: [] as (AbortSignal | undefined)[],
  };
  const at = <T>(list: T[] | undefined, index: number): T | undefined =>
    list?.[Math.min(index, list.length - 1)];
  return {
    ui: {
      select: async (_title, options) => {
        calls.selects.push(options);
        return at(picks.selects, calls.selects.length - 1);
      },
      editor: async (title, opts) => {
        calls.reasons.push(title);
        calls.prefills.push(opts?.prefill);
        calls.signals.push(opts?.signal);
        return at(picks.editors, calls.reasons.length - 1);
      },
    },
    calls,
  };
}

test("the signal reaches the reason editor — that is what takes the box down", async () => {
  const { ui, calls } = fakeUi({ selects: [DECLINE_ROW], editors: ["x"] });
  const controller = new AbortController();
  await renderChoice(ui, spec(), { signal: controller.signal });
  assert.equal(calls.signals[0], controller.signal);
});

test("picking an option returns it and never opens the reason box", async () => {
  const { ui, calls } = fakeUi({ selects: ["B. 停止"] });
  assert.equal(await renderChoice(ui, spec()), "B. 停止");
  assert.deepEqual(calls.reasons, []);
});

test("picking the decline row opens the reason EDITOR and returns row + reason", async () => {
  const { ui, calls } = fakeUi({ selects: [DECLINE_ROW], editors: ["  两个都不行  "] });
  assert.equal(await renderChoice(ui, spec()), `${DECLINE_ROW}：两个都不行`);
  assert.equal(calls.reasons.length, 1);
  assert.match(calls.reasons[0] ?? "", /不选的原因/);
  assert.match(calls.reasons[0] ?? "", /!chat/, "the hint travels with the editor's title");
});

test("an empty reason still returns the bare decline row", async () => {
  const { ui } = fakeUi({ selects: [DECLINE_ROW], editors: ["   "] });
  assert.equal(await renderChoice(ui, spec()), DECLINE_ROW);
});

test("a dismissed reason box is a dismissal — the user backed out of both halves", async () => {
  const { ui } = fakeUi({ selects: [DECLINE_ROW], editors: [undefined] });
  assert.equal(await renderChoice(ui, spec()), undefined);
});

// ---- the way back (2026-09-19) ----

test("the back row is drawn only where a caller asks for it, and always LAST", async () => {
  const withBack = fakeUi({ selects: ["B. 停止"] });
  await renderChoice(withBack.ui, spec(), { back: true });
  assert.deepEqual(withBack.calls.selects, [["A. 继续（推荐）", "B. 停止", DECLINE_ROW, BACK_ROW]]);
  const without = fakeUi({ selects: ["B. 停止"] });
  await renderChoice(without.ui, spec());
  assert.deepEqual(without.calls.selects, [["A. 继续（推荐）", "B. 停止", DECLINE_ROW]]);
});

test("the back row comes back as itself — the caller reads it with stepInterview", async () => {
  const { ui } = fakeUi({ selects: [BACK_ROW], editors: ["x"] });
  // `back: false` still returns the row if a host handed it over; only the
  // caller decides what it means (lib/ask-user.ts `stepInterview`).
  assert.equal(await renderChoice(ui, spec()), BACK_ROW);
});

test("ESC in the reason box goes BACK to the list, keeping what was typed", async () => {
  const { ui, calls } = fakeUi({
    selects: [DECLINE_ROW, "B. 停止"],
    editors: [`${REASON_EDITOR_BACK}写到一半`],
  });
  assert.equal(await renderChoice(ui, spec()), "B. 停止");
  assert.equal(calls.selects.length, 2, "the list is shown again after backing out");
  assert.equal(calls.prefills[0], undefined, "nothing to prefill on the first opening");
});

test("the text typed before backing out prefills the next opening", async () => {
  const { ui, calls } = fakeUi({
    selects: [DECLINE_ROW, DECLINE_ROW],
    editors: [`${REASON_EDITOR_BACK}写到一半`, "写完了"],
  });
  assert.equal(await renderChoice(ui, spec()), `${DECLINE_ROW}：写完了`);
  assert.deepEqual(calls.prefills, [undefined, "写到一半"]);
});

test("backing out with an empty box keeps the earlier text, not the emptiness", async () => {
  const { ui, calls } = fakeUi({
    selects: [DECLINE_ROW, DECLINE_ROW],
    editors: [`${REASON_EDITOR_BACK}先写的`, REASON_EDITOR_BACK, "最后"],
  });
  assert.equal(await renderChoice(ui, spec()), `${DECLINE_ROW}：最后`);
  assert.deepEqual(calls.prefills, [undefined, "先写的", "先写的"]);
});

test("no UI at all is a dismissal, never an invented answer", async () => {
  assert.equal(await renderChoice(undefined, spec()), undefined);
  assert.equal(await renderChoice({}, spec()), undefined);
});

test("the body rides on BOTH titles: the list's and the reason editor's", async () => {
  const { ui, calls } = fakeUi({ selects: [DECLINE_ROW], editors: ["x"] });
  await renderChoice(ui, spec(), { body: "补充说明" });
  assert.deepEqual(calls.selects, [["A. 继续（推荐）", "B. 停止", DECLINE_ROW]]);
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

// ---------------------------------------------------------------------------
// One dialog at a time (2026-09-18)
//
// THE HANG THIS PREVENTS, as measured: pi runs one assistant message's tool
// calls in parallel (`Promise.all`, unbreakable by an abort) and the host has
// ONE dialog slot — a second box replaces the first, whose promise is then
// never settled again. Two gate dialogs in one message therefore froze a
// session for good (rebate session 01a0b328).
// ---------------------------------------------------------------------------

/** Let every queued microtask run before the assertion looks. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the banner is head + question, and never a dangling separator", () => {
  assert.equal(dialogNotifyDetail(spec({ title: "问题 1 / 4" }), "PR 176 的限流要撤哪些？"),
    "问题 1 / 4 · PR 176 的限流要撤哪些？",
    "a progress label alone tells the user nothing about what they are being asked");
  assert.equal(dialogNotifyDetail(spec({ title: "review-gate: AI 请求缩小审查范围" })),
    "review-gate: AI 请求缩小审查范围", "a dialog with no body keeps its head alone");
  assert.equal(dialogNotifyDetail(spec({ title: "  " }), "只有正文"), "只有正文",
    "no head, no separator");
  assert.equal(dialogNotifyDetail(spec({ title: "T" }), "   "), "T", "a blank body is not a body");
});

test("the second box does not open under the first one", async () => {
  const schedule = createDialogQueue();
  const order: string[] = [];
  let answerFirst!: () => void;
  const firstAnswered = new Promise<void>((resolve) => { answerFirst = resolve; });

  const first = schedule(async () => {
    order.push("first:opened");
    await firstAnswered;
    order.push("first:closed");
    return "a";
  });
  const second = schedule(async () => {
    order.push("second:opened");
    return "b";
  });

  await settle();
  assert.deepEqual(order, ["first:opened"], "the second box must not be raised while the first is up");

  answerFirst();
  assert.equal(await first, "a");
  assert.equal(await second, "b");
  assert.deepEqual(order, ["first:opened", "first:closed", "second:opened"]);
});

test("each dialog gets its own answer back, in order", async () => {
  const schedule = createDialogQueue();
  const answers = await Promise.all([
    schedule(async () => "one"),
    schedule(async () => "two"),
    schedule(async () => "three"),
  ]);
  assert.deepEqual(answers, ["one", "two", "three"]);
});

test("a dialog that THREW does not wedge the queue", async () => {
  const schedule = createDialogQueue();
  const boom = schedule(async (): Promise<string> => { throw new Error("boom"); });
  const after = schedule(async () => "still serving");
  await assert.rejects(boom, /boom/);
  assert.equal(await after, "still serving",
    "a queue that stops serving after one error is the same hang under a different name");
});

test("a dialog cancelled while it QUEUES comes back at once, not when the other box closes", async () => {
  const schedule = createDialogQueue();
  const order: string[] = [];
  let answerFirst!: () => void;
  const firstAnswered = new Promise<void>((resolve) => { answerFirst = resolve; });

  const first = schedule(async () => {
    order.push("first:opened");
    await firstAnswered;
    order.push("first:closed");
    return "a";
  });

  const cancelled = new AbortController();
  const second = schedule(async () => {
    order.push("second:opened");
    return "b";
  }, cancelled.signal);

  // Reviewer P1 of the 2026-09-18 round: waiting for a turn lasts as long as
  // the box in front stays open, and the other side may have answered
  // meanwhile (an orchestrator through the channel, an ESC). A waiter that
  // kept waiting would strand its own tool on an unrelated dialog.
  cancelled.abort();
  assert.equal(await second, undefined, "the cancelled dialog returns without ever opening");
  assert.deepEqual(order, ["first:opened"], "…and the box that is up is untouched");

  // …and the queue keeps serving whoever is behind it.
  const third = schedule(async () => { order.push("third:opened"); return "c"; });
  answerFirst();
  assert.equal(await first, "a");
  assert.equal(await third, "c", "a cancelled waiter releases its place");
  assert.deepEqual(order, ["first:opened", "first:closed", "third:opened"]);
});

test("a cancelled waiter with someone behind it still holds the turn", async () => {
  // The bug this pins (caught by the first draft of the cancellation fix): a
  // cancelled waiter that simply released its promise let the NEXT dialog skip
  // the box it was waiting for and open a second one on top of it.
  const schedule = createDialogQueue();
  const order: string[] = [];
  let answerFirst!: () => void;
  const firstAnswered = new Promise<void>((resolve) => { answerFirst = resolve; });

  const first = schedule(async () => {
    order.push("first:opened");
    await firstAnswered;
    order.push("first:closed");
    return "a";
  });
  const cancelled = new AbortController();
  const second = schedule(async () => { order.push("second:opened"); return "b"; }, cancelled.signal);
  const third = schedule(async () => { order.push("third:opened"); return "c"; });

  cancelled.abort();
  assert.equal(await second, undefined);
  await settle();
  assert.deepEqual(order, ["first:opened"],
    "the waiter behind a cancelled one still waits for the SAME box, not for a settled promise");

  answerFirst();
  assert.equal(await first, "a");
  assert.equal(await third, "c");
  assert.deepEqual(order, ["first:opened", "first:closed", "third:opened"]);
});

test("a signal that was already aborted never opens a box", async () => {
  const schedule = createDialogQueue();
  const dead = new AbortController();
  dead.abort();
  let opened = false;
  assert.equal(await schedule(async () => { opened = true; return "x"; }, dead.signal), undefined);
  assert.equal(opened, false, "nothing is rendered for a dialog nobody is waiting for");
});

test("the host's abort and the caller's own are ONE signal for the dialog", () => {
  assert.equal(dialogSignal(), undefined, "no signal at all is a shape several callers produce");
  assert.equal(dialogSignal(undefined, undefined), undefined);

  const only = new AbortController();
  assert.equal(dialogSignal(only.signal), only.signal, "a single source is passed through, not cloned");
  assert.equal(dialogSignal(undefined, only.signal, undefined), only.signal);

  // The caller's own: an orchestrator answers, or an instruct arrives.
  const host = new AbortController();
  const caller = new AbortController();
  const both = dialogSignal(host.signal, caller.signal)!;
  assert.equal(both.aborted, false);
  caller.abort();
  assert.equal(both.aborted, true);

  // The host's: `ExtensionContext.signal`, which an ESC aborts — without it a
  // box stays on screen after the run was cancelled.
  const host2 = new AbortController();
  const caller2 = new AbortController();
  const both2 = dialogSignal(host2.signal, caller2.signal)!;
  host2.abort();
  assert.equal(both2.aborted, true);
  assert.equal(caller2.signal.aborted, false, "one side aborting must not abort the other side's controller");

  const dead = new AbortController();
  dead.abort();
  assert.equal(dialogSignal(dead.signal, new AbortController().signal)!.aborted, true,
    "an already-aborted source makes the dialog dead on arrival");
});
