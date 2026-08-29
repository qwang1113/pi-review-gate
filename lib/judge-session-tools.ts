/**
 * The three tools that act on an EXISTING judge session — `judge_read`,
 * `judge_close` and `judge_wait`.
 *
 * They live here rather than in `extensions/review-gate.ts` for the reason
 * this repository now has a rule about (AGENTS.md §"架构规范"): that file is
 * ~9000 lines, and it got there one "just add the tool body here" at a time.
 * The orchestration tools moved out first (lib/orchestrator-*-tools.ts); this
 * module is the same move for the judge side, and the same shape:
 * `register<Family>Tools(host, deps)`, with every effect the tools need
 * arriving through an injected `deps` object.
 *
 * THE BOUNDARY: these three tools OBSERVE or END a session that already
 * exists. Dispatching a round (`judge_submit` and the review chain it runs)
 * is a different job — it owns the gate state, git and process spawning — and
 * stays in the extension for now.
 *
 * WHAT IS AND IS NOT INJECTED. The pure decision modules are imported
 * directly (lib/judge-lifecycle.ts for the end-of-round criteria and the
 * reply formatter, lib/poll-wait.ts for the loop, lib/review-stream.ts for
 * the findings stream): they are already testable on their own, and hiding
 * them behind deps would only make the wiring longer. What IS injected is
 * everything the tools cannot own — the filesystem, the repo resolution, and
 * the extension's in-memory registries — so every rule in this file can be
 * exercised with a fake instead of a spawned judge.
 *
 * BEHAVIOR IS FROZEN: this module was moved verbatim out of the extension.
 * Tool names, schemas, reply texts, `details` fields and error branches are
 * the ones the agent-facing contract already documents; changing any of them
 * is a separate, deliberate change.
 */

import { Type } from "typebox";

import type { ToolHost, ToolReply } from "./tool-host.ts";
import { judgeProcessAlive } from "./judge-process.ts";
import type { JudgeConclusion, JudgeSessionState } from "./judge-session.ts";
import {
  clampWaitTimeout,
  evaluateJudgeWait,
  formatJudgeWaitReply,
  tailLines,
  JUDGE_WAIT_MAX_TIMEOUT_MS,
  WAIT_STDOUT_TAIL_LINES,
  type JudgeWaitOutcome,
} from "./judge-lifecycle.ts";
import { createProgressReporter, type ToolUpdate } from "./progress-stream.ts";
import { pollUntil } from "./poll-wait.ts";
import { parseStream } from "./review-stream.ts";

/** Default number of stdout lines `judge_read` hands back. */
export const DEFAULT_STDOUT_HISTORY_LINES = 200;
/** How much of a log file the wait path reads before tailing it. */
export const LOG_TAIL_MAX_BYTES = 8000;

/**
 * The parts of a dispatched judge child these tools address.
 *
 * A structural subset of the extension's own record on purpose: this module
 * must not become the second place that decides what a judge child IS.
 */
export interface JudgeChildRecord {
  sessionId: string;
  role: string;
  title: string;
  /** Directory pi writes its transcript jsonl into (stable per role). */
  sessionDir: string;
  /** Per-run stdout log (this round's raw output). */
  stdoutPath: string;
  /** Per-run stderr log (crash diagnosis). */
  stderrPath: string;
  /** exit-code file — the authoritative 'session finished' fact. */
  exitCodePath: string;
  /**
   * pid record `<pid> <start>` — cross-session takeover. Never read here; it
   * is the input {@link JudgeSessionToolDeps.sessionState} needs, and leaving
   * it out would force the wiring to look the child up a second time.
   */
  pidPath: string;
  /** This round's findings stream, when the role has one. */
  streamPath?: string;
  /** The live child process; liveness is `exitCode === null`. */
  child?: { exitCode?: number | null; pid?: number; kill?: (signal?: string) => boolean };
}

/** Repo resolution, as `resolveToolRepoTarget` already reports it. */
export type JudgeRepoTarget = { ok: true; root: string } | { ok: false; error: string };

