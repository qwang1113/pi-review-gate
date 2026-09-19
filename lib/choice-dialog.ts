import { raceAbort } from "./abort-race.ts";
import { isReasonBack, reasonBackText } from "./reason-editor.ts";

/**
 * THE question template — the ONE shape every gate dialog has (user decision,
 * 2026-09-08).
 *
 * WHY THIS MODULE EXISTS. The gate asked the user in two unrelated ways:
 * `ask_user` rendered an option list, and every gate-owned dialog rendered a
 * Yes/No box. The user's report was concrete: "有些是只能选是、否" — a yes/no
 * box has no room for the answer they actually wanted to give, and a
 * rejection left the agent with no reason at all (the goal approval even
 * popped a SECOND box just to collect one). One template fixes both:
 *
 *     2–4 options, exactly one of them marked （推荐）,
 *     plus one extra row: ✎ 不选，我说明原因.
 *
 * Picking that last row opens a text box, and what the user types travels
 * back with the answer as `✎ …：<reason>`. So "I choose none of these, and
 * here is why" is expressible everywhere, in the same place, with no second
 * dialog and no second code path.
 *
 * WHAT IS *NOT* HERE. This module owns the SHAPE: the row list, the
 * validation, the parsing, and the render call. It owns no policy — who may
 * approve what, what a rejection means, which option is recommended for a
 * given dialog. Those stay with the caller, which is why the same file serves
 * `ask_user` and the ship gate alike.
 *
 * PURITY. `renderChoice` takes the host's `ui` object as an argument and does
 * nothing else: no clock, no IO, no globals. Every branch — chosen, declined,
 * dismissed, no UI at all — is drivable from a test with three lines.
 */

/** An option list is a decision point, not a survey (user decision 2026-09-08). */
export const MIN_CHOICE_OPTIONS = 2;
export const MAX_CHOICE_OPTIONS = 4;

/** One option's own length cap, so a runaway option cannot blow the dialog. */
export const MAX_CHOICE_OPTION_CHARS = 120;

/** The extra row: "none of these, and here is why". */
export const DECLINE_ROW = "✎ 不选，我说明原因";

/**
 * THE WAY BACK — one question, one row (user decision, 2026-09-19).
 *
 * WHY IT IS THE TEMPLATE'S ROW AND NOT A CALLER'S. It is navigation, not an
 * answer: it carries no text the user chose and no meaning the caller decides.
 * Its 2026-09-17 predecessor (`extraRows`) was deleted precisely because a row
 * the template did not own had no business here — and this one the template
 * DOES own, which is why it comes back as a named row with a switch
 * (`renderChoice`'s `back`) rather than as a string the interview pastes in.
 *
 * IT IS DRAWN, NEVER OFFERED OVER THE CHANNEL: the rows a channel request
 * carries are `choiceRows` (the options and the decline row), so a project
 * manager is never handed a row that means "ask the human again".
 */
export const BACK_ROW = "← 返回上一题";

/**
 * The same extra row for an APPROVAL dialog, where "none of these" means
 * "do not approve yet — change something first". Same mechanism, the wording
 * the user asked for.
 */
export const REVISE_ROW = "✎ 我要改，我说明原因";

/** What the reason box accepts; `!chat` is the interview's escape. */
export const CHOICE_REASON_HINT = "直接输入原因；!chat=改在聊天里答";

/** Everything the template renders. */
export interface ChoiceSpec {
  /** The question itself — becomes the dialog's first line(s). */
  title: string;
  /** The options, in the order they are shown. 2–4 of them. */
  options: string[];
  /** Which option is marked （推荐）. MUST be one of `options`. */
  recommended: string;
  /** Row label for "none of these" — {@link DECLINE_ROW} by default. */
  declineRow?: string;
}

/** The decline row this spec actually uses. */
export function declineRowOf(spec: ChoiceSpec): string {
  return spec.declineRow ?? DECLINE_ROW;
}

/**
 * THE OPTION LETTERS (user decision, 2026-09-19): `A`, `B`, `C`… from the
 * first option. Two to four options, so the letters never run past `D`.
 *
 * WHY A LETTER AT ALL. The rows are a decision point the user reads top-down,
 * and "the second one" is a worse handle than `B` — in the 2026-09-19
 * interview the user's own answers were written as "A / B / C" in chat and
 * the gate's dialogs carried no such handle, so quoting a row meant quoting
 * its whole sentence. pi's selector has no letter shortcut (↑↓/j/k only), so
 * this is a LABEL, never an input method: it exists to be read and repeated.
 *
 * THE NAVIGATION ROWS ARE DELIBERATELY NOT NUMBERED: `✎ …` and `← 返回上一题`
 * are not answers, and a letter in front of them would say they are.
 */
