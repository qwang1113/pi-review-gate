/**
 * `pi-gate daemon …` — the command line the daemon is actually driven by.
 *
 * ── THE COMMANDS ──
 *
 *   start       bring it up (detached by default), and DO NOT start a second one
 *   stop        SIGTERM, wait for it to go away, and only then clear the record
 *   status      the one online rule (lib/daemon-presence.ts `probeDaemon`) + a line
 *   run         the foreground process `start` re-executes (internal)
 *   install     write ~/Library/LaunchAgents/<label>.plist and bootstrap it (launchd)
 *   uninstall   boot it out and remove the plist
 *
 * `start` is idempotent BY MEASUREMENT, not by a lock file: it probes the
 * running daemon before spawning anything, so a second `start` prints the live
 * one's pid and exits 0. The lock and the spawn themselves live in
 * `lib/daemon/autostart.ts` (menubar-and-boot, 2026-10-01) because a session
 * that needs the daemon brings it up the same way — one starter, one
 * implementation. A state file whose process is gone is not cleaned up by
 * anybody but the new daemon overwriting it — a stale record is evidence, not
 * garbage, and the online rule already reads it correctly.
 *
 * ── WHY `run` PROBES BEFORE IT BINDS ──
 *
 * `run` is what launchd executes. If a daemon is already answering on the
 * port — a manual `start` before `install`, say — the honest answer is "there
 * is already one" and exit 0, not "address in use" and exit 1. Under the
 * agent's `KeepAlive.SuccessfulExit = false` an exit 1 means launchd restarts
 * the job every 30 s forever, each one failing the same way.
 *
 * ── WHY A DETACHED CHILD AND NOT A BACKGROUND JOB ──
 *
 * The daemon must outlive the terminal that started it (its whole point is to
 * be there when nothing else is). `start` re-executes this same entry point
 * with `run`, detached, with stdout/stderr going to
 * `~/.pi/agent/rg-daemon/daemon.log`, and then WAITS for the state file and a
 * successful probe before it reports success — a start that returns before the
 * daemon is reachable is a start that lies.
 */

import { fileURLToPath, pathToFileURL } from "node:url";

import { createRuntime } from "./server.ts";
import { DEFAULT_WEB_DIR } from "./static.ts";
import {
  buildDaemonState,
  clearDaemonState,
  describeDaemonState,
  ensureDaemonToken,
  readDaemonState,
  writeDaemonState,
} from "./state.ts";
import { probeDaemon } from "../daemon-presence.ts";
import { pidAlive } from "../session-registry.ts";
import { ensureDaemonRunning } from "./autostart.ts";
import { installDaemonService, launchdPlistPath, uninstallDaemonService, type LaunchdDeps } from "./service-launchd.ts";
import {
  DAEMON_DEFAULT_PORT,
  DAEMON_HOME_ENV,
  daemonHome,
  daemonLogPath,
  daemonStatePath,
  daemonTokenPath,
  daemonUserHome,
} from "./paths.ts";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** How to re-execute this entry point for the detached daemon. */
  reexec?: string[];
  /** Agent home override (defaults to `$RG_DAEMON_HOME`, then `$HOME`). */
  home?: string;
  /**
   * How `install` / `uninstall` drive launchd. Injected so a test can exercise
   * the real code path without writing into the user's LaunchAgents or
   * booting an agent out of their session.
   */
  launchd?: Pick<LaunchdDeps, "runLaunchctl" | "platform" | "uid">;
}

/**
 * The home override, one mechanism: the CLI flag `io.home` is how a caller that
 * already knows passes it, and `RG_DAEMON_HOME` is how it reaches the DETACHED
 * CHILD — a `--home` flag on the command line would be a second, undocumented
 * way to point a daemon at somebody else's state.
 */
export { DAEMON_HOME_ENV };

const defaultIo = (): CliIo => ({
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  reexec: [process.execPath, fileURLToPath(import.meta.url)],
});

const USAGE = `用法：pi-gate daemon <start|stop|status|install|uninstall> [选项]

  start    启动常驻进程（已在线时不启动第二份）
           --port <n>                 监听端口（默认 ${DAEMON_DEFAULT_PORT}）
           --foreground               前台运行（调试用；默认后台）
           --workspace-root <path>    候选仓库的上级目录（可重复）
  stop     停止它（SIGTERM，等它退出后清理 state 文件）
  status   打印在线判定结果（state 文件 + pid + 端口探测）
  install  装成 launchd 登录项（RunAtLoad + 崩溃重启；--port / --workspace-root 同 start）
  uninstall 卸掉它并删除 plist
`;

interface Args {
  port: number;
  foreground: boolean;
  workspaceRoots: string[];
}

