/**
 * THE DELIVERY PROBE, now shared by three kinds of caller.
 *
 * It used to be an orchestration-only affair: watch a brand-new child's channel
 * until any record appears. Two things changed on 2026-09-05 and both are
 * asserted here, because the change is to a SHARED return semantics:
 *
 *  1. the channel path is passed in (a judge's channel is keyed by
 *     opener+judge, not by orchestration+child), and
 *  2. a WATERMARK exists, because a judge's channel outlives its panes: the
 *     records of previous rounds are still in the file, so "there is a record"
 *     would be true before the new pane ever booted.
 *
 * All three caller categories are exercised: an orchestration spawn (watermark
 * 0, the old meaning exactly), a judge spawn (watermark > 0), and an
 * instruction (acknowledgement, untouched by any of this).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  verifyDeliveryOn,
  verifyJudgeBoot,
  channelRecordCount,
  JUDGE_BOOT_ATTEMPTS,
} from "../lib/orchestrator-tool-kit.ts";
import {
  appendRecord,
  channelPathFor,
  type ChannelIO,
  type ChannelTarget,
} from "../lib/orchestrator-channel.ts";

const TARGET: ChannelTarget = { orchestrationId: "opener-1", childId: "rg-reviewer-abc", home: "/home/test" };
// Derived, never hand-written: the probe and the writer must agree on the path,
// and a literal that drifted from `channelPathFor` would make this whole file
// assert against an empty file it invented.
const PATH = channelPathFor(TARGET.orchestrationId, TARGET.childId, TARGET.home);

function memoryIO(): { io: ChannelIO; files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    io: {
      ensureDir() {},
      appendLine(path, line) { files.set(path, (files.get(path) ?? "") + line); },
      readText(path) { return files.get(path); },
      writeText(path, text) { files.set(path, text); },
      now: () => 1_700_000_000_000,
    },
  };
}

function state(io: ChannelIO, at: string): void {
  appendRecord(io, TARGET, { kind: "state", from: "child", at, state: "working" });
}

test("an orchestration spawn keeps its old meaning: any record at all is proof", async () => {
  const { io } = memoryIO();
  let slept = 0;
  const check = await verifyDeliveryOn(
    {
      channelIO: () => io,
      sleep: async () => { slept++; if (slept === 1) state(io, "2026-09-05T00:00:00.000Z"); },
    },
    { kind: "spawn", channelPath: PATH, attempts: 5 },
  );
  assert.equal(check.verdict.ok, true, "the child reported, so the receipt is earned");
  assert.equal(check.evidence.channelReported, true);
  assert.equal(slept, 1, "it stops at the FIRST evidence instead of burning the budget");
});

test("a silent channel is never a receipt — and the reason says what was not seen", async () => {
  const { io } = memoryIO();
  const check = await verifyDeliveryOn(
    { channelIO: () => io, sleep: async () => {} },
    { kind: "spawn", channelPath: PATH, attempts: 3 },
  );
  assert.equal(check.verdict.ok, false);
  assert.equal(check.evidence.channelReported, false);
  assert.equal(check.evidence.sidecarPresent, false, "a judge writes no sidecar, and none is claimed");
});

test("a judge's OLD rounds are not proof that its new pane booted (the watermark)", async () => {
  const { io } = memoryIO();
  // Two rounds already happened in this judge's channel — the file persists
  // across panes, which is exactly why counting records from zero would report
  // a dead pane as healthy.
  state(io, "2026-09-04T10:00:00.000Z");
  state(io, "2026-09-04T11:00:00.000Z");
  const baseline = channelRecordCount(io, PATH);
  assert.equal(baseline, 2, "the watermark is what the channel held BEFORE the spawn");

  const silent = await verifyJudgeBoot(
    { channelIO: () => io, sleep: async () => {} },
    { channelPath: PATH, baselineRecordCount: baseline, attempts: 3 },
  );
  assert.equal(silent.ok, false, "history is not evidence about the pane just opened");

  let slept = 0;
  const booted = await verifyJudgeBoot(
    {
      channelIO: () => io,
      sleep: async () => { slept++; if (slept === 2) state(io, "2026-09-05T00:00:00.000Z"); },
    },
    { channelPath: PATH, baselineRecordCount: baseline, attempts: 5 },
  );
  assert.equal(booted.ok, true, "a record ABOVE the watermark is");
  assert.match(booted.detail, /通道/, "the receipt says what was observed");
});

test("the judge budget is longer than the orchestration one, and overridable", async () => {
  assert.ok(JUDGE_BOOT_ATTEMPTS > 15, "a judge pane reports on its own heartbeat tick — it is slower to appear");
  const { io } = memoryIO();
  let slept = 0;
  const check = await verifyJudgeBoot(
    { channelIO: () => io, sleep: async () => { slept++; } },
    { channelPath: PATH, baselineRecordCount: 0, attempts: 4 },
  );
  assert.equal(check.ok, false);
  assert.equal(slept, 3, "attempts are attempts: N reads, N-1 sleeps between them");
});

test("an instruction still needs the child's own acknowledgement — nothing about that moved", async () => {
  const { io } = memoryIO();
  appendRecord(io, TARGET, {
    kind: "instruct", from: "orchestrator", at: "2026-09-05T00:00:00.000Z",
    instructId: "ins-1", mode: "interrupt", text: "carry on",
  });
  const queued = await verifyDeliveryOn(
    { channelIO: () => io, sleep: async () => {} },
    { kind: "instruct", channelPath: PATH, instructId: "ins-1", instructMode: "interrupt", attempts: 2 },
  );
  assert.equal(queued.verdict.ok, false, "writing to the channel proves nothing on its own");

  appendRecord(io, TARGET, {
    kind: "instruct-ack", from: "child", at: "2026-09-05T00:00:01.000Z",
    instructId: "ins-1", delivered: true, stage: "injected",
  });
  const acked = await verifyDeliveryOn(
    { channelIO: () => io, sleep: async () => {} },
    { kind: "instruct", channelPath: PATH, instructId: "ins-1", instructMode: "interrupt", attempts: 2 },
  );
  assert.equal(acked.verdict.ok, true);
  assert.equal(acked.evidence.ack?.stage, "injected");
});

test("an unreadable channel is a missing receipt, never a thrown error", async () => {
  const exploding: ChannelIO = {
    ensureDir() {},
    appendLine() {},
    readText() { throw new Error("disk gone"); },
    writeText() {},
    now: () => 0,
  };
  const check = await verifyDeliveryOn(
    { channelIO: () => exploding, sleep: async () => {} },
    { kind: "spawn", channelPath: PATH, attempts: 2 },
  );
  assert.equal(check.verdict.ok, false);
  assert.equal(check.evidence.channelReported, false);
});
