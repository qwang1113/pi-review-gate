/**
 * `name_session` AND THE LIFECYCLE THAT KEEPS A NAME TRUE.
 *
 * The registry's own rules are pinned in test/session-registry.test.ts. This
 * file drives the layer above it: what the TOOL does to the tmux surface, what
 * the heartbeat renews, what a release puts back, and what a session finds when
 * it starts again. The fake tmux keeps the window title, the window option and
 * the pane list as real state, so "the release restored what it changed" is an
 * assertion about state rather than about an argv list.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { ToolHost, ToolReply } from "../lib/tool-host.ts";
import { createSessionNaming, liveSessionNames, type SessionNamingDeps } from "../lib/session-name-tools.ts";
import {
  parseEntryText,
  sessionEntryPath,
  sessionRegistryRoot,
  SESSION_HEARTBEAT_MS,
  SESSION_STALE_MS,
  type RegistryIO,
} from "../lib/session-registry.ts";

const ROOT = "/home/agent/.pi/agent/rg-sessions";
const MINE = "019fbb1d-9e78-7ebf-88bf-d104b8a270ed";
const THEIRS = "019fbb1d-9e78-7ebf-88bf-ffee00000011";
const NOW = Date.parse("2026-09-25T10:00:00.000Z");
const PANE = "%7";

function fakeIO(files: Map<string, string> = new Map()): RegistryIO {
  return {
    readText: (path) => files.get(path),
    writeText: (path, text) => (files.set(path, text), true),
    createExclusive: (path, text) => (files.has(path) ? false : (files.set(path, text), true)),
    rename: (from, to) => {
      const value = files.get(from);
      if (value === undefined || files.has(to)) return false;
      files.delete(from);
      files.set(to, value);
      return true;
    },
    remove: (path) => (files.delete(path), true),
    listFiles: () => [...files.keys()].map((path) => path.slice(path.lastIndexOf("/") + 1)),
  };
}

/**
 * A tmux server that REMEMBERS the three things this layer writes: the window
 * title, the window option, and which panes exist.
 */
function fakeTmux(opts: { windowName?: string; option?: string; panes?: string[]; markers?: Record<string, string>; blind?: boolean } = {}) {
  const state = {
    windowName: opts.windowName ?? "node",
    option: opts.option ?? "",
    panes: opts.panes ?? [PANE],
    calls: [] as string[][],
    killed: [] as string[],
  };
  const run = (argv: readonly string[]) => {
    state.calls.push([...argv]);
    if (opts.blind) return { ok: false, stdout: "", stderr: "no server" };
    switch (argv[0]) {
      case "display-message":
        return {
          ok: true,
          stdout: `0|@45|${state.option}|${state.windowName}\n`,
          stderr: "",
        };
      case "rename-window":
        state.windowName = argv[argv.length - 1];
        return { ok: true, stdout: "", stderr: "" };
      case "set":
        if (argv.includes("-wu")) state.option = "";
        else state.option = argv[argv.length - 1];
        return { ok: true, stdout: "", stderr: "" };
      case "list-panes":
        return { ok: true, stdout: state.panes.join("\n"), stderr: "" };
      case "show-options":
        return { ok: true, stdout: (opts.markers ?? {})[argv[argv.indexOf("-t") + 1]] ?? "", stderr: "" };
      case "kill-session":
        state.killed.push(argv[argv.indexOf("-t") + 1]);
        return { ok: true, stdout: "", stderr: "" };
      default:
        return { ok: true, stdout: "", stderr: "" };
    }
  };
  return { run, state };
}

function makeNaming(opts: {
  files?: Map<string, string>;
  tmux?: ReturnType<typeof fakeTmux>;
  pane?: string | undefined;
  sessionId?: string | undefined;
  scopeSession?: () => string | undefined;
  state?: () => string;
} = {}) {
  const files = opts.files ?? new Map<string, string>();
  const tmux = opts.tmux ?? fakeTmux();
  const lost: string[] = [];
  const deps: SessionNamingDeps = {
    root: ROOT,
    io: fakeIO(files),
    runTmux: tmux.run,
    sessionId: () => ("sessionId" in opts ? opts.sessionId : MINE),
    ownPane: () => ("pane" in opts ? opts.pane : PANE),
    repoRoot: () => "/repo/pi-review-gate",
    cwd: () => "/repo/pi-review-gate",
    mode: () => "loop",
    state: opts.state ?? (() => "working"),
    scopeSession: opts.scopeSession ?? (() => undefined),
    now: () => NOW,
    alive: () => false,
    onLost: (reason) => lost.push(reason),
  };
  const naming = createSessionNaming(deps);
  let tool: { execute: (id: string, params: Record<string, unknown>) => Promise<ToolReply> } | undefined;
  const host = {
    registerTool: (spec: unknown) => {
      tool = spec as { execute: (id: string, params: Record<string, unknown>) => Promise<ToolReply> };
    },
  } as unknown as ToolHost;
  naming.register(host);
  return { naming, files, tmux, lost, run: (name: string) => tool!.execute("id", { name }) };
}

