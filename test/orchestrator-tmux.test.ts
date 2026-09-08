import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FORBIDDEN_TMUX_SUBCOMMANDS,
  UnsafeTmuxCommand,
  assertSafeTmuxArgv,
  buildEvenLayoutArgv,
  buildKillPaneArgv,
  buildWindowLayoutArgv,
  buildListPanesArgv,
  buildHandoffPaneArgv,
  buildSpawnPaneArgv,
  isPaneId,
  parsePaneIds,
  parseSpawnedPaneId,
  parseWindowLayout,
  planPanePlacement,
} from "../lib/orchestrator-tmux.ts";

test("a pane id is validated, never trusted", () => {
  for (const good of ["%0", "%12", "%9999"]) assert.equal(isPaneId(good), true);
  for (const bad of ["", "12", "pane12", "%", "%1a", "%-1", "@1", "%1;rm -rf /", undefined, null, 12]) {
    assert.equal(isPaneId(bad), false, `${JSON.stringify(bad)} is not a pane id`);
  }
});

test("every builder REFUSES a bad pane id rather than interpolating it", () => {
  // The commands are argv (no shell), so this is not about quoting — it is
  // about never addressing a target we did not get from tmux itself.
  assert.throws(() => buildKillPaneArgv("not-a-pane"), UnsafeTmuxCommand);
  assert.throws(() => buildListPanesArgv("$(whoami)"), UnsafeTmuxCommand);
  assert.throws(
    () => buildSpawnPaneArgv({ placement: { direction: "-h", target: "" }, cwd: "/repo" }),
    UnsafeTmuxCommand,
  );
  assert.throws(
    () => buildSpawnPaneArgv({ placement: { direction: "-v", target: "bogus" }, cwd: "/repo" }),
    UnsafeTmuxCommand,
  );
  assert.throws(() => buildEvenLayoutArgv("%1;rm -rf /"), UnsafeTmuxCommand);
  assert.throws(() => buildWindowLayoutArgv("not-a-pane"), UnsafeTmuxCommand);
  assert.throws(() => buildHandoffPaneArgv({ orchestratorPane: "x", cwd: "/repo" }), UnsafeTmuxCommand);
});

test("the gate holds ITSELF to the forbidden list", () => {
  // "the gate is exempt from the bash guard" must never come to mean "the
  // gate may do the forbidden thing".
  assert.deepEqual([...FORBIDDEN_TMUX_SUBCOMMANDS].sort(),
    ["kill-server", "kill-session", "kill-window", "new", "new-session", "new-window", "neww"]);
  for (const sub of FORBIDDEN_TMUX_SUBCOMMANDS) {
    assert.throws(() => assertSafeTmuxArgv([sub, "-t", "%1"]), UnsafeTmuxCommand, `${sub} must be refused`);
  }
  assert.throws(() => assertSafeTmuxArgv(["set-option", "-g", "mouse", "on"]), UnsafeTmuxCommand);
  assert.throws(() => assertSafeTmuxArgv(["setw", "-g", "x", "y"]), UnsafeTmuxCommand);
  assert.throws(() => assertSafeTmuxArgv([]), UnsafeTmuxCommand);
  assert.doesNotThrow(() => assertSafeTmuxArgv(["set-option", "-t", "%1", "remain-on-exit", "on"]),
    "a pane-local option is fine");
});

test("THE LAYOUT: fewer than three columns opens a new one, three stacks in the third", () => {
  const panes = (...ids: string[]) => ids.map((id, top) => ({ id, left: 0, top }));
  assert.deepEqual(planPanePlacement([panes("%1")]), { direction: "-h", target: "%1" },
    "one column ⇒ open a second one off the only pane");
  assert.deepEqual(planPanePlacement([panes("%1"), panes("%2")]), { direction: "-h", target: "%2" },
    "two columns ⇒ open the third beside the rightmost column's lone pane");
  // The lone pane decides WHERE (a plain split beside it lands where the third
  // column belongs, keeping the SHARED column rightmost); `-f` is the fallback
  // for the shape with no lone column, where a plain split would nest.
  assert.deepEqual(
    planPanePlacement([panes("%1"), panes("%2", "%3", "%4")]),
    { direction: "-h", target: "%1" },
    "the rightmost column already shares its height ⇒ open beside the column that sits alone",
  );
  assert.deepEqual(
    planPanePlacement([panes("%1", "%2"), panes("%3", "%4")]),
    { direction: "-h", target: "%4", full: true },
    "no column sits alone ⇒ -f still opens a real column",
  );
  assert.deepEqual(
    planPanePlacement([panes("%1"), panes("%2"), panes("%3", "%4", "%5")]),
    { direction: "-v", target: "%5" },
    "three columns ⇒ stack under the THIRD column's last pane, never open a fourth",
  );
  assert.deepEqual(
    planPanePlacement([panes("%1"), panes("%2"), panes("%3"), panes("%4")]),
    { direction: "-v", target: "%3" },
    "a window that is ALREADY too wide is not merged: the new pane still lands in the third column",
  );
  assert.throws(() => planPanePlacement([]), /非空/, "an empty layout is a bug, not a layout");
});

