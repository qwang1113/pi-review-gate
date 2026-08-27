/**
 * tmux judge-child substrate — pure + integration tests.
 *
 * Pure: name sanitization ('.' / ':' forbidden — the unkillable-orphan
 * pitfall), host detection. Integration (skipped when tmux is unavailable):
 * pane spawn / alive / send / capture / signal / kill against a real tmux
 * server. Every integration test runs inside its OWN detached session
 * (passed as the spawn `target`) so the main session's window is never
 * touched — that mistake once killed the main window mid-experiment.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SESSION_NAME,
  TMUX_SESSION_PREFIX,
  capturePane,
  hostInTmux,
  killPane,
  killSession,
  paneAlive,
  paneCurrentPath,
  safeSessionName,
  sendMessage,
  sendRawKeys,
  sessionAlive,
  spawnJudgePane,
  spawnSession,
  tmuxAvailable,
  waitForSignal,
  waitForSignalAsync,
} from "../lib/tmux-session.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";


/** Parse `list-panes -F` output into a pane-id → {left, top} map. */
function capturePaneTarget(sess: string): Record<string, { left: number; top: number }> {
  const out = execFileSync("tmux", ["list-panes", "-t", sess, "-F", "#{pane_id}|#{pane_left}|#{pane_top}"], {
    encoding: "utf8",
  });
  const map: Record<string, { left: number; top: number }> = {};
  for (const line of out.trim().split("\n")) {
    const [id, left, top] = line.split("|");
    if (id) map[id] = { left: Number(left), top: Number(top) };
  }
  return map;
}
test("safeSessionName forbids '.' and ':' (the unkillable-orphan pitfall)", () => {
  assert.equal(safeSessionName("rg-dot.test"), "rg-dot-test");
  assert.equal(safeSessionName("a:b"), "a-b");
  // trim happens AFTER slice: a truncated name cannot end in '-'
  const long = "x".repeat(MAX_SESSION_NAME + 5);
  const capped = safeSessionName(long);
  assert.ok(capped.length <= MAX_SESSION_NAME);
  assert.ok(!capped.endsWith("-"));
  assert.equal(safeSessionName("!!!"), "rg-child");
});

test("TMUX_SESSION_PREFIX keeps gate sessions identifiable", () => {
  assert.equal(TMUX_SESSION_PREFIX, "rg-");
});

test("hostInTmux reflects the environment", () => {
  assert.equal(typeof hostInTmux(), "boolean");
});

const integration = test("tmux integration: pane spawn→send→signal→capture→kill", { skip: !tmuxAvailable() }, async () => {
  const work = mkdtempSync(join(tmpdir(), "rg-tmux-test-"));
  const sess = `rg-test-${Date.now().toString(36)}`;
  try {
    // isolated session: the main window must never be split
    assert.equal(spawnSession({ name: sess, cwd: work, command: "sleep 300" }).ok, true);

    const spawned = spawnJudgePane({
      title: "role-a",
      cwd: work,
      command: "echo PANE-READY && exec bash --noprofile --norc -i",
      target: sess,
    });
    assert.equal(spawned.ok, true, spawned.error ?? "spawn failed");
    const pane = spawned.paneId!;
    assert.ok(pane.startsWith("%"));
    assert.ok(paneAlive(pane));

    // A SECOND judge must stack in the right column — splitting it off the
    // FIRST judge pane (round-2 finding: without -t, tmux splits the
    // TMUX_PANE owner, the main pane, landing the judge below the main
    // session instead of in the column).
    const second = spawnJudgePane({
      title: "role-b",
      cwd: work,
      command: "echo PANE-B && sleep 300",
      target: pane,
    });
    assert.equal(second.ok, true, second.error ?? "spawn failed");
    assert.ok(second.paneId !== undefined && second.paneId !== pane);
    const layout = capturePaneTarget(sess);
    const judgeA = layout[pane];
    const judgeB = layout[second.paneId!];
    assert.ok(judgeA !== undefined && judgeB !== undefined, `both judges visible: ${JSON.stringify(layout)}`);
    // same column (left edge equal), different rows (vertical stack)
    assert.equal(judgeA!.left, judgeB!.left);
    assert.notEqual(judgeA!.top, judgeB!.top);

    // the pane really runs at the requested cwd (symlinks resolved on both sides)
    await new Promise((r) => setTimeout(r, 600));
    const path = paneCurrentPath(pane);
    const { realpathSync } = await import("node:fs");
    assert.ok(path !== undefined && realpathSync(work) === realpathSync(path));

    // single-line send executes in the interactive shell
    const marker = join(work, "got.txt");
    assert.equal(sendMessage(pane, `echo got-it > '${marker}'`), true);
    await new Promise((r) => setTimeout(r, 700));
    const { readFileSync, existsSync } = await import("node:fs");
    assert.equal(existsSync(marker), true);
    assert.equal(readFileSync(marker, "utf8").trim(), "got-it");

    // multi-line send is REFUSED, not shredded (round-1 P2)
    assert.throws(() => sendMessage(pane, "line1\nline2"), /multi-line/);

    // wait-for signal protocol, both sync and async sides
    const { spawn } = await import("node:child_process");
    const sig = spawn("tmux", ["wait-for", "-S", `${sess}-done`]);
    await new Promise((r) => sig.on("exit", r));
    assert.equal(waitForSignal(`${sess}-done`, 5_000), true);
    const sig2 = spawn("tmux", ["wait-for", "-S", `${sess}-done2`]);
    await new Promise((r) => sig2.on("exit", r));
    const h = waitForSignalAsync(`${sess}-done2`);
    assert.equal(await h.promise, true);

    // capture returns text
    const paneText = capturePane(pane, { history: 50 });
    assert.ok(paneText !== undefined && paneText.includes("PANE-READY"));

    // sendRawKeys interrupts (harmless here)
    assert.equal(sendRawKeys(pane, "C-c"), true);

    // kill and confirm gone
    assert.equal(killPane(pane), true);
    assert.equal(paneAlive(pane), false);
  } finally {
    killSession(sess);
    rmSync(work, { recursive: true, force: true });
  }
});

