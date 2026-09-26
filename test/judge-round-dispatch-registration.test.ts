/**
 * A judge whose registration never reached the shared file is not a round:
 * its `judge_conclude` would be refused 「登记表里没有本 review」 (measured
 * 2026-09-26). The entry is written BEFORE the pane opens, and a write that
 * does not land means no judge is started at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJudgeRoundDispatch } from "../lib/judge-round-dispatch.ts";
import { emptyHierarchy, type HierarchyTable } from "../lib/hierarchy.ts";
import type { SessionHost } from "../lib/session-host.ts";

async function dispatchWith(writeLands: boolean) {
  const root = mkdtempSync(join(tmpdir(), "rg-dispatch-"));
  const saved = process.env.TMUX_PANE;
  process.env.TMUX_PANE = "%1";
  let table: HierarchyTable = emptyHierarchy();
  let opened = false;
  let onFileWhenOpened: boolean | undefined;
  let onFile: HierarchyTable = emptyHierarchy();
  const state = `${JSON.stringify({ kind: "state", from: "child", at: new Date().toISOString(), state: "idle" })}\n`;
  const runTmux = (argv: readonly string[]) => {
    if (argv[0] === "new-session") {
      opened = true;
      onFileWhenOpened = Object.keys(onFile).length > 0;
      return { ok: true, stdout: "@7 %9\n", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  const host = { stateFor: () => ({}), state: () => ({}), repos: () => ({ cwd: root, primary: root }), log: () => {} } as unknown as SessionHost;
  const { dispatchJudgeRound } = createJudgeRoundDispatch(host, {
    registry: {
      judgeHierarchy: () => table,
      setHierarchy: (next) => { table = next; if (writeLands) onFile = next; return writeLands; },
      dropAudits: () => {},
      callerIdentity: () => "opener",
      paneOwnerIdentity: () => "self",
      absorbJudgeModelEvents: () => {},
      nextJudgeRound: () => 1,
      dropDeadForeignJudges: () => {},
    },
    lanes: {
      resolveJudgeLane: () => ({
        decision: { lane: { objectId: "o", generation: 0 }, rotated: false, reason: "first", roundsInObject: 1 } as never,
        retirePrevious: () => {},
      }),
      rotationCarryoverFacts: () => ({}),
      closeJudgePaneOf: () => {},
      reapReviewScratch: () => {},
    },
    reviewTargets: new Map(),
    stageIsOn: () => true,
    runTmux,
    // The pane "boots" as soon as it is opened: one record above the watermark.
    channelIO: { ensureDir: () => {}, appendLine: () => {}, readText: () => (opened ? state : "") } as never,
    tmuxScope: { sessionId: () => "sess-1234567890", repoRoot: () => root, read: () => undefined, write: () => {}, now: () => "t" },
    cancelLedger: { forget: () => {} } as never,
    resolveJudgeLaunch: () => ({ ok: true, sysPromptPath: join(root, "p.md"), spec: "anthropic/x", chain: [], choice: {} as never }),
    sweepStaleJudgeSessionDirs: () => {},
  });
  try {
    const out = await dispatchJudgeRound({ root, role: "goal-auditor", title: "audit", task: "judge this", fresh: true });
    return { out, opened, onFileWhenOpened, table };
  } finally {
    if (saved === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = saved;
  }
}

test("registration not on file ⇒ no judge is started and the dispatch fails with a reason", async () => {
  const { out, opened } = await dispatchWith(false);
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /登记表.*没写成.*没有启动/);
  assert.equal(opened, false, "no window was opened, so no judge ran against a missing entry");
});

test("the entry is on file BEFORE the judge's window opens, and gains its pane afterwards", async () => {
  const { out, onFileWhenOpened, table } = await dispatchWith(true);
  assert.equal(out.ok, true, out.error);
  assert.equal(onFileWhenOpened, true);
  const entry = Object.values(table)[0]!;
  assert.equal(entry.paneId, "%9");
  assert.equal(entry.windowId, "@7");
  assert.equal(entry.roundSeq, 1);
});
