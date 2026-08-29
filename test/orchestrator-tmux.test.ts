import test from "node:test";
import assert from "node:assert/strict";

import {
  FORBIDDEN_TMUX_SUBCOMMANDS,
  UnsafeTmuxCommand,
  assertSafeTmuxArgv,
  buildKillPaneArgv,
  buildListPanesArgv,
  buildRelayPaneArgv,
  buildSendMessageArgv,
  buildSpawnPaneArgv,
  isPaneId,
  parsePaneIds,
  parseSpawnedPaneId,
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
  assert.throws(() => buildSendMessageArgv("%1x", "hi"), UnsafeTmuxCommand);
  assert.throws(() => buildSpawnPaneArgv({ orchestratorPane: "", cwd: "/repo" }), UnsafeTmuxCommand);
  assert.throws(
    () => buildSpawnPaneArgv({ orchestratorPane: "%1", lastChildPane: "bogus", cwd: "/repo" }),
    UnsafeTmuxCommand,
  );
  assert.throws(() => buildRelayPaneArgv({ orchestratorPane: "x", cwd: "/repo" }), UnsafeTmuxCommand);
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

test("THE LAYOUT: the first child creates the right column, later ones stack under it", () => {
  const first = buildSpawnPaneArgv({ orchestratorPane: "%1", cwd: "/repo" });
  assert.deepEqual(first.slice(0, 4), ["split-window", "-h", "-t", "%1"],
    "no right column yet ⇒ split the ORCHESTRATOR horizontally");

  const later = buildSpawnPaneArgv({ orchestratorPane: "%1", lastChildPane: "%7", cwd: "/repo" });
  assert.deepEqual(later.slice(0, 4), ["split-window", "-v", "-t", "%7"],
    "a right column exists ⇒ stack under the LAST child, never re-split the orchestrator");
});

test("a spawn asks tmux for the new pane id — it is never guessed", () => {
  const argv = buildSpawnPaneArgv({ orchestratorPane: "%1", cwd: "/repo" });
  assert.ok(argv.includes("-P"));
  assert.deepEqual(argv.slice(argv.indexOf("-F"), argv.indexOf("-F") + 2), ["-F", "#{pane_id}"]);
  assert.deepEqual(argv.slice(argv.indexOf("-c"), argv.indexOf("-c") + 2), ["-c", "/repo"]);
  assert.equal(argv[argv.length - 1], "pi", "an interactive pi is the default command");
});

test("environment travels as -e pairs, in a stable order", () => {
  const argv = buildSpawnPaneArgv({
    orchestratorPane: "%1",
    cwd: "/repo",
    env: { RG_ORCHESTRATION_ID: "orch-abc-1", RG_GATE_MODE: "loop" },
  });
  const pairs = argv.filter((_, i) => argv[i - 1] === "-e");
  assert.deepEqual(pairs, ["RG_GATE_MODE=loop", "RG_ORCHESTRATION_ID=orch-abc-1"],
    "sorted, so the argv is testable");
});

test("a relay always splits off the orchestrator's own pane", () => {
  const argv = buildRelayPaneArgv({ orchestratorPane: "%1", cwd: "/repo" });
  assert.deepEqual(argv.slice(0, 4), ["split-window", "-h", "-t", "%1"],
    "horizontal, so closing the old pane hands the left column to the successor");
});

test("a message is sent LITERALLY and submitted separately", () => {
  const [literal, enter] = buildSendMessageArgv("%3", "run tests; then Enter C-c");
  assert.deepEqual(literal, ["send-keys", "-t", "%3", "-l", "run tests; then Enter C-c"],
    "-l means the payload is text, never key names");
  assert.deepEqual(enter, ["send-keys", "-t", "%3", "Enter"],
    "submitting is its own command, so a payload cannot submit itself early");
});

test("a multi-line message is flattened rather than half-submitted", () => {
  const [literal] = buildSendMessageArgv("%3", "line one\nline two\r\nline three  ");
  assert.equal(literal![4], "line one line two line three",
    "an embedded newline would submit the first line and leave the rest as garbage");
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
