/**
 * WHICH RECTANGLE IS WHICH — the pane colour, the label, and the state on it.
 *
 * A presentation feature, so these tests are mostly about the two ways a
 * presentation feature can do real damage:
 *
 *  1. by growing the tool set (philosophy two). The decoration is applied
 *     INSIDE `orchestrator_spawn` and undone inside `orchestrator_close`; the
 *     user stated as a hard criterion that the orchestrator's call sequence
 *     must not change by one character, so the tests assert on the tmux argv
 *     those two calls produce and on the tool list staying at ten.
 *  2. by breaking something real when tmux refuses. Cosmetics must never fail
 *     a spawn, so a broken tmux is driven end to end and the child must still
 *     come up.
 *
 * And one correctness property: the colour is a pure function of the child
 * id, because a colour that drifts between processes (or after a takeover)
 * identifies nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

import { makeFakeWorld, replyText, twoTaskPlan } from "./helpers/fake-orchestration.ts";
import {
  isLastDecoratedChild,
  paneColorFor,
  paneLabelFor,
  paneStyleFor,
  paneTitleFor,
  paneTitleForHealth,
  PANE_BORDER_FORMAT,
  PANE_BORDER_STATUS,
  PANE_PALETTE,
} from "../lib/orchestrator-pane-decor.ts";
import { assertSafeTmuxArgv, buildHidePaneLabelsArgv, buildShowPaneLabelsArgv } from "../lib/orchestrator-tmux.ts";

test("a child's colour is a pure function of its id — same child, same colour, forever", () => {
  const first = paneColorFor("t1-mtf5kc1z");
  const second = paneColorFor("t1-mtf5kc1z");
  assert.deepEqual(first, second);
  assert.ok(PANE_PALETTE.includes(first), "and it comes from the palette, not from nowhere");
  assert.equal(paneStyleFor("t1-mtf5kc1z"), `fg=${first.token}`);
  // Different children should generally differ; the palette is small, so this
  // asserts spread rather than uniqueness.
  const spread = new Set(["t1-a", "t2-b", "t3-c", "t4-d", "t5-e"].map((id) => paneColorFor(id).token));
  assert.ok(spread.size >= 3, "five children must not all land on one colour");
});

test("the label is the task id plus a readable slug, bounded in length", () => {
  assert.equal(paneLabelFor("t1", "user interaction tools"), "@t1-user-interaction-tools");
  assert.equal(paneLabelFor("t2", "命令层"), "@t2", "a non-ASCII title collapses to the id, never to mojibake");
  assert.ok(paneLabelFor("t3", "a".repeat(80)).length <= 28, "a border that wraps stops being a one-glance read");
});

test("the title carries the STATE and how long it has held — identity alone is not enough", () => {
  assert.equal(
    paneTitleFor({ label: "@t1-user-interaction", state: "waiting-input", stateForSeconds: 12 }),
    "@t1-user-interaction · waiting-input 12s",
  );
  assert.equal(
    paneTitleFor({ label: "@t2-gate-commands", state: "waiting-judge", stateForSeconds: 220 }),
    "@t2-gate-commands · waiting-judge 220s",
  );
  assert.match(
    paneTitleFor({ label: "@t3", state: "working", stateForSeconds: 3600 }),
    /60m$/,
    "past ten minutes the question is 'how long', which minutes answer better",
  );

  assert.equal(
    paneTitleForHealth("@t1", { childId: "c", state: "done" }),
    "@t1 · done",
    "a state with no clock still renders",
  );
});

test("the window options are window-scoped and never carry -g", () => {
  for (const argv of buildShowPaneLabelsArgv("%3", PANE_BORDER_STATUS, PANE_BORDER_FORMAT)) {
    assert.doesNotMatch(argv.join(" "), /(^| )-g( |$)/, "the user's global config is not ours to touch");
    assert.equal(argv[0], "setw");
    assert.deepEqual(assertSafeTmuxArgv(argv), argv, "and the gate's own guard accepts it");
  }
  for (const argv of buildHidePaneLabelsArgv("%3")) {
    assert.ok(argv.includes("-u"), "undo restores the user's setting rather than a default we invented");
  }
});

test("the window bar is removed only for the LAST decorated child", () => {
  const children = [
    { id: "a" },
    { id: "b", closedAt: "2026-08-30T10:00:00.000Z" },
  ];
  assert.equal(isLastDecoratedChild(children, "a"), true, "b is already closed, so a is the last one");
  assert.equal(isLastDecoratedChild([{ id: "a" }, { id: "b" }], "a"), false,
    "removing the bar while a sibling still uses it would blank a live label");
});

// ---------------------------------------------------------------------------
// Inside the tools, and nowhere else
// ---------------------------------------------------------------------------

/** Every tmux argv the fake world saw, as joined strings. */
function tmuxLog(world: ReturnType<typeof makeFakeWorld>): string[] {
  return world.tmuxCalls.map((argv) => argv.join(" "));
}

