/**
 * The scheduler's two decisions — `dueDecision` (may this task start now?) and
 * `settlementFor` (what did that run end as?) — plus the tick that puts them
 * to work: what gets started, skipped, settled, and what must NOT happen twice
 * (a slot, a repo, a restart).
 *
 * The clock is always injected, the tmux is always fake and the observer is a
 * literal list of `DaemonSession`s, so a "restart" is one more `createScheduler`
 * call and a "week offline" is one timestamp.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";

import {
  createScheduler as createSchedulerRaw,
  dueDecision,
  openRuns,
  runTaskText,
  settlementFor,
  type DueDecision,
  type DueReason,
  type Scheduler,
  type SchedulerDeps,
} from "../lib/daemon/scheduler.ts";
import type { CutScheduleWorktree, ScheduleSettlement } from "../lib/schedule-worktree.ts";
import {
  addScheduledTask,
  appendScheduleRun,
  readScheduleRuns,
  readSchedules,
  updateScheduledTask,
  type NewScheduledTask,
  type ScheduledTask,
} from "../lib/schedule-store.ts";
import type { DaemonSession, SessionObserver } from "../lib/daemon/sessions.ts";
import { daemonTmuxScope } from "../lib/daemon/control.ts";
import { ensureDaemonIdentity } from "../lib/daemon/state.ts";
import { ownSessionName } from "../lib/session-tmux-scope.ts";
import { schedulesPath, scheduleRunsPath } from "../lib/daemon/paths.ts";
import type { TmuxRunner } from "../lib/orchestrator-tmux.ts";
import { fakeRunner, scheduleContract, scheduleTaskInput, scratchHome, scratchRepo } from "./daemon-helpers.ts";

/**
 * The cron the tick fixtures use: every five minutes, close enough together
 * that {@link justDueStamp} can name the slot a task is counting towards.
 */
const EVERY_FIVE_MINUTES = "*/5 * * * *";

/**
 * The tmux server the fake runner reports (`<socket>,<pid>`, the registry's own
 * spelling) — and the one the fixtures record with a run's window, because a
 * recorded window id is only meaningful on the server that minted it.
 */
const TEST_TMUX_SERVER = "/tmp/tmux-501/default,4242";

// `currentTmuxServer` prefers `$TMUX`, and this suite may well be running INSIDE
// tmux: the fake server id above is what these tests mean, so the ambient one is
// removed for the whole file.
delete process.env.TMUX;

/**
 * THE CHECKOUT SEAM, FAKED (2026-10-03).
 *
 * A tick test has no git repository on disk and does not need one: what it
 * verifies is the SCHEDULER's own decisions — when a run starts, what its
 * ledger line carries, and what happens to a slot it could not start at all.
 * The real `git worktree` behaviour (cut, seed, land, reclaim) is
 * test/schedule-worktree.test.ts's subject, where a real repository is the
 * point.
 */
const FAKE_WORKTREES = {
  cut: (input: { repo: string; runId: string }): CutScheduleWorktree => ({
    ok: true,
    worktree: {
      repo: input.repo,
      runId: input.runId,
      branch: `rg-schedule-${input.runId.replace(/[^A-Za-z0-9]/g, "")}`,
      base: "0".repeat(40),
      path: join(tmpdir(), `rg-fake-worktree-${input.runId}`),
    },
    seed: [],
  }),
  settle: (): ScheduleSettlement => ({ action: "reclaimed", branch: "", changes: false, note: "fake" }),
};

/** Every scheduler in this file gets the faked checkout seam. */
function createScheduler(deps: Omit<SchedulerDeps, "worktrees">): Scheduler {
  return createSchedulerRaw({ ...deps, worktrees: FAKE_WORKTREES });
}

/**
 * A `lastFiredAt` that puts the task's NEXT slot INSIDE `SLOT_GRACE_MS`.
 *
 * Five minutes and one second back lands the next five-minute boundary between
 * one and 301 seconds in the past — always inside the ten-minute grace window,
 * and always with the slot after it minutes away. That is what makes a task
 * "due right now" without waiting for a real cron minute.
 */
function justDueStamp(at: Date = new Date()): string {
  return new Date(at.getTime() - (5 * 60_000 + 1_000)).toISOString();
}

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "sch-00000001",
    name: "daily-audit",
    repo: "/repo",
    cron: "0 9 * * *",
    requirement: "每天 09:00 跑一次审计",
    contract: scheduleContract(),
    enabled: true,
    // Local wall clock, like the cron itself: `nextRunAfter` reads local time.
    createdAt: new Date(2026, 8, 30, 8, 0).toISOString(),
    updatedAt: new Date(2026, 8, 30, 8, 0).toISOString(),
    lastFiredAt: null,
    ...over,
  };
}

function sessionFor(sessionId: string, over: Partial<DaemonSession> = {}): DaemonSession {
  return {
    sessionId,
    name: null,
    kind: "loop",
    repo: "/repo",
    cwd: "/repo",
    branch: null,
    mode: "loop",
    state: "working",
    stateAt: null,
    stateSource: "pane",
    alive: true,
    tmux: null,
    pid: 1,
    transcript: null,
    lastActivityAt: null,
    rounds: { sent: 1, recorded: 1, lastVerdict: "READY" },
    completedAt: null,
    gateStateFound: true,
    unmet: [],
    registeredAt: null,
    heartbeatAt: null,
    ...over,
  };
}

/** An observer that answers with a fixed session list — no tmux, no disk. */
function fakeObserver(sessions: DaemonSession[], transcripts: Record<string, string> = {}): SessionObserver {
  return {
    collect: () => ({ now: new Date().toISOString(), tmuxReadable: true, sessions, problems: [] }),
    transcriptFor: (sessionId) => transcripts[sessionId],
    outputFor: () => [],
  };
}

