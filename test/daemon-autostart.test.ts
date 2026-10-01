/**
 * AUTOSTART (lib/daemon/autostart.ts) — the third way in.
 *
 * Two properties are the whole point and both are properties of two callers, so
 * they are driven here instead of asserted:
 *   - a session that already has a daemon spawns NOTHING (one HTTP probe and
 *     no lock file), and
 *   - two callers racing each other still spawn ONE process, because both go
 *     through the same `start.lock`.
 *
 * The probe and the spawn are injected, so no test here starts a real daemon
 * and none of them depends on what is running on this machine.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { claimStartLock, ensureDaemonRunning, ensureDaemonInBackground, START_LOCK_STALE_MS } from "../lib/daemon/autostart.ts";
import { buildDaemonState, ensureDaemonToken } from "../lib/daemon/state.ts";
import { daemonHome } from "../lib/daemon/paths.ts";
import type { DaemonProbe } from "../lib/daemon-presence.ts";
import { scratchHome } from "./daemon-helpers.ts";

/** A state record that looks alive: the probe is injected, so nothing checks the pid. */
function fakeState(home: string): ReturnType<typeof buildDaemonState> {
  ensureDaemonToken(home);
  return { ...buildDaemonState({ port: 4597 }), pid: process.pid };
}

const OFFLINE: DaemonProbe = { online: false, reason: "state 文件缺失或不是合法的 rg-daemon.json" };

function online(home: string): DaemonProbe {
  const state = fakeState(home);
  return { online: true, state, reason: `在线：pid ${state.pid}，端口 ${state.port}` };
}

test("an online daemon is left alone: one probe, no spawn, no lock", async () => {
  const home = scratchHome();
  let probes = 0;
  const spawned: unknown[] = [];
  const outcome = await ensureDaemonRunning({
    home,
    probe: async () => { probes += 1; return online(home); },
    spawnDetached: (spawned_) => spawned.push(spawned_),
  });
  assert.equal(outcome.status, "online");
  assert.equal(probes, 1, "the first probe answers it");
  assert.deepEqual(spawned, [], "nothing is started when there is already a daemon");
  assert.equal(existsSync(join(daemonHome(home), "start.lock")), false, "no lock is left behind");
});

test("an offline daemon is started once, and the receipt is a probe that says online", async () => {
  const home = scratchHome();
  const spawned: Array<{ command: string; args: string[]; home: string }> = [];
  let probes = 0;
  const outcome = await ensureDaemonRunning({
    home,
    reexec: ["/usr/bin/node", "/tmp/cli.ts"],
    // Offline, offline (under the lock), then online — the shape of a real start.
    probe: async () => { probes += 1; return probes < 3 ? OFFLINE : online(home); },
    spawnDetached: (spawned_) => spawned.push(spawned_),
    sleep: async () => {},
  });
  assert.equal(outcome.status, "started");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.command, "/usr/bin/node");
  assert.deepEqual(spawned[0]!.args, ["/tmp/cli.ts", "daemon", "run", "--port", "4597"], "the same argv the CLI would use");
  assert.equal(spawned[0]!.home, home, "the detached child is told which home to use");
  assert.equal(existsSync(join(daemonHome(home), "start.lock")), false, "the lock is released either way");
});

test("two callers racing spawn ONE process — the loser gets busy, not a second daemon", async () => {
  const home = scratchHome();
  const spawned: unknown[] = [];
  let release = (): void => {};
  const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const probe = async (): Promise<DaemonProbe> => {
    await gate; // both callers pass their first probe before either takes the lock
    return OFFLINE;
  };
  const first = ensureDaemonRunning({ home, probe, spawnDetached: (s) => spawned.push(s), sleep: async () => {} , waitMs: 0 });
  const second = ensureDaemonRunning({ home, probe, spawnDetached: (s) => spawned.push(s), sleep: async () => {}, waitMs: 0 });
  release();
  const outcomes = await Promise.all([first, second]);
  assert.equal(spawned.length, 1, "one daemon, whoever won the lock");
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ["busy", "failed"], "the loser is told to wait, not to start another");
});

test("a start that never answers the port is a failure with the log path, never a throw", async () => {
  const home = scratchHome();
  let now = 1_000;
  const outcome = await ensureDaemonRunning({
    home,
    probe: async () => OFFLINE,
    spawnDetached: () => {},
    sleep: async () => { now += 5_000; },
    now: () => now,
    waitMs: 10_000,
  });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.reason, /没有等到端口应答/);
  assert.match(outcome.reason, /daemon\.log/, "the reason says where to look");
});

test("a probe that THROWS is 'cannot confirm', and the start still happens", async () => {
  const home = scratchHome();
  let spawned = 0;
  const outcome = await ensureDaemonRunning({
    home,
    probe: async () => { throw new Error("probe exploded"); },
    spawnDetached: () => { spawned += 1; },
    sleep: async () => {},
    waitMs: 0,
  });
  assert.equal(spawned, 1);
  assert.equal(outcome.status, "failed", "an unreadable probe is never a reason to skip the start");
});

test("a spawn that throws is reported, not propagated", async () => {
  const home = scratchHome();
  const outcome = await ensureDaemonRunning({
    home,
    probe: async () => OFFLINE,
    spawnDetached: () => { throw new Error("no exec permission"); },
  });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.reason, /启动进程失败/);
  assert.equal(existsSync(join(daemonHome(home), "start.lock")), false, "a failed start releases the lock");
});

test("the background helper never throws and never blocks the caller", async () => {
  const lines: string[] = [];
  const spawned: unknown[] = [];
  const probe = async () => OFFLINE;
  ensureDaemonInBackground((line) => lines.push(line), { probe, spawnDetached: (s) => spawned.push(s), sleep: async () => {}, waitMs: 0 });
  assert.deepEqual(lines, [], "nothing is logged before the work finishes — the caller did not wait");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.equal(lines.length, 1, "the outcome lands in the caller's log");
  assert.match(lines[0]!, /review-gate\[daemon\]/);
});

test("the lock is one file with one winner, and a stale one is reclaimed", () => {
  const home = scratchHome();
  mkdirSync(daemonHome(home), { recursive: true });
  const lock = join(daemonHome(home), "start.lock");
  assert.equal(claimStartLock(lock, 1_000), true);
  assert.equal(claimStartLock(lock, 1_001), false, "a live, fresh holder is not taken over");
  writeFileSync(lock, `999999999 ${1_000}`, "utf8");
  assert.equal(claimStartLock(lock, 1_000 + START_LOCK_STALE_MS + 1), true, "a dead holder's lock is reclaimed");
});

test("an unwritable home is reported instead of being swallowed", async () => {
  // A path that cannot be a directory: `mkdirSync` fails, and the outcome says
  // so rather than pretending a start happened.
  const home = join(scratchHome(), "not-a-dir");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "rg-daemon"), "this is a file, not a directory", "utf8");
  let spawned = 0;
  const outcome = await ensureDaemonRunning({ home, probe: async () => OFFLINE, spawnDetached: () => { spawned += 1; } });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.reason, /建不出/);
  assert.equal(spawned, 0, "nothing is spawned into a home that cannot hold a lock");
});
