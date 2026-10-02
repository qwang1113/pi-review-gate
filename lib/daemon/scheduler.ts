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
 * ── WHAT "DUE" MEANS (2026-10-03) ──
 *
 * Counting the next slot from `now` would be useless for firing: a brand-new
 * task's first slot would always be one period away, so a task that never ran
 * would never run. The schedule counts from `lastFiredAt ?? createdAt`, so the
 * first slot is the first cron minute after the task was AUTHORED (authored
 * 08:59 for `0 9 * * *` ⇒ fires at 09:00).
 *
 * A SLOT THE DAEMON SLEPT THROUGH IS RUN, NOT DISCARDED (2026-10-03, user
 * decision — it replaced "missed slots are skipped, not replayed"). A machine
 * that was off, or a daemon that was restarting, no longer loses the slot: it
 * is still the task's next slot when the daemon comes back, and the next tick
 * runs it. Only ONE slot can ever be owed — `nextRunAfter` always answers with
 * the single slot after `lastFiredAt`, so a week of downtime produces one run,
 * never seven ("the user's rule: run it unless it genuinely cannot be run").
 * Reloaded slots are never CATCH-UP CATCH-UP: from that one run onward the
 * base is `now` and the ordinary rhythm resumes.
 *
 * The only thing that stops a due slot is the task's OWN run being unsettled
 * (`open-run`) — and that slot is not consumed either: it is judged again on
 * the tick that finds the run settled.
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
 * still holds its checkout and still settles. Both maps are pruned by age, which
 * is what lets a permanently broken home recover rather than grow forever.
 * The window this leaves is the one between the stamp landing and the append:
 * a process killed there leaves a RUNNING session with no `run-started` line,
 * so a restart neither settles it nor finds it in the ledger. THAT SESSION
 * STILL HOLDS ITS CHECKOUT, though — in the way the ledger cannot see: it writes
 * the checkout's presence heartbeat, which is what {@link liveSessionHolder}
 * answers with, and that heartbeat is what keeps the run from being read as
 * "gone" while its process is still there. The other
 * order is the fail-spin the quality round measured — one real session per
 * tick, forever — which is strictly worse.
 *
 * A version that was taken mid-write is RETRIED, not parked: the panel's `PUT`
 * can replace the table between our read and our write, and the store then
 * refuses the stamp ("请重读"). That is a race, so the stamp tries again with
 * the version it just read — otherwise one colliding panel edit would leave
 * the task believing its slot was dealt with while `lastFiredAt` never moved.
 *
 * ── WHY A RUN GETS ITS OWN CHECKOUT (2026-10-03) ──
 *
 * Two writers in one checkout overwrite each other (the invariant
 * lib/session-worktree.ts enforces for orchestration children) — which is why
 * a run used to be SKIPPED whenever the main repo had another live session, or
 * an earlier run of any task in that repo had not settled. That answer cost
 * six slots in one day on this machine. It is gone: every run works in its own
 * checkout cut from the main repo's HEAD (lib/schedule-worktree.ts), so the
 * main repo's occupants stop being a reason to skip. The one writer rule is
 * still enforced where it matters — inside the run's own checkout.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { nextRunAfter } from "../cron-schedule.ts";
import { STATION_CAP_ENV } from "../repo-pr-policy.ts";
import {
  checkSessionExclusivity,
  parsePresence,
  PRESENCE_FILENAME,
  type PresenceRecord,
} from "../session-exclusivity.ts";
import { GATE_MODE_ENV } from "../task-mode.ts";
import { createScheduleWorktree, settleScheduleWorktree, type CutScheduleWorktree, type ScheduleSettlement, type ScheduleWorktreeOwner } from "../schedule-worktree.ts";
import type { DeliveryStation } from "../delivery-station.ts";
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

export type DueReason = "due" | "disabled" | "not-yet" | "already-dealt" | "open-run" | "bad-time" | "bad-cron";

export interface DueDecision {
  due: boolean;
  /**
   * The slot this decision is about; `null` when the schedule cannot name one.
   * A `due` slot is one that has arrived — possibly long ago, while the daemon
   * was down: an owed slot keeps its identity until a run consumes it.
   */
  scheduledAt: Date | null;
  reason: DueReason;
}

