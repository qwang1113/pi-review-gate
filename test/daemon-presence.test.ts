/**
 * THE ONE ONLINE RULE (lib/daemon-presence.ts) — and the fact that BOTH probes
 * answer it the same way.
 *
 * The rule is frozen in `docs/daemon/api.md` §3: state file parses, its pid is
 * alive, and a TOKEN-BEARING `/api/health` answers 200 within 1000 ms. Every
 * failure — a missing file, a dead pid, a timeout, a broken curl — means
 * "cannot confirm online", and the consumer that reads it (the terminal
 * notifier) must keep sending.
 *
 * The two entry points differ in exactly one thing (how they ask the port) and
 * this file pins that they agree: the async one over `fetch`, the synchronous
 * one over the system curl that `lib/user-notify-runtime.ts` needs because a
 * dialog and an `exit` handler cannot await anything.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  daemonOnlineSync,
  judgeDaemonPresence,
  probeDaemon,
  probeDaemonSync,
  type HealthReading,
} from "../lib/daemon-presence.ts";
import { buildDaemonState, ensureDaemonToken, writeDaemonState } from "../lib/daemon/state.ts";
import { daemonStatePath } from "../lib/daemon/paths.ts";
import { runDaemonCli } from "../lib/daemon/cli.ts";
import { freePort, scratchHome } from "./daemon-helpers.ts";

/** The CLI's output is not the subject here; the daemon it starts is. */
const silentIo = { out: () => {}, err: () => {} };

test("the rule is three conditions, and its answer names the one that failed", () => {
  const state = { ...buildDaemonState({ port: 4597 }) };
  const ok: HealthReading = { ok: true };
  assert.equal(judgeDaemonPresence({ state: undefined, alive: false, token: undefined, health: ok }).online, false);
  assert.match(judgeDaemonPresence({ state: undefined, alive: false, token: undefined, health: ok }).reason, /state 文件缺失/);

  const deadPid = judgeDaemonPresence({ state, alive: false, token: "t", health: ok });
  assert.equal(deadPid.online, false);
  assert.match(deadPid.reason, new RegExp(`pid ${state.pid} 已不在`));

  const noToken = judgeDaemonPresence({ state, alive: true, token: undefined, health: ok });
  assert.equal(noToken.online, false);
  assert.match(noToken.reason, /token 文件缺失/);

  const unhealthy = judgeDaemonPresence({ state, alive: true, token: "t", health: { ok: false, reason: "健康检查返回 HTTP 500" } });
  assert.equal(unhealthy.online, false);
  assert.equal(unhealthy.reason, "健康检查返回 HTTP 500");

  const online = judgeDaemonPresence({ state, alive: true, token: "t", health: ok });
  assert.equal(online.online, true);
  assert.equal(online.state, state);
  assert.match(online.reason, /在线：pid/);
  // The pid is checked BEFORE the token: a dead pid names itself, it does not
  // send the reader looking for a token file that is perfectly fine.
  assert.equal(online.state?.port, 4597);
});

test("the sync probe asks loopback with the token, and reads the port out of the state file", () => {
  const home = scratchHome();
  const token = ensureDaemonToken(home).token;
  writeDaemonState({ ...buildDaemonState({ port: 4597 }), pid: process.pid }, home);
  const seen: Array<{ url: string; token: string }> = [];
  const probe = probeDaemonSync({
    home,
    health: (url, token_) => { seen.push({ url, token: token_ }); return { ok: true }; },
  });
  assert.equal(probe.online, true);
  assert.deepEqual(seen, [{ url: "http://127.0.0.1:4597/api/health", token }], "the computed loopback address, never `baseUrl`");
});

test("offline is the answer for every unreadable fact, and the probe never throws", () => {
  const home = scratchHome();
  const health = (): HealthReading => { throw new Error("curl exploded"); };

  // No state file at all.
  assert.equal(probeDaemonSync({ home, health }).online, false);
  assert.equal(daemonOnlineSync({ home, health }), false);

  // A garbage state file.
  writeFileSync(daemonStatePath(home), "{ this is not json", "utf8");
  assert.match(probeDaemonSync({ home, health }).reason, /state 文件缺失或不是合法的/);

  // A state file whose pid is gone.
  writeDaemonState({ ...buildDaemonState({ port: 4597 }), pid: 999_999_999 }, home);
  assert.match(probeDaemonSync({ home, health }).reason, /已不在/);

  // A live pid with no token file: "cannot confirm", the health check is never
  // even attempted.
  writeDaemonState({ ...buildDaemonState({ port: 4597 }), pid: process.pid }, home);
  assert.match(probeDaemonSync({ home, health }).reason, /token 文件缺失/);

  // A token, and a health reader that throws: the rule's answer, not an exception.
  ensureDaemonToken(home);
  const thrown = probeDaemonSync({ home, health });
  assert.equal(thrown.online, false);
  assert.match(thrown.reason, /不能断定在线/);
});

test("the async probe and the sync probe answer the same thing about the same daemon", async () => {
  const home = scratchHome();
  // A REAL daemon, in its own process: `execFileSync` inside the sync probe
  // blocks this process' event loop, so an in-process HTTP server could never
  // answer it — which is exactly the deadlock this test would otherwise measure
  // instead of the rule.
  const port = await freePort();
  const started = await runDaemonCli(["daemon", "start", "--port", String(port)], {
    ...silentIo,
    home,
    reexec: [process.execPath, fileURLToPath(new URL("../lib/daemon/cli.ts", import.meta.url))],
  });
  assert.equal(started, 0, "the fixture daemon starts");
  try {
    const asyncProbe = await probeDaemon({ home });
    const syncProbe = probeDaemonSync({ home });
    assert.equal(asyncProbe.online, true, asyncProbe.reason);
    assert.equal(syncProbe.online, true, syncProbe.reason);
    assert.equal(asyncProbe.state?.port, port);
    assert.equal(syncProbe.state?.port, port);
    assert.equal(daemonOnlineSync({ home }), true, "this is the exact call the notification path makes");
  } finally {
    await runDaemonCli(["daemon", "stop"], { ...silentIo, home });
  }
  // …and once it is gone, BOTH say offline — the terminal notifier's licence to
  // send again.
  const afterAsync = await probeDaemon({ home, timeoutMs: 200 });
  const afterSync = probeDaemonSync({ home, timeoutMs: 200 });
  assert.equal(afterAsync.online, false);
  assert.equal(afterSync.online, false);
  assert.equal(daemonOnlineSync({ home }), false);
});
