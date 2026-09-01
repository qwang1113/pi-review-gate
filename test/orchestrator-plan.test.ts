import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_PARALLEL,
  MAX_MAX_PARALLEL,
  PLAN_MAX_TASKS,
  PLAN_RELPATH,
  applyTaskStatus,
  canonicalPlanText,
  clampMaxParallel,
  conflictingParallelPairs,
  findDependencyCycle,
  formatPlanSummary,
  isLegalTransition,
  openDecisions,
  parsePlan,
  planHash,
  scheduleNextTasks,
  unfinishedTasks,
  unreportedDecisions,
  type OrchestratorPlan,
} from "../lib/orchestrator-plan.ts";

const NOW = "2026-08-29T12:00:00.000Z";

function planOf(overrides: Record<string, unknown> = {}): OrchestratorPlan {
  const parsed = parsePlan({
    title: "拆分 review-gate",
    intent: "把 8659 行的扩展拆成模块",
    tasks: [
      { id: "a", title: "抽 plan 模块", fileBoundaries: ["lib/plan"] },
      { id: "b", title: "抽 tmux 模块", fileBoundaries: ["lib/tmux"] },
    ],
    ...overrides,
  }, NOW);
  assert.ok(parsed.ok, `fixture must parse: ${parsed.problems.join("; ")}`);
  return parsed.plan!;
}

test("the plan file lives inside the gate-owned scope", () => {
  assert.ok(PLAN_RELPATH.startsWith(".pi/"),
    "writing the plan must never change the worktree fingerprint or arm the doc gate");
});

test("CONSTRAINT 5: a task with no declared file boundary is refused", () => {
  const parsed = parsePlan({
    title: "t", intent: "i",
    tasks: [{ id: "a", title: "no boundary" }],
  }, NOW);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.problems.some((p) => /fileBoundaries/.test(p)),
    "the message must name the missing field — parallel scheduling and proxy approval both depend on it");
  assert.equal(parsed.plan, undefined, "a plan with problems is not a plan");
});

test("CONSTRAINT 6 (write path): a task with no declared repo is refused when strictRepo", () => {
  const parsed = parsePlan({
    title: "t", intent: "i",
    tasks: [{ id: "a", title: "server-service-dashboard: BFF proxy", fileBoundaries: ["src"] }],
  }, NOW, true);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.problems.some((p) => /repo/.test(p)),
    "the strict write path must name the missing repo — it decides the child's cwd");
  assert.equal(parsed.plan, undefined);
});

test("CONSTRAINT 6 (write path): a task WITH a repo passes strictRepo", () => {
  const parsed = parsePlan({
    title: "t", intent: "i",
    tasks: [{ id: "a", title: "BFF proxy", repo: "/work/server-service-dashboard", fileBoundaries: ["src"] }],
  }, NOW, true);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan?.tasks[0].repo, "/work/server-service-dashboard");
});

test("CONSTRAINT 6 (write path): a RELATIVE repo is refused — it would resolve to the PM's own repo", () => {
  const parsed = parsePlan({
    title: "t", intent: "i",
    tasks: [{ id: "a", title: "BFF proxy", repo: "lib", fileBoundaries: ["src"] }],
  }, NOW, true);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.problems.some((p) => /绝对路径/.test(p)),
    "a relative repo must be named as the failure — it silently lands the child in the orchestrator's own repo");
});

test("READ path stays lenient: a legacy plan without repo still loads (strictRepo defaults false)", () => {
  const parsed = parsePlan({
    title: "t", intent: "i",
    tasks: [{ id: "a", title: "legacy", fileBoundaries: ["src"] }],
  }, NOW);
  assert.equal(parsed.ok, true, "an old plan without repo must keep loading");
  assert.equal(parsed.plan?.tasks[0].repo, undefined);
});

test("validation reports EVERY problem, not just the first", () => {
  const parsed = parsePlan({
    tasks: [
      { id: "a", title: "", fileBoundaries: ["/abs"] },
      { id: "a", title: "dup", fileBoundaries: ["lib"] },
      { id: "!bad", title: "x", fileBoundaries: ["lib"] },
    ],
  }, NOW);
  assert.equal(parsed.ok, false);
  const joined = parsed.problems.join("\n");
  for (const expected of [/plan\.title/, /plan\.intent/, /重复/, /非法/]) {
    assert.match(joined, expected);
  }
});

