/**
 * IS THE DAEMON ONLINE, AND IS ANYBODY HOME TO RAISE THE BANNER? — the two
 * questions the notification decision needs, each answered once.
 *
 * ── QUESTION ONE: THE ONLINE RULE ──
 *
 * `docs/daemon/api.md` §3 freezes what "online" means, and every consumer
 * depends on the SAME answer, because the answer is what decides whether a
 * banner is raised here or on the menu bar:
 *
 *   state file parses (§schema 1)  AND  its pid is alive  AND
 *   `GET http://127.0.0.1:<state.port>/api/health` answers 200 within 1000 ms
 *   with the daemon's token
 *
 * All three, or "not online". A failure to confirm is NOT "the process is
 * dead": nothing here kills a pid or deletes a state file, and the terminal
 * notifier keeps sending whenever the probe cannot confirm the daemon — a
 * probe that answers "offline" must stay the conservative reading, because the
 * other direction (suppressing a banner for a daemon that is not actually
 * there) is a notification nobody ever receives.
 *
 * ── QUESTION TWO: IS THE SENDER RUNNING ──
 *
 * The online rule alone was NOT enough to justify staying silent (quality
 * round P1, 2026-10-01): the banner is raised by the menu bar APP, the daemon
 * is auto-started by every interactive session and the app is not, so after a
 * reboot the default state was "daemon up, app down" — silence from both
 * sides. {@link bannerSenderPresence} reads the app's heartbeat and
 * {@link bannerSenderOnline} is the composed question the terminal notifier
 * asks; anything it cannot confirm answers "send", the recoverable end.
 *
 * ── WHY IT IS HERE AND NOT IN lib/daemon/state.ts ──
 *
 * `state.ts` owns the RECORD (the file's shape, the token, the identity);
 * this module owns the QUESTION. They were one file until the menu-bar task,
 * and splitting them is what lets the SAME rule answer twice without being
 * written twice:
 *
 *   - {@link probeDaemon}    — async, `fetch`, the reason a human reads in
 *                              `pi-gate daemon status`;
 *   - {@link probeDaemonSync} — SYNCHRONOUS, via curl, for the one caller that
 *                              cannot await: `lib/user-notify-runtime.ts`'s
 *                              `notify()` (and the process-exit handler behind
 *                              it), which decides whether the terminal is
 *                              allowed to raise a banner at all.
 *
 * Both gather the same three facts and hand them to {@link judgeDaemonPresence}
 * — the rule itself, written once. The sync path paying for a curl process is
 * deliberate: a CACHED answer would let a success from the past suppress a
 * banner for a daemon that has since died, and the contract is explicit that
 * suppression has to be earned by a probe that just succeeded.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { pidAlive } from "./session-registry.ts";
import { DAEMON_PROBE_TIMEOUT_MS, daemonBaseUrl, daemonUserHome, menubarPresencePath } from "./daemon/paths.ts";
import { readDaemonState, readDaemonToken, type DaemonState } from "./daemon/state.ts";

export interface DaemonProbe {
  online: boolean;
  state?: DaemonState;
  /** Always filled: why the answer is what it is (read by `status` and by a log). */
  reason: string;
}

/** What one attempt at `/api/health` answered. */
export type HealthReading = { ok: true } | { ok: false; reason: string };

/** The three facts the rule reads, in the order it reads them. */
export interface PresenceFacts {
  /** The parsed state record; `undefined` when the file is absent or malformed. */
  state: DaemonState | undefined;
  /** Whether that record's pid is alive. Ignored when there is no record. */
  alive: boolean;
  /** The token, or `undefined` when it could not be read. */
  token: string | undefined;
  /** What the health request answered. Ignored unless the three facts above hold. */
  health: HealthReading;
}

/**
 * THE RULE, over facts somebody else gathered. Pure — every branch is drivable
 * from a test, and neither entry point below can drift from it.
 */
