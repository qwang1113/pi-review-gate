/**
 * THE WORKER TOOLS — dispatch, wait, answer, close. Four names, one pane.
 *
 * ── WHAT THIS REPLACES (user decision, 2026-09-21) ──
 *
 * `npm:@tintinweb/pi-subagents` provided `Agent` / `SubagentWorkflow` /
 * `get_subagent_result` / `steer_subagent`: a subagent ran as a BACKGROUND
 * PROCESS the user could not see, could not re-model, could not attach to, and
 * whose context died with the process. The user's requirement was that opening
 * a subagent and opening a review pane be THE SAME THING — a tmux pane running
 * the configured model, resumed by session id — and that a finished pane be
 * closable to save screen space without losing the conversation.
 *
 * So a worker is a pane session with a deterministic session id. The four
 * tools are the four things a caller does with one, and there is no fifth:
 *
 *   - `worker_submit` — give it work. Opens the pane, or resumes the SAME
 *     session when the pane is gone; a second submit to a living worker is a
 *     message, not a second worker.
 *   - `worker_wait`   — collect what it said: its report, or a question it is
 *     blocked on. Message-driven, so a wait returns on the first of them.
 *   - `worker_answer` — answer that question.
 *   - `worker_close`  — free the pane. The transcript stays on disk, so the
 *     next `worker_submit` with the same id continues the conversation.
 *
 * ── WHY THERE IS NO `worker_recover` ──
 *
 * A judge needs one because its pane's death is discovered by the OPENER from
 * outside, and `judge_submit` must say so. A worker's death is discovered by
 * the next `worker_submit` itself (`paneAlive` false ⇒ open the pane again
 * under the same id), which is the same code path as the very first dispatch.
 * A separate recovery tool would be a second way to start a worker.
 *
 * PURE-ISH: tmux, the file system, the clock and the channel all enter through
 * {@link WorkerToolDeps}, so the whole protocol is drivable from a test.
 */

import { Type } from "typebox";
import type { ToolHost } from "./tool-host.ts";
import type { ToolReply } from "./tool-host.ts";
import type { SessionPaneRole } from "./session-factory.ts";
import type { ChannelIO, ChannelTarget, ChannelRecord, ChannelRequestRecord, ChannelReportRecord } from "./orchestrator-channel.ts";
import { appendRecord, channelPathFor, newChannelId, readChannel, requestPayload } from "./orchestrator-channel.ts";
import type { AgentsConfigMap } from "./model-config.ts";
import {
  buildWorkerPaneCommand,
  isWorkerId,
  withWorker,
  workerSessionId,
  type WorkerEntry,
  type WorkerRegistry,
} from "./worker-pane.ts";
import { buildWorkerSystemPrompt, buildWorkerTaskDocument } from "./worker-side.ts";

/** How long `worker_wait` polls before reporting the state it found. */
export const WORKER_WAIT_DEFAULT_MS = 300_000;
/** Poll interval. The worker's channel is a file on the same machine. */
export const WORKER_WAIT_POLL_MS = 500;

export interface WorkerToolDeps {
  /** This session's own pane — the layout anchor and the opener identity. */
  ownPane(): string | undefined;
  /** Is this pane id still alive? */
  paneAlive(paneId: string): boolean;
  /**
   * Open the pane through the ONE factory every pane goes through
   * (`openSessionPane` in lib/session-factory.ts). Injected rather than
   * imported so this module owns WHAT is opened and that module owns HOW —
   * and so the protocol below is testable without tmux.
   */
  openPane(spec: {
    ownPane: string;
    cwd: string;
    command: readonly string[];
    role: SessionPaneRole;
    register: (paneId: string) => void;
  }): Promise<{ ok: true; paneId: string } | { ok: false; error: string }>;
  /** Kill a pane. `ok: false` is tolerated (already gone ⇒ still closed). */
  killPane(paneId: string): boolean;
  /** The opener id this session dispatches under (its own pane, normally). */
  openerId(): string;
  /** The repo workers are dispatched against. */
  repoRoot(): string;
  channelIO: ChannelIO;
  channelHome(): string | undefined;
  /** Where a worker's prompt + task files live (a per-worker scratch dir). */
  workDirFor(workerId: string): string;
  /** Where pi keeps this worker's transcript (the OTHER half of the resume key). */
  sessionDirFor(workerId: string): string;
  writeFile(path: string, content: string): { ok: true } | { ok: false; error: string };
  readRegistry(): WorkerRegistry;
  saveRegistry(registry: WorkerRegistry): void;
  /** The tmux SERVER this session lives on, when resolvable — see WorkerEntry. */
  tmuxServer?(): string | undefined;
  /** The effective `agents` config: worker presets are the roles named `worker*`. */
  agents(): AgentsConfigMap;
  now(): number;
  sleep?(ms: number): Promise<void>;
  log(message: string): void;
}