/** The tmux the gate's own control tests use: enough to open one window. */
function fakeTmux(): TmuxRunner & { calls: string[][] } {
  return fakeRunner((argv) => {
    if (argv[0] === "display-message") return { ok: true, stdout: `${TEST_TMUX_SERVER}\n`, stderr: "" };
    if (argv[0] === "list-sessions") return { ok: true, stdout: "", stderr: "" };
    if (argv[0] === "new-session" || argv[0] === "new-window") return { ok: true, stdout: "@3 %9\n", stderr: "" };
    if (argv[0] === "list-panes") return { ok: true, stdout: "", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
}

/** Add one task to a scratch home whose next slot is DUE right now. */
function dueTask(home: string, repo: string, over: Partial<NewScheduledTask> = {}): ScheduledTask {
  const added = addScheduledTask(home, scheduleTaskInput(repo, { cron: EVERY_FIVE_MINUTES, ...over }));
  if (!added.ok) assert.fail(added.problem);
  const stamped = updateScheduledTask(home, added.value.id, { lastFiredAt: justDueStamp() }, { from: "gate" });
  if (!stamped.ok) assert.fail(stamped.problem);
  return stamped.value;
}

// ---------------------------------------------------------------------------
// dueDecision
// ---------------------------------------------------------------------------

test("due: a never-fired task counts from createdAt, and one slot is dealt with once", () => {
  const fresh = task();
  assert.equal(dueDecision({ task: fresh, now: new Date(2026, 8, 30, 8, 59), openRun: false }).reason, "not-yet");
  const due = dueDecision({ task: fresh, now: new Date(2026, 8, 30, 9, 0, 30), openRun: false });
  assert.equal(due.due, true);
  assert.equal(due.scheduledAt?.getTime(), new Date(2026, 8, 30, 9, 0).getTime());

  // Fired at 09:00:05 — the same cron minute must not fire again.
  const fired = task({ lastFiredAt: new Date(2026, 8, 30, 9, 0, 5).toISOString() });
  assert.equal(dueDecision({ task: fired, now: new Date(2026, 8, 30, 9, 0, 40), openRun: false }).due, false);
  assert.equal(dueDecision({ task: fired, now: new Date(2026, 8, 30, 9, 30), openRun: false }).due, false);
  assert.equal(dueDecision({ task: fired, now: new Date(2026, 9, 1, 9, 0, 30), openRun: false }).due, true);

  // A task whose daemon was away for a week IS due: the slot it names is the
  // first one it missed, and a slot that arrived while no daemon was running is
  // now RUN rather than discarded (2026-10-03). One run, not seven — `lastFiredAt`
  // names a single next slot however long the gap is.
  const stale = task({ lastFiredAt: new Date(2026, 8, 20, 9, 0, 5).toISOString() });
  const late = dueDecision({ task: stale, now: new Date(2026, 8, 30, 10, 0), openRun: false });
  assert.equal(late.due, true);
  assert.equal(late.reason, "due");
  assert.equal(late.scheduledAt?.getTime(), new Date(2026, 8, 21, 9, 0).getTime(), "欠着的是基准之后的第一个槽");

  // A stamp at or past the slot it is being judged against: already dealt with.
  const stamped = task({ lastFiredAt: new Date(2026, 8, 30, 9, 0, 30).toISOString() });
  assert.equal(dueDecision({ task: stamped, now: new Date(2026, 8, 30, 9, 0, 40), openRun: false }).reason, "not-yet");
});

test("due: a slot the daemon slept through is OWED, not skipped (2026-10-03)", () => {
  const now = new Date(2026, 8, 30, 10, 0);
  const stale = task({ lastFiredAt: new Date(2026, 8, 20, 9, 0, 5).toISOString() });
  const owed = dueDecision({ task: stale, now, openRun: false });
  assert.equal(owed.due, true);
  assert.equal(owed.reason, "due");
  assert.equal(owed.scheduledAt?.getTime(), new Date(2026, 8, 21, 9, 0).getTime(), "欠着的就是基准之后的第一个槽");
  assert.ok(owed.scheduledAt!.getTime() < now.getTime(), "它确实落在过去 — 那正是「欠着」的意思");

  // A slot that has NOT arrived is a different word.
  const ahead = dueDecision({ task: task({ lastFiredAt: new Date(2026, 8, 30, 9, 0, 5).toISOString() }), now, openRun: false });
  assert.equal(ahead.reason, "not-yet");
});

test("due: lateness no longer separates a late tick from a runnable slot", () => {
  const fresh = task(); // the first slot after it was authored: 2026-09-30 09:00 local
  const slot = new Date(2026, 8, 30, 9, 0);
  assert.equal(dueDecision({ task: fresh, now: slot, openRun: false }).reason, "due", "刚到点当然跑");
  const hoursLater = new Date(slot.getTime() + 6 * 60 * 60_000);
  assert.equal(dueDecision({ task: fresh, now: hoursLater, openRun: false }).reason, "due", "迟到六小时也是这一槽，跑它而不是丢掉");
});

test("due: scheduledAt names the slot the task is OWED, in the past or not", () => {
  // THE FIELD EVERY SURFACE RENDERS (the API's `nextRunAt`, the panel,
  // `schedule_task({action:"list"})`) names the slot the tick will act on. Two
  // things may sit behind `now`: the slot that has just arrived, and the slot an
  // owed run (or an unsettled one) is holding — in both cases the run a tick is
  // about to start IS for that slot, which is why they are honest rather than
  // stale (2026-10-03: late slots used to be skipped, and the field had to
  // pretend they never existed).
  //
  // `already-dealt` is NOT in the table: it is unreachable by construction
  // (`nextRunAfter` is strictly later than the base it is counted from, and that
  // base is `lastFiredAt` for every input that could reach the branch — see the
  // guard's own comment in lib/daemon/scheduler.ts).
  const at = new Date(2026, 8, 30, 10, 0);
  const cases: Array<{ label: string; now: Date; expected: DueReason; decision: DueDecision }> = [
    {
      label: "disabled",
      now: at,
      expected: "disabled",
      decision: dueDecision({ task: task({ enabled: false }), now: at, openRun: false }),
    },
    {
      label: "bad-time",
      now: at,
      expected: "bad-time",
      decision: dueDecision({ task: task({ createdAt: "not a time" }), now: at, openRun: false }),
    },
    {
      label: "bad-cron",
      now: at,
      expected: "bad-cron",
      decision: dueDecision({ task: task({ cron: "bogus" }), now: at, openRun: false }),
    },
    {
      label: "not-yet",
      now: at,
      expected: "not-yet",
      decision: dueDecision({ task: task({ lastFiredAt: new Date(2026, 8, 30, 9, 0, 5).toISOString() }), now: at, openRun: false }),
    },
    {
      label: "open-run",
      now: at,
      expected: "open-run",
      decision: dueDecision({ task: task({ lastFiredAt: new Date(2026, 8, 20, 9, 0, 5).toISOString() }), now: at, openRun: true }),
    },
    {
      label: "due (owed while the daemon was away)",
      now: at,
      expected: "due",
      decision: dueDecision({ task: task({ lastFiredAt: new Date(2026, 8, 20, 9, 0, 5).toISOString() }), now: at, openRun: false }),
    },
    {
      label: "due (never fired)",
      now: new Date(2026, 8, 30, 9, 0, 1),
      expected: "due",
      decision: dueDecision({ task: task(), now: new Date(2026, 8, 30, 9, 0, 1), openRun: false }),
    },
  ];
  for (const { label, now: moment, expected, decision } of cases) {
    assert.equal(decision.reason, expected, `${label} 必须命中它命名的分支`);
    if (decision.scheduledAt === null) continue;
    if (expected === "not-yet") {
      assert.ok(decision.scheduledAt.getTime() > moment.getTime(), `${label} 指向未来`);
      continue;
    }
    // `due` AND `open-run` both name a slot at or behind `now`: the first is the
    // slot that has arrived (possibly long ago — that is what "owed" means),
    // the second the slot an unsettled run is holding. What matters is that they
    // do not name a time in the FUTURE.
    assert.ok(
      decision.scheduledAt.getTime() <= moment.getTime(),
      `${label}: ${decision.scheduledAt.toISOString()} 不该落在未来`,
    );
  }
});

test("due: a disabled task, an open run and an unreadable schedule all refuse", () => {
  const fresh = task();
  const at = new Date(2026, 8, 30, 9, 0, 30);
  assert.equal(dueDecision({ task: task({ enabled: false }), now: at, openRun: false }).reason, "disabled");
  assert.equal(dueDecision({ task: fresh, now: at, openRun: true }).reason, "open-run");
  assert.equal(dueDecision({ task: task({ cron: "bogus" }), now: at, openRun: false }).reason, "bad-cron");
  assert.equal(dueDecision({ task: task({ createdAt: "not a time" }), now: at, openRun: false }).reason, "bad-time");
});

// ---------------------------------------------------------------------------
// settlementFor
// ---------------------------------------------------------------------------

test("settlement: only a recorded READY passes, and a vanished session is gone", () => {
  const run = {
    kind: "run-started" as const,
    runId: "run-1",
    taskId: "sch-00000001",
    sessionId: "sess-1",
    at: new Date(2026, 9, 1, 9, 0).toISOString(),
  };
  const now = new Date(2026, 9, 1, 9, 5);
  const of = (session: DaemonSession | undefined): ReturnType<typeof settlementFor> => settlementFor({ run, session, now });

  const passed = of(sessionFor("sess-1", { state: "done", unmet: ["review"] }));
  assert.equal(passed.outcome, "passed");
  assert.deepEqual(passed.unmet, ["review"], "unmet rides along verbatim");
  assert.equal(of(sessionFor("sess-1", { state: "done", rounds: { sent: 1, recorded: 1, lastVerdict: "BLOCKED" } })).outcome, "blocked");
  assert.equal(of(sessionFor("sess-1", { state: "done", rounds: { sent: 1, recorded: 1, lastVerdict: null } })).outcome, "failed");
  assert.equal(of(sessionFor("sess-1", { state: "idle" })).outcome, "passed", "an idle session that recorded a round has settled");
  assert.equal(of(sessionFor("sess-1", { state: "done", gateStateFound: false })).outcome, "gone");
  assert.equal(of(sessionFor("sess-1", { state: "dead" })).outcome, "passed", "a finished session that exited is still finished");
  assert.equal(of(undefined).outcome, "gone", "a session that is gone cannot be a success");

  // Still working — including a session waiting for an answer: never settled.
  assert.equal(of(sessionFor("sess-1", { state: "working" })).settle, false);
  assert.equal(of(sessionFor("sess-1", { state: "waiting-input" })).settle, false);
  assert.equal(of(sessionFor("sess-1", { state: "stalled" })).settle, false);
  // Idle with no round ever recorded is not "finished" — it is "did nothing".
  assert.equal(of(sessionFor("sess-1", { state: "idle", rounds: { sent: 0, recorded: 0, lastVerdict: null } })).settle, false);
  assert.equal(of(sessionFor("sess-1", { state: "dead", rounds: { sent: 0, recorded: 0, lastVerdict: null } })).outcome, "failed");

  // A session launched seconds ago has written neither transcript nor pane
  // state: missing from the listing is NOT "gone" until the grace window ends.
  const justStarted = { ...run, at: new Date(2026, 9, 1, 9, 5).toISOString() };
  assert.equal(settlementFor({ run: justStarted, session: undefined, now }).reason, "unseen");
  assert.equal(settlementFor({ run: justStarted, session: undefined, now, graceMs: 0 }).outcome, "gone");
});

test("settlement: a session that declared done is passed on the verdict that outlives its rounds (t6 defect 3)", () => {
  const run = {
    kind: "run-started" as const,
    runId: "run-3",
    taskId: "sch-00000001",
    sessionId: "sess-3",
    at: new Date(2026, 9, 1, 9, 0).toISOString(),
  };
  const now = new Date(2026, 9, 1, 9, 30);
  // EXACTLY what the observer reports for a session that got a READY and then
  // `declare_done`d: the round history is cleared, the standing binding is not,
  // and the completion record is there (lib/declare-done-tool.ts,
  // lib/daemon/sessions.ts `readRounds`). Read off `rounds` alone this was
  // `failed` / `verdict: null` — the normal end of a run could not be `passed`.
  const declaredDone = sessionFor("sess-3", {
    state: "idle",
    completedAt: "2026-10-01T09:20:00.000Z",
    rounds: { sent: 2, recorded: 0, lastVerdict: "READY" },
  });
  const decision = settlementFor({ run, session: declaredDone, now });
  assert.equal(decision.outcome, "passed");
  assert.equal(decision.verdict, "READY");
  assert.equal(decision.reason, "settled");

  // A completion settles the run even when the pane word never arrived: the
  // window may still be open and the transcript freshly written, and the
  // session's own statement that it finished is enough (it is what
  // `declare_done` accepts).
  assert.equal(
    settlementFor({ run, session: sessionFor("sess-3", { state: "working", completedAt: "2026-10-01T09:20:00.000Z" }), now }).outcome,
    "passed",
  );
  // …but the CONTENT still decides: the same completion with no standing
  // verdict is a failure, not a pass.
  assert.equal(
    settlementFor({
      run,
      session: sessionFor("sess-3", {
        state: "done",
        completedAt: "2026-10-01T09:20:00.000Z",
        rounds: { sent: 2, recorded: 0, lastVerdict: null },
      }),
      now,
    }).outcome,
    "failed",
  );
  // …and the pane word the gate derives from that same record releases the veto
  // on its own: it is one fact read twice, and the transcript window can drop
  // the record, so neither form may be the only way out (the run would occupy
  // its repo for as long as the process lived).
  assert.equal(
    settlementFor({
      run,
      session: sessionFor("sess-3", { state: "done", rounds: { sent: 2, recorded: 0, lastVerdict: "READY" } }),
      now,
      evidence: { holdsCheckout: true, transcriptAt: null },
    }).outcome,
    "passed",
  );
});

test("settlement: a run that still holds its checkout is not 'gone' (t6 defect 2)", () => {
  const run = {
    kind: "run-started" as const,
    runId: "run-2",
    taskId: "sch-00000001",
    sessionId: "sess-2",
    at: new Date(2026, 9, 1, 9, 0).toISOString(),
  };
  // TWENTY MINUTES past its start: absence of observation alone would settle
  // this as gone here.
  const now = new Date(2026, 9, 1, 9, 20);
  const goneWithoutEvidence = settlementFor({ run, session: undefined, now });
  assert.equal(goneWithoutEvidence.outcome, "gone");

  assert.deepEqual(
    settlementFor({ run, session: undefined, now, evidence: { holdsCheckout: true, transcriptAt: null } }),
    { settle: false, outcome: null, verdict: null, unmet: [], reason: "running" },
    "its own checkout heartbeat is a live process, not a closed run",
  );
  assert.equal(
    settlementFor({
      run,
      session: undefined,
      now,
      evidence: { holdsCheckout: false, transcriptAt: new Date(2026, 9, 1, 9, 19, 30).toISOString() },
    }).settle,
    false,
    "a transcript written seconds ago has a live writer",
  );
  // …and the evidence expires on its own: a transcript that stopped is not
  // evidence any more (lib/daemon/sessions.ts TRANSCRIPT_ACTIVE_MS).
  assert.equal(
    settlementFor({
      run,
      session: undefined,
      now,
      evidence: { holdsCheckout: false, transcriptAt: new Date(2026, 9, 1, 9, 10).toISOString() },
    }).outcome,
    "gone",
  );

  // The same veto one word over: the observer calls the session `idle` (no
  // pane, no name, its transcript quiet) while the process is blocked in a long
  // command — it is alive, and its repo is not free yet.
  const quiet = sessionFor("sess-2", { state: "idle", rounds: { sent: 1, recorded: 1, lastVerdict: "READY" } });
  assert.equal(settlementFor({ run, session: quiet, now }).outcome, "passed");
  assert.equal(
    settlementFor({ run, session: quiet, now, evidence: { holdsCheckout: true, transcriptAt: null } }).settle,
    false,
    "a live process is not a finished run",
  );
});

// ---------------------------------------------------------------------------
// the ledger's questions
// ---------------------------------------------------------------------------

test("openRuns drops what settled", () => {
  const records = [
    { kind: "run-started" as const, runId: "r1", taskId: "t1", sessionId: "s1", at: "2026-10-01T00:00:00.000Z" },
    { kind: "run-started" as const, runId: "r2", taskId: "t2", sessionId: "s2", at: "2026-10-01T01:00:00.000Z" },
    {
      kind: "run-settled" as const,
      runId: "r1",
      taskId: "t1",
      at: "2026-10-01T02:00:00.000Z",
      outcome: "passed" as const,
      verdict: "READY",
      unmet: [],
    },
    { kind: "run-skipped" as const, taskId: "t3", at: "2026-10-01T03:00:00.000Z", reason: "busy" },
  ];
  assert.deepEqual(openRuns(records).map((run) => run.runId), ["r2"]);
});

// ---------------------------------------------------------------------------
// the tick
// ---------------------------------------------------------------------------

test("a tick fires a due task once, and a restart does not fire it again", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  const scheduled = dueTask(home, repo, { requirement: "每天跑一次审计" });
  const tmux = fakeTmux();
  const observer = fakeObserver([]);

  const first = createScheduler({ home, runTmux: tmux, observer });
  first.tick();
  const started = readScheduleRuns(home).filter((record) => record.kind === "run-started");
  assert.equal(started.length, 1);
  // AND THE LAUNCH RECEIPT RIDES ITS OWN LINE (2026-10-03): the window the
  // settlement must close later, recorded where a restart can still find it —
  // the `run-started` line itself has to exist before the launch, so it cannot
  // carry coordinates that only exist afterwards.
  const window = readScheduleRuns(home).find((record) => record.kind === "run-window");
  assert.ok(window !== undefined && window.kind === "run-window", JSON.stringify(readScheduleRuns(home)));
  assert.equal(window.windowId, "@3");
  assert.ok(window.scopeSession.startsWith("rg-"));
  assert.equal(window.runId, started[0]!.runId);

  // Same slot, another tick — and then a whole new scheduler over the same
  // home, which is what a daemon restart is: one process becomes another.
  first.tick();
  const restarted = createScheduler({ home, runTmux: tmux, observer });
  restarted.tick();
  assert.equal(
    readScheduleRuns(home).filter((record) => record.kind === "run-started").length,
    1,
    "a slot is dealt with once, across restarts",
  );

  // …and the slot moved: the table says so, so the next tick is "not yet".
  const after = readSchedules(home);
  assert.equal(after.ok && after.file.tasks[0]!.lastFiredAt !== null, true);
  assert.equal(dueDecision({ task: after.ok ? after.file.tasks[0]! : scheduled, now: new Date(), openRun: false }).due, false);

  // The run started with its contract's station, the run identity in the
  // environment, and a first message that says what to do.
  const creation = tmux.calls.find((argv) => argv[0] === "new-session")!;
  assert.ok(creation.some((entry) => entry.startsWith("RG_SCHEDULE_ID=sch-")), creation.join(" "));
  assert.ok(creation.some((entry) => entry.startsWith("RG_SCHEDULE_RUN=run-")), creation.join(" "));
  assert.ok(creation.includes("RG_STATION_CAP=commit"), creation.join(" "));
  assert.ok(creation.includes("RG_GATE_MODE=loop"), creation.join(" "));
  const opening = creation.slice(creation.indexOf("--") + 1).join(" ");
  assert.match(opening, new RegExp(`这是定时任务 ${scheduled.name} 的一次运行`));
  assert.match(opening, /run-[0-9a-f]{8}/, "the run id names WHICH run this is");
  assert.match(opening, /每天跑一次审计/);
  assert.match(opening, /\.pi\/loop-goal\.md/);
  assert.match(opening, /judge_submit/);
  assert.match(opening, /declare_done/);
});

test("a week offline RUNS the owed slot once, and the rhythm resumes from there (2026-10-03)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  // A daily 09:00 task whose base is a week old: the slot it is counting
  // towards arrived while no daemon was running. LATE IS NOT LOST any more.
  const added = addScheduledTask(home, scheduleTaskInput(repo, { cron: "0 9 * * *" }));
  if (!added.ok) assert.fail(added.problem);
  const stamped = updateScheduledTask(
    home,
    added.value.id,
    { lastFiredAt: new Date(2026, 8, 20, 9, 0, 5).toISOString() },
    { from: "gate" },
  );
  if (!stamped.ok) assert.fail(stamped.problem);
  // THE TICK'S OWN CLOCK, moved by hand: the daemon "comes back up" here.
  const at = new Date(2026, 8, 30, 10, 0);
  const tmux = fakeTmux();
  const scheduler = createScheduler({ home, runTmux: tmux, observer: fakeObserver([]), now: () => at.getTime() });

  scheduler.tick();
  assert.equal(tmux.calls.filter((argv) => argv[0] === "new-session").length, 1, "停机跨过的时点补跑一次");
  const records = readScheduleRuns(home);
  assert.equal(records.filter((record) => record.kind === "run-started").length, 1);
  assert.equal(records.filter((record) => record.kind === "run-skipped").length, 0, "不写跳过：这一槽是被跑掉的");
  // ONE RUN, NOT SEVEN: the base moves to `now`, so the other slots the outage
  // covered are never named by anything — there is no catch-up queue.
  const table = readSchedules(home);
  assert.ok(table.ok, table.ok ? "" : table.problem);
  assert.equal(table.ok && table.file.tasks[0]!.lastFiredAt, at.toISOString(), "这一槽被消费：基准前移到现在");
  scheduler.tick();
  assert.equal(
    readScheduleRuns(home).filter((record) => record.kind === "run-started").length,
    1,
    "同一个槽不会跑第二遍",
  );
});

test("a checkout that cannot be cut KEEPS the slot — the next tick tries again (2026-10-03)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  const task = dueTask(home, repo, { name: "unbuildable-checkout" });
  const tmux = fakeTmux();
  const logs: string[] = [];
  // A TEMPORARY obstacle: a full disk, a repo mid-rebuild. Nothing may be
  // consumed — if the slot were stamped, the run would be lost for a whole
  // period because of something that fixes itself in seconds.
  const broken = createSchedulerRaw({
    home,
    runTmux: tmux,
    observer: fakeObserver([]),
    log: (message) => logs.push(message),
    worktrees: {
      cut: () => ({ ok: false, problem: "磁盘满了" }),
      settle: () => ({ action: "reclaimed", branch: "", changes: false, note: "fake" }),
    },
  });
  broken.tick();
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-started").length, 0, "切不出 checkout 就不发车");
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-skipped").length, 0, "暂时障碍不写 run-skipped");
  assert.ok(logs.some((message) => message.includes("磁盘满了")), logs.join("\n"));
  const table = readSchedules(home);
  assert.ok(table.ok, table.ok ? "" : table.problem);
  assert.equal(table.ok && table.file.tasks[0]!.lastFiredAt, task.lastFiredAt, "槽没被消费：基准没动");

  // THE OBSTACLE PASSES — and the very next tick runs that same slot.
  const healthy = createScheduler({ home, runTmux: tmux, observer: fakeObserver([]) });
  healthy.tick();
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-started").length, 1, "条件一好就补上这一次");
  healthy.tick();
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-started").length, 1, "仍然只跑一次");
});

