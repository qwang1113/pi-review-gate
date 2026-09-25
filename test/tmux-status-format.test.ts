/**
 * THE STATUS-LINE REWRITE (t2, 2026-09-25) — the one thing this package writes
 * outside itself, so it is pinned rather than trusted.
 *
 * It runs against a temp file, never the user's `~/.tmux.conf`, and the three
 * properties it must have are the ones a config file deserves: the untouched
 * lines stay byte-identical, the change is conditional (an unnamed window
 * renders what it rendered before), and running it twice changes nothing — not
 * the file, and not a second backup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installTmuxStatusFormat,
  rewriteTmuxStatusFormat,
  TMUX_STATUS_CONDITIONAL,
} from "../scripts/tmux-status-format.mjs";

const USER_CONF = [
  "unbind C-b",
  "set -g prefix C-a",
  "# 鼠标模式",
  "set -g mouse on",
  "",
  'set -g window-status-current-format "#[fg=black,bg=blue] #I:#[fg=black,bg=blue]#{b:pane_current_path} "',
  'set -g window-status-format "#[fg=brightblack,bg=default] #I:#[fg=brightblack,bg=default]#{b:pane_current_path} "',
  "",
  "bind r source-file ~/.tmux.conf",
  "",
].join("\n");

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "rg-tmux-status-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("both format lines become conditional, and every other line is byte-identical", () => {
  const { text, rewritten, already } = rewriteTmuxStatusFormat(USER_CONF);
  assert.equal(rewritten, 2);
  assert.equal(already, 0);
  assert.equal(text.split(TMUX_STATUS_CONDITIONAL).length - 1, 2, "both lines carry the conditional");
  assert.equal(text.includes("#[fg=black,bg=blue] #I:#[fg=black,bg=blue]" + TMUX_STATUS_CONDITIONAL + " \""), true);
  assert.equal(text.includes("#[fg=brightblack,bg=default] #I:#[fg=brightblack,bg=default]" + TMUX_STATUS_CONDITIONAL + " \""), true);
  // The false branch IS the old format: an unnamed window renders exactly what
  // it rendered before (the path), and the name is appended only when set.
  assert.match(TMUX_STATUS_CONDITIONAL, /^#\{\?#\{@rg_session_name\},#\{b:pane_current_path\} · #\{@rg_session_name\},#\{b:pane_current_path\}\}$/);
  const before = USER_CONF.split("\n").filter((l) => !l.includes("window-status"));
  const after = text.split("\n").filter((l) => !l.includes("window-status"));
  assert.deepEqual(after, before, "nothing else in the file moved");
});

test("running it on an already-conditional file is a no-op — and so is a second run on a file it just wrote", () => {
  const once = rewriteTmuxStatusFormat(USER_CONF);
  const twice = rewriteTmuxStatusFormat(once.text);
  assert.equal(twice.rewritten, 0);
  assert.equal(twice.already, 2);
  assert.equal(twice.text, once.text, "no doubling of the conditional");
});

test("a status line this does not understand is left alone, not guessed at", () => {
  const other = [
    "set -g window-status-format \"#{b:pane_current_path}\"",
    "set -g window-status-current-format '#[fg=red]#{b:pane_current_path}'",
    "set -g window-status-format \"#{s/foo/bar:#{b:pane_current_path}}\" # trailing comment",
    "set -g status-left \"#{b:pane_current_path}\"",
    "",
  ].join("\n");
  const { text, rewritten } = rewriteTmuxStatusFormat(other);
  // The first line is rewritten (it is a format line using the path); the
  // single-quoted one and the one carrying a trailing comment are not touched:
  // this function does not parse tmux quoting, so it declines rather than guess.
  assert.equal(rewritten, 1);
  assert.equal(text.split("\n")[0], `set -g window-status-format "${TMUX_STATUS_CONDITIONAL}"`);
  assert.equal(text.split("\n")[1], `set -g window-status-current-format '#[fg=red]#{b:pane_current_path}'`);
  assert.equal(text.split("\n")[2], `set -g window-status-format "#{s/foo/bar:#{b:pane_current_path}}" # trailing comment`);
  assert.equal(text.split("\n")[3], `set -g status-left "#{b:pane_current_path}"`);
});

test("the file operation backs the old bytes up once, and leaves the name out of the summary twice", () => {
  withTempDir((dir) => {
    const conf = join(dir, ".tmux.conf");
    writeFileSync(conf, USER_CONF, "utf8");
    const first = installTmuxStatusFormat({ confPath: conf, stamp: "s1", log: () => {} });
    assert.equal(first.status, "rewritten");
    const backup = first.backup;
    assert.equal(typeof backup, "string", "a rewrite always says where the old bytes went");
    assert.equal(readFileSync(String(backup), "utf8"), USER_CONF, "the backup is the bytes as they were");
    const changed = readFileSync(conf, "utf8");
    assert.equal(changed, rewriteTmuxStatusFormat(USER_CONF).text);

    const second = installTmuxStatusFormat({ confPath: conf, stamp: "s2", log: () => {} });
    assert.equal(second.status, "already");
    assert.equal(readFileSync(conf, "utf8"), changed, "nothing rewritten the second time");
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".bak-rg-")), [".tmux.conf.bak-rg-s1"],
      "and no second backup");
  });
});

test("a missing file and a file with no such format line are both reported, not invented", () => {
  withTempDir((dir) => {
    assert.equal(installTmuxStatusFormat({ confPath: join(dir, "nope"), log: () => {} }).status, "missing");
    const conf = join(dir, ".tmux.conf");
    writeFileSync(conf, "set -g mouse on\n", "utf8");
    const result = installTmuxStatusFormat({ confPath: conf, log: () => {} });
    assert.equal(result.status, "no-format-line");
    assert.equal(readFileSync(conf, "utf8"), "set -g mouse on\n");
  });
});
