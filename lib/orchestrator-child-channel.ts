/**
 * THE CHILD SIDE of the channel — reporting, and the two-answer race.
 *
 * The child's agent knows nothing about any of this. Everything here is done
 * BY THE GATE inside the child process, which is the whole reason the design
 * works: the gate is already the thing that raises every dialog, already
 * receives `agent_settled`, and already has `ctx.isIdle()`. It never had to
 * ask a terminal what it was doing — it simply never wrote it down.
 *
 * ── THE RACE (the piece that replaces keyboard simulation) ──
 *
 * A question is answerable by TWO parties at once: the human sitting in the
 * pane, and the orchestrator through the channel. Both are legitimate, and
 * neither can be made to wait for the other. So the dialog is raised with an
 * `AbortSignal` and a channel watcher runs beside it:
 *
 *   - the orchestrator answers first ⇒ the watcher aborts the signal and the
 *     dialog DISAPPEARS from the user's screen, because a box asking a
 *     question that is already settled is worse than no box at all;
 *   - the human answers first ⇒ the watcher is cancelled and a settle record
 *     goes into the channel, so the orchestrator's own wait ends instead of
 *     hanging on a request nobody will ever answer again.
 *
 * The dialog STAYS UP for as long as nobody has answered. That is deliberate
 * and it is the whole fallback story: if the orchestrator dies, crashes, or
 * is killed by accident, the child is not stranded — a human can attach to
 * the pane and answer. Which is exactly why there is NO TIMEOUT anywhere in
 * this file. A timeout would convert "nobody is watching right now" into a
 * permanent wrong answer.
 *
 * ── WHY ESC SETTLES ──
 *
 * A dismissal is the human answering "nothing", and it settles the request.
 * The alternative — keep waiting for the orchestrator after the human waved
 * the box away — leaves the orchestrator blocked on a question that is no
 * longer on anybody's screen. The one case where the human side must NOT
 * settle is a child with no UI at all (headless): there the dialog resolves
 * `undefined` instantly, which is not a person deciding anything, so the
 * channel side runs alone.
 *
 * Pure-ish: IO through {@link ChannelIO}, the dialog through an injected
 * callback, sleeping through an injected timer. The protocol tests drive this
 * exact code with none of the three being real.
 */

import {
  appendRecord,
  newChannelId,
  projectChannel,
  readChannel,
  channelPathFor,
  type ChannelIO,
  type ChannelInstructRecord,
  type ChannelRequestRecord,
  type ChannelTarget,
  type ChildReportedState,
  type InstructAckStage,

} from "./orchestrator-channel.ts";

/** How often the channel is re-read while a question is outstanding. */
export const ANSWER_POLL_MS = 750;