test("a run that already settled is not re-settled on every tick (2026-10-03, quality P1)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  // DISABLED so no due slot fires a second run into this test.
  const added = addScheduledTask(home, scheduleTaskInput(repo, { name: "settled-long-ago", enabled: false }));
  if (!added.ok) assert.fail(added.problem);
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const checkout = { worktree: "/tmp/rg-worktrees/fake-sch", branch: "rg-schedule-runaaaa5555", base: "0".repeat(40) };
  appendScheduleRun(home, { kind: "run-armed", runId: "run-aaaa5555", taskId: added.value.id, sessionId: "sess-aaaa5555", at, ...checkout });
  appendScheduleRun(home, { kind: "run-started", runId: "run-aaaa5555", taskId: added.value.id, sessionId: "sess-aaaa5555", at, ...checkout });
  appendScheduleRun(home, { kind: "run-settled", runId: "run-aaaa5555", taskId: added.value.id, at, outcome: "passed", verdict: "READY", unmet: [] });
  const scheduler = createScheduler({
    home,
    runTmux: fakeTmux(),
    // THE SESSION IS STILL VISIBLE (it finished an hour ago; the observer keeps
    // sessions far longer than that): "is it still OPEN?" would re-settle this
    // run every tick and append a duplicate `run-settled` forever.
    observer: fakeObserver([
      sessionFor("sess-aaaa5555", { repo, state: "done", rounds: { sent: 1, recorded: 1, lastVerdict: "READY" } }),
    ]),
  });
  scheduler.tick();
  scheduler.tick();
  assert.equal(
    readScheduleRuns(home).filter((record) => record.kind === "run-settled").length,
    1,
    "已结算的运行不会被每 20 秒重复结算",
  );
});

