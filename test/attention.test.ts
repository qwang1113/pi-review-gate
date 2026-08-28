import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTENTION_CHANNEL,
  ATTENTION_THROTTLE_MS,
  ATTENTION_TTL_MS,
  attentionText,
  consumeAttention,
  publishAttention,
  sideEffectsEnabled,
  type AttentionDeps,
} from "../lib/attention.ts";

/** In-memory state + recorded side effects, so no test ever touches tmux or osascript. */
function harness(startMs = Date.parse("2026-08-28T03:00:00.000Z")) {
  let raw: string | undefined;
  let clock = startMs;
  const signals: string[] = [];
  const notes: Array<{ title: string; body: string }> = [];
  const deps: AttentionDeps = {
    now: () => clock,
    readState: () => raw,
    writeState: (next) => { raw = next; },
    signal: (c) => { signals.push(c); },
    notify: (title, body) => { notes.push({ title, body }); },
    sideEffects: () => true,
  };
  return {
    deps,
    signals,
    notes,
    advance: (ms: number) => { clock += ms; },
    state: () => (raw ? JSON.parse(raw) as { events: Array<Record<string, unknown>> } : { events: [] }),
  };
}

const SELF = "session-self";
const OTHER = "session-other";
const input = { fromSessionId: OTHER, fromPane: "%800", fromWindow: "tmax(@365)", repo: "/w/pi-review-gate", reason: "等待 goal 批准" };

test("(a) a session never wakes itself — its OWN event is invisible to consume (P0 self-wake loop)", () => {
  const h = harness();
  const pub = publishAttention({ ...input, fromSessionId: SELF }, h.deps);
  assert.equal(pub.status, "sent");
  assert.equal(consumeAttention(SELF, h.deps), undefined, "own event must never wake the publisher");
  // Another session still sees it.
  assert.ok(consumeAttention(OTHER, h.deps), "a different session is woken by that same event");
});

test("(b) N rapid publishes of the same (repo, reason) ring the bell ONCE", () => {
  const h = harness();
  const results = [1, 2, 3, 4, 5].map(() => publishAttention(input, h.deps).status);
  assert.deepEqual(results, ["sent", "throttled", "throttled", "throttled", "throttled"]);
  assert.deepEqual(h.signals, [ATTENTION_CHANNEL], "exactly one tmux signal");
  assert.equal(h.notes.length, 1, "exactly one notification (screenshot showed 10+)");
  // A different reason is a different event — never swallowed by the throttle.
  assert.equal(publishAttention({ ...input, reason: "等待回答提问" }, h.deps).status, "sent");
  // And the window does expire.
  h.advance(ATTENTION_THROTTLE_MS + 1);
  assert.equal(publishAttention(input, h.deps).status, "sent");
});

test("(c) a handled event never wakes anybody again; an expired one never wakes at all", () => {
  const h = harness();
  publishAttention(input, h.deps);
  assert.ok(consumeAttention(SELF, h.deps), "first consume delivers");
  assert.equal(consumeAttention(SELF, h.deps), undefined, "handled events are done");
  assert.ok(h.state().events.every((e) => typeof e.handledAt === "string"), "handledAt is persisted");

  const h2 = harness();
  publishAttention(input, h2.deps);
  h2.advance(ATTENTION_TTL_MS + 1);
  assert.equal(consumeAttention(SELF, h2.deps), undefined, "expired events are ignored");
});

test("(d) test / non-interactive hosts produce NO external side effect", () => {
  const h = harness();
  const off: AttentionDeps = { ...h.deps, sideEffects: () => false };
  assert.equal(publishAttention(input, off).status, "disabled");
  assert.deepEqual(h.signals, [], "no tmux signal");
  assert.deepEqual(h.notes, [], "no osascript notification");
  assert.deepEqual(h.state().events, [], "nothing is even recorded");

  // The real predicate: a test run, CI, a piped stdout or a tmux-less host is silent.
  const tty = { TMUX: "/tmp/tmux-501/default" } as NodeJS.ProcessEnv;
  assert.equal(sideEffectsEnabled({ ...tty, NODE_ENV: "test" }, true), false, "NODE_ENV=test");
  assert.equal(sideEffectsEnabled({ ...tty, RG_NO_SIDE_EFFECTS: "1" }, true), false, "explicit opt-out");
  assert.equal(sideEffectsEnabled({ ...tty, CI: "1" }, true), false, "CI");
  assert.equal(sideEffectsEnabled(tty, false), false, "not a TTY (headless pi -p)");
  assert.equal(sideEffectsEnabled({}, true), false, "no tmux");
  assert.equal(sideEffectsEnabled(tty, true), true, "interactive tmux host publishes");
});

test("(e) wake text and notification carry origin + repo + reason", () => {
  const h = harness();
  const { event } = publishAttention(input, h.deps);
  const text = attentionText(event!);
  assert.match(text, /tmax\(@365\)/, "originating window");
  assert.match(text, /pi-review-gate/, "repo");
  assert.match(text, /等待 goal 批准/, "reason");
  assert.match(h.notes[0]!.title, /review-gate · tmax\(@365\)/, "notification title identifies the session");
  assert.equal(h.notes[0]!.body, text, "notification body is the same contextual line");
});

test("the state file keeps a bounded, JSON-parseable history", () => {
  const h = harness();
  for (let i = 0; i < 30; i++) {
    publishAttention({ ...input, reason: `reason-${i}` }, h.deps);
  }
  const events = h.state().events;
  assert.ok(events.length <= 20, `history is bounded (got ${events.length})`);
  assert.ok(events.every((e) => typeof e.id === "string" && typeof e.createdAt === "string"));
});
