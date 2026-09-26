/**
 * THE UNNAMED SESSIONS' DEDICATED TMUX SESSIONS — what a crashed session left.
 *
 * A session killed with `kill -9` never runs its exit cleanup, and if it never
 * took a name there is no registration to find it by. The sweep reads the
 * session itself instead (marker + owner pid + owner pane) and kills it only
 * when every fact says the owner is gone. Each test below is one fact that is
 * missing, unreadable or alive — and each must leave the session standing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { sweepOrphans } from "../lib/session-orphan-sweep.ts";
import { sessionEntryPath, type RegistryDeps, type RegistryIO } from "../lib/session-registry.ts";
import { deriveSessionName } from "../lib/session-tmux-scope.ts";
import {
  SESSION_OWNER_OPTION,
  SESSION_OWNER_PANE_OPTION,
  SESSION_OWNER_PID_OPTION,
  SESSION_PINNED_OPTION,
} from "../lib/tmux-session-argv.ts";
import type { TmuxRunner } from "../lib/orchestrator-tmux.ts";

const ROOT = "/home/agent/.pi/agent/rg-sessions";
const NOW = Date.parse("2026-09-27T10:00:00.000Z");
const DEAD = "019fbb1d-9e78-7ebf-88bf-dead00000001";
const LIVE = "019fbb1d-9e78-7ebf-88bf-11fe00000002";
const MINE = "019fbb1d-9e78-7ebf-88bf-3e1f00000003";
const DEAD_SCOPE = deriveSessionName("/repo/other-repo", DEAD)!;

type Options = Record<string, string>;

function fakeTmux(opts: {
  sessions: Record<string, Options>;
  panes?: string[];
  fail?: "list-sessions" | "show-options" | "list-panes" | "kill-session";
  throws?: boolean;
}) {
  const killed: string[] = [];
  const sets: string[][] = [];
  const run: TmuxRunner = (argv, _env, declared) => {
    const sub = argv[0];
    if (sub === opts.fail) {
      if (opts.throws) throw new Error(`${sub} blew up`);
      return { ok: false, stdout: "", stderr: `${sub} failed` };
    }
    const target = String(argv[argv.indexOf("-t") + 1] ?? "");
    if (sub === "list-sessions") return { ok: true, stdout: Object.keys(opts.sessions).join("\n"), stderr: "" };
    if (sub === "list-panes") return { ok: true, stdout: (opts.panes ?? []).join("\n"), stderr: "" };
    if (sub === "show-options") return { ok: true, stdout: `${opts.sessions[target]?.[String(argv.at(-1))] ?? ""}\n`, stderr: "" };
    if (sub === "set") {
      sets.push([...argv]);
      return { ok: true, stdout: "", stderr: "" };
    }
    if (sub === "kill-session") {
      assert.deepEqual(declared, [target], "the kill declares the session it just proved");
      killed.push(target);
      return { ok: true, stdout: "", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  return { run, killed, sets };
}

function io(files = new Map<string, string>(), listable = true): RegistryIO {
  return {
    readText: (path) => files.get(path),
    writeText: () => true,
    createExclusive: () => true,
    rename: () => false,
    remove: () => true,
    listFiles: () => (listable ? [...files.keys()].map((path) => path.slice(path.lastIndexOf("/") + 1)) : undefined),
  };
}

function deps(tmux: ReturnType<typeof fakeTmux>, opts: { alive?: (pid: number) => boolean; files?: Map<string, string>; listable?: boolean } = {}): RegistryDeps {
  return {
    root: ROOT,
    io: io(opts.files, opts.listable ?? true),
    runTmux: tmux.run,
    alive: opts.alive ?? (() => false),
    now: () => NOW,
  };
}

function facts(owner: string, pid = "4242", pane = "%42"): Options {
  return { [SESSION_OWNER_OPTION]: owner, [SESSION_OWNER_PID_OPTION]: pid, [SESSION_OWNER_PANE_OPTION]: pane };
}

test("a crashed owner (pid gone, pane gone) loses its dedicated session; a live one's stays", () => {
  const liveScope = deriveSessionName("/repo/x", LIVE)!;
  const tmux = fakeTmux({
    sessions: { [DEAD_SCOPE]: facts(DEAD), [liveScope]: facts(LIVE, "777", "%7"), work: {} },
    panes: ["%7"],
  });
  const report = sweepOrphans(deps(tmux, { alive: (pid) => pid === 777 }), { sessionId: MINE });
  assert.deepEqual(tmux.killed, [DEAD_SCOPE]);
  assert.deepEqual(report.scopes.reaped, [{ session: DEAD_SCOPE, owner: DEAD }]);
  assert.match(report.notes.join("\n"), new RegExp(`已回收.*${DEAD_SCOPE}`), "every kill reaches the log");
  assert.match(report.scopes.kept.find((k) => k.session === liveScope)?.reason ?? "", /pid 777 还在/);
});

test("any live or missing fact keeps the session", () => {
  const cases: [string, Parameters<typeof fakeTmux>[0], ((pid: number) => boolean)?][] = [
    ["pid alive", { sessions: { [DEAD_SCOPE]: facts(DEAD) } }, () => true],
    ["pid probe throws", { sessions: { [DEAD_SCOPE]: facts(DEAD) } }, () => { throw new Error("EINVAL"); }],
    ["pane still there", { sessions: { [DEAD_SCOPE]: facts(DEAD) }, panes: ["%42"] }],
    ["old session: no pid", { sessions: { [DEAD_SCOPE]: facts(DEAD, "") } }],
    ["old session: no pane", { sessions: { [DEAD_SCOPE]: facts(DEAD, "4242", "") } }],
    ["garbage pid", { sessions: { [DEAD_SCOPE]: facts(DEAD, "12abc") } }],
    ["empty marker", { sessions: { [DEAD_SCOPE]: facts("") } }],
    ["marker does not mint the name", { sessions: { [DEAD_SCOPE]: facts(LIVE) } }],
    ["list-sessions fails", { sessions: { [DEAD_SCOPE]: facts(DEAD) }, fail: "list-sessions" }],
    ["list-sessions throws", { sessions: { [DEAD_SCOPE]: facts(DEAD) }, fail: "list-sessions", throws: true }],
    ["show-options fails", { sessions: { [DEAD_SCOPE]: facts(DEAD) }, fail: "show-options" }],
    ["show-options throws", { sessions: { [DEAD_SCOPE]: facts(DEAD) }, fail: "show-options", throws: true }],
    ["list-panes fails", { sessions: { [DEAD_SCOPE]: facts(DEAD) }, fail: "list-panes" }],
    ["list-panes throws", { sessions: { [DEAD_SCOPE]: facts(DEAD) }, fail: "list-panes", throws: true }],
    ["pinned (handed off / manager's children)", { sessions: { [DEAD_SCOPE]: { ...facts(DEAD), [SESSION_PINNED_OPTION]: "handed-off" } } }],
  ];
  for (const [label, server, alive] of cases) {
    const tmux = fakeTmux(server);
    const report = sweepOrphans(deps(tmux, alive === undefined ? {} : { alive }), { sessionId: MINE });
    assert.deepEqual(tmux.killed, [], label);
    assert.deepEqual(report.scopes.reaped, [], label);
  }
});

test("readable names (rg-<repo>-<role>-<tail>) and the older shape are swept by the same rule", () => {
  // s1, 2026-09-27: the role segment is new; a session the older build named
  // must neither be killed while its owner lives nor escape once it is dead.
  const oldLive = deriveSessionName("/repo/x", LIVE)!;
  const newDead = deriveSessionName("/repo/other-repo", DEAD, "pm")!;
  assert.match(newDead, /^rg-other-repo-pm-/);
  const tmux = fakeTmux({
    sessions: { [oldLive]: facts(LIVE, "777", "%7"), [newDead]: facts(DEAD), [DEAD_SCOPE]: facts(DEAD) },
    panes: ["%7"],
  });
  sweepOrphans(deps(tmux, { alive: (pid) => pid === 777 }), { sessionId: MINE });
  assert.deepEqual([...tmux.killed].sort(), [DEAD_SCOPE, newDead].sort(), "the dead owner's sessions, both shapes");
  assert.equal(tmux.killed.includes(oldLive), false, "the live owner's old-name session survives");
});

test("a kill tmux refuses is reported, not thrown", () => {
  for (const throws of [false, true]) {
    const tmux = fakeTmux({ sessions: { [DEAD_SCOPE]: facts(DEAD) }, fail: "kill-session", throws });
    const report = sweepOrphans(deps(tmux), {});
    assert.deepEqual(report.scopes.reaped, []);
    assert.doesNotMatch(report.notes.join("\n"), /已回收/);
    assert.match(report.scopes.kept[0]?.reason ?? "", /回收失败/);
  }
});

test("my own dedicated session is refreshed with THIS process's pid/pane, never reaped", () => {
  const mine = deriveSessionName("/repo/me", MINE)!;
  const tmux = fakeTmux({ sessions: { [mine]: facts(MINE, "1", "%1") } });
  const report = sweepOrphans(deps(tmux), { sessionId: MINE, pid: 9090, pane: "%90" });
  assert.deepEqual(tmux.killed, []);
  assert.deepEqual(tmux.sets.map((a) => [a[2], a[3], a[4]]), [
    [mine, SESSION_OWNER_PID_OPTION, "9090"],
    [mine, SESSION_OWNER_PANE_OPTION, "%90"],
  ]);
  assert.match(report.scopes.kept[0]?.reason ?? "", /本会话自己/);
});

test("a NAMED session's dedicated session is the registration path's, and an unreadable registry stops this pass", () => {
  const entry = {
    schema: 1, name: "t2-registry", sessionId: DEAD, pid: 4242, repo: "/r", cwd: "/r", mode: "loop", state: "working",
    registeredAt: new Date(NOW - 60_000).toISOString(),
    // LIVE by heartbeat: the registration path keeps it, and this pass must not overrule that.
    heartbeatAt: new Date(NOW - 1000).toISOString(),
  };
  const files = new Map([[sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry)]]);
  const tmux = fakeTmux({ sessions: { [DEAD_SCOPE]: facts(DEAD) } });
  sweepOrphans(deps(tmux, { files }), {});
  assert.deepEqual(tmux.killed, [], "owned by a named session ⇒ not this pass's to kill");

  const byScope = new Map([[sessionEntryPath(ROOT, "t2-registry"), JSON.stringify({ ...entry, sessionId: LIVE, scopeSession: DEAD_SCOPE })]]);
  const tmux2 = fakeTmux({ sessions: { [DEAD_SCOPE]: facts(DEAD) } });
  sweepOrphans(deps(tmux2, { files: byScope }), {});
  assert.deepEqual(tmux2.killed, [], "named as some registration's scope session ⇒ left to that path");

  const blind = fakeTmux({ sessions: { [DEAD_SCOPE]: facts(DEAD) } });
  const report = sweepOrphans(deps(blind, { listable: false }), {});
  assert.deepEqual(blind.killed, []);
  assert.deepEqual(report.scopes, { reaped: [], kept: [] });
});