test("a dependency that does not exist, or that loops, is refused", () => {
  const missing = parsePlan({
    title: "t", intent: "i",
    tasks: [{ id: "a", title: "a", fileBoundaries: ["lib"], dependsOn: ["ghost"] }],
  }, NOW);
  assert.ok(missing.problems.some((p) => /不存在/.test(p)));

  const cyclic = parsePlan({
    title: "t", intent: "i",
    tasks: [
      { id: "a", title: "a", fileBoundaries: ["lib/a"], dependsOn: ["b"] },
      { id: "b", title: "b", fileBoundaries: ["lib/b"], dependsOn: ["a"] },
    ],
  }, NOW);
  assert.ok(cyclic.problems.some((p) => /成环/.test(p)),
    "an unrunnable plan would make the exit condition permanently unsatisfiable");
  assert.ok(findDependencyCycle(cyclic.plan?.tasks ?? [
    { id: "a", title: "a", fileBoundaries: ["lib/a"], dependsOn: ["b"], execution: "serial", status: "pending" },
    { id: "b", title: "b", fileBoundaries: ["lib/b"], dependsOn: ["a"], execution: "serial", status: "pending" },
  ]));
});

test("parallelism is clamped to what the layout and the cost model support", () => {
  assert.equal(clampMaxParallel(undefined), DEFAULT_MAX_PARALLEL);
  assert.equal(clampMaxParallel(0), 1);
  assert.equal(clampMaxParallel(-5), 1);
  assert.equal(clampMaxParallel(99), MAX_MAX_PARALLEL);
  assert.equal(clampMaxParallel("many"), DEFAULT_MAX_PARALLEL);
  assert.equal(clampMaxParallel(2.7), 2);
});

test("a plan larger than the cap is refused", () => {
  const tasks = Array.from({ length: PLAN_MAX_TASKS + 1 }, (_, i) => ({
    id: `t${i}`, title: `t${i}`, fileBoundaries: [`lib/t${i}`],
  }));
  const parsed = parsePlan({ title: "t", intent: "i", tasks }, NOW);
  assert.ok(parsed.problems.some((p) => new RegExp(String(PLAN_MAX_TASKS)).test(p)));
});

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

test("the two ILLEGAL transitions are the plan's honesty guarantees", () => {
  assert.equal(isLegalTransition("pending", "done"), false,
    "declaring a task done without ever running it would make constraint 3 vacuous");
  assert.equal(isLegalTransition("done", "running"), false,
    "rework must go through pending, so the plan records that the task came back");
  assert.equal(isLegalTransition("pending", "running"), true);
  assert.equal(isLegalTransition("running", "done"), true);
  assert.equal(isLegalTransition("running", "blocked"), true);
  assert.equal(isLegalTransition("blocked", "pending"), true);
  assert.equal(isLegalTransition("done", "pending"), true, "rework is allowed — just not silently");
  assert.equal(isLegalTransition("done", "done"), true, "a no-op is not a lie");
});

test("applyTaskStatus refuses the illegal move and explains WHY", () => {
  const plan = planOf();
  const refused = applyTaskStatus(plan, "a", "done", { now: NOW });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /没跑过就说做完了/);
  assert.equal(plan.tasks[0]!.status, "pending", "the input is never mutated");
});

test("applyTaskStatus refuses to start a task whose prerequisites are unfinished", () => {
  const plan = planOf({
    tasks: [
      { id: "a", title: "a", fileBoundaries: ["lib/a"] },
      { id: "b", title: "b", fileBoundaries: ["lib/b"], dependsOn: ["a"] },
    ],
  });
  const refused = applyTaskStatus(plan, "b", "running", { now: NOW });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /前置任务尚未完成/);
});

