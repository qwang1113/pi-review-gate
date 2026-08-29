/**
 * The ATOMS the orchestration layer was missing, and the rules it got wrong.
 *
 * Everything here is a pure decision: text in, structure out. The protocol
 * test (test/orchestrator-protocol.test.ts) proves the tools use these rules
 * correctly against a simulated terminal; this file proves the rules
 * themselves, one defect at a time.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  dialogIsOpen,
  dialogSignature,
  parsePaneSnapshot,
  readStartupEvidence,
  describeStartupEvidence,
  findDialogFooter,
  formatPaneSnapshot,
} from "../lib/orchestrator-pane-read.ts";

import {
  APPROVE_LABEL_PATTERN,
  normalizeKey,
  describeScreenChange,
  SUBMIT_KEY_ORDER,
  TMUX_KEY_NAMES,

  normalizeKeySequence,
  planMoveKeys,
  planSelection,
  resolveSelectionTarget,
  verifyDismissed,
  verifyHighlight,
} from "../lib/orchestrator-keys.ts";
import {
  buildChildCommand,
  buildTaskDocument,
  deliveryVerdict,
  echoMarker,
  planSend,
  SEND_INLINE_MAX_CHARS,
} from "../lib/orchestrator-delivery.ts";
import {
  acceptAttention,
  clampChildWaitTimeout,
  evaluateChildWait,
  CHILD_WAIT_DEFAULT_MS,
  CHILD_WAIT_MAX_MS,
} from "../lib/orchestrator-wait.ts";
import { readFileSync } from "node:fs";
import { orchestratorWriteBlock, worktreeRequirement } from "../lib/orchestrator-gate.ts";
import { childGateFacts } from "../lib/orchestrator-tool-kit.ts";

import { nextDecisionId, parsePlan } from "../lib/orchestrator-plan.ts";
import { buildOrchestratorExitBlock } from "../lib/orchestrator-directives.ts";
import { sidecarPath, stateVariantFrom, STATE_VARIANT_ENV } from "../lib/gate-state.ts";
import { buildCapturePaneArgv, buildSendKeysArgv, UnsafeTmuxCommand } from "../lib/orchestrator-tmux.ts";
import type { AttentionEvent } from "../lib/attention.ts";

// ---------------------------------------------------------------------------
// F3 — reading the screen
// ---------------------------------------------------------------------------

/**
 * The key-hint footer every live choice list draws, and the ONLY thing that
 * makes this module report a dialog at all (R-1/R-9).
 */
const FOOTER = "  ↑↓ navigate  enter select  esc cancel";

/** Exactly how pi's own SelectList renders: `"→ "` selected, `"  "` not. */
const PI_CONFIRM = [
  "review-gate: 认可这个目标吗？",
  " 目标全文已显示在上方消息中。",
  "",
  "→ Yes",
  "  No",
  FOOTER,
].join("\n");


test("F3: a pi confirm dialog is parsed — including the row that carries NO glyph", () => {
  const snapshot = parsePaneSnapshot(PI_CONFIRM);
  assert.ok(snapshot.dialog, "the dialog is recognized");
  assert.deepEqual(snapshot.dialog!.options.map((o) => o.label), ["Yes", "No"]);
  assert.equal(snapshot.dialog!.selectedIndex, 1);
  assert.equal(dialogIsOpen(snapshot), true);
  // The unselected row is only findable by COLUMN, which is the whole point:
  // pi pads it with spaces to the width of the marker.
  assert.equal(snapshot.dialog!.options[1]!.selected, false);
});

test("F3: the LAST dialog on screen wins — an answered one above is scrollback", () => {
  const snapshot = parsePaneSnapshot([
    "→ 旧问题 A",
    "  旧问题 B",
    "answered: 旧问题 A",
    "",
    "新的问题",
    "  保留",
    "→ 丢弃",
    FOOTER,
  ].join("\n"));

  assert.deepEqual(snapshot.dialog!.options.map((o) => o.label), ["保留", "丢弃"]);
  assert.equal(snapshot.dialog!.selectedIndex, 2);
  assert.equal(snapshot.dialog!.title, "新的问题");
});

