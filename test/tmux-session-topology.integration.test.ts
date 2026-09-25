/**
 * THE WINDOW TOPOLOGY, MEASURED AGAINST A REAL TMUX (2026-09-25).
 *
 * The unit tests pin the argv; only this file pins what tmux DOES with it, and
 * the facts it pins are the ones the whole change rests on:
 *
 *   - a child really lands as a WINDOW of the opener's own session (`new-session`
 *     for the first one, `new-window` for the rest), with the gate's label as
 *     its window name;
 *   - the opener's own window gains NOTHING — no split, no resize, no pane;
 *   - `kill-window` frees exactly that child, and tmux reclaims the session
 *     itself once its last window is gone;
 *   - the ownership marker is what makes reuse and the final kill safe: a
 *     session whose marker says somebody else created it is neither reused nor
 *     killed;
 *   - liveness (`list-panes -a`) answers about a window the opener's window
 *     cannot even see.
 *
 * It drives the PRODUCTION functions rather than a copy of them
 * (`openSessionWindow`, `closeSessionWindow`, `openScopeWindow`,
 * `closeOwnSession`), each given a runner that executes the very argv the gate
 * would execute against a throwaway server.
 *
 * It runs on its OWN tmux socket (`-L rg-scope-lab-<pid>`), never the user's
 * server, and destroys it afterwards. No tmux ⇒ skipped, not failed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeSessionWindow,
  openSessionWindow,
  type PaneRunner,
} from "../lib/session-factory.ts";
import {
  closeOwnSession,
  deriveSessionName,
  openScopeWindow,
  type TmuxScope,
  type TmuxScopeRecord,
} from "../lib/session-tmux-scope.ts";
import { isOwnSessionName, SESSION_OWNER_OPTION } from "../lib/orchestrator-tmux.ts";
import { judgePaneAlive } from "../lib/judge-pane.ts";

const SOCKET = `rg-scope-lab-${process.pid}`;
const SESSION_ID = "019fbb1d-9e78-7ebf-88bf-d104b8a270ed";
const OWN_SESSION = deriveSessionName("/tmp/pi-review-gate-lab", SESSION_ID)!;

function tmux(args: readonly string[]): string {
  return execFileSync("tmux", ["-L", SOCKET, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tmuxOk(args: readonly string[]): boolean {
  try {
    tmux(args);
    return true;
  } catch {
    return false;
  }
}

function tmuxInstalled(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SKIP = tmuxInstalled() ? false : "tmux is not installed";

/** The gate's own runner, backed by the lab server. */
const runner: PaneRunner = (argv) => {
  try {
    return { ok: true, stdout: tmux([...argv]), stderr: "" };
  } catch (error) {
    return { ok: false, stdout: "", stderr: String(error) };
  }
};

/** A scope whose sidecar record is an object in memory, like the real one. */
interface LabScope extends TmuxScope {
  record: TmuxScopeRecord | undefined;
}

function labScope(): LabScope {
  const scope: LabScope = {
    record: undefined,
    sessionId: () => SESSION_ID,
    repoRoot: () => "/tmp/pi-review-gate-lab",
    read: () => scope.record,
    write: (record) => { scope.record = record; },
    now: () => new Date().toISOString(),
  };
  return scope;
}

/** Start the lab server with ONE window — "the user's own", which must not move. */
function startLab(): void {
  try { tmux(["kill-server"]); } catch { /* no server yet */ }
  tmux(["new-session", "-d", "-x", "200", "-y", "50", "-s", "lab", "-c", "/tmp", "sleep", "600"]);
}

