import test from "node:test";
import assert from "node:assert/strict";

import {
  HANDOFF_PATH_ENV,
  MIN_HANDOFF_CHARS,
  PREDECESSOR_PANE_ENV,
  PREDECESSOR_TRANSCRIPT_ENV,
  formatInheritanceBrief,
  predecessorCloseAuthorization,
  readInheritance,
  relayPreconditions,
  successorEnv,
} from "../lib/orchestrator-relay.ts";
import { ORCHESTRATION_ID_ENV } from "../lib/orchestration-id.ts";
import {
  CHILD_WAIT_DEFAULT_MS,
  CHILD_WAIT_MAX_MS,
  clampChildWaitTimeout,
  evaluateChildWait,
} from "../lib/orchestrator-wait.ts";
import type { SupervisionEvent } from "../lib/orchestrator-supervisor.ts";

const READY = {
  planApproved: true,
  handoffPath: "docs/orchestrator-handoff.md",
  handoffChars: MIN_HANDOFF_CHARS + 100,
  ownPane: "%1",
  liveChildCount: 2,
};

// ---------------------------------------------------------------------------
// CONSTRAINT 12 — preconditions
// ---------------------------------------------------------------------------

test("a relay with everything in place is allowed — live children and all", () => {
  assert.deepEqual(relayPreconditions(READY), [],
    "carrying running work across the handover is the POINT of addressing children by orchestration id");
});

test("CONSTRAINT 12: the plan and the handoff must already be on disk", () => {
  assert.ok(relayPreconditions({ ...READY, planApproved: false })
    .some((p) => /plan 未落盘或批准已失效/.test(p)));
  assert.ok(relayPreconditions({ ...READY, handoffPath: undefined })
    .some((p) => /没有交接文档/.test(p)));
  assert.ok(relayPreconditions({ ...READY, handoffChars: undefined })
    .some((p) => /不存在/.test(p)), "a path the agent named but never wrote is not a handoff");
});

test("a handoff document too short to hand anything over is refused", () => {
  const problems = relayPreconditions({ ...READY, handoffChars: MIN_HANDOFF_CHARS - 1 });
  assert.ok(problems.some((p) => /太短了/.test(p)),
    "the successor has to READ it — a stub means it inherits nothing");
});

test("no tmux pane means there is nowhere to put the successor", () => {
  assert.ok(relayPreconditions({ ...READY, ownPane: undefined })
    .some((p) => /tmux pane/.test(p)));
});

test("every problem is reported at once, so one fix round is enough", () => {
  const problems = relayPreconditions({
    planApproved: false, handoffPath: undefined, handoffChars: undefined,
    ownPane: undefined, liveChildCount: 0,
  });
  assert.equal(problems.length, 3);
});

// ---------------------------------------------------------------------------
// What travels, and what the successor may do with it
// ---------------------------------------------------------------------------

test("the successor inherits the ADDRESS, the handoff and the raw record", () => {
  const env = successorEnv({
    orchestrationId: "orch-abc-1",
    predecessorPane: "%1",
    handoffPath: "docs/orchestrator-handoff.md",
    predecessorTranscript: "/sessions/old.jsonl",
  });
  assert.equal(env[ORCHESTRATION_ID_ENV], "orch-abc-1",
    "the same id ⇒ no child has to be restarted");
  assert.equal(env[PREDECESSOR_PANE_ENV], "%1");
  assert.equal(env[HANDOFF_PATH_ENV], "docs/orchestrator-handoff.md");
  assert.equal(env[PREDECESSOR_TRANSCRIPT_ENV], "/sessions/old.jsonl");

  const withoutTranscript = successorEnv({
    orchestrationId: "orch-abc-1", predecessorPane: "%1", handoffPath: "docs/h.md",
  });
  assert.ok(!(PREDECESSOR_TRANSCRIPT_ENV in withoutTranscript),
    "an unknown transcript is omitted rather than passed as an empty pointer");
});

test("inheritance is read back, and blanks are treated as absent", () => {
  assert.deepEqual(
    readInheritance({
      [PREDECESSOR_PANE_ENV]: "%1",
      [HANDOFF_PATH_ENV]: " docs/h.md ",
      [PREDECESSOR_TRANSCRIPT_ENV]: "   ",
    } as NodeJS.ProcessEnv),
    { predecessorPane: "%1", handoffPath: "docs/h.md", predecessorTranscript: undefined },
  );
  assert.deepEqual(readInheritance({} as NodeJS.ProcessEnv),
    { predecessorPane: undefined, handoffPath: undefined, predecessorTranscript: undefined });
});

