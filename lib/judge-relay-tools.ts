/**
 * The three tools that RELAY something to a judge process — `review_spawn`
 * (dispatch a round under an explicit display title), `review_send` (resume a
 * role's session with a follow-up) and `review_watch` (re-register the
 * completion watcher for a live child).
 *
 * They live here rather than in `extensions/review-gate.ts` for the reason
 * this repository now has a rule about (AGENTS.md §"架构规范"): that file is
 * ~9000 lines, and it got there one "just add the tool body here" at a time.
 * The orchestration tools moved out first (lib/orchestrator-*-tools.ts), the
 * judge tools that OBSERVE or END a session followed
 * (lib/judge-session-tools.ts); this module is the other half of that judge
 * family, and the same shape: `register<Family>Tools(host, deps)`, with every
 * effect the tools need arriving through an injected `deps` object.
 *
 * THE BOUNDARY: these three tools hand a round, a message or a listener TO a
 * judge session. They do not decide identity, reuse or liveness — that is the
 * dispatch owner's job (`dispatchJudgeRound`, still in the extension, reached
 * here as {@link JudgeRelayToolDeps.dispatchRound}) and the watch registry's
 * (lib/judge-watch.ts, reached as {@link JudgeRelayToolDeps.registerWatch}).
 * Observing or ending a session is lib/judge-session-tools.ts.
 *
 * WHAT IS AND IS NOT INJECTED. The pure modules are imported directly
 * (lib/judge-prompt.ts for the role list, lib/judge-process.ts for the
 * liveness rule): they are already testable on their own, and hiding them
 * behind deps would only make the wiring longer. What IS injected is
 * everything the tools cannot own — the repo resolution, the process
 * dispatch, the extension's in-memory child registry and the watch
 * registration — so every rule in this file can be exercised with a fake
 * instead of a spawned judge.
 *
 * BEHAVIOR IS FROZEN: this module was moved verbatim out of the extension.
 * Tool names, schemas, reply texts, `details` fields and error branches are
 * the ones the agent-facing contract already documents; changing any of them
 * is a separate, deliberate change.
 */

import { Type } from "typebox";

import type { ToolHost, ToolReply } from "./tool-host.ts";
import type { ToolRepoTarget } from "./repo-resolve.ts";
import { judgeProcessAlive } from "./judge-process.ts";
import { JUDGE_ROLES } from "./judge-prompt.ts";

/**
 * The parts of a dispatched judge child these tools address.
 *
 * A structural subset of the extension's own record on purpose: this module
 * must not become the second place that decides what a judge child IS.
 */
export interface JudgeRelayChild {
  sessionId: string;
  role: string;
  /** Display label — `review_send` reuses it so a resume keeps its name. */
  title: string;
  /** Directory pi writes its transcript jsonl into (stable per role). */
  sessionDir: string;
  /** Per-run stdout log (this round's raw output). */
  stdoutPath: string;
  /** This round's findings stream, when the role has one. */
  streamPath?: string;
  /** The live child process; liveness is `exitCode === null`. */
  child?: { exitCode?: number | null; pid?: number };
}

/** What one dispatch of a judge round produced (or why it could not). */
export interface JudgeRelayDispatch {
  ok: boolean;
  /** The role's session already had a transcript — this round continues it. */
  reused: boolean;
  busy?: boolean;
  sessionId?: string;
  sessionDir?: string;
  runDir?: string;
  stdoutPath?: string;
  error?: string;
}

/** One round handed to the dispatch owner. */
export interface JudgeRelayDispatchRequest {
  root: string;
  role: string;
  title: string;
  task: string;
  fresh?: boolean;
  /** This round's findings stream, recorded on the child for judge_wait. */
  streamPath?: string;
}

/**
 * Everything these tools need from the outside world.
 *
 * Deliberately narrow and side-effect-explicit: every method is a thing a
 * test replaces with three lines.
 */
export interface JudgeRelayToolDeps {
  /** Which repo does this call target? Never guessed — see repo-resolve.ts. */
  resolveRepo(requested: string | undefined): ToolRepoTarget;
  /** The single owner of judge identity, reuse and spawning. */
  dispatchRound(request: JudgeRelayDispatchRequest): JudgeRelayDispatch;
  /** The judge child of one role in one repo, if the registry still holds it. */
  childByRole(root: string, role: string): JudgeRelayChild | undefined;
  /** Locate a judge child by ROLE (preferred) or by session id. */
  findChild(root: string, role: string | undefined, sessionId: string | undefined): JudgeRelayChild | undefined;
  /**
   * A child by session id ACROSS repos — `review_watch` is addressed by the
   * internal key alone, so it cannot ask a repo first.
   */
  childBySessionId(sessionId: string): JudgeRelayChild | undefined;
  /** Register the completion watcher (one handle per session id). */
  registerWatch(sessionId: string, label: string): void;
}

