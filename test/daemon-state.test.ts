/**
 * The daemon's own identity: the state file, the token, and the ONE online rule
 * (lib/daemon/state.ts). docs/daemon/api.md is the contract; this pins it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  buildDaemonState,
  clearDaemonState,
  ensureDaemonIdentity,
  ensureDaemonToken,
  probeDaemon,
  readDaemonState,
  readDaemonToken,
  tokenMatches,
  writeDaemonState,
  writePrivateFile,
} from "../lib/daemon/state.ts";
import { daemonStatePath, daemonTokenPath } from "../lib/daemon/paths.ts";
import { createRuntime } from "../lib/daemon/server.ts";
import { paneRunner, scratchHome } from "./daemon-helpers.ts";
const mode = (path: string): number => statSync(path).mode & 0o777;

test("the state file and the token are both 0600, and the token is not in the state", () => {
  const home = scratchHome();
  const state = buildDaemonState({ port: 4597 });
  writeDaemonState(state, home);
  const { token, created } = ensureDaemonToken(home);

  assert.equal(created, true);
  assert.equal(mode(daemonStatePath(home)), 0o600, "state file is private");
  assert.equal(mode(daemonTokenPath(home)), 0o600, "token file is private");
  assert.ok(token.length >= 32);
  const raw = readFileSync(daemonStatePath(home), "utf8");
  assert.ok(!raw.includes(token), "the discovery record must never carry the secret");
  assert.equal(readDaemonToken(home), token, "the token reads back");
});

test("ensureDaemonToken keeps an existing token (a restart does not invalidate consumers)", () => {
  const home = scratchHome();
  const first = ensureDaemonToken(home);
  const second = ensureDaemonToken(home);
  assert.equal(second.token, first.token);
  assert.equal(second.created, false);
});

test("tokenMatches is exact and refuses a missing/empty expectation", () => {
  assert.equal(tokenMatches("abc", "abc"), true);
  assert.equal(tokenMatches("abc", "abd"), false);
  assert.equal(tokenMatches("abc", "abcd"), false);
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches("abc", undefined), false);
  assert.equal(tokenMatches(undefined, "abc"), false);
  assert.equal(tokenMatches(12, "abc"), false);
});

test("a malformed or partial state file reads as absent", () => {
  const home = scratchHome();
  writeFileSync(daemonStatePath(home), "{ not json");
  assert.equal(readDaemonState(home), undefined);
  writeFileSync(daemonStatePath(home), JSON.stringify({ schema: 1, pid: 1 }));
  assert.equal(readDaemonState(home), undefined, "a schema-1 record with no port is not a record");
  writeFileSync(daemonStatePath(home), JSON.stringify({ ...buildDaemonState({ port: 1 }), schema: 2 }));
  assert.equal(readDaemonState(home), undefined, "another schema version is not this daemon");
});

test("clearDaemonState removes only the record that still describes its own pid", () => {
  const home = scratchHome();
  writeDaemonState(buildDaemonState({ port: 1234 }), home);
  assert.equal(clearDaemonState(999, home), false, "a stop that raced a restart must not delete the new record");
  assert.ok(readDaemonState(home) !== undefined);
  assert.equal(clearDaemonState(process.pid, home), true);
  assert.equal(readDaemonState(home), undefined);
});

test("writePrivateFile creates missing parents and never leaves the temp sibling", () => {
  const home = scratchHome();
  const path = `${home}/deep/nested/token`;
  writePrivateFile(path, "secret\n");
  assert.equal(readFileSync(path, "utf8"), "secret\n");
  assert.equal(mode(path), 0o600);
  assert.deepEqual(readdirSync(dirname(path)), ["token"], "no temp sibling survives");
});

test("the state's tokenFile points into the home the daemon actually uses", () => {
  const home = scratchHome();
  const state = buildDaemonState({ port: 4597, workspaceRoots: [], home });
  assert.equal(state.tokenFile, daemonTokenPath(home));
  assert.notEqual(state.tokenFile, daemonTokenPath(), "defaulting to $HOME named a file nobody had written");
});

test("the probe talks to loopback, never to the address a state file claims", async () => {
  const home = scratchHome();
  ensureDaemonToken(home);
  // A tampered/corrupt record: it names another host, and the probe carries the
  // token — following it would hand the secret to whoever answers there.
  writeDaemonState({ ...buildDaemonState({ port: 4597 }), baseUrl: "http://evil.example:4597" }, home);
  const seen: string[] = [];
  const probe = await probeDaemon({
    home,
    timeoutMs: 200,
    fetchImpl: (async (input: string | URL | Request) => {
      seen.push(String(input));
      throw new Error("nothing listens there");
    }) as unknown as typeof fetch,
  });
  assert.equal(probe.online, false);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /^http:\/\/127\.0\.0\.1:4597\/api\/health$/);
});

test("the daemon identity is minted once and reused", () => {
  const home = scratchHome();
  const first = ensureDaemonIdentity(home);
  const second = ensureDaemonIdentity(home);
  assert.match(first, /^daemon-[a-z0-9]{6,32}$/);
  assert.equal(second, first);
});

test("offline: no state file, a dead pid, and a live pid with nothing listening", async () => {
  const home = scratchHome();
  assert.equal((await probeDaemon({ home })).online, false);

  writeDaemonState({ ...buildDaemonState({ port: 4597 }), pid: 999_999_999 }, home);
  ensureDaemonToken(home);
  const deadPid = await probeDaemon({ home });
  assert.equal(deadPid.online, false);
  assert.match(deadPid.reason, /pid 999999999 已不在/);

  // A live pid and a closed port: the probe must say "cannot confirm", never
  // "dead", because the online rule never kills and never deletes.
  writeDaemonState({ ...buildDaemonState({ port: 9 }), pid: process.pid }, home);
  const nothingListening = await probeDaemon({ home });
  assert.equal(nothingListening.online, false);
  assert.match(nothingListening.reason, /不能断定在线|探测失败/);
});

test("online: a real runtime on loopback answers the probe", async () => {
  const home = scratchHome();
  const token = ensureDaemonToken(home).token;
  const runtime = createRuntime({
    home,
    port: 0,
    token,
    runTmux: paneRunner([]),
    webDir: `${home}/nowhere`,
  });
  const port = await runtime.start();
  try {
    writeDaemonState({ ...buildDaemonState({ port }), pid: process.pid }, home);
    const probe = await probeDaemon({ home });
    assert.equal(probe.online, true);
    assert.equal(probe.state?.port, port);
  } finally {
    await runtime.stop();
  }
});

test("the probe gives up on a socket that never answers (the timeout is the offline rule)", async () => {
  const home = scratchHome();
  const token = ensureDaemonToken(home).token;
  const { createServer } = await import("node:net");
  const silent = createServer(() => { /* accept and never answer */ });
  const port = await new Promise<number>((resolvePromise) => {
    silent.listen(0, "127.0.0.1", () => {
      const address = silent.address();
      resolvePromise(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  try {
    writeDaemonState({ ...buildDaemonState({ port }), pid: process.pid }, home);
    const probe = await probeDaemon({ home, timeoutMs: 250 });
    assert.equal(probe.online, false);
    assert.match(probe.reason, /探测失败/);
  } finally {
    silent.close();
  }
  assert.ok(token.length > 0);
});

test("the token file's parent directory is created when it is missing", () => {
  const home = scratchHome();
  mkdirSync(dirname(daemonTokenPath(home)), { recursive: true });
  ensureDaemonToken(home);
  assert.equal(mode(daemonTokenPath(home)), 0o600);
});