/**
 * Everything these tools need from the outside world.
 *
 * Deliberately narrow and side-effect-explicit: every method is a thing a
 * test replaces with three lines.
 */
export interface JudgeSessionToolDeps {
  /** Which repo does this call target? Never guessed — see repo-resolve.ts. */
  resolveRepo(requested: string | undefined): JudgeRepoTarget;
  /** Locate a judge child by ROLE (preferred) or by session id. */
  findChild(root: string, role: string | undefined, sessionId: string | undefined): JudgeChildRecord | undefined;
  /** Liveness/exit facts from the session's own artifacts (pid, exit-code). */
  sessionState(child: JudgeChildRecord): JudgeSessionState;
  /** The conclusion parsed from the RECORDED session dir. */
  conclusion(child: JudgeChildRecord): JudgeConclusion;
  /** Crash context that survives the process. */
  stderrTail(child: JudgeChildRecord): string | undefined;
  /** Whole file, or undefined when it is absent/unreadable. */
  readText(path: string): string | undefined;
  /** Existence only — an empty exit-code file still means "finished". */
  fileExists(path: string): boolean;
  /** Cancel the exit watcher (and the process record) for a session id. */
  cancelWatch(sessionId: string): void;
  /** Remove the child from the extension's registry. */
  dropChild(sessionId: string): void;
  /** Forget the goal draft a closed audit was judging. */
  dropPendingAudit(root: string): void;
  /** Cancel the gate-owned hosted-wait watchdog. */
  cancelWaitTimer(): void;
}

// ---------- shared parameter schemas ----------
// One definition per parameter, shared by the three tools: a role enum that
// drifts between two of them is exactly the kind of silent inconsistency this
// move is supposed to make impossible.

const ROLE_PARAM = Type.Optional(Type.Enum({ reviewer: "reviewer", adviser: "adviser", "goal-auditor": "goal-auditor" }));
const SESSION_ID_PARAM = Type.Optional(Type.String({ description: "Internal key; prefer role" }));
const REPO_PARAM = Type.Optional(Type.String({
  description: "Absolute repo path (required once the session edited several repos)",
}));

// ---------- reply builders ----------

function reply(text: string, details: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details };
}

function fail(text: string, details: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details, isError: true };
}

/**
 * The failure shapes.
 *
 * Each one carries EVERY field its tool's success path reports, with the
 * neutral value: an agent (or a test) reading `details.hasVerdict` must never
 * find the key simply missing because the call failed early.
 */
function readFailDetails(): Record<string, unknown> {
  return { found: false, alive: false, lifecycle: "unknown", exitCode: undefined, hasVerdict: false };
}

function closeFailDetails(): Record<string, unknown> {
  return { closed: false, terminated: false, sessionId: undefined };
}

function waitFailDetails(): Record<string, unknown> {
  return { done: false, reason: undefined, role: undefined, hasVerdict: false };
}

// ---------- shared addressing ----------

type Addressed =
  | { ok: true; root: string; role: string | undefined; sessionId: string | undefined }
  | { ok: false; text: string };

/**
 * Who is being addressed, and in which repo.
 *
 * Both refusals are identical across the three tools, and both are
 * fail-closed: an unaddressed call names the roles it accepts, and an
 * ambiguous repo is never guessed — reading, closing or waiting on the wrong
 * repo's judge is a silently wrong answer about somebody else's change.
 */
function addressJudge(
  deps: JudgeSessionToolDeps,
  params: Record<string, unknown>,
  toolName: string,
): Addressed {
  const role = params.role ? String(params.role) : undefined;
  const sessionId = params.sessionId ? String(params.sessionId) : undefined;
  if (!role && !sessionId) {
    return { ok: false, text: `review-gate: ${toolName} needs a role (reviewer / adviser / goal-auditor).` };
  }
  const target = deps.resolveRepo(typeof params.repo === "string" ? params.repo : undefined);
  if (!target.ok) return { ok: false, text: target.error };
  return { ok: true, root: target.root, role, sessionId };
}

