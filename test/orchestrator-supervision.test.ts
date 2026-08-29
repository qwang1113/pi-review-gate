/**
 * SUPERVISION, end to end against a fake terminal — the capability the second
 * orchestration run did not have.
 *
 * That run finished, and only because a human ran the supervision by hand all
 * night: `tmux capture-pane` in a loop, an eyeball verdict on each child, an
 * Escape when the project manager itself went silent. Its conclusion names
 * one blocker — "the project manager cannot reliably know what a child is
 * doing" — and these tests are that blocker, one defect per test.
 *
 * WHY THEY ARE PROTOCOL TESTS. The previous round shipped 1918 green unit
 * tests and deadlocked on the first real hop, because every defect lived in
 * the seam between a decision and the world. So nothing here stubs a
 * decision: the tools run against test/helpers/fake-orchestration.ts, whose
 * panes behave like panes — a dialog renders its key-hint footer, a narrow
 * pane wraps a long option, a renderer can refuse plain `Enter`, and the
 * clock only moves when a test moves it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { fakeOrchestration, replyText as text, samplePlan } from "./helpers/fake-orchestration.ts";
import { IDLE_AFTER_MS } from "../lib/orchestrator-child-state.ts";

/** Spawn task `a` and hand back the harness plus the registered child. */
async function spawned(options: Parameters<typeof fakeOrchestration>[0] = {}) {
  const h = fakeOrchestration({ plan: samplePlan(), approved: true, ...options });
  await h.call("orchestrator_spawn", { taskId: "a", task: "把 lib/plan 拆出来" });
  return { h, child: h.runtime().children[0]! };
}

/** Let the probe take a first reading, then move the clock past a threshold. */
async function settle(h: Awaited<ReturnType<typeof spawned>>["h"], ms: number): Promise<void> {
  h.deps.probe().observe();
  h.advance(ms);
}

// ---------------------------------------------------------------------------
// R-16 — the wait that swallowed its own events
// ---------------------------------------------------------------------------

test("R-16: an attention event whose dialog is OPEN ends the wait at once, and names the child", async () => {
  const { h, child } = await spawned();
  h.openDialog(child.paneId, "把当前分支作为基准分支吗？", ["是", "否"]);
  h.pushAttention({ toSessionId: "orch-abc-1", fromPane: child.paneId, reason: "等待回答提问" });

  const waited = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(waited.details?.done, true, "the event must not be consumed and then held");
  assert.equal(waited.details?.childId, child.paneId);
  assert.match(text(waited), /等待回答提问/);
  // R-4 — every reply carries the whole snapshot, so "which one of them wants
  // me" never costs another tool call.
  assert.match(text(waited), /健康快照/);
  assert.match(text(waited), new RegExp(child.id));
});

test("R-16: an event the gate CANNOT verify is still news — silence is never the safe side", async () => {
  const { h, child } = await spawned();
  h.pushAttention({ toSessionId: "orch-abc-1", fromPane: child.paneId, reason: "等待回答提问" });
  // The screen cannot be read at all (the exact condition under which the old
  // waiter concluded "no dialog ⇒ already settled" and kept waiting).
  const realTmux = h.deps.tmux;
  h.deps.tmux = (argv) => (argv[0] === "capture-pane"
    ? { ok: false, stdout: "", stderr: "can't read pane" }
    : realTmux(argv));

  const waited = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(waited.details?.done, true, "an unverifiable request must still wake the supervisor");
  assert.equal(waited.details?.reason, "attention");
});

test("R-16: an event written off as settled is REPORTED, and the probe rings again later", async () => {
  const { h, child } = await spawned();
  // The user answered the dialog in the pane themselves: no dialog left, and
  // the child is visibly working again.
  h.panes.get(child.paneId)!.printed.push("answered: 是", "Context 5% · esc to interrupt");
  h.pushAttention({ toSessionId: "orch-abc-1", fromPane: child.paneId, reason: "等待回答提问" });

  const waited = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(waited.details?.done, false, "a genuinely settled matter is not news");
  assert.equal(waited.details?.settled, 1, "but it is COUNTED");
  assert.match(text(waited), /已经办成/, "and named, so nothing vanishes silently");
  assert.match(text(waited), /10s→30s→60s/, "with the promise that a real one would ring again");
});

