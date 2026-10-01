/**
 * The scheduled-task table and its run ledger: round-trips, the version rule,
 * the panel/gate authoring split, the contract's own hashes, and the ledger.
 * Every path is under a scratch `home`, so the real agent home is untouched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addScheduledTask,
  appendScheduleRun,
  applyScheduleEdit,
  findScheduledTask,
  listScheduledTasks,
  nextRunAtFor,
  readScheduleRuns,
  readSchedules,
  removeScheduledTask,
  SCHEDULE_ID_ENV,
  SCHEDULE_RUN_ENV,
  updateScheduledTask,
  type NewScheduledTask,
  type ScheduleContract,
  type ScheduleEditPatch,
  type ScheduledTask,
} from "../lib/schedule-store.ts";
import { scheduleRunsPath, schedulesPath } from "../lib/daemon/paths.ts";
import { goalTextHash, normalizeGoalText } from "../lib/loop-goal.ts";
import { restatementHash } from "../lib/restatement.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "rg-schedules-"));
const mode = (path: string): number => statSync(path).mode & 0o777;

function makeContract(over: Partial<ScheduleContract> = {}): ScheduleContract {
  const restatementText =
    "## 需求反述\n1. 这件事是什么：每天自动跑一次审计\n2. 例子：23:30 发起一次\n" +
    "3. 改之前：手动敲命令\n4. 改之后：由调度器发起";
  const goalText = "# 定时审计\n意图：让审计按天自动发起";
  return {
    restatement: {
      text: restatementText,
      hash: restatementHash(restatementText),
      station: "commit",
      at: "2026-10-01T00:00:00.000Z",
    },
    goal: { text: goalText, hash: goalTextHash(normalizeGoalText(goalText)), at: "2026-10-01T00:00:00.000Z" },
    approvedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function taskInput(repo: string, over: Partial<NewScheduledTask> = {}): NewScheduledTask {
  return {
    name: "daily-audit",
    repo,
    cron: "0 9 * * *",
    requirement: "每天 09:00 跑一次审计",
    contract: makeContract(),
    from: "gate",
    ...over,
  };
}

test("the two environment constants are the ones the gate lists", () => {
  assert.equal(SCHEDULE_ID_ENV, "RG_SCHEDULE_ID");
  assert.equal(SCHEDULE_RUN_ENV, "RG_SCHEDULE_RUN");
});

test("add → read round-trips through a 0600 file, and the id/name both find it", () => {
  const home = scratch();
  const repo = scratch();
  const added = addScheduledTask(home, taskInput(repo));
  assert.equal(added.ok, true);
  if (!added.ok) return;
  assert.equal(added.version, 1);
  assert.match(added.value.id, /^sch-[0-9a-f]{8}$/);
  assert.equal(added.value.enabled, true);
  assert.equal(added.value.lastFiredAt, null);
  assert.equal(added.value.createdAt, added.value.updatedAt);

  assert.equal(mode(schedulesPath(home)), 0o600, "the table is private");
  const raw = JSON.parse(readFileSync(schedulesPath(home), "utf8")) as { schema: number; version: number };
  assert.equal(raw.schema, 1);
  assert.equal(raw.version, 1);

  const read = readSchedules(home);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.file.tasks.length, 1);
  assert.equal(read.file.tasks[0]!.name, "daily-audit");
  assert.deepEqual(read.file.tasks[0]!.contract, makeContract());

  assert.equal(findScheduledTask(home, added.value.id)?.name, "daily-audit");
  assert.equal(findScheduledTask(home, "daily-audit")?.id, added.value.id);
  assert.equal(findScheduledTask(home, "nope"), undefined);
  assert.equal(listScheduledTasks(home).length, 1);
});

test("a panel call cannot create a task — creating one IS authoring", () => {
  const home = scratch();
  const repo = scratch();

  const explicit = addScheduledTask(home, taskInput(repo, { from: "panel" }));
  assert.equal(explicit.ok, false);
  if (explicit.ok) return;
  assert.match(explicit.problem, /authoring 会话|schedule_task/);
  assert.match(explicit.problem, /需求|契约/);

  // Forgetting `from` is a PANEL call on purpose: fail closed, not open.
  const forgotten = addScheduledTask(home, taskInput(repo, { from: undefined }));
  assert.equal(forgotten.ok, false);
  assert.equal(existsSync(schedulesPath(home)), false, "a refused add writes nothing");
  assert.deepEqual(listScheduledTasks(home), []);
});

test("name / repo / cron / contract are all validated before anything is written", () => {
  const home = scratch();
  const repo = scratch();
  const file = join(repo, "not-a-directory.txt");
  writeFileSync(file, "x");

  const cases: Array<[string, NewScheduledTask]> = [
    ["名字不是 kebab-case", taskInput(repo, { name: "Daily Audit" })],
    ["名字太短", taskInput(repo, { name: "a" })],
    ["repo 不是绝对路径", taskInput(repo, { repo: "relative/path" })],
    ["repo 不存在", taskInput(repo, { repo: join(repo, "missing") })],
    ["repo 不是目录", taskInput(repo, { repo: file })],
    ["cron 不合法", taskInput(repo, { cron: "0 9 * *" })],
    ["requirement 为空", taskInput(repo, { requirement: "  " })],
  ];
  for (const [why, input] of cases) {
    const result = addScheduledTask(home, input);
    assert.equal(result.ok, false, `${why} 必须被拒`);
  }
  assert.equal(listScheduledTasks(home).length, 0);

  const first = addScheduledTask(home, taskInput(repo, { enabled: false }));
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.value.enabled, false);

  // A non-boolean `enabled` would be written as-is and make the whole table
  // unreadable on the next load — refused by the same value validation as
  // every other field (round-1 reviewer P2).
  const badEnabled = addScheduledTask(home, taskInput(repo, { name: "bad-enabled", enabled: "yes" as unknown as boolean }));
  assert.equal(badEnabled.ok, false);
  if (badEnabled.ok) return;
  assert.match(badEnabled.problem, /enabled/);
  assert.equal(readSchedules(home).ok, true, "the table is still readable");

  const duplicate = addScheduledTask(home, taskInput(repo, { cron: "0 10 * * *" }));
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) return;
  assert.match(duplicate.problem, /已经被另一个调度任务用了/);
});

test("the contract's hashes must be the hashes of its own texts", () => {
  const home = scratch();
  const repo = scratch();

  const badRestatement = makeContract();
  badRestatement.restatement.hash = "deadbeef";
  const first = addScheduledTask(home, taskInput(repo, { contract: badRestatement }));
  assert.equal(first.ok, false);
  if (first.ok) return;
  assert.match(first.problem, /restatement\.hash/);
  assert.match(first.problem, /restatementHash/);

  const badGoal = makeContract();
  badGoal.goal.hash = "deadbeef";
  const second = addScheduledTask(home, taskInput(repo, { contract: badGoal }));
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.match(second.problem, /goal\.hash/);

  const badStation = makeContract();
  // @ts-expect-error the station is a closed set; a hand-edited file can still lie.
  badStation.restatement.station = "somewhere";
  const third = addScheduledTask(home, taskInput(repo, { contract: badStation }));
  assert.equal(third.ok, false);
  if (third.ok) return;
  assert.match(third.problem, /station/);
});

test("expectedVersion is the only thing standing between two writers", () => {
  const home = scratch();
  const repo = scratch();
  const added = addScheduledTask(home, taskInput(repo));
  assert.equal(added.ok, true);
  if (!added.ok) return;

  const stale = updateScheduledTask(home, added.value.id, { enabled: false }, { expectedVersion: 0, from: "panel" });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.match(stale.problem, /有人同时改过，请重读/);

  const current = updateScheduledTask(
    home,
    added.value.id,
    { enabled: false },
    { expectedVersion: 1, from: "panel" },
  );
  assert.equal(current.ok, true);
  if (!current.ok) return;
  assert.equal(current.value.enabled, false);
  assert.equal(current.value.updatedAt >= current.value.createdAt, true);
  assert.equal(current.version, 2);

  // A disabled task has no next run.
  assert.equal(nextRunAtFor(current.value, new Date(2026, 9, 1, 8, 0)), null);
});

test("a panel edit may touch name / cron / enabled — and nothing else", () => {
  const home = scratch();
  const repo = scratch();
  const other = scratch();
  const added = addScheduledTask(home, taskInput(repo));
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const id = added.value.id;

  const panelRefused: Array<[string, Parameters<typeof updateScheduledTask>[2]]> = [
    ["requirement", { requirement: "换一个需求" }],
    ["repo", { repo: other }],
    ["contract", { contract: makeContract() }],
  ];
  for (const [field, patch] of panelRefused) {
    const result = updateScheduledTask(home, id, patch, { from: "panel" });
    assert.equal(result.ok, false, `panel 改 ${field} 必须被拒`);
    if (result.ok) continue;
    assert.match(result.problem, /authoring 会话/);
    assert.match(result.problem, /需求\/repo\/契约/);
  }
  // The refusals never wrote: version and content are where they were.
  assert.equal(readSchedules(home).ok && (readSchedules(home) as { ok: true; file: { version: number } }).file.version, 1);
  assert.equal(findScheduledTask(home, id)?.repo, repo);

  const allowed = updateScheduledTask(
    home,
    id,
    { name: "daily-audit-2", cron: "*/30 * * * *", enabled: false },
    { from: "panel" },
  );
  assert.equal(allowed.ok, true);
  if (!allowed.ok) return;
  assert.equal(allowed.value.name, "daily-audit-2");
  assert.equal(allowed.value.cron, "*/30 * * * *");
  assert.equal(allowed.value.enabled, false);
  assert.equal(allowed.value.id, id, "the id is store-managed and never rewritten");
});

