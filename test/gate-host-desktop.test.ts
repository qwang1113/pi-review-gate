/**
 * THE DESKTOP HOST against a FAKE desktop client (a unix socket server in a
 * child process — the host blocks its own thread on every request, exactly
 * like a blocking tmux call, so the server cannot live on this thread).
 *
 * The fake answers through lib/desktop-host-protocol.ts's own encoder, so a
 * shape the real (Rust) client could not produce cannot pass here either, and
 * it logs every request it decoded to a file the test reads back.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createDesktopClient, helloFor } from "../lib/desktop-host-client.ts";
import { createDesktopHost } from "../lib/gate-host-desktop.ts";
import {
  createGateHost,
  desktopHandle,
  desktopIdOf,
  hostIsInteractive,
  hostOwnPane,
  hostServer,
  isSessionHandle,
  parseSessionCoords,
  type GateHost,
} from "../lib/gate-host.ts";
import { openSessionWindow } from "../lib/session-factory.ts";
import { judgePaneAlive } from "../lib/judge-pane.ts";
import { createUserNotifyRuntime } from "../lib/user-notify-runtime.ts";
import { emptyState } from "../lib/gate-state.ts";

const SELF = "root-1";
const dirs: string[] = [];
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The fake client. `config` scripts its answers; every decoded request is logged. */
const FAKE_CLIENT = `
const [socketPath, logPath, configJson, protocolUrl] = process.argv.slice(1);
const config = JSON.parse(configJson);
const { createServer } = await import("node:net");
const { appendFileSync } = await import("node:fs");
const { decodeRequest, encodeResponse } = await import(protocolUrl);
const sessions = [{ hostSessionId: ${JSON.stringify(SELF)}, parent: null, role: "root", title: "root", groupPin: null }];
let seq = 0;
let connections = 0;
const server = createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  let me;
  const nth = ++connections;
  socket.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const decoded = decodeRequest(line);
      if (!decoded.ok) { appendFileSync(logPath, JSON.stringify({ bad: decoded.error }) + "\\n"); continue; }
      const { id, method, params } = decoded.request;
      appendFileSync(logPath, JSON.stringify({ method, params }) + "\\n");
      const reply = (outcome) => socket.write(encodeResponse(id, method, outcome).frame);
      const ok = (result) => reply({ ok: true, result });
      const err = (code, message) => reply({ ok: false, error: { code, message } });
      if (method === "hello") {
        if (params.hostSessionId !== config.expect) { err("forbidden", "not the id I minted"); socket.end(); continue; }
        me = params.hostSessionId;
        ok({ protocol: 1, client: { name: "fake", version: "0" } });
        // An idle drop: the first connection goes away right after the handshake.
        if (config.dropFirst && nth === 1) setTimeout(() => socket.destroy(), 20);
      } else if (!me) err("forbidden", "no hello");
      else if (method === "session.open") {
        const hostSessionId = "s-" + (++seq);
        sessions.push({ hostSessionId, parent: me, role: params.role, title: params.title, groupPin: null });
        ok({ hostSessionId, pid: 4242 });
      } else if (method === "session.list") {
        if (config.failList) err("unavailable", "cannot list right now");
        else ok({ sessions });
      } else if (method === "session.close") {
        const gone = params.target === "children"
          ? sessions.filter((s) => s.parent === me)
          : sessions.filter((s) => s.hostSessionId === params.hostSessionId);
        for (const s of gone) sessions.splice(sessions.indexOf(s), 1);
        ok({ closed: gone.map((s) => s.hostSessionId) });
      } else if (method === "notify") ok({ shown: config.shown !== false });
      else if (method === "focus.state") ok({ focusedHostSessionId: config.focused ?? null, appFrontmost: config.frontmost === true });
      else ok({});
    }
  });
});
server.listen(socketPath, () => process.stdout.write("listening\\n"));
`;

interface Fake {
  socketPath: string;
  requests(): Array<{ method: string; params: Record<string, unknown> }>;
  kill(): void;
}

/**
 * A socket directory short enough for `sun_path` (103 bytes) whatever TMPDIR
 * is — a judge pane's TMPDIR is a long per-session path.
 */
function socketDir(): string {
  const dir = mkdtempSync("/tmp/rg-dh-");
  dirs.push(dir);
  return dir;
}

