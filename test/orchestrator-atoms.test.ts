/**
 * The ATOMS the orchestration layer rests on, and the rules it got wrong.
 *
 * Everything here is a pure decision: facts in, structure out. The protocol
 * tests (test/orchestrator-tools.test.ts, test/orchestrator-channel.test.ts)
 * prove the tools USE these rules correctly against a simulated world; this
 * file proves the rules themselves, one defect at a time.
 *
 * WHAT LEFT (2026-08-30). Two whole sections — the pane parser and the key
 * planner — are gone with the modules they covered. They existed to make a
 * TERMINAL readable, and a terminal is no longer anybody's interface: a child
 * reports on its channel and is answered through it. Deleting the tests along
 * with the code is the point of philosophy three; keeping them would have
 * meant keeping the code.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChildCommand,
  buildRecoverCommand,
  buildRecoveryNote,
  buildTaskDocument,
  childSessionId,
  deliveryVerdict,
  emptyDeliveryEvidence,
} from "../lib/orchestrator-delivery.ts";
import {
  clampChildWaitTimeout,
  evaluateChildWait,
  CHILD_WAIT_DEFAULT_MS,
  CHILD_WAIT_MAX_MS,
} from "../lib/orchestrator-wait.ts";
import { readFileSync } from "node:fs";
import { orchestratorWriteBlock } from "../lib/orchestrator-gate.ts";
import { childGateFacts } from "../lib/orchestrator-tool-kit.ts";
import { detectOrphans } from "../lib/orchestrator-recovery-tools.ts";
import { emptyRuntime, type OrchestratorRuntime } from "../lib/orchestrator-registry.ts";

import { nextDecisionId, parsePlan } from "../lib/orchestrator-plan.ts";
import { buildOrchestratorExitBlock } from "../lib/orchestrator-directives.ts";
import { sidecarPath, stateVariantFrom, STATE_VARIANT_ENV } from "../lib/gate-state.ts";

// ---------------------------------------------------------------------------
// F7 / F8 — delivery, and the receipt that has to be earned
// ---------------------------------------------------------------------------

test("F7: the task rides in on the argv as pi's own @file reference, under a stable session id", () => {
  const argv = buildChildCommand("/tmp/rg/tasks/rg-task-a-1.md", "a-1");
  assert.deepEqual(argv, ["pi", "--session-id", "rg-child-a-1", "@/tmp/rg/tasks/rg-task-a-1.md"]);
  assert.equal(childSessionId("a-1"), "rg-child-a-1");
  assert.equal(childSessionId("../../etc"), "rg-child-------etc", "an id can never become a path");
});

test("a recovery re-opens the SAME session id, with a note instead of the task", () => {
  const argv = buildRecoverCommand("a-1", "/tmp/rg/tasks/note.md");
  assert.deepEqual(argv, ["pi", "--session-id", "rg-child-a-1", "@/tmp/rg/tasks/note.md"]);
  const note = buildRecoveryNote({ childId: "a-1", taskId: "t1", reason: "pane 消失" });
  assert.match(note, /上面的对话历史就是你自己的/, "the transcript continues — it did not restart");
  assert.match(note, /t1/);
});

test("F8: a spawn is believed on a CHANNEL RECORD, never on having opened a pane", () => {
  const nothing = emptyDeliveryEvidence();
  const refused = deliveryVerdict("spawn", nothing);
  assert.equal(refused.ok, false);
  assert.match((refused as { reason: string }).reason, /不回执「已发送」/);

  assert.equal(deliveryVerdict("spawn", { ...nothing, channelReported: true }).ok, true);
  assert.equal(deliveryVerdict("spawn", { ...nothing, sidecarPresent: true }).ok, true,
    "a sidecar on disk is the weaker but still real fallback");
});

test("F8: an instruction is believed on the child's ACKNOWLEDGEMENT, and a failed one is a failure", () => {
  const base = { channelReported: true, sidecarPresent: true };
  const silent = deliveryVerdict("instruct", base);
  assert.equal(silent.ok, false, "writing to a channel proves only that it was written");
  assert.match((silent as { reason: string }).reason, /一直没有回执/);

  const failed = deliveryVerdict("instruct", { ...base, ack: { delivered: false, detail: "会话已结束" } });
  assert.equal(failed.ok, false);
  assert.match((failed as { reason: string }).reason, /会话已结束/, "the child's own reason is reported verbatim");

  const ok = deliveryVerdict("instruct", { ...base, ack: { delivered: true, detail: "sendUserMessage" } });
  assert.equal(ok.ok, true);
});

test("the task document carries the marker and the brief, and nothing that needs typing", () => {
  const doc = buildTaskDocument({ marker: "rg-task-t1-x", taskId: "t1", title: "任务一", brief: "做这个" });
  assert.match(doc, /rg-task-t1-x/);
  assert.match(doc, /做这个/);
});

// ---------------------------------------------------------------------------
// F14 — the waiter's rules
// ---------------------------------------------------------------------------

test("a supervision event ends the wait and NAMES the child (R-4)", () => {
  const decision = evaluateChildWait({
    events: [{ childId: "c1", state: "waiting-input", summary: "c1 在等回答：「选一个」" }],
    done: false,
    paneAlive: true,
  });
  assert.equal(decision.done, true);
  assert.equal(decision.reason, "supervision");
  assert.equal(decision.childId, "c1", "the old receipt could not answer 'which one of them wants me'");
});

test("F14: liveness that could not be measured keeps the wait alive; a real death ends it", () => {
  const unknown = evaluateChildWait({ done: false, paneAlive: false, livenessUnknown: true });
  assert.equal(unknown.done, false, "an unreadable tmux is not a death certificate");
  assert.match(unknown.summary, /读不到 tmux/);

  const gone = evaluateChildWait({ done: false, paneAlive: false });
  assert.equal(gone.done, true);
  assert.equal(gone.reason, "pane-gone");
});

test("F14: the wait budget is bounded — 300s by default, 900s at most, 0 = snapshot", () => {
  assert.equal(clampChildWaitTimeout(undefined), CHILD_WAIT_DEFAULT_MS);
  assert.equal(CHILD_WAIT_DEFAULT_MS, 300_000);
  assert.equal(clampChildWaitTimeout(30 * 60_000), CHILD_WAIT_MAX_MS);
  assert.equal(CHILD_WAIT_MAX_MS, 900_000, "the old 30-minute ceiling read as a lost session");
  assert.equal(clampChildWaitTimeout(0), 0, "0 is the snapshot mode that absorbed orchestrator_status");
  assert.equal(clampChildWaitTimeout(-5), 0, "a negative budget is a snapshot, never a 1s busy-poll");
});

// ---------------------------------------------------------------------------
// Recovery — the orphan rule
// ---------------------------------------------------------------------------

function runtimeWith(children: OrchestratorRuntime["children"]): OrchestratorRuntime {
  return { ...emptyRuntime("orch-a-b"), children };
}

test("an orphan is a task the plan calls running with no live pane behind it", () => {
  const runtime = runtimeWith([
    { id: "c1", taskId: "t1", paneId: "%2", cwd: "/repo", createdAt: "now" },
  ]);
  const alive = detectOrphans(runtime, ["t1"], new Set(["%2"]));
  assert.equal(alive.length, 0, "a live child is not an orphan");

  const dead = detectOrphans(runtime, ["t1"], new Set());
  assert.equal(dead.length, 1);
  assert.equal(dead[0]!.childId, "c1", "a registered child can be RECOVERED, and the report says so");

  const noChild = detectOrphans(runtime, ["t9"], new Set(["%2"]));
  assert.equal(noChild.length, 1);
  assert.equal(noChild[0]!.childId, undefined, "a task with no child at all can only be re-spawned");
});

test("liveness that could not be read claims NO orphans — missing information is not evidence", () => {
  const runtime = runtimeWith([
    { id: "c1", taskId: "t1", paneId: "%2", cwd: "/repo", createdAt: "now" },
  ]);
  assert.deepEqual(detectOrphans(runtime, ["t1"], undefined), []);
});

// ---------------------------------------------------------------------------
// F2 / F4 / F5 / F13 — the rest
// ---------------------------------------------------------------------------

test("F2: an orchestrator may write OUTSIDE the repo; inside it, the whitelist still holds", () => {
  const orchestrator = { taskMode: "orchestrator" as const };
  assert.equal(
    orchestratorWriteBlock({ ...orchestrator, relPath: "/tmp/report.md", outsideRepo: true }),
    undefined,
    "an out-of-repo path cannot pollute the worktree or enter a checkpoint",
  );
  assert.equal(orchestratorWriteBlock({ ...orchestrator, relPath: ".pi/orchestrator-plan.json" }), undefined);
  assert.equal(orchestratorWriteBlock({ ...orchestrator, relPath: "docs/orchestrator-handoff.md" }), undefined);
  assert.match(
    orchestratorWriteBlock({ ...orchestrator, relPath: "lib/thing.ts" }) ?? "",
    /项目经理不写代码/,
    "code inside the repo is still refused",
  );
  assert.equal(
    orchestratorWriteBlock({ taskMode: "loop", relPath: "lib/thing.ts" }),
    undefined,
    "and none of this applies to an ordinary loop session",
  );
});

test("F4: a sidecar variant gives a session its own file, and cannot escape .pi/", () => {
  assert.equal(sidecarPath("/repo"), "/repo/.pi/review-gate-state.json");
  assert.equal(sidecarPath("/repo", ".pi", "a-1"), "/repo/.pi/review-gate-state.a-1.json");
  assert.equal(
    sidecarPath("/repo", ".pi", "../../etc/passwd"),
    "/repo/.pi/review-gate-state.etc-passwd.json",
    "a traversal attempt lands as a filename, never as a path",
  );
  assert.equal(stateVariantFrom({} as NodeJS.ProcessEnv), undefined);
  assert.equal(stateVariantFrom({ [STATE_VARIANT_ENV]: "  " } as NodeJS.ProcessEnv), undefined);
  assert.equal(stateVariantFrom({ [STATE_VARIANT_ENV]: "a/b" } as NodeJS.ProcessEnv), "a-b");
});


test("F10: what a child has EDITED is readable from its sidecar — constraint 8's real input", () => {
  const deps = {
    childGateState: () => ({
      taskMode: "loop",
      pausedQuestion: { question: "先补测试还是先改实现？", at: "2026-08-29T00:00:00Z" },
      sessionEditedFiles: ["lib/a/one.ts"],
    }),
  } as unknown as Parameters<typeof childGateFacts>[0];
  const facts = childGateFacts(deps, {
    id: "a-1", taskId: "a", paneId: "%2", cwd: "/repo", createdAt: "now", stateVariant: "a-1",
  });
  assert.equal(facts.present, true);
  assert.deepEqual(facts.editedFiles, ["lib/a/one.ts"]);
  assert.ok(facts.lines.some((l) => l.includes("先补测试还是先改实现？")), "and so is an ordinary pause");
});

test("F5: decision ids are minted by the gate and never collide with what is on disk", () => {
  const parsed = parsePlan({
    title: "t", intent: "i",
    tasks: [{ id: "a", title: "a", fileBoundaries: ["lib"] }],
    decisions: [{ id: "d1", question: "q" }, { id: "d7", question: "q" }],
  });
  assert.ok(parsed.ok, parsed.problems.join("; "));
  assert.equal(nextDecisionId(parsed.plan!), "d8", "the highest number wins, not the count");
});

test("F13: an orchestrator's exit block is the PLAN, with no loop-goal or reviewer talk", () => {
  const block = buildOrchestratorExitBlock(["plan 还有 2 个任务未完成"]);
  assert.match(block, /plan 全部做完/);
  assert.match(block, /plan 还有 2 个任务未完成/);
  // It may MENTION the loop contract, but only to say it does not apply — the
  // failure being fixed is an orchestrator being told to go negotiate a goal
  // and submit its (nonexistent) edits for review.
  assert.match(block, /不需要协商 loop goal/);
  assert.match(block, /不需要 `judge_submit`/);
  assert.doesNotMatch(block, /propose_loop_goal/);
  assert.doesNotMatch(block, /改完就送审/, "the loop block's own imperative never reaches this role");

  assert.match(buildOrchestratorExitBlock([]), /没有未决项/);
});
