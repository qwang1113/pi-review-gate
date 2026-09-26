#!/usr/bin/env node
/**
 * THE TMUX SIDEBAR (2026-09-27, s1) — `prefix + e`.
 *
 *   node scripts/tmux-sidebar.ts toggle <pane id>   open a sidebar left of that
 *                                                  pane's window, or close the
 *                                                  one already there
 *   node scripts/tmux-sidebar.ts run                the TUI itself (what toggle starts)
 *
 * Reads the server with one `list-panes -a` every two seconds and on every key;
 * everything it knows comes from pane options the gate's sessions write about
 * themselves (lib/tmux-pane-state.ts). It writes exactly two things: the
 * `@rg_sidebar` marker on its own pane, and the client's current
 * session/window/pane when the user jumps. Never `-g`.
 *
 * The logic lives in lib/tmux-sidebar-{collect,tree,render}.ts; this file is
 * the terminal loop and nothing else.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildListAllPanesArgv, parsePaneRows, SIDEBAR_PANE_OPTION } from "../lib/tmux-sidebar-collect.ts";
import { buildSidebarTree, type JumpTarget } from "../lib/tmux-sidebar-tree.ts";
import {
  clampSelection,
  lineAtClick,
  moveSelection,
  paintLines,
  scrollFor,
  sidebarLines,
  type SidebarLine,
} from "../lib/tmux-sidebar-render.ts";

const SIDEBAR_WIDTH = 30;
const REFRESH_MS = 2_000;

function tmux(argv: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("tmux", argv as string[], { encoding: "utf8" });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const PANE_ID = /^%\d+$/;

/** Close the window's sidebar if it has one, otherwise open one. */
function toggle(pane: string | undefined): number {
  if (!pane || !PANE_ID.test(pane)) {
    process.stderr.write("用法：tmux-sidebar.ts toggle <pane id>\n");
    return 2;
  }
  const listed = tmux(["list-panes", "-t", pane, "-F", `#{pane_id}\t#{${SIDEBAR_PANE_OPTION}}`]);
  if (!listed.ok) {
    process.stderr.write(`读不到 ${pane} 所在的 window：${listed.stderr}\n`);
    return 1;
  }
  const open = listed.stdout.split("\n").map((line) => line.split("\t")).find(([, mark]) => mark === "1");
  if (open) return tmux(["kill-pane", "-t", open[0]]).ok ? 0 : 1;
  const script = fileURLToPath(import.meta.url);
  const created = tmux([
    "split-window", "-h", "-b", "-f", "-l", String(SIDEBAR_WIDTH), "-t", pane, "-P", "-F", "#{pane_id}",
    process.execPath, script, "run",
  ]);
  const id = created.stdout.trim();
  if (!created.ok || !PANE_ID.test(id)) {
    process.stderr.write(`开不了侧边栏：${created.stderr}\n`);
    return 1;
  }
  // Marked by the opener, not by the TUI: a second press that arrives before
  // node has booted must still find it.
  tmux(["set", "-p", "-t", id, SIDEBAR_PANE_OPTION, "1"]);
  return 0;
}

/** The client showing this sidebar — the one a jump moves. */
function ownClient(): string | undefined {
  const self = process.env.TMUX_PANE ?? "";
  const session = tmux(["display-message", "-p", "-t", self, "#{session_name}"]).stdout.trim();
  const clients = tmux(["list-clients", "-F", "#{client_name}\t#{session_name}"]).stdout.split("\n");
  return clients.map((line) => line.split("\t")).find(([, s]) => s === session)?.[0];
}

function jump(target: JumpTarget): void {
  const client = ownClient();
  tmux(["switch-client", ...(client ? ["-c", client] : []), "-t", target.session]);
  tmux(["select-window", "-t", target.windowId]);
  tmux(["select-pane", "-t", target.paneId]);
}

function run(): number {
  const out = process.stdout;
  let lines: SidebarLine[] = [];
  let selected = 0;
  let scroll = 0;
  let error = "";

  const refresh = (): void => {
    const listed = tmux(buildListAllPanesArgv());
    if (!listed.ok) {
      error = `读不到 tmux：${listed.stderr.trim() || "list-panes 失败"}`;
      lines = [];
      return;
    }
    error = "";
    lines = sidebarLines(buildSidebarTree(parsePaneRows(listed.stdout), Math.floor(Date.now() / 1000)), width());
    selected = clampSelection(lines, selected);
  };
  const width = (): number => Math.max(10, out.columns || SIDEBAR_WIDTH);
  const height = (): number => Math.max(1, (out.rows || 24) - 1);
  const draw = (): void => {
    scroll = scrollFor(selected, scroll, height());
    const body = error ? [error] : paintLines(lines, { width: width(), height: height(), selected, scroll });
    out.write(`\x1b[H\x1b[2J${body.join("\r\n")}\x1b[${height() + 1};1H\x1b[2mj/k ↵ 跳转 · q 关闭\x1b[0m`);
  };
  const quit = (): void => {
    out.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
    process.exit(0);
  };

  out.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    // SGR mouse: ESC [ < button ; x ; y M  — a left press selects and jumps.
    for (const match of chunk.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
      if (match[4] !== "M" || Number(match[1]) !== 0) continue;
      const hit = lineAtClick(lines, Number(match[3]), scroll);
      if (hit !== undefined) {
        selected = hit;
        jump(lines[hit].target!);
      }
    }
    const keys = chunk.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, "");
    if (keys === "q" || keys === "\x03") return quit();
    if (keys === "j" || keys === "\x1b[B") selected = moveSelection(lines, selected, 1);
    if (keys === "k" || keys === "\x1b[A") selected = moveSelection(lines, selected, -1);
    if ((keys === "\r" || keys === "\n") && lines[selected]?.target) jump(lines[selected].target!);
    refresh();
    draw();
  });
  out.on("resize", () => { refresh(); draw(); });
  setInterval(() => { refresh(); draw(); }, REFRESH_MS);
  refresh();
  draw();
  return 0;
}

const [command, arg] = process.argv.slice(2);
if (command === "toggle") process.exit(toggle(arg));
else if (command === "run") run();
else {
  process.stderr.write("用法：tmux-sidebar.ts toggle <pane id> | run\n");
  process.exit(2);
}
