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
 * user cut the interview short, and handing every answer back at once — so
 * the agent only ever writes the questions.
 *
 * Everything here is pure: question hygiene, what a chosen line MEANS, and
 * how the finished interview reads. The SHAPE of a question — the rows, the
 * recommendation marker, the `✎ 不选，我说明原因` row — is not owned here any
 * more: it is the gate's one question template (lib/choice-dialog.ts), which
 * every dialog in the gate now shares (user decision, 2026-09-08). The
 * extension owns the dialogs and the persistence.
 */

import {
  MAX_CHOICE_OPTION_CHARS,
  MAX_CHOICE_OPTIONS,
  choiceRows,
  parseChoice,
  validateChoice,
  type ChoiceSpec,
} from "./choice-dialog.ts";

/** Hard caps: an interview is a decision point, not a survey. */
export const MAX_QUESTIONS = 10;
export const MAX_QUESTION_CHARS = 1200;

/** One question as the agent wrote it — always a choice question. */
export interface AskQuestion {
  /** The question itself, including context the user needs to decide. */
  text: string;
  /** 2–4 choices. There is no free-text question any more (2026-09-08). */
  options: string[];
  /** The agent's own recommendation — must equal one of `options`. */
  recommended: string;
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
 * `sensitive-edit` today; "运维类" is deliberately not a scope until the
 * user names the operations it should cover.
 */
export const GRANTABLE_SCOPES = ["sensitive-edit"] as const;

/** True when `scope` is a grantable proxy scope. */
export function isGrantableScope(scope: string | undefined): scope is string {
  return scope !== undefined && (GRANTABLE_SCOPES as readonly string[]).includes(scope);
}

/** What the user did with one question. */
export type AnswerKind =
  /** They answered (dialog choice or typed text). */
  | "answered"
  /** They cut the interview short before reaching this one. */
  | "skipped"
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
  /** The chosen option or the typed text; absent unless answered. */
  answer?: string;
}

/**
 * The interview's own escape, kept as an explicit ROW because it stops the
 * whole interview rather than answering one question. "Answer in chat" is
 * not a row any more: it is one of the typed escapes below, offered inside
 * the template's reason box.
 */
export const SKIP_REST_CHOICE = "⏭ 跳过后续问题";

/** Typed into the template's reason box, these mean the escapes above. */
export const SKIP_REST_INPUT = "!skip";
export const ANSWER_IN_CHAT_INPUT = "!chat";

/**
 * Clean up what the agent submitted, and REFUSE the whole batch when it does
 * not follow the template (user decision, 2026-09-08).
 *
 * It used to be tolerant — empties dropped, a missing recommendation
 * tolerated, a question with no options silently degraded to a free-text box
 * — on the theory that refusing would send the agent back to guessing. The
 * user chose the opposite, and the dialogs show why: a question the agent did
 * not think through arrives as a dialog the user cannot answer with one
 * keystroke. A rejected batch costs one rewrite; a bad dialog costs the
 * user's attention every single time.
 *
 * Sizes are still capped rather than refused (more questions than
 * MAX_QUESTIONS, an over-long option, more options than the template allows)
 * — those are mechanical, and the reply says what was cut.
 */
export type QuestionsResult =
  | { ok: true; questions: AskQuestion[]; dropped: number; trimmedOptions: number }
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
    const bad = validateChoice(normalized.question.options, normalized.question.recommended, where);
    if (bad) return { ok: false, error: bad };
    if (normalized.trimmed) trimmedOptions += 1;
    questions.push(normalized.question);
    if (questions.length >= MAX_QUESTIONS) break;
  }
  return { ok: true, questions, dropped: Math.max(0, raw.length - questions.length), trimmedOptions };
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
  // A grantScope question is ALWAYS a choice question (every question is),
  // and the scope is recognized from a fixed list — an agent cannot invent one.
  return {
    question: {
      text: trimmedText,
      options,
      recommended,
      ...(grantScope && isGrantableScope(grantScope) ? { grantScope } : {}),
    },
    trimmed: all.length > options.length,
  };
}

/** "3 / 7" — the progress the gate tracks so the agent never counts. */
export function progressLabel(index: number, total: number): string {
  return `${index + 1} / ${total}`;
}

/** The question as the gate's one template sees it. */
export function choiceSpecOf(q: AskQuestion): ChoiceSpec {
  return { title: q.text, options: q.options, recommended: q.recommended };
}

/**
 * The rows one question shows: the options (recommendation marked), the
 * template's `✎ 不选，我说明原因` row, then the interview's own escape.
 *
 * The decline row is where "none of these" lives in EVERY gate dialog;
 * `⏭ 跳过后续问题` is interview-only, because only an interview has later
 * questions to skip.
 */
export function buildChoiceList(q: AskQuestion): string[] {
  return [...choiceRows(choiceSpecOf(q)), SKIP_REST_CHOICE];
}