// ---------- the wait criteria (this module's own) ----------

/**
 * Observe one judge round and apply the three end-of-round criteria.
 *
 * The fence criterion reads the round's STDOUT: there the verdict is plain
 * text, while inside the transcript jsonl it is JSON-escaped — which is why
 * the old hand-written `grep '"gate":"READY"'` never matched anything.
 */
export function probeJudgeRound(deps: JudgeSessionToolDeps, child: JudgeChildRecord): JudgeWaitOutcome {
  return evaluateJudgeWait({
    processAlive: judgeProcessAlive(child.child),
    exitCodeExists: deps.fileExists(child.exitCodePath),
    stdoutTail: readLogTail(deps, child.stdoutPath),
  });
}

/** Last bytes of a log file; an unreadable/absent log reads as empty. */
export function readLogTail(deps: JudgeSessionToolDeps, path: string, maxBytes = LOG_TAIL_MAX_BYTES): string {
  return (deps.readText(path) ?? "").slice(-maxBytes);
}

/**
 * The findings a judge has streamed so far, newest last, one line each.
 *
 * Evidence only: the stream never carries a verdict (parseStream rejects
 * verdict-shaped lines), so showing it while a round is still open cannot
 * leak a conclusion the gate has not recorded.
 */
export function recentStreamFindings(deps: JudgeSessionToolDeps, streamPath: string | undefined): string[] {
  if (!streamPath) return [];
  const raw = deps.readText(streamPath);
  if (raw === undefined) return [];
  try {
    return parseStream(raw).findings
      .map((f) => `[${f.severity}] ${f.location ? `${f.location} — ` : ""}${f.issue}`.slice(0, 300));
  } catch { return []; }
}

// ---------- judge_read ----------

async function doRead(deps: JudgeSessionToolDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const addressed = addressJudge(deps, params, "judge_read");
  if (!addressed.ok) return fail(addressed.text, readFailDetails());
  const history = typeof params.history === "number" ? params.history : DEFAULT_STDOUT_HISTORY_LINES;
  const child = deps.findChild(addressed.root, addressed.role, addressed.sessionId);
  if (!child) {
    return fail(
      `review-gate: no judge child on record for ${addressed.role ?? addressed.sessionId}.`,
      readFailDetails(),
    );
  }

  const running = judgeProcessAlive(child.child);
  const state = deps.sessionState(child);
  // Live output: tail of the stdout log (the process's stream is teed there
  // continuously). Simple last-N-lines read (tailLogFile is a streaming tail
  // for precommit, not a snapshot reader).
  let stdoutTail: string | undefined;
  const rawStdout = deps.readText(child.stdoutPath);
  if (rawStdout !== undefined) {
    const lines = rawStdout.split("\n");
    stdoutTail = lines.length <= history ? rawStdout : lines.slice(-history).join("\n");
  }
  // The process is gone but its records are not: only then are the transcript
  // and stderr the authoritative account of what happened.
  const conclusion = !running ? deps.conclusion(child) : undefined;
  const stderrTail = !running ? deps.stderrTail(child) : undefined;
  const header = `review-gate: judge session ${child.title} (${child.role}) — ${running ? "running" : state.lifecycle}` +
    (state.exitCode !== undefined ? ` (exit ${state.exitCode})` : "") +
    ` [session ${child.sessionId}]`;
  const body: string[] = [];
  if (stdoutTail) body.push(`--- stdout (tail ${history}) ---\n${stdoutTail}`);
  if (conclusion) {
    body.push(
      conclusion.text !== undefined
        ? `--- conclusion (${conclusion.hasVerdict ? "verdict fence" : "NO verdict fence — last message, may be a sign-off"}` +
          `, from ${conclusion.transcriptPath}) ---\n${conclusion.text}`
        : `--- no conclusion on disk (transcript ${conclusion.transcriptPath ?? "missing"}) — the child produced no assistant output ---`,
    );
  }
  if (stderrTail) body.push(`--- stderr (tail) ---\n${stderrTail}`);
  if (!stdoutTail && !conclusion) body.push("--- nothing to read yet (no stdout, no recorded session) ---");
  return reply([header, ...body].join("\n"), {
    found: true,
    alive: running,
    lifecycle: state?.lifecycle,
    exitCode: state?.exitCode,
    hasVerdict: conclusion?.hasVerdict ?? false,
  });
}

