/**
 * Control (lib/daemon/control.ts): the inbox record has to be the SAME wire
 * format `lib/session-message-tools.ts` writes (its `parseInboxRecord` is the
 * judge here), and starting a session has to go through tmux in the shape the
 * gate's own scope rules demand.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createDaemonTmuxRunner,
  launchTask,
  listCandidateRepos,
  safeWindowName,
  sendSessionMessage,
} from "../lib/daemon/control.ts";
import { runTmuxArgv } from "../lib/tmux-exec.ts";
import { createSessionObserver } from "../lib/daemon/sessions.ts";
import { inboxPayloadPath, parseInboxRecord, SESSION_MESSAGE_KIND } from "../lib/session-message-tools.ts";
import { sessionInboxPath, sessionNameProblem, sessionRegistryRoot } from "../lib/session-registry.ts";
import { MAX_INLINE_RECORD_BYTES } from "../lib/channel-io.ts";
import {
  fakeRunner,
  paneRunner,
  registryEntry,
  scratchHome,
  writeRegistry,
  writeTranscript,
} from "./daemon-helpers.ts";

function inboxLines(home: string, name: string): string[] {
  const raw = readFileSync(sessionInboxPath(sessionRegistryRoot(home), name), "utf8");
  return raw.split("\n").filter((line) => line.trim() !== "");
}

test("a message lands in the inbox in the module's own record shape", () => {
  const home = scratchHome();
  writeRegistry(home, registryEntry({ name: "t1-work", sessionId: "s-1", repo: "/repo", cwd: "/repo" }));
  const outcome = sendSessionMessage({ home, runTmux: paneRunner([]), now: () => 1_700_000_000_000 }, {
    to: "@t1-work",
    text: "please look at the daemon",
  });
  assert.equal(outcome.ok, true, outcome.problem ?? "");

  const lines = inboxLines(home, "t1-work");
  assert.equal(lines.length, 1);
  const record = parseInboxRecord(lines[0]!);
  assert.ok(record, "the gate's own parser must accept what the daemon writes");
  assert.equal(record.kind, SESSION_MESSAGE_KIND);
  assert.equal(record.from, "daemon");
  assert.equal(record.fromSessionId, "daemon");
  assert.equal(record.fromMode, "daemon");
  assert.equal(record.toSessionId, "s-1");
  assert.equal(record.text, "please look at the daemon");
  assert.equal(record.at, "2023-11-14T22:13:20.000Z");
  assert.deepEqual(Object.keys(JSON.parse(lines[0]!)).sort(), [
    "at", "from", "fromMode", "fromRepo", "fromSessionId", "kind", "messageId", "text", "toSessionId",
  ].sort());
  assert.equal(outcome.inbox, sessionInboxPath(sessionRegistryRoot(home), "t1-work"));
});

test("a message nobody can be reached at is refused, with the addresses that do work", () => {
  const home = scratchHome();
  writeRegistry(home, registryEntry({ name: "live-one", sessionId: "s-1", repo: "/repo", cwd: "/repo" }));
  const outcome = sendSessionMessage({ home, runTmux: paneRunner([]) }, { to: "ghost", text: "hello" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem ?? "", /不在活会话里/);
  assert.deepEqual(outcome.liveNames, ["live-one"]);
});

test("a name whose holder cannot be classified is refused fail-closed", () => {
  const home = scratchHome();
  writeRegistry(home, registryEntry({
    name: "stale-one",
    sessionId: "s-1",
    repo: "/repo",
    cwd: "/repo",
    pid: 999_999_999,
    heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  }));
  // tmux unreadable ⇒ the registry cannot separate "stuck" from "gone" ⇒ unknown.
  const outcome = sendSessionMessage({
    home,
    runTmux: fakeRunner(() => ({ ok: false, stdout: "", stderr: "no server" })),
  }, { to: "stale-one", text: "hello" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem ?? "", /判不出来/);
});

test("an empty name, a bad name and an empty body are refused before any file is touched", () => {
  const home = scratchHome();
  assert.equal(sendSessionMessage({ home, runTmux: paneRunner([]) }, { to: "", text: "x" }).ok, false);
  assert.equal(sendSessionMessage({ home, runTmux: paneRunner([]) }, { to: "a", text: "x" }).ok, false);
  assert.equal(sendSessionMessage({ home, runTmux: paneRunner([]) }, { to: "t1-work", text: "   " }).ok, false);
});

test("a pane id minted by another tmux server never counts as a live session", () => {
  const home = scratchHome();
  // A stale registration whose pane id EXISTS on the server we are talking to —
  // but was minted by a different one (a restarted server reuses `%1`).
  writeRegistry(home, registryEntry({
    name: "old-one",
    sessionId: "s1",
    repo: "/repo",
    cwd: "/repo",
    pid: 999_999_999,
    heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    tmux: { session: "rg-old", window: "@1", pane: "%1", server: "/private/tmp/tmux-501/old,111" },
  }));
  const runner = fakeRunner((argv) => {
    if (argv[0] === "display-message") return { ok: true, stdout: "/private/tmp/tmux-501/default,22388\n", stderr: "" };
    if (argv[0] === "list-panes") return { ok: true, stdout: "%1\n", stderr: "" };
    return { ok: false, stdout: "", stderr: `unexpected: ${argv.join(" ")}` };
  });
  const outcome = sendSessionMessage({ home, runTmux: runner }, { to: "old-one", text: "hi" });
  assert.equal(outcome.ok, false, "a stranger's pane is not this session");
  assert.match(outcome.problem ?? "", /不在活会话里/);

  // …and the same entry IS live when the server matches (the pane id means what
  // the record says it means).
  writeRegistry(home, registryEntry({
    name: "old-one",
    sessionId: "s1",
    repo: "/repo",
    cwd: "/repo",
    pid: 999_999_999,
    heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    tmux: { session: "rg-old", window: "@1", pane: "%1", server: "/private/tmp/tmux-501/default,22388" },
  }));
  assert.equal(sendSessionMessage({ home, runTmux: runner }, { to: "old-one", text: "hi" }).ok, true);
});

test("a body too long for one line spills to a side file the record points at", () => {
  const home = scratchHome();
  writeRegistry(home, registryEntry({ name: "t1-work", sessionId: "s-1", repo: "/repo", cwd: "/repo" }));
  const body = "x".repeat(MAX_INLINE_RECORD_BYTES + 100);
  const outcome = sendSessionMessage({ home, runTmux: paneRunner([]) }, { to: "t1-work", text: body });
  assert.equal(outcome.ok, true, outcome.problem ?? "");
  const line = inboxLines(home, "t1-work")[0]!;
  assert.ok(Buffer.byteLength(line, "utf8") <= MAX_INLINE_RECORD_BYTES + 1, "the appended line stays small");
  const record = parseInboxRecord(line)!;
  assert.equal(record.text, undefined);
  assert.equal(record.textRef?.chars, body.length);
  assert.equal(record.textRef?.path, inboxPayloadPath(sessionInboxPath(sessionRegistryRoot(home), "t1-work"), record.messageId));
  assert.equal(readFileSync(record.textRef!.path, "utf8"), body);
});

test("the daemon's tmux runner refuses anything outside its own declared session", () => {
  const refused = runTmuxArgv(["kill-session", "-t", "rg-somebody-else"], process.env, { ownSessions: ["rg-mine-abcdef"] });
  assert.equal(refused.ok, false);
  assert.match(refused.stderr, /必须是本会话自己的 session/);
  const killServer = runTmuxArgv(["kill-server"], process.env, { ownSessions: ["rg-mine-abcdef"] });
  assert.equal(killServer.ok, false);
  assert.match(killServer.stderr, /kill-server/);
  assert.equal(typeof createDaemonTmuxRunner(), "function");
});

test("launchTask opens a window in the daemon's own scope with mode, station and task", () => {
  const home = scratchHome();
  const calls: string[][] = [];
  const runner = fakeRunner((argv) => {
    calls.push([...argv]);
    if (argv[0] === "list-sessions") return { ok: true, stdout: "", stderr: "" };
    if (argv[0] === "new-session" || argv[0] === "new-window") return { ok: true, stdout: "@3 %9\n", stderr: "" };
    if (argv[0] === "list-panes") return { ok: true, stdout: "", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
  const outcome = launchTask({ home, runTmux: runner }, {
    repo: process.cwd(),
    task: "把 daemon 的文档补齐",
    mode: "loop",
    station: "commit",
    name: "panel-task",
  });
  assert.equal(outcome.ok, true, outcome.problem ?? "");
  assert.equal(outcome.windowId, "@3");
  assert.equal(outcome.paneId, "%9");
  assert.ok(outcome.scopeSession?.startsWith("rg-"), `unexpected scope session: ${outcome.scopeSession}`);

  const creation = calls.find((argv) => argv[0] === "new-session")!;
  assert.ok(creation.includes("-c"));
  assert.equal(creation[creation.indexOf("-c") + 1], process.cwd());
  assert.equal(creation[creation.indexOf("-s") + 1], outcome.scopeSession, "the session it creates is the one it reported");
  const env = creation.find((entry) => entry.startsWith("RG_GATE_MODE="));
  assert.equal(env, "RG_GATE_MODE=loop");
  assert.ok(creation.some((entry) => entry === "RG_STATION_CAP=commit"));
  // The daemon's own home rides along: `envCommand` strips every gate variable
  // that is not passed, and a session that cannot see the daemon's home writes
  // its questions where this daemon never looks (quality round P2, 2026-10-01).
  assert.ok(creation.some((entry) => entry === `RG_DAEMON_HOME=${home}`), `unexpected env: ${creation.join(" ")}`);
  assert.ok(creation.includes("--session-id"));
  assert.ok(creation.includes("--name"));
  assert.equal(creation[creation.indexOf("--name") + 1], "panel-task");
  const afterDashes = creation.slice(creation.indexOf("--") + 1).join(" ");
  assert.match(afterDashes, /把 daemon 的文档补齐/);
  assert.match(afterDashes, /name_session\(\{name:"panel-task"\}\)/);
});

test("launchTask refuses a bad repo, mode, station or a name somebody holds", () => {
  const home = scratchHome();
  const runner = paneRunner([]);
  const base = { home, runTmux: runner };
  assert.match(launchTask(base, { repo: "/definitely/not/here", task: "x" }).problem ?? "", /不是存在的目录/);
  assert.match(launchTask(base, { repo: process.cwd(), task: "  " }).problem ?? "", /任务描述是空的/);
  assert.match(launchTask(base, { repo: process.cwd(), task: "x", mode: "turbo" }).problem ?? "", /门禁模式/);
  assert.match(launchTask(base, { repo: process.cwd(), task: "x", station: "prod" }).problem ?? "", /交付站点/);
  assert.match(launchTask(base, { repo: process.cwd(), task: "x", name: "A" }).problem ?? "", /会话名不合法/);

  writeRegistry(home, registryEntry({ name: "taken-name", sessionId: "s-9", repo: "/repo", cwd: "/repo" }));
  assert.match(launchTask(base, { repo: process.cwd(), task: "x", name: "taken-name" }).problem ?? "", /已被占用/);
});

test("a tmux that cannot list sessions refuses the launch instead of creating one", () => {
  const home = scratchHome();
  const outcome = launchTask(
    { home, runTmux: fakeRunner(() => ({ ok: false, stdout: "", stderr: "no server" })) },
    { repo: process.cwd(), task: "x" },
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem ?? "", /读不到 tmux server|list-sessions/);
});

test("candidate repos come from running sessions and from the workspace roots", () => {
  const home = scratchHome();
  const repoA = join(home, "repos", "alpha");
  const repoB = join(home, "repos", "beta");
  const workspace = join(home, "workspace");
  mkdirSync(join(repoA, ".git"), { recursive: true });
  mkdirSync(join(repoB, ".git"), { recursive: true });
  mkdirSync(join(workspace, "gamma", ".git"), { recursive: true });
  mkdirSync(join(workspace, "not-a-repo"), { recursive: true });

  writeRegistry(home, registryEntry({ name: "t1", sessionId: "s1", repo: repoA, cwd: repoA }));
  writeTranscript(home, { sessionId: "s2", cwd: repoB, records: [] });

  const observer = createSessionObserver({ home, runTmux: paneRunner([]) });
  const repos = listCandidateRepos({ observer, workspaceRoots: [workspace] });
  const paths = repos.map((repo) => repo.path);
  assert.ok(paths.includes(repoA), "a running session's repo is offered");
  assert.ok(paths.includes(repoB), "a recent transcript's cwd is offered");
  assert.ok(paths.includes(join(workspace, "gamma")), "a git repo one level under a workspace root is offered");
  assert.ok(!paths.includes(join(workspace, "not-a-repo")));
  assert.equal(new Set(paths).size, paths.length, "no duplicates");
});

test("safeWindowName strips what tmux would expand and caps the length", () => {
  assert.equal(safeWindowName("t1#(echo pwn)"), "t1(echo pwn)");
  assert.equal(safeWindowName("a\nb"), "ab");
  assert.equal(safeWindowName("x".repeat(80)).length, 32);
});

test("sessionNameProblem is the rule the daemon applies (no second naming rule)", () => {
  assert.equal(sessionNameProblem("daemon"), undefined);
  assert.notEqual(sessionNameProblem("daemon "), undefined);
});

test("a launch leaves no stray files in the agent home beyond its own scope record", () => {
  const home = scratchHome();
  const runner = fakeRunner((argv) =>
    argv[0] === "list-sessions" ? { ok: true, stdout: "", stderr: "" } : { ok: true, stdout: "@1 %1\n", stderr: "" });
  launchTask({ home, runTmux: runner }, { repo: process.cwd(), task: "x" });
  const entries = readdirSync(join(home, ".pi", "agent", "rg-daemon"));
  assert.deepEqual(entries.sort(), ["identity", "scope-repo", "scope.json"]);
  assert.ok(readFileSync(join(home, ".pi", "agent", "rg-daemon", "scope-repo"), "utf8").includes(process.cwd()));
});
