/**
 * THE CHECKBOX SHAPE — rows, parsing, the key state machine, the box itself.
 *
 * WHAT MAKES THIS SHAPE WORTH A SECOND FILE is the one promise it has to keep
 * in common with the radio list: 「直接回车 ＝ 接受提问方的推荐」. A radio
 * question's recommendation is `recommended`; a checkbox question's is
 * `defaultChecked`, and the initial state below IS that group — so `Enter`
 * with nothing touched must submit exactly it.
 *
 * Everything is driven through the pure layers (text + state machine) and
 * through the component's own `render`/`handleInput`, which is what a terminal
 * would drive. No pi runtime is involved: the box renders its own lines.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BACK_ROW, DECLINE_ROW, type ChoiceSpec, type ChoiceUi } from "../lib/choice-dialog.ts";
import {
  MULTI_ANSWER_SEPARATOR,
  MULTI_UNAVAILABLE,
  buildMultiChoiceBox,
  defaultMultiChoiceKey,
  multiChoiceKey,
  multiChoiceRow,
  multiChoiceRows,
  multiChoiceStart,
  multiSelectionLabel,
  parseMultiChoice,
  renderMultiChoice,
  truncateToWidth,
  type MultiSelectOutcome,
} from "../lib/multi-choice-dialog.ts";
import { REASON_EDITOR_BACK } from "../lib/reason-editor.ts";

const spec = (over: Partial<ChoiceSpec> = {}): ChoiceSpec => ({
  title: "开哪几个环节？",
  options: ["预检", "quality 审查", "功能审查", "precommit"],
  defaultChecked: ["预检", "quality 审查"],
  ...over,
});

/** A box driven the way a terminal drives it, collecting what it answered. */
function boxOf(spec_: ChoiceSpec, opts: { back?: boolean } = {}) {
  const outcomes: MultiSelectOutcome[] = [];
  let renders = 0;
  const box = buildMultiChoiceBox({
    title: spec_.title,
    spec: spec_,
    ...(opts.back ? { back: true } : {}),
    done: (outcome) => outcomes.push(outcome),
    requestRender: () => { renders += 1; },
  });
  return { box, outcomes, renders: () => renders };
}

// ---- the rows ----

test("every option row carries its letter AND its checkbox", () => {
  assert.equal(multiChoiceRow("预检", spec(), 0, true), "[x] A. 预检");
  assert.equal(multiChoiceRow("功能审查", spec(), 2, false), "[ ] C. 功能审查");
  assert.deepEqual(multiChoiceRows(spec(), ["预检"]), [
    "[x] A. 预检",
    "[ ] B. quality 审查",
    "[ ] C. 功能审查",
    "[ ] D. precommit",
    DECLINE_ROW,
  ]);
});

test("a recommendation the author does give is still marked — it is just optional", () => {
  const rows = multiChoiceRows(spec({ recommended: "功能审查" }), []);
  assert.deepEqual(rows.slice(0, 2), ["[ ] A. 预检", "[ ] B. quality 审查"]);
  assert.equal(rows[2], "[ ] C. 功能审查（推荐）");
});

test("the navigation rows carry NO checkbox — they are not things you tick", () => {
  const rows = multiChoiceRows(spec(), [], { back: true });
  assert.equal(rows.at(-2), DECLINE_ROW);
  assert.equal(rows.at(-1), BACK_ROW);
  assert.ok(!rows.at(-1)!.startsWith("["));
  assert.ok(!rows.at(-2)!.startsWith("["));
});

// ---- the label ----

test("the answer is written in the OPTION LIST'S order, whatever order they were ticked", () => {
  assert.equal(
    multiSelectionLabel(["功能审查", "预检"], spec().options),
    `A. 预检${MULTI_ANSWER_SEPARATOR}C. 功能审查`);
  assert.equal(multiSelectionLabel([], spec().options), "", "nothing ticked is an empty answer, not a missing one");
});

// ---- parsing ----

test("an empty confirmed answer is a list of none — never a dismissal", () => {
  assert.deepEqual(parseMultiChoice("", spec()), { kind: "chose", options: [] });
  assert.deepEqual(parseMultiChoice(undefined, spec()), { kind: "dismissed" });
});

test("every spelling of the same tick lands on the same option", () => {
  for (const picked of ["A", "a", "A.", "1", "预检", "A. 预检"]) {
    assert.deepEqual(parseMultiChoice(picked, spec()), { kind: "chose", options: ["预检"] }, picked);
  }
});

