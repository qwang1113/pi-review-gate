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
 * question protocol directory, the notification store, and the scheduled-task
 * table + its run ledger (`schedulesPath` / `scheduleRunsPath`).
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

/**
 * The agent-home override: `RG_DAEMON_HOME` beats `$HOME`.
 *
 * It exists for the tests (one scratch home per daemon) and for a user who
 * keeps their agent files outside `$HOME` — and it has to be ONE name, read in
 * one place: the CLI resolves it, the detached child inherits it, and the
 * notification probe must look at the same home the CLI just started.
 */
export const DAEMON_HOME_ENV = "RG_DAEMON_HOME";

/** The agent home every daemon path below is derived from. */
export function daemonUserHome(env: NodeJS.ProcessEnv = process.env): string {
  return env[DAEMON_HOME_ENV] ?? homedir();
}

/**
 * THE USER HOME — where the things the daemon READS ABOUT OTHERS are written.
 *
 * `daemonUserHome()` above relocates THIS DAEMON's files, and only those. The
 * files the daemon observes belong to other processes, which resolve their own
 * homes from `$HOME`:
 *
 *   - pi writes its transcripts under `<user home>/.pi/agent/sessions`, from
 *     its own agent dir (`PI_CODING_AGENT_DIR` / `TAU_CODING_AGENT_DIR` or
 *     `$HOME/.pi/agent`) — `lib/session-dir.ts` owns that rule in full;
 *   - a gate session registers its `@名字` under
 *     `<user home>/.pi/agent/rg-sessions` (`sessionRegistryRoot()`, which
 *     reads `homedir()`).
 *
 * Neither knows `RG_DAEMON_HOME` exists, so a daemon that looked for them under
 * its OWN home found nothing at all under the documented override — every
 * session with `transcript: null` / `gateStateFound: false`, and a scheduled
 * run that could only ever settle as `gone` (t6 acceptance, 2026-10-02). One
 * reader, one writer, same home.
 *
 * The pending-question protocol is the OPPOSITE case on purpose and is not
 * covered here: its writer is a gate session, which is TOLD the daemon's home
 * through `RG_DAEMON_HOME` (`lib/daemon/control.ts` injects it at launch), so
 * both sides resolve that one from `daemonHome()`.
 */
export function userHome(): string {
  return homedir();
}

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

/**
 * The menu bar app's heartbeat (`~/.pi/agent/rg-daemon/menubar.json`).
 *
 * It answers the one question the terminal notifier cannot answer any other
 * way: is the app that owns every banner actually RUNNING? The app writes it
 * every few seconds while it lives; `lib/daemon-presence.ts` reads it before
 * the terminal side agrees to stay silent (see `docs/daemon/api.md` §8.1).
 *
 * Not a secret and not a state record: nothing but "the app is alive as of".
 */
export function menubarPresencePath(home: string = homedir()): string {
  return join(daemonHome(home), "menubar.json");
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

/**
 * The notification ledger — a DIRECTORY (per-key claim files + an append-only
 * history), not one JSON document: see lib/daemon/events.ts for why one file
 * could not be written by two processes without losing an entry.
 */
export function notificationStorePath(home: string = homedir()): string {
  return join(daemonHome(home), "notifications");
}

/**
 * The scheduled-task table (0600): what the scheduler should run.
 *
 * One JSON document — `{schema, version, tasks}` — read and rewritten by the
 * daemon, by a gate session's `schedule_task` tool and by the panel, so its
 * shape and its version rule live in one module (`lib/schedule-store.ts`);
 * this path is here because every daemon-owned file is named in one place.
 */
export function schedulesPath(home: string = homedir()): string {
  return join(daemonHome(home), "schedules.json");
}

/**
 * The scheduled-run ledger (0600, append-only JSONL): what actually ran.
 *
 * Separate from the table on purpose — only the daemon's tick appends to it
 * and nothing ever rewrites it, so a run that started while another one settled
 * cannot lose an entry, and a reader can read the file while it is being
 * appended to. The record shapes are `ScheduleRunRecord` in
 * `lib/schedule-store.ts`.
 */
export function scheduleRunsPath(home: string = homedir()): string {
  return join(daemonHome(home), "schedule-runs.jsonl");
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
