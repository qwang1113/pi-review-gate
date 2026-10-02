/**
 * THE LAUNCHD HALF — "start the daemon at login, and again after it crashes".
 *
 * Three ways into `pi-gate daemon start` were asked for, and this is the one
 * that survives a reboot: a user LaunchAgent in `~/Library/LaunchAgents` that
 * runs `node <bin> daemon run` at login and after a CRASH.
 *
 * ── THE TWO KEYS THAT MAKE "STOP" POSSIBLE ──
 *
 * `RunAtLoad` is obvious. The restart policy is not: plain `KeepAlive true`
 * would resurrect the daemon the moment the user runs `pi-gate daemon stop` —
 * a command whose whole contract is that the process goes away and stays away.
 * `KeepAlive.SuccessfulExit = false` is the honest translation of "重新起来
 * whenever it CRASHED": launchd relaunches a job that exited non-zero, and our
 * SIGTERM handler exits 0 (`lib/daemon/cli.ts`), so a deliberate stop is not a
 * crash and is left alone. `ThrottleInterval` then bounds the damage of a
 * process that cannot start at all (a port already taken by a non-daemon
 * listener) to one attempt every 30 s instead of a spin.
 *
 * ── WHY THE PLIST IS BUILT, NOT COPIED FROM A TEMPLATE ──
 *
 * Every value in it is a fact of THIS machine: which node, which entry point,
 * which port, which home. A template with placeholders is the same code with
 * an escaping bug for free — the plist is XML and a path with an `&` in it has
 * to be escaped, so {@link xmlEscape} is applied at every insertion point.
 *
 * NOTHING HERE IS DONE TWICE: `install`/`uninstall` in `lib/daemon/cli.ts` are
 * thin printers over {@link installDaemonService} / {@link uninstallDaemonService},
 * and both take the launchctl runner as a dependency — a test must never write
 * to the real `~/Library/LaunchAgents` or boot a real agent out of the user's
 * session.
 *
 * ── TWO HOMES, NOT ONE (quality round P2, 2026-10-01) ──
 *
 * `userHome` is where launchd looks for a login item (`~/Library/LaunchAgents`,
 * always the REAL user home); `home` is the daemon's own (`RG_DAEMON_HOME` or
 * `$HOME`), which the plist passes through in `EnvironmentVariables`. Deriving
 * the first from the second wrote the plist into a directory nothing scans
 * whenever the override was set — and then reported 「登录自启」.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DAEMON_DEFAULT_PORT, daemonHome, daemonLogPath } from "./paths.ts";

/** The one label, referenced by every launchctl call below. */
export const LAUNCHD_LABEL = "com.pi.review-gate.daemon";

/** One launchctl invocation's result. */
export interface LaunchctlResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface LaunchdDeps {
  /**
   * THE DAEMON'S home (`RG_DAEMON_HOME` or `$HOME`) — what the agent's
   * `EnvironmentVariables` entry is set to, and where the log goes.
   */
  home?: string;
  /**
   * THE USER's home — where `~/Library/LaunchAgents` lives.
   *
   * SEPARATE FROM `home` ON PURPOSE (quality round P2, 2026-10-01): launchd
   * only ever reads a login item from the USER's own `~/Library/LaunchAgents`,
   * so pointing this at an `RG_DAEMON_HOME` override would write a plist into
   * a directory nothing scans and then report 「登录自启」 — a lie. The override
   * still reaches the daemon (the plist passes it through); it just does not
   * move launchd's own directory. Injected by tests, so a scratch home never
   * touches the real one.
   */
  userHome?: string;
  /** `[node, <pi-gate entry>, …]` — how launchd re-executes the CLI. */
  reexec: readonly string[];
  /**
   * THE PATH THE DAEMON RUNS WITH — the one the shell that RAN the install
   * had, `process.env.PATH` by default.
   *
   * launchd hands a job the minimal `/usr/bin:/bin:/usr/sbin:/sbin`, and this
   * daemon starts sessions by `execFileSync("tmux", …)` and then `tmux
   * new-window … pi`. With Homebrew's tmux at `/opt/homebrew/bin/tmux`
   * (measured 2026-10-02) that PATH does not contain the executable, so tmux
   * could not be spawned at all and EVERY scheduled run was skipped with
   * 「读不到 tmux server（list-sessions 失败）」— the daemon's PATH is the only
   * thing that was wrong, and the shell's own PATH is the one fact that says
   * where tmux lives on this machine. Copied, never guessed: a hardcoded
   * Homebrew prefix would miss a nix / macports / custom install.
   */
  path?: string;
  port?: number;
  workspaceRoots?: readonly string[];
  /** Overridden by tests; the default runs the real `/bin/launchctl`. */
  runLaunchctl?: (argv: readonly string[]) => LaunchctlResult;
  /** Overridden by tests; the default is `process.platform`. */
  platform?: string;
  uid?: number;
}

/** Where `LaunchAgents` is looked up: the real user home unless a test says otherwise. */
export const launchdUserHome = (userHome?: string): string => userHome ?? homedir();

