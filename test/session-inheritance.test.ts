/**
 * WHAT A SUCCESSOR INHERITS — the environment, read back; the brief it is
 * shown; and the id it runs under.
 *
 * The pins that matter are the ones a broken handover produced: the successor
 * must be able to name the session it replaces (its proof of heirship in an
 * occupied worktree), it must be TOLD to read the handoff document first, and
 * its brief must not ask it to close anything — closing is the gate's step,
 * and the old brief's instruction to do it by hand is what left two live
 * sessions behind.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  HANDOFF_DOC_ENV,
  HANDOFF_KIND_ENV,
  MAX_DERIVED_SESSION_ID,
  PREDECESSOR_PANE_ENV,
  PREDECESSOR_SESSION_ENV,
  PREDECESSOR_TRANSCRIPT_ENV,
  formatInheritanceBrief,
  handoffGeneration,
  isHandoffSuccessorOf,
  readInheritance,
  stateOwnership,
  successorEnv,
  successorSessionId,
} from "../lib/session-inheritance.ts";
import { ORCHESTRATION_ID_ENV } from "../lib/orchestration-id.ts";

test("the successor inherits the ADDRESS, the document, the raw record and the kind", () => {
  const env = successorEnv({
    kind: "orchestrator",
    orchestrationId: "orch-abc-1",
    predecessorPane: "%1",
    handoffDoc: ".pi/handoff/abc.md",
    predecessorTranscript: "/sessions/old.jsonl",
  });
  assert.equal(env[ORCHESTRATION_ID_ENV], "orch-abc-1", "the same id ⇒ no child has to be restarted");
  assert.equal(env[PREDECESSOR_PANE_ENV], "%1");
  assert.equal(env[HANDOFF_DOC_ENV], ".pi/handoff/abc.md");
  assert.equal(env[PREDECESSOR_TRANSCRIPT_ENV], "/sessions/old.jsonl");
  assert.equal(env[HANDOFF_KIND_ENV], "orchestrator");

  const ordinary = successorEnv({ kind: "loop", predecessorPane: "%1", handoffDoc: "d.md" });
  assert.ok(!(ORCHESTRATION_ID_ENV in ordinary), "a loop session inherits no orchestration to run");
  assert.ok(!(PREDECESSOR_TRANSCRIPT_ENV in ordinary), "an unknown transcript is omitted, never empty");
  assert.equal(ordinary[PREDECESSOR_PANE_ENV], "%1", "the pane to close is ALWAYS carried");
});

test("the successor carries the id of the session it replaces — its takeover proof", () => {
  // MEASURED (2026-09-10, rebate): a successor arms its gate in the SAME
  // worktree as the session it replaces, and the exclusivity guard refuses a
  // second claimant while the holder's heartbeat is fresh — it refused the
  // successor with a message naming the session that had just handed over.
  // This variable is how the successor says "I am that session's heir"
  // (lib/session-exclusivity.ts), which is why it travels even though the
  // predecessor also releases.
  const env = successorEnv({
    kind: "loop", predecessorPane: "%1", handoffDoc: "d.md",
    predecessorSessionId: "01a08908-a531-7764-876a-9fa512fdfd28",
  });
  assert.equal(env[PREDECESSOR_SESSION_ENV], "01a08908-a531-7764-876a-9fa512fdfd28");
});

test("extra variables ride along, so a kind can carry its mode and state variant", () => {
  const env = successorEnv({
    kind: "child", predecessorPane: "%1", handoffDoc: "d.md",
    extra: { RG_STATE_VARIANT: "child-3", RG_GATE_MODE: "loop" },
  });
  assert.equal(env.RG_STATE_VARIANT, "child-3");
  assert.equal(env.RG_GATE_MODE, "loop");
});

test("inheritance is read back, and blanks are treated as absent", () => {
  assert.deepEqual(
    readInheritance({
      [HANDOFF_KIND_ENV]: "judge",
      [PREDECESSOR_PANE_ENV]: "%1",
      [HANDOFF_DOC_ENV]: " .pi/handoff/a.md ",
      [PREDECESSOR_TRANSCRIPT_ENV]: "   ",
    } as NodeJS.ProcessEnv),
    { kind: "judge", predecessorPane: "%1", handoffDoc: ".pi/handoff/a.md" },
  );
  assert.deepEqual(readInheritance({} as NodeJS.ProcessEnv), {});
  assert.deepEqual(
    readInheritance({ [HANDOFF_KIND_ENV]: "nonsense", [PREDECESSOR_PANE_ENV]: "%1" } as NodeJS.ProcessEnv),
    { predecessorPane: "%1" },
    "an unrecognised kind is dropped, not passed through",
  );
});

test("inheritance goes to the handoff successor of the session the sidecar belongs to — and to nobody else", () => {
  // TWO facts, and each one alone is the wrong answer. The marker says the
  // gate opened this process to replace somebody (`orchestrator_attach` and an
  // ordinary new session carry none, and their behaviour must not change); the
  // sidecar's own sessionId says WHOSE state is on disk, so an approval cannot
  // ride into a session a third session's state happens to be sitting there
  // for.
  const predecessor = "01a08908-a531-7764-876a-9fa512fdfd28";
  const marker = { [PREDECESSOR_SESSION_ENV]: predecessor } as NodeJS.ProcessEnv;

  assert.equal(isHandoffSuccessorOf(marker, predecessor), true, "the predecessor's own successor");
  assert.equal(isHandoffSuccessorOf(marker, "some-other-session"), false,
    "another session's sidecar is not the predecessor's state");
  assert.equal(isHandoffSuccessorOf({} as NodeJS.ProcessEnv, predecessor), false,
    "no marker ⇒ an ordinary new session or a takeover: nothing is inherited");
  assert.equal(isHandoffSuccessorOf(marker, undefined), false, "an ownerless sidecar inherits nothing");
  assert.equal(isHandoffSuccessorOf(marker, "   "), false, "a blank owner is not an owner");
  assert.equal(isHandoffSuccessorOf({ [PREDECESSOR_SESSION_ENV]: "  " } as NodeJS.ProcessEnv, ""), false,
    "a blank marker is not a marker");
});

test("stateOwnership: mine / the predecessor's / somebody else's — one rule, and only these three answers", () => {
  const predecessor = "predecessor-session";
  const own = "this-session";
  const marker = { [PREDECESSOR_SESSION_ENV]: predecessor } as NodeJS.ProcessEnv;

  assert.equal(stateOwnership({} as NodeJS.ProcessEnv, own, own), "mine");
  assert.equal(stateOwnership(marker, own, predecessor), "inherited",
    "the handoff marker AND the sidecar's own owner have to agree");
  assert.equal(stateOwnership(marker, own, "a-third-session"), "foreign",
    "…so a third session's state is never inherited");
  assert.equal(stateOwnership({} as NodeJS.ProcessEnv, own, predecessor), "foreign",
    "no marker ⇒ an ordinary new session or a takeover inherits nothing");
  assert.equal(stateOwnership(marker, own, undefined), "foreign", "an ownerless sidecar belongs to nobody");
  assert.equal(stateOwnership(marker, own, "  "), "foreign", "a blank owner is not an owner");
  assert.equal(stateOwnership({} as NodeJS.ProcessEnv, null, null), "foreign",
    "a session with no id of its own owns nothing");
});

test("the brief sends the successor to the document first, and says who closes the predecessor", () => {
  const brief = formatInheritanceBrief({
    kind: "orchestrator",
    predecessorPane: "%1",
    handoffDoc: ".pi/handoff/a.md",
    predecessorTranscript: "/sessions/old.jsonl",
  }, "orch-abc-1");
  assert.match(brief, /\.pi\/handoff\/a\.md/);
  assert.match(brief, /第一件事就是读它/);
  assert.match(brief, /orch-abc-1/);
  assert.match(brief, /old\.jsonl/);
  assert.match(brief, /交接文档是自述/, "the transcript is offered BECAUSE the handoff is a self-report");
  assert.match(brief, /门禁会在确认你接手后自动关掉它/, "the gate closes it — and the successor is told so");
  assert.doesNotMatch(brief, /orchestrator_close/, "no session is asked to close a predecessor any more");

  assert.equal(formatInheritanceBrief({}), "", "an ordinary session inherits nothing and is told nothing");
});

test("each kind gets its own first action — a judge is not told to attach", () => {
  const judge = formatInheritanceBrief({ kind: "judge", predecessorPane: "%1", handoffDoc: "d.md" });
  assert.match(judge, /这一轮审查/);
  assert.doesNotMatch(judge, /orchestrator_attach/);

  const manager = formatInheritanceBrief({ kind: "orchestrator", predecessorPane: "%1", handoffDoc: "d.md" });
  assert.match(manager, /orchestrator_attach/);
});

test("successor ids are derived from the predecessor, so a chain reads as one line", () => {
  assert.equal(successorSessionId("01a09b18-fb19", 1), "01a09b18-fb19-h1");
  assert.equal(successorSessionId("01a09b18-fb19-h1", 2), "01a09b18-fb19-h2");
  assert.equal(successorSessionId("01a09b18-fb19-h9", 10), "01a09b18-fb19-h10", "the suffix is replaced, never appended twice");
  assert.equal(successorSessionId("", 1), "session-h1", "an empty id still yields something addressable");
  assert.ok(successorSessionId("x".repeat(200), 3).length <= MAX_DERIVED_SESSION_ID);
});

test("the generation is read back from the id itself — no bookkeeping to lose", () => {
  assert.equal(handoffGeneration("01a09b18"), 0);
  assert.equal(handoffGeneration("01a09b18-h1"), 1);
  assert.equal(handoffGeneration("01a09b18-h12"), 12);
  assert.equal(handoffGeneration("01a09b18-hx"), 0);
});