test("a legal move returns a NEW plan and records the note", () => {
  const plan = planOf();
  const moved = applyTaskStatus(plan, "a", "running", { note: "child a-1", now: NOW });
  assert.ok(moved.ok);
  if (moved.ok) {
    assert.equal(moved.plan.tasks[0]!.status, "running");
    assert.equal(moved.plan.tasks[0]!.note, "child a-1");
    assert.notEqual(moved.plan, plan);
    assert.equal(plan.tasks[0]!.status, "pending");
  }
  const unknown = applyTaskStatus(plan, "nope", "running", { now: NOW });
  assert.equal(unknown.ok, false);
});

// ---------------------------------------------------------------------------
// Scheduling (constraint 6)
// ---------------------------------------------------------------------------

test("CONSTRAINT 6: same-repo tasks are DEFERRED, never co-scheduled (2026-09-07)", () => {
  // The isolation worktree is gone, so two children may never share one
  // checkout: same-repo tasks serialize whatever their boundaries say.
  const plan = planOf({
    maxParallel: 2,
    tasks: [
      { id: "a", title: "a", fileBoundaries: ["lib"] },
      { id: "b", title: "b", fileBoundaries: ["docs"] }, // disjoint, but SAME repo
    ],
  });
  const { start, deferred } = scheduleNextTasks(plan, [], "/repo");
  assert.deepEqual(start.map((s) => s.task.id), ["a"], "only one child per repo starts");
  assert.deepEqual(deferred.map((d) => d.task.id), ["b"]);
  assert.equal(deferred[0]!.blockedBy, "a");
  assert.match(deferred[0]!.reason, /同一 repo/, "the deferral says why, so the user can be told");
});

test("cross-repo tasks DO run in parallel (2026-09-07)", () => {
  const plan = planOf({ maxParallel: 2, tasks: [
    { id: "a", title: "a", fileBoundaries: ["lib"], repo: "/repo-a" },
    { id: "b", title: "b", fileBoundaries: ["lib"], repo: "/repo-b" },
  ] });
  const { start, deferred } = scheduleNextTasks(plan, [], "/repo-a");
  assert.deepEqual(start.map((s) => s.task.id), ["a", "b"], "different checkouts may run side by side");
  assert.deepEqual(start.map((s) => s.execution), ["serial", "parallel"]);
  assert.deepEqual(deferred, []);
});

test("an undeclared repo means the orchestration's own repo", () => {
  const plan = planOf({ maxParallel: 2, tasks: [
    { id: "a", title: "a", fileBoundaries: ["lib"] },
    { id: "b", title: "b", fileBoundaries: ["lib"], repo: "/repo-b" },
  ] });
  const { start, deferred } = scheduleNextTasks(plan, [], "/repo-a");
  assert.deepEqual(start.map((s) => s.task.id), ["a", "b"], "a defaults to the primary repo, which differs from b");
});


test("a task in the SAME repo as something ALREADY RUNNING waits for it", () => {
  const plan = planOf({
    maxParallel: 2,
    tasks: [
      { id: "a", title: "a", fileBoundaries: ["lib"], status: "running" },
      { id: "b", title: "b", fileBoundaries: ["lib/x.ts"] },
    ],
  });
  const { start, deferred } = scheduleNextTasks(plan, ["a"], "/repo");
  assert.deepEqual(start, []);
  assert.deepEqual(deferred.map((d) => d.blockedBy), ["a"]);
});

test("the parallel cap and unmet dependencies both hold tasks back", () => {
  const full = planOf({ maxParallel: 1, tasks: [
    { id: "a", title: "a", fileBoundaries: ["lib/a"], status: "running" },
    { id: "b", title: "b", fileBoundaries: ["lib/b"] },
  ] });
  assert.deepEqual(scheduleNextTasks(full, ["a"], "/repo"), { start: [], deferred: [] },
    "no free slot ⇒ nothing starts");
  const chained = planOf({ tasks: [
    { id: "a", title: "a", fileBoundaries: ["lib/a"] },
    { id: "b", title: "b", fileBoundaries: ["lib/b"], dependsOn: ["a"] },
  ] });
  assert.deepEqual(scheduleNextTasks(chained, [], "/repo").start.map((s) => s.task.id), ["a"],
    "b is not a candidate at all until a is done");
});

