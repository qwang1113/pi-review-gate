import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ESCALATE_AT,
  HUMAN_AT,
  PLAN_DIR,
  PLAN_SCHEMA,
  PLAN_STATE_FILE,
  PLAN_VIEW_FILE,
  acceptRound,
  beginVerifyRound,
  chargeAbortedRound,
  escalationFor,
  isSeamModule,
  nextDispatch,
  parsePlanState,
  readPlanState,
  renderPlan,
  validateGraph,
  worklogPathFor,
  writePlanState,
  type PlanModule,
  type PlanState,
} from "../lib/plan-state.ts";

function moduleOf(overrides: Partial<PlanModule> = {}): PlanModule {
  return {
    id: "M-01",
    title: "seed module",
    intent: "do the first thing",
    owned_paths: ["lib/a.ts"],
    depends_on: [],
    must_haves: [{ id: "mh-1", kind: "artifact", statement: "lib/a.ts exists", risk: "normal" }],
    model: "claude-sonnet-5",
    thinking: "high",
    risk: "normal",
    est_context_tokens: 80000,
    status: "pending",
    blocked_rounds: 0,
    worklog: worklogPathFor("M-01"),
    result: "",
    ...overrides,
  };
}

function planOf(modules: PlanModule[], overrides: Partial<PlanState> = {}): PlanState {
  return {
    schema: PLAN_SCHEMA,
    requirement: "ship the thing",
    brief: "brief.md",
    created: "2026-08-12",
    status: "executing",
    cursor: null,
    verify_round: 0,
    integration_blocked_rounds: 0,
    modules,
    ...overrides,
  };
}

const serialize = (state: PlanState): string => JSON.stringify(state);

test("a well-formed plan round-trips through the parser", () => {
  const state = planOf([moduleOf(), moduleOf({ id: "M-02", owned_paths: ["lib/b.ts"], depends_on: ["M-01"], worklog: worklogPathFor("M-02") })]);
  const parsed = parsePlanState(serialize(state));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.deepEqual(parsed.state.modules.map((m) => m.id), ["M-01", "M-02"]);
  assert.equal(parsed.state.modules[1].depends_on[0], "M-01");
});

test("malformed state is refused with the exact defect, never guessed at", () => {
  const good = planOf([moduleOf()]);
  const cases: Array<[string, RegExp]> = [
    ["{not json", /not valid JSON/],
    ["[]", /must be a JSON object/],
    [JSON.stringify({ ...good, schema: 2 }), /unsupported plan schema 2/],
    [JSON.stringify({ ...good, requirement: "" }), /"requirement" must be a non-empty string/],
    [JSON.stringify({ ...good, status: "half-done" }), /unknown plan status/],
    [JSON.stringify({ ...good, verify_round: -1 }), /"verify_round" must be a non-negative integer/],
    [JSON.stringify({ ...good, modules: {} }), /"modules" must be an array/],
    [JSON.stringify({ ...good, cursor: "M-99" }), /cursor points at unknown module/],
    [JSON.stringify(planOf([moduleOf(), moduleOf({ owned_paths: ["lib/z.ts"] })])), /duplicate module id/],
    [JSON.stringify(planOf([moduleOf({ status: "halfway" as PlanModule["status"] })])), /status is unknown/],
    [JSON.stringify(planOf([moduleOf({ thinking: "turbo" as PlanModule["thinking"] })])), /thinking is unknown/],
    [JSON.stringify(planOf([moduleOf({ must_haves: [] })])), /must list at least one acceptance criterion/],
    [JSON.stringify(planOf([moduleOf({ owned_paths: [] })])), /owned_paths must be a non-empty array/],
    [JSON.stringify(planOf([moduleOf({ est_context_tokens: 0 })])), /est_context_tokens must be a positive integer/],
    [JSON.stringify(planOf([moduleOf({ blocked_rounds: -1 })])), /blocked_rounds must be a non-negative integer/],
    [JSON.stringify(planOf([moduleOf({ depends_on: ["M-42"] })])), /depends on unknown module "M-42"/],
    [JSON.stringify(planOf([moduleOf({ depends_on: ["M-01"] })])), /depends on itself/],
  ];
  for (const [raw, expected] of cases) {
    const result = parsePlanState(raw);
    assert.equal(result.ok, false, `expected refusal for ${raw.slice(0, 60)}`);
    if (!result.ok) assert.match(result.error, expected);
  }
});

