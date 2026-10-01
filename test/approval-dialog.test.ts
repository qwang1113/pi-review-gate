/**
 * THE APPROVAL LADDER (lib/approval-dialog.ts) — the reading every family
 * shares: race the two sides, parse the answer with the one parser, and turn it
 * into the four facts the callers branch on.
 *
 * It exists as one function because it was three copies (quality round,
 * 2026-10-02). The three families' own wording and questions are tested where
 * they live (test/goal-tools.test.ts, test/restatement.test.ts,
 * test/schedule-tools.test.ts); this file pins the decoding itself, especially
 * the three states after "no" that must never collapse into one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { awaitApproval } from "../lib/approval-dialog.ts";
import { REVISE_ROW, type ChoiceSpec } from "../lib/choice-dialog.ts";
import type { ChannelDialogOutcome } from "../lib/orchestrator-child-channel.ts";

const SPEC: ChoiceSpec = {
  title: "review-gate: 试一个框",
  options: ["认可", "不认可"],
  recommended: "认可",
  declineRow: REVISE_ROW,
};

/** One ask: the funnel hands back `outcome`, and the render is a stub. */
function ask(outcome: ChannelDialogOutcome | (() => Promise<never>)) {
  return {
    askEitherSide: async () =>
      typeof outcome === "function" ? outcome() : outcome,
    request: { dialogKind: "select" as const, title: SPEC.title, options: SPEC.options },
    hasUI: true,
    spec: SPEC,
    approveLabel: "认可",
    render: async () => "认可",
  };
}

const outcome = (answer: string | undefined, by: ChannelDialogOutcome["by"], reason?: string): ChannelDialogOutcome => ({
  answer,
  by,
  requestId: "r1",
  ...(reason === undefined ? {} : { reason }),
});

test("the approve label is the only yes; everything else is a refusal", async () => {
  const yes = await awaitApproval(ask(outcome("认可", "human")));
  assert.deepEqual(yes, { approved: true, interrupted: false, dismissed: false });

  const no = await awaitApproval(ask(outcome("不认可", "human")));
  assert.equal(no.approved, false);
  assert.equal(no.reason, undefined, "a bare refusal carries no reason to invent");
});

test("the USER's typed reason beats the channel's — the box they typed into is the one they saw", async () => {
  const typed = await awaitApproval(ask(outcome(`${REVISE_ROW}：需求写错了`, "orchestrator", "通道给的原因")));
  assert.equal(typed.approved, false);
  assert.equal(typed.reason, "需求写错了");

  const channelOnly = await awaitApproval(ask(outcome("不认可", "orchestrator", "通道给的原因")));
  assert.equal(channelOnly.reason, "通道给的原因");
});

test("interrupted and dismissed are NOT a rejection — the three states stay three", async () => {
  const interrupted = await awaitApproval(ask(outcome(undefined, "interrupted")));
  assert.equal(interrupted.approved, false);
  assert.equal(interrupted.interrupted, true);

  const dismissed = await awaitApproval(ask(outcome(undefined, "dismissed")));
  assert.equal(dismissed.approved, false);
  assert.equal(dismissed.interrupted, false);
  assert.equal(dismissed.dismissed, true);
});

test("a funnel that throws reads as 'nobody answered', never as an objection", async () => {
  const thrown = await awaitApproval(ask(async () => { throw new Error("no dialog host"); }));
  assert.deepEqual(thrown, { approved: false, interrupted: false, dismissed: true });
});