export function judgeDaemonPresence(facts: PresenceFacts): DaemonProbe {
  if (facts.state === undefined) {
    return { online: false, reason: "state 文件缺失或不是合法的 rg-daemon.json" };
  }
  if (!facts.alive) {
    return { online: false, state: facts.state, reason: `state 里的 pid ${facts.state.pid} 已不在` };
  }
  if (facts.token === undefined) {
    return { online: false, state: facts.state, reason: "token 文件缺失或读不出来" };
  }
  if (!facts.health.ok) {
    return { online: false, state: facts.state, reason: facts.health.reason };
  }
  return { online: true, state: facts.state, reason: `在线：pid ${facts.state.pid}，端口 ${facts.state.port}` };
}

/**
 * The record, its pid and the token — gathering only, so the two probes differ
 * in exactly one thing (how they ask the port) and agree on everything else.
 */
function gatherPresenceFacts(home: string | undefined): { state?: DaemonState; alive: boolean; token?: string } {
  const state = readDaemonState(home);
  if (state === undefined) return { alive: false };
  if (!pidAlive(state.pid)) return { state, alive: false };
  const token = readDaemonToken(home);
  return { state, alive: true, ...(token === undefined ? {} : { token }) };
}

/**
 * The health URL is COMPUTED, never read out of the state file.
 *
 * `baseUrl` is a field of a file, and this request carries the token: a
 * tampered or corrupt record pointing at another host would hand the secret to
 * whatever answers there. The daemon only ever listens on loopback, so the
 * address is 127.0.0.1 plus the recorded port, and `baseUrl` stays what it
 * says it is — a description of where the daemon was started.
 */
function healthUrl(state: DaemonState): string {
  return `${daemonBaseUrl(state.port)}/api/health`;
}

/**
 * The online rule, ASYNCHRONOUSLY — the shape `pi-gate daemon status` prints
 * and `start` / `stop` decide on.
 */