export function optionLetter(index: number): string {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

/** The marker the recommended row carries — one definition, renderer and parser. */
export const RECOMMEND_MARKER = "（推荐）";

/** The letters prefix the rows: `A. text`. */
const ROW_PREFIX = /^([A-Za-z])\.\s+/;

/**
 * THE POSITION A ROW IS ANSWERED BY, in either shorthand the screen offers:
 * a letter (`A` / `a` / `A.` / `A、` → 0) or a 1-based index (`1` → 0).
 * Anything else → `undefined`; an out-of-range position is still an INDEX (the
 * caller decides what a position past the list means).
 *
 * ONE DEFINITION FOR TWO PARSERS (quality round P2, both halves, 2026-09-19).
 * The human's dialog answer goes through `parseChoice` below and the project
 * manager's channel answer goes through `resolveAnswer`
 * (lib/orchestrator-answer-tools.ts); both read a bare letter AND a bare number
 * the same way BY CONSTRUCTION rather than by four copies of two regexes that
 * drift apart the first time one of them is touched (AGENTS.md 哲学二: one
 * thing, one implementation). The two shorthands are one function because they
 * are one question — "is this answer a position, and which one" — and every
 * caller wants both halves of it.
 */
export function rowIndexOf(text: string): number | undefined {
  const trimmed = text.trim();
  const letter = /^([A-Za-z])[.、)）]?$/.exec(trimmed);
  if (letter) return letter[1]!.toUpperCase().charCodeAt(0) - "A".charCodeAt(0);
  if (/^\d+$/.test(trimmed)) return Number(trimmed) - 1;
  return undefined;
}

/**
 * `A. text（推荐）` → `text`. A row read back without either decoration (a
 * project manager typing the text off the receipt) comes back with what was
 * left of it, and text that never had the decoration is returned unchanged.
 */
function stripRowDecoration(picked: string): string {
  const prefix = ROW_PREFIX.exec(picked);
  const body = prefix ? picked.slice(prefix[0].length) : picked;
  return body.endsWith(RECOMMEND_MARKER) ? body.slice(0, -RECOMMEND_MARKER.length) : body;
}

/** The option row as shown: `A. the text`, the recommended one carrying （推荐）. */
export function optionRow(option: string, recommended: string, index: number): string {
  const row = `${optionLetter(index)}. ${option}`;
  return option === recommended ? `${row}${RECOMMEND_MARKER}` : row;
}

/**
 * The option as the RECORD writes it: `A. text`.
 *
 * The transcript summary and the tool reply are read long after the dialog is
 * gone, and `→ A. 只加「← 返回上一题」行` is the line the user can still match
 * against what the screen showed. Anything that was NOT one of the options
 * (free text the orchestrator answered with) comes back untouched.
 */
export function optionLabel(option: string, options: readonly string[]): string {
  const index = options.findIndex((candidate) => candidate === option);
  return index < 0 ? option : `${optionLetter(index)}. ${option}`;
}

/** Every row the dialog shows, in order: the options, then the decline row. */
export function choiceRows(spec: ChoiceSpec): string[] {
  return [
    ...spec.options.map((option, index) => optionRow(option, spec.recommended, index)),
    declineRowOf(spec),
  ];
}

/**
 * Is this option list + recommendation a valid question?
 *
 * Returns an agent-facing error, or `undefined` when the spec is fine. The
 * message says what to change, because the caller's next move is to rewrite
 * the question and ask again — a rejection the agent cannot act on is just a
 * slower guess.
 */
export function validateChoice(
  options: string[] | undefined,
  recommended: string | undefined,
  /** Where in the call this question is, e.g. "第 2 个问题". */
  where = "这个问题",
): string | undefined {
  if (!options || options.length < MIN_CHOICE_OPTIONS) {
    return `${where}只有 ${options?.length ?? 0} 个选项 —— 每题必须给 ${MIN_CHOICE_OPTIONS}–${MAX_CHOICE_OPTIONS} 个选项`;
  }
  if (!recommended) {
    return `${where}没有 recommended —— 每题必须标出一个推荐选项`;
  }
  if (!options.includes(recommended)) {
    return `${where}的 recommended "${recommended}" 不在选项里 —— 推荐值必须与其中一个选项完全相同`;
  }
  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(option)) return `${where}有重复选项 "${option}" —— 选项文本必须唯一`;
    seen.add(option);
  }
  return undefined;
}