test("a gate edit may carry the contract", () => {
  const home = scratch();
  const repo = scratch();
  const added = addScheduledTask(home, taskInput(repo));
  assert.equal(added.ok, true);
  if (!added.ok) return;

  const next = makeContract();
  next.goal.text = "# 定时审计 v2\n意图：改到 10:00";
  next.goal.hash = goalTextHash(normalizeGoalText(next.goal.text));
  const updated = updateScheduledTask(
    home,
    added.value.id,
    { contract: next, cron: "0 10 * * *" },
    { from: "gate", expectedVersion: 1 },
  );
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.equal(updated.value.cron, "0 10 * * *");
  assert.deepEqual(updated.value.contract, next);
  assert.equal(updated.version, 2);
});

test("update and remove refuse a task that is not there, and remove is version-checked", () => {
  const home = scratch();
  const repo = scratch();
  const added = addScheduledTask(home, taskInput(repo));
  assert.equal(added.ok, true);
  if (!added.ok) return;

  assert.equal(updateScheduledTask(home, "sch-deadbeef", { enabled: false }, { from: "gate" }).ok, false);

  const stale = removeScheduledTask(home, added.value.id, { expectedVersion: 0 });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.match(stale.problem, /有人同时改过，请重读/);

  const removed = removeScheduledTask(home, added.value.id, { expectedVersion: 1 });
  assert.equal(removed.ok, true);
  assert.equal(removed.ok && removed.value.id, added.value.id);
  assert.equal(removeScheduledTask(home, added.value.id).ok, false, "removing it twice fails the second time");
  assert.deepEqual(listScheduledTasks(home), []);
});

