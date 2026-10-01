/**
 * `schedule_task` — the ONE tool for scheduled tasks (lib/schedule-tools.ts).
 *
 * The negotiation chain (restatement dialog → goal audit → approval dialog)
 * runs INSIDE the call and is the expensive half, so the branches below are
 * exactly the ones a wrong move would burn a user's minutes on: a declined
 * restatement writing nothing, a BLOCKED audit never opening the approval box,
 * an approved contract landing in the schedule table (and, for a session with
 * no goal yet, in its own records too), and a cron-only update not
 * renegotiating at all.
 *
 * The store's own rules (hashes, version, the panel/gate authoring split) are
 * tested in test/schedule-store.test.ts; here they are taken as given and the
 * HUMAN-IN-THE-LOOP half is what is exercised.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  doScheduleTask,
  registerScheduleTools,
  type ScheduleToolDeps,
} from "../lib/schedule-tools.ts";
import {
  addScheduledTask,
  readSchedules,
  type ScheduleContract,
  type ScheduledTask,
} from "../lib/schedule-store.ts";
import { emptyState, type GateState } from "../lib/gate-state.ts";
import { goalTextHash } from "../lib/loop-goal.ts";
import { restatementHash } from "../lib/restatement.ts";
import { RESTATEMENT_CONFIRM_TITLE } from "../lib/restatement.ts";
import type { TaskMode } from "../lib/task-mode.ts";
import type { ToolHost } from "../lib/tool-host.ts";

const RESTATEMENT = [
  "## 需求反述",
  "1. 这件事是什么：每天定时跑一次夜间审计，把结论写进台账。",
  "2. 举个例子：03:00 由 daemon 起一个 loop 会话跑审计。",
  "3. 改之前：我每次都要手动敲命令触发审计。",
  "4. 改之后：到点自动发起，我只看台账里的裁决。",
  "5. 哪几步会变得不同：不用再手动触发；失败会在台账里留下 outcome。",
].join("\n");
const GOAL = "# 夜间审计\n意图：按天自动发起一次审计\n\n1. 台账里出现一次 run-settled";
const APPROVED_AT = "2026-10-02T00:00:00.000Z";

interface Fake {
  deps: ScheduleToolDeps;
  home: string;
  repo: string;
  otherRepo: string;
  st: GateState;
  /** Which surfaces were reached, in order. */
  surfaces: string[];
  shown: string[];
  bodies: string[];
  written: Array<{ path: string; text: string }>;
  persisted: string[];
  audit: { ok: true } | { ok: false; text: string };
  auditRuns: number;
  approveRestatement: boolean;
  approveGoal: boolean;
  rejectReason: string | undefined;
  judgePane: boolean;
  workerPane: boolean;
  child: boolean;
  mode: TaskMode;
}

