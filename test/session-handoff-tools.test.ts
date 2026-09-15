/**
 * THE ONE HANDOVER TOOL — the chain after the agent says "hand over".
 *
 * The failures this pins are the ones the old path actually produced: a bare
 * successor that was never told to read anything, a predecessor left alive
 * because closing it was somebody's remembered chore, and a handover that
 * half-happened (pane never opened) while the predecessor had already given up
 * its worktree claim.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  handoffDocPath,
  handoffExtraEnvFor,
  registerContextStatusTool,
  runSessionHandoff,
  successorOpeningMessage,
  type SessionHandoffDeps,
} from "../lib/session-handoff-tools.ts";
import { STATE_VARIANT_ENV } from "../lib/gate-state.ts";
import { ORCHESTRATION_ID_ENV } from "../lib/orchestration-id.ts";
import { GATE_MODE_ENV } from "../lib/task-mode.ts";
import { STATION_CAP_ENV } from "../lib/repo-pr-policy.ts";
import { HANDOFF_FILL_PLACEHOLDER } from "../lib/session-handoff.ts";

function fakeDeps(overrides: Partial<SessionHandoffDeps> = {}): {
  deps: SessionHandoffDeps;
  files: Map<string, string>;
  events: string[];
} {
  const files = new Map<string, string>();
  const events: string[] = [];
  const base: SessionHandoffDeps = {
    kind: () => "loop",
    sessionId: () => "session-1",
    ownPane: () => "%5",
    repoRoot: () => "/repo",
    transcriptPath: () => "/sessions/session-1.jsonl",
    docPath: (id) => handoffDocPath("/repo", id),
    docFacts: () => ({ contract: "goal: 修好交接", outstanding: ["未提交改动：lib/x.ts"] }),
    writeText: (path, text) => { files.set(path, text); },
    readText: (path) => files.get(path),
    openSuccessor: async () => { events.push("open"); return { ok: true, paneId: "%9" }; },
    retire: () => ({
      committed: () => events.push("committed"),
      rolledBack: () => events.push("rolledBack"),
    }),
    now: () => Date.parse("2026-09-14T00:00:00.000Z"),
    ...overrides,
  };
  return { deps: base, files, events };
}

test("a handover writes the document, opens the successor, then goes silent — in that order", async () => {
  const { deps, files, events } = fakeDeps();
  const receipt = await runSessionHandoff(deps);
  assert.equal(receipt.isError, undefined, receipt.content[0]!.text);

  const docPath = handoffDocPath("/repo", "session-1");
  const doc = files.get(docPath);
  assert.ok(doc, "the skeleton is written before the successor is told to read it");
  assert.match(doc!, /goal: 修好交接/);
  assert.match(doc!, /- 未提交改动：lib\/x\.ts/);
  assert.match(doc!, /\/sessions\/session-1\.jsonl/);

  assert.deepEqual(events, ["open", "committed"], "retire happens before the open, silence only after it succeeded");
  assert.match(receipt.content[0]!.text, /%9/);
  assert.match(receipt.content[0]!.text, /session-1-h1/, "the successor id is derived from ours");
  assert.match(receipt.content[0]!.text, /只读静默/);
  assert.match(receipt.content[0]!.text, /补充段还是占位/, "the receipt says the agent's half is still missing");
});

test("the successor's FIRST MESSAGE points at the document, and its ENV carries the mode", async () => {
  const { deps } = fakeDeps();
  let command: readonly string[] = [];
  let env: Readonly<Record<string, string>> = {};
  await runSessionHandoff({
    ...deps,
    extraEnv: () => ({ RG_GATE_MODE: "loop", RG_ORCHESTRATION_ID: "orch-1", RG_STATE_VARIANT: "child-2" }),
    openSuccessor: async (spec) => { command = spec.command; env = spec.env; return { ok: true, paneId: "%9" }; },
  });
  assert.equal(command[0], "pi");
  assert.equal(command[1], "--session-id");
  assert.match(command[3]!, /你是接任者/);
  assert.match(command[3]!, /\.pi\/handoff\/session-1\.md/, "read this first, by path");
  // THE ENV IS PART OF THE CONTRACT, and this is the assertion whose absence let
  // a real bug through: `extraEnv` was spread at the TOP level of the
  // `successorEnv` call, so every one of these keys was dropped and the
  // successor reclassified itself as a plain loop session (reviewer P1,
  // 2026-09-14). A test that only reads the argv cannot see that happen.
  assert.equal(env.RG_GATE_MODE, "loop", "the successor keeps the predecessor's mode");
  assert.equal(env.RG_ORCHESTRATION_ID, "orch-1", "and the orchestration it belongs to");
  assert.equal(env.RG_STATE_VARIANT, "child-2", "and its own gate sidecar variant");
  assert.equal(env.RG_HANDOFF_PREDECESSOR_PANE, "%5", "alongside everything the handover itself carries");
  assert.match(successorOpeningMessage("/repo/.pi/handoff/x.md", "orchestrator"), /orchestrator_attach/);
  assert.doesNotMatch(successorOpeningMessage("/repo/.pi/handoff/x.md", "loop"), /orchestrator_attach/);
});

test("a pane that cannot be opened rolls the retirement back and names the failure", async () => {
  const { deps, events } = fakeDeps({
    openSuccessor: async () => { events.push("open"); return { ok: false, error: "no space for new pane" }; },
  });
  const receipt = await runSessionHandoff(deps);
  assert.equal(receipt.isError, true);
  assert.match(receipt.content[0]!.text, /no space for new pane/);
  assert.match(receipt.content[0]!.text, /你仍然是持有者/);
  assert.deepEqual(events, ["open", "rolledBack"], "phase one is undone; phase two never ran");
});

test("a throw from the pane layer is a rollback too, not a half-retired session", async () => {
  const { deps, events } = fakeDeps({
    openSuccessor: async () => { throw new Error("tmux runner exploded"); },
  });
  const receipt = await runSessionHandoff(deps);
  assert.equal(receipt.isError, true);
  assert.match(receipt.content[0]!.text, /tmux runner exploded/);
  assert.deepEqual(events, ["rolledBack"]);
});

test("no session id or no pane is a refusal, never a silent no-op", async () => {
  const noId = await runSessionHandoff(fakeDeps({ sessionId: () => undefined }).deps);
  assert.equal(noId.isError, true);
  assert.match(noId.content[0]!.text, /没有 session id/);

  const noPane = await runSessionHandoff(fakeDeps({ ownPane: () => undefined }).deps);
  assert.equal(noPane.isError, true);
  assert.match(noPane.content[0]!.text, /tmux pane/);
});

test("an existing document is left alone — the agent's paragraph survives a second call", async () => {
  const { deps, files } = fakeDeps();
  const docPath = handoffDocPath("/repo", "session-1");
  files.set(docPath, "# 会话交接\n\n" + HANDOFF_FILL_PLACEHOLDER.replace(HANDOFF_FILL_PLACEHOLDER, "我自己写的补充"));
  await runSessionHandoff(deps);
  assert.match(files.get(docPath)!, /我自己写的补充/, "the tool never overwrites what the agent wrote");
});

/** A bare host that keeps whatever is registered — enough to drive a tool. */
function collectingHost(): {
  host: Parameters<typeof registerContextStatusTool>[0];
  tools: Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown>; isError?: boolean }> }>;
} {
  const tools = new Map();
  const host = { registerTool: (def: { name: string }) => { tools.set(def.name, def); } };
  return { host: host as unknown as Parameters<typeof registerContextStatusTool>[0], tools };
}

