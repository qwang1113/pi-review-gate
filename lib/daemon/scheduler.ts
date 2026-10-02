/**
 * THE SCHEDULER — the daemon's clock: WHAT is due, and WHAT a finished run
 * concluded.
 *
 * ── TWO DECISIONS, EACH A PURE FUNCTION ──
 *
 * The daemon is resident and ticks on a 20-second timer, and the two things a
 * tick decides are the two that must not be buried in an `if (tmux)` block:
 * `dueDecision` (may this task start now?) and `settlementFor` (what did that
 * run end as?). Both are exported, both take the clock as an argument, and
 * neither touches the filesystem or tmux — the tick around them is the only
 * IO, so "why did it not run" is answerable without a real daemon and a real
 * cron minute.
 *
 * ── WHAT "DUE" MEANS ──
 *
 * Counting the next slot from `now` would be useless for firing: a brand-new
 * task's first slot would always be one period away, so a task that never ran
 * would never run. The schedule counts from `lastFiredAt ?? createdAt`, so the
 * first slot is the first cron minute after the task was AUTHORED (authored
 * 08:59 for `0 9 * * *` ⇒ fires at 09:00).
 *
 * A SLOT THE DAEMON SLEPT THROUGH IS SKIPPED, NOT REPLAYED (user decision):
 * the slot due is `lastFiredAt`'s next one, and it is judged against `now`.
 * Still ahead ⇒ `not-yet`; just passed, inside {@link SLOT_GRACE_MS} ⇒ `due`
 * (that window is what absorbs a late tick); further behind than that ⇒
 * `missed` — nothing starts, and `scheduledAt` becomes the NEXT slot instead of
 * the one that was lost, so no surface ever names a slot the daemon slept
 * through. The missed slot is consumed by the tick that judged it (it stamps
 * the base forward and records a `run-skipped`), which is what keeps "skip this
 * one" from turning into "never run again".
 *
 * ONE SOURCE FOR "WHAT IS NEXT": the API's `nextRunAt` (daemon/server.ts) and
 * `schedule_task({action:"list"})` both read `dueDecision`'s `scheduledAt`, so
 * the panel and the agent can never disagree about a task that is merely
 * WAITING — and neither can promise a tick the scheduler would skip.
 *
 * ── ONE SLOT IS DEALT WITH ONCE (RESTART INCLUDED) ──
 *
 * `lastFiredAt` is stamped for EVERY slot the scheduler deals with — fired,
 * skipped because the repo was busy, or failed to launch — so a tick that
 * jitters, and a daemon that restarts, never deal with the same slot twice.
 * The ledger (`schedule-runs.jsonl`, append-only) is what a restart reads to
 * learn which runs are still OPEN; the table's `lastFiredAt` is what it reads
 * to learn which slots are already dealt with.
 *
 * THE STAMP COMES FIRST, AND A WRITE THAT FAILS IS REMEMBERED IN MEMORY. A
 * session that has been launched cannot be un-launched, so its slot counts as
 * dealt with the moment the launch returns: stamp, then append. When the stamp
 * cannot be written at all (read-only home, full disk) the slot is kept in
 * `unrecordedSlots` and the run in `unrecordedRuns` — this process only — so
 * the same slot is never started twice while the disk is broken, and the run
 * still holds its repo and still settles. Both maps are pruned by age, which
 * is what lets a permanently broken home recover rather than grow forever.
 * The window this leaves is the one between the stamp landing and the append:
 * a process killed there leaves a RUNNING session with no `run-started` line,
 * so a restart neither settles it nor finds it in the ledger. THAT SESSION
 * STILL HOLDS ITS REPO, though — in the way the ledger cannot see: it writes
 * the checkout's presence heartbeat, which is what `liveSessionHolder` refuses
 * later runs on (and what makes the user's own new session in that repo be
 * refused too, until the process is gone). The other
 * order is the fail-spin the quality round measured — one real session per
 * tick, forever — which is strictly worse.
 *
 * A version that was taken mid-write is RETRIED, not parked: the panel's `PUT`
 * can replace the table between our read and our write, and the store then
 * refuses the stamp ("请重读"). That is a race, so the stamp tries again with
 * the version it just read — otherwise one colliding panel edit would leave
 * the task believing its slot was dealt with while `lastFiredAt` never moved.
 *
 * ── WHY A RUN MUST SETTLE BEFORE THE NEXT ONE IN THE SAME REPO STARTS ──
 *
 * Two writers in one checkout overwrite each other (the invariant
 * lib/session-worktree.ts enforces for orchestration children). A run that is
 * still open therefore blocks every other run whose task sits in the same
 * repo, and the skip is RECORDED with the run that holds it — "nothing ran
 * today" and "something ran and never finished" must not look alike.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { nextRunAfter } from "../cron-schedule.ts";
import { normalizeRepoPath, STATION_CAP_ENV } from "../repo-pr-policy.ts";
import {
  checkSessionExclusivity,
  parsePresence,
  PRESENCE_FILENAME,
  type PresenceRecord,
} from "../session-exclusivity.ts";
import { GATE_MODE_ENV } from "../task-mode.ts";
import {
  appendScheduleRun,
  readScheduleRuns,
  readSchedules,
  SCHEDULE_ID_ENV,
  SCHEDULE_RUN_ENV,
  updateScheduledTask,
  type ScheduledTask,
  type ScheduleRunOutcome,
  type ScheduleRunRecord,
  type ScheduleRunStarted,
} from "../schedule-store.ts";
import { launchTask, closeRunWindowAt, type RunWindowTarget } from "./control.ts";
import type { SessionObserver, DaemonSession } from "./sessions.ts";
import { TRANSCRIPT_ACTIVE_MS } from "./sessions.ts";
import type { TmuxRunner } from "../orchestrator-tmux.ts";

/** How often the daemon looks for work. */
export const SCHEDULE_TICK_MS = 20_000;

