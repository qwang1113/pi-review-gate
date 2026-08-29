/**
 * ROUND 3 — the defects the third end-to-end orchestration run measured.
 *
 * That run finished both routes without a human ever pressing a key for the
 * project manager, and 15 of the previous round's 30 fixes were confirmed in
 * the field. It found ONE fatal gap and a handful of expensive ones, and each
 * gets a test here that names it:
 *
 *   R3-5  a child that had `declare_done` accepted was classified `working`
 *         and produced NO event for 725 seconds — completion had no criterion
 *         at all, and "is it running" was matched against the whole screen;
 *   R3-1  constraint 8 refused a documentation goal for QUOTING the modules
 *         it documents, forcing two proxy approvals to bypass the check;
 *   R3-2  a boolean `approveGoal: true` was told its "text" disagreed with
 *         the sidecar;
 *   R3-3  events for answered dialogs and CLOSED children still woke the
 *         supervisor, contradicting the snapshot in their own receipt;
 *   R3-4  the dialog title in that snapshot was the last line of the question;
 *   R3-6  a parallel lane's base branch degraded to the gate's own scratch
 *         branch, so the lane's output never reached the orchestration base.
 *
 * (R3-7, the merge that could not run in a linked worktree, is a pure module
 * of its own: test/worktree-merge.test.ts.)
 *
 * The `done` criterion and the activity-signal fix are tested TWICE on
 * purpose: once as pure functions fed fake screens (no tmux at all), because
 * the failing case is "text that scrolled by an hour ago", and once through
 * the tools against the fake terminal, because the previous round shipped
 * 1918 green unit tests and still deadlocked on the first real hop.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVITY_TAIL_LINES,
  DONE_REPORT_LIMIT,
  DONE_REWAKE_MS,
  IDLE_AFTER_MS,
  classifyChildState,
  decideChildEvent,
  formatChildHealth,
  screenLooksBusy,
  type ChildObservation,
} from "../lib/orchestrator-child-state.ts";
import { parsePaneSnapshot } from "../lib/orchestrator-pane-read.ts";
import { ORCH_BASE_BRANCH_ENV } from "../lib/gate-state.ts";
import { fakeOrchestration, replyText as text, samplePlan } from "./helpers/fake-orchestration.ts";

const AT = 1_000_000;

/** A screen with a long transcript above a quiet composer. */
function screenWith(history: readonly string[], tail: readonly string[]): string {
  return [...history, ...tail].join("\n");
}

