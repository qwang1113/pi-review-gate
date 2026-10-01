/**
 * THE THIRD WAY TO START THE DAEMON — a session that needs it brings it up.
 *
 * The daemon powers the web panel and the menu bar, and the moment a user
 * notices it is not running is the moment they are in a session with work in
 * hand. So the gate starts it there, in the background, and gets on with the
 * session: {@link ensureDaemonRunning} is fire-and-forget from
 * `lib/session-lifecycle.ts`'s `onSessionStart`, and NOTHING it does may reach
 * the session — no dialog, no throw, no wait on the critical path.
 *
 * ── ONE STARTER, ONE DAEMON ──
 *
 * Three independent callers can want the daemon at the same instant (this
 * session, another session, the user's `pi-gate daemon start`). "Never a
 * second one" is therefore enforced where every one of them goes through:
 * the same `start.lock` (`O_EXCL`, stale holders reclaimable) the CLI uses,
 * claimed BEFORE the spawn and released after — plus a SECOND probe under the
 * lock, because the winner of the lock may have been the one that just brought
 * it up. The lock is claimed after a first probe, so the ordinary case (already
 * online) costs one HTTP request and no lock file at all.
 *
 * `start` in `lib/daemon/cli.ts` delegates here rather than keeping its own
 * copy of the spawn: the same argv shape, the same log file, the same
 * `RG_DAEMON_HOME`, and the same "wait for the port to answer before claiming
 * success" — two implementations of that would drift, and the drift would look
 * like a daemon that starts from one entry point and not the other.
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { pidAlive } from "../session-registry.ts";
import { probeDaemon, type DaemonProbe } from "../daemon-presence.ts";
import { DAEMON_DEFAULT_PORT, daemonHome, daemonLogPath, daemonUserHome } from "./paths.ts";
import type { DaemonState } from "./state.ts";

/** How long a start lock may live before anybody may take it over. */
export const START_LOCK_STALE_MS = 30_000;

/** How long a starter waits for the port to answer before calling it a failure. */
export const START_WAIT_MS = 10_000;

/** How often that wait re-probes. */
const START_POLL_MS = 200;

/**
 * Create the start lock, or take over one whose owner is gone.
 *
 * A live holder that is still fresh wins; anything else (its starter died, or
 * the file outlived any start it could belong to) is reclaimed rather than left
 * to block every future start.
 */
export function claimStartLock(lockPath: string, now: number = Date.now()): boolean {
  const body = `${process.pid} ${now}`;
  try {
    writeFileSync(lockPath, body, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    // Somebody holds it — take it over only when that is provably stale.
  }
  let holder: number | undefined;
  let heldAt: number | undefined;
  try {
    const [pid, at] = readFileSync(lockPath, "utf8").trim().split(" ");
    holder = Number(pid);
    heldAt = Number(at);
  } catch {
    return false;
  }
  const alive = holder !== undefined && Number.isInteger(holder) && pidAlive(holder);
  const fresh = heldAt !== undefined && Number.isFinite(heldAt) && now - heldAt < START_LOCK_STALE_MS;
  if (alive && fresh) return false;
  try {
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, body, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false; // another starter won the takeover race
  }
}

/**
 * BRING IT UP WITHOUT WAITING — for a caller that must not be delayed by it.
 *
 * `session_start` is the caller (lib/session-lifecycle.ts): the daemon takes a
 * second or so to bind, and the session has work to do. The outcome goes to the
 * caller's log, and a rejection is dropped — autostart itself does not throw,
 * and this line makes sure a future change to that cannot turn "the daemon did
 * not start" into "the session broke".
 *
 * `deps` exists for the same reason every other injection in this file does:
 * the test that pins "it never throws" must not be able to start a real daemon
 * on the machine running the suite.
 */
export function ensureDaemonInBackground(log?: (text: string) => void, deps: AutostartDeps = {}): void {
  void ensureDaemonRunning(deps)
    .then((outcome) => {
      log?.(`review-gate[daemon] ${outcome.status}：${outcome.reason}`);
    })
    .catch((error: unknown) => {
      log?.(`review-gate[daemon] 拉起失败（不影响本会话）：${error instanceof Error ? error.message : String(error)}`);
    });
}

/** `ok` when this machine has a daemon to talk to; the reason is always filled. */
export type AutostartStatus = "online" | "started" | "busy" | "failed";

export interface AutostartOutcome {
  status: AutostartStatus;
  state?: DaemonState;
  reason: string;
}

export interface AutostartDeps {
  /** The daemon's home (`RG_DAEMON_HOME` or `$HOME`). */
  home?: string;
  port?: number;
  workspaceRoots?: readonly string[];
  /** `[node, <entry>]` — how the detached child re-executes the CLI. */
  reexec?: readonly string[];
  /** Budget for "the port answered before I report success". */
  waitMs?: number;
  /** Injected in tests; the default is the real {@link probeDaemon}. */
  probe?: (opts: { home?: string }) => Promise<DaemonProbe>;
  /** Injected in tests so no test spawns a real daemon. */
  spawnDetached?: (spawned: { command: string; args: string[]; home: string }) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The detached daemon: its own process group, its own log, nothing keeping the parent alive. */
function spawnDaemonProcess(spawned: { command: string; args: string[]; home: string }): void {
  const logFd = openSync(daemonLogPath(spawned.home), "a", 0o600);
  try {
    const child = spawn(spawned.command, spawned.args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, RG_DAEMON_HOME: spawned.home },
    });
    child.unref();
  } finally {
    // The CHILD holds its own copy of the descriptor; the parent's copy is
    // closed here because the parent may be a long-lived pi session (the
    // autostart path) and one leaked log fd per session adds up.
    closeSync(logFd);
  }
}

