/**
 * BACKGROUND-AGENT WAIT TRACKING — pure-fold tests.
 *
 * The acceptance contract (goal-auditor round 1, verbatim directions):
 *   (a) spawn a background Agent, keep calling OTHER tools, then end the
 *       turn ⇒ still counted as waiting;
 *   (b) a failed launch, or a completed agent ⇒ back to real idle;
 *   (c) several agents where ONE finishes first and the rest keep running
 *       ACROSS turns ⇒ only the finished one is removed, still waiting;
 *   (d) all finished ⇒ real idle.
 * And: NO timeout and NO "new turn clears everything" — the only removal is
 * the agent's own terminal signal, keyed by id.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  foldBackgroundWaits,
  hasBackgroundWaits,
  NO_BACKGROUND_WAITS,
  type BackgroundWaitMessage,
  type BackgroundWaitToolResult,
} from "../lib/background-wait.ts";

/** pi-subagents' own launch wording, as observed in real transcripts. */
function launch(toolName = "Agent", isError = false, runInBackground: boolean | undefined = true): BackgroundWaitToolResult {
  return {
    toolName,
    isError,
    runInBackground,
    text: "Agent started in background. Agent ID: 852ca04f-f5fc-496 Type: flash Description: Gemini 审查 banner 交互 Output file: /tmp/x",
  };
}

function result(toolName: string, text: string, isError = false, runInBackground: boolean | undefined = undefined): BackgroundWaitToolResult {
  return { toolName, isError, runInBackground, text };
}

/** A terminal get_subagent_result report, as pi-subagents formats it. */
function completed(agentId: string, status = "completed"): BackgroundWaitToolResult {
  return result(
    "get_subagent_result",
    `Agent: ${agentId}\nType: flash | Status: ${status} | Tool uses: 13 | 8.0k token\nDescription: x`,
  );
}

function notification(ids: string | string[]): BackgroundWaitMessage {
  const all = Array.isArray(ids) ? ids : [ids];
  const [first, ...rest] = all;
  return {
    customType: "subagent-notification",
    details: { id: first, description: "x", status: "completed", ...(rest.length ? { others: rest.map((id) => ({ id, status: "completed" })) } : {}) },
  };
}

test("(a) a launched background agent counts as waiting, across later tool calls", () => {
  let waits = NO_BACKGROUND_WAITS;
  waits = foldBackgroundWaits(waits, { kind: "tool_result", tool: launch() });
  assert.equal(hasBackgroundWaits(waits), true, "launch starts the wait");

  // The child keeps doing OTHER work after the launch (audit direction a):
  // read, bash, edit — none of them end the wait.
  waits = foldBackgroundWaits(waits, { kind: "tool_result", tool: result("read", "file contents") });
  waits = foldBackgroundWaits(waits, { kind: "tool_result", tool: result("bash", "ok") });
  assert.equal(hasBackgroundWaits(waits), true, "intervening tool calls do not end the wait");
});

test("(b) a failed launch never starts a wait; a completed agent ends it", () => {
  let waits = NO_BACKGROUND_WAITS;
  waits = foldBackgroundWaits(waits, { kind: "tool_result", tool: launch("Agent", true) });
  assert.equal(hasBackgroundWaits(waits), false, "an error result is not a launch");

  waits = foldBackgroundWaits(waits, {
    kind: "tool_result",
    tool: result("Agent", "provider is not configured — the agent could not start", true),
  });
  assert.equal(hasBackgroundWaits(waits), false, "a failed launch starts nothing");

  // A real launch, then the terminal get_subagent_result.
  waits = foldBackgroundWaits(waits, { kind: "tool_result", tool: launch() });
  assert.equal(hasBackgroundWaits(waits), true);
  waits = foldBackgroundWaits(waits, { kind: "tool_result", tool: completed("852ca04f-f5fc-496") });
  assert.equal(hasBackgroundWaits(waits), false, "the agent's own terminal signal ends the wait");
});

test("(b2) a non-terminal poll ('Status: running') does NOT end the wait", () => {
  let waits = NO_BACKGROUND_WAITS;
  waits = foldBackgroundWaits(waits, { kind: "tool_result", tool: launch() });
  waits = foldBackgroundWaits(waits, {
    kind: "tool_result",
    tool: result("get_subagent_result", "Agent: 852ca04f-f5fc-496\nType: flash | Status: running | Tool uses: 3\nAgent is still running. Use wait: true or check back later."),
  });
  assert.equal(hasBackgroundWaits(waits), true, "a running poll is not a terminal signal");
  // A queued agent is not terminal either — it has not started.
  waits = foldBackgroundWaits(waits, {
    kind: "tool_result",
    tool: result("get_subagent_result", "Agent: 852ca04f-f5fc-496\nType: flash | Status: queued | Tool uses: 0"),
  });
  assert.equal(hasBackgroundWaits(waits), true, "queued is not a terminal status");
  waits = foldBackgroundWaits(waits, { kind: "tool_result", tool: completed("852ca04f-f5fc-496", "error") });
  assert.equal(hasBackgroundWaits(waits), false, "an error terminal report still ends the wait");
});