// ---------- shared parameter schemas ----------
// One definition per parameter, shared by the tools that take it: a role enum
// that drifts between two of them is exactly the kind of silent inconsistency
// this move is supposed to make impossible.

const JUDGE_ROLE_ENUM = Type.Enum({ reviewer: "reviewer", adviser: "adviser", "goal-auditor": "goal-auditor" });
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
 * neutral value: an agent (or a test) reading `details.sent` must never find
 * the key simply missing because the call failed early.
 */
function sendFailDetails(sessionId?: string): Record<string, unknown> {
  return { sent: false, sessionId };
}

// ---------- review_spawn ----------

async function doSpawn(deps: JudgeRelayToolDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const target = deps.resolveRepo(typeof params.repo === "string" ? params.repo : undefined);
  if (!target.ok) {
    return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
  }
  const root = target.root;
  const role = String(params.role ?? "");
  if (!JUDGE_ROLES.includes(role as (typeof JUDGE_ROLES)[number])) {
    return fail(
      `review-gate: review_spawn rejected — unknown role "${role}".`,
      { spawned: false },
    );
  }
  const task = String(params.task ?? "").trim();
  if (!task) {
    return fail(
      "review-gate: review_spawn rejected — the task text is empty. Write the task first, then pass it.",
      { spawned: false },
    );
  }
  const dispatch = deps.dispatchRound({
    root,
    role,
    title: String(params.title ?? role),
    task,
    fresh: params.fresh === true,
  });
  if (!dispatch.ok) {
    return fail(
      `review-gate: review_spawn failed — ${dispatch.error ?? "no child"}`,
      { spawned: false },
    );
  }
  const child = deps.childByRole(root, role);
  const sessionDir = dispatch.sessionDir ?? child?.sessionDir;
  const stdoutPath = dispatch.stdoutPath ?? child?.stdoutPath;
  // A REUSED session says so and stops there: its session dir and stdout were
  // already reported when it was spawned, and repeating them would read as a
  // new child.
  const text = dispatch.reused
    ? `review-gate: reusing existing ${role} child session ${dispatch.sessionId} — context carries over across rounds.\n` +
      `- 本轮任务已提交；进程退出即完成，监听已重新注册。`
    : `review-gate: ${role} child spawned as session ${dispatch.sessionId} (${child?.title ?? role}).\n` +
      `- session dir: ${sessionDir} (transcript jsonl; resume = same session id)\n` +
      `- stdout: ${stdoutPath}\n` +
      `- 任务文本已随 spawn 传入(@file)；进程退出即完成，监听已自动注册，唤醒会作为新 turn 到达。`;
  return reply(text, {
    spawned: !dispatch.reused,
    reused: dispatch.reused,
    sessionId: dispatch.sessionId,
    role,
    title: child?.title,
    sessionDir,
    stdoutPath,
    watching: true,
  });
}

// ---------- review_watch ----------

async function doWatch(deps: JudgeRelayToolDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const sessionId = String(params.sessionId ?? "").trim();
  const label = String(params.label ?? "").trim() || sessionId;
  if (!sessionId) {
    return fail(
      "review-gate: review_watch rejected — the session id is empty.",
      { watching: false },
    );
  }
  // A watcher listens on a PROCESS exit: registering one for a child that has
  // already ended would wait for an event that can never arrive again.
  const child = deps.childBySessionId(sessionId);
  if (!child || !judgeProcessAlive(child.child)) {
    return fail(
      `review-gate: no LIVE judge child with session id ${sessionId} — nothing to watch.`,
      { watching: false },
    );
  }
  // One watcher per session id; a re-watch replaces the old handle.
  deps.registerWatch(sessionId, label);
  return reply(
    `review-gate: watching ${sessionId} — 进程退出时会主动唤醒本会话（无需轮询）。`,
    { watching: true, sessionId },
  );
}

// ---------- review_send ----------