// ---------------------------------------------------------------------------
// R-23 — the two states that never produced an event at all
// ---------------------------------------------------------------------------

test("R-23: a child that quietly STOPS wakes the supervisor, with no event from the child", async () => {
  const { h, child } = await spawned();
  // Nothing on screen but a finished turn: no dialog, no "esc to interrupt",
  // and nothing changing. This is the state the hand-run could only find by
  // grepping the pane every few seconds.
  h.panes.get(child.paneId)!.printed = ["> 我把 lib/plan 拆完了", "等你的下一步"];
  await settle(h, IDLE_AFTER_MS + 1000);

  const waited = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(waited.details?.done, true);
  assert.equal(waited.details?.reason, "probe", "the GATE manufactured this event");
  assert.equal(waited.details?.childId, child.id);
  assert.match(text(waited), /idle/);
  assert.equal(h.attention.length, 0, "and the child never rang: there was nothing to ring about");
});

test("R-23: a frozen screen is NOT idle while a judge round is in flight", async () => {
  const { h, child } = await spawned();
  // The measured counter-example: a child blocked in `judge_wait` for 550s
  // has a frozen screen and a frozen token counter, and interrupting it would
  // abort a healthy review round.
  h.panes.get(child.paneId)!.printed = ["等待 reviewer 本轮结束（已耗时 550s）"];
  h.setJudgeRunning(child.cwd, true);
  await settle(h, IDLE_AFTER_MS * 3);

  const waited = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(waited.details?.done, false, "a working child must never be reported as stopped");
  assert.match(text(waited), /working/);
  assert.match(text(waited), /judge 子进程/, "and the reason names the structured fact it used");
});

