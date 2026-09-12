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
  findDependencyCycle,
  formatPlanSummary,
  mergeTaskProgress,
  isLegalTransition,
  isPlanHash,
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
      { id: "a", title: "抽 plan 模块" },
      { id: "b", title: "抽 tmux 模块" },
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

test("a plan file carrying a REMOVED task field loads, and the field is dropped", () => {
  // The file-boundary field was deleted from PlanTask on 2026-09-17 (user
  // decision). Old plan files on disk still carry it, and refusing them would
  // strand an orchestration mid-flight for a field nothing reads any more.
  // Driven with a placeholder key so the rule under test is "unknown task
  // fields are ignored", not "this one name is special-cased".
  const parsed = parsePlan({
    title: "t", intent: "i",
    tasks: [{ id: "a", title: "legacy", legacyFileScope: ["lib/a.ts"] }],
  }, NOW);
  assert.equal(parsed.ok, true, parsed.problems.join("; "));
  assert.deepEqual(
    Object.keys(parsed.plan!.tasks[0]!).sort(),
    ["dependsOn", "execution", "id", "note", "status", "title"],
    "the unknown field is dropped, not carried",
  );
});

test("CONSTRAINT 6 (write path): a task with no declared repo is refused when strictRepo", () => {
  const parsed = parsePlan({
    title: "t", intent: "i",
    tasks: [{ id: "a", title: "server-service-dashboard: BFF proxy" }],
  }, NOW, true);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.problems.some((p) => /repo/.test(p)),
    "the strict write path must name the missing repo — it decides the child's cwd");
  assert.equal(parsed.plan, undefined);
});

test("CONSTRAINT 6 (write path): a task WITH a repo passes strictRepo", () => {
  const parsed = parsePlan({
    title: "t", intent: "i",
    tasks: [{ id: "a", title: "BFF proxy", repo: "/work/server-service-dashboard" }],
  }, NOW, true);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan?.tasks[0].repo, "/work/server-service-dashboard");
});

test("CONSTRAINT 6 (write path): a RELATIVE repo is refused — it would resolve to the PM's own repo", () => {
  const parsed = parsePlan({
    title: "t", intent: "i",
    tasks: [{ id: "a", title: "BFF proxy", repo: "lib" }],
  }, NOW, true);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.problems.some((p) => /绝对路径/.test(p)),
    "a relative repo must be named as the failure — it silently lands the child in the orchestrator's own repo");
});

test("READ path stays lenient: a legacy plan without repo still loads (strictRepo defaults false)", () => {
  const parsed = parsePlan({
    title: "t", intent: "i",
    tasks: [{ id: "a", title: "legacy" }],
  }, NOW);
  assert.equal(parsed.ok, true, "an old plan without repo must keep loading");
  assert.equal(parsed.plan?.tasks[0].repo, undefined);
});