/**
 * How late a slot may be and still be RUN rather than skipped.
 *
 * The daemon ticks every 20 s, so "the tick landed a few seconds into the cron
 * minute" is the NORMAL case, not a delay — zero tolerance would mean a task
 * only ever fires when a tick happens to land exactly on its minute. This
 * window also absorbs the tick that arrived late for an ordinary reason: a
 * laptop lid closed for a few minutes, a tick held up by a full precommit.
 *
 * WHY IT IS NOT LARGER: past this window the slot is MISSED, and the user's
 * decision is that a missed slot is SKIPPED rather than replayed (a machine
 * that was off for a week must not fire the tasks it slept through). A window
 * of hours would quietly restore the catch-up run this rule removes. Ten
 * minutes is several tick intervals and still well below any cron period a
 * schedule is likely to use.
 */
export const SLOT_GRACE_MS = 10 * 60 * 1_000;

/**
 * How long a slot / a run that could NOT be written to disk is remembered in
 * memory (see `unrecordedSlots`). One day is far longer than any real repair
 * takes, and short enough that a permanently broken home cannot grow the set
 * without bound.
 */
const UNRECORDED_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * How long a just-started run may be MISSING from the observer's listing before
 * that counts as "it is gone".
 *
 * A session that was launched seconds ago has not written its transcript or
 * its pane state yet, so the observer cannot see it — and reading that as
 * "finished/gone" would settle the run, release its repo and let a second
 * writer in while the first is still starting. Only a run that never appeared
 * within this window is treated as vanished.
 */
export const SETTLE_GRACE_MS = 120_000;

/** How many settled/skipped records `GET /api/schedules` shows per task. */
export const LAST_RUNS_SHOWN = 5;

// ---------------------------------------------------------------------------
// The due decision
// ---------------------------------------------------------------------------

export type DueReason = "due" | "disabled" | "not-yet" | "already-dealt" | "open-run" | "bad-time" | "bad-cron" | "missed";

export interface DueDecision {
  due: boolean;
  /**
   * The slot this decision is about; `null` when the schedule cannot name one.
   * NEVER A TIME THE DAEMON SLEPT THROUGH: for `missed` it is the NEXT slot,
   * not the one that was lost (that one rides in {@link missedAt}). A `due`
   * slot is one that just arrived, and the slot an `open-run` task is holding is
   * the one its running session was started for — neither is a stale promise.
   */
  scheduledAt: Date | null;
  /** Set only for `missed`: the slot the daemon slept through, which the tick consumes. */
  missedAt: Date | null;
  reason: DueReason;
}

/**
 * May this task start now?
 *
 * `openRun` is the caller's answer to "does this task have a run that has not
 * settled" — a second run of the SAME task would mean two sessions racing on
 * one goal.
 *
 * THE FOUR WORDS A SLOT CAN HAVE (see the module docblock for why): `not-yet`
 * (still ahead), `due` (just arrived, or arrived within {@link SLOT_GRACE_MS}),
 * `missed` (the daemon was not there when it arrived — skipped, and
 * `scheduledAt` slides to the next one), and `open-run` (the task's own run has
 * not settled; it is not this slot's turn yet). A task still running keeps
 * `open-run` even for a slot that is long past — consuming that slot belongs to
 * the tick that finds the run settled.
 *
 * THE ONE PLACE `scheduledAt` MAY BE OLD, SAID PLAINLY: `open-run` returns the
 * slot the RUNNING session was started for, and a run that has been going for
 * days holds a slot from days ago. That is honest rather than stale — nothing
 * will move that base until the run settles — and it is the reading
 * `schedule_task({action:"list"})` already names (「已过期：本任务还有一次运行没
 * 结算」). No panel sees it: `GET /api/schedules` passes `openRun: false`
 * (daemon/server.ts), so the HTTP field never names a slot the daemon slept
 * through.
 */