/** Never throws: a probe that failed is "cannot confirm", never "online". */
async function safeProbe(probe: (opts: { home?: string }) => Promise<DaemonProbe>, home: string): Promise<DaemonProbe | undefined> {
  try {
    return await probe({ home });
  } catch {
    return undefined;
  }
}

/**
 * MAKE SURE A DAEMON IS RUNNING — the whole autostart, in one call.
 *
 * Returns what happened instead of throwing, so a caller can log one line and
 * carry on. `reason` is a sentence a human can read in `~/.pi/agent/rg-daemon/`
 * logs or in the CLI's output.
 */
export async function ensureDaemonRunning(deps: AutostartDeps = {}): Promise<AutostartOutcome> {
  const home = deps.home ?? daemonUserHome();
  const probe = deps.probe ?? ((opts: { home?: string }) => probeDaemon(opts));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
  const now = deps.now ?? ((): number => Date.now());
  const waitMs = deps.waitMs ?? START_WAIT_MS;

  const before = await safeProbe(probe, home);
  if (before?.online === true && before.state !== undefined) {
    return { status: "online", state: before.state, reason: `已经在跑（${before.reason}）` };
  }

  const lockPath = join(daemonHome(home), "start.lock");
  try {
    mkdirSync(daemonHome(home), { recursive: true });
  } catch (error) {
    // A home that cannot be created is reported, not guessed at: the spawn
    // below would fail with the same reason, one line later.
    return { status: "failed", reason: `建不出 ${daemonHome(home)}：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!claimStartLock(lockPath, now())) {
    return { status: "busy", reason: "另一个启动已经持有 start.lock（它正在起，或它就是刚起来的那一份）" };
  }
  try {
    // UNDER THE LOCK, LOOK AGAIN: whoever held it before us may be exactly the
    // starter that brought the daemon up in the meantime.
    const underLock = await safeProbe(probe, home);
    if (underLock?.online === true && underLock.state !== undefined) {
      return { status: "online", state: underLock.state, reason: `已经在跑（${underLock.reason}）` };
    }
    // `fileURLToPath`, never `.pathname`: a checkout path with a space or a
    // non-ASCII character comes back percent-encoded from a URL object, and the
    // detached child would then fail to load a file that exists.
    const reexec = deps.reexec ?? [process.execPath, fileURLToPath(new URL("./cli.ts", import.meta.url))];
    const port = deps.port ?? DAEMON_DEFAULT_PORT;
    const roots = deps.workspaceRoots ?? [];
    const args = [...reexec.slice(1), "daemon", "run", "--port", String(port), ...roots.flatMap((root) => ["--workspace-root", root])];
    try {
      (deps.spawnDetached ?? spawnDaemonProcess)({ command: reexec[0]!, args, home });
    } catch (error) {
      return { status: "failed", reason: `启动进程失败：${error instanceof Error ? error.message : String(error)}（日志：${daemonLogPath(home)}）` };
    }
    const deadline = now() + waitMs;
    while (now() < deadline) {
      await sleep(START_POLL_MS);
      const current = await safeProbe(probe, home);
      if (current?.online === true && current.state !== undefined) {
        return { status: "started", state: current.state, reason: `已启动（${current.reason}）` };
      }
    }
    return { status: "failed", reason: `${Math.round(waitMs / 1000)} 秒内没有等到端口应答（日志：${daemonLogPath(home)}）` };
  } finally {
    rmSync(lockPath, { force: true });
  }
}
