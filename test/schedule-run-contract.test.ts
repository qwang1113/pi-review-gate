/**
 * `adoptScheduledRunContract` — what a scheduled run inherits at
 * `session_start` (lib/schedule-run-contract.ts).
 *
 * The run must NOT re-negotiate: the contract was approved when the task was
 * authored. What this file pins is the FAIL-CLOSED half — the four facts that
 * must all hold before a single byte is written (the two hashes match their
 * texts, the task's repo is this session's repo, and the append-only ledger
 * proves `RG_SCHEDULE_RUN` is THIS session's run) — because the failure mode
 * of a wrongly adopted contract is a session editing and shipping against a
 * goal nobody approved.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adoptScheduledRunContract } from "../lib/schedule-run-contract.ts";
import { createScheduleWorktree, scheduleOwnerRecordPath } from "../lib/schedule-worktree.ts";
import {
  addScheduledTask,
  appendScheduleRun,
  SCHEDULE_ID_ENV,
  SCHEDULE_RUN_ENV,
  type ScheduleContract,
} from "../lib/schedule-store.ts";
import { schedulesPath } from "../lib/daemon/paths.ts";
import { emptyState, type GateState } from "../lib/gate-state.ts";
import { goalTextHash } from "../lib/loop-goal.ts";
import { restatementHash } from "../lib/restatement.ts";

const RESTATEMENT = [
  "## 需求反述",
  "1. 这件事是什么：每天定时跑一次夜间审计。",
  "2. 举个例子：03:00 起一个 loop 会话。",
  "3. 改之前：手动触发。",
  "4. 改之后：自动发起。",
].join("\n");
const GOAL = "# 夜间审计\n意图：按天自动发起一次审计";
const APPROVED_AT = "2026-10-01T00:00:00.000Z";
const SESSION = "sess-run";

function makeContract(over: Partial<ScheduleContract> = {}): ScheduleContract {
  return {
    restatement: { text: RESTATEMENT, hash: restatementHash(RESTATEMENT), station: "commit", at: APPROVED_AT },
    goal: { text: GOAL, hash: goalTextHash(GOAL), at: APPROVED_AT },
    approvedAt: APPROVED_AT,
    ...over,
  };
}

interface Fake {
  home: string;
  repo: string;
  other: string;
  st: GateState;
  written: Array<{ path: string; text: string }>;
  persisted: string[];
  logs: string[];
  failsWrite: boolean;
}

function fake(): Fake {
  return {
    home: mkdtempSync(join(tmpdir(), "rg-run-contract-")),
    repo: mkdtempSync(join(tmpdir(), "rg-run-repo-")),
    other: mkdtempSync(join(tmpdir(), "rg-run-other-")),
    st: emptyState(SESSION, 10),
    written: [],
    persisted: [],
    logs: [],
    failsWrite: false,
  };
}

/** Seed one task (repo configurable) and, unless told otherwise, its run. */
function seed(f: Fake, over: { repo?: string; run?: "none" | "other-session" | "ok" } = {}): string {
  const added = addScheduledTask(f.home, {
    name: "nightly-audit",
    repo: over.repo ?? f.repo,
    cron: "0 3 * * *",
    requirement: "每晚审一次",
    contract: makeContract(),
    from: "gate",
  });
  assert.equal(added.ok, true, added.ok ? "" : added.problem);
  const id = added.ok ? added.value.id : "sch-00000000";
  if (over.run !== "none") {
    appendScheduleRun(f.home, {
      kind: "run-started",
      runId: "run-1",
      taskId: id,
      sessionId: over.run === "other-session" ? "sess-someone-else" : SESSION,
      at: "2026-10-02T00:00:00.000Z",
    });
  }
  return id;
}

function deps(f: Fake) {
  return {
    home: () => f.home,
    repoRoot: () => f.repo,
    sessionId: () => SESSION,
    stateFor: () => f.st,
    persist: (_ctx: unknown, root: string) => { f.persisted.push(root); },
    loopGoalPath: (root: string) => join(root, ".pi", "loop-goal.md"),
    writeGoalFile: (path: string, text: string) => {
      if (f.failsWrite) throw new Error("EACCES");
      f.written.push({ path, text });
    },
    log: (message: string) => { f.logs.push(message); },
  };
}

const env = (taskId: string, runId = "run-1"): NodeJS.ProcessEnv => ({
  [SCHEDULE_ID_ENV]: taskId,
  [SCHEDULE_RUN_ENV]: runId,
});

test("a proven run adopts the contract into its goal file and its sidecar records", () => {
  const f = fake();
  const id = seed(f);
  const out = adoptScheduledRunContract(deps(f), {}, env(id));
  assert.equal(out.adopted, true, out.adopted ? "" : out.reason);
  assert.equal(f.written.length, 1);
  assert.equal(f.written[0]!.path, join(f.repo, ".pi", "loop-goal.md"));
  assert.equal(f.written[0]!.text, GOAL + "\n");
  assert.equal(f.st.restatement?.hash, restatementHash(RESTATEMENT));
  assert.equal(f.st.restatement?.station, "commit");
  assert.equal(f.st.restatement?.at, APPROVED_AT, "the approval happened then, not now");
  assert.equal(f.st.loopGoal?.hash, goalTextHash(GOAL));
  assert.equal(f.st.loopGoal?.station, "commit");
  assert.equal(f.st.loopGoal?.at, APPROVED_AT);
  assert.deepEqual(f.persisted, [f.repo]);
  assert.match(f.logs.join("\n"), /继承了定时任务 nightly-audit/);
});