export function dueDecision(input: { task: ScheduledTask; now: Date; openRun: boolean }): DueDecision {
  const task = input.task;
  if (task?.enabled !== true) return { due: false, scheduledAt: null, missedAt: null, reason: "disabled" };
  const base = task.lastFiredAt ?? task.createdAt;
  if (!Number.isFinite(Date.parse(base))) {
    return { due: false, scheduledAt: null, missedAt: null, reason: "bad-time" };
  }
  const scheduledAt = nextRunAfter(task.cron, new Date(base));
  if (scheduledAt === null) return { due: false, scheduledAt: null, missedAt: null, reason: "bad-cron" };
  const dealtAt = task.lastFiredAt === null ? undefined : Date.parse(task.lastFiredAt);
  // UNREACHABLE TODAY, KEPT AS A GUARD: `nextRunAfter` is STRICTLY later than
  // its base, and the base IS `lastFiredAt` whenever this branch could fire — so
  // a stamp can never sit at or after the slot counted from it. It would take a
  // future base other than `lastFiredAt` to reach this, and the rule it states
  // ("a slot at or behind the stamp is already dealt with") is the one that must
  // hold if that ever changes. One slot, dealt with once.
  if (dealtAt !== undefined && dealtAt >= scheduledAt.getTime()) {
    return { due: false, scheduledAt, missedAt: null, reason: "already-dealt" };
  }
  const nowMs = input.now.getTime();
  if (scheduledAt.getTime() > nowMs) return { due: false, scheduledAt, missedAt: null, reason: "not-yet" };
  if (input.openRun) return { due: false, scheduledAt, missedAt: null, reason: "open-run" };
  if (nowMs - scheduledAt.getTime() > SLOT_GRACE_MS) {
    // MISSED: the daemon was not there when this slot arrived, and the user's
    // decision is that it is skipped rather than replayed. `scheduledAt` must
    // not keep naming a time in the past — every surface (the API's
    // `nextRunAt`, the panel, `schedule_task({action:"list"})`) renders this
    // field, and "一次性欠着" is exactly the reading this rule removes. The
    // slot the daemon slept through rides along as `missedAt`, because the
    // tick's `run-skipped` line names WHAT was skipped.
    return { due: false, scheduledAt: nextRunAfter(task.cron, input.now), missedAt: scheduledAt, reason: "missed" };
  }
  return { due: true, scheduledAt, missedAt: null, reason: "due" };
}

// ---------------------------------------------------------------------------
// The settlement decision
// ---------------------------------------------------------------------------

export type SettleReason = "settled" | "unseen" | "running";

/**
 * WHAT THE RUN'S OWN RECORDS SAY ABOUT IT — the two facts that answer "is this
 * still running?" when the session listing cannot place the session at all.
 *
 * Both are written by the run itself, so neither is the daemon's own belief:
 *
 *   - `holdsCheckout`: `<repo>/.pi/session-presence.json` carries a FRESH
 *     heartbeat whose `sessionId` is this run's — the record and the rule the
 *     fire-side guard already reads (lib/session-exclusivity.ts). The gate
 *     renews it every 10s and it lapses within a minute of the process dying,
 *     so a hard kill cannot pin a run open with it.
 *   - `transcriptAt`: the run's transcript mtime, `null` when the observer can
 *     no longer see one. A file that moved a moment ago has a live writer by
 *     definition — the observer reads the SAME window for its `working` word.
 */
export interface RunEvidence {
  holdsCheckout: boolean;
  transcriptAt: string | null;
}

export interface SettlementDecision {
  settle: boolean;
  /** Set when `settle` — the outcome the ledger gets. */
  outcome: ScheduleRunOutcome | null;
  verdict: string | null;
  unmet: string[];
  reason: SettleReason;
}

/**
 * What did this run end as? Read off the OBSERVED session and the run's own
 * records, never off a guess:
 *
 *   READY        ⇒ passed
 *   BLOCKED      ⇒ blocked
 *   anything else (no verdict, a verdict the gate did not record) ⇒ failed
 *   no readable gate state, or the run vanished  ⇒ gone
 *
 * `passed` is reachable ONLY through a recorded READY — that is the mechanical
 * half of "a scheduled run's output goes through the reviewer": a session that
 * merely stopped is not a success.
 *
 * ── NOT OBSERVED IS NOT THE SAME AS GONE ──
 *
 * The observer only knows what the machine publishes about a session, and a run
 * whose pane lost its `@rg_sid` (or whose session never registered a name) can
 * be alive and working while the listing cannot place it. Reading that absence
 * as "it finished" settled a run as `gone` 21 minutes BEFORE the same session
 * recorded its READY, and left its window holding the checkout (t6 acceptance,
 * 2026-10-02). So the missing-session branch asks the run's OWN records first
 * ({@link RunEvidence}) — a checkout it still holds, a transcript still being
 * written — and only a run with no trace of life settles as gone.
 *
 * ── AND A LIVE PROCESS IS NOT A FINISHED RUN ──
 *
 * The same mistake one word over: a session the observer calls `dead` or
 * `idle` (no pane, no name, its transcript quiet) may still be a live process
 * blocked in a long command — `declare_done` releases the WORKTREE, not the
 * process. The veto is the same evidence, and it yields to the one thing that
 * really does end a run: the run's OWN statement that it is done — the recorded
 * COMPLETION (`session.completedAt`, `declare_done` accepted) or the pane word
 * derived from that same record (`done`). Either one, and the run settles even
 * while its window is still open; the two are one fact read twice, which is why
 * neither may be the only way out.
 */