test("F3: a numbered list with no highlight is SHOWN but carries no selected index", () => {
  const snapshot = parsePaneSnapshot(["请选择：", "1. 第一项", "2. 第二项", FOOTER].join("\n"));

  assert.deepEqual(snapshot.dialog!.options.map((o) => o.label), ["第一项", "第二项"]);
  assert.equal(snapshot.dialog!.selectedIndex, undefined, "nothing may be pressed on this basis");
});

test("R-1/R-9: WITHOUT the key-hint footer there is no dialog — the widget row is not an option", () => {
  // The measured pane: a belowEditor sub-agent widget whose `▶` glyph the old
  // parser anchored on. Twice it merely invented a dialog out of nothing;
  // the third time a REAL dialog was on screen, the widget (further down the
  // pane) won, and `orchestrator_key` refused for an option list that did not
  // exist — with no way left to answer the child. 25 minutes of deadlock.
  const widgetOnly = parsePaneSnapshot([
    "did not create, and",
    "the tests still pass",
    "",
    "▶ reviewer | # Task for reviewer | 1517537s",
  ].join("\n"));
  assert.equal(widgetOnly.dialog, undefined, "a glyph is not a dialog");
  assert.equal(dialogIsOpen(widgetOnly), false);

  // The SAME widget under a real dialog changes nothing about the dialog.
  const withDialog = parsePaneSnapshot([
    "把当前分支作为本会话的基准分支吗？",
    "→ 是",
    "  否",
    FOOTER,
    "▶ reviewer | # Task for reviewer | 1517537s",
  ].join("\n"));
  assert.deepEqual(withDialog.dialog!.options.map((o) => o.label), ["是", "否"]);
  assert.equal(withDialog.dialog!.selectedIndex, 1);
});

test("R-12: a row that WRAPPED in a narrow pane is merged back into one option", () => {
  const snapshot = parsePaneSnapshot([
    "怎么办",
    "→ A 等其他会话修根因",
    "  B 你自己修",
    "  C 不修根因，你给一条先交",
    "付文档的路",
    FOOTER,
  ].join("\n"));
  assert.equal(snapshot.dialog!.options.length, 3, "three options, not two — the third is the one that wrapped");
  assert.match(snapshot.dialog!.options[2]!.label, /C 不修根因，你给一条先交付文档的路/);
});

test("R-5: the dialog SIGNATURE is what tells one question from the next", () => {
  const first = parsePaneSnapshot(["1 / 3 选一个", "→ 甲", "  乙", FOOTER].join("\n"));
  const same = parsePaneSnapshot(["1 / 3 选一个", "  甲", "→ 乙", FOOTER].join("\n"));
  const next = parsePaneSnapshot(["2 / 3 再选", "→ 甲", "  乙", FOOTER].join("\n"));
  assert.equal(dialogSignature(first.dialog), dialogSignature(same.dialog),
    "moving the highlight is not a different question");
  assert.notEqual(dialogSignature(first.dialog), dialogSignature(next.dialog));
  assert.equal(dialogSignature(undefined), undefined);
});


test("F3: ordinary prose is not a dialog, and the raw screen always comes back", () => {
  const prose = "正在读取文件\n分析中……\n没有问题";
  const snapshot = parsePaneSnapshot(prose);
  assert.equal(snapshot.dialog, undefined);
  assert.equal(dialogIsOpen(snapshot), false);
  assert.equal(snapshot.text, prose, "the agent can always read the screen itself");
  assert.match(formatPaneSnapshot(snapshot), /没有识别出选项式对话框/);
});

test("F3: an empty pane is empty — that is EVIDENCE, not a parse failure", () => {
  const snapshot = parsePaneSnapshot("\n\n   \n");
  assert.equal(snapshot.hasContent, false);
  const evidence = readStartupEvidence(snapshot, "rg-task-a-1");
  assert.deepEqual(evidence, {
    paneHasContent: false,
    looksLikePi: false,
    markerVisible: false,
    steeringQueued: false,
  });

});

test("F8: startup evidence names exactly what was and was not seen", () => {
  const snapshot = parsePaneSnapshot("pi @/tmp/rg-task-a-1.md\nContext 2%");
  const evidence = { ...readStartupEvidence(snapshot, "rg-task-a-1"), sidecarPresent: false };
  assert.equal(evidence.looksLikePi, true);
  assert.equal(evidence.markerVisible, true);
  assert.match(describeStartupEvidence(evidence), /子会话 sidecar 已落盘=否/);
});

// ---------------------------------------------------------------------------
// F6 / F11 — pressing a key
// ---------------------------------------------------------------------------

