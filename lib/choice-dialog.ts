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

/** What the reason box hints at; `!chat`/`!skip` are the interview escapes. */
export const CHOICE_REASON_HINT = "直接输入原因；!chat=改在聊天里答，!skip=跳过后续";

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
  /** Placeholder for the reason box — {@link CHOICE_REASON_HINT} by default. */
  reasonPlaceholder?: string;
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

/** Does this answer line carry a decline reason? Used by the channel side. */
export function isDeclineLine(line: string, spec: ChoiceSpec): boolean {
  const decline = declineRowOf(spec);
  return line === decline || line.startsWith(decline);
}

/** Does this row look like a template decline row (`✎ …`)? */
export function looksLikeDeclineRow(row: string): boolean {
  return row.startsWith("✎");
}

/** The `ui` surface this template needs — a structural subset of pi's. */
export interface ChoiceUi {
  select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
  input?: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
}

/** The reason box's title, so a dismissed box is not read as a decline. */
export function reasonTitleOf(spec: ChoiceSpec): string {
  return `${spec.title}\n（不选的原因——留空等于只说「不选」）`;
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
 * `body` is the budget-fitted extra text (the caller owns the geometry —
 * lib/dialog-budget.ts); it is appended to the title, which is what pi's
 * select renders. `extraRows` are rows the CALLER owns — an interview's
 * `⏭ 跳过后续问题` is the only one today — appended after the template's
 * decline row and deliberately not understood here: the caller decides what
 * they mean.
 */
export async function renderChoice(
  ui: ChoiceUi | undefined,
  spec: ChoiceSpec,
  opts: { signal?: AbortSignal; body?: string; extraRows?: string[] } = {},
): Promise<string | undefined> {
  const rows = [...choiceRows(spec), ...(opts.extraRows ?? [])];
  const title = opts.body ? `${spec.title}\n${opts.body}` : spec.title;
  const picked = await ui?.select?.(title, rows, opts.signal ? { signal: opts.signal } : undefined);
  if (picked !== declineRowOf(spec)) return picked;
  const reason = await ui?.input?.(
    reasonTitleOf(spec),
    spec.reasonPlaceholder ?? CHOICE_REASON_HINT,
    opts.signal ? { signal: opts.signal } : undefined,
  );
  if (reason === undefined) return undefined;
  const trimmed = reason.trim();
  return trimmed ? `${declineRowOf(spec)}：${trimmed}` : declineRowOf(spec);
}

/**
 * The lines a headless environment must carry itself: the same question with
 * the same rows, as plain text. Used where no dialog can be rendered.
 */
export function formatChoice(spec: ChoiceSpec): string {
  return `${spec.title}\n${choiceRows(spec).map((row) => `  - ${row}`).join("\n")}`;
}