test("applyScheduleEdit is the one place the authoring rule lives", () => {
  assert.equal(applyScheduleEdit({ from: "panel", patch: { enabled: false } }).ok, true);
  assert.equal(applyScheduleEdit({ from: "panel", patch: { name: "x-2", cron: "0 1 * * *" } }).ok, true);
  assert.equal(applyScheduleEdit({ from: "gate", patch: { contract: makeContract() } }).ok, true);

  const panelContract = applyScheduleEdit({ from: "panel", patch: { contract: makeContract() } });
  assert.equal(panelContract.ok, false);
  if (!panelContract.ok) assert.match(panelContract.problem, /需求\/repo\/契约/);

  const unknownField = applyScheduleEdit({ from: "gate", patch: { id: "sch-00000000" } as ScheduleEditPatch });
  assert.equal(unknownField.ok, false);
  if (!unknownField.ok) assert.match(unknownField.problem, /不认识的字段/);

  const unknownOrigin = applyScheduleEdit({ from: "cli" as "panel", patch: { enabled: true } });
  assert.equal(unknownOrigin.ok, false);
});

test("nextRunAtFor counts from lastFiredAt, and from now when it never fired", () => {
  const repo = scratch();
  const base: ScheduledTask = {
    id: "sch-00000001",
    name: "daily-audit",
    repo,
    cron: "0 9 * * *",
    requirement: "每天 09:00 跑一次审计",
    contract: makeContract(),
    enabled: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastFiredAt: null,
  };
  const never = nextRunAtFor(base, new Date(2026, 9, 1, 8, 0));
  assert.equal(never?.getTime(), new Date(2026, 9, 1, 9, 0).getTime());

  const fired: ScheduledTask = { ...base, lastFiredAt: new Date(2026, 9, 1, 9, 0).toISOString() };
  const next = nextRunAtFor(fired, new Date(2026, 9, 1, 9, 30));
  assert.equal(next?.getTime(), new Date(2026, 9, 2, 9, 0).getTime(), "the run already done is not a candidate");

  assert.equal(nextRunAtFor({ ...base, enabled: false }, new Date(2026, 9, 1, 8, 0)), null);
  assert.equal(nextRunAtFor({ ...base, cron: "bogus" }, new Date(2026, 9, 1, 8, 0)), null);
});