test("a dependency cycle is reported instead of hanging the dispatcher", () => {
  const cyclic = planOf([
    moduleOf({ id: "M-01", depends_on: ["M-02"] }),
    moduleOf({ id: "M-02", depends_on: ["M-01"], owned_paths: ["lib/b.ts"] }),
  ]);
  const result = parsePlanState(JSON.stringify(cyclic));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /dependency cycle: M-01 -> M-02 -> M-01/);
});

test("plan-time modules must own disjoint paths; seam modules are the documented exemption", () => {
  const overlapping = planOf([
    moduleOf({ id: "M-01", owned_paths: ["lib/a.ts", "lib/shared.ts"] }),
    moduleOf({ id: "M-02", owned_paths: ["lib/shared.ts"] }),
  ]);
  assert.match(validateGraph(overlapping) ?? "", /modules "M-01" and "M-02" both own "lib\/shared.ts"/);

  const withSeam = planOf([
    moduleOf({ id: "M-01", owned_paths: ["lib/a.ts", "lib/shared.ts"] }),
    moduleOf({ id: "M-INT-1", owned_paths: ["lib/shared.ts"], depends_on: ["M-01"], seam: true }),
  ]);
  assert.equal(validateGraph(withSeam), undefined, "a seam module may overlap: serial execution keeps it safe");
  assert.equal(isSeamModule({ id: "M-INT-1", seam: true }), true);
  assert.equal(isSeamModule({ id: "M-01", seam: undefined }), false);
});

test("the seam exemption keys on the explicit flag, so an id that merely looks like a seam cannot slip past", () => {
  const impostor = planOf([
    moduleOf({ id: "M-01", owned_paths: ["lib/a.ts", "lib/shared.ts"] }),
    moduleOf({ id: "M-INT-oops", owned_paths: ["lib/shared.ts"] }),
  ]);
  assert.match(
    validateGraph(impostor) ?? "",
    /both own "lib\/shared.ts"/,
    "naming a plan-time module like a seam must not exempt it",
  );
  assert.equal(isSeamModule({ id: "M-INT-oops", seam: undefined }), false);

  // The flag survives a round-trip, so an exemption granted at creation stays granted.
  const parsed = parsePlanState(JSON.stringify(planOf([
    moduleOf({ id: "M-01", owned_paths: ["lib/shared.ts"] }),
    moduleOf({ id: "M-INT-1", owned_paths: ["lib/shared.ts"], seam: true }),
  ])));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  if (parsed.ok) assert.equal(parsed.state.modules[1].seam, true);
});

test("writePlanState renders the view and refuses to persist an invalid plan", () => {
  const root = mkdtempSync(join(tmpdir(), "plan-state-"));
  const state = planOf([moduleOf({ title: "pipe | in title" })], { cursor: "M-01" });

  assert.equal(writePlanState(root, state).ok, true);

  const reread = readPlanState(root);
  assert.ok(reread.ok, reread.ok ? "" : reread.error);
  assert.equal(reread.state.cursor, "M-01");

  const view = readFileSync(join(root, PLAN_DIR, PLAN_VIEW_FILE), "utf8");
  assert.match(view, /Rendered from `\.pi\/plan\/state\.json`/);
  assert.match(view, /pipe \\\| in title/, "table cells must escape pipes or the view breaks");

  // Every refusal readPlanState would raise must also stop the write, or the
  // run can persist a state no command can load again.
  for (const [broken, expected] of [
    [planOf([moduleOf({ depends_on: ["nope"] })]), /depends on unknown module "nope"/],
    [planOf([moduleOf({ must_haves: [] })]), /must list at least one acceptance criterion/],
    [planOf([moduleOf(), moduleOf({ owned_paths: ["lib/z.ts"] })]), /duplicate module id/],
    [planOf([moduleOf()], { verify_round: -1 }), /"verify_round" must be a non-negative integer/],
  ] as const) {
    const bad = writePlanState(root, broken);
    assert.equal(bad.ok, false, `expected a refusal for ${expected}`);
    if (!bad.ok) assert.match(bad.error, expected);
  }

  const after = readPlanState(root);
  assert.ok(after.ok, "a refused write must leave the previous state loadable");
  if (after.ok) assert.equal(after.state.modules[0].title, "pipe | in title");
});

