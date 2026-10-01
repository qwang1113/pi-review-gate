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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bannerSenderOnline,
  bannerSenderPresence,
  judgeDaemonPresence,
  MENUBAR_HEARTBEAT_FRESH_MS,
  probeDaemon,
  probeDaemonSync,
  type HealthReading,
  type HealthRunner,
} from "../lib/daemon-presence.ts";
import { buildDaemonState, ensureDaemonToken, writeDaemonState } from "../lib/daemon/state.ts";
import { daemonStatePath, menubarPresencePath } from "../lib/daemon/paths.ts";
import { runDaemonCli } from "../lib/daemon/cli.ts";
import { freePort, scratchHome } from "./daemon-helpers.ts";

/** The CLI's output is not the subject here; the daemon it starts is. */
const silentIo = { out: () => {}, err: () => {} };

test("both entries read the SAME home — RG_DAEMON_HOME is honoured by the async probe too", async () => {
  // The bug this pins (quality round P1, 2026-10-01): `probeDaemon` used to let
  // the fs helpers fall back to `$HOME` while `probeDaemonSync` resolved
  // `daemonUserHome()`, so with the override set the two entries could disagree
  // about there being a daemon AT ALL — one reading the override, the other the
  // real home.
  const home = scratchHome();
  ensureDaemonToken(home);
  writeDaemonState({ ...buildDaemonState({ port: 4711 }), pid: process.pid }, home);
  const previous = process.env.RG_DAEMON_HOME;
  process.env.RG_DAEMON_HOME = home;
  try {
    const seen: string[] = [];
    await probeDaemon({
      timeoutMs: 200,
      fetchImpl: (async (input: string | URL | Request) => {
        seen.push(String(input));
        throw new Error("nothing listens there");
      }) as unknown as typeof fetch,
    });
    let syncUrl = "";
    probeDaemonSync({ health: (url) => { syncUrl = url; return { ok: true }; } });
    assert.deepEqual(seen, ["http://127.0.0.1:4711/api/health"], "the async probe read the override");
    assert.equal(syncUrl, "http://127.0.0.1:4711/api/health", "…and the sync probe read the same one");
  } finally {
    if (previous === undefined) delete process.env.RG_DAEMON_HOME;
    else process.env.RG_DAEMON_HOME = previous;
  }
});

// ---------------------------------------------------------------------------
// The rule is three conditions, and its answer names the one that failed
// ---------------------------------------------------------------------------

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
    assert.equal(probeDaemonSync({ home }).online, true, "the sync probe the notification path is built on");
  } finally {
    await runDaemonCli(["daemon", "stop"], { ...silentIo, home });
  }
  // …and once it is gone, BOTH say offline — the terminal notifier's licence to
  // send again.
  const afterAsync = await probeDaemon({ home, timeoutMs: 200 });
  const afterSync = probeDaemonSync({ home, timeoutMs: 200 });
  assert.equal(afterAsync.online, false);
  assert.equal(afterSync.online, false);
  assert.equal(bannerSenderOnline({ home }), false, "and nobody claims the banner either");
});

// ---------------------------------------------------------------------------
// WHO RAISES THE BANNER — the online rule alone was never enough
// ---------------------------------------------------------------------------

/** One heartbeat, exactly as the menu bar app writes it (pid + ISO time + canPost). */
function heartbeat(home: string, at: number, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(home, ".pi", "agent", "rg-daemon"), { recursive: true });
  writeFileSync(
    menubarPresencePath(home),
    JSON.stringify({ schema: 1, pid: process.pid, at: new Date(at).toISOString(), canPost: true, ...extra }),
    "utf8",
  );
}

test("the banner sender is the app's own heartbeat — and every doubt means it is NOT there", () => {
  const home = scratchHome();
  const now = Date.parse("2026-10-01T06:00:00.000Z");
  assert.equal(bannerSenderPresence({ home, now }).present, false, "no file ⇒ nobody to send it");
  assert.match(bannerSenderPresence({ home, now }).reason, /不存在或读不出来/);

  heartbeat(home, now - 4_000);
  assert.equal(bannerSenderPresence({ home, now }).present, true, "a fresh beat from a live pid is the one positive fact");

  heartbeat(home, now - MENUBAR_HEARTBEAT_FRESH_MS - 1);
  assert.equal(bannerSenderPresence({ home, now }).present, false, "an app that stopped writing is not a sender");
  assert.match(bannerSenderPresence({ home, now }).reason, /已过期/);

  heartbeat(home, now - 1_000, { pid: 999_999_999 });
  assert.equal(bannerSenderPresence({ home, now }).present, false, "a crash leaves a fresh file behind a dead pid");
  assert.match(bannerSenderPresence({ home, now }).reason, /pid 999999999 已不在/);

  // pid 0 / -1 ARE ALIVE to `kill(2)` (the process group / every process), so a
  // heartbeat carrying one would otherwise read as "the app is running" in a
  // file nobody wrote. Quality round P2, 2026-10-01.
  for (const bogus of [0, -1]) {
    heartbeat(home, now - 1_000, { pid: bogus });
    assert.equal(bannerSenderPresence({ home, now }).present, false, `pid ${bogus} is not a sender`);
    assert.match(bannerSenderPresence({ home, now }).reason, /必须是正整数/);
  }

  // A RUNNING APP THAT CANNOT DELIVER IS NOT A SENDER (reviewer P1,
  // 2026-10-01): the app states its own ability, and it must be required.
  heartbeat(home, now - 1_000, { canPost: false });
  assert.equal(bannerSenderPresence({ home, now }).present, false, "fresh heartbeat, no permission ⇒ nobody posts");
  assert.match(bannerSenderPresence({ home, now }).reason, /发不出横幅/);

  // …and a heartbeat from an app built before the field existed is not a
  // licence to stay silent either (the mixed-version pair fails OPEN).
  writeFileSync(
    menubarPresencePath(home),
    JSON.stringify({ schema: 1, pid: process.pid, at: new Date(now - 1_000).toISOString() }),
    "utf8",
  );
  assert.equal(bannerSenderPresence({ home, now }).present, false, "no canPost field ⇒ cannot be trusted");

  writeFileSync(menubarPresencePath(home), "not json", "utf8");
  assert.equal(bannerSenderPresence({ home, now }).present, false, "garbage is not a licence to stay silent");
});

test("suppression needs BOTH halves: the app running AND the daemon answering", () => {
  // THE P1 THIS PINS (quality round, 2026-10-01): the daemon is auto-started by
  // every interactive session and the app is not, so "the daemon answers"
  // alone suppressed banners nobody was left to raise — silence from both
  // sides after a reboot.
  const home = scratchHome();
  const now = Date.parse("2026-10-01T06:00:00.000Z");
  const health: HealthRunner = () => ({ ok: true });
  heartbeat(home, now - 1_000);

  assert.equal(bannerSenderOnline({ home, now, health }), false, "the app is up but there is no daemon behind it");

  writeDaemonState({ ...buildDaemonState({ port: 4597 }), pid: process.pid }, home);
  ensureDaemonToken(home);
  assert.equal(bannerSenderOnline({ home, now, health }), true, "both halves ⇒ the app owns the banner");

  heartbeat(home, now - MENUBAR_HEARTBEAT_FRESH_MS - 5_000);
  assert.equal(bannerSenderOnline({ home, now, health }), false, "the app quit ⇒ the terminal sends again");
});
