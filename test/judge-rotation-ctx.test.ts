/**
 * Round 4: a judge pane whose FIRST model fails before any tool ran must still
 * walk its chain. The context the rotation switches through used to be noted
 * by `tool_call` only, so every fallback answered 「没有可用的 ctx」 and none
 * was tried. session_start now notes it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { installJudgeModelRotation } from "../lib/judge-pane-self.ts";
import { createSessionLifecycle, type SessionLifecycleDeps } from "../lib/session-lifecycle.ts";
import type { SessionCells } from "../lib/session-cells.ts";

const CHAIN = ["anthropic/claude-fable-5:max", "anthropic/claude-opus-5:max"];

test("a first-model failure before any tool call switches to the next slot", async () => {
  const cells = { lastUiCtx: { current: undefined }, cwd: "/tmp" } as unknown as SessionCells;
  const setModelCalls: string[] = [];
  const ctx = {
    cwd: "/tmp",
    model: undefined,
    isIdle: () => true,
    ui: { notify: () => {} },
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
  };

  // session_start is the only hook that has run. The rest of its work needs a
  // full host; the context must already be noted before any of it.
  const lifecycle = createSessionLifecycle(cells, new Proxy({}, {
    get: () => { throw new Error("stub host"); },
  }) as unknown as SessionLifecycleDeps);
  await lifecycle.onSessionStart(ctx as never).catch(() => {});
  assert.equal(cells.latestCtx, ctx as never);

  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  const pi = {
    on: (name: string, fn: (event: unknown, ctx?: unknown) => unknown) => { handlers.set(name, fn); },
    setModel: async (model: { provider: string; id: string }) => { setModelCalls.push(`${model.provider}/${model.id}`); return true; },
    setThinkingLevel: () => {},
    sendUserMessage: () => {},
  };
  const logs: string[] = [];
  installJudgeModelRotation(pi as never, cells, "reviewer", {
    freshProjectConfig: () => ({
      agentsGlobal: { reviewer: { auto: false, slots: CHAIN } },
      agentsProject: undefined,
    }) as never,
    childBinding: () => undefined,
    log: (text) => logs.push(text),
  });

  await handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "connect ECONNREFUSED" }] });
  await handlers.get("agent_settled")!({});

  assert.deepEqual(setModelCalls, ["anthropic/claude-opus-5"]);
  assert.ok(logs.some((l) => l.includes("→ anthropic/claude-opus-5")), logs.join("\n"));
  assert.ok(!logs.some((l) => l.includes("没有可用的 ctx")));
});
