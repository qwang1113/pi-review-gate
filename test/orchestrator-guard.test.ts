import test from "node:test";
import assert from "node:assert/strict";

import {
  ALWAYS_FORBIDDEN,
  TOOL_REPLACED,
  detectForbiddenTmux,
} from "../lib/orchestrator-guard.ts";

const ORCH = { orchestratorMode: true };
const LOOP = { orchestratorMode: false };

/**
 * COVERAGE CONTRACT (task book §11): every entry of the forbidden list has a
 * test. These two loops are what make that mechanical rather than a promise —
 * adding a rule to either list without a case here fails the suite.
 */
test("every ALWAYS-FORBIDDEN subcommand is refused, in both modes", () => {
  assert.deepEqual([...ALWAYS_FORBIDDEN].sort(), [
    "kill-server", "kill-session", "kill-window", "new-session", "new-window",
  ], "the forbidden list itself is pinned — adding one silently is not possible");
  for (const sub of ALWAYS_FORBIDDEN) {
    for (const mode of [ORCH, LOOP]) {
      const hit = detectForbiddenTmux(`tmux ${sub}`, mode);
      assert.ok(hit, `tmux ${sub} must be refused (orchestratorMode=${mode.orchestratorMode})`);
      assert.equal(hit.subcommand, sub);
      assert.equal(hit.tier, "forbidden");
      assert.match(hit.reason, /禁止/);
    }
  }
});

test("every TOOL-REPLACED subcommand is redirected in orchestrator mode and left alone otherwise", () => {
  assert.deepEqual([...TOOL_REPLACED].sort(), ["kill-pane", "send-keys", "split-window"]);
  const expectedTool: Record<string, RegExp> = {
    "split-window": /orchestrator_spawn/,
    "send-keys": /orchestrator_send/,
    "kill-pane": /orchestrator_close/,
  };
  for (const sub of TOOL_REPLACED) {
    const hit = detectForbiddenTmux(`tmux ${sub} -t %3`, ORCH);
    assert.ok(hit, `tmux ${sub} must be redirected in orchestrator mode`);
    assert.equal(hit.tier, "use-the-tool");
    assert.match(hit.reason, expectedTool[sub]!, "the refusal names the tool to call instead");
    assert.equal(detectForbiddenTmux(`tmux ${sub} -t %3`, LOOP), undefined,
      `${sub} is nobody's business outside orchestrator mode`);
  }
});

test("short aliases reach the same rules", () => {
  for (const [alias, canonical] of [
    ["new", "new-session"],
    ["neww", "new-window"],
    ["killw", "kill-window"],
  ] as const) {
    const hit = detectForbiddenTmux(`tmux ${alias}`, LOOP);
    assert.ok(hit, `${alias} must not slip through by being spelled differently`);
    assert.equal(hit.subcommand, canonical);
  }
  const killp = detectForbiddenTmux("tmux killp -t %1", ORCH);
  assert.equal(killp?.subcommand, "kill-pane");
  const splitw = detectForbiddenTmux("tmux splitw -h", ORCH);
  assert.equal(splitw?.subcommand, "split-window");
});

test("a global option write is refused; a LOCAL one is not", () => {
  for (const cmd of [
    "tmux set -g status off",
    "tmux set-option -g mouse on",
    "tmux setw -g mode-keys vi",
    "tmux set-window-option -g automatic-rename off",
  ]) {
    const hit = detectForbiddenTmux(cmd, LOOP);
    assert.ok(hit, `${cmd} must be refused — that is the user's own configuration`);
    assert.equal(hit.tier, "forbidden");
    assert.match(hit.reason, /全局/);
  }
  assert.equal(detectForbiddenTmux("tmux set -t %2 remain-on-exit on", LOOP), undefined,
    "a pane-local option is not the user's global config");
});

