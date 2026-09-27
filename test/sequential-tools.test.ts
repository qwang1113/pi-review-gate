// D16 / D44: tools whose effect a sibling call in the same batch depends on
// declare pi's `executionMode: "sequential"` — pi then runs the WHOLE batch in
// source order (pi-agent-core `executeToolCalls`: any sequential tool ⇒ the
// sequential executor).
import test from "node:test";
import assert from "node:assert/strict";
import { registerJudgeSubmitTool } from "../lib/judge-submit-tool.ts";
import { registerGateModeTool } from "../lib/gate-mode-tool.ts";
import { registerRestatementTools } from "../lib/restatement.ts";
import type { ToolHost } from "../lib/tool-host.ts";

test("judge_submit, set_gate_mode and propose_restatement run their batch in order", () => {
  const modes = new Map<string, string | undefined>();
  const host: ToolHost = { registerTool: (d) => { modes.set(d.name, d.executionMode); } };
  registerJudgeSubmitTool(host, {} as never, {} as never);
  registerGateModeTool(host, {} as never, {} as never);
  registerRestatementTools(host, {} as never);
  for (const name of ["judge_submit", "set_gate_mode", "propose_restatement"]) {
    assert.equal(modes.get(name), "sequential", name);
  }
});
