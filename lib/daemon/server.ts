/**
 * THE DAEMON'S HTTP SURFACE — routing, bearer auth, SSE, and the static panel.
 *
 * ── WHAT IT IS ──
 *
 * One `http.Server` bound to 127.0.0.1 (never 0.0.0.0: this process can start
 * sessions and rewrite the user's configuration, and the only thing that makes
 * that safe is that nothing off the machine can reach it). Every `/api/*` call
 * carries the token; the token is compared in constant time and never logged.
 *
 * The endpoints are thin: each one calls the module that owns a concern
 * (sessions, events, questions, config, control) and turns its answer into
 * JSON. This file owns exactly three things — the route table, the
 * request/response plumbing, and static serving — and no policy.
 *
 * ── WHY SSE GOES THROUGH THE HUB AND NOT A FILE WATCHER ──
 *
 * Subscribers register with the hub (lib/daemon/events.ts) and one watcher
 * polls. A subscription says what it wants (one session, or all of them), gets
 * the last N entries replayed, and then receives whatever the watcher pushes.
 * `ping` frames keep a proxy or a sleeping laptop from silently dropping the
 * connection. The token travels in `?token=` here because `EventSource` cannot
 * set a header — the one place the query form exists, and only on loopback.
 *
 * ── STATIC: A PANEL, NOT AN API ──
 *
 * Everything outside `/api/` is served from `web/dist` (the web workspace's
 * build output). An unknown path falls back to `index.html`, so a single-page
 * app's own routes survive a reload. When the build output is missing, the
 * daemon answers with a page that SAYS SO and how to build it — never a 500,
 * because "the panel was not built yet" is a normal state of a source checkout.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { createSessionObserver, SESSION_LIST_LIMIT, type DaemonSession, type SessionObserver } from "./sessions.ts";
import { createNotificationStore, createSessionWatcher, createSseHub, type DaemonEvent } from "./events.ts";
import { createScheduler, dueDecision, LAST_RUNS_SHOWN } from "./scheduler.ts";
import { listPendingQuestions, submitAnswer } from "./questions.ts";
import { readConfig, writeConfig, type ConfigTargetName } from "./config.ts";
import { createDaemonTmuxRunner, launchTask, listCandidateRepos, sendSessionMessage } from "./control.ts";
import {
  applyScheduleEdit,
  findScheduledTask,
  readScheduleRuns,
  readSchedules,
  removeScheduledTask,
  scheduleNameProblem,
  scheduleRepoProblem,
  updateScheduledTask,
  type ScheduleEditPatch,
  type ScheduledTask,
} from "../schedule-store.ts";
import { describeCron, parseCron } from "../cron-schedule.ts";
import { readRecentEntries, readRecentEntriesWithOffset } from "./transcript.ts";
import { tokenMatches } from "./state.ts";
import { DAEMON_SCHEMA, daemonPackageVersion, notificationStorePath } from "./paths.ts";
import { DEFAULT_WEB_DIR, servePanel, type StaticReply } from "./static.ts";
import type { TmuxRunner } from "../orchestrator-tmux.ts";

/** Bodies are configuration and messages: small, and never a file upload. */
export const MAX_BODY_BYTES = 512 * 1024;

/** `GET /api/schedules/:id/runs` — the ledger window the panel asks for by default. */
export const DEFAULT_RUNS_LIMIT = 50;
export const MAX_RUNS_LIMIT = 500;

/** A patch a panel may send to `PUT /api/schedules/:id`. */
const PANEL_SCHEDULE_FIELDS: readonly string[] = Object.freeze(["cron", "enabled", "name"]);

/** How many output entries a fresh subscription replays unless it asks otherwise. */
export const DEFAULT_REPLAY = 30;
export const MAX_REPLAY = 500;
/** SSE keep-alive: a comment frame on this cadence keeps the socket honest. */
export const SSE_PING_MS = 15_000;

