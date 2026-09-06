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
  /** It switched gate mode (loop→explore/normal/orchestrator) — newsworthy. */
  | "mode-changed"
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
 * How long a child must go WITHOUT forward progress before its OWN `idle`
 * report is believed. 120 seconds, and it is THE USER'S NUMBER (2026-09-04) —
 * pinned here like `JUDGE_ROTATION_CONTEXT_PERCENT`, not a threshold to tune
 * away on a hunch.
 *
 * ── WHY A REPORT NEEDS CORROBORATION AT ALL (B3) ──
 *
 * The child reports `working` vs `idle` from `ctx.isIdle()`, and that reading
 * is true BETWEEN two tool calls: a session in the middle of a read-only
 * investigation (bash, read, bash, …) is idle at almost every heartbeat tick.
 * Measured on 2026-09-04: a child whose transcript grew 23.7KB in 45 seconds
 * was reported "停下了（没有 declare_done）" four polls in a row, with
 * "最后活动 0s 前" printed on the same line. The cost was not only two
 * needless interrupts — `idle` is newsworthy, so `orchestrator_wait` returned
 * instantly every time and the supervisor's one waiting tool degraded into a
 * busy poll.
 *
 * The corroborating fact was already in the very same record: `lastProgressAt`,
 * which advances ONLY on a real agent event (a tool result, a turn boundary)
 * and never on a heartbeat. It was a READING nothing consulted. Now it decides:
 * a child that reported `idle` while it was stepping forward moments ago is
 * `working`, and only genuine silence for this long makes the report true.
 */
export const IDLE_PROGRESS_GRACE_MS = 120_000;

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
  if (completionReported(observation)) return "done";

  if (stalledNow(observation)) return "stalled";

  if (last?.state === "waiting-judge") return "waiting-judge";
  // A mode switch is a one-shot event: the report carries it, and the next
  // heartbeat re-reports the child's real state. A supervisor must SEE it.
  if (last?.state === "mode-changed") return "mode-changed";
  // B3 — an `idle` REPORT is not by itself evidence that the child stopped.
  // It is believed only when the child's own progress stamp agrees: no
  // forward step for IDLE_PROGRESS_GRACE_MS. Anything more recent than that
  // is a session between two tool calls, which is `working`.
  if (last?.state === "idle") return idleReportIsBelievable(observation) ? "idle" : "working";
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

/**
 * DID THIS CHILD SAY IT FINISHED — the completion fact, on its own.
 *
 * Separate from {@link classifyChildState} because the STATE answers a
 * different question. A child whose pane is gone is `dead` and nothing else,
 * which is right for supervision (a corpse is the headline) and wrong for the
 * wrap-up block: "it finished, and then its pane went away" is not the same
 * situation as "it died without ever reporting". Reading completion off the
 * state made the receipt tell a manager that a child which HAD reported done
 * "从未报告完成 …必要时把任务改回 pending 重开", while block 3 was showing
 * that same child's `declare_done` record among its surviving assets — the
 * very two-blocks-disagree shape B4 exists to remove.
 *
 * Bounded by `lastAssignedAt` exactly as the state is (round-1 P1): a
 * completion older than the current assignment is history, not a verdict.
 */
export function completionReported(observation: ChildObservation): boolean {
  const last = observation.projection.lastState;
  if (last?.state !== "done") return false;
  const reportedAt = Date.parse(last.at);
  const assigned = observation.lastAssignedAt;
  return assigned === undefined || !Number.isFinite(reportedAt) || reportedAt >= assigned;
}


/**
 * Milliseconds since the child's last FORWARD PROGRESS.
 *
 * `undefined` means the child never stamped one — a session that has not
 * booted far enough to run a tool, or an extension older than the stamp.
 * Deliberately NOT zero: "no information" and "stepped forward just now" are
 * opposite facts, and B3's whole lesson is that guessing between them is what
 * produced a false "停下了".
 */
export function progressStaleMs(observation: ChildObservation): number | undefined {
  const at = observation.projection.lastState?.lastProgressAt;
  const ms = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(ms)) return undefined;
  return Math.max(0, observation.at - ms);
}

