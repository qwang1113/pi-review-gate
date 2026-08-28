import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTENTION_THROTTLE_MS,
  ATTENTION_TTL_MS,
  attentionChannelFor,
  attentionText,
  consumeAttention,
  parentSessionId,
  publishAttention,
  sideEffectsEnabled,
  type AttentionDeps,
} from "../lib/attention.ts";

/** In-memory state + recorded side effects, so no test ever touches tmux. */
function harness(startMs = Date.parse("2026-08-28T03:00:00.000Z")) {
  let raw: string | undefined;
  let clock = startMs;
  const signals: string[] = [];
  const deps: AttentionDeps = {
    now: () => clock,
    readState: () => raw,
    writeState: (next) => { raw = next; },
    signal: (c) => { signals.push(c); },
    sideEffects: () => true,
  };
  return {
    deps,
    signals,
    advance: (ms: number) => { clock += ms; },
    state: () => (raw ? JSON.parse(raw) as { events: Array<Record<string, unknown>> } : { events: [] }),
  };
}

const SELF = "session-self";
const PARENT = "session-parent";
const UNRELATED = "session-unrelated";
const input = { fromSessionId: SELF, toSessionId: PARENT, fromPane: "%800", fromWindow: "tmax(@365)", repo: "/w/pi-review-gate", reason: "等待 goal 批准" };

test("(a) the bell is DIRECTED: published on the PARENT's channel, and only the parent consumes it", () => {
  const h = harness();
  const pub = publishAttention(input, h.deps);
  assert.equal(pub.status, "sent");
  assert.deepEqual(h.signals, [attentionChannelFor(PARENT)], "the signal goes to the parent's channel, never a global one");
  // The parent sees it; an unrelated session is INVISIBLE to it.
  assert.ok(consumeAttention(PARENT, h.deps), "the addressed parent is woken");
  const h2 = harness();
  publishAttention(input, h2.deps);
  assert.equal(consumeAttention(UNRELATED, h2.deps), undefined, "an unrelated session never sees somebody else's event");
});

test("(b) a session without a parent publishes NOTHING (no-parent, no file, no signal)", () => {
  const h = harness();
  const pub = publishAttention({ ...input, toSessionId: undefined }, h.deps);
  assert.equal(pub.status, "no-parent");
  assert.deepEqual(h.signals, [], "no tmux signal");
  assert.deepEqual(h.state().events, [], "nothing is even recorded");
});

test("(c) a session never wakes ITSELF — its own event addressed to its parent is invisible to it", () => {
  const h = harness();
  publishAttention(input, h.deps);
  assert.equal(consumeAttention(SELF, h.deps), undefined, "own event must never wake the publisher");
  assert.ok(consumeAttention(PARENT, h.deps), "the parent still sees it");
});

test("(d) N rapid publishes of the same (repo, reason) to the SAME parent ring the bell ONCE", () => {
  const h = harness();
  const results = [1, 2, 3, 4, 5].map(() => publishAttention(input, h.deps).status);
  assert.deepEqual(results, ["sent", "throttled", "throttled", "throttled", "throttled"]);
  assert.deepEqual(h.signals, [attentionChannelFor(PARENT)], "exactly one tmux signal");
  // A different reason is a different event — never swallowed by the throttle.
  assert.equal(publishAttention({ ...input, reason: "等待回答提问" }, h.deps).status, "sent");
  // And the window does expire.
  h.advance(ATTENTION_THROTTLE_MS + 1);
  assert.equal(publishAttention(input, h.deps).status, "sent");
});

test("(e) a handled event never wakes anybody again; an expired one never wakes at all", () => {
  const h = harness();
  publishAttention(input, h.deps);
  assert.ok(consumeAttention(PARENT, h.deps), "first consume delivers");
  assert.equal(consumeAttention(PARENT, h.deps), undefined, "handled events are done");
  assert.ok(h.state().events.every((e) => typeof e.handledAt === "string"), "handledAt is persisted");

  const h2 = harness();
  publishAttention(input, h2.deps);
  h2.advance(ATTENTION_TTL_MS + 1);
  assert.equal(consumeAttention(PARENT, h2.deps), undefined, "expired events are ignored");
});