export interface RuntimeOptions {
  home: string;
  port: number;
  token: string;
  /** Roots whose immediate git subdirectories are offered as task targets. */
  workspaceRoots?: readonly string[];
  /** Static files to serve; defaults to `<package>/web/dist`. */
  webDir?: string;
  /** Injected for tests, so an HTTP test never touches the real tmux. */
  runTmux?: TmuxRunner;
  now?: () => number;
  /** How often the scheduler looks for due tasks; injected so a test controls the clock. */
  schedulerIntervalMs?: number;
  log?: (message: string) => void;
}

export interface Runtime {
  server: Server;
  /** The bound port (equal to the requested one unless it was 0). */
  port(): number;
  start(): Promise<number>;
  stop(): Promise<void>;
}

interface Ctx {
  method: string;
  pathname: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: unknown;
}

interface Reply extends StaticReply {
  json?: unknown;
  headers?: Record<string, string>;
}

const ok = (json: unknown): Reply => ({ status: 200, json });
const bad = (status: number, error: string, extra: Record<string, unknown> = {}): Reply => ({
  status,
  json: { error, ...extra },
});

/** One route: a method, a path pattern (`:name` captures a segment), and a handler. */
interface Route {
  method: string;
  pattern: string[];
  handler: (ctx: Ctx) => Promise<Reply> | Reply;
}

function match(pattern: string[], pathname: string): Record<string, string> | undefined {
  const parts = pathname.split("/").filter((part) => part !== "");
  if (parts.length !== pattern.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]!;
    let actual: string;
    try {
      actual = decodeURIComponent(parts[index]!);
    } catch {
      // A segment that is not valid percent-encoding (`%`, `%zz`) is a segment
      // that matches nothing: the router must answer 404, never throw a
      // URIError out of the request handler where it reads as a 500.
      return undefined;
    }
    if (expected.startsWith(":")) params[expected.slice(1)] = actual;
    else if (expected !== actual) return undefined;
  }
  return params;
}

const segments = (path: string): string[] => path.split("/").filter((part) => part !== "");

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

