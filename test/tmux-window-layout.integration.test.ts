/**
 * THE THREE-COLUMN RULE, MEASURED AGAINST A REAL TMUX (2026-09-08).
 *
 * The rule rests on two behaviours of tmux itself, and both were believed
 * before they were measured:
 *
 *   - a same-direction `split-window` is FLATTENED into the container that
 *     already holds the target, so splitting the second column's pane yields a
 *     third SIBLING column rather than a nested one;
 *   - `select-layout -E` spreads the target pane's PARENT container, so the
 *     target picks the axis: a third-column pane equalises heights, a
 *     first-column pane equalises widths.
 *
 * The unit tests pin the argv; only this file pins what tmux DOES with it. It
 * drives the production functions rather than a copy of them — `openSessionPane`
 * is given a runner that executes the very argv the gate would execute.
 *
 * It runs on its OWN tmux socket (`-L rg-layout-lab-<pid>`), never the user's
 * server, and destroys it afterwards. No tmux ⇒ skipped, not failed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { buildWindowLayoutArgv, parseWindowLayout } from "../lib/orchestrator-tmux.ts";
import { closeSessionPane, openSessionPane, type PaneRunner } from "../lib/session-factory.ts";

const SOCKET = `rg-layout-lab-${process.pid}`;

function tmux(args: readonly string[]): string {
  // stderr is piped, not inherited: `kill-server` on a socket with no server
  // yet is the normal first step and must not print noise into the run.
  return execFileSync("tmux", ["-L", SOCKET, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tmuxInstalled(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SKIP = tmuxInstalled() ? false : "tmux is not installed";

/** The gate's own runner, backed by the lab server. */
const runner: PaneRunner = (argv) => {
  try {
    return { ok: true, stdout: tmux([...argv]), stderr: "" };
  } catch (error) {
    return { ok: false, stdout: "", stderr: String(error) };
  }
};

/** Open one more session the way the gate does, and return nothing but truth. */
async function openLabSession(ownPane: string, n: number): Promise<void> {
  const outcome = await openSessionPane(runner, {
    ownPane,
    cwd: "/tmp",
    layout: "child-column",
    role: { kind: "judge", openerId: "lab", judgeId: `lab-${n}`, role: "reviewer" },
    command: ["sleep", "600"],
  });
  assert.equal(outcome.ok, true, `session ${n} opened`);
}

/** `pane_id width height`, straight from tmux. */
function geometry(): { id: string; width: number; height: number }[] {
  return tmux(["list-panes", "-F", "#{pane_id} #{pane_width} #{pane_height}"])
    .trim()
    .split("\n")
    .map((line) => {
      const [id, width, height] = line.trim().split(/\s+/);
      return { id: id!, width: Number(width), height: Number(height) };
    });
}

const spread = (values: number[]): number => Math.max(...values) - Math.min(...values);

test("six sessions stay three columns, third column evenly shared", { skip: SKIP }, async () => {
  try {
    try { tmux(["kill-server"]); } catch { /* no server yet */ }
    tmux(["new-session", "-d", "-x", "200", "-y", "50", "-s", "lab", "sleep", "600"]);
    const own = tmux(["list-panes", "-F", "#{pane_id}"]).trim().split("\n")[0]!;

    for (let n = 1; n <= 5; n++) await openLabSession(own, n);

    const layout = parseWindowLayout(tmux(buildWindowLayoutArgv(own)));
    assert.equal(layout.columns.length, 3, "six sessions, still three columns");
    assert.deepEqual(
      layout.columns.map((column) => column.length),
      [1, 1, 4],
      "first two columns hold one pane each; the third holds the rest",
    );

    const byId = new Map(geometry().map((p) => [p.id, p]));
    const widths = layout.columns.map((column) => byId.get(column[0]!.id)!.width);
    assert.ok(spread(widths) <= 1, `columns are equal width, got ${widths.join("/")}`);

    const heights = layout.columns[2]!.map((pane) => byId.get(pane.id)!.height);
    assert.ok(spread(heights) <= 1, `third column heights are even, got ${heights.join("/")}`);

    // Close one pane of the shared column: what is left must be even again.
    assert.equal(closeSessionPane(runner, layout.columns[2]![0]!.id).ok, true);
    const after = parseWindowLayout(tmux(buildWindowLayoutArgv(own)));
    assert.equal(after.columns.length, 3, "closing a pane never changes the column count here");
    assert.equal(after.columns[2]!.length, 3);
    const afterById = new Map(geometry().map((p) => [p.id, p]));
    const afterHeights = after.columns[2]!.map((pane) => afterById.get(pane.id)!.height);
    assert.ok(spread(afterHeights) <= 1, `the remaining panes re-even, got ${afterHeights.join("/")}`);

    // NOW THE TRAP (reviewer P1, 2026-09-08). Close the SECOND column and the
    // third column's panes BECOME the second one. Opening the next session off
    // that column's last pane nests a half-width pane inside it — so the rule
    // has to pick a pane that sits alone, and the new column must really
    // appear. This is the one path a pure unit test cannot prove.
    assert.equal(closeSessionPane(runner, after.columns[1]![0]!.id).ok, true);
    const two = parseWindowLayout(tmux(buildWindowLayoutArgv(own)));
    assert.equal(two.columns.length, 2, "closing the second column leaves two");
    assert.ok(two.columns[1]!.length > 1, "and the surviving column holds several panes");

    await openLabSession(own, 6);
    const three = parseWindowLayout(tmux(buildWindowLayoutArgv(own)));
    assert.equal(three.columns.length, 3, "the next session opens a REAL third column, not a nest");
    assert.deepEqual(
      three.columns.map((column) => column.length),
      [1, 1, two.columns[1]!.length],
      "one pane each in the first two columns, the rest still sharing the third",
    );
  } finally {
    try { tmux(["kill-server"]); } catch { /* already gone */ }
  }
});
