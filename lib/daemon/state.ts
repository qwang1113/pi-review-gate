/**
 * THE DAEMON'S OWN IDENTITY — its state file and its token.
 *
 * ── WHY THE TOKEN IS NOT IN THE STATE FILE ──
 *
 * The state file is the DISCOVERY record: pid, port, startedAt — the things a
 * consumer, a `status` command and a human all need. The token is the shared
 * secret that guards every `/api/*` call. Putting it in the discovery record
 * would mean anything that reads the port (a `cat`, a log, a bug report, a
 * screen) also reads the secret, so it lives in its own 0600 file and only a
 * caller that already knows where to look can read it.
 *
 * ── AND THE ONE ONLINE RULE ──
 *
 * It no longer lives here (menubar-and-boot, 2026-10-01): the record's SHAPE is
 * this module's business, the QUESTION "is it online" is
 * `lib/daemon-presence.ts`'s, and it is answered there twice (async for the
 * CLI, synchronous for the notification path) by ONE rule. Nothing in this
 * file probes anything.
 */

import { readFileSync, rmSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";

import { writeFileAtomic } from "../atomic-write.ts";
import { pidAlive } from "../session-registry.ts";
import {
  DAEMON_HOST,
  DAEMON_SCHEMA,
  daemonBaseUrl,
  daemonIdentityPath,
  daemonPackageVersion,
  daemonStatePath,
  daemonTokenPath,
} from "./paths.ts";
/** The public half of the daemon's identity, as it sits on disk. */
export interface DaemonState {
  schema: typeof DAEMON_SCHEMA;
  pid: number;
  port: number;
  /** ISO. */
  startedAt: string;
  version: string;
  baseUrl: string;
  /** Where the token lives — a POINTER, never the secret itself. */
  tokenFile: string;
  /**
   * Board roots the daemon was started with (`--workspace-root`): the places
   * `GET /api/repos` expands into candidate repositories. Absent means none
   * were given, which is not an error — the running sessions' own repos are
   * still offered.
   */
  workspaceRoots?: string[];
}
/**
 * Write a file only its owner can read, atomically.
 *
 * The plain `writeFileAtomic` carries the TARGET's permissions across the swap,
 * which is not enough for a file that must never be readable by another user:
 * the target may not exist yet (created at the process umask, 0644), and a
 * reader tailing the directory could open the token between the write and the
 * rename. Enforcing the mode is exactly what `writeFileAtomic`'s `opts.mode`
 * does — this is a name for that fact, not a second implementation of it
 * (quality round P2, 2026-10-01).
 */
const writePrivate = (path: string, text: string): void => writeFileAtomic(path, text, { mode: 0o600 });

const parseState = (raw: unknown): DaemonState | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const pid = typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : undefined;
  const port = typeof value.port === "number" && Number.isInteger(value.port) && value.port > 0 && value.port < 65536
    ? value.port
    : undefined;
  const startedAt = typeof value.startedAt === "string" ? value.startedAt.trim() : "";
  const version = typeof value.version === "string" ? value.version : "";
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
  const tokenFile = typeof value.tokenFile === "string" ? value.tokenFile.trim() : "";
  if (value.schema !== DAEMON_SCHEMA || pid === undefined || port === undefined || !startedAt || !baseUrl || !tokenFile) {
    return undefined;
  }
  const workspaceRoots = Array.isArray(value.workspaceRoots)
    ? value.workspaceRoots.filter((root): root is string => typeof root === "string" && root.trim() !== "")
    : undefined;
  return {
    schema: DAEMON_SCHEMA,
    pid,
    port,
    startedAt,
    version,
    baseUrl,
    tokenFile,
    ...(workspaceRoots === undefined ? {} : { workspaceRoots }),
  };
};

