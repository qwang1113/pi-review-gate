/**
 * A session that ends WITHOUT declare_done still closes its own tmux session
 * (t4, 2026-09-26): /quit used to leave its worker window running forever.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { TmuxRunner } from "../lib/orchestrator-tmux.ts";
import { deriveSessionName, type TmuxScope } from "../lib/session-tmux-scope.ts";
import { closeOwnSessionOnExit } from "../lib/session-scope-exit.ts";
import { createSessionLifecycle, type SessionLifecycleDeps } from "../lib/session-lifecycle.ts";
import type { SessionCells } from "../lib/session-cells.ts";

const ID = "01a0da79-71e5-7311-9987-4a423c94525a";
const NAME = deriveSessionName("/tmp/t10-accept", ID)!;

function scope(recorded = true): TmuxScope {
  return {
    sessionId: () => ID,
    repoRoot: () => "/tmp/t10-accept",
    read: () => (recorded ? { name: NAME, owner: ID, createdAt: "2026-09-26T00:00:00Z" } : undefined),
    write: () => {},
    now: () => "2026-09-26T00:00:00Z",
  };
}

function server(owner = ID): { run: TmuxRunner; sessions: Set<string>; kills: number } {
  const state = { sessions: new Set([NAME]), kills: 0 };
  const run: TmuxRunner = (argv) => {
    if (argv[0] === "list-sessions") return { ok: true, stdout: [...state.sessions].join("\n"), stderr: "" };
    if (argv[0] === "show-options") return { ok: true, stdout: `${owner}\n`, stderr: "" };
    if (argv[0] === "kill-session") {
      state.kills += 1;
      state.sessions.delete(String(argv[argv.indexOf("-t") + 1]));
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  return Object.assign(state, { run });
}

const plain = { handedOff: false, openChildren: 0 };

test("an ordinary exit kills the session it created, and a second call is a no-op", () => {
  const tmux = server();
  assert.equal(closeOwnSessionOnExit(tmux.run, scope(), plain).closed, true);
  assert.equal(tmux.sessions.has(NAME), false);
  assert.equal(closeOwnSessionOnExit(tmux.run, scope(), plain).closed, false, "shutdown then exit: idempotent");
  assert.equal(tmux.kills, 1);
});

test("a handed-off session and a manager with open children keep the session", () => {
  const tmux = server();
  assert.equal(closeOwnSessionOnExit(tmux.run, scope(), { handedOff: true, openChildren: 0 }).closed, false);
  assert.equal(closeOwnSessionOnExit(tmux.run, scope(), { handedOff: false, openChildren: 2 }).closed, false);
  assert.equal(tmux.kills, 0);
});

test("no record, or a marker that is not ours, kills nothing", () => {
  const unrecorded = server();
  assert.equal(closeOwnSessionOnExit(unrecorded.run, scope(false), plain).closed, false);
  const foreign = server("someone-else");
  assert.equal(closeOwnSessionOnExit(foreign.run, scope(), plain).closed, false);
  assert.equal(unrecorded.kills + foreign.kills, 0);
});

test("the pane state starts before the non-git short-circuit, so every pi session reports (s1)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/session-lifecycle.ts", import.meta.url), "utf8");
  const start = src.indexOf("deps.runtime().startPaneState();");
  const nonGit = src.indexOf("if (!cells.sessionInGit) {");
  assert.ok(start > 0 && nonGit > 0 && start < nonGit);
});

test("session_shutdown closes the scope on quit, never on reload", () => {
  let closes = 0;
  const noop = () => {};
  const deps = {
    notify: { startHint: () => "", markCleanShutdown: noop },
    cancelChildWaitTimer: noop,
    disarmUiRefreshTimer: noop,
    runtime: () => ({ stopSupervisionTimer: noop, stopRevivalTimer: noop, startSessionNamingHeartbeat: noop, stopSessionNamingHeartbeat: noop, startPaneState: noop }),
    stopChildHeartbeat: noop,
    releaseWorktree: noop,
    stopExclusivityRecheck: noop,
    naming: { onSessionStart: () => ({ sweep: { reaped: [] } }), release: noop },
    closeScopeOnExit: () => { closes += 1; },
    log: noop,
  } as unknown as SessionLifecycleDeps;
  const cells = { lastUiCtx: { current: undefined } } as unknown as SessionCells;
  const lifecycle = createSessionLifecycle(cells, deps);
  lifecycle.onSessionShutdown({ type: "session_shutdown", reason: "reload" } as never);
  assert.equal(closes, 0);
  lifecycle.onSessionShutdown({ type: "session_shutdown", reason: "quit" } as never);
  assert.equal(closes, 1);
});