test("a missing plan points at /decompose instead of throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "plan-missing-"));
  const result = readPlanState(root);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /run \/decompose first/);
});

test("a truncated state file is refused, not partially trusted", () => {
  const root = mkdtempSync(join(tmpdir(), "plan-torn-"));
  mkdirSync(join(root, PLAN_DIR), { recursive: true });
  const full = JSON.stringify(planOf([moduleOf()]), null, 2);
  writeFileSync(join(root, PLAN_DIR, PLAN_STATE_FILE), full.slice(0, Math.floor(full.length / 2)), "utf8");
  const result = readPlanState(root);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /not valid JSON/);
});

test("renderPlan is a projection: every module and counter is visible without parsing state", () => {
  const view = renderPlan(planOf([moduleOf({ status: "blocked", blocked_rounds: 4, result: "needs a seam" })], {
    status: "verifying",
    verify_round: 3,
    integration_blocked_rounds: 2,
  }));
  assert.match(view, /status: \*\*verifying\*\*/);
  assert.match(view, /verify round: 3/);
  assert.match(view, /integration blocked rounds: 2/);
  assert.match(view, /\| M-01 \| blocked \|/);
  assert.match(view, /needs a seam/);
});

test("a verify round moves implemented modules into review and bumps the round counter", () => {
  const started = beginVerifyRound(planOf([
    moduleOf({ status: "implemented" }),
    moduleOf({ id: "M-02", owned_paths: ["lib/b.ts"], status: "accepted" }),
  ]));
  assert.equal(started.status, "verifying");
  assert.equal(started.verify_round, 1);
  assert.deepEqual(started.modules.map((m) => m.status), ["reviewing", "accepted"]);
});

test("an aborted round charges the blamed module and rolls every other module back", () => {
  const round = beginVerifyRound(planOf([
    moduleOf({ status: "implemented" }),
    moduleOf({ id: "M-02", owned_paths: ["lib/b.ts"], status: "implemented" }),
  ]));
  const outcome = chargeAbortedRound(round, { blamedModules: ["M-01"] });

  assert.equal(outcome.state.status, "executing", "an abort hands control back to /plan-next");
  assert.deepEqual(outcome.state.modules.map((m) => m.status), ["blocked", "implemented"]);
  assert.equal(outcome.state.modules[0].blocked_rounds, 1);
  assert.equal(outcome.chargedIntegration, false, "a round owned by one module does not charge the run counter");
  assert.deepEqual(outcome.needsHuman, []);

  // The rollback is what makes the next round's step 0 able to re-enter review.
  assert.equal(beginVerifyRound(outcome.state).modules[1].status, "reviewing");
});

test("every failure shape charges a counter — a seam round and a Phase B round both bound the loop", () => {
  const round = beginVerifyRound(planOf([moduleOf({ status: "implemented" })]));

  const seamRound = chargeAbortedRound(round, { blamedModules: [], createdSeam: true });
  assert.equal(seamRound.chargedIntegration, true, "a round whose findings became a seam module must charge the run");
  assert.equal(seamRound.state.integration_blocked_rounds, 1);
  assert.equal(seamRound.state.modules[0].status, "implemented", "an unblamed module rolls back");

  const phaseB = chargeAbortedRound(round, { blamedModules: ["M-01"], phaseB: true });
  assert.equal(phaseB.chargedIntegration, true, "Phase B always charges the run counter");
  assert.equal(phaseB.state.integration_blocked_rounds, 1);
  assert.equal(phaseB.state.modules[0].blocked_rounds, 1, "and the blamed module is charged too");

  // The bound must hold even when the caller (an LLM) forgets to say why the
  // round failed: an abort with nothing charged to a module is, by the
  // assignment rule, a run-level failure.
  const unattributed = chargeAbortedRound(round, { blamedModules: [] });
  assert.equal(unattributed.chargedIntegration, true, "a free abort would make the verify loop unbounded");
  assert.equal(unattributed.state.integration_blocked_rounds, 1);
});

