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
  exitNotifyKind,
  isWatchingPane,
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
    tmux: () => ({ paneId: "%7", windowId: "@3" }),
    // The session's own banner group — the notifier removes an older banner
    // with the same id (user decision, 2026-09-18).
    group: "sess-1",
    notifierPath: NOTIFIER,
    // The macOS app the click raises — in production `defaultActivateBundle()`
    // reads it from `__CFBundleIdentifier`; the pure planner takes it as a fact.
    activateBundle: "com.mitchellh.ghostty",
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

/**
 * THE FAILURE RULE, on its own (reviewer P1, 2026-09-17): “a session the user
 * ended themselves is not news, a crash is”. The caller is an `exit` handler,
 * which cannot be exercised in-process, so the decision lives here and the
 * wiring that consults it is pinned by test/extension-structure.test.ts.
 */
test("a clean shutdown says nothing; anything else is the one banner nobody can raise", () => {
  assert.equal(exitNotifyKind({ cleanShutdown: true }), undefined,
    "quit | reload | new | resume | fork — the user did it on purpose");
  assert.equal(exitNotifyKind({ cleanShutdown: false }), "failed",
    "no shutdown record and the process is gone: that is a crash");
});

test("each kind says what happened and where", () => {
  // THE TITLE IS `<type> · <repo>` (user decision, 2026-09-18): the type word
  // leads, the directory name follows, and the session's ROLE is deliberately
  // not in it — the user asked for the role once and then withdrew it ("算了,
  // 不显示角色"). The word `需要你` was the vague half: `等你回答` says what is
  // being asked of them.
  const finished = buildUserNotifyMessage({ kind: "finished", repoName: "onchain", detail: "PR 已开" });
  assert.equal(finished.title, "任务完成 · onchain");
  assert.equal(finished.body, "PR 已开");

  const failed = buildUserNotifyMessage({ kind: "failed", repoName: "onchain", detail: "" });
  assert.match(failed.title, /异常结束/);
  assert.match(failed.body, /异常结束/, "the default body must say what a failure IS here");
  assert.doesNotMatch(failed.body, /declare_done/,
    "…and must not claim a cause the judge never checked (reviewer P2, 2026-09-17)");

  const needs = buildUserNotifyMessage({ kind: "needs-user", repoName: "onchain", detail: "选哪个方案？" });
  assert.equal(needs.title, "等你回答 · onchain");
  assert.equal(needs.body, "选哪个方案？", "the body carries the actual question");

  assert.equal(buildUserNotifyMessage({ kind: "finished", repoName: "  ", detail: "x" }).title, "任务完成 · pi",
    "a nameless repo still produces a readable title");
});

// ---------------------------------------------------------------------------
// WHAT RUNS
// ---------------------------------------------------------------------------

test("the argv is the notifier, the text, the group, the terminal to activate, and the pane to jump to", () => {
  const p = plan();
  assert.equal(p.status, "send");
  if (p.status !== "send") return;
  assert.deepEqual(p.argv, [
    NOTIFIER,
    "-title", "任务完成 · pi-review-gate",
    "-message", "本轮完成",
    "-group", "sess-1",
    "-activate", "com.mitchellh.ghostty",
    "-execute", "tmux select-window -t @3; tmux select-pane -t %7",
  ]);
  assert.equal(p.argv[0], NOTIFIER, "the binary is RESOLVED: the exit path may have no PATH to search");
  assert.equal(p.key, notifyKey("任务完成 · pi-review-gate", "本轮完成"));
});

test("the tmux address is resolved ONLY when a banner actually goes out", () => {
  // Reviewer P2 (2026-09-17): every gate dialog reaches this path, including
  // the ones in child sessions and judge panes — and resolving the address is a
  // synchronous `tmux display-message`. It must not be paid by a session that
  // can never send, nor by a send the throttle refuses.
  let asked = 0;
  const address = () => { asked += 1; return { paneId: "%7", windowId: "@3" }; };
  assert.equal(plan({ tmux: address, stateVariant: "t1-x" }).status, "skipped");
  assert.equal(plan({ tmux: address, interactive: false }).status, "skipped");
  assert.equal(plan({ tmux: address, notifierPath: undefined }).status, "missing");
  const key = notifyKey("任务完成 · pi-review-gate", "本轮完成");
  const history = recordNotify(emptyNotifyHistory(), key, T0);
  assert.equal(plan({ tmux: address, history, now: T0 + 1 }).status, "throttled");
  assert.equal(asked, 0, "none of those four ever needed to know where this session lives");

  assert.equal(plan({ tmux: address }).status, "send");
  assert.equal(asked, 1, "the one that sends asks exactly once");
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
    "tmux select-window -t %7; tmux select-pane -t %7",
    "with no window id, both halves still run — MEASURED: select-window accepts a pane id");
  assert.equal(buildFocusCommand({ paneId: "%7", windowId: "bogus" }),
    "tmux select-window -t %7; tmux select-pane -t %7",
    "an unreadable window id is not a reason to give up on the pane");
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
  assert.deepEqual(buildNotifierArgv({ title: "T", body: "B", activateBundle: "com.mitchellh.ghostty" }), [
    NOTIFIER_BINARY, "-title", "T", "-message", "B", "-activate", "com.mitchellh.ghostty",
  ], "the pure builder names the binary, and planUserNotify swaps in the resolved path");
});

