/**
 * THE BANNER CHANNEL (user decision, 2026-09-17): who may interrupt the human,
 * for what, and what exactly gets run.
 *
 * The module replaced an OSC escape written to stdout. What is worth pinning
 * here is therefore not "does it send" but the three answers the rule is made
 * of — WHO (a manager or a standalone loop session, never a child), WHEN
 * (finished, failed, or a dialog is waiting — and never for a session the user
 * ended themselves), and WHAT the notifier is handed (an argv with an absolute
 * binary, the pane to jump back to, and a command that cannot be broken by the
 * text it carries).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MISSING_NOTIFIER_HINT,
  NOTIFIER_BINARY,
  NOTIFY_BODY_MAX,
  NOTIFY_DEDUP_MS,
  NOTIFY_RATE_MAX,
  NOTIFY_RATE_WINDOW_MS,
  buildFocusCommand,
  buildNotifierArgv,
  buildUserNotifyMessage,
  decideNotify,
  describeNotifyOutcome,
  emptyNotifyHistory,
  mayNotifyUser,
  normalizeNotifyHistory,
  notifyKey,
  planUserNotify,
  recordNotify,
  sanitizeNotifyText,
  type NotifyHistory,
} from "../lib/user-notify.ts";

const T0 = 1_700_000_000_000;
const NOTIFIER = "/opt/homebrew/bin/terminal-notifier";

/** The shape every test below starts from, so the subject of each is explicit. */
function plan(overrides: Partial<Parameters<typeof planUserNotify>[0]> = {}) {
  return planUserNotify({
    kind: "finished",
    repoName: "pi-review-gate",
    detail: "本轮完成",
    taskMode: "loop",
    stateVariant: undefined,
    tmux: { paneId: "%7", windowId: "@3" },
    notifierPath: NOTIFIER,
    history: emptyNotifyHistory(),
    now: T0,
    interactive: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// WHO
// ---------------------------------------------------------------------------

test("only a session with nobody above it may raise a banner", () => {
  assert.equal(mayNotifyUser({ taskMode: "orchestrator", stateVariant: undefined }), true);
  assert.equal(mayNotifyUser({ taskMode: "loop", stateVariant: undefined }), true,
    "a standalone loop session is exactly what the user asked to hear from");

  assert.equal(mayNotifyUser({ taskMode: "loop", stateVariant: "t6-mu54kfwc" }), false,
    "an orchestration child's questions belong to its manager");
  assert.equal(mayNotifyUser({ taskMode: "normal", stateVariant: undefined }), false,
    "normal mode is the gate switched off — it has nothing to announce");
  assert.equal(mayNotifyUser({ taskMode: "explore", stateVariant: undefined }), false);
  assert.equal(mayNotifyUser({ taskMode: undefined, stateVariant: undefined }), false,
    "an unclassified session (or an early crash) must not guess");
  assert.equal(mayNotifyUser({ taskMode: "orchestrator", stateVariant: "  " }), true,
    "blank is not an identity");
});

test("a test run can never put a banner on somebody's screen", () => {
  const p = plan({ interactive: false });
  assert.equal(p.status, "skipped");
  // …even when the session WOULD be allowed to: the side-effect gate is first.
  assert.equal(plan({ interactive: false, taskMode: "orchestrator" }).status, "skipped");
});

test("a child session is skipped with the reason that names the rule", () => {
  const p = plan({ stateVariant: "t1-x" });
  assert.equal(p.status, "skipped");
  if (p.status === "skipped") assert.match(p.reason, /子会话/);
});

// ---------------------------------------------------------------------------
// WHEN — the three kinds
// ---------------------------------------------------------------------------

test("each kind says what happened and where", () => {
  const finished = buildUserNotifyMessage({ kind: "finished", repoName: "onchain", detail: "PR 已开" });
  assert.equal(finished.title, "完成 · onchain");
  assert.equal(finished.body, "PR 已开");

  const failed = buildUserNotifyMessage({ kind: "failed", repoName: "onchain", detail: "" });
  assert.match(failed.title, /异常结束/);
  assert.match(failed.body, /没有 declare_done/, "the default body must say what a failure IS here");

  const needs = buildUserNotifyMessage({ kind: "needs-user", repoName: "onchain", detail: "选哪个方案？" });
  assert.match(needs.title, /需要你/);
  assert.equal(needs.body, "选哪个方案？");

  assert.equal(buildUserNotifyMessage({ kind: "finished", repoName: "  ", detail: "x" }).title, "完成 · pi",
    "a nameless repo still produces a readable title");
});

// ---------------------------------------------------------------------------
// WHAT RUNS
// ---------------------------------------------------------------------------

test("the argv is the notifier, the text, the terminal to activate, and the pane to jump to", () => {
  const p = plan();
  assert.equal(p.status, "send");
  if (p.status !== "send") return;
  assert.deepEqual(p.argv, [
    NOTIFIER,
    "-title", "完成 · pi-review-gate",
    "-message", "本轮完成",
    "-activate", "com.mitchellh.ghostty",
    "-execute", "tmux select-window -t @3; tmux select-pane -t %7",
  ]);
  assert.equal(p.argv[0], NOTIFIER, "the binary is RESOLVED: the exit path may have no PATH to search");
  assert.equal(p.key, notifyKey("完成 · pi-review-gate", "本轮完成"));
});

test("no tmux pane ⇒ no focus command at all, never half of one", () => {
  const p = plan({ tmux: undefined });
  assert.equal(p.status, "send");
  if (p.status !== "send") return;
  assert.ok(!p.argv.includes("-execute"), "there is nothing to jump to");
  assert.ok(p.argv.includes("-activate"), "the terminal is still worth bringing forward");
});

test("a focus target that is not a tmux id is dropped rather than pasted in", () => {
  assert.equal(buildFocusCommand({ paneId: "%7", windowId: "@3" }),
    "tmux select-window -t @3; tmux select-pane -t %7");
  assert.equal(buildFocusCommand({ paneId: "%7", windowId: undefined }),
    "tmux select-pane -t %7", "with no window, selecting the pane still lands on it");
  assert.equal(buildFocusCommand({ paneId: "%7", windowId: "bogus" }),
    "tmux select-pane -t %7", "an unreadable window id is not a reason to give up on the pane");
  assert.equal(buildFocusCommand({ paneId: "7; rm -rf /", windowId: "@3" }), undefined,
    "the command is handed to a shell — anything that is not an id never gets in");
  assert.equal(buildFocusCommand({ paneId: "", windowId: "@3" }), undefined);
});

test("agent-written text lands in its own argv element, never in the click command", () => {
  const p = plan({ detail: '"; rm -rf / #\n新的一行 $(whoami) `id`' });
  assert.equal(p.status, "send");
  if (p.status !== "send") return;
  const execute = p.argv[p.argv.indexOf("-execute") + 1]!;
  assert.equal(execute, "tmux select-window -t @3; tmux select-pane -t %7",
    "the click command is built from ids only");
  const message = p.argv[p.argv.indexOf("-message") + 1]!;
  assert.doesNotMatch(message, /\n/, "a newline in a message renders as a broken banner");
  assert.match(message, /rm -rf/, "…but the text itself is still there — sanitized, not censored");
});

test("the notifier is spawned by its resolved path, and its own argv stays positional", () => {
  assert.deepEqual(buildNotifierArgv({ title: "T", body: "B" }), [
    NOTIFIER_BINARY, "-title", "T", "-message", "B", "-activate", "com.mitchellh.ghostty",
  ], "the pure builder names the binary, and planUserNotify swaps in the resolved path");
});

// ---------------------------------------------------------------------------
// The four outcomes are told apart
// ---------------------------------------------------------------------------

test("a missing notifier is REPORTED, never rounded into a send", () => {
  const p = plan({ notifierPath: undefined });
  assert.equal(p.status, "missing");
  if (p.status === "missing") assert.match(p.hint, /brew install terminal-notifier/);
  assert.match(MISSING_NOTIFIER_HINT, /通知是关的/, "the one-time hint says what the user loses");

  assert.deepEqual(describeNotifyOutcome({ status: "sent" }), "已发出系统通知。");
  assert.match(describeNotifyOutcome({ status: "missing", note: MISSING_NOTIFIER_HINT }), /没发出去/);
  assert.match(describeNotifyOutcome({ status: "throttled", note: "太频繁" }), /节流/);
  assert.match(describeNotifyOutcome({ status: "skipped", note: "子会话" }), /没有发通知/);
});

// ---------------------------------------------------------------------------
// Throttling (constraint 9)
// ---------------------------------------------------------------------------

test("the SAME text is not repeated inside the dedup window", () => {
  const key = notifyKey("T", "B");
  let history: NotifyHistory = emptyNotifyHistory();
  assert.deepEqual(decideNotify({ history, key, now: T0 }), { send: true });
  history = recordNotify(history, key, T0);

  const blocked = decideNotify({ history, key, now: T0 + 1000 });
  assert.equal(blocked.send, false, "the same unanswered question every loop iteration is the pager storm");
  if (!blocked.send) assert.match(blocked.reason, /已发过/);

  assert.deepEqual(decideNotify({ history, key, now: T0 + NOTIFY_DEDUP_MS + 1 }), { send: true },
    "after the window it may be repeated");
});

test("DIFFERENT text is not deduped, but the rate limit still bounds it", () => {
  let history: NotifyHistory = emptyNotifyHistory();
  for (let i = 0; i < NOTIFY_RATE_MAX; i++) {
    const key = notifyKey("T", `body ${i}`);
    assert.deepEqual(decideNotify({ history, key, now: T0 + i }), { send: true }, `send ${i} must pass`);
    history = recordNotify(history, key, T0 + i);
  }
  const overflow = decideNotify({ history, key: notifyKey("T", "one more"), now: T0 + NOTIFY_RATE_MAX });
  assert.equal(overflow.send, false, "a misbehaving run must not empty its plan into someone's screen");
  if (!overflow.send) assert.match(overflow.reason, /频率超限/);

  assert.deepEqual(
    decideNotify({ history, key: notifyKey("T", "one more"), now: T0 + NOTIFY_RATE_WINDOW_MS + 1 }),
    { send: true },
    "the window slides",
  );
});

test("the throttled plan carries the reason and never an argv", () => {
  const key = notifyKey("完成 · pi-review-gate", "本轮完成");
  const history = recordNotify(emptyNotifyHistory(), key, T0);
  const p = plan({ history, now: T0 + 1000 });
  assert.equal(p.status, "throttled");
  if (p.status === "throttled") assert.match(p.reason, /已发过/);

  const fresh = plan({ history, now: T0 + NOTIFY_DEDUP_MS + 1 });
  assert.equal(fresh.status, "send", "a reopened dialog must ring again once the window has passed");
});

test("the history stays bounded — it is persisted in the sidecar", () => {
  let history: NotifyHistory = emptyNotifyHistory();
  for (let i = 0; i < 50; i++) history = recordNotify(history, notifyKey("T", `b${i}`), T0 + i * 1000);
  assert.ok(history.sentAt.length <= 50);
  // Advance well past both windows: everything older must be dropped.
  history = recordNotify(history, notifyKey("T", "last"), T0 + NOTIFY_DEDUP_MS * 3);
  assert.deepEqual(Object.keys(history.lastByKey), [notifyKey("T", "last")],
    "only keys that can still suppress something are kept");
  assert.deepEqual(history.sentAt, [T0 + NOTIFY_DEDUP_MS * 3]);
});

test("a sidecar's history is read fail-soft, never rounded into silence", () => {
  assert.deepEqual(normalizeNotifyHistory(undefined), { sentAt: [], lastByKey: {} });
  assert.deepEqual(normalizeNotifyHistory("nonsense"), { sentAt: [], lastByKey: {} });
  // A NaN timestamp compares false against every window test: it would poison
  // the arithmetic rather than merely contributing nothing.
  assert.deepEqual(normalizeNotifyHistory({ sentAt: [T0, Number.NaN, "x"], lastByKey: { k: T0, bad: null } }),
    { sentAt: [T0], lastByKey: { k: T0 } });
  assert.deepEqual(normalizeNotifyHistory({ sentAt: { 0: T0 }, lastByKey: [1] }),
    { sentAt: [], lastByKey: {} }, "wrong container types are not iterated");
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

test("control characters are removed and the length is capped", () => {
  assert.equal(sanitizeNotifyText("a\u0000b\u001bc\u007fd", 40), "a b c d");
  assert.equal(sanitizeNotifyText("  多   空白\n\n行  ", 40), "多 空白 行");
  const long = sanitizeNotifyText("x".repeat(500), NOTIFY_BODY_MAX);
  assert.equal(long.length, NOTIFY_BODY_MAX);
  assert.ok(long.endsWith("…"), "a truncation the reader can see");
  assert.ok(sanitizeNotifyText("x".repeat(500), NOTIFY_BODY_MAX).length <= NOTIFY_BODY_MAX);
  assert.equal(sanitizeNotifyText("正常", 40), "正常", "an unbroken string is untouched");
});