function reply(text: string, details?: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details };
}

function fail(text: string, details?: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details, isError: true };
}

/** The channel one worker talks on — opener + worker id, like a judge's. */
export function workerChannelTarget(openerId: string, workerId: string, home?: string): ChannelTarget {
  return { orchestrationId: openerId, childId: `worker-${workerId}`, ...(home === undefined ? {} : { home }) };
}

/**
 * WHERE AN EXISTING WORKER'S CHANNEL IS — read from its registry entry, never
 * re-derived from this session's environment (reviewer P1, 2026-09-21).
 *
 * The opener's pane id changes on every restart, re-attach and handover, so a
 * re-derived target points at a channel the worker never wrote to: its report
 * lands where nobody looks and the caller waits on an empty file forever. The
 * entry is the record of who opened it, so the entry is what answers.
 */
function workerTargetFor(deps: WorkerToolDeps, registry: WorkerRegistry, workerId: string): ChannelTarget {
  const recorded = registry[workerId]?.openerId;
  return workerChannelTarget(recorded ?? deps.openerId(), workerId, deps.channelHome());
}

/** Everything a worker has said that the opener has not consumed yet. */
export interface WorkerProjection {
  /** The newest report on the channel, with the id used to dedupe it. */
  report?: { reportId: string; text: string; at: string };
  /** The oldest question still waiting for an answer. */
  question?: { requestId: string; title: string; options: string[]; payload?: string; at: string };
  /** How many records the channel holds — the boot watermark. */
  records: number;
}

/**
 * Project one worker channel into the two things a caller can act on.
 *
 * A question stays in the projection until an ANSWER for its requestId exists:
 * that is what makes `worker_wait` idempotent — polling it twice shows the same
 * question rather than losing it, and the caller's `worker_answer` is the only
 * thing that retires it.
 */
export function projectWorkerChannel(io: ChannelIO, records: readonly ChannelRecord[]): WorkerProjection {
  const answered = new Set<string>();
  for (const r of records) if (r.kind === "answer") answered.add(r.requestId);
  let report: WorkerProjection["report"];
  let question: WorkerProjection["question"];
  for (const r of records) {
    if (r.kind === "report") {
      const text = (r as ChannelReportRecord).summary;
      if (typeof text === "string" && text.trim()) {
        report = { reportId: (r as ChannelReportRecord).reportId, text: text.trim(), at: r.at };
      }
      continue;
    }
    if (r.kind === "request") {
      const req = r as ChannelRequestRecord;
      if (answered.has(req.requestId)) continue;
      // OLDEST first: a worker blocked on question one must not be answered out
      // of order by a later one.
      if (!question) {
        question = {
          requestId: req.requestId,
          title: req.title,
          options: req.options ?? [],
          at: req.at,
          ...(requestPayload(io, req) === undefined ? {} : { payload: requestPayload(io, req)! }),
        };
      }
    }
  }
  return { ...(report === undefined ? {} : { report }), ...(question === undefined ? {} : { question }), records: records.length };
}

