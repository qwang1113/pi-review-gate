/**
 * RACING A PROMISE AGAINST AN ABORT — the ONE implementation the gate uses.
 *
 * Quality round P2 (2026-09-18): the fix for the frozen session grew the same
 * fifteen lines twice in one round — the dialog queue giving up its turn, and
 * the reason box stopping being waited on. Same `{ once: true }` listener, same
 * `settled` guard, same detached listener on the non-abort path, same fold of a
 * rejection into the abort answer. Both callers now come here instead
 * (AGENTS.md 哲学三: 永不并行两套实现), so "settle exactly once" is written
 * once and tested once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { raceAbort } from "../lib/abort-race.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the work wins when it finishes first", async () => {
  const live = new AbortController();
  assert.equal(await raceAbort(Promise.resolve("done"), live.signal, "cancelled"), "done");
});

test("the abort wins, and the answer is the CALLER's", async () => {
  const aborter = new AbortController();
  const pending = raceAbort(new Promise<string>(() => {}), aborter.signal, "cancelled");
  aborter.abort();
  assert.equal(await pending, "cancelled");
});

test("an already-aborted signal resolves at once, without waiting for the work", async () => {
  const dead = new AbortController();
  dead.abort();
  const never = new Promise<string>(() => {});
  assert.equal(await raceAbort(never, dead.signal, "cancelled"), "cancelled");
});

test("a rejection lands on the abort answer instead of taking the process down", async () => {
  // Neither caller has anything better to do with a throwing host or a broken
  // predecessor, and an unhandled rejection here would kill the session over a
  // dialog.
  const live = new AbortController();
  assert.equal(
    await raceAbort(Promise.reject(new Error("host exploded")), live.signal, "cancelled"),
    "cancelled",
  );
});

test("exactly one answer, whichever side is first", async () => {
  const aborter = new AbortController();
  let answers = 0;
  const raced = raceAbort(Promise.resolve("done"), aborter.signal, "cancelled").then((value) => {
    answers += 1;
    return value;
  });
  await settle();
  aborter.abort();
  assert.equal(await raced, "done", "the work got there first — that is what `settle` above arranged");
  await settle();
  assert.equal(answers, 1, "the late abort must not settle it a second time");
});