function parseArgs(argv: readonly string[], io: CliIo): Args | undefined {
  const args: Args = { port: DAEMON_DEFAULT_PORT, foreground: false, workspaceRoots: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--foreground") {
      args.foreground = true;
      continue;
    }
    if (flag === "--port" || flag === "--workspace-root") {
      const value = argv[index + 1];
      if (value === undefined) {
        io.err(`${flag} 需要一个值`);
        return undefined;
      }
      index += 1;
      if (flag === "--port") {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          io.err(`--port 不是合法端口：${JSON.stringify(value)}`);
          return undefined;
        }
        args.port = port;
      } else {
        args.workspaceRoots.push(value);
      }
      continue;
    }
    io.err(`未知参数：${flag}`);
    return undefined;
  }
  return args;
}

/** The foreground daemon: bind, record, and stay until told to stop. */
async function runForeground(args: Args, io: CliIo, home: string): Promise<number> {
  // IDEMPOTENT EVEN IN THE FOREGROUND (see the module header): under launchd
  // this process IS the agent, and a second one that cannot bind would be
  // restarted forever. "Already running" is a clean exit, not a crash.
  const existing = await probeDaemon({ home });
  if (existing.online && existing.state !== undefined) {
    io.out(`pi-gate daemon 已经在跑，没有启动第二份：${describeDaemonState(existing.state)}`);
    return 0;
  }
  const { token } = ensureDaemonToken(home);
  const runtime = createRuntime({
    home,
    port: args.port,
    token,
    workspaceRoots: args.workspaceRoots,
    log: (message) => io.err(`[daemon] ${message}`),
  });
  let port: number;
  try {
    port = await runtime.start();
  } catch (error) {
    io.err(`无法监听 127.0.0.1:${args.port} —— ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  writeDaemonState(buildDaemonState({ port, workspaceRoots: args.workspaceRoots, home }), home);
  io.out(`pi-gate daemon 已在 http://127.0.0.1:${port} 监听（pid ${process.pid}）`);
  io.out(`token 文件：${daemonTokenPath(home)}（0600，内容不会回显）`);
  if (args.workspaceRoots.length > 0) io.out(`工作区根目录：${args.workspaceRoots.join("、")}`);

  const shutdown = (): void => {
    void runtime.stop().then(() => {
      clearDaemonState(process.pid, home);
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // The promise never resolves: the server holds the event loop, and the
  // handlers above are the only way out — a daemon that "finishes" is a daemon
  // that failed.
  return await new Promise<number>(() => { /* exits through shutdown() */ });
}

async function start(args: Args, io: CliIo, home: string): Promise<number> {
  if (args.foreground) return runForeground(args, io, home);
  // THE WHOLE START — probe, lock, spawn, wait for the port — is
  // lib/daemon/autostart.ts's. A session that needs the daemon runs the same
  // function, so "never a second one" is enforced once.
  const outcome = await ensureDaemonRunning({
    home,
    port: args.port,
    workspaceRoots: args.workspaceRoots,
    ...(io.reexec === undefined ? {} : { reexec: io.reexec }),
  });
  if (outcome.status === "busy") {
    io.err(`另一个 \`pi-gate daemon start\` 正在启动中（start.lock）—— 等它结束再试，或先 \`pi-gate daemon status\` 看结果。`);
    return 1;
  }
  if (outcome.status === "failed" || outcome.state === undefined) {
    io.err(`启动失败：${outcome.reason}`);
    return 1;
  }
  if (outcome.status === "online") {
    io.out(`pi-gate daemon 已经在跑：${describeDaemonState(outcome.state)}`);
    io.out("没有启动第二份。要重启就先 `pi-gate daemon stop`。");
    return 0;
  }
  io.out(`pi-gate daemon 已启动：${describeDaemonState(outcome.state)}`);
  io.out(`面板：http://127.0.0.1:${outcome.state.port}/　token 文件：${daemonTokenPath(home)}`);
  io.out(`日志：${daemonLogPath(home)}`);
  return 0;
}

async function stop(io: CliIo, home: string): Promise<number> {
  const state = readDaemonState(home);
  if (state === undefined) {
    io.out("没有在跑的 pi-gate daemon（state 文件不存在或读不出来）");
    return 0;
  }
  if (!pidAlive(state.pid)) {
    io.out(`state 里的 pid ${state.pid} 已经不在 —— 清理记录`);
    clearDaemonState(state.pid, home);
    return 0;
  }
  // CONFIRM IT IS STILL THE DAEMON BEFORE SIGNALLING (reviewer P1, 2026-10-01).
  // A pid is reused: the number in a stale state file can belong to something
  // else entirely by now, and killing that is the one destructive thing this
  // command could do. The port answering with OUR token is the proof that the
  // pid it names is the daemon; without that proof, stop refuses rather than
  // guesses (a daemon whose health check is wedged is stopped by hand).
  const probe = await probeDaemon({ home });
  if (!probe.online || probe.state?.pid !== state.pid) {
    io.err(
      `拒绝发 SIGTERM：pid ${state.pid} 活着，但带 token 的健康检查没有确认它就是 daemon` +
        `（${probe.reason}）—— pid 可能已被复用，杀错进程比多看一眼贵得多。` +
        "确认它是什么之后再手动处理，或删掉 state 文件里的记录。",
    );
    return 1;
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch (error) {
    io.err(`发 SIGTERM 失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (!pidAlive(state.pid)) {
      clearDaemonState(state.pid, home);
      io.out(`已停止 pid ${state.pid}`);
      return 0;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  io.err(`pid ${state.pid} 收到 SIGTERM 后 8 秒仍在运行 —— 没有强杀（强杀会留下写坏一半的状态）`);
  return 1;
}

async function status(io: CliIo, home: string): Promise<number> {
  const probe = await probeDaemon({ home });
  const state = probe.state ?? readDaemonState(home);
  if (state !== undefined) io.out(`state：${describeDaemonState(state)}`);
  else io.out(`state：${daemonStatePath(home)} 不存在或读不出来`);
  io.out(`在线：${probe.online ? "是" : "否"} —— ${probe.reason}`);
  io.out(`面板地址：http://127.0.0.1:${state?.port ?? DAEMON_DEFAULT_PORT}/（静态目录 ${DEFAULT_WEB_DIR}）`);
  return probe.online ? 0 : 1;
}

/** `install` / `uninstall`: the launchd agent, with launchctl's own answers printed. */
function service(command: "install" | "uninstall", args: Args, io: CliIo, home: string): number {
  const reexec = io.reexec ?? [process.execPath, fileURLToPath(import.meta.url)];
  const deps = {
    home,
    reexec,
    port: args.port,
    workspaceRoots: args.workspaceRoots,
    ...(io.launchd ?? {}),
  };
  if (command === "install") {
    const result = installDaemonService(deps);
    for (const step of result.steps) io.out(`· ${step}`);
    if (!result.ok) {
      io.err(`没装成：${result.problem}`);
      return 1;
    }
    io.out(`已装载：${launchdPlistPath(home)}（登录自启；崩溃后由 launchd 重起，\`pi-gate daemon stop\` 的干净退出不会）`);
    io.out("现在它应该已经在跑（RunAtLoad）—— `pi-gate daemon status` 确认。");
    io.out("若此刻另有一份手动启动的 daemon 在跑：那一份会继续服务，launchd 的这份会干净退出；先 `pi-gate daemon stop` 再 `launchctl kickstart -k gui/$(id -u)/com.pi.review-gate.daemon` 交给它。");
    return 0;
  }
  const result = uninstallDaemonService(deps);
  for (const step of result.steps) io.out(`· ${step}`);
  if (!result.ok) {
    io.err(`没卸干净：${result.problem}`);
    return 1;
  }
  if (!result.removed) io.out(`没有装过 launchd 登录项${result.problem === undefined ? "" : `（${result.problem}）`}`);
  else io.out("已卸载：不再登录自启，plist 已删除（正在跑的那一份不受影响，需要的话 `pi-gate daemon stop`）。");
  return 0;
}

export async function runDaemonCli(argv: readonly string[], io: CliIo = defaultIo()): Promise<number> {
  // THE HOME IS RESOLVED HERE, ONCE (reviewer P1, 2026-10-01): it used to be
  // read inside `defaultIo`, so every caller that passed its own `io` — the
  // `pi-gate` bin entry among them — silently fell back to `$HOME` and the
  // documented `RG_DAEMON_HOME` override did nothing. An explicit `io.home`
  // still wins (a caller that already knows), then the environment, then $HOME.
  const home = io.home ?? daemonUserHome();
  // `pi-gate daemon start …`: the word `daemon` is part of the address, and the
  // same entry point is re-executed for the detached child — dropping it here
  // keeps one reading of the command line instead of two.
  const [first, ...afterFirst] = argv;
  const [command, ...rest] = first === "daemon" ? afterFirst : argv;
  if (command === undefined) {
    io.out(USAGE);
    return 1;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    io.out(USAGE);
    return 0;
  }
  if (command === "status") return status(io, home);
  if (command === "stop") return stop(io, home);
  if (command !== "start" && command !== "run" && command !== "install" && command !== "uninstall") {
    io.err(`未知子命令：${command}\n${USAGE}`);
    return 1;
  }
  const args = parseArgs(rest, io);
  if (args === undefined) return 1;
  if (command === "install" || command === "uninstall") return service(command, args, io, home);
  if (command === "run") return runForeground(args, io, home);
  return start(args, io, home);
}

// Running this file directly is also a supported entry point (the detached
// child re-executes it): `node lib/daemon/cli.ts daemon run --port 4597`.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runDaemonCli(process.argv.slice(2));
}