/** Everything the child side needs to talk on its channel. */
export interface ChildChannelBinding {
  io: ChannelIO;
  target: ChannelTarget;
  /** The child's own pi session id — what a recovery re-opens. */
  sessionId?: string;
  /** Injected timer, so tests advance time instead of spending it. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
}

/** The channel file this binding reads and writes. */
export function bindingPath(binding: ChildChannelBinding): string {
  return channelPathFor(binding.target.orchestrationId, binding.target.childId, binding.target.home);
}

function stamp(io: ChannelIO): string {
  return new Date(io.now()).toISOString();
}

/**
 * Report what this child is doing. Called by the gate's own event handlers,
 * never by the agent.
 */
export function reportState(
  binding: ChildChannelBinding,
  state: ChildReportedState,
  extra: { contextPercent?: number; dialogTitle?: string; note?: string; waitingFor?: string; lastProgressAt?: string } = {},
): void {
  try {
    appendRecord(binding.io, binding.target, {
      kind: "state",
      from: "child",
      at: stamp(binding.io),
      state,
      sessionId: binding.sessionId,
      ...extra,
    });
  } catch {
    /* reporting is never allowed to break the child's own work */
  }
}

/** One question, as the orchestrator will see it. */
export interface ChannelDialogRequest {
  dialogKind: "select" | "confirm" | "input";
  /** Which gate dialog this is; `goal-approval` carries constraint 8. */
  topic?: ChannelRequestRecord["topic"];
  title: string;
  /** The rows offered, in order. Empty for a free-text input. */
  options: string[];
  /** The full text behind the question (a goal draft, a plan…), when there is one. */
  payload?: string;
  /** Is there a real UI to render into? `false` ⇒ the channel answers alone. */
  hasUI: boolean;
}

/** Who ended a question, and with what. */
export interface ChannelDialogOutcome {
  answer: string | undefined;
  by: "human" | "orchestrator" | "dismissed" | "interrupted";
  requestId: string;
  /** The orchestrator's decline reason (goal rejection), when one was given. */
  reason?: string;
}

/** Raise the dialog. Must honour `signal` by resolving `undefined` when aborted. */
export type DialogRenderer = (signal: AbortSignal) => Promise<string | undefined>;

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/**
 * Ask a question that EITHER the human or the orchestrator may answer.
 *
 * Returns as soon as one of them does, and records in the channel which one
 * it was — the settle record is what releases the other side.
 */
export async function askThroughChannel(
  binding: ChildChannelBinding,
  request: ChannelDialogRequest,
  render: DialogRenderer,
  /** An external "stop" (an instruct interrupt). When it fires, the dialog is
   * dismissed as INTERRUPTED — not as a human "dismissed", because a stopped
   * goal approval must never read as a user rejection. */
  interruptSignal?: AbortSignal,
): Promise<ChannelDialogOutcome> {
  const requestId = newChannelId("req", binding.io.now());
  appendRecord(binding.io, binding.target, {
    kind: "request",
    from: "child",
    at: stamp(binding.io),
    requestId,
    dialogKind: request.dialogKind,
    ...(request.topic === undefined ? {} : { topic: request.topic }),
    title: request.title,
    options: request.options,
    ...(request.payload === undefined ? {} : { payload: request.payload }),
  });
  reportState(binding, "waiting-input", { dialogTitle: request.title });

  const dialogAbort = new AbortController();
  const pollAbort = new AbortController();
  let decided = false;
  let settle!: (outcome: ChannelDialogOutcome) => void;
  const decision = new Promise<ChannelDialogOutcome>((resolve) => { settle = resolve; });
  const finish = (answer: string | undefined, by: ChannelDialogOutcome["by"], reason?: string): void => {
    if (decided) return;
    decided = true;
    settle({ answer, by, requestId, ...(reason === undefined ? {} : { reason }) });
  };

  const channelSide = watchForAnswer(binding, requestId, pollAbort.signal).then((got) => {
    if (got.answer === undefined || decided) return;
    // The orchestrator got there first: take the box off the human's screen.
    dialogAbort.abort();
    finish(got.answer, "orchestrator", got.reason);
  });

  const humanSide = (request.hasUI
    ? render(dialogAbort.signal).catch(() => undefined)
    : Promise.resolve<string | undefined>(undefined)
  ).then((answer) => {
    if (decided) return;
    if (answer !== undefined) {
      pollAbort.abort();
      finish(answer, "human");
      return;
    }
    // No UI at all is NOT a person dismissing anything — let the channel run.
    if (!request.hasUI) return;
    pollAbort.abort();
    finish(undefined, "dismissed");
  });

  // An external interrupt (an instruct) dismisses the box as INTERRUPTED.
  // Distinct from a human "dismissed": a stopped goal approval must not read
  // as a rejection, and a stopped consent stays fail-closed.
  const interruptSide = interruptSignal === undefined
    ? Promise.resolve<string | undefined>(undefined)
    : new Promise<string | undefined>((resolve) => {
        if (interruptSignal.aborted) { resolve(undefined); return; }
        const onAbort = () => { dialogAbort.abort(); finish(undefined, "interrupted"); resolve(undefined); };
        interruptSignal.addEventListener("abort", onAbort, { once: true });
        // Whatever settles the dialog first (human / orchestrator / interrupt),
        // the interrupt side resolves — a dangling promise would hang the
        // allSettled that awaits it.
        decision.then(() => { interruptSignal.removeEventListener("abort", onAbort); resolve(undefined); });
      })
    .then(() => undefined);

  const outcome = await decision;
  pollAbort.abort();
  dialogAbort.abort();
  // Both sides are settled or cancelled by now; awaiting them keeps the
  // renderer's own cleanup inside this call rather than after it returns.
  await Promise.allSettled([channelSide, humanSide, interruptSide]);

  appendRecord(binding.io, binding.target, {
    kind: "request-settled",
    from: "child",
    at: stamp(binding.io),
    requestId,
    by: outcome.by,
    ...(outcome.answer === undefined ? {} : { answer: outcome.answer }),
  });
  return outcome;
}

/**
 * Poll the channel until an answer for `requestId` appears, or the wait is
 * cancelled. Resolves `undefined` on cancellation — never on a timeout,
 * because there is none.
 */
async function watchForAnswer(
  binding: ChildChannelBinding,
  requestId: string,
  signal: AbortSignal,
): Promise<{ answer: string | undefined; reason?: string }> {
  const sleep = binding.sleep ?? defaultSleep;
  const interval = binding.pollMs ?? ANSWER_POLL_MS;
  const path = bindingPath(binding);
  let cursor = 0;
  while (!signal.aborted) {
    let read;
    try {
      read = readChannel(binding.io, path, cursor);
    } catch {
      read = undefined;
    }
    if (read) {
      cursor = read.cursor;
      for (const record of read.records) {
        if (record.kind === "answer" && record.requestId === requestId) {
          return { answer: record.answer, reason: record.reason };
        }
      }
    }
    await sleep(interval, signal);
  }
  return { answer: undefined };
}

/**
 * Instructions the orchestrator has sent that this child has not applied yet.
 *
 * Read-only: applying them (a `sendUserMessage`, an `abort()`) is the
 * extension's job, and {@link acknowledgeInstruct} is how it reports back.
 */
export function pendingInstructions(binding: ChildChannelBinding): ChannelInstructRecord[] {
  try {
    const read = readChannel(binding.io, bindingPath(binding));
    return projectChannel(read.records).pendingInstructs;
  } catch {
    return [];
  }
}

/** Say whether an instruction was actually applied. Never claim it blindly. */
export function acknowledgeInstruct(
  binding: ChildChannelBinding,
  instructId: string,
  delivered: boolean,
  detail?: string,
  /**
   * `received` = the gate has the instruction and queued it; `injected` = pi
   * has taken it. Defaults to `injected` so the old single-stage meaning is
   * preserved for any caller that does not care about the distinction.
   */
  stage: InstructAckStage = "injected",
): void {
  try {
    appendRecord(binding.io, binding.target, {
      kind: "instruct-ack",
      from: "child",
      at: stamp(binding.io),
      instructId,
      delivered,
      stage,
      ...(detail === undefined ? {} : { detail }),
    });
  } catch {
    /* best effort */
  }
}

