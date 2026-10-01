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
 * ── WHAT "DUE" MEANS, AND WHY IT IS NOT `nextRunAtFor` ──
 *
 * `nextRunAtFor` (lib/schedule-store.ts) counts from `lastFiredAt` when there
 * is one and from `now` otherwise — right for the panel's "when does it fire
 * next", useless for firing: counted from `now`, a brand-new task's first slot
 * is always one period away, so a task that never ran would never run. The
 * schedule here counts from `lastFiredAt ?? createdAt`, so the first slot is
 * the first cron minute after the task was AUTHORED (authored 08:59 for
 * `0 9 * * *` ⇒ fires at 09:00), and a task whose daemon was away for a week
 * fires ONCE on the next tick rather than seven times — a missed slot is not
 * replayed, the schedule simply moves on: the slot due is `lastFiredAt`'s next
 * one, and dealing with it stamps `lastFiredAt = now`.
 *
 * ── ONE SLOT IS DEALT WITH ONCE (RESTART INCLUDED) ──
 *
 * `lastFiredAt` is stamped for EVERY slot the scheduler deals with — fired,
 * skipped because the repo was busy, or failed to launch — so a tick that
 * jitters, and a daemon that restarts, never deal with the same slot twice.
 * The ledger (`schedule-runs.jsonl`, append-only) is what a restart reads to
 * learn which runs are still OPEN; the table's `lastFiredAt` is what it reads
 * to learn which slots are already dealt with. Both are files: neither piece
 * of state lives only in memory. `run-started` is appended BEFORE the stamp —
 * a process killed between the two steps comes back, sees an open run for that
 * task and starts no second one.
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

import { nextRunAfter } from "../cron-schedule.ts";
import { normalizeRepoPath, STATION_CAP_ENV } from "../repo-pr-policy.ts";
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
import { launchTask } from "./control.ts";
import type { SessionObserver, DaemonSession } from "./sessions.ts";
import type { TmuxRunner } from "../orchestrator-tmux.ts";

/** How often the daemon looks for work. */
export const SCHEDULE_TICK_MS = 20_000;

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
  /** The slot this decision is about; `null` when the schedule cannot name one. */
  scheduledAt: Date | null;
  reason: DueReason;
}

/**
 * May this task start now?
 *
 * `openRun` is the caller's answer to "does this task have a run that has not
 * settled" — a second run of the SAME task would mean two sessions racing on
 * one goal.
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
  // REDUNDANT ON PURPOSE: `nextRunAfter` is strictly later than its base, so
  // the slot is always past `lastFiredAt` — except when a hand-edited file
  // carries a stamp inside the slot being judged. One slot, dealt with once.
  if (dealtAt !== undefined && dealtAt >= scheduledAt.getTime()) {
    return { due: false, scheduledAt, reason: "already-dealt" };
  }
  if (scheduledAt.getTime() > input.now.getTime()) return { due: false, scheduledAt, reason: "not-yet" };
  if (input.openRun) return { due: false, scheduledAt, reason: "open-run" };
  return { due: true, scheduledAt, reason: "due" };
}

// ---------------------------------------------------------------------------
// The settlement decision
// ---------------------------------------------------------------------------

export type SettleReason = "settled" | "unseen" | "running";

export interface SettlementDecision {
  settle: boolean;
  /** Set when `settle` — the outcome the ledger gets. */
  outcome: ScheduleRunOutcome | null;
  verdict: string | null;
  unmet: string[];
  reason: SettleReason;
}

/**
 * What did this run end as? Read off the OBSERVED session, never off a guess:
 *
 *   READY        ⇒ passed
 *   BLOCKED      ⇒ blocked
 *   anything else (no verdict, a verdict the gate did not record) ⇒ failed
 *   no readable gate state, or the session vanished   ⇒ gone
 *
 * `passed` is reachable ONLY through a recorded READY — that is the mechanical
 * half of "a scheduled run's output goes through the reviewer": a session that
 * merely stopped is not a success.
 */