const dyingPane = test("tmux integration: pane-mode remain-on-exit retains a fast-dying judge (round-3 P2)", { skip: !tmuxAvailable() }, async () => {
  const work = mkdtempSync(join(tmpdir(), "rg-tmux-diepane-"));
  const sess = `rg-diepane-${Date.now().toString(36)}`;
  try {
    // Round-5 P2: create the target session with RAW tmux so remain-on-exit
    // is NOT already on its window — the old spawnSession-based setup made
    // the test pass even with the -t derivation deleted (mutation-verified
    // by the reviewer). With a raw session, only the pre-split set-option
    // (targeted at this window) can retain the dying pane.
    execFileSync("tmux", ["new-session", "-d", "-s", sess, "-c", work, "sleep 300"], { encoding: "utf8" });
    const spawned = spawnJudgePane({
      title: "dying",
      cwd: work,
      command: "exit 7",
      target: sess,
    });
    assert.equal(spawned.ok, true, spawned.error ?? "spawn failed");
    const pane = spawned.paneId!;
    await new Promise((r) => setTimeout(r, 800));
    // the pane SURVIVES (retained for diagnosis) but is DEAD — pre-split
    // set-option is what makes this measurable; -t derivation means the
    // option lands on the split's own window (round-4 P2).
    assert.equal(paneAlive(pane), false);
    const dead = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_dead}"], { encoding: "utf8" });
    assert.equal(dead.trim(), "1");
  } finally {
    killSession(sess);
    rmSync(work, { recursive: true, force: true });
  }
});

const dying = test("tmux integration: remain-on-exit is atomic (round-1 F1)", { skip: !tmuxAvailable() }, async () => {
  const work = mkdtempSync(join(tmpdir(), "rg-tmux-die-"));
  const sess = `rg-die-${Date.now().toString(36)}`;
  try {
    // A child that dies at startup must NOT take the session with it: the
    // remain-on-exit option is set in the SAME tmux invocation, and the
    // result must not claim ok for a session that is already gone.
    const res = spawnSession({ name: sess, cwd: work, command: "exit 3" });
    assert.equal(res.ok, true, res.error ?? "spawn failed");
    assert.equal(res.name, sess);
    // The child needs a beat to exit; then the session SURVIVES
    // (remain-on-exit keeps the pane for diagnosis) but the pane is DEAD,
    // so liveness is false.
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(sessionAlive(sess), false);
    // reaching here means has-session exited 0 → the session exists
    execFileSync("tmux", ["has-session", "-t", sess], { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
  } finally {
    killSession(sess);
    rmSync(work, { recursive: true, force: true });
  }
});