const textOf = (reply: ToolReply): string => reply.content.map((part) => part.text).join("\n");

/** A registry entry in the shape this module writes, for the listing tests. */
function entryForTest(name: string, sessionId: string, at: number) {
  return {
    schema: 1, name, sessionId, pid: 4242, repo: "/repo/pi-review-gate", cwd: "/repo/pi-review-gate",
    mode: "loop", state: "working", tmux: { session: "0", window: "@45", pane: PANE },
    registeredAt: new Date(at - 60_000).toISOString(), heartbeatAt: new Date(at).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// the tool
// ---------------------------------------------------------------------------

test("an illegal name is refused before anything is written or renamed", async () => {
  const { files, tmux, run } = makeNaming();
  const reply = await run("T2_Registry");
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /kebab-case/);
  assert.equal(files.size, 0, "no registration file was created");
  assert.deepEqual(tmux.state.calls, [], "and tmux was not touched at all");
  assert.equal(tmux.state.windowName, "node");
});

test("naming registers the session, renames its window and writes the option the status line reads", async () => {
  const { files, tmux, run, naming } = makeNaming();
  const reply = await run("t2-registry");
  assert.notEqual(reply.isError, true);
  assert.match(textOf(reply), /名字：t2-registry/);
  assert.match(textOf(reply), new RegExp(`${ROOT}/t2-registry.json`));
  assert.match(textOf(reply), /位置：0:@45 \(%7\)/);
  const stored = parseEntryText(files.get(sessionEntryPath(ROOT, "t2-registry")));
  assert.equal(stored?.sessionId, MINE, "the entry is bound to THIS session");
  assert.deepEqual(stored?.tmux, { session: "0", window: "@45", pane: PANE });
  assert.equal(stored?.tmux !== undefined && stored.tmux.session.length > 0, true);
  assert.equal(stored?.mode, "loop");
  assert.equal(stored?.state, "working");
  assert.equal(stored?.pid, process.pid);
  assert.equal(tmux.state.windowName, "t2-registry", "the window title IS the name");
  assert.equal(tmux.state.option, "t2-registry", "and so is the option the status line renders");
  assert.equal(naming.currentName(), "t2-registry");
});

test("a session that runs outside tmux still gets a name, and is told the display half could not happen", async () => {
  const { files, run, naming } = makeNaming({ pane: undefined });
  const reply = await run("t2-registry");
  assert.notEqual(reply.isError, true);
  assert.match(textOf(reply), /不在 tmux 里/);
  const stored = parseEntryText(files.get(sessionEntryPath(ROOT, "t2-registry")));
  assert.equal(stored?.tmux, undefined, "no coordinates are invented for a session that has none");
  assert.equal(naming.currentName(), "t2-registry");
});

test("a live holder is refused by name, and the holder's own registration is not touched", async () => {
  const taken = JSON.stringify({
    schema: 1, name: "t2-registry", sessionId: THEIRS, pid: 4242,
    repo: "/repo/other", cwd: "/repo/other", mode: "orchestrator", state: "working",
    tmux: { session: "0", window: "@9", pane: "%99" },
    registeredAt: new Date(NOW - 120_000).toISOString(), heartbeatAt: new Date(NOW).toISOString(),
  });
  const files = new Map([[sessionEntryPath(ROOT, "t2-registry"), taken]]);
  const { tmux, run, naming } = makeNaming({ files });
  const reply = await run("t2-registry");
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /已被别的活会话占用/);
  assert.match(textOf(reply), /repo=\/repo\/other/);
  assert.match(textOf(reply), /状态=working/);
  assert.match(textOf(reply), /登记时间=/);
  assert.equal(files.get(sessionEntryPath(ROOT, "t2-registry")), taken, "the occupant's entry is byte-identical");
  assert.equal(tmux.state.windowName, "node", "and this session did not rename its window either");
  assert.equal(naming.currentName(), undefined);
});

test("a rename gives the old name back before the new one is claimed, and the window keeps ONE name", async () => {
  const { files, tmux, run } = makeNaming();
  await run("t2-registry");
  await run("t2-renamed");
  assert.equal(files.has(sessionEntryPath(ROOT, "t2-registry")), false, "the old name is free again");
  assert.equal(parseEntryText(files.get(sessionEntryPath(ROOT, "t2-renamed")))?.sessionId, MINE);
  assert.equal(tmux.state.option, "t2-renamed");
  assert.equal(tmux.state.windowName, "t2-renamed");
});

