/**
 * `ask_user` — the ONE way the agent reaches the user.
 *
 * WHY THIS MODULE EXISTS (user ask, 2026-08-29). Asking used to be two things
 * at once: a tool that PAUSED the loop (`pause_for_question`) and a habit of
 * writing questions into the reply and hoping the user answered. The first
 * carried exactly one question; the second cost a whole loop iteration every
 * time the agent forgot the tool existed.
 *
 * One entry point, one meaning: calling it pauses. The gate owns the
 * mechanics — asking one question at a time, tracking "N of M", letting the
 * user stop the whole interview by closing the box, and handing every answer
 * back at once — so the agent only ever writes the questions.
 *
 * Everything here is pure: question hygiene, what a chosen line MEANS, and
 * how the finished interview reads. The SHAPE of a question — the rows, the
 * recommendation marker, the `✎ 不选，我说明原因` row — is not owned here any
 * more: it is the gate's one question template (lib/choice-dialog.ts), which
 * every dialog in the gate now shares (user decision, 2026-09-08). The
 * extension owns the dialogs and the persistence.
 */

import {
  BACK_ROW,
  MAX_CHOICE_OPTION_CHARS,
  MAX_CHOICE_OPTIONS,
  choiceRows,
  optionLabel,
  parseChoice,
  validateChoice,
  type ChoiceSpec,
} from "./choice-dialog.ts";
import {
  defaultCheckedOf,
  isMultipleChoice,
  MULTI_ANSWER_SEPARATOR,
  multiChoiceRows,
  multiSelectionLabel,
  parseMultiChoice,
} from "./multi-choice-dialog.ts";

/**
 * One question's own length cap. There is NO cap on how MANY questions one
 * call may ask (user decision, 2026-09-17).
 *
 * The cap existed to keep an interview from becoming a wall, and it bought the
 * opposite of what it was for: a batch past it had its TAIL silently discarded,
 * and the agent — told the rest would come "next round" — usually never asked
 * again and went off to guess instead, which is the exact failure questions
 * exist to prevent. The user's own escape is closing the box, and that stops
 * the whole interview (see resolveQuestion).
 */
export const MAX_QUESTION_CHARS = 1200;

/** One question as the agent wrote it — always a choice question. */
export interface AskQuestion {
  /** The question itself, including context the user needs to decide. */
  text: string;
  /** 2–4 choices. There is no free-text question any more (2026-09-08). */
  options: string[];
  /**
   * The agent's own recommendation — must equal one of `options`.
   *
   * REQUIRED ON A RADIO QUESTION (that is what pressing Enter submits), and
   * deliberately optional on a {@link AskQuestion.multiple} one, where the
   * role is played by `defaultChecked` (user decision, 2026-09-22). A
   * checkbox question that does give one still draws it as （推荐）.
   */
  recommended: string;
  /**
   * THIS QUESTION TAKES SEVERAL ANSWERS — the checkbox shape (2026-09-22).
   *
   * `true` must come with a `defaultChecked` — the group the question author
   * recommends — so that “press Enter, accept the recommendation” means the
   * same thing on both shapes. The default is deliberately NOT guessed: an
   * unticked list nobody chose is not a recommendation.
   */
  multiple?: true;
  /**
   * The options a checklist question opens TICKED. Required when `multiple` is
   * set (an empty array is a legitimate answer: “recommend none of them”), and
   * every entry must be one of `options`.
   */
  defaultChecked?: string[];
  /**
   * ORCHESTRATOR ONLY (2026-09-16): when the project manager asks the user
   * for a proxy authority, this names the scope (e.g. `sensitive-edit`).
   * An affirmative answer mints a grant for the whole orchestration; any
   * other answer mints nothing. The gate recognizes the scope from a fixed
   * list — an agent cannot invent one.
   */
  grantScope?: string;
}

/**
 * Proxy scopes the gate will actually mint — an agent cannot invent one.
 *
 * `sensitive-edit` is the original door (2026-09-16). `tmux-access` joins it
 * (2026-09-17, reviewer P2): letting the project manager approve a child's
 * request to type at the user's tmux server has the same blast radius as
 * authorizing a write to `.env` — `kill-server` takes the user's whole session
 * with it — so the PM may only do it after the USER granted that scope.
 * "运维类" is still deliberately not a scope until the user names the
 * operations it should cover.
 */