test("an ARMED run whose `run-started` never landed is still settled (2026-10-03, quality P2)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  const task = dueTask(home, repo, { name: "orphaned-arm" });
  // THE STATE A CRASH BETWEEN THE TWO WRITES LEAVES: only the arming line, no
  // `run-started` — while the session it started is real and working. Nothing
  // else would ever settle it (the window stays open, the checkout is never
  // reclaimed, its output has no landing), so the tick's orphan pass does.
  appendScheduleRun(home, {
    kind: "run-armed",
    runId: "run-eeee7777",
    taskId: task.id,
    sessionId: "sess-eeee7777",
    at: new Date(Date.now() - 60_000).toISOString(),
    worktree: "/tmp/rg-worktrees/fake-sch",
    branch: "rg-schedule-runeeee7777",
    base: "0".repeat(40),
  });
  createScheduler({
    home,
    runTmux: fakeTmux(),
    observer: fakeObserver([
      sessionFor("sess-eeee7777", { repo, state: "done", rounds: { sent: 1, recorded: 1, lastVerdict: "READY" } }),
    ]),
  }).tick();
  const settled = readScheduleRuns(home).filter((record) => record.kind === "run-settled");
  assert.equal(settled.length, 1, "孤儿运行必须被结算，否则它永远占着 checkout");
  assert.equal(settled[0]!.kind === "run-settled" && settled[0]!.outcome, "passed");
});

