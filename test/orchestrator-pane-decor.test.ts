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
  paneColorFor,
  paneLabelFor,
  paneStyleFor,
  paneTitleFor,
  PANE_BORDER_FORMAT,
  PANE_BORDER_STATUS,
  PANE_PALETTE,
} from "../lib/orchestrator-pane-decor.ts";
import { assertSafeTmuxArgv, buildHidePaneLabelsArgv, buildShowPaneLabelsArgv } from "../lib/orchestrator-tmux.ts";
import { parsePlan } from "../lib/orchestrator-plan.ts";

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
    paneTitleFor({ label: "@t1", state: "done" }),
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

// ("the window bar is removed only for the LAST decorated child" moved with
// its subject: `isLastDecoratedChild` is gone, and the question — how many
// decorated panes of ANY kind can I still see — is asserted in
// test/session-factory.test.ts and in the four close paths' own tests.)

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
  // Framed ONCE: the factory says "display only", the orchestration adds what
  // is specific to a child. Wrapping it twice read as two nested failures.
  assert.match(replyText(reply), /装饰失败（仅显示降级）/, "and it says so instead of pretending");
  assert.match(replyText(reply), /纯展示层，子会话本身不受影响/, "…in the child's own words");
  assert.doesNotMatch(replyText(reply), /没能全部生效（pane 装饰失败/, "…and not nested inside itself");
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
  // AND the window is named by the ORCHESTRATOR'S OWN pane (%0), never by the
  // child's (reviewer P2, 2026-09-05): `setw -t <pane>` uses the pane only to
  // identify a window, and the pane being closed is exactly the id that may
  // already be gone — a failed option write leaves the bar on for good.
  const unsets = log.filter((line) => line.startsWith("setw") && line.includes("-u"));
  assert.equal(unsets.length, 2, "both options are restored");
  assert.ok(unsets.every((line) => line.includes("-t %0")), "…through a pane that is provably alive");
  assert.ok(unsets.every((line) => !line.includes(child.paneId)), "…not through the pane being killed");
});

test("close leaves the window bar up while a SIBLING CHILD is still on screen", async () => {
  // The other half of the same expression (reviewer P2, 2026-09-05: pinning the
  // judge half alone left this one free to be zeroed). Two live child panes
  // only happen ACROSS repos — inside one repo the scheduler serializes them —
  // so the plan declares two, which is also the only shape where a manager
  // really can be closing one child while another is still labelled.
  const plan = parsePlan({
    title: "跨仓库计划",
    intent: "两个仓库各一个任务，可以并行",
    tasks: [
      { id: "t1", title: "任务一", repo: "/repo" },
      { id: "t2", title: "任务二", repo: "/other/repo" },
    ],
  });
  assert.ok(plan.plan, plan.problems.join("; "));
  const world = makeFakeWorld({
    plan: plan.plan!,
    approvePlan: true,
    resolvableRepos: ["/repo", "/other/repo"],
  });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  const second = await world.call("orchestrator_spawn", { taskId: "t2", task: "做任务二" });
  assert.equal(second.isError, undefined, replyText(second));
  const [first, sibling] = world.runtime().children;
  assert.ok(sibling, "two children in two repos run at once — that is the case under test");

  await world.call("orchestrator_close", { childId: first!.id });

  const unsets = tmuxLog(world).filter((line) => line.startsWith("setw") && line.includes("-u"));
  assert.deepEqual(unsets, [], "the sibling's border is still labelled: the bar stays up");
});

test("a CLOSED sibling is not a decorated pane, even if its pane outlived the close", async () => {
  // The `!c.closedAt` half of the filter (reviewer Nit, 2026-09-05: it could
  // be deleted and every test stayed green). It matters exactly when a closed
  // child's pane is still on screen — a kill that failed, or a pane tmux still
  // lists — because then liveness alone would call it a sibling and the bar
  // would stay up forever.
  const plan = parsePlan({
    title: "跨仓库计划",
    intent: "两个仓库各一个任务",
    tasks: [
      { id: "t1", title: "任务一", repo: "/repo" },
      { id: "t2", title: "任务二", repo: "/other/repo" },
    ],
  });
  assert.ok(plan.plan, plan.problems.join("; "));
  const world = makeFakeWorld({
    plan: plan.plan!,
    approvePlan: true,
    resolvableRepos: ["/repo", "/other/repo"],
  });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  await world.call("orchestrator_spawn", { taskId: "t2", task: "做任务二" });
  const [first, second] = world.runtime().children;

  // t1 is CLOSED on the books while its pane stays on screen.
  world.saveRuntime({
    ...world.runtime(),
    children: world.runtime().children.map((c) =>
      c.id === first!.id ? { ...c, closedAt: new Date(world.now()).toISOString() } : c),
  });

  await world.call("orchestrator_close", { childId: second!.id });

  const unsets = tmuxLog(world).filter((line) => line.startsWith("setw") && line.includes("-u"));
  assert.equal(unsets.length, 2, "the only child this orchestration still owns is the one closing");
});