function fake(over: Partial<Fake> = {}): Fake {
  const f: Fake = {
    deps: undefined as unknown as ScheduleToolDeps,
    home: mkdtempSync(join(tmpdir(), "rg-schedule-tools-")),
    repo: mkdtempSync(join(tmpdir(), "rg-schedule-tools-repo-")),
    otherRepo: mkdtempSync(join(tmpdir(), "rg-schedule-tools-other-")),
    st: emptyState("sess-1", 10),
    surfaces: [],
    shown: [],
    bodies: [],
    written: [],
    persisted: [],
    audit: { ok: true },
    auditRuns: 0,
    approveRestatement: true,
    approveGoal: true,
    rejectReason: undefined,
    judgePane: false,
    workerPane: false,
    child: false,
    mode: "loop",
    ...over,
  };
  f.st.taskMode = f.mode;
  f.deps = {
    home: () => f.home,
    primaryRepoRoot: () => f.repo,
    cwd: () => f.repo,
    stateFor: () => f.st,
    persist: (_ctx, root) => { f.persisted.push(root); },
    log: () => {},
    showToUser: (_uiCtx, _lead, body) => { f.surfaces.push("showToUser"); f.shown.push(body); return true; },
    askChoice: async (_uiCtx, spec, opts) => {
      const restatement = spec.title === RESTATEMENT_CONFIRM_TITLE;
      f.surfaces.push(restatement ? "restatement-dialog" : "goal-dialog");
      f.bodies.push(opts?.body ?? "");
      const approve = restatement ? f.approveRestatement : f.approveGoal;
      if (approve) return spec.options[0];
      return f.rejectReason === undefined ? undefined : `${spec.declineRow}：${f.rejectReason}`;
    },
    askEitherSide: async (_request, _hasUI, render) => {
      const answer = await render({ signal: new AbortController().signal, onProxyAnswer: () => {} });
      return { answer, by: answer === undefined ? "dismissed" : "human", requestId: "r1" };
    },
    runGoalAudit: async () => { f.auditRuns += 1; return f.audit; },
    loopGoalPath: (root) => join(root, ".pi", "loop-goal.md"),
    loopGoalRelPath: ".pi/loop-goal.md",
    writeGoalFile: (path, text) => { f.written.push({ path, text }); },
    isJudgePane: () => f.judgePane,
    isWorkerPane: () => f.workerPane,
    isOrchestrationChild: () => f.child,
    taskMode: () => f.mode,
    gitRoot: (dir) => (dir === f.repo || dir === f.otherRepo ? dir : null),
    now: () => new Date(APPROVED_AT),
  };
  return f;
}

function contract(): ScheduleContract {
  return {
    restatement: { text: RESTATEMENT, hash: restatementHash(RESTATEMENT), station: "commit", at: APPROVED_AT },
    goal: { text: GOAL, hash: goalTextHash(GOAL), at: APPROVED_AT },
    approvedAt: APPROVED_AT,
  };
}

/** Put one task in the table without going through the tool (version 1). */
function seed(f: Fake, over: { name?: string; cron?: string } = {}): ScheduledTask {
  const added = addScheduledTask(f.home, {
    name: over.name ?? "nightly-audit",
    repo: f.repo,
    cron: over.cron ?? "0 3 * * *",
    requirement: "每晚审一次",
    contract: contract(),
    from: "gate",
  });
  assert.equal(added.ok, true, added.ok ? "" : added.problem);
  return added.ok ? added.value : (undefined as never);
}

const createParams = (f: Fake, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: "create",
  name: "nightly-audit",
  repo: f.repo,
  cron: "0 3 * * *",
  requirement: "每晚审一次",
  restatement: RESTATEMENT,
  goal: GOAL,
  station: "commit",
  ...over,
});

/** The table's tasks, or `[]` when it cannot be read (a listing never throws). */
function tasksIn(f: Fake): ScheduledTask[] {
  const read = readSchedules(f.home);
  return read.ok ? read.file.tasks : [];
}

// ---------------------------------------------------------------------------
// create — the whole chain, and what a refusal leaves behind

test("create: the approved chain writes the schedule contract AND the session's own records", async () => {
  const f = fake();
  const out = await doScheduleTask(f.deps, createParams(f), {}, undefined);
  assert.equal(out.isError, undefined, out.content[0]!.text);
  assert.deepEqual(f.surfaces, ["showToUser", "restatement-dialog", "showToUser", "goal-dialog"],
    "restatement first, goal approval last — and the audit runs between them");
  assert.equal(f.auditRuns, 1);

  const table = readSchedules(f.home);
  assert.equal(table.ok, true);
  const task = table.ok ? table.file.tasks[0] : undefined;
  assert.ok(task, "the task is in the table");
  assert.equal(task!.name, "nightly-audit");
  assert.equal(task!.repo, f.repo);
  assert.equal(task!.cron, "0 3 * * *");
  assert.equal(task!.enabled, true);
  assert.equal(task!.contract.restatement.hash, restatementHash(RESTATEMENT));
  assert.equal(task!.contract.goal.hash, goalTextHash(GOAL));
  assert.equal(task!.contract.restatement.station, "commit");
  assert.equal(task!.contract.approvedAt, APPROVED_AT);

  // The session half: no approved goal yet ⇒ the same approval is recorded
  // here, from the SAME text, with the approval's own time.
  assert.equal(f.written.length, 1);
  assert.equal(f.written[0]!.path, join(f.repo, ".pi", "loop-goal.md"));
  assert.equal(f.written[0]!.text, GOAL + "\n");
  assert.equal(f.st.restatement?.hash, restatementHash(RESTATEMENT));
  assert.equal(f.st.restatement?.station, "commit");
  assert.equal(f.st.restatement?.at, APPROVED_AT);
  assert.equal(f.st.loopGoal?.hash, goalTextHash(GOAL));
  assert.equal(f.st.loopGoal?.station, "commit");
  assert.deepEqual(f.persisted, [f.repo]);
});

