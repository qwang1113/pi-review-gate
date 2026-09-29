import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createOpenerWatch,
  enforceOpenerBinding,
  forwardOpenerEnv,
  openerEnv,
  openerRebindPath,
  probeProcessStart,
  readOpenerEnv,
  readOpenerRebind,
  recordSuccessorOpener,
  resolveOpener,
  type ProcessIdentity,
  type ProcessProbe,
} from "../lib/opener-process.ts";

const OPENER: ProcessIdentity = { pid: 4242, started: "Mon Sep 28 10:00:00 2026" };
const SUCCESSOR: ProcessIdentity = { pid: 5151, started: "Tue Sep 29 09:00:00 2026" };

/** A process table: pid → start time. Anything absent is gone. */
const table = (rows: Record<number, string>): ProcessProbe => (pid) => rows[pid] ?? null;

test("the process table, not a file, says whether the opener is alive", () => {
  assert.equal(resolveOpener(OPENER, () => undefined, table({ 4242: OPENER.started })).status, "alive");
  assert.equal(resolveOpener(OPENER, () => undefined, table({})).status, "gone");
  // A recycled pid is a DIFFERENT process: same number, another start time.
  assert.equal(resolveOpener(OPENER, () => undefined, table({ 4242: "Tue Sep 29 11:11:11 2026" })).status, "gone");
  // A failed LOOK never kills anything.
  assert.equal(resolveOpener(OPENER, () => undefined, () => undefined).status, "unknown");
});

test("re-binding after a handover: only to a candidate that is alive right now", () => {
  const live = table({ 5151: SUCCESSOR.started });
  // 1. no candidate file ⇒ gone
  assert.equal(resolveOpener(OPENER, () => undefined, live).status, "gone");
  // 2. the candidate is itself dead ⇒ gone
  assert.equal(resolveOpener(OPENER, () => SUCCESSOR, table({})).status, "gone");
  // 3. the candidate names the very opener that just died ⇒ gone
  assert.equal(resolveOpener(OPENER, () => OPENER, live).status, "gone");
  // 4. a live successor ⇒ alive, and bound to IT from now on
  const rebound = resolveOpener(OPENER, () => SUCCESSOR, live);
  assert.deepEqual(rebound, { status: "alive", identity: SUCCESSOR });
  // A candidate whose pid lives but under another start time is not the successor.
  assert.equal(resolveOpener(OPENER, () => SUCCESSOR, table({ 5151: "later" })).status, "gone");
});

test("the watch keeps the re-bound identity, and a pane without one is never judged", () => {
  const rows: Record<number, string> = { 4242: OPENER.started };
  const env = openerEnv("sess-1", OPENER);
  const watch = createOpenerWatch(env, { probe: table(rows), readRebind: (key) => (key === "sess-1" ? SUCCESSOR : undefined) });
  assert.equal(watch.check(), "alive");
  delete rows[4242];
  rows[5151] = SUCCESSOR.started;
  assert.equal(watch.check(), "alive", "re-bound to the successor");
  delete rows[5151];
  assert.equal(watch.check(), "gone", "and it dies with the successor, not with a file");
  assert.equal(createOpenerWatch({}, { probe: table({}) }).check(), "unbound");
});

test("gone ⇒ every clock stops and pi is shut down; anything else ⇒ nothing happens", () => {
  const calls: string[] = [];
  const act = { stop: () => calls.push("stop"), shutdown: () => calls.push("shutdown") };
  for (const status of ["alive", "unknown", "unbound"] as const) {
    assert.equal(enforceOpenerBinding({ check: () => status }, act), false);
  }
  assert.deepEqual(calls, []);
  assert.equal(enforceOpenerBinding({ check: () => "gone" }, act), true);
  assert.deepEqual(calls, ["stop", "shutdown"]);
});

test("env round-trip, and a relay forwards the SAME opener", () => {
  const env = openerEnv("orch-1", OPENER);
  assert.deepEqual(readOpenerEnv(env), { identity: OPENER, key: "orch-1" });
  assert.deepEqual(forwardOpenerEnv(env), env);
  assert.deepEqual(forwardOpenerEnv({}), {}, "nothing to forward from a session nobody opened");
  assert.equal(readOpenerEnv({ ...env, RG_OPENER_PID: "x" }), undefined);
});

test("a successor writes its identity under the predecessor's keys — the orchestration only for a manager", () => {
  const home = mkdtempSync(join(tmpdir(), "opener-home-"));
  assert.deepEqual(
    recordSuccessorOpener({ kind: "orchestrator", predecessorSession: "pm-1" }, "orch-9", { identity: SUCCESSOR, home }),
    ["pm-1", "orch-9"],
  );
  assert.deepEqual(readOpenerRebind("orch-9", home), SUCCESSOR);
  assert.deepEqual(readOpenerRebind("pm-1", home), SUCCESSOR);
  // A CHILD's successor carries the same orchestration id and must not become
  // its siblings' opener.
  assert.deepEqual(
    recordSuccessorOpener({ kind: "child", predecessorSession: "c-1" }, "orch-7", { identity: SUCCESSOR, home }),
    ["c-1"],
  );
  assert.equal(readOpenerRebind("orch-7", home), undefined);
  assert.deepEqual(recordSuccessorOpener({}, "orch-9", { identity: SUCCESSOR, home }), [], "not a successor");
  // A corrupt file is no candidate.
  const bad = openerRebindPath("broken", home);
  mkdirSync(dirname(bad), { recursive: true });
  writeFileSync(bad, "{not json");
  assert.equal(readOpenerRebind("broken", home), undefined);
});

test("the real process table: this process is alive, a killed one is gone", async () => {
  const own = probeProcessStart(process.pid);
  assert.ok(own, "ps reports this process");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  const started = probeProcessStart(child.pid!);
  assert.ok(started);
  const identity = { pid: child.pid!, started: started! };
  assert.equal(resolveOpener(identity, () => undefined, probeProcessStart).status, "alive");
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(resolveOpener(identity, () => undefined, probeProcessStart).status, "gone");
});
