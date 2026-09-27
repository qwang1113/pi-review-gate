/**
 * The handover reminder as the HOST decides it (D07): which pane gets one at
 * all, and whether it is asked for a paragraph it cannot write.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHandoffHost, type HandoffHostDeps } from "../lib/handoff-host.ts";
import { JUDGE_ID_ENV, JUDGE_OPENER_ENV } from "../lib/judge-pane.ts";
import { WORKER_ID_ENV, WORKER_OPENER_ENV, WORKER_ROLE_ENV } from "../lib/worker-side.ts";
import type { SessionCells } from "../lib/session-cells.ts";
import type { ToolHost } from "../lib/tool-host.ts";

const PANE_ENV = [JUDGE_OPENER_ENV, JUDGE_ID_ENV, WORKER_OPENER_ENV, WORKER_ID_ENV, WORKER_ROLE_ENV];

type Host = ReturnType<typeof createHandoffHost>;
type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> };

function reminderIn(env: Record<string, string>): string {
  return withHost(env, ({ host }) => host.handoffReminderBlock());
}

function withHost<T>(env: Record<string, string>, body: (h: { host: Host; tools: Tool[]; cwd: string }) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), "rg-handoff-host-"));
  const saved = PANE_ENV.map((k) => [k, process.env[k]] as const);
  for (const k of PANE_ENV) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const cells = {
      cwd,
      primaryRepoRoot: cwd,
      state: { sessionId: "sess-1" },
      latestCtx: {
        getContextUsage: () => ({ tokens: 800, contextWindow: 1000, percent: 80 }),
        sessionManager: { getSessionDir: () => join(cwd, "sessions") },
      },
    } as unknown as SessionCells;
    const deps = {
      runtimeClocks: () => ({ handedOff: () => false }),
      judgeTaskText: () => undefined,
    } as unknown as HandoffHostDeps;
    const tools: Tool[] = [];
    const host = createHandoffHost({ registerTool: (t: Tool) => { tools.push(t); } } as unknown as ToolHost, cells, deps);
    return body({ host, tools, cwd });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("D07: a worker pane is never reminded to hand over — it has no successor path", () => {
  assert.equal(reminderIn({ [WORKER_OPENER_ENV]: "o", [WORKER_ID_ENV]: "w", [WORKER_ROLE_ENV]: "worker" }), "");
});

test("D07: a judge pane is reminded, but never asked for the paragraph it cannot write", () => {
  const judge = reminderIn({ [JUDGE_OPENER_ENV]: "o", [JUDGE_ID_ENV]: "j" });
  assert.match(judge, /session_handoff\(\)/);
  assert.doesNotMatch(judge, /先把你自己的那一段/);
});

test("D07: an ordinary session is still asked to write its paragraph first", () => {
  assert.match(reminderIn({}), /先把你自己的那一段/);
});

test("D07: a worker pane's session_handoff is refused before any document or pane exists", async () => {
  const env = { [WORKER_OPENER_ENV]: "o", [WORKER_ID_ENV]: "w", [WORKER_ROLE_ENV]: "worker" };
  const text = await withHost(env, async ({ tools }) => {
    const tool = tools.find((t) => t.name === "session_handoff");
    assert.ok(tool);
    return (await tool.execute("id", {})).content[0]!.text;
  });
  assert.match(text, /worker pane 不交接/);
});

test("D06: the host's transcript pointer is the `<ts>_<id>.jsonl` file that exists", () => {
  withHost({}, ({ host, cwd }) => {
    mkdirSync(join(cwd, "sessions"), { recursive: true });
    const file = join(cwd, "sessions", "2026-09-27T00-00-00-000Z_sess-1.jsonl");
    writeFileSync(file, "");
    assert.equal(host.ownTranscriptPath(), file);
  });
});