/** `~/Library/LaunchAgents/<label>.plist` — under the USER's home. */
export function launchdPlistPath(userHome?: string): string {
  return join(launchdUserHome(userHome), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

const xmlEscape = (raw: string): string =>
  raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The agent's property list.
 *
 * `ProgramArguments` is exactly what a human would type to run the daemon in
 * the foreground — plus `RG_DAEMON_HOME` in the environment, so an install made
 * with an overridden home starts a daemon that reads the SAME files the
 * installing CLI just wrote — plus `PATH`, so it can still find `tmux` (see
 * {@link LaunchdDeps.path}).
 */
export function buildLaunchdPlist(deps: LaunchdDeps): string {
  const home = deps.home ?? homedir();
  const port = deps.port ?? DAEMON_DEFAULT_PORT;
  const roots = deps.workspaceRoots ?? [];
  const path = deps.path ?? process.env.PATH ?? "";
  const log = daemonLogPath(home);
  const args = [...deps.reexec, "daemon", "run", "--port", String(port), ...roots.flatMap((root) => ["--workspace-root", root])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RG_DAEMON_HOME</key>
    <string>${xmlEscape(home)}</string>
    <key>PATH</key>
    <string>${xmlEscape(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- restart a CRASH only: a graceful "pi-gate daemon stop" exits 0 -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

/** The real thing: `/bin/launchctl`, no shell. */
function defaultLaunchctl(argv: readonly string[]): LaunchctlResult {
  const result = spawnSync("/bin/launchctl", [...argv], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error === undefined ? "" : String(result.error.message)),
  };
}

export interface ServiceOutcome {
  ok: boolean;
  /** One line per external step, in the order it ran — what the CLI prints. */
  steps: string[];
  plistPath: string;
  problem?: string;
}

const detail = (result: LaunchctlResult): string => (result.stderr.trim() || result.stdout.trim() || `退出码 ${result.code}`);

/**
 * Write the plist and put the job in the user's GUI domain.
 *
 * `bootout` FIRST, IGNORING ITS RESULT: the job may be loaded with an older
 * plist (a second install after a path or port change), and `bootstrap` refuses
 * a label that is already there. "It was not loaded" is the expected answer on
 * a first install, not an error — while a `bootstrap` that fails afterwards is
 * reported with launchctl's own words.
 */
export function installDaemonService(deps: LaunchdDeps): ServiceOutcome {
  const plistPath = launchdPlistPath(deps.userHome);
  const steps: string[] = [];
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    return { ok: false, plistPath, steps, problem: `launchd 只在 macOS 上有（这台机器是 ${platform}）—— 用 \`pi-gate daemon start\` 手动启动` };
  }
  const run = deps.runLaunchctl ?? defaultLaunchctl;
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  try {
    mkdirSync(join(launchdUserHome(deps.userHome), "Library", "LaunchAgents"), { recursive: true });
    mkdirSync(daemonHome(deps.home ?? homedir()), { recursive: true });
    writeFileSync(plistPath, buildLaunchdPlist(deps), { encoding: "utf8", mode: 0o644 });
    steps.push(`写入 ${plistPath}`);
  } catch (error) {
    return { ok: false, plistPath, steps, problem: `写 plist 失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const bootout = run(["bootout", `${domain}/${LAUNCHD_LABEL}`]);
  steps.push(`launchctl bootout ${domain}/${LAUNCHD_LABEL}（旧的一份先卸掉；未装载时这一步本来就会失败，忽略）`);
  const bootstrap = run(["bootstrap", domain, plistPath]);
  steps.push(`launchctl bootstrap ${domain} ${plistPath}`);
  if (!bootstrap.ok) {
    return { ok: false, plistPath, steps, problem: `launchctl bootstrap 失败：${detail(bootstrap)}（bootout：${detail(bootout)}）` };
  }
  return { ok: true, plistPath, steps };
}

/**
 * Boot the job out and delete the plist.
 *
 * "NOT INSTALLED" IS REPORTED AS SUCH, never as success-with-a-warning: the
 * caller prints a different sentence for the two, and a user who never
 * installed the agent should not be told it was removed.
 */
export function uninstallDaemonService(deps: LaunchdDeps): ServiceOutcome & { removed: boolean } {
  const plistPath = launchdPlistPath(deps.userHome);
  const steps: string[] = [];
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    return { ok: false, removed: false, plistPath, steps, problem: `launchd 只在 macOS 上有（这台机器是 ${platform}）` };
  }
  const run = deps.runLaunchctl ?? defaultLaunchctl;
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  const bootout = run(["bootout", `${domain}/${LAUNCHD_LABEL}`]);
  steps.push(`launchctl bootout ${domain}/${LAUNCHD_LABEL}`);
  const hadPlist = existsSync(plistPath);
  try {
    rmSync(plistPath, { force: true });
  } catch (error) {
    return { ok: false, removed: false, plistPath, steps, problem: `删 plist 失败：${error instanceof Error ? error.message : String(error)}` };
  }
  steps.push(`删除 ${plistPath}`);
  if (!bootout.ok && !hadPlist) {
    // The raw launchctl words, not a second sentence around them: the caller
    // already says "nothing was installed", and what a human needs next is what
    // launchctl actually answered.
    return { ok: true, removed: false, plistPath, steps, problem: detail(bootout) };
  }
  return { ok: true, removed: true, plistPath, steps };
}
