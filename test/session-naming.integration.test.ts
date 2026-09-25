/**
 * NAMING, RELEASING AND THE ORPHAN SWEEP, MEASURED AGAINST A REAL TMUX.
 *
 * The unit tests pin what the modules DECIDE (with a fake server, so the races
 * and the fail-closed branches can be reached at all). This file pins what tmux
 * actually DOES with the argv — and those are exactly the facts the feature
 * rests on:
 *
 *   - `rename-window` + `set -w @rg_session_name` really land on the session's
 *     OWN window, and `set -wu` really removes the option (so the status line
 *     falls back to the user's own format — no stale name on a dead window);
 *   - the conditional format really expands to「目录名 · 会话名」on a named
 *     window and to the plain directory on an unnamed one — the two branches are
 *     what the user's `~/.tmux.conf` now contains;
 *   - the sweep really kills the tmux session a dead holder left behind, and
 *     really leaves one whose `@rg_scope_owner` marker is not that holder's.
 *
 * It drives the PRODUCTION functions (`createSessionNaming`, `sweepOrphans`,
 * `installTmuxStatusFormat`) against its own throwaway tmux server
 * (`-L rg-name-lab-<pid>`), and never touches the user's server. No tmux ⇒
 * skipped, not failed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionNaming } from "../lib/session-name-tools.ts";
import {
  nodeRegistryIO,
  sessionEntryPath,
  sessionInboxPath,
  type RegistryDeps,
  type RegistryTmuxResult,
} from "../lib/session-registry.ts";
import { sweepOrphans } from "../lib/session-orphan-sweep.ts";
import { SESSION_OWNER_OPTION, assertSafeTmuxArgv } from "../lib/orchestrator-tmux.ts";
import { installTmuxStatusFormat, TMUX_STATUS_CONDITIONAL } from "../scripts/tmux-status-format.mjs";

const SOCKET = `rg-name-lab-${process.pid}`;
const MINE = "019fbb1d-9e78-7ebf-88bf-d104b8a270ed";
const DEAD = "019fbb1d-9e78-7ebf-88bf-dead00000000";
const DEAD_SCOPE = "rg-pi-review-gate-dead000000";

function tmuxInstalled(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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

/** The runner the modules get: every argv executed on the throwaway server. */
function runner(argv: readonly string[]): RegistryTmuxResult {
  try {
    const stdout = execFileSync("tmux", ["-L", SOCKET, ...argv], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: String(stdout ?? ""), stderr: "" };
  } catch (error) {
    const e = error as { stderr?: string | Buffer; message?: string };
    return { ok: false, stdout: "", stderr: String(e.stderr ?? e.message ?? "tmux failed") };
  }
}

/**
 * The runner the EXTENSION would give the sweep: the same guard, applied before
 * tmux ever sees the argv (`ownSessions` = this session's own, plus whatever the
 * caller proved — the dead session's name, for the kill). WITHOUT this the
 * integration test would prove the sweep works only for an unguarded executor,
 * which is not the one it runs under (reviewer round 1 asked exactly that).
 */
function guardedRunner(own: readonly string[]) {
  return (argv: readonly string[], extra?: readonly string[]): RegistryTmuxResult => {
    try {
      assertSafeTmuxArgv(argv, { ownSessions: [...own, ...(extra ?? [])] });
    } catch (error) {
      return { ok: false, stdout: "", stderr: (error as Error).message };
    }
    return runner(argv);
  };
}

function sweepDeps(root: string): RegistryDeps {
  // `rg-my-own-session-00000000` stands in for the SWEEPING session's own
  // dedicated session: the marker read needs no declaration, and the kill of the
  // dead one carries its own name through the sweep's second argument.
  return { root, io: nodeRegistryIO(root), runTmux: guardedRunner(["rg-my-own-session-00000000"]), alive: () => false, now: () => Date.now() };
}

/** The tool the runtime registered, so the test calls what an agent calls. */
function toolOf(naming: ReturnType<typeof createSessionNaming>) {
  let tool: { execute: (id: string, params: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }> } | undefined;
  naming.register({ registerTool: (spec: unknown) => { tool = spec as typeof tool; } } as never);
  if (!tool) throw new Error("name_session was not registered");
  return tool;
}