test("create: a refused restatement writes NOTHING and never reaches the audit", async () => {
  const f = fake({ approveRestatement: false, rejectReason: "需求写错了：不是每天而是每周" });
  const out = await doScheduleTask(f.deps, createParams(f), {}, undefined);
  assert.equal(out.isError, true);
  assert.match(out.content[0]!.text, /需求写错了/);
  assert.deepEqual(f.surfaces, ["showToUser", "restatement-dialog"]);
  assert.equal(f.auditRuns, 0, "no audit after a refused restatement");
  assert.equal(tasksIn(f).length, 0);
  assert.deepEqual(f.written, []);
  assert.equal(f.st.loopGoal, undefined);
});

test("create: a BLOCKED goal audit opens NO approval box and writes nothing", async () => {
  const f = fake({ audit: { ok: false, text: "review-gate: goal 审计没过（P1：退出标准不可检查）" } });
  const out = await doScheduleTask(f.deps, createParams(f), {}, undefined);
  assert.equal(out.isError, true);
  assert.match(out.content[0]!.text, /P1：退出标准不可检查/);
  assert.deepEqual(f.surfaces, ["showToUser", "restatement-dialog"],
    "the user is never asked to approve a draft the auditor blocked");
  assert.equal(tasksIn(f).length, 0);
  assert.deepEqual(f.written, []);
});

test("create: a refused GOAL approval writes nothing", async () => {
  const f = fake({ approveGoal: false, rejectReason: "退出标准 2 没法机械判定" });
  const out = await doScheduleTask(f.deps, createParams(f), {}, undefined);
  assert.equal(out.isError, true);
  assert.match(out.content[0]!.text, /退出标准 2/);
  assert.equal(tasksIn(f).length, 0);
  assert.deepEqual(f.written, []);
  assert.equal(f.st.loopGoal, undefined);
});

test("create: the approval box SAYS the contract doubles as this session's goal", async () => {
  const f = fake();
  await doScheduleTask(f.deps, createParams(f), {}, undefined);
  assert.match(f.bodies[0] ?? "", /这是定时任务 nightly-audit 的需求反述/);
  const goalBody = f.bodies[1] ?? "";
  assert.match(goalBody, /本会话还没有 loop goal/);
  assert.match(goalBody, /同时作为本会话的退出契约记录/);
  assert.match(goalBody, /本轮交付站点/);
  assert.match(f.shown[0] ?? "", /本轮交付站点/);
});

test("create: a session that ALREADY has an approved goal is never overwritten", async () => {
  const f = fake();
  const standing = { hash: "a".repeat(64), at: "2026-01-01T00:00:00.000Z", station: "precommit" as const };
  f.st.loopGoal = { ...standing };
  f.st.restatement = { text: "旧的反述", hash: restatementHash("旧的反述"), at: standing.at, station: "precommit" };
  const before = JSON.stringify({ restatement: f.st.restatement, loopGoal: f.st.loopGoal });
  const out = await doScheduleTask(f.deps, createParams(f), {}, undefined);
  assert.equal(out.isError, undefined, out.content[0]!.text);
  assert.deepEqual(f.written, [], "no goal file is written over the approved one");
  assert.deepEqual(f.persisted, [], "and the sidecar is not rewritten");
  assert.equal(JSON.stringify({ restatement: f.st.restatement, loopGoal: f.st.loopGoal }), before);
  assert.match(f.bodies[1] ?? "", /本会话已有获批 loop goal/);
});

