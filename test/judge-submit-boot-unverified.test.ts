/**
 * 2026-09-30 (t4 of the desktop orchestration): the QUALITY pane of a round
 * opened but did not report on its channel within the boot window. The submit
 * returned there, so the reviewer was never dispatched; the failure text read
 * as the reviewer's own, and `judge_wait({role:"reviewer"})` answered "no judge
 * on record" — a self-lock the agent retried into three times with `fresh`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerJudgeSubmitTool, type JudgeSubmitToolDeps } from "../lib/judge-submit-tool.ts";
import { createRoundCancelLedger } from "../lib/round-cancel-ledger.ts";
import type { SessionCells } from "../lib/session-cells.ts";

async function run(qualityDelivered: boolean) {
  const dispatched: string[] = [];
  const cancelled: string[] = [];
  let execute: ((...a: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }>) | undefined;
  const deps = {
    resolveToolRepo: () => ({ ok: true, root: "/tmp/fake-repo" }),
    stateForRepo: () => ({ precommit: { verdict: "NOT_RUN", mode: "full" } }),
    qualityRoundInFlight: () => false,
    persistRepo: () => {},
    stageIsOn: () => true,
    submitForReview: async () => ({
      ok: true,
      role: "quality-auditor",
      taskText: "quality task",
      parallelReviewer: { taskText: "reviewer task" },
      laneFailure: () => undefined,
    }),
    dispatchJudgeRound: async ({ role }: { role: string }) => {
      dispatched.push(role);
      if (role === "quality-auditor") {
        return { ok: false, reused: false, delivered: qualityDelivered, judgeId: "j-q", paneId: "%31", sessionDir: "/tmp/s", error: "通道里一条记录都没有" };
      }
      return { ok: true, reused: false, judgeId: `j-${role}`, paneId: "%40", sessionDir: "/tmp/s" };
    },
    cancelJudgeRound: (_root: string, role: string) => { cancelled.push(role); return "stopped"; },
    cancelLedger: createRoundCancelLedger(),
    noteQualityRoundDispatched: () => {},
    registry: { pendingAudits: new Map(), persistJudgeHierarchy: () => {} },
  } as unknown as JudgeSubmitToolDeps;
  registerJudgeSubmitTool(
    { registerTool: (d: { execute: typeof execute }) => { execute = d.execute; } } as never,
    { sessionInGit: true } as SessionCells,
    deps,
  );
  const reply = await execute!("id", { role: "reviewer", task: "change" }, undefined, undefined, {});
  return { reply, dispatched, cancelled };
}

test("a quality pane whose boot record is late still counts as dispatched — the reviewer starts beside it", async () => {
  const { reply, dispatched, cancelled } = await run(true);
  assert.deepEqual(dispatched, ["quality-auditor", "reviewer"]);
  assert.deepEqual(cancelled, []);
  assert.notEqual(reply.isError, true);
  const text = reply.content[0]!.text;
  assert.match(text, /quality-auditor: pane %31 .*启动未确认/);
  assert.match(text, /reviewer: pane %40/);
});

test("a dispatch that reached no judge fails the round and names the role that failed", async () => {
  const { reply, dispatched } = await run(false);
  assert.deepEqual(dispatched, ["quality-auditor"]);
  assert.equal(reply.isError, true);
  assert.match(reply.content[0]!.text, /quality-auditor 没派出去/);
});