export type ChoiceMeaning =
  | { kind: "answered"; answer: string }
  | { kind: "deferred-to-chat" }
  | { kind: "skip-rest" }
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
    if (parsed.option === SKIP_REST_CHOICE) return { kind: "skip-rest" };
    return { kind: "answered", answer: parsed.option };
  }
  // The decline row: the user picked none of the options. What they typed is
  // either one of the interview's typed escapes or the reason itself — and an
  // empty box is still an answer ("none of these, no reason given"), never a
  // silent dismissal.
  const typed = parsed.reason.trim().toLowerCase();
  if (typed === SKIP_REST_INPUT) return { kind: "skip-rest" };
  if (typed === ANSWER_IN_CHAT_INPUT) return { kind: "deferred-to-chat" };
  return {
    kind: "answered",
    answer: parsed.reason ? `不选，原因：${parsed.reason}` : "不选（未说明原因）",
  };
}


/**
 * Why the rest of an interview will never be shown.
 *
 * `skip-rest` is the user pressing the escape row; `interrupted` is the
 * project manager firing an instruct, which takes every open box down at
 * once. They are kept apart because they settle the unshown questions
 * differently on the wire (`dismissed` vs `interrupted`), and because a
 * stopped goal approval must never read as a rejection — the same distinction
 * the channel already draws.
 */
export type InterviewStop = "skip-rest" | "interrupted";

/** What one settled question does to the interview. */
export interface QuestionResolution {
  answer: AskAnswer;
  /** Set when THIS question is the one that stops the remaining ones. */
  stop?: InterviewStop;
}

/**
 * What one settled question MEANS — the whole rule, in one pure place.
 *
 * IT EXISTS BECAUSE THE QUESTIONS ARE NOW IN FLIGHT TOGETHER (2026-09-06).
 * The interview used to ask strictly one at a time, so "the user skipped the
 * rest" could be handled by simply not asking them. Every question of a batch
 * is now offered to the project manager the moment the interview starts, so a
 * question can come back ANSWERED even though the user later pressed "skip
 * the rest" — the manager answered it first, and "先答者生效" is the
 * invariant this whole channel is built on. Hence rule one:
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
 * Only silence is interpreted by the stop reason: skipped when the user chose
 * to skip, unanswered when an instruct took the box away (nobody decided
 * anything — the reply must not claim they did).

 */
export function resolveQuestion(
  q: AskQuestion,
  picked: string | undefined,
  opts: {
    /** This question's own box was taken down by an instruct. */
    interrupted?: boolean;
    /** The interview had already stopped when this question settled. */
    stopped?: InterviewStop;
  } = {},
): QuestionResolution {
  if (picked !== undefined) {
    const meaning = interpretChoice(picked, q);
    if (meaning.kind === "skip-rest") {
      return { answer: { question: q.text, kind: "skipped" }, stop: "skip-rest" };
    }
    if (meaning.kind === "answered") {
      return { answer: { question: q.text, kind: "answered", answer: meaning.answer } };
    }
    if (meaning.kind === "deferred-to-chat") {
      return { answer: { question: q.text, kind: "deferred-to-chat" } };
    }
    // A dismissal reported WITH text is not a thing; fall through to silence.
  }
  if (opts.interrupted) {
    return { answer: { question: q.text, kind: "unanswered" }, stop: "interrupted" };
  }
  if (opts.stopped === "skip-rest") {
    return { answer: { question: q.text, kind: "skipped" } };
  }
  // Dismissed (ESC), no dialog at all, or an interview already stopped by an
  // instruct: the user asked for nothing, and the reply must say so.
  return { answer: { question: q.text, kind: "unanswered" } };
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
          : a.kind === "skipped"
            ? "→ 用户跳过"
            : "→ 没有得到回答（对话框被关闭，或环境没有对话框）";
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
  const skipped = answers.filter((a) => a.kind === "skipped").length;
  const deferred = answers.filter((a) => a.kind === "deferred-to-chat").length;
  const unanswered = answers.filter((a) => a.kind === "unanswered").length;
  const parts = [`已回答 ${answered}`];
  if (deferred) parts.push(`转聊天 ${deferred}`);
  if (skipped) parts.push(`跳过 ${skipped}`);
  if (unanswered) parts.push(`未作答 ${unanswered}`);
  const head = `${parts.join(" · ")}（共 ${answers.length} 问）`;
  const lines = answers.map((a, i) => {
    const outcome = a.kind === "answered"
      ? short(a.answer ?? "", TRANSCRIPT_ANSWER_CHARS)
      : a.kind === "deferred-to-chat"
        ? "（转聊天回答）"
        : a.kind === "skipped"
          ? "（跳过）"
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
    if (a.kind === "answered" || a.kind === "skipped") carried.push(a);
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
    "把下面的问题原样写进你的回复，然后结束本轮，等用户回答：\n" +
    questions.map((q, i) =>
      `${progressLabel(i, questions.length)} ${q.text}\n   选项：${buildChoiceList(q).join(" / ")}`).join("\n");
}