function windowLines(session: string): string[] {
  return tmux(["list-windows", "-t", session, "-F", "#{window_id}\t#{window_name}"])
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

test("a child lands as a WINDOW of the opener's own session; the user's window is untouched",
  { skip: SKIP }, async () => {
    const scope = labScope();
    try {
      startLab();
      const ownPaneBefore = tmux(["list-panes", "-t", "lab", "-F", "#{pane_id}"]);
      const opened: Array<{ paneId: string; windowId: string }> = [];
      for (let n = 1; n <= 3; n++) {
        const outcome = await openSessionWindow(runner, {
          scope,
          cwd: "/tmp",
          layout: "own-session-window",
          role: { kind: "judge", openerId: "lab", judgeId: `lab-${n}`, role: "reviewer" },
          command: ["sleep", "600"],
          decor: { label: `reviewer@lab-${n}`, colorSeed: `lab-${n}`, state: "working" },
          register: (coords) => {
            assert.ok(coords.windowId, "the factory must record the window id, not only the pane id");
            assert.equal(coords.sessionName, OWN_SESSION);
            opened.push({ paneId: coords.paneId, windowId: coords.windowId });
          },
        });
        assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
      }

      // THE SESSION: named from this session's own identity, and holding one
      // window per child — with the gate's label as the window NAME.
      assert.equal(isOwnSessionName(OWN_SESSION), true, `derived name ${OWN_SESSION} must validate`);
      assert.ok(tmuxOk(["has-session", "-t", OWN_SESSION]), "the session exists after the first child");
      const windows = windowLines(OWN_SESSION);
      assert.equal(windows.length, 3, "three children, three windows");
      assert.deepEqual(
        windows.map((line) => line.split("\t")[1]).sort(),
        ["reviewer@lab-1", "reviewer@lab-2", "reviewer@lab-3"],
        "the window name is the gate's label, so `prefix w` says who is who",
      );
      assert.equal(new Set(opened.map((o) => o.windowId)).size, 3, "each child got its own window");

      // THE USER'S WINDOW: not one pane more than before, and nothing resized
      // or relaid out.
      const ownPaneAfter = tmux(["list-panes", "-t", "lab", "-F", "#{pane_id}"]);
      assert.equal(ownPaneAfter, ownPaneBefore, "the opener's window is exactly as it was");
      assert.equal(ownPaneAfter.split("\n").length, 1, "and it still holds exactly one pane");

      // LIVENESS: the new topology asks the whole server, because the opener's
      // window cannot see these panes at all.
      assert.equal(judgePaneAlive(runner, opened[0]!.paneId), true);

      // CLOSING ONE CHILD: its window goes, the others stay, the session stays.
      const closed = closeSessionWindow(runner, { ownSession: OWN_SESSION, windowId: opened[1]!.windowId });
      assert.equal(closed.ok, true, closed.ok ? "" : closed.error);
      assert.deepEqual(
        windowLines(OWN_SESSION).map((line) => line.split("\t")[0]).sort(),
        [opened[0]!.windowId, opened[2]!.windowId].sort(),
        "exactly the closed window is gone",
      );
      assert.equal(judgePaneAlive(runner, opened[1]!.paneId), false, "its pane is gone with it");
      assert.equal(judgePaneAlive(runner, opened[0]!.paneId), true, "its neighbours are not");
      assert.equal(tmux(["list-panes", "-t", "lab", "-F", "#{pane_id}"]), ownPaneBefore,
        "and closing a child still did not touch the user's window");
    } finally {
      try { tmux(["kill-server"]); } catch { /* already gone */ }
    }
  });

test("the session is LAZY: nothing exists until a child is needed", { skip: SKIP }, async () => {
  const scope = labScope();
  try {
    startLab();
    assert.equal(tmuxOk(["has-session", "-t", OWN_SESSION]), false, "no child yet ⇒ no session");
    assert.deepEqual(tmux(["list-sessions", "-F", "#{session_name}"]).split("\n"), ["lab"],
      "the lab server holds only the opener's window");
    assert.equal(scope.record as TmuxScopeRecord | undefined, undefined, "and nothing was recorded");

    const outcome = await openSessionWindow(runner, {
      scope,
      cwd: "/tmp",
      layout: "own-session-window",
      role: { kind: "judge", openerId: "lab", judgeId: "lab-1", role: "reviewer" },
      command: ["sleep", "600"],
    });
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
    assert.ok(tmuxOk(["has-session", "-t", OWN_SESSION]), "the first child created the session");
    assert.equal(scope.record?.name, OWN_SESSION, "and the sidecar now records it");
    assert.equal(scope.record?.owner, SESSION_ID, "with this session as its owner");
  } finally {
    try { tmux(["kill-server"]); } catch { /* already gone */ }
  }
});

test("the marker decides reuse and the kill: a stranger's session is left alone",
  { skip: SKIP }, async () => {
    const scope = labScope();
    try {
      startLab();
      const first = await openScopeWindow(runner, scope, { cwd: "/tmp", command: ["sleep", "600"] });
      assert.equal(first.ok, true, first.ok ? "" : first.error);
      assert.equal(tmux(["show-options", "-t", OWN_SESSION, "-qv", SESSION_OWNER_OPTION]), SESSION_ID);

      // SOMEBODY ELSE'S SESSION WEARING OUR NAME. The name is derived, so it
      // is reproducible — which is exactly why "mine" has to be a fact rather
      // than a shape: overwrite the marker and the gate must stop.
      tmux(["set", "-t", OWN_SESSION, SESSION_OWNER_OPTION, "some-other-session-id"]);
      const reuse = await openScopeWindow(runner, scope, { cwd: "/tmp", command: ["sleep", "600"] });
      assert.equal(reuse.ok, false, "a name whose marker is not ours is never reused");
      if (!reuse.ok) assert.match(reuse.error, /归属标记/);
      const kill = closeOwnSession(runner, scope);
      assert.equal(kill.ok, false, "and never killed");
      if (!kill.ok) assert.match(kill.error, /归属标记/);
      assert.ok(tmuxOk(["has-session", "-t", OWN_SESSION]), "the stranger's session is still standing");
      assert.equal(windowLines(OWN_SESSION).length, 1, "with nothing added to it");

      // Put OUR marker back: now the same name is ours again, and the kill is
      // scoped to it — the lab session beside it is not touched.
      tmux(["set", "-t", OWN_SESSION, SESSION_OWNER_OPTION, SESSION_ID]);
      const killed = closeOwnSession(runner, scope);
      assert.equal(killed.ok, true, killed.ok ? "" : killed.error);
      assert.equal(killed.ok ? killed.killed : true, true);
      assert.equal(tmuxOk(["has-session", "-t", OWN_SESSION]), false, "our session is gone");
      assert.ok(tmuxOk(["has-session", "-t", "lab"]), "the opener's own session is untouched");
      assert.equal(tmux(["list-panes", "-t", "lab", "-F", "#{pane_id}"]).split("\n").length, 1);

      // IDEMPOTENT: killing it again is a no-op, not an error.
      const again = closeOwnSession(runner, scope);
      assert.equal(again.ok, true);
      assert.equal(again.ok ? again.killed : true, false, "there was nothing left to kill");
    } finally {
      try { tmux(["kill-server"]); } catch { /* already gone */ }
    }
  });

test("never having opened a child means never having a session to close", { skip: SKIP }, async () => {
  try {
    startLab();
    const scope = labScope();
    const result = closeOwnSession(runner, scope);
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.killed : true, false, "nothing to kill, no tmux call wasted");
    assert.deepEqual(tmux(["list-sessions", "-F", "#{session_name}"]).split("\n"), ["lab"]);
  } finally {
    try { tmux(["kill-server"]); } catch { /* already gone */ }
  }
});

