/**
 * THE CHILD SIDE OF THE SUPERVISION CHANNEL — moved out of
 * `extensions/review-gate.ts` (t6, wave 2 of the split).
 *
 * A session spawned by an orchestrator reports on ONE file that belongs to
 * it alone, and reads its instructions from the same file. The agent in
 * this session knows nothing about any of it: everything below is done by
 * the gate, on pi's own events, which is the whole reason it can be
 * trusted. (The ORCHESTRATOR side is lib/orchestrator-supervisor.ts.)
 *
 * A session with no orchestration address has no binding at all and every
 * function here is a silent no-op — a standalone session reports nowhere.
 * The RULES stay in lib/orchestrator-child-channel.ts.
 */

import { watch as fsWatch, type FSWatcher } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { instructText, judgeChannelTarget, type ChannelIO } from "./channel-io.ts";
import type { ChildReportedState } from "./channel-records.ts";
import {
  acknowledgeInstruct,
  askThroughChannel,
  bindingPath,
  decideReportedChildState,
  pendingInstructions,
  reportState,
  type ChannelDialogOutcome,
  type ChannelDialogRequest,
  type ChildChannelBinding,
} from "./orchestrator-child-channel.ts";
import { supervisionTarget } from "./orchestration-id.ts";
import { isOwnedChildPane } from "./orchestrator-delivery.ts";
import {
  foldBackgroundWaits,
  hasBackgroundWaits,
  NO_BACKGROUND_WAITS,
  type BackgroundWaitEvent,
  type BackgroundWaits,
} from "./background-wait.ts";
import { deliverInterrupt } from "./interrupt-delivery.ts";
import { readWorkerSideEnv } from "./worker-side.ts";
import { readJudgeSideEnv } from "./judge-side.ts";
import { STATE_VARIANT_ENV } from "./gate-state-io.ts";
import { contextPercentOf } from "./session-handoff.ts";
import type { SessionHost } from "./session-host.ts";

/** What the child side needs from the session beyond the shared host. */
export interface ChildSideDeps {
  pi: Pick<ExtensionAPI, "sendUserMessage">;
  /** The channel file I/O the whole session shares. */
  channelIO: ChannelIO;
  /** The judge (or copilot wait) this session is blocked on, if any. */
  activeJudgeWait(): { role: string; since: number } | undefined;
  /** Is THIS session a judge pane? */
  isJudgePane(): boolean;
  /** A judge pane learns its round's range from the task text it is handed. */
  noteJudgeTaskText(text: string | undefined, roundSeq?: number): void;
}