test("context_status hands the session its OWN reading — the number and the verdict", async () => {
  // The requirement (2026-09-14): a session must never again budget against a
  // context it guessed at. Two facts in one call, and a missing reading stays
  // missing rather than becoming reassurance.
  const room = collectingHost();
  registerContextStatusTool(room.host, {
    usage: () => ({ tokens: 358_000, contextWindow: 1_000_000, percent: 35.8 }),
    docPath: () => ".pi/handoff/abc.md",
  });
  const tool = room.tools.get("context_status");
  assert.ok(tool, "the tool is registered under the name the reminder uses");
  const out = await tool!.execute("call-1", {});
  assert.match(out.content[0]!.text, /35\.8%/);
  assert.equal(out.details?.tokens, 358_000);
  assert.equal(out.details?.contextWindow, 1_000_000);
  assert.equal(out.details?.handoffDue, false);

  const full = collectingHost();
  registerContextStatusTool(full.host, { usage: () => ({ tokens: 730_000, contextWindow: 1_000_000 }) });
  const fullOut = await full.tools.get("context_status")!.execute("call-2", {});
  assert.equal(fullOut.details?.handoffDue, true);
  assert.match(fullOut.content[0]!.text, /session_handoff\(\)/);

  const blind = collectingHost();
  registerContextStatusTool(blind.host, {
    usage: () => { throw new Error("host has no usage API"); },
  });
  const blindOut = await blind.tools.get("context_status")!.execute("call-3", {});
  assert.match(blindOut.content[0]!.text, /宿主没有提供读数/);
  assert.equal(blindOut.details?.handoffDue, false);
});

