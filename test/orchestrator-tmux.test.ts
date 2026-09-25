/**
 * THE argv BUILDERS AND THE SAFETY DOOR (2026-09-25 topology).
 *
 * What is pinned here is the SHAPE of the commands and, more importantly, WHO
 * may be addressed by them: `new-session` / `new-window` / `kill-window` /
 * `kill-session` are commands the agent must never improvise, and the gate now
 * genuinely needs all four. The tests below exist to make sure the door that
 * lets them through requires a session name and that the argv's own target
 * names it — including through the short aliases.
 *
 * The three-column layout it replaced has no test left because it has no code
 * left; the last test in this file asserts that absence by SHAPE (no exported
 * symbol of that kind, no builder emitting the equaliser), so a resurrected
 * copy cannot pass unnoticed without the assertion naming it — the round's exit
 * criterion is that those identifiers appear nowhere in the tree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  NEVER_ALLOWED_TMUX_SUBCOMMANDS,
  OWN_SESSION_TMUX_SUBCOMMANDS,
  SESSION_OWNER_OPTION,
  UnsafeTmuxCommand,
  assertSafeTmuxArgv,
  buildHandoffPaneArgv,
  buildKillPaneArgv,
  buildKillSessionArgv,
  buildKillWindowArgv,
  buildListServerPanesArgv,
  buildListSessionsArgv,
  buildNewSessionArgv,
  buildNewWindowArgv,
  buildReadSessionOwnerArgv,
  buildSetSessionOwnerArgv,
  isOwnSessionName,
  isPaneId,
  isWindowId,
  parsePaneIds,
  parseSessionNames,
  parseSpawnedPaneId,
  parseSpawnedWindow,
  parseWindowCoords,
} from "../lib/orchestrator-tmux.ts";

const SESSION = "rg-pi-review-gate-d104b8a270";

test("ids are validated, never trusted", () => {
  for (const good of ["%0", "%12", "%9999"]) assert.equal(isPaneId(good), true);
  for (const bad of ["", "12", "pane12", "%", "%1a", "%-1", "@1", "%1;rm -rf /", undefined, null, 12]) {
    assert.equal(isPaneId(bad), false, `${JSON.stringify(bad)} is not a pane id`);
  }
  for (const good of ["@0", "@12"]) assert.equal(isWindowId(good), true);
  for (const bad of ["", "@", "%1", "12", "@1;ls", undefined]) {
    assert.equal(isWindowId(bad), false, `${JSON.stringify(bad)} is not a window id`);
  }
});

test("a session name is only one the GATE could have derived", () => {
  assert.equal(isOwnSessionName(SESSION), true);
  assert.equal(isOwnSessionName("rg-repo-abc123"), true);
  // A colon is tmux's own session/window separator: a name carrying one could
  // be used to aim a scoped command at somebody else's window.
  for (const bad of ["", "lab", "rg:a", "rg-repo-a;b", "other-rg-repo-abc123", "rg-repo-ABC", undefined, 7]) {
    assert.equal(isOwnSessionName(bad), false, `${JSON.stringify(bad)} is not a gate session name`);
  }
});

test("kill-server is refused in EVERY case — no session name makes it safe", () => {
  assert.deepEqual([...NEVER_ALLOWED_TMUX_SUBCOMMANDS], ["kill-server"]);
  assert.throws(() => assertSafeTmuxArgv(["kill-server"]), UnsafeTmuxCommand);
  assert.throws(() => assertSafeTmuxArgv(["kill-server"], { ownSessions: [SESSION] }), UnsafeTmuxCommand);
  assert.throws(() => assertSafeTmuxArgv([]), UnsafeTmuxCommand);
});

test("a global flag where the subcommand belongs is refused — it would hide the subcommand", () => {
  // `tmux -L sock kill-session -t x` puts `-L` in the position this module reads
  // as the subcommand, so the whole check (including `kill-server`) would be
  // skipped. The gate never passes a leading flag (its socket comes from the
  // environment), so refusing costs nothing.
  assert.throws(() => assertSafeTmuxArgv(["-L", "sock", "kill-session", "-t", SESSION]), UnsafeTmuxCommand);
  assert.throws(() => assertSafeTmuxArgv(["-L", "sock", "kill-server"]), UnsafeTmuxCommand);
});

test("every session-scoped command needs a declaration AND a target that names one of them", () => {
  const own = { ownSessions: [SESSION] };
  assert.deepEqual(
    [...OWN_SESSION_TMUX_SUBCOMMANDS].sort(),
    [
      "kill-session", "kill-window", "killw", "new", "new-session", "new-window", "neww",
      // The SESSION ENVIRONMENT is a session-scoped thing the gate may write
      // (it removes an earlier build's polluted variables), so it is held to
      // the same rule as the four that create and destroy.
      "set-environment", "show-environment",
    ],
  );
  // With a declared scope, but pointing somewhere else: refused.
  assert.throws(() => assertSafeTmuxArgv(["kill-session", "-t", "lab"], own), UnsafeTmuxCommand);
  assert.throws(() => assertSafeTmuxArgv(["new-window", "-t", "lab"], own), UnsafeTmuxCommand);
  assert.throws(() => assertSafeTmuxArgv(["set-environment", "-t", "lab", "-u", "RG_WORKER_ID"], own), UnsafeTmuxCommand);
  assert.throws(() => assertSafeTmuxArgv(["show-environment", "-t", "lab"], own), UnsafeTmuxCommand);
  // …including at ANOTHER gate-looking session: "mine" is an exact match, not
  // "a name of my shape".
  assert.throws(() => assertSafeTmuxArgv(["kill-session", "-t", "rg-other-repo-abcdef1234"], own), UnsafeTmuxCommand);
  // A window target must stay inside a declared session — a bare `@id` would
  // resolve against whatever now owns that number.
  assert.throws(() => assertSafeTmuxArgv(["kill-window", "-t", "@12"], own), UnsafeTmuxCommand);
  // A declared name that the gate could not have derived (an empty list, or one
  // holding junk) is not a declaration at all.
  assert.throws(() => assertSafeTmuxArgv(["kill-session", "-t", "lab"], { ownSessions: ["lab"] }), UnsafeTmuxCommand);
  assert.throws(() => assertSafeTmuxArgv(["kill-session", "-t", SESSION], { ownSessions: [] }), UnsafeTmuxCommand);
  assert.throws(() => assertSafeTmuxArgv(["kill-session", "-t", SESSION], { ownSessions: ["lab"] }), UnsafeTmuxCommand);
  // The aliases are held to the same rule, not to a second one.
  assert.throws(() => assertSafeTmuxArgv(["new", "-s", "lab"], own), UnsafeTmuxCommand);
  assert.throws(() => assertSafeTmuxArgv(["killw", "-t", `lab:@1`], own), UnsafeTmuxCommand);
  // The in-session forms pass.
  assert.doesNotThrow(() => assertSafeTmuxArgv(["kill-session", "-t", SESSION], own));
  assert.doesNotThrow(() => assertSafeTmuxArgv(["kill-window", "-t", `${SESSION}:@12`], own));
  assert.doesNotThrow(() => assertSafeTmuxArgv(["new-window", "-t", SESSION], own));
  assert.doesNotThrow(() => assertSafeTmuxArgv(["set-environment", "-t", SESSION, "-u", "RG_WORKER_ID"], own));
  assert.doesNotThrow(() => assertSafeTmuxArgv(["show-environment", "-t", SESSION], own));
  // A LIST, not one name: a relay successor holds the previous seat's windows
  // too, and those live in the predecessor's session (quality round P1).
  const lineage = { ownSessions: [SESSION, "rg-other-repo-abcdef1234"] };
  assert.doesNotThrow(() => assertSafeTmuxArgv(["kill-window", "-t", "rg-other-repo-abcdef1234:@3"], lineage));
  assert.doesNotThrow(() => assertSafeTmuxArgv(["kill-session", "-t", "rg-other-repo-abcdef1234"], lineage));
  assert.throws(() => assertSafeTmuxArgv(["kill-session", "-t", "rg-third-repo-99999999"], lineage), UnsafeTmuxCommand);
});

test("only the four session-scoped commands need a declaration: reading a marker does NOT, killing it does", () => {
  // THE SWEEP'S TWO CALLS (2026-09-25, t2), and why they differ. Before killing
  // another session's dedicated session the sweep READS its `@rg_scope_owner`
  // marker — that read is not one of the guarded commands (the guard's list is
  // about creating and destroying surface), so it needs no declaration and
  // cannot be refused for one. The KILL that follows is guarded, and it carries
  // the declaration the marker check just earned.
  const guard = { ownSessions: ["rg-mine-0000000000"] };
  assert.doesNotThrow(
    () => assertSafeTmuxArgv(buildReadSessionOwnerArgv("rg-dead-0000000000"), guard),
    "a marker read is unguarded by design — and it is what makes the kill below safe",
  );
  assert.throws(
    () => assertSafeTmuxArgv(buildKillSessionArgv("rg-dead-0000000000"), guard),
    UnsafeTmuxCommand,
    "a kill of a session nobody declared is refused",
  );
  assert.doesNotThrow(
    () => assertSafeTmuxArgv(buildKillSessionArgv("rg-dead-0000000000"), {
      ownSessions: [...guard.ownSessions, "rg-dead-0000000000"],
    }),
    "…and passes exactly when the verified name is declared (what the sweep passes)",
  );
});

test("a caller that declares NOTHING cannot run the four — looking like ours is not being ours", () => {
  // THE EXECUTOR'S HALF OF THE SAME RULE (2026-09-25). The runner that spawns
  // tmux knows no session of its own, so it is handed the declaration by its
  // caller (lib/orchestrator-wiring.ts `runTmux(argv, env, guard)`, and in the
  // extension by the ONE wrapper every tmux call goes through). Without it, a
  // gate-shaped target is still refused: shape is not ownership, and the cost of
  // refusing is one clear message while the cost of accepting is somebody else's
  // screen.
  const sessionCommands = [
    ["new-session", "-d", "-s", SESSION],
    ["new-window", "-t", SESSION],
    ["kill-window", "-t", `${SESSION}:@12`],
    ["kill-session", "-t", SESSION],
  ];
  for (const argv of sessionCommands) {
    assert.throws(() => assertSafeTmuxArgv(argv), UnsafeTmuxCommand, `${argv.join(" ")} without a declaration`);
    assert.doesNotThrow(() => assertSafeTmuxArgv(argv, { ownSessions: [SESSION] }), `${argv.join(" ")} declared`);
  }
  // The user's own session can never be addressed, declared or not.
  assert.throws(() => assertSafeTmuxArgv(["kill-session", "-t", "my-work"]), UnsafeTmuxCommand);
  assert.throws(() => assertSafeTmuxArgv(["kill-window", "-t", "my-work:@3"], { ownSessions: [SESSION] }), UnsafeTmuxCommand);
  // …and `kill-server` is refused in every case.
  assert.throws(() => assertSafeTmuxArgv(["kill-server"], { ownSessions: [SESSION] }), UnsafeTmuxCommand);
});

test("new-session may not be grouped into another session", () => {
  // `-t` on new-session means "join this session's group", which is another
  // session's business entirely — refused rather than interpreted.
  assert.throws(
    () => assertSafeTmuxArgv(["new-session", "-d", "-s", SESSION, "-t", SESSION], { ownSessions: [SESSION] }),
    UnsafeTmuxCommand,
  );
});

test("no argv may write a GLOBAL option", () => {
  assert.throws(() => assertSafeTmuxArgv(["set-option", "-g", "mouse", "on"]), UnsafeTmuxCommand);
  assert.throws(() => assertSafeTmuxArgv(["setw", "-g", "x", "y"]), UnsafeTmuxCommand);
  assert.doesNotThrow(() => assertSafeTmuxArgv(["set-option", "-t", "%1", "remain-on-exit", "on"]),
    "a pane-local option is fine");
});

test("every builder REFUSES a bad target rather than interpolating it", () => {
  assert.throws(() => buildKillPaneArgv("not-a-pane"), UnsafeTmuxCommand);
  assert.throws(() => buildKillWindowArgv(SESSION, "%1"), UnsafeTmuxCommand, "a pane id is not a window id");
  assert.throws(() => buildKillWindowArgv("lab", "@1"), UnsafeTmuxCommand);
  assert.throws(() => buildKillSessionArgv("lab"), UnsafeTmuxCommand);
  assert.throws(() => buildNewSessionArgv({ ownSession: "lab", cwd: "/repo" }), UnsafeTmuxCommand);
  assert.throws(() => buildHandoffPaneArgv({ orchestratorPane: "x", cwd: "/repo" }), UnsafeTmuxCommand);
});

test("a new session opens WITH its first child — no stray shell window", () => {
  const argv = buildNewSessionArgv({
    ownSession: SESSION,
    cwd: "/repo",
    env: { RG_GATE_MODE: "loop", RG_STATE_VARIANT: "t1-abc" },
    command: ["pi", "@.pi/tasks/t1.md"],
    windowName: "t1@pm",
  });
  assert.deepEqual(argv.slice(0, 3), ["new-session", "-d", "-s"]);
  assert.equal(argv[3], SESSION);
  assert.deepEqual(argv.slice(argv.indexOf("-c"), argv.indexOf("-c") + 2), ["-c", "/repo"]);
  assert.deepEqual(argv.slice(argv.indexOf("-n"), argv.indexOf("-n") + 2), ["-n", "t1@pm"]);
  // THE ENVIRONMENT RIDES THE CHILD'S OWN COMMAND (2026-09-25): tmux `-e`
  // writes the SESSION's environment, so the first child's identity was
  // inherited by every later window of that session (measured in the t5
  // acceptance round — a judge reported into the worker's channel).
  assert.ok(!argv.includes("-e"), "never tmux -e: it would write the SESSION environment");
  const envAt = argv.indexOf("env");
  assert.ok(envAt > 0, "the child's environment is its own command's prefix");
  assert.deepEqual(
    argv.slice(envAt, envAt + 3),
    ["env", "RG_GATE_MODE=loop", "RG_STATE_VARIANT=t1-abc"],
    "sorted, so the argv is testable",
  );
  assert.ok(argv.includes("-P") && argv.includes("-F"), "tmux prints what it created");
  assert.equal(argv[argv.indexOf("#{window_id} #{pane_id}") - 1], "-F");
  assert.deepEqual(argv.slice(-2), ["pi", "@.pi/tasks/t1.md"], "the child's own command IS the first window");
});

test("a later child joins the session as one more window", () => {
  const argv = buildNewWindowArgv({ ownSession: SESSION, cwd: "/repo", command: ["pi"] });
  assert.deepEqual(argv.slice(0, 3), ["new-window", "-t", SESSION]);
  assert.ok(!argv.includes("-d"), "only the session itself is detached");
  assert.equal(argv[argv.length - 1], "pi", "an interactive pi is the default command");
});

test("the relay is the ONE split left, always off the opener's own pane", () => {
  const argv = buildHandoffPaneArgv({ orchestratorPane: "%1", cwd: "/repo" });
  assert.deepEqual(argv.slice(0, 4), ["split-window", "-h", "-t", "%1"],
    "horizontal, so closing the old pane hands its place to the successor");
});

test("a window is killed THROUGH its session, never by a bare id", () => {
  assert.deepEqual(buildKillWindowArgv(SESSION, "@7"), ["kill-window", "-t", `${SESSION}:@7`]);
  assert.deepEqual(buildKillSessionArgv(SESSION), ["kill-session", "-t", SESSION]);
  // The relay path still closes one pane — the rectangle in the user's window
  // that the retiring session itself sits in.
  assert.deepEqual(buildKillPaneArgv("%5"), ["kill-pane", "-t", "%5"]);
});

test("the ownership marker is read back, and an unset one is a real answer", () => {
  assert.deepEqual(
    buildSetSessionOwnerArgv(SESSION, "019fbb1d-9e78-7ebf-88bf-d104b8a270ed"),
    ["set", "-t", SESSION, SESSION_OWNER_OPTION, "019fbb1d-9e78-7ebf-88bf-d104b8a270ed"],
  );
  assert.deepEqual(buildReadSessionOwnerArgv(SESSION), ["show-options", "-t", SESSION, "-qv", SESSION_OWNER_OPTION]);
  // Measured (tmux 3.7c): an unset option prints NOTHING and exits 0, so an
  // empty reading is "nobody claimed it" — never a failed call.
  assert.deepEqual(parseSessionNames(""), []);
});

test("liveness is a SERVER-WIDE pane list — a window target cannot answer it", () => {
  assert.deepEqual(buildListServerPanesArgv(), ["list-panes", "-a", "-F", "#{pane_id}"]);
  assert.deepEqual(buildListSessionsArgv(), ["list-sessions", "-F", "#{session_name}"]);
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

test("tmux output is parsed strictly", () => {
  assert.deepEqual(parsePaneIds("%1\n%2\n\n  %3  \n"), ["%1", "%2", "%3"]);
  assert.deepEqual(parsePaneIds("error: no server running"), [], "noise is not a pane list");
  assert.equal(parseSpawnedPaneId("%42\n"), "%42");
  assert.equal(parseSpawnedPaneId(""), undefined, "no id ⇒ the caller must roll back, not guess");
  assert.equal(parseSpawnedPaneId("no such window"), undefined);
  assert.deepEqual(parseSessionNames("lab\n\n work \n"), ["lab", "work"]);
  assert.deepEqual(parseSpawnedWindow("@3 %7\n"), { windowId: "@3", paneId: "%7" });
  // HALF A COORDINATE IS NOT ONE: a window id without its pane, or a garbled
  // line, must leave the caller nothing to address.
  assert.equal(parseSpawnedWindow("@3\n"), undefined);
  assert.equal(parseSpawnedWindow("%7\n"), undefined);
  assert.equal(parseSpawnedWindow("no server running"), undefined);
  assert.equal(parseSpawnedWindow(""), undefined);
});

test("a window coordinate read back from disk is BOTH halves or nothing", () => {
  // The pair is what a close is addressed by, so a half-record is not a record:
  // the registries leave both off and the entry reads as "predates the window
  // topology" (lib/orchestrator-registry.ts / lib/worker-pane.ts both use this
  // one parser, so their answers cannot drift apart).
  const good = { windowId: "@7", tmuxSession: SESSION };
  assert.deepEqual(parseWindowCoords(good), good);
  assert.deepEqual(parseWindowCoords({ tmuxSession: SESSION }), undefined, "no window id ⇒ nothing to close");
  assert.deepEqual(parseWindowCoords({ windowId: "@7" }), undefined, "no session ⇒ the kill cannot be scoped");
  assert.deepEqual(parseWindowCoords({ windowId: "%7", tmuxSession: SESSION }), undefined,
    "a pane id is not a window id");
  assert.deepEqual(parseWindowCoords({ windowId: "@7", tmuxSession: "my-work" }), undefined,
    "a session name the gate could not have derived is not a target");
  assert.deepEqual(parseWindowCoords({ windowId: "@7", tmuxSession: `${SESSION}:@7` }), undefined,
    "and neither is one carrying tmux's own separator");
  assert.deepEqual(parseWindowCoords({}), undefined);
});

/**
 * THE THREE-COLUMN LAYOUT IS DELETED, AND THIS IS WHAT KEEPS IT DELETED
 * (philosophy three, 2026-09-25).
 *
 * The functions that planned, probed and equalised the user's window have no
 * caller any more, so a resurrected copy would be invisible to every other
 * test in this file — they test what exists. This one tests what must NOT.
 */
