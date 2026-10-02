/**
 * The scheduled-task endpoints (lib/daemon/server.ts): the wire the panel
 * builds against — status codes, field names, what a panel may change, what it
 * may NOT change, and what an authoring session is told to do.
 *
 * Over a REAL socket, like the rest of the daemon's contract tests: a handler
 * that is right but routes wrong is not right.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { createRuntime, type Runtime } from "../lib/daemon/server.ts";
import { ensureDaemonToken } from "../lib/daemon/state.ts";
import { schedulesPath } from "../lib/daemon/paths.ts";
import { addScheduledTask, appendScheduleRun, readSchedules, updateScheduledTask, type ScheduledTask } from "../lib/schedule-store.ts";
import type { TmuxRunner } from "../lib/orchestrator-tmux.ts";
import { fakeRunner, scheduleTaskInput, scratchHome, scratchRepo } from "./daemon-helpers.ts";

interface Harness {
  home: string;
  repo: string;
  runtime: Runtime;
  port: number;
  token: string;
  tmux: TmuxRunner & { calls: string[][] };
  call: (path: string, init?: RequestInit) => Promise<Response>;
  json: <T = Record<string, unknown>>(path: string, init?: RequestInit) => Promise<T>;
}

async function harness(): Promise<Harness> {
  const home = scratchHome();
  const repo = scratchRepo();
  const webDir = join(home, "web");
  mkdirSync(webDir, { recursive: true });
  const token = ensureDaemonToken(home).token;
  const tmux = fakeRunner((argv) => {
    if (argv[0] === "list-sessions") return { ok: true, stdout: "", stderr: "" };
    if (argv[0] === "new-session" || argv[0] === "new-window") return { ok: true, stdout: "@3 %9\n", stderr: "" };
    if (argv[0] === "list-panes") return { ok: true, stdout: "", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
  const runtime = createRuntime({
    home,
    // The scratch home plays the whole machine here: pi's transcripts and the
    // gate's registry are read from the USER home (lib/daemon/paths.ts
    // `userHome()`), never from the daemon's own.
    userHome: home,
    port: 0,
    token,
    webDir,
    runTmux: tmux,
    // The scheduler is armed but will not fire during a test: `start()` ticks
    // once, so every fixture below is written DISABLED.
    schedulerIntervalMs: 60 * 60 * 1_000,
  });
  const port = await runtime.start();
  const base = `http://127.0.0.1:${port}`;
  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  async function json<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<T> {
    return (await (await call(path, init)).json()) as T;
  }
  return { home, repo, runtime, port, token, tmux, call, json };
}

/** One disabled task in the scratch table — never due, so the timer stays out of it. */
function addTask(home: string, repo: string, over: { name?: string; enabled?: boolean } = {}): ScheduledTask {
  const added = addScheduledTask(home, scheduleTaskInput(repo, {
    name: over.name ?? "daily-audit",
    enabled: over.enabled ?? false,
  }));
  if (!added.ok) assert.fail(added.problem);
  return added.value;
}

const taskList = async (h: Harness): Promise<Array<Record<string, unknown>>> =>
  (await h.json<{ tasks: Array<Record<string, unknown>> }>("/api/schedules")).tasks;

test("the schedule endpoints are behind the token like every other one", async () => {
  const h = await harness();
  try {
    const anonymous = await fetch(`http://127.0.0.1:${h.port}/api/schedules`);
    assert.equal(anonymous.status, 401);
    const author = await fetch(`http://127.0.0.1:${h.port}/api/schedules/author`, { method: "POST", body: "{}" });
    assert.equal(author.status, 401);
  } finally {
    await h.runtime.stop();
  }
});