export function settlementFor(input: {
  run: ScheduleRunStarted;
  session: DaemonSession | undefined;
  now: Date;
  graceMs?: number;
  /** The run's own facts, for the branches the listing cannot answer. */
  evidence?: RunEvidence;
}): SettlementDecision {
  const nowMs = input.now.getTime();
  const graceMs = input.graceMs ?? SETTLE_GRACE_MS;
  const startedAt = Date.parse(input.run.at);
  const sinceStart = Number.isFinite(startedAt) ? nowMs - startedAt : Number.POSITIVE_INFINITY;
  // The two facts that mean "a live process is behind this run". Both are
  // written by the run ITSELF, and both lapse on their own: the presence
  // heartbeat is renewed every 10s and read through a 60s window, and a
  // transcript that stopped moving ages out of this one.
  const holdsCheckout = input.evidence?.holdsCheckout === true;
  const transcriptAt = input.evidence?.transcriptAt ?? null;
  const transcriptEpoch = transcriptAt === null ? Number.NaN : Date.parse(transcriptAt);
  const writing = Number.isFinite(transcriptEpoch) && nowMs - transcriptEpoch < TRANSCRIPT_ACTIVE_MS;

  const session = input.session;
  if (session === undefined) {
    if (holdsCheckout || writing) {
      return { settle: false, outcome: null, verdict: null, unmet: [], reason: "running" };
    }
    return sinceStart >= graceMs
      ? { settle: true, outcome: "gone", verdict: null, unmet: [], reason: "settled" }
      : { settle: false, outcome: null, verdict: null, unmet: [], reason: "unseen" };
  }
  const verdict = session.rounds.lastVerdict;
  // THE RUN'S OWN STATEMENT THAT IT IS DONE ends it on its own — the recorded
  // completion (`declare_done` accepted) or the pane word the gate derives from
  // that same record. It does not depend on the pane being there at all, which
  // matters for a session the observer can only see through its transcript.
  //
  // BOTH FORMS, not just the record: the transcript read window is 256 KiB
  // (lib/daemon/sessions.ts), so a huge tool result can push the completion
  // record out of it — and a run held open by the veto below with no way to
  // ever settle would occupy its repo for as long as the process lives.
  const concluded = session.completedAt !== null || session.state === "done";
  const ended =
    concluded ||
    session.state === "dead" ||
    (session.state === "idle" && session.rounds.recorded > 0);
  // A RUN THAT STILL HOLDS ITS CHECKOUT HAS NOT ENDED — unless it concluded.
  if (!ended || (holdsCheckout && !concluded)) {
    return { settle: false, outcome: null, verdict, unmet: session.unmet, reason: "running" };
  }
  const outcome: ScheduleRunOutcome = !session.gateStateFound
    ? "gone"
    : verdict === "READY"
      ? "passed"
      : verdict === "BLOCKED"
        ? "blocked"
        : "failed";
  return { settle: true, outcome, verdict, unmet: session.unmet, reason: "settled" };
}

// ---------------------------------------------------------------------------
// The ledger's own questions
// ---------------------------------------------------------------------------

/** Every run that STARTED and has no `run-settled` line yet, oldest first. */
export function openRuns(records: readonly ScheduleRunRecord[]): ScheduleRunStarted[] {
  const open = new Map<string, ScheduleRunStarted>();
  for (const record of records) {
    if (record.kind === "run-started") open.set(record.runId, record);
    else if (record.kind === "run-settled") open.delete(record.runId);
  }
  return [...open.values()];
}

/**
 * The open run already writing in this repo, if there is one.
 *
 * `repoOf` answers where a run's task sits; a run whose repo cannot be named
 * (its task was deleted) falls back to the observed session's repo at the call
 * site, and a repo nobody can name blocks nobody — an unreadable fact must not
 * be read as a conflict.
 */