test("a module is charged once per round however many findings it owns", () => {
  const round = beginVerifyRound(planOf([moduleOf({ status: "implemented" })]));
  const outcome = chargeAbortedRound(round, { blamedModules: ["M-01", "M-01"] });
  assert.equal(outcome.state.modules[0].blocked_rounds, 1);
});

test("crossing the human threshold blocks the plan instead of looping forever", () => {
  const round = beginVerifyRound(planOf([moduleOf({ status: "implemented", blocked_rounds: HUMAN_AT })]));
  const outcome = chargeAbortedRound(round, { blamedModules: ["M-01"] });
  assert.deepEqual(outcome.needsHuman, ["M-01"]);
  assert.equal(outcome.state.status, "blocked");
  assert.deepEqual(nextDispatch(outcome.state), {
    kind: "blocked",
    reason: "the plan is blocked and needs a human decision",
  });

  const integration = chargeAbortedRound(
    beginVerifyRound(planOf([moduleOf({ status: "implemented" })], { integration_blocked_rounds: HUMAN_AT })),
    { blamedModules: [], phaseB: true },
  );
  assert.deepEqual(integration.needsHuman, ["<integration>"]);
  assert.equal(integration.state.status, "blocked");
});

test("only a READY Phase B accepts modules, and acceptance is what resets the escalation counter", () => {
  const round = beginVerifyRound(planOf([moduleOf({ status: "implemented", blocked_rounds: 5 })]));
  assert.equal(round.modules[0].status, "reviewing", "Phase A alone never accepts");
  assert.equal(round.modules[0].blocked_rounds, 5);

  const accepted = acceptRound(round);
  assert.equal(accepted.status, "done");
  assert.equal(accepted.modules[0].status, "accepted");
  assert.equal(accepted.modules[0].blocked_rounds, 0);
});

test("escalation raises thinking first, then hands the model tier to the caller", () => {
  assert.equal(escalationFor(moduleOf({ blocked_rounds: ESCALATE_AT - 1 })), undefined);
  assert.deepEqual(escalationFor(moduleOf({ blocked_rounds: ESCALATE_AT, thinking: "medium" })), {
    thinking: "high",
    raiseModelTier: false,
  });
  assert.deepEqual(escalationFor(moduleOf({ blocked_rounds: ESCALATE_AT + 3, thinking: "max" })), {
    thinking: "max",
    raiseModelTier: true,
  });
});

test("dispatch follows the dependency DAG and treats the cursor as a preference, not an authority", () => {
  const plan = planOf([
    moduleOf({ id: "M-01", status: "implemented" }),
    moduleOf({ id: "M-02", owned_paths: ["lib/b.ts"], depends_on: ["M-01"], status: "pending" }),
    moduleOf({ id: "M-03", owned_paths: ["lib/c.ts"], depends_on: ["M-02"], status: "pending" }),
  ], { cursor: "M-03" });

  const next = nextDispatch(plan);
  assert.equal(next.kind, "run");
  assert.equal(next.kind === "run" && next.module.id, "M-02", "a stale cursor must not wedge the run");

  const cursored = nextDispatch({ ...plan, cursor: "M-02" });
  assert.equal(cursored.kind === "run" && cursored.module.id, "M-02");
});

test("blocked modules are re-dispatchable, and a fully implemented plan asks for verification", () => {
  const remediation = nextDispatch(planOf([moduleOf({ status: "blocked", blocked_rounds: 2 })]));
  assert.equal(remediation.kind === "run" && remediation.module.id, "M-01");

  const ready = nextDispatch(planOf([
    moduleOf({ status: "implemented" }),
    moduleOf({ id: "M-02", owned_paths: ["lib/b.ts"], status: "accepted" }),
  ]));
  assert.deepEqual(ready, { kind: "verify" });

  const running = nextDispatch(planOf([moduleOf({ status: "running" })]));
  assert.equal(running.kind, "blocked");
  assert.equal(running.kind === "blocked" && /still running or under review/.test(running.reason), true);
});

test("a finished plan reports done rather than looping", () => {
  assert.deepEqual(nextDispatch(planOf([moduleOf({ status: "accepted" })], { status: "done" })), { kind: "done" });
});