test("the run ledger appends one line per record and reads back filtered", () => {
  const home = scratch();
  const runs = scheduleRunsPath(home);
  appendScheduleRun(home, {
    kind: "run-started",
    runId: "run-1",
    taskId: "sch-aaaaaaaa",
    sessionId: "sess-1",
    at: "2026-10-01T09:00:00.000Z",
  });
  appendScheduleRun(home, {
    kind: "run-settled",
    runId: "run-1",
    taskId: "sch-aaaaaaaa",
    at: "2026-10-01T09:20:00.000Z",
    outcome: "passed",
    verdict: "READY",
    unmet: [],
  });
  appendScheduleRun(home, {
    kind: "run-skipped",
    taskId: "sch-bbbbbbbb",
    at: "2026-10-02T09:00:00.000Z",
    reason: "本任务已禁用",
  });

  assert.equal(mode(runs), 0o600, "the ledger is private");
  const lines = readFileSync(runs, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]!).kind, "run-started");

  const all = readScheduleRuns(home);
  assert.deepEqual(all.map((record) => record.kind), ["run-started", "run-settled", "run-skipped"]);
  assert.equal(readScheduleRuns(home, { taskId: "sch-aaaaaaaa" }).length, 2);
  const newest = readScheduleRuns(home, { taskId: "sch-aaaaaaaa", limit: 1 });
  assert.equal(newest.length, 1);
  assert.equal(newest[0]!.kind, "run-settled");
  assert.equal(newest[0]!.kind === "run-settled" ? newest[0].verdict : undefined, "READY");
  assert.deepEqual(readScheduleRuns(home, { taskId: "sch-cccccccc" }), []);

  assert.throws(() => appendScheduleRun(home, { kind: "nope" } as never), /未知的调度台账记录/);
});

test("a hand-edited table missing a contract field is refused, never passed on", () => {
  const home = scratch();
  const repo = scratch();
  const added = addScheduledTask(home, taskInput(repo));
  assert.equal(added.ok, true);
  if (!added.ok) return;

  const file = JSON.parse(readFileSync(schedulesPath(home), "utf8")) as {
    tasks: Array<{ contract: { restatement: Record<string, unknown> } }>;
  };
  delete file.tasks[0]!.contract.restatement.station;
  writeFileSync(schedulesPath(home), JSON.stringify(file));

  const read = readSchedules(home);
  assert.equal(read.ok, false, "a task without a station is not a task");
  if (read.ok) return;
  assert.match(read.problem, /形状/);
  assert.deepEqual(listScheduledTasks(home), []);
});

