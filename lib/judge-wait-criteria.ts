/**
 * THE WAIT CRITERIA of a pane judge — when `judge_wait` (lib/judge-wait-tool.ts)
 * and the settle sweep in extensions/review-gate.ts consider a round ended,
 * and what else a wake-up carries (open questions, streamed findings, model
 * failures).
 *
 * Its own module so the criteria can be read, tested and shared without the
 * tools that act on them: the settle sweep calls `probeJudgeRound` directly,
 * and the wait loop runs `probeJudgeWait` on every tick. Which report closes
 * a round is NOT decided here — `selectRoundReport` (lib/audit-round-report.ts)
 * is the one selector, shared with the recorder.
 */
import {
  paneIdUsable,
} from "./hierarchy.ts";
import { channelPathFor, judgeChannelTarget } from "./channel-io.ts";
import { isStalled, projectChannel, readChannel, HEARTBEAT_STALE_MS } from "./channel-projection.ts";
import type { ChannelRecord } from "./channel-records.ts";
import { judgePaneAlive } from "./judge-pane.ts";
import { refreshSessionPaneTitle } from "./session-factory.ts";
// The label grammar lives with the rest of the border identity (ONE renderer:
// lib/orchestrator-pane-decor.ts), not beside the pane plumbing that writes it.
import { judgePaneLabel } from "./orchestrator-pane-decor.ts";
import type { ChildState } from "./orchestrator-child-state.ts";
// The ONE selector for "which report closes this round" and its wording. The
// wait shares it with the recorder on purpose (2026-09-05): two comparisons
// meant the wait could end a round the recorder then refused to record.
import {
  describeRoundMiss,
  selectRoundReport,
  type RoundBinding,
} from "./audit-round-report.ts";
import type { OpenQuestionBrief } from "./judge-report.ts";
import type { ModelEvent } from "./model-health.ts";
import { parseStream } from "./review-stream.ts";
import type { JudgeChildRecord, JudgeSessionToolDeps } from "./judge-session-tools.ts";

/** The `at` of the newest instruction this pane was given — its newest TASK. */
function newestInstructAt(records: ReadonlyArray<ChannelRecord>): string | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]!;
    if (record.kind === "instruct") return record.at;
  }
  return undefined;
}

/**
 * Did the consumed report arrive AFTER the pane's newest task?
 *
 * The half of `settled` that is not about the pane. `already-consumed` means a
 * report is in and the cursor passed it — but a `cursor-only` binding
 * (adviser) never compares round numbers, so immediately after a RE-DISPATCH
 * the probe would still be looking at the PREVIOUS round's consumed report, on
 * a pane whose heartbeat has not yet left `idle`, and answer "nothing left to
 * receive" for a round that has not started. That is the same kind of lie this
 * criterion exists to kill, pointing the other way (round-1 quality P1,
 * 2026-09-16).
 *
 * "Newer than the task" separates the two cases. No task at all is NOT the
 * suspect case — a pane's first round arrives as a file, not as an instruction
 * — so it may settle; an unreadable timestamp may not, because the strict
 * direction here is the one that does not tell the agent to walk away.
 */
function reportIsNewerThanLastTask(
  reportAt: string | undefined,
  lastTaskAt: string | undefined,
): boolean {
  if (lastTaskAt === undefined) return true;
  if (reportAt === undefined) return false;
  const report = Date.parse(reportAt);
  const task = Date.parse(lastTaskAt);
  if (!Number.isFinite(report) || !Number.isFinite(task)) return false;
  return report > task;
}

// ---------- the wait criteria (this module's own) ----------

export interface PaneJudgeWaitObservation {
  done: boolean;
  reason: "report" | "pane-dead" | "question" | "finding" | "model-exhausted" | "pending" | "settled";
  reportId?: string;
  verdict?: string;
  findingsCount?: number;
  stateLine?: string;
  /** Every question the judge has open, cursor-independent (the wait filters). */
  openQuestions?: OpenQuestionBrief[];
  /** Findings streamed since the caller's cursor, one formatted line each. */
  newFindings?: string[];
  /** Total findings visible in the stream — the cursor value to store next. */
  seenFindingCount?: number;
  /** Questions the opener has not been shown yet. */
  newQuestions?: OpenQuestionBrief[];
  /**
   * A report the channel HOLDS that is not this round's — an older round's, or
   * one stamped no later than this round's checkpoint.
   *
   * It never ends the round (the recorder would refuse it), and it is never
   * silently dropped either: the opener is told which report was set aside and
   * why, so "still waiting" is a checkable statement rather than a guess.
   */
  notThisRound?: { reportId: string; round?: number; at?: string; detail: string };
  /**
   * Model failures the pane reported (lib/judge-model-rotation.ts), newest
   * last. `exhausted` on one of them is what ENDS the round as failed — a
   * rotation on its own is news, not a conclusion.
   */
  modelEvents?: ModelEvent[];
  /** Total model events visible in the channel — the cursor value to store next. */
  seenModelEventCount?: number;
}

