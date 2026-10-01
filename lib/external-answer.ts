/**
 * THE THIRD ANSWER SOURCE — the gate's half of the daemon's pending-question
 * protocol (docs/daemon/api.md §7, the frozen contract; daemon-core implements
 * the other half in lib/daemon/questions.ts).
 *
 * ── WHAT IT IS ──
 *
 * Every dialog the gate raises reaches the user through ONE funnel
 * (`askDialog` in lib/gate-dialogs.ts), and that funnel has always raced two
 * answer sources: the human in the pane, and — when nobody is there —
 * the arbiter stand-in (lib/user-proxy.ts). This module is the third: the
 * question is written to a file before it is shown, the daemon lists it over
 * HTTP and the web panel writes an answer to a second file. Whoever answers
 * first wins; the others are torn down without an error.
 *
 * ── WHY A FILE AND NOT AN IPC ──
 *
 * The two processes are independent: the daemon is resident, the gate session
 * comes and goes, and no session has to be running for the panel to exist. A
 * directory keyed by session id makes `(sessionId, requestId)` the identity of
 * ONE ask — so a session that dies takes its unanswered questions out of the
 * picture with it, and a restarted daemon needs no handshake to list what is
 * still pending.
 *
 * ── FAIL-CLOSED, ALWAYS ──
 *
 * Nothing on this path can widen anything. An unreadable file, a JSON body
 * that is not an answer, an answer that is not one of the rows the dialog
 * offered, a mismatched (sessionId, requestId) pair — every one of them is
 * REFUSED and the dialog goes on waiting exactly as it did before this module
 * existed. The handle's promise then simply never settles, so the proxy race
 * and the human's own box are untouched. The one thing this module must never
 * do is turn "a file appeared" into a decision.
 *
 * The acceptance rule is not a second implementation: `resolveAnswer`
 * (lib/orchestrator-answer-rules.ts) is the SAME reader the daemon and the
 * project manager's channel answers already obey, so a letter, a row quoted
 * verbatim, several rows on a checkbox question and the `✎ 不选` decline row
 * all mean here exactly what they mean there.
 *
 * ── WHAT IS ON THE WIRE ──
 *
 * `options` carries the rows the dialog actually shows — the plain option
 * texts PLUS the template's decline row (`✎ 不选，我说明原因` / `✎ 我要改…`),
 * because on screen that row is one of the answers and a panel that cannot
 * offer it would be able to approve but not to refuse. `payload` carries the
 * body WHOLE and is never spilled to the `payloadRef` side file the format
 * also allows: the only reader is a browser talking HTTP, and a path it cannot
 * open is a body it cannot read.
 *
 * `sessionName` stays null and `topic` defaults to `other`: both are display
 * fields the frozen format marks optional, and the panel joins the session
 * list (which already carries names) for the first one.
 *
 * ponytail: the question file is written even when the daemon has never run —
 * a few bytes under its own directory, deleted when the dialog settles. The
 * ceiling is a session that dies mid-question: its file stays until somebody
 * answers it or the directory is removed. Tighten it in the daemon's listing
 * (which knows session liveness) rather than by adding a second liveness rule
 * here.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { daemonUserHome } from "./daemon/paths.ts";

import { writeFileAtomic } from "./atomic-write.ts";
import { declineRowOf, type ChoiceSpec } from "./choice-dialog.ts";
import { parseAnswer, QUESTION_SCHEMA, type DaemonQuestion } from "./daemon/questions.ts";
import { questionAnswerPath, questionPath, sessionIdProblem, sessionQuestionsDir } from "./daemon/paths.ts";
import { resolveAnswer } from "./orchestrator-answer-rules.ts";

/** How often a waiting dialog looks for an answer file. */
export const EXTERNAL_ANSWER_POLL_MS = 300;

/** A repeating timer, injected so a test drives the watch by hand. */
export type PollScheduler = (fn: () => void, ms: number) => { cancel: () => void };

/** One dialog, as the outside world has to see it to be able to answer it. */
export interface ExternalQuestionInput {
  /** The dialog's own spec — title, options, recommendation, shape. */
  spec: ChoiceSpec;
  /**
   * Is this the CHECKBOX shape? Passed in rather than re-derived: `askDialog`
   * already knows which renderer it is about to use, and the shape test lives
   * in lib/multi-choice-dialog.ts (`defaultChecked`), not in a second copy.
   */
  multiple: boolean;
  /** The long half of the question (the body the human would read). */
  body?: string;
  /** The channel's topic word, when the caller knows it (docs/daemon/api.md §7.2). */
  topic?: string;
  /** This question is one of an interview batch — the stamp the panel groups by. */
  batch?: { id: string; index: number; total: number };
}