export function createRuntime(opts: RuntimeOptions): Runtime {
  const log = opts.log ?? ((): void => { /* silent by default */ });
  const now = opts.now ?? ((): number => Date.now());
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const workspaceRoots = opts.workspaceRoots ?? [];
  const runTmux = opts.runTmux ?? createDaemonTmuxRunner();
  const observer = createSessionObserver({ home: opts.home, runTmux, ...(opts.now === undefined ? {} : { now: opts.now }) });
  const hub = createSseHub();
  const store = createNotificationStore(notificationStorePath(opts.home), { now });
  const watcher = createSessionWatcher({ observer, hub, ...(opts.now === undefined ? {} : { now: opts.now }), onError: log });
  // THE SCHEDULER LIVES WITH THE RUNTIME, not with a route: a schedule must
  // fire whether or not anyone has the panel open, which is the whole point of
  // a resident daemon (lib/daemon/scheduler.ts).
  const scheduler = createScheduler({
    home: opts.home,
    runTmux,
    observer,
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.schedulerIntervalMs === undefined ? {} : { intervalMs: opts.schedulerIntervalMs }),
    log,
  });

  function findSession(id: string): DaemonSession | undefined {
    // `@名字` and `名字` are the same address (the rule lib/session-message-tools.ts
    // applies to a recipient) — the panel quoting a name back must not 404.
    const key = id.trim().replace(/^@/, "");
    const collection = observer.collect({ includeRecentMs: 7 * 24 * 60 * 60 * 1_000, limit: SESSION_LIST_LIMIT });
    return collection.sessions.find((session) => session.sessionId === key || session.name === key);
  }

  const routes: Route[] = [
    {
      method: "GET",
      pattern: segments("/api/health"),
      handler: (): Reply => ok({
        ok: true,
        schema: DAEMON_SCHEMA,
        pid: process.pid,
        port: boundPort,
        version: daemonPackageVersion(),
        startedAt: new Date(startedAt).toISOString(),
        now: new Date(now()).toISOString(),
        uptimeMs: now() - startedAt,
      }),
    },
    {
      method: "GET",
      pattern: segments("/api/sessions"),
      handler: (ctx): Reply => {
        const includeRecent = numberParam(ctx.query.get("includeRecentMs"));
        const limit = Math.min(Math.max(numberParam(ctx.query.get("limit")) ?? SESSION_LIST_LIMIT, 1), SESSION_LIST_LIMIT);
        const collection = observer.collect({
          ...(includeRecent === undefined ? {} : { includeRecentMs: includeRecent }),
          limit,
        });
        return ok({
          schema: DAEMON_SCHEMA,
          now: collection.now,
          tmuxReadable: collection.tmuxReadable,
          problems: collection.problems,
          sessions: collection.sessions,
        });
      },
    },
    {
      method: "GET",
      pattern: segments("/api/sessions/:id"),
      handler: (ctx): Reply => {
        const session = findSession(ctx.params.id!);
        if (session === undefined) return bad(404, `没有这个会话：${ctx.params.id}`);
        return ok({ session });
      },
    },
    {
      method: "GET",
      pattern: segments("/api/sessions/:id/output"),
      handler: (ctx): Reply => {
        const session = findSession(ctx.params.id!);
        if (session === undefined) return bad(404, `没有这个会话：${ctx.params.id}`);
        const tail = Math.min(Math.max(numberParam(ctx.query.get("tail")) ?? 50, 1), MAX_REPLAY);
        const path = observer.transcriptFor(session.sessionId);
        const entries = path === undefined ? [] : readRecentEntries(path, tail);
        return ok({ sessionId: session.sessionId, entries, transcript: path ?? null });
      },
    },
    {
      method: "POST",
      pattern: segments("/api/sessions/:id/messages"),
      handler: (ctx): Reply => {
        const session = findSession(ctx.params.id!);
        if (session === undefined) return bad(404, `没有这个会话：${ctx.params.id}`);
        if (session.name === null) {
          return bad(400, `${ctx.params.id} 还没有名字 —— 门禁只投递给登记过名字的会话`, {
            sessionId: session.sessionId,
          });
        }
        const body = asObject(ctx.body);
        const outcome = sendSessionMessage({ home: opts.home, runTmux, now }, {
          to: session.name,
          text: typeof body.text === "string" ? body.text : "",
          // NO `from` FROM THE REQUEST (reviewer P1, 2026-10-01): the sender is
          // the daemon and nothing else. A caller-supplied name would let any
          // holder of the token write into another session's inbox dressed as
          // that session — the panel is not a peer, and it must not be able to
          // claim to be one.
        });
        if (!outcome.ok) return bad(400, outcome.problem ?? "发送失败", { liveNames: outcome.liveNames ?? [] });
        return ok({ ok: true, messageId: outcome.messageId, at: outcome.at, inbox: outcome.inbox, to: session.name });
      },
    },
    {
      method: "GET",
      pattern: segments("/api/repos"),
      handler: (): Reply => ok({ repos: listCandidateRepos({ observer, workspaceRoots }) }),
    },
    {
      method: "POST",
      pattern: segments("/api/tasks"),
      handler: (ctx): Reply => {
        const body = asObject(ctx.body);
        const outcome = launchTask({ home: opts.home, runTmux, now }, {
          repo: typeof body.repo === "string" ? body.repo : "",
          task: typeof body.task === "string" ? body.task : "",
          ...(typeof body.mode === "string" ? { mode: body.mode } : {}),
          ...(typeof body.station === "string" ? { station: body.station } : {}),
          ...(typeof body.name === "string" ? { name: body.name } : {}),
        });
        if (!outcome.ok) return bad(400, outcome.problem ?? "启动失败");
        return ok({
          ok: true,
          sessionId: outcome.sessionId,
          scopeSession: outcome.scopeSession,
          windowId: outcome.windowId,
          paneId: outcome.paneId,
          windowName: outcome.windowName,
        });
      },
    },
    {
      method: "GET",
      pattern: segments("/api/schedules"),
      handler: (): Reply => {
        const at = new Date(now());
        const read = readSchedules(opts.home);
        if (!read.ok) return bad(500, read.problem);
        const records = readScheduleRuns(opts.home);
        const byTask = new Map<string, typeof records>();
        for (const record of records) {
          const bucket = byTask.get(record.taskId);
          if (bucket === undefined) byTask.set(record.taskId, [record]);
          else bucket.push(record);
        }
        const tasks = read.file.tasks.map((task) => ({
          ...task,
          // THE SAME JUDGEMENT THE SCHEDULER MAKES, so the panel and the tick
          // cannot disagree about what is coming: it is the slot this task is
          // COUNTING TOWARDS (`lastFiredAt`'s next one, or the first one after
          // it was authored), which lands in the past — delayed, about to run —
          // rather than one whole period ahead when a run was missed.
          nextRunAt: dueDecision({ task, now: at, openRun: false }).scheduledAt?.toISOString() ?? null,
          describe: describeCron(task.cron),
          // `run-started` is not a RESULT: the panel shows what happened, not
          // that something is (or was) happening.
          lastRuns: (byTask.get(task.id) ?? [])
            .filter((record) => record.kind !== "run-started")
            .slice(-LAST_RUNS_SHOWN),
        }));
        return ok({ schema: DAEMON_SCHEMA, now: at.toISOString(), tasks });
      },
    },
    {
      method: "POST",
      pattern: segments("/api/schedules/author"),
      handler: (ctx): Reply => {
        const body = asObject(ctx.body);
        const action = body.action;
        if (action !== "create" && action !== "update") {
          return bad(400, `action 只能是 create / update（收到 ${JSON.stringify(action)}）`);
        }
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const nameProblem = scheduleNameProblem(name);
        if (nameProblem !== undefined) return bad(400, nameProblem);
        if (action === "create") {
          const taken = findScheduledTask(opts.home, name);
          if (taken !== undefined) return bad(400, `名字 ${name} 已经被调度任务 ${taken.id} 占用（id 与 name 共用一个命名空间）`);
        }
        const repo = typeof body.repo === "string" ? body.repo.trim() : "";
        const repoProblem = scheduleRepoProblem(repo);
        if (repoProblem !== undefined) return bad(400, repoProblem);
        const cron = typeof body.cron === "string" ? body.cron.trim() : "";
        const parsed = parseCron(cron);
        if (!parsed.ok) return bad(400, `cron 不合法：${parsed.problem}`);
        const requirement = typeof body.requirement === "string" ? body.requirement.trim() : "";
        if (requirement === "") return bad(400, "requirement 不能为空 —— authoring 会话要拿它去谈需求反述");
        const id = typeof body.id === "string" ? body.id.trim() : "";
        if (action === "update") {
          if (id === "") return bad(400, "action=update 必须带 id");
          const found = taskById(opts.home, id);
          if ("reply" in found) return found.reply;
        }
        // THIS ENDPOINT WRITES NO TABLE: the contract is written by the gate's
        // own tool, after the user approved it in the authoring session.
        const outcome = launchTask({ home: opts.home, runTmux, now }, {
          repo,
          task: authoringTaskText({ action, id, name, repo, cron, requirement }),
          mode: "loop",
        });
        if (!outcome.ok) return bad(400, outcome.problem ?? "启动 authoring 会话失败");
        return ok({
          ok: true,
          sessionId: outcome.sessionId,
          scopeSession: outcome.scopeSession,
          windowId: outcome.windowId,
          paneId: outcome.paneId,
        });
      },
    },
    {
      method: "PUT",
      pattern: segments("/api/schedules/:id"),
      handler: (ctx): Reply => {
        const found = taskById(opts.home, ctx.params.id!);
        if ("reply" in found) return found.reply;
        const body = asObject(ctx.body);
        const patch: ScheduleEditPatch = {};
        if (Object.hasOwn(body, "cron")) patch.cron = body.cron as string;
        if (Object.hasOwn(body, "enabled")) patch.enabled = body.enabled as boolean;
        if (Object.hasOwn(body, "name")) patch.name = body.name as string;
        const extra = Object.keys(body).filter((key) => !PANEL_SCHEDULE_FIELDS.includes(key));
        if (extra.length > 0) {
          // THE AUTHORING RULE IS NOT RESTATED HERE: the whole body goes to the
          // one implementation, which names the authoring path for a contract
          // field and lists the fields a panel may touch for anything else.
          const verdict = applyScheduleEdit({ from: "panel", patch: body as ScheduleEditPatch });
          return bad(400, verdict.ok
            ? `面板只能改 ${PANEL_SCHEDULE_FIELDS.join(" / ")}（收到 ${extra.join("、")}）—— 需求、repo 与契约请走 POST /api/schedules/author`
            : verdict.problem);
        }
        const outcome = updateScheduledTask(opts.home, found.task.id, patch, { from: "panel" });
        if (!outcome.ok) return bad(400, outcome.problem);
        return ok({ ok: true, task: outcome.value, version: outcome.version });
      },
    },
    {
      method: "DELETE",
      pattern: segments("/api/schedules/:id"),
      handler: (ctx): Reply => {
        const found = taskById(opts.home, ctx.params.id!);
        if ("reply" in found) return found.reply;
        const removed = removeScheduledTask(opts.home, found.task.id);
        if (!removed.ok) return bad(400, removed.problem);
        return ok({ ok: true, task: removed.value, version: removed.version });
      },
    },
    {
      method: "GET",
      pattern: segments("/api/schedules/:id/runs"),
      handler: (ctx): Reply => {
        const found = taskById(opts.home, ctx.params.id!);
        if ("reply" in found) return found.reply;
        const limit = Math.min(Math.max(numberParam(ctx.query.get("limit")) ?? DEFAULT_RUNS_LIMIT, 1), MAX_RUNS_LIMIT);
        return ok({
          schema: DAEMON_SCHEMA,
          taskId: found.task.id,
          runs: readScheduleRuns(opts.home, { taskId: found.task.id, limit }),
        });
      },
    },
    {
      method: "GET",
      pattern: segments("/api/config"),
      handler: (ctx): Reply => {
        const target = ctx.query.get("target") ?? "";
        if (!isTarget(target)) return bad(400, `target 只能是 settings/models/gate-global/gate-project（收到 ${JSON.stringify(target)}）`);
        const repo = ctx.query.get("repo") ?? undefined;
        if (target === "gate-project" && (repo ?? "") === "") return bad(400, "gate-project 必须带 repo 参数");
        try {
          return ok(readConfig(target, { home: opts.home, ...(repo === undefined ? {} : { repo }) }));
        } catch (error) {
          return bad(400, error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      method: "PUT",
      pattern: segments("/api/config"),
      handler: (ctx): Reply => {
        const body = asObject(ctx.body);
        const target = typeof body.target === "string" ? body.target : "";
        if (!isTarget(target)) return bad(400, `target 只能是 settings/models/gate-global/gate-project（收到 ${JSON.stringify(target)}）`);
        const repo = typeof body.repo === "string" ? body.repo : undefined;
        if (target === "gate-project" && (repo ?? "") === "") return bad(400, "gate-project 必须带 repo 参数");
        if (typeof body.path !== "string" || body.path.trim() === "") return bad(400, "缺少 path");
        if (!("value" in body)) return bad(400, "缺少 value（要删除这个键就传 null）");
        const outcome = writeConfig(target, body.path.trim(), body.value, {
          home: opts.home,
          ...(repo === undefined ? {} : { repo }),
          now,
        });
        if (!outcome.ok) return bad(400, outcome.problem ?? "写入被拒绝", { path: body.path });
        return ok({ ok: true, path: outcome.path, backup: outcome.backup, value: outcome.value });
      },
    },
    {
      method: "GET",
      pattern: segments("/api/questions"),
      handler: (ctx): Reply => {
        const sessionId = ctx.query.get("sessionId") ?? undefined;
        return ok(listPendingQuestions(opts.home, sessionId === undefined ? {} : { sessionId }));
      },
    },
    {
      method: "POST",
      pattern: segments("/api/questions/:requestId/answer"),
      handler: (ctx): Reply => {
        const body = asObject(ctx.body);
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        if (sessionId === "") return bad(400, "缺少 sessionId —— 一个问题由 (sessionId, requestId) 一起定位");
        // TWO SHAPES, TWO MEANINGS (quality round P1, 2026-10-01): `answers`
        // arrives ALREADY SPLIT — one element per chosen row — and is handed
        // over as a list. Joining it here and letting the text parser split it
        // again would cut an option's own text apart whenever it contains a
        // separator (` / `, `、`, `,`, `+`, a space). `answer` is text somebody
        // typed and keeps the reading it always had.
        const structured =
          Array.isArray(body.answers)
            ? body.answers.filter((item): item is string => typeof item === "string")
            : undefined;
        const answerText = typeof body.answer === "string" ? body.answer : undefined;
        if (structured === undefined && answerText === undefined) {
          return bad(400, "缺少 answer（字符串）或 answers（字符串数组）");
        }
        if (structured !== undefined && structured.length === 0) {
          return bad(400, "answers 里没有可读的选项");
        }
        const outcome = submitAnswer(opts.home, {
          sessionId,
          requestId: ctx.params.requestId!,
          ...(structured === undefined ? { answer: answerText ?? "" } : { answers: structured }),
          by: body.by === "user" ? "user" : "daemon",
          ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        });
        if (!outcome.ok) return bad(400, outcome.problem ?? "答案被拒绝");
        return ok({ ok: true, requestId: ctx.params.requestId, answer: outcome.answer, path: outcome.path });
      },
    },
    {
      method: "GET",
      pattern: segments("/api/notifications"),
      handler: (ctx): Reply => {
        const since = ctx.query.get("since");
        const sinceMs = since === null ? undefined : Date.parse(since);
        const limit = Math.min(Math.max(numberParam(ctx.query.get("limit")) ?? 100, 1), 500);
        return ok({ schema: DAEMON_SCHEMA, entries: store.list({ ...(sinceMs === undefined || Number.isNaN(sinceMs) ? {} : { sinceMs }), limit }) });
      },
    },
    {
      method: "POST",
      pattern: segments("/api/notifications/claim"),
      handler: (ctx): Reply => {
        const body = asObject(ctx.body);
        const key = typeof body.key === "string" ? body.key.trim() : "";
        if (key === "") return bad(400, "缺少 key —— 消费方用它表达「这条事实」（推荐 notifyKey(title, body) 的两个部分用 \\u0000 连接）");
        if (key.length > 512) return bad(400, "key 太长（上限 512 字符）");
        const claim = store.claim({
          key,
          kind: typeof body.kind === "string" ? body.kind.slice(0, 32) : "unknown",
          sessionId: typeof body.sessionId === "string" ? body.sessionId : "",
          name: typeof body.name === "string" ? body.name : null,
          title: typeof body.title === "string" ? body.title : "",
          body: typeof body.body === "string" ? body.body : "",
        });
        return ok({ schema: DAEMON_SCHEMA, key, ...claim });
      },
    },
  ];

  const startedAt = now();
  let server: Server | undefined;
  let boundPort = opts.port;

  function reply(res: ServerResponse, result: Reply): void {
    const headers: Record<string, string> = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(result.headers ?? {}),
    };
    if (result.buffer !== undefined) {
      headers["content-type"] = result.contentType ?? "application/octet-stream";
      res.writeHead(result.status, headers);
      res.end(result.buffer);
      return;
    }
    if (result.text !== undefined || result.contentType !== undefined) {
      const contentType = result.contentType ?? "text/plain; charset=utf-8";
      const body = result.buffer ?? result.text ?? "";
      headers["content-type"] = contentType;
      res.writeHead(result.status, headers);
      res.end(body);
      return;
    }
    const body = JSON.stringify(result.json ?? {});
    headers["content-type"] = "application/json; charset=utf-8";
    res.writeHead(result.status, headers);
    res.end(body);
  }

  function handleSse(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
    const sessionId = query.get("sessionId");
    const replayCount = Math.min(Math.max(numberParam(query.get("replay")) ?? DEFAULT_REPLAY, 0), MAX_REPLAY);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let closed = false;
    const write = (event: DaemonEvent): void => {
      if (closed) return;
      res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
    };
    write({ event: "hello", data: { schema: DAEMON_SCHEMA, now: new Date(now()).toISOString(), sessionId: sessionId ?? null } });
    if (sessionId !== null) {
      // PRIME BEFORE REPLAYING, ALWAYS — even when the subscriber asked for no
      // replay: the bookmark is what makes "the first output after subscribing"
      // reachable, and `replay=0` means "do not send me the past", not "skip the
      // window between now and my first tick". The replay's own end offset is
      // the bookmark, so the tail picks up exactly what the replay did not.
      //
      // AND PRIME EVEN WHEN THE TRANSCRIPT DOES NOT EXIST YET (quality round P1,
      // 2026-10-01): a session started seconds ago — what the panel does right
      // after `POST /api/tasks` — has written nothing, and skipping the bookmark
      // there cost this subscriber every byte written until the file's first
      // sight. `watcher.prime` remembers where reading should start and plants
      // it the moment the transcript appears.
      const path = observer.transcriptFor(sessionId);
      const replay =
        path === undefined || replayCount === 0
          ? { entries: [], offset: undefined }
          : readRecentEntriesWithOffset(path, replayCount);
      watcher.prime(sessionId, replay.offset);
      if (replay.entries.length > 0) {
        write({ event: "output", data: { sessionId, entries: replay.entries, replay: true } });
      }
    }
    const unsubscribe = hub.add(write, sessionId);
    const ping = setInterval(() => write({ event: "ping", data: { at: new Date(now()).toISOString() } }), SSE_PING_MS);
    ping.unref?.();
    const close = (): void => {
      closed = true;
      clearInterval(ping);
      unsubscribe();
    };
    req.on("close", close);
    res.on("close", close);
    res.on("error", close);
  }

  async function readBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; problem: string }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) return { ok: false, problem: `请求体超过 ${MAX_BODY_BYTES} 字节` };
      chunks.push(buffer);
    }
    if (chunks.length === 0) return { ok: true, value: {} };
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (text === "") return { ok: true, value: {} };
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, problem: "请求体不是合法 JSON" };
    }
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/")) {
      reply(res, servePanel(webDir, pathname));
      return;
    }
    // THE QUERY TOKEN IS AN SSE-ONLY EXCEPTION (reviewer P1, 2026-10-01):
    // `EventSource` cannot set a header, so that one endpoint has to take it in
    // the URL — and a URL is exactly where a secret must not otherwise live
    // (shell history, proxy logs, browser history). Every other call uses the
    // Authorization header.
    const provided = bearer(req) ?? (pathname === "/api/events" ? url.searchParams.get("token") : undefined);
    if (!tokenMatches(provided, opts.token)) {
      reply(res, bad(401, "缺少或错误的 token —— Authorization: Bearer <token>（SSE 可用 ?token=）"));
      return;
    }
    if (pathname === "/api/events") {
      if (req.method !== "GET") {
        reply(res, bad(405, "SSE 只支持 GET"));
        return;
      }
      handleSse(req, res, url.searchParams);
      return;
    }
    const route = routes.find((candidate) => candidate.method === req.method && match(candidate.pattern, pathname) !== undefined);
    if (route === undefined) {
      const pathExists = routes.some((candidate) => match(candidate.pattern, pathname) !== undefined);
      reply(res, bad(pathExists ? 405 : 404, pathExists ? `${req.method} 不被这个 endpoint 支持` : `没有这个 endpoint：${pathname}`));
      return;
    }
    const body = req.method === "GET" ? undefined : await readBody(req);
    if (body !== undefined && !body.ok) {
      reply(res, bad(400, body.problem));
      return;
    }
    const ctx: Ctx = {
      method: req.method ?? "GET",
      pathname,
      query: url.searchParams,
      params: match(route.pattern, pathname) ?? {},
      body: body === undefined ? undefined : body.value,
    };
    try {
      reply(res, await route.handler(ctx));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`请求处理失败 ${req.method} ${pathname}：${message}`);
      reply(res, bad(500, `daemon 内部错误：${message}`));
    }
  }

  return {
    server: (() => {
      server = createServer((req, res) => {
        void dispatch(req, res).catch((error: unknown) => {
          log(`请求分派失败：${error instanceof Error ? error.message : String(error)}`);
          try {
            reply(res, bad(500, "daemon 内部错误"));
          } catch { /* the socket is already gone */ }
        });
      });
      return server;
    })(),
    port: () => boundPort,
    start(): Promise<number> {
      const instance = server!;
      return new Promise((resolvePromise, rejectPromise) => {
        const onError = (error: Error): void => rejectPromise(error);
        instance.once("error", onError);
        instance.listen(opts.port, "127.0.0.1", () => {
          instance.removeListener("error", onError);
          const address = instance.address();
          boundPort = typeof address === "object" && address !== null ? address.port : opts.port;
          watcher.start();
          scheduler.start();
          resolvePromise(boundPort);
        });
      });
    },
    stop(): Promise<void> {
      watcher.stop();
      scheduler.stop();
      const instance = server;
      if (instance === undefined) return Promise.resolve();
      return new Promise((resolvePromise) => {
        instance.close(() => resolvePromise());
        // An SSE connection holds the server open; close them so a stop is a stop.
        instance.closeAllConnections?.();
      });
    },
  };
}