/** What the user did with one question. */
export type ChoicePick =
  | { kind: "chose"; option: string }
  | { kind: "declined"; reason: string }
  | { kind: "dismissed" };

/**
 * What a returned line MEANS.
 *
 * The three shapes are the whole contract: a known option, the decline row
 * (with or without a reason — `✎ …：<reason>`, or the bare row when the
 * reason box was left empty), or nothing at all (ESC / no UI). A line that
 * is none of those is still returned as `chose` verbatim: the orchestrator
 * may answer a child's dialog with free text of its own, and the caller —
 * not this module — decides what that means.
 */
export function parseChoice(picked: string | undefined, spec: ChoiceSpec): ChoicePick {
  if (picked === undefined) return { kind: "dismissed" };
  const decline = declineRowOf(spec);
  if (picked === decline) return { kind: "declined", reason: "" };
  if (picked.startsWith(decline)) {
    return { kind: "declined", reason: picked.slice(decline.length).replace(/^[：:]\s*/, "").trim() };
  }
  // THE TEXT THE CALLER WROTE, first — every internal comparison (a goal
  // approval's own labels, the interview's recommended-grant check) is made on
  // this, never on what the screen happened to show.
  const original = spec.options.find((option) => picked === option);
  if (original !== undefined) return { kind: "chose", option: original };
  // A ROW THE LIST SHOWED: `A. text（推荐）` — what the dialog itself returns
  // when the human picks a row, and what a channel answer carries back after a
  // project manager answered with the row's own text (with or without the
  // recommendation marker, which is decoration, not content).
  const shown = spec.options.find((option) => option === stripRowDecoration(picked));
  if (shown !== undefined) return { kind: "chose", option: shown };
  // A POSITION READ OFF THE SCREEN — `A`, `a`, `A.` or the 1-based `1`. AFTER
  // the exact-text match on purpose: an option whose own text IS `A` must win
  // over the position, or `B` would answer the first option. The reading
  // itself is shared with the channel's parser (`rowIndexOf`).
  const index = rowIndexOf(picked);
  if (index !== undefined) {
    const option = spec.options[index];
    if (option !== undefined) return { kind: "chose", option };
  }
  // Anything else is returned verbatim: free text the orchestrator may answer
  // with, whose meaning only the caller can decide.
  return { kind: "chose", option: picked };
}

/** Does this row look like a template decline row (`✎ …`)? */
export function looksLikeDeclineRow(row: string): boolean {
  return row.startsWith("✎");
}

/** The `ui` surface this template needs — a structural subset of pi's. */
export interface ChoiceUi {
  select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
  /**
   * The reason box — a MULTI-LINE editor (user decision, 2026-09-17), not the
   * single-line prompt it used to be: the user is writing an explanation, and
   * pi's own editor brings newline handling, paste and `ctrl+g` into their
   * $EDITOR. The signal is what takes the box off the screen when the other
   * side answers first (lib/orchestrator-child-channel.ts), so a host that
   * implements this WITHOUT the signal silently loses that.
   *
   * WHY NOT pi's `ui.editor` DIRECTLY: it takes no signal, and a box that
   * cannot be taken down is how an orchestrator's answer and a user's typing
   * both look like they worked. `extensions/review-gate.ts` builds this from
   * pi's own `ExtensionEditorComponent` (same box, signal attached).
   */
  /**
   * `prefill` is the text the box opens with — the interview's way of not
   * losing half a sentence when the user backs out to the list and returns
   * (user decision, 2026-09-19). A host that ignores it still works; it just
   * makes the user retype.
   */
  editor?: (title: string, opts?: { signal?: AbortSignal; prefill?: string }) => Promise<string | undefined>;
}

/**
 * The reason box's title: what is being declined, then the hint.
 *
 * IT CARRIES THE WHOLE HEAD (2026-09-17). An interview question's list title is
 * a bare `问题 n / m` now (the truncated first line is gone), and the reason
 * box renders its own title ALONE — so the full question text has to ride
 * here, or the user writes an explanation into a box that never says what it
 * is about. That blindness is exactly what the old 60-character headline
 * existed to prevent; carrying the WHOLE text fixes it properly.
 */
export function reasonTitleOf(dialogTitle: string): string {
  return `${dialogTitle}\n（不选的原因——留空等于只说「不选」；${CHOICE_REASON_HINT}）`;
}

