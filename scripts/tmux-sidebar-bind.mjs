/**
 * `prefix + e` → THE TMUX SIDEBAR (2026-09-27, s1): one `bind` line appended
 * to the user's `~/.tmux.conf`, the same way the status line is rewritten
 * (scripts/tmux-status-format.mjs) — in the file the user owns, backed up
 * first, idempotent, and never `tmux set -g` on a running server. The user
 * reloads it with `prefix + r`.
 *
 * WHAT IT REFUSES TO DO:
 *   - touch a config that already binds `e` itself (the user's key wins);
 *   - write a path tmux would have to un-quote (a `'` or `"` in it);
 *   - bind a package installed under `node_modules`: node refuses to strip
 *     TypeScript types there, so the sidebar could not start.
 *
 * `.mjs` for the reason tmux-status-format.mjs gives: the installer and the
 * test import this one module, so there is one answer to "already bound".
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** The comment that marks OUR line, so a rerun finds and refreshes it. */
export const SIDEBAR_BIND_MARKER = "# pi-review-gate: tmux sidebar (prefix + e)";

/**
 * A user binding of `e` that is not ours: `bind e`, `bind-key -r e`,
 * `bind -T prefix e`, `bind -N "note" e` — flags that take an argument
 * (`-T table`, `-N note`) consume it. Any table counts: a conservative match
 * only ever leaves the config alone.
 */
const USER_BIND_E = /^\s*bind(?:-key)?\s+(?:(?:-[TN]\s+(?:"[^"]*"|'[^']*'|\S+)|-[a-zA-Z]+)\s+)*e(?:\s|$)/;

/** The line itself; formats (`#{pane_id}`) are expanded by run-shell. */
export function sidebarBindLine(node, script) {
  return `bind e run-shell "'${node}' '${script}' toggle '#{pane_id}'"`;
}

/**
 * Pure: text in, text out. `status` is `appended` | `updated` | `already` |
 * `conflict` (the user binds `e` themselves — left alone).
 */
export function appendSidebarBind(text, line) {
  const source = String(text ?? "");
  const lines = source.split("\n");
  const at = lines.indexOf(SIDEBAR_BIND_MARKER);
  if (at >= 0) {
    if (lines[at + 1] === line) return { text: source, status: "already" };
    lines.splice(at + 1, lines[at + 1] !== undefined && USER_BIND_E.test(lines[at + 1]) ? 1 : 0, line);
    return { text: lines.join("\n"), status: "updated" };
  }
  if (lines.some((l) => USER_BIND_E.test(l))) return { text: source, status: "conflict" };
  const tail = source.length === 0 || source.endsWith("\n") ? "" : "\n";
  return { text: `${source}${tail}\n${SIDEBAR_BIND_MARKER}\n${line}\n`, status: "appended" };
}

/** Do it to a real file. Returns what it did; never throws for an expected case. */
export function installTmuxSidebarBind(opts = {}) {
  const confPath = opts.confPath ?? join(homedir(), ".tmux.conf");
  const root = resolve(opts.root ?? ".");
  const node = opts.node ?? process.execPath;
  const log = opts.log ?? (() => {});
  const stamp = opts.stamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  if (root.split(sep).includes("node_modules")) return { status: "node-modules", confPath };
  const script = join(root, "scripts", "tmux-sidebar.ts");
  if (/["'\n]/.test(node + script)) return { status: "unsafe-path", confPath };
  if (!existsSync(confPath)) return { status: "missing", confPath };
  let original;
  try {
    original = readFileSync(confPath, "utf8");
  } catch (error) {
    return { status: "unreadable", confPath, error: String(error?.message ?? error) };
  }
  const { text, status } = appendSidebarBind(original, sidebarBindLine(node, script));
  if (status === "already" || status === "conflict") return { status, confPath };
  const backup = `${confPath}.bak-rg-${stamp}`;
  try {
    copyFileSync(confPath, backup);
    writeFileSync(confPath, text, "utf8");
  } catch (error) {
    return { status: "failed", confPath, backup, error: String(error?.message ?? error) };
  }
  log(`  ✓ prefix + e now toggles the pi session sidebar (backup: ${backup})`);
  log("    run `prefix + r` inside tmux (or `tmux source-file ~/.tmux.conf`) to reload it");
  return { status, confPath, backup };
}
