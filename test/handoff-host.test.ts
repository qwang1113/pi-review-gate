/**
 * The handover reminder as the HOST decides it (D07): which pane gets one at
 * all, and whether it is asked for a paragraph it cannot write.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHandoffHost, type HandoffHostDeps } from "../lib/handoff-host.ts";
import { JUDGE_ID_ENV, JUDGE_OPENER_ENV } from "../lib/judge-pane.ts";
import { WORKER_ID_ENV, WORKER_OPENER_ENV, WORKER_ROLE_ENV } from "../lib/worker-side.ts";
import type { SessionCells } from "../lib/session-cells.ts";
import type { ToolHost } from "../lib/tool-host.ts";

const PANE_ENV = [JUDGE_OPENER_ENV, JUDGE_ID_ENV, WORKER_OPENER_ENV, WORKER_ID_ENV, WORKER_ROLE_ENV];

function reminderIn(env: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), "rg-handoff-host-"));
  const saved = PANE_ENV.map((k) => [k, process.env[k]] as const);
  for (const k of PANE_ENV) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const cells = {
      cwd,
      primaryRepoRoot: cwd,
      state: { sessionId: "sess-1" },
      latestCtx: { getContextUsage: () => ({ tokens: 800, contextWindow: 1000, percent: 80 }) },
    } as unknown as SessionCells;
    const deps = {
      runtimeClocks: () => ({ handedOff: () => false }),
      judgeTaskText: () => undefined,
    } as unknown as HandoffHostDeps;
    const host = createHandoffHost({ registerTool: () => {} } as unknown as ToolHost, cells, deps);
    return host.handoffReminderBlock();
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