test("(b3) a completed report whose BODY quotes 'Status: running' still ends the wait", () => {
  // The report's own body (the agent's final output) may quote anything — a
  // full-text scan would read this completed agent as still running and hang
  // the wait forever. Only the status LINE decides.
  let waits = NO_BACKGROUND_WAITS;
  waits = foldBackgroundWaits(waits, { kind: "tool_result", tool: launch() });
  waits = foldBackgroundWaits(waits, {
    kind: "tool_result",
    tool: result(
      "get_subagent_result",
      "Agent: 852ca04f-f5fc-496\nType: flash | Status: completed | Tool uses: 5\nDescription: x\n\nI grepped the logs and Status: running never appeared. All good.",
    ),
  });
  assert.equal(hasBackgroundWaits(waits), false, "the status LINE says completed — the body's mention of running is noise");
});

test("(b4) a FOREGROUND agent whose text echoes the launch wording starts no wait", () => {
  // run_in_background: false ⇒ the result is the agent's own inline reply,
  // which may legitimately quote the launch wording back at the caller.
  const waits = foldBackgroundWaits(NO_BACKGROUND_WAITS, {
    kind: "tool_result",
    tool: launch("Agent", false, false),
  });
  assert.equal(hasBackgroundWaits(waits), false, "only a background call can start a wait");
  // The default (run_in_background not passed at all) IS background.
  let background = NO_BACKGROUND_WAITS;
  background = foldBackgroundWaits(background, {
    kind: "tool_result",
    tool: launch("Agent", false, undefined),
  });
  assert.equal(hasBackgroundWaits(background), true, "pi-subagents defaults to background");
});

test("(c) one of several agents finishing removes only it — across turns", () => {
  let waits = NO_BACKGROUND_WAITS;
  waits = foldBackgroundWaits(waits, { kind: "tool_result", tool: launch() }); // id A
  const agentA = waits[0]!;
  waits = foldBackgroundWaits(waits, {
    kind: "tool_result",
    tool: result("Agent", "Nested agent started in background. Agent ID: bb11-a2"),
  });
  const agentB = "bb11-a2";

  // A new turn begins (audit direction c: 跨轮仍有任务运行) — the next
  // launch is exactly the kind of event a fresh turn starts with, and it
  // must not clear the older waits.
  waits = foldBackgroundWaits(waits, {
    kind: "tool_result",
    tool: result("Agent", "Agent started in background. Agent ID: cc33-b3"),
  });
  assert.equal(hasBackgroundWaits(waits), true);
  assert.deepEqual([...waits].sort(), [agentA, agentB, "cc33-b3"].sort());

  // A completes; the others are still waiting.
  waits = foldBackgroundWaits(waits, { kind: "tool_result", tool: completed(agentA) });
  assert.equal(hasBackgroundWaits(waits), true, "the other agents still wait");
  assert.ok(!waits.includes(agentA), "only the finished one is removed");
  assert.ok(waits.includes(agentB) && waits.includes("cc33-b3"));

  // B completes through its notification; C is still waiting.
  waits = foldBackgroundWaits(waits, { kind: "message", message: notification(agentB) });
  assert.equal(hasBackgroundWaits(waits), true);
  assert.ok(waits.includes("cc33-b3"), "C is untouched by B's notification");

  // The group notification finishes C (and names B again — idempotent).
  waits = foldBackgroundWaits(waits, { kind: "message", message: notification([agentB, "cc33-b3"]) });
  assert.equal(hasBackgroundWaits(waits), false, "(d) all finished ⇒ real idle");
});

test("a notification for an unknown id changes nothing; non-notification messages change nothing", () => {
  let waits = NO_BACKGROUND_WAITS;
  waits = foldBackgroundWaits(waits, { kind: "tool_result", tool: launch() });
  const before = waits;
  waits = foldBackgroundWaits(waits, { kind: "message", message: { customType: "subagent-notification", details: { id: "someone-else" } } });
  assert.equal(waits.length, 1, "a stranger's notification does not clear the wait");
  waits = foldBackgroundWaits(waits, { kind: "message", message: { customType: "user-prompt", details: undefined } });
  assert.deepEqual(waits, before, "any other message is not a signal at all");
});

test("a non-Agent tool quoting the launch wording does not start a wait", () => {
  const waits = foldBackgroundWaits(NO_BACKGROUND_WAITS, {
    kind: "tool_result",
    tool: result("bash", "grep found: Agent started in background. Agent ID: fake-1"),
  });
  assert.equal(hasBackgroundWaits(waits), false, "only pi-subagents' own tools start waits");
});

test("a duplicate launch is not recorded twice", () => {
  let waits = NO_BACKGROUND_WAITS;
  waits = foldBackgroundWaits(waits, { kind: "tool_result", tool: launch() });
  waits = foldBackgroundWaits(waits, { kind: "tool_result", tool: launch() });
  assert.equal(waits.length, 1);
});