function isTarget(value: string): value is ConfigTargetName {
  return value === "settings" || value === "models" || value === "gate-global" || value === "gate-project";
}

/**
 * The task with this EXACT id, or the reply a caller must send instead.
 *
 * By id and not by name: `id` is the address the write endpoints are given,
 * and `findScheduledTask`'s name alias belongs to the read side (the panel
 * quotes an id back, and a name that happens to be another task's id must not
 * make a `PUT` land on the wrong row).
 */
function taskById(home: string, id: string): { task: ScheduledTask } | { reply: Reply } {
  const read = readSchedules(home);
  if (!read.ok) return { reply: bad(500, read.problem) };
  const task = read.file.tasks.find((candidate) => candidate.id === id);
  if (task === undefined) return { reply: bad(404, `没有这个调度任务：${id}`) };
  return { task };
}

/**
 * What an authoring session is asked to do, in one message.
 *
 * It names `schedule_task` and NOT `propose_restatement` / `propose_loop_goal`:
 * that tool runs both itself (restatement dialog → goal audit → approval) and
 * writes the approved contract into the table in the same breath. Asking for
 * them separately would open two dialogs for one contract, and neither of them
 * knows how to write the table.
 */
function authoringTaskText(input: {
  action: "create" | "update";
  id: string;
  name: string;
  repo: string;
  cron: string;
  requirement: string;
}): string {
  const call = [
    `action:${JSON.stringify(input.action)}`,
    ...(input.action === "update" ? [`id:${JSON.stringify(input.id)}`] : []),
    `name:${JSON.stringify(input.name)}`,
    `repo:${JSON.stringify(input.repo)}`,
    `cron:${JSON.stringify(input.cron)}`,
    `requirement:${JSON.stringify(input.requirement)}`,
  ].join(", ");
  return [
    `用 \`schedule_task({${call}})\` 把这份定时任务的契约谈定 —— 它会先弹需求反述、跑 goal 审计，再请你批准 goal。`,
    "**不要**另外调 `propose_restatement` / `propose_loop_goal`：`schedule_task` 会把它们走完，并把批准的契约同时记为本会话的 loop goal。",
    "",
    "本次会话只负责把契约谈定并写进调度表：不要改代码、不要 commit。",
  ].join("\n");
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberParam(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