test("CONSTRAINT 12: ONLY the successor may close the predecessor", () => {
  // This asymmetry is what makes the handover verifiable: a session that can
  // close the old one has demonstrably started and reached a tool call.
  const notASuccessor = predecessorCloseAuthorization("%1", {} as NodeJS.ProcessEnv);
  assert.equal(notASuccessor.ok, false);
  if (!notASuccessor.ok) assert.match(notASuccessor.reason, /不是任何人的接任者/);

  const wrongTarget = predecessorCloseAuthorization("%9", {
    [PREDECESSOR_PANE_ENV]: "%1",
  } as NodeJS.ProcessEnv);
  assert.equal(wrongTarget.ok, false, "a successor may close ITS predecessor, not any orchestrator");
  if (!wrongTarget.ok) assert.match(wrongTarget.reason, /只能关掉自己的前任/);

  assert.deepEqual(
    predecessorCloseAuthorization("%1", { [PREDECESSOR_PANE_ENV]: "%1" } as NodeJS.ProcessEnv),
    { ok: true },
  );
});

test("the predecessor cannot close ITSELF — it has no such variable", () => {
  // The old session going away before the new one is up is exactly the gap
  // the protocol exists to prevent.
  assert.equal(predecessorCloseAuthorization("%1", {
    [ORCHESTRATION_ID_ENV]: "orch-abc-1",
    [HANDOFF_PATH_ENV]: "docs/h.md",
  } as NodeJS.ProcessEnv).ok, false);
});

test("the successor's brief names all three inherited things", () => {
  const brief = formatInheritanceBrief({
    predecessorPane: "%1",
    handoffPath: "docs/h.md",
    predecessorTranscript: "/sessions/old.jsonl",
  }, "orch-abc-1");
  assert.match(brief, /docs\/h\.md/);
  assert.match(brief, /orch-abc-1/);
  assert.match(brief, /old\.jsonl/);
  assert.match(brief, /交接文档是自述/, "the transcript is offered BECAUSE the handoff is a self-report");
  assert.match(brief, /orchestrator_close/, "and it says whose job closing the old pane is");
  assert.equal(formatInheritanceBrief({}), "", "an ordinary orchestrator inherits nothing and is told nothing");
});

// ---------------------------------------------------------------------------
// Wait criteria (§6.3)
// ---------------------------------------------------------------------------

function supervision(summary: string): SupervisionEvent {
  return { childId: "c1", state: "waiting-input", summary };
}

test("a supervision event is the most informative outcome, so it wins", () => {
  const decision = evaluateChildWait({
    events: [supervision("c1 在等回答：「等待回答提问」")], done: true, paneAlive: true,
  });
  assert.equal(decision.done, true);
  assert.equal(decision.reason, "supervision");
  assert.match(decision.summary, /等待回答提问/, "the summary carries what the child actually asked for");
  assert.equal(decision.childId, "c1");
});


test("a finished child does NOT exit — 'done' is an event, not a process end", () => {
  const decision = evaluateChildWait({ done: true, paneAlive: true });
  assert.equal(decision.done, true);
  assert.equal(decision.reason, "child-done");
  assert.match(decision.summary, /仍然活着/,
    "waiting for the process to end here would hang forever — that is why the criteria differ from a judge's");
});

test("a vanished pane ends the wait instead of burning the whole budget", () => {
  const decision = evaluateChildWait({ done: false, paneAlive: false });
  assert.equal(decision.done, true);
  assert.equal(decision.reason, "pane-gone");
  assert.match(decision.summary, /多半没做完/);
});

test("nothing yet is not an end state, and the note becomes the live snapshot", () => {
  const decision = evaluateChildWait({ done: false, paneAlive: true, note: "子会话 a-1 仍在 pane %2" });
  assert.equal(decision.done, false);
  assert.equal(decision.reason, "pending");
  assert.equal(decision.summary, "子会话 a-1 仍在 pane %2");
});

test("the wait budget is clamped to a sane window", () => {
  assert.equal(clampChildWaitTimeout(undefined), CHILD_WAIT_DEFAULT_MS);
  assert.equal(clampChildWaitTimeout("soon"), CHILD_WAIT_DEFAULT_MS);
  // 0 is the SNAPSHOT mode that absorbed `orchestrator_status` — it is passed
  // through rather than clamped up to a 1s busy-poll, and so is anything
  // meaningless-but-non-blocking.
  assert.equal(clampChildWaitTimeout(0), 0);
  assert.equal(clampChildWaitTimeout(-1), 0);

  assert.equal(clampChildWaitTimeout(10 ** 12), CHILD_WAIT_MAX_MS);
  assert.equal(clampChildWaitTimeout(60_000), 60_000);
});
