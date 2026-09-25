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
 *
 * WHERE THE PARTS LIVE: `worker_submit`'s implementation is
 * lib/worker-submit.ts, and the channel / pane-ownership / role facts every
 * tool reads are lib/worker-channel.ts.
 */

import { Type } from "typebox";
import type { ToolHost } from "./tool-host.ts";
import type { ToolReply } from "./tool-host.ts";
import type { SessionPaneCoords, SessionPaneDecor, SessionPaneRole } from "./session-factory.ts";
import { windowAlreadyGone } from "./session-factory.ts";
import type { ChannelIO } from "./orchestrator-channel.ts";
import { appendRecord } from "./orchestrator-channel.ts";
import type { AgentsConfigMap } from "./agents-config.ts";
import { isWorkerId, withWorker, type WorkerRegistry } from "./worker-pane.ts";
import { pollUntil } from "./poll-wait.ts";
import {
  WORKER_WAIT_POLL_MS,
  ownedPaneAlive,
  paneIsOurs,
  readWorkerChannel,
  workerTargetFor,
  type WorkerProjection,
} from "./worker-channel.ts";
import { submitWorker } from "./worker-submit.ts";

/** How long `worker_wait` polls before reporting the state it found. */
export const WORKER_WAIT_DEFAULT_MS = 300_000;