export function repoHolder(
  runs: readonly ScheduleRunStarted[],
  repo: string,
  repoOf: (run: ScheduleRunStarted) => string | undefined,
): ScheduleRunStarted | undefined {
  const wanted = normalizeRepoPath(repo);
  if (wanted === "") return undefined;
  return runs.find((run) => {
    const other = repoOf(run);
    return other !== undefined && other !== "" && normalizeRepoPath(other) === wanted;
  });
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/** The timer seam: an injectable `setInterval` whose handle is its own cancel. */
export interface SchedulerClock {
  every(ms: number, fn: () => void): () => void;
}

export const defaultSchedulerClock: SchedulerClock = {
  every(ms, fn) {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return () => clearInterval(handle);
  },
};

export interface SchedulerDeps {
  home: string;
  runTmux: TmuxRunner;
  observer: SessionObserver;
  now?: () => number;
  intervalMs?: number;
  clock?: SchedulerClock;
  log?: (message: string) => void;
}

export interface Scheduler {
  /** One pass: settle what finished, start what is due. */
  tick(): void;
  start(): void;
  stop(): void;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? ((): number => Date.now());
  const intervalMs = deps.intervalMs ?? SCHEDULE_TICK_MS;
  const clock = deps.clock ?? defaultSchedulerClock;
  const log = deps.log ?? ((): void => { /* silent by default */ });
  let stopTimer: (() => void) | undefined;
  let running = false;
  /**
   * The slots this process DEALT WITH but could not record on disk.
   *
   * `lastFiredAt` is what normally stops the same cron minute from firing
   * twice, and it lives in a file — but a home can be read-only or full, and
   * "the write failed" must not turn into "start another session every 20
   * seconds, forever": the session cannot be un-started, so the slot it was
   * started for is remembered HERE and the tick skips it (quality round P1,
   * 2026-10-02). Entries are dropped once the stamp does land, and pruned by
   * age so a permanently broken home cannot grow the map without bound.
   */
  const unrecordedSlots = new Map<string, number>();
  /**
   * Runs that are really running but never reached the ledger, for the same
   * reason. They hold their repo and they settle exactly like a recorded run —
   * `tick` folds them into its open list.
   */
  const unrecordedRuns = new Map<string, ScheduleRunStarted>();

  /** Drop what is too old to matter: a resident process must not grow forever. */
  function pruneUnrecorded(nowMs: number): void {
    for (const [slot, atMs] of unrecordedSlots) {
      if (nowMs - atMs > UNRECORDED_TTL_MS) unrecordedSlots.delete(slot);
    }
    for (const [runId, run] of unrecordedRuns) {
      const atMs = Date.parse(run.at);
      if (Number.isFinite(atMs) && nowMs - atMs > UNRECORDED_TTL_MS) unrecordedRuns.delete(runId);
    }
  }

  /**
   * WHAT THE RUN'S OWN RECORDS SAY ABOUT IT (see `RunEvidence`).
   *
   * Asked fresh on every tick, because both answers move: the presence
   * heartbeat is renewed every 10s and lapses on its own, and a transcript
   * stops growing the moment its session does. The presence file is the SAME
   * one the fire-side guard reads (`liveSessionHolder`), asked here with the
   * run's own identity — a fresh heartbeat by SOMEBODY ELSE in that checkout is
   * not this run being alive.
   */
  function runEvidence(run: ScheduleRunStarted, repo: string | undefined, at: Date): RunEvidence {
    const holder = repo === undefined || repo === "" ? undefined : liveSessionHolder(repo, at);
    const path = deps.observer.transcriptFor(run.sessionId);
    return {
      holdsCheckout: holder !== undefined && holder.sessionId === run.sessionId,
      transcriptAt: path === undefined ? null : mtimeIso(path),
    };
  }

  /**
   * WHICH WINDOW THIS SETTLEMENT MUST CLOSE, if any.
   *
   * Two addresses for one window, in the order of what the daemon really knows:
   *
   *   1. the pane coordinates the OBSERVER read — the session is in the listing
   *      with a pane, so `kill-window` can be aimed at exactly that window;
   *   2. the coordinates the LAUNCH RECEIPT recorded, for a run whose session
   *      still holds its checkout while the observer has NO pane for it (its
   *      pane lost `@rg_sid`, which is the shape this fix is about). Without
   *      this address the daemon could not close that window at all, and the
   *      live process kept the repo occupied until the user closed it by hand.
   *
   * A fresh checkout heartbeat is what licenses the second address: it is a
   * live process in that repository, so there IS a window to close. (It also
   * bounds the damage of a stale id: a recorded window belongs to the daemon's
   * OWN scope session, where the worst case is closing a window the daemon
   * opened itself.) A run with NEITHER has nothing to close — its process is
   * gone, and tmux closes a window whose process exited — which is why a `gone`
   * settlement logs no failed close.
   */
  function closeTargetFor(
    run: ScheduleRunStarted,
    session: DaemonSession | undefined,
    evidence: RunEvidence,
    repo: string | undefined,
  ): RunWindowTarget | undefined {
    if (session !== undefined && session.tmux !== null) {
      return { repo: session.repo, session: session.tmux.session, window: session.tmux.window };
    }
    if (!evidence.holdsCheckout || run.scopeSession === undefined || run.windowId === undefined) return undefined;
    const anchor = repo ?? session?.repo ?? "";
    return anchor === "" ? undefined : { repo: anchor, session: run.scopeSession, window: run.windowId };
  }

  /** Stamp the slot as dealt with — fired, skipped or failed alike. */
  function dealt(task: ScheduledTask, at: Date, slot: string): void {
    // REMEMBER FIRST, FORGET AFTER: between these two writes the process can
    // die, and the disk can refuse both — either way the slot is known to be
    // dealt with. See `unrecordedSlots` for why that matters.
    unrecordedSlots.set(slot, at.getTime());
    let problem = "未知原因";
    // TWO ATTEMPTS, BECAUSE THE FIRST CAN LOSE A RACE: the version read here
    // can be replaced by a panel write microseconds before ours lands, and the
    // store then refuses it. A refused stamp must not park the task until the
    // TTL expires — retrying with the version just read is what makes the race
    // a retry rather than a day of silence.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = readSchedules(deps.home);
      try {
        const stamped = updateScheduledTask(deps.home, task.id, { lastFiredAt: at.toISOString() }, {
          from: "gate",
          ...(current.ok ? { expectedVersion: current.file.version } : {}),
        });
        if (stamped.ok) {
          unrecordedSlots.delete(slot);
          return;
        }
        problem = stamped.problem;
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
    }
    log(`调度任务 ${task.id} 的 lastFiredAt 没写上（只记在内存里）：${problem}`);
  }

  function skipped(task: ScheduledTask, at: Date, reason: string, slot: string): void {
    dealt(task, at, slot);
    try {
      appendScheduleRun(deps.home, { kind: "run-skipped", taskId: task.id, at: at.toISOString(), reason });
    } catch (error) {
      log(`调度任务 ${task.name} 的跳过记录没写进台账：${error instanceof Error ? error.message : String(error)}`);
    }
    log(`调度任务 ${task.name} 跳过：${reason}`);
  }

  function fire(task: ScheduledTask, at: Date, slot: string): ScheduleRunStarted | undefined {
    const runId = `run-${randomBytes(4).toString("hex")}`;
    const started = launchTask({ home: deps.home, runTmux: deps.runTmux, now: deps.now }, {
      repo: task.repo,
      task: runTaskText(task, at, runId),
      mode: "loop",
      // THE CONTRACT'S STATION IS THE CEILING the run may deliver at: the user
      // approved this task at that station, and a run may not ship further.
      station: task.contract.restatement.station,
      env: { [SCHEDULE_ID_ENV]: task.id, [SCHEDULE_RUN_ENV]: runId },
    });
    if (!started.ok || started.sessionId === undefined) {
      skipped(task, at, `起会话失败：${started.problem ?? "launchTask 没给出 sessionId"}`, slot);
      return undefined;
    }
    const run: ScheduleRunStarted = {
      kind: "run-started",
      runId,
      taskId: task.id,
      sessionId: started.sessionId,
      at: at.toISOString(),
      // THE LAUNCH RECEIPT, KEPT WITH THE RUN (see `ScheduleRunStarted`): the
      // window cannot be read back off the pane once the pane has lost
      // `@rg_sid`, and the settlement needs to close it.
      ...(started.scopeSession === undefined ? {} : { scopeSession: started.scopeSession }),
      ...(started.windowId === undefined ? {} : { windowId: started.windowId }),
    };
    // A SESSION IS ALREADY RUNNING: from here on the slot counts as dealt with
    // and this run holds its repo, whatever the disk does next.
    dealt(task, at, slot);
    try {
      appendScheduleRun(deps.home, run);
    } catch (error) {
      unrecordedRuns.set(runId, run);
      log(`运行 ${runId} 写不进台账（会话已在跑，先记在内存里）：${error instanceof Error ? error.message : String(error)}`);
    }
    log(`调度任务 ${task.name} 已发起运行 ${runId}（会话 ${started.sessionId}）`);
    return run;
  }

  function tick(): void {
    const at = new Date(now());
    const table = readSchedules(deps.home);
    if (!table.ok) {
      // A table that cannot be read is NOT an empty table: t1 refuses to
      // overwrite one, and the tick refuses to treat it as "nothing to run".
      log(`调度表读不了，这次 tick 什么都不做：${table.problem}`);
      return;
    }
    const records = readScheduleRuns(deps.home);
    // WHICH SESSIONS WERE RUNS OF OURS THAT ALREADY SETTLED. A leftover window of
    // one of those is an unfinished cleanup, not an occupant — see the guard
    // inside the loop below (quality round P2, 2026-10-02).
    const startedSessions = new Map<string, string>();
    for (const record of records) {
      if (record.kind === "run-started") startedSessions.set(record.runId, record.sessionId);
    }
    const settledSessions = new Set<string>();
    for (const record of records) {
      if (record.kind !== "run-settled") continue;
      const sessionId = startedSessions.get(record.runId);
      if (sessionId !== undefined) settledSessions.add(sessionId);
    }
    // RUNS THAT NEVER REACHED THE LEDGER ARE STILL RUNNING: the session is
    // live, so it holds its repo and it must settle like any other run.
    const open = [...openRuns(records), ...unrecordedRuns.values()];
    const repos = new Map(table.file.tasks.map((task) => [task.id, task.repo] as const));
    // THE WINDOW EACH RUN RECORDED, by session id: the receiver of a run's
    // launch receipt can be closed by coordinates even when its pane has no
    // `@rg_sid` to read them from (see `closeTargetFor` and the retry below).
    const recordedWindows = new Map<string, RunWindowTarget>();
    for (const record of records) {
      if (record.kind !== "run-started" || record.scopeSession === undefined || record.windowId === undefined) continue;
      recordedWindows.set(record.sessionId, {
        repo: repos.get(record.taskId) ?? "",
        session: record.scopeSession,
        window: record.windowId,
      });
    }

    // SETTLE FIRST: a run that just ended must release its repo in THIS tick,
    // or the slot that is due right now gets blocked by its own predecessor.
    const collection = open.length === 0 ? undefined : deps.observer.collect();
    const repoOfRun = (run: ScheduleRunStarted): string | undefined =>
      repos.get(run.taskId) ??
      // Its task is gone (deleted while the run was in flight): the session it
      // started is the only thing left that can name the checkout.
      collection?.sessions.find((candidate) => candidate.sessionId === run.sessionId)?.repo;
    const settled = new Set<string>();
    for (const run of open) {
      // ONE RUN'S FAILURE MUST NOT TAKE THE TICK WITH IT: a home that went
      // read-only, a full disk, a store that refuses a write — the daemon is
      // resident, and the run is retried on the next tick against the same
      // durable ledger.
      try {
        const session = collection?.sessions.find((candidate) => candidate.sessionId === run.sessionId);
        const repo = repoOfRun(run);
        const evidence = runEvidence(run, repo, at);
        const decision = settlementFor({ run, session, now: at, evidence });
        if (!decision.settle) continue;
        appendScheduleRun(deps.home, {
          kind: "run-settled",
          runId: run.runId,
          taskId: run.taskId,
          at: at.toISOString(),
          outcome: decision.outcome ?? "failed",
          verdict: decision.verdict,
          unmet: decision.unmet,
        });
        settled.add(run.runId);
        unrecordedRuns.delete(run.runId);
        log(`运行 ${run.runId}（任务 ${run.taskId}）结算：${decision.outcome}${decision.verdict === null ? "" : `（${decision.verdict}）`}`);
        // AND LET GO OF THE CHECKOUT (quality round P1, 2026-10-02): a session
        // holds its worktree until its PROCESS exits (`declare_done` does not
        // release it), so a settled run whose window stays open would keep its
        // repo "occupied" forever and every later run of it would be skipped.
        // The daemon opened this window; the daemon closes it — on EVERY
        // settlement, whatever the outcome (the outcome only decides what the
        // ledger says). WHICH window is `closeTargetFor`'s question.
        const target = closeTargetFor(run, session, evidence, repo);
        if (target !== undefined && !closeRunWindowAt(deps, target)) {
          log(`运行 ${run.runId} 的窗口没能关掉（它会继续占着 ${target.repo}）`);
        }
      } catch (error) {
        log(`运行 ${run.runId} 结算失败（下次 tick 再试）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const stillOpen = open.filter((run) => !settled.has(run.runId));
    for (const task of table.file.tasks) {
      try {
        const decision = dueDecision({ task, now: at, openRun: stillOpen.some((run) => run.taskId === task.id) });
        // A SLOT THE DAEMON SLEPT THROUGH IS CONSUMED, NOT ABANDONED: judging it
        // `missed` and moving on would leave `lastFiredAt` on the OLD base, so
        // every 20-second tick would judge the same stale slot missed again —
        // and the task would never run again. Consuming it is two writes: the
        // base moves forward (the same `dealt` stamp a fired slot gets) and the
        // ledger keeps WHY nothing ran.
        //
        // THE STAMP IS `now`, NOT THE SLOT THAT WAS LOST: the next slot is
        // counted from the stamp, so `now` is what lines the schedule up with
        // real time in ONE step. Stamping the lost slot instead would leave the
        // base a period behind and the NEXT slot due at once — a skip per tick
        // until it caught up. Neither choice breaks "one slot is dealt with
        // once": that rule reads `lastFiredAt`, and the tick that stamps a slot
        // is the only one that ever judges it.
        if (decision.reason === "missed" && decision.missedAt !== null) {
          // TWO WAYS A SLOT IS MISSED, AND THE LEDGER NAMES BOTH: the daemon was
          // not running at all, or the task's OWN run was still open when the
          // slot arrived and settled later (that settlement is what finally
          // moves this base — `open-run` only says "nothing starts at THIS
          // instant", not "nothing was running at that one"). A reason that
          // named only the first would be wrong for the second.
          const reason =
            `错过时点 ${decision.missedAt.toISOString()}：那一槽到达时没有启动运行（daemon 当时不在跑，` +
            "或本任务自己还有一次运行没结算），按用户决定跳过不补跑 —— 下一个到点照常跑";
          const stale = slotKey(task.id, decision.missedAt);
          // ONE LEDGER LINE PER SLOT EVEN WHEN THE STAMP CANNOT BE WRITTEN: a
          // failed stamp leaves the slot in `unrecordedSlots`, and the retry
          // below keeps re-attempting the stamp (without it the task stays
          // pinned to the old base) while the skip is not written twice.
          if (unrecordedSlots.has(stale)) dealt(task, at, stale);
          else skipped(task, at, reason, stale);
          continue;
        }
        if (!decision.due) continue;
        const slot = slotKey(task.id, decision.scheduledAt);
        // THE SAME SLOT IS NOT STARTED TWICE, even when nothing can be
        // written: a session that was started but not recorded would otherwise
        // be started again on every tick, forever.
        if (unrecordedSlots.has(slot)) {
          log(`调度任务 ${task.name} 的这个时间点已经起过会话、只是没能落盘（写不进去），本次不重复启动`);
          continue;
        }
        const holder = repoHolder(stillOpen, task.repo, repoOfRun);
        if (holder !== undefined) {
          skipped(task, at, `repo ${task.repo} 上还有未结算的运行 ${holder.runId}（任务 ${holder.taskId}，${holder.at} 起）—— 两个写者不能同时进同一个 checkout`, slot);
          continue;
        }
        // ANOTHER SESSION'S CHECKOUT IS NO MORE SHARABLE THAN ANOTHER RUN'S.
        // The gate will REFUSE to arm the session this tick would start, and a
        // session that cannot arm cannot adopt its contract: it would sit on
        // L8 with every edit blocked. Skip it (recorded, with the occupant's
        // name) instead of starting a run that cannot work — the user's own
        // window counts here even after `declare_done`: the holder is whoever
        // still has the process.
        const sessionHolder = liveSessionHolder(task.repo, at);
        if (sessionHolder !== undefined) {
          // A LEFTOVER WINDOW OF OURS IS NOT AN OCCUPANT FOREVER (quality round
          // P2, 2026-10-02): closing a settled run's window is BEST-EFFORT — the
          // settlement must never depend on tmux — so a close that failed, or a
          // process killed between the two, left a window holding this repo
          // with nothing left to retry it. Here is the retry: the one place
          // that already has to name the occupant.
          if (settledSessions.has(sessionHolder.sessionId)) {
            const leftover = (collection ?? deps.observer.collect()).sessions
              .find((candidate) => candidate.sessionId === sessionHolder.sessionId);
            // THE SAME TWO ADDRESSES THE SETTLEMENT USED: the pane's, when the
            // observer has one, and otherwise the coordinates the launch
            // receipt recorded — a session that lost `@rg_sid` is exactly the
            // one whose leftover window would otherwise never be reclaimed.
            const recorded = recordedWindows.get(sessionHolder.sessionId);
            const target: RunWindowTarget | undefined = leftover !== undefined && leftover.tmux !== null
              ? { repo: leftover.repo, session: leftover.tmux.session, window: leftover.tmux.window }
              : recorded !== undefined && recorded.repo !== "" ? recorded : undefined;
            if (target !== undefined && closeRunWindowAt(deps, target)) {
              log(`上一次结算没关掉的运行窗口 ${sessionHolder.sessionId} 已补关（${task.repo}）—— 下一个时间点起可以正常跑`);
            }
          }
          skipped(task, at, `repo ${task.repo} 上还有别的活会话 ${sessionHolder.sessionId}（最后心跳 ${sessionHolder.at}）占着这块 worktree —— 门禁不会为运行会话启动，契约继承不了（关掉那个会话，或等它的心跳过期）`, slot);
          continue;
        }
        // A RUN STARTED IN THIS TICK IS OPEN TOO: without adding it, two tasks in
        // one repo that are both due would both start here — the second seeing a
        // `stillOpen` computed before the first one existed.
        const run = fire(task, at, slot);
        if (run !== undefined) stillOpen.push(run);
      } catch (error) {
        log(`调度任务 ${task.id} 处理失败（下次 tick 再试）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    pruneUnrecorded(at.getTime());
  }

  return {
    tick,
    start() {
      if (stopTimer !== undefined) return;
      guardTick();
      stopTimer = clock.every(intervalMs, guardTick);
    },
    stop() {
      if (stopTimer !== undefined) stopTimer();
      stopTimer = undefined;
    },
  };

  /**
   * A tick a RESIDENT process can survive.
   *
   * The store's append-only ledger throws on a home it cannot write, and an
   * uncaught throw out of a timer callback is a daemon that dies and does not
   * come back by itself — one full disk would take the whole machine's session
   * supervision with it. The throw is logged and the next tick tries again
   * against the same durable state.
   */
  function guardTick(): void {
    if (running) return;
    running = true;
    try {
      tick();
    } catch (error) {
      log(`调度 tick 失败（下次再试）：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  }
}

/** A file's mtime as ISO, or `null` when it cannot be read. */
function mtimeIso(path: string): string | null {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

/**
 * A slot's identity: the task plus the CRON INSTANT, never the tick's clock.
 * Two ticks inside one minute must name the same slot — that is the whole
 * point of remembering it — while the next cron minute is a different slot.
 */
function slotKey(taskId: string, scheduledAt: Date | null): string {
  return `${taskId}@${scheduledAt === null ? "" : scheduledAt.getTime()}`;
}

/**
 * THE LIVE SESSION HOLDING THIS CHECKOUT, if there is one.
 *
 * A scheduled run is an ORDINARY loop session: it arms the gate in the
 * checkout, and the gate refuses to arm a second session in a worktree someone
 * else holds (lib/session-exclusivity.ts, `.pi/session-presence.json`, a 10s
 * heartbeat with a 60s window). A run that cannot arm cannot adopt its contract
 * either — `adoptScheduledRunContract` fails closed when it cannot persist — so
 * it would sit there with L8 blocking every edit while the ledger called it
 * "running", and the user would see none of it. THAT IS WHY THE SCHEDULER ASKS
 * BEFORE IT FIRES (quality round P1, 2026-10-02): the same question the session
 * itself will ask, through the SAME function, so the two cannot drift.
 *
 * It is asked with the RUN's identity, not the daemon's: an ordinary loop
 * session claims the main sidecar, so the only thing that can refuse it is a
 * fresh heartbeat by somebody else — and the fail-open direction is the
 * function's own (a missing, unreadable or nonsensical record is nobody).
 *
 * WHAT THIS DOES NOT CLOSE, said plainly: the session asks the SAME question
 * again a few seconds later (pi's cold start), and a session that claims this
 * checkout inside that window still lands in the failure this guard exists to
 * avoid. The answer is not a bigger guard — the window is inherent — but the
 * doc says so (docs/daemon/api.md §13.7) rather than promising the absence of a
 * state that can still happen.
 */
export function liveSessionHolder(repo: string, now: Date): PresenceRecord | undefined {
  let raw: string | undefined;
  try {
    raw = readFileSync(join(repo, ".pi", PRESENCE_FILENAME), "utf8");
  } catch {
    return undefined; // no record = nobody claims this checkout
  }
  const verdict = checkSessionExclusivity({
    env: { [GATE_MODE_ENV]: "loop" },
    // The run's session id does not exist yet, so it is neither the holder nor
    // the holder's heir — exactly the question "is somebody else in here".
    sessionId: undefined,
    existing: parsePresence(raw),
    repoRoot: repo,
    now: now.getTime(),
  });
  return verdict.ok ? undefined : verdict.holder;
}

/** The opening message a scheduled run starts with. */
export function runTaskText(task: ScheduledTask, at: Date, runId: string): string {
  return [
    `这是定时任务 ${task.name} 的一次运行（${runId}，${at.toISOString()} 发起）：${task.requirement}`,
    "",
    "本次运行的契约（用户已批准）见 `.pi/loop-goal.md`（门禁会在 session_start 继承它）。" +
      "干完活按门禁流程走：有代码改动就 `judge_submit` 送 reviewer，READY 之后才 `declare_done`。",
  ].join("\n");
}