test("R-16: waiting on ONE child never discards what the gate learned about the others", async () => {
  const h = fakeOrchestration({ plan: samplePlan(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a", task: "串行任务" });
  await h.call("orchestrator_spawn", { taskId: "b", task: "并行任务" });
  const [first, second] = h.runtime().children;
  h.openDialog(first!.paneId, "A 在问", ["Yes", "No"]);
  h.openDialog(second!.paneId, "B 也在问", ["Yes", "No"]);
  await settle(h, 5_000);

  // A wait scoped to the FIRST child must not eat the second one's event: a
  // dropped event is a child left waiting in front of a dialog forever, which
  // is exactly the failure this round exists to end.
  const scoped = await h.call("orchestrator_wait", { childId: first!.id, timeoutMs: 1000 });
  assert.equal(scoped.details?.childId, first!.id);

  const rest = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(rest.details?.done, true, "the sibling's request survived");
  assert.equal(rest.details?.childId, second!.id);
});


test("R-23: a pane that vanished is reported as dead, by name", async () => {
  const { h, child } = await spawned();
  h.killPane(child.paneId);
  const waited = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(waited.details?.done, true);
  assert.equal(waited.details?.childId, child.id);
  assert.match(text(waited), /dead/);
});

test("R-16/R-23: an unanswered dialog RINGS AGAIN on the backoff instead of going quiet", async () => {
  const { h, child } = await spawned();
  h.openDialog(child.paneId, "选一个", ["A", "B"]);
  await settle(h, 5_000);

  const first = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(first.details?.done, true, "entering waiting-input is news");
  assert.match(text(first), /waiting-input/);

  // Immediately after, the same unanswered dialog is NOT re-reported…
  const quiet = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(quiet.details?.done, false, "it does not spam once it has been reported");

  // …until the first backoff step (10s) has passed.
  h.advance(11_000);
  const again = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  assert.equal(again.details?.done, true, "an unresolved request comes back");
  assert.equal(again.details?.childId, child.id);
});

// ---------------------------------------------------------------------------
// R-1 / R-9 / R-12 / R-18 — reading the screen
// ---------------------------------------------------------------------------

test("R-1/R-9: the belowEditor widget is NOT a dialog, and the gate refuses to press at it", async () => {
  const { h, child } = await spawned();
  // The exact pane that deadlocked the run: a sub-agent widget carrying the
  // `▶` glyph, and no dialog anywhere.
  h.panes.get(child.paneId)!.widget = "▶ reviewer | # Task for reviewer | 1517537s";
  h.panes.get(child.paneId)!.printed.push("did not create, and");

  const read = await h.call("orchestrator_read", { childId: child.id });
  assert.equal(read.details?.dialogOptions, 0, "no footer ⇒ no dialog, however many glyphs are on screen");
  assert.match(text(read), /没有识别出选项式对话框/);

  const pressed = await h.call("orchestrator_key", { childId: child.id, index: 1 });
  assert.equal(pressed.isError, true, "pressing at a widget row is exactly what must not happen");
});

test("R-1: a REAL dialog under the same widget is parsed, and answerable", async () => {
  const { h, child } = await spawned();
  h.panes.get(child.paneId)!.widget = "▶ reviewer | # Task for reviewer | 1517537s";
  h.openDialog(child.paneId, "把当前分支 refactor/x 作为本会话的基准分支吗？", [
    "是，基准分支 = refactor/x",
    "否，我自己选",
  ]);

  const read = await h.call("orchestrator_read", { childId: child.id });
  assert.equal(read.details?.dialogOptions, 2, "the widget below the footer is cut away, the rows are not");

  const answered = await h.call("orchestrator_key", { childId: child.id, match: "是，基准分支" });
  assert.notEqual(answered.isError, true, text(answered));
  assert.match(h.render(child.paneId), /answered: 是，基准分支/);
});

test("R-12: an option that WRAPPED in a narrow pane is still selectable", async () => {
  const { h, child } = await spawned();
  h.panes.get(child.paneId)!.width = 59;
  h.openDialog(child.paneId, "怎么办", [
    "A 等其他会话修根因",
    "B 你自己修",
    "C 不修根因，你给一条先交付文档的路",
  ], 0);

  const read = await h.call("orchestrator_read", { childId: child.id });
  assert.equal(read.details?.dialogOptions, 3, "a wrapped row is one row, not a lost one");

  const answered = await h.call("orchestrator_key", { childId: child.id, match: "C 不修根因" });
  assert.notEqual(answered.isError, true, text(answered));
  assert.match(h.render(child.paneId), /answered: C 不修根因/, "the option the USER picked really landed");
});

test("R-18: a capture that comes back mid-repaint is RETRIED, not turned into a refusal", async () => {
  const { h, child } = await spawned();
  h.openDialog(child.paneId, "认可这个 goal 吗？", ["Yes", "No"]);
  // The first capture lands mid-repaint (blank screen), the next one is fine.
  const realTmux = h.deps.tmux;
  let captures = 0;
  h.deps.tmux = (argv) => {
    if (argv[0] === "capture-pane") {
      captures += 1;
      if (captures === 1) return { ok: true, stdout: "", stderr: "" };
    }
    return realTmux(argv);
  };

  const answered = await h.call("orchestrator_key", { childId: child.id, index: 1 });
  assert.notEqual(answered.isError, true, text(answered));
  assert.match(h.render(child.paneId), /answered: Yes/);
});

// ---------------------------------------------------------------------------
// R-8 / R-5 — submitting an answer
// ---------------------------------------------------------------------------

test("R-8: a dialog that ignores Enter is still answered — the gate picks the key, not the caller", async () => {
  const { h, child } = await spawned();
  // Measured on a real pi confirmation dialog: `Enter` and `C-m` did nothing,
  // only `KPEnter` submitted.
  h.panes.get(child.paneId)!.submitKey = "KPEnter";
  h.openDialog(child.paneId, "认可这个 goal 吗？", ["Yes", "No"]);

  const answered = await h.call("orchestrator_key", { childId: child.id, index: 1 });
  assert.notEqual(answered.isError, true, text(answered));
  assert.match(h.render(child.paneId), /answered: Yes/);
  assert.deepEqual(answered.details?.submitKeysTried, ["enter", "kpenter"], "Enter first, then the one that works");
});

test("R-8: a low-level key that changes NOTHING says so, instead of reading as delivered", async () => {
  const { h, child } = await spawned();
  h.panes.get(child.paneId)!.submitKey = "KPEnter";
  h.openDialog(child.paneId, "认可这个 goal 吗？", ["Yes", "No"]);

  const pressed = await h.call("orchestrator_key", { childId: child.id, keys: ["enter"] });
  assert.notEqual(pressed.isError, true);
  assert.equal(pressed.details?.screenChanged, false);
  assert.match(text(pressed), /完全没有变化/, "the fact the old receipt withheld for 600s");
  assert.match(h.render(child.paneId), /认可这个 goal 吗/, "and the dialog is indeed untouched");
});

test("R-5: answering question 1 of an interview is a SUCCESS, even though question 2 opens at once", async () => {
  const { h, child } = await spawned();
  const pane = h.panes.get(child.paneId)!;
  pane.queuedDialogs = [{ title: "2 / 3 下一题", options: ["甲", "乙"], selected: 0 }];
  h.openDialog(child.paneId, "1 / 3 选一个", ["C 域叙述 + 末尾全量速查表", "别的"], 0);

  const answered = await h.call("orchestrator_key", { childId: child.id, index: 1 });
  assert.notEqual(answered.isError, true, text(answered));
  assert.equal(answered.details?.submitted, true);
  assert.match(text(answered), /换成了另一个框/, "the new dialog is reported, not mistaken for a failure");
  assert.match(h.render(child.paneId), /2 \/ 3 下一题/);
});

// ---------------------------------------------------------------------------
// R-13 / R-14 / R-20 — delivering something to a child
// ---------------------------------------------------------------------------

test("R-13: text is REFUSED while a dialog is open — the accident that answered for the child", async () => {
  const { h, child } = await spawned();
  h.openDialog(child.paneId, "【阻塞·需要拍板】怎么办", ["A 等其他会话修根因", "C 先交付文档"], 0);

  const sent = await h.call("orchestrator_send", { childId: child.id, message: "用户拍的是 C，请照 C 做" });
  assert.equal(sent.isError, true);
  assert.equal(sent.details?.dialogOpen, true);
  assert.match(text(sent), /R-13/);
  assert.match(h.render(child.paneId), /【阻塞·需要拍板】/, "nothing was answered on the child's behalf");
});

test("R-14: a message that lands in the steering QUEUE is delivered, and the lane is named", async () => {
  const { h, child } = await spawned();
  const pane = h.panes.get(child.paneId)!;
  // A busy child files the message instead of showing it in the composer.
  const realTmux = h.deps.tmux;
  h.deps.tmux = (argv) => {
    const result = realTmux(argv);
    if (argv[0] === "send-keys" && argv.includes("-l")) {
      pane.buffer = "";
      pane.printed.push("Steering: 项目经理给你发了一份说明，请先完整读一遍再继...");
    }
    return result;
  };

  const sent = await h.call("orchestrator_send", { childId: child.id, message: "读一下这个" });
  assert.notEqual(sent.isError, true, text(sent));
  assert.equal(sent.details?.lane, "queued", "the queue is a delivery, not a failure");
  assert.match(text(sent), /steering 队列/);
});

test("R-20: a COMMAND is not sent to a busy child — it would become a message and never run", async () => {
  const { h, child } = await spawned();
  h.panes.get(child.paneId)!.printed.push("Context 12% · esc to interrupt");

  const sent = await h.call("orchestrator_send", {
    childId: child.id,
    kind: "command",
    message: "/gate-bypass 环境变量污染了测试子进程",
  });
  assert.equal(sent.isError, true);
  assert.equal(sent.details?.delivered, false, "nothing was typed: a half-delivered command is worse than none");
  assert.match(text(sent), /不会\*\*被执行|不会被执行/);
});

test("R-20/R-24: the same command IS delivered when the child is idle, and the gate waits for that window itself", async () => {

  const { h, child } = await spawned();
  h.panes.get(child.paneId)!.printed = ["> 等你的下一步"];

  const sent = await h.call("orchestrator_send", {
    childId: child.id,
    kind: "command",
    message: "/gate-bypass 环境变量污染了测试子进程",
  });
  assert.notEqual(sent.isError, true, text(sent));
  assert.equal(sent.details?.lane, "submitted");
  assert.equal(sent.details?.executed, true);
  assert.match(h.render(child.paneId), /\/gate-bypass/);
});

// ---------------------------------------------------------------------------
// R-17 — the supervisor never has to run tmux by hand again
// ---------------------------------------------------------------------------

test("R-11: read and status both print the PROBE's verdict, not an invitation to guess", async () => {
  const { h, child } = await spawned();
  // A pane that a human read as "terminated" during the real run while the
  // child was in fact working (it was mid-precommit).
  h.panes.get(child.paneId)!.printed.push("precommit FAIL — 正在读 .pi/precommit-last.log", "esc to interrupt");

  const read = await h.call("orchestrator_read", { childId: child.id });
  assert.equal(read.details?.state, "working", "the tool answers the question, rather than showing a screen");
  assert.match(text(read), /门禁探针判定的状态/);

  const status = await h.call("orchestrator_status", {});
  assert.match(text(status), /子会话现在在干什么/);
  assert.match(text(status), new RegExp(child.id));
});


test("R-17: ONE wait answers everything the hand-rolled capture-pane loop was for", async () => {
  const h = fakeOrchestration({ plan: samplePlan(), approved: true });
  await h.call("orchestrator_spawn", { taskId: "a", task: "串行任务" });
  await h.call("orchestrator_spawn", { taskId: "b", task: "并行任务" });
  const [first, second] = h.runtime().children;
  // Two children in different situations — exactly the night the report
  // describes, where the supervisor polled both panes by hand every few
  // seconds because no tool would tell it this.
  h.openDialog(first!.paneId, "认可这个 goal 吗？", ["Yes", "No"]);
  h.panes.get(second!.paneId)!.printed.push("Context 30% · esc to interrupt");
  await settle(h, 5_000);

  const waited = await h.call("orchestrator_wait", { timeoutMs: 1000 });
  const reply = text(waited);
  for (const child of [first!, second!]) {
    assert.match(reply, new RegExp(child.id), `${child.id} is in the snapshot`);
  }
  assert.match(reply, /waiting-input/, "the one that needs an answer is named as such");
  assert.match(reply, /working/, "and the one that is fine is not dragged into it");
  assert.match(reply, /当前框「认可这个 goal 吗？」/, "including WHAT it is waiting on");
  const health = waited.details?.health as Array<{ childId: string; state: string }>;
  assert.equal(health.length, 2, "the snapshot is structured too, not only prose");
});


// ---------------------------------------------------------------------------
// R-28 — closing a child must not break the repository
// ---------------------------------------------------------------------------

test("R-28: a worktree the repo's git hooks point INTO is repaired BEFORE it is removed", async () => {
  const h = fakeOrchestration({ plan: samplePlan(), approved: true, hooksPointAtWorktree: "/tmp/wt/b" });
  await h.call("orchestrator_spawn", { taskId: "b", task: "并行任务" });
  const child = h.runtime().children[0]!;
  assert.equal(child.worktree, "/tmp/wt/b", "a parallel lane gets its own worktree");

  const closed = await h.call("orchestrator_close", { childId: child.id });
  assert.notEqual(closed.isError, true, text(closed));
  assert.equal(h.hookRepairs(), 1, "the hooks were re-pointed at the main worktree first");
  assert.deepEqual(h.removed, ["/tmp/wt/b"], "and only THEN was the worktree removed");
  assert.match(text(closed), /R-28/);
});

test("R-28: if the hooks cannot be repaired, the worktree is NOT removed and the pane stays", async () => {
  const h = fakeOrchestration({
    plan: samplePlan(),
    approved: true,
    hooksPointAtWorktree: "/tmp/wt/b",
    hookRepairFails: true,
  });
  await h.call("orchestrator_spawn", { taskId: "b", task: "并行任务" });
  const child = h.runtime().children[0]!;

  const closed = await h.call("orchestrator_close", { childId: child.id });
  assert.equal(closed.isError, true, "breaking the whole repository is not an acceptable cleanup");
  assert.deepEqual(h.removed, [], "the resource other sessions depend on is left alone");
  assert.match(text(closed), /install-git-hooks\.sh/, "and the human is told exactly how to fix it");
});