test("a second child in one repo is REFUSED when the gate cannot isolate it", async () => {
  // CHANGED 2026-09-10: same-repo tasks are no longer serialized — the second
  // one gets its own `git worktree` (lib/orchestrator-worktree.ts). What this
  // test now pins is the FAIL-CLOSED half: this fake world wires no
  // `createWorktree`, so the spawn must be refused rather than putting two
  // writers in one checkout. "We could not isolate you" is a reason to wait,
  // never a reason to share.
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  await world.call("orchestrator_plan", { action: "set-status", taskId: "t1", status: "done" });
  const second = await world.call("orchestrator_spawn", { taskId: "t2", task: "做任务二" });

  assert.equal(second.isError, true, "no isolation available ⇒ no second writer in this checkout");
  // The REASON matters, not just the refusal: "t2 was refused" would also be
  // true if the plan were unapproved or the task unknown, and then this test
  // would be asserting nothing about scheduling (reviewer Nit, 2026-09-05).
  assert.match(replyText(second), /同一个 repo（\/repo）/, "…refused because it would share a checkout");
  assert.match(replyText(second), /无法为它开出隔离的 worktree/, "…and the gate says which capability is missing");
  assert.equal(world.runtime().children.length, 1, "…and no second pane was opened");
});

test("…and it RUNS BESIDE the first one when the gate CAN isolate it", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, isolateChild: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  await world.call("orchestrator_plan", { action: "set-status", taskId: "t1", status: "done" });
  const second = await world.call("orchestrator_spawn", { taskId: "t2", task: "做任务二" });

  assert.equal(second.isError, undefined, replyText(second));
  const children = world.runtime().children;
  assert.equal(children.length, 2, "both children are live at once — that is the whole point");
  assert.ok(children[1]!.worktree, "and the second one records the checkout it got");
  assert.notEqual(children[1]!.cwd, "/repo", "its cwd is the ISOLATED path, not the shared checkout");
  assert.equal(children[1]!.cwd, children[1]!.worktree!.path);
  // The spawn reply says WHICH checkout it got — a manager reading "sharing the
  // main worktree" while the pane works in an isolated one would reason about
  // the wrong tree.
  assert.match(replyText(second), /独立 checkout/);
});

// ---------------------------------------------------------------------------
// THE SETTLEMENT ACTION (round-8 P1). Only the pure plan was covered; the
// DECISION — which settlement a manager asked for, and which calls must be
// REFUSED — had none, so a broken wiring would have shipped unnoticed.
// ---------------------------------------------------------------------------

test("close settles the checkout the manager asked about, and refuses a value it does not know", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, isolateChild: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  await world.call("orchestrator_spawn", { taskId: "t2", task: "做任务二" });
  const child = world.runtime().children[1]!;
  assert.ok(child.worktree, "t2 got an isolated checkout");

  // An unknown value is refused BEFORE anything is touched — the parameter is
  // a decision, and guessing at it would discard somebody's work.
  const bogus = await world.call("orchestrator_close", { childId: child.id, worktree: "nuke" });
  assert.equal(bogus.isError, true);
  assert.match(replyText(bogus), /worktree 参数不认识/);
  assert.deepEqual(world.settlements, [], "…and nothing was settled");

  const merged = await world.call("orchestrator_close", { childId: child.id, worktree: "merge" });
  assert.equal(merged.isError, undefined, replyText(merged));
  assert.deepEqual(world.settlements, [{ childId: child.id, settlement: "merge" }]);
  // A MERGE KEEPS the checkout (round-6 P2): the merge is only staged, so the
  // worktree and its branch are the manager's way back from `merge --abort`.
  assert.ok(world.runtime().children[1]!.worktree, "a staged merge must not delete the only other copy of the work");
});

test("a checkout nobody can settle keeps the child OPEN — close is refused, not walked away from", async () => {
  // The fail-closed half (round-9 P2, which the previous round claimed a static
  // assertion covered — it did not). A session can have the isolation wired and
  // the settlement not; closing anyway would leave a checkout that no later
  // call can settle and that the orphan list cannot even reach (it reports
  // unfinished children only).
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, isolateWithoutSettle: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  await world.call("orchestrator_spawn", { taskId: "t2", task: "做任务二" });
  const child = world.runtime().children[1]!;
  assert.ok(child.worktree, "it really did get a checkout — that is what makes this a refusal worth testing");

  const reply = await world.call("orchestrator_close", { childId: child.id, worktree: "discard" });
  assert.equal(reply.isError, true, "closing would strand the checkout");
  assert.match(replyText(reply), /没有接上 git 能力/);
  assert.equal(world.runtime().children[1]!.closedAt, undefined,
    "…and the child is still OPEN, so the close can be retried once the capability exists");
});

