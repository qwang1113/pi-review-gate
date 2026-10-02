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
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createScheduler,
  dueDecision,
  openRuns,
  repoHolder,
  runTaskText,
  settlementFor,
  SLOT_GRACE_MS,
  type DueDecision,
  type DueReason,
  type Scheduler,
} from "../lib/daemon/scheduler.ts";
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
import { scheduleRunsPath } from "../lib/daemon/paths.ts";
import type { TmuxRunner } from "../lib/orchestrator-tmux.ts";
import { fakeRunner, scheduleContract, scheduleTaskInput, scratchHome, scratchRepo } from "./daemon-helpers.ts";

/**
 * The cron the tick fixtures use: every five minutes, close enough together
 * that {@link justDueStamp} can name the slot a task is counting towards.
 */
const EVERY_FIVE_MINUTES = "*/5 * * * *";

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

  // A task whose daemon was away for a week is NOT due: the slot it names is
  // the first one it missed, and a missed slot is skipped (the dedicated test
  // below owns that rule and the base it consumes).
  const stale = task({ lastFiredAt: new Date(2026, 8, 20, 9, 0, 5).toISOString() });
  const late = dueDecision({ task: stale, now: new Date(2026, 8, 30, 10, 0), openRun: false });
  assert.equal(late.due, false);
  assert.equal(late.reason, "missed");

  // A stamp at or past the slot it is being judged against: already dealt with.
  const stamped = task({ lastFiredAt: new Date(2026, 8, 30, 9, 0, 30).toISOString() });
  assert.equal(dueDecision({ task: stamped, now: new Date(2026, 8, 30, 9, 0, 40), openRun: false }).reason, "not-yet");
});

test("due: a slot the daemon slept through is MISSED — skipped, never named in the past", () => {
  const now = new Date(2026, 8, 30, 10, 0);
  const stale = task({ lastFiredAt: new Date(2026, 8, 20, 9, 0, 5).toISOString() });
  const missed = dueDecision({ task: stale, now, openRun: false });
  assert.equal(missed.due, false);
  assert.equal(missed.reason, "missed");
  assert.equal(missed.missedAt?.getTime(), new Date(2026, 8, 21, 9, 0).getTime(), "被错过的就是基准之后的第一个槽");
  assert.equal(missed.scheduledAt?.getTime(), new Date(2026, 9, 1, 9, 0).getTime(), "scheduledAt 滑到 now 之后的下一次");
  assert.ok(missed.scheduledAt!.getTime() > now.getTime(), "…所以它不会指着一个过去的时间，说下一次在那里");

  // A slot that has NOT arrived is a different word — and no missedAt.
  const ahead = dueDecision({ task: task({ lastFiredAt: new Date(2026, 8, 30, 9, 0, 5).toISOString() }), now, openRun: false });
  assert.equal(ahead.reason, "not-yet");
  assert.equal(ahead.missedAt, null);
});

test("due: the grace window is what separates a late tick from a missed slot", () => {
  const fresh = task(); // the first slot after it was authored: 2026-09-30 09:00 local
  const slot = new Date(2026, 8, 30, 9, 0);
  const edge = new Date(slot.getTime() + SLOT_GRACE_MS);
  assert.equal(dueDecision({ task: fresh, now: edge, openRun: false }).reason, "due", "宽限之内仍算到点");
  const past = new Date(edge.getTime() + 1);
  assert.equal(dueDecision({ task: fresh, now: past, openRun: false }).reason, "missed", "宽限之外就是错过");
});

