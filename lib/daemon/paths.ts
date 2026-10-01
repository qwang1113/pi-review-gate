/**
 * WHERE THE DAEMON KEEPS ITS THINGS — every path in one place.
 *
 * The daemon is a NODE PROCESS, not a pi extension: it runs outside a session's
 * runtime, has no `ctx`, no tool host and no session-scoped sidecar. What it
 * does share with the gate is the agent home, and each file it keeps there is
 * named here so that a test can point the whole daemon at a scratch directory
 * by passing a different `home` — no environment variable, no global.
 *
 * Two files hold the daemon's own identity, and the split is deliberate:
 *
 *   ~/.pi/agent/rg-daemon.json   0600  pid / port / startedAt — the PUBLIC half,
 *                                      read by anything that wants to find it
 *   ~/.pi/agent/rg-daemon.token  0600  the shared secret — never in the state
 *                                      file, never in a log, never echoed
 *
 * Everything else lives under `~/.pi/agent/rg-daemon/`: the log, the daemon's
 * own persistent identity (used to derive its tmux scope session), the answered
 * question protocol directory and the notification store.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Shape version of the state file and of the HTTP payloads that carry it. */
export const DAEMON_SCHEMA = 1;

/** The port the daemon listens on unless `--port` says otherwise. */
export const DAEMON_DEFAULT_PORT = 4597;

/** Only ever loopback. A second interface is not a configuration, it is a bug. */
export const DAEMON_HOST = "127.0.0.1";

/** How long the online probe waits for `/api/health` before calling it offline. */
export const DAEMON_PROBE_TIMEOUT_MS = 1_000;

/** A session id used as a path segment must not be able to leave its directory. */
const SAFE_ID = /^(?!.*\.\.)[A-Za-z0-9._-]{1,128}$/;

/** `undefined` when `value` is a session id that is safe to use as a path segment. */
export function sessionIdProblem(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw.length === 0) return "session id 不能为空";
  if (!SAFE_ID.test(raw)) return `session id 只能含 [A-Za-z0-9._-]（不能有 ..）：${JSON.stringify(raw)}`;
  return undefined;
}

export function daemonAgentHome(home: string = homedir()): string {
  return join(home, ".pi", "agent");
}

/** The daemon's own directory: log, identity, questions, notification store. */
export function daemonHome(home: string = homedir()): string {
  return join(daemonAgentHome(home), "rg-daemon");
}

/** The public half of the daemon's identity (0600; never the token). */
export function daemonStatePath(home: string = homedir()): string {
  return join(daemonAgentHome(home), "rg-daemon.json");
}

/** The shared secret (0600). Read by the CLI and by every consumer that must authenticate. */
export function daemonTokenPath(home: string = homedir()): string {
  return join(daemonAgentHome(home), "rg-daemon.token");
}

/** Where a foreground/daemonized process writes its stdout + stderr. */
export function daemonLogPath(home: string = homedir()): string {
  return join(daemonHome(home), "daemon.log");
}

/**
 * The daemon's OWN persistent session id — the handle its tmux scope session is
 * derived from (`rg-<repo>-<tail>`, lib/session-tmux-scope.ts). It survives a
 * restart so a restart inherits the same scope session instead of leaving one
 * behind, and it is a plain id, not a pi session id.
 */
export function daemonIdentityPath(home: string = homedir()): string {
  return join(daemonHome(home), "identity");
}

/** Root of the pending-question protocol (see docs/daemon/api.md). */
export function questionsRoot(home: string = homedir()): string {
  return join(daemonHome(home), "questions");
}

export function sessionQuestionsDir(home: string, sessionId: string): string {
  return join(questionsRoot(home), sessionId);
}

export function questionPath(home: string, sessionId: string, requestId: string): string {
  return join(sessionQuestionsDir(home, sessionId), `${requestId}.json`);
}

export function questionAnswerPath(home: string, sessionId: string, requestId: string): string {
  return join(sessionQuestionsDir(home, sessionId), `${requestId}.answer.json`);
}

/** The notification history / dedupe store (a consumer asks "was this already sent?"). */
export function notificationStorePath(home: string = homedir()): string {
  return join(daemonHome(home), "notifications.json");
}

export function daemonBaseUrl(port: number, host: string = DAEMON_HOST): string {
  return `http://${host}:${port}`;
}

/**
 * This package's version, read from the package root rather than hard-coded so
 * the state file cannot claim a version the running code is not.
 */
export function daemonPackageVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