test("a task whose contract does NOT check out is never launched (2026-10-03, reviewer P1)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  const task = dueTask(home, repo, { name: "broken-contract" });
  // A HAND-DAMAGED CONTRACT: the store's reader does not verify the hashes
  // (adoption does), so a task like this reaches the scheduler looking runnable.
  const read = readSchedules(home);
  assert.ok(read.ok, read.ok ? "" : read.problem);
  const damaged = {
    ...read.file,
    tasks: read.file.tasks.map((entry) => (entry.id === task.id
      ? { ...entry, contract: { ...entry.contract, goal: { ...entry.contract.goal, hash: "deadbeef" } } }
      : entry)),
  };
  writeFileSync(schedulesPath(home), JSON.stringify(damaged));

  const tmux = fakeTmux();
  createScheduler({ home, runTmux: tmux, observer: fakeObserver([]) }).tick();
  assert.equal(tmux.calls.filter((argv) => argv[0] === "new-session").length, 0, "不发一辆注定继承不了契约的车");
  const skips = readScheduleRuns(home).filter((record) => record.kind === "run-skipped");
  assert.equal(skips.length, 1);
  assert.match(skips[0]!.reason, /契约不成立/);
});

test("a checkout that can NEVER be cut consumes the slot and names the reason (2026-10-03)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  dueTask(home, repo, { name: "repo-without-git" });
  const broken = createSchedulerRaw({
    home,
    runTmux: fakeTmux(),
    observer: fakeObserver([]),
    worktrees: {
      cut: () => ({ ok: false, problem: "repo 不是 git 仓库：/x", permanent: true }),
      settle: () => ({ action: "reclaimed", branch: "", changes: false, note: "fake" }),
    },
  });
  broken.tick();
  const records = readScheduleRuns(home);
  assert.equal(records.filter((record) => record.kind === "run-started").length, 0);
  const skips = records.filter((record) => record.kind === "run-skipped");
  assert.equal(skips.length, 1, "永久障碍写一条 run-skipped（goal 的四类之一）");
  assert.match(skips[0]!.reason, /不是 git 仓库/);
  // CONSUMED: waiting longer will not produce a repository, so the slot is spent
  // — the next tick is quiet instead of trying again every 20 seconds.
  broken.tick();
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-skipped").length, 1);
});

test("a run that outlives its own slot keeps that slot owed until it settles (2026-10-03)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  const added = addScheduledTask(home, scheduleTaskInput(repo, { cron: "0 * * * *" }));
  if (!added.ok) assert.fail(added.problem);
  const stamped = updateScheduledTask(
    home,
    added.value.id,
    { lastFiredAt: new Date(2026, 8, 30, 9, 0, 5).toISOString() },
    { from: "gate" },
  );
  if (!stamped.ok) assert.fail(stamped.problem);
  appendScheduleRun(home, {
    kind: "run-started",
    runId: "run-cccc7777",
    taskId: added.value.id,
    sessionId: "sess-cccc7777",
    at: new Date(2026, 8, 30, 9, 0, 5).toISOString(),
  });
  let at = new Date(2026, 8, 30, 10, 10, 30);
  let sessions: DaemonSession[] = [sessionFor("sess-cccc7777", { repo, state: "working" })];
  const observer: SessionObserver = {
    collect: () => ({ now: at.toISOString(), tmuxReadable: true, sessions, problems: [] }),
    transcriptFor: () => undefined,
    outputFor: () => [],
  };
  const tmux = fakeTmux();
  const scheduler = createScheduler({ home, runTmux: tmux, observer, now: () => at.getTime() });

  // The 10:00 slot arrived while THIS TASK'S OWN run was still going: nothing
  // starts — `open-run` — and the slot itself is NOT consumed.
  scheduler.tick();
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-skipped").length, 0, "运行还在跑：那是 open-run");
  assert.equal(tmux.calls.filter((argv) => argv[0] === "new-session").length, 0);

  // IT SETTLES AT 11:30 — and the tick that finds it settled runs the owed
  // slot right there: late by an hour and a half is still runnable.
  at = new Date(2026, 8, 30, 11, 30);
  sessions = [sessionFor("sess-cccc7777", { repo, state: "done", rounds: { sent: 1, recorded: 1, lastVerdict: "READY" } })];
  scheduler.tick();
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-settled").length, 1, "运行在本 tick 结算");
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-skipped").length, 0, "不写跳过");
  assert.equal(tmux.calls.filter((argv) => argv[0] === "new-session").length, 1, "结算之后，欠着的那一槽立刻跑");
});

test("another live session in the repo no longer stops the run (2026-10-03)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  dueTask(home, repo, { name: "busy-repo-task" });
  const presence = join(repo, ".pi", "session-presence.json");
  mkdirSync(join(repo, ".pi"), { recursive: true });
  // A FRESH heartbeat: somebody is working in the MAIN repo right now. That used
  // to cost a `run-skipped` per slot — six of them in one day on this machine.
  // The run works in its own checkout now, so it is not a conflict at all (the
  // presence file is not even read on this path any more).
  writeFileSync(
    presence,
    JSON.stringify({ sessionId: "other-session", pid: 4242, host: "host", at: new Date().toISOString() }),
    { mode: 0o600 },
  );
  const tmux = fakeTmux();
  createScheduler({ home, runTmux: tmux, observer: fakeObserver([]) }).tick();
  const records = readScheduleRuns(home);
  assert.equal(records.filter((record) => record.kind === "run-started").length, 1, "主 repo 有人也照常起");
  assert.equal(records.filter((record) => record.kind === "run-skipped").length, 0, "不再有「被占」这条跳过");
  // AND THE LEDGER NAMES THE RUN'S OWN CHECKOUT: that is what the settlement
  // and the contract adoption both need.
  const run = records.find((record) => record.kind === "run-started");
  assert.ok(run !== undefined && run.kind === "run-started", JSON.stringify(records));
  assert.equal(run.worktree?.includes("rg-fake-worktree-"), true, JSON.stringify(run));
  assert.match(run.branch ?? "", /^rg-schedule-run/);
  assert.equal(run.base, "0".repeat(40));
});