export function createChildSide(host: SessionHost, deps: ChildSideDeps) {
  const { pi, channelIO, activeJudgeWait, isJudgePane, noteJudgeTaskText } = deps;

  /** This session's channel, or undefined when it is not somebody's child. */
  function childBinding(): ChildChannelBinding | undefined {
    const state = host.state();
    const orchestrationId = supervisionTarget();
    const childId = process.env[STATE_VARIANT_ENV]?.trim();
    if (orchestrationId && childId) {
      // Only the pane the gate itself opened may call itself this child. A
      // background subagent inherits the env vars but runs under a random pi
      // session id, not the deterministic rg-child-<childId> — the check is
      // in lib/orchestrator-delivery.ts (isOwnedChildPane) and it is what
      // keeps the subagent's gate from binding its parent's channel and
      // overwriting the parent's reports with idle heartbeats (2026-09-09).
      if (!isOwnedChildPane(childId, state.sessionId)) {
        return undefined;
      }
      const paneId = process.env.TMUX_PANE?.trim();
      return {
        io: channelIO,
        target: { orchestrationId, childId },
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        ...(paneId ? { paneId } : {}),
      };
    }
    // Judge panes talk through the SAME file shape under their opener id:
    // a judge pane is a child process with a gate, not a second channel.
    // (Heartbeat, dialog race and round-task drain all funnel through this
    // binding, so they work for judges with no further wiring.)
    //
    // A WORKER PANE JOINS THE SAME LIST (2026-09-21), and this one branch is
    // the whole of its channel story: `ask_user` inside the worker reaches the
    // opener through the dialog race, and `worker_submit`'s message to a live
    // worker is injected by the child-side drain — both without a line of
    // worker-specific transport.
    const workerSide = readWorkerSideEnv(process.env);
    if (workerSide) {
      return {
        io: channelIO,
        target: { orchestrationId: workerSide.openerId, childId: `worker-${workerSide.workerId}` },
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      };
    }
    const judgeSide = readJudgeSideEnv(process.env);
    if (!judgeSide) return undefined;
    return {
      io: channelIO,
      target: judgeChannelTarget(judgeSide.openerId, judgeSide.judgeId),
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    };
  }

  /**
   * Tell the orchestration what this session is doing.
   *
   * Called from `agent_settled`, `turn_end` AND the independent heartbeat
   * timer — pi's own truth, never a heuristic about a terminal.
   * `ctx.isIdle()` separates "still streaming" from "stopped", and the gate's
   * own completion record separates "stopped" from "finished": a child that
   * ran `declare_done` is `done`, and one that merely went quiet is `idle`.
   * That distinction is the entire fix for R3-5, where a finished child was
   * classified `working` and produced no event for 725 seconds.
   *
   * ── WAITING-JUDGE (round-4 P0) ──
   *
   * A judge round of its own outranks both `working` and `idle`, and it has
   * to, because BOTH readings were wrong while one was running: streaming
   * inside `judge_wait` reported `working` while the heartbeat died with it
   * (⇒ `stalled` ⇒ an `interrupt` suggestion aimed at a live review round),
   * and a child that dispatched a judge and settled reported `idle` — "it
   * stopped" — about a session doing exactly what it should. The gate knows
   * which judge and since when, so it says so.
   *
   * THROTTLED, because the heartbeat calls it every tick: a record is written
   * when the state CHANGES or when the last one is old enough to be worth
   * refreshing. Without that the channel would grow a line every few seconds
   * for no new information — and `lastStateSince` (how long a state has held)
   * is computed from an unbroken run of identical states, so re-reporting is
   * cheap but not free.
   */
  function reportChildState(
    ctx: ExtensionContext,
    note?: string,
    opts: { force?: boolean; state?: ChildReportedState } = {},
  ): void {
    const binding = childBinding();
    if (!binding) return;
    const streaming = ctx.isIdle?.() === false || ctx.hasPendingMessages?.() === true;
    const percent = contextPercentOf(ctx as unknown as { getContextUsage?: () => unknown });
    const judging = activeJudgeWait();
    // Waiting on a background agent the child itself spawned is work, not a
    // stop (lib/background-wait.ts): without it, a child whose turn ended
    // while its subagent ran reported `idle` and the orchestrator read
    // "停下了（没有 declare_done）" for a wait it started itself.
    const waitingOnBackground = hasBackgroundWaits(backgroundWaits);
    const reported = decideReportedChildState({
      forced: opts.state,
      judging: judging !== undefined,
      streaming,
      waitingOnBackground,
      completedAt: host.state().completion?.at,
    });
    const now = Date.now();
    const changed = reported !== lastReportedChildState || lastToolActivity !== lastReportedActivity;
    if (!opts.force && !changed && now - lastChildReportAt < CHILD_STATE_REFRESH_MS) return;
    lastReportedChildState = reported;
    lastReportedActivity = lastToolActivity;
    lastChildReportAt = now;
    const settledSince = lastSettledAt !== undefined && toolCallsSinceSettle === 0 ? lastSettledAt : undefined;
    reportState(
      binding,
      reported,
      {
        ...(percent === undefined ? {} : { contextPercent: Math.round(percent) }),
        ...(judging ? { waitingFor: judging.role } : {}),
        ...(note === undefined ? {} : { note }),
        // E — the progress stamp rides on EVERY report (heartbeat included), so
        // a `working` child re-reported on a timer keeps its last real-progress
        // time. It only advances on a genuine agent event (see noteChildProgress).
        ...(lastChildProgressAt === undefined ? {} : { lastProgressAt: new Date(lastChildProgressAt).toISOString() }),
        // …and the STRUCTURAL half: present only while the child's last turn
        // has ENDED and nothing has run since (user decision, 2026-09-10).
        // A supervisor may act on `idle` the moment it sees this, without
        // waiting out the confirmation window.
        ...(settledSince === undefined ? {} : { settledSince }),
        // WHAT it is doing, for a manager that has only the state word to go on
        // (2026-09-17, user decision): `working · 自上次推进 3200s` cannot tell
        // "reading a large tree" from "spinning on the same search".
        ...(lastToolActivity === undefined ? {} : { activity: lastToolActivity }),
      },
    );
  }

  /** How often the heartbeat ticks (drain + a state refresh when it is due). */
  const CHILD_HEARTBEAT_MS = 10_000;
  /** How stale an unchanged state report may get before it is rewritten. */
  const CHILD_STATE_REFRESH_MS = 60_000;
  let childHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * The fast path for incoming instructions: a watch on this child's OWN
   * channel file (see {@link watchOwnChannel}).
   */
  let childChannelWatcher: FSWatcher | undefined;
  /** True while a drain is mid-flight — the re-entrancy guard. */
  let drainingInstructions = false;
  /**
   * The child-side interrupt source: an instruct (interrupt/steer) fires it
   * to dismiss an OPEN dialog as INTERRUPTED before the message is injected.
   * Wired into askThroughChannel's `interruptSignal`, so the box comes down
   * and the waiting request settles by:"interrupted" — never read as a user
   * rejection, never as consent.
   */
  let gateInterruptController: AbortController = new AbortController();
  /**
   * The signal a dialog currently open listens to for an instruct interrupt.
   * Every dialog gets the CURRENT controller's signal; drain aborts that
   * controller and installs a fresh one, so one interrupt dismisses the dialog
   * open AT THAT MOMENT and never a later one.
   */
  function currentInterruptSignal(): AbortSignal {
    return gateInterruptController.signal;
  }
  let lastChildReportAt = 0;
  let lastReportedChildState: ChildReportedState | undefined;
  /**
   * The activity line last written to the channel.
   *
   * Tracked so a NEW tool call republishes the state at once instead of
   * waiting out `CHILD_STATE_REFRESH_MS` — a receipt that says "working · 最近
   * read(x)" while the child has been running `make test` for a minute is
   * exactly the staleness this field exists to remove.
   */
  let lastReportedActivity: string | undefined;
  /**
   * Epoch ms of the child's last FORWARD PROGRESS (E). Advanced ONLY by a real
   * agent event — a tool result or a turn boundary — never by the heartbeat, so
   * a `working` child that keeps turning the crank shows a small "no progress"
   * reading while one wedged in place shows a growing one. Undefined until the
   * first event, so a booting session is not reported as stuck.
   */
  let lastChildProgressAt: number | undefined;
  /** Stamp forward progress. Called from the agent-event handlers, not the heartbeat. */
  function noteChildProgress(kind: "tool" | "settled" = "tool"): void {
    if (!childBinding()) return;
    lastChildProgressAt = Date.now();
    if (kind === "settled") {
      lastSettledAt = new Date(lastChildProgressAt).toISOString();
      toolCallsSinceSettle = 0;
      return;
    }
    // A tool result (or a turn boundary that may still be followed by more
    // work) means the child is AT WORK: whatever settle we were holding is no
    // longer its current state, and the stamp is dropped.
    toolCallsSinceSettle += 1;
    lastSettledAt = undefined;
  }

  /**
   * THE CHILD'S OWN "I STOPPED" EVIDENCE (2026-09-10, user decision).
   *
   * `agent_settled` is the one event that says a turn is OVER rather than
   * paused — pi will not continue on its own — and anything that runs after it
   * (a tool result, the next turn's boundary) is work RESUMED, which clears
   * the stamp. The pair is what the supervisor reads as `settledSince`, and it
   * is why `idle` no longer has to be confirmed by a 120s silence window:
   * "settled with nothing run since" cannot be true in the middle of a
   * bash → read → bash investigation, which is exactly the measurement that
   * window was introduced for (2026-09-04).
   */
  let lastSettledAt: string | undefined;
  let toolCallsSinceSettle = 0;
  /**
   * Background agents this session spawned that have not reported a terminal
   * state yet (lib/background-wait.ts owns the start/end contract). While
   * non-empty the child reports `working` even when its own turn has ended —
   * waiting on its own subagent is work, not a stop.
   */
  let backgroundWaits: BackgroundWaits = NO_BACKGROUND_WAITS;
  /**
   * The most recent tool call this session made, rendered for the receipt.
   *
   * WHY IT RIDES ON `tool_call` AND NOT `tool_result`: the question the
   * manager is asking is "what is it doing RIGHT NOW", and the call is placed
   * before the work starts — the result can be minutes later, and a child
   * whose tool has been running for ten minutes should read as "running
   * `bash(make test)`", not as the last thing that already finished.
   * (lib/orchestrator-child-channel.ts `describeToolActivity` renders it.)
   */
  let lastToolActivity: string | undefined;
  /** Record the tool call just placed (see `lastToolActivity`). */
  function noteToolActivity(activity: string | undefined): void { lastToolActivity = activity; }
  /** Fold one background-agent event into the wait set; true when it CHANGED. */
  function foldBackgroundWait(event: BackgroundWaitEvent): boolean {
    const next = foldBackgroundWaits(backgroundWaits, event);
    if (next === backgroundWaits) return false;
    backgroundWaits = next;
    return true;
  }
  /** Feed one tool result into the background-wait fold (see the module). */
  function observeBackgroundToolResult(event: {
    toolName: string;
    isError: boolean;
    content: readonly { type?: string; text?: string }[];
    input?: Record<string, unknown>;
  }): void {
    const text = event.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    // pi-subagents' `run_in_background` defaults to true; only an explicit
    // false is a foreground call, whose result can never start a wait.
    const raw = event.input?.run_in_background;
    const runInBackground = raw === true ? true : raw === false ? false : undefined;
    backgroundWaits = foldBackgroundWaits(backgroundWaits, {
      kind: "tool_result",
      tool: { toolName: event.toolName, isError: event.isError === true, text, runInBackground },
    });
  }
  /**
   * Instructions this session has already acknowledged as RECEIVED.
   *
   * In memory rather than derived from the channel because the receipt is
   * written once per instruction: the projection deliberately keeps an
   * instruction pending until it is INJECTED, so re-reading it would make the
   * heartbeat append a duplicate `received` on every tick.
   */
  const acknowledgedReceipts = new Set<string>();


  /**
   * THE HEARTBEAT — an independent timer, and the whole point is what it does
   * NOT depend on.
   *
   * Reporting used to ride on `agent_settled` and `turn_end`, which are AGENT
   * events: they do not fire during a `judge_wait`, a full precommit, or any
   * long tool call, because all of those happen inside one turn. So the
   * channel went silent for minutes at a time while the process was perfectly
   * healthy, the supervisor's 180-second budget expired, and a working child
   * was reported as lost — twice in one run, ~14 minutes, with `interrupt`
   * offered as the remedy (round-4 P0, the one defect where following the
   * gate's own advice made things worse).
   *
   * A timer owned by the extension cannot have that failure mode: it ticks
   * while the agent is blocked, so `stalled` goes back to meaning what it
   * says — the extension itself is gone.
   *
   * It also drains instructions, which is what makes `followUp` deliverable
   * to a BUSY child: the orchestrator's message is acknowledged within one
   * tick instead of waiting for the agent to settle (round-4 P1 — a message
   * that was written, never acknowledged, and silently lost).
   */
  function startChildHeartbeat(ctx: ExtensionContext): void {
    if (childHeartbeatTimer || !childBinding()) return;
    childHeartbeatTimer = setInterval(() => {
      const live = host.ctx() ?? ctx;
      try {
        reportChildState(live);
      } catch { /* a heartbeat must never break the session it reports on */ }
      void drainChildInstructions(live).catch(() => { /* best effort */ });
      // Self-heal: the channel file may not have existed when this session
      // started, and a watcher that could not be installed then can be now.
      watchOwnChannel(live);
    }, CHILD_HEARTBEAT_MS);
    watchOwnChannel(ctx);
  }

  /**
   * DRAIN ON WRITE, NOT ON THE NEXT TICK (2026-09-10).
   *
   * MEASURED (this repo's own channels): an `orchestrator_instruct` reached
   * its child in p50 4.79s / p90 9.11s, because the ONLY thing that read a
   * child's channel was the 10s heartbeat — a message written just after a
   * tick waited almost a whole interval. That latency sits on the one path
   * the orchestrator uses to talk to its children, and it is pure waiting:
   * the orchestrator has already written the file by the time this fires.
   *
   * THE TICK STAYS, and not out of tradition: a watcher may fail to install
   * (no channel file yet), may miss (a file REPLACED rather than appended to
   * leaves the watch on a dead inode), and is not available everywhere. The
   * 10s tick is what makes every one of those harmless, and the re-entrancy
   * guard in `drainChildInstructions` what makes a watcher firing beside it
   * safe. The watcher is the fast path, never the only path.
   */
  function watchOwnChannel(ctx: ExtensionContext): void {
    if (childChannelWatcher) return;
    const binding = childBinding();
    if (!binding) return;
    let path: string;
    try { path = bindingPath(binding); } catch { return; }
    try {
      const watcher = fsWatch(path, () => {
        void drainChildInstructions(host.ctx() ?? ctx).catch(() => { /* best effort */ });
      });
      // A watcher must never be the reason the process stays alive, and a
      // watcher that errors is dropped so the next tick reinstalls it.
      watcher.unref?.();
      watcher.on("error", () => { stopChildChannelWatcher(); });
      childChannelWatcher = watcher;
    } catch { /* no file yet, or no watch support ⇒ the tick still covers it */ }
  }

  function stopChildChannelWatcher(): void {
    if (childChannelWatcher) {
      try { childChannelWatcher.close(); } catch { /* already gone */ }
    }
    childChannelWatcher = undefined;
  }

  function stopChildHeartbeat(): void {
    if (childHeartbeatTimer) clearInterval(childHeartbeatTimer);
    childHeartbeatTimer = undefined;
    stopChildChannelWatcher();
  }

  /**
   * Apply whatever the orchestrator has sent, through pi's OWN delivery API.
   *
   * `steer` / `followUp` are `sendUserMessage`'s own modes and `interrupt` is
   * `ctx.abort()`; nothing is typed at a terminal, so nothing can be
   * truncated, split by a newline, or read by an open dialog as a menu
   * selection. Every one of those was measured on the `send-keys` path this
   * replaces (F7, F8, R-20, R-13).
   *
   * The acknowledgement is what the orchestrator's receipt is built on, so it
   * is written from what ACTUALLY happened — a failure is acknowledged as a
   * failure, never omitted.
   */
  async function drainChildInstructions(ctx: ExtensionContext): Promise<void> {
    const binding = childBinding();
    if (!binding) return;
    // RE-ENTRANCY GUARD: the heartbeat and agent_settled both drain; an
    // `await pi.sendUserMessage()` inside one drain would let the OTHER fire
    // while the first is still mid-flight, and the instruction would be
    // injected twice (round-4: a message that was written, never acknowledged,
    // and silently lost — the inverse: acknowledged twice, then acted on twice).
    if (drainingInstructions) return;
    drainingInstructions = true;
    try {
      await drainInstructionsInner(binding, ctx);
    } finally {
      drainingInstructions = false;
    }
  }

  async function drainInstructionsInner(binding: ChildChannelBinding, ctx: ExtensionContext): Promise<void> {
    for (const instruction of pendingInstructions(binding)) {
      // STAGE ONE — "I have it". Written BEFORE anything is attempted, and
      // exactly once per instruction, because it answers a different question
      // than the injection does: it proves this child's gate is alive and has
      // the message. That is the only honest bar for a `followUp`, whose whole
      // definition is "read this when you are done" — demanding an injection
      // from a busy child made the orchestrator's tool fail on a message that
      // had in fact arrived, and the message was then dropped (round-4 P1).
      if (!acknowledgedReceipts.has(instruction.instructId)) {
        acknowledgedReceipts.add(instruction.instructId);
        acknowledgeInstruct(
          binding,
          instruction.instructId,
          true,
          `已入队（mode=${instruction.mode}）`,
          "received",
        );
      }
      try {
        if (instruction.mode === "interrupt") {
          // Highest priority (2026-08-31): abort the current turn AND carry
          // the new message, so the child stops what it was doing and reads
          // this immediately. A bare interrupt (no text) stays a plain abort.
          const interruptText = instructText(channelIO, instruction);
          // Same as the steer/followUp path below: a round delivered as an
          // interrupt still carries the range the observer records against.
          if (isJudgePane()) noteJudgeTaskText(interruptText, instruction.roundSeq);
          // STOP-FIRST (user decision 2026-09-01): any OPEN dialog is
          // dismissed as INTERRUPTED before the message is injected — a
          // goal box, a question, a consent. The controller is swapped so
          // the NEXT dialog starts clean; the abort below additionally
          // stops the current turn if one is running.
          gateInterruptController.abort();
          gateInterruptController = new AbortController();
          if (interruptText) {
            // STOP FIRST, THEN SPEAK — AND WAIT FOR THE STOP TO LAND
            // (2026-09-21). `ctx.abort()` is SYNCHRONOUS on this side and does
            // not wait for the turn to end, so handing the text to pi while the
            // agent was still streaming queued it as `steer` — and the abort's
            // own end-of-run skipped the drain those queued messages wait for.
            // Measured: two judges of one round froze for 552s with the
            // dispatch sitting unread, and the same drain serves orchestration
            // children. lib/interrupt-delivery.ts owns the contract; this is
            // only the pi surface.
            const delivered = await deliverInterrupt(interruptText, {
              abort: () => ctx.abort?.(),
              isIdle: () => ctx.isIdle?.() === true,
              // NO `deliverAs`: by pi's own contract that is the form which
              // "sends immediately and triggers a new turn".
              sendNow: (text) => pi.sendUserMessage(text),
            });
            // A DEFERRED DELIVERY IS NOT AN INJECTION (2026-09-21): the text is
            // still in the channel, and the next drain retries it. Acknowledging
            // it as `injected` is how the opener was told "delivered" about a
            // message nobody had read — the ack says which stage was ACTUALLY
            // reached, which is the whole point of the two-stage handshake.
            acknowledgeInstruct(
              binding,
              instruction.instructId,
              true,
              delivered.delivered === "turn"
                ? `已中止当前 turn，等 pane 空闲（${delivered.waitedMs}ms）后作为新一轮投递`
                : `pane 仍在忙（已等 ${delivered.waitedMs}ms）—— 正文留在通道里，下一次 drain 再投`,
              delivered.delivered === "turn" ? "injected" : "received",
            );
          } else {
            ctx.abort?.();
            acknowledgeInstruct(binding, instruction.instructId, true, "已调用 ctx.abort()", "injected");
          }
          continue;
        }
        const text = instructText(channelIO, instruction);
        // A judge pane's instructions ARE its rounds: the next round's task
        // text is where its `baseline..HEAD` is written, so the inspection
        // observer learns the range from the same message the judge reads.
        if (isJudgePane()) noteJudgeTaskText(text, instruction.roundSeq);
        if (!text) {
          acknowledgeInstruct(
            binding,
            instruction.instructId,
            false,
            "指令没有正文（也没有可读的溢出文件）",
            "injected",
          );
          continue;
        }
        // STOP-FIRST for steer too: it cuts INTO the current turn, so an
        // open dialog (goal box / question / consent) must come down first —
        // otherwise the message is injected while the child stays wedged on
        // the box (the measured deadlock). followUp is the one mode that
        // does NOT stop: its whole meaning is "read this when you are done".
        if (instruction.mode === "steer") {
          gateInterruptController.abort();
          gateInterruptController = new AbortController();
        }
        pi.sendUserMessage(text, { deliverAs: instruction.mode });
        acknowledgeInstruct(
          binding,
          instruction.instructId,
          true,
          instruction.mode === "steer"
            ? `已解除等待并投递 (deliverAs:${instruction.mode})`
            : `pi.sendUserMessage(deliverAs:${instruction.mode})`,
          "injected",
        );
      } catch (error) {
        acknowledgeInstruct(binding, instruction.instructId, false, (error as Error).message, "injected");

      }
    }
  }

  /**
   * Raise a gate dialog that EITHER the human or the orchestrator may answer.
   *
   * This is the single funnel every gate question goes through, and it is why
   * the orchestrator never needs to read a screen: the request — title, every
   * option in order, and the full payload (a goal draft, a plan) — is written
   * into the channel as data. Whoever answers first wins; the other side is
   * cancelled, so a box the orchestrator answered DISAPPEARS from the user's
   * screen instead of asking a question that is already settled.
   *
   * A session with no orchestration simply renders the dialog, exactly as it
   * always did.
   */
  async function askEitherSide(
    request: Omit<ChannelDialogRequest, "hasUI">,
    hasUI: boolean,
    render: (signal: AbortSignal) => Promise<string | undefined>,
  ): Promise<ChannelDialogOutcome> {
    const binding = childBinding();
    if (!binding) {
      const answer = hasUI ? await render(new AbortController().signal) : undefined;
      return { answer, by: "human", requestId: "" };
    }
    // The dialog listens to the gate's interrupt source as well as its own
    // abort: an instruct fired while it is open dismisses it as INTERRUPTED
    // so the child can process the message instead of staying wedged on the box.
    return askThroughChannel(binding, { ...request, hasUI }, render, currentInterruptSignal());
  }

  return {
    childBinding,
    reportChildState,
    noteChildProgress,
    noteToolActivity,
    foldBackgroundWait,
    observeBackgroundToolResult,
    startChildHeartbeat,
    stopChildHeartbeat,
    drainChildInstructions,
    askEitherSide,
  };
}