/**
 * May this task start now?
 *
 * `openRun` is the caller's answer to "does this task have a run that has not
 * settled" — a second run of the SAME task would mean two sessions racing on
 * one goal.
 *
 * THE FOUR WORDS A SLOT CAN HAVE: `not-yet` (still ahead), `due` (arrived —
 * including one that arrived while the daemon was not running, which is now
 * RUN rather than discarded), `open-run` (the task's own run has not settled;
 * it is not this slot's turn yet — and the slot is KEPT, not consumed), and
 * the schedule's own failures (`bad-time` / `bad-cron`). A task still running
 * keeps `open-run` even for a slot that is long past — consuming that slot
 * belongs to the tick that finds the run settled.
 *
 * THE ONE PLACE `scheduledAt` MAY BE OLD is exactly the owed slot: a slot that
 * arrived while the daemon was down stays `due` however late the tick is, and
 * `schedule_task({action:"list"})` renders it as overdue rather than promising
 * a tick it would skip. That is honest — the run some tick is about to start
 * IS for that slot.
 */
export function dueDecision(input: { task: ScheduledTask; now: Date; openRun: boolean }): DueDecision {
  const task = input.task;
  if (task?.enabled !== true) return { due: false, scheduledAt: null, reason: "disabled" };
  const base = task.lastFiredAt ?? task.createdAt;
  if (!Number.isFinite(Date.parse(base))) {
    return { due: false, scheduledAt: null, reason: "bad-time" };
  }
  const scheduledAt = nextRunAfter(task.cron, new Date(base));
  if (scheduledAt === null) return { due: false, scheduledAt: null, reason: "bad-cron" };
  const dealtAt = task.lastFiredAt === null ? undefined : Date.parse(task.lastFiredAt);
  // UNREACHABLE TODAY, KEPT AS A GUARD: `nextRunAfter` is STRICTLY later than
  // its base, and the base IS `lastFiredAt` whenever this branch could fire — so
  // a stamp can never sit at or after the slot counted from it. It would take a
  // future base other than `lastFiredAt` to reach this, and the rule it states
  // ("a slot at or behind the stamp is already dealt with") is the one that must
  // hold if that ever changes. One slot, dealt with once.
  if (dealtAt !== undefined && dealtAt >= scheduledAt.getTime()) {
    return { due: false, scheduledAt, reason: "already-dealt" };
  }
  const nowMs = input.now.getTime();
  if (scheduledAt.getTime() > nowMs) return { due: false, scheduledAt, reason: "not-yet" };
  if (input.openRun) return { due: false, scheduledAt, reason: "open-run" };
  // LATE IS NOT LOST (2026-10-03, user decision): a slot that arrived while the
  // daemon was down is still the task's owed slot, and running it is the point.
  // Whatever lateness the old grace window used to reject is now just lateness.
  return { due: true, scheduledAt, reason: "due" };
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
  /**
   * THE RUN'S OWN CHECKOUT, INJECTED — the same seam shape the rest of this
   * module uses (`runTmux`, `observer`, `now`, `clock`).
   *
   * Production uses lib/schedule-worktree.ts unchanged; a tick test injects a
   * fake so it can exercise "the checkout could not be cut, so the slot stays
   * owed" and "a finished run lands here" without a real repository on disk.
   * The real git behaviour has its own tests (test/schedule-worktree.test.ts),
   * where a real repo is the point.
   */
  worktrees?: {
    cut: (input: { repo: string; runId: string }) => CutScheduleWorktree;
    settle: (input: { worktree: ScheduleWorktreeOwner; outcome: ScheduleRunOutcome; station: DeliveryStation }) => ScheduleSettlement;
  };
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
  const worktrees = deps.worktrees ?? { cut: createScheduleWorktree, settle: settleScheduleWorktree };
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
  /**
   * The slots this process TRIED and could not start, for a reason that may
   * pass (a full disk, a repo mid-rebuild, a tmux server that is starting up).
   *
   * Nothing is stamped for these — the slot is OWED and the next tick tries
   * again — so this map exists only to keep one failed attempt from printing
   * the same log line every 20 seconds. An entry is dropped the moment its slot
   * is dealt with, and pruned by age like `unrecordedSlots`.
   */
  const deferredSlots = new Map<string, number>();

  /** Drop what is too old to matter: a resident process must not grow forever. */
  function pruneUnrecorded(nowMs: number): void {
    for (const [slot, atMs] of unrecordedSlots) {
      if (nowMs - atMs > UNRECORDED_TTL_MS) unrecordedSlots.delete(slot);
    }
    for (const [slot, atMs] of deferredSlots) {
      if (nowMs - atMs > UNRECORDED_TTL_MS) deferredSlots.delete(slot);
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
   * stops growing the moment its session does. The heartbeat lives in THE RUN'S
   * OWN CHECKOUT (2026-10-03) — ask the main repo and every run would look dead
   * the moment the observer cannot place its session, which is exactly the case
   * this evidence exists for. A heartbeat by SOMEBODY ELSE there is not this
   * run being alive either.
   */
  function runEvidence(run: ScheduleRunStarted, repo: string | undefined, at: Date): RunEvidence {
    const checkout = run.worktree ?? repo;
    const holder = checkout === undefined || checkout === "" ? undefined : liveSessionHolder(checkout, at);
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
    deferredSlots.delete(slot);
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
    // THE SESSION ID IS DECIDED HERE, not inside `launchTask` (2026-10-03): the
    // run's ledger line must exist BEFORE the process starts (see below).
    const sessionId = randomUUID();
    // THE CHECKOUT FIRST (2026-10-03): the run works in its own copy of the
    // repo, so cutting that copy is part of STARTING it. A checkout that cannot
    // be cut is a TEMPORARY obstacle (a full disk, a repo mid-rebuild): nothing
    // is stamped, the slot stays owed, and the next tick tries again.
    const cut = worktrees.cut({ repo: task.repo, runId });
    if (!cut.ok) {
      const reason = `切隔离 checkout 失败：${cut.problem}`;
      if (cut.permanent === true) {
        // NO RETRY CAN FIX THESE — the repo is gone, or has no git in it. The
        // slot is consumed and the ledger says why, instead of promising a tick
        // that will fail the same way every 20 seconds (2026-10-03).
        skipped(task, at, reason, slot);
      } else {
        deferred(task, at, slot, reason);
      }
      return undefined;
    }
    // THE LEDGER LINE COMES FIRST (2026-10-03, reviewer P1): the session adopts
    // its contract at `session_start`, and adoption asks the ledger whether this
    // session IS this run — so the line has to be there before the process can
    // possibly ask. Writing it after the launch left a real window in which a
    // scheduled run started with no contract at all (pi's cold start is seconds;
    // the write is one line).
    const run: ScheduleRunStarted = {
      kind: "run-started",
      runId,
      taskId: task.id,
      sessionId,
      at: at.toISOString(),
      // THE RUN'S OWN CHECKOUT, IN THE LEDGER (lib/schedule-worktree.ts settles
      // it by exactly these four facts, and the contract adoption reads the
      // owner record they point at).
      worktree: cut.worktree.path,
      branch: cut.worktree.branch,
      base: cut.worktree.base,
    };
    try {
      appendScheduleRun(deps.home, run);
    } catch (error) {
      // The disk is broken: the session is about to be real, so it is
      // remembered in memory instead — it still holds its checkout and it still
      // settles.
      unrecordedRuns.set(runId, run);
      log(`运行 ${runId} 写不进台账（会话即将在跑，先记在内存里）：${error instanceof Error ? error.message : String(error)}`);
    }
    const started = launchTask({ home: deps.home, runTmux: deps.runTmux, now: deps.now }, {
      repo: task.repo,
      // THE RUN'S OWN CHECKOUT, NEVER THE MAIN REPO — this is what makes the
      // user's own session there stop blocking the task.
      workdir: cut.worktree.path,
      sessionId,
      task: runTaskText(task, at, runId),
      mode: "loop",
      // THE CONTRACT'S STATION IS THE CEILING the run may deliver at: the user
      // approved this task at that station, and a run may not ship further.
      station: task.contract.restatement.station,
      env: { [SCHEDULE_ID_ENV]: task.id, [SCHEDULE_RUN_ENV]: runId },
    });
    if (!started.ok || started.sessionId === undefined) {
      const problem = started.problem ?? "launchTask 没给出 sessionId";
      // A RUN THAT NEVER HAPPENED MUST NOT STAY OPEN: the line above is settled
      // right here, so nothing waits on a session that does not exist.
      try {
        appendScheduleRun(deps.home, {
          kind: "run-settled",
          runId,
          taskId: task.id,
          at: at.toISOString(),
          outcome: "gone",
          verdict: null,
          unmet: [],
          landing: `会话没能起来（${problem}）`,
        });
      } catch (error) {
        log(`运行 ${runId} 的失败没能记进台账：${error instanceof Error ? error.message : String(error)}`);
      }
      unrecordedRuns.delete(runId);
      // THE CHECKOUT GOES BACK — it holds nothing and no session was ever
      // started in it.
      try {
        worktrees.settle({ worktree: cut.worktree, outcome: "failed", station: task.contract.restatement.station });
      } catch (error) {
        log(`运行 ${runId} 的隔离 checkout 没能回收：${error instanceof Error ? error.message : String(error)}`);
      }
      if (started.permanent === true) {
        // A PERMANENT obstacle (no tmux to run at all): retrying every 20 s
        // would burn the schedule on something no retry can repair. The slot is
        // consumed and the ledger names the reason.
        skipped(task, at, `起会话失败（永久障碍）：${problem}`, slot);
      } else {
        deferred(task, at, slot, `起会话失败：${problem}`);
      }
      return undefined;
    }
    // A SESSION IS ALREADY RUNNING: from here on the slot counts as dealt with
    // and this run holds its checkout, whatever the disk does next.
    dealt(task, at, slot);
    // …AND WHERE ITS WINDOW IS, in a SECOND line (2026-10-03): the coordinates
    // did not exist when the `run-started` line had to be written. Best-effort —
    // a run with no coordinates is closed the only remaining way, when its
    // process exits and tmux reclaims the window.
    if (started.scopeSession !== undefined && started.windowId !== undefined) {
      try {
        appendScheduleRun(deps.home, {
          kind: "run-window",
          runId,
          taskId: task.id,
          sessionId,
          at: at.toISOString(),
          scopeSession: started.scopeSession,
          windowId: started.windowId,
        });
      } catch (error) {
        log(`运行 ${runId} 的窗口坐标没能记进台账：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    log(`调度任务 ${task.name} 已发起运行 ${runId}（会话 ${started.sessionId}）`);
    return run;
  }

  /**
   * A slot that could NOT be run, for a reason that may pass.
   *
   * The slot is KEPT — nothing is stamped, nothing is written to the ledger —
   * so the next tick, 20 seconds later, tries again, and a daemon restart
   * changes nothing because nothing was written. The log line is printed ONCE
   * per slot: a disk that stays full for an hour must not produce 180 identical
   * lines.
   */
  function deferred(task: ScheduledTask, at: Date, slot: string, reason: string): void {
    const first = !deferredSlots.has(slot);
    deferredSlots.set(slot, at.getTime());
    if (first) log(`调度任务 ${task.name} 本次没能起成（${reason}）—— 这个时间点留着，下一次 tick 再试`);
  }

  /**
   * WHERE A FINISHED RUN'S OUTPUT LANDS — the ONE call site of the rule
   * (lib/schedule-worktree.ts). A run whose record predates isolated checkouts
   * has no `worktree`, and nothing is settled for it: its output is wherever it
   * always was.
   */
  function settleRunWorktree(
    run: ScheduleRunStarted,
    outcome: ScheduleRunOutcome,
    station: DeliveryStation,
    repo: string | undefined,
  ): ScheduleSettlement | undefined {
    if (run.worktree === undefined || run.branch === undefined || run.base === undefined) return undefined;
    if (repo === undefined || repo === "") return undefined;
    try {
      const settlement = worktrees.settle({
        worktree: { repo, runId: run.runId, branch: run.branch, base: run.base, path: run.worktree },
        outcome,
        station,
      });
      log(`运行 ${run.runId} 的隔离 checkout 已结算：${settlement.action} —— ${settlement.note}`);
      return settlement;
    } catch (error) {
      log(`运行 ${run.runId} 的隔离 checkout 结算失败（目录留在 ${run.worktree}）：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
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
    // RUNS THAT NEVER REACHED THE LEDGER ARE STILL RUNNING: the session is
    // live, so it holds its repo and it must settle like any other run.
    const open = [...openRuns(records), ...unrecordedRuns.values()];
    const repos = new Map(table.file.tasks.map((task) => [task.id, task.repo] as const));
    // WHICH STATION EACH TASK'S RUN DELIVERS AT: the settlement needs it to
    // decide where a finished checkout's output lands (lib/schedule-worktree.ts).
    const stations = new Map(table.file.tasks.map((task) => [task.id, task.contract.restatement.station] as const));

    // SETTLE FIRST: a run that just ended must release its repo in THIS tick,
    // or the slot that is due right now gets blocked by its own predecessor.
    const collection = open.length === 0 ? undefined : deps.observer.collect();
    const repoOfRun = (run: ScheduleRunStarted): string | undefined =>
      repos.get(run.taskId) ??
      // Its task is gone (deleted while the run was in flight): the session it
      // started is the only thing left that can name the checkout.
      collection?.sessions.find((candidate) => candidate.sessionId === run.sessionId)?.repo;
    const settled = new Set<string>();
    // WHERE EACH OPEN RUN'S WINDOW IS, by run id: `run-started` cannot carry it
    // any more (that line must exist before the session starts), so the
    // `run-window` line written a moment later is what a settlement closes a
    // pane-less window by (2026-10-03).
    const windows = new Map<string, { scopeSession: string; windowId: string }>();
    for (const record of records) {
      if (record.kind === "run-window") {
        windows.set(record.runId, { scopeSession: record.scopeSession, windowId: record.windowId });
      }
    }
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
        // WHERE THE RUN'S OUTPUT LANDS IS DECIDED HERE, ONCE (2026-10-03): its
        // own checkout is settled — recycled whole when it produced nothing,
        // merged (staged) into the main repo when it concluded READY below the
        // `pr` station, kept as a branch otherwise. The note goes into the
        // ledger so the panel and `schedule_task({action:"list"})` can say which
        // branch holds it.
        const settlement = settleRunWorktree(run, decision.outcome ?? "failed", stations.get(run.taskId) ?? "precommit", repo);
        appendScheduleRun(deps.home, {
          kind: "run-settled",
          runId: run.runId,
          taskId: run.taskId,
          at: at.toISOString(),
          outcome: decision.outcome ?? "failed",
          verdict: decision.verdict,
          unmet: decision.unmet,
          ...(settlement === undefined || settlement.action === "reclaimed"
            ? {}
            : { branch: settlement.branch, landing: settlement.note }),
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
        // WHICH WINDOW TO CLOSE: the pane's coordinates when the observer has
        // them, else the ones recorded with the run (an older record may carry
        // them on `run-started` itself; a new one has a `run-window` line).
        const recorded = windows.get(run.runId);
        const withWindow: ScheduleRunStarted = run.scopeSession !== undefined || recorded === undefined
          ? run
          : { ...run, ...recorded };
        const target = closeTargetFor(withWindow, session, evidence, repo);
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
        // (A slot the daemon slept through is no longer CONSUMED here: it stays
        // owed and the `due` branch below runs it — see `dueDecision`.)
        if (!decision.due) continue;
        const slot = slotKey(task.id, decision.scheduledAt);
        // THE SAME SLOT IS NOT STARTED TWICE, even when nothing can be
        // written: a session that was started but not recorded would otherwise
        // be started again on every tick, forever.
        if (unrecordedSlots.has(slot)) {
          log(`调度任务 ${task.name} 的这个时间点已经起过会话、只是没能落盘（写不进去），本次不重复启动`);
          continue;
        }
        // NOTHING ASKS "IS SOMEBODY ELSE IN THE REPO" ANY MORE (2026-10-03): the
        // run works in its own checkout now (lib/schedule-worktree.ts), so the
        // user's session in the main repo — or another run of any task in it —
        // stopped being a reason to skip. That check cost six slots in one day
        // on this machine. The only writer rule that survives is inside the
        // run's checkout, and "one run per checkout" holds by construction.
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
 * WHAT ASKS IT NOW (2026-10-03): {@link runEvidence}, answering "is the process
 * behind this run still there" when the observer cannot place its session at
 * all — the run's own heartbeat in ITS OWN checkout is the fact that keeps a
 * live run from being settled as `gone`. It is asked with the run's own
 * identity: a fresh heartbeat by SOMEBODY ELSE in that checkout is not this run
 * being alive.
 *
 * WHAT USED TO ASK IT: the scheduler's fire-side guard. A run worked in the
 * main repo, so a fresh heartbeat there meant "somebody else is in this
 * checkout" and the slot was skipped — the session could not arm (the gate
 * refuses a second session in one worktree) and could not adopt its contract
 * either, so sending it would have been a car that cannot drive (quality round
 * P1, 2026-10-02). Every run has its own checkout now (lib/schedule-worktree.ts)
 * and that conflict cannot happen, so nothing asks this question before firing.
 * WHERE IT IS ASKED, AND WHAT IT ANSWERS NOW (2026-10-03). It used to be the
 * scheduler's OWN fire-side guard: a fresh heartbeat in the MAIN repo meant
 * "somebody else is in this checkout", and the slot was skipped — with the
 * session's own refusal to arm as the justification. No more: the run works in
 * its own checkout ({@link runEvidence}), so nothing asks this question before
 * firing. What survives is the EVIDENCE role — "is the process behind this run
 * still there?" — and for that the two facts are equivalent: a missing,
 * unreadable or nonsensical record is nobody.
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