const skip = tmuxInstalled() ? false : "tmux is not installed";

test("naming a session really renames its window and writes the option the status line reads", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rg-name-root-"));
  try {
    const pane = tmux(["new-session", "-d", "-s", "lab", "-n", "lab-original", "-c", tmpdir(), "-P", "-F", "#{pane_id}"]);
    const panePath = tmux(["display-message", "-p", "-t", pane, "#{b:pane_current_path}"]);
    assert.equal(tmux(["display-message", "-p", "-t", pane, "#{window_name}"]), "lab-original");

    const naming = createSessionNaming({
      root,
      io: nodeRegistryIO(root),
      runTmux: runner,
      sessionId: () => MINE,
      ownPane: () => pane,
      repoRoot: () => "/repo/pi-review-gate",
      cwd: () => "/repo/pi-review-gate",
      mode: () => "loop",
      state: () => "working",
      scopeSession: () => DEAD_SCOPE,
    });

    const reply = await toolOf(naming).execute("id", { name: "lab-registry" });
    assert.notEqual(reply.isError, true);
    // 1. THE WINDOW — tmux's own answer, never the module's bookkeeping.
    assert.equal(tmux(["display-message", "-p", "-t", pane, "#{window_name}"]), "lab-registry");
    assert.equal(tmux(["show-options", "-w", "-t", pane, "-qv", "@rg_session_name"]), "lab-registry");
    // 2. THE REGISTRY — bound to this session, holding tmux's own coordinates.
    const entry = JSON.parse(readFileSync(sessionEntryPath(root, "lab-registry"), "utf8"));
    assert.equal(entry.sessionId, MINE);
    assert.equal(entry.tmux.pane, pane);
    assert.equal(entry.tmux.window, tmux(["display-message", "-p", "-t", pane, "#{window_id}"]));
    assert.equal(entry.scopeSession, DEAD_SCOPE);
    // 3. THE STATUS LINE renders both branches from what the window carries
    //    right now — the very expression the user's conf installs.
    tmux(["set", "-g", "window-status-format", TMUX_STATUS_CONDITIONAL]);
    assert.equal(tmux(["display-message", "-p", "-t", pane, "#{E:window-status-format}"]), `${panePath} · lab-registry`);
    tmux(["set", "-wu", "-t", pane, "@rg_session_name"]);
    assert.equal(tmux(["display-message", "-p", "-t", pane, "#{E:window-status-format}"]), panePath,
      "an unnamed window renders exactly the directory, as before");
    tmux(["set", "-w", "-t", pane, "@rg_session_name", "lab-registry"]);
    // 4. AND THE RELEASE PUTS IT BACK: title restored, option gone, entry gone.
    assert.deepEqual(naming.release(), { released: true, name: "lab-registry" });
    assert.equal(tmux(["display-message", "-p", "-t", pane, "#{window_name}"]), "lab-original");
    assert.equal(tmux(["show-options", "-w", "-t", pane, "-qv", "@rg_session_name"]), "");
    assert.equal(tmux(["display-message", "-p", "-t", pane, "#{E:window-status-format}"]), panePath);
    assert.equal(existsSync(sessionEntryPath(root, "lab-registry")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    tmuxOk(["kill-server"]);
  }
});

test("the installed conf line is what the user's tmux will render, on a real server", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-name-conf-"));
  try {
    const confPath = join(dir, ".tmux.conf");
    writeFileSync(confPath, 'set -g window-status-format "#[fg=black]#{b:pane_current_path} "\n', "utf8");
    const result = installTmuxStatusFormat({ confPath, stamp: "lab", log: () => {} });
    assert.equal(result.status, "rewritten");
    const pane = tmux(["new-session", "-d", "-s", "lab", "-c", tmpdir(), "-P", "-F", "#{pane_id}"]);
    const panePath = tmux(["display-message", "-p", "-t", pane, "#{b:pane_current_path}"]);
    // Source the file the installer produced: the rendering below is therefore
    // an answer about INSTALLED bytes, not about a format string typed here.
    tmux(["source-file", confPath]);
    // A DELIMITED READING: `display-message -p` trims nothing, but the test's own
    // helper does, and the format's trailing space is part of what is installed.
    assert.equal(tmux(["display-message", "-p", "-t", pane, `|#{E:window-status-format}|`]), `|#[fg=black]${panePath} |`);
    tmux(["set", "-w", "-t", pane, "@rg_session_name", "conf-lab"]);
    assert.equal(tmux(["display-message", "-p", "-t", pane, `|#{E:window-status-format}|`]), `|#[fg=black]${panePath} · conf-lab |`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    tmuxOk(["kill-server"]);
  }
});

test("the sweep really kills what a dead holder left, and never what it cannot prove", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "rg-name-sweep-"));
  try {
    // THIS RUNS UNDER THE PRODUCTION GUARD (see `guardedRunner`): the marker
    // read is unguarded by design, the kill is guarded and declares the name it
    // verified — which is the pair reviewer round 1 doubted.
    // A session the gate would have created for a child, marked as the DEAD
    // session's own, plus a registration that has gone stale with no pid and no
    // pane behind it.
    tmux(["new-session", "-d", "-s", DEAD_SCOPE, "-n", "child", "-c", tmpdir()]);
    tmux(["set", "-t", DEAD_SCOPE, SESSION_OWNER_OPTION, DEAD]);
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    writeFileSync(sessionEntryPath(root, "dead-session"), JSON.stringify({
      schema: 1, name: "dead-session", sessionId: DEAD, pid: 999_999,
      repo: "/repo/pi-review-gate", cwd: "/repo/pi-review-gate", mode: "child", state: "working",
      tmux: { session: "gone", window: "@9999", pane: "%9999" },
      scopeSession: DEAD_SCOPE, registeredAt: stale, heartbeatAt: stale,
    }), "utf8");
    writeFileSync(sessionInboxPath(root, "dead-session"), "{\"from\":\"@someone\"}\n", "utf8");
    // …and one whose marker says the session belongs to somebody else entirely.
    const foreign = `${DEAD_SCOPE}x`;
    tmux(["new-session", "-d", "-s", foreign, "-n", "child", "-c", tmpdir()]);
    tmux(["set", "-t", foreign, SESSION_OWNER_OPTION, "someone-else"]);
    writeFileSync(sessionEntryPath(root, "not-ours"), JSON.stringify({
      schema: 1, name: "not-ours", sessionId: DEAD, pid: 999_999,
      repo: "/repo/pi-review-gate", cwd: "/repo/pi-review-gate", mode: "child", state: "working",
      tmux: { session: "gone", window: "@9998", pane: "%9998" },
      scopeSession: foreign, registeredAt: stale, heartbeatAt: stale,
    }), "utf8");

    const report = sweepOrphans(sweepDeps(root));
    assert.deepEqual(report.reaped.map((r) => r.name), ["dead-session"]);
    assert.equal(report.reaped[0]?.sessionKilled, true);
    // NOT DELETED (2026-09-25, reviewer P1 twice): the sweep frees the name and
    // deliberately leaves the mail — a fresh session may claim the name and be
    // sent a message before any cleanup could run.
    // tmux's own answer: the dead session is gone, the foreign one is untouched.
    // Read as a LIST, not with `has-session -t <name>`: tmux resolves a session
    // target by prefix when the exact name is absent (measured on 3.7c: with only
    // `…dead000000x` left, `has-session -t …dead000000` answers YES), so the
    // question "is this exact session still there" has to be asked of the list.
    assert.deepEqual(tmux(["list-sessions", "-F", "#{session_name}"]).split("\n"), [foreign]);
    assert.equal(existsSync(sessionInboxPath(root, "dead-session")), true, "its mail stays — nobody deletes another session's inbox");
    assert.match(report.kept.find((k) => k.name === "not-ours")?.reason ?? "", /归属标记是 someone-else/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    tmuxOk(["kill-server"]);
  }
});