export function settlementFor(input: {
  run: ScheduleRunStarted;
  session: DaemonSession | undefined;
  now: Date;
  graceMs?: number;
}): SettlementDecision {
  const session = input.session;
  if (session === undefined) {
    const startedAt = Date.parse(input.run.at);
    const graceMs = input.graceMs ?? SETTLE_GRACE_MS;
    const vanished = !Number.isFinite(startedAt) || input.now.getTime() - startedAt >= graceMs;
    return vanished
      ? { settle: true, outcome: "gone", verdict: null, unmet: [], reason: "settled" }
      : { settle: false, outcome: null, verdict: null, unmet: [], reason: "unseen" };
  }
  const verdict = session.rounds.lastVerdict;
  const ended =
    session.state === "done" ||
    session.state === "dead" ||
    (session.state === "idle" && session.rounds.recorded > 0);
  if (!ended) return { settle: false, outcome: null, verdict, unmet: session.unmet, reason: "running" };
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

  /** Stamp the slot as dealt with — fired, skipped or failed alike. */
  function dealt(task: ScheduledTask, at: Date): void {
    const stamped = updateScheduledTask(deps.home, task.id, { lastFiredAt: at.toISOString() }, { from: "gate" });
    if (!stamped.ok) log(`调度任务 ${task.id} 的 lastFiredAt 没写上：${stamped.problem}`);
  }

  function skipped(task: ScheduledTask, at: Date, reason: string): void {
    appendScheduleRun(deps.home, { kind: "run-skipped", taskId: task.id, at: at.toISOString(), reason });
    dealt(task, at);
    log(`调度任务 ${task.name} 跳过：${reason}`);
  }

  function fire(task: ScheduledTask, at: Date): ScheduleRunStarted | undefined {
    const runId = `run-${randomBytes(4).toString("hex")}`;
    const started = launchTask({ home: deps.home, runTmux: deps.runTmux, now: deps.now }, {
      repo: task.repo,
      task: runTaskText(task, at),
      mode: "loop",
      // THE CONTRACT'S STATION IS THE CEILING the run may deliver at: the user
      // approved this task at that station, and a run may not ship further.
      station: task.contract.restatement.station,
      env: { [SCHEDULE_ID_ENV]: task.id, [SCHEDULE_RUN_ENV]: runId },
    });
    if (!started.ok || started.sessionId === undefined) {
      skipped(task, at, `起会话失败：${started.problem ?? "launchTask 没给出 sessionId"}`);
      return undefined;
    }
    const run: ScheduleRunStarted = {
      kind: "run-started",
      runId,
      taskId: task.id,
      sessionId: started.sessionId,
      at: at.toISOString(),
    };
    appendScheduleRun(deps.home, run);
    dealt(task, at);
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
    const open = openRuns(records);
    const repos = new Map(table.file.tasks.map((task) => [task.id, task.repo] as const));

    // SETTLE FIRST: a run that just ended must release its repo in THIS tick,
    // or the slot that is due right now gets blocked by its own predecessor.
    const collection = open.length === 0 ? undefined : deps.observer.collect();
    const settled = new Set<string>();
    for (const run of open) {
      // ONE RUN'S FAILURE MUST NOT TAKE THE TICK WITH IT: a home that went
      // read-only, a full disk, a store that refuses a write — the daemon is
      // resident, and the run is retried on the next tick against the same
      // durable ledger.
      try {
        const session = collection?.sessions.find((candidate) => candidate.sessionId === run.sessionId);
        const decision = settlementFor({ run, session, now: at });
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
        log(`运行 ${run.runId}（任务 ${run.taskId}）结算：${decision.outcome}${decision.verdict === null ? "" : `（${decision.verdict}）`}`);
      } catch (error) {
        log(`运行 ${run.runId} 结算失败（下次 tick 再试）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const stillOpen = open.filter((run) => !settled.has(run.runId));
    const repoOfRun = (run: ScheduleRunStarted): string | undefined =>
      repos.get(run.taskId) ??
      // Its task is gone (deleted while the run was in flight): the session it
      // started is the only thing left that can name the checkout.
      collection?.sessions.find((candidate) => candidate.sessionId === run.sessionId)?.repo;

    for (const task of table.file.tasks) {
      try {
        const decision = dueDecision({ task, now: at, openRun: stillOpen.some((run) => run.taskId === task.id) });
        if (!decision.due) continue;
        const holder = repoHolder(stillOpen, task.repo, repoOfRun);
        if (holder !== undefined) {
          skipped(task, at, `repo ${task.repo} 上还有未结算的运行 ${holder.runId}（任务 ${holder.taskId}，${holder.at} 起）—— 两个写者不能同时进同一个 checkout`);
          continue;
        }
        // A RUN STARTED IN THIS TICK IS OPEN TOO: without adding it, two tasks in
        // one repo that are both due would both start here — the second seeing a
        // `stillOpen` computed before the first one existed.
        const run = fire(task, at);
        if (run !== undefined) stillOpen.push(run);
      } catch (error) {
        log(`调度任务 ${task.id} 处理失败（下次 tick 再试）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
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

/** The opening message a scheduled run starts with. */
export function runTaskText(task: ScheduledTask, at: Date): string {
  return [
    `这是定时任务 ${task.name} 的一次运行（${at.toISOString()} 发起）：${task.requirement}`,
    "",
    "本次运行的契约（用户已批准）见 `.pi/loop-goal.md`（门禁会在 session_start 继承它）。" +
      "干完活按门禁流程走：有代码改动就 `judge_submit` 送 reviewer，READY 之后才 `declare_done`。",
  ].join("\n");
}