/**
 * What the opener has ALREADY been shown — the wait's de-duplication cursors.
 *
 * Without them a message-driven wait is unusable: the finding that ended the
 * previous wait would end the next one too, immediately, forever. Each cursor
 * is owned by the side that persists it (the report id and the finding count
 * on the judge's registry entry, the announced question ids by the session, so
 * a question a settle wake-up already delivered is not delivered twice).
 */
export interface JudgeWaitCursors {
  /** Newest report already recorded. */
  reportId: string | undefined;
  /** How many streamed findings the opener has already seen. */
  findingCount: number;
  /** Question ids already announced — by a wait OR by the settle path. */
  announcedQuestions: ReadonlySet<string>;
  /** How many model-failure events the opener has already acted on. */
  modelEventCount: number;
}

/**
 * Observe one pane judge round: a NEW channel report ends it, a dead pane
 * ends it as failed, anything else is still running. The end-of-round
 * criterion reads the channel (where the conclusion is structured data), never
 * a transcript scan — the transcript stays the long memory, not the signal.
 *
 * It also reports the judge's OPEN QUESTIONS, without judging whether they are
 * new: the settle path and the wait keep different cursors over them, and a
 * probe that applied one of those cursors would be the wrong observation for
 * the other caller.
 */
export function probeJudgeRound(
  deps: Pick<JudgeSessionToolDeps, "channelIO" | "channelHome" | "tmux" | "now" | "tmuxServer" | "paneOwner">,
  child: Pick<JudgeChildRecord, "openerId" | "judgeId" | "paneId" | "windowId" | "tmuxSession" | "role" | "tmuxServer">,
  consumedReportId: string | undefined,
  binding: RoundBinding,
): PaneJudgeWaitObservation {
  const io = deps.channelIO();
  const home = deps.channelHome();
  const target = judgeChannelTarget(child.openerId, child.judgeId, home);
  const read = readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home));
  const projection = projectChannel(read.records);
  /**
   * C2 — REPAINT THE BORDER FROM THIS READING.
   *
   * pi overwrites a pane's title shortly after boot, so the one written at
   * spawn is gone within seconds and a judge pane sat there saying nothing
   * about itself for the whole round. The orchestration side already solved
   * this by repainting from every health reading; this is the same function
   * (lib/session-factory.ts), on the judge's own probe — which BOTH the wait
   * loop and the settle sweep go through, so there is no path that reads a
   * judge's state without refreshing what the human sees.
   *
   * The state comes from the CHANNEL projection, never from the screen, and
   * the paint is throttled and failure-swallowed inside the shared function.
   *
   * `paneIdUsable` FIRST, and it is a slightly different question from the
   * kill path's: the registry is persisted, so an entry restored after a tmux
   * server restart carries a pane id that server has since handed to somebody
   * else. Writing a title through it would rename a stranger's pane —
   * cosmetic, but in the user's own window. (A repaint needs only the pane id
   * to be usable; a close also needs the window and session it was recorded
   * with, which is `windowClosable`.)
   */
  const paintTitle = (state: ChildState | undefined, since?: string): void => {
    if (!child.paneId || !child.role || state === undefined) return;
    // `paneIdUsable`, NOT `windowClosable`: writing a title through a pane id
    // needs the same single fact `judgeLive` uses (was this id minted by the
    // server we are talking to), and an entry from before the window topology
    // has no window coordinates while its pane is perfectly painted-able.
    if (!paneIdUsable(child, deps.tmuxServer())) return;
    const seconds = since ? Math.max(0, (deps.now() - Date.parse(since)) / 1000) : undefined;
    refreshSessionPaneTitle(deps.tmux, {
      paneId: child.paneId,
      label: judgePaneLabel(child.role, deps.paneOwner()),
      state,
      ...(seconds === undefined || Number.isNaN(seconds) ? {} : { stateForSeconds: seconds }),
      now: deps.now(),
    });
  };
  const openQuestions: OpenQuestionBrief[] = (projection.openRequests ?? []).map((q) => ({
    title: q.title,
    options: q.options,
    requestId: q.requestId,
  }));
  // Model failures the pane reported, when it reported any. Present on EVERY
  // outcome that carries them: a round that ends after a rotation should say
  // which model died, and a round that ends WITHOUT the pane ever concluding
  // (exhausted chain) is exactly the case where the events are the whole story.
  const withModelEvents = projection.modelEvents.length > 0 ? { modelEvents: projection.modelEvents } : {};
  // ONE criterion, shared with the recorder (lib/audit-round.ts). This used to
  // be its own comparison — "newest report, different id from the cursor" —
  // and that is precisely how a round ended here on a report the recorder then
  // refused: the wait announced a READY, the gate recorded nothing, and the
  // agent read the wake-up as a finished round (2026-09-05).
  const selected = selectRoundReport(read.records, { ...binding, consumedReportId });
  if (selected.ok) {
    const report = selected.report;
    // The round is over: say so on the border too, so a human glancing at the
    // window sees `done` instead of the last state the judge happened to report.
    paintTitle("done");
    return {
      done: true,
      reason: "report",
      reportId: report.reportId,
      verdict: report.verdict,
      ...(report.findingsCount === undefined ? {} : { findingsCount: report.findingsCount }),
      openQuestions,
      ...withModelEvents,
    };
  }
  // A report is sitting there and it is NOT this round's: keep waiting, and
  // carry WHICH one and WHY so the wake-up can say it out loud.
  //
  // THE CONSUMED ONE IS NOT THAT (reviewer P2, 2026-09-05). The selector checks
  // the ROUND before the cursor on purpose, so from round 2 on the previous
  // round's report — already recorded, cursor already advanced — comes back as
  // `round-mismatch` rather than `already-consumed`. Announcing it would report
  // a verdict that WAS adopted as "set aside", every single wait, which is how
  // a real warning becomes noise nobody reads. The cursor is the check that
  // says "this one is handled", whatever reason the selector gave.
  const notThisRound =
    selected.reason === "no-report"
    || selected.reason === "already-consumed"
    || selected.reportId === undefined
    || selected.reportId === consumedReportId
      ? undefined
      : {
          reportId: selected.reportId,
          ...(selected.round === undefined ? {} : { round: selected.round }),
          ...(selected.at === undefined ? {} : { at: selected.at }),
          detail: describeRoundMiss(selected),
        };
  const paneAlive = child.paneId ? judgePaneAlive(deps.tmux, child.paneId) : undefined;
  const withEvents = withModelEvents;
  if (paneAlive === false) {
    return { done: true, reason: "pane-dead", openQuestions, ...withEvents, ...(notThisRound === undefined ? {} : { notThisRound }) };
  }
  const state = projection.lastState?.state ?? "unknown";
  const since = projection.lastStateSince ?? projection.lastActivityAt ?? "—";
  // NOTHING LEFT TO RECEIVE (2026-09-16). A wait whose round has ALREADY been
  // concluded, recorded and consumed, on a pane that is sitting idle, has no
  // event to deliver — and blocking to the timeout says something FALSE: the
  // opener reads a state line as "still working". Measured (notification
  // session, 2026-09-15): six minutes and forty-seven seconds inside a wait
  // that could not end, while the gate had been green since minute two and the
  // human had to point it out.
  //
  // `already-consumed` is the exact reading that means "this round's report is
  // in and the cursor has passed it" — the same source, not a new one. The
  // pane state is what keeps it honest: a WORKING pane is a round in flight,
  // and that one still has an event to wait for.
  // …and the report must be NEWER than the pane's last task: a `cursor-only`
  // binding never compares round numbers, so right after a re-dispatch the
  // only report the probe can see is the PREVIOUS round's, already consumed,
  // on a pane still reporting `idle` — and answering "nothing left to
  // receive" for a round that has not started is the same lie in the other
  // direction (round-1 quality P1, 2026-09-16).
  if (
    selected.reason === "already-consumed"
    && (state === "idle" || state === "done")
    && reportIsNewerThanLastTask(selected.at, newestInstructAt(read.records))
  ) {
    paintTitle("done");
    return {
      done: true,
      reason: "settled",
      stateLine: `${state}（自 ${since}）`,
      openQuestions,
      ...withEvents,
    };
  }
  paintTitle(projection.lastState?.state, projection.lastStateSince ?? projection.lastActivityAt);
  return {
    done: false,
    reason: "pending",
    stateLine: `${state}（自 ${since}）`,
    openQuestions,
    ...withEvents,
    ...(notThisRound === undefined ? {} : { notThisRound }),
  };
}