test("R-8: `submit` is an INTENT, and the gate owns which key it becomes", () => {
  // Measured on a real pi confirmation dialog: `Enter` and `C-m` did nothing,
  // only `KPEnter` moved it. A caller must not have to know that — and the
  // one that pressed `enter` and was told the press went out waited 600s on
  // an answer it had never given.
  assert.equal(normalizeKey("submit"), "submit");
  assert.equal(normalizeKey("KPEnter"), "kpenter");
  assert.deepEqual([...SUBMIT_KEY_ORDER], ["enter", "kpenter"], "the ordinary key first, the stubborn one second");
  assert.equal(TMUX_KEY_NAMES.kpenter, "KPEnter");
  assert.equal(TMUX_KEY_NAMES.submit, "Enter", "the intent starts with the key that usually works");
});

test("R-8: the low-level receipt reports whether the screen MOVED, and refuses to imply more", () => {
  const before = parsePaneSnapshot(["认可吗", "→ Yes", "  No", FOOTER].join("\n"));
  const unchanged = describeScreenChange(before, before);
  assert.equal(unchanged.changed, false);
  assert.match(unchanged.note, /完全没有变化/);
  assert.match(unchanged.note, /index.*match|`index`\/`match`/, "and it points at the path that CAN submit");

  const after = parsePaneSnapshot("answered: Yes");
  assert.equal(describeScreenChange(before, after).changed, true);
  assert.equal(describeScreenChange(before, undefined).changed, false,
    "a screen that could not be read proves nothing either way");
});

test("R-1: the footer is found at the BOTTOM — an older one further up never wins", () => {
  const lines = ["旧框", "→ A", FOOTER, "…", "新框", "→ B", FOOTER, "▶ widget"];
  assert.equal(findDialogFooter(lines), 6);
  assert.equal(findDialogFooter(["没有任何框"]), undefined);
});


test("F6: only whitelisted key names survive — an unknown one is NEVER typed as text", () => {
  assert.equal(normalizeKey("Esc"), "escape");
  assert.equal(normalizeKey("ArrowDown"), "down");
  assert.equal(normalizeKey("kill-session"), undefined);
  const refused = normalizeKeySequence(["down", "rm -rf /"]);
  assert.equal(refused.ok, false);
  assert.throws(() => buildSendKeysArgv("%2", ["boom" as never]), UnsafeTmuxCommand);
});

test("F6: the arrow presses are COUNTED from the current highlight, never assumed", () => {
  assert.deepEqual(planMoveKeys(1, 3), ["down", "down"]);
  assert.deepEqual(planMoveKeys(3, 1), ["up", "up"]);
  assert.deepEqual(planMoveKeys(2, 2), [], "already there ⇒ no keys at all");
});

test("F6: without a readable highlight the gate REFUSES to press instead of guessing", () => {
  const dialog = { options: [{ index: 1, label: "A", selected: false }, { index: 2, label: "B", selected: false }] };
  const plan = planSelection(dialog, { index: 2 });
  assert.equal(plan.ok, false);
  assert.match((plan as { reason: string }).reason, /拒绝盲按/);
});

test("F6: a row that does not exist is refused with the size of the list", () => {
  const dialog = { options: [{ index: 1, label: "A", selected: true }], selectedIndex: 1 };
  const target = resolveSelectionTarget(dialog, { index: 9 });
  assert.equal(target.ok, false);
  assert.match((target as { reason: string }).reason, /只有 1 项/);
});

test("F11: a highlight that did not land where we aimed is a FAILURE, and nothing is submitted", () => {
  const after = parsePaneSnapshot(["→ A", "  B", "  C", FOOTER].join("\n"));
  const verdict = verifyHighlight(after, 3, "C");
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /没有提交任何东西/);
});