test("create: a task in ANOTHER repo leaves this session's own contract alone", async () => {
  const f = fake();
  const out = await doScheduleTask(f.deps, createParams(f, { repo: f.otherRepo }), {}, undefined);
  assert.equal(out.isError, undefined, out.content[0]!.text);
  const table = readSchedules(f.home);
  assert.equal(table.ok && table.file.tasks[0]?.repo, f.otherRepo);
  assert.deepEqual(f.written, []);
  assert.equal(f.st.loopGoal, undefined, "another repo's task is not this session's exit contract");
  assert.equal(f.st.restatement, undefined);
  assert.match(f.bodies[1] ?? "", /只写调度记录，不动本会话的契约记录/);
  assert.match(out.content[0]!.text, /不动本会话的契约记录/);
});

test("create: bad inputs are refused BEFORE any dialog or audit", async () => {
  const badCron = fake();
  let out = await doScheduleTask(badCron.deps, createParams(badCron, { cron: "0 99 * * *" }), {}, undefined);
  assert.equal(out.isError, true);
  assert.match(out.content[0]!.text, /cron 不合法/);
  assert.deepEqual(badCron.surfaces, []);

  const badRepo = fake();
  out = await doScheduleTask(badRepo.deps, createParams(badRepo, { repo: join(badRepo.repo, "nope") }), {}, undefined);
  assert.equal(out.isError, true);
  assert.deepEqual(badRepo.surfaces, []);

  const notARepo = fake();
  out = await doScheduleTask(notARepo.deps, createParams(notARepo, { repo: tmpdir() }), {}, undefined);
  assert.equal(out.isError, true, "a directory that is not a git repo cannot carry a run");
  assert.deepEqual(notARepo.surfaces, []);
  assert.equal(notARepo.auditRuns, 0);

  const noRestatement = fake();
  out = await doScheduleTask(noRestatement.deps, createParams(noRestatement, { restatement: "  " }), {}, undefined);
  assert.equal(out.isError, true);
  assert.match(out.content[0]!.text, /必须带 restatement/);
  assert.deepEqual(noRestatement.surfaces, []);

  const badRestatement = fake();
  out = await doScheduleTask(badRestatement.deps, createParams(badRestatement, { restatement: "改一下就好了" }), {}, undefined);
  assert.equal(out.isError, true, "a restatement that is not a restatement is refused by the shared content check");
  assert.match(out.content[0]!.text, /schedule_task rejected/, "the refusal names the tool that was actually called");
  assert.doesNotMatch(out.content[0]!.text, /propose_restatement rejected/,
    "…and never sends the reader to negotiate the SESSION's own goal instead");
  assert.deepEqual(badRestatement.surfaces, []);
  assert.equal(badRestatement.auditRuns, 0);
});

// ---------------------------------------------------------------------------
// update — plain settings do not renegotiate, contract edits do

test("update: cron / enabled / name only — no dialog, no audit, contract untouched", async () => {
  const f = fake();
  const task = seed(f);
  const out = await doScheduleTask(f.deps, { action: "update", id: task.id, cron: "30 4 * * *", enabled: false }, {}, undefined);
  assert.equal(out.isError, undefined, out.content[0]!.text);
  assert.deepEqual(f.surfaces, [], "a schedule change is not a contract change");
  assert.equal(f.auditRuns, 0);
  const table = readSchedules(f.home);
  const after = table.ok ? table.file.tasks[0] : undefined;
  assert.equal(after?.cron, "30 4 * * *");
  assert.equal(after?.enabled, false);
  assert.deepEqual(after?.contract, task.contract, "the contract rides along unchanged");
  assert.match(out.content[0]!.text, /不重走协商/);
});