/**
 * The MESSAGE-DRIVEN criterion (2026-09-05, user decision): the wait ends on
 * the first thing that happened, not at the end of the round.
 *
 * Order is deliberate — a finished round outranks a question, which outranks a
 * finding — because when several land in the same probe the opener should act
 * on the strongest one. Both new criteria read the SAME sources the gate
 * already writes (the round's stream file, the channel's open requests): the
 * judge-side record format is untouched, so a judge running the newest code
 * still reports to an opener running the oldest.
 */
export function probeJudgeWait(
  deps: Pick<JudgeSessionToolDeps, "channelIO" | "channelHome" | "tmux" | "now" | "tmuxServer" | "readText" | "roundBinding" | "paneOwner">,
  child: Pick<JudgeChildRecord, "openerId" | "judgeId" | "paneId" | "streamPath" | "role" | "repoRoot" | "tmuxServer" | "modelSpec">,
  cursors: JudgeWaitCursors,
): PaneJudgeWaitObservation {
  const round = probeJudgeRound(deps, child, cursors.reportId, deps.roundBinding(child));
  const findings = recentStreamFindings(deps, child.streamPath);
  const seenFindingCount = findings.length;
  // MODEL FAILURES ARE NOT A CONCLUSION (criterion 3 vs criterion 4): a
  // rotation is news the opener acts on (cool the slot down, warn the user)
  // and the round keeps running, but an EXHAUSTED chain means the round can
  // never produce a verdict — ending the wait there is what turns "hung for
  // hours" into "failed with a reason".
  const allModelEvents = round.modelEvents ?? [];
  const newModelEvents = allModelEvents.slice(cursors.modelEventCount);
  const seenModelEventCount = allModelEvents.length;
  /** An empty list stays off the observation: a wake-up says what happened. */
  const withEvents = (obs: PaneJudgeWaitObservation): PaneJudgeWaitObservation => {
    // The partial observation may carry the CHANNEL'S WHOLE list (the probe
    // that produced it reads the channel, not this caller's cursor). Drop it
    // and re-attach only what is new — otherwise a receipt reprints rotations
    // that were acted on several wake-ups ago (P2, reviewer 2026-09-10).
    const { modelEvents: _inherited, ...rest } = obs;
    return {
      ...rest,
      ...(newModelEvents.length > 0 ? { modelEvents: newModelEvents } : {}),
      seenFindingCount,
      seenModelEventCount,
    };
  };
  if (round.done) return withEvents(round);
  if (newModelEvents.some((event) => event.exhausted === true)) {
    return withEvents({ ...round, done: true, reason: "model-exhausted" });
  }
  const newQuestions = (round.openQuestions ?? []).filter((q) => !cursors.announcedQuestions.has(q.requestId));
  if (newQuestions.length > 0) {
    return withEvents({ ...round, done: true, reason: "question", newQuestions });
  }
  if (seenFindingCount > cursors.findingCount) {
    return withEvents({
      ...round,
      done: true,
      reason: "finding",
      newFindings: findings.slice(cursors.findingCount),
    });
  }
  return withEvents({ ...round, done: false, reason: "pending" });
}