test("R-5: the SAME dialog still on screen means NOT answered; a DIFFERENT one means it was", () => {
  const before = parsePaneSnapshot(["1 / 3 选一个", "→ Yes", "  No", FOOTER].join("\n"));
  const unchanged = parsePaneSnapshot(["1 / 3 选一个", "→ Yes", "  No", FOOTER].join("\n"));
  assert.equal(verifyDismissed(before, unchanged, "Yes").ok, false);

  // The measured case: answering question 1 of an interview immediately opens
  // question 2. The old "is a dialog still on screen" check called that a
  // failure, and a retry would have answered question 2 by mistake.
  const nextQuestion = parsePaneSnapshot(["2 / 3 再选一个", "→ A", "  B", FOOTER].join("\n"));
  const moved = verifyDismissed(before, nextQuestion, "Yes");
  assert.equal(moved.ok, true);
  assert.match((moved as { note: string }).note, /换成了另一个框/);

  assert.equal(verifyDismissed(before, parsePaneSnapshot("answered: Yes"), "Yes").ok, true);

  // A screen that could not be read is NOT evidence that the dialog is gone.
  const unreadable = verifyDismissed(before, undefined, "Yes");
  assert.equal(unreadable.ok, false, "an unreadable screen must never read as a successful submit");
  assert.match((unreadable as { reason: string }).reason, /读不到/);

});


test("F11: the approval pattern recognizes an affirmative row and only that", () => {
  assert.ok(APPROVE_LABEL_PATTERN.test("Yes"));
  assert.ok(APPROVE_LABEL_PATTERN.test("认可"));
  assert.ok(APPROVE_LABEL_PATTERN.test("Approve"));
  assert.equal(APPROVE_LABEL_PATTERN.test("No"), false);
  assert.equal(APPROVE_LABEL_PATTERN.test("拒绝"), false);
});

// ---------------------------------------------------------------------------
// F7 / F8 — delivery
// ---------------------------------------------------------------------------

test("F7: the task rides in on the argv as pi's own @file reference", () => {
  assert.deepEqual(buildChildCommand("/tmp/t.md"), ["pi", "@/tmp/t.md"]);
  const doc = buildTaskDocument({ marker: "rg-task-a-1", taskId: "a", title: "拆分", brief: "干这个" });
  assert.match(doc, /rg-task-a-1/, "the marker survives into the document");
  assert.match(doc, /干这个/);
});

test("F7: anything long or multi-line becomes a FILE; only short single lines are typed", () => {
  assert.equal(planSend("短消息").kind, "inline");
  assert.equal(planSend("一行\n两行").kind, "file", "a newline would submit early and split the message");
  assert.equal(planSend("x".repeat(SEND_INLINE_MAX_CHARS + 1)).kind, "file");
});

test("F7: the echo marker is short enough to survive a terminal's line wrapping", () => {
  assert.equal(echoMarker("  多余的   空白  被折叠 "), "多余的 空白 被折叠");
  assert.ok(echoMarker("x".repeat(100)).length <= 16);
});

test("F8: a spawn is believed on a running process; a typed message needs its ECHO", () => {
  const nothing = { paneHasContent: false, looksLikePi: false, markerVisible: false, sidecarPresent: false };
  assert.equal(deliveryVerdict("spawn", nothing).ok, false);
  assert.equal(deliveryVerdict("send", nothing).ok, false);

  const running = { ...nothing, paneHasContent: true, looksLikePi: true };
  assert.equal(deliveryVerdict("spawn", running).ok, true, "the task was in the argv — running proves it arrived");
  assert.equal(
    deliveryVerdict("send", running).ok,
    false,
    "a running process proves NOTHING about text pushed through the keyboard — that was F8",
  );
  assert.equal(deliveryVerdict("send", { ...running, markerVisible: true }).ok, true);
});

// ---------------------------------------------------------------------------
// F12 / F14 — the waiter's rules
// ---------------------------------------------------------------------------

