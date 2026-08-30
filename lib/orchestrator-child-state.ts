/**
 * WHAT IS THAT CHILD DOING RIGHT NOW — answered from structured truth only.
 *
 * ── WHY THIS FILE WAS REWRITTEN (2026-08-30) ──
 *
 * It used to answer the question by looking at a terminal: an integer count
 * of "busy-looking" words in the last few rendered lines, a normalized screen
 * fingerprint, a footer-anchored dialog parse. Three end-to-end runs produced
 * 40+ defects and roughly two thirds of them trace to that one decision —
 * `Working` in the scrollback matching forever (R3-5: a finished child sat
 * silent for 725 seconds and only a suspicious human noticed), a status bar
 * read as a menu row (R-1), a wrapped option lost (R-12), a title taken from
 * the wrong line (R3-4).
 *
 * None of that information had to be guessed. The gate runs INSIDE the child.
 * It is the code that raises every dialog, it receives `agent_settled`, and
 * `ctx.isIdle()` is a function call away. So the child now REPORTS
 * (lib/orchestrator-child-channel.ts) and this module reads the report. The
 * screen is not consulted at all, in any state, ever.
 *
 * ── THE ONE THING STILL MEASURED FROM OUTSIDE ──
 *
 * `dead`. A corpse files no report, so pane existence is the only honest
 * source, and it is taken from `list-panes` (an enumeration) rather than from
 * anything rendered. `paneAlive === undefined` means tmux could not be read,
 * which is deliberately NOT `false`: an unreadable pane list once made a live
 * child look dead (F14), and a wrong death ends supervision.
 *
 * ── AND THE ONE THAT CANNOT BE REPORTED ──
 *
 * `stalled`. A child whose extension crashed or whose process wedged cannot
 * say so. It is inferred from the absence of a heartbeat while the pane is
 * still there — the complement of `dead`, and the reason the child reports on
 * a schedule rather than only when something happens.
 *
 * Pure module: observations in, a state out. No tmux, no filesystem, no clock
 * of its own.
 */

import {
  isStalled,
  type ChannelProjection,
  HEARTBEAT_STALE_MS,
} from "./orchestrator-channel.ts";

/** The seven states a registered child can be in. */
export type ChildState =
  /** Its own report says it is streaming, or it has work in flight. */
  | "working"
  /** A dialog is open and unanswered — the request is IN the channel. */
  | "waiting-input"
  /**
   * Blocked on something THE GATE ITSELF started — a judge round, a full
   * precommit. Healthy, expected, and nothing for a supervisor to do.
   *
   * It exists because the alternative was measured (round-4 P0): the child
   * fell silent inside `judge_wait`, the silence was read as `stalled`, and
   * the receipt's own advice (`interrupt` / `close`) would have cut a running
   * review round in half. Naming the wait is what makes the difference
   * between "nobody is home" and "waiting for the reviewer, 220s in".
   */
  | "waiting-judge"
  /** It reported its task complete. */
  | "done"
  /** Alive and reporting, but not working and not asking — it stopped. */
  | "idle"
  /** Its pane is gone. */
  | "dead"
  /** Pane alive, but nothing has been reported for long enough to worry. */
  | "stalled";


/** One measurement of one child. Every field is observed, never assumed. */
export interface ChildObservation {
  childId: string;
  /** Pane liveness as measured by `list-panes`; `undefined` = unreadable. */
  paneAlive: boolean | undefined;
  /** Everything the child has said on its channel, already folded. */
  projection: ChannelProjection;
  /**
   * Epoch ms this child was last GIVEN work.
   *
   * Two jobs. It bounds a completion — a `done` report older than the current
   * assignment belongs to the PREVIOUS one (round-1 P1), and without this a
   * re-tasked child that then got STUCK would keep being reported finished.
   * It is also the activity floor for a child that has not reported yet, so a
   * freshly spawned session is not called `stalled` before it has booted.
   */
  lastAssignedAt?: number;
  /** Now, in epoch ms — injected, never read from a clock in here. */
  at: number;
  /** Silence budget before `stalled`; injectable for tests. */
  staleMs?: number;
}