test("a FAILED reclamation keeps the record, so the discard can be retried", async () => {
  // Round-10 P1: this is the branch the whole `reclaimed` field exists for,
  // and it had no coverage (the fake hardcoded `reclaimed: true`). A discard
  // that removed nothing must NOT forget the checkout — otherwise the retry
  // the receipt offers is impossible and the directory is stranded, invisible
  // even to the orphan list (which reports unfinished children only).
  const world = makeFakeWorld({
    plan: twoTaskPlan(), approvePlan: true, isolateChild: true, settleReclaimed: false,
  });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  await world.call("orchestrator_spawn", { taskId: "t2", task: "做任务二" });
  const child = world.runtime().children[1]!;

  const failed = await world.call("orchestrator_close", { childId: child.id, worktree: "discard" });
  assert.equal(failed.isError, undefined, replyText(failed));
  assert.match(replyText(failed), /没能回收/, "the settlement's own account reaches the receipt");
  assert.ok(world.runtime().children[1]!.worktree,
    "the record SURVIVES a failed removal, or no later call could reach the checkout again");

  // …and the retry reaches the settlement again.
  await world.call("orchestrator_close", { childId: child.id, worktree: "discard" });
  assert.equal(world.settlements.length, 2, "the second discard really ran");
});

test("a CLOSED child's checkout can still be settled — the advice the merge receipt gives is not a dead end", async () => {
  // Round-7 P1: the merge receipt says "reclaim it later with close({worktree})",
  // and `closableChild` rejects anything with a `closedAt` — which every child
  // that has been through a close has. That made the advice unexecutable.
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, isolateChild: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  await world.call("orchestrator_spawn", { taskId: "t2", task: "做任务二" });
  const child = world.runtime().children[1]!;
  assert.equal((await world.call("orchestrator_close", { childId: child.id })).isError, undefined,
    "close it first — the default `keep` leaves the checkout");
  assert.ok(world.runtime().children[1]!.closedAt, "…and it is on record as closed");

  const late = await world.call("orchestrator_close", { childId: child.id, worktree: "discard" });
  assert.equal(late.isError, undefined, replyText(late));
  assert.match(replyText(late), /早已关闭/, "the reply says what this call actually did");
  assert.deepEqual(world.settlements, [
    { childId: child.id, settlement: "keep" },
    { childId: child.id, settlement: "discard" },
  ], "the first close kept the checkout (the default), the late one discarded it");
  assert.equal(world.runtime().children[1]!.worktree, undefined,
    "…and only a settlement that REMOVED the checkout is forgotten");
});

test("close leaves the window bar up while a REVIEW pane is still on screen", async () => {
  // The other kind of decorated pane. Counting only children was a measured
  // defect: a manager closing its last child blanked its own review's border.
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, judgePanes: 1 });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  const child = world.runtime().children[0]!;

  await world.call("orchestrator_close", { childId: child.id });

  const unsets = tmuxLog(world).filter((line) => line.startsWith("setw") && line.includes("-u"));
  assert.deepEqual(unsets, [], "the review pane still needs the border line it is labelled with");
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


/*
 * ── THE WINDOW LABEL BAR IS SHARED, AND TWO CROSS-SESSION CLOSES MISFIRE ──
 *
 * The rule itself (who opens the bar, who may take it down, what an unreadable
 * pane list means) is argued in lib/orchestrator-pane-decor.ts's header and
 * implemented by `releasesWindowLabels` + `countDecoratedPanes` in
 * lib/session-factory.ts. The tests above cover it for panes a session CAN
 * see.
 *
 * The one below drives the real `orchestrator_close` and asserts what it
 * really does: with nothing left in ITS OWN registry it releases the bar. That
 * is correct for what it can see, and it is also the misfire — a reviewer pane
 * the CHILD opened is not in the manager's registry, so "nothing left" is
 * measured over an incomplete set and a running review's border goes with it.
 *
 * WHAT THIS TEST DOES NOT DO, deliberately, so it does not claim more than it
 * has: it cannot stage the other session's pane. The fake tmux lists exactly
 * the panes this world opened, so a pane belonging to a session that does not
 * exist here cannot be put on screen. The gap is therefore ARGUED here and in
 * lib/orchestrator-pane-decor.ts's header, and only its visible half is
 * asserted. A round that adds cross-session pane visibility changes the INPUT
 * to this decision, so it should expect to rewrite this test rather than to
 * see it fail. (2026-09-06: left unfixed by user decision — both misfires are
 * display-only and the next spawn re-establishes the bar.)
 */

test("the release is measured over THIS session's registry only — which is the cross-session gap", async () => {
  // The real close path, with nothing left that this manager can see: no
  // sibling child, no judge of its own. It releases — and this assertion is
  // the mirror image of "close leaves the window bar up while a REVIEW pane is
  // still on screen" above, which is the same code with one visible pane.
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  const child = world.runtime().children[0]!;

  await world.call("orchestrator_close", { childId: child.id });

  const unsets = tmuxLog(world).filter((line) => line.startsWith("setw") && line.includes("-u"));
  assert.ok(
    unsets.length > 0,
    "with an empty visible set the manager takes the window bar down",
  );
  // …and THAT is the misfire, because the visible set is the manager's own
  // registry. A reviewer pane opened by the CHILD is on the same window and in
  // none of these numbers, so it loses its border here. The fix is a
  // cross-session pane registry; nothing in the counter itself is wrong.
  assert.equal(
    world.runtime().children.filter((c) => !c.closedAt).length,
    0,
    "the set it measured: its own children, and there are none left",
  );
});

