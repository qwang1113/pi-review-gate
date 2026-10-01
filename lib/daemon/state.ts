/**
 * THE DAEMON'S OWN IDENTITY — its state file, its token, and the ONE rule that
 * answers "is the daemon online".
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
 * ── AND THE ONE ONLINE RULE (frozen in docs/daemon/api.md) ──
 *
 *   state file parses (§schema 1)  AND  its pid is alive  AND
 *   `GET /api/health` answers 200 within {@link DAEMON_PROBE_TIMEOUT_MS}
 *
 * All three, or "not online". A timeout or a connection refusal means exactly
 * one thing — *the daemon cannot be confirmed online* — and it never means "the
 * process is dead": that is why nothing here kills a pid or deletes a state
 * file. The terminal notifier keeps sending while a menu-bar sender holds back,
 * so a probe that says "offline" must stay the conservative reading.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";

import { pidAlive } from "../session-registry.ts";
import {
  DAEMON_HOST,
  DAEMON_PROBE_TIMEOUT_MS,
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
 * The plain `writeFileAtomic` leaves the temporary sibling at the process
 * umask (0644), so a reader tailing the directory could open the token between
 * the write and the rename. The mode is set on the temp file and the rename
 * carries the inode, so no window ever exposes it.
 */
export function writePrivateFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* the rename already carried 0600 */ }
}

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

export function buildDaemonState(
  port: number,
  now: number = Date.now(),
  workspaceRoots: readonly string[] = [],
  /**
   * The agent home this daemon actually uses. Passed so `tokenFile` POINTS AT
   * THE FILE THAT EXISTS: defaulting to `homedir()` here while the CLI wrote the
   * token under an override produced a state file naming a path nobody had
   * written (reviewer P1, 2026-10-01 — a test-only home made it visible).
   */
  home?: string,
): DaemonState {
  return {
    schema: DAEMON_SCHEMA,
    pid: process.pid,
    port,
    startedAt: new Date(now).toISOString(),
    version: daemonPackageVersion(),
    baseUrl: daemonBaseUrl(port),
    tokenFile: daemonTokenPath(home),
    ...(workspaceRoots.length === 0 ? {} : { workspaceRoots: [...workspaceRoots] }),
  };
}

export function writeDaemonState(state: DaemonState, home?: string): void {
  writePrivateFile(daemonStatePath(home), `${JSON.stringify(state, null, 2)}\n`);
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
  writePrivateFile(daemonTokenPath(home), `${token}\n`);
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
  writePrivateFile(path, `${id}\n`);
  return id;
}

export interface DaemonProbe {
  online: boolean;
  state?: DaemonState;
  /** Always filled: why the answer is what it is (read by `status` and by a log). */
  reason: string;
}

/**
 * The one online rule (see the module header). Never throws, never kills.
 */
export async function probeDaemon(opts: {
  home?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<DaemonProbe> {
  const state = readDaemonState(opts.home);
  if (state === undefined) return { online: false, reason: "state 文件缺失或不是合法的 rg-daemon.json" };
  if (!pidAlive(state.pid)) return { online: false, state, reason: `state 里的 pid ${state.pid} 已不在` };
  const token = readDaemonToken(opts.home);
  if (token === undefined) return { online: false, state, reason: "token 文件缺失或读不出来" };
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    // THE ADDRESS IS OURS, NOT THE FILE'S (reviewer P1, 2026-10-01). `baseUrl`
    // is read out of a file, and this call carries the TOKEN: a tampered or
    // corrupt record pointing at another host would hand the secret to whatever
    // answers there. The daemon only ever listens on loopback, so the rule is
    // computed here — 127.0.0.1 + the recorded port — and the field is treated
    // as a description of where it was started, never as an instruction.
    const url = `${daemonBaseUrl(state.port)}/api/health`;
    const response = await doFetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DAEMON_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return { online: false, state, reason: `健康检查返回 HTTP ${response.status}` };
    return { online: true, state, reason: `在线：pid ${state.pid}，端口 ${state.port}` };
  } catch (error) {
    return {
      online: false,
      state,
      reason: `端口探测失败（${error instanceof Error ? error.message : String(error)}）—— 不能断定在线`,
    };
  }
}

/** A human-readable one-liner for `status` and for a consumer's log. */
export function describeDaemonState(state: DaemonState): string {
  return `pid=${state.pid} port=${state.port} version=${state.version} startedAt=${state.startedAt} (${DAEMON_HOST})`;
}