export const GRANTABLE_SCOPES = ["sensitive-edit", "tmux-access"] as const;

/** True when `scope` is a grantable proxy scope. */
export function isGrantableScope(scope: string | undefined): scope is string {
  return scope !== undefined && (GRANTABLE_SCOPES as readonly string[]).includes(scope);
}

/** What the user did with one question. */
export type AnswerKind =
  /** They answered (dialog choice or typed text). */
  | "answered"
  /** They asked to answer this one in chat instead of a dialog. */
  | "deferred-to-chat"
  /**
   * The dialog closed without a choice (ESC), or there was no dialog to show
   * at all. Deliberately distinct from "deferred": the user did not ask for
   * anything, so the reply must not claim they did.
   */
  | "unanswered";

export interface AskAnswer {
  question: string;
  kind: AnswerKind;
  /**
   * The chosen option or the typed text; absent unless answered.
   *
   * A CHOSEN OPTION IS WRITTEN AS THE SCREEN WROTE IT — `A. the text` (user
   * decision, 2026-09-19). The dialog is gone by the time anyone reads the
   * transcript, so the letter is the only thing that still ties the record to
   * what the user saw. Everything that is NOT an option (a typed reason, a
   * deferred-to-chat note) carries no letter, because it never had one.
   */
  answer?: string;
  /**
   * The option's OWN text, without the letter — what the caller's own
   * comparisons run on (the proxy grant is minted only for the option the
   * agent recommended). Absent when the answer was not one of the options.
   */
  option?: string;
  /**
   * THE TICKED OPTIONS, as text, in option order — present for a checklist
   * answer only (2026-09-22), empty when the user confirmed with nothing
   * ticked. The caller that wants structure reads this instead of splitting
   * `answer` back apart.
   */
  options?: string[];
}

/**
 * The interview's one typed escape, offered inside the template's reason box.
 *
 * THERE IS NO "skip the rest" ROW ANY MORE (user decision, 2026-09-17): it
 * promised what closing the box already does, in a second vocabulary — and
 * every way out of an interview that is not "close the box" is one more thing
 * the user has to know. Closing stops the whole interview; see
 * resolveQuestion.
 */
export const ANSWER_IN_CHAT_INPUT = "!chat";

/**
 * Clean up what the agent submitted, and REFUSE the whole batch when it does
 * not follow the template (user decision, 2026-09-08).
 *
 * It used to be tolerant — empties discarded, a missing recommendation
 * tolerated, a question with no options silently degraded to a free-text box
 * — on the theory that refusing would send the agent back to guessing. The
 * user chose the opposite, and the dialogs show why: a question the agent did
 * not think through arrives as a dialog the user cannot answer with one
 * keystroke. A rejected batch costs one rewrite; a bad dialog costs the
 * user's attention every single time.
 *
 * Sizes are still capped rather than refused (an over-long question, an
 * over-long option, more options than the template allows) — those are
 * mechanical, and the reply says what was cut. The NUMBER of questions is not
 * capped any more (2026-09-17): asking every one of them, with the box as the
 * user's way out, is the one behaviour that never silently swallows one.
 */
export type QuestionsResult =
  | { ok: true; questions: AskQuestion[]; trimmedOptions: number }
  | { ok: false; error: string };

