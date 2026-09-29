/**
 * EVERY PLACE THE GATE CAN START A TURN, ON THE RECORD (2026-09-29).
 *
 * The wake storm was not one bug: four sources each woke an idle session on
 * their own clock, with no upper bound, over facts that had not changed.
 * lib/wake-governor.ts is the one throttle idle-time wakes pass; this test is
 * what keeps a FIFTH source from being added beside it. Every call that can
 * start a turn is counted per file and must match the list below, each entry
 * saying why it is not an idle re-announcement. A new one fails here until it
 * goes through the governor or earns an entry.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

const ALLOWED: Record<string, { count: number; why: string }> = {
  "lib/wake-governor.ts": { count: 2, why: "the governor itself — the one place a governed wake is sent" },
  "lib/l2-continuation.ts": {
    count: 2,
    why: "CHILD_ENDED is announced once per judge (a new fact); RESUME answers the turn that just ended and is bounded by maxRounds + the loop-stall breaker",
  },
  "lib/orchestrator-runtime-host.ts": {
    count: 2,
    why: "a supervision notice to a BUSY manager rides the running turn (idle ones go through the governor); the settle continuation answers the turn that just ended, bounded by maxRounds",
  },
  "lib/child-side-host.ts": { count: 3, why: "delivers an instruction the supervisor wrote (one delivery per instruction)" },
  "lib/turn-directive.ts": { count: 2, why: "the thinking-loop notice, replacing the turn the gate itself aborted" },
  "lib/judge-pane-self.ts": { count: 2, why: "a judge's own model-switch notice inside its round" },
  "lib/judge-round-settle.ts": { count: 1, why: "a round's report — a new verdict, delivered once" },
  "lib/precommit-lane.ts": { count: 1, why: "the lane's failure report, once per round" },
  "lib/round-cancel-host.ts": { count: 1, why: "the cancel matrix's verdict, once per round" },
  "lib/session-worktree-host.ts": { count: 1, why: "the relocate command a user-confirmed dialog asked for" },
  "lib/gate-command-tools.ts": { count: 1, why: "a slash command the user typed" },
  "extensions/review-gate.ts": { count: 1, why: "a message another session sent to this one (send_message)" },
};

const TURN_STARTER = /\bsendUserMessage\(|triggerTurn:\s*true/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => `${dir}/${e.name}`);
}

function countSites(file: string): number {
  let n = 0;
  for (const line of readFileSync(join(ROOT, file), "utf8").split("\n")) {
    const code = line.trim();
    if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) continue;
    // A method SIGNATURE in an interface is not a call.
    if (/^sendUserMessage\(\w+:/.test(code)) continue;
    n += code.match(TURN_STARTER)?.length ?? 0;
  }
  return n;
}

test("every call that can start a turn is on the record — idle wakes go through lib/wake-governor.ts", () => {
  const found: Record<string, number> = {};
  for (const file of [...sourceFiles("lib"), ...sourceFiles("extensions")]) {
    const n = countSites(file);
    if (n > 0) found[file] = n;
  }
  const expected = Object.fromEntries(Object.entries(ALLOWED).map(([f, { count }]) => [f, count]));
  assert.deepEqual(
    found,
    expected,
    "a turn-starting call was added or removed. An idle-time wake must go through " +
    "lib/wake-governor.ts (createWakeGovernor().wake); anything else needs an entry in ALLOWED saying why it is not one.",
  );
});