/** Read one worker's channel, tolerating a channel that does not exist yet. */
function readWorkerChannel(deps: WorkerToolDeps, registry: WorkerRegistry, workerId: string): WorkerProjection {
  try {
    const path = channelPathFor(...targetParts(deps, registry, workerId));
    return projectWorkerChannel(deps.channelIO, readChannel(deps.channelIO, path).records);
  } catch {
    return { records: 0 };
  }
}

function targetParts(
  deps: WorkerToolDeps,
  registry: WorkerRegistry,
  workerId: string,
): [string, string, string | undefined] {
  const target = workerTargetFor(deps, registry, workerId);
  return [target.orchestrationId, target.childId, target.home];
}

/** Mint the next free worker id (`worker-1`, `worker-2`, …). */
export function nextWorkerId(registry: WorkerRegistry): string {
  for (let i = 1; ; i += 1) {
    const candidate = `worker-${i}`;
    if (!registry[candidate]) return candidate;
  }
}

/** The role's resolved launch: the model to run and the prompt it carries. */
export function resolveWorkerRole(
  agents: AgentsConfigMap,
  role: string,
  overrideModel?: string,
): { ok: true; model: string; prompt?: string } | { ok: false; reason: string } {
  const entry = agents[role];
  if (!entry || entry.source === "default") {
    return {
      ok: false,
      reason:
        `worker 角色 \`${role}\` 没有配置 —— 在 ~/.pi/review-gate.json 的 agents 段里加上它` +
        `（\`{ "auto": false, "slots": ["<provider>/<model>:<thinking>"], "prompt": "…" }\`）。` +
        "没有配置就派活等于用一个没人选过的模型跑，所以这里直接拒绝。",
    };
  }
  if (entry.malformed) return { ok: false, reason: `worker 角色 \`${role}\` 的配置字段非法（malformed）` };
  const override = overrideModel?.trim();
  if (override) return { ok: true, model: override, ...(entry.prompt === undefined ? {} : { prompt: entry.prompt }) };
  const model = entry.slots[0];
  if (!model) {
    return { ok: false, reason: `worker 角色 \`${role}\` 的 slots 是空的 —— 没有可派发的模型` };
  }
  return { ok: true, model, ...(entry.prompt === undefined ? {} : { prompt: entry.prompt }) };
}

