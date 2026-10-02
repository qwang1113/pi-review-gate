/**
 * Control (lib/daemon/control.ts): the inbox record has to be the SAME wire
 * format `lib/session-message-tools.ts` writes (its `parseInboxRecord` is the
 * judge here), and starting a session has to go through tmux in the shape the
 * gate's own scope rules demand.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
  const outcome = sendSessionMessage({ home, userHome: home, runTmux: paneRunner([]), now: () => 1_700_000_000_000 }, {
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

test("a message reaches the registry the GATE wrote, not one under the daemon's own home", () => {
  // DEFECT 1's other half (t6 acceptance): the daemon hands `RG_DAEMON_HOME` to
  // the sessions it launches, but the GATE resolves its registry from `$HOME`
  // (`sessionRegistryRoot()`) and knows nothing about that variable. Read from
  // the daemon's own home, every name came back "不在活会话里" under the
  // documented override — the message was never sent.
  const home = scratchHome(); // the USER home: where a session registers
  const daemonHome = scratchHome(); // the daemon's own: where it used to look
  writeRegistry(home, registryEntry({ name: "t1-work", sessionId: "s-1", repo: "/repo", cwd: "/repo" }));
  const deps = { home: daemonHome, userHome: home, runTmux: paneRunner([]) };
  const outcome = sendSessionMessage(deps, { to: "@t1-work", text: "hi" });
  assert.equal(outcome.ok, true, outcome.problem ?? "");
  // THE INBOX LANDS NEXT TO THAT REGISTRATION — which is where the recipient's
  // own gate reads it, since its root is the same one.
  assert.equal(inboxLines(home, "t1-work").length, 1);

  // The daemon's home is not a second registry: a name that exists only there
  // is not addressable at all.
  writeRegistry(daemonHome, registryEntry({ name: "daemon-only", sessionId: "s-2", repo: "/repo", cwd: "/repo" }));
  assert.equal(sendSessionMessage(deps, { to: "daemon-only", text: "hi" }).ok, false);
});

test("a message nobody can be reached at is refused, with the addresses that do work", () => {
  const home = scratchHome();
  writeRegistry(home, registryEntry({ name: "live-one", sessionId: "s-1", repo: "/repo", cwd: "/repo" }));
  const outcome = sendSessionMessage({ home, userHome: home, runTmux: paneRunner([]) }, { to: "ghost", text: "hello" });
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
    userHome: home,
    runTmux: fakeRunner(() => ({ ok: false, stdout: "", stderr: "no server" })),
  }, { to: "stale-one", text: "hello" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem ?? "", /判不出来/);
});

test("an empty name, a bad name and an empty body are refused before any file is touched", () => {
  const home = scratchHome();
  assert.equal(sendSessionMessage({ home, userHome: home, runTmux: paneRunner([]) }, { to: "", text: "x" }).ok, false);
  assert.equal(sendSessionMessage({ home, userHome: home, runTmux: paneRunner([]) }, { to: "a", text: "x" }).ok, false);
  assert.equal(sendSessionMessage({ home, userHome: home, runTmux: paneRunner([]) }, { to: "t1-work", text: "   " }).ok, false);
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
  const outcome = sendSessionMessage({ home, userHome: home, runTmux: runner }, { to: "old-one", text: "hi" });
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
  assert.equal(sendSessionMessage({ home, userHome: home, runTmux: runner }, { to: "old-one", text: "hi" }).ok, true);
});

test("a body too long for one line spills to a side file the record points at", () => {
  const home = scratchHome();
  writeRegistry(home, registryEntry({ name: "t1-work", sessionId: "s-1", repo: "/repo", cwd: "/repo" }));
  const body = "x".repeat(MAX_INLINE_RECORD_BYTES + 100);
  const outcome = sendSessionMessage({ home, userHome: home, runTmux: paneRunner([]) }, { to: "t1-work", text: body });
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
  const outcome = launchTask({ home, userHome: home, runTmux: runner }, {
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
  const base = { home, userHome: home, runTmux: runner };
  assert.match(launchTask(base, { repo: "/definitely/not/here", task: "x" }).problem ?? "", /不是存在的目录/);
  assert.match(launchTask(base, { repo: process.cwd(), task: "  " }).problem ?? "", /任务描述是空的/);
  assert.match(launchTask(base, { repo: process.cwd(), task: "x", mode: "turbo" }).problem ?? "", /门禁模式/);
  assert.match(launchTask(base, { repo: process.cwd(), task: "x", station: "prod" }).problem ?? "", /交付站点/);
  assert.match(launchTask(base, { repo: process.cwd(), task: "x", name: "A" }).problem ?? "", /会话名不合法/);

  writeRegistry(home, registryEntry({ name: "taken-name", sessionId: "s-9", repo: "/repo", cwd: "/repo" }));
  assert.match(launchTask(base, { repo: process.cwd(), task: "x", name: "taken-name" }).problem ?? "", /已被占用/);
});

test("a tmux that cannot run at all refuses the launch instead of creating one", () => {
  const home = scratchHome();
  // ENOENT is the shape a MISSING EXECUTABLE has — the failure that silently
  // ate every scheduled run on 2026-10-02, and the one retrying cannot fix.
  const outcome = launchTask(
    { home, userHome: home, runTmux: fakeRunner(() => ({ ok: false, stdout: "", stderr: "spawnSync tmux ENOENT" })) },
    { repo: process.cwd(), task: "x" },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.permanent, true, "永久障碍：调度器据此消费掉那一槽，而不是每 20 秒重试");
  assert.match(outcome.problem ?? "", /起不来 tmux/);
});

test("a tmux server that is merely DOWN does not stop the launch (2026-10-03)", () => {
  const home = scratchHome();
  // `no server running` means there is no session to find — and `new-session` is
  // exactly what starts one. Refusing here used to lose the slot every time.
  const tmux = fakeRunner((argv) => {
    if (argv[0] === "list-sessions") return { ok: false, stdout: "", stderr: "no server running on /tmp/tmux-501/default" };
    if (argv[0] === "new-session") return { ok: true, stdout: "@1 %1\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
  const outcome = launchTask({ home, userHome: home, runTmux: tmux }, { repo: process.cwd(), task: "x" });
  assert.equal(outcome.ok, true, outcome.problem ?? "");
  assert.ok(outcome.sessionId !== undefined);
  assert.ok(tmux.calls.some((argv) => argv[0] === "new-session"), JSON.stringify(tmux.calls));
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

  const observer = createSessionObserver({ userHome: home, runTmux: paneRunner([]) });
  const repos = listCandidateRepos({ observer, workspaceRoots: [workspace] });
  const paths = repos.map((repo) => repo.path);
  assert.ok(paths.includes(repoA), "a running session's repo is offered");
  assert.ok(paths.includes(repoB), "a recent transcript's cwd is offered");
  assert.ok(paths.includes(join(workspace, "gamma")), "a git repo one level under a workspace root is offered");
  assert.ok(!paths.includes(join(workspace, "not-a-repo")));
  assert.equal(new Set(paths).size, paths.length, "no duplicates");
  // The three source words are a CONTRACT (docs/daemon/api.md §5.6) and the
  // panel renders one group per word — a finished session offered as a running
  // one is what this distinction exists to prevent.
  const sources = new Map(repos.map((repo) => [repo.path, repo.source]));
  assert.equal(sources.get(repoA), "session", "a live session's repo is a running one");
  assert.equal(sources.get(repoB), "history", "a transcript with no pane left is history");
  assert.equal(sources.get(join(workspace, "gamma")), "root");
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
  launchTask({ home, userHome: home, runTmux: runner }, { repo: process.cwd(), task: "x" });
  const entries = readdirSync(join(home, ".pi", "agent", "rg-daemon"));
  assert.deepEqual(entries.sort(), ["identity", "scope-repo", "scope.json"]);
  assert.ok(readFileSync(join(home, ".pi", "agent", "rg-daemon", "scope-repo"), "utf8").includes(process.cwd()));
  // …AND THE MODE THE CONTRACT PROMISES (docs/daemon/api.md §11 的文件表): 0600
  // on both, not whatever the process umask happens to be — the record and the
  // anchor repo are the daemon's own business, not every user on the machine's.
  for (const name of ["scope.json", "scope-repo"]) {
    const mode = statSync(join(home, ".pi", "agent", "rg-daemon", name)).mode & 0o777;
    assert.equal(mode, 0o600, `${name} must be 0600 (§11), got 0o${mode.toString(8)}`);
  }
});