export function validateQuestions(raw: unknown): QuestionsResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      error: "没有提交任何问题 —— 每题要写完整文本、2–4 个选项和一个 recommended（推荐值须与其中一个选项完全相同）。",
    };
  }
  const questions: AskQuestion[] = [];
  let trimmedOptions = 0;
  for (const [index, item] of raw.entries()) {
    const where = `第 ${index + 1} 个问题`;
    const normalized = normalizeOne(item);
    if (!normalized) return { ok: false, error: `${where}没有可读的 text —— 每题都要有完整的问题文本。` };
    const question = normalized.question;
    // A DEFAULT TICK ON A RADIO QUESTION IS A MISTAKE, NOT A NO-OP (2026-09-22):
    // silently dropping it would let an agent believe the box opens with its
    // picks while the user sees a plain single-choice list.
    if (!question.multiple && (item as { defaultChecked?: unknown } | null)?.defaultChecked !== undefined) {
      return {
        ok: false,
        error: `${where}带了 defaultChecked 但没有 multiple: true —— 默认勾选只对多选题有意义；` +
          "单选题请用 recommended 表达推荐值。",
      };
    }
    const bad = question.multiple
      ? validateMultiple(question, where)
      // A radio question owes its recommendation; a checkbox one owes the
      // default ticks instead (validateMultiple), which is the SAME promise
      // “Enter accepts what the asker recommends” under the other shape.
      : validateChoice(question.options, question.recommended, where);
    if (bad) return { ok: false, error: bad };
    if (normalized.trimmed) trimmedOptions += 1;
    questions.push(question);
  }
  return { ok: true, questions, trimmedOptions };
}

/**
 * What a MULTIPLE-CHOICE question must satisfy (user decision, 2026-09-22).
 *
 * The option list rules are the radio ones (2–4 rows, no duplicates) with the
 * recommendation NO LONGER required — `defaultChecked` is what a bare Enter
 * submits instead, and the whole point of requiring it is that the promise
 * 「直接回车 ＝ 接受提问方的推荐」 survives the shape change.
 */
function validateMultiple(q: AskQuestion, where: string): string | undefined {
  if (q.grantScope) {
    return `${where}既是多选题又带 grantScope —— 授权题的答案必须唯一（推荐哪一项就是授权哪一项），` +
      "因此只能是单选题。";
  }
  const bad = validateChoice(q.options, q.recommended, where, { recommendedRequired: false });
  if (bad) return bad;
  if (q.defaultChecked === undefined) {
    return `${where}是多选题但没有 defaultChecked —— 多选题必须显式给出推荐勾选的那一组，` +
      "想推荐一项都不勾就写 `defaultChecked: []`（直接回车交的就是这一组）。";
  }
  // THE SEPARATOR MAY NOT APPEAR IN AN OPTION (quality round P2, 2026-09-22).
  // `A. 甲 / C. 丙` is how a checklist answer is written down, so an option
  // whose own text contains `" / "` cannot be told apart from two ticks —
  // silently, and in the losing direction (the whole answer becomes
  // unreadable). Refused here, at the one entry every question comes through.
  for (const option of q.options) {
    if (option.includes(MULTI_ANSWER_SEPARATOR)) {
      return `${where}的选项 "${option}" 里含有多选答案的分隔符 "${MULTI_ANSWER_SEPARATOR.trim()}" —— ` +
        "它是勾选项之间的分隔符，出现在选项里就分不出「一项叫这个名字」与「勾了两项」；请换一种写法。";
    }
  }
  for (const option of q.defaultChecked) {
    if (!q.options.includes(option)) {
      return `${where}的 defaultChecked 里有不在选项里的 "${option}" —— 它只能从选项里选。`;
    }
  }
  return undefined;
}

interface NormalizedQuestion {
  question: AskQuestion;
  /** The option list had to be cut to MAX_CHOICE_OPTIONS. */
  trimmed: boolean;
}

