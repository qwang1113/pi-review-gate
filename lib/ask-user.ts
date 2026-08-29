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

/** The escape hatches every question offers (user ask). */
export const SKIP_REST_CHOICE = "⏭ 跳过后续问题";
export const ANSWER_IN_CHAT_CHOICE = "💬 我想在聊天里详细回答";

/** Typed into a free-text question, these mean the same as the choices above. */
export const SKIP_REST_INPUT = "!skip";
export const ANSWER_IN_CHAT_INPUT = "!chat";

/** The hint a free-text dialog shows, so its escapes are discoverable. */
export const FREE_TEXT_HINT = `直接输入答案；${ANSWER_IN_CHAT_INPUT}=改在聊天里答，${SKIP_REST_INPUT}=跳过后续`;

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
 * What free text MEANS. A free-text dialog has no choice list, so its escapes
 * are typed (`!chat`, `!skip`) — without them, criterion 5's two exits would
 * exist for choice questions only.
 */
export function interpretFreeText(typed: string | undefined): ChoiceMeaning {
  if (typed === undefined) return { kind: "dismissed" };
  const trimmed = typed.trim();
  if (trimmed === "") return { kind: "dismissed" };
  if (trimmed.toLowerCase() === SKIP_REST_INPUT) return { kind: "skip-rest" };
  if (trimmed.toLowerCase() === ANSWER_IN_CHAT_INPUT) return { kind: "deferred-to-chat" };
  return { kind: "answered", answer: trimmed };
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

/** A short transcript line so the Q&A stays visible after the dialogs close. */
export function formatTranscriptSummary(answers: AskAnswer[]): string {
  const answered = answers.filter((a) => a.kind === "answered").length;
  const skipped = answers.filter((a) => a.kind === "skipped").length;
  const deferred = answers.filter((a) => a.kind === "deferred-to-chat").length;
  const unanswered = answers.filter((a) => a.kind === "unanswered").length;
  const parts = [`已回答 ${answered}`];
  if (deferred) parts.push(`转聊天 ${deferred}`);
  if (skipped) parts.push(`跳过 ${skipped}`);
  if (unanswered) parts.push(`未作答 ${unanswered}`);
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
      `${progressLabel(i, questions.length)} ${q.text}` +
      (q.options?.length ? `\n   选项：${q.options.join(" / ")}` : "") +
      (q.recommended ? `\n   推荐：${q.recommended}` : "")).join("\n");
}