test("(f) test / non-interactive hosts produce NO external side effect", () => {
  const h = harness();
  const off: AttentionDeps = { ...h.deps, sideEffects: () => false };
  assert.equal(publishAttention(input, off).status, "disabled");
  assert.deepEqual(h.signals, [], "no tmux signal");
  assert.deepEqual(h.state().events, [], "nothing is even recorded");

  // The real predicate: a test run, CI, a piped stdout or a tmux-less host is silent.
  const tty = { TMUX: "/tmp/tmux-501/default" } as NodeJS.ProcessEnv;
  assert.equal(sideEffectsEnabled({ ...tty, NODE_ENV: "test" }, true), false, "NODE_ENV=test");
  assert.equal(sideEffectsEnabled({ ...tty, RG_NO_SIDE_EFFECTS: "1" }, true), false, "explicit opt-out");
  assert.equal(sideEffectsEnabled({ ...tty, CI: "1" }, true), false, "CI");
  assert.equal(sideEffectsEnabled(tty, false), false, "not a TTY (headless pi -p)");
  assert.equal(sideEffectsEnabled({}, true), false, "no tmux");
  assert.equal(sideEffectsEnabled(tty, true), true, "interactive tmux host publishes");
  // Round-17 P2 (reviewer, measured): `node --test` sets NODE_TEST_CONTEXT, NOT
  // NODE_ENV — without this branch the suite's silence rested on isTTY alone.
  assert.equal(sideEffectsEnabled({ ...tty, NODE_TEST_CONTEXT: "child-v8" }, true), false, "node --test child");
  assert.equal(sideEffectsEnabled({ ...tty, NODE_TEST_CONTEXT: "top-level" }, true), false, "node --test top level");
  // And the real runtime this very test executes in must be silent:
  assert.equal(sideEffectsEnabled(process.env, true), false, "THIS test process may not fire side effects");
});

test("(g) wake text and event carry origin + repo + reason + BOTH endpoints", () => {
  const h = harness();
  const { event } = publishAttention(input, h.deps);
  const text = attentionText(event!);
  assert.match(text, /tmax\(@365\)/, "originating window");
  assert.match(text, /pi-review-gate/, "repo");
  assert.match(text, /等待 goal 批准/, "reason");
  assert.equal(event!.toSessionId, PARENT, "the event names its parent");
  assert.equal(event!.fromSessionId, SELF, "the event names its sender");
});

test("(h) attentionChannelFor derives a safe, per-session channel", () => {
  assert.equal(attentionChannelFor("abc-123"), "rg-attention-abc-123");
  assert.equal(attentionChannelFor("bad/id"), "rg-attention-bad-id", "unsafe chars are sanitized");
  assert.notEqual(attentionChannelFor("a"), attentionChannelFor("b"), "two sessions never share a bell");
});

test("(i) parentSessionId reads RG_PARENT_SESSION from the environment, absent when unset", () => {
  assert.equal(parentSessionId({}), undefined);
  assert.equal(parentSessionId({ RG_PARENT_SESSION: "" }), undefined, "empty is absent");
  assert.equal(parentSessionId({ RG_PARENT_SESSION: "  parent-1  " }), "parent-1", "trimmed");
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

test("the REAL state file is written atomically and round-trips through publish/consume", async () => {
  const { mkdtempSync, readdirSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "rg-attention-"));
  const statePath = join(dir, "nested", "state.json");
  const deps = { statePath, sideEffects: () => true, signal: () => {} };

  const pub = publishAttention({ ...input, fromSessionId: "other" }, deps);
  assert.equal(pub.status, "sent");
  assert.deepEqual(readdirSync(join(dir, "nested")), ["state.json"], "no .tmp file is left behind");
  JSON.parse(readFileSync(statePath, "utf8"));

  assert.equal(consumeAttention("not-the-parent", deps), undefined, "still filters by address through the real file");
  const got = consumeAttention(PARENT, deps);
  assert.equal(got?.reason, input.reason, "the parent reads the payload back from disk");
  assert.equal(consumeAttention(PARENT, deps), undefined, "the handled mark survived the write");
});
