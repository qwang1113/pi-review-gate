/**
 * AN ORCHESTRATION CHILD'S CONTRACT (2026-10-20, user decision).
 *
 * A child has no loop goal: the gate writes its five-switch record at dispatch
 * (`goal: false`) and copies the plan's intent, the task book and the plan's
 * acceptance checklist into its sidecar. These tests drive the REAL session
 * host (lib/loop-goal-host.ts) with that state, because both answers it gives
 * are load-bearing and neither is visible from a source regex:
 *
 *  - what the reviewer/quality rounds are handed (the plan's intent + the task
 *    book, NOT a goal the child never negotiated), and
 *  - how far the child may ship (the plan's ceiling from `RG_STATION_CAP`;
 *    `undefined` here let a child narrowed to `commit` push and open a PR).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoopGoalHost } from "../lib/loop-goal-host.ts";
import { goalTextHash } from "../lib/loop-goal.ts";
import { emptyState } from "../lib/gate-state.ts";
import { childStagesRecord } from "../lib/loop-stages.ts";
import { ORCHESTRATION_ID_ENV } from "../lib/orchestration-id.ts";
import { STATE_VARIANT_ENV } from "../lib/gate-state-io.ts";
import { STATION_CAP_ENV } from "../lib/repo-pr-policy.ts";
import type { SessionCells } from "../lib/session-cells.ts";

const REPO = "/repo";
const AT = "2026-10-20T00:00:00.000Z";

/** The state a dispatcher writes for one child (lib/child-gate-record.ts). */
function childState(opts: { accepts: boolean }) {
  const state = emptyState("rg-child-t1", 10);
  state.stages = childStagesRecord({ accepts: opts.accepts, at: AT });
  state.childContext = {
    planIntent: "把这轮编排的目标做完",
    acceptancePlan: "起服务 → 调接口 → 比对返回数据",
    taskBrief: "目标：把分页做出来\n代码落点：lib/pagination.ts",
  };
  return state;
}

function host(state = childState({ accepts: false })) {
  const cells = {
    state,
    primaryRepoRoot: REPO,
    cwd: REPO,
    sessionInGit: true,
    repoStateCache: new Map(),
  } as unknown as SessionCells;
  return createLoopGoalHost(cells, {
    stateForRepo: () => state,
    persistRepo: () => {},
    persist: () => {},
    knownRepoRoots: () => [REPO],
    isJudgePane: () => false,
    askMultiChoice: async () => undefined,
    log: () => {},
  });
}

test("the reviewers are handed the plan's intent and the task book — not a goal", () => {
  const text = host().goalTextForReviewers(REPO);
  assert.ok(text, "a child always has a judgement basis: its dispatch record");
  assert.match(text!.text, /本轮所属 plan 的意图/);
  assert.match(text!.text, /把这轮编排的目标做完/);
  assert.match(text!.text, /本任务书/);
  assert.match(text!.text, /lib\/pagination\.ts/);
  assert.equal(text!.truncated, false);
});

test("a child keeps its CEILING when the goal stage is off — \`undefined\` here let a narrowed child publish", () => {
  // A narrowed child of a multi-task repo: the dispatcher wrote `commit`.
  process.env[ORCHESTRATION_ID_ENV] = "orch-deadbeef-abc";
  process.env[STATE_VARIANT_ENV] = "t1";
  process.env[STATION_CAP_ENV] = "commit";
  try {
    assert.equal(host().deliveryStationFor(REPO), "commit");
  } finally {
    delete process.env[ORCHESTRATION_ID_ENV];
    delete process.env[STATE_VARIANT_ENV];
    delete process.env[STATION_CAP_ENV];
  }
});

test("…and a session that is NOT an orchestration child keeps the old reading", () => {
  process.env[STATION_CAP_ENV] = "commit";
  try {
    assert.equal(host().deliveryStationFor(REPO), undefined,
      "a standalone loop session with the goal stage off has no contract at all");
  } finally {
    delete process.env[STATION_CAP_ENV];
  }
});

/* ───────────── the goal question is per repo (2026-10-20) ───────────── */

test("a goal approved in ANOTHER checkout satisfies the session — the primary's empty answer is not the answer", () => {
  // The measured case: work (and the approved goal) live in a `git worktree`
  // beside the repo; the primary checkout changed nothing and has no goal.
  const primary = mkdtempSync(join(tmpdir(), "rg-goal-primary-"));
  const secondary = mkdtempSync(join(tmpdir(), "rg-goal-work-"));
  try {
    const text = "# 任务\n意图：把 worktree 里的改动做完";
    mkdirSync(join(primary, ".pi"), { recursive: true });
    mkdirSync(join(secondary, ".pi"), { recursive: true });
    writeFileSync(join(secondary, ".pi", "loop-goal.md"), text);

    const primaryState = emptyState("s", 10);
    const workState = emptyState("s", 10);
    workState.hasCodeChange = true;
    workState.loopGoal = { hash: goalTextHash(text), at: AT, station: "pr" };

    const cells = {
      state: primaryState,
      primaryRepoRoot: primary,
      cwd: primary,
      sessionInGit: true,
      repoStateCache: new Map([[secondary, workState]]),
      sessionRepos: new Set([primary, secondary]),
    } as unknown as SessionCells;
    const h = createLoopGoalHost(cells, {
      stateForRepo: (root) => (root === secondary ? workState : primaryState),
      persistRepo: () => {},
      persist: () => {},
      knownRepoRoots: () => [primary, secondary],
      isJudgePane: () => false,
      askMultiChoice: async () => undefined,
      log: () => {},
    });

    assert.equal(h.loopGoalConfirmed(primary), false, "the primary never approved a goal");
    assert.equal(h.loopGoalConfirmed(secondary), true, "…and the checkout that did, did");
    assert.equal(h.goalStageSatisfied(secondary), true, "the state is resolved FROM the root, not taken from the primary");
    assert.equal(h.goalSatisfiedForWork(), true,
      "the session-level answer is about the repos this round CHANGED — the question declare_done and the ship gate ask");

    // Nothing changed anywhere ⇒ the primary's own answer, exactly as before.
    const idle = { ...workState, hasCodeChange: false, hasDocChange: false };
    const idleCells = { ...cells, repoStateCache: new Map([[secondary, idle]]) } as unknown as SessionCells;
    const idleHost = createLoopGoalHost(idleCells, {
      stateForRepo: (root) => (root === secondary ? idle : primaryState),
      persistRepo: () => {},
      persist: () => {},
      knownRepoRoots: () => [primary, secondary],
      isJudgePane: () => false,
      askMultiChoice: async () => undefined,
      log: () => {},
    });
    assert.equal(idleHost.goalSatisfiedForWork(), false, "with no work anywhere the primary's (missing) goal decides");
  } finally {
    rmSync(primary, { recursive: true, force: true });
    rmSync(secondary, { recursive: true, force: true });
  }
});
