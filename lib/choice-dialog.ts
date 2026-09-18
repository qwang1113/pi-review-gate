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

/** The option row as shown: the recommended one carries its marker. */
export function optionRow(option: string, recommended: string): string {
  return option === recommended ? `${option}（推荐）` : option;
}

/** Every row the dialog shows, in order: the options, then the decline row. */
export function choiceRows(spec: ChoiceSpec): string[] {
  return [
    ...spec.options.map((option) => optionRow(option, spec.recommended)),
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
  const original = spec.options.find((option) => picked === option || picked === optionRow(option, spec.recommended));
  return { kind: "chose", option: original ?? picked };
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
  editor?: (title: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
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
 * the template itself does not own has no business here.
 */
export async function renderChoice(
  ui: ChoiceUi | undefined,
  spec: ChoiceSpec,
  opts: { signal?: AbortSignal; body?: string } = {},
): Promise<string | undefined> {
  const title = opts.body ? `${spec.title}\n${opts.body}` : spec.title;
  const picked = await ui?.select?.(title, choiceRows(spec), opts.signal ? { signal: opts.signal } : undefined);
  if (picked !== declineRowOf(spec)) return picked;
  const reason = await ui?.editor?.(reasonTitleOf(title), opts.signal ? { signal: opts.signal } : undefined);
  if (reason === undefined) return undefined;
  const trimmed = reason.trim();
  return trimmed ? `${declineRowOf(spec)}：${trimmed}` : declineRowOf(spec);
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
 * WHY NOT THE HOST'S OWN `executionMode: "sequential"` (pi's tool flag, which
 * also sequentializes a batch): that flag has to be repeated on EVERY
 * dialog-raising tool, and one tool added without it reopens the hole — while
 * this queue sits on the ONE funnel every dialog already goes through
 * (AGENTS.md 哲学二: 一件事只有一个入口).
 */
export function createDialogQueue(): <T>(run: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return async function schedule<T>(run: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    // NOT `.catch`: `tail` settles ONLY through `release`, so a dialog that
    // threw cannot leave the queue rejected — a queue that stops serving after
    // one error is the same hang under a different name.
    await previous;
    try {
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

