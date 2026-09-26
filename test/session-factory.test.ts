/**
 * THE SESSION FACTORY — one entry, five input combinations.
 *
 * The point of this file is that a combination cannot quietly lose a step. Each
 * of the five ways the gate opens a pi session (judge spawn, judge recover,
 * orchestration spawn, orchestration recover, relay successor) is asserted here
 * on the two things that are cross-process contracts — the ENV key set and the
 * argv shape — plus the decoration and the delivery check that used to exist on
 * one side only (C1, C2, and the judge-side receipt).
 *
 * AND ON WHERE THE CHILD LANDS (2026-09-25, user decision): a child is a WINDOW
 * of the opener's own tmux session — `new-session` for the first one, `new-window`
 * for every later one — with the gate's label as the window name. The ONE
 * exception is the relay, which still splits the opener's own pane because a
 * handover must not move the user's screen.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";

import {
  closeSessionPane,
  closeSessionWindow,
  decorateSessionPane,
  openSessionWindow,
  paintPaneTitle,
  paneRecoverability,
  refreshSessionPaneTitle,
  PANE_REPAINT_MIN_MS,
  type PaneTitleMemory,
} from "../lib/session-factory.ts";
import type { TmuxRunner } from "../lib/orchestrator-tmux.ts";
// The label grammar's ONE home — imported from there, not re-exported by the
// pane plumbing that writes what it renders (2026-09-18).
import { judgePaneLabel, pmPaneLabel } from "../lib/orchestrator-pane-decor.ts";
import { judgeScratchDir } from "../lib/judge-process.ts";
import type { TmuxScope, TmuxScopeRecord } from "../lib/session-tmux-scope.ts";
import { deriveSessionName } from "../lib/session-tmux-scope.ts";
import { SESSION_PINNED_OPTION } from "../lib/tmux-session-argv.ts";
import * as sessionFactory from "../lib/session-factory.ts";
import { buildSessionEnv } from "../lib/session-env.ts";
import { buildJudgePaneCommand, buildJudgeRecoverCommand, judgePaneDecor } from "../lib/session-launch-specs.ts";

const SESSION_ID = "019fbb1d-9e78-7ebf-88bf-d104b8a270ed";
// Derived by the production function, never hardcoded: the test asserts the
// SAME name the gate would build from this session's identity.
const OWN_SESSION = deriveSessionName("/repo", SESSION_ID)!;

/**
 * A fake tmux for the window topology: the first child creates the session and
 * every later one joins it, and each creation prints `@id %id` the way the real
 * `-P -F '#{window_id} #{pane_id}'` does.
 */