// ---------- judge_close ----------

async function doClose(deps: JudgeSessionToolDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const addressed = addressJudge(deps, params, "judge_close");
  if (!addressed.ok) return fail(addressed.text, closeFailDetails());
  const child = deps.findChild(addressed.root, addressed.role, addressed.sessionId);
  if (!child) {
    // Idempotent: nothing to close is a SUCCESS, so a task-completion sweep
    // never has to know whether a round is still on record.
    return reply(
      `review-gate: no judge child on record for ${addressed.role ?? addressed.sessionId} — nothing to close.`,
      { closed: true, terminated: false, sessionId: undefined },
    );
  }
  const sessionId = child.sessionId;
  // Cancel the exit watcher so no wake fires for a close we initiated.
  deps.cancelWatch(sessionId);
  const running = judgeProcessAlive(child.child);
  if (running) {
    try { child.child?.kill?.("SIGTERM"); } catch { /* already gone */ }
  }
  deps.dropChild(sessionId);
  // A closed audit takes its draft with it — same reason as fresh:true.
  if (child.role === "goal-auditor") deps.dropPendingAudit(addressed.root);
  deps.cancelWaitTimer();
  const how = running
    ? `${child.role} session terminated (SIGTERM)`
    : `${child.role} session had already exited`;
  return reply(
    `review-gate: ${how}; transcript and logs stay at ${child.sessionDir}.`,
    { closed: true, terminated: running, sessionId },
  );
}

// ---------- judge_wait ----------

async function doWait(
  deps: JudgeSessionToolDeps,
  params: Record<string, unknown>,
  signal: { readonly aborted: boolean } | undefined,
  onUpdate: unknown,
): Promise<ToolReply> {
  const addressed = addressJudge(deps, params, "judge_wait");
  if (!addressed.ok) return fail(addressed.text, waitFailDetails());
  const child = deps.findChild(addressed.root, addressed.role, addressed.sessionId);
  if (!child) {
    return fail(
      `review-gate: no judge child on record for ${addressed.role ?? addressed.sessionId} — submit a round first (judge_submit).`,
      waitFailDetails(),
    );
  }
  const budgetMs = clampWaitTimeout(typeof params.timeoutMs === "number" ? params.timeoutMs : undefined);
  // The blackest box in the loop: a review round is 8.9 minutes at the
  // median. Every probe tick republishes what the judge has written so far,
  // so waiting shows motion instead of a frozen call.
  const progress = createProgressReporter({
    title: `review-gate: 等待 ${child.role} 本轮结束`,
    onUpdate: onUpdate as ToolUpdate | undefined,
  });
  progress.step(`${child.role} 运行中`);
  // The LOOP is generic (lib/poll-wait.ts); only these three criteria are
  // this tool's own — that is the whole point of the split, so the next
  // waiter (different criteria, same skeleton) reuses it instead of copying a
  // subtly different timeout.
  const waited = await pollUntil({
    probe: () => probeJudgeRound(deps, child),
    isDone: (o) => o.done,
    budgetMs,
    signal,
    onProbe: () => {
      const findings = recentStreamFindings(deps, child.streamPath);
      progress.tail([
        tailLines(readLogTail(deps, child.stdoutPath), WAIT_STDOUT_TAIL_LINES),
        findings.length ? `findings: ${findings.length} 条，最新 ${findings[findings.length - 1]}` : "",
      ].filter(Boolean).join("\n"));
    },
  });
  // A budget that expires while the FIRST probe is still running leaves no
  // observation at all (lib/poll-wait.ts). That is not "finished", and it is
  // not an error either — it is "we could not measure anything in the time
  // you gave us", which the reply below states as such.
  const outcome: JudgeWaitOutcome = waited.observation ?? { done: false, reason: "pending" };

  progress.done(outcome.done ? outcome.reason : "未结束");
  const conclusion = outcome.done ? deps.conclusion(child) : undefined;

  // The RETURN is the agent's channel (user decision 6.2): a finished round
  // hands back the conclusion plus this round's stdout tail; an unfinished
  // one hands back the progress so far — the same tail plus the newest
  // streamed findings — instead of a bare "not done yet".
  const text = formatJudgeWaitReply({
    role: child.role,
    done: outcome.done,
    reason: outcome.reason,
    waitedMs: waited.waitedMs,
    stdoutTail: readLogTail(deps, child.stdoutPath),
    conclusion: conclusion ? { text: conclusion.text, hasVerdict: conclusion.hasVerdict } : undefined,
    findings: recentStreamFindings(deps, child.streamPath),
  });
  return reply(text, {
    done: outcome.done,
    reason: outcome.reason,
    role: child.role,
    hasVerdict: conclusion?.hasVerdict ?? false,
  });
}

