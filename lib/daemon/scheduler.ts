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
 * cannot be written at all (read-only home, full disk) the run is kept in
 * `unrecordedRuns` — this process only — so the run still holds its checkout
 * and still settles. That map is pruned by age, which is what lets a permanently broken home recover rather than grow forever.
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
import { existsSync, readFileSync, statSync } from "node:fs";
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
  scheduleContractProblem,
  updateScheduledTask,
  type ScheduledTask,
  type ScheduleRunArmed,
  type ScheduleRunOutcome,
  type ScheduleRunRecord,
  type ScheduleRunStarted,
} from "../schedule-store.ts";
import { launchTask, closeRunWindowAt, type RunWindowTarget } from "./control.ts";
import { currentTmuxServer } from "../tmux-exec.ts";
import type { SessionObserver, DaemonSession } from "./sessions.ts";
import { TRANSCRIPT_ACTIVE_MS } from "./sessions.ts";
import type { TmuxRunner } from "../orchestrator-tmux.ts";

/** How often the daemon looks for work. */
export const SCHEDULE_TICK_MS = 20_000;

/**
 * How long a slot / a run that could NOT be written to disk is remembered in
 * memory (see `deferredSlots`). One day is far longer than any real repair
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
    settle: (input: {
      worktree: ScheduleWorktreeOwner;
      outcome: ScheduleRunOutcome;
      /** `undefined` when the task is gone: the settlement then keeps the output. */
      station: DeliveryStation | undefined;
    }) => ScheduleSettlement;
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
   * The armings this process already cleaned up. The ledger's arming lines are
   * PERMANENT (nothing rewrites that file), so this set has to live as long as the
   * process does: per-tick it would re-probe every historical arming every 20
   * seconds, and the ledger only grows (reviewer P2, 2026-10-03).
   */
  const cleanedArms = new Set<string>();
  /**
   * Runs that are really running but never reached the ledger, because the disk
   * refused the write. They hold their checkout and they settle exactly like a
   * recorded run — `tick` folds them into its open list. (A SLOT whose stamp
   * could not be written has no such memory any more: `dealt` failing means no
   * session is started at all, so the slot is simply still owed and the next
   * tick retries it — the stale "already started one" guard this map used to
   * back was removed with that change, 2026-10-03.)
   */
  const unrecordedRuns = new Map<string, ScheduleRunStarted>();
  /**
   * The slots this process TRIED and could not start, for a reason that may
   * pass (a full disk, a repo mid-rebuild, a tmux server that is starting up).
   *
   * Nothing is stamped for these — the slot is OWED and the next tick tries
   * again — so this map exists only to keep one failed attempt from printing
   * the same log line every 20 seconds. An entry lives as long as the process
   * does (pruned only by age, `UNRECORDED_TTL_MS`): a slot that fails, is
   * stamped, and then fails again on the launch comes back under the SAME key,
   * and dropping the entry in between is exactly what would make that retry log
   * again (quality round P2, 2026-10-03).
   */
  const deferredSlots = new Map<string, number>();
  /**
   * The tasks whose schedule can NEVER produce a slot, already said in the ledger
   * (2026-10-03, reviewer P1): a cron that resolves to no instant at all
   * (`0 0 30 2 *`), an unreadable base. There is no slot to consume for these —
   * `dueDecision` cannot name a next cron time — so a `run-skipped` line is the
   * only place a user can see WHY the task never runs, recorded once per task per
   * process (the condition cannot change by itself).
   */
  const notedBroken = new Set<string>();
  /**
   * The disabled tasks whose `run-skipped` line is already in the ledger
   * (2026-10-03): `enabled:false` is one of the four permanent obstacles, so its
   * history is written — once per task per process, because the condition cannot
   * change by itself and the ledger only grows. A SEPARATE set from the one
   * ABOVE, because a task can be disabled first and then have a broken cron:
   * sharing one set meant that second, ledger-worthy condition was silenced
   * forever.
   */
  const notedDisabled = new Set<string>();

  /** Drop what is too old to matter: a resident process must not grow forever. */
  function pruneUnrecorded(nowMs: number): void {
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

  /**
   * Stamp the slot as dealt with — fired, skipped or failed alike.
   *
   * `false` = the stamp could NOT be persisted, and the caller must then NOT
   * start anything: a slot that is not consumed on disk would be run again after
   * a restart, and the ledger's own record of that run is gone by then (or never
   * existed). That duplicate is the whole reason this stamp exists (reviewer P1,
   * 2026-10-03).
   */
  function dealt(task: ScheduledTask, at: Date, slot: string): boolean {
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
          // THE DE-NOISING ENTRY STAYS PUT (quality round P2, 2026-10-03): the
          // same slot key comes back along the retry path (stamp OK → launch
          // fails → `deferred`), and dropping it here made every one of those
          // retries log again — `pruneUnrecorded` is what eventually clears it.
          return true;
        }
        problem = stamped.problem;
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
    }
    log(`调度任务 ${task.id} 的 lastFiredAt 没写上：${problem}`);
    return false;
  }

  /**
   * Put the slot back after a launch that never happened.
   *
   * The stamp is written BEFORE the launch (a run must never start for a slot
   * that is still owed), so a launch that fails has to undo it — otherwise a
   * TEMPORARY obstacle would silently consume the slot, which is exactly what
   * "run it unless it genuinely cannot be run" forbids. A rollback that itself
   * fails costs that one slot, and says so.
   */
  function rollbackStamp(task: ScheduledTask, slot: string): boolean {
    try {
      // WITH THE VERSION IT JUST READ, like every other write in this file: a
      // rollback is still a write, and it must not clobber a panel edit that
      // landed while the launch was failing.
      const current = readSchedules(deps.home);
      const back = updateScheduledTask(deps.home, task.id, { lastFiredAt: task.lastFiredAt }, {
        from: "gate",
        ...(current.ok ? { expectedVersion: current.file.version } : {}),
      });
      // THE REFUSAL IS A VALUE, NOT A THROW: a version conflict comes back as
      // `{ok:false}`, and a slot silently lost to one would be exactly the
      // silent consumption this function exists to undo.
      if (!back.ok) {
        log(`调度任务 ${task.id} 的槽戳没能回滚（这一槽被消费）：${back.problem}`);
        return false;
      }
      return true;
    } catch (error) {
      log(`调度任务 ${task.id} 的槽戳没能回滚（这一槽被消费）：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  function skipped(task: ScheduledTask, at: Date, reason: string, slot: string, runId?: string): void {
    // THE SKIP IS RECORDED ONLY ONCE THE SLOT IS ACTUALLY SPENT (2026-10-03,
    // reviewer P1): a stamp that could not be written leaves the slot OWED, and
    // the next tick will make this same decision — recording it every 20 seconds
    // would fill the ledger with copies of one judgement.
    if (!dealt(task, at, slot)) return;
    try {
      appendScheduleRun(deps.home, {
        kind: "run-skipped",
        taskId: task.id,
        at: at.toISOString(),
        reason,
        // WHICH RUN CONSUMED THE SLOT, when there was one: the arming cleanup
        // reads this to know the stamp is already explained (reviewer P0).
        ...(runId === undefined ? {} : { runId }),
      });
    } catch (error) {
      // A CONSUMED SLOT WITH NO LINE LOSES ITS REASON FOREVER (reviewer P1,
      // 2026-10-03): the stamp goes back so the decision is made again on the
      // next tick. When even THAT fails, the one remaining evidence is the log —
      // and it says which slot is gone and why.
      if (!rollbackStamp(task, slot)) {
        log(`调度任务 ${task.name} 的这一槽被消费且台账没写进去（回滚也失败，这一槽丢失）：${reason}`);
      } else {
        log(`调度任务 ${task.name} 的跳过记录没写进台账（槽戳已回滚，下一次 tick 重判）：${error instanceof Error ? error.message : String(error)}`);
      }
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
    // THE ARMING COMES FIRST (2026-10-03, reviewer P1): a checkout must never
    // exist without a ledger line that names it, or a daemon killed right after
    // cutting one leaves a directory nothing can find again — the slot stamp
    // alone does not say WHAT was created. The arming is inert on its own
    // (`openRuns` ignores it), so a launch that never happens still leaves no run
    // behind.
    const armed: ScheduleRunArmed = {
      kind: "run-armed",
      runId,
      taskId: task.id,
      sessionId,
      at: at.toISOString(),
      repo: task.repo,
      worktree: cut.worktree.path,
      branch: cut.worktree.branch,
      base: cut.worktree.base,
    };
    try {
      appendScheduleRun(deps.home, armed);
    } catch (error) {
      // A SESSION CANNOT INHERIT A CONTRACT IT CANNOT READ: with the ledger
      // unwritable, nothing is launched and the checkout goes back. The slot is
      // still owed — a broken disk is a TEMPORARY obstacle.
      releaseCheckout(cut.worktree, task, runId);
      deferred(task, at, slot, `台账写不进去（${error instanceof Error ? error.message : String(error)}）`);
      return undefined;
    }
    // THEN THE SLOT IS CONSUMED, still before the session exists: a launch that
    // succeeds cannot be un-launched, so its slot must already be dealt with on
    // disk — otherwise a crash right after would leave a real session holding a
    // slot the table still calls owed.
    if (!dealt(task, at, slot)) {
      releaseCheckout(cut.worktree, task, runId);
      deferred(task, at, slot, "这一槽的处理戳写不进去");
      return undefined;
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
      if (started.mayHaveStarted === true) {
        // THE WINDOW MAY BE OPEN AND A SESSION MAY BE WORKING IN IT (reviewer
        // P1, 2026-10-03): the slot is SPENT — starting a second run for it would
        // be exactly the duplicate the stamp exists to prevent — the checkout is
        // kept (it is the only copy of whatever is running there), and the ledger
        // says so.
        //
        // NOT `skipped()`: that helper rolls the stamp back when the ledger line
        // cannot be written, which is right for "definitely did not start" and
        // exactly wrong here — an unrolled stamp would let the next tick start a
        // SECOND run for a slot that may already be running (quality round P2,
        // 2026-10-03).
        // THE SLOT IS ALREADY SPENT — `dealt` ran before the launch and had to
        // succeed for us to be here at all, so calling it AGAIN would only push
        // another stamp onto an already-consumed slot (reviewer P1, 2026-10-03).
        try {
          appendScheduleRun(deps.home, {
            kind: "run-skipped",
            taskId: task.id,
            at: at.toISOString(),
            reason: `起会话失败但窗口可能已经开了（${problem}）—— 这一槽视为已处理`,
            runId,
          });
        } catch (error) {
          log(`调度任务 ${task.id} 的这一槽台账没写进去（这一槽仍视为已处理：窗口可能已经开了）：${error instanceof Error ? error.message : String(error)}`);
        }
        log(`运行 ${runId} 的窗口可能已经开了但坐标读不到 —— 保留它的 checkout ${cut.worktree.path} 不动，请人工确认`);
      } else {
        // NOTHING IS WRITTEN FOR A LAUNCH THAT NEVER HAPPENED (reviewer P1): the
        // arming line is inert on its own (`openRuns` ignores it), so the ledger
        // keeps NO run this session never was — no `run-settled`, no ghost in the
        // panel's history. The checkout goes back too.
        releaseCheckout(cut.worktree, task, runId);
        if (started.permanent === true) {
          // A PERMANENT obstacle (no tmux to run at all): the slot was ALREADY
          // spent before the launch, so there is no second stamp and no rollback
          // — the ledger records the reason, and the `runId` it carries is what
          // the arming cleanup reads to know the consumption is explained
          // (reviewer P0/P2, 2026-10-03). A ledger write that fails leaves the
          // slot spent, which is the correct outcome for a permanent obstacle.
          try {
            appendScheduleRun(deps.home, {
              kind: "run-skipped",
              taskId: task.id,
              at: at.toISOString(),
              reason: `起会话失败（永久障碍）：${problem}`,
              runId,
            });
          } catch (error) {
            log(`调度任务 ${task.id} 的永久障碍记录没写进台账（这一槽仍已消费）：${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          // A TEMPORARY obstacle: the stamp goes back, so this slot is still owed.
          // A rollback that itself fails costs that one slot — recorded as a skip
          // so the reason survives instead of only living in a log line.
          if (!rollbackStamp(task, slot)) {
            try {
              appendScheduleRun(deps.home, {
                kind: "run-skipped",
                taskId: task.id,
                at: at.toISOString(),
                reason: `起会话失败（${problem}），且槽戳回滚失败 —— 这一槽被消费`,
                runId,
              });
            } catch (error) {
              log(`调度任务 ${task.id} 的这一槽丢失记录没写进台账：${error instanceof Error ? error.message : String(error)}`);
            }
          }
          deferred(task, at, slot, `起会话失败：${problem}`);
        }
      }
      return undefined;
    }
    const run: ScheduleRunStarted = {
      kind: "run-started",
      runId,
      taskId: task.id,
      sessionId,
      at: at.toISOString(),
      // THE RUN'S OWN CHECKOUT, IN THE LEDGER (lib/schedule-worktree.ts settles
      // it by exactly these four facts, and the contract adoption reads the
      // owner record they point at) — plus the repo itself, which is the anchor
      // a settlement needs once the task is gone from the table.
      repo: task.repo,
      worktree: cut.worktree.path,
      branch: cut.worktree.branch,
      base: cut.worktree.base,
    };
    try {
      appendScheduleRun(deps.home, run);
    } catch (error) {
      // The session is REAL and running; only its ledger line is missing. It is
      // remembered in memory so it still settles — and the arming line already
      // on disk keeps a restart from treating the slot as unhandled.
      unrecordedRuns.set(runId, run);
      log(`运行 ${runId} 写不进台账（会话已在跑，先记在内存里）：${error instanceof Error ? error.message : String(error)}`);
    }
    // …AND WHERE ITS WINDOW IS, in its own line (2026-10-03): the coordinates
    // did not exist until the launch returned. Best-effort — a run with no
    // coordinates is closed the only remaining way, when its process exits and
    // tmux reclaims the window.
    if (started.scopeSession !== undefined && started.windowId !== undefined) {
      try {
        const server = currentTmuxServer(deps.runTmux);
        appendScheduleRun(deps.home, {
          kind: "run-window",
          runId,
          taskId: task.id,
          sessionId,
          at: at.toISOString(),
          scopeSession: started.scopeSession,
          windowId: started.windowId,
          ...(server === undefined ? {} : { server }),
        });
      } catch (error) {
        log(`运行 ${runId} 的窗口坐标没能记进台账：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    log(`调度任务 ${task.name} 已发起运行 ${runId}（会话 ${started.sessionId}）`);
    return run;
  }

  /**
   * Give a checkout back after a launch that never happened.
   *
   * The run produced nothing — no session was ever started in it — so this is a
   * `failed` settlement, which recycles an empty checkout and keeps a non-empty
   * one for a human (lib/schedule-worktree.ts). A settlement that throws is
   * logged and forgotten: the slot's fate must not depend on it.
   */
  function releaseCheckout(worktree: ScheduleWorktreeOwner, task: ScheduledTask, runId: string): void {
    try {
      worktrees.settle({ worktree, outcome: "failed", station: task.contract.restatement.station });
    } catch (error) {
      log(`运行 ${runId} 的隔离 checkout 没能回收：${error instanceof Error ? error.message : String(error)}`);
    }
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
    station: DeliveryStation | undefined,
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
    const collection = open.length === 0 && !records.some((record) => record.kind === "run-armed")
      ? undefined
      : deps.observer.collect();
    // ORPHANED ARMINGS ARE RUNS TOO (2026-10-03, quality round P2): a daemon
    // that died between the launch and the `run-started` write leaves only the
    // arming line, and the session it started is REAL — it holds a checkout and
    // it will produce output — while `openRuns` deliberately ignores `run-armed`
    // (a launch that never happened must not look like a run). A session the
    // observer can SEE is what tells the two apart: an arming nobody is behind
    // stays inert forever and costs nothing.
    // AN ARMING THAT EVER BECAME A RUN IS NOT AN ORPHAN (2026-10-03, quality
    // round P1): a run whose `run-started` DID land has its own settlement, and
    // its session stays visible in the observer for hours after it finished —
    // asking "is it still open?" instead of "did a start line ever land?" would
    // re-settle it on EVERY tick, appending a duplicate `run-settled` every 20
    // seconds, forever.
    const everStarted = new Set(
      records.filter((record) => record.kind === "run-started" || record.kind === "run-settled").map((record) => record.runId),
    );
    const orphaned: ScheduleRunStarted[] = records
      .filter((record): record is ScheduleRunArmed => record.kind === "run-armed")
      .filter((armed) => !everStarted.has(armed.runId))
      .filter((armed) => (collection?.sessions ?? []).some((session) => session.sessionId === armed.sessionId))
      .map((armed) => ({
        kind: "run-started",
        runId: armed.runId,
        taskId: armed.taskId,
        sessionId: armed.sessionId,
        at: armed.at,
        ...(armed.repo === undefined ? {} : { repo: armed.repo }),
        ...(armed.worktree === undefined ? {} : { worktree: armed.worktree }),
        ...(armed.branch === undefined ? {} : { branch: armed.branch }),
        ...(armed.base === undefined ? {} : { base: armed.base }),
      }));
    const all = [...new Map([...open, ...orphaned].map((run) => [run.runId, run])).values()];
    // AN ARMING NOBODY CAME FOR IS CLEANED UP (2026-10-03, reviewer P1): a daemon
    // killed between the arming and the launch — or between the launch and the
    // `run-started` write, in which case the session is not visible either —
    // leaves a checkout that no run and no session will ever reclaim. The arming
    // line is the only thing that names it, and it is inert by design, so this is
    // where its directory is closed out. The line itself STAYS (nothing is
    // rewritten); only the checkout goes.
    for (const record of records) {
      if (record.kind !== "run-armed") continue;
      if (everStarted.has(record.runId) || cleanedArms.has(record.runId)) continue;
      if ((collection?.sessions ?? []).some((session) => session.sessionId === record.sessionId)) continue; // the orphan pass owns it
      const armedAt = Date.parse(record.at);
      if (!Number.isFinite(armedAt) || at.getTime() - armedAt < SETTLE_GRACE_MS) continue; // it may still be cold-starting
      if (record.repo === undefined || record.worktree === undefined || record.branch === undefined || record.base === undefined) continue;
      // THE LISTING IS NOT THE ONLY EVIDENCE OF LIFE (2026-10-03, reviewer P1):
      // a session the observer cannot place may still be a live process — the
      // checkout's own heartbeat and its transcript say so, which is exactly what
      // `runEvidence` answers for a run.
      const asRun: ScheduleRunStarted = {
        kind: "run-started",
        runId: record.runId,
        taskId: record.taskId,
        sessionId: record.sessionId,
        at: record.at,
        ...(record.worktree === undefined ? {} : { worktree: record.worktree }),
        ...(record.repo === undefined ? {} : { repo: record.repo }),
      };
      const evidence = runEvidence(asRun, record.repo, at);
      if (evidence.holdsCheckout) continue;
      const transcriptAt = evidence.transcriptAt === null ? Number.NaN : Date.parse(evidence.transcriptAt);
      if (Number.isFinite(transcriptAt) && at.getTime() - transcriptAt < TRANSCRIPT_ACTIVE_MS) continue;
      if (!existsSync(record.worktree)) {
        cleanedArms.add(record.runId); // already recycled, or never created
      } else {
        // THE SETTLEMENT REPORTS FAILURE AS A VALUE, NOT AS A THROW (reviewer P1,
        // 2026-10-03): `settleScheduleWorktree` never throws — every refusal comes
        // back as `branch-kept` with its own note — so a `catch` here would never
        // run and the log would claim a recycling that did not happen. Remembered
        // either way, because both outcomes are FINAL for this arming: the
        // checkout was recycled, or it is deliberately kept for a human to look
        // at (that is what `branch-kept` means).
        const settlement = worktrees.settle({
          worktree: { repo: record.repo, runId: record.runId, branch: record.branch, base: record.base, path: record.worktree },
          outcome: "failed",
          station: stations.get(record.taskId),
        });
        cleanedArms.add(record.runId);
        log(settlement.action === "reclaimed"
          ? `运行 ${record.runId} 的 arming 没有对应的会话（daemon 当时死了？）—— 它的隔离 checkout 已回收`
          : `运行 ${record.runId} 的 arming 没有对应的会话 —— checkout 按 ${settlement.action} 处理：${settlement.note}`);
      }
      // THE SLOT STAMP IS LEFT EXACTLY WHERE IT IS (reviewer P1/P2, 2026-10-03).
      // This pass used to put it back, which was wrong in both directions: a
      // PERMANENT obstacle spends the slot on purpose (and a `run-skipped` line
      // that failed to land would have made this pass undo that, turning one
      // failure into a retry every couple of minutes), while a TEMPORARY one has
      // already rolled its own stamp back in the same call that saw the failure.
      // What is left is the crash window — the daemon died between the stamp and
      // the launch — and losing that ONE slot is the cheap side of the trade:
      // re-running a slot is what the whole stamp exists to prevent.
    }
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
    const windows = new Map<string, { scopeSession: string; windowId: string; server?: string }>();
    for (const record of records) {
      if (record.kind === "run-window") {
        windows.set(record.runId, {
          scopeSession: record.scopeSession,
          windowId: record.windowId,
          ...(record.server === undefined ? {} : { server: record.server }),
        });
      }
    }
    // WHICH SERVER IS UP RIGHT NOW — asked ONCE per tick, because both the
    // settlement and the closing retry need it and a recorded window id is only
    // meaningful on the server that minted it (2026-10-03, reviewer P1).
    const liveServer = currentTmuxServer(deps.runTmux);
    for (const run of all) {
      // ONE RUN IS SETTLED ONCE, even if the same run id reached this list twice
      // (an in-memory run whose `run-started` write failed is ALSO visible as an
      // orphaned arming): a second settlement would append a contradictory
      // `run-settled` and try to land the same checkout again (reviewer P1,
      // 2026-10-03).
      if (settled.has(run.runId)) continue;
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
        const settlement = settleRunWorktree(run, decision.outcome ?? "failed", stations.get(run.taskId), repo ?? run.repo);
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
        // A RECORDED ADDRESS IS ONLY MEANINGFUL ON THE SERVER THAT MINTED IT
        // (2026-10-03, reviewer P1): pane coordinates come from the listing and
        // are therefore current, but the `run-window` fallback was written by
        // whichever server was up at launch time — aiming a close at a reused
        // window id would take a stranger's window with it.
        const recordedServer = windows.get(run.runId)?.server;
        // …AND THE LISTING'S OWN ADDRESS IS ONLY AS FRESH AS THE LISTING: the
        // server can be replaced between `collect()` and this close, and the
        // pane's `@N` would then name a window on the NEW server. Asking again
        // narrows that to the few microseconds between the two reads (reviewer
        // P1, 2026-10-03).
        const sameServerNow = currentTmuxServer(deps.runTmux) === liveServer;
        const addressTrustworthy = (session !== undefined && session.tmux !== null && sameServerNow) ||
          (recordedServer !== undefined && liveServer !== undefined && recordedServer === liveServer);
        const target = addressTrustworthy ? closeTargetFor(withWindow, session, evidence, repo) : undefined;
        if (target !== undefined && !closeRunWindowAt(deps, target)) {
          log(`运行 ${run.runId} 的窗口没能关掉（它会继续占着 ${target.repo}）`);
        }
      } catch (error) {
        log(`运行 ${run.runId} 结算失败（下次 tick 再试）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const stillOpen = all.filter((run) => !settled.has(run.runId));
    // …AND RETRIED UNTIL THE WINDOW IS REALLY GONE (2026-10-03, reviewer P1): the
    // retry used to expire with a time window, which only delays the same
    // permanent loss when tmux stays broken longer. What is bounded here is the
    // WORK, not the retry — one `list-windows` per scope session says which
    // recorded windows still exist, and only those are closed.
    const settledIds = new Set(records.filter((record) => record.kind === "run-settled").map((record) => record.runId));
    const liveWindows = new Map<string, Set<string>>();
    for (const coords of windows.values()) {
      if (liveWindows.has(coords.scopeSession)) continue;
      liveWindows.set(coords.scopeSession, listWindowIds(deps.runTmux, coords.scopeSession));
    }
    for (const [runId, coords] of windows) {
      if (!settledIds.has(runId)) continue;
      if (coords.server === undefined || liveServer === undefined || coords.server !== liveServer) continue;
      if (!(liveWindows.get(coords.scopeSession)?.has(coords.windowId) ?? false)) continue;
      const anchorRecord = records.find(
        (record): record is ScheduleRunArmed | ScheduleRunStarted =>
          (record.kind === "run-armed" || record.kind === "run-started") && record.runId === runId,
      );
      const anchor = anchorRecord?.repo ?? "";
      if (anchor === "") continue;
      closeRunWindowAt(deps, { repo: anchor, session: coords.scopeSession, window: coords.windowId });
    }
    for (const task of table.file.tasks) {
      try {
        const decision = dueDecision({ task, now: at, openRun: stillOpen.some((run) => run.taskId === task.id) });
        if (decision.reason === "disabled") {
          // A DISABLED TASK STILL GETS A LEDGER LINE (reviewer P1, 2026-10-03):
          // it is one of the four permanent obstacles the approved goal names, and
          // "why does this never run" has to be answerable FROM THE LEDGER —
          // `enabled:false` on the row says what, the record says since when.
          // Once per task per process: the condition cannot change by itself.
          if (!notedDisabled.has(task.id)) {
            try {
              appendScheduleRun(deps.home, {
                kind: "run-skipped",
                taskId: task.id,
                at: at.toISOString(),
                reason: "永久障碍：任务已停用（enabled:false）",
              });
              notedDisabled.add(task.id);
            } catch (error) {
              log(`调度任务 ${task.id} 的停用记录没写进台账（下次 tick 再试）：${error instanceof Error ? error.message : String(error)}`);
            }
          }
          continue;
        }
        if (decision.reason === "bad-cron" || decision.reason === "bad-time") {
          if (!notedBroken.has(task.id)) {
            const why = decision.reason === "bad-cron"
              ? `cron 无解（${task.cron}）`
              : "createdAt / lastFiredAt 读不出时间";
            try {
              appendScheduleRun(deps.home, { kind: "run-skipped", taskId: task.id, at: at.toISOString(), reason: `永久障碍：${why}` });
              // ONLY NOW IS IT REMEMBERED: a line that could not be written must
              // be retried on the next tick, or the permanent condition would
              // never reach the ledger at all (reviewer P1, 2026-10-03).
              notedBroken.add(task.id);
            } catch (error) {
              log(`调度任务 ${task.id} 的永久障碍记录没写进台账（下次 tick 再试）：${error instanceof Error ? error.message : String(error)}`);
            }
          }
          continue;
        }
        // (A slot the daemon slept through is no longer CONSUMED here: it stays
        // owed and the `due` branch below runs it — see `dueDecision`.)
        if (!decision.due) continue;
        const slot = slotKey(task.id, decision.scheduledAt);
        // A CONTRACT THAT DOES NOT CHECK OUT IS NOT A RUNNABLE TASK (2026-10-03,
        // reviewer P1): adoption refuses it at `session_start`
        // (lib/schedule-run-contract.ts), so starting a session for it would
        // burn the slot on a run that can never adopt what the user approved.
        // The store's own validator is what answers — never a second copy.
        const contractProblem = scheduleContractProblem(task.contract);
        if (contractProblem !== undefined) {
          // PERMANENT: no retry repairs a corrupted contract. The slot is
          // consumed and the ledger names it — a stamp that cannot be written is
          // retried by the next tick, which just repeats this decision.
          skipped(task, at, `任务契约不成立（${contractProblem}）`, slot);
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

/**
 * The window ids a tmux session currently holds — the cheap question the
 * window-close retry asks before trying to close anything (2026-10-03). An
 * unreadable answer is an EMPTY set, which reads as "nothing to close": tmux
 * being unreachable must not turn into an error of its own.
 */
function listWindowIds(run: TmuxRunner, session: string): Set<string> {
  try {
    const result = run(["list-windows", "-t", session, "-F", "#{window_id}"]);
    if (!result.ok) return new Set();
    return new Set(result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== ""));
  } catch {
    return new Set();
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