function event(overrides: Partial<AttentionEvent> = {}): AttentionEvent {
  return {
    id: "e1",
    fromSessionId: "child",
    toSessionId: "orch-1",
    repo: "/repo",
    reason: "等待回答提问",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("F12: an event addressed elsewhere, or from an unregistered pane, is not ours", () => {
  const mine = { orchestrationId: "orch-1", childPanes: ["%2"] };
  assert.equal(acceptAttention(event({ fromPane: "%2" }), mine).accept, true);
  assert.equal(acceptAttention(event({ toSessionId: "somebody-else" }), mine).accept, false);
  assert.equal(acceptAttention(event({ fromPane: "%99" }), mine).accept, false);
  // No origin at all: accepted (older publishers stamped none) but flagged.
  const noPane = acceptAttention(event(), mine);
  assert.equal(noPane.accept, true);
  assert.match(noPane.reason!, /没带来源 pane/);
});

test("F12: an attention whose dialog is already closed is SETTLED, not news", () => {
  const open = evaluateChildWait({ attention: event(), attentionStillOpen: true, done: false, paneAlive: true });
  assert.equal(open.done, true);
  assert.equal(open.reason, "attention");

  // R-16 — writing an event off now takes POSITIVE evidence: no dialog AND
  // the probe saying the child moved on. "I saw no dialog" alone is exactly
  // the judgement that swallowed two real requests for 17 minutes.
  const settled = evaluateChildWait({
    attention: event(),
    attentionStillOpen: false,
    originState: "working",
    done: false,
    paneAlive: true,
  });
  assert.equal(settled.done, false);
  assert.equal(settled.reason, "settled-elsewhere");

  const noDialogButStopped = evaluateChildWait({
    attention: event(),
    attentionStillOpen: false,
    originState: "idle",
    done: false,
    paneAlive: true,
  });
  assert.equal(noDialogButStopped.done, true, "a child that stopped is NEWS, never a settled ghost");


  // Unknown (the screen could not be read) must never SILENCE a request.
  const unknown = evaluateChildWait({ attention: event(), done: false, paneAlive: true });
  assert.equal(unknown.done, true);
});

test("F14: liveness that could not be measured keeps the wait alive; a real death ends it", () => {
  const unknown = evaluateChildWait({ done: false, paneAlive: false, livenessUnknown: true });
  assert.equal(unknown.done, false, "an unreadable tmux is not a death certificate");
  assert.match(unknown.summary, /读不到 tmux/);

  const gone = evaluateChildWait({ done: false, paneAlive: false });
  assert.equal(gone.done, true);
  assert.equal(gone.reason, "pane-gone");
});

test("F14: the wait budget is bounded — 300s by default, 900s at most", () => {
  assert.equal(clampChildWaitTimeout(undefined), CHILD_WAIT_DEFAULT_MS);
  assert.equal(CHILD_WAIT_DEFAULT_MS, 300_000);
  assert.equal(clampChildWaitTimeout(30 * 60_000), CHILD_WAIT_MAX_MS);
  assert.equal(CHILD_WAIT_MAX_MS, 900_000, "the old 30-minute ceiling read as a lost session");
  assert.equal(clampChildWaitTimeout(-5), 1_000);
});

// ---------------------------------------------------------------------------
// F2 / F4 / F5 / F13 — the rest
// ---------------------------------------------------------------------------

test("F2: an orchestrator may write OUTSIDE the repo; inside it, the whitelist still holds", () => {
  const orchestrator = { taskMode: "orchestrator" as const };
  assert.equal(
    orchestratorWriteBlock({ ...orchestrator, relPath: "/tmp/report.md", outsideRepo: true }),
    undefined,
    "an out-of-repo path cannot pollute the worktree or enter a checkpoint",
  );
  assert.equal(orchestratorWriteBlock({ ...orchestrator, relPath: ".pi/orchestrator-plan.json" }), undefined);
  assert.equal(orchestratorWriteBlock({ ...orchestrator, relPath: "docs/orchestrator-handoff.md" }), undefined);
  assert.match(
    orchestratorWriteBlock({ ...orchestrator, relPath: "lib/thing.ts" }) ?? "",
    /项目经理不写代码/,
    "code inside the repo is still refused",
  );
  assert.equal(
    orchestratorWriteBlock({ taskMode: "loop", relPath: "lib/thing.ts" }),
    undefined,
    "and none of this applies to an ordinary loop session",
  );
});

test("F4: a sidecar variant gives a session its own file, and cannot escape .pi/", () => {
  assert.equal(sidecarPath("/repo"), "/repo/.pi/review-gate-state.json");
  assert.equal(sidecarPath("/repo", ".pi", "a-1"), "/repo/.pi/review-gate-state.a-1.json");
  assert.equal(
    sidecarPath("/repo", ".pi", "../../etc/passwd"),
    "/repo/.pi/review-gate-state.etc-passwd.json",
    "a traversal attempt lands as a filename, never as a path",
  );
  assert.equal(stateVariantFrom({} as NodeJS.ProcessEnv), undefined);
  assert.equal(stateVariantFrom({ [STATE_VARIANT_ENV]: "  " } as NodeJS.ProcessEnv), undefined);
  assert.equal(stateVariantFrom({ [STATE_VARIANT_ENV]: "a/b" } as NodeJS.ProcessEnv), "a-b");
});

test("F9 / O-2: a serial child shares the worktree, and WHY that is safe is on the record", () => {
  // The user chose "isolate the sidecar, keep the shared worktree" over "a
  // worktree per child", so the safety of that choice rests on an argument
  // rather than on a mechanism. An argument nobody wrote down is an
  // assumption, and O-2 is precisely the gate having warned about the shared
  // sidecar while the layer kept using it — so the reasoning is pinned here.
  assert.equal(worktreeRequirement("parallel").needed, true);
  assert.equal(worktreeRequirement("serial").needed, false);

  const source = readFileSync(new URL("../lib/orchestrator-gate.ts", import.meta.url), "utf8");
  const at = source.indexOf("WHY A SERIAL CHILD SHARING THE ORCHESTRATOR'S WORKTREE IS SAFE");
  assert.ok(at > 0, "the argument must be written down next to the decision it justifies");
  const argument = source.slice(at, at + 1800);
  assert.match(argument, /ONE WRITER AT A TIME/, "serial is enforced, not merely intended");
  assert.match(argument, /THE SUPERVISOR IS NOT A WRITER/, "constraint 2 keeps the orchestrator out");
  assert.match(argument, /RG_STATE_VARIANT/, "and the one shared mutable thing is now split (F4)");
});

test("F10: the goal draft the child is asking about is readable from its sidecar", () => {
  // F10 was filed as INFORMATION: the draft was already sitting in the
  // child's own `goalPrereview.draft` while the orchestrator was asking a
  // human to read it out loud. The data was never missing; the tool was.
  const deps = {
    childGateState: () => ({
      taskMode: "loop",
      pausedQuestion: { question: "先补测试还是先改实现？", at: "2026-08-29T00:00:00Z" },
      goalPrereview: { verdict: "PASS", at: "2026-08-29T00:00:00Z", draft: "# 任务：拆分 lib/plan" },
    }),
  } as unknown as Parameters<typeof childGateFacts>[0];
  const facts = childGateFacts(deps, {
    id: "a-1", taskId: "a", paneId: "%2", cwd: "/repo", createdAt: "now", stateVariant: "a-1",
  });
  assert.equal(facts.present, true);
  assert.equal(facts.goalDraft, "# 任务：拆分 lib/plan");
  assert.ok(facts.lines.some((l) => l.includes("先补测试还是先改实现？")), "and so is an ordinary pause");
});


test("F5: decision ids are minted by the gate and never collide with what is on disk", () => {
  const parsed = parsePlan({
    title: "t", intent: "i",
    tasks: [{ id: "a", title: "a", fileBoundaries: ["lib"] }],
    decisions: [{ id: "d1", question: "q" }, { id: "d7", question: "q" }],
  });
  assert.ok(parsed.ok, parsed.problems.join("; "));
  assert.equal(nextDecisionId(parsed.plan!), "d8", "the highest number wins, not the count");
});

test("F13: an orchestrator's exit block is the PLAN, with no loop-goal or reviewer talk", () => {
  const block = buildOrchestratorExitBlock(["plan 还有 2 个任务未完成"]);
  assert.match(block, /plan 全部做完/);
  assert.match(block, /plan 还有 2 个任务未完成/);
  // It may MENTION the loop contract, but only to say it does not apply — the
  // failure being fixed is an orchestrator being told to go negotiate a goal
  // and submit its (nonexistent) edits for review.
  assert.match(block, /不需要协商 loop goal/);
  assert.match(block, /不需要 `judge_submit`/);
  assert.doesNotMatch(block, /propose_loop_goal/);
  assert.doesNotMatch(block, /改完就送审/, "the loop block's own imperative never reaches this role");

  assert.match(buildOrchestratorExitBlock([]), /没有未决项/);
});

test("reading a pane is a read-only tmux command, and it reaches into the scrollback", () => {
  const argv = buildCapturePaneArgv("%3", 200);
  assert.deepEqual(argv, ["capture-pane", "-p", "-t", "%3", "-S", "-200"]);
  assert.deepEqual(buildSendKeysArgv("%3", ["down", "enter"]), ["send-keys", "-t", "%3", "Down", "Enter"]);
  assert.throws(() => buildCapturePaneArgv("not-a-pane"), UnsafeTmuxCommand);
});
