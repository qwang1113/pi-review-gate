/**
 * THE TMUX STATUS LINE (2026-09-25, user requirement) — 「目录名 · 会话名」 for
 * the windows a pi session named, and the user's own rendering everywhere else.
 *
 * ── WHY THIS ONE THING WRITES OUTSIDE THE PACKAGE ──
 *
 * A session's name is shown by the tmux status line, which is the USER's
 * configuration — and the only honest way to change it is their config file,
 * never `tmux set -g` on a running server. (That would edit the live server
 * behind the user's back; the gate refuses it at the argv layer,
 * lib/orchestrator-tmux.ts.) So the change lands where the user can read it,
 * back it up, and revert it — and they reload it with `prefix + r`, which is
 * also how they get to see it at all.
 *
 * ── THE CONDITIONS ARE THE DESIGN ──
 *
 * A window WITHOUT `@rg_session_name` — every window the user did not name —
 * renders EXACTLY what it rendered before: the conditional's false branch is
 * the format that was already there. Only the two `window-status*-format` lines
 * are touched, and only inside their quotes.
 *
 * IDEMPOTENT, twice over: a line that already carries `@rg_session_name` is left
 * alone, and a line that does not use `#{b:pane_current_path}` at all is left
 * alone too (there is nothing to wrap, and inventing a status format for
 * somebody else's config is not this function's place). The first change backs
 * the file up.
 *
 * Not TypeScript, and deliberately: the postinstall script runs from a real
 * `node_modules` install, where Node refuses to type-strip — so the pure
 * transform and the file operation live in one importable module that BOTH the
 * installer and `test/tmux-status-format.test.ts` call. A second copy of this
 * regex would be a second answer to "was it already rewritten".
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The one expression both halves of the rewrite wrap around the path. */
export const TMUX_STATUS_CONDITIONAL =
  "#{?#{@rg_session_name},#{b:pane_current_path} · #{@rg_session_name},#{b:pane_current_path}}";

/** The option a named session writes (lib/orchestrator-tmux.ts, same spelling). */
const SESSION_NAME_OPTION = "@rg_session_name";

/**
 * `set` / `setw` with an optional `-g`, the window format double-quoted.
 * Anything else — a variable, single quotes, an assignment this does not
 * understand — is NOT rewritten: guessing at somebody's config syntax is how a
 * config file gets corrupted.
 */
const FORMAT_LINE = /^(\s*set(?:w|-option|-window-option)?\s+(?:-g\s+)?(window-status(?:-current)?-format)\s+")(.*)("\s*)$/;

/**
 * Rewrite the two format lines of a tmux config. Pure: text in, text out.
 *
 * `rewritten` counts the lines actually changed, `already` the lines that were
 * already conditional — the caller uses both to say what it did, and neither to
 * decide whether to write (writing an unchanged file is harmless, but a second
 * BACKUP of it is not).
 */
export function rewriteTmuxStatusFormat(text) {
  let rewritten = 0;
  let already = 0;
  const lines = String(text ?? "").split("\n").map((line) => {
    const match = FORMAT_LINE.exec(line);
    if (!match) return line;
    const body = match[3];
    if (body.includes(SESSION_NAME_OPTION)) {
      already += 1;
      return line;
    }
    if (!body.includes("#{b:pane_current_path}")) return line;
    rewritten += 1;
    return `${match[1]}${body.split("#{b:pane_current_path}").join(TMUX_STATUS_CONDITIONAL)}${match[4]}`;
  });
  return { text: lines.join("\n"), rewritten, already };
}

/**
 * Do it to a real file: rewrite when there is something to rewrite, back the
 * old bytes up first, report what happened. Returns what it did so a caller (or
 * a test) never has to re-read the file to find out.
 */
export function installTmuxStatusFormat(opts = {}) {
  const confPath = opts.confPath ?? join(homedir(), ".tmux.conf");
  const log = opts.log ?? (() => {});
  const stamp = opts.stamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  if (!existsSync(confPath)) {
    return { status: "missing", confPath };
  }
  let original;
  try {
    original = readFileSync(confPath, "utf8");
  } catch (error) {
    return { status: "unreadable", confPath, error: String(error?.message ?? error) };
  }
  const { text, rewritten, already } = rewriteTmuxStatusFormat(original);
  if (rewritten === 0) {
    return { status: already > 0 ? "already" : "no-format-line", confPath };
  }
  const backup = `${confPath}.bak-rg-${stamp}`;
  try {
    copyFileSync(confPath, backup);
    writeFileSync(confPath, text, "utf8");
  } catch (error) {
    return { status: "failed", confPath, backup, error: String(error?.message ?? error) };
  }
  log(`  ✓ tmux status line now shows「目录名 · 会话名」for named windows (backup: ${backup})`);
  log("    run `prefix + r` inside tmux (or `tmux source-file ~/.tmux.conf`) to reload it");
  return { status: "rewritten", confPath, backup, rewritten };
}