/** Register the four worker tools on ONE host. */
export function registerWorkerTools(host: ToolHost, deps: WorkerToolDeps): void {
  host.registerTool({
    name: "worker_submit",
    label: "Dispatch A Read-Only Worker",
    description:
      "Give a piece of READ-ONLY work to a worker session in its own tmux pane — the pane-shaped replacement " +
      "for a background subagent. The worker runs the model configured for its role in ~/.pi/review-gate.json " +
      "(`agents.worker*`, with its own `prompt`), cannot edit files or run commands (edit/write/bash are excluded " +
      "from its tool surface, so several workers can run at once without invalidating a recorded review), and reports back " +
      "through `worker_wait`. Pass the SAME `workerId` to continue an existing worker: a living pane receives " +
      "the text as a message, a closed pane is re-opened with the same session id so the worker keeps its " +
      "context. Omit `workerId` and the gate mints one and tells you which.",
    parameters: Type.Object({
      task: Type.String({ description: "What to investigate. Self-contained: the worker sees nothing else." }),
      workerId: Type.Optional(Type.String({
        description: "Reuse/continue this worker (a–z, 0–9, dashes). Omit for a fresh one.",
      })),
      role: Type.Optional(Type.String({
        description: "Which configured preset to launch as (default `worker`; any `agents.worker*` entry).",
      })),
      model: Type.Optional(Type.String({
        description: "Override the preset's first slot for THIS dispatch (e.g. `onekey/gpt-6-astra:high`).",
      })),
    }),
    execute: (_id, params) => submitWorker(deps, params),
  });

  host.registerTool({
    name: "worker_wait",
    label: "Wait On A Worker",
    description:
      "Wait for a worker's next message and return it: its report (the result) or a question it is blocked " +
      "on. Message-driven — it returns as soon as either lands, not when the worker exits, and a question " +
      "stays pending until `worker_answer` retires it. `timeoutMs: 0` is an instant snapshot. A worker that " +
      "has already reported does not report twice: the same report is not delivered again unless it is new.",
    parameters: Type.Object({
      workerId: Type.Optional(Type.String({ description: "Which worker. Required once you have more than one." })),
      timeoutMs: Type.Optional(Type.Number({ description: "How long to wait (default 300000, 0 = snapshot)." })),
    }),
    execute: (_id, params) => waitWorker(deps, params),
  });

  host.registerTool({
    name: "worker_answer",
    label: "Answer A Worker",
    description:
      "Answer the question a worker is waiting on (see `worker_wait`). The answer takes the exact option text, " +
      "its 1-based number, or an unambiguous substring; free text is allowed for a question with no options.",
    parameters: Type.Object({
      workerId: Type.String(),
      requestId: Type.Optional(Type.String({ description: "The question's id from `worker_wait`, when several are open." })),
      answer: Type.String(),
    }),
    execute: (_id, params) => answerWorker(deps, params),
  });

  host.registerTool({
    name: "worker_close",
    label: "Close A Worker",
    description:
      "Close a worker's pane and free the screen space, keeping its transcript: the next `worker_submit` with " +
      "the same `workerId` re-opens the same session, so the worker still remembers what it read. Idempotent. " +
      "Closing is NOT required — a worker that has reported can simply be left alone — but nothing else will " +
      "reclaim the pane for you.",
    parameters: Type.Object({
      workerId: Type.String(),
    }),
    execute: (_id, params) => closeWorker(deps, params),
  });
}

// ---------------------------------------------------------------------------
// the four implementations
// ---------------------------------------------------------------------------

/** How long `worker_submit` waits for the pane's gate to confirm an append. */
export const WORKER_ACK_WAIT_MS = 8_000;

/**
 * Wait for the pane's own gate to say it injected this instruction.
 *
 * The ack (`instruct-ack`, stage `injected`) is written by the CHILD's gate —
 * the only party that knows whether the text reached the agent. Absent budget
 * ⇒ a plain report of what was seen: `injected: false` means NOT CONFIRMED,
 * never "failed" (the message is in the channel either way).
 */
async function waitForInstructAck(
  deps: WorkerToolDeps,
  registry: WorkerRegistry,
  workerId: string,
  instructId: string,
  budgetMs = WORKER_ACK_WAIT_MS,
): Promise<{ injected: boolean }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const started = deps.now();
  for (;;) {
    try {
      const path = channelPathFor(...targetParts(deps, registry, workerId));
      const ack = readChannel(deps.channelIO, path).records.find(
        (r) => r.kind === "instruct-ack" && (r as { instructId?: unknown }).instructId === instructId,
      ) as { delivered?: unknown; stage?: unknown } | undefined;
      if (ack) {
        return { injected: ack.delivered === true && (ack.stage === undefined || ack.stage === "injected") };
      }
    } catch {
      // Unreadable channel this tick — keep waiting; the budget is the verdict.
    }
    if (deps.now() - started >= budgetMs) return { injected: false };
    await sleep(WORKER_WAIT_POLL_MS);
  }
}