async function fakeClient(config: { expect?: string; failList?: boolean; shown?: boolean; focused?: string; frontmost?: boolean; dropFirst?: boolean } = {}): Promise<Fake> {
  const dir = socketDir();
  dirs.push(dir);
  const socketPath = join(dir, "s.sock");
  const logPath = join(dir, "log.jsonl");
  const protocolUrl = new URL("../lib/desktop-host-protocol.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", FAKE_CLIENT, socketPath, logPath, JSON.stringify({ expect: SELF, ...config }), protocolUrl], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (data: Buffer) => { if (String(data).includes("listening")) resolve(); });
    child.on("exit", (code) => reject(new Error(`fake client exited early (${code})`)));
  });
  return {
    socketPath,
    requests: () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    kill: () => { child.kill("SIGKILL"); },
  };
}

function hostOn(socketPath: string, hostSessionId = SELF): GateHost {
  return createDesktopHost({
    socketPath,
    hostSessionId,
    client: createDesktopClient({ socketPath, timeoutMs: 2_000, hello: () => helloFor({ hostSessionId, cwd: "/repo", piSessionId: "pi-1" }) }),
  });
}

const judgeSpec = {
  cwd: "/repo",
  layout: "own-session-window" as const,
  role: { kind: "judge" as const, openerId: "op", judgeId: "rg-reviewer-x", role: "reviewer" },
  command: ["pi", "--session-id", "rg-reviewer-x"],
  decor: { label: "reviewer@t6", windowName: "reviewer", colorSeed: "rg-reviewer-x", state: "working" as const },
};

test("handshake, open, live, decorate and close — each one protocol request", async () => {
  const fake = await fakeClient();
  const host = hostOn(fake.socketPath);
  assert.deepEqual(host.ready(), { ok: true });
  const hello = fake.requests()[0]!;
  assert.equal(hello.method, "hello");
  assert.equal(hello.params.hostSessionId, SELF);
  assert.equal(hello.params.protocol, 1);

  const registered: unknown[] = [];
  const opened = await openSessionWindow(host, { ...judgeSpec, register: (coords) => registered.push(coords) });
  assert.equal(opened.ok, true);
  assert.deepEqual(registered, [{ paneId: "desktop:s-1", windowId: "desktop:s-1", sessionName: `desktop:${SELF}` }],
    "a child is registered under its desktop handle, grouped under this session");
  const open = fake.requests().find((r) => r.method === "session.open")!;
  assert.equal(open.params.placement, "own-group");
  assert.equal(open.params.role, "judge");
  assert.equal(open.params.title, "reviewer");
  assert.ok((open.params.argv as string[]).includes("rg-reviewer-x"), "the child's argv is the gate's, unrewritten");
  assert.ok(!Object.keys(open.params.env as object).some((k) => k.startsWith("RG_HOST")), "the host identity is the client's to mint");
  const decorate = fake.requests().find((r) => r.method === "session.decorate")!;
  assert.equal(decorate.params.hostSessionId, "s-1");
  assert.match(String(decorate.params.label), /^reviewer@t6 · /);
  assert.equal(decorate.params.colorSeed, "rg-reviewer-x");

  assert.equal(judgePaneAlive(host, "desktop:s-1"), true);
  assert.deepEqual(host.closeWindow({ ownSession: `desktop:${SELF}`, windowId: "desktop:s-1" }), { ok: true });
  assert.equal(judgePaneAlive(host, "desktop:s-1"), false, "a session missing from a SUCCESSFUL list is gone");
  assert.deepEqual(host.closeWindow({ ownSession: `desktop:${SELF}`, windowId: "desktop:s-1" }), { ok: true }, "close is idempotent");
  assert.deepEqual(host.closeWindow({ ownSession: "rg-x", windowId: "@3" }).ok, false, "a tmux id is refused, never sent");
});