function normalizeOne(item: unknown): NormalizedQuestion | undefined {
  const text = typeof item === "string"
    ? item
    : typeof (item as { text?: unknown })?.text === "string"
      ? (item as { text: string }).text
      : "";
  const trimmedText = text.trim().slice(0, MAX_QUESTION_CHARS);
  if (!trimmedText) return undefined;
  const rawOptions = (item as { options?: unknown })?.options;
  const all = Array.isArray(rawOptions)
    ? rawOptions
      .filter((o): o is string => typeof o === "string" && o.trim() !== "")
      .map((o) => o.trim().slice(0, MAX_CHOICE_OPTION_CHARS))
    : [];
  const options = all.slice(0, MAX_CHOICE_OPTIONS);
  const rawRecommended = (item as { recommended?: unknown })?.recommended;
  const recommended = typeof rawRecommended === "string" && rawRecommended.trim() !== ""
    ? rawRecommended.trim().slice(0, MAX_CHOICE_OPTION_CHARS)
    : "";
  const rawGrant = (item as { grantScope?: unknown })?.grantScope;
  const grantScope = typeof rawGrant === "string" && rawGrant.trim() !== ""
    ? rawGrant.trim().slice(0, MAX_CHOICE_OPTION_CHARS)
    : undefined;
  // A multiple-choice flag and its default ticks. The flag only counts when it
  // is exactly `true` (a `"yes"` is not a checkbox), and the ticks are kept
  // only when they were GIVEN — `undefined` is what the validator refuses.
  const multiple = (item as { multiple?: unknown })?.multiple === true;
  const rawChecked = (item as { defaultChecked?: unknown })?.defaultChecked;
  const defaultChecked = Array.isArray(rawChecked)
    ? rawChecked
      .filter((o): o is string => typeof o === "string" && o.trim() !== "")
      .map((o) => o.trim().slice(0, MAX_CHOICE_OPTION_CHARS))
    : undefined;
  // A grantScope question is ALWAYS a choice question (every question is),
  // and the scope is recognized from a fixed list — an agent cannot invent one.
  return {
    question: {
      text: trimmedText,
      options,
      recommended,
      ...(multiple ? { multiple: true as const } : {}),
      ...(multiple && defaultChecked !== undefined ? { defaultChecked } : {}),
      ...(grantScope && isGrantableScope(grantScope) ? { grantScope } : {}),
    },
    trimmed: all.length > options.length,
  };
}

/** "3 / 7" — the progress the gate tracks so the agent never counts. */
export function progressLabel(index: number, total: number): string {
  return `${index + 1} / ${total}`;
}

/**
 * The question as the gate's dialog shapes see it.
 *
 * A multiple-choice question carries its own shape marker: `defaultChecked`
 * present IS 「this is a checklist」 (lib/multi-choice-dialog.ts), and its
 * contents are the boxes the list opens with.
 */
export function choiceSpecOf(q: AskQuestion): ChoiceSpec {
  return {
    title: q.text,
    options: q.options,
    recommended: q.recommended,
    ...(q.multiple ? { defaultChecked: q.defaultChecked ?? [] } : {}),
  };
}

/**
 * This question's rows as TEXT — checkbox rows for a checklist, radio rows
 * otherwise. ONE statement of “what the question offers”, so the transcript
 * the user reads and the headless fallback can never disagree about the shape.
 */
export function questionRows(q: AskQuestion): string[] {
  const spec = choiceSpecOf(q);
  return isMultipleChoice(spec) ? multiChoiceRows(spec, defaultCheckedOf(spec)) : choiceRows(spec);
}

export type ChoiceMeaning =
  | { kind: "answered"; answer: string; option?: string; options?: string[] }
  | { kind: "deferred-to-chat" }
  | { kind: "dismissed" };

/**
 * What a line the user picked MEANS. `undefined` is a dismissed dialog
 * (ESC): deliberately NOT an answer and NOT a skip — the caller decides,
 * and treating a dismissal as consent is how a gate invents approvals.
 */
export function interpretChoice(picked: string | undefined, q: AskQuestion): ChoiceMeaning {
  const parsed = parseChoice(picked, choiceSpecOf(q));
  if (parsed.kind === "dismissed") return { kind: "dismissed" };
  if (parsed.kind === "chose") {
    // An option the dialog OFFERED carries its letter into the record; free
    // text (a project manager's own words) is kept exactly as it arrived.
    const index = q.options.indexOf(parsed.option);
    return index < 0
      ? { kind: "answered", answer: parsed.option }
      : { kind: "answered", answer: optionLabel(parsed.option, q.options), option: parsed.option };
  }
  // The decline row: the user picked none of the options. What they typed is
  // either the interview's typed escape or the reason itself — and an empty
  // box is still an answer ("none of these, no reason given"), never a
  // silent dismissal.
  const typed = parsed.reason.trim().toLowerCase();
  if (typed === ANSWER_IN_CHAT_INPUT) return { kind: "deferred-to-chat" };
  return {
    kind: "answered",
    answer: parsed.reason ? `不选，原因：${parsed.reason}` : "不选（未说明原因）",
  };
}