test("no RG_SCHEDULE_* in the environment: an ordinary session does nothing at all", () => {
  const f = fake();
  seed(f);
  const out = adoptScheduledRunContract(deps(f), {}, {});
  assert.equal(out.adopted, false);
  assert.equal(f.st.loopGoal, undefined);
  assert.deepEqual(f.written, []);
  assert.equal(existsSync(join(f.repo, ".pi")), false);
  assert.equal(f.logs.length, 0, "an ordinary session start says nothing at all");
});

test("a contract whose hash does not match its own text is refused, nothing written", () => {
  const f = fake();
  const id = seed(f);
  // The store refuses to WRITE such a contract, so tamper with the file the
  // way a hand edit would (the reader must not trust it either).
  const path = schedulesPath(f.home);
  const doc = JSON.parse(readFileSync(path, "utf8")) as { tasks: Array<{ contract: { goal: { hash: string } } }> };
  doc.tasks[0]!.contract.goal.hash = "0".repeat(64);
  writeFileSync(path, JSON.stringify(doc));
  const out = adoptScheduledRunContract(deps(f), {}, env(id));
  assert.equal(out.adopted, false);
  assert.match(out.adopted ? "" : out.reason, /契约不成立/);
  assert.deepEqual(f.written, []);
  assert.equal(f.st.loopGoal, undefined);
  assert.match(f.logs.join("\n"), /没有继承调度契约/);
});

test("a task for ANOTHER repo is not this session's contract", () => {
  const f = fake();
  const id = seed(f, { repo: f.other });
  const out = adoptScheduledRunContract(deps(f), {}, env(id));
  assert.equal(out.adopted, false);
  assert.match(out.adopted ? "" : out.reason, /repo/);
  assert.equal(f.st.loopGoal, undefined);
});

test("a run the ledger does not attribute to THIS session is refused", () => {
  const none = fake();
  const id = seed(none, { run: "none" });
  assert.equal(adoptScheduledRunContract(deps(none), {}, env(id)).adopted, false);
  assert.equal(none.st.loopGoal, undefined);

  const foreign = fake();
  const other = seed(foreign, { run: "other-session" });
  const out = adoptScheduledRunContract(deps(foreign), {}, env(other));
  assert.equal(out.adopted, false);
  assert.match(out.adopted ? "" : out.reason, /run-started/);
  assert.equal(foreign.st.loopGoal, undefined);

  const wrongRun = fake();
  const id2 = seed(wrongRun);
  assert.equal(adoptScheduledRunContract(deps(wrongRun), {}, { [SCHEDULE_ID_ENV]: id2, [SCHEDULE_RUN_ENV]: "run-999" }).adopted, false);
  assert.equal(wrongRun.st.loopGoal, undefined);
});

test("an unknown task id adopts nothing", () => {
  const f = fake();
  seed(f);
  const out = adoptScheduledRunContract(deps(f), {}, env("sch-deadbeef"));
  assert.equal(out.adopted, false);
  assert.match(out.adopted ? "" : out.reason, /no scheduled task/);
  assert.deepEqual(f.written, []);
});

test("a goal file that cannot be written leaves NO approval record behind", () => {
  const f = fake();
  f.failsWrite = true;
  const id = seed(f);
  const out = adoptScheduledRunContract(deps(f), {}, env(id));
  assert.equal(out.adopted, false);
  assert.match(out.adopted ? "" : out.reason, /EACCES/);
  assert.equal(f.st.loopGoal, undefined, "an approval record may never claim a file that is not there");
  assert.equal(f.st.restatement, undefined);
  assert.deepEqual(f.persisted, []);
});

test("a run in its OWN checkout adopts the contract too (2026-10-03)", () => {
  // THE SHAPE THE SCHEDULER PRODUCES: every run works in the checkout cut from
  // the task's repository (lib/schedule-worktree.ts), so its cwd is NOT the
  // task's repo. Asking for path equality would refuse every run that exists —
  // and a refused session cannot adopt the contract it was started for.
  const f = fake();
  const repo = mkdtempSync(join(tmpdir(), "rg-run-contract-git-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "gate-test@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "gate test"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "hello\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  const id = seed(f, { repo });
  const cut = createScheduleWorktree({ repo, runId: "run-1" });
  assert.equal(cut.ok, true, cut.ok ? "" : cut.problem);
  if (!cut.ok) return;
  try {
    const out = adoptScheduledRunContract({ ...deps(f), repoRoot: () => cut.worktree.path }, {}, env(id));
    assert.equal(out.adopted, true, out.adopted ? "" : out.reason);
    assert.deepEqual(f.written, [{ path: join(cut.worktree.path, ".pi", "loop-goal.md"), text: GOAL + "\n" }]);
    assert.equal(f.st.loopGoal?.station, "commit", "契约里的站点跟着过来");
  } finally {
    rmSync(cut.worktree.path, { recursive: true, force: true });
    rmSync(scheduleOwnerRecordPath(cut.worktree.path), { force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