async function submitWorker(deps: WorkerToolDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const task = String(params.task ?? "").trim();
  if (!task) return fail("review-gate: `task` 不能为空 —— worker 看不到你的上下文，任务书就是它的全部输入。");
  const role = String(params.role ?? "worker").trim() || "worker";
  const resolved = resolveWorkerRole(deps.agents(), role, typeof params.model === "string" ? params.model : undefined);
  if (!resolved.ok) return fail(`review-gate: ${resolved.reason}`);

  const registry = deps.readRegistry();
  const asked = typeof params.workerId === "string" ? params.workerId.trim() : "";
  if (asked && !isWorkerId(asked)) {
    return fail(
      `review-gate: workerId "${asked}" 不合法 —— 它同时是 pane 标题、通道文件名和 pi session id 的一部分，` +
      "只接受 `[a-z0-9][a-z0-9-]{0,40}`。",
    );
  }
  const workerId = asked || nextWorkerId(registry);
  const existing = registry[workerId];

  // A LIVING PANE IS A CONVERSATION IN PROGRESS (2026-09-21): the text goes to
  // the worker as a message, through the same instruct channel an orchestration
  // child uses, so it is read by the pane's own gate and cannot be truncated,
  // reordered or read as a dialog keypress.
  if (existing?.paneId !== undefined && deps.paneAlive(existing.paneId)) {
    const target = workerTargetFor(deps, registry, workerId);
    const instructId = newChannelId("wi", deps.now());
    appendRecord(deps.channelIO, target, {
      kind: "instruct",
      from: "orchestrator",
      at: new Date(deps.now()).toISOString(),
      instructId,
      mode: "interrupt",
      text: task,
    });
    // EARN THE RECEIPT (reviewer P2, 2026-09-21). Appending a record proves
    // nothing: the pane's own gate is what reads it, and its ack is the only
    // evidence the text was injected. `orchestrator_instruct` verifies for the
    // same reason ("一条没人读的消息不算投递"), and without it a worker whose
    // pane is alive but whose gate never drains leaves the caller waiting on an
    // answer nobody was ever asked for. Bounded, because a worker deep in a
    // tool call takes as long as it takes — and the honest answer then is
    // "written, not yet confirmed".
    const ack = await waitForInstructAck(deps, registry, workerId, instructId);
    deps.log(`worker ${workerId}: 追加任务${ack.injected ? "已注入" : "已写入通道（未确认注入）"}（pane ${existing.paneId} 存活）`);
    return reply(
      `review-gate: worker ${workerId} 仍在 pane ${existing.paneId} 上跑 —— 追加任务` +
      (ack.injected
        ? "它自己的门禁已确认注入（同一会话，不是新 worker）。"
        : `已写进它的通道，但 ${Math.round(WORKER_ACK_WAIT_MS / 1000)}s 内没等到注入确认（它可能正忙）。`) +
      "\n用 `worker_wait({workerId: …})` 收它的回复；若一直没动静，`worker_close` 后重新 `worker_submit` 会在同一 session 上重开。",
      { workerId, paneId: existing.paneId, mode: "instruct", injected: ack.injected },
    );
  }

  const open = await openWorkerPane(deps, {
    workerId,
    // An EXISTING worker keeps its channel; a new one is born on this
    // session's identity.
    openerId: existing?.openerId ?? deps.openerId(),
    role,
    task,
    model: resolved.model,
    ...(resolved.prompt === undefined ? {} : { prompt: resolved.prompt }),
  });
  if (!open.ok) return fail(`review-gate: worker ${workerId} 没能启动 —— ${open.error}`);
  return reply(
    `review-gate: worker ${workerId}（角色 ${role}，模型 ${resolved.model}）已在 pane ${open.paneId} 启动。\n` +
    (existing
      ? "它上一次的会话被**接着用**了（同一 session id）—— 它还记得之前读过的东西。\n"
      : "") +
    `任务：${task.slice(0, 200)}${task.length > 200 ? "…" : ""}\n` +
    "用 `worker_wait({workerId})` 收结果。",
    { workerId, paneId: open.paneId, role, model: resolved.model, resumed: Boolean(existing) },
  );
}