/**
 * Classify one child.
 *
 * ORDER MATTERS and each step earns its place:
 *
 *  1. a vanished pane beats every report, because the reports stop being
 *     updated the moment the process is gone (a stale `working` on a dead
 *     child is the failure that hides a crash);
 *  2. an OPEN REQUEST beats everything else that is alive — it is the state a
 *     supervisor must never miss, and unlike the old design it is a record in
 *     a file rather than an inference about pixels;
 *  3. completion, bounded by the current assignment;
 *  4. silence (stalled) before any positive report, because a report older
 *     than the heartbeat budget is not evidence of anything current;
 *  5. and only THEN the positive reports, `waiting-judge` among them.
 *
 * Step 4 still precedes step 5 on purpose, and the ordering is exactly what
 * makes `waiting-judge` honest rather than a blindfold: a child that says it
 * is waiting for a reviewer and then STOPS heartbeating is `stalled` like any
 * other corpse. What changed in round 4 is that the heartbeat no longer
 * depends on the agent producing events, so a live child inside a 10-minute
 * `judge_wait` keeps clearing step 4 and lands here, where its own report
 * says what it is doing.
 */
export function classifyChildState(observation: ChildObservation): ChildState {
  if (observation.paneAlive === false) return "dead";

  const { projection } = observation;
  if (projection.openRequests.length > 0) return "waiting-input";

  const last = projection.lastState;
  const assigned = observation.lastAssignedAt;
  if (last?.state === "done") {
    const reportedAt = Date.parse(last.at);
    const belongsToCurrentWork =
      assigned === undefined || !Number.isFinite(reportedAt) || reportedAt >= assigned;
    if (belongsToCurrentWork) return "done";
  }

  if (stalledNow(observation)) return "stalled";

  if (last?.state === "waiting-judge") return "waiting-judge";
  if (last?.state === "idle") return "idle";
  // Either it reported `working`, or it has not reported at all yet and is
  // still inside its heartbeat budget (a session that is booting).
  return "working";
}


/** `isStalled`, with the assignment stamp as the activity floor. */
function stalledNow(observation: ChildObservation): boolean {
  const staleMs = observation.staleMs ?? HEARTBEAT_STALE_MS;
  const floor = observation.lastAssignedAt;
  const reported = observation.projection.lastActivityAt;
  const reportedMs = reported ? Date.parse(reported) : Number.NaN;
  const effective = Math.max(
    Number.isFinite(reportedMs) ? reportedMs : Number.NEGATIVE_INFINITY,
    floor ?? Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(effective)) return false;
  return isStalled(
    { ...observation.projection, lastActivityAt: new Date(effective).toISOString() },
    observation.paneAlive,
    observation.at,
    staleMs,
  );
}

/** One line of the health snapshot every `orchestrator_wait` receipt carries. */
export interface ChildHealth {
  childId: string;
  state: ChildState;
  /** ISO time of the child's newest channel record. */
  lastActivityAt?: string;
  /** Seconds since that record — the number a human reads first. */
  quietForSeconds?: number;
  /** Title of the dialog currently open, from the request itself. */
  dialogTitle?: string;
  /** Percent of ITS context window used, when it reported one. */
  contextPercent?: number;
  /** Its own pi session id — what `orchestrator_recover` re-opens. */
  sessionId?: string;
  /**
   * How long the child has been in THIS state, in seconds.
   *
   * Separate from `quietForSeconds` and not redundant with it: with an
   * independent heartbeat the child is never quiet for long, so the number
   * that carries meaning is how long the STATE has lasted — 220 seconds of
   * `waiting-judge` is a review round, 900 seconds of `waiting-input` is a
   * question nobody answered.
   */
  stateForSeconds?: number;
  /** What it is blocked on while `waiting-judge` (`reviewer`, `precommit`…). */
  waitingFor?: string;
}

