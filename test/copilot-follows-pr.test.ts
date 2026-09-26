/**
 * COPILOT FOLLOWS WHOEVER OPENED THE PR (2026-09-27, user decision): the
 * Copilot loop is armed by the gate's own observation of a successful
 * PR-affecting ship, never by the acceptance switch — a task whose plan
 * switched acceptance off still owes the Copilot cycle for a PR it opened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ACCEPTANCE_GATE_ENV } from "../lib/acceptance-round.ts";
import { createSessionCells } from "../lib/session-cells.ts";
import { createToolResultHook } from "../lib/tool-event-hooks.ts";
import { git } from "./helpers/git.ts";

test("a successful PR creation arms Copilot even with the acceptance gate closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-copilot-follows-"));
  const saved = process.env[ACCEPTANCE_GATE_ENV];
  process.env[ACCEPTANCE_GATE_ENV] = "off:a1";
  try {
    git(dir, ["init", "-q"]);
    const cells = createSessionCells(dir);
    cells.state.taskMode = "loop";
    cells.projectConfig.copilotReview.enabled = true;
    const hook = createToolResultHook(cells, {
      childSide: { noteChildProgress: () => {}, observeBackgroundToolResult: () => {} },
      isJudgePane: () => false,
      judgeCurrentRound: () => undefined,
      judgeOwnPaths: () => [],
      goalStageSatisfied: () => true,
      stateForRepo: () => cells.state,
      persistRepo: () => {},
      onEditResult: () => undefined,
    });
    const command = ["gh", "pr", "create", "--title", "t", "--body", "b"].join(" ");
    await hook(
      { toolName: "bash", input: { command }, content: [], isError: false } as never,
      {} as never,
    );
    assert.equal(cells.state.copilot?.status, "ARMED", "the PR's opener owes the Copilot cycle");
  } finally {
    if (saved === undefined) delete process.env[ACCEPTANCE_GATE_ENV];
    else process.env[ACCEPTANCE_GATE_ENV] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
