/**
 * Bug 1 of the 2026-09-29 wake storm, in the shape it was measured: a judge
 * that already HANDED IN its round, whose pane is alive and whose heartbeat
 * keeps the channel fresh, held its opener in a hosted wait for 40 hours —
 * one `REVIEW_GATE_CHILD_HOST_WAIT` a minute, a WATCHDOG between them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createL2Continuation, type L2ContinuationDeps } from "../lib/l2-continuation.ts";
import { createSessionCells } from "../lib/session-cells.ts";
import { createWakeGovernor } from "../lib/wake-governor.ts";
import type { JudgeEntry } from "../lib/hierarchy.ts";

// The gate reads its OWN role off the environment (a judge pane skips the
// loop entirely), and these tests may run inside a judge or acceptance pane:
// run them as a plain session, whatever launched the suite.
const gateEnv = Object.keys(process.env).filter((k) => k.startsWith("RG_"));
const savedEnv = Object.fromEntries(gateEnv.map((k) => [k, process.env[k]]));
test.before(() => { for (const k of gateEnv) delete process.env[k]; });
test.after(() => { Object.assign(process.env, savedEnv); });

function harness(opts: { reported: boolean; lastActivity?: string }) {
  const cells = createSessionCells(mkdtempSync(join(tmpdir(), "l2-")));
  cells.state.taskMode = "loop";
  cells.state.hasCodeChange = true; // review PENDING ⇒ the gate is unmet
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (text: string) => { sent.push(text); },
    sendMessage: () => { sent.push("<custom>"); },
  };
  const judge: JudgeEntry = {
    judgeId: "rg-goal-auditor-x", openerId: "opener", role: "goal-auditor", repoRoot: cells.cwd,
    title: "goal-auditor", sessionDir: "/nowhere", paneId: "%5",
    spawnedAt: new Date(Date.now() - 3_600_000).toISOString(),
  } as JudgeEntry;
  const deps: L2ContinuationDeps = {
    pi,
    childSide: { reportChildState: () => {}, noteChildProgress: () => {}, drainChildInstructions: async () => {} },
    registry: {
      ownJudges: () => [judge],
      ownLiveJudges: () => [judge],
      judgeRoundReported: () => opts.reported,
      listServerPanesForThisSession: () => ["%5"],
      // The heartbeat keeps it fresh — exactly what defeated the silence bound.
      channelLastActivity: () => opts.lastActivity ?? new Date().toISOString(),
    },
    settleFinishedRounds: async () => false,
    runtime: () => ({
      handedOff: () => false,
      orchestratorSettled: () => {},
      startRevivalTimer: () => {},
      wakeProgressKey: () => "same-facts",
    }),
    wakes: createWakeGovernor({ pi, notify: () => {} }),
    goalStageSatisfied: () => true,
    copilotProblemsAcrossRepos: () => [],
    updateWidget: () => {},
    persist: () => {},
  };
  const l2 = createL2Continuation(cells, deps);
  const ctx = { isIdle: () => true, ui: { notify: () => {} } } as unknown as ExtensionContext;
  return { cells, sent, l2, ctx };
}

test("a judge that already reported is not hosted: no HOST_WAIT, no WATCHDOG armed", async () => {
  const { cells, sent, l2, ctx } = harness({ reported: true });
  await l2.onAgentSettled(ctx);
  assert.equal(sent.some((t) => t.includes("REVIEW_GATE_CHILD_HOST_WAIT")), false, sent.join("\n---\n"));
  assert.equal(cells.childWaitTimer, undefined, "no watchdog is left to re-wake the session");
  l2.cancelChildWaitTimer();
});

test("an ALIVE judge silent past the bound is announced through the governor, not on every settle", async () => {
  // Its last progress is an hour old (one long tool call, or a question
  // waiting on a human) while its pane lives: the announcement must not
  // repeat on every settle over the same fact.
  const { sent, l2, ctx } = harness({ reported: false, lastActivity: new Date(Date.now() - 3_600_000).toISOString() });
  for (let i = 0; i < 5; i++) await l2.onAgentSettled(ctx);
  assert.equal(sent.filter((t) => t.includes("REVIEW_GATE_CHILD_ENDED")).length, 1, sent.join("\n---\n"));
  l2.cancelChildWaitTimer();
});

test("a judge genuinely in flight is still hosted — through the governor", async () => {
  const { cells, sent, l2, ctx } = harness({ reported: false });
  await l2.onAgentSettled(ctx);
  assert.equal(sent.filter((t) => t.includes("REVIEW_GATE_CHILD_HOST_WAIT")).length, 1);
  // A second settle right away is inside the governor's gap: nothing sent,
  // a watchdog armed for when it may speak again.
  await l2.onAgentSettled(ctx);
  assert.equal(sent.filter((t) => t.includes("REVIEW_GATE_CHILD_HOST_WAIT")).length, 1);
  assert.notEqual(cells.childWaitTimer, undefined);
  l2.cancelChildWaitTimer();
});