/** How a confirmed-but-empty checklist answer reads in the record. */
export const MULTI_NONE_ANSWER = "（一项都没勾）";

/**
 * What a line the user picked MEANS when the question is a CHECKLIST.
 *
 * Same three outcomes the radio shape has, with the one difference that makes
 * the shape worth having: the answer is a LIST. An EMPTY list is a real answer
 * here (the user confirmed without ticking anything — t5-stages' “every stage
 * off”), which is why it is spelled out rather than confused with silence:
 * `undefined` stays the dismissal it has always been.
 *
 * A line nobody can read is recorded VERBATIM with no ticks — a proxy that
 * answers a dialog with prose must not thereby tick boxes on the user's behalf.
 */
export function interpretMultiChoice(picked: string | undefined, q: AskQuestion): ChoiceMeaning {
  const parsed = parseMultiChoice(picked, choiceSpecOf(q));
  if (parsed.kind === "dismissed") return { kind: "dismissed" };
  if (parsed.kind === "declined") {
    const typed = parsed.reason.trim().toLowerCase();
    if (typed === ANSWER_IN_CHAT_INPUT) return { kind: "deferred-to-chat" };
    return {
      kind: "answered",
      answer: parsed.reason ? `不选，原因：${parsed.reason}` : "不选（未说明原因）",
      options: [],
    };
  }
  if (parsed.kind === "unreadable") {
    // NO `options` AT ALL, NOT AN EMPTY ARRAY (quality round P2, 2026-09-22):
    // an empty list means “the user ticked nothing”, and a caller that reads
    // only the structured half must not see a prose answer it cannot judge as
    // the same thing. `answer` still carries the text verbatim.
    return { kind: "answered", answer: parsed.text };
  }
  if (parsed.options.length === 0) return { kind: "answered", answer: MULTI_NONE_ANSWER, options: [] };
  return {
    kind: "answered",
    answer: multiSelectionLabel(parsed.options, q.options),
    options: parsed.options,
  };
}


/** What one settled question does to the interview. */
export interface QuestionResolution {
  answer: AskAnswer;
  /**
   * Set when THIS question is the one that stopped the rest of the interview
   * — the user closed its box instead of answering. An instruct interrupt is
   * deliberately NOT this: that is the channel's own `interrupted` outcome,
   * and a stopped dialog must never read as a user rejection.
   */
  stop?: true;
}

/**
 * What one settled question MEANS — the whole rule, in one pure place.
 *
 * IT EXISTS BECAUSE THE QUESTIONS ARE IN FLIGHT TOGETHER (2026-09-06). The
 * interview used to ask strictly one at a time, so "the user stopped the rest"
 * could be handled by simply not asking them. Every question of a batch is now
 * offered to the project manager the moment the interview starts, so a
 * question can come back ANSWERED even though the user later closed the box on
 * the rest — the manager answered it first, and "先答者生效" is the invariant
 * this whole channel is built on. Hence rule one:
 *
 *   AN ANSWER THE RACE DELIVERED IS ALWAYS HONOURED, whatever stopped the
 *   rest.
 *
 * "The race delivered it" is the exact bar, and it is the same one every gate
 * dialog has always been held to: the child's own race decides who answered
 * first, so an answer still sitting unread on the channel when the interview
 * stops was not first — precisely as an ESC has always beaten an answer the
 * poll had not picked up yet. Nothing here re-judges that; it reads the
 * outcome the race produced.
 *
 * CLOSING THE BOX IS THE WAY OUT (user decision, 2026-09-17). It stops the
 * remaining questions — `stop: true`, so the caller stops offering boxes — and
 * every one of them settles as unanswered, this one included. There used to be
 * a separate `skipped` outcome for the interview's own escape row; with the row
 * gone, a question nobody decided about is unanswered, one way or the other.
 */