/**
 * Does the child's own `idle` report survive its progress stamp? (B3)
 *
 * NO STAMP ⇒ BELIEVED, on purpose. A child that never reported progress gives
 * this function nothing to contradict the report with, and inventing a
 * contradiction would turn a genuinely stopped child (or one running an older
 * extension that predates the stamp) into a permanent `working` — the exact
 * failure `idle` exists to catch (R3-5, a finished child silent for 725s).
 * The grace period only ever downgrades a report that the child's OWN record
 * disagrees with.
 */
function idleReportIsBelievable(observation: ChildObservation): boolean {
  const stale = progressStaleMs(observation);
  if (stale === undefined) return true;
  return stale >= IDLE_PROGRESS_GRACE_MS;
}

/**
 * Is this `working` child one whose own report said `idle`? (B3)
 *
 * The health line says so out loud rather than silently overruling the child
 * (user decision, 2026-09-17): the raw signal "it says it stopped" stays
 * visible to the supervisor instead of being hidden for two minutes, and a
 * supervisor who sees it can go and look for itself.
 */
function isUnbelievedIdle(observation: ChildObservation, state: ChildState): boolean {
  return state === "working" && observation.projection.lastState?.state === "idle";
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
  /**
   * Seconds since the last FORWARD PROGRESS, for a `working` child only (E).
   * The distinguishing reading between "turning the crank" (small) and "wedged
   * in place" (growing) — a `working` child is otherwise indistinguishable from
   * a hang. Purely informational: it never makes a child newsworthy.
   */
  progressStaleSeconds?: number;
  /**
   * This `working` child REPORTED `idle`, and the report was not believed
   * because its progress stamp is younger than {@link IDLE_PROGRESS_GRACE_MS}
   * (B3). Present only in that case, so the receipt can show the supervisor
   * the raw signal it is overruling instead of hiding it.
   */
  selfReportedIdle?: boolean;
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
  // E — seconds since the child's last FORWARD PROGRESS (a tool call / turn
  // boundary the child stamped), NOT since its last heartbeat. Undefined until
  // the child has reported one.
  const staleMs = progressStaleMs(observation);
  const progressStale = staleMs === undefined ? undefined : Math.round(staleMs / 1000);
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
    // E — the progress reading, only for a `working` child (the one state that
    // otherwise cannot be told apart from a hang). It is a READING, never a
    // wake reason: isNewsworthy is untouched.
    ...(state === "working" && progressStale !== undefined
      ? { progressStaleSeconds: progressStale }
      : {}),
    // B3 — and when this `working` was reached by OVERRULING the child's own
    // `idle` report, say so. The supervisor sees both the reading and the
    // report it contradicts.
    ...(isUnbelievedIdle(observation, state) ? { selfReportedIdle: true } : {}),
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
  // mode-changed is a one-shot event the supervisor must not miss — a child
  // that silently downgraded to explore/normal could otherwise be waited on
  // forever under the assumption it is still enforcing loop.
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
    case "mode-changed": return "切换了门禁模式";
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
  if (health.state === "working") {
    // B3 — the overruled `idle` report is named in the line itself, so the
    // supervisor reads BOTH facts: the child said it stopped, and its own
    // progress stamp says otherwise. Hiding the report for two minutes would
    // trade one blind spot for another, and it would make the flip to `idle`
    // arrive with no warning — a supervisor who sees this marker knows the
    // state will turn if the child does not step again.
    //
    // KEPT SHORT ON PURPOSE (user, 2026-09-17). This is the line a manager
    // scans every few minutes, one row per child, inside a five-block receipt:
    // the information is preserved, the words are not. "自报停下·未满 120s"
    // carries the report, the doubt and the deadline in ten characters.
    const doubted = health.selfReportedIdle
      ? `·自报停下未满 ${Math.round(IDLE_PROGRESS_GRACE_MS / 1000)}s`
      : "";
    if (health.progressStaleSeconds !== undefined) {
      // A READING, not an alarm: it just names how long since the last real
      // forward step, so 60 minutes of `working` with no checkpoint reads
      // differently from a hang. No wake, no suggested action.
      const progress = `自上次推进 ${health.progressStaleSeconds}s`;
      return `${base}（${progress}${doubted}）`;
    }
    // No progress reading at all (a child that never stamped one). The doubt
    // marker cannot occur without a stamp — it is what produced the doubt —
    // so this branch is the plain `working` line.
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