/**
 * Render the template and return the line the user picked.
 *
 * Picking the decline row is a TWO-STEP interaction here (row, then text
 * box) and a single line on the way out: the caller sees exactly one shape,
 * whether the answer came from the human, from an orchestrator through the
 * channel, or from a test. A dismissed REASON box returns `undefined`, the
 * same as a dismissed list — the user backed out of both halves, and reading
 * that as a decision is how a gate invents an answer.
 *
 * `body` is the long half of the question — counts, consequences, the facts
 * being confirmed — and is passed through WHOLE (user decision, 2026-09-16:
 * the row budget that used to fit it is gone, see lib/renderer-mode.ts); it is
 * appended to the title, which is what pi's select renders, AND to the reason
 * editor's title, so the box the user writes in knows what it is about.
 *
 * There is no longer an `extraRows` (2026-09-17): it existed for exactly one
 * caller-owned row — the interview's own escape — and that row is gone. A row
 * the template itself does not own has no business here; the way BACK one
 * question (2026-09-19) is the template's own, so it is a switch here rather
 * than a string a caller pastes into the list.
 *
 * THE REASON BOX IS NOT A WAY OUT ANY MORE (user decision, 2026-09-19). ESC in
 * the editor used to close the question — which, for an interview, stops every
 * remaining question, so a user who opened the box, changed their mind and
 * pressed ESC lost the whole interview instead of returning to the list they
 * were reading. A host that CAN tell the two apart (a custom component:
 * lib/reason-editor.ts's `REASON_EDITOR_BACK`) now opens the list again with
 * the text so far kept; a host that cannot (the signal-less `ui.editor`
 * fallback) keeps the old reading, because there `undefined` is the only fact
 * it has.
 */
export async function renderChoice(
  ui: ChoiceUi | undefined,
  spec: ChoiceSpec,
  opts: { signal?: AbortSignal; body?: string; back?: boolean } = {},
): Promise<string | undefined> {
  const title = opts.body ? `${spec.title}\n${opts.body}` : spec.title;
  // The back row is drawn here, NOT added to `choiceRows`: the rows a channel
  // request offers a project manager must stay the answerable ones.
  const rows = opts.back ? [...choiceRows(spec), BACK_ROW] : choiceRows(spec);
  let prefill: string | undefined;
  for (;;) {
    const picked = await ui?.select?.(title, rows, opts.signal ? { signal: opts.signal } : undefined);
    if (picked !== declineRowOf(spec)) return picked;
    const reason = await ui?.editor?.(reasonTitleOf(title), {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(prefill === undefined ? {} : { prefill }),
    });
    // ESC IN THE BOX: back to the list, holding on to what was typed.
    if (reason !== undefined && isReasonBack(reason)) {
      prefill = reasonBackText(reason) || prefill;
      continue;
    }
    if (reason === undefined) return undefined;
    const trimmed = reason.trim();
    return trimmed ? `${declineRowOf(spec)}：${trimmed}` : declineRowOf(spec);
  }
}

/**
 * WHAT A DIALOG'S BANNER SAYS: the box's HEAD, then the thing being asked.
 *
 * The banner is raised by whoever shows the box, and it used to carry the head
 * alone — which for an interview question is the bare progress label `问题 1 / 4`
 * (the question's own first line was deliberately dropped from the list title
 * on 2026-09-17). A notification whose whole text is a progress label tells the
 * user nothing about what they are being asked (user report, 2026-09-18), so
 * the body rides along and the head stays as the anchor.
 *
 * The QUESTION itself is what callers must pass as `body`; sanitization and
 * the length cap belong to the notification layer (lib/user-notify.ts), not to
 * the shape of a dialog.
 */
export function dialogNotifyDetail(spec: ChoiceSpec, body?: string): string {
  const head = spec.title.trim();
  const detail = (body ?? "").trim();
  if (!detail) return head;
  return head ? `${head} · ${detail}` : detail;
}

