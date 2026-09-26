/**
 * `prefix + e` IN THE USER'S ~/.tmux.conf (s1, 2026-09-27) — against temp
 * files only. Appended once, backed up first, the user's own `bind e` wins,
 * and a package under node_modules is never bound.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendSidebarBind,
  installTmuxSidebarBind,
  SIDEBAR_BIND_MARKER,
  sidebarBindLine,
} from "../scripts/tmux-sidebar-bind.mjs";

const USER_CONF = "set -g prefix C-a\nset -g mouse on\nbind r source-file ~/.tmux.conf\n";
const LINE = sidebarBindLine("/usr/bin/node", "/pkg/scripts/tmux-sidebar.ts");

test("the line runs the sidebar's toggle on the pressed pane", () => {
  assert.equal(LINE, `bind e run-shell "'/usr/bin/node' '/pkg/scripts/tmux-sidebar.ts' toggle '#{pane_id}'"`);
});

test("append: once, then already; a moved package updates our line in place", () => {
  const first = appendSidebarBind(USER_CONF, LINE);
  assert.equal(first.status, "appended");
  assert.ok(first.text.startsWith(USER_CONF), "the user's lines are untouched");
  assert.ok(first.text.endsWith(`${SIDEBAR_BIND_MARKER}\n${LINE}\n`));
  assert.deepEqual(appendSidebarBind(first.text, LINE), { text: first.text, status: "already" });
  const moved = sidebarBindLine("/usr/bin/node", "/elsewhere/scripts/tmux-sidebar.ts");
  const updated = appendSidebarBind(first.text, moved);
  assert.equal(updated.status, "updated");
  assert.equal(updated.text.split("\n").filter((l) => l.startsWith("bind e")).length, 1, "replaced, not doubled");
  assert.equal(appendSidebarBind("set -g mouse on", LINE).text, `set -g mouse on\n\n${SIDEBAR_BIND_MARKER}\n${LINE}\n`);
});

test("a user binding of e is never overridden", () => {
  for (const own of [
    "bind e split-window", "bind-key -r e resize-pane", "  bind e",
    "bind-key -T prefix e display-message mine", "bind -N \"my note\" e x", "bind -r -T prefix e x",
  ]) {
    const result = appendSidebarBind(`${USER_CONF}${own}\n`, LINE);
    assert.equal(result.status, "conflict", own);
    assert.equal(result.text, `${USER_CONF}${own}\n`);
  }
  assert.equal(appendSidebarBind("bind enter x\n", LINE).status, "appended", "only the key e itself");
  assert.equal(appendSidebarBind("bind -T prefix E x\n", LINE).status, "appended", "E is another key");
});

test("install: backup on the first change only, missing file, node_modules and quoted paths skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-sidebar-bind-"));
  try {
    const confPath = join(dir, "tmux.conf");
    writeFileSync(confPath, USER_CONF);
    const opts = { confPath, root: "/pkg", node: "/usr/bin/node", stamp: "s1" };
    assert.equal(installTmuxSidebarBind(opts).status, "appended");
    const once = readFileSync(confPath, "utf8");
    assert.equal(readFileSync(`${confPath}.bak-rg-s1`, "utf8"), USER_CONF, "the backup is the old bytes");
    assert.equal(installTmuxSidebarBind({ ...opts, stamp: "s2" }).status, "already");
    assert.equal(readFileSync(confPath, "utf8"), once, "second run changes nothing");
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".bak-rg-")), ["tmux.conf.bak-rg-s1"], "and makes no second backup");

    assert.equal(installTmuxSidebarBind({ ...opts, confPath: join(dir, "absent") }).status, "missing");
    assert.equal(installTmuxSidebarBind({ ...opts, root: "/app/node_modules/pi-review-gate" }).status, "node-modules");
    assert.equal(installTmuxSidebarBind({ ...opts, root: "/it's/here" }).status, "unsafe-path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
