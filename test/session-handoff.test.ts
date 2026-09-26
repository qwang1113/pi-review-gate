/**
 * THE ONE HANDOVER POLICY — threshold, document, and what counts as a takeover.
 *
 * Every rule here replaces a number or a step that used to live somewhere else
 * (see the module header): 80/90 for the orchestrator, 60 for a judge, and
 * nothing at all for a loop session. The tests pin the arithmetic AND the
 * failure directions, because "no reading" rendering as room to spare is the
 * bug shape this project has already paid for once.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHandoffDoc,
  contextPercentFromUsage,
  formatContextStatus,
  formatTokens,
  handoffAccepted,
  handoffDocFilled,
  handoffDue,
  handoffReminder,
  readContext,
  HANDOFF_FILL_HEADING,
  HANDOFF_FILL_PLACEHOLDER,
  HANDOFF_PERCENT,
  lastUserMessages,
  recentUserSection,
  successorDoneRefusal,
  withRecentUserMessages,
  RECENT_USER_HEADING,
  RECENT_USER_MAX_CHARS,
} from "../lib/session-handoff.ts";
import { THINKING_LOOP_INJECTION } from "../lib/thinking-loop-controller.ts";

test("the reading prefers pi's percent, and falls back to tokens / window", () => {
  assert.equal(contextPercentFromUsage({ tokens: 700_000, contextWindow: 1_000_000, percent: 68 }), 68);
  assert.equal(contextPercentFromUsage({ tokens: 700_000, contextWindow: 1_000_000 }), 70);
  assert.equal(contextPercentFromUsage({ tokens: 350_000, contextWindow: 1_000_000 }), 35);
});

test("a reading the host could not supply is MISSING, never reassurance", () => {
  assert.equal(contextPercentFromUsage(undefined), undefined);
  assert.equal(contextPercentFromUsage(null), undefined);
  assert.equal(contextPercentFromUsage({}), undefined);
  assert.equal(contextPercentFromUsage({ tokens: null, contextWindow: 1_000_000 }), undefined);
  assert.equal(contextPercentFromUsage({ tokens: 10, contextWindow: 0 }), undefined, "a zero window cannot be a ratio");
  assert.equal(contextPercentFromUsage({ tokens: Number.NaN, contextWindow: 1_000_000 }), undefined);
  assert.equal(contextPercentFromUsage("70%"), undefined);
});

test("the threshold is 70% of the window — the user's 700k of 1M, as a ratio", () => {
  assert.equal(HANDOFF_PERCENT, 70);
  assert.equal(handoffDue({ percent: 69.9 }).due, false, "the RAW percentage decides — rounding first would fire early");
  assert.equal(handoffDue({ percent: 70 }).due, true);
  assert.equal(handoffDue({ tokens: 700_000, contextWindow: 1_000_000 }).due, true);
  assert.equal(handoffDue({ tokens: 699_000, contextWindow: 1_000_000 }).due, false);
  assert.equal(handoffDue({ tokens: 700_000, contextWindow: 1_000_000 }).percent, 70);
});

test("no reading at all does NOT remind — a reminder that fires on missing facts is noise", () => {
  assert.deepEqual(handoffDue(undefined), { due: false });
  assert.deepEqual(handoffDue({ tokens: null }), { due: false });
});

test("the document states the gate's own facts, and marks the agent's half as testimony", () => {
  const doc = buildHandoffDoc({
    kind: "orchestrator",
    sessionId: "01a09b18",
    repoRoot: "/repo",
    contract: "plan: 三个任务，t1 完成",
    outstanding: ["t2 running（pane 5）", "未提交改动：lib/x.ts"],
    transcriptPath: "/sessions/01a09b18.jsonl",
    firstAction: "orchestrator_attach({orchestrationId})",
    now: "2026-09-14T00:00:00.000Z",
  });
  assert.match(doc, /项目经理（orchestrator）/);
  assert.match(doc, /01a09b18/);
  assert.match(doc, /\/sessions\/01a09b18\.jsonl/, "the raw record travels with the document");
  assert.match(doc, /plan: 三个任务，t1 完成/);
  assert.match(doc, /- t2 running（pane 5）/);
  assert.match(doc, /orchestrator_attach/);
  assert.ok(doc.includes(HANDOFF_FILL_HEADING), "the agent's own section is present");
  assert.ok(doc.includes(HANDOFF_FILL_PLACEHOLDER));
  assert.equal(handoffDocFilled(doc), false);
});

test("an empty hand is stated as empty, not left blank", () => {
  const doc = buildHandoffDoc({ kind: "loop", sessionId: "s1", repoRoot: "/repo" });
  assert.match(doc, /门禁没有记录到生效的契约/);
  assert.match(doc, /门禁没有记录到未完成项/);
});

test("the agent's paragraph is 'written' by the placeholder being gone", () => {
  const filled = buildHandoffDoc({ kind: "loop", sessionId: "s1", repoRoot: "/repo" })
    .replace(HANDOFF_FILL_PLACEHOLDER, "我把接口改到 lib/x.ts 了，下一步补测试。");
  assert.equal(handoffDocFilled(filled), true);
  assert.match(filled, /下一步补测试/);
});

test("a takeover needs BOTH facts — the document READ and a successful call", () => {
  // The user's own wording, and the conjunction is the safety: an OR let a
  // successor run any bash command successfully and close its predecessor
  // without ever opening the document it was told to read.
  assert.equal(handoffAccepted({ readHandoffDoc: true, firstToolSucceeded: true }), true);
  assert.equal(handoffAccepted({ readHandoffDoc: true, firstToolSucceeded: false }), false,
    "reading the document did not work, so nothing was taken over");
  assert.equal(handoffAccepted({ readHandoffDoc: false, firstToolSucceeded: true }), false,
    "a successful command is not a takeover if the context was never read");
  assert.equal(handoffAccepted({ readHandoffDoc: false, firstToolSucceeded: false }), false);
});

test("readContext keeps every field the host reported — and absence means UNKNOWN", () => {
  assert.deepEqual(readContext({ tokens: 358_000, contextWindow: 1_000_000, percent: 35.8 }), {
    tokens: 358_000,
    contextWindow: 1_000_000,
    percent: 35.8,
  });
  // The arithmetic fallback: pi sometimes reports no percent, and the pair of
  // numbers is then the only reading there is.
  const derived = readContext({ tokens: 358_000, contextWindow: 1_000_000 });
  assert.equal(derived.percent, 35.8);
  assert.equal(derived.tokens, 358_000);
  assert.deepEqual(readContext({ percent: 42 }), { percent: 42 });
  assert.deepEqual(readContext(undefined), {}, "a missing reading is EMPTY, never a zeroed one");
  assert.deepEqual(readContext({ tokens: null, contextWindow: 0, percent: null }), {});
});

test("formatTokens reads like a human wrote it", () => {
  assert.equal(formatTokens(358_000), "358k");
  assert.equal(formatTokens(1_048_576), "1.0M");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(Number.NaN), "?");
});

test("context_status answers the session's OWN question, with the decision attached", () => {
  // The whole point of the tool (user requirement, 2026-09-14): a session must
  // never again spend a round budgeting against a context it GUESSED at.
  const room = formatContextStatus({ tokens: 358_000, contextWindow: 1_000_000, percent: 35.8 });
  assert.match(room, /358k \/ 1.0M/);
  assert.match(room, /35\.8%/);
  assert.match(room, /交接阈值：70%/);
  assert.match(room, /余量充足/);
  assert.doesNotMatch(room, /session_handoff\(\)/, "below the threshold nothing is asked of the reader");

  const full = formatContextStatus(
    { tokens: 730_000, contextWindow: 1_000_000, percent: 73 },
    { docPath: ".pi/handoff/abc.md" },
  );
  assert.match(full, /已过交接阈值 70%/);
  assert.match(full, /session_handoff\(\)/);
  assert.match(full, /\.pi\/handoff\/abc\.md/);

  const blind = formatContextStatus({});
  assert.match(blind, /宿主没有提供读数/);
  assert.doesNotMatch(blind, /余量充足/, "a missing measurement is never reassurance");
});

test("the reminder names the document and the tool, and asks for the paragraph first", () => {
  const pending = handoffReminder({
    kind: "loop",
    percent: 73,
    docPath: ".pi/handoff/abc.md",
    pendingFill: true,
  });
  assert.match(pending, /73%/);
  assert.match(pending, /\.pi\/handoff\/abc\.md/);
  assert.match(pending, /session_handoff\(\)/);
  assert.match(pending, /先把你自己的那一段/, "the paragraph is a prerequisite of the call, not an afterthought");
  assert.doesNotMatch(pending, /orchestrator_handoff/, "one entry point, and it is named exactly once");

  const written = handoffReminder({
    kind: "child",
    percent: 71,
    docPath: ".pi/handoff/abc.md",
    pendingFill: false,
  });
  assert.match(written, /随时可以调/);
  assert.doesNotMatch(written, /先把你自己的那一段/);
});

const userMsg = (content: unknown) => ({ type: "message", message: { role: "user", content } });

test("lastUserMessages: the last n user texts, oldest first; other roles and non-text skipped", () => {
  const entries = [
    userMsg("第一条"),
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "助手" }] } },
    userMsg([{ type: "text", text: "第二条" }]),
    userMsg([{ type: "image", data: "xx" }]),
    { type: "compaction", summary: "s" },
    userMsg([{ type: "text", text: "第三条" }, { type: "image" }, { type: "text", text: "续" }]),
    userMsg("再加一个任务：修 X"),
  ];
  assert.deepEqual(lastUserMessages(entries, 3), ["第二条", "第三条\n续", "再加一个任务：修 X"]);
  assert.deepEqual(lastUserMessages([], 3), []);
});

test("lastUserMessages: the gate's own injections never displace the user's words (measured 2026-09-26)", () => {
  const entries = [
    userMsg("用户甲"),
    userMsg("[REVIEW_GATE_RESUME] The task is not finished yet:\n- loop goal not confirmed"),
    userMsg("用户乙"),
    userMsg([{ type: "text", text: "[REVIEW_GATE_REPORT] reviewer（x）本轮已有 channel report" }]),
    userMsg("[ORCHESTRATION_RESUME] 编排还没结束"),
    userMsg("用户丙"),
    userMsg("[ORCHESTRATION] 子会话需要你："),
    userMsg(THINKING_LOOP_INJECTION),
  ];
  assert.deepEqual(lastUserMessages(entries, 3), ["用户甲", "用户乙", "用户丙"]);
  assert.deepEqual(lastUserMessages([userMsg("[bug] 用户自己写的标签")], 3), ["[bug] 用户自己写的标签"],
    "only the gate's own tag families are skipped");
});

test("lastUserMessages: exactly the limit is kept whole, one more is cut and says so", () => {
  const exact = "字".repeat(RECENT_USER_MAX_CHARS);
  assert.equal(lastUserMessages([userMsg(exact)], 3)[0], exact);
  const over = lastUserMessages([userMsg("字".repeat(RECENT_USER_MAX_CHARS + 1))], 3)[0]!;
  assert.ok(over.startsWith(exact));
  assert.match(over, new RegExp(`已截断，原文 ${RECENT_USER_MAX_CHARS + 1} 字`));
});

test("the document carries the user's last words, or says there were none", () => {
  const doc = buildHandoffDoc({ kind: "orchestrator", sessionId: "s1", repoRoot: "/repo", recentUserMessages: ["再加一个任务：修 X"] });
  assert.ok(doc.indexOf(RECENT_USER_HEADING) < doc.indexOf(HANDOFF_FILL_HEADING));
  assert.match(recentUserSection(doc)!, /> 再加一个任务：修 X/);
  const empty = buildHandoffDoc({ kind: "loop", sessionId: "s1", repoRoot: "/repo", recentUserMessages: [] });
  assert.match(recentUserSection(empty)!, /没有记录到用户消息/);
  const unread = buildHandoffDoc({ kind: "loop", sessionId: "s1", repoRoot: "/repo" });
  assert.match(recentUserSection(unread)!, /读不到会话记录/, "a missing reading is not 'none'");
});

test("refreshing the user section keeps the agent's paragraph — even when a message holds a heading", () => {
  const filled = buildHandoffDoc({ kind: "loop", sessionId: "s1", repoRoot: "/repo", recentUserMessages: ["旧的"] })
    .replace(HANDOFF_FILL_PLACEHOLDER, "我的补充");
  const once = withRecentUserMessages(filled, ["## 不是标题\n新的"]);
  const twice = withRecentUserMessages(once, ["最新"]);
  assert.match(twice, /我的补充/);
  assert.match(recentUserSection(twice)!, /> 最新/);
  assert.doesNotMatch(twice, /旧的|新的/);
  assert.equal(twice.split(RECENT_USER_HEADING).length, 2, "one section, never duplicated");
  // A document from before this section existed gets it before the paragraph.
  const legacy = `# x\n\n${HANDOFF_FILL_HEADING}\n\n我的补充\n`;
  const upgraded = withRecentUserMessages(legacy, ["要求"]);
  assert.ok(upgraded.indexOf(RECENT_USER_HEADING) < upgraded.indexOf(HANDOFF_FILL_HEADING));
  assert.match(upgraded, /我的补充/);
});

test("a contract that quotes the section heading is never mistaken for the section (reviewer P1)", () => {
  const contract = `loop goal：\n${RECENT_USER_HEADING}\n契约里引用的标题\n${HANDOFF_FILL_HEADING}\n契约里引用的补充标题`;
  const doc = buildHandoffDoc({ kind: "loop", sessionId: "s1", repoRoot: "/repo", contract, recentUserMessages: ["旧话"] });
  assert.match(recentUserSection(doc)!, /> 旧话/);
  const refreshed = withRecentUserMessages(doc, ["新话"]);
  assert.ok(refreshed.includes(contract), "the contract is untouched");
  assert.match(recentUserSection(refreshed)!, /> 新话/);
  assert.doesNotMatch(refreshed, /旧话/);
  // A legacy document (no fence) whose contract quotes the fill heading.
  const legacy = `# x\n\n${contract}\n\n${HANDOFF_FILL_HEADING}\n\n我的补充\n`;
  const upgraded = withRecentUserMessages(legacy, ["要求"]);
  assert.ok(upgraded.includes(contract));
  assert.ok(upgraded.indexOf("> 要求") > upgraded.indexOf("契约里引用的补充标题"));
});

test("a successor's first declare_done is refused once, pasting the user's last words", () => {
  const doc = buildHandoffDoc({ kind: "orchestrator", sessionId: "s1", repoRoot: "/repo", recentUserMessages: ["再加一个任务：修 X"] });
  const refusal = successorDoneRefusal({ isSuccessor: true, checked: false, docPath: "/repo/.pi/handoff/s1.md", doc });
  assert.ok(refusal);
  assert.match(refusal!, /再加一个任务：修 X/);
  assert.match(refusal!, /\/repo\/\.pi\/handoff\/s1\.md/);
  assert.equal(successorDoneRefusal({ isSuccessor: true, checked: true, doc }), undefined, "only once");
  assert.equal(successorDoneRefusal({ isSuccessor: false, checked: false, doc }), undefined, "not a successor");
  assert.match(successorDoneRefusal({ isSuccessor: true, checked: false })!, /transcript/,
    "an unreadable document still refuses, pointing at the transcript");
});