test("the window's geometry is grouped by pane_left, never guessed", () => {
  // What tmux actually printed on a scratch server after three horizontal
  // splits and two vertical ones: the third column's panes share a left.
  const layout = parseWindowLayout([
    "%3 100 25 0",
    "%1 0 0 0",
    "%4 100 50 0",
    "%2 100 0 0",
  ].join("\n"));
  assert.deepEqual(layout.columns.map((c) => c.map((p) => p.id)), [["%1"], ["%2", "%3", "%4"]],
    "columns left→right, panes within a column top→bottom");
  assert.equal(layout.zoomed, false);
  assert.equal(parseWindowLayout("%1 0 0 1").zoomed, true, "a zoomed pane is reported, so equalising can stand down");
  assert.deepEqual(parseWindowLayout("no server running").columns, [], "noise is not a layout");
  assert.deepEqual(parseWindowLayout("%1 0 0").columns, [[{ id: "%1", left: 0, top: 0 }]],
    "a build that does not print the zoom flag still yields the geometry");
});

test("equalising addresses ONE pane — tmux spreads that pane's parent container", () => {
  // The whole three-column rule rests on this: a third-column pane spreads
  // that column's HEIGHTS, a first-column pane spreads the COLUMNS' widths.
  assert.deepEqual(buildEvenLayoutArgv("%5"), ["select-layout", "-E", "-t", "%5"]);
});

test("the layout probe asks for the geometry and nothing else", () => {
  assert.deepEqual(buildWindowLayoutArgv("%5"), [
    "list-panes", "-t", "%5", "-F", "#{pane_id} #{pane_left} #{pane_top} #{window_zoomed_flag}",
  ]);
});

test("a spawn asks tmux for the new pane id — it is never guessed", () => {
  const argv = buildSpawnPaneArgv({ placement: { direction: "-h", target: "%1" }, cwd: "/repo" });
  assert.deepEqual(argv.slice(0, 4), ["split-window", "-h", "-t", "%1"]);
  assert.deepEqual(argv.slice(argv.indexOf("-F"), argv.indexOf("-F") + 2), ["-F", "#{pane_id}"]);
  assert.deepEqual(argv.slice(argv.indexOf("-c"), argv.indexOf("-c") + 2), ["-c", "/repo"]);
  assert.equal(argv[argv.length - 1], "pi", "an interactive pi is the default command");
});

test("a new column carries -f; stacking inside a column does not", () => {
  const opening = buildSpawnPaneArgv({
    placement: { direction: "-h", target: "%5", full: true },
    cwd: "/repo",
  });
  assert.deepEqual(opening.slice(0, 5), ["split-window", "-h", "-f", "-t", "%5"],
    "-f spans the window height, so the split is a real column wherever the target sits");
  assert.ok(opening.includes("-P") && opening.includes("-F"), "and tmux still prints the new pane id");
  const stacking = buildSpawnPaneArgv({ placement: { direction: "-v", target: "%5" }, cwd: "/repo" });
  assert.ok(!stacking.includes("-f"), "-f would make the new pane full-width and wreck the third column");
});

test("environment travels as -e pairs, in a stable order", () => {
  const argv = buildSpawnPaneArgv({
    placement: { direction: "-v", target: "%1" },
    cwd: "/repo",
    env: { RG_ORCHESTRATION_ID: "orch-abc-1", RG_GATE_MODE: "loop" },
  });
  const pairs = argv.filter((_, i) => argv[i - 1] === "-e");
  assert.deepEqual(pairs, ["RG_GATE_MODE=loop", "RG_ORCHESTRATION_ID=orch-abc-1"],
    "sorted, so the argv is testable");
});

test("a handoff always splits off the orchestrator's own pane", () => {
  const argv = buildHandoffPaneArgv({ orchestratorPane: "%1", cwd: "/repo" });
  assert.deepEqual(argv.slice(0, 4), ["split-window", "-h", "-t", "%1"],
    "horizontal, so closing the old pane hands the left column to the successor");
});

test("NOTHING in this module can type at a pane any more (2026-08-30)", () => {
  // Philosophy three, asserted rather than assumed. `send-keys` produced four
  // separate measured defects (truncation, no submit, the wrong lane, a
  // newline read as a menu selection); text and answers now travel through
  // the child's channel, so the builders that typed are DELETED — not left
  // unused, which is how a removed path comes back.
  const source = readFileSync(new URL("../lib/orchestrator-tmux.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"send-keys"/, "no builder may emit send-keys");
  assert.doesNotMatch(source, /"capture-pane"/, "and nothing here reads a screen");
});


test("kill and list address a PANE and nothing wider", () => {
  assert.deepEqual(buildKillPaneArgv("%5"), ["kill-pane", "-t", "%5"]);
  assert.deepEqual(buildListPanesArgv("%5"), ["list-panes", "-t", "%5", "-F", "#{pane_id}"]);
});

test("tmux output is parsed strictly", () => {
  assert.deepEqual(parsePaneIds("%1\n%2\n\n  %3  \n"), ["%1", "%2", "%3"]);
  assert.deepEqual(parsePaneIds("error: no server running"), [], "noise is not a pane list");
  assert.equal(parseSpawnedPaneId("%42\n"), "%42");
  assert.equal(parseSpawnedPaneId(""), undefined, "no id ⇒ the caller must roll back, not guess");
  assert.equal(parseSpawnedPaneId("no such window"), undefined);
});