test("moving a task to another repo has to bring a new contract with it", () => {
  const home = scratch();
  const repo = scratch();
  const other = scratch();
  const added = addScheduledTask(home, taskInput(repo));
  assert.equal(added.ok, true);
  if (!added.ok) return;

  // No hash binds `repo`, so a bare move would re-point a task the user agreed
  // to in THIS repository (round-1 quality P2).
  const bare = updateScheduledTask(home, added.value.id, { repo: other }, { from: "gate", expectedVersion: 1 });
  assert.equal(bare.ok, false);
  if (bare.ok) return;
  assert.match(bare.problem, /新的 contract/);

  // …and the contract it brings has to BE new: re-sending the old one next to a
  // new repo is not a re-negotiation (round-3 reviewer P2).
  const sameContract = updateScheduledTask(
    home,
    added.value.id,
    { repo: other, contract: makeContract() },
    { from: "gate", expectedVersion: 1 },
  );
  assert.equal(sameContract.ok, false);
  if (sameContract.ok) return;
  assert.match(sameContract.problem, /两个 hash 都没变/);

  // Submitting the whole task back UNCHANGED is not a move: the rule compares
  // against the current repo, not against the presence of the key.
  const unchanged = updateScheduledTask(
    home,
    added.value.id,
    { name: added.value.name, repo, cron: added.value.cron, enabled: added.value.enabled },
    { from: "gate", expectedVersion: 1 },
  );
  assert.equal(unchanged.ok, true);

  const fresh = makeContract();
  fresh.goal.text = "# 定时审计（新仓库）\n意图：在另一个 checkout 上跑";
  fresh.goal.hash = goalTextHash(normalizeGoalText(fresh.goal.text));
  const moved = updateScheduledTask(
    home,
    added.value.id,
    { repo: other, contract: fresh },
    { from: "gate", expectedVersion: 2 },
  );
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  assert.equal(moved.value.repo, other);
  assert.deepEqual(moved.value.contract, fresh);
});

test("an unparseable lastFiredAt is refused on both sides — it would mean「never again」", () => {
  const home = scratch();
  const repo = scratch();
  const added = addScheduledTask(home, taskInput(repo));
  assert.equal(added.ok, true);
  if (!added.ok) return;

  const bad = updateScheduledTask(
    home,
    added.value.id,
    { lastFiredAt: "yesterday" },
    { from: "gate", expectedVersion: 1 },
  );
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.match(bad.problem, /lastFiredAt/);

  const firedAt = new Date(2026, 9, 1, 9, 0).toISOString();
  const stamped = updateScheduledTask(
    home,
    added.value.id,
    { lastFiredAt: firedAt },
    { from: "gate", expectedVersion: 1 },
  );
  assert.equal(stamped.ok, true);
  if (!stamped.ok) return;
  assert.equal(stamped.value.lastFiredAt, firedAt);
  assert.equal(
    nextRunAtFor(stamped.value, new Date(2026, 9, 1, 9, 30))?.getTime(),
    new Date(2026, 9, 2, 9, 0).getTime(),
  );

  // A hand-edited file cannot get past the read side either.
  const file = JSON.parse(readFileSync(schedulesPath(home), "utf8")) as { tasks: Array<{ lastFiredAt: string }> };
  file.tasks[0]!.lastFiredAt = "yesterday";
  writeFileSync(schedulesPath(home), JSON.stringify(file));
  assert.equal(readSchedules(home).ok, false);
});

test("a corrupt table is refused, never silently emptied and overwritten", () => {
  const home = scratch();
  mkdirSync(join(home, ".pi", "agent", "rg-daemon"), { recursive: true });
  writeFileSync(schedulesPath(home), "{ not json");

  const read = readSchedules(home);
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.match(read.problem, /不是合法 JSON/);
  assert.deepEqual(listScheduledTasks(home), []);

  const repo = scratch();
  const added = addScheduledTask(home, taskInput(repo));
  assert.equal(added.ok, false, "a write onto an unreadable table is refused");
  assert.equal(readFileSync(schedulesPath(home), "utf8"), "{ not json", "the bytes are still there");
});
