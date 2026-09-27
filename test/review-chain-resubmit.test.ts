/**
 * D03 (2026-09-27), the timing the reviewer caught: `judge_submit` asks
 * `resubmitWhileQualityInFlight` before the chain starts, but the older lane
 * may still be RUNNING then and only fail while this submission waits for it
 * (`waitForQuietLane`). The chain asks again after the wait, before it starts
 * its own lane (which resets `st.precommit`) and before any checkpoint.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewChain } from "../lib/review-chain.ts";

const ROOT = "/tmp/fake-repo";

function makeChain(opts: { fresh?: boolean }) {
  const st = { bypass: { active: false }, precommit: { verdict: "NOT_RUN", mode: "full" } };
  const calls: string[] = [];
  const chain = createReviewChain(
    { stateFor: () => st, persistRepo: () => {} } as never,
    {
      callTool: async (name: string) => { calls.push(name); return { content: [], details: {}, isError: true }; },
      toolText: () => "",
      extractTaskText: (t: string) => t,
      stageIsOn: () => true,
      reviewTargets: new Map(),
      // The older lane lands FAIL while this submission waits for it.
      waitForQuietLane: async () => { st.precommit = { verdict: "FAIL", mode: "full" }; },
      startPrecommitBeside: () => { calls.push("lane"); return { settled: Promise.resolve(), failure: () => undefined, bind: () => {} }; },
      qualityRoundInFlight: () => true,
      buildGoalAuditRound: async () => ({ ok: false, error: "unused" }),
      auditRunDeps: () => ({}) as never,
    } as never,
  );
  return { run: () => chain.submitForReview({ root: ROOT, note: "n", ctx: {}, ...opts }), calls };
}

test("D03: a lane that fails DURING the wait still refuses the re-submission — no lane, no checkpoint", async () => {
  const { run, calls } = makeChain({});
  const out = await run();
  assert.equal(out.ok, false);
  assert.match(out.ok ? "" : out.text, /judge_wait\(\{role:"quality-auditor"\}\)/);
  assert.deepEqual(calls, [], "neither the new lane nor review_checkpoint ran");
});

test("D03: fresh abandons the in-flight quality round and the chain proceeds", async () => {
  const { run, calls } = makeChain({ fresh: true });
  await run();
  assert.deepEqual(calls.slice(0, 2), ["lane", "review_checkpoint"]);
});