test("update: a contract field re-opens the whole chain and rewrites the contract", async () => {
  const f = fake();
  const task = seed(f);
  const out = await doScheduleTask(f.deps, {
    action: "update", id: task.id, requirement: "改成每周审一次",
    restatement: RESTATEMENT.replace("每天", "每周"), goal: GOAL + "\n2. 每周一次",
    station: "pr",
  }, {}, undefined);
  assert.equal(out.isError, undefined, out.content[0]!.text);
  assert.deepEqual(f.surfaces, ["showToUser", "restatement-dialog", "showToUser", "goal-dialog"]);
  const table = readSchedules(f.home);
  const after = table.ok ? table.file.tasks[0] : undefined;
  assert.equal(after?.id, task.id, "the id survives an update");
  assert.equal(after?.requirement, "改成每周审一次");
  assert.equal(after?.contract.restatement.station, "pr");
  assert.equal(after?.contract.approvedAt, APPROVED_AT);
  assert.notEqual(after?.contract.goal.hash, task.contract.goal.hash, "a new draft is a new hash");
  // The session's OWN goal is already on record here? No — `seed` only writes
  // the table, so this approval also lands in the session records.
  assert.equal(f.written.length, 1);
});

test("update: a contract edit without the two texts is refused, and names what is missing", async () => {
  const f = fake();
  const task = seed(f);
  const out = await doScheduleTask(f.deps, { action: "update", id: task.id, requirement: "只改需求" }, {}, undefined);
  assert.equal(out.isError, true);
  assert.match(out.content[0]!.text, /restatement 与 goal/);
  assert.deepEqual(f.surfaces, []);
  const table = readSchedules(f.home);
  assert.equal(table.ok && table.file.tasks[0]?.requirement, "每晚审一次");
});

test("update: an unknown id is refused without touching the table", async () => {
  const f = fake();
  const task = seed(f);
  const out = await doScheduleTask(f.deps, { action: "update", id: "sch-00000000", cron: "0 5 * * *" }, {}, undefined);
  assert.equal(out.isError, true);
  assert.match(out.content[0]!.text, /找不到 id sch-00000000/);
  const table = readSchedules(f.home);
  assert.equal(table.ok && table.file.tasks[0]?.cron, task.cron);
});

// ---------------------------------------------------------------------------
// remove

test("remove: the exact id is deleted, and the removed record is reported", async () => {
  const f = fake();
  const task = seed(f);
  const out = await doScheduleTask(f.deps, { action: "remove", id: task.id }, {}, undefined);
  assert.equal(out.isError, undefined, out.content[0]!.text);
  assert.match(out.content[0]!.text, /nightly-audit/);
  assert.equal(out.details?.removed !== undefined, true);
  const table = readSchedules(f.home);
  assert.equal(table.ok && table.file.tasks.length, 0);
});

test("remove: a wrong id deletes nothing", async () => {
  const f = fake();
  const task = seed(f);
  const out = await doScheduleTask(f.deps, { action: "remove", id: task.name }, {}, undefined);
  assert.equal(out.isError, true, "a NAME is not an id — remove must not guess");
  assert.match(out.content[0]!.text, /没有删掉任何东西/);
  const table = readSchedules(f.home);
  assert.equal(table.ok && table.file.tasks.length, 1);
});

// ---------------------------------------------------------------------------
// list