function happyRunner(seen: string[][] = []): TmuxRunner {
  let windowSeq = 7;
  let created = false;
  let owner = "";
  return (argv) => {
    seen.push([...argv]);
    const sub = argv[0];
    if (sub === "list-sessions") return { ok: true, stdout: created ? `${OWN_SESSION}\n` : "", stderr: "" };
    if (sub === "split-window") return { ok: true, stdout: "%7\n", stderr: "" };
    if (sub === "show-options") return { ok: true, stdout: owner ? `${owner}\n` : "", stderr: "" };
    if (sub === "set") {
      owner = String(argv[argv.length - 1]);
      return { ok: true, stdout: "", stderr: "" };
    }
    if (sub === "new-session" || sub === "new-window") {
      created = true;
      return { ok: true, stdout: `@${windowSeq++} %${windowSeq}\n`, stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
}

/**
 * The child's environment, read back out of its OWN command — the `env K=V …`
 * prefix `lib/orchestrator-tmux.ts` builds. Never tmux's `-e`: that one writes
 * the SESSION environment, which every later window of the session inherits
 * (measured 2026-09-25).
 */
function envOf(argv: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  const envAt = argv.indexOf("env");
  if (envAt < 0) return env;
  const tokens = argv.slice(envAt + 1);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "-u") { i++; continue; } // a gate variable the child is NOT given
    if (!token.includes("=")) break;
    const [key, ...rest] = token.split("=");
    env[key!] = rest.join("=");
  }
  return env;
}

/** The scope seam, with the sidecar record kept in memory. */
interface FakeScope extends TmuxScope {
  record: TmuxScopeRecord | undefined;
}

function fakeScope(): FakeScope {
  const scope: FakeScope = {
    record: undefined,
    sessionId: () => SESSION_ID,
    repoRoot: () => "/repo",
    read: () => scope.record,
    write: (record) => { scope.record = record; },
    now: () => "2026-09-25T00:00:00.000Z",
  };
  return scope;
}

const JUDGE_COMMAND = buildJudgePaneCommand({
  sessionId: "rg-reviewer-abc123",
  taskPath: "/repo/.pi/judge-sessions/task-1.md",
  sessionDir: "/repo/.pi/judge-sessions/sessions",
  sysPromptPath: "/repo/.pi/judge-sessions/sp.md",
  model: "anthropic/claude-fable-5:max",
});

// ---------------------------------------------------------------------------
// The five combinations
// ---------------------------------------------------------------------------

test("combination 1 — a judge SPAWN: judge env, own colour, border line, verified boot", async () => {
  const seen: string[][] = [];
  const registered: string[] = [];
  const outcome = await openSessionWindow(happyRunner(seen), {
    scope: fakeScope(),
    cwd: "/repo",
    layout: "own-session-window",
    role: {
      kind: "judge",
      openerId: "session-child-1",
      judgeId: "rg-reviewer-abc123",
      role: "reviewer",
      taskPath: "/repo/.pi/judge-sessions/task-1.md",
      streamPath: "/repo/.pi/review-stream/r.jsonl",
    },
    command: JUDGE_COMMAND,
    decor: judgePaneDecor("rg-reviewer-abc123", "reviewer", "t6"),
    register: (coords) => registered.push(coords.paneId),
    verify: async () => ({ ok: true, detail: "上报了状态" }),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.paneId, "%8", "the id comes from tmux, never from a guess");
  assert.deepEqual(registered, ["%8"], "registration happens inside the open");
  assert.equal(outcome.deliveryNote, "上报了状态");

  const spawn = seen.find((argv) => argv[0] === "new-session")!;
  assert.ok(spawn, "the child created the opener's own session");
  assert.deepEqual(envOf(spawn), {
    RG_JUDGE_OPENER: "session-child-1",
    RG_JUDGE_ID: "rg-reviewer-abc123",
    RG_JUDGE_ROLE: "reviewer",
    RG_JUDGE_TASK: "/repo/.pi/judge-sessions/task-1.md",
    RG_JUDGE_STREAM: "/repo/.pi/review-stream/r.jsonl",
    // Plus the scratch root the reaper reads back (test/judge-scratch.test.ts).
    TMPDIR: judgeScratchDir("rg-reviewer-abc123"),
  }, "exactly the judge variables — the judge side reads these by name");
  assert.equal(seen.some((argv) => argv[0] === "split-window"), false,
    "the user's window is untouched: the child is a window of the opener's own session");

  const flat = seen.map((a) => a.join(" "));
  assert.ok(flat.some((s) => s.includes("select-pane") && s.includes("-P")), "a border colour is set");
  assert.ok(flat.some((s) => s.includes("@t6")), "the title names the review kind AND who opened it");
  // C1: the WINDOW option that renders the border line used to be set by the
  // orchestration spawn only, so a judge pane opened without a project manager
  // in the window had a colour nobody could see. In the window topology it is
  // set on the CHILD's own window, which is even safer.
  assert.ok(flat.some((s) => s.includes("pane-border-status")), "the border LINE is turned on (C1)");
  assert.ok(flat.some((s) => s.includes("pane-border-format")), "and given its format (C1)");
});

test("combination 2 — a judge RECOVER: same three keys, resume argv, no task file", async () => {
  const seen: string[][] = [];
  const outcome = await openSessionWindow(happyRunner(seen), {
    scope: fakeScope(),
    cwd: "/repo",
    layout: "own-session-window",
    role: { kind: "judge", openerId: "session-child-1", judgeId: "rg-reviewer-abc123", role: "reviewer" },
    command: buildJudgeRecoverCommand("rg-reviewer-abc123"),
    decor: judgePaneDecor("rg-reviewer-abc123", "reviewer", "pm"),
  });
  assert.equal(outcome.ok, true);
  const spawn = seen.find((argv) => argv[0] === "new-session")!;
  assert.deepEqual(envOf(spawn), {
    RG_JUDGE_OPENER: "session-child-1",
    RG_JUDGE_ID: "rg-reviewer-abc123",
    RG_JUDGE_ROLE: "reviewer",
    TMPDIR: judgeScratchDir("rg-reviewer-abc123"),
  }, "no task and no stream on a recover — the transcript already holds the round");
  assert.ok(spawn.includes("--session-id"), "the transcript continues by id");
  assert.ok(!spawn.some((a) => a.startsWith("@")), "no argv message: nothing to re-deliver");
});

test("combination 3 — an orchestration SPAWN: orchestration env, a window WITH the gate's label", async () => {
  const seen: string[][] = [];
  const outcome = await openSessionWindow(happyRunner(seen), {
    scope: fakeScope(),
    cwd: "/repo",
    layout: "own-session-window",
    role: { kind: "orchestration-child", orchestrationId: "orch-abc-1", stateVariant: "t1-xyz" },
    command: ["pi", "@.pi/tasks/t1.md"],
    decor: { label: "@t1-thing", colorSeed: "t1-xyz", state: "working", stateForSeconds: 0 },
    verify: async () => ({ ok: true, detail: "通道有记录" }),
  });
  assert.equal(outcome.ok, true);
  const spawn = seen.find((argv) => argv[0] === "new-session")!;
  assert.deepEqual(envOf(spawn), {
    RG_ORCHESTRATION_ID: "orch-abc-1",
    RG_GATE_MODE: "loop",
    RG_STATE_VARIANT: "t1-xyz",
  }, "the child's own sidecar variant is ALSO its exclusivity-guard exemption");
  assert.deepEqual(spawn.slice(0, 4), ["new-session", "-d", "-s", OWN_SESSION],
    "the child creates the opener's own session when it is the first one");
  assert.deepEqual(spawn.slice(spawn.indexOf("-n"), spawn.indexOf("-n") + 2), ["-n", "@t1-thing"],
    "and the window carries the gate's label, so `tmux ls` says who is who");
  assert.equal(seen.some((argv) => argv[0] === "split-window"), false, "no column, no split, no resize");
  assert.ok(seen.some((argv) => argv[0] === "set" && argv.includes(SESSION_PINNED_OPTION)),
    "a manager's session is PINNED: orchestrator_attach inherits its children, the crash sweep must not");
});

test("a SECOND child joins the session instead of creating it", async () => {
  const scope = fakeScope();
  const seen: string[][] = [];
  const run = happyRunner(seen);
  for (const judgeId of ["j-1", "j-2"]) {
    const outcome = await openSessionWindow(run, {
      scope,
      cwd: "/repo",
      layout: "own-session-window",
      role: { kind: "judge", openerId: "o", judgeId, role: "reviewer" },
      command: ["pi"],
    });
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
  }
  assert.deepEqual(seen.filter((argv) => argv[0] === "new-session").length, 1, "the session is created ONCE");
  assert.deepEqual(seen.filter((argv) => argv[0] === "new-window").length, 1, "and the second child joins it");
  assert.equal(scope.record?.name, OWN_SESSION, "the sidecar records what was created");
  assert.equal(scope.record?.owner, SESSION_ID, "and who owns it");
});

test("combination 4 — an orchestration RECOVER: same env, its own window again", async () => {
  const seen: string[][] = [];
  await openSessionWindow(happyRunner(seen), {
    scope: fakeScope(),
    cwd: "/repo",
    layout: "own-session-window",
    role: { kind: "orchestration-child", orchestrationId: "orch-abc-1", stateVariant: "t1-xyz" },
    command: ["pi", "--session-id", "rg-child-t1", "@.pi/tasks/note.md"],
    decor: { label: "@t1-thing", colorSeed: "t1-xyz", state: "working", stateForSeconds: 0 },
  });
  const spawn = seen.find((argv) => argv[0] === "new-session")!;
  assert.equal(envOf(spawn).RG_STATE_VARIANT, "t1-xyz", "a recovered child keeps its exemption");
  assert.deepEqual(spawn.slice(0, 4), ["new-session", "-d", "-s", OWN_SESSION]);
  assert.equal(seen.some((argv) => argv[0] === "split-window"), false, "the user's window is not touched");
});

test("combination 5 — a relay SUCCESSOR: beside the opener, its own env, no border, NO session", async () => {
  const seen: string[][] = [];
  // No `register` and no `decor`: a successor is not a child — it takes the
  // orchestration over, so nothing registers it and nothing paints it.
  const outcome = await openSessionWindow(happyRunner(seen), {
    scope: fakeScope(),
    ownPane: "%1",
    cwd: "/repo",
    layout: "beside-opener",
    role: {
      kind: "successor",
      env: { RG_ORCHESTRATION_ID: "orch-abc-1", RG_GATE_MODE: "orchestrator", RG_HANDOFF_PATH: "docs/h.md" },
    },
    command: ["pi"],
  });
  assert.equal(outcome.ok, true);
  const spawn = seen.find((argv) => argv[0] === "split-window")!;
  assert.deepEqual(envOf(spawn), {
    RG_ORCHESTRATION_ID: "orch-abc-1",
    RG_GATE_MODE: "orchestrator",
    RG_HANDOFF_PATH: "docs/h.md",
  }, "a successor's env is the relay's own, passed through unchanged");
  assert.deepEqual(spawn.slice(0, 4), ["split-window", "-h", "-t", "%1"],
    "THE ONE REMAINING SPLIT: a handover lands where the human is already looking");
  assert.equal(seen.some((argv) => argv[0].startsWith("new-")), false,
    "and it creates no tmux session — a successor's own children get their own");
  assert.equal(seen.filter((a) => a[0] === "select-pane").length, 0, "no border: a successor is not a child");
  assert.equal(seen.filter((a) => a[0] === "setw").length, 0, "and no window option either");
});

test("a successor is opened only after the seat's own session is PINNED — and a failed pin refuses the handover", async () => {
  const spec = { scope: fakeScope(), ownPane: "%1", cwd: "/repo", layout: "beside-opener" as const, role: { kind: "successor" as const, env: {} }, command: ["pi"] };
  const withSession = (failPin: boolean, seen: string[][]): TmuxRunner => (argv, env, declared) => {
    if (argv[0] === "list-sessions") { seen.push([...argv]); return { ok: true, stdout: `${OWN_SESSION}\n`, stderr: "" }; }
    if (argv[0] === "show-options") { seen.push([...argv]); return { ok: true, stdout: `${SESSION_ID}\n`, stderr: "" }; }
    if (argv[0] === "set" && failPin) { seen.push([...argv]); return { ok: false, stdout: "", stderr: "nope" }; }
    return happyRunner(seen)(argv, env, declared);
  };
  const seen: string[][] = [];
  assert.equal((await openSessionWindow(withSession(false, seen), spec)).ok, true);
  const pin = seen.findIndex((a) => a[0] === "set" && a.includes(SESSION_PINNED_OPTION));
  assert.ok(pin >= 0 && pin < seen.findIndex((a) => a[0] === "split-window"), "pinned BEFORE the successor exists");

  const refusedSeen: string[][] = [];
  const refused = await openSessionWindow(withSession(true, refusedSeen), spec);
  assert.equal(refused.ok, false);
  assert.equal(refusedSeen.some((a) => a[0] === "split-window"), false, "no successor next to an unpinned session");
});

test("a relay with no opener pane is refused, not guessed", async () => {
  const outcome = await openSessionWindow(happyRunner(), {
    scope: fakeScope(),
    cwd: "/repo",
    layout: "beside-opener",
    role: { kind: "successor", env: {} },
    command: ["pi"],
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.error, /ownPane/);
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test("a failed creation is a failed open — never a guessed id", async () => {
  const run: TmuxRunner = (argv) => argv[0] === "list-sessions"
    ? { ok: true, stdout: "", stderr: "" }
    : { ok: false, stdout: "", stderr: "no server" };
  const outcome = await openSessionWindow(run, {
    scope: fakeScope(), cwd: "/repo", layout: "own-session-window",
    role: { kind: "judge", openerId: "o", judgeId: "j", role: "reviewer" },
    command: ["pi"],
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /no server/);
  assert.equal(outcome.paneId, undefined, "nothing exists, so nothing is named");
});

test("an empty creation print is a failed open — a half coordinate is not one", async () => {
  const outcome = await openSessionWindow(() => ({ ok: true, stdout: "@3\n", stderr: "" }), {
    scope: fakeScope(), cwd: "/repo", layout: "own-session-window",
    role: { kind: "successor", env: {} },
    command: ["pi"],
  });
  assert.equal(outcome.ok, false);
});

test("a thrown tmux call is a failed open, not an exception the caller must catch", async () => {
  const run: TmuxRunner = (argv) => {
    if (argv[0] === "list-sessions") return { ok: true, stdout: "", stderr: "" };
    throw new Error("tmux exploded");
  };
  const outcome = await openSessionWindow(run, {
    scope: fakeScope(), cwd: "/repo", layout: "own-session-window",
    role: { kind: "successor", env: {} },
    command: ["pi"],
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /tmux exploded/);
});

test("decor failure degrades to a warning, never to a failed open", async () => {
  const run: TmuxRunner = (argv) => {
    if (argv[0] === "list-sessions") return { ok: true, stdout: "", stderr: "" };
    if (argv[0] === "new-session" || argv[0] === "new-window") return { ok: true, stdout: "@7 %8\n", stderr: "" };
    // The OWNERSHIP MARKER is not cosmetic: a tmux that refuses `set -t <session>
    // @rg_scope_owner` leaves a session nothing can reuse or kill, so
    // `openScopeWindow` drops the whole session there — asserted in
    // test/session-tmux-scope.test.ts. Only the DISPLAY writes are refused
    // here, which is what this test is about.
    if (argv[0] === "set" && !argv.includes("-p")) return { ok: true, stdout: "", stderr: "" };
    return { ok: false, stdout: "", stderr: "select failed" };
  };
  const outcome = await openSessionWindow(run, {
    scope: fakeScope(), cwd: "/repo", layout: "own-session-window",
    role: { kind: "judge", openerId: "o", judgeId: "j", role: "reviewer" },
    command: ["pi"],
    decor: judgePaneDecor("j", "reviewer", "self"),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // The warning is FRAMED, not a bare tmux stderr: every caller pastes it into
  // a receipt, and "select failed" on its own reads like the session failed.
  assert.match(outcome.decorWarning ?? "", /降级/);
  assert.match(outcome.decorWarning ?? "", /select failed/);
});

test("a failed delivery check KEEPS the window and its registration", async () => {
  const registered: string[] = [];
  const outcome = await openSessionWindow(happyRunner(), {
    scope: fakeScope(), cwd: "/repo", layout: "own-session-window",
    role: { kind: "judge", openerId: "o", judgeId: "j", role: "reviewer" },
    command: ["pi"],
    register: (coords) => registered.push(coords.paneId),
    verify: async () => ({ ok: false, detail: "通道里一条记录都没有" }),
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.deliveryFailed, true);
  assert.equal(outcome.paneId, "%8", "the child is named so the caller can wait on it");
  assert.equal(outcome.windowId, "@7", "…with its window too, so the caller can close exactly it");
  assert.deepEqual(registered, ["%8"], "the registration survives: it may only be slow");
  assert.match(outcome.error, /一条记录都没有/);
});

// ---------------------------------------------------------------------------
// Decoration and the repaint (C2)
// ---------------------------------------------------------------------------

test("decoration writes colour, title and BOTH window options", () => {
  const seen: string[][] = [];
  const warning = decorateSessionPane(happyRunner(seen), "%7", {
    label: "@review-adviser", colorSeed: "j2", state: "working",
  });
  assert.equal(warning, undefined);
  const flat = seen.map((a) => a.join(" "));
  assert.equal(seen.length, 4, "colour + title + two window options");
  assert.ok(flat[0]!.includes("select-pane") && flat[0]!.includes("-P"));
  assert.ok(flat[1]!.includes("@review-adviser · working"));
  assert.ok(flat.some((s) => s.includes("pane-border-status top")));
  assert.ok(flat.some((s) => s.includes("pane-border-format")));
});

test("the repaint is throttled, skips an unchanged title, and swallows tmux failures", () => {
  const store = new Map<string, { title: string; at: number }>();
  const memory: PaneTitleMemory = store;
  const seen: string[][] = [];
  const run = happyRunner(seen);
  const paint = (state: "working" | "waiting-input", now: number, seconds: number): boolean =>
    refreshSessionPaneTitle(run, {
      paneId: "%7", label: "reviewer@t6", state, stateForSeconds: seconds, now, memory,
    });

  assert.equal(paint("working", 1_000, 0), true, "first paint always lands");
  assert.equal(paint("working", 1_000, 0), false, "an unchanged title is not repainted");
  assert.equal(paint("waiting-input", 1_500, 1), false, "…and a change inside the throttle window waits");
  assert.equal(paint("waiting-input", 1_000 + PANE_REPAINT_MIN_MS + 1, 9), true, "…until the window passes");
  assert.equal(seen.length, 2, "exactly two tmux calls for four requests");
  assert.ok(seen[1]!.join(" ").includes("waiting-input 9s"), "the state and its age are what the border shows");

  const exploding: TmuxRunner = () => { throw new Error("tmux gone"); };
  assert.doesNotThrow(() => refreshSessionPaneTitle(exploding, {
    paneId: "%9", label: "reviewer@t6", state: "done", now: 5_000, memory,
  }), "a cosmetic write never breaks supervision");
});

test("judge labels carry the OPENER and are sanitized", () => {
  assert.equal(judgePaneLabel("reviewer", "t6"), "reviewer@t6");
  assert.equal(judgePaneLabel("goal-auditor", "pm"), "goal-auditor@pm");
  // The ambiguity this grammar exists for: same role, different opener, two
  // DIFFERENT labels (measured: a window held two byte-identical
  // `@review-goal-auditor` borders).
  assert.notEqual(judgePaneLabel("goal-auditor", "t6"), judgePaneLabel("goal-auditor", "pm"));
  assert.equal(judgePaneLabel("../../etc", "x"), "..-..-etc@x");
  assert.doesNotMatch(judgePaneLabel("../../etc", "../.."), /[\/\s]/, "no path separator and no space survives");
  assert.equal(judgePaneDecor("rg-reviewer-x", "adviser", "pm").colorSeed, "rg-reviewer-x", "colour hashes on the judge id");
});

test("the manager's own border is `pm:<dir>`, and painting it is unconditional", () => {
  assert.equal(pmPaneLabel("pi-review-gate"), "pm:pi-review-gate");
  assert.equal(pmPaneLabel("My Repo.Dir"), "pm:my-repo-dir", "a raw directory name is slugged, never printed as-is");
  const seen: string[][] = [];
  const run: TmuxRunner = (argv) => { seen.push([...argv]); return { ok: true, stdout: "", stderr: "" }; };
  paintPaneTitle(run, "%3", pmPaneLabel("repo"));
  paintPaneTitle(run, "%3", pmPaneLabel("repo"));
  assert.equal(seen.length, 2, "no memory and no throttle: pi may have rewritten it in between, so it is repainted every probe");
  assert.deepEqual(seen[1], ["set", "-p", "-t", "%3", "@rg_label", "pm:repo"],
    "a pane USER OPTION, not the title — pi rewrites `pane_title` and would erase it");
  // Cosmetic, always: a tmux that throws must not take supervision down with it.
  assert.doesNotThrow(() => paintPaneTitle(() => { throw new Error("tmux gone"); }, "%3", "pm:repo"));
});

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

test("a child is closed by WINDOW, addressed through the session that owns it", () => {
  const seen: string[][] = [];
  assert.equal(closeSessionWindow(happyRunner(seen), { ownSession: OWN_SESSION, windowId: "@7" }).ok, true);
  assert.deepEqual(seen, [["kill-window", "-t", `${OWN_SESSION}:@7`]],
    "one call, and the target can only reach a window of the gate's own session");
  // THE RELEASE IS GONE, AND THIS IS WHAT PINS IT (2026-09-17, user decision).
  // Taking a window's label bar down meant writing `pane-border-status`, and
  // that RESIZES EVERY PANE IN THE WINDOW — measured on a scratch tmux as
  // SIGWINCH with `rows 84 → 83`, in both directions. Under the window
  // topology the bar belongs to the CHILD's window and stops existing with it.
  assert.equal(seen.some((argv) => argv[0] === "setw"), false, "no window option is written on close");
  assert.equal(seen.some((argv) => argv[0] === "list-panes"), false,
    "and nothing is probed: there is no column left to even out");
});

test("the RELAY path still closes exactly one PANE, and touches nothing else", () => {
  const seen: string[][] = [];
  assert.equal(closeSessionPane(happyRunner(seen), "%7").ok, true);
  assert.deepEqual(seen, [["kill-pane", "-t", "%7"]],
    "the predecessor's own rectangle in the USER's window — a kill-window there would take the successor with it");
});

test("THE LABEL BAR IS NEVER RELEASED — and nothing can ask to (2026-09-17)", () => {
  // `releasesWindowLabels` and `countDecoratedPanes` used to live here, and
  // this test used to pin their answers. Both are DELETED with the release
  // path: taking the bar down writes `pane-border-status`, and that resizes
  // EVERY pane in the window. The user's own decision was "never turn it off
  // again", and the window topology finished the job — the bar now lives in
  // the child's window.
  for (const gone of ["releasesWindowLabels", "countDecoratedPanes"]) {
    assert.equal(gone in sessionFactory, false, `${gone} is deleted, not bypassed`);
  }
});


test("close failure is reported, not swallowed", () => {
  const outcome = closeSessionWindow(() => ({ ok: false, stdout: "", stderr: "gone" }), {
    ownSession: OWN_SESSION, windowId: "@7",
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error, "gone");
});

// ---------------------------------------------------------------------------
// The recovery judgement both recover tools share
// ---------------------------------------------------------------------------

test("one recovery judgement: refuse unknown, closed, pane-less, alive and unreadable", () => {
  assert.equal(paneRecoverability({ registered: false }), "unknown");
  assert.equal(paneRecoverability({ registered: true, closedAt: "2026-09-05T00:00:00Z", paneId: "%7" }), "closed");
  assert.equal(paneRecoverability({ registered: true }), "no-pane");
  assert.equal(paneRecoverability({ registered: true, paneId: "%7", paneAlive: true }), "alive");
  assert.equal(paneRecoverability({ registered: true, paneId: "%7", paneAlive: undefined }), "unknown-liveness",
    "tmux unreadable is missing information — never a licence to open a second process");
  assert.equal(paneRecoverability({ registered: true, paneId: "%7", paneAlive: false }), "recoverable");
});

// ---------------------------------------------------------------------------
// The env builder, on its own
// ---------------------------------------------------------------------------

test("the env builder is the only assembly point, and it omits what it was not given", () => {
  assert.deepEqual(buildSessionEnv({ kind: "judge", openerId: "o", judgeId: "j", role: "adviser" }), {
    RG_JUDGE_OPENER: "o", RG_JUDGE_ID: "j", RG_JUDGE_ROLE: "adviser",
    // The one key that is not about addressing the judge: where its throwaway
    // worktrees must go, so the gate can reclaim them (see the test in
    // test/judge-scratch.test.ts for why the two sides must agree).
    TMPDIR: judgeScratchDir("j"),
  });
  assert.deepEqual(buildSessionEnv({ kind: "orchestration-child", orchestrationId: "orch-1", stateVariant: "t2" }), {
    RG_ORCHESTRATION_ID: "orch-1", RG_GATE_MODE: "loop", RG_STATE_VARIANT: "t2",
  });
  const relay = { RG_ORCHESTRATION_ID: "orch-1", RG_GATE_MODE: "orchestrator" };
  const built = buildSessionEnv({ kind: "successor", env: relay });
  assert.deepEqual(built, relay);
  assert.notEqual(built, relay, "a copy: the caller's object is never handed to tmux by reference");
});

test("opening a judge window CREATES the scratch TMPDIR it hands the judge (reviewer P1)", async () => {
  // The env key is only useful if the directory exists: `mktemp -d` under a
  // missing `$TMPDIR` is ENOENT, so a judge told to build a throwaway worktree
  // under it was handed a path nothing had made. The gate that will reclaim it
  // (`reapReviewScratch`) only ever removed it, and removal of something that
  // was never created is how the write side went missing unnoticed.
  const judgeId = "rg-reviewer-mkdir-abc";
  const scratch = judgeScratchDir(judgeId);
  rmSync(scratch, { recursive: true, force: true });
  assert.equal(existsSync(scratch), false, "the test starts from nothing");
  try {
    const outcome = await openSessionWindow(happyRunner(), {
      scope: fakeScope(),
      cwd: "/repo",
      layout: "own-session-window",
      role: { kind: "judge", openerId: "session-child-1", judgeId, role: "reviewer" },
      command: JUDGE_COMMAND,
    });
    assert.equal(outcome.ok, true);
    assert.ok(existsSync(scratch), "the child's TMPDIR exists by the time the child does");
    // …and a non-judge child has no TMPDIR to create.
    const child = buildSessionEnv({ kind: "orchestration-child", orchestrationId: "orch-1", stateVariant: "t2" });
    assert.equal(child.TMPDIR, undefined);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the judge argv carries the read-only contract and the resume keys", () => {
  assert.deepEqual(buildJudgePaneCommand({
    sessionId: "rg-reviewer-x", taskPath: "/r/task-1.md", sessionDir: "/r/sessions",
    sysPromptPath: "/r/sp.md", model: "m",
  }),
  ["pi", "--no-skills", "--exclude-tools", "edit,write",
    "--system-prompt", "/r/sp.md", "--model", "m",
    "--session-dir", "/r/sessions", "--session-id", "rg-reviewer-x", "@/r/task-1.md"]);
  assert.deepEqual(buildJudgeRecoverCommand("rg-reviewer-x"),
    ["pi", "--exclude-tools", "edit,write", "--session-id", "rg-reviewer-x"]);
});