test("kill-pane -a is destructive in EVERY mode — it sweeps the user's panes too", () => {
  const hit = detectForbiddenTmux("tmux kill-pane -a -t %1", LOOP);
  assert.ok(hit, "-a is not the same operation as closing one pane");
  assert.equal(hit.tier, "forbidden");
  assert.match(hit.reason, /其他所有 pane/);
  // And in orchestrator mode it is still the destructive rule, not the redirect.
  assert.equal(detectForbiddenTmux("tmux kill-pane -a", ORCH)?.tier, "forbidden");
});

test("tmux's own global flags do not hide the subcommand", () => {
  for (const cmd of [
    "tmux -L work kill-server",
    "tmux -S /tmp/sock kill-session -t x",
    "tmux -2 -u kill-window",
    "tmux -f /dev/null new-session",
  ]) {
    assert.ok(detectForbiddenTmux(cmd, LOOP), `${cmd} must still be seen`);
  }
});

test("the guard follows compound commands and a path to tmux", () => {
  assert.ok(detectForbiddenTmux("cd /tmp && tmux kill-server", LOOP));
  assert.ok(detectForbiddenTmux("echo hi; /usr/local/bin/tmux kill-session", LOOP));
  assert.ok(detectForbiddenTmux("ls | tmux new-window", LOOP));
});

test("SECURITY: a wrapper or a nested shell does not hide the command", () => {
  // All of these were measured PASSING through the first version of this
  // guard, which only looked at the first token of a segment.
  for (const cmd of [
    "FOO=bar tmux kill-server",
    "TMUX_TMPDIR=/tmp tmux kill-window",
    "command tmux kill-server",
    "env tmux kill-server",
    "env -i tmux kill-server",
    "sudo -u someone tmux kill-session -t x",
    "nohup tmux kill-server &",
    "sh -c 'tmux kill-server'",
    'bash -c "tmux new-window"',
    "eval 'tmux kill-session'",
  ]) {
    const hit = detectForbiddenTmux(cmd, LOOP);
    assert.ok(hit, `${cmd} must not slip through`);
    assert.equal(hit.tier, "forbidden");
  }
});

test("QUOTED text is data for the PRECISE path, and the sweep needs tmux nearby", () => {
  // The fail-closed sweep only engages when the segment actually invokes tmux
  // or a nested shell, so prose about tmux in an unrelated command stays out.
  assert.equal(detectForbiddenTmux('git commit -m "do not run kill-session"', LOOP), undefined,
    "a commit message mentioning a subcommand is not an invocation");
  assert.equal(detectForbiddenTmux('grep -n "kill-window" notes.md', LOOP), undefined);
  assert.equal(detectForbiddenTmux('echo "read the tmux manual"', LOOP), undefined,
    "mentioning tmux without a destructive subcommand is not a hit");
  // Prose ALONE stays out: with no tmux invocation and no shell in the
  // segment, there is nothing that could execute.
  assert.equal(detectForbiddenTmux('echo "tmux kill-server"', LOOP), undefined,
    "quoting it into an echo is not running it");
  // But the moment that same string is piped INTO a shell, it is a command
  // again — and the payload lives in another segment, so the bare-shell case
  // sweeps the whole line (the same move lib/ship-detect.ts makes for git).
  assert.ok(detectForbiddenTmux('echo "tmux kill-server" | sh', LOOP),
    "piped-to-shell is the classic way to launder a command past a token check");
});

test("ordinary tmux use is untouched", () => {
  for (const cmd of [
    "tmux list-panes -F '#{pane_id}'",
    "tmux display-message -p '#{pane_id}'",
    "tmux capture-pane -p -t %1",
    "tmux ls",
  ]) {
    assert.equal(detectForbiddenTmux(cmd, ORCH), undefined, `${cmd} must pass`);
  }
  assert.equal(detectForbiddenTmux("", ORCH), undefined);
  assert.equal(detectForbiddenTmux("git status", ORCH), undefined);
});

test("the FIRST hit is reported, with the offending segment", () => {
  const hit = detectForbiddenTmux("git status && tmux kill-server && echo done", LOOP);
  assert.ok(hit);
  assert.equal(hit.segment, "tmux kill-server", "the message can point at what was refused");
});
