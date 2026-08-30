import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderProgress,
  createProgressReporter,
  withSlowNotice,
  toolNotice,
  statusNotice,
  PROGRESS_THROTTLE_MS,
  type ToolUpdate,
} from "../lib/progress-stream.ts";

/** Collect what a tool would have shown the user. */
function sink(): { updates: string[]; onUpdate: ToolUpdate } {
  const updates: string[] = [];
  return {
    updates,
    onUpdate: (partial) => { updates.push(partial.content.map((c) => c.text).join("\n")); },
  };
}

test("renderProgress states each step with its marker, detail and elapsed time", () => {
  const text = renderProgress("review-gate: judge_submit", [
    { label: "precommit (full)", state: "done", detail: "PASS", elapsedMs: 92_000 },
    { label: "checkpoint", state: "running", elapsedMs: 1_400 },
  ], 93_400);
  assert.equal(text, [
    "review-gate: judge_submit（已耗时 93s）",
    "  ✓ precommit (full) — PASS 92s",
    "  … checkpoint 1s",
  ].join("\n"));
});

test("renderProgress appends the live tail only when there is one", () => {
  const steps = [{ label: "test", state: "running" as const, elapsedMs: 0 }];
  assert.doesNotMatch(renderProgress("t", steps, 0, "   \n "), /实时输出/);
  assert.match(renderProgress("t", steps, 0, "running suite\n"), /--- 实时输出 ---\nrunning suite$/);
});

test("renderProgress survives an empty run (no steps, no tail)", () => {
  assert.equal(renderProgress("t", [], 0), "t（已耗时 0s）");
});

test("a step transition publishes immediately; a tail update is throttled", () => {
  let clock = 0;
  const { updates, onUpdate } = sink();
  const r = createProgressReporter({ title: "t", onUpdate, now: () => clock });
  r.step("precommit");
  assert.equal(updates.length, 1, "starting a step publishes at once");
  clock += 100;
  r.tail("line 1");
  assert.equal(updates.length, 1, "a tail inside the throttle window does not repaint");
  clock += PROGRESS_THROTTLE_MS;
  r.tail("line 2");
  assert.equal(updates.length, 2, "…and does once the window has passed");
  assert.match(updates[1], /line 2/);
});

test("the previous step is closed when the next one starts, and failures are marked", () => {
  let clock = 0;
  const { updates, onUpdate } = sink();
  const r = createProgressReporter({ title: "t", onUpdate, now: () => clock });
  r.step("precommit");
  clock += 92_000;
  r.step("checkpoint");
  clock += 2_000;
  r.fail("rejected");
  const last = updates[updates.length - 1];
  assert.match(last, /✓ precommit 92s/, "the closed step keeps the time IT took");
  assert.match(last, /✗ checkpoint — rejected 2s/);
});

test("an identical frame is not repainted", () => {
  let clock = 0;
  const { updates, onUpdate } = sink();
  const r = createProgressReporter({ title: "t", onUpdate, now: () => clock });
  r.step("a");
  r.flush();
  r.flush();
  assert.equal(updates.length, 1, "nothing moved, nothing published");
});

test("without an onUpdate sink every reporter call is a no-op", () => {
  const r = createProgressReporter({ title: "t" });
  r.step("a");
  r.tail("x");
  r.done("ok");
  r.fail("no");
  r.flush(); // must not throw
});

test("a sink that throws never breaks the tool it decorates", () => {
  const r = createProgressReporter({
    title: "t",
    onUpdate: () => { throw new Error("UI is gone"); },
  });
  r.step("a");
  r.flush();
});

test("withSlowNotice stays silent for a fast call", async () => {
  const { updates, onUpdate } = sink();
  const value = await withSlowNotice(toolNotice(onUpdate), "still classifying…", async () => 42, 50);
  assert.equal(value, 42);
  assert.deepEqual(updates, []);
});

test("withSlowNotice announces once when the call drags on", async () => {
  const { updates, onUpdate } = sink();
  const value = await withSlowNotice(toolNotice(onUpdate), "still classifying…", async () => {
    await new Promise((r) => setTimeout(r, 40));
    return "done";
  }, 5);
  assert.equal(value, "done");
  assert.deepEqual(updates, ["still classifying…"]);
});

test("withSlowNotice clears its timer when the work throws", async () => {
  const { updates, onUpdate } = sink();
  await assert.rejects(
    withSlowNotice(toolNotice(onUpdate), "slow", async () => { throw new Error("boom"); }, 5),
    /boom/,
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(updates, [], "a failed call must not announce itself afterwards");
});

test("statusNotice writes and then CLEARS the gate's own status line", async () => {
  const calls: Array<[string, string | undefined]> = [];
  const notice = statusNotice({ setStatus: (k, t) => { calls.push([k, t]); } }, "review-gate-llm");
  await withSlowNotice(notice, "classifying…", async () => {
    await new Promise((r) => setTimeout(r, 30));
  }, 5);
  assert.deepEqual(calls, [["review-gate-llm", "classifying…"], ["review-gate-llm", undefined]]);
});

test("a fast call leaves the status bar untouched", async () => {
  const calls: Array<[string, string | undefined]> = [];
  const notice = statusNotice({ setStatus: (k, t) => { calls.push([k, t]); } }, "review-gate-llm");
  await withSlowNotice(notice, "classifying…", async () => "fast", 200);
  assert.deepEqual(calls, [], "nothing was shown, so nothing must be cleared");
});

test("a host without a status bar yields no sink at all", () => {
  assert.equal(statusNotice(undefined, "k"), undefined);
  assert.equal(statusNotice({}, "k"), undefined);
  assert.equal(toolNotice(undefined), undefined);
});