test("GET /api/schedules lists an empty table, then the tasks with their derived fields", async () => {
  const h = await harness();
  try {
    const empty = await h.json<{ schema: number; now: string; tasks: unknown[] }>("/api/schedules");
    assert.equal(empty.schema, 1);
    assert.equal(empty.tasks.length, 0);
    assert.ok(Number.isFinite(Date.parse(empty.now)));

    const task = addTask(h.home, h.repo);
    appendScheduleRun(h.home, { kind: "run-started", runId: "run-1", taskId: task.id, sessionId: "s1", at: "2026-10-01T00:00:00.000Z" });
    appendScheduleRun(h.home, {
      kind: "run-settled",
      runId: "run-1",
      taskId: task.id,
      at: "2026-10-01T00:05:00.000Z",
      outcome: "passed",
      verdict: "READY",
      unmet: [],
    });
    appendScheduleRun(h.home, { kind: "run-skipped", taskId: task.id, at: "2026-10-02T00:00:00.000Z", reason: "repo busy" });

    const tasks = await taskList(h);
    assert.equal(tasks.length, 1);
    const shown = tasks[0]!;
    assert.equal(shown.id, task.id);
    assert.equal(shown.cron, "0 9 * * *");
    assert.equal(shown.enabled, false);
    assert.equal(shown.nextRunAt, null, "a disabled task has no next run");
    assert.equal(shown.describe, "每天 09:00");
    // `run-started` is not a RESULT: the panel shows what happened, not that
    // something is (or was) happening.
    const lastRuns = shown.lastRuns as Array<{ kind: string }>;
    assert.deepEqual(lastRuns.map((record) => record.kind), ["run-settled", "run-skipped"]);

    // A disabled task has no next run; an enabled one counts it from the table.
    const live = addTask(h.home, h.repo, { name: "enabled-audit", enabled: true });
    const withLive = await taskList(h);
    const liveRow = withLive.find((row) => row.id === live.id)!;
    assert.equal(typeof liveRow.nextRunAt, "string");
    assert.ok(Date.parse(liveRow.nextRunAt as string) > Date.now(), "a never-fired enabled task is scheduled ahead");
  } finally {
    await h.runtime.stop();
  }
});

test("GET /api/schedules names the slot the daemon OWES, even when it is in the past (2026-10-03)", async () => {
  const h = await harness();
  try {
    const task = addTask(h.home, h.repo, { name: "slept-through", enabled: true });
    // THE DAEMON WAS AWAY FOR A WEEK: the slot this task was counting towards
    // arrived while nothing was running. That slot is OWED — the next tick runs
    // it — so the row names it exactly, in the past and all. It used to be
    // skipped and this field slid to the following slot; that whole idea is gone.
    const restored = updateScheduledTask(
      h.home,
      task.id,
      { lastFiredAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString() },
      { from: "gate" },
    );
    if (!restored.ok) assert.fail(restored.problem);
    const row = (await taskList(h)).find((candidate) => candidate.id === task.id)!;
    assert.ok(row.nextRunAt !== null, "有下一次要跑的槽");
    assert.ok(
      Date.parse(String(row.nextRunAt)) < Date.now(),
      `欠着的槽就在过去，实话实说：得到 ${String(row.nextRunAt)}`,
    );
    assert.ok(
      Date.parse(String(row.nextRunAt)) > Date.now() - 8 * 24 * 60 * 60 * 1_000,
      "它是基准之后的第一个槽，不是一周前那个时刻",
    );
  } finally {
    await h.runtime.stop();
  }
});

