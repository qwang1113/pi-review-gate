/**
 * THE ARBITER'S ROUND (2026-09-29): one more kind on the same engine —
 * dispatch, wait, the one selector — whose conclusion goes back to the caller
 * instead of into gate state. These pin the three things the engine had to
 * learn: hand the report back, record nothing, and leave a goal audit alone.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runVerdictRound } from "../lib/audit-round.ts";
import { settleAuditRound, type AuditRoundEntry, type SettleAuditRoundDeps } from "../lib/audit-round-settle.ts";
import { ARBITER_ROUND_SPEC, specForRound, type PendingAudit } from "../lib/audit-round-specs.ts";
import type { ChannelRecord, ChannelReportRecord } from "../lib/channel-records.ts";
import { recordModelFailure, selectHealthySlot } from "../lib/model-health.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("ONE WAY TO OPEN A MODEL: no one-shot `pi -p` subprocess anywhere in the gate (AGENTS.md)", () => {
  const root = join(import.meta.dirname, "..");
  const offenders: string[] = [];
  for (const dir of ["lib", "extensions"]) {
    for (const name of readdirSync(join(root, dir)).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(root, dir, name), "utf8");
      // `pi -p` (print mode, one shot) in argv form.
      if (/["']pi["'],\s*["']-p["']/.test(src) || /["']-p["'],\s*\.\.\.[A-Z_]*ISOLATION/.test(src)) offenders.push(`${dir}/${name}`);
    }
  }
  assert.deepEqual(offenders, [], "a model decision must run as a judge window (dispatchJudgeRound), not a side process");
});

const NOW = "2026-09-29T12:00:00.000Z";

function report(reportId: string, round: number, verdict: string): ChannelRecord {
  return { kind: "report", from: "child", at: NOW, reportId, round, verdict };
}

function world(records: ChannelRecord[], roundSeq = 3) {
  const state = {
    entry: { judgeId: "arb-1", openerId: "o", role: "arbiter", roundSeq, lastReportId: undefined } as AuditRoundEntry,
    cursors: [] as string[],
    dispatched: [] as string[],
    waitedFor: [] as Array<{ role: string; budgetMs: number }>,
  };
  const deps = {
    dispatch: ({ role, task }: { role: string; task: string }) => {
      state.dispatched.push(`${role}:${task}`);
      return { ok: true as const, judgeId: "arb-1" };
    },
    judgeIdOf: () => "arb-1",
    judgeEntry: () => state.entry,
    readRoundRecords: () => records,
    conclusionOf: (r: ChannelReportRecord) => ({ verdict: r.verdict ?? "", findings: [] }),
    proseOf: () => "A. grant it\nbecause",
    advanceCursor: (_id: string, reportId: string) => {
      state.cursors.push(reportId);
      state.entry = { ...state.entry, lastReportId: reportId };
    },
    nowIso: () => NOW,
    pendingAudit: () => undefined,
    forgetPending: () => {},
    checkpointAt: () => undefined,
    savePlanAudit: () => {},
    log: () => {},
    recordGoal: async () => "x",
    recordReview: async () => "x",
    recordQuality: async () => "x",
    recordAcceptance: async () => "x",
    awaitRoundEnd: async (_root: string, role: string, budgetMs: number) => {
      state.waitedFor.push({ role, budgetMs });
      return { ok: true, detail: "" };
    },
  };
  return { state, deps };
}

test("runVerdictRound hands back THIS round's verdict and notes, and consumes it", async () => {
  const { state, deps } = world([report("r-old", 2, "BLOCKED"), report("r-now", 3, "READY")]);
  const outcome = await runVerdictRound(deps, { spec: ARBITER_ROUND_SPEC, root: "/r", task: "the question", budgetMs: 1234 });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.concluded.verdict, "READY");
  assert.equal(outcome.notes, "A. grant it\nbecause");
  assert.deepEqual(state.dispatched, ["arbiter:the question"]);
  assert.deepEqual(state.waitedFor, [{ role: "arbiter", budgetMs: 1234 }], "the caller's budget, on the arbiter's window");
  assert.deepEqual(state.cursors, ["r-now"]);
});

test("a late report from the PREVIOUS question never answers this one (round-bound)", async () => {
  const { deps } = world([report("r-old", 2, "READY")]);
  const outcome = await runVerdictRound(deps, { spec: ARBITER_ROUND_SPEC, root: "/r", task: "q", budgetMs: 1 });
  assert.equal(outcome.ok, false);
});

test("the wait and the settle sweep see the report but never consume it — the blocked caller does", async () => {
  const { state, deps } = world([report("r-now", 3, "BLOCKED")]);
  // What `judge_wait` / the sweep do when the report lands, before the caller reads it.
  const seen = await settleAuditRound(deps, { judgeId: "arb-1", root: "/r" });
  assert.equal(seen.status, "arbiter");
  assert.deepEqual(state.cursors, [], "nobody but the caller moves the arbiter's cursor");
  const outcome = await runVerdictRound(deps, { spec: ARBITER_ROUND_SPEC, root: "/r", task: "q", budgetMs: 1 });
  assert.equal(outcome.ok && outcome.concluded.verdict, "BLOCKED");
  assert.deepEqual(state.cursors, ["r-now"]);
});

test("no dispatch, no wait, no report \u2014 each is a stated failure, never a verdict", async () => {
  const noDispatch = world([]);
  const refused = await runVerdictRound(
    { ...noDispatch.deps, dispatch: () => ({ ok: false as const, error: "tmux gone" }) },
    { spec: ARBITER_ROUND_SPEC, root: "/r", task: "q", budgetMs: 1 },
  );
  assert.deepEqual(refused, { ok: false, text: ARBITER_ROUND_SPEC.notDispatched("tmux gone") });
  const noWait = world([]);
  const timedOut = await runVerdictRound(
    { ...noWait.deps, awaitRoundEnd: async () => ({ ok: false, detail: "all slots failed: 400" }) },
    { spec: ARBITER_ROUND_SPEC, root: "/r", task: "q", budgetMs: 1 },
  );
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.ok ? "" : timedOut.text, /all slots failed: 400/, "the window's own reason reaches the caller");
});

test("the arbiter's fallback is the judges' own: a cooling first slot dispatches the second", () => {
  // The measured failure: the old `pi -p` side path took slots[0] only, so a
  // model out of quota ended the stand-in outright.
  const chain = ["anthropic/claude-opus-5-5:max", "anthropic/claude-fable-5-1:max"];
  const now = Date.parse(NOW);
  const health = recordModelFailure({}, chain[0]!, now - 1_000, "400 out of extra usage");
  const choice = selectHealthySlot(chain, health, now);
  assert.equal(choice?.spec, chain[1]);
  assert.equal(choice?.skipped.length, 1);
});

test("the settle paths record NOTHING for an arbiter round, and leave a pending goal audit alone", async () => {
  const pending: PendingAudit = { kind: "goal", draft: "d", startedAt: NOW };
  let recorded = 0;
  let forgotten = 0;
  let cursor = 0;
  const deps = {
    judgeEntry: () => ({ judgeId: "arb-1", openerId: "o", role: "arbiter", roundSeq: 3 }),
    readRoundRecords: () => [report("r-now", 3, "READY")],
    conclusionOf: () => ({ verdict: "READY", findings: [] }),
    proseOf: () => "",
    advanceCursor: () => { cursor += 1; },
    pendingAudit: () => pending,
    forgetPending: () => { forgotten += 1; },
    nowIso: () => NOW,
    checkpointAt: () => undefined,
    savePlanAudit: () => { recorded += 1; },
    log: () => {},
    recordGoal: async () => { recorded += 1; return "x"; },
    recordReview: async () => { recorded += 1; return "x"; },
    recordQuality: async () => { recorded += 1; return "x"; },
    recordAcceptance: async () => { recorded += 1; return "x"; },
  } as unknown as SettleAuditRoundDeps;
  const settled = await settleAuditRound(deps, { judgeId: "arb-1", root: "/r" });
  assert.equal(settled.status, "arbiter");
  assert.deepEqual([recorded, forgotten, cursor], [0, 0, 0], "no record, the goal audit's pending kept, the caller owns the cursor");
  // The role decides the spec \u2014 a goal audit in flight does not turn the arbiter into it.
  assert.equal(specForRound("arbiter", "goal"), ARBITER_ROUND_SPEC);
});