test("two tasks in one repo no longer block each other (2026-10-03)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  const holder = dueTask(home, repo, { name: "task-a" });
  const second = dueTask(home, repo, { name: "task-b", requirement: "同一 repo 的第二个任务" });
  appendScheduleRun(home, {
    kind: "run-started",
    runId: "run-aaaa1111",
    taskId: holder.id,
    sessionId: "sess-run-aaaa1111",
    at: new Date().toISOString(),
  });
  const tmux = fakeTmux();
  const scheduler = createScheduler({
    home,
    runTmux: tmux,
    observer: fakeObserver([sessionFor("sess-run-aaaa1111", { state: "working", repo })]),
  });

  // THE HAND-WRITTEN RUN IS STILL GOING, and the second task's slot is due:
  // both are open at once now — each in its own checkout, which is the whole
  // point. It used to be a `run-skipped` against the first run's id.
  scheduler.tick();
  const records = readScheduleRuns(home);
  const started = records.filter((record) => record.kind === "run-started");
  assert.equal(started.length, 2, "两个任务各起各的，不再互相阻塞");
  assert.equal(started.filter((record) => record.taskId === second.id).length, 1);
  assert.equal(records.filter((record) => record.kind === "run-skipped").length, 0);
});

test("a settling run is settled ONCE, and the repo's other task runs anyway (2026-10-03)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  const first = dueTask(home, repo, { name: "task-a" });
  const second = dueTask(home, repo, { name: "task-b", requirement: "同一 repo 的第二个任务" });
  appendScheduleRun(home, {
    kind: "run-started",
    runId: "run-bbbb2222",
    taskId: first.id,
    sessionId: "sess-run-bbbb2222",
    at: new Date().toISOString(),
  });
  const tmux = fakeTmux();
  const scheduler = createScheduler({
    home,
    runTmux: tmux,
    observer: fakeObserver([sessionFor("sess-run-bbbb2222", { state: "done", repo, unmet: ["code-review"] })]),
  });

  scheduler.tick();
  const records = readScheduleRuns(home);
  const settled = records.filter((record) => record.kind === "run-settled");
  assert.equal(settled.length, 1);
  assert.equal(settled[0]!.runId, "run-bbbb2222");
  assert.equal(settled[0]!.outcome, "passed");
  assert.deepEqual(settled[0]!.unmet, ["code-review"]);

  // BOTH tasks are due and share a repo — and both run. Nothing waits for the
  // other's checkout any more.
  const started = records.filter((record) => record.kind === "run-started");
  assert.equal(started.length, 3, "the hand-written run plus one for EACH due task");
  assert.deepEqual(
    started.filter((record) => record.runId !== "run-bbbb2222").map((record) => record.taskId).sort(),
    [first.id, second.id].sort(),
  );
  assert.equal(records.filter((record) => record.kind === "run-skipped").length, 0);
});

test("a settled run's window is closed — the checkout it held is reclaimed (quality round P1)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  const tmux = fakeTmux();
  const scopeName = ownSessionName(daemonTmuxScope({
    home,
    identity: ensureDaemonIdentity(home),
    runTmux: tmux,
    anchorRepo: repo,
  }));
  assert.ok(scopeName !== undefined, "the daemon derives its own scope session name");

  // NO TASK IN THIS REPO YET: these ticks exercise the SETTLE path, and a due
  // task would fire a run of its own (which would then hold the repo and block
  // the guard's branch below).
  const start = (runId: string, sessionId: string): void => {
    appendScheduleRun(home, { kind: "run-started", runId, taskId: "sch-bbbb2222", sessionId, at: new Date().toISOString() });
  };

  // The run is over (done + a recorded round). Its window is the daemon's own,
  // so the daemon closes it — a session holds its worktree until its PROCESS
  // exits, and `declare_done` does not release it.
  start("run-bbbb2222", "sess-bbbb2222");
  createScheduler({
    home,
    runTmux: tmux,
    observer: fakeObserver([
      sessionFor("sess-bbbb2222", { state: "done", repo, tmux: { session: scopeName!, window: "@7", pane: "%7" } }),
    ]),
  }).tick();
  assert.ok(
    tmux.calls.some((argv) => argv[0] === "kill-window" && argv.includes(`${scopeName}:@7`)),
    `expected the daemon to close its own window, got: ${JSON.stringify(tmux.calls)}`,
  );

  // A session in SOMEBODY ELSE'S session is not the daemon's to close.
  start("run-cccc3333", "sess-cccc3333");
  const killsBefore = tmux.calls.filter((argv) => argv[0] === "kill-window").length;
  createScheduler({
    home,
    runTmux: tmux,
    observer: fakeObserver([
      sessionFor("sess-cccc3333", { state: "done", repo, tmux: { session: "somebody-elses", window: "@8", pane: "%8" } }),
    ]),
  }).tick();
  assert.equal(tmux.calls.filter((argv) => argv[0] === "kill-window").length, killsBefore, "别人的 window 不关");

  // A SETTLEMENT HAPPENS ONCE: the next tick has nothing left to settle for it.
  createScheduler({ home, runTmux: tmux, observer: fakeObserver([]) }).tick();
  assert.equal(
    readScheduleRuns(home).filter((record) => record.kind === "run-settled" && record.runId === "run-bbbb2222").length,
    1,
    "同一个运行不会结算两次",
  );
});

test("a crash between the ledger line and the stamp still does not fire the slot twice (2026-10-03)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  const task = dueTask(home, repo, { name: "crash-window" });
  // THE STATE A CRASH LEAVES BEHIND: the `run-started` line is on disk (it is
  // written BEFORE the launch), the table's `lastFiredAt` is still the old
  // stamp, and the session went down with the daemon. A restart must not start
  // that slot a second time — the open run is what blocks it.
  appendScheduleRun(home, {
    kind: "run-started",
    runId: "run-cccc9999",
    taskId: task.id,
    sessionId: "sess-cccc9999",
    at: new Date().toISOString(),
  });
  const tmux = fakeTmux();
  const scheduler = createScheduler({ home, runTmux: tmux, observer: fakeObserver([]) });
  scheduler.tick();
  assert.equal(
    readScheduleRuns(home).filter((record) => record.kind === "run-started").length,
    1,
    "未结算的那次运行挡住这一槽",
  );
  assert.equal(tmux.calls.filter((argv) => argv[0] === "new-session").length, 0, "重启不会把它再发一次");
});