/**
 * SERIALIZE THE GATE'S DIALOGS — one box on screen, ever.
 *
 * WHY THIS IS THE GATE'S JOB, NOT A HOST DETAIL (measured, 2026-09-18). pi runs
 * the tool calls of ONE assistant message in PARALLEL (`pi-agent-core`
 * `executeToolCallsParallel`, a `Promise.all` over the batch, and an abort does
 * not interrupt that await) while the host has exactly ONE dialog slot:
 * `showExtensionSelector` assigns `this.extensionSelector`, clears the
 * container and adds the new component. A second dialog therefore REPLACES the
 * first — the first component is dropped, the callbacks that would settle its
 * promise are never called again, so the first tool call never returns, the
 * batch never settles and the turn hangs with no way out.
 *
 * MEASURED: rebate session `01a0b328` (2026-09-18) put `ask_user` (4 questions)
 * and `request_scope_limit` in ONE message — two "needs you" banners 40ms
 * apart, the user answered the scope-limit box, and the session froze for good.
 *
 * ONE QUEUE PER SESSION, and it is held across the WHOLE dialog — the list AND
 * the reason box that may follow it — because those are one conversation with
 * the user.
 *
 * A QUEUED DIALOG CAN STILL BE CANCELLED (reviewer P1, 2026-09-18). Waiting for
 * a turn lasts as long as the box in front of it stays open, so a request whose
 * signal aborts while it queues — the project manager answered it through the
 * channel, the user pressed ESC — must come back IMMEDIATELY, not after an
 * unrelated box closes; a waiter that kept waiting would strand its own tool for
 * as long as the OTHER dialog does. `signal` is optional: a caller with no
 * cancellation source simply waits its turn.
 *
 * WHY NOT THE HOST'S OWN `executionMode: "sequential"` (pi's tool flag, which
 * also sequentializes a batch): that flag has to be repeated on EVERY
 * dialog-raising tool, and one tool added without it reopens the hole — while
 * this queue sits on the ONE funnel every dialog already goes through
 * (AGENTS.md 哲学二: 一件事只有一个入口).
 */
export function createDialogQueue(): <T>(run: () => Promise<T>, signal?: AbortSignal) => Promise<T | undefined> {
  let tail: Promise<unknown> = Promise.resolve();
  return async function schedule<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
    const previous = tail;
    let releaseSelf!: () => void;
    const self = new Promise<void>((resolve) => { releaseSelf = resolve; });
    tail = self;
    let released = false;
    /**
     * GIVE UP MY PLACE — AND ONLY MY OWN.
     *
     * A cancelled waiter returns at once, but the QUEUE it leaves behind must
     * stay ordered: whoever is already behind me is waiting for the SAME box I
     * was (the one my `previous` stands for), and a chain that skipped to the
     * next promise would let them open a second dialog on top of it — exactly
     * the defect this module exists to prevent. So:
     *
     *   - no waiter behind me ⇒ hand the chain back to `previous` (the queue
     *     is empty again as far as the next caller is concerned), and settle;
     *   - someone behind me ⇒ my promise settles when the box I was waiting for
     *     does; I am no longer on screen, I am just holding the turn.
     */
    const release = () => {
      if (released) return;
      released = true;
      if (tail === self) {
        tail = previous;
        releaseSelf();
        return;
      }
      void previous.then(() => releaseSelf(), () => releaseSelf());
    };
    try {
      if (signal?.aborted) return undefined;
      if (signal) {
        // `true` means the abort won: the caller skips its dialog. The race
        // itself lives in lib/abort-race.ts (the reason box races the same way).
        if (await raceAbort(previous.then(() => false), signal, true)) return undefined;
      } else {
        // NOT `.catch`: `tail` settles ONLY through `release`, so a dialog that
        // threw cannot leave the queue rejected — a queue that stops serving
        // after one error is the same hang under a different name.
        await previous;
      }
      // A signal can abort between "my turn arrived" and this line.
      if (signal?.aborted) return undefined;
      return await run();
    } finally {
      release();
    }
  };
}

/**
 * THE SIGNAL A DIALOG LISTENS TO: the caller's own, plus the host's.
 *
 * TWO SOURCES, TWO DIFFERENT ESCAPES. The caller's signal is what takes a box
 * down when the OTHER SIDE answers (an orchestrator's answer, an instruct:
 * lib/orchestrator-child-channel.ts). The host's (`ExtensionContext.signal`,
 * the run's own abort signal) is what an ESC press aborts — and without it a
 * gate box stays on screen after the user cancelled the run, which is how a
 * dialog outlives the very thing it was asking about (user report,
 * 2026-09-18: "按 ESC 也无法结束").
 *
 * `AbortSignal.any` is the standard combinator, but it REJECTS an empty array,
 * and "no signal at all" is a shape several callers produce — in a command
 * handler, or in a test's fake UI.
 */
export function dialogSignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  if (live.length === 0) return undefined;
  return live.length === 1 ? live[0] : AbortSignal.any(live);
}

