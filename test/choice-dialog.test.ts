import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHOICE_REASON_HINT,
  DECLINE_ROW,
  MAX_CHOICE_OPTIONS,
  REVISE_ROW,
  choiceRows,
  createDialogQueue,
  dialogNotifyDetail,
  dialogSignal,
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