test("the run's ledger line is written BEFORE the session starts (2026-10-03, reviewer P1)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  dueTask(home, repo, { name: "ledger-first" });
  let atLaunch: ReturnType<typeof readScheduleRuns> = [];
  const tmux = fakeRunner((argv) => {
    if (argv[0] === "list-sessions") return { ok: true, stdout: "", stderr: "" };
    if (argv[0] === "new-session") atLaunch = readScheduleRuns(home);
    return { ok: true, stdout: "@3 %9\n", stderr: "" };
  });
  createScheduler({ home, runTmux: tmux, observer: fakeObserver([]) }).tick();

  // THE SESSION ADOPTS ITS CONTRACT AT `session_start`, and adoption asks the
  // ledger whether this session IS this run. Writing that line after the launch
  // left a real window (pi's cold start is seconds; the write is one line) in
  // which a scheduled run started with no contract at all.
  //
  // IT IS A `run-armed` LINE, not a `run-started`: a launch that never happens
  // must leave nothing that counts as a run (reviewer P1).
  const armed = atLaunch.filter((record) => record.kind === "run-armed");
  assert.equal(armed.length, 1, "起会话那一刻，台账里已经有了这次运行的授权行");
  assert.equal(atLaunch.filter((record) => record.kind === "run-started").length, 0, "会话还没起来，就还不是一次运行");
  // …and the real run, plus its window coordinates, land a moment later.
  const after = readScheduleRuns(home);
  const runs = after.filter((record) => record.kind === "run-started");
  assert.equal(runs.length, 1);
  const windows = after.filter((record) => record.kind === "run-window");
  assert.equal(windows.length, 1);
  assert.equal(
    windows[0]!.kind === "run-window" && windows[0]!.runId,
    runs[0]!.kind === "run-started" && runs[0]!.runId,
  );
});

test("a launch that never happened leaves no OPEN run behind (2026-10-03)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  dueTask(home, repo, { name: "launch-fails" });
  const failing = fakeRunner((argv) => {
    if (argv[0] === "list-sessions") return { ok: true, stdout: "", stderr: "" };
    if (argv[0] === "new-session") return { ok: false, stdout: "", stderr: "tmux refused" };
    return { ok: true, stdout: "@3 %9\n", stderr: "" };
  });
  createScheduler({ home, runTmux: failing, observer: fakeObserver([]) }).tick();
  const records = readScheduleRuns(home);
  assert.equal(records.filter((record) => record.kind === "run-started").length, 0, "起不来的会话不是一次运行");
  assert.equal(
    records.filter((record) => record.kind === "run-settled").length,
    0,
    "也不写它的结局：幽灵运行会出现在面板历史里（reviewer P1）",
  );
  assert.equal(records.filter((record) => record.kind === "run-armed").length, 1, "只留下契约继承用的那行登记");
  assert.equal(records.filter((record) => record.kind === "run-skipped").length, 0, "暂时性失败：槽留着");

  // THE SLOT IS STILL OWED: the next tick tries again, with a new run.
  createScheduler({ home, runTmux: fakeTmux(), observer: fakeObserver([]) }).tick();
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-started").length, 1);
});

test("coordinates recorded in a LATER line still close a pane-less window (2026-10-03)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  const tmux = fakeTmux();
  const scopeName = ownSessionName(daemonTmuxScope({
    home,
    identity: ensureDaemonIdentity(home),
    runTmux: tmux,
    anchorRepo: repo,
  }));
  assert.ok(scopeName !== undefined);
  const id = addScheduledTask(home, scheduleTaskInput(repo, { name: "window-later", enabled: false }));
  if (!id.ok) assert.fail(id.problem);
  appendScheduleRun(home, {
    kind: "run-started",
    runId: "run-ffff8888",
    taskId: id.value.id,
    sessionId: "sess-ffff8888",
    at: new Date(Date.now() - 60_000).toISOString(),
  });
  appendScheduleRun(home, {
    kind: "run-window",
    runId: "run-ffff8888",
    taskId: id.value.id,
    sessionId: "sess-ffff8888",
    at: new Date(Date.now() - 59_000).toISOString(),
    scopeSession: scopeName!,
    windowId: "@12",
    server: TEST_TMUX_SERVER,
  });
  mkdirSync(join(repo, ".pi"), { recursive: true });
  writeFileSync(
    join(repo, ".pi", "session-presence.json"),
    JSON.stringify({ sessionId: "sess-ffff8888", pid: 4242, host: "host", at: new Date().toISOString() }),
    { mode: 0o600 },
  );
  createScheduler({
    home,
    runTmux: tmux,
    observer: fakeObserver([
      sessionFor("sess-ffff8888", {
        repo,
        tmux: null,
        state: "working",
        completedAt: new Date().toISOString(),
        rounds: { sent: 1, recorded: 0, lastVerdict: "READY" },
      }),
    ]),
  }).tick();
  assert.ok(
    tmux.calls.some((argv) => argv[0] === "kill-window" && argv.includes(`${scopeName}:@12`)),
    `expected the RECORDED window to be closed, got: ${JSON.stringify(tmux.calls)}`,
  );
});

test("a settled run whose pane lost its @rg_sid is still closed by its launch receipt (t6 defect 2)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  const tmux = fakeTmux();
  const scopeName = ownSessionName(daemonTmuxScope({
    home,
    identity: ensureDaemonIdentity(home),
    runTmux: tmux,
    anchorRepo: repo,
  }));
  assert.ok(scopeName !== undefined);
  const added = addScheduledTask(home, scheduleTaskInput(repo, { name: "sidelined", cron: EVERY_FIVE_MINUTES }));
  if (!added.ok) assert.fail(added.problem);
  // THE LAUNCH RECEIPT IS ITS OWN LINE (t7 + 2026-10-03): once the pane has lost
  // `@rg_sid` the window id cannot be read back from anywhere else, and the
  // server that minted it is what makes the id safe to act on.
  appendScheduleRun(home, {
    kind: "run-started",
    runId: "run-aaaa9999",
    taskId: added.value.id,
    sessionId: "sess-aaaa9999",
    at: new Date(Date.now() - 60_000).toISOString(),
  });
  appendScheduleRun(home, {
    kind: "run-window",
    runId: "run-aaaa9999",
    taskId: added.value.id,
    sessionId: "sess-aaaa9999",
    at: new Date(Date.now() - 60_000).toISOString(),
    scopeSession: scopeName,
    windowId: "@9",
    server: TEST_TMUX_SERVER,
  });
  // The run concluded (`declare_done`), and its checkout heartbeat is fresh: the
  // process — and therefore the window — is still there. The OBSERVER has no
  // pane for it, which is exactly the case that used to leave the checkout
  // occupied until the user closed the window by hand.
  mkdirSync(join(repo, ".pi"), { recursive: true });
  writeFileSync(
    join(repo, ".pi", "session-presence.json"),
    JSON.stringify({ sessionId: "sess-aaaa9999", pid: 4242, host: "host", at: new Date().toISOString() }),
    { mode: 0o600 },
  );
  const logs: string[] = [];
  const scheduler = (): Scheduler => createScheduler({
    home,
    runTmux: tmux,
    log: (message) => logs.push(message),
    observer: fakeObserver([
      sessionFor("sess-aaaa9999", {
        repo,
        tmux: null,
        state: "working",
        completedAt: new Date().toISOString(),
        rounds: { sent: 1, recorded: 0, lastVerdict: "READY" },
      }),
    ]),
  });
  scheduler().tick();

  const settled = readScheduleRuns(home).filter((record) => record.kind === "run-settled");
  assert.equal(settled.length, 1, logs.join("\n"));
  assert.equal(settled[0]!.outcome, "passed");
  assert.ok(
    tmux.calls.some((argv) => argv[0] === "kill-window" && argv.includes(`${scopeName}:@9`)),
    `expected the RECORDED window to be closed, got: ${JSON.stringify(tmux.calls)}`,
  );
  // AND THE RUN IS NOT SETTLED TWICE: the next tick finds nothing left for it,
  // whatever the checkout's heartbeat says.
  scheduler().tick();
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-settled").length, 1, logs.join("\n"));
});