/** Is this pane judge's silence a stall? Missing pane info is never a stall. */
export function paneJudgeStalled(
  deps: JudgeSessionToolDeps,
  child: JudgeChildRecord,
): boolean {
  const io = deps.channelIO();
  const home = deps.channelHome();
  const target = judgeChannelTarget(child.openerId, child.judgeId, home);
  const read = readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home));
  const projection = projectChannel(read.records);
  const paneAlive = child.paneId ? judgePaneAlive(deps.tmux, child.paneId) : undefined;
  return isStalled(projection, paneAlive, deps.now(), HEARTBEAT_STALE_MS);
}

/**
 * The findings a judge has streamed so far, newest last, one line each.
 *
 * Evidence only: the stream never carries a verdict (parseStream rejects
 * verdict-shaped lines), so showing it while a round is still open cannot
 * leak a conclusion the gate has not recorded.
 */
export function recentStreamFindings(
  deps: Pick<JudgeSessionToolDeps, "readText">,
  streamPath: string | undefined,
): string[] {
  if (!streamPath) return [];
  const raw = deps.readText(streamPath);
  if (raw === undefined) return [];
  try {
    return parseStream(raw).findings
      .map((f) => `[${f.severity}] ${f.location ? `${f.location} — ` : ""}${f.issue}`.slice(0, 300));
  } catch { return []; }
}