test("several ticks come back as several options, in option order", () => {
  assert.deepEqual(
    parseMultiChoice(`A. 预检${MULTI_ANSWER_SEPARATOR}C. 功能审查`, spec()),
    { kind: "chose", options: ["预检", "功能审查"] });
  assert.deepEqual(parseMultiChoice("C / A", spec()), { kind: "chose", options: ["预检", "功能审查"] });
  assert.deepEqual(parseMultiChoice("预检 / 预检", spec()), { kind: "chose", options: ["预检"] }, "a repeat is not two ticks");
});

test("the decline row is the same row it is on the radio list, reason included", () => {
  assert.deepEqual(parseMultiChoice(DECLINE_ROW, spec()), { kind: "declined", reason: "" });
  assert.deepEqual(parseMultiChoice(`${DECLINE_ROW}：都不开`, spec()), { kind: "declined", reason: "都不开" });
});

test("a quoted row may still carry its checkbox — the mark is stripped, not refused", () => {
  assert.deepEqual(parseMultiChoice("[ ] A. 预检", spec()), { kind: "chose", options: ["预检"] });
  assert.deepEqual(
    parseMultiChoice(`[x] A. 预检${MULTI_ANSWER_SEPARATOR}[ ] C. 功能审查`, spec()),
    { kind: "chose", options: ["预检", "功能审查"] });
});

test("a line nobody can read says so instead of guessing ticks", () => {
  assert.deepEqual(parseMultiChoice("Z", spec()), { kind: "unreadable", text: "Z" });
  assert.deepEqual(parseMultiChoice("预检 / 不存在", spec()), { kind: "unreadable", text: "预检 / 不存在" });
});

// ---- the state machine ----

test("the list OPENS on the group its author recommends — that is what Enter accepts", () => {
  assert.deepEqual(multiChoiceStart(spec()).checked, ["预检", "quality 审查"]);
  assert.deepEqual(multiChoiceStart(spec({ defaultChecked: [] })).checked, []);
});

test("space ticks and untickes the row under the cursor, and nothing else", () => {
  const s = multiChoiceStart(spec({ defaultChecked: [] }));
  const down = multiChoiceKey(s, spec(), "\u001b[B");
  assert.equal(down.kind, "redraw");
  const ticked = multiChoiceKey((down as { state: typeof s }).state, spec(), " ");
  assert.equal(ticked.kind, "redraw");
  assert.deepEqual((ticked as { state: typeof s }).state.checked, ["quality 审查"]);
  const unticked = multiChoiceKey((ticked as { state: typeof s }).state, spec(), " ");
  assert.deepEqual((unticked as { state: typeof s }).state.checked, []);
});

test("j/k move like the arrows, and the cursor WRAPS at both ends", () => {
  const s = multiChoiceStart(spec());
  assert.equal((multiChoiceKey(s, spec(), "j") as { state: { cursor: number } }).state.cursor, 1);
  assert.equal((multiChoiceKey(s, spec(), "k") as { state: { cursor: number } }).state.cursor, 4,
    "up from the first row lands on the decline row (5 rows)");
  const last = { ...s, cursor: 4 };
  assert.equal((multiChoiceKey(last, spec(), "j") as { state: { cursor: number } }).state.cursor, 0);
});

test("space on a navigation row does nothing — a tick cannot be put on ✎ or ←", () => {
  const onDecline = { ...multiChoiceStart(spec()), cursor: 4 };
  assert.deepEqual(multiChoiceKey(onDecline, spec(), " "), { kind: "none" });
  const onBack = { ...multiChoiceStart(spec()), cursor: 5 };
  assert.deepEqual(multiChoiceKey(onBack, spec(), " ", { back: true }), { kind: "none" });
});

test("Enter submits the ticks — including an EMPTY list, which is a real answer", () => {
  assert.deepEqual(multiChoiceKey(multiChoiceStart(spec()), spec(), "\r"), {
    kind: "submit",
    options: ["预检", "quality 审查"],
  });
  assert.deepEqual(multiChoiceKey(multiChoiceStart(spec({ defaultChecked: [] })), spec(), "\r"), {
    kind: "submit",
    options: [],
  });
});

test("Enter on the decline row declines, and on the way back it goes back", () => {
  const onDecline = { ...multiChoiceStart(spec()), cursor: 4 };
  assert.deepEqual(multiChoiceKey(onDecline, spec(), "\r"), { kind: "decline" });
  const onBack = { ...multiChoiceStart(spec()), cursor: 5 };
  assert.deepEqual(multiChoiceKey(onBack, spec(), "\r", { back: true }), { kind: "back" });
  assert.deepEqual(multiChoiceKey(multiChoiceStart(spec()), spec(), "\u001b"), { kind: "close" });
  assert.deepEqual(multiChoiceKey(multiChoiceStart(spec()), spec(), "x"), { kind: "none" });
});