async function openWorkerPane(
  deps: WorkerToolDeps,
  opts: { workerId: string; openerId: string; role: string; task: string; model: string; prompt?: string },
): Promise<{ ok: true; paneId: string } | { ok: false; error: string }> {
  const ownPane = deps.ownPane();
  if (!ownPane) {
    return { ok: false, error: "读不到自己的 tmux pane（$TMUX_PANE）—— worker 是 tmux pane 会话，没有 tmux 就开不出来。" };
  }
  const workDir = deps.workDirFor(opts.workerId);
  const sysPromptPath = `${workDir}/system-prompt.md`;
  const taskPath = `${workDir}/task.md`;
  const prompt = deps.writeFile(
    sysPromptPath,
    buildWorkerSystemPrompt({
      repoRoot: deps.repoRoot(),
      role: opts.role,
      ...(opts.prompt === undefined ? {} : { prompt: opts.prompt }),
    }),
  );
  if (!prompt.ok) return { ok: false, error: `系统提示词写不出来（${prompt.error}）` };
  const task = deps.writeFile(taskPath, buildWorkerTaskDocument({ workerId: opts.workerId, role: opts.role, task: opts.task }));
  if (!task.ok) return { ok: false, error: `任务书写不出来（${task.error}）` };

  const sessionId = workerSessionId(opts.workerId);
  const command = buildWorkerPaneCommand({
    sessionId,
    taskPath,
    sessionDir: deps.sessionDirFor(opts.workerId),
    sysPromptPath,
    model: opts.model,
  });
  // The pane is opened by the ONE factory every other pane goes through; what
  // this function adds is only WHAT to open (lib/session-factory.ts owns how).
  //
  // RESUME KEEPS THE CHANNEL THE WORKER ALREADY HAS (reviewer P1, 2026-09-21).
  // `opts.openerId` is fixed when the WORKER IS BORN and never re-stamped: a
  // worker that already exists owns a channel under the opener that first
  // opened it, so stamping this session's identity on a resume would move the
  // address while everything the worker ever said stayed behind — including
  // the report the caller is waiting for.
  const openerId = opts.openerId;
  const opened = await deps.openPane({
    ownPane,
    cwd: deps.repoRoot(),
    command,
    role: { kind: "worker", openerId, workerId: opts.workerId, role: opts.role },
    register: (paneId) => {
      const registry = deps.readRegistry();
      // THE CURSOR SURVIVES A REOPEN (reviewer P1, 2026-09-21): `reportedAt` is
      // the ONLY thing that says "this report has been consumed", and
      // `withWorker` replaces the whole entry — so rebuilding it without the
      // cursor meant every reopen (a dead pane resumed, an id reused after
      // close) re-delivered the newest report as if it had just landed.
      const prior = registry[opts.workerId];
      deps.saveRegistry(withWorker(registry, {
        workerId: opts.workerId,
        openerId,
        role: opts.role,
        model: opts.model,
        paneId,
        sessionId,
        repoRoot: deps.repoRoot(),
        createdAt: new Date(deps.now()).toISOString(),
        ...(prior?.reportedAt === undefined ? {} : { reportedAt: prior.reportedAt }),
        ...(deps.tmuxServer?.() === undefined ? {} : { tmuxServer: deps.tmuxServer()! }),
      }));
    },
  });
  if (!opened.ok) return { ok: false, error: opened.error };
  return { ok: true, paneId: opened.paneId };
}

