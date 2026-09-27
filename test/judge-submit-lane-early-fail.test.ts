/**
 * t8 (2026-09-27): a precommit lane that lands FAIL before the reviewer is
 * dispatched (a 0.2s test failure lands while the quality pane is still
 * booting) must not leave the reviewer running — measured: ~40s of a reviewer
 * judging content the gate already refuses, until the quality round BLOCKED.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerJudgeSubmitTool, type JudgeSubmitToolDeps } from "../lib/judge-submit-tool.ts";
import { createRoundCancelLedger } from "../lib/round-cancel-ledger.ts";
import type { SessionCells } from "../lib/session-cells.ts";

const ROOT = "/tmp/fake-repo";
const WHY = "全量 precommit 没过（FAIL）—— 这份内容 ship 不了，功能轮不必再审";

/** `failWhen` = the dispatch of this role during which the lane lands FAIL. */
async function run(
  failWhen: "quality-auditor" | "reviewer" | "before",
  opts: { qualityInFlight?: boolean; lastLane?: string; fresh?: boolean } = {},
) {
  let failed: string | undefined = failWhen === "before" ? WHY : undefined;
  let chainRan = false;
  const dispatched: string[] = [];
  const cancelled: string[] = [];
  const ledger = createRoundCancelLedger();
  let execute: ((...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>) | undefined;
  const deps = {
    resolveToolRepo: () => ({ ok: true, root: ROOT }),
    stateForRepo: () => ({ precommit: { verdict: opts.lastLane ?? "NOT_RUN", mode: "full" } }),
    qualityRoundInFlight: () => opts.qualityInFlight === true,
    persistRepo: () => {},
    stageIsOn: () => true,
    submitForReview: async () => {
      chainRan = true;
      return {
        ok: true,
        role: "quality-auditor",
        taskText: "quality task",
        parallelReviewer: { taskText: "reviewer task" },
        laneFailure: () => failed,
      };
    },
    dispatchJudgeRound: async ({ role }: { role: string }) => {
      dispatched.push(role);
      if (role === failWhen) failed = WHY; // the lane lands while this pane opens
      return { ok: true, reused: false, judgeId: `j-${role}`, paneId: "%1", sessionDir: "/tmp/s" };
    },
    cancelJudgeRound: (_root: string, role: string, why: string) => {
      cancelled.push(role);
      ledger.note(ROOT, { role, judgeId: `j-${role}`, why });
      return "stopped";
    },
    cancelLedger: ledger,
    noteQualityRoundDispatched: () => {},
    registry: { pendingAudits: new Map(), persistJudgeHierarchy: () => {} },
  } as unknown as JudgeSubmitToolDeps;
  registerJudgeSubmitTool(
    { registerTool: (d: { execute: typeof execute }) => { execute = d.execute; } } as never,
    { sessionInGit: true } as SessionCells,
    deps,
  );
  const reply = await execute!("id", { role: "reviewer", task: "change", ...(opts.fresh ? { fresh: true } : {}) }, undefined, undefined, {});
  return { reply, dispatched, cancelled, ledger, chainRan };
}

test("D03: lane FAIL lands before the QUALITY dispatch ⇒ neither judge is started, and the receipt says why", async () => {
  const { reply, dispatched, ledger } = await run("before");
  assert.deepEqual(dispatched, [], "a quality round started now would only be interrupted by the re-submission");
  assert.equal(ledger.read(ROOT, "quality-auditor", undefined)?.why, WHY);
  assert.match(reply.content[0]!.text, /质量轮也没派/);
});

test("D03: re-submitting while the failed round's quality judge still judges is refused — fresh overrides", async () => {
  const refused = await run("reviewer", { qualityInFlight: true, lastLane: "FAIL" });
  assert.equal(refused.chainRan, false, "nothing ran: no checkpoint, no lane");
  assert.deepEqual(refused.dispatched, []);
  assert.match(refused.reply.content[0]!.text, /judge_wait\(\{role:"quality-auditor"\}\)/);
  const forced = await run("reviewer", { qualityInFlight: true, lastLane: "FAIL", fresh: true });
  assert.equal(forced.chainRan, true);
  const passed = await run("reviewer", { qualityInFlight: true, lastLane: "PASS" });
  assert.equal(passed.chainRan, true, "a passing lane never holds a re-submission");
});

test("lane FAIL lands before the reviewer's dispatch ⇒ the reviewer is never started", async () => {
  const { reply, dispatched, cancelled, ledger } = await run("quality-auditor");
  assert.deepEqual(dispatched, ["quality-auditor"], "the quality round still runs; the reviewer is not dispatched");
  assert.deepEqual(cancelled, []);
  assert.equal(ledger.read(ROOT, "reviewer", undefined)?.why, WHY, "judge_wait reads the lane's reason");
  const text = reply.content[0]!.text;
  assert.match(text, /reviewer 未派/);
  assert.doesNotMatch(text, /reviewer（judge/, "the reviewer is not listed as accepted");
});

test("lane FAIL lands while the reviewer's pane opens ⇒ cancelled the moment it comes up", async () => {
  const { reply, dispatched, cancelled, ledger } = await run("reviewer");
  assert.deepEqual(dispatched, ["quality-auditor", "reviewer"]);
  assert.deepEqual(cancelled, ["reviewer"]);
  assert.equal(ledger.read(ROOT, "reviewer", undefined)?.why, WHY);
  assert.match(reply.content[0]!.text, /reviewer 未派（或派出即取消）/);
});