// ---- the box ----

test("the box renders its title, its rows and a footer, and finishes exactly once", () => {
  const { box, outcomes, renders } = boxOf(spec());
  const lines = box.render(80);
  assert.equal(lines[0], "开哪几个环节？");
  assert.match(lines[2]!, /❯ \[x\] A\. 预检/);
  assert.match(lines[3]!, /^ {2}\[x\] B\. quality 审查/);
  assert.match(lines.at(-1)!, /空格/);

  box.handleInput("\u001b[B");
  box.handleInput(" ");
  assert.equal(renders(), 2, "each state change asks the TUI to redraw");
  box.handleInput("\r");
  box.handleInput("\r");
  assert.deepEqual(outcomes, [{ kind: "picked", options: ["预检"] }], "the second Enter is after the box is gone");
});

test("a theme whose fg/bold read their own state survives the box (real-session P0)", () => {
  // PI HANDS OVER AN INSTANCE, NOT A BAG OF FUNCTIONS. Its Theme.fg/bold read
  // `this` (the real one throws `Cannot read properties of undefined (reading
  // 'fgColors')`), so taking the method off the object and calling it detached
  // killed the pi process on the box's FIRST render. The methods below fail in
  // exactly the same way when their receiver is lost.
  const theme = {
    colors: { accent: "«A»", dim: "«D»" } as Record<string, string>,
    fg(this: { colors: Record<string, string> }, color: string, text: string): string {
      return `${this.colors[color] ?? "?"}${text}`;
    },
    bold(this: { colors: Record<string, string> }, text: string): string {
      return `«B»${text}`;
    },
  };
  const outcomes: MultiSelectOutcome[] = [];
  const box = buildMultiChoiceBox({
    title: "标题",
    spec: spec(),
    theme,
    done: (outcome) => outcomes.push(outcome),
  });
  const lines = box.render(80);
  assert.ok(lines.some((line) => line.includes("«B»标题")), "bold lost its receiver");
  assert.ok(lines.some((line) => line.includes("«A»")), "the cursor row lost its colour");
  assert.ok(lines.some((line) => line.includes("«D»")), "the footer lost its colour");
});

test("a disposed box answers nothing — the host took it off the screen", () => {
  const { box, outcomes } = boxOf(spec());
  box.dispose();
  box.handleInput("\r");
  assert.deepEqual(outcomes, []);
});

test("every rendered line fits the width it was given", () => {
  const { box } = boxOf(spec({ options: ["一个很长很长很长很长的环节名字", "短的"] }));
  // The measurement is the TERMINAL'S notion of a cell, which is what the
  // truncation has to satisfy: CJK is two columns, everything the gate draws
  // itself (`❯`, `…`, `[x]`, ANSI escapes) is one or none.
  const wide = (cp: number) =>
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xff00 && cp <= 0xff60);
  for (const line of box.render(12)) {
    let visible = 0;
    for (const char of line.replace(/\u001b\[[0-9;]*m/g, "")) visible += wide(char.codePointAt(0)!) ? 2 : 1;
    assert.ok(visible <= 12, `“${line}” is ${visible} cells wide`);
  }
});

// ---- width ----

test("truncation counts CELLS: a wide character is two, an escape is none", () => {
  assert.equal(truncateToWidth("abc", 2), "a…", "the ellipsis occupies a cell of its own");
  assert.equal(truncateToWidth("中文", 3), "中…");
  assert.equal(truncateToWidth("中文", 4), "中文");
  assert.equal(truncateToWidth("\u001b[31mabc\u001b[0m", 2), "\u001b[31ma…");
  assert.equal(truncateToWidth("anything", 0), "");
});

// ---- the dialog ----

test("the dialog returns the line the parser reads, for every outcome", async () => {
  const ui = (outcome: MultiSelectOutcome) => ({ multiSelect: async () => outcome });

  assert.equal(
    await renderMultiChoice(ui({ kind: "picked", options: ["功能审查", "预检"] }), spec()),
    `A. 预检${MULTI_ANSWER_SEPARATOR}C. 功能审查`);
  assert.equal(await renderMultiChoice(ui({ kind: "picked", options: [] }), spec()), "");
  assert.equal(await renderMultiChoice(ui({ kind: "back" }), spec()), BACK_ROW);
  assert.equal(await renderMultiChoice(ui({ kind: "dismissed" }), spec()), undefined);
  // NO HOST IS NOT A DISMISSAL (reviewer P2): a host that cannot draw a checkbox
  // never showed the question, and the caller has to hear that.
  assert.equal(await renderMultiChoice(undefined, spec()), MULTI_UNAVAILABLE);
  assert.equal(await renderMultiChoice(ui({ kind: "unavailable" }), spec()), MULTI_UNAVAILABLE);
});