test("spawn decorates the pane ITSELF — no second call, no extra tool", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const reply = await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  assert.equal(reply.isError, undefined, replyText(reply));

  const child = world.runtime().children[0]!;
  const log = tmuxLog(world).join("\n");
  assert.match(log, new RegExp(`select-pane -t ${child.paneId} -P fg=colour\\d+`), "the border colour is set");
  assert.match(log, new RegExp(`select-pane -t ${child.paneId} -T @t1`), "and the label, with the task in it");
  assert.match(log, /setw -t %\d+ pane-border-status top/, "and the window bar is turned on");
  assert.match(replyText(reply), /pane 已标记为 @t1/, "the reply says what the user will see");

  // Philosophy two: nothing new is addressable.
  assert.equal(world.tools.has("orchestrator_decorate"), false);
  assert.equal([...world.tools.keys()].filter((n) => n.startsWith("orchestrator_")).length, 10);
});

test("a tmux that refuses cosmetics does NOT fail the spawn", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, tmuxDecorFails: true });
  const reply = await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });

  assert.equal(reply.isError, undefined, "a coloured border is never worth a failed session");
  assert.equal(reply.details?.delivered, true);
  assert.match(replyText(reply), /装饰没能全部生效/, "and it says so instead of pretending");
  assert.equal(world.runtime().children.length, 1, "the child is registered either way");
});

test("close takes the window bar down before killing the pane, and only then", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  const child = world.runtime().children[0]!;

  await world.call("orchestrator_close", { childId: child.id });

  const log = tmuxLog(world);
  const unset = log.findIndex((line) => line.includes("-u pane-border-status"));
  const kill = log.findIndex((line) => line.startsWith(`kill-pane -t ${child.paneId}`));
  assert.ok(unset >= 0, "the window-level option this orchestration set must be undone");
  assert.ok(kill >= 0);
  assert.ok(unset < kill, "after kill-pane the pane id is no longer a valid setw target");
});

test("the health snapshot names the same colour the border uses", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  const child = world.runtime().children[0]!;

  const wait = await world.call("orchestrator_wait", { timeoutMs: 0 });
  const text = replyText(wait);
  assert.match(text, new RegExp(`\\[${paneColorFor(child.id).name}\\]`),
    "a row in the receipt and a rectangle on screen must be matchable by eye");
});

test("the probe repaints the label from the health it just measured", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  const child = world.runtime().children[0]!;
  // The heartbeat keeps reporting while the agent is blocked — that is what
  // keeps this child out of `stalled` and lets the border show the real wait.
  for (let tick = 0; tick < 8; tick++) {
    world.childReports(child.id, "waiting-judge", { waitingFor: "reviewer" });
    world.advance(30_000);
  }


  await world.call("orchestrator_wait", { timeoutMs: 0 });

  const titles = tmuxLog(world).filter((line) => line.includes(`-T @t1`));
  assert.ok(titles.length >= 2, "the title is refreshed by the probe, not only at spawn");
  assert.match(titles[titles.length - 1]!, /waiting-judge/,
    "so the border answers 'what is it doing' without a tool call");
});

test("the repaint is throttled — the probe must not fork a tmux process every 2 seconds", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  const child = world.runtime().children[0]!;
  const titlesNow = (): number => tmuxLog(world).filter((line) => line.includes("-T @t1")).length;

  await world.call("orchestrator_wait", { timeoutMs: 0 });
  const afterFirst = titlesNow();
  assert.ok(afterFirst >= 1, "the first probe paints");

  // Same instant, same state: nothing to say, so nothing is spawned. The wait
  // loop probes every 2 seconds, so without this an hour-long orchestration
  // would fork thousands of tmux processes purely for decoration.
  await world.call("orchestrator_wait", { timeoutMs: 0 });
  assert.equal(titlesNow(), afterFirst, "an unchanged title costs nothing");

  // A state change 2 seconds later is still inside the throttle window.
  world.childReports(child.id, "waiting-judge", { waitingFor: "reviewer" });
  world.advance(2_000);
  await world.call("orchestrator_wait", { timeoutMs: 0 });
  assert.equal(titlesNow(), afterFirst, "a border that lags a few seconds costs nothing");

  // Past the window, the change lands.
  world.advance(6_000);
  world.childReports(child.id, "waiting-judge", { waitingFor: "reviewer" });
  await world.call("orchestrator_wait", { timeoutMs: 0 });
  assert.ok(titlesNow() > afterFirst, "but the border does have to catch up eventually");
  assert.match(tmuxLog(world).filter((l) => l.includes("-T @t1")).pop()!, /waiting-judge/);
});

test("the throttle memory belongs to the orchestration, not to the module", async () => {
  // Two worlds in one process: the fake clock is fixed, so both children get
  // the same id. A module-level cache would make the second world's first
  // paint disappear — which is also how a real second orchestration in one pi
  // process would lose its borders.
  const first = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await first.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  await first.call("orchestrator_wait", { timeoutMs: 0 });

  const second = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await second.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  await second.call("orchestrator_wait", { timeoutMs: 0 });

  assert.ok(
    tmuxLog(second).some((line) => line.includes("-T @t1")),
    "the second orchestration paints its own panes",
  );
});

