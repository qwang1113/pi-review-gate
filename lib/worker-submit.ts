/**
 * `worker_submit`'s implementation — give a worker work: a message to a
 * living pane (with its injection ack), or a pane opened (or re-opened under
 * the same session id) through the one session factory.
 *
 * Its own module so lib/worker-tools.ts keeps the registration and the three
 * tools that READ a worker (wait / answer / close); the channel and ownership
 * facts both sides need are lib/worker-channel.ts.
 */
import type { ToolReply } from "./tool-host.ts";
import { workerPaneDecor } from "./session-factory.ts";
import { appendRecord, channelPathFor, newChannelId, readChannel } from "./orchestrator-channel.ts";
import {
  buildWorkerPaneCommand,
  isWorkerId,
  withWorker,
  workerSessionId,
  type WorkerRegistry,
} from "./worker-pane.ts";
import { buildWorkerSystemPrompt, buildWorkerTaskDocument } from "./worker-side.ts";
import {
  WORKER_WAIT_POLL_MS,
  nextWorkerId,
  ownedPaneAlive,
  resolveWorkerRole,
  targetParts,
  workerTargetFor,
} from "./worker-channel.ts";
import type { WorkerToolDeps } from "./worker-tools.ts";

function reply(text: string, details?: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details };
}

function fail(text: string, details?: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details, isError: true };
}

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
      // THE LAST ACK, NOT THE FIRST (quality round P1, 6th report, 2026-09-21):
      // the handshake always writes `received` first and only writes `injected`
      // once the instruction was actually applied — so `.find` always returned
      // the `received` record and this predicate could never be true. Every
      // "injected" the caller was ever told about came from... nowhere; the
      // helper simply always answered "not confirmed".
      //
      // Written as filter + index rather than `findLast`/`at(-1)` on purpose
      // (reviewer P2): those are recent additions, and this path runs on
      // whatever Node the user's pi started with.
      const acks = readChannel(deps.channelIO, path).records.filter(
        (r) => r.kind === "instruct-ack" && (r as { instructId?: unknown }).instructId === instructId,
      );
      const ack = acks.length > 0 ? (acks[acks.length - 1] as { delivered?: unknown; stage?: unknown }) : undefined;
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

export async function submitWorker(deps: WorkerToolDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const task = String(params.task ?? "").trim();
  if (!task) return fail("review-gate: `task` 不能为空 —— worker 看不到你的上下文，任务书就是它的全部输入。");
  const role = String(params.role ?? "worker").trim() || "worker";
  const resolved = resolveWorkerRole(
    deps.agents(),
    role,
    typeof params.model === "string" ? params.model : undefined,
    deps.validateModel,
  );
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
  if (ownedPaneAlive(deps, existing)) {
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
    `review-gate: worker ${workerId}（角色 ${role}，模型 ${resolved.model}）已在 window ${open.windowId ?? open.paneId} 启动。\n` +
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
): Promise<{ ok: true; paneId: string; windowId?: string } | { ok: false; error: string }> {
  const ownPane = deps.ownPane();
  if (!ownPane) {
    return { ok: false, error: "读不到自己的 tmux pane（$TMUX_PANE）—— 门禁必须在 tmux 里跑，才能开子会话。" };
  }
  let windowId: string | undefined;
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
    cwd: deps.repoRoot(),
    command,
    role: { kind: "worker", openerId, workerId: opts.workerId, role: opts.role },
    decor: workerPaneDecor(opts.workerId, deps.paneOwner()),
    register: (coords) => {
      windowId = coords.windowId;
      const registry = deps.readRegistry();
      // THE CURSOR SURVIVES A REOPEN (reviewer P1, 2026-09-21): `reportedAt` is
      // the ONLY thing that says "this report has been consumed", and
      // `withWorker` replaces the whole entry — so rebuilding it without the
      // cursor meant every reopen (a dead pane resumed, an id reused after
      // close) re-delivered the newest report as if it had just landed.
      const prior = registry[opts.workerId];
      // THE SERVER READING SURVIVES TOO (reviewer P1, 2026-09-21): a fresh
      // reading wins, but an UNREADABLE one must not erase what is recorded —
      // `worker_close` refuses to kill when the recorded server disagrees with
      // the current one, and a dropped field silently removes that check. The
      // stale-forever risk is the safe direction here: a server that really
      // changed makes the next close refuse, which is a human's call.
      const tmuxServer = deps.tmuxServer?.() ?? prior?.tmuxServer;
      deps.saveRegistry(withWorker(registry, {
        workerId: opts.workerId,
        openerId,
        role: opts.role,
        model: opts.model,
        paneId: coords.paneId,
        ...(coords.windowId === undefined ? {} : { windowId: coords.windowId }),
        ...(coords.sessionName === undefined ? {} : { tmuxSession: coords.sessionName }),
        sessionId,
        repoRoot: deps.repoRoot(),
        createdAt: new Date(deps.now()).toISOString(),
        ...(prior?.reportedAt === undefined ? {} : { reportedAt: prior.reportedAt }),
        ...(tmuxServer === undefined ? {} : { tmuxServer }),
      }));
    },
  });
  if (!opened.ok) return { ok: false, error: opened.error };
  return { ok: true, paneId: opened.paneId, ...(windowId === undefined ? {} : { windowId }) };
}