/** One observation, with only the fields a test cares about spelled out. */
function observation(overrides: Partial<ChildObservation> = {}): ChildObservation {
  return {
    childId: "c1",
    paneAlive: true,
    at: AT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// R3-5a — "is it running" may only look at the bottom of the screen
// ---------------------------------------------------------------------------

test("R3-5a: `Working` printed an hour ago is not `working` now — only the tail counts", () => {
  // THE MEASURED SCREEN. A finished child's pane still holds everything it
  // ever printed, including the activity indicators of every turn it ran. The
  // old check was `text.includes(sig)`, so this screen matched forever.
  const screen = screenWith(
    [
      "> 开始干活",
      "Working (12s · esc to interrupt)",
      "· 改了 lib/plan/state.ts",
      "Thinking…",
      // …and then a normal amount of output scrolled past, which is what puts
      // those indicators out of reach of a live reading.
      ...Array.from({ length: ACTIVITY_TAIL_LINES }, (_unused, i) => `· 第 ${i + 1} 条日志`),
      "review-gate: done accepted. 任务完成，工作分支已合并。",
    ],
    ["", "> ", "▶ reviewer | # Task for reviewer | 1529306s"],
  );
  assert.equal(screenLooksBusy(screen), false, "the indicators are all in the scrollback");

  // …and a live indicator in the tail is still seen.
  const busy = screenWith(["> 开始干活", "· 读文件"], ["Working (3s · esc to interrupt)", "> "]);
  assert.equal(screenLooksBusy(busy), true, "an indicator near the composer means it IS running");
});

test("R3-5a: trailing blank lines do not push the live indicator out of the window", () => {
  const padded = screenWith(
    ["> 开始", "Working (3s · esc to interrupt)"],
    Array.from({ length: ACTIVITY_TAIL_LINES }, () => ""),
  );
  assert.equal(screenLooksBusy(padded), true,
    "a capture that ends in blank rows must not read as 'stopped' — that interrupts real work");
});

// ---------------------------------------------------------------------------
// R3-5b — completion is a criterion, and it produces an event
// ---------------------------------------------------------------------------

test("R3-5b: a child whose sidecar records `declare_done` is `done`, even with Working in its scrollback", () => {
  const screen = screenWith(
    [
      "Working (12s · esc to interrupt)",
      ...Array.from({ length: ACTIVITY_TAIL_LINES }, (_unused, i) => `· 第 ${i + 1} 条日志`),
      "review-gate: done accepted.",
    ],
    ["", "> "],
  );
  const fingerprint = classifyChildState(observation({ screenText: screen }), {}).memory;
  // Second reading: the screen has not moved since the first one.
  const verdict = classifyChildState(
    observation({
      screenText: screen,
      sidecar: { completedAt: "2026-08-30T04:20:00.000Z", judgeRunning: false },
    }),
    fingerprint,
  );
  assert.equal(verdict.state, "done", "this was `working` for 725 seconds in the third run");
  assert.match(verdict.reason, /sidecar/, "and the reason names the structured fact, not the screen");
});

test("R3-5b: completion does NOT outrank a question — a finished child that is asked something waits", () => {
  const verdict = classifyChildState(
    observation({
      screenText: "问题在此\n  A\n  B",
      dialogOpen: true,
      dialogTitle: "还要再跑一轮吗？",
      sidecar: { completedAt: "2026-08-30T04:20:00.000Z" },
    }),
    { fingerprint: "问题在此\n A\n B", changedAt: AT - 10_000 },
  );
  assert.equal(verdict.state, "waiting-input", "somebody's turn to act outranks a terminal state");
});

test("R3-5b: a completed child that was re-tasked is `working` again", () => {
  const first = classifyChildState(
    observation({ screenText: "旧屏幕", sidecar: { completedAt: "2026-08-30T04:20:00.000Z" } }),
    {},
  );
  const second = classifyChildState(
    observation({
      screenText: "新的一轮开始了",
      sidecar: { completedAt: "2026-08-30T04:20:00.000Z" },
    }),
    first.memory,
  );
  assert.equal(second.state, "working", "the completion record is history; the screen moved");
});

test("R3-5b: `done` rings twice and then goes quiet (user decision, option C)", () => {
  const screen = "review-gate: done accepted.\n> ";
  const settledMemory = classifyChildState(observation({ screenText: screen }), {}).memory;
  const verdict = classifyChildState(
    observation({ screenText: screen, sidecar: { completedAt: "2026-08-30T04:20:00.000Z" } }),
    settledMemory,
  );
  assert.equal(verdict.state, "done");

  const first = decideChildEvent(verdict, "working", AT);
  assert.equal(first.raise, true, "entering `done` is exactly when a supervisor must be woken");

  const tooSoon = decideChildEvent({ ...verdict, memory: first.memory }, "done", AT + 5_000);
  assert.equal(tooSoon.raise, false, "a terminal state does not nag");

  const second = decideChildEvent({ ...verdict, memory: first.memory }, "done", AT + DONE_REWAKE_MS);
  assert.equal(second.raise, true, "…but one missed event must not lose the completion");

  const third = decideChildEvent({ ...verdict, memory: second.memory }, "done", AT + 10 * DONE_REWAKE_MS);
  assert.equal(third.raise, false, `at most ${DONE_REPORT_LIMIT} rings`);
});

test("R3-5b: an idle child is still idle — `done` never swallows the 'stopped without declaring' case", () => {
  const screen = "什么都没发生\n> ";
  const memory = classifyChildState(observation({ screenText: screen }), {}).memory;
  const verdict = classifyChildState(
    observation({ screenText: screen, at: AT + IDLE_AFTER_MS }),
    memory,
  );
  assert.equal(verdict.state, "idle");
  assert.match(verdict.reason, /并没有报告 declare_done/);
});

// ---------------------------------------------------------------------------
// R3-5 through the tools: the event, and the registry fact behind it
// ---------------------------------------------------------------------------

test("R3-5: `orchestrator_wait` returns on the completion, and the registry records doneAt", async () => {
  const h = fakeOrchestration({ plan: samplePlan(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a", task: "干活 a" });
  const child = h.runtime().children[0]!;
  // Its pane still shows the whole session, activity indicators included —
  // this is the exact screen that produced no event for 725 seconds.
  h.panes.get(child.paneId)!.printed = [
    "Working (30s · esc to interrupt)",
    ...Array.from({ length: ACTIVITY_TAIL_LINES }, (_unused, i) => `· 第 ${i + 1} 条日志`),
    "review-gate: done accepted. 全部完成。",
  ];
  h.setSidecar(child.cwd, child.stateVariant, {
    completion: { at: "2026-08-30T04:20:00.000Z", merge: "merged" },
  });
  h.deps.probe().observe();
  h.advance(5_000);

  const waited = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(waited.details?.done, true, "completion is the moment a supervisor most needs waking");
  assert.match(text(waited), /done/);
  assert.match(text(waited), new RegExp(child.id));
  assert.ok(h.runtime().children[0]!.doneAt,
    "markChildDone had NO caller before this round: doneAt was never set, and every reader of it was dead code");
});

// ---------------------------------------------------------------------------
// R3-1 — constraint 8 is judged on landings, and watched continuously
// ---------------------------------------------------------------------------

test("R3-1: a child that edits outside its boundary produces an event naming the files", async () => {
  const h = fakeOrchestration({ plan: samplePlan(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a", task: "干活 a" });
  const child = h.runtime().children[0]!;
  h.setSidecar(child.cwd, child.stateVariant, {
    sessionEditedFiles: ["lib/plan/state.ts", "extensions/review-gate.ts"],
  });

  const events = h.deps.probe().observe().events;
  const breach = events.find((e) => e.kind === "boundary-breach");
  assert.ok(breach, "the approval no longer reads the goal text, so the LANDINGS must be watched");
  assert.deepEqual(breach!.paths, ["extensions/review-gate.ts"]);
  assert.match(breach!.reason, /约束 8/);

  // The same standing breach must not ring on every probe…
  h.advance(30_000);
  const again = h.deps.probe().observe().events.filter((e) => e.kind === "boundary-breach");
  assert.equal(again.length, 0, "a known breach is not news every ten seconds");

  // …while a NEW file is news immediately.
  h.setSidecar(child.cwd, child.stateVariant, {
    sessionEditedFiles: ["lib/plan/state.ts", "extensions/review-gate.ts", "hooks/pre-commit"],
  });
  const fresh = h.deps.probe().observe().events.filter((e) => e.kind === "boundary-breach");
  assert.deepEqual(fresh[0]?.paths, ["hooks/pre-commit"]);
});

test("R3-1: the health snapshot names the out-of-boundary landings", () => {
  const rendered = formatChildHealth([{
    childId: "c1",
    taskId: "a",
    paneId: "%2",
    state: "working",
    reason: "在跑",
    outsideBoundaries: ["extensions/review-gate.ts"],
  }]);
  assert.match(rendered, /越界落点/);
  assert.match(rendered, /extensions\/review-gate\.ts/);
});

// ---------------------------------------------------------------------------
// R3-2 — a receipt may not describe text the caller never passed
// ---------------------------------------------------------------------------

test("R3-2: `approveGoal: true` is never told its 'text' disagrees with the sidecar", async () => {
  const h = fakeOrchestration({ plan: samplePlan(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a", task: "干活 a" });
  const child = h.runtime().children[0]!;
  h.setSidecar(child.cwd, child.stateVariant, {
    goalPrereview: { verdict: "PASS", at: "now", draft: "退出标准 1..7，只动 lib/plan" },
    sessionEditedFiles: ["lib/plan/state.ts"],
  });
  h.openDialog(child.paneId, "认可这个 goal 吗？", ["Yes", "No"]);

  const reply = await h.call("orchestrator_send", { childId: child.id, approveGoal: true });
  assert.notEqual(reply.isError, true, text(reply));
  assert.equal(reply.details?.approved, true);
  assert.doesNotMatch(text(reply), /不一致/,
    "the caller passed a boolean — telling it its copy is stale sends it to re-read for nothing");
});

// ---------------------------------------------------------------------------
// R3-3 — an event that no longer describes reality is not news
// ---------------------------------------------------------------------------

test("R3-3: a queued event for a CLOSED child is dropped, and named rather than swallowed", async () => {
  const h = fakeOrchestration({ plan: samplePlan(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a", task: "干活 a" });
  const child = h.runtime().children[0]!;
  h.panes.get(child.paneId)!.printed = ["> 我干完了，等你的下一步"];
  h.deps.probe().observe();
  h.advance(IDLE_AFTER_MS + 1_000);
  const raised = h.deps.probe().observe().events;
  assert.ok(raised.length > 0, "the idle child rang");

  await h.call("orchestrator_close", { childId: child.id });
  const drained = h.deps.probe().drain();
  assert.equal(drained.events.length, 0, "a closed child cannot have anything for the supervisor");
  assert.equal(drained.stale.length, raised.length);
  assert.match(drained.stale[0]!.reason, /已经关闭/);
});

test("R3-3: an event whose state has since changed is dropped, not delivered", async () => {
  const h = fakeOrchestration({ plan: samplePlan(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a", task: "干活 a" });
  const child = h.runtime().children[0]!;
  h.panes.get(child.paneId)!.printed = ["> 我干完了，等你的下一步"];
  h.deps.probe().observe();
  h.advance(IDLE_AFTER_MS + 1_000);
  assert.ok(h.deps.probe().observe().events.length > 0, "it went idle and rang");

  // The child starts working again before anybody drains the queue.
  h.panes.get(child.paneId)!.printed.push("Working (2s · esc to interrupt)");
  h.advance(1_000);
  h.deps.probe().observe();

  const drained = h.deps.probe().drain();
  assert.equal(drained.events.length, 0, "the receipt must not contradict its own health snapshot");
  assert.match(drained.stale[0]!.reason, /working/);
});

// ---------------------------------------------------------------------------
// R3-4 — the dialog title is the question, not its last line
// ---------------------------------------------------------------------------

test("R3-4: an interview's title is the question's subject, not the tail of its prose", () => {
  const screen = [
    "上面是别的输出",
    "",
    "问题 2 / 3",
    "这一轮的模块划分怎么切？（只讨论表格，不解释判据成因）",
    "我推荐 A：单模块 + 两个 helper。",
    "→ A) 单模块",
    "  B) 两个模块",
    "  C) 单模块 + 把三个私有 helper 再拆到第三个文件里凑数。",
    "↑/↓ 选择 · Enter 确认 · Esc 取消",
  ].join("\n");
  const snapshot = parsePaneSnapshot(screen);
  assert.equal(snapshot.dialog?.options.length, 3, "the options still parse");
  assert.match(snapshot.dialog?.title ?? "", /这一轮的模块划分怎么切/,
    "the third run showed '论表格，不解释判据成因）。我推荐 A：…' here");
});

test("R3-4: without a progress header the nearest line is still used — a wrong title is worse than a fragment", () => {
  const screen = [
    "把当前分支作为基准分支吗？",
    "→ 是",
    "  否",
    "↑/↓ 选择 · Enter 确认 · Esc 取消",
  ].join("\n");
  assert.equal(parsePaneSnapshot(screen).dialog?.title, "把当前分支作为基准分支吗？");
});

// ---------------------------------------------------------------------------
// R3-6 — a lane's base branch is DECLARED by its supervisor
// ---------------------------------------------------------------------------

test("R3-6: a spawned child is told the orchestration's base branch", async () => {
  const h = fakeOrchestration({
    plan: samplePlan(),
    approved: true,
    currentBranch: "refactor/gate-heavy-agent-light",
  });
  await h.call("orchestrator_spawn", { taskId: "b", task: "并行任务" });
  const spawn = h.tmuxCalls.find((argv) => argv[0] === "split-window")!;
  const injected = spawn.join(" ");
  assert.match(injected, new RegExp(`${ORCH_BASE_BRANCH_ENV}=refactor/gate-heavy-agent-light`),
    "without this the child defaults its base to the gate's own orch/ branch and the lane stops there");
});