// ---------- registration ----------

/** Register `judge_read`, `judge_close` and `judge_wait`. */
export function registerJudgeSessionTools(host: ToolHost, deps: JudgeSessionToolDeps): void {
  host.registerTool({
    name: "judge_read",
    label: "Read Judge Child",
    description:
      "Read a judge child by ROLE (a snapshot, never a wait): its session state (running / " +
      "finished + exit code), the tail of its stdout log, its conclusion parsed from the " +
      "transcript (the last assistant text carrying a verdict fence), and the tail of its stderr. " +
      "The process may already be gone — the transcript and logs are not.",
    parameters: Type.Object({
      role: ROLE_PARAM,
      sessionId: SESSION_ID_PARAM,
      repo: REPO_PARAM,
      history: Type.Optional(Type.Integer({
        description: `Tail lines of the stdout log (default ${DEFAULT_STDOUT_HISTORY_LINES})`,
      })),
    }),
    execute: (_id, params) => doRead(deps, params),
  });

  host.registerTool({
    name: "judge_close",
    label: "Close Judge Child",
    description:
      "Terminate a judge role's pi PROCESS (SIGTERM; its transcript stays on disk, so the same role " +
      "can be resumed later) and drop it from the registry. Use it at task completion (before " +
      "declare_done) or to stop a round that has gone off the rails. NOT a memory wipe: the next " +
      "dispatch of this role resumes the same conversation. Idempotent: an already-finished child " +
      "still closes successfully.",
    parameters: Type.Object({
      role: ROLE_PARAM,
      sessionId: SESSION_ID_PARAM,
      repo: REPO_PARAM,
    }),
    execute: (_id, params) => doClose(deps, params),
  });

  host.registerTool({
    name: "judge_wait",
    label: "Wait For Judge",
    description:
      "Block until a judge role's current round is over, then return what it produced. This is the " +
      "FALLBACK, not the normal path: judge_submit already wakes this session on completion, so " +
      "call this only when there is genuinely nothing else to do. Three independent criteria end " +
      "the wait — the process exited, its exit-code file landed, or a verdict/question fence is " +
      "already in its stdout. On timeout it returns the current state instead of failing, so the " +
      "decision stays yours.",
    parameters: Type.Object({
      role: ROLE_PARAM,
      sessionId: SESSION_ID_PARAM,
      repo: REPO_PARAM,
      timeoutMs: Type.Optional(Type.Integer({
        description: `Blocking window in ms (default 300000, hard cap ${JUDGE_WAIT_MAX_TIMEOUT_MS})`,
      })),
    }),
    execute: (_id, params, signal, onUpdate) => doWait(deps, params, signal, onUpdate),
  });
}