test("handoffExtraEnvFor: the successor keeps the mode, the address and its own variant", () => {
  // These three lines were edited in three consecutive rounds with no test of
  // any kind — one round shipping a claimed-but-absent change that only the
  // diff caught (reviewer P2, 2026-09-14). They are pure and they are here now.
  assert.equal(handoffExtraEnvFor({ kind: "loop", taskMode: "loop" })[GATE_MODE_ENV], "loop");
  assert.equal(handoffExtraEnvFor({ kind: "loop", taskMode: "explore" })[GATE_MODE_ENV], "explore",
    "an explore session's successor does not become a delivery session");
  assert.equal(handoffExtraEnvFor({ kind: "child", taskMode: "normal" })[GATE_MODE_ENV], "normal");
  assert.equal(handoffExtraEnvFor({ kind: "orchestrator", taskMode: "loop" })[GATE_MODE_ENV], "orchestrator",
    "a project manager hands its role over, whatever else it was classified as");
  assert.equal(handoffExtraEnvFor({ kind: "loop" })[GATE_MODE_ENV], "loop", "an unset mode falls back to loop");

  assert.equal(
    handoffExtraEnvFor({ kind: "orchestrator", orchestrationId: "orch-abc-1" })[ORCHESTRATION_ID_ENV],
    "orch-abc-1",
    "the address the caller resolved travels verbatim",
  );
  assert.ok(!(ORCHESTRATION_ID_ENV in handoffExtraEnvFor({ kind: "loop", orchestrationId: "   " })),
    "an absent address is omitted, never passed as blank");
  assert.equal(handoffExtraEnvFor({ kind: "child", stateVariant: "child-3" })[STATE_VARIANT_ENV], "child-3");
  assert.ok(!(STATE_VARIANT_ENV in handoffExtraEnvFor({ kind: "loop" })));

  // THE STATION CEILING RIDES THE RELAY (2026-09-15). It lives in the pane's
  // environment, so a successor that did not receive it would negotiate a goal
  // its plan already ruled out — and push/open the second PR the user forbade.
  assert.equal(handoffExtraEnvFor({ kind: "child", stationCap: "commit" })[STATION_CAP_ENV], "commit");
  assert.ok(!(STATION_CAP_ENV in handoffExtraEnvFor({ kind: "child" })),
    "a session with no ceiling (a standalone loop) passes none on");
  assert.ok(!(STATION_CAP_ENV in handoffExtraEnvFor({ kind: "child", stationCap: "   " })),
    "a blank ceiling is ABSENT, never an empty variable");
});

test("a judge delegates the pane work through `requestSuccession`, and opens nothing itself", async () => {
  const { deps, events } = fakeDeps({
    kind: () => "judge",
    requestSuccession: (docPath, pendingFill) => {
      events.push(`request:${pendingFill}`);
      return { ok: true, detail: `已请 opener 开下一代（${docPath}）` };
    },
    openSuccessor: async () => { events.push("open"); return { ok: true, paneId: "%9" }; },
  });
  const receipt = await runSessionHandoff(deps);
  assert.equal(receipt.isError, undefined);
  assert.deepEqual(events, ["request:true"], "the judge opens nothing: the opener owns its pane");
  assert.match(receipt.content[0]!.text, /请停下/);
});