/** What one open question hands the dialog that is waiting on it. */
export interface ExternalAnswerHandle {
  /**
   * The accepted answer — and a promise that NEVER SETTLES while nobody has
   * answered. That is the fail-closed half: `askDialog` races this against the
   * human's box and the proxy, and a promise resolving `undefined` here would
   * end a dialog nobody answered.
   */
  answer: Promise<string | undefined>;
  /** Did the answer that settled come from the outside? (Then it was a user.) */
  answered(): boolean;
  /** Stop waiting and remove what this ask wrote. Idempotent. */
  close(): void;
}

export interface ExternalAnswerChannel {
  /** Publish one question and start watching for its answer. */
  open(question: ExternalQuestionInput): ExternalAnswerHandle;
}

export interface ExternalAnswerDeps {
  /** The agent home; the protocol lives under `<home>/.pi/agent/rg-daemon/questions`. */
  home?: string;
  /**
   * This session's identity, read per question. `undefined` (a headless
   * harness, a host that cannot say) means the protocol is NOT offered — the
   * dialog then behaves exactly as it did before this module existed.
   */
  identity(): { sessionId: string } | undefined;
  now?: () => number;
  pollMs?: number;
  schedule?: PollScheduler;
  /** Why an answer was refused / the channel is unavailable. Best-effort. */
  log?(message: string): void;
}

/**
 * A collision-resistant request id.
 *
 * IT MUST BE COLLISION-RESISTANT, not a counter (quality: the id names a file
 * a RESUMED session can find again). A counter would let a stale question from
 * a previous run of the same session id sit at the path a fresh question is
 * about to use, and the gate would read the old answer as the new one's.
 */
