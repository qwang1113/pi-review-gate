#!/usr/bin/env node
/**
 * THE TMUX SIDEBAR (2026-09-27, s1; lock + preview t7) — `prefix + e`.
 *
 *   node scripts/tmux-sidebar.ts toggle <pane id>   open a sidebar left of that
 *                                                  pane's window, or close the
 *                                                  one already there
 *   node scripts/tmux-sidebar.ts run                the TUI itself (what toggle starts)
 *
 * Reads the server with one `list-panes -a` every second and on every key;
 * everything it knows comes from pane options the gate's sessions write about
 * themselves (lib/tmux-pane-state.ts). While it is open, every other pane of
 * its window has its input switched off, and the selected row's pane is shown
 * on the right. It writes: the `@rg_sidebar` marker on its own pane, the lock
 * record on its window (so it outlives a pane killed hard), the input flag of the panes it locked (given back on every way
 * out), and the client's current session/window/pane when the user jumps —
 * a jump closes the sidebar. Never `-g`.
 *
 * The logic lives in lib/tmux-sidebar-{collect,tree,render,lock,preview}.ts;
 * this file is the terminal loop and nothing else.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildListAllPanesArgv, parsePaneRows, SIDEBAR_PANE_OPTION } from "../lib/tmux-sidebar-collect.ts";
import {
  buildWindowPanesArgv,
  decodeLocked,
  lockArgv,
  parseWindowPanes,
  planLock,
  readRecordArgv,
  recordArgv,
  restoreArgvs,
} from "../lib/tmux-sidebar-lock.ts";
import { buildCaptureArgv, joinColumns, previewLines, splitColumns } from "../lib/tmux-sidebar-preview.ts";
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

/** Room for the list plus a preview beside it. */
const SIDEBAR_WIDTH = "60%";
const REFRESH_MS = 1_000;

function tmux(argv: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("tmux", argv as string[], { encoding: "utf8" });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const PANE_ID = /^%\d+$/;

/**
 * Switch off every pane of the sidebar's window that is still on. The record
 * is written BEFORE the lock: a crash in between then leaves a record naming a
 * pane that is still on (restoring it is harmless), never a locked pane
 * nobody remembers.
 */
function lockWindow(sidebarId: string): void {
  const listed = tmux(buildWindowPanesArgv(sidebarId));
  if (!listed.ok) return;
  const plan = planLock(parseWindowPanes(listed.stdout), sidebarId);
  if (plan.record !== undefined) tmux(recordArgv(sidebarId, plan.record));
  for (const id of plan.lock) tmux(lockArgv(id));
}

/** Give back what the window's record says was locked; `target` is any live pane of it. */
function restore(target: string): void {
  const read = tmux(readRecordArgv(target));
  if (!read.ok) return;
  for (const argv of restoreArgvs(target, decodeLocked(read.stdout))) tmux(argv);
}

/** Close the window's sidebar if it has one, otherwise open one. */
function toggle(pane: string | undefined): number {
  if (!pane || !PANE_ID.test(pane)) {
    process.stderr.write("用法：tmux-sidebar.ts toggle <pane id>\n");
    return 2;
  }
  const listed = tmux(buildWindowPanesArgv(pane));
  if (!listed.ok) {
    process.stderr.write(`读不到 ${pane} 所在的 window：${listed.stderr}\n`);
    return 1;
  }
  const window = parseWindowPanes(listed.stdout);
  const open = window.panes.find((p) => p.sidebar);
  const survivor = window.panes.find((p) => !p.sidebar)?.paneId ?? pane;
  if (open) {
    // Killed FIRST, restored after, from a pane that survives: a TUI still
    // running could otherwise re-lock between our restore and its death.
    const killed = tmux(["kill-pane", "-t", open.paneId]).ok;
    restore(survivor);
    return killed ? 0 : 1;
  }
  if (window.locked.length > 0) {
    // A sidebar died without giving its panes back (killed hard): this press
    // only unlocks. The next one opens a sidebar again.
    restore(survivor);
    return 0;
  }
  const script = fileURLToPath(import.meta.url);
  const created = tmux([
    "split-window", "-h", "-b", "-f", "-l", SIDEBAR_WIDTH, "-t", pane, "-P", "-F", "#{pane_id}",
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
  lockWindow(id);
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
  const self = PANE_ID.test(process.env.TMUX_PANE ?? "") ? process.env.TMUX_PANE! : undefined;
  let lines: SidebarLine[] = [];
  let selected = 0;
  let scroll = 0;
  let error = "";
  let preview = "";

  const columns = (): { list: number; preview: number } => splitColumns(Math.max(10, out.columns || 30));
  const height = (): number => Math.max(1, (out.rows || 24) - 1);
  const refresh = (): void => {
    if (self) lockWindow(self);
    const listed = tmux(buildListAllPanesArgv());
    if (!listed.ok) {
      error = `读不到 tmux：${listed.stderr.trim() || "list-panes 失败"}`;
      lines = [];
      return;
    }
    error = "";
    lines = sidebarLines(buildSidebarTree(parsePaneRows(listed.stdout), Math.floor(Date.now() / 1000)), columns().list);
    selected = clampSelection(lines, selected);
    const target = lines[selected]?.target?.paneId;
    const captured = target ? tmux(buildCaptureArgv(target)) : undefined;
    preview = !captured ? "" : captured.ok ? captured.stdout : "（这个 pane 已经不在了）";
  };
  const draw = (): void => {
    const cols = columns();
    scroll = scrollFor(selected, scroll, height());
    const list = error ? [error] : paintLines(lines, { width: cols.list, height: height(), selected, scroll });
    const body = cols.preview > 0
      ? joinColumns(list, previewLines(preview, cols.preview, height()), cols.list, height())
      : list;
    out.write(`\x1b[H\x1b[2J${body.join("\r\n")}\x1b[${height() + 1};1H\x1b[2mj/k 选择 · ↵ 跳转 · q 关闭\x1b[0m`);
  };
  /** Every way out goes through here: the locked panes get their input back first. */
  const quit = (code = 0): never => {
    if (self) restore(self);
    out.write("\x1b[?7h\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
    process.exit(code);
  };
  const jumpAndClose = (target: JumpTarget): never => {
    if (self) restore(self);
    jump(target);
    return quit();
  };

  process.on("SIGHUP", () => quit());
  process.on("SIGTERM", () => quit());
  process.on("uncaughtException", (err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    quit(1);
  });

  // Autowrap off: a row whose width we misjudge is clipped by the terminal
  // instead of wrapping and shifting every row (and click) below it.
  out.write("\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[?1000h\x1b[?1006h");
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    // SGR mouse: ESC [ < button ; x ; y M  — a left press on the list jumps.
    for (const match of chunk.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
      if (match[4] !== "M" || Number(match[1]) !== 0 || Number(match[2]) > columns().list) continue;
      const hit = lineAtClick(lines, Number(match[3]), scroll);
      if (hit !== undefined) jumpAndClose(lines[hit].target!);
    }
    const keys = chunk.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, "");
    if (keys === "q" || keys === "\x03") quit();
    if (keys === "j" || keys === "\x1b[B") selected = moveSelection(lines, selected, 1);
    if (keys === "k" || keys === "\x1b[A") selected = moveSelection(lines, selected, -1);
    if ((keys === "\r" || keys === "\n") && lines[selected]?.target) jumpAndClose(lines[selected].target!);
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
