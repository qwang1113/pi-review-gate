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
  childPaneLabel,
  judgePaneLabel,
  paneColorFor,
  paneIdentity,
  paneStyleFor,
  paneTitleFor,
  pmPaneLabel,
  selfPaneOwner,
  PANE_BORDER_FORMAT,
  PANE_BORDER_STATUS,
  PANE_PALETTE,
} from "../lib/orchestrator-pane-decor.ts";
import { newChildId, taskIdFromChildId } from "../lib/orchestrator-registry.ts";
import {
  assertSafeTmuxArgv,
  buildPaneLabelArgv,
  buildShowPaneLabelsArgv,
  PANE_LABEL_OPTION,
  UnsafeTmuxCommand,
} from "../lib/orchestrator-tmux.ts";
import { parsePlan } from "../lib/orchestrator-plan.ts";
import * as tmuxModule from "../lib/orchestrator-tmux.ts";

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

test("the label is `what@who:name` — who opened it, and what it is for", () => {
  assert.equal(childPaneLabel("t1", "user interaction tools"), "t1@pm:user-interaction-tools");
  assert.equal(childPaneLabel("t2", "命令层"), "t2@pm", "a non-ASCII title collapses to the id, never to mojibake");
  assert.ok(childPaneLabel("t3", "a".repeat(80)).length <= 44, "a border that wraps stops being a one-glance read");
  assert.equal(pmPaneLabel("pi-review-gate"), "pm:pi-review-gate", "the manager's own pane has no opener to name");
  // A judge's label is its role plus its OPENER — the pair the user could not
  // tell apart when two goal-auditors sat in one window.
  assert.equal(judgePaneLabel("goal-auditor", "t6"), "goal-auditor@t6");
  assert.notEqual(judgePaneLabel("goal-auditor", "t6"), judgePaneLabel("goal-auditor", "pm"));
});