/** The state file, or undefined when it is absent, unreadable or malformed. */
export function readDaemonState(home?: string): DaemonState | undefined {
  try {
    return parseState(JSON.parse(readFileSync(daemonStatePath(home), "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * What a fresh state record is built from.
 *
 * AN OBJECT, not four positional parameters (quality round P2, 2026-10-01):
 * `home` and the `home` passed to `writeDaemonState` are two spellings of the
 * same value that must agree, and a call site that repeats it twice silently
 * falls back to `$HOME` the moment one of them is dropped — which is exactly
 * the bug (a `tokenFile` pointing at another home) this fixes.
 */
export interface DaemonStateInit {
  port: number;
  now?: number;
  workspaceRoots?: readonly string[];
  /** The agent home this daemon actually uses; `tokenFile` follows it. */
  home?: string;
}

export function buildDaemonState(init: DaemonStateInit): DaemonState {
  const now = init.now ?? Date.now();
  const workspaceRoots = init.workspaceRoots ?? [];
  return {
    schema: DAEMON_SCHEMA,
    pid: process.pid,
    port: init.port,
    startedAt: new Date(now).toISOString(),
    version: daemonPackageVersion(),
    baseUrl: daemonBaseUrl(init.port),
    tokenFile: daemonTokenPath(init.home),
    ...(workspaceRoots.length === 0 ? {} : { workspaceRoots: [...workspaceRoots] }),
  };
}

export function writeDaemonState(state: DaemonState, home?: string): void {
  writePrivate(daemonStatePath(home), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Remove the state file, but ONLY when it still describes `pid`.
 *
 * A stop that raced a fresh start must not delete the new daemon's record —
 * the comparison is what makes the removal safe without a lock.
 */
export function clearDaemonState(pid: number, home?: string): boolean {
  const current = readDaemonState(home);
  if (current === undefined || current.pid !== pid) return false;
  try {
    rmSync(daemonStatePath(home), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** The token, or undefined when it has not been minted (or cannot be read). */
export function readDaemonToken(home?: string): string | undefined {
  try {
    const raw = readFileSync(daemonTokenPath(home), "utf8").trim();
    return raw.length === 0 ? undefined : raw;
  } catch {
    return undefined;
  }
}

/**
 * The token for THIS daemon: the existing one when there is one, a fresh
 * 32-byte one otherwise.
 *
 * Reusing an existing token is what lets a CLI invocation that started the
 * daemon, a menu-bar app that started it yesterday and a browser tab that
 * loaded a URL all keep working across a restart. Rotating on every start
 * would invalidate every consumer for no gain on a loopback-only socket whose
 * file is already 0600.
 */
export function ensureDaemonToken(home?: string): { token: string; created: boolean } {
  const existing = readDaemonToken(home);
  if (existing !== undefined) return { token: existing, created: false };
  const token = randomBytes(32).toString("base64url");
  writePrivate(daemonTokenPath(home), `${token}\n`);
  return { token, created: true };
}

/** Constant-time comparison; a length mismatch is false without touching the bytes. */
export function tokenMatches(provided: unknown, expected: string | undefined): boolean {
  if (expected === undefined || expected.length === 0) return false;
  const given = typeof provided === "string" ? provided : "";
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** The daemon's own persistent handle, minted on first use. */
export function ensureDaemonIdentity(home?: string): string {
  const path = daemonIdentityPath(home);
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (/^daemon-[a-z0-9]{6,32}$/.test(raw)) return raw;
  } catch { /* mint one below */ }
  const id = `daemon-${randomBytes(5).toString("hex")}`;
  writePrivate(path, `${id}\n`);
  return id;
}

// THE ONLINE PROBE USED TO LIVE HERE. It is `lib/daemon-presence.ts` since
// 2026-10-01 (menubar-and-boot): the record's shape is this file's business,
// the question "is it online" is answered there — twice (async for the CLI,
// synchronous for the notification path) by ONE rule, so the terminal notifier
// and `pi-gate daemon status` can never disagree about what online means.

/** A human-readable one-liner for `status` and for a consumer's log. */
export function describeDaemonState(state: DaemonState): string {
  return `pid=${state.pid} port=${state.port} version=${state.version} startedAt=${state.startedAt} (${DAEMON_HOST})`;
}