test("the window-layout machinery is gone from the module AND from its tests", async () => {
  const mod = await import("../lib/orchestrator-tmux.ts");
  // BY SHAPE, not by a list of names: an assertion that spells a deleted
  // function out is itself a place that name lives, and the round's exit
  // criterion is that the identifiers are gone from the tree. A pattern can
  // only be satisfied by a module that really has none of them.
  const suspicious = Object.keys(mod).filter((name) => /Layout|Placement|SpawnPane/.test(name));
  assert.deepEqual(suspicious, [], "no layout/placement/legacy-spawn export may come back");
  // …and no surviving builder may emit the equaliser, which is what the layout
  // used to run after every spawn and every close.
  const source = readFileSync(new URL("../lib/orchestrator-tmux.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"select-layout"/);
  // The other half of the topology is in session-factory: its layout values are
  // exactly the two that exist today, and neither is the old one.
  const factory = readFileSync(new URL("../lib/session-factory.ts", import.meta.url), "utf8");
  const declared = factory.match(/export type SessionPaneLayout =([\s\S]*?);/)?.[1] ?? "";
  assert.deepEqual([...declared.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort(), ["beside-opener", "own-session-window"]);
});

/**
 * READING `allow-passthrough` IS GONE (user decision, 2026-09-17).
 *
 * The gate used to read it so a receipt could stop claiming a delivery tmux
 * may have dropped. The banner no longer travels through tmux at all
 * (lib/user-notify.ts carries the measurement that forced the change), so
 * there is nothing left to ask about — and a reader nothing consults is the
 * kind of code that quietly comes back.
 */
test("nothing in the tmux module reads the passthrough option any more", () => {
  const source = readFileSync(new URL("../lib/orchestrator-tmux.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /allow-passthrough/,
    "the option belongs to the user's config; with OSC gone the gate has no business reading it");
});
