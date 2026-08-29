/**
 * THE FOUR-STATE MACHINE, as pure decisions.
 *
 * All four states were observed in the second orchestration run, and the
 * report is unusually specific about how NOT to decide them: "token 零增长不能
 * 用来判定 idle" — a child blocked in `judge_wait` for 550s and one running a
 * 700s poll loop both freeze their counters and are both perfectly healthy.
 * So the classification leans on structured truth first and uses the screen
 * fingerprint last, and every rule here is a function of facts you can write
 * down in a test rather than something you have to open a terminal to see.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyChildState,
  decideChildEvent,
  describeChildState,
  formatChildHealth,
  IDLE_AFTER_MS,
  isNewsworthy,
  nextRewakeDelayMs,
  screenFingerprint,
  screenLooksBusy,
  type ChildObservation,
  type ChildStateMemory,
} from "../lib/orchestrator-child-state.ts";

const T0 = 1_700_000_000_000;

function observe(over: Partial<ChildObservation> = {}): ChildObservation {
  return { childId: "t1-abc", paneAlive: true, at: T0, ...over };
}

// ---------------------------------------------------------------------------
// The fingerprint — the signal that had to be made honest first
// ---------------------------------------------------------------------------

test("R-23: the fingerprint ignores counters, so a ticking token display is not 'work'", () => {
  const a = screenFingerprint("Context 2% · $6.640 · 1517537s\n正在读取文件");
  const b = screenFingerprint("Context 7% · $6.641 · 1517599s\n正在读取文件");
  assert.equal(a, b, "only the digits changed — nothing happened");

  const c = screenFingerprint("Context 7% · $6.641 · 1517599s\n开始写文件");
  assert.notEqual(a, c, "and real output still registers");
});

test("R-23: 'busy' is recognized from the screen, and it is the same predicate delivery uses", () => {
  assert.equal(screenLooksBusy("Context 2% · esc to interrupt"), true);
  assert.equal(screenLooksBusy("Thinking…"), true);
  assert.equal(screenLooksBusy("> 等你的下一步"), false);
  assert.equal(screenLooksBusy(undefined), false);
});

// ---------------------------------------------------------------------------
// The states
// ---------------------------------------------------------------------------

test("dead: a pane that is provably gone, and nothing else, is dead", () => {
  const verdict = classifyChildState(observe({ paneAlive: false }));
  assert.equal(verdict.state, "dead");
});

test("F14/R-11: liveness that could NOT be measured keeps the previous state — never a death", () => {
  const memory: ChildStateMemory = { state: "working", fingerprint: "x", changedAt: T0 };
  const verdict = classifyChildState(observe({ paneAlive: undefined }), memory);
  assert.equal(verdict.state, "working");
  assert.match(verdict.reason, /未知/);
});

test("waiting-input: a dialog on a settled screen, and the title travels with it", () => {
  const memory: ChildStateMemory = { fingerprint: screenFingerprint("选一个"), changedAt: T0 - 30_000 };
  const verdict = classifyChildState(
    observe({ screenText: "选一个", dialogOpen: true, dialogTitle: "选一个", at: T0 }),
    memory,
  );
  assert.equal(verdict.state, "waiting-input");
  assert.match(verdict.reason, /选一个/);
});

test("waiting-input: a dialog that JUST appeared is still 'working' until the screen settles", () => {
  const verdict = classifyChildState(observe({ screenText: "选一个", dialogOpen: true }), { fingerprint: "别的" });
  assert.equal(verdict.state, "working", "one repaint is not a question yet");
});

test("waiting-input: a gate PAUSE is structured truth — it needs no dialog on screen", () => {
  const verdict = classifyChildState(observe({
    screenText: "……",
    sidecar: { pausedQuestion: true },
  }));
  assert.equal(verdict.state, "waiting-input");
  assert.match(verdict.reason, /ask_user/);
});

test("R-23: a judge round in flight is WORKING, however frozen the screen looks", () => {
  const frozen = "等待 reviewer 本轮结束（已耗时 550s）";
  const memory: ChildStateMemory = { fingerprint: screenFingerprint(frozen), changedAt: T0 - IDLE_AFTER_MS * 4 };
  const verdict = classifyChildState(
    observe({ screenText: frozen, sidecar: { judgeRunning: true }, at: T0 }),
    memory,
  );
  assert.equal(verdict.state, "working");
  assert.match(verdict.reason, /judge/);
});

test("R-23: idle is 'nothing in flight AND nothing moving for long enough' — and it says so", () => {
  const screen = "> 我做完了";
  const memory: ChildStateMemory = { fingerprint: screenFingerprint(screen), changedAt: T0 - IDLE_AFTER_MS - 1 };
  const verdict = classifyChildState(observe({ screenText: screen, at: T0 }), memory);
  assert.equal(verdict.state, "idle");
  assert.match(verdict.reason, /并没有报告 declare_done/);

  const early = classifyChildState(
    observe({ screenText: screen, at: T0 }),
    { fingerprint: screenFingerprint(screen), changedAt: T0 - 5_000 },
  );
  assert.equal(early.state, "working", "a five-second pause is not a stop");
});

test("working: a screen that changed since the last probe, with no other evidence needed", () => {
  const verdict = classifyChildState(observe({ screenText: "新的一行" }), { fingerprint: "旧的一行", changedAt: T0 - 60_000 });
  assert.equal(verdict.state, "working");
  assert.match(verdict.reason, /指纹/);
});

test("a screen that cannot be read keeps the previous state, and says which fact it lacked", () => {
  const verdict = classifyChildState(observe({ screenText: undefined }), { state: "waiting-input", changedAt: T0 });
  assert.equal(verdict.state, "waiting-input");
  assert.match(verdict.reason, /读不到/);
});

test("the memory carries the state forward: `since` survives while the state does not change", () => {
  const first = classifyChildState(observe({ screenText: "a", at: T0 }));
  const second = classifyChildState(observe({ screenText: "a", at: T0 + 5_000 }), first.memory);
  assert.equal(second.state, first.state);
  assert.equal(second.memory.since, first.memory.since, "the clock on a state starts when the state does");
});

// ---------------------------------------------------------------------------
// When to ring — and when to ring AGAIN
// ---------------------------------------------------------------------------

test("only waiting-input / idle / dead are worth a wake-up", () => {
  assert.equal(isNewsworthy("working"), false);
  for (const state of ["waiting-input", "idle", "dead"] as const) {
    assert.equal(isNewsworthy(state), true);
  }
});

test("R-16: the re-wake backoff is 10s → 30s → 60s, counted from the last report", () => {
  assert.equal(nextRewakeDelayMs(1), 10_000);
  assert.equal(nextRewakeDelayMs(2), 30_000);
  assert.equal(nextRewakeDelayMs(3), 60_000);
  assert.equal(nextRewakeDelayMs(9), 60_000, "it plateaus rather than going silent");
});

test("R-16: entering a state rings once, and an UNRESOLVED state rings again on the backoff", () => {
  const screen = "选一个";
  const settled: ChildStateMemory = { fingerprint: screenFingerprint(screen), changedAt: T0 - 30_000 };
  const first = classifyChildState(observe({ screenText: screen, dialogOpen: true, at: T0 }), settled);
  const entered = decideChildEvent(first, undefined, T0);
  assert.equal(entered.raise, true, "entering waiting-input is news");
  assert.equal(entered.memory.reported, 1);

  const soon = classifyChildState(
    observe({ screenText: screen, dialogOpen: true, at: T0 + 3_000 }),
    entered.memory,
  );
  assert.equal(decideChildEvent(soon, "waiting-input", T0 + 3_000).raise, false, "no spam");

  const later = classifyChildState(
    observe({ screenText: screen, dialogOpen: true, at: T0 + 11_000 }),
    entered.memory,
  );
  const again = decideChildEvent(later, "waiting-input", T0 + 11_000);
  assert.equal(again.raise, true, "an unanswered question comes back — the R-16 silence is the bug");
  assert.equal(again.memory.reported, 2);
});

test("a state that RESOLVED itself resets the counter, so the next problem starts at 10s again", () => {
  const memory: ChildStateMemory = { state: "waiting-input", reported: 3, lastReportedAt: T0, changedAt: T0 };
  const working = classifyChildState(observe({ screenText: "Context 2% · esc to interrupt", at: T0 + 1_000 }), memory);
  assert.equal(working.state, "working");
  assert.equal(working.memory.reported, 0, "the backoff belongs to the state, not to the child");
});

// ---------------------------------------------------------------------------
// The snapshot the supervisor actually reads (R-4 / R-11)
// ---------------------------------------------------------------------------

test("R-4/R-11: the health snapshot names the child, its state, how long it has been still, and its dialog", () => {
  const rendered = formatChildHealth([
    {
      childId: "t1-abc",
      taskId: "t1",
      paneId: "%46",
      state: "waiting-input",
      reason: "屏幕上有等待回答的对话框",
      lastActivityAt: new Date(T0).toISOString(),
      secondsSinceActivity: 42,
      dialogTitle: "认可这个 goal 吗？",
    },
    { childId: "t3-def", taskId: "t3", paneId: "%47", state: "working", reason: "屏幕指纹变了", done: true },
  ]);
  assert.match(rendered, /t1-abc/);
  assert.match(rendered, /%46/);
  assert.match(rendered, /42s/);
  assert.match(rendered, /认可这个 goal 吗？/);
  assert.match(rendered, /已报告完成/);
  assert.equal(formatChildHealth([]), "（当前没有开着的子会话）");
});

test("every state has a human label — the supervisor reads words, not enum values", () => {
  for (const state of ["working", "waiting-input", "idle", "dead"] as const) {
    assert.match(describeChildState(state), new RegExp(state));
  }
});
