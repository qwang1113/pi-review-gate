/**
 * `pi-gate daemon start|stop|status` (lib/daemon/cli.ts) — driven for real,
 * including the detached process, because "start does not start a second one"
 * and "stop actually stops it" are properties of two processes talking, not of
 * a function returning a value.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DAEMON_HOME_ENV, runDaemonCli, type CliIo } from "../lib/daemon/cli.ts";
import { probeDaemon, readDaemonState } from "../lib/daemon/state.ts";
import { daemonStatePath, daemonTokenPath } from "../lib/daemon/paths.ts";
import { freePort, scratchHome } from "./daemon-helpers.ts";

/** One command's output, captured — plus the exit code the shell would see. */
async function cli(home: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const lines: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    home,
    reexec: [process.execPath, fileURLToPath(new URL("../lib/daemon/cli.ts", import.meta.url))],
  };
  const code = await runDaemonCli(argv, io);
  return { code, out: lines.join("\n"), err: errors.join("\n") };
}

test("help and refusals never touch the daemon", async () => {
  const home = scratchHome();
  assert.match((await cli(home, ["daemon", "--help"])).out, /pi-gate daemon/);
  assert.equal((await cli(home, ["daemon"])).code, 1);
  const unknown = await cli(home, ["daemon", "explode"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /未知子命令/);
  assert.equal(existsSync(daemonStatePath(home)), false);
});

test("stop and status are honest when nothing is running", async () => {
  const home = scratchHome();
  const stopped = await cli(home, ["daemon", "stop"]);
  assert.equal(stopped.code, 0);
  assert.match(stopped.out, /没有在跑的/);

  const status = await cli(home, ["daemon", "status"]);
  assert.equal(status.code, 1, "an offline daemon is a non-zero status");
  assert.match(status.out, /在线：否/);
  assert.match(status.out, /state 文件缺失/);
});

test("install and uninstall are explicit placeholders", async () => {
  const home = scratchHome();
  for (const command of ["install", "uninstall"]) {
    const result = await cli(home, ["daemon", command]);
    assert.equal(result.code, 0);
    assert.match(result.out, /没有实装 launchd/);
    assert.match(result.out, /menubar-and-boot/);
  }
});

test("unknown flags are refused before anything is spawned", async () => {
  const home = scratchHome();
  const result = await cli(home, ["daemon", "start", "--port", "not-a-port"]);
  assert.equal(result.code, 1);
  assert.match(result.err, /不是合法端口/);
  const missingValue = await cli(home, ["daemon", "start", "--workspace-root"]);
  assert.equal(missingValue.code, 1);
});

test("start brings a real daemon up, a second start leaves it alone, stop takes it down", async () => {
  const home = scratchHome();
  const port = await freePort();
  const workspace = home;
  const started = await cli(home, ["daemon", "start", "--port", String(port), "--workspace-root", workspace]);
  try {
    assert.equal(started.code, 0, `${started.out}\n${started.err}`);
    assert.match(started.out, /已启动/);
    const state = readDaemonState(home);
    assert.ok(state, "the state file is written before start reports success");
    assert.equal(state.port, port);
    assert.equal(existsSync(daemonTokenPath(home)), true);
    const probe = await probeDaemon({ home });
    assert.equal(probe.online, true, probe.reason);
    assert.deepEqual(state.workspaceRoots, [workspace]);

    // The API answers with the token the daemon minted.
    const token = (await import("node:fs")).readFileSync(daemonTokenPath(home), "utf8").trim();
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(health.status, 200);

    const second = await cli(home, ["daemon", "start", "--port", String(port)]);
    assert.equal(second.code, 0);
    assert.match(second.out, /已经在跑/);
    assert.equal(readDaemonState(home)?.pid, state.pid, "the same process, not a second one");

    const status = await cli(home, ["daemon", "status"]);
    assert.equal(status.code, 0);
    assert.match(status.out, /在线：是/);
  } finally {
    const stopped = await cli(home, ["daemon", "stop"]);
    assert.equal(stopped.code, 0, stopped.err);
    assert.match(stopped.out, /已停止/);
  }
  assert.equal(existsSync(daemonStatePath(home)), false, "stop clears the record it owned");
  assert.equal((await probeDaemon({ home, timeoutMs: 200 })).online, false);
});

test("a stale state file whose process is gone is cleaned up by stop, not by a kill", async () => {
  const home = scratchHome();
  const { writeDaemonState, buildDaemonState } = await import("../lib/daemon/state.ts");
  writeDaemonState({ ...buildDaemonState(4597), pid: 999_999_999 }, home);
  const result = await cli(home, ["daemon", "stop"]);
  assert.equal(result.code, 0);
  assert.match(result.out, /已经不在/);
  assert.equal(existsSync(daemonStatePath(home)), false);
});

test("the documented home override is the variable the detached child reads", () => {
  assert.equal(DAEMON_HOME_ENV, "RG_DAEMON_HOME");
});
