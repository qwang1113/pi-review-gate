import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THINKING_LOOP_CAP_NOTICE,
  THINKING_LOOP_INJECTION,
  THINKING_LOOP_MAX_RECOVERIES,
  THINKING_LOOP_NOTICE,
  createThinkingLoopController,
} from "../lib/thinking-loop-controller.ts";
import { THINKING_TRUNCATION_MARKER } from "../lib/thinking-loop-guard.ts";

const LOOP_SAMPLE = "好。执行。好。（输出）好。好。";

function loopText(chars: number): string {
  return LOOP_SAMPLE.repeat(Math.ceil(chars / LOOP_SAMPLE.length)).slice(0, chars);
}

/** Long, healthy, never-repeating thinking — must never be cut. */
function healthyThinking(chars: number): string {
  const out: string[] = [];
  let length = 0;
  for (let i = 0; length < chars; i++) {
    const line = `第${i}步：检查 ${i}.ts 里 ${i * 17} 行的条件分支，确认它与上游第 ${i * 3} 个调用的契约一致。`;
    out.push(line);
    length += line.length;
  }
  return out.join("").slice(0, chars);
}

function harness() {
  const injected: string[] = [];
  const notified: string[] = [];
  let aborts = 0;
  const controller = createThinkingLoopController({
    abort: () => {
      aborts += 1;
    },
    notify: (message) => notified.push(message),
    inject: (text) => injected.push(text),
  });
  return {
    controller,
    injected,
    notified,
    get aborts() {
      return aborts;
    },
  };
}

/** Run one spinning turn: fresh turn, stream a loop, end it. */
function spin(h: ReturnType<typeof harness>, chars = 4000): void {
  h.controller.startTurn();
  for (let i = 0; i < chars; i += 17) {
    h.controller.observe("thinking", loopText(chars).slice(i, i + 17));
  }
  h.controller.endTurn();
}

test("a trip aborts, injects one notice for the model, and notifies the human", () => {
  const h = harness();
  spin(h);
  assert.equal(h.aborts, 1);
  assert.deepEqual(h.injected, [THINKING_LOOP_INJECTION]);
  assert.deepEqual(h.notified, [THINKING_LOOP_NOTICE]);
  assert.deepEqual(h.controller.state(), { recoveries: 1, tripped: true });
});

test("auto-recovery stops at the cap but aborting and notifying continue", () => {
  const h = harness();
  for (let i = 0; i < THINKING_LOOP_MAX_RECOVERIES; i++) spin(h);
  assert.equal(h.injected.length, THINKING_LOOP_MAX_RECOVERIES);
  assert.equal(h.notified.length, THINKING_LOOP_MAX_RECOVERIES);

  spin(h); // one past the cap
  assert.equal(h.injected.length, THINKING_LOOP_MAX_RECOVERIES, "no further injection");
  assert.equal(h.notified.at(-1), THINKING_LOOP_CAP_NOTICE);
  assert.equal(h.aborts, THINKING_LOOP_MAX_RECOVERIES + 1, "still aborts");
  assert.deepEqual(h.controller.state(), {
    recoveries: THINKING_LOOP_MAX_RECOVERIES,
    tripped: true,
  });
});

test("a productive turn resets the recovery counter", () => {
  const h = harness();
  for (let i = 0; i < THINKING_LOOP_MAX_RECOVERIES; i++) spin(h);
  assert.equal(h.controller.state().recoveries, THINKING_LOOP_MAX_RECOVERIES);

  // A turn that emits text is a real recovery.
  h.controller.startTurn();
  h.controller.observe("text", "Done.");
  h.controller.endTurn();
  assert.equal(h.controller.state().recoveries, 0);

  // …so the next loop gets a fresh budget.
  spin(h);
  assert.equal(h.injected.length, THINKING_LOOP_MAX_RECOVERIES + 1);
});

test("a turn that ends without producing anything does not reset the counter", () => {
  const h = harness();
  spin(h);
  h.controller.startTurn();
  h.controller.observe("thinking", "短");
  h.controller.endTurn();
  assert.equal(h.controller.state().recoveries, 1);
});

test("truncateDisplay is CONTENT-addressed, not session-addressed", () => {
  // Reviewer P1, round 1: a session-level "truncating now" flag cut every
  // thinking block while set and stopped cutting the tripped one as soon as
  // the next turn cleared it. The transformer is handed a string, never a
  // message id, so the ONLY correct owner of the decision is the content.
  const h = harness();
  const loop = loopText(50_000);
  const healthy = healthyThinking(50_000);

  // Before any trip, the loop block is ALREADY cut — it is a loop on its face.
  const cut = h.controller.truncateDisplay(loop, "assistant-thinking");
  assert.ok(cut.startsWith(THINKING_TRUNCATION_MARKER));
  assert.ok(cut.length < loop.length);
  // A healthy long block is never touched, tripped session or not.
  assert.equal(h.controller.truncateDisplay(healthy, "assistant-thinking"), healthy);
  // Non-thinking messages are never rewritten.
  assert.equal(h.controller.truncateDisplay(loop, "assistant"), loop);
  assert.equal(h.controller.truncateDisplay(loop, "user"), loop);

  // After a trip AND after the next turn starts, the loop block stays cut —
  // re-rendering it (resize, restored session) must not re-flood the terminal.
  spin(h);
  h.controller.startTurn();
  assert.ok(h.controller.truncateDisplay(loop, "assistant-thinking").startsWith(THINKING_TRUNCATION_MARKER));
});

test("startTurn keeps the recovery history", () => {
  const h = harness();
  spin(h);
  h.controller.startTurn();
  assert.equal(h.controller.state().recoveries, 1);
  assert.equal(h.controller.state().tripped, true);
});