test("a run the listing cannot place is not settled while its own checkout still names it (t6 defect 2)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  const presence = join(repo, ".pi", "session-presence.json");
  const writePresence = (sessionId: string, at: string): void => {
    mkdirSync(join(repo, ".pi"), { recursive: true });
    writeFileSync(presence, JSON.stringify({ sessionId, pid: 4242, host: "host", at }), { mode: 0o600 });
  };
  const settled = (): Array<{ outcome?: string }> => readScheduleRuns(home).filter((record) => record.kind === "run-settled");
  // THE RUN'S TASK IS IN THE TABLE, because that is what names its checkout
  // (`repoOfRun`) when the session itself cannot be placed. It is DISABLED so
  // no due slot fires a second run into this test.
  const added = addScheduledTask(home, scheduleTaskInput(repo, { name: "unplaceable-run", enabled: false }));
  if (!added.ok) assert.fail(added.problem);
  // TEN MINUTES OLD: well past the settle grace, so only evidence of life can
  // keep this run open — and that is exactly the defect: the run settled `gone`
  // 21 minutes BEFORE its session recorded the READY it ended up with.
  appendScheduleRun(home, {
    kind: "run-started",
    runId: "run-eeee5555",
    taskId: added.value.id,
    sessionId: "sess-eeee5555",
    at: new Date(Date.now() - 10 * 60_000).toISOString(),
  });
  const scheduler = createScheduler({ home, runTmux: fakeTmux(), observer: fakeObserver([]) });

  // THE RUN'S OWN HEARTBEAT in the checkout it is working in: the observer could
  // not place the session (its pane lost `@rg_sid`), but this says a live
  // process is behind it — settling here frees the repo for a second writer.
  writePresence("sess-eeee5555", new Date().toISOString());
  scheduler.tick();
  assert.equal(settled().length, 0, "观测不到 ≠ 确实结束");

  // SOMEBODY ELSE, LONG AGO: a stale heartbeat is nobody (the same window the
  // fire-side guard reads), and nothing else claims this run is alive.
  writePresence("somebody-else", new Date(Date.now() - 5 * 60_000).toISOString());
  scheduler.tick();
  assert.equal(settled().length, 1);
  assert.equal(settled()[0]!.outcome, "gone", "无任何存活迹象、宽限期也过了，才算 gone");
});

test("a run whose transcript is still moving is alive; one that stopped is not (t6 defect 2)", () => {
  const home = scratchHome();
  const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const transcript = join(home, "sess-ffff6666.jsonl");
  writeFileSync(transcript, "\n");
  appendScheduleRun(home, {
    kind: "run-started",
    runId: "run-ffff6666",
    taskId: "sch-ffff6666",
    sessionId: "sess-ffff6666",
    at: startedAt,
  });
  const observer = fakeObserver([], { "sess-ffff6666": transcript });
  const settled = (): Array<{ outcome?: string }> => readScheduleRuns(home).filter((record) => record.kind === "run-settled");

  createScheduler({ home, runTmux: fakeTmux(), observer }).tick();
  assert.equal(settled().length, 0, "转写还在动 ⇒ 有活着的写者，继续等");

  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(transcript, old, old);
  createScheduler({ home, runTmux: fakeTmux(), observer }).tick();
  assert.equal(settled()[0]?.outcome, "gone", "停下来的转写不再算存活证据");
});

test("a task whose launch fails is recorded as a skip, not retried every tick", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  dueTask(home, repo);
  const tmux = fakeRunner(() => ({ ok: false, stdout: "", stderr: "no tmux server" }));
  const scheduler = createScheduler({ home, runTmux: tmux, observer: fakeObserver([]) });
  scheduler.tick();
  const skips = readScheduleRuns(home).filter((record) => record.kind === "run-skipped");
  assert.equal(skips.length, 1);
  assert.match(skips[0]!.reason, /起会话失败/);
  scheduler.tick();
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-skipped").length, 1, "the slot is dealt with once");
});

test("the tick does nothing at all when the table cannot be read", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  dueTask(home, repo);
  // A hand-edited, broken document: t1 refuses to read it, and the tick must
  // not read it as "no tasks" (that is how a repair would silently stop work).
  writeFileSync(`${home}/.pi/agent/rg-daemon/schedules.json`, "{ not json");
  const tmux = fakeTmux();
  const scheduler = createScheduler({ home, runTmux: tmux, observer: fakeObserver([]) });
  scheduler.tick();
  assert.equal(readScheduleRuns(home).length, 0);
  assert.equal(tmux.calls.filter((argv) => argv[0] === "new-session").length, 0);
});

test("a ledger that cannot be written starts NO session — the slot stays owed (2026-10-03)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  const task = dueTask(home, repo, { name: "task-a" });
  // The ledger path as a DIRECTORY: `appendScheduleRun` throws EISDIR on every
  // tick, while the table still writes.
  mkdirSync(scheduleRunsPath(home), { recursive: true });
  const tmux = fakeTmux();
  const scheduler = createScheduler({ home, runTmux: tmux, observer: fakeObserver([]) });
  scheduler.tick();
  scheduler.tick();
  scheduler.tick();
  // A SESSION CANNOT INHERIT A CONTRACT IT CANNOT READ (reviewer P1): adoption
  // reads the ledger file, and that file is unwritable — so nothing is launched
  // at all, and the slot stays owed instead of being spent on a run that would
  // start with no contract.
  const launches = tmux.calls.filter((argv) => argv[0] === "new-session" || argv[0] === "new-window").length;
  assert.equal(launches, 0, "台账写不进去就不发车");
  const table = readSchedules(home);
  assert.equal(
    table.ok && table.file.tasks[0]!.lastFiredAt,
    task.lastFiredAt,
    "槽没被消费：磁盘好了它还会跑",
  );
});

test("one task's failure does not take the tick with it, and neither does a broken clock", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  dueTask(home, repo);
  // The ledger path as a DIRECTORY: `appendFileSync` throws EISDIR on it — a
  // write that THROWS, which is exactly what a resident daemon must survive.
  mkdirSync(scheduleRunsPath(home), { recursive: true });
  const scheduler = createScheduler({ home, runTmux: fakeTmux(), observer: fakeObserver([]) });
  assert.doesNotThrow(() => scheduler.tick(), "one task's failure must not escape the tick");

  // And the outermost guard: a tick that throws on its first line is logged,
  // not an uncaught exception out of a timer callback (that is a daemon that
  // dies and does not come back by itself).
  const broken = createScheduler({
    home,
    runTmux: fakeTmux(),
    observer: fakeObserver([]),
    now: () => { throw new Error("clock broke"); },
    clock: { every: () => (() => { /* nothing to cancel */ }) },
  });
  assert.doesNotThrow(() => broken.start());
});

test("runTaskText names the task, its requirement, this run and the gate's own steps", () => {
  const text = runTaskText(task({ name: "nightly" }), new Date(2026, 9, 1, 9, 0), "run-abc12345");
  assert.match(text, /这是定时任务 nightly 的一次运行（run-abc12345/);
  assert.match(text, /每天 09:00 跑一次审计/);
  assert.match(text, /\.pi\/loop-goal\.md/);
  assert.match(text, /judge_submit/);
  assert.match(text, /declare_done/);
});

test("start() ticks immediately and stops on stop()", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  dueTask(home, repo);
  const tmux = fakeTmux();
  const ticks: Array<() => void> = [];
  const scheduler: Scheduler = createScheduler({
    home,
    runTmux: tmux,
    observer: fakeObserver([]),
    clock: { every: (_ms, fn) => { ticks.push(fn); return () => { ticks.length = 0; }; } },
  });
  scheduler.start();
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-started").length, 1, "start() ticks once right away");
  assert.equal(ticks.length, 1, "and arms the timer");
  scheduler.stop();
  assert.equal(ticks.length, 0, "stop() cancels the timer");
});