async function waitWorker(deps: WorkerToolDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const registry = deps.readRegistry();
  const asked = typeof params.workerId === "string" ? params.workerId.trim() : "";
  const workerId = asked || onlineWorkerId(deps, registry);
  if (!workerId) {
    return fail(
      "review-gate: 没有在跑的 worker，也没有指定 workerId —— 先 `worker_submit` 派一个。",
    );
  }
  const timeoutMs = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
    ? Math.max(0, params.timeoutMs)
    : WORKER_WAIT_DEFAULT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const started = deps.now();
  const seen = registry[workerId]?.reportedAt;
  for (;;) {
    const projection = readWorkerChannel(deps, registry, workerId);
    if (projection.question) {
      return reply(
        `review-gate: worker ${workerId} 在等你回答：\n\n${projection.question.title}\n` +
        (projection.question.options.length
          ? "\n" + projection.question.options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")
          : "") +
        (projection.question.payload ? `\n\n${projection.question.payload}` : "") +
        `\n\n用 \`worker_answer({workerId: "${workerId}", requestId: "${projection.question.requestId}", answer: "…"})\` 回它。`,
        { workerId, requestId: projection.question.requestId, kind: "question" },
      );
    }
    if (projection.report && projection.report.reportId !== seen) {
      const entry = registry[workerId];
      if (entry) {
        deps.saveRegistry(withWorker(registry, { ...entry, reportedAt: projection.report.reportId }));
      }
      return reply(
        `review-gate: worker ${workerId} 交活了：\n\n${projection.report.text}`,
        { workerId, reportId: projection.report.reportId, kind: "report" },
      );
    }
    // A DEAD PANE WITH NOTHING NEW IS NEWS TOO (reviewer P2, 2026-09-21): the
    // old loop spent the whole 300-second timeout to report "it is gone" —
    // something it had read on the very first iteration. A worker whose pane is
    // gone and whose channel holds no unconsumed report cannot produce anything
    // else, and saying so NOW is what "message-driven" is supposed to mean.
    const entry = registry[workerId];
    if (entry?.paneId !== undefined && !deps.paneAlive(entry.paneId)) {
      return reply(
        `review-gate: worker ${workerId} 的 pane（${entry.paneId}）已不在，通道里也没有未消费的报告 —— 它不会再有新消息了。\n` +
        `接着用：\`worker_submit({ workerId: "${workerId}", task: … })\`（同一 session id 重开，它还记得上次读过的）；` +
        `不用了就 \`worker_close({ workerId: "${workerId}" })\`。`,
        { workerId, kind: "gone", alive: false },
      );
    }
    if (timeoutMs === 0 || deps.now() - started >= timeoutMs) {
      const entry = registry[workerId];
      const alive = entry?.paneId !== undefined ? deps.paneAlive(entry.paneId) : false;
      return reply(
        `review-gate: worker ${workerId} 还没有新消息（等了 ${Math.round((deps.now() - started) / 1000)}s）。\n` +
        (entry
          ? (entry.paneId === undefined
              ? "它的 pane 已经关过（登记还在，所以可以接着用）。\n"
              // "存活，但没有任何新消息" — the aliveness is a READING; "still
              // working" was an assertion this side cannot make (quality P2).
              : `pane ${entry.paneId}：${alive ? "存活，但没有任何新消息" : "已不在"}。\n`)
          : "它不在注册表里 —— 可能已经被 close 过。\n") +
        `再等一次，或 \`worker_close({workerId: "${workerId}"})\` 收掉它。`,
        { workerId, kind: "timeout", alive },
      );
    }
    await sleep(WORKER_WAIT_POLL_MS);
  }
}

/** The only worker a `worker_wait` may default to: the one that is running. */
function onlineWorkerId(deps: WorkerToolDeps, registry: WorkerRegistry): string | undefined {
  const ids = Object.keys(registry);
  if (ids.length === 1) return ids[0];
  const live = ids.filter((id) => {
    const paneId = registry[id]!.paneId;
    return paneId !== undefined && deps.paneAlive(paneId);
  });
  return live.length === 1 ? live[0] : undefined;
}

