/**
 * THE PENDING-QUESTION PROTOCOL — the file half of "answer it from the browser".
 *
 * ── WHAT IT IS ──
 *
 * A gate session that is about to open a dialog writes the question to a file
 * before it renders it; the daemon reads that directory, lists the questions
 * over HTTP, and writes the chosen answer back to a second file. Whoever gets
 * there first wins (the human in the pane, or the panel), and the gate removes
 * the pair once it has consumed one.
 *
 *     ~/.pi/agent/rg-daemon/questions/<sessionId>/<requestId>.json           the question
 *     ~/.pi/agent/rg-daemon/questions/<sessionId>/<requestId>.answer.json    the answer
 *
 * ── WHY A DIRECTORY PER SESSION ──
 *
 * A request id is minted inside one session's dialog queue and is only unique
 * there; the directory is what makes `(sessionId, requestId)` the identity of
 * one ASK rather than of one string. It also means a session that dies takes
 * its unanswered questions with it (the whole directory is its own), which is
 * the honest reading: nobody is waiting on them any more.
 *
 * ── WHO OWNS WHAT ──
 *
 * The GATE writes the question and deletes both files when the question is
 * settled; the DAEMON lists what has no answer yet and writes the answer. The
 * daemon never invents a question and never answers one twice: a second answer
 * to the same request is refused while the answer file is there.
 *
 * The answer's own validation is NOT re-implemented here — `resolveAnswer`
 * (lib/orchestrator-answer-rules.ts) is the rule the project manager's channel
 * answers already obey, so a letter, a row quoted verbatim, a whole list on a
 * checkbox question and the decline row all mean here exactly what they mean
 * there.
 *
 * ── THE FORMAT IS FROZEN IN docs/daemon/api.md ──
 *
 * Field names, the option/multiple/batch shape and the pending rule
 * (question present, answer absent) are the contract other tasks build
 * against. This module is its implementation; the document is its authority.
 */

import { linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { resolveAnswer, resolveAnswerList } from "../orchestrator-answer-rules.ts";
import {
  questionAnswerPath,
  questionPath,
  questionsRoot,
  sessionIdProblem,
  sessionQuestionsDir,
} from "./paths.ts";

export const QUESTION_SCHEMA = 1;

/** One safe path segment, same shape the channel's request ids already have. */
export const REQUEST_ID_PATTERN = /^(?!.*\.\.)[A-Za-z0-9._-]{1,64}$/;

export interface QuestionPayloadRef {
  path: string;
  chars: number;
}

/** A question as it sits on disk (frozen; see docs/daemon/api.md). */
export interface DaemonQuestion {
  schema: typeof QUESTION_SCHEMA;
  requestId: string;
  sessionId: string;
  sessionName: string | null;
  /** `ask-user` | `goal-approval` | `restatement` | … — the gate's own topic word. */
  topic: string;
  title: string;
  options: string[];
  multiple: boolean;
  recommended: string | null;
  defaultChecked: string[];
  payload: string | null;
  payloadRef: QuestionPayloadRef | null;
  batchId: string | null;
  batchIndex: number | null;
  batchTotal: number | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface DaemonAnswer {
  schema: typeof QUESTION_SCHEMA;
  requestId: string;
  sessionId: string;
  answer: string;
  by: "daemon" | "user";
  reason: string | null;
  at: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; problem: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Parse one stored question. Every doubt is a problem string, never a throw. */
export function parseQuestion(raw: unknown): ParseResult<DaemonQuestion> {
  if (!raw || typeof raw !== "object") return { ok: false, problem: "不是 JSON 对象" };
  const value = raw as Record<string, unknown>;
  if (value.schema !== QUESTION_SCHEMA) return { ok: false, problem: `schema 必须是 ${QUESTION_SCHEMA}` };
  const requestId = text(value.requestId);
  if (!REQUEST_ID_PATTERN.test(requestId)) return { ok: false, problem: "requestId 缺失或不合法" };
  const sessionId = text(value.sessionId);
  const idProblem = sessionIdProblem(sessionId);
  if (idProblem !== undefined) return { ok: false, problem: idProblem };
  const title = typeof value.title === "string" ? value.title : "";
  if (title.trim() === "") return { ok: false, problem: "title 不能为空" };
  const options = Array.isArray(value.options) ? value.options.filter((o): o is string => typeof o === "string") : [];
  const multiple = value.multiple === true;
  const recommended = text(value.recommended);
  if (recommended !== "" && !options.includes(recommended)) {
    return { ok: false, problem: `recommended "${recommended}" 不在 options 里` };
  }
  if (!multiple && options.length > 0 && recommended === "") {
    return { ok: false, problem: "单选题必须给 recommended" };
  }
  const defaultChecked = Array.isArray(value.defaultChecked)
    ? value.defaultChecked.filter((o): o is string => typeof o === "string" && options.includes(o))
    : [];
  const payloadRefRaw = value.payloadRef;
  let payloadRef: QuestionPayloadRef | null = null;
  if (payloadRefRaw && typeof payloadRefRaw === "object") {
    const ref = payloadRefRaw as Record<string, unknown>;
    const path = text(ref.path);
    if (path !== "") payloadRef = { path, chars: typeof ref.chars === "number" ? ref.chars : 0 };
  }
  const batchId = text(value.batchId);
  return {
    ok: true,
    value: {
      schema: QUESTION_SCHEMA,
      requestId,
      sessionId,
      sessionName: text(value.sessionName) || null,
      topic: text(value.topic) || "other",
      title,
      options,
      multiple,
      recommended: recommended === "" ? null : recommended,
      defaultChecked,
      payload: typeof value.payload === "string" ? value.payload : null,
      payloadRef,
      batchId: batchId === "" ? null : batchId,
      batchIndex: typeof value.batchIndex === "number" ? value.batchIndex : null,
      batchTotal: typeof value.batchTotal === "number" ? value.batchTotal : null,
      createdAt: text(value.createdAt) || new Date().toISOString(),
      expiresAt: text(value.expiresAt) || null,
    },
  };
}

export function parseAnswer(raw: unknown): ParseResult<DaemonAnswer> {
  if (!raw || typeof raw !== "object") return { ok: false, problem: "不是 JSON 对象" };
  const value = raw as Record<string, unknown>;
  if (value.schema !== QUESTION_SCHEMA) return { ok: false, problem: `schema 必须是 ${QUESTION_SCHEMA}` };
  const requestId = text(value.requestId);
  if (!REQUEST_ID_PATTERN.test(requestId)) return { ok: false, problem: "requestId 缺失或不合法" };
  const sessionId = text(value.sessionId);
  const idProblem = sessionIdProblem(sessionId);
  if (idProblem !== undefined) return { ok: false, problem: idProblem };
  const answer = text(value.answer);
  if (answer === "") return { ok: false, problem: "answer 不能为空" };
  return {
    ok: true,
    value: {
      schema: QUESTION_SCHEMA,
      requestId,
      sessionId,
      answer,
      by: value.by === "user" ? "user" : "daemon",
      reason: text(value.reason) || null,
      at: text(value.at) || new Date().toISOString(),
    },
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Is this question the one the PATH says it is?
 *
 * The identity of one ask is `(directory sessionId, filename requestId)`, and the
 * file's own fields must agree with it (docs/daemon/api.md §7.2). Without this
 * check a file planted at one path — or a producer that wrote a mismatched
 * pair — is listed as a DIFFERENT request and, worse, the answer would be
 * written under the path the daemon invented rather than the one the asking
 * session is watching (reviewer P1, 2026-10-01).
 */
function matchesPath(question: DaemonQuestion, sessionId: string, requestId: string): boolean {
  return question.sessionId === sessionId && question.requestId === requestId;
}

/** Is this question still waiting for an answer? */
export function isPending(home: string, question: DaemonQuestion): boolean {
  try {
    readFileSync(questionAnswerPath(home, question.sessionId, question.requestId), "utf8");
    return false; // an answer is already there
  } catch {
    return true;
  }
}

export interface QuestionList {
  questions: DaemonQuestion[];
  /** Files that could not be read or parsed — reported, never silently skipped. */
  problems: string[];
}

/**
 * Every unanswered question on the machine, newest first.
 *
 * A session filter narrows the walk to one directory; without it every session
 * directory is read. A session with no questions has no directory at all, so
 * the common case costs one `readdir`.
 */
export function listPendingQuestions(home: string, opts: { sessionId?: string } = {}): QuestionList {
  const problems: string[] = [];
  const questions: DaemonQuestion[] = [];
  const root = questionsRoot(home);
  let dirs: string[];
  try {
    dirs = opts.sessionId === undefined ? readdirSync(root) : [opts.sessionId];
  } catch {
    return { questions, problems };
  }
  for (const sessionId of dirs) {
    if (sessionIdProblem(sessionId) !== undefined) continue;
    if (opts.sessionId !== undefined && sessionId !== opts.sessionId) continue;
    let files: string[];
    try {
      files = readdirSync(sessionQuestionsDir(home, sessionId));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json") || file.endsWith(".answer.json")) continue;
      const requestId = file.slice(0, -".json".length);
      const parsed = parseQuestion(readJson(questionPath(home, sessionId, requestId)));
      if (!parsed.ok) {
        problems.push(`${sessionId}/${file}: ${parsed.problem}`);
        continue;
      }
      if (!matchesPath(parsed.value, sessionId, requestId)) {
        problems.push(`${sessionId}/${file}: 文件里的 sessionId/requestId 与路径不一致，不确定它属于哪次询问，已忽略`);
        continue;
      }
      if (!isPending(home, parsed.value)) continue;
      questions.push(parsed.value);
    }
  }
  questions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { questions, problems };
}

export interface AnswerOutcome {
  ok: boolean;
  /** The canonical answer, when one was written. */
  answer?: string;
  problem?: string;
  /** The path the answer landed in — for the receipt. */
  path?: string;
}

/**
 * Answer one pending question.
 *
 * Refusals are all the same shape (nothing was written): an unknown request, a
 * question whose file does not belong to the path it was found at, a question
 * that already has an answer, or an answer `resolveAnswer` cannot read against
 * the rows the question offered.
 *
 * FIRST ANSWER WINS, ATOMICALLY (reviewer P1, 2026-10-01): the answer file is
 * created with `O_EXCL`, so the daemon and the pane (or two callers) racing on
 * one request cannot both write — the loser gets EEXIST and is told the
 * question is already answered. A plain atomic replace would have let the
 * second write silently overwrite the first, which is the opposite of "谁先答
 * 算谁的".
 */
export function submitAnswer(
  home: string,
  input: {
    sessionId: string;
    requestId: string;
    /** Free-form text a human (or the panel's decline row) typed. */
    answer?: string;
    /** Already-split rows: the caller picked these options, so do not re-parse them as text. */
    answers?: readonly string[];
    by?: "daemon" | "user";
    reason?: string;
  },
): AnswerOutcome {
  const idProblem = sessionIdProblem(input.sessionId);
  if (idProblem !== undefined) return { ok: false, problem: idProblem };
  if (!REQUEST_ID_PATTERN.test(input.requestId)) return { ok: false, problem: "requestId 不合法" };
  const parsed = parseQuestion(readJson(questionPath(home, input.sessionId, input.requestId)));
  if (!parsed.ok) return { ok: false, problem: `读不到这个问题：${parsed.problem}` };
  if (!matchesPath(parsed.value, input.sessionId, input.requestId)) {
    return { ok: false, problem: "问题的 sessionId/requestId 与它的路径不一致 —— 不向一个对不上的位置写答案" };
  }
  if (!isPending(home, parsed.value)) return { ok: false, problem: "这个问题已经答过了（答案文件已存在）" };
  const request = { options: parsed.value.options, ...(parsed.value.multiple ? { multiple: true } : {}) };
  // TWO SHAPES, TWO READINGS (quality round P1, 2026-10-01): a list of rows is
  // matched row by row, a text answer keeps the human reading it always had.
  const resolved =
    input.answers === undefined ? resolveAnswer(request, input.answer ?? "") : resolveAnswerList(request, input.answers);
  if (!resolved.ok) return { ok: false, problem: resolved.reason };
  const answer: DaemonAnswer = {
    schema: QUESTION_SCHEMA,
    requestId: input.requestId,
    sessionId: input.sessionId,
    answer: resolved.answer,
    by: input.by === "user" ? "user" : "daemon",
    reason: input.reason === undefined || input.reason.trim() === "" ? null : input.reason.trim(),
    at: new Date().toISOString(),
  };
  const path = questionAnswerPath(home, input.sessionId, input.requestId);
  // TWO STEPS, TWO MEANINGS (reviewer P2, 2026-10-01): only the LINK can report
  // "somebody answered first". A failure while writing the temp file is a write
  // failure — reporting it as "已经答过了" would freeze the panel on a question
  // nobody answered. A RANDOM temp suffix keeps a crashed run's leftover from
  // colliding with this one.
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    mkdirSync(sessionQuestionsDir(home, input.sessionId), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(answer, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    return { ok: false, problem: `答案写入失败：${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    // ATOMIC **AND** EXCLUSIVE: the link fails with EEXIST when somebody got
    // there first, and the name only ever appears with the complete document
    // behind it (a truncated answer file would both vanish from the pending list
    // and refuse every later answer).
    linkSync(tmp, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return { ok: false, problem: "这个问题已经答过了（另一个回答先落地）" };
    return { ok: false, problem: `答案写入失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    rmSync(tmp, { force: true });
  }
  return { ok: true, answer: answer.answer, path };
}
