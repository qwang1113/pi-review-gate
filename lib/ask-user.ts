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
 * Everything here is pure: question hygiene, the choice list a dialog shows,
 * what a chosen line MEANS, and how the finished interview reads. The
 * extension owns the dialogs and the persistence.
 */

/** Hard caps: an interview is a decision point, not a survey. */
export const MAX_QUESTIONS = 10;
export const MAX_QUESTION_CHARS = 1200;
export const MAX_OPTION_CHARS = 120;
export const MAX_OPTIONS = 8;

/** One question as the agent wrote it. */
export interface AskQuestion {
  /** The question itself, including context the user needs to decide. */
  text: string;
  /** Choices, when the decision is a pick rather than free text. */
  options?: string[];
  /** The agent's own recommendation — the user should never have to guess it. */
  recommended?: string;
}

/** What the user did with one question. */
export type AnswerKind =
  /** They answered (dialog choice or typed text). */
  | "answered"
  /** They cut the interview short before reaching this one. */
  | "skipped"
  /** They asked to answer this one in chat instead of a dialog. */
  | "deferred-to-chat";

export interface AskAnswer {
  question: string;
  kind: AnswerKind;
  /** The chosen option or the typed text; absent for skipped/deferred. */
  answer?: string;
}

/** The two escape hatches every question offers (user ask). */
export const SKIP_REST_CHOICE = "⏭ 跳过后续问题";
export const ANSWER_IN_CHAT_CHOICE = "💬 我想在聊天里详细回答";

/**
 * Clean up what the agent submitted: drop empties, cap sizes and counts.
 * Never throws — a malformed list becomes a shorter valid one, because
 * refusing the whole interview would send the agent back to guessing.
 */
export function normalizeQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const item of raw) {
    const q = normalizeOne(item);
    if (q) out.push(q);
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out;
}

function normalizeOne(item: unknown): AskQuestion | undefined {
  const text = typeof item === "string"
    ? item
    : typeof (item as { text?: unknown })?.text === "string"
      ? (item as { text: string }).text
      : "";
  const trimmed = text.trim().slice(0, MAX_QUESTION_CHARS);
  if (!trimmed) return undefined;
  const rawOptions = (item as { options?: unknown })?.options;
  const options = Array.isArray(rawOptions)
    ? rawOptions
      .filter((o): o is string => typeof o === "string" && o.trim() !== "")
      .map((o) => o.trim().slice(0, MAX_OPTION_CHARS))
      .slice(0, MAX_OPTIONS)
    : undefined;
  const rawRecommended = (item as { recommended?: unknown })?.recommended;
  const recommended = typeof rawRecommended === "string" && rawRecommended.trim() !== ""
    ? rawRecommended.trim().slice(0, MAX_OPTION_CHARS)
    : undefined;
  return {
    text: trimmed,
    ...(options && options.length ? { options } : {}),
    ...(recommended ? { recommended } : {}),
  };
}

/** "3 / 7" — the progress the gate tracks so the agent never counts. */
export function progressLabel(index: number, total: number): string {
  return `${index + 1} / ${total}`;
}

/**
 * The lines a choice dialog shows for one question: the agent's options
 * (recommendation marked) plus the two escapes. A question with no options is
 * a free-text one and gets no choice list.
 */
export function buildChoiceList(q: AskQuestion): string[] {
  if (!q.options?.length) return [];
  const marked = q.options.map((o) => (o === q.recommended ? `${o}（推荐）` : o));
  return [...marked, ANSWER_IN_CHAT_CHOICE, SKIP_REST_CHOICE];
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
  if (picked === undefined) return { kind: "dismissed" };
  if (picked === SKIP_REST_CHOICE) return { kind: "skip-rest" };
  if (picked === ANSWER_IN_CHAT_CHOICE) return { kind: "deferred-to-chat" };
  // Strip the recommendation marker so the agent gets the option it wrote.
  const original = q.options?.find((o) => picked === o || picked === `${o}（推荐）`);
  return { kind: "answered", answer: original ?? picked };
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
          : "→ 用户跳过";
      return `${head}\n${body}`;
    })
    .join("\n");
}

/** A short transcript line so the Q&A stays visible after the dialogs close. */
export function formatTranscriptSummary(answers: AskAnswer[]): string {
  const answered = answers.filter((a) => a.kind === "answered").length;
  const skipped = answers.filter((a) => a.kind === "skipped").length;
  const deferred = answers.filter((a) => a.kind === "deferred-to-chat").length;
  const parts = [`已回答 ${answered}`];
  if (deferred) parts.push(`转聊天 ${deferred}`);
  if (skipped) parts.push(`跳过 ${skipped}`);
  return `${parts.join(" · ")}（共 ${answers.length} 问）`;
}

/**
 * Does the agent still owe the user a reply in chat? True when anything was
 * left unanswered — the loop must stop and wait rather than push on with a
 * decision the user did not make.
 */
export function needsUserReply(answers: AskAnswer[]): boolean {
  return answers.some((a) => a.kind !== "answered");
}