export function resolveQuestion(
  q: AskQuestion,
  picked: string | undefined,
  opts: {
    /** This question's own box was taken down by an instruct. */
    interrupted?: boolean;
  } = {},
): QuestionResolution {
  if (picked !== undefined) {
    // WHICH READER READS IT IS THE SHAPE'S OWN BUSINESS: a checklist answer is
    // a list, and forcing it through the radio reader would keep exactly one
    // tick and silently drop the rest.
    const meaning = q.multiple ? interpretMultiChoice(picked, q) : interpretChoice(picked, q);
    if (meaning.kind === "answered") {
      return {
        answer: {
          question: q.text,
          kind: "answered",
          answer: meaning.answer,
          ...(meaning.option === undefined ? {} : { option: meaning.option }),
          ...(meaning.options === undefined ? {} : { options: meaning.options }),
        },
      };
    }
    if (meaning.kind === "deferred-to-chat") {
      return { answer: { question: q.text, kind: "deferred-to-chat" } };
    }
    // A dismissal reported WITH text is not a thing; fall through to silence.
  }
  // An instruct took the box away: nobody decided anything, and the reply must
  // not claim they did. Deliberately NOT a stop — the interrupt has already
  // settled the whole batch through the channel.
  if (opts.interrupted) return { answer: { question: q.text, kind: "unanswered" } };
  // Dismissed (ESC), or no dialog at all: the user asked for nothing — and
  // closing the box is how an interview gets stopped.
  return { answer: { question: q.text, kind: "unanswered" }, stop: true };
}


/**
 * WALKING BACK THROUGH AN INTERVIEW — the whole rule, as a pure step.
 *
 * WHY THE STATE MACHINE IS ITS OWN THING (user decision, 2026-09-19). The
 * interview renders ONE question at a time and settles it; the way back makes
 * that not a straight line any more — the box on screen is not always the
 * question the interview is waiting for. The rule has four branches and all
 * four are decisions about the CURSOR, not about dialogs:
 *
 *   - `← 返回上一题` moves the cursor one question back and renders it again;
 *   - the FIRST question cannot go further back (its list draws no such row,
 *     and a row that arrives anyway must not walk off the end);
 *   - a closed box is the interview's stop, from whichever question;
 *   - an answer to the anchored question settles IT, while an answer to a
 *     question reached by walking back OVERWRITES that one and sends the user
 *     back to the anchored question — the skipped questions keep the answers
 *     they already had (user decision, 2026-09-19: only the changed one is
 *     re-decided).
 *
 * It lives here, away from the dialogs, so every branch is drivable from a
 * test with three lines and no terminal — the interview's loop in
 * lib/ask-user-interview.ts only carries the branches out.
 */
export interface InterviewCursor {
  /** The question the interview is blocked on — where an answer ends the wait. */
  anchor: number;
  /** The question on screen right now: the anchor, or an earlier one. */
  cursor: number;
}

/** What the row the user picked does to the interview. */
export type InterviewStep =
  /** Render this question next. */
  | { kind: "render"; cursor: number }
  /** The box was closed: the whole interview stops here. */
  | { kind: "close" }
  /** The ANCHORED question was answered — the interview moves on to the next. */
  | { kind: "answerCurrent"; picked: string }
  /** A question reached by walking back was RE-answered: overwrite it, then return to the anchor. */
  | { kind: "revise"; index: number; picked: string };

export function stepInterview(state: InterviewCursor, picked: string | undefined): InterviewStep {
  if (picked === BACK_ROW) {
    return { kind: "render", cursor: state.cursor > 0 ? state.cursor - 1 : state.cursor };
  }
  if (picked === undefined) return { kind: "close" };
  if (state.cursor === state.anchor) return { kind: "answerCurrent", picked };
  return { kind: "revise", index: state.cursor, picked };
}

/**
 * The interview as the agent reads it back: every question with its answer,
 * including the ones nobody answered. Silence is reported as silence.
 */
export function formatAnswers(answers: AskAnswer[]): string {
  if (!answers.length) return "（没有问题）";
  return answers
    .map((a, i) => {
      const head = `${progressLabel(i, answers.length)} ${a.question}`;
      const body = a.kind === "answered"
        ? `→ ${a.answer}`
        : a.kind === "deferred-to-chat"
          ? "→ 用户选择在聊天里详细回答（等他的下一条消息）"
          : "→ 没有得到回答（用户关掉了对话框，或环境没有对话框）";
      return `${head}\n${body}`;
    })
    .join("\n");
}

