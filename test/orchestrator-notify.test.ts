import test from "node:test";
import assert from "node:assert/strict";

import {
  emptyNotifyHistory,
  NOTIFY_BODY_MAX,
  NOTIFY_DEDUP_MS,
  NOTIFY_RATE_MAX,
  NOTIFY_RATE_WINDOW_MS,
  NOTIFY_TITLE_MAX,
  buildNotifySequence,
  decideNotify,
  detectNotifyProtocol,
  notifyKey,
  passthroughDeliveryNote,
  prepareNotification,
  recordNotify,
  sanitizeNotifyText,
  wrapForTmux,
  writeNotification,
  type NotifyHistory,
} from "../lib/orchestrator-notify.ts";

const T0 = 1_700_000_000_000;

test("the protocol is detected from the terminal, with OSC 777 as the broad default", () => {
  assert.equal(detectNotifyProtocol({ KITTY_WINDOW_ID: "1" } as NodeJS.ProcessEnv), "osc99");
  assert.equal(detectNotifyProtocol({ TERM_PROGRAM: "iTerm.app" } as NodeJS.ProcessEnv), "osc9");
  assert.equal(detectNotifyProtocol({} as NodeJS.ProcessEnv), "osc777");
  assert.equal(detectNotifyProtocol({ TERM_PROGRAM: "Apple_Terminal" } as NodeJS.ProcessEnv), "osc777",
    "an unsupported terminal simply ignores the sequence — there is no failure mode to branch on");
});

test("SECURITY: the payload cannot terminate or hijack the escape sequence", () => {
  // The text is agent-written and goes inside an OSC sequence: ESC and BEL end
  // it, and `;` separates its fields.
  const hostile = "title\u001b]0;pwned\u0007 and\u001b\\ more; fields";
  const clean = sanitizeNotifyText(hostile, 200);
  assert.doesNotMatch(clean, /[\u0000-\u001f\u007f-\u009f]/, "no control characters survive");
  assert.doesNotMatch(clean, /;/, "no field separator survives");
  assert.match(clean, /pwned/, "the TEXT survives — it is neutralized, not censored");
});

test("text is capped at the length the daemons actually render", () => {
  const long = "x".repeat(1000);
  assert.equal(sanitizeNotifyText(long, NOTIFY_TITLE_MAX).length, NOTIFY_TITLE_MAX);
  assert.ok(sanitizeNotifyText(long, NOTIFY_BODY_MAX).endsWith("…"));
  assert.equal(sanitizeNotifyText("  a   b  ", 50), "a b", "whitespace is collapsed");
  assert.equal(sanitizeNotifyText("", 50), "");
});

test("each protocol produces its own sequence", () => {
  assert.equal(buildNotifySequence("osc777", "T", "B"), "\u001b]777;notify;T;B\u0007");
  assert.equal(buildNotifySequence("osc9", "T", "B"), "\u001b]9;T: B\u0007");
  assert.match(buildNotifySequence("osc99", "T", "B"), /^\u001b\]99;i=1:d=0:p=title;T/);
});

test("inside tmux the sequence is wrapped in a passthrough with doubled ESCs", () => {
  const raw = "\u001b]777;notify;T;B\u0007";
  assert.equal(wrapForTmux(raw, false), raw, "outside tmux nothing is wrapped");
  const wrapped = wrapForTmux(raw, true);
  assert.ok(wrapped.startsWith("\u001bPtmux;"));
  assert.ok(wrapped.endsWith("\u001b\\"));
  assert.ok(wrapped.includes("\u001b\u001b]777"), "inner ESC bytes must be doubled or tmux eats the sequence");
});

test("prepareNotification sanitizes, detects and wraps in one call", () => {
  const payload = prepareNotification({
    title: "编排完成; 请验收",
    body: "plan 全部做完\u0007",
    env: { TMUX: "/tmp/sock,1,0" } as NodeJS.ProcessEnv,
  });
  assert.equal(payload.protocol, "osc777");
  assert.doesNotMatch(payload.title, /;/);
  assert.ok(payload.sequence.startsWith("\u001bPtmux;"), "TMUX in the env ⇒ passthrough");
  const empty = prepareNotification({ title: "   ", body: "x", env: {} as NodeJS.ProcessEnv });
  assert.equal(empty.title, "review-gate", "an empty title still names the sender");
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
  assert.equal(overflow.send, false, "a misbehaving run must not empty its plan into someone's phone");
  if (!overflow.send) assert.match(overflow.reason, /频率超限/);

  assert.deepEqual(
    decideNotify({ history, key: notifyKey("T", "one more"), now: T0 + NOTIFY_RATE_WINDOW_MS + 1 }),
    { send: true },
    "the window slides",
  );
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

test("writing is the ONE side effect, and it is injectable", () => {
  const written: string[] = [];
  writeNotification("SEQ", (chunk) => written.push(chunk));
  assert.deepEqual(written, ["SEQ"]);
  assert.doesNotThrow(() => writeNotification("SEQ", () => { throw new Error("no tty"); }),
    "a notification is never a gate condition — a failed write must not throw into a tool");
});

/**
 * TOLD HONESTLY (2026-09-17). Inside tmux, writing the sequence is not
 * delivery: tmux forwards a DCS passthrough only as far as `allow-passthrough`
 * allows — `off` (the default) forwards nothing, `on` forwards only when the
 * pane is VISIBLE, `all` always. The receipt used to say "已发出" in all three
 * cases, and measured on this machine the user's own value is `on` — so every
 * notification from a background window was dropped while the manager was told
 * it had reached them.
 */
test("the delivery note tells the truth for each allow-passthrough value", () => {
  assert.equal(passthroughDeliveryNote("all"), "", "nothing to warn about — it really went out");

  const on = passthroughDeliveryNote("on");
  assert.match(on, /只对可见的 pane/, "the visibility rule is the WHOLE reason a notification vanishes");
  assert.match(on, /set -g allow-passthrough all/, "…and the one line that fixes it is in the receipt");
  assert.doesNotMatch(on, /无法判断/, "this value is known, so nothing is hedged");

  const off = passthroughDeliveryNote("off");
  assert.match(off, /到不了你面前/, "off means it never arrives, visible pane or not");
  assert.match(off, /set -g allow-passthrough all/);
  assert.notEqual(off, on, "off and on are different failures and must not share one sentence");

  const unknown = passthroughDeliveryNote(undefined);
  assert.match(unknown, /无法判断/, "an unreadable value is reported as unknown, never rounded to fine");
  assert.match(unknown, /set -g allow-passthrough all/);

  // The gate NEVER writes that option itself, and the note must not read as if
  // it does: it hands over the line and the user decides.
  for (const note of [on, off, unknown]) {
    assert.match(note, /门禁不会替你改/, "the user's global config stays the user's");
  }
});