test("no identity carries a space, and none carries a tmux format character", () => {
  const labels = [
    childPaneLabel("t6", "Fix   the #1 bug, now"),
    judgePaneLabel("reviewer", "t6"),
    pmPaneLabel("My Repo"),
    paneIdentity({ what: "t1", owner: "a b", name: "x y" }),
  ];
  for (const label of labels) {
    assert.doesNotMatch(label, /\s/, `no space survives in ${JSON.stringify(label)}`);
    assert.doesNotMatch(label, /#/, `no format character survives in ${JSON.stringify(label)}`);
  }
  assert.equal(childPaneLabel("t6", "Fix   the #1 bug, now"), "t6@pm:fix-the-1-bug-now");
});

/**
 * The child id is what a child session knows about itself (`RG_STATE_VARIANT`),
 * so the owner half of every judge IT opens is read back out of it.
 */
test("a child names itself from its own handle, a manager from its mode", () => {
  const childId = newChildId("t6", 1_700_000_000_000);
  assert.equal(taskIdFromChildId(childId), "t6");
  assert.equal(taskIdFromChildId("fix-auth-abc123"), "fix-auth", "a task id may contain a dash and still round-trip");
  assert.equal(selfPaneOwner({ stateVariant: childId, orchestrator: false }), "t6");
  // A manager that INHERITED an orchestration carries the same variable as a
  // child would; it is the MODE that decides, and a child never runs in it.
  assert.equal(selfPaneOwner({ stateVariant: childId, orchestrator: true }), "t6");
  assert.equal(selfPaneOwner({ orchestrator: true }), "pm");
  assert.equal(selfPaneOwner({ orchestrator: false }), "self");
  assert.equal(selfPaneOwner({ stateVariant: "   ", orchestrator: false }), "self", "blank is not an identity");
});

test("the title carries the STATE and how long it has held — identity alone is not enough", () => {
  assert.equal(
    paneTitleFor({ label: "t1@pm:user-interaction", state: "waiting-input", stateForSeconds: 12 }),
    "t1@pm:user-interaction · waiting-input 12s",
  );
  assert.equal(
    paneTitleFor({ label: "t2@pm:gate-commands", state: "waiting-judge", stateForSeconds: 220 }),
    "t2@pm:gate-commands · waiting-judge 220s",
  );
  assert.match(
    paneTitleFor({ label: "t3@pm", state: "working", stateForSeconds: 3600 }),
    /60m$/,
    "past ten minutes the question is 'how long', which minutes answer better",
  );

  assert.equal(
    paneTitleFor({ label: "t1@pm", state: "done" }),
    "t1@pm · done",
    "a state with no clock still renders",
  );
});

test("the label is a pane USER OPTION, so pi cannot overwrite it", () => {
  // pi writes its own `pane_title` at boot and on every extension rebind, so a
  // label written once at spawn used to vanish within seconds — survived only
  // by the health probes that repaint, which a worker pane does not have.
  assert.deepEqual(
    buildPaneLabelArgv("%453", "x@self · working"),
    ["set", "-p", "-t", "%453", "@rg_label", "x@self · working"],
  );
  assert.deepEqual(
    assertSafeTmuxArgv(buildPaneLabelArgv("%453", "t1@pm")),
    buildPaneLabelArgv("%453", "t1@pm"),
    "the gate's own guard accepts it — `set -p` is pane-scoped and carries no -g",
  );
  assert.throws(() => buildPaneLabelArgv("; rm -rf /", "t1@pm"), UnsafeTmuxCommand,
    "a pane id is still validated: a label write is not a hole in the argv rules");
});

test("the border format reads the gate's label and falls back to the pane's own title", () => {
  // Both branches, read out of tmux's own conditional syntax: gate-opened panes
  // show what the gate wrote, and the BYSTANDERS in that window (the user's own
  // shell — the bar is window-scoped and never taken down) keep what they had.
  const match = /^#\{\?([^,]+),(.+),(.+)\}$/.exec(PANE_BORDER_FORMAT);
  assert.ok(match, `not a tmux conditional: ${PANE_BORDER_FORMAT}`);
  assert.equal(match[1], PANE_LABEL_OPTION, "the condition is the option the gate writes");
  assert.equal(match[2], `#{${PANE_LABEL_OPTION}}`, "set ⇒ the gate's label");
  assert.equal(match[3], "#{pane_title}", "unset ⇒ the pane's own title, exactly as before");
});

test("the window options are window-scoped and never carry -g", () => {
  for (const argv of buildShowPaneLabelsArgv("%3", PANE_BORDER_STATUS, PANE_BORDER_FORMAT)) {
    assert.doesNotMatch(argv.join(" "), /(^| )-g( |$)/, "the user's global config is not ours to touch");
    assert.equal(argv[0], "setw");
    assert.deepEqual(assertSafeTmuxArgv(argv), argv, "and the gate's own guard accepts it");
  }
  // There is NO undo builder any more (2026-09-17, user decision): toggling
  // `pane-border-status` resizes every pane in the window (measured on a
  // scratch tmux: SIGWINCH, rows 84 ↔ 83), so the bar is turned on once and
  // left on. Pinned by absence — `buildHidePaneLabelsArgv` is not exported.
  assert.equal("buildHidePaneLabelsArgv" in tmuxModule, false, "the release path is deleted, not bypassed");
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
  assert.match(log, new RegExp(`set -p -t ${child.paneId} @rg_label t1@pm($|\\s)`), "and the label, with the task AND its opener in it");
  assert.match(log, /setw -t %\d+ pane-border-status top/, "and the window bar is turned on");
  assert.match(replyText(reply), /pane 已标记为 t1@pm/, "the reply says what the user will see");

  // Philosophy two: nothing new is addressable. (EIGHT, not nine — the
  // notification tool is gone; the gate sends its own banners now.)
  assert.equal(world.tools.has("orchestrator_decorate"), false);
  assert.equal([...world.tools.keys()].filter((n) => n.startsWith("orchestrator_")).length, 8);
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

test("close kills its WINDOW and writes NO WINDOW OPTION (2026-09-17)", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  const child = world.runtime().children[0]!;

  await world.call("orchestrator_close", { childId: child.id });

  const log = tmuxLog(world);
  assert.ok(
    log.some((line) => line.startsWith(`kill-window -t ${child.tmuxSession}:${child.windowId}`)),
    `the child's window is closed, addressed through the session that owns it: ${log.join(" | ")}`,
  );
  // THE RELEASE IS DELETED, AND THIS IS WHERE IT WOULD COME BACK. Taking the
  // bar down writes `pane-border-status`, and that RESIZES EVERY PANE IN THE
  // WINDOW — measured on a scratch tmux as SIGWINCH with `rows 84 → 83`, in
  // both directions while re-setting the same value triggers nothing. Under
  // the window topology a child's bar lives in the CHILD's window and stops
  // existing with it, so a close writes no window option at all.
  assert.deepEqual(
    // Option writes only: a spawn line carries `env -u …` for its own child.
    log.filter((line) => line.startsWith("set") && line.includes(" -u")),
    [],
    "no window option is restored on close — the bar stays on (user decision 2026-09-17)",
  );
});

test("a child recorded before the window topology is closed by clearing its registration, not by a guess", async () => {
  // A sidecar row from an older build has no window coordinates at all, so the
  // window cannot be addressed. The first version of this code FAILED the whole
  // close there ("记录里没有 window/session 坐标"), which left the child `running`
  // forever and contradicted its own comment; the judge path takes the opposite
  // direction — leave the pane alone, clear the registration, say which
  // happened. Same rule now, and this is the test that holds it (2026-09-25,
  // quality round P2).
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  const spawned = world.runtime().children[0]!;
  world.saveRuntime({
    ...world.runtime(),
    children: [{ ...spawned, windowId: undefined, tmuxSession: undefined }],
  });

  const reply = await world.call("orchestrator_close", { childId: spawned.id });
  assert.equal(reply.isError, undefined, replyText(reply));
  assert.ok(world.runtime().children[0]!.closedAt !== undefined, "the registration is cleared either way");
  assert.match(replyText(reply), /没有 window\/session 坐标/, "…and the reply says the window was left alone");
  assert.equal(tmuxLog(world).some((line) => line.startsWith("kill-window")), false,
    "nothing was addressed by an id the record does not have");
});

test("close leaves every other pane's border alone, sibling or review pane", async () => {
  // ONE TEST FOR WHAT USED TO BE TWO (2026-09-17). The old pair pinned the
  // label-bar release's two halves — "a sibling child is still on screen" and
  // "a review pane is still on screen" — and both were really asking whether
  // the release ran. There is no release any more: a close writes no window
  // option, so no sibling can lose its border by construction. The two shapes
  // that used to differ are driven here so the case itself stays covered.
  const plan = parsePlan({
    title: "跨仓库计划",
    intent: "两个仓库各一个任务，可以并行",
    tasks: [
      { id: "t1", title: "任务一", repo: "/repo" },
      { id: "t2", title: "任务二", repo: "/other/repo" },
    ],
  });
  assert.ok(plan.plan, plan.problems.join("; "));
  const withSibling = makeFakeWorld({
    plan: plan.plan!,
    approvePlan: true,
    resolvableRepos: ["/repo", "/other/repo"],
  });
  await withSibling.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  const second = await withSibling.call("orchestrator_spawn", { taskId: "t2", task: "做任务二" });
  assert.equal(second.isError, undefined, replyText(second));
  await withSibling.call("orchestrator_close", { childId: withSibling.runtime().children[0]!.id });
  assert.deepEqual(
    tmuxLog(withSibling).filter((line) => line.startsWith("setw") && line.includes("-u")),
    [],
    "the sibling's border is still labelled",
  );

  const withReview = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true, judgePanes: 1 });
  await withReview.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  await withReview.call("orchestrator_close", { childId: withReview.runtime().children[0]!.id });
  assert.deepEqual(
    tmuxLog(withReview).filter((line) => line.startsWith("setw") && line.includes("-u")),
    [],
    "the review pane still needs the border line it is labelled with",
  );
});