export async function probeDaemon(opts: {
  home?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<DaemonProbe> {
  // THE SAME HOME THE SYNC SIDE USES (quality round P1, 2026-10-01): without
  // this line `readDaemonState(undefined)` fell back to `$HOME` and ignored
  // `RG_DAEMON_HOME`, so the two entries could disagree about there being a
  // daemon at all — one answering "online", the other "no state file".
  const home = opts.home ?? daemonUserHome();
  const gathered = gatherPresenceFacts(home);
  if (gathered.state === undefined || !gathered.alive || gathered.token === undefined) {
    // The rule's own early exits, judged with a health reading that is never
    // consulted — so the reason a user reads is the rule's, not this caller's.
    return judgeDaemonPresence({ state: gathered.state, alive: gathered.alive, token: gathered.token, health: { ok: false, reason: "" } });
  }
  const doFetch = opts.fetchImpl ?? fetch;
  let health: HealthReading;
  try {
    const response = await doFetch(healthUrl(gathered.state), {
      headers: { authorization: `Bearer ${gathered.token}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DAEMON_PROBE_TIMEOUT_MS),
    });
    health = response.ok ? { ok: true } : { ok: false, reason: `健康检查返回 HTTP ${response.status}` };
  } catch (error) {
    health = {
      ok: false,
      reason: `端口探测失败（${error instanceof Error ? error.message : String(error)}）—— 不能断定在线`,
    };
  }
  return judgeDaemonPresence({ state: gathered.state, alive: true, token: gathered.token, health });
}

/** How the sync probe asks the port. Injected so no test has to spawn curl. */
export type HealthRunner = (url: string, token: string, timeoutMs: number) => HealthReading;

/** One value, quoted for curl's `--config` format (the token must not reach argv). */
function curlConfigValue(raw: string): string {
  return raw.replace(/[\r\n]/g, "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The health check WITHOUT `fetch`: the macOS system curl, told to read its
 * whole request from stdin.
 *
 * THE TOKEN NEVER REACHES argv: a header passed as an argument is readable in
 * `ps` output by every other process of the same user, and this file's own
 * 0600 says the secret is not for them. `--config -` reads the url and the
 * header from stdin instead, which no process table carries.
 *
 * A MISSING OR BROKEN CURL IS "CANNOT CONFIRM", never an exception: the rule
 * only ever answers offline, and the terminal notifier sends — the direction
 * that ends with the user being told.
 */
function curlHealth(url: string, token: string, timeoutMs: number): HealthReading {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  try {
    const code = execFileSync(
      "/usr/bin/curl",
      ["--silent", "--show-error", "--output", "/dev/null", "--write-out", "%{http_code}", "--max-time", String(seconds), "--config", "-"],
      {
        input: `url = "${curlConfigValue(url)}"\nheader = "Authorization: Bearer ${curlConfigValue(token)}"\n`,
        encoding: "utf8",
        timeout: timeoutMs + 2_000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
    return code === "200" ? { ok: true } : { ok: false, reason: `健康检查返回 HTTP ${code || "无应答"}` };
  } catch (error) {
    const detail = (error as { stderr?: unknown }).stderr;
    const text = typeof detail === "string" && detail.trim() !== "" ? detail.trim() : (error as Error).message;
    return { ok: false, reason: `端口探测失败（${text}）—— 不能断定在线` };
  }
}

/**
 * THE SAME RULE, SYNCHRONOUSLY — for the one decision that cannot await.
 *
 * `notify()` is called from the gate's dialog path and from the `exit`
 * handler, and neither may return a promise: the process may be gone before a
 * fetch resolves. Hence the subprocess — measured on this machine, a curl
 * against a live loopback daemon costs ~10 ms, and it is paid only when a
 * banner was otherwise about to go out (after the mode gate, the throttle and
 * the "is the user looking" check).
 *
 * IT NEVER THROWS. A reader that fails — a missing curl, an exception out of an
 * injected one — is a reading of "cannot confirm", which is the one answer that
 * keeps the terminal notifier sending, and it is the same answer every other
 * failure produces.
 */
export function probeDaemonSync(opts: {
  home?: string;
  timeoutMs?: number;
  health?: HealthRunner;
} = {}): DaemonProbe {
  const home = opts.home ?? daemonUserHome();
  const timeoutMs = opts.timeoutMs ?? DAEMON_PROBE_TIMEOUT_MS;
  const gathered = gatherPresenceFacts(home);
  if (gathered.state === undefined || !gathered.alive || gathered.token === undefined) {
    return judgeDaemonPresence({ state: gathered.state, alive: gathered.alive, token: gathered.token, health: { ok: false, reason: "" } });
  }
  let reading: HealthReading;
  try {
    reading = (opts.health ?? curlHealth)(healthUrl(gathered.state), gathered.token, timeoutMs);
  } catch (error) {
    reading = { ok: false, reason: `端口探测失败（${error instanceof Error ? error.message : String(error)}）—— 不能断定在线` };
  }
  return judgeDaemonPresence({ state: gathered.state, alive: true, token: gathered.token, health: reading });
}

/**
 * How long the menu bar app's heartbeat counts.
 *
 * The app writes one every 5 s (its own refresh timer). Four missed beats is
 * long enough that a busy machine does not drop a banner over a scheduling
 * hiccup, and short enough that a quit app stops suppressing almost at once.
 */
export const MENUBAR_HEARTBEAT_FRESH_MS = 20_000;

export interface BannerSenderPresence {
  present: boolean;
  /** Always filled: the fact behind the answer (logs, and a human debugging a missing banner). */
  reason: string;
}

/**
 * Is the app that owns the banners RUNNING? Answered from its own heartbeat.
 *
 * WHY THIS EXISTS (quality round P1, 2026-10-01): the rule is "one sender at a
 * time", and the terminal side used to suppress on "the daemon is online"
 * alone. Those are different facts — the daemon is auto-started by every
 * interactive session, the menu bar app is not — so after a reboot the DEFAULT
 * state was "daemon up, app down": the terminal kept silent and the app was
 * not there, which is a notification nobody ever receives. Suppression now has
 * to be EARNED by the sender being present, exactly as the online probe has to
 * earn its answer.
 *
 * EVERY DOUBT IS `false` (missing file, unreadable JSON, a stale heartbeat, a
 * dead pid, a `canPost: false` from the app itself, a clock that cannot be
 * read): the terminal then sends, which is the recoverable end — a duplicate
 * banner instead of silence.
 */
export function bannerSenderPresence(opts: { home?: string; now?: number } = {}): BannerSenderPresence {
  const path = menubarPresencePath(opts.home ?? daemonUserHome());
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { present: false, reason: "菜单栏 app 的心跳文件不存在或读不出来（app 没在跑）" };
  }
  if (!raw || typeof raw !== "object") return { present: false, reason: "菜单栏 app 的心跳不是 JSON 对象" };
  const record = raw as Record<string, unknown>;
  if (record.schema !== 1) return { present: false, reason: `菜单栏 app 的心跳 schema 不认识（${JSON.stringify(record.schema)}）` };
  // A POSITIVE pid, like every other pid this package trusts (`lib/daemon/state.ts`):
  // `pidAlive(0)` and `pidAlive(-1)` are TRUE — `kill(0, 0)` / `kill(-1, 0)` signal
  // the whole process group / every process of the user — so a heartbeat carrying
  // one of those would read as "the app is running" for a file nobody wrote.
  const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 ? record.pid : undefined;
  if (pid === undefined) return { present: false, reason: "菜单栏 app 的心跳没有可用的 pid（必须是正整数）" };
  const at = typeof record.at === "string" ? Date.parse(record.at) : Number.NaN;
  if (!Number.isFinite(at)) return { present: false, reason: "菜单栏 app 的心跳没有可读的时间戳" };
  const now = opts.now ?? Date.now();
  if (now - at > MENUBAR_HEARTBEAT_FRESH_MS) {
    return { present: false, reason: `菜单栏 app 的心跳已过期 ${Math.round((now - at) / 1000)}s（app 大概没在跑）` };
  }
  if (!pidAlive(pid)) return { present: false, reason: `菜单栏 app 的 pid ${pid} 已不在` };
  // A RUNNING APP IS NOT A SENDING APP (reviewer P1, 2026-10-01): the banner is
  // raised through UNUserNotificationCenter, so an app whose permission was
  // denied raises nothing while sitting there looking healthy. The app states
  // that fact itself and this is where it is required; a heartbeat written
  // before the field existed is also refused, which is the fail-open direction
  // for a mixed-version pair.
  //
  // LAST, AFTER the two liveness checks (reviewer Nit, 2026-10-01): a heartbeat
  // that is stale or dead is the ordinary POST-MORTEM state, and answering it
  // with "the app is running but cannot post" would be a reason that contradicts
  // the facts — this module's `reason` is its debugging surface.
  if (record.canPost !== true) {
    return { present: false, reason: "菜单栏 app 在跑，但它报告自己发不出横幅（通知权限被拒或投递失败）" };
  }
  return { present: true, reason: `菜单栏 app 在跑（pid ${pid}，心跳 ${Math.round((now - at) / 1000)}s 前）` };
}

/**
 * THE QUESTION THE TERMINAL NOTIFIER ACTUALLY ASKS: is somebody else going to
 * raise this banner?
 *
 * Both halves are required and they are different facts: the daemon has to be
 * answering (otherwise it cannot have an app attached to it at all), and the
 * app has to be alive (otherwise nobody raises anything). Anything either side
 * cannot confirm answers `false` — the terminal sends.
 */
export function bannerSenderOnline(opts: { home?: string; timeoutMs?: number; health?: HealthRunner; now?: number } = {}): boolean {
  if (!probeDaemonSync(opts).online) return false;
  return bannerSenderPresence(opts).present;
}
