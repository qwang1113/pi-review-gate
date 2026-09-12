/**
 * The pane's own model self-heal: a round whose model died walks the role's
 * chain instead of sitting there until a human notices.
 *
 * The behaviour pinned here is the one measured missing on 2026-09-10: 25
 * failed requests, one audit round that could not end, and the user
 * hand-switching the model in the pane.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChainExhaustedNote,
  buildRotationResumeNote,
  createModelRotation,
} from "../lib/judge-model-rotation.ts";
import { summarizeModelError, type ModelEvent } from "../lib/model-health.ts";

const CHAIN = ["anthropic/claude-opus-5:max", "onekey/gpt-6-astra:xhigh", "anthropic/claude-fable-5-1:max"];

interface Harness {
  rotation: ReturnType<typeof createModelRotation>;
  events: ModelEvent[];
  notices: string[];
  nudges: string[];
  switched: string[];
}

function harness(opts: {
  chain?: string[];
  current?: string;
  refuses?: string[];
} = {}): Harness {
  const events: ModelEvent[] = [];
  const notices: string[] = [];
  const nudges: string[] = [];
  const switched: string[] = [];
  const chain = opts.chain ?? CHAIN;
  let current = opts.current ?? chain[0] ?? "";
  const rotation = createModelRotation({
    chain: () => chain,
    currentSpec: () => current,
    switchTo: async (spec) => {
      if (opts.refuses?.includes(spec)) return false;
      switched.push(spec);
      current = spec;
      return true;
    },
    nudge: (text) => nudges.push(text),
    report: (event) => events.push(event),
    notify: (text) => notices.push(text),
  });
  return { rotation, events, notices, nudges, switched };
}

test("a terminal model failure moves to the next slot and keeps the round going", async () => {
  const h = harness();
  const event = await h.rotation.onModelFailure("503 auth_unavailable");
  assert.equal(event?.spec, CHAIN[0]);
  assert.equal(event?.to, CHAIN[1]);
  assert.equal(event?.exhausted, undefined);
  assert.deepEqual(h.switched, [CHAIN[1]], "the pane actually switched models");
  assert.equal(h.nudges.length, 1, "the round is nudged to carry on, not abandoned");
  assert.match(h.nudges[0]!, /继续本轮任务/);
  assert.equal(h.events.length, 1, "the opener is told");
  assert.match(h.notices[0]!, /fallback/);
});

test("a chain that repeats a provider never spends the same model twice", async () => {
  const chain = ["onekey/gpt-6-astra:max", "onekey/gpt-6-astra:high", "anthropic/claude-opus-5:max"];
  const h = harness({ chain });
  await h.rotation.onModelFailure("503");
  assert.deepEqual(h.switched, [chain[2]!], "the same provider/id under another level is the same model");
});

test("a slot the registry refuses is walked past, not given up on", async () => {
  const h = harness({ refuses: [CHAIN[1]!] });
  const event = await h.rotation.onModelFailure("503");
  assert.deepEqual(h.switched, [CHAIN[2]!]);
  assert.equal(event?.to, CHAIN[2]);
});

test("a SECOND failure continues from where the pane landed", async () => {
  const h = harness();
  await h.rotation.onModelFailure("503");
  const second = await h.rotation.onModelFailure("502 status code (no body)");
  assert.equal(second?.spec, CHAIN[1], "the model that failed this time");
  assert.equal(second?.to, CHAIN[2]);
  assert.deepEqual(h.rotation.attempted(), [CHAIN[0], CHAIN[1], CHAIN[2]]);
});

test("an exhausted chain says so and does NOT nudge — the round is over", async () => {
  const h = harness({ chain: [CHAIN[0]!] });
  const event = await h.rotation.onModelFailure("503");
  assert.equal(event?.exhausted, true);
  assert.equal(event?.to, undefined);
  assert.equal(h.nudges.length, 0, "nothing left to continue on");
  assert.deepEqual(h.switched, []);
  assert.match(h.notices[0]!, /链上的模型都试过了/);
});

test("no chain at all is the caller's fail-closed case, not a rotation", async () => {
  const h = harness({ chain: [], current: "anthropic/claude-opus-5:max" });
  assert.equal(await h.rotation.onModelFailure("503"), undefined);
  assert.deepEqual(h.events, []);
});

test("the error text is summarised, never replayed in full", () => {
  assert.equal(summarizeModelError(undefined), undefined);
  assert.equal(summarizeModelError("  503\n  unavailable  "), "503 unavailable");
  const long = summarizeModelError("x".repeat(400));
  assert.equal(long?.length, 198);
  assert.ok(long?.endsWith("…"));
});

test("the two notes name the models, and the resume note tells the judge what NOT to do", () => {
  const resume = buildRotationResumeNote("a/x", "b/y", "503");
  assert.match(resume, /a\/x 失败（503）/);
  assert.match(resume, /切到链上的下一个模型 b\/y/);
  assert.match(resume, /不要重做已经完成的部分/);
  assert.match(buildChainExhaustedNote("a/x"), /不要自己下结论/);
});