test("the decline row opens the reason box; what it returns is the row plus the reason", async () => {
  const ui = (reason: string | undefined) => ({
    multiSelect: async () => ({ kind: "decline" as const, checked: [] }),
    editor: async () => reason,
  });
  assert.equal(await renderMultiChoice(ui("都不开"), spec()), `${DECLINE_ROW}：都不开`);
  assert.equal(await renderMultiChoice(ui(""), spec()), DECLINE_ROW, "an empty reason is still a decline");
  assert.equal(await renderMultiChoice(ui(undefined), spec()), undefined, "backing out of the box decides nothing");
});

test("ESC in the reason box re-opens the LIST as the user left it (reviewer P2)", async () => {
  const seen: Array<string[] | undefined> = [];
  let first = true;
  const ui = {
    multiSelect: async (_title: string, spec_: ChoiceSpec) => {
      seen.push(spec_.defaultChecked);
      if (first) {
        first = false;
        // He had already ticked C before choosing ✎ — that is the state the
        // list has to come back to, not the author's defaults.
        return { kind: "decline" as const, checked: ["功能审查"] };
      }
      return { kind: "picked" as const, options: ["功能审查"] };
    },
    editor: async () => `${REASON_EDITOR_BACK}都省了吧`,
  };
  assert.equal(await renderMultiChoice(ui, spec()), "C. 功能审查");
  assert.deepEqual(seen, [["预检", "quality 审查"], ["功能审查"]],
    "the ticks the user made survive the round trip through the reason box");
});

test("a raw input chunk is READ by the host when it has one — that is how ESC survives", () => {
  // REVIEWER P1: a terminal on the Kitty keyboard protocol sends ESC as
  // `\u001b[27u`, and Ctrl+C as `\u001b[99;5u`. The default table cannot know
  // that; pi's keybindings can, and the box takes them as a reader.
  const kittyEscape = "\u001b[27u";
  assert.equal(defaultMultiChoiceKey(kittyEscape), undefined,
    "the fallback table deliberately knows only the plain sequences");
  assert.deepEqual(multiChoiceKey(multiChoiceStart(spec()), spec(), kittyEscape),
    { kind: "none" });

  const readKey = (data: string) => (data === kittyEscape ? "escape" as const : defaultMultiChoiceKey(data));
  assert.deepEqual(multiChoiceKey(multiChoiceStart(spec()), spec(), kittyEscape, { readKey }),
    { kind: "close" }, "with the host's reader the same bytes close the box");
  assert.deepEqual(multiChoiceKey(multiChoiceStart(spec()), spec(), "j", { readKey }),
    { kind: "redraw", state: { cursor: 1, checked: ["预检", "quality 审查"] } },
    "…and a key the reader does not recognise still falls through to the shape's own table");

  // The COMPONENT takes the same seam, which is what makes the fix reach the
  // screen rather than only the state machine.
  const outcomes: MultiSelectOutcome[] = [];
  const box = buildMultiChoiceBox({
    title: "t", spec: spec(), readKey, done: (outcome) => outcomes.push(outcome),
  });
  box.handleInput(kittyEscape);
  assert.deepEqual(outcomes, [{ kind: "dismissed" }]);
});

test("the fallback reader names every key the box understands", () => {
  assert.equal(defaultMultiChoiceKey("\u001b[A"), "up");
  assert.equal(defaultMultiChoiceKey("k"), "up");
  assert.equal(defaultMultiChoiceKey("\u001bOB"), "down");
  assert.equal(defaultMultiChoiceKey("j"), "down");
  assert.equal(defaultMultiChoiceKey("\r"), "enter");
  assert.equal(defaultMultiChoiceKey(" "), "space");
  assert.equal(defaultMultiChoiceKey("\u001b"), "escape");
  assert.equal(defaultMultiChoiceKey("q"), undefined);
  // SPACE IS THE ONE KEY pi's select keybindings cannot lend us (there is no
  // toggle binding), so the terminal's other spellings live HERE: Kitty CSI-u
  // and xterm modifyOtherKeys.
  for (const space of ["\u001b[32u", "\u001b[32;1u", "\u001b[32::32;1u", "\u001b[27;1;32~"]) {
    assert.equal(defaultMultiChoiceKey(space), "space", JSON.stringify(space));
  }
});
