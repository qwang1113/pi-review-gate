/**
 * THE ONE EXEC WRAPPER FOR TMUX ARGV — no shell in between, ever.
 *
 * ── WHY IT IS ITS OWN MODULE ──
 *
 * Two very different processes run tmux commands: a pi session's gate
 * (lib/orchestrator-wiring.ts) and the standalone daemon
 * (lib/daemon/control.ts). Each had its own copy of this twenty-line wrapper,
 * line for line the same — and a duplicated exec path is the one place where
 * "the safety door ran" can quietly become "the safety door ran in the other
 * copy". The door itself (`assertSafeTmuxArgv`, lib/orchestrator-tmux.ts) was
 * already shared; this is the half that actually spawns.
 *
 * It lives beside neither caller on purpose: lib/orchestrator-tmux.ts documents
 * itself as a PURE argv builder that never spawns anything, and a module whose
 * header argues it does not spawn is the wrong home for the thing that does.
 *
 * ── WHAT IT GUARANTEES ──
 *
 *  - the door runs FIRST, on every call, with the caller's declaration
 *    ({@link SafeTmuxOptions}); a refusal is returned, never thrown at the
 *    caller;
 *  - `execFileSync` with an argv ARRAY — there is no shell, so nothing in a
 *    window name, a path or a label can be interpreted;
 *  - a bounded timeout, so a wedged server cannot hang the caller;
 *  - every failure is a VALUE (`{ok:false, stderr}`), because all three callers
 *    are in the middle of something that must report rather than crash.
 */

import { execFileSync } from "node:child_process";

import { assertSafeTmuxArgv, type SafeTmuxOptions, type TmuxRunResult, type TmuxRunner } from "./orchestrator-tmux.ts";
import { tmuxServerFrom } from "./hierarchy.ts";

/**
 * THE TMUX SERVER THIS PROCESS TALKS TO, when it is not the default one.
 *
 * WHY AN ENVIRONMENT FACT AND NOT AN ARGUMENT (2026-10-03): the safety door
 * REFUSES a leading global flag from any caller on purpose — `-L sock
 * kill-session …` would otherwise put `-L` where the subcommand belongs and
 * slip the whole check, `kill-server` included. A socket is not a per-command
 * choice anybody makes; it is where this process's tmux lives, exactly like
 * `$TMUX` for a session. So the environment carries it, the exec wrapper adds
 * `-L` itself, and the door keeps refusing callers that pass one.
 *
 * What it is FOR: the daemon and an acceptance run can work on a private
 * server instead of the user's — so a test may destroy its own server without
 * taking the user's (or a judge's) panes with it.
 */
export const TMUX_SOCKET_ENV = "RG_TMUX_SOCKET";

/** A socket name tmux itself accepts: no path, no flag smuggling. */
const TMUX_SOCKET_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** `["-L", name]` for a valid non-default socket, `[]` otherwise. */
export function tmuxSocketArgv(env: NodeJS.ProcessEnv): readonly string[] {
  const name = (env[TMUX_SOCKET_ENV] ?? "").trim();
  return name === "" || !TMUX_SOCKET_NAME.test(name) ? [] : ["-L", name];
}

/** Run one tmux command under the safety door. Never throws. */
export function runTmuxArgv(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  guard: SafeTmuxOptions = {},
): TmuxRunResult {
  try {
    assertSafeTmuxArgv(argv, guard);
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
  try {
    const stdout = execFileSync("tmux", [...tmuxSocketArgv(env), ...argv], {
      encoding: "utf8",
      env,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: String(stdout ?? ""), stderr: "" };
  } catch (error) {
    const failure = error as { stderr?: Buffer | string; message?: string };
    return { ok: false, stdout: "", stderr: String(failure.stderr ?? failure.message ?? "tmux failed") };
  }
}

/**
 * WHICH TMUX SERVER THIS PROCESS IS TALKING TO.
 *
 * The registry records the server that minted a pane id (`<socket>,<server pid>`)
 * and a pane id only means something on THAT server: after a `kill-server` or a
 * reboot the next server hands out the same small numbers again, so a stale
 * entry's `%3` can name a stranger's pane. A pi session reads this from `$TMUX`;
 * a process outside tmux ASKS tmux — `#{pid}` is the server pid, which is exactly
 * the pair `$TMUX` carries.
 *
 * Unreadable ⇒ undefined ⇒ the comparison is skipped, exactly as it is for a
 * session outside tmux (never reclaim, never reject, on missing information).
 */
export function currentTmuxServer(runTmux: TmuxRunner): string | undefined {
  const fromEnv = tmuxServerFrom(process.env);
  if (fromEnv !== undefined) return fromEnv;
  try {
    const result = runTmux(["display-message", "-p", "-F", "#{socket_path},#{pid}"]);
    if (!result.ok) return undefined;
    const value = result.stdout.trim();
    return /^.+,\d+$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