test("due: scheduledAt never names a time the daemon slept through", () => {
  // THE FIELD EVERY SURFACE RENDERS (the API's `nextRunAt`, the panel,
  // `schedule_task({action:"list"})`) must never claim that a slot the daemon
  // slept through is what comes next. Only two things may sit behind `now` at
  // all: the slot that has just arrived (inside the grace window, a tick away
  // from being dealt with or skipped), and the slot an UNSETTLED RUN is holding
  // — the open-run case below says why that one is honest rather than stale.
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
      label: "missed",
      now: at,
      expected: "missed",
      decision: dueDecision({ task: task({ lastFiredAt: new Date(2026, 8, 20, 9, 0, 5).toISOString() }), now: at, openRun: false }),
    },
    {
      // A WEEK-OLD BASE **and** an unsettled run: the only shape that reaches
      // this branch with a slot behind `now`.
      label: "open-run",
      now: at,
      expected: "open-run",
      decision: dueDecision({ task: task({ lastFiredAt: new Date(2026, 8, 20, 9, 0, 5).toISOString() }), now: at, openRun: true }),
    },
    {
      label: "due",
      now: new Date(2026, 8, 30, 9, 1),
      expected: "due",
      decision: dueDecision({ task: task(), now: new Date(2026, 8, 30, 9, 1), openRun: false }),
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
    if (expected === "open-run") {
      // THE ONE EXCEPTION, AND IT IS THE POINT OF THIS BRANCH: an unsettled run
      // holds the slot it was STARTED for, and a run that has been going for
      // days holds a slot from days ago. Nothing may move that base until the
      // run settles, so the honest answer is the old slot — not a "next" one
      // that would not be honoured. No panel ever sees it: `GET /api/schedules`
      // asks with `openRun: false` (daemon/server.ts), and the tool face names
      // it 「已过期：本任务还有一次运行没结算」 instead of promising a tick.
      assert.ok(decision.scheduledAt.getTime() < moment.getTime(), "open-run 显示的是那次运行正在处理的槽");
      continue;
    }
    assert.ok(
      decision.scheduledAt.getTime() > moment.getTime() - SLOT_GRACE_MS,
      `${label}: ${decision.scheduledAt.toISOString()} 落在宽限之外（now ${moment.toISOString()}）`,
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

test("openRuns drops what settled, and repoHolder compares normalized paths", () => {
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
  const repoOf = (run: { taskId: string }): string => (run.taskId === "t1" ? "/a/repo" : "/b/repo");
  const open = openRuns(records);
  assert.equal(repoHolder(open, "/a/repo", repoOf), undefined, "the settled run no longer holds anything");
  assert.equal(repoHolder(open, "/b/repo/", repoOf)?.runId, "r2", "a trailing slash is the same repository");
  assert.equal(repoHolder(open, "/c/repo", repoOf), undefined);
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
  // AND THE LAUNCH RECEIPT RIDES THE SAME LINE (t7): the window the settlement
  // must close later, recorded where a restart can still find it.
  assert.equal(started[0]!.windowId, "@3");
  assert.ok((started[0]!.scopeSession ?? "").startsWith("rg-"));

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

test("a week offline SKIPS the missed slot — and the next real slot still fires (no dead stop)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  // A daily 09:00 task whose base is a week old: the slot it is counting
  // towards arrived while no daemon was running.
  const added = addScheduledTask(home, scheduleTaskInput(repo, { cron: "0 9 * * *" }));
  if (!added.ok) assert.fail(added.problem);
  const stamped = updateScheduledTask(
    home,
    added.value.id,
    { lastFiredAt: new Date(2026, 8, 20, 9, 0, 5).toISOString() },
    { from: "gate" },
  );
  if (!stamped.ok) assert.fail(stamped.problem);
  // THE TICK'S OWN CLOCK, moved by hand: the daemon "comes back up" here, and
  // the next real slot is an assignment away.
  let at = new Date(2026, 8, 30, 10, 0);
  const tmux = fakeTmux();
  const scheduler = createScheduler({ home, runTmux: tmux, observer: fakeObserver([]), now: () => at.getTime() });

  // THREE TICKS IN A ROW: nothing starts, and the skipped slot is recorded ONCE
  // — the base moved forward, so ticks 2 and 3 are no longer looking at it.
  scheduler.tick();
  scheduler.tick();
  scheduler.tick();
  assert.equal(tmux.calls.filter((argv) => argv[0] === "new-session").length, 0, "停机跨过的时点不补跑");
  const skips = readScheduleRuns(home).filter((record) => record.kind === "run-skipped");
  assert.equal(skips.length, 1, "一槽只记一条 run-skipped");
  assert.match(skips[0]!.reason, /跳过不补跑/);
  assert.ok(
    skips[0]!.reason.includes(new Date(2026, 8, 21, 9, 0).toISOString()),
    `reason 点名被错过的那个时刻：${skips[0]!.reason}`,
  );
  const table = readSchedules(home);
  assert.ok(table.ok, table.ok ? "" : table.problem);
  assert.equal(
    table.ok && table.file.tasks[0]!.lastFiredAt,
    at.toISOString(),
    "被错过的槽被消费掉：基准前移，任务不会永远停在旧槽上",
  );

  // AND THE NEXT REAL SLOT STILL FIRES: ten hours later its own 09:00 arrives.
  at = new Date(2026, 9, 1, 9, 0, 30);
  scheduler.tick();
  assert.equal(
    readScheduleRuns(home).filter((record) => record.kind === "run-started").length,
    1,
    "跳过一个时点不等于停死：下一次到点照常跑",
  );
});

test("a run that outlives its own slot is missed for the RIGHT reason (itself, not a stopped daemon)", () => {
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
  // starts, and that is `open-run` — not a missed slot.
  scheduler.tick();
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-skipped").length, 0, "运行还在跑：那是 open-run");
  assert.equal(tmux.calls.filter((argv) => argv[0] === "new-session").length, 0);

  // IT SETTLES AT 11:30 — and the tick that finds it settled is where the base
  // finally moves. The slot is missed, but the daemon was NEVER away, and the
  // ledger has to say so.
  at = new Date(2026, 8, 30, 11, 30);
  sessions = [sessionFor("sess-cccc7777", { repo, state: "done", rounds: { sent: 1, recorded: 1, lastVerdict: "READY" } })];
  scheduler.tick();
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-settled").length, 1, "运行在本 tick 结算");
  const skips = readScheduleRuns(home).filter((record) => record.kind === "run-skipped");
  assert.equal(skips.length, 1, "结算之后，这一槽才被判错过");
  assert.ok(
    skips[0]!.reason.includes(new Date(2026, 8, 30, 10, 0).toISOString()),
    `reason 点名被错过的那个槽：${skips[0]!.reason}`,
  );
  assert.match(
    skips[0]!.reason,
    /本任务自己还有一次运行没结算/,
    "成因不能只说「daemon 不在跑」——它一直在跑",
  );
  assert.equal(tmux.calls.filter((argv) => argv[0] === "new-session").length, 0, "这一轮也不重新发车");
});

test("a run is not fired into a checkout another LIVE SESSION holds (quality round P1)", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  const task = dueTask(home, repo, { name: "held-repo-task" });
  const presence = join(repo, ".pi", "session-presence.json");
  const writePresence = (at: string): void => {
    mkdirSync(join(repo, ".pi"), { recursive: true });
    writeFileSync(presence, JSON.stringify({ sessionId: "other-session", pid: 4242, host: "host", at }), { mode: 0o600 });
  };
  const scheduler = createScheduler({ home, runTmux: fakeTmux(), observer: fakeObserver([]) });

  // A FRESH heartbeat = somebody is working in that checkout right now. The
  // gate would refuse to arm the run's session, and a run that cannot arm
  // cannot adopt its contract — so nothing is started.
  writePresence(new Date().toISOString());
  scheduler.tick();
  let records = readScheduleRuns(home);
  assert.equal(records.filter((record) => record.kind === "run-started").length, 0, "被占用的 checkout 里不出发起会话");
  const skips = records.filter((record) => record.kind === "run-skipped");
  assert.equal(skips.length, 1, "占用写成一条 run-skipped，而不是一辆开不动的车");
  assert.match(skips[0]!.reason, /other-session/, "reason 点名占用者");

  // The skip stamps the slot like any other decision: the next tick is quiet.
  scheduler.tick();
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-skipped").length, 1);

  // A LAPSED heartbeat is nobody (the exclusivity rule's own fail-open
  // direction): with the slot put back in the past, the run goes out.
  writePresence(new Date(Date.now() - 5 * 60_000).toISOString());
  const rewound = updateScheduledTask(home, task.id, { lastFiredAt: justDueStamp() }, { from: "gate" });
  assert.equal(rewound.ok, true);
  scheduler.tick();
  records = readScheduleRuns(home);
  assert.equal(records.filter((record) => record.kind === "run-started").length, 1, "过期心跳不挡车");
});

test("a repo with an unsettled run blocks the next one, and the skip names the holder", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  const holder = dueTask(home, repo, { name: "task-a" });
  const blocked = dueTask(home, repo, { name: "task-b", requirement: "同一 repo 的第二个任务" });
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

  scheduler.tick();
  const records = readScheduleRuns(home);
  assert.equal(records.filter((record) => record.kind === "run-started").length, 1, "the open run is the only one started");
  const skips = records.filter((record) => record.kind === "run-skipped");
  assert.equal(skips.length, 1, "the same repo's second task is skipped, not started");
  assert.equal(skips[0]!.taskId, blocked.id);
  assert.match(skips[0]!.reason, /run-aaaa1111/);
  assert.match(skips[0]!.reason, new RegExp(holder.id));

  // The skip stamps the slot: a 20-second-later tick does not repeat it.
  scheduler.tick();
  assert.equal(readScheduleRuns(home).filter((record) => record.kind === "run-skipped").length, 1);
});

test("a settling run frees its repo — for exactly one successor", () => {
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

  // Both tasks are due and share a repo: the settled run released it, ONE of
  // them starts, and the other is skipped against the run that just started.
  const started = records.filter((record) => record.kind === "run-started");
  assert.equal(started.length, 2, "the hand-written run plus exactly one new one");
  const fresh = started.find((record) => record.runId !== "run-bbbb2222")!;
  assert.equal(fresh.taskId, first.id, "the task whose run settled goes first");
  const skips = records.filter((record) => record.kind === "run-skipped");
  assert.equal(skips.length, 1);
  assert.equal(skips[0]!.taskId, second.id);
  assert.match(skips[0]!.reason, new RegExp(fresh.runId));
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

  // …AND IF THAT CLOSE HAD FAILED (quality round P2): the leftover window holds
  // the repo, so the next due slot finds it through the guard and closes it
  // again instead of only skipping forever.
  dueTask(home, repo, { name: "closing-task-next" });
  mkdirSync(join(repo, ".pi"), { recursive: true });
  writeFileSync(
    join(repo, ".pi", "session-presence.json"),
    JSON.stringify({ sessionId: "sess-bbbb2222", pid: 4242, host: "host", at: new Date().toISOString() }),
    { mode: 0o600 },
  );
  const kills = tmux.calls.filter((argv) => argv[0] === "kill-window").length;
  createScheduler({
    home,
    runTmux: tmux,
    observer: fakeObserver([
      sessionFor("sess-bbbb2222", { state: "done", repo, tmux: { session: scopeName!, window: "@7", pane: "%7" } }),
    ]),
  }).tick();
  assert.equal(
    tmux.calls.filter((argv) => argv[0] === "kill-window").length,
    kills + 1,
    "已结算运行的遗留窗口在下一次到期时被补关",
  );
  assert.equal(
    readScheduleRuns(home).filter((record) => record.kind === "run-settled" && record.runId === "run-bbbb2222").length,
    1,
    "补关不会重复结算",
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
  // THE LAUNCH RECEIPT IS ON THE LEDGER LINE (t7): once the pane has lost
  // `@rg_sid`, the window id cannot be read back from anywhere else.
  appendScheduleRun(home, {
    kind: "run-started",
    runId: "run-aaaa9999",
    taskId: added.value.id,
    sessionId: "sess-aaaa9999",
    at: new Date(Date.now() - 60_000).toISOString(),
    scopeSession: scopeName,
    windowId: "@9",
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
  // AND THE SAME COORDINATES ARE WHAT THE LEFTOVER GUARD RETRIES WITH. The fake
  // tmux killed nothing, so the checkout heartbeat is still fresh: the next due
  // slot finds the occupant through it and closes the window from the receipt,
  // instead of only skipping this repo forever.
  const stamped = updateScheduledTask(home, added.value.id, { lastFiredAt: justDueStamp() }, { from: "gate" });
  if (!stamped.ok) assert.fail(stamped.problem);
  scheduler().tick();
  assert.ok(logs.some((message) => message.includes("已补关")), logs.join("\n"));
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

test("a ledger that cannot be written starts ONE session for a slot, never one per tick", () => {
  const home = scratchHome();
  const repo = scratchRepo();
  dueTask(home, repo, { name: "task-a" });
  // The ledger path as a DIRECTORY: `appendScheduleRun` throws EISDIR on every
  // tick, while the table still writes. The session that got started cannot be
  // un-started, so the SLOT must count as dealt with regardless — otherwise
  // every 20-second tick starts another real session, forever (quality round
  // P1, 2026-10-02; `dealt` therefore runs BEFORE the append, and the slot is
  // also remembered in memory in case the stamp itself fails).
  mkdirSync(scheduleRunsPath(home), { recursive: true });
  const tmux = fakeTmux();
  const scheduler = createScheduler({ home, runTmux: tmux, observer: fakeObserver([]) });
  scheduler.tick();
  scheduler.tick();
  scheduler.tick();
  const launches = tmux.calls.filter((argv) => argv[0] === "new-session" || argv[0] === "new-window").length;
  assert.equal(launches, 1, "one slot, one session — a failed ledger write is not a reason to start another");
  const table = readSchedules(home);
  assert.equal(table.ok && table.file.tasks[0]!.lastFiredAt !== null, true, "the stamp landed, so the slot is dealt with on disk too");
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