test("an unreadable tmux is 'I do not know' — never a licence to create or kill",
  { skip: SKIP }, async () => {
    const scope = labScope();
    scope.record = { name: OWN_SESSION, owner: SESSION_ID, createdAt: new Date().toISOString() };
    const blind: PaneRunner = () => ({ ok: false, stdout: "", stderr: "no server running on /tmp/tmux-0/default" });
    const opened = await openScopeWindow(blind, scope, { cwd: "/tmp", command: ["sleep", "600"] });
    assert.equal(opened.ok, false, "no server ⇒ no session is created");
    const killed = closeOwnSession(blind, scope);
    assert.equal(killed.ok, false, "and nothing is killed on an unknown");
    // `judgePaneAlive` answers the same way: undefined, never "dead".
    assert.equal(judgePaneAlive(blind, "%1"), undefined);
});

/** Read a file the child wrote, once it exists. */
async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${path}`);
}

/**
 * A CHILD'S IDENTITY NEVER ENTERS THE TMUX SESSION ENVIRONMENT (2026-09-25).
 *
 * THE DEFECT THIS PINS, measured in the t5 acceptance round: `new-session -e`
 * writes the child's variables into the SESSION's own environment, so the FIRST
 * child stamped its identity onto the whole session — and every window opened
 * afterwards inherited it. A quality-auditor opened after a worker came up
 * carrying `RG_WORKER_ID`, reported its state into the WORKER's channel file,
 * left its own channel empty, and the opener's boot verification timed out:
 * the round could never complete.
 *
 * Both directions are asserted, because "the environment does not leak" alone
 * would pass just as well if the child never got its environment at all.
 */
test("a child's environment rides its own command, never the tmux session", { skip: SKIP }, async () => {
  const scope = labScope();
  const dir = mkdtempSync(join(tmpdir(), "rg-scope-env-"));
  const dump = join(dir, "dump.mjs");
  // A shell-free probe: tmux joins a multi-element command with spaces, so the
  // quotes of a `sh -c "…"` would be lost. The child writes the variable it was
  // given to the path it was given.
  writeFileSync(
    dump,
    'import { writeFileSync } from "node:fs";\n' +
      'writeFileSync(process.argv[3], String(process.env[process.argv[2]] ?? "<unset>"));\n' +
      // STAY ALIVE: a window whose command exits takes itself (and, as the only
      // window, the whole session) with it, and the second child of this test
      // needs the session to still be there.
      'setTimeout(() => {}, 600000);\n',
    "utf8",
  );
  const firstOut = join(dir, "first.txt");
  const secondOut = join(dir, "second.txt");
  try {
    startLab();
    const first = await openSessionWindow(runner, {
      scope,
      cwd: "/tmp",
      layout: "own-session-window",
      role: { kind: "worker", openerId: "lab", workerId: "worker-1", role: "worker" },
      command: ["node", dump, "RG_WORKER_ID", firstOut],
    });
    assert.equal(first.ok, true, first.ok ? "" : first.error);

    const sessionEnv = tmux(["show-environment", "-t", OWN_SESSION]);
    assert.ok(
      !/RG_WORKER_ID|RG_WORKER_OPENER|RG_GATE_MODE/.test(sessionEnv),
      `the session environment must stay clean — every later window inherits it:\n${sessionEnv}`,
    );
    // …and the child itself really did get the variable.
    assert.equal(await waitForFile(firstOut), "worker-1");

    // A SESSION ALREADY POLLUTED IS HEALED BEFORE IT IS REUSED (quality round
    // P1, 2026-09-25): this is the t5 incident scene — the old build left the
    // first child's identity in the session's OWN environment, and a judge
    // opened afterwards inherited it and reported into the worker's channel.
    tmux(["set-environment", "-t", OWN_SESSION, "RG_WORKER_ID", "worker-5"]);
    tmux(["set-environment", "-t", OWN_SESSION, "RG_GATE_MODE", "explore"]);
    assert.match(tmux(["show-environment", "-t", OWN_SESSION]), /RG_WORKER_ID=worker-5/,
      "the pollution this half of the test is about must really be there");

    // A SECOND CHILD DOES NOT INHERIT THE FIRST ONE'S IDENTITY.
    const second = await openSessionWindow(runner, {
      scope,
      cwd: "/tmp",
      layout: "own-session-window",
      role: { kind: "judge", openerId: "lab", judgeId: "reviewer-1", role: "reviewer" },
      command: ["node", dump, "RG_WORKER_ID", secondOut],
    });
    assert.equal(second.ok, true, second.ok ? "" : second.error);
    assert.equal(await waitForFile(secondOut), "<unset>",
      "a judge must not come up wearing the worker's identity");
    assert.ok(
      !/RG_WORKER_ID|RG_WORKER_OPENER|RG_GATE_MODE/.test(tmux(["show-environment", "-t", OWN_SESSION])),
      "and the second child did not put one there either",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    try { tmux(["kill-server"]); } catch { /* already gone */ }
  }
});