test("close leaves every other pane's border alone, whatever the registry says", async () => {
  // The old test here — "a CLOSED sibling is not a decorated pane" — pinned the
  // `!c.closedAt` half of a filter that only the label-bar release read. The
  // release is deleted (2026-09-17, user decision), so the filter has no
  // reader; what still matters is the behaviour it protected: a close must not
  // blank anybody's border, no matter what the registry says about them.
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
  const [first] = world.runtime().children;

  // t1 is CLOSED on the books while its pane stays on screen.
  world.saveRuntime({
    ...world.runtime(),
    children: world.runtime().children.map((c) =>
      c.id === first!.id ? { ...c, closedAt: new Date(world.now()).toISOString() } : c),
  });

  await world.call("orchestrator_close", { childId: world.runtime().children[1]!.id });

  assert.deepEqual(
    tmuxLog(world).filter((line) => line.startsWith("setw") && line.includes("-u")),
    [],
    "a row on the books is not a border: nothing is taken down either way",
  );
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



test("the health snapshot names the same colour the border uses", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  const child = world.runtime().children[0]!;

  const wait = await world.call("orchestrator_wait", { timeoutMs: 0 });
  const text = replyText(wait);
  assert.match(text, new RegExp(`\\[${paneColorFor(child.id).name}\\]`),
    "a row in the receipt and a rectangle on screen must be matchable by eye");
});

test("the manager's OWN pane is labelled `pm:<repo>`, and rebuilt on EVERY probe", async () => {
  // The manager's pane is the one pane the gate never opened — the user did —
  // so nothing in a registry decorates it and a window of six panes had no way
  // to say WHICH one is the manager. It gets a title now, and it is written
  // UNCONDITIONALLY: `pm:<repo>` holds no state, so there is no changing string
  // to diff against, and pi rewrites every pane title at boot and on each
  // extension rebind — a write-once title would go stale exactly when a rebind
  // happened. One tmux call per probe for ONE pane, and the label survives the
  // next rebind by a poll.
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  const pmTitles = (): string[] => tmuxLog(world).filter((line) => line.startsWith("set -p -t %0 @rg_label pm:"));

  await world.call("orchestrator_wait", { timeoutMs: 0 });
  const afterFirst = pmTitles();
  assert.deepEqual(afterFirst, ["set -p -t %0 @rg_label pm:repo"], "identity first, and it says what it is");

  // The probe runs again with NOTHING changed — and the title is written again.
  // That is the whole difference from the child/judge repaint path, whose
  // memory exists to avoid forking tmux once per pane per probe; this is one
  // pane, and a stale one would be a pane nobody can identify.
  await world.call("orchestrator_wait", { timeoutMs: 0 });
  assert.equal(pmTitles().length, 2, "a second probe writes the same title a second time");
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

  const titles = tmuxLog(world).filter((line) => line.includes(`@rg_label t1@pm`));
  assert.ok(titles.length >= 2, "the title is refreshed by the probe, not only at spawn");
  assert.match(titles[titles.length - 1]!, /waiting-judge/,
    "so the border answers 'what is it doing' without a tool call");
});

test("the repaint is throttled — the probe must not fork a tmux process every 2 seconds", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  const child = world.runtime().children[0]!;
  const titlesNow = (): number => tmuxLog(world).filter((line) => line.includes("@rg_label t1@pm")).length;

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
  assert.match(tmuxLog(world).filter((l) => l.includes("@rg_label t1@pm")).pop()!, /waiting-judge/);
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
    tmuxLog(second).some((line) => line.includes("@rg_label t1@pm")),
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

test("closing the last visible child still writes no window option", async () => {
  // This test used to assert the cross-session MISFIRE as the accepted state:
  // a manager closing its last child took the window bar down, and a reviewer
  // pane a CHILD had opened on the same window (invisible to this registry)
  // lost its border with it. Both halves of that are gone (2026-09-17, user
  // decision) — the bar is never taken down, so there is nothing left to
  // misfire on. What remains worth pinning is the shape that produced it: a
  // manager with zero live children closing one.
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  const child = world.runtime().children[0]!;

  await world.call("orchestrator_close", { childId: child.id });

  assert.deepEqual(
    tmuxLog(world).filter((line) => line.startsWith("setw") && line.includes("-u")),
    [],
    "its own registry is empty and nothing is taken down — the gap is closed by removal, not by a fix",
  );
  assert.equal(
    world.runtime().children.filter((c) => !c.closedAt).length,
    0,
    "the set that used to drive the release: its own children, none left",
  );
});