async function answerWorker(deps: WorkerToolDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const workerId = String(params.workerId ?? "").trim();
  if (!isWorkerId(workerId)) return fail(`review-gate: workerId "${workerId}" 不合法。`);
  const answer = String(params.answer ?? "").trim();
  if (!answer) return fail("review-gate: answer 不能为空。");
  const registry = deps.readRegistry();
  const projection = readWorkerChannel(deps, registry, workerId);
  const requestId = typeof params.requestId === "string" ? params.requestId.trim() : projection.question?.requestId;
  if (!requestId) {
    return fail(
      `review-gate: worker ${workerId} 现在没有待答的问题` +
      (projection.records ? "（它的通道里有记录，但没有未答复的提问）" : "（它的通道还是空的）") +
      " —— 用 `worker_wait({workerId})` 看它到底说了什么。",
    );
  }
  const question = projection.question;
  if (question && requestId === question.requestId && question.options.length > 0) {
    const exact = question.options.find((o) => o === answer);
    const byIndex = /^\d+$/.test(answer) ? question.options[Number(answer) - 1] : undefined;
    const partial = question.options.filter((o) => o.includes(answer));
    const picked = exact ?? byIndex ?? (partial.length === 1 ? partial[0] : undefined);
    if (!picked) {
      return fail(
        `review-gate: "${answer}" 不是选项、序号，也不是能唯一命中的子串 —— 照抄一个选项，或用它的序号：\n` +
        question.options.map((o, i) => `  ${i + 1}. ${o}`).join("\n"),
        { workerId, requestId },
      );
    }
    appendRecord(deps.channelIO, workerTargetFor(deps, registry, workerId), {
      kind: "answer",
      from: "orchestrator",
      at: new Date(deps.now()).toISOString(),
      requestId,
      answer: picked,
    });
    return reply(`review-gate: 已回复 worker ${workerId}：${picked}`, { workerId, requestId, answer: picked });
  }
  appendRecord(deps.channelIO, workerTargetFor(deps, registry, workerId), {
    kind: "answer",
    from: "orchestrator",
    at: new Date(deps.now()).toISOString(),
    requestId,
    answer,
  });
  return reply(`review-gate: 已回复 worker ${workerId}。`, { workerId, requestId, answer });
}

async function closeWorker(deps: WorkerToolDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const workerId = String(params.workerId ?? "").trim();
  if (!isWorkerId(workerId)) return fail(`review-gate: workerId "${workerId}" 不合法。`);
  const registry = deps.readRegistry();
  const entry = registry[workerId];
  if (!entry) {
    return reply(`review-gate: worker ${workerId} 不在注册表里（已经关过，或从没派过）。`, { workerId, closed: false });
  }
  // FAIL-CLOSED OWNERSHIP (reviewer P1, 2026-09-21). A recorded server we
  // cannot RE-READ is not a licence to kill: an unreadable identity is missing
  // information, and after a tmux restart that pane id may belong to somebody
  // else's session entirely. Only an exact match proceeds.
  const tmuxServer = deps.tmuxServer?.();
  if (entry.tmuxServer !== undefined && entry.tmuxServer !== tmuxServer) {
    return fail(
      `review-gate: 拒绝关闭 worker ${workerId} —— 它登记在 tmux server ${entry.tmuxServer}，` +
      `当前读到的是 ${tmuxServer ?? "读不到"}。那个 pane id 现在可能属于别的会话，关它就是误伤。` +
      "登记已保留，请人工确认后处理。",
      { workerId, closed: false },
    );
  }
  if (entry.paneId === undefined) {
    return reply(`review-gate: worker ${workerId} 的 pane 已经关过了（登记还在，同一 id 可以接着用）。`, {
      workerId, closed: true, paneId: undefined,
    });
  }
  const killed = deps.killPane(entry.paneId);
  // THE ENTRY STAYS (reviewer P1, 2026-09-21). Closing a pane releases SCREEN
  // SPACE, not the conversation: the channel owner, the session id and the
  // report cursor are exactly what a later `worker_submit` needs to resume the
  // same session. Dropping the entry meant a resume opened a NEW channel under
  // the current session's identity (the old reports unreachable) with the
  // consumed-report cursor reset (the newest one re-delivered).
  const { paneId: _closedPane, ...kept } = entry;
  deps.saveRegistry(withWorker(registry, kept));
  return reply(
    `review-gate: worker ${workerId} 的 pane ${entry.paneId} ${killed ? "已关闭" : "已不在（视为关闭）"}。\n` +
    "它的 transcript 留在磁盘上：再用同一个 `workerId` 派活会接着同一会话（`" + entry.sessionId + "`）。",
    { workerId, closed: true, paneId: entry.paneId },
  );
}
