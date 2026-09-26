/**
 * A freshly opened judge whose registration never reached the shared file is
 * not a round: its `judge_conclude` would be refused 「登记表里没有本 review」
 * (measured 2026-09-26). The dispatch closes the pane and says so instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJudgeRoundDispatch } from "../lib/judge-round-dispatch.ts";
import { emptyHierarchy, type HierarchyTable, type JudgeEntry } from "../lib/hierarchy.ts";
import type { SessionHost } from "../lib/session-host.ts";

test("registration not on file ⇒ the new pane is closed and the dispatch fails with a reason", async () => {
  const root = mkdtempSync(join(tmpdir(), "rg-dispatch-"));
  const saved = process.env.TMUX_PANE;
  process.env.TMUX_PANE = "%1";
  try {
    let table: HierarchyTable = emptyHierarchy();
    const closed: JudgeEntry[] = [];
    let opened = false;
    const lines: string[] = [];
    const channelIO = {
      ensureDir: () => {},
      appendLine: (_p: string, line: string) => { lines.push(line); },
      // The pane never reports: an unregistered judge must not be waited on to boot.
      readText: () => "",
    };
    const runTmux = (argv: readonly string[]) => {
      if (argv[0] === "list-sessions") return { ok: true, stdout: "", stderr: "" };
      if (argv[0] === "new-session") { opened = true; return { ok: true, stdout: "@7 %9\n", stderr: "" }; }
      return { ok: true, stdout: "", stderr: "" };
    };
    const host = { stateFor: () => ({}), state: () => ({}), repos: () => ({ cwd: root, primary: root }), log: () => {} } as unknown as SessionHost;
    const { dispatchJudgeRound } = createJudgeRoundDispatch(host, {
      registry: {
        judgeHierarchy: () => table,
        setHierarchy: (next) => { table = next; return false; }, // the lock stayed held by a peer
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
        closeJudgePaneOf: (entry) => { closed.push(entry); },
        reapReviewScratch: () => {},
      },
      reviewTargets: new Map(),
      stageIsOn: () => true,
      runTmux,
      channelIO: channelIO as never,
      tmuxScope: { sessionId: () => "sess-1234567890", repoRoot: () => root, read: () => undefined, write: () => {}, now: () => "t" },
      cancelLedger: { forget: () => {} } as never,
      resolveJudgeLaunch: () => ({ ok: true, sysPromptPath: join(root, "p.md"), spec: "anthropic/x", chain: [], choice: {} as never }),
      sweepStaleJudgeSessionDirs: () => {},
    });
    const t0 = Date.now();
    const out = await dispatchJudgeRound({ root, role: "goal-auditor", title: "audit", task: "judge this", fresh: true });
    assert.ok(opened);
    assert.ok(Date.now() - t0 < 2_000, "closed at once, not after the boot probe");
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /登记表.*没写成.*已关掉/);
    assert.equal(closed.length, 1, "the pane that was opened is closed");
    assert.equal(closed[0]!.paneId, "%9");
    assert.equal(Object.keys(table).length, 0, "and it is not left in the table");
  } finally {
    if (saved === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = saved;
  }
});
