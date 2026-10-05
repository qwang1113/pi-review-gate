/**
 * THE SOCKET SEAM, AND THE DOOR IN FRONT OF IT (2026-10-03).
 *
 * Why it exists: the daemon and an acceptance run must be able to work on a
 * PRIVATE tmux server, so a test may destroy its own server without taking the
 * user's (or a reviewing judge's) panes with it. It also has a second, measured
 * purpose — the failure mode that ate three scheduled runs on 2026-10-02 was a
 * daemon whose PATH had no tmux, and the machine-side of that is
 * `lib/session-tmux-scope.ts` telling "no server" apart from "no tmux".
 *
 * The rule this file pins down: the socket is an ENVIRONMENT FACT, added by the
 * exec wrapper AFTER the safety door — so a caller still cannot pass a leading
 * global flag, which is how `-L sock kill-server …` would otherwise smuggle
 * `kill-server` past it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { TMUX_SOCKET_ENV, runTmuxArgv, tmuxSocketArgv } from "../lib/tmux-exec.ts";
import { readSessionList, tmuxServerAbsent } from "../lib/session-tmux-scope.ts";

test("only a valid socket name becomes `-L <name>`; anything else is ignored", () => {
  assert.deepEqual(tmuxSocketArgv({}), []);
  assert.deepEqual(tmuxSocketArgv({ [TMUX_SOCKET_ENV]: "   " }), []);
  assert.deepEqual(tmuxSocketArgv({ [TMUX_SOCKET_ENV]: "rg-accept-1" }), ["-L", "rg-accept-1"]);
  // Paths and shell-ish strings never reach argv: a socket is a NAME.
  assert.deepEqual(tmuxSocketArgv({ [TMUX_SOCKET_ENV]: "/tmp/tmux-501/default" }), []);
  assert.deepEqual(tmuxSocketArgv({ [TMUX_SOCKET_ENV]: "a;rm -rf /" }), []);
  assert.deepEqual(tmuxSocketArgv({ [TMUX_SOCKET_ENV]: "x".repeat(65) }), []);
});

test("the door still refuses a caller that passes a global flag itself", () => {
  // The wrapper adds `-L` ITSELF; a caller doing it is still an error, and that
  // is what keeps `kill-server` from riding in behind one.
  const refused = runTmuxArgv(["-L", "rg-accept-test", "kill-server"], { [TMUX_SOCKET_ENV]: "rg-accept-test" });
  assert.equal(refused.ok, false);
  assert.match(refused.stderr, /全局 flag/);
});

test("with RG_TMUX_SOCKET set, a call really lands on that private server", () => {
  // A NAME NOBODY ELSE USES, so this test can never touch the user's server —
  // and it only ever ASKS a question that creates nothing.
  const socket = `rg-accept-test-${process.pid}`;
  const env: NodeJS.ProcessEnv = { ...process.env, [TMUX_SOCKET_ENV]: socket };
  try {
    const reading = readSessionList((argv) => runTmuxArgv(argv, env));
    assert.equal(reading.ok, false, "那个 socket 上没有 server");
    if (!reading.ok) {
      assert.equal(
        tmuxServerAbsent(reading.detail),
        true,
        `没有 server 必须与「tmux 不可用」分得开：${reading.detail}`,
      );
    }
  } finally {
    // Nothing was created (list-sessions never starts a server), but if a server
    // ever were, this removes exactly OURS — never the user's (`kill-server` is
    // refused by the door, so it goes through tmux directly, on our socket only).
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      /* no server on that socket, which is the expected outcome */
    }
  }
});