test("re-naming with the SAME name is a renewal, not a second registration", async () => {
  const { files, run } = makeNaming();
  await run("t2-registry");
  const first = parseEntryText(files.get(sessionEntryPath(ROOT, "t2-registry")));
  await run("t2-registry");
  const second = parseEntryText(files.get(sessionEntryPath(ROOT, "t2-registry")));
  assert.equal(second?.registeredAt, first?.registeredAt, "the original registration time survives");
  assert.equal([...files.keys()].length, 1);
});

test("a reclamation of a dead name is reported as such, and the new entry is this session's", async () => {
  const dead = JSON.stringify({
    schema: 1, name: "t2-registry", sessionId: THEIRS, pid: 4242,
    repo: "/repo/other", cwd: "/repo/other", mode: "child", state: "idle",
    registeredAt: new Date(NOW - 900_000).toISOString(), heartbeatAt: new Date(NOW - SESSION_STALE_MS - 1000).toISOString(),
  });
  const files = new Map([[sessionEntryPath(ROOT, "t2-registry"), dead]]);
  const { run } = makeNaming({ files });
  const reply = await run("t2-registry");
  assert.notEqual(reply.isError, true);
  assert.match(textOf(reply), /接管了死会话/);
  assert.equal(parseEntryText(files.get(sessionEntryPath(ROOT, "t2-registry")))?.sessionId, MINE);
});

// ---------------------------------------------------------------------------
// the lifecycle
// ---------------------------------------------------------------------------

test("the heartbeat renews the entry, and a name taken away is REPORTED instead of retaken", async () => {
  const { files, run, naming, lost } = makeNaming();
  await run("t2-registry");
  const before = parseEntryText(files.get(sessionEntryPath(ROOT, "t2-registry")));
  naming.tick();
  const after = parseEntryText(files.get(sessionEntryPath(ROOT, "t2-registry")));
  assert.equal(after?.sessionId, MINE, "a renewal never changes the owner");
  assert.equal(typeof before?.name, "string");
  assert.equal(naming.heartbeatMs, SESSION_HEARTBEAT_MS);

  // Somebody else takes the name (its holder is gone): the renewal must not
  // write over them, and the session is told.
  const taken = JSON.stringify({ ...after, sessionId: THEIRS });
  files.set(sessionEntryPath(ROOT, "t2-registry"), taken);
  naming.tick();
  assert.equal(files.get(sessionEntryPath(ROOT, "t2-registry")), taken, "the new holder's entry is untouched");
  assert.equal(naming.currentName(), undefined);
  assert.match(lost[0] ?? "", /不再持有/);
});

test("the heartbeat is silent when this session holds no name", () => {
  const { naming, files } = makeNaming();
  naming.tick();
  assert.equal(files.size, 0, "a session that never named itself writes nothing");
});

test("a release gives the name back, clears the option and puts the window title back exactly as it was", async () => {
  const { files, tmux, run, naming } = makeNaming();
  await run("t2-registry");
  const result = naming.release();
  assert.equal(result.released, true);
  assert.equal(files.has(sessionEntryPath(ROOT, "t2-registry")), false);
  assert.equal(tmux.state.option, "", "the status line falls back to the directory");
  assert.equal(tmux.state.windowName, "node", "and the title is the one the window had before");
  assert.equal(naming.currentName(), undefined);
  assert.deepEqual(naming.release(), { released: true }, "idempotent");
});

test("a release never renames a window somebody else renamed in the meantime", async () => {
  const { tmux, run, naming } = makeNaming();
  await run("t2-registry");
  tmux.state.windowName = "someone-elses-title";
  naming.release();
  assert.equal(tmux.state.windowName, "someone-elses-title", "not this session's window to rename again");
  assert.equal(tmux.state.option, "", "the option it wrote is still its own to clear");
});