test("validation reports EVERY problem, not just the first", () => {
  const parsed = parsePlan({
    tasks: [
      { id: "a", title: "" },
      { id: "a", title: "dup" },
      { id: "!bad", title: "x" },
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
    tasks: [{ id: "a", title: "a", dependsOn: ["ghost"] }],
  }, NOW);
  assert.ok(missing.problems.some((p) => /不存在/.test(p)));

  const cyclic = parsePlan({
    title: "t", intent: "i",
    tasks: [
      { id: "a", title: "a", dependsOn: ["b"] },
      { id: "b", title: "b", dependsOn: ["a"] },
    ],
  }, NOW);
  assert.ok(cyclic.problems.some((p) => /成环/.test(p)),
    "an unrunnable plan would make the exit condition permanently unsatisfiable");
  assert.ok(findDependencyCycle(cyclic.plan?.tasks ?? [
    { id: "a", title: "a", dependsOn: ["b"], execution: "serial", status: "pending" },
    { id: "b", title: "b", dependsOn: ["a"], execution: "serial", status: "pending" },
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
    id: `t${i}`, title: `t${i}`,
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
      { id: "a", title: "a" },
      { id: "b", title: "b", dependsOn: ["a"] },
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
// mergeTaskProgress — what a rewrite may and may not destroy (B2b, 2026-09-06)
// ---------------------------------------------------------------------------

test("mergeTaskProgress: a NOTE the rewrite supplies wins over the old one", () => {
  // The measured defect: `write` carried a new note for an existing task and
  // the merge pinned the OLD one back, silently. Four consecutive rounds of
  // orchestration hit it; each project manager had to work around it.
  const previous = applyTaskStatus(planOf(), "a", "running", { note: "旧备注", now: NOW });
  assert.ok(previous.ok);
  const next = planOf({
    tasks: [
      { id: "a", title: "抽 plan 模块", note: "新备注" },
      { id: "b", title: "抽 tmux 模块" },
    ],
  });

  const merged = mergeTaskProgress(previous.ok ? previous.plan : undefined, next);

  assert.equal(merged.tasks[0]!.note, "新备注", "a note the caller supplied must land");
  assert.equal(merged.tasks[0]!.status, "running", "the STATUS is still execution's to own");
});

test("mergeTaskProgress: an OMITTED note still inherits the previous one", () => {
  // The other half of the same rule: a rewrite that simply does not mention
  // notes must not wipe the ones execution recorded.
  const previous = applyTaskStatus(planOf(), "a", "running", { note: "旧备注", now: NOW });
  assert.ok(previous.ok);

  const merged = mergeTaskProgress(previous.ok ? previous.plan : undefined, planOf());

  assert.equal(merged.tasks[0]!.note, "旧备注");
  assert.equal(merged.tasks[0]!.status, "running");
});

test("mergeTaskProgress: a note grants NOTHING — hash and canonical text ignore it", () => {
  // This is the premise the fix rests on: if a note reached the canonical
  // text, accepting a note update would be a content change and the user's
  // approval would have to be re-obtained. It does not.
  const withoutNote = planOf();
  const withNote = planOf({
    tasks: [
      { id: "a", title: "抽 plan 模块", note: "随便写点什么" },
      { id: "b", title: "抽 tmux 模块" },
    ],
  });

  assert.equal(canonicalPlanText(withNote), canonicalPlanText(withoutNote));
  assert.equal(planHash(withNote), planHash(withoutNote),
    "a note must never move the hash the user's approval binds to");
});


// ---------------------------------------------------------------------------
// Scheduling (constraint 6)
// ---------------------------------------------------------------------------

test("CONSTRAINT 6: same-repo tasks run SIDE BY SIDE, each in its own checkout (2026-09-10)", () => {
  // It used to say "never co-scheduled": one checkout, one writer. The
  // isolation is back (lib/orchestrator-worktree.ts) and the rule is now about
  // CHECKOUTS rather than repos — the coordinator gives the second writer its
  // own, so this function has nothing left to serialize.
  const plan = planOf({
    maxParallel: 2,
    tasks: [
      { id: "a", title: "a" },
      { id: "b", title: "b" }, // SAME repo
    ],
  });
  const { start, deferred } = scheduleNextTasks(plan, [], "/repo");
  // CHANGED 2026-09-10: same-repo tasks run side by side, each in its own
  // `git worktree` (lib/orchestrator-worktree.ts). The coordinator assigns
  // the second checkout at spawn; what this function decides is only WHAT may
  // start at all.
  assert.deepEqual(start.map((s) => s.task.id), ["a", "b"], "both start — the second gets its own checkout");
  assert.deepEqual(deferred, [], "nothing is deferred for sharing a repo any more");
});

test("cross-repo tasks DO run in parallel (2026-09-07)", () => {
  const plan = planOf({ maxParallel: 2, tasks: [
    { id: "a", title: "a", repo: "/repo-a" },
    { id: "b", title: "b", repo: "/repo-b" },
  ] });
  const { start, deferred } = scheduleNextTasks(plan, [], "/repo-a");
  assert.deepEqual(start.map((s) => s.task.id), ["a", "b"], "different checkouts may run side by side");
  assert.deepEqual(start.map((s) => s.execution), ["serial", "parallel"]);
  assert.deepEqual(deferred, []);
});

test("an undeclared repo means the orchestration's own repo", () => {
  const plan = planOf({ maxParallel: 2, tasks: [
    { id: "a", title: "a" },
    { id: "b", title: "b", repo: "/repo-b" },
  ] });
  const { start, deferred } = scheduleNextTasks(plan, [], "/repo-a");
  assert.deepEqual(start.map((s) => s.task.id), ["a", "b"], "a defaults to the primary repo, which differs from b");
});


test("a task in the SAME repo as something ALREADY RUNNING starts too — in its own checkout", () => {
  const plan = planOf({
    maxParallel: 2,
    tasks: [
      { id: "a", title: "a", status: "running" },
      { id: "b", title: "b" },
    ],
  });
  const { start, deferred } = scheduleNextTasks(plan, ["a"], "/repo");
  assert.deepEqual(start.map((s) => s.task.id), ["b"],
    "the running task no longer blocks the second one; isolation at spawn is what makes that safe");
  assert.equal(start[0]!.execution, "parallel", "and it is honest about running beside something");
  assert.deepEqual(deferred, []);
});

test("the parallel cap and unmet dependencies both hold tasks back", () => {
  const full = planOf({ maxParallel: 1, tasks: [
    { id: "a", title: "a", status: "running" },
    { id: "b", title: "b" },
  ] });
  assert.deepEqual(scheduleNextTasks(full, ["a"], "/repo"), { start: [], deferred: [] },
    "no free slot ⇒ nothing starts");
  const chained = planOf({ tasks: [
    { id: "a", title: "a" },
    { id: "b", title: "b", dependsOn: ["a"] },
  ] });
  assert.deepEqual(scheduleNextTasks(chained, [], "/repo").start.map((s) => s.task.id), ["a"],
    "b is not a candidate at all until a is done");
});

test("same-repo parallel pairs are NO LONGER a downgrade — each gets its own checkout (2026-09-10)", () => {
  // The 2026-09-07 rule serialized them; the 2026-09-10 rule gives the second
  // writer a `git worktree` (lib/orchestrator-worktree.ts), so there is
  // nothing to downgrade and nothing to warn the user about.
  const plan = planOf({ maxParallel: 3, tasks: [
    { id: "a", title: "a", execution: "parallel" },
    { id: "b", title: "b", execution: "parallel" },
    { id: "c", title: "c", execution: "parallel", repo: "/repo-b" },
  ] });
  assert.doesNotMatch(formatPlanSummary(plan), /并行降级/,
    "the approval dialog must not promise a slowdown that no longer happens");
  assert.deepEqual(scheduleNextTasks(plan, [], "/repo").start.map((s) => s.task.id), ["a", "b", "c"],
    "all three start: two repos, and two isolated checkouts in the first one");
});

// ---------------------------------------------------------------------------
// Exit conditions (constraints 3 and 11)
// ---------------------------------------------------------------------------

test("CONSTRAINT 3: anything not done keeps the orchestration open", () => {
  const plan = planOf({ tasks: [
    { id: "a", title: "a", status: "done" },
    { id: "b", title: "b", status: "blocked" },
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
      { id: "a", title: "抽 plan 模块" },
      { id: "b", title: "抽 tmux 模块" },
      { id: "c", title: "偷偷加的" },
    ] })],
    ["a task moved to another repo", planOf({ tasks: [
      { id: "a", title: "抽 plan 模块", repo: "/other-repo" },
      { id: "b", title: "抽 tmux 模块" },
    ] })],
    ["more parallelism", planOf({ maxParallel: 4 })],
    ["a different intent", planOf({ intent: "别的目标" })],
  ];
  for (const [what, changed] of cases) {
    assert.notEqual(planHash(changed), planHash(base), `${what} must invalidate the approval`);
  }
});

test("the plan-hash SHAPE is one rule, owned by the function that produces it", () => {
  // Every authorizing record read back from the sidecar (the approved hash and
  // its lineage) is shape-checked first, and the check used to be written out
  // again at each site. A copied authorization rule drifts, and it drifts
  // OPEN — one site accepting an upper-case or short digest would admit a
  // record the others refuse.
  assert.equal(isPlanHash(planHash(planOf({}))), true);
  for (const bad of ["", "not-a-hash", "a".repeat(63), "a".repeat(65), "A".repeat(64), " " + "a".repeat(64), 7, null, undefined, ["a".repeat(64)]]) {
    assert.equal(isPlanHash(bad), false, `${JSON.stringify(bad)} is not a plan hash`);
  }
});

// ---------------------------------------------------------------------------
// the delivery station (2026-09-06)

test("deliveryStation: read from the plan, and MISSING or unreadable means precommit", () => {
  assert.equal(planOf({ deliveryStation: "pr" }).deliveryStation, "pr");
  assert.equal(planOf({ deliveryStation: "commit" }).deliveryStation, "commit");
  // A plan file written before the field existed still parses — as the
  // STRICTEST station, which allows no ship command at all.
  assert.equal(planOf().deliveryStation, "precommit");
  for (const broken of ["merge", "", "PR!!", 7, null, {}]) {
    assert.equal(planOf({ deliveryStation: broken }).deliveryStation, "precommit",
      `an unreadable station (${JSON.stringify(broken)}) must not loosen anything`);
  }
});

test("deliveryStation: it is APPROVED CONTENT — changing it changes the hash", () => {
  // The station decides which ship commands the orchestration may reach, so
  // it cannot be edited under a standing approval without the gate noticing.
  assert.notEqual(planHash(planOf({ deliveryStation: "pr" })), planHash(planOf()));
  assert.notEqual(planHash(planOf({ deliveryStation: "pr" })), planHash(planOf({ deliveryStation: "commit" })));
  assert.equal(planHash(planOf({ deliveryStation: "precommit" })), planHash(planOf()),
    "an explicit precommit is the same content as an absent station");
  assert.match(canonicalPlanText(planOf({ deliveryStation: "pr" })), /"deliveryStation":"pr"/);
});

test("deliveryStation: the summary the user approves names the station", () => {
  assert.match(formatPlanSummary(planOf({ deliveryStation: "pr" })), /本轮交付站点/);
  assert.match(formatPlanSummary(planOf({ deliveryStation: "pr" })), /PR/);
  assert.match(formatPlanSummary(planOf()), /precommit/);
});

test("the canonical text is order-independent for sets", () => {
  const a = planOf({ tasks: [{ id: "a", title: "t", dependsOn: ["x", "y"] }, { id: "x", title: "x" }, { id: "y", title: "y" }] });
  const b = planOf({ tasks: [{ id: "a", title: "t", dependsOn: ["y", "x"] }, { id: "x", title: "x" }, { id: "y", title: "y" }] });
  assert.equal(canonicalPlanText(a), canonicalPlanText(b),
    "re-ordering a dependency list is not a change the user needs to re-approve");
});

test("the summary is readable and names every task with its repo", () => {
  const summary = formatPlanSummary(planOf());
  assert.match(summary, /拆分 review-gate/);
  assert.match(summary, /\[pending\] a \(serial\)/);
  assert.match(summary, /并行上限：2/);
});