/** How much of a question / answer one transcript line shows. */
export const TRANSCRIPT_QUESTION_CHARS = 60;
export const TRANSCRIPT_ANSWER_CHARS = 80;

/** One question, shortened to its first line and capped. */
function short(text: string, max: number): string {
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

/**
 * What the interview leaves in the TRANSCRIPT, one line per question.
 *
 * The dialogs are gone the moment they close and they write nothing of their
 * own, so this was the only lasting record of the Q&A — and it used to hold
 * COUNTS only ("已回答 2（共 2 问）"): neither the user nor the agent could see
 * afterwards WHAT was asked or WHICH option was chosen (user report,
 * 2026-08-29). It now shows each question with its answer, in O13 style: one
 * line each, the question shortened to its first line, the answer as the user
 * gave it — never the full option list, which is noise once a choice is made.
 */
export function formatTranscriptSummary(answers: AskAnswer[]): string {
  const answered = answers.filter((a) => a.kind === "answered").length;
  const deferred = answers.filter((a) => a.kind === "deferred-to-chat").length;
  const unanswered = answers.filter((a) => a.kind === "unanswered").length;
  const parts = [`已回答 ${answered}`];
  if (deferred) parts.push(`转聊天 ${deferred}`);
  if (unanswered) parts.push(`未作答 ${unanswered}`);
  const head = `${parts.join(" · ")}（共 ${answers.length} 问）`;
  const lines = answers.map((a, i) => {
    const outcome = a.kind === "answered"
      ? short(a.answer ?? "", TRANSCRIPT_ANSWER_CHARS)
      : a.kind === "deferred-to-chat"
        ? "（转聊天回答）"
        : "（未作答）";
    return `${progressLabel(i, answers.length)} ${short(a.question, TRANSCRIPT_QUESTION_CHARS)} → ${outcome}`;
  });
  return [head, ...lines].join("\n");
}

/**
 * Does the agent still owe the user a reply in chat? True when anything was
 * left unanswered — the loop must stop and wait rather than push on with a
 * decision the user did not make.
 */
export function needsUserReply(answers: AskAnswer[]): boolean {
  return answers.some((a) => a.kind !== "answered");
}

/** An interview in progress, persisted so an interrupted one can continue. */
export interface AskProgress {
  at: string;
  answers: AskAnswer[];
}

/**
 * Where to pick a repeated interview up.
 *
 * The gate persists progress after EVERY question, so a session that died
 * mid-interview (or an agent that re-submitted the same list) resumes at the
 * first unanswered question instead of asking the user everything again. The
 * stored run must match this call question-for-question — a different list is
 * a different interview, and reusing its answers would attribute the user's
 * words to a question they never saw.
 */
export function resumeFrom(stored: AskProgress | undefined, questions: AskQuestion[]): AskAnswer[] {
  if (!stored?.answers?.length) return [];
  const sameInterview = stored.answers.length <= questions.length &&
    stored.answers.every((a, i) => a.question === questions[i]?.text);
  if (!sameInterview) return [];
  // Only a PREFIX of settled answers carries over: the first unsettled one is
  // where the interview resumes.
  const carried: AskAnswer[] = [];
  for (const a of stored.answers) {
    if (a.kind === "answered") carried.push(a);
    else break;
  }
  return carried;
}

/**
 * The reply for an environment with no dialogs at all (headless / RPC).
 *
 * The failure this prevents was measured: the tool reported a completed
 * interview, paused the loop, and waited for answers to questions the user
 * was never shown. When nothing could be rendered, the agent must be told to
 * carry the questions itself.
 */
export function buildNoDialogNotice(questions: AskQuestion[]): string {
  return "review-gate: 这个环境没有可用的对话框（headless / RPC），问题一个都没能展示给用户。\n" +
    "把下面的问题原样写进你的回复，然后结束本轮，等用户回答" +
    "（这是「declare_done 前不结束 turn」的唯一一类例外：在等人）：\n" +
    questions.map((q, i) =>
      `${progressLabel(i, questions.length)} ${q.text}\n   选项：${questionRows(q).join(" / ")}`).join("\n");
}

