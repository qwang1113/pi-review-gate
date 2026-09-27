/**
 * D03 (2026-09-27), the timing the reviewer caught: `judge_submit` asks
 * `resubmitWhileQualityInFlight` before the chain starts, but the older lane
 * may still be RUNNING then and only fail while this submission waits for it
 * (`waitForQuietLane`). The chain asks again after the wait, before it starts
 * its own lane (which resets `st.precommit`) and before any checkpoint.
 *
 * N1 (2026-09-27): the checkpoint is asked as a DRY RUN before the lane
 * starts, so a refused checkpoint never starts one; a refusal that still comes
 * later (real checkpoint, prepare) aborts the lane it started.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewChain } from "../lib/review-chain.ts";

const ROOT = "/tmp/fake-repo";

type Step = "dry" | "checkpoint" | "prepare";

function makeChain(opts: {
  fresh?: boolean;
  laneFailsDuringWait?: boolean;
  refuse?: Step;
}) {
  const st = { bypass: { active: false }, precommit: { verdict: "NOT_RUN", mode: "full" } };
  const calls: string[] = [];
  const chain = createReviewChain(
    { stateFor: () => st, persistRepo: () => {} } as never,
    {
      callTool: async (name: string, params: { dryRun?: boolean }) => {
        const step: Step = name === "prepare_review" ? "prepare" : params?.dryRun ? "dry" : "checkpoint";
        calls.push(step);
        return { content: [], details: step === "prepare" ? { prepared: opts.refuse !== "prepare" } : {}, isError: opts.refuse === step };
      },
      toolText: () => "",
      extractTaskText: (t: string) => t,
      stageIsOn: () => true,
      reviewTargets: new Map(),
      waitForQuietLane: async () => {
        // The older lane lands FAIL while this submission waits for it.
        if (opts.laneFailsDuringWait) st.precommit = { verdict: "FAIL", mode: "full" };
      },
      startPrecommitBeside: () => {
        calls.push("lane");
        return {
          settled: Promise.resolve(),
          failure: () => undefined,
          bind: () => {},
          abort: () => { calls.push("abort"); },
        };
      },
      qualityRoundInFlight: () => true,
      buildGoalAuditRound: async () => ({ ok: false, error: "unused" }),
      auditRunDeps: () => ({}) as never,
    } as never,
  );
  return { run: () => chain.submitForReview({ root: ROOT, note: "n", ctx: {}, fresh: opts.fresh }), calls };
}

test("D03: a lane that fails DURING the wait still refuses the re-submission — no lane, no checkpoint", async () => {
  const { run, calls } = makeChain({ laneFailsDuringWait: true });
  const out = await run();
  assert.equal(out.ok, false);
  assert.match(out.ok ? "" : out.text, /judge_wait\(\{role:"quality-auditor"\}\)/);
  assert.deepEqual(calls, [], "neither the new lane nor review_checkpoint ran");
});

test("D03: fresh abandons the in-flight quality round and the chain proceeds to the lane and the checkpoint", async () => {
  const { run, calls } = makeChain({ laneFailsDuringWait: true, fresh: true, refuse: "checkpoint" });
  await run();
  assert.deepEqual(calls.slice(0, 3), ["dry", "lane", "checkpoint"]);
});

test("N1: a checkpoint the dry run refuses never starts the lane", async () => {
  const { run, calls } = makeChain({ fresh: true, refuse: "dry" });
  const out = await run();
  assert.equal(out.ok, false);
  assert.match(out.ok ? "" : out.text, /lane 未启动/);
  assert.deepEqual(calls, ["dry"], "no lane, no real checkpoint");
});

test("N1: a refusal after the lane started aborts that lane", async () => {
  for (const refuse of ["checkpoint", "prepare"] as const) {
    const { run, calls } = makeChain({ fresh: true, refuse });
    const out = await run();
    assert.equal(out.ok, false);
    assert.equal(calls.at(-1), "abort", `${refuse} refused ⇒ the lane is aborted`);
  }
});