test("same-repo parallel pairs are reported at approval time (2026-09-07)", () => {
  const plan = planOf({ tasks: [
    { id: "a", title: "a", fileBoundaries: ["lib"], execution: "parallel" },
    { id: "b", title: "b", fileBoundaries: ["lib/x"], execution: "parallel" },
    { id: "c", title: "c", fileBoundaries: ["docs"], execution: "parallel", repo: "/repo-b" },
  ] });
  assert.deepEqual(conflictingParallelPairs(plan, "/repo"), [{ a: "a", b: "b" }],
    "same repo ⇒ parallel is downgraded; a different repo keeps its parallel");
  assert.match(formatPlanSummary(plan), /并行降级/,
    "the user sees the downgrade in the approval dialog, before it happens");
});

// ---------------------------------------------------------------------------
// Exit conditions (constraints 3 and 11)
// ---------------------------------------------------------------------------

test("CONSTRAINT 3: anything not done keeps the orchestration open", () => {
  const plan = planOf({ tasks: [
    { id: "a", title: "a", fileBoundaries: ["lib/a"], status: "done" },
    { id: "b", title: "b", fileBoundaries: ["lib/b"], status: "blocked" },
  ] });
  assert.deepEqual(unfinishedTasks(plan).map((t) => t.id), ["b"],
    "blocked counts as unfinished — it is not an exit state");
});

test("CONSTRAINT 11: only a decision the user was never TOLD about blocks", () => {
  const plan = planOf({
    decisions: [
      { id: "d1", question: "丢弃工作区？" },
      { id: "d2", question: "换方案？", notifiedAt: NOW },
      { id: "d3", question: "已答", resolvedAt: NOW, answer: "yes" },
    ],
  });
  assert.deepEqual(unreportedDecisions(plan).map((d) => d.id), ["d1"],
    "a notified-but-unanswered question does not block: the user has it and can answer whenever");
  assert.deepEqual(openDecisions(plan).map((d) => d.id), ["d1", "d2"]);
});

// ---------------------------------------------------------------------------
// Content binding (constraint 1)
// ---------------------------------------------------------------------------

test("the approval hash covers the WORK, and executing the work does not break it", () => {
  const plan = planOf();
  const before = planHash(plan);
  const running = applyTaskStatus(plan, "a", "running", { now: "2026-08-30T00:00:00.000Z" });
  assert.ok(running.ok);
  if (running.ok) {
    assert.equal(planHash(running.plan), before,
      "status and timestamps are excluded — otherwise the approval would die on the first task");
  }
});

test("changing what the user approved REVOKES the approval", () => {
  const base = planOf();
  const cases: Array<[string, OrchestratorPlan]> = [
    ["a new task", planOf({ tasks: [
      { id: "a", title: "抽 plan 模块", fileBoundaries: ["lib/plan"] },
      { id: "b", title: "抽 tmux 模块", fileBoundaries: ["lib/tmux"] },
      { id: "c", title: "偷偷加的", fileBoundaries: ["extensions"] },
    ] })],
    ["a widened boundary", planOf({ tasks: [
      { id: "a", title: "抽 plan 模块", fileBoundaries: ["."] },
      { id: "b", title: "抽 tmux 模块", fileBoundaries: ["lib/tmux"] },
    ] })],
    ["more parallelism", planOf({ maxParallel: 4 })],
    ["a different intent", planOf({ intent: "别的目标" })],
  ];
  for (const [what, changed] of cases) {
    assert.notEqual(planHash(changed), planHash(base), `${what} must invalidate the approval`);
  }
});

test("the canonical text is order-independent for sets", () => {
  const a = planOf({ tasks: [{ id: "a", title: "t", fileBoundaries: ["lib", "docs"], dependsOn: [] }] });
  const b = planOf({ tasks: [{ id: "a", title: "t", fileBoundaries: ["docs", "lib"], dependsOn: [] }] });
  assert.equal(canonicalPlanText(a), canonicalPlanText(b),
    "re-ordering a boundary list is not a change the user needs to re-approve");
});

test("the summary is readable and names every task with its boundary", () => {
  const summary = formatPlanSummary(planOf());
  assert.match(summary, /拆分 review-gate/);
  assert.match(summary, /\[pending\] a \(serial\)/);
  assert.match(summary, /边界：lib\/plan/);
  assert.match(summary, /并行上限：2/);
});