test("PUT may touch name / cron / enabled — and nothing else", async () => {
  const h = await harness();
  try {
    const task = addTask(h.home, h.repo);
    const renamed = await h.json<{ task: { name: string }; version: number }>(`/api/schedules/${task.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "renamed-audit", cron: "30 8 * * *", enabled: true }),
    });
    assert.equal(renamed.task.name, "renamed-audit");
    assert.equal(renamed.version, 2);
    const afterRename = readSchedules(h.home);
    assert.equal(afterRename.ok && afterRename.file.tasks[0]!.cron, "30 8 * * *");

    for (const body of [
      { requirement: "换一个需求" },
      { repo: "/somewhere/else" },
      { contract: { restatement: {}, goal: {} } },
      { lastFiredAt: null },
      { nonsense: true },
    ]) {
      const response = await h.call(`/api/schedules/${task.id}`, { method: "PUT", body: JSON.stringify(body) });
      assert.equal(response.status, 400, `expected a refusal for ${JSON.stringify(body)}`);
      const payload = (await response.json()) as { error: string };
      if ("requirement" in body || "repo" in body || "contract" in body) {
        assert.match(payload.error, /POST \/api\/schedules\/author/, `the refusal must name the authoring path: ${payload.error}`);
      }
    }
    // The refusals changed nothing.
    const afterRefusals = readSchedules(h.home);
    assert.equal(afterRefusals.ok && afterRefusals.file.tasks[0]!.requirement, "每天 09:00 跑一次审计");

    assert.equal((await h.call("/api/schedules/sch-ffffffff", { method: "PUT", body: JSON.stringify({ enabled: false }) })).status, 404);
    // A bad VALUE is a 400 like any other, and never a 500.
    assert.equal((await h.call(`/api/schedules/${task.id}`, { method: "PUT", body: JSON.stringify({ cron: "bogus" }) })).status, 400);
  } finally {
    await h.runtime.stop();
  }
});

test("POST /api/schedules/author starts an authoring session and writes nothing", async () => {
  const h = await harness();
  try {
    const before = existsSync(schedulesPath(h.home));
    const body = {
      action: "create",
      name: "weekly-audit",
      repo: h.repo,
      cron: "0 9 * * 1",
      requirement: "每周一 09:00 跑一次审计",
    };
    const created = await h.json<{ ok: boolean; sessionId: string; scopeSession: string; windowId: string; paneId: string }>(
      "/api/schedules/author",
      { method: "POST", body: JSON.stringify(body) },
    );
    assert.equal(created.ok, true);
    assert.ok(created.sessionId.length > 0);
    assert.ok(created.scopeSession.startsWith("rg-"));
    assert.equal(created.windowId, "@3");
    assert.equal(created.paneId, "%9");

    const creation = h.tmux.calls.find((argv) => argv[0] === "new-session")!;
    assert.ok(creation.some((entry) => entry === "RG_GATE_MODE=loop"), creation.join(" "));
    const opening = creation.slice(creation.indexOf("--") + 1).join(" ");
    assert.match(opening, /schedule_task\(\{action:"create"/);
    assert.match(opening, /"weekly-audit"/);
    assert.match(opening, /"0 9 \* \* 1"/);
    assert.match(opening, /每周一 09:00 跑一次审计/);
    assert.match(opening, /不要\*\*另外调|不要\*\*另外调|不要\*\*/);
    assert.match(opening, /propose_restatement/);
    assert.match(opening, /propose_loop_goal/);
    // THE ENDPOINT ITSELF WRITES NO TABLE: the contract is written by the gate's
    // own tool after the user approved it in that session.
    assert.equal(existsSync(schedulesPath(h.home)), before);
    assert.equal(existsSync(schedulesPath(h.home)), false, "authoring a contract never creates the table");
  } finally {
    await h.runtime.stop();
  }
});

test("POST /api/schedules/author validates before it opens a session", async () => {
  const h = await harness();
  try {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: "x", repo: h.repo, cron: "0 9 * * *", requirement: "r" }, /action 只能是/],
      [{ action: "create", name: "X", repo: h.repo, cron: "0 9 * * *", requirement: "r" }, /name 必须是 kebab-case/],
      [{ action: "create", name: "ok-name", repo: "/nowhere/at/all", cron: "0 9 * * *", requirement: "r" }, /repo 不存在/],
      [{ action: "create", name: "ok-name", repo: h.repo, cron: "bogus", requirement: "r" }, /cron 不合法/],
      [{ action: "create", name: "ok-name", repo: h.repo, cron: "0 9 * * *", requirement: "  " }, /requirement 不能为空/],
      [{ action: "update", name: "ok-name", repo: h.repo, cron: "0 9 * * *", requirement: "r" }, /必须带 id/],
    ];
    for (const [body, expected] of cases) {
      const response = await h.call("/api/schedules/author", { method: "POST", body: JSON.stringify(body) });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.match(((await response.json()) as { error: string }).error, expected);
    }
    const unknown = await h.call("/api/schedules/author", {
      method: "POST",
      body: JSON.stringify({ action: "update", id: "sch-ffffffff", name: "ok-name", repo: h.repo, cron: "0 9 * * *", requirement: "r" }),
    });
    assert.equal(unknown.status, 404);
    // Nothing reached tmux for any of them.
    assert.equal(h.tmux.calls.filter((argv) => argv[0] === "new-session").length, 0);

    // A name that is already taken is refused BEFORE a session is opened.
    addTask(h.home, h.repo, { name: "taken-name" });
    const clash = await h.call("/api/schedules/author", {
      method: "POST",
      body: JSON.stringify({ action: "create", name: "taken-name", repo: h.repo, cron: "0 9 * * *", requirement: "r" }),
    });
    assert.equal(clash.status, 400);
    assert.match(((await clash.json()) as { error: string }).error, /已经被调度任务/);
    assert.equal(h.tmux.calls.filter((argv) => argv[0] === "new-session").length, 0);
  } finally {
    await h.runtime.stop();
  }
});

test("DELETED tasks go away and their removal answers with the row", async () => {
  const h = await harness();
  try {
    const task = addTask(h.home, h.repo, { name: "doomed-task" });
    const removed = await h.json<{ ok: boolean; task: { id: string; name: string } }>(`/api/schedules/${task.id}`, { method: "DELETE" });
    assert.equal(removed.ok, true);
    assert.equal(removed.task.id, task.id);
    assert.equal(removed.task.name, "doomed-task");
    assert.deepEqual(await taskList(h), []);
    assert.equal((await h.call(`/api/schedules/${task.id}`, { method: "DELETE" })).status, 404);
  } finally {
    await h.runtime.stop();
  }
});

test("GET /api/schedules/:id/runs answers one task's ledger, newest `limit` entries", async () => {
  const h = await harness();
  try {
    const task = addTask(h.home, h.repo);
    const other = addTask(h.home, h.repo, { name: "other-task" });
    for (let index = 1; index <= 4; index += 1) {
      appendScheduleRun(h.home, {
        kind: "run-settled",
        runId: `run-${index}`,
        taskId: task.id,
        at: `2026-10-0${index}T00:00:00.000Z`,
        outcome: "passed",
        verdict: "READY",
        unmet: [],
      });
    }
    appendScheduleRun(h.home, { kind: "run-skipped", taskId: other.id, at: "2026-10-01T00:00:00.000Z", reason: "busy" });

    const all = await h.json<{ taskId: string; runs: Array<{ runId: string }>; total: number; offset: number }>(
      `/api/schedules/${task.id}/runs`,
    );
    assert.equal(all.taskId, task.id);
    assert.equal(all.total, 4, "total 是这个任务自己的台账总数");
    assert.equal(all.offset, 0);
    assert.deepEqual(all.runs.map((record) => record.runId), ["run-1", "run-2", "run-3", "run-4"], "another task's ledger stays out");
    const limited = await h.json<{ runs: Array<{ runId: string }> }>(`/api/schedules/${task.id}/runs?limit=2`);
    assert.deepEqual(limited.runs.map((record) => record.runId), ["run-3", "run-4"], "the NEWEST entries survive the limit");
    assert.equal((await h.call(`/api/schedules/${task.id}/runs?limit=0`)).status, 200, "0 clamps to 1 rather than failing");
    assert.equal((await h.call("/api/schedules/sch-ffffffff/runs")).status, 404);
  } finally {
    await h.runtime.stop();
  }
});

test("`offset` walks the WHOLE ledger, one page at a time, without gaps or repeats (2026-10-03)", async () => {
  const h = await harness();
  try {
    const task = addTask(h.home, h.repo);
    // MORE THAN ONE PAGE, and deliberately more than the panel asks for at
    // once: the point of `offset` is that the 500-record ceiling stops being the
    // end of the history.
    for (let index = 0; index < 12; index += 1) {
      appendScheduleRun(h.home, {
        kind: "run-settled",
        runId: `run-${String(index).padStart(2, "0")}`,
        taskId: task.id,
        at: `2026-10-01T00:00:${String(index).padStart(2, "0")}.000Z`,
        outcome: "passed",
        verdict: "READY",
        unmet: [],
      });
    }
    const seen: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await h.json<{ runs: Array<{ runId: string }>; total: number }>(
        `/api/schedules/${task.id}/runs?limit=5&offset=${offset}`,
      );
      assert.equal(page.total, 12);
      if (page.runs.length === 0) break;
      seen.push(...page.runs.map((record) => record.runId));
      offset += page.runs.length;
    }
    assert.equal(seen.length, 12, "每一页都不重不漏");
    assert.deepEqual([...seen].sort(), Array.from({ length: 12 }, (_, index) => `run-${String(index).padStart(2, "0")}`).sort());
    const beyond = await h.json<{ runs: unknown[] }>(`/api/schedules/${task.id}/runs?limit=5&offset=99`);
    assert.deepEqual(beyond.runs, [], "越过最早一条只有一个空页，不是错误");
  } finally {
    await h.runtime.stop();
  }
});