export interface WorkerToolDeps {
  /** This session's own pane — the layout anchor and the opener identity. */
  ownPane(): string | undefined;
  /** Is this pane id still alive? */
  paneAlive(paneId: string): boolean;
  /**
   * Open the window through the ONE factory every child goes through
   * (`openSessionWindow` in lib/session-factory.ts). Injected rather than
   * imported so this module owns WHAT is opened and that module owns HOW —
   * and so the protocol below is testable without tmux.
   */
  openPane(spec: {
    cwd: string;
    command: readonly string[];
    role: SessionPaneRole;
    /** Border colour + label, so a worker window is not a blank rectangle. */
    decor: SessionPaneDecor;
    register: (coords: SessionPaneCoords) => void;
  }): Promise<{ ok: true; paneId: string } | { ok: false; error: string }>;
  /**
   * Close a worker's WINDOW (2026-09-25). The failure is REPORTED, not collapsed
   * into `false`: "tmux refused" and "it is already gone" are different facts,
   * and only one of them means the window may still be on screen.
   *
   * A window rather than a pane because that is what a worker is: a window of
   * its opener's own tmux session, addressed `<ownSession>:<@id>`.
   */
  closeWindow(coords: { ownSession: string; windowId: string }): { ok: boolean; error?: string };
  /** The opener id this session dispatches under (its own pane, normally). */
  openerId(): string;
  /**
   * WHO THIS SESSION IS on a border — the `@<owner>` half of the label
   * (lib/orchestrator-pane-decor.ts `selfPaneOwner`). It is derived from the
   * session's own facts, never from a tool parameter, which is why it is a
   * seam and not an argument: `pm`, a task id, or `self`.
   */
  paneOwner(): string;
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
  /**
   * Does this model spec resolve against the user's registry?
   *
   * Injected because reading the registry is the CALLER's business
   * (lib/model-config.ts `validateSpec` + `loadRegistry`), and the answer is
   * what keeps a typo'd preset from being discovered only when pi refuses to
   * start the pane. Optional in the seam so protocol tests need no registry.
   */
  validateModel?(spec: string): { ok: boolean; reason?: string };
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

/** Register the four worker tools on ONE host. */
export function registerWorkerTools(host: ToolHost, deps: WorkerToolDeps): void {
  host.registerTool({
    name: "worker_submit",
    label: "Dispatch A Read-Only Worker",
    description:
      "Give a piece of READ-ONLY work to a worker session in its own tmux pane — the pane-shaped replacement " +
      "for a background subagent. The worker runs the model configured for its role in ~/.pi/review-gate.json " +
      "(`agents.worker*`, with its own `prompt`), cannot edit files (`edit`/`write` are excluded from its tool " +
      "surface) and may run READ-ONLY commands only — `git log`, `rg`, a test — so several workers can run at " +
      "once without invalidating a recorded review. It reports back " +
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
      "has already reported does not report twice: the same report is not delivered again unless it is new. " +
      "The wait is INTERRUPTIBLE: ESC, or simply typing a message, returns it immediately and consumes nothing.",
    parameters: Type.Object({
      workerId: Type.Optional(Type.String({ description: "Which worker. Required once you have more than one." })),
      timeoutMs: Type.Optional(Type.Number({ description: "How long to wait (default 300000, 0 = snapshot)." })),
    }),
    execute: (_id, params, signal) => waitWorker(deps, params, signal),
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
// the three implementations that read a worker (submit: lib/worker-submit.ts)
// ---------------------------------------------------------------------------

/**
 * What one probe of a worker's channel found. `kind: "pending"` is the only
 * observation the wait keeps polling on; every other one ENDS it.
 *
 * The probe is READ-ONLY on purpose (2026-09-22): the consumed-report cursor
 * moves in the reply path, after the loop, so an interrupted wait cannot mark
 * a report delivered that nobody ever saw.
 */
interface WorkerWaitObservation {
  kind: "question" | "report" | "gone" | "pending";
  question?: NonNullable<WorkerProjection["question"]>;
  report?: NonNullable<WorkerProjection["report"]>;
  /** Its pane is gone; `deliveredReportId` names the report already handed over, if any. */
  gone?: { closed: boolean; paneId?: string; deliveredReportId?: string };
}

async function waitWorker(
  deps: WorkerToolDeps,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolReply> {
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
  const seen = registry[workerId]?.reportedAt;

  // The two things a worker channel can carry, as replies — shared by the
  // probe below and by the last look taken before declaring it gone.
  // How this worker's pane READS right now — shared by every "nothing to hand
  // over" reply, and computed at reply time because liveness is a reading.
  const paneLine = (): string => {
    const entry = registry[workerId];
    if (!entry) return "它不在注册表里 —— 可能已经被 close 过。\n";
    if (entry.paneId === undefined) return "它的 pane 已经关过（登记还在，所以可以接着用）。\n";
    // "存活，但没有任何新消息" — the aliveness is a READING; "still working"
    // was an assertion this side cannot make (quality P2).
    return `pane ${entry.paneId}：${ownedPaneAlive(deps, entry) ? "存活，但没有任何新消息" : "已不在"}。\n`;
  };

  const abortedReply = (why: "signal" | "user-input", waitedMs: number): ToolReply =>
    reply(
      `review-gate: 等 worker ${workerId} 的调用被打断了（${
        why === "user-input" ? "有人在跟你说话" : "ESC"
      }，等了 ${Math.round(waitedMs / 1000)}s）——它还没有交给你的新消息。\n` +
      paneLine() +
      "**什么都没有被消费**：它已经写下的、以及之后才交的报告，下次 `worker_wait` 照样读得到。",
      { workerId, kind: "aborted", alive: ownedPaneAlive(deps, registry[workerId]), abortReason: why },
    );

  const questionReply = (q: NonNullable<WorkerProjection["question"]>): ToolReply =>
    reply(
      `review-gate: worker ${workerId} 在等你回答：\n\n${q.title}\n` +
      (q.options.length ? "\n" + q.options.map((o, i) => `  ${i + 1}. ${o}`).join("\n") : "") +
      (q.payload ? `\n\n${q.payload}` : "") +
      `\n\n用 \`worker_answer({workerId: "${workerId}", requestId: "${q.requestId}", answer: "…"})\` 回它。`,
      { workerId, requestId: q.requestId, kind: "question" },
    );
  const reportReply = (r: NonNullable<WorkerProjection["report"]>): ToolReply => {
    // THE CURSOR MOVES HERE AND NOWHERE ELSE (2026-09-22): only a report this
    // call actually HANDS OVER may be marked consumed. An interrupted wait
    // (ESC, or the user typing) returns without touching it, so the next
    // `worker_wait` still delivers whatever landed.
    const current = registry[workerId];
    if (current) deps.saveRegistry(withWorker(registry, { ...current, reportedAt: r.reportId }));
    return reply(
      `review-gate: worker ${workerId} 交活了：\n\n${r.text}`,
      { workerId, reportId: r.reportId, kind: "report" },
    );
  };

  const probe = async (): Promise<WorkerWaitObservation> => {
    const projection = readWorkerChannel(deps, registry, workerId);
    if (projection.question) return { kind: "question", question: projection.question };
    if (projection.report && projection.report.reportId !== seen) return { kind: "report", report: projection.report };
    // A WORKER THAT CANNOT SPEAK AGAIN IS NEWS TOO (reviewer P2, 2026-09-21):
    // `paneId === undefined` means its pane was CLOSED — nothing will ever
    // write to that channel again — and a dead pane means the same. The old
    // loop spent the whole 300-second timeout to report either, something it
    // had read on the very first iteration.
    const entry = registry[workerId];
    if (entry && !ownedPaneAlive(deps, entry)) {
      // …BUT NOT BEFORE ITS LAST WORDS HAVE HAD A MOMENT TO LAND (reviewer P1,
      // 2026-09-21). `worker_close` kills the pane, and a report the worker had
      // already written can reach the channel around the same moment.
      //
      // WHY THIS IS A WINDOW AND NOT A GUARANTEE, stated honestly: the only
      // writer left is a process that is being killed, so anything it wrote is
      // either already in the file or will never arrive — the residual
      // uncertainty is how long the kill takes to take effect, and no finite
      // wait can be "long enough" for an arbitrary one. What makes the report
      // safe is not this sleep, it is that NOTHING IS DISCARDED: the entry and
      // the channel both stay, so the next `worker_wait` reads whatever
      // landed after this one returned. The sleep just avoids the common case
      // of reporting "nothing" a few milliseconds before the answer arrives.
      await sleep(WORKER_WAIT_POLL_MS * 4);
      const after = readWorkerChannel(deps, registry, workerId);
      if (after.question) return { kind: "question", question: after.question };
      if (after.report && after.report.reportId !== seen) return { kind: "report", report: after.report };
      return {
        kind: "gone",
        gone: {
          closed: entry.paneId === undefined,
          // SAY WHICH KIND OF "NOTHING" THIS IS (reviewer P1, 2026-09-21): a
          // channel whose newest report was ALREADY handed over is a different
          // fact from one that never carried a report, and stepping over the
          // first silently reads as "it never said anything".
          ...(after.report === undefined ? {} : { deliveredReportId: after.report.reportId }),
          ...(entry.paneId === undefined ? {} : { paneId: entry.paneId }),
        },
      };
    }
    return { kind: "pending" };
  };

  // AN ALREADY-CANCELLED CALL DOES NOT EVEN LOOK. Probing first would be
  // harmless for reading, but it could DELIVER a report — and a report handed
  // to a call the host has already cancelled is a report nobody reads, with
  // its consumed-cursor moved. Returning here keeps the channel untouched.
  if (signal?.aborted) return abortedReply("signal", 0);

  // THE LOOP IS THE GATE'S OWN SKELETON (lib/poll-wait.ts, 2026-09-22). The
  // hand-written `for(;;) await sleep(500)` that used to live here ignored the
  // host's `signal` and had nobody watching for a user message, so a wait was
  // unreachable for its whole 300s budget — measured. `pollUntil` races both
  // interrupts against every probe and every sleep, exactly as `judge_wait`
  // and `orchestrator_wait` do.
  const waited = timeoutMs === 0
    // A ZERO BUDGET IS "look once", not "race a 0ms timer against the probe":
    // through pollUntil that race is winnable by the timer, and the snapshot
    // would come back as "not one probe finished".
    ? { observation: await probe(), aborted: false, waitedMs: 0, abortReason: undefined }
    : await pollUntil<WorkerWaitObservation>({
      probe,
      isDone: (o) => o.kind !== "pending",
      budgetMs: timeoutMs,
      pollMs: WORKER_WAIT_POLL_MS,
      now: deps.now,
      sleep,
      ...(signal === undefined ? {} : { signal }),
    });

  const observation = waited.observation;
  // DELIVERY BEATS THE INTERRUPT LABEL: a message that arrived in the same
  // tick the user spoke is still a message, and `pollUntil` reports `aborted`
  // from the end state regardless of what ended the loop.
  if (observation?.kind === "question") return questionReply(observation.question!);
  if (observation?.kind === "report") return reportReply(observation.report!);
  if (observation?.kind === "gone") {
    const gone = observation.gone!;
    return reply(
      `review-gate: worker ${workerId} ${gone.closed ? "的 pane 已经关掉了" : `的 pane（${gone.paneId}）已不在`}，` +
        (gone.deliveredReportId !== undefined
          ? `它最后那份报告（${gone.deliveredReportId}）本次已交付过 —— 没有更新的内容。\n`
          : "现在通道里没有新消息。\n") +
      "（如果它在被杀之前写过报告，那份仍在通道里：再 `worker_wait` 一次就能读到 —— 这里不会丢弃任何东西。）\n" +
      `接着用：\`worker_submit({ workerId: "${workerId}", task: … })\`（同一 session id 重开，它还记得上次读过的）；` +
      `不用了就 \`worker_close({ workerId: "${workerId}" })\`。`,
      { workerId, kind: "gone", alive: false, closed: gone.closed },
    );
  }

  if (waited.aborted) return abortedReply(waited.abortReason ?? "signal", waited.waitedMs);
  return reply(
    `review-gate: worker ${workerId} 还没有新消息（等了 ${Math.round(waited.waitedMs / 1000)}s）。\n` +
    paneLine() +
    `再等一次，或 \`worker_close({workerId: "${workerId}"})\` 收掉它。`,
    { workerId, kind: "timeout", alive: ownedPaneAlive(deps, registry[workerId]) },
  );
}

/** The only worker a `worker_wait` may default to: the one that is running. */
function onlineWorkerId(deps: WorkerToolDeps, registry: WorkerRegistry): string | undefined {
  const ids = Object.keys(registry);
  if (ids.length === 1) return ids[0];
  const live = ids.filter((id) => ownedPaneAlive(deps, registry[id]));
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
  // IDEMPOTENT FIRST (reviewer P2, 2026-09-21): a worker with no pane has
  // nothing to kill, so there is no mis-kill for the ownership check below to
  // prevent — and refusing the CALL here reported a failed close for a worker
  // that is already closed.
  if (entry.paneId === undefined) {
    return reply(`review-gate: worker ${workerId} 的 pane 已经关过了（登记还在，同一 id 可以接着用）。`, {
      workerId, closed: true, paneId: undefined,
    });
  }
  // FAIL-CLOSED OWNERSHIP (reviewer P1, 2026-09-21). A recorded server we
  // cannot RE-READ is not a licence to kill: an unreadable identity is missing
  // information, and after a tmux restart that pane id may belong to somebody
  // else's session entirely. Only an exact match proceeds.
  const tmuxServer = deps.tmuxServer?.();
  if (!paneIsOurs(entry, tmuxServer)) {
    return fail(
      `review-gate: 拒绝关闭 worker ${workerId} —— 它登记在 tmux server ${entry.tmuxServer}，` +
      `当前读到的是 ${tmuxServer ?? "读不到"}。那个 pane id 现在可能属于别的会话，关它就是误伤。` +
      "登记已保留，请人工确认后处理。",
      { workerId, closed: false },
    );
  }
  const closed = entry.windowId && entry.tmuxSession
    ? deps.closeWindow({ ownSession: entry.tmuxSession, windowId: entry.windowId })
    : undefined;
  const killed = closed?.ok === true;
  // “IT IS ALREADY GONE” IS NOT “TMUX REFUSED” (2026-09-25, quality round P2).
  // This path used to read the seam's boolean, so a worker whose window had
  // already been closed was reported as a FAILED close, kept its coordinates in
  // the registry forever (making the next dispatch open a second window beside
  // a ghost), and told the caller a window might still be on screen. The
  // reading is now the same one `orchestrator_close` uses
  // (lib/session-factory.ts `windowAlreadyGone`).
  const gone = closed !== undefined && !closed.ok && windowAlreadyGone(closed.error);
  // WHAT THIS CALL ACTUALLY KNOWS, said honestly (2026-09-25, quality round
  // P2). "已不在（视为关闭）" was one sentence for two different facts: tmux
  // REFUSED the close (the window may well still be on screen, and a caller
  // told it was closed stops looking), or the entry carried no window
  // coordinates at all (an older row — this tool has nothing to close and
  // cannot tell whether it is still open). Neither is "closed", so neither
  // claims it — but an ALREADY GONE window is, and saying otherwise was the bug.
  const closeNote = closed === undefined
    ? "登记里没有 window 坐标（可能已经关过，也可能是旧版本留下的）—— 它是否还开着无法确认，请人工确认后清理"
    : killed
      ? "已关闭"
      : gone
        ? "它的 window 已经不在了（视为已关闭）"
        : "关闭失败（tmux 拒绝）—— 那个 window 可能还开着";
  // THE ENTRY STAYS (reviewer P1, 2026-09-21). Closing a window releases
  // SCREEN SPACE, not the conversation: the channel owner, the session id and
  // the report cursor are exactly what a later `worker_submit` needs to resume
  // the same session. Dropping the entry meant a resume opened a NEW channel
  // under the current session's identity (the old reports unreachable) with the
  // consumed-report cursor reset (the newest one re-delivered).
  //
  // AND THE COORDINATES ONLY GO WHEN THE WINDOW REALLY WENT (reviewer P1,
  // round 1): a refused close or an entry that never carried coordinates leaves
  // the window possibly ON SCREEN, and a registry that no longer says where it
  // was makes the next `worker_submit` open a SECOND window beside it — a
  // duplicate worker and a leaked pane. Keeping them is what lets the next
  // close retry and say the same true thing again.
  if (killed || gone) {
    const { paneId: _closedPane, windowId: _closedWindow, tmuxSession: _closedSession, ...kept } = entry;
    deps.saveRegistry(withWorker(registry, kept));
  }
  return reply(
    `review-gate: worker ${workerId} 的 window ${entry.windowId ?? entry.paneId} ${closeNote}。\n` +
    "它的 transcript 留在磁盘上：再用同一个 `workerId` 派活会接着同一会话（`" + entry.sessionId + "`）。",
    { workerId, closed: killed || gone, paneId: entry.paneId },
  );
}