test("list: every task with its run facts, and an empty table is a real answer", async () => {
  const empty = fake();
  const none = await doScheduleTask(empty.deps, { action: "list" }, {}, undefined);
  assert.equal(none.isError, undefined);
  assert.match(none.content[0]!.text, /当前没有任何定时任务/);
  assert.deepEqual(none.details?.tasks, []);
  assert.equal(none.details?.version, 0, "the table version goes out with the list — expectedVersion is checked against it");

  const f = fake();
  seed(f, { name: "nightly-audit", cron: "0 3 * * *" });
  seed(f, { name: "weekly-audit", cron: "0 9 * * 1" });
  const out = await doScheduleTask(f.deps, { action: "list" }, {}, undefined);
  assert.equal(out.isError, undefined);
  const tasks = out.details?.tasks as Array<Record<string, unknown>>;
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((t) => t.name), ["nightly-audit", "weekly-audit"]);
  assert.equal(tasks[0]?.repo, f.repo);
  assert.equal(tasks[0]?.station, "commit");
  assert.equal(tasks[0]?.enabled, true);
  assert.equal(typeof tasks[0]?.nextRunAt, "string", "a waiting task names its next slot");
  assert.equal(tasks[0]?.lastRun, null, "never run yet");
  assert.match(String(tasks[0]?.describe), /03:00|3:00/);
  assert.equal(out.details?.version, 2, "two writes ⇒ version 2, the number a later update may pass as expectedVersion");
  assert.match(out.content[0]!.text, /调度表 version 2/);
  assert.match(out.content[0]!.text, /cron: 0 3 \* \* \*/);
  assert.match(out.content[0]!.text, /最近一次运行: 从未运行/);
});

test("list: a MISSED slot reads as overdue, not as one period away", async () => {
  const f = fake();
  seed(f);
  // A month later: the task never ran, so its first slot is long past — the
  // daemon will deal with that very slot on its next tick, and 「下次运行」
  // must not claim it is a day away (the panel's `/api/schedules` reads the
  // same `dueDecision`, so the two surfaces cannot disagree).
  const later = new Date(Date.parse(APPROVED_AT) + 30 * 24 * 60 * 60 * 1000);
  f.deps.now = () => later;
  const out = await doScheduleTask(f.deps, { action: "list" }, {}, undefined);
  const task = (out.details?.tasks as Array<Record<string, unknown>>)[0]!;
  assert.equal(task.overdue, true);
  assert.ok(Date.parse(String(task.nextRunAt)) < later.getTime(), String(task.nextRunAt));
  assert.match(out.content[0]!.text, /已过期/);
});

// ---------------------------------------------------------------------------
// the identity gate — authoring is refused, reading is not

test("judge / worker / child / normal refuse authoring; list still answers", async () => {
  for (const over of [
    { judgePane: true }, { workerPane: true }, { child: true }, { mode: "normal" as TaskMode },
  ]) {
    const f = fake(over);
    const out = await doScheduleTask(f.deps, createParams(f), {}, undefined);
    assert.equal(out.isError, true, JSON.stringify(over));
    assert.match(out.content[0]!.text, /schedule_task 被拒/);
    assert.deepEqual(f.surfaces, [], "no dialog is raised in a session that may not negotiate");
    assert.equal(tasksIn(f).length, 0);
    // The READ is not part of the refusal: 「现在有哪些定时任务」 must be
    // answerable from anywhere.
    const listed = await doScheduleTask(f.deps, { action: "list" }, {}, undefined);
    assert.equal(listed.isError, undefined, JSON.stringify(over));
  }
});

test("a missing action is refused with the four legal ones", async () => {
  const f = fake();
  const out = await doScheduleTask(f.deps, {}, {}, undefined);
  assert.equal(out.isError, true);
  assert.match(out.content[0]!.text, /list \/ create \/ update \/ remove/);
});

// ---------------------------------------------------------------------------
// registration — ONE tool, one host, one entry point

test("registerScheduleTools registers exactly one tool", () => {
  const names: string[] = [];
  const host: ToolHost = { registerTool: (definition) => { names.push(definition.name); } };
  registerScheduleTools(host, {} as never);
  assert.deepEqual(names, ["schedule_task"]);
});