test("an unknown host app drops `-activate` — the click still focuses the pane, it just cannot raise a window", () => {
  // Reviewer Nit (carried two rounds, fixed 2026-09-17): the bundle used to be
  // hard-coded Ghostty, so a click raised Ghostty for a session running in any
  // other terminal — and `TERM_PROGRAM` cannot fix that, because inside tmux it
  // is `tmux`. No bundle ⇒ no `-activate` at all, rather than a guess.
  assert.deepEqual(buildNotifierArgv({ title: "T", body: "B" }), [
    NOTIFIER_BINARY, "-title", "T", "-message", "B",
  ]);
  const p = plan({ activateBundle: undefined });
  assert.equal(p.status, "send");
  if (p.status !== "send") return;
  assert.ok(!p.argv.includes("-activate"), "a guess is worse than silence here");
  assert.ok(p.argv.includes("-execute"), "…and the pane is still the click target");
});

// ---------------------------------------------------------------------------
// Is the user already looking at it? (user decision, 2026-09-18)
// ---------------------------------------------------------------------------

/** The happy shape of {@link isWatchingPane}: matching pane AND matching app. */
const WATCHING = {
  paneId: "%7",
  activePanes: ["%3", "%7"],
  frontBundleId: "com.mitchellh.ghostty",
  sessionBundleId: "com.mitchellh.ghostty",
};

test("suppression has to be EARNED by two facts agreeing", () => {
  assert.equal(isWatchingPane(WATCHING), true, "the pane on screen AND the session's app in front");

  assert.equal(isWatchingPane({ ...WATCHING, activePanes: ["%3"] }), false,
    "the client is showing another pane in the same terminal");
  assert.equal(isWatchingPane({ ...WATCHING, frontBundleId: "com.google.Chrome" }), false,
    "the terminal is behind another app: the pane is active but not on screen");
  assert.equal(isWatchingPane({ ...WATCHING, activePanes: [] }), false,
    "no attached client at all");
  assert.equal(isWatchingPane({ ...WATCHING, paneId: undefined }), false, "not in tmux");
  assert.equal(isWatchingPane({ ...WATCHING, paneId: "7; rm -rf /" }), false, "not a tmux id");
  assert.equal(isWatchingPane({ ...WATCHING, paneId: " %7 " }), true, "whitespace is trimmed, not compared");
  assert.equal(isWatchingPane({ ...WATCHING, frontBundleId: undefined }), false,
    "an unreadable frontmost app must not silence the channel");
  assert.equal(isWatchingPane({ ...WATCHING, sessionBundleId: "" }), false,
    "a session that cannot name its own app cannot claim to be watched");
});

test("a user looking at the box is not interrupted — for any kind of banner", () => {
  const p = plan({ watching: () => true });
  assert.equal(p.status, "skipped");
  if (p.status === "skipped") assert.match(p.reason, /正在看/);

  assert.equal(plan({ kind: "needs-user", detail: "选哪个？", watching: () => false }).status, "send");
  assert.equal(plan({ kind: "needs-user", detail: "选哪个？", watching: () => true }).status, "skipped");
});

test("the watching check is asked LAZILY, and only on the path that would send", () => {
  let watched = 0;
  const watching = () => { watched += 1; return false; };
  assert.equal(plan({ watching, stateVariant: "t1-x" }).status, "skipped");
  assert.equal(plan({ watching, interactive: false }).status, "skipped");
  assert.equal(plan({ watching, notifierPath: undefined }).status, "missing");
  assert.equal(watched, 0, "none of those three ever asks whether the user is looking");

  // …and neither does a banner the THROTTLE refuses (quality round P2,
  // 2026-09-18): the evidence costs three to five synchronous subprocesses, so
  // the cheap decision comes first and a suppressed banner still records
  // nothing, leaving the next real one its slot.
  const history = recordNotify(
    emptyNotifyHistory(),
    notifyKey("任务完成 · pi-review-gate", "本轮完成"),
    T0,
  );
  assert.equal(plan({ watching, history, now: T0 + 1 }).status, "throttled");
  assert.equal(watched, 0, "a throttled banner pays for no evidence either");

  assert.equal(plan({ watching }).status, "send");
  assert.equal(watched, 1, "the one that sends asks exactly once");
});

test("one banner per session: the group is what removes the previous one", () => {
  assert.deepEqual(buildNotifierArgv({ title: "T", body: "B", group: "sess-1" }), [
    NOTIFIER_BINARY, "-title", "T", "-message", "B", "-group", "sess-1",
  ], "`-group` is what makes Notification Center keep ONE banner for the session");
  assert.ok(!buildNotifierArgv({ title: "T", body: "B" }).includes("-group"),
    "no id ⇒ no group at all, never an empty one");
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
  const key = notifyKey("任务完成 · pi-review-gate", "本轮完成");
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