test("a restart adopts the name its own session id already holds — and sweeps other people's leftovers", () => {
  const scope = "rg-pi-review-gate-ffee000000";
  const files = new Map<string, string>([
    [sessionEntryPath(ROOT, "t2-registry"), JSON.stringify({
      schema: 1, name: "t2-registry", sessionId: MINE, pid: 1, repo: "/repo/pi-review-gate",
      cwd: "/repo/pi-review-gate", mode: "loop", state: "idle",
      tmux: { session: "0", window: "@45", pane: PANE },
      registeredAt: new Date(NOW - 60_000).toISOString(), heartbeatAt: new Date(NOW).toISOString(),
    })],
    [sessionEntryPath(ROOT, "abandoned"), JSON.stringify({
      schema: 1, name: "abandoned", sessionId: THEIRS, pid: 4242, repo: "/repo/other", cwd: "/repo/other",
      mode: "child", state: "working", scopeSession: scope,
      registeredAt: new Date(NOW - 900_000).toISOString(), heartbeatAt: new Date(NOW - SESSION_STALE_MS - 1).toISOString(),
    })],
  ]);
  const tmux = fakeTmux({ panes: [], markers: { [scope]: THEIRS } });
  const { naming } = makeNaming({ files, tmux, sessionId: MINE });
  const started = naming.onSessionStart();
  assert.equal(started.adopted, "t2-registry", "the same session id keeps its name across a restart");
  assert.equal(naming.currentName(), "t2-registry");
  assert.deepEqual(started.sweep.reaped.map((r) => r.name), ["abandoned"]);
  assert.deepEqual(tmux.state.killed, [scope], "the dead session's tmux session is reclaimed");
  assert.equal(files.has(sessionEntryPath(ROOT, "abandoned")), false);
});

test("the entry carries the session's scope session once it has one, so the sweep can find it later", async () => {
  let scope: string | undefined;
  const { files, run, naming } = makeNaming({ scopeSession: () => scope });
  await run("t2-registry");
  assert.equal(parseEntryText(files.get(sessionEntryPath(ROOT, "t2-registry")))?.scopeSession, undefined);
  scope = "rg-pi-review-gate-0000000000";
  naming.tick();
  assert.equal(parseEntryText(files.get(sessionEntryPath(ROOT, "t2-registry")))?.scopeSession, scope,
    "the dedicated session is recorded by the next heartbeat");
});

test("a release that could not give the name back keeps it — the registry and the screen never disagree", async () => {
  // QUALITY ROUND P2 (2026-09-25): `held` used to be cleared BEFORE the failure
  // was looked at, so a failed release left the session believing it had no
  // name (nothing renews, nothing retries) while the entry — owned by this
  // very process — still looked live to every other reader. The window must not
  // be put back either: a registry that still says "mine" and a screen that
  // says nothing is the other half of the same lie.
  const { files, tmux, run, naming } = makeNaming();
  await run("t2-registry");
  // Somebody else's entry, as if the name had been taken over under us.
  files.set(sessionEntryPath(ROOT, "t2-registry"), JSON.stringify({
    ...JSON.parse(String(files.get(sessionEntryPath(ROOT, "t2-registry")))),
    sessionId: THEIRS,
  }));
  const released = naming.release();
  assert.equal(released.released, false);
  assert.match(released.error ?? "", /已不归本会话/);
  assert.equal(naming.currentName(), "t2-registry", "the session still holds what the registry did not confirm it lost");
  assert.equal(tmux.state.option, "t2-registry", "…and the window is not put back behind the registry's back");
  assert.equal(tmux.state.windowName, "t2-registry");
});

test("listing the addressable names reports WHO IS ALIVE and never drops the ones it cannot judge", async () => {
  const stale = new Date(NOW - SESSION_STALE_MS - 1000).toISOString();
  const files = new Map<string, string>([
    [sessionEntryPath(ROOT, "alive-one"), JSON.stringify(entryForTest("alive-one", MINE, NOW))],
    [sessionEntryPath(ROOT, "dead-one"), JSON.stringify(entryForTest("dead-one", THEIRS, Date.parse(stale)))],
  ]);
  const live = liveSessionNames({ root: ROOT, io: fakeIO(files), runTmux: fakeTmux({ panes: [] }).run, now: () => NOW, alive: () => false });
  assert.deepEqual(live.live.map((e) => e.name), ["alive-one"]);
  assert.deepEqual(live.unknown, [], "a provably dead holder is not \"unknown\"");
  // An unreadable tmux is missing information: the stale one is reported as
  // unknown rather than silently dropped from the list a caller picks from.
  const blind = liveSessionNames({ root: ROOT, io: fakeIO(files), runTmux: fakeTmux({ blind: true }).run, now: () => NOW, alive: () => false });  assert.deepEqual(blind.live.map((e) => e.name), ["alive-one"]);
  assert.deepEqual(blind.unknown.map((e) => e.name), ["dead-one"]);
});

test("the registry root defaults to the agent home, and the inbox sits beside the entry", () => {
  assert.match(sessionRegistryRoot("/home/agent"), /rg-sessions$/);
  assert.equal(sessionEntryPath(ROOT, "t2-registry"), `${ROOT}/t2-registry.json`);
});