/** Build the health line for one child. */
export function childHealth(observation: ChildObservation): ChildHealth {
  const state = classifyChildState(observation);
  const { projection } = observation;
  const lastActivityAt = projection.lastActivityAt;
  const parsed = lastActivityAt ? Date.parse(lastActivityAt) : Number.NaN;
  const open = projection.openRequests[0];
  // A question's clock starts when it was ASKED, not when the child last
  // reported: the heartbeat keeps re-reporting `waiting-input`, and the number
  // a supervisor needs is how long the human (or it) has left it hanging.
  const since = open?.at ?? projection.lastStateSince;
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  return {
    childId: observation.childId,
    state,
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
    ...(Number.isFinite(parsed)
      ? { quietForSeconds: Math.max(0, Math.round((observation.at - parsed) / 1000)) }
      : {}),
    ...(Number.isFinite(sinceMs)
      ? { stateForSeconds: Math.max(0, Math.round((observation.at - sinceMs) / 1000)) }
      : {}),
    ...(open?.title === undefined ? {} : { dialogTitle: open.title }),
    ...(projection.lastState?.contextPercent === undefined
      ? {}
      : { contextPercent: projection.lastState.contextPercent }),
    ...(projection.lastState?.sessionId === undefined
      ? {}
      : { sessionId: projection.lastState.sessionId }),
    ...(state === "waiting-judge" && projection.lastState?.waitingFor !== undefined
      ? { waitingFor: projection.lastState.waitingFor }
      : {}),
  };
}


/**
 * States that are WORTH WAKING the orchestrator for.
 *
 * Two are not, and they are the two that mean "all is well, nobody has to do
 * anything": `working`, and — since round 4 — `waiting-judge`. Waking a
 * supervisor for a review round it started itself is not supervision, it is
 * noise: the measured cost was 12 useless wake-ups across ~14 minutes, each
 * one arriving with an `interrupt` suggestion attached.
 *
 * Everything else is either a request, a completion, or a failure — and R3-5
 * is the standing proof that a completion which produces no signal is
 * indistinguishable from a hang.
 */
export function isNewsworthy(state: ChildState): boolean {
  return state !== "working" && state !== "waiting-judge";
}


/** Re-ask backoff for a request nobody has answered yet. */
export const REWAKE_BACKOFF_MS: readonly number[] = Object.freeze([10_000, 30_000, 60_000]);

/** How long before the Nth reminder about the same unanswered thing. */
export function nextRewakeDelayMs(alreadyReported: number): number {
  const index = Math.min(Math.max(alreadyReported, 0), REWAKE_BACKOFF_MS.length - 1);
  return REWAKE_BACKOFF_MS[index]!;
}

/** A completion rings at most twice, then stays quiet. */
export const DONE_REPORT_LIMIT = 2;
/** Gap between those two completion reminders. */
export const DONE_REWAKE_MS = 60_000;

/** Human-readable name of a state, for the receipt. */
export function describeChildState(state: ChildState): string {
  switch (state) {
    case "working": return "在干活";
    case "waiting-input": return "等人回答";
    case "waiting-judge": return "在等门禁自己派出去的活（reviewer / precommit）";
    case "done": return "已完成";
    case "idle": return "停下了（没有 declare_done）";
    case "dead": return "pane 已消失";
    case "stalled": return "pane 还在，但心跳停了（扩展已不在，不是「它在忙」）";
  }
}

/**
 * One state, with the number that makes it readable.
 *
 * `waiting-judge` reads as "在等 reviewer 220s" rather than as a bare label,
 * because the whole point of the state is that the DURATION is the reassuring
 * part: a supervisor who cannot see how long the wait has run has no way to
 * tell a normal review round from a wedged one.
 */
export function describeChildStateDetailed(health: ChildHealth): string {
  const base = describeChildState(health.state);
  if (health.state === "waiting-judge") {
    const what = health.waitingFor ?? "reviewer";
    const forSeconds = health.stateForSeconds === undefined ? "" : `（已等 ${health.stateForSeconds}s）`;
    return `在等 ${what}${forSeconds} —— 正常，别打断`;
  }
  if (health.state === "waiting-input" && health.stateForSeconds !== undefined) {
    return `${base}（已等 ${health.stateForSeconds}s）`;
  }
  return base;
}

/** Render the health snapshot the orchestrator reads every round. */
export function formatChildHealth(list: readonly ChildHealth[]): string {
  if (list.length === 0) return "（本编排目前没有存活的子会话）";
  return list
    .map((h) => {
      const quiet = h.quietForSeconds === undefined ? "" : `，已静默 ${h.quietForSeconds}s`;
      const dialog = h.dialogTitle ? `，框：${h.dialogTitle}` : "";
      const ctx = h.contextPercent === undefined ? "" : `，上下文 ${h.contextPercent}%`;
      return `- ${h.childId}：${describeChildStateDetailed(h)}${quiet}${dialog}${ctx}`;
    })
    .join("\n");
}

