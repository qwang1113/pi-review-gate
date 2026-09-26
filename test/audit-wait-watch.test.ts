/**
 * What the gate does while it waits on its own auditor (lib/audit-wait-watch.ts):
 * the auditor's question reaches the user, the progress line says where and
 * how long, and a round without a verdict says why.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  auditWaitProgressLine,
  classifyAuditWaitFailure,
  questionDialogSpec,
  watchAuditRound,
} from "../lib/audit-wait-watch.ts";
import type { ChannelRecord, ChannelRequestRecord } from "../lib/channel-records.ts";
import type { ChoiceSpec } from "../lib/choice-dialog.ts";

const SINCE = "2026-09-26T15:21:34.000Z";

function request(over: Partial<ChannelRequestRecord> = {}): ChannelRequestRecord {
  return {
    kind: "request",
    from: "child",
    at: "2026-09-26T15:22:39.333Z",
    requestId: "req-1",
    dialogKind: "select",
    topic: "ask-user",
    title: "问题 1 / 1\n交卷被拒，如何处理？",
    options: ["A. 请 opener 重新派发（推荐）", "B. 本轮作废", "✎ 不选，我说明原因"],
    ...over,
  };
}

const state = (activity: string, at = "2026-09-26T15:22:27.162Z"): ChannelRecord =>
  ({ kind: "state", from: "child", at, state: "working", activity }) as ChannelRecord;

test("questionDialogSpec strips the rows' letters, marker and decline row", () => {
  const spec = questionDialogSpec(request())!;
  assert.deepEqual(spec.options, ["请 opener 重新派发", "本轮作废"]);
  assert.equal(spec.recommended, "请 opener 重新派发");
  assert.match(spec.title, /交卷被拒/);
  assert.equal(questionDialogSpec(request({ dialogKind: "input", options: [] })), undefined);
});

test("progress line names the tmux session:window and the seconds waited", () => {
  const where = { role: "goal-auditor", tmuxSession: "rg-repo-abc", windowId: "@12", paneId: "%34" };
  assert.equal(auditWaitProgressLine(where, 75_400), "goal-auditor 在 tmux rg-repo-abc:@12（pane %34）里跑，已等 75s");
});

test("classify: each of the four causes reads as itself", () => {
  const dead = classifyAuditWaitFailure({ paneAlive: false, records: [], since: SINCE });
  assert.deepEqual(dead.kinds, ["pane-dead"]);
  assert.match(dead.text, /进程已经不在/);

  const refused = classifyAuditWaitFailure({ paneAlive: undefined, records: [state("judge_conclude(BLOCKED)")], since: SINCE });
  assert.deepEqual(refused.kinds, ["conclude-refused"]);
  assert.match(refused.text, /交卷被门禁拒了/);

  const asking = classifyAuditWaitFailure({ paneAlive: undefined, records: [request()], since: SINCE });
  assert.deepEqual(asking.kinds, ["question"]);
  assert.match(asking.text, /在提问.*交卷被拒，如何处理/);

  const silent = classifyAuditWaitFailure({ paneAlive: undefined, records: [state("bash(ls)")], since: SINCE });
  assert.deepEqual(silent.kinds, ["no-report"]);
  assert.match(silent.text, /没有交卷.*working/);

  // A conclusion from an EARLIER round is not this round's refusal.
  const old = classifyAuditWaitFailure({ paneAlive: undefined, records: [state("judge_conclude(READY)", "2026-09-26T13:48:04.000Z")], since: SINCE });
  assert.deepEqual(old.kinds, ["no-report"]);
});

/** A fake world: a channel we append to, a clock, and a controllable stop. */
function world(records: ChannelRecord[]) {
  const asked: { spec: ChoiceSpec; signal: AbortSignal; answer: (a: string | undefined) => void }[] = [];
  const answers: { requestId: string; answer: string }[] = [];
  const lines: string[] = [];
  let now = 0;
  let endRound!: () => void;
  const stop = new Promise<void>((r) => { endRound = r; });
  let tick!: () => void;
  const deps = {
    readRecords: () => records,
    ask: (spec: ChoiceSpec, signal: AbortSignal) => new Promise<string | undefined>((resolve) => {
      asked.push({ spec, signal, answer: resolve });
      signal.addEventListener("abort", () => resolve(undefined));
    }),
    writeAnswer: (requestId: string, answer: string) => {
      answers.push({ requestId, answer });
      records.push({ kind: "answer", from: "orchestrator", at: new Date().toISOString(), requestId, answer } as ChannelRecord);
    },
    progress: (line: string) => lines.push(line),
    now: () => now,
    sleep: () => new Promise<void>((r) => { tick = r; }),
  };
  const step = async (advanceMs: number) => { now += advanceMs; tick(); await new Promise((r) => setImmediate(r)); };
  return { deps, asked, answers, lines, stop, endRound, step };
}

const where = { role: "goal-auditor", tmuxSession: "rg-x", windowId: "@3", paneId: "%9" };

test("a question raised during the wait is put to the user and the answer goes back on the channel", async () => {
  const records: ChannelRecord[] = [state("bash(ls)")];
  const w = world(records);
  const done = watchAuditRound(w.deps, { where, since: SINCE, startedAtMs: 0, stop: w.stop });
  await w.step(0);
  assert.equal(w.asked.length, 0);
  records.push(request());
  await w.step(2_000);
  assert.equal(w.asked.length, 1, "asked as soon as it appeared");
  assert.match(w.lines.at(-1)!, /已转到你的对话框/);
  w.asked[0]!.answer("请 opener 重新派发");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.answers, [{ requestId: "req-1", answer: "A. 请 opener 重新派发（推荐）" }]);
  await w.step(2_000);
  assert.equal(w.asked.length, 1, "asked once, not every tick");
  // Progress refreshes with growing seconds.
  const secs = w.lines.map((l) => Number(/已等 (\d+)s/.exec(l)![1]));
  assert.ok(secs.length >= 3 && secs.at(-1)! > secs[0]!);
  w.endRound();
  await w.step(0);
  await done;
});

test("answered in the auditor's own pane first: the forwarded box is taken down", async () => {
  const records: ChannelRecord[] = [request()];
  const w = world(records);
  const done = watchAuditRound(w.deps, { where, since: SINCE, startedAtMs: 0, stop: w.stop });
  await w.step(0);
  assert.equal(w.asked.length, 1);
  records.push({ kind: "request-settled", from: "child", at: "2026-09-26T15:23:00.000Z", requestId: "req-1", by: "user" } as ChannelRecord);
  await w.step(2_000);
  assert.equal(w.asked[0]!.signal.aborted, true);
  assert.equal(w.answers.length, 0, "nothing written for a question somebody else answered");
  w.endRound();
  await w.step(0);
  await done;
});
