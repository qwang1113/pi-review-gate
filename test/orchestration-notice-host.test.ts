/**
 * THE NOTICE IN A REAL PI HOST — the acceptance run for the delivery fix
 * (lib/orchestrator-runtime-host.ts `superviseTick` + its `message_end` check).
 *
 * Everything that decided the measured defect is real here: pi's own
 * AgentSession (steer queue, one-at-a-time draining, `message_end`
 * replacement), the gate's runtime host loaded as an inline extension, and
 * child channels written as real files under a temp home. Only the model is
 * scripted (pi-ai's faux provider), and it records every context it is sent —
 * that context is what the project manager would actually read.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { appendRecord, nodeChannelIO } from "../lib/channel-io.ts";
import type { ChannelRecord } from "../lib/channel-records.ts";
import { createOrchestratorRuntime, type OrchestratorRuntimeDeps } from "../lib/orchestrator-runtime-host.ts";
import type { ChildSession, OrchestratorRuntime } from "../lib/orchestrator-registry.ts";
import type { SessionHost } from "../lib/session-host.ts";
import type { SupervisionMemory } from "../lib/orchestrator-supervisor.ts";

const ORCH = "orch-notice-host";
const CHILD_ID = "h1-muih4hsa";

async function realHost() {
  const home = mkdtempSync(join(tmpdir(), "notice-host-"));
  const io = nodeChannelIO();
  let clock = Date.now();
  let memory: SupervisionMemory = {};
  let runtime: OrchestratorRuntime = {
    orchestrationId: ORCH,
    children: [{ id: CHILD_ID, taskId: "h1", paneId: "%1", cwd: home } as ChildSession],
  };
  const write = (record: Record<string, unknown>) =>
    appendRecord(io, { orchestrationId: ORCH, childId: CHILD_ID, home }, {
      from: "child", at: new Date(clock).toISOString(), ...record,
    } as ChannelRecord);

  const orchestratorDeps = {
    runtime: () => runtime,
    readPlan: () => ({ plan: { tasks: [{ id: "h1", status: "running" }] }, problems: [] }),
    supervisionMemory: () => memory,
    saveSupervisionMemory: (next: SupervisionMemory) => { memory = next; },
    channelHome: () => home,
    now: () => clock,
    tmux: () => ({ ok: true, stdout: "%1\n", stderr: "" }),
    waitActive: () => false,
    beginWait: () => () => {},
  };

  // The tool the manager is "blocked in" — released by the test.
  let release: () => void = () => {};
  let blocked: () => void = () => {};
  const nextBlock = () => new Promise<void>((r) => { blocked = r; });

  const contexts: string[] = [];
  const faux = createFauxCore({ provider: "faux", api: "faux-api", models: [{ id: "m" }] });
  let tick: () => void = () => {};

  const loader = new DefaultResourceLoader({
    cwd: home,
    agentDir: home,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi: ExtensionAPI) => {
      pi.registerProvider("faux", {
        baseUrl: "http://faux.invalid", apiKey: "x", api: "faux-api",
        models: [{
          id: "m", name: "m", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
        }],
        streamSimple: faux.streamSimple as never,
      });
      pi.registerTool({
        name: "block",
        label: "block",
        description: "blocks until the test releases it",
        parameters: Type.Object({}),
        execute: () => new Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>((resolve) => {
          release = () => resolve({ content: [{ type: "text", text: "released" }], details: {} });
          blocked();
        }),
      });
      const host = {
        state: () => ({ taskMode: "orchestrator" }),
        repos: () => ({ primary: home, cwd: home, all: [home] }),
        ctx: () => undefined,
      } as unknown as SessionHost;
      tick = createOrchestratorRuntime(host, {
        pi,
        orchestratorDeps,
        channelIO: io,
        currentOrchestrationId: () => ORCH,
      } as unknown as OrchestratorRuntimeDeps).superviseTick;
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: home,
    agentDir: home,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(home),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });
  await session.setModel(session.modelRuntime.getModel("faux", "m")!);

  const recordContext = (ctx: { messages: unknown[] }) => { contexts.push(JSON.stringify(ctx.messages)); };
  return {
    session, faux, contexts, write, nextBlock,
    tick: () => tick(),
    release: () => release(),
    advance: (ms: number) => { clock += ms; },
    close: () => { runtime = { ...runtime, children: runtime.children.map((c) => ({ ...c, closedAt: new Date(clock).toISOString() })) }; },
    script: (steps: Array<"block" | "reply">) => faux.setResponses(steps.map((step) => (ctx: { messages: unknown[] }) => {
      recordContext(ctx);
      return fauxAssistantMessage(step === "block" ? fauxToolCall("block", {}) : "ok");
    }) as never),
    notices: () => session.messages.filter((m) => m.role === "custom" && (m as { details?: { kind?: string } }).details?.kind === "orchestration-notice"),
  };
}

test("real host: a question answered while the manager is blocked arrives as ONE expired line; a closed child rings no more", async () => {
  const h = await realHost();
  h.script(["block", "reply"]);
  const firstBlock = h.nextBlock();
  const run = h.session.prompt("supervise");
  await firstBlock;

  h.write({ kind: "request", requestId: "req-a", dialogKind: "select", topic: "tmux-access", title: "允许 tmux？", options: ["是", "否"] });
  h.write({ kind: "state", state: "waiting-input", dialogTitle: "允许 tmux？" });
  // A minute of ticks while the tool blocks: the old timer queued one per re-ring.
  for (let i = 0; i < 8; i++) { h.tick(); h.advance(30_000); }
  h.write({ kind: "request-settled", requestId: "req-a", by: "human" });
  h.write({ kind: "state", state: "working" });
  h.release();
  await run;

  assert.equal(h.notices().length, 1, "one notice was ever queued");
  const after = h.contexts[1]!;
  assert.match(after, /已全部过期/, "the model saw the rewritten notice");
  assert.doesNotMatch(after, /req-a|允许 tmux/, "…and never the settled question");

  // Still unanswered on delivery ⇒ delivered as written, readably.
  h.script(["block", "reply"]);
  const secondBlock = h.nextBlock();
  const second = h.session.prompt("again");
  await secondBlock;
  h.advance(60_000);
  h.write({ kind: "request", requestId: "req-b", dialogKind: "select", topic: "tmux-access", title: "再要一次 tmux", options: ["是", "否"] });
  h.write({ kind: "state", state: "waiting-input", dialogTitle: "再要一次 tmux" });
  h.tick();
  h.release();
  await second;
  const live = h.contexts[3]!;
  assert.match(live, /h1 的 tmux 授权请求在等回答：「再要一次 tmux」/);
  assert.match(live, /childId=h1-muih4hsa，requestId=req-b/);

  // Closed ⇒ nothing, however long we tick.
  h.close();
  const before = h.session.messages.length;
  for (let i = 0; i < 5; i++) { h.advance(120_000); h.tick(); }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.session.messages.length, before, "a closed child injects nothing");
});
