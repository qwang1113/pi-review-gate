/**
 * An orchestration child that ran `session_handoff` keeps its channel
 * (2026-09-26, t8 measured: the successor `rg-child-<id>-h1` wrote nothing, the
 * manager saw `pane 已消失` and its instruct never got an ack).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { appendRecord, type ChannelIO } from "../lib/channel-io.ts";
import { projectChannel, readChannel } from "../lib/channel-projection.ts";
import { acknowledgeInstruct, bindingPath, pendingInstructions, reportState, type ChildChannelBinding } from "../lib/orchestrator-child-channel.ts";
import { childSessionId, isOwnedChildPane } from "../lib/orchestrator-delivery.ts";
import { repointChildPanes, type OrchestratorRuntime } from "../lib/orchestrator-registry.ts";
import { relayedPane, superviseChildren } from "../lib/orchestrator-supervisor.ts";
import { isHandoffChainOf, successorSessionId } from "../lib/session-inheritance.ts";

const T0 = 1_700_000_000_000;
const ORCH = "orch-deadbeef-abc";
const HOME = "/home/test";

function memoryIO(now: () => number): ChannelIO {
  const files = new Map<string, string>();
  return {
    ensureDir() { /* implicit */ },
    appendLine(path, line) { files.set(path, (files.get(path) ?? "") + line); },
    readText(path) { return files.get(path); },
    writeText(path, text) { files.set(path, text); },
    now,
  };
}

test("isHandoffChainOf: the root and its -hN successors, nobody else", () => {
  const root = childSessionId("c1");
  assert.ok(isHandoffChainOf(root, root));
  assert.ok(isHandoffChainOf(root, successorSessionId(root, 1)));
  assert.ok(isHandoffChainOf(root, successorSessionId(successorSessionId(root, 1), 2)));
  assert.ok(!isHandoffChainOf(root, "3f0c6a8e-1b2c-4d5e-8f90-123456789abc"), "a subagent's random uuid");
  assert.ok(!isHandoffChainOf(root, successorSessionId(childSessionId("c2"), 1)), "another child's successor");
  assert.ok(!isHandoffChainOf(root, `${root}-h0`));
});

test("the successor pane still owns the child's channel; a subagent still does not", () => {
  assert.ok(isOwnedChildPane("c1", "rg-child-c1-h1"));
  assert.ok(isOwnedChildPane("c1", "rg-child-c1-h2"));
  assert.ok(!isOwnedChildPane("c1", "rg-child-c2-h1"));
  assert.ok(!isOwnedChildPane("c1", "3f0c6a8e-1b2c-4d5e-8f90-123456789abc"));
});

test("after a handover the manager sees the successor's done, in its new pane, and its instruct is acked", () => {
  let now = T0;
  const io = memoryIO(() => now);
  const target = { orchestrationId: ORCH, childId: "c1", home: HOME };
  const predecessor: ChildChannelBinding = { io, target, sessionId: "rg-child-c1", paneId: "%2" };
  const successor: ChildChannelBinding = { io, target, sessionId: "rg-child-c1-h1", paneId: "%9" };

  reportState(predecessor, "working");
  now += 1000;
  appendRecord(io, target, {
    kind: "instruct", from: "orchestrator", at: new Date(now).toISOString(),
    instructId: "ins-1", mode: "steer", text: "探活",
  });
  now += 1000;
  reportState(successor, "working");

  // The successor's own gate drains the instruction and acknowledges it.
  const inbox = pendingInstructions(successor);
  assert.deepEqual(inbox.map((i) => i.instructId), ["ins-1"]);
  acknowledgeInstruct(successor, "ins-1", true);
  assert.equal(projectChannel(readChannel(io, bindingPath(successor)).records).pendingInstructs.length, 0);

  now += 1000;
  reportState(successor, "done");

  // The predecessor pane %2 is gone; only the successor's %9 is alive.
  const runtime: OrchestratorRuntime = {
    orchestrationId: ORCH,
    children: [{ id: "c1", taskId: "t1", paneId: "%2", cwd: "/repo", createdAt: new Date(T0).toISOString() }],
  } as OrchestratorRuntime;
  const snapshot = superviseChildren({
    orchestrationId: ORCH, children: runtime.children, livePanes: new Set(["%9"]), io, home: HOME, at: now,
  });
  assert.equal(snapshot.health[0]!.state, "done", "the successor's report is the child's report");
  assert.equal(snapshot.children[0]!.projection.lastState?.sessionId, "rg-child-c1-h1");
  assert.deepEqual(snapshot.relayed, [{ childId: "c1", paneId: "%9" }]);
  assert.equal(repointChildPanes(runtime, snapshot.relayed).children[0]!.paneId, "%9");
});

test("relayedPane adopts only a live reported pane in place of a dead registered one", () => {
  assert.equal(relayedPane("%2", "%9", new Set(["%9"])), "%9");
  assert.equal(relayedPane("%2", "%9", new Set(["%2", "%9"])), undefined, "registered pane still alive");
  assert.equal(relayedPane("%2", "%9", new Set([])), undefined, "reported pane dead too");
  assert.equal(relayedPane("%2", "%9", undefined), undefined, "tmux unreadable");
  assert.equal(relayedPane("%2", undefined, new Set(["%9"])), undefined, "nothing reported");
  assert.equal(relayedPane("%2", "bogus", new Set(["bogus"])), undefined, "not a pane id");
});