test("a relay successor goes beside the opener; an orchestration child pins the group first", async () => {
  const fake = await fakeClient();
  const host = hostOn(fake.socketPath);
  const relay = await openSessionWindow(host, { cwd: "/repo", layout: "beside-opener", ownPane: host.ownPane()!, role: { kind: "successor", env: {} }, command: ["pi"] });
  assert.equal(relay.ok, true);
  assert.equal(relay.ok && relay.windowId, undefined, "a relay has no window coordinates to be closed by");
  const child = await openSessionWindow(host, {
    cwd: "/repo",
    layout: "own-session-window",
    role: { kind: "orchestration-child", orchestrationId: "orch-1", stateVariant: "t1" },
    command: ["pi"],
  });
  assert.equal(child.ok, true);
  const methods = fake.requests().map((r) => r.method);
  assert.deepEqual(methods.slice(1), ["session.pin", "session.open", "session.pin", "session.open"],
    "a successor's pin, then the relay; the child's pin, then the child");
  const opens = fake.requests().filter((r) => r.method === "session.open");
  assert.equal(opens[0]!.params.placement, "beside-opener");
  assert.equal(opens[1]!.params.placement, "own-group");
  assert.equal(host.closeChildren().ok, true);
  assert.deepEqual(fake.requests().at(-1), { method: "session.close", params: { target: "children" } });
});

test("an unreadable list is UNKNOWN liveness, never death", async () => {
  const fake = await fakeClient({ failList: true });
  const host = hostOn(fake.socketPath);
  assert.equal(host.livePanes(), undefined);
  assert.equal(judgePaneAlive(host, "desktop:s-1"), undefined);
});

test("the banner is the client's notify, sent only when the user is not looking", async () => {
  const fake = await fakeClient({ focused: SELF, frontmost: false });
  const host = hostOn(fake.socketPath);
  const state = emptyState("sess-1", 10);
  state.taskMode = "loop";
  const runtime = createUserNotifyRuntime({
    state: () => state,
    persist: () => {},
    repoName: () => "repo",
    taskMode: () => "loop",
    env: () => ({}),
    interactive: () => true,
    notifier: host.notifier,
  });
  assert.deepEqual(runtime.notify({ kind: "needs-user", detail: "要你拍板" }), { status: "sent" });
  const sent = fake.requests().find((r) => r.method === "notify")!;
  assert.equal(sent.params.kind, "needs-user");
  assert.equal(sent.params.focusHostSessionId, SELF, "a click lands on this session");
  assert.equal(sent.params.group, "sess-1");
  assert.ok(fake.requests().some((r) => r.method === "focus.state"), "the watching question was asked first");

  const refused = await fakeClient({ shown: false });
  const quiet = hostOn(refused.socketPath);
  const outcome = createUserNotifyRuntime({
    state: () => emptyState("sess-2", 10),
    persist: () => {},
    repoName: () => "repo",
    taskMode: () => "loop",
    env: () => ({}),
    interactive: () => true,
    notifier: quiet.notifier,
  }).notify({ kind: "finished", detail: "done" });
  assert.equal(outcome.status, "missing", "a banner the system refused is reported as not sent");
});

test("a client that goes away fails every act with `disconnected` — no fallback, no hang", async () => {
  const fake = await fakeClient();
  const host = hostOn(fake.socketPath);
  assert.equal(host.ready().ok, true);
  fake.kill();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(host.livePanes(), undefined, "liveness becomes unknown");
  const opened = host.openWindow({ cwd: "/repo", env: {}, command: ["pi"], role: judgeSpec.role });
  assert.equal(opened.ok, false);
  assert.match(opened.ok ? "" : opened.error, /disconnected/);
  const ready = host.ready();
  assert.equal(ready.ok, false, "the next request tries once more and fails with the reason");
  assert.match(ready.ok ? "" : ready.error, /disconnected/);
});

test("a connection that dropped while idle is re-established by the NEXT request, once", async () => {
  const fake = await fakeClient({ dropFirst: true });
  const host = hostOn(fake.socketPath);
  assert.equal(host.ready().ok, true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(host.livePanes(), [`desktop:${SELF}`], "reconnect + hello, then the request itself");
  assert.equal(fake.requests().filter((r) => r.method === "hello").length, 2);
  assert.equal(fake.requests().filter((r) => r.method === "session.list").length, 1, "the request is sent once, never twice");
});

test("the orphan sweep lets a registration go only after the client answered, and only for its own groups", async () => {
  const fake = await fakeClient();
  const host = hostOn(fake.socketPath);
  assert.deepEqual(host.reclaimScope("desktop:gone-1", "sid"), { outcome: "gone" });
  assert.equal(host.reclaimScope("rg-repo-abcdef1234", "sid").outcome, "kept", "a tmux group is the tmux host's");
  const blind = hostOn((await fakeClient({ failList: true })).socketPath);
  assert.equal(blind.reclaimScope("desktop:gone-1", "sid").outcome, "kept", "unreadable is not gone");
});

test("a socket nobody listens on, and a refused handshake, are named errors", async () => {
  const nowhere = hostOn(join(socketDir(), "none.sock"));
  const ready = nowhere.ready();
  assert.equal(ready.ok, false);
  assert.match(ready.ok ? "" : ready.error, /连不上/);
  assert.equal((await openSessionWindow(nowhere, judgeSpec)).ok, false);

  const fake = await fakeClient({ expect: "somebody-else" });
  const refused = hostOn(fake.socketPath).ready();
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /hello 被拒/);
});