export function newExternalRequestId(nowMs: number): string {
  return `q-${Math.floor(nowMs).toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** The question document — the frozen shape, built in one place. */
export function buildExternalQuestion(
  sessionId: string,
  requestId: string,
  input: ExternalQuestionInput,
  at: string,
): DaemonQuestion {
  return {
    schema: QUESTION_SCHEMA,
    requestId,
    sessionId,
    sessionName: null,
    topic: input.topic ?? "other",
    title: input.spec.title,
    // The decline row rides in `options` WITH the plain rows: on screen it is
    // one of the answers (lib/choice-dialog.ts's template owns it), and the
    // format's own reader (`resolveAnswer`) already knows how to read it back.
    options: [...input.spec.options, declineRowOf(input.spec)],
    multiple: input.multiple,
    recommended: input.spec.recommended ?? null,
    defaultChecked: input.multiple ? [...(input.spec.defaultChecked ?? [])] : [],
    payload: input.body ?? null,
    payloadRef: null,
    batchId: input.batch?.id ?? null,
    batchIndex: input.batch?.index ?? null,
    batchTotal: input.batch?.total ?? null,
    createdAt: at,
    expiresAt: null,
  };
}

/** What one look at the answer file produced. */
export type AnswerLook =
  | { kind: "pending" }
  | { kind: "answer"; answer: string }
  | { kind: "refused"; problem: string };

/**
 * Read the answer file and decide whether it settles this ask.
 *
 * Deliberately split out and exported: every refusal branch (a body that is
 * not JSON, ids that do not match, an answer outside the offered rows) is the
 * security surface of this channel, and it is pinned by tests rather than by
 * reading the code.
 */
export function lookAtAnswerFile(
  path: string,
  expected: { sessionId: string; requestId: string; options: readonly string[]; multiple: boolean },
): AnswerLook {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Absent is the ordinary case while the panel is still thinking. An
    // unreadable file is treated the same way on purpose: it never becomes an
    // answer, and a later successful read still can.
    return { kind: "pending" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "refused", problem: "答案文件不是合法 JSON" };
  }
  const answer = parseAnswer(parsed);
  if (!answer.ok) return { kind: "refused", problem: `答案文件读不出来：${answer.problem}` };
  if (answer.value.sessionId !== expected.sessionId || answer.value.requestId !== expected.requestId) {
    return { kind: "refused", problem: "答案里的 (sessionId, requestId) 与这次询问对不上" };
  }
  const resolved = resolveAnswer(
    { options: [...expected.options], ...(expected.multiple ? { multiple: true } : {}) },
    answer.value.answer,
  );
  if (!resolved.ok) return { kind: "refused", problem: `外部答案不在选项里：${resolved.reason}` };
  return { kind: "answer", answer: resolved.answer };
}

export function createExternalAnswers(deps: ExternalAnswerDeps): ExternalAnswerChannel {
  // THE DAEMON'S OWN HOME RESOLUTION (quality round P2, 2026-10-01): the
  // daemon reads this directory as `daemonUserHome()` (rg/RG_DAEMON_HOME), so
  // bare `homedir()` here would write every question into `$HOME` while the
  // panel looked under the override — unanswered and silent. One rule, both
  // sides: `lib/daemon/paths.ts`.
  const home = deps.home ?? daemonUserHome();
  const now = deps.now ?? (() => Date.now());
  const pollMs = deps.pollMs ?? EXTERNAL_ANSWER_POLL_MS;
  const schedule: PollScheduler = deps.schedule ?? ((fn, ms) => {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  });

  /** A channel that is not available is not an error — it is the old behavior. */
  function unavailable(): ExternalAnswerHandle {
    return { answer: new Promise<string | undefined>(() => {}), answered: () => false, close: () => {} };
  }

  function open(input: ExternalQuestionInput): ExternalAnswerHandle {
    try {
      const sessionId = deps.identity()?.sessionId ?? "";
      const idProblem = sessionIdProblem(sessionId);
      if (idProblem !== undefined) return unavailable();
      const atMs = now();
      const requestId = newExternalRequestId(atMs);
      const question = buildExternalQuestion(sessionId, requestId, input, new Date(atMs).toISOString());
      const dir = sessionQuestionsDir(home, sessionId);
      const questionFile = questionPath(home, sessionId, requestId);
      const answerFile = questionAnswerPath(home, sessionId, requestId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileAtomic(questionFile, `${JSON.stringify(question, null, 2)}\n`);
      try {
        // A question can carry a plan or a goal draft; the file is the user's
        // own text and nobody else's to read. Best effort: the mode is already
        // restrictive on a fresh file, and the directory above is 0700.
        chmodSync(questionFile, 0o600);
      } catch { /* best effort */ }
      return watch({
        sessionId,
        requestId,
        options: question.options,
        multiple: question.multiple,
        dir,
        questionFile,
        answerFile,
      });
    } catch (error) {
      // A daemon that never ran, a read-only home, a host with no session id:
      // the dialog keeps working exactly as it did before this channel existed.
      deps.log?.(`外部答案通道不可用（这次对话框照旧只等人 / arbiter）：${String(error).slice(0, 200)}`);
      return unavailable();
    }
  }

  /**
   * Wait for the answer file, and hand the dialog the first one that is real.
   *
   * `close()` is the OTHER half of the race: whoever settled the dialog —
   * the human, the arbiter, an ESC — calls it, and the question leaves the
   * panel's list at the same moment the box leaves the screen. A question the
   * panel can still answer after it was settled elsewhere is a question whose
   * answer nobody would ever read.
   */
  function watch(ask: {
    sessionId: string;
    requestId: string;
    options: string[];
    multiple: boolean;
    dir: string;
    questionFile: string;
    answerFile: string;
  }): ExternalAnswerHandle {
    let timer: { cancel: () => void } | undefined;
    let done = false;
    let settledExternally = false;
    let resolveAnswer!: (value: string | undefined) => void;
    const answer = new Promise<string | undefined>((resolve) => { resolveAnswer = resolve; });

    const close = (): void => {
      if (done) return;
      done = true;
      timer?.cancel();
      timer = undefined;
      rmSync(ask.questionFile, { force: true });
      rmSync(ask.answerFile, { force: true });
      // The session's own directory, once it holds nothing else. Best effort:
      // a pending sibling question (or the daemon's own files) keeps it.
      try { rmdirSync(ask.dir); } catch { /* not empty, or not ours */ }
    };

    const accept = (value: string): void => {
      settledExternally = true;
      close();
      resolveAnswer(value);
    };

    const tick = (): void => {
      timer = undefined;
      if (done) return;
      const looked = lookAtAnswerFile(ask.answerFile, ask);
      if (looked.kind === "answer") {
        accept(looked.answer);
        return;
      }
      if (looked.kind === "refused") {
        // CONSUME WHAT CANNOT BE ACCEPTED. Leaving the file would keep the
        // panel saying "already answered" for a question that is still open,
        // and the polling would re-read the same bytes forever. Removing it
        // refuses the answer AND leaves the door open for a real one — the
        // dialog is still waiting either way.
        deps.log?.(`外部答案被拒（这次询问继续等）：${looked.problem}`);
        rmSync(ask.answerFile, { force: true });
      }
      if (done) return;
      timer = schedule(tick, pollMs);
    };

    timer = schedule(tick, pollMs);
    return { answer, answered: () => settledExternally, close };
  }

  return { open };
}
