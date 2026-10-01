/**
 * `pi-gate daemon …` — the command line the daemon is actually driven by.
 *
 * ── THE COMMANDS ──
 *
 *   start       bring it up (detached by default), and DO NOT start a second one
 *   stop        SIGTERM, wait for it to go away, and only then clear the record
 *   status      the one online rule (lib/daemon/state.ts `probeDaemon`) + a line
 *   run         the foreground process `start` re-executes (internal)
 *   install     NOT IMPLEMENTED HERE — launchd is menubar-and-boot's job
 *   uninstall   same
 *
 * `start` is idempotent BY MEASUREMENT, not by a lock file: it probes the
 * running daemon before spawning anything, so a second `start` prints the live
 * one's pid and exits 0. A state file whose process is gone is not cleaned up
 * by anybody but the new daemon overwriting it — a stale record is evidence,
 * not garbage, and the online rule already reads it correctly.
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

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createRuntime } from "./server.ts";
import { DEFAULT_WEB_DIR } from "./static.ts";
import {
  buildDaemonState,
  clearDaemonState,
  describeDaemonState,
  ensureDaemonToken,
  probeDaemon,
  readDaemonState,
  writeDaemonState,
} from "./state.ts";
import { DAEMON_DEFAULT_PORT, daemonHome, daemonLogPath, daemonTokenPath } from "./paths.ts";
import { pidAlive } from "../session-registry.ts";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** How to re-execute this entry point for the detached daemon. */
  reexec?: string[];
  /** Agent home override (defaults to `$RG_DAEMON_HOME`, then `$HOME`). */
  home?: string;
}

/**
 * The home override, one mechanism: the CLI flag `io.home` is how a caller that
 * already knows passes it, and `RG_DAEMON_HOME` is how it reaches the DETACHED
 * CHILD — a `--home` flag on the command line would be a second, undocumented
 * way to point a daemon at somebody else's state.
 */
export const DAEMON_HOME_ENV = "RG_DAEMON_HOME";

const defaultIo = (): CliIo => ({
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  reexec: [process.execPath, fileURLToPath(import.meta.url)],
  ...(process.env[DAEMON_HOME_ENV] === undefined ? {} : { home: process.env[DAEMON_HOME_ENV] }),
});

const USAGE = `用法：pi-gate daemon <start|stop|status|install|uninstall> [选项]

  start    启动常驻进程（已在线时不启动第二份）
           --port <n>                 监听端口（默认 ${DAEMON_DEFAULT_PORT}）
           --foreground               前台运行（调试用；默认后台）
           --workspace-root <path>    候选仓库的上级目录（可重复）
  stop     停止它（SIGTERM，等它退出后清理 state 文件）
  status   打印在线判定结果（state 文件 + pid + 端口探测）
  install  / uninstall  占位：launchd 实装由 menubar-and-boot 提供
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
  writeDaemonState(buildDaemonState(port, Date.now(), args.workspaceRoots), home);
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
  const probe = await probeDaemon({ home });
  if (probe.online && probe.state !== undefined) {
    io.out(`pi-gate daemon 已经在跑：${describeDaemonState(probe.state)}`);
    io.out("没有启动第二份。要重启就先 `pi-gate daemon stop`。");
    return 0;
  }
  if (args.foreground) return runForeground(args, io, home);

  mkdirSync(daemonHome(home), { recursive: true });
  const logFd = openSync(daemonLogPath(home), "a", 0o600);
  const reexec = io.reexec ?? [process.execPath, fileURLToPath(import.meta.url)];
  const child = spawn(
    reexec[0]!,
    [
      ...reexec.slice(1),
      "daemon",
      "run",
      "--port",
      String(args.port),
      ...args.workspaceRoots.flatMap((root) => ["--workspace-root", root]),
    ],
    { detached: true, stdio: ["ignore", logFd, logFd], env: { ...process.env, [DAEMON_HOME_ENV]: home } },
  );
  child.unref();

  // EARN THE RECEIPT: poll the same online rule every consumer uses until it
  // says yes (or the budget runs out). Reading the state file alone would
  // report success on a record the daemon had not finished writing.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    const current = await probeDaemon({ home });
    if (current.online && current.state !== undefined) {
      io.out(`pi-gate daemon 已启动：${describeDaemonState(current.state)}`);
      io.out(`面板：http://127.0.0.1:${current.state.port}/　token 文件：${daemonTokenPath(home)}`);
      io.out(`日志：${daemonLogPath(home)}`);
      return 0;
    }
  }
  io.err(`启动失败：10 秒内没有等到端口应答。看日志：${daemonLogPath(home)}`);
  return 1;
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
  else io.out(`state：${daemonHome(home)} 下没有可读的 rg-daemon.json`);
  io.out(`在线：${probe.online ? "是" : "否"} —— ${probe.reason}`);
  io.out(`面板地址：http://127.0.0.1:${state?.port ?? DAEMON_DEFAULT_PORT}/（静态目录 ${DEFAULT_WEB_DIR}）`);
  return probe.online ? 0 : 1;
}

/** `install` / `uninstall` are placeholders until the launchd task lands. */
function notImplemented(command: string, io: CliIo): number {
  io.out(`pi-gate daemon ${command}：本轮没有实装 launchd（常驻登录项由 menubar-and-boot 提供）。`);
  io.out("现在请用 `pi-gate daemon start` 手动启动。");
  return 0;
}

export async function runDaemonCli(argv: readonly string[], io: CliIo = defaultIo()): Promise<number> {
  const home = io.home ?? homedir();
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
  if (command === "install" || command === "uninstall") return notImplemented(command, io);
  if (command !== "start" && command !== "run") {
    io.err(`未知子命令：${command}\n${USAGE}`);
    return 1;
  }
  const args = parseArgs(rest, io);
  if (args === undefined) return 1;
  if (command === "run") return runForeground(args, io, home);
  return start(args, io, home);
}

// Running this file directly is also a supported entry point (the detached
// child re-executes it): `node lib/daemon/cli.ts daemon run --port 4597`.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runDaemonCli(process.argv.slice(2));
}
