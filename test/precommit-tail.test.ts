/**
 * Live tail of the precommit run log.
 *
 * The unit exists because the runner's log is written through a FILE
 * DESCRIPTOR (never a pipe — a stalled pipe reader deadlocks a detached
 * runner at the 64KB buffer), so liveness has to come from reading. What must
 * hold, and is pinned here:
 *
 *   - appended chunks reach the sink while the runner is still writing;
 *   - `stop()` performs a FINAL read, so the lines a killed runner wrote
 *     between two ticks are not lost (the abort/timeout path);
 *   - the forwarded stream equals the file's full content (nothing dropped,
 *     nothing duplicated);
 *   - a throwing sink can never stall the run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailLogFile, NODE_TAIL_IO, type TailIo } from "../lib/precommit-tail.ts";

function tempLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-tail-"));
  return join(dir, "output.log");
}

/** Manual clock: `pump` runs only when the test says so (no real timers). */
function manualTail(path: string, sink: (t: string) => void, io: TailIo) {
  const ticks: (() => void)[] = [];
  const realSetInterval = globalThis.setInterval;
  (globalThis as { setInterval: unknown }).setInterval = ((fn: () => void) => {
    ticks.push(fn);
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  try {
    const handle = tailLogFile(path, sink, { io });
    return { handle, tick: () => ticks.forEach((f) => f()) };
  } finally {
    (globalThis as { setInterval: unknown }).setInterval = realSetInterval;
  }
}

test("tail forwards appended chunks while the runner is still writing", () => {
  const path = tempLog();
  writeFileSync(path, "# Precommit plan (fast) — 2 step(s) to run\n");
  const seen: string[] = [];
  const { handle, tick } = manualTail(path, (t) => seen.push(t), NODE_TAIL_IO);

  tick();
  assert.match(seen.join(""), /Precommit plan/, "the plan preamble must arrive before any check finishes");

  appendFileSync(path, "▶ lint — npm run lint\n");
  tick();
  assert.match(seen.join(""), /lint/, "later appends must be forwarded too");

  handle.stop();
  rmSync(path, { force: true });
});

test("stop() flushes what was written between two ticks (abort/timeout path)", () => {
  const path = tempLog();
  writeFileSync(path, "first\n");
  const seen: string[] = [];
  const { handle, tick } = manualTail(path, (t) => seen.push(t), NODE_TAIL_IO);
  tick();

  // The runner is killed (abort or the 20-minute timeout) right after writing
  // its last lines — no further tick will happen.
  appendFileSync(path, "killed-after-this\n");
  handle.stop();

  assert.match(seen.join(""), /killed-after-this/, "stop() must do a final read");
  assert.equal(seen.join(""), "first\nkilled-after-this\n", "forwarded stream must equal the log exactly");
  rmSync(path, { force: true });
});

test("forwarded stream never duplicates or drops content", () => {
  const path = tempLog();
  writeFileSync(path, "");
  const seen: string[] = [];
  const { handle, tick } = manualTail(path, (t) => seen.push(t), NODE_TAIL_IO);

  const lines = ["a".repeat(100), "b".repeat(100), "c".repeat(100)];
  for (const line of lines) { appendFileSync(path, `${line}\n`); tick(); }
  handle.stop();

  assert.equal(seen.join(""), lines.map((l) => `${l}\n`).join(""));
  assert.equal(handle.forwarded(), lines.reduce((n, l) => n + l.length + 1, 0));
  rmSync(path, { force: true });
});

test("a missing log and a throwing sink are both survivable", () => {
  const missing = join(tmpdir(), "rg-tail-does-not-exist", "output.log");
  const { handle: h1, tick: t1 } = manualTail(missing, () => {}, NODE_TAIL_IO);
  t1();
  h1.stop(); // must not throw

  const path = tempLog();
  writeFileSync(path, "boom\n");
  const { handle: h2, tick: t2 } = manualTail(path, () => { throw new Error("sink exploded"); }, NODE_TAIL_IO);
  t2(); // a failing consumer must never propagate into the run
  h2.stop();
  rmSync(path, { force: true });
});

test("a multibyte character split across two polls is not corrupted", () => {
  // The runner's log is full of non-ASCII (▶, ✅, ·, Chinese step names), and a
  // poll boundary lands wherever the writer happens to be. Decoding each byte
  // slice on its own would emit U+FFFD and move the cursor past it, corrupting
  // the stream permanently.
  const path = tempLog();
  const bytes = Buffer.from("▶ lint\n", "utf8");
  writeFileSync(path, bytes.subarray(0, 2)); // first 2 of the 3 bytes of ▶

  const seen: string[] = [];
  const { handle, tick } = manualTail(path, (t) => seen.push(t), NODE_TAIL_IO);
  tick();
  assert.ok(!seen.join("").includes("\uFFFD"), "a partial character must be held back, never emitted as U+FFFD");

  writeFileSync(path, bytes); // the rest of the character arrives
  tick();
  handle.stop();

  assert.equal(seen.join(""), "▶ lint\n", "the completed character must be forwarded intact");
  rmSync(path, { force: true });
});

test("a truncated log resets the cursor instead of reading from a stale offset", () => {
  const path = tempLog();
  writeFileSync(path, "long first content\n");
  const seen: string[] = [];
  const { handle, tick } = manualTail(path, (t) => seen.push(t), NODE_TAIL_IO);
  tick();

  writeFileSync(path, "x\n"); // shorter than the cursor
  tick();
  handle.stop();

  assert.equal(seen.at(-1), "x\n", "after truncation the tail re-reads from the start");
  rmSync(path, { force: true });
});