test("an invalid host env refuses every act and never builds a tmux host", () => {
  let tmuxBuilt = false;
  const host = createGateHost({
    env: { RG_HOST: "desktop", RG_HOST_SESSION: SELF },
    tmux: () => { tmuxBuilt = true; throw new Error("must not fall back"); },
    desktop: () => { throw new Error("not a valid desktop env either"); },
  });
  assert.equal(host.kind, "unavailable");
  assert.equal(tmuxBuilt, false);
  assert.equal(host.ready().ok, false);
  assert.match(host.ready().ok ? "" : (host.ready() as { error: string }).error, /RG_HOST_SOCKET[\s\S]*不会退回 tmux/);
  assert.equal(host.openWindow({ cwd: "/", env: {}, command: ["pi"], role: judgeSpec.role }).ok, false);
  assert.equal(host.livePanes(), undefined);
  assert.equal(host.closeChildren().ok, false);
  assert.equal(host.notifier.send({ kind: "finished", title: "t", body: "b", argv: [] }, false).ok, false);
  assert.equal(createGateHost({ env: {}, tmux: () => ({ kind: "tmux" }) as GateHost, desktop: () => { throw new Error("no"); } }).kind, "tmux",
    "no RG_HOST ⇒ the terminal host");
});

test("handles: disjoint from tmux ids by shape, read back fail-closed", () => {
  assert.equal(desktopHandle("s-1"), "desktop:s-1");
  assert.equal(desktopIdOf("desktop:s-1"), "s-1");
  assert.equal(desktopIdOf("desktop:../x"), undefined);
  assert.equal(desktopIdOf("%3"), undefined);
  assert.equal(isSessionHandle("%3"), true);
  assert.equal(isSessionHandle("desktop:s-1"), true);
  assert.equal(isSessionHandle("my-work"), false);
  assert.deepEqual(parseSessionCoords({ windowId: "desktop:s-1", tmuxSession: "desktop:root" }), { windowId: "desktop:s-1", tmuxSession: "desktop:root" });
  assert.equal(parseSessionCoords({ windowId: "desktop:s-1", tmuxSession: "rg-repo-abc" }), undefined, "never a mix");
  assert.deepEqual(parseSessionCoords({ windowId: "@7", tmuxSession: "rg-repo-abc" }), { windowId: "@7", tmuxSession: "rg-repo-abc" });
  const desktopEnv = { RG_HOST: "desktop", RG_HOST_SOCKET: "/tmp/x.sock", RG_HOST_SESSION: SELF, TMUX_PANE: "%9" };
  assert.equal(hostOwnPane(desktopEnv), `desktop:${SELF}`, "under the desktop host a stray TMUX_PANE is not this session");
  assert.equal(hostServer(desktopEnv), "desktop:/tmp/x.sock");
  assert.equal(hostOwnPane({ TMUX_PANE: "%9" }), "%9");
  assert.equal(hostServer({ TMUX: "/s,1,0" }), "/s,1");
  assert.equal(hostOwnPane({ RG_HOST: "bogus", TMUX_PANE: "%9" }), undefined, "an invalid env has no pane at all");
  assert.equal(hostIsInteractive(desktopEnv, false), true, "pi runs --mode rpc under the desktop client: no TTY, still a human");
  assert.equal(hostIsInteractive({}, false), false);
  assert.equal(hostIsInteractive({}, true), true);
  assert.equal(hostIsInteractive({ RG_HOST: "bogus" }, false), false);
});