async function doSend(deps: JudgeRelayToolDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const role = params.role ? String(params.role) : undefined;
  const wantedId = params.sessionId ? String(params.sessionId) : undefined;
  const text = String(params.text ?? "");
  if (!role && !wantedId) {
    return fail("review-gate: review_send needs a role (reviewer / adviser / goal-auditor).", sendFailDetails());
  }
  if (!text.trim()) {
    return fail("review-gate: review_send rejected — the message is empty.", sendFailDetails());
  }
  const target = deps.resolveRepo(typeof params.repo === "string" ? params.repo : undefined);
  if (!target.ok) return fail(target.error, sendFailDetails());
  const root = target.root;
  const child = deps.findChild(root, role, wantedId);
  if (!child) {
    return fail(`review-gate: no judge child on record for ${role ?? wantedId}.`, sendFailDetails());
  }
  // A resume IS a dispatch under the same session id — so it goes through
  // the same owner, which allocates a FRESH run dir. Reusing the previous
  // round's exit-code/stdout files would make judge_wait report "done"
  // instantly and hand back the PREVIOUS round's verdict.
  const dispatch = deps.dispatchRound({ root, role: child.role, title: child.title, task: text, streamPath: child.streamPath });
  if (!dispatch.ok) {
    return fail(
      `review-gate: review_send did not deliver — ${dispatch.error ?? "the judge process could not start"}`,
      sendFailDetails(dispatch.sessionId),
    );
  }
  return reply(
    `review-gate: ${child.role} 已收到本轮消息（同一 session 续接，上下文保留）。`,
    { sent: true, sessionId: dispatch.sessionId },
  );
}

// ---------- registration ----------

/** Register `review_spawn`, `review_watch` and `review_send`. */
export function registerJudgeRelayTools(host: ToolHost, deps: JudgeRelayToolDeps): void {
  host.registerTool({
    name: "review_spawn",
    label: "Spawn Judge Child",
    description:
      "ADVANCED / internal entry: dispatch a judge round with an explicit display title. " +
      "judge_submit is the normal path and derives the title itself — use this only when a " +
      "diagnostics label matters. Same mechanics: role+repo decide the session id and its " +
      "directory, an alive same-role session is reused, the exit listener is registered for you.",
    parameters: Type.Object({
      role: JUDGE_ROLE_ENUM,
      title: Type.String({
        description: "Human-readable child label (sanitized; display and diagnostics only)",
      }),
      repo: REPO_PARAM,
      task: Type.String({
        description: "The task text for THIS round (written to a file and passed as an @file argv reference)",
      }),
      fresh: Type.Optional(Type.Boolean({
        description: "Force a NEW session even when an alive same-role child exists (default: reuse)",
      })),
    }),
    execute: (_id, params) => doSpawn(deps, params),
  });

  // ---------- review_watch tool (the wake-up mechanism) ----------

  host.registerTool({
    name: "review_watch",
    label: "Watch Review Child",
    description:
      "ADVANCED / internal: every dispatched round registers its completion watcher itself " +
      "(judge_submit), so you never call this in the normal flow — only to re-register with a " +
      "custom label after a reload, or for a process resumed outside the gate. When the child " +
      "exits, the watcher wakes THIS session via pi.sendMessage(triggerTurn) — a new turn, no " +
      "polling, no sleep. Watchers are cancelled on session shutdown.",
    parameters: Type.Object({
      sessionId: Type.String({
        description: "The judge session id to watch (internal key; roles are addressed by name everywhere else)",
      }),
      label: Type.Optional(Type.String({
        description: "Human-readable child label for the wake message (default: the session id)",
      })),
    }),
    execute: (_id, params) => doWatch(deps, params),
  });

  host.registerTool({
    name: "review_send",
    label: "Send to Judge Session",
    description:
      "ADVANCED / internal entry: send a follow-up (typically the answer to a judge's question) to " +
      "a role's session. It is the same operation as judge_submit — a resume under the same session " +
      "id, so the judge wakes with its full context — and judge_submit is the normal path. " +
      "Requires the role's process to have EXITED: a non-interactive judge reads its task once, at " +
      "spawn, and cannot be interrupted mid-turn.",
    parameters: Type.Object({
      role: Type.Optional(JUDGE_ROLE_ENUM),
      sessionId: Type.Optional(Type.String({ description: "Internal key; prefer role" })),
      text: Type.String({ description: "The follow-up message (any length; written to a file)" }),
      repo: REPO_PARAM,
    }),
    execute: (_id, params) => doSend(deps, params),
  });
}
